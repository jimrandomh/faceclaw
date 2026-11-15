import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../lib/model.js';
import * as feedback from '../lib/feedback.js';

export const sampleState = {
  protocol: 1, version: '0.1.0', phase: 'connected', connected: true, preview: false,
  screenOn: true, locked: false, canUnlock: true, charging: false, silentMode: false,
  listening: false, remoteEnabled: true, crownClockwiseNext: false, battery: 78, caseBattery: 64,
  foreground: { appId: 'music', title: 'Music' },
  windows: [
    { windowId: 'music:1', appId: 'music', title: 'Music', focused: true, closeable: true },
    { windowId: 'notes:2', appId: 'notes', title: 'Notes', focused: false, closeable: true },
    { windowId: 'launcher:1', appId: 'launcher', title: 'Launcher', focused: false, closeable: false },
  ],
  apps: [{ appId: 'timer', title: 'Timer' }, { appId: 'navigation', title: 'Navigation' }, { appId: 'translator', title: 'Translation' }],
};

export function watchFixture({ fixedFrameworkState = true } = {}) {
  const code = fs.readFileSync(new URL('../page/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  let page, key, crown, gesture, screenListener, screenStatus = 1, now = 1760545800000;
  const calls = [], requests = [], pending = [], widgets = [], timers = new Map(); let timer = 0, exits = 0;
  const frameworkState = { messaging: Object.freeze({ frameworkTransport: true }) };
  const setTimer = (fn, delay) => { timers.set(++timer, { fn, at: now + delay }); return timer; };
  const clearTimer = id => timers.delete(id);
  const ui = {
    widget: { TEXT: 'text', BUTTON: 'button', FILL_RECT: 'rect' },
    prop: { TEXT: 'text', VISIBLE: 'visible', COLOR: 'color', MORE: 'more' },
    event: { CLICK_DOWN: 'down', CLICK_UP: 'up', MOVE: 'move', MOVE_OUT: 'cancel' }, align: {}, text_style: {},
    createWidget(type, props) {
      const widget = { type, props: { ...props }, events: {}, enabled: true,
        setProperty(key, value) {
          if (key === 'more') {
            if (type === 'button' && !['x', 'y', 'w', 'h'].every(key => Number.isFinite(value[key]))) throw new Error('Zepp BUTTON MORE requires x/y/w/h');
            Object.assign(this.props, value);
          } else this.props[key] = value;
        },
        setEnable(enabled) { this.enabled = enabled; }, addEventListener(event, callback) { this.events[event] = callback; },
      }; widgets.push(widget); return widget;
    },
  };
  vm.runInNewContext(code, {
    ...model, ...feedback, ui, display: { setPageBrightTime() {}, pauseDropWristScreenOff() {}, resetPageBrightTime() {}, resetDropWristScreenOff() {} },
    createTouchpad: emit => model.createTouchpad(emit, { setTimeout: setTimer, clearTimeout: clearTimer }),
    createCommandFeedback: onChange => feedback.createCommandFeedback(onChange, { now: () => now, setTimeout: setTimer, clearTimeout: clearTimer }),
    exit: () => { exits++; },
    Screen: class { getStatus() { return screenStatus; } onChange(callback) { screenListener = callback; } offChange() { screenListener = null; } },
    Page: value => {
      page = value;
      // The Balance retains this framework-owned object: replacing page.state is ignored.
      // Mirror that verified behavior so phone snapshots cannot silently collide with ZML.
      if (fixedFrameworkState) Object.defineProperty(page, 'state', {
        enumerable: true, configurable: false,
        get: () => frameworkState, set() {},
      });
    }, BasePage: value => value,
    onKey: ({ callback }) => key = callback, onDigitalCrown: ({ callback }) => crown = callback, onGesture: ({ callback }) => gesture = callback,
    offKey() {}, offDigitalCrown() {}, offGesture() {}, KEY_HOME: 1, KEY_SELECT: 2, KEY_BACK: 3, KEY_SHORTCUT: 8, KEY_EVENT_CLICK: 4, GESTURE_UP: 5, GESTURE_DOWN: 6, GESTURE_RIGHT: 7,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout: setTimer, clearTimeout: clearTimer,
  });
  page.request = req => { requests.push(req); calls.push(req.operation); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  page.build();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    page, calls, requests, widgets, timers, ui, exits: () => exits,
    key: (code = 1, event = 4) => key(code, event),
    crown: (degree = -24, elapsed = 350) => { now += elapsed; crown(1, degree); },
    gesture: value => gesture(value),
    touch: (event, x, y, elapsed = 0) => { now += elapsed; page.pad.events[event]({ x, y }); },
    advance(ms) {
      now += ms;
      const ready = [...timers].filter(([, value]) => value.at <= now);
      for (const [id, value] of ready) { if (timers.delete(id)) value.fn(); }
    },
    screen: value => { screenStatus = value; screenListener?.(); },
    reply: async (result = { ok: true, state: sampleState }) => { if (!pending.length) throw new Error('No pending request'); pending.shift().resolve(result); await flush(); },
    reject: async message => { pending.shift().reject(new Error(message)); await flush(); },
    now: () => now,
  };
}
