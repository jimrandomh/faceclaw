const test = require("node:test");
const assert = require("node:assert/strict");

const { JavaDirectBuffer } = require("../.test-build/app/native/java-direct-buffer.js");

/**
 * A stand-in for java.nio.ByteBuffer.allocateDirect: fixed capacity, a
 * position and a limit, and the relative bulk get() SurfaceCompositor uses.
 * viewOf() plays ArrayBuffer.from: a view over the same memory, not a copy.
 */
function fakeBackend() {
  const allocated = [];
  return {
    allocated,
    allocateDirect(capacity) {
      const memory = new Uint8Array(capacity);
      const buffer = {
        memory,
        position: 0,
        limitValue: capacity,
        clear() {
          this.position = 0;
          this.limitValue = capacity;
          return this;
        },
        limit(newLimit) {
          if (newLimit > capacity) throw new Error("limit past capacity");
          this.limitValue = newLimit;
          if (this.position > newLimit) this.position = newLimit;
          return this;
        },
        remaining() {
          return this.limitValue - this.position;
        },
        get(dst, offset, length) {
          if (length > this.remaining()) throw new Error("BufferUnderflowException");
          dst.set(memory.subarray(this.position, this.position + length), offset);
          this.position += length;
          return this;
        },
      };
      allocated.push(buffer);
      return buffer;
    },
    viewOf(buffer) {
      return buffer.memory;
    },
  };
}

/** Consume the way SurfaceCompositor.applyAndComposite does: exact remaining(), then drain. */
function consume(buffer, expectedBytes) {
  assert.equal(buffer.remaining(), expectedBytes);
  const out = new Uint8Array(expectedBytes);
  buffer.get(out, 0, expectedBytes);
  return out;
}

function frame(length, seed) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

test("a loaded buffer exposes exactly the payload bytes to a Java-style reader", () => {
  const backend = fakeBackend();
  const pool = new JavaDirectBuffer(640 * 480, backend);
  const shell = frame(640 * 480, 1);
  assert.deepEqual(consume(pool.load(shell), shell.length), shell);
});

test("successive frames reuse one Java buffer, including smaller ones", () => {
  const backend = fakeBackend();
  const pool = new JavaDirectBuffer(640 * 480, backend);
  for (let i = 0; i < 50; i++) {
    const size = i % 2 === 0 ? 640 * 480 : 640 * 452;
    const bytes = frame(size, i);
    assert.deepEqual(consume(pool.load(bytes), size), bytes);
  }
  assert.equal(pool.allocations, 1);
  assert.equal(backend.allocated.length, 1);
});

test("a payload larger than the buffer allocates once more, then reuses", () => {
  const backend = fakeBackend();
  const pool = new JavaDirectBuffer(0, backend);
  consume(pool.load(frame(10, 0)), 10);
  consume(pool.load(frame(9000, 0)), 9000);
  consume(pool.load(frame(8000, 0)), 8000);
  consume(pool.load(frame(9000, 0)), 9000);
  assert.equal(pool.allocations, 2);
});

test("loadOptional passes null through and loads a draw list", () => {
  const backend = fakeBackend();
  const pool = new JavaDirectBuffer(0, backend);
  assert.equal(pool.loadOptional(null), null);
  assert.equal(pool.loadOptional(undefined), null);
  assert.equal(pool.loadOptional(new ArrayBuffer(0)), null);
  assert.equal(backend.allocated.length, 0);
  const draws = frame(36, 7);
  assert.deepEqual(consume(pool.loadOptional(draws.buffer), 36), draws);
});

test("a view on a larger buffer contributes only its own bytes", () => {
  const backend = fakeBackend();
  const pool = new JavaDirectBuffer(0, backend);
  const whole = frame(100, 3);
  const view = whole.subarray(10, 30);
  assert.deepEqual(consume(pool.load(view), 20), whole.slice(10, 30));
});
