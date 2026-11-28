mod common;

use band_core::events::Event;
use common::*;

fn samples(events: &[Event]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Gyro { timestamp_us, raw } => Some(format!("gyro {timestamp_us} {}", raw[0])),
            Event::Orientation { timestamp_us, quaternion } => Some(format!("orientation {timestamp_us} {}", quaternion[0])),
            _ => None,
        })
        .collect()
}

#[test]
fn motion_samples_go_out_only_while_asked_for() {
    let mut peer = Peer::legacy(true, false);
    let gyro = peer.gyro(1_000, 0.0).unwrap();
    let orientation = peer.band.orientation(&mut peer.session, 1_500, [1.0, 0.0, 0.0, 0.0], 0.01).unwrap();
    assert!(samples(&gyro).is_empty() && samples(&orientation).is_empty());

    peer.session.set_motion_samples(true);
    let mut events = peer.gyro(2_000, 0.02).unwrap();
    events.extend(peer.band.orientation(&mut peer.session, 2_500, [1.0, 0.0, 0.0, 0.0], 0.03).unwrap());
    assert_eq!(samples(&events), vec!["gyro 2000 1000", "orientation 2500 1"]);
    // Sensor data never shows in the debug output.
    let printed = format!("{events:?}");
    assert!(printed.contains("Gyro(at=2000)") && !printed.contains("1000]"));

    peer.session.set_motion_samples(false);
    assert!(samples(&peer.gyro(3_000, 0.04).unwrap()).is_empty());
}

#[test]
fn an_invalid_orientation_gives_no_sample() {
    let mut peer = Peer::legacy(true, false);
    peer.session.set_motion_samples(true);
    let events = peer.band.orientation(&mut peer.session, 1_000, [2.0, 0.0, 0.0, 0.0], 0.0).unwrap();
    assert!(samples(&events).is_empty());
}
