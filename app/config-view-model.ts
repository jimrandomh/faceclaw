import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "./g2/android-permissions";
import { isValidMacAddress, loadDeviceAddresses, normalizeMacAddress, saveDeviceAddresses } from "./g2/device-addresses";
import { buildAddressSet, DeviceDiscoveryBridge } from "./native/device-discovery";

type TextChangeArgs = { value?: string; object?: { text?: string } };

export class ConfigViewModel extends Observable {
  private readonly discovery = new DeviceDiscoveryBridge();
  private _rightAddress = "";
  private _leftAddress = "";
  private _ringAddress = "";
  private _status = "";
  private _discoveryLog = "";
  private _discovering = false;

  constructor() {
    super();
    const stored = loadDeviceAddresses();
    this.rightAddress = stored.right;
    this.leftAddress = stored.left;
    this.ringAddress = stored.ring;
    this.status = "Edit addresses manually, or load them from paired devices or a scan.";
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
  }

  onLeftAddressTextChange(args: TextChangeArgs): void {
    this.leftAddress = args.object?.text ?? args.value ?? "";
  }

  onRingAddressTextChange(args: TextChangeArgs): void {
    this.ringAddress = args.object?.text ?? args.value ?? "";
  }

  async onLoadPairedTap(): Promise<void> {
    await this.populateFromDiscovery(async () => this.discovery.getBondedCandidates(), "Loaded paired devices.");
  }

  async onScanTap(): Promise<void> {
    await this.populateFromDiscovery(async () => this.discovery.scanCandidates(6000), "Scanned nearby devices.");
  }

  onBackTap(): void {
    Frame.topmost()?.navigate({
      moduleName: "main-page",
      clearHistory: true,
    });
  }

  onSaveTap(): void {
    const right = normalizeMacAddress(this.rightAddress);
    const left = normalizeMacAddress(this.leftAddress);
    const ring = normalizeMacAddress(this.ringAddress);

    if (!isValidMacAddress(right)) {
      this.status = "Right arm MAC address is invalid.";
      return;
    }
    if (!isValidMacAddress(left)) {
      this.status = "Left arm MAC address is invalid.";
      return;
    }
    if (!isValidMacAddress(ring, true)) {
      this.status = "Ring MAC address is invalid.";
      return;
    }

    saveDeviceAddresses({ right, left, ring });
    this.rightAddress = right;
    this.leftAddress = left;
    this.ringAddress = ring;
    this.status = "Saved device addresses.";
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
      this.discoveryLog = selection.summary;
      this.status = successMessage;
    } catch (error) {
      this.status = this.formatError(error);
    } finally {
      this.setDiscovering(false);
    }
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    return raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  }
}
