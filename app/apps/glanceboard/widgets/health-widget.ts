import { type GrayImage } from "../../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { dailySummary, nextBucketStart } from "../../../health/health-derive";
import { drawHealthCard, type HealthCardData } from "../../../health/health-card";
import { syncLiveRecords } from "../../../health/health-live";
import { isFixtureData } from "../../../health/health-seed";
import { healthStore } from "../../../health/health-store-files";
import { startOfLocalDay } from "../../../health/health-types";
import { type GlanceWidget } from "../widget";

/** Saved daily metrics, refreshed while visible without extra BLE polling. */
export class HealthWidget implements GlanceWidget {
  private data: HealthCardData = { kind: "empty" };
  private timer: ReturnType<typeof setInterval> | null = null;

  start(requestRender: () => void): void {
    this.stop();
    const refresh = (): void => {
      this.refresh();
      requestRender();
    };
    refresh();
    this.timer = setInterval(refresh, 60_000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private refresh(): void {
    try {
      syncLiveRecords();
      if (isFixtureData()) {
        this.data = { kind: "fixture" };
        return;
      }
      const today = startOfLocalDay(Date.now());
      const store = healthStore();
      const samples = store.samplesInRange(today, nextBucketStart(today, "day"));
      const summary = dailySummary(samples, store.sleepSessions(), today);
      this.data = samples.length || summary.sleep
        ? { kind: "live", summary,
          hasSteps: samples.some((sample) => sample.metric === "steps"),
          hasCalories: samples.some((sample) => sample.metric === "calories") }
        : { kind: "empty" };
    } catch (error) {
      console.warn("health widget refresh failed", error);
      this.data = { kind: "error" };
    }
  }

  paint(image: GrayImage): void {
    drawHealthCard(image, this.data, getDefaultSmallFont(), getDefaultMediumFont());
  }
}
