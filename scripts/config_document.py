#!/usr/bin/env python3
"""Read a Faceclaw config file for push_config.sh / push_config_ios.sh.

The phone-side importer (Kotlin SettingsTransfer) does the authoritative validation and
platform filtering; this catches unusable files before the scripts touch a device, and
converts legacy Android shared-preferences XML (what pull_config.sh wrote before configs
were JSON) into a schema-1 document tagged as Android. See scripts/config-transfer.md.

  config_document.py INPUT    # prints the document to push
"""
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

LIMIT = 2 * 1024 * 1024


def _check_value(key, value):
    if not isinstance(key, str) or not key or len(key) > 512:
        raise ValueError('Invalid setting name')
    if value is None:
        raise ValueError(f'Setting {key} is null; supply an empty value to clear it')
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f'Setting {key} is not a finite number')
    if not isinstance(value, (str, bool, int, float, dict, list)):
        raise ValueError(f'Unsupported value for setting {key}')


def _no_constants(name):
    raise ValueError(f'{name} is not valid JSON')


def check_document(text):
    """Validate a JSON document's shape; returns (schema, platform, setting count)."""
    try:
        config = json.loads(text, parse_constant=_no_constants,
                            object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise ValueError(f'Config is not valid JSON: {error}') from None
    if not isinstance(config, dict) or type(config.get('schema')) is not int or config['schema'] not in (1, 2):
        raise ValueError('Expected a Faceclaw config with "schema": 1 or 2')
    platform = config.get('platform')
    if platform is not None and not isinstance(platform, str):
        raise ValueError('"platform" must be a string')
    count = 0
    for section in ('settings', 'platformSettings'):
        values = config.get(section, {} if section == 'platformSettings' else None)
        if not isinstance(values, dict):
            raise ValueError(f'"{section}" must be an object')
        for key, value in values.items():
            _check_value(key, value)
        count += len(values)
    if count > 4096:
        raise ValueError('Too many settings')
    return config['schema'], platform, count


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Setting {key} appears more than once')
        result[key] = value
    return result


def convert_android_xml(data):
    """Android shared-preferences XML -> schema-1 document text (the phone classifies the keys)."""
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
            try:
                value = float(item.get('value', '')) if item.tag == 'float' else int(item.get('value', ''))
            except ValueError:
                raise ValueError('Invalid numeric preference value') from None
        else:
            raise ValueError('Unsupported Android preference type')
        if len(item):
            raise ValueError('Nested preference content is not supported')
        _check_value(key, value)
        settings[key] = value
    return json.dumps({'schema': 1, 'platform': 'android', 'settings': settings},
                      indent=2, ensure_ascii=False, allow_nan=False) + '\n'


def read_document(path):
    """The document to push for a JSON config or legacy Android XML file, validated."""
    data = Path(path).read_bytes()
    if len(data) > LIMIT:
        raise ValueError('Config exceeds 2 MiB')
    if data.lstrip().startswith(b'<'):
        text = convert_android_xml(data)
    else:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('Config is not UTF-8') from None
    check_document(text)
    if len(text.encode()) > LIMIT:
        raise ValueError('Config exceeds 2 MiB')
    return text


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        text = read_document(sys.argv[1])
    except (OSError, ValueError, ET.ParseError) as error:
        print(f'Error: {error}', file=sys.stderr)
        return 1
    sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
