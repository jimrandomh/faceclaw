/**
 * Getting the watch app onto the user's watch, from the phone app.
 *
 * Only iOS has something to offer (watch-app-install.ios.ts). No phone app can
 * install a watch app itself: what iOS allows is asking whether the paired
 * watch has ours, and sending the user to where the system installs it. The
 * Wear OS app is installed on the watch (wear/README.md), so this Android side
 * always answers "unknown" and the phone UI shows nothing.
 */

/**
 * Where the Faceclaw app stands on the user's watch. On iOS these strings come
 * from FaceclawWatchBridge.m (watchAppInstallState); keep the two in sync.
 */
export type WatchAppInstallState =
  /** No answer: the session isn't up yet, or this phone has no watch support. */
  | "unknown"
  /** No watch is paired with this phone. */
  | "no-watch"
  /** A watch is paired, without the Faceclaw app. */
  | "not-installed"
  | "installed";

/**
 * Where the user installs the watch app: the iPhone's Watch app (its Available
 * Apps list), or for a TestFlight beta the app's page in TestFlight, which is
 * where Apple puts the button.
 */
export type WatchAppInstallSource = "watch-app" | "testflight";

/** What openSourceWhenInFront() did. */
export type WatchAppHandover =
  | "opened"
  /**
   * Faceclaw isn't on the phone's screen, and iOS only lets the app in front
   * open another. It opens when Faceclaw next comes to the front, if that's soon.
   */
  | "waiting"
  /** There is nothing to open, or the phone wouldn't open it. */
  | "failed";

export interface WatchAppInstall {
  getState(): WatchAppInstallState;
  /** Where to install from, or null when this copy of the phone app has no watch app to offer. */
  getSource(): WatchAppInstallSource | null;
  /** Subscribe to getState() changing. */
  onStateChanged(listener: () => void): () => void;
  /** Open what getSource() names. Resolves false when there is none, or it wouldn't open. */
  openSource(): Promise<boolean>;
  /**
   * openSource() for a request made on the glasses, when the phone may be in a
   * pocket: if Faceclaw isn't in front, the opening waits until it is.
   */
  openSourceWhenInFront(): Promise<WatchAppHandover>;
}

export const watchAppInstall: WatchAppInstall = {
  getState: () => "unknown",
  getSource: () => null,
  onStateChanged: () => () => {},
  openSource: () => Promise.resolve(false),
  openSourceWhenInFront: () => Promise.resolve("failed"),
};
