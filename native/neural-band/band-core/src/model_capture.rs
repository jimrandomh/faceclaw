//! Turning the band's built-in handwriting model on for a while, and the band back to normal
//! (kinesis `BandModelCapture.swift`, MIT). It owns no transport: [crate::session::BandSession]
//! sends its requests on the open connection and hands it the answers.
//!
//! The model runs while two band settings are changed: `data-collection` on and
//! `data-collection-model` set to 5. Their ids differ between firmwares (27 and 28 in kinesis,
//! 28 and 29 on newer bands), so they are found by name, and nothing is ever written to a
//! setting that wasn't identified by its name (one of them, `settings-reset`, wipes them all).
//! Each write is read back, the band's own values are kept and written back at the end, and a
//! restore that loses an answer tries that step once more.

use std::collections::VecDeque;

use crate::error::{BandError, Result, perr};
use crate::handwriting::{HANDWRITING_PIPELINE, InferenceSample};
use crate::proto::{ProtoFields, field_bytes, field_int};

/// The settings service.
pub const SETTINGS_CHANNEL: u16 = 0x8001;
pub const STREAM_CHANNEL: u16 = 0x8005;
/// Stream control fields for the model's output: the inference stream (4) and two it needs.
pub const MODEL_STREAM_FIELDS: [u32; 3] = [4, 22, 23];
/// The settings request's oneof arm.
const SETTINGS_ARM: u32 = 14;
/// `data-collection-model` value of the handwriting model, and the band's normal values.
const HANDWRITING_MODEL: u64 = 5;
const NORMAL_MODEL: u64 = 2;
const NORMAL_COLLECTION: u64 = 0;
/// Answer time for a request; a settings lookup that doesn't answer is skipped sooner.
const REQUEST_TIMEOUT: f64 = 5.0;
const LOOKUP_TIMEOUT: f64 = 1.5;
/// Whole-operation limits: switching on, restoring, and silence while the model runs.
const PREPARE_LIMIT: f64 = 60.0;
const RESTORE_LIMIT: f64 = 35.0;
const READY_LIMIT: f64 = 360.0;
/// Request ids far above the session's own (stream 2–5, raw sEMG from 7).
const FIRST_ID: u64 = 0x1000_0000;

/// One of the two settings the model needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    /// `data-collection`, a boolean.
    Collection,
    /// `data-collection-model`, an enum.
    Model,
}

impl Setting {
    pub fn name(self) -> &'static str {
        match self {
            Self::Collection => "data-collection",
            Self::Model => "data-collection-model",
        }
    }

    /// The value's field in a write (7 boolean, 10 enum) and in a read (8, 11).
    fn write_field(self) -> u32 {
        match self {
            Self::Collection => 7,
            Self::Model => 10,
        }
    }

    fn read_field(self) -> u32 {
        match self {
            Self::Collection => 8,
            Self::Model => 11,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapturePhase {
    Idle,
    /// Finding the settings, switching the model on, waiting for its first samples.
    Preparing,
    /// Samples are coming: write.
    Ready,
    Restoring,
    Finished,
}

impl CapturePhase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Restoring => "restoring",
            Self::Finished => "finished",
        }
    }
}

/// Where the capture is. `verified` (when finished): the band's settings were read back as
/// normal, or were never changed.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureStatus {
    pub phase: CapturePhase,
    pub message: String,
    pub problem: Option<String>,
    pub verified: bool,
    /// The band's settings were written: they are owed a restore.
    pub mutated: bool,
    /// The settings' ids on this band (collection, model) once found: hints for next time.
    pub ids: Option<(u64, u64)>,
}

impl CaptureStatus {
    pub fn active(&self) -> bool {
        matches!(
            self.phase,
            CapturePhase::Preparing | CapturePhase::Ready | CapturePhase::Restoring
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Streams(bool),
    /// How many settings the band has.
    Count,
    /// Ask setting names until both are found.
    Lookup,
    Snapshot(Setting),
    Write(Setting, u64),
    Read(Setting, u64),
}

/// A request to send: the session encodes it on [ModelRequest::channel], with the service-open
/// words the first time on the settings channel.
#[derive(Debug, Clone, Copy)]
pub struct ModelRequest {
    pub id: u64,
    pub channel: u16,
    op: Op,
    /// The setting id the request is about (lookup, snapshot, write, read).
    setting: u64,
    deadline: f64,
}

impl ModelRequest {
    /// For a streams request, whether the model streams go on or off; the session sends its
    /// full stream control with it ([MODEL_STREAM_FIELDS] included).
    pub fn streams(&self) -> Option<bool> {
        match self.op {
            Op::Streams(on) => Some(on),
            _ => None,
        }
    }

    /// The request message; `streams` is the stream control (streams requests only).
    pub fn payload(&self, streams: &[u8]) -> Vec<u8> {
        let (arm, body) = match self.op {
            Op::Streams(_) => (4, streams.to_vec()),
            Op::Count => (SETTINGS_ARM, field_bytes(1, &field_int(1, 2))),
            Op::Lookup => (
                SETTINGS_ARM,
                field_bytes(2, &[field_int(1, 2), field_int(2, self.setting)].concat()),
            ),
            Op::Write(setting, value) => (
                SETTINGS_ARM,
                field_bytes(
                    3,
                    &[
                        field_int(1, self.setting),
                        field_int(2, 1),
                        field_bytes(setting.write_field(), &field_int(1, value)),
                    ]
                    .concat(),
                ),
            ),
            Op::Snapshot(_) | Op::Read(..) => (
                SETTINGS_ARM,
                field_bytes(3, &[field_int(1, self.setting), field_int(2, 0)].concat()),
            ),
        };
        [field_int(1, self.id), field_bytes(arm, &body)].concat()
    }
}

pub struct ModelCapture {
    status: CaptureStatus,
    stream_wanted: Option<bool>,
    pending: Option<ModelRequest>,
    ops: VecDeque<Op>,
    next_id: u64,
    mutated: bool,
    problem: Option<String>,
    restore_errors: Vec<String>,
    retried_restore: bool,
    /// A recovery is still checking the band's settings: a failure there writes nothing.
    checking_schema: bool,
    samples: usize,
    last_sample: f64,
    deadline: f64,
    events: Vec<CaptureStatus>,
    hints: Option<(u64, u64)>,
    candidates: VecDeque<u64>,
    collection: Option<u64>,
    model: Option<u64>,
    /// The band's own values, before this capture changed them.
    original_collection: Option<u64>,
    original_model: Option<u64>,
}

impl Default for ModelCapture {
    fn default() -> Self {
        Self {
            status: CaptureStatus {
                phase: CapturePhase::Idle,
                message: String::new(),
                problem: None,
                verified: false,
                mutated: false,
                ids: None,
            },
            stream_wanted: None,
            pending: None,
            ops: VecDeque::new(),
            next_id: FIRST_ID,
            mutated: false,
            problem: None,
            restore_errors: Vec::new(),
            retried_restore: false,
            checking_schema: false,
            samples: 0,
            last_sample: 0.0,
            deadline: f64::INFINITY,
            events: Vec::new(),
            hints: None,
            candidates: VecDeque::new(),
            collection: None,
            model: None,
            original_collection: None,
            original_model: None,
        }
    }
}

impl ModelCapture {
    pub fn status(&self) -> &CaptureStatus {
        &self.status
    }

    pub fn active(&self) -> bool {
        self.status.active()
    }

    /// The model streams as last requested (`None`: never touched on this connection).
    pub fn stream_wanted(&self) -> Option<bool> {
        self.stream_wanted
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Switch the model on. `hints`: the settings' ids found last time (collection, model);
    /// asked first, and trusted only if the band names them the same.
    pub fn start(&mut self, time: f64, hints: Option<(u64, u64)>) -> Result<()> {
        if self.active() {
            return Err(BandError::Busy("The band's handwriting is already running.".into()));
        }
        self.reset(hints);
        self.ops = [
            Op::Streams(true),
            Op::Count,
            Op::Lookup,
            Op::Snapshot(Setting::Collection),
            Op::Snapshot(Setting::Model),
            Op::Write(Setting::Collection, 1),
            Op::Write(Setting::Model, HANDWRITING_MODEL),
            Op::Read(Setting::Collection, 1),
            Op::Read(Setting::Model, HANDWRITING_MODEL),
        ]
        .into();
        self.deadline = time + PREPARE_LIMIT;
        self.publish(CapturePhase::Preparing, "switching the band to handwriting", false);
        Ok(())
    }

    /// Put the band's settings back to normal without knowing what they were: after an app or
    /// connection that ended mid-capture. Writes only once both settings are found by name.
    pub fn recover(&mut self, time: f64, hints: Option<(u64, u64)>) -> Result<()> {
        if self.active() {
            return Err(BandError::Busy("The band's handwriting is still running.".into()));
        }
        self.reset(hints);
        self.mutated = true;
        self.checking_schema = true;
        self.ops = [
            Op::Count,
            Op::Lookup,
            Op::Write(Setting::Model, NORMAL_MODEL),
            Op::Write(Setting::Collection, NORMAL_COLLECTION),
            Op::Read(Setting::Model, NORMAL_MODEL),
            Op::Read(Setting::Collection, NORMAL_COLLECTION),
            Op::Streams(false),
        ]
        .into();
        self.deadline = time + PREPARE_LIMIT;
        self.publish(CapturePhase::Restoring, "restoring the band's normal mode", false);
        Ok(())
    }

    /// End the capture: the band's own values back (or the normal ones), then streams off.
    pub fn restore(&mut self, time: f64) {
        if !self.active() || self.status.phase == CapturePhase::Restoring {
            return;
        }
        self.pending = None;
        let mut ops = VecDeque::new();
        if self.mutated && self.collection.is_some() && self.model.is_some() {
            let model = self.normal_model();
            let collection = self.normal_collection();
            ops.extend([
                Op::Write(Setting::Model, model),
                Op::Write(Setting::Collection, collection),
                Op::Read(Setting::Model, model),
                Op::Read(Setting::Collection, collection),
            ]);
        }
        ops.push_back(Op::Streams(false));
        self.ops = ops;
        self.deadline = time + RESTORE_LIMIT;
        self.publish(CapturePhase::Restoring, "restoring the band's normal mode", false);
    }

    /// The next request to send, if one is due; also runs the timeouts.
    pub fn next(&mut self, time: f64) -> Option<ModelRequest> {
        if !self.active() {
            return None;
        }
        if time >= self.deadline {
            // The whole operation ran out of time: no retry.
            self.fail("the band's handwriting timed out", time, false);
            if self.status.phase == CapturePhase::Restoring && time >= self.deadline {
                self.ops.clear();
                self.pending = None;
                self.complete();
                return None;
            }
        }
        if let Some(pending) = self.pending
            && time >= pending.deadline
        {
            if pending.op == Op::Lookup {
                // Some settings never answer a lookup: ask the next one.
                self.pending = None;
            } else {
                self.fail("the band didn't answer a handwriting request", time, true);
            }
        }
        if self.pending.is_some() || !self.active() {
            return None;
        }
        while let Some(&op) = self.ops.front() {
            if op == Op::Lookup {
                if self.collection.is_some() && self.model.is_some() {
                    self.ops.pop_front();
                    self.checking_schema = false;
                    continue;
                }
                let Some(candidate) = self.candidates.pop_front() else {
                    self.fail("the band's handwriting settings weren't found", time, false);
                    return self.next_after_failure(time);
                };
                return Some(self.send(Op::Lookup, candidate, time + LOOKUP_TIMEOUT));
            }
            self.ops.pop_front();
            let setting = match op {
                Op::Snapshot(setting) | Op::Write(setting, _) | Op::Read(setting, _) => {
                    match self.id_of(setting) {
                        Some(id) => id,
                        None => {
                            // Never write to a setting not identified by name.
                            self.fail("the band's handwriting settings weren't found", time, false);
                            return self.next_after_failure(time);
                        }
                    }
                }
                _ => 0,
            };
            match op {
                Op::Streams(on) => self.stream_wanted = Some(on),
                Op::Write(..) => {
                    self.mutated = true;
                    self.status.mutated = true;
                }
                _ => {}
            }
            return Some(self.send(op, setting, time + REQUEST_TIMEOUT));
        }
        match self.status.phase {
            CapturePhase::Restoring => self.complete(),
            CapturePhase::Preparing if self.samples >= 5 && time - self.last_sample < 2.0 => {
                self.deadline = time + READY_LIMIT;
                self.publish(CapturePhase::Ready, "write", false);
            }
            CapturePhase::Ready if time - self.last_sample > 3.0 => {
                self.fail("the band stopped sending handwriting", time, true);
                return self.next(time);
            }
            _ => {}
        }
        None
    }

    /// After a failure that switched to restoring, the restore's first request.
    fn next_after_failure(&mut self, time: f64) -> Option<ModelRequest> {
        if self.active() && self.pending.is_none() && !self.ops.is_empty() {
            self.next(time)
        } else {
            if self.status.phase == CapturePhase::Restoring && self.ops.is_empty() {
                self.complete();
            }
            None
        }
    }

    /// An RPC answer; false if it isn't the pending request's.
    pub fn receive(&mut self, channel: u16, payload: &[u8], time: f64) -> bool {
        let Some(pending) = self.pending else {
            return false;
        };
        if channel & 0x7fff != pending.channel & 0x7fff {
            return false;
        }
        let Ok(fields) = ProtoFields::parse(payload) else {
            return false;
        };
        if fields.integer(1).ok() != Some(pending.id) {
            return false;
        }
        let ok = fields.integer(2).ok() == Some(1) && time < pending.deadline;
        if !ok && pending.op == Op::Lookup {
            // A setting that won't describe itself: skip it.
            self.pending = None;
            return true;
        }
        let result = if ok {
            self.apply(&pending, &fields)
        } else {
            Err(perr("the band refused a handwriting request"))
        };
        match result {
            Ok(()) => self.pending = None,
            Err(error) => self.fail(&error.to_string(), time, true),
        }
        true
    }

    /// The band turned the pending request's service down (an error word on its channel).
    pub fn rejected(&mut self, channel: u16, time: f64) -> bool {
        let Some(pending) = self.pending else {
            return false;
        };
        if channel & 0x7fff != pending.channel & 0x7fff {
            return false;
        }
        self.fail("the band refused a handwriting request", time, true);
        true
    }

    /// An inference sample while the model runs; true when it's handwriting to decode.
    pub fn sample(&mut self, sample: &InferenceSample, time: f64) -> bool {
        if !self.active()
            || sample.pipeline != HANDWRITING_PIPELINE
            || self.status.phase == CapturePhase::Restoring
        {
            return false;
        }
        if !sample.is_text_distribution() {
            self.fail("the band's handwriting output has an unexpected shape", time, true);
            return false;
        }
        self.samples += 1;
        self.last_sample = time;
        if self.status.phase == CapturePhase::Ready {
            self.deadline = time + READY_LIMIT;
        }
        true
    }

    /// Status changes since the last call.
    pub fn drain(&mut self) -> Vec<CaptureStatus> {
        std::mem::take(&mut self.events)
    }

    fn reset(&mut self, hints: Option<(u64, u64)>) {
        self.pending = None;
        self.ops.clear();
        self.mutated = false;
        self.problem = None;
        self.restore_errors.clear();
        self.retried_restore = false;
        self.checking_schema = false;
        self.samples = 0;
        self.last_sample = 0.0;
        self.hints = hints;
        self.candidates.clear();
        self.collection = None;
        self.model = None;
        self.original_collection = None;
        self.original_model = None;
        self.status.mutated = false;
        self.status.ids = None;
    }

    fn send(&mut self, op: Op, setting: u64, deadline: f64) -> ModelRequest {
        self.next_id += 1;
        let request = ModelRequest {
            id: self.next_id,
            channel: if matches!(op, Op::Streams(_)) {
                STREAM_CHANNEL
            } else {
                SETTINGS_CHANNEL
            },
            op,
            setting,
            deadline,
        };
        self.pending = Some(request);
        request
    }

    fn id_of(&self, setting: Setting) -> Option<u64> {
        match setting {
            Setting::Collection => self.collection,
            Setting::Model => self.model,
        }
    }

    fn apply(&mut self, pending: &ModelRequest, fields: &ProtoFields) -> Result<()> {
        match pending.op {
            Op::Streams(on) => {
                let flags = ProtoFields::parse(fields.bytes(5)?)?;
                for field in MODEL_STREAM_FIELDS {
                    if flags.integer(field)? != u64::from(on) {
                        return Err(perr("the band didn't confirm the handwriting streams"));
                    }
                }
            }
            Op::Count => {
                let count = ProtoFields::parse(ProtoFields::parse(fields.bytes(SETTINGS_ARM)?)?.bytes(1)?)?
                    .integer(1)?;
                if count < 2 || count > 512 {
                    return Err(perr("the band has no handwriting settings"));
                }
                // The hints first (a band that kept its ids answers in two lookups), then all.
                let hinted: Vec<u64> = self
                    .hints
                    .map(|(collection, model)| vec![collection, model])
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|id| (1..=count).contains(id))
                    .collect();
                let rest = (1..=count).filter(|id| !hinted.contains(id));
                self.candidates = hinted.iter().copied().chain(rest).collect();
            }
            Op::Lookup => {
                let info = ProtoFields::parse(ProtoFields::parse(fields.bytes(SETTINGS_ARM)?)?.bytes(2)?)?;
                if info.integer(4)? == pending.setting {
                    let name = info.bytes(3).unwrap_or(&[]);
                    if name == Setting::Collection.name().as_bytes() {
                        self.collection = Some(pending.setting);
                    } else if name == Setting::Model.name().as_bytes() {
                        self.model = Some(pending.setting);
                    }
                    if let (Some(collection), Some(model)) = (self.collection, self.model) {
                        self.status.ids = Some((collection, model));
                    }
                }
            }
            Op::Snapshot(setting) | Op::Write(setting, _) | Op::Read(setting, _) => {
                let answer = ProtoFields::parse(ProtoFields::parse(fields.bytes(SETTINGS_ARM)?)?.bytes(3)?)?;
                let writing = matches!(pending.op, Op::Write(..));
                if answer.integer(1)? != pending.setting
                    || answer.integer(2)? != u64::from(writing)
                    || answer.integer(3)? != 0
                {
                    return Err(perr("the band refused a handwriting setting"));
                }
                if let Op::Read(_, expected) = pending.op {
                    let value = ProtoFields::parse(answer.bytes(setting.read_field())?)?.integer(1)?;
                    if value != expected {
                        return Err(perr("a handwriting setting read back differently"));
                    }
                }
                if let Op::Snapshot(_) = pending.op {
                    let value = ProtoFields::parse(answer.bytes(setting.read_field())?)?.integer(1)?;
                    match setting {
                        Setting::Collection => self.original_collection = Some(value),
                        Setting::Model => self.original_model = Some(value),
                    }
                }
            }
        }
        Ok(())
    }

    /// What a restore writes: the band's own values, unless they look like a capture left
    /// unfinished (collection on, or the handwriting model), then the normal ones.
    fn normal_collection(&self) -> u64 {
        self.original_collection
            .filter(|&value| value == NORMAL_COLLECTION)
            .unwrap_or(NORMAL_COLLECTION)
    }

    fn normal_model(&self) -> u64 {
        self.original_model
            .filter(|&value| value != HANDWRITING_MODEL)
            .unwrap_or(NORMAL_MODEL)
    }

    fn fail(&mut self, message: &str, time: f64, retry: bool) {
        let failed = self.pending.take().map(|request| request.op);
        if retry
            && self.status.phase == CapturePhase::Restoring
            && !self.checking_schema
            && !self.retried_restore
            && let Some(op) = failed
            && !matches!(op, Op::Count | Op::Lookup)
        {
            // One lost packet must not leave the band in the model.
            self.retried_restore = true;
            self.ops.push_front(op);
            return;
        }
        if self.status.phase == CapturePhase::Restoring {
            self.restore_errors.push(message.to_owned());
            if self.checking_schema {
                // A recovery that couldn't identify the settings writes nothing.
                self.ops.clear();
                self.checking_schema = false;
            }
        } else {
            self.problem = Some(message.to_owned());
            self.restore(time);
        }
    }

    fn complete(&mut self) {
        let verified = self.restore_errors.is_empty();
        if !verified {
            let mut problems: Vec<String> = self.problem.iter().cloned().collect();
            problems.extend(self.restore_errors.iter().cloned());
            self.problem = Some(problems.join("; "));
        }
        let message = match (verified, self.mutated) {
            (true, true) => "the band's normal mode is back",
            (true, false) => "the band's settings were never changed",
            (false, _) => "the band's normal mode couldn't be confirmed",
        };
        self.publish(CapturePhase::Finished, message, verified);
    }

    fn publish(&mut self, phase: CapturePhase, message: &str, verified: bool) {
        self.status = CaptureStatus {
            phase,
            message: message.to_owned(),
            problem: self.problem.clone(),
            verified,
            mutated: self.mutated,
            ids: self.collection.zip(self.model),
        };
        self.events.push(self.status.clone());
    }
}
