use band_core::events::GestureMessage;
use band_core::gestures::{ActionGate, DialRouter, GestureRouter, Recognized, Swipe, Tap};

fn gesture(
    sequence: u64,
    time: f64,
    action: &str,
    derived: &str,
    finger: &str,
    synthetic: bool,
) -> GestureMessage {
    GestureMessage {
        sequence,
        timestamp_us: sequence * 1000,
        finger: finger.into(),
        action: action.into(),
        derived_action: derived.into(),
        synthetic,
        received_at: time,
    }
}

/// kinesis default arguments: time 100, action "left", derived "unknown", finger "thumb".
fn g(sequence: u64) -> GestureMessage {
    gesture(sequence, 100.0, "left", "unknown", "thumb", false)
}

const LEFT: Option<Recognized> = Some(Recognized::Swipe(Swipe::Left));

#[test]
fn one_swipe_produces_one_action_across_raw_derived_and_repeated_messages() {
    let mut router = GestureRouter::default();
    let raw = g(1);
    assert_eq!(router.gesture(&raw, 100.01), LEFT);
    assert_eq!(router.gesture(&raw, 100.02), None);
    assert_eq!(
        router.gesture(
            &gesture(2, 100.03, "unknown", "buttonLeft", "thumb", false),
            100.04
        ),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(3, 100.5, "left", "unknown", "thumb", false),
            100.51
        ),
        LEFT
    );
}

#[test]
fn derived_first_and_all_four_directions_work() {
    let mut router = GestureRouter::default();
    assert_eq!(
        router.gesture(
            &gesture(1, 100.0, "unknown", "buttonRight", "thumb", false),
            100.0
        ),
        Some(Recognized::Swipe(Swipe::Right))
    );
    assert_eq!(
        router.gesture(
            &gesture(2, 100.02, "right", "unknown", "thumb", false),
            100.03
        ),
        None
    );
    assert_eq!(
        router.gesture(&gesture(3, 101.0, "up", "unknown", "thumb", false), 101.0),
        Some(Recognized::Swipe(Swipe::Up))
    );
    assert_eq!(
        router.gesture(&gesture(4, 102.0, "down", "unknown", "thumb", false), 102.0),
        Some(Recognized::Swipe(Swipe::Down))
    );
    assert_eq!(
        router.gesture(&gesture(5, 103.0, "left", "unknown", "thumb", false), 103.0),
        LEFT
    );
}

#[test]
fn stale_partial_synthetic_and_wrong_finger_events_cannot_control_the_desktop() {
    let mut router = GestureRouter::default();
    assert_eq!(router.gesture(&g(1), 101.0), None);
    assert_eq!(
        router.gesture(&gesture(2, 102.0, "left", "unknown", "thumb", false), 100.0),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(3, 100.0, "partialLeft", "unknown", "thumb", false),
            100.0
        ),
        None
    );
    assert_eq!(
        router.gesture(&gesture(4, 100.0, "left", "unknown", "index", false), 100.0),
        None
    );
    assert_eq!(
        router.gesture(&gesture(5, 100.0, "left", "unknown", "thumb", true), 100.0),
        None
    );
    assert_eq!(router.gesture(&g(6), 100.02), LEFT);
}

#[test]
fn reconnect_can_restart_sequence_without_replaying_stale_input() {
    let mut router = GestureRouter::default();
    assert_eq!(router.gesture(&g(1), 100.0), LEFT);
    router.reset();
    assert_eq!(router.gesture(&g(1), 200.0), None);
    assert_eq!(
        router.gesture(&gesture(1, 200.0, "left", "unknown", "thumb", false), 200.0),
        LEFT
    );
}

#[test]
fn enabling_does_not_replay_old_input_and_pausing_is_immediate() {
    let mut gate = ActionGate::default();
    assert!(!gate.allows(100.0, 100.0, true, true));
    gate.arm(100.1);
    assert!(!gate.allows(100.0, 100.2, true, true));
    assert!(gate.allows(100.2, 100.2, true, true));
    assert!(!gate.allows(100.3, 100.3, true, true));
    gate.pause();
    assert!(!gate.allows(101.0, 101.0, true, true));
}

#[test]
fn permission_and_live_connection_are_required_at_dispatch() {
    let mut gate = ActionGate::default();
    gate.arm(100.0);
    assert!(!gate.allows(101.0, 101.0, false, true));
    assert!(!gate.allows(101.0, 101.0, true, false));
    assert!(!gate.allows(101.0, 102.0, true, true));
    assert!(gate.allows(102.0, 102.0, true, true));
}

#[test]
fn double_taps_are_recognized_once_and_partial_pinches_are_ignored() {
    let mut router = GestureRouter::default();
    assert_eq!(
        router.gesture(
            &gesture(1, 100.0, "doubletap", "unknown", "index", false),
            100.0
        ),
        Some(Recognized::Tap(Tap::IndexDoubleTap))
    );
    assert_eq!(
        router.gesture(
            &gesture(2, 100.03, "unknown", "doubleTap", "index", false),
            100.04
        ),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(3, 101.0, "unknown", "doubleTap", "middle", false),
            101.0
        ),
        Some(Recognized::Tap(Tap::MiddleDoubleTap))
    );
    assert_eq!(
        router.gesture(
            &gesture(4, 102.0, "partialClick", "unknown", "index", false),
            102.0
        ),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(5, 103.0, "doubletap", "unknown", "middle", true),
            103.0
        ),
        None
    );
}

#[test]
fn dial_reversal_and_release_do_not_carry_over_old_movement() {
    let mut dial = DialRouter::default();
    assert_eq!(dial.turn(1.0, 1.0, 100.0), 0);
    assert_eq!(dial.turn(-1.0, 1.0, 100.1), 0);
    assert_eq!(dial.turn(-1.0, 1.0, 100.2), -1);
    assert_eq!(dial.turn(1.0, 1.0, 100.3), 0);
    dial.reset();
    assert_eq!(dial.turn(1.0, 1.0, 100.4), 0);
    assert_eq!(dial.turn(f64::NAN, 1.0, 100.5), 0);
    assert_eq!(dial.turn(600.0, 1.0, 100.6), 1);
    assert_eq!(dial.turn(0.0, 1.0, 100.7), 0);
}

#[test]
fn fractional_dial_input_accumulates_across_rate_limit_and_sensitivity_scales() {
    for sensitivity in [0.5, 1.0, 2.0, 4.0] {
        let mut dial = DialRouter::default();
        let mut gate = ActionGate::new(0.0);
        gate.arm(100.0);
        let mut sent = 0;
        for index in 0..32 {
            let now = 100.0 + f64::from(index) * 0.04;
            if gate.allows(now, now, true, true) {
                sent += dial.turn(0.125, sensitivity, now);
            }
        }
        sent += dial.turn(0.0, sensitivity, 101.4);
        assert_eq!(
            sent,
            (2.0 * sensitivity) as i32,
            "sensitivity {sensitivity}"
        );
    }
}

#[test]
fn releasing_or_losing_motion_discards_pending_dial_steps() {
    let mut dial = DialRouter::default();
    assert_eq!(dial.turn(2.0, 1.0, 100.0), 1);
    assert_eq!(dial.turn(2.0, 1.0, 100.01), 0);
    dial.reset();
    assert_eq!(dial.turn(0.0, 1.0, 100.1), 0);
    assert_eq!(dial.turn(2.0, 1.0, 100.2), 1);
    assert_eq!(dial.turn(2.0, 1.0, 100.21), 0);
    assert_eq!(dial.turn(0.0, 1.0, 101.0), 0);
}

#[test]
fn a_fast_dial_flick_cannot_send_a_burst_or_queue_more_changes() {
    let mut dial = DialRouter::default();
    assert_eq!(dial.turn(20.0, 4.0, 100.0), 1);
    assert_eq!(dial.turn(0.0, 4.0, 100.1), 0);
    assert_eq!(dial.turn(-20.0, 4.0, 100.2), -1);
    assert_eq!(dial.turn(0.0, 4.0, 100.3), 0);
}

#[test]
fn interleaved_raw_and_derived_gestures_are_counted_once_per_gesture() {
    let mut router = GestureRouter::default();
    assert_eq!(
        router.gesture(&gesture(1, 100.0, "left", "unknown", "thumb", false), 100.0),
        LEFT
    );
    assert_eq!(
        router.gesture(
            &gesture(2, 100.01, "right", "unknown", "thumb", false),
            100.01
        ),
        Some(Recognized::Swipe(Swipe::Right))
    );
    assert_eq!(
        router.gesture(
            &gesture(3, 100.02, "unknown", "buttonLeft", "thumb", false),
            100.02
        ),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(4, 100.03, "unknown", "buttonRight", "thumb", false),
            100.03
        ),
        None
    );
    assert_eq!(
        router.gesture(
            &gesture(5, 100.04, "left", "unknown", "thumb", false),
            100.04
        ),
        LEFT
    );
}

#[test]
fn gesture_identity_includes_the_finger() {
    let mut router = GestureRouter::default();
    assert_eq!(
        router.gesture(&gesture(1, 100.0, "tap", "unknown", "index", false), 100.0),
        Some(Recognized::Tap(Tap::IndexTap))
    );
    assert_eq!(
        router.gesture(&gesture(1, 100.0, "tap", "unknown", "middle", false), 100.0),
        Some(Recognized::Tap(Tap::MiddleTap))
    );
}

#[test]
fn a_middle_hold_is_a_gesture_and_an_index_hold_is_not() {
    let mut router = GestureRouter::default();
    let hold = |finger: &str, sequence: u64| GestureMessage {
        sequence,
        timestamp_us: sequence,
        finger: finger.into(),
        action: "press".into(),
        derived_action: "buttonHold".into(),
        synthetic: false,
        received_at: 100.0,
    };
    assert_eq!(
        router.gesture(&hold("middle", 1), 100.0),
        Some(Recognized::Tap(Tap::MiddleHold))
    );
    // Holding the index finger is the dial, so it never fires an action of its own.
    assert_eq!(router.gesture(&hold("index", 2), 100.0), None);
    assert_eq!(
        (Tap::MiddleHold.finger(), Tap::MiddleHold.action()),
        ("middle", "hold")
    );
}
