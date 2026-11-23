import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { DrawOp, type AnimatedListClip, type ListCall, type PlacedDisplayList } from "../../graphics/display-list";
import { encodeReplayDraws } from "../../graphics/glyph-wire";
import { GrayImage, grayToNibble } from "../../graphics/image";
import { type Plane } from "../../graphics/plane";
import { renderIcon, type IconName } from "../../graphics/icons";
import { InputEvent } from "../../ui/gestures";
import { IconGrid, ICON_GRID_ICON_SIZE, iconGridRowHeight } from "../../ui/icon-grid";
import { Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../../ui/layers";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { menuAnimationDurationMs, nextAnimationToken } from "../../ui/menu-animation-pref";
import { type MenuBox } from "../../ui/menu-core";
import { WINDOW_MENU_LAYOUT } from "../../ui/window-menu";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { createInProcessWindow } from "../../ui/shell/in-process-window";
import {
  getFolderAssignments,
  getFolders,
  getFolderStateFingerprint,
  setAppFolder,
  unusedNewFolderName,
} from "./launcher-folders";
import { shell, type ShellWindow } from "../../ui/shell/shell";
import { folderTransitionList, type FolderTransition } from "./folder-transition";

export type LauncherAppEntry = {
  appId: string;
  label: string;
  icon: IconName;
  uninstallable?: boolean;
  /** Dynamic artwork for installed apps; icon remains the fallback. */
  renderIcon?: (size: number) => GrayImage | null;
  iconKey?: string;
};

export type LauncherOptions = {
  actions: LayerActions;
  apps: () => LauncherAppEntry[];
  launchApp: (appId: string) => Promise<void> | void;
  uninstallApp: (appId: string) => Promise<void> | void;
  /** Submit a painted viewport-sized frame (as planes) to this window's surface. */
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  /** Flip the launcher's compositor surface visibility on foreground changes. */
  setSurfaceVisible: (visible: boolean) => void;
};

export const LAUNCHER_WINDOW_ID = "launcher";
export const LAUNCHER_SURFACE_ID = "window:launcher";

/**
 * An open folder's panel: how far in from the grid's sides, and from the
 * window's top and bottom. The sides' is less than the blank margin beside
 * the grid's first and last columns, so no part of a cell shows beside it.
 */
const FOLDER_PANEL_INSET_X = 12;
const FOLDER_PANEL_INSET_Y = 14;
/** The panel's one-pixel outline. */
const FOLDER_BORDER = 1;
const FOLDER_BORDER_VALUE = 72;
/** The folder's name, from the panel's corner, and the gap between it and the folder's grid. */
const FOLDER_NAME_X = 12;
const FOLDER_NAME_Y = 8;
const FOLDER_NAME_GAP = 6;
const FOLDER_NAME_VALUE = 220;
/** The folder's grid: its gap from the panel's sides, and its last row's from the panel's bottom. */
const FOLDER_GRID_PAD_X = 6;
const FOLDER_GRID_PAD_BOTTOM = 6;
/** A folder opening or closing, at Normal menu animation speed. */
const FOLDER_TRANSITION_MS = 200;

type Rect = { x: number; y: number; width: number; height: number };

/** One cell of the top grid: an app, or a folder holding some of the apps. */
type LauncherGridEntry =
  | { kind: "app"; label: string; icon: IconName; appId: string; renderIcon?: (size: number) => GrayImage | null }
  | { kind: "folder"; label: string; name: string };

type LauncherAppCell = Extract<LauncherGridEntry, { kind: "app" }>;

function appCell(app: LauncherAppEntry): LauncherAppCell {
  return { kind: "app", label: app.label, icon: app.icon, appId: app.appId, renderIcon: app.renderIcon };
}

function describeEntry(entry: LauncherGridEntry) {
  return {
    label: entry.label,
    icon: entry.kind === "app"
      ? entry.renderIcon?.(ICON_GRID_ICON_SIZE) ?? renderIcon(entry.icon, ICON_GRID_ICON_SIZE)
      : renderIcon("folder-filled", ICON_GRID_ICON_SIZE),
  };
}

/** A fresh transition, or null while menu animation is disabled. */
function startFolderTransition(kind: FolderTransition["kind"]): FolderTransition | null {
  const durationMs = menuAnimationDurationMs(FOLDER_TRANSITION_MS);
  return durationMs > 0 ? { kind, startedAt: Date.now(), token: nextAnimationToken(), durationMs } : null;
}

function transitionRunning(transition: FolderTransition | null): transition is FolderTransition {
  return !!transition && Date.now() - transition.startedAt < transition.durationMs;
}

/**
 * The launcher grid: app and folder icons with labels, in an IconGrid (which
 * owns layout, selection and the ring/watch navigation schemes). Opening a
 * folder puts a LauncherFolderLayer over it; backing out of the top grid
 * yields to the sidebar.
 *
 * The folder grouping lives in the settings store (see launcher-folders.ts)
 * and is re-read every paint, so assistant folder tools take effect without
 * the layer holding any copy of the state.
 */
class LauncherGridLayer implements Layer {
  // Watch swipes are spatial: up/down move between rows, left/right between
  // columns. From the leftmost column, left keeps going out to the sidebar:
  // "left" points toward the sidebar all the way out.
  readonly acceptsDirectional = true;
  /** The folder open over the grid, if any. */
  private folder: LauncherFolderLayer | null = null;
  /** A folder that has just closed, shrinking back into its cell. */
  private closing: { folder: LauncherFolderLayer; transition: FolderTransition } | null = null;
  /** The grid's box in the last paint. */
  private box: MenuBox | null = null;
  private readonly grid = new IconGrid<LauncherGridEntry>({
    items: () => this.entries(),
    describe: describeEntry,
    onActivate: (entry, index, ctx) => this.openEntry(entry, index, ctx),
    onBack: () => {
      shell.yieldFocusToSidebar();
      return true;
    },
  });

  constructor(readonly options: LauncherOptions) {}

  onFocus(lastInput: InputEvent | null): void {
    this.grid.onFocus(lastInput);
    this.folder?.onFocus(lastInput);
  }

  /** The top grid's cells, computed fresh from the folder state. */
  private entries(): LauncherGridEntry[] {
    const apps = this.options.apps();
    const byAppId = new Map(apps.map((app) => [app.appId, app]));
    const assignments = getFolderAssignments();
    const entries: LauncherGridEntry[] = [];
    // A folder cell appears only when it holds at least one known app; stale
    // assignments to removed apps are ignored.
    for (const [name, members] of getFolders()) {
      if (members.some((appId) => byAppId.has(appId))) {
        entries.push({ kind: "folder", label: name, name });
      }
    }
    for (const app of apps) {
      if (!assignments[app.appId]) entries.push(appCell(app));
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** A folder's apps, in label order. */
  folderApps(name: string): LauncherAppCell[] {
    const byAppId = new Map(this.options.apps().map((app) => [app.appId, app]));
    return (getFolders().get(name) ?? [])
      .map((appId) => byAppId.get(appId))
      .filter((app): app is LauncherAppEntry => !!app)
      .map(appCell)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Where a folder's cell shows its icon in the top grid, for the panel to open out of. */
  private folderIconCenter(name: string): { x: number; y: number } | null {
    const index = this.entries().findIndex((entry) => entry.kind === "folder" && entry.name === name);
    return index < 0 ? null : this.grid.iconCenter(index);
  }

  /** Open a folder or launch an app; true when that left the grid (a launch). */
  private async openEntry(entry: LauncherGridEntry, index: number, ctx: LayerContext): Promise<boolean> {
    if (entry.kind === "folder") {
      this.closing = null;
      this.folder = new LauncherFolderLayer(this, entry.name, this.grid.iconCenter(index));
      ctx.stack.push(this.folder);
      return false;
    }
    await this.launch(entry.appId);
    return true;
  }

  async launch(appId: string): Promise<void> {
    this.grid.enterRowMode();
    await this.options.launchApp(appId);
  }

  /**
   * Take the open folder off the stack, wherever it sits in it. `animate`
   * plays its panel shrinking back into its cell (backing out of it); without
   * that it is simply gone (an app launched from it, or it has no apps left).
   */
  closeFolder(stack: LayerStack, animate: boolean): void {
    const folder = this.folder;
    if (!folder) return;
    const transition = animate ? startFolderTransition("close") : null;
    this.closing = transition ? { folder, transition } : null;
    stack.remove(folder);
  }

  /** The folder layer left the stack, by whatever path. */
  folderRemoved(folder: LauncherFolderLayer): void {
    if (this.folder === folder) this.folder = null;
  }

  /** Close the open folder once it has no apps left (the assistant, or the context menu, emptied it). */
  closeEmptyFolder(stack: LayerStack): void {
    if (this.folder && this.folderApps(this.folder.name).length === 0) this.closeFolder(stack, false);
  }

  /**
   * What draws the part of the top grid that `rect` (image coordinates)
   * covers, as it shows under an open folder, with (0, 0) at the rect's
   * corner. Null when the grid can't be replayed.
   */
  replayUnder(rect: Rect): ListCall[] | null {
    const box = this.box;
    if (!box) return null;
    return this.grid.replayCalls({ x: box.x - rect.x, y: box.y - rect.y }, { x: 0, y: 0, width: rect.width, height: rect.height }, false);
  }

  /**
   * App-specific entries for the window's context menu. Only item mode
   * pins the selection to a single cell, and only apps can move to folders,
   * so anywhere else the menu falls back to just the defaults.
   */
  menuItems(): MenuItem[] {
    const entry = this.folder ? this.folder.selectedApp : this.grid.selectedItem;
    if (!entry || entry.kind !== "app") return [];
    return [
      {
        label: "Move to folder",
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(
            new MenuLayer("Move to folder", this.moveToFolderItems(entry.appId), WINDOW_MENU_LAYOUT),
          );
        },
      },
      ...(this.options.apps().find((app) => app.appId === entry.appId)?.uninstallable
        ? [{
            label: "Uninstall",
            onSelect: (ctx: LayerContext) => {
              ctx.stack.pop();
              ctx.stack.push(
                new MenuLayer(
                  "Uninstall app?",
                  [
                    {
                      label: "Confirm uninstall",
                      onSelect: async (confirmCtx) => {
                        confirmCtx.stack.pop();
                        setAppFolder(entry.appId, null);
                        await this.options.uninstallApp(entry.appId);
                        this.grid.enterRowMode();
                      },
                    },
                    { label: "Cancel", onSelect: (confirmCtx) => confirmCtx.stack.pop() },
                  ],
                  WINDOW_MENU_LAYOUT,
                ),
              );
            },
          } satisfies MenuItem]
        : []),
    ];
  }

  /**
   * The folder-picker submenu: every existing folder except the app's own,
   * plus a generated-name "New folder" (ring input has no text entry) and,
   * when the app is in a folder, an escape back to the top level.
   */
  private moveToFolderItems(appId: string): MenuItem[] {
    const currentFolder = getFolderAssignments()[appId] ?? null;
    const items: MenuItem[] = [];
    for (const name of getFolders().keys()) {
      if (name === currentFolder) continue;
      items.push({
        label: name,
        onSelect: (ctx) => {
          setAppFolder(appId, name);
          ctx.stack.pop();
        },
      });
    }
    items.push({
      label: "New folder",
      onSelect: (ctx) => {
        setAppFolder(appId, unusedNewFolderName());
        ctx.stack.pop();
      },
    });
    if (currentFolder !== null) {
      items.push({
        label: "Remove from folder",
        onSelect: (ctx) => {
          setAppFolder(appId, null);
          ctx.stack.pop();
        },
      });
    }
    return items;
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    // The grid scrolls, so it runs to the window's top and bottom edges, the
    // padding suggested for them inside it: its end rows keep clear of a
    // border there, and a row cut off for scrolling meets the border rather
    // than a blank strip.
    const box: MenuBox = { x: padding.left, y: 0, width: width - padding.left - padding.right, height,
      padTop: padding.top, padBottom: padding.bottom };
    this.box = box;
    // Under an open folder the grid is at rest and out of focus: its
    // selection is outlined, marking the folder the panel belongs to.
    this.grid.paint(image, box, ctx.stack.isFocused() && !this.folder, { animate: !this.folder });
    const closing = this.closing;
    if (closing && !this.folder && transitionRunning(closing.transition)) {
      const list = closing.folder.transitionList(closing.transition, this.folderIconCenter(closing.folder.name));
      if (list) image.drawDisplayList(list.displayList, list.x, list.y, list.width, list.height);
    } else {
      this.closing = null;
    }
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.grid.handleInput(event, ctx);
  }

  /** A touch on the phone's mirror opens the cell under it. */
  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    return await this.grid.hitTest(x, y, ctx);
  }
}

/**
 * An open folder: a panel smaller than the window, over the top grid, holding
 * the folder's name and a grid of its apps. It opens out of the folder's icon
 * and closes back into it (see folder-transition.ts); backing out of it, or a
 * touch outside it on the phone's mirror, closes it.
 */
class LauncherFolderLayer implements Layer {
  readonly acceptsDirectional = true;
  private readonly grid: IconGrid<LauncherAppCell>;
  private opening = startFolderTransition("open");
  /** The panel and its grid's box in the last paint. */
  private panel: Rect | null = null;
  private box: MenuBox | null = null;

  /** `iconCenter` is the folder's icon in the top grid, which the panel opens out of. */
  constructor(private readonly host: LauncherGridLayer, readonly name: string,
      private readonly iconCenter: { x: number; y: number } | null) {
    this.grid = new IconGrid<LauncherAppCell>({
      items: () => host.folderApps(name),
      describe: describeEntry,
      onActivate: async (entry, _index, ctx) => {
        // Close first, so the launcher never shows (even briefly) stale
        // folder contents when it is next on screen.
        host.closeFolder(ctx.stack, false);
        await host.launch(entry.appId);
        return true;
      },
      onBack: (ctx) => {
        host.closeFolder(ctx.stack, true);
        return true;
      },
    });
    // The watch's scheme never shows a row band; start on a single cell.
    if (shell.lastInputWasWatch()) this.grid.enterItemMode();
  }

  onFocus(lastInput: InputEvent | null): void {
    this.grid.onFocus(lastInput);
  }

  /** The app the selection is on, when it is on a single one. */
  get selectedApp(): LauncherAppCell | null {
    return this.grid.selectedItem;
  }

  onRemoved(): void {
    this.host.folderRemoved(this);
  }

  /**
   * The panel: as wide as the top grid less its inset, and as tall as the
   * folder's rows need, up to the window's height less its inset.
   */
  private layout(ctx: LayerContext): { panel: Rect; box: MenuBox } {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const panelX = padding.left + FOLDER_PANEL_INSET_X;
    const panelWidth = Math.max(1, width - padding.left - padding.right - 2 * FOLDER_PANEL_INSET_X);
    const gridTop = FOLDER_BORDER + FOLDER_NAME_Y + font.lineHeight + FOLDER_NAME_GAP;
    const boxWidth = Math.max(1, panelWidth - 2 * (FOLDER_BORDER + FOLDER_GRID_PAD_X));
    const rows = Math.max(1, Math.ceil(this.host.folderApps(this.name).length / this.grid.columns));
    const wanted = gridTop + rows * iconGridRowHeight(font) + FOLDER_GRID_PAD_BOTTOM + FOLDER_BORDER;
    const panelHeight = Math.max(1, Math.min(wanted, height - 2 * FOLDER_PANEL_INSET_Y));
    const panel = { x: panelX, y: Math.max(0, ((height - panelHeight) / 2) | 0), width: panelWidth, height: panelHeight };
    // The grid runs to the panel's bottom border, so a row cut off for
    // scrolling meets it; its last row keeps clear of it.
    const box: MenuBox = { x: panel.x + FOLDER_BORDER + FOLDER_GRID_PAD_X, y: panel.y + gridTop, width: boxWidth,
      height: Math.max(1, panel.height - gridTop - FOLDER_BORDER), padBottom: FOLDER_GRID_PAD_BOTTOM };
    return { panel, box };
  }

  /** The folder's name as drawn in the panel, relative to the panel's corner. */
  private drawName(image: GrayImage, x: number, y: number, panelWidth: number): void {
    const font = getDefaultSmallFont();
    image.drawText(font, x + FOLDER_NAME_X, y + FOLDER_BORDER + FOLDER_NAME_Y,
      truncateText(font, this.name, panelWidth - 2 * FOLDER_NAME_X), FOLDER_NAME_VALUE);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const { panel, box } = this.layout(ctx);
    this.panel = panel;
    this.box = box;
    // Fill 1, not 0: 0 is the plane's transparent color, and the panel
    // covers the top grid.
    image.fillRect(panel.x, panel.y, panel.width, panel.height, 1);
    image.drawRect(panel.x, panel.y, panel.width, panel.height, FOLDER_BORDER_VALUE);
    this.drawName(image, panel.x, panel.y, panel.width);
    this.grid.paint(image, box, ctx.stack.isFocused());
    if (transitionRunning(this.opening)) {
      const list = this.transitionList(this.opening, this.iconCenter);
      if (list) image.drawDisplayList(list.displayList, list.x, list.y, list.width, list.height);
      else this.opening = null;
    } else {
      this.opening = null;
    }
    return image;
  }

  /**
   * The panel opening out of `iconCenter` or closing into it, placed over the
   * panel as last painted. Null before a paint, without an icon to grow from,
   * and when something on the panel or under it can't be replayed.
   */
  transitionList(transition: FolderTransition, iconCenter: { x: number; y: number } | null): PlacedDisplayList | null {
    const panel = this.panel, box = this.box;
    if (!panel || !box || !iconCenter) return null;
    const name = new GrayImage(panel.width, FOLDER_BORDER + FOLDER_NAME_Y + getDefaultSmallFont().lineHeight);
    this.drawName(name, 0, 0, panel.width);
    const nameDraws = encodeReplayDraws(name.draws);
    if (!nameDraws) return null;
    const content = (clip: AnimatedListClip): ListCall[] | null => {
      const rows = this.grid.replayCalls({ x: box.x - panel.x, y: box.y - panel.y }, clip, true);
      if (!rows) return null;
      return [{ op: DrawOp.DRAWS, x: 0, y: 0, records: nameDraws.records, count: nameDraws.count, source: name, clip }, ...rows];
    };
    const displayList = folderTransitionList(transition, panel,
      { x: iconCenter.x - panel.x, y: iconCenter.y - panel.y }, grayToNibble(FOLDER_BORDER_VALUE),
      content, () => this.host.replayUnder(panel));
    return displayList && { displayList, x: panel.x, y: panel.y, width: panel.width, height: panel.height, depth: 0 };
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.grid.handleInput(event, ctx);
  }

  /** A touch on the phone's mirror: on the panel it opens the app under it, off the panel it closes the folder. */
  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    const panel = this.panel;
    if (panel && (x < panel.x || y < panel.y || x >= panel.x + panel.width || y >= panel.y + panel.height)) {
      this.host.closeFolder(ctx.stack, true);
      return true;
    }
    await this.grid.hitTest(x, y, ctx);
    return true;
  }
}

/**
 * The launcher: a pinned, uncloseable in-process window presenting the app
 * grid. Selecting an app asks the controller to launch it and foregrounds the
 * new window.
 */
export function createLauncherWindow(options: LauncherOptions): ShellWindow {
  const gridLayer = new LauncherGridLayer(options);
  const created = createInProcessWindow({
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    iconLetter: "A",
    icon: "layout-grid",
    closeable: false,
    menuItems: () => gridLayer.menuItems(),
    actions: options.actions,
    onFocus: (lastInput) => gridLayer.onFocus(lastInput),
    // Not wrapped in YieldAtRootLayer: the grid handles double-click itself to
    // back out of item selection before yielding to the sidebar.
    baseLayer: gridLayer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  });
  // The assistant's folder tools change the grouping from outside the window;
  // the settings broadcast is the change signal, and the fingerprint check
  // keeps every unrelated setting change from repainting the launcher. The
  // launcher is pinned for the app's lifetime, so the subscription never needs
  // tearing down.
  let lastState = `${getFolderStateFingerprint()}\n${launcherAppsFingerprint(options.apps())}`;
  onAnySettingChanged(() => {
    const state = `${getFolderStateFingerprint()}\n${launcherAppsFingerprint(options.apps())}`;
    if (state === lastState) return;
    lastState = state;
    gridLayer.closeEmptyFolder(created.stack);
    created.requestRender();
  });
  return created.window;
}

function launcherAppsFingerprint(apps: LauncherAppEntry[]): string {
  return apps
    .map((app) => `${app.appId}:${app.label}:${app.icon}:${app.iconKey ?? ""}:${app.uninstallable ? 1 : 0}`)
    .join("|");
}
