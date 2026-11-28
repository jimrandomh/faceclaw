//! The writing's suggestions, word by word, as the band's decoder writes (see the crate's
//! description). It follows the decoder's text: each letter gets a slot with the band's
//! distribution, the word so far is matched against the lexicon and the wearer's own words,
//! and the candidates are ranked by how well the letters read as them, how likely they are
//! after the previous word, and what the wearer taught. When the word ends (a space,
//! punctuation, a new line) a clearly better word replaces it; the thumb accepts a suggestion,
//! moves between them, or undoes the last change. Every change comes back as the decoder's new
//! text, so the field gets it as one edit.

use band_core::handwriting::{CLASSES, Edit, edit};

use crate::channel::{self, INSERT, Slot};
use crate::fold::{self, Case};
use crate::format::LANGS;
use crate::lexicon::{Lang, Lexicon};
use crate::personal::{FEATURES, MARGIN_RANGE, Personal};
use crate::search;

/// Suggestions shown at once.
pub const SHOWN: usize = 3;
/// A word not in any list, as a cost: how unlikely an unknown word is (rarer than the rarest
/// word kept, about 14).
const UNKNOWN: f32 = 22.0;
/// A word only the wearer uses, before their counts.
const OWN_WORD: f32 = 9.0;
/// A correction to a word the lexicon also has (esta -> está) needs this much more.
const KNOWN_WORD_EXTRA: f32 = 2.0;
/// Accents put back on letters that make no word without them (nao -> não): this sure.
const ACCENT_ONLY_MARGIN: f32 = 0.5;
/// A suggestion that changes written letters goes first when it's better by this share of the
/// correction margin (the thumb is a choice, a correction isn't).
const FIRST_MARGIN: f32 = 0.5;
/// Learning rates: the ranking, the letters' bias.
const RANK_RATE: f32 = 0.05;
const BIAS_RATE: f32 = 0.03;
/// A confirmed word teaches the letters only when it read this well.
const TEACHING_COST: f32 = 6.0;
/// A practice word is known: it teaches even when the band read it badly, short of another word.
const TRAINING_COST: f32 = 14.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// Correct a word when it ends.
    pub autocorrect: bool,
    /// Learn from this field (not from a password, an e-mail address, a web address).
    pub learn: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Accept,
    Undo,
    Next,
    Previous,
}

impl Op {
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "accept" => Op::Accept,
            "undo" => Op::Undo,
            "next" => Op::Next,
            "previous" => Op::Previous,
            _ => return None,
        })
    }
}

/// What the suggestions are about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Nothing to suggest.
    None,
    /// The word being written: completions and corrections.
    Word,
    /// The next word.
    Next,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::None => "none",
            Kind::Word => "word",
            Kind::Next => "next",
        }
    }
}

/// A change the panel tells about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Corrected { from: String, to: String },
    Accepted { word: String },
    Undone { word: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The decoder's new text, when it changed.
    pub text: Option<String>,
}

/// The ranking's features, lower is likelier: [channel, language model, letters left,
/// completion, letters changed, the wearer's word].
type Features = [f32; FEATURES];

#[derive(Debug, Clone)]
struct Candidate {
    /// The spelling, in the written case.
    surface: String,
    features: Features,
    score: f32,
}

#[derive(Debug, Clone)]
enum Change {
    Accepted,
    Corrected { written: String, corrected: String, features: (Features, Features) },
}

#[derive(Debug, Clone)]
struct Undo {
    before: String,
    after: String,
    change: Change,
    slots: Vec<Slot>,
    letters: String,
}

/// A word confirmed but not yet learned: it is learned once writing goes on past it (or ends)
/// without an undo.
#[derive(Debug, Clone)]
struct Pending {
    word: String,
    previous: Option<String>,
    slots: Vec<Slot>,
    /// It was a correction: kept, it makes the next ones a little bolder.
    corrected: bool,
    /// Practice: the word the wearer was asked to write here.
    expected: Option<String>,
}

pub struct Assistant {
    lexicon: Lexicon,
    personal: Personal,
    settings: Settings,
    today: u32,
    slots: Vec<Slot>,
    /// The folded letters the slots stand for.
    letters: String,
    /// The class of the letter the last slot is reading, while the band still writes it.
    open_class: Option<usize>,
    last_frame: Option<(u64, Vec<f32>)>,
    /// When the band last wrote something (its clock, µs).
    last_stroke: Option<u64>,
    candidates: Vec<Candidate>,
    selected: usize,
    kind: Kind,
    /// The word the suggestions are for, as written.
    word: String,
    undo: Option<Undo>,
    pending: Option<Pending>,
    notice: Option<Notice>,
    /// UTF-16 range of the word just changed, in the text.
    mark: Option<(usize, usize)>,
    rev: u64,
    dirty: bool,
    /// Practice: the words the wearer is about to write (folded), and how many words the text
    /// had when they were given. No suggestions, no corrections; each word teaches the letters.
    training: Option<(Vec<String>, usize)>,
}

fn split_word(text: &str) -> (&str, &str) {
    let start = text
        .char_indices()
        .rev()
        .take_while(|(_, c)| fold::is_word_char(*c))
        .last()
        .map_or(text.len(), |(index, _)| index);
    (&text[..start], &text[start..])
}

/// The word before `before` (what precedes the current word), if the sentence goes on from it.
fn previous_word(before: &str) -> Option<String> {
    let trimmed = before.trim_end_matches([' ', '\t']);
    if trimmed.ends_with(['.', '!', '?', '\n']) || trimmed.is_empty() {
        return None;
    }
    let (_, word) = split_word(trimmed.trim_end_matches([',', ';', ':']));
    (!word.is_empty()).then(|| word.to_owned())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn score(weights: &Features, features: &Features) -> f32 {
    weights.iter().zip(features).map(|(w, f)| w * f).sum()
}

impl Assistant {
    pub fn new(lexicon: Lexicon, personal: Personal, settings: Settings, today: u32) -> Self {
        let mut personal = personal;
        personal.decay(today);
        Self {
            lexicon,
            personal,
            settings,
            today,
            slots: Vec::new(),
            letters: String::new(),
            open_class: None,
            last_frame: None,
            last_stroke: None,
            candidates: Vec::new(),
            selected: 0,
            kind: Kind::None,
            word: String::new(),
            undo: None,
            pending: None,
            notice: None,
            mark: None,
            rev: 0,
            dirty: false,
            training: None,
        }
    }

    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
    }

    /// Practice (a writing trainer told Lumen the text to come): `expected` is what the wearer
    /// is about to write after `text`, the decoder's text now; `None` ends it. Meanwhile nothing
    /// is suggested or corrected, and each word that ends teaches the letters' bias the expected
    /// word (a known answer, better than a guess), without counting as the wearer's own word.
    pub fn set_training(&mut self, expected: Option<&str>, text: &str) {
        self.finish_pending();
        self.training = expected.map(|expected| {
            let words = expected.split_whitespace().map(fold::fold).filter(|w| !w.is_empty()).collect();
            (words, Self::words_in(text))
        });
        self.undo = None;
        let ended = text.is_empty() || text.ends_with(|c: char| !fold::is_word_char(c));
        self.refresh(text, ended);
    }

    pub fn training(&self) -> bool {
        self.training.is_some()
    }

    /// Words in `text` (runs of word characters).
    fn words_in(text: &str) -> usize {
        text.split(|c: char| !fold::is_word_char(c)).filter(|w| !w.is_empty()).count()
    }

    /// The text starts over (what the field holds when the writing starts).
    pub fn reset(&mut self, text: &str) {
        self.finish_pending();
        self.undo = None;
        self.slots.clear();
        self.letters.clear();
        self.open_class = None;
        self.sync(text, None);
        self.refresh(text, false);
    }

    /// A sample of the band's model (log-probabilities per class), before the text it adds.
    pub fn frame(&mut self, timestamp_us: u64, values: &[f32]) {
        if values.len() < CLASSES {
            return;
        }
        let best = (0..CLASSES).max_by(|&a, &b| values[a].total_cmp(&values[b])).unwrap_or(0);
        if let Some(open) = self.open_class {
            if best == open {
                if let Some(slot) = self.slots.last_mut() {
                    slot.add(values, &self.personal.bias);
                }
            } else {
                self.open_class = None;
            }
        }
        self.last_frame = Some((timestamp_us, values.to_vec()));
    }

    /// When the band last wrote something, by its clock.
    pub fn last_stroke(&self) -> Option<u64> {
        self.last_stroke
    }

    /// The decoder wrote `class`, its text is now `text`.
    pub fn written(&mut self, text: &str, class: usize) -> Outcome {
        let meaning = edit(class);
        if matches!(meaning, Some(Edit::Boundary)) {
            return Outcome::default();
        }
        if let Some((timestamp, _)) = &self.last_frame {
            self.last_stroke = Some(*timestamp);
        }
        if matches!(meaning, Some(Edit::Shift)) {
            return Outcome::default();
        }
        self.notice = None;
        self.mark = None;
        // Anything written after a change confirms it.
        if self.undo.as_ref().is_some_and(|undo| undo.after != text) {
            self.undo = None;
        }
        let ended = text.chars().last().is_some_and(|c| !fold::is_word_char(c));
        let (_, word) = split_word(text);
        if !ended || !word.is_empty() || matches!(meaning, Some(Edit::Backspace)) {
            // Writing on (a letter, a deletion): the word before is kept.
            if !word.is_empty() && self.pending.is_some() {
                self.finish_pending();
            }
            let class = (fold::fold(word).len() > self.letters.len()).then_some(class);
            self.sync(text, class);
            self.refresh(text, false);
            return Outcome::default();
        }
        // A word ended with the character just written.
        let mut chars = text.chars();
        let separator = chars.next_back().unwrap_or(' ');
        let body = chars.as_str();
        let (before, written) = split_word(body);
        let mut outcome = Outcome::default();
        let mut final_word = written.to_owned();
        if !written.is_empty() {
            if let Some((corrected, features)) = self.correction(before, written) {
                let new_text = format!("{before}{corrected}{separator}");
                self.personal.margin = self.personal.margin.clamp(MARGIN_RANGE.0, MARGIN_RANGE.1);
                self.undo = Some(Undo {
                    before: text.to_owned(),
                    after: new_text.clone(),
                    change: Change::Corrected { written: written.to_owned(), corrected: corrected.clone(), features },
                    slots: self.slots.clone(),
                    letters: self.letters.clone(),
                });
                self.notice = Some(Notice::Corrected { from: written.to_owned(), to: corrected.clone() });
                self.mark = Some((utf16_len(before), utf16_len(before) + utf16_len(&corrected)));
                final_word = corrected;
                outcome.text = Some(new_text);
            }
            self.finish_pending();
            let expected = self.training.as_ref().and_then(|(words, base)| {
                let index = (Self::words_in(body)).checked_sub(base + 1)?;
                words.get(index).cloned()
            });
            self.pending = Some(Pending {
                word: final_word,
                previous: previous_word(before),
                slots: std::mem::take(&mut self.slots),
                corrected: outcome.text.is_some(),
                expected,
            });
        }
        self.slots.clear();
        self.letters.clear();
        self.open_class = None;
        let current = outcome.text.clone().unwrap_or_else(|| text.to_owned());
        self.refresh(&current, true);
        outcome
    }

    /// A thumb gesture (or the touchpad's arrows) on the suggestions.
    pub fn command(&mut self, op: Op, text: &str) -> Outcome {
        match op {
            Op::Next | Op::Previous => {
                if self.candidates.len() > 1 {
                    let n = self.candidates.len();
                    self.selected = if op == Op::Next { (self.selected + 1) % n } else { (self.selected + n - 1) % n };
                    self.rev += 1;
                }
                Outcome::default()
            }
            Op::Accept => self.accept(text),
            Op::Undo => self.undo(text),
        }
    }

    fn accept(&mut self, text: &str) -> Outcome {
        let Some(chosen) = self.candidates.get(self.selected).cloned() else { return Outcome::default() };
        let (before, word) = split_word(text);
        let lead = if word.is_empty() && !before.is_empty() && !before.ends_with([' ', '\n']) { " " } else { "" };
        let new_text = format!("{before}{lead}{} ", chosen.surface);
        let start = utf16_len(before) + utf16_len(lead);
        if self.settings.learn {
            // The chosen one over the others shown.
            let others: Vec<Features> =
                self.candidates.iter().enumerate().filter(|(index, _)| *index != self.selected).map(|(_, c)| c.features).collect();
            for other in others {
                self.teach_ranking(&chosen.features, &other);
            }
        }
        self.finish_pending();
        // With nothing written yet, `before` is the whole text: its last word comes before.
        let previous = previous_word(before);
        self.undo = Some(Undo {
            before: text.to_owned(),
            after: new_text.clone(),
            change: Change::Accepted,
            slots: self.slots.clone(),
            letters: self.letters.clone(),
        });
        self.pending = Some(Pending {
            word: chosen.surface.clone(),
            previous,
            slots: std::mem::take(&mut self.slots),
            corrected: false,
            expected: None,
        });
        self.letters.clear();
        self.open_class = None;
        self.notice = Some(Notice::Accepted { word: chosen.surface.clone() });
        self.mark = Some((start, start + utf16_len(&chosen.surface)));
        self.refresh(&new_text, true);
        Outcome { text: Some(new_text) }
    }

    fn undo(&mut self, text: &str) -> Outcome {
        let Some(undo) = self.undo.take().filter(|undo| undo.after == text) else { return Outcome::default() };
        let pending = self.pending.take();
        let mut notice_word = String::new();
        match &undo.change {
            Change::Corrected { written, corrected, features } => {
                notice_word = written.clone();
                if self.settings.learn {
                    // The wearer meant what they wrote: it is theirs now, and this correction
                    // won't come again; corrections get more careful.
                    self.personal.use_word(&written.to_lowercase(), 2.0, self.today);
                    self.personal.blocked.insert((fold::fold(written), corrected.to_lowercase()));
                    self.personal.margin = (self.personal.margin + 0.5).min(MARGIN_RANGE.1);
                    self.teach_ranking(&features.0, &features.1);
                    self.dirty = true;
                }
                // The written word stands, waiting to be confirmed like any other.
                if let Some(mut pending) = pending {
                    pending.word = written.clone();
                    pending.corrected = false;
                    self.pending = Some(pending);
                }
            }
            Change::Accepted => {
                if let Some(pending) = pending {
                    notice_word = pending.word;
                }
            }
        }
        self.slots = undo.slots;
        self.letters = undo.letters;
        self.open_class = None;
        self.notice = Some(Notice::Undone { word: notice_word });
        self.mark = None;
        let ended = undo.before.chars().last().is_some_and(|c| !fold::is_word_char(c));
        self.refresh(&undo.before, ended);
        Outcome { text: Some(undo.before) }
    }

    /// Makes the slots match the current word of `text`: a new letter (with the band's last
    /// sample when `class` wrote it), a deletion, or anything else (rebuilt without the band).
    fn sync(&mut self, text: &str, class: Option<usize>) {
        let (_, word) = split_word(text);
        let letters = fold::fold(word);
        if letters == self.letters {
            return;
        }
        if letters.len() == self.letters.len() + 1 && letters.starts_with(self.letters.as_str()) {
            let c = letters.chars().last().unwrap();
            let slot = match (&self.last_frame, class) {
                (Some((_, values)), Some(class)) if channel::symbol_of_class(class).is_some() => {
                    self.open_class = Some(class);
                    Slot::from_values(values, &self.personal.bias)
                }
                _ => Slot::certain(c),
            };
            self.slots.push(slot);
        } else if self.letters.starts_with(letters.as_str()) {
            self.slots.truncate(letters.len());
            self.open_class = None;
        } else {
            self.slots = letters.chars().map(Slot::certain).collect();
            self.open_class = None;
        }
        self.letters = letters;
    }

    fn lang_cost(&self, lang: Lang, previous_lang: Option<Lang>) -> f32 {
        let total: f32 = self.personal.langs.iter().sum();
        let prior = -((self.personal.langs[lang as usize] + 1.0) / (total + LANGS as f32)).ln();
        let context = match previous_lang {
            Some(prev) if prev == lang => -(0.85f32).ln(),
            Some(_) => -(0.15f32).ln(),
            None => 0.0,
        };
        prior + context
    }

    /// The previous word's entry and language.
    fn context(&self, previous: Option<&str>) -> (Option<u32>, Option<Lang>) {
        let Some(previous) = previous else { return (None, None) };
        let lower = previous.to_lowercase();
        let entry = self.lexicon.entries(&fold::fold(previous)).find(|&id| self.lexicon.entry(id).surface.to_lowercase() == lower);
        let lang = entry.and_then(|id| {
            let e = self.lexicon.entry(id);
            match (e.cost(Lang::En), e.cost(Lang::Pt)) {
                (Some(_), None) => Some(Lang::En),
                (None, Some(_)) => Some(Lang::Pt),
                (Some(en), Some(pt)) => Some(if en < pt { Lang::En } else { Lang::Pt }),
                _ => None,
            }
        });
        (entry, lang)
    }

    /// How likely a lexicon word is here, the wearer's use counted in.
    fn word_cost(&self, entry: Option<u32>, surface: &str, previous: Option<&str>, context: (Option<u32>, Option<Lang>)) -> f32 {
        let base = match entry {
            Some(id) => Lang::ALL
                .iter()
                .filter_map(|&lang| self.lexicon.pair_cost(lang, context.0, id).map(|cost| cost + self.lang_cost(lang, context.1)))
                .fold(f32::INFINITY, f32::min),
            None => OWN_WORD,
        };
        let lower = surface.to_lowercase();
        let own = self.personal.word_count(&lower);
        let pair = self.personal.pair_count(previous.unwrap_or(""), &lower);
        base - (1.0 + own).ln() - 0.7 * (1.0 + pair).ln()
    }

    /// The candidates for the word being written (`written`, after `before`).
    fn word_candidates(&self, before: &str, written: &str) -> Vec<Candidate> {
        let previous = previous_word(before);
        let context = self.context(previous.as_deref());
        let case = Case::of(written);
        let mut out: Vec<Candidate> = Vec::new();
        let mut push = |surface: String, entry: Option<u32>, channel: f32, extra: usize, this: &Self| {
            let surface = case.apply(&surface);
            if out.iter().any(|c| c.surface == surface) {
                return;
            }
            let lm = this.word_cost(entry, &surface, previous.as_deref(), context);
            let changed = fold::fold(&surface).get(..this.letters.len()).is_none_or(|start| start != this.letters);
            let own = this.personal.word_count(&surface.to_lowercase()) > 0.0;
            let features = [channel, lm, extra as f32, (extra > 0) as u8 as f32, changed as u8 as f32, own as u8 as f32];
            out.push(Candidate { score: score(&this.personal.weights, &features), surface, features });
        };
        let found = search::lexicon_words(&self.lexicon, &self.slots);
        for f in found.iter().take(80) {
            let entry = self.lexicon.entry(f.entry);
            if entry.hidden {
                continue;
            }
            push(entry.surface.to_owned(), Some(f.entry), f.channel, f.extra, self);
        }
        let best = found.first().map_or(f32::INFINITY, |f| f.channel);
        let own: Vec<String> = self.personal.words.keys().cloned().collect();
        for word in own {
            let key = fold::fold(&word);
            if key.is_empty() || self.lexicon.entries(&key).any(|id| self.lexicon.entry(id).surface.to_lowercase() == word) {
                continue;
            }
            let (cost, left) = search::align(&self.slots, &key);
            if cost <= best + 7.0 {
                push(word, None, cost, left, self);
            }
        }
        out.sort_by(|a, b| a.score.total_cmp(&b.score));
        out
    }

    /// The next words after `previous`, the wearer's first.
    fn next_candidates(&self, previous: Option<&str>) -> Vec<Candidate> {
        let context = self.context(previous);
        let mut out: Vec<Candidate> = Vec::new();
        let lower_previous = previous.map(str::to_lowercase).unwrap_or_default();
        let mut words: Vec<(String, Option<u32>)> = self
            .personal
            .pairs
            .keys()
            .filter(|(a, _)| *a == lower_previous)
            .map(|(_, b)| (b.clone(), None))
            .collect();
        if let Some(prev) = context.0 {
            for lang in Lang::ALL {
                words.extend(self.lexicon.next_words(lang, prev).into_iter().take(8).map(|(id, _)| (self.lexicon.entry(id).surface.to_owned(), Some(id))));
            }
        }
        for (surface, entry) in words {
            if out.iter().any(|c| c.surface.to_lowercase() == surface.to_lowercase()) {
                continue;
            }
            let entry = entry.or_else(|| self.lexicon.entries(&fold::fold(&surface)).find(|&id| self.lexicon.entry(id).surface.to_lowercase() == surface));
            if entry.is_some_and(|id| self.lexicon.entry(id).hidden) {
                continue;
            }
            let lm = self.word_cost(entry, &surface, previous, context);
            let features = [0.0, lm, 0.0, 0.0, 0.0, 0.0];
            out.push(Candidate { score: lm, surface, features });
        }
        out.sort_by(|a, b| a.score.total_cmp(&b.score));
        out
    }

    /// A clearly better word for `written` (which just ended), with the features of both.
    fn correction(&self, before: &str, written: &str) -> Option<(String, (Features, Features))> {
        // Not a code or a number: a digit is fine (a "l" the band read as "1"), two aren't.
        let digits = written.chars().filter(char::is_ascii_digit).count();
        if !self.settings.autocorrect
            || self.training.is_some()
            || self.letters.len() < 2
            || digits >= 2
            || digits == written.chars().count()
        {
            return None;
        }
        let lower = written.to_lowercase();
        if self.personal.word_count(&lower) > 0.0 {
            return None;
        }
        let known = self.lexicon.entries(&self.letters).any(|id| self.lexicon.entry(id).surface.to_lowercase() == lower);
        let candidates = self.word_candidates(before, written);
        // As written: its own reading, and the lexicon's word or an unknown one.
        let (channel, _) = search::align(&self.slots, &self.letters);
        let written_features: Features = match candidates.iter().find(|c| c.surface == written) {
            Some(c) => [channel, c.features[1], 0.0, 0.0, 0.0, c.features[5]],
            None => [channel, UNKNOWN, 0.0, 0.0, 0.0, 0.0],
        };
        let written_score = score(&self.personal.weights, &written_features);
        let best = candidates
            .iter()
            .filter(|c| c.features[2] <= 1.0 && c.surface != written)
            .map(|c| {
                // A missing last letter counts as missed, not as a completion.
                let mut f = c.features;
                if f[2] > 0.0 {
                    f[0] += INSERT;
                    f[2] = 0.0;
                    f[3] = 0.0;
                }
                (c.surface.clone(), f, score(&self.personal.weights, &f))
            })
            .min_by(|a, b| a.2.total_cmp(&b.2))?;
        let (surface, features, best_score) = best;
        if self.personal.blocked.contains(&(self.letters.clone(), surface.to_lowercase())) {
            return None;
        }
        let accent_only = fold::fold(&surface) == self.letters;
        let margin = if accent_only && !known {
            ACCENT_ONLY_MARGIN
        } else if known {
            self.personal.margin + KNOWN_WORD_EXTRA
        } else {
            self.personal.margin
        };
        (written_score - best_score > margin).then_some((surface, (written_features, features)))
    }

    /// Recomputes the suggestions for `text`; `ended`: a word just ended (show the next word).
    fn refresh(&mut self, text: &str, ended: bool) {
        let (before, word) = split_word(text);
        self.word = word.to_owned();
        let (kind, candidates) = if self.training.is_some() {
            (Kind::None, Vec::new())
        } else if !word.is_empty() && !self.slots.is_empty() {
            (Kind::Word, self.word_candidates(before, word))
        } else if word.is_empty() && (ended || text.ends_with(' ') || text.is_empty()) {
            (Kind::Next, self.next_candidates(previous_word(before).as_deref()))
        } else {
            (Kind::None, Vec::new())
        };
        let mut candidates = candidates;
        // The thumb accepts the first: a word that changes written letters goes first only when
        // it's clearly likelier and drops none of them (the letter just written was meant),
        // else what continues the writing does.
        let letters = self.letters.len();
        let drops = |c: &Candidate| fold::fold(&c.surface).len() < letters;
        if kind == Kind::Word
            && candidates.first().is_some_and(|c| c.features[4] > 0.0)
            && let Some(index) = candidates.iter().position(|c| c.features[4] == 0.0)
            && (drops(&candidates[0]) || candidates[index].score - candidates[0].score <= self.personal.margin * FIRST_MARGIN)
        {
            let kept = candidates.remove(index);
            candidates.insert(0, kept);
        }
        candidates.truncate(SHOWN);
        self.kind = if candidates.is_empty() { Kind::None } else { kind };
        self.candidates = candidates;
        self.selected = 0;
        self.rev += 1;
    }

    /// One pairwise step: `better` should score below `worse`.
    fn teach_ranking(&mut self, better: &Features, worse: &Features) {
        let margin = score(&self.personal.weights, worse) - score(&self.personal.weights, better);
        let step = RANK_RATE / (1.0 + margin.exp());
        for i in 0..FEATURES {
            self.personal.weights[i] = (self.personal.weights[i] + step * (worse[i] - better[i])).clamp(-3.0, 3.0);
        }
        self.dirty = true;
    }

    /// Learns the word waiting for confirmation, if any.
    fn finish_pending(&mut self) {
        let Some(pending) = self.pending.take() else { return };
        if !self.settings.learn {
            return;
        }
        // Practice: the expected word teaches the letters; nothing else is learned (the words
        // were the trainer's, not the wearer's).
        if self.training.is_some() || pending.expected.is_some() {
            if let Some(expected) = &pending.expected {
                self.teach_letters(&pending.slots, expected, TRAINING_COST);
            }
            return;
        }
        let lower = pending.word.to_lowercase();
        self.personal.use_word(&lower, 1.0, self.today);
        self.personal.use_pair(pending.previous.as_deref().unwrap_or(""), &lower, 1.0, self.today);
        let key = fold::fold(&pending.word);
        if let Some(id) = self.lexicon.entries(&key).find(|&id| self.lexicon.entry(id).surface.to_lowercase() == lower) {
            let entry = self.lexicon.entry(id);
            match (entry.cost(Lang::En), entry.cost(Lang::Pt)) {
                (Some(_), None) => self.personal.langs[Lang::En as usize] += 1.0,
                (None, Some(_)) => self.personal.langs[Lang::Pt as usize] += 1.0,
                _ => {}
            }
        }
        if pending.corrected {
            self.personal.margin = (self.personal.margin - 0.05).max(MARGIN_RANGE.0);
        }
        // The band's letters, read as this word: their bias moves toward it.
        self.teach_letters(&pending.slots, &key, TEACHING_COST);
        self.dirty = true;
    }

    /// The bias of the letters the band read (`slots`) moves toward the folded `word`, when they
    /// read as it for at most `limit`.
    fn teach_letters(&mut self, slots: &[Slot], word: &str, limit: f32) {
        if slots.is_empty() || !slots.iter().any(Slot::measured) {
            return;
        }
        let (cost, left) = search::align(slots, word);
        if left != 0 || cost > limit {
            return;
        }
        for (slot, symbol) in search::pairs(slots, word) {
            channel::learn(&mut self.personal.bias, &slots[slot], symbol, BIAS_RATE);
        }
        self.dirty = true;
    }

    /// The writing ended: what's pending is learned. Returns the store's bytes when it changed.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        self.finish_pending();
        std::mem::take(&mut self.dirty).then(|| self.personal.to_bytes())
    }

    /// The store's bytes as they are now.
    pub fn personal_bytes(&self) -> Vec<u8> {
        self.personal.to_bytes()
    }

    pub fn rev(&self) -> u64 {
        self.rev
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The word the suggestions are for, as written ("" for the next word).
    pub fn word(&self) -> &str {
        &self.word
    }

    pub fn items(&self) -> Vec<&str> {
        self.candidates.iter().map(|c| c.surface.as_str()).collect()
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// What follows the caret in gray: the rest of the selected suggestion when it continues
    /// the written word as written (else nothing: it shows among the suggestions only).
    pub fn ghost(&self) -> String {
        let Some(candidate) = self.candidates.get(self.selected) else { return String::new() };
        if self.kind == Kind::Next {
            return candidate.surface.clone();
        }
        let written: Vec<char> = self.word.chars().flat_map(char::to_lowercase).collect();
        let surface: Vec<char> = candidate.surface.chars().collect();
        let lowered: Vec<char> = candidate.surface.chars().flat_map(char::to_lowercase).collect();
        if lowered.len() > written.len() && lowered.starts_with(&written) && lowered.len() == surface.len() {
            surface[written.len()..].iter().collect()
        } else {
            String::new()
        }
    }

    /// The shown suggestions with their features and score, for measuring (see examples/replay).
    pub fn explain(&self) -> Vec<(String, [f32; FEATURES], f32)> {
        self.candidates.iter().map(|c| (c.surface.clone(), c.features, c.score)).collect()
    }

    pub fn can_undo(&self) -> bool {
        self.undo.is_some()
    }

    pub fn notice(&self) -> Option<&Notice> {
        self.notice.as_ref()
    }

    pub fn mark(&self) -> Option<(usize, usize)> {
        self.mark
    }
}

#[cfg(test)]
mod tests;
