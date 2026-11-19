/**
 * The phone side of the CFW keyboard bridge for one glasses session: the
 * client, the remembered keyboard, reconnecting it, and what the UI shows.
 * The session hands it field-131 records and a way to send controls; the
 * rest stays in here. Modelled on the Glassly app's G2KeyboardBridge (MIT).
 *
 * The firmware keeps nothing across a reboot (it comes back with the bridge
 * off), and holds the keyboard's connection only while told to. So the
 * remembered keyboard is brought back whenever the glasses link comes up and
 * whenever the keyboard drops, backing off while it stays away. The
 * discovered handle mapping is good for one connection and is never stored.
 * No platform imports: this runs under node in the tests.
 */
import { KeyboardClient, KeyboardClientError, type KeyboardStatus } from "./client";
import type { HidKeyEvent, HidPointerSample } from "./hid";
import {
  KeyboardDm,
  KeyboardError,
  mergeKeyboardAdverts,
  parseKeyboardAddress,
  type KeyboardAdvert,
} from "./protocol";

export type SavedKeyboard = { address: string; addressType: number; name: string };

export type KeyboardBridgeState =
  /** No glasses link that can host a keyboard. */
  | "unavailable"
  | "idle"
  | "scanning"
  | "connecting"
  | "pairing"
  | "configuring"
  | "connected"
  | "error";

/** A pairing step waiting on the user. */
export type KeyboardPairingPrompt =
  /** Type this on the keyboard, then Enter. */
  | { kind: "display"; pin: number }
  /** Confirm both sides show this value (answerCompare). */
  | { kind: "compare"; value: number }
  /** The keyboard shows a code to enter here (answerPasskey). */
  | { kind: "entry" };

export type KeyboardBridgeSnapshot = {
  state: KeyboardBridgeState;
  saved: SavedKeyboard | null;
  /** Name of the keyboard being connected or in use. */
  activeName: string;
  error: string;
  pairing: KeyboardPairingPrompt | null;
  /** Advertisers from the last scan, HID devices first, strongest first. */
  scanResults: KeyboardAdvert[];
  /** A user-started scan or connect is running. */
  busy: boolean;
  /** The remembered keyboard is away and the bridge keeps trying to bring it back. */
  waiting: boolean;
  /** The connected keyboard has a touchpad or mouse buttons. */
  pointer: boolean;
};

export type KeyboardBridgeHost = {
  /** Queue a control record on the live session; false when there is none. */
  send(record: Uint8Array): boolean;
  loadSaved(): SavedKeyboard | null;
  storeSaved(saved: SavedKeyboard | null): void;
  /** Key transitions from the keyboard (including forced releases). */
  onKeys(events: HidKeyEvent[]): void;
  /** A report from the keyboard's touchpad or mouse (including a forced release of its buttons). */
  onPointer(sample: HidPointerSample): void;
  /** The keyboard stopped being usable; drop held-key state without releases. */
  onKeyboardGone(): void;
  /** Something in snapshot() changed. */
  onChanged(): void;
  /**
   * A line for the log. `routine` marks the ones that repeat for as long as
   * a remembered keyboard stays away, which only a verbose log wants.
   */
  log(line: string, routine?: boolean): void;
  /** A fresh six-digit pairing passkey from a good random source. */
  randomPasskey?(): number;
  /**
   * Whether looking for an absent keyboard is worthwhile now. Each attempt
   * has the glasses' radio listening for the keyboard for up to half a
   * minute, so the owner limits it to when the glasses are in use, and calls
   * retryNow() when that starts. Default: always.
   */
  shouldReconnect?(): boolean;
};

/** Delay before each automatic attempt after a failure; the last one repeats. */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
/** After the glasses link comes up, before the first attempt. */
const RESUME_DELAY_MS = 1_000;
/** After the keyboard drops (it may just be going to sleep). */
const DROP_RETRY_DELAY_MS = 2_000;
const RELEASE_POLLS = 20;
const RELEASE_POLL_MS = 150;

export class KeyboardBridge {
  private client: KeyboardClient | null = null;
  private available = false;
  private state: KeyboardBridgeState = "unavailable";
  private saved: SavedKeyboard | null;
  private activeName = "";
  private error = "";
  private pairing: KeyboardPairingPrompt | null = null;
  private scanResults: KeyboardAdvert[] = [];
  /** A user-started scan/connect holds the bridge. */
  private busy = false;
  /** The keyboard is connected, encrypted and subscribed. */
  private ready = false;
  private userDisconnected = false;
  /** The keyboard was let go while the glasses were out of reach; tell the firmware when they are back. */
  private releaseOnLink = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** Bumped whenever the client is replaced; work started for an older one stops quietly. */
  private generation = 0;

  constructor(private readonly host: KeyboardBridgeHost) {
    this.saved = host.loadSaved();
  }

  snapshot(): KeyboardBridgeSnapshot {
    return {
      state: this.state,
      saved: this.saved,
      activeName: this.activeName,
      error: this.error,
      pairing: this.pairing,
      scanResults: sortAdverts(this.scanResults),
      busy: this.busy,
      waiting: this.available && !!this.saved && !this.ready && !this.userDisconnected && !this.busy,
      pointer: this.ready && this.client?.configuration?.pointer === true,
    };
  }

  /** True while key events can arrive. */
  isConnected(): boolean {
    return this.ready;
  }

  // ---------- Link lifecycle (driven by the session owner) ----------

  /** The glasses link is up on firmware with the bridge: bring the remembered keyboard back. */
  linkReady(): void {
    if (this.available) return;
    this.available = true;
    this.userDisconnected = false;
    this.reconnectAttempt = 0;
    this.error = "";
    const client = this.replaceClient();
    this.setState("idle");
    if (this.saved && !this.releaseOnLink) {
      this.scheduleReconnect(RESUME_DELAY_MS);
    } else if (this.releaseOnLink && client) {
      this.userDisconnected = !!this.saved;
      client.query().then((status) => {
        if (status.enabled || status.conn) return client.disable();
      }).catch(() => {});
    }
    this.releaseOnLink = false;
  }

  /** The glasses link is gone. Only the remembered keyboard survives. */
  linkLost(): void {
    if (!this.available && !this.client) return;
    this.available = false;
    this.cancelReconnect();
    this.generation++;
    this.client?.close();
    this.client = null;
    this.busy = false;
    this.pairing = null;
    this.error = "";
    this.dropKeyboard();
    this.setState("unavailable");
  }

  /**
   * The app is about to close the glasses link on purpose: tell the firmware
   * to let the keyboard go, so it isn't left attached to glasses nobody is
   * listening to. Best effort; nothing waits for the answer.
   */
  linkClosing(): void {
    const client = this.client;
    if (!client || !this.available || !client.status.enabled) return;
    client.disable().catch(() => {});
  }

  /** One field-131 payload from the session. */
  accept(payload: Uint8Array): void {
    this.client?.accept(payload);
  }

  /**
   * The keyboard may be reachable now, or is wanted now (the display woke):
   * if it is away and the bridge is waiting out a backoff, try at once.
   */
  retryNow(): void {
    if (!this.available || !this.saved || this.ready || this.userDisconnected || this.busy) return;
    // No timer means an attempt is already in flight.
    if (this.reconnectTimer === null) return;
    this.reconnectAttempt = 0;
    this.scheduleReconnect(0);
  }

  // ---------- Commands (the settings UI) ----------

  /** Scan for about five seconds; results accumulate in the snapshot as they arrive. */
  async scan(): Promise<KeyboardAdvert[]> {
    const client = this.beginUserOperation();
    const generation = this.generation;
    this.scanResults = [];
    this.error = "";
    this.setState("scanning");
    try {
      await this.releaseLink(client);
      await client.enable();
      await client.scan();
      if (generation === this.generation) this.setState("idle");
    } catch (e) {
      if (generation === this.generation) this.fail(e);
      throw friendly(e);
    } finally {
      if (generation === this.generation) this.endUserOperation();
    }
    return sortAdverts(this.scanResults);
  }

  /** Connect, pair and subscribe a keyboard, then remember it. */
  async connect(keyboard: SavedKeyboard): Promise<void> {
    if (!parseKeyboardAddress(keyboard.address) || keyboard.addressType < 0 || keyboard.addressType > 3) {
      throw new KeyboardClientError("Invalid keyboard address");
    }
    const client = this.beginUserOperation();
    const generation = this.generation;
    this.userDisconnected = false;
    try {
      await this.connectWith(client, generation, keyboard, false);
    } finally {
      if (generation === this.generation) this.endUserOperation();
    }
  }

  /** Try the remembered keyboard again now. */
  async reconnect(): Promise<void> {
    if (!this.saved) throw new KeyboardClientError("No remembered keyboard");
    await this.connect(this.saved);
  }

  /** Drop the keyboard but keep it remembered. No automatic reconnect until the next explicit connect or glasses session. */
  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.cancelReconnect();
    const client = this.replaceClient();
    // A scan or connect this interrupts no longer owns the bridge.
    this.busy = false;
    this.dropKeyboard();
    this.pairing = null;
    this.error = "";
    if (!client) {
      this.releaseOnLink = true;
      this.setState("unavailable");
      return;
    }
    this.setState("idle");
    try {
      await client.query();
      await client.disable();
    } catch (e) {
      this.host.log(`keyboard disconnect: ${messageOf(e)}`);
    }
  }

  /** Forget the remembered keyboard. The glasses keep their bond with it. */
  async forget(): Promise<void> {
    this.saved = null;
    this.host.storeSaved(null);
    await this.disconnect();
    this.scanResults = [];
    this.activeName = "";
    this.host.onChanged();
  }

  /** Answer a "compare" pairing prompt. */
  async answerCompare(accept: boolean): Promise<void> {
    if (!this.client || this.pairing?.kind !== "compare") throw new KeyboardClientError("No pairing comparison is pending");
    this.pairing = null;
    this.host.onChanged();
    await this.client.confirm(accept);
  }

  /** Answer an "entry" pairing prompt with the code the keyboard shows. */
  async answerPasskey(pin: number): Promise<void> {
    if (!this.client || this.pairing?.kind !== "entry") throw new KeyboardClientError("No pairing code is pending");
    this.pairing = null;
    this.host.onChanged();
    await this.client.authenticate(pin);
  }

  // ---------- Internals ----------

  private beginUserOperation(): KeyboardClient {
    if (!this.available) throw new KeyboardClientError("Connect to G2 glasses running Faceclaw firmware first");
    if (this.busy) throw new KeyboardClientError("Another keyboard operation is in progress");
    // An automatic attempt may be mid-flight (a sleeping keyboard holds one
    // for up to 30 s): a fresh client fails it at once and takes over.
    this.cancelReconnect();
    const client = this.replaceClient()!;
    this.dropKeyboard();
    this.pairing = null;
    this.busy = true;
    return client;
  }

  private endUserOperation(): void {
    this.busy = false;
    this.host.onChanged();
  }

  /** Close the current client and, while the link is up, start a fresh one. */
  private replaceClient(): KeyboardClient | null {
    this.generation++;
    this.client?.close();
    this.client = null;
    if (!this.available) return null;
    const generation = this.generation;
    const live = () => generation === this.generation;
    const client = new KeyboardClient(
      (record) => live() && this.host.send(record),
      {
        keys: (events) => { if (live() && this.ready) this.host.onKeys(events); },
        pointer: (sample) => { if (live() && this.ready) this.host.onPointer(sample); },
        advert: (advert) => { if (live()) this.addAdvert(advert); },
        status: (status) => { if (live()) this.onStatus(status); },
        dm: (event, status) => { if (live()) this.onDm(event, status); },
        passkeyDisplay: (pin) => { if (live()) this.prompt({ kind: "display", pin }); },
        passkeyRequest: () => { if (live()) this.prompt({ kind: "entry" }); },
        compareRequest: (value) => { if (live()) this.prompt({ kind: "compare", value }); },
        servicesChanged: () => { if (live()) this.onServicesChanged(); },
        error: (message) => { if (live()) this.host.log(`keyboard: ${message}`); },
        log: (line) => { if (live()) this.host.log(`keyboard setup: ${line}`); },
      },
      { randomPasskey: this.host.randomPasskey ? () => this.host.randomPasskey!() : undefined },
    );
    this.client = client;
    return client;
  }

  private async connectWith(
    client: KeyboardClient,
    generation: number,
    keyboard: SavedKeyboard,
    resume: boolean,
  ): Promise<void> {
    const live = () => generation === this.generation;
    this.error = "";
    this.activeName = keyboard.name;
    this.setState("connecting");
    try {
      const status = await client.query();
      if (resume && status.enabled && status.connected && status.encrypted) {
        // The glasses kept the keyboard through a phone-side drop (or an app
        // restart): only the handle mapping is missing.
        this.host.log("keyboard still connected to the glasses; rediscovering");
      } else {
        await this.releaseLink(client);
        await client.enable();
        await client.connect(keyboard.addressType, parseKeyboardAddress(keyboard.address)!);
      }
      if (!live()) return;
      this.pairing = null;
      this.setState("configuring");
      const config = await client.configure();
      if (!live()) return;
      this.ready = true;
      this.reconnectAttempt = 0;
      // The list was for choosing; it is stale from here on.
      this.scanResults = [];
      if (!sameKeyboard(this.saved, keyboard)) {
        this.saved = { ...keyboard };
        this.host.storeSaved(this.saved);
      }
      this.host.log(
        `keyboard ready: ${keyboard.name || keyboard.address}, ${config.watched.length} of ` +
        `${config.reports.filter((r) => r.type === 1).length} input reports subscribed` +
        `${config.pointer ? ", with a pointer" : ""}, epoch ${config.epoch}`);
      this.setState("connected");
    } catch (e) {
      if (!live()) return;
      this.ready = false;
      this.pairing = null;
      if (resume) {
        // An automatic attempt: a keyboard that is asleep or out of range is
        // the ordinary case, not an error to put in front of the user.
        this.host.log(`keyboard reconnect: ${messageOf(friendly(e))}`, true);
        this.setState("idle");
      } else {
        this.fail(e);
      }
      throw friendly(e);
    }
  }

  /**
   * The firmware refuses SCAN and CONNECT while it still owns a keyboard
   * slot, and an interrupted connect keeps initiating until the close lands.
   * DISABLE is epoch-checked and a fresh client hasn't seen the epoch yet,
   * so QUERY first (it isn't, and its answer carries the epoch), then wait
   * for the slot to clear.
   */
  private async releaseLink(client: KeyboardClient): Promise<void> {
    const status = await client.query();
    if (!status.enabled && status.conn === 0) return;
    await client.disable();
    for (let i = 0; i < RELEASE_POLLS; i++) {
      if ((await client.query()).conn === 0) return;
      await delay(RELEASE_POLL_MS);
    }
    throw new KeyboardClientError("The glasses are still closing the previous keyboard link; try again in a moment");
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(delayMs: number): void {
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delayMs);
  }

  private async attemptReconnect(): Promise<void> {
    const saved = this.saved;
    const client = this.client;
    if (!this.available || !client || !saved || this.userDisconnected || this.ready || this.busy) return;
    if (this.host.shouldReconnect && !this.host.shouldReconnect()) {
      this.parkFirmware(client);
      this.scheduleReconnect(RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]!);
      return;
    }
    const generation = this.generation;
    try {
      await this.connectWith(client, generation, saved, true);
    } catch {
      if (generation !== this.generation || !this.available || this.userDisconnected) return;
      // Keyboards sleep, and the ring's own scan can hold the controller
      // (BUSY): keep trying, less often, while the glasses stay up.
      const backoff = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
      this.reconnectAttempt++;
      this.scheduleReconnect(backoff);
    }
  }

  /**
   * While it is enabled the firmware bridge runs a 20 ms timer and reports
   * its status every second, keyboard or no keyboard. When nothing will be
   * tried for a while, switch it off; the next attempt enables it again.
   */
  private parkFirmware(client: KeyboardClient): void {
    if (!client.status.enabled) return;
    client.disable().catch(() => {});
  }

  private onStatus(status: KeyboardStatus): void {
    if (this.ready && (!status.connected || !status.encrypted)) this.keyboardDropped("status");
    else if (this.state === "connecting" && status.connected && !status.encrypted) this.setState("pairing");
  }

  private onDm(event: number, status: number): void {
    if (event === KeyboardDm.connClose || event === KeyboardDm.pairFailed || event === KeyboardDm.encryptFailed) {
      this.host.log(`keyboard DM event 0x${event.toString(16)} status ${status}`);
      if (this.ready) this.keyboardDropped("dm");
    }
  }

  private onServicesChanged(): void {
    this.host.log("keyboard services changed; rediscovering");
    this.dropKeyboard();
    this.setState("idle");
    if (this.saved && !this.userDisconnected && !this.busy) this.scheduleReconnect(0);
  }

  private keyboardDropped(reason: string): void {
    this.host.log(`keyboard disconnected (${reason})`);
    this.dropKeyboard();
    this.setState("idle");
    if (this.saved && !this.userDisconnected && !this.busy) this.scheduleReconnect(DROP_RETRY_DELAY_MS);
  }

  /** The keyboard is no longer usable: tell the host once. */
  private dropKeyboard(): void {
    if (!this.ready) return;
    this.ready = false;
    this.host.onKeyboardGone();
  }

  private addAdvert(advert: KeyboardAdvert): void {
    const index = this.scanResults.findIndex(
      (a) => a.address === advert.address && a.addressType === advert.addressType);
    if (index < 0) {
      this.scanResults.push(advert);
    } else {
      const merged = mergeKeyboardAdverts(this.scanResults[index]!, advert);
      const old = this.scanResults[index]!;
      if (merged.name === old.name && merged.hid === old.hid && merged.rssi === old.rssi) return;
      this.scanResults[index] = merged;
    }
    this.host.onChanged();
  }

  private prompt(pairing: KeyboardPairingPrompt): void {
    this.pairing = pairing;
    this.setState("pairing");
  }

  private setState(next: KeyboardBridgeState): void {
    this.state = next;
    if (next !== "pairing" && next !== "connecting") this.pairing = null;
    this.host.onChanged();
  }

  private fail(error: unknown): void {
    this.error = messageOf(friendly(error));
    this.host.log(`keyboard error: ${this.error}`);
    this.setState("error");
  }
}

function sameKeyboard(a: SavedKeyboard | null, b: SavedKeyboard): boolean {
  return !!a && a.address === b.address && a.addressType === b.addressType && a.name === b.name;
}

function sortAdverts(adverts: readonly KeyboardAdvert[]): KeyboardAdvert[] {
  return [...adverts].sort((a, b) => Number(b.hid) - Number(a.hid) || b.rssi - a.rssi);
}

/**
 * Firmware BUSY nearly always means the ring's own scan or reconnect holds
 * the radio; say that rather than the raw control error.
 */
function friendly(error: unknown): Error {
  if (error instanceof KeyboardClientError && error.code === KeyboardError.busy) {
    return new KeyboardClientError(
      "The glasses' radio is busy (usually the ring reconnecting). Wait a few seconds and try again.", error.code);
  }
  if (error instanceof KeyboardClientError && error.code === KeyboardError.noSpace) {
    return new KeyboardClientError(
      "The glasses have no room for another connection or pairing.", error.code);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
