package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

class FaceclawRingEventDecoder {
    companion object {
        @JvmStatic
        fun decode(raw: ByteArray?): DirectRingEvent? {
            if (((raw == null) || (raw.size == 0))) {
                return null
            }
            var report: DirectRingEvent? = decodeRingReport(raw)
            if ((report != null)) {
                return report
            }
            return decodeDirectGesture(raw)
        }

        /**
         * The R1's standard input report, `00 09 61 00 TYPE AUX SPEED TICK_LE32`: the same
         * 11 bytes the ring sends the glasses, which CFW's gesture_fwd.c forwards as an EvenHub
         * SysEvent. TYPE maps exactly as CFW maps it, and the raw fields ride along as ring
         * metadata, so direct and glasses-relayed input look the same to the TypeScript side
         * (including RingInputFilter's 100-tick suppression). Unmapped types become
         * EVENT_RING_UNKNOWN, which is kept for diagnostics but never routed as a gesture.
         */
        private fun decodeRingReport(raw: ByteArray): DirectRingEvent? {
            if (raw.size != 11 || u8(raw[0]) != 0x00 || u8(raw[1]) != 0x09 ||
                u8(raw[2]) != 0x61 || u8(raw[3]) != 0x00) {
                return null
            }
            val type = u8(raw[4])
            val aux = u8(raw[5])
            val speed = u8(raw[6])
            val tick = (u8(raw[7]) or (u8(raw[8]) shl 8) or (u8(raw[9]) shl 16) or (u8(raw[10]) shl 24))
                .toLong() and 0xffffffffL
            val label = ringReportTypeName(type)
            val eventType = when (type) {
                0x00 -> BleProtocol.EVENT_RING_LONG_PRESS
                0x01 -> BleProtocol.EVENT_CLICK
                0x02 -> BleProtocol.EVENT_DOUBLE_CLICK
                0x04 -> BleProtocol.EVENT_SCROLL_TOP
                0x05 -> BleProtocol.EVENT_SCROLL_BOTTOM
                0x08 -> BleProtocol.EVENT_RING_LONG_PRESS_RELEASE
                0x09 -> BleProtocol.EVENT_SHORT_THEN_LONG_PRESS
                0x0a -> BleProtocol.EVENT_RING_PRESS
                else -> BleProtocol.EVENT_RING_UNKNOWN
            }
            val detail = "type=0x${type.toString(16).padStart(2, '0')}($label) " +
                "aux=0x${aux.toString(16).padStart(2, '0')} speed=0x${speed.toString(16).padStart(2, '0')} tick=$tick"
            return event(eventType, label, detail).also {
                it.event.ringTick = tick
                it.event.ringType = type
                it.event.ringAux = aux
                it.event.ringSpeed = speed
            }
        }

        private fun decodeDirectGesture(raw: ByteArray): DirectRingEvent? {
            if (((raw.size != 3) || (u8(raw[0]) != 0xff))) {
                return null
            }
            var type: Int = u8(raw[1])
            var param: Int = u8(raw[2])
            var detail: String =
                "type=0x${type.toString(16).padStart(2, '0')} param=0x${param.toString(16).padStart(2, '0')}"
            if (((type == 0x03) && (param == 0x20))) {
                return event(BleProtocol.EVENT_RING_LONG_PRESS, "HOLD", detail)
            }
            if (((type == 0x04) && (param == 0x01))) {
                return event(BleProtocol.EVENT_CLICK, "TAP_SINGLE", detail)
            }
            if (((type == 0x04) && (param == 0x02))) {
                return event(BleProtocol.EVENT_DOUBLE_CLICK, "TAP_DOUBLE", detail)
            }
            if ((type == 0x05)) {
                if ((param <= 0x01)) {
                    return event(BleProtocol.EVENT_SCROLL_BOTTOM, "SWIPE_FORWARD", detail)
                }
                return event(BleProtocol.EVENT_SCROLL_TOP, "SWIPE_BACKWARD", detail)
            }
            return null
        }

        private fun event(eventType: Int, label: String, detail: String): DirectRingEvent {
            var event: G2Event =
                G2Event("sys-event", "", eventType, BleProtocol.EVENT_SOURCE_RING, 0)
            return DirectRingEvent(event, label, detail)
        }

        private fun ringReportTypeName(type: Int): String {
            return when (type) {
                0x00 -> "LONG_PRESS"
                0x01 -> "TAP"
                0x02 -> "DOUBLE_TAP"
                0x04 -> "SWIPE_UP"
                0x05 -> "SWIPE_DOWN"
                0x08 -> "LONG_PRESS_RELEASE"
                0x09 -> "TAP_THEN_HOLD"
                0x0a -> "TOUCH_DOWN"
                else -> "UNKNOWN"
            }
        }

        private fun u8(value: Byte): Int {
            return (value and 0xff)
        }
    }

    constructor() {}

    class DirectRingEvent {
        @JvmField val event: G2Event

        @JvmField val label: String

        @JvmField val detail: String

        constructor(event: G2Event, label: String, detail: String) {
            this.event = event
            this.label = label
            this.detail = detail
        }
    }
}
