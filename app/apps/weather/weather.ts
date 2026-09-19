import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { type ForecastPeriod, type WeatherState } from "../../native/weather";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, scrollToKeepSelectionVisible } from "../../ui/menu";
import { lineStep, tightRowHeight } from "../../ui/metrics";

const PAGE_X = 18;
const HEADER_Y = 8;
const CURRENT_TOP = 34;
const CURRENT_TEXT_X = 112;
const FORECAST_HEADER_Y = 105;
const FORECAST_TOP = 124;
/** Forecast rows hold a 20px icon; grow with the font past that. */
const FORECAST_MIN_ROW_HEIGHT = 23;
/** Gap between forecast columns. */
const FORECAST_COL_GAP = 14;

/** Weather's current-conditions summary and scrollable 12-hour forecast. */
export class WeatherLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;

  constructor(
    private readonly state: () => WeatherState,
    private readonly requestUpdate: () => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const weather = this.state();
    image.drawText(font, PAGE_X, HEADER_Y, "Weather", 225);
    if (weather.locationName) {
      image.drawText(
        font,
        width - PAGE_X - font.measureText(truncateText(font, weather.locationName, 220)),
        HEADER_Y,
        truncateText(font, weather.locationName, 220),
        150,
      );
    }

    if (weather.phase === "permission-required") {
      this.drawMessage(
        image,
        font,
        width,
        height,
        "Allow approximate location on your phone to get local weather.",
        `${GESTURE_CLICK} request`,
      );
      return image;
    }
    if (weather.phase === "locating" || weather.phase === "loading") {
      this.drawMessage(image, font, width, height, weather.status);
      return image;
    }
    if (weather.phase === "error") {
      this.drawMessage(image, font, width, height, weather.status, `${GESTURE_CLICK} retry`);
      return image;
    }

    this.drawCurrent(image, weather, width);
    this.drawForecast(image, weather.forecast, ctx, width, height);
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
    if (!weather.forecast.length || weather.phase !== "ready") return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(weather.forecast.length - 1, this.selectedIndex + 1);
    }
  }

  private drawCurrent(image: GrayImage, weather: WeatherState, width: number): void {
    const current = weather.current;
    if (!current) return;
    const large = getDefaultLargeFont();
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const temperature = current.temperatureF === null ? "--°" : `${Math.round(current.temperatureF)}°F`;
    image.drawText(large, PAGE_X, CURRENT_TOP + 8, temperature, 245);
    // Description / details / source stack compactly from just below the
    // header line, so at large font sizes they stay clear of the forecast
    // table instead of running into it.
    let cy = 30;
    image.drawText(
      medium,
      CURRENT_TEXT_X,
      cy,
      truncateText(medium, current.description || "Current conditions", width - CURRENT_TEXT_X - PAGE_X),
      220,
    );
    cy += medium.lineHeight + 2;

    const details: string[] = [];
    if (current.humidityPercent !== null) details.push(`Humidity ${Math.round(current.humidityPercent)}%`);
    if (current.windSpeedMph !== null) {
      details.push(`Wind ${current.windDirection ? `${current.windDirection} ` : ""}${Math.round(current.windSpeedMph)} mph`);
    }
    image.drawText(small, CURRENT_TEXT_X, cy, details.join("   ") || "Current forecast", 170);
    cy += lineStep(small);
    const source = current.observed ? "Observed" : "Forecast";
    const age = current.timestampMs ? formatAge(Date.now() - current.timestampMs) : "";
    image.drawText(small, CURRENT_TEXT_X, cy, `${source}${age ? ` ${age}` : ""}`, 105);
    image.drawLine(PAGE_X, FORECAST_HEADER_Y - 7, width - PAGE_X, FORECAST_HEADER_Y - 7, 40);
  }

  private drawForecast(
    image: GrayImage,
    forecast: ForecastPeriod[],
    ctx: LayerContext,
    width: number,
    height: number,
  ): void {
    const font = getDefaultSmallFont();
    if (!forecast.length) {
      image.drawText(font, PAGE_X, FORECAST_TOP, "No upcoming forecast periods.", 160);
      return;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, forecast.length - 1);
    const rowH = Math.max(FORECAST_MIN_ROW_HEIGHT, tightRowHeight(font) + 3);
    // The last row only needs its text line (not a full row pitch of
    // clearance below), which usually fits one more row before the bottom.
    const visibleRows = Math.max(1, 1 + Math.floor((height - FORECAST_TOP - (font.lineHeight + 4)) / rowH));
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedIndex, visibleRows, forecast.length);

    // Columns are sized to the widest period name so names ("Wednesday
    // Night") never truncate; the summary column absorbs what's left.
    const nameWidth = Math.max(
      font.measureText("Upcoming"),
      ...forecast.map((period) => font.measureText(period.name)),
    );
    const tempX = PAGE_X + nameWidth + FORECAST_COL_GAP;
    const precipX = tempX + Math.max(font.measureText("Temp"), font.measureText("100°F")) + FORECAST_COL_GAP;
    const summaryX = precipX + Math.max(font.measureText("Rain"), font.measureText("100%")) + FORECAST_COL_GAP;

    image.drawText(font, PAGE_X, FORECAST_HEADER_Y, "Upcoming", 150);
    image.drawText(font, tempX, FORECAST_HEADER_Y, "Temp", 105);
    image.drawText(font, precipX, FORECAST_HEADER_Y, "Rain", 105);

    const last = Math.min(forecast.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < last; index++) {
      const period = forecast[index]!;
      const y = FORECAST_TOP + (index - this.scrollRow) * rowH;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, PAGE_X - 7, y - 2, width - 2 * (PAGE_X - 7), rowH - 2, ctx.stack.isFocused(), 5);
      }
      const shade = selected ? 245 : 190;
      image.drawText(font, PAGE_X, y + 2, period.name, shade);
      image.drawText(font, tempX, y + 2, period.temperatureF === null ? "--" : `${Math.round(period.temperatureF)}°F`, shade);
      image.drawText(font, precipX, y + 2, period.precipitationPercent === null ? "--" : `${Math.round(period.precipitationPercent)}%`, selected ? 220 : 155);
      image.drawText(font, summaryX, y + 2, truncateText(font, period.shortForecast, width - summaryX - PAGE_X), selected ? 220 : 165);
    }
  }

  private drawMessage(
    image: GrayImage,
    font: UiFont,
    width: number,
    height: number,
    message: string,
    footer?: string,
  ): void {
    const lines = wrapText(font, message, width - 2 * (PAGE_X + 6));
    const top = Math.max(52, Math.round((height - lines.length * 15) / 2) - 8);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, PAGE_X + 6, top + index * 15, lines[index]!, 185);
    }
    if (footer) {
      image.drawText(font, PAGE_X, height - 20, footer, 110);
    }
  }
}

function formatAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

