import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, truncateLeft } from "../../graphics/textwrap";
import { GrayImage, type UiFont } from "../../graphics/image";
import { renderIcon, type IconName } from "../../graphics/icons";
import { clamp } from "../../util/numeric-util";
import { drawListScrollbar, drawSelectionHighlight, scrollToKeepSelectionVisible, type MenuItem } from "../../ui/menu";
import { iconGridMinRowHeight, tightRowHeight } from "../../ui/metrics";
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
import { directionalFallback, isWatchInput, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";

const LIST_X = 20;

/** Header: one line holding both the title and the current path. */
function headerHeight(font: UiFont): number {
  return 10 + font.lineHeight;
}

const GRID_COLS = 5;
const ICON_SIZE = 44;
const LABEL_GAP = 2;

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

type IconRow =
  | { kind: "special"; item: BrowserItem; flatIndex: number }
  | { kind: "grid"; items: EntryItem[]; firstIndex: number };

type IconMode = "row" | "item";

/**
 * Filesystem browser with two views. The top "Places" level lists bookmarks
 * and the storage roots; descending browses real directories. Icons view is a
 * 5-column grid with launcher-style two-level selection (scroll picks a row,
 * click drops into the row, scroll picks the item); list view is a flat list.
 * Click descends into a directory or picks a supported file; double-click
 * backs out one level (item selection, then parent directory, then Places,
 * then leaving the browser). That is the ring's scheme; in icons view the
 * watch (see handleIconsWatchInput) skips row mode and moves one cell at a
 * time in four directions, exactly as in the launcher. Sized to its hosting
 * stack.
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

  private listIndex = 0;
  private selectedRow = 0;
  private selectedCol = 0;
  private iconMode: IconMode = "row";
  private scrollRow = 0;

  constructor(private readonly options: FileBrowserOptions) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const rows = this.flatRows();

    image.drawText(font, 20, 8, "Files", 220);
    const pathLabel = this.location === null ? "Places" : this.location;
    const pathX = 20 + font.measureText("Files") + 14;
    image.drawText(font, pathX, 8, truncateLeft(font, pathLabel, width - pathX - 20), 130);

    if (filesViewModeSetting.get() === "list") {
      this.paintList(image, font, rows, ctx);
    } else {
      this.paintIcons(image, font, rows, ctx);
    }
    return image;
  }

  private paintList(image: GrayImage, font: UiFont, rows: BrowserItem[], ctx: LayerContext): void {
    const { width, height } = ctx.stack.getBaseSize();
    this.listIndex = clamp(this.listIndex, 0, Math.max(0, rows.length - 1));

    const rowH = tightRowHeight(font);
    const headerH = headerHeight(font);
    const listHeight = height - headerH - 4;
    const visibleRows = Math.max(1, (listHeight / rowH) | 0);
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.listIndex, visibleRows, rows.length);

    const lastVisible = Math.min(rows.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < lastVisible; index++) {
      const row = rows[index]!;
      const y = headerH + (index - this.scrollRow) * rowH;
      const selected = index === this.listIndex;
      if (selected) {
        drawSelectionHighlight(image, LIST_X - 6, y - 1, width - 2 * LIST_X + 12, rowH - 1, ctx.stack.isFocused(), 4);
      }
      const value = itemValue(row, selected);
      image.drawText(font, LIST_X, y + 1, truncateText(font, row.label, width - 2 * LIST_X), value);
    }
  }

  private paintIcons(image: GrayImage, font: UiFont, rows: BrowserItem[], ctx: LayerContext): void {
    const { width, height } = ctx.stack.getBaseSize();
    const focused = ctx.stack.isFocused();
    const iconRows = buildIconRows(rows);
    this.selectedRow = clamp(this.selectedRow, 0, Math.max(0, iconRows.length - 1));

    const gridTop = headerHeight(font);
    const gridBottom = height - 6;
    const visibleRows = Math.max(1, Math.floor((gridBottom - gridTop) / iconGridMinRowHeight(font, ICON_SIZE, LABEL_GAP)));
    const rowH = Math.floor((gridBottom - gridTop) / visibleRows);
    const colW = width / GRID_COLS;
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedRow, visibleRows, iconRows.length);

    const lastVisible = Math.min(iconRows.length, this.scrollRow + visibleRows);
    for (let rowIndex = this.scrollRow; rowIndex < lastVisible; rowIndex++) {
      const row = iconRows[rowIndex]!;
      const y = gridTop + (rowIndex - this.scrollRow) * rowH;
      const selected = rowIndex === this.selectedRow;

      if (row.kind === "special") {
        const textY = y + (((rowH - font.lineHeight) / 2) | 0);
        if (selected) {
          drawSelectionHighlight(image, LIST_X - 6, textY - 2, width - 2 * LIST_X + 12, font.lineHeight + 4, focused, 4);
        }
        image.drawText(font, LIST_X, textY, truncateText(font, row.item.label, width - 2 * LIST_X), itemValue(row.item, selected));
        continue;
      }

      if (selected) {
        // Same preview rule as the launcher: while defocused with the watch
        // as the last-used source, show the cell a click would land on (watch
        // focus enters item mode directly; see onFocus) instead of a row band
        // the watch scheme never shows.
        const cellHighlight = this.iconMode === "item" || (!focused && shell.lastInputWasWatch());
        if (cellHighlight) {
          this.selectedCol = clamp(this.selectedCol, 0, row.items.length - 1);
          drawSelectionHighlight(image, this.selectedCol * colW + 4, y + 1, colW - 8, rowH - 2, focused, 6);
        } else {
          drawSelectionHighlight(image, 4, y + 1, width - 8, rowH - 2, focused, 6);
        }
      }

      for (let col = 0; col < row.items.length; col++) {
        const item = row.items[col]!;
        const centerX = col * colW + colW / 2;
        const blockTop = y + Math.max(2, (rowH - ICON_SIZE - font.lineHeight - LABEL_GAP) / 2);
        const icon = renderIcon(item.icon, ICON_SIZE);
        if (icon) {
          image.bitBlt(item.supported ? icon : dimmedIcon(item.icon, icon), Math.round(centerX - icon.width / 2), Math.round(blockTop), {
            transparentZero: true,
          });
        }
        const label = truncateText(font, item.label, colW - 8);
        const labelY = Math.round(blockTop + ICON_SIZE + LABEL_GAP);
        image.drawText(font, Math.round(centerX - font.measureText(label) / 2), labelY, label, item.supported ? 210 : 100);
      }
    }

    if (iconRows.length > visibleRows) {
      drawListScrollbar(image, width - 5, gridTop, visibleRows * rowH - 4, this.scrollRow, visibleRows, iconRows.length);
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (filesViewModeSetting.get() === "list") {
      // The flat list has no spatial meaning for swipes; give them the
      // standard scroll / select / back meanings (the layer opted into
      // directional delivery for the icons view, so the stack won't).
      await this.handleListInput(directionalFallback(event), ctx);
    } else if (isWatchInput(event)) {
      await this.handleIconsWatchInput(event, ctx);
    } else {
      await this.handleIconsInput(event, ctx);
    }
  }

  /**
   * Focus arriving from the watch goes straight to item selection, as in the
   * launcher: the watch has left/right swipes, so it never needs row mode.
   * Any other source keeps the two-level scheme and enters in row mode.
   */
  onFocus(lastInput: InputEvent | null): void {
    if (filesViewModeSetting.get() !== "icons") return;
    if (lastInput && isWatchInput(lastInput)) {
      this.iconMode = "item";
      const iconRows = buildIconRows(this.flatRows());
      this.clampColToRow(iconRows[clamp(this.selectedRow, 0, Math.max(0, iconRows.length - 1))]);
    } else {
      this.iconMode = "row";
    }
  }

  private async handleListInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.flatRows();
    switch (event.type) {
      case "scroll-up":
        this.listIndex = Math.max(0, this.listIndex - 1);
        return;
      case "scroll-down":
        this.listIndex = Math.min(Math.max(0, rows.length - 1), this.listIndex + 1);
        return;
      case "click": {
        const row = rows[clamp(this.listIndex, 0, Math.max(0, rows.length - 1))];
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

  private async handleIconsInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.flatRows();
    const iconRows = buildIconRows(rows);
    this.selectedRow = clamp(this.selectedRow, 0, Math.max(0, iconRows.length - 1));
    const row = iconRows[this.selectedRow];
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "scroll-down" ? 1 : -1;
        if (this.iconMode === "item") {
          // Item selection traverses linearly: past a row's edge it continues
          // onto the adjacent row (a special row counts as a single item).
          if (row?.kind === "grid") {
            const next = clamp(this.selectedCol, 0, row.items.length - 1) + delta;
            if (next >= 0 && next < row.items.length) {
              this.selectedCol = next;
              return;
            }
          }
          const adjacentIndex = this.selectedRow + delta;
          if (adjacentIndex < 0 || adjacentIndex >= iconRows.length) return;
          this.selectedRow = adjacentIndex;
          const adjacent = iconRows[adjacentIndex]!;
          if (adjacent.kind === "grid") {
            this.selectedCol = delta > 0 ? 0 : adjacent.items.length - 1;
          }
        } else {
          this.selectedRow = clamp(this.selectedRow + delta, 0, Math.max(0, iconRows.length - 1));
        }
        return;
      }
      case "click": {
        if (!row) return;
        if (row.kind === "special") {
          await this.activateItem(row.item, ctx);
          return;
        }
        if (this.iconMode === "row") {
          this.iconMode = "item";
          // Default to the middle column (clamped to the row's item count).
          this.selectedCol = Math.min(Math.floor(GRID_COLS / 2), row.items.length - 1);
        } else {
          const item = row.items[clamp(this.selectedCol, 0, row.items.length - 1)];
          if (item) await this.activateItem(item, ctx);
        }
        return;
      }
      case "double-click":
        if (this.iconMode === "item") {
          this.iconMode = "row";
        } else {
          this.navigateUp();
        }
        return;
      default:
        return;
    }
  }

  /**
   * The watch's scheme for the icons view — the launcher's: there is no row
   * mode, the selection is always one cell (a special row counts as its
   * single full-width item). Up/down (and the crown) move between rows
   * keeping the column, right/left move within the row, and left from the
   * leftmost column keeps going out — parent directory, Places, then the
   * sidebar. Row mode is restored on the way out so a ring user finds the
   * grid as they left it.
   */
  private async handleIconsWatchInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const iconRows = buildIconRows(this.flatRows());
    this.selectedRow = clamp(this.selectedRow, 0, Math.max(0, iconRows.length - 1));
    const row = iconRows[this.selectedRow];
    if (this.iconMode === "row") {
      this.iconMode = "item";
      this.clampColToRow(row);
    }
    switch (event.type) {
      case "swipe-up":
      case "swipe-down":
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "swipe-down" || event.type === "scroll-down" ? 1 : -1;
        this.selectedRow = clamp(this.selectedRow + delta, 0, Math.max(0, iconRows.length - 1));
        // Keep the column; a shorter row (or a special one) clamps it.
        this.clampColToRow(iconRows[this.selectedRow]);
        return;
      }
      case "swipe-right":
        if (row?.kind === "grid") {
          this.selectedCol = clamp(this.selectedCol + 1, 0, row.items.length - 1);
        }
        return;
      case "swipe-left":
        if (row?.kind === "grid" && this.selectedCol > 0) {
          this.selectedCol--;
        } else {
          this.watchNavigateUp();
        }
        return;
      case "click": {
        if (!row) return;
        if (row.kind === "special") {
          await this.activateItem(row.item, ctx);
        } else {
          const item = row.items[clamp(this.selectedCol, 0, row.items.length - 1)];
          if (item) await this.activateItem(item, ctx);
        }
        // Descending into a directory resets the selection for the ring (row
        // mode at the top); the watch scheme stays in single-item selection.
        this.iconMode = "item";
        return;
      }
      case "double-click":
        this.watchNavigateUp();
        return;
      default:
        return;
    }
  }

  private clampColToRow(row: IconRow | undefined): void {
    if (row?.kind === "grid") {
      this.selectedCol = clamp(this.selectedCol, 0, row.items.length - 1);
    }
  }

  /**
   * navigateUp for the watch scheme: inside the browser the selection stays
   * in item mode (resetSelection/selectPath put it back in row mode for the
   * ring); leaving from Places restores row mode on the way out.
   */
  private watchNavigateUp(): void {
    if (this.location === null) {
      this.iconMode = "row";
      this.options.onLeave();
      return;
    }
    this.navigateUp();
    this.iconMode = "item";
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
          const rows = this.flatRows();
          this.listIndex = clamp(this.listIndex, 0, Math.max(0, rows.length - 1));
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
      return rows[clamp(this.listIndex, 0, rows.length - 1)] ?? null;
    }
    const iconRows = buildIconRows(rows);
    const row = iconRows[clamp(this.selectedRow, 0, iconRows.length - 1)];
    if (!row) return null;
    if (row.kind === "special") return row.item;
    if (this.iconMode !== "item") return null;
    return row.items[clamp(this.selectedCol, 0, row.items.length - 1)] ?? null;
  }

  private setViewMode(mode: FilesViewMode): void {
    if (filesViewModeSetting.get() === mode) return;
    const rows = this.flatRows();
    const iconRows = buildIconRows(rows);
    if (mode === "list") {
      // Carry the icon-grid selection into the flat list (clamped column when
      // only a row was selected).
      const row = iconRows[clamp(this.selectedRow, 0, Math.max(0, iconRows.length - 1))];
      if (row) {
        this.listIndex =
          row.kind === "special" ? row.flatIndex : row.firstIndex + clamp(this.selectedCol, 0, row.items.length - 1);
      }
    } else {
      this.setGridSelectionFromFlatIndex(rows, clamp(this.listIndex, 0, Math.max(0, rows.length - 1)));
      this.iconMode = "row";
    }
    filesViewModeSetting.set(mode);
    this.scrollRow = 0;
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

  private navigateUp(): void {
    const from = this.location;
    if (from === null) {
      this.options.onLeave();
      return;
    }
    if (from === this.navRoot || from === "/") {
      this.location = null;
      this.entries = null;
      this.resetSelection();
      this.selectPath(this.navRoot ?? from);
      this.navRoot = null;
      return;
    }
    const parentRaw = from.slice(0, from.lastIndexOf("/"));
    this.navigateTo(parentRaw.length ? parentRaw : "/");
    this.selectPath(from);
  }

  private resetSelection(): void {
    this.listIndex = 0;
    this.selectedRow = 0;
    this.selectedCol = 0;
    this.iconMode = "row";
    this.scrollRow = 0;
  }

  /** Select the item with the given path (e.g. the directory just left). */
  private selectPath(path: string): void {
    const rows = this.flatRows();
    const index = rows.findIndex((row) => row.kind === "entry" && row.entry.path === path);
    if (index < 0) return;
    this.listIndex = index;
    this.setGridSelectionFromFlatIndex(rows, index);
  }

  private setGridSelectionFromFlatIndex(rows: BrowserItem[], index: number): void {
    const specials = leadingSpecialCount(rows);
    if (index < specials) {
      this.selectedRow = index;
      this.selectedCol = 0;
      return;
    }
    const ordinal = index - specials;
    this.selectedRow = specials + Math.floor(ordinal / GRID_COLS);
    this.selectedCol = ordinal % GRID_COLS;
  }

  private flatRows(): BrowserItem[] {
    const rows: BrowserItem[] = [];
    if (!hasAllFilesAccess()) {
      rows.push({ kind: "grant", label: "Grant file access (opens phone Settings)" });
    }
    if (this.location === null) {
      for (const path of getBookmarkedPaths()) {
        rows.push(this.bookmarkItem(path));
      }
      rows.push(this.placeItem("Internal storage", externalStorageRootPath()));
      rows.push(this.placeItem("/", "/"));
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

function buildIconRows(flat: BrowserItem[]): IconRow[] {
  const rows: IconRow[] = [];
  let index = 0;
  // Special rows (grant prompt, empty/unreadable info) lead the list; each
  // gets a full-width row of its own. Entries follow, chunked into grid rows.
  while (index < flat.length && flat[index]!.kind !== "entry") {
    rows.push({ kind: "special", item: flat[index]!, flatIndex: index });
    index++;
  }
  for (; index < flat.length; index += GRID_COLS) {
    rows.push({ kind: "grid", items: flat.slice(index, index + GRID_COLS) as EntryItem[], firstIndex: index });
  }
  return rows;
}

function leadingSpecialCount(rows: BrowserItem[]): number {
  let count = 0;
  while (count < rows.length && rows[count]!.kind !== "entry") count++;
  return count;
}

function itemValue(item: BrowserItem, selected: boolean): number {
  if (item.kind === "info") return 120;
  if (item.kind === "grant") return selected ? 255 : 210;
  if (!item.supported) return selected ? 140 : 100;
  return selected ? 255 : 200;
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
