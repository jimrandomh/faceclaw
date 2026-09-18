import { GrayImage } from "../../../graphics/image";
import { renderIcon } from "../../../graphics/icons";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { truncateText } from "../../../graphics/textwrap";
import { mediaControllerBridge, type MediaControllerState } from "../../../native/media-controller";
import { clamp } from "../../../util/numeric-util";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const ART_SIZE = 96;
/** The idle note: the Music app's icon, at this size and the dimmest shade. */
const IDLE_NOTE_SIZE = 64;
const IDLE_NOTE_VALUE = 20;
let idleNote: GrayImage | null | undefined;

/**
 * The music icon reduced to a single dim shade: every pixel the renderer
 * lit at least half becomes IDLE_NOTE_VALUE, the rest stay transparent
 * (scaling the antialiased original down would quantize its edges away).
 * Built once and kept, so drawImage's content-addressed cache holds.
 */
function idleNoteImage(): GrayImage | null {
  if (idleNote !== undefined) return idleNote;
  const icon = renderIcon("music", IDLE_NOTE_SIZE);
  if (!icon) {
    idleNote = null;
    return null;
  }
  const note = new GrayImage(icon.width, icon.height, 0);
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      if (icon.getPixel(x, y) >= 128) note.setPixel(x, y, IDLE_NOTE_VALUE);
    }
  }
  idleNote = note;
  return note;
}
const ART_X = PAD;
const PROGRESS_BAR_HEIGHT = 5;

/**
 * Now playing: album art, title/artist/album and a progress bar for the
 * active Android media session, the Music app's header at card size. The
 * media bridge runs for the whole session; the widget subscribes and ticks
 * once a second only while something is playing.
 */
export class MusicWidget implements GlanceWidget {
  private media: MediaControllerState = mediaControllerBridge.snapshot();
  private unsubscribe: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private art: GrayImage | null = null;
  private artKey = "";

  start(requestRender: () => void): void {
    this.unsubscribe = mediaControllerBridge.onStateChange((state) => {
      this.media = state;
      if (state.playbackState === "playing" && state.durationMs > 0 && state.positionMs >= 0) {
        this.progressTimer ??= setInterval(requestRender, 1_000);
      } else {
        this.stopProgressTimer();
      }
      requestRender();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopProgressTimer();
  }

  private stopProgressTimer(): void {
    if (this.progressTimer !== null) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  paint(image: GrayImage): void {
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const media = mediaControllerBridge.snapshot();
    this.media = media;
    if (!media.available || (!media.title && !media.artist)) {
      if (!media.accessEnabled) {
        // Actionable, so it stays as text.
        image.drawText(small, PAD, PAD, "Music", 150);
        image.drawText(small, PAD, PAD + small.lineHeight + 6, "Notification access needed", 140);
        return;
      }
      // Nothing playing: a dim note, centred, and nothing else.
      const note = idleNoteImage();
      if (note) image.drawImage(note, ((image.width - note.width) / 2) | 0, ((image.height - note.height) / 2) | 0);
      return;
    }

    const artY = Math.max(PAD, ((image.height - ART_SIZE) / 2) | 0);
    this.drawArt(image, media, artY);

    const textX = ART_X + ART_SIZE + 12;
    const textWidth = image.width - textX - PAD;
    let y = artY;
    image.drawText(medium, textX, y, truncateText(medium, media.title || "Unknown title", textWidth), 230);
    y += medium.lineHeight + 2;
    if (media.artist) {
      image.drawText(small, textX, y, truncateText(small, media.artist, textWidth), 170);
      y += small.lineHeight + 2;
    }
    if (media.album) {
      image.drawText(small, textX, y, truncateText(small, media.album, textWidth), 120);
    }

    // Progress pinned to the art's bottom edge; the state label sits beside it.
    const barY = artY + ART_SIZE - PROGRESS_BAR_HEIGHT;
    const timeY = barY - small.lineHeight - 3;
    const stateLabel = media.playbackState === "playing" ? "" : media.playbackState === "paused" ? "Paused" : media.playbackState;
    if (media.durationMs > 0 && media.positionMs >= 0) {
      const elapsed = formatMediaTime(media.positionMs);
      const duration = formatMediaTime(media.durationMs);
      image.drawText(small, textX, timeY, elapsed, 140);
      image.drawText(small, textX + textWidth - small.measureText(duration), timeY, duration, 140);
      if (stateLabel) {
        image.drawText(small, textX + (((textWidth - small.measureText(stateLabel)) / 2) | 0), timeY, stateLabel, 140);
      }
      image.drawRect(textX, barY, textWidth, PROGRESS_BAR_HEIGHT, 55);
      const progress = clamp(media.positionMs / media.durationMs, 0, 1);
      image.fillRect(textX + 1, barY + 1, Math.round((textWidth - 2) * progress), PROGRESS_BAR_HEIGHT - 2, 170);
    } else if (stateLabel) {
      image.drawText(small, textX, timeY, stateLabel, 140);
    }
  }

  private drawArt(image: GrayImage, media: MediaControllerState, artY: number): void {
    const key = `${media.packageName}|${media.title}|${media.album}`;
    // Retry while null: players often publish metadata before the bitmap.
    if (key !== this.artKey || this.art === null) {
      this.artKey = key;
      this.art = mediaControllerBridge.getAlbumArt(ART_SIZE);
    }
    if (this.art) {
      const dx = ART_X + Math.max(0, ((ART_SIZE - this.art.width) / 2) | 0);
      const dy = artY + Math.max(0, ((ART_SIZE - this.art.height) / 2) | 0);
      image.bitBlt(this.art, dx, dy);
      image.drawRect(dx - 1, dy - 1, this.art.width + 2, this.art.height + 2, 60);
    } else {
      image.drawRect(ART_X, artY, ART_SIZE, ART_SIZE, 60);
      const font = getDefaultSmallFont();
      image.drawText(font, ART_X + Math.round((ART_SIZE - font.measureText("no art")) / 2),
        artY + Math.round((ART_SIZE - font.lineHeight) / 2), "no art", 90);
    }
  }
}

function formatMediaTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
