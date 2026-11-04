import Foundation

/**
 Wire format shared with the phone app. Mirror of app/native/wear-bridge-types.ts
 (paths), app/g2/wear-remote.ts (payloads) and App_Resources/iOS/src/FaceclawWatchBridge.m
 (WatchConnectivity keys); see wear/PROTOCOL.md.
 */
enum WirePath {
    static let input = "/faceclaw/input"
    /** Watch -> phone: a finger landed on the pad, ahead of the gesture it becomes; no seq, never acked. */
    static let press = "/faceclaw/press"
    static let command = "/faceclaw/command"
    static let assistant = "/faceclaw/assistant"
    static let text = "/faceclaw/text"
    static let stateRequest = "/faceclaw/state/request"
    /** Watch -> phone: our own battery ({battery, charging, at}); no seq, never acked. */
    static let battery = "/faceclaw/battery"
    /** Phone -> watch: please send `battery` now. Only reaches an app that's in front. */
    static let batteryRequest = "/faceclaw/battery/request"
    static let ack = "/faceclaw/ack"
    static let event = "/faceclaw/event"
    static let state = "/faceclaw/state"
}

/** Keys of the WatchConnectivity dictionaries that carry those messages. */
enum WireKey {
    static let path = "path"
    static let json = "json"
    static let updatedAt = "updatedAt"
    /** The time a live event was sent, matching `eventAt` when it's also in the context. */
    static let at = "at"
    /** Application context: the latest event a suspended app would otherwise have missed. */
    static let event = "event"
    static let eventAt = "eventAt"
    /** Application context, watch -> phone: the battery report, as JSON. */
    static let battery = "battery"
}

/** Ring-style gestures, as the phone's synthetic ring input understands them. */
enum RingGesture: String {
    case click
    case doubleClick = "double-click"
    case scrollUp = "scroll-up"
    case scrollDown = "scroll-down"
    /** Finger down: the hold lasts until longPressRelease. */
    case longPressStart = "long-press-start"
    case longPressRelease = "long-press-release"
    /** Tap then hold: opens the app's context menu on the glasses. */
    case shortThenLongPress = "short-then-long-press"
    /** The spoken "Hey Even": opens the glasses' own voice dialog. */
    case wakeword
    /**
     Spatial (four-way) input the ring cannot produce. The glasses UI gives it a
     spatial meaning where one exists (grid rows and columns, panel columns,
     tracks) and otherwise treats up/down as scroll, right as select and left as back.
     */
    case swipeUp = "swipe-up"
    case swipeDown = "swipe-down"
    case swipeLeft = "swipe-left"
    case swipeRight = "swipe-right"
}

/** Shell commands; things the ring cannot express. */
enum PhoneCommand {
    static let launchApp = "launch-app"
    static let focusWindow = "focus-window"
    static let closeWindow = "close-window"
    static let wake = "wake"
    static let sleep = "sleep"
    static let lock = "lock"
    static let unlock = "unlock"
    static let connect = "connect"
    static let disconnect = "disconnect"
    static let closeAssistant = "close-assistant"
    static let sidebar = "sidebar"
}

struct AppEntry: Equatable, Identifiable {
    var appId: String
    var title: String
    var id: String { appId }
}

struct WindowEntry: Equatable, Identifiable {
    var windowId: String
    var title: String
    var appId: String
    var focused: Bool
    var closeable: Bool
    var acceptsText: Bool
    var id: String { windowId }
}

/** The phone's mirrored dashboard state (/faceclaw/state). */
struct PhoneState: Equatable {
    var version = ""
    var phase = "disconnected"
    var status = ""
    var connected = false
    /** The shell is running on the phone's preview with no glasses, so gestures still land. */
    var preview = false
    var screenOn = false
    var locked = false
    var worn: Bool?
    var listening = false
    /** Current or last-known G2 charge percentage. */
    var battery: Int?
    var charging = false
    /** Last-known charging-case percentage; live only while the glasses are docked. */
    var caseBattery: Int?
    /** The case is on USB; nil while the glasses are out of the case. */
    var caseCharging: Bool?
    var silentMode = false
    var foreground: AppEntry?
    var windows: [WindowEntry] = []
    var apps: [AppEntry] = []
    var remoteEnabled = true
    /** Settings > Watch on the glasses; WatchPrefs and Haptics say what they do. */
    var vibrateOnInput = true
    var soundEffects = false
    var canUnlock = true
    var mirrorAssistant = true
    var assistantAvailable = false
    var updatedAt: Int64 = 0

    /** Gestures have a display to act on, whether that's the glasses or the phone's preview. */
    var takesInput: Bool { connected || preview }

    static func parse(_ json: String, updatedAt: Int64) -> PhoneState? {
        guard let o = parseObject(json) else { return nil }
        var state = PhoneState()
        state.version = o["version"] as? String ?? ""
        state.phase = o["phase"] as? String ?? "disconnected"
        state.status = o["status"] as? String ?? ""
        state.connected = o["connected"] as? Bool ?? false
        state.preview = o["preview"] as? Bool ?? false
        state.screenOn = o["screenOn"] as? Bool ?? false
        state.locked = o["locked"] as? Bool ?? false
        state.worn = o["worn"] as? Bool
        state.listening = o["listening"] as? Bool ?? false
        state.battery = percent(o["battery"])
        state.charging = o["charging"] as? Bool ?? false
        state.caseBattery = percent(o["caseBattery"])
        state.caseCharging = o["caseCharging"] as? Bool
        state.silentMode = o["silentMode"] as? Bool ?? false
        if let foreground = o["foreground"] as? [String: Any] { state.foreground = appEntry(foreground) }
        state.windows = (o["windows"] as? [[String: Any]] ?? []).map { w in
            WindowEntry(
                windowId: w["windowId"] as? String ?? "",
                title: w["title"] as? String ?? "",
                appId: w["appId"] as? String ?? "",
                focused: w["focused"] as? Bool ?? false,
                closeable: w["closeable"] as? Bool ?? true,
                acceptsText: w["acceptsText"] as? Bool ?? false
            )
        }
        state.apps = (o["apps"] as? [[String: Any]] ?? []).map(appEntry)
        state.remoteEnabled = o["remoteEnabled"] as? Bool ?? true
        state.vibrateOnInput = o["vibrateOnInput"] as? Bool ?? true
        state.soundEffects = o["soundEffects"] as? Bool ?? false
        state.canUnlock = o["canUnlock"] as? Bool ?? true
        state.mirrorAssistant = o["mirrorAssistant"] as? Bool ?? true
        state.assistantAvailable = o["assistantAvailable"] as? Bool ?? false
        state.updatedAt = updatedAt
        return state
    }

    private static func appEntry(_ o: [String: Any]) -> AppEntry {
        AppEntry(appId: o["appId"] as? String ?? "", title: o["title"] as? String ?? "")
    }

    private static func percent(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, (0...100).contains(number.intValue) else { return nil }
        return number.intValue
    }
}

/** The phone's reply to one of our messages. */
struct Ack: Equatable {
    var seq: Int64
    var ok: Bool
    /** False: the phone's app process answered, but its dashboard isn't up. */
    var jsReady: Bool
    var message: String

    static func parse(_ json: String) -> Ack? {
        guard let o = parseObject(json) else { return nil }
        return Ack(
            seq: (o["seq"] as? NSNumber)?.int64Value ?? 0,
            ok: o["ok"] as? Bool ?? false,
            jsReady: o["jsReady"] as? Bool ?? true,
            message: o["message"] as? String ?? ""
        )
    }
}

/** Phone -> watch events (/faceclaw/event). */
enum PhoneEvent: Equatable {
    /** phase: thinking | streaming | done | error | closed; text is the reply so far. */
    case assistant(phase: String, text: String)
    case alert(text: String)

    static func parse(_ json: String) -> PhoneEvent? {
        guard let o = parseObject(json) else { return nil }
        switch o["type"] as? String {
        case "assistant": return .assistant(phase: o["phase"] as? String ?? "", text: o["text"] as? String ?? "")
        case "alert": return .alert(text: o["text"] as? String ?? "")
        default: return nil
        }
    }
}

/** The assistant overlay as mirrored from the glasses. */
struct AssistantMirror: Equatable {
    /** idle | thinking | streaming | done | error */
    var phase = "idle"
    var text = ""

    func applying(phase next: String, text nextText: String) -> AssistantMirror {
        switch next {
        case "thinking": return AssistantMirror(phase: "thinking", text: "")
        case "streaming": return AssistantMirror(phase: "streaming", text: nextText)
        case "done": return AssistantMirror(phase: "done", text: nextText.isEmpty ? text : nextText)
        case "error": return AssistantMirror(phase: "error", text: nextText)
        case "closed": return AssistantMirror(phase: "idle", text: text)
        default: return self
        }
    }
}

private func parseObject(_ json: String) -> [String: Any]? {
    guard let data = json.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}
