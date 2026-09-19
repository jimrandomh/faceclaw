// Owns the one live maths problem and everything derived from it. Shared
// state rather than per-request because the whole point of "graph it" and
// "explain it" is that they refer to the problem already on the lens; a
// caller that re-parsed its own capture each time would make those
// follow-ups impossible.
//
// Deep digit work runs on the phone as an explicit, cancellable long run
// the wearer opts into. The
// optional AI pass is injected as a hook so this module stays free of any
// networking and testable in plain Node.

import { type MathConstantName, ComputeCancelled, constantDisplayName, constantNamed } from "./constant-digits";
import { highlightedMatch } from "./digit-search";
import { formatInt } from "./math-number";
import {
  type LongRunOffer,
  type LongRunProgress,
  type MathWorkload,
  compactDuration,
  longRunOffer as makeLongRunOffer,
  runAcceptedCount,
  runAcceptedDigits,
  runAcceptedSearch,
} from "./workload";
import { type MathSessionResult, MathSession, parseCommand } from "./session";
import { type Graph } from "./plotter";
import { type SolutionStep } from "./solver";
import { plain } from "./text-renderer";

// ---------------------------------------------------------------------------
// Branch outcome

/**
 * A branch result. The value/failure split matters: a parse error must never
 * be posted onward as if it were the answer.
 */
export type MathBranchOutcome =
  | { kind: "value"; text: string }
  | { kind: "failure"; reason: string };

export type MathBranchMode = "solve" | "explain" | "graph" | "derivative" | "digitSearch" | "digitCount";

/**
 * The app's uniform gesture contract: forward/back step through the
 * working, commit
 * graphs, alternate explains, exit clears.
 */
export type RingAction = "forward" | "back" | "commit" | "alternate" | "exit";

/**
 * Ask the configured assistant to render a spoken problem as an expression
 * (the prompt text lives in app/prompts.ts with every other prompt).
 * Injected by the app; null when no provider is configured. Resolves to the
 * model's raw reply, or null on failure — the coordinator sanitises it.
 */
export type AICompletion = (spokenText: string) => Promise<string | null>;

export class MathCoordinator {
  /** The last thing produced, for the answer view. */
  lastResult: MathSessionResult | null = null;
  lastGraph: Graph | null = null;
  /** Position in the working, for the step indicator. */
  stepPosition: { index: number; total: number } | null = null;

  /**
   * A standing offer to grind the full-depth answer out on the phone.
   * Non-null means every surface should be offering it.
   */
  pendingLongRun: LongRunOffer | null = null;
  /** Live progress while an accepted run is going. Null when nothing is running. */
  longRunProgress: LongRunProgress | null = null;
  /**
   * The answer a deeper pass produced. One channel, because from the
   * wearer's side it is one event: the better answer arrived.
   */
  deepAnswer: MathBranchOutcome | null = null;

  /** Repaint hook, set by the owning layer. */
  onChanged: (() => void) | null = null;

  private readonly session = new MathSession();
  private completeWithAI: AICompletion | null = null;
  private longRunCancelled = false;
  private longRunRunning = false;
  private longRunStartedAtMs = 0;

  get hasProblem(): boolean {
    return this.session.hasProblem;
  }

  get currentSolution() {
    return this.session.currentSolution;
  }

  get explanationSteps(): SolutionStep[] {
    return this.session.currentSolution?.steps ?? [];
  }

  get isRunningLong(): boolean {
    return this.longRunRunning;
  }

  setUsesDegrees(value: boolean): void {
    this.session.setUsesDegrees(value);
  }

  setAICompletion(completion: AICompletion | null): void {
    this.completeWithAI = completion;
  }

  private changed(): void {
    this.onChanged?.();
  }

  // -------------------------------------------------------------------------
  // Branch execution

  /**
   * Run one branch. Returns the glasses text, or a failure string — the
   * caller distinguishes them.
   */
  run(mode: MathBranchMode, input: string): MathBranchOutcome {
    const trimmed = input.trim();

    let sessionResult: MathSessionResult;
    switch (mode) {
      case "solve":
        // "Solve it" after Graph/Explain means show the standing answer
        // again. Requiring fresh input here made the third follow-up mode
        // uniquely fail.
        if (!trimmed && this.session.hasProblem) {
          sessionResult = this.session.execute({ kind: "restate" });
        } else if (!trimmed) {
          return { kind: "failure", reason: "Nothing was captured to solve" };
        } else {
          sessionResult = this.session.solve(trimmed);
        }
        break;
      case "graph":
        // A graph branch may fire with a fresh capture ("graph x squared") or
        // as a follow-up on the standing problem ("graph it"). Both have to
        // work from the same branch.
        if (trimmed && (parseCommand(trimmed) === null || this.isProblem(trimmed))) {
          this.session.solve(trimmed);
        }
        sessionResult = this.session.graph();
        break;
      case "explain":
        if (trimmed && this.isProblem(trimmed)) this.session.solve(trimmed);
        sessionResult = this.session.explain();
        break;
      case "derivative":
        if (trimmed && this.isProblem(trimmed)) this.session.solve(trimmed);
        sessionResult = this.session.differentiate(null);
        break;
      case "digitSearch":
      case "digitCount": {
        const digits = MathCoordinator.digitRun(trimmed);
        if (!digits) return { kind: "failure", reason: "No digits were captured to look for" };
        // The constant is read from the capture when the wearer named one
        // ("…in the golden ratio") and is π otherwise.
        const constant: MathConstantName = constantNamed(trimmed) ?? "pi";
        sessionResult = this.session.execute({
          kind: "advanced",
          topic:
            mode === "digitCount"
              ? { kind: "digitCount", pattern: digits, constant }
              : { kind: "digitSearch", pattern: digits, constant, occurrence: 1 },
        });
        break;
      }
    }

    return this.publish(sessionResult);
  }

  /**
   * Every digit in the capture, in order, with the separators dropped.
   *
   * Joined rather than "the first run" because ASR punctuates a spoken date
   * freely — "07 04 84", "070484", "7/4/84" are all the same six digits —
   * and taking the first run would search π for "07", which appears within
   * the first dozen places and looks for all the world like a working
   * answer.
   */
  static digitRun(text: string): string | null {
    const joined = text.replace(/\D/g, "");
    return joined ? joined : null;
  }

  private isProblem(text: string): boolean {
    return parseCommand(text)?.kind === "problem";
  }

  // -------------------------------------------------------------------------
  // Spoken questions

  /**
   * Answer a question stated in words, whatever shape it arrived in.
   *
   * Two passes, in this order and never the other way round:
   *
   * 1. The deterministic engine alone. The spoken normaliser already turns
   *    "two x squared plus three x" into `2x²+3x`, and every answer it gives
   *    is exact.
   * 2. Only if that fails to parse, ask the model to REWRITE the words as an
   *    expression — and then solve that expression here, deterministically.
   *
   * The model never computes anything. It is used as a translator from
   * English into notation, which is the part it is genuinely good at and the
   * part where a mistake is visible: the rewritten expression is returned
   * alongside the answer, so a wrong reading shows up as a wrong-looking
   * equation rather than as a plausible wrong number.
   */
  async answerSpoken(text: string): Promise<MathBranchOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return { kind: "failure", reason: "Nothing was said to calculate" };

    const command = parseCommand(trimmed);
    if (command) {
      const outcome = this.publish(this.session.execute(command));
      if (outcome.kind === "value") return outcome;
      // A FOLLOW-UP that failed keeps its own message. "Graph it" with
      // nothing on the lens fails because there is nothing to graph, and
      // handing those two words to a rewriter would replace that with "could
      // not read that as a calculation" — true of the words, and useless
      // about the actual problem.
      if (command.kind !== "problem") return outcome;
    }

    const rewritten = await this.expressionFromAI(trimmed);
    if (!rewritten) {
      return { kind: "failure", reason: "Could not read that as a calculation" };
    }
    const outcome = this.publish(this.session.solve(rewritten));
    if (outcome.kind !== "value") return outcome;
    // Show the reading, not just the result. A wearer glancing at the lens
    // has to be able to see that the machine understood the right question
    // before they repeat the number.
    return { kind: "value", text: `${rewritten}\n${outcome.text}` };
  }

  /**
   * Ask the configured assistant to render a spoken problem as an
   * expression. Returns null when no provider is configured, when it
   * declines, or when it answers with anything that is not one.
   */
  private async expressionFromAI(text: string): Promise<string | null> {
    if (!this.completeWithAI) return null;
    let raw: string | null;
    try {
      raw = await this.completeWithAI(text);
    } catch {
      return null;
    }
    if (!raw) return null;

    let candidate = raw.trim();
    // Models fence notation out of habit even when told not to.
    if (candidate.startsWith("```")) {
      candidate = candidate
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join(" ")
        .trim();
    }
    candidate = candidate.replace(/^[ `.,]+|[ `.,]+$/g, "");

    if (!candidate || candidate.toLowerCase() === "none") return null;
    // A refusal or an apology is prose, and prose fed to the parser fails in
    // a way that reads like the maths was wrong rather than the routing.
    if (candidate.length > 120) return null;
    if (!/[+\-*/^=\d]/.test(candidate)) return null;
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Voice follow-ups

  /**
   * Handle a spoken follow-up. Returns null when the utterance is not a
   * maths command, so ordinary conversation flows past untouched — this is
   * called from the transcript stream, which sees everything said in the
   * room in continuous mode.
   */
  handleUtterance(utterance: string): MathBranchOutcome | null {
    // A standing offer or a run in flight owns the next yes/no said in the
    // room. Checked before the maths parser, because "keep going" is not an
    // equation and would otherwise fall straight through.
    const longRunAnswer = this.handleLongRunUtterance(utterance);
    if (longRunAnswer) return longRunAnswer;

    const command = parseCommand(utterance);
    if (!command) return null;
    // A bare problem with no standing session is a new problem; a follow-up
    // with no session is a no-op rather than an error card in mid-air.
    if (command.kind !== "problem" && command.kind !== "advanced" && !this.session.hasProblem) {
      return null;
    }
    return this.publish(this.session.execute(command));
  }

  /**
   * Accept or decline a long run by voice. Only fires while an offer stands
   * or a run is going, so these phrases stay out of the way of ordinary
   * conversation the rest of the time.
   */
  handleLongRunUtterance(utterance: string): MathBranchOutcome | null {
    const text = utterance.toLowerCase();

    if (this.longRunRunning) {
      if (!STOP_PHRASES.some((phrase) => text.includes(phrase))) return null;
      this.cancelLongRun();
      return { kind: "failure", reason: "Stopping" };
    }

    const offer = this.pendingLongRun;
    if (!offer) return null;
    if (ACCEPT_PHRASES.some((phrase) => text.includes(phrase))) {
      void this.acceptLongRun();
      return { kind: "value", text: `Working — ${compactDuration(offer.estimatedSeconds)}` };
    }
    if (DECLINE_PHRASES.some((phrase) => text.includes(phrase))) {
      this.declineLongRun();
      return { kind: "failure", reason: "Left it there" };
    }
    return null;
  }

  get hasLongRunInteraction(): boolean {
    return this.pendingLongRun !== null || this.longRunRunning;
  }

  // -------------------------------------------------------------------------
  // Uniform gesture contract

  handleRingAction(action: RingAction): MathBranchOutcome | null {
    // The offer and the running job both pre-empt the step navigation: while
    // either is on screen, the input is answering that question and nothing
    // else. Same gestures, no new vocabulary.
    if (this.longRunRunning) {
      if (action !== "exit") return null;
      this.cancelLongRun();
      return { kind: "failure", reason: "Stopping" };
    }
    const offer = this.pendingLongRun;
    if (offer) {
      switch (action) {
        case "commit":
          void this.acceptLongRun();
          return { kind: "value", text: `Working — ${compactDuration(offer.estimatedSeconds)}` };
        case "exit":
          this.declineLongRun();
          return { kind: "failure", reason: "Left it there" };
        default:
          return null;
      }
    }

    if (!this.session.hasProblem) return null;
    switch (action) {
      case "forward":
        return this.publish(this.session.execute({ kind: "nextStep" }));
      case "back":
        return this.publish(this.session.execute({ kind: "previousStep" }));
      case "commit":
        return this.publish(this.session.graph());
      case "alternate":
        return this.publish(this.session.explain());
      case "exit":
        return this.publish(this.session.execute({ kind: "clear" }));
    }
  }

  // -------------------------------------------------------------------------
  // Long runs

  /** Take the standing offer. Returns false when there was nothing to accept. */
  acceptLongRun(): boolean {
    const offer = this.pendingLongRun;
    if (!offer || this.longRunRunning) return false;
    this.pendingLongRun = null;
    this.deepAnswer = null;
    this.longRunCancelled = false;
    this.longRunRunning = true;
    this.longRunStartedAtMs = Date.now();
    this.longRunProgress = { fraction: 0, stage: "starting", elapsedSeconds: 0 };
    this.changed();

    const cancellation = () => this.longRunCancelled;
    const progress = (fraction: number, stage: string) => {
      this.longRunProgress = {
        fraction,
        stage,
        elapsedSeconds: (Date.now() - this.longRunStartedAtMs) / 1000,
      };
      this.changed();
    };

    void (async () => {
      let outcome: MathBranchOutcome;
      try {
        switch (offer.workload.kind) {
          case "digitSearch": {
            const found = await runAcceptedSearch(offer, cancellation, progress);
            outcome = describeDeepSearch(found, offer.workload.pattern, offer.workload.constant);
            break;
          }
          case "constantDigits": {
            const digits = await runAcceptedDigits(offer, cancellation, progress);
            outcome = digits
              ? {
                  kind: "value",
                  text: `${constantDisplayName(offer.workload.constant)}: ${formatInt(digits.length)} digits ready`,
                }
              : { kind: "failure", reason: "Could not generate that many digits" };
            break;
          }
          case "digitCount": {
            const counted = await runAcceptedCount(offer, cancellation, progress);
            outcome = {
              kind: "value",
              text: describeCount(counted.occurrences, counted.searchedDigits, offer.workload.pattern, offer.workload.constant),
            };
            break;
          }
        }
      } catch (error) {
        outcome =
          error instanceof ComputeCancelled
            ? { kind: "failure", reason: "Stopped" }
            : { kind: "failure", reason: String((error as Error)?.message ?? error) };
      }
      this.longRunRunning = false;
      this.longRunProgress = null;
      this.deepAnswer = outcome;
      this.changed();
    })();
    return true;
  }

  /** Turn the offer down. The shallow answer already given stands. */
  declineLongRun(): void {
    this.pendingLongRun = null;
    this.changed();
  }

  /**
   * Stop a run in flight. The digits computed so far are discarded — a
   * partial expansion cannot answer a position question.
   */
  cancelLongRun(): void {
    this.longRunCancelled = true;
  }

  // -------------------------------------------------------------------------
  // Publishing

  private publish(sessionResult: MathSessionResult): MathBranchOutcome {
    this.lastResult = sessionResult;

    // The shallow answer goes out immediately; anything better arrives on
    // `deepAnswer` if the wearer accepts the standing offer. Never block the
    // first response on the second — silence is worse than a partial.
    if (sessionResult.unresolvedWorkload) {
      this.pendingLongRun = makeLongRunOffer(
        sessionResult.unresolvedWorkload,
        "Needs a deeper expansion than the fast pass holds",
        shallowDescription(sessionResult.unresolvedWorkload, sessionResult),
      );
      this.deepAnswer = null;
    }

    switch (sessionResult.payload.kind) {
      case "graph":
        this.lastGraph = sessionResult.payload.graph;
        this.stepPosition = null;
        break;
      case "step":
        this.lastGraph = null;
        this.stepPosition = { index: sessionResult.payload.index, total: sessionResult.payload.total };
        break;
      case "solution":
      case "message":
      case "topic":
        this.lastGraph = null;
        // An advanced topic answers in one shot — there is no working to step
        // through, so the step indicator must clear.
        this.stepPosition = null;
        break;
      case "failure":
        break;
    }
    this.changed();

    if (sessionResult.payload.kind === "failure") {
      return { kind: "failure", reason: sessionResult.payload.message };
    }
    return { kind: "value", text: this.glassesText(sessionResult) };
  }

  /**
   * Two or three short rows. The lens has no room for the detail sentence,
   * which is why `detail` stays in the fuller answer view.
   */
  private glassesText(sessionResult: MathSessionResult): string {
    switch (sessionResult.payload.kind) {
      case "step": {
        const payload = sessionResult.payload;
        return `${payload.index + 1}/${payload.total}  ${payload.step.title}\n${plain(payload.step.expression)}`;
      }
      case "graph":
        // The bitmap carries the picture; this is the text fallback.
        return sessionResult.headline;
      case "topic": {
        // Two field rows at most: the window is short and the headline
        // already took a line.
        const payload = sessionResult.payload;
        return [payload.headline, ...payload.fields.slice(0, 2)].join("\n");
      }
      default:
        return sessionResult.headline;
    }
  }
}

// ---------------------------------------------------------------------------
// Long-run phrases

const ACCEPT_PHRASES = [
  "keep going",
  "run it anyway",
  "run it any way",
  "take your time",
  "go deeper",
  "keep looking",
  "do it anyway",
  "yes go on",
];

const DECLINE_PHRASES = [
  "never mind",
  "nevermind",
  "forget it",
  "leave it",
  "don't bother",
  "do not bother",
  "skip it",
];

const STOP_PHRASES = ["stop", "cancel", "give up", "that's enough", "thats enough"];

// ---------------------------------------------------------------------------
// Descriptions

function describeDeepSearch(
  outcome: Awaited<ReturnType<typeof runAcceptedSearch>>,
  pattern: string,
  constant: MathConstantName,
): MathBranchOutcome {
  switch (outcome.kind) {
    case "found":
      return {
        kind: "value",
        text:
          `${constantDisplayName(constant)}: places ${outcome.match.start}–${outcome.match.end}\n` +
          `…${highlightedMatch(outcome.match)}…`,
      };
    case "notFound":
      // Now a much stronger claim than the shallow pass could make, so it is
      // worth stating the depth that was actually reached.
      return {
        kind: "failure",
        reason:
          `${pattern} is not in the first ${formatInt(outcome.searchedDigits)} digits ` +
          `of ${constantDisplayName(constant)}`,
      };
    case "invalidPattern":
      return { kind: "failure", reason: outcome.reason };
  }
}

function describeCount(
  occurrences: number,
  searchedDigits: number,
  pattern: string,
  constant: MathConstantName,
): string {
  const times = occurrences === 1 ? "time" : "times";
  return `${pattern}: ${occurrences} ${times}\nfirst ${formatInt(searchedDigits)} digits of ${constantDisplayName(constant)}`;
}

function shallowDescription(workload: MathWorkload, sessionResult: MathSessionResult): string | null {
  switch (workload.kind) {
    case "digitSearch":
      return sessionResult.headline;
    case "digitCount":
      return sessionResult.headline;
    case "constantDigits":
      return null;
  }
}
