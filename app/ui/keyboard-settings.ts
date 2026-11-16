import { getDefaultSmallFont } from "../graphics/ui-fonts";
import type { KeyboardBridgeSnapshot } from "../g2/keyboard/bridge";
import type { KeyboardAdvert } from "../g2/keyboard/protocol";
import { keyboardService } from "../g2/keyboard/service";
import { ConfigSettingString, textSettingMenuItem } from "./dashboard-settings";
import type { LayerContext } from "./layers";
import { drawRightValueMenuItem, MenuLayer, type MenuItem } from "./menu";

/**
 * Settings > Keyboard: pairing a Bluetooth keyboard with the glasses (the
 * CFW keyboard bridge, app/g2/keyboard/). The keyboard pairs with the
 * glasses, not the phone, so all of it happens here, on the glasses: scan,
 * pick, and for a keyboard that wants one, the passkey to type on it.
 */

/** The code a keyboard with a display shows, typed on the phone. Scratch, not a preference. */
const pairingCodeSetting = new ConfigSettingString({
  id: "keyboardPairingCode",
  storageKey: "keyboard.pairingCode",
  label: "Code on keyboard",
  defaultValue: "",
  normalize: (value) => (value ?? "").replace(/\D/g, "").slice(0, 6),
});

const sixDigits = (value: number): string => {
  const text = String(value).padStart(6, "0");
  return `${text.slice(0, 3)} ${text.slice(3)}`;
};

function advertLabel(advert: KeyboardAdvert): string {
  const name = advert.name.trim() || advert.address;
  return name.length > 30 ? `${name.slice(0, 27)}...` : name;
}

/** One line saying where the keyboard stands, for the Settings row and the menu's first row. */
export function keyboardStatusText(snapshot: KeyboardBridgeSnapshot): string {
  const name = snapshot.activeName || snapshot.saved?.name || "keyboard";
  switch (snapshot.state) {
    case "unavailable":
      return snapshot.saved ? "Glasses not connected" : "Not set up";
    case "scanning":
      return "Scanning...";
    case "connecting":
      return `Connecting to ${name}...`;
    case "pairing":
      return `Pairing with ${name}...`;
    case "configuring":
      return `Setting up ${name}...`;
    case "connected":
      return `Connected: ${name}`;
    case "error":
      return snapshot.error || "Failed";
    default:
      if (snapshot.waiting) return `Waiting for ${name}`;
      return snapshot.saved ? `${name} (disconnected)` : "Not set up";
  }
}

/** The short form for the right edge of the Settings row. */
function keyboardStatusBrief(snapshot: KeyboardBridgeSnapshot): string {
  switch (snapshot.state) {
    case "connected":
      return "Connected";
    case "scanning":
      return "Scanning";
    case "connecting":
    case "pairing":
    case "configuring":
      return "Connecting";
    case "error":
      return "Failed";
    case "unavailable":
      return snapshot.saved ? "Offline" : "Off";
    default:
      return snapshot.waiting ? "Waiting" : snapshot.saved ? "Disconnected" : "Off";
  }
}

const info = (label: string): MenuItem => ({ label, disabled: true, onSelect: () => {} });

class KeyboardSettingsLayer extends MenuLayer {
  private unsubscribe: (() => void) | null = null;
  private showOthers = false;
  /** What kind of rows are showing; a change moves the highlight to the first row that does something. */
  private shape = "";

  constructor(viewport: { width: number; height: number }) {
    super("Bluetooth keyboard", [], {
      x: "center",
      y: 8,
      width: Math.min(320, viewport.width - 40),
      minHeight: Math.min(160, viewport.height - 40),
      maxHeight: Math.min(240, viewport.height - 40),
      depth: 4,
    });
  }

  open(ctx: LayerContext): void {
    ctx.stack.push(this);
    this.updateRows();
    this.unsubscribe = keyboardService.subscribe(() => {
      this.updateRows();
      ctx.actions.requestRender();
    });
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Run a bridge command; its failure shows up in the snapshot, which repaints the rows. */
  private run(action: () => Promise<unknown>): void {
    void action().catch(() => {});
  }

  private updateRows(): void {
    const snapshot = keyboardService.snapshot();
    const bridge = keyboardService.bridge;
    const rows: MenuItem[] = [info(keyboardStatusText(snapshot))];
    let shape: string = snapshot.state;

    const scanRow = (label: string): MenuItem => ({
      label,
      disabled: snapshot.busy,
      onSelect: () => {
        this.showOthers = false;
        this.run(() => bridge.scan());
      },
    });

    if (snapshot.state === "unavailable") {
      rows.push(info("Connect G2 glasses to pair one."));
      if (snapshot.saved) rows.push({ label: `Forget ${snapshot.saved.name || "keyboard"}`, onSelect: () => this.run(() => bridge.forget()) });
    } else if (snapshot.pairing) {
      const pairing = snapshot.pairing;
      shape = `pairing:${pairing.kind}`;
      if (pairing.kind === "display") {
        rows.push(info(`Type ${sixDigits(pairing.pin)} on the keyboard,`), info("then press Enter."));
      } else if (pairing.kind === "compare") {
        rows.push(
          info(`Does the keyboard show ${sixDigits(pairing.value)}?`),
          { label: "Yes, pair", onSelect: () => this.run(() => bridge.answerCompare(true)) },
          { label: "No", onSelect: () => this.run(() => bridge.answerCompare(false)) },
        );
      } else {
        rows.push(
          info("Enter the code the keyboard shows."),
          textSettingMenuItem(pairingCodeSetting),
          {
            label: "Pair with this code",
            disabled: () => pairingCodeSetting.get().length !== 6,
            onSelect: () => {
              const code = pairingCodeSetting.get();
              pairingCodeSetting.set("");
              this.run(() => bridge.answerPasskey(parseInt(code, 10)));
            },
          },
        );
      }
      rows.push({ label: "Cancel pairing", onSelect: () => this.run(() => bridge.disconnect()) });
    } else if (snapshot.state === "connecting" || snapshot.state === "pairing" || snapshot.state === "configuring") {
      rows.push({ label: "Cancel", onSelect: () => this.run(() => bridge.disconnect()) });
    } else if (snapshot.state === "scanning" || (snapshot.scanResults.length > 0 && snapshot.state !== "connected")) {
      shape = "results";
      const hid = snapshot.scanResults.filter((advert) => advert.hid);
      const others = snapshot.scanResults.filter((advert) => !advert.hid);
      const pick = (advert: KeyboardAdvert): MenuItem => ({
        label: advertLabel(advert),
        disabled: snapshot.busy,
        onSelect: () => {
          this.run(() => bridge.connect({ address: advert.address, addressType: advert.addressType, name: advert.name.trim() || advert.address }));
        },
      });
      rows.push(...hid.map(pick));
      if (!hid.length && snapshot.state !== "scanning") rows.push(info("No keyboards found."), info("Put it in pairing mode."));
      if (others.length && this.showOthers) rows.push(...others.map(pick));
      else if (others.length) {
        rows.push({
          label: `Show ${others.length} other device${others.length === 1 ? "" : "s"}`,
          onSelect: (ctx) => {
            this.showOthers = true;
            this.updateRows();
            ctx.actions.requestRender();
          },
        });
      }
      if (snapshot.state !== "scanning") rows.push(scanRow("Scan again"));
      if (snapshot.saved && snapshot.state !== "scanning") {
        rows.push({ label: `Reconnect ${snapshot.saved.name || "keyboard"}`, disabled: snapshot.busy, onSelect: () => this.run(() => bridge.reconnect()) });
      }
    } else if (snapshot.state === "connected") {
      rows.push(
        { label: "Disconnect", onSelect: () => this.run(() => bridge.disconnect()) },
        { label: "Forget this keyboard", onSelect: () => this.run(() => bridge.forget()) },
        scanRow("Pair a different keyboard"),
      );
    } else if (snapshot.saved) {
      shape = snapshot.waiting ? "waiting" : "saved";
      rows.push({ label: "Reconnect now", disabled: snapshot.busy, onSelect: () => this.run(() => bridge.reconnect()) });
      if (snapshot.waiting) rows.push({ label: "Stop reconnecting", onSelect: () => this.run(() => bridge.disconnect()) });
      rows.push(
        { label: "Forget this keyboard", onSelect: () => this.run(() => bridge.forget()) },
        scanRow("Pair a different keyboard"),
      );
    } else {
      shape = "empty";
      rows.push(info("Put the keyboard in pairing mode,"), info("then scan."), scanRow("Scan for keyboards"));
    }

    const firstAction = rows.findIndex((row) => row.disabled !== true);
    if (shape !== this.shape) {
      this.shape = shape;
      this.setItems(rows, Math.max(0, firstAction));
    } else {
      this.setItems(rows);
    }
  }
}

/** The Settings row that opens the keyboard menu. */
export function keyboardSettingsMenuItem(): MenuItem {
  return {
    label: "Bluetooth keyboard",
    description:
      "Pair a Bluetooth keyboard with the glasses. It types into Terminal sessions, and its arrow keys, Enter and Escape work everywhere as scroll, select and back.",
    onSelect: (ctx) => new KeyboardSettingsLayer(ctx.stack.getBaseSize()).open(ctx),
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "Bluetooth keyboard", keyboardStatusBrief(keyboardService.snapshot()));
    },
  };
}
