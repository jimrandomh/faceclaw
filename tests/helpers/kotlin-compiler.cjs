const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');

/** A cached Maven artifact (`.jar` unless `extension` says otherwise), or null. */
function cachedArtifact(group, artifact, version, extension = 'jar') {
  const directory = path.join(cache, group, artifact, version);
  if (!fs.existsSync(directory)) return null;
  for (const hash of fs.readdirSync(directory)) {
    const file = path.join(directory, hash, `${artifact}-${version}.${extension}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** The newest cached version of an artifact, or null. */
function newestArtifact(group, artifact, extension = 'jar') {
  const directory = path.join(cache, group, artifact);
  if (!fs.existsSync(directory)) return null;
  for (const version of fs.readdirSync(directory).sort().reverse()) {
    const file = cachedArtifact(group, artifact, version, extension);
    if (file) return file;
  }
  return null;
}

/**
 * The Kotlin compiler NativeScript's Android build already cached (the version
 * in before-plugins.gradle), or null before the first ./build.sh. Run it as
 * `java -cp <classpath> org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -cp <stdlib> ...`.
 */
function kotlinCompiler() {
  const gradle = fs.readFileSync(path.join(__dirname, '../../App_Resources/Android/before-plugins.gradle'), 'utf8')
    .match(/kotlinVersion\s*=\s*"([^"]+)"/);
  if (!gradle) return null;
  const version = gradle[1];
  const stdlib = cachedArtifact('org.jetbrains.kotlin', 'kotlin-stdlib', version);
  const compiler = [
    cachedArtifact('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', version),
    stdlib,
    cachedArtifact('org.jetbrains.kotlin', 'kotlin-script-runtime', version),
    cachedArtifact('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', version),
    newestArtifact('org.jetbrains.kotlin', 'kotlin-reflect'),
    newestArtifact('org.jetbrains.intellij.deps', 'trove4j'),
    newestArtifact('org.jetbrains', 'annotations'),
    newestArtifact('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
  ];
  if (compiler.some(file => !file)) return null;
  return { classpath: compiler.join(path.delimiter), stdlib };
}

module.exports = { cachedArtifact, newestArtifact, kotlinCompiler };
