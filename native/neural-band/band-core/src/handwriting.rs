//! The band's built-in handwriting model, read as text (kinesis `BandModelCapture.swift`
//! `BandInferenceSample` and `ExperimentalHandwritingDecoder.swift`, MIT).
//!
//! The band streams its model's output as inference samples (kind 0x0200020c). Pipeline 3 is
//! handwriting: 100 log-probabilities per sample, one per class. The classes follow Meta's
//! public research character set (generic-neuromotor-interface `handwriting_utils.py`); that
//! the consumer firmware uses the same order is what this decoder assumes and what a test on
//! the band confirms.

use crate::error::{Result, perr};
use crate::proto::ProtoFields;

/// The inference pipeline the handwriting model writes to.
pub const HANDWRITING_PIPELINE: u64 = 3;
/// Classes per handwriting sample; the last one is the CTC blank.
pub const CLASSES: usize = 100;
pub const BLANK: usize = 99;

const LETTERS_AND_DIGITS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PUNCTUATION: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
/// Classes 94 to 98, after the printable characters.
const EDITS: [&str; 5] = ["⌫", "⏎", " ", "⇧", "🤏"];

/// What a class does to the text, where it isn't a character to type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edit {
    /// Seen after letters and edits on the band; no known meaning, adds nothing.
    Boundary,
    Space,
    Backspace,
    Newline,
    /// Capitalizes the next letter (an up arrow).
    Shift,
}

/// Class meanings seen on the band (kinesis' wearer tests): 88's forward push is a space, 94's
/// backward sweep deletes, an up arrow (97) shifts; 87 and 98 carry no text.
pub fn edit(class: usize) -> Option<Edit> {
    match class {
        87 | 98 => Some(Edit::Boundary),
        88 | 96 => Some(Edit::Space),
        94 => Some(Edit::Backspace),
        95 => Some(Edit::Newline),
        97 => Some(Edit::Shift),
        _ => None,
    }
}

/// The glyph of a class (`⌫`, `⏎`, `⇧`, `🤏` for the edits), for the raw class trail.
pub fn glyph(class: usize) -> String {
    let printable = LETTERS_AND_DIGITS.len() + PUNCTUATION.len();
    if class < LETTERS_AND_DIGITS.len() {
        LETTERS_AND_DIGITS[class..class + 1].to_owned()
    } else if class < printable {
        let index = class - LETTERS_AND_DIGITS.len();
        PUNCTUATION[index..index + 1].to_owned()
    } else {
        EDITS.get(class - printable).map_or_else(String::new, |edit| (*edit).to_owned())
    }
}

/// One inference sample as the band sent it. Its values are model outputs, not characters.
#[derive(Debug, Clone, PartialEq)]
pub struct InferenceSample {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub pipeline: u64,
    pub latency_us: Option<u64>,
    pub values: Vec<f32>,
}

impl InferenceSample {
    /// Fields: 1 sequence, 2 timestamp (µs), 3 little-endian floats, 7 latency (optional),
    /// 10 pipeline.
    pub fn parse(payload: &[u8]) -> Result<Self> {
        let fields = ProtoFields::parse(payload)?;
        let sequence = fields.required_integer(1)?;
        let timestamp_us = fields.required_integer(2)?;
        let pipeline = fields.required_integer(10)?;
        if sequence > u64::from(u32::MAX) || pipeline > u64::from(u32::MAX) {
            return Err(perr("Invalid inference sample identifier"));
        }
        let latency_us = if fields.contains(7) {
            Some(fields.integer(7)?)
        } else {
            None
        };
        let bytes = fields.bytes(3)?;
        if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() > 4096 {
            return Err(perr("Invalid inference sample dimensions"));
        }
        let values: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|four| f32::from_le_bytes([four[0], four[1], four[2], four[3]]))
            .collect();
        if !values.iter().all(|value| value.is_finite()) {
            return Err(perr("Nonfinite inference sample"));
        }
        Ok(Self {
            sequence,
            timestamp_us,
            pipeline,
            latency_us,
            values,
        })
    }

    /// A handwriting distribution: pipeline 3, 100 log-probabilities (all ≤ 0) whose
    /// exponentials add up to 1.
    pub fn is_text_distribution(&self) -> bool {
        self.pipeline == HANDWRITING_PIPELINE
            && self.values.len() == CLASSES
            && self.values.iter().all(|&value| value <= 0.000_001)
            && (self.values.iter().map(|&value| f64::from(value).exp()).sum::<f64>() - 1.0).abs()
                < 0.000_1
    }

    /// The most likely class (the first one on a tie).
    pub fn best_class(&self) -> usize {
        let mut best = 0;
        for (index, &value) in self.values.iter().enumerate() {
            if value > self.values[best] {
                best = index;
            }
        }
        best
    }
}

/// Greedy CTC over the samples: each sample's most likely class, without blanks and without
/// repeats of the class before it. A gap in the sequence or the clock forgets that class, so
/// a letter written twice across a gap counts twice.
#[derive(Debug, Default, Clone)]
pub struct HandwritingDecoder {
    text: String,
    raw: String,
    shifted: bool,
    previous_class: Option<usize>,
    previous_sequence: Option<u64>,
    previous_timestamp: Option<u64>,
    discontinuities: usize,
}

impl HandwritingDecoder {
    /// The text written so far, with the edits applied (spaces, deletions, capitals).
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Every class emitted since the last reset, as glyphs.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn discontinuities(&self) -> usize {
        self.discontinuities
    }

    /// Start over from `text` (what the field already holds); the collapse state stays, so a
    /// class still held across the reset isn't typed twice.
    pub fn reset(&mut self, text: &str) {
        self.text = text.to_owned();
        self.raw.clear();
        self.shifted = false;
    }

    /// Replace the text (a word completed or corrected) and carry on writing after it: the raw
    /// trail, a pending capital and the collapse state stay.
    pub fn set_text(&mut self, text: &str) {
        self.text = text.to_owned();
    }

    /// The next letter will be a capital (an up arrow was written).
    pub fn shifted(&self) -> bool {
        self.shifted
    }

    /// Reads one sample; returns the class it emitted, if any.
    pub fn consume(&mut self, sample: &InferenceSample) -> Option<usize> {
        if !sample.is_text_distribution() {
            return None;
        }
        if self.previous_sequence == Some(sample.sequence)
            && self.previous_timestamp == Some(sample.timestamp_us)
        {
            return None;
        }
        if let (Some(sequence), Some(timestamp)) = (self.previous_sequence, self.previous_timestamp)
            && (sample.sequence != (sequence + 1) & u64::from(u32::MAX)
                || sample.timestamp_us <= timestamp)
        {
            self.previous_class = None;
            self.discontinuities += 1;
        }
        self.previous_sequence = Some(sample.sequence);
        self.previous_timestamp = Some(sample.timestamp_us);
        let class = sample.best_class();
        let previous = self.previous_class.replace(class);
        if class == BLANK || Some(class) == previous {
            return None;
        }
        self.raw.push_str(&glyph(class));
        match edit(class) {
            Some(Edit::Boundary) => {}
            Some(Edit::Shift) => self.shifted = true,
            Some(Edit::Space) => {
                self.text.push(' ');
                self.shifted = false;
            }
            Some(Edit::Backspace) => {
                self.text.pop();
            }
            Some(Edit::Newline) => {
                self.text.push('\n');
                self.shifted = false;
            }
            None => {
                let character = glyph(class);
                if self.shifted {
                    self.text.push_str(&character.to_uppercase());
                } else {
                    self.text.push_str(&character);
                }
                self.shifted = false;
            }
        }
        Some(class)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A distribution whose most likely class is `class`.
    fn sample(sequence: u64, class: usize) -> InferenceSample {
        let rest = (1.0 - 0.9) / (CLASSES as f64 - 1.0);
        let values = (0..CLASSES)
            .map(|index| (if index == class { 0.9f64 } else { rest }).ln() as f32)
            .collect();
        InferenceSample {
            sequence,
            timestamp_us: sequence * 15_625,
            pipeline: HANDWRITING_PIPELINE,
            latency_us: None,
            values,
        }
    }

    fn run(classes: &[usize]) -> HandwritingDecoder {
        let mut decoder = HandwritingDecoder::default();
        for (index, &class) in classes.iter().enumerate() {
            decoder.consume(&sample(index as u64 + 1, class));
        }
        decoder
    }

    #[test]
    fn classes_follow_the_research_character_set() {
        assert_eq!(glyph(0), "a");
        assert_eq!(glyph(26), "A");
        assert_eq!(glyph(52), "0");
        assert_eq!(glyph(62), "!");
        assert_eq!(glyph(93), "~");
        assert_eq!(glyph(94), "⌫");
        assert_eq!(glyph(96), " ");
        assert_eq!(glyph(98), "🤏");
    }

    #[test]
    fn blanks_and_repeats_collapse_and_a_blank_separates_doubles() {
        // h h _ i _ _ i: the repeated h collapses, the blank between the two i keeps both.
        let h = 7;
        let i = 8;
        assert_eq!(run(&[h, h, BLANK, i, BLANK, BLANK, i]).text(), "hii");
        assert_eq!(run(&[h, h, h, i, i]).text(), "hi");
    }

    #[test]
    fn edits_apply_to_the_text() {
        // shift, h, i, space, x, backspace, newline
        let decoder = run(&[97, BLANK, 7, BLANK, 8, BLANK, 88, BLANK, 23, BLANK, 94, BLANK, 95]);
        assert_eq!(decoder.text(), "Hi \n");
        assert_eq!(decoder.raw(), "⇧hi_x⌫⏎");
        // Boundaries add nothing.
        assert_eq!(run(&[0, 87, 1, 98]).text(), "ab");
    }

    #[test]
    fn set_text_keeps_writing_after_the_new_text() {
        // shift, then the text changes (a word completed): the capital still applies.
        let mut decoder = run(&[0, BLANK, 97]);
        decoder.set_text("ab ");
        assert!(decoder.shifted());
        decoder.consume(&sample(4, BLANK));
        decoder.consume(&sample(5, 2));
        assert_eq!(decoder.text(), "ab C");
        assert!(!decoder.shifted());
    }

    #[test]
    fn a_gap_in_the_sequence_forgets_the_previous_class() {
        let mut decoder = HandwritingDecoder::default();
        decoder.consume(&sample(1, 0));
        decoder.consume(&sample(5, 0));
        assert_eq!(decoder.text(), "aa");
        assert_eq!(decoder.discontinuities(), 1);
        // A repeated sample is ignored.
        decoder.consume(&sample(5, 1));
        assert_eq!(decoder.text(), "aa");
    }

    #[test]
    fn reset_keeps_the_field_text_and_the_held_class() {
        let mut decoder = HandwritingDecoder::default();
        decoder.consume(&sample(1, 0));
        decoder.reset("Café ");
        decoder.consume(&sample(2, 0));
        decoder.consume(&sample(3, 1));
        assert_eq!(decoder.text(), "Café b");
    }

    #[test]
    fn other_pipelines_and_shapes_are_not_text() {
        let mut other = sample(1, 0);
        other.pipeline = 1;
        assert!(!other.is_text_distribution());
        let mut short = sample(1, 0);
        short.values.truncate(50);
        assert!(!short.is_text_distribution());
        let mut positive = sample(1, 0);
        positive.values[3] = 0.5;
        assert!(!positive.is_text_distribution());
    }

    #[test]
    fn samples_parse_from_the_band_payload() {
        use crate::proto::{field_bytes, field_int};
        let floats: Vec<u8> = [-0.5f32, -1.0, -2.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let payload = [
            field_int(1, 7),
            field_int(2, 1_000),
            field_bytes(3, &floats),
            field_int(10, 3),
        ]
        .concat();
        let parsed = InferenceSample::parse(&payload).unwrap();
        assert_eq!(parsed.sequence, 7);
        assert_eq!(parsed.pipeline, 3);
        assert_eq!(parsed.values, vec![-0.5, -1.0, -2.0]);
        assert_eq!(parsed.latency_us, None);
        assert!(InferenceSample::parse(&field_int(1, 7)).is_err());
    }
}
