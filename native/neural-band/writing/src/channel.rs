//! What the band read for one written letter. Each letter the band's decoder writes keeps the
//! model's whole distribution, not just its likeliest class: "1" read at 60 % with "l" at 35 %
//! makes "lumen" cheap where a 1-best decoder would need an edit. Text that came without a
//! distribution (what the field held, a letter typed back after a deletion) gets a confident
//! one, so a correction can still change it, at a price.
//!
//! The wearer's own letters teach it ([learn]): a bias per class, moved a little each time a
//! word is confirmed, so a "l" this wearer's band keeps reading as "1" costs less to correct.

use band_core::handwriting::{BLANK, CLASSES, Edit, edit};

/// a-z, 0-9, then everything else written (punctuation).
pub const SYMBOLS: usize = 37;
const OTHER: usize = 36;
/// The cheapest a symbol never seen costs (p = 1e-4).
const FLOOR: f32 = 9.21;
/// A letter the band missed, written into the word.
pub const INSERT: f32 = 3.5;
/// A letter the band wrote that the word doesn't have.
pub const DELETE: f32 = 4.0;
/// A letter without the band's distribution: this sure, the rest spread over the alphabet.
const CERTAIN: f32 = 0.85;

/// Class pairs per letter: lower case, upper case.
fn letter_classes(symbol: usize) -> (usize, Option<usize>) {
    if symbol < 26 { (symbol, Some(symbol + 26)) } else { (symbol + 26, None) }
}

/// The symbol a class writes, when it writes one ([OTHER] for punctuation).
pub fn symbol_of_class(class: usize) -> Option<usize> {
    match class {
        0..=25 => Some(class),
        26..=51 => Some(class - 26),
        52..=61 => Some(class - 26),
        _ if class == BLANK || edit(class).is_some() || class >= 94 => None,
        _ => Some(OTHER),
    }
}

/// The symbol of a folded character.
pub fn symbol_of_char(c: char) -> Option<usize> {
    match c {
        'a'..='z' => Some(c as usize - 'a' as usize),
        '0'..='9' => Some(26 + c as usize - '0' as usize),
        _ => None,
    }
}

/// Whether a class writes into the text (a letter, a digit, punctuation).
fn writes(class: usize) -> bool {
    class < 94 && !matches!(edit(class), Some(Edit::Boundary | Edit::Space))
}

#[derive(Debug, Clone)]
pub struct Slot {
    /// -ln p per symbol.
    cost: [f32; SYMBOLS],
    /// The model's log-probabilities (averaged over the samples of the letter), for learning.
    values: Option<Box<[f32; CLASSES]>>,
    samples: u32,
}

impl Slot {
    /// A letter from the model's log-probabilities (`values`, one per class), with the wearer's
    /// `bias` added.
    pub fn from_values(values: &[f32], bias: &[f32; CLASSES]) -> Self {
        let mut own = Box::new([0.0f32; CLASSES]);
        own.copy_from_slice(&values[..CLASSES]);
        let mut slot = Self { cost: [FLOOR; SYMBOLS], values: Some(own), samples: 1 };
        slot.compute(bias);
        slot
    }

    /// A letter written without the band's distribution.
    pub fn certain(c: char) -> Self {
        let rest = ((1.0 - CERTAIN) / (SYMBOLS - 1) as f32).ln();
        let mut cost = [-rest; SYMBOLS];
        if let Some(symbol) = symbol_of_char(c) {
            cost[symbol] = -CERTAIN.ln();
        } else {
            cost[OTHER] = -CERTAIN.ln();
        }
        Self { cost, values: None, samples: 0 }
    }

    /// Another sample of the same letter: the distributions average.
    pub fn add(&mut self, values: &[f32], bias: &[f32; CLASSES]) {
        let Some(own) = &mut self.values else { return };
        let n = self.samples as f32;
        for (mine, &new) in own.iter_mut().zip(values) {
            // Averaging probabilities, in the log domain.
            let a = *mine + (n / (n + 1.0)).ln();
            let b = new + (1.0 / (n + 1.0)).ln();
            let high = a.max(b);
            *mine = high + ((a - high).exp() + (b - high).exp()).ln();
        }
        self.samples += 1;
        self.compute(bias);
    }

    fn compute(&mut self, bias: &[f32; CLASSES]) {
        let Some(values) = &self.values else { return };
        let mut mass = [0.0f64; SYMBOLS];
        let mut total = 0.0f64;
        for class in (0..CLASSES).filter(|&class| writes(class)) {
            let Some(symbol) = symbol_of_class(class) else { continue };
            let p = f64::from(values[class] + bias[class]).exp();
            mass[symbol] += p;
            total += p;
        }
        for (cost, mass) in self.cost.iter_mut().zip(mass) {
            *cost = if total > 0.0 { (-(mass / total).ln() as f32).min(FLOOR) } else { FLOOR };
        }
    }

    /// The cost of reading this slot as `symbol`.
    pub fn cost(&self, symbol: usize) -> f32 {
        self.cost[symbol]
    }

    /// The cost of this slot being noise (no letter of the word).
    pub fn delete(&self) -> f32 {
        DELETE.min(self.cost[OTHER] + 0.5)
    }

    /// The likeliest symbol.
    pub fn best(&self) -> usize {
        (0..SYMBOLS).min_by(|&a, &b| self.cost[a].total_cmp(&self.cost[b])).unwrap_or(OTHER)
    }

    /// Whether this came with the band's distribution (and can teach).
    pub fn measured(&self) -> bool {
        self.values.is_some()
    }
}

/// One step of the wearer's bias toward `symbol` for this slot (a confirmed reading): the
/// gradient of the classes' softmax cross-entropy, the target split between the letter's
/// lower- and upper-case classes as the model split them.
pub fn learn(bias: &mut [f32; CLASSES], slot: &Slot, symbol: usize, rate: f32) {
    let Some(values) = &slot.values else { return };
    let classes: Vec<usize> = (0..CLASSES).filter(|&class| writes(class)).collect();
    let logits: Vec<f32> = classes.iter().map(|&class| values[class] + bias[class]).collect();
    let high = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exp: Vec<f32> = logits.iter().map(|l| (l - high).exp()).collect();
    let sum: f32 = exp.iter().sum();
    let (lower, upper) = letter_classes(symbol);
    let target_mass: f32 = classes
        .iter()
        .zip(&exp)
        .filter(|(class, _)| **class == lower || Some(**class) == upper)
        .map(|(_, e)| e / sum)
        .sum::<f32>()
        .max(1e-6);
    for (index, &class) in classes.iter().enumerate() {
        let p = exp[index] / sum;
        let target = if class == lower || Some(class) == upper { p / target_mass } else { 0.0 };
        bias[class] = (bias[class] - rate * (p - target)).clamp(-BIAS_LIMIT, BIAS_LIMIT);
    }
}

/// How far the wearer's bias may move a class (in nats).
pub const BIAS_LIMIT: f32 = 2.5;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Log-probabilities with `p` on `class` and the rest spread.
    pub fn values(pairs: &[(usize, f32)]) -> Vec<f32> {
        let used: f32 = pairs.iter().map(|(_, p)| p).sum();
        let rest = (1.0 - used) / (CLASSES - pairs.len()) as f32;
        (0..CLASSES)
            .map(|class| pairs.iter().find(|(c, _)| *c == class).map_or(rest, |(_, p)| *p).ln())
            .collect()
    }

    #[test]
    fn a_slot_keeps_the_runner_up() {
        let bias = [0.0; CLASSES];
        // "1" (class 53) at 60 %, "l" (11) at 35 %.
        let slot = Slot::from_values(&values(&[(53, 0.6), (11, 0.35)]), &bias);
        assert_eq!(slot.best(), symbol_of_char('1').unwrap());
        let l = slot.cost(symbol_of_char('l').unwrap());
        assert!(l < 1.2, "{l}");
        assert!(slot.cost(symbol_of_char('x').unwrap()) > 6.0);
        // Upper and lower case count together.
        let slot = Slot::from_values(&values(&[(26 + 11, 0.5), (11, 0.4)]), &bias);
        assert!(slot.cost(symbol_of_char('l').unwrap()) < 0.15);
    }

    #[test]
    fn learning_moves_the_bias_toward_the_confirmed_letter() {
        let mut bias = [0.0; CLASSES];
        let frame = values(&[(53, 0.6), (11, 0.35)]);
        let l = symbol_of_char('l').unwrap();
        let before = Slot::from_values(&frame, &bias).cost(l);
        for _ in 0..20 {
            let slot = Slot::from_values(&frame, &bias);
            learn(&mut bias, &slot, l, 0.05);
        }
        let after = Slot::from_values(&frame, &bias).cost(l);
        assert!(after < before - 0.3, "{before} -> {after}");
        assert!(bias.iter().all(|b| b.abs() <= BIAS_LIMIT));
    }

    #[test]
    fn a_letter_without_a_distribution_is_sure_but_not_certain() {
        let slot = Slot::certain('a');
        assert!(slot.cost(0) < 0.2);
        assert!(slot.cost(1) > 4.0 && slot.cost(1) < 6.0);
        assert!(!slot.measured());
    }
}
