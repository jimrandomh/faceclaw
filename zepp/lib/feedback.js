// Watch feedback tracks phone handling, never proof of a rendered glasses frame.
const GESTURE_LABELS = {
  click: 'Tap', 'double-click': 'Double tap', 'long-press': 'Long press',
  'short-then-long-press': 'Tap then hold', 'scroll-up': 'Scroll up', 'scroll-down': 'Scroll down',
  'swipe-up': 'Swipe up', 'swipe-down': 'Swipe down', 'swipe-left': 'Swipe left', 'swipe-right': 'Swipe right',
};
const COMMAND_LABELS = {
  'launch-app': 'Open app', 'focus-window': 'Show app', 'close-window': 'Close app',
  sidebar: 'Glasses menu', wake: 'Wake glasses', sleep: 'Sleep glasses', lock: 'Lock glasses',
  unlock: 'Unlock glasses', connect: 'Connect glasses', disconnect: 'Disconnect glasses',
  'close-assistant': 'Close assistant',
};
const STAGES = { queued: 0, sending: 1, 'phone-received': 2 };
const TERMINAL = ['accepted', 'failed', 'unknown', 'blocked', 'skipped'];
let instanceCounter = 0;

export function operationLabel(operation) {
  if (operation && operation.kind === 'gesture') return Object.prototype.hasOwnProperty.call(GESTURE_LABELS, operation.gesture) ? GESTURE_LABELS[operation.gesture] : 'Gesture';
  if (operation && operation.kind === 'command') return Object.prototype.hasOwnProperty.call(COMMAND_LABELS, operation.command) ? COMMAND_LABELS[operation.command] : 'Watch command';
  return operation && operation.kind === 'state' ? 'Refresh status' : 'Watch command';
}

const stageName = value => value === 'waiting' ? 'queued' : value;
const detailLine = value => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.length > 26 ? text.slice(0, 25) + '…' : text;
};

export function createCommandFeedback(onChange, options = {}) {
  const now = options.now || Date.now;
  const startTimer = options.setTimeout || setTimeout, stopTimer = options.clearTimeout || clearTimeout;
  // A page-specific nonce keeps delayed receipts from an earlier page out.
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + (++instanceCounter).toString(36);
  let current = null, timer = null, counter = 0;
  const readNow = () => { const value = now(); return Number.isFinite(value) ? value : 0; };
  const cancelTimer = () => { if (timer !== null) stopTimer(timer); timer = null; };
  const elapsed = record => {
    if (record.pending) record.elapsed = Math.max(record.elapsed, readNow() - record.started);
    return record.elapsed;
  };
  const snapshot = () => {
    if (!current) return null;
    const record = current, seconds = elapsed(record) / 1000;
    let detail;
    if (record.phase === 'queued') detail = 'Waiting · ' + Math.floor(seconds) + 's';
    else if (record.phase === 'sending') detail = 'Sending · ' + Math.floor(seconds) + 's';
    else if (record.phase === 'phone-received') detail = 'Phone received · ' + Math.floor(seconds) + 's';
    else if (record.phase === 'accepted') detail = 'Faceclaw accepted · ' + seconds.toFixed(1) + 's';
    else if (record.phase === 'failed') detail = 'Not accepted';
    else if (record.phase === 'unknown') detail = 'Result unknown';
    else if (record.phase === 'blocked') detail = record.detail || 'Unavailable right now';
    else detail = record.detail || 'Try again';
    return { id: record.id, text: record.label + '\n' + detail, error: record.error, pending: record.pending, phase: record.phase };
  };
  const emit = () => { if (typeof onChange === 'function') onChange(snapshot()); };
  const tick = record => {
    timer = startTimer(() => {
      if (current !== record || !record.pending) return;
      timer = null;
      tick(record);
      emit();
    }, 1000);
  };
  return {
    begin(operation, stage = 'sending') {
      cancelTimer();
      const requested = stageName(stage), phase = Object.prototype.hasOwnProperty.call(STAGES, requested) ? requested : 'sending';
      const record = { id: 'fc-' + nonce + '-' + (++counter).toString(36), label: operationLabel(operation),
        phase, started: readNow(), elapsed: 0, pending: true, error: false, detail: '' };
      current = record;
      tick(record);
      emit();
      return record.id;
    },
    update(id, stage) {
      const phase = stageName(stage);
      if (!current || current.id !== id || !current.pending ||
        !Object.prototype.hasOwnProperty.call(STAGES, phase) || STAGES[phase] <= STAGES[current.phase]) return;
      current.phase = phase;
      emit();
    },
    finish(id, phase, detail) {
      if (!current || current.id !== id || !current.pending || TERMINAL.indexOf(phase) < 0) return;
      const record = current;
      elapsed(record);
      record.pending = false; record.phase = phase; record.detail = detailLine(detail);
      record.error = phase === 'failed' || phase === 'unknown' || phase === 'blocked';
      cancelTimer();
      timer = startTimer(() => {
        if (current !== record || record.pending) return;
        timer = null; current = null; emit();
      }, record.error ? 5000 : 3000);
      emit();
    },
    clear() { cancelTimer(); current = null; emit(); },
    snapshot,
  };
}
