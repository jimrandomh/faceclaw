const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { interactive } = require('../scripts/faceclaw-input.cjs');
const { createEditor } = require('../scripts/faceclaw-input-editor.cjs');

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for interactive state');
}
async function fixture(t, transmit) {
  const input = new PassThrough(), output = new PassThrough(), modes = [], requests = [];
  let printed = '', stopped = false;
  input.isTTY = output.isTTY = true; input.isRaw = false; output.columns = 100;
  input.setRawMode = value => { input.isRaw = value; modes.push(value); };
  output.on('data', data => { printed += data.toString(); });
  const task = interactive({}, input, output, async (_options, payload) => {
    requests.push(payload); if (transmit) return transmit(payload);
  }).then(() => { stopped = true; });
  t.after(async () => { if (!stopped) input.write('\x03'); await task; input.destroy(); output.destroy(); });
  await until(() => printed.includes('Connected.'));
  return { input, requests, modes, task, printed: () => printed, stopped: () => stopped,
    messages: () => requests.filter(r => r.action !== 'ping') };
}

test('i composes with Enquirer editing and sends text once; editing keys never become gestures', async t => {
  const f = await fixture(t);
  // Start and type in one input chunk. Left/right, delete/backspace, Ctrl-A/E,
  // and Ctrl-W exercise the actual Enquirer input editor, not a stub.
  f.input.write('ihello worxd\x1b[D\x1b[D\x1b[3~l\x1b[CX\x7f\x05!\x01Say \x05 extra\x17\r');
  await until(() => f.messages().length === 1);
  assert.deepEqual(f.messages(), [{ action: 'text', text: 'Say hello world!' }]);
  assert.match(f.printed(), /Sent to foreground window/);
  f.input.write('\x1b[A');
  await until(() => f.messages().length === 2);
  assert.deepEqual(f.messages()[1], { action: 'input', gesture: 'swipe-up', source: 'watch' });
});

test('a sends to assistant and i/a remain literal while composing; Unicode is preserved', async t => {
  const f = await fixture(t);
  f.input.write('aAssistant: café 世界 👋 i a\r');
  await until(() => f.messages().length === 1);
  assert.deepEqual(f.messages(), [{ action: 'assistant', text: 'Assistant: café 世界 👋 i a' }]);
});

test('Esc discards and clears a draft, then returns to controls with a fresh next draft', async t => {
  const f = await fixture(t);
  f.input.write('isecret draft\t\x1b[A\x1b[B');
  await until(() => f.printed().includes('secret draft'));
  f.input.write('\x1b');
  await until(() => f.printed().includes('Draft discarded.'));
  assert.deepEqual(f.messages(), []);
  f.input.write('a\r');
  await until(() => f.printed().includes('Empty draft; nothing sent.'));
  assert.deepEqual(f.messages(), []);
  f.input.write('\r');
  await until(() => f.messages().length === 1);
  assert.deepEqual(f.messages()[0], { action: 'input', gesture: 'click', source: 'watch' });
  f.input.write('ifresh\r');
  await until(() => f.messages().length === 2);
  assert.equal(f.messages()[1].text, 'fresh');
});

test('Ctrl-C while composing clears the prompt and restores raw mode without sending a draft', async t => {
  const f = await fixture(t);
  f.input.write('aunfinished');
  await until(() => f.printed().includes('unfinished'));
  f.input.write('\x03'); await f.task;
  assert.deepEqual(f.messages(), []);
  assert.deepEqual(f.modes, [true, false]);
  assert.equal(f.input.listenerCount('keypress'), 0);
});

test('composition-only token works without input permission and a rejected text does not kill the session', async t => {
  let rejectText = true;
  const f = await fixture(t, payload => {
    assert.notEqual(payload.permission, 'input');
    if (payload.action === 'text' && rejectText) {
      rejectText = false;
      throw Object.assign(new Error('Token lacks text permission.'), { code: 'forbidden' });
    }
  });
  f.input.write('ino access\r');
  await until(() => f.printed().includes('Token lacks text permission.'));
  assert.equal(f.stopped(), false);
  f.input.write('aallowed\r');
  await until(() => f.printed().includes('Sent to assistant.'));
  assert.deepEqual(f.messages(), [{ action: 'text', text: 'no access' }, { action: 'assistant', text: 'allowed' }]);
});

test('editor validates the API length limit and lets the user fix the draft', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.columns = 80;
  let printed = ''; output.on('data', data => { printed += data; });
  const editor = createEditor('text', input, output);
  editor.keypress('x'.repeat(8001), {}); editor.keypress('\r', { name: 'return' });
  await until(() => printed.includes('Maximum 8000 characters.'));
  editor.keypress('\x01', { name: 'a', ctrl: true });
  editor.keypress('\x0b', { name: 'k', ctrl: true });
  editor.keypress('valid', {}); editor.keypress('\r', { name: 'return' });
  assert.equal(await editor.result, 'valid');
  input.destroy(); output.destroy();
});
