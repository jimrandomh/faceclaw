//! Typed values the session reports (kinesis `Gestures.swift` BandEvent/BandGesture,
//! `EMGReadings.swift`, `BandBatteryStatus.swift`).

use crate::ceremony::CeremonyHttpRequest;
use crate::error::{Result, perr};
use crate::identity::EnrollmentIdentity;
use crate::model_capture::CaptureStatus;
use crate::proto::ProtoFields;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Hand {
    Right,
    Left,
}

/// One recognized-gesture message as the band sent it. Names come from the
/// band's enum tables; unknown values read `unrecognized:<n>`.
/// Sensor data must not be logged verbatim.
#[derive(Debug, Clone, PartialEq)]
pub struct GestureMessage {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub finger: String,
    pub action: String,
    pub derived_action: String,
    pub synthetic: bool,
    /// Host monotonic time (seconds) the message was decoded at.
    pub received_at: f64,
}

/// `BatteryInfoResp.batteryData`: level 0–100 and an optional charging flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatteryStatus {
    pub level: u8,
    pub charging: Option<bool>,
}

impl BatteryStatus {
    pub fn from_response(response: &[u8]) -> Result<Self> {
        let rpc = ProtoFields::parse(response)?;
        if rpc.required_integer(2)? != 1 {
            return Err(perr("Battery status unavailable"));
        }
        let inner = ProtoFields::parse(rpc.bytes(3)?)?;
        let battery = ProtoFields::parse(inner.bytes(1)?)?;
        let level = battery.required_integer(1)?;
        if level > 100 {
            return Err(perr("Invalid battery level"));
        }
        let charging = if battery.contains(2) {
            let value = battery.required_integer(2)?;
            if value > 1 {
                return Err(perr("Invalid charging flag"));
            }
            Some(value == 1)
        } else {
            None
        };
        Ok(Self {
            level: level as u8,
            charging,
        })
    }
}

/// Dimensions from the band's `Config.emg` field. ADC calibration is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmgConfig {
    pub sample_rate: u64,
    pub channels: u64,
    pub adc_bits: u64,
    pub samples_per_batch: u64,
    pub encoding: u64,
}

impl EmgConfig {
    pub fn from_response(response: &[u8]) -> Result<Self> {
        let response = ProtoFields::parse(response)?;
        if response.required_integer(2)? != 1 {
            return Err(perr("The band rejected the EMG configuration read."));
        }
        let config = ProtoFields::parse(response.bytes(6)?)?;
        let emg = ProtoFields::parse(config.bytes(42)?)?;
        Ok(Self {
            sample_rate: emg.required_integer(1)?,
            channels: emg.required_integer(2)?,
            adc_bits: emg.required_integer(4)?,
            samples_per_batch: emg.required_integer(5)?,
            encoding: emg.required_integer(10)?,
        })
    }

    /// The observed layout: 2048 Hz, 8 channels, 16-bit, 16 samples, encoding 0.
    pub fn is_supported(&self) -> bool {
        self.sample_rate == 2048
            && self.channels == 8
            && self.adc_bits == 16
            && self.samples_per_batch == 16
            && self.encoding == 0
    }
}

/// One raw sEMG batch: 16 samples × 8 channels, little-endian u16, interleaved
/// by sample then channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmgBatch {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub values: Vec<u16>,
}

impl EmgBatch {
    pub const CHANNELS: usize = 8;
    pub const SAMPLES: usize = 16;

    pub fn parse(payload: &[u8], config: &EmgConfig) -> Result<Self> {
        if !config.is_supported() {
            return Err(perr(
                "This EMG format isn't supported by the readings view yet.",
            ));
        }
        let fields = ProtoFields::parse(payload)?;
        let sequence = fields.required_integer(1)?;
        let timestamp_us = fields.required_integer(2)?;
        let bytes = fields.bytes_len(3, 256)?;
        let values = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Ok(Self {
            sequence,
            timestamp_us,
            values,
        })
    }
}

/// Everything a session reports. Times are implied by the `feed`/`tick` call.
/// Sensor data must not be logged verbatim: `Debug` prints raw sEMG frames by length only.
#[derive(Clone)]
pub enum Event {
    /// Input streams are live (first subscription ack or first sensor data).
    Connected,
    /// Authenticated traffic arrived while streaming (at most every 0.2 s).
    Heartbeat,
    /// A decoded sensor frame arrived (gesture, motion or raw sEMG).
    DataSeen,
    Gesture(GestureMessage),
    /// The pinch dial armed (`true`) or let go (`false`).
    DialState(bool),
    /// Relative wrist rotation while the dial is armed, coalesced to ≥ 20 ms.
    DialTurn(f64),
    Handedness(Hand),
    /// The band's reply to a device-state request (ConfigReq field 6), described for the log.
    DeviceStateReply(String),
    HandednessFailure(String),
    /// `None` = unknown (timed out, rejected or unsupported).
    BatteryStatus(Option<BatteryStatus>),
    RawEmgFrame(Vec<u8>),
    RawEmgConfiguration(EmgConfig),
    RawEmgState(bool),
    RawEmgFailure(String),
    CeremonyStage(String),
    /// The session needs an ownership HTTP exchange; resume it with
    /// `BandSession::ceremony_pair_request_completed` / `ceremony_pair_completed`.
    CeremonyHttp(CeremonyHttpRequest),
    /// The band confirmed this host as owner. Persist the identity; trust setup continues.
    CeremonyCompleted(EnrollmentIdentity),
    /// The handwriting capture moved (switching on, ready, restoring, finished).
    HandwritingState(CaptureStatus),
    /// The handwriting text changed: `text` with the edits applied, `raw` every class written
    /// since the last reset, `class` the one just written. What someone writes: never log it.
    HandwritingText {
        text: String,
        raw: String,
        class: usize,
    },
    /// One handwriting sample as the model wrote it (only while
    /// [crate::session::BandSession::set_handwriting_frames] is on): its 100 log-probabilities,
    /// one per class, for a decoder that reads more than the most likely one. What someone
    /// writes: never log it.
    HandwritingFrame {
        sequence: u64,
        timestamp_us: u64,
        latency_us: Option<u64>,
        values: Vec<f32>,
    },
    /// A gyro sample in raw counts, for the air mouse (only while
    /// [crate::session::BandSession::set_motion_samples] is on). Sensor data: never log it.
    Gyro { timestamp_us: u64, raw: [i16; 3] },
    /// An orientation sample, a unit quaternion in wire order w, x, y, z (only while
    /// [crate::session::BandSession::set_motion_samples] is on). Sensor data: never log it.
    Orientation { timestamp_us: u64, quaternion: [f32; 4] },
}

impl std::fmt::Debug for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connected => f.write_str("Connected"),
            Self::Heartbeat => f.write_str("Heartbeat"),
            Self::DataSeen => f.write_str("DataSeen"),
            Self::Gesture(gesture) => f.debug_tuple("Gesture").field(gesture).finish(),
            Self::DialState(on) => f.debug_tuple("DialState").field(on).finish(),
            Self::DialTurn(delta) => f.debug_tuple("DialTurn").field(delta).finish(),
            Self::Handedness(hand) => f.debug_tuple("Handedness").field(hand).finish(),
            Self::DeviceStateReply(text) => f.debug_tuple("DeviceStateReply").field(text).finish(),
            Self::HandednessFailure(message) => {
                f.debug_tuple("HandednessFailure").field(message).finish()
            }
            Self::BatteryStatus(status) => f.debug_tuple("BatteryStatus").field(status).finish(),
            Self::RawEmgFrame(bytes) => write!(f, "RawEmgFrame(len={})", bytes.len()),
            Self::RawEmgConfiguration(config) => {
                f.debug_tuple("RawEmgConfiguration").field(config).finish()
            }
            Self::RawEmgState(on) => f.debug_tuple("RawEmgState").field(on).finish(),
            Self::RawEmgFailure(message) => f.debug_tuple("RawEmgFailure").field(message).finish(),
            Self::CeremonyStage(stage) => f.debug_tuple("CeremonyStage").field(stage).finish(),
            Self::CeremonyHttp(request) => f.debug_tuple("CeremonyHttp").field(request).finish(),
            Self::CeremonyCompleted(identity) => {
                f.debug_tuple("CeremonyCompleted").field(identity).finish()
            }
            Self::HandwritingState(status) => f.debug_tuple("HandwritingState").field(status).finish(),
            Self::HandwritingText { text, class, .. } => {
                write!(f, "HandwritingText(len={}, class={class})", text.chars().count())
            }
            Self::HandwritingFrame { timestamp_us, .. } => write!(f, "HandwritingFrame(at={timestamp_us})"),
            Self::Gyro { timestamp_us, .. } => write!(f, "Gyro(at={timestamp_us})"),
            Self::Orientation { timestamp_us, .. } => write!(f, "Orientation(at={timestamp_us})"),
        }
    }
}
