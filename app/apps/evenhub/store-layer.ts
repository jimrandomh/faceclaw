import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerActions, type LayerContext, type LayerStack } from "../../ui/layers";
import { drawSelectionHighlight, type MenuItem } from "../../ui/menu";
import { Menu } from "../../ui/menu-core";
import { shell } from "../../ui/shell/shell";
import { ConfigSettingString } from "../../ui/dashboard-settings";
import { evenHubApi, EvenHubAuthenticationError, isEvenHubStoreConfigured, type EvenHubStoreApp, type EvenHubStorePage } from "./even-api";
import { clearEvenHubLoginForm, clearEvenHubSession, clearTransientEvenHubSession, evenHubLoginEmailSetting, evenHubLoginPasswordSetting, evenHubRememberMeSetting, resetEvenHubLoginForm } from "./credentials";
import { getInstalledEvenHubApps, uninstallEvenHubPackage, type InstalledEvenHubApp } from "./installed-apps";
import { EvenHubStoreDetailLayer, type EvenHubStoreDetailOptions } from "./store-detail-layer";
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

/** Row pitch of the two-line app list (title + detail), including the 2px gap between highlights. */
function storeRowHeight(font: UiFont): number {
  return Math.max(30, 2 * lineStep(font) + 4);
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
  /** Selection and scroll over `rows` (resynced before each paint and input). */
  menu: Menu<StoreRow>;
  /** Search only: the query the rows belong to. */
  query: string;
};

function emptyTab(): TabState {
  const rows: StoreRow[] = [];
  return {
    rows,
    total: 0,
    nextPage: 1,
    exhausted: false,
    loaded: false,
    loading: false,
    status: "",
    menu: new Menu<StoreRow>({
      items: rows,
      rowGap: 2,
      highlight: { radius: 5 },
      getHeight: () => storeRowHeight(getDefaultSmallFont()),
      draw: ({ image, item, x, y, width }) => {
        const font = getDefaultSmallFont();
        const { title, detail, titleValue } = rowText(item);
        const textX = x + 6;
        const textW = width - 12;
        image.drawText(font, textX, y + 2, truncateText(font, title, textW), titleValue);
        image.drawText(font, textX, y + 2 + lineStep(font), truncateText(font, detail, textW), 115);
      },
    }),
    query: "",
  };
}

/** The tab's menu, with its items brought up to date with `rows` (which loads replace or extend). */
function tabMenu(tab: TabState): Menu<StoreRow> {
  if (tab.menu.items !== tab.rows) tab.menu.setItems(tab.rows);
  return tab.menu;
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
      // Do NOT open the phone credential editor here. This runs on the first
      // paint, which includes the restore of a still-open EvenHub at app
      // startup -- so an unfinished sign-in re-opened the form on every
      // launch, unasked. The login pane already says "Enter your Even account
      // email and password in the phone app" and already opens the editor on
      // click (handleInput), so the editor is still one tap away for someone
      // who actually wants it.
      if (!this.showingLogin) {
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

    const rowH = storeRowHeight(font);
    const visibleRows = Math.max(1, Math.floor((height - headerH - 4) / rowH));
    const listFocused = ctx.stack.isFocused() && this.focus === "list";
    const menu = tabMenu(tab);
    menu.paint(
      image,
      { x: LIST_X - 6, y: headerH, width: width - LIST_X * 2 + 12, height: visibleRows * rowH - 2 },
      listFocused,
    );
    menu.drawScrollbar(image, width - 5, headerH, visibleRows * rowH - 3);
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
    const menu = tabMenu(tab);
    switch (event.type) {
      case "scroll-up":
        await menu.handleInput(event);
        return;
      case "scroll-down":
        await menu.handleInput(event);
        if ((menu.selectedIndex ?? 0) >= tab.rows.length - 4) void this.loadNextPage(ctx, this.activeTab);
        return;
      case "click":
        await this.activateRow(ctx, menu.selectedItem ?? undefined);
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
        ctx.stack.push(new EvenHubStoreDetailLayer(row.app, this.detailOptions()));
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
    stack.push(new EvenHubStoreDetailLayer(placeholderStoreApp(installed), this.detailOptions()));
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
    state.menu.setItems(state.rows, query ? 1 : 0);
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
      state.menu.setItems(rows, 0);
      state.menu.scrollTop = 0;
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
          // An expired session fails every remaining update the same way.
          if (this.handleAuthError(ctx, error)) return;
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
    state.menu.setItems(state.rows);
  }

  // ---- login and phone editors --------------------------------------------

  /**
   * Drop back to the logged-out pane when Even rejects the session (an
   * expired login); true if the error was one. Anything open above the list
   * (an app page, a permission dialog) needed the session too, so it goes.
   * The phone form is not opened: this can happen on the first load of a
   * store window restored at startup (see paint), and the pane's click
   * opens it.
   */
  private handleAuthError(ctx: LayerContext, error: unknown): boolean {
    if (!(error instanceof EvenHubAuthenticationError)) return false;
    const message = cleanError(error);
    this.options.appendLog(`evenhub store: session rejected: ${message}`);
    if (this.closed) return true;
    ctx.stack.clearToBase();
    this.enterLogin(ctx, `Signed out: ${message}`, false);
    return true;
  }

  private detailOptions(): EvenHubStoreDetailOptions {
    return {
      launchApp: this.options.launchApp,
      appendLog: this.options.appendLog,
      onInstalled: (installed) => this.onInstalled(installed),
      onAuthError: (ctx, error) => this.handleAuthError(ctx, error),
    };
  }

  private enterLogin(
    ctx: LayerContext,
    status = "Sign in to browse public apps.",
    openEditor = true,
  ): void {
    const wasShowingLogin = this.showingLogin;
    this.closePhoneEditor(ctx.actions, "search");
    this.showingLogin = true;
    this.loginBusy = false;
    this.loginStatus = status;
    for (const tab of TABS) this.tabs[tab.id] = emptyTab();
    this.focus = "list";
    if (!wasShowingLogin) resetEvenHubLoginForm();
    if (openEditor) this.openCredentialEditor(ctx);
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
      () => { this.phoneEditor = "none"; clearEvenHubLoginForm(); },
    );
  }

  private openSearchEditor(ctx: LayerContext): void {
    if (this.phoneEditor !== "none") return;
    this.phoneEditor = "search";
    void ctx.actions.startTextSettingsEdit([evenHubSearchQuerySetting], "Search EvenHub", () => {
      this.phoneEditor = "none";
      if (this.closed) return;
      void this.runSearch(ctx, evenHubSearchQuerySetting.get());
    }, undefined, () => { this.phoneEditor = "none"; });
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
      // A wholly empty submission (the keyboard's Done key on an untouched
      // form) is treated as a cancel and leaves the editor closed -- the login
      // pane still says how to get back in, and a click reopens the editor.
      // A half-filled form is a real mistake, so that still reopens with the
      // message.
      const cancelled = !email.trim() && !password;
      this.enterLogin(
        ctx,
        cancelled ? "Sign in to browse public apps." : "Email and password are required.",
        !cancelled,
      );
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

/** A list row's title (with its shade) and dim detail line. */
function rowText(row: StoreRow): { title: string; detail: string; titleValue: number } {
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
