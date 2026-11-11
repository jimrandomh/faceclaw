const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const { pcmLevel } = loader()('app/util/audio-level.ts');

function harness() {
  const levelListeners = new Set();
  let tick = null;
  const { MicLevelMeter, paintListeningHeader, RECORDING_ICON, withRecordingIcon } = loader({
    setInterval(fn) { tick = fn; return 1; },
    clearInterval() { tick = null; },
  }, {
    '../native/voice-control': { voiceControlBridge: {
      onMicLevel(listener) { levelListeners.add(listener); return () => levelListeners.delete(listener); },
    } },
  })('app/ui/listening-header.ts');
  const level = value => { for (const listener of levelListeners) listener(value); };
  return { MicLevelMeter, paintListeningHeader, RECORDING_ICON, withRecordingIcon, level, tick: () => tick?.(), ticking: () => tick !== null, levelListeners };
}

/** Records draws; text is 6px per character, like a fixed-width bitmap face. */
function fakeImage(width = 576) {
  const texts = [], rects = [], images = [];
  return { width, texts, rects, images,
    drawText(_font, x, y, text, gray) { texts.push({ x, y, text, gray }); },
    drawImage(source, x, y) { images.push({ source, x, y }); },
    fillRect(x, y, w, h, gray) { rects.push({ x, y, w, h, gray }); } };
}
const font = { ascent: 12, lineHeight: 16, measureText: text => text.length * 6 };

function pcm(amplitude, samples = 800) {
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = (i % 2 ? amplitude : -amplitude) & 0xffff;
    bytes[i * 2] = value & 255;
    bytes[i * 2 + 1] = value >> 8;
  }
  return bytes;
}

test('pcm level maps RMS onto a 60 dB meter', () => {
  assert.equal(pcmLevel(new Uint8Array(0)), 0);
  assert.equal(pcmLevel(pcm(0)), 0);
  assert.ok(Math.abs(pcmLevel(pcm(3277)) - 2 / 3) < 0.01, '-20 dBFS sits two thirds up');
  assert.ok(pcmLevel(pcm(32767)) > 0.99);
});

test('the meter repaints only when the lit segment count changes, and only while visible', () => {
  const h = harness();
  const meter = new h.MicLevelMeter();
  let renders = 0, visible = true;
  meter.start(() => renders++, () => visible);
  h.level(0.3); h.level(0.5); h.level(0.2);
  h.tick();
  assert.equal(renders, 1, 'the peak of the tick lights 4 of 8');
  h.level(0.5); h.tick();
  assert.equal(renders, 1, 'same segment count, no repaint');

  // Off screen the level still tracks, so the next visible paint is current.
  visible = false;
  h.level(1); h.tick();
  assert.equal(renders, 1);
  const image = fakeImage();
  meter.paint(image, 0, 10, 6);
  assert.equal(image.rects.filter(rect => rect.gray === 200).length, 8);

  // Silence decays the meter to empty within about a second.
  visible = true;
  for (let i = 0; i < 5; i++) h.tick();
  const after = fakeImage();
  meter.paint(after, 0, 10, 6);
  assert.equal(after.rects.filter(rect => rect.gray === 200).length, 0);
  assert.ok(renders > 1);

  meter.stop();
  assert.equal(h.ticking(), false);
  assert.equal(h.levelListeners.size, 0);
});

test('the header puts title and status on one line, truncated before the meter', () => {
  const h = harness();
  const meter = new h.MicLevelMeter();
  const image = fakeImage(300);
  const bodyTop = h.paintListeningHeader(image, font, 'Translate', 'Listening (ElevenLabs)...', meter);
  assert.equal(bodyTop, 20 + 18 + 2);
  assert.deepEqual(image.texts.map(({ x, y, gray }) => [x, y, gray]), [[24, 20, 200], [24 + 54, 20, 110]]);
  assert.equal(image.texts[0].text, 'Translate');
  const status = image.texts[1].text;
  assert.ok(status.startsWith(' · Listening') && status.endsWith('...'), status);
  const meterX = Math.min(...image.rects.map(rect => rect.x));
  assert.equal(meterX, 300 - 24 - meter.width);
  assert.ok(24 + 54 + status.length * 6 <= meterX - 10, 'status stops short of the meter');
  // Segments sit on the text baseline.
  assert.ok(image.rects.every(rect => rect.y + rect.h === 20 + font.ascent));

  assert.equal(image.images.length, 0, 'no recording circle unless the audio is being saved');

  const idle = fakeImage(300);
  h.paintListeningHeader(idle, font, 'Transcribe', 'Starting microphone...', null);
  assert.equal(idle.rects.length, 0);
  assert.equal(idle.texts[1].text, ' · Starting microphone...');
});

test('while the audio is being saved, the recording circle sits beside the meter', () => {
  const h = harness();
  const meter = new h.MicLevelMeter();
  const image = fakeImage(300);
  h.paintListeningHeader(image, font, 'Translate', 'Listening (ElevenLabs)...', meter, true);
  const meterX = Math.min(...image.rects.map(rect => rect.x));
  assert.equal(meterX, 300 - 24 - meter.width, 'the meter stays where it was');
  assert.equal(image.images.length, 1);
  const [circle] = image.images;
  assert.equal(circle.source, h.RECORDING_ICON);
  assert.equal(circle.x + circle.source.width + 4, meterX);
  // Centred on the meter, whose 7 rows sit on the text baseline.
  const meterTop = Math.min(...image.rects.map(rect => rect.y));
  assert.equal(circle.y + circle.source.height / 2, meterTop + 7 / 2);
  const status = image.texts[1].text;
  assert.ok(24 + 54 + status.length * 6 <= circle.x - 10, 'status stops short of the circle');

  // The mic isn't live (starting, or waiting for the glasses): nothing is being saved to mark.
  const idle = fakeImage(300);
  h.paintListeningHeader(idle, font, 'Transcribe', 'Starting microphone...', null, true);
  assert.equal(idle.images.length, 0);
});

test('a tray icon gains the recording circle to its right, vertically centred', () => {
  const h = harness();
  const { GrayImage } = loader()('app/graphics/image.ts');
  const mic = new GrayImage(14, 15, 0);
  mic.setPixel(0, 0, 200); mic.setPixel(13, 14, 200);
  const icon = h.withRecordingIcon(mic);
  assert.deepEqual([icon.width, icon.height], [14 + 2 + 9, 15]);
  assert.deepEqual([icon.getPixel(0, 0), icon.getPixel(13, 14)], [200, 200]);
  assert.deepEqual([icon.getPixel(14, 7), icon.getPixel(15, 7)], [0, 0], 'a gap separates them');
  // The circle's widest row is the icon's middle row; its corners are clear.
  for (let x = 16; x < 25; x++) assert.equal(icon.getPixel(x, 7), 220);
  assert.deepEqual([icon.getPixel(16, 3), icon.getPixel(20, 3), icon.getPixel(20, 2), icon.getPixel(20, 12)], [0, 220, 0, 0]);
});
