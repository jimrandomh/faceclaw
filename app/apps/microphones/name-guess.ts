/**
 * Introduction-based speaker naming: when a caption line
 * contains a spoken introduction, the auto-numbered
 * "Speaker N" profile it belongs to can be renamed without the user typing
 * anything. Two shapes are recognized:
 *
 * - Self-introduction ("I'm Alice", "my name is Alice") — names the speaker
 *   of the line itself.
 * - Third-party introduction ("this is Bob", "meet Bob") — pends the name
 *   and applies it to the next DIFFERENT still-generic speaker heard.
 *
 * Names inferred from speech are suggestions applied only to still-generic
 * profiles; a name the user set (or a prior inference) is never overwritten.
 * Pure module: no platform imports.
 */

import { isKnownFirstName } from "./name-data";

export type NameInference = { name: string; kind: "self" | "third-party" };

// Words that commonly follow "I'm ..." / "this is ..." without being names.
// Lowercase; candidates are checked case-insensitively against this list (ASR
// capitalization is unreliable, so "I'm Hungry" must fail like "I'm hungry").
// The list is deliberately broad — a rejected real introduction costs one
// manual rename, while a false positive mislabels a person in every caption.
const NOT_NAMES = new Set([
  // Function words, intensifiers, hedges.
  ..."not no yes so just really very too quite pretty almost about kind sort still always never now then here there back home away the a an in on at all both only even also again once maybe probably definitely honestly actually literally basically totally"
    .split(" "),
  // States and feelings ("I'm hungry", "I'm exhausted").
  ..."sure sorry afraid good fine okay ok great well better worse bad happy sad glad mad angry upset annoyed frustrated tired exhausted sleepy awake hungry thirsty starving full sick ill healthy cold hot warm freezing boiling excited nervous anxious worried scared terrified confused surprised shocked impressed disappointed proud grateful thankful jealous embarrassed ashamed bored curious serious certain positive confident comfortable uncomfortable ready busy free late early lost stuck broke rich famous lucky unlucky alone single married engaged divorced retired unemployed pregnant alive dead"
    .split(" "),
  // Progressive verbs ("I'm wanting", "I'm heading out").
  ..."gonna going wanting hoping waiting wondering thinking trying getting feeling speaking calling recording sending listening watching looking asking telling saying talking hearing working walking running driving flying riding leaving arriving staying coming moving heading starting stopping finishing planning meeting eating drinking cooking cleaning shopping packing visiting traveling studying learning teaching reading writing playing singing dancing sleeping dreaming waking standing sitting laughing crying kidding joking guessing counting checking testing building making taking giving putting buying selling paying saving spending losing winning helping"
    .split(" "),
  // Descriptors that read as predicates, not names.
  ..."new old young tall short big small huge tiny first last next early done finished set open closed right wrong left in out off on up down over under behind ahead around through outside inside upstairs downstairs downtown"
    .split(" "),
  // Exclamations and judgments ("this is Ridiculous", "this is Awesome").
  ..."awesome amazing ridiculous terrible horrible incredible impossible important interesting boring crazy insane weird strange funny hilarious perfect beautiful gorgeous wonderful fantastic excellent brilliant stupid dumb silly annoying confusing exciting embarrassing frustrating disappointing surprising shocking unbelievable outrageous obvious delicious gross disgusting nasty cool nice sweet cute lovely fair unfair true false real fake normal typical classic official final original actual exact simple easy hard difficult complicated expensive cheap heavy light loud quiet fast slow safe dangerous risky enough everything nothing something anything everyone nobody someone anyone mine yours hers theirs ours it that this what how why where who when"
    .split(" "),
]);

// Suffixes that mark ordinary adjectives, not given names ("Ridiculous",
// "Wonderful", "Believable"). Kept narrow: common name endings like "-ly"
// (Emily, Kelly) and "-ing" (Ming, Qing) are deliberately NOT here — those
// rely on the word list and the LLM tier instead.
const NON_NAME_SUFFIXES = ["ous", "ful", "less", "able", "ible"];

// Trigger phrases match either sentence case; the captured NAME must be
// capitalized (ASR renders proper nouns capitalized, and this rejects
// ordinary words after "I'm ...").
const NAME = "([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)";
const SELF_PATTERNS = [
  new RegExp(`\\b[Mm]y name is ${NAME}`),
  new RegExp(`\\b[Ii](?:'| a)m ${NAME}`),
  new RegExp(`\\b[Cc]all me ${NAME}`),
  new RegExp(`\\b[Tt]his is ${NAME} speaking\\b`),
];

const THIRD_PARTY_PATTERNS = [
  new RegExp(`\\b[Tt]his is ${NAME}`),
  new RegExp(`\\b(?:[Mm]eet|[Ss]ay hi to|[Ss]ay hello to) ${NAME}`),
  new RegExp(`\\b[Hh]is name is ${NAME}`),
  new RegExp(`\\b[Hh]er name is ${NAME}`),
  new RegExp(`\\b[Tt]heir name is ${NAME}`),
];

function plausibleName(candidate: string): string | null {
  const words = candidate.trim().split(/\s+/);
  if (words.length === 0 || words.length > 2) return null;
  for (const word of words) {
    if (word.length < 2 || word.length > 20) return null;
    const lower = word.toLowerCase();
    // NOT_NAMES wins even over the known-names dataset: words like "Rich"
    // and "Young" ARE real given names, but "I'm rich" is far more often a
    // predicate, and a false positive mislabels a person in every caption.
    if (NOT_NAMES.has(lower)) return null;
    // The suffix rule, by contrast, defers to the dataset — it exists to
    // catch adjectives ("Ridiculous"), and it wrongly rejects real names
    // like Precious, Demetrious, and Octavious without this carve-out.
    if (
      !isKnownFirstName(word) &&
      NON_NAME_SUFFIXES.some((suffix) => lower.length > suffix.length + 2 && lower.endsWith(suffix))
    ) {
      return null;
    }
    if (!/^[A-Z]/.test(word)) return null;
  }
  return words.join(" ");
}

/**
 * Whether an inferred name's given name (its first word — a second word is
 * a surname the first-name dataset can't know) appears in the known-names
 * dataset. Positive signal only: known names can skip the slower LLM
 * verification, but absence never rejects — real names the dataset misses
 * (non-Anglophone names especially) still go through the normal path.
 */
export function isKnownName(candidate: string): boolean {
  const first = candidate.trim().split(/\s+/)[0];
  return first ? isKnownFirstName(first) : false;
}

/**
 * Detect a spoken introduction in one caption line. Self-introductions win
 * over third-party shapes ("this is Alice speaking" is a self-intro even
 * though "this is Alice" also matches the third-party pattern).
 */
export function inferIntroducedName(text: string): NameInference | null {
  if (!text) return null;
  for (const pattern of SELF_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const name = plausibleName(match[1]!);
      if (name) return { name, kind: "self" };
    }
  }
  for (const pattern of THIRD_PARTY_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const name = plausibleName(match[1]!);
      if (name) return { name, kind: "third-party" };
    }
  }
  return null;
}

/** True for the auto-assigned "Speaker N" names (safe to overwrite). */
export function isGenericSpeakerName(name: string): boolean {
  return /^Speaker \d+$/.test(name.trim());
}

export type PendingIntroduction = { name: string; bySpeakerId: number; atMs: number };

/** How long a third-party introduction waits for its subject to speak. */
export const PENDING_INTRODUCTION_TTL_MS = 2 * 60 * 1000;

/**
 * Whether a pending third-party introduction applies to a newly heard
 * speaker: someone OTHER than the introducer, still generically named,
 * speaking within the window.
 */
export function pendingApplies(
  pending: PendingIntroduction,
  speakerId: number,
  speakerName: string,
  nowMs: number,
): boolean {
  if (nowMs - pending.atMs > PENDING_INTRODUCTION_TTL_MS) return false;
  if (speakerId === pending.bySpeakerId) return false;
  return isGenericSpeakerName(speakerName);
}
