import { GrayImage } from "../../graphics/image";
import { windowIcon } from "./chrome-layer";
import { type IconName } from "../../graphics/icons";
import { toolRegistry, type ToolResult, type ToolSpec } from "../../assistant/tool-registry";
import { appViewportSize, type WindowHeightMode } from "./geometry";
import * as frameTimings from "../../native/frame-timings";
import { shell, type ShellWindow } from "./shell";

/**
 * Messages between the shell (main thread) and an app worker. One worker
 * hosts one app, which may have several windows; messages are routed by
 * windowId. Everything crossing this boundary is small JSON; pixels go
 * worker→Java directly.
 */
export type WorkerAppMessage =
  | { type: "open-window"; windowId: string; surfaceId: string; viewport: { width: number; height: number } }
  | { type: "close-window"; windowId: string }
  | { type: "input"; windowId: string; event: unknown; frameId: number; focused: boolean }
  | { type: "text-input"; windowId: string; text: string }
  | { type: "render"; windowId: string; focused: boolean }
  | { type: "foreground"; windowId: string; foreground: boolean; focused: boolean }
  | { type: "screen"; on: boolean }
  /** Assistant tool invocation aimed at a window; reply with tool-result. */
  | { type: "tool-call"; callId: string; windowId: string; name: string; args: unknown };

export type WorkerAppReply =
  | {
      /**
       * The worker's bundle has evaluated and its onmessage handler is
       * installed. Messages posted to a still-loading worker can be silently
       * dropped, so the host queues everything until this arrives.
       */
      type: "worker-ready";
    }
  | { type: "yield-focus"; windowId: string }
  | {
      /** Foreground and focus one of the app's existing windows. */
      type: "focus-window";
      windowId: string;
    }
  | {
      /**
       * Wake the glasses and focus one of the app's windows (e.g. a terminal
       * bell with wake-on-bell enabled). Ignored unless the screen is off, so
       * it can never steal focus from an in-use screen.
       */
      type: "wake-window";
      windowId: string;
    }
  | {
      /** App-initiated window (e.g. a terminal view opened from the hub list). */
      type: "open-window-request";
      windowId: string;
      title: string;
      iconLetter: string;
      icon?: IconName;
      iconGlyph?: string;
      focus?: boolean;
      /** Window height: the standard 288px band ("min", default) or full screen ("max"). */
      heightMode?: WindowHeightMode;
    }
  | { type: "set-title"; windowId: string; title: string }
  | { type: "set-attention"; windowId: string; attention: boolean }
  | {
      /** Window-menu pick: open the shell's voice dialog aimed at this window. */
      type: "start-voice-input";
      windowId: string;
    }
  | {
      /** Window-menu pick: close this window (the shell owns the close path). */
      type: "close-window-request";
      windowId: string;
    }
  | {
      /** Open or focus the Settings app, optionally jumping to a section. */
      type: "open-settings";
      section?: string;
    }
  | {
      /**
       * Open the phone app's text editor on a string setting (by id, resolved
       * on the main thread). The worker paints its own "type on the phone"
       * UI and watches the setting for changes; it must post
       * end-text-setting-edit when its flow finishes.
       */
      type: "start-text-setting-edit";
      settingId: string;
    }
  | { type: "end-text-setting-edit" }
  | {
      /**
       * Set or clear the app's top-bar tray icon. Pixels ride the JSON
       * postMessage roundtrip — acceptable because tray icons are small and
       * infrequently updated.
       */
      type: "set-tray-icon";
      icon: { width: number; height: number; pixels: number[] } | null;
    }
  | {
      /**
       * Declare (replacing the prior set) the assistant tools this window
       * contributes. Names are unprefixed; the registry adds `app.<appId>.`.
       */
      type: "set-tools";
      windowId: string;
      tools: ToolSpec[];
    }
  | {
      /** Result of a tool-call, matched to the request by callId. */
      type: "tool-result";
      callId: string;
      result: ToolResult;
    };

export type WorkerWindowSpec = {
  /** Unique across the shell; namespace with the appId (e.g. "terminal:view:3"). */
  windowId: string;
  title: string;
  iconLetter: string;
  /** Lucide icon name for the sidebar indicator; falls back to iconLetter. */
  icon?: IconName;
  /** Per-window character variant of `icon` (e.g. ">3" terminal icons). */
  iconGlyph?: string;
  /** Foreground and focus the window once its surface exists. */
  focus?: boolean;
  /** Window height: the standard 288px band ("min", default) or full screen ("max"). */
  heightMode?: WindowHeightMode;
  /**
   * Deliver watch swipes to the worker as swipe-* events instead of the
   * scroll / click / double-click fallback. The worker then owns the meaning
   * of all four directions in every window state (see ShellWindow).
   */
  acceptsDirectional?: boolean;
};

export type WorkerAppHostOptions = {
  appId: string;
  worker: Worker;
  /** Create/refresh a window surface on the compositor (no-op when disconnected). */
  configureSurface: (surfaceId: string, visible: boolean, heightMode: WindowHeightMode) => Promise<void>;
  setSurfaceVisible: (surfaceId: string, visible: boolean) => void;
  removeSurface: (surfaceId: string) => void;
  requestShellRender: () => void;
  /** Open or focus the Settings app, optionally selecting a section. */
  openSettings: (section?: string) => void;
  /** Open the phone app's text editor on a string setting (by id). */
  startTextSettingEdit: (settingId: string) => void;
  /** Close the phone text editor opened by startTextSettingEdit. */
  endTextSettingEdit: () => void;
};

/**
 * Owns the Worker for one app and adapts its windows to the shell's window
 * interface: forwards input and lifecycle over postMessage, relays worker
 * requests (yield-focus, new windows, attention flags) back to the shell,
 * and manages compositor surfaces for the app's windows. The worker submits
 * frames straight to the Java compositor, so no pixels cross this boundary.
 */
/** A tool-call awaiting its worker reply; also its own leak-safety timeout. */
type PendingToolCall = {
  windowId: string;
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * How long the host waits for a worker's tool-result before giving up. The
 * registry applies its own (usually shorter) per-tool timeout; this is the
 * backstop that also frees the pending-call entry if the worker never replies.
 */
const TOOL_CALL_HOST_TIMEOUT_MS = 15_000;

export class WorkerAppHost {
  private readonly openWindows = new Set<string>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private nextCallSerial = 1;
  /**
   * Messages posted before the worker finishes evaluating its bundle can be
   * silently dropped (notably the launch-time foreground/render pair, leaving
   * a black window until the first input). Queue everything until the worker
   * posts worker-ready, then flush in order.
   */
  private workerReady = false;
  private readonly queuedMessages: WorkerAppMessage[] = [];

  constructor(private readonly options: WorkerAppHostOptions) {
    options.worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerAppReply | undefined;
      if (!message) return;
      switch (message.type) {
        case "worker-ready":
          this.workerReady = true;
          for (const queued of this.queuedMessages.splice(0)) {
            this.options.worker.postMessage(queued);
          }
          break;
        case "yield-focus":
          // Only the focused window's yield is meaningful.
          if (shell.foregroundWindow()?.windowId === message.windowId) {
            shell.yieldFocusToSidebar();
          }
          break;
        case "focus-window":
          if (this.openWindows.has(message.windowId)) {
            shell.focusWindow(message.windowId);
            this.options.requestShellRender();
          }
          break;
        case "wake-window":
          if (this.openWindows.has(message.windowId) && !shell.isScreenOn()) {
            // Focus first so wake's foreground-window refresh hits the target.
            shell.focusWindow(message.windowId);
            shell.wake("window");
            this.options.requestShellRender();
          }
          break;
        case "open-window-request":
          this.openWindow({
            windowId: message.windowId,
            title: message.title,
            iconLetter: message.iconLetter,
            icon: message.icon,
            iconGlyph: message.iconGlyph,
            focus: message.focus,
            heightMode: message.heightMode,
          });
          break;
        case "set-attention":
          shell.setWindowAttention(message.windowId, message.attention);
          break;
        case "start-voice-input":
          // Menus only open on the focused window, but re-check foreground:
          // the reply crosses a thread boundary and focus may have moved.
          if (shell.foregroundWindow()?.windowId === message.windowId) {
            shell.startVoiceInput();
          }
          break;
        case "close-window-request":
          if (this.openWindows.has(message.windowId)) {
            shell.closeWindow(message.windowId);
            this.options.requestShellRender();
          }
          break;
        case "open-settings":
          this.options.openSettings(message.section);
          break;
        case "start-text-setting-edit":
          this.options.startTextSettingEdit(message.settingId);
          break;
        case "end-text-setting-edit":
          this.options.endTextSettingEdit();
          break;
        case "set-tray-icon": {
          let icon: GrayImage | null = null;
          if (message.icon) {
            icon = new GrayImage(message.icon.width, message.icon.height, 0);
            icon.pixels.set(message.icon.pixels.slice(0, icon.pixels.length));
          }
          shell.setTrayIcon(this.options.appId, icon);
          break;
        }
        case "set-title":
          // Titles are informational for now (sidebar shows icons only).
          break;
        case "set-tools":
          // Only a window we actually have open may contribute tools.
          if (this.openWindows.has(message.windowId)) {
            toolRegistry.setAppTools({
              windowId: message.windowId,
              appId: this.options.appId,
              specs: message.tools,
              invoke: (toolName, args) => this.callWindowTool(message.windowId, toolName, args),
              isForeground: () => shell.foregroundWindow()?.windowId === message.windowId,
            });
          }
          break;
        case "tool-result": {
          const pending = this.pendingToolCalls.get(message.callId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingToolCalls.delete(message.callId);
            pending.resolve(message.result);
          }
          break;
        }
      }
    };
    options.worker.onerror = (error) => {
      console.error(`worker app ${options.appId} error: ${JSON.stringify(error)}`);
    };
  }

  windowCount(): number {
    return this.openWindows.size;
  }

  /** Open a window of this app and register it with the shell. */
  openWindow(spec: WorkerWindowSpec): ShellWindow {
    const surfaceId = `window:${spec.windowId}`;
    const heightMode = spec.heightMode ?? "min";
    this.openWindows.add(spec.windowId);
    this.post({
      type: "open-window",
      windowId: spec.windowId,
      surfaceId,
      viewport: appViewportSize(heightMode),
    });
    const window: ShellWindow = {
      appId: this.options.appId,
      windowId: spec.windowId,
      title: spec.title,
      surfaceId,
      closeable: true,
      acceptsDirectional: spec.acceptsDirectional,
      heightMode,
      close: () => {
        this.openWindows.delete(spec.windowId);
        // Withdraw this window's tools and fail any in-flight calls to it.
        toolRegistry.removeAppTools(spec.windowId);
        this.failPendingToolCallsFor(spec.windowId);
        this.post({ type: "close-window", windowId: spec.windowId });
        this.options.removeSurface(surfaceId);
      },
      drawIcon: windowIcon(spec.icon, spec.iconLetter, spec.iconGlyph),
      handleInput: (event, frameId) => {
        frameTimings.logFrame(frameId, `input posted to the ${this.options.appId} worker`);
        this.post({
          type: "input",
          windowId: spec.windowId,
          event,
          frameId,
          focused: shell.isWindowFocused(spec.windowId),
        });
      },
      requestRender: () => {
        this.post({ type: "render", windowId: spec.windowId, focused: shell.isWindowFocused(spec.windowId) });
      },
      receiveTextInput: (text) => {
        this.post({ type: "text-input", windowId: spec.windowId, text });
      },
      setForeground: (foreground) => {
        this.options.setSurfaceVisible(surfaceId, foreground);
        if (foreground) {
          shell.setWindowAttention(spec.windowId, false);
        }
        this.post({
          type: "foreground",
          windowId: spec.windowId,
          foreground,
          focused: shell.isWindowFocused(spec.windowId),
        });
      },
      setScreenOn: (on) => {
        // Screen state is per-app, but sending per-window keeps the protocol
        // uniform; the worker treats it globally.
        this.post({ type: "screen", on });
      },
    };
    shell.registerWindow(window);
    // Configure the surface before any foregrounding so the worker's first
    // frame has somewhere to land.
    void this.options
      .configureSurface(surfaceId, false, heightMode)
      .then(() => {
        if (spec.focus) {
          shell.focusWindow(spec.windowId);
        }
        this.options.requestShellRender();
      })
      .catch((error) => {
        console.error(`surface setup for ${spec.windowId} failed: ${error}`);
      });
    return window;
  }

  /**
   * Post a tool-call to the worker and resolve when its tool-result comes back.
   * Resolves with a tool error on timeout so a hung worker yields a tool error
   * rather than a stuck assistant turn.
   */
  private callWindowTool(windowId: string, toolName: string, args: unknown): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const callId = `${this.options.appId}:${this.nextCallSerial++}`;
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        resolve({ ok: false, error: `App ${this.options.appId} did not respond to ${toolName}` });
      }, TOOL_CALL_HOST_TIMEOUT_MS);
      this.pendingToolCalls.set(callId, { windowId, resolve, timer });
      this.post({ type: "tool-call", callId, windowId, name: toolName, args });
    });
  }

  private failPendingToolCallsFor(windowId: string): void {
    for (const [callId, pending] of this.pendingToolCalls) {
      if (pending.windowId !== windowId) continue;
      clearTimeout(pending.timer);
      this.pendingToolCalls.delete(callId);
      pending.resolve({ ok: false, error: "The target window was closed" });
    }
  }

  private post(message: WorkerAppMessage): void {
    if (!this.workerReady) {
      this.queuedMessages.push(message);
      return;
    }
    this.options.worker.postMessage(message);
  }
}
