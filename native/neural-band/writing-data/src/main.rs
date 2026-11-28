//! Builds `writing.lex`, the lexicon of the writing suggestions (see the `writing` crate), and
//! its manifest, from:
//! - AOSP LatinIME's word lists (Apache-2.0): the words, their spellings and frequencies, the
//!   offensive ones marked (never suggested). Portuguese gets the 2009 spelling (idéia ->
//!   ideia, vôo -> voo, freqüente -> frequente, pára -> para).
//! - Tatoeba's sentences (CC BY 2.0 FR): how often each word comes in everyday sentences, and
//!   which word follows which (absolute discounting, pruned).
//!
//! Usage: writing-data <sources dir from fetch.sh> <out .lex> <out manifest .json>

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use unicode_normalization::UnicodeNormalization;
use writing::build::LexiconBuilder;
use writing::fold;
use writing::lexicon::Lang;

/// Words kept per language, likeliest first.
const VOCABULARY: usize = 80_000;
/// Pairs: a head seen at least this often, its likeliest continuations, seen at least twice.
const HEAD_MIN: u32 = 8;
const PAIRS_PER_HEAD: usize = 12;
const PAIR_MIN: u32 = 2;
const DISCOUNT: f64 = 0.75;
const LONGEST: usize = 24;

struct Word {
    surface: String,
    f: u32,
    hidden: bool,
}

fn read_aosp(path: &Path) -> Vec<Word> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut words = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.strip_prefix(" word=") else { continue };
        let mut fields = HashMap::new();
        let (surface, tail) = rest.split_once(',').unwrap_or((rest, ""));
        for pair in tail.split(',') {
            if let Some((key, value)) = pair.split_once('=') {
                fields.insert(key, value);
            }
        }
        if fields.get("not_a_word") == Some(&"true") {
            continue;
        }
        let flags = fields.get("flags").copied().unwrap_or("");
        let surface: String = surface.nfc().collect();
        let surface = surface.replace('’', "'");
        if surface.chars().count() > LONGEST
            || !surface.chars().any(char::is_alphabetic)
            || !fold::foldable(&surface)
            || surface.chars().any(|c| c.is_ascii_digit())
            || flags.contains("nonword")
        {
            continue;
        }
        let f = fields.get("f").and_then(|f| f.parse().ok()).unwrap_or(0);
        words.push(Word { surface, f, hidden: flags.contains("offensive") });
    }
    words
}

/// The 2009 spelling agreement, for what the AOSP list still spells the old way.
fn reform(word: &str) -> String {
    let differential = [("pára", "para"), ("péla", "pela"), ("pélas", "pelas"), ("pêlo", "pelo"), ("pêlos", "pelos"),
        ("pólo", "polo"), ("pólos", "polos"), ("pêra", "pera"), ("pêras", "peras"), ("côa", "coa")];
    if let Some((_, new)) = differential.iter().find(|(old, _)| *old == word) {
        return (*new).to_owned();
    }
    let mut out = word.replace('ü', "u").replace("ôo", "oo").replace("êem", "eem");
    // Open diphthongs éi, ói lose the accent when another syllable follows (idéia, heróico),
    // and keep it at the end of the word (papéis, herói).
    for (accented, plain) in [("éi", "ei"), ("ói", "oi")] {
        while let Some(at) = out.find(accented) {
            let after = &out[at + accented.len()..];
            if after.chars().any(|c| "aeiouáéíóúâêôãõ".contains(c)) {
                out.replace_range(at..at + accented.len(), plain);
            } else {
                break;
            }
        }
    }
    // Prefixes join the word unless the letters meet (micro-ondas) or an h follows; r and s
    // double (anti-social -> antissocial).
    const PREFIXES: [&str; 20] = ["auto", "anti", "contra", "extra", "infra", "intra", "neo", "proto", "pseudo", "semi",
        "supra", "ultra", "micro", "macro", "mini", "multi", "mega", "tele", "retro", "hidro"];
    if let Some((prefix, rest)) = out.split_once('-')
        && PREFIXES.contains(&prefix)
        && let Some(first) = rest.chars().next()
    {
        let last = prefix.chars().last().unwrap();
        if first != 'h' && first != last {
            if first == 'r' || first == 's' {
                return format!("{prefix}{first}{rest}");
            }
            if "aeiou".contains(first) {
                return format!("{prefix}{rest}");
            }
        }
    }
    out
}

fn is_ascii_letters(word: &str) -> bool {
    word.is_ascii()
}

/// Words of a sentence, lower case, apostrophes straightened; `None` between runs (punctuation
/// breaks the pairs).
fn tokens(sentence: &str) -> Vec<Option<String>> {
    let mut out = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<Option<String>>| {
        let w = word.trim_matches(|c| c == '\'' || c == '-').to_owned();
        if !w.is_empty() {
            out.push(Some(w));
        }
        word.clear();
    };
    for c in sentence.nfc().flat_map(char::to_lowercase) {
        let c = if c == '’' { '\'' } else { c };
        if c.is_alphanumeric() || c == '\'' || c == '-' {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            if !c.is_whitespace() {
                out.push(None);
            }
        }
    }
    flush(&mut word, &mut out);
    out
}

struct Counts {
    unigrams: HashMap<String, u32>,
    pairs: HashMap<(String, String), u32>,
    total: u64,
}

fn count(path: &Path, lower_to_surface: &HashMap<String, String>) -> Counts {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut counts = Counts { unigrams: HashMap::new(), pairs: HashMap::new(), total: 0 };
    for line in text.lines() {
        let sentence = line.splitn(3, '\t').nth(2).unwrap_or("");
        let mut previous: Option<String> = None;
        for token in tokens(sentence) {
            let surface = token.as_ref().and_then(|t| lower_to_surface.get(t)).cloned();
            match surface {
                Some(surface) => {
                    *counts.unigrams.entry(surface.clone()).or_default() += 1;
                    counts.total += 1;
                    if let Some(prev) = previous.take() {
                        *counts.pairs.entry((prev, surface.clone())).or_default() += 1;
                    }
                    previous = Some(surface);
                }
                None => previous = None,
            }
        }
    }
    counts
}

/// -ln p per kept spelling: Tatoeba's counts mixed with the AOSP frequency (its 0-255 scale
/// fitted to the counts), the AOSP list deciding which words exist.
fn unigram_costs(words: &[Word], counts: &Counts) -> HashMap<String, f64> {
    let total = counts.total.max(1) as f64;
    let (mut sx, mut sy, mut sxx, mut sxy, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for word in words {
        let c = counts.unigrams.get(&word.surface).copied().unwrap_or(0);
        if c >= 3 {
            let (x, y) = (f64::from(word.f), (f64::from(c) / total).ln());
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
            n += 1.0;
        }
    }
    let b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    let a = (sy - b * sx) / n;
    eprintln!("  fit ln p = {a:.2} + {b:.4} f over {n} words");
    let mut p: HashMap<String, f64> = HashMap::new();
    for word in words {
        let c = f64::from(counts.unigrams.get(&word.surface).copied().unwrap_or(0));
        let value = 0.5 * c / total + 0.5 * (a + b * f64::from(word.f)).exp();
        let slot = p.entry(word.surface.clone()).or_default();
        *slot = slot.max(value);
    }
    // A spelling without accents that is far rarer than an accented one with the same letters
    // is a typo the list kept ("nao" next to "não").
    let mut by_key: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for (surface, value) in &p {
        by_key.entry(fold::fold(surface)).or_default().push((surface.clone(), *value));
    }
    for spellings in by_key.values() {
        let accented = spellings.iter().filter(|(s, _)| !is_ascii_letters(s)).map(|(_, v)| *v).fold(0.0, f64::max);
        for (surface, value) in spellings {
            if is_ascii_letters(surface) && *value * 20.0 < accented {
                p.remove(surface);
            }
        }
    }
    let mut ranked: Vec<(String, f64)> = p.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.truncate(VOCABULARY);
    let sum: f64 = ranked.iter().map(|(_, v)| v).sum();
    ranked.into_iter().map(|(s, v)| (s, -(v / sum).ln())).collect()
}

fn sha256(path: &Path) -> String {
    let output = std::process::Command::new("sha256sum").arg(path).output().expect("sha256sum");
    String::from_utf8_lossy(&output.stdout).split_whitespace().next().unwrap_or("").to_owned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: writing-data <sources dir> <out .lex> <out manifest .json>");
        std::process::exit(2);
    }
    let sources = Path::new(&args[1]);
    let mut builder = LexiconBuilder::default();
    let mut stats = Vec::new();
    for (lang, list, sentences) in [(Lang::En, "en_US", "eng"), (Lang::Pt, "pt_BR", "por")] {
        eprintln!("{list}");
        let mut words = read_aosp(&sources.join(format!("{list}_wordlist.combined")));
        if lang == Lang::Pt {
            let mut merged: HashMap<String, Word> = HashMap::new();
            for word in words {
                let surface = if word.surface.chars().next().is_some_and(char::is_lowercase) { reform(&word.surface) } else { word.surface.clone() };
                let entry = merged.entry(surface.clone()).or_insert(Word { surface, f: 0, hidden: false });
                entry.f = entry.f.max(word.f);
                entry.hidden |= word.hidden;
            }
            words = merged.into_values().collect();
        }
        let mut lower_to_surface: HashMap<String, String> = HashMap::new();
        for word in &words {
            let lower = word.surface.to_lowercase();
            let exact = lower == word.surface;
            if exact || !lower_to_surface.contains_key(&lower) {
                lower_to_surface.insert(lower, word.surface.clone());
            }
        }
        let counts = count(&sources.join(format!("{sentences}_sentences.tsv")), &lower_to_surface);
        eprintln!("  {} tokens, {} distinct, {} pairs", counts.total, counts.unigrams.len(), counts.pairs.len());
        let costs = unigram_costs(&words, &counts);
        let hidden: HashSet<&str> = words.iter().filter(|w| w.hidden).map(|w| w.surface.as_str()).collect();
        for (surface, cost) in &costs {
            builder.word(surface, lang, *cost, hidden.contains(surface.as_str()));
        }
        // Pairs: P(w|h) = max(c(h,w) - D, 0) / c(h) + backoff(h) P(w), the pruned pairs' mass
        // going to the backoff.
        let mut heads: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
        for ((head, next), c) in &counts.pairs {
            if costs.contains_key(head) && costs.contains_key(next) {
                heads.entry(head.as_str()).or_default().push((next.as_str(), *c));
            }
        }
        let mut kept_pairs = 0;
        for (head, mut nexts) in heads {
            let total: u32 = nexts.iter().map(|(_, c)| c).sum();
            if total < HEAD_MIN {
                continue;
            }
            nexts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            let kept: Vec<(&str, u32)> = nexts.into_iter().filter(|(_, c)| *c >= PAIR_MIN).take(PAIRS_PER_HEAD).collect();
            let total = f64::from(total);
            let kept_mass: f64 = kept.iter().map(|(_, c)| (f64::from(*c) - DISCOUNT) / total).sum();
            let backoff = (1.0 - kept_mass).max(1e-6);
            for (next, c) in &kept {
                let p = (f64::from(*c) - DISCOUNT) / total + backoff * (-costs[*next]).exp();
                builder.pair(lang, head, next, -p.ln());
                kept_pairs += 1;
            }
            builder.backoff(lang, head, -backoff.ln());
        }
        eprintln!("  {} words, {} pairs", costs.len(), kept_pairs);
        stats.push(format!("\"{list}\":{{\"words\":{},\"pairs\":{kept_pairs},\"tokens\":{}}}", costs.len(), counts.total));
    }
    let bytes = builder.finish();
    fs::write(&args[2], &bytes).expect("write lexicon");
    let lex_sha = sha256(Path::new(&args[2]));
    let files: Vec<String> = ["en_US_wordlist.combined.gz", "pt_BR_wordlist.combined.gz", "eng_sentences.tsv.bz2", "por_sentences.tsv.bz2"]
        .iter()
        .map(|name| format!("\"{name}\":\"{}\"", sha256(&sources.join(name))))
        .collect();
    let manifest = format!(
        "{{\n  \"format\": {},\n  \"sha256\": \"{lex_sha}\",\n  \"bytes\": {},\n  \"stats\": {{{}}},\n  \"sources\": {{{}}},\n  \"licenses\": {{\"AOSP LatinIME word lists\": \"Apache-2.0\", \"Tatoeba sentences\": \"CC BY 2.0 FR\"}}\n}}\n",
        writing::format::VERSION,
        bytes.len(),
        stats.join(","),
        files.join(",")
    );
    fs::write(&args[3], manifest).expect("write manifest");
    eprintln!("{} bytes, sha256 {lex_sha}", bytes.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_2009_spelling() {
        assert_eq!(reform("idéia"), "ideia");
        assert_eq!(reform("heróico"), "heroico");
        assert_eq!(reform("jóia"), "joia");
        assert_eq!(reform("papéis"), "papéis");
        assert_eq!(reform("herói"), "herói");
        assert_eq!(reform("vôo"), "voo");
        assert_eq!(reform("vêem"), "veem");
        assert_eq!(reform("têm"), "têm");
        assert_eq!(reform("freqüente"), "frequente");
        assert_eq!(reform("pára"), "para");
        assert_eq!(reform("auto-estima"), "autoestima");
        assert_eq!(reform("anti-social"), "antissocial");
        assert_eq!(reform("micro-ondas"), "micro-ondas");
        assert_eq!(reform("anti-higiênico"), "anti-higiênico");
    }

    #[test]
    fn sentences_break_into_words() {
        let words: Vec<Option<String>> = tokens("Oi, tudo bem? I don't know.");
        let expected = [Some("oi"), None, Some("tudo"), Some("bem"), None, Some("i"), Some("don't"), Some("know"), None];
        assert_eq!(words, expected.iter().map(|w| w.map(str::to_owned)).collect::<Vec<_>>());
    }
}
