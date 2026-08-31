import { Application, EventData, Frame, Observable, View } from "@nativescript/core";

import { ensureBlePermissions } from "../g2/android-permissions";
import { loadDeviceAddresses, loadPairedGlassesIdentity, saveDeviceAddresses, savePairedGlassesIdentity } from "../g2/device-addresses";
import { formatErrorMessage } from "../util/format-error";
import {
  colorwayLabel,
  DEFAULT_STALE_AFTER_MS,
  DiscoveryAggregator,
  glassesRow,
  nearestCandidateId,
  ringRow,
  type GlassesPairCandidate,
  type PairingRowPresentation,
  type RingCandidate,
} from "../g2/pairing-candidates";
import { DeviceDiscoveryBridge } from "../native/device-discovery";
import { setPreviewOnlyMode } from "./onboarding-state";

/** One Repeater row: the presentation plus the display-only fields the XML binds. */
export type PairingRowItem = PairingRowPresentation & {
  rowClass: string;
  swatchVisibility: "visible" | "collapse";
  colorwayLabel: string;
  badgeVisibility: "visible" | "collapse";
  variantVisibility: "visible" | "collapse";
  proximityLine: string;
  proximityClass: string;
  armsVisibility: "visible" | "collapse";
  warningVisibility: "visible" | "collapse";
  chevron: string;
  /**
   * Tap handler carried on the row itself. The Repeater assigns a row's
   * bindingContext before attaching it to the tree, so a `$parents['Page']`
   * binding cannot resolve on first bind and logs an error every refresh;
   * binding `tap="{{ onRowTap }}"` against the item avoids the walk entirely.
   */
  onRowTap: (args: EventData) => void;
};

const REFRESH_INTERVAL_MS = 500;
const NO_RESULTS_HINT_AFTER_MS = 10_000;

/**
 * Live pairing scan. Streams advertisements into a `DiscoveryAggregator`,
 * re-renders the pair/ring lists at a calm cadence, and saves the chosen
 * addresses plus the decoded identity when the user continues.
 *
 * Selection is always a deliberate tap (no auto-select on a single result):
 * a strong signal is a hint, not consent.
 */
export class PairingViewModel extends Observable {
  private readonly onboarding: boolean;
  private readonly aggregator = new DiscoveryAggregator();
  private discovery: DeviceDiscoveryBridge | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  private advertisementCount = 0;
  private scanFailure = "";

  private _scanning = false;
  private _status = "";
  private _glassesRows: PairingRowItem[] = [];
  private _ringRows: PairingRowItem[] = [];
  private selectedPair: GlassesPairCandidate | null = null;
  private selectedRing: RingCandidate | null = null;
  private readonly previouslyPairedSerial: string | null;
  private readonly previouslyPairedRing: string;

  constructor(options?: { onboarding?: boolean }) {
    super();
    this.onboarding = options?.onboarding ?? false;
    this.previouslyPairedSerial = loadPairedGlassesIdentity()?.serial ?? null;
    this.previouslyPairedRing = loadDeviceAddresses().ring;
    // A backgrounded phone (Home, screen lock, a call) must not keep the
    // low-latency scan and the refresh timer burning; pick both back up when
    // the app returns.
    Application.on(Application.suspendEvent, this.onAppSuspend);
    Application.on(Application.resumeEvent, this.onAppResume);
  }

  // --- lifecycle -------------------------------------------------------------

  private resumeScanAfterSuspend = false;

  private readonly onAppSuspend = (): void => {
    if (this._scanning) {
      this.resumeScanAfterSuspend = true;
      this.stop();
    }
  };

  private readonly onAppResume = (): void => {
    if (this.resumeScanAfterSuspend) {
      this.resumeScanAfterSuspend = false;
      void this.start();
    }
  };

  /** Final teardown when the page is left for good (not a detour to manual entry). */
  dispose(): void {
    this.stop();
    Application.off(Application.suspendEvent, this.onAppSuspend);
    Application.off(Application.resumeEvent, this.onAppResume);
  }

  async start(): Promise<void> {
    if (this._scanning) return;
    if (!global.isAndroid) {
      this.status = "Pairing is only available on Android.";
      return;
    }
    try {
      await ensureBlePermissions();
    } catch (error) {
      this.status = this.formatError(error);
      return;
    }
    try {
      this.discovery ??= new DeviceDiscoveryBridge();
    } catch (error) {
      this.status = this.formatError(error);
      return;
    }
    if (!this.discovery.bluetoothEnabled) {
      this.status = "Bluetooth is off. Turn it on, then tap Scan.";
      return;
    }
    this.scanFailure = "";
    this.startedAtMs = Date.now();
    const started = this.discovery.startScan({
      onAdvertisement: (raw) => {
        if (this.aggregator.ingest(raw)) this.advertisementCount += 1;
      },
      onScanFailed: (_code, message) => {
        this.scanFailure = message;
        this.scanning = false;
        this.refresh();
      },
    });
    if (!started) {
      this.status = "Could not start the Bluetooth scan. Check that Bluetooth is on.";
      return;
    }
    // Bonded arms show up immediately (no signal) and gain a serial once heard.
    this.discovery.emitBondedDevices();
    this.scanning = true;
    this.refreshTimer ??= setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    this.refresh();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.discovery?.stopScan();
    this.scanning = false;
    this.refresh();
  }

  // --- observable properties -------------------------------------------------

  get actionBarHidden(): boolean {
    return this.onboarding;
  }

  get headline(): string {
    return this.onboarding ? "Pair Your Glasses" : "Pair Glasses";
  }

  get instructions(): string {
    return (
      "Take the glasses out of their case (or open the lid) and keep them next to the phone. " +
      "Each arm advertises its serial; a pair is ready when both arms report the same one. " +
      "An arm connected to the official Even app stops advertising — disconnect it there first."
    );
  }

  get scanning(): boolean {
    return this._scanning;
  }

  set scanning(value: boolean) {
    if (this._scanning === value) return;
    this._scanning = value;
    this.notifyPropertyChange("scanning", value);
    this.notifyPropertyChange("scanningVisibility", this.scanningVisibility);
    this.notifyPropertyChange("scanToggleLabel", this.scanToggleLabel);
  }

  get scanningVisibility(): "visible" | "collapse" {
    return this._scanning ? "visible" : "collapse";
  }

  get scanToggleLabel(): string {
    return this._scanning ? "Pause scan" : "Scan again";
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status === value) return;
    this._status = value;
    this.notifyPropertyChange("status", value);
  }

  get glassesRows(): PairingRowItem[] {
    return this._glassesRows;
  }

  get ringRows(): PairingRowItem[] {
    return this._ringRows;
  }

  get emptyGlassesVisibility(): "visible" | "collapse" {
    return this._glassesRows.length ? "collapse" : "visible";
  }

  get emptyGlassesMessage(): string {
    if (this.scanFailure) return `Scan failed: ${this.scanFailure}`;
    if (!this._scanning) return "Scan paused. Tap Scan again to look for glasses.";
    const elapsed = Date.now() - this.startedAtMs;
    if (elapsed < NO_RESULTS_HINT_AFTER_MS) return "Listening for glasses…";
    return (
      "No glasses heard yet. Make sure they are out of the case and not connected to another app. " +
      "On Android 11 and older, Location must also be switched on for Bluetooth scanning to return results."
    );
  }

  get emptyRingVisibility(): "visible" | "collapse" {
    return this._ringRows.length ? "collapse" : "visible";
  }

  get emptyRingMessage(): string {
    return this._scanning ? "No ring heard yet. Tap the ring to wake it if you have one." : "";
  }

  get selectionVisibility(): "visible" | "collapse" {
    return this.selectedPair || this.selectedRing ? "visible" : "collapse";
  }

  get selectionSummary(): string {
    const parts: string[] = [];
    if (this.selectedPair) {
      const identity = this.selectedPair.identity;
      const label = identity ? identity.displayName : "Even Realities G2";
      parts.push(
        `${label} · serial ${this.selectedPair.serial ?? "unknown"}\n` +
          `Left ${this.selectedPair.left?.address ?? "?"} · Right ${this.selectedPair.right?.address ?? "?"}`,
      );
    }
    if (this.selectedRing) {
      parts.push(`Ring ${this.selectedRing.advertisement.name} · ${this.selectedRing.advertisement.address}`);
    }
    return parts.join("\n");
  }

  get primaryLabel(): string {
    return this.onboarding ? "Continue" : "Save";
  }

  get primaryEnabled(): boolean {
    return !!this.selectedPair || (!this.onboarding && !!this.selectedRing);
  }

  get secondaryLabel(): string {
    return this.onboarding ? "Back" : "Cancel";
  }

  // --- actions ---------------------------------------------------------------

  // Arrow property: NativeScript fires XML event handlers with `this` bound to the
  // tapped view's bindingContext (the row item), not the view model.
  readonly onRowTap = (args: EventData): void => {
    const row = (args.object as View).bindingContext as PairingRowItem | undefined;
    if (!row) return;
    if (row.kind === "glasses") {
      const pair = this.aggregator.pairs().find((candidate) => candidate.id === row.id) ?? null;
      if (!pair) return;
      if (!row.canSelect) {
        this.status = row.warning || `${row.modelTitle}: ${row.armsSummary}. Both arms must be heard before pairing.`;
        return;
      }
      this.selectedPair = this.selectedPair?.id === pair.id ? null : pair;
    } else {
      const ring = this.aggregator.rings().find((candidate) => candidate.id === row.id) ?? null;
      this.selectedRing = this.selectedRing?.id === ring?.id ? null : ring;
    }
    this.refresh();
  };

  onPrimaryTap(): void {
    const pair = this.selectedPair;
    const ring = this.selectedRing;
    if (!pair && !ring) return;
    // refresh() drops a selection whose pair regressed below complete, but the
    // tap can race a prune: never fall back to previously stored addresses for
    // a missing arm — that silently welds together arms of two different pairs.
    if (pair && (!pair.left || !pair.right)) return;
    const existing = loadDeviceAddresses();
    const addresses = {
      right: pair ? pair.right!.address : existing.right,
      left: pair ? pair.left!.address : existing.left,
      ring: ring?.advertisement.address ?? existing.ring,
    };
    saveDeviceAddresses(addresses);
    if (pair) {
      savePairedGlassesIdentity({
        serial: pair.serial ?? "",
        leftName: pair.left!.name,
        rightName: pair.right!.name,
        leftAddress: pair.left!.address,
        rightAddress: pair.right!.address,
        ringName: ring?.advertisement.name ?? (addresses.ring === existing.ring ? (loadPairedGlassesIdentity()?.ringName ?? "") : ""),
        ringAddress: addresses.ring,
        pairedAtMs: Date.now(),
      });
    } else if (ring) {
      // Replacing just the ring: keep the stored glasses identity current so
      // the config page doesn't keep naming the old ring.
      const identity = loadPairedGlassesIdentity();
      if (identity) {
        savePairedGlassesIdentity({
          ...identity,
          ringName: ring.advertisement.name,
          ringAddress: ring.advertisement.address,
        });
      }
    }
    this.dispose();
    if (this.onboarding) {
      setPreviewOnlyMode(false);
      // Continue the onboarding chain: check the glasses' firmware next.
      Frame.topmost()?.navigate({ moduleName: "phone-ui/onboarding-firmware-check-page" });
      return;
    }
    Frame.topmost()?.navigate({ moduleName: "phone-ui/main-page", clearHistory: true });
  }

  onSecondaryTap(): void {
    this.dispose();
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({
      moduleName: this.onboarding ? "phone-ui/onboarding-unpair-page" : "phone-ui/main-page",
      clearHistory: true,
    });
  }

  onManualTap(): void {
    this.stop();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/config-page",
      context: { onboarding: this.onboarding },
    });
  }

  onScanToggleTap(): void {
    if (this._scanning) {
      this.stop();
      return;
    }
    this.aggregator.clear();
    this.advertisementCount = 0;
    void this.start();
  }

  // --- rendering -------------------------------------------------------------

  private refresh(): void {
    this.aggregator.prune(Date.now(), DEFAULT_STALE_AFTER_MS);
    const pairs = this.aggregator.pairs();
    const rings = this.aggregator.rings();

    // Keep the selection pointing at live data (addresses can only change if a
    // side was replaced); drop it if the pair disappeared — or if it degraded
    // below complete (an arm went back in the case), so Save can never write a
    // one-armed selection padded with stale addresses.
    if (this.selectedPair) {
      const live = pairs.find((pair) => pair.id === this.selectedPair!.id) ?? null;
      this.selectedPair = live?.completeness === "complete" ? live : null;
    }
    if (this.selectedRing) {
      this.selectedRing = rings.find((ring) => ring.id === this.selectedRing!.id) ?? null;
    }

    const nearestPair = nearestCandidateId(pairs);
    const nearestRing = nearestCandidateId(rings);
    this._glassesRows = pairs.map((pair) =>
      toRowItem(
        glassesRow(pair, { pairedSerial: this.previouslyPairedSerial, nearestId: nearestPair }),
        this.selectedPair?.id === pair.id,
        this.onRowTap,
      ),
    );
    this._ringRows = rings.map((ring) =>
      toRowItem(
        ringRow(ring, { pairedRingAddress: this.previouslyPairedRing, nearestId: nearestRing }),
        this.selectedRing?.id === ring.id,
        this.onRowTap,
      ),
    );

    const complete = pairs.filter((pair) => pair.completeness === "complete").length;
    const partial = pairs.length - complete;
    if (this.scanFailure) {
      this.status = `Scan failed: ${this.scanFailure}`;
    } else if (!this._scanning) {
      this.status = "Scan paused.";
    } else if (!pairs.length && !rings.length) {
      this.status = "Scanning…";
    } else {
      const bits = [
        complete ? `${complete} ${complete === 1 ? "pair" : "pairs"} ready` : null,
        partial ? `${partial} with one arm heard` : null,
        rings.length ? `${rings.length} ${rings.length === 1 ? "ring" : "rings"}` : null,
      ].filter(Boolean);
      this.status = `Scanning… ${bits.join(" · ")}. Tap a pair to select it.`;
    }

    for (const property of [
      "glassesRows",
      "ringRows",
      "emptyGlassesVisibility",
      "emptyGlassesMessage",
      "emptyRingVisibility",
      "emptyRingMessage",
      "selectionVisibility",
      "selectionSummary",
      "primaryEnabled",
    ] as const) {
      this.notifyPropertyChange(property, this[property]);
    }
  }

  private formatError(error: unknown): string {
    return formatErrorMessage(error);
  }
}

function toRowItem(row: PairingRowPresentation, selected: boolean, onRowTap: (args: EventData) => void): PairingRowItem {
  const classes = ["pairing-row"];
  if (selected) classes.push("pairing-row-selected");
  if (!row.canSelect) classes.push("pairing-row-incomplete");
  return {
    ...row,
    rowClass: classes.join(" "),
    // The swatch is redundant when the variant photo already shows the finish.
    swatchVisibility: row.swatchHex && !row.hasVariantImage ? "visible" : "collapse",
    colorwayLabel: colorwayLabel(row.colorway),
    badgeVisibility: row.badge ? "visible" : "collapse",
    variantVisibility: row.variantSummary ? "visible" : "collapse",
    proximityLine: `${row.proximityGlyph}  ${row.proximitySummary}`,
    proximityClass: row.zone === "immediate" ? "pairing-proximity pairing-proximity-immediate" : "pairing-proximity",
    armsVisibility: row.armsSummary ? "visible" : "collapse",
    warningVisibility: row.warning ? "visible" : "collapse",
    chevron: selected ? "✓" : row.canSelect ? "›" : "…",
    onRowTap,
  };
}
