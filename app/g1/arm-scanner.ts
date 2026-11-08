/**
 * Finding a G1's arms by listening for them. That's how an install knows what each arm runs before connecting to it,
 * and how it finds an arm again afterwards, when it advertises what it runs now (and, coming from g1v0 before 0.5.66, at
 * a new address).
 */
import { classifyAdvertisement, type EvenAdvertisement } from "../g2/even-advertisement";
import { DiscoveryAggregator, type GlassesPairCandidate } from "../g2/pairing-candidates";
import { DeviceDiscoveryBridge } from "../native/device-discovery";
import { pickG1Pair, sameG1Serial, type G1Side, type G1Wanted } from "./flash-plan";

/** A serial should tell which arm is ours, but an arm that is the only one of its side around is good enough after this. */
const ACCEPT_ANY_SERIAL_AFTER_MS = 45_000;

export class G1ArmScanner {
  private discovery: DeviceDiscoveryBridge | null = null;
  private finish: (() => void) | null = null;

  /** Resolves with the wanted pair once both arms have been heard, or null after [timeoutMs]. */
  waitForPair(wanted: G1Wanted, timeoutMs: number): Promise<GlassesPairCandidate | null> {
    const aggregator = new DiscoveryAggregator();
    return this.listen<GlassesPairCandidate>(timeoutMs, (raw, done) => {
      if (aggregator.ingest(raw)) {
        const pair = pickG1Pair(aggregator.pairs(), wanted);
        if (pair) done(pair);
      }
    });
  }

  /** Resolves when an arm of this side on g1v0 is heard, or null after [timeoutMs]. */
  waitForG1v0Arm(side: G1Side, serial: string | null | undefined, timeoutMs: number): Promise<EvenAdvertisement | null> {
    return this.waitForArm(side, serial, timeoutMs, (arm) => arm.g1Firmware !== "stock");
  }

  /** Resolves when an arm of this side is heard that [accept] takes, on any firmware, or null after [timeoutMs]. */
  waitForArm(
    side: G1Side,
    serial: string | null | undefined,
    timeoutMs: number,
    accept: (arm: EvenAdvertisement) => boolean,
  ): Promise<EvenAdvertisement | null> {
    const startedAt = Date.now();
    const others = new Map<string, EvenAdvertisement>();
    return this.listen<EvenAdvertisement>(timeoutMs, (raw, done) => {
      const arm = classifyAdvertisement(raw);
      if (!arm || arm.role !== side || !arm.g1Firmware || !accept(arm)) return;
      if (!serial || sameG1Serial(arm.serial, serial)) {
        done(arm);
        return;
      }
      others.set(arm.address, arm);
      if (others.size === 1 && Date.now() - startedAt >= ACCEPT_ANY_SERIAL_AFTER_MS) done(arm);
    });
  }

  stop(): void {
    this.finish?.();
  }

  private listen<T>(timeoutMs: number, onRaw: (raw: Parameters<DiscoveryAggregator["ingest"]>[0], done: (value: T) => void) => void): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.discovery ??= new DeviceDiscoveryBridge();
      const discovery = this.discovery;
      if (!discovery.bluetoothEnabled) {
        reject(new Error("Bluetooth is off. Turn it on, then try again."));
        return;
      }
      let settled = false;
      const settle = (value: T | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finish = null;
        discovery.stopScan();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      this.finish = () => settle(null);
      const started = discovery.startScan({
        onAdvertisement: (raw) => onRaw(raw, (value) => settle(value)),
        onScanFailed: (_code, message) => settle(null, new Error(`The Bluetooth scan failed: ${message}`)),
      });
      if (!started) settle(null, new Error("Could not start the Bluetooth scan. Check that Bluetooth is on."));
    });
  }
}
