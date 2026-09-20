import { hasLocationPermission } from "./location-permissions";
import { getCurrentLocation, type CurrentLocation } from "./location";
import { fetchWithUserAgent } from "../util/http";
import { USER_AGENT } from "../version";

export type WeatherPhase = "permission-required" | "locating" | "loading" | "ready" | "error";

export type CurrentWeather = {
  temperatureF: number | null;
  description: string;
  humidityPercent: number | null;
  windSpeedMph: number | null;
  windDirection: string;
  timestampMs: number | null;
  observed: boolean;
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
};

type NwsStationsResponse = {
  features?: Array<{ id?: unknown }>;
};

type NwsObservationResponse = {
  properties?: {
    timestamp?: unknown;
    textDescription?: unknown;
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
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FORECAST_PERIODS = 14;

const DEFAULT_STATE: WeatherState = {
  phase: "permission-required",
  status: "Location permission is required for local weather.",
  locationName: "",
  current: null,
  forecast: [],
  lastUpdatedMs: null,
};

/** Shared weather state and periodic refresh, active only while its app is open. */
export class WeatherBridge {
  private readonly listeners = new Set<(state: WeatherState) => void>();
  private state: WeatherState = cloneState(DEFAULT_STATE);
  private refreshHandle: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;

  onStateChange(listener: (state: WeatherState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): WeatherState {
    return cloneState(this.state);
  }

  start(): void {
    if (!this.refreshHandle) {
      this.refreshHandle = setInterval(() => void this.refreshNow(), WEATHER_REFRESH_MS);
    }
    void this.refreshNow();
  }

  stop(): void {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!hasLocationPermission()) {
      this.state = cloneState(DEFAULT_STATE);
      this.emit();
      return;
    }

    this.refreshInFlight = this.refresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
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
  return {
    temperatureF: temperatureF ?? hourly?.temperatureF ?? null,
    description: stringValue(properties?.textDescription) || hourly?.shortForecast || "Current conditions",
    humidityPercent: finiteNumber(properties?.relativeHumidity?.value),
    windSpeedMph,
    windDirection: windDegrees === null ? hourly?.windDirection ?? "" : degreesToCompass(windDegrees),
    timestampMs: timestampValue(properties?.timestamp),
    observed: true,
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
  };
}

function normalizeForecastPeriod(value: NwsForecastPeriodResponse): ForecastPeriod | null {
  if (!value || typeof value !== "object") return null;
  const name = stringValue(value.name);
  const temperature = finiteNumber(value.temperature);
  const unit = stringValue(value.temperatureUnit).toUpperCase();
  return {
    name: name || "Forecast",
    startTimeMs: timestampValue(value.startTime) ?? 0,
    temperatureF: temperature === null ? null : unit === "C" ? temperature * 9 / 5 + 32 : temperature,
    shortForecast: stringValue(value.shortForecast),
    detailedForecast: stringValue(value.detailedForecast),
    precipitationPercent: finiteNumber(value.probabilityOfPrecipitation?.value),
    windSpeed: stringValue(value.windSpeed),
    windDirection: stringValue(value.windDirection),
    isDaytime: Boolean(value.isDaytime),
  };
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
