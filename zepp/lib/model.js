export const COLORS = {
  background: 0x000000, primary: 0xb8d8ff, primaryVariant: 0x7fb0f0,
  onPrimary: 0x0b1a2e, text: 0xffffff, secondary: 0xc9c9c9,
  muted: 0x8a8a8a, surface: 0x202020, notice: 0x2a2a2a,
  good: 0x7bd88f, busy: 0xf2c14e, problem: 0xff8a80, errorBg: 0x4a1f1a,
};

export function moveSelection(index, count, delta) {
  return count ? Math.max(0, Math.min(count - 1, index + delta)) : 0;
}

export function appRows(state) {
  if (!state) return [];
  const windowRow = window => ({
    key: 'w:' + window.windowId, title: window.title, section: window.focused ? 'On screen' : 'Also open',
    operation: { kind: 'command', command: 'focus-window', windowId: window.windowId },
    close: window.closeable ? { kind: 'command', command: 'close-window', windowId: window.windowId } : null,
    focused: window.focused,
  });
  return state.windows.filter(w => w.focused).map(windowRow).concat(
    state.windows.filter(w => !w.focused).map(windowRow),
    state.apps.map(app => ({ key: 'a:' + app.appId, title: app.title, section: 'Launch', operation: { kind: 'command', command: 'launch-app', appId: app.appId }, focused: false, close: null })),
  );
}

export function statusRows(state) {
  const connected = !!(state && state.connected), on = !!(state && state.screenOn), locked = !!(state && state.locked);
  const command = name => ({ kind: 'command', command: name });
  return [
    { key: 'connection', title: connected ? 'Connected' : 'Disconnected', detail: connected ? 'Press to disconnect' : 'Press to connect', operation: command(connected ? 'disconnect' : 'connect'), enabled: !!state },
    { key: 'display', title: on ? 'Display on' : 'Display off', detail: on ? 'Press to turn off' : 'Press to wake', operation: command(on ? 'sleep' : 'wake'), enabled: connected && !locked },
    { key: 'lock', title: locked ? 'Locked' : 'Unlocked', detail: locked && !state.canUnlock ? 'Unlock on the phone' : locked ? 'Press to unlock' : 'Press to lock', operation: command(locked ? 'unlock' : 'lock'), enabled: connected && !(locked && !state.canUnlock) },
    { key: 'sidebar', title: 'Glasses menu', detail: 'Open the sidebar', operation: command('sidebar'), enabled: connected },
    { key: 'refresh', title: 'Refresh phone', detail: state && state.version ? 'Faceclaw ' + state.version : 'Open Faceclaw on phone', operation: { kind: 'state' }, enabled: true },
    { key: 'help', title: 'How to use', detail: 'Controls and pairing', operation: { kind: 'help' }, enabled: true },
  ];
}

export function padStatus(state, linkError) {
  if (linkError) return { text: /input token/i.test(linkError) ? 'Check input token' : 'Check phone', detail: 'See connection details', tone: COLORS.problem };
  if (!state) return { text: 'Connecting…', detail: 'Open Faceclaw on phone', tone: COLORS.busy };
  if (!state.remoteEnabled) return { text: 'Watch control off', detail: 'Enable in Faceclaw settings', tone: COLORS.problem };
  if (!state.connected) return { text: state.phase === 'connecting' ? 'Connecting…' : 'Disconnected', detail: 'Open Status to connect', tone: COLORS.busy };
  if (state.charging) return { text: 'Charging' + (state.battery === null ? '' : ' · ' + state.battery + '%'), detail: state.caseBattery === null ? 'Glasses in case' : 'Case ' + state.caseBattery + '%', tone: COLORS.good };
  if (state.silentMode) return { text: 'Silent mode', detail: 'Use the phone to change', tone: COLORS.muted };
  if (state.locked) return { text: 'Locked', detail: state.canUnlock ? 'Open Status to unlock' : 'Unlock on the phone', tone: COLORS.muted };
  if (!state.screenOn) return { text: 'Double tap to wake', detail: 'Glasses display off', tone: COLORS.muted };
  return { text: state.listening ? 'Listening…' : state.foreground && state.foreground.title || 'Launcher', detail: state.preview ? 'Phone preview' : state.battery === null ? 'Connected' : 'G2 · ' + state.battery + '%', tone: COLORS.good };
}

// Positive Zepp degrees are counterclockwise. Clockwise advances a watch
// list; the glasses pad separately respects Faceclaw's crown direction.
// Discard the excess: no queue or delayed scrolling after the hand stops.
export function createCrownNavigation() {
  const stepDegrees = 24, repeatMs = 280, idleMs = 350;
  let pending = 0, lastEvent = null, lastStep = null, lastDirection = 0;
  function reset() { pending = 0; lastEvent = null; lastStep = null; lastDirection = 0; }
  return {
    reset,
    clearPending() { pending = 0; lastEvent = null; },
    step(degree, now) {
      if (!Number.isFinite(degree) || !degree || !Number.isFinite(now)) return 0;
      if (lastEvent !== null && (now < lastEvent || now - lastEvent >= idleMs)) reset();
      lastEvent = now;
      const direction = degree < 0 ? 1 : -1;
      if (pending * degree < 0) pending = 0;
      if (lastStep !== null && direction === lastDirection && now - lastStep < repeatMs) { pending = 0; return 0; }
      pending += degree;
      if (Math.abs(pending) < stepDegrees) return 0;
      pending = 0; lastStep = now; lastDirection = direction;
      return direction;
    },
  };
}

// Zepp gives single-finger coordinates. A hold is sent on release because
// the local API accepts the completed long-press gesture, not a held state.
export function createTouchpad(emit, options = {}) {
  const startTimer = options.setTimeout || setTimeout, stopTimer = options.clearTimeout || clearTimeout;
  let down = null, tapTimer = null, previousTap = null, moved = false;
  const clearTap = () => { if (tapTimer !== null) stopTimer(tapTimer); tapTimer = null; previousTap = null; };
  return {
    reset() { down = null; moved = false; clearTap(); },
    down(x, y, now) {
      if (![x, y, now].every(Number.isFinite)) return;
      const second = previousTap !== null && now - previousTap >= 0 && now - previousTap <= 300;
      if (second) { if (tapTimer !== null) stopTimer(tapTimer); tapTimer = null; }
      down = { x, y, time: now, second }; moved = false;
    },
    move(x, y) { if (down && Math.hypot(x - down.x, y - down.y) > 30) moved = true; },
    up(x, y, now) {
      if (!down || ![x, y, now].every(Number.isFinite)) { down = null; return; }
      const press = down; down = null;
      const dx = x - press.x, dy = y - press.y, duration = now - press.time;
      if (duration < 0) { clearTap(); return; }
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 40) {
        clearTap();
        const gesture = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'swipe-up' : 'swipe-down') : (dx < 0 ? 'swipe-left' : 'swipe-right');
        emit(gesture, { startY: press.y }); return;
      }
      if (moved) { clearTap(); return; }
      if (duration >= 600) { clearTap(); emit(press.second ? 'short-then-long-press' : 'long-press'); return; }
      if (press.second) { clearTap(); emit('double-click'); return; }
      previousTap = now;
      tapTimer = startTimer(() => { tapTimer = null; previousTap = null; emit('click'); }, 300);
    },
  };
}
