const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const { parseArgs } = require('../scripts/faceclaw-input.cjs');
const { TokenStore, handleRequest } = require('../.test-build/app/remote/protocol.js');

function evaluate(source, context) {
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
}
test('CLI text and text -n reach the real terminal client with exactly one Enter or none', async () => {
  const sent = [], native = { exports: {}, require: () => ({}), global: { isIOS: true }, NSUTF8StringEncoding: 4,
    NSString: { stringWithString: text => ({ lengthOfBytesUsingEncoding: () => Buffer.byteLength(text),
      dataUsingEncoding: () => ({ base64EncodedStringWithOptions: () => Buffer.from(text).toString('base64') }) }) } };
  evaluate(fs.readFileSync('app/native/g2mirror-client.ts', 'utf8'), native);
  const client = new native.exports.G2MirrorClient({});
  client.ws = { sendText: json => sent.push(JSON.parse(json)) };
  client.handleMessage(JSON.stringify({ type: 'connect', command: 'test' }));
  // Run the production worker message handler, without starting its network/render loops.
  const source = ts.createSourceFile('worker.ts', fs.readFileSync('app/apps/terminal/terminal-app.worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const handler = source.statements.find(node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === 'global.onmessage');
  assert.ok(handler);
  const worker = { global: {}, windows: new Map([['terminal', { kind: 'view', client }]]) };
  evaluate(handler.getText(source), worker);
  let stored = '[]';
  const tokens = new TokenStore(() => stored, value => { stored = value; }, () => 'a'.repeat(64),
    value => crypto.createHash('sha256').update(value).digest('hex'));
  const { token } = tokens.create('CLI', ['text']);
  const host = { ready: () => true, locked: () => false, acceptsText: () => true,
    text: (text, submit) => worker.global.onmessage({ data: { type: 'text-input', windowId: 'terminal', text, submit } }) };
  for (const noSubmit of [false, true]) {
    const text = 'café 世界';
    const args = parseArgs(['text', ...(noSubmit ? ['-n'] : []), text], { FACECLAW_TOKEN: token });
    assert.equal((await handleRequest(JSON.stringify({ version: 1, token, ...args.payload }), tokens, host)).ok, true);
    const message = sent.at(-1);
    assert.equal(Buffer.from(message.data, 'base64').toString('utf8'), text + (noSubmit ? '' : '\r'));
    assert.equal(message.delays === undefined, noSubmit);
  }
});
