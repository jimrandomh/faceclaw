import { type GrayImage } from "../graphics/image";
import { type Plane } from "../graphics/plane";
import { type IconName } from "../graphics/icons";
import { type LayerActions } from "../ui/layers";
import { type InProcessAppOptions, type InProcessWindow } from "../ui/shell/in-process-window";
import { WorkerAppHost } from "../ui/shell/worker-window";
import { shell } from "../ui/shell/shell";

/**
 * An app, as seen from outside while it isn't running. Each app directory's
 * index.ts default-exports one of these, and all-apps.ts collects them; the
 * controller and shell reach apps only through this surface. Meant to grow
 * into the sole export of an app package (the boundary for sandboxing and
 * dynamic loading).
 */
export type AppDefinition = {
  appId: string;
  /** Launcher-grid and window-title label. */
  title: string;
  /** Launcher-grid icon. */
  icon: IconName;
  /** App-supplied launcher icon renderer; icon remains the fallback. */
  renderIcon?: (size: number) => GrayImage | null;
  /** Open the app's window (or focus it if already open). */
  launch: (ctx: AppContext, params?: AppLaunchParams) => Promise<void>;
  /**
   * Runs once at shell startup, before any launch. For apps that must exist
   * from boot (the launcher registers its pinned window here).
   */
  boot?: (ctx: AppContext) => void;
  /** False for apps that must not appear in the launcher grid (the launcher itself). */
  showInLauncher?: boolean;
  /** Present on the app that handles text shared via the Android share intent. */
  openSharedText?: (ctx: AppContext, title: string, text: string) => void;
};

export type AppLaunchParams = {
  /** Settings-app section deep-link (window menu -> Settings). */
  section?: string;
};

/**
 * Shell/controller services available to an app's launch and boot callbacks,
 * bound to that app's id. This is deliberately the only channel from app
 * definitions back into the controller.
 */
export type AppContext = {
  /** The id of the app this context was built for. */
  appId: string;
  /** Every app, in launcher-grid order. */
  apps: readonly AppDefinition[];
  /** Shared layer actions (voice capture, text-setting edits, buzzer, ...). */
  actions: Omit<LayerActions, "requestRender">;
  /** Launch (or focus) any app by id through the shell. */
  launchApp: (appId: string, params?: AppLaunchParams) => Promise<void>;
  /** Uninstall a dynamically registered app, if the app id supports it. */
  uninstallApp: (appId: string) => Promise<void>;
  /** Launch-or-focus a main-thread singleton window keyed by windowId. */
  launchInProcessApp: (
    windowId: string,
    surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow,
  ) => Promise<void>;
  /** Get this app's shared worker host, spawning the worker on first use. */
  ensureWorkerHost: (createWorker: () => Worker) => WorkerAppHost;
  /** Submit a window surface's painted frame, as planes (windows created outside launchInProcessApp). */
  submitWindowFrame: (surfaceId: string, planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  setWindowSurfaceVisible: (surfaceId: string, visible: boolean) => void;
  requestShellRender: () => void;
  appendLog: (message: string) => void;
  /**
   * Register (or clear, with null) the window hosting the on-glasses
   * text-setting editor, so the controller can sync it with the phone-side
   * editor field.
   */
  setTextEditorHost: (host: TextEditorHost | null) => void;
};

/** See AppContext.setTextEditorHost. */
export type TextEditorHost = {
  /** Whether the glasses-side text-setting editor is the top layer. */
  isTextEditorOnTop: () => boolean;
  /** Pop the text-setting editor if it is on top; returns whether it was. */
  closeTextEditor: () => boolean;
  requestRender: () => void;
};

/**
 * Launch-or-focus flow shared by the worker-hosted apps: focus the app's
 * existing window if one is open, otherwise open a window in the app's shared
 * worker (spawned on first launch).
 */
export async function launchWorkerAppWindow(
  ctx: AppContext,
  options: {
    /** Must construct the worker with a string-literal path (webpack worker loader). */
    createWorker: () => Worker;
    windowId: string;
    title: string;
    iconLetter: string;
    icon: IconName;
    /**
     * Which existing window counts as "already launched": any window of this
     * app (default), or only options.windowId exactly (multi-window apps like
     * the terminal, where launching should reopen the hub even while other
     * windows are open).
     */
    matchExistingBy?: "appId" | "windowId";
    /** Deliver watch swipes raw instead of the fallback (see WorkerWindowSpec). */
    acceptsDirectional?: boolean;
  },
): Promise<void> {
  const existing = shell
    .getWindows()
    .find((window) =>
      options.matchExistingBy === "windowId" ? window.windowId === options.windowId : window.appId === ctx.appId,
    );
  if (existing) {
    shell.focusWindow(existing.windowId);
    ctx.requestShellRender();
    return;
  }
  const host = ctx.ensureWorkerHost(options.createWorker);
  host.openWindow({
    windowId: options.windowId,
    title: options.title,
    iconLetter: options.iconLetter,
    icon: options.icon,
    focus: true,
    acceptsDirectional: options.acceptsDirectional,
  });
  ctx.appendLog(`launched ${options.windowId}`);
}
