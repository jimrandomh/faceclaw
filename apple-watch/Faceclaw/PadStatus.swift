import Foundation

/** What we know about the phone and the Faceclaw app on it. */
struct LinkStatus: Equatable {
    /** The WatchConnectivity session is up; until then nothing below is known. */
    var activated = false
    /** The iPhone can be messaged right now. */
    var phoneReachable = false
    /** That iPhone has Faceclaw installed. */
    var phoneAppInstalled = false
    /**
     Whether the phone app's dashboard (the JS side) answered our last message;
     nil until we have heard anything. False means Faceclaw is installed but its
     dashboard isn't running, so the user has to open it.
     */
    var appRunning: Bool?
}

enum StatusTone { case good, busy, off, problem }

/**
 The pad's indicator line, with a tone that picks its colour, and an optional
 smaller line under it (the charging case's level while charging).
 */
struct StatusLine: Equatable {
    var text: String
    var tone: StatusTone
    var detail: String?
}

/**
 The pad's indicator: what the next gesture lands on when everything is
 connected (the foreground app, or the screen/lock state in the way of it),
 otherwise the connection problem to fix first.
 */
func padLine(state: PhoneState?, link: LinkStatus) -> StatusLine {
    guard link.activated else { return StatusLine(text: "Waiting for phone", tone: .busy) }
    guard link.phoneAppInstalled else { return StatusLine(text: "Install Faceclaw on phone", tone: .problem) }
    guard link.phoneReachable else { return StatusLine(text: "No phone", tone: .problem) }
    if link.appRunning == false { return StatusLine(text: "Open Faceclaw on phone", tone: .problem) }
    guard let state else { return StatusLine(text: "Waiting for phone", tone: .busy) }
    if !state.remoteEnabled { return StatusLine(text: "Watch control off", tone: .problem) }
    if state.connected {
        if state.charging || state.phase == "charging" {
            return StatusLine(text: chargingLine(state), tone: .busy, detail: caseLine(state))
        }
        if state.silentMode { return StatusLine(text: "Silent mode", tone: .off) }
        if state.locked { return StatusLine(text: "Locked", tone: .off) }
        if !state.screenOn { return StatusLine(text: "●● Wake", tone: .off) }
        if state.listening { return StatusLine(text: "Listening…", tone: .busy) }
        return StatusLine(text: state.foreground?.title ?? "Launcher", tone: .good)
    }
    switch state.phase {
    case "connecting": return StatusLine(text: "Connecting…", tone: .busy)
    case "retrying": return StatusLine(text: "Reconnecting…", tone: .busy)
    case "disconnecting": return StatusLine(text: "Disconnecting…", tone: .busy)
    default: break
    }
    if state.preview {
        if state.locked { return StatusLine(text: "Locked", tone: .off) }
        if !state.screenOn { return StatusLine(text: "●● Wake", tone: .off) }
        return StatusLine(text: state.foreground?.title ?? "Launcher", tone: .good, detail: "Phone preview")
    }
    return StatusLine(text: "Disconnected", tone: .off)
}

private func chargingLine(_ state: PhoneState) -> String {
    state.battery.map { "Charging: \(state.glassesModel) \($0)%" } ?? "Charging"
}

/**
 "Case 64%", with ⚡ while the case is on USB; nil when the level is unknown. The
 case only reports while the glasses are docked, so this is only drawn while they charge.
 */
private func caseLine(_ state: PhoneState) -> String? {
    state.caseBattery.map { "Case \($0)%" + (state.caseCharging == true ? " ⚡" : "") }
}
