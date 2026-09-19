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
            var chargerGesture: DirectRingEvent? = decodeChargerGesture(raw)
            if ((chargerGesture != null)) {
                return chargerGesture
            }
            return decodeDirectGesture(raw)
        }

        private fun decodeChargerGesture(raw: ByteArray): DirectRingEvent? {
            if ((raw.size != 11)) {
                return null
            }
            if (
                ((((u8(raw[0]) != 0x00) || (u8(raw[1]) != 0x09)) || (u8(raw[2]) != 0x61)) ||
                    (u8(raw[3]) != 0x00))
            ) {
                return null
            }
            var code: Int = u8(raw[4])
            var param: Int = (u8(raw[5]) or (u8(raw[6]) shl 8))
            var tick: Long =
                ((((u8(raw[7]) or (u8(raw[8]) shl 8)) or (u8(raw[9]) shl 16)) or
                        (u8(raw[10]) shl 24))
                    .toLong() and 0xffffffffL)
            var detail: String =
                "code=0x${code.toString(16).padStart(2, '0')}(${chargerCodeName(code)}) param=0x${param.toString(16).padStart(4, '0')} tick=$tick"
            when (code) {
                0x00 -> {
                    return event(BleProtocol.EVENT_RING_LONG_PRESS, "LONG_PRESS", detail)
                }
                0x01 -> {
                    return event(BleProtocol.EVENT_CLICK, "TAP", detail)
                }
                0x02 -> {
                    return event(BleProtocol.EVENT_DOUBLE_CLICK, "DOUBLE_TAP", detail)
                }
                0x04 -> {
                    return event(BleProtocol.EVENT_SCROLL_TOP, "SWIPE_UP", detail)
                }
                0x05 -> {
                    return event(BleProtocol.EVENT_SCROLL_BOTTOM, "SWIPE_DOWN", detail)
                }
                0x08 -> {
                    return event(
                        BleProtocol.EVENT_RING_LONG_PRESS_RELEASE,
                        "LONG_PRESS_RELEASE",
                        detail,
                    )
                }
                else -> {
                    return null
                }
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

        private fun chargerCodeName(code: Int): String {
            when (code) {
                0x00 -> {
                    return "LONG_PRESS"
                }
                0x01 -> {
                    return "TAP"
                }
                0x02 -> {
                    return "DOUBLE_TAP"
                }
                0x04 -> {
                    return "SWIPE_UP"
                }
                0x05 -> {
                    return "SWIPE_DOWN"
                }
                0x08 -> {
                    return "LONG_PRESS_RELEASE"
                }
                else -> {
                    return "unknown"
                }
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
