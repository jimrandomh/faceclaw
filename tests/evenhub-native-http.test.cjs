const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture(android = true, overrides = {}) {
  const calls = [];
  let listener;
  class NativeRequest {
    constructor(cachePath, callback) {
      calls.push(['construct', cachePath]);
      listener = callback;
    }
    request(url, method, headers, timeoutMs, maxBytes) {
      calls.push(['request', url, method, Array.from(headers), timeoutMs, maxBytes]);
      if (overrides.request) return overrides.request(url, method, headers, timeoutMs, maxBytes);
      return 'req-1';
    }
    read(id, offset, maxBytes) {
      calls.push(['read', id, offset, maxBytes]);
      return overrides.read ? overrides.read(id, offset, maxBytes) : JSON.stringify(['AQID', offset + maxBytes >= 3]);
    }
    cancel(id) { calls.push(['cancel', id]); }
    close() { calls.push(['close']); }
  }
  const globals = {
    Array: class extends Array {
      static create(_javaType, length) { return new Array(length); }
    },
    global: { isAndroid: android },
    com: { faceclaw: { app: {
      FaceclawEvenHubHttpListener: class {
        constructor(value) { Object.assign(this, value); }
      },
      FaceclawEvenHubHttp: NativeRequest,
    } } },
  };
  const { EvenHubNativeHttp } = loader(globals, {
    '../../native/file-access': { appCacheDirPath: () => '/app-cache' },
  })('app/apps/evenhub/native-http.ts');
  return { transport: new EvenHubNativeHttp(), calls, getListener: () => listener, overrides };
}

test('native HTTP resolves metadata and reads bounded base64 chunks', async () => {
  const { transport, calls, getListener } = fixture();
  const pending = transport.request({
    url: 'https://books.example/opds', method: 'GET',
    headers: { Accept: 'application/atom+xml', Authorization: 'Basic private' },
    timeoutMs: 20000, maxBytes: 2000000,
  });
  getListener().onResponse('req-1', 200, 'https://books.example/opds', '[["Content-Length","3"]]');
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    requestId: 'req-1', status: 200, url: 'https://books.example/opds',
    headers: [['Content-Length', '3']],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(transport.read('req-1', 0, 3))), { data: 'AQID', done: true });
  assert.deepEqual(calls[0], ['construct', '/app-cache']);
  assert.equal(calls.find((call) => call[0] === 'request')[2], 'GET');
  assert.deepEqual(calls.find((call) => call[0] === 'read'), ['read', 'req-1', 0, 3]);
  transport.close();
});

test('native HTTP cancel is idempotent and close rejects pending work', async () => {
  const { transport, calls, getListener } = fixture();
  const pending = transport.request({ url: 'https://books.example/opds' });
  transport.cancel('req-1');
  transport.cancel('req-1');
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls.filter((call) => call[0] === 'cancel').length, 2);
  getListener().onResponse('req-1', 200, 'ignored', '[]');
  transport.close();
  await assert.rejects(transport.request({ url: 'https://books.example/opds' }), /closed/);
});

test('malformed native response metadata rejects and cleans up', async () => {
  const { transport, calls, getListener } = fixture();
  const pending = transport.request({ url: 'https://books.example/opds' });
  getListener().onResponse('req-1', 200, 'https://books.example/opds', '{bad json');
  await assert.rejects(pending, /malformed response metadata/);
  assert.ok(calls.some((call) => call[0] === 'cancel' && call[1] === 'req-1'),
    'malformed metadata must cancel the native request and delete its response file');
  transport.close();
});

test('native HTTP resolves non-2xx metadata and empty HEAD bodies', async () => {
  const { transport, getListener } = fixture(true, { read: () => JSON.stringify(['', true]) });
  const pending = transport.request({ url: 'https://books.example/missing', method: 'HEAD' });
  getListener().onResponse('req-1', 404, 'https://books.example/missing', '[]');
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    requestId: 'req-1', status: 404, url: 'https://books.example/missing', headers: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(transport.read('req-1'))), { data: '', done: true });
  transport.cancel('req-1');
  transport.close();
});

test('malformed native response fields reject and clean up', async (t) => {
  const cases = [
    ['status', ['not-a-status', 'https://books.example/opds', '[]']],
    ['final URL', [200, null, '[]']],
    ['headers', [200, 'https://books.example/opds', '[["Content-Length"]]']],
  ];
  for (const [name, args] of cases) {
    await t.test(name, async () => {
      const { transport, calls, getListener } = fixture();
      const pending = transport.request({ url: 'https://books.example/opds' });
      getListener().onResponse('req-1', ...args);
      await assert.rejects(pending, /malformed response metadata/);
      assert.ok(calls.some((call) => call[0] === 'cancel' && call[1] === 'req-1'));
      transport.close();
    });
  }
});

test('malformed native chunks are rejected without coercion', async (t) => {
  const cases = [
    ['non-string data', [null, true]],
    ['non-boolean done', ['AQID', 'yes']],
    ['invalid base64', ['not base64!', true]],
  ];
  for (const [name, chunk] of cases) {
    await t.test(name, () => {
      const { transport } = fixture(true, { read: () => JSON.stringify(chunk) });
      assert.throws(() => transport.read('req-1', 0, 3), /malformed response chunk/);
      transport.close();
    });
  }
});

test('completion then cancel releases native state; close is idempotent', async () => {
  const { transport, calls, getListener } = fixture();
  const pending = transport.request({ url: 'https://books.example/opds' });
  transport.close();
  await assert.rejects(pending, /closed/);
  getListener().onResponse('req-1', 200, 'ignored', '[]');
  getListener().onFailure('req-1', 'ignored');
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
  assert.equal(calls.some((call) => call[0] === 'cancel'), false);
  transport.close();
  transport.cancel('req-1');
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);

  const second = fixture();
  const completed = second.transport.request({ url: 'https://books.example/opds' });
  second.getListener().onResponse('req-1', 200, 'https://books.example/opds', '[]');
  await completed;
  second.transport.cancel('req-1');
  assert.equal(second.calls.filter((call) => call[0] === 'cancel').length, 1);
  second.transport.close();
});

test('native HTTP validates request bounds and session method arguments', () => {
  const validators = loader({ URL }, {
    '../../native/file-access': { appCacheDirPath: () => '/app-cache' },
  })('app/apps/evenhub/native-http.ts');
  assert.deepEqual(JSON.parse(JSON.stringify(validators.nativeHttpOptions({ url: 'https://books.example' }))), {
    url: 'https://books.example', method: 'GET', headers: {}, timeoutMs: 30000, maxBytes: 16777216,
  });
  const invalidOptions = [
    {}, { url: 'file:///tmp/book.epub' }, { url: 'https://books.example', method: 'POST' },
    { url: 'https://user:secret@books.example/opds' },
    { url: 'https://books.example', headers: { Authorization: 42 } },
    { url: 'https://books.example', timeoutMs: 0 },
    { url: 'https://books.example', maxBytes: 64 * 1024 * 1024 + 1 },
  ];
  for (const options of invalidOptions) {
    assert.throws(() => validators.nativeHttpOptions(options), { name: 'TypeError' });
  }
  assert.equal(validators.boundedNativeHttpInteger(undefined, 262144, 1048576, 'maxBytes'), 262144);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1048577, '3']) {
    assert.throws(() => validators.boundedNativeHttpInteger(value, 262144, 1048576, 'maxBytes'), { name: 'TypeError' });
  }
  assert.equal(validators.boundedNativeHttpInteger(0, 0, Number.MAX_SAFE_INTEGER, 'offset', true), 0);
  assert.throws(() => validators.boundedNativeHttpInteger(-1, 0, Number.MAX_SAFE_INTEGER, 'offset', true), { name: 'TypeError' });
  for (const value of ['', 'x'.repeat(129), null, 42]) {
    assert.throws(() => validators.nativeHttpRequestId(value), { name: 'TypeError' });
  }
});

test('native HTTP is Android-only', () => {
  assert.throws(() => fixture(false), /only available on Android/);
});
test('native HTTP redacts native request and response parsing errors', async () => {
  const secret = 'private-header-value';
  const start = fixture(true, { request: () => { throw new Error(`Bad header: ${secret}`); } });
  await assert.rejects(start.transport.request({ url: 'https://books.example', headers: { Cookie: secret } }), (error) => {
    assert.equal(error.message, 'Native HTTP request could not be started.');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const read = fixture(true, { read: () => { throw new Error(`Missing response: ${secret}`); } });
  assert.throws(() => read.transport.read('req-1'), (error) => {
    assert.equal(error.message, 'Native HTTP response could not be read.');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  start.transport.close();
  read.transport.close();
});
