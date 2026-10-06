/**
 * The T3 Code thread list as the Glanceboard shows it: the T3 worker builds
 * this snapshot from its live connections and publishes it through the
 * host's worker-state channel; the T3 Code widget paints it on the main
 * thread. Plain JSON (it crosses postMessage) with timestamps rather than
 * formatted ages, so the widget's "5m" is right whenever it paints.
 *
 * No NativeScript imports: this module is bundled into the worker as well.
 */
import {
  isThreadUnread,
  sectionThreads,
  threadActivityMs,
  threadStatus,
  type T3ThreadShell,
  type T3ThreadStatus,
} from "./t3-model";

/** Worker-state key the T3 worker publishes its snapshot under. */
export const T3_GLANCE_STATE_KEY = "t3code:threads";

/** More than a double-height slot can show; the widget says how many it left out. */
const MAX_ROWS = 24;

export type T3GlanceRow = {
  /** Environment id + thread id. */
  key: string;
  title: string;
  status: T3ThreadStatus;
  /** A run finished since the thread was last visited (on any T3 client). */
  unread: boolean;
  /** For approvals: what kind ("command", "file-change", ...). */
  requestKind: string | null;
  /** Last activity, epoch ms (server clock). */
  activityMs: number;
};

export type T3GlanceSnapshot = {
  /** Any environment is paired. */
  configured: boolean;
  /** Why there is nothing to show when no environment is connected ("Connecting…", ...); "" otherwise. */
  status: string;
  needsYou: number;
  working: number;
  /** Needs-you first, then working, then recent; settled and snoozed threads left out. */
  rows: T3GlanceRow[];
  /** Listed threads beyond `rows`. */
  more: number;
};

export type T3GlanceEnvironment = {
  id: string;
  ready: boolean;
  /** "connecting", "retrying", "auth-failed", ... (T3EnvironmentClient phase). */
  phase: string;
  enabled: boolean;
  threads: Iterable<T3ThreadShell>;
};

export function buildGlanceSnapshot(environments: readonly T3GlanceEnvironment[], nowMs: number): T3GlanceSnapshot {
  const owner = new Map<T3ThreadShell, string>();
  for (const environment of environments) {
    if (!environment.ready) continue;
    for (const thread of environment.threads) owner.set(thread, environment.id);
  }
  const sections = sectionThreads(owner.keys(), nowMs);
  const listed = [...sections.attention, ...sections.working, ...sections.recent];
  const rows = listed.slice(0, MAX_ROWS).map((thread): T3GlanceRow => {
    const status = threadStatus(thread);
    return {
      key: `${owner.get(thread)}:${thread.id}`,
      title: thread.title || "Untitled",
      status,
      unread: isThreadUnread(thread),
      requestKind: status === "approval" ? (thread.pendingRuntimeRequest?.kind ?? null) : null,
      activityMs: threadActivityMs(thread),
    };
  });
  return {
    configured: environments.length > 0,
    status: environments.some((environment) => environment.ready) ? "" : environmentsStatus(environments),
    needsYou: sections.attention.length,
    working: sections.working.filter((thread) => threadStatus(thread) === "working").length,
    rows,
    more: listed.length - rows.length,
  };
}

function environmentsStatus(environments: readonly T3GlanceEnvironment[]): string {
  if (!environments.length) return "";
  if (environments.every((environment) => !environment.enabled)) return "Disconnected";
  if (environments.some((environment) => environment.phase === "connecting" || environment.phase === "connected")) return "Connecting…";
  if (environments.every((environment) => !environment.enabled || environment.phase === "auth-failed")) return "Pair again in the T3 Code app";
  return "Can't reach T3 Code";
}

/** "1 needs you · 2 working" (or "" when neither). */
export function glanceSummary(snapshot: Pick<T3GlanceSnapshot, "needsYou" | "working">): string {
  return [
    snapshot.needsYou ? `${snapshot.needsYou} need${snapshot.needsYou === 1 ? "s" : ""} you` : "",
    snapshot.working ? `${snapshot.working} working` : "",
  ].filter(Boolean).join(" · ");
}
