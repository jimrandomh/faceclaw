import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "../g2/android-permissions";
import {
  isValidMacAddress,
  loadDeviceAddresses,
  loadPairedGlassesIdentityForAddresses,
  normalizeMacAddress,
  saveDeviceAddresses,
  type PairedGlassesIdentity,
} from "../g2/device-addresses";
import { glassesImagePath } from "../g2/glasses-artwork";
import { GlassesHardwareIdentity } from "../g2/glasses-hardware-identity";
import { buildAddressSet, DeviceDiscoveryBridge } from "../native/device-discovery";
import { formatErrorMessage } from "../util/format-error";

type TextChangeArgs = { value?: string; object?: { text?: string } };

export class ConfigViewModel extends Observable {
  private readonly discovery = new DeviceDiscoveryBridge();
  private readonly onboarding: boolean;
  private _rightAddress = "";
  private _leftAddress = "";
  private _ringAddress = "";
  private _status = "";
  private _discoveryLog = "";
  private _discovering = false;
  private pairedIdentity: PairedGlassesIdentity | null = null;

  constructor(options?: { onboarding?: boolean }) {
    super();
    this.onboarding = options?.onboarding ?? false;
    const stored = loadDeviceAddresses();
    this.rightAddress = stored.right;
    this.leftAddress = stored.left;
    this.ringAddress = stored.ring;
    this.refreshIdentity();
    this.status = this.onboarding
      ? "Scan for glasses to pick yours by model and serial, load the addresses of devices paired with this phone, or enter them by hand, then Continue."
      : "Edit addresses manually, scan for glasses, or load them from paired devices.";
  }

  // --- paired identity card --------------------------------------------------

  /** The identity saved by the pairing scan, shown only while it still describes the entered addresses. */
  private refreshIdentity(): void {
    this.pairedIdentity = loadPairedGlassesIdentityForAddresses({
      right: this._rightAddress,
      left: this._leftAddress,
      ring: this._ringAddress,
    });
    for (const property of [
      "identityVisibility",
      "identityImagePath",
      "identityTitle",
      "identityVariant",
      "identityVariantVisibility",
      "identitySerial",
      "identityDetail",
    ] as const) {
      this.notifyPropertyChange(property, this[property]);
    }
  }

  private get decodedIdentity(): GlassesHardwareIdentity | null {
    return GlassesHardwareIdentity.decode(this.pairedIdentity?.serial);
  }

  get identityVisibility(): "visible" | "collapse" {
    return this.pairedIdentity ? "visible" : "collapse";
  }

  get identityImagePath(): string {
    return glassesImagePath(this.decodedIdentity);
  }

  get identityTitle(): string {
    return this.decodedIdentity?.productName ?? "Even Realities G2";
  }

  get identityVariant(): string {
    return this.decodedIdentity?.variantSummary ?? "";
  }

  get identityVariantVisibility(): "visible" | "collapse" {
    return this.identityVariant ? "visible" : "collapse";
  }

  get identitySerial(): string {
    return this.pairedIdentity ? `Serial ${this.pairedIdentity.serial}` : "";
  }

  get identityDetail(): string {
    const identity = this.pairedIdentity;
    if (!identity) return "";
    const parts = [`Left ${identity.leftName || identity.leftAddress}`, `Right ${identity.rightName || identity.rightAddress}`];
    if (identity.ringName) parts.push(`Ring ${identity.ringName}`);
    if (identity.pairedAtMs) parts.push(`paired ${new Date(identity.pairedAtMs).toLocaleDateString()}`);
    return parts.join(" · ");
  }

  get saveLabel(): string {
    return this.onboarding ? "Continue" : "Save";
  }

  get rightAddress(): string {
    return this._rightAddress;
  }

  set rightAddress(value: string) {
    if (this._rightAddress !== value) {
      this._rightAddress = value;
      this.notifyPropertyChange("rightAddress", value);
    }
  }

  get leftAddress(): string {
    return this._leftAddress;
  }

  set leftAddress(value: string) {
    if (this._leftAddress !== value) {
      this._leftAddress = value;
      this.notifyPropertyChange("leftAddress", value);
    }
  }

  get ringAddress(): string {
    return this._ringAddress;
  }

  set ringAddress(value: string) {
    if (this._ringAddress !== value) {
      this._ringAddress = value;
      this.notifyPropertyChange("ringAddress", value);
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

  get discoveryLog(): string {
    return this._discoveryLog;
  }

  set discoveryLog(value: string) {
    if (this._discoveryLog !== value) {
      this._discoveryLog = value;
      this.notifyPropertyChange("discoveryLog", value);
    }
  }

  get canDiscover(): boolean {
    return !this._discovering;
  }

  private setDiscovering(value: boolean): void {
    if (this._discovering !== value) {
      this._discovering = value;
      this.notifyPropertyChange("canDiscover", this.canDiscover);
    }
  }

  onRightAddressTextChange(args: TextChangeArgs): void {
    this.rightAddress = args.object?.text ?? args.value ?? "";
    this.refreshIdentity();
  }

  onLeftAddressTextChange(args: TextChangeArgs): void {
    this.leftAddress = args.object?.text ?? args.value ?? "";
    this.refreshIdentity();
  }

  onRingAddressTextChange(args: TextChangeArgs): void {
    this.ringAddress = args.object?.text ?? args.value ?? "";
  }

  async onLoadPairedTap(): Promise<void> {
    await this.populateFromDiscovery(async () => this.discovery.getBondedCandidates(), "Loaded paired devices.");
  }

  /** The live scan page identifies pairs by serial, model, and distance; hand off to it. */
  async onScanTap(): Promise<void> {
    if (!this.onboarding) {
      // A connected arm stops advertising, so drop the link before scanning.
      // Required lazily: a module-scope import would instantiate the dashboard
      // controller singleton during onboarding, which this page is part of.
      // Outside onboarding the main page has already loaded it.
      const { dashboardController } = require("../g2/dashboard-controller") as typeof import("../g2/dashboard-controller");
      const { resumeAutoReconnect } = require("../g2/reconnect-policy") as typeof import("../g2/reconnect-policy");
      try {
        await dashboardController.disconnect();
      } catch {
        // proceed anyway; the pairing page reports what it hears
      }
      // disconnect() enters the manual-disconnected state; pairing is a
      // detour, so let the main page reconnect afterwards.
      resumeAutoReconnect();
    }
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/pairing-page",
      context: { onboarding: this.onboarding },
    });
  }

  onBackTap(): void {
    if (this.onboarding) {
      const frame = Frame.topmost();
      if (frame?.canGoBack()) {
        frame.goBack();
        return;
      }
      frame?.navigate({ moduleName: "phone-ui/onboarding-page", clearHistory: true });
      return;
    }
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/main-page",
      clearHistory: true,
    });
  }

  onSaveTap(): void {
    if (!this.saveAddresses()) {
      return;
    }
    if (this.onboarding) {
      // Continue the onboarding chain: check the glasses' firmware next.
      Frame.topmost()?.navigate({ moduleName: "phone-ui/onboarding-firmware-check-page" });
    }
  }

  private saveAddresses(): boolean {
    const right = normalizeMacAddress(this.rightAddress);
    const left = normalizeMacAddress(this.leftAddress);
    const ring = normalizeMacAddress(this.ringAddress);

    if (!isValidMacAddress(right)) {
      this.status = "Right arm MAC address is invalid.";
      return false;
    }
    if (!isValidMacAddress(left)) {
      this.status = "Left arm MAC address is invalid.";
      return false;
    }
    if (!isValidMacAddress(ring, true)) {
      this.status = "Ring MAC address is invalid.";
      return false;
    }

    saveDeviceAddresses({ right, left, ring });
    this.rightAddress = right;
    this.leftAddress = left;
    this.ringAddress = ring;
    this.status = this.onboarding ? "Saved. Continuing..." : "Saved device addresses.";
    return true;
  }

  private async populateFromDiscovery(
    load: () => Promise<Parameters<typeof buildAddressSet>[0]>,
    successMessage: string,
  ): Promise<void> {
    if (!global.isAndroid) {
      this.status = "Discovery is only available on Android.";
      return;
    }
    this.setDiscovering(true);
    try {
      await ensureBlePermissions();
      const candidates = await load();
      const selection = buildAddressSet(candidates);
      if (selection.right) this.rightAddress = selection.right;
      if (selection.left) this.leftAddress = selection.left;
      if (selection.ring) this.ringAddress = selection.ring;
      this.refreshIdentity();
      this.discoveryLog = selection.summary;
      this.status = successMessage;
    } catch (error) {
      this.status = this.formatError(error);
    } finally {
      this.setDiscovering(false);
    }
  }

  private formatError(error: unknown): string {
    return formatErrorMessage(error);
  }
}
