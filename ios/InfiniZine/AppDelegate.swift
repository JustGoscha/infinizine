import ScreenEventsKit
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = PencilWindow(frame: UIScreen.main.bounds)
        let controller = WebViewController()
        window.rootViewController = controller
        window.pencil = { [weak controller] in controller?.pencil }
        // ScreenEvents: always share touches with screen recorders — but only while the screen is being recorded
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let events = ScreenEventsTouchCapture(window: window, source: Peer(id: "app.infinizine.ipad", name: "InfiniZine", version: version))
        let args = ProcessInfo.processInfo.arguments
        events.userEnabled = true
        events.ignoreCaptureState = args.contains("-SEForceCapture") // testing: the simulator never reports a recorded screen
        window.screenEvents = events
        controller.screenEvents = events
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// A .zine opened from Files or the share sheet: import it into the library.
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        (window?.rootViewController as? WebViewController)?.importZine(at: url)
        return true
    }
}

/// Hands every touch event to the Pencil capture before dispatching it as usual.
final class PencilWindow: UIWindow {
    var pencil: () -> PencilCapture? = { nil }
    var screenEvents: ScreenEventsTouchCapture?
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches { pencil()?.handle(event) }
        screenEvents?.handle(event)
        super.sendEvent(event)
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        screenEvents?.refreshDisplay() // rotation, Split View, Stage Manager
    }
}
