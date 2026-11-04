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

/** Watch-local preferences (nothing here is synced to the phone). */
@MainActor
@Observable
final class WatchPrefs {
    /** Buzz on every gesture sent, and tick on crown detents. */
    var haptics: Bool {
        didSet { store.set(haptics, forKey: Keys.haptics) }
    }

    var crownSensitivity: CrownSensitivity {
        didSet { store.set(crownSensitivity.rawValue, forKey: Keys.crown) }
    }

    @ObservationIgnored private let store = UserDefaults.standard

    private enum Keys {
        static let haptics = "haptics"
        static let crown = "crownSensitivity"
    }

    init() {
        haptics = store.object(forKey: Keys.haptics) as? Bool ?? true
        crownSensitivity = store.string(forKey: Keys.crown).flatMap(CrownSensitivity.init(rawValue:)) ?? .normal
    }
}

/** The wrist's confirmation of what was sent. */
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

    /** The phone refused or did not answer; always plays. */
    func error() { WKInterfaceDevice.current().play(.failure) }

    private func play(_ type: WKHapticType) {
        if prefs.haptics { WKInterfaceDevice.current().play(type) }
    }
}
