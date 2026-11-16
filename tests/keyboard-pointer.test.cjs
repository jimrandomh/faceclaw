const test = require('node:test')
const assert = require('node:assert/strict')
const { PointerInput } = require('../.test-build/app/g2/keyboard/pointer.js')

const sample = (buttons, extra = {}) => ({ buttons, dx: 0, dy: 0, wheel: 0, pan: 0, ...extra })
function pointer() {
  const out = []
  const input = new PointerInput({
    buttons: events => out.push(...events.map(e => `${e.down ? 'down' : 'up'}:${e.page}:${e.usage}`)),
    wheel: key => out.push(key),
  })
  return { input, out }
}

test('buttons become key transitions; the wheel a key per report; movement nothing', () => {
  const { input, out } = pointer()
  input.handle(sample(0, { dx: 40, dy: -3 }))
  assert.deepEqual(out, [])
  input.handle(sample(0b001)); input.handle(sample(0b001, { dx: 2 })); input.handle(sample(0b110)); input.handle(sample(0))
  assert.deepEqual(out, ['down:9:1', 'up:9:1', 'down:9:2', 'down:9:3', 'up:9:2', 'up:9:3'])
  out.length = 0
  // However many detents a report claims, it is one step; a two-finger scroll sends many.
  input.handle(sample(0, { wheel: 1 })); input.handle(sample(0, { wheel: -3 })); input.handle(sample(0, { pan: 2 })); input.handle(sample(0, { pan: -1 }))
  assert.deepEqual(out, ['WheelUp', 'WheelDown', 'WheelRight', 'WheelLeft'])
})

test('taking the pointer: samples go to the taker, held buttons are let go first, and its clicks are nobody else\'s', () => {
  const { input, out } = pointer()
  const taken = []
  input.handle(sample(0b001))
  const release = input.take(s => taken.push(s))
  assert.deepEqual(out, ['down:9:1', 'up:9:1'])
  out.length = 0
  input.handle(sample(0b001, { dx: 5 })); input.handle(sample(0b011, { wheel: 1 })); input.handle(sample(0b010))
  assert.deepEqual(taken, [sample(0b001, { dx: 5 }), sample(0b011, { wheel: 1 }), sample(0b010)])
  assert.deepEqual(out, [])
  // Given back with the right button still down: its release is not a key-up for anyone.
  release()
  input.handle(sample(0)); input.handle(sample(0b100)); input.handle(sample(0))
  assert.deepEqual(out, ['down:9:3', 'up:9:3'])
  // A stale release function can't take the pointer away from a later taker.
  const second = []
  const releaseSecond = input.take(s => second.push(s))
  release()
  input.handle(sample(0, { dx: 1 }))
  assert.equal(second.length, 1)
  releaseSecond()
})

test('the keyboard going away forgets held buttons without reporting releases', () => {
  const { input, out } = pointer()
  input.handle(sample(0b001))
  input.reset()
  assert.deepEqual(out, ['down:9:1'])
  // The next keyboard starts clean: a press is a press.
  input.handle(sample(0b001))
  assert.deepEqual(out, ['down:9:1', 'down:9:1'])
})
