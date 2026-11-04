import SwiftUI

/**
 The touchpad. The whole screen is the pad: tap = select, double-tap = back, hold
 = long press (released when the finger lifts), tap then hold = the app's menu,
 swipes in four directions = spatial navigation, crown = plain scrolling. An upward
 swipe that begins at the bottom edge reveals the otherwise-hidden action buttons.
 */
struct RemoteScreen: View {
    let link: PhoneLink
    let prefs: WatchPrefs
    let open: (Destination) -> Void

    @Environment(\.isLuminanceReduced) private var isDimmed
    @Environment(\.scenePhase) private var scenePhase
    @State private var pad: PadController
    @State private var crownValue = 0.0
    /** When the touch in progress began; nil once it's over, however it ended. */
    @GestureState private var touchStart: Date?
    @FocusState private var crownFocused: Bool

    init(link: PhoneLink, prefs: WatchPrefs, open: @escaping (Destination) -> Void) {
        self.link = link
        self.prefs = prefs
        self.open = open
        _pad = State(initialValue: PadController(link: link, prefs: prefs))
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                padSurface
                primaryActionShortcut
                clockAndStatus.allowsHitTesting(false)
                if pad.controlsVisible && !isDimmed { tray }
            }
            .onChange(of: geometry.size.height, initial: true) { _, height in pad.padHeight = height }
        }
        .ignoresSafeArea()
        .toolbar(.hidden, for: .navigationBar)
        .animation(.easeOut(duration: 0.18), value: pad.controlsVisible)
        // Crown events only reach a focused view, and the focus is lost to every screen pushed on top.
        .focusable(true)
        .focused($crownFocused)
        .focusEffectDisabled()
        .digitalCrownRotation(
            $crownValue,
            from: -Self.crownRange,
            through: Self.crownRange,
            by: 1,
            sensitivity: prefs.crownSensitivity.digitalCrown,
            isContinuous: true,
            isHapticFeedbackEnabled: prefs.haptics
        )
        .digitalCrownAccessory(.hidden)
        .onChange(of: crownValue) { old, new in
            // A jump across the whole range is the value wrapping, not a turn.
            let delta = new - old
            if abs(delta) < Self.crownRange { pad.crownTurned(by: delta) }
        }
        // A touch-up also clears this, which arrives late enough to fall inside the next
        // touch of a quick double-tap; the pad checks which touch it's being told about.
        .onChange(of: touchStart) { old, new in
            if new == nil, let old { pad.touchWentAway(startedAt: old) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { crownFocused = true } else { pad.touchCancelled() }
        }
        .onAppear { crownFocused = true }
    }

    private var padSurface: some View {
        Color.black
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .updating($touchStart) { value, state, _ in
                        if state == nil { state = value.time }
                    }
                    .onChanged { pad.touchChanged(start: $0.startLocation, location: $0.location, time: $0.time) }
                    .onEnded { pad.touchEnded(location: $0.location) }
            )
            .accessibilityIdentifier("pad")
    }

    /**
     The double-tap hand gesture (Series 9, Ultra 2, SE 3 and later) selects. It needs a
     control to attach to, and the pad surface is a gesture rather than a control,
     so this one sits underneath everything as a transparent stand-in.
     */
    @ViewBuilder
    private var primaryActionShortcut: some View {
        if #available(watchOS 11.0, *) {
            Button("Select") { pad.click() }
                .buttonStyle(.plain)
                .handGestureShortcut(.primaryAction)
                .frame(width: 1, height: 1)
                .opacity(0.01)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    private var clockAndStatus: some View {
        let status = padLine(state: link.state, link: link.link)
        return ZStack {
            // A large, straight clock fixed on the vertical centre of the pad.
            TimelineView(.everyMinute) { context in
                Text(context.date.formatted(.dateTime.hour(.defaultDigits(amPM: .omitted)).minute()))
                    .font(.system(size: 44, weight: .regular, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            if !pad.controlsVisible {
                // Offset rather than stacked, so the clock stays put whatever this says.
                VStack(spacing: 0) {
                    Text(status.text)
                        .font(.headline)
                        .foregroundStyle(statusColor(status.tone))
                        .accessibilityIdentifier("padStatus")
                    if let detail = status.detail {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 12)
                .offset(y: 46)
                .transition(.opacity)
            }
        }
    }

    private func statusColor(_ tone: StatusTone) -> Color {
        if isDimmed { return .gray }
        return tone == .good ? .white : tone.color
    }

    private var tray: some View {
        VStack {
            Spacer()
            HStack(spacing: 6) {
                TrayButton(symbol: "sparkles", label: "Assistant") { openFromTray(.assistant) }
                TextFieldLink(prompt: Text("Type into app")) {
                    TrayIcon(symbol: "keyboard")
                } onSubmit: { text in
                    send(typed: text)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Type into app")
                .accessibilityIdentifier("Type into app")
                TrayButton(symbol: "square.grid.2x2", label: "Apps") { openFromTray(.apps) }
                TrayButton(symbol: "ellipsis", label: "Status and settings") { openFromTray(.status) }
            }
            .padding(.bottom, 10)
            // A swipe down that starts on a button dismisses the tray; a tap stays the button's.
            .simultaneousGesture(
                DragGesture(minimumDistance: 12).onEnded { value in
                    if value.translation.height > abs(value.translation.width) { pad.dismissControls() }
                }
            )
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /** The tray has done its job: coming back should show the pad's status, not the buttons. */
    private func openFromTray(_ destination: Destination) {
        pad.controlsVisible = false
        open(destination)
    }

    private func send(typed text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptics(prefs: prefs).click()
        link.sendText(trimmed)
    }

    /** Far more detents than a session will ever turn; only the changes matter. */
    private static let crownRange = 1_000_000.0
}

private struct TrayButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { TrayIcon(symbol: symbol) }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityIdentifier(label)
    }
}

private struct TrayIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Color(white: 0.2)))
    }
}
