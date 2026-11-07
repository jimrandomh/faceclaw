/** The demo page around the display: input from mouse, touch and keyboard, the side panel, frame drawing. */
import { glanceboardEnabledSetting } from "../apps/glanceboard/glanceboard-settings";
import { markCompassCalibrated } from "../apps/compass/calibration";
import { saveConnections } from "../apps/terminal/connections";
import { previewColorSetting } from "../ui/dashboard-settings";
import { PhoneGestureRecognizer, type PhoneGesture } from "../phone-ui/phone-gestures";
import type { KeyboardInputSession } from "../ui/shell/keyboard-input";
import { isBuzzerMuted, setBuzzerMuted } from "./buzzer";
import { seedDemoFiles } from "./demo-data/files";
import { DEMO_TERMINAL_SERVER_NAME, DEMO_TERMINAL_URL } from "./demo-data/terminal";
import { postDemoNotification, seedDemoNotifications } from "./demo-data/notifications";
import { clearPersistentDocuments } from "./vfs";
import { clearSettings, getBooleanSetting, setBooleanSetting } from "../native/settings-store";
import { WebController, type WebFrame } from "./web-controller";

const element = (id: string): HTMLElement => document.getElementById(id)!;

/** 16 levels through the phones' preview palette (PreviewPalette.kt; gamma 0.7 brightens them). */
function paletteFor(green: boolean): Uint32Array {
  const palette = new Uint32Array(256);
  for (let gray = 0; gray < 256; gray++) {
    const value = Math.round(255 * Math.pow(gray / 255, 0.7));
    // ImageData is little-endian RGBA in memory, so these words read ABGR.
    palette[gray] = green
      ? (0xff000000 | (value << 8)) >>> 0
      : (0xff000000 | (value << 16) | (value << 8) | value) >>> 0;
  }
  return palette;
}

const GREEN_PALETTE = paletteFor(true);
const WHITE_PALETTE = paletteFor(false);

function drawFrame(canvas: HTMLCanvasElement, frame: WebFrame): void {
  const crop = frame.crop ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  if (canvas.width !== crop.width || canvas.height !== crop.height) {
    canvas.width = crop.width;
    canvas.height = crop.height;
  }
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(crop.width, crop.height);
  const out = new Uint32Array(image.data.buffer);
  const palette = frame.green ? GREEN_PALETTE : WHITE_PALETTE;
  const black = palette[0]!;
  for (let row = 0; row < crop.height; row++) {
    const y = crop.y + row;
    for (let column = 0; column < crop.width; column++) {
      const x = crop.x + column;
      out[row * crop.width + column] = x >= 0 && y >= 0 && x < frame.width && y < frame.height
        ? palette[frame.gray[y * frame.width + x]!]! : black;
    }
  }
  context.putImageData(image, 0, 0);
}

function bindTouchSurface(surface: HTMLElement, onGesture: (gesture: PhoneGesture, nx: number, ny: number) => void): void {
  const recognizer = new PhoneGestureRecognizer((gesture, x, y) => {
    const rect = surface.getBoundingClientRect();
    onGesture(gesture, rect.width ? x / rect.width : 0, rect.height ? y / rect.height : 0);
  });
  const relative = (event: PointerEvent) => {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  let active = 0;
  surface.addEventListener("pointerdown", (event) => {
    surface.setPointerCapture(event.pointerId);
    active++;
    recognizer.touch({ action: "down", ...relative(event), pointers: active });
    event.preventDefault();
  });
  surface.addEventListener("pointermove", (event) => {
    if (active > 0) recognizer.touch({ action: "move", ...relative(event), pointers: active });
  });
  surface.addEventListener("pointerup", (event) => {
    if (active === 0) return;
    recognizer.touch({ action: "up", ...relative(event), pointers: active });
    active = Math.max(0, active - 1);
  });
  surface.addEventListener("pointercancel", () => {
    active = 0;
    recognizer.touch({ action: "cancel", x: 0, y: 0, pointers: 0 });
  });
  surface.addEventListener("contextmenu", (event) => event.preventDefault());
}

/** Wheel notches to ring scroll steps: a trackpad's stream of small deltas shouldn't race through a list. */
function bindWheel(surface: HTMLElement, controller: WebController): void {
  let accumulated = 0;
  let lastStepAt = 0;
  surface.addEventListener("wheel", (event) => {
    event.preventDefault();
    accumulated += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 30 : 1);
    const now = performance.now();
    if (Math.abs(accumulated) < 40 || now - lastStepAt < 70) return;
    controller.input(accumulated > 0 ? "scroll-down" : "scroll-up");
    accumulated = 0;
    lastStepAt = now;
  }, { passive: false });
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function bindKeyboard(controller: WebController): void {
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holding = false;
  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    switch (event.key) {
      case "ArrowUp": controller.input("scroll-up"); break;
      case "ArrowDown": controller.input("scroll-down"); break;
      case "Enter":
      case " ":
        if (!event.repeat) {
          // The ring's touch-down, which the action games act on at once.
          controller.gesture("press", "ring");
          // Hold the key to hold the ring: half a second makes it a long press.
          holdTimer = setTimeout(() => { holdTimer = null; holding = true; controller.input("long-press"); }, 500);
        }
        break;
      case "Escape":
      case "Backspace":
        if (!event.repeat) controller.input("double-click");
        break;
      case "m":
      case "M":
        if (!event.repeat) { controller.input("short-then-long-press"); controller.input("long-press-release"); }
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  window.addEventListener("keyup", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
      controller.input("click");
    } else if (holding) {
      holding = false;
      controller.input("long-press-release");
    }
  });
}

function bindKeyboardPanel(panel: HTMLElement): (session: KeyboardInputSession | null) => void {
  const input = panel.querySelector("input")!;
  let current: KeyboardInputSession | null = null;
  input.addEventListener("input", () => current?.setText(input.value));
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); current?.send(); }
    if (event.key === "Escape") { event.preventDefault(); current?.discard(); }
  });
  panel.querySelector<HTMLElement>("[data-send]")!.addEventListener("click", () => current?.send());
  panel.querySelector<HTMLElement>("[data-discard]")!.addEventListener("click", () => current?.discard());
  return (session) => {
    current = session;
    panel.hidden = !session;
    input.value = "";
    if (session) input.focus();
  };
}

const FIRST_VISIT_KEY = "demo.seeded";

export function startPage(): void {
  if (!getBooleanSetting(FIRST_VISIT_KEY, false)) {
    // What a person looking at glasses would see.
    previewColorSetting.set("green");
    glanceboardEnabledSetting.set(true);
    markCompassCalibrated();
    saveConnections([{ id: "demo", url: DEMO_TERMINAL_URL, serverName: DEMO_TERMINAL_SERVER_NAME, enabled: true }]);
    seedDemoFiles();
    setBooleanSetting(FIRST_VISIT_KEY, true);
  }
  seedDemoNotifications();

  const canvas = element("display") as HTMLCanvasElement;
  const status = element("status");
  let lastFocus = "";
  const onKeyboardInputChanged = bindKeyboardPanel(element("keyboard-panel"));
  const controller = new WebController({
    onFrame: (frame) => {
      drawFrame(canvas, frame);
      canvas.style.opacity = String(0.25 + 0.75 * frame.brightness);
      if (frame.focus !== lastFocus) {
        lastFocus = frame.focus;
        status.textContent = frame.focus;
      }
    },
    onError: (message) => { status.textContent = message; },
    onKeyboardInputChanged,
  });

  // For poking at the demo from the console.
  (window as unknown as { faceclawDemo: unknown }).faceclawDemo = { controller, postDemoNotification };

  bindTouchSurface(canvas, (gesture, nx, ny) => controller.gesture(gesture, "mirror", nx, ny));
  bindWheel(canvas, controller);
  bindTouchSurface(element("ring-pad"), (gesture) => controller.gesture(gesture, "ring"));
  bindWheel(element("ring-pad"), controller);
  bindKeyboard(controller);

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-input]")) {
    const type = button.dataset.input as Parameters<WebController["input"]>[0];
    button.addEventListener("click", () => {
      controller.input(type);
      if (type === "long-press" || type === "short-then-long-press") controller.input("long-press-release");
    });
  }
  element("send-notification").addEventListener("click", () => postDemoNotification());
  element("type-text").addEventListener("click", () => controller.startKeyboardInput());
  const sound = element("sound") as HTMLInputElement;
  sound.checked = !isBuzzerMuted();
  sound.addEventListener("change", () => setBuzzerMuted(!sound.checked));
  const lens = element("lens-background") as HTMLSelectElement;
  lens.addEventListener("change", () => { document.body.dataset.lens = lens.value; });
  element("reset-demo").addEventListener("click", () => {
    clearSettings();
    void clearPersistentDocuments().then(() => location.reload());
  });
}
