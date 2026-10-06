/**
 * Lays a T3 thread's timeline out as wrapped, shaded text lines for the
 * glasses: user messages dim with a "You:" lead, assistant replies bright
 * (light Markdown cleanup), tool activity as dim one-liners, approvals and
 * questions highlighted. Long runs of tool activity collapse to a count plus
 * the latest few steps, so the conversation stays readable.
 */
import { wrapText, type WrapFont } from "../../graphics/textwrap";
import { plainMarkdown, type TimelineEntry } from "./t3-model";

export type TranscriptLine = {
  text: string;
  /** Gray level 0..255. */
  value: number;
  /** Left inset in pixels. */
  indent: number;
};

/** Activity runs longer than this collapse to a count plus the last ACTIVITY_TAIL. */
const ACTIVITY_COLLAPSE_AT = 4;
const ACTIVITY_TAIL = 2;
const ACTIVITY_INDENT = 10;

const USER_VALUE = 170;
const ASSISTANT_VALUE = 240;
const ACTIVITY_VALUE = 120;
const REQUEST_VALUE = 255;
const RESOLVED_REQUEST_VALUE = 140;

type Block = { key: string; build: () => TranscriptLine[] };

/** Per-entry wrap cache: re-wrapping a long transcript on every streamed update is wasted work. */
export class TranscriptLayout {
  private cache = new Map<string, TranscriptLine[]>();
  private font: WrapFont | null = null;
  private width = 0;

  layout(entries: readonly TimelineEntry[], font: WrapFont, width: number): TranscriptLine[] {
    if (font !== this.font || width !== this.width) {
      this.cache.clear();
      this.font = font;
      this.width = width;
    }
    const next = new Map<string, TranscriptLine[]>();
    const lines: TranscriptLine[] = [];
    for (const block of blocks(entries, font, width)) {
      let built = this.cache.get(block.key);
      if (!built) built = block.build();
      next.set(block.key, built);
      if (lines.length) lines.push({ text: "", value: 0, indent: 0 });
      lines.push(...built);
    }
    this.cache = next;
    return lines;
  }
}

function wrapped(font: WrapFont, text: string, width: number, value: number, indent = 0): TranscriptLine[] {
  return wrapText(font, text, Math.max(1, width - indent)).map((line) => ({ text: line, value, indent }));
}

function activityLine(font: WrapFont, entry: Extract<TimelineEntry, { kind: "activity" }>, width: number): TranscriptLine[] {
  const suffix = entry.state === "running" ? " …" : entry.state === "failed" ? " (failed)" : entry.state === "stopped" ? " (stopped)" : "";
  const text = `· ${entry.label}${entry.detail ? `  ${entry.detail}` : ""}${suffix}`;
  // One line each: activity is context, not content.
  const [first] = wrapText(font, text, Math.max(1, width - ACTIVITY_INDENT));
  const line = first ?? "";
  const truncated = line.length < text.length ? `${line.replace(/\s+$/, "")}…` : line;
  return [{ text: truncated, value: entry.state === "failed" ? 170 : ACTIVITY_VALUE, indent: ACTIVITY_INDENT }];
}

function blocks(entries: readonly TimelineEntry[], font: WrapFont, width: number): Block[] {
  const result: Block[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind === "activity") {
      // A run of consecutive activity rows forms one block.
      const run: Array<Extract<TimelineEntry, { kind: "activity" }>> = [];
      while (index < entries.length && entries[index]!.kind === "activity") {
        run.push(entries[index] as Extract<TimelineEntry, { kind: "activity" }>);
        index++;
      }
      const key = `activity:${run.map((item) => `${item.id}|${item.state}|${item.label}|${item.detail}`).join("\n")}`;
      result.push({
        key,
        build: () => {
          if (run.length < ACTIVITY_COLLAPSE_AT) return run.flatMap((item) => activityLine(font, item, width));
          const hidden = run.length - ACTIVITY_TAIL;
          const failed = run.slice(0, hidden).filter((item) => item.state === "failed").length;
          return [
            { text: `· ${hidden} earlier steps${failed ? ` (${failed} failed)` : ""}`, value: ACTIVITY_VALUE - 20, indent: ACTIVITY_INDENT },
            ...run.slice(hidden).flatMap((item) => activityLine(font, item, width)),
          ];
        },
      });
      continue;
    }
    index++;
    switch (entry.kind) {
      case "user":
        result.push({
          key: `user:${entry.id}:${entry.text}`,
          build: () => wrapped(font, `${entry.queued ? "You (queued)" : "You"}: ${entry.text.trim()}`, width, USER_VALUE),
        });
        break;
      case "assistant":
        result.push({
          key: `assistant:${entry.id}:${entry.streaming}:${entry.text}`,
          build: () => {
            const text = plainMarkdown(entry.text);
            const lines = text ? wrapped(font, text, width, ASSISTANT_VALUE) : [];
            if (entry.streaming) lines.push({ text: "…", value: ASSISTANT_VALUE, indent: 0 });
            return lines;
          },
        });
        break;
      case "request":
        result.push({
          key: `request:${entry.id}:${entry.resolved}:${entry.detail}`,
          build: () => {
            const value = entry.resolved ? RESOLVED_REQUEST_VALUE : REQUEST_VALUE;
            const lines = wrapped(font, `${entry.resolved ? "" : "→ "}${entry.label}${entry.resolved ? " (answered)" : ""}`, width, value);
            if (entry.detail) lines.push(...wrapped(font, entry.detail, width, entry.resolved ? ACTIVITY_VALUE : 210, ACTIVITY_INDENT));
            return lines;
          },
        });
        break;
    }
  }
  return result;
}
