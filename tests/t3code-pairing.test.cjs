const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePairingInput, baseUrlLabel } = require('../.test-build/app/apps/t3code/t3-pairing.js');

function target(input) {
  const result = parsePairingInput(input);
  assert.ok(result.ok, result.error);
  return result.target;
}

test('direct pairing link from t3 pair', () => {
  assert.deepEqual(target('http://192.168.1.20:3773/pair#token=7JBMA3AYC28V'), {
    credential: '7JBMA3AYC28V', label: '',
    httpBaseUrl: 'http://192.168.1.20:3773/', wsBaseUrl: 'ws://192.168.1.20:3773/',
  });
  assert.equal(target('  https://Mac.tail1234.ts.net:443/pair?token=ABCDEFGH2345 ').httpBaseUrl, 'https://mac.tail1234.ts.net/');
  assert.equal(target('https://mac.tail1234.ts.net/pair#token=ABCDEFGH2345').wsBaseUrl, 'wss://mac.tail1234.ts.net/');
});

test('hosted app.t3.codes link uses the host param', () => {
  const parsed = target('https://app.t3.codes/pair?host=https%3A%2F%2Fmy-mac.tail1234.ts.net%2F&label=My+Mac#token=7JBMA3AYC28V');
  assert.deepEqual(parsed, {
    credential: '7JBMA3AYC28V', label: 'My Mac',
    httpBaseUrl: 'https://my-mac.tail1234.ts.net/', wsBaseUrl: 'wss://my-mac.tail1234.ts.net/',
  });
  // A schemeless host defaults to https.
  assert.equal(target('https://app.t3.codes/pair?host=box.example.com:8443#token=ABCDEFGH2345').httpBaseUrl, 'https://box.example.com:8443/');
});

test('mobile QR payload and hand-typed host + code', () => {
  const inner = encodeURIComponent('http://10.0.0.5:3773/pair#token=ZZZZ22223333');
  assert.equal(target(`t3code://pair?pairingUrl=${inner}`).httpBaseUrl, 'http://10.0.0.5:3773/');
  assert.deepEqual(target('10.0.0.5:3773 ABCDEFGH2345'), {
    credential: 'ABCDEFGH2345', label: '', httpBaseUrl: 'http://10.0.0.5:3773/', wsBaseUrl: 'ws://10.0.0.5:3773/',
  });
  assert.equal(target('mac.tail1234.ts.net ABCDEFGH2345').httpBaseUrl, 'https://mac.tail1234.ts.net/');
});

test('rejects links without a token or of the wrong kind', () => {
  assert.equal(parsePairingInput('').ok, false);
  assert.match(parsePairingInput('http://10.0.0.5:3773/pair').error, /no pairing token/);
  assert.match(parsePairingInput('ftp://10.0.0.5/pair#token=X').error, /Unsupported/);
  assert.equal(parsePairingInput('hello there').ok, false);
});

test('baseUrlLabel drops the scheme', () => {
  assert.equal(baseUrlLabel('http://10.0.0.5:3773/'), '10.0.0.5:3773');
});
