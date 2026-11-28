mod common;

use band_core::events::Event;
use common::*;

#[test]
fn encrypted_input_drives_the_dial_and_releases_on_motion_loss() {
    let mut peer = Peer::legacy(true, false);
    let first = peer.gyro(1_000_000, 0.0).unwrap();
    assert!(connected(&first) && heartbeat(&first));
    assert!(
        engagement(&peer.gesture_with(1, 2, 0, 1, 0.01).unwrap()).is_empty(),
        "synthetic press"
    );
    let press = peer.gesture(1, 0.02).unwrap();
    // A press alone never arms the dial. A tap is over before a hold begins.
    assert!(engagement(&press).is_empty());
    let Event::Gesture(gesture) = &press[0] else {
        panic!("missing gesture")
    };
    assert!(gesture.finger == "index" && gesture.action == "press" && !gesture.synthetic);
    assert!(gesture.sequence == 10 && gesture.timestamp_us == 20);
    assert_eq!(gesture.received_at, 100.0 + 0.02);
    assert!(engagement(&peer.gesture_with(0, 2, 9, 0, 0.021).unwrap()).is_empty());
    // Held with motion flowing, it arms once the pinch has outlasted a tap, and turns from there.
    let held = peer.spin(0.03, 0.22).unwrap();
    assert_eq!(engagement(&held), vec![true]);
    let turn = movement(&held);
    assert!(!turn.is_empty());
    assert!((turn[0] - 0.7).abs() < 1e-9, "first turn {}", turn[0]);
    // Motion stops arriving: the dial lets go.
    assert_eq!(engagement(&peer.session.tick(100.6)), vec![false]);
    assert!(movement(&peer.spin(0.61, 0.61).unwrap()).is_empty());
    // A gap in the band's own clock lets go too.
    assert!(engagement(&peer.gesture(1, 0.62).unwrap()).is_empty());
    assert_eq!(engagement(&peer.spin(0.63, 0.82).unwrap()), vec![true]);
    peer.band.stamp += 1_000_000;
    assert_eq!(engagement(&peer.spin(0.83, 0.83).unwrap()), vec![false]);
    assert!(movement(&peer.spin(0.84, 0.84).unwrap()).is_empty());
    // So does the release.
    assert!(engagement(&peer.gesture(1, 0.85).unwrap()).is_empty());
    assert_eq!(engagement(&peer.spin(0.86, 1.05).unwrap()), vec![true]);
    assert_eq!(engagement(&peer.gesture(2, 1.06).unwrap()), vec![false]);
    assert!(movement(&peer.spin(1.07, 1.07).unwrap()).is_empty());
}

#[test]
fn the_two_presses_of_a_double_tap_never_arm_the_dial() {
    let mut peer = Peer::legacy(true, false);
    peer.spin(0.0, 0.02).unwrap();
    let mut events = Vec::new();
    // Two quick pinches with the wrist moving the whole time.
    for start in [0.03, 0.22] {
        events.extend(peer.gesture(1, start).unwrap());
        events.extend(peer.spin(start + 0.01, start + 0.12).unwrap());
        events.extend(peer.gesture(2, start + 0.13).unwrap());
        events.extend(peer.spin(start + 0.14, start + 0.18).unwrap());
    }
    assert!(engagement(&events).is_empty() && movement(&events).is_empty());
    // The same pinch, held, does arm.
    let mut held = peer.gesture(1, 0.5).unwrap();
    held.extend(peer.spin(0.51, 0.75).unwrap());
    assert_eq!(engagement(&held), vec![true]);
    assert!(!movement(&held).is_empty());
}

#[test]
fn startup_motion_does_not_turn_an_old_press_into_a_new_pinch() {
    let mut peer = Peer::legacy(true, false);
    assert!(engagement(&peer.gesture(1, 0.0).unwrap()).is_empty());
    peer.gyro(1_000_000, 0.01).unwrap();
    assert!(engagement(&peer.gesture_with(0, 2, 9, 0, 0.02).unwrap()).is_empty());
    assert!(movement(&peer.gyro(1_010_000, 0.03).unwrap()).is_empty());
    // Held long past the arming delay, the old press still never becomes a pinch.
    peer.band.stamp = 1_010_000;
    let stale = peer.spin(0.04, 0.3).unwrap();
    assert!(engagement(&stale).is_empty() && movement(&stale).is_empty());
    peer.gesture(2, 0.31).unwrap();
    // A press made while motion is flowing does.
    assert!(engagement(&peer.gesture(1, 0.32).unwrap()).is_empty());
    let fresh = peer.spin(0.33, 0.55).unwrap();
    assert_eq!(engagement(&fresh), vec![true]);
    assert!(!movement(&fresh).is_empty());
}

#[test]
fn a_lone_invalid_orientation_sample_is_skipped_and_a_run_of_them_is_an_error() {
    let mut peer = Peer::legacy(true, false);
    let sample = |sequence: u64, quaternion: [f32; 4]| {
        let bytes: Vec<u8> = quaternion.iter().flat_map(|v| v.to_le_bytes()).collect();
        [
            band_core::proto::field_int(1, sequence),
            band_core::proto::field_int(2, sequence * 1_000),
            band_core::proto::field_bytes(3, &bytes),
        ]
        .concat()
    };
    let not_unit = [0.0f32; 4];
    let unit = [1.0f32, 0.0, 0.0, 0.0];
    assert!(peer.send(ORIENTATION, &sample(1, not_unit), 0.0).is_ok());
    assert!(peer.send(ORIENTATION, &sample(2, unit), 0.01).is_ok());
    // A good one in between starts the count again.
    for sequence in 3..27 {
        assert!(peer.send(ORIENTATION, &sample(sequence, not_unit), sequence as f64 * 0.01).is_ok());
    }
    assert!(peer.send(ORIENTATION, &sample(27, not_unit), 0.27).is_err());
}
