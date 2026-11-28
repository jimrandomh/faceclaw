//! Looks words up in a lexicon file: `cargo run -p writing --example inspect -- writing.lex nao voce eu`.
use writing::lexicon::{Lang, Lexicon};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lex = Lexicon::open(std::path::Path::new(&args[1])).expect("lexicon");
    println!("{} entries", lex.len());
    for word in &args[2..] {
        let key = writing::fold::fold(word);
        let entries: Vec<String> = lex
            .entries(&key)
            .map(|id| {
                let e = lex.entry(id);
                format!("{} en={:?} pt={:?}{}", e.surface, e.cost(Lang::En), e.cost(Lang::Pt), if e.hidden { " hidden" } else { "" })
            })
            .collect();
        println!("{key}: {entries:?}");
        if let Some(id) = lex.entries(&key).next() {
            for lang in Lang::ALL {
                let next: Vec<String> = lex.next_words(lang, id).iter().take(6).map(|(n, c)| format!("{}:{c:.1}", lex.entry(*n).surface)).collect();
                if !next.is_empty() {
                    println!("  next {lang:?}: {next:?}");
                }
            }
        }
        let under: Vec<&str> = lex.under(&key, 8).iter().map(|&id| lex.entry(id).surface).collect();
        println!("  under: {under:?}");
    }
}
