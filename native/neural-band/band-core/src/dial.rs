//! Relative wrist rotation while an index pinch is held (kinesis `PinchDial.swift`).

use crate::events::GestureMessage;

/// A tap is over in well under this. Only a pinch that outlasts it is a hold,
/// so neither press of a double tap arms the dial.
pub const ARM_DELAY: f64 = 0.18;

#[derive(Debug, Clone, Default)]
pub struct PinchDial {
    engaged: bool,
    index_pressed: Option<f64>,
    middle_pressed: Option<f64>,
    /// A press can only become a pinch if motion was already flowing when it began.
    index_can_arm: bool,
    last_gyro_at: Option<f64>,
    last_device_time: Option<u64>,
    bias: [f64; 3],
    integral: [f64; 3],
    axis: Option<usize>,
}

impl PinchDial {
    pub fn engaged(&self) -> bool {
        self.engaged
    }

    fn release(&mut self) {
        self.engaged = false;
        self.integral = [0.0; 3];
        self.axis = None;
    }

    fn motion_fresh(&self, now: f64) -> bool {
        self.last_gyro_at.is_some_and(|at| now - at < 0.35)
    }

    pub fn tick(&mut self, now: f64) {
        if self.last_gyro_at.is_some_and(|at| now - at >= 0.35) {
            self.index_pressed = None;
            self.middle_pressed = None;
            self.release();
        }
        if self.middle_pressed.is_some_and(|at| now - at >= 10.0) {
            self.middle_pressed = None;
        }
        if self.index_pressed.is_some_and(|at| now - at >= 10.0) {
            self.index_pressed = None;
            self.release();
        }
        if !self.engaged
            && self.index_can_arm
            && self.index_pressed.is_some_and(|at| now - at >= ARM_DELAY)
            && self.motion_fresh(now)
        {
            self.release();
            self.engaged = true;
        }
    }

    pub fn gesture(&mut self, gesture: &GestureMessage, now: f64) {
        self.tick(now);
        let index = match gesture.finger.as_str() {
            "index" => true,
            "middle" => false,
            _ => return,
        };
        if gesture.synthetic {
            return;
        }
        let press = gesture.action == "press" || gesture.derived_action == "buttonPress";
        let released = gesture.action == "release"
            || gesture.derived_action == "buttonRelease"
            || gesture.derived_action == "buttonHoldRelease";
        if press {
            if index && self.index_pressed.is_none() {
                self.index_pressed = Some(now);
                self.index_can_arm = self.motion_fresh(now);
            } else if !index && self.middle_pressed.is_none() {
                self.middle_pressed = Some(now);
            }
        }
        if released {
            if index {
                self.index_pressed = None;
                self.index_can_arm = false;
                self.release();
            } else {
                self.middle_pressed = None;
            }
        }
    }

    /// Feed one gyro sample (band clock `timestamp` in µs, raw int16 axes as f64).
    /// Returns rotation to apply while engaged: the accumulated integral once an
    /// axis dominates (≥ 0.25), then per-sample deltas on that axis.
    pub fn gyro(&mut self, timestamp: u64, values: [f64; 3], now: f64) -> Option<f64> {
        self.tick(now);
        let previous = self.last_device_time.replace(timestamp);
        self.last_gyro_at = Some(now);
        let previous = match previous {
            Some(previous) if timestamp > previous && timestamp - previous <= 50_000 => previous,
            _ => {
                if self.engaged {
                    self.index_pressed = None;
                    self.release();
                }
                return None;
            }
        };
        let dt = (timestamp - previous) as f64 / 1e6;
        let idle = self.index_pressed.is_none() && self.middle_pressed.is_none();
        if idle && (0..3).all(|i| (values[i] - self.bias[i]).abs() < 45.0) {
            let k = 1.0 - (-dt / 2.0).exp();
            for (i, &value) in values.iter().enumerate() {
                self.bias[i] += (value - self.bias[i]) * k;
            }
        }
        // Observed 0.07 gyro scale; this remains a relative, experimental estimate.
        let delta: [f64; 3] = std::array::from_fn(|i| (values[i] - self.bias[i]) * (0.07 * dt));
        if !self.engaged {
            return None;
        }
        for (i, &d) in delta.iter().enumerate() {
            self.integral[i] += d;
        }
        if self.axis.is_none() {
            // First maximum wins on ties, like Swift's max(by:).
            let mut dominant = 0;
            for i in 1..3 {
                if self.integral[dominant].abs() < self.integral[i].abs() {
                    dominant = i;
                }
            }
            if self.integral[dominant].abs() >= 0.25 {
                self.axis = Some(dominant);
                return Some(self.integral[dominant]);
            }
        }
        self.axis.map(|axis| delta[axis])
    }
}

#[cfg(test)]
mod tests {
    use super::PinchDial;
    use crate::events::GestureMessage;

    fn pinch(action: &str, time: f64) -> GestureMessage {
        GestureMessage {
            sequence: 1,
            timestamp_us: 1,
            finger: "index".into(),
            action: action.into(),
            derived_action: "unknown".into(),
            synthetic: false,
            received_at: time,
        }
    }

    #[test]
    fn a_held_pinch_with_motion_arms_after_the_delay_and_reports_rotation() {
        let mut dial = PinchDial::default();
        assert_eq!(dial.gyro(1_000_000, [1000.0, 0.0, 0.0], 0.0), None);
        dial.gesture(&pinch("press", 0.02), 0.02);
        let mut stamp = 1_000_000u64;
        let mut now = 0.03;
        let mut first = None;
        while now <= 0.22 + 1e-9 {
            stamp += 10_000;
            if let Some(delta) = dial.gyro(stamp, [1000.0, 0.0, 0.0], now) {
                first.get_or_insert(delta);
            }
            now += 0.01;
        }
        assert!(dial.engaged());
        assert!((first.unwrap() - 0.7).abs() < 1e-9);
        dial.gesture(&pinch("release", 0.23), 0.23);
        assert!(!dial.engaged());
    }

    #[test]
    fn motion_loss_releases_the_dial() {
        let mut dial = PinchDial::default();
        dial.gyro(1_000_000, [0.0; 3], 0.0);
        dial.gesture(&pinch("press", 0.01), 0.01);
        dial.gyro(1_010_000, [0.0; 3], 0.2);
        assert!(dial.engaged());
        dial.tick(0.6);
        assert!(!dial.engaged());
    }
}
