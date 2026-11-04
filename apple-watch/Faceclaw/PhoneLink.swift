import Foundation
import Observation
import WatchConnectivity
import WatchKit
import os

/** A transient message for the UI (ack failures, confirmations). */
struct Notice: Equatable {
    var text: String
    var isError: Bool
    var id: UUID
}

/**
 The watch's end of the WatchConnectivity conversation with the phone: sends
 gestures, commands and text as messages, receives acks and events, and mirrors
 the phone's state. The twin of wear/.../PhoneLink.kt, with these differences:

 - Live messages only work while this app is in front. The iPhone app can't wake
   us, so the phone also leaves its state and latest event in the application
   context, which is delivered whenever we next run.
 - `isReachable` lags a moment behind a wrist raise, which is exactly when a
   gesture arrives, so messages are held briefly instead of failing at once.
 */
@MainActor
@Observable
final class PhoneLink: NSObject {
    private(set) var state: PhoneState?
    private(set) var link = LinkStatus()
    private(set) var assistant = AssistantMirror()
    private(set) var notice: Notice?

    @ObservationIgnored private let log = Logger(subsystem: "com.faceclaw.watch", category: "PhoneLink")
    @ObservationIgnored private var nextSeq: Int64 = 1
    @ObservationIgnored private var pendingAcks: [Int64: Task<Void, Never>] = [:]
    @ObservationIgnored private var held: [Outgoing] = []
    @ObservationIgnored private var heldExpiry: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var batteryTimer: Task<Void, Never>?
    @ObservationIgnored private var lastBatteryReported: WatchBatteryReading?
    @ObservationIgnored private var lastEventAt: Int64 = 0

    private struct Outgoing {
        var path: String
        var json: String
        var seq: Int64
        var quiet: Bool
    }

    private var session: WCSession { WCSession.default }

    /** Activate the session. Called during launch, including a background launch. */
    func start() {
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    // MARK: - App lifecycle

    /** The app came to the front: catch up on everything that happened while suspended. */
    func becameActive() {
        refresh()
        batteryTimer?.cancel()
        // watchOS has no battery-change notification, and the app is only awake to be polled here.
        batteryTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.batteryPollNanos)
                guard !Task.isCancelled else { return }
                self?.reportBattery(force: false)
            }
        }
    }

    func resignedActive() {
        batteryTimer?.cancel()
        batteryTimer = nil
        WatchBattery.scheduleBackgroundRefresh()
    }

    /** Re-read the session, the cached state and ask the phone for a fresh one. */
    func refresh() {
        updateLink()
        guard session.activationState == .activated else { return }
        applyContext(session.receivedApplicationContext)
        if link.phoneAppInstalled {
            requestState()
            reportBattery(force: true)
        }
    }

    /** The system gave us background time: leave the battery level for the phone to find. */
    func reportBatteryFromBackground() async {
        for _ in 0..<50 where session.activationState != .activated {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        reportBattery(force: true)
        WatchBattery.scheduleBackgroundRefresh()
    }

    // MARK: - Outbound

    func sendGesture(_ gesture: RingGesture, steps: Int = 1) {
        send(WirePath.input, ["gesture": gesture.rawValue, "steps": steps])
    }

    /**
     A finger landed: the phone delivers it as the ring's touch-down (ring-press)
     ahead of whatever gesture the touch becomes. Fire-and-forget and silent, since
     the gesture that follows reports any failure; never held, since a late
     touch-down would be worse than none.
     */
    func sendPress() {
        guard let state, state.takesInput, state.screenOn, session.isReachable else { return }
        transmit(path: WirePath.press, json: "{}")
    }

    func sendCommand(_ command: String, extras: [String: String] = [:]) {
        var body: [String: Any] = ["command": command]
        for (key, value) in extras { body[key] = value }
        send(WirePath.command, body)
    }

    func sendAssistantQuery(_ text: String) {
        assistant = AssistantMirror(phase: "thinking", text: "")
        send(WirePath.assistant, ["text": text])
    }

    func sendText(_ text: String) {
        send(WirePath.text, ["text": text])
    }

    func requestState() {
        send(WirePath.stateRequest, [:], quiet: true)
    }

    func clearAssistant() {
        assistant = AssistantMirror()
    }

    private func send(_ path: String, _ body: [String: Any], quiet: Bool = false) {
        let seq = nextSeq
        nextSeq += 1
        var body = body
        body["seq"] = seq
        guard let json = encodeJSON(body) else { return }
        let message = Outgoing(path: path, json: json, seq: seq, quiet: quiet)
        if session.activationState == .activated && session.isReachable {
            transmit(message)
        } else if quiet {
            // Only state requests are quiet, and reachability returning sends a fresh one.
        } else {
            hold(message)
        }
    }

    private func hold(_ message: Outgoing) {
        log.debug("hold \(message.path, privacy: .public) seq=\(message.seq) (not reachable)")
        held.append(message)
        if held.count > Self.heldLimit { held.removeFirst() }
        guard heldExpiry == nil else { return }
        heldExpiry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.holdNanos)
            guard !Task.isCancelled else { return }
            self?.expireHeld()
        }
    }

    private func flushHeld() {
        heldExpiry?.cancel()
        heldExpiry = nil
        let messages = held
        held = []
        messages.forEach(transmit)
    }

    private func expireHeld() {
        heldExpiry = nil
        guard !held.isEmpty else { return }
        held = []
        showNotice(link.phoneAppInstalled ? "The phone is out of range." : "Faceclaw isn't installed on the phone.", isError: true)
    }

    private func transmit(_ message: Outgoing) {
        log.debug("send \(message.path, privacy: .public) seq=\(message.seq)")
        transmit(path: message.path, json: message.json) { [weak self] error in
            self?.sendFailed(message, error)
        }
        // The phone acks every message; silence means its app process never received it.
        pendingAcks[message.seq] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.ackTimeoutNanos)
            guard !Task.isCancelled, let self, self.pendingAcks.removeValue(forKey: message.seq) != nil else { return }
            if self.link.appRunning == nil { self.link.appRunning = false }
            if !message.quiet { self.showNotice("No reply from the phone.", isError: true) }
        }
    }

    private func transmit(path: String, json: String, onError: (@MainActor (Error) -> Void)? = nil) {
        session.sendMessage([WireKey.path: path, WireKey.json: json], replyHandler: nil) { [log] error in
            log.error("send \(path, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            Task { @MainActor in onError?(error) }
        }
    }

    private func sendFailed(_ message: Outgoing, _ error: Error) {
        pendingAcks.removeValue(forKey: message.seq)?.cancel()
        updateLink()
        guard !message.quiet else { return }
        let code = (error as? WCError)?.code
        switch code {
        case .notReachable: showNotice("The phone is out of range.", isError: true)
        case .companionAppNotInstalled: showNotice("Faceclaw isn't installed on the phone.", isError: true)
        default: showNotice("Couldn't reach the phone.", isError: true)
        }
    }

    /** Send our battery to the phone (for the glasses' Watch indicator), live and for later. */
    private func reportBattery(force: Bool) {
        guard session.activationState == .activated else { return }
        let reading = WatchBattery.read()
        if !force && reading == lastBatteryReported { return }
        lastBatteryReported = reading
        guard let json = encodeJSON(reading.payload(at: Date())) else { return }
        if session.isReachable { transmit(path: WirePath.battery, json: json) }
        do {
            try session.updateApplicationContext([WireKey.battery: json])
        } catch {
            log.debug("battery context not sent: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Inbound

    private func handleMessage(path: String, json: String, updatedAt: Int64, at: Int64) {
        switch path {
        case WirePath.ack:
            if let ack = Ack.parse(json) { handleAck(ack) }
        case WirePath.event:
            handleEvent(json: json, at: at, fromContext: false)
        case WirePath.state:
            // A live state comes from the running dashboard, unlike one left in the context.
            applyState(json: json, updatedAt: updatedAt)
            link.appRunning = true
        case WirePath.batteryRequest:
            reportBattery(force: true)
        default:
            break
        }
    }

    private func handleAck(_ ack: Ack) {
        pendingAcks.removeValue(forKey: ack.seq)?.cancel()
        link.appRunning = ack.jsReady
        if !ack.ok {
            showNotice(ack.message.isEmpty ? "The phone refused that." : ack.message, isError: true)
        } else if !ack.message.isEmpty {
            showNotice(ack.message, isError: false)
        }
    }

    private func handleEvent(json: String, at: Int64, fromContext: Bool) {
        guard let event = PhoneEvent.parse(json) else { return }
        // The same event can arrive both live and in the context.
        if at != 0 {
            guard at > lastEventAt else { return }
            lastEventAt = at
        }
        let age = at == 0 ? 0 : Date().timeIntervalSince1970 - Double(at) / 1000
        switch event {
        case let .assistant(phase, text):
            if fromContext && age > Self.assistantEventMaxAge { return }
            assistant = assistant.applying(phase: phase, text: text)
        case let .alert(text):
            if fromContext && age > Self.alertEventMaxAge { return }
            showNotice(text, isError: false)
        }
    }

    private func applyContext(_ context: [String: Any]) {
        if let json = context[WireKey.json] as? String {
            applyState(json: json, updatedAt: (context[WireKey.updatedAt] as? NSNumber)?.int64Value ?? 0)
        }
        if let json = context[WireKey.event] as? String {
            handleEvent(json: json, at: (context[WireKey.eventAt] as? NSNumber)?.int64Value ?? 0, fromContext: true)
        }
    }

    private func applyState(json: String, updatedAt: Int64) {
        // A live message and the context can carry the same or an older state, in either order.
        if let state, updatedAt < state.updatedAt { return }
        if let parsed = PhoneState.parse(json, updatedAt: updatedAt) { state = parsed }
    }

    private func updateLink() {
        // The session logs an error for each property read before activation.
        guard WCSession.isSupported(), session.activationState == .activated else { return }
        link.activated = true
        link.phoneReachable = session.isReachable
        link.phoneAppInstalled = session.isCompanionAppInstalled
        if !link.phoneAppInstalled { link.appRunning = nil }
    }

    private func reachabilityChanged() {
        updateLink()
        log.debug("reachable=\(self.link.phoneReachable)")
        if session.isReachable {
            flushHeld()
            requestState()
            reportBattery(force: true)
        }
    }

    private func activated() {
        updateLink()
        applyContext(session.receivedApplicationContext)
        reachabilityChanged()
    }

    private func showNotice(_ text: String, isError: Bool) {
        noticeTask?.cancel()
        notice = Notice(text: text, isError: isError, id: UUID())
        noticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: isError ? Self.noticeErrorNanos : Self.noticeInfoNanos)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    private static let ackTimeoutNanos: UInt64 = 4_000_000_000
    /** How long a message waits for reachability, e.g. right after a wrist raise. */
    private static let holdNanos: UInt64 = 1_500_000_000
    private static let heldLimit = 8
    private static let batteryPollNanos: UInt64 = 60_000_000_000
    private static let noticeInfoNanos: UInt64 = 1_800_000_000
    private static let noticeErrorNanos: UInt64 = 3_200_000_000
    /** A reply that finished while we slept is still worth showing for this long. */
    private static let assistantEventMaxAge: TimeInterval = 600
    private static let alertEventMaxAge: TimeInterval = 60
}

extension PhoneLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let log = Logger(subsystem: "com.faceclaw.watch", category: "PhoneLink")
        log.info("session activation finished: state \(state.rawValue), error \(error?.localizedDescription ?? "none", privacy: .public)")
        Task { @MainActor in self.activated() }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.reachabilityChanged() }
    }

    nonisolated func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
        Task { @MainActor in self.updateLink() }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let path = message[WireKey.path] as? String else { return }
        let json = message[WireKey.json] as? String ?? "{}"
        let updatedAt = (message[WireKey.updatedAt] as? NSNumber)?.int64Value ?? 0
        let at = (message[WireKey.at] as? NSNumber)?.int64Value ?? 0
        Task { @MainActor in self.handleMessage(path: path, json: json, updatedAt: updatedAt, at: at) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.refreshFromContext() }
    }

    @MainActor private func refreshFromContext() {
        applyContext(session.receivedApplicationContext)
    }
}

private func encodeJSON(_ object: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    return String(data: data, encoding: .utf8)
}
