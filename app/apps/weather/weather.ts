import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { WEATHER_SOURCE_NAMES, type ForecastPeriod, type WeatherState } from "../../native/weather";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { centeredTextY, lineStep, tightRowHeight } from "../../ui/metrics";
import { distanceUnitSetting } from "../../ui/dashboard-settings";
import type { Viewport } from "../../ui/viewport";
import { renderWeatherIcon } from "./weather-icons";
import { formatTemperature, widestTemperatureSample } from "./temperature-format";

/**
 * How far the page's text (title, current conditions, forecast names) starts
 * right of the forecast rows' selection boxes, which span the padding
 * suggested for the window's side edges.
 */
const PAGE_TEXT_INSET = 7;
/**
 * The page's fixed parts, down from the title line at the window's top
 * padding: the temperature, the description column's first line, the rule
 * above the forecast, the forecast's column headings, and its first row's text.
 */
const TEMPERATURE_OFFSET_Y = 34;
const CURRENT_TEXT_OFFSET_Y = 22;
const FORECAST_RULE_OFFSET_Y = 90;
const FORECAST_HEADER_OFFSET_Y = 97;
const FORECAST_OFFSET_Y = 116;
/** Minimum distance of the description column from the page text's left edge. */
const CURRENT_TEXT_MIN_OFFSET_X = 94;
/** The current-conditions icon, left of the temperature. */
const CURRENT_ICON_SIZE = 40;
const CURRENT_ICON_GAP = 10;
/** Gap between the temperature and the description column. */
const CURRENT_TEXT_GAP = 16;
/** Forecast rows hold a 20px icon; grow with the font past that. */
const FORECAST_MIN_ROW_HEIGHT = 23;
/** Gap between forecast columns. */
const FORECAST_COL_GAP = 14;
/** Pixels between consecutive forecast rows' selection boxes. */
const FORECAST_ROW_GAP = 2;
/** A full-page message: its indent from the page text, and the least it sits below the title line. */
const MESSAGE_INDENT = 6;
const MESSAGE_MIN_OFFSET_Y = 44;

/**
 * Where the page's parts go in a viewport. The forecast rows' selection
 * boxes are the outermost thing toward the window's sides, so they sit at
 * the padding suggested there, and the page's text is placed from them.
 */
type PageLayout = {
  width: number;
  height: number;
  /** The forecast rows' selection boxes. */
  boxX: number;
  boxWidth: number;
  /** The span of the page's text: the title starts at textX, the location name ends at textRight. */
  textX: number;
  textRight: number;
  /** The title line's top, at the window's top padding. */
  top: number;
  /** The window's bottom padding, kept under a footer line and inside the forecast list. */
  padBottom: number;
};

function pageLayout({ width, height, padding }: Viewport): PageLayout {
  return {
    width,
    height,
    boxX: padding.left,
    boxWidth: width - padding.left - padding.right,
    textX: padding.left + PAGE_TEXT_INSET,
    textRight: width - padding.right - PAGE_TEXT_INSET,
    top: padding.top,
    padBottom: padding.bottom,
  };
}

/** Forecast column x offsets from the row box's left edge. */
type ForecastColumns = { name: number; temp: number; precip: number; summary: number };

/** Weather's current-conditions summary and scrollable 12-hour forecast. */
export class WeatherLayer implements Layer {
  /** Forecast table rows: selection only, a click does nothing there. */
  private readonly forecastMenu = new Menu<ForecastPeriod>({
    wrap: false,
    rowGap: FORECAST_ROW_GAP,
    highlight: { radius: 5 },
    getHeight: () => forecastRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawForecastRow(args),
  });
  /** Column layout for drawForecastRow, set by each drawForecast. */
  private columns: ForecastColumns = { name: 0, temp: 0, precip: 0, summary: 0 };

  constructor(
    private readonly state: () => WeatherState,
    private readonly requestUpdate: () => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const page = pageLayout(ctx.stack.getBaseSize());
    const image = new GrayImage(page.width, page.height, 0);
    const weather = this.state();
    image.drawText(font, page.textX, page.top, "Weather", 225);
    if (weather.locationName) {
      const locationName = truncateText(font, weather.locationName, 220);
      image.drawText(font, page.textRight - font.measureText(locationName), page.top, locationName, 150);
    }

    if (weather.phase === "permission-required") {
      this.drawMessage(
        image,
        font,
        page,
        "Allow approximate location on your phone to get local weather.",
        `${GESTURE_CLICK} request`,
      );
      return image;
    }
    // A refresh with earlier data in hand keeps showing that data.
    if ((weather.phase === "locating" || weather.phase === "loading") && !weather.current) {
      this.drawMessage(image, font, page, weather.status);
      return image;
    }
    if (weather.phase === "error") {
      this.drawMessage(image, font, page, weather.status, `${GESTURE_CLICK} retry`);
      return image;
    }

    this.drawCurrent(image, weather, page);
    this.drawForecast(image, weather.forecast, ctx, page);
    return image;
  }

  handleInput(event: InputEvent): void {
    const weather = this.state();
    if (event.type === "click") {
      // Refresh on the forecast view lives in the long-press menu; a tap
      // only acts on the permission prompt and the error screen.
      if (weather.phase === "permission-required" || weather.phase === "error") {
        this.requestUpdate();
      }
      return;
    }
    if (!weather.forecast.length || !showsForecast(weather)) return;
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.forecastMenu.setItems(weather.forecast);
      void this.forecastMenu.handleInput(event);
    }
  }

  private drawCurrent(image: GrayImage, weather: WeatherState, page: PageLayout): void {
    const current = weather.current;
    if (!current) return;
    const large = getDefaultLargeFont();
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const temperature = current.temperatureF === null ? "--°" : formatTemperature(current.temperatureF);
    const temperatureY = page.top + TEMPERATURE_OFFSET_Y;
    let temperatureX = page.textX;
    if (current.condition) {
      const icon = renderWeatherIcon(current.condition, current.isDaytime, CURRENT_ICON_SIZE);
      if (icon) image.drawImage(icon, page.textX, temperatureY + (((large.lineHeight - icon.height) / 2) | 0));
      temperatureX += CURRENT_ICON_SIZE + CURRENT_ICON_GAP;
    }
    image.drawText(large, temperatureX, temperatureY, temperature, 245);
    const textX = Math.max(
      page.textX + CURRENT_TEXT_MIN_OFFSET_X,
      temperatureX + Math.ceil(large.measureText(temperature)) + CURRENT_TEXT_GAP,
    );
    // Description / details / source stack compactly from just below the
    // header line, so at large font sizes they stay clear of the forecast
    // table instead of running into it.
    let cy = page.top + CURRENT_TEXT_OFFSET_Y;
    image.drawText(
      medium,
      textX,
      cy,
      truncateText(medium, current.description || "Current conditions", page.textRight - textX),
      220,
    );
    cy += medium.lineHeight + 2;

    const details: string[] = [];
    if (current.humidityPercent !== null) details.push(`Humidity ${Math.round(current.humidityPercent)}%`);
    if (current.windSpeedMph !== null) {
      details.push(`Wind ${current.windDirection ? `${current.windDirection} ` : ""}${formatWindSpeed(current.windSpeedMph)}`);
    }
    image.drawText(small, textX, cy, details.join("   ") || "Current forecast", 170);
    cy += lineStep(small);
    // Naming the source also credits Open-Meteo, as its CC BY licence asks.
    const sourceName = weather.source ? `${WEATHER_SOURCE_NAMES[weather.source]} ` : "";
    const source = `${sourceName}${current.observed ? "observed" : "forecast"}`;
    const age = current.timestampMs ? formatAge(Date.now() - current.timestampMs) : "";
    const updating = weather.phase === "locating" || weather.phase === "loading" ? " · updating" : "";
    image.drawText(small, textX, cy, `${source}${age ? ` ${age}` : ""}${updating}`, 105);
    const ruleY = page.top + FORECAST_RULE_OFFSET_Y;
    image.drawLine(page.textX, ruleY, page.textRight - 1, ruleY, 40);
  }

  private drawForecast(
    image: GrayImage,
    forecast: ForecastPeriod[],
    ctx: LayerContext,
    page: PageLayout,
  ): void {
    const font = getDefaultSmallFont();
    const forecastTop = page.top + FORECAST_OFFSET_Y;
    if (!forecast.length) {
      image.drawText(font, page.textX, forecastTop, "No upcoming forecast periods.", 160);
      return;
    }

    // Columns are sized to the widest period name so names ("Wednesday
    // Night") never truncate; the summary column absorbs what's left.
    const nameWidth = Math.max(
      font.measureText("Upcoming"),
      ...forecast.map((period) => font.measureText(period.name)),
    );
    const tempX = page.textX + nameWidth + FORECAST_COL_GAP;
    const precipX = tempX + Math.max(font.measureText("Temp"), font.measureText(widestTemperatureSample())) + FORECAST_COL_GAP;
    const summaryX = precipX + Math.max(font.measureText("Rain"), font.measureText("100%")) + FORECAST_COL_GAP;

    const headerY = page.top + FORECAST_HEADER_OFFSET_Y;
    image.drawText(font, page.textX, headerY, "Upcoming", 150);
    image.drawText(font, tempX, headerY, "Temp", 105);
    image.drawText(font, precipX, headerY, "Rain", 105);

    this.columns = {
      name: page.textX - page.boxX,
      temp: tempX - page.boxX,
      precip: precipX - page.boxX,
      summary: summaryX - page.boxX,
    };
    this.forecastMenu.setItems(forecast);
    // The rows scroll under the fixed column headings, down to the window's
    // bottom edge, where a row cut off for scrolling meets the edge; that
    // edge's padding goes inside the list, after its last row.
    const boxTop = forecastTop - 2;
    if (boxTop >= page.height) return;
    this.forecastMenu.paint(
      image,
      { x: page.boxX, y: boxTop, width: page.boxWidth, height: page.height - boxTop, padBottom: page.padBottom },
      ctx.stack.isFocused(),
    );
  }

  private drawForecastRow({ image, item: period, x, y, width, height, selected }: MenuDrawArgs<ForecastPeriod>): void {
    const font = getDefaultSmallFont();
    const columns = this.columns;
    const shade = selected ? 245 : 190;
    const textY = centeredTextY(font, y, height);
    image.drawText(font, x + columns.name, textY, period.name, shade);
    image.drawText(font, x + columns.temp, textY, period.temperatureF === null ? "--" : formatTemperature(period.temperatureF), shade);
    image.drawText(font, x + columns.precip, textY, period.precipitationPercent === null ? "--" : `${Math.round(period.precipitationPercent)}%`, selected ? 220 : 155);
    // The summary stops as far short of the selection box's right edge as the name starts in from its left.
    const summaryWidth = width - columns.summary - columns.name;
    image.drawText(font, x + columns.summary, textY, truncateText(font, period.shortForecast, summaryWidth), selected ? 220 : 165);
  }

  private drawMessage(
    image: GrayImage,
    font: UiFont,
    page: PageLayout,
    message: string,
    footer?: string,
  ): void {
    const lines = wrapText(font, message, page.textRight - page.textX - 2 * MESSAGE_INDENT);
    // Centered in the window, but never up into the title line.
    const top = Math.max(page.top + MESSAGE_MIN_OFFSET_Y, Math.round((page.height - lines.length * 15) / 2) - 8);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, page.textX + MESSAGE_INDENT, top + index * 15, lines[index]!, 185);
    }
    if (footer) {
      image.drawText(font, page.textX, page.height - page.padBottom - font.lineHeight, footer, 110);
    }
  }
}

/** Whether paint shows the forecast table (ready, or refreshing over earlier data). */
function showsForecast(weather: WeatherState): boolean {
  if (weather.phase === "ready") return true;
  return (weather.phase === "locating" || weather.phase === "loading") && weather.current !== null;
}

/** Forecast row pitch, including the gap between selection boxes. */
function forecastRowHeight(font: UiFont): number {
  return Math.max(FORECAST_MIN_ROW_HEIGHT, tightRowHeight(font) + 3);
}

/** A wind speed (weather data is kept in mph) in the Distance unit setting's speed unit: "12 mph" / "19 km/h". */
function formatWindSpeed(mph: number): string {
  return distanceUnitSetting.get() === "kilometers" ? `${Math.round(mph * 1.609344)} km/h` : `${Math.round(mph)} mph`;
}

function formatAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

