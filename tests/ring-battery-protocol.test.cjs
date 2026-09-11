const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('ring battery decodes valid, unavailable, legacy, and malformed reports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-ring-java-'));
  const javaBin = (name) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  try {
    execFileSync(javaBin('javac'), ['-d', directory,
      path.join(__dirname, '../App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/BleProtocol.java'),
      path.join(__dirname, '../App_Resources/Android/src/main/java/com/faceclaw/app/util/CollectionUtils.java'),
      path.join(__dirname, 'fixtures/RingBatteryProtocolTest.java')], { stdio: 'pipe' });
    execFileSync(javaBin('java'), ['-ea', '-cp', directory, 'com.faceclaw.app.RingBatteryProtocolTest'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
