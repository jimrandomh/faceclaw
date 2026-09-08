const test = require('node:test');
const { execFileSync } = require('node:child_process');
test('iOS config codec preserves Android XML and JSON types and rejects malformed imports', () => {
  execFileSync('python3', ['-c', `
import importlib.util, pathlib, tempfile
spec = importlib.util.spec_from_file_location('config', 'scripts/ios_config.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
values = {'terminal.connections': '[{"url":"g2mirror://test@host"}]', 'flag': True, 'empty': '', 'number': 42, 'ratio': 0.25, 'unicode': 'π & < 🔋\\nnext'}
with tempfile.TemporaryDirectory() as d:
 p = pathlib.Path(d) / 'settings'
 for xml in [False, True]:
  m.atomic_write(p, m.encode_config(values, xml))
  assert m.read_config(p) == values
  assert p.stat().st_mode & 0o777 == 0o600
 for invalid in [b'{}', b'<map><set name="x"/></map>', b'<map><boolean name="x" value="maybe"/></map>', b'<map><string name="x">a</string><string name="x">b</string></map>', b'{"schema":1,"settings":{"x":null}}', b'{"schema":1,"settings":{"x":NaN}}', b'<map><string name="x">oops']:
  p.write_bytes(invalid)
  try: m.read_config(p)
  except (ValueError, m.ET.ParseError): pass
  else: raise AssertionError('accepted invalid config')
`], { stdio: 'inherit' });
});
