//! What the wearer taught: their words and which follow which, the bias of their letters, how
//! the suggestions are weighed, the languages they write, and how sure a correction must be.
//! Kept in one small file on the glasses (never in a log), forgotten gradually: a word unused
//! for weeks fades (LatinIME's forgetting, a half-life of about three weeks here).

use std::collections::{HashMap, HashSet};

use band_core::handwriting::CLASSES;

use crate::format::LANGS;

const MAGIC: &[u8; 4] = b"LWPS";
const VERSION: u32 = 1;
/// The ranking's features (see `assistant::Features`).
pub const FEATURES: usize = 6;
pub const DEFAULT_WEIGHTS: [f32; FEATURES] = [1.0, 0.55, 0.25, 0.6, 0.8, -0.5];
/// How sure a correction must be (score margin), where it starts and its bounds.
pub const DEFAULT_MARGIN: f32 = 2.0;
pub const MARGIN_RANGE: (f32, f32) = (1.0, 6.0);
/// Per day unused.
const DECAY: f32 = 0.97;
const FORGOTTEN: f32 = 0.1;
const MAX_WORDS: usize = 20_000;
const MAX_PAIRS: usize = 40_000;
const MAX_BLOCKED: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Usage {
    pub count: f32,
    /// Days since 1970 it was last used.
    pub day: u32,
}

#[derive(Debug, Clone)]
pub struct Personal {
    /// Spelling (lower case unless the wearer capitalizes it) -> use.
    pub words: HashMap<String, Usage>,
    /// (previous word, word), lower case; "" for the start of a text.
    pub pairs: HashMap<(String, String), Usage>,
    pub bias: [f32; CLASSES],
    pub weights: [f32; FEATURES],
    /// Words confirmed per language (English, Portuguese).
    pub langs: [f32; LANGS],
    pub margin: f32,
    /// Corrections the wearer undid: (folded written word, correction).
    pub blocked: HashSet<(String, String)>,
}

impl Default for Personal {
    fn default() -> Self {
        Self {
            words: HashMap::new(),
            pairs: HashMap::new(),
            bias: [0.0; CLASSES],
            weights: DEFAULT_WEIGHTS,
            langs: [0.0; LANGS],
            margin: DEFAULT_MARGIN,
            blocked: HashSet::new(),
        }
    }
}

fn bump(map_usage: &mut Usage, by: f32, today: u32) {
    map_usage.count += by;
    map_usage.day = today;
}

impl Personal {
    pub fn use_word(&mut self, word: &str, by: f32, today: u32) {
        bump(self.words.entry(word.to_owned()).or_insert(Usage { count: 0.0, day: today }), by, today);
    }

    pub fn use_pair(&mut self, previous: &str, word: &str, by: f32, today: u32) {
        let key = (previous.to_lowercase(), word.to_lowercase());
        bump(self.pairs.entry(key).or_insert(Usage { count: 0.0, day: today }), by, today);
    }

    pub fn word_count(&self, word: &str) -> f32 {
        self.words.get(word).map_or(0.0, |u| u.count)
    }

    pub fn pair_count(&self, previous: &str, word: &str) -> f32 {
        self.pairs.get(&(previous.to_lowercase(), word.to_lowercase())).map_or(0.0, |u| u.count)
    }

    /// Fades what wasn't used since its day, as of `today`, and drops what faded out.
    pub fn decay(&mut self, today: u32) {
        let fade = |usage: &mut Usage| {
            let days = today.saturating_sub(usage.day);
            if days > 0 {
                usage.count *= DECAY.powi(days.min(3650) as i32);
                usage.day = today;
            }
            usage.count >= FORGOTTEN
        };
        self.words.retain(|_, usage| fade(usage));
        self.pairs.retain(|_, usage| fade(usage));
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        let text = |out: &mut Vec<u8>, s: &str| {
            let bytes = &s.as_bytes()[..s.len().min(255)];
            out.push(bytes.len() as u8);
            out.extend_from_slice(bytes);
        };
        let usage = |out: &mut Vec<u8>, u: &Usage| {
            out.extend_from_slice(&u.count.to_le_bytes());
            out.extend_from_slice(&u.day.to_le_bytes());
        };
        let mut words: Vec<(&String, &Usage)> = self.words.iter().collect();
        words.sort_by(|a, b| b.1.count.total_cmp(&a.1.count).then(a.0.cmp(b.0)));
        words.truncate(MAX_WORDS);
        out.extend_from_slice(&(words.len() as u32).to_le_bytes());
        for (word, u) in words {
            text(&mut out, word);
            usage(&mut out, u);
        }
        let mut pairs: Vec<(&(String, String), &Usage)> = self.pairs.iter().collect();
        pairs.sort_by(|a, b| b.1.count.total_cmp(&a.1.count).then(a.0.cmp(b.0)));
        pairs.truncate(MAX_PAIRS);
        out.extend_from_slice(&(pairs.len() as u32).to_le_bytes());
        for ((a, b), u) in pairs {
            text(&mut out, a);
            text(&mut out, b);
            usage(&mut out, u);
        }
        for value in self.bias.iter().chain(&self.weights).chain(&self.langs).chain(std::iter::once(&self.margin)) {
            out.extend_from_slice(&value.to_le_bytes());
        }
        let mut blocked: Vec<&(String, String)> = self.blocked.iter().collect();
        blocked.sort();
        blocked.truncate(MAX_BLOCKED);
        out.extend_from_slice(&(blocked.len() as u32).to_le_bytes());
        for (a, b) in blocked {
            text(&mut out, a);
            text(&mut out, b);
        }
        out
    }

    /// The store from its bytes; anything unreadable (another version, a cut file) is a fresh
    /// start, never an error that stops the writing.
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self::parse(bytes).unwrap_or_default()
    }

    fn parse(bytes: &[u8]) -> Option<Self> {
        let mut at = 0usize;
        let take = |at: &mut usize, n: usize| -> Option<&[u8]> {
            let slice = bytes.get(*at..*at + n)?;
            *at += n;
            Some(slice)
        };
        if take(&mut at, 4)? != MAGIC || u32::from_le_bytes(take(&mut at, 4)?.try_into().ok()?) != VERSION {
            return None;
        }
        let u32_at = |at: &mut usize| -> Option<u32> { Some(u32::from_le_bytes(take(at, 4)?.try_into().ok()?)) };
        let f32_at = |at: &mut usize| -> Option<f32> { Some(f32::from_le_bytes(take(at, 4)?.try_into().ok()?)) };
        let text_at = |at: &mut usize| -> Option<String> {
            let len = *take(at, 1)?.first()? as usize;
            String::from_utf8(take(at, len)?.to_vec()).ok()
        };
        let mut personal = Personal::default();
        for _ in 0..u32_at(&mut at)?.min(MAX_WORDS as u32) {
            let word = text_at(&mut at)?;
            let usage = Usage { count: f32_at(&mut at)?, day: u32_at(&mut at)? };
            personal.words.insert(word, usage);
        }
        for _ in 0..u32_at(&mut at)?.min(MAX_PAIRS as u32) {
            let a = text_at(&mut at)?;
            let b = text_at(&mut at)?;
            let usage = Usage { count: f32_at(&mut at)?, day: u32_at(&mut at)? };
            personal.pairs.insert((a, b), usage);
        }
        for value in personal.bias.iter_mut().chain(personal.weights.iter_mut()).chain(personal.langs.iter_mut()) {
            *value = f32_at(&mut at)?;
        }
        personal.margin = f32_at(&mut at)?;
        for _ in 0..u32_at(&mut at)?.min(MAX_BLOCKED as u32) {
            let a = text_at(&mut at)?;
            let b = text_at(&mut at)?;
            personal.blocked.insert((a, b));
        }
        let finite = personal.bias.iter().chain(&personal.weights).chain(&personal.langs).all(|v| v.is_finite())
            && personal.margin.is_finite();
        finite.then_some(personal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_round_trips_and_a_bad_file_is_a_fresh_start() {
        let mut personal = Personal::default();
        personal.use_word("levi", 2.0, 100);
        personal.use_pair("", "oi", 1.0, 100);
        personal.bias[11] = 0.4;
        personal.margin = 2.5;
        personal.blocked.insert(("levi".into(), "leve".into()));
        let bytes = personal.to_bytes();
        let back = Personal::from_bytes(&bytes);
        assert_eq!(back.word_count("levi"), 2.0);
        assert_eq!(back.pair_count("", "Oi"), 1.0);
        assert_eq!(back.bias[11], 0.4);
        assert_eq!(back.margin, 2.5);
        assert!(back.blocked.contains(&("levi".into(), "leve".into())));
        // Cut, another version, garbage: empty, no panic.
        assert!(Personal::from_bytes(&bytes[..bytes.len() - 3]).words.is_empty());
        assert!(Personal::from_bytes(b"LWPS\x09\0\0\0").words.is_empty());
        assert!(Personal::from_bytes(&[0xff; 64]).words.is_empty());
    }

    #[test]
    fn unused_words_fade_and_go() {
        let mut personal = Personal::default();
        personal.use_word("levi", 1.0, 0);
        personal.use_word("lumen", 10.0, 0);
        personal.decay(30);
        assert!(personal.word_count("lumen") > 3.0 && personal.word_count("lumen") < 5.0);
        personal.decay(120);
        assert_eq!(personal.word_count("levi"), 0.0);
        assert!(personal.words.contains_key("lumen"));
    }
}
