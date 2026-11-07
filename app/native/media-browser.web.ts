import { DEMO_ALBUMS } from "../web/demo-data/music";
import { DEMO_PLAYER_NAME, DEMO_PLAYER_PACKAGE, mediaControllerBridge } from "./media-controller";
import type { MediaBrowseItem, MediaBrowserApp, MediaBrowserBridge } from "./media-types";

export type { MediaBrowseItem, MediaBrowserApp } from "./media-types";

const APP: MediaBrowserApp = { packageName: DEMO_PLAYER_PACKAGE, serviceClass: "", appName: DEMO_PLAYER_NAME };

class DemoMediaBrowser implements MediaBrowserBridge {
  listBrowsableApps(): MediaBrowserApp[] { return [APP]; }
  async connect(_app: MediaBrowserApp): Promise<string> { return "root"; }

  async browse(parentId: string): Promise<MediaBrowseItem[]> {
    if (parentId === "root") {
      return DEMO_ALBUMS.map((album) => ({ mediaId: `album:${album.name}`, title: album.name, subtitle: album.artist, browsable: true, playable: false }));
    }
    const album = DEMO_ALBUMS.find((entry) => `album:${entry.name}` === parentId);
    return (album?.tracks ?? []).map((track) => ({ mediaId: `track:${track.id}`, title: track.title, subtitle: track.artist, browsable: false, playable: true }));
  }

  playFromMediaId(mediaId: string): void {
    if (mediaId.startsWith("track:")) mediaControllerBridge.playTrack(Number(mediaId.slice(6)));
  }

  disconnect(): void {}
}

export const mediaBrowserBridge: MediaBrowserBridge = new DemoMediaBrowser();
