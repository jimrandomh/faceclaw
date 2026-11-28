//! The air mouse's math, ported from kinesis `Sources/Kinesis/AirCursor.swift`
//! (callbacked/kinesis 5c78485, MIT): where the forearm points, from the band's orientation
//! quaternion; how fast it turns, from the gyro; and the movement that reaches the pointer,
//! smoothed, held back while the arm is still and accelerated when it's quick. Relative, like a
//! mouse. Kinesis' home correction and screen clamping need the pointer's position, which a
//! Bluetooth mouse never learns, so they stay out, as does its calibration. Pure: times are
//! seconds, passed in.

use crate::events::Hand;

/// Observed, not from a datasheet: raw gyro counts to degrees per second.
pub const GYRO_SCALE: f64 = 0.07;

/// Where the forearm points. The quaternion arrives as w, x, y, z and rotates the band's body
/// frame into a world frame whose +z is up; the band's body +y runs along the forearm toward the
/// hand on a right wrist and toward the elbow on a left one. Twisting the wrist changes neither
/// angle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ForearmAim {
    /// Degrees around gravity; positive is counterclockwise seen from above, to the left.
    pub azimuth: f64,
    /// Degrees above the horizon.
    pub elevation: f64,
}

impl ForearmAim {
    /// `None` for a value that isn't a unit quaternion.
    pub fn from_quaternion(q: [f64; 4], hand: Hand) -> Option<Self> {
        if !q.iter().all(|v| v.is_finite()) {
            return None;
        }
        let norm: f64 = q.iter().map(|v| v * v).sum();
        if !(0.9..=1.1).contains(&norm) {
            return None;
        }
        let n = norm.sqrt();
        let q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
        let axis = if hand == Hand::Left { [0.0, -1.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let f = rotate(q, axis);
        let length = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]).sqrt();
        if length == 0.0 {
            return None;
        }
        Some(Self {
            azimuth: f[1].atan2(f[0]).to_degrees(),
            elevation: (f[2] / length).clamp(-1.0, 1.0).asin().to_degrees(),
        })
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `v` rotated by the unit quaternion `q` (w, x, y, z).
fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let u = [q[1], q[2], q[3]];
    let t = cross(u, v).map(|c| 2.0 * c);
    let c = cross(u, t);
    [v[0] + q[0] * t[0] + c[0], v[1] + q[0] * t[1] + c[1], v[2] + q[0] * t[2] + c[2]]
}

/// The IEEE remainder (Swift's `remainder`): `a` minus the nearest multiple of `b`.
fn remainder(a: f64, b: f64) -> f64 {
    a - b * (a / b).round()
}

fn smoothstep(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// The 1€ filter (Casiez, Roussel and Vogel, 2012): heavy smoothing while the value is nearly
/// still, so tremor disappears, light smoothing while it moves fast, so a move isn't delayed.
#[derive(Debug, Clone)]
pub struct OneEuroFilter {
    min_cutoff: f64,
    beta: f64,
    derivative_cutoff: f64,
    value: Option<f64>,
    derivative: f64,
}

impl OneEuroFilter {
    pub fn new(min_cutoff: f64, beta: f64) -> Self {
        Self { min_cutoff, beta, derivative_cutoff: 1.0, value: None, derivative: 0.0 }
    }

    fn smoothing(cutoff: f64, dt: f64) -> f64 {
        let tau = 1.0 / (2.0 * std::f64::consts::PI * cutoff);
        1.0 / (1.0 + tau / dt)
    }

    pub fn filter(&mut self, raw: f64, dt: f64) -> f64 {
        let Some(previous) = self.value.filter(|_| dt > 0.0) else {
            self.value = Some(raw);
            self.derivative = 0.0;
            return raw;
        };
        self.derivative += ((raw - previous) / dt - self.derivative) * Self::smoothing(self.derivative_cutoff, dt);
        let cutoff = self.min_cutoff + self.beta * self.derivative.abs();
        let next = previous + (raw - previous) * Self::smoothing(cutoff, dt);
        self.value = Some(next);
        next
    }

    pub fn reset(&mut self) {
        self.value = None;
        self.derivative = 0.0;
    }
}

/// Pointer acceleration: slow aiming moves the pointer less, for precision, and a quick flick
/// more, for distance. Careful moves measured 1.2 to 1.8°/s and flicks over 30°/s.
pub mod acceleration {
    pub const SLOW_SPEED: f64 = 2.0;
    pub const FAST_SPEED: f64 = 30.0;
    pub const SLOW_FACTOR: f64 = 0.6;
    pub const FAST_FACTOR: f64 = 1.6;
    pub const FLICK_BOOSTS: std::ops::RangeInclusive<f64> = 1.0..=2.5;

    /// The multiplier at this speed (degrees per second), up to `fast` for a flick.
    pub fn factor(speed: f64, fast: f64) -> f64 {
        if !speed.is_finite() {
            return SLOW_FACTOR;
        }
        let x = (speed - SLOW_SPEED) / (FAST_SPEED - SLOW_SPEED);
        SLOW_FACTOR + (fast - SLOW_FACTOR) * super::smoothstep(x)
    }
}

/// How the arm was moving when a pinch came.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approach {
    Still,
    Settling,
    Tracking,
}

/// Moves the pointer by how the forearm's aim changes, like a mouse, not by where it points: a
/// laser mapping ties every spot on screen to one arm position, and every bit of sway moved it.
#[derive(Debug, Clone)]
pub struct AirPointer {
    azimuth_filter: OneEuroFilter,
    elevation_filter: OneEuroFilter,
    unwrapped_azimuth: Option<f64>,
    last_raw_azimuth: f64,
    last_raw_elevation: f64,
    last_time: Option<f64>,
    aim: Option<ForearmAim>,
    /// Movement not yet taken, sample by sample, already scaled by stillness and acceleration.
    pending: Vec<(f64, [f64; 2])>,
    /// The gate's view of speed: rises with the gyro at once, falls over 150 ms.
    gate_speed: f64,
    gyro_bias: [f64; 3],
    last_gyro_time: Option<f64>,
    /// Degrees per second the aim turns, from the gyro, without the wrist's twist.
    speed: f64,
    recent_speeds: Vec<(f64, f64)>,
    acceleration_speed: f64,
    click_guard_until: f64,
    click_guard_speed: f64,
    /// 0 is the most responsive and 1 the steadiest.
    pub steadiness: f64,
    /// The most a quick move multiplies by ([acceleration::FLICK_BOOSTS]).
    pub fast_factor: f64,
}

impl Default for AirPointer {
    fn default() -> Self {
        Self {
            // A 1.2 Hz floor calms slow aiming; the speed term keeps quick moves crisp.
            azimuth_filter: OneEuroFilter::new(1.2, 0.12),
            elevation_filter: OneEuroFilter::new(1.2, 0.12),
            unwrapped_azimuth: None,
            last_raw_azimuth: 0.0,
            last_raw_elevation: 0.0,
            last_time: None,
            aim: None,
            pending: Vec::new(),
            gate_speed: 0.0,
            gyro_bias: [0.0; 3],
            last_gyro_time: None,
            speed: 0.0,
            recent_speeds: Vec::new(),
            acceleration_speed: 0.0,
            click_guard_until: f64::NEG_INFINITY,
            click_guard_speed: 0.0,
            steadiness: 0.5,
            fast_factor: acceleration::FAST_FACTOR,
        }
    }
}

impl AirPointer {
    /// Near straight up or down the compass angle is meaningless, so it holds still there.
    pub const STEEP_ELEVATION: f64 = 75.0;
    /// A gap this long in the stream drops the movement across it.
    pub const MAXIMUM_GAP: f64 = 0.5;
    /// After a pinch the forearm drifts 0.2 to 0.8° over 0.3 s at 2 to 4°/s: for a moment the
    /// stillness threshold rises to this range, then fades back.
    pub const CLICK_GUARD: (f64, f64) = (3.5, 6.0);
    pub const CLICK_GUARD_SECONDS: f64 = 0.4;
    /// Smoothing of the speed that sets acceleration: short, like a mouse.
    const ACCELERATION_SECONDS: f64 = 0.03;

    pub fn speed(&self) -> f64 {
        self.speed
    }

    pub fn aim(&self) -> Option<ForearmAim> {
        self.aim
    }

    /// Below the range's start (degrees per second) the arm is held still and nothing moves;
    /// above its end it moves fully. Holding still measured 0.5°/s typically, careful moves
    /// 1.2 to 1.8°/s.
    pub fn still(steadiness: f64) -> (f64, f64) {
        let low = 0.5 + 0.7 * steadiness.clamp(0.0, 1.0);
        (low, low + 0.5)
    }

    /// The stillness range at `time`, raised for a while after a pinch.
    fn still_at(&self, time: f64) -> (f64, f64) {
        let base = Self::still(self.steadiness);
        let strength = ((self.click_guard_until - time) / Self::CLICK_GUARD_SECONDS).clamp(0.0, 1.0);
        if strength <= 0.0 {
            return base;
        }
        let guard_low = Self::CLICK_GUARD.0.max(self.click_guard_speed);
        let guard_high = guard_low + (Self::CLICK_GUARD.1 - Self::CLICK_GUARD.0);
        let low = base.0 + (guard_low - base.0) * strength;
        let high = base.1 + (guard_high - base.1) * strength;
        (low, high.max(low + 0.1))
    }

    /// People slow down into a click, as with a mouse; tracking something that moves keeps its speed.
    pub fn approach(&self) -> Approach {
        if self.speed < 3.0 {
            return Approach::Still;
        }
        let peak = self.recent_speeds.iter().map(|&(_, s)| s).fold(self.speed, f64::max);
        if self.speed < 15.0 && self.speed < peak * 0.8 { Approach::Settling } else { Approach::Tracking }
    }

    /// A pinch or release happened: absorb the drift that follows it, and the smoothing's lag,
    /// which would carry the pointer on past the click.
    pub fn guard_click(&mut self, time: f64) {
        self.click_guard_until = time + Self::CLICK_GUARD_SECONDS;
        self.click_guard_speed = self.speed;
        let Some(azimuth) = self.unwrapped_azimuth else { return };
        self.azimuth_filter.reset();
        self.elevation_filter.reset();
        self.aim = Some(ForearmAim {
            azimuth: self.azimuth_filter.filter(azimuth, 0.0),
            elevation: self.elevation_filter.filter(self.last_raw_elevation, 0.0),
        });
        self.pending.clear();
    }

    /// How much of the aim's movement reaches the pointer now: 0 held still, 1 moving.
    fn motion(&self, time: f64) -> f64 {
        let (low, high) = self.still_at(time);
        // During a click guard the arm's own speed decides, not the held-over one.
        let judged = if time < self.click_guard_until { self.speed } else { self.gate_speed };
        smoothstep((judged - low) / (high - low))
    }

    /// One gyro sample in raw counts. Only its rate is used: the orientation says where the
    /// forearm points, the gyro whether it's moving.
    pub fn receive_gyro(&mut self, raw: [f64; 3], time: f64) {
        if !raw.iter().all(|v| v.is_finite()) {
            return;
        }
        let dt = self.last_gyro_time.map_or(0.0, |last| time - last);
        self.last_gyro_time = Some(time);
        if dt <= 0.0 || dt >= Self::MAXIMUM_GAP {
            return;
        }
        let corrected: [f64; 3] = std::array::from_fn(|i| raw[i] * GYRO_SCALE - self.gyro_bias[i]);
        let magnitude = corrected.iter().map(|c| c * c).sum::<f64>().sqrt();
        // The resting offset drifts; learn it only while the arm is clearly still.
        if magnitude < 0.8 {
            let k = 1.0 - (-dt / 4.0).exp();
            for (bias, c) in self.gyro_bias.iter_mut().zip(corrected) {
                *bias += c * k;
            }
        }
        // Body +y is the forearm: a rate around it is a twist, which never moves the pointer.
        let rate = (corrected[0] * corrected[0] + corrected[2] * corrected[2]).sqrt();
        self.speed += (rate - self.speed) * (1.0 - (-dt / 0.1).exp());
        self.acceleration_speed += (rate - self.acceleration_speed) * (1.0 - (-dt / Self::ACCELERATION_SECONDS).exp());
        self.gate_speed = self.speed.max(self.gate_speed * (-dt / 0.15).exp());
        self.recent_speeds.push((time, self.speed));
        self.recent_speeds.retain(|&(t, _)| time - t <= 0.2);
    }

    /// One orientation sample; false after a gap, whose movement is dropped.
    pub fn receive(&mut self, sample: ForearmAim, time: f64) -> bool {
        let gap = self.last_time.map_or(f64::INFINITY, |last| time - last);
        if gap <= 0.0 {
            return true;
        }
        self.last_time = Some(time);
        let Some(mut unwrapped) = self.unwrapped_azimuth.filter(|_| gap <= Self::MAXIMUM_GAP) else {
            self.azimuth_filter.reset();
            self.elevation_filter.reset();
            self.unwrapped_azimuth = Some(sample.azimuth);
            self.last_raw_azimuth = sample.azimuth;
            self.last_raw_elevation = sample.elevation;
            self.pending.clear();
            self.aim = Some(ForearmAim {
                azimuth: self.azimuth_filter.filter(sample.azimuth, 0.0),
                elevation: self.elevation_filter.filter(sample.elevation, 0.0),
            });
            return false;
        };
        // Keep the compass angle continuous across ±180°, and freeze it where it's undefined.
        if sample.elevation.abs() < Self::STEEP_ELEVATION {
            unwrapped += remainder(sample.azimuth - self.last_raw_azimuth, 360.0);
            self.unwrapped_azimuth = Some(unwrapped);
        }
        self.last_raw_azimuth = sample.azimuth;
        self.last_raw_elevation = sample.elevation;
        let next = ForearmAim {
            azimuth: self.azimuth_filter.filter(unwrapped, gap),
            elevation: self.elevation_filter.filter(sample.elevation, gap),
        };
        if let Some(previous) = self.aim {
            // Each step scaled by the speed at that moment, so a flick keeps its gain.
            let gain = self.motion(time) * acceleration::factor(self.acceleration_speed, self.fast_factor);
            let step = [(next.azimuth - previous.azimuth) * gain, (next.elevation - previous.elevation) * gain];
            if step != [0.0, 0.0] {
                self.pending.push((time, step));
            }
        }
        self.aim = Some(next);
        true
    }

    /// The movement since the last call, each step with the time the band sampled it: compass
    /// degrees (positive left) and elevation (positive up). `None` until there's an aim.
    pub fn take_movement(&mut self) -> Option<Vec<(f64, [f64; 2])>> {
        self.aim?;
        Some(std::mem::take(&mut self.pending))
    }

    /// Drops the movement not yet taken.
    pub fn discard(&mut self) {
        self.pending.clear();
    }
}

/// How late the band's data arrives, by the band's own clock. On a congested link samples came
/// up to 22 s late, in bursts, while the link stayed up: arrival time can't see that. The
/// smallest gap between host and band time is an on-time sample's transit; anything above it is
/// delay. The baseline creeps up at most 0.5 ms a second, for drift between the clocks.
#[derive(Debug, Clone, Default)]
pub struct ArrivalDelay {
    baseline: Option<f64>,
    last_band: Option<f64>,
    last_host: Option<f64>,
}

impl ArrivalDelay {
    pub fn measure(&mut self, band: f64, host: f64) -> f64 {
        if !band.is_finite() || !host.is_finite() {
            return 0.0;
        }
        // The band's clock restarted: the old baseline no longer applies.
        if self.last_band.is_some_and(|last| band < last - 1.0) {
            *self = Self::default();
        }
        let offset = host - band;
        let baseline = match (self.baseline, self.last_host) {
            (Some(previous), Some(last_host)) => (previous + (host - last_host).max(0.0) * 0.0005).min(offset),
            _ => offset,
        };
        self.baseline = Some(baseline);
        self.last_band = Some(band);
        self.last_host = Some(host);
        (offset - baseline).max(0.0)
    }
}

/// How slanted the arm's natural up and across lines are: an elbow doesn't hinge in a straight
/// screen line (a right arm moving "straight up" drifted left, toward the body).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerReach {
    /// Compass degrees per degree of elevation when the arm moves straight up (positive: left).
    pub up_tilt: f64,
    /// Elevation per compass degree when the arm moves straight right.
    pub across_tilt: f64,
}

impl PointerReach {
    /// Kinesis' measured default for a right arm; a left arm stays straight until measured.
    pub fn standard(hand: Hand) -> Self {
        Self { up_tilt: if hand == Hand::Right { 0.1 } else { 0.0 }, across_tilt: 0.0 }
    }

    /// An aim change (compass, positive left; elevation, positive up) in degrees along the
    /// screen: right and down.
    pub fn screen_degrees(&self, aim: [f64; 2]) -> [f64; 2] {
        let scale = 1.0 + self.up_tilt * self.across_tilt;
        let right = -(aim[0] - self.up_tilt * aim[1]) / scale;
        let up = (self.across_tilt * aim[0] + aim[1]) / scale;
        [right, -up]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quaternion_multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
        [
            a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
            a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
            a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
        ]
    }

    fn around(degrees: f64, axis: [f64; 3]) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), axis[0] * half.sin(), axis[1] * half.sin(), axis[2] * half.sin()]
    }

    /// The band's quaternion (w, x, y, z) for a forearm turned `azimuth` left, raised
    /// `elevation` and twisted `twist` degrees (kinesis `bandQuaternion`).
    pub(crate) fn band_quaternion(azimuth: f64, elevation: f64, twist: f64) -> [f64; 4] {
        quaternion_multiply(
            quaternion_multiply(around(azimuth, [0.0, 0.0, 1.0]), around(elevation, [1.0, 0.0, 0.0])),
            around(twist, [0.0, 1.0, 0.0]),
        )
    }

    fn aim(azimuth: f64, elevation: f64) -> ForearmAim {
        ForearmAim { azimuth, elevation }
    }

    #[test]
    fn the_aim_follows_turning_and_raising_and_ignores_twisting() {
        let rest = ForearmAim::from_quaternion(band_quaternion(0.0, 0.0, 0.0), Hand::Right).unwrap();
        assert!((rest.azimuth - 90.0).abs() < 1e-9 && rest.elevation.abs() < 1e-9);
        let turned = ForearmAim::from_quaternion(band_quaternion(30.0, 0.0, 0.0), Hand::Right).unwrap();
        assert!((turned.azimuth - 120.0).abs() < 1e-9);
        let raised = ForearmAim::from_quaternion(band_quaternion(0.0, 20.0, 0.0), Hand::Right).unwrap();
        assert!((raised.elevation - 20.0).abs() < 1e-9 && (raised.azimuth - 90.0).abs() < 1e-9);
        for (azimuth, elevation) in [(0.0, 0.0), (45.0, 15.0), (-60.0, -30.0)] {
            let plain = ForearmAim::from_quaternion(band_quaternion(azimuth, elevation, 0.0), Hand::Right).unwrap();
            let twisted = ForearmAim::from_quaternion(band_quaternion(azimuth, elevation, 70.0), Hand::Right).unwrap();
            assert!((plain.azimuth - twisted.azimuth).abs() < 1e-9 && (plain.elevation - twisted.elevation).abs() < 1e-9);
        }
        let negated = band_quaternion(30.0, 10.0, 0.0).map(|v| -v);
        let same = ForearmAim::from_quaternion(negated, Hand::Right).unwrap();
        assert!((same.azimuth - 120.0).abs() < 1e-9 && (same.elevation - 10.0).abs() < 1e-9);
        assert!(ForearmAim::from_quaternion([2.0, 0.0, 0.0, 0.0], Hand::Right).is_none());
        assert!(ForearmAim::from_quaternion([f64::NAN, 0.0, 0.0, 0.0], Hand::Right).is_none());
    }

    #[test]
    fn a_left_wrists_band_points_its_axis_at_the_elbow() {
        let left = ForearmAim::from_quaternion(band_quaternion(0.0, -40.0, 0.0), Hand::Left).unwrap();
        assert!((left.elevation - 40.0).abs() < 1e-9);
        let turned = ForearmAim::from_quaternion(band_quaternion(20.0, -40.0, 0.0), Hand::Left).unwrap();
        assert!((remainder(turned.azimuth - left.azimuth, 360.0) - 20.0).abs() < 1e-9);
    }

    /// Feeds the pointer at 128 Hz, like the band, and adds up its movement (x left, y up).
    struct Feed {
        pointer: AirPointer,
        time: f64,
        moved: [f64; 2],
        last: Option<ForearmAim>,
        noise: f64,
    }

    impl Feed {
        fn new(steadiness: f64) -> Self {
            let pointer = AirPointer { steadiness, ..AirPointer::default() };
            Self { pointer, time: 0.0, moved: [0.0; 2], last: None, noise: 0.3 }
        }

        fn sample(&mut self, aim: ForearmAim) {
            self.time += 1.0 / 128.0;
            let rate = self.last.map_or(0.0, |last| {
                remainder(aim.azimuth - last.azimuth, 360.0).hypot(aim.elevation - last.elevation) * 128.0
            });
            let jitter = self.noise * (self.time * 97.0).sin();
            self.pointer.receive_gyro([(rate + jitter) / GYRO_SCALE, 0.0, jitter / GYRO_SCALE], self.time);
            self.last = Some(aim);
            self.pointer.receive(aim, self.time);
            for (_, step) in self.pointer.take_movement().unwrap_or_default() {
                self.moved[0] += step[0];
                self.moved[1] += step[1];
            }
        }

        fn sweep(&mut self, start: ForearmAim, end: ForearmAim, seconds: f64) {
            let steps = ((seconds * 128.0) as usize).max(1);
            for step in 1..=steps {
                let t = step as f64 / steps as f64;
                self.sample(aim(
                    start.azimuth + (end.azimuth - start.azimuth) * t,
                    start.elevation + (end.elevation - start.elevation) * t,
                ));
            }
            for _ in 0..64 {
                self.sample(end);
            }
        }

        fn hold(&mut self, at: ForearmAim, seconds: f64) {
            for _ in 0..(seconds * 128.0) as usize {
                self.sample(at);
            }
        }
    }

    fn length(v: [f64; 2]) -> f64 {
        v[0].hypot(v[1])
    }

    #[test]
    fn movement_is_how_far_the_aim_turned_and_nothing_while_it_holds() {
        let mut feed = Feed::new(0.0);
        feed.hold(aim(90.0, 10.0), 0.5);
        assert!(length(feed.moved) < 1e-9);
        feed.moved = [0.0; 2];
        feed.sweep(aim(90.0, 10.0), aim(100.0, 15.0), 0.5);
        let factor = acceleration::factor(10f64.hypot(5.0) / 0.5, acceleration::FAST_FACTOR);
        assert!(feed.moved[0] > 10.0 * factor * 0.8 && feed.moved[0] < 10.0 * factor * 1.05, "{:?}", feed.moved);
        assert!((feed.moved[0] / feed.moved[1] - 2.0).abs() < 0.05);
    }

    #[test]
    fn movement_is_continuous_across_the_compass_seam() {
        let mut feed = Feed::new(0.0);
        feed.hold(aim(178.0, 0.0), 0.5);
        feed.sweep(aim(178.0, 0.0), aim(182.0, 0.0), 0.2);
        assert!(feed.moved[0] > 3.0 && feed.moved[0] < 4.0 * acceleration::FAST_FACTOR, "{:?}", feed.moved);
    }

    #[test]
    fn a_gap_in_the_stream_drops_the_movement_across_it() {
        let mut feed = Feed::new(0.0);
        feed.hold(aim(90.0, 0.0), 0.5);
        feed.time += 1.0;
        feed.hold(aim(130.0, 0.0), 0.5);
        assert!(length(feed.moved) < 1e-9);
    }

    #[test]
    fn near_straight_up_the_compass_angle_holds_still() {
        let mut feed = Feed::new(0.0);
        feed.hold(aim(90.0, 80.0), 0.5);
        feed.sweep(aim(90.0, 80.0), aim(-20.0, 80.0), 1.0);
        assert!(feed.moved[0].abs() < 1e-9);
    }

    #[test]
    fn a_held_arm_stays_still_and_a_slow_move_still_moves() {
        let mut held = Feed::new(0.5);
        held.hold(aim(90.0, 0.0), 1.0);
        for _ in 0..(3 * 128) {
            let t = held.time + 1.0 / 128.0;
            held.sample(aim(90.0 + 0.06 * (2.0 * std::f64::consts::PI * 2.0 * t).sin(), 0.0));
        }
        assert!(length(held.moved) < 0.02, "{:?}", held.moved);
        let mut slow = Feed::new(0.5);
        slow.hold(aim(90.0, 0.0), 1.0);
        slow.sweep(aim(90.0, 0.0), aim(93.0, 0.0), 2.0);
        let factor = acceleration::SLOW_FACTOR;
        assert!(slow.moved[0] > 3.0 * factor * 0.85 && slow.moved[0] < 3.0 * factor * 1.05, "{:?}", slow.moved);
    }

    #[test]
    fn the_click_guard_absorbs_the_pinch_drift_but_lets_tracking_through() {
        let mut drift = Feed::new(0.5);
        drift.hold(aim(90.0, 0.0), 1.0);
        drift.pointer.guard_click(drift.time);
        drift.sweep(aim(90.0, 0.0), aim(90.6, 0.0), 0.25);
        assert!(drift.moved[0].abs() < 0.05, "{:?}", drift.moved);
        let mut unguarded = Feed::new(0.5);
        unguarded.hold(aim(90.0, 0.0), 1.0);
        unguarded.sweep(aim(90.0, 0.0), aim(90.6, 0.0), 0.25);
        assert!(unguarded.moved[0] > 0.2, "{:?}", unguarded.moved);
        let mut tracking = Feed::new(0.5);
        tracking.hold(aim(90.0, 0.0), 1.0);
        tracking.pointer.guard_click(tracking.time);
        tracking.sweep(aim(90.0, 0.0), aim(96.0, 0.0), 0.4);
        let free = acceleration::factor(15.0, acceleration::FAST_FACTOR) * 6.0;
        assert!(tracking.moved[0] > free * 0.7, "{:?}", tracking.moved);
    }

    #[test]
    fn acceleration_gives_precision_when_slow_and_distance_when_fast() {
        assert_eq!(acceleration::factor(0.0, 1.6), acceleration::SLOW_FACTOR);
        assert_eq!(acceleration::factor(1000.0, 1.6), 1.6);
        assert_eq!(acceleration::factor(f64::NAN, 1.6), acceleration::SLOW_FACTOR);
        let speeds: Vec<f64> = (0..=60).map(|s| acceleration::factor(s as f64, 1.6)).collect();
        assert!(speeds.windows(2).all(|w| w[0] <= w[1]));
        let mut slow = Feed::new(0.0);
        let mut fast = Feed::new(0.0);
        slow.hold(aim(90.0, 0.0), 0.5);
        fast.hold(aim(90.0, 0.0), 0.5);
        let start = slow.time;
        for _ in 0..128 {
            let azimuth = 90.0 + (slow.time - start);
            slow.sample(aim(azimuth, 0.0));
        }
        let mut fastest: f64 = 0.0;
        for step in 1..=32 {
            fast.sample(aim(90.0 + 20.0 * step as f64 / 32.0, 0.0));
            fastest = fastest.max(fast.pointer.speed());
        }
        assert!(slow.pointer.speed() < acceleration::SLOW_SPEED && fastest > acceleration::FAST_SPEED);
    }

    #[test]
    fn straightening_turns_the_arms_natural_lines_into_screen_lines() {
        let reach = PointerReach { up_tilt: 0.23, across_tilt: 0.03 };
        let up = reach.screen_degrees([0.23, 1.0]);
        assert!(up[0].abs() < 1e-9 && up[1] < 0.0);
        let right = reach.screen_degrees([-1.0, 0.03]);
        assert!(right[1].abs() < 1e-9 && right[0] > 0.0);
        assert_eq!(PointerReach::standard(Hand::Left).up_tilt, 0.0);
        // Turning left (compass +) moves the pointer left; raising it moves it up.
        let straight = PointerReach { up_tilt: 0.0, across_tilt: 0.0 };
        assert_eq!(straight.screen_degrees([2.0, 0.0]), [-2.0, -0.0]);
        assert_eq!(straight.screen_degrees([0.0, 3.0]), [-0.0, -3.0]);
    }

    #[test]
    fn arrival_delay_is_the_lateness_over_the_quickest_transit() {
        let mut delay = ArrivalDelay::default();
        assert_eq!(delay.measure(10.0, 110.0), 0.0);
        // Half a second late, less the baseline's creep (0.5 ms a second).
        assert!((delay.measure(10.1, 110.6) - 0.5).abs() < 1e-3);
        // An on-time sample again: no delay, and the baseline holds.
        assert!(delay.measure(10.2, 110.2) < 1e-3);
        // The band's clock restarted: start over.
        assert_eq!(delay.measure(1.0, 111.0), 0.0);
    }
}
