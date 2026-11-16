const test = require('node:test')
const assert = require('node:assert/strict')
const {
  KEY_ACTIONS, MAX_KEY_BINDINGS, GestureScheme, chordId, chordOf, defaultKeyAction, describeChord, gestureRepeats,
  isModifierCode, keyActionLabel, keyBindingMap, parseChordId, parseKeyBindings, resolveKey, serializeKeyBindings,
} = require('../.test-build/app/g2/keyboard/bindings.js')
const { KeyRouter } = require('../.test-build/app/g2/keyboard/key-router.js')

const key = (k, overrides = {}) => ({
  phase: 'down', key: k, code: overrides.code ?? k, repeat: false, timestampMs: 0,
  ...overrides, modifiers: { shift: false, ctrl: false, alt: false, meta: false, ...overrides.modifiers },
})
const chord = (code, mods = {}) => ({ code, shift: false, ctrl: false, alt: false, meta: false, ...mods })
const none = new Map()

test('built-in keys: arrows are the watch\'s swipes, Enter selects, Esc backs out', () => {
  const action = (k, overrides) => defaultKeyAction(key(k, overrides))
  assert.deepEqual(action('ArrowLeft'), { action: 'swipe-left', overridesTyping: false })
  assert.deepEqual(action('ArrowRight'), { action: 'swipe-right', overridesTyping: false })
  assert.deepEqual(action('ArrowUp'), { action: 'swipe-up', overridesTyping: false })
  assert.deepEqual(action('ArrowDown'), { action: 'swipe-down', overridesTyping: false })
  assert.deepEqual(action('Enter'), { action: 'click', overridesTyping: false })
  assert.deepEqual(action('Enter', { code: 'NumpadEnter' }), { action: 'click', overridesTyping: false })
  assert.deepEqual(action('Escape'), { action: 'double-click', overridesTyping: false })
  // With a modifier, Escape means "back" even where keys are being typed.
  for (const modifier of ['shift', 'ctrl', 'alt']) {
    assert.deepEqual(action('Escape', { modifiers: { [modifier]: true } }), { action: 'double-click', overridesTyping: true })
  }
  assert.equal(action('Escape', { modifiers: { meta: true } }), null)
  assert.equal(action('ArrowLeft', { modifiers: { ctrl: true } }), null)
  assert.equal(action('Enter', { modifiers: { alt: true } }), null)
  for (const k of ['a', ' ', 'Backspace', 'Tab', 'F1', 'AudioVolumeUp']) assert.equal(action(k), null)
})

test('chords: canonical ids round-trip, and read naturally', () => {
  const c = chord('Escape', { shift: true, ctrl: true })
  assert.equal(chordId(c), 'Ctrl+Shift+Escape'); assert.deepEqual(parseChordId('Ctrl+Shift+Escape'), c)
  assert.deepEqual(parseChordId('ArrowLeft'), chord('ArrowLeft'))
  assert.deepEqual(chordOf(key('A', { code: 'KeyA', modifiers: { shift: true } })), chord('KeyA', { shift: true }))
  for (const bad of ['', 'Shift+', 'Shift+Shift+KeyA', 'Hyper+KeyA', 'ShiftLeft', 'Ctrl+ControlRight', 'Key A', '+'.repeat(3)]) {
    assert.equal(parseChordId(bad), null, bad)
  }
  assert.equal(isModifierCode('AltRight'), true); assert.equal(isModifierCode('CapsLock'), false)
  const said = (code, mods) => describeChord(chord(code, mods))
  assert.equal(said('Escape', { shift: true }), 'Shift+Esc'); assert.equal(said('ArrowLeft'), 'Left')
  assert.equal(said('KeyA', { ctrl: true, alt: true }), 'Ctrl+Alt+A'); assert.equal(said('Digit7'), '7')
  assert.equal(said('AudioVolumeUp'), 'Volume Up'); assert.equal(said('MediaPlayPause'), 'Play/Pause')
  assert.equal(said('NumpadEnter'), 'Numpad Enter'); assert.equal(said('F5'), 'F5'); assert.equal(said('Slash'), '/')
  // A remote's unnamed buttons keep the only name they have.
  assert.equal(said('Consumer1cb'), 'Media key 0x1cb'); assert.equal(said('Usagea5'), 'Key 0xa5')
})

test('custom keybindings survive storage; junk in storage is dropped', () => {
  const bindings = [
    { chord: chord('AudioVolumeUp'), action: 'scroll-up' },
    { chord: chord('KeyQ', { ctrl: true }), action: 'long-press' },
    { chord: chord('ArrowLeft'), action: 'none' },
  ]
  assert.deepEqual(parseKeyBindings(serializeKeyBindings(bindings)), bindings)
  assert.deepEqual([...keyBindingMap(bindings)], [['AudioVolumeUp', 'scroll-up'], ['Ctrl+KeyQ', 'long-press'], ['ArrowLeft', 'none']])
  assert.deepEqual(parseKeyBindings(''), []); assert.deepEqual(parseKeyBindings('{'), []); assert.deepEqual(parseKeyBindings('{"a":1}'), [])
  assert.deepEqual(parseKeyBindings(JSON.stringify([
    null, 7, { key: 'KeyA' }, { key: 'KeyA', action: 'explode' }, { key: 'Shift+ShiftLeft', action: 'click' },
    { key: 'KeyB', action: 'click' }, { key: 'KeyB', action: 'double-click' },
  ])), [{ chord: chord('KeyB'), action: 'double-click' }])
  const many = Array.from({ length: 200 }, (_, i) => ({ key: `F${i + 1}`, action: 'click' }))
  assert.equal(parseKeyBindings(JSON.stringify(many)).length, MAX_KEY_BINDINGS)
  // Every action has a label for the picker, and the list has no duplicates.
  assert.equal(new Set(KEY_ACTIONS.map(a => a.action)).size, KEY_ACTIONS.length)
  assert.equal(keyActionLabel('double-click'), 'Back'); assert.equal(keyActionLabel('none'), 'Nothing')
})

test('resolution: custom first and everywhere, then the built-ins; "Nothing" only removes the built-in', () => {
  const custom = keyBindingMap([
    { chord: chord('AudioVolumeUp'), action: 'scroll-up' },
    { chord: chord('ArrowLeft'), action: 'double-click' },
    { chord: chord('ArrowRight'), action: 'none' },
    { chord: chord('Escape', { shift: true }), action: 'none' },
  ])
  // Unbound keys: typed where something takes keys, otherwise the built-in.
  assert.deepEqual(resolveKey(key('a', { code: 'KeyA' }), custom), { consume: false, gesture: null })
  assert.deepEqual(resolveKey(key('ArrowUp'), custom), { consume: false, gesture: 'swipe-up' })
  assert.deepEqual(resolveKey(key('Escape'), custom), { consume: false, gesture: 'double-click' })
  assert.deepEqual(resolveKey(key('Escape', { modifiers: { ctrl: true } }), custom), { consume: true, gesture: 'double-click' })
  // Custom: spoken for even in a terminal.
  assert.deepEqual(resolveKey(key('AudioVolumeUp'), custom), { consume: true, gesture: 'scroll-up' })
  assert.deepEqual(resolveKey(key('ArrowLeft'), custom), { consume: true, gesture: 'double-click' })
  // The chord is exact: Shift+Left is not the Left keybinding.
  assert.deepEqual(resolveKey(key('ArrowLeft', { modifiers: { shift: true } }), custom), { consume: false, gesture: 'swipe-left' })
  // "Nothing": no navigation, still typed; and it can take a built-in override away.
  assert.deepEqual(resolveKey(key('ArrowRight'), custom), { consume: false, gesture: null })
  assert.deepEqual(resolveKey(key('Escape', { modifiers: { shift: true } }), custom), { consume: false, gesture: null })
  // Held keys: moving repeats, the rest acts once but stays spoken for.
  assert.deepEqual(resolveKey(key('AudioVolumeUp', { repeat: true }), custom), { consume: true, gesture: 'scroll-up' })
  assert.deepEqual(resolveKey(key('ArrowLeft', { repeat: true }), custom), { consume: true, gesture: null })
  assert.deepEqual(resolveKey(key('ArrowDown', { repeat: true }), none), { consume: false, gesture: 'swipe-down' })
  assert.deepEqual(resolveKey(key('ArrowRight', { repeat: true }), none), { consume: false, gesture: null })
  assert.deepEqual(resolveKey(key('Enter', { repeat: true }), none), { consume: false, gesture: null })
  assert.deepEqual(['swipe-left', 'swipe-right', 'click', 'double-click', 'long-press'].filter(gestureRepeats), [])
})

test('taps go with whichever scheme the keyboard last moved by', () => {
  const scheme = new GestureScheme()
  assert.equal(scheme.originFor('click'), 'watch')
  assert.equal(scheme.originFor('scroll-down'), 'ring'); assert.equal(scheme.originFor('click'), 'ring')
  assert.equal(scheme.originFor('double-click'), 'ring'); assert.equal(scheme.originFor('long-press'), 'ring')
  assert.equal(scheme.originFor('swipe-left'), 'watch'); assert.equal(scheme.originFor('click'), 'watch')
  assert.equal(scheme.originFor('short-then-long-press'), 'watch')
})

function router(options = {}) {
  const state = {
    ready: true, locked: false, screenOn: true, windowTakesKeys: false, now: 1000,
    bindings: keyBindingMap(options.bindings ?? []), gestures: [], offered: [], wakes: 0, activity: 0, pending: [],
    hold: false,
  }
  const r = new KeyRouter({
    ready: () => state.ready, locked: () => state.locked, screenOn: () => state.screenOn,
    wake: () => { state.wakes++ },
    offerToWindow: event => { state.offered.push(`${event.phase}:${event.key}`); return state.windowTakesKeys },
    gesture: (gesture, origin) => {
      state.gestures.push(`${gesture}/${origin}`)
      return state.hold ? new Promise(resolve => state.pending.push(resolve)) : Promise.resolve()
    },
    bindings: () => state.bindings, noteActivity: () => { state.activity++ }, log: () => {}, now: () => state.now,
  })
  return { r, state }
}
const up = (k, overrides) => key(k, { ...overrides, phase: 'up' })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('router: navigation where nothing takes keys, typing where something does, Shift+Esc out of either', () => {
  const { r, state } = router()
  r.handleKey(key('ArrowLeft')); r.handleKey(up('ArrowLeft')); r.handleKey(key('Enter')); r.handleKey(key('Escape'))
  assert.deepEqual(state.gestures, ['swipe-left/watch', 'click/watch', 'double-click/watch'])
  // A terminal session: the same keys are its own, Escape included.
  state.windowTakesKeys = true; state.gestures.length = 0; state.offered.length = 0
  for (const k of ['ArrowLeft', 'Enter', 'Escape', 'a']) { r.handleKey(key(k)); r.handleKey(up(k)) }
  assert.deepEqual(state.gestures, [])
  assert.deepEqual(state.offered, ['down:ArrowLeft', 'up:ArrowLeft', 'down:Enter', 'up:Enter', 'down:Escape', 'up:Escape', 'down:a', 'up:a'])
  // Shift+Esc (or Ctrl, or Alt) backs out, and neither its press nor its release is typed.
  state.offered.length = 0
  for (const modifier of ['shift', 'ctrl', 'alt']) {
    r.handleKey(key('Escape', { modifiers: { [modifier]: true } })); r.handleKey(up('Escape'))
  }
  assert.deepEqual(state.gestures, ['double-click/watch', 'double-click/watch', 'double-click/watch'])
  assert.deepEqual(state.offered, [])
})

test('router: a key the window hands back gets its navigation meaning; one it kept does not', () => {
  const { r, state } = router()
  state.windowTakesKeys = true
  r.handleKey(key('ArrowDown'))
  assert.deepEqual(state.gestures, [])
  // The terminal was showing its session list: the key comes back.
  r.handleUnhandledKey(key('ArrowDown'))
  assert.deepEqual(state.gestures, ['swipe-down/watch'])
  r.handleUnhandledKey(key('a')); r.handleUnhandledKey(up('ArrowDown'))
  assert.equal(state.gestures.length, 1)
  // Stale by the time it comes back: the display went dark, or locked.
  state.screenOn = false; r.handleUnhandledKey(key('ArrowDown'))
  state.screenOn = true; state.locked = true; r.handleUnhandledKey(key('ArrowDown'))
  assert.equal(state.gestures.length, 1); assert.equal(state.wakes, 0)
})

test('router: custom keybindings work in a terminal too, and "Nothing" leaves the key to be typed', () => {
  const { r, state } = router({ bindings: [
    { chord: chord('AudioVolumeUp'), action: 'scroll-up' },
    { chord: chord('AudioVolumeDown'), action: 'scroll-down' },
    { chord: chord('MediaPlayPause'), action: 'click' },
    { chord: chord('ArrowLeft'), action: 'none' },
  ] })
  state.windowTakesKeys = true
  r.handleKey(key('AudioVolumeDown')); r.handleKey(up('AudioVolumeDown')); r.handleKey(key('MediaPlayPause')); r.handleKey(up('MediaPlayPause'))
  // A remote bound to scroll is a ring: its select is a ring's tap.
  assert.deepEqual(state.gestures, ['scroll-down/ring', 'click/ring']); assert.deepEqual(state.offered, [])
  r.handleKey(key('ArrowLeft'))
  assert.deepEqual(state.offered, ['down:ArrowLeft'])
  // And where nothing takes keys, "Nothing" is nothing.
  state.windowTakesKeys = false; state.gestures.length = 0
  r.handleKey(key('ArrowLeft')); r.handleUnhandledKey(key('ArrowLeft'))
  assert.deepEqual(state.gestures, [])
})

test('router: a dark display only wakes, a locked one stays locked, and nothing happens off the glasses', () => {
  const { r, state } = router()
  state.screenOn = false
  r.handleKey(key('a')); r.handleKey(key('a', { repeat: true })); r.handleKey(up('a'))
  assert.equal(state.wakes, 1); assert.deepEqual(state.gestures, []); assert.deepEqual(state.offered, [])
  state.locked = true
  r.handleKey(key('Enter'))
  assert.equal(state.wakes, 2)
  state.screenOn = true
  r.handleKey(key('Enter')); r.handleKey(key('Escape', { modifiers: { shift: true } }))
  assert.equal(state.wakes, 2); assert.deepEqual(state.gestures, [])
  state.locked = false; state.ready = false
  r.handleKey(key('Enter'))
  assert.deepEqual(state.gestures, [])
})

test('router: a held key repeats movement at a rate the display can follow, and never queues behind itself', async () => {
  const { r, state } = router()
  r.handleKey(key('ArrowDown'))
  for (let i = 1; i <= 20; i++) { await flush(); state.now = 1400 + i * 50; r.handleKey(key('ArrowDown', { repeat: true })) }
  // Twenty repeats a second arrive; every other one is acted on.
  assert.equal(state.gestures.length, 1 + 10)
  // While a gesture is still being handled, repeats are dropped rather than queued.
  state.gestures.length = 0; state.hold = true; state.now += 1000
  r.handleKey(key('ArrowUp'))
  for (let i = 1; i <= 5; i++) { state.now += 200; r.handleKey(key('ArrowUp', { repeat: true })) }
  assert.equal(state.gestures.length, 1)
  state.pending.splice(0).forEach(resolve => resolve()); await flush()
  state.now += 200; r.handleKey(key('ArrowUp', { repeat: true }))
  assert.equal(state.gestures.length, 2)
  // A fresh press is never dropped, even on the heels of another gesture.
  r.handleKey(up('ArrowUp')); r.handleKey(key('Enter'))
  assert.equal(state.gestures.at(-1), 'click/watch')
})

test('router: capturing a key for a new keybinding takes the chord and nothing else happens', () => {
  const { r, state } = router()
  const captured = []
  r.captureNextKey(c => captured.push(c))
  // Modifiers alone are waited through; the key pressed with them is the chord.
  r.handleKey(key('Shift', { code: 'ShiftLeft', modifiers: { shift: true } }))
  assert.deepEqual(captured, [])
  r.handleKey(key('Escape', { modifiers: { shift: true } }))
  assert.deepEqual(captured, [chord('Escape', { shift: true })])
  // Its release, and the modifier's, do nothing; the next key is ordinary again.
  r.handleKey(up('Escape')); r.handleKey(up('Shift', { code: 'ShiftLeft' }))
  assert.deepEqual(state.gestures, []); assert.ok(state.activity >= 2)
  r.handleKey(key('Enter'))
  assert.deepEqual(state.gestures, ['click/watch'])
  // Called off: keys go back to meaning what they mean.
  const cancel = r.captureNextKey(c => captured.push(c))
  cancel()
  r.handleKey(key('ArrowUp'))
  assert.equal(captured.length, 1); assert.equal(state.gestures.at(-1), 'swipe-up/watch')
  // A second capture replaces the first, and the first one's cancel can't undo it.
  const first = r.captureNextKey(() => captured.push('first'))
  r.captureNextKey(c => captured.push(c))
  first()
  r.handleKey(key('x', { code: 'KeyX' }))
  assert.deepEqual(captured.at(-1), chord('KeyX'))
})

test('a mouse by default: left taps, right double taps, middle holds, the wheel is the ring\'s scroll', () => {
  const action = (k, overrides) => defaultKeyAction(key(k, overrides))
  // Nothing types a mouse button, so these hold in a terminal session too.
  assert.deepEqual(action('MouseButton1'), { action: 'click', overridesTyping: true })
  assert.deepEqual(action('MouseButton2'), { action: 'double-click', overridesTyping: true })
  assert.deepEqual(action('MouseButton3'), { action: 'long-press', overridesTyping: true })
  assert.deepEqual(action('WheelUp'), { action: 'scroll-up', overridesTyping: true })
  assert.deepEqual(action('WheelDown'), { action: 'scroll-down', overridesTyping: true })
  // Whatever is held on the keyboard.
  assert.deepEqual(action('MouseButton1', { modifiers: { ctrl: true, shift: true } }), { action: 'click', overridesTyping: true })
  // Extra buttons and the horizontal wheel mean nothing until bound.
  for (const k of ['MouseButton4', 'MouseButton5', 'WheelLeft', 'WheelRight']) assert.equal(action(k), null)
  const said = code => describeChord(chord(code))
  assert.equal(said('MouseButton1'), 'Left button'); assert.equal(said('MouseButton2'), 'Right button')
  assert.equal(said('MouseButton3'), 'Middle button'); assert.equal(said('MouseButton4'), 'Mouse button 4')
  assert.equal(said('WheelUp'), 'Wheel up'); assert.equal(describeChord(chord('WheelDown', { ctrl: true })), 'Ctrl+Wheel down')
  assert.deepEqual(parseChordId('Shift+MouseButton2'), chord('MouseButton2', { shift: true }))
})

test('router: the mouse works where keys are being typed, its wheel is paced, and its buttons can be rebound', async () => {
  const { r, state } = router({ bindings: [{ chord: chord('MouseButton4'), action: 'short-then-long-press' }, { chord: chord('MouseButton2'), action: 'none' }] })
  const wheel = k => { r.handleKey(key(k, { burst: true })); r.handleKey(up(k, { burst: true })) }
  state.windowTakesKeys = true
  r.handleKey(key('MouseButton1')); r.handleKey(up('MouseButton1'))
  r.handleKey(key('MouseButton3')); r.handleKey(up('MouseButton3'))
  await flush(); state.now += 500
  wheel('WheelDown')
  // The wheel is the ring's scroll, and what follows it is the ring's too.
  await flush(); state.now += 500
  r.handleKey(key('MouseButton1')); r.handleKey(up('MouseButton1'))
  assert.deepEqual(state.gestures, ['click/watch', 'long-press/watch', 'scroll-down/ring', 'click/ring'])
  assert.deepEqual(state.offered, [], 'never typed')
  // A custom keybinding for an extra button; "Nothing" on the right button leaves it inert.
  state.gestures.length = 0
  r.handleKey(key('MouseButton4')); r.handleKey(up('MouseButton4')); r.handleKey(key('MouseButton2')); r.handleKey(up('MouseButton2'))
  assert.deepEqual(state.gestures, ['short-then-long-press/ring'])
  // A two-finger scroll reports far faster than the display can follow: every 100 ms at most.
  state.gestures.length = 0; state.offered.length = 0
  for (let i = 0; i < 40; i++) { await flush(); state.now += 25; wheel('WheelUp') }
  assert.equal(state.gestures.length, 10); assert.ok(state.gestures.every(g => g === 'scroll-up/ring'))
  // On a dark display a click wakes it and does nothing else.
  state.screenOn = false; state.gestures.length = 0
  r.handleKey(key('MouseButton1')); r.handleKey(up('MouseButton1'))
  assert.equal(state.wakes, 1); assert.deepEqual(state.gestures, [])
})

test('router: a mouse button or a turn of the wheel can be captured for a keybinding', () => {
  const { r, state } = router()
  const captured = []
  r.captureNextKey(c => captured.push(c))
  r.handleKey(key('MouseButton2')); r.handleKey(up('MouseButton2'))
  r.captureNextKey(c => captured.push(c))
  r.handleKey(key('WheelUp', { burst: true, modifiers: { shift: true } })); r.handleKey(up('WheelUp', { burst: true }))
  assert.deepEqual(captured, [chord('MouseButton2'), chord('WheelUp', { shift: true })])
  assert.deepEqual(state.gestures, [])
})
