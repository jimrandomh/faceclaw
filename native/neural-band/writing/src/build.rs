//! Writes a lexicon file (see [crate::format]): the data tool's last step, and the tests' way
//! to make a small one.

use std::collections::{BTreeMap, HashMap};

use crate::fold;
use crate::format::{self, LANGS, NO_COST};
use crate::lexicon::Lang;

/// Likeliest words kept per short prefix.
const TOP_PER_PREFIX: usize = 16;

#[derive(Default)]
pub struct LexiconBuilder {
    /// spelling -> (cost per language, hidden)
    words: HashMap<String, ([Option<f64>; LANGS], bool)>,
    /// (language, head, next) -> cost of next after head
    pairs: HashMap<(usize, String, String), f64>,
    /// (language, head) -> backoff cost
    backoff: HashMap<(usize, String), f64>,
}

impl LexiconBuilder {
    /// A spelling and its cost (-ln p) alone in `lang`; the cheapest wins when it comes twice.
    pub fn word(&mut self, surface: &str, lang: Lang, cost: f64, hidden: bool) {
        let entry = self.words.entry(surface.to_owned()).or_insert(([None; LANGS], false));
        let slot = &mut entry.0[lang as usize];
        *slot = Some(slot.map_or(cost, |old| old.min(cost)));
        entry.1 |= hidden;
    }

    /// `next`'s cost right after `head` in `lang` (both must be words of that language).
    pub fn pair(&mut self, lang: Lang, head: &str, next: &str, cost: f64) {
        self.pairs.insert((lang as usize, head.to_owned(), next.to_owned()), cost);
    }

    /// The cost of a word `head`'s pairs don't list, on top of its own.
    pub fn backoff(&mut self, lang: Lang, head: &str, cost: f64) {
        self.backoff.insert((lang as usize, head.to_owned()), cost);
    }

    pub fn finish(self) -> Vec<u8> {
        // Keys in order, each with its spellings (spelling, costs, hidden), cheapest first.
        type Spelling = (String, [Option<f64>; LANGS], bool);
        let mut by_key: BTreeMap<String, Vec<Spelling>> = BTreeMap::new();
        for (surface, (costs, hidden)) in self.words {
            let key = fold::fold(&surface);
            if key.is_empty() {
                continue;
            }
            by_key.entry(key).or_default().push((surface, costs, hidden));
        }
        let best = |costs: &[Option<f64>; LANGS]| costs.iter().flatten().cloned().fold(f64::INFINITY, f64::min);
        let mut keys = fst::MapBuilder::memory();
        let mut entries = Vec::new();
        let mut strings = Vec::new();
        let mut ids: HashMap<String, u32> = HashMap::new();
        // (key, entry, cost) for the prefix lists
        let mut ranked: Vec<(String, u32, f64)> = Vec::new();
        let mut next_id = 0u32;
        for (key, mut spellings) in by_key {
            spellings.sort_by(|a, b| best(&a.1).total_cmp(&best(&b.1)).then(a.0.cmp(&b.0)));
            spellings.truncate(255);
            keys.insert(&key, (u64::from(next_id) << 8) | spellings.len() as u64).expect("keys in order");
            for (surface, costs, hidden) in spellings {
                entries.extend_from_slice(&(strings.len() as u32).to_le_bytes());
                entries.push(surface.len().min(255) as u8);
                entries.push(if hidden { format::FLAG_HIDDEN } else { 0 });
                for cost in costs {
                    entries.push(cost.map_or(NO_COST, format::quantize));
                }
                strings.extend_from_slice(&surface.as_bytes()[..surface.len().min(255)]);
                if !hidden {
                    ranked.push((key.clone(), next_id, best(&costs)));
                }
                ids.insert(surface, next_id);
                next_id += 1;
            }
        }
        let mut lists: BTreeMap<String, Vec<(f64, u32)>> = BTreeMap::new();
        for (key, id, cost) in &ranked {
            for len in 1..=format::PREFIX_MAX.min(key.len()) {
                lists.entry(key[..len].to_owned()).or_default().push((*cost, *id));
            }
        }
        let mut prefix = fst::MapBuilder::memory();
        let mut toplist = Vec::new();
        for (key, mut list) in lists {
            list.sort_by(|a, b| a.0.total_cmp(&b.0));
            list.truncate(TOP_PER_PREFIX);
            let start = toplist.len() / 4;
            for (_, id) in &list {
                toplist.extend_from_slice(&id.to_le_bytes());
            }
            prefix.insert(&key, ((start as u64) << 8) | list.len() as u64).expect("prefixes in order");
        }
        let mut heads: [Vec<u8>; LANGS] = Default::default();
        let mut pairs: [Vec<u8>; LANGS] = Default::default();
        for lang in 0..LANGS {
            let mut by_head: BTreeMap<u32, Vec<(f64, u32)>> = BTreeMap::new();
            for ((l, head, next), cost) in &self.pairs {
                if *l != lang {
                    continue;
                }
                if let (Some(&h), Some(&n)) = (ids.get(head), ids.get(next)) {
                    by_head.entry(h).or_default().push((*cost, n));
                }
            }
            for (head_surface, _) in self.backoff.keys().filter(|(l, _)| *l == lang).map(|(l, h)| (h, l)) {
                if let Some(&h) = ids.get(head_surface) {
                    by_head.entry(h).or_default();
                }
            }
            let names: HashMap<u32, &String> = ids.iter().map(|(s, id)| (*id, s)).collect();
            for (head, mut list) in by_head {
                list.sort_by(|a, b| a.0.total_cmp(&b.0));
                list.truncate(u16::MAX as usize);
                let backoff = self.backoff.get(&(lang, names[&head].clone())).copied().unwrap_or(0.0);
                heads[lang].extend_from_slice(&head.to_le_bytes());
                heads[lang].extend_from_slice(&((pairs[lang].len() / format::PAIR_SIZE) as u32).to_le_bytes());
                heads[lang].extend_from_slice(&(list.len() as u16).to_le_bytes());
                heads[lang].push(format::quantize(backoff));
                heads[lang].push(0);
                for (cost, next) in list {
                    pairs[lang].extend_from_slice(&next.to_le_bytes());
                    pairs[lang].push(format::quantize(cost));
                }
            }
        }
        let [head_en, head_pt] = heads;
        let [next_en, next_pt] = pairs;
        format::write(&[
            (format::KEYS, keys.into_inner().expect("keys")),
            (format::ENTRIES, entries),
            (format::STRINGS, strings),
            (format::PREFIX, prefix.into_inner().expect("prefix")),
            (format::TOPLIST, toplist),
            (format::HEADS[0], head_en),
            (format::PAIRS[0], next_en),
            (format::HEADS[1], head_pt),
            (format::PAIRS[1], next_pt),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexicon::Lexicon;

    #[test]
    fn a_lexicon_round_trips() {
        let mut builder = LexiconBuilder::default();
        builder.word("não", Lang::Pt, 3.0, false);
        builder.word("nao", Lang::Pt, 12.0, false);
        builder.word("esta", Lang::Pt, 5.0, false);
        builder.word("está", Lang::Pt, 4.0, false);
        builder.word("the", Lang::En, 2.0, false);
        builder.word("I", Lang::En, 3.5, false);
        builder.word("damn", Lang::En, 9.0, true);
        builder.pair(Lang::Pt, "não", "está", 1.5);
        builder.backoff(Lang::Pt, "não", 2.0);
        let lex = Lexicon::from_bytes(builder.finish()).unwrap();
        let nao: Vec<&str> = lex.entries("nao").map(|id| lex.entry(id).surface).collect();
        assert_eq!(nao, vec!["não", "nao"]);
        let esta: Vec<&str> = lex.entries("esta").map(|id| lex.entry(id).surface).collect();
        assert_eq!(esta, vec!["está", "esta"]);
        let the = lex.entries("the").start;
        assert_eq!(lex.entry(the).cost(Lang::En), Some(2.0));
        assert_eq!(lex.entry(the).cost(Lang::Pt), None);
        assert!(lex.entry(lex.entries("damn").start).hidden);
        assert_eq!(lex.entries("i").len(), 1);
        // Pairs: the seen one, and the backoff for the rest.
        let n = lex.entries("nao").start;
        let est = lex.entries("esta").start;
        let es = est + 1;
        assert!((lex.pair_cost(Lang::Pt, Some(n), est).unwrap() - 1.5).abs() < 0.01);
        assert!((lex.pair_cost(Lang::Pt, Some(n), es).unwrap() - 7.0).abs() < 0.01);
        assert_eq!(lex.next_words(Lang::Pt, n), vec![(est, 1.5)]);
        // Prefix lists, likeliest first, without hidden words.
        let under: Vec<&str> = lex.under("es", 10).iter().map(|&id| lex.entry(id).surface).collect();
        assert_eq!(under, vec!["está", "esta"]);
        assert!(lex.under("da", 10).is_empty());
        assert_eq!(lex.under("esta", 10).len(), 2);
    }
}
