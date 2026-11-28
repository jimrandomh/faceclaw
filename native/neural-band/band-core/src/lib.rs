//! Sans-IO protocol core for the Meta Neural Band.
//!
//! Ported from callbacked/kinesis `Sources/KinesisCore` (MIT). Callers feed
//! received bytes plus a monotonic time in seconds and get outgoing bytes and
//! typed events back; nothing here touches sockets, clocks or files.

pub mod airshield;
pub mod ceremony;
pub mod datax;
pub mod dial;
pub mod error;
pub mod events;
pub mod gestures;
pub mod handwriting;
pub mod identity;
pub mod model_capture;
pub mod pointer;
pub mod proto;
pub mod responder;
pub mod session;
pub mod sim;

pub use error::{BandError, Result};
