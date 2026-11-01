#!/usr/bin/env python3
"""Transfer Faceclaw preferences using Xcode's supported app-container APIs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config_document import read_document  # noqa: E402

BUNDLE = os.environ.get('IOS_BUNDLE_ID') or 'com.faceclaw.app'
REMOTE = 'Library/FaceclawConfigPort'
# The app reads requests of up to 8 MiB: a 2 MiB document embedded as an escaped JSON string.
REQUEST_LIMIT = 8 * 1024 * 1024


def run(args, tolerate=False):
    try:
        result = subprocess.run(['xcrun', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        if tolerate:
            return subprocess.CompletedProcess(args, 1, '', 'Xcode device command timed out')
        raise RuntimeError('Xcode device command timed out; check that the phone is connected and unlocked') from None
    if result.returncode and not tolerate:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'Xcode device command failed')
    return result


def atomic_write(path, data):
    path = Path(path).absolute()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def transfer(args):
    # Parse and validate before touching the device or restarting its app.
    document = read_document(args.file) if args.operation == 'push' else None
    with tempfile.TemporaryDirectory(prefix='faceclaw-config-') as work:
        work = Path(work)
        device = args.device or os.environ.get('IOS_DEVICE')
        if args.simulator:
            device = device or 'booted'
            container = Path(run(['simctl', 'get_app_container', device, BUNDLE, 'data']).stdout.strip())
        else:
            if not device:
                listing = work / 'devices.json'
                run(['devicectl', 'list', 'devices', '--json-output', str(listing)])
                devices = json.loads(listing.read_text())['result']['devices']
                available = [d for d in devices if d.get('connectionProperties', {}).get('tunnelState') == 'connected']
                if len(available) != 1:
                    raise ValueError('Specify the iPhone with --device UDID (or IOS_DEVICE)')
                device = available[0]['identifier']
        identifier = str(uuid.uuid4())
        payload = {'id': identifier, 'operation': args.operation}
        if document is not None:
            payload['document'] = document
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        if len(encoded) > REQUEST_LIMIT:
            raise ValueError('Config request exceeds 8 MiB')
        stage = work / 'FaceclawConfigPort'
        stage.mkdir(mode=0o700)
        atomic_write(stage / 'request.json', encoded)
        if args.simulator:
            remote = container / REMOTE
            remote.mkdir(parents=True, exist_ok=True)
            atomic_write(remote / 'request.json', encoded)
            run(['simctl', 'terminate', device, BUNDLE], tolerate=True)
            run(['simctl', 'launch', device, BUNDLE])
        else:
            run(['devicectl', 'device', 'copy', 'to', '--device', device, '--domain-type', 'appDataContainer',
                 '--domain-identifier', BUNDLE, '--source', str(stage), '--destination', REMOTE])
            run(['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', BUNDLE])
        deadline = time.monotonic() + 25
        response = None
        while time.monotonic() < deadline:
            if args.simulator:
                response_path = remote / 'response.json'
            else:
                response_path = work / 'response.json'
                run(['devicectl', 'device', 'copy', 'from', '--device', device, '--domain-type', 'appDataContainer',
                     '--domain-identifier', BUNDLE, '--source', REMOTE + '/response.json', '--destination', str(response_path)], tolerate=True)
            try:
                candidate = json.loads(response_path.read_text())
                if candidate.get('id') == identifier:
                    response = candidate
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        if response is None:
            raise RuntimeError('No matching config response. Unlock the phone and install a build with config-port support, then retry.')
        if not response.get('ok'):
            message = response.get('message', 'Config transfer failed')
            if message == 'Invalid config request':
                message += ' (does the installed build predate JSON config documents?)'
            raise RuntimeError(message)
        if args.operation == 'pull':
            if not isinstance(response.get('document'), str):
                raise RuntimeError('The installed build predates JSON config documents; update it and retry.')
            atomic_write(args.file, response['document'].encode())
            print(f'Pulled {response.get("count", "?")} settings to {args.file} (mode 600). App restarted.')
        else:
            skipped = response.get('skipped') or []
            note = f' Left out {len(skipped)} {response.get("sourcePlatform") or "other-platform"}-only settings.' if skipped else ''
            print(f'Pushed {response["count"]} settings; app restarted.{note} Unspecified settings preserved; '
                  f'previous preferences backed up in {REMOTE}/previous.plist.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Pull/push iOS Faceclaw config; restarts the app. Requires Xcode and an unlocked development device. Push merges supplied keys; accepts Faceclaw JSON from either platform, or legacy Android XML.')
    parser.add_argument('operation', choices=['pull', 'push'])
    parser.add_argument('path', nargs='?')
    parser.add_argument('-f', '--file')
    parser.add_argument('-d', '--device', help='iPhone UDID/name, or simulator ID with --simulator; defaults to IOS_DEVICE or the only connected device')
    parser.add_argument('--simulator', action='store_true', help='Use simctl (default device: booted)')
    args = parser.parse_args()
    if args.path and args.file:
        parser.error('Specify one file, either positional or with -f')
    args.file = args.file or args.path or 'faceclaw_settings.ios.json'
    if args.operation == 'pull' and Path(args.file).suffix.lower() == '.xml':
        parser.error('Configs are pulled as JSON; choose a .json filename')
    try:
        transfer(args)
    except (OSError, ValueError, RuntimeError, ET.ParseError) as error:
        print(f'Error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
