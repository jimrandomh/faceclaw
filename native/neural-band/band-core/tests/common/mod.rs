#![allow(dead_code)]

use band_core::Result;
use band_core::datax::DataXFrame;
use band_core::events::{Event, Hand};
use band_core::proto::{field_bytes as fb, field_int as fi};
use band_core::session::BandSession;
use band_core::sim::SimBand;

pub const LINK: u32 = 0x02001000;
pub const RPC: u32 = 0x02000315;
pub const REJECTED: u32 = 0x0300c001;
pub const RAW: u32 = 0x0200020a;
pub const GESTURE: u32 = 0x0200020d;
pub const GYRO: u32 = 0x0200020f;
pub const ORIENTATION: u32 = 0x02000212;
pub const SERVICE_OPEN: [u32; 2] = [0x8100ce56, 0x02000314];

/// A legacy (no identity) session connected to a simulated band — kinesis test `Peer`.
pub struct Peer {
    pub session: BandSession,
    pub band: SimBand,
    pub startup: Vec<DataXFrame>,
}

impl Peer {
    pub fn legacy(complete_setup: bool, raw_emg: bool) -> Peer {
        let mut session = BandSession::new(None, None, raw_emg);
        let (band, startup) = SimBand::connect(&mut session).unwrap();
        let mut peer = Peer {
            session,
            band,
            startup,
        };
        if complete_setup {
            let more = peer.band.complete_legacy_setup(&mut peer.session).unwrap();
            peer.startup.extend(more);
        }
        peer
    }

    pub fn exchange(
        &mut self,
        channel: u16,
        kind: u32,
        payload: &[u8],
        now: f64,
    ) -> Result<(Vec<Event>, Vec<DataXFrame>)> {
        self.band
            .exchange(&mut self.session, channel, kind, payload, now)
    }

    pub fn send(&mut self, kind: u32, payload: &[u8], now: f64) -> Result<Vec<Event>> {
        self.band.send(&mut self.session, kind, payload, now)
    }

    pub fn raw(&mut self, payload: &[u8], now: f64) -> Result<Vec<Event>> {
        self.band.raw(&mut self.session, payload, now)
    }

    pub fn gyro(&mut self, stamp: u64, now: f64) -> Result<Vec<Event>> {
        self.band.gyro(&mut self.session, stamp, 1000, now)
    }

    pub fn spin(&mut self, from: f64, through: f64) -> Result<Vec<Event>> {
        self.band.spin(&mut self.session, from, through)
    }

    /// Index finger, no derived action, not synthetic.
    pub fn gesture(&mut self, action: u64, now: f64) -> Result<Vec<Event>> {
        self.band.gesture(&mut self.session, action, 2, 0, 0, now)
    }

    pub fn gesture_with(
        &mut self,
        action: u64,
        finger: u64,
        derived: u64,
        synthetic: u64,
        now: f64,
    ) -> Result<Vec<Event>> {
        self.band
            .gesture(&mut self.session, action, finger, derived, synthetic, now)
    }

    pub fn requests(&mut self, bytes: &[u8]) -> Result<Vec<DataXFrame>> {
        self.band.requests(bytes)
    }

    pub fn hand_reply(
        &mut self,
        id: u64,
        value: Option<u64>,
        status: u64,
        channel: u16,
        now: f64,
    ) -> Result<(Vec<Event>, Vec<DataXFrame>)> {
        self.band
            .hand_reply(&mut self.session, id, value, status, channel, now)
    }
}

pub fn flags_on() -> Vec<u8> {
    [fi(3, 1), fi(6, 1), fi(8, 1)].concat()
}

pub fn flags_off() -> Vec<u8> {
    [fi(3, 0), fi(6, 0), fi(8, 0)].concat()
}

/// A subscription status reply with gestures/motion on and raw sEMG `raw`.
pub fn stream_reply(id: u64, raw: u64) -> Vec<u8> {
    [
        fi(1, id),
        fi(2, 1),
        fb(5, &[fi(2, raw), flags_on()].concat()),
    ]
    .concat()
}

/// A subscription status reply without the raw flag (kinesis `status(id)`).
pub fn status(id: u64) -> Vec<u8> {
    [fi(1, id), fi(2, 1), fb(5, &flags_on())].concat()
}

pub fn ready() -> Vec<u8> {
    [fi(1, 1), fb(2, &[1; 16])].concat()
}

pub fn device_ok() -> Vec<u8> {
    [fi(1, 1), fi(2, 1), fb(4, &[])].concat()
}

pub fn channels(frames: &[DataXFrame]) -> Vec<u16> {
    frames.iter().map(|frame| frame.channel).collect()
}

pub fn connected(events: &[Event]) -> bool {
    events.iter().any(|event| matches!(event, Event::Connected))
}

pub fn heartbeat(events: &[Event]) -> bool {
    events.iter().any(|event| matches!(event, Event::Heartbeat))
}

pub fn data_seen(events: &[Event]) -> bool {
    events.iter().any(|event| matches!(event, Event::DataSeen))
}

pub fn hands(events: &[Event]) -> Vec<Hand> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Handedness(hand) => Some(*hand),
            _ => None,
        })
        .collect()
}

pub fn hand_failure(events: &[Event]) -> bool {
    events
        .iter()
        .any(|event| matches!(event, Event::HandednessFailure(_)))
}

pub fn engagement(events: &[Event]) -> Vec<bool> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::DialState(on) => Some(*on),
            _ => None,
        })
        .collect()
}

pub fn movement(events: &[Event]) -> Vec<f64> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::DialTurn(delta) => Some(*delta),
            _ => None,
        })
        .collect()
}
