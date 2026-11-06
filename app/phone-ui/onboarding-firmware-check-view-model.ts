import { resumeAutoReconnect } from "../g2/reconnect-policy";
import { finishOnboardingNavigation } from "./onboarding-navigation";
import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "../native/ble-permissions";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import {
  downloadAndExtractEvenHubFonts,
  hasExtractedEvenHubFonts,
  type FirmwareProgress,
} from "../g2/firmware-builder";
import {
  BASE_STOCK_VERSION_TEXT,
  REQUIRED_FACECLAW_FIRMWARE_VERSION,
  classifyOnboardingFirmware,
  describeFirmwareExtension,
  type FirmwareExtension,
  type OnboardingFirmwareKind,
} from "../g2/firmware-compat";
import { DeviceInfoProbe, DeviceInfoState } from "../native/device-info-probe";
import { G1Flasher } from "../native/g1-flasher";
import { saveG1Pair } from "../g1/addresses";
import { G1ArmScanner } from "../g1/arm-scanner";
import { G1V0_IMAGE } from "../g1/firmware/g1v0-image";
import { G1_CASE_INSTRUCTIONS, G1_INSTALL_NOTICE, g1FirmwareState, type G1FlashResult, type G1Side } from "../g1/flash-plan";
import { loadPairedGlassesIdentity } from "../g2/device-addresses";
import { glassesTypeSetting } from "../ui/dashboard-settings";
import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";
import { formatErrorMessage } from "../util/format-error";

type CheckPhase = "checking" | "fonts" | "custom" | "flashable" | "newer-validated" | "newer" | "error";

const G1_LOCATE_MS = 30_000;
const G1_CHECK_CONNECT_MS = 45_000;

export class OnboardingFirmwareCheckViewModel extends Observable {
  private _phase: CheckPhase = "checking";
  private _headline = "Checking Firmware";
  private _status = "";
  private _busy = true;

  private generation = 0;

  private probeInstance: { close(): void } | null = null;

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
      case "newer-validated":
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
      case "newer-validated":
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
    this.applyClassification("custom", "", { kind: "none" });
  }

  // --- probe flow ------------------------------------------------------------

  private async check(): Promise<void> {
    const generation = ++this.generation;
    if (!global.isAndroid && !global.isIOS) {
      this.toError("Firmware checking is only available on Android.");
      return;
    }
    this.setPhase("checking");
    this.headline = "Checking Firmware";
    this.busy = true;
    this.status = "Connecting to your glasses to read their firmware version...";

    try {
      await ensureBlePermissions();
      if (generation !== this.generation) return;
      if (glassesTypeSetting.get() === "g1") {
        await this.checkG1(generation);
        return;
      }
      const stored = loadDeviceAddresses();
      if (!isValidMacAddress(stored.right)) {
        this.toError("No glasses address is configured. Go back and set the device addresses.");
        return;
      }

      this.disposeProbe();
      const probe = new DeviceInfoProbe(stored.right, stored.left);
      this.probeInstance = probe;
      probe.onStateChange((state, detail) => this.reportProbeState(state, detail));

      const info = await probe.run();
      if (generation !== this.generation) return;
      this.probeInstance = null;

      const { kind, version, extension } = classifyOnboardingFirmware(info);
      this.applyClassification(kind, version, extension);
    } catch (error) {
      if (generation !== this.generation) return;
      this.toError(this.formatError(error));
    }
  }

  /**
   * What each arm's name says first, as that needs no connection: Even's firmware can't be asked in the same way, and an
   * arm that is about to be replaced shouldn't have to pair. Only arms on g1v0 are asked which version they run.
   */
  private async checkG1(generation: number): Promise<void> {
    this.status = "Listening for your glasses...";
    const scanner = new G1ArmScanner();
    this.probeInstance = { close: () => scanner.stop() };
    const stored = loadDeviceAddresses();
    const pair = await scanner.waitForPair({ serial: loadPairedGlassesIdentity()?.serial, left: stored.left, right: stored.right }, G1_LOCATE_MS);
    if (generation !== this.generation) return;
    this.probeInstance = null;
    if (!pair) {
      this.toError(`Couldn't hear both arms of your glasses. ${G1_CASE_INSTRUCTIONS} Make sure no other app or phone is connected to them, then retry.`);
      return;
    }
    saveG1Pair(pair);
    const named = [pair.left!.g1Firmware, pair.right!.g1Firmware];
    if (named.includes("stock")) {
      this.showG1Install({ firmware: "stock" });
      return;
    }
    if (named.includes("g1v0-safe")) {
      this.showG1Install({ safeMode: true });
      return;
    }
    const arms: G1FlashResult[] = [];
    for (const side of ["left", "right"] as G1Side[]) {
      const flasher = new G1Flasher({ address: pair[side]!.address, side, firmwarePath: "", mode: "probe", connectWindowMs: G1_CHECK_CONNECT_MS });
      this.probeInstance = flasher;
      flasher.onState((state) => {
        if (generation !== this.generation) return;
        if (state === "pairing") {
          this.status = `Pairing with the ${side} arm. If your phone asks, accept it. A G1 pairs only in its case, with the lid open.`;
        } else {
          this.status = `Checking the ${side} arm...`;
        }
      });
      arms.push(await flasher.run());
      if (generation !== this.generation) return;
      this.disposeProbe();
    }
    const state = g1FirmwareState(arms, G1V0_IMAGE.version);
    if (state === "current") this.applyClassification("custom", arms[0]!.version ?? "", { kind: "none" });
    else this.showG1Install(state === "stock" ? { firmware: "stock" } : state === "safe-mode" ? { safeMode: true } : arms.find((arm) => arm.version) ?? {});
  }

  private showG1Install(found: G1FlashResult): void {
    this.busy = false;
    this.setPhase("flashable");
    if (found.firmware === "stock") {
      this.headline = "Ready to Install";
      this.status = `Your glasses run Even's firmware.\n\n${G1_CASE_INSTRUCTIONS}\n\n${G1_INSTALL_NOTICE}`;
    } else if (found.safeMode) {
      this.headline = "Firmware Needs Reinstalling";
      this.status = `An arm of your glasses is in safe mode: its firmware restarted repeatedly. Installing it again usually fixes this.\n\n${G1_CASE_INSTRUCTIONS}`;
    } else {
      this.headline = "Firmware Update Available";
      this.status = `Your glasses run Faceclaw's firmware ${found.version ?? ""}, and this version of Faceclaw comes with ${G1V0_IMAGE.version}.\n\n${G1_CASE_INSTRUCTIONS}`;
    }
  }

  private reportProbeState(state: DeviceInfoState, detail: string): void {
    // The probe brings up the right lens, then the left, and pairs with each
    // in turn (they are separate Bluetooth devices with separate bonds).
    const lens = detail === "left" || detail === "right" ? `the ${detail} lens` : "your glasses";
    if (state === "connecting") {
      this.status = `Connecting to ${lens}...`;
    } else if (state === "authenticating") {
      // First-time connections pair here; the OS may show a Bluetooth dialog.
      this.status = `Pairing with ${lens}... Each lens pairs separately; if your phone asks to pair, tap Pair.`;
    } else if (state === "querying") {
      this.status = "Reading the firmware version...";
    }
  }

  private applyClassification(kind: OnboardingFirmwareKind, version: string, extension: FirmwareExtension): void {
    this.busy = false;
    // `kind` is classifyOnboardingFirmware's OnboardingFirmwareKind ("custom" |
    // "older-faceclaw" | "other-custom" | "flashable-stock" | "newer-stock-unvalidated" |
    // "newer-stock-validated" | "unknown") -- NOT CheckPhase's shorter
    // "flashable"/"newer-validated"/"newer" (used below via setPhase for _phase/primaryLabel/etc).
    // The two types share two of four names, so a typo'd case label here type-checks
    // fine as long as `kind` stays plain `string`, but silently falls through to
    // `default` (the hard "couldn't read a firmware version" error) for every real
    // stock-firmware version, flashable or newer alike -- onboarding was unusable for
    // any device that ever reached this switch with an actual reported version.
    switch (kind) {
      case "custom":
        if (!hasExtractedEvenHubFonts()) {
          void this.extractFontsForCustomFirmware(version, extension);
          break;
        }
        this.showCustomReady(version, extension, false);
        break;
      case "older-faceclaw":
        this.setPhase("flashable");
        this.headline = "Firmware Update Available";
        this.status =
          `Your glasses run ${describeFirmwareExtension(extension)}${version ? `, based on stock ${version}` : ""}. ` +
          `This version of Faceclaw needs revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}. ` +
          "Tap Install Firmware to update it.";
        break;
      case "other-custom":
        this.setPhase("flashable");
        this.headline = "Other Custom Firmware";
        this.status =
          `Your glasses run ${describeFirmwareExtension(extension)}${version ? `, based on stock ${version}` : ""}. ` +
          `Faceclaw needs its own custom firmware (revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}). ` +
          "Tap Install Firmware to replace the current firmware with it.";
        break;
      case "flashable-stock":
        this.setPhase("flashable");
        this.headline = "Ready to Install";
        this.status =
          `Your glasses run stock firmware ${version}. This is compatible — tap Install Firmware to flash ` +
          "Faceclaw's custom firmware.";
        break;
      case "newer-stock-validated":
        this.setPhase("newer-validated");
        this.headline = "Ready to Install";
        this.status =
          `Your glasses run stock firmware ${version}, which is compatible. This version is newer than the ` +
          `${BASE_STOCK_VERSION_TEXT} release Faceclaw's custom image is built from. You may not be able to ` +
          `use the official Even app without upgrading back to ${version} first (the official Even app will ` +
          `perform that upgrade for you if you re-pair it).`;
        break;

      case "newer-stock-unvalidated":
        this.setPhase("newer");
        this.headline = "Unrecognized Firmware";
        this.status =
          `Your glasses run stock firmware ${version}, which is newer than the ${BASE_STOCK_VERSION_TEXT} ` +
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

  private async extractFontsForCustomFirmware(version: string, extension: FirmwareExtension): Promise<void> {
    const generation = this.generation;
    this.setPhase("fonts");
    this.headline = "Preparing G2 Fonts";
    this.busy = true;
    this.status =
      "Custom firmware is already installed, but its phone-side fonts are missing. " +
      "Downloading the official firmware to extract them; your glasses will not be reflashed.";
    try {
      await downloadAndExtractEvenHubFonts((progress) => {
        if (generation === this.generation) this.reportFontProgress(progress);
      });
      if (generation !== this.generation) return;
      this.showCustomReady(version, extension, true);
    } catch (error) {
      if (generation !== this.generation) return;
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

  private showCustomReady(version: string, extension: FirmwareExtension, extractedFonts: boolean): void {
    this.busy = false;
    this.setPhase("custom");
    this.headline = extractedFonts ? "Fonts Ready" : "Custom Firmware Detected";
    const details = glassesTypeSetting.get() === "g1" ? [version].filter(Boolean) : [
      extension.kind === "faceclaw" ? `revision ${extension.version}` : "",
      version ? `based on stock ${version}` : "",
    ].filter(Boolean);
    this.status =
      `Your glasses already run Faceclaw's custom firmware${details.length ? ` (${details.join(", ")})` : ""}. ` +
      (extractedFonts
        ? "The phone-side G2 fonts were extracted successfully. No flashing was needed — you're all set."
        : "The phone-side G2 fonts are present. No flashing needed — you're all set.");
  }

  // --- terminal actions ------------------------------------------------------

  private goToFlashing(): void {
    this.disposeProbe();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-flash-page",
      // This page already described the install; skip the flash page's
      // intro/"Connect & Confirm" step and connect immediately.
      context: { mode: "install", fromOnboarding: true, autoStart: true },
    });
  }

  private finish(): void {
    resumeAutoReconnect();
    setPreviewOnlyMode(false);
    setOnboardingCompleted(true);
    this.disposeProbe();
    finishOnboardingNavigation();
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

  dispose(): void { ++this.generation; this.disposeProbe(); }

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
