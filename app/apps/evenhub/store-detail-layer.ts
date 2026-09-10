import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { TextViewerLayer } from "../files/text-viewer";
import { evenHubApi, type EvenHubStoreApp } from "./even-api";
import {
  getInstalledEvenHubApp,
  installedEvenHubAppId,
  setInstalledEvenHubIcon,
  type InstalledEvenHubApp,
} from "./installed-apps";
import { cleanError, installStoreApp } from "./store-install";
import { describeUpdate } from "./updates";
import { lineStep, listRowHeight } from "../../ui/metrics";

const X = 18;

export type EvenHubStoreDetailOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  appendLog: (message: string) => void;
  /** A package was installed, updated, or reinstalled from this page. */
  onInstalled?: (app: InstalledEvenHubApp) => void;
};

/** Storefront metadata and the Install/Launch action for one public app. */
export class EvenHubStoreDetailLayer implements Layer {
  /** About, What's New, Install/Launch. */
  private selectedIndex = 2;
  private working = false;
  private detailPromise: Promise<void> | null = null;
  private status = "";

  constructor(
    private app: EvenHubStoreApp,
    private readonly options: EvenHubStoreDetailOptions,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    if (!this.detailPromise) void this.ensureDetail(ctx);
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font);
    const actionRowH = listRowHeight(font) + 4;

    const installed = getInstalledEvenHubApp(this.app.packageId);
    const actions = ["About", "What's New", this.working ? "Installing..." : this.primaryActionLabel(installed)];

    // Detail lines as (text, shade, extra gap below); built per candidate
    // width so the layout choice below can measure before drawing.
    const buildLines = (textWidth: number): { text: string; value: number; gapAfter: number }[] => {
      const lines: { text: string; value: number; gapAfter: number }[] = [];
      lines.push({ text: truncateText(font, this.app.name, textWidth), value: 235, gapAfter: 2 });
      const creator = this.app.creatorName ? `by ${this.app.creatorName}` : this.app.packageId;
      lines.push({ text: truncateText(font, creator, textWidth), value: 130, gapAfter: 6 });
      const summary = this.app.tagline || this.app.description || "No description supplied.";
      const summaryLines = wrapText(font, summary, textWidth).slice(0, 3);
      for (const [index, line] of summaryLines.entries()) {
        lines.push({ text: line, value: 205, gapAfter: index === summaryLines.length - 1 ? 4 : 0 });
      }
      const metadata = [
        `${formatCount(this.app.installCount)} installs  ·  ${formatCount(this.app.likeCount)} likes`,
        this.app.version ? `Version ${this.app.version}${this.app.fileSize ? `  ·  ${formatBytes(this.app.fileSize)}` : ""}` : "",
        this.app.categories.length ? `Categories: ${this.app.categories.join(", ")}` : "",
        this.app.firstPublishedAt ? `Published: ${formatDate(this.app.firstPublishedAt)}` : "",
      ].filter(Boolean);
      for (const line of metadata) {
        lines.push({ text: truncateText(font, line, textWidth), value: 125, gapAfter: 0 });
      }
      if (installed && !this.status) {
        const standing = describeUpdate(installed, this.app);
        const note = standing.packageMissing
          ? "  ·  package missing, reinstall"
          : standing.updateAvailable
            ? "  ·  update available"
            : "";
        lines.push({ text: truncateText(font, `Installed version ${installed.version}${note}`, textWidth), value: 155, gapAfter: 0 });
      }
      if (this.status) {
        lines.push({ text: truncateText(font, this.status, textWidth), value: 180, gapAfter: 0 });
      }
      return lines;
    };
    const linesHeight = (lines: { gapAfter: number }[]): number =>
      lines.reduce((sum, line) => sum + step + line.gapAfter, 0);

    // Stacked layout (details full-width, actions at the bottom) when it
    // fits; otherwise the actions become a narrow top-right menu and the
    // details flow down a left column beside it.
    const stackedActionTop = height - 6 - actions.length * actionRowH;
    const stacked = 8 + linesHeight(buildLines(width - X * 2)) + 6 <= stackedActionTop;
    const menuW = 150;
    const menuX = width - menuW - 12;
    const textWidth = stacked ? width - X * 2 : menuX - X - 14;

    let y = 8;
    for (const line of buildLines(textWidth)) {
      image.drawText(font, X, y, line.text, line.value);
      y += step + line.gapAfter;
    }

    const actionX = stacked ? X : menuX;
    const actionW = stacked ? textWidth : menuW;
    const actionTop = stacked ? stackedActionTop : 8;
    for (let index = 0; index < actions.length; index++) {
      const actionY = actionTop + index * actionRowH;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, actionX - 5, actionY, actionW + 10, actionRowH - 1, ctx.stack.isFocused(), 8);
      }
      const value = this.working && index === 2 ? 145 : selected ? 245 : 190;
      image.drawText(font, actionX + 6, actionY + 5, truncateText(font, actions[index]!, actionW - 8), value);
    }
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      if (!this.working) ctx.stack.pop();
      return;
    }
    if (this.working) return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(2, this.selectedIndex + 1);
      return;
    }
    if (event.type !== "click") return;

    await this.ensureDetail(ctx);

    if (this.selectedIndex === 0) {
      ctx.stack.push(new TextViewerLayer(this.app.description || "No description supplied.", "About"));
      return;
    }
    if (this.selectedIndex === 1) {
      ctx.stack.push(new TextViewerLayer(this.app.changelog || "No release notes supplied.", "What's New"));
      return;
    }

    const installed = getInstalledEvenHubApp(this.app.packageId);
    if (installed && this.primaryActionLabel(installed) === "Launch") {
      await this.options.launchApp(installedEvenHubAppId(installed.packageId));
      return;
    }

    await this.install(ctx);
  }

  /** Install for a new app; Update / Reinstall when the installed copy is stale or gone. */
  private primaryActionLabel(installed: InstalledEvenHubApp | null): string {
    if (!installed) return "Install";
    const standing = describeUpdate(installed, this.app);
    if (standing.packageMissing) return "Reinstall";
    return standing.updateAvailable ? "Update" : "Launch";
  }

  private async install(ctx: LayerContext): Promise<void> {
    this.working = true;
    ctx.actions.requestRender();
    try {
      const result = await installStoreApp(ctx, this.app, {
        appendLog: this.options.appendLog,
        onStatus: (status) => {
          this.status = status;
          ctx.actions.requestRender();
        },
      });
      if (!result) {
        this.status = "Installation canceled.";
        return;
      }
      this.status = "Installed";
      this.options.onInstalled?.(result);
      ctx.actions.requestRender();
      await this.options.launchApp(installedEvenHubAppId(result.packageId));
    } catch (error) {
      this.status = cleanError(error);
      this.options.appendLog(`evenhub store: ${this.status}`);
    } finally {
      this.working = false;
      ctx.actions.requestRender();
    }
  }

  private ensureDetail(ctx: LayerContext): Promise<void> {
    if (this.detailPromise) return this.detailPromise;
    this.detailPromise = evenHubApi
      .getStoreAppDetail(this.app.packageId)
      .then((detail) => {
        if (detail) this.app = { ...this.app, ...detail };
        const installed = getInstalledEvenHubApp(this.app.packageId);
        if (installed && !installed.iconFile && this.app.iconPath) {
          return evenHubApi.downloadPublicAsset(this.app.iconPath).then((icon) => {
            setInstalledEvenHubIcon(this.app.packageId, icon);
          });
        }
        return undefined;
      })
      .catch((error) => {
        this.options.appendLog(`evenhub store: app details unavailable: ${cleanError(error)}`);
      })
      .finally(() => ctx.actions.requestRender());
    return this.detailPromise;
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
