import type { GrayImage } from "../../graphics/image";

/** The arrow, tip at its top left: '#' is the outline, '.' the fill. */
const CURSOR = [
  "#",
  "##",
  "#.#",
  "#..#",
  "#...#",
  "#....#",
  "#.....#",
  "#......#",
  "#.......#",
  "#........#",
  "#.....#####",
  "#..#..#",
  "#.# #..#",
  "##  #..#",
  "#    #..#",
  "     #..#",
  "      ##",
];

export const POINTER_CURSOR_WIDTH = Math.max(...CURSOR.map((row) => row.length));
export const POINTER_CURSOR_HEIGHT = CURSOR.length;

export function paintPointerCursor(image: GrayImage, x: number, y: number, pressed = false): void {
  for (const [row, pixels] of CURSOR.entries()) {
    for (let col = 0; col < pixels.length; col++) {
      const pixel = pixels[col];
      if (pixel === " ") continue;
      image.setPixel(x + col, y + row, pixel === "#" ? 255 : pressed ? 175 : 70);
    }
  }
}
