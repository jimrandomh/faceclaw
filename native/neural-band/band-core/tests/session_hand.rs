mod common;

use band_core::events::Hand;
use common::*;

#[test]
fn native_hand_selection_writes_only_handedness_and_checks_an_independent_readback() {
    for selected in [Hand::Left, Hand::Right] {
        let mut peer = Peer::legacy(true, false);
        let initial = if selected == Hand::Left { 0 } else { 1 };
        let desired: u8 = if selected == Hand::Left { 1 } else { 0 };
        let query = peer.startup.last().unwrap().clone();
        assert_eq!(query.channel, 0x8006);
        assert_eq!(query.words, SERVICE_OPEN.to_vec());
        assert_eq!(hex::encode(&query.payload), "08012a00");
        assert!(
            peer.session.set_handedness(selected, 100.0).is_err(),
            "no hand reported yet"
        );
        let read = peer.hand_reply(1, Some(initial), 1, 6, 1.0).unwrap();
        let opposite = if selected == Hand::Left {
            Hand::Right
        } else {
            Hand::Left
        };
        assert_eq!(hands(&read.0), vec![opposite]);
        assert!(read.1.is_empty());
        peer.send(RPC, &status(3), 1.0).unwrap();
        let bytes = peer.session.set_handedness(selected, 101.0).unwrap();
        let request = peer.requests(&bytes).unwrap();
        assert_eq!(request.len(), 1);
        assert!(request[0].channel == 0x8006 && request[0].words.is_empty());
        assert_eq!(
            request[0].payload,
            vec![0x08, 0x02, 0x2a, 0x02, 0x50, desired]
        );
        assert!(
            peer.session.set_handedness(selected, 101.0).is_err(),
            "one request at a time"
        );
        let stale = peer
            .hand_reply(1, Some(u64::from(desired)), 1, 6, 1.0)
            .unwrap();
        assert!(hands(&stale.0).is_empty() && stale.1.is_empty());
        let wrong_channel = peer
            .hand_reply(2, Some(u64::from(desired)), 1, 7, 1.0)
            .unwrap();
        assert!(hands(&wrong_channel.0).is_empty() && wrong_channel.1.is_empty());
        let written = peer
            .hand_reply(2, Some(u64::from(desired)), 1, 6, 2.0)
            .unwrap();
        assert!(hands(&written.0).is_empty());
        assert_eq!(written.1.len(), 1);
        assert_eq!(written.1[0].channel, 0x8006);
        assert_eq!(hex::encode(&written.1[0].payload), "08032a00");
        let confirmed = peer
            .hand_reply(3, Some(u64::from(desired)), 1, 6, 3.0)
            .unwrap();
        assert_eq!(hands(&confirmed.0), vec![selected]);
        assert_eq!(peer.session.hand(), Some(selected));
        assert!(confirmed.1.is_empty());
    }
}

#[test]
fn native_hand_read_rejects_missing_invalid_and_late_values() {
    for value in [None, Some(2)] {
        let mut peer = Peer::legacy(true, false);
        let result = peer.hand_reply(1, value, 1, 6, 1.0).unwrap();
        assert!(hands(&result.0).is_empty());
        assert!(hand_failure(&result.0));
        assert_eq!(peer.session.hand(), None);
    }
    let mut peer = Peer::legacy(true, false);
    assert!(hand_failure(&peer.session.tick(106.0)));
    let late = peer.hand_reply(1, Some(1), 1, 6, 7.0).unwrap();
    assert!(hands(&late.0).is_empty() && late.1.is_empty());
    assert_eq!(peer.session.hand(), None);
    let mut unticked = Peer::legacy(true, false);
    let delayed = unticked.hand_reply(1, Some(1), 1, 6, 7.0).unwrap();
    assert!(hands(&delayed.0).is_empty() && delayed.1.is_empty());
    assert!(hand_failure(&delayed.0));
    assert_eq!(unticked.session.hand(), None);
}

#[test]
fn native_hand_write_rejection_and_mismatched_readback_never_confirm_the_requested_hand() {
    for rejected in [true, false] {
        let mut peer = Peer::legacy(true, false);
        peer.hand_reply(1, Some(0), 1, 6, 1.0).unwrap();
        peer.send(RPC, &status(3), 1.0).unwrap();
        let bytes = peer.session.set_handedness(Hand::Left, 101.0).unwrap();
        peer.requests(&bytes).unwrap();
        let write = peer
            .hand_reply(2, Some(1), if rejected { 2 } else { 1 }, 6, 2.0)
            .unwrap();
        let result = if rejected {
            write
        } else {
            peer.hand_reply(3, Some(0), 1, 6, 3.0).unwrap()
        };
        assert!(!hands(&result.0).contains(&Hand::Left));
        assert!(hand_failure(&result.0));
        assert!(result.1.is_empty());
        assert_ne!(peer.session.hand(), Some(Hand::Left));
    }
}

#[test]
fn a_rejected_configuration_service_fails_the_hand_read() {
    let mut peer = Peer::legacy(true, false);
    let result = peer.exchange(6, REJECTED, &[], 1.0).unwrap();
    assert!(hand_failure(&result.0));
    assert_eq!(peer.session.hand(), None);
}
