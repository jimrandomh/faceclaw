const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The visualizer's JavaScript replays recordings the Kotlin tests produced (ScreenRecorderTest,
// GlassesSessionCoreTest; scripts/update-screen-recording-fixtures.sh refreshes them) and must
// arrive at the pictures the phone's reference renderer did.
const Emulator = require('../tools/screen-recording-visualizer/emulator.js');
const Recording = require('../tools/screen-recording-visualizer/recording.js');

const fixtures = path.join(__dirname, 'fixtures/screen-recording');
const load = name => Recording.load(new Uint8Array(fs.readFileSync(path.join(fixtures, name))));

/** Every lens played to the end of the recording. */
function play(recording) {
  return recording.createLenses().map((lens, index) => {
    const player = new Emulator.Player(lens, recording.ops[index]);
    player.seek(recording.ops[index].length);
    assert.deepEqual([...player.errors], [], 'no message was rejected');
    return player;
  });
}

function differing(a, b) {
  assert.equal(a.length, b.length);
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] >> 4) !== (b[i] >> 4)) count++;
    if ((a[i] & 15) !== (b[i] & 15)) count++;
  }
  return count;
}

test('every draw opcode replays to the reference renderer\'s pixels on both lenses', async () => {
  const recording = await load('opcodes.fcrec.jsonl');
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'opcodes.expected.json'), 'utf8'));
  const bytes = name => Recording.base64(expected[name]);
  assert.equal(recording.width, expected.width);
  assert.equal(recording.height, expected.height);
  const [left, right] = play(recording);
  assert.equal(differing(left.lens.screen, bytes('leftScreen')), 0, 'left screen buffer');
  assert.equal(differing(right.lens.screen, bytes('rightScreen')), 0, 'right screen buffer');
  // The root list's highlight slides for 200 ms after PRESENT, then rests.
  const presented = left.lens.presented.t;
  assert.equal(differing(left.lens.display(presented).pixels, bytes('left')), 0, 'left at present');
  assert.equal(differing(left.lens.display(presented + 100).pixels, bytes('leftAt100ms')), 0, 'left mid-animation');
  assert.ok(left.lens.display(presented + 100).animationPending);
  assert.equal(differing(left.lens.display(presented + 5000).pixels, bytes('leftSettled')), 0, 'left settled');
  assert.equal(differing(left.lens.display(null).pixels, bytes('leftSettled')), 0);
  assert.ok(!left.lens.display(null).animationPending);
  assert.equal(differing(right.lens.display(null).pixels, bytes('rightSettled')), 0, 'right settled');
  assert.ok(differing(bytes('leftSettled'), bytes('rightSettled')) > 0);
  assert.ok(!left.lens.resources.has(4), 'evicted');
});

test('seeking lands on the same state as playing straight through', async () => {
  const recording = await load('opcodes.fcrec.jsonl');
  const ops = recording.ops[0];
  const straight = [];
  const lens = recording.createLenses()[0];
  const player = new Emulator.Player(lens, ops, { interval: 2 });
  for (let position = 0; position <= ops.length; position++) {
    player.seek(position);
    straight.push({ screen: lens.screen.slice(), shown: lens.display(null).pixels });
  }
  for (const position of [ops.length, 0, 5, 3, 4, ops.length - 1, 1, ops.length]) {
    player.seek(position);
    assert.equal(differing(lens.screen, straight[position].screen), 0, 'screen at ' + position);
    assert.equal(differing(lens.display(null).pixels, straight[position].shown), 0, 'display at ' + position);
  }
  // Nothing is shown differently until a PRESENT, whatever was drawn meanwhile.
  const firstPresent = ops.findIndex(op => (op.payload[0] & 127) === Emulator.MSG.PRESENT);
  assert.ok(firstPresent > 3);
  assert.equal(differing(straight[firstPresent].shown, straight[0].shown), 0);
  assert.ok(differing(straight[firstPresent].screen, straight[0].screen) > 0);
  assert.ok(differing(straight[firstPresent + 1].shown, straight[0].shown) > 0);
  assert.equal(player.positionAt(ops[firstPresent].t - 1), firstPresent);
  assert.equal(player.positionAt(ops[firstPresent].t), firstPresent + 1);
});

test('a session recording replays to the phone\'s own composites', async () => {
  const recording = await load('session.fcrec.jsonl');
  assert.equal(recording.header.glasses, 'g2');
  assert.ok(recording.replayable);
  assert.equal(recording.screens.length, 2);
  const [first, last] = recording.screens;
  // The starting state alone is the first composite; the messages lead to the last.
  const lenses = recording.createLenses();
  assert.equal(differing(lenses[0].display(null).pixels, first.pixels), 0, 'starting state');
  const [left, right] = play(recording);
  assert.equal(differing(left.lens.display(null).pixels, last.pixels), 0, 'left lens at the end');
  assert.equal(differing(right.lens.display(null).pixels, last.pixels), 0, 'right lens at the end');
  assert.ok(differing(first.pixels, last.pixels) > 0);
  assert.equal(recording.screenAt(recording.t0), first);
  assert.equal(recording.screenAt(recording.t1), last);

  // Where the pixels came from: the app's frame as screen pixels, the shell layer as a surface.
  const { origin } = left.lens.display(null);
  const at = (x, y) => origin[y * recording.width + x];
  assert.equal(at(37, 1), Emulator.ORIGIN.PIXELS);
  assert.equal(at(8 + 20, 2 + 3), Emulator.ORIGIN.SURFACE);
});

test('messages are decoded into where their bytes went, and tied to their frames', async () => {
  const recording = await load('session.fcrec.jsonl');
  const { CATEGORY } = Recording;
  const display = recording.messages.filter(message => message.kind === 'resources' || message.kind === 'image');
  assert.ok(display.length >= 4);
  for (const message of display) {
    assert.equal(message.items.reduce((sum, item) => sum + item.bytes, 0), message.bytes, message.name);
    assert.ok(message.ackT >= message.t);
    assert.ok(message.lensAcks[0] !== null && message.lensAcks[1] !== null);
    assert.ok(recording.framesById.get(message.frame).messages.includes(message));
  }
  const texts = display.flatMap(message => message.items.map(item => item.text));
  assert.ok(texts.some(text => /^pixels \d+×\d+ at \d+,\d+$/.test(text)), texts.join('; '));
  assert.ok(texts.some(text => /^pixels \d+×6 at 0,0 → #\d+$/.test(text)), texts.join('; '));
  assert.ok(texts.some(text => /^upload display list #\d+$/.test(text)), texts.join('; '));
  assert.ok(texts.includes('present'));

  const totals = Recording.totals(recording);
  const row = key => totals.rows.find(entry => entry.key === key);
  assert.ok(row('screen').payload > 0 && row('surface').payload > 0 && row('lists').payload > 0);
  assert.equal(row('fonts').payload, 0);
  assert.equal(Math.round(totals.rows.reduce((sum, entry) => sum + entry.wire, 0)), totals.wire);
  assert.equal(totals.rows.reduce((sum, entry) => sum + entry.payload, 0), totals.payload);
  assert.equal(totals.payload, recording.messages.reduce((sum, message) => sum + message.bytes, 0));
  const buckets = Recording.buckets(recording, recording.t0, recording.t1 + 1, 7);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.total, 0), totals.wire);
  assert.equal(display[0].category, CATEGORY.SCREEN);

  // The two frames: an input and the shell render it caused, both sent.
  assert.equal(recording.roots.length, 1);
  const [input] = recording.roots;
  assert.match(input.reason, /^input:test tap/);
  assert.equal(input.children.length, 1);
  assert.equal(input.children[0].outcome, 'sent');
  assert.ok(input.sentT > input.t && input.treeEndT >= input.children[0].endT);
  assert.ok(input.lines.some(line => line.span && line.span.name === 'composite'));
  const latency = Recording.latency(recording);
  assert.equal(latency.input.count, 1);
  assert.equal(latency.input.p50, input.sentT - input.t);
  assert.equal(latency.sent, 2);
  assert.ok(recording.logs.some(line => line.text.startsWith('queue image update#')));
});

test('files that are not recordings, or are from a newer format, are refused with a reason', () => {
  assert.throws(() => Recording.parse('{"type":"log"}\n'), /Not a Faceclaw screen recording/);
  assert.throws(() => Recording.parse('GIF89a'), /not JSON|Not a Faceclaw/);
  assert.throws(() => Recording.parse('{"type":"header","format":"faceclaw-screen-recording","version":99,"t":0}\n'), /version 99/);
  // A recording cut off mid-line (the app died while saving) still opens.
  const cut = Recording.parse('{"type":"header","format":"faceclaw-screen-recording","version":1,"t":5,"width":4,"height":2}\n{"type":"log","t":9,"text":"x"}\n{"type":"lo');
  assert.equal(cut.logs.length, 1);
  assert.equal(cut.t1, 9);
  assert.ok(!cut.replayable);
});

test('a rejected message is reported and leaves the display as it was', () => {
  const lens = new Emulator.Lens(false);
  lens.resize(8, 2);
  const draw = (...call) => new Uint8Array([26, 1, 0, call.length, 0, ...call]);
  const ops = [
    { t: 1, payload: draw(9, 0, 7) },                // clear to 7
    { t: 2, payload: new Uint8Array([28]) },
    { t: 3, payload: draw(4, 0, 9, 0, 0, 0, 15) },   // image #9, which was never uploaded
    { t: 4, payload: new Uint8Array([27, 9, 0]) },   // root #9: the same missing resource
    { t: 5, payload: new Uint8Array([28]) },
  ];
  const player = new Emulator.Player(lens, ops).seek(ops.length);
  assert.deepEqual([...player.errors.keys()], [2, 4]);
  assert.match(player.errors.get(2), /Missing resource 9/);
  assert.deepEqual([...lens.display(null).pixels], [0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77]);
});
