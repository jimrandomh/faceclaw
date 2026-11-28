import { GrayImage } from "../graphics/image";
import type { Plane } from "../graphics/plane";
import { paintPointerCursor, POINTER_CURSOR_HEIGHT, POINTER_CURSOR_WIDTH } from "./keyboard/cursor";

export type NeuralBandCursor = { x: number; y: number; primaryDown: boolean };
export type NeuralBandWritingTarget = {
  getText(): string;
  setText(text: string): void;
  setHandwritingActive?(active: boolean): void;
  onBlur?(listener: () => void): () => void;
};

type Bounds = { width: number; height: number };
type ModalitiesHost = {
  setPointer(enabled: boolean): boolean;
  setHandwriting(enabled: boolean): boolean;
  resetHandwritingText(text: string): void;
  pointerChanged(cursor: NeuralBandCursor | null): void;
  pointerClick(x: number, y: number): void;
  pointerBack(): void;
  writingTarget(): NeuralBandWritingTarget | null;
  bounds(): Bounds;
  noteActivity?(): void;
};

// Lumen rust/bridge/src/controller.rs sends [kind, time in seconds, a, b].
// MOVE carries screen degrees and BUTTONS carries the held-button mask.
const RECORD_SIZE = 4;
const MOVE = 0;
const CLEAR = 1;
const BUTTONS = 2;
const PRIMARY_BUTTON = 1;
const SECONDARY_BUTTON = 2;
// Lumen ScreenPointer's default speed: a 30-degree turn spans the short side.
const DEGREES_PER_SCREEN_SHORT_SIDE = 30;
const TAP_LIMIT_SECONDS = 0.4;
const TAP_SLOP_PIXELS = 8;

type PointerState = {
  x: number;
  y: number;
  buttons: number;
  press: { x: number; y: number; time: number; dragged: boolean } | null;
};

type WritingState = {
  target: NeuralBandWritingTarget;
  text: string;
  ready: boolean;
  unsubscribeBlur?: () => void;
};

/** The opt-in phone search field, tracked by its native query field's focus. */
let searchFocus: { target: NeuralBandWritingTarget; release(): void } | null = null;

export function focusNeuralBandSearchTarget(target: NeuralBandWritingTarget): () => void {
  searchFocus?.release();
  const blurListeners = new Set<() => void>();
  const focus = {
    target: {
      getText: () => target.getText(),
      setText: (text: string) => target.setText(text),
      onBlur(listener: () => void) {
        blurListeners.add(listener);
        return () => { blurListeners.delete(listener); };
      },
    },
    release() {
      if (searchFocus !== focus) return;
      searchFocus = null;
      for (const listener of blurListeners) listener();
      blurListeners.clear();
    },
  };
  searchFocus = focus;
  return focus.release;
}

export function focusedNeuralBandSearchTarget(): NeuralBandWritingTarget | null {
  return searchFocus?.target ?? null;
}

const normalCursor = new GrayImage(POINTER_CURSOR_WIDTH, POINTER_CURSOR_HEIGHT, 0);
const heldCursor = new GrayImage(POINTER_CURSOR_WIDTH, POINTER_CURSOR_HEIGHT, 0);
paintPointerCursor(normalCursor, 0, 0, false);
paintPointerCursor(heldCursor, 0, 0, true);

export function neuralBandCursorPlane(cursor: NeuralBandCursor, shellKey: number): Plane {
  return { image: cursor.primaryDown ? heldCursor : normalCursor, x: cursor.x, y: cursor.y, shellKey };
}

/** Owns two exclusive, opt-in input modes. Neither can outlive its UI target. */
export class NeuralBandModalities {
  private pointer: PointerState | null = null;
  private writing: WritingState | null = null;

  constructor(private readonly host: ModalitiesHost) {}

  togglePointer(): boolean {
    if (this.pointer) {
      this.stopPointer(true);
      return true;
    }
    this.stopHandwriting();
    const { width, height } = this.host.bounds();
    if (width < 1 || height < 1 || !this.host.setPointer(true)) return false;
    this.pointer = { x: Math.floor(width / 2), y: Math.floor(height / 2), buttons: 0, press: null };
    this.host.pointerChanged(this.cursor(this.pointer));
    return true;
  }

  pointerOff(): void {
    this.stopPointer(false);
  }

  onPointer(records: readonly number[]): void {
    const pointer = this.pointer;
    if (!pointer) return;
    const { width, height } = this.host.bounds();
    if (width < 1 || height < 1) return;
    const before = this.cursor(pointer);
    const gain = Math.min(width, height) / DEGREES_PER_SCREEN_SHORT_SIDE;
    for (let i = 0; i + RECORD_SIZE <= records.length && this.pointer === pointer; i += RECORD_SIZE) {
      const [kind, time, a, b] = [records[i]!, records[i + 1]!, records[i + 2]!, records[i + 3]!];
      if (kind === CLEAR) continue; // No pending movement on the TS side to discard.
      if (!Number.isFinite(time) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (kind === MOVE) {
        pointer.x = Math.max(0, Math.min(width - 1, pointer.x + a * gain));
        pointer.y = Math.max(0, Math.min(height - 1, pointer.y + b * gain));
        const press = pointer.press;
        if (press && Math.hypot(pointer.x - press.x, pointer.y - press.y) > TAP_SLOP_PIXELS) press.dragged = true;
      } else if (kind === BUTTONS && Number.isInteger(a) && a >= 0 && a <= (PRIMARY_BUTTON | SECONDARY_BUTTON)) {
        this.updateButtons(pointer, time, a);
      }
    }
    if (this.pointer !== pointer) return;
    const after = this.cursor(pointer);
    if (after.x !== before.x || after.y !== before.y || after.primaryDown !== before.primaryDown) {
      this.host.noteActivity?.();
      this.host.pointerChanged(after);
    }
  }

  private updateButtons(pointer: PointerState, time: number, buttons: number): void {
    const changed = pointer.buttons ^ buttons;
    pointer.buttons = buttons;
    if (!changed) return;
    this.host.noteActivity?.();
    if (changed & PRIMARY_BUTTON) {
      if (buttons & PRIMARY_BUTTON) {
        pointer.press = { x: pointer.x, y: pointer.y, time, dragged: false };
      } else {
        const press = pointer.press;
        pointer.press = null;
        if (press && !press.dragged && time >= press.time && time - press.time < TAP_LIMIT_SECONDS) {
          this.host.pointerClick(Math.round(press.x), Math.round(press.y));
        }
      }
    }
    if ((changed & buttons & SECONDARY_BUTTON) && this.pointer === pointer) this.host.pointerBack();
  }

  private cursor(pointer: PointerState): NeuralBandCursor {
    return { x: Math.round(pointer.x), y: Math.round(pointer.y), primaryDown: !!(pointer.buttons & PRIMARY_BUTTON) };
  }

  private stopPointer(notifyBand: boolean): void {
    if (!this.pointer) return;
    this.pointer = null;
    if (notifyBand) this.host.setPointer(false);
    this.host.pointerChanged(null);
  }

  toggleHandwriting(): boolean {
    if (this.stopHandwriting()) return true;
    const target = this.host.writingTarget();
    if (!target) return false;
    this.stopPointer(true);
    if (!this.host.setHandwriting(true)) return false;
    const text = target.getText();
    this.writing = { target, text, ready: false, unsubscribeBlur: target.onBlur?.(() => this.stopHandwriting()) };
    this.host.resetHandwritingText(text);
    target.setHandwritingActive?.(true);
    this.host.noteActivity?.();
    return true;
  }

  onHandwriting(event: unknown): void {
    this.syncFocus();
    const writing = this.writing;
    if (!writing || !event || typeof event !== "object") return;
    const { type, phase, text } = event as { type?: unknown; phase?: unknown; text?: unknown };
    if (type === "state") {
      if (phase === "ready") {
        writing.ready = true;
        this.host.noteActivity?.();
      } else if (phase === "restoring" || phase === "finished") {
        this.endHandwriting(false);
      }
    } else if (type === "text" && writing.ready && typeof text === "string") {
      // Lumen emits the whole field, with erasures and corrections already
      // applied. A concurrent edit from the phone supersedes this session.
      if (writing.target.getText() !== writing.text) {
        this.stopHandwriting();
        return;
      }
      writing.text = text;
      writing.target.setText(text);
      this.host.noteActivity?.();
    }
  }

  syncFocus(): void {
    if (this.writing && this.host.writingTarget() !== this.writing.target) this.stopHandwriting();
  }

  stopHandwriting(): boolean {
    return this.endHandwriting(true);
  }

  stop(): void {
    this.stopPointer(true);
    this.stopHandwriting();
  }

  private endHandwriting(notifyBand: boolean): boolean {
    const writing = this.writing;
    if (!writing) return false;
    this.writing = null;
    writing.unsubscribeBlur?.();
    if (notifyBand) this.host.setHandwriting(false);
    writing.target.setHandwritingActive?.(false);
    return true;
  }
}
