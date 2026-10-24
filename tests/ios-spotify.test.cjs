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

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

/** Values from the sandbox carry its own Array/Object prototypes; compare their plain JSON form. */
const plain = value => JSON.parse(JSON.stringify(value));

/** settings-store stand-in: synchronous change notifications. */
function fakeSettings(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Set();
  return {
    values,
    getStringSetting: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    setStringSetting: (key, value) => { values.set(key, value); for (const listener of listeners) listener(key); },
    onSettingsStoreChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** Manual timers: run() fires everything due, in order. */
function fakeTimers() {
  let now = 1_000_000; let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => { const id = nextId++; pending.set(id, { fn, at: now + (delay || 0) }); return id; },
    clearTimeout: id => pending.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.has(id)) { pending.delete(id); timer.fn(); }
      }
    },
    delays: () => [...pending.values()].map(timer => timer.at - now),
  };
}

/**
 * Spotify's endpoints as a route table: "METHOD /path" -> response or function(call).
 * Records every call with its parsed URL, headers and body.
 */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const call = { url, method: init.method, path: parsed.pathname.replace('/v1', ''), query: Object.fromEntries(parsed.searchParams),
      headers: init.headers, body: init.body };
    calls.push(call);
    let route = routes[`${init.method} ${call.path}`];
    if (typeof route === 'function') route = route(call);
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
    const { status = 200, body = '' } = route ?? { status: 404, body: '{"error":{"status":404,"message":"no route"}}' };
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

function loadSpotify({ settings = fakeSettings(), timers = null } = {}) {
  const globals = timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {};
  const types = load('app/native/media-types.ts');
  const api = load('app/native/spotify-web-api.ts', {}, globals);
  const auth = load('app/native/spotify-auth.ts', { './settings-store': settings, './spotify-web-api': api }, globals);
  const player = load('app/native/spotify-player.ts', { './media-types': types, './spotify-web-api': api }, globals);
  const library = load('app/native/spotify-library.ts', { './spotify-player': player }, globals);
  const service = load('app/native/spotify-service.ts', {
    './settings-store': settings, './spotify-auth': auth, './spotify-library': library, './spotify-player': player, './spotify-web-api': api,
  }, globals);
  return { types, api, auth, player, library, service, settings };
}

function signedIn(extra = {}) {
  return fakeSettings({
    'music.spotify.clientId': CLIENT_ID,
    'music.spotify.account': JSON.stringify({ clientId: CLIENT_ID, accessToken: 'access-1', refreshToken: 'refresh-1',
      expiresAtMs: 9e15, userId: 'jim', displayName: 'Jim', product: 'premium', ...extra }),
  });
}

const tokens = { accessToken: async force => (force ? 'fresh' : 'stale') };

function track(id, extra = {}) {
  return { type: 'track', uri: `spotify:track:${id}`, name: `Song ${id}`, duration_ms: 200_000,
    artists: [{ name: 'Band' }, { name: 'Guest' }], album: { name: 'Record', images: [
      { url: 'https://i.scdn.co/640', width: 640, height: 640 },
      { url: 'https://i.scdn.co/300', width: 300, height: 300 },
      { url: 'https://i.scdn.co/64', width: 64, height: 64 }] }, ...extra };
}

function playbackBody(extra = {}) {
  return { device: { id: 'phone', name: "Jim's iPhone", type: 'Smartphone', is_active: true, volume_percent: 70, supports_volume: false },
    is_playing: true, progress_ms: 30_000, shuffle_state: false, repeat_state: 'off', context: { uri: 'spotify:playlist:p1' },
    item: track('a'), currently_playing_type: 'track', actions: { disallows: { resuming: true } }, ...extra };
}

test('the Web API client parses playback, retries a 401 with a fresh token and names player errors', async () => {
  const { api } = loadSpotify();
  const f = fakeFetch({
    'GET /me/player': [{ status: 401, body: '' }, { body: playbackBody({
      item: { type: 'episode', uri: 'spotify:episode:e', name: 'Ep', duration_ms: 1000, images: [], show: { name: 'Show', images: [{ url: 'u', width: 300 }] } },
    }) }],
    'PUT /me/player/play': { status: 404, body: { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } } },
    'POST /me/player/next': { status: 403, body: { error: { status: 403, message: 'Premium required', reason: 'PREMIUM_REQUIRED' } } },
    'PUT /me/player/pause': { status: 204 },
  });
  const client = new api.SpotifyClient(f.fetch, tokens);
  const playback = await client.playback();
  assert.deepEqual(f.calls.map(call => call.headers.Authorization), ['Bearer stale', 'Bearer fresh']);
  assert.equal(f.calls[0].query.additional_types, 'episode');
  assert.equal(playback.playing, true); assert.equal(playback.device.type, 'Smartphone'); assert.equal(playback.device.volumePercent, 70);
  assert.deepEqual(plain(playback.disallows), ['resuming']); assert.equal(playback.contextUri, 'spotify:playlist:p1');
  assert.equal(playback.item.type, 'episode'); assert.equal(playback.item.artists, 'Show'); assert.equal(playback.item.images[0].url, 'u');

  await assert.rejects(client.play({ contextUri: 'spotify:album:x', offsetUri: 'spotify:track:y' }),
    error => error instanceof api.SpotifyApiError && error.reason === 'NO_ACTIVE_DEVICE' && /Open Spotify/.test(error.message));
  const play = f.calls.find(call => call.path === '/me/player/play');
  assert.deepEqual(JSON.parse(play.body), { context_uri: 'spotify:album:x', offset: { uri: 'spotify:track:y' } });
  assert.equal(play.headers['Content-Type'], 'application/json');
  await assert.rejects(client.next(), /needs Spotify Premium/);
  // Body-less commands still send an (empty) body, or Spotify answers 411.
  await client.pause();
  assert.equal(f.calls.at(-1).body, '');
  assert.equal(f.calls.find(call => call.method === 'GET').body, undefined);
});

test('the Web API client follows next links and reads the renamed playlist item field', async () => {
  const { api } = loadSpotify();
  const f = fakeFetch({
    'GET /playlists/p1/items': call => (call.query.offset === '2'
      ? { body: { items: [{ track: track('c') }], next: null } }
      : { body: { items: [{ item: track('a') }, { item: null }, { item: track('b') }], next: 'https://api.spotify.com/v1/playlists/p1/items?offset=2' } }),
    'GET /me/following': { body: { artists: { items: [{ id: 'ar', name: 'Artist', uri: 'spotify:artist:ar' }], next: null } } },
    'GET /search': { body: { tracks: { items: [track('s')] }, playlists: { items: [null, { id: 'pl', name: 'Mix', owner: { id: 'o' } }] } } },
  });
  const client = new api.SpotifyClient(f.fetch, tokens);
  assert.deepEqual(plain((await client.playlistItems('p1')).map(item => item.name)), ['Song a', 'Song b', 'Song c']);
  assert.equal(f.calls[0].query.limit, '50');
  assert.equal((await client.followedArtists())[0].name, 'Artist');
  const results = await client.search('daft punk', ['track', 'playlist'], 50);
  assert.equal(f.calls.at(-1).query.limit, '10'); // development-mode maximum
  assert.equal(f.calls.at(-1).query.q, 'daft punk');
  assert.equal(results.tracks[0].artists, 'Band, Guest');
  assert.equal(results.playlists.length, 1); assert.equal(results.playlists[0].uri, 'spotify:playlist:pl');
});

test('sign-in builds a PKCE authorize URL, exchanges the code and stores the account', async () => {
  const settings = fakeSettings({ 'music.spotify.clientId': CLIENT_ID });
  const { auth } = loadSpotify({ settings });
  const f = fakeFetch({
    'POST /api/token': { body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } },
    'GET /me': { body: { id: 'jim', display_name: 'Jim', product: 'premium' } },
  });
  let opened = null;
  const webSignIn = {
    createPkce: () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
    randomState: () => 'state-1',
    open: async (url, port, redirectPath) => {
      opened = { url, port, redirectPath };
      return 'http://127.0.0.1:43823/spotify-callback?code=AQB%2Fcode&state=state-1';
    },
    cancel: () => {},
  };
  const account = await auth.signInToSpotify(f.fetch, webSignIn, () => 5_000);
  const authorize = new URL(opened.url);
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:43823/spotify-callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge'), 'challenge-1');
  assert.match(authorize.searchParams.get('scope'), /user-modify-playback-state .*user-library-modify/);
  assert.deepEqual([opened.port, opened.redirectPath], [43823, '/spotify-callback']);

  const exchange = Object.fromEntries(new URLSearchParams(f.calls[0].body));
  assert.deepEqual(exchange, { grant_type: 'authorization_code', code: 'AQB/code', redirect_uri: 'http://127.0.0.1:43823/spotify-callback',
    client_id: CLIENT_ID, code_verifier: 'verifier-1' });
  assert.equal(f.calls[1].headers.Authorization, 'Bearer access-1');
  assert.equal(account.displayName, 'Jim'); assert.equal(account.expiresAtMs, 5_000 + 3_600_000);
  assert.equal(auth.readSpotifyAccount().refreshToken, 'refresh-1');

  // Another client ID: the stored sign-in no longer counts.
  settings.setStringSetting('music.spotify.clientId', 'f'.repeat(32));
  assert.equal(auth.readSpotifyAccount(), null);
});

test('redirect parsing rejects mismatched state and reports a declined sign-in', () => {
  const { auth } = loadSpotify();
  assert.equal(auth.parseSpotifyRedirect('http://127.0.0.1:1/cb?state=s&code=a%20b', 's'), 'a b');
  assert.throws(() => auth.parseSpotifyRedirect('http://127.0.0.1:1/cb?state=x&code=a', 's'), /didn't match/);
  assert.throws(() => auth.parseSpotifyRedirect('http://127.0.0.1:1/cb?error=access_denied&state=s', 's'), /declined/);
  assert.throws(() => auth.parseSpotifyRedirect('http://127.0.0.1:1/cb?state=s', 's'), /no authorization code/);
});

test('the session refreshes an expired token once for concurrent callers and signs out when revoked', async () => {
  const settings = signedIn({ expiresAtMs: 0 });
  const { auth } = loadSpotify({ settings });
  let refreshes = 0;
  const f = fakeFetch({ 'POST /api/token': () => {
    refreshes++;
    return refreshes === 1 ? { body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } }
      : { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } };
  } });
  const session = new auth.SpotifySession(f.fetch, () => 10_000);
  assert.deepEqual(await Promise.all([session.accessToken(false), session.accessToken(false)]), ['access-2', 'access-2']);
  assert.equal(refreshes, 1);
  assert.equal(Object.fromEntries(new URLSearchParams(f.calls[0].body)).refresh_token, 'refresh-1');
  // The rotated refresh token is kept; the new access token is used until it nears expiry.
  assert.equal(auth.readSpotifyAccount().refreshToken, 'refresh-2');
  assert.equal(await session.accessToken(false), 'access-2'); assert.equal(refreshes, 1);

  await assert.rejects(session.accessToken(true), /Sign in again/);
  assert.equal(auth.readSpotifyAccount(), null);
  await assert.rejects(session.accessToken(false), /Not signed in/);
});

function playerFixture({ routes = {}, settings = signedIn() } = {}) {
  const timers = fakeTimers();
  const s = loadSpotify({ settings, timers });
  const f = fakeFetch({ 'GET /me/player': { body: playbackBody() }, 'GET /me/library/contains': { body: [false] },
    'GET /me/player/queue': { body: { currently_playing: track('a'), queue: [track('b'), track('c', { artists: [{ name: 'Other' }] })] } },
    ...routes });
  const downloads = []; const decodes = []; const system = { volume: 40, set: [] };
  const service = new s.service.SpotifyService({
    fetch: f.fetch,
    webSignIn: { createPkce: () => ({}), randomState: () => '', open: async () => '', cancel: () => {} },
    download: async url => { downloads.push(url); return new Uint8Array([1, 2, 3]); },
    decodeArt: (_bytes, size) => { decodes.push(size); return { size }; },
    systemVolume: { get: () => system.volume, set: value => system.set.push(value) },
  });
  // The player reads time from Date.now by default; give it the fake clock.
  const player = new s.player.SpotifyPlayer({ client: service.client, isSignedIn: () => s.auth.readSpotifyAccount() !== null,
    download: async url => { downloads.push(url); return new Uint8Array([1, 2, 3]); },
    decodeArt: (_bytes, size) => { decodes.push(size); return { size }; },
    systemVolume: { get: () => system.volume, set: value => system.set.push(value) }, now: timers.now });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
  return { ...s, f, timers, service, player, downloads, decodes, system, settle };
}

test('the player polls while listened to and maps playback, art and actions into the media state', async () => {
  const p = playerFixture();
  const states = [];
  const unsubscribe = p.player.onStateChange(state => states.push(state));
  assert.equal(states[0].available, false); assert.equal(states[0].accessEnabled, true);
  p.timers.advance(0); await p.settle();
  const state = p.player.snapshot();
  assert.equal(state.available, true); assert.equal(state.playbackState, 'playing');
  assert.equal(state.title, 'Song a'); assert.equal(state.artist, 'Band, Guest'); assert.equal(state.album, 'Record');
  assert.equal(state.appName, 'Spotify'); assert.equal(state.packageName, 'com.spotify.client');
  assert.equal(state.canPlayPause, true); assert.equal(state.canSkipNext, true);
  assert.deepEqual(plain(state.customActions.map(action => action.name)), ['Shuffle: off', 'Repeat: off', 'Like song']);
  // The 300px image (the smallest at least 128 wide), downloaded once and decoded per size.
  assert.deepEqual(p.downloads, ['https://i.scdn.co/300']);
  assert.deepEqual(plain(p.player.getAlbumArt(112)), { size: 112 }); p.player.getAlbumArt(112);
  assert.deepEqual(p.decodes, [112]);
  // Position advances between polls.
  p.timers.advance(1_000);
  assert.equal(p.player.snapshot().positionMs, 31_000);
  // Polling continues on a playing interval, and stops with the last listener.
  assert.ok(p.timers.delays().some(delay => delay > 0 && delay <= 5_000));
  unsubscribe();
  assert.deepEqual(p.timers.delays(), []);
});

test('pausing applies at once, resuming with no active device starts on an open phone, and failures become a notice', async () => {
  let active = true;
  const p = playerFixture({ routes: {
    'PUT /me/player/pause': { status: 204 },
    'PUT /me/player/play': call => (call.query.device_id || active ? { status: 204 }
      : { status: 404, body: { error: { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'none' } } }),
    'GET /me/player/devices': { body: { devices: [
      { id: 'mac', name: 'MacBook', type: 'Computer', is_active: false },
      { id: 'iphone', name: 'iPhone', type: 'Smartphone', is_active: false },
      { id: 'tv', name: 'TV', type: 'TV', is_restricted: true }] } },
    'POST /me/player/next': { status: 403, body: { error: { status: 403, reason: 'PREMIUM_REQUIRED', message: 'x' } } },
  } });
  p.player.onStateChange(() => {});
  p.timers.advance(0); await p.settle();
  await p.player.playPause();
  assert.equal(p.player.snapshot().playbackState, 'paused');
  assert.equal(p.f.calls.filter(call => call.path === '/me/player/pause').length, 1);

  active = false;
  await p.player.playPause();
  const plays = p.f.calls.filter(call => call.path === '/me/player/play');
  assert.deepEqual(plays.map(call => call.query.device_id ?? ''), ['', 'iphone']);
  assert.deepEqual(JSON.parse(plays[1].body), {});

  await p.player.skipNext();
  assert.match(p.player.snapshot().notice, /Premium/);
  // A settle poll re-reads soon after each command.
  assert.ok(p.timers.delays().some(delay => delay <= 600));
  p.timers.advance(8_100);
  assert.equal(p.player.snapshot().notice, '');
});

test('the queue lists the current track first and jumping skips forward to the chosen item', async () => {
  const p = playerFixture({ routes: { 'POST /me/player/next': { status: 204 } } });
  p.player.onStateChange(() => {});
  p.timers.advance(0); await p.settle();
  assert.deepEqual(plain(p.player.getQueue()), []); // first read in flight
  await p.settle();
  assert.deepEqual(plain(p.player.getQueue().map(item => [item.id, item.title, item.subtitle, item.active])),
    [[0, 'Song a', 'Band, Guest', true], [1, 'Song b', 'Band, Guest', false], [2, 'Song c', 'Other', false]]);
  await p.player.skipToQueueItem(2);
  assert.equal(p.f.calls.filter(call => call.path === '/me/player/next').length, 2);
  assert.equal(p.player.snapshot().title, 'Song c');
  assert.deepEqual(plain(p.player.getQueue().map(item => item.title)), ['Song c']);
});

test('volume goes to a speaker through Spotify and to this phone through the system volume', async () => {
  const p = playerFixture({ routes: {
    'GET /me/player': { body: playbackBody({ device: { id: 'spk', name: 'Kitchen', type: 'Speaker', is_active: true, volume_percent: 30, supports_volume: true } }) },
    'PUT /me/player/volume': { status: 204 },
  } });
  p.player.onStateChange(() => {});
  p.timers.advance(0); await p.settle();
  assert.equal(p.player.snapshot().appName, 'Spotify · Kitchen');
  assert.equal(p.player.getMediaVolumePercent(), 30);
  p.player.setMediaVolumePercent(32); p.player.setMediaVolumePercent(34);
  assert.equal(p.player.getMediaVolumePercent(), 34);
  await p.settle();
  const volumes = p.f.calls.filter(call => call.path === '/me/player/volume');
  // One request in flight; the latest value follows it.
  assert.deepEqual(volumes.map(call => [call.query.volume_percent, call.query.device_id]), [['32', 'spk'], ['34', 'spk']]);

  const phone = playerFixture();
  phone.player.onStateChange(() => {});
  phone.timers.advance(0); await phone.settle();
  assert.equal(phone.player.getMediaVolumePercent(), 40);
  phone.player.setMediaVolumePercent(55);
  assert.deepEqual(phone.system.set, [55]);
  assert.equal(phone.f.calls.some(call => call.path === '/me/player/volume'), false);
});

test('shuffle, repeat and like run their Web API calls and relabel at once', async () => {
  const p = playerFixture({ routes: {
    'PUT /me/player/shuffle': { status: 204 }, 'PUT /me/player/repeat': { status: 204 }, 'PUT /me/library': { status: 200 },
  } });
  p.player.onStateChange(() => {});
  p.timers.advance(0); await p.settle();
  await p.player.sendCustomAction('shuffle');
  await p.player.sendCustomAction('repeat');
  await p.player.sendCustomAction('like');
  assert.deepEqual(plain(p.player.snapshot().customActions.map(action => action.name)), ['Shuffle: on', 'Repeat: all', 'Unlike song']);
  const calls = p.f.calls.filter(call => call.method === 'PUT');
  assert.deepEqual(calls.map(call => [call.path, call.query.state ?? call.query.uris]),
    [['/me/player/shuffle', 'true'], ['/me/player/repeat', 'context'], ['/me/library', 'spotify:track:a']]);
});

test('signed out, the player reports no access and never calls the API', async () => {
  const p = playerFixture({ settings: fakeSettings({ 'music.spotify.clientId': CLIENT_ID }) });
  p.player.onStateChange(() => {});
  p.timers.advance(0); await p.settle();
  assert.equal(p.player.snapshot().accessEnabled, false);
  assert.equal(p.f.calls.length, 0);
});

test('the library tree lists owned playlists as browsable and plays tracks within their context', async () => {
  const s = loadSpotify({ settings: signedIn() });
  const f = fakeFetch({
    'GET /me/playlists': { body: { items: [
      { id: 'mine', name: 'Mine', owner: { id: 'jim' } },
      { id: 'theirs', name: 'Theirs', owner: { id: 'spotify', display_name: 'Spotify' } },
      { id: 'collab', name: 'Collab', collaborative: true, owner: { id: 'friend' } }], next: null } },
    'GET /me/player/recently-played': { body: { items: [
      { track: track('a'), context: { uri: 'spotify:album:al' } }, { track: track('a'), context: null }, { track: track('b'), context: null }] } },
  });
  const plays = [];
  const library = new s.library.SpotifyLibrary({ client: new s.api.SpotifyClient(f.fetch, tokens),
    player: { startPlayback: async request => { plays.push(request); return true; } },
    isSignedIn: () => true, userId: () => 'jim' });
  const [app] = library.listBrowsableApps();
  assert.equal(await library.connect(app), 'root');
  assert.deepEqual(plain((await library.browse('root')).map(row => row.title)), ['Recently played', 'Playlists', 'Liked Songs', 'Albums', 'Artists']);
  const playlists = await library.browse('playlists');
  assert.deepEqual(plain(playlists.map(row => [row.title, row.browsable, row.subtitle])),
    [['Mine', true, ''], ['Theirs', false, 'Spotify'], ['Collab', true, '']]);
  const recent = await library.browse('recent');
  assert.deepEqual(plain(recent.map(row => row.mediaId)), ['track:spotify:track:a|spotify:album:al', 'track:spotify:track:b']);

  library.playFromMediaId(recent[0].mediaId);
  library.playFromMediaId(recent[1].mediaId);
  library.playFromMediaId('track:spotify:track:z|liked');
  library.playFromMediaId('liked');
  library.playFromMediaId('playlist:mine');
  assert.deepEqual(plain(plays), [
    { contextUri: 'spotify:album:al', offsetUri: 'spotify:track:a' },
    { uris: ['spotify:track:b'] },
    { contextUri: 'spotify:user:jim:collection', offsetUri: 'spotify:track:z' },
    { contextUri: 'spotify:user:jim:collection' },
    { contextUri: 'spotify:playlist:mine' },
  ]);
  library.disconnect();
  await assert.rejects(library.browse('root'), /Not connected/);
});

test('search-and-play starts the best match and explains failures', async () => {
  const p = playerFixture({ routes: {
    'GET /search': call => ({ body: call.query.type === 'album'
      ? { albums: { items: [{ id: 'al', name: 'Discovery', uri: 'spotify:album:al', artists: [{ name: 'Daft Punk' }] }] } }
      : { tracks: { items: [] } } }),
    'PUT /me/player/play': { status: 204 },
  } });
  assert.equal(await p.service.playSearch('discovery', 'album'), 'the album Discovery by Daft Punk');
  const play = p.f.calls.find(call => call.path === '/me/player/play');
  assert.deepEqual(JSON.parse(play.body), { context_uri: 'spotify:album:al' });
  await assert.rejects(p.service.playSearch('nothing'), /found no track/);
});

test('the service resets the player when the signed-in account changes, not when tokens refresh', async () => {
  const p = playerFixture();
  const reset = [];
  p.service.player.accountChanged = () => reset.push('reset');
  const changes = [];
  p.service.onChange(() => changes.push('change'));
  const account = JSON.parse(p.settings.values.get('music.spotify.account'));
  p.settings.setStringSetting('music.spotify.account', JSON.stringify({ ...account, accessToken: 'access-9' }));
  assert.deepEqual(reset, []);
  p.service.signOut();
  assert.deepEqual(reset, ['reset']);
  assert.equal(p.service.account(), null);
  assert.ok(changes.length >= 2);
});

function composite(appleState, spotifyState, spotifyLastPlayingAtMs = 0) {
  const types = load('app/native/media-types.ts');
  const calls = [];
  const fakeBridge = (name, state) => ({
    accessLabel: `${name} label`, accessAction: `${name} action`, skipRebuildsQueue: name === 'spotify', state, lastPlayingAtMs: 0,
    onStateChange(listener) { listener(this.state); return () => {}; },
    snapshot() { return this.state; }, start: async () => calls.push(`${name}:start`), stop: async () => {},
    playPause: async () => calls.push(`${name}:playPause`), skipNext: async () => calls.push(`${name}:next`),
    getAlbumArt: () => name, getQueue: () => [], refresh: async () => calls.push(`${name}:refresh`),
    hasAccess: () => name === 'apple', requestAccess: async () => calls.push(`${name}:access`),
  });
  const apple = fakeBridge('apple', appleState);
  const spotify = fakeBridge('spotify', spotifyState);
  spotify.lastPlayingAtMs = spotifyLastPlayingAtMs;
  const api = load('app/native/media-controller.ios.ts', {
    '@nativescript/core': { Dialogs: {}, Utils: {} }, './image-files': {}, './kotlin-data': {}, './media-types': types,
    './spotify.ios': { spotifyService: () => null },
  });
  const bridge = new api.IosMediaControllerBridge(apple, () => (spotifyState ? spotify : null), () => 50);
  return { api, bridge, calls, apple, spotify, types };
}

test('the iOS bridge follows whichever player is playing and routes commands to it', async () => {
  const types = load('app/native/media-types.ts');
  const base = { ...types.DEFAULT_MEDIA_STATE, accessEnabled: true };
  const playing = { ...base, available: true, playbackState: 'playing', title: 'Playing' };
  const paused = { ...base, available: true, playbackState: 'paused', title: 'Paused' };
  const { chooseMediaSource } = composite(base, null).api;
  assert.equal(chooseMediaSource('apple-music', base, null, 0, 0), 'apple-music');
  assert.equal(chooseMediaSource('apple-music', { ...base, accessEnabled: false }, base, 0, 0), 'spotify');
  assert.equal(chooseMediaSource('apple-music', paused, playing, 0, 0), 'spotify');
  assert.equal(chooseMediaSource('spotify', playing, paused, 0, 0), 'apple-music');
  assert.equal(chooseMediaSource('spotify', playing, playing, 0, 0), 'spotify'); // no flapping
  assert.equal(chooseMediaSource('spotify', paused, paused, 20, 10), 'apple-music'); // played last
  assert.equal(chooseMediaSource('apple-music', paused, paused, 0, 0), 'spotify');
  assert.equal(chooseMediaSource('apple-music', paused, base, 0, 0), 'apple-music');

  const c = composite(paused, { ...playing, notice: '' });
  assert.equal(c.bridge.snapshot().title, 'Playing');
  assert.equal(c.bridge.skipRebuildsQueue, true);
  await c.bridge.playPause(); await c.bridge.refresh();
  assert.deepEqual(c.calls, ['spotify:playPause', 'spotify:refresh']);
  assert.equal(c.bridge.getAlbumArt(10), 'spotify');
  const firstArt = c.bridge.snapshot().artVersion;
  // Switching players changes the art version even when the sources' versions match.
  c.spotify.state = { ...paused, notice: 'Spotify needs Premium' };
  c.apple.state = { ...playing, title: 'Apple' };
  const state = c.bridge.snapshot();
  assert.equal(state.title, 'Apple'); assert.notEqual(state.artVersion, firstArt);
  // A Spotify failure still shows while Apple Music is the player shown.
  assert.equal(state.notice, 'Spotify needs Premium');
  assert.equal(c.bridge.hasAccess(), true); // Apple Music's permission
  await c.bridge.requestAccess();
  assert.equal(c.calls.at(-1), 'apple:access');

  const idle = composite(base, base);
  assert.equal(idle.bridge.snapshot().status, 'Nothing is playing.');
});

test('the assistant offers Spotify search-and-play once signed in and refreshes before reading media state', async () => {
  let account = null; const searches = []; const refreshes = [];
  const spotify = {
    account: () => account,
    playSearch: async (query, kind) => { searches.push([query, kind]); if (query === 'fail') throw new Error('No device'); return 'Song by Band'; },
  };
  const registered = new Map(); const systemTools = new Map();
  const { registerSystemTools } = load('app/assistant/system-tools.ts', {
    '../native/calendar': {}, '../native/calendar-permissions': {},
    '../native/media-controller': { mediaControllerBridge: { start: async () => {}, refresh: async () => refreshes.push('refresh'),
      snapshot: () => ({ accessEnabled: true, playbackState: 'playing', title: 'Song', artist: 'Band', appName: 'Spotify' }) } },
    '../native/spotify': { spotifyService: () => spotify },
    '../native/notification-icons': {}, '../ui/shell/shell': {}, './tool-registry': {},
  }, { global: { isIOS: true } });
  registerSystemTools({
    registerSystemTool: (definition, handler) => systemTools.set(definition.name, handler),
    register: registration => registered.set(registration.spec.name, registration),
  });
  assert.match((await systemTools.get('media.now_playing')()).content, /Playing: Song by Band in Spotify/);
  assert.deepEqual(refreshes, ['refresh']);

  const tool = registered.get('media.spotify_play');
  assert.equal(tool.spec.availability, 'always');
  assert.equal(tool.isAvailable(), false);
  account = { userId: 'jim' };
  assert.equal(tool.isAvailable(), true);
  assert.equal((await tool.handler({ query: ' discovery ', kind: 'album' })).content, 'Playing Song by Band on Spotify.');
  await tool.handler({ query: 'x', kind: 'podcast' });
  assert.deepEqual(plain(searches), [['discovery', 'album'], ['x', 'track']]);
  assert.equal((await tool.handler({ query: 'fail' })).error, 'No device');
  assert.equal((await tool.handler({ query: '  ' })).ok, false);
});
