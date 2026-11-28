mod common;

use band_core::datax::{DataXFrame, encode_frame};
use band_core::identity::{EnrollmentIdentity, point64, trust_digest};
use band_core::proto::ProtoFields;
use band_core::session::BandSession;
use band_core::sim::SimBand;
use band_core::{BandError, Result};
use common::*;
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};

/// A synthetic enrolled band (kinesis `EnrolledPeer`).
struct Enrolled {
    session: BandSession,
    band: SimBand,
    band_key: SigningKey,
}

impl Enrolled {
    fn new(band_key_in_record: bool) -> Enrolled {
        let app_key = SigningKey::random(&mut OsRng);
        let band_key = SigningKey::random(&mut OsRng);
        let identity = EnrollmentIdentity::new(
            app_key.clone(),
            band_key_in_record.then(|| *band_key.verifying_key()),
        );
        let mut session = BandSession::new(Some(identity), None, false);
        let (band, startup) = SimBand::connect(&mut session).unwrap();
        // Enrolled startup replaces the empty identity query with one EnableTrust proof.
        assert_eq!(startup.len(), 1);
        let proof = &startup[0];
        assert_eq!(proof.channel, 0x8002);
        assert_eq!(proof.words, vec![0x81000024, 0x02001000]);
        let fields = ProtoFields::parse(&proof.payload).unwrap();
        assert_eq!(
            fields.bytes(1).unwrap(),
            Sha256::digest(point64(app_key.verifying_key())).as_slice()
        );
        // Independently rebuild the transcript digest and verify the proof.
        let digest = trust_digest(
            &band.band_challenge,
            &band.transport_point,
            &band.host_seed,
            &band.host_point,
        );
        let signature = Signature::from_slice(fields.bytes_len(2, 64).unwrap()).unwrap();
        app_key
            .verifying_key()
            .verify_prehash(&digest, &signature)
            .unwrap();
        Enrolled {
            session,
            band,
            band_key,
        }
    }

    fn send(&mut self, frame: &[u8]) -> Result<Vec<DataXFrame>> {
        let record = self.band.encrypt(frame)?;
        let result = self.session.feed(&record, 100.0)?;
        self.band.requests(&result.outgoing)
    }

    fn proof(&self) -> Vec<u8> {
        self.band.trust_proof(&self.band_key).unwrap()
    }
}

fn result(code: u32) -> Vec<u8> {
    encode_frame(2, &[code], &[]).unwrap()
}

fn words(frames: &[DataXFrame]) -> Vec<Vec<u32>> {
    frames.iter().map(|frame| frame.words.clone()).collect()
}

#[test]
fn enrolled_startup_verifies_both_trust_directions_before_link_setup() {
    for proof_first in [false, true] {
        let mut peer = Enrolled::new(true);
        let end = if proof_first {
            let first = peer.send(&peer.proof()).unwrap();
            // The band proof is acknowledged at once, but link setup waits for the result.
            assert_eq!(words(&first), vec![vec![0x03001000]]);
            assert_eq!(channels(&first), vec![3]);
            let second = peer.send(&result(0x03001000)).unwrap();
            assert_eq!(second.len(), 1);
            second[0].clone()
        } else {
            assert!(peer.send(&result(0x03001000)).unwrap().is_empty());
            let second = peer.send(&peer.proof()).unwrap();
            assert_eq!(second.len(), 2);
            assert_eq!(second[0].channel, 3);
            assert_eq!(second[0].words, vec![0x03001000]);
            second[1].clone()
        };
        assert!(end.channel == 0x8001 && end.words == vec![0x02001000]);
        let end_fields = ProtoFields::parse(&end.payload).unwrap();
        assert_eq!(end_fields.integer(1).unwrap(), 1);
        assert_eq!(end_fields.bytes(2).unwrap().len(), 16);
        // The band's link-setup acknowledgement reopens the shared startup flow.
        let end_ack = peer
            .send(&encode_frame(0x8001, &[0x02001000], &ready()).unwrap())
            .unwrap();
        assert_eq!(channels(&end_ack), vec![0x8003]);
        let info = peer
            .send(&encode_frame(3, &[RPC], &device_ok()).unwrap())
            .unwrap();
        assert_eq!(channels(&info), vec![0x8005, 0x8005, 0x8006]);
        let enabled = peer
            .send(&encode_frame(5, &[RPC], &status(3)).unwrap())
            .unwrap();
        assert!(enabled.is_empty());
        assert!(peer.session.streams_enabled());
    }
}

#[test]
fn a_different_key_rejection_surfaces_the_identity_error() {
    let mut peer = Enrolled::new(true);
    match peer.send(&result(0x03001043)) {
        Err(BandError::IdentityMismatch { code, message }) => {
            assert_eq!(code, 0x1043);
            assert!(message.contains("band enrolled to a different key"));
            assert_eq!(
                BandError::IdentityMismatch {
                    code,
                    message: message.clone()
                }
                .to_string(),
                message
            );
        }
        other => panic!("expected an identity mismatch, got {other:?}"),
    }
    assert!(!peer.session.streams_enabled());
}

#[test]
fn any_other_identity_result_is_a_mismatch_too() {
    let mut peer = Enrolled::new(true);
    match peer.send(&result(0x03001044)) {
        Err(BandError::IdentityMismatch { code, .. }) => assert_eq!(code, 0x1044),
        other => panic!("expected an identity mismatch, got {other:?}"),
    }
}

#[test]
fn a_band_proof_from_the_wrong_key_is_never_acknowledged() {
    let mut peer = Enrolled::new(true);
    assert!(peer.send(&result(0x03001000)).unwrap().is_empty());
    let forged = peer
        .band
        .trust_proof(&SigningKey::random(&mut OsRng))
        .unwrap();
    assert!(peer.send(&forged).is_err());
    // The rejected proof left no acknowledgement or link setup behind.
    let retried = peer.send(&peer.proof()).unwrap();
    assert_eq!(words(&retried), vec![vec![0x03001000], vec![0x02001000]]);
}

#[test]
fn an_unverifiable_band_proof_is_accepted_when_no_band_key_is_stored() {
    let mut peer = Enrolled::new(false);
    assert!(peer.send(&result(0x03001000)).unwrap().is_empty());
    let unknown = peer
        .band
        .trust_proof(&SigningKey::random(&mut OsRng))
        .unwrap();
    let frames = peer.send(&unknown).unwrap();
    assert_eq!(words(&frames), vec![vec![0x03001000], vec![0x02001000]]);
}

#[test]
fn a_duplicate_band_proof_is_an_error() {
    let mut peer = Enrolled::new(true);
    peer.send(&peer.proof()).unwrap();
    assert!(peer.send(&peer.proof()).is_err());
}

#[test]
fn legacy_startup_never_changes_without_an_identity() {
    let peer = Peer::legacy(false, false);
    // Without an identity the legacy wire shape stays: an empty identity query
    // and EndLinkSetup, two frames instead of one EnableTrust proof.
    assert_eq!(channels(&peer.startup), vec![0x8002, 0x8001]);
    assert_eq!(peer.startup[0].words, vec![0x81000024, 0x02003000]);
    assert!(peer.startup[0].payload.is_empty());
    assert_eq!(peer.startup[1].words, vec![0x02001000]);
}
