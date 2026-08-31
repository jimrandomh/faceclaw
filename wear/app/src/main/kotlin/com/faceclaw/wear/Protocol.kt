package com.faceclaw.wear

import org.json.JSONObject

/**
 * Wire format shared with the phone app. Mirror of app/native/wear-bridge.ts
 * (paths) and app/g2/wear-remote.ts (payloads); see ../../PROTOCOL.md.
 */
object Protocol {
    /** Advertised by the phone app so the watch can find it. */
    const val CAPABILITY_PHONE = "faceclaw_phone"

    const val PATH_INPUT = "/faceclaw/input"
    const val PATH_COMMAND = "/faceclaw/command"
    const val PATH_ASSISTANT = "/faceclaw/assistant"
    const val PATH_TEXT = "/faceclaw/text"
    const val PATH_STATE_REQUEST = "/faceclaw/state/request"
    const val PATH_ACK = "/faceclaw/ack"
    const val PATH_EVENT = "/faceclaw/event"
    const val PATH_STATE = "/faceclaw/state"

    const val STATE_KEY_JSON = "json"
    const val STATE_KEY_UPDATED_AT = "updatedAt"
}

/** Ring-style gestures, as the phone's synthetic ring input understands them. */
enum class Gesture(val wire: String) {
    CLICK("click"),
    DOUBLE_CLICK("double-click"),
    SCROLL_UP("scroll-up"),
    SCROLL_DOWN("scroll-down"),
    /** A complete short hold (press + release). */
    LONG_PRESS("long-press"),
    /** Finger down: the hold lasts until LONG_PRESS_RELEASE. */
    LONG_PRESS_START("long-press-start"),
    LONG_PRESS_RELEASE("long-press-release"),
    /** The spoken "Hey Even": opens the glasses' own voice dialog. */
    WAKEWORD("wakeword"),
    /**
     * Spatial (four-way) input the ring cannot produce. The glasses UI gives
     * it a spatial meaning where one exists (grid rows and columns, panel
     * columns, tracks) and otherwise treats up/down as scroll, right as select
     * and left as back.
     */
    SWIPE_UP("swipe-up"),
    SWIPE_DOWN("swipe-down"),
    SWIPE_LEFT("swipe-left"),
    SWIPE_RIGHT("swipe-right"),
}

/** Shell commands; things the ring cannot express. */
object Command {
    const val LAUNCH_APP = "launch-app"
    const val FOCUS_WINDOW = "focus-window"
    const val CLOSE_WINDOW = "close-window"
    const val SIDEBAR = "sidebar"
    const val WAKE = "wake"
    const val SLEEP = "sleep"
    const val LOCK = "lock"
    const val UNLOCK = "unlock"
    const val CONNECT = "connect"
    const val DISCONNECT = "disconnect"
    const val CLOSE_ASSISTANT = "close-assistant"
    const val DISPLAY_MODE = "display-mode"
}

/** The glasses' display modes, mirroring the phone's Display > Display mode. */
enum class DisplayMode(val wire: String, val label: String) {
    BAND("576x288", "Band · 576×288"),
    TALL("576x480", "Tall · 576×480"),
    FULL("640x480", "Full panel · 640×480");

    fun next(): DisplayMode = entries[(ordinal + 1) % entries.size]

    companion object {
        fun fromWire(value: String): DisplayMode? = entries.firstOrNull { it.wire == value }
    }
}

data class AppEntry(val appId: String, val title: String)

data class WindowEntry(
    val windowId: String,
    val title: String,
    val appId: String,
    val focused: Boolean,
    val closeable: Boolean,
    val acceptsText: Boolean,
)

/** The phone's mirrored dashboard state (Data Layer item /faceclaw/state). */
data class PhoneState(
    val version: String,
    val phase: String,
    val status: String,
    val connected: Boolean,
    val screenOn: Boolean,
    val locked: Boolean,
    val worn: Boolean?,
    val listening: Boolean,
    /** Display mode wire value ("576x288" | "576x480" | "640x480"). */
    val displayMode: String,
    /** Current or last-known G2 charge percentage. */
    val battery: Int?,
    val charging: Boolean,
    val silentMode: Boolean,
    val foreground: AppEntry?,
    val windows: List<WindowEntry>,
    val apps: List<AppEntry>,
    val remoteEnabled: Boolean,
    /** False by default: clockwise moves to the previous item. */
    val crownClockwiseNext: Boolean,
    val canUnlock: Boolean,
    val mirrorAssistant: Boolean,
    val assistantAvailable: Boolean,
    val updatedAt: Long,
) {
    companion object {
        fun parse(json: String, updatedAt: Long): PhoneState? {
            return try {
                val o = JSONObject(json)
                val foreground = o.optJSONObject("foreground")
                PhoneState(
                    version = o.optString("version", ""),
                    phase = o.optString("phase", "disconnected"),
                    status = o.optString("status", ""),
                    connected = o.optBoolean("connected", false),
                    screenOn = o.optBoolean("screenOn", false),
                    locked = o.optBoolean("locked", false),
                    worn = if (o.isNull("worn")) null else o.optBoolean("worn"),
                    listening = o.optBoolean("listening", false),
                    displayMode = o.optString("displayMode", "576x288"),
                    battery = if (o.isNull("battery")) null else o.optInt("battery", -1).takeIf { it in 0..100 },
                    charging = o.optBoolean("charging", false),
                    silentMode = o.optBoolean("silentMode", false),
                    foreground = foreground?.let {
                        AppEntry(it.optString("appId", ""), it.optString("title", ""))
                    },
                    windows = o.optJSONArray("windows")?.let { array ->
                        (0 until array.length()).mapNotNull { index ->
                            val w = array.optJSONObject(index) ?: return@mapNotNull null
                            WindowEntry(
                                windowId = w.optString("windowId", ""),
                                title = w.optString("title", ""),
                                appId = w.optString("appId", ""),
                                focused = w.optBoolean("focused", false),
                                closeable = w.optBoolean("closeable", true),
                                acceptsText = w.optBoolean("acceptsText", false),
                            )
                        }
                    } ?: emptyList(),
                    apps = o.optJSONArray("apps")?.let { array ->
                        (0 until array.length()).mapNotNull { index ->
                            val a = array.optJSONObject(index) ?: return@mapNotNull null
                            AppEntry(a.optString("appId", ""), a.optString("title", ""))
                        }
                    } ?: emptyList(),
                    remoteEnabled = o.optBoolean("remoteEnabled", true),
                    crownClockwiseNext = o.optBoolean("crownClockwiseNext", false),
                    canUnlock = o.optBoolean("canUnlock", true),
                    mirrorAssistant = o.optBoolean("mirrorAssistant", true),
                    assistantAvailable = o.optBoolean("assistantAvailable", false),
                    updatedAt = updatedAt,
                )
            } catch (error: Exception) {
                null
            }
        }
    }
}

/** The phone's reply to one of our messages. */
data class Ack(val seq: Long, val ok: Boolean, val jsReady: Boolean, val message: String) {
    companion object {
        fun parse(json: String): Ack? = try {
            val o = JSONObject(json)
            Ack(
                seq = o.optLong("seq", 0),
                ok = o.optBoolean("ok", false),
                jsReady = o.optBoolean("jsReady", true),
                message = o.optString("message", ""),
            )
        } catch (error: Exception) {
            null
        }
    }
}

/** Phone -> watch events (/faceclaw/event). */
sealed class PhoneEvent {
    /** phase: thinking | streaming | done | error | closed; text is the reply so far. */
    data class Assistant(val phase: String, val text: String) : PhoneEvent()
    data class Alert(val text: String) : PhoneEvent()

    companion object {
        fun parse(json: String): PhoneEvent? = try {
            val o = JSONObject(json)
            when (o.optString("type")) {
                "assistant" -> Assistant(o.optString("phase", ""), o.optString("text", ""))
                "alert" -> Alert(o.optString("text", ""))
                else -> null
            }
        } catch (error: Exception) {
            null
        }
    }
}
