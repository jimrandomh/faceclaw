// These pin the DSP behaviours the microphones app depends on: fractional
// delays interpolate rather than round, the per-temple beamformer actually
// gains from coherent summation, the direct-correlation TDOA recovers known
// delays (including sub-sample ones), the NLMS canceller removes correlated
// noise without eating the signal, and the bearing math survives the ±π seam.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  G2_DEFAULT_GEOMETRY,
  bearingDegrees,
  bearingUnitVector,
  fractionalDelay,
  DelaySumBeamformer,
  InterMicNoiseCanceller,
  gccPhatDelaySamples,
  steerWorldToDevice,
  deviceToWorld,
  fuseBearings,
  TempleAudioPipeline,
  bearingFromTdoa,
  angleInArc,
} = require("../.test-build/app/apps/microphones/dsp.js");

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const deg = (d) => (d * Math.PI) / 180;

const rms = (x, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
};

// Deterministic white-ish noise (LCG), so failures reproduce.
const makeNoise = (n, seed = 12345) => {
  const out = new Float32Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state / 0x80000000 - 1; // uniform in [-1, 1)
  }
  return out;
};

test("fractional delay of a ramp by half a sample yields midpoint averages", () => {
  const ramp = Float32Array.from({ length: 32 }, (_, i) => i);
  const delayed = fractionalDelay(ramp, 0.5);
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(near(delayed[i], (ramp[i] + ramp[i - 1]) / 2, 1e-5));
  }
});

test("beamformer sums coherently when steered at the source", () => {
  const sampleRate = 16000;
  const beamformer = new DelaySumBeamformer(sampleRate);
  const geometry = G2_DEFAULT_GEOMETRY;
  const target = { azimuth: 0 };
  const d = bearingUnitVector(target);
  const c = geometry.speedOfSound;
  const pF = geometry.positions.left.front;
  const pR = geometry.positions.left.rear;
  // A wavefront from straight ahead reaches each mic early by dot(p, d)/c.
  const tauF = ((pF.x * d.x + pF.y * d.y) / c) * sampleRate;
  const tauR = ((pR.x * d.x + pR.y * d.y) / c) * sampleRate;
  // Frequency chosen so opposite-direction steering misaligns by half a
  // period — the misaligned beam should nearly cancel.
  const w = Math.PI / (2 * (tauF - tauR));
  const n = 2048;
  const front = new Float32Array(n);
  const rear = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    front[i] = Math.sin(w * (i + tauF));
    rear[i] = Math.sin(w * (i + tauR));
  }
  const aligned = beamformer.beam("left", front, rear, target);
  const misaligned = beamformer.beam("left", front, rear, { azimuth: Math.PI });
  // Skip the edge the delay lines zero-fill.
  const alignedRms = rms(aligned, 32, n);
  const misalignedRms = rms(misaligned, 32, n);
  assert.ok(near(alignedRms, Math.SQRT1_2, 0.05)); // full-amplitude sinusoid
  assert.ok(alignedRms > 2 * misalignedRms);
});

test("direct-correlation TDOA recovers an integer delay", () => {
  const a = makeNoise(2048);
  const k = 5;
  const b = new Float32Array(a.length);
  for (let i = k; i < a.length; i++) b[i] = a[i - k];
  assert.ok(near(gccPhatDelaySamples(a, b, 16), k, 0.15));
});

test("direct-correlation TDOA resolves a fractional delay via parabolic interpolation", () => {
  const a = makeNoise(2048, 777);
  const k = 3.4;
  const b = fractionalDelay(a, k);
  assert.ok(near(gccPhatDelaySamples(a, b, 16), k, 0.3));
});

test("NLMS canceller removes correlated noise and keeps the signal", () => {
  const n = 8000;
  const sampleRate = 16000;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  const reference = makeNoise(n, 424242);
  const primary = new Float32Array(n);
  // The primary hears the noise through a short path (2-sample lag, 0.8 gain).
  for (let i = 0; i < n; i++) {
    primary[i] = tone[i] + 0.8 * (i >= 2 ? reference[i - 2] : 0);
  }
  const anc = new InterMicNoiseCanceller();
  const out = anc.process(primary, reference);
  // Judge the converged tail only.
  const half = n / 2;
  const primaryRms = rms(primary, half, n);
  const outRms = rms(out, half, n);
  const toneRms = rms(tone, half, n);
  assert.ok(outRms < 0.8 * primaryRms); // noise reduced
  assert.ok(outRms > 0.5 * toneRms); // signal survives
  // Residual noise power (beyond the tone) drops substantially.
  const noiseInPower = primaryRms * primaryRms - toneRms * toneRms;
  const noiseOutPower = Math.max(0, outRms * outRms - toneRms * toneRms);
  assert.ok(noiseOutPower < 0.5 * noiseInPower);
});

test("bearingFromTdoa is antisymmetric and clamps to ±90°", () => {
  const sampleRate = 16000;
  const spacing = 0.11;
  const positive = bearingFromTdoa(2, sampleRate, spacing);
  const negative = bearingFromTdoa(-2, sampleRate, spacing);
  assert.ok(positive > 0);
  assert.ok(near(positive, -negative, 1e-9));
  assert.ok(near(bearingFromTdoa(100, sampleRate, spacing), Math.PI / 2, 1e-9));
  assert.ok(near(bearingFromTdoa(-100, sampleRate, spacing), -Math.PI / 2, 1e-9));
  assert.equal(bearingFromTdoa(0, sampleRate, spacing), 0);
});

test("angleInArc handles wraparound at ±180°", () => {
  const center = deg(170);
  const halfWidth = deg(30);
  assert.ok(angleInArc(deg(-175), center, halfWidth)); // 15° away, across the seam
  assert.ok(angleInArc(deg(150), center, halfWidth));
  assert.ok(!angleInArc(deg(130), center, halfWidth)); // 40° away
  assert.ok(!angleInArc(deg(-130), center, halfWidth)); // 60° away, across the seam
});

test("fuseBearings takes the circular mean across the ±180° seam", () => {
  const fused = fuseBearings(deg(170), 1, deg(-170), 1);
  assert.ok(near(Math.abs(fused), Math.PI, 1e-6));
  assert.ok(near(fuseBearings(deg(10), 1, deg(20), 1), deg(15), 1e-6));
  // Weights pull the mean toward the more confident temple.
  const weighted = fuseBearings(0, 3, Math.PI / 2, 1);
  assert.ok(near(weighted, Math.atan2(0.25, 0.75), 1e-6));
});

test("world and device frames round-trip through the head orientation", () => {
  const head = { compassHeading: deg(40), imuYaw: deg(5) };
  const world = deg(120);
  const steered = steerWorldToDevice(world, head);
  assert.ok(near(deviceToWorld(steered.azimuth, head), world, 1e-9));
  assert.ok(near(bearingDegrees(steered), 120 - 45, 1e-9));
});

test("temple pipeline matches the raw beam with ANC disabled", () => {
  const pipeline = new TempleAudioPipeline("right", 16000);
  pipeline.enableANC = false;
  const beamformer = new DelaySumBeamformer(16000);
  const front = makeNoise(512, 1);
  const rear = makeNoise(512, 2);
  const target = { azimuth: deg(30) };
  const viaPipeline = pipeline.process(front, rear, target);
  const direct = beamformer.beam("right", front, rear, target);
  assert.equal(viaPipeline.length, direct.length);
  for (let i = 0; i < direct.length; i++) assert.equal(viaPipeline[i], direct[i]);
});
