import CoreGraphics
import Foundation

/** What the remote's touch surface can report. */
enum PadEvent: Equatable {
    /** A finger landed (the second tap of a pair included), before it's known what the touch will become. */
    case press
    case tap
    case doubleTap
    /** A tap whose immediate second press was held: the G2 tap-then-hold gesture. */
    case shortThenLongPress
    case longPressStart
    case longPressEnd
    /** The finger travelled past touch slop; dx/dy are the total displacement. */
    case swipe(start: CGPoint, dx: CGFloat, dy: CGFloat)
}

/**
 One detector for everything the pad does, so a gesture is reported exactly
 once: tap, double-tap (a second tap inside the double-tap timeout), a hold
 (reported at the long-press timeout and again on release), tap-then-hold (a
 second tap held past the long-press timeout) and a swipe. The same state
 machine as wear/.../TouchpadGestures.kt, without its two-finger gestures:
 SwiftUI on watchOS only ever sees one finger.

 It has no clock of its own. The owner passes the time with each event and calls
 `advance(to:)` once `deadline` passes, which is what makes it testable.
 Every longPressStart is paired with a longPressEnd, whatever ends the touch:
 the phone treats a start without a release as a hold still in progress.
 */
final class PadGestureRecognizer {
    struct Timing {
        var longPress: TimeInterval = 0.4
        var doubleTap: TimeInterval = 0.3
        var slop: CGFloat = 8
    }

    private enum Phase {
        case idle
        case firstTouch(start: CGPoint, moved: Bool)
        case holding
        case awaitingSecondTouch
        case secondTouch(held: Bool)
    }

    private var phase = Phase.idle
    private let timing: Timing

    /** When `advance(to:)` next has something to do; nil when only a touch event can move things on. */
    private(set) var deadline: TimeInterval?
    var onEvent: (PadEvent) -> Void = { _ in }

    init(timing: Timing = Timing()) {
        self.timing = timing
    }

    /** A finger is on the pad, as far as this recognizer knows. */
    var isTouching: Bool {
        switch phase {
        case .firstTouch, .holding, .secondTouch: return true
        case .idle, .awaitingSecondTouch: return false
        }
    }

    func touchDown(at location: CGPoint, time: TimeInterval) {
        if isTouching { cancel() }
        onEvent(.press)
        if case .awaitingSecondTouch = phase {
            phase = .secondTouch(held: false)
        } else {
            phase = .firstTouch(start: location, moved: false)
        }
        deadline = time + timing.longPress
    }

    func touchMoved(to location: CGPoint) {
        guard case let .firstTouch(start, moved) = phase, !moved else { return }
        if hypot(location.x - start.x, location.y - start.y) > timing.slop {
            phase = .firstTouch(start: start, moved: true)
            deadline = nil
        }
    }

    func touchUp(at location: CGPoint, time: TimeInterval) {
        switch phase {
        case let .firstTouch(start, moved):
            if moved {
                reset()
                onEvent(.swipe(start: start, dx: location.x - start.x, dy: location.y - start.y))
            } else {
                // A plain tap; give a second tap a chance to make it a double.
                phase = .awaitingSecondTouch
                deadline = time + timing.doubleTap
            }
        case .holding:
            reset()
            onEvent(.longPressEnd)
        case let .secondTouch(held):
            reset()
            if !held { onEvent(.doubleTap) }
        case .idle, .awaitingSecondTouch:
            break
        }
    }

    func advance(to time: TimeInterval) {
        guard let deadline, time >= deadline else { return }
        self.deadline = nil
        switch phase {
        case .firstTouch:
            phase = .holding
            onEvent(.longPressStart)
        case .secondTouch:
            phase = .secondTouch(held: true)
            onEvent(.shortThenLongPress)
        case .awaitingSecondTouch:
            reset()
            onEvent(.tap)
        case .idle, .holding:
            break
        }
    }

    /**
     The touch is over but no touch-up will come: the system took the gesture or
     the wrist dropped. A touch in progress is dropped rather than mistaken for a
     tap; a tap already completed and a hold already reported are both honoured.
     */
    func cancel() {
        let cancelled = phase
        reset()
        switch cancelled {
        case .holding: onEvent(.longPressEnd)
        case .awaitingSecondTouch: onEvent(.tap)
        case .idle, .firstTouch, .secondTouch: break
        }
    }

    private func reset() {
        phase = .idle
        deadline = nil
    }
}
