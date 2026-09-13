/**
 * THE RING'S SLEEP STAGE-TYPE IDS — the single place the 0-3 -> stage mapping
 * is decided. If this ever turns out wrong, this file is the whole fix.
 *
 * ## What the ring sends
 *
 * A `06:01` sleep record carries two independent descriptions of the same
 * night (see the protocol decode, section 6):
 *
 *   1. Five NAMED per-stage totals at fixed byte offsets - `total_time`,
 *      `wake_time`, `rem_time`, `light_time`, `deep_time`. These are named,
 *      not guessed: the decode reproduced a whole exported row byte-for-byte
 *      from them, so a percentage computed from these fields needs no mapping
 *      at all and is not affected by anything in this file.
 *
 *   2. A segment array of `[stage_type, half_minutes]` pairs - the hypnogram,
 *      the shape of the night. `stage_type` is a raw 0-3 id, and *which* id is
 *      which stage was the open question this file answers.
 *
 * So: STAGE PERCENTAGES DO NOT DEPEND ON THIS MAPPING. Only the hypnogram
 * strip does. `health-derive.ts` computes percentages from the named totals
 * and never consults `STAGE_NAME_BY_ID` for them.
 *
 * ## How the mapping was determined
 *
 * The implementation return doc listed this as guess #3 - "never cracked",
 * expected to need a live-hardware comparison against Even's own app after a
 * night's sleep. It did not, because that comparison was already sitting in
 * the exported history: the export IS Even's app's own report, and its
 * `rem_time`/`light_time`/`deep_time`/`wake_time` columns are Even's own
 * labels for the same night whose raw segment array sits in the same row.
 *
 * Cross-check performed 2026-09-10 over all 34 exported sessions: for each
 * session, sum `half_minutes * 30` per stage id and ask which named total it
 * equals.
 *
 *   stage id 0 -> wake_time    34/34 sessions, no other total matched
 *   stage id 1 -> rem_time     34/34 sessions, no other total matched
 *   stage id 2 -> light_time   34/34 sessions, no other total matched
 *   stage id 3 -> deep_time    34/34 sessions, no other total matched
 *
 * Not one session produced an ambiguous match (an id equalling two totals) or
 * an unmatched id, and the decode's own sum identity
 * (`sum(half_minutes) * 30 == total_time + wake_time`) held in all 34.
 *
 * ## Why it is still marked unconfirmed
 *
 * `STAGE_MAPPING_CONFIRMED` stays `false` until the same result is seen on a
 * record faceclaw decoded off the wire ITSELF, rather than one Even's app
 * exported. The arithmetic above is strong evidence about what the *ids mean*,
 * but every session it was computed from reached the CSV through Even's app,
 * so it cannot rule out that the app relabels ids on the way in. That is a
 * narrow doubt, and the live check Chris planned still closes it in one night.
 *
 * While this is `false` the UI labels the hypnogram as unconfirmed rather than
 * asserting "this band is REM"; see `health-chart.ts`. Flipping it to `true`
 * is the whole of the change once a live record agrees.
 */

export type SleepStageName = "wake" | "rem" | "light" | "deep";

/** Raw `stage_type` id -> stage. See this file's header for the evidence. */
export const STAGE_NAME_BY_ID: Readonly<Record<number, SleepStageName>> = {
  0: "wake",
  1: "rem",
  2: "light",
  3: "deep",
};

/**
 * False until a record faceclaw decoded off the wire itself confirms the
 * mapping above. Read by the UI, which softens its stage labels while it is
 * false. Flip to `true` after a live cross-check agrees.
 */
export const STAGE_MAPPING_CONFIRMED = false;

/** The order stages are stacked/listed in, deepest sleep last. */
export const STAGE_DISPLAY_ORDER: readonly SleepStageName[] = ["wake", "rem", "light", "deep"];

export function stageNameForId(stageId: number): SleepStageName | null {
  return STAGE_NAME_BY_ID[stageId] ?? null;
}

/** Human label for a stage, hedged while the mapping is unconfirmed. */
export function stageLabel(stage: SleepStageName): string {
  const labels: Record<SleepStageName, string> = {
    wake: "Awake",
    rem: "REM",
    light: "Light",
    deep: "Deep",
  };
  return labels[stage];
}
