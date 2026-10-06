/**
 * Client-side state for T3 Code's orchestration (v2) streams, independent of
 * transport and rendering: the shell (projects + thread list) reducer, the
 * per-thread detail reducer, thread status / ordering for the glasses list,
 * one-line summaries of timeline items, and the dispatch-command builders.
 *
 * Mirrors T3's own client runtime (packages/client-runtime/src/state/
 * shellReducer.ts, orchestrationV2Projection.ts, models.ts; apps/mobile's
 * threadListV2.ts and threadActivity.ts) in reduced form. Wire objects are
 * typed loosely: only the fields read here are declared, and everything is
 * treated as possibly missing so newer/older servers degrade gracefully.
 */

// ---------------------------------------------------------------------------
// Wire shapes (subset)

export type T3ProjectShell = {
  id: string;
  title: string;
  workspaceRoot?: string;
  defaultModelSelection?: T3ModelSelection | null;
};

export type T3ModelSelection = { instanceId: string; model: string; options?: unknown[] };

export type T3ThreadShell = {
  id: string;
  projectId: string;
  title: string;
  providerInstanceId?: string | null;
  modelSelection?: T3ModelSelection | null;
  status?: string;
  activityRunStatus?: string | null;
  activeRunId?: string | null;
  latestRunId?: string | null;
  activeProviderThreadId?: string | null;
  latestRunRequestedAt?: string | null;
  latestRunCompletedAt?: string | null;
  lastVisitedAt?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string; createdAt?: string } | null;
  pendingBackgroundTasks?: Array<{ kind?: string }>;
  lastError?: string | null;
  lastErrorClass?: string | null;
  usageLimitResetAt?: string | null;
  latestUserMessageAt?: string | null;
  latestUserAuthoredMessageAt?: string | null;
  hasActionableProposedPlan?: boolean;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledOverride?: string | null;
  settledAt?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  lineage?: { relationshipToParent?: string | null } | null;
};

export type T3Run = {
  id: string;
  status: string;
  userMessageId?: string | null;
  requestedAt?: string | null;
  queuePosition?: number | null;
};

export type T3RunAttempt = { id: string; runId: string; rootNodeId?: string | null; status: string };

export type T3RuntimeRequest = {
  id: string;
  kind: string;
  status: string;
  responseCapability?: { type: string } | null;
};

export type T3ConversationMessage = {
  id: string;
  role?: string;
  text?: string;
  delegatedCompletion?: unknown;
  notification?: unknown;
};

export type T3PlanStep = { id?: string; text: string; status: string };

export type T3Plan = {
  id: string;
  kind: string;
  runId?: string | null;
  status?: string;
  steps?: T3PlanStep[];
};

export type T3ApprovalOption = { decision: string; label: string; warning?: string };

export type T3Question = {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string; value?: string }>;
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  required?: boolean;
};

/** A timeline row. Fields beyond the common ones depend on `type`. */
export type T3TurnItem = {
  id: string;
  threadId: string;
  runId: string | null;
  nodeId?: string | null;
  ordinal: number;
  status: string;
  title?: string | null;
  type: string;
  // user_message / assistant_message / reasoning
  text?: string;
  streaming?: boolean;
  inputIntent?: string;
  // command_execution
  input?: unknown;
  exitCode?: number;
  outputIndicatesFailure?: boolean;
  // file_change
  fileName?: string;
  additions?: number;
  deletions?: number;
  changes?: unknown[];
  // file_search / web_search
  pattern?: string;
  patterns?: string[];
  // dynamic_tool
  toolName?: string | null;
  // approval_request / user_input_request
  requestId?: string;
  requestKind?: string;
  prompt?: string;
  appName?: string;
  options?: T3ApprovalOption[];
  questions?: T3Question[];
  responseMode?: string;
  // notification / system_notice / run_interrupt_result
  summary?: string;
  detail?: string;
  message?: string;
  // error
  failure?: { class?: string; message?: string; code?: string | null } | null;
  // compaction
  beforeTokenCount?: number;
  afterTokenCount?: number;
  // handoff
  toModel?: string;
  // proposed_plan
  markdown?: string;
};

type ProjectedTurnItem = { visibility?: string; item: T3TurnItem };

// ---------------------------------------------------------------------------
// Shell (projects + thread list)

export class ShellModel {
  readonly projects = new Map<string, T3ProjectShell>();
  readonly threads = new Map<string, T3ThreadShell>();
  /** Last applied sequence (the resume cursor), or null before the first snapshot. */
  sequence: number | null = null;
  /** The server finished replaying and the stream is live. */
  synchronized = false;

  /** Apply one subscribeShell stream item; returns whether anything changed. */
  apply(raw: unknown): boolean {
    const item = raw as Record<string, any>;
    switch (item?.kind) {
      case "synchronized":
        this.synchronized = true;
        return true;
      case "snapshot": {
        const snapshot = item.snapshot ?? {};
        if (Array.isArray(item.resolvedRepositoryIdentityRoots)) {
          // Metadata-only refresh (carries threads: []): never a replacement.
          return false;
        }
        this.projects.clear();
        this.threads.clear();
        for (const project of snapshot.projects ?? []) this.projects.set(project.id, project);
        for (const thread of snapshot.threads ?? []) this.threads.set(thread.id, thread);
        this.sequence = typeof snapshot.snapshotSequence === "number" ? snapshot.snapshotSequence : 0;
        return true;
      }
      case "project.updated":
      case "project.removed":
      case "thread.updated":
      case "thread.removed": {
        const sequence = typeof item.sequence === "number" ? item.sequence : null;
        if (sequence !== null && this.sequence !== null && sequence <= this.sequence) return false;
        if (item.kind === "project.updated" && item.project) this.projects.set(item.project.id, item.project);
        else if (item.kind === "project.removed") this.projects.delete(item.projectId);
        else if (item.kind === "thread.updated" && item.thread) {
          if (item.location === "archive") this.threads.delete(item.thread.id);
          else this.threads.set(item.thread.id, item.thread);
        } else if (item.kind === "thread.removed") this.threads.delete(item.threadId);
        if (sequence !== null) this.sequence = sequence;
        return true;
      }
      default:
        return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Thread status and list ordering (as T3's mobile thread list derives them)

export type T3ThreadStatus =
  /** A provider approval is waiting on the user. */
  | "approval"
  /** The provider asked the user a question. */
  | "input"
  | "working"
  /** Parked on background work (subagent, monitor) that will wake it. */
  | "waiting"
  | "failed"
  /** Failed on a usage limit. */
  | "limited"
  | "ready";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const WAKING_BACKGROUND_KINDS = new Set(["subagent", "monitor", "background_task"]);

export function threadStatus(thread: T3ThreadShell): T3ThreadStatus {
  const request = thread.pendingRuntimeRequest;
  if (request && request.kind !== "user_input" && request.kind !== "auth_refresh") return "approval";
  if (request?.kind === "user_input") return "input";
  if (thread.latestRunId == null && thread.activeProviderThreadId == null) return "ready";
  const background =
    thread.status !== "failed" &&
    (thread.pendingBackgroundTasks ?? []).some((task) => WAKING_BACKGROUND_KINDS.has(task.kind ?? ""));
  const runStatus = background ? "idle" : (thread.activityRunStatus ?? thread.status ?? "idle");
  if (ACTIVE_RUN_STATUSES.has(runStatus)) return "working";
  if (runStatus === "idle") return "waiting";
  if (runStatus === "failed") return thread.lastErrorClass === "usage_limit" ? "limited" : "failed";
  return "ready";
}

export function threadStatusLabel(status: T3ThreadStatus): string {
  switch (status) {
    case "approval":
      return "Needs approval";
    case "input":
      return "Has a question";
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "failed":
      return "Failed";
    case "limited":
      return "Usage limit";
    case "ready":
      return "Ready";
  }
}

const STATUS_MARKERS: Record<T3ThreadStatus, { marker: string; value: number }> = {
  approval: { marker: "!", value: 255 },
  input: { marker: "?", value: 255 },
  working: { marker: "…", value: 210 },
  waiting: { marker: "…", value: 130 },
  failed: { marker: "x", value: 200 },
  limited: { marker: "x", value: 160 },
  ready: { marker: "", value: 0 },
};

/**
 * The one-glyph status mark drawn left of a thread title (in the app's list
 * and on the Glanceboard), with its gray level: ! approval, ? question,
 * … working, x failed, ● finished since last visited, ✓ settled.
 */
export function threadMarker(status: T3ThreadStatus, flags: { settled?: boolean; unread?: boolean } = {}): { marker: string; value: number } {
  if (status === "ready" && flags.settled) return { marker: "✓", value: 110 };
  if (status === "ready" && flags.unread) return { marker: "●", value: 220 };
  return STATUS_MARKERS[status];
}

function timeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A run finished since the user (on any client) last looked at the thread. */
export function isThreadUnread(thread: T3ThreadShell): boolean {
  const completed = timeMs(thread.latestRunCompletedAt);
  const visited = timeMs(thread.lastVisitedAt);
  return completed > 0 && visited > 0 && completed > visited;
}

export function isThreadSettled(thread: T3ThreadShell): boolean {
  return thread.settledOverride === "settled";
}

export function isThreadSnoozed(thread: T3ThreadShell, nowMs: number): boolean {
  if (timeMs(thread.snoozedUntil) <= nowMs) return false;
  // A raised hand (question, approval, failure, or a run finishing after the
  // snooze) brings it back.
  const status = threadStatus(thread);
  if (status === "approval" || status === "input" || status === "failed") return false;
  return !(timeMs(thread.latestRunCompletedAt) > timeMs(thread.snoozedAt));
}

/** Archived, deleted and provider-run subagent threads stay out of the list. */
export function isThreadListed(thread: T3ThreadShell): boolean {
  return !thread.archivedAt && !thread.deletedAt && thread.lineage?.relationshipToParent !== "subagent";
}

/** When the thread last saw activity worth sorting by. */
export function threadActivityMs(thread: T3ThreadShell): number {
  return timeMs(thread.latestUserMessageAt) || timeMs(thread.updatedAt) || timeMs(thread.createdAt);
}

function settledMs(thread: T3ThreadShell): number {
  return timeMs(thread.settledAt) || threadActivityMs(thread);
}

export type ThreadSection = "attention" | "working" | "recent" | "snoozed" | "settled";

export type ThreadSections = Record<ThreadSection, T3ThreadShell[]>;

/**
 * The glasses list: threads that need the user first, then running ones
 * (ordered by when the user last wrote, so finishing doesn't reshuffle
 * them), then everything else by recent activity; snoozed and settled
 * threads are kept apart.
 */
export function sectionThreads(threads: Iterable<T3ThreadShell>, nowMs: number): ThreadSections {
  const sections: ThreadSections = { attention: [], working: [], recent: [], snoozed: [], settled: [] };
  for (const thread of threads) {
    if (!isThreadListed(thread)) continue;
    const status = threadStatus(thread);
    if (status === "approval" || status === "input") sections.attention.push(thread);
    else if (isThreadSnoozed(thread, nowMs)) sections.snoozed.push(thread);
    else if (isThreadSettled(thread)) sections.settled.push(thread);
    else if (status === "working" || status === "waiting") sections.working.push(thread);
    else sections.recent.push(thread);
  }
  const byId = (a: T3ThreadShell, b: T3ThreadShell) => a.id.localeCompare(b.id);
  sections.attention.sort((a, b) => timeMs(b.pendingRuntimeRequest?.createdAt) - timeMs(a.pendingRuntimeRequest?.createdAt) || byId(a, b));
  const sentMs = (thread: T3ThreadShell) => timeMs(thread.latestUserAuthoredMessageAt) || timeMs(thread.latestRunRequestedAt);
  sections.working.sort((a, b) => sentMs(b) - sentMs(a) || byId(a, b));
  sections.recent.sort((a, b) => threadActivityMs(b) - threadActivityMs(a) || byId(a, b));
  sections.snoozed.sort((a, b) => timeMs(a.snoozedUntil) - timeMs(b.snoozedUntil) || byId(a, b));
  sections.settled.sort((a, b) => settledMs(b) - settledMs(a) || byId(a, b));
  return sections;
}

/** "now", "5m", "3h", "2d", "Mar 4" style age. */
export function formatAge(thenMs: number, nowMs: number): string {
  if (!thenMs) return "";
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const date = new Date(thenMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

// ---------------------------------------------------------------------------
// Thread detail (subscribeThread)

const MAX_ITEMS_KEPT = 400;

export class ThreadDetailModel {
  /** Last applied sequence (the resume cursor), or null before the first snapshot. */
  sequence: number | null = null;
  synchronized = false;
  deleted = false;
  thread: Record<string, any> | null = null;
  readonly runs = new Map<string, T3Run>();
  readonly attempts = new Map<string, T3RunAttempt>();
  readonly runtimeRequests = new Map<string, T3RuntimeRequest>();
  readonly messages = new Map<string, T3ConversationMessage>();
  readonly plans = new Map<string, T3Plan>();
  /** This thread's own timeline rows, by id. */
  readonly items = new Map<string, T3TurnItem>();
  /** Rows inherited from a forked-from thread: a frozen prefix. */
  private inherited: T3TurnItem[] = [];
  /** Bounded-window bookkeeping: older history exists that we didn't load. */
  hasMoreHistory = false;
  private historyCursor: string | null = null;
  private latestLocalTurnOrdinal: number | null = null;

  constructor(readonly threadId: string) {}

  /** Apply one subscribeThread stream item; returns whether anything changed. */
  apply(raw: unknown): boolean {
    const item = raw as Record<string, any>;
    switch (item?.kind) {
      case "synchronized":
        this.synchronized = true;
        return true;
      case "snapshot":
        this.applySnapshot(item);
        return true;
      case "event": {
        const sequence = typeof item.sequence === "number" ? item.sequence : null;
        if (sequence !== null && this.sequence !== null && sequence <= this.sequence) return false;
        if (sequence !== null) this.sequence = sequence;
        return this.applyEvent(item.event ?? {});
      }
      default:
        return false;
    }
  }

  private applySnapshot(item: Record<string, any>): void {
    const projection = item.projection ?? {};
    this.sequence = typeof item.snapshotSequence === "number" ? item.snapshotSequence : 0;
    this.thread = projection.thread ?? null;
    this.deleted = Boolean(this.thread?.deletedAt);
    const fill = <T extends { id: string }>(map: Map<string, T>, values: T[] | undefined) => {
      map.clear();
      for (const value of values ?? []) map.set(value.id, value);
    };
    fill(this.runs, projection.runs);
    fill(this.attempts, projection.attempts);
    fill(this.runtimeRequests, projection.runtimeRequests);
    fill(this.messages, projection.messages);
    fill(this.plans, projection.plans);
    this.items.clear();
    this.inherited = [];
    for (const row of (projection.visibleTurnItems ?? []) as ProjectedTurnItem[]) {
      if (!row?.item) continue;
      if (row.visibility === "local") this.items.set(row.item.id, row.item);
      else this.inherited.push(row.item);
    }
    this.hasMoreHistory = Boolean(item.hasMoreHistory);
    this.historyCursor = typeof item.historyCursor === "string" ? item.historyCursor : null;
    this.latestLocalTurnOrdinal = typeof item.latestLocalTurnOrdinal === "number" ? item.latestLocalTurnOrdinal : null;
  }

  private applyEvent(event: Record<string, any>): boolean {
    const payload = event.payload;
    const type = String(event.type ?? "");
    if (type === "thread.deleted") {
      this.deleted = true;
      return true;
    }
    if (type.startsWith("thread.")) {
      if (payload && typeof payload === "object") this.thread = payload;
      return true;
    }
    switch (type) {
      case "run.created":
      case "run.updated":
        this.runs.set(payload.id, payload);
        return true;
      case "run-attempt.created":
      case "run-attempt.updated":
        this.attempts.set(payload.id, payload);
        return true;
      case "runtime-request.updated":
        this.runtimeRequests.set(payload.id, payload);
        return true;
      case "message.updated":
        this.messages.set(payload.id, payload);
        return true;
      case "plan.updated":
        this.plans.set(payload.id, payload);
        return true;
      case "turn-item.updated":
        return this.upsertItem(payload as T3TurnItem);
      default:
        // Unknown and uninteresting events still advance the cursor.
        return false;
    }
  }

  private upsertItem(item: T3TurnItem): boolean {
    if (!item?.id || item.threadId !== this.threadId) return false;
    const partial = this.hasMoreHistory || this.historyCursor !== null;
    if (!this.items.has(item.id) && partial) {
      // Updates to rows from history we never loaded.
      if (this.latestLocalTurnOrdinal !== null && item.ordinal <= this.latestLocalTurnOrdinal) return false;
      const oldest = this.oldestLocalOrdinal();
      if (oldest !== null && item.ordinal < oldest) return false;
    }
    this.items.set(item.id, item);
    if (partial && (this.latestLocalTurnOrdinal === null || item.ordinal > this.latestLocalTurnOrdinal)) {
      this.latestLocalTurnOrdinal = item.ordinal;
    }
    if (this.items.size > MAX_ITEMS_KEPT) this.trimOldest();
    return true;
  }

  private oldestLocalOrdinal(): number | null {
    let oldest: number | null = null;
    for (const item of this.items.values()) if (oldest === null || item.ordinal < oldest) oldest = item.ordinal;
    return oldest;
  }

  /** A long-lived subscription keeps growing; drop the oldest rows (they're history now). */
  private trimOldest(): void {
    const sorted = [...this.items.values()].sort(compareItems);
    for (const item of sorted.slice(0, sorted.length - MAX_ITEMS_KEPT)) this.items.delete(item.id);
    this.hasMoreHistory = true;
    this.inherited = [];
  }

  /** Visible rows in display order (inherited fork history first). */
  timeline(): T3TurnItem[] {
    const local = [...this.items.values()].filter((item) => this.isVisible(item)).sort(compareItems);
    return [...this.inherited, ...local];
  }

  private isVisible(item: T3TurnItem): boolean {
    const run = item.runId ? this.runs.get(item.runId) : undefined;
    if (run?.status === "rolled_back") return false;
    if (item.type === "user_message" && item.inputIntent === "queued_turn" && run?.status === "cancelled") return false;
    if (item.type === "run_interrupt_result" && item.runId && item.nodeId) {
      const superseded = [...this.attempts.values()].some(
        (attempt) => attempt.runId === item.runId && attempt.rootNodeId === item.nodeId && attempt.status === "superseded",
      );
      if (superseded) {
        const hasRequest = [...this.items.values()].some(
          (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
        );
        if (!hasRequest) return false;
      }
    }
    return true;
  }

  /** The run a Stop should interrupt, if any. */
  activeRunId(): string | null {
    let active: T3Run | null = null;
    for (const run of this.runs.values()) {
      if (["preparing", "starting", "running", "waiting"].includes(run.status)) {
        if (!active || timeMs(run.requestedAt) >= timeMs(active.requestedAt)) active = run;
      }
    }
    return active?.id ?? null;
  }

  /** Pending approvals and questions, oldest first, paired with their timeline rows. */
  pendingRequests(): PendingRequest[] {
    const result: PendingRequest[] = [];
    const items = [...this.items.values()].sort(compareItems);
    for (const request of this.runtimeRequests.values()) {
      if (request.status !== "pending") continue;
      if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
      const type = request.kind === "user_input" ? "user_input_request" : "approval_request";
      const item = [...items].reverse().find((candidate) => candidate.type === type && candidate.requestId === request.id);
      if (!item) continue;
      const capability = request.responseCapability?.type ?? "live";
      result.push({
        request,
        item,
        kind: request.kind === "user_input" ? "question" : "approval",
        answerable: request.kind === "user_input" ? capability !== "not_resumable" : capability === "live",
        messageMode: item.responseMode === "message" || capability === "message",
      });
    }
    return result.sort((a, b) => compareItems(a.item, b.item));
  }

  /** Follow-ups waiting for the active run to finish (they have no timeline row yet). */
  queuedMessages(): string[] {
    return [...this.runs.values()]
      .filter((run) => run.status === "queued" && run.userMessageId)
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
      .map((run) => this.messages.get(run.userMessageId!))
      .filter((message): message is T3ConversationMessage => Boolean(message && !message.delegatedCompletion && !message.notification))
      .map((message) => message.text ?? "");
  }

  /** The current todo list (the latest run's, else the newest one). */
  todoList(): T3Plan | null {
    const todos = [...this.plans.values()].filter((plan) => plan.kind === "todo_list" && plan.steps?.length);
    if (!todos.length) return null;
    const latestRunId = this.thread?.latestRunId ?? null;
    return todos.find((plan) => plan.runId === latestRunId) ?? todos[todos.length - 1]!;
  }
}

export type PendingRequest = {
  request: T3RuntimeRequest;
  item: T3TurnItem;
  kind: "approval" | "question";
  /** False when the provider session can't take an answer any more (interrupt instead). */
  answerable: boolean;
  /** Message-mode questions: answers must be non-empty strings. */
  messageMode: boolean;
};

function compareItems(a: T3TurnItem, b: T3TurnItem): number {
  return a.ordinal - b.ordinal || String(a.id).localeCompare(String(b.id));
}

// ---------------------------------------------------------------------------
// Timeline presentation

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; queued?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "activity"; id: string; label: string; detail: string; state: ActivityState }
  | { kind: "request"; id: string; label: string; detail: string; resolved: boolean };

export type ActivityState = "running" | "done" | "failed" | "stopped";

function activityState(item: T3TurnItem): ActivityState {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "done";
  }
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `bash -lc '<script>'` → `<script>` (what T3's work log shows). */
export function commandDisplayText(command: string): string {
  const trimmed = command.trim();
  const match = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(trimmed);
  return match ? match[2]!.trim() || trimmed : trimmed;
}

/** One-line label and optional detail for a non-message timeline row (null to hide it). */
export function summarizeActivity(item: T3TurnItem): { label: string; detail: string } | null {
  const title = oneLine(item.title);
  switch (item.type) {
    case "command_execution": {
      const input = typeof item.input === "string" ? oneLine(commandDisplayText(item.input)) : "";
      if (input === "Preparing workspace") return null;
      return { label: input || title || "Command", detail: "" };
    }
    case "file_change": {
      const count = item.changes?.length ?? 0;
      const label = title || (count > 1 ? `Changed ${count} files` : `Changed ${baseName(item.fileName ?? "a file")}`);
      const stats = item.additions != null || item.deletions != null ? `+${item.additions ?? 0}/-${item.deletions ?? 0}` : "";
      return { label: capitalize(label), detail: stats };
    }
    case "file_search":
      return { label: capitalize(title || "Searched files"), detail: oneLine(item.pattern) };
    case "web_search":
      return { label: capitalize(title || "Searched the web"), detail: oneLine((item.patterns ?? []).join(", ")) };
    case "dynamic_tool":
      return { label: capitalize(title || oneLine(item.toolName) || "Tool call"), detail: "" };
    case "reasoning":
      return { label: activityState(item) === "running" ? "Thinking" : "Thought", detail: "" };
    case "subagent":
      return { label: capitalize(title || "Subagent"), detail: "" };
    case "notification":
      return { label: oneLine(item.summary) || "Notification", detail: oneLine(item.detail) };
    case "system_notice":
      return { label: oneLine(item.message) || "Notice", detail: "" };
    case "error":
      if (item.status === "cancelled" && item.failure?.code === "workspace_preparation_failed") return null;
      return {
        label: item.failure?.class === "usage_limit" ? "Usage limit reached" : "Provider error",
        detail: oneLine(item.failure?.message),
      };
    case "run_interrupt_result":
      return { label: "Run interrupted", detail: oneLine(item.message) };
    case "compaction":
      return item.beforeTokenCount != null && item.afterTokenCount != null
        ? { label: `Context compacted ${item.beforeTokenCount} → ${item.afterTokenCount} tokens`, detail: "" }
        : { label: "Compacting context", detail: "" };
    case "handoff":
      return { label: "Context handed off", detail: oneLine(item.toModel) };
    case "fork":
      return { label: "Thread forked", detail: "" };
    case "thread_created":
      return { label: "Thread created", detail: "" };
    case "proposed_plan":
      return { label: "Proposed plan", detail: oneLine(item.markdown).slice(0, 200) };
    case "todo_list":
    case "checkpoint":
    case "run_interrupt_request":
      return null;
    default:
      return title ? { label: capitalize(title), detail: "" } : null;
  }
}

/** Approval / question rows: what's being asked. */
export function describeRequest(item: T3TurnItem): { label: string; detail: string } {
  if (item.type === "user_input_request") {
    const questions = (item.questions ?? []).map((question) => oneLine(question.question)).filter(Boolean);
    return { label: "Question", detail: questions.join(" · ") };
  }
  const what = item.requestKind === "file-change" ? "Approve file change" : item.requestKind === "command" ? "Approve command" : "Approval requested";
  return { label: item.appName ? `${what} (${item.appName})` : what, detail: oneLine(item.prompt) };
}

/** Timeline rows → display entries (messages, activities, requests), plus queued follow-ups at the end. */
export function timelineEntries(detail: ThreadDetailModel): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of detail.timeline()) {
    switch (item.type) {
      case "user_message":
        entries.push({ kind: "user", id: item.id, text: item.text ?? "" });
        break;
      case "assistant_message":
        if ((item.text ?? "").trim() || item.streaming) {
          entries.push({ kind: "assistant", id: item.id, text: item.text ?? "", streaming: Boolean(item.streaming) });
        }
        break;
      case "approval_request":
      case "user_input_request": {
        const { label, detail: what } = describeRequest(item);
        entries.push({ kind: "request", id: item.id, label, detail: what, resolved: activityState(item) !== "running" });
        break;
      }
      default: {
        const summary = summarizeActivity(item);
        if (summary) entries.push({ kind: "activity", id: item.id, ...summary, state: activityState(item) });
      }
    }
  }
  detail.queuedMessages().forEach((text, index) => entries.push({ kind: "user", id: `queued:${index}`, text, queued: true }));
  return entries;
}

/**
 * Light Markdown cleanup for a monochrome text view: drop code fences and
 * emphasis markers, show links as their text, turn list markers into bullets.
 */
export function plainMarkdown(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) =>
      line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)[-*+]\s+/, "$1· ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Commands (orchestration.dispatchCommand payloads)

/** RFC 4122 v4 UUID; T3 clients use these for command, message and thread ids. */
export function uuidv4(random: () => number = Math.random): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[(Math.floor(random() * 16) & 0x3) | 0x8];
    else out += hex[Math.floor(random() * 16)];
  }
  return out;
}

/**
 * A follow-up message. While a run is active the server queues it; with
 * steer set, the server steers the active turn when the provider supports it
 * (and otherwise queues or interrupt-restarts), like T3's own clients.
 */
export function messageDispatchCommand(threadId: string, text: string, options: { steer?: boolean } = {}): Record<string, unknown> {
  return {
    type: "message.dispatch",
    commandId: uuidv4(),
    createdBy: "user",
    creationSource: "mobile",
    threadId,
    messageId: uuidv4(),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    ...(options.steer ? { deliveryIntent: "auto" } : {}),
  };
}

export function approvalResponseCommand(threadId: string, requestId: string, decision: string): Record<string, unknown> {
  return { type: "runtime-request.respond", commandId: uuidv4(), threadId, requestId, decision };
}

export function questionAnswerCommand(threadId: string, requestId: string, answers: Record<string, string | string[]>): Record<string, unknown> {
  return { type: "runtime-request.respond", commandId: uuidv4(), threadId, requestId, answers };
}

export function interruptCommand(threadId: string, runId: string): Record<string, unknown> {
  // holdQueue (as T3's clients send it): queued follow-ups wait instead of starting.
  return { type: "run.interrupt", commandId: uuidv4(), threadId, runId, holdQueue: true };
}

export function visitCommand(threadId: string, visitedAt: string): Record<string, unknown> {
  return { type: "thread.visit", commandId: uuidv4(), threadId, visitedAt };
}

export function settleCommand(threadId: string, settle: boolean): Record<string, unknown> {
  return settle
    ? { type: "thread.settle", commandId: uuidv4(), threadId }
    : { type: "thread.unsettle", commandId: uuidv4(), threadId, reason: "user" };
}

/** The approval choices to offer: the request's own, else T3 mobile's defaults. */
export function approvalOptions(item: T3TurnItem): T3ApprovalOption[] {
  if (item.options?.length) return item.options;
  return [
    { decision: "accept", label: "Allow once" },
    { decision: "acceptForSession", label: "Allow for session" },
    { decision: "decline", label: "Decline" },
  ];
}

/** What an option answers a question with: its value if it has one, else its label. */
export function optionAnswer(option: { label: string; value?: string }): string {
  return option.value ?? option.label;
}

// ---------------------------------------------------------------------------
// New threads

export type T3ServerProvider = {
  instanceId: string;
  displayName?: string;
  driver?: string;
  enabled?: boolean;
  installed?: boolean;
  auth?: { status?: string };
  models?: Array<{ slug: string; name?: string; isDefault?: boolean; isLegacy?: boolean }>;
};

function providerUsable(provider: T3ServerProvider): boolean {
  return provider.enabled !== false && provider.installed !== false && provider.auth?.status !== "unauthenticated";
}

export function providerDisplayName(providers: readonly T3ServerProvider[], instanceId: string | null | undefined): string {
  if (!instanceId) return "";
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return provider?.displayName || provider?.driver || instanceId;
}

/**
 * Model for a new thread, the way T3's mobile app defaults it: project
 * override, environment default, the project's legacy default, then the
 * first usable provider's default model, then any usable model.
 */
export function defaultModelSelection(
  settings: Record<string, any> | null,
  providers: readonly T3ServerProvider[],
  project: T3ProjectShell,
): T3ModelSelection | null {
  const usable = (selection: T3ModelSelection | null | undefined): selection is T3ModelSelection => {
    if (!selection?.instanceId || !selection.model) return false;
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    return provider ? providerUsable(provider) : providers.length === 0;
  };
  const candidates = [
    settings?.projectSettingsOverrides?.[project.id]?.defaultModelSelection,
    settings?.defaultModelSelection,
    project.defaultModelSelection,
  ];
  for (const candidate of candidates) if (usable(candidate)) return candidate;
  for (const pickDefault of [true, false]) {
    for (const provider of providers) {
      if (!providerUsable(provider)) continue;
      const model = (provider.models ?? []).find((entry) => !entry.isLegacy && (!pickDefault || entry.isDefault));
      if (model) return { instanceId: provider.instanceId, model: model.slug };
    }
  }
  return null;
}

/** First line of a prompt as a provisional title (the server generates a better one). */
export function provisionalTitle(text: string): string {
  const collapsed = oneLine(text);
  if (!collapsed) return "New thread";
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

export function launchThreadPayload(
  project: T3ProjectShell,
  text: string,
  modelSelection: T3ModelSelection,
  settings: Record<string, any> | null,
): Record<string, unknown> {
  const runtimeMode = settings?.projectSettingsOverrides?.[project.id]?.defaultRuntimeMode ?? settings?.defaultRuntimeMode ?? "full-access";
  return {
    commandId: uuidv4(),
    creationSource: "mobile",
    threadId: uuidv4(),
    projectId: project.id,
    title: provisionalTitle(text),
    generateTitle: true,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: uuidv4(), text, attachments: [] },
  };
}
