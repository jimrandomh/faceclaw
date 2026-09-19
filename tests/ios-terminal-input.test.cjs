const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, context) {
  const sandbox = { exports: {}, ...context };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  return sandbox.exports;
}
test('iOS Type Into App submits UTF-8 terminal text and delays Enter at the byte boundary without Java', () => {
  const sent = [];
  const { G2MirrorClient } = load('app/native/g2mirror-client.ts', {
    require: () => ({}), global: { isIOS: true }, NSUTF8StringEncoding: 4,
    NSString: { stringWithString: text => ({
      lengthOfBytesUsingEncoding: () => Buffer.byteLength(text, 'utf8'),
      dataUsingEncoding: () => ({ base64EncodedStringWithOptions: () => Buffer.from(text).toString('base64') }),
    }) },
  });
  const client = new G2MirrorClient({});
  client.ws = { sendText: json => sent.push(JSON.parse(json)) };
  client.handleMessage(JSON.stringify({ type: 'connect', command: 'test' }));
  const { VoiceInputLayer } = load('app/ui/shell/voice-input.ts', {
    require: id => id.includes('voice-control') ? { voiceControlBridge: { stop() {} } }
      : id.includes('dashboard-settings') ? { anthropicApiKeySetting: { get: () => '' } } : {},
    global: { isIOS: true },
  });
  for (const text of ['hello terminal', 'café π 🔋', 'line one\n第二行', '']) {
    let closed = false;
    const layer = new VoiceInputLayer({ actions: { requestRender() {} }, onClosed() {},
      dismiss() { closed = true; layer.onRemoved(); }, sendTargets: [{ id: 'app', label: 'Type Into App', onSend: value => client.submitInput(value) }] });
    layer.onTranscript({ text, isFinal: true });
    const count = sent.length;
    layer.menuRows()[0].onSelect();
    assert.equal(closed, true);
    if (!text) { assert.equal(sent.length, count); continue; }
    const message = sent.at(-1);
    assert.equal(message.type, 'input');
    assert.equal(Buffer.from(message.data, 'base64').toString('utf8'), text + '\r');
    assert.deepEqual(message.delays, [{ at: Buffer.byteLength(text), ms: 150 }]);
  }
});
