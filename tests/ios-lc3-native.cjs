// Exercise the actual decoder with stock G2 packet framing and encoded PCM.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-lc3-'));
const src = 'App_Resources/iOS/src';
const files = readdirSync(join(root, src, 'lc3')).filter(f => f.endsWith('.c')).map(f => `${src}/lc3/${f}`);
execFileSync('xcrun', ['clang', '-fobjc-arc', '-O2', '-framework', 'Foundation', '-I', src, '-I', `${src}/lc3`,
  'tests/native/ios-lc3-test.m', `${src}/FaceclawLc3Decoder.m`, ...files, '-o', join(dir, 'lc3-test')], { cwd: root, stdio: 'inherit' });
execFileSync(join(dir, 'lc3-test'), [], { stdio: 'inherit' });
