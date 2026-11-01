const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const sandbox = { exports: {}, console, JSON, Promise, Date, Math, setTimeout, clearTimeout, require: id => {
    if (!(id in modules)) throw new Error(`Unstubbed import: ${id}`);
    return modules[id];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}

/** Values from the sandbox carry its own Array/Object prototypes; compare their plain JSON form. */
const plain = value => JSON.parse(JSON.stringify(value));

const SPOTIFY = 'com.spotify.music';
const types = load('app/native/media-types.ts');
const base = { ...types.DEFAULT_MEDIA_STATE, accessEnabled: true };
const playing = (extra = {}) => ({ ...base, available: true, playbackState: 'playing', title: 'Song', ...extra });
const paused = (extra = {}) => ({ ...base, available: true, playbackState: 'paused', title: 'Song', ...extra });

function controllerApi() {
  return load('app/native/media-controller.ts', {
    '@nativescript/core': { Utils: {} },
    './image-files': {}, './media-apps': {}, './settings-store': {}, './notification-access': {},
    './media-types': types,
    './spotify': { spotifyService: () => null },
    './spotify-player': { SPOTIFY_ANDROID_PACKAGE: SPOTIFY },
  });
}

/** A media-session bridge and a Web API player stand-in, each recording the commands it gets. */
function composite(sessionState, spotifyState) {
  const api = controllerApi();
  const calls = [];
  const fake = (name, state, extra = {}) => ({
    accessPrompt: `${name} prompt`, accessLabel: `${name} label`, accessAction: `${name} action`, skipRebuildsQueue: true,
    state, queue: [], volume: name === 'session' ? 30 : 70, lastPlayingAtMs: 0, listeners: [],
    onStateChange(listener) { this.listeners.push(listener); listener(this.state); return () => calls.push(`${name}:unsubscribe`); },
    snapshot() { return this.state; },
    start: async () => calls.push(`${name}:start`), stop: async () => calls.push(`${name}:stop`),
    playPause: async () => calls.push(`${name}:playPause`), skipNext: async () => calls.push(`${name}:next`),
    skipPrevious: async () => calls.push(`${name}:previous`),
    skipToQueueItem: async id => calls.push(`${name}:skipTo:${id}`),
    getQueue() { calls.push(`${name}:queue`); return this.queue; },
    getMediaVolumePercent() { return this.volume; }, setMediaVolumePercent: value => calls.push(`${name}:volume:${value}`),
    getAlbumArt: () => name,
    hasAccess: () => name === 'session', requestAccess: async () => calls.push(`${name}:access`),
    sendCustomAction: async action => calls.push(`${name}:custom:${action}`),
    refresh: async () => calls.push(`${name}:refresh`),
    ...extra,
  });
  const session = fake('session', sessionState);
  const spotify = fake('spotify', spotifyState);
  let now = 100;
  const bridge = new api.AndroidMediaControllerBridge(session, () => (spotifyState ? spotify : null), () => now);
  return { api, bridge, calls, session, spotify, tick: ms => { now += ms; } };
}

test('the Android bridge chooses between the media session and Spotify\'s Web API player', () => {
  const { chooseAndroidMediaSource: choose } = controllerApi();
  const spotifySession = (extra) => ({ ...extra, packageName: SPOTIFY });
  // Signed out (or no Web API player): always the session.
  assert.equal(choose('spotify', paused(), null, 0, 0), 'session');
  assert.equal(choose('spotify', paused(), { ...playing(), accessEnabled: false }, 0, 0), 'session');
  // Without notification access, Spotify when it has something, else the session's access prompt.
  assert.equal(choose('session', { ...base, accessEnabled: false }, paused(), 0, 0), 'spotify');
  assert.equal(choose('session', { ...base, accessEnabled: false }, base, 0, 0), 'session');
  // Playing wins.
  assert.equal(choose('session', paused({ packageName: 'org.videolan.vlc' }), playing(), 0, 0), 'spotify');
  assert.equal(choose('spotify', playing({ packageName: 'org.videolan.vlc' }), paused(), 0, 0), 'session');
  // Both playing: Spotify's own session is the same playback; another player keeps the current choice.
  assert.equal(choose('spotify', spotifySession(playing()), playing(), 0, 0), 'session');
  assert.equal(choose('spotify', playing({ packageName: 'org.videolan.vlc' }), playing(), 0, 0), 'spotify');
  assert.equal(choose('session', playing({ packageName: 'org.videolan.vlc' }), playing(), 0, 0), 'session');
  // Neither playing: Spotify's session, then the one that played last, then whichever has something.
  assert.equal(choose('spotify', spotifySession(paused()), paused(), 0, 50), 'session');
  assert.equal(choose('session', paused({ packageName: 'org.videolan.vlc' }), paused(), 10, 50), 'spotify');
  assert.equal(choose('spotify', paused({ packageName: 'org.videolan.vlc' }), paused(), 50, 10), 'session');
  assert.equal(choose('spotify', paused({ packageName: 'org.videolan.vlc' }), paused(), 0, 0), 'session');
  assert.equal(choose('session', base, paused(), 0, 0), 'spotify');
  assert.equal(choose('session', base, base, 0, 0), 'session');
});

test('a Spotify session keeps its transport and art and gains the Web API\'s rows and device volume', async () => {
  const actions = [{ action: 'shuffle', name: 'Shuffle: off' }, { action: 'repeat', name: 'Repeat: off' }, { action: 'like', name: 'Like song' }];
  const c = composite(playing({ packageName: SPOTIFY, appName: 'Spotify', title: 'Song a', artVersion: 4 }),
    playing({ packageName: SPOTIFY, appName: 'Spotify · Kitchen', title: 'Song a', customActions: actions }));
  let state = c.bridge.snapshot();
  assert.equal(state.title, 'Song a');
  assert.equal(state.appName, 'Spotify · Kitchen');
  assert.deepEqual(plain(state.customActions.map(action => action.action)), ['shuffle', 'repeat', 'like']);
  assert.equal(c.bridge.accessPrompt, 'session prompt');

  await c.bridge.playPause(); await c.bridge.skipNext();
  await c.bridge.sendCustomAction('like');
  assert.equal(c.bridge.getAlbumArt(112), 'session');
  // Volume follows Spotify (a Connect speaker's own volume, or this phone's).
  assert.equal(c.bridge.getMediaVolumePercent(), 70);
  c.bridge.setMediaVolumePercent(55);
  assert.deepEqual(c.calls, ['session:playPause', 'session:next', 'spotify:custom:like', 'spotify:volume:55']);

  // After a skip the API still describes the previous track: "Like song" waits until it catches up.
  c.session.state = { ...c.session.state, title: 'Song b' };
  state = c.bridge.snapshot();
  assert.deepEqual(plain(state.customActions.map(action => action.action)), ['shuffle', 'repeat']);
  assert.equal(state.appName, 'Spotify');

  // Another player's session gets no Spotify rows, and its own volume.
  c.session.state = playing({ packageName: 'org.videolan.vlc', appName: 'VLC' });
  state = c.bridge.snapshot();
  assert.equal(state.customActions, undefined);
  assert.equal(c.bridge.getMediaVolumePercent(), 30);
});

test('Spotify playing on another device, with no session here, follows the Web API player', async () => {
  const c = composite({ ...base, status: 'No session' }, playing({ packageName: SPOTIFY, appName: 'Spotify · MacBook', title: 'Remote', artVersion: 1 }));
  const first = c.bridge.snapshot();
  assert.equal(first.title, 'Remote');
  await c.bridge.playPause(); await c.bridge.skipPrevious(); c.bridge.setMediaVolumePercent(20);
  assert.equal(c.bridge.getAlbumArt(64), 'spotify');
  assert.deepEqual(c.calls, ['spotify:playPause', 'spotify:previous', 'spotify:volume:20']);

  // Switching sources changes the art version even when the sources' versions match.
  c.spotify.state = paused({ packageName: SPOTIFY, artVersion: 1, notice: 'Controlling Spotify playback needs Spotify Premium.' });
  c.session.state = playing({ packageName: 'org.videolan.vlc', title: 'Local', artVersion: 1 });
  const second = c.bridge.snapshot();
  assert.equal(second.title, 'Local');
  assert.notEqual(second.artVersion, first.artVersion);
  // A Spotify failure still shows while the session is the one shown.
  assert.equal(second.notice, 'Controlling Spotify playback needs Spotify Premium.');
});

test('the queue comes from the session, or the Web API when a Spotify session lists none, and jumps go to its source', async () => {
  const c = composite(playing({ packageName: SPOTIFY }), playing({ packageName: SPOTIFY }));
  c.session.queue = [{ id: 7, title: 'Next', active: false }];
  assert.equal(c.bridge.getQueue()[0].id, 7);
  await c.bridge.skipToQueueItem(7);
  c.session.queue = [];
  c.spotify.queue = [{ id: 1, title: 'Up next', subtitle: 'Band', active: false }];
  assert.equal(c.bridge.getQueue()[0].title, 'Up next');
  await c.bridge.skipToQueueItem(1);
  assert.deepEqual(c.calls.filter(call => call.includes('skipTo')), ['session:skipTo:7', 'spotify:skipTo:1']);

  // Not Spotify's session: its (empty) queue stands.
  c.session.state = playing({ packageName: 'org.videolan.vlc' });
  assert.deepEqual(plain(c.bridge.getQueue()), []);
});

test('a Spotify session changing track re-reads the Web API at once; listeners hear both sources', () => {
  const c = composite(playing({ packageName: SPOTIFY, title: 'Song a' }), playing({ packageName: SPOTIFY, title: 'Song a' }));
  const heard = [];
  const unsubscribe = c.bridge.onStateChange(state => heard.push(state.title));
  assert.deepEqual(c.calls, ['spotify:refresh']);
  c.session.listeners[0]({ ...c.session.state, positionMs: 5 });
  assert.deepEqual(c.calls, ['spotify:refresh']); // same track and play state
  c.session.state = playing({ packageName: SPOTIFY, title: 'Song b' });
  c.session.listeners[0](c.session.state);
  c.spotify.listeners[0](c.spotify.state);
  assert.deepEqual(c.calls, ['spotify:refresh', 'spotify:refresh']);
  assert.ok(heard.length >= 4);
  unsubscribe();
  assert.deepEqual(c.calls.slice(2), ['session:unsubscribe', 'spotify:unsubscribe']);
});

test('signed out of Spotify, the Android bridge is the media session', async () => {
  const c = composite(playing({ packageName: SPOTIFY, title: 'Song' }), { ...base, accessEnabled: false, status: 'Not signed in to Spotify.' });
  const state = c.bridge.snapshot();
  assert.equal(state.title, 'Song');
  assert.equal(state.customActions, undefined);
  await c.bridge.playPause(); await c.bridge.start(); await c.bridge.requestAccess();
  assert.equal(c.bridge.hasAccess(), true);
  assert.equal(c.bridge.getMediaVolumePercent(), 30);
  assert.deepEqual(c.calls, ['session:playPause', 'session:start', 'session:access']);
});

function browser({ installed = true, signedIn = true, enabled = true } = {}) {
  const api = load('app/native/media-browser.ts', {
    '@nativescript/core': { Utils: {} }, './media-apps': {}, './settings-store': {},
    './media-types': types,
    './spotify': { spotifyService: () => null },
    './spotify-player': { SPOTIFY_ANDROID_PACKAGE: SPOTIFY },
  });
  const calls = [];
  const vlc = { packageName: 'org.videolan.vlc', serviceClass: 'VlcBrowser', appName: 'VLC' };
  const spotifyService = { packageName: SPOTIFY, serviceClass: 'SpotifyMediaBrowserService', appName: 'Spotify' };
  const services = {
    listBrowsableApps: refresh => { calls.push(`services:list:${Boolean(refresh)}`); return installed ? [spotifyService, vlc] : [vlc]; },
    connect: async app => { calls.push(`services:connect:${app.packageName}`); return 'vlc-root'; },
    browse: async parentId => { calls.push(`services:browse:${parentId}`); return []; },
    playFromMediaId: mediaId => calls.push(`services:play:${mediaId}`),
    disconnect: () => calls.push('services:disconnect'),
  };
  const libraryApp = { packageName: SPOTIFY, serviceClass: '', appName: 'Spotify' };
  const library = {
    app: libraryApp,
    listBrowsableApps: () => (signedIn ? [libraryApp] : []),
    connect: async app => {
      calls.push(`library:connect:${app.serviceClass}`);
      if (!signedIn) throw new Error('Sign in under Spotify in the Music app menu first.');
      return 'root';
    },
    browse: async parentId => { calls.push(`library:browse:${parentId}`); return []; },
    playFromMediaId: mediaId => calls.push(`library:play:${mediaId}`),
    disconnect: () => calls.push('library:disconnect'),
  };
  const bridge = new api.AndroidMediaBrowserBridge(services, () => library, () => enabled);
  return { bridge, calls, vlc, spotifyService };
}

test('Spotify\'s library row opens the Web API library, or explains how to sign in', async () => {
  const b = browser();
  const apps = b.bridge.listBrowsableApps(true);
  assert.deepEqual(plain(apps.map(app => app.appName)), ['Spotify', 'VLC']);
  assert.equal(await b.bridge.connect(apps[0]), 'root');
  await b.bridge.browse('playlists');
  b.bridge.playFromMediaId('playlist:mine');
  assert.equal(await b.bridge.connect(b.vlc), 'vlc-root');
  await b.bridge.browse('vlc-root');
  b.bridge.disconnect();
  await assert.rejects(b.bridge.browse('root'), /Not connected/);
  assert.deepEqual(b.calls, ['services:list:true', 'library:connect:', 'library:browse:playlists', 'library:play:playlist:mine',
    'library:disconnect', 'services:connect:org.videolan.vlc', 'services:browse:vlc-root', 'services:disconnect']);

  const signedOut = browser({ signedIn: false });
  const [spotify] = signedOut.bridge.listBrowsableApps();
  await assert.rejects(signedOut.bridge.connect(spotify), /Sign in under Spotify/);

  // Not installed: the library is offered once signed in (it plays on other devices), unless Spotify is ignored.
  assert.deepEqual(plain(browser({ installed: false }).bridge.listBrowsableApps().map(app => app.appName)), ['VLC', 'Spotify']);
  assert.deepEqual(plain(browser({ installed: false, signedIn: false }).bridge.listBrowsableApps().map(app => app.appName)), ['VLC']);
  assert.deepEqual(plain(browser({ installed: false, enabled: false }).bridge.listBrowsableApps().map(app => app.appName)), ['VLC']);
});
