const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-config-'));
try {
  // Build the production common codec for the host to test real Objective-C IO,
  // migration and bridge calls without booting a simulator.
  const konan = join(homedir(), '.konan');
  const compiler = process.env.KOTLINC_NATIVE || readdirSync(konan).filter(n => n.startsWith('kotlin-native-prebuilt-')).sort().reverse()
    .map(n => join(konan, n, 'bin/kotlinc-native')).find(existsSync);
  if (!compiler) throw new Error('Install Kotlin/Native (npm run native:ios) or set KOTLINC_NATIVE');
  execFileSync(compiler, ['native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/SettingsDocument.kt',
    '-produce', 'framework', '-o', join(dir, 'FaceclawKit'), '-Xbinary=bundleId=com.faceclaw.settings.test'], { cwd: root, stdio: 'inherit' });
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'FaceclawKit', '-F', dir,
    '-Wl,-rpath,' + dir, '-I', 'App_Resources/iOS/src', 'tests/native/ios-config-test.m',
    'App_Resources/iOS/src/FaceclawConfigPort.m', 'App_Resources/iOS/src/FaceclawSettings.m', '-o', join(dir, 'config-test')], { cwd: root, stdio: 'inherit' });
  execFileSync(join(dir, 'config-test'), [dir], { stdio: 'inherit' });
} finally { rmSync(dir, { recursive: true, force: true }); }
