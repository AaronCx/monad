import XCTest

/// Drives the app against a real monadd. Runs only when the runner is given a
/// daemon (TEST_RUNNER_MONAD_DAEMON_URL and TEST_RUNNER_MONAD_DAEMON_TOKEN on
/// the xcodebuild command line); CI has none, so there it skips.
@MainActor
final class LiveDaemonUITests: XCTestCase {
    func testBrowsesSessionsTranscriptAndSearch() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["MONAD_DAEMON_URL"], let token = env["MONAD_DAEMON_TOKEN"] else {
            throw XCTSkip("no live daemon given (TEST_RUNNER_MONAD_DAEMON_URL / _TOKEN)")
        }
        let app = XCUIApplication()
        app.launchEnvironment["MONAD_DAEMON_URL"] = url
        app.launchEnvironment["MONAD_DAEMON_TOKEN"] = token
        app.launch()

        // The session list, with the daemon's status on top.
        try expect(app.staticTexts["monad"], within: 15)
        try expect(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'monadd '")).firstMatch, within: 15)
        let firstSession = app.buttons.matching(identifier: "session-row").firstMatch
        try expect(firstSession, within: 15)
        attach(app, "1-sessions")

        // A session's transcript.
        firstSession.tap()
        let transcriptLine = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '[seq '")).firstMatch
        try expect(transcriptLine, within: 15)
        attach(app, "2-transcript")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Search, and a hit opens its session at the hit's row.
        app.buttons["Search"].tap()
        let field = app.searchFields.firstMatch
        try expect(field, within: 10)
        field.tap()
        field.typeText(env["MONAD_SEARCH_QUERY"] ?? "scroll")
        app.keyboards.buttons["search"].tap()
        let hit = app.buttons.matching(NSPredicate(format: "label CONTAINS 'seq '")).firstMatch
        try expect(hit, within: 15)
        attach(app, "3-search")
        hit.tap()
        try expect(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Transcript from seq'")).firstMatch, within: 15)
        try expect(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '[seq '")).firstMatch, within: 15)
        attach(app, "4-hit")
    }

    private func expect(_ element: XCUIElement, within seconds: TimeInterval, line: UInt = #line) throws {
        let found = element.waitForExistence(timeout: seconds)
        XCTAssertTrue(found, "not found: \(element)", line: line)
        if !found { throw NSError(domain: "LiveDaemonUITests", code: 1, userInfo: [NSLocalizedDescriptionKey: "step failed"]) }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
