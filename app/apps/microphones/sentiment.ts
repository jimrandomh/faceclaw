// Deterministic sentiment analysis: a keyword emotion classifier (with
// negation scoping and confidence calibration) plus hand-lexicon polarity
// scoring. No platform NLP dependency — the deterministic tiers carry the
// whole signal.

import { NON_WORD_RUN } from "../../util/unicode-class";

export type EmotionLabel =
  | "happy"
  | "sad"
  | "angry"
  | "frustrated"
  | "excited"
  | "anxious"
  | "surprised"
  | "confident"
  | "confused"
  | "disgusted"
  | "embarrassed"
  | "relieved"
  | "bored"
  | "calm"
  | "neutral";

export type SentimentBucket = "veryPositive" | "positive" | "neutral" | "negative" | "veryNegative";

export type EmotionDetection = {
  emotion: EmotionLabel;
  confidence: number;
  source: "keyword" | "lexical" | "none";
};

// Declaration order matters twice: EMOTION_ORDER breaks ranking ties, and
// EMOTION_PATTERNS is evaluated in table order.
const EMOTION_ORDER: EmotionLabel[] = [
  "happy", "sad", "angry", "frustrated", "excited", "anxious", "surprised",
  "confident", "confused", "disgusted", "embarrassed", "relieved", "bored",
  "calm", "neutral",
];

// Terms users commonly use when searching for each emotion. The classifier
// matches these too, so storage and retrieval speak the same vocabulary.
const SEARCH_ALIASES: Record<EmotionLabel, string[]> = {
  happy: ["happy", "happiness", "glad", "pleased", "joy", "joyful", "cheerful", "delighted"],
  sad: ["sad", "sadness", "unhappy", "heartbroken", "depressed", "grief", "somber", "upset"],
  angry: ["angry", "anger", "mad", "furious", "livid", "irate", "outraged", "rage", "hostile"],
  frustrated: ["frustrated", "frustration", "annoyed", "annoying", "irritated", "irritating", "fed up"],
  excited: ["excited", "excitement", "enthusiastic", "thrilled", "pumped", "stoked"],
  anxious: ["anxious", "anxiety", "worried", "worry", "nervous", "afraid", "scared", "stressed", "panic"],
  surprised: ["surprised", "surprise", "shocked", "unexpected", "astonished", "amazed"],
  confident: ["confident", "confidence", "certain", "assured", "sure", "determined"],
  confused: ["confused", "confusion", "unclear", "uncertain", "puzzled", "lost"],
  disgusted: ["disgusted", "disgust", "repulsed", "revolted", "sickened", "revolting"],
  embarrassed: ["embarrassed", "embarrassment", "ashamed", "humiliated", "mortified", "self-conscious", "awkward"],
  relieved: ["relieved", "relief", "reassured", "thank goodness", "weight off my shoulders"],
  bored: ["bored", "boredom", "boring", "uninterested", "tedious", "zoned out"],
  calm: ["calm", "calmness", "relaxed", "peaceful", "at ease", "settled"],
  neutral: ["neutral"],
};

// High-precision subset suitable for silently turning natural language into
// an exact filter. Ambiguous terms such as "sure", "lost", "miss", and "mad"
// remain indexed search aliases but never hijack ordinary searches.
const INFERRED_FILTER_ALIASES: Record<EmotionLabel, string[]> = {
  happy: ["happy", "happiness", "glad", "joy", "joyful", "cheerful", "delighted"],
  sad: ["sad", "sadness", "unhappy", "heartbroken", "depressed", "grief", "somber"],
  angry: ["angry", "anger", "furious", "livid", "irate", "outraged", "rage", "hostile"],
  frustrated: ["frustrated", "frustration", "annoyed", "irritated", "fed up"],
  excited: ["excited", "excitement", "enthusiastic", "thrilled", "pumped", "stoked"],
  anxious: ["anxious", "anxiety", "worried", "nervous", "afraid", "scared", "panic"],
  surprised: ["surprised", "surprise", "shocked", "astonished"],
  confident: ["confident", "confidence", "assured"],
  confused: ["confused", "confusion", "puzzled"],
  disgusted: ["disgusted", "disgust", "repulsed", "revolted", "sickened"],
  embarrassed: ["embarrassed", "embarrassment", "ashamed", "humiliated", "mortified"],
  relieved: ["relieved", "relief", "reassured"],
  bored: ["bored", "boredom", "uninterested"],
  calm: ["calm", "calmness", "relaxed"],
  neutral: [],
};

const EMOTION_PATTERNS: Array<[EmotionLabel, string[]]> = [
  ["happy", ["happy", "happier", "glad", "pleased", "wonderful", "great", "awesome", "fantastic", "love", "enjoy", "thankful", "grateful", "delighted", "joyful", "cheerful"]],
  ["excited", ["excited", "enthusiastic", "amazing", "incredible", "can't wait", "thrilled", "pumped", "stoked", "wow", "unbelievable", "blown away"]],
  ["sad", ["sad", "unhappy", "unfortunately", "miss", "sorry", "regret", "disappointing", "heartbreaking", "crying", "depressed", "grief", "mourn"]],
  ["angry", ["angry", "mad", "furious", "livid", "irate", "outraged", "rage", "hostile", "unacceptable", "ridiculous", "hate", "damn", "pissed", "how dare you", "enough is enough", "what the hell", "this is bullshit", "you never listen", "i have had enough", "stop it right now"]],
  ["frustrated", ["frustrated", "annoyed", "annoying", "irritated", "irritating", "stuck", "struggling", "can't figure", "doesn't work", "broken", "keeps failing", "fed up", "tired of", "sick of", "waste of time", "again and again", "why does this keep"]],
  ["anxious", ["worried", "anxious", "nervous", "concerned", "afraid", "scared", "uneasy", "stressed", "stress", "panic", "overwhelmed", "overwhelm", "dread"]],
  ["surprised", ["surprised", "astonished", "unexpected", "didn't expect", "shocking", "no way", "whoa"]],
  ["confident", ["confident", "certain", "sure", "guaranteed", "no doubt", "convinced"]],
  ["confused", ["confused", "don't understand", "unclear", "what do you mean", "lost", "lost me", "makes no sense", "wait what", "i'm not sure", "puzzled"]],
  ["disgusted", ["disgusted", "repulsed", "revolted", "sickened", "that's disgusting", "that is disgusting", "makes me sick", "turns my stomach"]],
  ["embarrassed", ["embarrassed", "ashamed", "humiliated", "mortified", "self-conscious", "i could die of embarrassment"]],
  ["relieved", ["relieved", "what a relief", "thank goodness", "thank god", "weight off my shoulders", "can breathe again"]],
  ["bored", ["bored", "uninterested", "zoned out", "lost interest", "couldn't care less"]],
  ["calm", ["calm", "relaxed", "peaceful", "at ease", "settled", "untroubled"]],
];

const EMOTION_SEARCH_PATTERNS: Array<[EmotionLabel, string[]]> = EMOTION_PATTERNS.map(
  ([emotion, patterns]) => [emotion, dedupe(patterns.concat(SEARCH_ALIASES[emotion]))],
);

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

// These lexicons carry the whole polarity signal, so both sets are extended
// (see below).
const POSITIVE_LEXICON = new Set<string>([
  "amazing", "awesome", "best", "excellent", "fantastic", "glad", "great", "happy",
  "love", "outstanding", "perfect", "pleased", "positive", "relieved", "thankful", "wonderful",
  // Extension: common polarity words added so the lexicons carry the whole
  // polarity signal on their own.
  "beautiful", "better", "brilliant", "delighted", "enjoy", "enjoyed", "excited",
  "fun", "good", "grateful", "helpful", "hopeful", "impressive", "joy", "lovely",
  "nice", "proud", "success", "successful", "thrilled",
]);

const NEGATIVE_LEXICON = new Set<string>([
  "angry", "ashamed", "awful", "bad", "bored", "disappointed", "disappointing",
  "disgusted", "embarrassed", "frustrated", "hate", "horrible", "negative", "sad",
  "terrible", "unacceptable", "unhappy", "upset", "worried", "worse",
  // Extension: see the note on POSITIVE_LEXICON.
  "annoyed", "annoying", "anxious", "broken", "crying", "depressed", "dreadful",
  "failed", "failing", "furious", "hurt", "miserable", "nasty", "painful", "poor",
  "scared", "stressed", "useless", "worst", "wrong",
]);

const NEGATION_TOKENS = new Set<string>([
  "not", "never", "no", "neither", "nor", "hardly", "without", "cannot", "cant",
]);

// Contrastive conjunctions end a negation scope: "not happy, but angry"
// expresses anger. Coordinating "and" is intentionally excluded because
// "not angry and frustrated" often negates both states.
const NEGATION_SCOPE_BOUNDARY_TOKENS = new Set<string>([
  "but", "however", "though", "yet",
]);

function emotionTokens(text: string): string[] {
  // Preserve the semantic negation before punctuation/apostrophes are stripped.
  const normalized = text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/can't/g, "cannot")
    .replace(/i'm/g, "i am")
    .replace(/n't/g, " not");
  return normalized.split(NON_WORD_RUN).filter((token) => token.length > 0);
}

function emotionCueIsNegated(start: number, tokens: string[]): boolean {
  if (start <= 0) return false;
  const windowStart = Math.max(0, start - 3);
  for (let i = start - 1; i >= windowStart; i--) {
    if (NEGATION_SCOPE_BOUNDARY_TOKENS.has(tokens[i])) {
      // Only a negation between the boundary and the cue still applies.
      for (let j = i + 1; j < start; j++) {
        if (NEGATION_TOKENS.has(tokens[j])) return true;
      }
      return false;
    }
  }
  for (let i = windowStart; i < start; i++) {
    if (NEGATION_TOKENS.has(tokens[i])) return true;
  }
  return false;
}

function matchesAt(patternTokens: string[], start: number, tokens: string[]): boolean {
  for (let i = 0; i < patternTokens.length; i++) {
    if (tokens[start + i] !== patternTokens[i]) return false;
  }
  return true;
}

// Match whole words/phrases, not substrings ("mad" must not match "made"),
// and ignore explicitly negated cues ("I am not angry").
function nonNegatedMatchCount(pattern: string, tokens: string[]): number {
  const patternTokens = emotionTokens(pattern);
  if (patternTokens.length === 0 || patternTokens.length > tokens.length) return 0;
  let count = 0;
  for (let start = 0; start <= tokens.length - patternTokens.length; start++) {
    if (!matchesAt(patternTokens, start, tokens)) continue;
    if (emotionCueIsNegated(start, tokens)) continue;
    count++;
  }
  return count;
}

function containsNonNegatedPattern(pattern: string, tokens: string[]): boolean {
  const patternTokens = emotionTokens(pattern);
  if (patternTokens.length === 0 || patternTokens.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - patternTokens.length; start++) {
    if (!matchesAt(patternTokens, start, tokens)) continue;
    if (emotionCueIsNegated(start, tokens)) continue;
    return true;
  }
  return false;
}

function detectEmotionWithScore(text: string, sentimentScore: number): EmotionDetection {
  const tokens = emotionTokens(text);

  // Stable ordering makes runner-up selection reproducible, while equal
  // evidence is handled as ambiguity below rather than guessed.
  const ranked: Array<[EmotionLabel, number]> = [];
  for (const [emotion, patterns] of EMOTION_SEARCH_PATTERNS) {
    let score = 0;
    for (const pattern of patterns) {
      score += nonNegatedMatchCount(pattern, tokens);
    }
    if (score > 0) ranked.push([emotion, score]);
  }
  ranked.sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return EMOTION_ORDER.indexOf(a[0]) - EMOTION_ORDER.indexOf(b[0]);
  });

  if (ranked.length > 0) {
    const [bestEmotion, bestScore] = ranked[0];
    const runnerUpScore = ranked.length > 1 ? ranked[1][1] : 0;
    if (bestScore - runnerUpScore === 0) {
      // Equally strong cues for different emotions are genuinely ambiguous;
      // picking one would make mixed statements depend on declaration order.
      return { emotion: "neutral", confidence: 0.40, source: "none" };
    }
    const confidence =
      bestScore >= 2
        ? Math.min(0.98, 0.88 + (bestScore - 2) * 0.03)
        : // A single cue can be quoted, topical, idiomatic, or sarcastic.
          0.70;
    return { emotion: bestEmotion, confidence, source: "keyword" };
  }

  // Polarity is not an emotion taxonomy: a negative score cannot distinguish
  // anger, sadness, fear, or frustration. Keep the categorical label neutral
  // and expose the independent score for search.
  if (Math.abs(sentimentScore) < 0.10) {
    return { emotion: "neutral", confidence: 0.76, source: "none" };
  }
  return { emotion: "neutral", confidence: 0.46, source: "lexical" };
}

export function detectEmotion(text: string): EmotionDetection {
  return detectEmotionWithScore(text, scoreSentiment(text));
}

// Score a single text string in [-1, 1]. Sentences are scored independently
// and averaged; the lexicon delta per sentence is normalized by sentence
// length.
export function scoreSentiment(text: string): number {
  const sentences = text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  if (sentences.length === 0) return 0;

  const scores: number[] = [];
  for (const sentence of sentences) {
    const tokens = emotionTokens(sentence);
    if (tokens.length === 0) continue;
    let delta = 0;
    for (let i = 0; i < tokens.length; i++) {
      let polarity = 0;
      if (POSITIVE_LEXICON.has(tokens[i])) polarity = 1;
      else if (NEGATIVE_LEXICON.has(tokens[i])) polarity = -1;
      if (polarity === 0) continue;
      if (emotionCueIsNegated(i, tokens)) polarity = -polarity;
      delta += polarity;
    }
    if (delta === 0) {
      scores.push(0);
      continue;
    }
    const normalized = delta / Math.max(Math.floor(tokens.length / 3), 1);
    scores.push(Math.max(-1, Math.min(1, normalized)));
  }
  if (scores.length === 0) return 0;

  const average = scores.reduce((total, score) => total + score, 0) / scores.length;
  return Math.max(-1, Math.min(1, average));
}

export function sentimentBucket(score: number): SentimentBucket {
  if (score > 0.3) return "veryPositive";
  if (score > 0.1) return "positive";
  if (score < -0.3) return "veryNegative";
  if (score < -0.1) return "negative";
  return "neutral";
}

export type AnalyzedLine = {
  score: number;
  emotion: EmotionLabel;
  emotionConfidence: number;
};

export function analyzeLine(text: string): AnalyzedLine {
  const score = scoreSentiment(text);
  const detection = detectEmotionWithScore(text, score);
  return { score, emotion: detection.emotion, emotionConfidence: detection.confidence };
}

export type SentimentPoint = {
  index: number;
  score: number;
  emotion: EmotionLabel;
};

export type SentimentSummary = {
  averageScore: number;
  bucket: SentimentBucket;
  bucketCounts: Record<SentimentBucket, number>;
  emotionDistribution: Partial<Record<EmotionLabel, number>>;
  trend: SentimentPoint[];
};

const MAX_TREND_POINTS = 60;

export function summarize(lines: AnalyzedLine[]): SentimentSummary {
  const bucketCounts: Record<SentimentBucket, number> = {
    veryPositive: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    veryNegative: 0,
  };
  const emotionDistribution: Partial<Record<EmotionLabel, number>> = {};
  if (lines.length === 0) {
    return { averageScore: 0, bucket: "neutral", bucketCounts, emotionDistribution, trend: [] };
  }

  let total = 0;
  for (const line of lines) {
    total += line.score;
    bucketCounts[sentimentBucket(line.score)]++;
    emotionDistribution[line.emotion] = (emotionDistribution[line.emotion] ?? 0) + 1;
  }
  const averageScore = total / lines.length;

  // Downsample by averaging within evenly-spaced chunks, keeping the most
  // extreme emotion per chunk so spikes stay visible on the chart. The chunk
  // width rounds up so the trend never exceeds MAX_TREND_POINTS.
  const trend: SentimentPoint[] = [];
  const step = Math.max(1, Math.ceil(lines.length / MAX_TREND_POINTS));
  for (let i = 0; i < lines.length; i += step) {
    const chunk = lines.slice(i, i + step);
    const chunkTotal = chunk.reduce((sum, line) => sum + line.score, 0);
    let extreme = chunk[0];
    for (const line of chunk) {
      if (Math.abs(line.score) > Math.abs(extreme.score)) extreme = line;
    }
    trend.push({ index: i, score: chunkTotal / chunk.length, emotion: extreme.emotion });
  }

  return {
    averageScore,
    bucket: sentimentBucket(averageScore),
    bucketCounts,
    emotionDistribution,
    trend,
  };
}

// Human-readable metadata for the transcript search index. Keeping the alias
// mapping beside the classifier prevents an analysis label and its retrieval
// aliases from drifting apart.
export function searchableMetadata(emotion: EmotionLabel, score: number): string {
  const emotionTerms = [emotion as string].concat(SEARCH_ALIASES[emotion]);
  let sentimentTerms: string[];
  switch (sentimentBucket(score)) {
    case "veryPositive":
      sentimentTerms = ["very positive", "positive sentiment"];
      break;
    case "positive":
      sentimentTerms = ["positive", "positive sentiment"];
      break;
    case "neutral":
      sentimentTerms = ["neutral", "neutral sentiment"];
      break;
    case "negative":
      sentimentTerms = ["negative", "negative sentiment"];
      break;
    case "veryNegative":
      sentimentTerms = ["very negative", "negative sentiment"];
      break;
  }
  return emotionTerms.concat(sentimentTerms).join(" ");
}

// Infer an exact emotion filter from ordinary search language. Returns null
// for no emotion or multiple distinct emotions so compound requests can fall
// back to normal ranked retrieval.
export function inferredEmotionFilter(query: string): EmotionLabel | null {
  const tokens = emotionTokens(query);
  const matches: EmotionLabel[] = [];
  for (const emotion of EMOTION_ORDER) {
    if (emotion === "neutral") continue;
    const patterns = dedupe([emotion as string].concat(INFERRED_FILTER_ALIASES[emotion]));
    if (patterns.some((pattern) => containsNonNegatedPattern(pattern, tokens))) {
      matches.push(emotion);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
