// macOS integration test for the loopback OAuth redirect receiver compiled into iOS
// (Spotify sign-in): builds FaceclawLoopbackRedirect.m with a probe and talks HTTP to it.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-loopback-'));
try {
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
    'tests/native/ios-loopback-redirect-test.m', 'App_Resources/iOS/src/FaceclawLoopbackRedirect.m',
    '-o', join(dir, 'loopback-test')], { cwd: root, stdio: 'inherit' });
  // A port unlikely to be taken on a dev machine; the app's own port is in spotify-auth.ts.
  execFileSync(join(dir, 'loopback-test'), ['43899'], { stdio: 'inherit' });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
