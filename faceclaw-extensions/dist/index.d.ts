/**
 * faceclaw-extensions — type definitions for the Faceclaw extension API.
 *
 * Faceclaw (https://github.com/…/faceclaw) is an alternative host for EvenHub
 * apps that runs them directly on the Even Realities G2 glasses instead of the
 * stock Even app. An app built against the standard `@evenrealities/even_hub_sdk`
 * runs unchanged. When it happens to be running inside Faceclaw, this package
 * lets it detect that and reach a few extra, Faceclaw-only capabilities.
 *
 * Design contract:
 *  - The only entry point is the injected global `window.getFaceclawExtensions`.
 *    It is `(() => FaceclawExtensions) | null` inside Faceclaw and `undefined`
 *    in the stock Even app (and any other host). Nothing on the standard SDK or
 *    on built-in prototypes is modified — every Faceclaw capability lives behind
 *    this one global, so it is always obvious what is an extension and standard
 *    apps keep working everywhere.
 *  - New functionality is only ever *added* here; existing members keep their
 *    behavior, so pinning a version stays backwards-compatible.
 *
 * Usage:
 * ```ts
 * import { getFaceclawExtensions } from "faceclaw-extensions";
 *
 * const fc = getFaceclawExtensions();
 * if (fc) {
 *   console.log("Running in", fc.getVersion()); // "Faceclaw/0.4.0"
 *   fc.addWindowLifecycleListener((e) => {
 *     if (e.type === "hidden") pauseExpensiveWork();
 *   });
 * }
 * ```
 */
/** Third-party API-key services whose keys the user may have configured in Faceclaw. */
export type ApiKeyService = "openai" | "anthropic" | "soniox" | "elevenlabs" | "mapbox";
/**
 * One step of a piezo-buzzer tone sequence. The G2 has a single monophonic PWM
 * buzzer; a sequence plays back-to-back steps on the firmware's own timer.
 */
export interface BuzzerStep {
    /** Tone frequency in Hz. The piezo is loudest ~1–4 kHz; faint below ~150 Hz. */
    freq: number;
    /** Step duration in milliseconds (1–65535). */
    ms: number;
    /** PWM duty cycle, 0–100 (default 50). `duty: 0` is a rest (silence) for `ms`. */
    duty?: number;
}
/**
 * Window lifecycle transitions, delivered to
 * {@link FaceclawExtensions.addWindowLifecycleListener}:
 *  - `visible` / `hidden`: the app's glasses window became the shown surface, or
 *    stopped being it — because the user switched the foreground window or the
 *    phone screen turned on/off. A hidden app keeps running (Faceclaw keeps its
 *    webview alive) but nothing it renders reaches the glasses.
 *  - `focused` / `blurred`: input focus moved onto or off the app's window (e.g.
 *    the user opened the app switcher). A blurred-but-visible app is still shown
 *    but no longer receives taps/scrolls.
 *
 * An app can assume it starts `visible` and `focused` at launch; events report
 * changes from there.
 */
export type WindowLifecycleEventType = "visible" | "hidden" | "focused" | "blurred";
export interface WindowLifecycleEvent {
    type: WindowLifecycleEventType;
}
/**
 * A magnetometer heading sample from {@link FaceclawExtensions.addCompassListener}.
 * All headings are degrees clockwise in [0, 360).
 */
export interface CompassReading {
    /**
     * Raw magnetic heading as reported by the glasses, with no correction for
     * how they sit on the wearer's head. Kept for apps that zero it themselves.
     */
    headingDegrees: number;
    /**
     * Magnetic heading corrected by the wearer's calibration offset from the
     * host's Compass app. Equal to `headingDegrees` until they calibrate.
     */
    magneticHeadingDegrees: number;
    /**
     * Whether the wearer has been through the host's compass calibration, i.e.
     * whether `magneticHeadingDegrees` and `trueHeadingDegrees` can be trusted
     * as absolute rather than relative.
     */
    wearerCalibrated: boolean;
    /**
     * Local magnetic declination (east positive), from the phone's location and
     * the World Magnetic Model. Absent when the host has no location.
     */
    declinationDegrees?: number;
    /** `magneticHeadingDegrees` plus declination. Absent when declination is. */
    trueHeadingDegrees?: number;
}
export interface FaceclawContainerCommon {
    containerID: number;
    containerName: string;
    xPosition: number;
    yPosition: number;
    width: number;
    height: number;
    zOrderIndex?: number;
    isEventCapture?: 0 | 1 | boolean;
    /** Inherit content from the same-named container in the previous layout. */
    preserve?: boolean;
}
export interface FaceclawTextContainer extends FaceclawContainerCommon {
    content?: string;
    borderWidth?: number;
    borderRadius?: number;
    paddingLength?: number;
}
/** Image containers may be up to 576x452 in the extended layout. */
export type FaceclawImageContainer = FaceclawContainerCommon;
export interface FaceclawListContainer extends FaceclawContainerCommon {
    itemContainer?: {
        itemName?: string[];
        itemWidth?: number;
        isItemSelectBorderEn?: 0 | 1 | boolean;
    };
}
export interface FaceclawLayout {
    textObject?: FaceclawTextContainer[];
    imageObject?: FaceclawImageContainer[];
    listObject?: FaceclawListContainer[];
}
/**
 * A tool the app contributes to Faceclaw's voice assistant. The assistant sees
 * it namespaced by the app's package name (`app.<packageName>.<name>`); `name`
 * here is the bare, un-prefixed name.
 */
export interface AssistantTool {
    /** Bare tool name (no package prefix), e.g. `"set_color"`. */
    name: string;
    /** What the tool does — the assistant reads this to decide when to call it. */
    description: string;
    /** JSON Schema for the arguments object the assistant will pass to `handler`. */
    parameters?: object;
    /**
     * When the tool is callable: `"foreground"` (default) only while the app owns
     * the visible window; `"open"` any time the app is running (even backgrounded).
     */
    availability?: "open" | "foreground";
    /**
     * Invoked when the assistant calls the tool. Return a string (or any
     * JSON-serializable value) to report back to the assistant; throw to report an
     * error. May be async.
     */
    handler: (args: any) => unknown | Promise<unknown>;
}
/**
 * The Faceclaw-only capability surface. Obtained via {@link getFaceclawExtensions}.
 * Every method is additive to the standard EvenHub SDK.
 */
export interface FaceclawExtensions {
    /** Host version string, e.g. `"Faceclaw/0.4.0"`. */
    getVersion(): string;
    /**
     * Hand input focus back to Faceclaw's app switcher without closing the app
     * (it keeps running in the background). Equivalent to the user double-tapping
     * out, but explicit.
     */
    returnToAppSwitcher(): void;
    /**
     * Close this app for real and tear down its window. Unlike the stock
     * `shutDownPageContainer(1)` — which Faceclaw interprets as "return to the app
     * switcher" so double-tap-to-quit apps stay alive — this always quits.
     */
    quit(): void;
    /**
     * Subscribe to window lifecycle changes (see {@link WindowLifecycleEvent}).
     * Returns an unsubscribe function.
     */
    addWindowLifecycleListener(listener: (event: WindowLifecycleEvent) => void): () => void;
    /**
     * List which API-key services the user has configured in Faceclaw. Returns
     * only the service names, never the key values — use
     * {@link requestApiKeyAccess} to obtain values (with the user's consent).
     */
    getConfiguredApiKeys(): Promise<ApiKeyService[]>;
    /**
     * Ask the user to share one or more configured API keys with this app. Opens
     * a consent prompt on the glasses. Resolves with a map of the granted keys'
     * values (only for services that are both requested and configured); services
     * the user declines, or that aren't configured, are absent. Resolves with an
     * empty object if the user denies.
     */
    requestApiKeyAccess(services: ApiKeyService[]): Promise<Partial<Record<ApiKeyService, string>>>;
    /**
     * Play a tone sequence on the glasses' piezo buzzer. Sequences longer than the
     * firmware's per-message cap (48 steps) are split and paced automatically.
     * Resolves once every message has been queued.
     */
    playBuzzer(steps: BuzzerStep[]): Promise<void>;
    /**
     * Activate the glasses' magnetometer compass and receive heading samples.
     * Returns an unsubscribe function; the sensor stays on while at least one
     * listener is registered and the app is the foreground window.
     *
     * The magnetometer sits inside the right arm, which rests against the
     * wearer's head with a slight curl that differs between wearers (and between
     * wears), so `headingDegrees` is relative. The host's Compass app lets the
     * wearer calibrate that away and adds local declination: prefer
     * `trueHeadingDegrees` when present, then `magneticHeadingDegrees`, and check
     * `wearerCalibrated` before trusting either as absolute.
     */
    addCompassListener(listener: (reading: CompassReading) => void): () => void;
    /**
     * Build the app's initial page from an extended layout (superset of the stock
     * createStartUpPageContainer — full 576x452 canvas, no container-count limit,
     * per-container `preserve`). Resolves true on success.
     */
    createLayout(layout: FaceclawLayout): Promise<boolean>;
    /**
     * Replace the current page with a new extended layout (superset of the stock
     * rebuildPageContainer). Containers marked `preserve` inherit their content
     * from the same-named container in the outgoing layout. Resolves true on success.
     */
    replaceLayout(layout: FaceclawLayout): Promise<boolean>;
    /**
     * Declare the app's voice-assistant tools, replacing any previously set. Each
     * tool's `handler` runs in the app when the assistant calls it. The assistant
     * sees the tools namespaced by the app's package name. Pass `[]` to remove all.
     */
    setAssistantTools(tools: AssistantTool[]): void;
}
declare global {
    interface Window {
        /** Injected by Faceclaw; `undefined` in the stock Even app and other hosts. */
        getFaceclawExtensions?: (() => FaceclawExtensions) | null;
    }
}
/**
 * Return the Faceclaw extension API if the app is running inside Faceclaw, or
 * `null` otherwise (the stock Even app, a browser, etc.). Safe to call anywhere.
 */
export declare function getFaceclawExtensions(): FaceclawExtensions | null;
