//! AirShield transport encryption (kinesis `AirShield.swift`).
//!
//! Record: `0x40 | HMAC-SHA256(counter_le || body)[..8] | body`, where
//! `body = (blocks - 1) as u8 || AES-256-CBC(frame padded with 0xc0+n)`.
//! The IV chains from the previous ciphertext block and the counter wraps.

use aes::Aes256;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::NoPadding};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::error::{Result, perr};

#[derive(Clone)]
pub struct AirShieldKeys {
    pub encryption: [u8; 32],
    pub mac: [u8; 32],
    /// Bytes the MAC covers before the counter (`02 02 00 00` for scheme 31).
    pub mac_prefix: &'static [u8],
    /// Pad a block-aligned frame with a whole block, as newer firmware does
    /// (scheme 3 sends aligned frames unpadded).
    pub pad_aligned: bool,
}

/// Where a scheme's MAC key comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacKey {
    /// The encryption key itself (scheme 3).
    Encryption,
    /// `HKDF(S, salt: SHA256(R || C || "hmac_derive"))` (scheme 31).
    Derived,
    /// `HKDF(H, salt: SHA256(R || C || "hmac_derive" || H))` (scheme 7 notes).
    DerivedHashed,
}

/// One way of turning the ECDH secret into record keys. Schemes 3 (band) and
/// 31 (glasses) are verified on hardware; newer band firmware negotiates 26,
/// whose rules are unknown, so pairing tries `SCHEME_26_GUESSES` in turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Variant {
    /// HKDF input `H = SHA256(S)` with salt `SHA256(H || C || R)` (scheme 3),
    /// else `S` with salt `SHA256(C || R)` (scheme 31).
    pub hashed_secret: bool,
    pub mac_key: MacKey,
    /// The MAC covers `02 02 00 00` first (scheme 31).
    pub mac_prefix: bool,
    /// The scheme number our EnableEncryption names.
    pub announce: u64,
}

pub const SCHEME_3: Variant = Variant {
    hashed_secret: true,
    mac_key: MacKey::Encryption,
    mac_prefix: false,
    announce: 3,
};

pub const SCHEME_31: Variant = Variant {
    hashed_secret: false,
    mac_key: MacKey::Derived,
    mac_prefix: true,
    announce: 31,
};

const fn guess(hashed_secret: bool, mac_key: MacKey, mac_prefix: bool) -> Variant {
    Variant {
        hashed_secret,
        mac_key,
        mac_prefix,
        announce: 26,
    }
}

/// Candidates for scheme 26 (0b11010: 31 without bits 0 and 2), likeliest
/// first. Bit 2 is what separates the notes' 7 from 3 (a derived MAC key), so
/// 26 probably shares 31's key derivation and prefix but keeps the encryption
/// key as its MAC key.
pub const SCHEME_26_GUESSES: [Variant; 8] = [
    guess(false, MacKey::Encryption, true),
    guess(false, MacKey::Derived, true),
    guess(true, MacKey::Encryption, false),
    guess(false, MacKey::Encryption, false),
    guess(true, MacKey::Encryption, true),
    guess(false, MacKey::Derived, false),
    guess(true, MacKey::DerivedHashed, false),
    guess(true, MacKey::DerivedHashed, true),
];

fn hkdf(ikm: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(b"AirShield", &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

impl std::fmt::Debug for AirShieldKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AirShieldKeys { .. }")
    }
}

impl AirShieldKeys {
    /// Parameter-3 key derivation, the only one verified on this band:
    /// `hashed = SHA256(secret)`, `key = HKDF-SHA256(ikm: hashed,
    /// salt: SHA256(hashed || challenge || seed), info: "AirShield", 32)`.
    pub fn derive(secret: &[u8], challenge: &[u8], seed: &[u8]) -> Result<Self> {
        Self::derive_variant(SCHEME_3, secret, challenge, seed)
    }

    /// Keys for one direction: `challenge` is the receiver's RequestEncryption
    /// challenge (C), `seed` the sender's EnableEncryption seed (R).
    pub fn derive_variant(
        variant: Variant,
        secret: &[u8],
        challenge: &[u8],
        seed: &[u8],
    ) -> Result<Self> {
        if secret.len() != 32 || challenge.len() != 16 || seed.len() != 32 {
            return Err(perr("Invalid AirShield key material"));
        }
        let hashed = Sha256::digest(secret);
        let encryption = if variant.hashed_secret {
            hkdf(
                &hashed,
                &Sha256::digest([hashed.as_slice(), challenge, seed].concat()),
            )
        } else {
            hkdf(secret, &Sha256::digest([challenge, seed].concat()))
        };
        let mac = match variant.mac_key {
            MacKey::Encryption => encryption,
            MacKey::Derived => hkdf(
                secret,
                &Sha256::digest([seed, challenge, b"hmac_derive"].concat()),
            ),
            MacKey::DerivedHashed => hkdf(
                &hashed,
                &Sha256::digest([seed, challenge, b"hmac_derive", hashed.as_slice()].concat()),
            ),
        };
        Ok(Self {
            encryption,
            mac,
            mac_prefix: if variant.mac_prefix {
                &[2, 2, 0, 0]
            } else {
                &[]
            },
            pad_aligned: variant.announce != 3,
        })
    }

    pub fn fixed(encryption: [u8; 32], mac: [u8; 32]) -> Self {
        Self {
            encryption,
            mac,
            mac_prefix: &[],
            pad_aligned: false,
        }
    }
}

pub struct AirShieldCipher {
    keys: AirShieldKeys,
    pub iv: [u8; 16],
    pub counter: u32,
}

impl AirShieldCipher {
    pub fn new(keys: AirShieldKeys, iv: [u8; 16], counter: u32) -> Self {
        Self { keys, iv, counter }
    }

    fn tag(&self, body: &[u8]) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.keys.mac)
            .expect("HMAC accepts any key length");
        mac.update(self.keys.mac_prefix);
        mac.update(&self.counter.to_le_bytes());
        mac.update(body);
        mac.finalize().into_bytes().into()
    }

    pub fn encrypt(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        let count = match 16 - frame.len() % 16 {
            16 if !self.keys.pad_aligned => 0,
            count => count,
        };
        let mut padded = frame.to_vec();
        padded.extend(std::iter::repeat_n(0xc0 + count as u8, count));
        if padded.is_empty() || padded.len() > 4096 {
            return Err(perr("AirShield frame too large"));
        }
        let ciphertext = cbc::Encryptor::<Aes256>::new_from_slices(&self.keys.encryption, &self.iv)
            .expect("AES-256 key and 16-byte IV")
            .encrypt_padded_vec_mut::<NoPadding>(&padded);
        let mut body = Vec::with_capacity(ciphertext.len() + 1);
        body.push((ciphertext.len() / 16 - 1) as u8);
        body.extend_from_slice(&ciphertext);
        let tag = self.tag(&body);
        self.iv
            .copy_from_slice(&ciphertext[ciphertext.len() - 16..]);
        self.counter = self.counter.wrapping_add(1);
        let mut packet = Vec::with_capacity(body.len() + 9);
        packet.push(0x40);
        packet.extend_from_slice(&tag[..8]);
        packet.extend(body);
        Ok(packet)
    }

    /// Verifies the MAC over every byte before decrypting; no unauthenticated
    /// plaintext leaves this type and a failure leaves IV and counter untouched.
    pub fn decrypt(&mut self, packet: &[u8]) -> Result<Vec<u8>> {
        if packet.len() < 10 {
            return Err(perr("Truncated AirShield packet"));
        }
        let expected = self.tag(&packet[9..]);
        let difference = expected[..8]
            .iter()
            .zip(&packet[1..9])
            .fold(0u8, |acc, (a, b)| acc | (a ^ b));
        if difference != 0 {
            return Err(perr("Band packet authentication failed"));
        }
        let ciphertext = &packet[10..];
        if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
            return Err(perr("Invalid AES block shape"));
        }
        let plaintext = cbc::Decryptor::<Aes256>::new_from_slices(&self.keys.encryption, &self.iv)
            .expect("AES-256 key and 16-byte IV")
            .decrypt_padded_vec_mut::<NoPadding>(ciphertext)
            .map_err(|_| perr("AES operation failed"))?;
        self.iv
            .copy_from_slice(&ciphertext[ciphertext.len() - 16..]);
        self.counter = self.counter.wrapping_add(1);
        Ok(plaintext)
    }
}

/// Splits the L2CAP byte stream into AirShield records. `0x81/0x82 xx`
/// (xx ≤ 1) and `0x01/0x02 len …` control markers are skipped; `0x41/0x42`
/// relay records are skipped unread; `0x40` records are authenticated and
/// decrypted.
pub struct AirShieldReceiver {
    pub cipher: AirShieldCipher,
    pending: Vec<u8>,
    /// Skipped records, described for the log (drained by the session).
    pub skipped: Vec<String>,
}

impl AirShieldReceiver {
    pub fn new(cipher: AirShieldCipher) -> Self {
        Self {
            cipher,
            pending: Vec::new(),
            skipped: Vec::new(),
        }
    }

    /// An error leaves the offending bytes pending; treat it as fatal for the
    /// connection and drop the receiver.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.pending.extend_from_slice(bytes);
        let mut plaintext = Vec::new();
        while let Some(&marker) = self.pending.first() {
            let short_control = marker == 0x81 || marker == 0x82;
            if short_control && self.pending.len() >= 2 && self.pending[1] <= 1 {
                self.skipped.push(format!(
                    "control record {marker:02x} {:02x}",
                    self.pending[1]
                ));
                self.pending.drain(..2);
                continue;
            }
            if marker == 0x01 || marker == 0x02 {
                if self.pending.len() < 2 {
                    break;
                }
                let size = 3 + usize::from(self.pending[1]);
                if self.pending.len() < size {
                    break;
                }
                self.skipped.push(format!(
                    "relay record on channel {marker}, {} bytes",
                    size - 3
                ));
                self.pending.drain(..size);
                continue;
            }
            if short_control && self.pending.len() < 2 {
                break;
            }
            if !(0x40..=0x42).contains(&marker) {
                return Err(perr("Unsupported band transport marker"));
            }
            if self.pending.len() < 10 {
                break;
            }
            let size = 10 + (usize::from(self.pending[9]) + 1) * 16;
            if self.pending.len() < size {
                break;
            }
            if marker == 0x40 {
                let packet = self.pending[..size].to_vec();
                plaintext.push(self.cipher.decrypt(&packet)?);
            } else {
                self.skipped
                    .push(format!("encrypted relay record {marker:02x}, {size} bytes"));
            }
            self.pending.drain(..size);
        }
        Ok(plaintext)
    }

    pub fn finish(&self) -> Result<()> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(perr("Truncated AirShield packet"))
        }
    }
}
