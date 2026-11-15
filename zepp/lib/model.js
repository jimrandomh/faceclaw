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
  if (!state.screenOn) return { text: 'Press crown', detail: 'Glasses display off', tone: COLORS.muted };
  return { text: state.listening ? 'Listening…' : state.foreground && state.foreground.title || 'Launcher', detail: state.preview ? 'Phone preview' : state.battery === null ? 'Connected' : 'G2 · ' + state.battery + '%', tone: COLORS.good };
}

// Positive Zepp degrees are counterclockwise. Return clockwise-positive steps;
// the page applies its direction preference consistently at the input boundary.
// Discard the excess: no queue or delayed scrolling after the hand stops.
export function createCrownNavigation() {
  const stepDegrees = 24, repeatMs = 280, idleMs = 350;
  let pending = 0, lastEvent = null, lastStep = null;
  function reset() { pending = 0; lastEvent = null; lastStep = null; }
  return {
    reset,
    clearPending() { pending = 0; lastEvent = null; },
    step(degree, now) {
      if (!Number.isFinite(degree) || !degree || !Number.isFinite(now)) return 0;
      if (lastEvent !== null && (now < lastEvent || now - lastEvent >= idleMs)) reset();
      lastEvent = now;
      const direction = degree < 0 ? 1 : -1;
      if (pending * degree < 0) pending = 0;
      // A sign change can be mechanical bounce, not a second deliberate step.
      // Rate-limit reversals too, without saving excess movement for later.
      if (lastStep !== null && now - lastStep < repeatMs) { pending = 0; return 0; }
      pending += degree;
      if (Math.abs(pending) < stepDegrees) return 0;
      pending = 0; lastStep = now;
      return direction;
    },
  };
}

// Zepp gives single-finger coordinates. Holds emit the same discrete gesture
// at 600ms; no held/released stream or extra gesture is sent on finger-up.
export function createTouchpad(emit, options = {}) {
  const startTimer = options.setTimeout || setTimeout, stopTimer = options.clearTimeout || clearTimeout;
  let down = null, holdTimer = null, tapTimer = null, previousTap = null, downSerial = 0;
  const clearHold = () => { if (holdTimer !== null) stopTimer(holdTimer); holdTimer = null; };
  const clearTap = () => { if (tapTimer !== null) stopTimer(tapTimer); tapTimer = null; previousTap = null; };
  const reset = () => { down = null; clearHold(); clearTap(); };
  const hold = press => {
    if (down !== press || press.moved) return;
    // emit may synchronously call reset or begin another contact.
    reset();
    emit(press.second ? 'short-then-long-press' : 'long-press');
  };
  return {
    reset,
    down(x, y, now) {
      const serial = ++downSerial;
      if (![x, y, now].every(Number.isFinite)) { reset(); return; }
      const gap = previousTap === null ? null : now - previousTap.time;
      const second = gap !== null && gap >= 0 && gap <= 300;
      const overdueTap = gap !== null && gap > 300;
      reset();
      // If a delayed click timer has not run, settle that completed contact
      // before installing this one. It must never fire into the new hold.
      if (overdueTap) emit('click');
      if (serial !== downSerial) return;
      const press = { x, y, time: now, second, moved: false };
      down = press;
      holdTimer = startTimer(() => hold(press), 600);
    },
    move(x, y) {
      if (![x, y].every(Number.isFinite)) { reset(); return; }
      if (down && Math.hypot(x - down.x, y - down.y) > 30) {
        down.moved = true; clearHold();
      }
    },
    up(x, y, now) {
      if (![x, y, now].every(Number.isFinite)) { reset(); return; }
      if (!down) return;
      const press = down; down = null; clearHold();
      const dx = x - press.x, dy = y - press.y, duration = now - press.time;
      if (duration < 0) { clearTap(); return; }
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 40) {
        clearTap();
        const gesture = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'swipe-up' : 'swipe-down') : (dx < 0 ? 'swipe-left' : 'swipe-right');
        emit(gesture, { startY: press.y }); return;
      }
      if (press.moved || Math.hypot(dx, dy) > 30) { clearTap(); return; }
      // Preserve a fallback when the event loop delayed the hold timer.
      if (duration >= 600) { clearTap(); emit(press.second ? 'short-then-long-press' : 'long-press'); return; }
      if (press.second) { clearTap(); emit('double-click'); return; }
      const tap = { time: now };
      previousTap = tap;
      tapTimer = startTimer(() => {
        if (previousTap !== tap) return;
        clearTap();
        emit('click');
      }, 300);
    },
  };
}
