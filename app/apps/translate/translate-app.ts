import { TranslateLayer } from "./translate";
import { resolveTranslationModel } from "./translate-llm";
import { resolveTranslateProvider, translateProviderSetting, translateShowOriginalSetting } from "./translate-settings";
import { MIC_ICON } from "../transcribe/transcribe-app";
import { transcriptTimestamp } from "../transcribe/transcribe";
import { type ContinuousCaptureOptions } from "../../ui/layers";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
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
  ? "Translate needs a language model: add an Anthropic or OpenAI API key (Settings > API Keys)."
  : "Translate needs a language model: add an Anthropic or OpenAI API key (Settings > API Keys), or download the on-phone model (Settings > Assistant).";

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
  // Checks the setup and (re)starts capture with the chosen provider: at
  // launch, when the provider setting changes, and on a tap after a problem.
  const startCapture = () => {
    const provider = resolveTranslateProvider();
    const problem = !provider ? NO_PROVIDER_PROBLEM : !resolveTranslationModel() ? NO_MODEL_PROBLEM : null;
    layer.setProblem(problem);
    if (!provider || problem) {
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      return;
    }
    options.startContinuousVoiceCapture({ multilingualProvider: provider });
    shell.setTrayIcon(TRAY_ICON_ID, MIC_ICON);
  };
  const layer = new TranslateLayer(transcriptTimestamp(), startCapture);
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
      {
        label: "Translate settings",
        onSelect: (ctx) => {
          ctx.stack.pop();
          openSettingsSubMenu(ctx, "Translate settings", [
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
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  // Wire async state changes to this window's renderer, rather than the
  // controller action from which the window-specific actions were derived.
  layer.start(app.requestRender);
  startCapture();
  return app;
}
