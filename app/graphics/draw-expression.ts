/** Revision 27 expression bytecode. ELAPSED is a bridge binding, never sent to firmware. */
export const ExprOp = {
  I32: 1, F32: 2, DUP: 3, DROP: 4, SWAP: 5,
  IADD: 16, ISUB: 17, IMUL: 18, IDIV: 19, IMOD: 20, INEG: 21, IMIN: 22, IMAX: 23,
  FADD: 32, FSUB: 33, FMUL: 34, FDIV: 35, FNEG: 36, FMIN: 37, FMAX: 38,
  I2F: 48, F2I: 49, TIME: 50, LERP: 64, SMOOTHSTEP: 65,
  EASE_IN_QUAD: 66, EASE_OUT_QUAD: 67, EASE_IN_OUT_QUAD: 68,
  EASE_IN_CUBIC: 69, EASE_OUT_CUBIC: 70, EASE_IN_OUT_CUBIC: 71,
  ELAPSED: 128,
} as const;

export function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Draw integer out of range');
  return value;
}
export function varint(value: number, signed = true): number[] {
  integer(value, signed ? -2147483648 : 0, signed ? 2147483647 : 4294967295);
  const widths = [7, 14, 21, 28, 32], prefixes = [0, 128, 192, 224, 240];
  const size = widths.findIndex(bits => bits === 32 || (signed
    ? value >= -(2 ** (bits - 1)) && value < 2 ** (bits - 1) : value < 2 ** bits)) + 1;
  const bytes = [size === 5 ? 240 : prefixes[size - 1] | ((value >>> (8 * (size - 1))) & ((1 << (8 - size)) - 1))];
  for (let i = 1; i < size; i++) bytes.push((value >>> (8 * (size - 1 - i))) & 255);
  return bytes;
}

export class DrawBytes {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(size: number): Uint8Array {
    integer(size, 0, this.bytes.length - this.offset);
    const result = this.bytes.slice(this.offset, this.offset + size); this.offset += size; return result;
  }
  u8(): number { return this.take(1)[0]; }
  u16(): number { return this.u8() | this.u8() << 8; }
  i16(): number { return this.u16() << 16 >> 16; }
  u32(): number { return (this.u16() | this.u16() << 16) >>> 0; }
  variable(signed = true): number {
    const first = this.u8();
    const size = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : first === 240 ? 5 : 0;
    if (!size) throw new Error('Reserved extended-varint prefix');
    let value = size === 5 ? 0 : first & ((1 << (8 - size)) - 1);
    for (let i = 1; i < size; i++) value = (value << 8) | this.u8();
    const bits = [7, 14, 21, 28, 32][size - 1];
    return signed ? bits < 32 ? value << (32 - bits) >> (32 - bits) : value : value >>> 0;
  }
}

/** Immutable, typed expression builder; operations use firmware i32/f32 semantics. */
export class DrawExpression<T extends 'i32' | 'f32'> {
  private constructor(readonly type: T, readonly code: readonly number[]) {
    // Leave room for native elapsed bindings and surface translation.
    if (code.length > 900) throw new Error('Draw expression too large');
  }
  static i32(value: number): DrawExpression<'i32'> { return new DrawExpression('i32', [ExprOp.I32, ...varint(value)]); }
  static f32(value: number): DrawExpression<'f32'> {
    if (!Number.isFinite(Math.fround(value))) throw new Error('Invalid draw float');
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, value, true);
    return new DrawExpression('f32', [ExprOp.F32, ...bytes]);
  }
  /** Time already elapsed on this list's timeline when the next PRESENT happens. */
  static elapsed(): DrawExpression<'i32'> { return new DrawExpression('i32', [ExprOp.ELAPSED]); }
  /**
   * A 0..1 timeline fraction that survives subsequent PRESENT clock resets.
   * With a delay, it stays 0 for the first delayMs of the timeline; a
   * negative delay continues a motion that started before the timeline.
   */
  static progress(durationMs: number, delayMs = 0): DrawExpression<'f32'> {
    integer(delayMs, -2147483647, 2147483647);
    if (delayMs + durationMs <= 0) return DrawExpression.f32(1);
    const duration = DrawExpression.i32(integer(durationMs, 1, 2147483647));
    const end = DrawExpression.i32(integer(delayMs + durationMs, 1, 2147483647));
    const elapsed = DrawExpression.elapsed().min(end);
    let total = end.sub(elapsed).max(DrawExpression.i32(0)).time().add(elapsed);
    if (delayMs) total = total.sub(DrawExpression.i32(delayMs)).max(DrawExpression.i32(0));
    return total.toFloat().div(duration.toFloat());
  }
  static decode(code: Uint8Array): DrawExpression<'i32'> { return new DrawExpression('i32', Array.from(code)); }
  private binary(other: DrawExpression<T>, i: number, f: number): DrawExpression<T> {
    if (other.type !== this.type) throw new Error('Draw expression type mismatch');
    return new DrawExpression(this.type, [...this.code, ...other.code, this.type === 'i32' ? i : f]);
  }
  add(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.IADD, ExprOp.FADD); }
  sub(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.ISUB, ExprOp.FSUB); }
  mul(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.IMUL, ExprOp.FMUL); }
  div(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.IDIV, ExprOp.FDIV); }
  min(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.IMIN, ExprOp.FMIN); }
  max(b: DrawExpression<T>): DrawExpression<T> { return this.binary(b, ExprOp.IMAX, ExprOp.FMAX); }
  mod(this: DrawExpression<'i32'>, b: DrawExpression<'i32'>): DrawExpression<'i32'> { return this.binary(b, ExprOp.IMOD, ExprOp.IMOD); }
  neg(): DrawExpression<T> { return new DrawExpression(this.type, [...this.code, this.type === 'i32' ? ExprOp.INEG : ExprOp.FNEG]); }
  toFloat(this: DrawExpression<'i32'>): DrawExpression<'f32'> { return new DrawExpression('f32', [...this.code, ExprOp.I2F]); }
  toInt(this: DrawExpression<'f32'>): DrawExpression<'i32'> { return new DrawExpression('i32', [...this.code, ExprOp.F2I]); }
  time(this: DrawExpression<'i32'>): DrawExpression<'i32'> { return new DrawExpression('i32', [...this.code, ExprOp.TIME]); }
  ease(this: DrawExpression<'f32'>, op: number = ExprOp.SMOOTHSTEP): DrawExpression<'f32'> {
    integer(op, ExprOp.SMOOTHSTEP, ExprOp.EASE_IN_OUT_CUBIC);
    return new DrawExpression('f32', [...this.code, op]);
  }
  lerp(this: DrawExpression<'f32'>, from: DrawExpression<'f32'>, to: DrawExpression<'f32'>): DrawExpression<'f32'> {
    return new DrawExpression('f32', [...from.code, ...to.code, ...this.code, ExprOp.LERP]);
  }
}
export type DrawValue = number | DrawExpression<'i32'>;
export function encodeValue(value: DrawValue): number[] {
  return typeof value === 'number' ? varint(value) : [255, ...varint(value.code.length, false), ...value.code];
}
export function readValue(reader: DrawBytes): DrawValue {
  if (reader.bytes[reader.offset] !== 255) return reader.variable();
  reader.u8(); return DrawExpression.decode(reader.take(reader.variable(false)));
}

/** Software preview of the same VM; invalid programs return zero and discard pending animation. */
export function evaluate(value: DrawValue, elapsed: number, presentTime = 0): { value: number; pending: boolean } {
  if (typeof value === 'number') return { value, pending: false };
  const reader = new DrawBytes(Uint8Array.from(value.code)), stack: { value: number; float: boolean }[] = [];
  let pending = false;
  const push = (value: number, float = false) => {
    value = float ? Math.fround(value) : value | 0;
    if (!Number.isFinite(value) || stack.length === 32) throw new Error('Invalid expression stack');
    stack.push({ value, float });
  };
  const pop = (float: boolean) => { const v = stack.pop(); if (!v || v.float !== float) throw new Error('Expression type mismatch'); return v.value; };
  const toInt = (v: number) => { if (v < -2147483648 || v >= 2147483648) throw new Error('Invalid integer conversion'); return Math.trunc(v); };
  try {
    while (reader.offset < reader.bytes.length) {
      const op = reader.u8();
      if (op === ExprOp.I32) push(reader.variable());
      else if (op === ExprOp.F32) { const b = reader.take(4); push(new DataView(b.buffer).getFloat32(0, true), true); }
      else if (op === ExprOp.ELAPSED) push(Math.min(2147483647, Math.max(0, elapsed)));
      else if (op === ExprOp.I2F) push(pop(false), true);
      else if (op === ExprOp.F2I) push(toInt(pop(true)));
      else if (op === ExprOp.TIME) { const max = pop(false); if (max < 0) throw new Error('Invalid time'); const t = Math.min(Math.max(0, presentTime), max); pending ||= t !== max; push(t); }
      else if (op === ExprOp.INEG || op === ExprOp.FNEG) push(-pop(op === ExprOp.FNEG), op === ExprOp.FNEG);
      else if (op >= ExprOp.IADD && op <= ExprOp.IMAX || op >= ExprOp.FADD && op <= ExprOp.FMAX) {
        const float = op >= ExprOp.FADD, b = pop(float), a = pop(float);
        const key = float ? op - ExprOp.FADD : op - ExprOp.IADD;
        if ((key === 3 || !float && key === 4) && b === 0) throw new Error('Division by zero');
        const result = key === 0 ? a + b : key === 1 ? a - b : key === 2 ? float ? a * b : Math.imul(a, b) : key === 3 ? a / b : !float && key === 4 ? a % b : key === (float ? 5 : 6) ? Math.min(a, b) : Math.max(a, b);
        push(result, float);
      } else if (op === ExprOp.LERP) { const t = pop(true), b = pop(true), a = pop(true); push(a + Math.fround(Math.fround(b - a) * t), true); }
      else if (op >= ExprOp.SMOOTHSTEP && op <= ExprOp.EASE_IN_OUT_CUBIC) {
        const t = Math.max(0, Math.min(1, pop(true))), u = Math.fround(1 - t), f = Math.fround;
        let result: number;
        switch (op) {
          case ExprOp.SMOOTHSTEP: result = f(t * t) * f(3 - f(2 * t)); break;
          case ExprOp.EASE_IN_QUAD: result = t * t; break;
          case ExprOp.EASE_OUT_QUAD: result = 1 - f(u * u); break;
          case ExprOp.EASE_IN_OUT_QUAD: result = t < .5 ? f(2 * t) * t : 1 - f(f(2 * u) * u); break;
          case ExprOp.EASE_IN_CUBIC: result = f(t * t) * t; break;
          case ExprOp.EASE_OUT_CUBIC: result = 1 - f(f(u * u) * u); break;
          default: result = t < .5 ? f(f(4 * t) * t) * t : 1 - f(f(f(4 * u) * u) * u);
        }
        push(result, true);
      } else if (op === ExprOp.DUP) { const a = stack[stack.length - 1]; if (!a) throw new Error('Underflow'); push(a.value, a.float); }
      else if (op === ExprOp.DROP) { if (!stack.pop()) throw new Error('Underflow'); }
      else if (op === ExprOp.SWAP) { if (stack.length < 2) throw new Error('Underflow'); const a = stack.pop()!, b = stack.pop()!; stack.push(a, b); }
      else throw new Error('Unknown expression opcode');
    }
    const top = stack.pop(); if (!top) throw new Error('Empty expression');
    return { value: top.float ? toInt(top.value) : top.value, pending };
  } catch { return { value: 0, pending: false }; }
}
