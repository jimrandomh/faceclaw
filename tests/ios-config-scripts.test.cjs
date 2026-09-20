const test = require('node:test');
const { execFileSync } = require('node:child_process');
test('shared config codec migrates XML/v1, reads JSONC and preserves nested types', () => {
  execFileSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, json
spec = importlib.util.spec_from_file_location('config', 'scripts/ios_config.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
values = {'terminal.connections': [{'url':'g2mirror://test@host'}], 'teleprompter.recents': [], 'flag': True, 'empty': '', 'number': 42, 'ratio': 0.25, 'unicode': 'π & < 🔋\\nnext'}
with tempfile.TemporaryDirectory() as d:
 p = pathlib.Path(d) / 'settings'
 for xml in [False, True]:
  m.atomic_write(p, m.encode_config(values, xml))
  assert m.read_config(p) == values
  assert p.stat().st_mode & 0o777 == 0o600
 p.write_text(json.dumps({'schema':1, 'settings':dict(values, **{'terminal.connections':json.dumps(values['terminal.connections'])})}))
 assert m.read_config(p) == values
 p.write_text('// comment\\n{"schema":2, /*schema*/ "settings":{"terminal.connections":[{"url":"ssh://host/*literal*/",},],"text":"literal,}",},}')
 assert m.read_config(p) == {'terminal.connections':[{'url':'ssh://host/*literal*/'}], 'text':'literal,}'}
 for invalid in [b'{}', b'<map><set name="x"/></map>', b'<map><boolean name="x" value="maybe"/></map>', b'<map><string name="x">a</string><string name="x">b</string></map>', b'{"schema":1,"settings":{"x":null}}', b'{"schema":1,"settings":{"x":NaN}}', b'<map><string name="x">oops', b'{"schema":3,"settings":{}}', b'{"schema":true,"settings":{}}', b'{"schema":2,"settings":{"x":1,"x":2}}', b'/*unterminated', b'{"schema":2,"settings":{"x":1}} trailing']:
  p.write_bytes(invalid)
  try: m.read_config(p)
  except (ValueError, m.ET.ParseError): pass
  else: raise AssertionError('accepted invalid config')
`], { stdio: 'inherit' });
});
