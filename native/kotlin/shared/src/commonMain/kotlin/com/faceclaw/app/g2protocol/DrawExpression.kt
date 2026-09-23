package com.faceclaw.app

/** Literal or branchless expression used by rounded-rectangle x/y in revision 27. */
sealed class DrawValue {
    class Integer(val value: Int) : DrawValue()
    class Expression(val program: ByteArray) : DrawValue()

    companion object {
        /** Smoothstep interpolation; time is measured from the next PRESENT. */
        fun animate(from: Int, to: Int, durationMs: Int, elapsedMs: Int = 0): DrawValue {
            require(durationMs > 0 && elapsedMs >= 0)
            if (from == to || elapsedMs >= durationMs) return Integer(to)
            val code = ByteSink()
            fun integer(value: Int) {
                code.write(DrawExpression.PUSH_I32)
                code.write(ExtendedVarint.signed(value))
            }
            integer(from)
            code.write(DrawExpression.I2F)
            integer(to)
            code.write(DrawExpression.I2F)
            integer(durationMs - elapsedMs)
            code.write(DrawExpression.TIME)
            integer(elapsedMs)
            code.write(DrawExpression.IADD)
            code.write(DrawExpression.I2F)
            integer(durationMs)
            code.write(DrawExpression.I2F)
            code.write(DrawExpression.FDIV)
            code.write(DrawExpression.SMOOTHSTEP)
            code.write(DrawExpression.LERP)
            code.write(DrawExpression.F2I)
            return Expression(code.toByteArray())
        }
    }
}

/** Prefix payload is most-significant first; continuation bytes use all eight bits. */
internal object ExtendedVarint {
    private val widths = intArrayOf(7, 14, 21, 28, 32)
    private val prefixes = intArrayOf(0, 0x80, 0xc0, 0xe0, 0xf0)

    fun signed(value: Int): ByteArray {
        val size = widths.indexOfFirst { bits ->
            bits == 32 || value.toLong() in -(1L shl (bits - 1)) until (1L shl (bits - 1))
        } + 1
        return encode(value, size)
    }

    fun unsigned(value: UInt): ByteArray {
        val size = widths.indexOfFirst { it == 32 || value.toLong() < (1L shl it) } + 1
        return encode(value.toInt(), size)
    }

    private fun encode(value: Int, size: Int): ByteArray {
        val bytes = ByteArray(size)
        if (size == 5) {
            bytes[0] = 0xf0.toByte()
        } else {
            val mask = (1 shl (8 - size)) - 1
            bytes[0] = (prefixes[size - 1] or ((value ushr (8 * (size - 1))) and mask)).toByte()
        }
        for (i in 1 until size) bytes[i] = (value ushr (8 * (size - 1 - i))).toByte()
        return bytes
    }

    fun read(reader: DrawReader, signed: Boolean, first: Int = reader.readU8()): Int {
        val size = when {
            first < 0x80 -> 1
            first < 0xc0 -> 2
            first < 0xe0 -> 3
            first < 0xf0 -> 4
            first == 0xf0 -> 5
            else -> error("Reserved extended-varint prefix")
        }
        var value = if (size == 5) 0 else first and ((1 shl (8 - size)) - 1)
        repeat(size - 1) { value = (value shl 8) or reader.readU8() }
        val bits = widths[size - 1]
        return if (signed && bits < 32) (value shl (32 - bits)) shr (32 - bits) else value
    }

    fun write(value: DrawValue): ByteArray = when (value) {
        is DrawValue.Integer -> signed(value.value)
        is DrawValue.Expression -> {
            require(value.program.size <= DrawExpression.MAX_BYTES)
            byteArrayOf(0xff.toByte()) + unsigned(value.program.size.toUInt()) + value.program
        }
    }

    fun evaluate(reader: DrawReader, frame: DrawEvaluation): Int {
        val first = reader.readU8()
        if (first != 0xff) return read(reader, true, first)
        val length = read(reader, false).toUInt()
        // Outer framing errors reject the call; errors inside a framed program yield zero.
        require(length <= reader.remaining.toUInt())
        val program = reader.readSlice(length.toInt())
        if (length > DrawExpression.MAX_BYTES.toUInt()) return 0
        return DrawExpression.evaluate(program, frame)
    }
}

internal class DrawEvaluation(val elapsedMs: Long) {
    var animationPending = false
}

/** Typed i32/f32 stack machine. Keep opcode IDs and semantics in sync with draw_expression.c. */
internal object DrawExpression {
    const val MAX_BYTES = 1024
    const val MAX_STACK = 32
    const val PUSH_I32 = 1
    const val PUSH_F32 = 2
    const val DUP = 3
    const val DROP = 4
    const val SWAP = 5
    const val IADD = 16
    const val ISUB = 17
    const val IMUL = 18
    const val IDIV = 19
    const val IMOD = 20
    const val INEG = 21
    const val IMIN = 22
    const val IMAX = 23
    const val FADD = 32
    const val FSUB = 33
    const val FMUL = 34
    const val FDIV = 35
    const val FNEG = 36
    const val FMIN = 37
    const val FMAX = 38
    const val I2F = 48
    const val F2I = 49
    const val TIME = 50
    const val LERP = 64
    const val SMOOTHSTEP = 65
    const val EASE_IN_QUAD = 66
    const val EASE_OUT_QUAD = 67
    const val EASE_IN_OUT_QUAD = 68
    const val EASE_IN_CUBIC = 69
    const val EASE_OUT_CUBIC = 70
    const val EASE_IN_OUT_CUBIC = 71

    fun evaluate(reader: DrawReader, frame: DrawEvaluation): Int {
        val bits = IntArray(MAX_STACK)
        val floats = BooleanArray(MAX_STACK)
        var size = 0
        var pending = false
        fun push(value: Int, float: Boolean = false) {
            require(size < MAX_STACK)
            bits[size] = value
            floats[size++] = float
        }
        fun integer(): Int {
            require(size > 0 && !floats[size - 1])
            return bits[--size]
        }
        fun float(): Float {
            require(size > 0 && floats[size - 1])
            return Float.fromBits(bits[--size])
        }
        fun pushFloat(value: Float) {
            require(value.isFinite())
            push(value.toBits(), true)
        }
        fun toInteger(value: Float): Int {
            require(value.isFinite() && value >= -2147483648f && value < 2147483648f)
            return value.toInt()
        }
        try {
            require(reader.remaining <= MAX_BYTES)
            while (reader.remaining > 0) {
                when (val op = reader.readU8()) {
                    PUSH_I32 -> push(ExtendedVarint.read(reader, true))
                    PUSH_F32 -> {
                        val value = reader.readU8() or (reader.readU8() shl 8) or
                            (reader.readU8() shl 16) or (reader.readU8() shl 24)
                        pushFloat(Float.fromBits(value))
                    }
                    DUP -> {
                        require(size > 0)
                        push(bits[size - 1], floats[size - 1])
                    }
                    DROP -> { require(size > 0); size-- }
                    SWAP -> {
                        require(size >= 2)
                        val value = bits[size - 1]
                        val type = floats[size - 1]
                        bits[size - 1] = bits[size - 2]
                        floats[size - 1] = floats[size - 2]
                        bits[size - 2] = value
                        floats[size - 2] = type
                    }
                    IADD, ISUB, IMUL, IDIV, IMOD, IMIN, IMAX -> {
                        val b = integer()
                        val a = integer()
                        push(when (op) {
                            IADD -> a + b
                            ISUB -> a - b
                            IMUL -> a * b
                            IDIV -> { require(b != 0); if (a == Int.MIN_VALUE && b == -1) a else a / b }
                            IMOD -> { require(b != 0); if (a == Int.MIN_VALUE && b == -1) 0 else a % b }
                            IMIN -> minOf(a, b)
                            else -> maxOf(a, b)
                        })
                    }
                    INEG -> push(-integer())
                    FADD, FSUB, FMUL, FDIV, FMIN, FMAX -> {
                        val b = float()
                        val a = float()
                        pushFloat(when (op) {
                            FADD -> a + b
                            FSUB -> a - b
                            FMUL -> a * b
                            FDIV -> { require(b != 0f); a / b }
                            FMIN -> minOf(a, b)
                            else -> maxOf(a, b)
                        })
                    }
                    FNEG -> pushFloat(-float())
                    I2F -> pushFloat(integer().toFloat())
                    F2I -> push(toInteger(float()))
                    TIME -> {
                        val maximum = integer()
                        require(maximum >= 0)
                        val time = frame.elapsedMs.coerceIn(0, maximum.toLong()).toInt()
                        if (time != maximum) pending = true
                        push(time)
                    }
                    LERP -> {
                        val t = float()
                        val b = float()
                        val a = float()
                        pushFloat(a + (b - a) * t)
                    }
                    in SMOOTHSTEP..EASE_IN_OUT_CUBIC -> {
                        val t = float().coerceIn(0f, 1f)
                        val u = 1f - t
                        pushFloat(when (op) {
                            SMOOTHSTEP -> t * t * (3f - 2f * t)
                            EASE_IN_QUAD -> t * t
                            EASE_OUT_QUAD -> 1f - u * u
                            EASE_IN_OUT_QUAD -> if (t < .5f) 2f * t * t else 1f - 2f * u * u
                            EASE_IN_CUBIC -> t * t * t
                            EASE_OUT_CUBIC -> 1f - u * u * u
                            else -> if (t < .5f) 4f * t * t * t else 1f - 4f * u * u * u
                        })
                    }
                    else -> error("Unknown expression opcode")
                }
            }
            require(size > 0)
            val result = if (floats[size - 1]) toInteger(float()) else integer()
            frame.animationPending = frame.animationPending || pending
            return result
        } catch (_: IllegalArgumentException) {
            return 0
        } catch (_: IllegalStateException) {
            return 0
        }
    }
}
