/**
 * New-thread options for orchestration.launchThread, resolved the way T3
 * Code's own new-task flow does it (apps/mobile/src/features/threads/
 * new-task-flow-provider.tsx, lib/modelOptions.ts, thread-settings-options.ts,
 * new-task-context-presentation.ts; packages/shared/src/projectSettings.ts
 * and model.ts): which models, model options, access modes, workspaces and
 * branches to offer, their defaults, and the launch payload.
 *
 * Defaults follow T3's project-settings chain: the project's override, then
 * the environment's setting, then (for the workspace mode) the repository's
 * checked-in t3.json, then the built-in value. The user's explicit picks live
 * in a LaunchDraft; resolveLaunch() layers them over those defaults.
 *
 * Pure (no I/O), so it runs under the Node tests; the worker owns the draft,
 * the branch list and t3.json reads.
 */
import type { T3ModelOptionSelection, T3ModelSelection, T3ProjectShell } from "./t3-model";
import { uuidv4 } from "./t3-model";

// ---------------------------------------------------------------------------
// Wire shapes (subset)

export type T3OptionChoice = { id: string; label: string; description?: string; isDefault?: boolean };

/** One per-model option a provider offers (reasoning effort, fast mode, ...). */
export type T3OptionDescriptor =
  | {
      id: string;
      label: string;
      description?: string;
      type: "select";
      options: T3OptionChoice[];
      currentValue?: string;
      /** Values applied by rewriting the prompt (Claude's "ultrathink"), not offered as picks. */
      promptInjectedValues?: string[];
    }
  | { id: string; label: string; description?: string; type: "boolean"; currentValue?: boolean };

export type T3ProviderModel = {
  slug: string;
  name?: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  capabilities?: { optionDescriptors?: T3OptionDescriptor[] } | null;
};

export type T3ServerProvider = {
  instanceId: string;
  displayName?: string;
  driver?: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: string;
  auth?: { status?: string };
  supportedRuntimeModes?: string[];
  models?: T3ProviderModel[];
};

/** A branch from vcs.listRefs. */
export type T3VcsRef = {
  name: string;
  isRemote?: boolean;
  remoteName?: string;
  current: boolean;
  isDefault: boolean;
  /** Set when the branch is checked out in a worktree (the project root counts). */
  worktreePath: string | null;
};

export type T3RefList = {
  refs: T3VcsRef[];
  isRepo: boolean;
  hasPrimaryRemote: boolean;
  nextCursor?: number | null;
  totalCount?: number;
};

/** The settings a repository's t3.json can supply. */
export type T3ProjectFileDefaults = { defaultThreadEnvMode?: WorkspaceMode };

export const T3_PROJECT_FILE_NAME = "t3.json";

export function parseProjectFile(contents: string): T3ProjectFileDefaults | null {
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return null;
    const mode = parsed.defaultThreadEnvMode;
    return mode === "local" || mode === "worktree" ? { defaultThreadEnvMode: mode } : {};
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project-scoped settings

type Settings = Record<string, any> | null | undefined;

/**
 * The project's overrides. Until the server has folded them into
 * settings.projectSettingsOverrides, the project's own legacy model and
 * workspace fields count as overrides too.
 */
function projectOverrides(settings: Settings, project: T3ProjectShell): Record<string, unknown> {
  const stored = (settings?.projectSettingsOverrides?.[project.id] ?? {}) as Record<string, unknown>;
  if (settings?.projectSettingsFolded) return stored;
  return {
    ...(project.defaultModelSelection != null ? { defaultModelSelection: project.defaultModelSelection } : {}),
    ...(project.defaultThreadEnvMode != null ? { defaultThreadEnvMode: project.defaultThreadEnvMode } : {}),
    ...stored,
  };
}

/** A project-scoped setting: the project's override (even null), else the environment's. */
function projectSetting(settings: Settings, project: T3ProjectShell, key: string): unknown {
  const override = projectOverrides(settings, project)[key];
  return override !== undefined ? override : settings?.[key];
}

/** The project that is the environment's Scratch folder (threads without a project). */
export function isScratchProject(project: T3ProjectShell, scratchWorkspaceRoot: string | null | undefined): boolean {
  if (!scratchWorkspaceRoot || !project.workspaceRoot) return false;
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");
  return normalize(project.workspaceRoot) === normalize(scratchWorkspaceRoot);
}

/**
 * The same repository among another environment's projects (moving a new
 * thread to another computer): repository identity, else the checkout's
 * folder name, else the title.
 */
export function matchingProject(projects: Iterable<T3ProjectShell>, target: T3ProjectShell): T3ProjectShell | null {
  const list = [...projects];
  const key = target.repositoryIdentity?.canonicalKey ?? null;
  if (key) {
    const match = list.find((project) => project.repositoryIdentity?.canonicalKey === key);
    if (match) return match;
  }
  const folder = baseName(target.workspaceRoot);
  return (
    (folder ? list.find((project) => baseName(project.workspaceRoot) === folder) : undefined) ??
    list.find((project) => project.title === target.title) ??
    null
  );
}

function baseName(path: string | undefined): string {
  return (path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

// ---------------------------------------------------------------------------
// Providers and models

function providerUsable(provider: T3ServerProvider): boolean {
  return (
    provider.enabled !== false &&
    provider.installed !== false &&
    provider.auth?.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}

function findProvider(providers: readonly T3ServerProvider[], instanceId: string | null | undefined): T3ServerProvider | undefined {
  return instanceId ? providers.find((provider) => provider.instanceId === instanceId) : undefined;
}

function findModel(providers: readonly T3ServerProvider[], selection: T3ModelSelection | null | undefined): T3ProviderModel | undefined {
  return findProvider(providers, selection?.instanceId)?.models?.find((model) => model.slug === selection?.model);
}

const DRIVER_NAMES: Record<string, string> = { codex: "Codex", claudeAgent: "Claude", pi: "Pi" };

/** "Claude", "Codex", or the provider's configured name. */
export function providerDisplayName(providers: readonly T3ServerProvider[], instanceId: string | null | undefined): string {
  if (!instanceId) return "";
  const provider = findProvider(providers, instanceId);
  const driver = provider?.driver ?? "";
  return provider?.displayName || DRIVER_NAMES[driver] || driver || instanceId;
}

/** The model's display name ("Claude Opus 5"), else its slug. */
export function modelDisplayName(providers: readonly T3ServerProvider[], selection: T3ModelSelection | null | undefined): string {
  if (!selection) return "";
  return findModel(providers, selection)?.name || selection.model;
}

export type ModelChoiceGroup = {
  instanceId: string;
  label: string;
  /** Current models first, then legacy ones. */
  models: Array<{ selection: T3ModelSelection; label: string; isLegacy: boolean }>;
};

/** Every model on a usable provider, grouped by provider. */
export function modelChoices(providers: readonly T3ServerProvider[]): ModelChoiceGroup[] {
  const groups: ModelChoiceGroup[] = [];
  for (const provider of providers) {
    if (!providerUsable(provider)) continue;
    const models = (provider.models ?? [])
      .map((model) => ({
        selection: { instanceId: provider.instanceId, model: model.slug },
        label: model.name || model.slug,
        isLegacy: model.isLegacy === true,
      }))
      .sort((a, b) => Number(a.isLegacy) - Number(b.isLegacy));
    if (models.length) groups.push({ instanceId: provider.instanceId, label: providerDisplayName(providers, provider.instanceId), models });
  }
  return groups;
}

/**
 * Model for a new thread, the way T3's mobile app defaults it: the project's
 * default (project override, then environment), then the first usable
 * provider's default model, then any current model. Legacy models are never
 * picked implicitly.
 */
export function defaultModelSelection(
  settings: Settings,
  providers: readonly T3ServerProvider[],
  project: T3ProjectShell,
): T3ModelSelection | null {
  const usable = (selection: unknown): selection is T3ModelSelection => {
    const candidate = selection as T3ModelSelection | null | undefined;
    if (!candidate?.instanceId || !candidate.model) return false;
    const provider = findProvider(providers, candidate.instanceId);
    if (!provider) return providers.length === 0;
    return providerUsable(provider) && findModel(providers, candidate)?.isLegacy !== true;
  };
  const override = projectOverrides(settings, project).defaultModelSelection;
  for (const candidate of [override, settings?.defaultModelSelection]) if (usable(candidate)) return candidate;
  for (const pickDefault of [true, false]) {
    for (const provider of providers) {
      if (!providerUsable(provider)) continue;
      const model = (provider.models ?? []).find((entry) => !entry.isLegacy && (!pickDefault || entry.isDefault));
      if (model) return { instanceId: provider.instanceId, model: model.slug };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-model options (effort, fast mode, ...)

/** Effort values T3 mobile leaves out of its picker (a workflow trigger, not a reasoning level). */
const HIDDEN_CHOICE_IDS = new Set(["ultracode"]);

export function modelOptionDescriptors(providers: readonly T3ServerProvider[], selection: T3ModelSelection | null | undefined): T3OptionDescriptor[] {
  return findModel(providers, selection)?.capabilities?.optionDescriptors ?? [];
}

function selectionOptions(selection: T3ModelSelection | null | undefined): T3ModelOptionSelection[] {
  return Array.isArray(selection?.options) ? selection!.options! : [];
}

function validChoice(descriptor: Extract<T3OptionDescriptor, { type: "select" }>, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!descriptor.options.length) return value;
  if (descriptor.promptInjectedValues?.includes(value)) return undefined;
  return descriptor.options.some((option) => option.id === value) ? value : undefined;
}

/** The option's effective value: the selection's pick, else the provider's current value, else its default. */
export function optionValue(descriptor: T3OptionDescriptor, selection: T3ModelSelection | null | undefined): string | boolean | undefined {
  const picked = selectionOptions(selection).find((option) => option.id === descriptor.id)?.value;
  if (descriptor.type === "boolean") {
    if (typeof picked === "boolean") return picked;
    return descriptor.currentValue;
  }
  return (
    validChoice(descriptor, picked) ??
    validChoice(descriptor, descriptor.currentValue) ??
    descriptor.options.find((option) => option.isDefault)?.id
  );
}

export function optionValueLabel(descriptor: T3OptionDescriptor, value: string | boolean | undefined): string {
  if (descriptor.type === "boolean") return value ? "On" : "Off";
  return descriptor.options.find((option) => option.id === value)?.label ?? (typeof value === "string" ? value : "Default");
}

/** The choices to offer for a select option. */
export function selectableChoices(descriptor: Extract<T3OptionDescriptor, { type: "select" }>): T3OptionChoice[] {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter((option) => !injected.has(option.id) && !HIDDEN_CHOICE_IDS.has(option.id));
}

/** The selection with one option picked. */
export function withModelOption(selection: T3ModelSelection, id: string, value: string | boolean): T3ModelSelection {
  return { ...selection, options: [...selectionOptions(selection).filter((option) => option.id !== id), { id, value }] };
}

/**
 * The selection as sent: only explicitly picked options whose values the
 * model still accepts (T3's normalizeSelectionOptions); none at all leaves
 * the provider's defaults in charge.
 */
export function dispatchModelSelection(providers: readonly T3ServerProvider[], selection: T3ModelSelection): T3ModelSelection {
  const bare = { instanceId: selection.instanceId, model: selection.model };
  const picked = selectionOptions(selection);
  if (!picked.length) return bare;
  const model = findModel(providers, selection);
  if (!model?.capabilities) return { ...bare, options: picked };
  const options: T3ModelOptionSelection[] = [];
  for (const descriptor of model.capabilities.optionDescriptors ?? []) {
    if (!picked.some((option) => option.id === descriptor.id)) continue;
    const value = optionValue(descriptor, selection);
    if (typeof value === "string" || typeof value === "boolean") options.push({ id: descriptor.id, value });
  }
  return options.length ? { ...bare, options } : bare;
}

// ---------------------------------------------------------------------------
// Access (runtime mode)

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{ mode: string; label: string; description: string }> = [
  { mode: "approval-required", label: "Supervised", description: "Ask before commands and file changes." },
  { mode: "auto-accept-edits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." },
  { mode: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  { mode: "full-access", label: "Full access", description: "Allow commands and edits without prompts." },
];

const DEFAULT_RUNTIME_MODE = "full-access";

/** The access modes the provider supports (all of them when it doesn't say). */
export function runtimeModeChoices(provider: T3ServerProvider | null | undefined): typeof RUNTIME_MODE_CHOICES {
  const supported = provider?.supportedRuntimeModes;
  if (!supported?.length) return RUNTIME_MODE_CHOICES;
  const filtered = RUNTIME_MODE_CHOICES.filter((choice) => supported.includes(choice.mode));
  return filtered.length ? filtered : RUNTIME_MODE_CHOICES;
}

export function runtimeModeLabel(mode: string): string {
  return RUNTIME_MODE_CHOICES.find((choice) => choice.mode === mode)?.label ?? mode;
}

// ---------------------------------------------------------------------------
// Workspace and branch

export type WorkspaceMode = "local" | "worktree";

/** Project override, then environment setting, then the repo's t3.json, then "local". */
export function defaultWorkspaceMode(settings: Settings, project: T3ProjectShell, projectFile: T3ProjectFileDefaults | null | undefined): WorkspaceMode {
  const value = projectSetting(settings, project, "defaultThreadEnvMode");
  if (value === "local" || value === "worktree") return value;
  return projectFile?.defaultThreadEnvMode ?? "local";
}

function defaultStartFromOrigin(settings: Settings, project: T3ProjectShell): boolean {
  const value = projectSetting(settings, project, "newWorktreesStartFromOrigin");
  return typeof value === "boolean" ? value : true;
}

/** The checked-out branch's worktree, when it isn't the project checkout itself. */
function separateWorktree(ref: T3VcsRef, project: T3ProjectShell): string | null {
  return ref.worktreePath && ref.worktreePath !== project.workspaceRoot ? ref.worktreePath : null;
}

/** A short tag for a branch in the picker. */
export function refBadge(ref: T3VcsRef, project: T3ProjectShell): string {
  if (ref.current) return "current";
  if (separateWorktree(ref, project)) return "worktree";
  if (ref.isRemote) return "remote";
  if (ref.isDefault) return "default";
  return "";
}

/**
 * Picking this branch for a thread in the project checkout means switching
 * that checkout to it first (vcs.switchRef), as T3 mobile does. Branches
 * already checked out somewhere run where they are.
 */
export function needsCheckout(ref: T3VcsRef, mode: WorkspaceMode): boolean {
  return mode === "local" && !ref.current && !ref.worktreePath;
}

// ---------------------------------------------------------------------------
// Draft → launch

/** The user's explicit picks; null fields take the resolved default. */
export type LaunchDraft = {
  model: T3ModelSelection | null;
  runtimeMode: string | null;
  workspaceMode: WorkspaceMode | null;
  /** Local: the branch the thread runs on; worktree: the base branch. */
  branch: string | null;
  /** Local: run in this existing worktree (the picked branch is checked out there). */
  worktreePath: string | null;
  startFromOrigin: boolean | null;
};

export function emptyLaunchDraft(): LaunchDraft {
  return { model: null, runtimeMode: null, workspaceMode: null, branch: null, worktreePath: null, startFromOrigin: null };
}

export type LaunchContext = {
  settings: Settings;
  providers: readonly T3ServerProvider[];
  project: T3ProjectShell;
  scratchWorkspaceRoot?: string | null;
  /** The repo's t3.json defaults: undefined while unread, null when absent. */
  projectFile?: T3ProjectFileDefaults | null;
  /** vcs.listRefs for the project, or null until loaded. */
  refs: T3RefList | null;
};

export type ResolvedLaunch = {
  model: T3ModelSelection | null;
  runtimeMode: string;
  /** False for the Scratch project and for folders that aren't repositories. */
  canChooseWorkspace: boolean;
  workspaceMode: WorkspaceMode;
  branch: string | null;
  worktreePath: string | null;
  startFromOrigin: boolean;
  /** Why the thread can't start yet (nothing to run it with, no base branch). */
  blocker: string | null;
};

export function resolveLaunch(draft: LaunchDraft, context: LaunchContext): ResolvedLaunch {
  const { settings, providers, project, refs } = context;
  const model = draft.model ?? defaultModelSelection(settings, providers, project);
  const choices = runtimeModeChoices(findProvider(providers, model?.instanceId));
  const wantedMode = draft.runtimeMode ?? (projectSetting(settings, project, "defaultRuntimeMode") as string | null | undefined) ?? DEFAULT_RUNTIME_MODE;
  const runtimeMode = choices.some((choice) => choice.mode === wantedMode) ? wantedMode : choices[0]!.mode;
  const canChooseWorkspace = !isScratchProject(project, context.scratchWorkspaceRoot) && refs?.isRepo !== false;
  const workspaceMode: WorkspaceMode = canChooseWorkspace ? (draft.workspaceMode ?? defaultWorkspaceMode(settings, project, context.projectFile)) : "local";
  const startFromOrigin = draft.startFromOrigin ?? defaultStartFromOrigin(settings, project);
  const localRefs = (refs?.refs ?? []).filter((ref) => !ref.isRemote);
  let branch: string | null;
  let worktreePath: string | null = null;
  if (workspaceMode === "worktree") {
    // The default branch may only exist as origin/<default>, so search every ref for it.
    branch = draft.branch ?? refs?.refs.find((ref) => ref.isDefault)?.name ?? localRefs.find((ref) => ref.current)?.name ?? null;
  } else if (draft.branch) {
    branch = draft.branch;
    worktreePath = draft.worktreePath;
  } else {
    const current = localRefs.find((ref) => ref.current);
    branch = current?.name ?? null;
    worktreePath = current ? separateWorktree(current, project) : null;
  }
  let blocker: string | null = null;
  if (!model) blocker = "No usable agent on that computer: sign in to Claude Code, Codex or another provider in T3 Code first.";
  else if (workspaceMode === "worktree" && !branch) blocker = refs ? "Choose a base branch for the worktree." : "Still loading branches.";
  return { model, runtimeMode, canChooseWorkspace, workspaceMode, branch, worktreePath, startFromOrigin, blocker };
}

/** "Current checkout", "Existing worktree" or "New worktree". */
export function workspaceLabel(resolved: Pick<ResolvedLaunch, "workspaceMode" | "worktreePath">): string {
  if (resolved.workspaceMode === "worktree") return "New worktree";
  return resolved.worktreePath ? "Existing worktree" : "Current checkout";
}

/** The branch row: "main", or a worktree's base "From origin/main". */
export function branchLabel(resolved: Pick<ResolvedLaunch, "workspaceMode" | "branch" | "startFromOrigin">, hasPrimaryRemote: boolean): string {
  if (!resolved.branch) return resolved.workspaceMode === "worktree" ? "Choose branch" : "Unknown";
  if (resolved.workspaceMode === "local") return resolved.branch;
  const fromOrigin = resolved.startFromOrigin && hasPrimaryRemote && !resolved.branch.startsWith("origin/");
  return `From ${fromOrigin ? `origin/${resolved.branch}` : resolved.branch}`;
}

/** The draft after picking a branch (or worktree base) in the given mode. */
export function pickBranch(draft: LaunchDraft, ref: T3VcsRef, mode: WorkspaceMode, project: T3ProjectShell): LaunchDraft {
  return { ...draft, branch: ref.name, worktreePath: mode === "local" ? separateWorktree(ref, project) : null };
}

/**
 * The draft after switching workspace mode. A new worktree keeps an explicitly
 * picked base; the project checkout goes back to whatever is checked out.
 */
export function pickWorkspaceMode(draft: LaunchDraft, mode: WorkspaceMode): LaunchDraft {
  return mode === "local"
    ? { ...draft, workspaceMode: mode, branch: null, worktreePath: null }
    : { ...draft, workspaceMode: mode, worktreePath: null };
}

/** Where the server runs the thread (OrchestrationV2 workspaceStrategy). */
export function workspaceStrategy(resolved: ResolvedLaunch): Record<string, unknown> {
  if (resolved.workspaceMode === "worktree") {
    return { type: "worktree", baseRef: resolved.branch, ...(resolved.startFromOrigin ? { startFromOrigin: true } : {}) };
  }
  if (resolved.worktreePath) {
    return { type: "existing_worktree", worktreePath: resolved.worktreePath, ...(resolved.branch ? { branch: resolved.branch } : {}) };
  }
  return { type: "root", ...(resolved.branch ? { branch: resolved.branch } : {}) };
}

/** First line of a prompt as a provisional title (the server generates a better one). */
export function provisionalTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New thread";
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

/** The orchestration.launchThread payload. Throws when resolveLaunch reported a blocker. */
export function launchThreadPayload(
  project: T3ProjectShell,
  text: string,
  resolved: ResolvedLaunch,
  providers: readonly T3ServerProvider[],
): Record<string, unknown> {
  if (resolved.blocker || !resolved.model) throw new Error(resolved.blocker ?? "No model selected.");
  return {
    commandId: uuidv4(),
    creationSource: "mobile",
    threadId: uuidv4(),
    projectId: project.id,
    title: provisionalTitle(text),
    generateTitle: true,
    modelSelection: dispatchModelSelection(providers, resolved.model),
    runtimeMode: resolved.runtimeMode,
    interactionMode: "default",
    workspaceStrategy: workspaceStrategy(resolved),
    initialMessage: { messageId: uuidv4(), text, attachments: [] },
  };
}
