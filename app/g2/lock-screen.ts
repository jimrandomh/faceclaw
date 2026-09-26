import { GrayImage, G2_LENS_WIDTH, G2_LENS_HEIGHT } from "../graphics/image";
import { getDefaultMediumFont } from "../graphics/ui-fonts";
import { wrapText } from "../graphics/textwrap";

export const LOCK_SCREEN_SURFACE_ID = "lock-screen";
const LOCK_SCREEN_MESSAGE = "Glasses locked; unlock the phone to unlock the glasses.";

export function createLockScreenImage(): GrayImage {
  const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  const font = getDefaultMediumFont();
  const boxWidth = 480;
  const boxHeight = 150;
  const boxX = Math.round((G2_LENS_WIDTH - boxWidth) / 2);
  const boxY = Math.round((G2_LENS_HEIGHT - boxHeight) / 2);
  image.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, 150, 12);
  const lines = wrapText(font, LOCK_SCREEN_MESSAGE, boxWidth - 64);
  const textHeight = lines.length * font.lineHeight;
  const firstY = boxY + Math.round((boxHeight - textHeight) / 2);
  lines.forEach((line, index) => {
    const x = Math.round((G2_LENS_WIDTH - font.measureText(line)) / 2);
    image.drawText(font, x, firstY + index * font.lineHeight, line, 230);
  });
  return image;
}
