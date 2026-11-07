// Runs the real AsideLayer, under plain node, against a fake mic, model and
// clock. Bitmap fonts are the real Terminus files the device can use.
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./load-typescript.cjs');

const ROOT = path.resolve(__dirname, '../..');
const WINDOW = { width: 576, height: 260 };

function makeSetting(options) {
  return {
    ...options,
    value: options.defaultValue,
    get() { return this.value; },
    set(value) { this.value = value; return value; },
    displayValue(value = this.value) { return options.formatValue ? options.formatValue(value) : String(value); },
    isDisabled() { return false; },
  };
}

function settingClass() {
  return function Setting(options) { return makeSetting(options); };
}

function createAsideHarness({ model = { provider: 'anthropic', model: 'test-model', apiKey: 'key' } } = {}) {
  const clock = { now: 1_000_000 };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const timers = [];
  const voice = {
    transcript: new Set(),
    pause: new Set(),
    status: new Set(),
    onTranscript(listener) { this.transcript.add(listener); return () => this.transcript.delete(listener); },
    onSpeechPause(listener) { this.pause.add(listener); return () => this.pause.delete(listener); },
    onStatus(listener) {
      this.status.add(listener);
      listener({ status: 'Listening...', listening: true, detail: '' });
      return () => this.status.delete(listener);
    },
    onMicLevel() { return () => {}; },
  };
  const h = {
    clock,
    voice,
    model,
    requests: [],
    cancelled: 0,
    saved: [],
    host: { started: 0, stopped: 0, announced: [], slept: 0, wokeDisplay: false },
    renders: 0,
    visible: true,
    settings: {},
    captureOpen: () => h.host.started > h.host.stopped,
  };
  const textSetting = settingClass();
  const graphics = loader({}, {})('app/graphics/image.ts');
  // Keeps the text of each paint, for asserting on what is on screen.
  class RecordingImage extends graphics.GrayImage {
    constructor(...args) {
      super(...args);
      this.texts = [];
    }
    drawText(font, x, y, text, value) {
      this.texts.push({ text, x, y, gray: value });
      return super.drawText(font, x, y, text, value);
    }
  }
  const { BdfFont } = loader({}, { '@nativescript/core': {} })('app/graphics/bdffont.ts');
  const font = (size) => BdfFont.parse(fs.readFileSync(path.join(ROOT, `app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
  const small = font(12);
  const medium = font(16);
  const menuItem = (setting) => ({ label: setting.label, onSelect() {} });
  const load = loader(
    {
      global: { isIOS: false, isAndroid: true },
      Date: FakeDate,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: (run) => { timers.push(run); return timers.length; },
      clearTimeout() {},
    },
    {
      '../../graphics/image': { ...graphics, GrayImage: RecordingImage },
      '../graphics/image': { ...graphics, GrayImage: RecordingImage },
      '../../graphics/ui-fonts': { getDefaultSmallFont: () => small, getDefaultMediumFont: () => medium },
      '../../native/voice-control': { voiceControlBridge: voice },
      '../native/voice-control': { voiceControlBridge: voice },
      '../../native/file-access': {
        writeTextToDownloads: (filename, text) => {
          h.saved.push({ filename, text });
          return `/downloads/${filename}`;
        },
      },
      '../../ui/dashboard/settings-panel': { openSettingsSubMenu() {} },
      '../../ui/dashboard-settings': {
        ConfigSettingBoolean: textSetting,
        ConfigSettingEnum: textSetting,
        ConfigSettingString: textSetting,
        assistantModelSetting: { isDisabled: () => false },
        enumSettingMenuItem: menuItem,
        textSettingMenuItem: menuItem,
        toggleSettingMenuItem: menuItem,
      },
      '../../assistant/models': { ASSISTANT_MODEL_CHOICES: ['auto', 'sonnet', 'hermes'], assistantModelLabel: (value) => value },
      '../../assistant/feature-model': {
        resolveFeatureModel: () => h.model,
        streamFeatureModel: (_model, request) => {
          h.requests.push(request);
          return { cancel: () => { h.cancelled++; } };
        },
      },
    },
  );
  const settings = load('app/apps/aside/aside-settings.ts');
  const { AsideLayer } = load('app/apps/aside/aside.ts');
  h.settings = settings;

  h.createLayer = ({ noticeSeen = true } = {}) => {
    settings.asideNoticeSeenSetting.set(noticeSeen);
    const layer = new AsideLayer('2026-11-07-090000', {
      startCapture: () => { h.host.started++; },
      stopCapture: () => { h.host.stopped++; },
      announceCue: (cue) => { h.host.announced.push(cue); return h.host.wokeDisplay; },
      sleepDisplay: () => { h.host.slept++; },
    });
    layer.start(() => { h.renders++; }, () => h.visible);
    h.layer = layer;
    return layer;
  };
  const ctx = {
    stack: { getBaseSize: () => WINDOW, pop() { h.popped = (h.popped ?? 0) + 1; } },
    actions: {},
  };
  h.ctx = ctx;
  h.paint = () => h.layer.paint(ctx);
  h.screen = () => h.paint().texts.map((entry) => entry.text).join('\n');
  h.input = (type) => h.layer.handleInput({ type, timestampMs: clock.now }, ctx);
  h.tap = () => h.input('click');
  h.tick = (ms = 500) => {
    clock.now += ms;
    h.layer.onTick();
  };
  h.say = (text, isFinal = true) => {
    for (const listener of voice.transcript) listener({ text, isFinal });
  };
  h.runTimers = () => {
    for (const run of timers.splice(0)) run();
  };
  h.lastRequest = () => h.requests[h.requests.length - 1];
  h.lastPrompt = () => h.lastRequest().messages[0].content;
  h.reply = (text) => h.lastRequest().onDone({ text, content: [], stopReason: 'end_turn' });
  h.menu = () => h.layer.menuItems().map((item) => item.label);
  h.pick = (label) => {
    const item = h.layer.menuItems().find((candidate) => candidate.label === label);
    if (!item) throw new Error(`no menu item ${label}`);
    return item.onSelect(ctx, null);
  };
  return h;
}

module.exports = { createAsideHarness, WINDOW };
