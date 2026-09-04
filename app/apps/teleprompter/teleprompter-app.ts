import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { readTextFile, type DirectoryEntry } from "../../native/file-access";
import { LIST_ROW_TEXT_INSET } from "../../ui/metrics";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { type Layer, type LayerContext } from "../../ui/layers";
import { appViewportSize } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { FileBrowserLayer } from "../files/file-browser";
import { TeleprompterReaderLayer } from "./reader";
import {
  baseName,
  clearRecentScripts,
  getRecentScripts,
  parentDirName,
  removeRecentScript,
  saveRecentScriptPosition,
  touchRecentScript,
} from "./recent-files";

export const TELEPROMPTER_WINDOW_ID = "teleprompter";
export const TELEPROMPTER_SURFACE_ID = "window:teleprompter";

const SCRIPT_FILE = /\.(txt|md|markdown|text|log)$/i;

const HOME_LAYOUT = {
  x: 8,
  y: 8,
  width: 272,
  showBorder: false,
  minHeight: 0,
  maxHeight: appViewportSize("min").height - 16,
  opaque: true,
};

export type TeleprompterAppOptions = InProcessAppOptions & {
  /** Hold continuous mic capture while a script is being tracked. */
  startContinuousVoiceCapture: () => void;
  stopContinuousVoiceCapture: () => void;
  appendLog: (message: string) => void;
};

/**
 * The Teleprompter app window. The home page is a Browse entry plus the
 * recently opened scripts; Browse pushes the Files app's browser to pick a
 * text file, and either path pushes the reader (see TeleprompterReaderLayer)
 * over the home page.
 */
export function createTeleprompterAppWindow(options: TeleprompterAppOptions): InProcessWindow {
  // The home menu's items are rebuilt in place whenever the recents change
  // (MenuLayer reads the array each paint).
  const homeItems: MenuItem[] = [];
  const home = new MenuLayer("Teleprompter", homeItems, HOME_LAYOUT);
  let created: InProcessWindow | null = null;
  let notice = "";

  const requestRender = () => created?.requestRender();

  /** The layer currently on top of the window's stack (the home menu at base). */
  const topLayer = (): Layer => {
    let top: Layer = home;
    created?.stack.topMatches((layer) => {
      top = layer;
      return true;
    });
    return top;
  };

  const openScript = (ctx: LayerContext, path: string, name: string) => {
    const text = readTextFile(path);
    if (text === null) {
      removeRecentScript(path);
      notice = `Could not read ${name}`;
      options.appendLog(`teleprompter: could not read ${path}`);
      refreshHome();
      return;
    }
    const recent = touchRecentScript(path, name);
    notice = "";
    refreshHome();
    const layer = new TeleprompterReaderLayer(
      text,
      name,
      {
        requestRender,
        startCapture: () => options.startContinuousVoiceCapture(),
        stopCapture: () => options.stopContinuousVoiceCapture(),
        savePosition: (position) => saveRecentScriptPosition(path, position),
      },
      recent.position,
    );
    ctx.stack.push(layer);
    layer.attach();
  };

  const openBrowser = (ctx: LayerContext) => {
    const stack = ctx.stack;
    const picker = new FileBrowserLayer({
      isSupportedFile: (name) => SCRIPT_FILE.test(name),
      onLeave: () => stack.pop(),
      onFilePicked: (entry: DirectoryEntry, pickCtx) => {
        if (!SCRIPT_FILE.test(entry.name)) {
          notice = "Pick a text file (.txt, .md)";
          return;
        }
        pickCtx.stack.pop();
        openScript(pickCtx, entry.path, entry.name);
      },
    });
    stack.push(picker);
  };

  function refreshHome(): void {
    const font = getDefaultSmallFont();
    const items: MenuItem[] = [
      {
        label: "Browse for a script...",
        onSelect: (ctx) => openBrowser(ctx),
      },
    ];
    for (const recent of getRecentScripts()) {
      const folder = parentDirName(recent.path);
      items.push({
        label: recent.name || baseName(recent.path),
        onSelect: (ctx) => openScript(ctx, recent.path, recent.name),
        render: ({ image, x, y, width, selected, text }) => {
          const value = selected ? 255 : 200;
          const folderWidth = folder ? font.measureText(folder) : 0;
          const nameMax = folder ? width - folderWidth - 12 : width;
          image.drawText(font, x, y + LIST_ROW_TEXT_INSET, truncateText(font, text, Math.max(40, nameMax)), value);
          if (folder && nameMax >= 40) {
            image.drawText(font, x + width - folderWidth, y + LIST_ROW_TEXT_INSET, folder, 90);
          }
        },
      });
    }
    if (notice) {
      items.push({ label: notice, disabled: true, onSelect: () => {} });
    }
    homeItems.length = 0;
    homeItems.push(...items);
    // Land on the most recent script (one click resumes it), else on Browse.
    home.selectItem(getRecentScripts().length > 0 ? 1 : 0);
  }

  refreshHome();

  created = createInProcessWindow({
    appId: "teleprompter",
    windowId: TELEPROMPTER_WINDOW_ID,
    title: "Teleprompter",
    iconLetter: "Tp",
    icon: "scroll-text",
    closeable: true,
    actions: options.actions,
    menuItems: () => {
      const top = topLayer();
      if (top instanceof TeleprompterReaderLayer) return top.buildMenuItems();
      if (top instanceof FileBrowserLayer) return top.buildMenuItems();
      if (top !== home) return [];
      return [
        {
          label: "Clear recent scripts",
          onSelect: (ctx) => {
            clearRecentScripts();
            refreshHome();
            ctx.stack.pop();
          },
        },
      ];
    },
    onFocus: (lastInput) => {
      const top = topLayer();
      if (top instanceof FileBrowserLayer) top.onFocus(lastInput);
    },
    baseLayer: new YieldAtRootLayer(home),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  return created;
}
