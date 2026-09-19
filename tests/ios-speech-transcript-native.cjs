const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const dir = mkdtempSync(join(tmpdir(), 'faceclaw-transcript-'));
try {
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
    'tests/native/ios-speech-transcript-test.m', 'App_Resources/iOS/src/FaceclawSpeechTranscript.m', '-o', join(dir, 'test')], { stdio: 'inherit' });
  execFileSync(join(dir, 'test'), [], { stdio: 'inherit' });
} finally { rmSync(dir, { recursive: true, force: true }); }
