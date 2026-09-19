import { Utils } from "@nativescript/core";

import { isLocalModelReady, streamLocalQwen } from "../../native/llama";
import type { LlmStreamHandle } from "../../assistant/llm-protocol";
import { parseConversationQuery } from "../../phone-ui/conversation-search";

declare const com: any;

/**
 * Question answering over saved conversations with the on-phone LLM (the
 * assistant's Qwen model). Retrieval-then-read: the question is parsed for
 * date/emotion filters and keywords, matching transcript segments and
 * session/speaker metadata are pulled from the conversation store, and the
 * model answers strictly from that context. Everything stays on-device.
 */

// Qwen runs with a 4096-token context; leave room for the answer.
const MAX_CONTEXT_CHARS = 7000;
const MAX_KEYWORDS = 6;
const SEGMENTS_PER_KEYWORD = 30;
const RECENT_SEGMENT_LIMIT = 120;
const SESSION_LIMIT = 20;

const KEYWORD_STOPWORDS = new Set(
  ("the a an and or but of in on at to from with about for was were is are am be been did do does have has had " +
    "what when where who whom whose which why how tell show me my i we us our you your they them their it its " +
    "that this these those there anyone someone something anything talk talked talking say said saying speak spoke " +
    "conversation conversations chat chats discussion discussions transcript transcripts recording recordings").split(" "),
);

export type ConversationAnswerCallbacks = {
  onDelta?: (textSoFar: string) => void;
  onDone: (answer: string, contextNote: string) => void;
  onError: (message: string) => void;
};

export function conversationQaAvailable(): boolean {
  return global.isAndroid && isLocalModelReady();
}

function store(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

type SegmentRow = {
  id: number;
  sessionId: number;
  speakerId: number | null;
  startedAt: number;
  text: string;
  translation: string;
  emotion: string;
  sentiment: number;
};

function parseSegments(json: string): SegmentRow[] {
  return (JSON.parse(json) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    sessionId: Number(row.sessionId ?? 0),
    speakerId: row.speakerId === null ? null : Number(row.speakerId),
    startedAt: Number(row.startedAt),
    text: String(row.text ?? ""),
    translation: String(row.translation ?? ""),
    emotion: String(row.emotion ?? ""),
    sentiment: Number(row.sentiment ?? 0),
  }));
}

function keywords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const word = raw.trim();
    if (word.length < 3 || KEYWORD_STOPWORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= MAX_KEYWORDS) break;
  }
  return [...seen];
}

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Assemble the retrieval context: speaker roster (names, tags, wearer flag),
 * session metadata, and the transcript lines most relevant to the question.
 * Returns the context text plus a short human-readable note about coverage.
 */
function buildContext(question: string): { context: string; note: string } {
  const filters = parseConversationQuery(question);
  const filterJson: Record<string, unknown> = {};
  if (filters.sinceMs !== null) filterJson.sinceMs = filters.sinceMs;
  if (filters.untilMs !== null) filterJson.untilMs = filters.untilMs;
  if (filters.emotion !== null) filterJson.emotion = filters.emotion;

  const speakerNames = new Map<number, string>();
  const speakerLines: string[] = [];
  for (const row of JSON.parse(String(store().querySpeakers())) as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    const name = String(row.name ?? "");
    speakerNames.set(id, name);
    const parts = [name];
    if (row.isWearer) parts.push("(the wearer/user)");
    if (row.tag) parts.push(`tag: ${String(row.tag)}`);
    parts.push(`${Number(row.segmentCount ?? 0)} lines heard`);
    speakerLines.push(`- ${parts.join(", ")}`);
  }

  const sessions = JSON.parse(
    String(store().querySessions(JSON.stringify({ ...filterJson, limit: SESSION_LIMIT }))),
  ) as Array<Record<string, unknown>>;
  const sessionTitles = new Map<number, string>();
  const sessionLines: string[] = [];
  for (const row of sessions) {
    const id = Number(row.id);
    const title = String(row.title ?? "") || `Conversation ${formatWhen(Number(row.startedAt))}`;
    sessionTitles.set(id, title);
    const who = ((row.speakers as Array<{ name?: unknown }>) ?? [])
      .map((speaker) => String(speaker.name ?? ""))
      .filter(Boolean)
      .join(", ");
    sessionLines.push(
      `- [#${id}] ${title} — ${formatWhen(Number(row.startedAt))}, ${Number(row.segmentCount ?? 0)} lines` +
        (who ? `, speakers: ${who}` : "") +
        `, overall sentiment ${Number(row.avgSentiment ?? 0).toFixed(2)}`,
    );
  }

  const terms = keywords(filters.text);
  const segmentMap = new Map<number, SegmentRow>();
  if (terms.length > 0) {
    for (const term of terms) {
      const rows = parseSegments(
        String(
          store().searchSegments(
            JSON.stringify({ ...filterJson, query: term, limit: SEGMENTS_PER_KEYWORD }),
          ),
        ),
      );
      for (const row of rows) segmentMap.set(row.id, row);
    }
  }
  if (segmentMap.size === 0) {
    // No keyword hits (or no keywords): fall back to the filtered recents so
    // summary-style questions still have material to read.
    for (const row of parseSegments(
      String(store().searchSegments(JSON.stringify({ ...filterJson, limit: RECENT_SEGMENT_LIMIT }))),
    )) {
      segmentMap.set(row.id, row);
    }
  }

  const segments = [...segmentMap.values()].sort((a, b) => a.startedAt - b.startedAt);
  const excerptLines: string[] = [];
  let currentSession = -1;
  for (const segment of segments) {
    if (segment.sessionId !== currentSession) {
      currentSession = segment.sessionId;
      excerptLines.push(`\n## ${sessionTitles.get(currentSession) ?? `Conversation #${currentSession}`}`);
    }
    const speaker =
      segment.speakerId !== null ? (speakerNames.get(segment.speakerId) ?? "Speaker") : "Speaker";
    const emotion = segment.emotion && segment.emotion !== "neutral" ? ` [${segment.emotion}]` : "";
    excerptLines.push(`[${formatWhen(segment.startedAt)}] ${speaker}${emotion}: ${segment.text}`);
    if (segment.translation) excerptLines.push(`  (translated: ${segment.translation})`);
  }

  let context =
    `# Known speakers\n${speakerLines.join("\n") || "(none yet)"}\n\n` +
    `# Conversations${filters.sinceMs !== null || filters.emotion !== null ? " (filtered by the question)" : ""}\n` +
    `${sessionLines.join("\n") || "(none in range)"}\n\n` +
    `# Transcript excerpts\n${excerptLines.join("\n") || "(no matching lines)"}`;
  let truncated = false;
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS);
    truncated = true;
  }
  const note =
    `${sessions.length} conversation${sessions.length === 1 ? "" : "s"}, ` +
    `${segments.length} transcript line${segments.length === 1 ? "" : "s"} consulted` +
    (terms.length ? ` (keywords: ${terms.join(", ")})` : "") +
    (truncated ? "; context truncated to fit the on-device model" : "");
  return { context, note };
}

/**
 * Ask the on-device model a question about saved conversations. Returns a
 * cancel handle; the answer streams via onDelta and lands in onDone with a
 * note describing what data was consulted.
 */
export function askConversations(
  question: string,
  callbacks: ConversationAnswerCallbacks,
): LlmStreamHandle {
  if (!conversationQaAvailable()) {
    setTimeout(
      () =>
        callbacks.onError(
          "The on-phone model isn't downloaded yet — enable it under Settings > Assistant on the glasses.",
        ),
      0,
    );
    return { cancel: () => {} };
  }
  let context: { context: string; note: string };
  try {
    context = buildContext(question);
  } catch (error) {
    setTimeout(() => callbacks.onError(`Could not read the conversation store: ${String(error)}`), 0);
    return { cancel: () => {} };
  }
  return streamLocalQwen({
    apiKey: "",
    model: "local",
    system:
      "You answer questions about the user's saved conversations, captured by their smart glasses. " +
      "Use ONLY the provided speaker roster, conversation list, and transcript excerpts. " +
      "Cite conversations by their title and date when referencing them. " +
      "If the provided data does not contain the answer, say so plainly rather than guessing. " +
      "Transcript sentiment scores range -1 (very negative) to 1 (very positive); " +
      "bracketed words after a speaker's name are detected emotional tones. " +
      `Today's date is ${formatWhen(Date.now())}.`,
    messages: [
      {
        role: "user",
        content: `${context.context}\n\n# Question\n${question.trim()}`,
      },
    ],
    maxTokens: 400,
    onTextDelta: (_delta, textSoFar) => callbacks.onDelta?.(textSoFar),
    onDone: (result) => callbacks.onDone(result.text.trim(), context.note),
    onError: (message) => callbacks.onError(message),
  });
}
