const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const sandbox = { exports: {}, require: id => {
    if (!(id in modules)) throw new Error(`Unstubbed import: ${id}`);
    return modules[id];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function provider() {
  let now = 1000000, granted = true;
  const reads = [];
  const bridge = { readUpcomingEventsWindowMsCompletion: (max, window, done) => reads.push({ max, window, done }) };
  const permissions = { hasCalendarPermission: () => granted };
  const clock = { Date: class extends Date { static now() { return now; } } };
  const api = load('app/native/calendar.ios.ts', { './calendar-permissions': permissions }, {
    FaceclawCalendar: { shared: () => bridge }, ...clock,
  });
  const event = (id, extra = {}) => ({ id, title: 'Meeting', startMs: now + 10000, endMs: now + 60000,
    allDay: false, location: 'Office', calendarName: 'Work', ...extra });
  return { api, bridge, reads, permissions, event, clock, advance: ms => { now += ms; }, permission: value => { granted = value; } };
}

test('iOS calendar reads asynchronously, shares pending work, caches, and expires ended events', () => {
  const f = provider(); let changes = 0;
  f.api.onCalendarChanged(() => changes++);
  assert.equal(f.api.readUpcomingEvents().length, 0);
  assert.equal(f.api.getCalendarReadState(), 'loading');
  f.api.readUpcomingEvents(); assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].max, 50); assert.equal(f.reads[0].window, 14 * 86400000);
  f.reads[0].done(JSON.stringify([f.event('one')]), null);
  assert.equal(changes, 1); assert.equal(f.api.getCalendarReadState(), 'ready');
  assert.equal(f.api.readUpcomingEvents()[0].id, 'one'); assert.equal(f.reads.length, 1);
  f.advance(30000); assert.equal(f.api.readUpcomingEvents()[0].id, 'one');
  f.api.readUpcomingEvents(); assert.equal(f.reads.length, 2);
  f.advance(30001); assert.equal(f.api.readUpcomingEvents().length, 0, 'ended events disappear even during refresh');
});

test('iOS calendar preserves recurrence occurrences, all-day fields and overlapping events, and sorts before limiting', () => {
  const f = provider(); f.api.readUpcomingEvents(3, 100000);
  f.reads[0].done(JSON.stringify([
    f.event('series', { startMs: 1080000, endMs: 1090000 }),
    f.event('later', { startMs: 1090000, endMs: 1095000 }),
    f.event('series', { startMs: 1030000, endMs: 1040000 }),
    f.event('all-day', { startMs: 900000, allDay: true, location: '', calendarName: 'Personal' }),
    f.event('ended', { startMs: 900000, endMs: 999999 }),
    f.event('outside', { startMs: 1100000, endMs: 1110000 }),
    f.event('bad', { startMs: null }), f.event('bad-end', { endMs: 'invalid' }), null,
  ]), null);
  const rows = f.api.readUpcomingEvents(3, 100000);
  assert.deepEqual(Array.from(rows, e => e.id), ['all-day', 'series', 'series']);
  assert.equal(rows[0].allDay, true); assert.equal(rows[0].calendarName, 'Personal');
  assert.equal(rows[0].startMs, 900000); assert.equal(rows[0].location, '');
});

test('event-store changes invalidate pending reads and notify only active subscribers', () => {
  const f = provider(); let changes = 0;
  const off = f.api.onCalendarChanged(() => changes++);
  f.api.readUpcomingEvents(); const old = f.reads[0];
  f.bridge.changeHandler(); assert.equal(changes, 1);
  f.api.readUpcomingEvents(); old.done(JSON.stringify([f.event('stale')]), null);
  assert.equal(f.api.getCalendarReadState(), 'loading'); assert.equal(changes, 1);
  f.reads[1].done(JSON.stringify([f.event('fresh')]), null);
  assert.equal(f.api.readUpcomingEvents()[0].id, 'fresh'); assert.equal(changes, 2);
  off(); f.bridge.changeHandler(); assert.equal(changes, 2);
});

test('permission revocation prevents cached and in-flight calendar data from resurfacing', () => {
  const f = provider(); f.api.readUpcomingEvents();
  f.reads[0].done(JSON.stringify([f.event('private')]), null);
  f.permission(false); assert.equal(f.api.readUpcomingEvents().length, 0);
  f.permission(true); f.api.readUpcomingEvents();
  f.permission(false); f.reads[1].done(JSON.stringify([f.event('private')]), null);
  assert.equal(f.api.readUpcomingEvents().length, 0);
  f.permission(true); assert.equal(f.api.readUpcomingEvents().length, 0);
  assert.equal(f.reads.length, 3);
});

test('calendar read failures have a distinct state and retry after the cache interval', () => {
  for (const [json, error] of [['[]', 'Unavailable'], ['bad json', null], ['{}', null]]) {
    const f = provider(); f.api.readUpcomingEvents(); f.reads[0].done(json, error);
    assert.equal(f.api.getCalendarReadState(), 'error');
    assert.equal(f.api.readUpcomingEvents().length, 0); assert.equal(f.reads.length, 1);
    f.advance(30000); f.api.readUpcomingEvents();
    f.reads[1].done('[]', null); assert.equal(f.api.getCalendarReadState(), 'ready');
  }
});

test('calendar input bounds, query changes and force refresh do not reuse the wrong result', () => {
  const f = provider();
  for (const value of [0, -1, NaN, Infinity]) assert.equal(f.api.readUpcomingEvents(value).length, 0);
  f.api.readUpcomingEvents(5, 0); f.api.readUpcomingEvents(5, NaN); assert.equal(f.reads.length, 0);
  f.api.readUpcomingEvents(999, Number.MAX_VALUE);
  assert.equal(f.reads[0].max, 200); assert.equal(f.reads[0].window, 366 * 86400000);
  f.api.readUpcomingEvents(); f.reads[0].done(JSON.stringify([f.event('wrong-query')]), null);
  assert.equal(f.api.readUpcomingEvents().length, 0);
  f.reads[1].done(JSON.stringify([f.event('right-query')]), null);
  assert.equal(f.api.readUpcomingEvents(50, 14 * 86400000, true)[0].id, 'right-query');
  assert.equal(f.reads.length, 3);
});

function permissionFixture(initial = 'not-determined') {
  let status = initial, confirm = true;
  const requests = [], dialogs = [], opened = [];
  const api = load('app/native/calendar-permissions.ios.ts', {
    '@nativescript/core': {
      Dialogs: { confirm: async options => { dialogs.push(options); return confirm; }, alert: async options => { dialogs.push(options); } },
      Utils: { openUrl: async url => opened.push(url) },
    },
  }, { FaceclawCalendar: { shared: () => ({ hasPermission: () => status === 'granted',
    permissionStatus: () => status, requestPermission: done => requests.push(done) }) } });
  return { api, requests, dialogs, opened, status: value => { status = value; }, confirm: value => { confirm = value; } };
}

test('calendar permission requests coalesce, allow write-only upgrades, and propagate failures', async () => {
  for (const status of ['not-determined', 'write-only']) {
    const f = permissionFixture(status);
    assert.equal(f.api.hasCalendarPermission(), false);
    const first = f.api.ensureCalendarPermission(); assert.equal(f.api.ensureCalendarPermission(), first);
    assert.equal(f.requests.length, 1); f.requests[0](false, null); assert.equal(await first, false);
    const retry = f.api.ensureCalendarPermission(); f.requests[1](false, 'Native failure');
    await assert.rejects(retry, /Native failure/);
    const grant = f.api.ensureCalendarPermission(); f.status('granted'); f.requests[2](true, null);
    assert.equal(await grant, true); assert.equal(await f.api.ensureCalendarPermission(), true);
    assert.equal(f.requests.length, 3);
  }
});

test('denied calendar access offers Settings; restricted access explains the restriction', async () => {
  const denied = permissionFixture('denied');
  denied.confirm(false); assert.equal(await denied.api.ensureCalendarPermission(), false);
  assert.equal(denied.opened.length, 0);
  denied.confirm(true); await denied.api.ensureCalendarPermission();
  assert.deepEqual(denied.opened, ['app-settings:']); assert.equal(denied.requests.length, 0);
  const restricted = permissionFixture('restricted'); await restricted.api.ensureCalendarPermission();
  assert.match(restricted.dialogs[0].title, /Restricted/);
  assert.equal(restricted.requests.length, 0); assert.equal(restricted.opened.length, 0);
});

function screenFixture() {
  const f = provider(), timers = new Map(); let nextTimer = 0;
  const font = { lineHeight: 12, measureText: text => text.length * 6 };
  class Image {
    constructor(width = 300, height = 288) { this.width = width; this.height = height; this.text = []; }
    drawText(_font, _x, _y, text) { this.text.push(text); }
    fillRoundedRect() {} drawRoundedRect() {}
  }
  const common = {
    'graphics/image': { GrayImage: Image }, 'graphics/ui-fonts': { getDefaultSmallFont: () => font, getDefaultMediumFont: () => font },
    'graphics/textwrap': { truncateText: (_font, text) => text, wrapText: (_font, text) => [text] },
    'native/calendar': f.api, 'native/calendar-permissions': f.permissions, 'ui/metrics': { lineStep: () => 14 },
    'ui/dashboard-settings': { timeFormatSetting: { get: () => '24h' } }, 'ui/gestures': { GESTURE_CLICK: 'Tap' },
    'util/numeric-util': { clamp: (n, min, max) => Math.max(min, Math.min(max, n)) },
  };
  const modules = depth => Object.fromEntries(Object.entries(common).map(([key, value]) => [depth + key, value]));
  const calendar = load('app/apps/calendar/calendar.ts', modules('../../'));
  const widget = load('app/apps/glanceboard/widgets/calendar-widget.ts', {
    ...modules('../../../'), '../../calendar/calendar': calendar,
  }, { ...f.clock, setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id) });
  return { ...f, ...calendar, ...widget, timers, Image };
}

test('Calendar and Glanceboard show permission, loading, error and event states with widget cleanup', () => {
  const f = screenFixture(); let renders = 0, requests = 0;
  const widget = new f.CalendarWidget(), layer = new f.CalendarLayer(() => requests++);
  const ctx = { stack: { getBaseSize: () => ({ width: 300, height: 288 }) } };
  const paintWidget = () => { const image = new f.Image(); widget.paint(image); return image.text.join(' '); };
  widget.start(() => renders++); widget.start(() => renders++); assert.equal(f.timers.size, 1);
  f.permission(false); assert.match(layer.paint(ctx).text.join(' '), /Grant calendar permission/);
  assert.match(paintWidget(), /permission needed/);
  layer.handleInput({ type: 'click' }); assert.equal(requests, 1); assert.equal(f.reads.length, 0);
  f.permission(true); assert.match(layer.paint(ctx).text.join(' '), /Loading/);
  assert.match(paintWidget(), /Loading/);
  f.reads[0].done('[]', 'Unavailable'); assert.match(layer.paint(ctx).text.join(' '), /unavailable/);
  assert.match(paintWidget(), /unavailable/);
  f.api.invalidateCalendarCache(); layer.paint(ctx);
  f.reads[1].done(JSON.stringify([f.event('event')]), null);
  assert.match(layer.paint(ctx).text.join(' '), /Meeting/);
  assert.match(paintWidget(), /Meeting/);
  widget.stop(); const before = renders; f.bridge.changeHandler();
  assert.equal(renders, before); assert.equal(f.timers.size, 0);
});

test('Calendar window subscribes, refreshes periodically, and cleans up on close', async () => {
  let options, listener, tick, unsubscribed = 0, cleared = 0, closed = 0, renders = 0;
  const app = { requestRender: () => renders++ };
  const { createCalendarAppWindow } = load('app/apps/calendar/calendar-app.ts', {
    '../../native/calendar-permissions': { hasCalendarPermission: () => true },
    '../../native/calendar': { onCalendarChanged: fn => { listener = fn; return () => unsubscribed++; } },
    '../../ui/shell/chrome-layer': { makeImageWindowIcon() {}, windowIcon() {} },
    './calendar': { CalendarLayer: class {} }, './calendar-icon': {},
    '../../ui/shell/in-process-window': { YieldAtRootLayer: class {}, createInProcessWindow: value => { options = value; return app; } },
  }, { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => cleared++ });
  createCalendarAppWindow({ onClosed: () => closed++ });
  listener(); tick(); assert.equal(renders, 2);
  options.onClosed(); assert.equal(unsubscribed, 1); assert.equal(cleared, 1); assert.equal(closed, 1);
});

test('iOS Calendar is launchable and its permission remains optional during onboarding', async () => {
  const availability = load('app/apps/ios-availability.ts');
  assert.equal(availability.iosAppUnavailableReason('calendar'), null);
  const f = permissionFixture(); let resumed;
  const { PermissionsViewModel } = load('app/phone-ui/permissions-view-model.ts', {
    '@nativescript/core': { Observable: class { notifyPropertyChange() {} },
      Application: { on: (_event, fn) => { resumed = fn; }, off() {} } },
    '../native/ios-bluetooth': { iosBluetooth: () => ({ state: 5 }) },
    '../native/calendar-permissions': f.api,
    '../g2/android-permissions': {}, '../native/battery-optimization': {}, '../native/notification-access': {},
  }, { global: { isIOS: true } });
  const model = new PermissionsViewModel({ onboarding: true }); model.onPageLoaded();
  const card = () => model.cards.find(item => item.id === 'calendar');
  assert.equal(card().optionalVisibility, 'visible'); assert.equal(card().checkVisibility, 'collapse');
  assert.equal(model.primaryClass, '-primary');
  model.onCardTap({ object: { bindingContext: card() } }); assert.equal(f.requests.length, 1);
  f.status('granted'); f.requests[0](true, null); await flush();
  assert.equal(card().checkVisibility, 'visible');
  f.status('denied'); resumed(); assert.equal(card().checkVisibility, 'collapse');
});

test('awaited calendar reads do not replace the display cache and reject failures or revoked access', async () => {
  const f = provider(); f.api.readUpcomingEvents();
  const awaited = f.api.readUpcomingEventsAsync(10, 3600000);
  assert.equal(f.reads[1].max, 10); assert.equal(f.reads[1].window, 3600000);
  f.reads[1].done(JSON.stringify([f.event('assistant')]), null);
  assert.equal((await awaited)[0].id, 'assistant');
  assert.equal(f.api.getCalendarReadState(), 'loading');
  f.reads[0].done(JSON.stringify([f.event('display')]), null);
  assert.equal(f.api.readUpcomingEvents()[0].id, 'display');
  const failed = f.api.readUpcomingEventsAsync(); f.reads[2].done('[]', 'Unavailable');
  await assert.rejects(failed, /Unavailable/);
  const revoked = f.api.readUpcomingEventsAsync(); f.permission(false);
  f.reads[3].done(JSON.stringify([f.event('private')]), null);
  await assert.rejects(revoked, /permission/);
  await assert.rejects(f.api.readUpcomingEventsAsync(), /permission/);
  assert.equal(f.reads.length, 4);
});

test('iOS assistant calendar tool awaits events, reports denied access and failures, and leaves unsupported tools hidden', async () => {
  const f = provider(), registered = new Map();
  const { registerSystemTools } = load('app/assistant/system-tools.ts', {
    '../native/calendar': f.api, '../native/calendar-permissions': f.permissions,
    '../native/media-controller': {}, '../native/notification-icons': {}, '../ui/shell/shell': {}, './tool-registry': {},
  }, { global: { isIOS: true } });
  registerSystemTools({ registerSystemTool: (definition, handler) => registered.set(definition.name, handler) });
  assert.deepEqual([...registered.keys()], ['glasses.get_state', 'glasses.show_alert', 'calendar.list_events']);
  const list = registered.get('calendar.list_events');
  const result = list({ within_hours: 2, max_events: 3 });
  assert.equal(f.reads[0].max, 3); assert.equal(f.reads[0].window, 7200000);
  f.reads[0].done(JSON.stringify([f.event('one')]), null);
  assert.match((await result).content, /Meeting.*Office/);
  const empty = list({}); f.reads[1].done('[]', null);
  assert.match((await empty).content, /No upcoming/);
  const failed = list({}); f.reads[2].done('[]', 'Failed'); assert.equal((await failed).ok, false);
  f.permission(false); assert.equal((await list({})).ok, false); assert.equal(f.reads.length, 3);
});
