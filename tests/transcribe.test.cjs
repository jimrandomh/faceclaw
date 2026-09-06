const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const load = loader();
const { TranscriptModel, TranscriptScroll, wrapTranscribeText } = load('app/apps/transcribe/transcript-model.ts');
const { SpeechPauseDetector } = load('app/native/speech-pause.ts');
const { TimedTranscript } = load('app/native/transcript-format.ts');

function pcm(amplitude, ms = 50) {
  const bytes = new Uint8Array(ms * 16 * 2);
  for (let i = 0; i < bytes.length; i += 2) {
    bytes[i] = amplitude & 255;
    bytes[i + 1] = (amplitude >> 8) & 255;
  }
  return bytes;
}

test('partials replace, finals correct, and pause breaks survive display and saving', () => {
  const m = new TranscriptModel();
  m.accept({ text: 'Hello wor', isFinal: false });
  m.accept({ text: 'Hello world.', isFinal: true, paragraphBreakAfter: true });
  m.accept({ text: 'Next', isFinal: false });
  m.accept({ text: 'Next paragraph.', isFinal: false });
  assert.equal(m.text, 'Hello world.\nNext paragraph.');
  m.accept({ text: 'Next paragraph!', isFinal: true });
  assert.equal(m.text, 'Hello world.\nNext paragraph!');
  m.accept({ text: '', isFinal: true });
  assert.equal(m.text, 'Hello world.\nNext paragraph!');
});

test('onboard pauses can precede or follow finalization', () => {
  for (const before of [true, false]) {
    const m = new TranscriptModel();
    m.accept({ text: 'first', isFinal: false });
    if (before) m.pause();
    m.accept({ text: 'First.', isFinal: true });
    if (!before) m.pause();
    m.accept({ text: 'Second.', isFinal: false });
    assert.equal(m.text, 'First.\nSecond.');
  }
});

test('formatting metadata is used only by Transcribe, with revisable live speaker tokens', () => {
  const final = new TimedTranscript();
  final.append({ text: 'Hello.', start_ms: 0, end_ms: 500, speaker: '1' });
  const preview = final.copy();
  preview.append({ text: ' Wrong', start_ms: 600, end_ms: 900, speaker: '2' });
  assert.equal(preview.text, 'Hello.\nWrong');
  assert.equal(final.text, 'Hello.');
  final.append({ text: ' Right.', start_ms: 600, end_ms: 900, speaker: '1' });
  final.append({ text: ' Later.', start_ms: 2400, end_ms: 2800, speaker: '1' });
  assert.equal(final.text, 'Hello. Right.\nLater.');
  const event = { text: 'Hello. Right. Later.', transcribeText: final.text, isFinal: false };
  const m = new TranscriptModel();
  m.accept(event);
  assert.equal(m.text, final.text);
  assert.equal(event.text.includes('\n'), false);
});

test('wrapping preserves explicit newlines, blank paragraphs, and long unspaced words', () => {
  assert.deepEqual([...wrapTranscribeText(s => s.length, 'one two\nthree\n\nabcdefghij', 5)],
    ['one', 'two', 'three', '', 'abcde', 'fghij']);
});

test('scroll follows the tail until scrolled back, then resumes only at the bottom', () => {
  const s = new TranscriptScroll();
  assert.equal(s.layout(30, 10), 20);
  assert.equal(s.layout(33, 10), 23);
  s.scroll(-3);
  assert.equal(s.layout(50, 10), 20);
  assert.equal(s.layout(51, 10), 20);
  s.scroll(100);
  assert.equal(s.layout(55, 10), 45);
  s.scroll(-100);
  assert.equal(s.layout(60, 10), 0);
});

test('short transcripts become scrollable without disabling automatic following', () => {
  const s = new TranscriptScroll();
  assert.equal(s.layout(3, 10), 0);
  s.scroll(-3);
  assert.equal(s.layout(12, 10), 2);
});

test('pause detector uses 1.5 seconds of PCM, fires once per pause, and ignores leading silence', () => {
  const d = new SpeechPauseDetector();
  for (let i = 0; i < 60; i++) assert.equal(d.accept(pcm(0)), false);
  d.accept(pcm(3000));
  for (let i = 0; i < 29; i++) assert.equal(d.accept(pcm(0)), false);
  assert.equal(d.accept(pcm(0)), true);
  for (let i = 0; i < 60; i++) assert.equal(d.accept(pcm(0)), false);
  d.accept(pcm(3000));
  assert.equal(d.accept(pcm(0, 1500)), true);
});
