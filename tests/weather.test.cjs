const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const HOUR_MS = 60 * 60 * 1000;
const fix = { latitude: 37.7, longitude: -122.4, accuracyMeters: 8, timestampMs: 1234 };

/** weather.ts with fake timers, settings store and NWS responses. */
function weatherHarness({ periods, observation = null, store = new Map(), permission = () => true }) {
  const timers = new Map(), requests = [];
  let nextTimer = 1;
  const api = loader({
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn: () => { timers.delete(id); fn(); }, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  }, {
    './location-permissions': { hasLocationPermission: permission },
    './location': { getCurrentLocation: async () => fix },
    './settings-store': { getStringSetting: (key, fallback) => store.get(key) ?? fallback, setStringSetting: (key, value) => store.set(key, value) },
    '../version': { USER_AGENT: 'test' },
    '../util/http': { fetchWithUserAgent: async url => {
      requests.push(url);
      let body;
      if (url.includes('/points/')) {
        body = { properties: {
          forecast: 'https://fixture/forecast',
          observationStations: observation ? 'https://fixture/stations' : undefined,
          relativeLocation: { properties: { city: 'San Francisco', state: 'CA' } },
        } };
      } else if (url === 'https://fixture/stations') {
        body = { features: [{ id: 'https://fixture/station' }] };
      } else if (url.endsWith('/observations/latest')) {
        body = { properties: observation };
      } else {
        body = { properties: { periods } };
      }
      return { ok: true, json: async () => body };
    } },
  })('app/native/weather.ts');
  // Only the bridge's refresh timer outlives a refresh (fetch timeouts are cleared).
  const refreshTimer = () => {
    assert.ok(timers.size <= 1, `expected at most one timer, got ${timers.size}`);
    return [...timers.values()][0] ?? null;
  };
  return { api, store, requests, refreshTimer };
}

const sunny = { name: 'Today', temperature: 70, temperatureUnit: 'F', shortForecast: 'Sunny', isDaytime: true };

test('Weather takes the condition from the NWS icon, falling back to the text', async () => {
  const h = weatherHarness({
    periods: [
      { ...sunny, icon: 'https://api.weather.gov/icons/land/night/snow,60/rain,20?size=medium' },
      { ...sunny, name: 'Tonight', shortForecast: 'Chance Rain Showers', isDaytime: false },
      { ...sunny, name: 'Monday', shortForecast: 'Mostly Cloudy' },
    ],
    observation: {
      textDescription: 'Thunderstorms', icon: 'https://api.weather.gov/icons/land/day/tsra?size=medium',
      temperature: { value: 20, unitCode: 'wmoUnit:degC' },
    },
  });
  const bridge = new h.api.WeatherBridge();
  await bridge.refreshNow();
  const { current, forecast } = bridge.snapshot();
  assert.equal(current.condition, 'thunderstorm');
  assert.equal(current.isDaytime, true);
  assert.equal(current.temperatureF, 68);
  // The first code of a two-part icon, and its day/night segment.
  assert.equal(forecast[0].condition, 'snow');
  assert.equal(forecast[0].isDaytime, false);
  assert.equal(forecast[1].condition, 'showers');
  assert.equal(forecast[2].condition, 'cloudy');
});

test('Weather without an observation takes the condition from the first forecast period', async () => {
  const h = weatherHarness({ periods: [{ ...sunny, icon: 'https://api.weather.gov/icons/land/day/few?size=medium' }] });
  const bridge = new h.api.WeatherBridge();
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().current.condition, 'partly-cloudy');
  assert.equal(bridge.snapshot().current.observed, false);
});

test('Weather restores its cache on restart and refreshes hourly only during a session with an indicator on', async () => {
  const first = weatherHarness({ periods: [sunny] });
  const bridge = new first.api.WeatherBridge();
  await bridge.refreshNow();
  assert.ok(first.store.get('weather.cache'));

  // A restart shows the cached reading without fetching.
  const h = weatherHarness({ periods: [sunny], store: first.store });
  const restarted = new h.api.WeatherBridge();
  assert.equal(restarted.snapshot().phase, 'ready');
  assert.equal(restarted.snapshot().current.temperatureF, 70);
  assert.equal(h.requests.length, 0);

  restarted.setBackgroundRefresh(true);
  assert.equal(h.refreshTimer(), null, 'no refreshes outside a glasses session');
  restarted.setSessionActive(true);
  const timer = h.refreshTimer();
  assert.ok(timer.ms > HOUR_MS - 60_000 && timer.ms <= HOUR_MS, `fresh cache waits out the hour (${timer.ms})`);
  restarted.setBackgroundRefresh(false);
  assert.equal(h.refreshTimer(), null);
  restarted.setBackgroundRefresh(true);
  restarted.setSessionActive(false);
  assert.equal(h.refreshTimer(), null);
});

test('Weather refreshes a stale cache at once and backs off after a failure', async () => {
  const store = new Map([['weather.cache', JSON.stringify({
    version: 1, locationName: 'Old', current: null, forecast: [], lastUpdatedMs: Date.now() - 2 * HOUR_MS,
  })]]);
  let permission = true;
  const h = weatherHarness({ periods: [sunny], store, permission: () => permission });
  const bridge = new h.api.WeatherBridge();
  bridge.setBackgroundRefresh(true);
  bridge.setSessionActive(true);
  assert.equal(h.refreshTimer().ms, 0);

  h.refreshTimer().fn();
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().locationName, 'San Francisco, CA');
  assert.ok(h.refreshTimer().ms > HOUR_MS - 60_000);

  // Without permission the attempt fails; the next one waits the retry delay, not zero.
  permission = false;
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().phase, 'permission-required');
  const retry = h.refreshTimer().ms;
  assert.ok(retry > 9 * 60_000 && retry <= 10 * 60_000, `retry delay ${retry}`);
});

/** weather-indicators.ts with a fake shell, settings and bridge. */
function indicatorHarness() {
  const settings = new Map(), settingListeners = new Set(), stateListeners = new Set(), trays = [];
  const background = [];
  let state = { phase: 'ready', current: null, forecast: [], lastUpdatedMs: null };
  class GrayImage {
    constructor(width, height) { this.width = width; this.height = height; this.draws = []; }
    drawImage(_source, x, y) { this.draws.push(['image', x, y]); }
    drawText(_font, x, y, text) { this.draws.push(['text', x, y, text]); }
    withDrawsBaked() { return this; }
  }
  const font = { lineHeight: 12, measureText: text => text.length * 6 };
  class Setting {
    constructor(options) { Object.assign(this, options); }
    get() { return settings.get(this.storageKey) ?? this.defaultValue; }
  }
  const api = loader({}, {
    '../../graphics/image': { GrayImage },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/icons': { renderSvgIcon: (_name, _svg, size) => new GrayImage(size, size) },
    '../../native/weather': { weatherBridge: {
      onStateChange: listener => { stateListeners.add(listener); listener(state); return () => stateListeners.delete(listener); },
      snapshot: () => state,
      setBackgroundRefresh: enabled => background.push(enabled),
    } },
    '../../ui/dashboard-settings': {
      ConfigSettingBoolean: Setting,
      onAnySettingChanged: listener => { settingListeners.add(listener); return () => settingListeners.delete(listener); },
    },
    '../../ui/shell/shell': { shell: { setTrayIcon: (id, icon) => trays.push([id, icon]) } },
  })('app/apps/weather/weather-indicators.ts');
  return {
    api, trays, background,
    setSetting(key, value) { settings.set(key, value); for (const listener of settingListeners) listener(); },
    setState(next) { state = next; for (const listener of stateListeners) listener(state); },
  };
}

test('Weather tray icon follows the status-bar setting and hides a stale reading', () => {
  const h = indicatorHarness();
  h.api.startWeatherIndicators();
  assert.deepEqual(h.background, [false]);
  assert.equal(h.trays.length, 0, 'nothing shown, nothing to clear');

  h.setSetting('weather.showOnSystemCard', true);
  assert.equal(h.background.at(-1), true, 'the system card alone keeps refreshes running');
  assert.equal(h.trays.length, 0);

  h.setSetting('weather.showInStatusBar', true);
  const current = { temperatureF: 71.6, condition: 'rain', isDaytime: true };
  h.setState({ phase: 'ready', current, forecast: [], lastUpdatedMs: Date.now() });
  const [id, icon] = h.trays.at(-1);
  assert.equal(id, 'weather');
  assert.equal(icon.height, 24);
  assert.deepEqual(icon.draws.map(draw => draw[0]), ['image', 'text']);
  assert.equal(icon.draws[1][3], '72°');

  // An unchanged reading does not rebuild the icon.
  const count = h.trays.length;
  h.setState({ phase: 'loading', current, forecast: [], lastUpdatedMs: Date.now() });
  assert.equal(h.trays.length, count);

  h.setState({ phase: 'error', current, forecast: [], lastUpdatedMs: Date.now() - 4 * HOUR_MS });
  assert.deepEqual(h.trays.at(-1), ['weather', null]);

  h.setSetting('weather.showOnSystemCard', false);
  h.setSetting('weather.showInStatusBar', false);
  assert.equal(h.background.at(-1), false);
});
