//! What the app shows: the controller's view of the band (adapted from
//! air-gestures' daemon status; the link state is added by `Connection`).

use serde::Serialize;

use crate::config::DialTarget;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// Controls are off (the link can still be up).
    pub paused: bool,
    pub battery: Option<u8>,
    pub charging: Option<bool>,
    /// "left" or "right" as confirmed by the band.
    pub hand: Option<String>,
    #[serde(serialize_with = "dial_name")]
    pub dial: DialTarget,
    pub last_gesture: Option<String>,
    pub last_action: Option<String>,
    /// Recognized gestures this connection.
    pub gestures: u64,
}

fn dial_name<S: serde::Serializer>(dial: &DialTarget, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(dial.name())
}
