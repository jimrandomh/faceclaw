import { imageFromAsciiArt, type GrayImage } from "../../graphics/image";
import { voiceControlBridge } from "../../native/voice-control";
import { enumSettingMenuItem, saveRecordingSetting, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type ContinuousCaptureOptions } from "../../ui/layers";
import { withRecordingIcon } from "../../ui/listening-header";
import { TimePickerLayer } from "./time-picker";
import { TranscribeLayer, transcriptTimestamp } from "./transcribe";
import { transcribeMicCount, transcribeMicsSetting } from "./transcribe-settings";
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
  /** Begin (or retarget) continuous mic capture, kept on while the window is open. */
  startContinuousVoiceCapture: (options?: ContinuousCaptureOptions) => void;
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
  // At launch, and again when the Microphones setting changes: a running
  // capture moves over to the microphones now asked for.
  const startCapture = () =>
    options.startContinuousVoiceCapture({ recordAs: `transcribe-${stamp}`, mics: transcribeMicCount() });
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
      enumSettingMenuItem(transcribeMicsSetting, { onChange: startCapture }),
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
  startCapture();
  shell.setTrayIcon(TRAY_ICON_ID, micTrayIcon(voiceControlBridge.recording));
  return app;
}

/**
 * Transcribe in replay mode: a window of its own that transcribes a
 * recording (a .mka file from Save Recording) in place of the microphones,
 * in real time and through the same pipeline. It neither uses the mic nor
 * shows the mic tray icon, so it runs beside a live Transcribe window. The
 * header shows the position in the recording; a tap pauses and resumes; the
 * menu jumps to a time.
 */
export function createTranscribeReplayWindow(
  windowId: string,
  path: string,
  name: string,
  options: InProcessAppOptions,
): InProcessWindow | null {
  const replay = options.actions.openVoiceReplay?.(path) ?? null;
  if (!replay) return null;
  // Names a saved transcript after the recording it came from.
  const layer = new TranscribeLayer(name.replace(/\.[^.]+$/, ""), replay, name);
  const app = createInProcessWindow({
    appId: "transcribe",
    windowId,
    title: name,
    iconLetter: "Tr",
    icon: "mic",
    closeable: true,
    // Relaunching Transcribe after a restart would open the microphone, not this recording.
    restoresApp: false,
    // Like a playing video: something to watch, not to touch.
    keepsScreenOn: () => replay.state === "playing",
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    menuItems: () => [
      {
        label: "Jump to time",
        // The length isn't known until the recording has been opened.
        disabled: () => replay.durationMs <= 0,
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(
            new TimePickerLayer({
              title: "Jump to time",
              initialMs: replay.positionMs,
              maxMs: replay.durationMs,
              onPick: (positionMs) => {
                replay.jumpTo(positionMs);
                app.requestRender();
              },
            }),
          );
        },
      },
      {
        label: replay.state === "paused" ? "Resume" : "Pause",
        disabled: () => replay.state !== "playing" && replay.state !== "paused",
        onSelect: (ctx) => {
          ctx.stack.pop();
          replay.setPaused(replay.state === "playing");
        },
      },
      {
        label: "Restart from 0:00",
        onSelect: (ctx) => {
          ctx.stack.pop();
          replay.jumpTo(0);
        },
      },
      {
        label: "Save",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.saveTranscript();
        },
      },
    ],
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.onRemoved();
      replay.close();
      options.onClosed();
    },
  });
  // Started first, so the layer picks its opening status up as it subscribes.
  replay.start();
  layer.start(app.requestRender, () => shell.isWindowVisible(windowId));
  return app;
}
