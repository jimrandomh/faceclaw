import { NON_WORD_RUN } from "../../util/unicode-class";
import { TranscriptModel } from "../transcribe/transcript-model";

export type CueKind = "answer" | "recall" | "explain" | "check" | "suggest" | "note";

export const CUE_KIND_LABELS: Record<CueKind, string> = {
  answer: "Answer",
  recall: "Recall",
  explain: "Explain",
  check: "Check",
  suggest: "Suggest",
  note: "Note",
};

/** What the model wrote, parsed (see aside-reply.ts). */
export type CueDraft = {
  kind: CueKind;
  /** The one line shown at a glance. */
  headline: string;
  /** Shown on a tap; may be empty. */
  detail: string;
  /** The model's own rating of how much this matters, 0..10. */
  score: number;
};

/** A cue that reached the wearer. */
export type Cue = CueDraft & { id: number; shownAtMs: number };

export type AsideFrequency = "on-request" | "quiet" | "balanced" | "eager";

/** How readily Aside checks in with the model and interrupts. */
export type CuePacing = {
  /** Least time between checks. */
  checkGapMs: number;
  /** Least time between checks when the speech looks like a question. */
  questionGapMs: number;
  /** Least time after showing a cue before an ordinary check. */
  cueGapMs: number;
  /** New speech needed before an ordinary check. */
  minNewWords: number;
  /** The least score a cue may rate itself and still be shown. */
  minScore: number;
  /** By this long after its check began, a cue is about something the talk has left behind. */
  maxCueAgeMs: number;
};

const QUESTION_GAP_MS = 3_000;
const MAX_CUE_AGE_MS = 45_000;

const PACING: Record<Exclude<AsideFrequency, "on-request">, CuePacing> = {
  quiet: { checkGapMs: 25_000, questionGapMs: QUESTION_GAP_MS, cueGapMs: 180_000, minNewWords: 25, minScore: 8, maxCueAgeMs: MAX_CUE_AGE_MS },
  balanced: { checkGapMs: 15_000, questionGapMs: QUESTION_GAP_MS, cueGapMs: 60_000, minNewWords: 15, minScore: 7, maxCueAgeMs: MAX_CUE_AGE_MS },
  eager: { checkGapMs: 8_000, questionGapMs: QUESTION_GAP_MS, cueGapMs: 20_000, minNewWords: 8, minScore: 6, maxCueAgeMs: MAX_CUE_AGE_MS },
};

// An on-phone model fills the CPU for each check, and shares its runner with
// the voice assistant. It can also take most of a minute to reply, which the
// age limit has to allow or every cue would quietly be thrown away.
const LOCAL_CHECK_GAP_MS = 60_000;
const LOCAL_QUESTION_GAP_MS = 30_000;
const LOCAL_MAX_CUE_AGE_MS = 120_000;

/** The pacing for a How often setting, or null when Aside only answers taps. */
export function cuePacing(frequency: AsideFrequency, localModel: boolean): CuePacing | null {
  if (frequency === "on-request") return null;
  const pacing = PACING[frequency];
  if (!localModel) return pacing;
  return {
    ...pacing,
    checkGapMs: Math.max(pacing.checkGapMs, LOCAL_CHECK_GAP_MS),
    questionGapMs: Math.max(pacing.questionGapMs, LOCAL_QUESTION_GAP_MS),
    maxCueAgeMs: LOCAL_MAX_CUE_AGE_MS,
  };
}

/** How much of the transcript before JUST SAID to send: the opening (names, introductions) and the recent end. */
export type ContextLimits = { headChars: number; tailChars: number };

export type CueCheck = {
  /** "request" is the wearer asking, which skips every bar. */
  reason: "speech" | "question" | "request";
  earlier: string;
  justSaid: string;
  /** Cues shown so far, oldest first. */
  shownCues: string[];
  /** What the wearer typed or dictated to ask, if they did. */
  question: string;
  /** How far into the committed transcript this check has read. */
  readTo: number;
  startedAtMs: number;
};

export type CueOutcome = "none" | "below-bar" | "duplicate" | "too-old" | "accepted" | "abandoned";

/** A long turn with no final still gets looked at, after this much new speech. */
const LONG_TURN_WORDS = 40;
const MIN_QUESTION_WORDS = 2;
/** A gap this long without a transcript update counts as a pause in the speech. */
const PAUSE_GAP_MS = 1_200;
/** A cue waits this long at most for that pause. */
const MAX_HOLD_MS = 4_000;
const EXPANDED_TTL_MS = 60_000;
/** Cue history closes itself after this long without a scroll, so new cues can show. */
const HISTORY_IDLE_MS = 45_000;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_FAILURE_BACKOFF_MS = 300_000;
const CUES_SENT_BACK = 12;
const JUST_SAID_CHARS = 2_000;
const DUPLICATE_SIMILARITY = 0.6;

/** After the mic stops, a final transcript may still be on its way. */
export const STOP_SETTLE_MS = 1_500;

const QUESTION_OPENING = /^(who|whom|whose|what|what's|when|where|where's|why|how|how's|which|is|are|am|was|were|do|does|did|can|could|would|should|will|shall|have|has|had|isn't|aren't|don't|doesn't|didn't|won't|can't)\b/i;

/** Roughly how many words of speech, counting unspaced languages by their length. */
export function speechWeight(text: string): number {
  const words = text.match(/\S+/g)?.length ?? 0;
  return Math.max(words, Math.floor(text.trim().length / 6));
}

/**
 * Whether speech may be a question, for skipping the wait; the model decides
 * whether it needs answering. Recognizers without punctuation only get a look
 * at how the last line opens.
 */
export function looksLikeQuestion(text: string): boolean {
  if (/[?？؟]/.test(text)) return true;
  if (/[.!。！]/.test(text)) return false;
  const lines = text.trim().split("\n");
  return QUESTION_OPENING.test(lines[lines.length - 1]!.trim());
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(NON_WORD_RUN).filter(Boolean));
}

/** Word overlap between two cues (Jaccard), 0..1. */
export function cueSimilarity(a: string, b: string): number {
  const wordsA = wordSet(a);
  const wordsB = wordSet(b);
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / (wordsA.size + wordsB.size - shared);
}

/** The opening and recent end of a long text, cut at word boundaries, with the gap marked. */
export function trimContext(text: string, limits: ContextLimits): string {
  if (text.length <= limits.headChars + limits.tailChars) return text;
  const head = text.slice(0, limits.headChars).replace(/\s+\S*$/, "");
  const tail = text.slice(-limits.tailChars).replace(/^\S*\s+/, "");
  return `${head}\n[...]\n${tail}`;
}

/** The cue on screen: fresh, or read back from history (`position`). */
export type CurrentCue = {
  cue: Cue;
  expanded: boolean;
  position: { index: number; total: number } | null;
};

/**
 * One conversation: its transcript, when to ask the model about it, and the
 * cues that came of that. No timers or I/O; the layer drives it with the clock.
 *
 * A check reads to a watermark that advances whether or not it produced a cue,
 * so each check is about what is new. One cue shows at a time, with no queue:
 * nothing is even asked while one is up, or waiting for a pause in the speech.
 */
export class AsideSession {
  readonly transcript = new TranscriptModel();
  readonly cues: Cue[] = [];
  private nextCueId = 1;
  private readTo = 0;
  private active: CueCheck | null = null;
  private lastCheckAtMs = -Infinity;
  private lastCueAtMs = -Infinity;
  private lastSpeechAtMs = -Infinity;
  private failures = 0;
  private liveWeightRead = 0;
  private held: { draft: CueDraft; readyAtMs: number; requested: boolean } | null = null;
  private visible: { cue: Cue; untilMs: number; expanded: boolean } | null = null;
  private history: { index: number; untilMs: number } | null = null;
  private unseen = 0;
  private stoppedAtMs: number | null = null;

  /** `cueTtlMs` is read each time a cue shows, so a settings change applies to the next one. */
  constructor(private readonly cueTtlMs: () => number) {}

  /** Take a transcript event; false if the mic has been stopped for a while and it's not ours. */
  accept(event: { text: string; isFinal: boolean; transcribeText?: string; paragraphBreakAfter?: boolean }, nowMs: number): boolean {
    if (this.stoppedAtMs !== null && nowMs - this.stoppedAtMs > STOP_SETTLE_MS) return false;
    this.transcript.accept(event);
    if (event.text.trim()) this.lastSpeechAtMs = nowMs;
    if (event.isFinal) this.liveWeightRead = 0;
    return true;
  }

  speechPause(): void {
    if (this.stoppedAtMs === null) this.transcript.pause();
  }

  get hasSpeech(): boolean {
    return this.transcript.text.trim().length > 0;
  }

  get stopped(): boolean {
    return this.stoppedAtMs !== null;
  }

  get requestInFlight(): boolean {
    return this.active?.reason === "request";
  }

  /** The mic stopped. A check in flight is the caller's to cancel; its result is ignored. */
  stop(nowMs: number): void {
    if (this.stoppedAtMs !== null) return;
    this.stoppedAtMs = nowMs;
    this.active = null;
    this.held = null;
  }

  resume(): void {
    this.commitLive();
    this.stoppedAtMs = null;
  }

  /** Treat what the recognizer has so far as final (it has stopped, and won't improve on it). */
  commitLive(): void {
    if (this.transcript.liveText) this.transcript.accept({ text: "", isFinal: true });
  }

  /**
   * The next check to run, if it's time for one; the caller then owes
   * complete() or fail(). A likely question skips the word count and the wait
   * after a cue, since an answer is worthless late.
   */
  nextCheck(pacing: CuePacing | null, nowMs: number, limits: ContextLimits): CueCheck | null {
    if (!pacing || this.active || this.stoppedAtMs !== null || this.held || this.visible) return null;
    const sinceCheck = nowMs - this.lastCheckAtMs;
    if (sinceCheck < Math.min(MAX_FAILURE_BACKOFF_MS, this.failures * FAILURE_BACKOFF_MS)) return null;
    const fresh = this.transcript.finalText.slice(this.readTo);
    const weight = speechWeight(fresh);
    if (weight >= MIN_QUESTION_WORDS && looksLikeQuestion(fresh) && sinceCheck >= pacing.questionGapMs) {
      return this.begin("question", nowMs, limits);
    }
    if (sinceCheck < pacing.checkGapMs || nowMs - this.lastCueAtMs < pacing.cueGapMs) return null;
    const longTurn = speechWeight(this.transcript.liveText) - this.liveWeightRead >= LONG_TURN_WORDS;
    return weight >= pacing.minNewWords || longTurn ? this.begin("speech", nowMs, limits) : null;
  }

  /**
   * The wearer asked. Supersedes a check in flight (the caller cancels it) and
   * a cue waiting for a pause. Null when there's nothing to go on.
   */
  requestCheck(nowMs: number, limits: ContextLimits, question = ""): CueCheck | null {
    if (!this.hasSpeech && !question) return null;
    this.held = null;
    return this.begin("request", nowMs, limits, question);
  }

  private begin(reason: CueCheck["reason"], nowMs: number, limits: ContextLimits, question = ""): CueCheck {
    const finals = this.transcript.finalText;
    const live = this.transcript.liveText;
    this.lastCheckAtMs = nowMs;
    this.liveWeightRead = speechWeight(live);
    const check: CueCheck = {
      reason,
      earlier: trimContext(finals.slice(0, this.readTo), limits),
      justSaid: [finals.slice(this.readTo).slice(-JUST_SAID_CHARS), live].filter(Boolean).join("\n"),
      shownCues: this.cues.slice(-CUES_SENT_BACK).map((cue) => cue.headline),
      question,
      readTo: finals.length,
      startedAtMs: nowMs,
    };
    this.active = check;
    return check;
  }

  isActive(check: CueCheck): boolean {
    return this.active === check;
  }

  /** The check in flight, if it has been going longer than `timeoutMs`. */
  overdueCheck(nowMs: number, timeoutMs: number): CueCheck | null {
    return this.active && nowMs - this.active.startedAtMs > timeoutMs ? this.active : null;
  }

  /**
   * The model replied (null: nothing to say). What the check read counts as
   * read either way. A cue that clears every bar waits for tick() to show it.
   */
  complete(check: CueCheck, draft: CueDraft | null, nowMs: number, bar: { minScore: number; maxAgeMs: number; avoid: readonly string[] }): CueOutcome {
    if (this.active !== check) return "abandoned";
    this.active = null;
    this.failures = 0;
    this.readTo = Math.max(this.readTo, check.readTo);
    if (!draft) return "none";
    const requested = check.reason === "request";
    if (!requested) {
      if (draft.score < bar.minScore) return "below-bar";
      if (nowMs - check.startedAtMs > bar.maxAgeMs) return "too-old";
      const earlier = [...this.cues.map((cue) => cue.headline), ...bar.avoid];
      if (earlier.some((other) => cueSimilarity(draft.headline, other) >= DUPLICATE_SIMILARITY)) return "duplicate";
    }
    this.held = { draft, readyAtMs: nowMs, requested };
    return "accepted";
  }

  /** The request failed: the speech stays unread, and checks back off. */
  fail(check: CueCheck): void {
    if (this.active !== check) return;
    this.active = null;
    this.failures++;
  }

  /** Advance the clock. `shown` is a cue that reached the wearer on this tick. */
  tick(nowMs: number): { changed: boolean; shown: Cue | null } {
    let changed = false;
    if (this.stoppedAtMs !== null && nowMs - this.stoppedAtMs > STOP_SETTLE_MS && this.transcript.liveText) {
      this.commitLive();
      changed = true;
    }
    if (this.visible && nowMs >= this.visible.untilMs) {
      this.visible = null;
      changed = true;
    }
    if (this.history && nowMs >= this.history.untilMs) {
      this.closeHistory();
      changed = true;
    }
    const held = this.held;
    if (!held) return { changed, shown: null };
    const due = held.requested || nowMs - this.lastSpeechAtMs >= PAUSE_GAP_MS || nowMs - held.readyAtMs >= MAX_HOLD_MS;
    if (!due) return { changed, shown: null };
    this.held = null;
    return { changed: true, shown: this.present(held.draft, held.requested, nowMs) };
  }

  /** A cue the wearer asked for opens with its detail, since they're ready to read. */
  private present(draft: CueDraft, requested: boolean, nowMs: number): Cue {
    const cue: Cue = { ...draft, id: this.nextCueId++, shownAtMs: nowMs };
    this.cues.push(cue);
    this.lastCueAtMs = nowMs;
    if (this.history) this.unseen++;
    else this.visible = { cue, untilMs: nowMs + (requested ? EXPANDED_TTL_MS : this.cueTtlMs()), expanded: requested };
    return cue;
  }

  get current(): CurrentCue | null {
    if (this.history) {
      const { index } = this.history;
      return { cue: this.cues[index]!, expanded: true, position: { index: index + 1, total: this.cues.length } };
    }
    return this.visible ? { cue: this.visible.cue, expanded: this.visible.expanded, position: null } : null;
  }

  /** Cues that arrived while reading history. */
  get unseenCues(): number {
    return this.unseen;
  }

  /** A tap on the cue on screen: opens its detail, then dismisses it. False when none is up. */
  tap(nowMs: number): boolean {
    if (this.history) {
      this.closeHistory();
      return true;
    }
    const visible = this.visible;
    if (!visible) return false;
    if (visible.cue.detail && !visible.expanded) {
      visible.expanded = true;
      visible.untilMs = nowMs + EXPANDED_TTL_MS;
    } else {
      this.visible = null;
    }
    return true;
  }

  /** Clear the cue on screen, unless it's being read from history. */
  dismiss(): void {
    this.visible = null;
  }

  /**
   * Scroll through past cues: back (-1) opens history at the newest, and
   * forward past the newest closes it. Returns whether anything changed.
   */
  scrollCues(delta: -1 | 1, nowMs: number): boolean {
    if (!this.cues.length) return false;
    if (!this.history) {
      if (delta > 0) return false;
      this.visible = null;
      this.history = { index: this.cues.length - 1, untilMs: nowMs + HISTORY_IDLE_MS };
      return true;
    }
    const index = this.history.index + delta;
    if (index >= this.cues.length) {
      this.closeHistory();
      return true;
    }
    this.history = { index: Math.max(0, index), untilMs: nowMs + HISTORY_IDLE_MS };
    return true;
  }

  private closeHistory(): void {
    this.history = null;
    this.unseen = 0;
  }
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The Markdown file Save writes. `recap` is already Markdown, or empty. */
export function formatSessionForSave(session: { title: string; recap: string; cues: readonly Cue[]; transcript: string }): string {
  const parts = [`# ${session.title || "Conversation"}`];
  if (session.recap) parts.push(session.recap);
  if (session.cues.length) {
    const cues = session.cues.map((cue) => {
      const line = `- ${clockTime(cue.shownAtMs)} ${CUE_KIND_LABELS[cue.kind]}: ${cue.headline}`;
      return cue.detail ? `${line}\n  ${cue.detail}` : line;
    });
    parts.push(`## Cues\n\n${cues.join("\n")}`);
  }
  parts.push(`## Transcript\n\n${session.transcript.trim()}`);
  return `${parts.join("\n\n")}\n`;
}
