import { type BdfFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { GrayImage } from "../../graphics/image";
import { type Plane } from "../../graphics/plane";
import { renderIcon, type IconName } from "../../graphics/icons";
import { InputEvent } from "../../ui/gestures";
import { IconGrid, ICON_GRID_ICON_SIZE } from "../../ui/icon-grid";
import { Layer, LayerActions, LayerContext } from "../../ui/layers";
import { MenuLayer, type MenuItem } from "../../ui/menu";
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

const GRID_TOP = 6;

/** One cell of the grid: an app, or a folder holding some of the apps. */
type LauncherGridEntry =
  | { kind: "app"; label: string; icon: IconName; appId: string; renderIcon?: (size: number) => GrayImage | null }
  | { kind: "folder"; label: string; name: string };

/**
 * The launcher grid: app and folder icons with labels, in an IconGrid (which
 * owns layout, selection and the ring/watch navigation schemes). Opening a
 * folder shows the same grid restricted to that folder's apps; backing out
 * of a folder returns to the top grid, and from the top grid yields to the
 * sidebar.
 *
 * The folder grouping lives in the settings store (see launcher-folders.ts)
 * and is re-read every paint, so assistant folder tools take effect without
 * the layer holding any copy of the state.
 */
class LauncherGridLayer implements Layer {
  // Watch swipes are spatial: up/down move between rows, left/right between
  // columns. From the leftmost column, left keeps going out: it leaves the
  // open folder if there is one, else yields to the sidebar — "left" points
  // toward the sidebar all the way out.
  readonly acceptsDirectional = true;
  /** Folder whose contents the grid is showing, or null for the top grid. */
  private currentFolder: string | null = null;
  private readonly grid = new IconGrid<LauncherGridEntry>({
    items: () => this.entries(),
    describe: (entry) => ({
      label: entry.label,
      icon: entry.kind === "app"
        ? entry.renderIcon?.(ICON_GRID_ICON_SIZE) ?? renderIcon(entry.icon, ICON_GRID_ICON_SIZE)
        : renderIcon("folder-filled", ICON_GRID_ICON_SIZE),
    }),
    onActivate: (entry) => this.openEntry(entry),
    onBack: () => this.back(),
  });

  constructor(private readonly options: LauncherOptions) {}

  onFocus(lastInput: InputEvent | null): void {
    this.grid.onFocus(lastInput);
  }

  /**
   * The cells to show, computed fresh from the folder state. Self-heals
   * currentFolder: if the open folder no longer exists (the assistant
   * disbanded it), the view falls back to the top grid.
   */
  private entries(): LauncherGridEntry[] {
    const apps = this.options.apps();
    const byAppId = new Map(apps.map((app) => [app.appId, app]));
    if (this.currentFolder !== null) {
      const members = (getFolders().get(this.currentFolder) ?? [])
        .map((appId) => byAppId.get(appId))
        .filter(Boolean) as LauncherAppEntry[];
      if (members.length > 0) {
        return members
          .map((app): LauncherGridEntry => ({
            kind: "app",
            label: app.label,
            icon: app.icon,
            appId: app.appId,
            renderIcon: app.renderIcon,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      this.currentFolder = null;
    }
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
      if (!assignments[app.appId]) {
        entries.push({
          kind: "app",
          label: app.label,
          icon: app.icon,
          appId: app.appId,
          renderIcon: app.renderIcon,
        });
      }
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Leave the current folder, putting the selection back on its cell. */
  private exitFolder(): void {
    const folder = this.currentFolder;
    this.currentFolder = null;
    this.grid.resetSelection();
    const index = this.entries().findIndex((entry) => entry.kind === "folder" && entry.name === folder);
    if (index >= 0) this.grid.selectIndex(index);
  }

  /** Enter a folder or launch an app; true when that left the grid (a launch). */
  private async openEntry(entry: LauncherGridEntry): Promise<boolean> {
    if (entry.kind === "folder") {
      this.currentFolder = entry.name;
      this.grid.resetSelection();
      return false;
    }
    // Return to the top grid before launching, so the launcher never
    // shows (even briefly) stale folder contents when re-entered.
    if (this.currentFolder !== null) this.exitFolder();
    this.grid.enterRowMode();
    await this.options.launchApp(entry.appId);
    return true;
  }

  /** Leave the open folder, else yield to the sidebar; true when that left the grid. */
  private back(): boolean {
    if (this.currentFolder !== null) {
      this.exitFolder();
      return false;
    }
    shell.yieldFocusToSidebar();
    return true;
  }

  /**
   * App-specific entries for the window's context menu. Only item mode
   * pins the selection to a single cell, and only apps can move to folders,
   * so anywhere else the menu falls back to just the defaults.
   */
  menuItems(): MenuItem[] {
    const entry = this.grid.selectedItem;
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
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    // The folder-name header band scales with the font.
    const gridTop = this.currentFolder !== null ? GRID_TOP + font.lineHeight + 4 : GRID_TOP;
    if (this.currentFolder !== null) {
      image.drawText(font, 8, GRID_TOP - 2, truncateText(font, this.currentFolder, width - 16), 160);
    }
    const gridBottom = height - 4;
    this.grid.paint(image, { x: 0, y: gridTop, width, height: gridBottom - gridTop }, ctx.stack.isFocused());
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
    created.requestRender();
  });
  return created.window;
}

function launcherAppsFingerprint(apps: LauncherAppEntry[]): string {
  return apps
    .map((app) => `${app.appId}:${app.label}:${app.icon}:${app.iconKey ?? ""}:${app.uninstallable ? 1 : 0}`)
    .join("|");
}
