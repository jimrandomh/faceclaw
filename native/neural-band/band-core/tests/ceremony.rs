use band_core::ceremony::{OwnershipCeremony, Stage, failure_message};
use band_core::datax::encode_frame;
use band_core::identity::point64;
use band_core::proto::field_bytes as fb;
use p256::ecdsa::SigningKey;
use rand_core::OsRng;

const SERIAL: &str = "TESTSERIAL0001";
const PENDING_RECEIPT: &str =
    r#"{"serial":"TESTSERIAL0001","receipt_type":"ServerPendingOwnershipReceipt"}"#;
const DEVICE_RECEIPT: &str =
    r#"{"receipt_type":"DevicePendingOwnershipReceipt","additional_data":"{}"}"#;
const FINAL_RECEIPT: &str = r#"{"receipt_type":"ServerFinalOwnershipReceipt"}"#;

fn nonce() -> Vec<u8> {
    (0..16).collect()
}
fn pending_signature() -> Vec<u8> {
    [vec![0x30, 0x45, 0x02, 0x20], vec![3; 67]].concat()
}
fn device_signature() -> Vec<u8> {
    [vec![0x30, 0x46, 0x02, 0x21], vec![4; 66]].concat()
}
fn final_signature() -> Vec<u8> {
    [vec![0x30, 0x45, 0x02, 0x21], vec![5; 67]].concat()
}
fn identity_response_payload() -> Vec<u8> {
    [fb(1, &[1; 967]), fb(2, SERIAL.as_bytes()), fb(5, &[2; 889])].concat()
}
/// The captured response payload is exactly 0a10 followed by the 16-byte nonce.
fn skip_challenge_payload(nonce: &[u8]) -> Vec<u8> {
    [vec![0x0a, nonce.len() as u8], nonce.to_vec()].concat()
}

fn at_pair_stage() -> OwnershipCeremony {
    let mut ceremony = OwnershipCeremony::default();
    ceremony
        .identity_read(&identity_response_payload())
        .unwrap();
    ceremony
        .skip_challenge(&skip_challenge_payload(&nonce()))
        .unwrap();
    ceremony
        .pair_request_completed(&pending_signature(), PENDING_RECEIPT)
        .unwrap();
    ceremony
}

#[test]
fn ceremony_start_opens_the_identity_service_like_the_captured_sequence() {
    let mut ceremony = OwnershipCeremony::default();
    assert_eq!(
        ceremony.start().unwrap(),
        encode_frame(0x8002, &[0x81000024, 0x02003000], &[]).unwrap()
    );
    let skip = ceremony
        .identity_read(&identity_response_payload())
        .unwrap();
    assert_eq!(skip, encode_frame(0x8002, &[0x02002000], &[]).unwrap());
    let identity = ceremony.identity().unwrap();
    assert_eq!(identity.device_certificate, vec![1; 967]);
    assert_eq!(identity.serial, SERIAL);
    assert_eq!(identity.secondary_certificate, vec![2; 889]);
    assert!(
        ceremony.start().is_err(),
        "start only runs before the identity read"
    );
}

#[test]
fn the_nonce_parser_accepts_exactly_sixteen_bytes() {
    let mut ceremony = OwnershipCeremony::default();
    ceremony
        .identity_read(&identity_response_payload())
        .unwrap();
    let short: Vec<u8> = (0..15).collect();
    assert!(
        ceremony
            .skip_challenge(&skip_challenge_payload(&short))
            .is_err()
    );
    let request = ceremony
        .skip_challenge(&skip_challenge_payload(&nonce()))
        .unwrap();
    assert_eq!(request.nonce, nonce());
    assert_eq!(request.identity.serial, SERIAL);
    assert_eq!(request.app_public_key, ceremony.app_public_key());
    assert_eq!(request.app_public_key.len(), 64);
}

#[test]
fn ceremony_builders_match_the_captured_start_change_owner_frame_layout() {
    let mut ceremony = OwnershipCeremony::default();
    ceremony
        .identity_read(&identity_response_payload())
        .unwrap();
    ceremony
        .skip_challenge(&skip_challenge_payload(&nonce()))
        .unwrap();
    let start = ceremony
        .pair_request_completed(&pending_signature(), PENDING_RECEIPT)
        .unwrap();
    let expected = encode_frame(
        0x8002,
        &[0x02002002],
        &[
            fb(1, &pending_signature()),
            fb(2, PENDING_RECEIPT.as_bytes()),
        ]
        .concat(),
    )
    .unwrap();
    assert_eq!(start, expected);
    // Field 1 is a 71-byte DER signature introduced by 0a 47, then field 2.
    let payload = &start[8..];
    assert_eq!(&payload[..4], &[0x0a, 0x47, 0x30, 0x45]);
    assert_eq!(payload[73], 0x12);
    // A 1777-byte receipt's length varint is the three bytes f1 0d.
    let long_receipt = "x".repeat(1777);
    let mut long = OwnershipCeremony::default();
    long.identity_read(&identity_response_payload()).unwrap();
    long.skip_challenge(&skip_challenge_payload(&nonce()))
        .unwrap();
    let frame = long
        .pair_request_completed(&pending_signature(), &long_receipt)
        .unwrap();
    let payload = &frame[8..];
    assert_eq!(&payload[74..=75], &[0xf1, 0x0d]);
    assert_eq!(&payload[76..], long_receipt.as_bytes());
}

#[test]
fn start_change_owner_responses_carry_signature_then_receipt_verbatim() {
    let mut ceremony = at_pair_stage();
    let pair = ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    assert_eq!(pair.signature, device_signature());
    assert_eq!(pair.receipt, DEVICE_RECEIPT);
    assert_eq!(ceremony.stage(), Stage::FinishChangeOwner);
}

#[test]
fn finish_change_owner_uses_the_captured_field_map_and_complete_returns_the_identity() {
    let mut ceremony = at_pair_stage();
    ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    let band_key = SigningKey::random(&mut OsRng);
    let band_point = point64(band_key.verifying_key());
    let finish = ceremony
        .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&band_point))
        .unwrap();
    let expected = encode_frame(
        0x8002,
        &[0x02002004],
        &[fb(1, &final_signature()), fb(2, FINAL_RECEIPT.as_bytes())].concat(),
    )
    .unwrap();
    assert_eq!(finish, expected);
    assert!(
        ceremony.complete(&[0x02002005], &[1]).is_err(),
        "the confirmation must be empty"
    );
    assert!(ceremony.complete(&[0x02002004], &[]).is_err());
    let identity = ceremony.complete(&[0x02002005], &[]).unwrap();
    assert_eq!(
        identity.private_bytes(),
        <[u8; 32]>::from(ceremony.app_key().to_bytes())
    );
    assert_eq!(identity.band_public_key, Some(*band_key.verifying_key()));
}

#[test]
fn a_missing_device_key_leaves_the_band_proof_unverified() {
    let mut ceremony = at_pair_stage();
    ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    ceremony
        .pair_completed(&final_signature(), FINAL_RECEIPT, None)
        .unwrap();
    assert!(
        ceremony
            .complete(&[0x02002005], &[])
            .unwrap()
            .band_public_key
            .is_none()
    );
}

#[test]
fn ceremony_steps_reject_out_of_order_responses() {
    let mut ceremony = OwnershipCeremony::default();
    assert!(
        ceremony
            .skip_challenge(&skip_challenge_payload(&nonce()))
            .is_err()
    );
    assert!(
        ceremony
            .pair_request_completed(&pending_signature(), PENDING_RECEIPT)
            .is_err()
    );
    ceremony
        .identity_read(&identity_response_payload())
        .unwrap();
    let short: Vec<u8> = (0..15).collect();
    assert!(
        ceremony
            .skip_challenge(&skip_challenge_payload(&short))
            .is_err()
    );
    assert!(
        ceremony
            .pair_request_completed(&pending_signature(), PENDING_RECEIPT)
            .is_err()
    );
    ceremony
        .skip_challenge(&skip_challenge_payload(&nonce()))
        .unwrap();
    assert!(
        ceremony
            .pair_request_completed(&[], PENDING_RECEIPT)
            .is_err(),
        "empty signature"
    );
    ceremony
        .pair_request_completed(&pending_signature(), PENDING_RECEIPT)
        .unwrap();
    assert_eq!(
        failure_message(0x1042),
        "this band belongs to a different meta account. sign in with that account, or factory reset the band (hold its button for about 16 seconds) to claim it with this one."
    );
    assert!(failure_message(0x1044).contains("signature"));
    assert!(failure_message(0x1043).contains("identity"));
    assert_eq!(
        failure_message(0xbeef),
        "the band reported an ownership error (beef)."
    );
}

#[test]
fn identity_read_rejects_short_certificates_and_empty_serials() {
    let mut ceremony = OwnershipCeremony::default();
    let short = [fb(1, &[1; 200]), fb(2, SERIAL.as_bytes()), fb(5, &[2; 889])].concat();
    assert!(ceremony.identity_read(&short).is_err());
    let no_serial = [fb(1, &[1; 967]), fb(2, b""), fb(5, &[2; 889])].concat();
    assert!(ceremony.identity_read(&no_serial).is_err());
}

#[test]
fn an_invalid_device_key_fails_before_the_band_commits() {
    let mut ceremony = at_pair_stage();
    ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    assert!(
        ceremony
            .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&[0xff; 64]))
            .is_err()
    );
    assert_eq!(ceremony.stage(), Stage::FinishChangeOwner);
}

#[test]
fn a_prefixed_device_key_is_accepted_and_other_lengths_are_rejected() {
    let mut ceremony = at_pair_stage();
    ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    let band_key = SigningKey::random(&mut OsRng);
    let x963 = [vec![4u8], point64(band_key.verifying_key())].concat();
    assert!(
        ceremony
            .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&x963[..33]))
            .is_err()
    );
    assert!(
        ceremony
            .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&[0u8; 0]))
            .is_err()
    );
    let mut wrong_prefix = x963.clone();
    wrong_prefix[0] = 2;
    assert!(
        ceremony
            .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&wrong_prefix))
            .is_err()
    );
    assert_eq!(ceremony.stage(), Stage::FinishChangeOwner);
    ceremony
        .pair_completed(&final_signature(), FINAL_RECEIPT, Some(&x963))
        .unwrap();
    let identity = ceremony.complete(&[0x02002005], &[]).unwrap();
    assert_eq!(identity.band_public_key, Some(*band_key.verifying_key()));
}

#[test]
fn ceremony_debug_never_prints_receipts() {
    let mut ceremony = at_pair_stage();
    let pair = ceremony
        .start_change_owner(
            &[fb(1, &device_signature()), fb(2, DEVICE_RECEIPT.as_bytes())].concat(),
        )
        .unwrap();
    let text = format!("{:?}", pair);
    assert!(!text.contains(DEVICE_RECEIPT), "{text}");
    assert!(text.contains("receipt_len"), "{text}");
}
