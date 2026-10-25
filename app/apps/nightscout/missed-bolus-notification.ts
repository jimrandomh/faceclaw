import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { renderIcon } from "../../graphics/icons";
import { wrapText } from "../../graphics/textwrap";
import { formatRelativeTime } from "../../util/date-util";
import { nightscoutBridge } from "../../native/nightscout-bridge";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import {
  NOTIFICATION_CONTENT_X,
  createNotificationActionMenu,
  drawNotificationHeader,
  notificationActionMenuBox,
  notificationContentWidth,
} from "../../ui/notifications";
import { type GlucoseRise } from "./missed-bolus-detector";
import {
  drawDirectionIndicator,
  drawNightscoutGraph,
  drawNightscoutValueStrikeThrough,
  formatDelta,
  isNightscoutPointStale,
} from "./nightscout";

const ICON_SIZE = 24;
const GRAPH_GAP = 6;
const GRAPH_BOTTOM_MARGIN = 12;
const MIN_GRAPH_HEIGHT = 32;

type ActionItem = { label: string; run: () => void };

/**
 * The missed-bolus alert, laid out like an Android notification's detail view
 * (header, text, right-hand action column), with the live glucose readout and
 * 2-hour graph below the text.
 */
export class MissedBolusNotificationLayer implements Layer {
  private readonly menu = createNotificationActionMenu<ActionItem>();

  constructor(
    private readonly rise: GlucoseRise,
    private readonly postedAtMs: number,
    private readonly close: () => void,
    openNightscout: () => void,
  ) {
    this.menu.setItems([
      { label: "Dismiss", run: close },
      { label: "Open Nightscout", run: () => {
        close();
        openNightscout();
      } },
    ]);
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const step = lineStep(font);
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const contentX = NOTIFICATION_CONTENT_X;
    const contentWidth = notificationContentWidth(width);
    const nowMs = Date.now();

    let y = drawNotificationHeader(image, font, renderIcon("nightscout", ICON_SIZE), `Nightscout  ${formatRelativeTime(this.postedAtMs)}`);
    image.drawText(font, contentX, y, "Missed bolus?", 230);
    y += step;
    const minutes = Math.round((this.rise.latestMs - this.rise.onsetMs) / 60_000);
    const body = `Glucose rose ${this.rise.riseMgdl} mg/dL in ${minutes} min with no bolus or carbs entered.`;
    for (const line of wrapText(font, body, contentWidth)) {
      image.drawText(font, contentX, y, line, 190);
      y += step;
    }

    // Live readout and graph: the modal repaints with each shell render, so
    // these follow new readings (and a bolus, once entered) while it is up.
    const nightscout = nightscoutBridge.snapshot();
    const latest = nightscout.latest;
    if (latest) {
      const value = `${latest.sgv}`;
      image.drawText(font, contentX, y, value, 230);
      if (isNightscoutPointStale(latest, nowMs)) {
        drawNightscoutValueStrikeThrough(image, contentX, y + (font.lineHeight >> 1), font.measureText(value));
      }
      let x = contentX + font.measureText(`${value} `);
      x += drawDirectionIndicator(image, font, x, y, nightscout.direction, 200);
      x += font.measureText(" ");
      const iob = nightscout.iob === null ? "" : `  IOB ${nightscout.iob.toFixed(2)}`;
      image.drawText(font, x, y, `${formatDelta(nightscout.delta)}${iob}`, 180);
      y += step;
    }
    const graphTop = y + GRAPH_GAP;
    const graphHeight = height - GRAPH_BOTTOM_MARGIN - graphTop;
    if (graphHeight >= MIN_GRAPH_HEIGHT) {
      drawNightscoutGraph(image, { x: contentX, y: graphTop, width: contentWidth, height: graphHeight }, nightscout, nowMs, font);
    }

    this.menu.paint(image, notificationActionMenuBox(width, height), ctx.stack.isFocused());
    return image;
  }

  async handleInput(event: InputEvent): Promise<void> {
    if (event.type === "double-click") {
      this.close();
    } else if (event.type === "click") {
      this.menu.selectedItem?.run();
    } else if (event.type === "scroll-up" || event.type === "scroll-down") {
      await this.menu.handleInput(event);
    }
  }
}
