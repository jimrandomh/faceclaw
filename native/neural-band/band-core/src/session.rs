//! The band handshake, trust setup and input subscription (kinesis `BandSession.swift`).
//! It never exports session keys.
//!
//! Any `Err` from `feed` is terminal: drop the session. If a ceremony was
//! running, first persist `enrollment()` (set once the band confirmed
//! ownership) — the band may already have changed owner.

use std::collections::HashMap;

use p256::ecdsa::Signature;
use p256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey, ecdh};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

use crate::airshield::{
    AirShieldCipher, AirShieldKeys, AirShieldReceiver, SCHEME_3, SCHEME_26_GUESSES, Variant,
};
use crate::ceremony::{CeremonyHttpRequest, OwnershipCeremony, failure_message};
use crate::datax::{DataXFrame, DataXReceiver, be16, be32, encode_frame};
use crate::dial::PinchDial;
use crate::error::{BandError, Result, perr};
use crate::events::{BatteryStatus, EmgConfig, Event, GestureMessage, Hand};
use crate::handwriting::{HandwritingDecoder, InferenceSample};
use crate::identity::{EnrollmentIdentity, trust_digest};
use crate::model_capture::{MODEL_STREAM_FIELDS, ModelCapture, ModelRequest};
use crate::proto::{ProtoFields, field_bytes, field_int};

const STREAM_FIELDS: [u32; 3] = [3, 6, 8];
/// The gesture stream's flag; the other two ([MOTION_FIELDS]) carry motion (gyro, orientation),
/// which only pinch and turn needs.
const GESTURE_FIELD: u32 = 3;
const MOTION_FIELDS: [u32; 2] = [6, 8];
/// The channel as the protocol logic knows it: the direction flag and the low
/// byte. Newer firmware sets extra bits (0x1c00) on channels it answers or
/// opens: 0x9c01 for 0x8001, 0x9c02 for 0x8002.
fn route(channel: u16) -> u16 {
    channel & 0x80ff
}

const STREAM_CHANNEL: u16 = 0x8005;
const CONFIGURATION_CHANNEL: u16 = 0x8006;
const CONFIG_SERVICE_CHANNEL: u16 = 0x8007;
const BATTERY_CHANNEL: u16 = 0x8008;
/// Opens an RPC service on a channel; later requests on that channel carry no words.
const SERVICE_OPEN: [u32; 2] = [0x8100ce56, 0x02000314];
const RPC_RESPONSE: u32 = 0x02000315;
const SERVICE_REJECTED: u32 = 0x0300c001;
const RAW_EMG: u32 = 0x0200020a;
const GESTURE: u32 = 0x0200020d;
const GYRO: u32 = 0x0200020f;
const ORIENTATION: u32 = 0x02000212;
const LINK_SETUP: u32 = 0x02001000;
/// The band's model output (handwriting is its pipeline 3).
const INFERENCE: u32 = 0x0200020c;
/// Invalid orientation samples in a row that end the session. A lone one is skipped: the band
/// sends a few now and then, and ending the link for one cost two seconds of reconnecting.
const BAD_ORIENTATION_LIMIT: u32 = 25;

const FINGERS: [&str; 5] = ["unknown", "thumb", "index", "middle", "notApplicable"];
const ACTIONS: [&str; 21] = [
    "unknown",
    "press",
    "release",
    "tap",
    "doubletap",
    "click",
    "up",
    "down",
    "left",
    "right",
    "wake",
    "swipeIn",
    "swipeOut",
    "ia",
    "partialPress",
    "partialRelease",
    "partialClick",
    "partialUp",
    "partialDown",
    "partialLeft",
    "partialRight",
];
const DERIVED: [&str; 11] = [
    "unknown",
    "singleTap",
    "doubleTap",
    "buttonHold",
    "buttonRelease",
    "buttonUp",
    "buttonDown",
    "buttonLeft",
    "buttonRight",
    "buttonPress",
    "buttonHoldRelease",
];

fn table_name(table: &[&str], value: u64) -> String {
    usize::try_from(value)
        .ok()
        .and_then(|index| table.get(index))
        .map_or_else(
            || format!("unrecognized:{value}"),
            |name| (*name).to_owned(),
        )
}

/// Swift `allSatisfy { flags.contains($0) && flags.integer($0) == value }`: stops at the first miss.
fn all_set(flags: &ProtoFields, fields: &[u32], value: u64) -> Result<bool> {
    for &field in fields {
        if !(flags.contains(field) && flags.integer(field)? == value) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SetupStage {
    Link,
    Ceremony,
    Identity,
    DeviceInfo,
    Input,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawStage {
    Config,
    Query,
    Update,
}

#[derive(Debug, Clone, Copy)]
struct RawRequest {
    enabled: bool,
    stage: RawStage,
    id: u64,
    deadline: f64,
}

#[derive(Debug, Clone, Copy)]
struct HandRequest {
    id: u64,
    hand: Option<Hand>,
    reading: bool,
    deadline: f64,
}

/// What one `feed` produced: bytes to write to the band and events to act on.
#[derive(Debug, Default)]
pub struct FeedResult {
    pub outgoing: Vec<u8>,
    pub events: Vec<Event>,
}

pub struct BandSession {
    secret: SecretKey,
    public: Vec<u8>,
    challenge: [u8; 16],
    seed: [u8; 32],
    iv: [u8; 16],
    base: u32,
    peer_key: Option<Vec<u8>>,
    peer_challenge: Option<Vec<u8>>,
    /// The scheme the band's EnableEncryption named (3 on the firmware kinesis knows).
    peer_parameters: u64,
    /// Which of `SCHEME_26_GUESSES` to use if the band offers a newer scheme.
    scheme_guess: usize,
    /// The key rules in use, fixed once the band's RequestEncryption arrives.
    variant: Variant,
    /// The band offered a newer scheme, so `variant` is a guess.
    guessing: bool,
    /// Traffic the session skipped, described for the log.
    diagnostics: Vec<String>,
    /// Describe every frame once streaming, too (debug logging).
    log_frames: bool,
    peer_seed: Option<Vec<u8>>,
    pending: Vec<u8>,
    transmitter: Option<AirShieldCipher>,
    receiver: Option<AirShieldReceiver>,
    datax: DataXReceiver,
    channel_types: HashMap<u16, u32>,
    dial: PinchDial,
    emitted_engagement: bool,
    dial_pending: f64,
    last_dial: f64,
    last_heartbeat: f64,
    streaming: bool,
    stopping: bool,
    stop_acknowledged: bool,
    authenticated_packets: usize,
    motion_messages: usize,
    /// The motion samples themselves go out as events (the air mouse needs them).
    motion_samples: bool,
    /// The handwriting samples themselves go out as events too.
    handwriting_frames: bool,
    /// Invalid orientation samples in a row (see [BAD_ORIENTATION_LIMIT]).
    bad_orientation: u32,
    streams_enabled: bool,
    /// Motion streams wanted (on unless [BandSession::set_motion_enabled] turned them off).
    motion: bool,
    /// Motion streams as the band last reported them.
    motion_active: bool,
    /// Gesture stream wanted (on unless [BandSession::set_streams] turned it off).
    gestures: bool,
    battery_channel_opened: bool,
    battery_request_id: u64,
    battery_request: Option<(u64, f64)>,
    battery_unavailable: bool,
    raw_emg: bool,
    raw_requested: bool,
    config_service_opened: bool,
    raw_request_id: u64,
    raw_request: Option<RawRequest>,
    raw_emg_frames: usize,
    raw_emg_bytes: usize,
    setup_stage: SetupStage,
    enrollment: Option<EnrollmentIdentity>,
    ceremony: Option<OwnershipCeremony>,
    app_trusted: bool,
    band_trusted: bool,
    end_link_sent: bool,
    configuration_id: u64,
    hand_request: Option<HandRequest>,
    /// The id of a pending device-state request (ConfigReq field 6: 1 standby, 2 active).
    device_state_request: Option<(u64, u64)>,
    hand: Option<Hand>,
    /// The band's handwriting model, switched on and off on request.
    model: ModelCapture,
    /// The settings channel's service was opened (its first request carries `SERVICE_OPEN`).
    settings_opened: bool,
    handwriting: HandwritingDecoder,
}

impl BandSession {
    /// `enrollment`: connect as the stored owner. `ceremony`: claim a band in
    /// pairing mode. Neither: the legacy startup (bands in pairing mode only).
    /// `raw_emg`: request raw sEMG right after the gesture subscription.
    pub fn new(
        enrollment: Option<EnrollmentIdentity>,
        ceremony: Option<OwnershipCeremony>,
        raw_emg: bool,
    ) -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let public = secret.public_key().to_encoded_point(false).as_bytes()[1..].to_vec();
        Self {
            secret,
            public,
            challenge: random(),
            seed: random(),
            iv: random(),
            base: u32::from_le_bytes(random()),
            peer_key: None,
            peer_challenge: None,
            peer_parameters: 3,
            scheme_guess: 0,
            variant: SCHEME_3,
            guessing: false,
            diagnostics: Vec::new(),
            log_frames: false,
            peer_seed: None,
            pending: Vec::new(),
            transmitter: None,
            receiver: None,
            datax: DataXReceiver::default(),
            channel_types: HashMap::new(),
            dial: PinchDial::default(),
            emitted_engagement: false,
            dial_pending: 0.0,
            last_dial: f64::NEG_INFINITY,
            last_heartbeat: f64::NEG_INFINITY,
            streaming: false,
            stopping: false,
            stop_acknowledged: false,
            authenticated_packets: 0,
            motion_messages: 0,
            motion_samples: false,
            handwriting_frames: false,
            bad_orientation: 0,
            streams_enabled: false,
            motion: true,
            motion_active: true,
            gestures: true,
            battery_channel_opened: false,
            battery_request_id: 0,
            battery_request: None,
            battery_unavailable: false,
            raw_emg,
            raw_requested: false,
            config_service_opened: false,
            raw_request_id: 6,
            raw_request: None,
            raw_emg_frames: 0,
            raw_emg_bytes: 0,
            setup_stage: SetupStage::Link,
            enrollment,
            ceremony,
            app_trusted: false,
            band_trusted: false,
            end_link_sent: false,
            configuration_id: 0,
            hand_request: None,
            device_state_request: None,
            hand: None,
            model: ModelCapture::default(),
            settings_opened: false,
            handwriting: HandwritingDecoder::default(),
        }
    }

    pub fn stop_acknowledged(&self) -> bool {
        self.stop_acknowledged
    }
    /// Use guess `index` of `SCHEME_26_GUESSES` if the band offers a newer
    /// encryption scheme (no effect on a scheme-3 band).
    pub fn with_scheme_guess(mut self, index: usize) -> Self {
        self.scheme_guess = index;
        self
    }

    /// The guess in use, if the band offered a newer scheme.
    pub fn scheme_guess(&self) -> Option<usize> {
        self.guessing.then_some(self.scheme_guess)
    }

    /// Also describe every frame after setup (channel, type words, size).
    pub fn set_log_frames(&mut self, on: bool) {
        self.log_frames = on;
    }

    /// Describe what was skipped since the last call (relay/control records,
    /// frames nothing handles), for the log. Types and sizes only, no payloads.
    pub fn take_diagnostics(&mut self) -> Vec<String> {
        if let Some(receiver) = self.receiver.as_mut() {
            self.diagnostics.append(&mut receiver.skipped);
        }
        std::mem::take(&mut self.diagnostics)
    }

    pub fn authenticated_packets(&self) -> usize {
        self.authenticated_packets
    }
    pub fn motion_messages(&self) -> usize {
        self.motion_messages
    }
    pub fn streams_enabled(&self) -> bool {
        self.streams_enabled
    }
    pub fn hand(&self) -> Option<Hand> {
        self.hand
    }
    pub fn raw_emg_frames(&self) -> usize {
        self.raw_emg_frames
    }
    pub fn raw_emg_bytes(&self) -> usize {
        self.raw_emg_bytes
    }
    pub fn ceremony(&self) -> Option<&OwnershipCeremony> {
        self.ceremony.as_ref()
    }
    pub fn enrollment(&self) -> Option<&EnrollmentIdentity> {
        self.enrollment.as_ref()
    }
    /// The identity FinishChangeOwner commits, once `ceremony_pair_completed`
    /// succeeded; `None` before that or without a ceremony.
    pub fn pending_identity(&self) -> Option<EnrollmentIdentity> {
        self.ceremony.as_ref()?.pending_identity()
    }
    /// Whether the band's trust proof is checked: the enrollment knows the band's key.
    pub fn band_verified(&self) -> bool {
        self.enrollment
            .as_ref()
            .is_some_and(|identity| identity.band_public_key.is_some())
    }

    /// The first bytes to write after the L2CAP channel opens: RequestEncryption.
    pub fn request(&self) -> Result<Vec<u8>> {
        encode_frame(
            0x8001,
            &[0x81000005, 0x02000001],
            &[
                field_bytes(1, &self.public),
                field_bytes(2, &self.challenge),
                field_int(3, 0),
                // The schemes we support, as a bitmask: what the phone app offers.
                // (Offering only 3 doesn't change what newer firmware picks.)
                field_int(4, 31),
                field_int(7, 16),
            ]
            .concat(),
        )
    }

    fn encrypt(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        match self.transmitter.as_mut() {
            Some(transmitter) => transmitter.encrypt(frame),
            None => Err(perr("Band encryption is not ready")),
        }
    }

    fn end_link_setup(&self) -> Result<Vec<u8>> {
        encode_frame(
            0x8001,
            &[LINK_SETUP],
            &[field_int(1, 1), field_bytes(2, &random::<16>())].concat(),
        )
    }

    fn device_info_request(&self) -> Result<Vec<u8>> {
        encode_frame(
            0x8003,
            &SERVICE_OPEN,
            &[field_int(1, 1), field_bytes(3, &[])].concat(),
        )
    }

    /// Feed bytes read from the band's L2CAP channel at monotonic `time` (seconds).
    ///
    /// Any `Err` from `feed` is terminal: drop the session. If a ceremony was
    /// running, first persist `enrollment()` (set once the band confirmed
    /// ownership) — the band may already have changed owner.
    pub fn feed(&mut self, bytes: &[u8], time: f64) -> Result<FeedResult> {
        self.pending.extend_from_slice(bytes);
        let mut outgoing = Vec::new();
        let mut events = Vec::new();
        while self.receiver.is_none() && self.pending.len() >= 4 {
            if self.pending[0] & 0x80 == 0 {
                return Err(perr("Unexpected bytes before band encryption"));
            }
            let size = usize::from(be16(&self.pending, 0) & 0x7fff) + 4;
            if size < 8 {
                return Err(perr("Invalid band setup length"));
            }
            if self.pending.len() < size {
                break;
            }
            let frame: Vec<u8> = self.pending.drain(..size).collect();
            let offset = if frame[2] & 0x80 != 0 { 8 } else { 4 };
            if size < offset + 4 {
                return Err(perr("Truncated band setup header"));
            }
            let kind = be32(&frame, offset);
            let fields = ProtoFields::parse(&frame[offset + 4..])?;
            let point = fields.bytes_len(1, 64)?.to_vec();
            let peer = PublicKey::from_sec1_bytes(&[&[4u8][..], &point].concat())
                .map_err(|_| perr("Invalid band public key"))?;
            match kind {
                0x02000001 => {
                    let curve = fields.integer(3)?;
                    let parameters = fields.integer(4)?;
                    // `parameters` is a bitmask of the band's supported schemes. Older
                    // firmware offers exactly 3; newer offers 27 and then uses 26,
                    // whose key rules are guessed (bits 3 and 4 are 31's).
                    let newer = parameters & 24 != 0;
                    if self.peer_key.is_some() || curve != 0 || !(newer || parameters & 3 == 3) {
                        return Err(perr(format!(
                            "Unsupported band encryption parameters (repeated request: {}, curve {curve}, parameters {parameters}, field 7: {})",
                            self.peer_key.is_some(),
                            fields
                                .integer(7)
                                .map_or_else(|_| "?".to_string(), |v| v.to_string())
                        )));
                    }
                    self.peer_challenge = Some(fields.bytes_len(2, 16)?.to_vec());
                    self.peer_key = Some(point);
                    self.guessing = newer;
                    self.variant = if newer {
                        SCHEME_26_GUESSES[self.scheme_guess % SCHEME_26_GUESSES.len()]
                    } else {
                        SCHEME_3
                    };
                    outgoing.extend(encode_frame(
                        1,
                        &[0x02000002],
                        &[
                            field_bytes(1, &self.public),
                            field_bytes(2, &self.seed),
                            field_bytes(3, &self.iv),
                            field_int(4, u64::from(self.base)),
                            field_int(5, self.variant.announce),
                        ]
                        .concat(),
                    )?);
                }
                0x02000002 => {
                    let parameters = fields.integer(5)?;
                    let peer_challenge = match (&self.peer_key, &self.peer_challenge) {
                        // Newer firmware names 26 here whatever we offered; whether
                        // `variant` is right shows in the first packet either way.
                        (Some(key), Some(challenge)) if *key == point => challenge.clone(),
                        _ => {
                            return Err(perr(format!(
                                "Unexpected band encryption response (same key: {}, parameters {parameters})",
                                self.peer_key.as_deref() == Some(point.as_slice())
                            )));
                        }
                    };
                    self.peer_parameters = parameters;
                    let shared =
                        ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
                    let secret = shared.raw_secret_bytes().as_slice();
                    let peer_seed = fields.bytes_len(2, 32)?.to_vec();
                    let peer_iv: [u8; 16] =
                        fields.bytes_len(3, 16)?.try_into().expect("length checked");
                    let peer_counter = u32::try_from(fields.integer(4)?)
                        .map_err(|_| perr("Invalid band packet counter"))?;
                    self.transmitter = Some(AirShieldCipher::new(
                        AirShieldKeys::derive_variant(
                            self.variant,
                            secret,
                            &peer_challenge,
                            &self.seed,
                        )?,
                        self.iv,
                        self.base,
                    ));
                    self.receiver = Some(AirShieldReceiver::new(AirShieldCipher::new(
                        AirShieldKeys::derive_variant(
                            self.variant,
                            secret,
                            &self.challenge,
                            &peer_seed,
                        )?,
                        peer_iv,
                        peer_counter,
                    )));
                    self.peer_seed = Some(peer_seed);
                    if self.ceremony.is_some() {
                        // Enrollment runs the ownership ceremony instead of the identity
                        // queries; it rejoins the enrolled flow at trust.
                        self.setup_stage = SetupStage::Ceremony;
                        let start = self.ceremony.as_ref().expect("checked").start()?;
                        outgoing.extend(self.encrypt(&start)?);
                    } else if self.enrollment.is_some() {
                        // Enrolled startup replaces the empty identity query with an
                        // EnableTrust proof. Link setup waits for mutual trust.
                        self.setup_stage = SetupStage::Identity;
                        let proof = self.enable_trust(false)?;
                        outgoing.extend(self.encrypt(&proof)?);
                    } else {
                        // Complete link setup before opening the input service.
                        let query = encode_frame(0x8002, &[0x81000024, 0x02003000], &[])?;
                        outgoing.extend(self.encrypt(&query)?);
                        let end = self.end_link_setup()?;
                        outgoing.extend(self.encrypt(&end)?);
                    }
                }
                _ => return Err(perr("Unrecognized band setup message")),
            }
        }
        if self.receiver.is_some() {
            let records = self
                .receiver
                .as_mut()
                .expect("checked")
                .feed(&self.pending)
                .map_err(|error| {
                    if self.authenticated_packets == 0 && self.guessing {
                        perr(format!(
                            "{error} (the band chose encryption scheme {}; key guess {} was wrong)",
                            self.peer_parameters, self.scheme_guess
                        ))
                    } else {
                        error
                    }
                })?;
            self.pending.clear();
            for plaintext in records {
                self.authenticated_packets += 1;
                let frames = self.datax.feed(&plaintext)?;
                if matches!(
                    self.setup_stage,
                    SetupStage::Ceremony | SetupStage::Identity | SetupStage::Link
                ) {
                    // Setup only: header bytes (length, channel, type words), no payload.
                    let head = &plaintext[..plaintext.len().min(12)];
                    self.diagnostics.push(format!(
                        "packet {}: {} plaintext bytes, starts {:02x?}; frames {:?}; {} bytes held for a later packet",
                        self.authenticated_packets,
                        plaintext.len(),
                        head,
                        frames
                            .iter()
                            .map(|frame| format!(
                                "ch {:#x} words {:08x?} {}B",
                                frame.channel,
                                frame.words,
                                frame.payload.len()
                            ))
                            .collect::<Vec<_>>(),
                        self.datax.pending_len()
                    ));
                }
                for frame in frames {
                    if self.log_frames && self.setup_stage == SetupStage::Input {
                        self.diagnostics.push(format!(
                            "frame ch {:#x} words {:08x?} {}B",
                            frame.channel,
                            frame.words,
                            frame.payload.len()
                        ));
                    }
                    let produced = match self.input(&frame, time, &mut outgoing) {
                        Ok(produced) => produced,
                        // A frame this firmware sends that we can't read is logged and skipped, not
                        // fatal: one misread message mustn't drop the link.
                        Err(error) if self.streaming && error.to_string().to_lowercase().contains("protobuf") => {
                            vec![Event::DeviceStateReply(format!(
                                "unreadable frame skipped ({error}): ch {:#x} words {:08x?} payload {}",
                                frame.channel,
                                frame.words,
                                frame.payload.iter().take(96).map(|x| format!("{x:02x}")).collect::<String>()
                            ))]
                        }
                        Err(error) => return Err(error),
                    };
                    events.extend(produced);
                }
                if self.streaming && !self.stopping && time - self.last_heartbeat >= 0.2 {
                    self.last_heartbeat = time;
                    events.push(Event::Heartbeat);
                }
            }
        }
        Ok(FeedResult { outgoing, events })
    }

    /// Call periodically (e.g. every 50 ms): expires requests and releases the dial.
    pub fn tick(&mut self, time: f64) -> Vec<Event> {
        self.dial.tick(time);
        let mut events = self.engagement_events();
        if !self.stopping
            && self
                .hand_request
                .is_some_and(|request| time >= request.deadline)
        {
            self.hand_request = None;
            self.hand = None;
            events.push(Event::HandednessFailure(
                "Couldn't confirm the band hand. Reconnect and try again.".into(),
            ));
        }
        if !self.stopping
            && self
                .battery_request
                .is_some_and(|(_, deadline)| time >= deadline)
        {
            self.battery_request = None;
            events.push(Event::BatteryStatus(None));
        }
        if !self.stopping
            && self
                .raw_request
                .is_some_and(|request| time >= request.deadline)
        {
            self.raw_request = None;
            events.push(Event::RawEmgFailure(
                "The band didn't confirm the EMG change. Turn readings off, then try again.".into(),
            ));
        }
        events
    }

    /// Update the existing input subscription. Gesture and motion flags stay on.
    pub fn set_raw_emg_enabled(&mut self, enabled: bool, time: f64) -> Result<Vec<u8>> {
        if self.stopping {
            return Err(BandError::Busy(
                "Wait for the band to reconnect before changing readings.".into(),
            ));
        }
        if self.raw_request.is_some() {
            return Err(BandError::Busy(
                "Wait for the current EMG change to finish.".into(),
            ));
        }
        self.raw_emg = enabled;
        if !self.streams_enabled {
            return Ok(Vec::new());
        }
        self.raw_request_id += 1;
        let id = self.raw_request_id;
        self.raw_request = Some(RawRequest {
            enabled,
            stage: if enabled {
                RawStage::Config
            } else {
                RawStage::Update
            },
            id,
            deadline: time + 8.0,
        });
        if enabled {
            let words: &[u32] = if self.config_service_opened {
                &[]
            } else {
                &SERVICE_OPEN
            };
            self.config_service_opened = true;
            let frame = encode_frame(
                CONFIG_SERVICE_CHANNEL,
                words,
                &[field_int(1, id), field_bytes(5, &[])].concat(),
            )?;
            return self.encrypt(&frame);
        }
        self.raw_stream_update(id, false)
    }

    fn raw_stream_update(&mut self, id: u64, enabled: bool) -> Result<Vec<u8>> {
        self.raw_requested = true;
        let mut control: Vec<u8> = std::iter::once(field_int(2, u64::from(enabled)))
            .chain(STREAM_FIELDS.iter().map(|&field| field_int(field, 1)))
            .flatten()
            .collect();
        control.extend(self.model_stream_control());
        let frame = encode_frame(
            STREAM_CHANNEL,
            &[],
            &[field_int(1, id), field_bytes(4, &control)].concat(),
        )?;
        self.encrypt(&frame)
    }

    /// Write the band's hand setting, then confirm it with an independent read.
    pub fn set_handedness(&mut self, hand: Hand, time: f64) -> Result<Vec<u8>> {
        if !self.streams_enabled
            || self.stopping
            || self.hand.is_none()
            || self.hand_request.is_some()
        {
            return Err(BandError::Busy(
                "Wait for the band to report its hand before changing it.".into(),
            ));
        }
        self.dial = PinchDial::default();
        self.request_hand(Some(hand), false, time)
    }

    /// Asks the band for a device state, as Meta's client does on the middle double tap with
    /// host sleep handling on (per Kinesis's author): ConfigReq field 6, 1 standby, 2 active. In
    /// standby the band sends no gesture until its wake gesture (the middle double tap), which it
    /// keeps and doesn't report; the reply (field 6 echoed) is only logged.
    pub fn request_device_state(&mut self, state: u64) -> Result<Vec<u8>> {
        let id = self.configuration_id + 1;
        let words: &[u32] = if self.configuration_id == 0 {
            &SERVICE_OPEN
        } else {
            &[]
        };
        let frame = encode_frame(
            CONFIGURATION_CHANNEL,
            words,
            &[field_int(1, id), field_bytes(5, &field_int(6, state))].concat(),
        )?;
        let bytes = self.encrypt(&frame)?;
        self.configuration_id = id;
        self.device_state_request = Some((id, state));
        Ok(bytes)
    }

    fn request_hand(&mut self, hand: Option<Hand>, reading: bool, time: f64) -> Result<Vec<u8>> {
        let id = self.configuration_id + 1;
        // ConfigReq.is_left_handed is field 10. An empty ConfigReq reads current settings.
        let config = if reading {
            Vec::new()
        } else {
            field_int(10, u64::from(hand == Some(Hand::Left)))
        };
        let words: &[u32] = if self.configuration_id == 0 {
            &SERVICE_OPEN
        } else {
            &[]
        };
        let frame = encode_frame(
            CONFIGURATION_CHANNEL,
            words,
            &[field_int(1, id), field_bytes(5, &config)].concat(),
        )?;
        let bytes = self.encrypt(&frame)?;
        self.configuration_id = id;
        self.hand_request = Some(HandRequest {
            id,
            hand,
            reading,
            deadline: time + 5.0,
        });
        Ok(bytes)
    }

    fn receive_hand(
        &mut self,
        fields: &ProtoFields,
        time: f64,
        outgoing: &mut Vec<u8>,
    ) -> Result<Vec<Event>> {
        let Some(request) = self.hand_request else {
            return Ok(Vec::new());
        };
        if fields.integer(1)? != request.id {
            return Ok(Vec::new());
        }
        self.hand_request = None;
        let failure = |message: &str| vec![Event::HandednessFailure(message.to_owned())];
        if time >= request.deadline {
            self.hand = None;
            return Ok(failure(
                "Couldn't confirm the band hand. Reconnect and try again.",
            ));
        }
        if fields.integer(2)? != 1 {
            self.hand = None;
            return Ok(failure(
                "The band couldn't apply its hand setting. Reconnect and try again.",
            ));
        }
        if !request.reading {
            // Read it again independently; a successful write status alone isn't confirmation.
            let read = self.request_hand(request.hand, true, time)?;
            outgoing.extend(read);
            return Ok(Vec::new());
        }
        if !fields.contains(6) {
            self.hand = None;
            return Ok(failure("This band didn't report its hand setting."));
        }
        let config = ProtoFields::parse(fields.bytes(6)?)?;
        if !config.contains(10) || config.integer(10)? > 1 {
            self.hand = None;
            return Ok(failure("This band didn't report its hand setting."));
        }
        let reported = if config.integer(10)? == 1 {
            Hand::Left
        } else {
            Hand::Right
        };
        self.hand = Some(reported);
        let mut events = vec![Event::Handedness(reported)];
        if request.hand.is_some_and(|expected| expected != reported) {
            events.push(Event::HandednessFailure(
                "The band didn't keep the selected hand. Reconnect and try again.".into(),
            ));
        }
        Ok(events)
    }

    /// BatteryInfoReq: an empty read request, separate from sensor subscriptions.
    pub fn query_battery_status(&mut self, time: f64) -> Result<Vec<u8>> {
        if !self.streams_enabled
            || self.stopping
            || self.battery_unavailable
            || self.battery_request.is_some()
        {
            return Ok(Vec::new());
        }
        self.battery_request_id += 1;
        let id = self.battery_request_id;
        self.battery_request = Some((id, time + 3.0));
        let words: &[u32] = if self.battery_channel_opened {
            &[]
        } else {
            &SERVICE_OPEN
        };
        self.battery_channel_opened = true;
        let frame = encode_frame(
            BATTERY_CHANNEL,
            words,
            &[field_int(1, id), field_bytes(2, &[])].concat(),
        )?;
        self.encrypt(&frame)
    }

    /// Keep the gesture stream and turn the motion streams (gyro, orientation) on or off, as
    /// power saving while nothing needs pinch and turn. The band answers like a subscription
    /// (request 3); gestures staying on is required, motion is only reported
    /// ([BandSession::motion_active]).
    /// Whether each gyro and orientation sample also goes out as an event ([Event::Gyro],
    /// [Event::Orientation]), for the air mouse. Off by default: nothing else needs them.
    pub fn set_motion_samples(&mut self, on: bool) {
        self.motion_samples = on;
    }

    /// Whether each handwriting sample also goes out as an event ([Event::HandwritingFrame]),
    /// before the text it adds. Off by default.
    pub fn set_handwriting_frames(&mut self, on: bool) {
        self.handwriting_frames = on;
    }

    pub fn set_motion_enabled(&mut self, enabled: bool) -> Result<Vec<u8>> {
        self.set_streams(true, enabled)
    }

    /// The gesture stream and the motion streams on or off. With everything off (the band's
    /// power saving) the band sends nothing, doesn't recognize gestures and doesn't vibrate; the
    /// link stays up (status queries still answer) and a reply with gestures off counts as a
    /// live subscription while that's what was asked.
    pub fn set_streams(&mut self, gestures: bool, motion: bool) -> Result<Vec<u8>> {
        self.gestures = gestures;
        self.motion = motion;
        if !self.streams_enabled || self.stopping || self.raw_request.is_some() {
            return Ok(Vec::new());
        }
        let mut control = field_int(GESTURE_FIELD, u64::from(gestures));
        for field in MOTION_FIELDS {
            control.extend(field_int(field, u64::from(motion)));
        }
        control.extend(self.model_stream_control());
        let frame = encode_frame(
            STREAM_CHANNEL,
            &[],
            &[field_int(1, 3), field_bytes(4, &control)].concat(),
        )?;
        self.encrypt(&frame)
    }

    pub fn motion_active(&self) -> bool {
        self.motion_active
    }

    /// Read the existing subscription's status when sensor traffic goes quiet.
    pub fn query_stream_state(&mut self) -> Result<Vec<u8>> {
        if !self.streams_enabled || self.stopping || self.raw_request.is_some() {
            return Ok(Vec::new());
        }
        self.stream_request(5, None)
    }

    /// Switch the band's handwriting model on (`hints`: the settings' ids found last time) or
    /// back off. The requests go out with [BandSession::flush_handwriting]; progress comes back
    /// as [Event::HandwritingState], the text as [Event::HandwritingText].
    pub fn set_handwriting(
        &mut self,
        enabled: bool,
        hints: Option<(u64, u64)>,
        time: f64,
    ) -> Result<()> {
        if !enabled {
            self.model.restore(time);
            return Ok(());
        }
        if !self.streams_enabled || self.stopping || self.setup_stage != SetupStage::Input {
            return Err(BandError::Busy("Connect the band before writing.".into()));
        }
        self.model.start(time, hints)?;
        self.handwriting.reset("");
        Ok(())
    }

    /// Put the band's handwriting settings back to normal after a capture that never finished
    /// (an app or connection that ended in the middle).
    pub fn recover_handwriting(&mut self, hints: Option<(u64, u64)>, time: f64) -> Result<()> {
        if !self.streams_enabled || self.stopping || self.setup_stage != SetupStage::Input {
            return Err(BandError::Busy("Connect the band before restoring it.".into()));
        }
        self.model.recover(time, hints)
    }

    /// Whether the band's handwriting is on or being switched on (not while restoring).
    pub fn handwriting_writing(&self) -> bool {
        matches!(
            self.model.status().phase,
            crate::model_capture::CapturePhase::Preparing | crate::model_capture::CapturePhase::Ready
        )
    }

    /// Whether a handwriting capture is running (switching on, ready or restoring).
    pub fn handwriting_active(&self) -> bool {
        self.model.active()
    }

    /// Start the written text over from `text` (what the field holds now).
    pub fn reset_handwriting_text(&mut self, text: &str) {
        self.handwriting.reset(text);
    }

    /// Replace the written text (a word completed or corrected); the writing carries on after it.
    pub fn replace_handwriting_text(&mut self, text: &str) {
        self.handwriting.set_text(text);
    }

    /// The written text so far, with the edits applied.
    pub fn handwriting_text(&self) -> &str {
        self.handwriting.text()
    }

    /// The next written letter will be a capital.
    pub fn handwriting_shifted(&self) -> bool {
        self.handwriting.shifted()
    }

    /// The capture's next request, if one is due, and its status changes. Call it often while
    /// [BandSession::handwriting_active] (every tick).
    pub fn flush_handwriting(&mut self, time: f64) -> Result<(Vec<u8>, Vec<Event>)> {
        let mut outgoing = Vec::new();
        if !self.stopping
            && self.raw_request.is_none()
            && let Some(request) = self.model.next(time)
        {
            outgoing = self.encode_model(request)?;
        }
        Ok((outgoing, self.model_events()))
    }

    fn encode_model(&mut self, request: ModelRequest) -> Result<Vec<u8>> {
        let opened = if request.channel == STREAM_CHANNEL {
            true
        } else {
            std::mem::replace(&mut self.settings_opened, true)
        };
        let streams = match request.streams() {
            Some(_) => self.full_stream_control(),
            None => Vec::new(),
        };
        let words: &[u32] = if opened { &[] } else { &SERVICE_OPEN };
        let frame = encode_frame(request.channel, words, &request.payload(&streams))?;
        self.encrypt(&frame)
    }

    /// Every stream field, on or off as wanted, for a request that sets them all.
    fn full_stream_control(&self) -> Vec<u8> {
        let mut control = Vec::new();
        if self.raw_requested {
            control.extend(field_int(2, u64::from(self.raw_emg)));
        }
        control.extend(field_int(GESTURE_FIELD, u64::from(self.gestures)));
        for field in MOTION_FIELDS {
            control.extend(field_int(field, u64::from(self.motion)));
        }
        control.extend(self.model_stream_control());
        control
    }

    /// The model's stream fields as last requested; nothing if they were never touched.
    fn model_stream_control(&self) -> Vec<u8> {
        match self.model.stream_wanted() {
            Some(on) => MODEL_STREAM_FIELDS
                .iter()
                .flat_map(|&field| field_int(field, u64::from(on)))
                .collect(),
            None => Vec::new(),
        }
    }

    fn model_events(&mut self) -> Vec<Event> {
        self.model
            .drain()
            .into_iter()
            .map(Event::HandwritingState)
            .collect()
    }

    /// An inference sample: handwriting while the capture runs, otherwise nothing. A malformed
    /// one is skipped (ending the connection would leave the band in the model).
    fn receive_inference(&mut self, payload: &[u8], time: f64) -> Vec<Event> {
        let mut events = Vec::new();
        if self.stopping || !self.model.active() {
            return events;
        }
        match InferenceSample::parse(payload) {
            Ok(sample) => {
                if self.model.sample(&sample, time) {
                    if self.handwriting_frames {
                        events.push(Event::HandwritingFrame {
                            sequence: sample.sequence,
                            timestamp_us: sample.timestamp_us,
                            latency_us: sample.latency_us,
                            values: sample.values.clone(),
                        });
                    }
                    if let Some(class) = self.handwriting.consume(&sample) {
                        events.push(Event::HandwritingText {
                            text: self.handwriting.text().to_owned(),
                            raw: self.handwriting.raw().to_owned(),
                            class,
                        });
                    }
                }
            }
            Err(error) => self
                .diagnostics
                .push(format!("skipped a malformed model sample: {error}")),
        }
        events.extend(self.model_events());
        events.push(Event::DataSeen);
        events
    }

    /// Disable the streams (including raw sEMG if it was requested).
    ///
    /// An empty return means there is nothing to acknowledge — close the channel
    /// now. Otherwise write the bytes and wait up to 3 s for `stop_acknowledged()`.
    pub fn stop(&mut self) -> Result<Vec<u8>> {
        if self.stopping {
            return Ok(Vec::new());
        }
        self.stopping = true;
        self.hand_request = None;
        self.raw_request = None;
        self.battery_request = None;
        if self.transmitter.is_none() || self.setup_stage != SetupStage::Input {
            return Ok(Vec::new());
        }
        self.stream_request(4, Some(false))
    }

    /// Resume the ceremony after the `pair_request` HTTP exchange.
    pub fn ceremony_pair_request_completed(
        &mut self,
        signature: &[u8],
        receipt: &str,
    ) -> Result<Vec<u8>> {
        if self.stopping {
            return Ok(Vec::new());
        }
        let frame = self
            .ceremony
            .as_mut()
            .ok_or_else(|| perr("No enrollment is running"))?
            .pair_request_completed(signature, receipt)?;
        self.encrypt(&frame)
    }

    /// Resume the ceremony after the `pair` HTTP exchange.
    ///
    /// Persist `pending_identity()` as tentative BEFORE writing these bytes; the
    /// band may commit ownership even if its confirmation never arrives. Promote
    /// it on `Event::CeremonyCompleted`.
    pub fn ceremony_pair_completed(
        &mut self,
        signature: &[u8],
        receipt: &str,
        device_public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        if self.stopping {
            return Ok(Vec::new());
        }
        let frame = self
            .ceremony
            .as_mut()
            .ok_or_else(|| perr("No enrollment is running"))?
            .pair_completed(signature, receipt, device_public_key)?;
        self.encrypt(&frame)
    }

    /// Host EnableTrust on the identity service channel. The service-open word
    /// is only needed before the first identity exchange on the channel.
    fn enable_trust(&self, service_open: bool) -> Result<Vec<u8>> {
        let identity = self
            .enrollment
            .as_ref()
            .ok_or_else(|| perr("No owner identity is stored"))?;
        let (Some(peer_key), Some(peer_challenge)) = (&self.peer_key, &self.peer_challenge) else {
            return Err(perr("Band encryption is not ready"));
        };
        let digest = trust_digest(peer_challenge, peer_key, &self.seed, &self.public);
        let signature: Signature = identity
            .private_key
            .sign_prehash(&digest)
            .map_err(|_| perr("Could not sign the band trust proof"))?;
        let words: &[u32] = if service_open {
            &[0x02001000]
        } else {
            &[0x81000024, 0x02001000]
        };
        encode_frame(
            0x8002,
            words,
            &[
                field_bytes(1, &Sha256::digest(identity.app_point())),
                field_bytes(2, &signature.to_bytes()),
            ]
            .concat(),
        )
    }

    /// Drive one ownership ceremony response. HTTP steps pause the wire flow and
    /// surface `Event::CeremonyHttp`; the caller resumes with the server's reply.
    fn receive_ceremony(
        &mut self,
        frame: &DataXFrame,
        outgoing: &mut Vec<u8>,
    ) -> Result<Vec<Event>> {
        let Some(&kind) = frame.words.last() else {
            return Ok(Vec::new());
        };
        if kind & 0xff00_0000 == 0x0300_0000 {
            let code = kind & 0x00ff_ffff;
            return Err(BandError::OwnershipRejected {
                code,
                message: failure_message(code),
            });
        }
        let ceremony = self
            .ceremony
            .as_mut()
            .expect("ceremony stage implies a ceremony");
        match kind {
            0x02003001 => {
                let next = ceremony.identity_read(&frame.payload)?;
                outgoing.extend(self.encrypt(&next)?);
                Ok(vec![Event::CeremonyStage(
                    "reading the band identity".into(),
                )])
            }
            0x02002001 => {
                let request = ceremony.skip_challenge(&frame.payload)?;
                Ok(vec![
                    Event::CeremonyStage("claiming the band".into()),
                    Event::CeremonyHttp(CeremonyHttpRequest::PairRequest(request)),
                ])
            }
            0x02002003 => {
                let pair = ceremony.start_change_owner(&frame.payload)?;
                Ok(vec![
                    Event::CeremonyStage("confirming ownership".into()),
                    Event::CeremonyHttp(CeremonyHttpRequest::Pair(pair)),
                ])
            }
            0x02002005 => {
                let identity = ceremony.complete(&frame.words, &frame.payload)?;
                // Swap the new identity in and open the enrolled trust flow on the
                // same channel; the identity service is already open there.
                self.enrollment = Some(identity.clone());
                self.app_trusted = false;
                self.band_trusted = false;
                self.end_link_sent = false;
                self.setup_stage = SetupStage::Identity;
                let proof = self.enable_trust(true)?;
                outgoing.extend(self.encrypt(&proof)?);
                Ok(vec![
                    Event::CeremonyCompleted(identity),
                    Event::CeremonyStage("establishing trust".into()),
                ])
            }
            _ => {
                self.diagnostics.push(format!(
                    "unhandled ceremony frame: channel {:#x}, words {:08x?}, {} payload bytes",
                    frame.channel,
                    frame.words,
                    frame.payload.len()
                ));
                Ok(Vec::new())
            }
        }
    }

    /// Handle the enrolled identity exchange until both directions trust each
    /// other, then rejoin the shared EndLinkSetup flow.
    fn receive_identity(
        &mut self,
        frame: &DataXFrame,
        outgoing: &mut Vec<u8>,
    ) -> Result<Vec<Event>> {
        let Some(&kind) = frame.words.last() else {
            return Ok(Vec::new());
        };
        if kind & 0xff00_0000 == 0x0300_0000 && route(frame.channel) == 2 {
            if kind != 0x03001000 {
                let code = kind & 0x00ff_ffff;
                if code == 0x1043 {
                    return Err(BandError::IdentityMismatch {
                        code,
                        message: "band enrolled to a different key. forget the stored band identity to reconnect without it.".into(),
                    });
                }
                return Err(BandError::IdentityMismatch {
                    code,
                    message: format!(
                        "the band rejected the stored identity ({kind:x}). try reconnecting."
                    ),
                });
            }
            self.app_trusted = true;
        } else if kind == 0x02001001 && route(frame.channel) & 0x8000 != 0 {
            if self.band_trusted {
                return Err(perr("The band sent a duplicate identity proof"));
            }
            let fields = ProtoFields::parse(&frame.payload)?;
            let (Some(peer_key), Some(peer_seed)) = (&self.peer_key, &self.peer_seed) else {
                return Err(perr("Band encryption is not ready"));
            };
            let signature = fields.bytes_len(2, 64)?;
            if let Some(band_key) = self
                .enrollment
                .as_ref()
                .and_then(|identity| identity.band_public_key.as_ref())
            {
                let digest = trust_digest(&self.challenge, &self.public, peer_seed, peer_key);
                let valid = Signature::from_slice(signature)
                    .is_ok_and(|proof| band_key.verify_prehash(&digest, &proof).is_ok());
                if !valid {
                    return Err(perr(
                        "The band's identity proof didn't verify. Try reconnecting.",
                    ));
                }
            }
            self.band_trusted = true;
            let ack = encode_frame(frame.channel & 0x7fff, &[0x03001000], &[])?;
            outgoing.extend(self.encrypt(&ack)?);
        } else if kind == LINK_SETUP && route(frame.channel) == 0x8001 && self.end_link_sent {
            let fields = ProtoFields::parse(&frame.payload)?;
            if fields.required_integer(1)? != 1 || fields.bytes(2)?.len() != 16 {
                return Err(perr("Unexpected band link setup response"));
            }
            self.setup_stage = SetupStage::DeviceInfo;
            let info = self.device_info_request()?;
            outgoing.extend(self.encrypt(&info)?);
            return Ok(Vec::new());
        } else {
            return Ok(Vec::new());
        }
        if self.app_trusted && self.band_trusted && !self.end_link_sent {
            self.end_link_sent = true;
            let end = self.end_link_setup()?;
            outgoing.extend(self.encrypt(&end)?);
        }
        Ok(Vec::new())
    }

    fn stream_request(&mut self, id: u64, enabled: Option<bool>) -> Result<Vec<u8>> {
        let mut selected = STREAM_FIELDS.to_vec();
        if enabled == Some(false) && self.raw_requested {
            selected.insert(0, 2);
        }
        let control: Vec<u8> = match enabled {
            Some(on) => {
                let mut control: Vec<u8> = selected
                    .iter()
                    .flat_map(|&field| field_int(field, u64::from(on)))
                    .collect();
                // Stopping turns the model's streams off too, if they were ever touched.
                match (on, self.model.stream_wanted()) {
                    (false, Some(_)) => control.extend(
                        MODEL_STREAM_FIELDS.iter().flat_map(|&field| field_int(field, 0)),
                    ),
                    (true, _) => control.extend(self.model_stream_control()),
                    _ => {}
                }
                control
            }
            None => Vec::new(),
        };
        let words: &[u32] = if id == 2 { &SERVICE_OPEN } else { &[] };
        let frame = encode_frame(
            STREAM_CHANNEL,
            words,
            &[field_int(1, id), field_bytes(4, &control)].concat(),
        )?;
        self.encrypt(&frame)
    }

    fn engagement_events(&mut self) -> Vec<Event> {
        if self.dial.engaged() == self.emitted_engagement {
            return Vec::new();
        }
        self.emitted_engagement = self.dial.engaged();
        self.dial_pending = 0.0;
        self.last_dial = f64::NEG_INFINITY;
        vec![Event::DialState(self.emitted_engagement)]
    }

    fn input(
        &mut self,
        frame: &DataXFrame,
        time: f64,
        outgoing: &mut Vec<u8>,
    ) -> Result<Vec<Event>> {
        if let Some(&kind) = frame.words.last() {
            if self.channel_types.len() >= 1024 && !self.channel_types.contains_key(&frame.channel)
            {
                return Err(perr("Too many band input channels"));
            }
            self.channel_types.insert(frame.channel, kind);
        }
        let Some(&kind) = self.channel_types.get(&frame.channel) else {
            return Ok(Vec::new());
        };
        if self.ceremony.is_some() && self.setup_stage == SetupStage::Ceremony && !self.stopping {
            return self.receive_ceremony(frame, outgoing);
        }
        if self.enrollment.is_some() && self.setup_stage == SetupStage::Identity && !self.stopping {
            return self.receive_identity(frame, outgoing);
        }
        if kind == LINK_SETUP
            && route(frame.channel) == 0x8001
            && self.setup_stage == SetupStage::Link
            && !self.stopping
        {
            let fields = ProtoFields::parse(&frame.payload)?;
            if fields.required_integer(1)? != 1 {
                return Err(perr(
                    "The band couldn't finish setting up the connection. Try reconnecting.",
                ));
            }
            self.setup_stage = SetupStage::DeviceInfo;
            let info = self.device_info_request()?;
            outgoing.extend(self.encrypt(&info)?);
            return Ok(Vec::new());
        }
        if route(frame.channel) & 0x7fff == BATTERY_CHANNEL & 0x7fff && !self.stopping {
            if kind == SERVICE_REJECTED {
                self.battery_request = None;
                self.battery_unavailable = true;
                return Ok(vec![Event::BatteryStatus(None)]);
            }
            if kind == RPC_RESPONSE
                && let Some((id, _)) = self.battery_request
            {
                // Optional status errors must not interrupt gestures or EMG.
                let matches = ProtoFields::parse(&frame.payload)
                    .ok()
                    .and_then(|fields| fields.required_integer(1).ok())
                    == Some(id);
                if !matches {
                    return Ok(Vec::new());
                }
                self.battery_request = None;
                return Ok(vec![Event::BatteryStatus(
                    BatteryStatus::from_response(&frame.payload).ok(),
                )]);
            }
            return Ok(Vec::new());
        }
        if kind & 0xff00_0000 == 0x0300_0000
            && self.setup_stage == SetupStage::Input
            && !self.stopping
            && self.model.rejected(route(frame.channel), time)
        {
            // An error word on the channel a handwriting request waits on (the band refusing
            // that service): the capture fails and restores at once instead of timing out.
            let mut events = self.model_events();
            let (bytes, more) = self.flush_handwriting(time)?;
            outgoing.extend(bytes);
            events.extend(more);
            return Ok(events);
        }
        if kind == SERVICE_REJECTED && !self.stopping {
            if route(frame.channel) == 3 && self.setup_stage == SetupStage::DeviceInfo {
                return Err(perr("The band rejected gesture setup. Try reconnecting."));
            }
            if let Some(raw) = self.raw_request
                && (route(frame.channel) == 7
                    || (route(frame.channel) == 5 && raw.stage != RawStage::Config))
            {
                self.raw_request = None;
                return Ok(vec![Event::RawEmgFailure(
                    "The band rejected the EMG request.".into(),
                )]);
            }
            if route(frame.channel) == 5 && self.setup_stage == SetupStage::Input {
                return Err(perr(
                    "The band rejected the input subscription. Try reconnecting.",
                ));
            }
            if route(frame.channel) == 6 && self.device_state_request.take().is_some() {
                return Ok(vec![Event::DeviceStateReply(format!(
                    "device state request rejected, payload {}",
                    frame.payload.iter().map(|x| format!("{x:02x}")).collect::<String>()
                ))]);
            }
            if route(frame.channel) == 6 && self.hand_request.is_some() {
                self.hand_request = None;
                self.hand = None;
                return Ok(vec![Event::HandednessFailure(
                    "The band couldn't report its hand setting. Reconnect and try again.".into(),
                )]);
            }
            return Ok(Vec::new());
        }
        // Ignore unrelated services without trying to interpret their protobuf schema.
        if ![RPC_RESPONSE, RAW_EMG, GESTURE, GYRO, ORIENTATION, INFERENCE].contains(&kind) {
            return Ok(Vec::new());
        }
        if kind == RPC_RESPONSE
            && route(frame.channel) == 3
            && self.setup_stage == SetupStage::DeviceInfo
            && !self.stopping
        {
            let fields = ProtoFields::parse(&frame.payload)?;
            if fields.required_integer(1)? != 1 {
                return Ok(Vec::new());
            }
            if fields.required_integer(2)? != 1 {
                return Err(perr("The band rejected gesture setup. Try reconnecting."));
            }
            self.setup_stage = SetupStage::Input;
            let open = self.stream_request(2, None)?;
            let enable = self.stream_request(3, Some(true))?;
            let hand = self.request_hand(None, true, time)?;
            outgoing.extend(open);
            outgoing.extend(enable);
            outgoing.extend(hand);
            return Ok(Vec::new());
        }
        if self.setup_stage != SetupStage::Input {
            return Ok(Vec::new());
        }
        if kind == RPC_RESPONSE
            && !self.stopping
            && self.model.receive(route(frame.channel), &frame.payload, time)
        {
            // The capture's answer: send its next request right away.
            let mut events = self.model_events();
            let (bytes, more) = self.flush_handwriting(time)?;
            outgoing.extend(bytes);
            events.extend(more);
            return Ok(events);
        }
        if kind == RPC_RESPONSE && route(frame.channel) & 0x7fff == CONFIGURATION_CHANNEL & 0x7fff {
            if self.stopping {
                return Ok(Vec::new());
            }
            let fields = ProtoFields::parse(&frame.payload)?;
            if let Some((id, state)) = self.device_state_request {
                if fields.integer(1).ok() == Some(id) {
                    self.device_state_request = None;
                    let status = fields.integer(2).map(|s| s.to_string()).unwrap_or_else(|_| "none".into());
                    let config = if fields.contains(6) {
                        fields.bytes(6).map(|b| b.iter().map(|x| format!("{x:02x}")).collect::<String>()).unwrap_or_default()
                    } else {
                        "-".into()
                    };
                    return Ok(vec![Event::DeviceStateReply(format!(
                        "device state {state} reply: status {status}, config {config}, payload {}",
                        frame.payload.iter().map(|x| format!("{x:02x}")).collect::<String>()
                    ))]);
                }
            }
            return self.receive_hand(&fields, time, outgoing);
        }
        if kind == RPC_RESPONSE
            && !self.stopping
            && let Some(pending) = self.raw_request
            && let Some(events) = self.receive_raw(frame, pending, outgoing)?
        {
            return Ok(events);
        }
        if kind == RPC_RESPONSE && route(frame.channel) != STREAM_CHANNEL & 0x7fff {
            return Ok(Vec::new());
        }
        if kind == RPC_RESPONSE {
            let fields = ProtoFields::parse(&frame.payload)?;
            let request = fields.integer(1)?;
            if request == 3 || request == 5 {
                if self.stopping {
                    return Ok(Vec::new());
                }
                if fields.integer(2)? != 1 {
                    return Err(perr("The band rejected the input subscription"));
                }
                let flags = ProtoFields::parse(fields.bytes(5)?)?;
                // Gestures must stay on unless turned off on purpose; motion may be off while it
                // isn't wanted.
                if self.gestures && !all_set(&flags, &[GESTURE_FIELD], 1)? {
                    return Err(perr("The band input subscription stopped"));
                }
                self.streams_enabled = true;
                self.motion_active = all_set(&flags, &MOTION_FIELDS, 1)?;
                if self.motion_active != self.motion && self.motion {
                    return Err(perr("The band input subscription stopped"));
                }
                if request == 3 && self.raw_emg && self.raw_request.is_none() {
                    let raw = self.set_raw_emg_enabled(true, time)?;
                    outgoing.extend(raw);
                }
                if !self.streaming {
                    self.streaming = true;
                    return Ok(vec![Event::Connected]);
                }
            } else if request == 4 && fields.integer(2)? == 1 && fields.contains(5) {
                let flags = ProtoFields::parse(fields.bytes(5)?)?;
                let mut expected = STREAM_FIELDS.to_vec();
                if self.raw_requested {
                    expected.insert(0, 2);
                }
                self.stop_acknowledged = all_set(&flags, &expected, 0)?;
            }
            return Ok(Vec::new());
        }
        if self.stopping {
            return Ok(Vec::new());
        }
        if kind == INFERENCE {
            return Ok(self.receive_inference(&frame.payload, time));
        }
        if kind == RAW_EMG {
            // Keep the original payload for recordings, including unknown encodings.
            self.raw_emg_frames += 1;
            self.raw_emg_bytes += frame.payload.len();
            let mut events = Vec::new();
            if !self.streaming {
                self.streaming = true;
                events.push(Event::Connected);
                events.push(Event::Heartbeat);
                self.last_heartbeat = time;
            }
            events.push(Event::RawEmgFrame(frame.payload.clone()));
            events.push(Event::DataSeen);
            return Ok(events);
        }
        let fields = ProtoFields::parse(&frame.payload)?;
        let sequence = fields.required_integer(1)?;
        let timestamp = fields.required_integer(2)?;
        let mut events = Vec::new();
        if kind == GESTURE {
            let gesture = GestureMessage {
                sequence,
                timestamp_us: timestamp,
                finger: table_name(&FINGERS, fields.integer(3)?),
                action: table_name(&ACTIONS, fields.integer(4)?),
                derived_action: table_name(&DERIVED, fields.integer(5)?),
                synthetic: fields.integer(12)? != 0,
                received_at: time,
            };
            self.dial.gesture(&gesture, time);
            events.push(Event::Gesture(gesture));
            events.extend(self.engagement_events());
        } else {
            let bytes = fields
                .bytes_len(3, if kind == GYRO { 6 } else { 16 })?
                .to_vec();
            self.motion_messages += 1;
            if !self.streaming {
                self.streaming = true;
                events.push(Event::Connected);
                events.push(Event::Heartbeat);
                self.last_heartbeat = time;
            }
            if kind == GYRO {
                let values: [f64; 3] = std::array::from_fn(|i| {
                    f64::from(i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]))
                });
                if self.motion_samples {
                    events.push(Event::Gyro {
                        timestamp_us: timestamp,
                        raw: std::array::from_fn(|i| i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]])),
                    });
                }
                let delta = self.dial.gyro(timestamp, values, time);
                events.extend(self.engagement_events());
                if let Some(delta) = delta {
                    self.dial_pending += delta;
                    if time - self.last_dial >= 0.02 {
                        events.push(Event::DialTurn(self.dial_pending));
                        self.last_dial = time;
                        self.dial_pending = 0.0;
                    }
                }
            } else {
                let values: [f32; 4] = std::array::from_fn(|i| {
                    f32::from_le_bytes([
                        bytes[i * 4],
                        bytes[i * 4 + 1],
                        bytes[i * 4 + 2],
                        bytes[i * 4 + 3],
                    ])
                });
                let norm: f32 = values.iter().map(|v| v * v).sum();
                if !values.iter().all(|v| v.is_finite()) || !(0.9..=1.1).contains(&norm) {
                    self.bad_orientation += 1;
                    if self.bad_orientation >= BAD_ORIENTATION_LIMIT {
                        return Err(perr("Invalid band orientation sample"));
                    }
                } else {
                    self.bad_orientation = 0;
                    if self.motion_samples {
                        events.push(Event::Orientation { timestamp_us: timestamp, quaternion: values });
                    }
                }
            }
        }
        events.push(Event::DataSeen);
        Ok(events)
    }

    /// The staged raw-sEMG change: config read (0x8007) → status query → update.
    /// Returns `None` when the frame isn't the pending reply.
    fn receive_raw(
        &mut self,
        frame: &DataXFrame,
        pending: RawRequest,
        outgoing: &mut Vec<u8>,
    ) -> Result<Option<Vec<Event>>> {
        let fields = ProtoFields::parse(&frame.payload)?;
        let expected = if pending.stage == RawStage::Config {
            CONFIG_SERVICE_CHANNEL
        } else {
            STREAM_CHANNEL
        };
        if route(frame.channel) & 0x7fff != expected & 0x7fff || fields.integer(1)? != pending.id {
            return Ok(None);
        }
        if fields.integer(2)? != 1 {
            self.raw_request = None;
            return Ok(Some(vec![Event::RawEmgFailure(
                "The band rejected the EMG change. Gestures remain requested.".into(),
            )]));
        }
        match pending.stage {
            RawStage::Config => {
                let Ok(config) = EmgConfig::from_response(&frame.payload) else {
                    self.raw_request = None;
                    return Ok(Some(vec![Event::RawEmgFailure(
                        "The band didn't provide a readable EMG configuration.".into(),
                    )]));
                };
                self.raw_request_id += 1;
                let id = self.raw_request_id;
                self.raw_request = Some(RawRequest {
                    stage: RawStage::Query,
                    id,
                    ..pending
                });
                let query = self.stream_request(id, None)?;
                outgoing.extend(query);
                Ok(Some(vec![Event::RawEmgConfiguration(config)]))
            }
            RawStage::Query => {
                self.raw_request_id += 1;
                let id = self.raw_request_id;
                self.raw_request = Some(RawRequest {
                    stage: RawStage::Update,
                    id,
                    ..pending
                });
                let update = self.raw_stream_update(id, pending.enabled)?;
                outgoing.extend(update);
                Ok(Some(Vec::new()))
            }
            RawStage::Update => {
                self.raw_request = None;
                let flags = ProtoFields::parse(fields.bytes(5)?)?;
                for field in STREAM_FIELDS {
                    if flags.integer(field)? != 1 {
                        return Err(perr(
                            "The band stopped gesture streams during the EMG change. Reconnect with readings off.",
                        ));
                    }
                }
                if flags.integer(2)? != u64::from(pending.enabled) {
                    return Ok(Some(vec![Event::RawEmgFailure(
                        "The band didn't accept EMG alongside gestures.".into(),
                    )]));
                }
                Ok(Some(vec![Event::RawEmgState(pending.enabled)]))
            }
        }
    }
}
