"""Host-side Faceclaw JSONC codec; matches SettingsDocument's versioned format."""
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

SCHEMA = 2
LIMIT = 2 * 1024 * 1024
STRUCTURED_KEYS = {
    'terminal.connections', 'teleprompter.recents', 'launcher.folders', 'notifications.sources',
    'files.bookmarks', 'music.apps', 'microphones.array-config', 'display.uiFont2', 'terminal.font',
    'navigate.savedDestinations', 'navigate.recentDestinations', 'evenhub.installedApps.v1',
    'timers.state', 'assistant.conversations',
}


def jsonc_loads(text):
    # Tokenize strings first so comment markers/commas inside strings stay literal.
    token = re.compile(r'"(?:[^"\\\x00-\x1f]|\\.)*"|//[^\r\n]*|/\*[\s\S]*?\*/')
    clean = token.sub(lambda m: m[0] if m[0].startswith('"') else ' ', text.lstrip('\ufeff'))
    clean = re.sub(r'("(?:[^"\\\x00-\x1f]|\\.)*")|,\s*(?=[}\]])', lambda m: m[1] or '', clean)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(clean, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Invalid JSON number')))


def validate(settings):
    def valid(value, depth=0):
        if depth >= 63:
            return False
        if value is None or type(value) in (str, bool, int):
            return True
        if type(value) is float:
            return math.isfinite(value)
        if isinstance(value, list):
            return all(valid(item, depth + 1) for item in value)
        if isinstance(value, dict):
            return all(isinstance(k, str) and valid(v, depth + 1) for k, v in value.items())
        return False
    if not isinstance(settings, dict) or len(settings) > 4096:
        raise ValueError('Expected a settings object with at most 4096 entries')
    for key, value in settings.items():
        if not isinstance(key, str) or not key or len(key) > 512:
            raise ValueError('Invalid setting name')
        if value is None or not valid(value):
            raise ValueError('Invalid setting value')
    return settings


def migrate_v1(settings):
    result = dict(settings)
    for key in settings:
        if key not in STRUCTURED_KEYS and not key.startswith("ios.ble.peripheral."):
            continue
        if not isinstance(settings[key], str):
            continue
        try:
            parsed = jsonc_loads(settings[key])
        except ValueError:
            continue
        if isinstance(parsed, (dict, list)):
            result[key] = parsed
    return result


MIGRATIONS = {1: migrate_v1}


def read_config(path):
    data = Path(path).read_bytes()
    if len(data) > LIMIT:
        raise ValueError('Config exceeds 2 MiB')
    if data.lstrip().startswith(b'<'):
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise ValueError('XML declarations of document types/entities are not supported')
        root = ET.fromstring(data)
        if root.tag != 'map':
            raise ValueError('Expected Android shared-preferences <map>')
        settings = {}
        for item in root:
            key = item.get('name')
            if key in settings:
                raise ValueError('Duplicate setting name')
            if item.tag == 'string':
                value = item.text or ''
            elif item.tag == 'boolean' and item.get('value') in ('true', 'false'):
                value = item.get('value') == 'true'
            elif item.tag in ('int', 'long', 'float'):
                value = float(item.get('value', '')) if item.tag == 'float' else int(item.get('value', ''))
            else:
                raise ValueError('Unsupported Android preference type')
            if len(item):
                raise ValueError('Nested preference content is not supported')
            settings[key] = value
        version = 1
    else:
        config = jsonc_loads(data.decode('utf-8'))
        if not isinstance(config, dict) or type(config.get('schema')) is not int or not 1 <= config['schema'] <= SCHEMA:
            raise ValueError('Unsupported Faceclaw config schema')
        settings, version = config.get('settings'), config['schema']
    validate(settings)
    while version < SCHEMA:
        settings = MIGRATIONS[version](settings)
        version += 1
    return validate(settings)


def encode_config(settings, xml=False):
    validate(settings)
    if not xml:
        return (json.dumps({'schema': SCHEMA, 'settings': settings}, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()
    # Compatibility export for old builds. Containers become legacy strings.
    root = ET.Element('map')
    for key, value in sorted(settings.items()):
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        if isinstance(value, str):
            ET.SubElement(root, 'string', name=key).text = value
        else:
            kind = 'boolean' if isinstance(value, bool) else 'long' if isinstance(value, int) else 'float'
            ET.SubElement(root, kind, name=key, value=str(value).lower())
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True) + b'\n'


if __name__ == '__main__':
    import sys
    # Used before Android scripts touch the device; normalizes XML/v1/JSONC to v2.
    sys.stdout.buffer.write(encode_config(read_config(sys.argv[1])))
