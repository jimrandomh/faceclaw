const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

test('config_document converts Android XML, passes JSON documents through and rejects unusable files', () => {
  execFileSync('python3', ['-c', `
import importlib.util, json, pathlib, sys, tempfile
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('ios_config', 'scripts/ios_config.py')
ios = importlib.util.module_from_spec(spec); spec.loader.exec_module(ios)
import config_document as m
xml = b'''<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <string name="terminal.connections">[{&quot;url&quot;:&quot;g2mirror://test@host&quot;}]</string>
  <boolean name="flag" value="true" />
  <string name="empty"></string>
  <long name="number" value="42" />
  <float name="ratio" value="0.25" />
  <string name="unicode">&#960; &amp; &lt; &#128267;&#10;next</string>
</map>'''
with tempfile.TemporaryDirectory() as d:
  p = pathlib.Path(d) / 'settings'
  p.write_bytes(xml)
  doc = json.loads(m.read_document(p))
  assert doc['schema'] == 1 and doc['platform'] == 'android', doc
  assert doc['settings'] == {'terminal.connections': '[{"url":"g2mirror://test@host"}]', 'flag': True, 'empty': '', 'number': 42, 'ratio': 0.25, 'unicode': '\\u03c0 & < \\U0001f50b\\nnext'}, doc
  text = json.dumps({'schema': 2, 'platform': 'ios', 'settings': {'a': [1, {'b': None is None}]}, 'platformSettings': {'ios.x': 'y'}})
  p.write_text(text)
  assert m.read_document(p) == text
  ios.atomic_write(p, b'{}')
  assert p.stat().st_mode & 0o777 == 0o600
  for invalid in [b'{}', b'[]', b'{"schema":3,"settings":{}}', b'{"schema":true,"settings":{}}', b'{"schema":2.0,"settings":{}}', b'{"schema":2}',
                  b'{"schema":2,"settings":{"x":null}}', b'{"schema":2,"settings":{"x":NaN}}', b'{"schema":2,"settings":{"x":1e999}}',
                  b'{"schema":2,"settings":{"x":1,"x":2}}', b'{"schema":2,"settings":{},"platformSettings":[]}',
                  b'{"schema":2,"platform":1,"settings":{}}', b'{"schema":2,"settings":{"":"x"}}',
                  b'<map><set name="x"/></map>', b'<map><boolean name="x" value="maybe"/></map>',
                  b'<map><string name="x">a</string><string name="x">b</string></map>', b'<map><string name="x">oops']:
    p.write_bytes(invalid)
    try: m.read_document(p)
    except (ValueError, m.ET.ParseError): pass
    else: raise AssertionError(f'accepted invalid config {invalid!r}')
pulled = {'schema': 2, 'platform': 'ios', 'settings': {'onboarding.lookalike': True, 'display.timeFormat': '24h'}, 'platformSettings': {
  'onboarding.complete': True, 'onboarding.previewOnly': False, 'onboarding.glassesFinishedVersion': '0.8.6', 'onboarding.step': 3, 'deviceAddress.left': 'AA'}}
reset = json.loads(ios.onboarding_reset_document(json.dumps(pulled)))
assert reset == {'schema': 2, 'platform': 'ios', 'settings': {}, 'platformSettings': {
  'onboarding.complete': False, 'onboarding.glassesFinishedVersion': '', 'onboarding.step': 0}}, reset
assert m.check_document(json.dumps(reset)) == (2, 'ios', 3)
assert ios.onboarding_reset_document(json.dumps({**pulled, 'platformSettings': {'onboarding.complete': False, 'onboarding.glassesFinishedVersion': '', 'deviceAddress.left': 'AA'}})) is None
`], { stdio: 'inherit' });
});

// FaceclawSettingsPortReceiver exports and imports the keys the app keeps in NativeScript's
// ApplicationSettings (prefs.db) from that file, by a fixed list. A new ApplicationSettings
// caller needs its keys added there (nativeScriptKey) and here.
test('settings stored outside FaceclawSettings are the ones the Android config port knows about', () => {
  const known = new Map([
    ['app/g2/device-addresses.ts', ['deviceAddress.', 'deviceIdentity.']],
    ['app/phone-ui/onboarding-state.ts', ['onboarding.complete', 'onboarding.previewOnly']],
    ['app/apps/evenhub/session.ts', ['evenhub:']],
    // iOS-only: NSUserDefaults holds every setting there.
    ['app/native/ios-bluetooth.ts', null],
    ['app/native/settings-store.ios.ts', null],
  ]);
  const users = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && /\bApplicationSettings\b/.test(readFileSync(path, 'utf8'))) users.push(path);
    }
  };
  walk('app');
  assert.deepStrictEqual(users.sort(), [...known.keys()].sort());
  const receiver = readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawSettingsPortReceiver.kt', 'utf8');
  for (const [file, keys] of known) {
    for (const key of keys ?? []) {
      assert.ok(receiver.includes(`"${key}"`), `${file}: FaceclawSettingsPortReceiver.nativeScriptKey is missing ${key}`);
      assert.ok(readFileSync(file, 'utf8').includes(key) || file.endsWith('session.ts'), `${file} no longer uses ${key}`);
    }
  }
});
