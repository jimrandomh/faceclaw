import { GrayImage } from "../graphics/image";
import { screenHeight, screenWidth } from "../graphics/screen-size";
import { getDefaultMediumFont } from "../graphics/ui-fonts";
import { wrapText } from "../graphics/textwrap";

export const LOCK_SCREEN_SURFACE_ID = "lock-screen";
const LOCK_SCREEN_MESSAGE = "Glasses locked; unlock the phone to unlock the glasses.";

/** The paired glasses' whole screen, black, with the message in a box at its centre. */
export function createLockScreenImage(): GrayImage {
  const width = screenWidth(), height = screenHeight();
  const image = new GrayImage(width, height, 0);
  const font = getDefaultMediumFont();
  const boxWidth = 480;
  const boxHeight = 150;
  const boxX = Math.round((width - boxWidth) / 2);
  const boxY = Math.round((height - boxHeight) / 2);
  image.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, 150, 12);
  const lines = wrapText(font, LOCK_SCREEN_MESSAGE, boxWidth - 64);
  const textHeight = lines.length * font.lineHeight;
  const firstY = boxY + Math.round((boxHeight - textHeight) / 2);
  lines.forEach((line, index) => {
    const x = Math.round((width - font.measureText(line)) / 2);
    image.drawText(font, x, firstY + index * font.lineHeight, line, 230);
  });
  return image;
}
