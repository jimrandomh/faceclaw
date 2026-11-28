//! The owner identity that proves this host owns the band (kinesis `BandIdentity.swift`).
//! Persistence is the caller's job; this module only converts to and from bytes.

use p256::ecdsa::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::error::{Result, perr};

/// The raw 64-byte `x || y` point of a P-256 public key (SEC1 uncompressed minus `0x04`).
pub fn point64(key: &VerifyingKey) -> Vec<u8> {
    key.to_encoded_point(false).as_bytes()[1..].to_vec()
}

pub fn verifying_key_from_point64(point: &[u8]) -> Result<VerifyingKey> {
    if point.len() != 64 {
        return Err(perr("Invalid P-256 public key"));
    }
    VerifyingKey::from_sec1_bytes(&[&[4u8][..], point].concat())
        .map_err(|_| perr("Invalid P-256 public key"))
}

/// `SHA256(SHA256(receiver challenge || receiver key) || SHA256(sender seed || sender key))`.
pub fn trust_digest(challenge: &[u8], receiver: &[u8], seed: &[u8], sender: &[u8]) -> [u8; 32] {
    let first = Sha256::digest([challenge, receiver].concat());
    let second = Sha256::digest([seed, sender].concat());
    Sha256::digest([first.as_slice(), second.as_slice()].concat()).into()
}

/// The app key that signs `EnableTrust`, plus the band's own identity key when
/// known (then the band's `EnableTrustEC` proof is verified before it is acknowledged).
#[derive(Clone)]
pub struct EnrollmentIdentity {
    pub private_key: SigningKey,
    pub band_public_key: Option<VerifyingKey>,
}

impl std::fmt::Debug for EnrollmentIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnrollmentIdentity")
            .field("band_public_key", &self.band_public_key.is_some())
            .finish_non_exhaustive()
    }
}

impl EnrollmentIdentity {
    pub fn new(private_key: SigningKey, band_public_key: Option<VerifyingKey>) -> Self {
        Self {
            private_key,
            band_public_key,
        }
    }

    /// `private` is the raw 32-byte scalar; `band_x963` the 65-byte SEC1 point.
    pub fn from_bytes(private: &[u8], band_x963: Option<&[u8]>) -> Result<Self> {
        if private.len() != 32 {
            return Err(perr("Stored owner key is not 32 bytes"));
        }
        let private_key =
            SigningKey::from_slice(private).map_err(|_| perr("Stored owner key is invalid"))?;
        let band_public_key = match band_x963 {
            Some(bytes) if bytes.len() != 65 => return Err(perr("Stored band key is invalid")),
            Some(bytes) => Some(
                VerifyingKey::from_sec1_bytes(bytes)
                    .map_err(|_| perr("Stored band key is invalid"))?,
            ),
            None => None,
        };
        Ok(Self {
            private_key,
            band_public_key,
        })
    }

    pub fn private_bytes(&self) -> [u8; 32] {
        self.private_key.to_bytes().into()
    }

    pub fn band_key_x963(&self) -> Option<Vec<u8>> {
        self.band_public_key
            .map(|key| key.to_encoded_point(false).as_bytes().to_vec())
    }

    pub fn app_point(&self) -> Vec<u8> {
        point64(self.private_key.verifying_key())
    }
}
