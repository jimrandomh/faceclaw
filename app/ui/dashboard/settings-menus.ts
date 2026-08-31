import { knownFolders } from "@nativescript/core";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import { FACECLAW_VERSION } from "../../version";
import {
  cancelLocalModelDownload,
  deleteLocalModel,
  LOCAL_MODEL,
  localModelState,
  onLocalModelStateChanged,
  startLocalModelDownload,
} from "../../native/llama";
import {
  ASR_MODEL,
  asrModelState,
  cancelAsrModelDownload,
  deleteAsrModel,
  onAsrModelStateChanged,
  startAsrModelDownload,
} from "../../native/asr-model";
import { TextViewerLayer } from "../../apps/files/text-viewer";
import type { LayerContext } from "../layers";
import { drawRightValueMenuItem, openModalMenu, type MenuItem } from "../menu";
import { shell } from "../shell/shell";
import {
  anthropicApiKeySetting,
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  displayModeSetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  mirrorTouchSetting,
  openAiApiKeySetting,
  previewColorSetting,
  ringConnectionModeSetting,
  sonioxApiKeySetting,
  enumSettingMenuItem,
  firmwareDebugFlagsSetting,
  lockScreenEnabledSetting,
  saveVoiceRecordingsSetting,
  suspendEvenHubWhenScreenOffSetting,
  terminalAutoReconnectSetting,
  terminalLaunchPresetsSetting,
  terminalWakeOnBellSetting,
  textSettingMenuItem,
  timeFormatSetting,
  toggleSettingMenuItem,
  useMicControlSetting,
  verticalPositionSetting,
  voiceProviderSetting,
  screenTimeoutSetting,
  wakeWordActionSetting,
  watchCanUnlockSetting,
  watchCrownClockwiseNextSetting,
  watchMirrorAssistantSetting,
  watchRemoteEnabledSetting,
} from "../dashboard-settings";
import { wearBridge } from "../../native/wear-bridge";
import { SettingsPanelLayer, type SettingsSection } from "./settings-panel";
import { terminalFontPickerMenuItem, uiFontPickerMenuItem } from "../font-picker";

/** The Settings app's master-detail panel (sections on the left, contents on the right). */
export function createSettingsPanelLayer(): SettingsPanelLayer {
  return new SettingsPanelLayer(settingsSections());
}

function settingsSections(): SettingsSection[] {
  return [
    {
      label: "Display",
      items: [
        // Auto (ambient sensor) or an exact level; pushed to the glasses by
        // the dashboard controller when changed and on each connect.
        enumSettingMenuItem(brightnessSetting),
        enumSettingMenuItem(screenTimeoutSetting, {
          onChange: () => {
            shell.noteUserActivity();
          },
        }),
        toggleSettingMenuItem(lockScreenEnabledSetting),
        // Where min-height windows (and the sidebar) sit vertically on the
        // screen; the dashboard controller repositions surfaces on change.
        enumSettingMenuItem(verticalPositionSetting),
        // Band / tall / full-panel; the dashboard controller reflows windows.
        enumSettingMenuItem(displayModeSetting),
        // Controls the top-bar battery indicators (icon vs percentage).
        enumSettingMenuItem(batteryDisplayModeSetting),
        // Controls the top-bar clock (24-hour vs 12-hour).
        enumSettingMenuItem(timeFormatSetting),
        // Opens the modal font picker (face, weight, size) for UI text.
        uiFontPickerMenuItem(),
      ],
    },
    {
      label: "Voice",
      items: [
        enumSettingMenuItem(wakeWordActionSetting),
        enumSettingMenuItem(voiceProviderSetting),
        asrModelMenuItem(),
      ],
    },
    {
      label: "Assistant",
      items: [
        // On-phone LLM loop vs the user's own agent via the bridge plugin.
        enumSettingMenuItem(assistantBackendSetting),
        enumSettingMenuItem(assistantModelSetting),
        localModelMenuItem(),
        // When on, a wakeword utterance goes straight to the assistant with no
        // Send/Type menu step.
        toggleSettingMenuItem(assistantSkipConfirmationSetting),
        textSettingMenuItem(assistantBridgeHostSetting),
        textSettingMenuItem(assistantBridgePortSetting),
        textSettingMenuItem(assistantBridgeTokenSetting),
        toggleSettingMenuItem(assistantAllowProactiveSetting),
      ],
    },
    {
      label: "API Keys",
      items: [
        textSettingMenuItem(elevenLabsApiKeySetting),
        textSettingMenuItem(openAiApiKeySetting),
        textSettingMenuItem(sonioxApiKeySetting),
        textSettingMenuItem(anthropicApiKeySetting),
        textSettingMenuItem(mapboxApiKeySetting),
      ],
    },
    {
      label: "Terminal",
      // Connections (g2mirror:// strings) are managed inside the Terminal
      // app's Manage Connections section, not here.
      items: [
        terminalFontPickerMenuItem(),
        textSettingMenuItem(terminalLaunchPresetsSetting),
        toggleSettingMenuItem(terminalAutoReconnectSetting),
        toggleSettingMenuItem(terminalWakeOnBellSetting),
      ],
    },
    {
      label: "Phone display",
      // The phone app's mirror of the glasses screen and its controls
      // (app/phone-ui/): all read live by the main page.
      items: [
        enumSettingMenuItem(previewColorSetting),
        toggleSettingMenuItem(mirrorTouchSetting),
      ],
    },
    {
      label: "Watch",
      // Wear OS remote (wear/); the status line above the items says whether
      // a watch running the companion app is currently reachable.
      items: [
        toggleSettingMenuItem(watchRemoteEnabledSetting),
        toggleSettingMenuItem(watchCrownClockwiseNextSetting),
        toggleSettingMenuItem(watchCanUnlockSetting),
        toggleSettingMenuItem(watchMirrorAssistantSetting),
      ],
      renderDetail: renderWatchStatus,
    },
    {
      label: "Developer",
      items: [
        // Whether the phone opens its own BLE link to the R1 ring; the
        // glasses relay ring gestures either way. Applied at connect time.
        enumSettingMenuItem(ringConnectionModeSetting),
        toggleSettingMenuItem(saveVoiceRecordingsSetting),
        toggleSettingMenuItem(firmwareDebugFlagsSetting),
        toggleSettingMenuItem(suspendEvenHubWhenScreenOffSetting),
        toggleSettingMenuItem(useMicControlSetting),
      ],
    },
    {
      label: "About",
      // The version/license blurb (renderDetail) draws above the bundled
      // project docs, in both the preview and the focused states.
      items: [
        bundledDocMenuItem("README.md", "README"),
        bundledDocMenuItem("LICENSE", "License"),
        bundledDocMenuItem("PRIVACY", "Privacy policy"),
        bundledDocMenuItem("ACKNOWLEDGEMENTS.md", "Acknowledgements"),
      ],
      renderDetail: renderAbout,
    },
    {
      label: "Quit",
      items: [
        {
          label: "Disconnect from glasses",
          description: "Close the Bluetooth connection to the glasses and return them to standby.",
          onSelect: async (ctx) => {
            ctx.stack.clearToBase();
            await ctx.actions.disconnect();
          },
        },
      ],
    },
  ];
}

const LOCAL_MODEL_GB = `${(LOCAL_MODEL.sizeBytes / 1e9).toFixed(1)}GB`;

// While a download is running, re-render on progress updates so the row's
// percentage stays live; the watch tears itself down when the download ends.
let localModelRenderUnsub: (() => void) | null = null;

function watchLocalModelDownload(ctx: LayerContext): void {
  localModelRenderUnsub?.();
  localModelRenderUnsub = onLocalModelStateChanged((state) => {
    ctx.actions.requestRender();
    if (state.status !== "downloading") {
      localModelRenderUnsub?.();
      localModelRenderUnsub = null;
    }
  });
}

function localModelStatusText(): string {
  const state = localModelState();
  if (state.status === "ready") return "downloaded";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% of ${LOCAL_MODEL_GB}`;
  }
  return "not downloaded";
}

/** Download/cancel/delete management for the on-phone assistant model. */
function localModelMenuItem(): MenuItem {
  return {
    label: "On-phone model",
    description:
      `${LOCAL_MODEL.label} (${LOCAL_MODEL_GB} download over Wi-Fi recommended). ` +
      "Answers assistant queries on the phone itself, with no API key or cloud service. " +
      "Slower and simpler than the cloud models, but free and private. " +
      "Used automatically when no API key is set. An interrupted download resumes where it left off.",
    onSelect: (ctx) => {
      const state = localModelState();
      const action: MenuItem =
        state.status === "downloading"
          ? {
              label: "Cancel download",
              onSelect: (innerCtx) => {
                cancelLocalModelDownload();
                innerCtx.stack.pop();
              },
            }
          : state.status === "ready"
            ? {
                label: "Delete model",
                onSelect: (innerCtx) => {
                  deleteLocalModel();
                  innerCtx.stack.pop();
                },
              }
            : {
                label: `Download (${LOCAL_MODEL_GB})`,
                onSelect: (innerCtx) => {
                  startLocalModelDownload();
                  watchLocalModelDownload(innerCtx);
                  innerCtx.stack.pop();
                },
              };
      openModalMenu(ctx, "On-phone model", [action], 0);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "On-phone model", localModelStatusText());
    },
  };
}

const ASR_MODEL_MB = `${Math.round(ASR_MODEL.totalBytes / 1e6)}MB`;

let asrModelRenderUnsub: (() => void) | null = null;

function watchAsrModelDownload(ctx: LayerContext): void {
  asrModelRenderUnsub?.();
  asrModelRenderUnsub = onAsrModelStateChanged((state) => {
    ctx.actions.requestRender();
    if (state.status !== "downloading") {
      asrModelRenderUnsub?.();
      asrModelRenderUnsub = null;
    }
  });
}

function asrModelStatusText(): string {
  const state = asrModelState();
  if (state.status === "ready") return "downloaded";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% of ${ASR_MODEL_MB}`;
  }
  return "not downloaded";
}

/** Download/cancel/delete management for the on-device transcription model. */
function asrModelMenuItem(): MenuItem {
  return {
    label: "On-device voice model",
    description:
      `${ASR_MODEL.label} (${ASR_MODEL_MB} download). ` +
      "Transcribes voice input on the phone itself, with no API key or cloud service. " +
      "Required for the On-device transcription provider; the cloud providers work without it. " +
      "An interrupted download resumes where it left off.",
    onSelect: (ctx) => {
      const state = asrModelState();
      const action: MenuItem =
        state.status === "downloading"
          ? {
              label: "Cancel download",
              onSelect: (innerCtx) => {
                cancelAsrModelDownload();
                innerCtx.stack.pop();
              },
            }
          : state.status === "ready"
            ? {
                label: "Delete model",
                onSelect: (innerCtx) => {
                  deleteAsrModel();
                  innerCtx.stack.pop();
                },
              }
            : {
                label: `Download (${ASR_MODEL_MB})`,
                onSelect: (innerCtx) => {
                  startAsrModelDownload();
                  watchAsrModelDownload(innerCtx);
                  innerCtx.stack.pop();
                },
              };
      openModalMenu(ctx, "On-device voice model", [action], 0);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "On-device voice model", asrModelStatusText());
    },
  };
}

/** A row that opens one of the project docs (copied into the bundle under
 * about/ by webpack.config.js) in the paged text viewer. */
function bundledDocMenuItem(fileName: string, label: string): MenuItem {
  return {
    label,
    onSelect: (ctx) => {
      ctx.stack.push(new TextViewerLayer(readBundledDoc(fileName), label));
    },
  };
}

function readBundledDoc(fileName: string): string {
  try {
    const text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync();
    return text || `(${fileName} is missing from this build)`;
  } catch {
    return `(${fileName} is missing from this build)`;
  }
}

function renderWatchStatus(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  let status: string;
  if (!wearBridge.isAvailable()) {
    status = "Google Play services is unavailable on this phone, so no watch can connect.";
  } else {
    const connection = wearBridge.getWatchConnection();
    status = connection.reachable
      ? `Connected to ${connection.watchName || "a watch"}.`
      : "No watch connected. Install the Faceclaw watch app (wear/ in the source tree) on a Wear OS watch paired with this phone.";
  }
  const lines = wrapText(font, status, width);
  for (let i = 0; i < lines.length; i++) {
    image.drawText(font, x, y + i * font.lineHeight, lines[i]!, 170);
  }
  return lines.length * font.lineHeight + 10;
}

function renderAbout(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  const logo = getDashboardLogo();
  if (logo) {
    image.bitBlt(logo, x, y + 4, { transparentZero: true });
  }
  const textX = logo ? x + logo.width + 12 : x;
  image.drawText(font, textX, y + 8, "Faceclaw", 220);
  image.drawText(font, textX, y + 24, `v${FACECLAW_VERSION}`, 170);
  const blurb = "By James Babcock and other contributors. Distributed under the GNU General Public License, version 3.";
  const blurbY = y + Math.max(64, logo ? logo.height + 12 : 0);
  const blurbLines = wrapText(font, blurb, width);
  for (let i = 0; i < blurbLines.length; i++) {
    image.drawText(font, x, blurbY + i * font.lineHeight, blurbLines[i]!, 170);
  }
  return blurbY - y + blurbLines.length * font.lineHeight + 10;
}
