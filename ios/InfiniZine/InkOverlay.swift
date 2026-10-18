import UIKit

/// Latency hiding for the live stroke. The page paints the stroke a frame or two after
/// the Pencil moved (touch → web process → canvas → compositor). This layer, updated
/// straight from UIKit's touches, draws only the newest piece the page hasn't painted
/// yet, plus UIKit's prediction, in the same colour and width — so the ink stays
/// under the Pencil tip. The page reports what it has painted ("painted") and the
/// overlay drops everything older — once that frame can be on screen: the page reports
/// while drawing, and its canvas reaches the display a frame or two later (more when its
/// frames are heavy, e.g. animated areas), so dropping right away left a gap at the tip
/// that filled in again. Opaque strokes only (pen, fineliner): an overlap with
/// translucent ink would show.
final class InkOverlay: UIView {
    private let shape = CAShapeLayer()
    private var active = false
    private var widths: [CGFloat] = [] // screen width by pressure 0, 0.1, … 1
    private var samples: [PenSample] = []
    private var predicted: [PenSample] = []
    private var painted: TimeInterval = 0 // painted and surely on screen by now
    private var reports: [(at: CFTimeInterval, t: TimeInterval)] = [] // "painted" as reported, newest last
    private var reportInterval: CFTimeInterval = 1.0 / 60 // the page's frame time, smoothed
    private var ended = false
    private var clearTimer: Timer?
    /// for the benchmark: the newest sample shown and when
    private(set) var tip: PenSample?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        shape.fillColor = nil
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        shape.frame = bounds
    }

    /// The page's live stroke: {active, color "#rrggbb", widths [11 screen px]}.
    func style(_ body: [String: Any]) {
        active = body["active"] as? Bool ?? false
        if let c = body["color"] as? String { shape.strokeColor = UIColor(hex: c).cgColor }
        if let w = body["widths"] as? [Double], w.count >= 2 { widths = w.map { CGFloat($0) } }
        if !active { clear() }
    }

    func feed(_ phase: PenPhase, _ s: [PenSample], _ pr: [PenSample]) {
        if phase == .began {
            clearTimer?.invalidate()
            samples = []
            painted = 0
            reports = []
            ended = false
            // nothing until the page says this touch is an ink stroke (its "ink" message): a touch
            // with the eraser or the selector, or one on the toolbar, must never get native ink
            active = false
            shape.path = nil
        }
        samples += s
        predicted = pr
        if phase == .ended || phase == .cancelled {
            ended = true
            predicted = []
            // whatever the page hasn't confirmed by now, it has (or the stroke was dropped)
            clearTimer?.invalidate()
            clearTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { [weak self] _ in self?.clear() }
        }
        redraw()
    }

    func paintedUpTo(_ t: TimeInterval) {
        let now = CACurrentMediaTime()
        if let last = reports.last { reportInterval += (min(0.1, now - last.at) - reportInterval) * 0.2 }
        reports.append((now, t))
        settle(now)
        redraw()
        if ended && (samples.last.map { $0.t <= painted } ?? true) { clear() }
    }

    /// Take in the reports old enough that their frame is on screen: two of the page's frames
    /// (at least two display refreshes) after the report.
    private func settle(_ now: CFTimeInterval) {
        let refresh = 1.0 / Double(max(60, window?.screen.maximumFramesPerSecond ?? 60))
        let lag = max(2 * refresh, 2 * reportInterval)
        while let r = reports.first, now - r.at >= lag {
            painted = max(painted, r.t)
            reports.removeFirst()
        }
    }

    private func clear() {
        samples = []
        predicted = []
        tip = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.path = nil
        CATransaction.commit()
    }

    private func width(_ force: CGFloat) -> CGFloat {
        guard widths.count >= 2 else { return 2 }
        let f = min(1, max(0, force)) * CGFloat(widths.count - 1)
        let i = min(widths.count - 2, Int(f))
        return widths[i] + (widths[i + 1] - widths[i]) * (f - CGFloat(i))
    }

    private func redraw() {
        guard active else { return }
        settle(CACurrentMediaTime())
        // keep one already-painted sample so the overlay joins the page's stroke without a gap
        var from = samples.count - 1
        while from > 0 && samples[from - 1].t > painted { from -= 1 }
        if from > 0 { from -= 1 }
        if from > 0 { samples.removeFirst(from) } // painted for good: forget
        let pts = samples + predicted
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if pts.count >= 2 {
            let path = UIBezierPath()
            path.move(to: CGPoint(x: pts[0].x, y: pts[0].y))
            for q in pts.dropFirst() { path.addLine(to: CGPoint(x: q.x, y: q.y)) }
            shape.path = path.cgPath
            let recent = samples.suffix(4)
            let force = recent.isEmpty ? 0.5 : recent.reduce(0) { $0 + $1.force } / CGFloat(recent.count)
            shape.lineWidth = width(force > 0 ? force : 0.5)
            tip = ended ? nil : pts.last // pen up: nothing to keep up with any more
        } else {
            shape.path = nil
            tip = nil
        }
        CATransaction.commit()
    }
}

extension UIColor {
    convenience init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
}
