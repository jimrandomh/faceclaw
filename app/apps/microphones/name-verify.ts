import { isLocalModelReady, streamLocalQwen } from "../../native/llama";
import type { NameInference } from "./name-guess";

/**
 * Second-tier verification of heuristic name detections using the on-phone
 * LLM (the assistant's Qwen model, when downloaded). The regex tier is
 * deliberately permissive about unusual real names; the model is asked the
 * one question the regex can't answer — "is this actually a person's name
 * being introduced here?" — before a speaker profile gets renamed.
 *
 * Verdicts: true (confirmed), false (rejected), null (model unavailable,
 * busy, timed out, or gave a non-answer). Callers treat null as "trust the
 * heuristic": renames are retroactively correctable, so a missing model
 * must not disable introduction naming entirely.
 */

const VERDICT_TIMEOUT_MS = 25_000;

// One verification at a time: the runner is shared with the assistant, and
// caption lines can arrive faster than CPU inference finishes.
let inFlight = false;

export function verifyIntroducedName(
  inference: NameInference,
  sentence: string,
): Promise<boolean | null> {
  if (!global.isAndroid || !isLocalModelReady() || inFlight) {
    return Promise.resolve(null);
  }
  inFlight = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict: boolean | null) => {
      if (settled) return;
      settled = true;
      inFlight = false;
      resolve(verdict);
    };
    const timer = setTimeout(() => finish(null), VERDICT_TIMEOUT_MS);
    try {
      streamLocalQwen({
        apiKey: "",
        model: "local",
        system:
          "You verify speaker introductions for a live-captioning app. " +
          "Given a transcript line and a candidate name, decide whether the candidate " +
          "is genuinely a person's name being introduced (their own or someone else's), " +
          "rather than an ordinary word, feeling, or phrase. " +
          'Answer with exactly one word: "YES" or "NO".',
        messages: [
          {
            role: "user",
            content:
              `Transcript line: "${sentence.trim()}"\n` +
              `Candidate name: "${inference.name}" ` +
              `(detected as a ${inference.kind === "self" ? "self-introduction" : "third-party introduction"}).\n` +
              `Is "${inference.name}" a person's name being introduced in this line?`,
          },
        ],
        maxTokens: 8,
        onDone: (result) => {
          clearTimeout(timer);
          const text = result.text.trim().toUpperCase();
          if (/\bYES\b/.test(text)) finish(true);
          else if (/\bNO\b/.test(text)) finish(false);
          else finish(null);
        },
        onError: () => {
          clearTimeout(timer);
          finish(null);
        },
      });
    } catch (error) {
      clearTimeout(timer);
      console.warn(`name verification failed: ${error}`);
      finish(null);
    }
  });
}
