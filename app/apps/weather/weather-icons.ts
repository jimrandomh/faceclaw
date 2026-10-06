import { renderSvgIcon } from "../../graphics/icons";
import { type GrayImage, type UiFont } from "../../graphics/image";
import { type WeatherCondition, type WeatherState } from "../../native/weather";

// Lucide weather icons (ISC licensed), kept verbatim so they can be diffed
// against upstream.
const WEATHER_SVGS = {
  sun:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  moon:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
  "cloud-sun":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
  "cloud-moon":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M13 16a3 3 0 0 1 0 6H7a5 5 0 1 1 4.9-6z"/><path d="M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36"/></svg>',
  "cloud-fog":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7"/><path d="M17 21H9"/></svg>',
  wind:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>',
  "cloud-drizzle":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1"/><path d="M8 14v1"/><path d="M16 19v1"/><path d="M16 14v1"/><path d="M12 21v1"/><path d="M12 16v1"/></svg>',
  "cloud-sun-rain":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"/><path d="M11 20v2"/><path d="M7 19v2"/></svg>',
  "cloud-moon-rain":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M11 20v2"/><path d="M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36"/><path d="M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"/><path d="M7 19v2"/></svg>',
  "cloud-rain":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
  "cloud-lightning":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  "cloud-snow":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
  "cloud-hail":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v2"/><path d="M8 14v2"/><path d="M16 20h.01"/><path d="M8 20h.01"/><path d="M12 16v2"/><path d="M12 22h.01"/></svg>',
} as const;

type WeatherIconName = keyof typeof WEATHER_SVGS;

/** Status bar and system card hide weather whose last refresh is older than this. */
const INDICATOR_STALE_MS = 3 * 60 * 60 * 1000;
/** Gap between a reading's icon and its temperature. */
const READING_ICON_GAP = 3;

function weatherIconName(condition: WeatherCondition, isDaytime: boolean): WeatherIconName {
  switch (condition) {
    case "clear":
      return isDaytime ? "sun" : "moon";
    case "partly-cloudy":
      return isDaytime ? "cloud-sun" : "cloud-moon";
    case "cloudy":
      return "cloud";
    case "fog":
      return "cloud-fog";
    case "wind":
      return "wind";
    case "drizzle":
      return "cloud-drizzle";
    case "showers":
      return isDaytime ? "cloud-sun-rain" : "cloud-moon-rain";
    case "rain":
      return "cloud-rain";
    case "thunderstorm":
      return "cloud-lightning";
    case "snow":
      return "cloud-snow";
    case "sleet":
      return "cloud-hail";
  }
}

/** A size×size icon for the condition (sun or moon variants by time of day), rendered once and cached. */
export function renderWeatherIcon(condition: WeatherCondition, isDaytime: boolean, size: number): GrayImage | null {
  const name = weatherIconName(condition, isDaytime);
  return renderSvgIcon(`weather:${name}`, WEATHER_SVGS[name], size);
}

/** Current conditions as the status bar and system card show them. */
export type WeatherReading = {
  condition: WeatherCondition | null;
  isDaytime: boolean;
  /** Rounded, unit-less ("72°"), to stay compact. */
  temperature: string;
};

/** The current reading, or null when there is none or it has gone stale. */
export function weatherReading(state: WeatherState, nowMs: number): WeatherReading | null {
  const current = state.current;
  if (!current || state.lastUpdatedMs === null || nowMs - state.lastUpdatedMs > INDICATOR_STALE_MS) return null;
  return {
    condition: current.condition,
    isDaytime: current.isDaytime,
    temperature: current.temperatureF === null ? "--°" : `${Math.round(current.temperatureF)}°`,
  };
}

/** Width drawWeatherReading takes for this reading. */
export function measureWeatherReading(reading: WeatherReading, font: UiFont, iconSize: number): number {
  return (reading.condition ? iconSize + READING_ICON_GAP : 0) + font.measureText(reading.temperature);
}

/** The condition icon then the temperature, each centred vertically in the `height` rows from `top`. */
export function drawWeatherReading(
  image: GrayImage,
  reading: WeatherReading,
  font: UiFont,
  iconSize: number,
  x: number,
  top: number,
  height: number,
  shade: number,
): void {
  if (reading.condition) {
    const icon = renderWeatherIcon(reading.condition, reading.isDaytime, iconSize);
    if (icon) image.drawImage(icon, x, top + (((height - icon.height) / 2) | 0));
    x += iconSize + READING_ICON_GAP;
  }
  image.drawText(font, x, top + Math.max(0, ((height - font.lineHeight) / 2) | 0), reading.temperature, shade);
}
