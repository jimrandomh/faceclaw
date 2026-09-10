import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "../g2/android-permissions";
import {
  isValidMacAddress,
  loadDeviceAddresses,
  saveDeviceAddresses,
} from "../g2/device-addresses";
import {
  buildCustomFirmware,
  buildStockFirmware,
  FirmwareBuildError,
  FirmwareProgress,
} from "../g2/firmware-builder";
import { buildAddressSet, DeviceDiscoveryBridge } from "../native/device-discovery";
import { FirmwareFlasher, FlashProgress, FlashState } from "../native/firmware-flasher";
import {
  FlashPromptBattery,
  FlashPromptCommunicator,
  FlashPromptState,
} from "../native/flash-prompt-communicator";
import { resumeAutoReconnect, suppressAutoReconnect } from "../g2/reconnect-policy";
import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";
import { formatErrorMessage } from "../util/format-error";

type FlashPhase = "intro" | "prompt" | "building" | "ready" | "flashing" | "flashed" | "error";

export type FlashMode = "install" | "uninstall";

// Flashing a lens takes minutes and the glasses reboot afterwards; refuse to
// start when either arm is below this so a flat battery can't interrupt it.
const MIN_FLASH_BATTERY_PERCENT = 30;

export class OnboardingFlashViewModel extends Observable {
  private readonly mode: FlashMode;
  private readonly fromOnboarding: boolean;

  private _phase: FlashPhase = "intro";
  private _headline = "Flash Custom Firmware";
  private _status = "";
  private _log = "";
  private _busy = false;
  private _progress = 0;

  private readonly discovery = new DeviceDiscoveryBridge();
  private addresses: { right: string; left: string } | null = null;
  private firmwarePath = "";

  private prompt: FlashPromptCommunicator | null = null;
  private promptUnsubscribers: Array<() => void> = [];
  private promptBattery: FlashPromptBattery | null = null;
  private flasher: FirmwareFlasher | null = null;
  private flasherUnsubscribers: Array<() => void> = [];
  private retryAction: () => void = () => this.beginPrompt();

  constructor(options?: { mode?: FlashMode; fromOnboarding?: boolean }) {
    super();
    // The flash flow needs the glasses to itself: from here on the main
    // page must not auto-reconnect, until an install succeeds (below) or
    // the user connects explicitly.
    suppressAutoReconnect();
    this.mode = options?.mode ?? "install";
    this.fromOnboarding = options?.fromOnboarding ?? true;
    this._headline = this.mode === "uninstall" ? "Uninstall Custom Firmware" : "Flash Custom Firmware";
    this._status =
      this.mode === "uninstall"
        ? "This connects to your glasses, asks for confirmation on the lens, checks the battery, then downloads " +
          "and reflashes the official firmware — removing Faceclaw's custom features."
        : "This connects to your glasses, asks for confirmation on the lens, checks the battery, then downloads, " +
          "verifies, and flashes Faceclaw's custom firmware.";
  }

  // Kept short to fit the glasses' ~50-column text grid.
  private get glassesWarning(): string {
    return this.mode === "uninstall"
      ? "Reinstalling the official firmware removes Faceclaw's custom features. Continue?"
      : "Flashing custom firmware will void your warranty and carries some risk of bricking the glasses. Continue?";
  }

  private get noun(): string {
    return this.mode === "uninstall" ? "official firmware" : "custom firmware";
  }

  // --- observable properties -------------------------------------------------

  get phase(): FlashPhase {
    return this._phase;
  }

  get headline(): string {
    return this._headline;
  }

  set headline(value: string) {
    if (this._headline !== value) {
      this._headline = value;
      this.notifyPropertyChange("headline", value);
    }
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status !== value) {
      this._status = value;
      this.notifyPropertyChange("status", value);
    }
  }

  get log(): string {
    return this._log;
  }

  set log(value: string) {
    if (this._log !== value) {
      this._log = value;
      this.notifyPropertyChange("log", value);
      this.notifyPropertyChange("logVisibility", this.logVisibility);
    }
  }

  get logVisibility(): "visible" | "collapse" {
    return this._log ? "visible" : "collapse";
  }

  get busy(): boolean {
    return this._busy;
  }

  set busy(value: boolean) {
    if (this._busy !== value) {
      this._busy = value;
      this.notifyPropertyChange("busy", value);
      this.notifyPropertyChange("busyVisibility", this.busyVisibility);
    }
  }

  get busyVisibility(): "visible" | "collapse" {
    return this._busy ? "visible" : "collapse";
  }

  get progress(): number {
    return this._progress;
  }

  set progress(value: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (this._progress !== clamped) {
      this._progress = clamped;
      this.notifyPropertyChange("progress", clamped);
    }
  }

  get progressVisibility(): "visible" | "collapse" {
    return this._phase === "flashing" ? "visible" : "collapse";
  }

  get primaryLabel(): string {
    switch (this._phase) {
      case "intro":
        return "Connect & Confirm";
      case "ready":
        return "Flash Now";
      case "flashed":
        return "Finish";
      case "error":
        return "Retry";
      default:
        return "";
    }
  }

  get secondaryLabel(): string {
    switch (this._phase) {
      case "prompt":
        return "Cancel";
      case "ready":
        return "Not Now";
      default:
        return "Back";
    }
  }

  get primaryVisibility(): "visible" | "collapse" {
    return this.primaryLabel ? "visible" : "collapse";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    // No escape hatch mid-write (building/flashing) or after success (flashed).
    return this._phase === "building" || this._phase === "flashing" || this._phase === "flashed"
      ? "collapse"
      : "visible";
  }

  // --- button handlers -------------------------------------------------------

  onPrimaryTap(): void {
    switch (this._phase) {
      case "intro":
        void this.beginPrompt();
        return;
      case "ready":
        this.startFlashing();
        return;
      case "flashed":
        this.finish();
        return;
      case "error":
        this.retryAction();
        return;
      default:
        return;
    }
  }

  onSecondaryTap(): void {
    if (this._phase === "prompt") {
      this.cancelPrompt();
      return;
    }
    if (this._phase === "building" || this._phase === "flashing" || this._phase === "flashed") {
      return;
    }
    this.leave();
  }

  // --- prompt flow -----------------------------------------------------------

  /**
   * Connect to both arms, authenticate (this is where any Android pairing
   * prompts appear), show the Yes/No confirmation on the lens, then read the
   * battery. With `skipPrompt` (retrying after a low-battery refusal, when
   * the user has already confirmed) the on-glasses confirmation is skipped
   * and only the battery is re-checked.
   */
  private async beginPrompt(options?: { skipPrompt?: boolean }): Promise<void> {
    const skipPrompt = Boolean(options?.skipPrompt);
    if (!global.isAndroid) {
      this.toError("Flashing is only available on Android.", () => this.beginPrompt(options));
      return;
    }
    this.setPhase("prompt");
    this.headline = skipPrompt ? "Checking Battery" : "Confirm On Your Glasses";
    this.log = "";
    this.busy = true;
    this.promptBattery = null;
    this.status = "Preparing to connect. Make sure your glasses are on and the Even app is disconnected.";

    try {
      await ensureBlePermissions();
      const addresses = await this.resolveAddresses();
      if (!addresses) {
        this.busy = false;
        this.toError(
          "Couldn't find both glasses arms. Make sure the glasses are powered on and the Even app is disconnected, then retry.",
          () => this.beginPrompt(options),
        );
        return;
      }
      this.addresses = addresses;

      this.status = skipPrompt
        ? "Connecting to your glasses to re-check the battery..."
        : "Connecting to your glasses. Watch the lens for a Yes/No prompt.";
      this.startCommunicator(addresses, skipPrompt);
    } catch (error) {
      this.busy = false;
      this.toError(this.formatError(error), () => this.beginPrompt(options));
    }
  }

  private startCommunicator(addresses: { right: string; left: string }, skipPrompt: boolean): void {
    this.disposePrompt();
    const prompt = new FlashPromptCommunicator(addresses, this.glassesWarning, { skipPrompt });
    this.prompt = prompt;

    this.promptUnsubscribers.push(
      prompt.onLog((line) => this.appendLog(line)),
      prompt.onStateChange((state, detail) => this.handlePromptState(state, detail, skipPrompt)),
      prompt.onBattery((battery) => {
        this.promptBattery = battery;
      }),
      prompt.onResult((approved) => this.handlePromptResult(approved, skipPrompt)),
    );
    prompt.start();
  }

  private handlePromptState(state: FlashPromptState, detail: string, skipPrompt: boolean): void {
    switch (state) {
      case "connecting":
        this.status = "Connecting to your glasses...";
        break;
      case "connected":
        this.status =
          "Connected. Pairing with both lenses — if Android asks to pair, accept it (once per lens)." +
          (skipPrompt ? "" : " Then watch the lens for the confirmation.");
        break;
      case "battery":
        this.status = "Checking the glasses' battery level...";
        break;
      case "prompting":
        this.status =
          "Look at the lens and choose Yes to flash or No to cancel. (Use the ring or a temple tap to select.)";
        break;
      case "result":
        // Handled by onResult.
        break;
      case "cancelled":
        this.busy = false;
        this.toError("Cancelled.", () => this.beginPrompt());
        break;
      case "timeout":
        this.busy = false;
        this.toError(detail || "No response from the glasses.", () => this.beginPrompt());
        break;
      case "disconnected":
        this.busy = false;
        this.toError(detail || "Lost connection to the glasses.", () => this.beginPrompt({ skipPrompt }));
        break;
      case "error":
        this.busy = false;
        this.toError(detail || "Connection failed.", () => this.beginPrompt({ skipPrompt }));
        break;
    }
  }

  private handlePromptResult(approved: boolean, skipPrompt: boolean): void {
    this.disposePrompt();
    if (!approved) {
      this.busy = false;
      this.toError("You declined on the glasses. No firmware was written.", () => this.beginPrompt());
      return;
    }
    const lowBattery = this.describeLowBattery(this.promptBattery);
    if (lowBattery) {
      this.busy = false;
      // The user already confirmed on the lens; a retry only re-checks the battery.
      this.toError(lowBattery, () => this.beginPrompt({ skipPrompt: true }), "Charge Your Glasses");
      return;
    }
    if (!this.promptBattery || (this.promptBattery.right === null && this.promptBattery.left === null)) {
      this.appendLog("battery level unknown; proceeding");
    }
    this.appendLog(skipPrompt ? "battery ok; confirmed earlier on the lens" : "confirmed on the lens; battery ok");
    void this.buildFirmware();
  }

  /** A "charge first" message when either arm is below the flashing threshold, else null. */
  private describeLowBattery(battery: FlashPromptBattery | null): string | null {
    if (!battery) {
      return null;
    }
    const readings = [
      { arm: "right", percent: battery.right },
      { arm: "left", percent: battery.left },
    ].filter((r): r is { arm: string; percent: number } => r.percent !== null);
    const low = readings.filter((r) => r.percent < MIN_FLASH_BATTERY_PERCENT);
    if (low.length === 0) {
      return null;
    }
    const levels = readings.map((r) => `${r.arm} ${r.percent}%`).join(", ");
    return (
      `The glasses' battery is too low to flash safely (${levels}). ` +
      `Charge both lenses to at least ${MIN_FLASH_BATTERY_PERCENT}%, then tap Retry to check again. ` +
      "You won't need to confirm on the lens a second time."
    );
  }

  private cancelPrompt(): void {
    this.status = "Cancelling...";
    try {
      this.prompt?.cancel();
    } catch {
      // ignore
    }
    this.disposePrompt();
    this.busy = false;
    this.toError("Cancelled.", () => this.beginPrompt());
  }

  // --- firmware build flow ---------------------------------------------------

  private async buildFirmware(): Promise<void> {
    this.setPhase("building");
    this.headline = "Preparing Firmware";
    this.busy = true;
    this.status = "Confirmed. Downloading the stock firmware...";

    try {
      const build = this.mode === "uninstall" ? buildStockFirmware : buildCustomFirmware;
      const result = await build((progress) => this.reportBuildProgress(progress));
      this.firmwarePath = result.path;
      this.busy = false;
      this.setPhase("ready");
      this.headline = "Firmware Ready";
      this.status =
        `The ${this.noun} is prepared and verified (${result.bytes.toLocaleString()} bytes).\n\n` +
        "Tap Flash Now to write it to your glasses. Keep both lenses powered on and nearby — " +
        "each lens takes a few minutes, and the glasses will reboot when each lens finishes. " +
        "Do not close the app during flashing.";
      this.appendLog(`saved to ${result.path}`);
    } catch (error) {
      this.busy = false;
      const message =
        error instanceof FirmwareBuildError ? error.message : this.formatError(error);
      this.toError(message, () => this.buildFirmware());
    }
  }

  private reportBuildProgress(progress: FirmwareProgress): void {
    switch (progress.phase) {
      case "downloading":
        this.status = "Downloading the stock firmware from Even's CDN...";
        break;
      case "verifying-base":
        this.status = "Verifying the downloaded firmware...";
        break;
      case "extracting-fonts":
        this.status = "Extracting the glasses' fonts for EvenHub apps...";
        break;
      case "patching":
        this.status = `Applying patches (${progress.applied}/${progress.total})...`;
        break;
      case "verifying-output":
        this.status = "Verifying the patched firmware...";
        break;
      case "writing":
        this.status = "Saving the prepared firmware...";
        break;
      case "done":
        break;
    }
  }

  // --- flashing flow ---------------------------------------------------------

  private startFlashing(): void {
    if (!this.addresses || !this.firmwarePath) {
      this.toError("Missing glasses addresses or firmware; start over.", () => this.beginPrompt());
      return;
    }
    this.setPhase("flashing");
    this.headline = "Flashing Firmware";
    this.busy = true;
    this.progress = 0;
    this.status = "Starting. Do not close the app or power off the glasses.";

    this.disposeFlasher();
    const flasher = new FirmwareFlasher(this.addresses, this.firmwarePath);
    this.flasher = flasher;
    this.flasherUnsubscribers.push(
      flasher.onLog((line) => this.appendLog(line)),
      flasher.onProgress((progress) => this.handleFlashProgress(progress)),
      flasher.onStateChange((state, detail) => this.handleFlashState(state, detail)),
      flasher.onComplete((success, detail) => this.handleFlashComplete(success, detail)),
    );
    flasher.start();
  }

  private handleFlashState(state: FlashState, detail: string): void {
    switch (state) {
      case "validating":
        this.status = "Validating the firmware image...";
        break;
      case "connecting":
        this.status = `Connecting to the ${detail || ""} lens...`.replace("  ", " ");
        break;
      case "flashing":
        this.status = `Flashing the ${detail || ""} lens. Keep the glasses on and nearby.`.replace("  ", " ");
        break;
      case "rebooting":
        this.status = detail || "Lenses rebooting; reconnecting...";
        break;
      case "done":
      case "error":
        // Handled by onComplete.
        break;
    }
  }

  private handleFlashProgress(progress: FlashProgress): void {
    const lensIndex = progress.lens === "right" ? 1 : 0;
    // Weight by bytes, not by component index: the image is one large segment
    // plus several small ones, so per-component steps move wildly unevenly.
    const withinLens = progress.bytesTotal > 0 ? Math.min(1, progress.bytesSent / progress.bytesTotal) : 0;
    this.progress = ((lensIndex + withinLens) / 2) * 100;
    this.status =
      `Flashing ${progress.lens} lens — part ${progress.componentIndex}/${progress.componentCount}, ` +
      `block ${progress.blockIndex}/${progress.blockCount}. Keep the glasses on and nearby.`;
  }

  private handleFlashComplete(success: boolean, detail: string): void {
    this.disposeFlasher();
    this.busy = false;
    if (success) {
      if (this.mode === "install") {
        // A successful install ends the manual-disconnected state: the main
        // page may auto-connect to the freshly flashed glasses. (After an
        // uninstall the glasses run stock firmware, which Faceclaw would
        // immediately flag as incompatible, so stay manually disconnected.)
        resumeAutoReconnect();
      }
      this.progress = 100;
      this.setPhase("flashed");
      this.headline = "All Done";
      this.status =
        detail ||
        (this.mode === "uninstall"
          ? "Official firmware reinstalled. Your glasses are rebooting into the stock firmware."
          : "Firmware installed. Your glasses are rebooting into Faceclaw's custom firmware.");
      return;
    }
    this.toError(detail || "Flashing failed.", () => this.startFlashing());
  }

  // --- helpers ---------------------------------------------------------------

  private async resolveAddresses(): Promise<{ right: string; left: string } | null> {
    const stored = loadDeviceAddresses();
    if (isValidMacAddress(stored.right) && isValidMacAddress(stored.left)) {
      return { right: stored.right, left: stored.left };
    }

    this.status = "Scanning for your glasses...";
    const candidates = await this.discovery.scanCandidates(8000);
    const found = buildAddressSet(candidates);
    if (isValidMacAddress(found.right) && isValidMacAddress(found.left)) {
      saveDeviceAddresses({ right: found.right, left: found.left, ring: found.ring || stored.ring });
      return { right: found.right, left: found.left };
    }
    return null;
  }

  private finish(): void {
    if (this.mode === "install") {
      // Reaching the app via a successful install completes onboarding and
      // clears preview-only. (Idempotent when already past onboarding.)
      setPreviewOnlyMode(false);
      setOnboardingCompleted(true);
    }
    this.disposePrompt();
    this.disposeFlasher();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/main-page",
      clearHistory: true,
    });
  }

  private leave(): void {
    this.disposePrompt();
    this.disposeFlasher();
    const frame = Frame.topmost();
    if (this.fromOnboarding && frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({
      moduleName: this.fromOnboarding ? "phone-ui/onboarding-page" : "phone-ui/main-page",
      clearHistory: true,
    });
  }

  private toError(message: string, retry: () => void, headline = "Something Went Wrong"): void {
    this.retryAction = retry;
    this.status = message;
    this.setPhase("error");
    this.headline = headline;
  }

  private setPhase(phase: FlashPhase): void {
    if (this._phase !== phase) {
      this._phase = phase;
      this.notifyPropertyChange("phase", phase);
    }
    this.notifyPropertyChange("primaryLabel", this.primaryLabel);
    this.notifyPropertyChange("secondaryLabel", this.secondaryLabel);
    this.notifyPropertyChange("primaryVisibility", this.primaryVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
    this.notifyPropertyChange("progressVisibility", this.progressVisibility);
  }

  private appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.log = this._log ? `${this._log}\n[${stamp}] ${line}` : `[${stamp}] ${line}`;
  }

  private disposePrompt(): void {
    for (const unsubscribe of this.promptUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.promptUnsubscribers = [];
    if (this.prompt) {
      try {
        this.prompt.close();
      } catch {
        // ignore
      }
      this.prompt = null;
    }
  }

  private disposeFlasher(): void {
    for (const unsubscribe of this.flasherUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.flasherUnsubscribers = [];
    if (this.flasher) {
      try {
        this.flasher.close();
      } catch {
        // ignore
      }
      this.flasher = null;
    }
  }

  private formatError(error: unknown): string {
    return formatErrorMessage(error);
  }
}
