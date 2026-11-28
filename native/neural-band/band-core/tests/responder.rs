use band_core::BandError;
use band_core::ceremony::{CeremonyHttpRequest, OwnershipCeremony};
use band_core::events::{Event, Hand};
use band_core::identity::EnrollmentIdentity;
use band_core::responder::{Responder, SimMode};
use band_core::session::BandSession;
use p256::ecdsa::SigningKey;
use rand_core::OsRng;
use sha2::{Digest, Sha256};

/// Ping-pong host and band bytes until neither side has anything to say.
fn pump(
    session: &mut BandSession,
    band: &mut Responder,
    first: Vec<u8>,
    time: f64,
) -> band_core::Result<Vec<Event>> {
    let mut to_band = first;
    let mut events = Vec::new();
    for _ in 0..64 {
        if to_band.is_empty() {
            break;
        }
        let reply = band.respond(&to_band)?;
        let result = session.feed(&reply, time)?;
        events.extend(result.events);
        to_band = result.outgoing;
    }
    Ok(events)
}

fn start(session: &mut BandSession, band: &mut Responder) -> band_core::Result<Vec<Event>> {
    let request = session.request()?;
    pump(session, band, request, 100.0)
}

fn connected(events: &[Event]) -> bool {
    events.iter().any(|event| matches!(event, Event::Connected))
}

#[test]
fn a_legacy_session_connects_and_reads_hand_and_battery() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    let events = start(&mut session, &mut band).unwrap();
    assert!(connected(&events));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::Handedness(Hand::Right)))
    );
    let battery = session.query_battery_status(101.0).unwrap();
    let events = pump(&mut session, &mut band, battery, 101.0).unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::BatteryStatus(Some(status)) if status.level == 80))
    );
}

#[test]
fn an_enrolled_session_verifies_the_band_and_connects() {
    let band_key = SigningKey::random(&mut OsRng);
    let identity = EnrollmentIdentity::new(
        SigningKey::random(&mut OsRng),
        Some(*band_key.verifying_key()),
    );
    let mut band = Responder::new(SimMode::Enrolled, band_key);
    let mut session = BandSession::new(Some(identity), None, false);
    assert!(connected(&start(&mut session, &mut band).unwrap()));
    assert!(session.band_verified());
}

#[test]
fn a_rejected_identity_fails_the_session() {
    let mut band = Responder::new(SimMode::Enrolled, SigningKey::random(&mut OsRng));
    band.reject_identity = Some(0x03001043);
    let identity = EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None);
    let mut session = BandSession::new(Some(identity), None, false);
    assert!(matches!(
        start(&mut session, &mut band),
        Err(BandError::IdentityMismatch { code: 0x1043, .. })
    ));
}

#[test]
fn a_ceremony_runs_to_a_connected_enrolled_session() {
    let band_key = SigningKey::random(&mut OsRng);
    let mut band = Responder::new(SimMode::Ceremony, band_key);
    let band_point = band.band_point();
    let mut session = BandSession::new(None, Some(OwnershipCeremony::default()), false);
    let events = start(&mut session, &mut band).unwrap();
    let Some(Event::CeremonyHttp(CeremonyHttpRequest::PairRequest(request))) = events
        .iter()
        .find(|event| matches!(event, Event::CeremonyHttp(_)))
    else {
        panic!("no pair_request: {events:?}")
    };
    assert_eq!(request.identity.serial, band_core::responder::SIM_SERIAL);
    let bytes = session
        .ceremony_pair_request_completed(&[0x30, 1, 2], "{\"pending\":1}")
        .unwrap();
    let events = pump(&mut session, &mut band, bytes, 101.0).unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::CeremonyHttp(CeremonyHttpRequest::Pair(_))))
    );
    let bytes = session
        .ceremony_pair_completed(&[0x30, 3, 4], "{\"final\":1}", Some(&band_point))
        .unwrap();
    assert!(!band.finish_seen());
    let events = pump(&mut session, &mut band, bytes, 102.0).unwrap();
    assert!(band.finish_seen());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::CeremonyCompleted(_)))
    );
    assert!(connected(&events));
    assert!(session.band_verified());
}

#[test]
fn a_claim_rejection_ends_the_ceremony() {
    let mut band = Responder::new(SimMode::Ceremony, SigningKey::random(&mut OsRng));
    band.reject_claim = Some(0x03001042);
    let mut session = BandSession::new(None, Some(OwnershipCeremony::default()), false);
    start(&mut session, &mut band).unwrap();
    let bytes = session
        .ceremony_pair_request_completed(&[0x30], "{}")
        .unwrap();
    assert!(matches!(
        pump(&mut session, &mut band, bytes, 101.0),
        Err(BandError::OwnershipRejected { code: 0x1042, .. })
    ));
}

#[test]
fn injected_gestures_and_stop_work() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    start(&mut session, &mut band).unwrap();
    // Thumb (1) swipe left (8).
    let swipe = band.gesture(8, 1, 0).unwrap();
    let events = session.feed(&swipe, 101.0).unwrap().events;
    assert!(events.iter().any(
        |event| matches!(event, Event::Gesture(g) if g.finger == "thumb" && g.action == "left")
    ));
    let again = band.gesture(8, 1, 0).unwrap();
    let Event::Gesture(second) = &session.feed(&again, 101.1).unwrap().events[0] else {
        panic!()
    };
    assert_eq!(
        second.sequence, 2,
        "every injected gesture gets a fresh sequence"
    );
    let stop = session.stop().unwrap();
    pump(&mut session, &mut band, stop, 102.0).unwrap();
    assert!(session.stop_acknowledged());
    assert!(band.stopped());
}

#[test]
fn raw_emg_can_be_switched_on() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    start(&mut session, &mut band).unwrap();
    let bytes = session.set_raw_emg_enabled(true, 101.0).unwrap();
    let events = pump(&mut session, &mut band, bytes, 101.0).unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::RawEmgState(true)))
    );
    let frame = band.raw_emg().unwrap();
    assert!(
        session
            .feed(&frame, 101.1)
            .unwrap()
            .events
            .iter()
            .any(|e| matches!(e, Event::RawEmgFrame(_)))
    );
}

#[test]
fn a_silent_band_answers_nothing() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    start(&mut session, &mut band).unwrap();
    band.silent = true;
    let query = session.query_stream_state().unwrap();
    assert!(band.respond(&query).unwrap().is_empty());
}

#[test]
fn an_enrolled_band_with_a_set_owner_rejects_a_different_key() {
    let band_key = SigningKey::random(&mut OsRng);
    let mut band = Responder::new(SimMode::Enrolled, band_key);
    let someone_elses_point =
        EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None).app_point();
    band.set_owner(Some(Sha256::digest(someone_elses_point).into()));
    let identity = EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None);
    let mut session = BandSession::new(Some(identity), None, false);
    assert!(matches!(
        start(&mut session, &mut band),
        Err(BandError::IdentityMismatch { code: 0x1043, .. })
    ));
}

#[test]
fn a_legacy_band_rejects_an_enrolled_session() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let identity = EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None);
    let mut session = BandSession::new(Some(identity), None, false);
    assert!(matches!(
        start(&mut session, &mut band),
        Err(BandError::IdentityMismatch { code: 0x1043, .. })
    ));
}

#[test]
fn an_enrolled_band_does_not_let_a_legacy_session_connect() {
    let mut band = Responder::new(SimMode::Enrolled, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    let events = start(&mut session, &mut band).unwrap();
    assert!(!connected(&events));
}

#[test]
fn a_completed_ceremony_sets_the_bands_owner_to_the_new_app_point() {
    let band_key = SigningKey::random(&mut OsRng);
    let mut band = Responder::new(SimMode::Ceremony, band_key);
    let band_point = band.band_point();
    let mut session = BandSession::new(None, Some(OwnershipCeremony::default()), false);
    let events = start(&mut session, &mut band).unwrap();
    assert!(events.iter().any(|event| matches!(
        event,
        Event::CeremonyHttp(CeremonyHttpRequest::PairRequest(_))
    )));
    let bytes = session
        .ceremony_pair_request_completed(&[0x30, 1, 2], "{\"pending\":1}")
        .unwrap();
    pump(&mut session, &mut band, bytes, 101.0).unwrap();
    let bytes = session
        .ceremony_pair_completed(&[0x30, 3, 4], "{\"final\":1}", Some(&band_point))
        .unwrap();
    let events = pump(&mut session, &mut band, bytes, 102.0).unwrap();
    let Some(Event::CeremonyCompleted(identity)) = events
        .iter()
        .find(|event| matches!(event, Event::CeremonyCompleted(_)))
    else {
        panic!("no ceremony completed event: {events:?}")
    };
    let expected: [u8; 32] = Sha256::digest(identity.app_point()).into();
    assert_eq!(band.owner(), Some(expected));
    assert!(connected(&events));
}

#[test]
fn an_injected_gesture_before_streams_are_enabled_yields_nothing() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false);
    let request = session.request().unwrap();
    let reply = band.respond(&request).unwrap();
    let result = session.feed(&reply, 100.0).unwrap();
    band.respond(&result.outgoing).unwrap();
    let bytes = band.gesture(8, 1, 0).unwrap();
    assert!(bytes.is_empty());
}

/// Newer firmware (offers 27, names 26): only the matching key guess
/// connects; a wrong one fails on the band's side before anything is decrypted.
#[test]
fn a_newer_band_connects_only_with_the_matching_key_guess() {
    use band_core::airshield::SCHEME_26_GUESSES;
    let actual = 3;
    for guess in 0..SCHEME_26_GUESSES.len() {
        let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
        band.firmware = Some(SCHEME_26_GUESSES[actual]);
        let mut session = BandSession::new(None, None, false).with_scheme_guess(guess);
        let result = start(&mut session, &mut band);
        assert_eq!(session.scheme_guess(), Some(guess));
        if guess == actual {
            assert!(connected(&result.unwrap()), "guess {guess}");
        } else {
            assert!(result.is_err(), "guess {guess} should fail");
            assert_eq!(session.authenticated_packets(), 0);
        }
    }
}

#[test]
fn a_scheme_3_band_ignores_the_key_guess() {
    let mut band = Responder::new(SimMode::Legacy, SigningKey::random(&mut OsRng));
    let mut session = BandSession::new(None, None, false).with_scheme_guess(5);
    assert!(connected(&start(&mut session, &mut band).unwrap()));
    assert_eq!(session.scheme_guess(), None);
}
