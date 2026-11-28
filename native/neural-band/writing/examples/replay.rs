//! Replays a writing probe recording (tools/writing-probe, debug builds' WritingProbe) through
//! the band's greedy decoder with and without the suggestions, and prints what the panel would
//! have shown after each letter:
//! `cargo run -p writing --example replay -- writing.lex recording.jsonl [more.jsonl…]`.

use band_core::handwriting::{BLANK, CLASSES, HANDWRITING_PIPELINE, HandwritingDecoder, InferenceSample, glyph};
use writing::assistant::{Assistant, Op, Settings};
use writing::lexicon::Lexicon;
use writing::personal::Personal;

/// A full distribution from a record's likeliest classes (rounded to 3 decimals there), the
/// rest spread evenly, normalized again.
fn values(top: &[(usize, f64)]) -> Vec<f32> {
    let used: f64 = top.iter().map(|(_, lp)| lp.exp()).sum();
    let rest_total = (1.0 - used).max(1e-5);
    let rest = rest_total / (CLASSES - top.len()) as f64;
    let total = used + rest_total;
    (0..CLASSES)
        .map(|class| {
            let p = top.iter().find(|(c, _)| *c == class).map_or(rest, |(_, lp)| lp.exp());
            (p / total).ln() as f32
        })
        .collect()
}

fn field(line: &str, key: &str) -> Option<f64> {
    let at = line.find(&format!("\"{key}\":"))? + key.len() + 3;
    let tail = &line[at..];
    let end = tail.find([',', '}']).unwrap_or(tail.len());
    tail[..end].trim().parse().ok()
}

fn top(line: &str) -> Vec<(usize, f64)> {
    let Some(at) = line.find("\"top\":[") else { return Vec::new() };
    let tail = &line[at + 7..];
    let end = tail.find("]]").map_or(tail.len(), |e| e + 1);
    tail[..end]
        .split("],")
        .filter_map(|pair| {
            let pair = pair.trim_matches(|c| c == '[' || c == ']');
            let (class, lp) = pair.split_once(',')?;
            Some((class.trim().parse().ok()?, lp.trim().parse().ok()?))
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lexicon_path = std::path::Path::new(&args[1]);
    let mut personal = Personal::default();
    for path in &args[2..] {
        println!("== {path}");
        let text = std::fs::read_to_string(path).expect("recording");
        let mut decoder = HandwritingDecoder::default();
        let mut plain = HandwritingDecoder::default();
        let mut assistant = Assistant::new(Lexicon::open(lexicon_path).unwrap(), personal.clone(), Settings { autocorrect: true, learn: true }, 20_000);
        assistant.reset("");
        let mut sequence = 0u64;
        for line in text.lines() {
            if line.contains("\"type\":\"gesture\"") && line.contains("\"thumb\"") && line.contains("\"action\":\"right\"") {
                let current = decoder.text().to_owned();
                if let Some(new) = assistant.command(Op::Accept, &current).text {
                    println!("   [thumb right] accept -> {new:?}");
                    decoder.set_text(&new);
                }
                continue;
            }
            if !line.contains("\"type\":\"frame\"") {
                continue;
            }
            let ts = field(line, "ts").unwrap_or(0.0) as u64;
            let values = values(&top(line));
            sequence += 1;
            let sample = InferenceSample { sequence, timestamp_us: ts, pipeline: HANDWRITING_PIPELINE, latency_us: None, values: values.clone() };
            if std::env::var("REPLAY_DEBUG").is_ok() {
                eprintln!("frame ts {ts} top {:?} dist {}", top(line).first(), sample.is_text_distribution());
            }
            plain.consume(&sample);
            assistant.frame(ts, &values);
            if let Some(class) = decoder.consume(&sample) {
                if class == BLANK {
                    continue;
                }
                let current = decoder.text().to_owned();
                let outcome = assistant.written(&current, class);
                if let Some(new) = &outcome.text {
                    decoder.set_text(new);
                }
                if band_core::handwriting::edit(class) == Some(band_core::handwriting::Edit::Boundary) {
                    continue;
                }
                let shown = decoder.text();
                println!(
                    "  {:>4} {:<28} | {:<5} {:?} sel {} ghost {:?}{}",
                    glyph(class),
                    format!("{shown:?}"),
                    assistant.kind().name(),
                    assistant.items(),
                    assistant.selected(),
                    assistant.ghost(),
                    assistant.notice().map(|n| format!("  {n:?}")).unwrap_or_default()
                );
                if std::env::var("REPLAY_EXPLAIN").is_ok() {
                    for (word, f, score) in assistant.explain() {
                        println!("         {word:<10} {score:6.2}  ch {:.2} lm {:.2} extra {} compl {} changed {} own {}", f[0], f[1], f[2], f[3], f[4], f[5]);
                    }
                }
            }
        }
        println!("  greedy:    {:?}", plain.text());
        println!("  assistant: {:?}", decoder.text());
        if let Some(bytes) = assistant.finish() {
            personal = Personal::from_bytes(&bytes);
        }
    }
}
