import Foundation
import Observation
import SwiftUI
import WatchKit

enum CrownSensitivity: String, CaseIterable {
    case low = "Low"
    case normal = "Normal"
    case high = "High"

    var next: CrownSensitivity {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }

    var digitalCrown: DigitalCrownRotationalSensitivity {
        switch self {
        case .low: return .low
        case .normal: return .medium
        case .high: return .high
        }
    }
}

/**
 Crown sensitivity is the watch's own. Vibration and sound follow Settings > Watch on
 the glasses, through the mirrored state, which the application context keeps for
 when the phone is out of reach.
 */
@MainActor
@Observable
final class WatchPrefs {
    /** Confirm each gesture sent, and tick on crown detents. */
    var haptics: Bool { link.state?.vibrateOnInput ?? true }

    /** Give each gesture its own cue, sound included; see Haptics. */
    var soundEffects: Bool { link.state?.soundEffects ?? false }

    var crownSensitivity: CrownSensitivity {
        didSet { store.set(crownSensitivity.rawValue, forKey: Keys.crown) }
    }

    @ObservationIgnored private let link: PhoneLink
    @ObservationIgnored private let store = UserDefaults.standard

    private enum Keys {
        static let crown = "crownSensitivity"
    }

    init(link: PhoneLink) {
        self.link = link
        crownSensitivity = store.string(forKey: Keys.crown).flatMap(CrownSensitivity.init(rawValue:)) ?? .normal
    }
}

/**
 The wrist's confirmation of what was sent. watchOS has no call that plays only a
 vibration or only a sound: every WKHapticType is both, and only the watch's own Silent
 Mode mutes the sound. So sound effects on means the full set of cues, which vibrate
 whatever the vibrate setting says, and off means `.click` for everything. Whether
 `.click` is truly silent is unconfirmed; see notes/apple-watch-followups.md.
 */
@MainActor
struct Haptics {
    let prefs: WatchPrefs

    /** A sent click, swipe or command. */
    func click() { play(.click) }
    /** A sent double-click: back. */
    func doubleClick() { play(.directionDown) }
    /** The start of a hold. */
    func heavy() { play(.start) }
    /** A reply finished arriving. */
    func done() { play(.success) }

    /** The phone refused or did not answer; always plays, and never feels like a sent gesture. */
    func error() {
        let device = WKInterfaceDevice.current()
        if prefs.soundEffects {
            device.play(.failure)
            return
        }
        device.play(.click)
        Task {
            try? await Task.sleep(nanoseconds: Self.errorTapGapNanos)
            device.play(.click)
        }
    }

    private func play(_ cue: WKHapticType) {
        if prefs.soundEffects {
            WKInterfaceDevice.current().play(cue)
        } else if prefs.haptics {
            WKInterfaceDevice.current().play(.click)
        }
    }

    /** Apple's documentation asks for at least 100 ms between haptics. */
    private static let errorTapGapNanos: UInt64 = 150_000_000
}
