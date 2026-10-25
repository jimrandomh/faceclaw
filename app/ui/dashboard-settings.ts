import { normalizeNightscoutThreshold, type NightscoutThresholds } from "../apps/nightscout/nightscout-alerts";
import { GESTURE_DOUBLE_CLICK, InputEvent } from "./gestures";
import { DEFAULT_BRIGHTNESS_CURVE, normalizeBrightnessCurve, brightnessCurveError } from "../g2/brightness-curve";
import {
  getBooleanSetting,
  getStringSetting,
  onSettingsStoreChanged,
  setBooleanSetting,
  setStringSetting,
} from "~/native/settings-store";
import { getDefaultSmallFont } from "~/graphics/ui-fonts";
import { wrapText } from "~/graphics/textwrap";
import {
  ASSISTANT_MODEL_CHOICES,
  assistantModelLabel,
  assistantModelProvider,
  type AssistantModel,
} from "~/assistant/models";
import { isLocalModelReady } from "../native/llama";
import { normalizeWhisperServerUrl } from "../native/whisper-server-stt";
import { drawRightValueMenuItem, drawToggleMenuItem, MenuItem, openModalMenu } from "./menu";
import { ANIMATION_SPEEDS, animationSpeedLabel, scaleAnimationDuration, type AnimationSpeed } from "./animation-speed";
import { MENU_ANIMATION_KEY } from "./menu-animation-pref";
import { LIST_ROW_TEXT_INSET, lineStep } from "./metrics";
import { Layer, type LayerContext } from "./layers";
import { GrayImage } from "~/graphics/image";
import type { DataCollectionLevel } from "../analytics/analytics-store";
import { IOS_PRIVACY_SUMMARY } from "../analytics/privacy-disclosure";

export type NightscoutSettings = {
  siteUrl: string;
  apiToken: string;
};
export type BatteryDisplayMode = "icon" | "percentage" | "stacked" | "stacked-percentage" | "dense";
/** When a top-bar battery indicator is shown: always, only below 50%, or never. */
export type BatteryIndicatorVisibility = "always" | "low" | "never";
export type TimeFormat = "24h" | "12h";
export type TemperatureUnit = "fahrenheit" | "celsius";
export type ScreenTimeoutSetting = "15s" | "30s" | "1m" | "3m" | "never";
// Auto runs Faceclaw's light curve. Numeric values use the calibrated firmware
// scale, clamped to 2–100; 2 is also the endpoint for screen fades.
export const BRIGHTNESS_VALUES = ["auto", "2", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"] as const;
export type BrightnessSetting = (typeof BRIGHTNESS_VALUES)[number];
export type WakeWordAction = "voice-input" | "off" | "turn-screen-on";

type ConfigSettingOptions<TValue, TId extends string> = {
  id: TId;
  label: string;
  storageKey: string;
  defaultValue: TValue;
  formatValue?: (value: TValue) => string;
  /** Extended description shown in the Settings panel when the row is selected. */
  description?: string;
  /**
   * Boolean and enum settings only take fixed values, so Full analytics
   * reports them (fixedChoiceSettingValues); false keeps this one out.
   */
  reportInAnalytics?: boolean;
};

// Fired after any setting changes, in any isolate (storage lives in the Java
// FaceclawSettings store and broadcasts to every isolate). Lets phone-side UI
// that depends on settings toggled from the glasses (e.g. the text-setting
// editor) update without waiting for an unrelated snapshot emit. Delivery is
// asynchronous: one message-loop tick after the set().
const settingChangeListeners = new Set<() => void>();

export function onAnySettingChanged(listener: () => void): () => void {
  settingChangeListeners.add(listener);
  return () => {
    settingChangeListeners.delete(listener);
  };
}

onSettingsStoreChanged(() => {
  // Font/cache invalidation listeners may register after this relay. Let the
  // entire store notification finish before observers synchronously repaint.
  // Otherwise Save updates the label but paints the previous typeface once.
  setTimeout(() => {
    for (const listener of Array.from(settingChangeListeners)) {
      listener();
    }
  }, 0);
});

// Boolean and enum settings by storage key, for fixedChoiceSettingValues.
// Settings built repeatedly (per-app or per-slot) just replace themselves.
const fixedChoiceSettings = new Map<string, ConfigSetting<boolean> | ConfigSetting<string>>();

/**
 * The current value of every boolean and enum setting this isolate has
 * loaded, keyed by storage key: what Full analytics reports as settings.
 * Free-text settings never appear.
 */
export function fixedChoiceSettingValues(): Record<string, boolean | string> {
  const values: Record<string, boolean | string> = {};
  for (const [storageKey, setting] of fixedChoiceSettings) values[storageKey] = setting.get();
  return values;
}

export abstract class ConfigSetting<TValue, TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly description?: string;
  protected readonly storageKey: string;
  protected readonly defaultValue: TValue;
  private readonly valueFormatter: (value: TValue) => string;

  protected constructor(options: ConfigSettingOptions<TValue, TId>) {
    this.id = options.id;
    this.label = options.label;
    this.description = options.description;
    this.storageKey = options.storageKey;
    this.defaultValue = options.defaultValue;
    this.valueFormatter = options.formatValue ?? ((value) => String(value));
  }

  abstract get(): TValue;
  abstract set(value: TValue): TValue;

  displayValue(value?: TValue): string {
    const displayValue = arguments.length > 0 ? value as TValue : this.get();
    return this.valueFormatter(displayValue);
  }
}

export class ConfigSettingBoolean<TId extends string = string> extends ConfigSetting<boolean, TId> {
  // Widens ConfigSetting's protected constructor.
  public constructor(options: ConfigSettingOptions<boolean, TId>) {
    super(options);
    if (options.reportInAnalytics !== false) fixedChoiceSettings.set(options.storageKey, this);
  }

  get(): boolean {
    return getBooleanSetting(this.storageKey, this.defaultValue);
  }

  set(value: boolean): boolean {
    setBooleanSetting(this.storageKey, value);
    return value;
  }

  toggle(value = this.get()): boolean {
    return this.set(!value);
  }
}

type ConfigSettingEnumOptions<TValue extends string, TId extends string> = ConfigSettingOptions<TValue, TId> & {
  values: readonly TValue[];
  normalize?: (value: string | null | undefined) => TValue;
  /** Dynamic availability check used by enum picker rows. */
  isDisabled?: (value: TValue) => boolean;
};

export class ConfigSettingEnum<TValue extends string, TId extends string = string> extends ConfigSetting<TValue, TId> {
  readonly values: readonly TValue[];
  private readonly normalizer: (value: string | null | undefined) => TValue;
  private readonly disabledPredicate: (value: TValue) => boolean;

  constructor(options: ConfigSettingEnumOptions<TValue, TId>) {
    super(options);
    if (options.reportInAnalytics !== false) fixedChoiceSettings.set(options.storageKey, this);
    this.values = options.values;
    this.disabledPredicate = options.isDisabled ?? (() => false);
    if (options.normalize) {
      this.normalizer = (value: string | null | undefined) => {
        const normalized = options.normalize(value) as TValue|undefined;
        if (normalized === undefined) return this.defaultValue;
        return normalized;
      }
    } else {
      this.normalizer = (value) => this.values.includes(value as TValue) ? value as TValue : this.defaultValue;
    }
  }

  get(): TValue {
    return this.normalizer(getStringSetting(this.storageKey, this.defaultValue));
  }

  set(value: TValue): TValue {
    const normalized = this.normalizer(value);
    setStringSetting(this.storageKey, normalized);
    return normalized;
  }

  isDisabled(value: TValue): boolean {
    return this.disabledPredicate(value);
  }

  next(value = this.get()): TValue {
    const index = this.values.indexOf(value);
    for (let offset = 1; offset <= this.values.length; offset++) {
      const candidate = this.values[(index + offset) % this.values.length];
      if (candidate !== undefined && !this.isDisabled(candidate)) return candidate;
    }
    return value;
  }
}

type ConfigSettingStringOptions<TId extends string> = ConfigSettingOptions<string, TId> & {
  editorTitle?: string;
  glassesEditTitle?: string;
  inputKind?: "text" | "email" | "password";
  normalize?: (value: string | null | undefined) => string;
  validate?: (value: string) => string | null;
};

// Every string setting by id, so isolates that can only pass an id over a
// message channel (e.g. a worker app requesting the phone text editor) can be
// resolved back to the setting instance on the main thread.
const stringSettingsById = new Map<string, ConfigSettingString>();

export function getStringSettingById(id: string): ConfigSettingString | null {
  return stringSettingsById.get(id) ?? null;
}

export class ConfigSettingString<TId extends string = string> extends ConfigSetting<string, TId> {
  readonly editorTitle: string;
  readonly glassesEditTitle: string;
  readonly inputKind: "text" | "email" | "password";
  private readonly normalizer: (value: string | null | undefined) => string;
  private readonly validator?: (value: string) => string | null;

  constructor(options: ConfigSettingStringOptions<TId>) {
    super(options);
    this.editorTitle = options.editorTitle ?? options.label;
    this.glassesEditTitle = options.glassesEditTitle ?? `Edit ${options.label}`;
    this.inputKind = options.inputKind ?? "text";
    this.normalizer = options.normalize ?? ((value) => value ?? "");
    this.validator = options.validate;
    stringSettingsById.set(this.id, this);
  }

  get(): string {
    return this.normalizer(getStringSetting(this.storageKey, this.defaultValue));
  }

  set(value: string): string {
    const normalized = this.normalizer(value);
    // Preserve drafts for the editor/preview; consumers can use getValidValue().
    if (this.validator) {
      const candidate = this.validator(normalized) ? this.get() : normalized;
      if (!this.validator(candidate)) setStringSetting(this.storageKey + ".valid", candidate);
    }
    setStringSetting(this.storageKey, normalized);
    return normalized;
  }

  validationError(value = this.get()): string | null { return this.validator?.(value) ?? null; }

  getValidValue(): string {
    const value = this.get();
    if (!this.validationError(value)) return value;
    const saved = this.normalizer(getStringSetting(this.storageKey + ".valid", this.defaultValue));
    return this.validationError(saved) ? this.defaultValue : saved;
  }
}


export const batteryDisplayModeSetting = new ConfigSettingEnum<BatteryDisplayMode>({
  id: "batteryDisplayMode",
  label: "Style",
  storageKey: "dashboard.systemCard.batteryDisplayMode",
  defaultValue: "dense",
  values: ["icon", "percentage", "stacked", "stacked-percentage", "dense"],
  formatValue: batteryDisplayModeLabel,
  description: "How the top bar shows battery levels: a gauge icon or exact percentage beside the label, a compact gauge or percentage with the label stacked above it, or (dense) a device icon beside each gauge with two indicators stacked per column.",
});

/** Below this charge level a "Below 50%" indicator becomes visible. */
export const BATTERY_LOW_VISIBILITY_THRESHOLD = 50;

function batteryVisibilitySetting(
  id: string,
  device: string,
  storageKey: string,
): ConfigSettingEnum<BatteryIndicatorVisibility> {
  return new ConfigSettingEnum<BatteryIndicatorVisibility>({
    id,
    label: device,
    storageKey,
    defaultValue: "always",
    values: ["always", "low", "never"],
    formatValue: batteryIndicatorVisibilityLabel,
    description: `When the top bar shows the ${device} battery: always, only once it drops below ${BATTERY_LOW_VISIBILITY_THRESHOLD}%, or never.`,
  });
}

export const phoneBatteryVisibilitySetting = batteryVisibilitySetting(
  "phoneBatteryVisibility", "Phone", "display.battery.phoneVisibility",
);
export const glassesBatteryVisibilitySetting = batteryVisibilitySetting(
  "glassesBatteryVisibility", "G2", "display.battery.glassesVisibility",
);
export const ringBatteryVisibilitySetting = batteryVisibilitySetting(
  "ringBatteryVisibility", "R1", "display.battery.ringVisibility",
);
/** The Wear OS watch; the indicator only exists while a watch is reachable. */
export const watchBatteryVisibilitySetting = batteryVisibilitySetting(
  "watchBatteryVisibility", "Watch", "display.battery.watchVisibility",
);

/** Whether an indicator with this visibility setting shows at the given charge. */
export function batteryIndicatorVisible(visibility: BatteryIndicatorVisibility, percent: number): boolean {
  if (visibility === "never") return false;
  if (visibility === "always") return true;
  return percent < BATTERY_LOW_VISIBILITY_THRESHOLD;
}

/**
 * One string summarizing every setting the top-bar battery block reads, so
 * the shell can cheaply tell whether a settings change needs a repaint.
 */
export function batteryIndicatorSettingsKey(): string {
  return [
    batteryDisplayModeSetting.get(),
    phoneBatteryVisibilitySetting.get(),
    glassesBatteryVisibilitySetting.get(),
    ringBatteryVisibilitySetting.get(),
    watchBatteryVisibilitySetting.get(),
  ].join("|");
}

export const timeFormatSetting = new ConfigSettingEnum<TimeFormat>({
  id: "timeFormat",
  label: "Time format",
  storageKey: "display.timeFormat",
  defaultValue: "24h",
  values: ["24h", "12h"],
  formatValue: timeFormatLabel,
  description: "Whether the top-bar clock shows 24-hour or 12-hour time.",
});

export const temperatureUnitSetting = new ConfigSettingEnum<TemperatureUnit>({
  id: "temperatureUnit",
  label: "Temperature unit",
  storageKey: "display.temperatureUnit",
  defaultValue: "fahrenheit",
  values: ["fahrenheit", "celsius"],
  formatValue: (value) => value === "celsius" ? "Celsius" : "Fahrenheit",
  description: "Whether the Weather app, its top-bar indicator, and the Glanceboard's system card show temperatures in Fahrenheit or Celsius.",
});

/**
 * Where the app switcher (the open-window icons) sits: a strip along the
 * left or right edge of the display, a row under the window, or a popup box
 * over the middle of the window that shows only while it has focus.
 */
export type AppSwitcherPosition = "left" | "right" | "bottom" | "popup";

const APP_SWITCHER_POSITION_LABELS: Record<AppSwitcherPosition, string> = {
  left: "Left",
  right: "Right",
  bottom: "Bottom",
  popup: "Popup",
};

export const appSwitcherPositionSetting = new ConfigSettingEnum<AppSwitcherPosition>({
  id: "app-switcher-position",
  label: "App switcher position",
  storageKey: "display.appSwitcherPosition",
  defaultValue: "bottom",
  values: ["left", "right", "bottom", "popup"],
  formatValue: (value) => APP_SWITCHER_POSITION_LABELS[value] ?? value,
  description:
    "Where the open-app icons go. Left and right take a column beside windows; bottom puts a row beneath the window, which makes full-height windows a little shorter; popup shows them only while you're in the app switcher, in a box over the dimmed window. Bottom and popup leave room at the sides to set the display's depth. Open apps reopen at their new size when a change resizes windows.",
});

/**
 * An enum setting that took over from older settings: until it is first
 * set, its value is derived from theirs.
 */
class ConfigSettingEnumWithLegacy<TValue extends string> extends ConfigSettingEnum<TValue> {
  constructor(options: ConfigSettingEnumOptions<TValue, string>, private readonly legacyValue: () => TValue) {
    super(options);
  }

  get(): TValue {
    return getStringSetting(this.storageKey, "") === "" ? this.legacyValue() : super.get();
  }
}

/**
 * How much of the 640x480 panel windows use, and where: the stock
 * 288px-tall band, at one of five heights in the field of view; Tall, every
 * window the full height; or Full Screen, Tall at the panel's whole 640px
 * width. The app switcher keeps its own room in every mode. Full Screen
 * needs a bottom row or popup app switcher (a side strip leaves no width to
 * spare; there it is Tall), has no window frame, and plays at depth 0,
 * since its windows reach the panel's edges (geometry.ts).
 */
export const DISPLAY_LAYOUT_VALUES = [
  "band-top", "band-high", "band-middle", "band-low", "band-bottom", "tall", "fullscreen",
] as const;
export type DisplayLayout = (typeof DISPLAY_LAYOUT_VALUES)[number];

const DISPLAY_LAYOUT_LABELS: Record<DisplayLayout, string> = {
  "band-top": "Band · Top",
  "band-high": "Band · High",
  "band-middle": "Band · Middle",
  "band-low": "Band · Low",
  "band-bottom": "Band · Bottom",
  tall: "Tall",
  fullscreen: "Full Screen",
};

export function displayLayoutLabel(value: DisplayLayout): string {
  return DISPLAY_LAYOUT_LABELS[value] ?? value;
}

/** Whether the Full Screen display mode is available: with a bottom row or popup app switcher. */
export function fullScreenAvailable(): boolean {
  const position = appSwitcherPositionSetting.get();
  return position === "bottom" || position === "popup";
}

// Until 2026-10-10 the display mode ("576x288" band, "576x480" tall,
// "640x480" full panel) and the band's vertical position were separate
// settings, globally and per app.
const LEGACY_MODE_LAYOUTS: Record<string, DisplayLayout> = { "576x480": "tall", "640x480": "fullscreen" };
const LEGACY_POSITION_LAYOUTS: Record<string, DisplayLayout> = {
  top: "band-top", upper: "band-high", middle: "band-middle", lower: "band-low", bottom: "band-bottom",
};

function legacyBand(position: string): DisplayLayout {
  return LEGACY_POSITION_LAYOUTS[position] ?? "band-middle";
}

function legacyDisplayLayout(): DisplayLayout {
  const mode = getStringSetting("display.mode", "576x288");
  return LEGACY_MODE_LAYOUTS[mode] ?? legacyBand(getStringSetting("display.verticalPosition", "middle"));
}

export const displayLayoutSetting = new ConfigSettingEnumWithLegacy<DisplayLayout>({
  id: "display-mode",
  label: "Display mode",
  storageKey: "display.layout",
  defaultValue: "band-middle",
  values: DISPLAY_LAYOUT_VALUES,
  formatValue: displayLayoutLabel,
  isDisabled: (value) => value === "fullscreen" && !fullScreenAvailable(),
  description:
    "Band: the stock 288px-tall window, at the height in your field of view you choose. Tall: full-height windows. Full Screen: full-height windows across the display's whole width; it needs the app switcher at the bottom or as a popup, and turns depth off, since windows reach the display's edges. Navigate and Terminal can override this. Open apps reopen in the new size.",
}, legacyDisplayLayout);

const UI_DEPTH_VALUES = ["-62", "-48", "-32", "-16", "0", "16", "32", "48", "62"] as const;
export type UiDepth = (typeof UI_DEPTH_VALUES)[number];

/**
 * Stereo depth of the whole display, in the firmware's depth units: the
 * lenses shift everything by half this many pixels each, in opposite
 * directions. Only applies with the app switcher at the bottom or a popup,
 * where the windows' 576px width leaves 32px at each side: one for the side
 * of the window's frame and 31 to shift into, hence ±62 (see geometry.ts
 * uiDepth and windowFramed); not to Full Screen windows, which have no such
 * margins. Values stay even so the per-lens halves of nested depths add
 * exactly.
 */
export const uiDepthSetting = new ConfigSettingEnum<UiDepth>({
  id: "ui-depth",
  label: "Depth",
  storageKey: "display.uiDepth",
  defaultValue: "48",
  values: UI_DEPTH_VALUES,
  formatValue: (value) => {
    const depth = Number(value);
    return depth === 0 ? "0" : depth > 0 ? `+${depth} (nearer)` : `${depth} (farther)`;
  },
  description:
    "Moves the whole display nearer (positive) or farther away (negative) by shifting it in opposite directions on the two lenses. Available with the app switcher at the bottom or as a popup; not applied in the Full Screen display mode, whose windows reach the display's edges.",
});

/**
 * Where the status bar (clock, notification icons, app widgets, batteries)
 * goes: the top bar over each window, or its bottom. With a bottom app
 * switcher, the bottom is the right end of the switcher's row (geometry.ts
 * statusInSwitcherRow), where windows grow into the top bar's height; with a
 * popup switcher, a bar under the window (geometry.ts statusBarEdge).
 */
export type StatusBarPosition = "top" | "bottom";

export const statusBarPositionSetting = new ConfigSettingEnum<StatusBarPosition>({
  id: "status-bar-position",
  label: "Status bar position",
  storageKey: "display.statusBarPosition",
  defaultValue: "bottom",
  values: ["top", "bottom"],
  // "switcher" was the bottom value's name while only a bottom row had one.
  normalize: (value) => value === "bottom" || value === "switcher" ? "bottom" : "top",
  formatValue: (value) => value === "top" ? "Top"
    : appSwitcherPositionSetting.get() === "bottom" ? "With app switcher" : "Bottom",
  description:
    "Where the clock, notification icons, app widgets and battery indicators go. With the app switcher at the bottom, With app switcher puts them at the right end of its row, and windows grow into the top bar's space; with a popup app switcher, Bottom puts them under the window. Available with the app switcher at the bottom or as a popup. Changing it reopens open apps in the new size.",
});

/**
 * Whether the status bar always takes its rows along the window's edge, or
 * shows only while the popup app switcher is up, over the window's edge
 * (geometry.ts statusBarOverlays); the windows then grow into its rows.
 */
export type StatusBarVisibility = "always" | "switcher";

export const statusBarVisibilitySetting = new ConfigSettingEnum<StatusBarVisibility>({
  id: "status-bar-visibility",
  label: "Status bar visibility",
  storageKey: "display.statusBarVisibility",
  defaultValue: "always",
  values: ["always", "switcher"],
  formatValue: (value) => value === "switcher" ? "In app switcher" : "Always",
  description:
    "Always keeps the clock, notification icons, app widgets and battery indicators beside the window. In app switcher shows them only while the app switcher is open, over the edge of the window, and windows grow into their space. Available with a popup app switcher. Changing it reopens open apps in the new size.",
});

/**
 * Whether the foreground window gets a rounded border with a popup app
 * switcher (geometry.ts windowFramed); without one, a line divides the
 * window from the status bar.
 */
export const windowBorderSetting = new ConfigSettingBoolean({
  id: "window-border",
  label: "Window border",
  storageKey: "display.windowBorder",
  defaultValue: true,
  description:
    "Draw a rounded border around the window. Without it, a line separates the window from the status bar. Available with a popup app switcher. Changing it reopens open apps in the new size.",
});

export const brightnessSetting = new ConfigSettingEnum<BrightnessSetting>({
  id: "brightness",
  label: "Brightness",
  storageKey: "display.brightness",
  defaultValue: "auto",
  values: BRIGHTNESS_VALUES,
  normalize: (value) => value === "0" ? "2" : BRIGHTNESS_VALUES.includes(value as BrightnessSetting) ? value as BrightnessSetting : "auto",
  formatValue: brightnessLabel,
  description: "Auto uses Faceclaw's ambient-light curve; numbers set a fixed level. 2 is the dimmest level.",
});

const AUTO_BRIGHTNESS_LEVELS = ["2", "5", "10", "20", "25", "30", "40", "50", "60", "70", "80", "90", "100"] as const;
export const autoBrightnessMinSetting = new ConfigSettingEnum({
  id: "autoBrightnessMin", label: "Auto minimum", storageKey: "display.autoBrightnessMin",
  defaultValue: "20", values: AUTO_BRIGHTNESS_LEVELS,
  description: "Lowest brightness Auto will select. Screen fades can still reach 2.",
});
export const autoBrightnessMaxSetting = new ConfigSettingEnum({
  id: "autoBrightnessMax", label: "Auto maximum", storageKey: "display.autoBrightnessMax",
  defaultValue: "100", values: AUTO_BRIGHTNESS_LEVELS,
  description: "Highest brightness Auto will select. A value below the minimum uses the minimum.",
});
export const autoBrightnessCurveSetting = new ConfigSettingString({
  id: "autoBrightnessCurve", label: "Auto light curve", storageKey: "display.autoBrightnessCurve",
  defaultValue: DEFAULT_BRIGHTNESS_CURVE, normalize: normalizeBrightnessCurve, validate: brightnessCurveError,
  description: "2–16 lux:percent pairs, separated by commas. Percent is within your minimum–maximum range. Start at 0:0, end at 100%, and increase lux without decreasing percent. Incomplete edits stay in the preview; brightness keeps using the last valid curve.",
});
/** The screen on/off fade at Normal speed. */
const SCREEN_FADE_MS = 280;

export const menuAnimationSetting = new ConfigSettingEnum<AnimationSpeed>({
  id: "menu-animation",
  label: "Menu animation",
  storageKey: MENU_ANIMATION_KEY,
  defaultValue: "normal",
  values: ANIMATION_SPEEDS,
  formatValue: animationSpeedLabel,
  description: "How fast the highlight slides, lists scroll, and the ends bounce in menus, lists, and the launcher and Files icon grids. Disabled moves them instantly.",
});

export const screenFadeSetting = new ConfigSettingEnum<AnimationSpeed>({
  id: "screen-fade",
  label: "Screen fade",
  storageKey: "display.screenFadeSpeed",
  defaultValue: "normal",
  values: ANIMATION_SPEEDS,
  formatValue: animationSpeedLabel,
  description: "How fast the display fades in and out when the screen turns on or off. Disabled switches it instantly.",
});

export function getBrightnessPreferences() {
  const level = brightnessSettingToLevel(brightnessSetting.get());
  return { auto: level === null, level: level ?? 50,
    minimum: Number(autoBrightnessMinSetting.get()), maximum: Number(autoBrightnessMaxSetting.get()),
    curve: autoBrightnessCurveSetting.getValidValue(), fadeMs: scaleAnimationDuration(SCREEN_FADE_MS, screenFadeSetting.get()) };
}

export const wakeToLastAppSetting = new ConfigSettingBoolean({
  id: "wake-to-last-app",
  label: "Wake into last app",
  storageKey: "display.wakeToLastApp",
  defaultValue: false,
  description: "Waking the display with a double tap returns to the app you were using. Off: wake into the app switcher.",
});

export const screenTimeoutSetting = new ConfigSettingEnum<ScreenTimeoutSetting>({
  id: "screen-timeout",
  label: "Screen timeout",
  storageKey: "display.screenTimeout",
  defaultValue: "30s",
  values: ["15s", "30s", "1m", "3m", "never"],
  formatValue: screenTimeoutLabel,
  description: "How long the display stays on after the last input before turning itself off. \"Never\" keeps it on until turned off manually.",
});

export const lockScreenEnabledSetting = new ConfigSettingBoolean({
  id: "lock-screen-enabled",
  label: "Enable lock screen",
  storageKey: "display.lockScreenEnabled",
  defaultValue: true,
  description:
    "Lock the glasses after they are taken off while the phone is locked. Unlocking the phone unlocks the glasses." +
    (global.isIOS ? " On iPhone, this requires a device passcode and follows iOS data-protection notifications, which may be delayed after the screen locks." : ""),
});

// Phone display: the phone app's mirror of the glasses screen and the
// controls around it on the main page.
export type PreviewColor = "white" | "green";
export type PhoneRotation = "auto" | "portrait" | "landscape";

export const phoneRotationSetting = new ConfigSettingEnum<PhoneRotation>({
  id: "phone-rotation",
  label: "Rotation",
  storageKey: "phone.rotation",
  defaultValue: "auto",
  values: ["auto", "portrait", "landscape"],
  formatValue: (value) => ({ auto: "Auto-Rotate", portrait: "Always Portrait", landscape: "Always Landscape" })[value],
  description: "Automatically rotate with the phone, or keep the phone app in portrait or landscape. Auto-Rotate follows the phone's system rotation preference.",
});

export const previewColorSetting = new ConfigSettingEnum<PreviewColor>({
  id: "preview-color",
  label: "Preview color",
  storageKey: "phone.previewColor",
  defaultValue: "white",
  values: ["white", "green"],
  formatValue: (value) => (value === "green" ? "Green" : "White"),
  description:
    "How the phone's mirror of the glasses display renders: white/grayscale (clearest), or green to match the physical glasses.",
});

export type PreviewScaling = "scaled" | "raw";

export const previewScalingSetting = new ConfigSettingEnum<PreviewScaling>({
  id: "preview-scaling",
  label: "Preview scaling",
  storageKey: "phone.previewScaling",
  defaultValue: "scaled",
  values: ["scaled", "raw"],
  formatValue: (value) => (value === "raw" ? "Raw" : "Scaled"),
  description:
    "How much of the glasses display the phone's mirror shows: Scaled centers and enlarges the part the current display mode uses; Raw shows the whole 640x480 panel.",
});

export const mirrorTouchSetting = new ConfigSettingBoolean({
  id: "mirror-touch",
  label: "Touch mirror",
  // Key predates this setting object (the toggle used to live on the phone's
  // main screen); keeping it preserves the user's choice.
  storageKey: "phone.mirrorTouch",
  defaultValue: true,
  description:
    "Let touches on the phone's mirror act on the glasses UI: tap selects what it lands on, double-tap goes back, a hold opens the menu, swipes navigate.",
});

// Wear OS watch remote (app/g2/wear-remote.ts, wear/). All three are read on
// every watch message, so a change applies immediately.
export const watchRemoteEnabledSetting = new ConfigSettingBoolean({
  id: "watch-remote-enabled",
  label: "Watch remote control",
  storageKey: "watch.remoteEnabled",
  defaultValue: true,
  description:
    "Accept input from the Faceclaw Wear OS app: spatial swipes, taps, holds, crown, voice queries and app commands. The ring's scheme is unaffected. Turn off to ignore the watch.",
});

export const watchCanUnlockSetting = new ConfigSettingBoolean({
  id: "watch-can-unlock",
  label: "Watch can unlock glasses",
  storageKey: "watch.canUnlock",
  defaultValue: true,
  description:
    "Let the watch unlock the glasses' lock screen (which otherwise waits for the phone to be unlocked). Your watch is on your wrist; turn this off if you would rather it stay a phone-only unlock.",
});

export const watchCrownClockwiseNextSetting = new ConfigSettingBoolean({
  id: "watch-crown-clockwise-next",
  label: "Clockwise crown = next",
  storageKey: "watch.crownClockwiseNext",
  defaultValue: false,
  description:
    "Choose which crown direction moves to the next item. Off: clockwise moves to the previous item. On: clockwise moves to the next item.",
});

export const watchMirrorAssistantSetting = new ConfigSettingBoolean({
  id: "watch-mirror-assistant",
  label: "Mirror assistant to watch",
  storageKey: "watch.mirrorAssistant",
  defaultValue: true,
  description: "Stream assistant replies and on-glasses alerts to the watch so they can be read from the wrist.",
});

/**
 * A per-app display mode (Navigate, Terminal): the global one ("global"),
 * Terminal's own default ("default": tall sessions, the sessions list at
 * the global mode), or a mode of its own.
 */
export type AppDisplayLayout = "default" | "global" | DisplayLayout;

function legacyAppDisplayLayout(appId: string, defaultValue: AppDisplayLayout): AppDisplayLayout {
  const mode = getStringSetting(`${appId}.displayMode`, defaultValue);
  const position = getStringSetting(`${appId}.verticalPosition`, "global");
  if (LEGACY_MODE_LAYOUTS[mode]) return LEGACY_MODE_LAYOUTS[mode];
  const global = displayLayoutSetting.get();
  if (mode === "576x288") return position === "global" ? (global.startsWith("band-") ? global : legacyDisplayLayout()) : legacyBand(position);
  // Following the global mode at a band position of its own.
  if (mode === "global" && position !== "global" && global.startsWith("band-")) return legacyBand(position);
  return mode === "default" || mode === "global" ? mode : defaultValue;
}

function appDisplayLayoutSetting(appId: string, defaultValue: AppDisplayLayout): ConfigSettingEnum<AppDisplayLayout> {
  return new ConfigSettingEnumWithLegacy<AppDisplayLayout>({
    id: `${appId}-display-mode`,
    label: "Display mode",
    storageKey: `${appId}.displayLayout`,
    defaultValue,
    values: appId === "terminal" ? ["default", "global", ...DISPLAY_LAYOUT_VALUES] : ["global", ...DISPLAY_LAYOUT_VALUES],
    formatValue: (value) => value === "default" ? "Tall sessions (default)" : value === "global" ? "Use global" : displayLayoutLabel(value),
    isDisabled: (value) => value === "fullscreen" && !fullScreenAvailable(),
    description: appId === "terminal"
      ? "Display mode for Terminal. The default keeps session windows tall and the terminals list in the global mode. Use global follows Display settings for all Terminal windows. Resizing an open session reconnects its view at the new size."
      : "Display mode for Navigate. Choose a Band to leave more of your field of view clear, or Use global to follow Display settings. Applies to the current route too.",
  }, () => legacyAppDisplayLayout(appId, defaultValue));
}

export const navigateDisplayLayoutSetting = appDisplayLayoutSetting("navigate", "global");
export const terminalDisplayLayoutSetting = appDisplayLayoutSetting("terminal", "default");

export type { DataCollectionLevel };

/** The data-collection setting's key, for observers (app/analytics/analytics.ts). */
export const DATA_COLLECTION_KEY = "privacy.dataCollection";

const DATA_COLLECTION_LABELS: Record<DataCollectionLevel, string> = {
  none: "None",
  minimal: "Minimal",
  full: "Full",
};

// What each level collects is set out in app/analytics/analytics-store.ts and
// the privacy policy (PRIVACY); keep these in step with both.
const DATA_COLLECTION_SUMMARIES: Record<DataCollectionLevel, string> = {
  none: "Disable all data sharing",
  minimal: "Version, devices, and connection reliability statistics",
  full: "More detailed usage data",
};

/** One-line summary of what a data-collection level sends (onboarding, settings). */
export function dataCollectionSummary(level: DataCollectionLevel): string {
  return DATA_COLLECTION_SUMMARIES[level];
}

/** Chosen in the on-glasses onboarding; changeable in Settings > Privacy. */
export const dataCollectionSetting = new ConfigSettingEnum<DataCollectionLevel>({
  id: "data-collection",
  label: "Faceclaw statistics",
  storageKey: DATA_COLLECTION_KEY,
  defaultValue: "none",
  values: ["none", "minimal", "full"],
  formatValue: (value) => DATA_COLLECTION_LABELS[value],
  description:
    (global.isIOS ? IOS_PRIVACY_SUMMARY + " " : "") +
    "Optional statistics Faceclaw may send its developers once a day, to help fix problems and improve the " +
    "app. None: no Faceclaw statistics are stored or sent. Minimal: the app version, which devices are " +
    "paired and in use, and how reliable the connection to them is. Full: also settings chosen from fixed " +
    "options, and which kinds of API key are set (never the keys themselves).",
});

export const voiceControlEnabledSetting = new ConfigSettingBoolean({
  id: "voice-control-enabled",
  label: "Enable",
  storageKey: "voice.enabled",
  defaultValue: true,
  description: "Master switch for voice features, including wakeword detection and voice input.",
});

export const firmwareDebugFlagsSetting = new ConfigSettingBoolean({
  id: "firmware-debug-flags",
  label: "Firmware debug flags",
  storageKey: "developer.firmwareDebugFlags",
  defaultValue: false,
  description: "Overlay debug information provided by custom firmware that shows draw timings and dirty rects. Only useful for firmware development.",
});

export const suspendEvenHubWhenScreenOffSetting = new ConfigSettingBoolean({
  id: "suspend-evenhub-screen-off",
  label: "Suspend EvenHub when screen off",
  storageKey: "developer.suspendEvenHubWhenScreenOff",
  defaultValue: true,
  description: "Suspend the EvenHub session while the display is off. This significantly improves battery life, but increases the latency of waking the screen.",
});

export const useMicControlSetting = new ConfigSettingBoolean({
  id: "use-mic-control",
  label: "Use microphone control",
  storageKey: "developer.useMicControl",
  defaultValue: true,
  description:
    "Use the custom firmware's per-temple mic-control channel for the Microphones app's array capture. When off, use the standard single mixed stream.",
});

export const showBleBandwidthSetting = new ConfigSettingBoolean({
  id: "show-ble-bandwidth",
  label: "Show BLE bandwidth usage",
  storageKey: "developer.showBleBandwidth",
  defaultValue: false,
  description:
    "Show Bluetooth messages and bytes sent, throughput, acknowledged display fps, and bytes per frame at the bottom of the phone screen. Rates use a five-second window; bytes include control traffic and protocol framing.",
});

/**
 * How the phone talks to the R1. The ring has one phone role (health sync) and
 * one glasses role (gestures, battery pushes), so "health" and "direct" are
 * the two ways a phone link can be useful; see
 * GlassesSessionCore.setDirectRingRole and notes/ring-link-control.md.
 */
export type RingConnectionMode = "glasses" | "health" | "direct";

export const ringConnectionModeSetting = new ConfigSettingEnum<RingConnectionMode>({
  id: "ring-connection-mode",
  label: "Ring connection",
  storageKey: "developer.ringConnectionMode",
  defaultValue: "glasses",
  values: ["glasses", "health", "direct"],
  formatValue: (value) =>
    value === "direct" ? "Direct to phone" : value === "health" ? "Via glasses + health sync" : "Only via glasses",
  description:
    "How the R1 ring reaches the phone. Only via glasses: the glasses relay the ring's gestures and the phone never connects to it. Via glasses + health sync: the same, plus the phone connects to the ring to sync health data. Direct to phone (experimental): the phone takes the ring over from the glasses and gets its gestures and battery itself; the glasses lose ring input and ring health sync is off. Leaving Direct hands the ring back to the glasses. Takes effect on the next connection to the glasses.",
});

// "whisper" (no "onboard-" prefix) is OpenAI's CLOUD realtime model
// (gpt-realtime-whisper); "onboard-whisper" is the on-device sherpa-onnx
// Whisper backend. Same underlying model family, two different places it
// runs -- see the same note in native/voice-control.ts. The "whisper" value
// keeps its name (it's a persisted setting on real installs) but its label
// below now says "OpenAI" to tell the two apart in the picker.
// "whisper-server" is a self-hosted OpenAI-compatible Whisper (e.g. vLLM).
export type VoiceProvider = "onboard" | "onboard-whisper" | "elevenlabs" | "whisper" | "soniox" | "whisper-server";

// On iOS "onboard" is Apple's on-device recognizer, and there is no
// "onboard-whisper" (the sherpa-onnx models are Android-only).
const voiceProviderLabels: Record<VoiceProvider, string> = {
  onboard: global.isIOS ? "On-device (Apple)" : "On-device (Moonshine)",
  "onboard-whisper": "On-device (Whisper)",
  elevenlabs: "ElevenLabs",
  whisper: "OpenAI (Whisper)",
  soniox: "Soniox",
  "whisper-server": "Whisper server (self-hosted)",
};

export const voiceProviderSetting = new ConfigSettingEnum<VoiceProvider>({
  id: "voice-provider",
  label: "Transcription Provider",
  storageKey: "voice.provider",
  defaultValue: "onboard",
  values: global.isIOS
    ? ["onboard", "elevenlabs", "whisper", "soniox", "whisper-server"]
    : ["onboard", "onboard-whisper", "elevenlabs", "whisper", "soniox", "whisper-server"],
  formatValue: (value) => voiceProviderLabels[value] ?? value,
  isDisabled: (value) => {
    if (value === "elevenlabs") return elevenLabsApiKeySetting.get().trim().length === 0;
    if (value === "whisper") return openAiApiKeySetting.get().trim().length === 0;
    if (value === "soniox") return sonioxApiKeySetting.get().trim().length === 0;
    if (value === "whisper-server") return !normalizeWhisperServerUrl(whisperServerUrlSetting.get());
    return false;
  },
  description: global.isIOS
    ? "Speech-to-text engine for voice input. ElevenLabs, OpenAI, and Soniox are cloud services that need an API key (Settings > API Keys), with significantly better accuracy than on-device transcription. Whisper server is your own OpenAI-compatible Whisper (set its URL below). On-device uses your iPhone's speech language and never leaves the phone."
    : "Speech-to-text engine for voice input. ElevenLabs, OpenAI, and Soniox are cloud services that need an API key, with significantly better accuracy than on-device transcription. Whisper server is your own OpenAI-compatible Whisper (set its URL below). The two On-device options need their voice model downloaded (below) and never leave the phone.",
});

const wakeWordActionLabels: Record<WakeWordAction, string> = {
  "voice-input": "Voice Input",
  off: "Ignore",
  "turn-screen-on": "Turn Screen On",
};

export const wakeWordActionSetting = new ConfigSettingEnum<WakeWordAction>({
  id: "wake-word-action",
  label: "Wakeword Action (\"Hey Even\")",
  storageKey: "voice.wakeWordAction",
  defaultValue: "voice-input",
  values: ["voice-input", "off", "turn-screen-on"],
  formatValue: (value) => wakeWordActionLabels[value] ?? value,
  description: "What saying \"Hey Even\" does: start voice input, just turn the screen on, or nothing.",
});

export const saveTranscribeAudioSetting = new ConfigSettingBoolean({
  id: "save-transcribe-audio",
  label: "Save Transcribe audio",
  storageKey: "voice.saveTranscribeAudio",
  defaultValue: true,
  description: "Record each Transcribe session's audio as a WAV file in Downloads (about 2 MB per minute), named like its transcript. Recordings are kept until you delete them.",
});

export const saveVoiceRecordingsSetting = new ConfigSettingBoolean({
  id: "save-voice-recordings",
  label: "Save voice recordings",
  storageKey: "developer.saveVoiceRecordings",
  defaultValue: false,
  description: "Keep a copy of captured voice audio on the phone, for debugging transcription problems.",
});

export const assistantSkipConfirmationSetting = new ConfigSettingBoolean({
  id: "assistant-skip-confirmation",
  label: "Send to assistant without confirming",
  storageKey: "assistant.skipConfirmationAfterWakeword",
  defaultValue: false,
  description: "After a wakeword utterance, send the transcript straight to the assistant instead of stopping at the Send/Type confirmation menu.",
});

export type AssistantBackendKind = "direct" | "external";

const assistantBackendLabels: Record<AssistantBackendKind, string> = {
  direct: global.isIOS ? "Cloud API" : "On-phone",
  external: "My own agent (bridge)",
};

export const assistantBackendSetting = new ConfigSettingEnum<AssistantBackendKind>({
  id: "assistant-backend",
  label: "Assistant backend",
  storageKey: "assistant.backend",
  defaultValue: "direct",
  values: global.isIOS ? ["direct"] : ["direct", "external"],
  formatValue: (value) => assistantBackendLabels[value] ?? value,
  description:
    global.isIOS ? "Cloud models called with your OpenAI or Anthropic API key. Add your key in Settings > API Keys." : "Who answers assistant queries: an LLM called from the phone (a cloud API with your key, or the downloaded on-phone model), or your own long-running agent (e.g. OpenClaw) reached through the faceclaw-agent-bridge plugin.",
});

export const assistantHermesUrlSetting = new ConfigSettingString({
  id: "assistant-hermes-url",
  label: "Hermes URL",
  storageKey: "assistant.hermesUrl",
  defaultValue: "",
  editorTitle: "Hermes API server (e.g. http://host:8642/v1)",
  glassesEditTitle: "Edit Hermes URL",
  formatValue: (value) => value || "(not set)",
  description: "Address of a Hermes Agent gateway's API server, used when Hermes agent is the assistant model.",
});

export const assistantHermesKeySetting = new ConfigSettingString({
  id: "assistant-hermes-key",
  label: "Hermes key",
  storageKey: "assistant.hermesKey",
  defaultValue: "",
  editorTitle: "Hermes API server key",
  glassesEditTitle: "Edit Hermes key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "The API server's key (API_SERVER_KEY in Hermes's .env).",
});

export const assistantBridgeHostSetting = new ConfigSettingString({
  id: "assistant-bridge-host",
  label: "Bridge host",
  storageKey: "assistant.bridgeHost",
  defaultValue: "",
  editorTitle: "Agent bridge host (tailscale IP)",
  glassesEditTitle: "Edit bridge host",
  description:
    "Hostname or IP address (e.g. a Tailscale address) of the machine running the agent bridge.",
});

export const assistantBridgePortSetting = new ConfigSettingString({
  id: "assistant-bridge-port",
  label: "Bridge port",
  storageKey: "assistant.bridgePort",
  defaultValue: "8790",
  editorTitle: "Agent bridge port",
  glassesEditTitle: "Edit bridge port",
  description: "TCP port the agent bridge listens on. The default is 8790.",
});

export const assistantBridgeTokenSetting = new ConfigSettingString({
  id: "assistant-bridge-token",
  label: "Bridge token",
  storageKey: "assistant.bridgeToken",
  defaultValue: "",
  editorTitle: "Agent bridge auth token",
  glassesEditTitle: "Edit bridge token",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Shared secret that must match the bridge's configured token.",
});

export const assistantAllowProactiveSetting = new ConfigSettingBoolean({
  id: "assistant-allow-proactive",
  label: "Allow proactive agent actions",
  storageKey: "assistant.allowProactive",
  defaultValue: true,
  description:
    "Let the external agent use glasses tools outside of a conversation, e.g. showing an alert when a long-running job finishes. Rate-limited; only tools marked proactive-safe are allowed.",
});

export const elevenLabsApiKeySetting = new ConfigSettingString({
  id: "elevenlabs-api-key",
  label: "ElevenLabs key",
  storageKey: "voice.elevenLabsApiKey",
  defaultValue: "",
  editorTitle: "ElevenLabs API key",
  glassesEditTitle: "Edit ElevenLabs key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "ElevenLabs API key, used when ElevenLabs is the transcription provider. The key needs the speech-to-text permission.",
});

export const openAiApiKeySetting = new ConfigSettingString({
  id: "openai-api-key",
  label: "OpenAI key",
  storageKey: "voice.openAiApiKey",
  defaultValue: "",
  editorTitle: "OpenAI API key",
  glassesEditTitle: "Edit OpenAI key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "OpenAI API key, used when Whisper is the transcription provider or an OpenAI model is selected for the voice assistant.",
});

export const sonioxApiKeySetting = new ConfigSettingString({
  id: "soniox-api-key",
  label: "Soniox key",
  storageKey: "voice.sonioxApiKey",
  defaultValue: "",
  editorTitle: "Soniox API key",
  glassesEditTitle: "Edit Soniox key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Soniox API key, used when Soniox is the transcription provider.",
});

export const whisperServerUrlSetting = new ConfigSettingString({
  id: "whisper-server-url",
  label: "Whisper server URL",
  storageKey: "voice.whisperServerUrl",
  defaultValue: "",
  editorTitle: "Whisper server URL (e.g. http://100.x.y.z:8004/v1)",
  glassesEditTitle: "Edit Whisper server URL",
  formatValue: (value) => value || "(not set)",
  validate: (value) => (!value.trim() || normalizeWhisperServerUrl(value) ? null : "Enter an http:// or https:// address."),
  description:
    "API root of an OpenAI-compatible Whisper server (vLLM, speaches, LocalAI...), used when Whisper server is the transcription provider. On iOS a plain-http address must also be allowed by the app's App Transport Security exceptions.",
});

export const whisperServerModelSetting = new ConfigSettingString({
  id: "whisper-server-model",
  label: "Whisper server model",
  storageKey: "voice.whisperServerModel",
  defaultValue: "",
  editorTitle: "Whisper model id (empty: server's first)",
  glassesEditTitle: "Edit Whisper model",
  formatValue: (value) => value || "(server default)",
  description: "Model id sent to the Whisper server. Leave empty to use the first model the server lists.",
});

export const whisperServerLanguageSetting = new ConfigSettingString({
  id: "whisper-server-language",
  label: "Whisper language",
  storageKey: "voice.whisperServerLanguage",
  defaultValue: "",
  editorTitle: "Language code, e.g. en or sk (empty: auto)",
  glassesEditTitle: "Edit Whisper language",
  formatValue: (value) => value || "Auto-detect",
  validate: (value) => (!value.trim() || /^[a-z]{2,3}$/i.test(value.trim()) ? null : "Use a language code like en, sk or cs."),
  description:
    "Spoken language for the Whisper server. Leave empty to auto-detect; a wrong fixed language makes Whisper translate into it instead of transcribing.",
});

export const whisperServerApiKeySetting = new ConfigSettingString({
  id: "whisper-server-api-key",
  label: "Whisper server key",
  storageKey: "voice.whisperServerApiKey",
  defaultValue: "",
  editorTitle: "Whisper server API key (optional)",
  glassesEditTitle: "Edit Whisper server key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(none)"),
  description: "Bearer token for the Whisper server, if it requires one.",
});

export const anthropicApiKeySetting = new ConfigSettingString({
  id: "anthropic-api-key",
  label: "Anthropic key",
  storageKey: "llm.anthropicApiKey",
  defaultValue: "",
  editorTitle: "Anthropic API key",
  glassesEditTitle: "Edit Anthropic key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Anthropic API key, used when an Anthropic model is selected for the voice assistant.",
});

export const assistantModelSetting = new ConfigSettingEnum<AssistantModel>({
  id: "assistant-model",
  label: "Assistant model",
  storageKey: "assistant.model",
  defaultValue: "auto",
  values: ASSISTANT_MODEL_CHOICES,
  formatValue: assistantModelLabel,
  isDisabled: (value) => {
    const provider = assistantModelProvider(value);
    if (provider === "anthropic") return anthropicApiKeySetting.get().trim().length === 0;
    if (provider === "openai") return openAiApiKeySetting.get().trim().length === 0;
    if (provider === "local") return !isLocalModelReady();
    if (provider === "hermes") return assistantHermesUrlSetting.get().trim().length === 0;
    return false;
  },
  description:
    global.isIOS ? "Model used by the voice assistant. Auto prefers Terra with an OpenAI key, then Sonnet with an Anthropic key." : "Model used by the voice assistant. Auto prefers Terra when an OpenAI key is set, then Sonnet when an Anthropic key is set, then the downloaded on-phone model.",
});

export const mapboxApiKeySetting = new ConfigSettingString({
  id: "mapbox-api-key",
  label: "Mapbox token",
  storageKey: "maps.mapboxApiKey",
  defaultValue: "",
  editorTitle: "Mapbox public token (pk.…)",
  glassesEditTitle: "Edit Mapbox token",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Mapbox public token (pk. prefix), used by the Navigate app for maps, geocoding, and directions.",
});

/**
 * Staging buffer for the Terminal app's "Add connection" flow: the worker
 * asks the shell to open the phone text editor on this setting, the user
 * types the g2mirror:// connection string there, and the worker reads (and
 * clears) the draft when the user confirms on the glasses. Deliberately not
 * listed in the Settings app; connections are managed inside the Terminal app.
 */
export const terminalNewConnectionSetting = new ConfigSettingString({
  id: "terminal-new-connection",
  label: "New connection",
  storageKey: "terminal.newConnectionDraft",
  defaultValue: "",
  editorTitle: "g2mirror connection string (g2mirror://token@host)",
  glassesEditTitle: "Add connection",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
});

/**
 * Staging buffer for the T3 Code app's Pair-environment screen: the phone
 * text editor types the `t3 pair` link into it, and the app reads it back
 * when the user confirms on the glasses. Cleared after each attempt (the link
 * carries a one-time credential).
 */
export const t3codePairingLinkSetting = new ConfigSettingString({
  id: "t3code-pairing-link",
  label: "T3 Code pairing link",
  storageKey: "t3code.pairingDraft",
  defaultValue: "",
  editorTitle: "T3 Code pairing link (from `t3 pair`)",
  glassesEditTitle: "Pair T3 Code",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, " ").trim(),
});

export const t3codeWakeOnAttentionSetting = new ConfigSettingBoolean({
  id: "t3code-wake-on-attention",
  label: "Wake when a thread needs you",
  storageKey: "t3code.wakeOnAttention",
  defaultValue: false,
  description:
    "When a T3 Code agent asks for approval or asks a question while the glasses are asleep, wake them and show the T3 Code thread list.",
});

/**
 * Staging buffer for the Developer app's "Load app from URL" flow: the app
 * opens the phone text editor on this setting, the user types (or scans, or
 * dictates) the URL, and the app reads it back when the load is confirmed on
 * the glasses. Kept across launches so a reload after an edit-and-rebuild only
 * takes a click. Deliberately not listed in the Settings app.
 */
export const developerAppUrlSetting = new ConfigSettingString({
  id: "developer-app-url",
  label: "App URL",
  storageKey: "developer.appUrl",
  defaultValue: "",
  editorTitle: "EvenHub app URL (http:// or https://)",
  glassesEditTitle: "Load app from URL",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
});

export const terminalLaunchPresetsSetting = new ConfigSettingString({
  id: "terminal-launch-presets",
  label: "Launch presets",
  storageKey: "terminal.launchPresets",
  defaultValue: "shell",
  editorTitle: "g2mirror launch presets (comma-separated)",
  glassesEditTitle: "Edit launch presets",
  description:
    "Comma-separated names of g2mirror launch presets that can be started from the glasses. Presets are defined in the server's config; the wire protocol has no way to list them, so name them here. The default server config defines \"shell\".",
});

export const terminalAutoReconnectSetting = new ConfigSettingBoolean({
  id: "terminal-auto-reconnect",
  label: "Auto-reconnect",
  storageKey: "terminal.autoReconnect",
  defaultValue: true,
  description:
    "While at least one Terminal window is open, automatically reconnect to the g2mirror server when the connection drops, retrying with backoff until it succeeds.",
});

export const terminalWakeOnBellSetting = new ConfigSettingBoolean({
  id: "terminal-wake-on-bell",
  label: "Wake glasses on terminal bell",
  storageKey: "terminal.wakeOnBell",
  defaultValue: false,
  description:
    "When a terminal rings its bell while the glasses are asleep, wake them and focus that terminal's window (or the terminals list if it has no window open).",
});

export const roamGraphNameSetting = new ConfigSettingString({
  id: "roam-graph-name",
  label: "Roam graph name",
  storageKey: "integrations.roam.graphName",
  defaultValue: "",
  editorTitle: "Roam graph name",
  glassesEditTitle: "Edit Roam graph",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
  formatValue: emptySettingDisplay,
  description: "Name of the Roam Research graph the Roam app reads and writes (as shown in Roam's graph switcher).",
});

export const roamApiTokenSetting = new ConfigSettingString({
  id: "roam-api-token",
  label: "Roam API token",
  storageKey: "integrations.roam.apiToken",
  defaultValue: "",
  editorTitle: "Roam API token (roam-graph-token-...)",
  glassesEditTitle: "Edit Roam token",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
  formatValue: maskToken,
  description: "API token for the graph, created in Roam under Settings > Graph > API tokens. Needs edit access for checking off todos.",
});

export const nightscoutSiteUrlSetting = new ConfigSettingString({
  id: "nightscout-site-url",
  label: "Nightscout site URL",
  storageKey: "integrations.nightscout.siteUrl",
  defaultValue: "",
  editorTitle: "Nightscout site URL",
  glassesEditTitle: "Edit Nightscout URL",
  normalize: normalizeNightscoutSiteUrl,
  formatValue: emptySettingDisplay,
  description: "Base URL of a Nightscout site to fetch glucose readings from, for the dashboard's glucose card.",
});

export const nightscoutApiTokenSetting = new ConfigSettingString({
  id: "nightscout-api-token",
  label: "Nightscout API token",
  storageKey: "integrations.nightscout.apiToken",
  defaultValue: "",
  editorTitle: "Nightscout API token",
  glassesEditTitle: "Edit API token",
  normalize: normalizeNightscoutApiToken,
  formatValue: maskToken,
  description: "Access token for the Nightscout site's API.",
});

function nightscoutThresholdSetting(id: string, label: string, unit: string, description: string): ConfigSettingString {
  return new ConfigSettingString({
    id: `nightscout-${id}`,
    label,
    storageKey: `integrations.nightscout.${id}`,
    defaultValue: "0",
    editorTitle: `${label} (${unit}; 0 = off)`,
    normalize: normalizeNightscoutThreshold,
    formatValue: (value) => Number(value) > 0 ? `${value} ${unit}` : "Off",
    description: `${description} Enter 0 to disable.`,
  });
}

export const nightscoutMaxCannulaAgeSetting = nightscoutThresholdSetting(
  "max-cannula-age-hours", "Max cannula age", "h", "Warn when time since the last site change exceeds this many hours.",
);
export const nightscoutCartridgeLowSetting = nightscoutThresholdSetting(
  "cartridge-low-units", "Cartridge low threshold", "U", "Warn when the pump reservoir falls below this many units.",
);
export const nightscoutBatteryLowSetting = nightscoutThresholdSetting(
  "battery-low-voltage", "Battery voltage threshold", "V", "Warn when pump battery voltage falls below this value.",
);
export const nightscoutMaxLoopAgeSetting = nightscoutThresholdSetting(
  "max-loop-age-minutes", "Max time since last loop", "min", "Warn when time since the last loop exceeds this many minutes.",
);
export const nightscoutAlwaysShowInTopBarSetting = new ConfigSettingBoolean({
  id: "nightscout-always-show-in-top-bar",
  label: "Always show in status bar",
  storageKey: "integrations.nightscout.alwaysShowInTopBar",
  defaultValue: false,
  description: "Keep the Nightscout glucose graph and warnings in the top bar even when all Nightscout windows are closed.",
});
export const nightscoutMissedBolusAlertsSetting = new ConfigSettingBoolean({
  id: "nightscout-missed-bolus-alerts",
  label: "Missed-bolus alerts",
  storageKey: "integrations.nightscout.missedBolusAlerts",
  defaultValue: false,
  description: "Show a notification on the glasses when glucose rises like an unannounced meal with no bolus or carbs entered. Experimental.",
});
export const nightscoutMissedBolusCooldownSetting = new ConfigSettingString({
  id: "nightscout-missed-bolus-cooldown-minutes",
  label: "Missed-bolus alert cooldown",
  storageKey: "integrations.nightscout.missedBolusCooldownMinutes",
  defaultValue: "120",
  editorTitle: "Missed-bolus alert cooldown (min)",
  normalize: normalizeNightscoutThreshold,
  formatValue: (value) => `${value} min`,
  description: "After a missed-bolus alert, wait at least this many minutes before showing another.",
});

export function loadNightscoutThresholds(): NightscoutThresholds {
  return {
    maxCannulaAgeHours: Number(nightscoutMaxCannulaAgeSetting.get()),
    cartridgeLowUnits: Number(nightscoutCartridgeLowSetting.get()),
    batteryLowVoltage: Number(nightscoutBatteryLowSetting.get()),
    maxLoopAgeMinutes: Number(nightscoutMaxLoopAgeSetting.get()),
  };
}

// ---------------------------------------------------------------------------
// Navigate app: saved and recent destinations.

const stripControlChars = (value: string | null | undefined): string =>
  (value ?? "").replace(/[\x00-\x1f]+/g, "").trim();

export const navigateHomeAddressSetting = new ConfigSettingString({
  id: "navigate-home-address",
  label: "Home address",
  storageKey: "navigate.homeAddress",
  defaultValue: "",
  editorTitle: "Home address",
  glassesEditTitle: "Set Home address",
  normalize: stripControlChars,
  formatValue: emptySettingDisplay,
  description: "Address (or place name) the Navigate app's Home destination routes to.",
});

export const navigateWorkAddressSetting = new ConfigSettingString({
  id: "navigate-work-address",
  label: "Work address",
  storageKey: "navigate.workAddress",
  defaultValue: "",
  editorTitle: "Work address",
  glassesEditTitle: "Set Work address",
  normalize: stripControlChars,
  formatValue: emptySettingDisplay,
  description: "Address (or place name) the Navigate app's Work destination routes to.",
});

export const navigateRememberRecentSetting = new ConfigSettingBoolean({
  id: "navigate-remember-recent",
  label: "Remember recent destinations",
  storageKey: "navigate.rememberRecent",
  defaultValue: true,
  description:
    "Keep a short list of places you have navigated to, offered as destinations on the Navigate app's start page. Turning this off clears the list.",
});

/**
 * Custom named destinations beyond Home and Work, as a JSON array of
 * {id, name, address}. Managed inside the Navigate app (its context menu),
 * not listed in the Settings app.
 */
export const navigateSavedDestinationsSetting = new ConfigSettingString({
  id: "navigate-saved-destinations",
  label: "Saved destinations",
  storageKey: "navigate.savedDestinations",
  defaultValue: "[]",
});

/**
 * Recently navigated-to places, as a JSON array of {name, place, longitude,
 * latitude, atMs}, most recent first. Written by the Navigate app when
 * navigateRememberRecentSetting is on.
 */
export const navigateRecentDestinationsSetting = new ConfigSettingString({
  id: "navigate-recent-destinations",
  label: "Recent destinations",
  storageKey: "navigate.recentDestinations",
  defaultValue: "[]",
});

/**
 * Staging buffers for the Navigate app's add/edit-destination flow: the
 * worker asks the shell to open the phone text editor on one of these, the
 * user types (or dictates) the name/address, and the worker reads the draft
 * when the user confirms on the glasses. Deliberately not listed in the
 * Settings app.
 */
export const navigateDestinationNameDraftSetting = new ConfigSettingString({
  id: "navigate-destination-name-draft",
  label: "Destination name",
  storageKey: "navigate.destinationNameDraft",
  defaultValue: "",
  editorTitle: "Destination name (e.g. Gym)",
  glassesEditTitle: "Destination name",
  normalize: stripControlChars,
});

export const navigateDestinationAddressDraftSetting = new ConfigSettingString({
  id: "navigate-destination-address-draft",
  label: "Destination address",
  storageKey: "navigate.destinationAddressDraft",
  defaultValue: "",
  editorTitle: "Destination address or place name",
  glassesEditTitle: "Destination address",
  normalize: stripControlChars,
});


export function screenTimeoutSettingToMs(value: ScreenTimeoutSetting): number | null {
  switch (value) {
    case "15s":
      return 15_000;
    case "30s":
      return 30_000;
    case "1m":
      return 60_000;
    case "3m":
      return 180_000;
    case "never":
      return null;
  }
}

export function brightnessLabel(value: BrightnessSetting): string {
  return value === "auto" ? "Auto" : value;
}

/** The exact level for the wire, or null when the ambient sensor drives it. */
export function brightnessSettingToLevel(value: BrightnessSetting): number | null {
  return value === "auto" ? null : Number(value);
}

export function screenTimeoutLabel(value: ScreenTimeoutSetting): string {
  return value === "never" ? "Never" : value;
}

export function batteryDisplayModeLabel(value: BatteryDisplayMode): string {
  if (value === "percentage") return "Percentage";
  if (value === "stacked") return "Stacked";
  if (value === "stacked-percentage") return "Stacked percentage";
  if (value === "dense") return "Dense";
  return "Icon";
}

export function batteryIndicatorVisibilityLabel(value: BatteryIndicatorVisibility): string {
  if (value === "never") return "Never";
  if (value === "low") return `Below ${BATTERY_LOW_VISIBILITY_THRESHOLD}%`;
  return "Always";
}

export function timeFormatLabel(value: TimeFormat): string {
  return value === "12h" ? "12-hour" : "24-hour";
}

export function loadNightscoutSettings(): NightscoutSettings {
  return {
    siteUrl: nightscoutSiteUrlSetting.get(),
    apiToken: nightscoutApiTokenSetting.get(),
  };
}

export function isNightscoutSettingsConfigured(): boolean {
  return nightscoutSiteUrlSetting.get().length > 0 && nightscoutApiTokenSetting.get().length > 0;
}


function normalizeNightscoutSiteUrl(siteUrl: string | null | undefined): string {
  return (siteUrl ?? "").replace(/[\x00-\x1f]+/g, "").trim().replace(/\/+$/, "");
}

function normalizeNightscoutApiToken(apiToken: string | null | undefined): string {
  return (apiToken ?? "").replace(/[\x00-\x1f]+/g, "").trim();
}

function emptySettingDisplay(value: string): string {
  return value || "(empty)";
}

function maskToken(token: string): string {
  if (!token) return "(empty)";
  return token.length <= 6 ? "******" : `${token.slice(0, 2)}...${token.slice(-4)}`;
}


type SettingsMenuOptions<T> = {
  onChange?: (ctx: LayerContext, newValue: T, oldValue: T) => void
  /** Row label in place of the setting's own (for a setting shown in more than one menu). */
  label?: string
}

export function enumSettingMenuItem<TValue extends string, TId extends string = string>(
  setting: ConfigSettingEnum<TValue, TId>,
  opts?: SettingsMenuOptions<TValue>
): MenuItem {
  const label = opts?.label ?? setting.label;
  return {
    label,
    description: setting.description,
    onSelect: (ctx) => {
      const current = setting.get();
      const items = setting.values.map((value): MenuItem => ({
        label: setting.displayValue(value),
        disabled: () => setting.isDisabled(value),
        onSelect: () => {
          const oldValue = setting.get();
          setting.set(value);
          opts?.onChange?.(ctx, value, oldValue);
          ctx.stack.pop();
        },
        render: ({ image, x, y, disabled }) => {
          const selected = setting.get() === value ? " *" : "";
          image.drawText(
            getDefaultSmallFont(),
            x,
            y + LIST_ROW_TEXT_INSET,
            `${setting.displayValue(value)}${selected}`,
            disabled ? 70 : 200,
          );
        },
      }));
      openModalMenu(ctx, label, items, Math.max(0, setting.values.indexOf(current)));
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, setting.displayValue(setting.get()));
    },
  };
}

export function toggleSettingMenuItem<TId extends string = string>(
  setting: ConfigSettingBoolean<TId>,
   opts?: SettingsMenuOptions<boolean>
): MenuItem {
  const label = opts?.label ?? setting.label;
  return {
    label,
    description: setting.description,
    onSelect: (ctx) => {
      setting.set(!setting.get());
      opts?.onChange?.(ctx, setting.get(), !setting.get());
    },
    render: ({ image, x, y, width, selected }) => {
      drawToggleMenuItem(image, getDefaultSmallFont(), x, y, width, label, setting.get(), selected);
    },
  };
}

export function textSettingMenuItem<TId extends string = string>(
  setting: ConfigSettingString<TId>,
): MenuItem {
  return {
    label: setting.label,
    description: setting.description,
    onSelect: (ctx: LayerContext) => {
      void ctx.actions.startTextSettingEdit(setting);
      ctx.stack.push(new EditTextSettingLayer(setting));
    },
    render: ({ image, x, y, width }) => {
      // displayValue honors the setting's formatValue, so secrets (API keys,
      // tokens) can mask themselves instead of rendering in the clear.
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, setting.label, truncateSetting(setting.displayValue()));
    }
  };
}

function truncateSetting(value: string, maxLength = 22): string {
  const text = value || "(empty)";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export class EditTextSettingLayer implements Layer {
  constructor(private readonly setting: ConfigSettingString) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    // Sized to the hosting stack (full lens in the dashboard window, app
    // viewport in the settings app).
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font);
    image.drawText(font, 22, 16, this.setting.glassesEditTitle, 220);
    const messageTop = 24 + 2 * font.lineHeight;
    const message = wrapText(font, "Look at the phone app to type a value.", width - 48);
    for (let index = 0; index < message.length; index++) {
      image.drawText(font, 22, messageTop + index * step, message[index]!, 200);
    }
    image.drawText(font, 22, messageTop + (message.length + 2) * step, truncateSetting(this.setting.get(), 52), 220);
    const error = this.setting.validationError();
    if (error) wrapText(font, error, width - 48).forEach((line, index) =>
      image.drawText(font, 22, messageTop + (message.length + 4 + index) * step, line, 180));
    image.drawText(font, 22, height - 24 - font.lineHeight, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.endTextSettingEdit();
      ctx.stack.pop();
    }
  }
}
