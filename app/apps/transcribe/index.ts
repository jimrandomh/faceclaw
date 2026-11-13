import { type AppContext, type AppDefinition } from "../app-definition";
import {
  createTranscribeAppWindow,
  createTranscribeReplayWindow,
  TRANSCRIBE_SURFACE_ID,
  TRANSCRIBE_WINDOW_ID,
} from "./transcribe-app";

// Replay windows are closeable and non-singleton; the serial keeps their windowIds unique.
let nextReplaySerial = 1;

/**
 * Open a recording (.mka) in Transcribe's replay mode, as a window of its
 * own. Returns false where recordings can't be replayed.
 */
export function openRecordingInTranscribe(ctx: AppContext, path: string, name: string): boolean {
  if (!ctx.actions.openVoiceReplay) return false;
  const windowId = `transcribe:replay:${nextReplaySerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) => {
      const window = createTranscribeReplayWindow(windowId, path, name, options);
      if (!window) throw new Error("recordings can't be replayed here");
      return window;
    })
    .catch((error) => {
      ctx.appendLog(`transcribe replay window failed: ${error}`);
    });
  return true;
}

const transcribeApp: AppDefinition = {
  appId: "transcribe",
  title: "Transcribe",
  icon: "mic",
  launch: (ctx) =>
    ctx.launchInProcessApp(TRANSCRIBE_WINDOW_ID, TRANSCRIBE_SURFACE_ID, (options) =>
      createTranscribeAppWindow({
        ...options,
        startContinuousVoiceCapture: (capture) => void options.actions.startContinuousVoiceCapture("transcribe", capture),
        stopContinuousVoiceCapture: () => void options.actions.stopContinuousVoiceCapture("transcribe"),
      }),
    ),
};

export default transcribeApp;
