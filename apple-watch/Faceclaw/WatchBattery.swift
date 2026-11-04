import Foundation
import WatchKit

/** The watch's own charge level and charging state, for the glasses' battery indicators. */
struct WatchBatteryReading: Equatable {
    var battery: Int?
    var charging: Bool

    /** `at` lets the phone discount a report it finds long after it was left in the application context. */
    func payload(at date: Date) -> [String: Any] {
        [
            "battery": battery ?? NSNull(),
            "charging": charging,
            "at": Int64(date.timeIntervalSince1970 * 1000),
        ]
    }
}

enum WatchBattery {
    /** The `.backgroundTask(.appRefresh(...))` identifier. */
    static let refreshIdentifier = "battery"

    private static let refreshInterval: TimeInterval = 30 * 60

    @MainActor
    static func read() -> WatchBatteryReading {
        let device = WKInterfaceDevice.current()
        device.isBatteryMonitoringEnabled = true
        // Unknown (the simulator, or just after enabling monitoring) is not a reading of 0%.
        let level = device.batteryLevel
        let known = device.batteryState != .unknown && level >= 0
        let percent = known ? min(100, Int((level * 100).rounded())) : nil
        return WatchBatteryReading(
            battery: percent,
            charging: device.batteryState == .charging || device.batteryState == .full
        )
    }

    /**
     A closed app can't answer the phone's battery polls, so it asks to be woken
     now and then to leave a report behind. The system decides when, and may
     decline; the phone discards the level once it goes stale.
     */
    @MainActor
    static func scheduleBackgroundRefresh() {
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: Date(timeIntervalSinceNow: refreshInterval),
            userInfo: refreshIdentifier as NSString
        ) { _ in }
    }
}
