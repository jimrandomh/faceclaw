use super::*;
use crate::build::LexiconBuilder;
use crate::channel::tests::values;
use crate::personal::Personal;

fn lexicon() -> Lexicon {
    let mut b = LexiconBuilder::default();
    for (word, cost) in [
        ("não", 4.0), ("você", 4.5), ("vocês", 7.0), ("voltou", 8.5), ("está", 5.1), ("esta", 6.7), ("eu", 4.2),
        ("sei", 7.0), ("vou", 6.0), ("posso", 7.0), ("tudo", 6.0), ("bem", 6.0), ("com", 4.5), ("oi", 7.0),
        ("teste", 9.0), ("aqui", 6.5), ("leve", 9.0), ("lume", 12.0), ("casa", 6.0),
    ] {
        b.word(word, Lang::Pt, cost, false);
    }
    for (word, cost) in [("the", 3.4), ("they", 6.0), ("there", 6.0), ("don't", 5.4), ("I", 3.7), ("lumen", 13.8)] {
        b.word(word, Lang::En, cost, false);
    }
    for (head, next, cost) in [("eu", "não", 1.7), ("não", "sei", 3.4), ("com", "você", 2.5), ("você", "está", 2.5), ("você", "vai", 3.5)] {
        b.pair(Lang::Pt, head, next, cost);
        b.backoff(Lang::Pt, head, 2.0);
    }
    Lexicon::from_bytes(b.finish()).unwrap()
}

fn assistant() -> Assistant {
    Assistant::new(lexicon(), Personal::default(), Settings { autocorrect: true, learn: true }, 20_000)
}

fn class_of(c: char) -> usize {
    match c {
        'a'..='z' => c as usize - 'a' as usize,
        'A'..='Z' => 26 + c as usize - 'A' as usize,
        '0'..='9' => 52 + c as usize - '0' as usize,
        ' ' => 88,
        _ => panic!("no class for {c}"),
    }
}

/// The band writes `chars` after `text` (each letter 85 % sure); returns the text as it ends
/// up and the last outcome.
fn write(a: &mut Assistant, text: &str, chars: &str) -> (String, Outcome) {
    let mut text = text.to_owned();
    let mut outcome = Outcome::default();
    for (index, c) in chars.chars().enumerate() {
        let class = class_of(c);
        a.frame(index as u64 * 156_250, &values(&[(class, 0.85)]));
        text.push(c);
        outcome = a.written(&text, class);
        if let Some(new) = &outcome.text {
            text = new.clone();
        }
    }
    (text, outcome)
}

#[test]
fn a_word_being_written_gets_completions_and_the_gray_rest() {
    let mut a = assistant();
    a.reset("oi tudo bem com ");
    let (text, _) = write(&mut a, "oi tudo bem com ", "vo");
    assert_eq!(text, "oi tudo bem com vo");
    assert_eq!(a.kind(), Kind::Word);
    assert_eq!(a.items().first(), Some(&"você"), "{:?}", a.items());
    assert_eq!(a.ghost(), "cê");
    // Down moves to the next suggestion, and the gray rest follows it.
    let before = a.rev();
    a.command(Op::Next, &text);
    assert_eq!(a.selected(), 1);
    assert!(a.rev() > before);
    a.command(Op::Previous, &text);
    assert_eq!(a.selected(), 0);
}

#[test]
fn accepting_writes_the_word_and_a_space_then_predicts_the_next() {
    let mut a = assistant();
    a.reset("oi tudo bem com ");
    let (text, _) = write(&mut a, "oi tudo bem com ", "vo");
    let outcome = a.command(Op::Accept, &text);
    assert_eq!(outcome.text.as_deref(), Some("oi tudo bem com você "));
    assert_eq!(a.notice(), Some(&Notice::Accepted { word: "você".into() }));
    assert_eq!(a.mark(), Some((16, 20)));
    assert_eq!(a.kind(), Kind::Next);
    assert_eq!(a.items().first(), Some(&"está"));
    assert_eq!(a.ghost(), "está");
    // Accepting the prediction too.
    let outcome = a.command(Op::Accept, "oi tudo bem com você ");
    assert_eq!(outcome.text.as_deref(), Some("oi tudo bem com você está "));
    // Left undoes the last one.
    let outcome = a.command(Op::Undo, "oi tudo bem com você está ");
    assert_eq!(outcome.text.as_deref(), Some("oi tudo bem com você "));
}

#[test]
fn a_word_without_its_accent_is_corrected_at_the_space_and_undo_teaches_it() {
    let mut a = assistant();
    a.reset("");
    let (text, outcome) = write(&mut a, "", "eu nao ");
    assert_eq!(outcome.text.as_deref(), Some("eu não "));
    assert_eq!(text, "eu não ");
    assert_eq!(a.notice(), Some(&Notice::Corrected { from: "nao".into(), to: "não".into() }));
    assert!(a.can_undo());
    // The next word after "não" is predicted.
    assert_eq!(a.kind(), Kind::Next);
    assert_eq!(a.items().first(), Some(&"sei"));
    // Undo: "nao" stands and won't be corrected again.
    let outcome = a.command(Op::Undo, &text);
    assert_eq!(outcome.text.as_deref(), Some("eu nao "));
    let (text, outcome) = write(&mut a, "eu nao ", "nao ");
    assert_eq!(outcome.text, None, "{text}");
    assert_eq!(text, "eu nao nao ");
}

#[test]
fn capitals_carry_over_to_the_correction() {
    let mut a = assistant();
    a.reset("");
    let (text, _) = write(&mut a, "", "Nao ");
    assert_eq!(text, "Não ");
}

#[test]
fn a_known_word_stays_without_a_clear_reason() {
    let mut a = assistant();
    a.reset("");
    let (text, outcome) = write(&mut a, "", "casa ");
    assert_eq!(outcome.text, None);
    assert_eq!(text, "casa ");
    // And a word nobody knows, written clearly, stays as written.
    let (text, _) = write(&mut a, "casa ", "xq7 ");
    assert_eq!(text, "casa xq7 ");
}

#[test]
fn a_letter_the_band_misread_is_corrected_from_its_runner_up() {
    let mut a = assistant();
    a.reset("");
    // "1" at 60 % with "l" at 35 %, then "umen" clearly.
    a.frame(0, &values(&[(53, 0.6), (11, 0.35)]));
    a.written("1", 53);
    let (text, outcome) = write(&mut a, "1", "umen ");
    assert_eq!(outcome.text.as_deref(), Some("lumen "), "{text}");
}

#[test]
fn a_name_written_clearly_stays_as_written() {
    let mut a = assistant();
    a.reset("");
    // "levi" isn't in the lexicon, but each letter was clear: "leve" would need an "i" read as
    // an "e".
    let (text, outcome) = write(&mut a, "", "levi ");
    assert_eq!(outcome.text, None, "{text}");
}

#[test]
fn an_undone_correction_becomes_the_wearers_word() {
    let mut a = assistant();
    a.reset("");
    // "tdo" (short for "tudo") is corrected; the wearer undoes it.
    let (text, outcome) = write(&mut a, "", "tdo ");
    assert_eq!(outcome.text.as_deref(), Some("tudo "), "{text}");
    a.command(Op::Undo, "tudo ");
    let (text, outcome) = write(&mut a, "tdo ", "tdo ");
    assert_eq!(outcome.text, None, "{text}");
    let (text, _) = write(&mut a, &text, "td");
    assert!(a.items().contains(&"tdo"), "{text}: {:?}", a.items());
}

#[test]
fn what_was_learned_is_kept_in_the_store() {
    let mut a = assistant();
    a.reset("");
    write(&mut a, "", "eu tudo ");
    let bytes = a.finish().expect("learned something");
    let personal = Personal::from_bytes(&bytes);
    assert!(personal.word_count("eu") >= 1.0);
    assert!(personal.word_count("tudo") >= 1.0);
    assert!(personal.pair_count("eu", "tudo") >= 1.0);
    assert!(personal.langs[Lang::Pt as usize] >= 2.0);
    // Nothing more to save after that.
    assert!(a.finish().is_none());
}

#[test]
fn a_field_that_doesnt_learn_doesnt_and_one_that_doesnt_correct_doesnt() {
    let mut a = Assistant::new(lexicon(), Personal::default(), Settings { autocorrect: false, learn: false }, 20_000);
    a.reset("");
    let (text, _) = write(&mut a, "", "eu nao ");
    assert_eq!(text, "eu nao ");
    assert!(a.finish().is_none());
}

#[test]
fn the_wearers_letters_teach_the_bias() {
    let mut a = assistant();
    a.reset("");
    // "l" written five times as a "1" with "l" second: "lumen" confirmed each time.
    let mut text = String::new();
    for _ in 0..5 {
        a.frame(0, &values(&[(53, 0.6), (11, 0.35)]));
        text.push('1');
        a.written(&text, 53);
        let (t, _) = write(&mut a, &text, "umen ");
        text = t;
    }
    a.finish();
    let personal = Personal::from_bytes(&a.personal_bytes());
    assert!(personal.bias[11] > 0.0, "l: {}", personal.bias[11]);
    assert!(personal.bias[53] < 0.0, "1: {}", personal.bias[53]);
}

#[test]
fn a_correction_goes_first_only_when_clearly_better() {
    let mut b = LexiconBuilder::default();
    for (word, cost) in [("um", 4.0), ("lume", 12.0), ("lumes", 13.0)] {
        b.word(word, Lang::Pt, cost, false);
    }
    let mut a = Assistant::new(Lexicon::from_bytes(b.finish()).unwrap(), Personal::default(), Settings { autocorrect: true, learn: true }, 20_000);
    a.reset("");
    write(&mut a, "", "lum");
    // "um" is far likelier, but it drops a letter written clearly: "lume" goes first.
    assert_eq!(a.items().first(), Some(&"lume"), "{:?}", a.items());
    assert!(a.items().contains(&"um"));
}

#[test]
fn practice_suggests_nothing_corrects_nothing_and_teaches_the_expected_letters() {
    let mut a = assistant();
    a.reset("");
    a.set_training(Some("lumen casa"), "");
    assert!(a.training());
    // "l" written five times as a "1" with "l" second, the trainer expecting "lumen".
    a.frame(0, &values(&[(53, 0.6), (11, 0.35)]));
    a.written("1", 53);
    let (text, outcome) = write(&mut a, "1", "umen ");
    // Nothing changes the text and nothing is suggested.
    assert_eq!(outcome.text, None);
    assert_eq!(text, "1umen ");
    assert_eq!(a.kind(), Kind::None);
    assert!(a.items().is_empty());
    write(&mut a, &text, "cas");
    assert!(a.items().is_empty());
    let bytes = a.finish().expect("it learned");
    let personal = Personal::from_bytes(&bytes);
    assert!(personal.bias[11] > 0.0, "l: {}", personal.bias[11]);
    // The trainer's words aren't the wearer's own.
    assert_eq!(personal.word_count("lumen"), 0.0);
    assert_eq!(personal.word_count("1umen"), 0.0);
    // Practice over: suggestions again.
    a.set_training(None, "1umen cas");
    write(&mut a, "1umen cas", "");
    a.reset("1umen ca");
    assert!(!a.training());
}

#[test]
fn practice_counts_words_from_where_it_started() {
    let mut a = assistant();
    a.reset("oi ");
    a.set_training(Some("lumen"), "oi ");
    a.frame(0, &values(&[(53, 0.6), (11, 0.35)]));
    a.written("oi 1", 53);
    write(&mut a, "oi 1", "umen ");
    let personal = Personal::from_bytes(&a.finish().unwrap());
    assert!(personal.bias[11] > 0.0);
}
