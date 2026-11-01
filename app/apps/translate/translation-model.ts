import { wrapTranscribeText } from "../transcribe/transcript-model";

type TranscriptEvent = { text: string; isFinal: boolean };

/**
 * One block of speech (up to a pause) and its English translation. The last
 * block may still be live, its transcript revising; it is translated
 * provisionally as it grows, then again once final if its text changed.
 */
export type TranslationSegment = {
  source: string;
  /** Committed by the transcriber; a live block's source still revises. */
  final: boolean;
  /** The latest finished translation, of `translatedSource`. */
  translation: string;
  /** What `translation` translates: null until one finishes, behind `source` while provisional. */
  translatedSource: string | null;
  /** The text streamed so far by the request in flight for this block, else null. */
  streaming: string | null;
  /** A source whose translation failed; not retried until the source changes. */
  failedSource: string | null;
};

export type TranslationTurn = { source: string; translation: string };

/** A request: a block's source as sent, with the finished turns before it. */
export type TranslationJob = {
  segment: TranslationSegment;
  /** The source sent (a live block's moves on while the request is in flight). */
  source: string;
  /** Earlier translated turns, oldest first. */
  context: TranslationTurn[];
};

export type TranslationLine = { text: string; gray: number };

// Earlier turns sent with each request, so pronouns, names, and topic carry
// over between requests; bounded so a long session's requests stay small.
const CONTEXT_TURNS = 4;
const CONTEXT_CHARS = 800;
// A live block is translated again once its text has changed length by this
// much since the last request, so a trickle of revisions (punctuation, one
// corrected word) doesn't spend a request each. A final is always redone.
const PROVISIONAL_MIN_CHANGE = 3;

const TRANSLATION_GRAY = 230;
const PROVISIONAL_GRAY = 170;
const ORIGINAL_GRAY = 120;
const LIVE_GRAY = 90;

function newSegment(source: string, final: boolean): TranslationSegment {
  return { source, final, translation: "", translatedSource: null, streaming: null, failedSource: null };
}

/** Whether a block's current source still needs a translation request. */
function wantsTranslation(segment: TranslationSegment): boolean {
  const { source, translatedSource } = segment;
  if (!source || source === translatedSource || source === segment.failedSource) return false;
  return segment.final || translatedSource === null || Math.abs(source.length - translatedSource.length) >= PROVISIONAL_MIN_CHANGE;
}

/**
 * The Translate app's conversation: blocks of speech with their translations.
 * Translation is serial (one request at a time, in order, so each can carry
 * the turns before it as context): final blocks first, then the live one.
 * Finals that arrive while a request is in flight merge into one waiting
 * block, so a slow model batches the backlog instead of falling further
 * behind one request per pause.
 */
export class TranslationModel {
  readonly segments: TranslationSegment[] = [];
  private active: TranslationJob | null = null;

  /**
   * Take a transcript event (replace semantics within the live block).
   * Returns true when it made the request in flight moot (its block was
   * finalized as other text, or dropped); that request is abandoned here, and
   * the caller should cancel it.
   */
  accept(event: TranscriptEvent): boolean {
    const text = event.text.trim();
    const last = this.segments[this.segments.length - 1];
    const live = last && !last.final ? last : null;
    if (!event.isFinal) {
      if (live) live.source = text;
      else if (text) this.segments.push(newSegment(text, false));
      return false;
    }
    const finalText = text || live?.source || "";
    if (!live) {
      if (finalText && !this.mergeIntoWaiting(finalText)) this.segments.push(newSegment(finalText, true));
      return false;
    }
    const moot = this.active?.segment === live && this.active.source !== finalText;
    if (moot) this.abandonActive();
    if (!finalText || (this.active?.segment !== live && live.translatedSource === null && this.mergeIntoWaiting(finalText, live))) {
      this.segments.pop();
      return moot;
    }
    live.source = finalText;
    live.final = true;
    return moot;
  }

  /** Take the next request to make, or null while one is in flight or nothing waits. */
  nextJob(): TranslationJob | null {
    if (this.active) return null;
    const segment = this.segments.find((candidate) => wantsTranslation(candidate));
    if (!segment) return null;
    segment.streaming = "";
    this.active = { segment, source: segment.source, context: this.contextBefore(segment) };
    return this.active;
  }

  isActive(job: TranslationJob): boolean {
    return this.active === job;
  }

  /** Streamed text for the request in flight; false when `job` isn't it any more. */
  progress(job: TranslationJob, textSoFar: string): boolean {
    if (this.active !== job) return false;
    job.segment.streaming = textSoFar;
    return true;
  }

  complete(job: TranslationJob, translation: string): void {
    if (this.active !== job) return;
    this.active = null;
    job.segment.streaming = null;
    job.segment.translation = translation;
    job.segment.translatedSource = job.source;
  }

  fail(job: TranslationJob): void {
    if (this.active !== job) return;
    this.active = null;
    job.segment.streaming = null;
    job.segment.failedSource = job.source;
  }

  private abandonActive(): void {
    if (this.active) this.active.segment.streaming = null;
    this.active = null;
  }

  /**
   * Append a final to the block before `before` (default: the end) when that
   * block is final but still waiting for its first request. Returns whether
   * it did.
   */
  private mergeIntoWaiting(finalText: string, before?: TranslationSegment): boolean {
    const index = (before ? this.segments.indexOf(before) : this.segments.length) - 1;
    const waiting = this.segments[index];
    if (!waiting?.final || waiting.translatedSource !== null || waiting.failedSource !== null) return false;
    if (this.active?.segment === waiting) return false;
    waiting.source = `${waiting.source} ${finalText}`;
    return true;
  }

  private contextBefore(segment: TranslationSegment): TranslationTurn[] {
    const turns: TranslationTurn[] = [];
    let chars = 0;
    for (let index = this.segments.indexOf(segment) - 1; index >= 0 && turns.length < CONTEXT_TURNS; index--) {
      const earlier = this.segments[index]!;
      if (!earlier.final || earlier.translatedSource !== earlier.source || !earlier.translation) continue;
      chars += earlier.source.length + earlier.translation.length;
      if (turns.length && chars > CONTEXT_CHARS) break;
      turns.unshift({ source: earlier.source, translation: earlier.translation });
    }
    return turns;
  }

  /**
   * Display lines: each block's translation, bright once settled (final, and
   * of its final text) and dimmer while provisional; its original, dim, above
   * it when `showOriginal` is on and in its place until a translation
   * arrives. A redo streams in over the translation it replaces only once it
   * is as long, so the text doesn't shrink and regrow.
   */
  lines(measure: (text: string) => number, maxWidth: number, showOriginal: boolean): TranslationLine[] {
    const lines: TranslationLine[] = [];
    const push = (text: string, gray: number) => {
      for (const line of wrapTranscribeText(measure, text, maxWidth)) lines.push({ text: line, gray });
    };
    for (const segment of this.segments) {
      if (!segment.source) continue;
      const settled = segment.final && segment.translatedSource === segment.source;
      const finished = segment.translation.trim();
      const streaming = segment.streaming?.trim() ?? "";
      const translation = streaming.length >= finished.length ? streaming : finished;
      // A settled, empty translation is noise the model chose to drop.
      if (showOriginal || (!translation && !settled)) push(segment.source, segment.final ? ORIGINAL_GRAY : LIVE_GRAY);
      if (translation) push(translation, settled ? TRANSLATION_GRAY : PROVISIONAL_GRAY);
    }
    return lines;
  }

  /** Plain-text transcript for saving: each final original, then its translation. */
  savedText(): string {
    return this.segments
      .filter((segment) => segment.final)
      .map((segment) => {
        const translation = segment.translation.trim();
        if (!translation && segment.failedSource === segment.source) return `${segment.source}\n→ (not translated)`;
        if (!translation || translation === segment.source.trim()) return segment.source;
        return `${segment.source}\n→ ${translation}`;
      })
      .join("\n\n");
  }
}
