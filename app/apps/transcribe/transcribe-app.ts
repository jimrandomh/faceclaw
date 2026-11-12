import { imageFromAsciiArt, type GrayImage } from "../../graphics/image";
import { voiceControlBridge } from "../../native/voice-control";
import { saveRecordingSetting, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { withRecordingIcon } from "../../ui/listening-header";
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

// 14x15 microphone glyph for the top-bar tray (also Translate's).
const MIC_ICON = imageFromAsciiArt(
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
const MIC_RECORDING_ICON = withRecordingIcon(MIC_ICON);

/** The listening apps' tray icon: a microphone, with the recording circle while their audio is saved. */
export function micTrayIcon(recording: boolean): GrayImage {
  return recording ? MIC_RECORDING_ICON : MIC_ICON;
}

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
    menuItems: () => [
      {
        label: "Save",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.saveTranscript();
        },
      },
      // The controller starts and stops the recording as the setting changes.
      toggleSettingMenuItem(saveRecordingSetting),
    ],
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.onRemoved();
      unsubscribeRecording();
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  // Wire async state changes to this window's renderer, rather than the
  // controller action from which the window-specific actions were derived.
  layer.start(app.requestRender, () => shell.isWindowVisible(TRANSCRIBE_WINDOW_ID));
  const unsubscribeRecording = voiceControlBridge.onRecordingChange(() => {
    shell.setTrayIcon(TRAY_ICON_ID, micTrayIcon(voiceControlBridge.recording));
    app.requestRender();
  });
  options.startContinuousVoiceCapture({ recordAs: `transcribe-${stamp}` });
  shell.setTrayIcon(TRAY_ICON_ID, micTrayIcon(voiceControlBridge.recording));
  return app;
}
