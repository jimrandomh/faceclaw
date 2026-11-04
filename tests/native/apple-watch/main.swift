// Exercises the watch app's platform-independent logic on the Mac: the gesture
// state machine, the wire format and the pad's status line.
import Foundation

var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() {
        failures += 1
        print("FAILED line \(line): \(message)")
    }
}

// MARK: - Gestures

final class Harness {
    let recognizer = PadGestureRecognizer()
    var events: [PadEvent] = []
    var time: TimeInterval = 100

    init() { recognizer.onEvent = { [unowned self] in self.events.append($0) } }

    func down(_ point: CGPoint = .zero) { recognizer.touchDown(at: point, time: time) }
    func move(_ point: CGPoint) { recognizer.touchMoved(to: point) }
    func up(_ point: CGPoint = .zero) { recognizer.touchUp(at: point, time: time) }
    func wait(_ seconds: TimeInterval) { time += seconds; recognizer.advance(to: time) }
}

do {
    // A lone tap is only known to be one once the double-tap window closes.
    let h = Harness()
    h.down(); h.up()
    check(h.events == [.press], "a tap waits out the double-tap window: \(h.events)")
    h.wait(0.2)
    check(h.events == [.press], "still inside the window")
    h.wait(0.2)
    check(h.events == [.press, .tap], "tap after the window: \(h.events)")
    check(h.recognizer.deadline == nil, "nothing left to wait for")
}

do {
    let h = Harness()
    h.down(); h.up(); h.wait(0.1); h.down(); h.wait(0.05); h.up()
    check(h.events == [.press, .press, .doubleTap], "double-tap reports both presses: \(h.events)")
    h.wait(1)
    check(h.events.count == 3, "no late tap after a double-tap")
}

do {
    // Hold: reported at the timeout and again on release, however long it lasts.
    let h = Harness()
    h.down(); h.wait(0.39)
    check(h.events == [.press], "not yet a hold")
    h.wait(0.02)
    check(h.events == [.press, .longPressStart], "hold starts at the timeout: \(h.events)")
    h.wait(5); h.up()
    check(h.events == [.press, .longPressStart, .longPressEnd], "hold ends on release: \(h.events)")
}

do {
    // Movement during a hold doesn't turn it into a swipe.
    let h = Harness()
    h.down(); h.wait(0.5); h.move(CGPoint(x: 50, y: 50)); h.up(CGPoint(x: 50, y: 50))
    check(h.events == [.press, .longPressStart, .longPressEnd], "a hold stays a hold: \(h.events)")
}

do {
    let h = Harness()
    h.down(); h.up(); h.wait(0.1); h.down(); h.wait(0.5)
    check(h.events == [.press, .press, .shortThenLongPress], "tap then hold: \(h.events)")
    h.up(); h.wait(1)
    check(h.events.count == 3, "no double-tap or release after tap-then-hold: \(h.events)")
}

do {
    let h = Harness()
    let start = CGPoint(x: 100, y: 180), end = CGPoint(x: 104, y: 60)
    h.down(start); h.move(end); h.wait(1); h.up(end)
    check(h.events == [.press, .swipe(start: start, dx: 4, dy: -120)], "a swipe, never a hold: \(h.events)")
}

do {
    // A small wobble under the slop is still a tap.
    let h = Harness()
    h.down(.zero); h.move(CGPoint(x: 3, y: 3)); h.up(CGPoint(x: 3, y: 3)); h.wait(0.4)
    check(h.events == [.press, .tap], "wobble is a tap: \(h.events)")
}

do {
    // Whatever ends a hold, the phone must hear a release or it sees a stuck long-press.
    let h = Harness()
    h.down(); h.wait(0.5); h.recognizer.cancel()
    check(h.events == [.press, .longPressStart, .longPressEnd], "a cancelled hold is released: \(h.events)")
    check(!h.recognizer.isTouching, "idle after cancel")
}

do {
    let h = Harness()
    h.down(); h.recognizer.cancel(); h.wait(1)
    check(h.events == [.press], "a cancelled touch is not a tap: \(h.events)")
}

do {
    // The wrist dropped after a complete tap: it was still a tap, and there's no touch left to wait for.
    let h = Harness()
    h.down(); h.up(); h.recognizer.cancel()
    check(h.events == [.press, .tap], "a finished tap survives cancel: \(h.events)")
    h.wait(1)
    check(h.events.count == 2, "and isn't reported twice")
}

do {
    // A touch whose end was never seen must not wedge the next one.
    let h = Harness()
    h.down(); h.wait(0.5); h.down()
    check(h.events == [.press, .longPressStart, .longPressEnd, .press], "a lost touch-up is recovered: \(h.events)")
}

// MARK: - Wire format

do {
    let json = """
    {"protocol":1,"version":"0.8.6","phase":"connected","status":"ok","connected":true,"preview":false,
     "screenOn":true,"locked":false,"worn":null,"listening":false,"battery":78,"charging":false,"silentMode":false,
     "caseBattery":64,"caseCharging":null,"foreground":{"appId":"music","title":"Music"},
     "windows":[{"windowId":"w1","title":"Music","appId":"music","focused":true,"closeable":false,"acceptsText":true}],
     "apps":[{"appId":"timer","title":"Timer"}],"remoteEnabled":true,"crownClockwiseNext":true,"canUnlock":false,
     "mirrorAssistant":true,"assistantAvailable":true}
    """
    let state = PhoneState.parse(json, updatedAt: 42)
    check(state != nil, "state parses")
    check(state?.connected == true && state?.takesInput == true, "connected")
    check(state?.battery == 78 && state?.caseBattery == 64, "batteries")
    check(state?.worn == nil && state?.caseCharging == nil, "JSON null stays nil")
    check(state?.foreground == AppEntry(appId: "music", title: "Music"), "foreground")
    check(state?.windows.first?.acceptsText == true && state?.windows.first?.closeable == false, "window flags")
    check(state?.apps.map(\.appId) == ["timer"], "apps")
    check(state?.crownClockwiseNext == true && state?.canUnlock == false, "settings")
    check(state?.updatedAt == 42, "updatedAt")
}

do {
    // A state from an older or newer phone app parses with defaults rather than failing.
    let state = PhoneState.parse("{\"battery\":140,\"unknownField\":[1,2]}", updatedAt: 0)
    check(state?.battery == nil, "out-of-range percentage is unknown")
    check(state?.remoteEnabled == true && state?.canUnlock == true, "permissive defaults")
    check(state?.phase == "disconnected" && state?.takesInput == false, "disconnected default")
    check(PhoneState.parse("not json", updatedAt: 0) == nil, "garbage is rejected")
    check(PhoneState.parse("[1]", updatedAt: 0) == nil, "a non-object is rejected")
}

do {
    let ack = Ack.parse("{\"seq\":7,\"ok\":false,\"jsReady\":false,\"message\":\"nope\"}")
    check(ack == Ack(seq: 7, ok: false, jsReady: false, message: "nope"), "ack: \(String(describing: ack))")
    check(Ack.parse("{\"seq\":7,\"ok\":true}")?.jsReady == true, "jsReady defaults to true")
}

do {
    check(PhoneEvent.parse("{\"type\":\"assistant\",\"phase\":\"done\",\"text\":\"hi\"}") == .assistant(phase: "done", text: "hi"), "assistant event")
    check(PhoneEvent.parse("{\"type\":\"alert\",\"text\":\"x\"}") == .alert(text: "x"), "alert event")
    check(PhoneEvent.parse("{\"type\":\"other\"}") == nil, "unknown event")
}

do {
    var mirror = AssistantMirror()
    mirror = mirror.applying(phase: "thinking", text: "")
    check(mirror == AssistantMirror(phase: "thinking", text: ""), "thinking")
    mirror = mirror.applying(phase: "streaming", text: "Hel")
    mirror = mirror.applying(phase: "done", text: "")
    check(mirror == AssistantMirror(phase: "done", text: "Hel"), "an empty done keeps the streamed text")
    mirror = mirror.applying(phase: "closed", text: "")
    check(mirror == AssistantMirror(phase: "idle", text: "Hel"), "closed keeps the text to read")
    check(mirror.applying(phase: "bogus", text: "x") == mirror, "unknown phases change nothing")
}

// MARK: - Status line

do {
    var up = LinkStatus(activated: true, phoneReachable: true, phoneAppInstalled: true, appRunning: true)
    var state = PhoneState()
    state.connected = true
    state.screenOn = true
    state.foreground = AppEntry(appId: "music", title: "Music")

    check(padLine(state: nil, link: LinkStatus()).text == "Waiting for phone", "before activation")
    check(padLine(state: state, link: LinkStatus(activated: true, phoneAppInstalled: false)).text == "Install Faceclaw on phone", "no phone app")
    check(padLine(state: state, link: LinkStatus(activated: true, phoneAppInstalled: true)).text == "No phone", "unreachable")
    up.appRunning = false
    check(padLine(state: state, link: up).text == "Open Faceclaw on phone", "dashboard not up")
    up.appRunning = true
    check(padLine(state: nil, link: up).text == "Waiting for phone", "no state yet")
    check(padLine(state: state, link: up) == StatusLine(text: "Music", tone: .good), "foreground app")

    state.screenOn = false
    check(padLine(state: state, link: up).text == "●● Wake", "display off")
    state.locked = true
    check(padLine(state: state, link: up).text == "Locked", "locked beats display off")
    state.charging = true
    state.battery = 50
    state.caseBattery = 64
    state.caseCharging = true
    check(padLine(state: state, link: up) == StatusLine(text: "Charging · G2 50%", tone: .busy, detail: "Case 64% ⚡"), "charging")

    var off = PhoneState()
    check(padLine(state: off, link: up).text == "Disconnected", "disconnected")
    off.phase = "retrying"
    check(padLine(state: off, link: up).text == "Reconnecting…", "iOS's retrying phase")
    off.phase = "disconnected"
    off.preview = true
    off.screenOn = true
    check(padLine(state: off, link: up) == StatusLine(text: "Launcher", tone: .good, detail: "Phone preview"), "phone preview")
    off.screenOn = false
    check(padLine(state: off, link: up).text == "●● Wake", "preview display off")
    off.remoteEnabled = false
    check(padLine(state: off, link: up).text == "Watch control off", "remote disabled")
}

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("apple-watch logic: all checks passed")
