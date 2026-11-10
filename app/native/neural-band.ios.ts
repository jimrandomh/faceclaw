/**
 * iOS twin of neural-band.ts. Faceclaw doesn't host the Meta Neural Band on iOS yet (glassly's
 * Swift driver, tetramo-labs/glassly's bluetooth-sdk ios/Source/controllers/neuralband, is the
 * place to start), so the band reports itself unsupported and every call is a no-op.
 */
import {
  UNSUPPORTED_STATUS,
  type NeuralBandEvent,
  type NeuralBandGesture,
  type NeuralBandStatus,
} from "./neural-band-types";

export { type NeuralBandEvent, type NeuralBandGesture, type NeuralBandStatus };

class NeuralBandBridge {
  isSupported(): boolean {
    return false;
  }

  onEvent(_listener: (event: NeuralBandEvent) => void): () => void {
    return () => {};
  }

  getStatus(): NeuralBandStatus {
    return UNSUPPORTED_STATUS;
  }

  startMetaSignIn(): boolean {
    return false;
  }

  signOutMeta(): void {}
  startScan(): void {}
  stopScan(): void {}
  pair(_address: string, _name: string): void {}
  connect(): void {}
  disconnect(): void {}
  forget(): void {}
  setTwistScroll(_enabled: boolean): void {}
  setGestureHaptics(_enabled: boolean): void {}
  setHand(_hand: "left" | "right"): void {}
}

export const neuralBand = new NeuralBandBridge();
