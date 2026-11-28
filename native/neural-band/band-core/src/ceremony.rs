//! The BLE side of the one-time ownership ceremony (kinesis `OwnershipCeremony.swift`).
//!
//! Sequence: identity read (0x3000→0x3001), skip challenge (0x2000→0x2001,
//! yields the nonce), [HTTP pair_request], StartChangeOwner (0x2002→0x2003),
//! [HTTP pair], FinishChangeOwner (0x2004→0x2005). Receipts stay verbatim.

use p256::ecdsa::SigningKey;
use rand_core::OsRng;

use crate::datax::encode_frame;
use crate::error::{Result, perr};
use crate::identity::{EnrollmentIdentity, point64, verifying_key_from_point64};
use crate::proto::{ProtoFields, field_bytes};

/// How to wipe a band completely.
pub const FACTORY_RESET_HINT: &str = "hold its button for about 16 seconds";

/// What a band in pairing mode reports; sent verbatim to the ownership endpoints.
/// `Debug` prints lengths only.
#[derive(Clone, PartialEq, Eq)]
pub struct BandIdentityInfo {
    pub device_certificate: Vec<u8>,
    pub serial: String,
    pub secondary_certificate: Vec<u8>,
}

/// Input for the `pair_request` HTTP call. `Debug` prints lengths only.
#[derive(Clone, PartialEq, Eq)]
pub struct CeremonyPairRequest {
    pub identity: BandIdentityInfo,
    pub nonce: Vec<u8>,
    pub app_public_key: Vec<u8>,
}

/// Input for the `pair` HTTP call. `Debug` prints lengths only.
#[derive(Clone, PartialEq, Eq)]
pub struct CeremonyPair {
    pub receipt: String,
    pub signature: Vec<u8>,
}

impl std::fmt::Debug for BandIdentityInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BandIdentityInfo")
            .field("device_certificate_len", &self.device_certificate.len())
            .field("serial_len", &self.serial.len())
            .field(
                "secondary_certificate_len",
                &self.secondary_certificate.len(),
            )
            .finish()
    }
}

impl std::fmt::Debug for CeremonyPairRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CeremonyPairRequest")
            .field("identity", &self.identity)
            .field("nonce_len", &self.nonce.len())
            .field("app_public_key_len", &self.app_public_key.len())
            .finish()
    }
}

impl std::fmt::Debug for CeremonyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CeremonyPair")
            .field("receipt_len", &self.receipt.len())
            .field("signature_len", &self.signature.len())
            .finish()
    }
}

/// An exchange the band ceremony cannot answer by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CeremonyHttpRequest {
    PairRequest(CeremonyPairRequest),
    Pair(CeremonyPair),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    IdentityRead,
    SkipChallenge,
    StartChangeOwner,
    Pair,
    FinishChangeOwner,
    Done,
}

pub struct OwnershipCeremony {
    stage: Stage,
    /// A fresh app identity for this attempt; the caller stores it only after
    /// the band confirms the ownership change.
    app_key: SigningKey,
    identity: Option<BandIdentityInfo>,
    device_public_key: Option<Vec<u8>>,
}

impl Default for OwnershipCeremony {
    fn default() -> Self {
        Self::with_key(SigningKey::random(&mut OsRng))
    }
}

impl OwnershipCeremony {
    pub fn with_key(app_key: SigningKey) -> Self {
        Self {
            stage: Stage::IdentityRead,
            app_key,
            identity: None,
            device_public_key: None,
        }
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn app_key(&self) -> &SigningKey {
        &self.app_key
    }

    /// The raw 64-byte point of the fresh app identity public key.
    pub fn app_public_key(&self) -> Vec<u8> {
        point64(self.app_key.verifying_key())
    }

    pub fn identity(&self) -> Option<&BandIdentityInfo> {
        self.identity.as_ref()
    }

    /// The identity read that opens the identity service on channel 0x8002.
    pub fn start(&self) -> Result<Vec<u8>> {
        if self.stage != Stage::IdentityRead {
            return Err(perr("The enrollment is past its identity read"));
        }
        encode_frame(0x8002, &[0x81000024, 0x02003000], &[])
    }

    /// Parse the IdentityResponse (fields 1, 2, 5) and return SkipChallenge.
    pub fn identity_read(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        if self.stage != Stage::IdentityRead {
            return Err(perr("The band sent an unexpected identity response"));
        }
        let fields = ProtoFields::parse(payload)?;
        let certificate = fields.bytes(1)?.to_vec();
        let serial = fields.bytes(2)?;
        let secondary = fields.bytes(5)?.to_vec();
        let serial = std::str::from_utf8(serial)
            .ok()
            .filter(|serial| !serial.is_empty() && serial.is_ascii())
            .map(str::to_owned);
        let Some(serial) = serial.filter(|_| certificate.len() > 256 && secondary.len() > 256)
        else {
            return Err(perr("The band didn't report a usable identity"));
        };
        self.identity = Some(BandIdentityInfo {
            device_certificate: certificate,
            serial,
            secondary_certificate: secondary,
        });
        self.stage = Stage::SkipChallenge;
        encode_frame(0x8002, &[0x02002000], &[])
    }

    /// Parse the SkipChallengeResponse: field 1 holds the 16-byte ownership nonce.
    pub fn skip_challenge(&mut self, payload: &[u8]) -> Result<CeremonyPairRequest> {
        let identity = match (&self.stage, &self.identity) {
            (Stage::SkipChallenge, Some(identity)) => identity.clone(),
            _ => return Err(perr("The band sent an unexpected challenge response")),
        };
        let nonce = ProtoFields::parse(payload)?.bytes_len(1, 16)?.to_vec();
        self.stage = Stage::StartChangeOwner;
        Ok(CeremonyPairRequest {
            identity,
            nonce,
            app_public_key: self.app_public_key(),
        })
    }

    /// StartChangeOwner: field 1 the server's DER signature, field 2 its receipt verbatim.
    pub fn pair_request_completed(&mut self, signature: &[u8], receipt: &str) -> Result<Vec<u8>> {
        if self.stage != Stage::StartChangeOwner {
            return Err(perr("The enrollment isn't waiting for its claim"));
        }
        if signature.is_empty() || receipt.is_empty() {
            return Err(perr("The server didn't return a pending ownership receipt"));
        }
        self.stage = Stage::Pair;
        encode_frame(
            0x8002,
            &[0x02002002],
            &[
                field_bytes(1, signature),
                field_bytes(2, receipt.as_bytes()),
            ]
            .concat(),
        )
    }

    /// The band's StartChangeOwnerResponse: field 1 signature, field 2 receipt.
    pub fn start_change_owner(&mut self, payload: &[u8]) -> Result<CeremonyPair> {
        if self.stage != Stage::Pair {
            return Err(perr("The band sent an unexpected ownership response"));
        }
        let fields = ProtoFields::parse(payload)?;
        let signature = fields.bytes(1)?.to_vec();
        let receipt = String::from_utf8(fields.bytes(2)?.to_vec())
            .ok()
            .filter(|receipt| !receipt.is_empty())
            .ok_or_else(|| perr("The band didn't return its pending ownership receipt"))?;
        self.stage = Stage::FinishChangeOwner;
        Ok(CeremonyPair { receipt, signature })
    }

    /// FinishChangeOwner, same field map as StartChangeOwner. A missing device
    /// key is tolerated (the band's trust proof then stays unverified). A given
    /// key is the 64-byte `x || y` point or its 65-byte `0x04`-prefixed form.
    pub fn pair_completed(
        &mut self,
        signature: &[u8],
        receipt: &str,
        device_public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        if self.stage != Stage::FinishChangeOwner {
            return Err(perr("The enrollment isn't waiting for its final receipt"));
        }
        if signature.is_empty() || receipt.is_empty() {
            return Err(perr("The server didn't return a final ownership receipt"));
        }
        // Validate the device key before the band is asked to commit.
        let device_point = match device_public_key {
            None => None,
            Some(point) if point.len() == 64 => Some(point),
            Some(point) if point.len() == 65 && point[0] == 4 => Some(&point[1..]),
            Some(_) => return Err(perr("The server returned an invalid band key")),
        };
        if let Some(point) = device_point {
            verifying_key_from_point64(point)?;
        }
        self.device_public_key = device_point.map(<[u8]>::to_vec);
        self.stage = Stage::Done;
        encode_frame(
            0x8002,
            &[0x02002004],
            &[
                field_bytes(1, signature),
                field_bytes(2, receipt.as_bytes()),
            ]
            .concat(),
        )
    }

    /// The identity FinishChangeOwner asks the band to commit: the app key plus
    /// the validated device key, if any. `Some` once `pair_completed` succeeded.
    pub fn pending_identity(&self) -> Option<EnrollmentIdentity> {
        if self.stage != Stage::Done {
            return None;
        }
        let band_key = self
            .device_public_key
            .as_deref()
            .and_then(|point| verifying_key_from_point64(point).ok());
        Some(EnrollmentIdentity::new(self.app_key.clone(), band_key))
    }

    /// Confirm the empty FinishChangeOwnerResponse and hand back the new identity.
    /// If this errors, the caller still holds the app key via `app_key()`; the band may already have changed owner.
    pub fn complete(&self, words: &[u32], payload: &[u8]) -> Result<EnrollmentIdentity> {
        if self.stage != Stage::Done {
            return Err(perr("The enrollment isn't ready to finish"));
        }
        if words != [0x02002005] || !payload.is_empty() {
            return Err(perr("The band didn't confirm the ownership change"));
        }
        let band_key = match &self.device_public_key {
            Some(point) if point.len() == 64 => Some(verifying_key_from_point64(point)?),
            _ => None,
        };
        Ok(EnrollmentIdentity::new(self.app_key.clone(), band_key))
    }
}

/// The reference error map for identity-service result codes.
pub fn failure_message(code: u32) -> String {
    match code {
        0x1040 => "the band rejected the ownership receipt.".into(),
        0x1041 => "the band rejected the ownership challenge.".into(),
        0x1042 => format!(
            "this band belongs to a different meta account. sign in with that account, or factory reset the band ({FACTORY_RESET_HINT}) to claim it with this one."
        ),
        0x1043 => "the band rejected this app's identity.".into(),
        0x1044 => "the band rejected a signature.".into(),
        0x1045 => "the band rejected the receipt timing.".into(),
        0xd001 | 0xd004 | 0xd021 => "the band couldn't read the ownership request.".into(),
        0xc001 => "the band has no identity service.".into(),
        0xc004 => "the band couldn't parse the ownership request.".into(),
        _ => format!("the band reported an ownership error ({code:x})."),
    }
}
