import { Utils } from "@nativescript/core";

declare const com: any;

export type VoiceControlState = {
  status: string;
};

export type VoiceInputMode = "off" | "wakeword" | "full";
export type VoiceTranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly wakeWordListeners = new Set<(keyword: string) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private started = false;
  private mode: VoiceInputMode = "off";

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener({ status: this.status });
    return () => this.statusListeners.delete(listener);
  }

  onWakeWord(listener: (keyword: string) => void): () => void {
    this.wakeWordListeners.add(listener);
    return () => this.wakeWordListeners.delete(listener);
  }

  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  start(communicator?: any, mode: VoiceInputMode = "wakeword"): void {
    if (mode === "off") {
      this.stop();
      return;
    }
    if (!global.isAndroid) return;
    this.ensureController();
    if (communicator) {
      this.controller?.setCommunicator(communicator);
    }
    if (this.started && this.mode !== mode) {
      this.controller?.stop();
      this.started = false;
    }
    this.started = true;
    this.mode = mode;
    this.controller?.start(mode);
  }

  stop(): void {
    if (!this.started || !global.isAndroid) return;
    this.started = false;
    this.mode = "off";
    this.controller?.stop();
    this.setStatus("Voice control stopped.");
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawVoiceController(context);
    this.listenerProxy = new com.faceclaw.app.FaceclawVoiceControllerListener({
      onStatus: (status: string) => {
        this.setStatus(String(status));
      },
      onWakeWord: (keyword: string) => {
        for (const listener of this.wakeWordListeners) {
          listener(String(keyword));
        }
      },
      onTranscript: (text: string, isFinal: boolean) => {
        const event = { text: String(text), isFinal: Boolean(isFinal) };
        for (const listener of this.transcriptListeners) {
          listener(event);
        }
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private setStatus(status: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener({ status });
    }
  }
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();
