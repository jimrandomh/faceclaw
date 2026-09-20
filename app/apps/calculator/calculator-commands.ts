// The pure classification half of the calculator's command handling. Kept
// free of any UI import so the tests can exercise exactly the
// decisions that matter: which utterances are commands, which unprompted room
// speech is worth answering, and how the modes map onto the shared session.

import { type MathBranchMode } from "./math/coordinator";
import { parseCommand } from "./math/session";

/**
 * What a freshly captured problem does the moment it lands.
 *
 * Three, not more, because these are the three the wearer is TOLD about —
 * "Solve", "Explain", "Graph" are the spoken commands, so making them the
 * selectable modes means the touchpad and the voice are steering the same
 * thing rather than two parallel vocabularies. Differentiation stays
 * reachable by saying it ("the derivative of…"), which is how it is actually
 * asked for.
 */
export type CalculatorMode = "solve" | "explain" | "graph";

export const CALCULATOR_MODES: readonly CalculatorMode[] = ["solve", "explain", "graph"];

export function modeLabel(mode: CalculatorMode): string {
  switch (mode) {
    case "solve":
      return "Solve";
    case "explain":
      return "Explain";
    case "graph":
      return "Graph";
  }
}

export function modeDetail(mode: CalculatorMode): string {
  switch (mode) {
    case "solve":
      return "Answer it, exactly. 3/2 stays 3/2.";
    case "explain":
      return "Show the working step by step; scroll walks the rest.";
    case "graph":
      return "Plot it.";
  }
}

export function modeBranch(mode: CalculatorMode): MathBranchMode {
  return mode;
}

/**
 * The spoken commands that select this mode. Both the bare verb and the
 * "it" form, because someone shown "Solve" says both.
 */
export function modeSpokenCommands(mode: CalculatorMode): string[] {
  switch (mode) {
    case "solve":
      return ["solve", "solve it"];
    case "explain":
      return ["explain", "explain it"];
    case "graph":
      return ["graph", "graph it"];
  }
}

/**
 * How the Calculator listens.
 *
 * "Tap to talk" arms exactly one finalized utterance per tap, so the app is
 * not standing in the room claiming every sentence; "continuous" listens the
 * whole time the app is foreground, gated by the looks-like-maths test
 * below. The reason there are two input modes: a wearer in a
 * quiet room must be able to take the microphone away from the calculator.
 */
export type CalculatorListening = "tap" | "continuous";

export function listeningLabel(listening: CalculatorListening): string {
  switch (listening) {
    case "tap":
      return "Tap to talk";
    case "continuous":
      return "Continuous";
  }
}

/**
 * Recognise a bare mode command in an utterance. Exact match on the whole
 * utterance, not a substring: "I need to solve this problem with the tax
 * people" is conversation, and a substring test turns it into a command.
 */
export function modeCommand(text: string): CalculatorMode | null {
  const normalized = text.toLowerCase().replace(/^[ .,!?"']+|[ .,!?"']+$/g, "");
  for (const mode of CALCULATOR_MODES) {
    if (modeSpokenCommands(mode).includes(normalized)) return mode;
  }
  return null;
}

export function isDictationCancellation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/^[ .,!?"']+|[ .,!?"']+$/g, "");
  return ["cancel", "cancel listening", "stop listening", "never mind", "nevermind"].includes(normalized);
}

/**
 * Whether unprompted room speech is worth handing to the parser. In
 * continuous mode the app sees every finalized utterance in the room;
 * without this gate, every sentence becomes a failed calculation on the
 * lens.
 */
export function isWorthAnswering(text: string): boolean {
  if (modeCommand(text) !== null) return true;
  return parseCommand(text) !== null;
}

export function cycleMode(mode: CalculatorMode, forward: boolean): CalculatorMode {
  const index = CALCULATOR_MODES.indexOf(mode);
  const step = forward ? 1 : CALCULATOR_MODES.length - 1;
  return CALCULATOR_MODES[(index + step) % CALCULATOR_MODES.length]!;
}
