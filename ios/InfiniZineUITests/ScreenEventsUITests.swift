import XCTest

/// InfiniZine as a ScreenEvents source: SE Recorder (the standard's test recorder, in-app
/// listener, kept running in the background) receives InfiniZine's real touches over loopback.
/// Needs SE Recorder installed (omg-screenevents-standard/testapps).
final class ScreenEventsUITests: XCTestCase {
    let recorder = XCUIApplication(bundleIdentifier: "app.omg.screenevents.recorder")

    func count(_ label: String, _ key: String) -> Int {
        guard let r = label.range(of: "\(key)=(\\d+)", options: .regularExpression) else { return 0 }
        return Int(label[r].split(separator: "=")[1]) ?? 0
    }

    func testInfiniZineSendsTouchesToRecorder() throws {
        recorder.launchArguments = ["-SEInAppListener"]
        recorder.launch()
        let inapp = recorder.staticTexts["inapp"]
        XCTAssertTrue(inapp.waitForExistence(timeout: 10))

        let app = XCUIApplication()
        app.launchArguments = ["-SEForceCapture", "-izineMousePencil"]
        app.launch()
        sleep(4)
        let win = app.windows.firstMatch
        for (x0, y0, x1, y1) in [(0.25, 0.3, 0.7, 0.35), (0.3, 0.5, 0.6, 0.62)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
            win.coordinate(withNormalizedOffset: CGVector(dx: x0, dy: y0))
                .press(forDuration: 0.05, thenDragTo: win.coordinate(withNormalizedOffset: CGVector(dx: x1, dy: y1)), withVelocity: 300, thenHoldForDuration: 0.05)
        }
        win.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
        sleep(1)
        recorder.activate()
        var label = ""
        for _ in 0..<50 { label = inapp.label; if count(label, "ended") >= 3 { break }; usleep(200_000) }
        print("RECORDER COUNTS:\n\(label)")
        XCTAssertGreaterThanOrEqual(count(label, "began"), 3, label)
        XCTAssertEqual(count(label, "began"), count(label, "ended") + count(label, "cancelled"), label)
        XCTAssertGreaterThanOrEqual(count(label, "display"), 1, label)
    }
}
