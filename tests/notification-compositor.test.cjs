const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native zero underlay hides raster, deferred identities and fingerprints while preserving lock and retained state', () => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-notification-compositor-'));
  try {
    execFileSync('javac', ['-d', classes, 'App_Resources/Android/src/main/java/com/faceclaw/app/SurfaceCompositor.java', 'tests/fixtures/NotificationCompositorCheck.java'], { encoding: 'utf8', stdio: 'pipe' });
    assert.equal(execFileSync('java', ['-cp', classes, 'com.faceclaw.app.NotificationCompositorCheck'], { encoding: 'utf8', stdio: 'pipe' }), '');
  } finally { fs.rmSync(classes, { recursive: true, force: true }); }
});
