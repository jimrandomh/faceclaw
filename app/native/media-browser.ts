import { Utils } from "@nativescript/core";
import { ignoredMediaPackages, isMediaAppEnabled, MEDIA_APPS_KEY, rememberMediaApps } from "./media-apps";
import { onSettingsStoreChanged } from "./settings-store";

declare const com: any;

export type MediaBrowserApp = {
  packageName: string;
  serviceClass: string;
  appName: string;
};

export type MediaBrowseItem = {
  mediaId: string;
  title: string;
  subtitle: string;
  browsable: boolean;
  playable: boolean;
};

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

/**
 * Bridge to FaceclawMediaBrowser: connects to other apps' media browser
 * services (the mechanism Android Auto uses) to browse their libraries and
 * start playback, including starting a player that is not currently running.
 * Holds at most one connection at a time.
 */
export class FaceclawMediaBrowserBridge {
  private browser: any | null = null;
  private listenerProxy: any | null = null;
  private nextRequestId = 1;
  private readonly pendingConnects = new Map<number, PendingRequest<string>>();
  private readonly pendingBrowses = new Map<number, PendingRequest<MediaBrowseItem[]>>();
  private appsCache: MediaBrowserApp[] | null = null;
  private connectedPackage = "";

  /** Installed apps exposing a media browser service; cached after the first call. */
  listBrowsableApps(refresh = false): MediaBrowserApp[] {
    if (!global.isAndroid) return [];
    if (this.appsCache && !refresh) return this.enabledApps();
    this.ensureBrowser();
    if (!this.browser) return [];
    try {
      const raw = JSON.parse(String(this.browser.listBrowsableAppsJson())) as Array<{
        packageName?: string;
        serviceClass?: string;
        appName?: string;
      }>;
      this.appsCache = raw.map((app) => ({
        packageName: String(app.packageName ?? ""),
        serviceClass: String(app.serviceClass ?? ""),
        appName: String(app.appName ?? ""),
      }));
      rememberMediaApps(this.appsCache);
    } catch (error) {
      console.warn(`media browser app list parse failed: ${error}`);
      this.appsCache = [];
    }
    return this.enabledApps();
  }

  private enabledApps(): MediaBrowserApp[] {
    const ignored = new Set(ignoredMediaPackages());
    return (this.appsCache ?? []).filter((app) => !ignored.has(app.packageName));
  }

  /**
   * Connect to an app's browser service, starting its process if needed;
   * replaces any existing connection. Resolves to the browse-tree root id.
   */
  connect(app: MediaBrowserApp): Promise<string> {
    if (!global.isAndroid) return Promise.reject(new Error("Android only"));
    if (!isMediaAppEnabled(app.packageName)) return Promise.reject(new Error("App is ignored in Music settings"));
    this.ensureBrowser();
    if (!this.browser) return Promise.reject(new Error("Media browser unavailable"));
    const requestId = this.nextRequestId++;
    this.connectedPackage = app.packageName;
    return new Promise<string>((resolve, reject) => {
      this.pendingConnects.set(requestId, { resolve, reject });
      this.browser.connect(requestId, app.packageName, app.serviceClass);
    });
  }

  /** Fetch one level of the connected service's content tree. */
  browse(parentId: string): Promise<MediaBrowseItem[]> {
    if (!global.isAndroid) return Promise.reject(new Error("Android only"));
    if (this.connectedPackage && !isMediaAppEnabled(this.connectedPackage)) {
      this.disconnect();
      return Promise.reject(new Error("App is ignored in Music settings"));
    }
    this.ensureBrowser();
    if (!this.browser) return Promise.reject(new Error("Media browser unavailable"));
    const requestId = this.nextRequestId++;
    return new Promise<MediaBrowseItem[]>((resolve, reject) => {
      this.pendingBrowses.set(requestId, { resolve, reject });
      this.browser.browse(requestId, parentId);
    });
  }

  /** Start playback of a browsed item through the connected player's session. */
  playFromMediaId(mediaId: string): void {
    if (!global.isAndroid) return;
    if (!this.connectedPackage || !isMediaAppEnabled(this.connectedPackage)) return;
    this.browser?.playFromMediaId(mediaId);
  }

  /** Drop the connection; in-flight requests are rejected. */
  disconnect(): void {
    if (!global.isAndroid) return;
    this.rejectAllPending("Disconnected");
    this.connectedPackage = "";
    this.browser?.disconnect();
  }

  private rejectAllPending(reason: string): void {
    const pending = [...this.pendingConnects.values(), ...this.pendingBrowses.values()];
    this.pendingConnects.clear();
    this.pendingBrowses.clear();
    for (const request of pending) {
      request.reject(new Error(reason));
    }
  }

  private ensureBrowser(): void {
    if (!global.isAndroid || this.browser) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.browser = new com.faceclaw.app.FaceclawMediaBrowser(context);
    onSettingsStoreChanged((key) => {
      if (key === MEDIA_APPS_KEY && this.connectedPackage && !isMediaAppEnabled(this.connectedPackage)) {
        this.disconnect();
      }
    });
    this.listenerProxy = new com.faceclaw.app.FaceclawMediaBrowserListener({
      onConnectResult: (requestId: number, connected: boolean, rootId: string, error: string) => {
        const pending = this.pendingConnects.get(Number(requestId));
        if (!pending) return;
        this.pendingConnects.delete(Number(requestId));
        if (connected) pending.resolve(String(rootId));
        else pending.reject(new Error(String(error) || "Connection failed"));
      },
      onBrowseResult: (requestId: number, childrenJson: string, error: string) => {
        const pending = this.pendingBrowses.get(Number(requestId));
        if (!pending) return;
        this.pendingBrowses.delete(Number(requestId));
        const json = String(childrenJson ?? "");
        if (!json) {
          pending.reject(new Error(String(error) || "Browse failed"));
          return;
        }
        try {
          const raw = JSON.parse(json) as Array<{
            mediaId?: string;
            title?: string;
            subtitle?: string;
            browsable?: boolean;
            playable?: boolean;
          }>;
          pending.resolve(
            raw.map((item) => ({
              mediaId: String(item.mediaId ?? ""),
              title: String(item.title ?? ""),
              subtitle: String(item.subtitle ?? ""),
              browsable: Boolean(item.browsable),
              playable: Boolean(item.playable),
            })),
          );
        } catch (parseError) {
          pending.reject(new Error(`Browse result parse failed: ${parseError}`));
        }
      },
      onDisconnected: () => {
        this.rejectAllPending("Connection lost");
      },
    });
    this.browser.setListener(this.listenerProxy);
  }
}

export const mediaBrowserBridge = new FaceclawMediaBrowserBridge();
