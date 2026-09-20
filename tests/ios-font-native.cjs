// Runs the production Core Text renderer on macOS, without UIKit or a simulator.
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-font-'));
execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-framework', 'Foundation', '-framework', 'CoreText', '-framework', 'CoreGraphics',
  '-I', 'App_Resources/iOS/src', 'tests/native/ios-font-test.m', 'App_Resources/iOS/src/FaceclawFontRenderer.m', '-o', join(dir, 'font-test')], { cwd: root, stdio: 'inherit' });
execFileSync(join(dir, 'font-test'), [join(root, 'app/fonts/ttf'), dir], { stdio: 'inherit' });
console.log(`Font test artifacts: ${dir}`);
