package com.faceclaw.app

import kotlin.math.abs
import kotlin.math.round

/** Which on-device model ONBOARD voice input loads. */
enum class VoiceModelKind {
    MOONSHINE,
    WHISPER,
}

/**
 * Whole-utterance (offline) recognizer: each call decodes one complete buffer. The Android
 * implementation wraps sherpa-onnx; a streaming recognizer (Apple Speech) could satisfy this
 * by buffering and re-running, but the session's REPLACE-semantics partials assume re-decoding
 * the same buffer is cheap enough on the MOONSHINE cadence.
 */
interface OfflineTranscriber {
    /** Returns the trimmed text for [count] float samples at 16 kHz, or "" when nothing was recognized. */
    fun recognize(samples: FloatArray, count: Int): String

    fun release()
}

/** Speaker voice-print extraction over 16 kHz mono S16LE PCM; null when unavailable or too short. */
interface SpeakerEmbedder {
    fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray?

    fun release()
}

/** Marshals listener callbacks to the platform's UI/JS thread (Android: the main Handler). */
fun interface CallbackDispatcher {
    fun post(action: () -> Unit)
}

/** Receives the session's decoded PCM once capture ends (Android saves a WAV file). */
fun interface RecordingSink {
    fun save(pcm16le: ByteArray, sampleRate: Int)
}

/** A G2 microphone packet decoder (the shared [Lc3PacketFramer] over a platform LC3 codec). */
interface AudioPacketDecoder {
    fun decodePacket(packet: ByteArray?, pcmOut: ShortArray?): Int

    val lastAngleDegrees: Int
    val lastSsr: Int
    val realPackets: Long
    val duplicatePackets: Long
    val missingPackets: Long
    val decodeErrors: Long

    fun close()
}

/** Glasses microphone packets over BLE (Android: FaceclawBleCommunicator's capture API). */
interface PacketAudioSource {
    fun start(listener: FaceclawAudioPacketListener): Boolean

    fun stop()

    /** Whether the glasses are still delivering packets for this capture. */
    fun isActive(): Boolean
}

/** The phone's own microphone delivering 16 kHz mono PCM16 in blocking reads. */
interface PcmAudioSource {
    /** Blocking read into [pcm]; returns samples read, 0 to retry, or a negative error. */
    fun read(pcm: ShortArray): Int

    fun close()
}

/** Formats [value] with exactly [decimals] fraction digits (the shared stand-in for %.Nf). */
fun formatFixed(value: Double, decimals: Int): String {
    var scale = 1L
    repeat(decimals) { scale *= 10 }
    val scaled = round(abs(value) * scale).toLong()
    val whole = scaled / scale
    val fraction = scaled % scale
    val sign = if (value < 0 && scaled != 0L) "-" else ""
    return if (decimals == 0) "$sign$whole" else "$sign$whole." + fraction.toString().padStart(decimals, '0')
}

/**
 * Bounded FIFO between a producer thread and one consumer: when full the oldest item is
 * dropped (counted). [take] waits up to [waitMs] and returns null on timeout or when [open] is
 * false, so the consumer can poll a stop flag and emit periodic diagnostics.
 */
class DroppingPacketQueue<T : Any>(private val capacity: Int, platform: ProtocolPlatform = protocolPlatform()) {
    private val condition = platform.createCondition()
    private val items = ArrayDeque<T>()
    var droppedCount: Long = 0
        private set

    fun put(item: T) {
        condition.withLock {
            if (items.size >= capacity) {
                items.removeFirst()
                droppedCount++
            }
            items.addLast(item)
            condition.signalAll()
        }
    }

    /** Runs [action] while holding the queue lock, after enqueuing (used to update stats atomically). */
    fun put(item: T, action: () -> Unit) {
        condition.withLock {
            if (items.size >= capacity) {
                items.removeFirst()
                droppedCount++
            }
            items.addLast(item)
            action()
            condition.signalAll()
        }
    }

    fun take(waitMs: Long, open: () -> Boolean): T? {
        condition.withLock {
            if (items.isEmpty() && open()) condition.awaitMs(waitMs)
            return items.removeFirstOrNull()
        }
    }

    fun clear() {
        condition.withLock {
            items.clear()
            droppedCount = 0
        }
    }

    fun wake() {
        condition.withLock { condition.signalAll() }
    }
}
