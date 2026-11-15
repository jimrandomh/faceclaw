import * as ui from '@zos/ui';
import * as display from '@zos/display';
import { Screen } from '@zos/sensor';
import { exit } from '@zos/router';
import { onDigitalCrown, offDigitalCrown, onKey, offKey, onGesture, offGesture, KEY_HOME, KEY_SELECT, KEY_BACK, KEY_SHORTCUT, KEY_EVENT_CLICK, GESTURE_UP, GESTURE_DOWN, GESTURE_RIGHT } from '@zos/interaction';
import { BasePage } from '@zeppos/zml/base-page';
import { createCommandFeedback } from '../lib/feedback.js';
import { COLORS, appRows, statusRows, padStatus, moveSelection, createCrownNavigation, createTouchpad } from '../lib/model.js';

Page(BasePage({
  build() {
    // Zepp owns Page.state; keep the phone snapshot in an app-specific field.
    this.alive = true; this.awake = true; this.phoneState = null; this.stateTime = 0; this.busy = false; this.busyKind = ''; this.pendingCrown = null; this.pendingCrownTimer = null; this.navigationEpoch = 0;
    this.screen = 'remote'; this.tray = false; this.selected = 0; this.linkError = ''; this.notice = ''; this.noticeError = false;
    this.groups = { remote: [], list: [], help: [], details: [] }; this.rows = []; this.crown = createCrownNavigation();
    this.pollTimer = null; this.noticeTimer = null; this.clockTimer = null;
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
    this.touch = createTouchpad((gesture, info) => {
      if (!this.alive || !this.awake || this.screen !== 'remote') return;
      if (gesture === 'swipe-up' && info && info.startY >= 410 && !this.tray) { this.cancelPendingCrown(); this.tray = true; this.render(); return; }
      if (gesture === 'swipe-down' && info && info.startY >= 350 && this.tray) { this.cancelPendingCrown(); this.tray = false; this.render(); return; }
      this.gesture(gesture);
    });
    this.pad.addEventListener(ui.event.CLICK_DOWN, info => { this.cancelPendingCrown(); this.touch.down(info.x, info.y, Date.now()); });
    this.pad.addEventListener(ui.event.MOVE, info => this.touch.move(info.x, info.y));
    this.pad.addEventListener(ui.event.CLICK_UP, info => this.touch.up(info.x, info.y, Date.now()));
    this.pad.addEventListener(ui.event.MOVE_OUT, () => this.touch.reset());
    text(110, 44, 260, 40, 28, COLORS.muted, 'remote', 'Faceclaw');
    this.clock = text(70, 170, 340, 94, 78, COLORS.text, 'remote');
    this.padTitle = text(55, 274, 370, 46, 32, COLORS.text, 'remote');
    this.padDetail = text(62, 320, 356, 36, 24, COLORS.muted, 'remote');
    this.reveal = button(110, 384, 260, 54, 'Apps & status', () => {
      this.cancelPendingCrown();
      if (this.linkError) { this.navigate('details'); return; }
      this.touch.reset(); this.tray = true; this.render();
    }, 'remote', 26);
    this.appsButton = button(120, 368, 112, 68, 'Apps', () => this.navigate('apps'), 'remote');
    this.statusButton = button(248, 368, 112, 68, 'Status', () => this.navigate('status'), 'remote');

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
    text(54, 108, 372, 250, 27, COLORS.secondary, 'help', 'Tap: select\nDouble tap: back / wake\nHold: long press\nSwipe: navigate\nCrown: scroll\nApps: press crown to open\nLower side button: quit');
    button(105, 366, 270, 58, 'Back to touchpad', () => this.navigate('remote'), 'help', 26);
    text(90, 56, 300, 44, 32, COLORS.problem, 'details', 'Connection details');
    this.errorDetails = text(66, 118, 348, 232, 29, COLORS.secondary, 'details');
    button(136, 364, 208, 56, 'Retry', () => this.refresh(), 'details', 28);
    button(160, 426, 160, 36, 'Touchpad', () => this.navigate('remote'), 'details', 24);
    // Two-line pill, above the action tray and within the round display.
    this.noticeBg = make(ui.widget.FILL_RECT, { x: 54, y: 98, w: 372, h: 68, radius: 18, color: COLORS.notice });
    this.noticeBg.setEnable(false);
    this.noticeText = text(64, 100, 352, 64, 24, COLORS.text);
    this.commandFeedback = createCommandFeedback(() => this.renderFeedback());

    onDigitalCrown({ callback: (_key, degree) => {
      if (!this.alive || !this.awake) { this.cancelPendingCrown(); this.crown.clearPending(); return; }
      this.touch.reset(); this.keepAwake();
      const step = this.crown.step(degree, Date.now());
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
      this.cancelPendingCrown(); this.touch.reset(); this.keepAwake();
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
      this.awake = this.screenSensor.getStatus() === 1; this.navigationEpoch++;
      this.cancelPendingCrown(); this.commandFeedback.clear(); this.clearNotice(); this.touch.reset(); this.crown.reset(); this.cancelPoll();
      if (this.awake) { this.updateClock(); this.refresh(); } // Never synthesize a glasses tap on wake.
    };
    this.screenSensor.onChange(this.screenChanged);
    this.awake = this.screenSensor.getStatus() === 1;
    this.keepAwake(); this.updateClock(); this.render(); this.refresh();
  },
  keepAwake() {
    if (!this.alive || !this.awake) return;
    try { display.setPageBrightTime({ brightTime: 120000 }); } catch (_) {}
    try { display.pauseDropWristScreenOff({ duration: 120000 }); } catch (_) {}
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
  schedulePoll() {
    this.cancelPoll();
    if (this.alive && this.awake) this.pollTimer = setTimeout(() => this.refresh(), this.linkError ? 6000 : 3000);
  },
  navigate(screen) {
    if (!this.alive) return;
    this.navigationEpoch++;
    this.cancelPendingCrown(); this.commandFeedback.clear(); this.touch.reset(); this.crown.reset(); this.keepAwake();
    this.screen = screen; this.selected = 0; this.clearNotice(); this.render();
    if (screen === 'apps' || screen === 'status') this.refresh();
  },
  select(index, resetCrown = true) {
    this.cancelPendingCrown();
    if (resetCrown) this.crown.reset();
    this.touch.reset(); this.keepAwake(); this.selected = index; this.notice = ''; this.render();
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
    if (pending && this.commandFeedback) this.commandFeedback.finish(pending.id, 'skipped', detail);
  },
  canControl(allowDisconnected = false, feedbackId = null) {
    if (!this.phoneState || this.linkError || Date.now() - this.stateTime > 15000) {
      if (feedbackId) this.commandFeedback.finish(feedbackId, 'blocked', 'Refresh phone first');
      this.setNotice('Refresh the phone connection first.', true); this.refresh(); return false;
    }
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
    this.cancelPendingCrown(); this.notice = '';
    const operation = { kind: 'gesture', gesture };
    const id = this.commandFeedback.begin(operation, this.busy ? 'queued' : 'sending');
    if (!this.canControl(false, id)) return;
    if (!this.phoneState.screenOn || this.phoneState.locked) {
      this.commandFeedback.finish(id, 'blocked', this.phoneState.locked ? 'Glasses are locked' : 'Double tap to wake'); return;
    }
    if (this.busy) {
      // Keep one unsent step; it expires visibly instead of silently disappearing.
      if (this.busyKind !== 'state' && this.busyKind !== 'crown') {
        this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return;
      }
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
    if (age < 0 || age > 350) { this.commandFeedback.finish(pending.id, 'skipped', 'Turn crown again'); return; }
    if (!this.canControl(false, pending.id)) return;
    if (!this.phoneState.screenOn || this.phoneState.locked) {
      this.commandFeedback.finish(pending.id, 'blocked', this.phoneState.locked ? 'Glasses are locked' : 'Double tap to wake'); return;
    }
    this.commandFeedback.update(pending.id, 'sending');
    this.perform({ kind: 'gesture', gesture: pending.gesture }, false, true, pending.id);
  },
  gesture(gesture) {
    if (!this.alive || !this.awake) return;
    this.cancelPendingCrown(); this.notice = '';
    const operation = { kind: 'gesture', gesture }, id = this.commandFeedback.begin(operation);
    if (this.busy) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (!this.canControl(false, id)) return;
    if (this.phoneState.locked && gesture !== 'double-click') {
      this.commandFeedback.finish(id, 'blocked', 'Glasses are locked'); return;
    }
    const wakeGesture = ['click', 'double-click', 'long-press'].indexOf(gesture) >= 0;
    if (!wakeGesture && !this.phoneState.screenOn) {
      this.commandFeedback.finish(id, 'blocked', 'Double tap to wake'); return;
    }
    this.perform(operation, false, false, id);
  },
  activate() {
    this.cancelPendingCrown();
    if (!this.alive || !this.awake) return;
    const row = this.rows[this.selected];
    if (!row) { this.refresh(); return; }
    if (row.operation.kind === 'help') { this.navigate('help'); return; }
    if (row.operation.kind === 'state') { this.refresh(); return; }
    this.notice = '';
    const id = this.commandFeedback.begin(row.operation);
    if (this.busy) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (row.enabled === false) { this.commandFeedback.finish(id, 'blocked', 'Unavailable now'); this.setNotice(row.detail || 'Unavailable right now.', true); return; }
    if (!this.canControl(row.operation.command === 'connect' || row.operation.command === 'disconnect', id)) return;
    this.perform(row.operation, this.screen === 'apps', false, id);
  },
  closeSelected() {
    this.cancelPendingCrown();
    if (!this.alive || !this.awake || this.screen !== 'apps') return;
    const row = this.rows[this.selected];
    if (!row || !row.close) return;
    this.notice = '';
    const id = this.commandFeedback.begin(row.close);
    if (this.busy) { this.commandFeedback.finish(id, 'blocked', 'Busy · Not sent'); return; }
    if (this.canControl(false, id)) this.perform(row.close, false, false, id);
  },
  async exchange(operation, crownScroll = false, feedbackId = null) {
    this.busy = true; this.busyKind = operation.kind === 'state' ? 'state' : crownScroll ? 'crown' : 'action';
    this.cancelPoll();
    if (this.screen === 'remote' && operation.kind !== 'state') this.crown.clearPending();
    this.render();
    let explicitRejection = false;
    try {
      const result = await this.request({ method: 'FACECLAW', operation, ...(feedbackId ? { requestId: feedbackId } : {}) }, { timeout: 11000 });
      if (!result || result.ok !== true) {
        explicitRejection = !!(result && result.ok === false);
        throw new Error(result && result.error || 'No valid reply. Check the phone.');
      }
      return result;
    } catch (error) {
      this.cancelPendingCrown('Not sent');
      const raw = String(error && error.message || 'No phone reply.');
      // Losing transport or receiving a malformed reply cannot establish whether it ran.
      const unknown = operation.kind !== 'state' && (!explicitRejection || /unknown|timeout|timed out/i.test(raw));
      const message = unknown ? 'Result unknown. Check the glasses before trying again.' : raw;
      const currentIntent = !feedbackId || this.feedbackIsCurrent(feedbackId);
      if (feedbackId) this.commandFeedback.finish(feedbackId, unknown ? 'unknown' : 'failed');
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
    const result = await this.exchange({ kind: 'state' });
    if (!this.alive || !result) return;
    // Local list navigation remains live while polling; preserve the latest selection.
    const key = this.rows[this.selected] && this.rows[this.selected].key;
    this.phoneState = result.state; this.stateTime = Date.now(); this.linkError = '';
    if (this.screen === 'details') { this.screen = 'remote'; this.tray = false; }
    this.rows = this.screen === 'apps' ? appRows(this.phoneState) : statusRows(this.phoneState);
    const index = this.rows.findIndex(row => row.key === key);
    this.selected = index < 0 ? moveSelection(this.selected, this.rows.length, 0) : index;
    this.render();
    this.drainCrown();
  },
  async perform(operation, returnToPad = false, crownScroll = false, feedbackId = null) {
    if (!crownScroll) this.cancelPendingCrown();
    if (this.busy || !this.alive || !this.awake) return;
    const id = feedbackId || this.commandFeedback.begin(operation), epoch = this.navigationEpoch;
    this.keepAwake(); this.touch.reset();
    const result = await this.exchange(operation, crownScroll, id);
    if (!this.alive) return;
    if (result && this.awake) {
      // A blocked second press must not cancel the first launch's normal return.
      // Actual navigation or a sleep/wake cycle does cancel that screen change.
      if (returnToPad && epoch === this.navigationEpoch) { this.screen = 'remote'; this.tray = false; this.selected = 0; }
      if (this.feedbackIsCurrent(id)) {
        this.commandFeedback.finish(id, 'accepted');
        if (operation.kind !== 'gesture') this.setNotice(result.message || 'Sent to Faceclaw');
      }
    }
    if (result && crownScroll) {
      // A second status roundtrip used to block every crown step. Normal polling
      // updates the status; only a distinct, still-fresh user step can follow here.
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
    this.reveal.setProperty(ui.prop.MORE, { x: 110, y: 384, w: 260, h: 54, text: this.linkError ? 'Connection details' : 'Apps & status' });
    this.reveal.setProperty(ui.prop.VISIBLE, this.screen === 'remote' && !this.tray);
    this.appsButton.setProperty(ui.prop.VISIBLE, this.screen === 'remote' && this.tray);
    this.statusButton.setProperty(ui.prop.VISIBLE, this.screen === 'remote' && this.tray);
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
      this.empty.setProperty(ui.prop.TEXT, this.linkError ? 'Phone unavailable.\nOpen Connection details on the touchpad.' : 'No app list yet.\nOpen Faceclaw on the phone and connect the glasses.');
      this.listHint.setProperty(ui.prop.TEXT, this.busy ? 'Waiting for phone…' : this.screen === 'status' && selected ? this.fit(selected.detail, 350, 24) : 'Turn crown · Press to open');
    }
    this.renderFeedback();
  },
  renderFeedback() {
    if (!this.alive || !this.noticeText) return;
    const feedback = this.commandFeedback && this.commandFeedback.snapshot();
    const message = feedback ? feedback.text : this.notice;
    const visible = !!message && this.screen !== 'details';
    this.noticeBg.setProperty(ui.prop.VISIBLE, visible); this.noticeText.setProperty(ui.prop.VISIBLE, visible);
    this.noticeBg.setProperty(ui.prop.COLOR, feedback ? feedback.error ? COLORS.errorBg : feedback.pending ? 0x40351b : 0x18352b : this.noticeError ? COLORS.errorBg : COLORS.notice);
    this.noticeText.setProperty(ui.prop.TEXT, message.length > 62 ? message.slice(0, 61) + '…' : message);
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
    this.alive = false; this.cancelPendingCrown(); this.commandFeedback.clear(); this.cancelPoll(); this.crown.reset(); this.touch.reset();
    if (this.clockTimer !== null) clearTimeout(this.clockTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    if (this.screenSensor) this.screenSensor.offChange(this.screenChanged);
    offDigitalCrown(); offKey(); offGesture();
    try { display.resetPageBrightTime(); } catch (_) {}
    try { display.resetDropWristScreenOff(); } catch (_) {}
  },
  onDestroy() { this.dispose(); },
}));
