#if DEBUG
import UIKit
import WebKit

/// A scripted Apple Pencil for the iOS Simulator, which can't produce Pencil input.
/// Strokes follow known paths and go through PencilCapture.deliver exactly like UIKit
/// touches would on a ProMotion iPad Pro: an event every 1/120 s, each carrying the
/// coalesced samples since the last one (240 Hz, with ~0.1 px sensor noise) and a
/// predicted continuation (constant-velocity model, two samples ahead).
///
/// Mode "web" plays the same strokes the way Safari hands them to a page on iPadOS < 26.2:
/// one sample per event, rounded to whole CSS pixels, no prediction, page rendering capped
/// near 60 fps, no overlay. Same app, same pipeline, same measurements.
///
/// The page (src/pentest.ts) measures precision against the true path and how far the
/// painted tip trails the pen; the native overlay's lag is measured here. Results go to
/// Documents/izine-bench-<mode>.json and the log; then the app exits.
final class PencilSimulator {
    private weak var controller: WebViewController?
    private let mode: String
    private var native: Bool { mode != "web" }

    struct Stroke { let name: String; let duration: Double; let path: (Double) -> CGPoint }
    private var strokes: [Stroke] = []
    private let sigmas: [Double] = [1, 3] // the smoothing slider (px)
    private var overlayLags: [String: [Double]] = [:]
    private var link: CADisplayLink?
    private var currentName = ""
    private var rng = SystemRandomNumberGenerator()

    init(controller: WebViewController, mode: String) {
        self.controller = controller
        self.mode = mode
        let b = controller.view.bounds
        let x0 = b.width * 0.2, w = b.width, h = b.height
        func row(_ k: Double) -> Double { h * (0.22 + 0.11 * k) }
        strokes = [
            Stroke(name: "slow shallow line", duration: 2.0) { t in CGPoint(x: x0 + 70 * t, y: row(0) + 8 * t) },
            Stroke(name: "slow diagonal", duration: 2.0) { t in CGPoint(x: x0 + 50 * t, y: row(1) + 45 * t) },
            Stroke(name: "medium curve", duration: 1.5) { t in CGPoint(x: x0 + 180 * t, y: row(2.6) + 30 * sin(t * 4)) },
            Stroke(name: "small loops", duration: 2.0) { t in CGPoint(x: x0 + 30 * t + 6 * cos(9 * t), y: row(3.6) + 6 * sin(9 * t)) },
            Stroke(name: "fast flick", duration: 0.3) { t in CGPoint(x: x0 + min(1500 * t, w * 0.55), y: row(4.6) + 300 * t * t) },
        ]
        link = CADisplayLink(target: self, selector: #selector(frame))
        link?.add(to: .main, forMode: .common)
        Task { @MainActor in await self.run() }
    }

    /// overlay lag: at each display frame, how old (or how far ahead, if predicted) its tip is
    @objc private func frame() {
        guard native, let tip = controller?.overlayTip else { return }
        overlayLags[currentName, default: []].append((CACurrentMediaTime() - tip.t) * 1000)
    }

    @MainActor private func js(_ s: String) async {
        _ = try? await controller?.webView.evaluateJavaScript(s + ";0")
    }

    @MainActor private func run() async {
        try? await Task.sleep(nanoseconds: 800_000_000)
        for sigma in sigmas {
            await js("__izineTest.setup(\(sigma))")
            try? await Task.sleep(nanoseconds: 400_000_000)
            for (i, s) in strokes.enumerated() {
                currentName = "\(s.name)|\(sigma)"
                await js("__izineTest.begin(\(i), '\(s.name)')")
                await play(s, id: 1000 + i + Int(sigma) * 100)
                try? await Task.sleep(nanoseconds: 300_000_000) // let it commit
                await js("__izineTest.end(\(i))")
            }
        }
        var extra: [String: Any] = [:]
        for (k, v) in overlayLags where !v.isEmpty {
            let s = v.sorted()
            extra[k] = ["median": s[s.count / 2], "p90": s[min(s.count - 1, s.count * 9 / 10)], "n": s.count]
        }
        let json = String(data: try! JSONSerialization.data(withJSONObject: ["overlayLag": extra]), encoding: .utf8)!
        await js("__izineTest.done(\(json))")
    }

    private func noise() -> Double {
        // ~N(0, 0.1 px): sum of uniforms
        (0..<4).reduce(0.0) { acc, _ in acc + Double.random(in: -0.5...0.5, using: &rng) } * 0.17
    }

    /// One stroke in real time: 240 Hz samples, an event every 1/120 s.
    @MainActor private func play(_ s: Stroke, id: Int) async {
        guard let pencil = controller?.pencil else { return }
        let start = CACurrentMediaTime()
        let n = Int(s.duration * 240)
        func sample(_ k: Int, noisy: Bool = true) -> PenSample {
            let t = Double(k) / 240
            let p = s.path(t)
            let f = 0.3 + 0.3 * sin(.pi * t / s.duration)
            return PenSample(x: p.x + (noisy ? noise() : 0), y: p.y + (noisy ? noise() : 0), t: start + t,
                             force: f, altitude: 0.95, azimuth: 0.7)
        }
        func web(_ q: PenSample) -> PenSample { // what Safari < 26.2 hands the page
            PenSample(x: q.x.rounded(), y: q.y.rounded(), t: q.t, force: q.force, altitude: q.altitude, azimuth: q.azimuth)
        }
        var sent = -1
        var event = 0
        while sent < n {
            // wait for the next 1/120 s event time
            let due = start + Double(event) / 120
            let wait = due - CACurrentMediaTime()
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
            event += 1
            let now = CACurrentMediaTime()
            let upTo = min(n, Int((now - start) * 240))
            if upTo <= sent { continue }
            let ks = Array((sent + 1)...upTo)
            // the true path for the page's measurements
            let truth = ks.map { k -> String in let q = sample(k, noisy: false); return "[\(q.t),\(q.x),\(q.y)]" }.joined(separator: ",")
            await js("__izineTest.truth([\(truth)])")
            var batch = ks.map { sample($0) }
            var predicted: [PenSample] = []
            if native {
                if upTo >= 1 && upTo < n {
                    let a = sample(upTo - 1), b = sample(upTo)
                    predicted = (1...2).map { j in
                        PenSample(x: b.x + (b.x - a.x) * Double(j), y: b.y + (b.y - a.y) * Double(j), t: b.t + Double(j) / 240,
                                  force: b.force, altitude: b.altitude, azimuth: b.azimuth)
                    }
                }
            } else {
                batch = [web(batch[batch.count - 1])] // one sample per event, whole pixels
            }
            let phase: PenPhase = sent < 0 ? .began : upTo >= n ? .ended : .moved
            if phase == .began && batch.count > 1 && native {
                pencil.deliver(.began, [batch[0]], [], id: id)
                pencil.deliver(.moved, Array(batch.dropFirst()), predicted, id: id)
            } else {
                pencil.deliver(phase, batch, predicted, id: id)
            }
            sent = upTo
        }
    }

    /// The page's results: add the overlay's, write them out, log a summary, exit.
    func finish(_ body: [String: Any]) {
        link?.invalidate()
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent("izine-bench-\(mode).json")
        if let data = try? JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url)
        }
        NSLog("[izine] bench written: \(url.path)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
}
#endif
