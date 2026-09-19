// Reference DSP for the G2 4-mic head array: two 2-mic temples, front mic
// near each hinge and rear mic at each tip. Beamform WITHIN each temple (shared clock), then FUSE
// the two per-temple bearings — never raw cross-temple delay-and-sum, because
// the temples sample on independent clocks.
//
// One substitution from classic GCC-PHAT: the FFT cross-spectrum is
// replaced by a direct time-domain normalized cross-correlation over
// -maxLag..+maxLag. For the lags this array needs (|lag| <= 16 at 16 kHz) the
// direct form is cheaper than an FFT round-trip and carries no FFT dependency;
// the parabolic-interpolated peak still yields sub-sample delay.
//
// Pure TypeScript; no platform imports. Hot paths are Float32Array in and out.

export type MicSide = "left" | "right";
export type MicPosition = "front" | "rear";

// ---------------------------------------------------------------------------
// Array geometry (metres, head-centred; x=right, y=forward, z=up)

export type Vec3 = { x: number; y: number; z: number };

export type MicGeometry = {
  positions: Record<MicSide, Record<MicPosition, Vec3>>;
  speedOfSound: number;
};

export const G2_DEFAULT_GEOMETRY: MicGeometry = {
  positions: {
    left: {
      front: { x: -0.07, y: 0.05, z: 0 },
      rear: { x: -0.08, y: -0.06, z: 0 },
    },
    right: {
      front: { x: 0.07, y: 0.05, z: 0 },
      rear: { x: 0.08, y: -0.06, z: 0 },
    },
  },
  speedOfSound: 343,
};

// ---------------------------------------------------------------------------
// Bearing helpers

/** Azimuth in radians, 0 = straight ahead (device +y), positive to the right. */
export type Bearing = { azimuth: number };

export function bearingDegrees(bearing: Bearing): number {
  return (bearing.azimuth * 180) / Math.PI;
}

export function bearingUnitVector(bearing: Bearing): Vec3 {
  return { x: Math.sin(bearing.azimuth), y: Math.cos(bearing.azimuth), z: 0 };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// ---------------------------------------------------------------------------
// Fractional delay (shared by the beamformer and by tests)

/** Linear-interpolating fractional delay (positive = later). */
export function fractionalDelay(x: Float32Array, samples: number): Float32Array {
  const n = x.length;
  if (Math.abs(samples) < 1e-4) return x.slice();
  const out = new Float32Array(n);
  const i0 = Math.floor(samples);
  const frac = samples - i0;
  for (let i = 0; i < n; i++) {
    const j = i - i0;
    const a = j >= 0 && j < n ? x[j]! : 0;
    const b = j - 1 >= 0 && j - 1 < n ? x[j - 1]! : 0;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delay-and-sum beamformer (per temple, 2 mics, shared clock)

export class DelaySumBeamformer {
  constructor(
    public readonly sampleRate: number,
    public readonly geometry: MicGeometry = G2_DEFAULT_GEOMETRY,
  ) {}

  /**
   * Steer this temple's front/rear pair toward `target` (device-frame bearing)
   * and return the summed beam, halved to preserve amplitude.
   */
  beam(side: MicSide, front: Float32Array, rear: Float32Array, target: Bearing): Float32Array {
    const n = Math.min(front.length, rear.length);
    if (n === 0) return new Float32Array(0);
    const d = bearingUnitVector(target);
    const pF = this.geometry.positions[side].front;
    const pR = this.geometry.positions[side].rear;
    // Delay (samples) that aligns each mic's copy of a wavefront from `d`.
    const tauF = (dot(pF, d) / this.geometry.speedOfSound) * this.sampleRate;
    const tauR = (dot(pR, d) / this.geometry.speedOfSound) * this.sampleRate;
    const ref = Math.min(tauF, tauR);
    const sF = fractionalDelay(front, tauF - ref);
    const sR = fractionalDelay(rear, tauR - ref);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (sF[i]! + sR[i]!) * 0.5;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Two-mic adaptive noise canceller (NLMS) for inter-mic ANC

/**
 * Griffiths–Jim style: `primary` carries the steered speech, `reference` is a
 * null-steered noise estimate (front−rear after alignment). An NLMS filter
 * subtracts the correlated noise from the primary.
 */
export class InterMicNoiseCanceller {
  private readonly weights: Float32Array;
  private readonly history: Float32Array;

  constructor(
    private readonly taps: number = 32,
    private readonly stepSize: number = 0.05,
  ) {
    this.weights = new Float32Array(taps);
    this.history = new Float32Array(taps);
  }

  process(primary: Float32Array, reference: Float32Array): Float32Array {
    const n = Math.min(primary.length, reference.length);
    const out = new Float32Array(n);
    const { weights, history, taps } = this;
    const eps = 1e-6;
    for (let i = 0; i < n; i++) {
      for (let k = taps - 1; k > 0; k--) history[k] = history[k - 1]!;
      history[0] = reference[i]!;
      let yhat = 0;
      let energy = 0;
      for (let k = 0; k < taps; k++) {
        yhat += weights[k]! * history[k]!;
        energy += history[k]! * history[k]!;
      }
      const e = primary[i]! - yhat;
      out[i] = e;
      const step = (this.stepSize * e) / (energy + eps);
      for (let k = 0; k < taps; k++) weights[k] += step * history[k]!;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// TDOA via direct normalized cross-correlation (GCC-PHAT substitution)

/**
 * Estimate the delay of `b` relative to `a` in samples: if `b` is a copy of
 * `a` delayed by k samples, this returns approximately +k.
 *
 * Substitution note: classic GCC-PHAT whitens an FFT cross-spectrum. Here
 * the lag search is tiny (|lag| <= maxLag, typically <= 16),
 * so a direct time-domain normalized cross-correlation over the lag range is
 * cheaper and dependency-free. The per-lag normalization by the overlapped
 * segments' energies plays the whitening role of making the peak
 * amplitude-invariant. The peak is refined by parabolic interpolation for
 * sub-sample precision.
 */
export function gccPhatDelaySamples(a: Float32Array, b: Float32Array, maxLag: number): number {
  const n = Math.min(a.length, b.length);
  if (n === 0 || maxLag < 0) return 0;
  const lagCount = 2 * maxLag + 1;
  const corr = new Float32Array(lagCount);
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // Correlate a[i] against b[i + lag] over the overlapping span.
    const start = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    let sum = 0;
    let ea = 0;
    let eb = 0;
    for (let i = start; i < end; i++) {
      const av = a[i]!;
      const bv = b[i + lag]!;
      sum += av * bv;
      ea += av * av;
      eb += bv * bv;
    }
    const r = sum / (Math.sqrt(ea * eb) + 1e-12);
    corr[lag + maxLag] = r;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  // Parabolic interpolation around the integer peak for sub-sample precision.
  const idx = bestLag + maxLag;
  if (idx > 0 && idx < lagCount - 1) {
    const y0 = corr[idx - 1]!;
    const y1 = corr[idx]!;
    const y2 = corr[idx + 1]!;
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const offset = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(offset) <= 1) return bestLag + offset;
    }
  }
  return bestLag;
}

// ---------------------------------------------------------------------------
// Compass / IMU fusion: world-frame arc <-> device-frame steering

/**
 * `compassHeading` is the world heading of the device +y axis (radians,
 * 0 = north); `imuYaw` is a supplementary IMU trim (radians).
 */
export type HeadOrientation = { compassHeading: number; imuYaw: number };

/** Combined world→device rotation about vertical (compass anchored, IMU trims). */
function worldToDevice(head: HeadOrientation): number {
  return -(head.compassHeading + head.imuYaw);
}

/** Rotate a world-frame target bearing into the device frame for steering. */
export function steerWorldToDevice(worldAzimuth: number, head: HeadOrientation): Bearing {
  return { azimuth: worldAzimuth + worldToDevice(head) };
}

/** Convert a device-frame estimate back to world frame for display/fusion. */
export function deviceToWorld(deviceAzimuth: number, head: HeadOrientation): number {
  return deviceAzimuth - worldToDevice(head);
}

/**
 * Triangulate the two temples' world-frame bearings into a single estimate:
 * a circular-mean-safe blend, weighted by each temple's confidence.
 */
export function fuseBearings(
  left: number,
  leftWeight: number,
  right: number,
  rightWeight: number,
): number {
  const w = Math.max(1e-3, leftWeight + rightWeight);
  const x = (Math.sin(left) * leftWeight + Math.sin(right) * rightWeight) / w;
  const y = (Math.cos(left) * leftWeight + Math.cos(right) * rightWeight) / w;
  return Math.atan2(x, y);
}

// ---------------------------------------------------------------------------
// Faceclaw integration utilities

/**
 * Azimuth from an inter-mic delay, mirroring the firmware's approach:
 * asin of the delay normalized by the acoustic travel time across the pair,
 * clamped to ±90°.
 */
export function bearingFromTdoa(
  delaySamples: number,
  sampleRate: number,
  micSpacingMeters: number,
): number {
  const maxDelay = (micSpacingMeters / 343) * sampleRate;
  if (maxDelay <= 0) return 0;
  const normalized = Math.max(-1, Math.min(1, delaySamples / maxDelay));
  return Math.asin(normalized);
}

/** Wrap an angle to (-π, π]. */
function wrapAngle(angle: number): number {
  const twoPi = 2 * Math.PI;
  let a = angle % twoPi;
  if (a <= -Math.PI) a += twoPi;
  else if (a > Math.PI) a -= twoPi;
  return a;
}

/** Whether `azimuth` falls inside the arc, handling wraparound at ±π. */
export function angleInArc(azimuth: number, arcCenter: number, arcHalfWidth: number): boolean {
  return Math.abs(wrapAngle(azimuth - arcCenter)) <= arcHalfWidth;
}

// ---------------------------------------------------------------------------
// Top-level per-temple pipeline

export class TempleAudioPipeline {
  private readonly beamformer: DelaySumBeamformer;
  private readonly anc = new InterMicNoiseCanceller();
  enableANC = true;

  constructor(
    public readonly side: MicSide,
    sampleRate: number,
    geometry: MicGeometry = G2_DEFAULT_GEOMETRY,
  ) {
    this.beamformer = new DelaySumBeamformer(sampleRate, geometry);
  }

  /**
   * Process one frame's deinterleaved front/rear channels toward a
   * device-frame target, returning the enhanced mono beam for this temple.
   */
  process(front: Float32Array, rear: Float32Array, target: Bearing): Float32Array {
    const beam = this.beamformer.beam(this.side, front, rear, target);
    if (!this.enableANC) return beam;
    // Null-steer reference: the difference channel carries off-axis noise.
    const n = Math.min(front.length, rear.length);
    const reference = new Float32Array(n);
    for (let i = 0; i < n; i++) reference[i] = front[i]! - rear[i]!;
    return this.anc.process(beam, reference);
  }
}
