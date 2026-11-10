import { Dialogs, Observable } from "@nativescript/core";

import { neuralBandBatteryText, neuralBandName, neuralBandStatusLine } from "../g2/neural-band-core";
import { ensureBlePermissions } from "../native/ble-permissions";
import { neuralBand, type NeuralBandEvent, type NeuralBandStatus } from "../native/neural-band";
import {
  neuralBandEnabledSetting,
  neuralBandHapticsSetting,
  neuralBandTwistScrollSetting,
} from "../ui/dashboard-settings";
import { formatErrorMessage } from "../util/format-error";

type Visibility = "visible" | "collapse";

type DiscoveredRow = {
  name: string;
  address: string;
  rssi: number;
  detail: string;
  onTap: () => void;
};

/**
 * The phone's Neural Band page: sign in with Meta (once, to claim the band), scan for a band
 * in pairing mode and pair it, see its status, forget it, and the band's settings. The band
 * itself is driven by FaceclawNeuralBand.kt; app/g2/neural-band.ts maps its gestures.
 */
export class NeuralBandViewModel extends Observable {
  private status: NeuralBandStatus = neuralBand.getStatus();
  private discovered: DiscoveredRow[] = [];
  private offEvents: (() => void) | null = null;
  private _notice = "";
  /** A band tapped before signing in with Meta: paired once the sign-in completes. */
  private pendingPair: { address: string; name: string } | null = null;

  onPageLoaded(): void {
    if (!this.offEvents) this.offEvents = neuralBand.onEvent((event) => this.handleEvent(event));
    this.status = neuralBand.getStatus();
    this.refresh();
  }

  onPageUnloaded(): void {
    neuralBand.stopScan();
    this.offEvents?.();
    this.offEvents = null;
  }

  private handleEvent(event: NeuralBandEvent): void {
    if (event.type === "status") {
      const { type: _type, ...status } = event;
      const paired = !this.status.paired && status.paired;
      const signedIn = !this.status.metaSignedIn && status.metaSignedIn;
      this.status = status;
      if (paired) this.setDiscovered([]);
      this.refresh();
      const pending = this.pendingPair;
      if (signedIn && pending) {
        this.pendingPair = null;
        void this.pair(pending.address, pending.name);
      }
    } else if (event.type === "discovered") {
      if (this.discovered.some((row) => row.address === event.address)) return;
      this.setDiscovered([...this.discovered, {
        name: event.name,
        address: event.address,
        rssi: event.rssi,
        detail: `${event.address} · signal ${event.rssi} dBm`,
        onTap: () => void this.pair(event.address, event.name),
      }]);
    }
  }

  private setDiscovered(rows: DiscoveredRow[]): void {
    this.discovered = rows.sort((a, b) => b.rssi - a.rssi);
    this.notifyPropertyChange("discoveredRows", this.discoveredRows);
    this.notifyPropertyChange("emptyScanVisibility", this.emptyScanVisibility);
  }

  private refresh(): void {
    for (const property of [
      "statusLine", "supportedVisibility", "unsupportedVisibility", "bandVisibility", "bandTitle", "bandDetail",
      "handLabel", "handVisibility", "metaLabel", "metaButtonLabel", "metaDetail", "scanLabel", "pairVisibility",
      "emptyScanVisibility", "reconnectVisibility", "enabled", "twistScroll", "haptics", "notice", "noticeVisibility",
      "pairStatusVisibility",
    ] as const) {
      this.notifyPropertyChange(property, this[property]);
    }
  }

  // --- status -----------------------------------------------------------------

  get statusLine(): string {
    return neuralBandStatusLine(this.status);
  }

  get supportedVisibility(): Visibility {
    return this.status.supported ? "visible" : "collapse";
  }

  get unsupportedVisibility(): Visibility {
    return this.status.supported ? "collapse" : "visible";
  }

  get notice(): string {
    return this._notice;
  }

  get noticeVisibility(): Visibility {
    return this._notice ? "visible" : "collapse";
  }

  private setNotice(text: string): void {
    this._notice = text;
    this.notifyPropertyChange("notice", text);
    this.notifyPropertyChange("noticeVisibility", this.noticeVisibility);
  }

  // --- the paired band -------------------------------------------------------

  get bandVisibility(): Visibility {
    return this.status.paired ? "visible" : "collapse";
  }

  get bandTitle(): string {
    return neuralBandName(this.status);
  }

  get bandDetail(): string {
    const parts: string[] = [];
    if (this.status.address) parts.push(this.status.address);
    const battery = neuralBandBatteryText(this.status);
    if (battery) parts.push(`battery ${battery}`);
    if (this.status.firmware) parts.push(`firmware ${this.status.firmware}`);
    parts.push(this.status.claimed ? "claimed by this phone" : "not claimed yet");
    return parts.join(" · ");
  }

  get handVisibility(): Visibility {
    return this.status.state === "connected" && this.status.hand ? "visible" : "collapse";
  }

  get handLabel(): string {
    return this.status.hand === "left" ? "Worn on the left wrist: switch to right" : "Worn on the right wrist: switch to left";
  }

  get reconnectVisibility(): Visibility {
    return this.status.paired && (this.status.state === "disconnected" || this.status.state === "error" || this.status.state === "idle")
      ? "visible" : "collapse";
  }

  onHandTap(): void {
    try {
      neuralBand.setHand(this.status.hand === "left" ? "right" : "left");
      this.setNotice("");
    } catch (error) {
      this.setNotice(formatErrorMessage(error));
    }
  }

  async onReconnectTap(): Promise<void> {
    try {
      await ensureBlePermissions();
    } catch (error) {
      this.setNotice(formatErrorMessage(error));
      return;
    }
    if (!neuralBandEnabledSetting.get()) neuralBandEnabledSetting.set(true);
    this.setNotice("");
    neuralBand.connect();
  }

  async onForgetTap(): Promise<void> {
    const confirmed = await Dialogs.confirm({
      title: "Forget the band?",
      message:
        "Faceclaw disconnects and forgets the band and the key that proves it owns it. To use the band here again you'll pair it and sign in with Meta again.",
      okButtonText: "Forget",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) return;
    neuralBand.forget();
    this.setNotice("");
  }

  // --- Meta account ----------------------------------------------------------

  get metaLabel(): string {
    return this.status.metaSignedIn ? "Signed in with Meta." : "Not signed in with Meta.";
  }

  get metaDetail(): string {
    if (this.status.sessionExpired) return "Your Meta session expired. Sign in again to claim the band.";
    return "A band is tied to the Meta account that set it up, so claiming it for Faceclaw needs that account once. " +
      "You sign in on Meta's own page; Faceclaw keeps only the session it hands back, sealed on this phone, " +
      "and deletes it as soon as the band is claimed. After that the band connects without Meta.";
  }

  get metaButtonLabel(): string {
    return this.status.metaSignedIn ? "Sign out of Meta" : "Sign in with Meta";
  }

  onMetaTap(): void {
    if (this.status.metaSignedIn) {
      neuralBand.signOutMeta();
      return;
    }
    if (!neuralBand.startMetaSignIn()) this.setNotice("Couldn't open the sign-in page. Try again with Faceclaw in front.");
  }

  // --- pairing ---------------------------------------------------------------

  get pairVisibility(): Visibility {
    return this.status.supported ? "visible" : "collapse";
  }

  get scanLabel(): string {
    return this.status.scanning ? "Stop scanning" : this.status.paired ? "Scan for a different band" : "Scan for bands";
  }

  /** The status line again beside the band list, where a tap's progress would otherwise be out of view. */
  get pairStatusVisibility(): Visibility {
    return this.status.paired ? "visible" : "collapse";
  }

  get discoveredRows(): DiscoveredRow[] {
    return this.discovered;
  }

  get emptyScanVisibility(): Visibility {
    return this.status.scanning && this.discovered.length === 0 ? "visible" : "collapse";
  }

  async onScanTap(): Promise<void> {
    if (this.status.scanning) {
      neuralBand.stopScan();
      return;
    }
    try {
      await ensureBlePermissions();
    } catch (error) {
      this.setNotice(formatErrorMessage(error));
      return;
    }
    this.setNotice("");
    this.setDiscovered([]);
    neuralBand.startScan();
  }

  private async pair(address: string, name: string): Promise<void> {
    // The band's address rotates until it is bonded, so the name says whether it's the claimed one.
    const alreadyClaimed = this.status.claimed && this.status.name === name;
    if (!this.status.metaSignedIn && !alreadyClaimed) {
      const signIn = await Dialogs.confirm({
        title: `Claim ${name}?`,
        message:
          "Faceclaw needs the Meta account the band belongs to once, to claim it for this phone. " +
          "Sign in now and pairing continues when you're done. If the band stops pulsing meanwhile, " +
          "put it back in pairing mode (hold its button about 3 seconds).",
        okButtonText: "Sign in with Meta",
        cancelButtonText: "Cancel",
      });
      if (!signIn) return;
      this.pendingPair = { address, name };
      if (!neuralBand.startMetaSignIn()) {
        this.pendingPair = null;
        this.setNotice("Couldn't open the sign-in page. Try again with Faceclaw in front.");
      }
      return;
    }
    if (!neuralBandEnabledSetting.get()) neuralBandEnabledSetting.set(true);
    this.setNotice("");
    neuralBand.pair(address, name);
  }

  // --- settings --------------------------------------------------------------

  get enabled(): boolean {
    return neuralBandEnabledSetting.get();
  }

  set enabled(value: boolean) {
    if (value !== neuralBandEnabledSetting.get()) neuralBandEnabledSetting.set(value);
  }

  get twistScroll(): boolean {
    return neuralBandTwistScrollSetting.get();
  }

  set twistScroll(value: boolean) {
    if (value !== neuralBandTwistScrollSetting.get()) neuralBandTwistScrollSetting.set(value);
  }

  get haptics(): boolean {
    return neuralBandHapticsSetting.get();
  }

  set haptics(value: boolean) {
    if (value !== neuralBandHapticsSetting.get()) neuralBandHapticsSetting.set(value);
  }

  get gestureHelp(): string {
    return [
      "Index pinch: select",
      "Index double pinch: back (or wake the display)",
      "Middle pinch: the app's menu",
      "Hold a pinch: the system menu",
      "Thumb swipe: move up, down, left or right",
      "Pinch and twist (if on): scroll",
    ].join("\n");
  }
}
