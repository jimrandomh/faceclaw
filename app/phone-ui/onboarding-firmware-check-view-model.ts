import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "../g2/android-permissions";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import {
  downloadAndExtractEvenHubFonts,
  hasExtractedEvenHubFonts,
  type FirmwareProgress,
} from "../g2/firmware-builder";
import { classifyOnboardingFirmware, FLASHABLE_STOCK_VERSION_TEXT, type OnboardingFirmwareKind } from "../g2/firmware-compat";
import { DeviceInfoProbe, DeviceInfoState } from "../native/device-info-probe";
import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";
import { formatErrorMessage } from "../util/format-error";

type CheckPhase = "checking" | "fonts" | "custom" | "flashable" | "newer" | "error";

export class OnboardingFirmwareCheckViewModel extends Observable {
  private _phase: CheckPhase = "checking";
  private _headline = "Checking Firmware";
  private _status = "";
  private _busy = true;

  private probeInstance: DeviceInfoProbe | null = null;

  constructor() {
    super();
    void this.check();
  }

  // --- observable properties -------------------------------------------------

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

  get primaryLabel(): string {
    switch (this._phase) {
      case "custom":
        return "Finish";
      case "flashable":
        return "Install Firmware";
      case "newer":
        return "Proceed Anyway";
      case "error":
        return "Retry";
      default:
        return "";
    }
  }

  get secondaryLabel(): string {
    return "Back";
  }

  get primaryVisibility(): "visible" | "collapse" {
    return this.primaryLabel ? "visible" : "collapse";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    // Once the custom firmware is confirmed present, Finish is the only action.
    return this._phase === "custom" || this._phase === "fonts" ? "collapse" : "visible";
  }

  get errorActionsVisibility(): "visible" | "collapse" {
    return this._phase === "error" ? "visible" : "collapse";
  }

  // --- button handlers -------------------------------------------------------

  onPrimaryTap(): void {
    switch (this._phase) {
      case "custom":
        this.finish();
        return;
      case "flashable":
      case "newer":
        this.goToFlashing();
        return;
      case "error":
        void this.check();
        return;
      default:
        return;
    }
  }

  onSecondaryTap(): void {
    this.disposeProbe();
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({
      moduleName: "phone-ui/pairing-page",
      context: { onboarding: true },
      clearHistory: true,
    });
  }

  /** Escape hatch when the check itself fails: flash as if stock firmware had been detected. */
  onInstallTap(): void {
    if (this._phase !== "error") return;
    this.goToFlashing();
  }

  /** Escape hatch when the check itself fails: continue as if compatible custom firmware had been detected. */
  onSkipTap(): void {
    if (this._phase !== "error") return;
    // Same path as a real "custom" classification, so the phone-side G2 fonts
    // still get extracted when they're missing.
    this.applyClassification("custom", "", "");
  }

  // --- probe flow ------------------------------------------------------------

  private async check(): Promise<void> {
    if (!global.isAndroid) {
      this.toError("Firmware checking is only available on Android.");
      return;
    }
    this.setPhase("checking");
    this.headline = "Checking Firmware";
    this.busy = true;
    this.status = "Connecting to your glasses to read their firmware version...";

    try {
      await ensureBlePermissions();
      const stored = loadDeviceAddresses();
      if (!isValidMacAddress(stored.right)) {
        this.toError("No glasses address is configured. Go back and set the device addresses.");
        return;
      }

      this.disposeProbe();
      const probe = new DeviceInfoProbe(stored.right, stored.left);
      this.probeInstance = probe;
      probe.onStateChange((state) => this.reportProbeState(state));

      const info = await probe.run();
      this.probeInstance = null;

      const { kind, version } = classifyOnboardingFirmware(info);
      this.applyClassification(kind, version, info.capabilities.trim());
    } catch (error) {
      this.probeInstance = null;
      this.toError(this.formatError(error));
    }
  }

  private reportProbeState(state: DeviceInfoState): void {
    if (state === "connecting") {
      this.status = "Connecting to your glasses...";
    } else if (state === "authenticating") {
      // First-time connections pair here; the OS may show a Bluetooth dialog.
      this.status = "Authenticating with your glasses... If Android asks to pair, tap Pair.";
    } else if (state === "querying") {
      this.status = "Reading the firmware version...";
    }
  }

  private applyClassification(kind: OnboardingFirmwareKind, version: string, capabilities: string): void {
    this.busy = false;
    // `kind` is classifyOnboardingFirmware's OnboardingFirmwareKind ("custom" |
    // "flashable-stock" | "newer-stock" | "unknown") -- NOT CheckPhase's shorter
    // "flashable"/"newer" (used below via setPhase for _phase/primaryLabel/etc).
    // The two types share two of four names, so a typo'd case label here type-checks
    // fine as long as `kind` stays plain `string`, but silently falls through to
    // `default` (the hard "couldn't read a firmware version" error) for every real
    // stock-firmware version, flashable or newer alike -- onboarding was unusable for
    // any device that ever reached this switch with an actual reported version.
    switch (kind) {
      case "custom":
        if (!hasExtractedEvenHubFonts()) {
          void this.extractFontsForCustomFirmware(version, capabilities);
          break;
        }
        this.showCustomReady(version, capabilities, false);
        break;
      case "flashable-stock":
        this.setPhase("flashable");
        this.headline = "Ready to Install";
        this.status =
          `Your glasses run stock firmware ${version}. This is compatible — tap Install Firmware to flash ` +
          "Faceclaw's custom firmware.";
        break;
      case "newer-stock":
        this.setPhase("newer");
        this.headline = "Unrecognized Firmware";
        this.status =
          `Your glasses run stock firmware ${version}, which is newer than the ${FLASHABLE_STOCK_VERSION_TEXT} ` +
          "release Faceclaw's custom image is built from. Flashing may not work correctly and carries extra risk. " +
          "You can proceed anyway, or go back.";
        break;
      default:
        // "unknown" — connected but no version. Treat as a probe failure (hard block).
        this.toError(
          "Connected, but couldn't read a firmware version. Make sure the glasses are on and the Even app is " +
            "disconnected, then retry.",
        );
        break;
    }
  }

  private async extractFontsForCustomFirmware(version: string, capabilities: string): Promise<void> {
    this.setPhase("fonts");
    this.headline = "Preparing G2 Fonts";
    this.busy = true;
    this.status =
      "Custom firmware is already installed, but its phone-side fonts are missing. " +
      "Downloading the official firmware to extract them; your glasses will not be reflashed.";
    try {
      await downloadAndExtractEvenHubFonts((progress) => this.reportFontProgress(progress));
      this.showCustomReady(version, capabilities, true);
    } catch (error) {
      this.toError(
        `Custom firmware is installed, but the G2 fonts could not be prepared: ${this.formatError(error)}`,
        "Couldn't Prepare Fonts",
      );
    }
  }

  private reportFontProgress(progress: FirmwareProgress): void {
    switch (progress.phase) {
      case "downloading":
        this.status = "Downloading the official firmware from Even's CDN...";
        break;
      case "verifying-base":
        this.status = "Verifying the downloaded firmware...";
        break;
      case "extracting-fonts":
        this.status = "Extracting the G2 fonts for EvenHub apps...";
        break;
      default:
        break;
    }
  }

  private showCustomReady(version: string, capabilities: string, extractedFonts: boolean): void {
    this.busy = false;
    this.setPhase("custom");
    this.headline = extractedFonts ? "Fonts Ready" : "Custom Firmware Detected";
    this.status =
      `Your glasses already run Faceclaw's custom firmware${version ? ` (version ${version})` : ""}` +
      `${capabilities ? `, extensions: ${capabilities}` : ""}. ` +
      (extractedFonts
        ? "The phone-side G2 fonts were extracted successfully. No flashing was needed — you're all set."
        : "The phone-side G2 fonts are present. No flashing needed — you're all set.");
  }

  // --- terminal actions ------------------------------------------------------

  private goToFlashing(): void {
    this.disposeProbe();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-flash-page",
      context: { mode: "install", fromOnboarding: true },
    });
  }

  private finish(): void {
    setPreviewOnlyMode(false);
    setOnboardingCompleted(true);
    this.disposeProbe();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/main-page",
      clearHistory: true,
    });
  }

  private toError(message: string, headline = "Couldn't Check Firmware"): void {
    this.disposeProbe();
    this.busy = false;
    this.status = message;
    this.setPhase("error");
    this.headline = headline;
  }

  private setPhase(phase: CheckPhase): void {
    if (this._phase !== phase) {
      this._phase = phase;
      this.notifyPropertyChange("phase", phase);
    }
    this.notifyPropertyChange("primaryLabel", this.primaryLabel);
    this.notifyPropertyChange("secondaryLabel", this.secondaryLabel);
    this.notifyPropertyChange("primaryVisibility", this.primaryVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
    this.notifyPropertyChange("errorActionsVisibility", this.errorActionsVisibility);
  }

  private disposeProbe(): void {
    if (this.probeInstance) {
      try {
        this.probeInstance.close();
      } catch {
        // ignore
      }
      this.probeInstance = null;
    }
  }

  private formatError(error: unknown): string {
    return formatErrorMessage(error);
  }
}
