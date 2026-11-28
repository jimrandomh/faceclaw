//! From band gesture messages to at-most-once user gestures (kinesis
//! `GestureRouter`, `DialRouter`, `ActionGate` in `Gestures.swift`).

use std::collections::{HashMap, VecDeque};

use crate::events::GestureMessage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Swipe {
    Left,
    Right,
    Up,
    Down,
}

/// The band reports the middle finger's hold itself. The index hold is not the band's: an
/// index pinch held is how pinch and turn starts, so the bridge makes one from the press and
/// the release (a pinch held and let go without turning, see the bridge's controller).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tap {
    IndexTap,
    IndexDoubleTap,
    IndexHold,
    MiddleTap,
    MiddleDoubleTap,
    MiddleHold,
}

impl Tap {
    pub const ALL: [Tap; 6] = [
        Tap::IndexTap,
        Tap::IndexDoubleTap,
        Tap::IndexHold,
        Tap::MiddleTap,
        Tap::MiddleDoubleTap,
        Tap::MiddleHold,
    ];

    /// The taps the band reports as such ([GestureRouter]); the index hold isn't one.
    pub const REPORTED: [Tap; 5] = [
        Tap::IndexTap,
        Tap::IndexDoubleTap,
        Tap::MiddleTap,
        Tap::MiddleDoubleTap,
        Tap::MiddleHold,
    ];

    pub fn finger(self) -> &'static str {
        match self {
            Tap::IndexTap | Tap::IndexDoubleTap | Tap::IndexHold => "index",
            _ => "middle",
        }
    }

    pub fn action(self) -> &'static str {
        match self {
            Tap::IndexTap | Tap::MiddleTap => "tap",
            Tap::IndexDoubleTap | Tap::MiddleDoubleTap => "doubletap",
            Tap::IndexHold | Tap::MiddleHold => "hold",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Recognized {
    Swipe(Swipe),
    Tap(Tap),
}

fn swipe_named(name: &str) -> Option<Swipe> {
    match name {
        "left" => Some(Swipe::Left),
        "right" => Some(Swipe::Right),
        "up" => Some(Swipe::Up),
        "down" => Some(Swipe::Down),
        _ => None,
    }
}

fn derived_swipe(name: &str) -> Option<Swipe> {
    match name {
        "buttonLeft" => Some(Swipe::Left),
        "buttonRight" => Some(Swipe::Right),
        "buttonUp" => Some(Swipe::Up),
        "buttonDown" => Some(Swipe::Down),
        _ => None,
    }
}

fn derived_tap_action(name: &str) -> Option<&'static str> {
    match name {
        "singleTap" => Some("tap"),
        "doubleTap" => Some("doubletap"),
        "buttonHold" => Some("hold"),
        _ => None,
    }
}

/// The band reports many gestures twice (raw action and derived action) and
/// may repeat messages; this yields each gesture once. `reset` on reconnect.
#[derive(Debug, Default)]
pub struct GestureRouter {
    seen: VecDeque<String>,
    /// Last emission per gesture: (came from the derived field, received_at).
    last: HashMap<Recognized, (bool, f64)>,
}

impl GestureRouter {
    pub fn reset(&mut self) {
        self.seen.clear();
        self.last.clear();
    }

    pub fn gesture(&mut self, message: &GestureMessage, now: f64) -> Option<Recognized> {
        let age = now - message.received_at;
        if message.synthetic || !(-0.1..=0.35).contains(&age) {
            return None;
        }
        let derived_direction = derived_swipe(&message.derived_action);
        let direction = derived_direction.or_else(|| swipe_named(&message.action));
        let (gesture, from_derived) = match direction {
            Some(direction) if message.finger == "thumb" => {
                (Recognized::Swipe(direction), derived_direction.is_some())
            }
            _ => {
                let mapped = derived_tap_action(&message.derived_action);
                let action = mapped.unwrap_or(message.action.as_str());
                let tap = Tap::REPORTED
                    .into_iter()
                    .find(|tap| tap.finger() == message.finger && tap.action() == action)?;
                (Recognized::Tap(tap), mapped.is_some())
            }
        };
        let identity = format!(
            "{}:{}:{}:{}:{}",
            message.sequence,
            message.timestamp_us,
            message.finger,
            message.action,
            message.derived_action
        );
        if self.seen.contains(&identity) {
            return None;
        }
        self.seen.push_back(identity);
        if self.seen.len() > 128 {
            self.seen.pop_front();
        }
        if let Some(&(last_derived, last_time)) = self.last.get(&gesture)
            && last_derived != from_derived
            && (message.received_at - last_time).abs() < 0.18
        {
            return None;
        }
        self.last
            .insert(gesture, (from_derived, message.received_at));
        Some(gesture)
    }
}

/// Turns fractional dial movement into at most one ±1 step per 80 ms.
#[derive(Debug, Clone)]
pub struct DialRouter {
    remainder: f64,
    last_dispatch: f64,
    last_input: f64,
}

impl Default for DialRouter {
    fn default() -> Self {
        Self {
            remainder: 0.0,
            last_dispatch: f64::NEG_INFINITY,
            last_input: f64::NEG_INFINITY,
        }
    }
}

impl DialRouter {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One step per two degrees of relative rotation at sensitivity 1; excess
    /// whole steps from a fast flick are discarded.
    pub fn turn(&mut self, delta: f64, sensitivity: f64, now: f64) -> i32 {
        if !delta.is_finite()
            || !sensitivity.is_finite()
            || !now.is_finite()
            || !(0.5..=4.0).contains(&sensitivity)
        {
            return 0;
        }
        if now - self.last_input > 0.35 {
            self.reset();
        }
        self.last_input = now;
        if self.remainder * delta < 0.0 {
            self.remainder = 0.0;
        }
        self.remainder = (self.remainder + delta * sensitivity * 0.5).clamp(-2.0, 2.0);
        if now - self.last_dispatch < 0.08 {
            return 0;
        }
        let steps = (self.remainder.trunc() as i32).clamp(-1, 1);
        if steps == 0 {
            return 0;
        }
        self.remainder %= 1.0;
        self.last_dispatch = now;
        steps
    }
}

/// Only fresh events after `arm` may act, at most once per `minimum_interval`.
#[derive(Debug, Clone)]
pub struct ActionGate {
    armed_at: f64,
    last_action: f64,
    minimum_interval: f64,
}

impl Default for ActionGate {
    fn default() -> Self {
        Self::new(0.4)
    }
}

impl ActionGate {
    pub fn new(minimum_interval: f64) -> Self {
        Self {
            armed_at: f64::INFINITY,
            last_action: f64::NEG_INFINITY,
            minimum_interval,
        }
    }

    pub fn arm(&mut self, time: f64) {
        self.armed_at = time;
        self.last_action = f64::NEG_INFINITY;
    }

    pub fn pause(&mut self) {
        self.armed_at = f64::INFINITY;
    }

    /// For an action held back on purpose (a single tap waiting out its
    /// double tap): the event must have been fresh (`fresh`) and after `arm`;
    /// the rate limit counts from `now`.
    pub fn allows_held(&mut self, event_time: f64, fresh: bool, now: f64, live: bool) -> bool {
        if !(live && fresh && event_time >= self.armed_at)
            || now - self.last_action < self.minimum_interval
        {
            return false;
        }
        self.last_action = now;
        true
    }

    pub fn allows(&mut self, event_time: f64, now: f64, live: bool, trusted: bool) -> bool {
        let age = now - event_time;
        if !(live && trusted && event_time >= self.armed_at && (-0.1..=0.35).contains(&age))
            || now - self.last_action < self.minimum_interval
        {
            return false;
        }
        self.last_action = now;
        true
    }
}
