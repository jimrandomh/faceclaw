//! A terminal `feed` error must not lose an identity the band already accepted.

use band_core::ceremony::OwnershipCeremony;
use band_core::datax::encode_frame;
use band_core::identity::point64;
use band_core::proto::field_bytes as fb;
use band_core::session::BandSession;
use band_core::sim::SimBand;
use p256::ecdsa::SigningKey;
use rand_core::OsRng;

const SERIAL: &str = "TESTSERIAL0001";
const PENDING_RECEIPT: &str =
    r#"{"serial":"TESTSERIAL0001","receipt_type":"ServerPendingOwnershipReceipt"}"#;
const DEVICE_RECEIPT: &str =
    r#"{"receipt_type":"DevicePendingOwnershipReceipt","additional_data":"{}"}"#;
const FINAL_RECEIPT: &str = r#"{"receipt_type":"ServerFinalOwnershipReceipt"}"#;

/// Feed one record and let the band read whatever the session answered.
fn feed(session: &mut BandSession, band: &mut SimBand, frames: &[u8]) -> band_core::Result<()> {
    let record = band.encrypt(frames)?;
    let outgoing = session.feed(&record, 100.0)?.outgoing;
    band.requests(&outgoing)?;
    Ok(())
}

#[test]
fn a_failure_after_the_ownership_confirmation_keeps_the_new_identity() {
    let mut session = BandSession::new(None, Some(OwnershipCeremony::default()), false);
    let (mut band, _) = SimBand::connect(&mut session).unwrap();
    let app_point = session.ceremony().unwrap().app_public_key();
    let identity = [fb(1, &[1; 967]), fb(2, SERIAL.as_bytes()), fb(5, &[2; 889])].concat();
    feed(
        &mut session,
        &mut band,
        &encode_frame(2, &[0x02003001], &identity).unwrap(),
    )
    .unwrap();
    let nonce: Vec<u8> = (0..16).collect();
    feed(
        &mut session,
        &mut band,
        &encode_frame(2, &[0x02002001], &fb(1, &nonce)).unwrap(),
    )
    .unwrap();
    let start = session
        .ceremony_pair_request_completed(&[3; 71], PENDING_RECEIPT)
        .unwrap();
    band.requests(&start).unwrap();
    let response = [fb(1, &[4; 70]), fb(2, DEVICE_RECEIPT.as_bytes())].concat();
    feed(
        &mut session,
        &mut band,
        &encode_frame(2, &[0x02002003], &response).unwrap(),
    )
    .unwrap();
    let band_key = SigningKey::random(&mut OsRng);
    let finish = session
        .ceremony_pair_completed(
            &[5; 71],
            FINAL_RECEIPT,
            Some(&point64(band_key.verifying_key())),
        )
        .unwrap();
    band.requests(&finish).unwrap();
    assert!(session.enrollment().is_none());
    // The confirmation and a failing frame arrive in one record: feed errors.
    let confirmed = encode_frame(2, &[0x02002005], &[]).unwrap();
    let rejected = encode_frame(2, &[0x03001043], &[]).unwrap();
    assert!(feed(&mut session, &mut band, &[confirmed, rejected].concat()).is_err());
    let enrollment = session
        .enrollment()
        .expect("the confirmed identity survives the error");
    assert_eq!(enrollment.app_point(), app_point);
    assert!(session.band_verified());
}
