import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { drawListScrollbar, drawSelectionHighlight, scrollToKeepSelectionVisible, type MenuItem } from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import { evenHubApi, EvenHubAuthenticationError, isEvenHubStoreConfigured, type EvenHubStoreApp } from "./even-api";
import { clearEvenHubLoginForm, clearEvenHubSession, clearTransientEvenHubSession, evenHubLoginEmailSetting, evenHubLoginPasswordSetting, evenHubRememberMeSetting, resetEvenHubLoginForm } from "./credentials";
import { EvenHubStoreDetailLayer } from "./store-detail-layer";
import { lineStep } from "../../ui/metrics";

const LIST_X = 18;

/** Header: title line, then the status/subtitle line, then a small gap. */
function headerHeight(font: UiFont): number {
  return 8 + lineStep(font) + font.lineHeight + 6;
}

export type EvenHubStoreLayerOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  appendLog: (message: string) => void;
};

/** Browse the public EvenHub leaderboard and download one package to run. */
export class EvenHubStoreLayer implements Layer {
  private apps: EvenHubStoreApp[] = [];
  private selectedIndex = 0;
  private scrollRow = 0;
  private total = 0;
  private nextPage = 1;
  private started = false;
  private loading = false;
  private showingLogin = !isEvenHubStoreConfigured();
  private status = this.showingLogin ? "Sign in to browse public apps." : "";
  private credentialEditorOpen = false;
  private closed = false;

  constructor(private readonly options: EvenHubStoreLayerOptions) {
    if (this.showingLogin) resetEvenHubLoginForm();
  }

  paint(ctx: LayerContext): GrayImage {
    if (!this.started) {
      this.started = true;
      if (this.showingLogin) {
        this.openCredentialEditor(ctx);
      } else {
        void this.reload(ctx);
      }
    }

    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const headerH = headerHeight(font);
    image.drawText(font, LIST_X, 8, "EvenHub", 220);

    const subtitle = this.status || (this.total ? `${this.apps.length} of ${this.total} public apps` : "Public apps");
    image.drawText(font, LIST_X, 8 + lineStep(font), truncateText(font, subtitle, width - LIST_X * 2), 125);

    if (this.showingLogin) {
      const message = this.loading
        ? "Signing in..."
        : "Enter your Even account email and password in the phone app.";
      for (const [index, line] of wrapText(font, message, width - LIST_X * 2).entries()) {
        image.drawText(font, LIST_X, headerH + 16 + index * lineStep(font), line, 190);
      }
      image.drawText(font, LIST_X, height - font.lineHeight - 4, `${GESTURE_CLICK} edit credentials`, 105);
      return image;
    }

    if (this.apps.length === 0) {
      const message = this.loading ? "Loading apps..." : this.status || "No apps returned.";
      image.drawText(font, LIST_X, headerH + 22, truncateText(font, message, width - LIST_X * 2), 190);
    } else {
      this.selectedIndex = clamp(this.selectedIndex, 0, this.apps.length - 1);
      const rowH = Math.max(30, 2 * lineStep(font) + 4);
      const visibleRows = Math.max(1, Math.floor((height - headerH - 4) / rowH));
      this.scrollRow = scrollToKeepSelectionVisible(
        this.scrollRow,
        this.selectedIndex,
        visibleRows,
        this.apps.length,
      );
      const last = Math.min(this.apps.length, this.scrollRow + visibleRows);
      for (let index = this.scrollRow; index < last; index++) {
        const app = this.apps[index]!;
        const y = headerH + (index - this.scrollRow) * rowH;
        const selected = index === this.selectedIndex;
        if (selected) {
          drawSelectionHighlight(image, LIST_X - 6, y, width - LIST_X * 2 + 12, rowH - 2, ctx.stack.isFocused(), 5);
        }
        image.drawText(font, LIST_X, y + 2, truncateText(font, app.name, width - LIST_X * 2), 215);
        const detail = app.tagline || `${app.creatorName} · ${formatCount(app.installCount)} installs`;
        image.drawText(font, LIST_X, y + 2 + lineStep(font), truncateText(font, detail, width - LIST_X * 2), 115);
      }
      if (this.apps.length > visibleRows) {
        drawListScrollbar(image, width - 5, headerH, visibleRows * rowH - 3, this.scrollRow, visibleRows, this.apps.length);
      }
    }

    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.showingLogin) {
      if (event.type === "click" && !this.loading) {
        this.openCredentialEditor(ctx);
      } else if (event.type === "double-click") {
        shell.yieldFocusToSidebar();
      }
      return;
    }
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(Math.max(0, this.apps.length - 1), this.selectedIndex + 1);
        if (this.selectedIndex >= this.apps.length - 4 && this.apps.length < this.total) {
          void this.loadNextPage(ctx);
        }
        return;
      case "click":
        if (!this.loading) {
          const app = this.apps[this.selectedIndex];
          if (app) {
            ctx.stack.push(
              new EvenHubStoreDetailLayer(app, {
                launchApp: this.options.launchApp,
                appendLog: this.options.appendLog,
              }),
            );
          }
        }
        return;
      case "double-click":
        shell.yieldFocusToSidebar();
        return;
      default:
        return;
    }
  }

  buildMenuItems(): MenuItem[] {
    if (this.showingLogin) return [];
    return [
      {
        label: "Refresh",
        onSelect: (ctx) => {
          ctx.stack.pop();
          void this.reload(ctx);
        },
      },
      {
        label: "Log Out",
        onSelect: (ctx) => {
          ctx.stack.pop();
          clearEvenHubSession();
          this.enterLogin(ctx, "Signed out.");
        },
      },
    ];
  }

  closeCredentialEditor(actions: Pick<LayerActions, "endTextSettingEdit">): void {
    if (!this.credentialEditorOpen) return;
    this.credentialEditorOpen = false;
    void actions.endTextSettingEdit();
  }

  onWindowClosed(actions: Pick<LayerActions, "endTextSettingEdit">): void {
    this.closed = true;
    this.closeCredentialEditor(actions);
    clearTransientEvenHubSession();
  }

  private async reload(ctx: LayerContext): Promise<void> {
    if (this.loading) return;
    this.apps = [];
    this.total = 0;
    this.nextPage = 1;
    this.selectedIndex = 0;
    this.scrollRow = 0;
    this.status = "";
    if (!isEvenHubStoreConfigured()) {
      this.enterLogin(ctx);
      return;
    }
    await this.loadNextPage(ctx);
  }

  private async loadNextPage(ctx: LayerContext): Promise<void> {
    if (this.loading || (this.total > 0 && this.apps.length >= this.total)) return;
    this.loading = true;
    this.status = this.apps.length ? "Loading more apps..." : "Loading apps...";
    ctx.actions.requestRender();
    try {
      const page = await evenHubApi.listApps(this.nextPage);
      const seen = new Set(this.apps.map((app) => app.packageId));
      this.apps.push(...page.apps.filter((app) => !seen.has(app.packageId)));
      this.total = page.total;
      this.nextPage = page.page + 1;
      this.status = "";
    } catch (error) {
      const message = cleanError(error);
      if (error instanceof EvenHubAuthenticationError) {
        this.options.appendLog(`evenhub store login failed: ${message}`);
        this.enterLogin(ctx, `Login failed: ${message}`);
        return;
      }
      this.status = message;
      this.options.appendLog(`evenhub store: ${this.status}`);
    } finally {
      this.loading = false;
      ctx.actions.requestRender();
    }
  }

  private enterLogin(ctx: LayerContext, status = "Sign in to browse public apps."): void {
    const wasShowingLogin = this.showingLogin;
    this.showingLogin = true;
    this.loading = false;
    this.apps = [];
    this.total = 0;
    this.status = status;
    if (!wasShowingLogin) resetEvenHubLoginForm();
    this.openCredentialEditor(ctx);
    ctx.actions.requestRender();
  }

  private openCredentialEditor(ctx: LayerContext): void {
    if (this.credentialEditorOpen) return;
    this.credentialEditorOpen = true;
    void ctx.actions.startTextSettingsEdit(
      [evenHubLoginEmailSetting, evenHubLoginPasswordSetting],
      "Sign in to EvenHub",
      () => {
        this.credentialEditorOpen = false;
        void this.submitCredentials(ctx);
      },
      { setting: evenHubRememberMeSetting, label: "Remember me" },
    );
  }

  private async submitCredentials(ctx: LayerContext): Promise<void> {
    const email = evenHubLoginEmailSetting.get();
    const password = evenHubLoginPasswordSetting.get();
    if (!email.trim() || !password) {
      this.enterLogin(ctx, "Email and password are required.");
      return;
    }
    this.loading = true;
    this.status = "Signing in...";
    ctx.actions.requestRender();
    try {
      await evenHubApi.signIn(email, password, evenHubRememberMeSetting.get());
      if (this.closed) {
        clearTransientEvenHubSession();
        return;
      }
      this.showingLogin = false;
      clearEvenHubLoginForm();
      this.loading = false;
      await this.reload(ctx);
    } catch (error) {
      if (this.closed) return;
      const message = cleanError(error);
      this.options.appendLog(`evenhub store login failed: ${message}`);
      this.status = `Login failed: ${message}`;
      evenHubLoginPasswordSetting.set("");
      this.openCredentialEditor(ctx);
    } finally {
      evenHubLoginPasswordSetting.set("");
      this.loading = false;
      if (!this.closed) ctx.actions.requestRender();
    }
  }

}

function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
