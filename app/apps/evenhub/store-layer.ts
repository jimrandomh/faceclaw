import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerActions, type LayerContext, type LayerStack } from "../../ui/layers";
import { drawListScrollbar, drawSelectionHighlight, scrollToKeepSelectionVisible, type MenuItem } from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import { ConfigSettingString } from "../../ui/dashboard-settings";
import { evenHubApi, EvenHubAuthenticationError, isEvenHubStoreConfigured, type EvenHubStoreApp, type EvenHubStorePage } from "./even-api";
import { clearEvenHubLoginForm, clearEvenHubSession, clearTransientEvenHubSession, evenHubLoginEmailSetting, evenHubLoginPasswordSetting, evenHubRememberMeSetting, resetEvenHubLoginForm } from "./credentials";
import { getInstalledEvenHubApps, uninstallEvenHubPackage, type InstalledEvenHubApp } from "./installed-apps";
import { EvenHubStoreDetailLayer } from "./store-detail-layer";
import { cleanError, installStoreApp } from "./store-install";
import { checkForEvenHubUpdates, describeUpdate, type EvenHubAppUpdate } from "./updates";
import { lineStep } from "../../ui/metrics";

const LIST_X = 18;
/** Horizontal gap between tab labels. */
const TAB_GAP = 18;

/** Header: title + tabs line, then the status/subtitle line, then a small gap. */
function headerHeight(font: UiFont): number {
  return 8 + lineStep(font) + font.lineHeight + 6;
}

/** Last search typed on the phone; kept so reopening the store shows it again. */
export const evenHubSearchQuerySetting = new ConfigSettingString({
  id: "evenhub-search-query",
  label: "Search",
  storageKey: "evenhub.store.searchQuery",
  defaultValue: "",
  editorTitle: "Search EvenHub",
  glassesEditTitle: "Search EvenHub",
  normalize: (value) => (value ?? "").replace(/\s+/g, " ").trim(),
});

type StoreTab = "top" | "new" | "search" | "updates";

const TABS: { id: StoreTab; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "new", label: "New" },
  { id: "search", label: "Search" },
  { id: "updates", label: "Updates" },
];

type StoreRow =
  /** A storefront app; `update` is set on the Updates tab. */
  | { kind: "app"; app: EvenHubStoreApp; update?: EvenHubAppUpdate }
  /** The Search tab's first row: shows the query and opens the phone editor. */
  | { kind: "search-query" }
  /** A registry entry whose package is gone and which the store no longer lists. */
  | { kind: "orphan"; update: EvenHubAppUpdate };

type TabState = {
  rows: StoreRow[];
  /** Server-reported total, or 0 when unknown. */
  total: number;
  nextPage: number;
  /** No further pages: the total was reached, or a page added nothing new. */
  exhausted: boolean;
  /** A load has completed (or failed) at least once. */
  loaded: boolean;
  loading: boolean;
  /** Progress or error text for the subtitle line. */
  status: string;
  selectedIndex: number;
  scrollRow: number;
  /** Search only: the query the rows belong to. */
  query: string;
};

function emptyTab(): TabState {
  return {
    rows: [],
    total: 0,
    nextPage: 1,
    exhausted: false,
    loaded: false,
    loading: false,
    status: "",
    selectedIndex: 0,
    scrollRow: 0,
    query: "",
  };
}

export type EvenHubStoreLayerOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  appendLog: (message: string) => void;
};

/**
 * The EvenHub storefront: Top (leaderboard), New (by first publication),
 * Search, and Updates (installed apps that are stale or whose package is
 * missing). The tab row is its own focus level above the list: double-click
 * in the list focuses the tabs, scrolling there switches tabs, and a click
 * returns to the list.
 */
export class EvenHubStoreLayer implements Layer {
  private readonly tabs: Record<StoreTab, TabState> = {
    top: emptyTab(),
    new: emptyTab(),
    search: emptyTab(),
    updates: emptyTab(),
  };
  private activeTab: StoreTab = "top";
  private focus: "list" | "tabs" = "list";
  private started = false;
  private showingLogin = !isEvenHubStoreConfigured();
  private loginStatus = this.showingLogin ? "Sign in to browse public apps." : "";
  private loginBusy = false;
  private phoneEditor: "none" | "credentials" | "search" = "none";
  private closed = false;
  /** Serializes the Update All action; also blocks per-row installs meanwhile. */
  private updatingAll = false;
  /** An app page requested while the login form was up; opened once signed in. */
  private pendingPackage: InstalledEvenHubApp | null = null;

  constructor(private readonly options: EvenHubStoreLayerOptions) {
    if (this.showingLogin) resetEvenHubLoginForm();
  }

  paint(ctx: LayerContext): GrayImage {
    if (!this.started) {
      this.started = true;
      if (this.showingLogin) {
        this.openCredentialEditor(ctx);
      } else {
        void this.ensureTabLoaded(ctx, this.activeTab);
      }
    }

    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const headerH = headerHeight(font);
    image.drawText(font, LIST_X, 8, "EvenHub", 220);

    if (this.showingLogin) {
      image.drawText(font, LIST_X, 8 + lineStep(font), truncateText(font, this.loginStatus, width - LIST_X * 2), 125);
      const message = this.loginBusy
        ? "Signing in..."
        : "Enter your Even account email and password in the phone app.";
      for (const [index, line] of wrapText(font, message, width - LIST_X * 2).entries()) {
        image.drawText(font, LIST_X, headerH + 16 + index * lineStep(font), line, 190);
      }
      image.drawText(font, LIST_X, height - font.lineHeight - 4, `${GESTURE_CLICK} edit credentials`, 105);
      return image;
    }

    this.paintTabs(image, font, ctx);

    const tab = this.tabs[this.activeTab];
    const subtitle = tab.status || this.subtitle(this.activeTab, tab);
    image.drawText(font, LIST_X, 8 + lineStep(font), truncateText(font, subtitle, width - LIST_X * 2), 125);

    if (tab.rows.length === 0) {
      const message = tab.loading ? "Loading..." : this.emptyMessage(this.activeTab, tab);
      for (const [index, line] of wrapText(font, message, width - LIST_X * 2).slice(0, 3).entries()) {
        image.drawText(font, LIST_X, headerH + 22 + index * lineStep(font), line, 190);
      }
      return image;
    }

    tab.selectedIndex = clamp(tab.selectedIndex, 0, tab.rows.length - 1);
    const rowH = Math.max(30, 2 * lineStep(font) + 4);
    const visibleRows = Math.max(1, Math.floor((height - headerH - 4) / rowH));
    tab.scrollRow = scrollToKeepSelectionVisible(tab.scrollRow, tab.selectedIndex, visibleRows, tab.rows.length);
    const last = Math.min(tab.rows.length, tab.scrollRow + visibleRows);
    const listFocused = ctx.stack.isFocused() && this.focus === "list";
    for (let index = tab.scrollRow; index < last; index++) {
      const row = tab.rows[index]!;
      const y = headerH + (index - tab.scrollRow) * rowH;
      if (index === tab.selectedIndex) {
        drawSelectionHighlight(image, LIST_X - 6, y, width - LIST_X * 2 + 12, rowH - 2, listFocused, 5);
      }
      const { title, detail, titleValue } = this.rowText(row);
      image.drawText(font, LIST_X, y + 2, truncateText(font, title, width - LIST_X * 2), titleValue);
      image.drawText(font, LIST_X, y + 2 + lineStep(font), truncateText(font, detail, width - LIST_X * 2), 115);
    }
    if (tab.rows.length > visibleRows) {
      drawListScrollbar(image, width - 5, headerH, visibleRows * rowH - 3, tab.scrollRow, visibleRows, tab.rows.length);
    }
    return image;
  }

  /** Tab labels to the right of the title; the active one is bright and underlined. */
  private paintTabs(image: GrayImage, font: UiFont, ctx: LayerContext): void {
    const tabsFocused = ctx.stack.isFocused() && this.focus === "tabs";
    let x = LIST_X + font.measureText("EvenHub") + 28;
    for (const tab of TABS) {
      const label = this.tabLabel(tab.id);
      const w = font.measureText(label);
      const active = tab.id === this.activeTab;
      if (active) {
        if (tabsFocused) {
          drawSelectionHighlight(image, x - 6, 5, w + 12, font.lineHeight + 6, true, 4);
        } else {
          image.fillRect(x, 8 + font.lineHeight + 1, w, 1, 150);
        }
      }
      image.drawText(font, x, 8, label, active ? 235 : 120);
      x += w + TAB_GAP;
    }
  }

  private tabLabel(tab: StoreTab): string {
    const label = TABS.find((entry) => entry.id === tab)!.label;
    if (tab !== "updates") return label;
    const updates = this.tabs.updates;
    const count = updates.rows.filter((row) => row.kind !== "search-query").length;
    return updates.loaded && count > 0 ? `${label} (${count})` : label;
  }

  private subtitle(tab: StoreTab, state: TabState): string {
    const count = state.rows.length;
    switch (tab) {
      case "top":
        return state.total ? `${count} of ${state.total} public apps` : count ? `${count} public apps` : "Public apps by popularity";
      case "new":
        return count ? `${count} newest apps` : "Recently published apps";
      case "search": {
        const results = count - 1;
        if (!state.query) return "Search public apps";
        return results === 1 ? `1 result for "${state.query}"` : `${results} results for "${state.query}"`;
      }
      case "updates":
        if (!state.loaded) return "Installed apps with newer versions";
        return count === 0 ? "All installed apps are up to date" : count === 1 ? "1 app needs attention" : `${count} apps need attention`;
    }
  }

  private emptyMessage(tab: StoreTab, state: TabState): string {
    if (state.status) return state.status;
    switch (tab) {
      case "updates":
        return getInstalledEvenHubApps().length === 0
          ? "No apps are installed from EvenHub."
          : "Every installed app is at its latest version.";
      default:
        return "No apps returned.";
    }
  }

  private rowText(row: StoreRow): { title: string; detail: string; titleValue: number } {
    switch (row.kind) {
      case "search-query": {
        const query = evenHubSearchQuerySetting.get();
        return {
          title: query ? `Search: ${query}` : "Search: (enter a query)",
          detail: "Click to type on the phone, or use voice input.",
          titleValue: 200,
        };
      }
      case "orphan":
        return {
          title: row.update.installed.name,
          detail: row.update.error
            ? `Package missing · store lookup failed: ${row.update.error}`
            : "Package missing · not in the store · click to forget",
          titleValue: 170,
        };
      case "app": {
        const { app, update } = row;
        if (!update) {
          return {
            title: app.name,
            detail: app.tagline || `${app.creatorName} · ${formatCount(app.installCount)} installs`,
            titleValue: 215,
          };
        }
        const detail = update.packageMissing
          ? `Package missing · reinstall ${app.version ? `version ${app.version}` : ""}`.trim()
          : `Version ${update.installed.version} installed · ${app.version} available`;
        return { title: app.name, detail, titleValue: 215 };
      }
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.showingLogin) {
      if (event.type === "click" && !this.loginBusy) {
        this.openCredentialEditor(ctx);
      } else if (event.type === "double-click") {
        shell.yieldFocusToSidebar();
      }
      return;
    }
    if (this.focus === "tabs") {
      await this.handleTabInput(event, ctx);
      return;
    }
    const tab = this.tabs[this.activeTab];
    switch (event.type) {
      case "scroll-up":
        tab.selectedIndex = Math.max(0, tab.selectedIndex - 1);
        return;
      case "scroll-down":
        tab.selectedIndex = Math.min(Math.max(0, tab.rows.length - 1), tab.selectedIndex + 1);
        if (tab.selectedIndex >= tab.rows.length - 4) void this.loadNextPage(ctx, this.activeTab);
        return;
      case "click":
        await this.activateRow(ctx, tab.rows[tab.selectedIndex]);
        return;
      case "double-click":
        this.focus = "tabs";
        return;
      default:
        return;
    }
  }

  private async handleTabInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const index = TABS.findIndex((tab) => tab.id === this.activeTab);
    switch (event.type) {
      case "scroll-up":
        this.switchTab(ctx, TABS[Math.max(0, index - 1)]!.id);
        return;
      case "scroll-down":
        this.switchTab(ctx, TABS[Math.min(TABS.length - 1, index + 1)]!.id);
        return;
      case "click":
        this.focus = "list";
        if (this.activeTab === "search" && !evenHubSearchQuerySetting.get()) {
          this.openSearchEditor(ctx);
        }
        return;
      case "double-click":
        shell.yieldFocusToSidebar();
        return;
      default:
        return;
    }
  }

  private switchTab(ctx: LayerContext, tab: StoreTab): void {
    if (tab === this.activeTab) return;
    if (this.activeTab === "search") this.closePhoneEditor(ctx.actions, "search");
    this.activeTab = tab;
    void this.ensureTabLoaded(ctx, tab);
  }

  private async activateRow(ctx: LayerContext, row: StoreRow | undefined): Promise<void> {
    if (!row) return;
    switch (row.kind) {
      case "search-query":
        this.openSearchEditor(ctx);
        return;
      case "orphan": {
        // Nothing can be reinstalled; the only useful action is to drop the
        // dead registry entry so the launcher stops offering it.
        const { packageId, name } = row.update.installed;
        if (uninstallEvenHubPackage(packageId)) {
          this.options.appendLog(`evenhub store: forgot missing package ${packageId}`);
          this.removeUpdateRow(packageId);
          this.tabs.updates.status = `Forgot ${name}.`;
        }
        return;
      }
      case "app":
        if (this.updatingAll) return;
        ctx.stack.push(
          new EvenHubStoreDetailLayer(row.app, {
            launchApp: this.options.launchApp,
            appendLog: this.options.appendLog,
            onInstalled: (installed) => this.onInstalled(installed),
          }),
        );
        return;
    }
  }

  /**
   * Jump to an installed app's store page (the launcher's route for a package
   * whose file is missing). Any page already open above the list is replaced.
   * Store metadata is filled in by the detail page itself; until then a
   * placeholder built from the registry entry stands in.
   */
  showInstalledPackage(stack: LayerStack, installed: InstalledEvenHubApp): void {
    if (this.showingLogin) {
      this.pendingPackage = installed;
      return;
    }
    this.pendingPackage = null;
    stack.clearToBase();
    stack.push(
      new EvenHubStoreDetailLayer(placeholderStoreApp(installed), {
        launchApp: this.options.launchApp,
        appendLog: this.options.appendLog,
        onInstalled: (result) => this.onInstalled(result),
      }),
    );
  }

  /** Dictated text becomes a search (the shell's "Type Into App" / voice input). */
  receiveTextInput(text: string, ctx: LayerContext): void {
    if (this.showingLogin) return;
    const query = evenHubSearchQuerySetting.set(text);
    if (!query) return;
    this.closePhoneEditor(ctx.actions, "search");
    this.activeTab = "search";
    this.focus = "list";
    void this.runSearch(ctx, query);
  }

  buildMenuItems(): MenuItem[] {
    if (this.showingLogin) return [];
    const items: MenuItem[] = [];
    if (this.activeTab === "search") {
      items.push({
        label: "Search...",
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.focus = "list";
          this.openSearchEditor(ctx);
        },
      });
    }
    if (this.activeTab === "updates" && this.updatableRows().length > 0) {
      items.push({
        label: this.updatingAll ? "Updating..." : "Update All",
        disabled: () => this.updatingAll,
        onSelect: (ctx) => {
          ctx.stack.pop();
          void this.updateAll(ctx);
        },
      });
    }
    items.push({
      label: this.activeTab === "updates" ? "Check Again" : "Refresh",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void this.reload(ctx, this.activeTab);
      },
    });
    items.push({
      label: "Log Out",
      onSelect: (ctx) => {
        ctx.stack.pop();
        clearEvenHubSession();
        this.enterLogin(ctx, "Signed out.");
      },
    });
    return items;
  }

  onWindowClosed(actions: Pick<LayerActions, "endTextSettingEdit">): void {
    this.closed = true;
    this.closePhoneEditor(actions);
    clearTransientEvenHubSession();
  }

  // ---- loading -----------------------------------------------------------

  private ensureTabLoaded(ctx: LayerContext, tab: StoreTab): Promise<void> {
    const state = this.tabs[tab];
    if (state.loaded || state.loading) return Promise.resolve();
    return this.reload(ctx, tab);
  }

  private async reload(ctx: LayerContext, tab: StoreTab): Promise<void> {
    if (!isEvenHubStoreConfigured()) {
      this.enterLogin(ctx);
      return;
    }
    if (this.tabs[tab].loading) return;
    switch (tab) {
      case "top":
      case "new":
        this.tabs[tab] = emptyTab();
        await this.loadNextPage(ctx, tab);
        return;
      case "search":
        await this.runSearch(ctx, evenHubSearchQuerySetting.get());
        return;
      case "updates":
        await this.checkUpdates(ctx);
        return;
    }
  }

  private async loadNextPage(ctx: LayerContext, tab: StoreTab): Promise<void> {
    const state = this.tabs[tab];
    if (state.loading || state.exhausted) return;
    if (tab === "search" && !state.query) return;
    if (tab === "updates") return;
    state.loading = true;
    state.status = state.rows.length ? "Loading more apps..." : "Loading apps...";
    ctx.actions.requestRender();
    try {
      const page = await this.fetchPage(tab, state.nextPage, state.query);
      const seen = new Set(state.rows.map((row) => (row.kind === "app" ? row.app.packageId : "")));
      const fresh = page.apps.filter((app) => !seen.has(app.packageId));
      state.rows.push(...fresh.map((app): StoreRow => ({ kind: "app", app })));
      state.total = page.total;
      state.nextPage = page.page + 1;
      // A page that adds nothing (or a short page with no known total) means
      // the endpoint has no more to give — or ignores paging altogether.
      state.exhausted = (state.total > 0 && state.rows.length >= state.total)
        || fresh.length === 0
        || (state.total === 0 && page.apps.length < page.pageSize);
      state.status = "";
      if (tab === "top" && state.nextPage === 2 && !this.tabs.updates.loaded && !this.tabs.updates.loading) {
        // Quietly find out whether the Updates tab deserves a count.
        void this.checkUpdates(ctx, true);
      }
    } catch (error) {
      if (this.handleAuthError(ctx, error)) return;
      state.status = cleanError(error);
      this.options.appendLog(`evenhub store: ${state.status}`);
    } finally {
      state.loaded = true;
      state.loading = false;
      if (!this.closed) ctx.actions.requestRender();
    }
  }

  private fetchPage(tab: StoreTab, page: number, query: string): Promise<EvenHubStorePage> {
    switch (tab) {
      case "new":
        return evenHubApi.listNewApps(page);
      case "search":
        return evenHubApi.searchApps(query, page);
      default:
        return evenHubApi.listApps(page);
    }
  }

  private async runSearch(ctx: LayerContext, query: string): Promise<void> {
    const state = emptyTab();
    state.query = query;
    state.rows = [{ kind: "search-query" }];
    state.loaded = !query;
    // Keep the cursor on the first result once there are some.
    state.selectedIndex = query ? 1 : 0;
    this.tabs.search = state;
    ctx.actions.requestRender();
    if (query) await this.loadNextPage(ctx, "search");
  }

  private async checkUpdates(ctx: LayerContext, quiet = false): Promise<void> {
    const state = this.tabs.updates;
    if (state.loading) return;
    state.loading = true;
    state.status = "";
    const installedCount = getInstalledEvenHubApps().length;
    if (!quiet) {
      state.status = installedCount ? `Checking ${installedCount} installed apps...` : "";
      ctx.actions.requestRender();
    }
    try {
      const updates = await checkForEvenHubUpdates((done, total) => {
        if (quiet) return;
        state.status = `Checking installed apps (${done}/${total})...`;
        ctx.actions.requestRender();
      });
      const rows: StoreRow[] = updates.map((update) =>
        update.latest ? { kind: "app", app: update.latest, update } : { kind: "orphan", update },
      );
      state.rows = rows;
      state.selectedIndex = 0;
      state.scrollRow = 0;
      state.status = "";
      state.exhausted = true;
    } catch (error) {
      if (this.handleAuthError(ctx, error)) return;
      state.status = cleanError(error);
      this.options.appendLog(`evenhub store: update check failed: ${state.status}`);
    } finally {
      state.loaded = true;
      state.loading = false;
      if (!this.closed) ctx.actions.requestRender();
    }
  }

  private updatableRows(): Extract<StoreRow, { kind: "app" }>[] {
    return this.tabs.updates.rows.filter(
      (row): row is Extract<StoreRow, { kind: "app" }> => row.kind === "app" && row.update !== undefined,
    );
  }

  /** Install every pending update in turn; a declined permission dialog skips that app. */
  private async updateAll(ctx: LayerContext): Promise<void> {
    if (this.updatingAll) return;
    this.updatingAll = true;
    const state = this.tabs.updates;
    const pending = this.updatableRows();
    let installed = 0;
    const failures: string[] = [];
    try {
      for (const [index, row] of pending.entries()) {
        if (this.closed) return;
        const prefix = `${index + 1}/${pending.length} ${row.app.name}: `;
        try {
          const result = await installStoreApp(ctx, row.app, {
            appendLog: this.options.appendLog,
            onStatus: (status) => {
              state.status = prefix + (status || "Confirm permissions on the glasses...");
              ctx.actions.requestRender();
            },
          });
          if (result) {
            installed++;
            this.onInstalled(result);
          } else {
            failures.push(`${row.app.name} (declined)`);
          }
        } catch (error) {
          const message = cleanError(error);
          this.options.appendLog(`evenhub store: update of ${row.app.packageId} failed: ${message}`);
          failures.push(row.app.name);
        }
      }
      state.status = failures.length
        ? `Updated ${installed}; skipped ${failures.join(", ")}`
        : installed === 1 ? "Updated 1 app." : `Updated ${installed} apps.`;
    } finally {
      this.updatingAll = false;
      if (!this.closed) ctx.actions.requestRender();
    }
  }

  /** After any install, drop the Updates row it satisfied (from the detail page or Update All). */
  private onInstalled(installed: InstalledEvenHubApp): void {
    const row = this.tabs.updates.rows.find(
      (entry) => entry.kind === "app" && entry.app.packageId === installed.packageId,
    );
    if (row?.kind !== "app" || !row.update) return;
    const standing = describeUpdate(installed, row.app);
    if (!standing.updateAvailable && !standing.packageMissing) this.removeUpdateRow(installed.packageId);
  }

  private removeUpdateRow(packageId: string): void {
    const state = this.tabs.updates;
    state.rows = state.rows.filter((row) =>
      row.kind === "search-query" ? true : row.kind === "app" ? row.app.packageId !== packageId : row.update.installed.packageId !== packageId,
    );
    state.selectedIndex = clamp(state.selectedIndex, 0, Math.max(0, state.rows.length - 1));
  }

  // ---- login and phone editors --------------------------------------------

  /** Route a rejected session back to the login form; true if it was one. */
  private handleAuthError(ctx: LayerContext, error: unknown): boolean {
    if (!(error instanceof EvenHubAuthenticationError)) return false;
    const message = cleanError(error);
    this.options.appendLog(`evenhub store login failed: ${message}`);
    this.enterLogin(ctx, `Login failed: ${message}`);
    return true;
  }

  private enterLogin(ctx: LayerContext, status = "Sign in to browse public apps."): void {
    const wasShowingLogin = this.showingLogin;
    this.closePhoneEditor(ctx.actions, "search");
    this.showingLogin = true;
    this.loginBusy = false;
    this.loginStatus = status;
    for (const tab of TABS) this.tabs[tab.id] = emptyTab();
    this.focus = "list";
    if (!wasShowingLogin) resetEvenHubLoginForm();
    this.openCredentialEditor(ctx);
    ctx.actions.requestRender();
  }

  private openCredentialEditor(ctx: LayerContext): void {
    if (this.phoneEditor !== "none") return;
    this.phoneEditor = "credentials";
    void ctx.actions.startTextSettingsEdit(
      [evenHubLoginEmailSetting, evenHubLoginPasswordSetting],
      "Sign in to EvenHub",
      () => {
        this.phoneEditor = "none";
        void this.submitCredentials(ctx);
      },
      { setting: evenHubRememberMeSetting, label: "Remember me" },
    );
  }

  private openSearchEditor(ctx: LayerContext): void {
    if (this.phoneEditor !== "none") return;
    this.phoneEditor = "search";
    void ctx.actions.startTextSettingsEdit([evenHubSearchQuerySetting], "Search EvenHub", () => {
      this.phoneEditor = "none";
      if (this.closed) return;
      void this.runSearch(ctx, evenHubSearchQuerySetting.get());
    });
  }

  /** Close the phone editor if one is open (optionally only a given kind). */
  private closePhoneEditor(actions: Pick<LayerActions, "endTextSettingEdit">, kind?: "credentials" | "search"): void {
    if (this.phoneEditor === "none" || (kind && this.phoneEditor !== kind)) return;
    this.phoneEditor = "none";
    void actions.endTextSettingEdit();
  }

  private async submitCredentials(ctx: LayerContext): Promise<void> {
    const email = evenHubLoginEmailSetting.get();
    const password = evenHubLoginPasswordSetting.get();
    if (!email.trim() || !password) {
      this.enterLogin(ctx, "Email and password are required.");
      return;
    }
    this.loginBusy = true;
    this.loginStatus = "Signing in...";
    ctx.actions.requestRender();
    try {
      await evenHubApi.signIn(email, password, evenHubRememberMeSetting.get());
      if (this.closed) {
        clearTransientEvenHubSession();
        return;
      }
      this.showingLogin = false;
      clearEvenHubLoginForm();
      this.loginBusy = false;
      const pending = this.pendingPackage;
      if (pending) this.showInstalledPackage(ctx.stack, pending);
      await this.reload(ctx, this.activeTab);
    } catch (error) {
      if (this.closed) return;
      const message = cleanError(error);
      this.options.appendLog(`evenhub store login failed: ${message}`);
      this.loginStatus = `Login failed: ${message}`;
      evenHubLoginPasswordSetting.set("");
      this.openCredentialEditor(ctx);
    } finally {
      evenHubLoginPasswordSetting.set("");
      this.loginBusy = false;
      if (!this.closed) ctx.actions.requestRender();
    }
  }
}

/** A registry entry dressed as a store record, for pages opened before the store record arrives. */
function placeholderStoreApp(installed: InstalledEvenHubApp): EvenHubStoreApp {
  return {
    id: 0,
    packageId: installed.packageId,
    name: installed.name,
    creatorName: "",
    tagline: "",
    description: "",
    categories: [],
    installCount: 0,
    likeCount: 0,
    firstPublishedAt: "",
    iconPath: "",
    version: "",
    changelog: "",
    fileSize: 0,
  };
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
