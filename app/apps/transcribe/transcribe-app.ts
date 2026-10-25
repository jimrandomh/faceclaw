import { imageFromAsciiArt } from "../../graphics/image";
import { TranscribeLayer, transcriptTimestamp } from "./transcribe";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const TRANSCRIBE_WINDOW_ID = "transcribe";
export const TRANSCRIBE_SURFACE_ID = "window:transcribe";

const TRAY_ICON_ID = "transcribe";

// 16x18 microphone glyph for the top-bar tray (also Translate's).
export const MIC_ICON = imageFromAsciiArt(
  [
    "     ####     ",
    "    ######    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "  # #    # #  ",
    "  # #    # #  ",
    "  #  ####  #  ",
    "   #      #   ",
    "    ######    ",
    "       #      ",
    "       #      ",
    "     ######   ",
  ],
  { "#": 220 },
);

export type TranscribeAppOptions = InProcessAppOptions & {
  /** Begin continuous mic capture (kept on while the window is open). */
  startContinuousVoiceCapture: (options?: { recordAs?: string }) => void;
  stopContinuousVoiceCapture: () => void;
};

/**
 * The Transcribe app: live speech-to-text in its own window. While open it
 * holds continuous mic capture (so push-to-talk can share the stream) and
 * shows a microphone tray icon in the top bar.
 */
export function createTranscribeAppWindow(options: TranscribeAppOptions): InProcessWindow {
  // One timestamp per session names both the audio recording and a saved transcript.
  const stamp = transcriptTimestamp();
  const layer = new TranscribeLayer(stamp);
  const app = createInProcessWindow({
    appId: "transcribe",
    windowId: TRANSCRIBE_WINDOW_ID,
    title: "Transcribe",
    iconLetter: "Tr",
    icon: "mic",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    menuItems: () => [{
      label: "Save",
      onSelect: (ctx) => {
        ctx.stack.pop();
        layer.saveTranscript();
      },
    }],
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
  layer.start(app.requestRender, () => shell.isWindowVisible(TRANSCRIBE_WINDOW_ID));
  options.startContinuousVoiceCapture({ recordAs: `transcribe-${stamp}` });
  shell.setTrayIcon(TRAY_ICON_ID, MIC_ICON);
  return app;
}
