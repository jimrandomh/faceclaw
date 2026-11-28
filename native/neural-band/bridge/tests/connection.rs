use lumen_band::Connection;
use band_core::identity::EnrollmentIdentity;
use band_core::responder::{Responder, SimMode};
use p256::ecdsa::SigningKey;
use rand_core::OsRng;

/// Band gesture codes: thumb=1 index=2 middle=3; actions tap=3 doubletap=4
/// up=6 down=7 left=8 right=9; derived buttonHold=3.
const THUMB: u64 = 1;
const INDEX: u64 = 2;
const MIDDLE: u64 = 3;

/// Ping-pong until neither side has anything to say.
fn pump(connection: &mut Connection, band: &mut Responder, mut to_band: Vec<u8>, now: f64) {
    for _ in 0..64 {
        if to_band.is_empty() {
            return;
        }
        let reply = band.respond(&to_band).unwrap();
        to_band = connection.feed(&reply, now).unwrap();
    }
}

fn connected(paused: bool) -> (Connection, Responder) {
    connected_with(paused, "")
}

fn connected_with(paused: bool, mapping: &str) -> (Connection, Responder) {
    let identity = EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None);
    let mut connection =
        Connection::new(&identity.private_bytes(), 0, paused, "volume", mapping).unwrap();
    // An enrolled band with no owner recorded adopts the first key that proves trust.
    let mut band = Responder::new(SimMode::Enrolled, SigningKey::random(&mut OsRng));
    let request = connection.request().unwrap();
    pump(&mut connection, &mut band, request, 1.0);
    assert!(connection.take_log().contains(&"connected".to_owned()));
    assert!(connection.status_json().contains(r#""connected":true"#));
    (connection, band)
}

fn gesture(
    connection: &mut Connection,
    band: &mut Responder,
    action: u64,
    finger: u64,
    derived: u64,
    now: f64,
) {
    let bytes = band.gesture(action, finger, derived).unwrap();
    let reply = connection.feed(&bytes, now).unwrap();
    pump(connection, band, reply, now);
}

#[test]
fn a_swipe_down_plays_the_next_track() {
    let (mut connection, mut band) = connected(false);
    gesture(&mut connection, &mut band, 7, THUMB, 0, 3.0);
    assert_eq!(connection.take_actions(), vec!["media.next".to_owned()]);
    assert!(
        connection
            .take_log()
            .contains(&"gesture swipe down".to_owned())
    );
}

#[test]
fn an_index_tap_plays_or_pauses_once_its_double_tap_window_passes() {
    let (mut connection, mut band) = connected(false);
    gesture(&mut connection, &mut band, 3, INDEX, 0, 3.0);
    assert!(
        connection.take_actions().is_empty(),
        "held for a possible double tap"
    );
    connection.tick(3.2).unwrap();
    assert!(connection.take_actions().is_empty());
    connection.tick(3.45).unwrap();
    assert_eq!(
        connection.take_actions(),
        vec!["media.play_pause".to_owned()]
    );
}

#[test]
fn an_index_double_tap_swaps_the_dial_to_brightness() {
    let (mut connection, mut band) = connected(false);
    gesture(&mut connection, &mut band, 4, INDEX, 0, 3.0);
    assert_eq!(
        connection.take_actions(),
        vec!["dial.changed.brightness".to_owned()]
    );
    assert!(connection.status_json().contains(r#""dial":"brightness""#));
}

#[test]
fn a_middle_hold_turns_the_controls_off_and_on() {
    let (mut connection, mut band) = connected(false);
    gesture(&mut connection, &mut band, 0, MIDDLE, 3, 3.0);
    assert!(connection.status_json().contains(r#""paused":true"#));
    // Off: gestures do nothing…
    gesture(&mut connection, &mut band, 7, THUMB, 0, 5.0);
    assert!(connection.take_actions().is_empty());
    // …except the hold, which turns them back on.
    gesture(&mut connection, &mut band, 0, MIDDLE, 3, 7.0);
    assert!(connection.status_json().contains(r#""paused":false"#));
}

#[test]
fn quiet_links_send_keepalive_queries() {
    let (mut connection, _band) = connected(false);
    assert!(!connection.tick(10.0).unwrap().is_empty());
}

#[test]
fn a_malformed_owner_key_is_refused() {
    assert!(Connection::new(&[0u8; 10], 0, false, "volume", "").is_err());
}

#[test]
fn a_remapped_swipe_and_a_remapped_hold_run_their_new_actions() {
    let (mut connection, mut band) = connected(false);
    connection.set_mapping("swipe_down=volume.up;swipe_left=media.next;middle_hold=media.next");
    gesture(&mut connection, &mut band, 7, THUMB, 0, 3.0);
    assert_eq!(connection.take_actions(), vec!["volume.up".to_owned()]);
    gesture(&mut connection, &mut band, 8, THUMB, 0, 4.0);
    assert_eq!(connection.take_actions(), vec!["media.next".to_owned()]);
    // The middle hold is an action like any other now: it doesn't pause.
    gesture(&mut connection, &mut band, 0, MIDDLE, 3, 5.0);
    assert_eq!(connection.take_actions(), vec!["media.next".to_owned()]);
    assert!(connection.status_json().contains(r#""paused":false"#));
}

#[test]
fn the_pause_can_be_any_gesture_and_only_it_resumes() {
    let (mut connection, mut band) = connected(false);
    connection.set_mapping("swipe_left=band.pause;middle_hold=;swipe_down=media.next");
    gesture(&mut connection, &mut band, 8, THUMB, 0, 3.0);
    assert!(connection.status_json().contains(r#""paused":true"#));
    assert!(connection.take_actions().is_empty(), "the pause isn't the app's action");
    // Paused: the middle hold (no longer the pause) and the other gestures do nothing.
    gesture(&mut connection, &mut band, 0, MIDDLE, 3, 5.0);
    gesture(&mut connection, &mut band, 7, THUMB, 0, 6.0);
    assert!(connection.take_actions().is_empty());
    assert!(connection.status_json().contains(r#""paused":true"#));
    gesture(&mut connection, &mut band, 8, THUMB, 0, 7.0);
    assert!(connection.status_json().contains(r#""paused":false"#));
    gesture(&mut connection, &mut band, 7, THUMB, 0, 8.0);
    assert_eq!(connection.take_actions(), vec!["media.next".to_owned()]);
}

#[test]
fn a_mapping_with_no_way_to_resume_doesnt_stay_paused() {
    let (mut connection, _band) = connected(true);
    assert!(connection.status_json().contains(r#""paused":true"#));
    connection.set_mapping("middle_hold=media.next");
    assert!(connection.status_json().contains(r#""paused":false"#));
    // And a connection that starts paused with no pause gesture starts on.
    let (connection, _band) = connected_with(true, "middle_hold=");
    assert!(connection.status_json().contains(r#""paused":false"#));
}

#[test]
fn an_unmapped_gesture_does_nothing() {
    let (mut connection, mut band) = connected(false);
    connection.set_mapping("swipe_down=");
    gesture(&mut connection, &mut band, 7, THUMB, 0, 3.0);
    assert!(connection.take_actions().is_empty());
}

#[test]
fn a_band_on_the_other_wrist_is_set_to_the_chosen_hand_after_connecting() {
    // The simulated band starts as right-handed.
    let (mut connection, mut band) = connected_with(false, "hand=left");
    for step in 0..20 {
        let out = connection.tick(2.0 + f64::from(step) * 0.05).unwrap();
        pump(
            &mut connection,
            &mut band,
            out,
            2.0 + f64::from(step) * 0.05,
        );
    }
    assert_eq!(band.hand, 1, "the band stores left");
    assert!(
        connection.status_json().contains(r#""hand":"left""#),
        "{}",
        connection.status_json()
    );
}

#[test]
fn changing_the_wrist_applies_to_the_connected_band() {
    let (mut connection, mut band) = connected_with(false, "hand=band");
    assert!(connection.status_json().contains(r#""hand":"right""#));

    connection.set_mapping("hand=left");
    let outgoing = connection.tick(2.0).unwrap();
    pump(&mut connection, &mut band, outgoing, 2.0);
    assert_eq!(band.hand, 1);
    assert!(connection.status_json().contains(r#""hand":"left""#));

    connection.set_mapping("hand=right");
    let outgoing = connection.tick(2.5).unwrap();
    pump(&mut connection, &mut band, outgoing, 2.5);
    assert_eq!(band.hand, 0);
    assert!(connection.status_json().contains(r#""hand":"right""#));
    assert!(connection.status_json().contains(r#""connected":true"#));
}

#[test]
fn a_wrist_update_during_confirmation_keeps_the_link_connected() {
    let (mut connection, mut band) = connected_with(false, "hand=band");
    connection.set_mapping("hand=left");
    let pending = connection.tick(2.0).unwrap();

    // The band's confirmation for that write is still in flight.
    connection.set_mapping("hand=left;swipe_up=scroll-up");
    assert!(connection.tick(2.1).unwrap().is_empty());
    connection.set_mapping("hand=right;swipe_up=scroll-up");

    pump(&mut connection, &mut band, pending, 2.2);
    assert_eq!(band.hand, 0);
    assert!(connection.status_json().contains(r#""hand":"right""#));
    assert!(connection.status_json().contains(r#""connected":true"#));
}

fn claim_events(connection: &mut Connection) -> Vec<serde_json::Value> {
    connection
        .take_claim_events()
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn a_claim_connection_runs_the_ceremony_through_its_events_and_ends_connected() {
    let band_key = SigningKey::random(&mut OsRng);
    let mut band = Responder::new(SimMode::Ceremony, band_key.clone());
    let mut connection = Connection::new_claim(0, false, "volume", "");
    let request = connection.request().unwrap();
    pump(&mut connection, &mut band, request, 1.0);
    // Identity read and skip challenge done: the app is asked for pair_request.
    let events = claim_events(&mut connection);
    let request = events.iter().find(|e| e["type"] == "pair_request").expect("pair_request");
    assert_eq!(unhex(request["nonce"].as_str().unwrap()), (0..16).collect::<Vec<u8>>());
    assert_eq!(unhex(request["app_pubkey"].as_str().unwrap()).len(), 64);
    assert!(events.iter().any(|e| e["type"] == "stage"));
    assert!(connection.claim_pending_key().is_none());
    // The server's pending receipt: StartChangeOwner, then the band's receipt asks for pair.
    let signature = [vec![0x30, 0x45, 0x02, 0x20], vec![3; 67]].concat();
    let out = connection.claim_pair_request_completed(&signature, r#"{"receipt_type":"pending"}"#).unwrap();
    pump(&mut connection, &mut band, out, 2.0);
    let pair = claim_events(&mut connection).into_iter().find(|e| e["type"] == "pair").expect("pair");
    assert!(!pair["receipt"].as_str().unwrap().is_empty());
    // The final receipt: the pending key exists before the bytes go out, and the band commits it.
    let band_point = band_core::identity::point64(band_key.verifying_key());
    let out = connection
        .claim_pair_completed(&[vec![0x30, 0x45, 0x02, 0x21], vec![5; 67]].concat(), r#"{"receipt_type":"final"}"#, Some(&band_point))
        .unwrap();
    let pending = connection.claim_pending_key().expect("pending key before writing");
    assert_eq!(pending.len(), 97);
    let acknowledgment = band.respond(&out).unwrap();
    let trust = connection.feed(&acknowledgment, 3.0).unwrap();
    let completed = claim_events(&mut connection).into_iter().find(|e| e["type"] == "completed").expect("completed");
    assert_eq!(unhex(completed["owner_key"].as_str().unwrap()), pending);
    // FinishChangeOwner acknowledged the commit. The app must keep reading the
    // same channel while the candidate identity proves trust.
    assert!(connection.status_json().contains(r#""connected":false"#));
    assert!(!trust.is_empty(), "the commit acknowledgment starts the trust exchange");
    pump(&mut connection, &mut band, trust, 3.1);
    assert!(connection.status_json().contains(r#""connected":true"#));
    assert!(connection.take_log().contains(&"connected".to_owned()));
    // The committed key opens a normal connection to the same band.
    assert!(Connection::new(&pending, 0, false, "volume", "").is_ok());
}

#[test]
fn the_air_mouse_turns_pinches_into_buttons_and_its_swipe_turns_it_off() {
    let (mut connection, mut band) = connected_with(false, "swipe_left=pc.pointer");
    // Its gesture asks the app to turn it on.
    gesture(&mut connection, &mut band, 8, THUMB, 0, 3.0);
    assert_eq!(connection.take_actions(), vec!["pc.pointer".to_owned()]);
    connection.set_pointer(true, "steadiness=0.5;boost=1.0", 3.1);
    assert!(connection.take_log().contains(&"air mouse on".to_owned()));
    // An index pinch is the left button, not an action.
    gesture(&mut connection, &mut band, 1, INDEX, 0, 3.2);
    assert!(connection.take_actions().is_empty());
    let records = connection.take_pointer(3.2);
    assert!(records.chunks(4).any(|r| r[0] == 2.0 && r[2] == 1.0), "{records:?}");
    // The same swipe turns it off.
    gesture(&mut connection, &mut band, 8, THUMB, 0, 3.5);
    assert_eq!(connection.take_actions(), vec!["pointer.off".to_owned()]);
    assert!(connection.take_pointer(3.6).is_empty());
}

#[test]
fn pausing_ends_the_air_mouse_and_says_so() {
    let (mut connection, _band) = connected_with(false, "swipe_left=pc.pointer");
    connection.set_pointer(true, "", 3.0);
    connection.set_paused(true, 3.1);
    assert_eq!(connection.take_actions(), vec!["pointer.off".to_owned()]);
}
