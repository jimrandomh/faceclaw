// The glasses' side of the draw protocol, for replaying a screen recording: the resource cache,
// the screen buffer, display lists and presentation, one instance per lens.
//
// The drawing code is a port of the phone's reference interpreter
// (native/kotlin/shared/.../graphics/DisplayListRenderer.kt) and must agree with it pixel for
// pixel; tests/screen-recording.test.cjs holds it to recordings the Kotlin tests produce.
// The wire grammar is DrawProtocol.kt's (g2protocol/, beside it); FORMAT.md covers the recording.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcEmulator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCREEN = 65535;
  const CURRENT = 65534;
  const MSG = { UPLOAD: 21, EVICT: 22, DRAW: 26, ROOT: 27, PRESENT: 28, CREATE: 29 };
  const OP = { BBOX: 1, COPY: 2, STOCK_TEXT: 3, IMAGE: 4, TEXT: 5, LUT: 6, LIST: 7, ROUNDED_RECT: 8, CLEAR: 9, LINE: 10 };
  const FLAG_TARGET = 1, FLAG_DEPTH = 2, FLAG_CLIP = 4, FLAG_CLIP_ANIMATED = 8;
  /** A line with an endpoint coordinate further out than this draws nothing. */
  const LINE_COORDINATE_LIMIT = 4096;
  /** A shown screen, in the units of the fade an expression reads; a replay is of a shown screen. */
  const FADE_ONE = 1024;
  const RESOURCE_FONT = 1, RESOURCE_LIST = 2, RESOURCE_LARGE = 4, RESOURCE_RLE = 8;
  const OPT_BRIGHTNESS = 15, OPT_TRANSPARENT = 16, OPT_INVERSE = 32;
  const NO_BORDER = 16, NO_OUTSIDE = 16;
  /** Past every animation's end: TIME counts from PRESENT and clamps to the animation's length. */
  const SETTLED_MS = 3600000;

  // How a pixel got to the screen, kept beside each pixel so the display can be tinted by it.
  // The numbers index recording.js's CATEGORIES: the bytes that paid for the pixel.
  const ORIGIN = { UNKNOWN: 0, PIXELS: 1, SURFACE: 2, IMAGE: 3, FONT: 4, DRAWN: 6 };
  /** For put(): leave the pixel's origin as it is (a color remap changes its value only). */
  const KEEP = -1;

  class ProtocolError extends Error {}

  function check(condition, message) {
    if (!condition) throw new ProtocolError(message || 'Malformed draw data');
  }

  // ---------------------------------------------------------------------
  // Numeric fields: fixed-width little-endian, extended varints, and expressions.

  class Reader {
    constructor(bytes, start = 0, end = bytes.length) {
      check(start >= 0 && start <= end && end <= bytes.length);
      this.bytes = bytes;
      this.position = start;
      this.end = end;
    }

    get remaining() { return this.end - this.position; }

    u8() {
      check(this.remaining >= 1, 'Truncated draw field');
      return this.bytes[this.position++];
    }

    s8() { return (this.u8() << 24) >> 24; }

    u16() {
      const low = this.u8();
      return low | (this.u8() << 8);
    }

    s16() { return (this.u16() << 16) >> 16; }

    take(count) {
      check(count >= 0 && count <= this.remaining, 'Truncated draw data');
      const result = this.bytes.subarray(this.position, this.position + count);
      this.position += count;
      return result;
    }

    /** A bounded view prevents a truncated call from consuming the next call. */
    slice(count) {
      check(count >= 0 && count <= this.remaining, 'Truncated draw call');
      const result = new Reader(this.bytes, this.position, this.position + count);
      this.position += count;
      return result;
    }

    done() { check(this.remaining === 0, 'Trailing draw data'); }
  }

  const VARINT_BITS = [7, 14, 21, 28, 32];

  function readVarint(reader, signed, first = reader.u8()) {
    const size = first < 0x80 ? 1 : first < 0xc0 ? 2 : first < 0xe0 ? 3 : first < 0xf0 ? 4 : first === 0xf0 ? 5 : 0;
    check(size > 0, 'Reserved extended-varint prefix');
    let value = size === 5 ? 0 : first & ((1 << (8 - size)) - 1);
    for (let i = 1; i < size; i++) value = (value << 8) | reader.u8();
    const bits = VARINT_BITS[size - 1];
    return signed && bits < 32 ? (value << (32 - bits)) >> (32 - bits) : value;
  }

  const EXPRESSION_MAX_BYTES = 1024;
  const EXPRESSION_MAX_STACK = 32;
  const f32 = Math.fround;

  /** Typed i32/f32 stack machine; a program that fails in any way evaluates to zero. */
  function evaluateExpression(reader, frame) {
    const values = [];
    const floats = [];
    let pending = false;
    const push = (value, float = false) => {
      check(values.length < EXPRESSION_MAX_STACK);
      values.push(value);
      floats.push(float);
    };
    const integer = () => {
      check(values.length > 0 && !floats[floats.length - 1]);
      floats.pop();
      return values.pop();
    };
    const float = () => {
      check(values.length > 0 && floats[floats.length - 1]);
      floats.pop();
      return values.pop();
    };
    const pushFloat = (value) => {
      const rounded = f32(value);
      check(Number.isFinite(rounded));
      push(rounded, true);
    };
    const toInteger = (value) => {
      check(Number.isFinite(value) && value >= -2147483648 && value < 2147483648);
      return Math.trunc(value);
    };
    try {
      check(reader.remaining <= EXPRESSION_MAX_BYTES);
      while (reader.remaining > 0) {
        const op = reader.u8();
        if (op === 1) {
          push(readVarint(reader, true));
        } else if (op === 2) {
          const view = new DataView(new ArrayBuffer(4));
          for (let i = 0; i < 4; i++) view.setUint8(i, reader.u8());
          pushFloat(view.getFloat32(0, true));
        } else if (op === 3) {
          check(values.length > 0);
          push(values[values.length - 1], floats[floats.length - 1]);
        } else if (op === 4) {
          check(values.length > 0);
          values.pop();
          floats.pop();
        } else if (op === 5) {
          check(values.length >= 2);
          const n = values.length;
          [values[n - 1], values[n - 2]] = [values[n - 2], values[n - 1]];
          [floats[n - 1], floats[n - 2]] = [floats[n - 2], floats[n - 1]];
        } else if ((op >= 16 && op <= 20) || op === 22 || op === 23) {
          const b = integer();
          const a = integer();
          let result;
          if (op === 16) result = (a + b) | 0;
          else if (op === 17) result = (a - b) | 0;
          else if (op === 18) result = Math.imul(a, b);
          else if (op === 19) { check(b !== 0); result = a === -2147483648 && b === -1 ? a : Math.trunc(a / b); }
          else if (op === 20) { check(b !== 0); result = a === -2147483648 && b === -1 ? 0 : a % b; }
          else if (op === 22) result = Math.min(a, b);
          else result = Math.max(a, b);
          push(result);
        } else if (op === 21) {
          push((-integer()) | 0);
        } else if ((op >= 32 && op <= 35) || op === 37 || op === 38) {
          const b = float();
          const a = float();
          let result;
          if (op === 32) result = a + b;
          else if (op === 33) result = a - b;
          else if (op === 34) result = a * b;
          else if (op === 35) { check(b !== 0); result = a / b; }
          else if (op === 37) result = Math.min(a, b);
          else result = Math.max(a, b);
          pushFloat(result);
        } else if (op === 36) {
          pushFloat(-float());
        } else if (op === 48) {
          pushFloat(integer());
        } else if (op === 49) {
          push(toInteger(float()));
        } else if (op === 50) {
          const maximum = integer();
          check(maximum >= 0);
          const time = Math.min(Math.max(frame.elapsedMs, 0), maximum);
          if (time !== maximum) pending = true;
          push(time);
        } else if (op === 51) {
          // The screen fade, 0 (dark) to 1 (shown); the glasses sample it as they draw.
          pushFloat((frame.fade === undefined ? FADE_ONE : frame.fade) / FADE_ONE);
          if (frame.fadeMoving) pending = true;
        } else if (op === 64) {
          const t = float();
          const b = float();
          const a = float();
          pushFloat(a + f32(f32(b - a) * t));
        } else if (op >= 65 && op <= 71) {
          const t = Math.min(Math.max(float(), 0), 1);
          const u = f32(1 - t);
          let result;
          if (op === 65) result = f32(t * t) * f32(3 - f32(2 * t));
          else if (op === 66) result = t * t;
          else if (op === 67) result = 1 - f32(u * u);
          else if (op === 68) result = t < 0.5 ? f32(2 * t) * t : 1 - f32(f32(2 * u) * u);
          else if (op === 69) result = f32(t * t) * t;
          else if (op === 70) result = 1 - f32(f32(u * u) * u);
          else result = t < 0.5 ? f32(f32(4 * t) * t) * t : 1 - f32(f32(f32(4 * u) * u) * u);
          pushFloat(result);
        } else {
          check(false, 'Unknown expression opcode');
        }
      }
      check(values.length > 0);
      const result = floats[floats.length - 1] ? toInteger(float()) : integer();
      frame.animationPending = frame.animationPending || pending;
      return result;
    } catch (error) {
      if (error instanceof ProtocolError) return 0;
      throw error;
    }
  }

  /** A literal, or 0xff and a framed expression. */
  function evaluateValue(reader, frame) {
    const first = reader.u8();
    if (first !== 0xff) return readVarint(reader, true, first);
    const length = readVarint(reader, false) >>> 0;
    // Outer framing errors reject the call; errors inside a framed program yield zero.
    check(length <= reader.remaining);
    const program = reader.slice(length);
    if (length > EXPRESSION_MAX_BYTES) return 0;
    return evaluateExpression(program, frame);
  }

  function depthOffset(depth, right) {
    return right ? -Math.floor((depth + 1) / 2) : Math.floor(depth / 2);
  }

  // ---------------------------------------------------------------------
  // Pixels

  /**
   * Packed 4bpp rows that can be drawn into. `clip` is the writable [left, top, right, bottom)
   * in shifted target pixels. `origin`, when present, holds one ORIGIN per pixel.
   */
  class Target {
    constructor(bytes, width, height, offset = 0, shiftX = 0, clip = null, origin = null) {
      this.bytes = bytes;
      this.width = width;
      this.height = height;
      this.offset = offset;
      this.shiftX = shiftX;
      this.clip = clip;
      this.origin = origin;
      this.stride = (width + 1) >> 1;
      check(width > 0 && height > 0 && offset >= 0 && bytes.length - offset >= this.stride * height);
    }

    get(x, y) {
      const value = this.bytes[this.offset + y * this.stride + (x >> 1)];
      return x & 1 ? value & 15 : value >> 4;
    }

    shifted(dx) {
      return new Target(this.bytes, this.width, this.height, this.offset, this.shiftX + dx, this.clip, this.origin);
    }

    /** Narrow the clip to a rect in (unshifted) call coordinates. */
    clipped(x, y, w, h) {
      const left = x + this.shiftX;
      const rect = [left, y, left + w, y + h];
      if (this.clip) {
        rect[0] = Math.max(rect[0], this.clip[0]);
        rect[1] = Math.max(rect[1], this.clip[1]);
        rect[2] = Math.min(rect[2], this.clip[2]);
        rect[3] = Math.min(rect[3], this.clip[3]);
      }
      return new Target(this.bytes, this.width, this.height, this.offset, this.shiftX, rect, this.origin);
    }

    writable(x, y) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
      const clip = this.clip;
      return !clip || (x >= clip[0] && y >= clip[1] && x < clip[2] && y < clip[3]);
    }

    put(localX, y, value, origin) {
      this.set(localX + this.shiftX, y, value, origin);
    }

    /** As put, at a shifted (absolute) x. */
    set(x, y, value, origin) {
      if (!this.writable(x, y)) return;
      const index = this.offset + y * this.stride + (x >> 1);
      const old = this.bytes[index];
      this.bytes[index] = x & 1 ? (old & 240) | value : (old & 15) | (value << 4);
      if (this.origin && origin !== KEEP) this.origin[y * this.width + x] = origin;
    }
  }

  function decodeRle(bytes, position, count, exact) {
    const pixels = new Uint8Array(count);
    let index = 0;
    while (index < count) {
      check(position < bytes.length, 'Truncated pixel runs');
      const token = bytes[position++];
      let run = token >> 4;
      if (run === 0) {
        check(position < bytes.length, 'Truncated pixel runs');
        run = bytes[position++];
        if (run === 0) {
          check(position + 1 < bytes.length, 'Truncated pixel runs');
          run = bytes[position] | (bytes[position + 1] << 8);
          position += 2;
        }
      }
      check(run > 0 && run <= count - index, 'Pixel runs overflow their rectangle');
      pixels.fill(token & 15, index, index + run);
      index += run;
    }
    check(!exact || position === bytes.length, 'Trailing pixel runs');
    return pixels;
  }

  /**
   * An image record: a whole image resource, or one glyph inside a font. Without `unpack` a raw
   * image is only checked, not read (validation passes need its size alone).
   */
  function decodeImage(bytes, start = 0, unpack = true) {
    check(start >= 0 && start < bytes.length);
    const flags = bytes[start];
    check((flags & (RESOURCE_LARGE | RESOURCE_RLE)) === flags, 'Not an image');
    const large = (flags & RESOURCE_LARGE) !== 0;
    const header = large ? 5 : 3;
    check(start + header <= bytes.length);
    const width = large ? bytes[start + 1] | (bytes[start + 2] << 8) : bytes[start + 1];
    const height = large ? bytes[start + 3] | (bytes[start + 4] << 8) : bytes[start + 2];
    check(width >= 1 && width <= 640 && height >= 1 && height <= 480, 'Image size out of range');
    let pixels;
    if (flags & RESOURCE_RLE) {
      pixels = decodeRle(bytes, start + header, width * height, false);
    } else {
      const stride = (width + 1) >> 1;
      const offset = start + header;
      check(bytes.length - offset >= stride * height, 'Truncated image');
      pixels = unpack ? new Uint8Array(width * height) : null;
      for (let y = 0, i = 0; unpack && y < height; y++) {
        const row = offset + y * stride;
        for (let x = 0; x < width; x++) {
          const value = bytes[row + (x >> 1)];
          pixels[i++] = x & 1 ? value & 15 : value >> 4;
        }
      }
    }
    return { width, height, pixels, large, header };
  }

  function roundedContains(x, y, width, height, radius) {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const r = Math.min(radius, width >> 1, height >> 1);
    const dx = Math.max(0, 2 * r - (2 * Math.min(x, width - 1 - x) + 1));
    const dy = Math.max(0, 2 * r - (2 * Math.min(y, height - 1 - y) + 1));
    return dx * dx + dy * dy <= 4 * r * r;
  }

  // ---------------------------------------------------------------------
  // The interpreter

  /**
   * Runs draw sequences and display lists against a lens's resources.
   *
   * `host` supplies: `resources` (Map id -> Uint8Array), `right` (which lens), `builtin(cp, next)`
   * for stock-font glyphs, `writableResource(id)` (the bytes to draw into, for a target override)
   * and `resourceOrigin(id)` (the ORIGIN of pixels drawn from that resource).
   */
  class Renderer {
    constructor(host) {
      this.host = host;
      this.animationPending = false;
    }

    resource(id) {
      const bytes = this.host.resources.get(id);
      check(bytes, 'Missing resource ' + id);
      return bytes;
    }

    /**
     * Present: compose `root` into `composition`. Validates the whole graph before drawing;
     * with `validateOnly`, that is all it does.
     */
    render(root, screen, composition, elapsedMs = 0, trace = null, validateOnly = false) {
      return this.run(elapsedMs, (walk) => {
        // A root list composes the whole frame, including its screen copy.
        if (root !== SCREEN) this.executeList(root, composition, walk);
        else if (walk.apply) this.copyScreen(screen, composition);
      }, screen, trace, validateOnly);
    }

    /** A draw message's sequence, drawn into `target`. */
    execute(sequence, target, screen = target, elapsedMs = 0, trace = null) {
      return this.run(elapsedMs, (walk) => this.executeSequence(new Reader(sequence), target, walk), screen, trace);
    }

    run(elapsedMs, body, screen, trace, validateOnly = false) {
      const frame = { elapsedMs: Math.floor(elapsedMs), animationPending: false };
      const references = new Set();
      for (const apply of validateOnly ? [false] : [false, true]) {
        body({ screen, apply, references, frame, ancestors: [], remainingCalls: 4096, trace: apply ? trace : null });
      }
      this.animationPending = frame.animationPending;
      return references;
    }

    copyScreen(screen, composition) {
      const plain = screen.bytes !== composition.bytes && composition.shiftX === 0 && !composition.clip &&
        screen.width === composition.width && screen.height === composition.height && (screen.width & 1) === 0;
      if (plain) {
        const size = screen.stride * screen.height;
        composition.bytes.set(screen.bytes.subarray(screen.offset, screen.offset + size), composition.offset);
        if (composition.origin) {
          if (screen.origin) composition.origin.set(screen.origin);
          else composition.origin.fill(ORIGIN.UNKNOWN);
        }
        return;
      }
      for (let y = 0; y < screen.height; y++) {
        for (let x = 0; x < screen.width; x++) {
          composition.put(x, y, screen.get(x, y), screen.origin ? screen.origin[y * screen.width + x] : ORIGIN.UNKNOWN);
        }
      }
    }

    executeList(id, target, walk) {
      check(walk.ancestors.length < 8 && !walk.ancestors.includes(id), 'Display lists nest too deep or in a cycle');
      const bytes = this.resource(id);
      check(bytes.length >= 3 && bytes[0] === RESOURCE_LIST, 'Resource ' + id + ' is not a display list');
      walk.references.add(id);
      walk.ancestors.push(id);
      this.executeSequence(new Reader(bytes, 1), target, walk);
      walk.ancestors.pop();
    }

    executeSequence(reader, inherited, walk) {
      const count = reader.u16();
      for (let i = 0; i < count; i++) {
        const length = reader.u16();
        check(walk.remainingCalls > 0, 'More than 4096 calls');
        walk.remainingCalls--;
        this.executeCall(reader.slice(length), inherited, walk);
      }
      reader.done();
    }

    executeCall(reader, inherited, walk) {
      const opcode = reader.u8();
      const flags = reader.u8();
      check((flags & ~(FLAG_TARGET | FLAG_DEPTH | FLAG_CLIP | FLAG_CLIP_ANIMATED)) === 0, 'Reserved call flags');
      let target = inherited;
      let resourceTarget = null;
      if (flags & FLAG_TARGET) {
        resourceTarget = reader.u16();
        walk.references.add(resourceTarget);
        target = this.resourceTarget(resourceTarget, walk.apply).shifted(inherited.shiftX);
      }
      if (flags & FLAG_DEPTH) target = target.shifted(depthOffset(reader.s8(), this.host.right));
      if (flags & FLAG_CLIP_ANIMATED) {
        // The same rect, each field an extended value.
        check(!(flags & FLAG_CLIP), 'A call has one clip');
        const x = evaluateValue(reader, walk.frame);
        const y = evaluateValue(reader, walk.frame);
        const w = evaluateValue(reader, walk.frame);
        const h = evaluateValue(reader, walk.frame);
        // A value outside its fixed field's range (a negative size, say) makes the clip empty.
        const valid = x >= -32768 && x <= 32767 && y >= -32768 && y <= 32767 && w >= 0 && w <= 65535 && h >= 0 && h <= 65535;
        target = valid ? target.clipped(x, y, w, h) : target.clipped(0, 0, 0, 0);
      } else if (flags & FLAG_CLIP) {
        target = target.clipped(reader.s16(), reader.s16(), reader.u16(), reader.u16());
      }
      const note = walk.trace
        ? (rect) => walk.trace.push(Object.assign({ op: opcode, target: resourceTarget, shiftX: target.shiftX, depth: walk.ancestors.length }, rect))
        : null;
      switch (opcode) {
        case OP.BBOX: return this.drawBoundingBox(reader, target, walk, note);
        case OP.COPY: return this.drawRectCopy(reader, target, walk, note);
        case OP.STOCK_TEXT: return this.drawStockText(reader, target, walk, note);
        case OP.IMAGE: return this.drawImage(reader, target, walk, note);
        case OP.TEXT: return this.drawText(reader, target, walk, note);
        case OP.LUT: return this.remapColors(reader, target, walk, note);
        case OP.ROUNDED_RECT: return this.drawRoundedRect(reader, target, walk, note);
        case OP.CLEAR: return this.clear(reader, target, walk, note);
        case OP.LINE: return this.drawLine(reader, target, walk, note);
        case OP.LIST: {
          const id = reader.u16();
          reader.done();
          return this.executeList(id, target, walk);
        }
        default: check(false, 'Unknown draw opcode ' + opcode);
      }
    }

    /** A raw image resource as a draw target. Only the drawing pass asks for writable bytes. */
    resourceTarget(id, forWriting) {
      let bytes = this.resource(id);
      check((bytes[0] & (3 | RESOURCE_RLE)) === 0, 'Resource ' + id + ' is not a writable image');
      const image = decodeImage(bytes, 0, false); // Validate the complete raw image before exposing a write target.
      if (forWriting) bytes = this.host.writableResource(id);
      return new Target(bytes, image.width, image.height, image.header);
    }

    drawPixels(image, target, x, y, options, origin) {
      const transparent = (options & OPT_TRANSPARENT) !== 0;
      const inverse = (options & OPT_INVERSE) !== 0;
      const top = options & OPT_BRIGHTNESS;
      const { width, pixels } = image;
      for (let i = 0; i < pixels.length; i++) {
        const value = pixels[i];
        if (value === 0 && transparent) continue;
        const source = inverse ? 15 - value : value;
        target.put(x + (i % width), y + ((i / width) | 0), ((source * top) / 15) | 0, origin);
      }
    }

    drawBoundingBox(reader, target, walk, note) {
      const flags = reader.u8();
      check((flags & ~1) === 0, 'Reserved bounding-box flags');
      const wide = (flags & 1) !== 0;
      const x = wide ? reader.u16() : reader.u8() * 4;
      const y = wide ? reader.u16() : reader.u8() * 2;
      const width = wide ? reader.u16() : reader.u8() * 4;
      const height = wide ? reader.u16() : reader.u8() * 2;
      check(width > 0 && height > 0 && x + width <= target.width && y + height <= target.height, 'Bounding box outside its target');
      const rle = reader.take(reader.remaining);
      const pixels = decodeRle(rle, 0, width * height, true);
      if (!walk.apply) return;
      if (note) note({ x, y, width, height });
      for (let i = 0; i < pixels.length; i++) target.put(x + (i % width), y + ((i / width) | 0), pixels[i], ORIGIN.PIXELS);
    }

    drawRectCopy(reader, target, walk, note) {
      const id = reader.u16();
      const x = evaluateValue(reader, walk.frame);
      const y = evaluateValue(reader, walk.frame);
      const width = reader.u16();
      const height = reader.u16();
      const dx = evaluateValue(reader, walk.frame);
      const dy = evaluateValue(reader, walk.frame);
      reader.done();
      check(x >= 0 && y >= 0, 'Negative copy source');
      let source;
      let origin = null; // null: each pixel keeps the origin it had in the source
      if (id === SCREEN) {
        source = walk.screen;
      } else if (id === CURRENT) {
        source = target;
        origin = ORIGIN.DRAWN;
      } else {
        walk.references.add(id);
        source = this.resourceTarget(id, false);
        origin = this.host.resourceOrigin(id);
      }
      check(width > 0 && height > 0 && x + width <= source.width && y + height <= source.height, 'Copy source outside its image');
      // Mirrors the firmware's overflow guard before the depth shift.
      if (!walk.apply || dx < -65536 || dx > 65536) return;
      if (note) note({ x: dx, y: dy, width, height, source: id });
      // Clip the destination to the writable area, in shifted target pixels. The source is read unshifted.
      const originX = dx + target.shiftX;
      let left = Math.max(originX, 0);
      let right = Math.min(originX + width, target.width);
      let top = Math.max(dy, 0);
      let bottom = Math.min(dy + height, target.height);
      if (target.clip) {
        left = Math.max(left, target.clip[0]);
        top = Math.max(top, target.clip[1]);
        right = Math.min(right, target.clip[2]);
        bottom = Math.min(bottom, target.clip[3]);
      }
      if (left >= right || top >= bottom) return;
      const count = right - left;
      const rows = bottom - top;
      const sourceX = x + (left - originX);
      const sourceY = y + (top - dy);
      // Read everything first, so an overlapping copy has memmove semantics.
      const values = new Uint8Array(count * rows);
      const origins = origin === null && source.origin ? new Uint8Array(count * rows) : null;
      for (let row = 0, i = 0; row < rows; row++) {
        for (let column = 0; column < count; column++, i++) {
          values[i] = source.get(sourceX + column, sourceY + row);
          if (origins) origins[i] = source.origin[(sourceY + row) * source.width + sourceX + column];
        }
      }
      const fixed = origin === null ? ORIGIN.UNKNOWN : origin;
      for (let row = 0, i = 0; row < rows; row++) {
        for (let column = 0; column < count; column++, i++) {
          target.set(left + column, top + row, values[i], origins ? origins[i] : fixed);
        }
      }
    }

    drawStockText(reader, target, walk, note) {
      let x = reader.s16();
      const y = reader.s16();
      const options = reader.u8();
      const bytes = reader.take(reader.u8());
      reader.done();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        check(false, 'Stock text is not UTF-8');
      }
      const codePoints = Array.from(text, (character) => character.codePointAt(0));
      const startX = x;
      let bottom = y;
      for (let i = 0; i < codePoints.length; i++) {
        const codePoint = codePoints[i];
        if (codePoint >= 1 && codePoint <= 31) {
          x += codePoint - 11;
          continue;
        }
        let next = 0;
        for (let j = i + 1; j < codePoints.length; j++) {
          if (codePoints[j] < 1 || codePoints[j] > 31) {
            next = codePoints[j];
            break;
          }
        }
        check(this.host.builtin, 'Builtin font provider required');
        const glyph = this.host.builtin(codePoint, next);
        const image = decodeImage(glyph.image, 0, walk.apply);
        if (walk.apply) this.drawPixels(image, target, x + glyph.x, y + glyph.y, options, ORIGIN.DRAWN);
        bottom = Math.max(bottom, y + glyph.y + image.height);
        x += glyph.advance;
      }
      if (walk.apply && note) note({ x: startX, y, width: Math.max(1, x - startX), height: Math.max(1, bottom - y), text });
    }

    drawImage(reader, target, walk, note) {
      const id = reader.u16();
      const x = evaluateValue(reader, walk.frame);
      const y = evaluateValue(reader, walk.frame);
      const options = reader.u8();
      reader.done();
      walk.references.add(id);
      const image = decodeImage(this.resource(id), 0, walk.apply);
      // Far-off coordinates draw nothing (before the depth shift can overflow).
      if (!walk.apply || x < -65536 || x > 65536 || y < -65536 || y > 65536) return;
      if (note) note({ x, y, width: image.width, height: image.height, source: id });
      this.drawPixels(image, target, x, y, options, this.host.resourceOrigin(id));
    }

    drawText(reader, target, walk, note) {
      const id = reader.u16();
      let x = evaluateValue(reader, walk.frame);
      const y = evaluateValue(reader, walk.frame);
      const options = reader.u8();
      const text = reader.take(reader.u8());
      reader.done();
      walk.references.add(id);
      const data = this.resource(id);
      check(data.length >= 193 && data[0] === RESOURCE_FONT, 'Resource ' + id + ' is not a font');
      const apply = walk.apply && !(x < -65536 || x > 65536 || y < -65536 || y > 65536);
      const startX = x;
      let height = 1;
      for (const character of text) {
        if (character >= 1 && character <= 31) {
          x += character - 11;
          continue;
        }
        check(character >= 32 && character <= 127, 'Text outside the font');
        const offset = data[1 + (character - 32) * 2] | (data[2 + (character - 32) * 2] << 8);
        check(offset >= 193, 'Glyph missing from the font');
        const glyph = decodeImage(data, offset, apply);
        if (apply) this.drawPixels(glyph, target, x, y, options, ORIGIN.FONT);
        height = Math.max(height, glyph.height);
        x += glyph.width;
      }
      if (apply && note) {
        note({ x: startX, y, width: Math.max(1, x - startX), height, source: id, text: String.fromCharCode(...Array.from(text).filter((c) => c >= 32)) });
      }
    }

    remapColors(reader, target, walk, note) {
      const x = reader.u16();
      const y = reader.u16();
      const width = reader.u16();
      const height = reader.u16();
      const tables = reader.take(16);
      reader.done();
      check(width > 0 && height > 0 && x + width <= target.width && y + height <= target.height, 'Color remap outside its target');
      if (!walk.apply) return;
      if (note) note({ x, y, width, height });
      for (let yy = y; yy < y + height; yy++) {
        for (let xx = x; xx < x + width; xx++) {
          const tx = xx + target.shiftX;
          if (!target.writable(tx, yy)) continue;
          const value = target.get(tx, yy);
          // The even-parity table comes first; parity is of the shifted target pixel.
          const entry = tables[((tx + yy) & 1) * 8 + (value >> 1)];
          target.set(tx, yy, value & 1 ? entry & 15 : entry >> 4, KEEP);
        }
      }
    }

    /** The stepping is GrayImage.drawLine's, as in the firmware. */
    drawLine(reader, target, walk, note) {
      let x = evaluateValue(reader, walk.frame);
      let y = evaluateValue(reader, walk.frame);
      const endX = evaluateValue(reader, walk.frame);
      const endY = evaluateValue(reader, walk.frame);
      const color = reader.u8();
      reader.done();
      check(color <= 15, 'Line color out of range');
      if (!walk.apply) return;
      if ([x, y, endX, endY].some((value) => Math.abs(value) > LINE_COORDINATE_LIMIT)) return;
      if (note) note({ x: Math.min(x, endX), y: Math.min(y, endY), width: Math.abs(endX - x) + 1, height: Math.abs(endY - y) + 1 });
      const dx = Math.abs(endX - x), stepX = x < endX ? 1 : -1;
      const dy = -Math.abs(endY - y), stepY = y < endY ? 1 : -1;
      for (let error = dx + dy; ;) {
        target.put(x, y, color, ORIGIN.DRAWN);
        if (x === endX && y === endY) break;
        const doubled = 2 * error;
        if (doubled >= dy) { error += dy; x += stepX; }
        if (doubled <= dx) { error += dx; y += stepY; }
      }
    }

    clear(reader, target, walk, note) {
      const color = reader.u8();
      reader.done();
      check(color <= 15, 'Clear color out of range');
      if (!walk.apply) return;
      const clip = target.clip;
      if (!clip) {
        if (note) note({ x: 0, y: 0, width: target.width, height: target.height });
        target.bytes.fill(color * 17, target.offset, target.offset + target.stride * target.height);
        if (target.origin) target.origin.fill(ORIGIN.DRAWN);
        return;
      }
      // A clipped clear fills just the clip, which is in shifted pixels already.
      const left = Math.max(0, clip[0]);
      const top = Math.max(0, clip[1]);
      const right = Math.min(target.width, clip[2]);
      const bottom = Math.min(target.height, clip[3]);
      if (note) note({ x: left - target.shiftX, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) target.set(x, y, color, ORIGIN.DRAWN);
      }
    }

    drawRoundedRect(reader, target, walk, note) {
      const x = evaluateValue(reader, walk.frame);
      const y = evaluateValue(reader, walk.frame);
      const width = reader.u16();
      const height = reader.u16();
      const radius = reader.u16();
      const fill = reader.u8();
      const border = reader.u8();
      // An optional trailing color for the corners outside the shape.
      let outside = NO_OUTSIDE;
      if (reader.remaining === 1) {
        outside = reader.u8();
        check(outside <= 15, 'Outside color out of range');
      }
      reader.done();
      check(width >= 1 && width <= 640 && height >= 1 && height <= 480 && fill <= 15 && border <= NO_BORDER, 'Rounded rectangle out of range');
      if (!walk.apply) return;
      if (note) note({ x, y, width, height });
      if (x < -width - target.shiftX || x >= target.width - target.shiftX || y < -height || y >= target.height) return;
      for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width; xx++) {
          const tx = x + xx + target.shiftX;
          const ty = y + yy;
          if (tx < 0 || tx >= target.width || ty < 0 || ty >= target.height) continue;
          if (!roundedContains(xx, yy, width, height, radius)) {
            if (outside !== NO_OUTSIDE) target.set(tx, ty, outside, ORIGIN.DRAWN);
            continue;
          }
          const edge = !roundedContains(xx - 1, yy - 1, width - 2, height - 2, Math.max(0, radius - 1));
          if (edge && border < NO_BORDER) {
            target.set(tx, ty, border, ORIGIN.DRAWN);
          } else {
            // The background is max-blended: where it is darker than what is there, nothing changes.
            const old = target.get(tx, ty);
            if (fill > old) target.set(tx, ty, fill, ORIGIN.DRAWN);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // One lens

  /**
   * One lens's display state and what it is showing. Messages change the state; only PRESENT
   * changes what is shown, by snapshotting the state the root list is then composed from.
   */
  class Lens {
    constructor(right = false) {
      this.right = right;
      this.width = 0;
      this.height = 0;
      this.resources = new Map();
      /** id -> ORIGIN.SURFACE (created, drawn into) or ORIGIN.IMAGE (uploaded). */
      this.origins = new Map();
      /** Resources whose bytes a snapshot also holds: copied before they are next written. */
      this.shared = new Set();
      this.screen = new Uint8Array(0);
      this.screenOrigin = new Uint8Array(0);
      this.root = SCREEN;
      this.presented = null;
      this.builtin = null;
      this.renderer = new Renderer(this);
    }

    resize(width, height) {
      if (width === this.width && height === this.height) return;
      this.width = width;
      this.height = height;
      this.screen = new Uint8Array(((width + 1) >> 1) * height);
      this.screenOrigin = new Uint8Array(width * height);
      this.presented = null;
    }

    writableResource(id) {
      let bytes = this.resources.get(id);
      if (this.shared.has(id)) {
        bytes = bytes.slice();
        this.resources.set(id, bytes);
        this.shared.delete(id);
      }
      return bytes;
    }

    resourceOrigin(id) {
      return this.origins.get(id) || ORIGIN.IMAGE;
    }

    /** A recording's `state` record (see recording.js), as if it had just been presented. */
    loadState(state) {
      this.resize(state.width, state.height);
      this.screen.fill(0);
      this.screenOrigin.fill(ORIGIN.UNKNOWN);
      if (state.screen) this.screen.set(state.screen.subarray(0, this.screen.length));
      this.root = state.root;
      this.resources = new Map();
      this.origins = new Map();
      this.shared = new Set();
      for (const resource of state.resources) {
        this.resources.set(resource.id, resource.data.slice());
        this.origins.set(resource.id, resource.owner ? ORIGIN.SURFACE : ORIGIN.IMAGE);
      }
      this.present(null);
    }

    screenTarget() {
      return new Target(this.screen, this.width, this.height, 0, 0, null, this.screenOrigin);
    }

    /**
     * Apply one private-stream message. `t` is when the lens acknowledged it. `trace`, if given,
     * collects the rectangle each draw call touched. Returns the message type; a message the
     * firmware would reject throws ProtocolError and changes nothing visible.
     */
    apply(payload, t = null, trace = null) {
      const type = payload[0] & 127;
      if (type === MSG.UPLOAD) {
        const count = payload[1] | (payload[2] << 8);
        let p = 3;
        for (let i = 0; i < count; i++) {
          check(p + 10 <= payload.length, 'Truncated upload');
          const id = payload[p] | (payload[p + 1] << 8);
          const total = (payload[p + 2] | (payload[p + 3] << 8) | (payload[p + 4] << 16) | (payload[p + 5] << 24)) >>> 0;
          const offset = payload[p + 6] | (payload[p + 7] << 8);
          const size = payload[p + 8] | (payload[p + 9] << 8);
          check(p + 10 + size <= payload.length && offset + size <= total && total <= 65536, 'Upload chunk out of range');
          let bytes = this.resources.get(id);
          if (!bytes || bytes.length !== total || offset === 0) {
            bytes = new Uint8Array(total);
            this.resources.set(id, bytes);
            this.shared.delete(id);
          } else {
            bytes = this.writableResource(id);
          }
          bytes.set(payload.subarray(p + 10, p + 10 + size), offset);
          this.origins.set(id, ORIGIN.IMAGE);
          p += 10 + size;
        }
      } else if (type === MSG.EVICT) {
        const count = payload[1] | (payload[2] << 8);
        check(3 + count * 2 <= payload.length, 'Truncated eviction');
        for (let i = 0; i < count; i++) {
          const id = payload[3 + i * 2] | (payload[4 + i * 2] << 8);
          this.resources.delete(id);
          this.origins.delete(id);
          this.shared.delete(id);
        }
      } else if (type === MSG.CREATE) {
        const count = payload[1] | (payload[2] << 8);
        check(3 + count * 6 <= payload.length, 'Truncated surface creation');
        for (let i = 0; i < count; i++) {
          const p = 3 + i * 6;
          const id = payload[p] | (payload[p + 1] << 8);
          const width = payload[p + 2] | (payload[p + 3] << 8);
          const height = payload[p + 4] | (payload[p + 5] << 8);
          check(width >= 1 && width <= 640 && height >= 1 && height <= 480, 'Surface size out of range');
          // Replaying creation of an existing surface of the same geometry preserves its contents.
          const existing = this.resources.get(id);
          const size = 5 + ((width + 1) >> 1) * height;
          const same = existing && existing.length === size && existing[0] === RESOURCE_LARGE &&
            (existing[1] | (existing[2] << 8)) === width && (existing[3] | (existing[4] << 8)) === height;
          if (!same) {
            const bytes = new Uint8Array(size);
            bytes.set([RESOURCE_LARGE, width & 255, width >> 8, height & 255, height >> 8]);
            this.resources.set(id, bytes);
            this.shared.delete(id);
          }
          this.origins.set(id, ORIGIN.SURFACE);
        }
      } else if (type === MSG.DRAW) {
        check(this.width > 0, 'Screen size unknown');
        this.renderer.execute(payload.subarray(1), this.screenTarget(), undefined, 0, trace);
      } else if (type === MSG.ROOT) {
        check(payload.length >= 3, 'Truncated root');
        this.root = payload[1] | (payload[2] << 8);
      } else if (type === MSG.PRESENT) {
        check(this.width > 0, 'Screen size unknown');
        this.present(t, trace);
      }
      return type;
    }

    /** Take what the root list will be composed from, as of now. */
    present(t, trace = null) {
      const snapshot = {
        t,
        root: this.root,
        screen: this.screen.slice(),
        screenOrigin: this.screenOrigin.slice(),
        resources: new Map(this.resources),
        origins: new Map(this.origins),
      };
      for (const id of this.resources.keys()) this.shared.add(id);
      // The firmware validates the graph before presenting; a rejected one leaves the display as it was.
      this.compose(snapshot, 0, trace, trace === null);
      this.presented = snapshot;
    }

    compose(snapshot, elapsedMs, trace = null, validateOnly = false) {
      const stride = (this.width + 1) >> 1;
      const composition = new Uint8Array(stride * this.height);
      const origin = new Uint8Array(this.width * this.height);
      const host = {
        resources: snapshot.resources,
        right: this.right,
        builtin: this.builtin,
        // A root list that draws into a resource changes the snapshot's copy only.
        writableResource: (id) => {
          const bytes = snapshot.resources.get(id).slice();
          snapshot.resources.set(id, bytes);
          return bytes;
        },
        resourceOrigin: (id) => snapshot.origins.get(id) || ORIGIN.IMAGE,
      };
      const renderer = new Renderer(host);
      renderer.render(snapshot.root,
        new Target(snapshot.screen, this.width, this.height, 0, 0, null, snapshot.screenOrigin),
        new Target(composition, this.width, this.height, 0, 0, null, origin), elapsedMs, trace, validateOnly);
      return { pixels: composition, origin, animationPending: renderer.animationPending };
    }

    /**
     * What the lens shows at time `t` (null: with every animation settled): packed 4bpp
     * `pixels`, one ORIGIN per pixel in `origin`, and whether an animation is still running.
     */
    display(t = null) {
      const stride = (this.width + 1) >> 1;
      if (!this.presented) {
        return { pixels: new Uint8Array(stride * this.height), origin: new Uint8Array(this.width * this.height), animationPending: false };
      }
      const since = this.presented.t;
      const elapsed = t === null || since === null ? SETTLED_MS : Math.max(0, t - since);
      try {
        return this.compose(this.presented, elapsed);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return { pixels: new Uint8Array(stride * this.height), origin: new Uint8Array(this.width * this.height), animationPending: false, error: error.message };
      }
    }

    /** Everything needed to come back to this moment; cheap, since bytes are shared until written. */
    save() {
      for (const id of this.resources.keys()) this.shared.add(id);
      return {
        width: this.width,
        height: this.height,
        resources: new Map(this.resources),
        origins: new Map(this.origins),
        screen: this.screen.slice(),
        screenOrigin: this.screenOrigin.slice(),
        root: this.root,
        presented: this.presented,
      };
    }

    restore(saved) {
      this.width = saved.width;
      this.height = saved.height;
      this.resources = new Map(saved.resources);
      this.origins = new Map(saved.origins);
      this.shared = new Set(saved.resources.keys());
      this.screen = saved.screen.slice();
      this.screenOrigin = saved.screenOrigin.slice();
      this.root = saved.root;
      this.presented = saved.presented;
    }
  }

  // ---------------------------------------------------------------------
  // Seeking

  /**
   * A lens moved through a list of timed messages (`ops`: {t, payload}, in the order the lens
   * acknowledged them). Keeps periodic saves so any moment is a short replay away.
   */
  class Player {
    constructor(lens, ops, options = {}) {
      this.lens = lens;
      this.ops = ops;
      this.interval = Math.max(options.interval || 48, Math.ceil(ops.length / 256));
      this.position = 0;
      /** Per op, the error that made the firmware reject it (if it did). */
      this.errors = new Map();
      this.saves = [{ position: 0, state: lens.save() }];
    }

    /** How many ops have been acknowledged by time `t`. */
    positionAt(t) {
      let low = 0;
      let high = this.ops.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (this.ops[middle].t <= t) low = middle + 1;
        else high = middle;
      }
      return low;
    }

    /** Move to the state after the first `position` ops. */
    seek(position) {
      position = Math.max(0, Math.min(this.ops.length, position));
      if (position < this.position || position - this.position > this.interval) {
        let best = this.saves[0];
        for (const save of this.saves) {
          if (save.position <= position && save.position >= best.position) best = save;
        }
        if (position < this.position || best.position > this.position) {
          this.lens.restore(best.state);
          this.position = best.position;
        }
      }
      while (this.position < position) this.step();
      return this;
    }

    /** Apply the next op; `trace` collects the rectangles its draw calls touch. */
    step(trace = null) {
      const op = this.ops[this.position];
      try {
        this.lens.apply(op.payload, op.t, trace);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.errors.set(this.position, error.message);
      }
      this.position++;
      if (this.position % this.interval === 0 && !this.saves.some((save) => save.position === this.position)) {
        this.saves.push({ position: this.position, state: this.lens.save() });
      }
    }
  }

  return { SCREEN, CURRENT, MSG, OP, ORIGIN, SETTLED_MS, ProtocolError, Reader, Target, Renderer, Lens, Player, decodeImage, decodeRle, readVarint, depthOffset };
});
