//! Suggestions and corrections for the band's handwriting (the glasses' keyboard): the band's
//! own probabilities for each letter, a lexicon of English and Portuguese words with how likely
//! each is after the one before, and what the wearer teaches it by accepting, keeping and
//! undoing. See docs/features.md, "Suggestions while writing".

pub mod assistant;
pub mod build;
pub mod channel;
pub mod fold;
pub mod format;
pub mod lexicon;
pub mod personal;
pub mod search;
