import { wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { AMBIENT_CARD_TEXT_WIDTH, AMBIENT_MAX_LINES_PER_CARD, postAmbientCard } from "../../ui/shell/ambient-cards";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { transcriptTimestamp } from "../transcribe/transcribe";
import { MIC_ICON } from "../transcribe/transcribe-app";
import { AsideLayer } from "./aside";
import { type Cue } from "./aside-session";
import { asideCueTtlMs, asideWakeDisplaySetting } from "./aside-settings";

export const ASIDE_WINDOW_ID = "aside";
export const ASIDE_SURFACE_ID = "window:aside";

const TRAY_ICON_ID = "aside";

export type AsideAppOptions = InProcessAppOptions & {
  /** Begin continuous mic capture (kept on until paused or closed). */
  startContinuousVoiceCapture: () => void;
  stopContinuousVoiceCapture: () => void;
  requestShellRender: () => void;
};

/** Show a cue over whatever app is in front, wrapped to fit an ambient card. */
function postCueCard(cue: Cue): void {
  const lines = wrapText(getDefaultSmallFont(), cue.headline, AMBIENT_CARD_TEXT_WIDTH);
  postAmbientCard({
    id: `aside-${cue.id}`,
    title: lines[0] ?? cue.headline,
    lines: lines.slice(1, 1 + AMBIENT_MAX_LINES_PER_CARD),
    expiresAtMs: Date.now() + asideCueTtlMs(),
  });
}

/**
 * The Aside app: reads the transcript of the conversation the wearer is in and
 * shows a cue only when one is worth the interruption, then writes a recap.
 * Like Transcribe it holds continuous mic capture while listening, with a
 * microphone tray icon. See notes/aside-app-design.md.
 */
export function createAsideAppWindow(options: AsideAppOptions): InProcessWindow {
  // The display may well be asleep or showing another app; that's expected
  // while the wearer is talking to someone.
  const announceCue = (cue: Cue): boolean => {
    const asleep = !shell.isScreenOn();
    if (asleep) {
      if (!asideWakeDisplaySetting.get()) return false;
      shell.wake("window");
      options.requestShellRender();
    }
    if (shell.isWindowVisible(ASIDE_WINDOW_ID)) return asleep;
    postCueCard(cue);
    return false;
  };
  const layer = new AsideLayer(transcriptTimestamp(), {
    startCapture: () => {
      options.startContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, MIC_ICON);
    },
    stopCapture: () => {
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
    },
    announceCue,
    // Unless the wearer has moved on to the app switcher.
    sleepDisplay: () => {
      if (shell.isWindowFocused(ASIDE_WINDOW_ID)) shell.sleep();
    },
  });
  const app = createInProcessWindow({
    appId: "aside",
    windowId: ASIDE_WINDOW_ID,
    title: "Aside",
    iconLetter: "As",
    icon: "lightbulb",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    menuItems: () => layer.menuItems(),
    keepsScreenOn: () => layer.wantsScreenOn(),
    onForegroundChanged: (foreground) => {
      if (foreground) layer.refresh();
    },
    receiveTextInput: (text) => layer.receiveText(text),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.onRemoved();
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  // Wire async state changes to this window's renderer, rather than the
  // controller action from which the window-specific actions were derived.
  layer.start(app.requestRender, () => shell.isWindowVisible(ASIDE_WINDOW_ID));
  return app;
}
