import { type CueDraft, type CueKind } from "./aside-session";

const CUE_FIELD = /^[\s*_#>-]*(KIND|CUE|MORE|SCORE)[\s*_]*[:：][\s*_]*(.*)$/i;
const KINDS: readonly CueKind[] = ["answer", "recall", "explain", "check", "suggest"];
/** A headline past this won't read at a glance, whatever the model was told. */
const MAX_HEADLINE_CHARS = 100;

function cleanLine(text: string): string {
  return text.replace(/[*`]/g, "").replace(/^["“'\s]+|["”'\s]+$/g, "");
}

/** Cut an overlong headline at a word, keeping the whole of it in the detail. */
function fitHeadline(headline: string, detail: string): { headline: string; detail: string } {
  if (headline.length <= MAX_HEADLINE_CHARS) return { headline, detail };
  const cut = headline.slice(0, MAX_HEADLINE_CHARS).replace(/\s+\S*$/, "");
  return { headline: `${cut}...`, detail: [headline, detail].filter(Boolean).join(" ") };
}

/**
 * A cue reply (see ASIDE_CUE_SYSTEM_PROMPT), or null for NONE or anything
 * without a cue in it. A missing or unreadable score is 0, which fails every
 * bar: an unreadable reply stays silent.
 */
export function parseCueReply(reply: string): CueDraft | null {
  const fields: Record<string, string> = {};
  let field = "";
  for (const line of reply.split("\n")) {
    const match = CUE_FIELD.exec(line);
    if (match) {
      field = match[1]!.toLowerCase();
      fields[field] = match[2]!.trim();
    } else if (field === "more" && line.trim()) {
      fields.more += ` ${line.trim()}`;
    }
  }
  const headline = cleanLine(fields.cue ?? "");
  if (!headline || /^none\b/i.test(headline)) return null;
  const kind = (fields.kind ?? "").replace(/[^a-z]/gi, "").toLowerCase() as CueKind;
  const score = Number.parseFloat(fields.score ?? "");
  return {
    kind: KINDS.includes(kind) ? kind : "note",
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0,
    ...fitHeadline(headline, cleanLine(fields.more ?? "")),
  };
}

/**
 * A reply to a request from the wearer, which should say something even if the
 * model lost the format. Null only for NONE or an empty reply.
 */
export function parseRequestedCueReply(reply: string): CueDraft | null {
  const parsed = parseCueReply(reply);
  if (parsed) return parsed;
  const text = cleanLine(reply.replace(/\s+/g, " "));
  if (!text || /^none\b/i.test(text)) return null;
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return { kind: "note", score: 0, ...fitHeadline(sentence, text.slice(sentence.length).trim()) };
}

const RECAP_HEADINGS: Record<string, string> = {
  "SUMMARY": "Summary",
  "KEY POINTS": "Key points",
  "DECISIONS": "Decisions",
  "ACTION ITEMS": "Action items",
  "OPEN QUESTIONS": "Open questions",
};

export type RecapLine = { text: string; heading: boolean };

export type Recap = { title: string; lines: RecapLine[] };

/** A recap reply (see ASIDE_RECAP_SYSTEM_PROMPT), complete or still streaming. */
export function parseRecap(reply: string): Recap {
  let title = "";
  const lines: RecapLine[] = [];
  for (const raw of reply.split("\n")) {
    const line = raw.replace(/^[\s#*]+|[\s*]+$/g, "");
    if (!line) continue;
    const titled = /^TITLE\s*:\s*(.*)$/i.exec(line);
    if (titled) {
      title = titled[1]!.trim();
      continue;
    }
    const heading = RECAP_HEADINGS[line.replace(/:$/, "").toUpperCase()];
    lines.push(heading ? { text: heading, heading: true } : { text: raw.trim(), heading: false });
  }
  return { title, lines };
}

/** A recap as Markdown sections, for saving. */
export function recapMarkdown(recap: Recap): string {
  return recap.lines
    .map((line, index) => (line.heading ? `${index ? "\n" : ""}## ${line.text}\n` : line.text))
    .join("\n");
}
