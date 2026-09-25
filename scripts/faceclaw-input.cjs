#!/usr/bin/env node
'use strict';
const net = require('node:net');
const readline = require('node:readline');
const fs = require('node:fs');

const GESTURES = new Set(['click', 'double-click', 'long-press', 'short-then-long-press', 'scroll-up', 'scroll-down',
  'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right']);
const ALIASES = { tap: 'click', 'double-tap': 'double-click', up: 'swipe-up', down: 'swipe-down', left: 'swipe-left', right: 'swipe-right' };
const HELP = `Usage: faceclaw-input [--host HOST] [--port PORT] [--token-file FILE] COMMAND

  input GESTURE [--source watch|ring]   Send one gesture (default source: watch)
  text [-n] MESSAGE                   Type into the foreground window (-n: no Enter)
  assistant MESSAGE                   Send a message to the voice assistant
  interactive                         Use this terminal as a watch input device

Gestures: tap, double-tap, long-press, short-then-long-press,
          up, down, left, right, scroll-up, scroll-down
Interactive: arrows = watch directions; Enter = tap; Esc = double-tap;
             Tab = long-press; i = compose text; a = compose assistant message;
             Enter sends a draft; Esc discards it; Ctrl-C quits in either mode.
Token: FACECLAW_TOKEN or --token-file FILE. Host/port default to 127.0.0.1:8791
(or FACECLAW_HOST/FACECLAW_PORT). Android USB: adb forward tcp:8791 tcp:8791
Keep Faceclaw running. Each token needs the permission for its command.
`;
function parseArgs(args, env = process.env) {
  const options = { host: env.FACECLAW_HOST || '127.0.0.1', port: Number(env.FACECLAW_PORT || 8791), token: env.FACECLAW_TOKEN || '', source: 'watch' };
  const positional = [];
  let noSubmit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (arg === '-n') { noSubmit = true; continue; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (['--host', '--port', '--token-file', '--source'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--port') options.port = Number(value);
      else if (arg === '--token-file') options.token = fs.readFileSync(value, 'utf8').trim();
      else options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port.');
  if (!/^fc1_[a-f0-9]{64}$/.test(options.token)) throw new Error('Set FACECLAW_TOKEN or --token-file to a generated Faceclaw token.');
  if (!['watch', 'ring'].includes(options.source)) throw new Error('Source must be watch or ring.');
  const [command, ...values] = positional;
  if (noSubmit && command !== 'text') throw new Error('-n is only valid with text.');
  if (command === 'interactive') {
    if (values.length || options.source !== 'watch') throw new Error('Interactive mode uses watch input and takes no message.');
    return { options, interactive: true };
  }
  let payload;
  if (command === 'input') {
    const gesture = ALIASES[values[0]] || values[0];
    if (values.length !== 1 || !GESTURES.has(gesture)) throw new Error('Expected one valid gesture. See --help.');
    if (options.source === 'ring' && gesture.startsWith('swipe-')) throw new Error('Ring input uses scroll-up/down; directions require watch input.');
    payload = { action: 'input', gesture, source: options.source };
  } else if (command === 'text' || command === 'assistant') {
    const text = values.join(' ');
    if (!text.trim() || text.length > 8000 || text.includes('\0')) throw new Error('Message must contain 1–8000 characters without NUL.');
    payload = { action: command, text, ...(noSubmit ? { submit: false } : {}) };
  } else throw new Error('Expected input, text, assistant or interactive. See --help.');
  return { options, payload };
}
function send(options, payload, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    let buffer = Buffer.alloc(0), settled = false;
    const abort = () => finish(new Error('Request cancelled.'));
    const deadline = setTimeout(() => finish(new Error('Faceclaw request timed out.')), 6500);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.on('connect', () => socket.write(JSON.stringify({ ...payload, version: 1, token: options.token }) + '\n'));
    socket.on('error', error => finish(new Error(`Could not reach Faceclaw: ${error.code || 'connection error'}. Check the app, host address and USB forwarding or Tailscale.`)));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) return finish(new Error('Oversized Faceclaw response.'));
      const end = buffer.indexOf(10);
      if (end < 0) return;
      let response;
      try { response = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { return finish(new Error('Invalid Faceclaw response.')); }
      if (response?.ok !== true) {
        const error = new Error(response?.message || 'Faceclaw rejected the request.');
        error.code = response?.error;
        return finish(error);
      }
      finish(null, response);
    });
    socket.on('end', () => { if (!settled) finish(new Error('Faceclaw closed the connection without a response.')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function keyGesture(key) {
  return { up: 'swipe-up', down: 'swipe-down', left: 'swipe-left', right: 'swipe-right',
    return: 'click', enter: 'click', escape: 'double-click', tab: 'long-press' }[key?.name];
}
async function interactive(options, input = process.stdin, output = process.stdout, transmit = send) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Interactive mode requires a terminal.');
  const wasRaw = !!input.isRaw;
  readline.emitKeypressEvents(input, { escapeCodeTimeout: 75 });
  const controls = 'Arrows: directions | Enter: tap | Esc: double-tap | Tab: long-press | i: text | a: assistant | Ctrl-C: quit\n';
  output.write(controls);
  input.setRawMode(true);
  await new Promise(resolve => {
    let active = true, sending = false, connected = false;
    let heartbeat = null, editor = null;
    const deferredStatus = [];
    const status = message => editor ? deferredStatus.push(message) : output.write(message);
    const queue = [];
    const abort = new AbortController();
    const stop = () => {
      if (!active) return;
      active = false; queue.length = 0; abort.abort();
      if (heartbeat !== null) clearInterval(heartbeat);
      input.removeListener('keypress', onKey); input.removeListener('end', stop);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
      Promise.resolve(editor?.cancel()).catch(() => {}).finally(() => {
        input.setRawMode(wasRaw); input.pause(); output.write('\n'); resolve();
      });
    };
    const reportFailure = error => {
      if (!active) return;
      const disconnected = !['forbidden', 'locked', 'unavailable', 'bad_request', 'failed'].includes(error.code);
      if (disconnected) connected = false;
      queue.length = 0;
      status(`\n${error.message}${disconnected ? ' Waiting for connection; Ctrl-C to quit.' : ''}\n`);
    };
    const checkConnection = async () => {
      if (!active || sending || editor) return;
      sending = true;
      try {
        await transmit(options, { action: 'ping' }, abort.signal);
        if (!active) return;
        if (!connected) status('Connected.\n');
        connected = true;
      } catch (error) { reportFailure(error); }
      finally { sending = false; if (active && connected && queue.length) void drain(); }
    };
    const drain = async () => {
      if (sending || !connected) return;
      sending = true;
      try {
        while (active && queue.length) {
          const payload = queue.shift();
          await transmit(options, payload, abort.signal);
          if (active && payload.action !== 'input') status(payload.action === 'text' ? 'Sent to foreground window.\n' : 'Sent to assistant.\n');
        }
      } catch (error) { reportFailure(error); }
      finally { sending = false; }
    };
    const compose = action => {
      try {
        editor = require('./faceclaw-input-editor.cjs').createEditor(action, input, output);
      } catch (error) { output.write(`Could not open editor: ${error.message}\nRun npm install in the Faceclaw checkout.\n`); return; }
      editor.result.then(text => {
        editor = null;
        if (!active) return;
        for (const message of deferredStatus.splice(0)) output.write(message);
        if (text === null) output.write('Draft discarded.\n');
        else if (!text.trim()) output.write('Empty draft; nothing sent.\n');
        else if (!connected) output.write('Not sent: connection was lost. Reconnect before sending a new message.\n');
        else { queue.push({ action, text }); void drain(); }
        output.write(controls);
      }).catch(error => {
        editor = null;
        if (active) { for (const message of deferredStatus.splice(0)) output.write(message); output.write(`Editor failed: ${error.message}\n${controls}`); }
      });
    };
    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') return stop();
      if (editor) { editor.keypress(text, key); return; }
      // Node marks a standalone Esc as meta=true as well as name='escape'.
      if (key?.ctrl || (key?.meta && key.name !== 'escape')) return;
      if (connected && !key?.shift && (key?.name === 'i' || key?.name === 'a')) {
        compose(key.name === 'i' ? 'text' : 'assistant'); return;
      }
      const gesture = keyGesture(key);
      // Bound key repeat lag; discard excess while the remote is slow.
      if (gesture && connected && queue.length < 16) { queue.push({ action: 'input', gesture, source: 'watch' }); void drain(); }
    };
    input.on('keypress', onKey); input.on('end', stop);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
    input.resume();
    heartbeat = setInterval(() => { void checkConnection(); }, 3000);
    output.write('Connecting...\n');
    void checkConnection();
  });
}
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return process.stdout.write(HELP);
    if (args.interactive) await interactive(args.options);
    else { await send(args.options, args.payload); process.stdout.write('Sent.\n'); }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { parseArgs, send, keyGesture, interactive };
if (require.main === module) void main();
