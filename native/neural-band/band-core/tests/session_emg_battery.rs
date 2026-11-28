mod common;

use band_core::events::{BatteryStatus, Event};
use band_core::proto::{field_bytes as fb, field_int as fi};
use common::*;

fn emg_config_reply(id: u64, encoding: u64) -> Vec<u8> {
    let config = [
        fi(1, 2048),
        fi(2, 8),
        fi(4, 16),
        fi(5, 16),
        fi(10, encoding),
    ]
    .concat();
    [fi(1, id), fi(2, 1), fb(6, &fb(42, &config))].concat()
}

fn battery_reply(id: u64, level: u64, charging: Option<u64>) -> Vec<u8> {
    let mut battery = fi(1, level);
    if let Some(charging) = charging {
        battery.extend(fi(2, charging));
    }
    [fi(1, id), fi(2, 1), fb(3, &fb(1, &battery))].concat()
}

fn has_emg_state(events: &[Event], on: bool) -> bool {
    events
        .iter()
        .any(|event| matches!(event, Event::RawEmgState(state) if *state == on))
}

fn has_emg_failure(events: &[Event]) -> bool {
    events
        .iter()
        .any(|event| matches!(event, Event::RawEmgFailure(_)))
}

fn battery_events(events: &[Event]) -> Vec<Option<BatteryStatus>> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::BatteryStatus(status) => Some(*status),
            _ => None,
        })
        .collect()
}

#[test]
fn live_emg_can_be_enabled_and_disabled_without_replacing_gesture_streams() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    let bytes = peer.session.set_raw_emg_enabled(true, 100.0).unwrap();
    let config_read = peer.requests(&bytes).unwrap().remove(0);
    assert_eq!(config_read.channel, 0x8007);
    assert_eq!(config_read.words, SERVICE_OPEN.to_vec());
    assert_eq!(config_read.payload, [fi(1, 7), fb(5, &[])].concat());
    assert!(
        peer.session.query_stream_state().unwrap().is_empty(),
        "no status query mid-change"
    );
    let queried = peer.exchange(7, RPC, &emg_config_reply(7, 0), 0.0).unwrap();
    assert!(
        queried.0.iter().any(
            |event| matches!(event, Event::RawEmgConfiguration(config) if config.is_supported())
        )
    );
    let query = &queried.1[0];
    assert!(query.channel == 0x8005 && query.words.is_empty());
    assert_eq!(query.payload, [fi(1, 8), fb(4, &[])].concat());
    let enabled = peer.exchange(5, RPC, &stream_reply(8, 0), 0.0).unwrap();
    let enable = &enabled.1[0];
    assert!(enable.channel == 0x8005 && enable.words.is_empty());
    assert_eq!(
        enable.payload,
        [fi(1, 9), fb(4, &[fi(2, 1), flags_on()].concat())].concat()
    );
    let ack = peer.exchange(5, RPC, &stream_reply(9, 1), 0.0).unwrap();
    assert!(has_emg_state(&ack.0, true));
    assert!(!connected(&ack.0));
    let sample = [fi(1, 1), fi(2, 1_000_000), fb(3, &[128; 256])].concat();
    assert!(
        peer.raw(&sample, 1.0)
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::RawEmgFrame(_)))
    );
    let gesture = peer
        .send(
            GESTURE,
            &[fi(1, 1), fi(2, 1_000_000), fi(3, 2), fi(4, 3)].concat(),
            1.0,
        )
        .unwrap();
    assert!(
        gesture
            .iter()
            .any(|event| matches!(event, Event::Gesture(_)))
    );
    assert!(data_seen(&peer.gyro(1_000_000, 1.0).unwrap()));
    let bytes = peer.session.set_raw_emg_enabled(false, 102.0).unwrap();
    let disable = peer.requests(&bytes).unwrap().remove(0);
    assert_eq!(
        disable.payload,
        [fi(1, 10), fb(4, &[fi(2, 0), flags_on()].concat())].concat()
    );
    let off = peer.exchange(5, RPC, &stream_reply(10, 0), 2.0).unwrap();
    assert!(has_emg_state(&off.0, false));
    assert!(peer.session.streams_enabled());
    let stop_bytes = peer.session.stop().unwrap();
    let stop = peer.requests(&stop_bytes).unwrap().remove(0);
    let all_off = [fi(2, 0), fi(3, 0), fi(6, 0), fi(8, 0)].concat();
    assert_eq!(stop.payload, [fi(1, 4), fb(4, &all_off)].concat());
    peer.exchange(5, RPC, &[fi(1, 4), fi(2, 1), fb(5, &all_off)].concat(), 3.0)
        .unwrap();
    assert!(peer.session.stop_acknowledged());
    assert!(peer.raw(&sample, 4.0).unwrap().is_empty());
}

#[test]
fn a_saved_emg_preference_starts_gestures_before_adding_readings() {
    let mut peer = Peer::legacy(true, true);
    assert!(!peer.startup.iter().any(|frame| frame.channel == 0x8007));
    let ack = peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    assert!(connected(&ack.0));
    assert_eq!(channels(&ack.1), vec![0x8007]);
}

#[test]
fn emg_timeout_and_rejection_do_not_discard_the_gesture_subscription() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    let bytes = peer.session.set_raw_emg_enabled(true, 100.0).unwrap();
    peer.requests(&bytes).unwrap();
    assert!(peer.session.set_raw_emg_enabled(false, 101.0).is_err());
    assert!(has_emg_failure(&peer.session.tick(109.0)));
    assert!(peer.session.streams_enabled());
    let bytes = peer.session.set_raw_emg_enabled(true, 110.0).unwrap();
    peer.requests(&bytes).unwrap();
    let rejected = peer
        .exchange(7, RPC, &[fi(1, 8), fi(2, 0)].concat(), 10.0)
        .unwrap();
    assert!(has_emg_failure(&rejected.0));
    assert!(peer.session.streams_enabled());
    let bytes = peer.session.set_raw_emg_enabled(true, 111.0).unwrap();
    peer.requests(&bytes).unwrap();
    let service_rejected = peer.exchange(7, REJECTED, &[], 11.0).unwrap();
    assert!(has_emg_failure(&service_rejected.0));
    assert!(peer.session.streams_enabled());
}

#[test]
fn battery_status_reads_charging_without_changing_the_sensor_subscription() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    let bytes = peer.session.query_battery_status(100.0).unwrap();
    let query = peer.requests(&bytes).unwrap().remove(0);
    assert!(query.channel == 0x8008 && query.words == SERVICE_OPEN.to_vec());
    assert_eq!(hex::encode(&query.payload), "08011200");
    assert!(
        peer.session.query_battery_status(101.0).unwrap().is_empty(),
        "one query at a time"
    );
    let unrelated = peer
        .exchange(8, RPC, &battery_reply(9, 84, Some(1)), 0.0)
        .unwrap();
    assert!(battery_events(&unrelated.0).is_empty());
    let charged = peer
        .exchange(8, RPC, &battery_reply(1, 84, Some(1)), 0.0)
        .unwrap();
    assert_eq!(
        battery_events(&charged.0),
        vec![Some(BatteryStatus {
            level: 84,
            charging: Some(true)
        })]
    );
    let bytes = peer.session.query_battery_status(105.0).unwrap();
    let next = peer.requests(&bytes).unwrap().remove(0);
    assert!(next.channel == 0x8008 && next.words.is_empty());
    let off = peer
        .exchange(8, RPC, &battery_reply(2, 84, Some(0)), 5.0)
        .unwrap();
    assert_eq!(battery_events(&off.0)[0].unwrap().charging, Some(false));
    assert!(peer.session.streams_enabled());
}

#[test]
fn unavailable_battery_status_never_breaks_gestures() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    let bytes = peer.session.query_battery_status(100.0).unwrap();
    peer.requests(&bytes).unwrap();
    assert_eq!(battery_events(&peer.session.tick(104.0)), vec![None]);
    let bytes = peer.session.query_battery_status(105.0).unwrap();
    peer.requests(&bytes).unwrap();
    let rejected = peer.exchange(8, REJECTED, &[], 5.0).unwrap();
    assert_eq!(battery_events(&rejected.0), vec![None]);
    assert!(
        peer.session.query_battery_status(110.0).unwrap().is_empty(),
        "unavailable stays unavailable"
    );
    assert!(peer.session.streams_enabled());
    assert!(data_seen(&peer.gyro(1_000_000, 10.0).unwrap()));
}
