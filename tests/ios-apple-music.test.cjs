const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const sandbox = { exports: {}, console, JSON, Promise, require: id => {
    if (!(id in modules)) throw new Error(`Unstubbed import: ${id}`);
    return modules[id];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}

const types = load('app/native/media-types.ts');

/** A FaceclawAppleMusic stand-in: state is plain data the tests mutate. */
function fakeMusic() {
  const music = {
    permission: 'granted', state: { access: true, hasItem: true, state: 'playing', title: 'Song', artist: 'Band',
      album: 'Record', positionMs: 1000, durationMs: 200000, rate: 1, artVersion: 3 },
    queue: '[]', volume: 40, art: null, calls: [], permissionRequests: [], browses: [], plays: [],
    changeHandler: null,
    hasPermission() { return this.permission === 'granted'; },
    permissionStatus() { return this.permission; },
    requestPermission(done) { this.permissionRequests.push(done); },
    start() { this.calls.push('start'); }, stop() { this.calls.push('stop'); },
    stateJson() { return JSON.stringify(this.hasPermission() ? this.state : { access: false }); },
    playPause() { this.calls.push('playPause'); }, skipNext() { this.calls.push('skipNext'); },
    skipPrevious() { this.calls.push('skipPrevious'); }, skipToQueueIndex(i) { this.calls.push(`skipTo:${i}`); },
    queueJson() { return this.queue; },
    albumArt(size) { this.calls.push(`art:${size}`); return this.art; },
    volumePercent() { return this.volume; }, setVolumePercent(v) { this.calls.push(`volume:${v}`); },
    browseCompletion(parentId, done) { this.browses.push({ parentId, done }); },
    playCompletion(mediaId, done) { this.plays.push({ mediaId, done }); },
  };
  return music;
}

function controller(music = fakeMusic()) {
  const timers = new Map(); let nextTimer = 1;
  const dialogs = { confirms: [], alerts: [], confirmResult: true, opened: [] };
  const protocolCalls = [];
  const api = load('app/native/media-controller.ios.ts', {
    '@nativescript/core': {
      Dialogs: {
        confirm: async options => { dialogs.confirms.push(options); return dialogs.confirmResult; },
        alert: async options => { dialogs.alerts.push(options); },
      },
      Utils: { openUrl: url => dialogs.opened.push(url) },
    },
    './image-files': { grayImageFromPacket: bytes => (bytes && bytes.length ? { bytes } : null), PHOTO_TONE: { gamma: 2.2, dither: true } },
    './kotlin-data': { fromData: data => data },
    './media-types': types,
  }, {
    FaceclawAppleMusic: { shared: () => music },
    FaceclawKitIosProtocol: { new: () => ({ grayPacketBgraGammaDither: (packet, gamma, dither) => {
      protocolCalls.push({ packet, gamma, dither }); return [1, 0, 1, 0, 200];
    } }) },
    setInterval: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
  });
  return { api, bridge: api.mediaControllerBridge, music, timers, dialogs, protocolCalls,
    tick: () => { for (const fn of timers.values()) fn(); } };
}

test('Apple Music state normalizes the native player, access and missing items', () => {
  const { appleMusicState } = controller().api;
  const denied = appleMusicState({ access: false });
  assert.equal(denied.accessEnabled, false); assert.equal(denied.available, false);
  assert.equal(appleMusicState(null).accessEnabled, false);

  const playing = appleMusicState({ access: true, hasItem: true, state: 'playing', title: 'A', artist: 'B', album: 'C',
    positionMs: 5000, durationMs: 60000, rate: 0, artVersion: 7 });
  assert.equal(playing.available, true); assert.equal(playing.appName, 'Apple Music');
  assert.equal(playing.packageName, 'com.apple.Music');
  assert.equal(playing.playbackSpeed, 1, 'a starting player reports rate 0 but is advancing');
  assert.equal(playing.positionMs, 5000); assert.equal(playing.artVersion, 7);
  assert.ok(playing.canPlayPause && playing.canSkipNext && playing.canSkipPrevious);

  const paused = appleMusicState({ access: true, hasItem: true, state: 'paused', rate: 1, positionMs: 'x', durationMs: null });
  assert.equal(paused.playbackSpeed, 0); assert.equal(paused.positionMs, -1); assert.equal(paused.durationMs, -1);
  assert.equal(appleMusicState({ access: true, hasItem: true, state: 'odd' }).playbackState, 'unknown');

  const empty = appleMusicState({ access: true, hasItem: false, state: 'playing' });
  assert.equal(empty.accessEnabled, true); assert.equal(empty.available, false);
  assert.equal(empty.playbackState, 'idle'); assert.equal(empty.canPlayPause, false);
});

test('listeners start observation, are told only of real changes, and the poll runs while anyone listens', () => {
  const f = controller(); const seen = [];
  const off = f.bridge.onStateChange(state => seen.push(state));
  assert.deepEqual(f.music.calls, ['start']); assert.equal(seen.length, 1); assert.equal(f.timers.size, 1);
  assert.equal(typeof f.music.changeHandler, 'function');

  f.music.changeHandler(); // first refresh records the baseline
  const baseline = seen.length;
  f.music.state.positionMs = 9000; f.tick(); f.music.changeHandler();
  assert.equal(seen.length, baseline, 'playback progress alone does not notify');
  f.music.state.title = 'Next song'; f.music.state.artVersion = 4; f.tick();
  assert.equal(seen.length, baseline + 1); assert.equal(seen.at(-1).title, 'Next song');
  f.tick(); assert.equal(seen.length, baseline + 1);

  off(); assert.equal(f.timers.size, 0);
  f.music.state.title = 'Unheard'; f.music.changeHandler(); assert.equal(seen.length, baseline + 1);
  f.bridge.onStateChange(() => {}); assert.equal(f.music.calls.filter(c => c === 'start').length, 1);
});

test('transport, queue, volume and album art go through the native player', async () => {
  const f = controller();
  await f.bridge.playPause(); await f.bridge.skipNext(); await f.bridge.skipPrevious(); await f.bridge.skipToQueueItem(2.4);
  assert.deepEqual(f.music.calls, ['playPause', 'skipNext', 'skipPrevious', 'skipTo:2']);
  assert.equal(f.bridge.skipRebuildsQueue, false);

  f.music.queue = JSON.stringify([{ id: 0, title: 'One', active: false }, { id: 1, title: 'Two', active: true }, null]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.bridge.getQueue())),
    [{ id: 0, title: 'One', active: false }, { id: 1, title: 'Two', active: true }, { id: -1, title: '', active: false }]);
  f.music.queue = 'not json'; assert.equal(f.bridge.getQueue().length, 0);

  assert.equal(f.bridge.getMediaVolumePercent(), 40);
  f.music.volume = -1; assert.equal(f.bridge.getMediaVolumePercent(), -1);
  f.music.volume = NaN; assert.equal(f.bridge.getMediaVolumePercent(), -1);
  f.bridge.setMediaVolumePercent(140); assert.equal(f.music.calls.at(-1), 'volume:100');

  assert.equal(f.bridge.getAlbumArt(112), null); assert.equal(f.protocolCalls.length, 0);
  f.music.art = 'bgra-packet';
  assert.deepEqual(Array.from(f.bridge.getAlbumArt(111.6).bytes), [1, 0, 1, 0, 200]);
  assert.equal(f.music.calls.at(-1), 'art:112');
  assert.deepEqual(f.protocolCalls[0], { packet: 'bgra-packet', gamma: 2.2, dither: true });
});

test('access requests share one prompt, and denied or restricted access points to Settings', async () => {
  const f = controller(); f.music.permission = 'not-determined';
  const seen = []; f.bridge.onStateChange(state => seen.push(state.accessEnabled));
  assert.equal(f.bridge.hasAccess(), false); assert.equal(f.bridge.snapshot().accessEnabled, false);
  const first = f.bridge.requestAccess(), second = f.bridge.requestAccess();
  assert.equal(f.music.permissionRequests.length, 1);
  f.music.permission = 'granted'; f.music.permissionRequests[0](true);
  assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(seen.at(-1), true, 'listeners hear about the grant');
  assert.equal(await f.bridge.requestAccess(), true); assert.equal(f.music.permissionRequests.length, 1);

  f.music.permission = 'denied';
  assert.equal(await f.bridge.requestAccess(), false);
  assert.equal(f.dialogs.confirms.length, 1); assert.deepEqual(f.dialogs.opened, ['app-settings:']);
  f.dialogs.confirmResult = false; await f.bridge.requestAccess(); assert.equal(f.dialogs.opened.length, 1);

  f.music.permission = 'restricted';
  assert.equal(await f.bridge.requestAccess(), false); assert.equal(f.dialogs.alerts.length, 1);
  assert.equal(f.music.permissionRequests.length, 1);
});

function browser(music = fakeMusic()) {
  const api = load('app/native/media-browser.ios.ts', { './media-types': types }, {
    FaceclawAppleMusic: { shared: () => music },
  });
  return { bridge: api.mediaBrowserBridge, music };
}

test('the Apple Music library browses only with access and drops answers after disconnect', async () => {
  const f = browser();
  const [app] = f.bridge.listBrowsableApps();
  assert.equal(app.appName, 'Apple Music');
  await assert.rejects(f.bridge.connect({ ...app, packageName: 'other' }), /Only Apple Music/);
  await assert.rejects(f.bridge.browse('root'), /Not connected/);

  assert.equal(await f.bridge.connect(app), 'root');
  const listing = f.bridge.browse('root');
  assert.equal(f.music.browses[0].parentId, 'root');
  f.music.browses[0].done(JSON.stringify([{ mediaId: 'playlists', title: 'Playlists', browsable: true }]), null);
  assert.deepEqual(JSON.parse(JSON.stringify(await listing)),
    [{ mediaId: 'playlists', title: 'Playlists', subtitle: '', browsable: true, playable: false }]);

  const failed = f.bridge.browse('album:1');
  f.music.browses[1].done(null, 'Unknown library item');
  await assert.rejects(failed, /Unknown library item/);
  const garbled = f.bridge.browse('songs');
  f.music.browses[2].done('{', null);
  await assert.rejects(garbled, /parse failed/);

  f.bridge.playFromMediaId('song:5@album:1');
  assert.equal(f.music.plays[0].mediaId, 'song:5@album:1');
  const stale = f.bridge.browse('playlists');
  f.bridge.disconnect();
  f.music.browses[3].done('[]', null);
  await assert.rejects(stale, /Disconnected/);
  f.bridge.playFromMediaId('playlist:2'); assert.equal(f.music.plays.length, 1);

  f.music.permission = 'denied';
  assert.equal(f.bridge.listBrowsableApps().length, 0);
  await assert.rejects(f.bridge.connect(app), /not allowed/);
});
