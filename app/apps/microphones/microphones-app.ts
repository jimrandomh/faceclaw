import { imageFromAsciiArt } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { appViewportSize } from "../../ui/shell/geometry";
import { LIST_ROW_TEXT_INSET } from "../../ui/metrics";
import {
  MenuLayer,
  TextPageLayer,
  drawRightValueMenuItem,
  drawSubmenuIndicator,
  drawToggleMenuItem,
  openModalMenu,
  type MenuItem,
} from "../../ui/menu";
import { enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { isAsrModelReady, startAsrModelDownload, asrModelState } from "../../native/asr-model";
import { CaptionsLayer } from "./captions-layer";
import { LevelsLayer } from "./levels-layer";
import { RadarLayer } from "./radar-layer";
import { loadMicConfig, micArrayController, micControlAdvertised, micControlSupported, saveMicConfig } from "./mic-control";
import { isMicModelReady, micModelState, startMicModelDownload } from "./mic-models";
import { micChannelLabel, type MicChannelKey, type MicConfig } from "./mic-protocol";
import { micSession } from "./mic-session";
import { speakerRegistry, type SpeakerProfile } from "./speakers";
import { formatRelativeTime } from "../../util/date-util";
import {
  ancEnabledSetting,
  beamFilterSetting,
  captionsEnabledSetting,
  captionsRetentionSetting,
  recordingsRetentionSetting,
  saveCaptionsSetting,
  saveRecordingsSetting,
  translateEnabledSetting,
  wearerCommandsOnlySetting,
} from "./mic-settings";

export const MICROPHONES_WINDOW_ID = "microphones";
export const MICROPHONES_SURFACE_ID = "window:microphones";

const TRAY_ICON_ID = "microphones";

// 14x15 dual-mic glyph for the top-bar tray.
const TRAY_ICON = imageFromAsciiArt(
  [
    "  ##      ##  ",
    " #  #    #  # ",
    " #  #    #  # ",
    " #  #    #  # ",
    " #  #    #  # ",
    "# ## #  # ## #",
    " #  #    #  # ",
    "  ##      ##  ",
    "  #       #   ",
    "  ###     ### ",
  ],
  220,
);

const MENU_LAYOUT = {
  x: 8,
  y: 8,
  width: 292,
  showBorder: false,
  minHeight: 0,
  maxHeight: appViewportSize("min").height - 16,
  opaque: true,
};

function submenuItem(label: string, onSelect: MenuItem["onSelect"]): MenuItem {
  return {
    label,
    onSelect,
    render: ({ image, x, y, width, height, selected, disabled, text }) => {
      const font = getDefaultSmallFont();
      const value = disabled ? 70 : selected ? 255 : 200;
      image.drawText(font, x, y + LIST_ROW_TEXT_INSET, text, value);
      drawSubmenuIndicator(image, font, x, y, width, height, value);
    },
  };
}

/** Persist a config change and re-apply it live when the array is streaming. */
function updateMicConfig(mutate: (config: MicConfig) => MicConfig): void {
  const updated = mutate(loadMicConfig());
  saveMicConfig(updated);
  if (micSession.getState().mode === "extended") {
    micArrayController.apply(updated);
  }
}

function micChannelToggleItem(
  key: MicChannelKey,
  description: string,
  disabled: () => boolean,
): MenuItem {
  return configToggleItem(
    `${micChannelLabel(key)} mic`,
    () => loadMicConfig().hostMics[key],
    () => micSession.setMicChannelEnabled(key, !loadMicConfig().hostMics[key]),
    disabled,
    description,
  );
}

function configToggleItem(
  label: string,
  isOn: () => boolean,
  toggle: () => void,
  disabled?: () => boolean,
  description?: string,
): MenuItem {
  return {
    label,
    description,
    disabled,
    onSelect: () => toggle(),
    render: ({ image, x, y, width, selected }) => {
      drawToggleMenuItem(image, getDefaultSmallFont(), x, y, width, label, isOn(), selected);
    },
  };
}

function configPickerItem<T extends string | number>(
  label: string,
  values: readonly T[],
  format: (value: T) => string,
  current: () => T,
  apply: (value: T) => void,
  disabled?: () => boolean,
  description?: string,
): MenuItem {
  return {
    label,
    description,
    disabled,
    onSelect: (ctx) => {
      const items = values.map(
        (value): MenuItem => ({
          label: format(value) + (current() === value ? " *" : ""),
          onSelect: (innerCtx) => {
            apply(value);
            innerCtx.stack.pop();
          },
        }),
      );
      openModalMenu(ctx, label, items, Math.max(0, values.indexOf(current())));
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, format(current()));
    },
  };
}

function micSetupMenu(): MenuLayer {
  const unsupported = () => !micControlSupported();
  return new MenuLayer(
    "Microphone setup",
    [
      {
        label: "Array status",
        description:
          "Per-temple mic-control status. Requires the mic-control custom firmware (caps token micctl) and the Use microphone control developer setting.",
        onSelect: (ctx) => {
          micArrayController.query();
          const { left, right } = micArrayController.getStatuses();
          const describe = (side: string, status: typeof left) =>
            status
              ? `${side}: ${status.active ? "active" : "idle"}, mics ${status.channelMask & 1 ? "front" : ""}${
                  status.channelMask & 2 ? "+rear" : ""
                }, ${status.effectiveRateHz / 1000} kHz, ${status.hardwareArmed ? "armed" : "not armed"}, ${
                  status.framesEmitted
                } frames`
              : `${side}: no status yet`;
          const consistency = micArrayController.arrayConsistent()
            ? "Array consistent (L/R matched)."
            : "Array not yet consistent.";
          ctx.stack.push(
            new TextPageLayer(
              "Array status",
              micControlSupported()
                ? `${describe("Left", left)}\n${describe("Right", right)}\n${consistency}`
                : micControlAdvertised()
                  ? "Mic-control is available but disabled. Turn on Settings > Developer > Use microphone control to control the four mics individually."
                  : "The connected firmware does not advertise mic-control. Flash the microphone-configurations CFW build to control the four mics individually; on stock firmware the glasses stream one mixed channel with a firmware-computed direction of arrival.",
            ),
          );
        },
      },
      // Each temple streams its full front+rear pair; these four toggles are
      // host-side selection over the split channels, so any combination of
      // the four microphones can be used independently.
      micChannelToggleItem("leftFront", "Enable the left temple's front microphone (near the hinge).", unsupported),
      micChannelToggleItem("leftRear", "Enable the left temple's rear microphone (by the touchpad).", unsupported),
      micChannelToggleItem("rightFront", "Enable the right temple's front microphone (near the hinge).", unsupported),
      micChannelToggleItem("rightRear", "Enable the right temple's rear microphone (by the touchpad).", unsupported),
      configPickerItem(
        "Source",
        ["pdm", "codec"] as const,
        (value) => (value === "pdm" ? "PDM mics" : "Codec DMIC"),
        () => loadMicConfig().source,
        (value) => updateMicConfig((config) => ({ ...config, source: value })),
        unsupported,
        "PDM streams one channel; the codec front end streams both mics of a temple.",
      ),
      configPickerItem(
        "Codec",
        ["raw", "lc3"] as const,
        (value) => (value === "raw" ? "Raw PCM" : "LC3"),
        () => loadMicConfig().codec,
        (value) => updateMicConfig((config) => ({ ...config, codec: value })),
        unsupported,
        "Raw PCM preserves inter-mic phase for beamforming. (Current firmware always streams raw.)",
      ),
      configPickerItem(
        "Sample rate",
        [8000, 16000, 24000, 32000, 48000] as const,
        (value) => `${value / 1000} kHz`,
        () => loadMicConfig().sampleRateHz,
        (value) => updateMicConfig((config) => ({ ...config, sampleRateHz: value })),
        unsupported,
        "Requested capture rate per mic pair. Current firmware pins the effective rate at 16 kHz and echoes the request in the status.",
      ),
      configPickerItem(
        "LC3 bitrate",
        [0, 16000, 32000, 48000, 64000] as const,
        (value) => (value === 0 ? "Default" : `${value / 1000} kbps`),
        () => loadMicConfig().lc3BitrateBps,
        (value) => updateMicConfig((config) => ({ ...config, lc3BitrateBps: value })),
        unsupported,
        "Requested LC3 bitrate per mic pair (takes effect once the firmware's LC3 path lands).",
      ),
      configToggleItem(
        "Direction detection",
        () => loadMicConfig().beamform,
        () => updateMicConfig((config) => ({ ...config, beamform: !config.beamform })),
        unsupported,
        "Have each temple compute and stream its own sound direction (TDOA angle + signal strength).",
      ),
      {
        label: "4-mic capture (advanced)",
        description:
          "Arms the microphone hardware and multi-channel streaming on the glasses. Leave off until the firmware validation checklist has passed on this hardware.",
        disabled: unsupported,
        onSelect: (ctx) => {
          const config = loadMicConfig();
          if (config.armHardware) {
            updateMicConfig((current) => ({ ...current, armHardware: false }));
            micArrayController.stopStreaming();
            return;
          }
          openModalMenu(ctx, "Arm mic hardware?", [
            {
              label: "Cancel",
              onSelect: (innerCtx) => innerCtx.stack.pop(),
            },
            {
              label: "Enable (validated hardware only)",
              onSelect: (innerCtx) => {
                updateMicConfig((current) => ({ ...current, armHardware: true }));
                innerCtx.stack.pop();
              },
            },
          ]);
        },
        render: ({ image, x, y, width, selected }) => {
          drawToggleMenuItem(
            image,
            getDefaultSmallFont(),
            x,
            y,
            width,
            "4-mic capture (advanced)",
            loadMicConfig().armHardware,
            selected,
          );
        },
      },
    ],
    MENU_LAYOUT,
  );
}

function modelItem(
  label: string,
  ready: () => boolean,
  stateText: () => string,
  download: () => void,
): MenuItem {
  return {
    label,
    onSelect: () => {
      if (!ready()) download();
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, stateText());
    },
  };
}

function voiceSpeakersMenu(): MenuLayer {
  return new MenuLayer(
    "Voice & speakers",
    [
      {
        label: "Enroll my voice",
        description:
          "Speak a sentence after selecting; the next utterance becomes (or refreshes) your voice-print, used to label you in captions and to restrict commands to your voice.",
        disabled: () => !micSession.getState().captionsActive,
        onSelect: () => micSession.armWearerEnrollment(),
      },
      toggleSettingMenuItem(wearerCommandsOnlySetting),
      modelItem(
        "Speaker voice model",
        () => isMicModelReady("speaker-embedding"),
        () => {
          const state = micModelState("speaker-embedding");
          if (state.status === "ready") return "ready";
          if (state.status === "downloading") {
            return `${Math.round((state.bytesDownloaded / state.totalBytes) * 100)}%`;
          }
          return "download (28 MB)";
        },
        () => startMicModelDownload("speaker-embedding"),
      ),
      modelItem(
        "Caption ASR model",
        isAsrModelReady,
        () => {
          const state = asrModelState();
          if (state.status === "ready") return "ready";
          if (state.status === "downloading") {
            return `${Math.round((state.bytesDownloaded / state.totalBytes) * 100)}%`;
          }
          return "download (141 MB)";
        },
        startAsrModelDownload,
      ),
      modelItem(
        "Re-diarization model",
        () => isMicModelReady("diarization-segmentation"),
        () => {
          const state = micModelState("diarization-segmentation");
          if (state.status === "ready") return "ready";
          if (state.status === "downloading") {
            return `${Math.round((state.bytesDownloaded / state.totalBytes) * 100)}%`;
          }
          return "download (6 MB)";
        },
        () => startMicModelDownload("diarization-segmentation"),
      ),
    ],
    MENU_LAYOUT,
  );
}

/** The full contact card behind a People row (and behind the encounter popup). */
function speakerDetailBody(profile: SpeakerProfile): string {
  const parts: string[] = [
    `Last heard ${profile.lastHeardAt ? `${formatRelativeTime(profile.lastHeardAt)} ago` : "never"}.`,
  ];
  if (profile.tag) parts.push(`Note: ${profile.tag}`);
  if (profile.lastRecap) parts.push(`Last conversation: ${profile.lastRecap}`);
  if (profile.actionItems.length) {
    parts.push(`To do:\n${profile.actionItems.map((item) => `- ${item}`).join("\n")}`);
  }
  if (profile.facts.length) {
    parts.push(`Facts:\n${profile.facts.map((fact) => `- ${fact}`).join("\n")}`);
  }
  if (parts.length === 1) {
    parts.push(
      "No conversation insights yet. A recap, action items, and remembered facts are " +
        "generated when a captioned conversation with this person ends (requires the " +
        "on-phone assistant model).",
    );
  }
  return parts.join("\n\n");
}

/**
 * People: the speaker-recognition contacts, most recently heard first — the
 * review surface behind the encounter popup. Selecting a person shows when
 * they were last heard, their note, the recap and action items of the last
 * conversation, and the facts remembered about them.
 */
function peopleMenu(): MenuLayer {
  const profiles = speakerRegistry.all().filter((profile) => !profile.isWearer);
  const items: MenuItem[] = profiles.length
    ? profiles.map((profile) => ({
        label: profile.name,
        onSelect: (ctx) => {
          ctx.stack.push(new TextPageLayer(profile.name, speakerDetailBody(profile)));
        },
        render: ({ image, x, y, width }) => {
          drawRightValueMenuItem(
            image,
            getDefaultSmallFont(),
            x,
            y,
            width,
            profile.name,
            profile.lastHeardAt ? `${formatRelativeTime(profile.lastHeardAt)} ago` : "",
          );
        },
      }))
    : [
        {
          label: "No people heard yet",
          disabled: true,
          onSelect: () => {},
        },
      ];
  return new MenuLayer("People", items, MENU_LAYOUT);
}

function storageMenu(): MenuLayer {
  return new MenuLayer(
    "Storage",
    [
      toggleSettingMenuItem(saveCaptionsSetting),
      toggleSettingMenuItem(saveRecordingsSetting),
      enumSettingMenuItem(captionsRetentionSetting),
      enumSettingMenuItem(recordingsRetentionSetting),
      {
        label: "Review on phone",
        description:
          "Saved conversations, transcripts, speakers, and recordings are reviewed in the Faceclaw phone app: Conversations in the top-right menu.",
        onSelect: (ctx) => {
          ctx.stack.push(
            new TextPageLayer(
              "Review on phone",
              "Open the Faceclaw app on your phone and choose Conversations from the top-right menu to search captions, filter by speaker, play linked recordings, rename/merge speakers, re-diarize sessions, and see the tone/sentiment graph of each conversation.",
            ),
          );
        },
      },
    ],
    MENU_LAYOUT,
  );
}

export function createMicrophonesAppWindow(options: InProcessAppOptions): InProcessWindow {
  const menu = new MenuLayer(
    "Microphones",
    [
      submenuItem("Sonic Radar", (ctx) => {
        const layer = new RadarLayer();
        ctx.stack.push(layer);
        layer.start(ctx.actions.requestRender);
      }),
      submenuItem("Levels", (ctx) => {
        const layer = new LevelsLayer();
        ctx.stack.push(layer);
        layer.start(ctx.actions.requestRender);
      }),
      submenuItem("Captions view", (ctx) => {
        const layer = new CaptionsLayer();
        ctx.stack.push(layer);
        layer.start(ctx.actions.requestRender);
      }),
      submenuItem("People", (ctx) => {
        speakerRegistry.reload();
        ctx.stack.push(peopleMenu());
      }),
      configToggleItem(
        "Captions",
        () => captionsEnabledSetting.get(),
        () => micSession.setCaptionsEnabled(!captionsEnabledSetting.get()),
        undefined,
        captionsEnabledSetting.description,
      ),
      toggleSettingMenuItem(translateEnabledSetting),
      toggleSettingMenuItem(beamFilterSetting),
      toggleSettingMenuItem(ancEnabledSetting),
      submenuItem("Microphone setup", (ctx) => {
        ctx.stack.push(micSetupMenu());
      }),
      submenuItem("Voice & speakers", (ctx) => {
        ctx.stack.push(voiceSpeakersMenu());
      }),
      submenuItem("Storage", (ctx) => {
        ctx.stack.push(storageMenu());
      }),
    ],
    MENU_LAYOUT,
  );
  const app = createInProcessWindow({
    appId: "microphones",
    windowId: MICROPHONES_WINDOW_ID,
    title: "Microphones",
    iconLetter: "Mi",
    icon: "mic",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(menu),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      micSession.stop();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  micSession.start();
  shell.setTrayIcon(TRAY_ICON_ID, TRAY_ICON);
  return app;
}
