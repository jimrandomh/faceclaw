import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { drawSelectionHighlight, scrollToKeepSelectionVisible } from "../../ui/menu";
import { tightRowHeight } from "../../ui/metrics";
import {
  buildSoundSequencePayload,
  CFW_SEQ_MAX,
  effectPhrases,
  phraseDurationMs,
  SOUND_EFFECTS,
  type SoundEffect,
} from "../../ui/sound-effects";

const HEADER_HEIGHT = 30;
const LIST_X = 20;
const FOOTER_HEIGHT = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Buzzer demo: pick a sound effect from the catalog and play it on the
 * glasses' piezo. Multi-phrase effects are paced phrase-by-phrase so each
 * sequencer message lands as the previous phrase finishes.
 */
export class BuzzerDemoLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;
  private playing: string | null = null;

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, "Buzzer demo", 220);
    const status = this.playing ? `Playing: ${this.playing}` : `${GESTURE_CLICK} play`;
    image.drawText(font, width - 24 - font.measureText(status), 8, status, 140);

    const listHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT;
    const rowH = tightRowHeight(font);
    const visibleRows = Math.max(1, (listHeight / rowH) | 0);
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedIndex, visibleRows, SOUND_EFFECTS.length);

    const lastVisible = Math.min(SOUND_EFFECTS.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < lastVisible; index++) {
      const effect = SOUND_EFFECTS[index]!;
      const y = HEADER_HEIGHT + (index - this.scrollRow) * rowH;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, LIST_X - 6, y - 1, width - 2 * LIST_X + 12, rowH - 1, ctx.stack.isFocused(), 4);
      }
      image.drawText(font, LIST_X, y + 1, effect.name, selected ? 255 : 200);
      image.drawText(font, LIST_X + 110, y + 1, effect.desc, selected ? 180 : 120);
    }

    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(SOUND_EFFECTS.length - 1, this.selectedIndex + 1);
        return;
      case "click": {
        const effect = SOUND_EFFECTS[clamp(this.selectedIndex, 0, SOUND_EFFECTS.length - 1)];
        if (effect && !this.playing) {
          // Fire-and-forget: playback paces itself with sleeps between
          // phrases; awaiting it here would stall input for seconds.
          void this.playEffect(effect, ctx.actions).catch((error) => {
            console.warn(`buzzer effect failed: ${error}`);
          });
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

  private async playEffect(effect: SoundEffect, actions: LayerActions): Promise<void> {
    this.playing = effect.name;
    actions.requestRender();
    try {
      for (const phrase of effectPhrases(effect.make())) {
        // Safety net: chop any over-long phrase into <=48-step messages.
        for (let index = 0; index < phrase.length; index += CFW_SEQ_MAX) {
          const chunk = phrase.slice(index, index + CFW_SEQ_MAX);
          await actions.playBuzzerSequence(buildSoundSequencePayload(chunk));
          await sleep(phraseDurationMs(chunk));
        }
      }
    } finally {
      this.playing = null;
      actions.requestRender();
    }
  }
}
