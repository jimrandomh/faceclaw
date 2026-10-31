// Exercise the iOS resource sampler's mach/malloc/rusage queries natively (on macOS).
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-resource-usage-'));
try {
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
    'tests/native/ios-resource-usage-test.m', 'App_Resources/iOS/src/FaceclawResourceUsage.m',
    '-o', join(dir, 'resource-usage-test')], { cwd: root, stdio: 'inherit' });
  execFileSync(join(dir, 'resource-usage-test'), [], { stdio: 'inherit' });
} finally { rmSync(dir, { recursive: true, force: true }); }
