import { hasLocationPermission } from "./location-permissions";
import { getCurrentLocation, type CurrentLocation } from "./location";
import { getStringSetting, setStringSetting } from "./settings-store";
import { fetchWithUserAgent } from "../util/http";
import { USER_AGENT } from "../version";

export type WeatherPhase = "permission-required" | "locating" | "loading" | "ready" | "error";

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

const NWS_API_ROOT = "https://api.weather.gov";
const NWS_HEADERS = {
  Accept: "application/geo+json",
  // NWS asks callers to identify themselves with a contact address.
  "User-Agent": `${USER_AGENT} (https://github.com/jimrandomh/faceclaw)`,
};
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
  locationName: "",
  current: null,
  forecast: [],
  lastUpdatedMs: null,
};

type WeatherCache = {
  version: number;
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

      this.state = { ...this.state, phase: "loading", status: "Loading National Weather Service data..." };
      this.emit();
      const weather = await loadNwsWeather(location);
      this.state = {
        phase: "ready",
        status: "Weather updated.",
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

async function loadNwsWeather(location: CurrentLocation): Promise<{
  locationName: string;
  current: CurrentWeather;
  forecast: ForecastPeriod[];
}> {
  // NWS recommends no more than four decimals for its point lookup.
  const latitude = location.latitude.toFixed(4);
  const longitude = location.longitude.toFixed(4);
  const point = await fetchNwsJson<NwsPointResponse>(`${NWS_API_ROOT}/points/${latitude},${longitude}`);
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

async function fetchNwsJson<T>(url: string): Promise<T> {
  const request = fetchWithUserAgent(url, { headers: NWS_HEADERS });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Weather request timed out.")), FETCH_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([request, timeout]);
    if (!response.ok) {
      if (response.status === 404 && url.includes("/points/")) {
        throw new Error("This location is outside National Weather Service coverage.");
      }
      throw new Error(`National Weather Service request failed (HTTP ${response.status}).`);
    }
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
    return "Couldn't reach the National Weather Service. Check the phone's connection and retry.";
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
