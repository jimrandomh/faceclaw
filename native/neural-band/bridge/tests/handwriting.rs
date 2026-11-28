//! The band's handwriting model from the bridge: switched on by name-found settings, text out,
//! the middle tap still mapped, and the band always put back.

use band_core::identity::EnrollmentIdentity;
use band_core::responder::{Responder, SimMode};
use lumen_band::Connection;
use p256::ecdsa::SigningKey;
use rand_core::OsRng;
use serde_json::Value;

const MIDDLE: u64 = 3;

fn pump(connection: &mut Connection, band: &mut Responder, mut to_band: Vec<u8>, now: f64) {
    for _ in 0..256 {
        if to_band.is_empty() {
            return;
        }
        let reply = band.respond(&to_band).unwrap();
        to_band = connection.feed(&reply, now).unwrap();
    }
    panic!("the exchange never settled");
}

fn connected(mapping: &str) -> (Connection, Responder) {
    let identity = EnrollmentIdentity::new(SigningKey::random(&mut OsRng), None);
    let mut connection = Connection::new(&identity.private_bytes(), 0, false, "volume", mapping).unwrap();
    let mut band = Responder::new(SimMode::Enrolled, SigningKey::random(&mut OsRng));
    let request = connection.request().unwrap();
    pump(&mut connection, &mut band, request, 1.0);
    assert!(connection.status_json().contains(r#""connected":true"#));
    connection.take_log();
    (connection, band)
}

/// Ticks until the band has nothing more to answer.
fn settle(connection: &mut Connection, band: &mut Responder, now: f64) {
    for _ in 0..8 {
        let bytes = connection.tick(now).unwrap();
        if bytes.is_empty() {
            return;
        }
        pump(connection, band, bytes, now);
    }
}

fn events(connection: &mut Connection) -> Vec<Value> {
    connection
        .take_handwriting_events()
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn phases(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["type"] == "state")
        .map(|event| event["phase"].as_str().unwrap().to_owned())
        .collect()
}

/// Switch on and let samples arrive until the capture says ready.
fn start(connection: &mut Connection, band: &mut Responder, hints: Option<(u64, u64)>) -> Vec<Value> {
    let bytes = connection.set_handwriting(true, hints, 2.0).unwrap();
    pump(connection, band, bytes, 2.0);
    settle(connection, band, 2.0);
    for step in 0..6 {
        let now = 2.1 + f64::from(step) * 0.1;
        let bytes = band.handwriting(99).unwrap();
        let reply = connection.feed(&bytes, now).unwrap();
        pump(connection, band, reply, now);
    }
    settle(connection, band, 2.8);
    events(connection)
}

fn write(connection: &mut Connection, band: &mut Responder, classes: &[usize], at: f64) {
    for (index, &class) in classes.iter().enumerate() {
        let now = at + index as f64 * 0.02;
        let bytes = band.handwriting(class).unwrap();
        let reply = connection.feed(&bytes, now).unwrap();
        pump(connection, band, reply, now);
    }
}

#[test]
fn handwriting_finds_the_settings_by_name_writes_text_and_restores_the_band() {
    let (mut connection, mut band) = connected("middle_tap=nav.back;middle_double=screen.toggle;swipe_right=nav.right;index_tap=nav.activate");
    let started = start(&mut connection, &mut band, None);
    assert_eq!(phases(&started), vec!["preparing", "ready"]);
    let ready = started.iter().find(|e| e["phase"] == "ready").unwrap();
    // Found by name on this firmware: 28 and 29, not kinesis' 27 and 28.
    assert_eq!(ready["collection_id"], 28);
    assert_eq!(ready["model_id"], 29);
    assert_eq!(band.setting("data-collection"), 1);
    assert_eq!(band.setting("data-collection-model"), 5);
    assert!(band.model_streams());
    // Only the two settings were ever written.
    assert!(band.writes.iter().all(|(id, _)| *id == 28 || *id == 29));

    // h i (blank between) then shift + "o": "hiO"
    write(&mut connection, &mut band, &[7, 7, 99, 8, 99, 97, 99, 14], 3.0);
    let texts: Vec<Value> = events(&mut connection).into_iter().filter(|e| e["type"] == "text").collect();
    assert_eq!(texts.last().unwrap()["text"], "hiO");

    // While writing, a stroke read as a swipe or as the pausing middle hold does nothing...
    for (action, finger, derived) in [(9, 1, 0), (0, MIDDLE, 3), (3, 2, 0)] {
        let bytes = band.gesture(action, finger, derived).unwrap();
        let reply = connection.feed(&bytes, 3.3).unwrap();
        pump(&mut connection, &mut band, reply, 3.3);
    }
    connection.tick(3.3).unwrap();
    assert!(connection.take_actions().is_empty());
    assert!(connection.status_json().contains(r#""paused":false"#));
    // ...and the middle tap goes through at once, without waiting for a double tap.
    let tap = band.gesture(3, MIDDLE, 0).unwrap();
    let reply = connection.feed(&tap, 3.8).unwrap();
    pump(&mut connection, &mut band, reply, 3.8);
    assert_eq!(connection.take_actions(), vec!["nav.back".to_owned()]);

    let bytes = connection.set_handwriting(false, None, 4.0).unwrap();
    pump(&mut connection, &mut band, bytes, 4.0);
    settle(&mut connection, &mut band, 4.0);
    let ended = events(&mut connection);
    assert_eq!(phases(&ended), vec!["restoring", "finished"]);
    let finished = ended.last().unwrap();
    assert_eq!(finished["verified"], true);
    assert_eq!(band.setting("data-collection"), 0);
    assert_eq!(band.setting("data-collection-model"), 2);
    assert!(!band.model_streams());
    // Text never reaches the log.
    assert!(connection.take_log().iter().all(|line| !line.contains("hiO")));
}

#[test]
fn hints_shorten_the_lookup_and_a_wrong_hint_falls_back_to_the_names() {
    let (mut connection, mut band) = connected("");
    // Wrong hints (27 is stream_in_standby): never written, the lookup goes on by name.
    let started = start(&mut connection, &mut band, Some((27, 28)));
    let ready = started.iter().find(|e| e["phase"] == "ready").unwrap();
    assert_eq!(ready["collection_id"], 28);
    assert_eq!(ready["model_id"], 29);
    assert!(band.writes.iter().all(|(id, _)| *id == 28 || *id == 29));
}

#[test]
fn a_lookup_that_never_answers_is_skipped() {
    let (mut connection, mut band) = connected("");
    band.silent_lookups = vec![9];
    let bytes = connection.set_handwriting(true, None, 2.0).unwrap();
    pump(&mut connection, &mut band, bytes, 2.0);
    // Lookup 9 gets no answer: after 1.5 s the next id is asked.
    for step in 0..40 {
        let now = 2.0 + f64::from(step) * 0.5;
        let bytes = connection.tick(now).unwrap();
        pump(&mut connection, &mut band, bytes, now);
    }
    assert_eq!(band.setting("data-collection-model"), 5);
}

#[test]
fn recovery_puts_back_a_band_left_in_the_model() {
    // The app went away mid-capture: the band is still in the model on the next connection.
    let (mut fresh, mut band) = connected("");
    band.settings[27] = 1;
    band.settings[28] = 5;
    let bytes = fresh.recover_handwriting(None, 5.0).unwrap();
    pump(&mut fresh, &mut band, bytes, 5.0);
    settle(&mut fresh, &mut band, 5.0);
    let ended = events(&mut fresh);
    assert_eq!(phases(&ended), vec!["restoring", "finished"]);
    assert_eq!(ended.last().unwrap()["verified"], true);
    assert_eq!(band.setting("data-collection"), 0);
    assert_eq!(band.setting("data-collection-model"), 2);
}

#[test]
fn a_silent_model_ends_the_capture_and_restores() {
    let (mut connection, mut band) = connected("");
    let _ = start(&mut connection, &mut band, None);
    // No samples for more than 3 s while ready: fail, then restore.
    for step in 0..10 {
        let now = 7.0 + f64::from(step) * 0.5;
        let bytes = connection.tick(now).unwrap();
        pump(&mut connection, &mut band, bytes, now);
    }
    let ended = events(&mut connection);
    let finished = ended.iter().find(|e| e["phase"] == "finished").unwrap();
    assert_eq!(finished["verified"], true);
    assert!(finished["problem"].as_str().unwrap().contains("stopped sending"));
    assert_eq!(band.setting("data-collection-model"), 2);
}

#[test]
fn the_writing_probe_records_samples_and_gestures_only_when_on() {
    let (mut connection, mut band) = connected("middle_tap=nav.back;swipe_right=nav.right");
    start(&mut connection, &mut band, None);
    write(&mut connection, &mut band, &[7, 99], 3.0);
    let off = events(&mut connection);
    assert!(off.iter().all(|e| e["type"] != "frame" && e["type"] != "gesture"));

    connection.set_handwriting_probe(true);
    write(&mut connection, &mut band, &[8, 99], 3.1);
    let swipe = band.gesture(9, 1, 0).unwrap();
    let reply = connection.feed(&swipe, 3.2).unwrap();
    pump(&mut connection, &mut band, reply, 3.2);
    let on = events(&mut connection);
    let frames: Vec<&Value> = on.iter().filter(|e| e["type"] == "frame").collect();
    assert_eq!(frames.len(), 2);
    // The likeliest class first, eight of them, log-probabilities rounded.
    let top = frames[0]["top"].as_array().unwrap();
    assert_eq!(top.len(), 8);
    assert_eq!(top[0][0], 8);
    assert!(top[0][1].as_f64().unwrap() > -0.2);
    assert_eq!(frames[1]["top"][0][0], 99);
    assert!(frames[0]["ts"].as_u64().unwrap() < frames[1]["ts"].as_u64().unwrap());
    // The text still comes, after its sample.
    let text_at = on.iter().position(|e| e["type"] == "text").unwrap();
    assert!(on.iter().position(|e| e["type"] == "frame").unwrap() < text_at);
    let gesture = on.iter().find(|e| e["type"] == "gesture").unwrap();
    assert_eq!(gesture["finger"], "thumb");
    assert_eq!(gesture["at"], 3.2);
    // The swipe itself still does nothing while writing.
    assert!(connection.take_actions().is_empty());
    // Nothing of it reaches the log.
    assert!(connection.take_log().iter().all(|line| !line.contains("frame") && !line.contains("\"top\"")));

    connection.set_handwriting_probe(false);
    write(&mut connection, &mut band, &[9, 99], 3.4);
    assert!(events(&mut connection).iter().all(|e| e["type"] != "frame"));
}

#[test]
fn the_middle_tap_ends_the_writing_even_while_the_controls_are_paused() {
    let (mut connection, mut band) = connected("middle_tap=nav.back;middle_hold=band.pause");
    connection.set_paused(true, 1.5);
    assert!(connection.status_json().contains(r#""paused":true"#));
    let started = start(&mut connection, &mut band, None);
    assert_eq!(phases(&started), vec!["preparing", "ready"]);
    let tap = band.gesture(3, MIDDLE, 0).unwrap();
    let reply = connection.feed(&tap, 3.0).unwrap();
    pump(&mut connection, &mut band, reply, 3.0);
    assert_eq!(connection.take_actions(), vec!["nav.back".to_owned()]);
    // A second tap right after (the band's report repeated) is one action, not two.
    let again = band.gesture(3, MIDDLE, 0).unwrap();
    let reply = connection.feed(&again, 3.1).unwrap();
    pump(&mut connection, &mut band, reply, 3.1);
    assert!(connection.take_actions().is_empty());
    // The controls stay paused for everything else.
    assert!(connection.status_json().contains(r#""paused":true"#));
}

const THUMB: u64 = 1;
const RIGHT: u64 = 9;
const LEFT: u64 = 8;
const DOWN: u64 = 7;

/// A small lexicon file and where the wearer's store goes.
fn suggestion_files(dir: &std::path::Path) -> (String, String) {
    use writing::lexicon::Lang;
    let mut builder = writing::build::LexiconBuilder::default();
    for (word, cost) in [("você", 4.5), ("vocês", 7.0), ("vou", 6.0), ("não", 4.0), ("está", 5.1), ("estou", 6.0), ("com", 4.5)] {
        builder.word(word, Lang::Pt, cost, false);
    }
    builder.pair(Lang::Pt, "você", "está", 2.5);
    builder.backoff(Lang::Pt, "você", 2.0);
    let lexicon = dir.join("writing.lex");
    std::fs::write(&lexicon, builder.finish()).unwrap();
    (lexicon.to_string_lossy().into_owned(), dir.join("writing.store").to_string_lossy().into_owned())
}

fn with_suggestions(dir: &std::path::Path) -> (Connection, Responder, String) {
    let (lexicon, store) = suggestion_files(dir);
    let (mut connection, mut band) = connected("middle_tap=nav.back;swipe_right=nav.right;swipe_left=nav.left;swipe_down=nav.down");
    start(&mut connection, &mut band, None);
    let settings = writing::assistant::Settings { autocorrect: true, learn: true };
    connection.set_writing_assist(true, &lexicon, &store, settings, 20_000).unwrap();
    events(&mut connection);
    (connection, band, store)
}

fn swipe(connection: &mut Connection, band: &mut Responder, action: u64, now: f64) {
    let bytes = band.gesture(action, THUMB, 0).unwrap();
    let reply = connection.feed(&bytes, now).unwrap();
    pump(connection, band, reply, now);
}

fn last<'a>(events: &'a [Value], kind: &str) -> Option<&'a Value> {
    events.iter().rev().find(|e| e["type"] == kind)
}

#[test]
fn the_thumb_accepts_moves_between_and_undoes_the_suggestions() {
    let dir = tempfile::tempdir().unwrap();
    let (mut connection, mut band, _) = with_suggestions(dir.path());
    // v, o
    write(&mut connection, &mut band, &[21, 99, 14, 99], 3.0);
    let written = events(&mut connection);
    let suggest = last(&written, "suggest").unwrap();
    assert_eq!(suggest["kind"], "word");
    assert_eq!(suggest["items"][0], "você");
    assert_eq!(suggest["ghost"], "cê");
    // A moment without strokes, then the thumb: down moves, right accepts the one chosen.
    write(&mut connection, &mut band, &[99; 24], 3.2);
    swipe(&mut connection, &mut band, DOWN, 3.8);
    let moved = events(&mut connection);
    assert_eq!(last(&moved, "suggest").unwrap()["selected"], 1);
    swipe(&mut connection, &mut band, DOWN, 4.1);
    swipe(&mut connection, &mut band, DOWN, 4.4);
    let back = events(&mut connection);
    assert_eq!(last(&back, "suggest").unwrap()["selected"], 0);
    swipe(&mut connection, &mut band, RIGHT, 4.8);
    let accepted = events(&mut connection);
    assert_eq!(last(&accepted, "text").unwrap()["text"], "você ");
    let next = last(&accepted, "suggest").unwrap();
    assert_eq!(next["kind"], "next");
    assert_eq!(next["items"][0], "está");
    assert_eq!(next["notice"]["kind"], "accepted");
    assert_eq!(next["mark"], serde_json::json!([0, 4]));
    // The swipes stayed the writing's: no navigation ran.
    assert!(connection.take_actions().is_empty());
    // Left undoes it.
    swipe(&mut connection, &mut band, LEFT, 5.2);
    let undone = events(&mut connection);
    assert_eq!(last(&undone, "text").unwrap()["text"], "vo");
    // Writing goes on after the undo, from the decoder's own text.
    write(&mut connection, &mut band, &[2, 99], 5.4);
    assert_eq!(last(&events(&mut connection), "text").unwrap()["text"], "voc");
}

#[test]
fn a_swipe_in_the_middle_of_a_stroke_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (mut connection, mut band, _) = with_suggestions(dir.path());
    write(&mut connection, &mut band, &[21, 99, 14], 3.0);
    events(&mut connection);
    swipe(&mut connection, &mut band, RIGHT, 3.1);
    assert!(last(&events(&mut connection), "text").is_none());
    assert!(connection.take_log().iter().any(|line| line.contains("ignored")));
}

#[test]
fn a_corrected_word_is_one_text_and_no_word_reaches_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let (mut connection, mut band, _) = with_suggestions(dir.path());
    connection.take_log();
    // n, a, o, space
    write(&mut connection, &mut band, &[13, 99, 0, 99, 14, 99, 88], 3.0);
    let written = events(&mut connection);
    let texts: Vec<&str> = written.iter().filter(|e| e["type"] == "text").map(|e| e["text"].as_str().unwrap()).collect();
    assert_eq!(texts.last(), Some(&"não "));
    assert!(!texts.contains(&"nao "), "{texts:?}");
    let suggest = last(&written, "suggest").unwrap();
    assert_eq!(suggest["notice"], serde_json::json!({"kind": "corrected", "from": "nao", "to": "não"}));
    assert_eq!(suggest["undo"], true);
    let log = connection.take_log().join("\n");
    assert!(!log.contains("nao") && !log.contains("não"), "{log}");
    // The band's decoder writes after the correction.
    write(&mut connection, &mut band, &[4, 99], 3.3);
    assert_eq!(last(&events(&mut connection), "text").unwrap()["text"], "não e");
}

#[test]
fn what_the_suggestions_learned_is_saved_when_they_go_off() {
    let dir = tempfile::tempdir().unwrap();
    let (mut connection, mut band, store) = with_suggestions(dir.path());
    // c, o, m, space, v
    write(&mut connection, &mut band, &[2, 99, 14, 99, 12, 99, 88, 99, 21], 3.0);
    let settings = writing::assistant::Settings { autocorrect: true, learn: true };
    connection.set_writing_assist(false, "", "", settings, 20_000).unwrap();
    let personal = writing::personal::Personal::from_bytes(&std::fs::read(&store).unwrap());
    assert!(personal.word_count("com") >= 1.0);
    // Off: the swipes do nothing again.
    swipe(&mut connection, &mut band, RIGHT, 4.0);
    assert!(connection.take_actions().is_empty());
}

#[test]
fn practice_turns_suggestions_and_corrections_off() {
    let dir = tempfile::tempdir().unwrap();
    let (mut connection, mut band, _) = with_suggestions(dir.path());
    connection.writing_train(Some("nao casa"));
    events(&mut connection);
    // n, a, o, space: "nao" stays as written, nothing is suggested.
    write(&mut connection, &mut band, &[13, 99, 0, 99, 14, 99, 88], 3.0);
    let written = events(&mut connection);
    assert_eq!(last(&written, "text").unwrap()["text"], "nao ");
    assert!(written.iter().filter(|e| e["type"] == "suggest").all(|e| e["kind"] == "none"));
    connection.writing_train(None);
    write(&mut connection, &mut band, &[13, 99, 0, 99, 14, 99, 88], 3.4);
    assert_eq!(last(&events(&mut connection), "text").unwrap()["text"], "nao não ");
}
