import { Application } from "@nativescript/core";

declare const com: any;

const actionNames = [
  "scroll-up", "scroll-down", "select", "double-click", "back", "swipe-left", "swipe-right",
  "index-double", "middle-double", "index-triple", "middle-triple",
  "index-hold-start", "index-hold-end", "index-hold-cancel",
  "middle-hold-start", "middle-hold-end", "middle-hold-cancel",
  "dial-up", "dial-down", "short-then-long-press", "screen-toggle", "pointer-off", "session-ended",
] as const;

export type NeuralBandAction = (typeof actionNames)[number];
const knownActions: ReadonlySet<string> = new Set(actionNames);

// Keep the NativeScript proxy alive with the Android dashboard singleton.
let retainedActionListener: unknown;
let retainedPointerListener: unknown;
let retainedHandwritingListener: unknown;

export function listenForNeuralBandActions(listener: (action: NeuralBandAction) => void): void {
  if (!global.isAndroid || retainedActionListener) return;
  try {
    const bridge = com.faceclaw.app.FaceclawNeuralBand;
    const proxy = new bridge.ActionListener({
      onAction: (action: string) => {
        const value = String(action);
        if (knownActions.has(value)) listener(value as NeuralBandAction);
      },
    });
    bridge.setActionListener(proxy);
    retainedActionListener = proxy;
  } catch (error) {
    console.warn("Neural Band input unavailable", error);
  }
}

export function listenForNeuralBandPointer(listener: (records: readonly number[]) => void): void {
  if (!global.isAndroid || retainedPointerListener) return;
  try {
    const bridge = com.faceclaw.app.FaceclawNeuralBand;
    const proxy = new bridge.PointerListener({
      onPointer: (records: ArrayLike<number>) => {
        if (!records?.length || records.length > 2048) return;
        listener(Array.from(records, Number));
      },
    });
    bridge.setPointerListener(proxy);
    retainedPointerListener = proxy;
  } catch (error) {
    console.warn("Neural Band pointer unavailable", error);
  }
}

export function listenForNeuralBandHandwriting(listener: (event: unknown) => void): void {
  if (!global.isAndroid || retainedHandwritingListener) return;
  try {
    const bridge = com.faceclaw.app.FaceclawNeuralBand;
    const proxy = new bridge.HandwritingListener({
      onHandwriting: (json: string) => {
        let event: unknown;
        try {
          event = JSON.parse(String(json));
        } catch {
          return;
        }
        listener(event);
      },
    });
    bridge.setHandwritingListener(proxy);
    retainedHandwritingListener = proxy;
  } catch (error) {
    console.warn("Neural Band handwriting unavailable", error);
  }
}

export const neuralBandNativeModes = {
  setPointer(enabled: boolean): boolean {
    return global.isAndroid && com.faceclaw.app.FaceclawNeuralBand.setPointerEnabled(enabled) === true;
  },
  setHandwriting(enabled: boolean): boolean {
    return global.isAndroid && com.faceclaw.app.FaceclawNeuralBand.setHandwritingEnabled(enabled) === true;
  },
  resetHandwritingText(text: string): void {
    if (global.isAndroid) com.faceclaw.app.FaceclawNeuralBand.resetHandwritingText(text);
  },
};

export function isNeuralBandAvailable(): boolean {
  if (!global.isAndroid) return false;
  try {
    return com.faceclaw.app.FaceclawNeuralBand.isAvailable() === true;
  } catch {
    return false;
  }
}

export function openNeuralBandSettings(): void {
  if (!isNeuralBandAvailable()) return;
  const activity = Application.android.foregroundActivity;
  if (activity) com.faceclaw.app.FaceclawNeuralBand.openSettings(activity);
}
