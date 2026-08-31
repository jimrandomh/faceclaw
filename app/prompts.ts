import type { AssistantContext } from "./assistant/types";

/**
 * All hardcoded LLM prompt text lives here, so prompts can be reviewed and
 * edited in one place without digging through the code that sends them.
 */

/** Base system prompt for the on-glasses voice assistant. */
export const ASSISTANT_SYSTEM_PROMPT_BASE = [
  "You are the voice assistant built into a pair of Even Realities G2 smart glasses.",
  "Your reply is shown as text on a 640x480 monochrome heads-up display and may also be read aloud, so keep it short: 1-3 plain sentences, no markdown, no bullet lists unless the user explicitly asks for a list.",
  "Prefer doing things with the tools you have over describing how the user could do them; when a tool can answer or act, use it.",
  "If a tool fails or a capability is missing, say so briefly rather than inventing a result.",
].join(" ");

/** Full assistant system prompt: the base plus the current device context. */
export function buildAssistantSystemPrompt(ctx: AssistantContext): string {
  return `${ASSISTANT_SYSTEM_PROMPT_BASE}\n\n${describeAssistantContext(ctx)}`;
}

/**
 * The volatile device context on its own. The local provider appends this to
 * the user message instead of the system prompt: the system prompt + tool
 * declarations are the bulk of the prompt, and keeping them byte-stable lets
 * the on-phone model reuse its KV-cache prefix across turns instead of
 * re-prefilling ~2-3k tokens because the clock changed.
 */
export function describeAssistantContext(ctx: AssistantContext): string {
  const parts = [`Current time: ${ctx.localTime}.`];
  parts.push(`The glasses display is currently ${ctx.screenOn ? "on" : "off"}.`);
  if (ctx.foregroundApp) {
    const title = ctx.foregroundTitle ? ` ("${ctx.foregroundTitle}")` : "";
    parts.push(`The foreground app is ${ctx.foregroundApp}${title}.`);
  } else {
    parts.push("No app is in the foreground (the launcher is showing).");
  }
  if (ctx.headsetBattery !== null) {
    parts.push(`Glasses battery: ${ctx.headsetBattery}%.`);
  }
  return `Context: ${parts.join(" ")}`;
}

/** System prompt for the dictation-refinement (voice continuation) flow. */
export const REFINE_SYSTEM_PROMPT =
  "You edit dictated text. The user dictated a message, then dictated a follow-up. " +
  "If the follow-up is additional content, append it to the message where it naturally fits. " +
  "If it describes an edit (a correction, a deletion, or content to insert somewhere specific), apply that edit instead of appending the instruction itself. " +
  "Fix only what the follow-up asks; keep the rest of the original wording. " +
  "Output only the final text of the message, with no preamble, quotes, or commentary.";

/** User message for the dictation-refinement flow. */
export function buildRefineUserMessage(original: string, followup: string): string {
  return `Original dictation:\n${original}\n\nFollow-up dictation:\n${followup}`;
}

/**
 * The Calculator app's spoken-problem rewrite. The model never computes
 * anything: it is used strictly as a translator from English into notation,
 * and the deterministic engine solves the rewritten expression — so a wrong
 * reading shows up as a wrong-looking equation rather than as a plausible
 * wrong number.
 */
export const CALCULATOR_REWRITE_SYSTEM_PROMPT =
  "Rewrite the user's spoken request as ONE mathematical expression or equation, in plain " +
  "ASCII notation (+ - * / ^ = ( ) sqrt() sin() log()). Use x, y, z for unknowns. " +
  "Reply with the expression and NOTHING else — no words, no explanation, no answer, " +
  'no "=" result appended. If it is not a calculation, reply exactly "none".';

/** User message for the calculator rewrite flow. */
export function buildCalculatorRewriteUserMessage(spoken: string): string {
  return `Request: ${spoken}`;
}
