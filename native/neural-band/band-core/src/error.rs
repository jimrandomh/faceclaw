use thiserror::Error;

/// Every failure the protocol core can report. Messages are user-facing and
/// never contain key material.
///
/// `Protocol` / `IdentityMismatch` / `OwnershipRejected` returned from
/// `BandSession::feed` end the session. `Busy` means a request was refused and
/// the session is fine.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BandError {
    #[error("{0}")]
    Protocol(String),
    /// The band rejected our stored owner identity (kinesis `BandIdentityMismatchError`)
    /// with an identity-service result word `0x03xxxxxx` on channel 2; `code` is
    /// its low 24 bits. Only `0x1043` ("enrolled to a different key") proves the
    /// band does not accept this key; other codes may be transient.
    #[error("{message}")]
    IdentityMismatch { code: u32, message: String },
    /// The band refused a step of the ownership ceremony with an identity-service
    /// result word `0x03xxxxxx`; `code` is its low 24 bits and `message` the
    /// user-facing text for it. `0x1042` means the band belongs to a different
    /// Meta account: offer to sign in with that account (or a factory reset).
    /// Terminal for the session, like `Protocol`.
    #[error("{message}")]
    OwnershipRejected { code: u32, message: String },
    /// A request was refused because the session isn't ready or another
    /// change is in flight; the session itself is unaffected.
    #[error("{0}")]
    Busy(String),
}

pub type Result<T> = std::result::Result<T, BandError>;

pub(crate) fn perr(message: impl Into<String>) -> BandError {
    BandError::Protocol(message.into())
}
