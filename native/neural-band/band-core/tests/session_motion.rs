mod common;

use band_core::proto::{ProtoFields, field_bytes as fb, field_int as fi};
use common::*;

/// A subscription reply with the gesture stream on and the motion streams as given.
fn motion_reply(id: u64, motion: u64) -> Vec<u8> {
    [fi(1, id), fi(2, 1), fb(5, &[fi(2, 0), fi(3, 1), fi(6, motion), fi(8, motion)].concat())].concat()
}

#[test]
fn motion_streams_turn_off_and_on_while_gestures_stay() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    assert!(peer.session.streams_enabled());

    let bytes = peer.session.set_motion_enabled(false).unwrap();
    let request = peer.requests(&bytes).unwrap().remove(0);
    assert_eq!(request.channel, 0x8005);
    let fields = ProtoFields::parse(&request.payload).unwrap();
    let control = ProtoFields::parse(fields.bytes(4).unwrap()).unwrap();
    assert_eq!(control.integer(3).unwrap(), 1, "gestures stay on");
    assert_eq!(control.integer(6).unwrap(), 0);
    assert_eq!(control.integer(8).unwrap(), 0);

    // The band's answer, and a later status read, with motion off: still streaming.
    peer.exchange(5, RPC, &motion_reply(3, 0), 1.0).unwrap();
    assert!(peer.session.streams_enabled());
    assert!(!peer.session.motion_active());
    peer.exchange(5, RPC, &motion_reply(5, 0), 2.0).unwrap();
    assert!(peer.session.streams_enabled());

    let bytes = peer.session.set_motion_enabled(true).unwrap();
    assert!(!bytes.is_empty());
    peer.exchange(5, RPC, &motion_reply(3, 1), 3.0).unwrap();
    assert!(peer.session.motion_active());
}

#[test]
fn motion_wanted_but_reported_off_is_a_stopped_subscription() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    assert!(peer.exchange(5, RPC, &motion_reply(5, 0), 1.0).is_err());
}

#[test]
fn gestures_off_on_purpose_keeps_the_subscription() {
    let mut peer = Peer::legacy(true, false);
    peer.exchange(5, RPC, &stream_reply(3, 0), 0.0).unwrap();
    let bytes = peer.session.set_streams(false, false).unwrap();
    let request = peer.requests(&bytes).unwrap().remove(0);
    let fields = ProtoFields::parse(&request.payload).unwrap();
    let control = ProtoFields::parse(fields.bytes(4).unwrap()).unwrap();
    assert_eq!(control.integer(3).unwrap(), 0, "gestures off");
    assert_eq!(control.integer(6).unwrap(), 0);
    assert_eq!(control.integer(8).unwrap(), 0);
    let off = [fi(1, 5), fi(2, 1), fb(5, &[fi(2, 0), fi(3, 0), fi(6, 0), fi(8, 0)].concat())].concat();
    peer.exchange(5, RPC, &off, 1.0).unwrap();
    assert!(peer.session.streams_enabled());
    // Back on: a reply with gestures off is a stopped subscription again.
    peer.session.set_streams(true, true).unwrap();
    assert!(peer.exchange(5, RPC, &off, 2.0).is_err());
}
