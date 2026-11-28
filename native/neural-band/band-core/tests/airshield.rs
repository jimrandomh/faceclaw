use band_core::airshield::{AirShieldCipher, AirShieldKeys, AirShieldReceiver};

fn seq(range: std::ops::Range<u8>) -> Vec<u8> {
    range.collect()
}

fn fixed_keys() -> AirShieldKeys {
    AirShieldKeys::fixed(
        seq(0..32).try_into().unwrap(),
        seq(0..32).try_into().unwrap(),
    )
}

fn iv() -> [u8; 16] {
    seq(0..16).try_into().unwrap()
}

const FIRST: &str =
    "40c9f748fb0f0ae8e0018675352ee743a1e58ccd288d25d27f6e72551887e4aad6fc68175e7287a1eee1";
const SECOND: &str = "4038cb0decaa0692b900d5962230f8734c8a3de4d262936261f1";

#[test]
fn key_derivation_matches_the_independent_python_vector() {
    let keys = AirShieldKeys::derive(&seq(0..32), &seq(0..16), &seq(32..64)).unwrap();
    assert_eq!(
        hex::encode(keys.encryption),
        "5080496832e72e0a4de90f22e7797a3c6277197b4bd29f296bd7142850db1998"
    );
    assert_eq!(keys.mac, keys.encryption);
    assert!(AirShieldKeys::derive(&seq(0..31), &seq(0..16), &seq(32..64)).is_err());
}

#[test]
fn receiver_decrypts_split_records_and_skips_control_markers() {
    let first = hex::decode(FIRST).unwrap();
    let second = hex::decode(SECOND).unwrap();
    let mut receiver = AirShieldReceiver::new(AirShieldCipher::new(fixed_keys(), iv(), u32::MAX));
    let wire = [
        first.clone(),
        vec![0x81, 0, 1, 2, 42, 43, 44],
        second.clone(),
    ]
    .concat();
    let mut decoded = Vec::new();
    for byte in &wire {
        decoded.extend(receiver.feed(&[*byte]).unwrap());
    }
    receiver.finish().unwrap();
    assert_eq!(
        decoded,
        vec![
            b"first block.....second block....".to_vec(),
            b"last block......".to_vec()
        ]
    );
    assert_eq!(receiver.cipher.counter, 1, "the counter wraps");

    let mut sender = AirShieldCipher::new(fixed_keys(), iv(), u32::MAX);
    assert_eq!(sender.encrypt(&decoded[0]).unwrap(), first);
    assert_eq!(sender.encrypt(&decoded[1]).unwrap(), second);
}

#[test]
fn tampered_packets_are_rejected_before_any_state_changes() {
    let first = hex::decode(FIRST).unwrap();
    for index in [1usize, 12] {
        let mut corrupted = first.clone();
        corrupted[index] ^= 1;
        let mut bad = AirShieldReceiver::new(AirShieldCipher::new(fixed_keys(), iv(), u32::MAX));
        assert!(bad.feed(&corrupted).is_err());
        assert_eq!(bad.cipher.counter, u32::MAX);
        assert_eq!(bad.cipher.iv, iv());
    }
    let mut truncated = AirShieldReceiver::new(AirShieldCipher::new(fixed_keys(), iv(), u32::MAX));
    assert!(
        truncated
            .feed(&first[..first.len() - 1])
            .unwrap()
            .is_empty()
    );
    assert!(truncated.finish().is_err());
    let mut unknown = AirShieldReceiver::new(AirShieldCipher::new(fixed_keys(), iv(), 0));
    assert!(unknown.feed(&[0x55]).is_err(), "unknown transport marker");
}

#[test]
fn encrypt_rejects_empty_and_oversized_frames() {
    let mut sender = AirShieldCipher::new(fixed_keys(), iv(), 0);
    assert!(sender.encrypt(&[]).is_err());
    assert!(sender.encrypt(&vec![0; 4097]).is_err());
    assert!(sender.encrypt(&vec![0; 4096]).is_ok());
}

/// Scheme 31's published vectors (zhuowei/Starcruiser-mac `key_derivation_test.swift`):
/// raw-secret HKDF, a separate "hmac_derive" MAC key and the `02 02 00 00` MAC prefix.
#[test]
fn scheme_31_matches_the_public_vectors() {
    use band_core::airshield::{AirShieldCipher, AirShieldKeys, SCHEME_31};
    let secret =
        hex::decode("f2f6f1f1a56fb52122ec338ed887338b42b976290253dbd6f48f3cc0b15b2ba8").unwrap();
    let rx = AirShieldKeys::derive_variant(
        SCHEME_31,
        &secret,
        &hex::decode("c75051fb3e50142ba10c15a023777c6b").unwrap(),
        &[b'A'; 32],
    )
    .unwrap();
    assert_eq!(
        hex::encode(rx.encryption),
        "d70b81653601bbc46f13c6749324fa2b680af0064592a2c663a0891d7a43875d"
    );
    let tx = AirShieldKeys::derive_variant(
        SCHEME_31,
        &secret,
        b"0123456789abcdef",
        &hex::decode("c58e0f4bf291a0b2f50a40955b0bd53c9c7fd5a9f5fdbf7b14272efed585ca14").unwrap(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(tx.encryption),
        "2f72596312c1120bf869dd69b0c6b4aa6cc05981723a45a4bb294343a11793cc"
    );
    // The packet's MAC checks out (counter 0xba8d8b80); its IV isn't published,
    // so only the tag is compared — a MAC failure would be the first error.
    let packet = hex::decode("40f4d00bc5a22d9ecd0055ff7a63ea6ac9f1723721ffa9d7f4a7").unwrap();
    let mut cipher = AirShieldCipher::new(tx, [0; 16], 0xba8d8b80);
    let result = cipher.decrypt(&packet);
    assert!(
        !matches!(&result, Err(error) if error.to_string().contains("authentication")),
        "{result:?}"
    );
}
