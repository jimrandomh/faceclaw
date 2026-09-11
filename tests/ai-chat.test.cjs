const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, deps, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, console, setTimeout, clearTimeout, ...globals, require(name) {
    assert.ok(name in deps, `Unexpected import ${name} in ${file}`);
    return deps[name];
  } });
  return exports;
}
const callbacks = () => ({ onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError() {} });
const config = (model = 'terra', effort = 'low') => ({ kind: 'direct', llm: {
  provider: model === 'sonnet' ? 'anthropic' : 'openai', selection: model, model, effort, apiKey: 'secret-key',
} });
function sessions() {
  const turns = [];
  let synchronousError = false;
  const { AssistantSession } = load('app/assistant/session.ts', {
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: '', buildAssistantSystemPrompt: () => '', describeAssistantContext: () => '' },
    './bridge-client': { assistantBridge: {} },
    './direct-backend': { DirectAssistantBackend: class { runTurn(options) {
      const turn = { ...options, cancelled: false };
      turns.push(turn);
      if (synchronousError) options.callbacks.onError('failed');
      return { cancel() { turn.cancelled = true; } };
    } } },
    './tool-registry': { toolRegistry: { listTools: () => [] } },
  });
  function done(text) {
    const turn = turns.at(-1);
    turn.messages.push({ role: 'assistant', content: text });
    turn.callbacks.onTextDelta(text, text);
    turn.callbacks.onTurnDone({ stopReason: 'end_turn' });
  }
  return { AssistantSession, turns, done, setError() { synchronousError = true; } };
}
function conversations(saved = '') {
  const env = sessions();
  const { AssistantConversations } = load('app/assistant/conversations.ts', {
    './session': { AssistantSession: env.AssistantSession },
    './models': { ASSISTANT_MODEL_VALUES: ['auto', 'terra', 'sonnet'] },
  });
  let stored = '';
  const store = new AssistantConversations((model, effort) => config(model, effort), () => 'terra', (value) => { stored = value; }, saved);
  return { ...env, store, saved: () => stored };
}

test('voice and chat reuse selected history; sessions isolate context and persist without credentials', () => {
  const env = conversations();
  const firstId = env.store.current().id;
  const voice = env.store.ensureSession();
  voice.sendUtterance('Remember the blue door', {}, callbacks());
  assert.equal(env.store.create(), false);
  env.done('I will remember.');
  const chat = env.store.ensureSession();
  assert.equal(chat, voice);
  chat.sendUtterance('What color?', {}, callbacks());
  assert.equal(env.turns.at(-1).messages[0].content, 'Remember the blue door');
  assert.equal(chat.transcript[1].text, 'I will remember.');
  env.done('Blue.');
  assert.ok(env.store.create());
  env.store.ensureSession().sendUtterance('A separate topic', {}, callbacks());
  assert.equal(env.turns.at(-1).messages.length, 1);
  env.done('New topic.');
  assert.ok(env.store.select(firstId));
  assert.equal(env.store.ensureSession(), voice);
  const restored = conversations(env.saved());
  assert.equal(restored.store.current().id, firstId);
  assert.equal(restored.store.ensureSession().transcript.at(-1).text, 'Blue.');
  assert.equal(env.saved().includes('secret-key'), false);
  restored.store.ensureSession().sendUtterance('Continue after restart', {}, callbacks());
  assert.equal(restored.turns.at(-1).messages[0].content, 'Remember the blue door');
});

test('model and effort changes retain transcript and apply only to the chosen session', () => {
  const env = conversations();
  const original = env.store.current().id;
  env.store.ensureSession().sendUtterance('hello', {}, callbacks());
  assert.equal(env.store.configure('sonnet', 'high'), false);
  env.done('hi');
  env.store.configure('sonnet', 'high');
  env.store.ensureSession().sendUtterance('follow up', {}, callbacks());
  assert.equal(env.turns.at(-1).provider, 'anthropic');
  assert.equal(env.turns.at(-1).effort, 'high');
  assert.equal(env.turns.at(-1).messages[0].content, 'hello');
  env.done('still here');
  env.store.create();
  assert.equal(env.store.current().model, 'terra');
  assert.equal(env.store.current().reasoning, 'default');
  env.store.select(original);
  assert.equal(env.store.current().reasoning, 'high');
});

test('cancelled tools and late callbacks cannot mutate the next turn or its history', () => {
  const env = sessions();
  const session = new env.AssistantSession(config());
  session.sendUtterance('first', {}, callbacks());
  const old = env.turns[0];
  old.callbacks.onTextDelta('partial', 'partial');
  session.cancel();
  session.sendUtterance('second', {}, callbacks());
  old.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'late' }] });
  old.callbacks.onTextDelta('late', 'late');
  old.callbacks.onTurnDone({ stopReason: 'end_turn' });
  assert.equal(session.isTurnActive(), true);
  assert.equal(session.transcript[1].text, 'partial');
  assert.equal(JSON.stringify(env.turns[1].messages).includes('tool_result'), false);
  env.done('new answer');
  assert.equal(session.isTurnActive(), false);
});

test('synchronous provider errors do not leave a permanently active turn', () => {
  const env = sessions(); env.setError();
  const session = new env.AssistantSession(config());
  session.sendUtterance('hello', {}, callbacks());
  assert.equal(session.isTurnActive(), false);
  assert.equal(session.status, 'failed');
});

function draftEnv({ prepare = async () => true, start = async () => {}, initialStatus = 'Ready' } = {}) {
  const transcripts = new Set(), statuses = new Set(), timers = new Map();
  const sent = [];
  let starts = 0, stops = 0, mic = false, timerId = 0;
  const { VoiceDraft } = load('app/apps/ai-chat/voice-draft.ts', {
    '../../native/voice-control': { voiceControlBridge: {
      onTranscript(cb) { transcripts.add(cb); return () => transcripts.delete(cb); },
      onStatus(cb) { statuses.add(cb); cb({ status: initialStatus }); return () => statuses.delete(cb); },
    } },
    '../../ui/shell/voice-activity': { voiceActivity: { setActive(value) { mic = value; } } },
  }, {
    setTimeout(cb) { timers.set(++timerId, cb); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const draft = new VoiceDraft({ startVoiceCapture: async () => { starts++; await start(); }, stopVoiceCapture: () => { stops++; } }, prepare, () => {}, (text) => sent.push(text));
  return { draft, sent, starts: () => starts, stops: () => stops, mic: () => mic,
    transcript(text, isFinal = false) { for (const cb of [...transcripts]) cb({ text, isFinal }); },
    status(status) { for (const cb of [...statuses]) cb({ status }); },
    timeout() { for (const cb of [...timers.values()]) cb(); },
    subscriptions: () => transcripts.size + statuses.size,
  };
}

test('hold displays partials, release waits for final and sends exactly once', async () => {
  const env = draftEnv();
  await env.draft.start();
  env.transcript('hello');
  assert.equal(env.draft.text, 'hello');
  assert.deepEqual(env.sent, []);
  env.draft.release();
  assert.equal(env.stops(), 1);
  env.transcript('hello world', true);
  env.timeout();
  env.transcript('duplicate', true);
  assert.deepEqual(env.sent, ['hello world']);
  assert.equal(env.subscriptions(), 0);
  assert.equal(env.mic(), false);
});

test('release before permission resolves never starts a microphone', async () => {
  let ready;
  const env = draftEnv({ prepare: () => new Promise((resolve) => { ready = resolve; }) });
  const start = env.draft.start();
  env.draft.release(); ready(true); await start;
  assert.equal(env.starts(), 0);
  assert.equal(env.draft.active, false);
  assert.deepEqual(env.sent, []);
});

test('release during async mic startup stops capture after it starts', async () => {
  let started;
  const env = draftEnv({ start: () => new Promise((resolve) => { started = resolve; }) });
  const pending = env.draft.start();
  await new Promise(setImmediate);
  env.transcript('quick message');
  env.draft.release(); started(); await pending;
  assert.equal(env.stops(), 1);
  env.timeout();
  assert.deepEqual(env.sent, ['quick message']);
});

test('empty capture, rejection and closing never submit stale speech', async () => {
  for (const cancel of ['empty', 'rejection', 'close']) {
    const env = draftEnv({ initialStatus: 'old error' });
    await env.draft.start();
    assert.equal(env.starts(), 1);
    if (cancel !== 'empty') env.transcript('should not send');
    if (cancel === 'rejection') env.status('Ignored — not your enrolled voice');
    if (cancel === 'close') env.draft.cancel();
    env.draft.release(); env.timeout(); env.transcript('late', true);
    assert.deepEqual(env.sent, []);
    assert.equal(env.subscriptions(), 0);
  }
});

function shellEnv() {
  const gestures = load('app/ui/gestures.ts', {});
  class Image { constructor(width = 576, height = 260) { this.width = width; this.height = height; } }
  const images = { GrayImage: Image, G2_LENS_WIDTH: 640, G2_LENS_HEIGHT: 480 };
  const timings = { spanCurrent: (_, fn) => fn(), span: (_, __, fn) => fn(), spanAsync: (_, __, fn) => fn(),
    startFrame: () => 0, annotateFrame() {}, finishFrame() {}, runWithFrame: (_, fn) => fn() };
  const layers = load('app/ui/layers.ts', {
    '../graphics/image': images, '../graphics/plane': { dimPlanes: (planes) => planes },
    '../native/frame-timings': timings, './gestures': gestures,
  });
  class Menu {
    constructor(title, items) { this.title = title; this.items = items; this.selectedIndex = 0; }
    selectItem(index) { this.selectedIndex = index; return this; }
    paint(_ctx, below) { return below(); }
    handleInput(event, ctx) { if (event.type === 'double-click') ctx.stack.pop(); }
  }
  const settings = { wakeWordActionSetting: { get: () => 'voice-input' }, brightnessSetting: { get: () => 'auto' } };
  const { shell } = load('app/ui/shell/shell.ts', {
    '../../graphics/image': images, '../../graphics/plane': {}, '../../graphics/ui-fonts': {}, '../../g2/events': {},
    '../gestures': gestures, '../layers': layers, '../menu': { MenuLayer: Menu },
    './voice-input': {}, './keyboard-input': {}, './voice-activity': {}, './assistant': {},
    '../../assistant/conversations': {}, '../../assistant/models': {}, '../../native/settings-store': {},
    '../notifications': {}, '../dashboard-settings': settings, './ambient-cards': {},
    './chrome-layer': { ShellChromeLayer: class {} }, './modal-layer': {}, './tool-debug-layer': {},
    './brightness-picker-layer': {},
    '../../assistant/tool-registry': {}, './geometry': { sidebarWidth: () => 64, minWindowTop: () => 96, TOP_BAR_HEIGHT: 28 },
  });
  const { createInProcessWindow } = load('app/ui/shell/in-process-window.ts', {
    '../../graphics/image': images, '../../native/frame-timings': timings,
    '../../util/render-freshness': { beginRenderPass() {}, endRenderPass: () => false },
    '../layers': layers, '../window-menu': { WindowMenuLayer: Menu },
    './chrome-layer': { windowIcon: () => () => null }, './geometry': { appViewportSize: () => ({ width: 576, height: 260 }) },
    './shell': { shell },
  });
  const input = [], menus = [];
  let microphone = false;
  const app = createInProcessWindow({
    appId: 'ai-chat', windowId: 'ai-chat', title: 'AI Chat', iconLetter: 'AI', closeable: true, holdToTalk: true,
    baseLayer: { paint: () => new Image(), handleInput(event) {
      input.push(event.type);
      if (event.type === 'long-press') microphone = true;
      if (event.type === 'long-press-release') microphone = false;
      if (event.type === 'double-click') shell.yieldFocusToSidebar();
    } },
    menuItems: () => [{ label: 'New session', onSelect() {} }],
    onAppMenuOpened() { menus.push('app'); microphone = false; },
    onSystemMenuOpened() { menus.push('system'); microphone = false; },
    isVoiceCapturing: () => microphone,
    actions: layers.noopLayerActions, submitFrame: async () => {}, setSurfaceVisible() {},
  });
  shell.registerWindow(app.window);
  shell.focusWindow('ai-chat');
  return { shell, app, input, menus, microphone: () => microphone, event: (type) => gestures.makeInputEvent({ type }) };
}

test('chat holds bypass the escape timer; release, menus and double tap follow the requested routing', async () => {
  const env = shellEnv();
  await env.shell.receiveInput(env.event('long-press'));
  assert.equal(env.microphone(), true);
  assert.equal(env.shell.escapeMenuTimer, null);
  await env.shell.receiveInput(env.event('long-press-release'));
  assert.equal(env.microphone(), false);
  assert.deepEqual(env.input, ['long-press', 'long-press-release']);
  await env.shell.receiveInput(env.event('click'));
  assert.deepEqual(env.menus, ['app']);
  assert.equal(env.app.stack.isAtBase(), false);
  await env.shell.receiveInput(env.event('short-then-long-press'));
  assert.deepEqual(env.menus, ['app', 'system']);
  assert.equal(env.app.stack.isAtBase(), true);
  assert.equal(env.shell.stack.isAtBase(), false);
  await env.shell.receiveInput(env.event('long-press-release'));
  assert.deepEqual(env.input, ['long-press', 'long-press-release']);
  env.shell.stack.clearToBase();
  env.shell.focusWindow('ai-chat');
  await env.shell.receiveInput(env.event('double-click'));
  assert.equal(env.shell.isWindowFocused('ai-chat'), false);
});

test('ordinary apps retain long-press system menu and games retain the escape timer', async () => {
  const env = shellEnv();
  env.app.window.holdToTalk = false;
  await env.shell.receiveInput(env.event('long-press'));
  assert.deepEqual(env.menus, ['system']);
  assert.deepEqual(env.input, []);
  env.shell.stack.clearToBase();
  env.app.window.claimsLongPress = () => true;
  await env.shell.receiveInput(env.event('long-press'));
  assert.notEqual(env.shell.escapeMenuTimer, null);
  await env.shell.receiveInput(env.event('long-press-release'));
  assert.equal(env.shell.escapeMenuTimer, null);
});

function chatLayerEnv() {
  const env = conversations();
  const textwrap = load('app/graphics/textwrap.ts', {});
  const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
  const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
  const font = BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus/ter-u12n.bdf'), 'utf8'));
  let windowOptions;
  const { createAiChatWindow } = load('app/apps/ai-chat/ai-chat-app.ts', {
    '../../graphics/image': graphics, '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/textwrap': textwrap, '../../assistant/models': { assistantModelLabel: (s) => s },
    '../../ui/dashboard-settings': { assistantBackendSetting: { get: () => 'direct' } },
    '../../ui/gestures': load('app/ui/gestures.ts', {}), '../../ui/window-menu': {},
    '../../ui/shell/in-process-window': { createInProcessWindow(options) {
      windowOptions = options; return { requestRender() {} };
    } },
    '../../ui/shell/shell': { shell: { getAssistantConversations: () => env.store } },
    './voice-draft': { VoiceDraft: class { active = false; text = ''; status = ''; cancel() {} } },
  });
  createAiChatWindow({ actions: {}, setSurfaceVisible() {}, onClosed() {} });
  const layer = windowOptions.baseLayer;
  return { ...env, layer, paint: (width = 576, height = 260) => layer.paint({ stack: { getBaseSize: () => ({ width, height }) } }) };
}

test('scrollback stays anchored during streaming, follows at the bottom and resets on session switch', () => {
  const env = chatLayerEnv();
  const session = env.store.ensureSession();
  for (let i = 0; i < 20; i++) session.transcript.push({ role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: sample conversation text.` });
  env.paint();
  assert.ok(env.layer.maxFirstLine > 0);
  env.layer.handleInput({ type: 'swipe-up' });
  const first = env.layer.firstLine;
  session.transcript.push({ role: 'assistant', text: 'New streamed text '.repeat(30) });
  env.paint();
  assert.equal(env.layer.firstLine, first);
  for (let i = 0; i < 50; i++) env.layer.handleInput({ type: 'swipe-down' });
  assert.equal(env.layer.firstLine, null);
  env.layer.handleInput({ type: 'scroll-up' });
  env.store.create(); env.paint();
  assert.equal(env.layer.firstLine, null);
});

test('chat paints at both window heights with pending speech pinned beneath history', () => {
  const env = chatLayerEnv();
  env.store.ensureSession().transcript.push({ role: 'user', text: 'Plan my afternoon.' }, {
    role: 'assistant', text: 'You have a meeting at two. There is time for a walk beforehand. '.repeat(8),
  });
  env.layer.draft.active = true;
  env.layer.draft.status = 'Listening... release to send';
  env.layer.draft.text = 'Actually, leave some time to pick up lunch on the way.';
  for (const [width, height] of [[576, 260], [576, 452], [640, 452]]) {
    const image = env.paint(width, height);
    assert.equal(image.width, width); assert.equal(image.height, height);
    assert.equal(image.to8bppBuffer().length, width * height);
    if (process.env.FACECLAW_CHAT_RENDER_DIR) {
      const pixels = image.to8bppBuffer();
      const rgba = new Uint8Array(pixels.length * 4);
      for (let i = 0; i < pixels.length; i++) rgba.set([pixels[i], pixels[i], pixels[i], 255], i * 4);
      const png = require('upng-js').encode([rgba.buffer], width, height, 0);
      fs.writeFileSync(path.join(process.env.FACECLAW_CHAT_RENDER_DIR, `chat-${width}x${height}.png`), Buffer.from(png));
    }
  }
});
