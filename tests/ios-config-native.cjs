const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-config-'));
try {
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
    'tests/native/ios-config-test.m', 'App_Resources/iOS/src/FaceclawConfigPort.m', '-o', join(dir, 'config-test')], { cwd: root, stdio: 'inherit' });
  execFileSync(join(dir, 'config-test'), [dir], { stdio: 'inherit' });
} finally { rmSync(dir, { recursive: true, force: true }); }
