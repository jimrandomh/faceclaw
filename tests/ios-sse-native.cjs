const { execFileSync, spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-sse-'));
execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
  'tests/native/ios-sse-test.m', 'App_Resources/iOS/src/FaceclawSseRequest.m', '-o', join(dir, 'sse-test')], { cwd: root, stdio: 'inherit' });
const server = http.createServer(async (request, response) => {
  assert.notEqual(request.url, '/redirected', 'Credentials must not follow redirects');
  assert.equal(request.headers.authorization, 'Bearer fixture-key');
  assert.equal(request.headers['user-agent'], 'Faceclaw-test');
  assert.equal(request.method, 'POST');
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { test: true });
  if (request.url === '/error') { response.writeHead(401); response.end('{"error":{"type":"invalid_api_key"}}'); return; }
  if (request.url === '/redirect') { response.writeHead(302, { Location: '/redirected' }); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', ...(request.url === '/disconnect' ? { 'Content-Length': '1000' } : {}) });
  if (request.url === '/overflow') { response.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
  if (request.url === '/disconnect') {
    response.write('data: partial'); setTimeout(() => response.destroy(), 50); return;
  }
  if (request.url === '/cancel') {
    response.write('data: first\n'); const timer = setTimeout(() => response.end('data: late\n'), 200);
    response.on('close', () => clearTimeout(timer)); return;
  }
  // Split UTF-8 characters and CRLF boundaries across individual network writes.
  const bytes = Buffer.from('\uFEFFdata: π 👓\r\n\r\n: ping\rdata: last');
  let index = 0;
  const timer = setInterval(() => {
    if (index === bytes.length) { clearInterval(timer); response.end(); }
    else response.write(bytes.subarray(index, ++index));
  }, 2);
  response.on('close', () => clearInterval(timer));
});
server.listen(0, '127.0.0.1', async () => {
  try {
    for (const mode of ['stream', 'error', 'redirect', 'cancel', 'overflow', 'disconnect']) await new Promise((resolve, reject) => {
      const child = spawn(join(dir, 'sse-test'), [`http://127.0.0.1:${server.address().port}/${mode}`, mode], { stdio: 'inherit' });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${mode}: exit ${code}`)));
    });
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});
