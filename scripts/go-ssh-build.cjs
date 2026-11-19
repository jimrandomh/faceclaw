// Builds the Go SSH transport (native/ssh) with gomobile and stages it into
// the local @faceclaw/kotlin NativeScript plugin next to the shared Kotlin
// artifacts: platforms/android/faceclaw-ssh.aar and
// platforms/ios/Faceclawssh.xcframework. Run from the before-prepare hook;
// a content stamp skips the (~10 s) gomobile build when nothing changed.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native/ssh');
const buildDir = path.join(source, 'build');
const plugin = path.join(root, 'native/kotlin/plugin/platforms');

// Bump to force a rebuild when the gomobile invocation below changes.
const BUILD_RECIPE = 2;

function sourceHash(platform) {
  const hash = crypto.createHash('sha256');
  hash.update(`${BUILD_RECIPE}\n${platform}\n`);
  const files = readdirSync(source)
    .filter(name => (name.endsWith('.go') && !name.endsWith('_test.go')) || name === 'go.mod' || name === 'go.sum')
    .sort();
  for (const name of files) {
    hash.update(`${name}\n`);
    hash.update(readFileSync(path.join(source, name)));
  }
  return hash.digest('hex');
}

function findGo() {
  const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error('Building the SSH transport needs Go 1.26 or newer on PATH (e.g. "brew install go").');
  }
}

function newestNdk() {
  if (process.env.ANDROID_NDK_HOME && existsSync(process.env.ANDROID_NDK_HOME)) return process.env.ANDROID_NDK_HOME;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME must be set to build the SSH transport for Android.');
  const ndkRoot = path.join(sdk, 'ndk');
  const versions = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  if (!versions.length) throw new Error(`No Android NDK under ${ndkRoot}; install one with the SDK manager.`);
  return path.join(ndkRoot, versions[0]);
}

// gomobile's ObjC headers say "@import Foundation;", which fails wherever
// Clang modules are off (the NativeScript app target's compile, and its
// metadata generator). A plain #import means the same thing everywhere.
function patchGomobileHeaders(xcframework) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.h')) {
        const text = readFileSync(file, 'utf8');
        const patched = text.replace(/^@import Foundation;$/gm, '#import <Foundation/Foundation.h>');
        if (patched !== text) writeFileSync(file, patched);
      }
    }
  };
  walk(xcframework);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: source, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} failed (${signal || code})`));
    });
  });
}

async function buildGoSsh(platform) {
  if (!['android', 'ios'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const stampFile = path.join(buildDir, `.stamp-${platform}`);
  const output = platform === 'android'
    ? path.join(buildDir, 'faceclaw-ssh.aar')
    : path.join(buildDir, 'Faceclawssh.xcframework');
  const staged = platform === 'android'
    ? path.join(plugin, 'android/faceclaw-ssh.aar')
    : path.join(plugin, 'ios/Faceclawssh.xcframework');
  const hash = sourceHash(platform);
  const fresh = existsSync(output) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === hash;
  if (!fresh) {
    findGo();
    console.log(`[go-ssh] Building ${platform}`);
    mkdirSync(path.join(buildDir, 'bin'), { recursive: true });
    const env = { ...process.env, PATH: `${path.join(buildDir, 'bin')}${path.delimiter}${process.env.PATH}` };
    // gomobile bind finds gobind on PATH; build both from the versions pinned
    // in go.mod's tool block.
    await run('go', ['build', '-o', path.join(buildDir, 'bin') + path.sep, 'golang.org/x/mobile/cmd/gomobile', 'golang.org/x/mobile/cmd/gobind'], env);
    const common = ['-ldflags=-s -w', '-trimpath'];
    rmSync(output, { recursive: true, force: true });
    if (platform === 'android') {
      env.ANDROID_NDK_HOME = newestNdk();
      await run('gomobile', ['bind', '-target=android/arm64', '-androidapi', '24', '-javapkg', 'com.faceclaw.ssh', ...common, '-o', output, '.'], env);
    } else {
      await run('gomobile', ['bind', '-target=ios,iossimulator', '-iosversion', '15.0', ...common, '-o', output, '.'], env);
      patchGomobileHeaders(output);
    }
    writeFileSync(stampFile, hash);
  }
  // Stage only when the staged copy is missing or stale; preserve mtimes on
  // no-op builds (NativeScript uses them to detect changes).
  const stagedStamp = path.join(buildDir, `.staged-${platform}`);
  if (existsSync(staged) && existsSync(stagedStamp) && readFileSync(stagedStamp, 'utf8') === hash) return;
  mkdirSync(path.dirname(staged), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  cpSync(output, staged, { recursive: true });
  writeFileSync(stagedStamp, hash);
  if (platform === 'android') {
    // As in kotlin-build.cjs: NativeScript's metadata task tracks jars by
    // path, so force it to regenerate for the new classes.
    rmSync(path.join(root, 'platforms/android/app/src/main/assets/metadata'), { recursive: true, force: true });
  }
}

module.exports = { buildGoSsh };
if (require.main === module) {
  buildGoSsh(process.argv[2]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
