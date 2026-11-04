import CoreGraphics
import Foundation
import Observation
import os

/**
 What the pad's touches and crown turns mean: the watch-side half of the remote,
 the twin of the callbacks in wear/.../RemoteScreen.kt.
 */
@MainActor
@Observable
final class PadController {
    /** The action buttons, hidden until a swipe up from the bottom edge. */
    var controlsVisible = false

    @ObservationIgnored private let log = Logger(subsystem: "com.faceclaw.watch", category: "Pad")
    @ObservationIgnored private let link: PhoneLink
    @ObservationIgnored private let haptics: Haptics
    @ObservationIgnored private let recognizer = PadGestureRecognizer()
    @ObservationIgnored private var deadlineTask: Task<Void, Never>?
    @ObservationIgnored private var longPressSent = false
    @ObservationIgnored private var touchStartedAt: Date?
    @ObservationIgnored private var crownRemainder = 0.0
    /** Pad height in points, for the edge-reveal zone. */
    @ObservationIgnored var padHeight: CGFloat = 200

    init(link: PhoneLink, prefs: WatchPrefs) {
        self.link = link
        self.haptics = Haptics(prefs: prefs)
        recognizer.onEvent = { [weak self] event in self?.handle(event) }
    }

    // MARK: - Touch input

    func touchChanged(start: CGPoint, location: CGPoint, time: Date) {
        if !recognizer.isTouching {
            touchStartedAt = time
            recognizer.touchDown(at: start, time: now())
        }
        recognizer.touchMoved(to: location)
        syncDeadline()
    }

    func touchEnded(location: CGPoint) {
        recognizer.touchUp(at: location, time: now())
        syncDeadline()
    }

    /** The touch ended without a touch-up: the system took it, or the wrist dropped. */
    func touchCancelled() {
        recognizer.cancel()
        syncDeadline()
    }

    /**
     SwiftUI says a touch is over. If it's the current one and it hasn't ended, no
     touch-up is coming, and a hold still has to be released on the phone.
     */
    func touchWentAway(startedAt: Date) {
        if recognizer.isTouching && startedAt == touchStartedAt { touchCancelled() }
    }

    private func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func syncDeadline() {
        deadlineTask?.cancel()
        deadlineTask = nil
        guard let deadline = recognizer.deadline else { return }
        let delay = max(0, deadline - now())
        deadlineTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.recognizer.advance(to: self.now())
            self.syncDeadline()
        }
    }

    // MARK: - What gestures mean

    private var glassesScreenIsOff: Bool {
        guard let state = link.state else { return false }
        return state.takesInput && !state.screenOn
    }

    /**
     A dark display still takes a double-click (wake), and a tap or a hold (the
     phone's Glanceboard). Scrolls, swipes and the menu gesture mean nothing there,
     so they're dropped here without a buzz.
     */
    private func gestureAllowed(_ gesture: RingGesture) -> Bool {
        guard glassesScreenIsOff else { return true }
        switch gesture {
        case .doubleClick, .click, .longPressStart, .longPressRelease: return true
        default: return false
        }
    }

    private func handle(_ event: PadEvent) {
        log.debug("pad \(String(describing: event), privacy: .public)")
        switch event {
        case .press:
            link.sendPress()
        case .tap:
            click()
        case .doubleTap:
            haptics.doubleClick()
            link.sendGesture(.doubleClick)
        case .shortThenLongPress:
            guard !glassesScreenIsOff else { return }
            haptics.heavy()
            link.sendGesture(.shortThenLongPress)
        case .longPressStart:
            longPressSent = gestureAllowed(.longPressStart)
            if longPressSent {
                haptics.heavy()
                link.sendGesture(.longPressStart)
            }
        case .longPressEnd:
            if longPressSent {
                longPressSent = false
                haptics.click()
                link.sendGesture(.longPressRelease)
            }
        case let .swipe(start, dx, dy):
            swipe(start: start, dx: dx, dy: dy)
        }
    }

    /** The system's double-tap hand gesture lands here too. */
    func click() {
        guard gestureAllowed(.click) else { return }
        haptics.click()
        link.sendGesture(.click)
    }

    private func swipe(start: CGPoint, dx: CGFloat, dy: CGFloat) {
        let vertical = abs(dy) >= abs(dx)
        if vertical && !controlsVisible && dy < 0 && start.y >= padHeight - Self.edgeRevealZone {
            controlsVisible = true
            haptics.click()
        } else if vertical && controlsVisible && dy > 0 && start.y >= padHeight - Self.buttonTrayHeight {
            controlsVisible = false
            haptics.click()
        } else if vertical {
            // One step per swipe, regardless of length: the glasses repaint per
            // step, and multi-step swipes overshoot lists when the display lags
            // the finger. Repeated flicks or the crown cover long distances.
            send(dy < 0 ? .swipeUp : .swipeDown, steps: 1)
        } else {
            send(dx < 0 ? .swipeLeft : .swipeRight, steps: 1)
        }
    }

    private func send(_ gesture: RingGesture, steps: Int) {
        guard gestureAllowed(gesture) else { return }
        haptics.click()
        link.sendGesture(gesture, steps: steps)
    }

    func dismissControls() {
        guard controlsVisible else { return }
        controlsVisible = false
        haptics.click()
    }

    // MARK: - Crown

    /** A crown turn, in detents; positive is clockwise seen from the crown's end. */
    func crownTurned(by delta: Double) {
        crownRemainder += delta
        let steps = Int(crownRemainder.rounded(.towardZero))
        guard steps != 0 else { return }
        crownRemainder -= Double(steps)
        let clockwiseNext = link.state?.crownClockwiseNext == true
        let gesture: RingGesture = (steps > 0) == clockwiseNext ? .scrollDown : .scrollUp
        guard gestureAllowed(gesture) else { return }
        // Capped low: a fast twirl otherwise outruns the display. The crown's
        // own detent haptics are the feedback, so there's no buzz here.
        link.sendGesture(gesture, steps: min(abs(steps), Self.maxCrownSteps))
    }

    static let edgeRevealZone: CGFloat = 28
    static let buttonTrayHeight: CGFloat = 56
    private static let maxCrownSteps = 2
}
