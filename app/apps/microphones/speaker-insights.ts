import { Utils } from "@nativescript/core";

import { isLocalModelReady, streamLocalQwen } from "../../native/llama";
import { speakerRegistry } from "./speakers";

declare const com: any;

/**
 * Per-speaker conversation insights, generated with the on-phone LLM when a
 * caption session ends: a short recap of the conversation, the action items
 * it produced, and a consolidated list of inferred facts about the person
 * (fed by the transcript, the contact's tag/notes, and previously inferred
 * facts). Stored on the speaker row in the conversation store, where the
 * encounter popup and the People view read them back.
 *
 * Best-effort by design: no model, a busy runner, or an unparseable reply
 * simply leaves the speaker's existing insights in place. Everything runs
 * sequentially — the runner is shared with the assistant and caption name
 * verification.
 */

/** Speakers with fewer transcript lines than this in the session are skipped. */
const MIN_SPEAKER_LINES = 2;
/** Transcript excerpt budget; Qwen runs with a 4096-token context. */
const MAX_TRANSCRIPT_CHARS = 4500;
const MAX_FACTS = 8;
const MAX_ACTION_ITEMS = 6;
const GENERATION_TIMEOUT_MS = 90_000;

type SegmentLine = { speakerId: number | null; text: string };

function store(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

/** One generation at a time across sessions; a second session-end call queues behind the first. */
let chain: Promise<void> = Promise.resolve();

/**
 * Generate and store insights for every non-wearer speaker heard in the
 * session. Fire-and-forget: call after the session row is finished; errors
 * only log.
 */
export function generateSessionInsights(sessionId: number): void {
  if (!global.isAndroid || sessionId < 0 || !isLocalModelReady()) return;
  chain = chain.then(() => generateForSession(sessionId)).catch((error) => {
    console.warn(`speaker insights generation failed: ${error}`);
  });
}

async function generateForSession(sessionId: number): Promise<void> {
  const segments = (JSON.parse(String(store().querySegments(sessionId))) as Array<Record<string, unknown>>)
    .map((row): SegmentLine => ({
      speakerId: row.speakerId === null ? null : Number(row.speakerId),
      text: String(row.text ?? "").trim(),
    }))
    .filter((line) => line.text);
  if (!segments.length) return;

  speakerRegistry.reload();
  const lineCounts = new Map<number, number>();
  for (const line of segments) {
    if (line.speakerId !== null) {
      lineCounts.set(line.speakerId, (lineCounts.get(line.speakerId) ?? 0) + 1);
    }
  }

  const transcript = buildTranscript(segments);
  for (const [speakerId, lines] of lineCounts) {
    if (lines < MIN_SPEAKER_LINES) continue;
    const profile = speakerRegistry.byId(speakerId);
    if (!profile || profile.isWearer) continue;
    try {
      const insights = await generateForSpeaker(profile.name, profile.tag, profile.facts, transcript);
      if (insights) {
        speakerRegistry.setInsights(
          speakerId,
          insights.recap,
          insights.actionItems.slice(0, MAX_ACTION_ITEMS),
          insights.facts.slice(0, MAX_FACTS),
          sessionId,
        );
      }
    } catch (error) {
      console.warn(`speaker insights failed for ${profile.name}: ${error}`);
    }
  }
}

function buildTranscript(segments: SegmentLine[]): string {
  const names = new Map<number, string>();
  for (const profile of speakerRegistry.all()) {
    names.set(profile.id, profile.isWearer ? `${profile.name} (the wearer)` : profile.name);
  }
  const lines = segments.map((line) => {
    const who = line.speakerId !== null ? (names.get(line.speakerId) ?? "Speaker") : "Speaker";
    return `${who}: ${line.text}`;
  });
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the end of the conversation: goodbyes and plans (the action items)
    // cluster there, and the recap should reflect where things landed.
    text = "..." + text.slice(text.length - MAX_TRANSCRIPT_CHARS);
  }
  return text;
}

type SpeakerInsights = { recap: string; actionItems: string[]; facts: string[] };

function generateForSpeaker(
  name: string,
  notes: string,
  existingFacts: string[],
  transcript: string,
): Promise<SpeakerInsights | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: SpeakerInsights | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), GENERATION_TIMEOUT_MS);
    try {
      streamLocalQwen({
        apiKey: "",
        model: "local",
        system:
          "You maintain a contact's conversation memory for a live-captioning app. " +
          "From the transcript, produce for the named person: a recap of this conversation " +
          "(1-2 sentences), the concrete action items agreed or requested in it (things to do, " +
          "send, or follow up on — empty if none), and an updated list of short facts about the " +
          "person (job, family, interests, plans, preferences). Merge the previously known facts " +
          "with anything new from the transcript; drop duplicates and anything now outdated. " +
          "Never invent details that are not supported by the notes, known facts, or transcript. " +
          'Reply with ONLY a JSON object: {"recap": "...", "actionItems": ["..."], "facts": ["..."]}.',
        messages: [
          {
            role: "user",
            content:
              `Person: ${name}\n` +
              (notes ? `Contact notes: ${notes}\n` : "") +
              `Previously known facts: ${existingFacts.length ? JSON.stringify(existingFacts) : "(none)"}\n\n` +
              `# Transcript\n${transcript}`,
          },
        ],
        maxTokens: 350,
        onDone: (result) => {
          clearTimeout(timer);
          finish(parseInsights(result.text));
        },
        onError: (message) => {
          clearTimeout(timer);
          console.warn(`speaker insights model error: ${message}`);
          finish(null);
        },
      });
    } catch (error) {
      clearTimeout(timer);
      console.warn(`speaker insights request failed: ${error}`);
      finish(null);
    }
  });
}

/** Parse the model's reply leniently: the first {...} block wins. */
export function parseInsights(reply: string): SpeakerInsights | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    const recap = String(parsed.recap ?? "").trim();
    if (!recap) return null;
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
    return { recap, actionItems: list(parsed.actionItems), facts: list(parsed.facts) };
  } catch {
    return null;
  }
}
