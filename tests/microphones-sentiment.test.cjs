// These pin the parts the transcript UI depends on: keyword emotion hits with
// negation scoping, lexicon polarity signs, the 5-bucket thresholds, the
// summary rollup with its 60-point trend cap, and the search alias mappings.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectEmotion,
  scoreSentiment,
  sentimentBucket,
  analyzeLine,
  summarize,
  searchableMetadata,
  inferredEmotionFilter,
} = require("../.test-build/app/apps/microphones/sentiment.js");

test("keyword emotion hits", () => {
  assert.equal(detectEmotion("this keeps failing").emotion, "frustrated");
  assert.equal(detectEmotion("I am so worried about tomorrow").emotion, "anxious");
  assert.equal(detectEmotion("what a relief, thank goodness").emotion, "relieved");
  assert.equal(detectEmotion("that's disgusting").emotion, "disgusted");
  assert.equal(detectEmotion("enough is enough, this is unacceptable").emotion, "angry");
});

test("keyword hits carry the keyword source and calibrated confidence", () => {
  const single = detectEmotion("this keeps failing");
  assert.equal(single.source, "keyword");
  assert.equal(single.confidence, 0.7);

  const double = detectEmotion("I am frustrated and annoyed");
  assert.equal(double.emotion, "frustrated");
  assert.equal(double.confidence, 0.88);
});

test("whole words only: mad must not match made", () => {
  assert.equal(detectEmotion("we made a decision yesterday").emotion, "neutral");
});

test("negated cues are ignored", () => {
  const detection = detectEmotion("I'm not happy about this");
  assert.notEqual(detection.emotion, "happy");
  assert.ok(scoreSentiment("I'm not happy about this") < 0);
});

test("a contrast boundary ends the negation scope", () => {
  // "not happy, but angry" expresses anger: the negation before "but" must
  // not suppress the cue after it.
  assert.equal(detectEmotion("I am not happy, but angry").emotion, "angry");
});

test("equal evidence for two emotions stays neutral", () => {
  const detection = detectEmotion("I am happy and sad");
  assert.equal(detection.emotion, "neutral");
  assert.equal(detection.confidence, 0.4);
});

test("polarity signs", () => {
  assert.ok(scoreSentiment("This is great and wonderful") > 0);
  assert.ok(scoreSentiment("That was awful and terrible") < 0);
  assert.equal(scoreSentiment("The meeting starts at noon"), 0);
  assert.equal(scoreSentiment(""), 0);
});

test("negation flips polarity in scoring", () => {
  assert.ok(scoreSentiment("This is not good") < 0);
  assert.ok(scoreSentiment("This is not bad") > 0);
});

test("scores stay in [-1, 1]", () => {
  assert.ok(scoreSentiment("great great great great great great") <= 1);
  assert.ok(scoreSentiment("awful awful awful awful awful awful") >= -1);
});

test("sentences are scored independently and averaged", () => {
  const mixed = scoreSentiment("This is wonderful! This is terrible.");
  assert.equal(mixed, 0);
});

test("bucket edges", () => {
  assert.equal(sentimentBucket(0.31), "veryPositive");
  assert.equal(sentimentBucket(0.3), "positive");
  assert.equal(sentimentBucket(0.11), "positive");
  assert.equal(sentimentBucket(0.1), "neutral");
  assert.equal(sentimentBucket(0), "neutral");
  assert.equal(sentimentBucket(-0.1), "neutral");
  assert.equal(sentimentBucket(-0.11), "negative");
  assert.equal(sentimentBucket(-0.3), "negative");
  assert.equal(sentimentBucket(-0.31), "veryNegative");
});

test("analyzeLine combines score and emotion", () => {
  const line = analyzeLine("this keeps failing");
  assert.equal(line.emotion, "frustrated");
  assert.ok(line.score < 0);
  assert.equal(line.emotionConfidence, 0.7);
});

test("summarize counts buckets and emotions", () => {
  const lines = [
    { score: 0.8, emotion: "happy", emotionConfidence: 0.9 },
    { score: 0.2, emotion: "happy", emotionConfidence: 0.7 },
    { score: 0, emotion: "neutral", emotionConfidence: 0.76 },
    { score: -0.2, emotion: "frustrated", emotionConfidence: 0.7 },
    { score: -0.8, emotion: "angry", emotionConfidence: 0.9 },
  ];
  const summary = summarize(lines);
  assert.equal(summary.averageScore, 0);
  assert.equal(summary.bucket, "neutral");
  assert.deepEqual(summary.bucketCounts, {
    veryPositive: 1,
    positive: 1,
    neutral: 1,
    negative: 1,
    veryNegative: 1,
  });
  assert.deepEqual(summary.emotionDistribution, { happy: 2, neutral: 1, frustrated: 1, angry: 1 });
  assert.equal(summary.trend.length, 5);
  assert.deepEqual(summary.trend.map((p) => p.index), [0, 1, 2, 3, 4]);
});

test("summarize of nothing is neutral and empty", () => {
  const summary = summarize([]);
  assert.equal(summary.averageScore, 0);
  assert.equal(summary.bucket, "neutral");
  assert.deepEqual(summary.trend, []);
  assert.deepEqual(summary.emotionDistribution, {});
});

test("trend caps at 60 points and keeps the extreme emotion per chunk", () => {
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push({ score: 0.1, emotion: "calm", emotionConfidence: 0.7 });
  }
  // A spike inside a chunk must survive downsampling as that chunk's emotion.
  lines[10] = { score: -0.9, emotion: "angry", emotionConfidence: 0.9 };
  const summary = summarize(lines);
  assert.ok(summary.trend.length <= 60);
  assert.ok(summary.trend.length > 0);
  assert.ok(summary.trend.some((p) => p.emotion === "angry"));
  // Chunk averages must still reflect the spike rather than drop it.
  const spikeChunk = summary.trend.find((p) => p.emotion === "angry");
  assert.ok(spikeChunk.score < 0.1);
});

test("searchableMetadata contains aliases and sentiment terms", () => {
  const angry = searchableMetadata("angry", -0.5);
  for (const alias of ["angry", "mad", "furious", "rage", "hostile"]) {
    assert.ok(angry.includes(alias), `missing alias: ${alias}`);
  }
  assert.ok(angry.includes("very negative"));
  assert.ok(angry.includes("negative sentiment"));

  const sad = searchableMetadata("sad", -0.2);
  assert.ok(sad.includes("upset"));
  assert.ok(sad.includes("negative sentiment"));

  const happy = searchableMetadata("happy", 0.5);
  assert.ok(happy.includes("joyful"));
  assert.ok(happy.includes("very positive"));
});

test("inferredEmotionFilter parses natural-language queries", () => {
  assert.equal(inferredEmotionFilter("show me conversations where the speaker was angry"), "angry");
  assert.equal(inferredEmotionFilter("meetings where someone was fed up"), "frustrated");
  assert.equal(inferredEmotionFilter("find the joyful moments"), "happy");
  assert.equal(inferredEmotionFilter("what did we discuss about the budget"), null);
});

test("inferredEmotionFilter rejects ambiguity and negation", () => {
  // Ambiguous aliases such as "mad" and "sure" must not hijack searches.
  assert.equal(inferredEmotionFilter("the mad scientist presentation"), null);
  assert.equal(inferredEmotionFilter("are you sure about the numbers"), null);
  // Two distinct emotions fall back to normal ranked retrieval.
  assert.equal(inferredEmotionFilter("happy or sad conversations"), null);
  // A negated emotion is not a request for that emotion.
  assert.equal(inferredEmotionFilter("the speaker was not angry"), null);
});
