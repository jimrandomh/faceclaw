const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const HOUR_MS = 60 * 60 * 1000;
const fix = { latitude: 37.7, longitude: -122.4, accuracyMeters: 8, timestampMs: 1234 };

/**
 * weather.ts with fake timers, settings store and NWS responses. Without
 * NWS periods, the NWS point lookup 404s and openMeteo answers instead.
 * nowMs, if given, fixes the module's clock.
 */
function weatherHarness({
  periods, observation = null, openMeteo = null, place = null, store = new Map(), permission = () => true, nowMs,
}) {
  const timers = new Map(), requests = [];
  let nextTimer = 1;
  const api = loader({
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn: () => { timers.delete(id); fn(); }, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    ...(nowMs === undefined ? {} : { Date: class extends Date { static now() { return nowMs; } } }),
  }, {
    './location-permissions': { hasLocationPermission: permission },
    './location': { getCurrentLocation: async () => fix },
    './reverse-geocode': { reverseGeocode: async () => place },
    './settings-store': { getStringSetting: (key, fallback) => store.get(key) ?? fallback, setStringSetting: (key, value) => store.set(key, value) },
    '../version': { USER_AGENT: 'test' },
    '../util/http': { fetchWithUserAgent: async url => {
      requests.push(url);
      let body;
      if (url.startsWith('https://api.open-meteo.com/')) {
        body = openMeteo;
      } else if (url.includes('/points/')) {
        if (!periods) return { ok: false, status: 404 };
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

/**
 * An Open-Meteo answer (Fahrenheit, mph, unix seconds) whose hourly
 * forecast starts at local midnight today, with hourly values from
 * hour(index) (all fields optional).
 */
function openMeteoResponse({ offsetHours = 0, nowMs = Date.now(), hours = 192, hour = () => ({}), current = {} } = {}) {
  const offsetMs = offsetHours * HOUR_MS;
  const midnightMs = Math.floor((nowMs + offsetMs) / (24 * HOUR_MS)) * 24 * HOUR_MS - offsetMs;
  const hourly = { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [], wind_speed_10m: [], wind_direction_10m: [] };
  for (let index = 0; index < hours; index++) {
    const values = { temperature_2m: 60, precipitation_probability: 0, weather_code: 0, wind_speed_10m: 5, wind_direction_10m: 180, ...hour(index) };
    hourly.time.push((midnightMs + index * HOUR_MS) / 1000);
    for (const key of Object.keys(values)) hourly[key].push(values[key]);
  }
  return {
    utc_offset_seconds: offsetHours * 3600,
    current: { time: Math.floor(nowMs / 1000), temperature_2m: 64.2, relative_humidity_2m: 94, is_day: 1, weather_code: 2, wind_speed_10m: 2.7, wind_direction_10m: 292, ...current },
    hourly,
  };
}

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

test('Weather outside NWS coverage falls back to Open-Meteo and names the place with the geocoder', async () => {
  const h = weatherHarness({
    openMeteo: openMeteoResponse({ offsetHours: 10 }),
    place: { locality: 'Sydney', region: 'New South Wales', country: 'Australia' },
  });
  const bridge = new h.api.WeatherBridge();
  await bridge.refreshNow();
  const state = bridge.snapshot();
  assert.equal(state.phase, 'ready', state.status);
  assert.equal(state.source, 'open-meteo');
  assert.equal(state.locationName, 'Sydney, Australia');
  assert.equal(h.requests.length, 2, 'one NWS point lookup, then one Open-Meteo request');
  assert.match(h.requests[1], /latitude=37\.7000&longitude=-122\.4000/);
  assert.match(h.requests[1], /temperature_unit=fahrenheit/);
  assert.deepEqual({ ...state.current, timestampMs: null }, {
    temperatureF: 64.2, description: 'Partly Cloudy', humidityPercent: 94, windSpeedMph: 2.7, windDirection: 'W',
    timestampMs: null, observed: false, condition: 'partly-cloudy', isDaytime: true,
  });
  assert.equal(state.forecast.length, 14);

  // The source survives a restart; a geocoder with nothing to say leaves the coordinates.
  const restarted = new (weatherHarness({ openMeteo: openMeteoResponse(), store: h.store }).api.WeatherBridge)();
  assert.equal(restarted.snapshot().source, 'open-meteo');
  const unnamed = weatherHarness({ openMeteo: openMeteoResponse() });
  const unnamedBridge = new unnamed.api.WeatherBridge();
  await unnamedBridge.refreshNow();
  assert.equal(unnamedBridge.snapshot().locationName, '37.7000, -122.4000');
});

test('Open-Meteo hours group into NWS-style day and night periods in local time', async () => {
  // 3pm local, so the first period is the rest of today.
  const offsetHours = -5;
  const dayMs = 24 * HOUR_MS;
  const nowMs = Math.floor(Date.now() / dayMs) * dayMs + (15 - offsetHours) * HOUR_MS;
  const h = weatherHarness({
    nowMs,
    openMeteo: openMeteoResponse({
      offsetHours, nowMs,
      hour: index => ({
        // Peaks at 80 at 1pm and bottoms out at 20 at 1am; rain tomorrow
        // 3pm-5pm, then one stray hour of thunder; a windy 3am tonight.
        temperature_2m: 50 + 30 * Math.sin(((index % 24) - 7) / 24 * 2 * Math.PI),
        precipitation_probability: index === 24 + 15 ? 80 : 10,
        weather_code: { [24 + 15]: 63, [24 + 16]: 63, [24 + 20]: 95 }[index] ?? 1,
        wind_speed_10m: index === 24 + 3 ? 30 : 5,
        wind_direction_10m: index === 24 + 3 ? 90 : 180,
      }),
    }),
    place: { locality: '', region: 'Ontario', country: 'Canada' },
  });
  const bridge = new h.api.WeatherBridge();
  await bridge.refreshNow();
  const { forecast, locationName } = bridge.snapshot();
  assert.equal(locationName, 'Ontario, Canada');
  const weekday = days => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(nowMs + offsetHours * HOUR_MS + days * dayMs).getUTCDay()];
  assert.deepEqual(Array.from(forecast.slice(0, 4), period => period.name), ['Today', 'Tonight', weekday(1), `${weekday(1)} Night`]);
  assert.deepEqual(Array.from(forecast, period => period.isDaytime), Array.from({ length: 14 }, (_, index) => index % 2 === 0));

  // Today is only 3pm-6pm, past its 1pm peak.
  assert.equal(forecast[0].startTimeMs, nowMs);
  assert.equal(Math.round(forecast[0].temperatureF), 76);
  // Tonight runs to 6am and takes its low and its strongest wind.
  assert.equal(Math.round(forecast[1].temperatureF), 20);
  assert.equal(forecast[1].windSpeed, '30 mph');
  assert.equal(forecast[1].windDirection, 'E');
  // Tomorrow takes its most severe lasting code and its highest chance of rain.
  assert.equal(Math.round(forecast[2].temperatureF), 80);
  assert.equal(forecast[2].shortForecast, 'Rain');
  assert.equal(forecast[2].condition, 'rain');
  assert.equal(forecast[2].precipitationPercent, 80);
  // One hour of thunder doesn't name tomorrow night.
  assert.equal(forecast[3].shortForecast, 'Mostly Clear');
  assert.equal(forecast[3].condition, 'partly-cloudy');
});

test('Open-Meteo after midnight starts with the rest of last night', async () => {
  const dayMs = 24 * HOUR_MS;
  const nowMs = Math.floor(Date.now() / dayMs) * dayMs + 2 * HOUR_MS;
  const h = weatherHarness({ nowMs, openMeteo: openMeteoResponse({ nowMs }) });
  const bridge = new h.api.WeatherBridge();
  await bridge.refreshNow();
  assert.deepEqual(Array.from(bridge.snapshot().forecast.slice(0, 3), period => period.name), ['Overnight', 'Today', 'Tonight']);
});

/** weather-indicators.ts with a fake shell, settings and bridge. */
function indicatorHarness() {
  const settings = new Map(), settingListeners = new Set(), stateListeners = new Set(), trays = [];
  const background = [];
  let state = { phase: 'ready', current: null, forecast: [], lastUpdatedMs: null };
  let systemCardInUse = false;
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
      temperatureUnitSetting: new Setting({ storageKey: 'display.temperatureUnit', defaultValue: 'fahrenheit' }),
      onAnySettingChanged: listener => { settingListeners.add(listener); return () => settingListeners.delete(listener); },
    },
    '../../ui/shell/shell': { shell: { setTrayIcon: (id, icon) => trays.push([id, icon]) } },
    '../glanceboard/configuration': { isSystemCardWidgetInUse: () => systemCardInUse },
  })('app/apps/weather/weather-indicators.ts');
  return {
    api, trays, background,
    setSetting(key, value) { settings.set(key, value); for (const listener of settingListeners) listener(); },
    setSystemCardInUse(value) { systemCardInUse = value; for (const listener of settingListeners) listener(); },
    setState(next) { state = next; for (const listener of stateListeners) listener(state); },
  };
}

test('Weather tray icon follows the status-bar setting and hides a stale reading', () => {
  const h = indicatorHarness();
  h.api.startWeatherIndicators();
  assert.deepEqual(h.background, [false], 'system-card weather is on by default, but no system card is showing');
  assert.equal(h.trays.length, 0, 'nothing shown, nothing to clear');

  h.setSystemCardInUse(true);
  assert.equal(h.background.at(-1), true, 'the system card alone keeps refreshes running');
  assert.equal(h.trays.length, 0);
  h.setSetting('weather.showOnSystemCard', false);
  assert.equal(h.background.at(-1), false, 'not with its weather turned off');
  h.setSetting('weather.showOnSystemCard', true);
  assert.equal(h.background.at(-1), true);

  h.setSetting('weather.showInStatusBar', true);
  const current = { temperatureF: 71.6, condition: 'rain', isDaytime: true };
  h.setState({ phase: 'ready', current, forecast: [], lastUpdatedMs: Date.now() });
  const [id, icon] = h.trays.at(-1);
  assert.equal(id, 'weather');
  assert.equal(icon.height, 24);
  assert.deepEqual(icon.draws.map(draw => draw[0]), ['image', 'text']);
  assert.equal(icon.draws[1][3], '72°');
  h.setSetting('display.temperatureUnit', 'celsius');
  assert.equal(h.trays.at(-1)[1].draws[1][3], '22°', 'the temperature unit setting rebuilds the icon');
  h.setSetting('display.temperatureUnit', 'fahrenheit');

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
