//! The lexicon file the data tool (`writing-data`) writes and [crate::lexicon::Lexicon] maps:
//! `LWLX`, a version, then named sections, each 8-byte aligned so the file can be used in place.
//!
//! Sections:
//! - `keys`: an fst map, folded word -> `first entry << 8 | entries` (the spellings of one key:
//!   "esta", "está").
//! - `entries`: 8 bytes each: string offset (u32), length (u8), flags (u8), English cost (u8),
//!   Portuguese cost (u8). A cost is -ln p in steps of [COST_STEP]; [NO_COST] where the
//!   language doesn't have the word.
//! - `strings`: the spellings, UTF-8.
//! - `prefix` + `toplist`: an fst map from a folded prefix of up to [PREFIX_MAX] letters to
//!   `start << 8 | count` in `toplist` (u32 entry ids): the likeliest words under it.
//! - `head_en`/`next_en`, `head_pt`/`next_pt`: word pairs. A head is 12 bytes: entry (u32),
//!   first pair (u32), pairs (u16), backoff cost (u8), padding; sorted by entry. A pair is 5
//!   bytes: next entry (u32), cost of the next word after the head (u8); a head's pairs come
//!   likeliest first.

pub const MAGIC: &[u8; 4] = b"LWLX";
pub const VERSION: u32 = 1;
/// Costs are -ln p in steps of 0.1 nats, 0 to 25.4.
pub const COST_STEP: f32 = 0.1;
pub const NO_COST: u8 = 255;
/// English, Portuguese.
pub const LANGS: usize = 2;
pub const ENTRY_SIZE: usize = 8;
pub const HEAD_SIZE: usize = 12;
pub const PAIR_SIZE: usize = 5;
pub const PREFIX_MAX: usize = 3;
/// An entry never suggested (an offensive word stays readable, so it isn't "corrected").
pub const FLAG_HIDDEN: u8 = 1;

pub const KEYS: &str = "keys";
pub const ENTRIES: &str = "entries";
pub const STRINGS: &str = "strings";
pub const PREFIX: &str = "prefix";
pub const TOPLIST: &str = "toplist";
pub const HEADS: [&str; LANGS] = ["head_en", "head_pt"];
pub const PAIRS: [&str; LANGS] = ["next_en", "next_pt"];

pub fn quantize(cost: f64) -> u8 {
    (cost / f64::from(COST_STEP)).round().clamp(0.0, 254.0) as u8
}

pub fn cost(quantized: u8) -> f32 {
    f32::from(quantized) * COST_STEP
}

/// The sections of a file: name, start, end.
pub fn sections(bytes: &[u8]) -> Result<Vec<(String, usize, usize)>, String> {
    if bytes.len() < 12 || &bytes[..4] != MAGIC {
        return Err("not a lexicon file".into());
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    if version != VERSION {
        return Err(format!("lexicon version {version}, expected {VERSION}"));
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let at = 12 + index * 24;
        let record = bytes.get(at..at + 24).ok_or("truncated lexicon header")?;
        let name = String::from_utf8_lossy(&record[..8]).trim_end_matches('\0').to_owned();
        let start = u64::from_le_bytes(record[8..16].try_into().unwrap()) as usize;
        let len = u64::from_le_bytes(record[16..24].try_into().unwrap()) as usize;
        let end = start.checked_add(len).filter(|&end| end <= bytes.len()).ok_or("truncated lexicon section")?;
        out.push((name, start, end));
    }
    Ok(out)
}

/// A file from its sections.
pub fn write(sections: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let header = 12 + sections.len() * 24;
    let align = |n: usize| n.div_ceil(8) * 8;
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(sections.len() as u32).to_le_bytes());
    let mut at = align(header);
    for (name, data) in sections {
        let mut field = [0u8; 8];
        field[..name.len()].copy_from_slice(name.as_bytes());
        out.extend_from_slice(&field);
        out.extend_from_slice(&(at as u64).to_le_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        at = align(at + data.len());
    }
    for (_, data) in sections {
        out.resize(align(out.len()), 0);
        out.extend_from_slice(data);
    }
    out
}
