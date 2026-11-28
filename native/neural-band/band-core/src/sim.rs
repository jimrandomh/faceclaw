//! A scripted, encrypted band for tests and `pair --dry-run` (kinesis test `Peer`).
//! Its transport key is the public P-256 scalar 1; nothing here is secret.

use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey, ecdh};

use crate::airshield::{AirShieldCipher, AirShieldKeys, AirShieldReceiver, SCHEME_3, Variant};
use crate::datax::{DataXFrame, DataXReceiver, be16, be32, encode_frame};
use crate::error::{Result, perr};
use crate::events::Event;
use crate::identity::trust_digest;
use crate::proto::{ProtoFields, field_bytes, field_int};
use crate::session::BandSession;

pub struct SimBand {
    /// Band → host cipher.
    pub sender: AirShieldCipher,
    /// Host → band cipher.
    pub receiver: AirShieldReceiver,
    datax: DataXReceiver,
    pub transport_point: Vec<u8>,
    pub host_point: Vec<u8>,
    pub host_challenge: Vec<u8>,
    pub host_seed: Vec<u8>,
    pub band_challenge: Vec<u8>,
    pub band_seed: Vec<u8>,
    /// The band's own clock for `spin`, in microseconds.
    pub stamp: u64,
    /// Bits newer firmware sets on flagged (0x8000) channels it sends on.
    pub channel_tag: u16,
}

/// The band side of the transport handshake, driven from raw host bytes.
pub struct SimHandshake {
    transport: SecretKey,
    transport_point: Vec<u8>,
    band_challenge: Vec<u8>,
    band_seed: Vec<u8>,
    iv: [u8; 16],
    host_point: Vec<u8>,
    host_challenge: Vec<u8>,
    /// `Some` = newer firmware: offers 27, names 26 and keys with this variant.
    firmware: Option<Variant>,
}

impl SimHandshake {
    /// Answer the host's RequestEncryption frame (exactly one frame) with the
    /// band's RequestEncryption + EnableEncryption bytes.
    /// `firmware`: `None` is the scheme-3 band kinesis knows; `Some(variant)`
    /// is newer firmware that offers 27, names 26 and keys with `variant`.
    pub fn accept(
        host_request: &[u8],
        firmware: Option<Variant>,
    ) -> Result<(SimHandshake, Vec<u8>)> {
        if host_request.len() < 12 {
            return Err(perr("sim: short RequestEncryption"));
        }
        if be32(host_request, 8) != 0x02000001 {
            return Err(perr("sim: expected a RequestEncryption frame"));
        }
        let local = ProtoFields::parse(&host_request[12..])?;
        let host_point = local.bytes_len(1, 64)?.to_vec();
        let host_challenge = local.bytes_len(2, 16)?.to_vec();
        let mut scalar = [0u8; 32];
        scalar[31] = 1;
        let transport = SecretKey::from_slice(&scalar).expect("scalar 1 is a valid key");
        let transport_point =
            transport.public_key().to_encoded_point(false).as_bytes()[1..].to_vec();
        let band_challenge: Vec<u8> = (0..16).collect();
        let band_seed: Vec<u8> = (0..32).collect();
        let iv: [u8; 16] = std::array::from_fn(|i| 16 + i as u8);
        let peer_request = encode_frame(
            0x8001,
            &[0x81000005, 0x02000001],
            &[
                field_bytes(1, &transport_point),
                field_bytes(2, &band_challenge),
                field_int(3, 0),
                field_int(4, if firmware.is_some() { 27 } else { 3 }),
            ]
            .concat(),
        )?;
        let peer_enable = encode_frame(
            1,
            &[0x02000002],
            &[
                field_bytes(1, &transport_point),
                field_bytes(2, &band_seed),
                field_bytes(3, &iv),
                field_int(4, 42),
                field_int(5, if firmware.is_some() { 26 } else { 3 }),
            ]
            .concat(),
        )?;
        let handshake = SimHandshake {
            transport,
            transport_point,
            band_challenge,
            band_seed,
            iv,
            host_point,
            host_challenge,
            firmware,
        };
        Ok((handshake, [peer_request, peer_enable].concat()))
    }

    /// Take the host's EnableEncryption frame (exactly one frame) and derive both directions.
    pub fn finish(self, host_enable: &[u8]) -> Result<SimBand> {
        if host_enable.len() < 8 {
            return Err(perr("sim: short EnableEncryption"));
        }
        if be32(host_enable, 4) != 0x02000002 {
            return Err(perr("sim: expected an EnableEncryption frame"));
        }
        let enable = ProtoFields::parse(&host_enable[8..])?;
        // Newer firmware ignores the scheme the host names.
        if enable.bytes(1)? != self.host_point.as_slice()
            || (self.firmware.is_none() && enable.integer(5)? != 3)
        {
            return Err(perr("sim: unexpected EnableEncryption"));
        }
        let host_key = PublicKey::from_sec1_bytes(&[&[4u8][..], &self.host_point].concat())
            .map_err(|_| perr("sim: invalid host key"))?;
        let shared = ecdh::diffie_hellman(self.transport.to_nonzero_scalar(), host_key.as_affine());
        let host_seed = enable.bytes_len(2, 32)?.to_vec();
        let host_iv: [u8; 16] = enable.bytes_len(3, 16)?.try_into().expect("length checked");
        let host_counter =
            u32::try_from(enable.integer(4)?).map_err(|_| perr("sim: invalid counter"))?;
        let variant = self.firmware.unwrap_or(SCHEME_3);
        Ok(SimBand {
            sender: AirShieldCipher::new(
                AirShieldKeys::derive_variant(
                    variant,
                    shared.raw_secret_bytes().as_slice(),
                    &self.host_challenge,
                    &self.band_seed,
                )?,
                self.iv,
                42,
            ),
            receiver: AirShieldReceiver::new(AirShieldCipher::new(
                AirShieldKeys::derive_variant(
                    variant,
                    shared.raw_secret_bytes().as_slice(),
                    &self.band_challenge,
                    &host_seed,
                )?,
                host_iv,
                host_counter,
            )),
            datax: DataXReceiver::default(),
            transport_point: self.transport_point,
            host_point: self.host_point,
            host_challenge: self.host_challenge,
            host_seed,
            band_challenge: self.band_challenge,
            band_seed: self.band_seed,
            stamp: 1_000_000,
            channel_tag: if self.firmware.is_some() { 0x1c00 } else { 0 },
        })
    }
}

impl SimBand {
    /// Run the transport handshake against a fresh `session` (fed one byte at a
    /// time at time 100) and return the band plus the frames the host sent once
    /// encryption was up.
    pub fn connect(session: &mut BandSession) -> Result<(SimBand, Vec<DataXFrame>)> {
        let (handshake, peer) = SimHandshake::accept(&session.request()?, None)?;
        let mut output = Vec::new();
        for byte in peer {
            let result = session.feed(&[byte], 100.0)?;
            if !result.events.is_empty() {
                return Err(perr("sim: unexpected events during the handshake"));
            }
            output.extend(result.outgoing);
        }
        if output.len() < 4 {
            return Err(perr("sim: no EnableEncryption from the host"));
        }
        let size = usize::from(be16(&output, 0) & 0x7fff) + 4;
        if size < 8 || output.len() < size {
            return Err(perr("sim: truncated EnableEncryption"));
        }
        let mut band = handshake.finish(&output[..size])?;
        let startup = band.requests(&output[size..])?;
        Ok((band, startup))
    }

    /// Decrypt host → band bytes into frames.
    pub fn requests(&mut self, bytes: &[u8]) -> Result<Vec<DataXFrame>> {
        let mut frames = Vec::new();
        for plaintext in self.receiver.feed(bytes)? {
            frames.extend(self.datax.feed(&plaintext)?);
        }
        Ok(frames)
    }

    /// Encrypt one or more concatenated band → host frames as a single record.
    pub fn encrypt(&mut self, frames: &[u8]) -> Result<Vec<u8>> {
        if self.channel_tag == 0 {
            return self.sender.encrypt(frames);
        }
        let mut tagged = frames.to_vec();
        let mut at = 0;
        while at + 4 <= tagged.len() {
            let channel = be16(&tagged, at + 2);
            if channel & 0x8000 != 0 {
                tagged[at + 2..at + 4].copy_from_slice(&(channel | self.channel_tag).to_be_bytes());
            }
            at += usize::from(be16(&tagged, at) & 0x7fff) + 4;
        }
        self.sender.encrypt(&tagged)
    }

    /// Send one typed frame at `100 + now`; return the session's events and requests.
    pub fn exchange(
        &mut self,
        session: &mut BandSession,
        channel: u16,
        kind: u32,
        payload: &[u8],
        now: f64,
    ) -> Result<(Vec<Event>, Vec<DataXFrame>)> {
        let frame = encode_frame(channel, &[kind], payload)?;
        let record = self.encrypt(&frame)?;
        let result = session.feed(&record, 100.0 + now)?;
        let requests = self.requests(&result.outgoing)?;
        Ok((result.events, requests))
    }

    /// RPC responses go to channel 5, sensor data to 0x8010 (kinesis `Peer.send`).
    pub fn send(
        &mut self,
        session: &mut BandSession,
        kind: u32,
        payload: &[u8],
        now: f64,
    ) -> Result<Vec<Event>> {
        let channel = if kind == 0x02000315 { 5 } else { 0x8010 };
        Ok(self.exchange(session, channel, kind, payload, now)?.0)
    }

    /// One raw sEMG frame on channel 5 (the captured shape).
    pub fn raw(
        &mut self,
        session: &mut BandSession,
        payload: &[u8],
        now: f64,
    ) -> Result<Vec<Event>> {
        Ok(self.exchange(session, 5, 0x0200020a, payload, now)?.0)
    }

    pub fn gyro(
        &mut self,
        session: &mut BandSession,
        stamp: u64,
        x: i16,
        now: f64,
    ) -> Result<Vec<Event>> {
        let axes = [x.to_le_bytes(), 0i16.to_le_bytes(), 0i16.to_le_bytes()].concat();
        let payload = [
            field_int(1, stamp),
            field_int(2, stamp),
            field_bytes(3, &axes),
        ]
        .concat();
        self.send(session, 0x0200020f, &payload, now)
    }

    /// An orientation sample: a quaternion in wire order w, x, y, z.
    pub fn orientation(
        &mut self,
        session: &mut BandSession,
        stamp: u64,
        quaternion: [f32; 4],
        now: f64,
    ) -> Result<Vec<Event>> {
        let values: Vec<u8> = quaternion.iter().flat_map(|v| v.to_le_bytes()).collect();
        let payload = [field_int(1, stamp), field_int(2, stamp), field_bytes(3, &values)].concat();
        self.send(session, 0x02000212, &payload, now)
    }

    /// Keeps motion flowing: one gyro sample every 10 ms on both clocks.
    pub fn spin(
        &mut self,
        session: &mut BandSession,
        from: f64,
        through: f64,
    ) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        let mut now = from;
        while now <= through + 1e-9 {
            self.stamp += 10_000;
            let stamp = self.stamp;
            events.extend(self.gyro(session, stamp, 1000, now)?);
            now += 0.01;
        }
        Ok(events)
    }

    /// A gesture message with sequence 10 and band timestamp 20.
    pub fn gesture(
        &mut self,
        session: &mut BandSession,
        action: u64,
        finger: u64,
        derived: u64,
        synthetic: u64,
        now: f64,
    ) -> Result<Vec<Event>> {
        let payload = [
            field_int(1, 10),
            field_int(2, 20),
            field_int(3, finger),
            field_int(4, action),
            field_int(5, derived),
            field_int(12, synthetic),
        ]
        .concat();
        self.send(session, 0x0200020d, &payload, now)
    }

    pub fn hand_reply(
        &mut self,
        session: &mut BandSession,
        id: u64,
        value: Option<u64>,
        status: u64,
        channel: u16,
        now: f64,
    ) -> Result<(Vec<Event>, Vec<DataXFrame>)> {
        let config = [
            value.map(|value| field_int(10, value)).unwrap_or_default(),
            field_int(2, 2048),
        ]
        .concat();
        let payload = [
            field_int(1, id),
            field_int(2, status),
            field_bytes(6, &config),
        ]
        .concat();
        self.exchange(session, channel, 0x02000315, &payload, now)
    }

    /// Acknowledge the legacy link setup and the device-info query.
    pub fn complete_legacy_setup(&mut self, session: &mut BandSession) -> Result<Vec<DataXFrame>> {
        let ready = [field_int(1, 1), field_bytes(2, &[1; 16])].concat();
        let mut frames = self.exchange(session, 0x8001, 0x02001000, &ready, 0.0)?.1;
        let device = [field_int(1, 1), field_int(2, 1), field_bytes(4, &[])].concat();
        frames.extend(self.exchange(session, 3, 0x02000315, &device, 0.0)?.1);
        Ok(frames)
    }

    /// The band's EnableTrustEC proof over the host transcript, signed by `key`.
    pub fn trust_proof(&self, key: &SigningKey) -> Result<Vec<u8>> {
        let digest = trust_digest(
            &self.host_challenge,
            &self.host_point,
            &self.band_seed,
            &self.transport_point,
        );
        let signature: Signature = key
            .sign_prehash(&digest)
            .map_err(|_| perr("sim: signing failed"))?;
        encode_frame(
            0x8003,
            &[0x81000024, 0x02001001],
            &[
                field_bytes(1, &[7; 12]),
                field_bytes(2, &signature.to_bytes()),
                field_int(3, 1),
            ]
            .concat(),
        )
    }
}
