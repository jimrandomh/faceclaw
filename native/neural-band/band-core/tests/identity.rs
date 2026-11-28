use band_core::identity::{EnrollmentIdentity, point64, trust_digest, verifying_key_from_point64};
use p256::ecdsa::SigningKey;
use rand_core::OsRng;
use sha2::{Digest, Sha256};

#[test]
fn identity_round_trips_through_raw_bytes() {
    let key = SigningKey::random(&mut OsRng);
    let band = SigningKey::random(&mut OsRng);
    let identity = EnrollmentIdentity::new(key.clone(), Some(*band.verifying_key()));
    let private = identity.private_bytes();
    let band_x963 = identity.band_key_x963().unwrap();
    assert_eq!(band_x963.len(), 65);
    assert_eq!(band_x963[0], 4);
    let loaded = EnrollmentIdentity::from_bytes(&private, Some(&band_x963)).unwrap();
    assert_eq!(loaded.private_bytes(), private);
    assert_eq!(loaded.band_key_x963(), Some(band_x963));
    assert_eq!(loaded.app_point(), point64(key.verifying_key()));
    assert!(EnrollmentIdentity::from_bytes(&private[..31], None).is_err());
    assert!(EnrollmentIdentity::from_bytes(&private, Some(&[4; 65])).is_err());
    let compressed = SigningKey::random(&mut OsRng)
        .verifying_key()
        .to_encoded_point(true);
    assert_eq!(compressed.as_bytes().len(), 33);
    assert!(
        EnrollmentIdentity::from_bytes(&private, Some(compressed.as_bytes())).is_err(),
        "compressed points are rejected"
    );
    assert!(
        !format!("{loaded:?}").contains(&hex::encode(private)),
        "Debug never prints keys"
    );
}

#[test]
fn point64_round_trips_and_digest_matches_the_documented_formula() {
    let key = SigningKey::random(&mut OsRng);
    let point = point64(key.verifying_key());
    assert_eq!(point.len(), 64);
    assert_eq!(
        verifying_key_from_point64(&point).unwrap(),
        *key.verifying_key()
    );
    let (c, r, s, k) = ([1u8; 16], [2u8; 64], [3u8; 32], [4u8; 64]);
    let expected: [u8; 32] = Sha256::digest(
        [
            Sha256::digest([&c[..], &r[..]].concat()).as_slice(),
            Sha256::digest([&s[..], &k[..]].concat()).as_slice(),
        ]
        .concat(),
    )
    .into();
    assert_eq!(trust_digest(&c, &r, &s, &k), expected);
}
