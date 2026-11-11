import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { centeredTextY, tightRowHeight } from "../../ui/metrics";
import {
  buildSoundSequencePayload,
  CFW_SEQ_MAX,
  effectPhrases,
  phraseDurationMs,
  SOUND_EFFECTS,
  type SoundEffect,
} from "../../ui/sound-effects";

/** The title band: the list starts this far below the top edge's padding. */
const HEADER_HEIGHT = 22;
/** Horizontal inset of a row's text from its highlight box; the title lines up with it. */
const ROW_TEXT_INSET = 6;
/** The status text ends this far short of the rows' right edge. */
const STATUS_INSET = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Buzzer demo: pick a sound effect from the catalog and play it on the
 * glasses' piezo. Multi-phrase effects are paced phrase-by-phrase so each
 * sequencer message lands as the previous phrase finishes.
 */
export class BuzzerDemoLayer implements Layer {
  private readonly menu = new Menu<SoundEffect>({
    items: SOUND_EFFECTS,
    wrap: false,
    rowGap: 1,
    highlight: { radius: 4 },
    getHeight: () => tightRowHeight(getDefaultSmallFont()),
    draw: (args) => drawEffectRow(args),
  });
  private playing: string | null = null;

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, padding.left + ROW_TEXT_INSET, padding.top, "Buzzer demo", 220);
    const status = this.playing ? `Playing: ${this.playing}` : `${GESTURE_CLICK} play`;
    image.drawText(font, width - padding.right - STATUS_INSET - font.measureText(status), padding.top, status, 140);

    // The title line stays put, so the list starts right under it with no
    // padding of its own there. It scrolls, so it runs to the window's
    // bottom edge with the padding suggested for that edge inside it, after
    // the last row.
    const listTop = padding.top + HEADER_HEIGHT - 1;
    if (height > listTop) {
      this.menu.paint(
        image,
        { x: padding.left, y: listTop, width: Math.max(0, width - padding.left - padding.right), height: height - listTop,
          padTop: 0, padBottom: padding.bottom },
        ctx.stack.isFocused(),
      );
    }

    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        await this.menu.handleInput(event);
        return;
      case "click": {
        const effect = this.menu.selectedItem;
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

/** Effect name, then its description in a second column 110px to the right. */
function drawEffectRow({ image, item: effect, x, y, height, selected }: MenuDrawArgs<SoundEffect>): void {
  const font = getDefaultSmallFont();
  const textY = centeredTextY(font, y, height);
  image.drawText(font, x + ROW_TEXT_INSET, textY, effect.name, selected ? 255 : 200);
  image.drawText(font, x + ROW_TEXT_INSET + 110, textY, effect.desc, selected ? 180 : 120);
}
