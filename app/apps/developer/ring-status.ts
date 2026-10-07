import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { ringConnectionModeSetting } from "../../ui/dashboard-settings";
import { loadDeviceAddresses } from "../../g2/device-addresses";
import {
  getRingSessionStatus,
  getRingSystemBluetoothState,
  sendRingConfigCommand,
  setGlassesRingLink,
  type GlassesRingLinkAction,
  type RingConfigAction,
  type RingSessionStatus,
  type RingSystemBluetoothState,
} from "../../native/ring-status";

const POLL_INTERVAL_MS = 1_000;
const LEFT_X = 16;
const VALUE_X = 130;
const BUTTON_GAP = 8;

type Row = { label: string; value: string; dim?: boolean };
type Button = "glasses" | "ring" | "mode";

const BUTTONS: readonly Button[] = ["glasses", "ring", "mode"];

/** Glasses-side commands (sid 0x80 pair manager). */
const GLASSES_ACTIONS: readonly { label: string; action: GlassesRingLinkAction }[] = [
  { label: "Disconnect ring", action: "disconnect" },
  { label: "Release ring", action: "release" },
  { label: "Unpair ring", action: "unpair" },
  { label: "Connect ring", action: "connect" },
];

/** Ring-side commands over the direct link, and the combined flows. */
const RING_ACTIONS: readonly { label: string; action: RingConfigAction }[] = [
  { label: "Bind to these glasses", action: "bind" },
  { label: "Unbind from glasses", action: "unbind" },
  { label: "Targets: these glasses", action: "targets-glasses" },
  { label: "Targets: clear (any)", action: "targets-clear" },
  { label: "Remove ring notify", action: "remove-ring" },
  { label: "Touch source on", action: "touch-on" },
  { label: "Touch source off", action: "touch-off" },
  { label: "Pair auth (phone role)", action: "pair-auth" },
];

const ACTION_MENU_LAYOUT = { x: "center" as const, y: 8, width: 300, dimUnderneath: 0.35 };

/**
 * Where R1 ring input is coming from: the phone's own Bluetooth link to the
 * ring, the direct-link session state, and when input last arrived directly
 * versus relayed by the glasses. The ring sends gestures only to whichever
 * link holds its glasses role, so the two "input" rows are the quickest way
 * to see which path is live.
 *
 * Everything below is EXPERIMENTAL (see GlassesSessionRing.kt and
 * notes/ring-link-control.md). "Glasses..." sends sid 0x80 ring-link commands
 * to the glasses; "Ring..." sends binding commands to the ring over the
 * direct link (Mode must be direct and the link up), including Bind/Unbind,
 * which do both halves in the official app's order. Mode flips the Developer
 * "Ring connection" setting (applies on the next glasses connection). In
 * Direct mode the session does the setup on its own (see
 * GlassesSessionRing.runRingGlassesSetup); the menus are for experiments.
 */
export class RingStatusLayer implements Layer {
  private session: RingSessionStatus | null = null;
  private system: RingSystemBluetoothState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private selected = 0;
  private notice = "";

  constructor(
    private readonly windowId: string,
    private readonly requestRender: () => void,
  ) {
    this.poll();
    this.timer = setInterval(() => {
      this.poll();
      if (shell.isWindowVisible(this.windowId)) this.requestRender();
    }, POLL_INTERVAL_MS);
  }

  onRemoved(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ringAddress(): string {
    return this.session?.ringAddress || loadDeviceAddresses().ring;
  }

  private poll(): void {
    this.session = getRingSessionStatus();
    const address = this.ringAddress();
    this.system = address ? getRingSystemBluetoothState(address) : null;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const lineStep = font.lineHeight + 2;
    const buttonHeight = font.lineHeight + 8;
    const buttonTop = height - buttonHeight - 6;

    image.drawText(font, 18, 10, "Ring status", 230);
    let y = 10 + lineStep + 4;
    const rows = this.rows();
    if (this.notice) rows.push({ label: "", value: this.notice });
    for (const row of rows) {
      if (y + font.lineHeight > buttonTop - 4) break;
      image.drawText(font, LEFT_X, y, row.label, row.dim ? 100 : 150);
      image.drawText(font, VALUE_X, y, row.value, row.dim ? 120 : 220);
      y += lineStep;
    }

    const buttonWidth = Math.floor((width - 2 * LEFT_X - BUTTON_GAP * (BUTTONS.length - 1)) / BUTTONS.length);
    BUTTONS.forEach((button, index) => {
      const x = LEFT_X + index * (buttonWidth + BUTTON_GAP);
      const selected = index === this.selected;
      if (selected) image.fillRoundedRect(x, buttonTop, buttonWidth, buttonHeight, 40, 4);
      image.drawRoundedRect(x, buttonTop, buttonWidth, buttonHeight, selected ? 200 : 70, 4);
      const text = buttonLabel(button);
      image.drawText(font, x + Math.max(0, Math.floor((buttonWidth - font.measureText(text)) / 2)),
        buttonTop + 4, text, selected ? 255 : 170);
    });
    return image;
  }

  private rows(): Row[] {
    const s = this.session;
    const address = this.ringAddress();
    const rows: Row[] = [
      { label: "Ring", value: address || "none paired" },
      { label: "Phone BT", value: describeSystem(this.system) },
    ];

    if (!s) {
      rows.push({ label: "Session", value: "not connected to glasses", dim: true });
      return rows;
    }

    if (!s.directEnabled) {
      const pending = ringConnectionModeSetting.get() !== "glasses";
      rows.push({ label: "Direct link", value: pending ? "on after glasses reconnect" : "off (only via glasses)", dim: true });
    } else {
      const state = s.directNotificationsReady ? "subscribed"
        : s.directConnected ? "connected, subscribing"
        : "not connected";
      const since = s.directStateAgeMs >= 0 ? ` ${formatAge(s.directStateAgeMs)}` : "";
      const battery = s.directBattery >= 0 ? `, ${s.directBattery}%` : "";
      rows.push({
        label: "Direct link",
        value: `${state}${since}, role ${s.directRole}, ${s.directConnectCount} connects${battery}`,
      });
    }
    if (s.directEnabled && s.directRole === "glasses") {
      rows.push({
        label: "Direct auth",
        value: s.directGlassesAuth ? `${s.directGlassesAuth} ${formatAge(s.directGlassesAuthAgeMs)} ago` : "not sent yet",
      });
    }
    rows.push({ label: "Direct input", value: describeInput(s.lastDirectInputAgeMs, s.lastDirectInput) });
    if (s.directEnabled) {
      rows.push({ label: "Direct pkts", value: describeAge(s.lastDirectNotifyAgeMs) });
      if (s.lastDirectRaw) {
        rows.push({ label: "Direct raw", value: `${formatAge(s.lastDirectRawAgeMs)} ago: ${s.lastDirectRaw}` });
      }
    }
    rows.push({ label: "Glasses input", value: describeInput(s.lastGlassesInputAgeMs, s.lastGlassesInput) });
    rows.push({
      label: "Glasses ring",
      value: (s.glassesRingBatteryAgeMs < 0 ? "battery not reported"
        : `${s.glassesRingBattery >= 0 ? `battery ${s.glassesRingBattery}%` : "no battery"} ${formatAge(s.glassesRingBatteryAgeMs)} ago`)
        + (s.glassesRingMac ? `, mac ${s.glassesRingMac}` : ""),
    });
    if (s.lastGlassesReport) {
      rows.push({ label: "Glasses said", value: `${s.lastGlassesReport} (${formatAge(s.lastGlassesReportAgeMs)} ago)` });
    }
    if (s.lastRingCommand) {
      rows.push({
        label: "Ring cmd",
        value: `${s.lastRingCommand} ${formatAge(s.lastRingCommandAgeMs)} ago: ${s.lastRingCommandResult}`,
      });
    }
    if (s.lastCommand) {
      rows.push({ label: "Glasses cmd", value: `${s.lastCommand} ${formatAge(s.lastCommandAgeMs)} ago` });
      rows.push({ label: "Glasses ack", value: `R ${s.lastCommandResultR}; L ${s.lastCommandResultL}` });
    }
    if (s.lastDirectError) rows.push({ label: "Direct error", value: s.lastDirectError, dim: true });
    return rows;
  }

  private activate(ctx: LayerContext): void {
    switch (BUTTONS[this.selected]!) {
      case "glasses":
        ctx.stack.push(this.actionMenu("Glasses ring link", GLASSES_ACTIONS.map(({ label, action }) => ({
          label,
          onSelect: (menuCtx) => {
            this.runGlassesAction(label, action);
            menuCtx.stack.pop();
          },
        }))));
        return;
      case "ring":
        ctx.stack.push(this.actionMenu("Ring binding", RING_ACTIONS.map(({ label, action }) => ({
          label,
          onSelect: (menuCtx) => {
            this.notice = `${label}: ${sendRingConfigCommand(action, this.ringAddress(), this.system?.name ?? "")}`;
            this.poll();
            menuCtx.stack.pop();
          },
        }))));
        return;
      case "mode": {
        const next = ringConnectionModeSetting.set(ringConnectionModeSetting.next());
        this.notice = `Ring connection set to ${ringConnectionModeSetting.displayValue(next)}; applies on next glasses connection`;
        return;
      }
    }
  }

  private actionMenu(title: string, items: MenuItem[]): MenuLayer {
    return new MenuLayer(title, items, ACTION_MENU_LAYOUT);
  }

  private runGlassesAction(label: string, action: GlassesRingLinkAction): void {
    this.notice = setGlassesRingLink(action, this.ringAddress(), this.system?.name ?? "")
      ? `${label} sent (experimental)`
      : `${label} not sent (no session or no ring address)`;
    this.poll();
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.selected = (this.selected + BUTTONS.length - 1) % BUTTONS.length;
        return;
      case "scroll-down":
        this.selected = (this.selected + 1) % BUTTONS.length;
        return;
      case "click":
        this.activate(ctx);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

function buttonLabel(button: Button): string {
  switch (button) {
    case "glasses":
      return "Glasses...";
    case "ring":
      return "Ring...";
    case "mode":
      return `Mode: ${ringConnectionModeSetting.get()}`;
  }
}

function describeSystem(sys: RingSystemBluetoothState | null): string {
  if (!sys) return "unknown";
  if (sys.error) return `error: ${sys.error}`;
  if (sys.bonded === undefined) return "unknown";
  const parts = [sys.bonded ? "bonded" : "not bonded"];
  if (sys.gattConnected !== undefined) parts.push(sys.gattConnected ? "GATT up" : "no GATT");
  if (sys.aclConnected !== undefined) parts.push(sys.aclConnected ? "link up" : "no link");
  return parts.join(", ");
}

function describeInput(ageMs: number, label: string): string {
  if (ageMs < 0) return "never";
  return label ? `${formatAge(ageMs)} ago: ${label}` : `${formatAge(ageMs)} ago`;
}

function describeAge(ageMs: number): string {
  return ageMs < 0 ? "never" : `${formatAge(ageMs)} ago`;
}

function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
