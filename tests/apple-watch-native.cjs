// Compile the watch app's platform-independent Swift for the Mac and run its checks.
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-apple-watch-'));
const src = 'apple-watch/Faceclaw';
execFileSync('xcrun', ['swiftc', '-O', `${src}/Protocol.swift`, `${src}/PadStatus.swift`, `${src}/PadGestureRecognizer.swift`,
  'tests/native/apple-watch/main.swift', '-o', join(dir, 'apple-watch-test')], { cwd: root, stdio: 'inherit' });
execFileSync(join(dir, 'apple-watch-test'), [], { stdio: 'inherit' });
