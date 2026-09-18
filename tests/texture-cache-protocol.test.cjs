const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('256 KiB cache uploads and planner draws preserve wide image and glyph offsets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-texture-java-'));
  const javaBin = (name) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  const root = path.join(__dirname, '../App_Resources/Android/src/main/java/com/faceclaw/app');
  try {
    const clock = path.join(directory, 'SystemClock.java');
    const log = path.join(directory, 'Log.java');
    fs.writeFileSync(clock, 'package android.os; public class SystemClock { public static long elapsedRealtime() { return 0; } }');
    fs.writeFileSync(log, 'package android.util; public class Log { public static int i(String tag, String msg) { return 0; } }');
    const sources = ['GlyphAtlas.java', 'ImageAtlas.java', 'FwGlyphAtlas.java', 'SurfaceCompositor.java',
      'util/BmpUtil.java', 'util/CollectionUtils.java', 'g2protocol/BleProtocol.java',
      'g2protocol/BleImageOptimizer.java', 'g2protocol/TextureCacheState.java', 'g2protocol/TexturePlanner.java'];
    execFileSync(javaBin('javac'), ['-d', directory, ...sources.map(file => path.join(root, file)),
      clock, log, path.join(__dirname, 'fixtures/TextureCacheProtocolTest.java')], { stdio: 'pipe' });
    execFileSync(javaBin('java'), ['-ea', '-cp', directory, 'com.faceclaw.app.TextureCacheProtocolTest'], { stdio: 'pipe' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
