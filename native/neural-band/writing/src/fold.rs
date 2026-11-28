//! Words as the band can write them: lower case, without accents, apostrophes or hyphens. The
//! band's model has no accented letters, so "nao" has to find "não"; the lexicon is keyed by
//! this form (LatinIME does the same with its base characters).

/// The letter `c` folds to (lower case, accent off), `None` for what a key leaves out
/// (apostrophes, hyphens) or can't hold.
pub fn fold_char(c: char) -> Option<char> {
    let lower = match c {
        'A'..='Z' => c.to_ascii_lowercase(),
        'a'..='z' | '0'..='9' => c,
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
        'ç' | 'Ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
        'ñ' | 'Ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
        'ý' | 'ÿ' | 'Ý' => 'y',
        _ => return None,
    };
    Some(lower)
}

/// Whether `c` belongs to a word (a letter or digit any script writes, an apostrophe, a hyphen).
pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '\'' || c == '’' || c == '-'
}

/// The key of a word: its folded letters and digits, in order.
pub fn fold(word: &str) -> String {
    word.chars().filter_map(fold_char).collect()
}

/// Whether every letter of `word` folds (a word the lexicon can hold).
pub fn foldable(word: &str) -> bool {
    word.chars().all(|c| fold_char(c).is_some() || c == '\'' || c == '’' || c == '-')
}

/// How a written word is capitalized, to give a suggestion the same look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Case {
    Lower,
    /// The first letter only ("Nao").
    Capital,
    /// Every letter, two or more ("NAO").
    Upper,
}

impl Case {
    pub fn of(written: &str) -> Self {
        let letters: Vec<char> = written.chars().filter(|c| c.is_alphabetic()).collect();
        match letters.first() {
            Some(first) if first.is_uppercase() => {
                if letters.len() >= 2 && letters.iter().all(|c| c.is_uppercase()) {
                    Case::Upper
                } else {
                    Case::Capital
                }
            }
            _ => Case::Lower,
        }
    }

    /// `word` in this case; a lexicon word with its own capitals ("Brasil", "I") keeps them.
    pub fn apply(self, word: &str) -> String {
        match self {
            Case::Lower => word.to_owned(),
            Case::Upper => word.to_uppercase(),
            Case::Capital => {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                    None => String::new(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accents_case_apostrophes_and_hyphens_fold_away() {
        assert_eq!(fold("Não"), "nao");
        assert_eq!(fold("você"), "voce");
        assert_eq!(fold("ação"), "acao");
        assert_eq!(fold("don't"), "dont");
        assert_eq!(fold("guarda-chuva"), "guardachuva");
        assert_eq!(fold("Pôr"), "por");
        assert!(foldable("d'água"));
        assert!(!foldable("straße"));
    }

    #[test]
    fn a_suggestion_takes_the_written_case() {
        assert_eq!(Case::of("nao"), Case::Lower);
        assert_eq!(Case::of("Nao"), Case::Capital);
        assert_eq!(Case::of("NAO"), Case::Upper);
        assert_eq!(Case::of("N"), Case::Capital);
        assert_eq!(Case::Capital.apply("não"), "Não");
        assert_eq!(Case::Upper.apply("não"), "NÃO");
        assert_eq!(Case::Lower.apply("Brasil"), "Brasil");
    }
}
