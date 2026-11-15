import * as ui from '@zos/ui';
import * as display from '@zos/display';
import { Screen, Vibrator, VIBRATOR_SCENE_NOTIFICATION } from '@zos/sensor';
import { exit } from '@zos/router';
import { onDigitalCrown, offDigitalCrown, onKey, offKey, onGesture, offGesture, KEY_HOME, KEY_SELECT, KEY_BACK, KEY_SHORTCUT, KEY_EVENT_CLICK, GESTURE_UP, GESTURE_DOWN, GESTURE_RIGHT } from '@zos/interaction';
import { BasePage } from '@zeppos/zml/base-page';
import { createCommandFeedback } from '../lib/feedback.js';
import { createMessagingSession } from '../lib/session.js';
import { COLORS, appRows, statusRows, padStatus, moveSelection, createCrownNavigation, createTouchpad } from '../lib/model.js';

Page(BasePage({
  build() {
    // Zepp owns Page.state; keep the phone snapshot in an app-specific field.
    this.alive = true; this.awake = true; this.phoneState = null; this.stateTime = 0; this.busy = false; this.busyKind = ''; this.pendingCrown = null; this.pendingCrownTimer = null; this.navigationEpoch = 0;
    this.pendingInput = null; this.pendingInputTimer = null; this.touching = false; this.lastInputAt = 0; this.wakeEpoch = 0;
    this.linkSession = createMessagingSession(this.messaging);
    this.navSession = ''; this.navSequence = 0; this.navRequests = new Map(); this.navNeedsRefresh = false;
    this.resetNavigation();
    this.screen = 'remote'; this.selected = 0; this.linkError = ''; this.notice = ''; this.noticeError = false;
    this.groups = { remote: [], list: [], help: [], details: [] }; this.rows = []; this.crown = createCrownNavigation();
    this.pollTimer = null; this.noticeTimer = null; this.clockTimer = null;
    this.feedbackVisible = null; this.feedbackColor = null; this.feedbackText = null;
    this.failureVibrationTimer = null; this.failureVibrator = null;
    try { this.failureVibrator = new Vibrator(); } catch (_) {}
    const make = (type, props, group) => {
      const widget = ui.createWidget(type, props);
      if (group) this.groups[group].push(widget);
      return widget;
    };
    const text = (x, y, w, h, size, color, group, value = '') => {
      const widget = make(ui.widget.TEXT, { x, y, w, h, text: value, text_size: size, color, align_h: ui.align.CENTER_H, align_v: ui.align.CENTER_V, text_style: ui.text_style.WRAP }, group);
      widget.setEnable(false); return widget;
    };
    const button = (x, y, w, h, label, click, group, size = 28, primary = false) => make(ui.widget.BUTTON, {
      x, y, w, h, radius: h / 2, text: label, text_size: size, color: primary ? COLORS.onPrimary : COLORS.secondary,
      normal_color: primary ? COLORS.primary : COLORS.surface, press_color: primary ? COLORS.primaryVariant : 0x404040, click_func: click,
    }, group);
    make(ui.widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: COLORS.background });
    this.pad = make(ui.widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: COLORS.background }, 'remote');
    this.touch = createTouchpad(gesture => {
      if (!this.alive || !this.awake || this.screen !== 'remote') return;
      this.gesture(gesture);
    });
    this.pad.addEventListener(ui.event.CLICK_DOWN, info => {
      this.cancelPendingInput(); this.cancelPendingCrown(); this.touching = true; this.noteActivity(); this.touch.down(info.x, info.y, Date.now());
    });
    this.pad.addEventListener(ui.event.MOVE, info => { if (this.touching) this.noteActivity(); this.touch.move(info.x, info.y); });
    this.pad.addEventListener(ui.event.CLICK_UP, info => { this.touching = false; this.noteActivity(); this.touch.up(info.x, info.y, Date.now()); });
    this.pad.addEventListener(ui.event.MOVE_OUT, () => { this.cancelPendingInput(); this.touching = false; this.touch.reset(); this.noteActivity(); });
    text(110, 44, 260, 40, 28, COLORS.muted, 'remote', 'Faceclaw');
    this.clock = text(70, 170, 340, 94, 78, COLORS.text, 'remote');
    this.padTitle = text(55, 274, 370, 46, 32, COLORS.text, 'remote');
    this.padDetail = text(62, 320, 356, 36, 24, COLORS.muted, 'remote');
    this.appsButton = button(110, 368, 124, 68, 'Apps', () => this.navigate('apps'), 'remote');
    this.statusButton = button(246, 368, 124, 68, 'Status', () => this.navigate(this.linkError ? 'details' : 'status'), 'remote');

    this.smallClock = text(140, 16, 200, 36, 26, COLORS.secondary, 'list');
    this.listHeading = text(80, 60, 320, 40, 28, COLORS.primary, 'list');
    this.rowButtons = [112, 200, 288].map((y, i) => button(i === 1 ? 42 : 62, y, i === 1 ? 396 : 356, 76, '', () => {
      const index = this.selected + i - 1;
      if (index < 0 || index >= this.rows.length) return;
      if (index === this.selected) this.activate(); else this.select(index);
    }, 'list', i === 1 ? 34 : 29, i === 1));
    this.closeButton = button(374, 210, 64, 56, '×', () => this.closeSelected(), 'list', 36);
    this.empty = text(65, 142, 350, 194, 30, COLORS.secondary, 'list');
    this.listHint = text(65, 370, 350, 40, 24, COLORS.muted, 'list');
    this.back = button(160, 418, 160, 42, 'Touchpad', () => this.navigate('remote'), 'list', 25);
    this.position = text(350, 78, 62, 28, 20, COLORS.muted, 'list');

    text(80, 52, 320, 44, 30, COLORS.primary, 'help', 'Faceclaw Remote');
    text(54, 108, 372, 250, 27, COLORS.secondary, 'help', 'Tap: select\nDouble tap: back/sleep/wake\nHold 0.6s: long press\nTap + hold 0.6s: app menu\nSwipe/crown: navigate\nApps: press crown to open\nLower side button: quit');
    button(105, 366, 270, 58, 'Back to touchpad', () => this.navigate('remote'), 'help', 26);
    text(90, 56, 300, 44, 32, COLORS.problem, 'details', 'Connection details');
    this.errorDetails = text(66, 118, 348, 232, 29, COLORS.secondary, 'details');
    button(136, 364, 208, 56, 'Retry', () => this.refresh(), 'details', 28);
    button(160, 426, 160, 36, 'Touchpad', () => this.navigate('remote'), 'details', 24);
    // Two-line pill, above the touchpad and within the round display.
    this.noticeBg = make(ui.widget.FILL_RECT, { x: 54, y: 98, w: 372, h: 68, radius: 18, color: COLORS.notice });
    this.noticeBg.setEnable(false);
    this.noticeText = text(64, 100, 352, 64, 24, COLORS.text);
    this.commandFeedback = createCommandFeedback(() => this.renderFeedback(), { onFailure: () => this.vibrateFailure() });

    onDigitalCrown({ callback: (_key, degree) => {
      if (!this.alive || !this.awake) { this.cancelPendingInput(); this.cancelPendingCrown(); this.crown.clearPending(); return; }
      this.cancelPendingInput(); this.touching = false; this.touch.reset(); this.noteActivity();
      const step = -this.crown.step(degree, Date.now());
      if (!step) return;
      if (this.screen === 'remote') {
        const next = this.phoneState && this.phoneState.crownClockwiseNext;
        this.scrollCrown((step > 0) === next ? 'scroll-down' : 'scroll-up');
      } else if (this.screen === 'apps' || this.screen === 'status') this.select(moveSelection(this.selected, this.rows.length, step), false);
    } });
    onKey({ callback: (key, event) => {
      if (!this.alive || !this.awake || event !== KEY_EVENT_CLICK) return false;
      // Zepp's two-button layout maps the lower button to KEY_SHORTCUT.
      // Retain KEY_BACK as a compatibility path; the crown stays HOME/SELECT.
      if (key === KEY_SHORTCUT || key === KEY_BACK) { this.quitWatch(); return true; }
      if (key !== KEY_HOME && key !== KEY_SELECT) return false;
      this.cancelPendingInput(); this.cancelPendingCrown(); this.touching = false; this.touch.reset(); this.noteActivity();
      if (this.screen === 'remote') {
        if (this.linkError || !this.phoneState) this.refresh(); else this.gesture('click');
      } else if (this.screen === 'help') this.navigate('remote'); else if (this.screen === 'details') this.refresh(); else this.activate();
      return true;
    } });
    onGesture({ callback: gesture => {
      if (this.screen === 'remote') return true; // The pad's coordinates decide its gesture exactly once.
      if (gesture === GESTURE_RIGHT) { this.navigate('remote'); return true; }
      if (this.screen === 'apps' || this.screen === 'status') {
        if (gesture === GESTURE_UP || gesture === GESTURE_DOWN) {
          this.select(moveSelection(this.selected, this.rows.length, gesture === GESTURE_UP ? 1 : -1));
          return true;
        }
      }
      return false;
    } });
    this.screenSensor = new Screen();
    this.screenChanged = () => {
      if (!this.alive) return;
      this.awake = this.screenSensor.getStatus() === 1; this.navigationEpoch++; this.wakeEpoch++; this.brightLeaseAt = 0;
      this.resetNavigation(); this.linkSession.setAwake(this.awake);
      this.stopFailureVibration();
      this.touching = false; this.lastInputAt = Date.now();
      this.cancelPendingInput(); this.cancelPendingCrown(); this.commandFeedback.clear(); this.clearNotice(); this.touch.reset(); this.crown.reset(); this.cancelPoll();
      if (this.awake) { this.updateClock(); this.refresh(); } // Never synthesize a glasses tap on wake.
    };
    this.screenSensor.onChange(this.screenChanged);
    this.awake = this.screenSensor.getStatus() === 1;
    this.linkSession.setAwake(this.awake);
    this.keepAwake(); this.updateClock(); this.render(); this.refresh();
  },
  keepAwake() {
    if (!this.alive || !this.awake) return;
    const now = Date.now();
    if (this.brightLeaseAt && now >= this.brightLeaseAt && now - this.brightLeaseAt < 30000) return;
    this.brightLeaseAt = now;
    try { display.setPageBrightTime({ brightTime: 120000 }); } catch (_) {}
    try { display.pauseDropWristScreenOff({ duration: 120000 }); } catch (_) {}
  },
  stopFailureVibration() {
    if (this.failureVibrationTimer !== null) clearTimeout(this.failureVibrationTimer);
    this.failureVibrationTimer = null;
    try { if (this.failureVibrator) this.failureVibrator.stop(); } catch (_) {}
  },
  vibrateFailure() {
    if (!this.alive || !this.awake || !this.failureVibrator) return;
    this.stopFailureVibration();
    try {
      this.failureVibrator.start({ mode: VIBRATOR_SCENE_NOTIFICATION });
      this.failureVibrationTimer = setTimeout(() => this.stopFailureVibration(), 1000);
    } catch (_) {}
  },
  updateClock() {
    if (this.clockTimer !== null) clearTimeout(this.clockTimer);
    if (!this.alive || !this.awake) return;
    const now = new Date();
    const clock = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
    this.clock.setProperty(ui.prop.TEXT, clock); this.smallClock.setProperty(ui.prop.TEXT, clock);
    this.clockTimer = setTimeout(() => this.updateClock(), 60000 - (Date.now() % 60000));
  },
  cancelPoll() { if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null; },
  noteActivity() {
    this.lastInputAt = Date.now(); this.keepAwake(); this.schedulePoll();
  },
  schedulePoll() {
    this.cancelPoll();
    if (!this.alive || !this.awake || this.busy) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      // Do not take the request slot while a gesture is being recognized.
      if (this.touching || Date.now() - this.lastInputAt < 1000) { this.schedulePoll(); return; }
      this.refresh();
    }, this.linkError ? 6000 : 3000);
  },
  navigate(screen) {
    if (!this.alive) return;
    this.stopFailureVibration();
    this.navigationEpoch++; this.resetNavigation();
    this.cancelPendingInput(); this.cancelPendingCrown(); this.commandFeedback.clear(); this.touching = false; this.touch.reset(); this.crown.reset(); this.noteActivity();
    this.screen = screen; this.selected = 0; this.clearNotice(); this.render();
    if (screen === 'apps' || screen === 'status') this.refresh();
  },
  select(index, resetCrown = true) {
    this.cancelPendingInput(); this.cancelPendingCrown(); this.touching = false;
    if (resetCrown) this.crown.reset();
    this.touch.reset(); this.noteActivity(); this.selected = index; this.notice = '';
    this.renderList(); this.renderFeedback();
  },
  clearNotice() {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null; this.notice = '';
    this.renderFeedback();
  },
  setNotice(message, error = false) {
    if (!this.alive) return;
    this.notice = message; this.noticeError = error;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { if (this.alive) { this.notice = ''; this.render(); } }, error ? 9000 : 2600);
    this.render();
  },
  onCall(message) {
    if (!this.alive || !this.awake || !this.commandFeedback || !message || message.method !== 'FACECLAW_PROGRESS') return;
    const params = message.params;
    if (params && params.stage === 'phone-received' && typeof params.requestId === 'string') {
      this.commandFeedback.update(params.requestId, 'phone-received');
    }
  },
  feedbackIsCurrent(id) {
    const feedback = this.commandFeedback && this.commandFeedback.snapshot();
    return !!(feedback && feedback.id === id);
  },
  cancelPendingCrown(detail = 'Not sent') {
    if (this.pendingCrownTimer !== null) clearTimeout(this.pendingCrownTimer);
    this.pendingCrownTimer = null;
    const pending = this.pendingCrown; this.pendingCrown = null;
    if (pending && this.commandFeedback) this.commandFeedback.finish(pending.id, 'skipped', detail, { silent: true });
  },
  cancelPendingInput(detail = 'Not sent') {
    if (this.pendingInputTimer !== null) clearTimeout(this.pendingInputTimer);
    this.pendingInputTimer = null;
    const pending = this.pendingInput; this.pendingInput = null;
    if (pending && this.commandFeedback) this.commandFeedback.finish(pending.id, 'skipped', detail, { silent: true });
  },
  inputContext() {
    const state = this.phoneState;
    if (!state) return '';
    const focused = state.windows.find(window => window.focused);
    return JSON.stringify([state.screenOn, state.locked, focused ? focused.windowId : state.foreground && state.foreground.appId]);
  },
  queueInput(operation, id, returnToPad = false) {
    this.cancelPendingInput(); this.cancelPendingCrown();
    this.pendingInput = { operation: { ...operation }, id, returnToPad, at: Date.now(),
      epoch: this.navigationEpoch, screen: this.screen, context: this.inputContext(),
      rowKey: this.rows[this.selected] && this.rows[this.selected].key };
    this.pendingInputTimer = setTimeout(() => {
      if (this.pendingInput && this.pendingInput.id === id) this.cancelPendingInput('Please try again');
    }, 1000);
  },
  drainInput() {
    const pending = this.pendingInput;
    if (!pending) return;
    if (this.pendingInputTimer !== null) clearTimeout(this.pendingInputTimer);
    this.pendingInputTimer = null; this.pendingInput = null;
    const age = Date.now() - pending.at, operation = pending.operation;
    if (!this.alive || !this.awake || this.busy || age < 0 || age >= 1000 ||
      this.navigationEpoch !== pending.epoch || this.screen !== pending.screen || !this.feedbackIsCurrent(pending.id)) {
      this.commandFeedback.finish(pending.id, 'skipped', 'Not sent'); return;
    }
    if (!this.canControl(operation.command === 'connect' || operation.command === 'disconnect', pending.id)) return;
    if (operation.kind === 'gesture') {
      if (pending.context !== this.inputContext()) { this.commandFeedback.finish(pending.id, 'skipped', 'Screen changed · Try again'); return; }
      if (!this.canGesture(operation.gesture, pending.id)) return;
    } else {
      if (this.phoneState.locked && ['connect', 'disconnect', 'lock', 'unlock'].indexOf(operation.command) < 0) {
        this.commandFeedback.finish(pending.id, 'blocked', 'Glasses are locked'); return;
      }
      // Revalidate the exact target and action; a status toggle may have reversed.
      const row = this.rows[this.selected];
      const current = row && (operation.command === 'close-window' ? row.close : row.operation);
      if (!row || row.key !== pending.rowKey || row.enabled === false || !current ||
        current.command !== operation.command || current.appId !== operation.appId || current.windowId !== operation.windowId) {
        this.commandFeedback.finish(pending.id, 'skipped', 'List changed · Try again'); return;
      }
    }
    this.commandFeedback.update(pending.id, 'sending');
    this.perform(operation, pending.returnToPad, false, pending.id);
  },
  refreshBeforeInput(feedbackId) {
    // Preparation is not a failed gesture. Refresh automatically, but never
    // replay an input that was recognized against an old snapshot/context.
    if (feedbackId) this.commandFeedback.finish(feedbackId, 'skipped', 'Syncing · Try again', { silent: true });
    this.refresh(); return false;
  },
  canControl(allowDisconnected = false, feedbackId = null, navigation = false) {
    // A same-target navigation ACK renews only directional readiness. Taps,
    // holds and app/status commands still require a recent full state read.
    const time = navigation && this.phoneState && this.phoneState.navigationSupported && !this.navNeedsRefresh
      ? Math.max(this.stateTime, this.navigationTime) : this.stateTime;
    const age = Date.now() - time;
    if (!this.phoneState || this.linkError || age < 0 || age > 15000) return this.refreshBeforeInput(feedbackId);
    if (!this.phoneState.remoteEnabled) {
      if (feedbackId) this.commandFeedback.finish(feedbackId, 'blocked', 'Watch control is off');
      this.setNotice('Enable watch control in Faceclaw.', true); return false;
    }
    if (!allowDisconnected && !this.phoneState.connected) {
      if (feedbackId) this.commandFeedback.finish(feedbackId, 'blocked', 'Glasses disconnected');
      this.setNotice('Connect glasses in Status.', true); return false;
    }
    return true;
  },
  scrollCrown(gesture) {
    if (!this.alive || !this.awake || this.screen !== 'remote') return;
    // Crown movement has no backlog. While a mutation is in flight, consume
    // excess rotation quietly, preserving that command's progress and haptic.
    if (this.busy && this.busyKind !== 'state') { this.crown.clearPending(); return; }
    this.cancelPendingInput(); this.cancelPendingCrown(); this.notice = '';
    const operation = { kind: 'gesture', gesture };
    const id = this.commandFeedback.begin(operation, this.busy ? 'queued' : 'sending');
    if (!this.canControl(false, id, true)) return;
    if (!this.phoneState.screenOn || this.phoneState.locked) {
      this.commandFeedback.finish(id, 'blocked', this.phoneState.locked ? 'Glasses are locked' : 'Double tap to wake'); return;
    }
    if (this.phoneState.navigationSupported && !this.busy) { this.sendNavigation(operation, id); return; }
    if (this.busy) {
      // A read-only status poll may retain just the latest fresh crown intent.
      this.pendingCrown = { gesture, at: Date.now(), id };
      this.pendingCrownTimer = setTimeout(() => {
        if (this.pendingCrown && this.pendingCrown.id === id) this.cancelPendingCrown('Turn crown again');
      }, 350);
      return;
    }
    this.perform(operation, false, true, id);
  },
  drainCrown() {
    const pending = this.pendingCrown;
    if (this.pendingCrownTimer !== null) clearTimeout(this.pendingCrownTimer);
    this.pendingCrownTimer = null; this.pendingCrown = null;
    if (!pending) return;
    if (this.busy || !this.alive || !this.awake || this.screen !== 'remote') {
      this.commandFeedback.finish(pending.id, 'skipped', 'Not sent'); return;
    }
    const age = Date.now() - pending.at;
    if (age < 0 || age > 350) { this.commandFeedback.finish(pending.id, 'skipped', 'Turn crown again', { silent: true }); return; }
    if (!this.canControl(false, pending.id, true)) return;
    if (!this.phoneState.screenOn || this.phoneState.locked) {
      this.commandFeedback.finish(pending.id, 'blocked', this.phoneState.locked ? 'Glasses are locked' : 'Double tap to wake'); return;
    }
    this.commandFeedback.update(pending.id, 'sending');
    this.perform({ kind: 'gesture', gesture: pending.gesture }, false, true, pending.id);
  },
  gesture(gesture) {
    if (!this.alive || !this.awake) return;
    this.cancelPendingInput(); this.cancelPendingCrown(); this.notice = ''; this.noteActivity();
    const polling = this.busy && this.busyKind === 'state';
    const operation = { kind: 'gesture', gesture }, id = this.commandFeedback.begin(operation, polling ? 'queued' : 'sending');
    if (this.phoneState && this.phoneState.navigationSupported && /^(swipe|scroll)-/.test(gesture) && (!this.busy || this.busyKind === 'navigation')) {
      if (!this.canControl(false, id, true) || !this.canGesture(gesture, id)) return;
      this.sendNavigation(operation, id); return;
    }
    if (this.busy && !polling) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (!this.canControl(false, id)) return;
    if (!this.canGesture(gesture, id)) return;
    if (polling) { this.queueInput(operation, id); return; }
    this.perform(operation, false, false, id);
  },
  canGesture(gesture, id) {
    if (this.phoneState.locked && gesture !== 'double-click') {
      this.commandFeedback.finish(id, 'blocked', 'Glasses are locked'); return false;
    }
    const wakeGesture = ['click', 'double-click', 'long-press'].indexOf(gesture) >= 0;
    if (!wakeGesture && !this.phoneState.screenOn) {
      this.commandFeedback.finish(id, 'blocked', 'Double tap to wake'); return false;
    }
    return true;
  },
  activate() {
    this.cancelPendingInput(); this.cancelPendingCrown(); this.noteActivity();
    if (!this.alive || !this.awake) return;
    const row = this.rows[this.selected];
    if (!row) { this.refresh(); return; }
    if (row.operation.kind === 'help') { this.navigate('help'); return; }
    if (row.operation.kind === 'state') { this.refresh(); return; }
    this.notice = '';
    const polling = this.busy && this.busyKind === 'state';
    const id = this.commandFeedback.begin(row.operation, polling ? 'queued' : 'sending');
    if (this.busy && !polling) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (row.enabled === false) { this.commandFeedback.finish(id, 'blocked', 'Unavailable now'); this.setNotice(row.detail || 'Unavailable right now.', true); return; }
    if (!this.canControl(row.operation.command === 'connect' || row.operation.command === 'disconnect', id)) return;
    if (polling) { this.queueInput(row.operation, id, this.screen === 'apps'); return; }
    this.perform(row.operation, this.screen === 'apps', false, id);
  },
  closeSelected() {
    this.cancelPendingInput(); this.cancelPendingCrown(); this.noteActivity();
    if (!this.alive || !this.awake || this.screen !== 'apps') return;
    const row = this.rows[this.selected];
    if (!row || !row.close) return;
    this.notice = '';
    const polling = this.busy && this.busyKind === 'state';
    const id = this.commandFeedback.begin(row.close, polling ? 'queued' : 'sending');
    if (this.busy && !polling) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (!this.canControl(false, id)) return;
    if (polling) { this.queueInput(row.close, id); return; }
    this.perform(row.close, false, false, id);
  },
  resetNavigation() {
    if (this.navSession) this.linkSession.cancelNavigation(this.navSession);
    this.navSession = 'nav-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    this.navSequence = 0; this.navNeedsRefresh = true; this.navigationTime = 0;
    if (this.phoneState) this.phoneState.navigationSupported = false;
  },
  async sendNavigation(operation, id) {
    if (this.busy && this.busyKind !== 'navigation') {
      this.commandFeedback.finish(id, 'blocked', 'Finish current action'); return;
    }
    if (this.navNeedsRefresh || !this.phoneState.navigationContext) {
      this.refreshBeforeInput(id); return;
    }
    if (this.navRequests.size >= 4) { this.commandFeedback.finish(id, 'blocked', 'Too many swipes · Not sent'); return; }
    const sessionId = this.navSession, context = this.phoneState.navigationContext, sentAt = Date.now();
    this.navRequests.set(id, { context }); this.busy = true; this.busyKind = 'navigation';
    // Feedback already updated the small progress pill. Avoid native layout and
    // visibility writes on the touchpad's hot path before handing off the input.
    this.cancelPoll(); this.keepAwake();
    let result, failure;
    try {
      result = await this.request({ method: 'FACECLAW', operation, requestId: id,
        navigation: { sessionId, sequence: ++this.navSequence, context } }, { timeout: 11000 });
    } catch (error) { failure = error; }
    this.navRequests.delete(id);
    if (!this.alive) return;
    if (sessionId !== this.navSession) {
      this.commandFeedback.finish(id, 'skipped', 'Not sent', { silent: true });
      if (!this.navRequests.size && this.busyKind === 'navigation') {
        this.busy = false; this.busyKind = ''; if (this.awake) this.refresh();
      }
      return;
    }
    if (result && result.ok === true) {
      this.commandFeedback.finish(id, 'accepted');
      if (!result.navigation || result.navigation.version !== 1 || result.navigation.context !== context) this.navNeedsRefresh = true;
      // The phone rechecks permission, lock, connection, target and expiry for
      // each direction. Use send time so a delayed ACK cannot inflate the lease;
      // another failed/context-changing reply in this burst must keep it closed.
      else if (!this.navNeedsRefresh) this.navigationTime = Math.max(this.navigationTime, sentAt);
    } else if (result && result.notSent === true || failure && failure.notSent === true) {
      this.commandFeedback.finish(id, 'skipped', result && result.code === 'expired' ? 'Swipe expired · Not sent' : 'Not sent · Refresh phone');
      this.navNeedsRefresh = true;
    } else {
      this.commandFeedback.finish(id, 'unknown');
      this.setNotice('Result unknown. Check the glasses before trying again.', true);
      this.linkSession.cancelNavigation(sessionId); this.linkSession.invalidate('Navigation failed'); this.resetNavigation();
      if (!this.navRequests.size) { this.busy = false; this.busyKind = ''; this.refresh(); }
      return;
    }
    if (this.navNeedsRefresh) this.linkSession.cancelNavigation(sessionId);
    if (!this.navRequests.size) {
      this.busy = false; this.busyKind = '';
      if (this.navNeedsRefresh) { this.resetNavigation(); this.refresh(); } else this.schedulePoll();
    }
  },
  async exchange(operation, crownScroll = false, feedbackId = null) {
    this.busy = true; this.busyKind = operation.kind === 'state' ? 'state' : crownScroll ? 'crown' : 'action';
    this.cancelPoll();
    if (this.screen === 'remote' && operation.kind !== 'state') this.crown.clearPending();
    this.render();
    let explicitRejection = false;
    try {
      const result = await this.request({ method: 'FACECLAW', operation,
        ...(operation.kind === 'state' ? { navSession: this.navSession, stateScope: this.screen === 'apps' ? 'full' : 'compact' } : {}),
        ...(feedbackId ? { requestId: feedbackId } : {}) }, { timeout: 11000 });
      if (!result || result.ok !== true) {
        explicitRejection = !!(result && result.ok === false);
        throw new Error(result && result.error || 'No valid reply. Check the phone.');
      }
      return result;
    } catch (error) {
      this.linkSession.invalidate('Request failed');
      this.cancelPendingInput('Not sent');
      this.cancelPendingCrown('Not sent');
      const raw = String(error && error.message || 'No phone reply.');
      // Losing transport or receiving a malformed reply cannot establish whether it ran.
      const notSent = !!(error && error.notSent === true);
      const unknown = operation.kind !== 'state' && !notSent && (!explicitRejection || /unknown|timeout|timed out/i.test(raw));
      const message = unknown ? 'Result unknown. Check the glasses before trying again.' : raw;
      const currentIntent = !feedbackId || this.feedbackIsCurrent(feedbackId);
      if (feedbackId) this.commandFeedback.finish(feedbackId, unknown ? 'unknown' : notSent ? 'blocked' : 'failed', notSent ? 'Not sent · Refresh phone' : undefined);
      if (this.alive) {
        if (operation.kind === 'state') this.linkError = message.slice(0, 180);
        if (this.awake && currentIntent) this.setNotice(message.slice(0, 120), true);
      }
      return null;
    } finally {
      this.busy = false; this.busyKind = '';
      if (this.alive) { this.render(); this.schedulePoll(); }
    }
  },
  async refresh() {
    if (this.busy || !this.alive || !this.awake) return;
    const wakeEpoch = this.wakeEpoch, navSession = this.navSession;
    const result = await this.exchange({ kind: 'state' });
    if (!this.alive) return;
    // A reply begun before sleep cannot establish current readiness on wake.
    if (!this.awake || wakeEpoch !== this.wakeEpoch || navSession !== this.navSession) { if (this.awake) this.refresh(); return; }
    if (!result) return;
    // Local list navigation remains live while polling; preserve the latest selection.
    const key = this.rows[this.selected] && this.rows[this.selected].key;
    this.phoneState = result.state; this.navNeedsRefresh = false; this.stateTime = Date.now(); this.linkError = '';
    if (this.screen === 'details') this.screen = 'remote';
    this.rows = this.screen === 'apps' ? appRows(this.phoneState) : statusRows(this.phoneState);
    const index = this.rows.findIndex(row => row.key === key);
    this.selected = index < 0 ? moveSelection(this.selected, this.rows.length, 0) : index;
    this.render();
    this.drainInput();
    this.drainCrown();
  },
  async perform(operation, returnToPad = false, crownScroll = false, feedbackId = null) {
    if (!crownScroll) this.cancelPendingCrown();
    if (this.busy || !this.alive || !this.awake) return;
    const id = feedbackId || this.commandFeedback.begin(operation), epoch = this.navigationEpoch;
    if (operation.kind === 'gesture' && /^(swipe|scroll)-/.test(operation.gesture) && this.phoneState.navigationSupported) { this.sendNavigation(operation, id); return; }
    this.keepAwake(); this.touch.reset();
    if (operation.kind !== 'state') this.resetNavigation();
    const result = await this.exchange(operation, crownScroll, id);
    if (!this.alive) return;
    if (result && this.awake) {
      // A blocked second press must not cancel the first launch's normal return.
      // Actual navigation or a sleep/wake cycle does cancel that screen change.
      if (returnToPad && epoch === this.navigationEpoch) { this.screen = 'remote'; this.selected = 0; }
      this.commandFeedback.finish(id, 'accepted');
      if (this.feedbackIsCurrent(id) && operation.kind !== 'gesture') this.setNotice(result.message || 'Sent to Faceclaw');
    }
    if (result && operation.kind === 'gesture' && /^(swipe|scroll)-/.test(operation.gesture) && epoch === this.navigationEpoch) {
      // Directional navigation needs no second request before the next step.
      // Taps/holds can change display or lock state, so those still refresh.
      this.drainCrown();
      return;
    }
    // Refresh is read-only. A failed or timed-out command is never repeated.
    this.refresh();
  },
  fit(value, width, size) {
    try {
      const result = ui.getTextLayout(value, { text_size: size, text_width: width, wrapped: 1, rows_max: 1 });
      if (typeof result.text === 'string') return result.text;
    } catch (_) {}
    const max = Math.floor(width / (size * 0.61));
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  },
  render() {
    if (!this.alive) return;
    Object.keys(this.groups).forEach(group => this.groups[group].forEach(widget => widget.setProperty(ui.prop.VISIBLE,
      group === this.screen || group === 'remote' && this.screen === 'remote' || group === 'list' && (this.screen === 'apps' || this.screen === 'status'))));
    const pad = padStatus(this.phoneState, this.linkError);
    this.padTitle.setProperty(ui.prop.TEXT, this.fit(pad.text, 370, 32));
    this.padTitle.setProperty(ui.prop.COLOR, pad.tone === COLORS.good ? COLORS.text : pad.tone);
    this.padDetail.setProperty(ui.prop.TEXT, this.fit(pad.detail, 356, 24));
    this.errorDetails.setProperty(ui.prop.TEXT, this.linkError || 'Phone connected.');
    this.renderList();
    this.renderFeedback();
  },
  renderList() {
    if (!this.alive) return;
    if (this.screen === 'apps' || this.screen === 'status') {
      this.rows = this.screen === 'apps' ? appRows(this.phoneState) : statusRows(this.phoneState);
      this.selected = moveSelection(this.selected, this.rows.length, 0);
      const selected = this.rows[this.selected];
      this.listHeading.setProperty(ui.prop.TEXT, this.screen === 'status' ? 'Glasses & phone' : selected ? selected.section : 'Apps');
      this.position.setProperty(ui.prop.TEXT, this.rows.length ? (this.selected + 1) + '/' + this.rows.length : '');
      this.rowButtons.forEach((widget, i) => {
        const row = this.rows[this.selected + i - 1], selectedRow = i === 1;
        const canClose = selectedRow && row && row.close;
        const width = selectedRow ? canClose ? 320 : 396 : 356;
        widget.setProperty(ui.prop.MORE, {
          x: selectedRow ? 42 : 62, y: [112, 200, 288][i], w: width, h: 76,
          text: row ? this.fit(row.title, width - 30, selectedRow ? 34 : 29) : '',
          color: selectedRow ? COLORS.onPrimary : row && row.focused ? COLORS.primary : COLORS.secondary,
        });
        widget.setProperty(ui.prop.VISIBLE, !!row);
      });
      this.closeButton.setProperty(ui.prop.VISIBLE, !!(selected && selected.close));
      this.empty.setProperty(ui.prop.VISIBLE, !this.rows.length);
      this.empty.setProperty(ui.prop.TEXT, this.linkError ? 'Phone unavailable.\nTap Status on the touchpad for details.' : 'No app list yet.\nOpen Faceclaw on the phone and connect the glasses.');
      this.listHint.setProperty(ui.prop.TEXT, this.busy ? 'Waiting for phone…' : this.screen === 'status' && selected ? this.fit(selected.detail, 350, 24) : 'Turn crown · Press to open');
    }
  },
  renderFeedback() {
    if (!this.alive || !this.noticeText) return;
    const feedback = this.commandFeedback && this.commandFeedback.snapshot();
    const message = feedback ? feedback.text : this.notice;
    const visible = !!message && this.screen !== 'details';
    const color = feedback ? feedback.error ? COLORS.errorBg : feedback.pending ? 0x40351b : 0x18352b : this.noticeError ? COLORS.errorBg : COLORS.notice;
    const text = message.length > 62 ? message.slice(0, 61) + '…' : message;
    if (visible !== this.feedbackVisible) {
      this.noticeBg.setProperty(ui.prop.VISIBLE, visible); this.noticeText.setProperty(ui.prop.VISIBLE, visible); this.feedbackVisible = visible;
    }
    if (color !== this.feedbackColor) { this.noticeBg.setProperty(ui.prop.COLOR, color); this.feedbackColor = color; }
    if (text !== this.feedbackText) { this.noticeText.setProperty(ui.prop.TEXT, text); this.feedbackText = text; }
  },
  quitWatch() {
    if (!this.alive) return;
    // Stop timers/input before leaving, even if a phone request is pending.
    // This exits only the watch miniapp; it sends no glasses command.
    this.dispose();
    exit();
  },
  dispose() {
    if (!this.alive) return;
    this.stopFailureVibration();
    this.resetNavigation(); this.linkSession.dispose();
    this.alive = false; this.touching = false; this.cancelPendingInput(); this.cancelPendingCrown(); this.commandFeedback.clear(); this.cancelPoll(); this.crown.reset(); this.touch.reset();
    if (this.clockTimer !== null) clearTimeout(this.clockTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    if (this.screenSensor) this.screenSensor.offChange(this.screenChanged);
    offDigitalCrown(); offKey(); offGesture();
    try { display.resetPageBrightTime(); } catch (_) {}
    try { display.resetDropWristScreenOff(); } catch (_) {}
  },
  onDestroy() { this.dispose(); },
}));
