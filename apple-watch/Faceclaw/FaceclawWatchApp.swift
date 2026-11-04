import SwiftUI

@main
struct FaceclawWatchApp: App {
    private let link: PhoneLink
    private let prefs: WatchPrefs

    init() {
        link = PhoneLink()
        prefs = WatchPrefs()
        // Here rather than in a view: a background launch never builds one.
        link.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(link)
                .environment(prefs)
        }
        .backgroundTask(.appRefresh(WatchBattery.refreshIdentifier)) { [link] in
            await link.reportBatteryFromBackground()
        }
    }
}

enum Destination: Hashable {
    case assistant, apps, status, settings
}

private struct RootView: View {
    @Environment(PhoneLink.self) private var link
    @Environment(WatchPrefs.self) private var prefs
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Destination] = []

    var body: some View {
        NavigationStack(path: $path) {
            RemoteScreen(link: link, prefs: prefs, open: { path.append($0) })
                .navigationDestination(for: Destination.self) { destination in
                    switch destination {
                    case .assistant: AssistantScreen()
                    case .apps: AppsScreen()
                    case .status: StatusScreen(openSettings: { path.append(.settings) })
                    case .settings: SettingsScreen()
                    }
                }
        }
        .overlay(alignment: .bottom) { NoticeOverlay(notice: link.notice) }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active { link.becameActive() } else { link.resignedActive() }
        }
        // A refused or unanswered gesture gets a distinct buzz, so the wrist
        // knows without looking; the notice pill says why.
        .onChange(of: link.notice?.id) { _, _ in
            if link.notice?.isError == true { Haptics(prefs: prefs).error() }
        }
    }
}
