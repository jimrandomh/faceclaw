import {
  APPLE_MUSIC_APP_NAME,
  APPLE_MUSIC_PACKAGE,
  parseMediaBrowseItems,
  type MediaBrowseItem,
  type MediaBrowserApp,
  type MediaBrowserBridge,
} from "./media-types";

export type { MediaBrowseItem, MediaBrowserApp } from "./media-types";

declare const FaceclawAppleMusic: any;

const APPLE_MUSIC_APP: MediaBrowserApp = { packageName: APPLE_MUSIC_PACKAGE, serviceClass: "", appName: APPLE_MUSIC_APP_NAME };

/**
 * The Apple Music library (playlists, artists, albums, songs in the
 * on-device / iCloud music library) as a browse tree, through
 * FaceclawAppleMusic's MediaPlayer queries. Playing an item queues its
 * collection on the system Music player.
 */
export class AppleMusicBrowserBridge implements MediaBrowserBridge {
  private connected = false;
  /** Bumped on every connect/disconnect; answers to older requests are dropped. */
  private generation = 0;

  listBrowsableApps(): MediaBrowserApp[] {
    return FaceclawAppleMusic.shared().hasPermission() ? [APPLE_MUSIC_APP] : [];
  }

  connect(app: MediaBrowserApp): Promise<string> {
    this.disconnect();
    if (app.packageName !== APPLE_MUSIC_PACKAGE) return Promise.reject(new Error("Only Apple Music can be browsed on iOS"));
    if (!FaceclawAppleMusic.shared().hasPermission()) return Promise.reject(new Error("Apple Music access is not allowed"));
    this.connected = true;
    return Promise.resolve("root");
  }

  browse(parentId: string): Promise<MediaBrowseItem[]> {
    if (!this.connected) return Promise.reject(new Error("Not connected"));
    const generation = this.generation;
    return new Promise<MediaBrowseItem[]>((resolve, reject) => {
      FaceclawAppleMusic.shared().browseCompletion(parentId, (json: string | null, error: string | null) => {
        if (generation !== this.generation) reject(new Error("Disconnected"));
        else if (error || json == null) reject(new Error(String(error || "Browse failed")));
        else {
          try {
            resolve(parseMediaBrowseItems(String(json)));
          } catch (parseError) {
            reject(new Error(`Browse result parse failed: ${parseError}`));
          }
        }
      });
    });
  }

  playFromMediaId(mediaId: string): void {
    if (!this.connected) return;
    FaceclawAppleMusic.shared().playCompletion(mediaId, (error: string | null) => {
      if (error) console.warn(`[apple-music] play ${mediaId} failed: ${error}`);
    });
  }

  disconnect(): void {
    this.connected = false;
    this.generation++;
  }
}

export const mediaBrowserBridge: MediaBrowserBridge = new AppleMusicBrowserBridge();
