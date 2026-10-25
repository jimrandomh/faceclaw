const test = require('node:test');
const assert = require('node:assert/strict');
const launch = require('../.test-build/app/apps/t3code/t3-launch.js');

const EFFORT = {
  id: 'effort', label: 'Effort', type: 'select', promptInjectedValues: ['ultrathink'],
  options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }, { id: 'ultrathink', label: 'Ultrathink' }, { id: 'ultracode', label: 'Ultracode' }],
};
const FAST = { id: 'fastMode', label: 'Fast mode', type: 'boolean' };

const providers = [
  { instanceId: 'codex', driver: 'codex', enabled: true, installed: true, auth: { status: 'unauthenticated' }, models: [{ slug: 'gpt-5', isDefault: true }] },
  {
    instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true, installed: true, auth: { status: 'authenticated' },
    supportedRuntimeModes: ['approval-required', 'full-access'],
    models: [
      { slug: 'old', name: 'Old', isLegacy: true, isDefault: true },
      { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { slug: 'claude-opus-5', name: 'Claude Opus 5', isDefault: true, capabilities: { optionDescriptors: [EFFORT, FAST] } },
    ],
  },
  { instanceId: 'pi', driver: 'pi', enabled: true, installed: true, auth: { status: 'authenticated' }, models: [{ slug: 'pi-1' }] },
];
const project = { id: 'p1', title: 'faceclaw', workspaceRoot: '/src/faceclaw' };
const refs = {
  isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 4,
  refs: [
    { name: 'feature', current: true, isDefault: false, worktreePath: '/src/faceclaw' },
    { name: 'main', current: false, isDefault: true, worktreePath: null },
    { name: 'spike', current: false, isDefault: false, worktreePath: '/src/faceclaw-spike' },
    { name: 'origin/main', isRemote: true, remoteName: 'origin', current: false, isDefault: false, worktreePath: null },
  ],
};
const context = (overrides = {}) => ({ settings: null, providers, project, scratchWorkspaceRoot: '/home/scratch', projectFile: null, refs, ...overrides });

test('default model selection mirrors mobile', () => {
  assert.deepEqual(launch.defaultModelSelection(null, providers, project), { instanceId: 'claudeAgent', model: 'claude-opus-5' });
  const settings = { defaultModelSelection: { instanceId: 'codex', model: 'gpt-5' }, projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5' } } } };
  assert.deepEqual(launch.defaultModelSelection(settings, providers, project), { instanceId: 'claudeAgent', model: 'claude-sonnet-5' });
  assert.equal(launch.defaultModelSelection({ defaultModelSelection: { instanceId: 'codex', model: 'gpt-5' } }, providers.slice(0, 1), project), null, 'unauthenticated providers are skipped');
  // The project's legacy field acts as an override until the server folds it.
  const legacyProject = { ...project, defaultModelSelection: { instanceId: 'pi', model: 'pi-1' } };
  assert.deepEqual(launch.defaultModelSelection({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5' } }, providers, legacyProject), { instanceId: 'pi', model: 'pi-1' });
  assert.deepEqual(
    launch.defaultModelSelection({ projectSettingsFolded: true, defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5' } }, providers, legacyProject),
    { instanceId: 'claudeAgent', model: 'claude-sonnet-5' },
  );
});

test('model choices group usable providers, legacy last', () => {
  const groups = launch.modelChoices(providers);
  assert.deepEqual(groups.map((group) => group.label), ['Claude', 'Pi']);
  assert.deepEqual(groups[0].models.map((model) => model.label), ['Claude Sonnet 5', 'Claude Opus 5', 'Old']);
  assert.equal(groups[0].models[2].isLegacy, true);
  assert.equal(launch.modelDisplayName(providers, { instanceId: 'claudeAgent', model: 'claude-opus-5' }), 'Claude Opus 5');
});

test('model options: defaults, picks, hidden choices, dispatch normalization', () => {
  const opus = { instanceId: 'claudeAgent', model: 'claude-opus-5' };
  const [effort, fast] = launch.modelOptionDescriptors(providers, opus);
  assert.equal(launch.optionValue(effort, opus), 'high', 'isDefault choice');
  assert.equal(launch.optionValueLabel(fast, launch.optionValue(fast, opus)), 'Off');
  assert.deepEqual(launch.selectableChoices(effort).map((choice) => choice.id), ['low', 'high'], 'prompt-injected and ultracode are not offered');
  const picked = launch.withModelOption(launch.withModelOption(opus, 'effort', 'low'), 'fastMode', true);
  assert.equal(launch.optionValue(effort, picked), 'low');
  assert.equal(launch.optionValue(fast, picked), true);
  assert.deepEqual(launch.withModelOption(picked, 'effort', 'high').options, [{ id: 'fastMode', value: true }, { id: 'effort', value: 'high' }]);
  assert.deepEqual(launch.dispatchModelSelection(providers, opus), opus, 'no picks: provider defaults');
  const stale = { ...opus, options: [{ id: 'effort', value: 'ultrathink' }, { id: 'gone', value: 'x' }] };
  assert.deepEqual(launch.dispatchModelSelection(providers, stale), { ...opus, options: [{ id: 'effort', value: 'high' }] }, 'invalid values fall back; unknown ids drop');
});

test('access modes follow the provider and project defaults', () => {
  assert.deepEqual(launch.runtimeModeChoices(providers[1]).map((choice) => choice.mode), ['approval-required', 'full-access']);
  assert.equal(launch.runtimeModeChoices(providers[2]).length, 4, 'unspecified: every mode');
  const draft = launch.emptyLaunchDraft();
  assert.equal(launch.resolveLaunch(draft, context()).runtimeMode, 'full-access');
  const settings = { defaultRuntimeMode: 'auto', projectSettingsOverrides: { p1: { defaultRuntimeMode: 'approval-required' } } };
  assert.equal(launch.resolveLaunch(draft, context({ settings })).runtimeMode, 'approval-required');
  // "auto" isn't one of Claude's here, so it falls back to the first supported mode.
  assert.equal(launch.resolveLaunch({ ...draft, runtimeMode: 'auto' }, context()).runtimeMode, 'approval-required');
});

test('workspace: defaults chain, current checkout, existing and new worktrees', () => {
  let draft = launch.emptyLaunchDraft();
  let resolved = launch.resolveLaunch(draft, context());
  assert.equal(resolved.workspaceMode, 'local');
  assert.equal(resolved.branch, 'feature');
  assert.equal(launch.workspaceLabel(resolved), 'Current checkout');
  assert.deepEqual(launch.workspaceStrategy(resolved), { type: 'root', branch: 'feature' });

  assert.equal(launch.resolveLaunch(draft, context({ projectFile: { defaultThreadEnvMode: 'worktree' } })).workspaceMode, 'worktree', 't3.json');
  assert.equal(
    launch.resolveLaunch(draft, context({ settings: { defaultThreadEnvMode: 'local' }, projectFile: { defaultThreadEnvMode: 'worktree' } })).workspaceMode,
    'local',
    'the environment setting outranks t3.json',
  );
  assert.equal(
    launch.resolveLaunch(draft, context({ project: { ...project, defaultThreadEnvMode: 'worktree' }, settings: { defaultThreadEnvMode: 'local' } })).workspaceMode,
    'worktree',
    'a project override outranks the environment',
  );

  // A branch checked out in another worktree runs there.
  draft = launch.pickBranch(draft, refs.refs[2], 'local', project);
  resolved = launch.resolveLaunch(draft, context());
  assert.equal(launch.workspaceLabel(resolved), 'Existing worktree');
  assert.deepEqual(launch.workspaceStrategy(resolved), { type: 'existing_worktree', worktreePath: '/src/faceclaw-spike', branch: 'spike' });
  assert.equal(launch.needsCheckout(refs.refs[1], 'local'), true);
  assert.equal(launch.needsCheckout(refs.refs[2], 'local'), false);
  assert.equal(launch.needsCheckout(refs.refs[1], 'worktree'), false);
  assert.equal(launch.refBadge(refs.refs[0], project), 'current');
  assert.equal(launch.refBadge(refs.refs[2], project), 'worktree');

  // New worktree: from the default branch, origin by default.
  draft = launch.pickWorkspaceMode(launch.emptyLaunchDraft(), 'worktree');
  resolved = launch.resolveLaunch(draft, context());
  assert.equal(resolved.branch, 'main');
  assert.equal(launch.branchLabel(resolved, true), 'From origin/main');
  assert.deepEqual(launch.workspaceStrategy(resolved), { type: 'worktree', baseRef: 'main', startFromOrigin: true });
  resolved = launch.resolveLaunch({ ...draft, startFromOrigin: false }, context());
  assert.equal(launch.branchLabel(resolved, true), 'From main');
  assert.deepEqual(launch.workspaceStrategy(resolved), { type: 'worktree', baseRef: 'main' });
  assert.equal(launch.resolveLaunch(draft, context({ settings: { newWorktreesStartFromOrigin: false } })).startFromOrigin, false);
  // An explicit base survives switching back and forth; the checkout returns to what's checked out.
  draft = launch.pickBranch(draft, refs.refs[0], 'worktree', project);
  assert.equal(launch.resolveLaunch(draft, context()).branch, 'feature');
  assert.equal(launch.resolveLaunch(launch.pickWorkspaceMode(draft, 'local'), context()).worktreePath, null);
  assert.equal(launch.resolveLaunch(launch.pickWorkspaceMode(draft, 'worktree'), context()).branch, 'feature');

  // Still loading branches: worktree mode can't start yet.
  assert.match(launch.resolveLaunch(launch.pickWorkspaceMode(launch.emptyLaunchDraft(), 'worktree'), context({ refs: null })).blocker, /loading/);
});

test('scratch projects and non-repos run in their folder', () => {
  const scratch = { id: 'p2', title: 'Scratch', workspaceRoot: '/home/scratch/' };
  let resolved = launch.resolveLaunch({ ...launch.emptyLaunchDraft(), workspaceMode: 'worktree' }, context({ project: scratch, refs: null }));
  assert.equal(resolved.canChooseWorkspace, false);
  assert.deepEqual(launch.workspaceStrategy(resolved), { type: 'root' });
  resolved = launch.resolveLaunch(launch.emptyLaunchDraft(), context({ refs: { refs: [], isRepo: false, hasPrimaryRemote: false } }));
  assert.equal(resolved.canChooseWorkspace, false);
});

test('launch payload carries every option', () => {
  const draft = { ...launch.pickWorkspaceMode(launch.emptyLaunchDraft(), 'worktree'), model: { instanceId: 'claudeAgent', model: 'claude-opus-5', options: [{ id: 'effort', value: 'low' }] }, runtimeMode: 'approval-required' };
  const resolved = launch.resolveLaunch(draft, context());
  const payload = launch.launchThreadPayload(project, '  Fix   the login test  ', resolved, providers);
  assert.equal(payload.title, 'Fix the login test');
  assert.equal(payload.projectId, 'p1');
  assert.deepEqual(payload.modelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5', options: [{ id: 'effort', value: 'low' }] });
  assert.equal(payload.runtimeMode, 'approval-required');
  assert.equal(payload.interactionMode, 'default');
  assert.deepEqual(payload.workspaceStrategy, { type: 'worktree', baseRef: 'main', startFromOrigin: true });
  assert.equal(payload.initialMessage.text, '  Fix   the login test  ');
  assert.throws(() => launch.launchThreadPayload(project, 'x', launch.resolveLaunch(launch.emptyLaunchDraft(), context({ providers: [] })), []), /No usable agent/);
});

test('matching project on another host', () => {
  const projects = [
    { id: 'a', title: 'Other', workspaceRoot: '/w/other' },
    { id: 'b', title: 'faceclaw-fork', workspaceRoot: '/w/faceclaw' },
    { id: 'c', title: 'renamed', workspaceRoot: '/w/x', repositoryIdentity: { canonicalKey: 'github.com/jimrandomh/faceclaw' } },
  ];
  assert.equal(launch.matchingProject(projects, { ...project, repositoryIdentity: { canonicalKey: 'github.com/jimrandomh/faceclaw' } }).id, 'c');
  assert.equal(launch.matchingProject(projects, project).id, 'b', 'folder name');
  assert.equal(launch.matchingProject(projects, { id: 'z', title: 'Other', workspaceRoot: '/elsewhere/q' }).id, 'a', 'title');
  assert.equal(launch.matchingProject(projects, { id: 'z', title: 'none', workspaceRoot: '/q/none' }), null);
});

test('t3.json parsing', () => {
  assert.deepEqual(launch.parseProjectFile('{"defaultThreadEnvMode":"worktree","scripts":[]}'), { defaultThreadEnvMode: 'worktree' });
  assert.deepEqual(launch.parseProjectFile('{"defaultThreadEnvMode":"bogus"}'), {});
  assert.equal(launch.parseProjectFile('not json'), null);
});
