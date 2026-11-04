import SwiftUI

extension StatusTone {
    var color: Color {
        switch self {
        case .good: return Color(red: 0.48, green: 0.85, blue: 0.56)
        case .busy: return Color(red: 0.95, green: 0.76, blue: 0.31)
        case .off: return Color(white: 0.54)
        case .problem: return Color(red: 1.0, green: 0.54, blue: 0.5)
        }
    }
}

/** A transient pill at the bottom of the screen: ack failures and confirmations. */
struct NoticeOverlay: View {
    let notice: Notice?

    var body: some View {
        Group {
            if let notice {
                Text(notice.text)
                    .font(.caption2)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .foregroundStyle(notice.isError ? Color(red: 1, green: 0.71, blue: 0.66) : .white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(notice.isError ? Color(red: 0.29, green: 0.12, blue: 0.1) : Color(white: 0.16))
                    )
                    .padding(.horizontal, 8)
                    .padding(.bottom, 4)
                    .transition(.opacity)
                    .accessibilityIdentifier("notice")
            }
        }
        .animation(.easeOut(duration: 0.15), value: notice?.id)
        .allowsHitTesting(false)
    }
}

/** A list row: a title with an optional smaller line beneath it. */
private struct RowLabel: View {
    let title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).lineLimit(1)
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
            .padding(.leading, 4)
    }
}

// MARK: - Apps

/**
 The glasses' sidebar and launcher, on the wrist: open windows first (tap to bring
 one to the front, × to close it), then every launchable app.
 */
struct AppsScreen: View {
    @Environment(PhoneLink.self) private var link
    @Environment(WatchPrefs.self) private var prefs
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let windows = link.state?.windows ?? []
        let apps = link.state?.apps ?? []
        let onScreen = windows.filter(\.focused)
        let others = windows.filter { !$0.focused }
        ScrollView {
            LazyVStack(spacing: 4) {
                if !onScreen.isEmpty {
                    SectionHeader("On screen")
                    ForEach(onScreen) { windowRow($0) }
                }
                if !others.isEmpty {
                    SectionHeader("Also open")
                    ForEach(others) { windowRow($0) }
                }
                SectionHeader(apps.isEmpty ? "No app list yet" : "Launch")
                ForEach(apps) { app in
                    Button {
                        Haptics(prefs: prefs).click()
                        link.sendCommand(PhoneCommand.launchApp, extras: ["appId": app.appId])
                        dismiss()
                    } label: {
                        RowLabel(title: app.title)
                    }
                    .accessibilityIdentifier("app:\(app.appId)")
                }
                if apps.isEmpty {
                    Text("Open Faceclaw on the phone and connect the glasses.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .navigationTitle("Apps")
    }

    /** One open window: tap to bring it to the front, × to close it. */
    private func windowRow(_ window: WindowEntry) -> some View {
        HStack(spacing: 4) {
            Button {
                Haptics(prefs: prefs).click()
                link.sendCommand(PhoneCommand.focusWindow, extras: ["windowId": window.windowId])
                dismiss()
            } label: {
                // The launcher's window is titled "Apps" on the glasses; here
                // that would read as this very screen.
                RowLabel(
                    title: window.appId == "launcher" ? "Launcher" : window.title,
                    detail: window.acceptsText ? "takes typed text" : nil
                )
            }
            .tint(window.focused ? StatusTone.good.color : nil)
            if window.closeable {
                Button {
                    Haptics(prefs: prefs).click()
                    link.sendCommand(PhoneCommand.closeWindow, extras: ["windowId": window.windowId])
                } label: {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                }
                .frame(width: 40)
                .accessibilityLabel("Close \(window.title)")
            }
        }
    }
}

// MARK: - Assistant

/**
 Ask the assistant from the wrist (the system text sheet, which offers dictation)
 and read its reply here as it streams, mirrored from the glasses overlay. "Hey
 Even" instead uses the glasses' own microphone and voice dialog.
 */
struct AssistantScreen: View {
    @Environment(PhoneLink.self) private var link
    @Environment(WatchPrefs.self) private var prefs

    var body: some View {
        let available = link.state?.assistantAvailable != false
        let mirror = link.assistant
        let haptics = Haptics(prefs: prefs)
        ScrollView {
            VStack(spacing: 6) {
                TextFieldLink(prompt: Text("Ask the assistant")) {
                    Label("Ask", systemImage: "mic.fill").frame(maxWidth: .infinity)
                } onSubmit: { text in
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    haptics.click()
                    link.sendAssistantQuery(trimmed)
                }
                .disabled(!available)
                .accessibilityIdentifier("assistantAsk")

                Text(phaseLabel(mirror.phase, available: available))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("assistantPhase")

                if !mirror.text.isEmpty {
                    Text(mirror.text)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }

                Button {
                    haptics.click()
                    link.sendGesture(.wakeword)
                } label: {
                    RowLabel(title: "“Hey Even”", detail: "uses the glasses mic")
                }

                if mirror.phase != "idle" {
                    Button(mirror.phase == "thinking" || mirror.phase == "streaming" ? "Cancel" : "Dismiss") {
                        haptics.click()
                        link.sendCommand(PhoneCommand.closeAssistant)
                        link.clearAssistant()
                    }
                }
            }
        }
        .navigationTitle("Assistant")
        // A finished reply deserves a nudge: the wrist may be down while it streams.
        .onChange(of: mirror.phase) { _, phase in
            if phase == "done" || phase == "error" { haptics.done() }
        }
    }

    private func phaseLabel(_ phase: String, available: Bool) -> String {
        switch phase {
        case "thinking": return "Thinking…"
        case "streaming": return "Replying…"
        case "error": return "Error"
        case "done": return "Reply"
        default: return available ? "Ask something" : "Set up the assistant in Faceclaw's Settings"
        }
    }
}

// MARK: - Status

/** Glasses and phone status, with the connection / display / lock switches. */
struct StatusScreen: View {
    @Environment(PhoneLink.self) private var link
    @Environment(WatchPrefs.self) private var prefs
    let openSettings: () -> Void

    var body: some View {
        let state = link.state
        let connected = state?.connected == true
        let takesInput = state?.takesInput == true
        let haptics = Haptics(prefs: prefs)
        ScrollView {
            VStack(spacing: 4) {
                SectionHeader("Glasses")
                Button {
                    haptics.click()
                    link.sendCommand(connected ? PhoneCommand.disconnect : PhoneCommand.connect)
                } label: {
                    RowLabel(title: connectionLabel(state), detail: connected ? "tap to disconnect" : "tap to connect")
                }
                .tint(connected ? StatusTone.good.color : nil)
                .disabled(link.link.appRunning == false)

                let screenOn = state?.screenOn == true
                Button {
                    haptics.click()
                    link.sendCommand(screenOn ? PhoneCommand.sleep : PhoneCommand.wake)
                } label: {
                    RowLabel(title: screenOn ? "Display on" : "Display off", detail: screenOn ? "tap to turn off" : "tap to wake")
                }
                .disabled(!takesInput || state?.locked == true)

                let locked = state?.locked == true
                Button {
                    haptics.click()
                    link.sendCommand(locked ? PhoneCommand.unlock : PhoneCommand.lock)
                } label: {
                    RowLabel(title: locked ? "Locked" : "Unlocked", detail: lockDetail(locked: locked, state: state))
                }
                .disabled(!takesInput || (locked && state?.canUnlock == false))

                if let foreground = state?.foreground {
                    Button {
                        haptics.click()
                        link.sendCommand(PhoneCommand.sidebar)
                    } label: {
                        RowLabel(title: "On screen: \(foreground.title)", detail: "tap to open the sidebar")
                    }
                    .disabled(!takesInput)
                }

                SectionHeader("Phone")
                Button {
                    haptics.click()
                    link.refresh()
                } label: {
                    Label {
                        RowLabel(title: phoneLabel, detail: phoneDetail(state))
                    } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                }

                if state?.remoteEnabled == false {
                    Text("Watch control is turned off in Faceclaw's Settings > Watch.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                Button(action: openSettings) {
                    Label("Watch settings", systemImage: "gearshape").frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .navigationTitle("Status")
    }

    private func connectionLabel(_ state: PhoneState?) -> String {
        guard let state else { return "No status yet" }
        if state.charging || state.phase == "charging" { return "Charging" }
        if state.connected { return "Connected" }
        switch state.phase {
        case "connecting": return "Connecting…"
        case "retrying": return "Reconnecting…"
        case "disconnecting": return "Disconnecting…"
        default: return state.preview ? "Phone preview" : "Disconnected"
        }
    }

    private func lockDetail(locked: Bool, state: PhoneState?) -> String {
        if locked && state?.canUnlock == false { return "unlock from the phone" }
        return locked ? "tap to unlock" : "tap to lock"
    }

    private var phoneLabel: String {
        let status = link.link
        if !status.phoneAppInstalled { return "Faceclaw not installed" }
        if !status.phoneReachable { return "No phone connected" }
        if status.appRunning == false { return "Faceclaw not running" }
        return "iPhone"
    }

    private func phoneDetail(_ state: PhoneState?) -> String {
        let status = link.link
        if !status.phoneAppInstalled { return "install it on the phone" }
        if !status.phoneReachable { return "check Bluetooth" }
        if status.appRunning == false { return "open it on the phone" }
        if let version = state?.version, !version.isEmpty { return "Faceclaw v\(version)" }
        return "tap to refresh"
    }
}

// MARK: - Settings

/** Watch-local preferences: feel of the pad and crown. */
struct SettingsScreen: View {
    @Environment(WatchPrefs.self) private var prefs

    var body: some View {
        @Bindable var prefs = prefs
        ScrollView {
            VStack(spacing: 4) {
                Toggle("Vibrate on input", isOn: $prefs.haptics)
                Button {
                    prefs.crownSensitivity = prefs.crownSensitivity.next
                } label: {
                    RowLabel(title: "Crown sensitivity", detail: prefs.crownSensitivity.rawValue)
                }
                Text("To keep the remote open between glances, set Settings > General > Return to Clock > Faceclaw on the watch.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
                Text("Faceclaw watch v\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }
}
