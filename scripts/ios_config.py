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
ONBOARDING_PREFIX = 'onboarding.'


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


def resolve_device(args, work):
    device = args.device or os.environ.get('IOS_DEVICE')
    if args.simulator:
        return device or 'booted'
    if device:
        return device
    listing = work / 'devices.json'
    run(['devicectl', 'list', 'devices', '--json-output', str(listing)])
    devices = json.loads(listing.read_text())['result']['devices']
    available = [d for d in devices if d.get('connectionProperties', {}).get('tunnelState') == 'connected']
    if len(available) != 1:
        raise ValueError('Specify the iPhone with --device UDID (or IOS_DEVICE)')
    return available[0]['identifier']


def exchange(args, work, device, operation, document=None):
    """Restart the app with one request for it to consume at launch; returns its successful reply."""
    if args.simulator:
        container = Path(run(['simctl', 'get_app_container', device, BUNDLE, 'data']).stdout.strip())
    identifier = str(uuid.uuid4())
    payload = {'id': identifier, 'operation': operation}
    if document is not None:
        payload['document'] = document
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
    if len(encoded) > REQUEST_LIMIT:
        raise ValueError('Config request exceeds 8 MiB')
    stage = work / 'FaceclawConfigPort'
    stage.mkdir(mode=0o700, exist_ok=True)
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
    return response


def pull_document(args, work, device):
    response = exchange(args, work, device, 'pull')
    if not isinstance(response.get('document'), str):
        raise RuntimeError('The installed build predates JSON config documents; update it and retry.')
    return response


def transfer(args):
    # Parse and validate before touching the device or restarting its app.
    document = read_document(args.file) if args.operation == 'push' else None
    with tempfile.TemporaryDirectory(prefix='faceclaw-config-') as work:
        work = Path(work)
        device = resolve_device(args, work)
        if args.operation == 'pull':
            response = pull_document(args, work, device)
            atomic_write(args.file, response['document'].encode())
            print(f'Pulled {response.get("count", "?")} settings to {args.file} (mode 600). App restarted.')
        else:
            response = exchange(args, work, device, 'push', document)
            skipped = response.get('skipped') or []
            note = f' Left out {len(skipped)} {response.get("sourcePlatform") or "other-platform"}-only settings.' if skipped else ''
            print(f'Pushed {response["count"]} settings; app restarted.{note} Unspecified settings preserved; '
                  f'previous preferences backed up in {REMOTE}/previous.plist.')


def onboarding_reset_document(pulled):
    """A document clearing the onboarding keys set in a pulled config, or None if none are.

    Pushes merge, so a key can be overwritten but not removed. Every onboarding key reads the
    value written here the same as a missing key: false for flags, "" for the finished version.
    """
    cleared = {}
    for key, value in json.loads(pulled).get('platformSettings', {}).items():
        if not key.startswith(ONBOARDING_PREFIX):
            continue
        blank = False if isinstance(value, bool) else 0 if isinstance(value, (int, float)) else ''
        if value != blank:
            cleared[key] = blank
    if not cleared:
        return None
    return json.dumps({'schema': 2, 'platform': 'ios', 'settings': {}, 'platformSettings': cleared})


def reset_onboarding(args):
    with tempfile.TemporaryDirectory(prefix='faceclaw-config-') as work:
        work = Path(work)
        device = resolve_device(args, work)
        if args.all:
            print(f'Uninstalling {BUNDLE}, which removes ALL of its data...')
            if args.simulator:
                run(['simctl', 'uninstall', device, BUNDLE])
            else:
                run(['devicectl', 'device', 'uninstall', 'app', '--device', device, BUNDLE])
            print('Done. Reinstall (npm run run:ios) to start from a clean onboarding.')
            return
        print(f'Clearing onboarding preference keys ({ONBOARDING_PREFIX}*) for {BUNDLE}...')
        document = onboarding_reset_document(pull_document(args, work, device)['document'])
        if document is None:
            print('No onboarding keys were set. App is already in pre-onboarding state.')
            return
        keys = json.loads(document)['platformSettings']
        exchange(args, work, device, 'push', document)
        for key in keys:
            print(f'  cleared {key}')
        print(f'Done. Faceclaw has restarted into onboarding; previous preferences backed up in {REMOTE}/previous.plist.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Pull/push iOS Faceclaw config, or reset its onboarding state; restarts the app. Requires Xcode and an unlocked development device. Push merges supplied keys; accepts Faceclaw JSON from either platform, or legacy Android XML.')
    parser.add_argument('operation', choices=['pull', 'push', 'reset-onboarding'])
    parser.add_argument('path', nargs='?')
    parser.add_argument('-f', '--file')
    parser.add_argument('-d', '--device', help='iPhone UDID/name, or simulator ID with --simulator; defaults to IOS_DEVICE or the only connected device')
    parser.add_argument('--simulator', action='store_true', help='Use simctl (default device: booted)')
    parser.add_argument('--all', action='store_true', help='With reset-onboarding: uninstall the app, wiping ALL of its data')
    args = parser.parse_args()
    if args.operation == 'reset-onboarding' and (args.path or args.file):
        parser.error('reset-onboarding does not take a file')
    if args.all and args.operation != 'reset-onboarding':
        parser.error('--all only applies to reset-onboarding')
    if args.path and args.file:
        parser.error('Specify one file, either positional or with -f')
    args.file = args.file or args.path or 'faceclaw_settings.ios.json'
    if args.operation == 'pull' and Path(args.file).suffix.lower() == '.xml':
        parser.error('Configs are pulled as JSON; choose a .json filename')
    try:
        (reset_onboarding if args.operation == 'reset-onboarding' else transfer)(args)
    except (OSError, ValueError, RuntimeError, ET.ParseError) as error:
        print(f'Error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
