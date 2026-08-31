/**
 * Modal font picker for the Settings app: choose a face (bitmap Terminus
 * variants or any installed TTF family), a weight (the family's installed
 * styles), and a pixel size, with a live preview line rendered in the draft
 * font. Selections only persist on Save; double-click cancels.
 *
 * Used for both the UI font (Display section) and the terminal font
 * (Terminal section, filtered to monospace faces).
 */
import { getFont } from "../graphics/bdffont";
import { GrayImage, type UiFont } from "../graphics/image";
import { TtfFont } from "../graphics/ttf-font";
import { listInstalledFonts, type InstalledFont } from "../graphics/installed-fonts";
import {
  fontSelectionLabel,
  getDefaultSmallFont,
  uiFontSizeAllowed,
  getTerminalFontSelection,
  getUiFontSelection,
  setTerminalFontSelection,
  setUiFontSelection,
  type BitmapFace,
  type UiFontSelection,
} from "../graphics/ui-fonts";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "./gestures";
import { drawRightValueMenuItem, drawSelectionHighlight, openModalMenu, type MenuItem } from "./menu";
import { LIST_ROW_TEXT_INSET, listRowHeight } from "./metrics";
import type { Layer, LayerContext } from "./layers";

const SIZE_CHOICES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28] as const;
const DEFAULT_TTF_SIZE = 16;
const PREVIEW_TEXT = "The quick brown fox jumps over 0123456789";

type FontPickerOptions = {
  title: string;
  /** Only offer faces where every style is monospace (terminal picker). */
  monospaceOnly: boolean;
  /** When set, sizes where this returns false are disabled (and drafts are
   * clamped to an allowed size on face/weight changes). The UI-font picker
   * uses it to keep getDefaultSmallFont's line height within its guaranteed
   * 12..21px range; the terminal picker has no such bound. */
  sizeAllowed?: (path: string, size: number) => boolean;
  /** Bitmap faces offered ahead of the installed TTF families. */
  bitmapFaces: readonly { face: BitmapFace; label: string }[];
  get(): UiFontSelection;
  set(selection: UiFontSelection): void;
};

type FontFamily = {
  label: string;
  fonts: InstalledFont[];
};

/** The draft being edited: a bitmap face, or a TTF family + style + size. */
type Draft =
  | { kind: "bitmap"; face: BitmapFace }
  | { kind: "ttf"; family: FontFamily; font: InstalledFont; size: number };

const ROWS = ["face", "weight", "size", "save"] as const;
type RowId = (typeof ROWS)[number];

export class FontPickerLayer implements Layer {
  private readonly families: FontFamily[];
  private draft: Draft;
  private selectedRow = 0;

  constructor(private readonly options: FontPickerOptions) {
    this.families = collectFamilies(options.monospaceOnly);
    this.draft = this.draftFromSelection(options.get());
  }

  private draftFromSelection(selection: UiFontSelection): Draft {
    if (selection.kind === "ttf") {
      for (const family of this.families) {
        const font = family.fonts.find((f) => f.fileName === selection.file);
        if (font) return { kind: "ttf", family, font, size: this.clampSize(font, selection.size) };
      }
    }
    const face =
      selection.kind === "bitmap" && this.options.bitmapFaces.some((b) => b.face === selection.face)
        ? selection.face
        : this.options.bitmapFaces[0]?.face ?? "terminus";
    return { kind: "bitmap", face };
  }

  private draftSelection(): UiFontSelection {
    return this.draft.kind === "bitmap"
      ? { kind: "bitmap", face: this.draft.face }
      : { kind: "ttf", file: this.draft.font.fileName, size: this.draft.size };
  }

  /** The draft's concrete font for the preview (bitmap fallback if unloadable). */
  private previewFont(): UiFont {
    if (this.draft.kind === "ttf") {
      const font = TtfFont.load(this.draft.font.path, this.draft.size);
      if (font) return font;
    }
    return this.draft.kind === "bitmap" && this.draft.face === "terminusv"
      ? getFont("terminusv12")
      : getFont("terminus12");
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const focused = ctx.stack.isFocused();
    image.drawText(font, 22, 14, this.options.title, 220);

    const rowX = 22;
    const rowWidth = width - 2 * rowX;
    const rowHeight = listRowHeight(font);
    const rowsTop = 24 + font.lineHeight;
    for (let index = 0; index < ROWS.length; index++) {
      const row = ROWS[index]!;
      const y = rowsTop + index * rowHeight;
      const disabled = this.rowDisabled(row);
      if (index === this.selectedRow) {
        drawSelectionHighlight(image, rowX - 10, y, rowWidth + 20, rowHeight - 2, focused, 8);
      }
      if (row === "save") {
        image.drawText(font, rowX, y + LIST_ROW_TEXT_INSET, "Save", index === this.selectedRow ? 255 : 200);
        continue;
      }
      const label = row === "face" ? "Font" : row === "weight" ? "Weight" : "Size";
      const value = this.rowValue(row);
      if (disabled) {
        image.drawText(font, rowX, y + LIST_ROW_TEXT_INSET, label, 70);
        image.drawText(font, rowX + rowWidth - font.measureText(value) - 2, y + LIST_ROW_TEXT_INSET, value, 70);
      } else {
        drawRightValueMenuItem(image, font, rowX, y, rowWidth, label, value);
      }
    }

    // Preview: a separator, then the sample line in the draft font.
    const previewTop = rowsTop + ROWS.length * rowHeight + 10;
    image.drawLine(rowX - 10, previewTop, rowX + rowWidth + 10, previewTop, 60);
    const preview = this.previewFont();
    const sample =
      preview.measureText(PREVIEW_TEXT) <= rowWidth + 20 ? PREVIEW_TEXT : "The quick brown fox 0123";
    preview.drawText(image, rowX - 4, previewTop + 8, sample, 230);
    const info = `Line height: ${preview.lineHeight}px`;
    image.drawText(font, rowX - 4, previewTop + 8 + preview.lineHeight + 6, info, 110);

    return image;
  }

  private rowDisabled(row: RowId): boolean {
    return (row === "weight" || row === "size") && this.draft.kind === "bitmap";
  }

  private rowValue(row: RowId): string {
    if (row === "face") {
      if (this.draft.kind === "bitmap") {
        return this.options.bitmapFaces.find((b) => b.face === (this.draft as { face: BitmapFace }).face)?.label
          ?? "Terminus";
      }
      return this.draft.family.label;
    }
    if (this.draft.kind === "bitmap") return "-";
    if (row === "weight") return this.draft.font.style || "Regular";
    return String(this.draft.size);
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.selectedRow = (this.selectedRow + ROWS.length - 1) % ROWS.length;
        return;
      case "scroll-down":
        this.selectedRow = (this.selectedRow + 1) % ROWS.length;
        return;
      case "click": {
        const row = ROWS[this.selectedRow]!;
        if (this.rowDisabled(row)) return;
        if (row === "face") this.openFaceMenu(ctx);
        else if (row === "weight") this.openWeightMenu(ctx);
        else if (row === "size") this.openSizeMenu(ctx);
        else {
          this.options.set(this.draftSelection());
          ctx.stack.pop();
        }
        return;
      }
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private openFaceMenu(ctx: LayerContext): void {
    const items: MenuItem[] = [];
    for (const bitmap of this.options.bitmapFaces) {
      items.push({
        label: `${bitmap.label} (bitmap)`,
        onSelect: (innerCtx) => {
          this.draft = { kind: "bitmap", face: bitmap.face };
          innerCtx.stack.pop();
        },
      });
    }
    for (const family of this.families) {
      items.push({
        label: family.label,
        onSelect: (innerCtx) => {
          this.setFamily(family);
          innerCtx.stack.pop();
        },
      });
    }
    const currentIndex =
      this.draft.kind === "bitmap"
        ? Math.max(0, this.options.bitmapFaces.findIndex((b) => b.face === (this.draft as { face: BitmapFace }).face))
        : this.options.bitmapFaces.length + this.families.indexOf(this.draft.family);
    openModalMenu(ctx, "Font Face", items, Math.max(0, currentIndex));
  }

  /** Switch families, carrying the weight (nearest available) and size over. */
  private setFamily(family: FontFamily): void {
    const previous = this.draft;
    const targetOrder = previous.kind === "ttf" ? previous.font.weightOrder : 400;
    const size = previous.kind === "ttf" ? previous.size : DEFAULT_TTF_SIZE;
    let font = family.fonts[0]!;
    for (const candidate of family.fonts) {
      if (Math.abs(candidate.weightOrder - targetOrder) < Math.abs(font.weightOrder - targetOrder)) {
        font = candidate;
      }
    }
    this.draft = { kind: "ttf", family, font, size: this.clampSize(font, size) };
  }

  /**
   * The nearest allowed size for this face (line-height bounds differ by
   * face, so a face/weight change can invalidate the carried-over size).
   */
  private clampSize(font: InstalledFont, size: number): number {
    const allowed = this.options.sizeAllowed;
    if (!allowed || allowed(font.path, size)) return size;
    let best = -1;
    for (const candidate of SIZE_CHOICES) {
      if (!allowed(font.path, candidate)) continue;
      if (best < 0 || Math.abs(candidate - size) < Math.abs(best - size)) best = candidate;
    }
    return best > 0 ? best : size;
  }

  private openWeightMenu(ctx: LayerContext): void {
    if (this.draft.kind !== "ttf") return;
    const draft = this.draft;
    const items = draft.family.fonts.map((font): MenuItem => ({
      label: font.style || "Regular",
      onSelect: (innerCtx) => {
        this.draft = { ...draft, font, size: this.clampSize(font, draft.size) };
        innerCtx.stack.pop();
      },
    }));
    openModalMenu(ctx, "Weight", items, Math.max(0, draft.family.fonts.indexOf(draft.font)));
  }

  private openSizeMenu(ctx: LayerContext): void {
    if (this.draft.kind !== "ttf") return;
    const draft = this.draft;
    const items = SIZE_CHOICES.map((size): MenuItem => ({
      label: String(size),
      disabled: () => this.options.sizeAllowed !== undefined && !this.options.sizeAllowed(draft.font.path, size),
      onSelect: (innerCtx) => {
        this.draft = { ...draft, size };
        innerCtx.stack.pop();
      },
    }));
    openModalMenu(ctx, "Size", items, Math.max(0, SIZE_CHOICES.indexOf(draft.size as (typeof SIZE_CHOICES)[number])));
  }
}

/** Installed fonts grouped into families (styles sorted by weight). */
function collectFamilies(monospaceOnly: boolean): FontFamily[] {
  const byLabel = new Map<string, FontFamily>();
  for (const font of listInstalledFonts()) {
    if (monospaceOnly && !font.monospace) continue;
    let family = byLabel.get(font.family);
    if (!family) {
      family = { label: font.family, fonts: [] };
      byLabel.set(font.family, family);
    }
    family.fonts.push(font);
  }
  return [...byLabel.values()];
}

/** Settings row for the UI font: label + current value, opens the picker. */
export function uiFontPickerMenuItem(): MenuItem {
  return fontPickerMenuItem({
    rowLabel: "Font",
    description:
      "Typeface for UI text on the glasses: a bitmap Terminus variant or any installed TTF face at a chosen weight and size. Install more fonts from the Files app.",
    title: "UI font",
    monospaceOnly: false,
    sizeAllowed: uiFontSizeAllowed,
    bitmapFaces: [
      { face: "terminus", label: "Terminus" },
      { face: "terminusv", label: "TerminusV" },
    ],
    get: getUiFontSelection,
    set: setUiFontSelection,
  });
}

/** Settings row for the terminal font (monospace faces only). */
export function terminalFontPickerMenuItem(): MenuItem {
  return fontPickerMenuItem({
    rowLabel: "Font",
    description:
      "Typeface for terminal windows, limited to fixed-width faces. Takes effect for newly opened terminal windows.",
    title: "Terminal font",
    monospaceOnly: true,
    bitmapFaces: [{ face: "terminus", label: "Terminus" }],
    get: getTerminalFontSelection,
    set: setTerminalFontSelection,
  });
}

function fontPickerMenuItem(options: FontPickerOptions & { rowLabel: string; description: string }): MenuItem {
  return {
    label: options.rowLabel,
    description: options.description,
    onSelect: (ctx) => {
      ctx.stack.push(new FontPickerLayer(options));
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(
        image,
        getDefaultSmallFont(),
        x,
        y,
        width,
        options.rowLabel,
        fontSelectionLabel(options.get()),
      );
    },
  };
}
