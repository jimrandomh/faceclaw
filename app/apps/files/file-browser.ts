import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, truncateLeft } from "../../graphics/textwrap";
import { GrayImage, type UiFont } from "../../graphics/image";
import { renderIcon, type IconName } from "../../graphics/icons";
import { type MenuItem } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { IconGrid, ICON_GRID_ICON_SIZE } from "../../ui/icon-grid";
import { centeredTextY, tightRowHeight } from "../../ui/metrics";
import { ConfigSettingEnum } from "../../ui/dashboard-settings";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import {
  externalStorageRootPath,
  hasAllFilesAccess,
  listDirectory,
  requestAllFilesAccess,
  statPath,
  type DirectoryEntry,
} from "../../native/file-access";
import { directionalFallback, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";

const LIST_X = 20;
/** List view: the selection box extends this far left and right of the row text. */
const LIST_HIGHLIGHT_PAD = 6;

/** Header: one line holding both the title and the current path. */
function headerHeight(font: UiFont): number {
  return 10 + font.lineHeight;
}

export type FilesViewMode = "icons" | "list";

export const filesViewModeSetting = new ConfigSettingEnum<FilesViewMode>({
  id: "files-view-mode",
  label: "View",
  storageKey: "files.viewMode",
  defaultValue: "icons",
  values: ["icons", "list"],
  formatValue: (value) => (value === "icons" ? "Icons" : "List"),
});

// Bookmarked paths, in bookmarking order, stored as a JSON string array.
const BOOKMARKS_KEY = "files.bookmarks";

export function getBookmarkedPaths(): string[] {
  try {
    const parsed = JSON.parse(getStringSetting(BOOKMARKS_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

export function isBookmarked(path: string): boolean {
  return getBookmarkedPaths().includes(path);
}

export function toggleBookmark(path: string): void {
  const paths = getBookmarkedPaths();
  const next = paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path];
  setStringSetting(BOOKMARKS_KEY, JSON.stringify(next));
}

const TEXT_EXT = /\.(txt|md|markdown|log|json|xml|csv|ini|conf|cfg|yaml|yml|ts|js|py|java|c|cpp|h|sh|html|css)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|heic|heif|svg)$/i;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|3gp|m4v)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|mid)$/i;
const FONT_EXT = /\.(ttf|otf|ttc|bdf|woff2?)$/i;

function fileIconName(name: string): IconName {
  if (TEXT_EXT.test(name)) return "file-text";
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "film";
  if (AUDIO_EXT.test(name)) return "music";
  if (FONT_EXT.test(name)) return "type";
  return "file";
}

export type FileBrowserOptions = {
  /** Files failing this are listed dimmed (not viewable); picking them still fires onFilePicked. */
  isSupportedFile: (name: string) => boolean;
  onFilePicked: (entry: DirectoryEntry, ctx: LayerContext) => void;
  /** Double-click while already at the Places level (leave the browser). */
  onLeave: () => void;
};

type EntryItem = {
  kind: "entry";
  label: string;
  icon: IconName;
  entry: DirectoryEntry;
  supported: boolean;
  /** A bookmark whose path no longer exists (listed only for unbookmarking). */
  missing?: boolean;
  /** An item on the Places level (a bookmark or a fixed storage root). */
  place: boolean;
  /** Fixed Places roots cannot be bookmarked or unbookmarked. */
  fixed: boolean;
};

type BrowserItem = { kind: "grant"; label: string } | { kind: "info"; label: string } | EntryItem;

/**
 * Filesystem browser with two views. The top "Places" level lists bookmarks
 * and the storage roots; descending browses real directories. Icons view is
 * the launcher's IconGrid (two-level ring selection, four-way watch
 * selection; notice rows span the full width); list view is a flat list.
 * Click descends into a directory or picks a supported file; double-click
 * backs out one level (item selection, then parent directory, then Places,
 * then leaving the browser). Sized to its hosting stack.
 */
export class FileBrowserLayer implements Layer {
  // Watch swipes are spatial in icons view: up/down move between rows,
  // left/right between columns. From the leftmost column, left keeps going
  // out (parent directory, Places, then the sidebar). List view maps swipes
  // through directionalFallback itself.
  readonly acceptsDirectional = true;
  /** Current directory, or null at the Places level. */
  private location: string | null = null;
  /** The Places entry we descended through; going up from it returns to Places. */
  private navRoot: string | null = null;
  private entries: DirectoryEntry[] | null = null;
  private listingFailed = false;

  /** List view. Both views index the same flatRows(), which is how setViewMode carries the selection across. */
  private readonly listMenu = new Menu<BrowserItem>({
    wrap: false,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()),
    draw: (args) => this.drawListRow(args),
  });
  /** Icons view. */
  private readonly grid = new IconGrid<BrowserItem>({
    items: () => this.flatRows(),
    isWide: (item) => item.kind !== "entry",
    describe: (item, selected) =>
      item.kind === "entry"
        ? { label: item.label, icon: gridIcon(item), labelValue: item.supported ? 210 : 100 }
        : { label: item.label, labelValue: itemValue(item, selected) },
    onActivate: (item, _index, ctx) => this.activateItem(item, ctx),
    onBack: () => this.navigateUp(),
    scrollbar: true,
  });

  constructor(private readonly options: FileBrowserOptions) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, "Files", 220);
    const pathLabel = this.location === null ? "Places" : this.location;
    const pathX = 20 + font.measureText("Files") + 14;
    image.drawText(font, pathX, 8, truncateLeft(font, pathLabel, width - pathX - 20), 130);

    if (filesViewModeSetting.get() === "list") {
      this.paintList(image, font, ctx);
    } else {
      const headerH = headerHeight(font);
      this.grid.paint(image, { x: 0, y: headerH, width, height: height - headerH - 6 }, ctx.stack.isFocused());
    }
    return image;
  }

  private paintList(image: GrayImage, font: UiFont, ctx: LayerContext): void {
    const { width, height } = ctx.stack.getBaseSize();
    const headerH = headerHeight(font);
    this.listMenu.setItems(this.flatRows());
    // Row boxes start one pixel above the header's bottom edge.
    this.listMenu.paint(
      image,
      { x: LIST_X - LIST_HIGHLIGHT_PAD, y: headerH - 1, width: width - 2 * LIST_X + 2 * LIST_HIGHLIGHT_PAD, height: height - headerH - 4 },
      ctx.stack.isFocused(),
    );
  }

  private drawListRow({ image, item, x, y, width, height, selected }: MenuDrawArgs<BrowserItem>): void {
    const font = getDefaultSmallFont();
    const label = truncateText(font, item.label, width - 2 * LIST_HIGHLIGHT_PAD);
    image.drawText(font, x + LIST_HIGHLIGHT_PAD, centeredTextY(font, y, height), label, itemValue(item, selected));
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (filesViewModeSetting.get() === "list") {
      // The flat list has no spatial meaning for swipes; give them the
      // standard scroll / select / back meanings (the layer opted into
      // directional delivery for the icons view, so the stack won't).
      await this.handleListInput(directionalFallback(event), ctx);
    } else {
      await this.grid.handleInput(event, ctx);
    }
  }

  onFocus(lastInput: InputEvent | null): void {
    if (filesViewModeSetting.get() === "icons") this.grid.onFocus(lastInput);
  }

  private async handleListInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    this.listMenu.setItems(this.flatRows());
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        await this.listMenu.handleInput(event);
        return;
      case "click": {
        const row = this.listMenu.selectedItem;
        if (row) await this.activateItem(row, ctx);
        return;
      }
      case "double-click":
        this.navigateUp();
        return;
      default:
        return;
    }
  }

  /**
   * App-specific entries for the window long-press menu: the view switch,
   * plus bookmark/unbookmark for the selected entry (in icons view only once
   * an item, not just a row, is selected).
   */
  buildMenuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    const mode = filesViewModeSetting.get();
    items.push({
      label: mode === "icons" ? "View as list" : "View as icons",
      onSelect: (ctx) => {
        this.setViewMode(mode === "icons" ? "list" : "icons");
        ctx.stack.pop();
      },
    });
    const target = this.currentItem();
    if (target && target.kind === "entry" && !target.fixed) {
      const path = target.entry.path;
      const name = truncateChars(target.entry.name || path, 24);
      items.push({
        label: isBookmarked(path) ? `Remove bookmark: ${name}` : `Bookmark: ${name}`,
        onSelect: (ctx) => {
          toggleBookmark(path);
          this.listMenu.setItems(this.flatRows());
          ctx.stack.pop();
        },
      });
    }
    return items;
  }

  /** The item an entry-specific action would apply to, if one is selected. */
  private currentItem(): BrowserItem | null {
    const rows = this.flatRows();
    if (!rows.length) return null;
    if (filesViewModeSetting.get() === "list") {
      this.listMenu.setItems(rows);
      return this.listMenu.selectedItem;
    }
    return this.grid.selectedItem;
  }

  private setViewMode(mode: FilesViewMode): void {
    if (filesViewModeSetting.get() === mode) return;
    this.listMenu.setItems(this.flatRows());
    if (mode === "list") {
      // Carry the icon-grid selection into the flat list (the remembered
      // column when only a row was selected).
      const index = this.grid.cursorIndex;
      if (index !== null) this.listMenu.select(index);
    } else {
      const index = this.listMenu.selectedIndex ?? 0;
      this.grid.resetSelection();
      this.grid.selectIndex(index);
    }
    filesViewModeSetting.set(mode);
    this.listMenu.scrollTop = 0;
  }

  private async activateItem(item: BrowserItem, ctx: LayerContext): Promise<void> {
    if (item.kind === "grant") {
      requestAllFilesAccess();
      this.entries = null; // re-list after the user returns from Settings
      return;
    }
    if (item.kind !== "entry" || item.missing) return;
    if (item.entry.isDirectory) {
      this.navigateTo(item.entry.path, item.place);
    } else {
      // Every real file opens the picked-file dialog, viewable or not (the
      // dialog shows metadata; open actions depend on the type).
      this.options.onFilePicked(item.entry, ctx);
    }
  }

  private navigateTo(path: string, asRoot = false): void {
    if (asRoot) this.navRoot = path;
    this.location = path;
    this.entries = null;
    this.resetSelection();
  }

  /** Back out one level; true when that left the browser (from Places). */
  private navigateUp(): boolean {
    const from = this.location;
    if (from === null) {
      this.options.onLeave();
      return true;
    }
    if (from === this.navRoot || from === "/") {
      this.location = null;
      this.entries = null;
      this.resetSelection();
      this.selectPath(this.navRoot ?? from);
      this.navRoot = null;
      return false;
    }
    const parentRaw = from.slice(0, from.lastIndexOf("/"));
    this.navigateTo(parentRaw.length ? parentRaw : "/");
    this.selectPath(from);
    return false;
  }

  private resetSelection(): void {
    this.listMenu.select(0);
    this.listMenu.scrollTop = 0;
    this.grid.resetSelection();
  }

  /** Select the item with the given path (e.g. the directory just left). */
  private selectPath(path: string): void {
    const rows = this.flatRows();
    const index = rows.findIndex((row) => row.kind === "entry" && row.entry.path === path);
    if (index < 0) return;
    // Items first, then the selection, so the viewport scrolls minimally from the top.
    this.listMenu.setItems(rows);
    this.listMenu.select(index);
    this.grid.selectIndex(index);
  }

  private flatRows(): BrowserItem[] {
    const rows: BrowserItem[] = [];
    if (this.location === null) {
      // Only on Places: without All Files access some folders (e.g. Download)
      // may still be readable, and the prompt shouldn't crowd their listings.
      if (!hasAllFilesAccess()) {
        rows.push({ kind: "grant", label: "Grant file access (opens phone Settings)" });
      }
      for (const path of getBookmarkedPaths()) {
        rows.push(this.bookmarkItem(path));
      }
      rows.push(this.placeItem(global.isIOS ? "Faceclaw documents" : "Internal storage", externalStorageRootPath()));
      if (!global.isIOS) rows.push(this.placeItem("/", "/"));
      return rows;
    }
    this.loadEntries();
    for (const entry of this.entries ?? []) {
      rows.push({
        kind: "entry",
        entry,
        label: entry.isDirectory ? `${entry.name}/` : entry.name,
        icon: entry.isDirectory ? "folder" : fileIconName(entry.name),
        supported: entry.isDirectory || this.options.isSupportedFile(entry.name),
        place: false,
        fixed: false,
      });
    }
    if (!rows.some((row) => row.kind === "entry")) {
      rows.push({ kind: "info", label: this.listingFailed ? "(unreadable directory)" : "(empty directory)" });
    }
    return rows;
  }

  private placeItem(label: string, path: string): EntryItem {
    return {
      kind: "entry",
      entry: { name: label, path, isDirectory: true, sizeBytes: 0, modifiedMs: 0 },
      label,
      icon: "hard-drive",
      supported: true,
      place: true,
      fixed: true,
    };
  }

  private bookmarkItem(path: string): EntryItem {
    const stat = statPath(path);
    if (!stat) {
      const name = basename(path);
      return {
        kind: "entry",
        entry: { name, path, isDirectory: false, sizeBytes: 0, modifiedMs: 0 },
        label: `${name} (missing)`,
        icon: "file",
        supported: false,
        missing: true,
        place: true,
        fixed: false,
      };
    }
    const name = stat.name || path;
    return {
      kind: "entry",
      entry: stat,
      label: stat.isDirectory ? `${name}/` : name,
      icon: stat.isDirectory ? "folder" : fileIconName(name),
      supported: stat.isDirectory || this.options.isSupportedFile(name),
      place: true,
      fixed: false,
    };
  }

  private loadEntries(): void {
    if (this.entries !== null || this.location === null) return;
    const listing = listDirectory(this.location);
    this.listingFailed = listing === null;
    this.entries = listing ?? [];
  }
}

function itemValue(item: BrowserItem, selected: boolean): number {
  if (item.kind === "info") return 120;
  if (item.kind === "grant") return selected ? 255 : 210;
  if (!item.supported) return selected ? 140 : 100;
  return selected ? 255 : 200;
}

function gridIcon(item: EntryItem): GrayImage | null {
  const icon = renderIcon(item.icon, ICON_GRID_ICON_SIZE);
  return icon && !item.supported ? dimmedIcon(item.icon, icon) : icon;
}

// Unsupported files draw their grid icon at half brightness; rendered once
// per icon name and cached (all grid icons share one size).
const dimmedIconCache = new Map<IconName, GrayImage>();

function dimmedIcon(name: IconName, icon: GrayImage): GrayImage {
  const cached = dimmedIconCache.get(name);
  if (cached) return cached;
  const dimmed = new GrayImage(icon.width, icon.height, 0);
  for (let i = 0; i < icon.pixels.length; i++) {
    dimmed.pixels[i] = icon.pixels[i]! >> 1;
  }
  dimmedIconCache.set(name, dimmed);
  return dimmed;
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

function truncateChars(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
