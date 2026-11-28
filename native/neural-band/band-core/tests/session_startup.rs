mod common;

use band_core::datax::encode_frame;
use band_core::proto::{ProtoFields, field_bytes as fb, field_int as fi};
use band_core::session::BandSession;
use common::*;

#[test]
fn the_request_opens_encryption_with_parameters_31() {
    let session = BandSession::new(None, None, false);
    let request = session.request().unwrap();
    assert_eq!(hex::encode(&request[..12]), "806280018100000502000001");
    let fields = ProtoFields::parse(&request[12..]).unwrap();
    assert_eq!(fields.bytes(1).unwrap().len(), 64);
    assert_eq!(fields.bytes(2).unwrap().len(), 16);
    assert_eq!(
        (
            fields.integer(3).unwrap(),
            fields.integer(4).unwrap(),
            fields.integer(7).unwrap()
        ),
        (0, 31, 16)
    );
}

#[test]
fn bytes_before_encryption_must_be_a_setup_frame() {
    let mut session = BandSession::new(None, None, false);
    assert!(session.feed(&[0, 0, 0, 0], 0.0).is_err());
}

#[test]
fn startup_waits_for_its_link_and_device_info_before_opening_input() {
    let mut peer = Peer::legacy(false, false);
    assert_eq!(channels(&peer.startup), vec![0x8002, 0x8001]);
    assert!(peer.session.tick(106.0).is_empty());
    let unrelated = peer.exchange(0x8003, LINK, &ready(), 0.0).unwrap();
    assert!(unrelated.0.is_empty() && unrelated.1.is_empty());
    let device = peer.exchange(0x8001, LINK, &ready(), 7.0).unwrap();
    assert_eq!(channels(&device.1), vec![0x8003]);
    assert!(device.0.is_empty());
    let duplicate = peer.exchange(0x8001, LINK, &ready(), 7.0).unwrap();
    assert!(duplicate.1.is_empty());
    for channel in [0x8001u16, 0x8003] {
        let closed = peer.exchange(channel, 0x01000000, &[], 7.0).unwrap();
        assert!(closed.0.is_empty() && closed.1.is_empty());
    }
    let wrong_id = peer
        .exchange(3, RPC, &[fi(1, 2), fi(2, 1)].concat(), 7.0)
        .unwrap();
    assert!(wrong_id.1.is_empty());
    let accepted = peer.exchange(3, RPC, &device_ok(), 7.0).unwrap();
    assert_eq!(channels(&accepted.1), vec![0x8005, 0x8005, 0x8006]);
    assert!(accepted.0.is_empty() && !peer.session.streams_enabled());
    let repeated_link = peer.exchange(0x8001, LINK, &ready(), 7.0).unwrap();
    let repeated_device = peer.exchange(3, RPC, &device_ok(), 7.0).unwrap();
    assert!(repeated_link.0.is_empty() && repeated_link.1.is_empty());
    assert!(repeated_device.0.is_empty() && repeated_device.1.is_empty());
    assert!(peer.session.tick(108.0).is_empty());
    assert_eq!(
        hands(&peer.hand_reply(1, Some(0), 1, 6, 9.0).unwrap().0),
        vec![band_core::events::Hand::Right]
    );
}

#[test]
fn startup_ignores_input_until_device_info_succeeds() {
    for link_ready in [false, true] {
        let mut peer = Peer::legacy(false, false);
        if link_ready {
            peer.exchange(0x8001, LINK, &fi(1, 1), 0.0).unwrap();
        }
        assert!(peer.gyro(1_000_000, 0.0).unwrap().is_empty());
        assert!(peer.gesture(1, 0.01).unwrap().is_empty());
        let quaternion = hex::decode("0000000000000000000000000000803f").unwrap();
        let orientation = [fi(1, 1), fi(2, 1_000_000), fb(3, &quaternion)].concat();
        assert!(
            peer.send(ORIENTATION, &orientation, 0.02)
                .unwrap()
                .is_empty()
        );
        for id in [3u64, 5] {
            let premature = peer
                .exchange(
                    5,
                    RPC,
                    &[fi(1, id), fi(2, 1), fb(5, &flags_on())].concat(),
                    0.0,
                )
                .unwrap();
            assert!(premature.0.is_empty() && premature.1.is_empty());
        }
        assert!(!peer.session.streams_enabled() && peer.session.motion_messages() == 0);
        assert!(peer.session.query_stream_state().unwrap().is_empty());
        if !link_ready {
            peer.exchange(0x8001, LINK, &fi(1, 1), 0.0).unwrap();
        }
        let device = peer.exchange(3, RPC, &device_ok(), 0.0).unwrap();
        assert_eq!(channels(&device.1), vec![0x8005, 0x8005, 0x8006]);
        let enabled = peer.exchange(5, RPC, &status(3), 0.0).unwrap();
        assert!(connected(&enabled.0));
        assert!(peer.session.streams_enabled());
        peer.gyro(1_010_000, 0.03).unwrap();
        assert_eq!(peer.session.motion_messages(), 1);
    }
}

#[test]
fn rejected_startup_channels_fail_immediately_without_reporting_ready() {
    let mut peer = Peer::legacy(false, false);
    peer.exchange(0x8001, LINK, &fi(1, 1), 0.0).unwrap();
    assert!(peer.exchange(3, REJECTED, &[], 0.0).is_err());
    assert!(!peer.session.streams_enabled());
    let mut subscribing = Peer::legacy(true, false);
    let unrelated = subscribing.exchange(7, REJECTED, &[], 0.0).unwrap();
    assert!(unrelated.0.is_empty() && unrelated.1.is_empty());
    assert!(subscribing.exchange(5, REJECTED, &[], 0.0).is_err());
    assert!(!subscribing.session.streams_enabled());
}

#[test]
fn a_failed_link_setup_is_an_error() {
    let mut peer = Peer::legacy(false, false);
    assert!(peer.exchange(0x8001, LINK, &fi(1, 2), 0.0).is_err());
}

#[test]
fn stopping_during_setup_never_opens_an_input_subscription() {
    for link_ready in [false, true] {
        let mut peer = Peer::legacy(false, false);
        if link_ready {
            peer.exchange(0x8001, LINK, &fi(1, 1), 0.0).unwrap();
        }
        assert!(peer.session.stop().unwrap().is_empty());
        let late = peer.exchange(0x8001, LINK, &fi(1, 1), 0.0).unwrap();
        assert!(late.0.is_empty() && late.1.is_empty());
        let device = peer.exchange(3, RPC, &device_ok(), 0.0).unwrap();
        assert!(device.0.is_empty() && device.1.is_empty());
        for channel in [3u16, 5] {
            let closed = peer.exchange(channel, REJECTED, &[], 0.0).unwrap();
            assert!(closed.0.is_empty() && closed.1.is_empty());
        }
        assert!(!peer.session.streams_enabled());
    }
}

#[test]
fn native_handshake_subscribes_and_stops_the_same_streams_on_the_same_channel() {
    let mut peer = Peer::legacy(true, false);
    assert_eq!(
        channels(&peer.startup),
        vec![0x8002, 0x8001, 0x8003, 0x8005, 0x8005, 0x8006]
    );
    assert_eq!(peer.startup[0].words, vec![0x81000024, 0x02003000]);
    assert_eq!(peer.startup[1].words, vec![0x02001000]);
    let end = ProtoFields::parse(&peer.startup[1].payload).unwrap();
    assert_eq!(end.integer(1).unwrap(), 1);
    assert_eq!(end.bytes(2).unwrap().len(), 16);
    assert_eq!(peer.startup[3].words, SERVICE_OPEN.to_vec());
    assert!(peer.startup[4].words.is_empty());
    let enabled = ProtoFields::parse(
        ProtoFields::parse(&peer.startup[4].payload)
            .unwrap()
            .bytes(4)
            .unwrap(),
    )
    .unwrap();
    for field in [3, 6, 8] {
        assert_eq!(enabled.integer(field).unwrap(), 1);
    }
    assert!(!enabled.contains(2));
    let stop = peer.session.stop().unwrap();
    let frames = peer.requests(&stop).unwrap();
    let frame = &frames[0];
    assert_eq!(frame.channel, 0x8005);
    assert!(frame.words.is_empty());
    let request = ProtoFields::parse(&frame.payload).unwrap();
    assert_eq!(request.integer(1).unwrap(), 4);
    let disabled = ProtoFields::parse(request.bytes(4).unwrap()).unwrap();
    for field in [3, 6, 8] {
        assert_eq!(disabled.required_integer(field).unwrap(), 0);
    }
    let partial = [fi(1, 4), fi(2, 1), fb(5, &fi(3, 0))].concat();
    peer.send(RPC, &partial, 1.0).unwrap();
    assert!(!peer.session.stop_acknowledged());
    let complete = [fi(1, 4), fi(2, 1), fb(5, &flags_off())].concat();
    peer.send(RPC, &complete, 2.0).unwrap();
    assert!(peer.session.stop_acknowledged());
    assert!(peer.gesture(1, 3.0).unwrap().is_empty());
    assert!(peer.session.stop().unwrap().is_empty());
}

#[test]
fn late_subscription_replies_do_not_interrupt_shutdown() {
    for request_id in [3u64, 5] {
        let replies = [
            [fi(2, 1), fb(5, &flags_on())].concat(),
            fi(2, 2),
            [fi(2, 1), fb(5, &flags_off())].concat(),
        ];
        for reply in replies {
            let mut peer = Peer::legacy(true, false);
            if request_id == 5 {
                let ready = peer.exchange(5, RPC, &status(3), 0.0).unwrap();
                assert!(connected(&ready.0));
                let query = peer.session.query_stream_state().unwrap();
                assert!(!peer.requests(&query).unwrap().is_empty());
            }
            assert_eq!(peer.session.streams_enabled(), request_id == 5);
            let stop = peer.session.stop().unwrap();
            assert!(!peer.requests(&stop).unwrap().is_empty() && !peer.session.stop_acknowledged());
            let late = encode_frame(5, &[RPC], &[fi(1, request_id), reply].concat()).unwrap();
            let stop_ack =
                encode_frame(5, &[], &[fi(1, 4), fi(2, 1), fb(5, &flags_off())].concat()).unwrap();
            // A late reply must not prevent the following stop acknowledgement in the same record.
            let record = peer.band.encrypt(&[late, stop_ack].concat()).unwrap();
            let result = peer.session.feed(&record, 101.0).unwrap();
            assert!(result.events.is_empty() && result.outgoing.is_empty());
            assert_eq!(peer.session.streams_enabled(), request_id == 5);
            assert!(peer.session.stop_acknowledged());
            assert!(peer.session.query_stream_state().unwrap().is_empty());
            assert!(peer.session.stop().unwrap().is_empty());
        }
    }
}

#[test]
fn a_quiet_band_stays_connected_through_acknowledged_status_queries() {
    let mut peer = Peer::legacy(true, false);
    let started = peer.send(RPC, &status(3), 0.0).unwrap();
    assert!(connected(&started) && heartbeat(&started));
    assert!(peer.session.streams_enabled());
    assert_eq!(peer.session.motion_messages(), 0);
    let query = peer.session.query_stream_state().unwrap();
    let frames = peer.requests(&query).unwrap();
    let frame = &frames[0];
    assert!(frame.channel == 0x8005 && frame.words.is_empty());
    let fields = ProtoFields::parse(&frame.payload).unwrap();
    assert_eq!(fields.integer(1).unwrap(), 5);
    assert!(fields.bytes(4).unwrap().is_empty());
    let reply = peer.send(RPC, &status(5), 2.0).unwrap();
    assert!(heartbeat(&reply) && !connected(&reply));
    assert!(movement(&reply).is_empty());
    peer.session.stop().unwrap();
    assert!(peer.session.query_stream_state().unwrap().is_empty());
}

#[test]
fn another_rpc_channel_cannot_acknowledge_the_input_subscription() {
    for channel in [7u16, 0x8005] {
        let mut peer = Peer::legacy(true, false);
        let unrelated = peer.exchange(channel, RPC, &status(3), 0.0).unwrap();
        assert!(unrelated.0.is_empty() && unrelated.1.is_empty());
        assert!(!peer.session.streams_enabled());
        let accepted = peer.exchange(5, RPC, &status(3), 0.0).unwrap();
        assert!(connected(&accepted.0));
        assert!(peer.session.streams_enabled());
    }
}

#[test]
fn rejected_subscriptions_fail_without_reporting_a_ready_connection() {
    let mut peer = Peer::legacy(true, false);
    assert!(peer.send(RPC, &[fi(1, 3), fi(2, 2)].concat(), 0.0).is_err());
    assert!(!peer.session.streams_enabled());
}

#[test]
fn unknown_repeated_fields_do_not_break_known_gesture_messages() {
    let mut peer = Peer::legacy(true, false);
    let payload = [
        fi(1, 42),
        fi(2, 1000),
        fi(3, 1),
        fi(4, 8),
        fi(99, 1),
        fi(99, 2),
    ]
    .concat();
    let events = peer.send(GESTURE, &payload, 0.0).unwrap();
    let band_core::events::Event::Gesture(gesture) = &events[0] else {
        panic!("missing gesture")
    };
    assert!(gesture.finger == "thumb" && gesture.action == "left");
    assert!(gesture.sequence == 42 && gesture.timestamp_us == 1000);
    assert!(
        peer.send(GESTURE, &[payload, fi(1, 43)].concat(), 1.0)
            .is_err()
    );
}

#[test]
fn the_sim_band_reports_an_oversized_record_instead_of_panicking() {
    let mut peer = Peer::legacy(false, false);
    assert!(peer.band.encrypt(&[0; 5000]).is_err());
}

/// Newer band firmware offers 27 (seen on hardware); the host accepts it and
/// names 26, which that firmware uses. An offer with neither 3's nor 31's
/// extra bits fails.
#[test]
fn a_newer_band_offer_is_answered_with_scheme_26() {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let mut session = BandSession::new(None, None, false);
    session.request().unwrap();
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    let transport = p256::SecretKey::from_slice(&scalar).unwrap();
    let point = transport.public_key().to_encoded_point(false).as_bytes()[1..].to_vec();
    let challenge: Vec<u8> = (0..16).collect();
    let offer = |parameters| {
        encode_frame(
            0x8001,
            &[0x81000005, 0x02000001],
            &[
                fb(1, &point),
                fb(2, &challenge),
                fi(3, 0),
                fi(4, parameters),
                fi(7, 17),
            ]
            .concat(),
        )
        .unwrap()
    };
    let reply = session.feed(&offer(27), 100.0).unwrap();
    let size = usize::from(u16::from_be_bytes([reply.outgoing[0], reply.outgoing[1]]) & 0x7fff) + 4;
    let enable = ProtoFields::parse(&reply.outgoing[8..size]).unwrap();
    assert_eq!(
        enable.integer(5).unwrap(),
        26,
        "the host names the scheme newer firmware uses"
    );
    let mut other = BandSession::new(None, None, false);
    other.request().unwrap();
    let error = other.feed(&offer(4), 100.0).unwrap_err();
    assert!(error.to_string().contains("parameters 4"), "{error}");
}
