import { GrayImage } from "../../graphics/image";

/** The demo player's library: invented albums, with generated cover art and no actual audio. */
export type DemoTrack = { id: number; title: string; artist: string; album: string; durationMs: number; coverSeed: number };

function album(name: string, artist: string, coverSeed: number, firstId: number, tracks: [string, number][]): DemoTrack[] {
  return tracks.map(([title, seconds], index) => ({ id: firstId + index, title, artist, album: name, durationMs: seconds * 1000, coverSeed }));
}

export const DEMO_ALBUMS: readonly { name: string; artist: string; tracks: DemoTrack[] }[] = [
  { name: "Afterglow Transit", artist: "The Lantern Society", tracks: album("Afterglow Transit", "The Lantern Society", 1, 1, [
    ["Last Train to Morning", 214], ["Platform Nine", 187], ["Sodium Lights", 243], ["Quiet Car", 198], ["Terminus", 305],
  ]) },
  { name: "Low Tide Radio", artist: "Mara Quill", tracks: album("Low Tide Radio", "Mara Quill", 2, 6, [
    ["Static on the Shore", 231], ["Harbor Signal", 176], ["Salt Air", 208], ["Long Wave", 264],
  ]) },
  { name: "Paper Satellites", artist: "North Fold", tracks: album("Paper Satellites", "North Fold", 3, 10, [
    ["Origami Orbit", 192], ["Apogee", 245], ["Slow Reentry", 219],
  ]) },
];

export const DEMO_TRACKS: readonly DemoTrack[] = DEMO_ALBUMS.flatMap((entry) => entry.tracks);

const coverCache = new Map<string, GrayImage>();

/** Procedural cover art, so no image rights are involved: three kinds of interference pattern. */
export function demoCoverArt(seed: number, maxSize: number): GrayImage {
  const size = Math.max(16, Math.min(maxSize, 200));
  const key = `${seed}:${size}`;
  const cached = coverCache.get(key);
  if (cached) return cached;
  const image = new GrayImage(size, size, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5, ny = y / size - 0.5;
      const radius = Math.hypot(nx, ny);
      let value: number;
      if (seed === 1) value = 0.5 + 0.5 * Math.sin(radius * 46 - Math.atan2(ny, nx) * 3);
      else if (seed === 2) value = 0.5 + 0.5 * Math.sin((ny + 0.09 * Math.sin(nx * 14)) * 58);
      else value = 0.5 + 0.5 * Math.cos(nx * 40) * Math.cos(ny * 40 + radius * 12);
      const vignette = Math.max(0, 1 - radius * 1.2);
      image.pixels[y * size + x] = Math.round(16 * Math.floor(value * vignette * 15.99)) || 1;
    }
  }
  coverCache.set(key, image);
  return image;
}
