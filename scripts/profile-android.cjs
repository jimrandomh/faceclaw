#!/usr/bin/env node
'use strict';

// Host-side only: ART samples the process; V8 samples each JS isolate over CDP.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SourceMap } = require('node:module');

const HELP = `Usage: npm run profile:android -- [options]

  --device SERIAL       ADB device (or ANDROID_SERIAL; required if ambiguous)
  --seconds N           Recording duration, 1–300 (default: 10)
  --mode all|js|art     V8 TypeScript/JS, ART Java/Kotlin, or both (default: all)
  --interval N          Sampling interval in microseconds, 100–1000000 (default: 1000)
  --out DIRECTORY       New output directory (default: profiles/<timestamp>)
  --package ID          App package (default: com.faceclaw.app)
  --no-source-maps      Keep only generated JS locations

Requires Node 22+, adb, and an already running debug build. No rebuild or restart.
Reproduce the workload while recording. Ctrl-C stops and saves early.
Disconnect other debuggers/profilers first. See scripts/profile-android.md.
`;

function parseArgs(args, env = process.env) {
  const options = { device: env.ANDROID_SERIAL, seconds: 10, mode: 'all', interval: 1000,
    package: 'com.faceclaw.app', sourceMaps: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--no-source-maps') { options.sourceMaps = false; continue; }
    if (!['--device', '--seconds', '--mode', '--interval', '--out', '--package'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2)] = ['--seconds', '--interval'].includes(arg) ? Number(value) : value;
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 300) throw new Error('--seconds must be between 1 and 300.');
  if (!Number.isInteger(options.interval) || options.interval < 100 || options.interval > 1000000) throw new Error('--interval must be an integer between 100 and 1000000.');
  if (!['all', 'js', 'art'].includes(options.mode)) throw new Error('--mode must be all, js, or art.');
  // ADB shell joins arguments into a remote shell command. Keep all interpolated
  // remote paths and package names restricted, even though execFile uses no shell.
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(options.package)) throw new Error('Invalid Android package ID.');
  return options;
}

class Inspector {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) { this.onEvent(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    const disconnected = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('NativeScript inspector disconnected.'));
      }
      this.pending.clear();
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
  }

  static async connect(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const inspector = new Inspector(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out. Is this a running NativeScript debug build?')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to NativeScript inspector. Use a running debug build.')); }, { once: true });
    });
    return inspector;
  }

  call(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Inspector is not connected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out${sessionId ? ` (${sessionId})` : ''}.`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket.close(); }
}

function remapProfile(profile, maps) {
  const mapped = structuredClone(profile);
  let mappedNodes = 0;
  for (const node of mapped.nodes) {
    const frame = node.callFrame;
    const map = maps.get(frame.url);
    if (!map || frame.lineNumber < 0 || frame.columnNumber < 0) continue;
    const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
    if (!entry.originalSource || entry.originalLine === undefined) continue;
    frame.url = entry.originalSource;
    frame.lineNumber = entry.originalLine;
    frame.columnNumber = entry.originalColumn;
    if (entry.name) frame.functionName = entry.name;
    // V8's generated line ticks no longer describe this source file. Keep them
    // in the raw profile, but don't show misleading line counts in the mapped one.
    delete node.positionTicks;
    mappedNodes++;
  }
  return { profile: mapped, mappedNodes };
}

function traceSummary(buffer) {
  const end = buffer.indexOf('*end\n');
  if (end < 0 || buffer.subarray(0, 8).toString() !== '*version') throw new Error('ART did not produce a valid method trace.');
  const header = buffer.subarray(0, end).toString();
  const methods = header.split('*methods\n')[1]?.trim().split('\n') || [];
  return { bytes: buffer.length, overflow: header.includes('data-file-overflow=true'),
    methods: methods.length,
    faceclawMethods: methods.filter(line => line.includes('\tcom.faceclaw.')).length,
    kotlinMethods: methods.filter(line => /\.kt(?:\t|$)/.test(line)).length };
}

async function record(options) {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22+ is required (built-in WebSocket).');
  const adb = (...args) => execFileSync('adb', [...(options.device ? ['-s', options.device] : []), ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!options.device) {
    const devices = adb('devices').split('\n').filter(line => /\tdevice\s*$/.test(line)).map(line => line.split('\t')[0]);
    if (devices.length !== 1) throw new Error(`Found ${devices.length} ADB devices. Select one with --device SERIAL.`);
    options.device = devices[0];
  }
  const pids = adb('shell', 'pidof', options.package).trim().split(/\s+/);
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) throw new Error('Start Faceclaw before profiling; expected one app process.');
  const pid = pids[0];
  try { adb('shell', 'run-as', options.package, 'id'); }
  catch { throw new Error('Profiling requires an installed debug build (run-as failed). Build with ./build.sh --env.sourceMap=source-map.'); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(options.out || path.join('profiles', stamp));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output); // Refuse to overwrite an earlier capture.
  const remoteTrace = `/data/local/tmp/faceclaw-${stamp}-${process.pid}.trace`;
  const summary = { device: options.device, package: options.package, pid, mode: options.mode,
    intervalUs: options.interval, requestedSeconds: options.seconds, startedAt: new Date().toISOString(),
    profiles: [], warnings: [] };
  const warn = message => { summary.warnings.push(message); console.error(`Warning: ${message}`); };
  let port, inspector, artStarted = false, stopping = false, interrupted = false, wake;
  const targets = new Map();
  const stopEarly = () => { interrupted = true; if (wake) wake(); };
  process.on('SIGINT', stopEarly);
  process.on('SIGTERM', stopEarly);
  let failure;

  async function startTarget(sessionId, title) {
    const key = sessionId || 'main';
    if (targets.has(key) || stopping) return;
    const target = { sessionId, title, key, started: false };
    targets.set(key, target);
    target.ready = (async () => {
      await inspector.call('Profiler.enable', {}, sessionId);
      await inspector.call('Profiler.setSamplingInterval', { interval: options.interval }, sessionId);
      await inspector.call('Profiler.start', {}, sessionId);
      target.started = true;
      target.startedAt = new Date().toISOString();
      console.log(`V8 recording: ${title}`);
    })().catch(error => { warn(`Cannot profile ${title}: ${error.message}`); });
    await target.ready;
  }

  try {
    if (options.mode !== 'art') {
      port = adb('forward', 'tcp:0', `localabstract:${options.package}-inspectorServer`).trim();
      if (!/^\d+$/.test(port)) throw new Error('ADB did not allocate an inspector port.');
      inspector = await Inspector.connect(port);
      inspector.onEvent = message => {
        if (message.method === 'Target.attachedToTarget') {
          const { sessionId, targetInfo } = message.params;
          if (targetInfo.type === 'worker') void startTarget(sessionId, targetInfo.url || targetInfo.title);
        } else if (message.method === 'Target.detachedFromTarget') {
          const target = targets.get(message.params.sessionId);
          if (target) { target.detached = true; warn(`Worker exited before its profile could be saved: ${target.title}`); }
        }
      };
      await startTarget(undefined, 'main');
      if (!targets.get('main').started) throw new Error('Main V8 profiler failed to start.');
      try {
        await inspector.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await Promise.all([...targets.values()].map(target => target.ready));
      } catch (error) { warn(`Worker discovery unavailable; main V8 profile still active: ${error.message}`); }
    }
    if (options.mode !== 'js') {
      const result = adb('shell', 'am', 'profile', 'start', '--sampling', String(options.interval), pid, remoteTrace);
      if (/error|exception|failed/i.test(result)) throw new Error(result.trim());
      artStarted = true;
      console.log('ART recording: Java/Kotlin across the app process');
    }
    console.log(`Reproduce the workload now (${options.seconds}s; Ctrl-C saves early).`);
    if (!interrupted) await new Promise(resolve => {
      const timer = setTimeout(resolve, options.seconds * 1000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  } catch (error) { failure = error; }
  finally {
    stopping = true;
    // Stop every profiler before pulling maps/files. Failures in one profiler
    // must not prevent the others from stopping or their data from being saved.
    if (artStarted) {
      try { adb('shell', 'am', 'profile', 'stop', pid); }
      catch (error) { warn(`Could not stop ART: ${error.message}. Run adb -s ${options.device} shell am profile stop ${pid}`); }
    }
    await Promise.all([...targets.values()].map(async target => {
      await target.ready;
      if (!target.started || target.detached) return;
      try {
        const { profile } = await inspector.call('Profiler.stop', {}, target.sessionId);
        if (!Array.isArray(profile?.nodes)) throw new Error('Inspector returned no CPU profile.');
        const name = `js-${target.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        fs.writeFileSync(path.join(output, `${name}.raw.cpuprofile`), JSON.stringify(profile));
        target.profile = profile;
        summary.profiles.push({ name, title: target.title, startedAt: target.startedAt,
          samples: profile.samples?.length || 0, nodes: profile.nodes.length });
      } catch (error) { warn(`Could not save ${target.title}: ${error.message}`); }
    }));
    inspector?.close();
    if (port) {
      try { adb('forward', '--remove', `tcp:${port}`); }
      catch (error) { warn(`Could not remove ADB forward tcp:${port}: ${error.message}`); }
    }
    process.removeListener('SIGINT', stopEarly);
    process.removeListener('SIGTERM', stopEarly);
  }

  summary.stoppedAt = new Date().toISOString();
  summary.interrupted = interrupted;
  if (artStarted) {
    try {
      const file = path.join(output, 'java-kotlin.trace');
      adb('pull', remoteTrace, file);
      summary.art = traceSummary(fs.readFileSync(file));
      if (summary.art.overflow) warn('ART trace buffer overflowed. Use a shorter capture or a larger --interval.');
      adb('shell', 'rm', remoteTrace);
    } catch (error) { warn(`Could not retrieve ART trace (left at ${remoteTrace}): ${error.message}`); }
  }

  if (options.sourceMaps && summary.profiles.length) {
    // Use maps from the installed app, never a potentially mismatched local build.
    const maps = new Map();
    const urls = new Set([...targets.values()].flatMap(target => target.profile?.nodes.map(node => node.callFrame.url) || []));
    for (const url of urls) {
      const prefix = `file:///data/data/${options.package}/files/app/`;
      const alternate = `file:///data/user/0/${options.package}/files/app/`;
      const relative = url.startsWith(prefix) ? url.slice(prefix.length) : url.startsWith(alternate) ? url.slice(alternate.length) : '';
      if (!/^[A-Za-z0-9_.-]+\.(?:m?js)$/.test(relative)) continue;
      try {
        let payload;
        try { payload = adb('exec-out', 'run-as', options.package, 'cat', `files/app/${relative}.map`); }
        catch {
          const source = adb('exec-out', 'run-as', options.package, 'cat', `files/app/${relative}`);
          const inline = source.match(/sourceMappingURL=data:application\/json[^,\n]*;base64,([A-Za-z0-9+/=]+)/);
          if (!inline) throw new Error('no external or inline map');
          payload = Buffer.from(inline[1], 'base64').toString('utf8');
        }
        maps.set(url, new SourceMap(JSON.parse(payload)));
        fs.mkdirSync(path.join(output, 'source-maps'), { recursive: true });
        fs.writeFileSync(path.join(output, 'source-maps', `${relative}.map`), payload);
      } catch (error) { warn(`Source map unavailable for ${relative}: ${error.message}. Generated locations remain usable.`); }
    }
    for (const target of targets.values()) {
      if (!target.profile) continue;
      const name = `js-${target.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const mapped = remapProfile(target.profile, maps);
      fs.writeFileSync(path.join(output, `${name}.cpuprofile`), JSON.stringify(mapped.profile));
      summary.profiles.find(item => item.name === name).mappedNodes = mapped.mappedNodes;
    }
  }
  if (failure) summary.error = failure.message;
  fs.writeFileSync(path.join(output, 'capture.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Saved ${output}`);
  for (const profile of summary.profiles) console.log(`  ${profile.name}: ${profile.samples} samples, ${profile.mappedNodes || 0} source-mapped nodes`);
  if (summary.art) console.log(`  ART: ${summary.art.methods} methods (${summary.art.faceclawMethods} Faceclaw, ${summary.art.kotlinMethods} with Kotlin source)`);
  if (failure) throw failure;
  if ((options.mode !== 'js' && !summary.art) || (options.mode !== 'art' && !summary.profiles.length)) throw new Error('Capture incomplete; see capture.json.');
  return summary;
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else return record(options);
  }).catch(error => { console.error(`Profiling failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { parseArgs, Inspector, remapProfile, traceSummary, record };
