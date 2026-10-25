import { hasLocationPermission } from "./location-permissions";
import { getCurrentLocation, type CurrentLocation } from "./location";
import { type Place } from "./location-types";
import { reverseGeocode } from "./reverse-geocode";
import { getStringSetting, setStringSetting } from "./settings-store";
import { fetchWithUserAgent } from "../util/http";
import { USER_AGENT } from "../version";

export type WeatherPhase = "permission-required" | "locating" | "loading" | "ready" | "error";

/** National Weather Service in the US, Open-Meteo everywhere else. */
export type WeatherSource = "nws" | "open-meteo";

/** Short source names for the Weather app's credit line. */
export const WEATHER_SOURCE_NAMES: Record<WeatherSource, string> = {
  nws: "NWS",
  "open-meteo": "Open-Meteo",
};

/** Sky and precipitation state, as coarse as the icons that show it. */
export type WeatherCondition =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "wind"
  | "drizzle"
  | "showers"
  | "rain"
  | "thunderstorm"
  | "snow"
  | "sleet";

export type CurrentWeather = {
  temperatureF: number | null;
  description: string;
  humidityPercent: number | null;
  windSpeedMph: number | null;
  windDirection: string;
  timestampMs: number | null;
  observed: boolean;
  condition: WeatherCondition | null;
  isDaytime: boolean;
};

export type ForecastPeriod = {
  name: string;
  startTimeMs: number;
  temperatureF: number | null;
  shortForecast: string;
  detailedForecast: string;
  precipitationPercent: number | null;
  windSpeed: string;
  windDirection: string;
  isDaytime: boolean;
  condition: WeatherCondition | null;
};

export type WeatherState = {
  phase: WeatherPhase;
  status: string;
  /** Where current and forecast came from; null until the first refresh. */
  source: WeatherSource | null;
  locationName: string;
  current: CurrentWeather | null;
  forecast: ForecastPeriod[];
  lastUpdatedMs: number | null;
};

type NwsPointResponse = {
  properties?: {
    forecast?: unknown;
    forecastHourly?: unknown;
    observationStations?: unknown;
    relativeLocation?: {
      properties?: { city?: unknown; state?: unknown };
    };
  };
};

type NwsForecastResponse = {
  properties?: {
    periods?: NwsForecastPeriodResponse[];
  };
};

type NwsForecastPeriodResponse = {
  name?: unknown;
  startTime?: unknown;
  temperature?: unknown;
  temperatureUnit?: unknown;
  shortForecast?: unknown;
  detailedForecast?: unknown;
  probabilityOfPrecipitation?: { value?: unknown };
  windSpeed?: unknown;
  windDirection?: unknown;
  isDaytime?: unknown;
  icon?: unknown;
};

type NwsStationsResponse = {
  features?: Array<{ id?: unknown }>;
};

type NwsObservationResponse = {
  properties?: {
    timestamp?: unknown;
    textDescription?: unknown;
    icon?: unknown;
    temperature?: NwsMeasure;
    relativeHumidity?: NwsMeasure;
    windSpeed?: NwsMeasure;
    windDirection?: NwsMeasure;
  };
};

type NwsMeasure = {
  value?: unknown;
  unitCode?: unknown;
};

type OpenMeteoResponse = {
  utc_offset_seconds?: unknown;
  current?: {
    time?: unknown;
    temperature_2m?: unknown;
    relative_humidity_2m?: unknown;
    is_day?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
  };
  hourly?: {
    time?: unknown;
    temperature_2m?: unknown;
    precipitation_probability?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
  };
};

type LoadedWeather = {
  source: WeatherSource;
  locationName: string;
  current: CurrentWeather;
  forecast: ForecastPeriod[];
};

const NWS_API_ROOT = "https://api.weather.gov";
const NWS_HEADERS = {
  Accept: "application/geo+json",
  // NWS asks callers to identify themselves with a contact address.
  "User-Agent": `${USER_AGENT} (https://github.com/jimrandomh/faceclaw)`,
};
// Free for non-commercial use without a key; data is CC BY 4.0, credited
// on the Weather app's source line and in ACKNOWLEDGEMENTS.md.
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
/**
 * Days of hourly forecast to ask Open-Meteo for, from local midnight today:
 * enough that MAX_FORECAST_PERIODS periods from any hour end before it does.
 */
const OPEN_METEO_FORECAST_DAYS = 8;
/** Local hours Open-Meteo forecast days and nights start at, as NWS periods do. */
const DAY_START_HOUR = 6;
const NIGHT_START_HOUR = 18;
/** How long a place-name lookup may hold up an Open-Meteo refresh. */
const GEOCODE_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Refresh period while the Weather app is open. */
const APP_REFRESH_MS = 30 * 60 * 1000;
/** Refresh period for the status-bar and system-card indicators. */
const BACKGROUND_REFRESH_MS = 60 * 60 * 1000;
/** Delay before retrying after a failed refresh (capped at the period). */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FORECAST_PERIODS = 14;
/** Settings-store key holding the last successful refresh. */
const CACHE_KEY = "weather.cache";
const CACHE_VERSION = 1;

const DEFAULT_STATE: WeatherState = {
  phase: "permission-required",
  status: "Location permission is required for local weather.",
  source: null,
  locationName: "",
  current: null,
  forecast: [],
  lastUpdatedMs: null,
};

type WeatherCache = {
  version: number;
  /** Absent from caches written before Open-Meteo, which all came from NWS. */
  source?: WeatherSource;
  locationName: string;
  current: CurrentWeather | null;
  forecast: ForecastPeriod[];
  lastUpdatedMs: number;
};

/**
 * Shared weather state, refreshed on a schedule while anything shows it:
 * every 30 minutes while the Weather app is open, and hourly while a weather
 * indicator (status bar or Glanceboard system card) is enabled and the
 * glasses session is up. The last successful refresh is persisted, so a
 * restart shows it at once and the schedule counts from its age.
 */
export class WeatherBridge {
  private readonly listeners = new Set<(state: WeatherState) => void>();
  private loadedState: WeatherState | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  /** Start of the latest refresh attempt, successful or not. */
  private lastAttemptMs: number | null = null;
  private appOpen = false;
  private sessionActive = false;
  private backgroundWanted = false;

  onStateChange(listener: (state: WeatherState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): WeatherState {
    return cloneState(this.state);
  }

  /** The Weather app opened (or asked to retry): refresh now, then every 30 minutes. */
  start(): void {
    this.appOpen = true;
    void this.refreshNow();
  }

  /** The Weather app closed; any indicator schedule continues. */
  stop(): void {
    this.appOpen = false;
    this.schedule();
  }

  /** Whether a glasses session is up; indicator refreshes only run during one. */
  setSessionActive(active: boolean): void {
    if (active === this.sessionActive) return;
    this.sessionActive = active;
    this.schedule();
  }

  /** Whether an indicator wants hourly refreshes (see app/apps/weather/weather-indicators.ts). */
  setBackgroundRefresh(enabled: boolean): void {
    if (enabled === this.backgroundWanted) return;
    this.backgroundWanted = enabled;
    this.schedule();
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.clearRefreshTimer();
    this.lastAttemptMs = Date.now();
    if (!hasLocationPermission()) {
      this.state = cloneState(DEFAULT_STATE);
      this.emit();
      this.schedule();
      return;
    }

    this.refreshInFlight = this.refresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
      this.schedule();
    }
  }

  private get state(): WeatherState {
    if (!this.loadedState) this.loadedState = loadCachedState();
    return this.loadedState;
  }

  private set state(state: WeatherState) {
    this.loadedState = state;
  }

  private refreshIntervalMs(): number | null {
    if (this.appOpen) return APP_REFRESH_MS;
    if (this.sessionActive && this.backgroundWanted) return BACKGROUND_REFRESH_MS;
    return null;
  }

  /**
   * Arm the timer for the next refresh: one period after the last success,
   * but no sooner than the retry delay after a failed attempt.
   */
  private schedule(): void {
    this.clearRefreshTimer();
    // A running refresh reschedules when it settles.
    if (this.refreshInFlight) return;
    const intervalMs = this.refreshIntervalMs();
    if (intervalMs === null) return;
    const lastSuccessMs = this.state.lastUpdatedMs ?? -Infinity;
    const lastAttemptMs = this.lastAttemptMs ?? -Infinity;
    const dueMs = Math.max(lastSuccessMs + intervalMs, lastAttemptMs + Math.min(intervalMs, RETRY_AFTER_FAILURE_MS));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow();
    }, Math.max(0, dueMs - Date.now()));
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.state = { ...this.state, phase: "locating", status: "Getting current location..." };
      this.emit();
      const location = await getCurrentLocation();

      this.state = { ...this.state, phase: "loading", status: "Loading weather..." };
      this.emit();
      const weather = await loadWeather(location);
      this.state = {
        phase: "ready",
        status: "Weather updated.",
        source: weather.source,
        locationName: weather.locationName,
        current: weather.current,
        forecast: weather.forecast,
        lastUpdatedMs: Date.now(),
      };
      saveCachedState(this.state);
      this.emit();
    } catch (error) {
      const message = friendlyWeatherError(error);
      console.warn(`weather refresh failed: ${message}`);
      this.state = {
        ...this.state,
        phase: "error",
        status: message,
      };
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** The persisted last refresh, or the default state when there is none (or no permission to refresh it). */
function loadCachedState(): WeatherState {
  try {
    if (!hasLocationPermission()) return cloneState(DEFAULT_STATE);
    const raw = getStringSetting(CACHE_KEY, "");
    if (!raw) return cloneState(DEFAULT_STATE);
    const cache = JSON.parse(raw) as Partial<WeatherCache> | null;
    if (
      !cache ||
      cache.version !== CACHE_VERSION ||
      typeof cache.lastUpdatedMs !== "number" ||
      !Array.isArray(cache.forecast)
    ) {
      return cloneState(DEFAULT_STATE);
    }
    return cloneState({
      phase: "ready",
      status: "Weather updated.",
      source: cache.source === "open-meteo" ? "open-meteo" : "nws",
      locationName: typeof cache.locationName === "string" ? cache.locationName : "",
      current: cache.current && typeof cache.current === "object" ? cache.current : null,
      forecast: cache.forecast,
      lastUpdatedMs: cache.lastUpdatedMs,
    });
  } catch (error) {
    console.warn(`weather cache unreadable: ${error}`);
    return cloneState(DEFAULT_STATE);
  }
}

function saveCachedState(state: WeatherState): void {
  if (state.lastUpdatedMs === null) return;
  const cache: WeatherCache = {
    version: CACHE_VERSION,
    source: state.source ?? undefined,
    locationName: state.locationName,
    current: state.current,
    forecast: state.forecast,
    lastUpdatedMs: state.lastUpdatedMs,
  };
  try {
    setStringSetting(CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn(`weather cache write failed: ${error}`);
  }
}

/** NWS where it has coverage (the US and its territories), Open-Meteo everywhere else. */
async function loadWeather(location: CurrentLocation): Promise<LoadedWeather> {
  return (await loadNwsWeather(location)) ?? loadOpenMeteoWeather(location);
}

/** NWS weather, or null when the location is outside its coverage. */
async function loadNwsWeather(location: CurrentLocation): Promise<LoadedWeather | null> {
  // NWS recommends no more than four decimals for its point lookup.
  const latitude = location.latitude.toFixed(4);
  const longitude = location.longitude.toFixed(4);
  let point: NwsPointResponse;
  try {
    point = await fetchNwsJson<NwsPointResponse>(`${NWS_API_ROOT}/points/${latitude},${longitude}`);
  } catch (error) {
    if (error instanceof WeatherHttpError && error.status === 404) return null;
    throw error;
  }
  const properties = point.properties;
  const forecastUrl = stringValue(properties?.forecast);
  const hourlyUrl = stringValue(properties?.forecastHourly);
  const stationsUrl = stringValue(properties?.observationStations);
  if (!forecastUrl) throw new Error("NWS did not provide a forecast for this location.");

  const [forecastResponse, hourlyResponse, observation] = await Promise.all([
    fetchNwsJson<NwsForecastResponse>(forecastUrl),
    hourlyUrl ? fetchNwsJson<NwsForecastResponse>(hourlyUrl).catch(() => null) : Promise.resolve(null),
    stationsUrl ? loadLatestObservation(stationsUrl).catch(() => null) : Promise.resolve(null),
  ]);
  const forecast = (forecastResponse.properties?.periods ?? [])
    .map(normalizeForecastPeriod)
    .filter((period): period is ForecastPeriod => period !== null)
    .slice(0, MAX_FORECAST_PERIODS);
  if (!forecast.length) throw new Error("NWS returned an empty forecast.");

  const hourly = (hourlyResponse?.properties?.periods ?? [])
    .map(normalizeForecastPeriod)
    .find((period): period is ForecastPeriod => period !== null);

  return {
    source: "nws",
    locationName: pointLocationName(point, latitude, longitude),
    current: observation ? normalizeObservation(observation, hourly) : currentFromHourly(hourly, forecast[0]!),
    forecast,
  };
}

async function loadLatestObservation(stationsUrl: string): Promise<NwsObservationResponse | null> {
  const stations = await fetchNwsJson<NwsStationsResponse>(stationsUrl);
  const stationUrl = stringValue(stations.features?.[0]?.id);
  if (!stationUrl) return null;
  return fetchNwsJson<NwsObservationResponse>(`${stationUrl}/observations/latest`);
}

function fetchNwsJson<T>(url: string): Promise<T> {
  return fetchWeatherJson<T>(url, "National Weather Service", NWS_HEADERS);
}

/** A weather request the server answered with an error status. */
class WeatherHttpError extends Error {
  constructor(sourceName: string, readonly status: number) {
    super(`${sourceName} request failed (HTTP ${status}).`);
  }
}

async function fetchWeatherJson<T>(url: string, sourceName: string, headers?: Record<string, string>): Promise<T> {
  const request = fetchWithUserAgent(url, headers ? { headers } : undefined);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Weather request timed out.")), FETCH_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([request, timeout]);
    if (!response.ok) throw new WeatherHttpError(sourceName, response.status);
    return (await response.json()) as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function normalizeObservation(
  response: NwsObservationResponse,
  hourly: ForecastPeriod | undefined,
): CurrentWeather {
  const properties = response.properties;
  const temperatureF = convertTemperatureToF(properties?.temperature);
  const windSpeedMph = convertSpeedToMph(properties?.windSpeed);
  const windDegrees = finiteNumber(properties?.windDirection?.value);
  const textDescription = stringValue(properties?.textDescription);
  const icon = parseNwsIcon(properties?.icon);
  return {
    temperatureF: temperatureF ?? hourly?.temperatureF ?? null,
    description: textDescription || hourly?.shortForecast || "Current conditions",
    humidityPercent: finiteNumber(properties?.relativeHumidity?.value),
    windSpeedMph,
    windDirection: windDegrees === null ? hourly?.windDirection ?? "" : degreesToCompass(windDegrees),
    timestampMs: timestampValue(properties?.timestamp),
    observed: true,
    condition: icon.condition ?? conditionFromText(textDescription) ?? hourly?.condition ?? null,
    isDaytime: icon.isDaytime ?? hourly?.isDaytime ?? isLocalDaytime(),
  };
}

function currentFromHourly(hourly: ForecastPeriod | undefined, fallback: ForecastPeriod): CurrentWeather {
  const source = hourly ?? fallback;
  return {
    temperatureF: source.temperatureF,
    description: source.shortForecast || "Current forecast",
    humidityPercent: null,
    windSpeedMph: firstNumberInText(source.windSpeed),
    windDirection: source.windDirection,
    timestampMs: source.startTimeMs || null,
    observed: false,
    condition: source.condition,
    isDaytime: source.isDaytime,
  };
}

function normalizeForecastPeriod(value: NwsForecastPeriodResponse): ForecastPeriod | null {
  if (!value || typeof value !== "object") return null;
  const name = stringValue(value.name);
  const temperature = finiteNumber(value.temperature);
  const unit = stringValue(value.temperatureUnit).toUpperCase();
  const shortForecast = stringValue(value.shortForecast);
  const icon = parseNwsIcon(value.icon);
  return {
    name: name || "Forecast",
    startTimeMs: timestampValue(value.startTime) ?? 0,
    temperatureF: temperature === null ? null : unit === "C" ? temperature * 9 / 5 + 32 : temperature,
    shortForecast,
    detailedForecast: stringValue(value.detailedForecast),
    precipitationPercent: finiteNumber(value.probabilityOfPrecipitation?.value),
    windSpeed: stringValue(value.windSpeed),
    windDirection: stringValue(value.windDirection),
    isDaytime: icon.isDaytime ?? Boolean(value.isDaytime),
    condition: icon.condition ?? conditionFromText(shortForecast),
  };
}

// NWS icon codes (https://api.weather.gov/icons) by the condition they show.
const NWS_ICON_CONDITIONS: Record<string, WeatherCondition> = {
  skc: "clear",
  hot: "clear",
  cold: "clear",
  few: "partly-cloudy",
  sct: "partly-cloudy",
  bkn: "cloudy",
  ovc: "cloudy",
  wind_skc: "wind",
  wind_few: "wind",
  wind_sct: "wind",
  wind_bkn: "wind",
  wind_ovc: "wind",
  fog: "fog",
  haze: "fog",
  smoke: "fog",
  dust: "fog",
  rain: "rain",
  rain_showers: "rain",
  rain_showers_hi: "showers",
  tsra: "thunderstorm",
  tsra_sct: "thunderstorm",
  tsra_hi: "thunderstorm",
  tornado: "thunderstorm",
  hurricane: "thunderstorm",
  tropical_storm: "thunderstorm",
  snow: "snow",
  blizzard: "snow",
  sleet: "sleet",
  fzra: "sleet",
  rain_fzra: "sleet",
  snow_fzra: "sleet",
  rain_sleet: "sleet",
  snow_sleet: "sleet",
  rain_snow: "sleet",
};

/**
 * Condition and day/night from an NWS icon URL such as
 * ".../icons/land/day/tsra_sct,40/rain,20?size=medium". A period that
 * changes partway lists two codes; the first is the one in effect now.
 */
function parseNwsIcon(value: unknown): { condition: WeatherCondition | null; isDaytime: boolean | null } {
  const match = stringValue(value).match(/\/icons\/[^/]+\/(day|night)\/([a-z_]+)/);
  if (!match) return { condition: null, isDaytime: null };
  return { condition: NWS_ICON_CONDITIONS[match[2]!] ?? null, isDaytime: match[1] === "day" };
}

/** Condition from an NWS text description ("Chance Rain Showers"), for when there is no icon. */
function conditionFromText(text: string): WeatherCondition | null {
  const lower = text.toLowerCase();
  if (/thunder|t-storm|tstorm/.test(lower)) return "thunderstorm";
  if (/freezing|sleet|ice pellets|wintry|hail|rain and snow|snow and rain/.test(lower)) return "sleet";
  if (/snow|flurr|blizzard/.test(lower)) return "snow";
  if (/drizzle/.test(lower)) return "drizzle";
  if (/rain|showers/.test(lower)) return /chance|slight|scattered|isolated|patchy/.test(lower) ? "showers" : "rain";
  if (/fog|haze|smoke|dust|mist/.test(lower)) return "fog";
  if (/windy|breezy|blustery/.test(lower)) return "wind";
  if (/partly|few clouds|mostly sunny|mostly clear/.test(lower)) return "partly-cloudy";
  if (/cloud|overcast/.test(lower)) return "cloudy";
  if (/sunny|clear|fair/.test(lower)) return "clear";
  return null;
}

async function loadOpenMeteoWeather(location: CurrentLocation): Promise<LoadedWeather> {
  const latitude = location.latitude.toFixed(4);
  const longitude = location.longitude.toFixed(4);
  const query = [
    `latitude=${latitude}`,
    `longitude=${longitude}`,
    "current=temperature_2m,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m",
    "hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m",
    `forecast_days=${OPEN_METEO_FORECAST_DAYS}`,
    // Local-time periods need the location's UTC offset, which timezone=auto adds.
    "timezone=auto",
    "timeformat=unixtime",
    "temperature_unit=fahrenheit",
    "wind_speed_unit=mph",
  ].join("&");
  const [response, placeName] = await Promise.all([
    fetchWeatherJson<OpenMeteoResponse>(`${OPEN_METEO_FORECAST_URL}?${query}`, "Open-Meteo"),
    lookUpPlaceName(location),
  ]);
  const forecast = openMeteoForecastPeriods(response, Date.now()).slice(0, MAX_FORECAST_PERIODS);
  if (!forecast.length) throw new Error("Open-Meteo returned an empty forecast.");
  return {
    source: "open-meteo",
    locationName: placeName || `${latitude}, ${longitude}`,
    current: normalizeOpenMeteoCurrent(response) ?? currentFromHourly(undefined, forecast[0]!),
    forecast,
  };
}

/** Open-Meteo's current conditions, which come from its forecast models rather than a station. */
function normalizeOpenMeteoCurrent(response: OpenMeteoResponse): CurrentWeather | null {
  const current = response.current;
  if (!current || typeof current !== "object") return null;
  const wmo = wmoCode(finiteNumber(current.weather_code));
  const windDegrees = finiteNumber(current.wind_direction_10m);
  const time = finiteNumber(current.time);
  const isDay = finiteNumber(current.is_day);
  return {
    temperatureF: finiteNumber(current.temperature_2m),
    description: wmo?.description ?? "Current conditions",
    humidityPercent: finiteNumber(current.relative_humidity_2m),
    windSpeedMph: finiteNumber(current.wind_speed_10m),
    windDirection: windDegrees === null ? "" : degreesToCompass(windDegrees),
    timestampMs: time === null ? null : time * 1000,
    observed: false,
    condition: wmo?.condition ?? null,
    isDaytime: isDay === null ? isLocalDaytime() : isDay === 1,
  };
}

/**
 * NWS-style day (6am-6pm) and night periods from Open-Meteo's hourly
 * forecast, in the location's local time: each has its warmest daytime or
 * coolest nighttime temperature, its highest chance of rain, and the weather
 * from periodWeatherCode. The current period counts only the hours left in
 * it. Local time uses today's UTC offset, so periods after a DST change are
 * an hour off.
 */
function openMeteoForecastPeriods(response: OpenMeteoResponse, nowMs: number): ForecastPeriod[] {
  const hourly = response.hourly;
  const times = numberArray(hourly?.time);
  const temperatures = numberArray(hourly?.temperature_2m);
  const precipitation = numberArray(hourly?.precipitation_probability);
  const codes = numberArray(hourly?.weather_code);
  const windSpeeds = numberArray(hourly?.wind_speed_10m);
  const windDirections = numberArray(hourly?.wind_direction_10m);
  const offsetMs = (finiteNumber(response.utc_offset_seconds) ?? 0) * 1000;
  const todayIndex = Math.floor((nowMs + offsetMs) / DAY_MS);

  // The hourly indexes of each period still to come, in order.
  const groups: Array<{ dayIndex: number; isDaytime: boolean; hours: number[] }> = [];
  times.forEach((time, index) => {
    if (time === null || time * 1000 + HOUR_MS <= nowMs) return;
    const localMs = time * 1000 + offsetMs;
    const hour = new Date(localMs).getUTCHours();
    const isDaytime = hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR;
    // A night belongs to the date it starts on.
    const dayIndex = Math.floor(localMs / DAY_MS) - (hour < DAY_START_HOUR ? 1 : 0);
    const last = groups[groups.length - 1];
    if (last && last.dayIndex === dayIndex && last.isDaytime === isDaytime) last.hours.push(index);
    else groups.push({ dayIndex, isDaytime, hours: [index] });
  });

  return groups.map(({ dayIndex, isDaytime, hours }) => {
    const during = (values: Array<number | null>) => hours.map((index) => values[index] ?? null);
    const wmo = wmoCode(periodWeatherCode(during(codes)));
    const speeds = during(windSpeeds);
    const windiest = maxValue(speeds);
    const windDegrees = windiest === null ? null : windDirections[hours[speeds.indexOf(windiest)]!] ?? null;
    return {
      name: openMeteoPeriodName(dayIndex, isDaytime, todayIndex),
      startTimeMs: times[hours[0]!]! * 1000,
      temperatureF: isDaytime ? maxValue(during(temperatures)) : minValue(during(temperatures)),
      shortForecast: wmo?.description ?? "",
      detailedForecast: "",
      precipitationPercent: maxValue(during(precipitation)),
      windSpeed: windiest === null ? "" : `${Math.round(windiest)} mph`,
      windDirection: windDegrees === null ? "" : degreesToCompass(windDegrees),
      isDaytime,
      condition: wmo?.condition ?? null,
    };
  });
}

/**
 * The most severe weather code that lasts at least two hours of a period (or
 * its only hour), so one stray hour of drizzle doesn't name it. WMO codes
 * rise with severity, as Open-Meteo's own daily summaries assume.
 */
function periodWeatherCode(codes: Array<number | null>): number | null {
  const known = codes.filter((code): code is number => code !== null).sort((a, b) => b - a);
  return known.length ? known[Math.min(1, known.length - 1)]! : null;
}

/** "Today", "Tonight", "Friday", "Friday Night", or "Overnight" for last night's remainder. */
function openMeteoPeriodName(dayIndex: number, isDaytime: boolean, todayIndex: number): string {
  if (dayIndex < todayIndex) return "Overnight";
  if (dayIndex === todayIndex) return isDaytime ? "Today" : "Tonight";
  const weekday = WEEKDAYS[new Date(dayIndex * DAY_MS).getUTCDay()]!;
  return isDaytime ? weekday : `${weekday} Night`;
}

// WMO weather interpretation codes, as Open-Meteo reports them
// (https://open-meteo.com/en/docs#weather_variable_documentation).
const WMO_CODES: Record<number, { description: string; condition: WeatherCondition }> = {
  0: { description: "Clear", condition: "clear" },
  1: { description: "Mostly Clear", condition: "partly-cloudy" },
  2: { description: "Partly Cloudy", condition: "partly-cloudy" },
  3: { description: "Overcast", condition: "cloudy" },
  45: { description: "Fog", condition: "fog" },
  48: { description: "Freezing Fog", condition: "fog" },
  51: { description: "Light Drizzle", condition: "drizzle" },
  53: { description: "Drizzle", condition: "drizzle" },
  55: { description: "Heavy Drizzle", condition: "drizzle" },
  56: { description: "Light Freezing Drizzle", condition: "sleet" },
  57: { description: "Freezing Drizzle", condition: "sleet" },
  61: { description: "Light Rain", condition: "rain" },
  63: { description: "Rain", condition: "rain" },
  65: { description: "Heavy Rain", condition: "rain" },
  66: { description: "Light Freezing Rain", condition: "sleet" },
  67: { description: "Freezing Rain", condition: "sleet" },
  71: { description: "Light Snow", condition: "snow" },
  73: { description: "Snow", condition: "snow" },
  75: { description: "Heavy Snow", condition: "snow" },
  77: { description: "Snow Grains", condition: "snow" },
  80: { description: "Light Rain Showers", condition: "showers" },
  81: { description: "Rain Showers", condition: "showers" },
  82: { description: "Heavy Rain Showers", condition: "rain" },
  85: { description: "Light Snow Showers", condition: "snow" },
  86: { description: "Heavy Snow Showers", condition: "snow" },
  95: { description: "Thunderstorms", condition: "thunderstorm" },
  96: { description: "Thunderstorms and Hail", condition: "thunderstorm" },
  99: { description: "Thunderstorms and Heavy Hail", condition: "thunderstorm" },
};

function wmoCode(code: number | null): { description: string; condition: WeatherCondition } | undefined {
  return code === null ? undefined : WMO_CODES[code];
}

/** "Sydney, Australia" from the phone's geocoder, or "" when it can't name the place in time. */
async function lookUpPlaceName(location: CurrentLocation): Promise<string> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), GEOCODE_TIMEOUT_MS);
  });
  try {
    const place = await Promise.race([
      reverseGeocode(location.latitude, location.longitude).catch((error) => {
        console.warn(`weather place lookup failed: ${error}`);
        return null;
      }),
      timeout,
    ]);
    return placeLabel(place);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** The city (or failing that, the region) and country. */
function placeLabel(place: Place | null): string {
  if (!place) return "";
  const local = place.locality || place.region;
  if (!local || local === place.country) return place.country;
  return place.country ? `${local}, ${place.country}` : local;
}

/** Rough day/night by the phone's clock, for when NWS gives no hint. */
function isLocalDaytime(): boolean {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18;
}

function convertTemperatureToF(measure: NwsMeasure | undefined): number | null {
  const value = finiteNumber(measure?.value);
  if (value === null) return null;
  const unit = stringValue(measure?.unitCode).toLowerCase();
  if (unit.includes("degc")) return value * 9 / 5 + 32;
  return value;
}

function convertSpeedToMph(measure: NwsMeasure | undefined): number | null {
  const value = finiteNumber(measure?.value);
  if (value === null) return null;
  const unit = stringValue(measure?.unitCode).toLowerCase();
  if (unit.includes("km_h")) return value * 0.621371;
  if (unit.includes("m_s")) return value * 2.23694;
  return value;
}

function pointLocationName(point: NwsPointResponse, latitude: string, longitude: string): string {
  const relative = point.properties?.relativeLocation?.properties;
  const city = stringValue(relative?.city);
  const state = stringValue(relative?.state);
  return [city, state].filter(Boolean).join(", ") || `${latitude}, ${longitude}`;
}

function degreesToCompass(value: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round((((value % 360) + 360) % 360) / 45) % directions.length]!;
}

function firstNumberInText(value: string): number | null {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberArray(value: unknown): Array<number | null> {
  return Array.isArray(value) ? value.map((item) => finiteNumber(item)) : [];
}

function maxValue(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

function minValue(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? Math.min(...numbers) : null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function friendlyWeatherError(error: unknown): string {
  const message = (error as Error)?.message || String(error);
  if (/network request failed|failed to fetch|unable to resolve host/i.test(message)) {
    return "Couldn't reach the weather service. Check the phone's connection and retry.";
  }
  return message;
}

function cloneState(state: WeatherState): WeatherState {
  return {
    ...state,
    current: state.current ? { ...state.current } : null,
    forecast: state.forecast.map((period) => ({ ...period })),
  };
}

export const weatherBridge = new WeatherBridge();
