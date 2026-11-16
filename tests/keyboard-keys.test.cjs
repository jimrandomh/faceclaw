const test = require('node:test')
const assert = require('node:assert/strict')
const { KeyTranslator, translateUsage } = require('../.test-build/app/g2/keyboard/keys.js')
const { encodeTerminalKey, terminalScrollbackKey } = require('../.test-build/app/apps/terminal/terminal-keys.js')

const K = 7
const down = (usage, page = K) => ({ page, usage, down: true })
const up = (usage, page = K) => ({ page, usage, down: false })
const SHIFT = 225, RSHIFT = 229, CTRL = 224, ALT = 226, META = 227, CAPS = 57
const A = 4, ONE = 30, ENTER = 40, SLASH = 56

function translator() {
  const events = [], timers = new Map()
  let nextTimer = 1, now = 1000
  const t = new KeyTranslator({
    emit: e => events.push(e),
    now: () => now,
    setTimer: (callback, delayMs) => { timers.set(nextTimer, { callback, at: now + delayMs }); return nextTimer++ },
    clearTimer: handle => timers.delete(handle),
  })
  const advance = ms => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].callback()
    }
    now = end
  }
  return { t, events, timers, advance }
}
const key = (overrides = {}) => ({
  phase: 'down', key: 'a', code: 'KeyA', text: 'a', repeat: false, timestampMs: 0,
  ...overrides, modifiers: { shift: false, ctrl: false, alt: false, meta: false, ...overrides.modifiers },
})

test('US layout: letters, digits, punctuation, keypad, function and consumer keys', () => {
  assert.deepEqual(translateUsage(K, A, false, false), { key: 'a', code: 'KeyA', text: 'a' })
  assert.deepEqual(translateUsage(K, A, true, false), { key: 'A', code: 'KeyA', text: 'A' })
  assert.deepEqual(translateUsage(K, A, true, true), { key: 'a', code: 'KeyA', text: 'a' })
  assert.deepEqual(translateUsage(K, ONE, true, true), { key: '!', code: 'Digit1', text: '!' })
  assert.deepEqual(translateUsage(K, SLASH, true, false), { key: '?', code: 'Slash', text: '?' })
  assert.deepEqual(translateUsage(K, 44, false, false), { key: ' ', code: 'Space', text: ' ' })
  assert.deepEqual(translateUsage(K, 89, false, false), { key: '1', code: 'Numpad1', text: '1' })
  assert.deepEqual(translateUsage(K, 88, false, false), { key: 'Enter', code: 'NumpadEnter' })
  assert.deepEqual(translateUsage(K, 69, false, false), { key: 'F12', code: 'F12' })
  assert.deepEqual(translateUsage(K, 104, false, false), { key: 'F13', code: 'F13' })
  assert.deepEqual(translateUsage(12, 0xe9, false, false), { key: 'AudioVolumeUp', code: 'AudioVolumeUp' })
  assert.equal(translateUsage(K, 200, false, false).key, 'Unidentified')
})
test('modifiers follow the stream, on either side, and chords carry no text', () => {
  const { t, events } = translator()
  t.handle([down(SHIFT), down(A)])
  assert.deepEqual(events.map(e => [e.phase, e.key, e.text]), [['down', 'Shift', undefined], ['down', 'A', 'A']])
  assert.equal(events[1].modifiers.shift, true)
  // The other Shift takes over; releasing the first leaves it held.
  t.handle([down(RSHIFT), up(SHIFT), up(A), down(A)])
  assert.equal(events.at(-1).key, 'A')
  t.handle([up(RSHIFT), up(A), down(CTRL), down(A)])
  assert.deepEqual([events.at(-1).key, events.at(-1).text, events.at(-1).modifiers.ctrl], ['a', undefined, true])
  t.handle([up(CTRL), up(A), down(ALT), down(A)])
  assert.equal(events.at(-1).text, undefined)
  t.handle([up(ALT), up(A), down(META), down(A)])
  assert.equal(events.at(-1).text, undefined)
  // A duplicate report changes nothing.
  const count = events.length; t.handle([down(A)]); assert.equal(events.length, count)
  t.handle([up(200)]); assert.equal(events.length, count)
})
test('Caps Lock toggles letters only', () => {
  const { t, events } = translator()
  t.handle([down(CAPS), up(CAPS), down(A), up(A), down(ONE), up(ONE), down(SHIFT), down(A)])
  const typed = events.filter(e => e.phase === 'down' && e.text).map(e => e.text)
  assert.deepEqual(typed, ['A', '1', 'a'])
})
test('a held key repeats until it is released; the newest key is the one that repeats', () => {
  const { t, events, timers, advance } = translator()
  t.handle([down(A)])
  advance(399); assert.equal(events.length, 1)
  advance(1); assert.deepEqual([events.at(-1).key, events.at(-1).repeat], ['a', true])
  advance(100); assert.equal(events.filter(e => e.repeat).length, 3)
  t.handle([down(ONE)]); advance(400)
  assert.deepEqual([events.at(-1).key, events.at(-1).repeat], ['1', true])
  // Releasing the older key leaves the newer one repeating.
  t.handle([up(A)]); const before = events.length; advance(50)
  assert.equal(events.length, before + 1)
  t.handle([up(ONE)]); const after = events.length; advance(1000)
  assert.equal(events.length, after); assert.equal(timers.size, 0)
  // Modifiers never repeat.
  t.handle([down(SHIFT)]); advance(2000); assert.equal(events.filter(e => e.key === 'Shift').length, 1)
})
test('reset forgets held keys and modifiers without emitting, and stops the repeat', () => {
  const { t, events, timers, advance } = translator()
  t.handle([down(SHIFT), down(CAPS), down(A)])
  const count = events.length
  t.reset(); advance(5000)
  assert.equal(events.length, count); assert.equal(timers.size, 0)
  t.handle([down(A)])
  assert.deepEqual([events.at(-1).key, events.at(-1).modifiers.shift], ['a', false])
})

test('terminal: printable keys, Enter, Tab, Backspace, Escape', () => {
  const enc = (overrides, appCursor = false) => encodeTerminalKey(key(overrides), appCursor)
  assert.equal(enc({}), 'a')
  assert.equal(enc({ key: 'A', text: 'A', modifiers: { shift: true } }), 'A')
  assert.equal(enc({ key: 'Enter', text: undefined }), '\r')
  assert.equal(enc({ key: 'Tab', text: undefined }), '\t')
  assert.equal(enc({ key: 'Tab', text: undefined, modifiers: { shift: true } }), '\x1b[Z')
  assert.equal(enc({ key: 'Backspace', text: undefined }), '\x7f')
  assert.equal(enc({ key: 'Backspace', text: undefined, modifiers: { ctrl: true } }), '\x08')
  assert.equal(enc({ key: 'Escape', text: undefined }), '\x1b')
  assert.equal(enc({ key: ' ', text: ' ' }), ' ')
  assert.equal(enc({ phase: 'up' }), null)
  assert.equal(enc({ key: 'Shift', code: 'ShiftLeft', text: undefined, modifiers: { shift: true } }), null)
  assert.equal(enc({ key: 'AudioVolumeUp', text: undefined }), null)
  assert.equal(enc({ modifiers: { meta: true }, text: undefined }), null)
  // A repeat types again.
  assert.equal(enc({ repeat: true }), 'a')
})
test('terminal: Ctrl chords are control characters, Alt prefixes ESC', () => {
  const enc = (k, modifiers) => encodeTerminalKey(key({ key: k, text: undefined, modifiers }), false)
  assert.equal(enc('c', { ctrl: true }), '\x03'); assert.equal(enc('C', { ctrl: true, shift: true }), '\x03')
  assert.equal(enc('z', { ctrl: true }), '\x1a'); assert.equal(enc('[', { ctrl: true }), '\x1b')
  assert.equal(enc(' ', { ctrl: true }), '\x00'); assert.equal(enc('/', { ctrl: true }), '\x7f')
  assert.equal(enc('=', { ctrl: true }), null)
  assert.equal(enc('f', { alt: true }), '\x1bf'); assert.equal(enc('F', { alt: true, shift: true }), '\x1bF')
  assert.equal(enc('c', { ctrl: true, alt: true }), '\x1b\x03')
  assert.equal(enc('Enter', { alt: true }), '\x1b\r'); assert.equal(enc('Backspace', { alt: true }), '\x1b\x7f')
})
test('terminal: cursor keys follow DECCKM; modified ones and function keys use the xterm forms', () => {
  const enc = (k, modifiers, appCursor = false) => encodeTerminalKey(key({ key: k, text: undefined, modifiers }), appCursor)
  assert.equal(enc('ArrowUp'), '\x1b[A'); assert.equal(enc('ArrowUp', {}, true), '\x1bOA')
  assert.equal(enc('ArrowLeft', { ctrl: true }), '\x1b[1;5D'); assert.equal(enc('ArrowLeft', { ctrl: true }, true), '\x1b[1;5D')
  assert.equal(enc('ArrowRight', { shift: true, alt: true }), '\x1b[1;4C')
  assert.equal(enc('Home'), '\x1b[H'); assert.equal(enc('End', {}, true), '\x1bOF')
  assert.equal(enc('PageUp'), '\x1b[5~'); assert.equal(enc('Delete'), '\x1b[3~'); assert.equal(enc('Delete', { ctrl: true }), '\x1b[3;5~')
  assert.equal(enc('F1'), '\x1bOP'); assert.equal(enc('F4', { shift: true }), '\x1b[1;2S')
  assert.equal(enc('F5'), '\x1b[15~'); assert.equal(enc('F12'), '\x1b[24~'); assert.equal(enc('F13'), null)
})
test('terminal: Shift+PageUp and Shift+PageDown page the scrollback instead', () => {
  const page = (k, modifiers, phase = 'down') => terminalScrollbackKey(key({ key: k, text: undefined, modifiers, phase }))
  assert.equal(page('PageUp', { shift: true }), -1); assert.equal(page('PageDown', { shift: true }), 1)
  assert.equal(page('PageUp', {}), null); assert.equal(page('PageUp', { shift: true, ctrl: true }), null)
  assert.equal(page('PageUp', { shift: true }, 'up'), null); assert.equal(page('ArrowUp', { shift: true }), null)
})
