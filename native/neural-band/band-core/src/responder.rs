//! An auto-answering simulated band driven purely by bytes: the band side of a
//! whole connection (handshake, trust, ceremony, subscription, hand, battery,
//! raw sEMG, stop) for daemon tests and `air-gesturesd --dry-run`. Nothing is secret.

use p256::ecdsa::SigningKey;

use crate::airshield::Variant;
use crate::datax::{DataXFrame, be16, encode_frame};
use crate::error::Result;
use crate::identity::point64;
use crate::proto::{ProtoFields, field_bytes, field_int};
use crate::sim::{SimBand, SimHandshake};

pub const SIM_SERIAL: &str = "SIMBAND0001";
/// The settings of a current band, in id order from 1 (as one reported them on 2026-10-05).
pub const SIM_SETTINGS: [&str; 40] = [
    "inf_filter", "inf_downsample", "band-tightness-threshold", "trigger-band-tightness",
    "trigger-multi-tightness", "settings-reset", "battery_update", "battery_is_multicast", "bcm",
    "lepc-golden-range", "le-power-control", "le-tx-max-power-level", "le-tx-init-power-level",
    "positron-telemetry", "quat_stream_mode", "quat_stream_frequency", "wrist_encoding",
    "normalized-inference", "use-custom-metadata", "load-flash-model", "enable-partial-gestures",
    "load-model-bank-models", "gyro-bias", "accel-bias", "coredump_collect", "index_ia_enabled",
    "stream_in_standby", "data-collection", "data-collection-model", "haptics",
    "imu_calibration_applied", "auto-off-btd", "auto-standby-timeout-secs", "standby-gesture",
    "wake-gesture", "middle-wake-enabled", "hand", "led_on_gestures", "trigger-haptics",
    "keep-alive",
];
const RPC: u32 = 0x02000315;
const DEVICE_RECEIPT: &str =
    r#"{"receipt_type":"DevicePendingOwnershipReceipt","additional_data":"{}"}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimMode {
    /// A band in pairing mode answering the legacy startup.
    Legacy,
    /// A band owned by this host: answers EnableTrust with its identity proof.
    Enrolled,
    /// A band in pairing mode that runs the ownership ceremony, then trusts the new owner.
    Ceremony,
}

enum State {
    Request,
    Enable(SimHandshake),
    Ready(Box<SimBand>),
    Broken,
}

pub struct Responder {
    mode: SimMode,
    state: State,
    pending: Vec<u8>,
    band_key: SigningKey,
    /// Answer EnableTrust with this result word instead of success (e.g. 0x03001043).
    pub reject_identity: Option<u32>,
    /// Answer StartChangeOwner with this result word (e.g. 0x03001042, wrong account).
    pub reject_claim: Option<u32>,
    /// Answer FinishChangeOwner with this result word (the band does not commit).
    pub reject_finish: Option<u32>,
    /// ConfigResp field 10: 0 = right, 1 = left.
    pub hand: u64,
    /// (level, charging flag).
    pub battery: (u64, Option<u64>),
    /// Stop answering (the band went quiet); requests are still decrypted.
    pub silent: bool,
    /// Newer firmware keying with this variant (`None`: the scheme-3 band).
    pub firmware: Option<Variant>,
    /// A host packet has authenticated (the keys agreed).
    decrypted: bool,
    /// SHA-256 of the trusted owner's 64-byte app point (EnableTrust field 1).
    /// `None` accepts (and adopts) whichever key claims trust first.
    owner: Option<[u8; 32]>,
    /// Set once an EnableTrust exchange has been accepted.
    trusted: bool,
    streams: u64,
    motion: u64,
    raw: u64,
    sequence: u64,
    finish_seen: bool,
    stopped: bool,
    /// The model's streams (control fields 4, 22, 23).
    model_streams: u64,
    /// Setting values by id - 1 ([SIM_SETTINGS]); `data-collection` 0, `data-collection-model` 2.
    pub settings: Vec<u64>,
    /// Every setting write, as (id, value).
    pub writes: Vec<(u64, u64)>,
    /// Settings whose lookup gets no answer.
    pub silent_lookups: Vec<u64>,
}

fn frame_size(buffer: &[u8]) -> Option<usize> {
    if buffer.len() < 4 {
        return None;
    }
    let size = usize::from(be16(buffer, 0) & 0x7fff) + 4;
    (buffer.len() >= size).then_some(size)
}

fn reply(band: &mut SimBand, channel: u16, word: u32, payload: &[u8]) -> Result<Vec<u8>> {
    band.encrypt(&encode_frame(channel, &[word], payload)?)
}

impl Responder {
    pub fn new(mode: SimMode, band_key: SigningKey) -> Self {
        Self {
            mode,
            state: State::Request,
            pending: Vec::new(),
            band_key,
            reject_identity: None,
            reject_claim: None,
            reject_finish: None,
            hand: 0,
            battery: (80, Some(0)),
            silent: false,
            firmware: None,
            decrypted: false,
            owner: None,
            trusted: false,
            streams: 0,
            motion: 0,
            raw: 0,
            sequence: 0,
            finish_seen: false,
            stopped: false,
            model_streams: 0,
            settings: SIM_SETTINGS
                .iter()
                .map(|name| if *name == "data-collection-model" { 2 } else { 0 })
                .collect(),
            writes: Vec::new(),
            silent_lookups: Vec::new(),
        }
    }

    /// A setting's value by name.
    pub fn setting(&self, name: &str) -> u64 {
        let index = SIM_SETTINGS.iter().position(|n| *n == name).expect("known setting");
        self.settings[index]
    }

    /// Whether the model streams are on.
    pub fn model_streams(&self) -> bool {
        self.model_streams == 1
    }

    /// One handwriting sample whose most likely class is `class` (sent only while the model
    /// runs: streams on and `data-collection-model` = 5).
    pub fn handwriting(&mut self, class: usize) -> Result<Vec<u8>> {
        if self.model_streams != 1 || self.setting("data-collection-model") != 5 || self.silent {
            return Ok(Vec::new());
        }
        self.sequence += 1;
        let sequence = self.sequence;
        let rest = (1.0 - 0.9) / 99.0;
        let values: Vec<u8> = (0..100)
            .flat_map(|index| {
                let p: f64 = if index == class { 0.9 } else { rest };
                (p.ln() as f32).to_le_bytes()
            })
            .collect();
        let band = self.ready()?;
        band.stamp += 15_625;
        let payload = [
            field_int(1, sequence),
            field_int(2, band.stamp),
            field_bytes(3, &values),
            field_int(10, 3),
        ]
        .concat();
        band.encrypt(&encode_frame(0x8010, &[0x0200020c], &payload)?)
    }

    /// The settings service: count (`{1:{1:2}}`), lookup (`{2:{1:2,2:id}}`), read and write
    /// (`{3:{1:id,2:write?,7|10:{1:value}}}`), answered as a current band does.
    fn settings_answer(&mut self, band: &mut SimBand, frame: &DataXFrame) -> Result<Vec<u8>> {
        let fields = ProtoFields::parse(&frame.payload)?;
        let id = fields.integer(1)?;
        let Ok(request) = fields.bytes(14).and_then(ProtoFields::parse) else {
            return Ok(Vec::new());
        };
        let answer = if request.contains(1) {
            field_bytes(1, &field_int(1, SIM_SETTINGS.len() as u64))
        } else if request.contains(2) {
            let setting = ProtoFields::parse(request.bytes(2)?)?.integer(2)?;
            if self.silent_lookups.contains(&setting) {
                return Ok(Vec::new());
            }
            let Some(name) = SIM_SETTINGS.get(setting as usize - 1) else {
                return reply(band, 1, RPC, &[field_int(1, id), field_int(2, 0)].concat());
            };
            field_bytes(
                2,
                &[
                    field_bytes(1, b"title"),
                    field_bytes(2, b"description"),
                    field_bytes(3, name.as_bytes()),
                    field_int(4, setting),
                ]
                .concat(),
            )
        } else {
            let body = ProtoFields::parse(request.bytes(3)?)?;
            let setting = body.integer(1)?;
            let writing = body.integer(2)? == 1;
            let index = setting as usize - 1;
            let boolean = SIM_SETTINGS[index] == "data-collection";
            if writing {
                let field = if boolean { 7 } else { 10 };
                let value = ProtoFields::parse(body.bytes(field)?)?.integer(1)?;
                self.settings[index] = value;
                self.writes.push((setting, value));
            }
            let value = field_bytes(if boolean { 8 } else { 11 }, &field_int(1, self.settings[index]));
            field_bytes(
                3,
                &[field_int(1, setting), field_int(2, u64::from(writing)), field_int(3, 0), value]
                    .concat(),
            )
        };
        reply(
            band,
            1,
            RPC,
            &[field_int(1, id), field_int(2, 1), field_bytes(14, &answer)].concat(),
        )
    }

    /// The band identity key's 64-byte point (what the ownership server reports).
    pub fn band_point(&self) -> Vec<u8> {
        point64(self.band_key.verifying_key())
    }

    /// SHA-256 of the trusted owner's app point, once one has been adopted.
    pub fn owner(&self) -> Option<[u8; 32]> {
        self.owner
    }

    /// Restrict (or, with `None`, reopen) which owner's EnableTrust is accepted.
    pub fn set_owner(&mut self, owner: Option<[u8; 32]>) {
        self.owner = owner;
    }

    /// True once FinishChangeOwner reached the band.
    pub fn finish_seen(&self) -> bool {
        self.finish_seen
    }

    /// True once the band acknowledged a stop request.
    /// Whether any host packet has authenticated on this connection.
    pub fn decrypted(&self) -> bool {
        self.decrypted
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    /// Consume host bytes and return every reply the band sends.
    pub fn respond(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            match std::mem::replace(&mut self.state, State::Broken) {
                State::Request => {
                    let Some(size) = frame_size(&self.pending) else {
                        self.state = State::Request;
                        break;
                    };
                    let request: Vec<u8> = self.pending.drain(..size).collect();
                    let (handshake, answer) = SimHandshake::accept(&request, self.firmware)?;
                    out.extend(answer);
                    self.state = State::Enable(handshake);
                }
                State::Enable(handshake) => {
                    let Some(size) = frame_size(&self.pending) else {
                        self.state = State::Enable(handshake);
                        break;
                    };
                    let enable: Vec<u8> = self.pending.drain(..size).collect();
                    self.state = State::Ready(Box::new(handshake.finish(&enable)?));
                }
                State::Ready(mut band) => {
                    let bytes = std::mem::take(&mut self.pending);
                    let frames = band.requests(&bytes);
                    self.decrypted |= frames.as_ref().is_ok_and(|frames| !frames.is_empty());
                    let result = frames.and_then(|frames| {
                        let mut answers = Vec::new();
                        for frame in &frames {
                            answers.extend(self.answer(&mut band, frame)?);
                        }
                        Ok(answers)
                    });
                    self.state = State::Ready(band);
                    out.extend(result?);
                    break;
                }
                State::Broken => {
                    return Err(crate::error::BandError::Protocol(
                        "sim: responder is broken".into(),
                    ));
                }
            }
        }
        Ok(if self.silent { Vec::new() } else { out })
    }

    fn ready(&mut self) -> Result<&mut SimBand> {
        match &mut self.state {
            State::Ready(band) => Ok(band.as_mut()),
            _ => Err(crate::error::BandError::Protocol(
                "sim: not connected yet".into(),
            )),
        }
    }

    /// A recognized-gesture message (finger/action/derived use the band's enum values).
    pub fn gesture(&mut self, action: u64, finger: u64, derived: u64) -> Result<Vec<u8>> {
        if self.streams != 1 || self.stopped || self.silent {
            return Ok(Vec::new());
        }
        self.sequence += 1;
        let sequence = self.sequence;
        let band = self.ready()?;
        band.stamp += 10_000;
        let payload = [
            field_int(1, sequence),
            field_int(2, band.stamp),
            field_int(3, finger),
            field_int(4, action),
            field_int(5, derived),
        ]
        .concat();
        band.encrypt(&encode_frame(0x8010, &[0x0200020d], &payload)?)
    }

    /// One gyro sample 10 ms after the previous one.
    pub fn gyro(&mut self, x: i16) -> Result<Vec<u8>> {
        if self.streams != 1 || self.stopped || self.silent {
            return Ok(Vec::new());
        }
        let band = self.ready()?;
        band.stamp += 10_000;
        let axes = [x.to_le_bytes(), 0i16.to_le_bytes(), 0i16.to_le_bytes()].concat();
        let payload = [
            field_int(1, band.stamp),
            field_int(2, band.stamp),
            field_bytes(3, &axes),
        ]
        .concat();
        band.encrypt(&encode_frame(0x8010, &[0x0200020f], &payload)?)
    }

    /// One raw sEMG batch (256 bytes of mid-scale samples).
    pub fn raw_emg(&mut self) -> Result<Vec<u8>> {
        if self.raw != 1 || self.silent {
            return Ok(Vec::new());
        }
        self.sequence += 1;
        let sequence = self.sequence;
        let band = self.ready()?;
        band.stamp += 7_813;
        let payload = [
            field_int(1, sequence),
            field_int(2, band.stamp),
            field_bytes(3, &[0x80; 256]),
        ]
        .concat();
        band.encrypt(&encode_frame(5, &[0x0200020a], &payload)?)
    }

    fn answer(&mut self, band: &mut SimBand, frame: &DataXFrame) -> Result<Vec<u8>> {
        let kind = frame.words.last().copied();
        match (frame.channel, kind) {
            (0x8002, Some(0x02003000)) if self.mode == SimMode::Ceremony => {
                let payload = [
                    field_bytes(1, &[1; 967]),
                    field_bytes(2, SIM_SERIAL.as_bytes()),
                    field_bytes(5, &[2; 889]),
                ]
                .concat();
                reply(band, 2, 0x02003001, &payload)
            }
            // The legacy empty identity query needs no answer.
            (0x8002, Some(0x02003000)) => Ok(Vec::new()),
            (0x8002, Some(0x02002000)) => {
                let nonce: Vec<u8> = (0..16).collect();
                reply(band, 2, 0x02002001, &field_bytes(1, &nonce))
            }
            (0x8002, Some(0x02002002)) => match self.reject_claim {
                Some(code) => reply(band, 2, code, &[]),
                None => {
                    let signature = [vec![0x30, 0x44], vec![4; 68]].concat();
                    reply(
                        band,
                        2,
                        0x02002003,
                        &[
                            field_bytes(1, &signature),
                            field_bytes(2, DEVICE_RECEIPT.as_bytes()),
                        ]
                        .concat(),
                    )
                }
            },
            (0x8002, Some(0x02002004)) => {
                if let Some(code) = self.reject_finish {
                    return reply(band, 2, code, &[]);
                }
                self.finish_seen = true;
                self.mode = SimMode::Enrolled;
                reply(band, 2, 0x02002005, &[])
            }
            (0x8002, Some(0x02001000)) => {
                if let Some(code) = self.reject_identity {
                    return reply(band, 2, code, &[]);
                }
                let claimed: [u8; 32] = ProtoFields::parse(&frame.payload)?
                    .bytes_len(1, 32)?
                    .try_into()
                    .expect("length checked");
                // Legacy bands have no owner to check against, and a ceremony
                // only trusts a new owner once it has committed the claim (by
                // which point `mode` has already flipped to `Enrolled`).
                let allowed = self.mode == SimMode::Enrolled
                    && self.owner.is_none_or(|owner| owner == claimed);
                if !allowed {
                    return reply(band, 2, 0x03001043, &[]);
                }
                self.owner.get_or_insert(claimed);
                self.trusted = true;
                let mut out = reply(band, 2, 0x03001000, &[])?;
                let proof = band.trust_proof(&self.band_key)?;
                out.extend(band.encrypt(&proof)?);
                Ok(out)
            }
            (0x8001, Some(0x02001000)) => {
                if self.mode == SimMode::Enrolled && !self.trusted {
                    return Ok(Vec::new());
                }
                reply(
                    band,
                    0x8001,
                    0x02001000,
                    &[field_int(1, 1), field_bytes(2, &[1; 16])].concat(),
                )
            }
            (0x8001, Some(0x02000314) | None) => self.settings_answer(band, frame),
            (0x8003, _) => reply(
                band,
                3,
                RPC,
                &[field_int(1, 1), field_int(2, 1), field_bytes(4, &[])].concat(),
            ),
            (0x8005, _) => self.stream(band, frame),
            (0x8006, _) => {
                let fields = ProtoFields::parse(&frame.payload)?;
                let config = ProtoFields::parse(fields.bytes(5).unwrap_or(&[]))?;
                if config.contains(10) {
                    self.hand = config.integer(10)?;
                }
                let answer = [field_int(10, self.hand), field_int(2, 2048)].concat();
                reply(
                    band,
                    6,
                    RPC,
                    &[
                        field_int(1, fields.integer(1)?),
                        field_int(2, 1),
                        field_bytes(6, &answer),
                    ]
                    .concat(),
                )
            }
            (0x8007, _) => {
                let id = ProtoFields::parse(&frame.payload)?.integer(1)?;
                let emg = [
                    field_int(1, 2048),
                    field_int(2, 8),
                    field_int(4, 16),
                    field_int(5, 16),
                    field_int(10, 0),
                ]
                .concat();
                reply(
                    band,
                    7,
                    RPC,
                    &[
                        field_int(1, id),
                        field_int(2, 1),
                        field_bytes(6, &field_bytes(42, &emg)),
                    ]
                    .concat(),
                )
            }
            (0x8008, _) => {
                let id = ProtoFields::parse(&frame.payload)?.integer(1)?;
                let (level, charging) = self.battery;
                let mut battery = field_int(1, level);
                if let Some(charging) = charging {
                    battery.extend(field_int(2, charging));
                }
                reply(
                    band,
                    8,
                    RPC,
                    &[
                        field_int(1, id),
                        field_int(2, 1),
                        field_bytes(3, &field_bytes(1, &battery)),
                    ]
                    .concat(),
                )
            }
            _ => Ok(Vec::new()),
        }
    }

    /// The input subscription channel: open (id 2, no reply), enable/update
    /// (apply the control flags), status query (empty control), stop (id 4).
    fn stream(&mut self, band: &mut SimBand, frame: &DataXFrame) -> Result<Vec<u8>> {
        let fields = ProtoFields::parse(&frame.payload)?;
        let id = fields.integer(1)?;
        if id == 2 {
            return Ok(Vec::new());
        }
        let control = ProtoFields::parse(fields.bytes(4).unwrap_or(&[]))?;
        if control.contains(2) {
            self.raw = control.integer(2)?;
        }
        if control.contains(3) {
            self.streams = control.integer(3)?;
            self.motion = self.streams;
        }
        // The motion streams can be set apart from the gestures (power saving).
        if control.contains(6) {
            self.motion = control.integer(6)?;
        }
        if control.contains(4) {
            self.model_streams = control.integer(4)?;
        }
        if id == 4 && self.streams == 0 {
            self.stopped = true;
        }
        let flags = [
            field_int(2, self.raw),
            field_int(3, self.streams),
            field_int(4, self.model_streams),
            field_int(6, self.motion),
            field_int(8, self.motion),
            field_int(22, self.model_streams),
            field_int(23, self.model_streams),
        ]
        .concat();
        reply(
            band,
            5,
            RPC,
            &[field_int(1, id), field_int(2, 1), field_bytes(5, &flags)].concat(),
        )
    }
}
