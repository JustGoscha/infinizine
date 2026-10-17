import UIKit
import WebKit

/// One Pencil sample as the web side wants it (see src/native.ts).
struct PenSample {
    var x: CGFloat // CSS px (web view points)
    var y: CGFloat
    var t: TimeInterval // seconds, the touch clock (= CACurrentMediaTime)
    var force: CGFloat // 0…1
    var altitude: CGFloat // radians, π/2 = upright
    var azimuth: CGFloat // radians, screen plane
}

enum PenPhase: String { case began = "b", moved = "m", ended = "e", cancelled = "c" }

/// Watches the Pencil without taking a single touch away from the web view: it sees
/// every touch event as the window dispatches it (PencilWindow.sendEvent), so WebKit
/// still gets everything (hover, taps on the toolbar) and nothing can defer or cancel
/// the observation — a gesture recognizer on the web view would be failed by WebKit as
/// soon as the page calls preventDefault() on pointerdown. What it adds is what the web
/// view can't see: the precise (sub-pixel) location, every coalesced sample (240 Hz) and
/// UIKit's predicted touches. They go to src/native.ts, which replays them on the canvas.
final class PencilCapture {
    private weak var webView: WKWebView?
    /// set once the page has said it's ready
    var pageReady = false
    /// simulator testing: let mouse drags (direct touches) stand in for the Pencil
    var acceptsDirectTouches = false
    /// every batch, also handed to the native ink overlay
    var observer: ((PenPhase, [PenSample], [PenSample]) -> Void)?

    private var touch: UITouch?
    private var strokeId = 0
    static let logging = ProcessInfo.processInfo.arguments.contains("-izineLogStrokes")

    init(webView: WKWebView) {
        self.webView = webView
    }

    /// Called for every touch event the window dispatches, before it's delivered.
    func handle(_ event: UIEvent) {
        guard pageReady, let view = webView, let all = event.allTouches else { return }
        if touch == nil {
            // a new Pencil touch that lands on the web view
            guard let t = all.first(where: { $0.phase == .began && (($0.type == .pencil) || (acceptsDirectTouches && $0.type == .direct)) }),
                  let hit = t.view, hit.isDescendant(of: view) else { return }
            touch = t
            strokeId += 1
            forward(.began, t, event)
            return
        }
        guard let t = touch, all.contains(t) else { return }
        switch t.phase {
        case .moved, .stationary: if t.phase == .moved { forward(.moved, t, event) }
        case .ended: forward(.ended, t, event); touch = nil
        case .cancelled: forward(.cancelled, t, event); touch = nil
        default: break
        }
    }

    private func forward(_ phase: PenPhase, _ t: UITouch, _ event: UIEvent) {
        guard let view = webView else { return }
        let coalesced = event.coalescedTouches(for: t) ?? [t]
        let predicted = phase == .moved ? (event.predictedTouches(for: t) ?? []) : []
        deliver(phase, coalesced.map { Self.sample($0, in: view) }, predicted.map { Self.sample($0, in: view) })
    }

    static func sample(_ t: UITouch, in view: UIView) -> PenSample {
        let p = t.preciseLocation(in: view)
        let force = t.type == .pencil && t.maximumPossibleForce > 0 ? t.force / t.maximumPossibleForce : 0
        return PenSample(x: p.x, y: p.y, t: t.timestamp, force: force,
                         altitude: t.type == .pencil ? t.altitudeAngle : .pi / 2,
                         azimuth: t.type == .pencil ? t.azimuthAngle(in: view) : 0)
    }

    /// Send a batch to the page (also the entry point of the scripted Pencil, see PencilSimulator).
    func deliver(_ phase: PenPhase, _ samples: [PenSample], _ predicted: [PenSample], id: Int? = nil) {
        #if DEBUG
        if Self.logging { NSLog("[izine] pen \(phase.rawValue) \(samples.count)+\(predicted.count) at \(samples.first.map { "\($0.x),\($0.y)" } ?? "-")") }
        #endif
        observer?(phase, samples, predicted)
        guard let view = webView else { return }
        var js = "window.__izineNative&&__izineNative.pen({ph:'\(phase.rawValue)',id:\(id ?? strokeId),now:\(CACurrentMediaTime()),s:"
        Self.append(samples, to: &js)
        js += ",pr:"
        Self.append(predicted, to: &js)
        js += "})"
        view.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func append(_ s: [PenSample], to js: inout String) {
        js += "["
        for (i, q) in s.enumerated() {
            if i > 0 { js += "," }
            js += "[\(fmt(q.x)),\(fmt(q.y)),\(q.t),\(fmt(q.force)),\(fmt(q.altitude)),\(fmt(q.azimuth))]"
        }
        js += "]"
    }

    private static func fmt(_ v: CGFloat) -> String { String(format: "%.4f", Double(v)) }
}
