//! Which words the written letters could be: an alignment of the slots ([Slot]) with each word
//! of the lexicon's trie, letter by letter, as a weighted edit distance (a letter read as
//! another costs what the band thought of it; a missed or an extra letter costs a fixed price),
//! pruned as it goes. Where every slot is used up partway down a word, the rest of the word is
//! a completion and costs nothing here (the language model prices it).

use crate::channel::{DELETE, INSERT, Slot, symbol_of_char};
use crate::fold;
use crate::lexicon::Lexicon;

/// How much worse than the best reading a candidate may be.
const BEAM: f32 = 7.0;
/// Trie levels past the slots (letters the band missed).
const EXTRA_DEPTH: usize = 2;
/// Prefixes whose completions are listed, and completions per prefix.
const ROOTS: usize = 10;
const PER_ROOT: usize = 40;

/// A word the letters could be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Found {
    pub entry: u32,
    /// The slots' cost of reading as the word's beginning.
    pub channel: f32,
    /// Letters of the word past that beginning (0: the whole word was written).
    pub extra: usize,
}

fn next_row(row: &[f32], slots: &[Slot], symbol: Option<usize>) -> Vec<f32> {
    let mut next = Vec::with_capacity(row.len());
    next.push(row[0] + INSERT);
    for i in 1..row.len() {
        let slot = &slots[i - 1];
        let substitute = row[i - 1] + symbol.map_or(DELETE * 2.0, |s| slot.cost(s));
        let insert = row[i] + INSERT;
        let delete = next[i - 1] + slot.delete();
        next.push(substitute.min(insert).min(delete));
    }
    next
}

fn first_row(slots: &[Slot]) -> Vec<f32> {
    let mut row = vec![0.0];
    for slot in slots {
        let last = *row.last().unwrap();
        row.push(last + slot.delete());
    }
    row
}

/// The words of `lexicon` the `slots` could begin, cheapest reading first.
pub fn lexicon_words(lexicon: &Lexicon, slots: &[Slot]) -> Vec<Found> {
    let n = slots.len();
    if n == 0 {
        return Vec::new();
    }
    let fst = lexicon.keys();
    // (cost with every slot used, prefix)
    let mut roots: Vec<(f32, String)> = Vec::new();
    let mut bound = f32::INFINITY;
    let mut stack: Vec<(fst::raw::CompiledAddr, Vec<f32>, String)> = vec![(fst.root().addr(), first_row(slots), String::new())];
    while let Some((addr, row, prefix)) = stack.pop() {
        let node = fst.node(addr);
        for transition in node.transitions() {
            let c = transition.inp as char;
            let next = next_row(&row, slots, symbol_of_char(c));
            let lowest = next.iter().cloned().fold(f32::INFINITY, f32::min);
            if lowest > bound {
                continue;
            }
            let mut word = prefix.clone();
            word.push(c);
            let used = next[n];
            if used <= bound {
                roots.push((used, word.clone()));
                if used + BEAM < bound {
                    bound = used + BEAM;
                }
            }
            if word.len() < n + EXTRA_DEPTH {
                stack.push((transition.addr, next, word));
            }
        }
    }
    roots.retain(|(cost, _)| *cost <= bound);
    roots.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.len().cmp(&b.1.len())));
    // A longer prefix whose shorter one is already in adds nothing but cost.
    let mut kept: Vec<(f32, String)> = Vec::new();
    for (cost, prefix) in roots {
        if kept.iter().any(|(_, shorter)| prefix.starts_with(shorter.as_str())) {
            continue;
        }
        kept.push((cost, prefix));
        if kept.len() == ROOTS {
            break;
        }
    }
    let mut found: Vec<Found> = Vec::new();
    for (cost, prefix) in kept {
        for entry in lexicon.under(&prefix, PER_ROOT) {
            let key_len = fold::fold(lexicon.entry(entry).surface).len();
            let extra = key_len.saturating_sub(prefix.len());
            if let Some(existing) = found.iter_mut().find(|f| f.entry == entry) {
                if cost < existing.channel {
                    existing.channel = cost;
                    existing.extra = extra;
                }
            } else {
                found.push(Found { entry, channel: cost, extra });
            }
        }
        // The exact word under the prefix even when it isn't among the likeliest there.
        for entry in lexicon.entries(&prefix) {
            if !found.iter().any(|f| f.entry == entry) {
                found.push(Found { entry, channel: cost, extra: 0 });
            }
        }
    }
    found.sort_by(|a, b| a.channel.total_cmp(&b.channel));
    found
}

/// The cheapest reading of `slots` as the beginning of the folded `word`: (cost, letters left).
pub fn align(slots: &[Slot], word: &str) -> (f32, usize) {
    let symbols: Vec<Option<usize>> = word.chars().map(symbol_of_char).collect();
    let mut row = first_row(slots);
    let n = slots.len();
    let mut best = (row[n], symbols.len());
    for (j, symbol) in symbols.iter().enumerate() {
        row = next_row(&row, slots, *symbol);
        let left = symbols.len() - (j + 1);
        if row[n] < best.0 || (row[n] == best.0 && left < best.1) {
            best = (row[n], left);
        }
    }
    best
}

/// Which slot reads as which letter of the folded `word` in the cheapest alignment (slots
/// that are noise and letters the band missed left out), for learning from a confirmed word.
pub fn pairs(slots: &[Slot], word: &str) -> Vec<(usize, usize)> {
    let symbols: Vec<Option<usize>> = word.chars().map(symbol_of_char).collect();
    let (n, m) = (slots.len(), symbols.len());
    // table[j][i]: slots[..i] against word[..j]
    let mut table = vec![first_row(slots)];
    for symbol in &symbols {
        let next = next_row(table.last().unwrap(), slots, *symbol);
        table.push(next);
    }
    let (mut i, mut j) = (n, m);
    let mut out = Vec::new();
    while i > 0 && j > 0 {
        let here = table[j][i];
        let slot = &slots[i - 1];
        let substitute = table[j - 1][i - 1] + symbols[j - 1].map_or(DELETE * 2.0, |s| slot.cost(s));
        if (here - substitute).abs() < 1e-4 {
            if let Some(symbol) = symbols[j - 1] {
                out.push((i - 1, symbol));
            }
            i -= 1;
            j -= 1;
        } else if (here - (table[j - 1][i] + INSERT)).abs() < 1e-4 {
            j -= 1;
        } else {
            i -= 1;
        }
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::LexiconBuilder;
    use crate::lexicon::Lang;

    pub fn lexicon(words: &[(&str, f64)]) -> Lexicon {
        let mut builder = LexiconBuilder::default();
        for (word, cost) in words {
            builder.word(word, Lang::Pt, *cost, false);
        }
        Lexicon::from_bytes(builder.finish()).unwrap()
    }

    fn certain(word: &str) -> Vec<Slot> {
        word.chars().map(Slot::certain).collect()
    }

    fn surfaces(lexicon: &Lexicon, found: &[Found]) -> Vec<String> {
        found.iter().map(|f| lexicon.entry(f.entry).surface.to_owned()).collect()
    }

    #[test]
    fn a_beginning_finds_its_completions_and_close_words() {
        let lex = lexicon(&[("você", 5.0), ("vocês", 7.0), ("voltar", 8.0), ("vaca", 9.0), ("casa", 6.0)]);
        let found = lexicon_words(&lex, &certain("voc"));
        let words = surfaces(&lex, &found);
        assert!(words.contains(&"você".to_owned()));
        assert!(words.contains(&"vocês".to_owned()));
        assert!(!words.contains(&"casa".to_owned()), "{words:?}");
        let voce = found.iter().find(|f| lex.entry(f.entry).surface == "você").unwrap();
        assert_eq!(voce.extra, 1);
    }

    #[test]
    fn a_misread_letter_costs_what_the_band_thought() {
        let lex = lexicon(&[("lumen", 9.0), ("lume", 8.0)]);
        let bias = [0.0; band_core::handwriting::CLASSES];
        // "1umen" where the 1 had 35 % of l.
        let mut slots = vec![Slot::from_values(&crate::channel::tests::values(&[(53, 0.6), (11, 0.35)]), &bias)];
        slots.extend(certain("umen"));
        let found = lexicon_words(&lex, &slots);
        let lumen = found.iter().find(|f| lex.entry(f.entry).surface == "lumen").expect("lumen");
        assert_eq!(lumen.extra, 0);
        assert!(lumen.channel < 2.5, "{}", lumen.channel);
    }

    #[test]
    fn pairs_say_which_slot_was_which_letter() {
        let slots = certain("tste");
        let symbol = |c| symbol_of_char(c).unwrap();
        assert_eq!(pairs(&slots, "teste"), vec![(0, symbol('t')), (1, symbol('s')), (2, symbol('t')), (3, symbol('e'))]);
    }

    #[test]
    fn alignment_handles_missing_and_extra_letters() {
        let (exact, left) = align(&certain("teste"), "teste");
        assert!(exact < 1.0 && left == 0);
        let (missing, _) = align(&certain("tste"), "teste");
        assert!(missing > exact && missing < exact + INSERT + 0.5);
        let (extra, _) = align(&certain("tesste"), "teste");
        assert!(extra > exact);
        let (_, left) = align(&certain("tes"), "teste");
        assert_eq!(left, 2);
    }
}
