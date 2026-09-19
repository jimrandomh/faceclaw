import { TRANSCRIPT_PAUSE_MS } from "./speech-pause";

export type TranscriptToken = { text: string; start_ms?: number; end_ms?: number; speaker?: string };

/** A separate presentation buffer keeps paragraph breaks out of dictation. */
export class TimedTranscript {
  text = "";
  private endMs: number | undefined;
  private speaker: string | undefined;

  copy(): TimedTranscript {
    const copy = new TimedTranscript();
    copy.text = this.text;
    copy.endMs = this.endMs;
    copy.speaker = this.speaker;
    return copy;
  }

  append(token: TranscriptToken): void {
    const changedSpeaker = token.speaker != null && this.speaker != null && token.speaker !== this.speaker;
    const paused = token.start_ms != null && this.endMs != null && token.start_ms - this.endMs >= TRANSCRIPT_PAUSE_MS;
    if (token.text.trim() && this.text && (changedSpeaker || paused)) {
      this.text = `${this.text.trimEnd()}\n${token.text.trimStart()}`;
    } else {
      this.text += token.text;
    }
    if (token.text.trim()) {
      if (token.end_ms != null) this.endMs = token.end_ms;
      if (token.speaker != null) this.speaker = token.speaker;
    }
  }
}
