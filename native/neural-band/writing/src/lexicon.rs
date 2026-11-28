//! The words the suggestions come from, mapped from the file the data tool writes (see
//! [crate::format]): the pages stay on disk until read, and the kernel can drop them again.

use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

use fst::{IntoStreamer, Map, Streamer};

use crate::format::{self, LANGS, NO_COST};

enum Bytes {
    Mapped(memmap2::Mmap),
    Owned(Vec<u8>),
}

impl Bytes {
    fn get(&self) -> &[u8] {
        match self {
            Bytes::Mapped(map) => map,
            Bytes::Owned(bytes) => bytes,
        }
    }
}

/// A section of the file.
#[derive(Clone)]
pub struct Part {
    bytes: Arc<Bytes>,
    range: Range<usize>,
}

impl AsRef<[u8]> for Part {
    fn as_ref(&self) -> &[u8] {
        &self.bytes.get()[self.range.clone()]
    }
}

/// English or Portuguese, as the file indexes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    En = 0,
    Pt = 1,
}

impl Lang {
    pub const ALL: [Lang; LANGS] = [Lang::En, Lang::Pt];
}

/// One spelling of a word.
#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    pub surface: &'a str,
    pub hidden: bool,
    costs: [u8; LANGS],
}

impl Entry<'_> {
    /// -ln p of the word alone in `lang`, `None` where that language doesn't have it.
    pub fn cost(&self, lang: Lang) -> Option<f32> {
        let quantized = self.costs[lang as usize];
        (quantized != NO_COST).then(|| format::cost(quantized))
    }
}

pub struct Lexicon {
    keys: Map<Part>,
    prefix: Map<Part>,
    entries: Part,
    strings: Part,
    toplist: Part,
    heads: [Part; LANGS],
    pairs: [Part; LANGS],
}

impl Lexicon {
    /// Maps the file at `path`.
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("lexicon {}: {e}", path.display()))?;
        // The file is Lumen's own copy and nothing writes it while mapped.
        let map = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| format!("lexicon map: {e}"))?;
        Self::from(Bytes::Mapped(map))
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, String> {
        Self::from(Bytes::Owned(bytes))
    }

    fn from(bytes: Bytes) -> Result<Self, String> {
        let bytes = Arc::new(bytes);
        let sections = format::sections(bytes.get())?;
        let part = |name: &str| -> Result<Part, String> {
            sections
                .iter()
                .find(|(section, _, _)| section == name)
                .map(|(_, start, end)| Part { bytes: bytes.clone(), range: *start..*end })
                .ok_or_else(|| format!("lexicon without {name}"))
        };
        let map = |name: &str| -> Result<Map<Part>, String> { Map::new(part(name)?).map_err(|e| format!("{name}: {e}")) };
        let lexicon = Self {
            keys: map(format::KEYS)?,
            prefix: map(format::PREFIX)?,
            entries: part(format::ENTRIES)?,
            strings: part(format::STRINGS)?,
            toplist: part(format::TOPLIST)?,
            heads: [part(format::HEADS[0])?, part(format::HEADS[1])?],
            pairs: [part(format::PAIRS[0])?, part(format::PAIRS[1])?],
        };
        if lexicon.entries.as_ref().len() % format::ENTRY_SIZE != 0 {
            return Err("lexicon entries truncated".into());
        }
        Ok(lexicon)
    }

    pub fn len(&self) -> usize {
        self.entries.as_ref().len() / format::ENTRY_SIZE
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn entry(&self, id: u32) -> Entry<'_> {
        let at = id as usize * format::ENTRY_SIZE;
        let record = &self.entries.as_ref()[at..at + format::ENTRY_SIZE];
        let offset = u32::from_le_bytes(record[..4].try_into().unwrap()) as usize;
        let len = record[4] as usize;
        let surface = std::str::from_utf8(&self.strings.as_ref()[offset..offset + len]).unwrap_or("");
        Entry { surface, hidden: record[5] & format::FLAG_HIDDEN != 0, costs: [record[6], record[7]] }
    }

    /// The entries a key's value names.
    pub fn entries_of_value(value: u64) -> Range<u32> {
        let start = (value >> 8) as u32;
        start..start + (value & 0xff) as u32
    }

    /// The spellings of a folded word.
    pub fn entries(&self, key: &str) -> Range<u32> {
        self.keys.get(key).map_or(0..0, Self::entries_of_value)
    }

    /// The trie of folded words, for walking it letter by letter.
    pub fn keys(&self) -> &fst::raw::Fst<Part> {
        self.keys.as_fst()
    }

    /// Up to `limit` entries whose key starts with `prefix`, likeliest first for short prefixes
    /// (a list made in advance), in key order otherwise.
    pub fn under(&self, prefix: &str, limit: usize) -> Vec<u32> {
        if prefix.len() <= format::PREFIX_MAX {
            let Some(value) = self.prefix.get(prefix) else { return Vec::new() };
            let start = (value >> 8) as usize;
            let count = (value & 0xff) as usize;
            let list = self.toplist.as_ref();
            return (start..start + count)
                .take(limit)
                .map(|index| u32::from_le_bytes(list[index * 4..index * 4 + 4].try_into().unwrap()))
                .collect();
        }
        let mut upper = prefix.as_bytes().to_vec();
        upper.push(0xff);
        let mut stream = self.keys.range().ge(prefix).lt(upper).into_stream();
        let mut out = Vec::new();
        while let Some((_, value)) = stream.next() {
            out.extend(Self::entries_of_value(value));
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    fn head(&self, lang: Lang, entry: u32) -> Option<(usize, usize, u8)> {
        let heads = self.heads[lang as usize].as_ref();
        let count = heads.len() / format::HEAD_SIZE;
        let read = |index: usize| u32::from_le_bytes(heads[index * format::HEAD_SIZE..index * format::HEAD_SIZE + 4].try_into().unwrap());
        let (mut low, mut high) = (0, count);
        while low < high {
            let middle = (low + high) / 2;
            match read(middle).cmp(&entry) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => {
                    let record = &heads[middle * format::HEAD_SIZE..(middle + 1) * format::HEAD_SIZE];
                    let start = u32::from_le_bytes(record[4..8].try_into().unwrap()) as usize;
                    let pairs = u16::from_le_bytes(record[8..10].try_into().unwrap()) as usize;
                    return Some((start, pairs, record[10]));
                }
            }
        }
        None
    }

    /// The words seen after `previous` in `lang`, likeliest first, with their cost there.
    pub fn next_words(&self, lang: Lang, previous: u32) -> Vec<(u32, f32)> {
        let Some((start, count, _)) = self.head(lang, previous) else { return Vec::new() };
        let pairs = self.pairs[lang as usize].as_ref();
        (start..start + count)
            .map(|index| {
                let record = &pairs[index * format::PAIR_SIZE..(index + 1) * format::PAIR_SIZE];
                (u32::from_le_bytes(record[..4].try_into().unwrap()), format::cost(record[4]))
            })
            .collect()
    }

    /// -ln p of `word` right after `previous` in `lang`: the pair's own cost when it was seen,
    /// else the head's backoff plus the word's cost alone. `None` where `lang` lacks the word.
    pub fn pair_cost(&self, lang: Lang, previous: Option<u32>, word: u32) -> Option<f32> {
        let alone = self.entry(word).cost(lang)?;
        let Some(previous) = previous else { return Some(alone) };
        let Some((start, count, backoff)) = self.head(lang, previous) else { return Some(alone) };
        let pairs = self.pairs[lang as usize].as_ref();
        for index in start..start + count {
            let record = &pairs[index * format::PAIR_SIZE..(index + 1) * format::PAIR_SIZE];
            if u32::from_le_bytes(record[..4].try_into().unwrap()) == word {
                return Some(format::cost(record[4]));
            }
        }
        Some(format::cost(backoff) + alone)
    }
}
