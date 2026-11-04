import XCTest

/**
 Drives the real app on a watch simulator. The screens' own behaviour needs only
 the watch; the tests that talk to the phone need Faceclaw running on the paired
 iPhone simulator, and skip themselves otherwise. See apple-watch/README.md.
 */
@MainActor
final class PadUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(pad.waitForExistence(timeout: 10))
    }

    private var pad: XCUIElement { app.descendants(matching: .any)["pad"] }
    private var status: XCUIElement { app.staticTexts["padStatus"] }

    /**
     The middle of the pad. An element's own tap() lands on its accessibility activation
     point, near the top-left corner, and holding up there is the system's gesture for
     pulling down Notification Center.
     */
    private var padCenter: XCUICoordinate {
        pad.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    }

    private func swipe(_ dx: CGFloat, _ dy: CGFloat) {
        padCenter.press(forDuration: 0.02, thenDragTo: pad.coordinate(withNormalizedOffset: CGVector(dx: 0.5 + dx, dy: 0.5 + dy)))
    }

    private func revealTray() {
        // From the very bottom edge, which is what makes it the reveal gesture and not a scroll.
        let start = pad.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97))
        let end = pad.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.02, thenDragTo: end)
    }

    private func requirePhone() throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let text = status.exists ? status.label : ""
            if !text.isEmpty && !text.contains("phone") && !text.contains("Install") { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        throw XCTSkip("Faceclaw isn't answering on a paired iPhone: \(status.label)")
    }

    func testTrayRevealsAndOpensEveryScreen() {
        revealTray()
        let apps = app.buttons["Apps"]
        XCTAssertTrue(apps.waitForExistence(timeout: 3), "the tray should reveal from the bottom edge")
        XCTAssertTrue(app.buttons["Assistant"].exists)
        XCTAssertTrue(app.buttons["Status and settings"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["Type into app"].exists)

        apps.tap()
        XCTAssertTrue(app.staticTexts["Apps"].waitForExistence(timeout: 3))
    }

    func testStatusScreenReachesSettings() {
        revealTray()
        let more = app.buttons["Status and settings"]
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        more.tap()
        let settings = app.buttons["Watch settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 3))
        settings.tap()
        XCTAssertTrue(app.switches["Vibrate on input"].waitForExistence(timeout: 3))
    }

    /** The whole path: pad gesture -> phone -> shell -> mirrored state -> pad status line. */
    func testGesturesReachThePhoneAndComeBackAsState() throws {
        try requirePhone()
        let launcher = status.label
        XCTAssertFalse(launcher.isEmpty)

        // Open an app through the remote and watch the foreground title follow it.
        revealTray()
        let appsButton = app.buttons["Apps"]
        XCTAssertTrue(appsButton.waitForExistence(timeout: 3))
        appsButton.tap()
        let calculator = app.buttons["app:calculator"]
        XCTAssertTrue(calculator.waitForExistence(timeout: 5), "the phone's app list should be mirrored")
        calculator.tap()

        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let opened = NSPredicate(format: "label == %@", "Calculator")
        expectation(for: opened, evaluatedWith: status)
        waitForExpectations(timeout: 10)

        // Every other gesture goes the same way, and the phone answers each. A silent phone
        // would raise "No reply from the phone" within seconds; the gestures themselves are
        // checked on the phone's side by apple-watch/README.md's log command.
        padCenter.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        padCenter.doubleTap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        padCenter.press(forDuration: 0.8)
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        // Tap then hold: the first touch's end must not cancel the second, however close they are.
        padCenter.tap()
        padCenter.press(forDuration: 0.8)
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        swipe(-0.35, 0)
        swipe(0.35, 0)
        swipe(0, -0.35)
        swipe(0, 0.35)
        XCUIDevice.shared.rotateDigitalCrown(delta: 1)
        RunLoop.current.run(until: Date().addingTimeInterval(5))
        let notice = app.descendants(matching: .any)["notice"]
        XCTAssertFalse(notice.exists && notice.label.contains("reply"), "the phone should answer every gesture")
    }

    /** The system text sheet: the same path dictation takes, typed instead. */
    private func enterText(_ text: String) {
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(text)
        app.buttons["Done"].tap()
    }

    func testTypingReachesTheForegroundApp() throws {
        try requirePhone()
        revealTray()
        let apps = app.buttons["Apps"]
        XCTAssertTrue(apps.waitForExistence(timeout: 3))
        apps.tap()
        let calculator = app.buttons["app:calculator"]
        XCTAssertTrue(calculator.waitForExistence(timeout: 5))
        calculator.tap()
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "label == %@", "Calculator"), evaluatedWith: status)
        waitForExpectations(timeout: 10)

        revealTray()
        let type = app.descendants(matching: .any)["Type into app"]
        XCTAssertTrue(type.waitForExistence(timeout: 3))
        type.tap()
        enterText("1234")

        // A refusal or a dropped message would show an error pill within the ack timeout.
        RunLoop.current.run(until: Date().addingTimeInterval(6))
        let notice = app.descendants(matching: .any)["notice"]
        XCTAssertFalse(notice.exists, "typing should be accepted: \(notice.exists ? notice.label : "")")
    }

    /** A query goes out, and whatever the assistant does comes back as events. */
    func testAssistantRepliesAreMirrored() throws {
        try requirePhone()
        revealTray()
        let assistant = app.buttons["Assistant"]
        XCTAssertTrue(assistant.waitForExistence(timeout: 3))
        assistant.tap()
        let phase = app.staticTexts["assistantPhase"]
        XCTAssertTrue(phase.waitForExistence(timeout: 3))
        if phase.label.contains("Set up") { throw XCTSkip("No assistant on the phone") }
        app.descendants(matching: .any)["assistantAsk"].tap()
        enterText("hello")
        // The phone's first event replaces the watch's optimistic "Thinking…" with its own, then
        // a real reply or, with no model on a simulator, an error: both prove the channel.
        expectation(for: NSPredicate(format: "label == %@ OR label == %@", "Reply", "Error"), evaluatedWith: phase)
        waitForExpectations(timeout: 60)
    }
}
