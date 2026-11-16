import { getDefaultSmallFont } from "../graphics/ui-fonts";
import {
  DEFAULT_KEYS_HELP,
  KEY_ACTIONS,
  chordId,
  describeChord,
  keyActionLabel,
  type KeyChord,
} from "../g2/keyboard/bindings";
import { keyboardService } from "../g2/keyboard/service";
import { TextViewerLayer } from "../apps/files/text-viewer";
import type { LayerContext } from "./layers";
import { drawRightValueMenuItem, MenuLayer, openModalMenu, submenuItem, TextPageLayer, type MenuItem } from "./menu";

/**
 * Settings > Keyboard > Keybindings: the custom keybindings (a key, with
 * any modifiers held, to a gesture), which come before the built-in
 * meanings in app/g2/keyboard/bindings.ts. Adding one asks for the key on
 * the keyboard itself, so it works for a remote whose buttons send who
 * knows what.
 */

/** Waits for the key to bind. Double tap backs out, as from any page. */
class KeyCaptureLayer extends TextPageLayer {
  private cancel: (() => void) | null = null;

  constructor(private readonly onChord: (chord: KeyChord, ctx: LayerContext) => void) {
    super(
      "Add keybinding",
      "Press the key to bind, on the keyboard. Hold Shift, Ctrl or Alt with it to bind the combination.",
    );
  }

  open(ctx: LayerContext): void {
    ctx.stack.push(this);
    this.cancel = keyboardService.captureNextKey((chord) => {
      this.cancel = null;
      ctx.stack.popThrough(this);
      this.onChord(chord, ctx);
      ctx.actions.requestRender();
    });
  }

  onRemoved(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

class KeybindingsLayer extends MenuLayer {
  constructor(viewport: { width: number; height: number }) {
    super("Keybindings", [], {
      x: "center",
      y: 8,
      width: Math.min(320, viewport.width - 40),
      minHeight: Math.min(160, viewport.height - 40),
      maxHeight: Math.min(240, viewport.height - 40),
      depth: 4,
    });
  }

  open(ctx: LayerContext): void {
    this.updateRows();
    ctx.stack.push(this);
  }

  /** Rebuild the rows, with the highlight on `selectId`'s keybinding when given. */
  private updateRows(selectId?: string): void {
    const bindings = keyboardService.keyBindings();
    const rows: MenuItem[] = bindings.map((binding) => {
      const label = describeChord(binding.chord);
      return {
        label,
        onSelect: (ctx: LayerContext) => this.pickAction(ctx, binding.chord),
        render: ({ image, x, y, width }) => {
          drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, keyActionLabel(binding.action));
        },
      };
    });
    rows.push(
      { label: "Add keybinding", onSelect: (ctx) => this.add(ctx) },
      // Scrolls, where a page would cut the text off in a short window.
      submenuItem("Default keys", (ctx) => ctx.stack.push(new TextViewerLayer(DEFAULT_KEYS_HELP, "Default keys"))),
    );
    const selected = selectId === undefined ? -1 : bindings.findIndex((binding) => chordId(binding.chord) === selectId);
    if (selected >= 0) this.setItems(rows, selected);
    else this.setItems(rows);
  }

  private add(ctx: LayerContext): void {
    if (!keyboardService.bridge.isConnected()) {
      ctx.stack.push(new TextPageLayer(
        "Add keybinding",
        "No keyboard is connected. Pair or reconnect one under Bluetooth keyboard, then come back: the key to bind is read from the keyboard.",
      ));
      return;
    }
    new KeyCaptureLayer((chord, captureCtx) => this.pickAction(captureCtx, chord)).open(ctx);
  }

  /** Choose what `chord` does: for a new keybinding, or to change or remove one. */
  private pickAction(ctx: LayerContext, chord: KeyChord): void {
    const id = chordId(chord);
    const current = keyboardService.keyBindings().find((binding) => chordId(binding.chord) === id)?.action;
    const done = (inner: LayerContext): void => {
      inner.stack.pop();
      this.updateRows(id);
      inner.actions.requestRender();
    };
    const rows: MenuItem[] = KEY_ACTIONS.map((entry) => ({
      label: entry.action === current ? `${entry.label} *` : entry.label,
      onSelect: (inner: LayerContext) => {
        if (!keyboardService.setKeyBinding(chord, entry.action)) {
          inner.stack.pop();
          inner.stack.push(new TextPageLayer("Keybindings", "There is no room for another keybinding. Remove one first."));
          return;
        }
        done(inner);
      },
    }));
    if (current !== undefined) {
      rows.push({
        label: "Remove keybinding",
        onSelect: (inner) => {
          keyboardService.removeKeyBinding(chord);
          done(inner);
        },
      });
    }
    const selected = Math.max(0, KEY_ACTIONS.findIndex((entry) => entry.action === current));
    openModalMenu(ctx, describeChord(chord), rows, selected);
  }
}

/** The Settings row that opens the keybindings menu. */
export function keybindingsMenuItem(): MenuItem {
  return {
    label: "Keybindings",
    description:
      "Choose what keys do: arrows, Enter and Esc navigate by default, and any key (or a remote's button) can be bound to select, back, a swipe, a scroll or a menu.",
    onSelect: (ctx) => new KeybindingsLayer(ctx.stack.getBaseSize()).open(ctx),
    render: ({ image, x, y, width }) => {
      const count = keyboardService.keyBindings().length;
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "Keybindings", count ? `${count} custom` : "Default");
    },
  };
}
