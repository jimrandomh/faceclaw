//! Copied from air-gestures' `air-gesturesd/src/controller.rs` (91e7217); here
//! the commands are app action names instead of shell commands.
//!
//! What to do with each band event — a port of the event handling in kinesis
//! `BandModel.swift` (~L840–990). Pure: no I/O; time is passed in.

use band_core::events::{Event, GestureMessage, Hand};
use band_core::gestures::{ActionGate, DialRouter, GestureRouter, Recognized, Swipe, Tap};
use band_core::pointer::{AirPointer, Approach, ArrivalDelay, ForearmAim, PointerReach, acceleration};

use writing::assistant::Op;

use crate::config::{Config, DialTarget, HandSetting, PAUSE_TOGGLE, POINTER_TOGGLE, ToggleGesture};
use crate::status::Status;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Run this shell command.
    Run(String),
    /// Ask the band to switch hands.
    SetHand(Hand),
    /// A thumb swipe on the writing's suggestions, at this band time (µs).
    Write(Op, u64),
}

fn label(gesture: Recognized) -> &'static str {
    match gesture {
        Recognized::Swipe(Swipe::Left) => "swipe left",
        Recognized::Swipe(Swipe::Right) => "swipe right",
        Recognized::Swipe(Swipe::Up) => "swipe up",
        Recognized::Swipe(Swipe::Down) => "swipe down",
        Recognized::Tap(Tap::IndexTap) => "index tap",
        Recognized::Tap(Tap::IndexDoubleTap) => "index double tap",
        Recognized::Tap(Tap::IndexHold) => "index hold",
        Recognized::Tap(Tap::MiddleTap) => "middle tap",
        Recognized::Tap(Tap::MiddleDoubleTap) => "middle double tap",
        Recognized::Tap(Tap::MiddleHold) => "middle hold",
    }
}

#[derive(Default)]
struct TripleTap {
    count: u8,
    last_tap: Option<f64>,
    pending: Option<HeldTap>,
    fired_at: Option<f64>,
}

#[derive(Clone, Copy)]
struct HoldContact {
    pressed_at: f64,
    started: bool,
    dial_won: bool,
}

const MAX_HOLD: f64 = 60.0;
const HOLD_REPORT_GAP: f64 = 0.18;

/// How long a single tap waits for its double tap. On the band the second tap
/// follows 0.25–0.33 s after the first, and the double tap arrives with it.
pub const DOUBLE_TAP_WAIT: f64 = 0.4;

/// A single tap held back while its finger's double tap may still come.
#[derive(Debug, Clone, Copy)]
struct HeldTap {
    tap: Tap,
    fire_at: f64,
    received_at: f64,
}

/// The most time between the taps of a triple tap (the band's own double tap
/// needs them under ~0.33 s apart; a triple tap is a little slower).
pub const TRIPLE_TAP_GAP: f64 = 0.45;

/// The triple-tap toggle this tap could be part of.
fn triple_of(tap: Tap) -> ToggleGesture {
    match tap {
        Tap::IndexTap | Tap::IndexDoubleTap => ToggleGesture::IndexTriple,
        Tap::MiddleTap | Tap::MiddleDoubleTap => ToggleGesture::MiddleTriple,
        Tap::IndexHold | Tap::MiddleHold => ToggleGesture::None,
    }
}

/// An index pinch held at least this long and let go without turning is an index hold.
pub const INDEX_HOLD: f64 = 0.6;

/// Turning the wrist this much (degrees, either way) while the index pinch is held makes it
/// pinch and turn rather than a hold, even if no step came of it.
const INDEX_HOLD_TURN: f64 = 6.0;

fn double_of(tap: Tap) -> Option<Tap> {
    match tap {
        Tap::IndexTap => Some(Tap::IndexDoubleTap),
        Tap::MiddleTap => Some(Tap::MiddleDoubleTap),
        _ => None,
    }
}

fn hand_name(hand: Hand) -> &'static str {
    match hand {
        Hand::Left => "left",
        Hand::Right => "right",
    }
}

/// The app's action when the band turns the air mouse off: its gesture again, a mapping without
/// it, the controls paused.
pub const POINTER_OFF: &str = "pointer.off";

/// What [Controller::take_pointer] hands the app, four numbers each: kind, time, a, b.
/// MOVE: a sample's movement, `a` degrees right and `b` down, `time` when the band sampled it
/// (host clock).
pub const RECORD_MOVE: f64 = 0.0;
/// CLEAR: drop the movement waiting to play (a pinch, a pause, stale data).
pub const RECORD_CLEAR: f64 = 1.0;
/// BUTTONS: the mouse buttons held now, `a` = 1 left, 2 right, 0 none.
pub const RECORD_BUTTONS: f64 = 2.0;

/// While the air mouse runs, a pinch of the finger whose tap turns it off waits this long to tell
/// a quick pinch (off) from a held one (a press, a drag); a double tap's second pinch must come
/// within [SWITCH_DOUBLE_WINDOW] (kinesis `holdForCursorSwitch`).
const SWITCH_HOLD_LIMIT: f64 = 0.35;
const SWITCH_DOUBLE_WINDOW: f64 = 0.3;
/// A thumb gesture holds the pointer still this long and drops what its twitch moved.
const STEADY_AFTER_GESTURE: f64 = 0.12;
/// A pinch older than this when it reaches the pointer is dropped.
const POINTER_FRESH: f64 = 0.1;
/// Without an orientation sample this recent the pointer stops.
const STALE_ORIENTATION: f64 = 0.15;
/// Motion this late (band clock) is where the arm was, not where it is: dropped. Late for
/// [LATE_RELEASE_AFTER] lets go of a held button, so nothing stays stuck down.
const LATE_INPUT: f64 = 0.3;
const LATE_RELEASE_AFTER: f64 = 1.0;
const LATE_WINDOW: f64 = 0.5;

/// The air mouse's settings from the app: `steadiness=0.5;boost=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerTuning {
    pub steadiness: f64,
    pub boost: f64,
}

impl Default for PointerTuning {
    fn default() -> Self {
        Self { steadiness: 0.5, boost: acceleration::FAST_FACTOR }
    }
}

impl PointerTuning {
    pub fn parse(text: &str) -> Self {
        let mut tuning = Self::default();
        for pair in text.split(';') {
            let Some((key, value)) = pair.split_once('=') else { continue };
            let Ok(value) = value.trim().parse::<f64>() else { continue };
            if !value.is_finite() {
                continue;
            }
            match key.trim() {
                "steadiness" => tuning.steadiness = value.clamp(0.0, 1.0),
                "boost" => tuning.boost = value.clamp(*acceleration::FLICK_BOOSTS.start(), *acceleration::FLICK_BOOSTS.end()),
                _ => {}
            }
        }
        tuning
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Replay {
    Press,
    Click,
}

/// A pinch of the switch finger, waiting to become a click, a press or the switch.
#[derive(Debug, Clone, Copy)]
struct SwitchWait {
    finger: usize,
    due: f64,
    replay: Replay,
    released: bool,
}

/// Clicks that may form a physical double or triple shortcut in pointer mode.
#[derive(Debug, Clone, Copy, Default)]
struct PointerChord {
    taps: u8,
    pressed: bool,
    due: f64,
}

/// The air mouse while it runs (ported from kinesis `BandModel.swift`'s cursor).
struct PointerMode {
    air: AirPointer,
    reach: PointerReach,
    armed_at: f64,
    /// Index and middle pinched since it started.
    pressed: [bool; 2],
    /// The finger holding a button.
    held: Option<usize>,
    wait: Option<SwitchWait>,
    second_until: Option<f64>,
    chords: [Option<PointerChord>; 2],
    needs_anchor: bool,
    resumes_at: f64,
    last_orientation: f64,
    stale: bool,
    records: Vec<f64>,
}

impl PointerMode {
    fn record(&mut self, kind: f64, time: f64, a: f64, b: f64) {
        self.records.extend([kind, time, a, b]);
    }

    /// Hold the pointer still until `time`, and drop what moved meanwhile.
    fn steady(&mut self, time: f64) {
        self.resumes_at = self.resumes_at.max(time);
        self.needs_anchor = true;
    }
}

fn finger_slot(finger: &str) -> Option<usize> {
    match finger {
        "index" => Some(0),
        "middle" => Some(1),
        _ => None,
    }
}

/// A pinch's onset (not its hold report, which describes the same contact).
fn is_press(message: &GestureMessage) -> bool {
    let actions = [message.action.as_str(), message.derived_action.as_str()];
    actions.iter().any(|a| *a == "press" || *a == "buttonPress") && !actions.contains(&"buttonHold")
}

/// The band's own double tap report (it may come without a second press report).
fn is_double_tap(message: &GestureMessage) -> bool {
    message.action == "doubletap" || message.derived_action == "doubleTap"
}

/// After the air mouse turns off, its gesture is ignored this long: the band's own report of the
/// same double tap comes after the pinches that turned it off, and must not turn it on again.
const SWITCHED_OFF_QUIET: f64 = 0.6;
/// The shortest time between two actions while the band writes.
const WRITING_INTERVAL: f64 = 0.25;

fn is_release(message: &GestureMessage) -> bool {
    [message.action.as_str(), message.derived_action.as_str()]
        .iter()
        .any(|a| matches!(*a, "release" | "buttonRelease" | "buttonHoldRelease"))
}

pub struct Controller {
    config: Config,
    dial_target: DialTarget,
    router: GestureRouter,
    gate: ActionGate,
    dial_gate: ActionGate,
    /// The middle tap that ends the writing: armed while the band writes, whether or not the
    /// controls are paused.
    writing_gate: ActionGate,
    dial_router: DialRouter,
    /// Controls are on (the user hasn't paused).
    enabled: bool,
    /// The band's input subscription is up.
    live: bool,
    hand: Option<Hand>,
    hand_confirmed: bool,
    hand_requested: bool,
    /// Whether the one automatic retry (see `on_event`'s `Handedness` arm) has
    /// already been used for the current request.
    hand_retry_used: bool,
    /// A runtime hand request (e.g. from the control socket) that wins over
    /// the configured hand until the config reloads.
    hand_override: Option<Hand>,
    dial_armed: bool,
    dial_engaged: bool,
    dial_turned: bool,
    dial_ended_at: f64,
    last_dial_action: f64,
    held_tap: Option<HeldTap>,
    triple_taps: [TripleTap; 2],
    holds: [Option<HoldContact>; 2],
    hold_ended_at: [Option<f64>; 2],
    hold_cancelled: [bool; 2],
    hold_cancellations: Vec<Command>,
    /// Recent single taps of the toggle finger, for the triple tap.
    toggle_taps: Vec<f64>,
    /// When a triple tap last toggled (its third tap may also report a double).
    toggled_at: f64,
    /// The band's handwriting runs: only the middle tap counts (see [Controller::set_writing]).
    writing: bool,
    /// The writing has suggestions: the thumb's swipes work them (see [Controller::set_writing_assist]).
    writing_assist: bool,
    /// The air mouse (see [Controller::set_pointer]).
    pointer: Option<PointerMode>,
    /// Index and middle held now, whatever the mode.
    pinched: [bool; 2],
    arrival: ArrivalDelay,
    link_delay: f64,
    link_delay_at: f64,
    late_since: Option<f64>,
    on_time_since: Option<f64>,
    congested: bool,
    /// When the air mouse last turned itself off (see [SWITCHED_OFF_QUIET]).
    pointer_off_at: f64,
    /// When the index pinch now held began, for the index hold ([INDEX_HOLD]).
    index_pressed_at: Option<f64>,
    /// How far the wrist turned while it's held (degrees, signed).
    index_turn: f64,
    /// When an index hold last ran: the band's tap reports of the same pinch don't.
    index_hold_at: f64,
    delay_max: f64,
    delay_samples: u32,
    status: Status,
}

impl Controller {
    pub fn new(config: Config) -> Self {
        let enabled = config.band.autostart;
        let status = Status {
            paused: !enabled,
            dial: config.dial.target,
            ..Status::default()
        };
        Self {
            dial_target: config.dial.target,
            config,
            router: GestureRouter::default(),
            gate: ActionGate::default(),
            dial_gate: ActionGate::new(0.0),
            writing_gate: ActionGate::new(WRITING_INTERVAL),
            dial_router: DialRouter::default(),
            enabled,
            live: false,
            hand: None,
            hand_confirmed: false,
            hand_requested: false,
            hand_retry_used: false,
            hand_override: None,
            dial_armed: false,
            dial_engaged: false,
            dial_turned: false,
            dial_ended_at: f64::NEG_INFINITY,
            last_dial_action: f64::NEG_INFINITY,
            held_tap: None,
            triple_taps: Default::default(),
            holds: [None; 2],
            hold_ended_at: [None; 2],
            hold_cancelled: [false; 2],
            hold_cancellations: Vec::new(),
            toggle_taps: Vec::new(),
            toggled_at: f64::NEG_INFINITY,
            writing: false,
            writing_assist: false,
            pointer: None,
            pinched: [false; 2],
            arrival: ArrivalDelay::default(),
            link_delay: 0.0,
            link_delay_at: f64::NEG_INFINITY,
            late_since: None,
            on_time_since: None,
            congested: false,
            pointer_off_at: f64::NEG_INFINITY,
            index_pressed_at: None,
            index_turn: 0.0,
            index_hold_at: f64::NEG_INFINITY,
            delay_max: 0.0,
            delay_samples: 0,
            status,
        }
    }

    /// While the band's handwriting runs (and while it's being switched off: the hand is often
    /// still moving), a writing stroke can look like any gesture (the middle hold that pauses
    /// included): only the middle tap counts, at once and even while paused, so it can always
    /// end the writing. The dial is off. `now` arms that tap when the writing starts.
    pub fn set_writing(&mut self, writing: bool, now: f64) {
        if writing != self.writing {
            self.cancel_holds();
            self.triple_taps = Default::default();
            self.writing = writing;
            self.held_tap = None;
            self.toggle_taps.clear();
            self.index_pressed_at = None;
            // Its own gate: the pause disarms the controls' one, and writing can start while
            // paused (the touchpad opens the keyboard).
            if writing {
                self.writing_gate.arm(now);
            } else {
                self.writing_gate.pause();
            }
        }
        if writing {
            self.end_pointer(f64::NEG_INFINITY);
        }
    }

    /// While the band writes with suggestions, the thumb's swipes are theirs: right accepts,
    /// left undoes, up and down move between them ([Command::Write]). Measured on the band
    /// (2026-10-11): the swipes arrive while the model writes, and write nothing themselves.
    pub fn set_writing_assist(&mut self, on: bool) {
        self.writing_assist = on;
    }

    pub fn pointer_on(&self) -> bool {
        self.pointer.is_some()
    }

    /// Whether some gesture pauses and resumes the controls ([PAUSE_TOGGLE]).
    pub fn can_pause(&self) -> bool {
        self.config.gestures.has(PAUSE_TOGGLE)
    }

    /// The air mouse on or off (the app asks after the gesture mapped to [POINTER_TOGGLE] ran).
    /// While it runs the forearm's aim moves the pointer ([Controller::take_pointer]); the
    /// index pinch is the left button and the middle pinch the right one (held, they drag);
    /// thumb gestures keep their actions; the dial is off. The same gesture turns it off: a
    /// pinch of that finger waits a moment to tell the switch from a click. On again only
    /// retunes. It can't start without a live band or while the band writes: then it answers
    /// [POINTER_OFF].
    pub fn set_pointer(&mut self, on: bool, tuning: PointerTuning, now: f64) -> Vec<Command> {
        if !on {
            self.end_pointer(now);
            return Vec::new();
        }
        if let Some(mode) = &mut self.pointer {
            mode.air.steadiness = tuning.steadiness;
            mode.air.fast_factor = tuning.boost;
            return Vec::new();
        }
        if !self.live || self.writing {
            return vec![Command::Run(POINTER_OFF.into())];
        }
        let mut air = AirPointer::default();
        air.steadiness = tuning.steadiness;
        air.fast_factor = tuning.boost;
        self.pointer = Some(PointerMode {
            air,
            reach: PointerReach::standard(self.hand.unwrap_or(Hand::Right)),
            armed_at: now,
            pressed: self.pinched,
            held: None,
            wait: None,
            second_until: None,
            chords: [None; 2],
            needs_anchor: true,
            resumes_at: f64::NEG_INFINITY,
            last_orientation: f64::NEG_INFINITY,
            stale: true,
            records: Vec::new(),
        });
        self.router.reset();
        self.held_tap = None;
        self.triple_taps = Default::default();
        self.cancel_holds();
        self.toggle_taps.clear();
        self.reset_dial();
        self.dial_engaged = false;
        self.dial_turned = false;
        self.dial_ended_at = now;
        Vec::new()
    }

    fn end_pointer(&mut self, now: f64) {
        if self.pointer.take().is_some() {
            // Its pinches were clicks, not the start of an index hold.
            self.index_pressed_at = None;
            self.router.reset();
            self.dial_ended_at = self.dial_ended_at.max(now);
        }
    }

    /// Turned off by its own gesture.
    fn switch_off(&mut self, now: f64) -> Vec<Command> {
        self.end_pointer(now);
        self.pointer_off_at = now;
        self.status.last_gesture = Some("air mouse off".into());
        self.status.last_action = Some(POINTER_OFF.into());
        vec![Command::Run(POINTER_OFF.into())]
    }

    /// The air mouse's records since the last call (see [RECORD_MOVE]): this moment's share of
    /// the movement, in screen degrees, and the buttons. Stale or steadied, the movement is
    /// dropped (a CLEAR).
    pub fn take_pointer(&mut self, now: f64) -> Vec<f64> {
        let Some(mode) = &mut self.pointer else {
            return Vec::new();
        };
        if now - mode.last_orientation > STALE_ORIENTATION {
            if !mode.stale {
                mode.stale = true;
                mode.record(RECORD_CLEAR, now, 0.0, 0.0);
            }
            mode.air.discard();
            return std::mem::take(&mut mode.records);
        }
        mode.stale = false;
        if let Some(movement) = mode.air.take_movement() {
            if now < mode.resumes_at || mode.needs_anchor {
                // A pinch, a thumb gesture or the first moment drops what moved meanwhile.
                if now >= mode.resumes_at {
                    mode.needs_anchor = false;
                }
                mode.record(RECORD_CLEAR, now, 0.0, 0.0);
            } else {
                for (time, step) in movement {
                    let [right, down] = mode.reach.screen_degrees(step);
                    mode.record(RECORD_MOVE, time, right, down);
                }
            }
        }
        std::mem::take(&mut mode.records)
    }

    /// When a switch pinch's wait is due (see [Controller::fire_pointer_wait]).
    pub fn pointer_due(&self) -> Option<f64> {
        let mode = self.pointer.as_ref()?;
        mode.wait.map(|wait| wait.due).into_iter()
            .chain(mode.chords.iter().flatten().map(|chord| chord.due))
            .min_by(f64::total_cmp)
    }

    /// A switch pinch that turned out to be a press (held) or a click (a double tap's lone pinch).
    pub fn fire_pointer_wait(&mut self, now: f64) -> Vec<Command> {
        let commands = self.fire_pointer_chords(now);
        let Some(mode) = &mut self.pointer else {
            return commands;
        };
        let Some(wait) = mode.wait.filter(|wait| now >= wait.due) else {
            return commands;
        };
        mode.wait = None;
        mode.second_until = None;
        match wait.replay {
            Replay::Press if !wait.released => self.pointer_finger(wait.finger, true, now, now),
            Replay::Press => {}
            Replay::Click => {
                self.pointer_finger(wait.finger, true, now, now);
                self.pointer_finger(wait.finger, false, now, now);
            }
        }
        commands
    }

    fn pointer_double_action(&self, finger: usize) -> Option<&str> {
        let tap = if finger == 0 { Tap::IndexDoubleTap } else { Tap::MiddleDoubleTap };
        let action = self.config.gestures.command(Recognized::Tap(tap));
        matches!(action, "double-click" | "screen-toggle").then_some(action)
    }

    fn fire_pointer_chords(&mut self, now: f64) -> Vec<Command> {
        let mut commands = Vec::new();
        for finger in 0..2 {
            let Some(mode) = &mut self.pointer else { break };
            let pending = &mut mode.chords[finger];
            let Some(chord) = pending.filter(|chord| now >= chord.due) else { continue };
            *pending = None;
            if chord.pressed {
                self.pointer_finger(finger, true, now, now);
            } else if chord.taps == 1 {
                self.pointer_finger(finger, true, now, now);
                self.pointer_finger(finger, false, now, now);
            } else if chord.taps == 2 && let Some(action) = self.pointer_double_action(finger) {
                commands.push(Command::Run(action.into()));
            }
        }
        commands
    }

    /// How late motion arrives, by the band's clock; a congested link lets go of the button.
    /// The largest motion delay since the last call, and how many samples it covers (for the log).
    pub fn take_delay_report(&mut self) -> (f64, u32) {
        let report = (self.delay_max, self.delay_samples);
        self.delay_max = 0.0;
        self.delay_samples = 0;
        report
    }

    fn measure_delay(&mut self, band_us: u64, host: f64) -> f64 {
        let delay = self.arrival.measure(band_us as f64 / 1e6, host);
        self.link_delay = delay;
        self.link_delay_at = host;
        self.delay_max = self.delay_max.max(delay);
        self.delay_samples += 1;
        if delay > LATE_INPUT {
            self.on_time_since = None;
            let since = *self.late_since.get_or_insert(host);
            if host - since >= LATE_RELEASE_AFTER && !self.congested {
                self.congested = true;
                if let Some(mode) = &mut self.pointer
                    && mode.held.take().is_some()
                {
                    mode.record(RECORD_BUTTONS, host, 0.0, 0.0);
                }
            }
        } else {
            self.late_since = None;
            let since = *self.on_time_since.get_or_insert(host);
            if self.congested && host - since >= 2.0 {
                self.congested = false;
            }
        }
        delay
    }

    fn link_is_late(&self, now: f64) -> bool {
        now - self.link_delay_at <= LATE_WINDOW && self.link_delay > LATE_INPUT
    }

    fn pointer_gyro(&mut self, timestamp_us: u64, raw: [i16; 3], now: f64) {
        if self.pointer.is_none() {
            return;
        }
        let delay = self.measure_delay(timestamp_us, now);
        if let Some(mode) = &mut self.pointer
            && delay <= LATE_INPUT
        {
            mode.air.receive_gyro(raw.map(f64::from), now - delay);
        }
    }

    fn pointer_orientation(&mut self, timestamp_us: u64, quaternion: [f32; 4], now: f64) {
        if self.pointer.is_none() {
            return;
        }
        let hand = self.hand.unwrap_or(Hand::Right);
        let Some(aim) = ForearmAim::from_quaternion(quaternion.map(f64::from), hand) else {
            return;
        };
        let delay = self.measure_delay(timestamp_us, now);
        let Some(mode) = &mut self.pointer else { return };
        // A late sample skips: the pointer pauses, and the gap re-anchors it when data returns.
        if delay > LATE_INPUT {
            return;
        }
        // The band's own clock says when it sampled: two samples share each radio batch.
        if !mode.air.receive(aim, now - delay) {
            mode.needs_anchor = true;
        }
        mode.last_orientation = now;
    }

    /// An index or middle pinch while the air mouse runs.
    fn pointer_gesture(&mut self, message: &GestureMessage, finger: usize, now: f64) -> Vec<Command> {
        let press = is_press(message);
        let release = is_release(message);
        if message.synthetic {
            return Vec::new();
        }
        if let Some(commands) = self.pointer_chord(message, finger, now) {
            return commands;
        }
        // A double tap bound to the switch: the band's own report of it turns the air mouse off
        // too (the second pinch may arrive only as that report, with no press).
        if is_double_tap(message)
            && let Some(bound) = self.config.gestures.pointer_tap()
            && matches!(bound, Tap::IndexDoubleTap | Tap::MiddleDoubleTap)
            && finger_slot(bound.finger()) == Some(finger)
        {
            if let Some(mode) = &mut self.pointer {
                // The first pinch's click must not happen after all.
                mode.wait = None;
                mode.second_until = None;
            }
            return self.switch_off(now);
        }
        // The band's tap, double tap and hold reports describe the same pinches: ignored.
        if !(press || release) {
            return Vec::new();
        }
        if self.link_is_late(now) {
            // Late: a press is where the hand was. A release still lets go.
            if release && let Some(mode) = &mut self.pointer {
                mode.pressed[finger] = false;
                if mode.held == Some(finger) {
                    mode.held = None;
                    mode.record(RECORD_BUTTONS, now, 0.0, 0.0);
                }
            }
            return Vec::new();
        }
        if let Some(commands) = self.hold_for_switch(finger, press, now) {
            return commands;
        }
        self.pointer_finger(finger, press, message.received_at, now);
        Vec::new()
    }

    /// Recognize shortcuts without emitting the mouse clicks that formed them.
    /// The chosen finger's ordinary click waits for the next quick pinch.
    fn pointer_chord(&mut self, message: &GestureMessage, finger: usize, now: f64) -> Option<Vec<Command>> {
        let triple = self.config.gestures.pinches[finger].triple == POINTER_TOGGLE;
        let double = self.pointer_double_action(finger).map(str::to_owned);
        if !triple && double.is_none() {
            return None;
        }
        let late = self.link_is_late(now);
        let mode = self.pointer.as_mut()?;
        let pending = &mut mode.chords[finger];
        if late || mode.pressed[finger] {
            *pending = None;
            return None;
        }
        let mut chord = pending.filter(|chord| now <= chord.due).unwrap_or_default();
        if is_press(message) {
            if !chord.pressed {
                chord.pressed = true;
                chord.due = now + SWITCH_HOLD_LIMIT;
                *pending = Some(chord);
            }
            return Some(Vec::new());
        }
        if is_release(message) && chord.pressed {
            chord.pressed = false;
            chord.taps += 1;
        } else if is_double_tap(message) && !chord.pressed && chord.taps == 1 {
            // Some Band firmware reports the double without a second contact.
            chord.taps = 2;
        } else {
            return Some(Vec::new());
        }
        if triple && chord.taps == 3 {
            return Some(self.switch_off(now));
        }
        if !triple && chord.taps == 2 {
            *pending = None;
            return Some(double.into_iter().map(Command::Run).collect());
        }
        chord.due = now + if triple { TRIPLE_TAP_GAP } else { SWITCH_DOUBLE_WINDOW };
        *pending = Some(chord);
        Some(Vec::new())
    }

    /// The finger whose tap turns the air mouse off waits to tell the switch from a click: a
    /// double tap waits for a second pinch, a single tap for the release (a pinch held past
    /// [SWITCH_HOLD_LIMIT] presses, for a drag). The other finger never waits. `None`: not taken.
    fn hold_for_switch(&mut self, finger: usize, press: bool, now: f64) -> Option<Vec<Command>> {
        let bound = self.config.gestures.pointer_tap()?;
        if finger_slot(bound.finger()) != Some(finger) {
            return None;
        }
        let double = matches!(bound, Tap::IndexDoubleTap | Tap::MiddleDoubleTap);
        let mode = self.pointer.as_mut()?;
        if press {
            if double && mode.second_until.is_some_and(|until| now <= until) {
                // Its release then takes the ordinary path, where it does nothing.
                mode.wait = None;
                mode.second_until = None;
                return Some(self.switch_off(now));
            }
            mode.wait = Some(SwitchWait { finger, due: now + SWITCH_HOLD_LIMIT, replay: Replay::Press, released: false });
            return Some(Vec::new());
        }
        let wait = mode.wait.as_mut().filter(|wait| wait.finger == finger)?;
        if !double {
            mode.wait = None;
            return Some(self.switch_off(now));
        }
        // No second pinch in time: the click it was.
        wait.released = true;
        wait.replay = Replay::Click;
        wait.due = now + SWITCH_DOUBLE_WINDOW;
        mode.second_until = Some(now + SWITCH_DOUBLE_WINDOW);
        Some(Vec::new())
    }

    /// A pinch as a mouse button: down at the pinch, up at the release, one button at a time.
    /// Held still or settling onto a target, the drift that follows a pinch is absorbed.
    fn pointer_finger(&mut self, finger: usize, press: bool, received_at: f64, now: f64) {
        let delay = if self.link_is_late(now) { 0.0 } else { self.link_delay.min(LATE_INPUT) };
        let Some(mode) = &mut self.pointer else { return };
        if received_at < mode.armed_at || now - received_at > POINTER_FRESH {
            return;
        }
        let guard = mode.air.approach() != Approach::Tracking;
        if !press {
            if mode.pressed[finger] {
                mode.pressed[finger] = false;
                if guard {
                    mode.air.guard_click(received_at - delay);
                    mode.record(RECORD_CLEAR, now, 0.0, 0.0);
                }
                if mode.held == Some(finger) {
                    mode.held = None;
                    mode.record(RECORD_BUTTONS, now, 0.0, 0.0);
                }
            }
            return;
        }
        if mode.pressed[finger] {
            return;
        }
        mode.pressed[finger] = true;
        if guard {
            mode.air.guard_click(received_at - delay);
            mode.record(RECORD_CLEAR, now, 0.0, 0.0);
        }
        if mode.held.is_some() {
            mode.record(RECORD_BUTTONS, now, 0.0, 0.0);
        }
        mode.held = Some(finger);
        mode.record(RECORD_BUTTONS, now, if finger == 0 { 1.0 } else { 2.0 }, 0.0);
        self.status.gestures += 1;
        self.status.last_gesture = Some(if finger == 0 { "left click" } else { "right click" }.into());
    }

    /// Gesture, dial and control fields of the status (the daemon adds the rest).
    pub fn status(&self) -> &Status {
        &self.status
    }

    /// Apply a reloaded config. A changed dial target in the file wins over a
    /// runtime switch; a changed hand setting is applied if the band is live.
    pub fn set_config(&mut self, config: Config) -> Vec<Command> {
        if config.dial.target != self.config.dial.target {
            self.dial_target = config.dial.target;
            self.status.dial = config.dial.target;
        }
        let mapped_pointer = self.config.gestures.has_pointer_toggle();
        if config.gestures != self.config.gestures {
            self.cancel_holds();
            self.triple_taps = Default::default();
            self.held_tap = None;
            if let Some(mode) = &mut self.pointer {
                mode.wait = None;
                mode.second_until = None;
                mode.chords = [None; 2];
            }
        }
        self.config = config;
        self.hand_override = None;
        self.hand_requested = false;
        self.hand_retry_used = false;
        self.reset_dial();
        let mut commands = Vec::new();
        // A mapping with no way to turn it off ends the air mouse.
        if self.pointer.is_some() && mapped_pointer && !self.config.gestures.has_pointer_toggle() {
            self.end_pointer(f64::NEG_INFINITY);
            commands.push(Command::Run(POINTER_OFF.into()));
        }
        commands.extend(self.maybe_request_hand());
        commands
    }

    /// Ask the band to switch hands right now (e.g. from the control socket).
    /// This overrides the configured hand until the config reloads.
    pub fn request_hand(&mut self, hand: Hand) -> Vec<Command> {
        self.hand_override = Some(hand);
        self.hand_requested = false;
        self.hand_retry_used = false;
        self.maybe_request_hand()
    }

    pub fn resume(&mut self, now: f64) {
        self.enabled = true;
        self.status.paused = false;
        if self.live {
            self.gate.arm(now);
        }
        self.reset_dial();
    }

    pub fn pause(&mut self) {
        self.enabled = false;
        self.status.paused = true;
        self.end_pointer(f64::NEG_INFINITY);
        self.cancel_holds();
        self.triple_taps = Default::default();
        self.suspend();
    }

    pub fn toggle(&mut self, now: f64) {
        if self.enabled {
            self.pause()
        } else {
            self.resume(now)
        }
    }

    pub fn set_dial_target(&mut self, target: DialTarget) {
        self.dial_target = target;
        self.status.dial = target;
        self.reset_dial();
    }

    pub fn cycle_dial(&mut self) {
        self.set_dial_target(self.dial_target.next());
    }

    pub fn on_disconnect(&mut self) {
        self.live = false;
        self.hand = None;
        self.hand_confirmed = false;
        self.hand_requested = false;
        self.hand_retry_used = false;
        self.suspend();
        self.cancel_holds();
        self.triple_taps = Default::default();
        self.hold_ended_at = [None; 2];
        self.hold_cancelled = [false; 2];
        self.end_pointer(f64::NEG_INFINITY);
        self.pinched = [false; 2];
        self.held_tap = None;
        self.index_pressed_at = None;
        self.toggle_taps.clear();
        self.router.reset();
        self.status.charging = None;
    }

    pub fn on_event(&mut self, event: &Event, now: f64) -> Vec<Command> {
        match event {
            Event::Connected => {
                self.live = true;
                if self.enabled {
                    self.gate.arm(now);
                }
                self.maybe_request_hand()
            }
            Event::Handedness(hand) => {
                self.hand = Some(*hand);
                if let Some(mode) = &mut self.pointer {
                    mode.reach = PointerReach::standard(*hand);
                }
                self.hand_confirmed = true;
                self.status.hand = Some(hand_name(*hand).into());
                // The band still disagrees with an outstanding request: the
                // write may have been lost or refused. Retry once.
                if self.hand_requested
                    && !self.hand_retry_used
                    && self.desired_hand().is_some_and(|wanted| wanted != *hand)
                {
                    self.hand_retry_used = true;
                    self.hand_requested = false;
                }
                self.maybe_request_hand()
            }
            Event::HandednessFailure(_) => {
                self.hand_confirmed = false;
                Vec::new()
            }
            Event::BatteryStatus(Some(status)) => {
                self.status.battery = Some(status.level);
                self.status.charging = status.charging;
                Vec::new()
            }
            Event::BatteryStatus(None) => {
                self.status.charging = None;
                Vec::new()
            }
            Event::Gesture(message) => self.gesture(message, now),
            Event::Gyro { timestamp_us, raw } => {
                self.pointer_gyro(*timestamp_us, *raw, now);
                Vec::new()
            }
            Event::Orientation { timestamp_us, quaternion } => {
                self.pointer_orientation(*timestamp_us, *quaternion, now);
                Vec::new()
            }
            // The air mouse's index pinch is a click, not the dial's.
            Event::DialState(_) if self.pointer.is_some() => Vec::new(),
            Event::DialState(engaged) => {
                self.dial_state(*engaged, now);
                Vec::new()
            }
            Event::DialTurn(_) if self.writing || self.pointer.is_some() => Vec::new(),
            Event::DialTurn(rotation) => self.dial_turn(*rotation, now),
            _ => Vec::new(),
        }
    }

    fn gesture(&mut self, message: &GestureMessage, now: f64) -> Vec<Command> {
        let finger = finger_slot(&message.finger);
        if let Some(slot) = finger
            && !message.synthetic
        {
            if is_press(message) {
                self.pinched[slot] = true;
            } else if is_release(message) {
                self.pinched[slot] = false;
            }
        }
        let age = now - message.received_at;
        if !(-0.1..=0.35).contains(&age) {
            return Vec::new();
        }
        if let Some(slot) = finger
            && !message.synthetic
            && self.hold_cancelled[slot]
            && is_release(message)
        {
            self.hold_cancelled[slot] = false;
            self.hold_ended_at[slot] = Some(now);
        }
        if self.pointer.is_some()
            && let Some(slot) = finger
        {
            return self.pointer_gesture(message, slot, now);
        }
        if let Some(slot) = finger
            && !message.synthetic
        {
            if !self.config.gestures.pinches[slot].hold_start.is_empty() {
                if let Some(commands) = self.hold_edge_report(slot, message, now) {
                    return commands;
                }
            } else if slot == 0 && let Some(hold) = self.index_hold(message, now) {
                return hold;
            }
        }
        let Some(gesture) = self.router.gesture(message, now) else {
            return Vec::new();
        };
        // Just after the air mouse turned off, the band's own reports of the pinches that did it
        // still come (that finger's tap, its double tap): neither turns it on again nor runs the
        // single tap's action (an Esc on the middle tap fired every time it was turned off).
        if now - self.pointer_off_at < SWITCHED_OFF_QUIET {
            let finger = self.config.gestures.pointer_tap().map(Tap::finger);
            let switch_finger = matches!(gesture, Recognized::Tap(tap) if Some(tap.finger()) == finger ||
                finger_slot(tap.finger()).is_some_and(|slot| self.config.gestures.pinches[slot].triple == POINTER_TOGGLE));
            if switch_finger || self.config.gestures.command(gesture) == POINTER_TOGGLE {
                if self.held_tap.is_some_and(|held| Some(held.tap.finger()) == finger) {
                    self.held_tap = None;
                }
                return Vec::new();
            }
        }
        if let Some(mode) = &mut self.pointer {
            // A thumb gesture: the pointer holds still through its twitch, and it keeps its
            // action, unless it's the air mouse's own gesture, which turns it off.
            mode.steady(now + STEADY_AFTER_GESTURE);
            if self.config.gestures.command(gesture) == POINTER_TOGGLE {
                self.status.gestures += 1;
                return self.switch_off(now);
            }
        }
        if self.writing {
            if self.writing_assist
                && let Recognized::Swipe(direction) = gesture
            {
                if !self.writing_gate.allows(message.received_at, now, self.live, true) {
                    return Vec::new();
                }
                self.status.gestures += 1;
                self.status.last_gesture = Some(label(gesture).into());
                let op = match direction {
                    Swipe::Right => Op::Accept,
                    Swipe::Left => Op::Undo,
                    Swipe::Up => Op::Previous,
                    Swipe::Down => Op::Next,
                };
                return vec![Command::Write(op, message.timestamp_us)];
            }
            if gesture != Recognized::Tap(Tap::MiddleTap) {
                return Vec::new();
            }
            self.status.gestures += 1;
            self.status.last_gesture = Some(label(gesture).into());
            let command = self.config.gestures.writing_exit.as_deref()
                .unwrap_or_else(|| self.config.gestures.command(gesture)).to_owned();
            if command.is_empty() || !self.writing_gate.allows(message.received_at, now, self.live, true) {
                return Vec::new();
            }
            self.status.last_action = Some(command.clone());
            return vec![Command::Run(command)];
        }
        // Releasing a wrist turn, or an index hold, must not also trigger an index-finger
        // assignment.
        if let Recognized::Tap(tap) = gesture
            && tap.finger() == "index"
            && (now - self.last_dial_action <= 0.6 || now - self.dial_ended_at <= 0.7 || now - self.index_hold_at <= 0.7)
        {
            return Vec::new();
        }
        // A hold has no double to wait for.
        if gesture == Recognized::Tap(Tap::MiddleHold) {
            return self.run(gesture, message.received_at, now, false);
        }
        if let Recognized::Tap(tap) = gesture
            && self.config.band.toggle != ToggleGesture::None
            && triple_of(tap) == self.config.band.toggle
        {
            if double_of(tap).is_some() {
                if self
                    .toggle_taps
                    .last()
                    .is_some_and(|&last| now - last > TRIPLE_TAP_GAP)
                {
                    self.toggle_taps.clear();
                }
                self.toggle_taps.push(now);
                if self.toggle_taps.len() >= 3 {
                    self.toggle_taps.clear();
                    self.held_tap = None;
                    self.toggled_at = now;
                    return self.toggle_by_tap(now);
                }
            } else if now - self.toggled_at < 0.15 {
                // The third tap's own double tap: part of the triple.
                return Vec::new();
            } else {
                // This finger's double tap may be the start of a triple tap.
                self.held_tap = Some(HeldTap {
                    tap,
                    fire_at: now + TRIPLE_TAP_GAP,
                    received_at: message.received_at,
                });
                return Vec::new();
            }
        }
        if let Recognized::Tap(tap) = gesture {
            let slot = usize::from(tap.finger() == "middle");
            if !self.config.gestures.pinches[slot].triple.is_empty() {
                return self.triple_tap(slot, tap, message.received_at, now);
            }
            // A double tap supersedes the single tap(s) it was made of.
            if self
                .held_tap
                .is_some_and(|held| double_of(held.tap) == Some(tap))
            {
                self.held_tap = None;
            }
            // A single tap whose double has an action waits to see whether it
            // is the first half of that double tap.
            if let Some(double) = double_of(tap)
                && !self
                    .config
                    .gestures
                    .command(Recognized::Tap(tap))
                    .is_empty()
                && !self
                    .config
                    .gestures
                    .command(Recognized::Tap(double))
                    .is_empty()
            {
                match &mut self.held_tap {
                    // The double's second tap: its double tap comes right with it.
                    Some(held) if held.tap == tap => held.fire_at = held.fire_at.max(now + 0.08),
                    _ => {
                        self.held_tap = Some(HeldTap {
                            tap,
                            fire_at: now + DOUBLE_TAP_WAIT,
                            received_at: message.received_at,
                        })
                    }
                }
                return Vec::new();
            }
        }
        self.run(gesture, message.received_at, now, false)
    }

    fn triple_tap(&mut self, slot: usize, tap: Tap, received_at: f64, now: f64) -> Vec<Command> {
        if !self.live || !self.enabled {
            return Vec::new();
        }
        let sequence = &mut self.triple_taps[slot];
        if double_of(tap).is_some() {
            sequence.count = if sequence.last_tap.is_some_and(|last| now - last <= TRIPLE_TAP_GAP) {
                sequence.count + 1
            } else {
                1
            };
            sequence.last_tap = Some(now);
            if sequence.count == 3 {
                sequence.count = 0;
                sequence.pending = None;
                sequence.fired_at = Some(now);
                let label = if slot == 0 { "index triple tap" } else { "middle triple tap" };
                let action = self.config.gestures.pinches[slot].triple.clone();
                if !self.gate.allows(received_at, now, self.live, true) {
                    return Vec::new();
                }
                self.status.gestures += 1;
                self.status.last_gesture = Some(label.into());
                self.status.last_action = Some(action.clone());
                return vec![Command::Run(action)];
            }
            if let Some(pending) = sequence.pending.as_mut() {
                pending.fire_at = now + TRIPLE_TAP_GAP;
                return Vec::new();
            }
        } else if sequence.fired_at.is_some_and(|fired| now - fired < 0.15) {
            // The band's double immediately after the third tap belongs to the triple.
            return Vec::new();
        }
        sequence.pending = Some(HeldTap { tap, fire_at: now + TRIPLE_TAP_GAP, received_at });
        Vec::new()
    }

    /// The firmware reports contact separately from the derived tap. Only an actual
    /// release report completes a mapped hold. A watchdog or mode switch cancels it.
    fn hold_edge_report(&mut self, slot: usize, message: &GestureMessage, now: f64) -> Option<Vec<Command>> {
        if self.writing || !self.live || !self.enabled {
            return None;
        }
        if is_press(message) {
            self.hold_ended_at[slot] = None;
            self.hold_cancelled[slot] = false;
            self.holds[slot].get_or_insert(HoldContact {
                pressed_at: message.received_at,
                started: false,
                dial_won: false,
            });
            return Some(Vec::new());
        }
        if is_release(message) {
            if self.holds[slot].take().is_some_and(|hold| hold.started) {
                self.hold_ended_at[slot] = Some(now);
                let action = &self.config.gestures.pinches[slot].hold_release;
                return Some(Self::edge_command(action));
            }
            return Some(Vec::new());
        }
        let ended_recently = self.hold_ended_at[slot].is_some_and(|ended| now - ended < HOLD_REPORT_GAP);
        if message.action.eq_ignore_ascii_case("hold") || message.derived_action == "buttonHold" {
            if slot == 0 || ended_recently || self.hold_cancelled[slot] {
                return Some(Vec::new());
            }
            // The native middle hold report also covers a missed middle press.
            self.holds[slot].get_or_insert(HoldContact {
                pressed_at: message.received_at,
                started: false,
                dial_won: false,
            });
            return Some(self.start_hold(slot));
        }
        if ended_recently || self.hold_cancelled[slot] || self.holds[slot].is_some_and(|hold| hold.started) {
            return Some(Vec::new());
        }
        None
    }

    fn edge_command(action: &str) -> Vec<Command> {
        if action.is_empty() { Vec::new() } else { vec![Command::Run(action.into())] }
    }

    fn start_hold(&mut self, slot: usize) -> Vec<Command> {
        let Some(hold) = &mut self.holds[slot] else { return Vec::new() };
        if hold.started || hold.dial_won {
            return Vec::new();
        }
        hold.started = true;
        let finger = if slot == 0 { "index" } else { "middle" };
        if self.held_tap.is_some_and(|held| held.tap.finger() == finger) {
            self.held_tap = None;
        }
        self.triple_taps[slot] = TripleTap::default();
        self.status.gestures += 1;
        self.status.last_gesture = Some(format!("{finger} hold"));
        let action = &self.config.gestures.pinches[slot].hold_start;
        self.status.last_action = Some(action.clone());
        Self::edge_command(action)
    }

    fn cancel_holds(&mut self) {
        for (slot, hold) in self.holds.iter_mut().enumerate() {
            if let Some(hold) = hold.take() {
                self.hold_cancelled[slot] = true;
                if hold.started {
                    self.hold_cancellations.extend(Self::edge_command(&self.config.gestures.pinches[slot].hold_cancel));
                }
            }
        }
    }

    pub fn fire_hold_edges(&mut self, now: f64) -> Vec<Command> {
        let mut commands = std::mem::take(&mut self.hold_cancellations);
        for slot in 0..self.holds.len() {
            let Some(hold) = self.holds[slot] else { continue };
            let age = now - hold.pressed_at;
            if age >= MAX_HOLD {
                self.holds[slot] = None;
                self.hold_cancelled[slot] = true;
                if hold.started {
                    self.hold_ended_at[slot] = Some(now);
                    commands.extend(Self::edge_command(&self.config.gestures.pinches[slot].hold_cancel));
                }
            } else if age >= INDEX_HOLD {
                commands.extend(self.start_hold(slot));
            }
        }
        commands
    }

    /// The gesture's action, if the controls are on, or the pause, which works while they're off
    /// ([PAUSE_TOGGLE]). [held] is a single tap that waited for its double.
    fn run(&mut self, gesture: Recognized, received_at: f64, now: f64, held: bool) -> Vec<Command> {
        self.status.gestures += 1;
        self.status.last_gesture = Some(label(gesture).into());
        let command = self.config.gestures.command(gesture).to_owned();
        if command == PAUSE_TOGGLE {
            // One toggle per hold, however often the band repeats it.
            if now - self.toggled_at < 1.0 {
                return Vec::new();
            }
            self.toggled_at = now;
            return self.toggle_by_tap(now);
        }
        let allowed = if held {
            self.gate.allows_held(received_at, true, now, self.live)
        } else {
            self.gate.allows(received_at, now, self.live, true)
        };
        if !self.enabled || command.is_empty() || !allowed {
            return Vec::new();
        }
        self.status.last_action = Some(command.clone());
        vec![Command::Run(command)]
    }

    /// Follows the index pinch for the index hold: held at least [INDEX_HOLD] and let go
    /// without turning the wrist (pinch and turn starts the same way, so it's decided at the
    /// release). Some when this report ran it.
    fn index_hold(&mut self, message: &GestureMessage, now: f64) -> Option<Vec<Command>> {
        if self.writing {
            self.index_pressed_at = None;
            return None;
        }
        if is_press(message) {
            if self.index_pressed_at.is_none() {
                self.index_pressed_at = Some(message.received_at);
                self.index_turn = 0.0;
            }
            return None;
        }
        if !is_release(message) {
            return None;
        }
        let pressed_at = self.index_pressed_at.take()?;
        if message.received_at - pressed_at < INDEX_HOLD
            || self.index_turn.abs() >= INDEX_HOLD_TURN
            || self.last_dial_action >= pressed_at
        {
            return None;
        }
        self.index_hold_at = now;
        self.held_tap = None;
        Some(self.run(Recognized::Tap(Tap::IndexHold), message.received_at, now, false))
    }

    fn toggle_by_tap(&mut self, now: f64) -> Vec<Command> {
        if !self.live {
            return Vec::new();
        }
        self.toggle(now);
        let command = &self.config.band.on_toggle;
        if command.is_empty() {
            return Vec::new();
        }
        vec![Command::Run(command.clone())]
    }

    /// When a tap held for another pinch is due (see `fire_held_tap`).
    pub fn held_tap_due(&self) -> Option<f64> {
        std::iter::once(self.held_tap)
            .chain(self.triple_taps.iter().map(|sequence| sequence.pending))
            .flatten()
            .map(|held| held.fire_at)
            .min_by(f64::total_cmp)
    }

    /// Run due taps whose successor never came.
    pub fn fire_held_tap(&mut self, now: f64) -> Vec<Command> {
        let mut due = Vec::new();
        for pending in std::iter::once(&mut self.held_tap)
            .chain(self.triple_taps.iter_mut().map(|sequence| &mut sequence.pending))
        {
            if pending.is_some_and(|held| now >= held.fire_at) {
                due.extend(pending.take());
            }
        }
        due.sort_by(|a, b| a.fire_at.total_cmp(&b.fire_at));
        let mut commands = Vec::new();
        for held in due {
            commands.extend(self.run(Recognized::Tap(held.tap), held.received_at, now, true));
        }
        commands
    }

    fn dial_state(&mut self, engaged: bool, now: f64) {
        if !self.live {
            self.reset_dial();
            return;
        }
        // A pinch that turned has just ended: its release is not a tap.
        if !engaged && self.dial_turned {
            self.dial_ended_at = now;
        }
        self.dial_turned = false;
        self.dial_engaged = engaged;
        self.reset_dial();
        if engaged && self.enabled {
            self.dial_armed = true;
            self.dial_gate.arm(now);
        }
    }

    fn dial_turn(&mut self, rotation: f64, now: f64) -> Vec<Command> {
        if !self.live || !self.hand_confirmed || !self.dial_engaged || !rotation.is_finite() {
            return Vec::new();
        }
        // The same intended turn produces the opposite gyro sign on the left wrist.
        let delta = if self.hand == Some(Hand::Left) {
            -rotation
        } else {
            rotation
        };
        self.dial_turned = true;
        if self.index_pressed_at.is_some() {
            self.index_turn += delta;
        }
        if !self.enabled
            || !self.dial_armed
            || self.dial_target == DialTarget::Off
            || self.holds[0].is_some_and(|hold| hold.started)
        {
            return Vec::new();
        }
        if !self.dial_gate.allows(now, now, self.live, true) {
            return Vec::new();
        }
        let steps = self
            .dial_router
            .turn(delta, self.config.dial.sensitivity, now);
        if steps == 0 {
            return Vec::new();
        }
        if let Some(hold) = &mut self.holds[0] {
            hold.dial_won = true;
        }
        self.last_dial_action = now;
        match self.config.dial.command(self.dial_target, steps > 0) {
            Some(command) => {
                self.status.last_gesture = Some(
                    if steps > 0 {
                        "wrist turn +"
                    } else {
                        "wrist turn \u{2212}"
                    }
                    .into(),
                );
                self.status.last_action = Some(command.to_owned());
                vec![Command::Run(command.to_owned())]
            }
            None => Vec::new(),
        }
    }

    fn desired_hand(&self) -> Option<Hand> {
        if let Some(hand) = self.hand_override {
            return Some(hand);
        }
        match self.config.band.hand {
            HandSetting::Band => None,
            HandSetting::Left => Some(Hand::Left),
            HandSetting::Right => Some(Hand::Right),
        }
    }

    fn maybe_request_hand(&mut self) -> Vec<Command> {
        match (self.desired_hand(), self.hand) {
            (Some(wanted), Some(current))
                if self.live
                    && self.hand_confirmed
                    && wanted != current
                    && !self.hand_requested =>
            {
                self.hand_requested = true;
                vec![Command::SetHand(wanted)]
            }
            _ => Vec::new(),
        }
    }

    fn reset_dial(&mut self) {
        self.dial_armed = false;
        self.dial_gate.pause();
        self.dial_router.reset();
    }

    fn suspend(&mut self) {
        self.gate.pause();
        self.reset_dial();
        self.dial_engaged = false;
    }
}

#[cfg(test)]
mod pointer_tests {
    use super::*;
    use band_core::events::GestureMessage;

    struct Rig {
        controller: Controller,
        sequence: u64,
        stamp: u64,
    }

    impl Rig {
        /// A live, right-handed band with `mapping`, the air mouse on at t = 1.
        fn new(mapping: &str) -> Self {
            let mut config = Config::default();
            config.apply_mapping(mapping);
            let mut controller = Controller::new(config);
            controller.on_event(&Event::Connected, 0.0);
            controller.on_event(&Event::Handedness(Hand::Right), 0.0);
            let mut rig = Self { controller, sequence: 0, stamp: 0 };
            assert!(rig.controller.set_pointer(true, PointerTuning::default(), 1.0).is_empty());
            rig
        }

        fn gesture(&mut self, finger: &str, action: &str, now: f64) -> Vec<Command> {
            self.report(finger, action, "unknown", now)
        }

        fn report(&mut self, finger: &str, action: &str, derived: &str, now: f64) -> Vec<Command> {
            self.sequence += 1;
            let message = GestureMessage {
                sequence: self.sequence,
                timestamp_us: self.sequence,
                finger: finger.into(),
                action: action.into(),
                derived_action: derived.into(),
                synthetic: false,
                received_at: now,
            };
            self.controller.on_event(&Event::Gesture(message), now)
        }

        /// Orientation and gyro samples at 128 Hz, the forearm turning from `from` to `to`
        /// degrees left over `seconds`, on time.
        fn turn(&mut self, from: f64, to: f64, start: f64, seconds: f64) -> f64 {
            let steps = (seconds * 128.0) as usize;
            let mut now = start;
            for step in 0..=steps {
                now = start + step as f64 / 128.0;
                self.stamp = (now * 1e6) as u64;
                let azimuth = from + (to - from) * step as f64 / steps.max(1) as f64;
                let rate = if steps == 0 { 0.0 } else { (to - from).abs() / seconds };
                let raw = [(rate / band_core::pointer::GYRO_SCALE) as i16, 0, 0];
                self.controller.on_event(&Event::Gyro { timestamp_us: self.stamp, raw }, now);
                let q = quaternion(azimuth).map(|v| v as f32);
                self.controller.on_event(&Event::Orientation { timestamp_us: self.stamp, quaternion: q }, now);
            }
            now
        }

        fn records(&mut self, now: f64) -> Vec<[f64; 4]> {
            self.controller.take_pointer(now).chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
        }

        fn buttons(&mut self, now: f64) -> Vec<f64> {
            self.records(now).into_iter().filter(|r| r[0] == RECORD_BUTTONS).map(|r| r[2]).collect()
        }
    }

    /// The forearm level, turned `azimuth` degrees left of the band's resting heading.
    fn quaternion(azimuth: f64) -> [f64; 4] {
        let half = azimuth.to_radians() / 2.0;
        [half.cos(), 0.0, 0.0, half.sin()]
    }

    fn run(commands: &[Command]) -> Vec<String> {
        commands
            .iter()
            .filter_map(|c| match c {
                Command::Run(action) => Some(action.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn pinches_are_the_buttons_one_at_a_time() {
        let mut rig = Rig::new("swipe_left=pc.pointer;index_tap=pc.key.enter");
        rig.turn(90.0, 90.0, 1.0, 0.2);
        assert!(rig.gesture("index", "press", 1.3).is_empty());
        assert_eq!(rig.buttons(1.3), vec![1.0]);
        // The band's tap report for the same pinch runs nothing.
        assert!(rig.gesture("index", "tap", 1.31).is_empty());
        assert!(rig.gesture("middle", "press", 1.4).is_empty());
        assert_eq!(rig.buttons(1.4), vec![0.0, 2.0]);
        rig.gesture("index", "release", 1.5);
        assert!(rig.buttons(1.5).is_empty(), "the index no longer holds the button");
        rig.gesture("middle", "release", 1.6);
        assert_eq!(rig.buttons(1.6), vec![0.0]);
        // A second press report for the same pinch is ignored.
        rig.gesture("index", "press", 1.7);
        rig.gesture("index", "press", 1.71);
        assert_eq!(rig.buttons(1.71), vec![1.0]);
    }

    #[test]
    fn swipes_keep_their_actions_and_the_dial_rests() {
        let mut rig = Rig::new("swipe_left=pc.pointer;swipe_up=pc.scroll.up;index_double=dial.toggle");
        assert_eq!(run(&rig.gesture("thumb", "up", 1.2)), vec!["pc.scroll.up"]);
        assert!(rig.controller.on_event(&Event::DialState(true), 1.3).is_empty());
        assert!(rig.controller.on_event(&Event::DialTurn(5.0), 1.31).is_empty());
        // The swipe mapped to the air mouse turns it off.
        assert_eq!(run(&rig.gesture("thumb", "left", 1.4)), vec![POINTER_OFF]);
        assert!(!rig.controller.pointer_on());
    }

    #[test]
    fn a_tap_bound_switch_turns_off_on_a_quick_pinch_and_drags_on_a_held_one() {
        let mut rig = Rig::new("index_tap=pc.pointer");
        assert!(rig.gesture("index", "press", 1.2).is_empty());
        assert_eq!(rig.controller.pointer_due(), Some(1.2 + SWITCH_HOLD_LIMIT));
        assert_eq!(run(&rig.gesture("index", "release", 1.3)), vec![POINTER_OFF]);
        assert!(!rig.controller.pointer_on());

        let mut rig = Rig::new("index_tap=pc.pointer");
        rig.gesture("index", "press", 1.2);
        assert!(rig.buttons(1.3).is_empty());
        rig.controller.fire_pointer_wait(1.56);
        assert_eq!(rig.buttons(1.56), vec![1.0]);
        rig.gesture("index", "release", 2.0);
        assert_eq!(rig.buttons(2.0), vec![0.0]);
        assert!(rig.controller.pointer_on());
    }

    #[test]
    fn a_double_tap_bound_switch_clicks_a_lone_pinch_and_turns_off_on_two() {
        let mut rig = Rig::new("middle_double=pc.pointer");
        rig.gesture("middle", "press", 1.2);
        rig.gesture("middle", "release", 1.3);
        assert!(rig.buttons(1.3).is_empty(), "waits for a second pinch");
        rig.controller.fire_pointer_wait(1.61);
        assert_eq!(rig.buttons(1.61), vec![2.0, 0.0]);

        let mut rig = Rig::new("middle_double=pc.pointer");
        rig.gesture("middle", "press", 1.2);
        rig.gesture("middle", "release", 1.3);
        assert_eq!(run(&rig.gesture("middle", "press", 1.45)), vec![POINTER_OFF]);
        assert!(rig.gesture("middle", "release", 1.5).is_empty());
        assert!(!rig.controller.pointer_on());
        // The other finger never waits.
        let mut rig = Rig::new("middle_double=pc.pointer");
        rig.gesture("index", "press", 1.2);
        assert_eq!(rig.buttons(1.2), vec![1.0]);
    }

    #[test]
    fn the_bands_double_tap_report_turns_it_off_and_doesnt_turn_it_on_again() {
        let mut rig = Rig::new("middle_double=pc.pointer");
        rig.gesture("middle", "press", 1.2);
        rig.gesture("middle", "release", 1.3);
        // The second pinch arrives only as the band's double tap report.
        assert_eq!(run(&rig.gesture("middle", "doubletap", 1.45)), vec![POINTER_OFF]);
        assert!(!rig.controller.pointer_on());
        assert!(rig.controller.fire_pointer_wait(2.0).is_empty());
        // The same report again (or its derived twin) right after: nothing.
        assert!(run(&rig.gesture("middle", "doubletap", 1.5)).is_empty());
        // Later, the gesture asks to turn it on again, as before.
        assert_eq!(run(&rig.gesture("middle", "doubletap", 3.0)), vec!["pc.pointer"]);
    }

    #[test]
    fn a_pointer_triple_preserves_single_click_and_double_tap_without_leaking_clicks() {
        let mut rig = Rig::new("index_double=double-click;index_triple=pc.pointer");
        rig.gesture("index", "press", 1.2);
        rig.gesture("index", "release", 1.3);
        assert!(rig.buttons(1.3).is_empty());
        assert!(run(&rig.controller.fire_pointer_wait(1.8)).is_empty());
        assert_eq!(rig.buttons(1.8), vec![1.0, 0.0]);

        for at in [2.0, 2.2] {
            assert!(run(&rig.gesture("index", "press", at)).is_empty());
            assert!(run(&rig.gesture("index", "release", at + 0.1)).is_empty());
        }
        rig.gesture("index", "doubletap", 2.32);
        assert_eq!(run(&rig.controller.fire_pointer_wait(2.8)), vec!["double-click"]);
        assert!(rig.controller.pointer_on());
        assert!(rig.buttons(2.8).is_empty());

        for at in [3.0, 3.2] {
            rig.gesture("index", "press", at);
            rig.gesture("index", "release", at + 0.1);
        }
        rig.gesture("index", "doubletap", 3.32);
        rig.gesture("index", "press", 3.4);
        assert_eq!(run(&rig.gesture("index", "release", 3.5)), vec![POINTER_OFF]);
        assert!(!rig.controller.pointer_on());
        assert!(run(&rig.gesture("index", "doubletap", 3.51)).is_empty());
        assert!(run(&rig.controller.fire_held_tap(4.2)).is_empty());
        assert!(rig.buttons(4.2).is_empty());
    }

    #[test]
    fn a_double_screen_toggle_uses_the_bands_own_double_report_in_pointer_mode() {
        let mut rig = Rig::new("index_triple=pc.pointer;middle_double=screen-toggle");
        rig.gesture("middle", "press", 1.2);
        rig.gesture("middle", "release", 1.3);
        assert_eq!(run(&rig.gesture("middle", "doubletap", 1.45)), vec!["screen-toggle"]);
        assert!(rig.buttons(1.45).is_empty());
    }

    #[test]
    fn handwriting_uses_its_explicit_exit_instead_of_the_normal_middle_action() {
        let mut rig = Rig::new("middle_tap=pc.key.enter;writing_exit=back");
        rig.controller.set_writing(true, 1.2);
        assert_eq!(run(&rig.gesture("middle", "tap", 1.6)), vec!["back"]);
    }

    #[test]
    fn turning_it_off_with_a_double_tap_doesnt_run_the_single_taps_action() {
        // As the band reports a double tap: each pinch press, release and its single tap report,
        // then the double tap report.
        let mut rig = Rig::new("middle_tap=pc.key.escape;middle_double=pc.pointer");
        rig.gesture("middle", "press", 1.2);
        rig.gesture("middle", "release", 1.3);
        rig.report("middle", "unknown", "singleTap", 1.31);
        assert_eq!(run(&rig.gesture("middle", "press", 1.4)), vec![POINTER_OFF]);
        let mut after = Vec::new();
        after.extend(rig.gesture("middle", "release", 1.5));
        after.extend(rig.report("middle", "unknown", "singleTap", 1.51));
        after.extend(rig.report("middle", "unknown", "doubleTap", 1.52));
        after.extend(rig.controller.fire_held_tap(2.0));
        assert!(run(&after).is_empty(), "{after:?}");
        // Later, the middle tap is the Esc again.
        rig.report("middle", "unknown", "singleTap", 3.0);
        assert_eq!(run(&rig.controller.fire_held_tap(3.5)), vec!["pc.key.escape"]);
    }

    #[test]
    fn a_pinch_held_when_it_started_lets_go_of_nothing() {
        let mut config = Config::default();
        config.apply_mapping("swipe_left=pc.pointer");
        let mut controller = Controller::new(config);
        controller.on_event(&Event::Connected, 0.0);
        let press = GestureMessage {
            sequence: 1,
            timestamp_us: 1,
            finger: "index".into(),
            action: "press".into(),
            derived_action: "unknown".into(),
            synthetic: false,
            received_at: 0.5,
        };
        controller.on_event(&Event::Gesture(press.clone()), 0.5);
        controller.set_pointer(true, PointerTuning::default(), 1.0);
        let release = GestureMessage { sequence: 2, action: "release".into(), received_at: 1.2, ..press };
        controller.on_event(&Event::Gesture(release), 1.2);
        assert!(controller.take_pointer(1.2).chunks(4).all(|r| r[0] != RECORD_BUTTONS));
    }

    #[test]
    fn a_mapping_without_it_or_a_pause_turns_it_off() {
        let mut rig = Rig::new("swipe_left=pc.pointer");
        let mut config = Config::default();
        config.apply_mapping("swipe_left=pc.key.left");
        assert_eq!(run(&rig.controller.set_config(config)), vec![POINTER_OFF]);
        assert!(!rig.controller.pointer_on());
        let mut rig = Rig::new("swipe_left=pc.pointer");
        rig.controller.pause();
        assert!(!rig.controller.pointer_on());
        // It can't start while the band writes.
        let mut rig = Rig::new("swipe_left=pc.pointer");
        rig.controller.set_writing(true, 1.5);
        assert!(!rig.controller.pointer_on());
        assert_eq!(run(&rig.controller.set_pointer(true, PointerTuning::default(), 2.0)), vec![POINTER_OFF]);
    }

    #[test]
    fn turning_the_forearm_moves_the_pointer_after_the_first_moment() {
        let mut rig = Rig::new("swipe_left=pc.pointer");
        let now = rig.turn(90.0, 90.0, 1.0, 0.3);
        // The first take anchors: what moved before is dropped.
        assert!(rig.records(now).iter().all(|r| r[0] != RECORD_MOVE));
        // Turning right (the compass angle falling) moves the pointer right.
        let now = rig.turn(90.0, 80.0, now + 1.0 / 128.0, 0.5);
        let moves: Vec<[f64; 4]> = rig.records(now).into_iter().filter(|r| r[0] == RECORD_MOVE).collect();
        let right: f64 = moves.iter().map(|r| r[2]).sum();
        let down: f64 = moves.iter().map(|r| r[3]).sum();
        assert!(right > 3.0 && down.abs() < right * 0.2, "right {right}, down {down}");
        // A thumb gesture holds it still for a moment.
        rig.gesture("thumb", "up", now);
        let then = rig.turn(80.0, 75.0, now + 1.0 / 128.0, 0.05);
        assert!(rig.records(then).iter().all(|r| r[0] != RECORD_MOVE));
        // Stale data stops it.
        assert_eq!(rig.records(then + 1.0).first().map(|r| r[0]), Some(RECORD_CLEAR));
    }

    #[test]
    fn a_late_link_lets_go_of_the_button_and_ignores_presses() {
        let mut rig = Rig::new("swipe_left=pc.pointer");
        let now = rig.turn(90.0, 90.0, 1.0, 0.2);
        rig.gesture("index", "press", now);
        assert_eq!(rig.buttons(now), vec![1.0]);
        // The band's clock falls behind: samples arrive later and later.
        let mut host = now;
        for step in 1..=200 {
            host = now + step as f64 * 0.01;
            let band = ((now + step as f64 * 0.005) * 1e6) as u64;
            rig.controller.on_event(&Event::Gyro { timestamp_us: band, raw: [0, 0, 0] }, host);
        }
        assert_eq!(rig.buttons(host), vec![0.0]);
        rig.gesture("middle", "press", host);
        assert!(rig.buttons(host).is_empty());
    }

    #[test]
    fn tuning_reads_its_pairs_and_keeps_its_limits() {
        assert_eq!(PointerTuning::parse(""), PointerTuning::default());
        let tuning = PointerTuning::parse("steadiness=0.8;boost=9;other=1");
        assert_eq!(tuning, PointerTuning { steadiness: 0.8, boost: 2.5 });
        assert_eq!(PointerTuning::parse("steadiness=nan").steadiness, 0.5);
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;
    use band_core::events::GestureMessage;

    struct Rig {
        controller: Controller,
        sequence: u64,
    }

    impl Rig {
        /// A live, right-handed band with `mapping`.
        fn new(mapping: &str) -> Self {
            let mut config = Config::default();
            config.apply_mapping(mapping);
            let mut controller = Controller::new(config);
            controller.on_event(&Event::Connected, 0.0);
            controller.on_event(&Event::Handedness(Hand::Right), 0.0);
            Self { controller, sequence: 0 }
        }

        fn report(&mut self, finger: &str, action: &str, derived: &str, now: f64) -> Vec<Command> {
            self.sequence += 1;
            let message = GestureMessage {
                sequence: self.sequence,
                timestamp_us: self.sequence,
                finger: finger.into(),
                action: action.into(),
                derived_action: derived.into(),
                synthetic: false,
                received_at: now,
            };
            self.controller.on_event(&Event::Gesture(message), now)
        }

        /// An index pinch from `start` to `end`, reported as the band does (raw, then derived).
        fn pinch(&mut self, start: f64, end: f64) -> Vec<Command> {
            let mut out = self.report("index", "press", "unknown", start);
            out.extend(self.report("index", "unknown", "buttonPress", start));
            out.extend(self.report("index", "release", "unknown", end));
            out.extend(self.report("index", "unknown", "buttonRelease", end));
            out
        }
    }

    fn runs(commands: Vec<Command>) -> Vec<String> {
        commands
            .into_iter()
            .filter_map(|command| match command {
                Command::Run(action) => Some(action),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn mapped_hold_starts_before_release_and_consumes_each_real_release_once() {
        let mut rig = Rig::new(
            "index_hold_start=voice.start;index_hold_release=voice.end;middle_hold_start=menu.start;middle_hold_release=menu.end",
        );
        assert!(rig.report("index", "press", "unknown", 1.0).is_empty());
        assert!(rig.report("index", "unknown", "buttonPress", 1.1).is_empty());
        assert!(rig.controller.fire_hold_edges(1.5).is_empty());
        assert_eq!(runs(rig.controller.fire_hold_edges(1.61)), vec!["voice.start"]);
        assert!(rig.controller.fire_hold_edges(1.65).is_empty());
        assert_eq!(runs(rig.report("index", "release", "unknown", 1.8)), vec!["voice.end"]);
        assert!(rig.report("index", "unknown", "buttonHoldRelease", 1.81).is_empty());
        assert!(rig.report("index", "unknown", "singleTap", 1.82).is_empty());

        assert!(rig.report("middle", "press", "unknown", 3.0).is_empty());
        assert_eq!(runs(rig.report("middle", "unknown", "buttonHold", 3.5)), vec!["menu.start"]);
        assert!(rig.report("middle", "unknown", "buttonHold", 3.51).is_empty());
        assert_eq!(runs(rig.report("middle", "unknown", "buttonHoldRelease", 3.6)), vec!["menu.end"]);
        assert!(rig.report("middle", "release", "unknown", 3.61).is_empty());
        assert!(rig.report("middle", "unknown", "singleTap", 3.62).is_empty());
    }

    #[test]
    fn mapped_hold_cancels_on_a_missing_release_without_finalizing() {
        let mut rig = Rig::new("index_hold_start=voice.start;index_hold_release=voice.end;index_hold_cancel=voice.cancel");
        rig.report("index", "press", "unknown", 1.0);
        assert_eq!(runs(rig.controller.fire_hold_edges(1.65)), vec!["voice.start"]);
        assert_eq!(runs(rig.controller.fire_hold_edges(100.0)), vec!["voice.cancel"]);
        assert!(rig.report("index", "release", "unknown", 100.1).is_empty());
    }

    #[test]
    fn repeated_native_hold_reports_cannot_restart_a_cancelled_contact() {
        let mut rig = Rig::new("middle_hold_start=start;middle_hold_release=end;middle_hold_cancel=cancel");
        assert_eq!(runs(rig.report("middle", "unknown", "buttonHold", 1.0)), vec!["start"]);
        assert_eq!(runs(rig.controller.fire_hold_edges(62.0)), vec!["cancel"]);
        assert!(rig.report("middle", "unknown", "buttonHold", 62.3).is_empty());
        assert!(rig.report("middle", "unknown", "buttonHoldRelease", 62.5).is_empty());
        assert!(rig.report("middle", "unknown", "singleTap", 62.52).is_empty());
        assert_eq!(runs(rig.report("middle", "unknown", "buttonHold", 64.0)), vec!["start"]);
    }

    #[test]
    fn only_a_physical_release_completes_a_hold_and_mode_changes_cancel_it() {
        let mut rig = Rig::new("index_hold_start=start;index_hold_release=end;index_hold_cancel=cancel");
        rig.report("index", "press", "unknown", 1.0);
        assert_eq!(runs(rig.controller.fire_hold_edges(1.61)), vec!["start"]);
        let synthesized = Event::Gesture(GestureMessage {
            sequence: 2,
            timestamp_us: 2,
            finger: "index".into(),
            action: "release".into(),
            derived_action: "buttonRelease".into(),
            synthetic: true,
            received_at: 1.8,
        });
        assert!(rig.controller.on_event(&synthesized, 1.8).is_empty());
        assert_eq!(runs(rig.controller.set_pointer(true, PointerTuning::default(), 2.0)), Vec::<String>::new());
        assert_eq!(runs(rig.controller.fire_hold_edges(2.0)), vec!["cancel"]);
        assert!(rig.controller.set_config(rig.controller.config.clone()).is_empty());
        assert!(rig.controller.pointer_on(), "an explicitly enabled pointer survives the same mapping");
        assert!(rig.report("index", "release", "unknown", 2.2).is_empty());
    }

    #[test]
    fn a_dial_mapped_in_only_one_direction_still_works() {
        let mut rig = Rig::new("dial_up=;dial_down=down");
        rig.report("index", "press", "unknown", 1.0);
        rig.controller.on_event(&Event::DialState(true), 1.2);
        assert_eq!(runs(rig.controller.on_event(&Event::DialTurn(-4.0), 1.3)), vec!["down"]);
    }

    #[test]
    fn changing_dial_sensitivity_applies_to_the_next_pinch_on_the_live_controller() {
        let mut rig = Rig::new("dial_up=up;dial_down=down;dial_sensitivity=0.5");
        rig.report("index", "press", "unknown", 1.0);
        rig.controller.on_event(&Event::DialState(true), 1.2);
        assert!(runs(rig.controller.on_event(&Event::DialTurn(2.0), 1.3)).is_empty());
        assert_eq!(runs(rig.controller.on_event(&Event::DialTurn(2.0), 1.4)), vec!["up"]);
        rig.controller.on_event(&Event::DialState(false), 1.5);
        rig.report("index", "release", "unknown", 1.6);

        let mut config = Config::default();
        config.apply_mapping("dial_up=up;dial_down=down;dial_sensitivity=1.0");
        rig.controller.set_config(config);
        rig.report("index", "press", "unknown", 2.0);
        rig.controller.on_event(&Event::DialState(true), 2.2);
        assert_eq!(runs(rig.controller.on_event(&Event::DialTurn(2.0), 2.3)), vec!["up"]);
    }

    #[test]
    fn the_dial_and_the_hold_own_the_index_pinch_exclusively() {
        let mut rig = Rig::new("index_hold_start=voice.start;index_hold_release=voice.end;dial_up=up;dial_down=down");
        rig.report("index", "press", "unknown", 1.0);
        rig.controller.on_event(&Event::DialState(true), 1.2);
        assert_eq!(runs(rig.controller.on_event(&Event::DialTurn(4.0), 1.3)), vec!["up"]);
        assert!(rig.controller.fire_hold_edges(1.7).is_empty());
        assert!(rig.report("index", "release", "unknown", 1.8).is_empty());
        rig.controller.on_event(&Event::DialState(false), 1.8);

        rig.report("index", "press", "unknown", 3.0);
        rig.controller.on_event(&Event::DialState(true), 3.2);
        assert_eq!(runs(rig.controller.fire_hold_edges(3.65)), vec!["voice.start"]);
        assert!(rig.controller.on_event(&Event::DialTurn(-4.0), 3.7).is_empty());
        assert_eq!(runs(rig.report("index", "release", "unknown", 3.8)), vec!["voice.end"]);
    }

    #[test]
    fn mapped_triples_supersede_single_and_double_for_each_finger() {
        let mut rig = Rig::new("index_tap=i1;index_double=i2;index_triple=i3;middle_tap=m1;middle_double=m2;middle_triple=m3");
        for (finger, triple, start) in [("index", "i3", 1.0), ("middle", "m3", 3.0)] {
            assert!(rig.report(finger, "unknown", "singleTap", start).is_empty());
            assert!(rig.report(finger, "unknown", "singleTap", start + 0.27).is_empty());
            assert!(rig.report(finger, "unknown", "doubleTap", start + 0.28).is_empty());
            assert_eq!(runs(rig.report(finger, "unknown", "singleTap", start + 0.55)), vec![triple]);
            assert!(rig.report(finger, "unknown", "doubleTap", start + 0.56).is_empty());
            assert!(rig.controller.fire_held_tap(start + 1.1).is_empty());
        }
        assert!(rig.report("middle", "unknown", "singleTap", 6.0).is_empty());
        assert!(rig.report("middle", "unknown", "singleTap", 6.27).is_empty());
        assert!(rig.report("middle", "unknown", "doubleTap", 6.28).is_empty());
        assert_eq!(runs(rig.controller.fire_held_tap(6.74)), vec!["m2"]);
    }

    #[test]
    fn an_index_held_and_let_go_without_turning_is_the_index_hold() {
        let mut rig = Rig::new("index_hold=screen.home;index_tap=");
        assert_eq!(runs(rig.pinch(1.0, 1.8)), vec!["screen.home".to_owned()]);
        // A short pinch isn't one.
        assert!(runs(rig.pinch(3.0, 3.2)).is_empty());
        // Nor is it without an action.
        let mut rig = Rig::new("index_tap=");
        assert!(runs(rig.pinch(1.0, 1.8)).is_empty());
    }

    #[test]
    fn turning_while_it_is_held_is_pinch_and_turn_not_a_hold() {
        let mut rig = Rig::new("index_hold=screen.home;dial_up=volume.up;dial_down=volume.down");
        rig.report("index", "press", "unknown", 1.0);
        rig.controller.on_event(&Event::DialState(true), 1.2);
        rig.controller.on_event(&Event::DialTurn(4.0), 1.3);
        rig.controller.on_event(&Event::DialTurn(4.0), 1.45);
        rig.controller.on_event(&Event::DialState(false), 1.7);
        assert!(runs(rig.report("index", "release", "unknown", 1.8)).is_empty());
    }

    #[test]
    fn the_band_s_own_tap_after_the_hold_doesnt_run_the_index_tap() {
        let mut rig = Rig::new("index_hold=screen.home;index_tap=media.play_pause;index_double=");
        assert_eq!(runs(rig.pinch(1.0, 1.8)), vec!["screen.home".to_owned()]);
        assert!(runs(rig.report("index", "unknown", "singleTap", 1.85)).is_empty());
        // Later taps do.
        assert_eq!(runs(rig.report("index", "unknown", "singleTap", 3.0)), vec!["media.play_pause".to_owned()]);
    }

    #[test]
    fn the_middle_hold_pauses_by_default_and_runs_its_action_when_mapped() {
        let mut rig = Rig::new("");
        assert!(runs(rig.report("middle", "unknown", "buttonHold", 1.0)).is_empty());
        assert!(rig.controller.status().paused);
        // The band repeats the hold report: one toggle per hold.
        rig.report("middle", "unknown", "buttonHold", 1.3);
        assert!(rig.controller.status().paused);
        rig.report("middle", "unknown", "buttonHold", 3.0);
        assert!(!rig.controller.status().paused);
        let mut rig = Rig::new("middle_hold=screen.recents");
        assert_eq!(runs(rig.report("middle", "unknown", "buttonHold", 1.0)), vec!["screen.recents".to_owned()]);
        assert!(!rig.controller.status().paused);
    }

    #[test]
    fn an_index_hold_can_pause_and_resume() {
        let mut rig = Rig::new("index_hold=band.pause;middle_hold=;index_tap=");
        rig.pinch(1.0, 1.8);
        assert!(rig.controller.status().paused);
        rig.pinch(3.0, 3.8);
        assert!(!rig.controller.status().paused);
    }

    #[test]
    fn a_single_tap_that_waits_for_its_double_can_be_the_pause_too() {
        let mut rig = Rig::new("middle_tap=band.pause;middle_double=volume.mute;middle_hold=");
        rig.report("middle", "unknown", "singleTap", 1.0);
        assert!(!rig.controller.status().paused, "waiting for a double tap");
        rig.controller.fire_held_tap(1.5);
        assert!(rig.controller.status().paused);
        rig.report("middle", "unknown", "singleTap", 3.0);
        rig.controller.fire_held_tap(3.5);
        assert!(!rig.controller.status().paused);
    }
}
