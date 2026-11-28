package dev.lumen.band

import org.json.JSONObject

enum class Phase { STOPPED, SEARCHING, CONNECTING, CONNECTED }

interface GestureDevice {
    /** All callbacks run on Android's main thread. */
    interface Listener {
        fun onPhase(phase: Phase, band: String?)
        fun onStatus(status: JSONObject)
        fun onActions(actions: List<String>)
        /** Four values per record: kind, timestamp, x or button mask, y. */
        fun onPointer(records: DoubleArray) = Unit
        /** The band's state or cumulative handwritten text. Keep the text out of logs. */
        fun onHandwriting(event: JSONObject) = Unit
        /** A fixed connection milestone with an optional bounded numeric status. */
        fun onLog(line: String)
    }

    fun start()
    fun stop()
    fun setPaused(paused: Boolean)
    fun setMapping(mapping: String)
}
