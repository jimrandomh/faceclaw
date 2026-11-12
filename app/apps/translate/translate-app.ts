import { TranslateLayer } from "./translate";
import { resolveTranslationModel } from "./translate-llm";
import {
  resolveTranslateLanguage,
  resolveTranslateProvider,
  translateLanguageSetting,
  translateProviderSetting,
  translateShowOriginalSetting,
} from "./translate-settings";
import { micTrayIcon } from "../transcribe/transcribe-app";
import { transcriptTimestamp } from "../transcribe/transcribe";
import { voiceControlBridge } from "../../native/voice-control";
import { type ContinuousCaptureOptions } from "../../ui/layers";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { enumSettingMenuItem, saveRecordingSetting, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const TRANSLATE_WINDOW_ID = "translate";
export const TRANSLATE_SURFACE_ID = "window:translate";

const TRAY_ICON_ID = "translate";

const NO_PROVIDER_PROBLEM =
  "Translate needs a transcription provider that understands any language: add an ElevenLabs, OpenAI, or Soniox API key (Settings > API Keys), or a Whisper server URL (Settings > Voice).";
const NO_MODEL_PROBLEM = global.isIOS
  ? "Translate needs a language model: configure a cloud or OpenAI-compatible model in Settings > Assistant."
  : "Translate needs a language model: configure one in Settings > Assistant, or download the on-phone model.";

export type TranslateAppOptions = InProcessAppOptions & {
  /** Begin (or retarget) continuous mic capture, kept on while the window is open. */
  startContinuousVoiceCapture: (options: ContinuousCaptureOptions) => void;
  stopContinuousVoiceCapture: () => void;
};

/**
 * The Translate app: live speech in any language, translated into English by
 * the assistant's model, in its own window. Like Transcribe it holds
 * continuous mic capture while open, but always with a multilingual cloud
 * provider (Translate settings), which a shared capture switches to.
 */
export function createTranslateAppWindow(options: TranslateAppOptions): InProcessWindow {
  // One timestamp per session names both the audio recording and a saved transcript.
  const stamp = transcriptTimestamp();
  // Whether the mic tray icon is up (capture was asked for).
  let trayIconShown = false;
  const syncTrayIcon = () => shell.setTrayIcon(TRAY_ICON_ID, trayIconShown ? micTrayIcon(voiceControlBridge.recording) : null);
  // Checks the setup and (re)starts capture with the chosen provider and
  // language: at launch, when either setting changes, and on a tap after a
  // problem.
  const startCapture = () => {
    const provider = resolveTranslateProvider();
    const problem = !provider ? NO_PROVIDER_PROBLEM : !resolveTranslationModel() ? NO_MODEL_PROBLEM : null;
    layer.setProblem(problem);
    trayIconShown = Boolean(provider) && !problem;
    if (provider && !problem) {
      options.startContinuousVoiceCapture({
        recordAs: `translate-${stamp}`,
        transcription: { provider, language: resolveTranslateLanguage() },
      });
    } else {
      options.stopContinuousVoiceCapture();
    }
    syncTrayIcon();
  };
  const layer = new TranslateLayer(stamp, startCapture);
  const app = createInProcessWindow({
    appId: "translate",
    windowId: TRANSLATE_WINDOW_ID,
    title: "Translate",
    iconLetter: "Tl",
    icon: "languages",
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
      {
        label: "Translate settings",
        onSelect: (ctx) => {
          ctx.stack.pop();
          openSettingsSubMenu(ctx, "Translate settings", [
            enumSettingMenuItem(translateLanguageSetting, { onChange: startCapture }),
            enumSettingMenuItem(translateProviderSetting, { onChange: startCapture }),
            toggleSettingMenuItem(translateShowOriginalSetting),
          ]);
        },
      },
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
  layer.start(app.requestRender, () => shell.isWindowVisible(TRANSLATE_WINDOW_ID));
  const unsubscribeRecording = voiceControlBridge.onRecordingChange(() => {
    syncTrayIcon();
    app.requestRender();
  });
  startCapture();
  return app;
}
