/**
 * HEALTH - the glasses status page.
 *
 * This file is now PLUMBING ONLY: the store reads, the refresh timer, the
 * scroll cursor, the window lifecycle. Every pixel is drawn by
 * `health/health-glance.ts`, which has no NativeScript imports and therefore
 * renders under plain node - see `tools/health-preview.cjs`, which produces a
 * PNG of each page below without an emulator. The first pass drew and plumbed
 * in one file and could only be looked at by booting an AVD; that is the
 * difference this split buys, and it is the reason to keep the two apart.
 *
 * ## The surface, after Chris's 2026-09-10 review
 *
 * The overview is a SUMMARY - text only, no charts - and scrolling walks a
 * cursor through a detail page per parameter, ending at sleep's own view.
 * `GLANCE_PAGES` in `health-glance.ts` is the page list, and the doc comment
 * there carries the reasoning for the carousel (including which parts of it are
 * interpretation rather than spec).
 */

import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { dailySummary, hypnogram, rollupSeries, type DailySummary } from "../../health/health-derive";
import {
  drawGlancePage,
  GLANCE_PAGES,
  type GlanceData,
} from "../../health/health-glance";
import { healthStore } from "../../health/health-store-files";
import { requestFreshPull, syncLiveRecords } from "../../health/health-live";
import { isFixtureData, seedFixturesIfNeeded } from "../../health/health-seed";
import {
  DAY_MS,
  SAMPLE_METRICS,
  startOfLocalDay,
  type RollupPoint,
  type SampleMetric,
} from "../../health/health-types";

export const HEALTH_WINDOW_ID = "health";
export const HEALTH_SURFACE_ID = "window:health";

/** Cheap enough to re-read on a timer; the store is a few hundred rows a day. */
const REFRESH_INTERVAL_MS = 60_000;

class HealthLayer implements Layer {
  private summary: DailySummary | null = null;
  /** Today by hour, per metric - what the drill-down pages plot. */
  private hourly: Partial<Record<SampleMetric, RollupPoint[]>> = {};
  private stageBands: GlanceData["stageBands"] = [];
  private fixture = false;
  /** Index into GLANCE_PAGES. 0 is the overview. */
  private pageIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private removed = false;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    // Live data first: if the ring has been pulled this session, this stores it
    // and wipes any fixtures out of the way. Only if that leaves us with
    // nothing does seeding fill the screen, and seeding refuses outright once
    // real data has ever landed.
    syncLiveRecords();
    // Ask for something current rather than showing whatever the last
    // automatic 30-minute pull happened to catch. Returns immediately; the
    // pull takes ~15s and lands via the refresh tick below.
    requestFreshPull();
    seedFixturesIfNeeded();
    this.reload();
    this.timer = setInterval(() => this.reload(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  onRemoved(): void {
    this.stop();
  }

  private reload(): void {
    if (this.removed) return;
    // Cheap on every tick: a no-op when the communicator has nothing new, and
    // the store dedupes when it does, so a 30-minute pull shows up here within
    // one refresh instead of waiting for the app to be reopened.
    syncLiveRecords();
    try {
      const store = healthStore();
      const today = startOfLocalDay(Date.now());
      const samples = store.samplesInRange(today, today + DAY_MS);
      const sessions = store.sleepSessions();
      this.summary = dailySummary(samples, sessions, today);
      // One pass per metric over a day's samples - a few hundred rows, and the
      // drill-down has to be instant when the cursor lands on it.
      const hourly: Partial<Record<SampleMetric, RollupPoint[]>> = {};
      for (const metric of SAMPLE_METRICS) {
        hourly[metric] = rollupSeries(samples, {
          metric,
          granularity: "hour",
          startMs: today,
          endMs: today + DAY_MS,
        });
      }
      this.hourly = hourly;
      const night = sessions.find((session) => session.dayStartMs === today);
      this.stageBands = night ? hypnogram(night) : [];
      this.fixture = isFixtureData();
    } catch (error) {
      console.warn("health glance reload failed", error);
    }
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    drawGlancePage(
      image,
      { width, height },
      { small: getDefaultSmallFont(), large: getDefaultLargeFont() },
      GLANCE_PAGES[this.pageIndex] ?? GLANCE_PAGES[0]!,
      {
        summary: this.summary,
        hourly: this.hourly,
        stageBands: this.stageBands,
        nowMs: Date.now(),
        fixture: this.fixture,
      },
    );
    return image;
  }

  /**
   * Scrolling moves between the overview and the per-parameter detail pages.
   *
   * The cursor WRAPS. With seven pages and no back gesture available
   * (`YieldAtRootLayer` takes double-click for back-out-to-home), wrapping is
   * what guarantees the overview is always reachable by holding one direction -
   * a user who has scrolled to the end never has to work out which way is back.
   * Click advances too, so the drill-down is reachable without ever scrolling.
   */
  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
      case "click":
        this.movePage(1);
        return;
      case "scroll-up":
        this.movePage(-1);
        return;
      default:
        return;
    }
  }

  private movePage(delta: number): void {
    const count = GLANCE_PAGES.length;
    this.pageIndex = (this.pageIndex + delta + count) % count;
    this.requestRender();
  }
}

export function createHealthAppWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new HealthLayer(() => requestRender());
  const app = createInProcessWindow({
    appId: "health",
    windowId: HEALTH_WINDOW_ID,
    title: "Health",
    iconLetter: "H",
    icon: "activity",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}
