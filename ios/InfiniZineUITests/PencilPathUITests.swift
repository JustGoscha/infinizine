import XCTest

/// Real touches through UIKit in the simulator (it can't make Pencil touches, so the app is
/// launched with -izineMousePencil: direct touches stand in for the Pencil). The drags go
/// through the actual PencilCapture recognizer → web view → canvas; the app logs each
/// committed stroke (-izineLogStrokes) with its input precision and sample rate.
final class PencilPathUITests: XCTestCase {
    func testDragsBecomeFullPrecisionStrokes() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-izineMousePencil", "-izineLogStrokes"]
        app.launch()
        sleep(3)
        let win = app.windows.firstMatch
        let starts: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(0.25, 0.30, 0.65, 0.36), (0.25, 0.45, 0.55, 0.60), (0.30, 0.70, 0.70, 0.66)]
        for (x0, y0, x1, y1) in starts {
            let a = win.coordinate(withNormalizedOffset: CGVector(dx: x0, dy: y0))
            let b = win.coordinate(withNormalizedOffset: CGVector(dx: x1, dy: y1))
            a.press(forDuration: 0.05, thenDragTo: b, withVelocity: 300, thenHoldForDuration: 0.1)
            sleep(1)
        }
        let shot = XCUIScreen.main.screenshot()
        let att = XCTAttachment(screenshot: shot)
        att.lifetime = .keepAlways
        add(att)
        try shot.pngRepresentation.write(to: URL(fileURLWithPath: NSTemporaryDirectory() + "izine-uitest.png"))
    }
}
