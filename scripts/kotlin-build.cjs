const { spawn } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const kotlin = path.join(root, 'native/kotlin');

function sameContents(source, destination) {
  if (!existsSync(destination)) return false;
  if (statSync(source).isDirectory()) {
    if (!statSync(destination).isDirectory()) return false;
    const entries = readdirSync(source).sort();
    const previous = readdirSync(destination).sort();
    return entries.length === previous.length && entries.every((entry, index) =>
      entry === previous[index] && sameContents(path.join(source, entry), path.join(destination, entry)));
  }
  return statSync(destination).isFile() && readFileSync(source).equals(readFileSync(destination));
}

function checkAndroidRuntime(projectDir = root) {
  const generated = path.join(projectDir, 'platforms/android/build-tools/android-metadata-generator.jar');
  const installed = path.join(projectDir, 'node_modules/@nativescript/android/framework/build-tools/android-metadata-generator.jar');
  if (existsSync(generated) && !sameContents(installed, generated)) {
    throw new Error('Generated Android runtime is stale. Run "ns platform clean android" once after npm ci, then rebuild.');
  }
}

async function buildKotlin(platform, configuration = 'debug') {
  if (!['android', 'ios'].includes(platform)) throw new Error(`Unsupported Kotlin platform: ${platform}`);
  if (!['debug', 'release'].includes(configuration)) throw new Error(`Unsupported Kotlin configuration: ${configuration}`);
  const variant = configuration === 'release' ? 'Release' : 'Debug';
  const task = platform === 'android' ? ':shared:assembleAndroidMain' : `:shared:assembleFaceclawKit${variant}XCFramework`;
  const wrapper = path.join(root, 'wear', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  console.log(`[kotlin] Building ${platform} (${configuration})`);
  await new Promise((resolve, reject) => {
    const child = spawn(wrapper, [task, '--console=plain'], { cwd: kotlin, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Kotlin build failed (${signal || code})`));
    });
  });
  // Stage only after a successful build. npm links this directory into node_modules.
  const destination = path.join(kotlin, 'plugin/platforms', platform);
  mkdirSync(destination, { recursive: true });
  if (platform === 'android') {
    // NativeScript's resource copy can retain deleted sources. Remove the
    // generated copy from the pre-KMP bridge so it cannot duplicate the AAR.
    rmSync(path.join(root, 'platforms/android/app/src/main/java/com/faceclaw/shared/KotlinBridge.kt'), { force: true });
    const output = path.join(kotlin, 'shared/build/outputs/aar');
    const files = readdirSync(output).filter(name => name.endsWith('.aar'));
    if (files.length !== 1) throw new Error(`Expected one Kotlin AAR, found: ${files.join(', ')}`);
    const source = path.join(output, files[0]);
    const aar = path.join(destination, 'faceclaw-shared.aar');
    if (!sameContents(source, aar)) cpSync(source, aar);
  } else {
    const framework = path.join(destination, 'FaceclawKit.xcframework');
    const source = path.join(kotlin, `shared/build/XCFrameworks/${configuration}/FaceclawKit.xcframework`);
    // Preserve mtimes on no-op builds: NativeScript uses them to detect changes.
    if (!sameContents(source, framework)) {
      rmSync(framework, { recursive: true, force: true });
      cpSync(source, framework, { recursive: true });
    }
  }
}

module.exports = { buildKotlin, checkAndroidRuntime };
if (require.main === module) {
  buildKotlin(process.argv[2], process.argv[3]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
