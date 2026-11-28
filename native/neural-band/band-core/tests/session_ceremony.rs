mod common;

use band_core::ceremony::{CeremonyHttpRequest, OwnershipCeremony};
use band_core::datax::{DataXFrame, encode_frame};
use band_core::events::Event;
use band_core::identity::{point64, trust_digest};
use band_core::proto::{ProtoFields, field_bytes as fb};
use band_core::session::BandSession;
use band_core::sim::SimBand;
use band_core::{BandError, Result};
use common::{channels, connected, device_ok, ready, status};
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};

const SERIAL: &str = "TESTSERIAL0001";
const PENDING_RECEIPT: &str =
    r#"{"serial":"TESTSERIAL0001","receipt_type":"ServerPendingOwnershipReceipt"}"#;
const DEVICE_RECEIPT: &str =
    r#"{"receipt_type":"DevicePendingOwnershipReceipt","additional_data":"{}"}"#;
const FINAL_RECEIPT: &str = r#"{"receipt_type":"ServerFinalOwnershipReceipt"}"#;

fn nonce() -> Vec<u8> {
    (0..16).collect()
}

fn identity_response() -> Vec<u8> {
    let payload = [fb(1, &[1; 967]), fb(2, SERIAL.as_bytes()), fb(5, &[2; 889])].concat();
    encode_frame(2, &[0x02003001], &payload).unwrap()
}

fn skip_challenge_response() -> Vec<u8> {
    encode_frame(2, &[0x02002001], &[vec![0x0a, 0x10], nonce()].concat()).unwrap()
}

/// A pairing-mode band running the ceremony (kinesis `CeremonyPeer`).
struct CeremonyPeer {
    session: BandSession,
    band: SimBand,
    startup: Vec<DataXFrame>,
}

impl CeremonyPeer {
    fn new() -> CeremonyPeer {
        let mut session = BandSession::new(None, Some(OwnershipCeremony::default()), false);
        let (band, startup) = SimBand::connect(&mut session).unwrap();
        CeremonyPeer {
            session,
            band,
            startup,
        }
    }

    fn send(&mut self, frame: &[u8]) -> Result<(Vec<Event>, Vec<DataXFrame>)> {
        let record = self.band.encrypt(frame)?;
        let result = self.session.feed(&record, 100.0)?;
        Ok((result.events, self.band.requests(&result.outgoing)?))
    }
}

#[test]
fn the_session_runs_the_whole_ceremony_and_rejoins_the_enrolled_startup() {
    let mut peer = CeremonyPeer::new();
    let app_point = peer.session.ceremony().unwrap().app_public_key();
    // After the transport handshake the session opens the identity service.
    assert_eq!(peer.startup.len(), 1);
    assert_eq!(peer.startup[0].channel, 0x8002);
    assert_eq!(peer.startup[0].words, vec![0x81000024, 0x02003000]);
    // IdentityResponse -> SkipChallenge.
    let skip = peer.send(&identity_response()).unwrap().1;
    assert!(skip.len() == 1 && skip[0].channel == 0x8002 && skip[0].words == vec![0x02002000]);
    // SkipChallengeResponse -> pair_request event with the nonce.
    let challenge = peer.send(&skip_challenge_response()).unwrap().0;
    let request = challenge
        .iter()
        .find_map(|event| match event {
            Event::CeremonyHttp(CeremonyHttpRequest::PairRequest(request)) => Some(request.clone()),
            _ => None,
        })
        .expect("pair_request event");
    assert_eq!(request.nonce, nonce());
    assert_eq!(request.app_public_key, app_point);
    assert_eq!(request.identity.serial, SERIAL);
    // The HTTP reply becomes StartChangeOwner on channel 0x8002.
    let pending_signature = [vec![0x30, 0x45, 0x02, 0x20], vec![3; 67]].concat();
    let start_bytes = peer
        .session
        .ceremony_pair_request_completed(&pending_signature, PENDING_RECEIPT)
        .unwrap();
    let start = peer.band.requests(&start_bytes).unwrap().remove(0);
    assert!(start.channel == 0x8002 && start.words == vec![0x02002002]);
    assert_eq!(
        ProtoFields::parse(&start.payload)
            .unwrap()
            .bytes(2)
            .unwrap(),
        PENDING_RECEIPT.as_bytes()
    );
    // StartChangeOwnerResponse -> pair event with the verbatim receipt.
    let device_signature = [vec![0x30, 0x46, 0x02, 0x21], vec![4; 66]].concat();
    let response = encode_frame(
        2,
        &[0x02002003],
        &[fb(1, &device_signature), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
    )
    .unwrap();
    let events = peer.send(&response).unwrap().0;
    let pair = events
        .iter()
        .find_map(|event| match event {
            Event::CeremonyHttp(CeremonyHttpRequest::Pair(pair)) => Some(pair.clone()),
            _ => None,
        })
        .expect("pair event");
    assert_eq!(
        (pair.receipt.as_str(), pair.signature.clone()),
        (DEVICE_RECEIPT, device_signature)
    );
    // The final receipt becomes FinishChangeOwner; the empty confirmation hands
    // the new identity out and opens the enrolled trust flow.
    let band_key = SigningKey::random(&mut OsRng);
    let band_point = point64(band_key.verifying_key());
    let final_signature = [vec![0x30, 0x45, 0x02, 0x21], vec![5; 67]].concat();
    let finish_bytes = peer
        .session
        .ceremony_pair_completed(&final_signature, FINAL_RECEIPT, Some(&band_point))
        .unwrap();
    let finish = peer.band.requests(&finish_bytes).unwrap().remove(0);
    assert!(finish.channel == 0x8002 && finish.words == vec![0x02002004]);
    let (events, requests) = peer
        .send(&encode_frame(2, &[0x02002005], &[]).unwrap())
        .unwrap();
    let identity = events
        .iter()
        .find_map(|event| match event {
            Event::CeremonyCompleted(identity) => Some(identity.clone()),
            _ => None,
        })
        .expect("ceremony completed event");
    assert_eq!(identity.app_point(), app_point);
    assert_eq!(identity.band_public_key, Some(*band_key.verifying_key()));
    // The service is already open on 0x8002, so the trust proof uses one word.
    let trust = &requests[0];
    assert!(trust.channel == 0x8002 && trust.words == vec![0x02001000]);
    let trust_fields = ProtoFields::parse(&trust.payload).unwrap();
    assert_eq!(
        trust_fields.bytes(1).unwrap(),
        Sha256::digest(&app_point).as_slice()
    );
    let digest = trust_digest(
        &peer.band.band_challenge,
        &peer.band.transport_point,
        &peer.band.host_seed,
        &peer.band.host_point,
    );
    let signature = Signature::from_slice(trust_fields.bytes_len(2, 64).unwrap()).unwrap();
    identity
        .private_key
        .verifying_key()
        .verify_prehash(&digest, &signature)
        .unwrap();
    // From here the standard enrolled startup continues: band proof accepted, then EndLinkSetup.
    assert!(
        peer.send(&encode_frame(2, &[0x03001000], &[]).unwrap())
            .unwrap()
            .1
            .is_empty()
    );
    let proof = peer.band.trust_proof(&band_key).unwrap();
    let acknowledged = peer.send(&proof).unwrap().1;
    assert_eq!(acknowledged.first().unwrap().channel, 3);
    let end = acknowledged.last().unwrap();
    assert!(end.channel == 0x8001 && end.words == vec![0x02001000]);
}

#[test]
fn identity_result_codes_fail_the_ceremony_session() {
    let mut peer = CeremonyPeer::new();
    peer.send(&identity_response()).unwrap();
    match peer.send(&encode_frame(2, &[0x03001043], &[]).unwrap()) {
        Err(BandError::OwnershipRejected { message, .. }) => {
            assert!(message.contains("identity"), "{message}")
        }
        other => panic!("expected an ownership rejection, got {other:?}"),
    }
}

fn completed_identity(events: &[Event]) -> Option<band_core::identity::EnrollmentIdentity> {
    events.iter().find_map(|event| match event {
        Event::CeremonyCompleted(identity) => Some(identity.clone()),
        _ => None,
    })
}

impl CeremonyPeer {
    /// Identity read, skip challenge and StartChangeOwner: the band now holds
    /// the server's pending receipt.
    fn claim(&mut self) {
        self.send(&identity_response()).unwrap();
        self.send(&skip_challenge_response()).unwrap();
        let start = self
            .session
            .ceremony_pair_request_completed(&[3; 71], PENDING_RECEIPT)
            .unwrap();
        self.band.requests(&start).unwrap();
    }

    /// Through the StartChangeOwnerResponse: the session waits for the `pair` reply.
    fn claim_through_pair(&mut self) {
        self.claim();
        let response = encode_frame(
            2,
            &[0x02002003],
            &[fb(1, &[4; 70]), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
        self.send(&response).unwrap();
    }

    /// Write FinishChangeOwner with `band_key`'s point as the device key.
    fn finish(&mut self, band_key: &SigningKey) {
        let finish = self
            .session
            .ceremony_pair_completed(
                &[5; 71],
                FINAL_RECEIPT,
                Some(&point64(band_key.verifying_key())),
            )
            .unwrap();
        self.band.requests(&finish).unwrap();
    }

    /// The band's empty FinishChangeOwnerResponse.
    fn confirm(&mut self) -> (Vec<Event>, Vec<DataXFrame>) {
        self.send(&encode_frame(2, &[0x02002005], &[]).unwrap())
            .unwrap()
    }
}

#[test]
fn a_wrong_account_rejection_is_typed_and_stores_nothing() {
    let mut peer = CeremonyPeer::new();
    peer.claim();
    match peer.send(&encode_frame(2, &[0x03001042], &[]).unwrap()) {
        Err(BandError::OwnershipRejected { code, message }) => {
            assert_eq!(code, 0x1042);
            assert!(message.contains("different meta account"), "{message}");
        }
        other => panic!("expected an ownership rejection, got {other:?}"),
    }
    assert!(peer.session.enrollment().is_none());
}

#[test]
fn the_pending_identity_is_what_the_confirmation_hands_out() {
    let mut peer = CeremonyPeer::new();
    assert!(peer.session.pending_identity().is_none());
    peer.claim_through_pair();
    assert!(peer.session.pending_identity().is_none());
    let band_key = SigningKey::random(&mut OsRng);
    peer.finish(&band_key);
    let pending = peer
        .session
        .pending_identity()
        .expect("pending identity after FinishChangeOwner");
    let completed = completed_identity(&peer.confirm().0).expect("ceremony completed event");
    assert_eq!(pending.private_bytes(), completed.private_bytes());
    assert_eq!(pending.band_key_x963(), completed.band_key_x963());
    assert_eq!(
        pending.band_key_x963(),
        Some(
            band_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec()
        )
    );
}

#[test]
fn a_link_lost_after_finish_change_owner_still_leaves_the_pending_identity() {
    let mut peer = CeremonyPeer::new();
    peer.claim_through_pair();
    peer.finish(&SigningKey::random(&mut OsRng));
    let app_key: [u8; 32] = peer.session.ceremony().unwrap().app_key().to_bytes().into();
    let pending = peer.session.pending_identity().expect("pending identity");
    drop(peer);
    assert_eq!(pending.private_bytes(), app_key);
}

impl CeremonyPeer {
    /// Run the whole ceremony with `band_key` as the band's identity key, up to
    /// the host's trust proof; returns the frames the confirmation produced.
    fn enroll(&mut self, band_key: &SigningKey) -> Vec<DataXFrame> {
        self.claim_through_pair();
        self.finish(band_key);
        let (events, requests) = self.confirm();
        assert!(completed_identity(&events).is_some());
        requests
    }
}

#[test]
fn after_the_ceremony_the_session_rejoins_the_full_startup() {
    let mut peer = CeremonyPeer::new();
    let band_key = SigningKey::random(&mut OsRng);
    peer.enroll(&band_key);
    assert!(
        peer.send(&encode_frame(2, &[0x03001000], &[]).unwrap())
            .unwrap()
            .1
            .is_empty()
    );
    let proof = peer.band.trust_proof(&band_key).unwrap();
    let end = peer.send(&proof).unwrap().1;
    let end = end.last().unwrap();
    assert!(end.channel == 0x8001 && end.words == vec![0x02001000]);
    let end_ack = peer
        .send(&encode_frame(0x8001, &[0x02001000], &ready()).unwrap())
        .unwrap()
        .1;
    assert_eq!(channels(&end_ack), vec![0x8003]);
    let info = peer
        .send(&encode_frame(3, &[0x02000315], &device_ok()).unwrap())
        .unwrap()
        .1;
    assert_eq!(channels(&info), vec![0x8005, 0x8005, 0x8006]);
    let (events, _) = peer
        .send(&encode_frame(5, &[0x02000315], &status(3)).unwrap())
        .unwrap();
    assert!(connected(&events));
    assert!(peer.session.streams_enabled());
}

#[test]
fn a_rejection_after_finish_change_owner_keeps_the_pending_identity() {
    let mut peer = CeremonyPeer::new();
    peer.claim_through_pair();
    peer.finish(&SigningKey::random(&mut OsRng));
    match peer.send(&encode_frame(2, &[0x03001044], &[]).unwrap()) {
        Err(BandError::OwnershipRejected { code, .. }) => assert_eq!(code, 0x1044),
        other => panic!("expected an ownership rejection, got {other:?}"),
    }
    assert!(peer.session.enrollment().is_none());
    assert!(peer.session.pending_identity().is_some());
}

#[test]
fn a_post_ceremony_band_proof_from_the_wrong_key_is_refused() {
    let mut peer = CeremonyPeer::new();
    peer.enroll(&SigningKey::random(&mut OsRng));
    assert!(peer.session.band_verified());
    assert!(
        peer.send(&encode_frame(2, &[0x03001000], &[]).unwrap())
            .unwrap()
            .1
            .is_empty()
    );
    let forged = peer
        .band
        .trust_proof(&SigningKey::random(&mut OsRng))
        .unwrap();
    // The error is terminal, so neither the proof ack nor EndLinkSetup is written.
    assert!(peer.send(&forged).is_err());
    assert!(!peer.session.streams_enabled());
}

#[test]
fn resuming_the_ceremony_needs_a_running_ceremony() {
    let mut session = BandSession::new(None, None, false);
    SimBand::connect(&mut session).unwrap();
    assert!(
        session
            .ceremony_pair_request_completed(&[3; 71], PENDING_RECEIPT)
            .is_err()
    );
    // After `stop()` mid-ceremony the late HTTP reply is dropped quietly.
    let mut peer = CeremonyPeer::new();
    peer.send(&identity_response()).unwrap();
    peer.send(&skip_challenge_response()).unwrap();
    assert!(peer.session.stop().unwrap().is_empty());
    assert!(
        peer.session
            .ceremony_pair_request_completed(&[3; 71], PENDING_RECEIPT)
            .unwrap()
            .is_empty()
    );
}
