#!/usr/bin/env python3
"""Exercise the real CLI through a pseudo-terminal and a FIN-sensitive TCP peer."""
import json
import os
import pty
import select
import signal
import socket
import subprocess
import termios
import threading
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen(8)
server.settimeout(.1)
requests, failures = [], []
finished = threading.Event()
drop_next = threading.Event()


def serve():
    while not finished.is_set():
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        with conn:
            conn.settimeout(2)
            data = b''
            while b'\n' not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            request = json.loads(data)
            requests.append(request)
            # A forwarder may tear down both directions on FIN. Do likewise.
            conn.settimeout(.04)
            try:
                if conn.recv(1, socket.MSG_PEEK) == b'':
                    failures.append('CLI sent FIN before reply')
                    continue
            except socket.timeout:
                pass
            if request['action'] == 'input' and drop_next.is_set():
                drop_next.clear()
                continue
            conn.sendall(b'{"ok":true}\n')


thread = threading.Thread(target=serve, daemon=True)
thread.start()
master, slave = pty.openpty()
termios.tcsetwinsize(slave, (24, 100))
original = termios.tcgetattr(slave)
env = {**os.environ, 'FACECLAW_TOKEN': 'fc1_' + 'a' * 64}
child = subprocess.Popen(['node', str(root / 'scripts/faceclaw-input.cjs'), '--port', str(server.getsockname()[1]),
                          'interactive'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
output = bytearray()


def wait_for(predicate, timeout=7):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], .03)[0]:
            output.extend(os.read(master, 8192))
        if predicate():
            return
        assert child.poll() is None, output.decode(errors='replace')
    raise AssertionError(output.decode(errors='replace'))


try:
    wait_for(lambda: b'Connected.' in output)
    assert requests[0]['action'] == 'ping', requests
    for sequence, gesture in [(b'\x1b[A', 'swipe-up'), (b'\r', 'click'), (b'\x1b', 'double-click'), (b'\t', 'long-press')]:
        os.write(master, sequence)
        wait_for(lambda: any(r.get('gesture') == gesture for r in requests))
        time.sleep(.1)  # Each key follows the previous request's complete lifecycle.
        assert child.poll() is None
    before = len(requests)
    os.write(master, b'ihello worxd\x1b[D\x1b[D\x1b[3~l\x1b[C\x01Say \x05!\r')
    wait_for(lambda: b'Sent to foreground window.' in output)
    assert [r for r in requests[before:] if r['action'] != 'ping'] == [
        {'action': 'text', 'text': 'Say hello world!', 'version': 1, 'token': env['FACECLAW_TOKEN']}]
    os.write(master, 'aHello assistant 世界\r'.encode())
    wait_for(lambda: b'Sent to assistant.' in output)
    assert requests[-1]['action'] == 'assistant' and requests[-1]['text'] == 'Hello assistant 世界'
    before = len(requests)
    os.write(master, b'idiscard this draft')
    wait_for(lambda: b'discard this draft' in output)
    os.write(master, b'\x1b')
    wait_for(lambda: b'Draft discarded.' in output)
    assert not [r for r in requests[before:] if r['action'] != 'ping'], 'Esc leaked an input or sent a draft'
    drop_next.set()
    os.write(master, b'\x1b[B')
    wait_for(lambda: b'without a response' in output)
    assert child.poll() is None
    wait_for(lambda: output.count(b'Connected.') >= 2)
    before = len(requests)
    os.write(master, b'\x1b[C')
    wait_for(lambda: any(r.get('gesture') == 'swipe-right' for r in requests[before:]))
    time.sleep(.1)  # Let the final reply arrive before testing orderly exit.
    before = len(requests)
    os.write(master, b'aunfinished final draft')
    wait_for(lambda: b'unfinished final draft' in output)
    os.write(master, b'\x03')
    # Keep draining prompt cleanup output while waiting for process exit.
    wait_for(lambda: child.poll() is not None, timeout=2)
    assert child.returncode == 0
    assert termios.tcgetattr(slave) == original, 'Terminal mode was not restored'
    assert not failures, failures
    assert not [r for r in requests[before:] if r['action'] != 'ping'], 'Ctrl-C sent a draft'
    assert len([r for r in requests if r.get('gesture') == 'swipe-down']) == 1, 'Failed input was replayed'
    # Signals must also restore the terminal while the editor owns the prompt.
    # Enquirer's default signal handling exits before our async cleanup runs.
    output.clear()
    child = subprocess.Popen(['node', str(root / 'scripts/faceclaw-input.cjs'), '--port', str(server.getsockname()[1]),
                              'interactive'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
    wait_for(lambda: b'Connected.' in output)
    os.write(master, b'isignal cleanup draft')
    wait_for(lambda: b'signal cleanup draft' in output)
    child.send_signal(signal.SIGTERM)
    wait_for(lambda: child.poll() is not None, timeout=2)
    assert child.returncode == 0
    assert termios.tcgetattr(slave) == original, 'Signal exit left the terminal in raw mode'
    print('PTY probe passed: immediate connection, repeated keys, text/assistant editing, discard, recovery, Ctrl-C/SIGTERM and terminal restoration.')
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    finished.set()
    thread.join(timeout=3)
    server.close()
    os.close(master)
    os.close(slave)
