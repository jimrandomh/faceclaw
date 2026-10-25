/**
 * Types and a small helper for the Faceclaw extension API.
 *
 * [Faceclaw](https://github.com/jimrandomh/faceclaw) is an alternative host for
 * EvenHub apps: it runs them on the Even Realities G2 glasses without the stock
 * Even app. An app built against the standard `@evenrealities/even_hub_sdk`
 * runs unchanged. This package lets such an app detect that it is running
 * inside Faceclaw and use a few extra, Faceclaw-only capabilities.
 *
 * The only entry point is the injected global `window.getFaceclawExtensions`,
 * which is a function inside Faceclaw and `undefined` in the stock Even app and
 * every other host. Nothing on the standard SDK, on `window`, or on any built-in
 * prototype is modified, so an app that uses these extensions still runs
 * everywhere else; it just skips the extras.
 *
 * @example
 * ```ts
 * import { getFaceclawExtensions } from "@faceclaw/evenhub-extensions";
 *
 * const fc = getFaceclawExtensions();
 * if (fc) {
 *   console.log("Running in", fc.getVersion()); // "Faceclaw/0.8.2"
 *   fc.addWindowLifecycleListener((e) => {
 *     if (e.type === "hidden") pauseExpensiveWork();
 *   });
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * Third-party services whose API keys the user may have configured in Faceclaw.
 *
 * @group API keys
 */
export type ApiKeyService = "openai" | "anthropic" | "soniox" | "elevenlabs" | "mapbox";

/**
 * One step of a piezo-buzzer tone sequence. The G2 has a single monophonic PWM
 * buzzer, and the firmware plays a sequence's steps back to back on its own timer.
 *
 * @group Buzzer
 */
export interface BuzzerStep {
  /** Tone frequency in Hz. The piezo is loudest around 1–4 kHz and faint below about 150 Hz. */
  freq: number;
  /** Step duration in milliseconds (1–65535). */
  ms: number;
  /**
   * PWM duty cycle, 0–100. Use `duty: 0` for a rest (silence) lasting `ms`.
   * @defaultValue 50
   */
  duty?: number;
}

/**
 * A window lifecycle transition, delivered to
 * {@link FaceclawExtensions.addWindowLifecycleListener}.
 *
 * - `visible` / `hidden`: the app's glasses window became the shown surface, or
 *   stopped being it. This happens when the user switches the foreground window
 *   or the phone screen turns on or off. A hidden app keeps running (Faceclaw
 *   keeps its webview alive), but nothing it renders reaches the glasses.
 * - `focused` / `blurred`: input focus moved onto or off the app's window (for
 *   example, the user opened the app switcher). A blurred app can still be
 *   visible, but it doesn't receive taps or scrolls.
 *
 * An app can assume it starts `visible` and `focused` at launch. Events report
 * changes from there.
 *
 * @group Window
 */
export type WindowLifecycleEventType = "visible" | "hidden" | "focused" | "blurred";

/**
 * Payload of a {@link FaceclawExtensions.addWindowLifecycleListener} callback.
 *
 * @group Window
 */
export interface WindowLifecycleEvent {
  /** Which transition happened. */
  type: WindowLifecycleEventType;
}

/**
 * An image for {@link FaceclawExtensions.setWindowIcon}. An `ImageData` (from
 * a canvas's `getImageData`) fits this shape and can be passed directly.
 *
 * Draw it like Faceclaw's own icons: light strokes on black. Brightness is
 * coverage, so black is transparent, and Faceclaw inverts the icon for the
 * selected window. The switcher draws icons at about 32×32; larger images are
 * scaled down to fit, keeping their aspect ratio.
 *
 * @group Window
 */
export interface WindowIconImage {
  /** Width in pixels, 1–256. */
  width: number;
  /** Height in pixels, 1–256. */
  height: number;
  /**
   * Pixels in rows from the top left: either `width * height` grayscale
   * values (0–255), or `width * height * 4` RGBA values, which Faceclaw
   * converts to grayscale (luminance times alpha).
   */
  data: ArrayLike<number>;
}

// ---- Input ----

/**
 * The device an input came from:
 *
 * - `ring`: the Even R1 ring (or the ring pad in Faceclaw's phone app).
 * - `left-touchpad` / `right-touchpad`: the touch areas on the glasses' arms.
 * - `watch`: Faceclaw's Wear OS watch remote (or the watch pad in Faceclaw's
 *   phone app).
 *
 * @group Input
 */
export type InputSource = "ring" | "left-touchpad" | "right-touchpad" | "watch";

/**
 * A touch-down, from {@link FaceclawExtensions.addTouchDownListener}.
 *
 * @group Input
 */
export interface TouchDownEvent {
  /**
   * Which device was touched. Currently always `ring` or `watch`: the
   * glasses' touchpads don't report touch-down.
   */
  source: InputSource;
  /** When Faceclaw received the touch, in milliseconds since the epoch (comparable with `Date.now()`). */
  timestampMs: number;
}

/**
 * Which device produced a stock EvenHub gesture event, or `null` if Faceclaw
 * didn't say.
 *
 * The stock `eventSource` field only knows the stock devices, so Faceclaw
 * reports the watch there as the ring. Faceclaw adds the real device to the
 * event's raw JSON as `faceclawInputSource`, and this function reads it. Pass
 * the event object your `onEvenHubEvent` handler receives.
 *
 * Faceclaw adds the field to clicks, double-clicks, long-presses and their
 * releases, and scrolls, in both `sysEvent` and `listEvent`. It is missing when
 * the glasses don't report a scroll's source, on non-gesture events, and in
 * every other host.
 *
 * @example
 * ```ts
 * bridge.onEvenHubEvent((event) => {
 *   if (event.sysEvent && getInputSource(event) === "watch") {
 *     // ...
 *   }
 * });
 * ```
 *
 * @group Input
 */
export function getInputSource(event: { jsonData?: Record<string, unknown> } | null | undefined): InputSource | null {
  const value = event?.jsonData?.faceclawInputSource;
  return value === "ring" || value === "left-touchpad" || value === "right-touchpad" || value === "watch" ? value : null;
}

// ---- Text input ----

/**
 * Text sent to the app, from {@link FaceclawExtensions.addTextInputListener}.
 *
 * @group Text input
 */
export interface TextInputEvent {
  /** The finished text: a whole dictation, or a typed entry. */
  text: string;
  /**
   * Present when the sender said whether to submit the text (`true`, like
   * pressing Enter after it) or only insert it (`false`). Faceclaw's
   * remote-input tool sets it; dictation and the phone keyboard leave it out.
   */
  submit?: boolean;
}

/**
 * A magnetometer heading sample from {@link FaceclawExtensions.addCompassListener}.
 * All headings are in degrees clockwise, in the range [0, 360).
 *
 * Prefer `trueHeadingDegrees` when it is present, then `magneticHeadingDegrees`.
 * If `wearerCalibrated` is false, treat both as relative headings, or let the
 * user zero them.
 *
 * @group Compass
 */
export interface CompassReading {
  /**
   * Raw magnetic heading as reported by the glasses, with no correction for how
   * they sit on the wearer's head. It is kept for apps that zero it themselves.
   */
  headingDegrees: number;
  /**
   * Magnetic heading corrected by the wearer's calibration offset from
   * Faceclaw's Compass app. Equal to `headingDegrees` until the wearer calibrates.
   */
  magneticHeadingDegrees: number;
  /**
   * Whether the wearer has calibrated the compass in Faceclaw's Compass app.
   * Only trust `magneticHeadingDegrees` and `trueHeadingDegrees` as absolute
   * headings when this is true.
   */
  wearerCalibrated: boolean;
  /**
   * Local magnetic declination in degrees (east positive), computed from the
   * phone's location and the World Magnetic Model. Absent when Faceclaw has no
   * location fix or no location permission.
   */
  declinationDegrees?: number;
  /** `magneticHeadingDegrees` plus declination. Absent when `declinationDegrees` is. */
  trueHeadingDegrees?: number;
}

// ---- Fonts ----

/**
 * A font for text and list containers in an extended layout, from
 * {@link FaceclawLayout.font} and the containers' own `font`. A container
 * that has no font, and whose layout has none, uses the stock firmware font.
 *
 * Available families (see {@link FaceclawExtensions.getFonts}):
 *
 * - `Roboto`, `Inter`, `Montserrat` and `Roboto Mono`: bundled TrueType
 *   fonts in weights 300, 400 and 700, at any size.
 * - `Terminus`: a monospace bitmap font, in sizes 12, 14, 16, 18, 20, 22, 24,
 *   28 and 32, and weights 400 and 700.
 * - `EvenHub`: the stock firmware font, 20px only. Use it to bring back the
 *   stock font for one container when the layout sets another.
 * - Any font the user has installed in Faceclaw.
 *
 * Text in the stock font wraps exactly as on the stock firmware. Text in
 * other fonts wraps with Faceclaw's own line breaking.
 *
 * @group Fonts
 */
export interface FaceclawFont {
  /**
   * Font family, matched without regard to case, spaces or punctuation. An
   * unknown family falls back to Roboto.
   * @defaultValue "Roboto"
   */
  family?: string;
  /**
   * Size in pixels: the em size, as in CSS `font-size`. A line is somewhat
   * taller; {@link FaceclawExtensions.measureText} reports its height. 6–128.
   * Bitmap families use their nearest size.
   * @defaultValue 20
   */
  size?: number;
  /**
   * Weight, 100–900, where `"normal"` is 400 and `"bold"` is 700. The nearest
   * weight the family has is used, as CSS chooses it.
   * @defaultValue 400
   */
  weight?: number | "normal" | "bold";
}

/**
 * A font family Faceclaw can draw, from {@link FaceclawExtensions.getFonts}.
 *
 * @group Fonts
 */
export interface FaceclawFontFamily {
  /** The name to use as {@link FaceclawFont.family}. */
  family: string;
  /** The weights the family has, lightest first. */
  weights: number[];
  /** For a bitmap family, the sizes it has. Absent for a scalable family, which takes any size. */
  sizes?: number[];
  /** Whether every character has the same width. */
  monospace: boolean;
}

/**
 * The size of some text, from {@link FaceclawExtensions.measureText}.
 *
 * @group Fonts
 */
export interface TextMeasurement {
  /** Width in pixels of the widest line (lines are split at `\n`). */
  width: number;
  /** Height in pixels of one line. A text container advances by this much per line. */
  lineHeight: number;
}

// ---- Extended layout (a superset of the stock EvenHub page containers) ----

/**
 * Fields shared by every container in a {@link FaceclawLayout}. They match the
 * stock SDK's container-property classes, plus `preserve`.
 *
 * As in the stock SDK every field is optional, so the stock
 * `TextContainerProperty`, `ImageContainerProperty` and `ListContainerProperty`
 * classes can be passed directly. In practice you should set `containerID`,
 * `containerName` and the geometry on every container.
 *
 * @group Extended layout
 */
export interface FaceclawContainerCommon {
  /**
   * Container identity. Stock content updates (`textContainerUpgrade`,
   * `updateImageRawData`) address containers by this ID.
   */
  containerID?: number;
  /** Container name. `preserve` matches containers across layouts by name. */
  containerName?: string;
  /** Left edge in pixels on the 576×452 canvas. */
  xPosition?: number;
  /** Top edge in pixels on the 576×452 canvas. */
  yPosition?: number;
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Stacking order: higher values draw on top. */
  zOrderIndex?: number;
  /**
   * When set to `1`/`true`, this container receives the app's tap and scroll
   * events. Exactly one text or list container per layout should capture events.
   */
  isEventCapture?: number | boolean;
  /**
   * When true, inherit content (text, image pixels, or list items and selection)
   * from the container of the same kind and `containerName` in the previous
   * layout. Otherwise the container starts blank.
   */
  preserve?: boolean;
}

/**
 * A text container. The fields match the stock SDK's `TextContainerProperty`, plus `preserve`.
 *
 * @group Extended layout
 */
export interface FaceclawTextContainer extends FaceclawContainerCommon {
  /** Text to show. Update it later with the stock `textContainerUpgrade`. */
  content?: string;
  /**
   * Text brightness level, 0–4.
   * @defaultValue 4
   */
  textColor?: number;
  /** Border width in pixels, 0–5. Wider values are clamped. */
  borderWidth?: number;
  /** Accepted for compatibility with stock payloads. Faceclaw currently ignores it. */
  borderColor?: number;
  /** Border corner radius in pixels. */
  borderRadius?: number;
  /** Padding between the border and the text, in pixels. */
  paddingLength?: number;
  /**
   * The text's font. Its fields override the layout's
   * {@link FaceclawLayout.font} one by one. With neither, the text is in the
   * stock firmware font.
   */
  font?: FaceclawFont;
}

/**
 * An image container. The fields match the stock SDK's `ImageContainerProperty`,
 * plus `preserve`.
 *
 * In the extended layout an image container may be as large as the whole
 * 576×452 canvas; the stock limit is 288×144. Push pixels with the stock
 * `updateImageRawData`, which in Faceclaw accepts PNG, uncompressed BMP, or raw
 * grayscale sized to the container (8 bits per pixel, or 4 bits per pixel packed
 * two to a byte, high nibble first).
 *
 * @group Extended layout
 */
export type FaceclawImageContainer = FaceclawContainerCommon;

/**
 * The items of a {@link FaceclawListContainer}. Matches the stock `ListItemContainerProperty`.
 *
 * @group Extended layout
 */
export interface FaceclawListItems {
  /** Item labels, in display order. */
  itemName?: string[];
  /** Accepted for compatibility with stock payloads. The length of `itemName` is used instead. */
  itemCount?: number;
  /** Fixed width of each item's selection outline in pixels. `0` (the default) hugs the text. */
  itemWidth?: number;
  /** Whether the selected item is outlined. */
  isItemSelectBorderEn?: number | boolean;
}

/**
 * A list container. The fields match the stock SDK's `ListContainerProperty`, plus `preserve`.
 *
 * @group Extended layout
 */
export interface FaceclawListContainer extends FaceclawContainerCommon {
  /** The list's items and selection style. */
  itemContainer?: FaceclawListItems;
  /** Border width in pixels, 0–5. Wider values are clamped. */
  borderWidth?: number;
  /** Accepted for compatibility with stock payloads. Faceclaw currently ignores it. */
  borderColor?: number;
  /** Border corner radius in pixels. */
  borderRadius?: number;
  /** Padding between the border and the items, in pixels. */
  paddingLength?: number;
  /**
   * The items' font. Its fields override the layout's
   * {@link FaceclawLayout.font} one by one. With neither, the items are in
   * the stock firmware font. Each row is the font's line height plus 12
   * pixels.
   */
  font?: FaceclawFont;
}

/**
 * The page's contextual menu. Matches the stock SDK's `MenuContainerProperty`,
 * with the same limits: at most 10 items, each `itemID` a unique non-zero
 * uint32, and each `itemName` at most 32 UTF-8 bytes. Selections arrive as the
 * stock `menuItemClickEvent`.
 *
 * @group Extended layout
 */
export interface FaceclawMenu {
  /** Menu entries, in display order. */
  menuItems?: { itemName?: string; itemID?: number }[];
}

/**
 * A page layout for {@link FaceclawExtensions.createLayout} and
 * {@link FaceclawExtensions.replaceLayout}.
 *
 * It has the same shape as the stock `CreateStartUpPageContainer` /
 * `RebuildPageContainer`, so you can build it with the stock SDK's container
 * classes, with three differences:
 *
 * - The canvas is the full 576×452 app area instead of 576×288, so image
 *   containers may be up to 576×452.
 * - There is no limit on the number of containers.
 * - Each container may set `preserve: true` to inherit its content from the
 *   same-named container in the previous layout.
 *
 * Text and list containers can also use other fonts (see {@link FaceclawFont}).
 *
 * @group Extended layout
 */
export interface FaceclawLayout {
  /** Text containers. */
  textObject?: FaceclawTextContainer[];
  /** Image containers. */
  imageObject?: FaceclawImageContainer[];
  /** List containers. */
  listObject?: FaceclawListContainer[];
  /** The page's contextual menu. Omit it to clear any previous menu. */
  menuObject?: FaceclawMenu;
  /** Accepted for compatibility with stock payloads and ignored: there is no container limit. */
  containerTotalNum?: number;
  /** The default font for every text and list container in the layout. */
  font?: FaceclawFont;
}

// ---- Voice-assistant tools ----

/**
 * A JSON Schema object describing a tool's arguments.
 *
 * @group Assistant tools
 */
export type JsonSchema = Record<string, unknown>;

/**
 * A tool the app contributes to Faceclaw's voice assistant, for use with
 * {@link FaceclawExtensions.setAssistantTools}.
 *
 * The assistant sees the tool namespaced by the app's package name, as
 * `app.<packageName>.<name>`. `name` here is the bare name without that prefix.
 *
 * @typeParam Args - The arguments object the assistant passes to `handler`,
 *   as described by `parameters`.
 *
 * @group Assistant tools
 */
export interface AssistantTool<Args = any> {
  /**
   * Bare tool name (no package prefix), for example `"set_color"`: 1–64
   * letters, digits, underscores or hyphens.
   */
  name: string;
  /** What the tool does. The assistant reads this to decide when to call it. */
  description: string;
  /**
   * JSON Schema for the arguments object the assistant will pass to `handler`.
   * It must describe an object (`type: "object"`), with any `properties` an
   * object and any `required` an array of names, and must not use `oneOf`,
   * `anyOf` or `allOf` at the top level. These are the schemas the
   * assistant's model providers accept.
   * @defaultValue { type: "object", properties: {} }
   */
  parameters?: JsonSchema;
  /**
   * When the tool can be called: `"foreground"` only while the app owns the
   * visible window, or `"open"` any time the app is running, including in the
   * background.
   * @defaultValue "foreground"
   */
  availability?: "open" | "foreground";
  /**
   * Called when the assistant invokes the tool. Return a string, or any
   * JSON-serializable value, to report back to the assistant. Throw (or reject)
   * to report an error. May be async, but must finish within 10 seconds, or
   * the assistant is told the tool timed out.
   */
  handler: (args: Args) => unknown;
}

/**
 * The Faceclaw-only capability surface, obtained with {@link getFaceclawExtensions}.
 * Everything here is in addition to the standard EvenHub SDK.
 *
 * Calls that return a promise reject with an `Error` if the host fails to
 * carry them out.
 *
 * @group Entry point
 */
export interface FaceclawExtensions {
  /**
   * The extension API level the host implements. It is `1` for the API
   * described here (Faceclaw 0.8.3 and later), and increases by one each time
   * members are added. Members added later are documented with the level that
   * introduced them, so an app can check for them before calling:
   *
   * ```ts
   * if (fc.apiVersion >= 2) fc.someNewerMethod();
   * ```
   */
  readonly apiVersion: number;

  /**
   * The host's name and version, for example `"Faceclaw/0.8.2"`. For display
   * and logging; use {@link FaceclawExtensions.apiVersion} for feature checks.
   */
  getVersion(): string;

  /**
   * Hand input focus back to Faceclaw's app switcher without closing the app,
   * which keeps running in the background.
   */
  returnToAppSwitcher(): void;

  /**
   * Close this app and tear down its window.
   *
   * Faceclaw treats the stock `shutDownPageContainer(1)` as "return to the app
   * switcher", so apps that quit on double-tap stay alive. This method always
   * quits.
   */
  quit(): void;

  /**
   * Subscribe to window lifecycle changes (see {@link WindowLifecycleEventType}).
   *
   * @param listener - Called on each transition.
   * @returns A function that unsubscribes `listener`.
   */
  addWindowLifecycleListener(listener: (event: WindowLifecycleEvent) => void): () => void;

  /**
   * List the services whose API keys the user has configured in Faceclaw. This
   * returns only the service names, never the keys, and doesn't prompt the user.
   * Use {@link FaceclawExtensions.requestApiKeyAccess} to obtain the keys.
   */
  getConfiguredApiKeys(): Promise<ApiKeyService[]>;

  /**
   * Ask the user to share one or more configured API keys with this app. This
   * opens a consent prompt on the glasses, unless the user already granted
   * these services to this app earlier in the session.
   *
   * @param services - The services whose keys the app wants.
   * @returns A map from service to key, containing only the services that were
   *   both requested and configured. It is empty if the user declines.
   */
  requestApiKeyAccess(services: ApiKeyService[]): Promise<Partial<Record<ApiKeyService, string>>>;

  /**
   * Play a tone sequence on the glasses' piezo buzzer. Sequences longer than the
   * firmware's per-message limit of 48 steps are split and paced automatically.
   *
   * @returns A promise that resolves once every part of the sequence has been
   *   queued on the glasses, which can be before it finishes playing. It
   *   rejects if sending to the glasses fails. If the glasses aren't
   *   connected, the sequence is dropped and the promise still resolves.
   */
  playBuzzer(steps: BuzzerStep[]): Promise<void>;

  /**
   * Turn on the glasses' magnetometer and receive heading samples. The sensor
   * stays on while at least one listener is registered, and readings are only
   * delivered while the app is the foreground window.
   *
   * The magnetometer sits inside the right arm, which rests against the wearer's
   * head at an angle that differs between wearers (and between wears), so the
   * raw heading is only relative. See {@link CompassReading} for the corrected
   * headings and when to trust them.
   *
   * @param listener - Called with each sample.
   * @returns A function that unsubscribes `listener`.
   */
  addCompassListener(listener: (reading: CompassReading) => void): () => void;

  /**
   * Build the app's page from an extended layout. This is a superset of the
   * stock `createStartUpPageContainer`; see {@link FaceclawLayout} for the
   * differences.
   *
   * Unlike the stock call it may be called more than once. Once an app uses an
   * extended layout, its window stays at the full 576×452 size for the rest of
   * the session, including for later stock `rebuildPageContainer` calls.
   *
   * @returns A promise that resolves to true on success.
   */
  createLayout(layout: FaceclawLayout): Promise<boolean>;

  /**
   * Replace the current page with a new extended layout. This is a superset of
   * the stock `rebuildPageContainer`. Containers marked `preserve` inherit
   * their content from the same-named container in the outgoing layout.
   *
   * @returns A promise that resolves to true on success.
   */
  replaceLayout(layout: FaceclawLayout): Promise<boolean>;

  /**
   * Declare the app's voice-assistant tools, replacing any set earlier. Each
   * tool's `handler` runs in the app when the assistant calls it.
   *
   * Faceclaw skips a tool whose `name` or `parameters` break the rules in
   * {@link AssistantTool}, and logs a warning to the app's console saying why.
   *
   * @param tools - The tools to offer. Pass `[]` to remove them all.
   */
  setAssistantTools(tools: AssistantTool[]): void;

  /**
   * Receive touch-downs: the moment a finger touches the ring or the watch's
   * touchpad, before Faceclaw knows whether it will become a tap, a scroll or
   * a hold. The interpreted gesture still arrives afterwards as the usual
   * stock event. Use it where latency matters, as in games.
   *
   * Touch-downs arrive only while the app's window has input focus. The
   * glasses' own touchpads don't report them.
   *
   * @param listener - Called on each touch-down.
   * @returns A function that unsubscribes `listener`.
   */
  addTouchDownListener(listener: (event: TouchDownEvent) => void): () => void;

  /**
   * Receive text the user sends to the app. While at least one listener is
   * registered and the app is in the foreground, Faceclaw offers the app as
   * the "Type Into App" destination of its voice dialog, the phone keyboard
   * and the watch.
   *
   * @param listener - Called with each piece of text.
   * @returns A function that unsubscribes `listener`.
   */
  addTextInputListener(listener: (event: TextInputEvent) => void): () => void;

  /**
   * Open Faceclaw's voice dialog for this app. When the user sends the
   * dictation with Type Into App, it arrives at the text-input listeners.
   *
   * @returns A promise that resolves to true if the dialog is opening, or
   *   false if it can't open: there is no text-input listener, the app isn't
   *   in the foreground, voice input is unavailable, or another dialog is up.
   */
  startVoiceInput(): Promise<boolean>;

  /**
   * Replace the app's icon in the app switcher, or pass `null` to go back to
   * the package's icon. See {@link WindowIconImage} for the format.
   *
   * @returns A promise that resolves once the icon is set, and rejects if the
   *   image is malformed or larger than 256×256.
   */
  setWindowIcon(icon: WindowIconImage | null): Promise<void>;

  /**
   * Show or clear the attention dot on the app's switcher icon, for example
   * when something new arrives while the app is in the background. The dot
   * stays until the app clears it or closes.
   */
  setAttention(attention: boolean): void;

  /**
   * Stop the glasses display from turning off for inactivity while the app is
   * in the foreground, as a teleprompter or navigation app needs. It has no
   * effect while another window is in front, and the user can still turn the
   * display off. Pass `false` to restore the normal timeout.
   */
  setKeepScreenOn(keepOn: boolean): void;

  /**
   * List the font families available for {@link FaceclawFont.family},
   * including any the user has installed.
   */
  getFonts(): Promise<FaceclawFontFamily[]>;

  /**
   * Measure text as a container with this font would draw it, for example to
   * size a text container or centre a label.
   *
   * @param text - The text. Lines split at `\n` are measured separately.
   * @param font - The font to measure in. Unlike a container's font, it
   *   isn't combined with a layout default. Omit it to measure in the stock
   *   font.
   */
  measureText(text: string, font?: FaceclawFont): Promise<TextMeasurement>;
}

declare global {
  interface Window {
    /**
     * Injected by Faceclaw before any page script runs. `undefined` in the
     * stock Even app and other hosts. Prefer {@link getFaceclawExtensions},
     * which checks for it. If you call it directly, check that the result's
     * `apiVersion` is a number: Faceclaw 0.8.0–0.8.2 returned an incomplete
     * preview without one.
     */
    getFaceclawExtensions?: (() => FaceclawExtensions) | null;
  }
}

/**
 * Return the Faceclaw extension API if the app is running inside Faceclaw, or
 * `null` otherwise (in the stock Even app, a browser, a simulator, or Node).
 * Safe to call anywhere, at any time; Faceclaw installs the API before any page
 * script runs.
 *
 * It also returns `null` in Faceclaw 0.8.0–0.8.2, which had an incomplete,
 * unversioned preview of the API. Whenever it returns the API, every member
 * of API level 1 is present.
 *
 * @group Entry point
 */
export function getFaceclawExtensions(): FaceclawExtensions | null {
  const getter = typeof window !== "undefined" ? window.getFaceclawExtensions : null;
  if (typeof getter !== "function") return null;
  const extensions = getter();
  // Faceclaw 0.8.0–0.8.2 injected an unversioned preview with only some of
  // the level-1 members; treat it as absent.
  return extensions && typeof extensions.apiVersion === "number" ? extensions : null;
}
