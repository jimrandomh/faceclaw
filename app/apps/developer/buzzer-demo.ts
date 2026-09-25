import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
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
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, "Buzzer demo", 220);
    const status = this.playing ? `Playing: ${this.playing}` : `${GESTURE_CLICK} play`;
    image.drawText(font, width - 24 - font.measureText(status), 8, status, 140);

    const listHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT;
    this.menu.paint(
      image,
      { x: LIST_X - 6, y: HEADER_HEIGHT - 1, width: width - 2 * LIST_X + 12, height: listHeight },
      ctx.stack.isFocused(),
    );

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
  image.drawText(font, x + 6, textY, effect.name, selected ? 255 : 200);
  image.drawText(font, x + 6 + 110, textY, effect.desc, selected ? 180 : 120);
}
