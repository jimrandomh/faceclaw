import { wrapTranscribeText } from "../transcribe/transcript-model";

type TranscriptEvent = { text: string; isFinal: boolean };

export type TranslationState = "pending" | "translating" | "done" | "failed";

/** One stretch of finalized speech and its English translation. */
export type TranslationSegment = {
  source: string;
  /** The translation so far (streamed while translating). */
  translation: string;
  state: TranslationState;
};

export type TranslationTurn = { source: string; translation: string };

/** A segment handed to the model, with the finished turns before it. */
export type TranslationJob = {
  segment: TranslationSegment;
  /** Earlier translated turns, oldest first. */
  context: TranslationTurn[];
};

export type TranslationLine = { text: string; gray: number };

// Earlier turns sent with each request, so pronouns, names, and topic carry
// over between requests; bounded so a long session's requests stay small.
const CONTEXT_TURNS = 4;
const CONTEXT_CHARS = 800;

const TRANSLATION_GRAY = 230;
const ORIGINAL_GRAY = 120;
const LIVE_GRAY = 90;

/**
 * The Translate app's conversation: finalized speech segments with their
 * translations, plus the live partial of the utterance in progress.
 * Translation is serial (one request at a time, in order, so each can carry
 * the turns before it as context); finals that arrive while a request is in
 * flight merge into one pending segment, so a slow model batches the backlog
 * instead of falling further behind one request per pause.
 */
export class TranslationModel {
  readonly segments: TranslationSegment[] = [];
  /** The utterance in progress (replace semantics), not yet final. */
  live = "";

  accept(event: TranscriptEvent): void {
    const text = event.text.trim();
    if (!event.isFinal) {
      this.live = text;
      return;
    }
    const finalText = text || this.live;
    this.live = "";
    if (!finalText) return;
    const last = this.segments[this.segments.length - 1];
    if (last?.state === "pending") last.source = `${last.source} ${finalText}`;
    else this.segments.push({ source: finalText, translation: "", state: "pending" });
  }

  /** Take the next segment to translate, or null while one is in flight or none waits. */
  nextJob(): TranslationJob | null {
    if (this.segments.some((segment) => segment.state === "translating")) return null;
    const segment = this.segments.find((candidate) => candidate.state === "pending");
    if (!segment) return null;
    segment.state = "translating";
    return { segment, context: this.contextBefore(segment) };
  }

  progress(segment: TranslationSegment, textSoFar: string): void {
    if (segment.state === "translating") segment.translation = textSoFar;
  }

  complete(segment: TranslationSegment, translation: string): void {
    segment.translation = translation;
    segment.state = "done";
  }

  fail(segment: TranslationSegment): void {
    segment.translation = "";
    segment.state = "failed";
  }

  private contextBefore(segment: TranslationSegment): TranslationTurn[] {
    const turns: TranslationTurn[] = [];
    let chars = 0;
    for (let index = this.segments.indexOf(segment) - 1; index >= 0 && turns.length < CONTEXT_TURNS; index--) {
      const earlier = this.segments[index]!;
      if (earlier.state !== "done" || !earlier.translation) continue;
      chars += earlier.source.length + earlier.translation.length;
      if (turns.length && chars > CONTEXT_CHARS) break;
      turns.unshift({ source: earlier.source, translation: earlier.translation });
    }
    return turns;
  }

  /**
   * Display lines: each segment's translation, bright; its original, dim,
   * above it when `showOriginal` is on and in its place until a translation
   * arrives (or when it failed); then the live partial, dimmer.
   */
  lines(measure: (text: string) => number, maxWidth: number, showOriginal: boolean): TranslationLine[] {
    const lines: TranslationLine[] = [];
    const push = (text: string, gray: number) => {
      for (const line of wrapTranscribeText(measure, text, maxWidth)) lines.push({ text: line, gray });
    };
    for (const segment of this.segments) {
      const translation = segment.translation.trim();
      // A finished, empty translation is noise the model chose to drop.
      if (showOriginal || (!translation && segment.state !== "done")) push(segment.source, ORIGINAL_GRAY);
      if (translation) push(translation, TRANSLATION_GRAY);
    }
    if (this.live) push(this.live, LIVE_GRAY);
    return lines;
  }

  /** Plain-text transcript for saving: each original, then its translation. */
  savedText(): string {
    return this.segments
      .map((segment) => {
        const translation = segment.translation.trim();
        if (segment.state === "failed") return `${segment.source}\n→ (not translated)`;
        if (!translation || translation === segment.source.trim()) return segment.source;
        return `${segment.source}\n→ ${translation}`;
      })
      .join("\n\n");
  }
}
