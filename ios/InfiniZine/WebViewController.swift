import ScreenEventsKit
import UIKit
import WebKit

/// Hosts the InfiniZine web app — the same code and the same .zine format as the web
/// version — and adds what a browser can't: full-precision Pencil input (PencilCapture),
/// rendering at the display's full rate (120 Hz on ProMotion), file import/export
/// through the system.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private(set) var webView: WKWebView!
    private(set) var pencil: PencilCapture!
    private var overlay: InkOverlay!
    private var ready = false
    private var pendingImports: [URL] = []
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var simulator: AnyObject? // PencilSimulator (debug)
    var overlayTip: PenSample? { overlay.tip }
    var screenEvents: ScreenEventsTouchCapture?
    static let screenEventsKey = "screenEvents"


    /// `-izineTest native|web`: run the scripted Pencil benchmark (see PencilSimulator)
    static let testMode: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-izineTest"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }()
    static let flag = { (name: String) in ProcessInfo.processInfo.arguments.contains(name) }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.websiteDataStore = .default()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        var info: [String: Any] = ["platform": "ios", "version": version]
        if let t = Self.testMode { info["test"] = t }
        if Self.flag("-izineLogStrokes") { info["logStrokes"] = true }
        if Self.flag("-izineMousePencil") { info["mousePencil"] = true }
        info["screenEvents"] = UserDefaults.standard.bool(forKey: Self.screenEventsKey)
        let json = String(data: try! JSONSerialization.data(withJSONObject: info), encoding: .utf8)!
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__izineNativeApp = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(WeakMessageHandler(self), name: "izine")
        // Safari caps page rendering near 60 fps unless the user flips a setting; the app
        // renders at the display's rate (120 Hz on ProMotion). The web-emulation benchmark keeps the cap.
        let fullRate = Self.testMode != "web" && !Self.flag("-izine60")
        if fullRate { Self.setFeature(config.preferences, "PreferPageRenderingUpdatesNear60FPSEnabled", false) }

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsLinkPreview = false
        wv.allowsBackForwardNavigationGestures = false
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.pinchGestureRecognizer?.isEnabled = false
        wv.isOpaque = false
        wv.backgroundColor = UIColor(named: "Paper")
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        webView = wv

        let root = UIView()
        root.backgroundColor = UIColor(named: "Paper")
        wv.frame = root.bounds
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(wv)
        overlay = InkOverlay(frame: root.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(overlay)
        view = root

        pencil = PencilCapture(webView: wv)
        pencil.acceptsDirectTouches = Self.flag("-izineMousePencil") // simulator: draw with the mouse
        pencil.observer = { [weak self] phase, s, pr in self?.overlay.feed(phase, s, pr) }
        wv.load(URLRequest(url: AppSchemeHandler.start))
        NSLog("[izine] fullRate=\(fullRate) test=\(Self.testMode ?? "-")")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    // the screen edges are canvas too: system swipes need a second, deliberate swipe
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    /// Flip one of WebKit's internal feature flags (what Safari shows under Settings → Safari →
    /// Advanced → Feature Flags). Private, so every step is checked: on a WebKit without the
    /// flag (older iPadOS) nothing happens and the page simply renders at WebKit's default rate.
    @discardableResult
    static func setFeature(_ prefs: WKPreferences, _ key: String, _ enabled: Bool) -> Bool {
        let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
        guard (WKPreferences.self as AnyObject).responds(to: list), prefs.responds(to: set),
              let features = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject],
              let feature = features.first(where: { ($0.value(forKey: "key") as? String) == key }),
              let method = class_getInstanceMethod(WKPreferences.self, set) else {
            NSLog("[izine] WebKit feature \(key) not available")
            return false
        }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        unsafeBitCast(method_getImplementation(method), to: Setter.self)(prefs, set, enabled, feature)
        NSLog("[izine] WebKit feature \(key) = \(enabled)")
        return true
    }

    // MARK: messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            pencil.pageReady = true
            let urls = pendingImports
            pendingImports = []
            urls.forEach(importZine(at:))
            runLaunchActions()
        case "testReady":
            #if DEBUG
            if let mode = Self.testMode, simulator == nil { simulator = PencilSimulator(controller: self, mode: mode) }
            #endif
        case "ink":
            // the live stroke's look, so the overlay can draw the newest bit before the page does
            // (not in the web-emulation benchmark: a browser has no such layer)
            if Self.testMode != "web" && !Self.flag("-izineNoOverlay") { overlay.style(body) }
        case "painted":
            // the page has painted samples up to this (native clock) time
            if let t = body["t"] as? Double { overlay.paintedUpTo(t) }
        case "testResult":
            #if DEBUG
            (simulator as? PencilSimulator)?.finish(body)
            #endif
        case "screenEvents":
            let on = body["enabled"] as? Bool ?? false
            UserDefaults.standard.set(on, forKey: Self.screenEventsKey)
            screenEvents?.userEnabled = on
        case "log":
            NSLog("[izine:web] \(body["msg"] ?? "")")
        default: break
        }
    }

    /// Automation: `-izineImport <file>` imports a .zine at launch; `-izineExport` then saves the
    /// open zine through the normal download path (→ Documents); `-izineSummary` logs the library's open zine.
    private func runLaunchActions() {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-izineImport"), i + 1 < args.count {
            importZine(at: URL(fileURLWithPath: args[i + 1]))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            if Self.flag("-izineSummary") || Self.flag("-izineExport") {
                self.webView.evaluateJavaScript("JSON.stringify(__izineDebug.summary())") { r, _ in NSLog("[izine] summary \(r ?? "-")") }
            }
            if Self.flag("-izineExport") { self.webView.evaluateJavaScript("__izineDebug.exportZine();0", completionHandler: nil) }
        }
    }

    // MARK: import / export

    /// Load a .zine into the library (opened from Files or the share sheet).
    func importZine(at url: URL) {
        guard ready else { pendingImports.append(url); return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let text = try? String(contentsOf: url, encoding: .utf8),
              let arg = try? JSONSerialization.data(withJSONObject: [text]),
              let literal = String(data: arg, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__izineImport && window.__izineImport(\(literal)[0])", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if let url = navigationAction.request.url, navigationAction.navigationType == .linkActivated,
           let scheme = url.scheme, !["izine", "blob", "data", "about"].contains(scheme) {
            UIApplication.shared.open(url) // outside links leave for Safari
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename)
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // keep a copy in the app's Documents (visible in Files → On My iPad → InfiniZine)
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let kept = docs.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: kept)
        try? FileManager.default.copyItem(at: url, to: kept)
        NSLog("[izine] exported \(kept.path)")
        if Self.testMode != nil { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 60, width: 1, height: 1)
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        NSLog("[izine] download failed: \(error)")
    }

    // MARK: alert / confirm / prompt (WKWebView drops them unless the app shows them)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload() // memory pressure killed the page: bring it back (the library is in IndexedDB)
    }
}

/// WKUserContentController retains its handlers; this keeps the controller free.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
