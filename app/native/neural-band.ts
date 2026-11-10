/**
 * TS wrapper for FaceclawNeuralBand.kt: the Meta Neural Band as a phone-side controller.
 * This file only crosses the Java boundary; what a gesture means is decided in
 * app/g2/neural-band.ts, and the setup page is app/phone-ui/neural-band-page.
 *
 * The Meta sign-in and the band's keys stay native (keystore-sealed); nothing secret
 * crosses into JavaScript.
 */
import { Application, Utils } from "@nativescript/core";
import {
  UNSUPPORTED_STATUS,
  parseNeuralBandEvent,
  type NeuralBandEvent,
  type NeuralBandGesture,
  type NeuralBandStatus,
} from "./neural-band-types";

export { type NeuralBandEvent, type NeuralBandGesture, type NeuralBandStatus };

declare const com: any;

type Listener = (event: NeuralBandEvent) => void;

class NeuralBandBridge {
  private java: any = undefined;
  // The Java-side listener proxy must stay referenced or it gets GC'd.
  private retainedListenerProxy: any = null;
  private readonly listeners = new Set<Listener>();
  private lastStatus: NeuralBandStatus = UNSUPPORTED_STATUS;

  private getJava(): any {
    if (this.java !== undefined) return this.java;
    try {
      const context = Utils.android.getApplicationContext();
      this.java = context ? com.faceclaw.app.FaceclawNeuralBand.getInstance(context) : null;
    } catch (error) {
      console.warn("neural band bridge unavailable", error);
      this.java = null;
    }
    return this.java;
  }

  /** Whether this phone can host the band (Android 10+ for LE L2CAP channels). */
  isSupported(): boolean {
    try {
      return Boolean(this.getJava()?.isSupported());
    } catch {
      return false;
    }
  }

  private ensureListener(): void {
    if (this.retainedListenerProxy) return;
    const java = this.getJava();
    if (!java) return;
    this.retainedListenerProxy = new com.faceclaw.app.FaceclawNeuralBandListener({
      onEvent: (json: string) => {
        const event = parseNeuralBandEvent(String(json));
        if (!event) return;
        if (event.type === "status") {
          const { type: _type, ...status } = event;
          this.lastStatus = status;
        }
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(event);
          } catch (error) {
            console.warn("neural band listener failed", error);
          }
        }
      },
    });
    java.setListener(this.retainedListenerProxy);
  }

  /** Subscribe to band events. Registers the Java listener on first use (which sends a status). */
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureListener();
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): NeuralBandStatus {
    const java = this.getJava();
    if (!java) return this.lastStatus;
    try {
      const event = parseNeuralBandEvent(String(java.getStatusJson()));
      if (event?.type === "status") {
        const { type: _type, ...status } = event;
        this.lastStatus = status;
      }
    } catch {
      // keep the last one
    }
    return this.lastStatus;
  }

  /** Open Meta's sign-in page in Faceclaw. Needs Faceclaw in the foreground. */
  startMetaSignIn(): boolean {
    const java = this.getJava();
    const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
    if (!java || !activity) return false;
    java.startMetaSignIn(activity);
    return true;
  }

  signOutMeta(): void {
    this.getJava()?.signOutMeta();
  }

  startScan(): void {
    this.ensureListener();
    this.getJava()?.startScan();
  }

  stopScan(): void {
    this.getJava()?.stopScan();
  }

  pair(address: string, name: string): void {
    this.getJava()?.pair(address, name);
  }

  connect(): void {
    this.getJava()?.connect();
  }

  disconnect(): void {
    this.getJava()?.disconnect();
  }

  forget(): void {
    this.getJava()?.forget();
  }

  setTwistScroll(enabled: boolean): void {
    this.getJava()?.setTwistScroll(enabled);
  }

  setGestureHaptics(enabled: boolean): void {
    this.getJava()?.setGestureHaptics(enabled);
  }

  /** Throws (from the native side) until the band is connected and has reported its wrist. */
  setHand(hand: "left" | "right"): void {
    this.getJava()?.setHand(hand === "left");
  }
}

export const neuralBand = new NeuralBandBridge();
