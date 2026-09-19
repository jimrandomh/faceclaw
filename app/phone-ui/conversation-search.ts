import { inferredEmotionFilter, type EmotionLabel } from "../apps/microphones/sentiment";
import { NON_WORD_RUN } from "../util/unicode-class";

/**
 * Natural-language search parsing for the conversations list. The grammar is
 * deliberately small and lossy-safe: recognized phrases become structured
 * filters and are stripped from the query; everything left over is passed on
 * as a plain text query.
 *
 * Recognized date phrases (case-insensitive):
 *   - "past/last N hours/days/weeks/months" (N as digits, "one".."twelve",
 *     "a"/"an", "couple (of)", "few"; N omitted means 1), with optional
 *     leading "in/over/during/from" and "the"  -> sinceMs
 *   - "today", "this week", "this month"       -> sinceMs at the period start
 *   - "yesterday"                              -> sinceMs/untilMs bracketing
 *     that day (untilMs is dropped when combined with an open-ended phrase)
 *
 * Emotion: `inferredEmotionFilter` over the date-stripped query; when it
 * names exactly one emotion, that becomes the filter and the tokens that
 * triggered it (checked as unigrams and bigrams, so "fed up" works) are
 * stripped. When any filter was recognized, connective filler words
 * ("conversations where the speaker was ...") are stripped too, so the
 * residual text query is only the meaningful content words.
 */

export type ParsedConversationQuery = {
  sinceMs: number | null;
  untilMs: number | null;
  emotion: EmotionLabel | null;
  text: string;
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
};

const UNIT_MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

const RELATIVE_RANGE_PATTERN =
  /\b(?:(?:in|over|during|from)\s+)?(?:the\s+)?(?:past|last)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few|a|an)\s+)?(hour|day|week|month)s?\b/g;

/**
 * Filler words that carry no search content once the query has been
 * understood as a filter request ("conversations where the speaker was
 * angry"). Only stripped when an emotion or date filter matched, so ordinary
 * text queries pass through untouched.
 */
const FILLER_WORDS = new Set<string>([
  "conversations", "conversation", "chats", "chat", "sessions", "session",
  "where", "when", "which", "who", "that", "whose",
  "the", "a", "an", "was", "were", "is", "are", "be", "being", "been",
  "speaker", "speakers", "someone", "anybody", "anyone", "people", "person",
  "sounded", "sounds", "felt", "feels", "feeling", "seemed", "seems",
  "show", "me", "find", "search", "list", "get", "all", "any",
  "i", "we", "they", "he", "she", "it", "you",
  "in", "of", "with", "about", "on", "at", "and", "or", "to",
  "talked", "talking", "talks", "said", "saying",
]);

function parseCount(word: string | undefined): number {
  if (!word) return 1;
  const normalized = word.replace(/\s+of$/, "").trim();
  if (/^\d+$/.test(normalized)) return Math.max(1, parseInt(normalized, 10));
  return NUMBER_WORDS[normalized] ?? 1;
}

function startOfDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function tokenize(text: string): string[] {
  return text.split(NON_WORD_RUN).filter((token) => token.length > 0);
}

export function parseConversationQuery(raw: string, nowMs: number = Date.now()): ParsedConversationQuery {
  let working = raw.toLowerCase();
  const sinceCandidates: number[] = [];
  let untilMs: number | null = null;
  let openEndedRange = false;

  working = working.replace(RELATIVE_RANGE_PATTERN, (_match, count: string | undefined, unit: string) => {
    sinceCandidates.push(nowMs - parseCount(count) * UNIT_MS[unit]!);
    openEndedRange = true;
    return " ";
  });

  if (/\byesterday\b/.test(working)) {
    const todayStart = startOfDay(nowMs);
    sinceCandidates.push(todayStart - UNIT_MS.day!);
    untilMs = todayStart;
    working = working.replace(/\byesterday\b/g, " ");
  }
  if (/\btoday\b/.test(working)) {
    sinceCandidates.push(startOfDay(nowMs));
    openEndedRange = true;
    working = working.replace(/\btoday\b/g, " ");
  }
  if (/\bthis\s+week\b/.test(working)) {
    const now = new Date(nowMs);
    sinceCandidates.push(startOfDay(nowMs) - now.getDay() * UNIT_MS.day!);
    openEndedRange = true;
    working = working.replace(/\bthis\s+week\b/g, " ");
  }
  if (/\bthis\s+month\b/.test(working)) {
    const now = new Date(nowMs);
    sinceCandidates.push(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
    openEndedRange = true;
    working = working.replace(/\bthis\s+month\b/g, " ");
  }

  // "yesterday" alone brackets that day, but combined with an open-ended
  // phrase ("yesterday and the past week") the upper bound would silently
  // hide results the other phrase asked for.
  if (openEndedRange) untilMs = null;
  const sinceMs = sinceCandidates.length > 0 ? Math.min(...sinceCandidates) : null;

  const emotion = inferredEmotionFilter(working);
  let tokens = tokenize(working);
  if (emotion) {
    const kept: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (i + 1 < tokens.length && inferredEmotionFilter(`${tokens[i]} ${tokens[i + 1]}`) === emotion) {
        i++;
        continue;
      }
      if (inferredEmotionFilter(tokens[i]!) === emotion) continue;
      kept.push(tokens[i]!);
    }
    tokens = kept;
  }

  if (emotion || sinceMs !== null) {
    tokens = tokens.filter((token) => !FILLER_WORDS.has(token));
  }

  return { sinceMs, untilMs, emotion, text: tokens.join(" ") };
}
