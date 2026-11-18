const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmux = require('../.test-build/app/apps/terminal/tmux-client.js');

// ---- pure helpers ----

test('tmux version gate', () => {
  assert.deepEqual(tmux.parseTmuxVersion('tmux 3.2a'), [3, 2]);
  assert.equal(tmux.tmuxVersionSupported('tmux 3.2a'), true);
  assert.equal(tmux.tmuxVersionSupported('tmux 3.8'), true);
  assert.equal(tmux.tmuxVersionSupported('tmux 3.1c'), false);
  assert.equal(tmux.tmuxVersionSupported('tmux 2.7'), false);
  assert.equal(tmux.tmuxVersionSupported('tmux next-3.9'), true);
  assert.equal(tmux.tmuxVersionSupported('tmux master'), true);
});

test('decodeTmuxOutput undoes tmux and transport escaping', () => {
  const bytes = (text) => Array.from(tmux.decodeTmuxOutput(text));
  assert.deepEqual(bytes('a\\015\\012b'), [0x61, 0x0d, 0x0a, 0x62]);
  assert.deepEqual(bytes('back\\134slash'), [...Buffer.from('back\\slash')]);
  assert.deepEqual(bytes('héllo ✓'), [...Buffer.from('héllo ✓')]);
  // A UTF-8 character split across two %output lines arrives escaped.
  assert.deepEqual([...bytes('caf\\303'), ...bytes('\\251')], [...Buffer.from('café')]);
  // A lone backslash without three octal digits is literal.
  assert.deepEqual(bytes('\\9'), [0x5c, 0x39]);
});

test('hostCommand keeps scripts portable across login shells', () => {
  assert.equal(tmux.hostCommand('echo hi'), "exec /bin/sh -c 'echo hi'");
  assert.throws(() => tmux.hostCommand("echo 'hi'"));
  assert.throws(() => tmux.hostCommand('echo \\\\'));
  for (const command of [tmux.pollerCommand(), tmux.viewerCommand('$3'), tmux.launchCommand('shell'), tmux.launchCommand('htop -d 5')]) {
    assert.match(command, /^exec \/bin\/sh -c '[^']*'$/);
  }
  assert.throws(() => tmux.viewerCommand('work'));
  assert.throws(() => tmux.launchCommand('rm -rf ~; echo $HOME'));
});

test('pane rows and labels', () => {
  const fields = ['%3', '$1', 'work', '@2', '1', 'zsh', '2', '0', '4242', '0', '1700000000', '3', 'zsh', '/home/jim/src', 'build\twatcher'];
  const row = tmux.parsePaneRow(fields.join('\t'));
  assert.equal(row.title, 'build\twatcher');
  assert.equal(row.bells, 3);
  assert.equal(row.windowPanes, 2);
  assert.equal(tmux.paneLabel(row, 'laptop.local', '/home/jim'), 'work:1.0 build\twatcher');
  assert.equal(tmux.paneLabel({ ...row, title: 'laptop.local' }, 'laptop.local', '/home/jim'), 'work:1.0 zsh ~/src');
  assert.equal(tmux.paneLabel({ ...row, title: 'laptop', windowPanes: 1 }, 'laptop.local', '/home/jim'), 'work:1 zsh ~/src');
  assert.equal(tmux.parsePaneRow('garbage'), null);
});

test('snapshot bytes restore cursor and key modes', () => {
  const state = tmux.parsePaneState('%1|4|1|1|1|0|1|0|0|0|1|80|2|10|57|5|0');
  assert.equal(state.historyNext, 57);
  assert.equal(state.historyOldest, 5);
  const text = Buffer.from(tmux.snapshotBytes(state, ['$ ls', 'a b'], [])).toString();
  assert.equal(text, '$ ls\x1b[0m\r\na b\x1b[0m\x1b[2;5H\x1b[?1h');
  // Without history_added (tmux < 3.8), history_size stands in.
  assert.equal(tmux.parsePaneState('%1|0|0|1|0|0|1|0|0|0|23|80|24|10||||').historyNext, 10);
});

test('send-keys commands are hex and chunked', () => {
  const commands = tmux.sendKeysCommands('%4', new Uint8Array(300).fill(0x41));
  assert.equal(commands.length, 2);
  assert.match(commands[0], /^send-keys -t %4 -H 41 41 /);
});

// ---- against a real tmux server ----

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
const haveTmux = tmuxVersion.status === 0 && tmux.tmuxVersionSupported(tmuxVersion.stdout);

/** Mimic the SSH transport: run through a shell, split stdout/stderr into lines, escape non-UTF-8 lines. */
function localChannel(env) {
  return (command, listener) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed = false;
    // Like the SSH transport, a write to a channel whose command just exited is dropped, not thrown.
    child.stdin.on('error', () => {});
    const lines = (stream, emit) => {
      let buffered = Buffer.alloc(0);
      stream.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        let index;
        while ((index = buffered.indexOf(0x0a)) >= 0) {
          emit(escapeLine(buffered.subarray(0, index)));
          buffered = buffered.subarray(index + 1);
        }
      });
    };
    lines(child.stdout, (line) => !closed && listener.onLine(line));
    lines(child.stderr, (line) => !closed && listener.onStderr(line));
    child.on('spawn', () => listener.onOpen());
    child.on('exit', (status) => { if (!closed) { closed = true; listener.onClosed(status); } });
    return {
      send: (line) => { if (closed) return false; child.stdin.write(`${line}\n`); return true; },
      close: () => { if (closed) return; closed = true; child.stdin.end(); setTimeout(() => child.kill(), 500); },
    };
  };
}

function escapeLine(bytes) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) return text;
  return Array.from(bytes, (byte) => (byte >= 0x80 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte))).join('');
}

function waitFor(predicate, what, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let value;
      try { value = predicate(); } catch (error) { clearInterval(timer); reject(error); return; }
      if (value) { clearInterval(timer); resolve(value); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timed out waiting for ${what}`)); }
    }, 50);
  });
}

test('TmuxClient against a local tmux server', { skip: !haveTmux && 'tmux >= 3.2 not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tmux-'));
  const env = { ...process.env, TMUX_TMPDIR: dir, SHELL: '/bin/sh', PS1: '$ ' };
  delete env.TMUX;
  const tm = (...args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  const openChannel = localChannel(env);
  const clients = [];
  try {
    tm('new-session', '-d', '-s', 'work', '-x', '120', '-y', '40', '/bin/sh');
    const control = new tmux.TmuxClient({ openChannel, label: 'test', cols: 80, rows: 20, stateKey: 'test-connection' });
    clients.push(control);
    const bells = [];
    control.onBell((socket) => bells.push(socket));
    control.start();
    await waitFor(() => control.state().phase === 'connected' && control.state().sessions.length === 1, 'listing');
    assert.equal(control.state().sessions[0].socket, '%0');
    assert.match(control.state().sessions[0].title, /^work:0 /);

    // A bell in the session's current window (tmux's own bell flag misses these).
    tm('send-keys', '-t', '%0', '-l', "printf '\\a'");
    tm('send-keys', '-t', '%0', 'Enter');
    await waitFor(() => bells.includes('%0'), 'bell');

    const launched = await control.launchSession('shell');
    assert.match(launched, /^%\d+$/);
    await waitFor(() => control.state().sessions.some((s) => s.socket === launched), 'launched pane in listing');

    // View the original pane.
    const view = new tmux.TmuxClient({ openChannel, label: 'test', cols: 80, rows: 20, stateKey: '' });
    clients.push(view);
    let screen = '';
    const snapshots = [];
    const histories = [];
    view.onTerminalData((data, kind) => {
      if (kind === 'snapshot') { screen = ''; snapshots.push(Buffer.from(data).toString()); }
      screen += Buffer.from(data).toString();
    });
    view.onSnapshot((next, oldest) => snapshots.push({ next, oldest }));
    view.onHistoryLines((reply) => histories.push(reply));
    view.onStateChange((state) => {
      if (state.phase === 'connected' && !view.requested) { view.requested = true; view.connectSession('%0'); }
    });
    view.onSessionAttached(() => view.view());
    view.start();
    await waitFor(() => snapshots.length >= 2, 'snapshot');
    assert.equal(view.state().phase, 'attached');
    assert.equal(tm('display', '-p', '-t', '%0', '#{window_width}x#{window_height}').stdout.trim(), '80x20');

    view.sendInput('for i in $(seq 1 60); do echo row$i; done\r');
    await waitFor(() => screen.includes('row60'), 'typed command output');

    // Re-snapshot: rows have scrolled into the history; page some back.
    view.unview();
    view.view();
    await waitFor(() => snapshots.length >= 4, 'second snapshot');
    const { next } = snapshots[snapshots.length - 1];
    assert.ok(next > 20, `history should have grown, next=${next}`);
    view.requestHistory(next, 5);
    await waitFor(() => histories.length === 1, 'history page');
    assert.equal(histories[0].lines.length, 5);
    assert.equal(histories[0].start, next - 5);
    assert.ok(histories[0].lines.some((line) => /^row\d+$/.test(line)), JSON.stringify(histories[0].lines));

    // Unviewing gives the window back its own size.
    view.unview();
    await waitFor(() => tm('display', '-p', '-t', '%0', '#{window_width}').stdout.trim() !== '80', 'size restored', 3000).catch(() => {});

    // The pane going away ends the view.
    let detached = null;
    view.onSessionDetached((reason) => { detached = reason; });
    view.view();
    tm('kill-pane', '-t', '%0');
    await waitFor(() => detached !== null, 'detach on pane exit');
  } finally {
    for (const client of clients) client.stop();
    tm('kill-server');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
