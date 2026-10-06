const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../.test-build/app/apps/t3code/t3-model.js');
const { TranscriptLayout } = require('../.test-build/app/apps/t3code/t3-transcript.js');

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function shellThread(overrides = {}) {
  return {
    id: 't1', projectId: 'p1', title: 'Fix the flaky test',
    status: 'completed', activityRunStatus: null, latestRunId: 'r1', activeProviderThreadId: 'pt1',
    pendingRuntimeRequest: null, pendingBackgroundTasks: [], lastError: null, lastErrorClass: null,
    latestUserMessageAt: iso(-60_000), latestUserAuthoredMessageAt: iso(-60_000), updatedAt: iso(-30_000), createdAt: iso(-3_600_000),
    archivedAt: null, deletedAt: null, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null,
    lineage: { relationshipToParent: null },
    ...overrides,
  };
}

test('shell reducer: snapshot, metadata-only snapshot, deltas, dedupe, archive', () => {
  const shell = new model.ShellModel();
  shell.apply({ kind: 'snapshot', snapshot: { snapshotSequence: 10, projects: [{ id: 'p1', title: 'faceclaw' }], threads: [shellThread()] } });
  assert.equal(shell.sequence, 10);
  assert.equal(shell.threads.size, 1);
  // Repository-identity refresh frames carry threads: [] and must not wipe the list.
  assert.equal(shell.apply({ kind: 'snapshot', resolvedRepositoryIdentityRoots: ['/x'], snapshot: { snapshotSequence: 99, projects: [], threads: [] } }), false);
  assert.equal(shell.threads.size, 1);
  assert.equal(shell.sequence, 10);
  shell.apply({ kind: 'thread.updated', sequence: 11, location: 'active', thread: shellThread({ id: 't2', title: 'Second' }) });
  assert.equal(shell.threads.size, 2);
  assert.equal(shell.apply({ kind: 'thread.updated', sequence: 11, location: 'active', thread: shellThread({ id: 't3' }) }), false, 'replayed sequence is ignored');
  shell.apply({ kind: 'thread.updated', sequence: 12, location: 'archive', thread: shellThread({ id: 't2' }) });
  assert.deepEqual([...shell.threads.keys()], ['t1']);
  shell.apply({ kind: 'thread.removed', sequence: 13, location: 'active', threadId: 't1' });
  assert.equal(shell.threads.size, 0);
  assert.equal(shell.sequence, 13);
  shell.apply({ kind: 'synchronized' });
  assert.equal(shell.synchronized, true);
});

test('thread status follows T3 mobile', () => {
  assert.equal(model.threadStatus(shellThread({ pendingRuntimeRequest: { id: 'q', kind: 'command' } })), 'approval');
  assert.equal(model.threadStatus(shellThread({ pendingRuntimeRequest: { id: 'q', kind: 'user_input' } })), 'input');
  assert.equal(model.threadStatus(shellThread({ pendingRuntimeRequest: { id: 'q', kind: 'auth_refresh' }, status: 'running' })), 'working');
  assert.equal(model.threadStatus(shellThread({ activityRunStatus: 'waiting', status: 'waiting' })), 'working', 'run "waiting" is finalization, not approval');
  assert.equal(model.threadStatus(shellThread({ status: 'completed', pendingBackgroundTasks: [{ kind: 'subagent' }] })), 'waiting');
  assert.equal(model.threadStatus(shellThread({ status: 'failed', lastErrorClass: 'usage_limit' })), 'limited');
  assert.equal(model.threadStatus(shellThread({ status: 'failed' })), 'failed');
  assert.equal(model.threadStatus(shellThread({ latestRunId: null, activeProviderThreadId: null, status: 'idle' })), 'ready');
});

test('sections: needs-you first, working by send time, hidden subagents, snoozed and settled apart', () => {
  const threads = [
    shellThread({ id: 'recent-old', updatedAt: iso(-90_000), latestUserMessageAt: iso(-90_000) }),
    shellThread({ id: 'recent-new', latestUserMessageAt: iso(-10_000) }),
    shellThread({ id: 'asks', pendingRuntimeRequest: { id: 'q', kind: 'user_input', createdAt: iso(-5_000) } }),
    shellThread({ id: 'work-a', status: 'running', latestUserAuthoredMessageAt: iso(-50_000) }),
    shellThread({ id: 'work-b', status: 'running', latestUserAuthoredMessageAt: iso(-20_000) }),
    shellThread({ id: 'sub', lineage: { relationshipToParent: 'subagent' } }),
    shellThread({ id: 'done', settledOverride: 'settled', settledAt: iso(-1000) }),
    shellThread({ id: 'zz', snoozedUntil: iso(3_600_000), snoozedAt: iso(-1000), latestRunCompletedAt: iso(-5000) }),
  ];
  const sections = model.sectionThreads(threads, NOW);
  const ids = (list) => list.map((thread) => thread.id);
  assert.deepEqual(ids(sections.attention), ['asks']);
  assert.deepEqual(ids(sections.working), ['work-b', 'work-a']);
  assert.deepEqual(ids(sections.recent), ['recent-new', 'recent-old']);
  assert.deepEqual(ids(sections.settled), ['done']);
  assert.deepEqual(ids(sections.snoozed), ['zz']);
  // A run finishing after the snooze raises its hand.
  assert.equal(model.isThreadSnoozed(shellThread({ snoozedUntil: iso(3_600_000), snoozedAt: iso(-10_000), latestRunCompletedAt: iso(-1000) }), NOW), false);
});

test('unread means a run finished after the last visit (never visited reads as read)', () => {
  assert.equal(model.isThreadUnread(shellThread({ latestRunCompletedAt: iso(-1000), lastVisitedAt: iso(-5000) })), true);
  assert.equal(model.isThreadUnread(shellThread({ latestRunCompletedAt: iso(-5000), lastVisitedAt: iso(-1000) })), false);
  assert.equal(model.isThreadUnread(shellThread({ latestRunCompletedAt: iso(-1000), lastVisitedAt: null })), false);
});

function item(id, ordinal, type, extra = {}) {
  return { id, threadId: 't1', runId: 'r1', nodeId: null, ordinal, status: 'completed', title: null, type, ...extra };
}

function detailWithSnapshot(extra = {}) {
  const detail = new model.ThreadDetailModel('t1');
  detail.apply({
    kind: 'snapshot',
    snapshotSequence: 100,
    hasMoreHistory: false,
    historyCursor: null,
    latestLocalTurnOrdinal: 3,
    projection: {
      thread: { id: 't1', title: 'Fix the flaky test', latestRunId: 'r1' },
      runs: [{ id: 'r1', status: 'running', requestedAt: iso(-10_000) }],
      attempts: [], messages: [], plans: [],
      runtimeRequests: [],
      visibleTurnItems: [
        { visibility: 'inherited', item: { ...item('parent-1', 1, 'user_message', { text: 'from the parent' }), threadId: 'parent' } },
        { visibility: 'local', item: item('u1', 2, 'user_message', { text: 'Please fix it', inputIntent: 'turn_start' }) },
        { visibility: 'local', item: item('c1', 3, 'command_execution', { input: "bash -lc 'npm test'", status: 'running' }) },
      ],
      ...extra,
    },
  });
  return detail;
}

test('thread detail: snapshot, streaming text replaces, sequence dedupe', () => {
  const detail = detailWithSnapshot();
  assert.deepEqual(detail.timeline().map((row) => row.id), ['parent-1', 'u1', 'c1']);
  const streaming = (seq, text, streamingFlag) => detail.apply({
    kind: 'event', sequence: seq,
    event: { type: 'turn-item.updated', payload: item('a1', 4, 'assistant_message', { text, streaming: streamingFlag, status: streamingFlag ? 'running' : 'completed' }) },
  });
  assert.equal(streaming(101, 'I found the race.\n\n', true), true);
  assert.equal(streaming(102, 'I found the race.\n\nThe test awaits login() first.', false), true);
  assert.equal(streaming(102, 'stale replay', false), false);
  const entries = model.timelineEntries(detail);
  assert.deepEqual(entries.map((entry) => entry.kind), ['user', 'user', 'activity', 'assistant']);
  assert.equal(entries[3].text, 'I found the race.\n\nThe test awaits login() first.');
  assert.equal(entries[3].streaming, false);
  assert.equal(entries[2].label, 'npm test', 'bash -lc wrapper unwrapped');
  assert.equal(entries[2].state, 'running');
  assert.equal(detail.activeRunId(), 'r1');
});

test('thread detail: bounded windows drop updates to unloaded history', () => {
  const detail = detailWithSnapshot();
  detail.hasMoreHistory = true;
  detail.apply({ kind: 'event', sequence: 101, event: { type: 'turn-item.updated', payload: item('old', 1, 'assistant_message', { text: 'ancient' }) } });
  assert.equal(detail.items.has('old'), false);
  detail.apply({ kind: 'event', sequence: 102, event: { type: 'turn-item.updated', payload: item('new', 9, 'assistant_message', { text: 'fresh' }) } });
  assert.equal(detail.items.has('new'), true);
});

test('thread detail: rolled-back runs and cancelled queued turns are hidden', () => {
  const detail = detailWithSnapshot();
  detail.apply({ kind: 'event', sequence: 101, event: { type: 'run.updated', payload: { id: 'r1', status: 'rolled_back' } } });
  assert.deepEqual(detail.timeline().map((row) => row.id), ['parent-1']);
});

test('pending approval and question pair with their timeline rows', () => {
  const detail = detailWithSnapshot({
    runtimeRequests: [
      { id: 'req-a', kind: 'command', status: 'pending', responseCapability: { type: 'live' } },
      { id: 'req-q', kind: 'user_input', status: 'pending', responseCapability: { type: 'message' } },
      { id: 'req-old', kind: 'command', status: 'resolved' },
    ],
  });
  detail.apply({ kind: 'event', sequence: 101, event: { type: 'turn-item.updated', payload: item('ap', 4, 'approval_request', { status: 'waiting', requestId: 'req-a', requestKind: 'command', prompt: 'rm -rf build' }) } });
  detail.apply({ kind: 'event', sequence: 102, event: { type: 'turn-item.updated', payload: item('qu', 5, 'user_input_request', { status: 'waiting', requestId: 'req-q', responseMode: 'message', questions: [{ id: 'Which DB?', question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite', value: 'sqlite' }] }] }) } });
  const pending = detail.pendingRequests();
  assert.deepEqual(pending.map((request) => [request.kind, request.item.id, request.answerable, request.messageMode]), [
    ['approval', 'ap', true, false],
    ['question', 'qu', true, true],
  ]);
  assert.deepEqual(model.approvalOptions(pending[0].item).map((option) => option.decision), ['accept', 'acceptForSession', 'decline']);
  assert.equal(model.optionAnswer(pending[1].item.questions[0].options[1]), 'sqlite');
  const command = model.approvalResponseCommand('t1', 'req-a', 'accept');
  assert.equal(command.type, 'runtime-request.respond');
  assert.match(command.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const entries = model.timelineEntries(detail);
  assert.deepEqual(entries.filter((entry) => entry.kind === 'request').map((entry) => [entry.label, entry.detail, entry.resolved]), [
    ['Approve command', 'rm -rf build', false],
    ['Question', 'Which DB?', false],
  ]);
});

test('queued follow-ups come from queued runs and their messages', () => {
  const detail = detailWithSnapshot({
    runs: [
      { id: 'r1', status: 'running', requestedAt: iso(-10_000) },
      { id: 'r2', status: 'queued', userMessageId: 'm2', queuePosition: 1 },
      { id: 'r3', status: 'queued', userMessageId: 'm3', queuePosition: 0 },
    ],
    messages: [{ id: 'm2', role: 'user', text: 'then this' }, { id: 'm3', role: 'user', text: 'first this' }],
  });
  assert.deepEqual(detail.queuedMessages(), ['first this', 'then this']);
  const queued = model.timelineEntries(detail).filter((entry) => entry.queued);
  assert.deepEqual(queued.map((entry) => entry.text), ['first this', 'then this']);
});

test('activity summaries', () => {
  assert.equal(model.summarizeActivity(item('x', 1, 'command_execution', { input: 'Preparing workspace' })), null);
  assert.deepEqual(model.summarizeActivity(item('x', 1, 'file_change', { fileName: 'src/app/foo.ts', additions: 3, deletions: 1 })), { label: 'Changed foo.ts', detail: '+3/-1' });
  assert.deepEqual(model.summarizeActivity(item('x', 1, 'dynamic_tool', { title: 'read src/foo.ts', toolName: 'Read' })), { label: 'Read src/foo.ts', detail: '' });
  assert.equal(model.summarizeActivity(item('x', 1, 'reasoning', { status: 'running' })).label, 'Thinking');
  assert.equal(model.summarizeActivity(item('x', 1, 'error', { failure: { class: 'usage_limit', message: 'resets at 5pm' } })).label, 'Usage limit reached');
  assert.equal(model.summarizeActivity(item('x', 1, 'todo_list')), null);
  assert.equal(model.commandDisplayText("/bin/zsh -lc \"git status\""), 'git status');
});

test('plainMarkdown cleans up for the glasses', () => {
  assert.equal(
    model.plainMarkdown('## Plan\n\n- **Fix** the [race](http://x)\n- run `npm test`\n\n```ts\nconst a = 1;\n```\n\n\n\nDone.'),
    'Plan\n\n· Fix the race\n· run npm test\n\nconst a = 1;\n\nDone.',
  );
});

test('default model selection mirrors mobile', () => {
  const providers = [
    { instanceId: 'codex', enabled: true, installed: true, auth: { status: 'unauthenticated' }, models: [{ slug: 'gpt-5', isDefault: true }] },
    { instanceId: 'claudeAgent', enabled: true, installed: true, auth: { status: 'authenticated' }, models: [{ slug: 'old', isLegacy: true, isDefault: true }, { slug: 'claude-sonnet-5' }, { slug: 'claude-opus-5', isDefault: true }] },
  ];
  const project = { id: 'p1', title: 'faceclaw' };
  assert.deepEqual(model.defaultModelSelection(null, providers, project), { instanceId: 'claudeAgent', model: 'claude-opus-5' });
  const settings = { defaultModelSelection: { instanceId: 'codex', model: 'gpt-5' }, projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5' } } } };
  assert.deepEqual(model.defaultModelSelection(settings, providers, project), { instanceId: 'claudeAgent', model: 'claude-sonnet-5' });
  assert.equal(model.defaultModelSelection({ defaultModelSelection: { instanceId: 'codex', model: 'gpt-5' } }, providers.slice(0, 1), project), null, 'unauthenticated providers are skipped');
  const payload = model.launchThreadPayload(project, '  Fix   the login test  ', { instanceId: 'claudeAgent', model: 'claude-opus-5' }, null);
  assert.equal(payload.title, 'Fix the login test');
  assert.equal(payload.runtimeMode, 'full-access');
  assert.deepEqual(payload.workspaceStrategy, { type: 'root' });
});

test('formatAge', () => {
  assert.equal(model.formatAge(NOW - 20_000, NOW), 'now');
  assert.equal(model.formatAge(NOW - 5 * 60_000, NOW), '5m');
  assert.equal(model.formatAge(NOW - 3 * 3_600_000, NOW), '3h');
  assert.equal(model.formatAge(NOW - 2 * 86_400_000, NOW), '2d');
  assert.equal(model.formatAge(0, NOW), '');
});

test('transcript layout collapses long tool runs and wraps messages', () => {
  const font = { measureText: (text) => text.length * 6, getGlyph: () => ({ dwidthX: 6 }) };
  const activities = Array.from({ length: 6 }, (_, index) => ({ kind: 'activity', id: `a${index}`, label: `step ${index}`, detail: '', state: index === 5 ? 'running' : 'done' }));
  const entries = [
    { kind: 'user', id: 'u', text: 'please do the thing' },
    ...activities,
    { kind: 'assistant', id: 'm', text: 'All done, the thing is fixed now.', streaming: false },
  ];
  const layout = new TranscriptLayout();
  const lines = layout.layout(entries, font, 120).map((line) => line.text);
  assert.deepEqual(lines, [
    'You: please do the', 'thing',
    '',
    '· 4 earlier steps', '· step 4', '· step 5 …',
    '',
    'All done, the thing', 'is fixed now.',
  ]);
});
