import type { GrayImage, UiFont } from "../../graphics/image";
import { installedFontPath } from "../../graphics/installed-fonts";
import { wrapText } from "../../graphics/textwrap";
import { TtfFont } from "../../graphics/ttf-font";
import {
  fontSelectionLabel,
  getDefaultSmallFont,
  getUiFontSelection,
  setUiFontSelection,
  uiFontSizeAllowed,
} from "../../graphics/ui-fonts";
import { FONT_SIZE_CHOICES } from "../../ui/font-picker";
import type { InputEvent } from "../../ui/gestures";
import { Menu, type MenuBox, type MenuDrawArgs } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, listRowHeight } from "../../ui/metrics";
import { onboardingFont } from "./onboarding-fonts";
import { drawPageHeading, PAGE_X, type OnboardingNav, type OnboardingPage } from "./onboarding-page";

const CONTENT_GAP = 10;
const BOTTOM_MARGIN = 8;
const COLUMN_GAP = 12;
const PREVIEW_PADDING = 10;
const ROW_GAP = 2;
/** Between a size and its "Recommended" note. */
const NOTE_GAP = 8;
/** The sizes offered here; Settings has the full range. */
const SIZE_CHOICES = FONT_SIZE_CHOICES.filter((size) => size >= 12 && size <= 18);
/** Selected on the first visit, and marked. */
const RECOMMENDED_SIZE = 16;
const RECOMMENDED_NOTE = "Recommended";
/** Drawn while they fit, so smaller sizes visibly show more words. */
const PREVIEW_PARAGRAPHS = [
  "This is how text will look on your glasses.",
  "Smaller sizes fit more words on the display at once, while larger sizes are easier to read at a " +
    "glance or on the move. Most people find the recommended size a good balance between the two.",
];

/** The UI font's face, as far as this page is concerned: resizable (TTF) or not (bitmap). */
type Face =
  | { kind: "sized"; file: string; path: string; sizes: number[] }
  | { kind: "fixed"; label: string };

/**
 * The UI font's size, 12 to 18px (16 recommended, and selected at first),
 * beside a preview of text in the selected size. The face and weight stay
 * as they are (they live in the Settings font picker); a bitmap face has
 * only one size, so the page just says so. The size is saved on tap, not
 * while scrolling.
 */
export class TextSizePage implements OnboardingPage {
  readonly immersive = true;
  private face: Face = { kind: "fixed", label: "Terminus" };
  private readonly sizeMenu = new Menu<number>({
    wrap: false,
    rowGap: ROW_GAP,
    highlight: { radius: 8 },
    getHeight: () => listRowHeight(onboardingFont("body")),
    draw: (args) => this.drawSizeRow(args),
  });

  enter(): void {
    // Re-read on every visit: the face may have changed in Settings meanwhile.
    const selection = getUiFontSelection();
    if (selection.kind === "ttf") {
      const path = installedFontPath(selection.file);
      const sizes = SIZE_CHOICES.filter((size) => uiFontSizeAllowed(path, size));
      if (sizes.length) {
        this.face = { kind: "sized", file: selection.file, path, sizes };
        // The recommended size the first time; on a return, what was left selected.
        this.sizeMenu.setItems(sizes, nearestIndex(sizes, this.sizeMenu.selectedItem ?? RECOMMENDED_SIZE));
        return;
      }
    }
    // An unloadable TTF selection renders as Terminus, so call it that.
    this.face = { kind: "fixed", label: selection.kind === "bitmap" ? fontSelectionLabel(selection) : "Terminus" };
  }

  paint(image: GrayImage, focused: boolean): void {
    if (this.face.kind === "fixed") {
      const top = drawPageHeading(
        image,
        "Text size",
        `Your UI font, ${this.face.label}, comes in one size. To choose a size, pick a different font in ` +
          "Settings > Customization. Tap to continue.",
        3,
      ) + CONTENT_GAP;
      drawPreview(image, getDefaultSmallFont(), {
        x: PAGE_X - 10,
        y: top,
        width: image.width - 2 * (PAGE_X - 10),
        height: image.height - top - BOTTOM_MARGIN,
      });
      return;
    }
    const top = drawPageHeading(
      image,
      "Text size",
      "Swipe to choose a size, then tap to continue. The typeface and weight can be changed in Settings.",
    ) + CONTENT_GAP;
    const height = image.height - top - BOTTOM_MARGIN;
    const body = onboardingFont("body");
    // TTF widths are fractional; the menu's row images need whole pixels.
    const columnWidth = Math.ceil(20 + Math.max(...this.face.sizes.map((size) => body.measureText(sizeLabel(size)))) +
      NOTE_GAP + onboardingFont("detail").measureText(RECOMMENDED_NOTE));
    const menuBox = { x: PAGE_X - 10, y: top, width: columnWidth, height };
    this.sizeMenu.paint(image, menuBox, focused);
    const previewX = menuBox.x + menuBox.width + COLUMN_GAP;
    const size = this.sizeMenu.selectedItem;
    const font = (size !== null ? TtfFont.load(this.face.path, size) : null) ?? getDefaultSmallFont();
    drawPreview(image, font, { x: previewX, y: top, width: image.width - (PAGE_X - 10) - previewX, height });
  }

  handleInput(event: InputEvent, nav: OnboardingNav): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        if (this.face.kind === "sized") void this.sizeMenu.handleInput(event);
        return;
      case "click":
        this.save();
        nav.next();
        return;
      default:
        return;
    }
  }

  private save(): void {
    const size = this.sizeMenu.selectedItem;
    if (this.face.kind !== "sized" || size === null) return;
    const current = getUiFontSelection();
    if (current.kind === "ttf" && current.file === this.face.file && current.size === size) return;
    setUiFontSelection({ kind: "ttf", file: this.face.file, size });
  }

  private drawSizeRow({ image, item: size, x, y, height, selected }: MenuDrawArgs<number>): void {
    const body = onboardingFont("body");
    const label = sizeLabel(size);
    image.drawText(body, x + 10, y + LIST_ROW_TEXT_INSET, label, selected ? 255 : 190);
    if (size !== RECOMMENDED_SIZE) return;
    const detail = onboardingFont("detail");
    const noteY = y + Math.round((height - detail.lineHeight) / 2);
    image.drawText(detail, x + 10 + body.measureText(label) + NOTE_GAP, noteY, RECOMMENDED_NOTE, selected ? 210 : 150);
  }
}

function sizeLabel(size: number): string {
  return `${size} px`;
}

/** A framed sample in `font`: paragraphs of text, as many whole lines as fit. */
function drawPreview(image: GrayImage, font: UiFont, box: MenuBox): void {
  image.drawRoundedRect(box.x, box.y, box.width, box.height, 60, 8);
  const left = box.x + PREVIEW_PADDING;
  const width = box.width - 2 * PREVIEW_PADDING;
  const bottom = box.y + box.height - PREVIEW_PADDING;
  let y = box.y + PREVIEW_PADDING;
  for (const [index, paragraph] of PREVIEW_PARAGRAPHS.entries()) {
    if (index > 0) y += font.lineHeight >> 1;
    for (const line of wrapText(font, paragraph, width)) {
      if (y + font.lineHeight > bottom) return;
      image.drawText(font, left, y, line, 220);
      y += font.lineHeight;
    }
  }
}

function nearestIndex(values: readonly number[], target: number): number {
  let best = 0;
  for (let index = 1; index < values.length; index++) {
    if (Math.abs(values[index]! - target) < Math.abs(values[best]! - target)) best = index;
  }
  return best;
}
