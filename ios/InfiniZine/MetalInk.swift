import MetalKit
import UIKit

/// The native Metal backend of the page's GPU engine (src/metal.ts, planning in src/gpuplan.ts):
/// a Metal view under the web view — which then goes see-through — that draws the paper, its marks
/// and all the still ink. The page sends one binary packet per frame over izine://gpu/ (new
/// geometry, textures, moves, and the frame: camera, draw list, far tiles); this keeps the geometry
/// on the GPU and draws exactly what it's told, the same way the WebGPU backend does (same shaders,
/// same stencil-then-cover fills, same far tiles), so the two look alike.
final class MetalInk: NSObject, MTKViewDelegate {
    let view: MTKView
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var pipes: [String: MTLRenderPipelineState] = [:]
    private var stencils: [String: MTLDepthStencilState] = [:]
    private var samplers: [String: MTLSamplerState] = [:]
    private var items: Arena
    private var fan: Arena
    private var stampsA: Arena
    private var dotsA: Arena
    private var cover = [UInt32]()
    private var coverBuf: MTLBuffer?
    private var coverBufs: [MTLBuffer?] = [nil, nil, nil] // (one per frame in flight: the GPU may still read the last two)
    private var coverTurn = 0
    private var els: [UInt32: El] = [:]
    private var textures: [UInt32: MTLTexture] = [:]
    private var tiles: [UInt32: Tile] = [:]
    private var frame: Frame?
    private var builds: [(Tile, [UInt32])] = []
    private var tileMSAA: MTLTexture?
    private var tileStencil: MTLTexture?
    private(set) var active = false
    /// what the last packets cost here (for the benchmark log)
    private(set) var lastParseMs = 0.0
    private(set) var lastDrawMs = 0.0
    /// frame costs since the last report: (parse + draw ms), and the packets' sizes
    private var costs: [Double] = []
    private var bytes = 0

    static let tileSize = 512

    struct Part {
        var kind: UInt32 // 0 fan · 1 pattern · 2 stamps · 3 dots · 4 bitmap
        var blend: Int // 0 over · 1 multiply · 2 screen
        var slot: Int
        var v = 0, vn = 0 // fill vertices in the fan arena
        var inst = 0, n = 0 // stamps / dots
        var box: SIMD4<Float>
        var r: Float = 0 // dot radius
        var cell: Float = 0 // pixel cell size (bitmap of cells)
        var tex: UInt32 = 0
        var tint: [Part] = [] // far-out stand-in (dots, cells)
    }
    struct El { var parts: [Part]; var off = SIMD2<Float>(0, 0) }
    struct Tile { var id: UInt32; var tex: MTLTexture; var slot: Int; var L: Float; var i: Int32; var j: Int32 }
    struct Frame {
        var W: Float, H: Float, dpr: Float, s: Float, ox: Float, oy: Float, dim: Float
        var paper: SIMD3<Float>
        var gridKind: UInt32, gridSp: Float, gridX: Float, gridY: Float, gridDark: Bool, gridT: Float
        var nibTex: UInt32
        var direct: Bool
        var els: [UInt32]
        var show: [UInt32]
    }

    init?(frame: CGRect) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
        view = MTKView(frame: frame, device: device)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .stencil8
        view.sampleCount = 4
        view.isPaused = true
        view.enableSetNeedsDisplay = false
        view.framebufferOnly = !ProcessInfo.processInfo.arguments.contains("-izineMetalShot")
        view.isUserInteractionEnabled = false
        view.isHidden = true
        items = Arena(device, unit: 64, cap: 4096)
        fan = Arena(device, unit: 8, cap: 1 << 18)
        stampsA = Arena(device, unit: 28, cap: 1 << 16)
        dotsA = Arena(device, unit: 12, cap: 1 << 14)
        super.init()
        view.delegate = self
        do { try makePipelines() } catch { NSLog("[izine] metal: shaders failed: \(error)"); return nil }
    }

    /// "n frames, parse+draw ms p50 / p95 / max, MB received" since the last call (benchmark)
    func report(reset: Bool = false) -> String {
        defer { costs.removeAll(); bytes = 0 }
        if reset || costs.isEmpty { return "metal: no frames" }
        let c = costs.sorted()
        let q = { (p: Double) in c[min(c.count - 1, Int(Double(c.count) * p))] }
        return String(format: "metal native: %d frames · parse+draw p50 %.1f p95 %.1f max %.1f ms · %.1f MB in", c.count, q(0.5), q(0.95), c.last!, Double(bytes) / 1e6)
    }

    func setActive(_ on: Bool) {
        active = on
        view.isHidden = !on
        if !on { reset() }
    }

    private func reset() {
        els.removeAll(); textures.removeAll(); tiles.removeAll(); builds.removeAll(); frame = nil
        items = Arena(device, unit: 64, cap: 4096)
        fan = Arena(device, unit: 8, cap: 1 << 18)
        stampsA = Arena(device, unit: 28, cap: 1 << 16)
        dotsA = Arena(device, unit: 12, cap: 1 << 14)
    }

    // MARK: packets

    /// One packet from the page: apply its records, then draw its frame.
    private var packets = 0
    func receive(_ data: Data) {
        packets += 1
        guard active else { return }
        let t0 = CACurrentMediaTime()
        var gotFrame = false
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var r = Reader(raw)
            while r.left >= 8 {
                let type = r.u32(), len = Int(r.u32())
                let end = r.at + len
                switch type {
                case 1: readAdd(&r)
                case 2: remove(r.u32())
                case 3: let h = r.u32(); let dx = r.f32(), dy = r.f32(); move(h, dx, dy)
                case 4: readTex(&r)
                case 5: readTexSet(&r)
                case 6: textures.removeValue(forKey: r.u32())
                case 7: if let t = tiles.removeValue(forKey: r.u32()) { items.release(t.slot, 1) }
                case 8: readFrame(&r); gotFrame = true
                default: break
                }
                r.at = end
            }
        }
        lastParseMs = (CACurrentMediaTime() - t0) * 1000
        bytes += data.count
        if gotFrame { view.draw(); costs.append(lastParseMs + lastDrawMs) }
    }

    private func readFan(_ r: inout Reader) -> (Int, Int) {
        let n = Int(r.u32()) // floats
        let vn = n / 2
        guard vn > 0 else { return (0, 0) }
        let v = fan.alloc(vn)
        fan.write(at: v, r.bytes(n * 4))
        return (v, vn)
    }

    private func newItem(_ color: SIMD4<Float>, _ box: SIMD4<Float>, _ p: SIMD4<Float> = .zero) -> Int {
        let slot = items.alloc(1)
        let v = [color, box, p, SIMD4<Float>.zero]
        v.withUnsafeBytes { items.write(at: slot, $0) }
        return slot
    }

    private func readAdd(_ r: inout Reader) {
        let h = r.u32(), n = Int(r.u32())
        var parts: [Part] = []
        for _ in 0..<n {
            let kind = r.u32(), blend = Int(r.u32())
            let color = SIMD4<Float>(r.f32(), r.f32(), r.f32(), r.f32())
            let box = SIMD4<Float>(r.f32(), r.f32(), r.f32(), r.f32())
            switch kind {
            case 0:
                let (v, vn) = readFan(&r)
                parts.append(Part(kind: 0, blend: blend, slot: newItem(color, box), v: v, vn: vn, box: box))
            case 1:
                let p = SIMD4<Float>(r.f32(), r.f32(), r.f32(), 0)
                let (v, vn) = readFan(&r)
                parts.append(Part(kind: 1, blend: blend, slot: newItem(color, box, p), v: v, vn: vn, box: box))
            case 2:
                let count = Int(r.u32())
                let floats = Int(r.u32())
                let slot = newItem(color, box)
                let src = r.bytes(floats * 4)
                // 6 floats per stamp in → 7 words out (+ the item)
                var out = [Float](repeating: 0, count: count * 7)
                src.withMemoryRebound(to: Float.self) { f in
                    for i in 0..<count {
                        for k in 0..<6 { out[i * 7 + k] = f[i * 6 + k] }
                        out[i * 7 + 6] = Float(bitPattern: UInt32(slot))
                    }
                }
                let inst = stampsA.alloc(count)
                out.withUnsafeBytes { stampsA.write(at: inst, $0) }
                parts.append(Part(kind: 2, blend: 0, slot: slot, inst: inst, n: count, box: box))
            case 3:
                let rad = r.f32()
                let floats = Int(r.u32())
                let count = floats / 2
                let slot = newItem(color, box, SIMD4<Float>(rad, 0, 0, 0))
                let src = r.bytes(floats * 4)
                var out = [Float](repeating: 0, count: count * 3)
                src.withMemoryRebound(to: Float.self) { f in
                    for i in 0..<count { out[i * 3] = f[i * 2]; out[i * 3 + 1] = f[i * 2 + 1]; out[i * 3 + 2] = Float(bitPattern: UInt32(slot)) }
                }
                let inst = dotsA.alloc(count)
                out.withUnsafeBytes { dotsA.write(at: inst, $0) }
                let tintAlpha = r.f32()
                let (v, vn) = readFan(&r)
                let tint = Part(kind: 0, blend: blend, slot: newItem(SIMD4(color.x, color.y, color.z, tintAlpha), box), v: v, vn: vn, box: box)
                parts.append(Part(kind: 3, blend: blend, slot: slot, inst: inst, n: count, box: box, r: rad, tint: [tint]))
            default:
                let cell = r.f32(), tintAlpha = r.f32()
                let (v, vn) = readFan(&r)
                var p = Part(kind: 4, blend: blend, slot: newItem(color, box), box: box, cell: cell)
                if vn > 0 { p.tint = [Part(kind: 0, blend: blend, slot: newItem(SIMD4(color.x, color.y, color.z, tintAlpha), box), v: v, vn: vn, box: box)] }
                parts.append(p)
            }
        }
        if let old = els[h] { free(old) }
        els[h] = El(parts: parts)
    }

    private func free(_ e: El) {
        for p in e.parts { freePart(p) }
    }
    private func freePart(_ p: Part) {
        items.release(p.slot, 1)
        if p.vn > 0 { fan.release(p.v, p.vn) }
        if p.n > 0 { (p.kind == 2 ? stampsA : dotsA).release(p.inst, p.n) }
        p.tint.forEach(freePart)
    }
    private func remove(_ h: UInt32) {
        if let e = els.removeValue(forKey: h) { free(e) }
    }
    private func move(_ h: UInt32, _ dx: Float, _ dy: Float) {
        guard var e = els[h] else { return }
        e.off = SIMD2(dx, dy)
        els[h] = e
        let off = SIMD4<Float>(dx, dy, 0, 0)
        func put(_ p: Part) { withUnsafeBytes(of: off) { items.write(at: p.slot, $0, byteOffset: 48) }; p.tint.forEach(put) }
        e.parts.forEach(put)
    }

    private func readTex(_ r: inout Reader) {
        let id = r.u32(), w = Int(r.u32()), h = Int(r.u32()), layers = Int(r.u32()), mips = r.u32() != 0
        let d = MTLTextureDescriptor()
        d.pixelFormat = .rgba8Unorm
        d.width = w; d.height = h
        d.textureType = layers > 1 ? .type2DArray : .type2D
        d.arrayLength = layers
        d.mipmapLevelCount = mips ? Int(log2(Double(max(w, h)))) + 1 : 1
        d.usage = .shaderRead
        guard let tex = device.makeTexture(descriptor: d) else { _ = r.bytes(w * h * 4 * layers); return }
        for z in 0..<layers {
            let bytes = r.bytes(w * h * 4)
            tex.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, slice: z, withBytes: bytes.baseAddress!, bytesPerRow: w * 4, bytesPerImage: w * h * 4)
        }
        if mips, let cb = queue.makeCommandBuffer(), let blit = cb.makeBlitCommandEncoder() {
            blit.generateMipmaps(for: tex)
            blit.endEncoding()
            cb.commit()
        }
        textures[id] = tex
    }

    private func readTexSet(_ r: inout Reader) {
        let h = r.u32(), k = Int(r.u32()), id = r.u32(), hasRect = r.u32() != 0
        var rect: SIMD4<Float>?
        if hasRect { rect = SIMD4(r.f32(), r.f32(), r.f32(), r.f32()) }
        guard var e = els[h], k < e.parts.count else { return }
        e.parts[k].tex = id
        if let b = rect {
            e.parts[k].box = b
            withUnsafeBytes(of: b) { items.write(at: e.parts[k].slot, $0, byteOffset: 16) }
        }
        els[h] = e
    }

    private func readFrame(_ r: inout Reader) {
        _ = r.u32() // sequence
        let W = r.f32(), H = r.f32(), dpr = r.f32(), s = r.f32(), ox = r.f32(), oy = r.f32(), dim = r.f32()
        let paper = SIMD3<Float>(r.f32(), r.f32(), r.f32())
        let gk = r.u32(), gsp = r.f32(), gx = r.f32(), gy = r.f32(), gdark = r.u32() != 0, gt = r.f32()
        let nib = r.u32()
        let direct = r.u32() != 0
        var list: [UInt32] = []
        let n = Int(r.u32())
        list.reserveCapacity(n)
        for _ in 0..<n { list.append(r.u32()) }
        let nb = Int(r.u32())
        for _ in 0..<nb {
            let id = r.u32(), L = r.f32(), i = Int32(bitPattern: r.u32()), j = Int32(bitPattern: r.u32())
            let m = Int(r.u32())
            var hs: [UInt32] = []
            hs.reserveCapacity(m)
            for _ in 0..<m { hs.append(r.u32()) }
            builds.append((tile(id, L, i, j), hs))
        }
        let ns = Int(r.u32())
        var show: [UInt32] = []
        for _ in 0..<ns {
            let id = r.u32(), L = r.f32(), i = Int32(bitPattern: r.u32()), j = Int32(bitPattern: r.u32())
            _ = tile(id, L, i, j)
            show.append(id)
        }
        frame = Frame(W: W, H: H, dpr: dpr, s: s, ox: ox, oy: oy, dim: dim, paper: paper, gridKind: gk, gridSp: gsp, gridX: gx, gridY: gy, gridDark: gdark, gridT: gt, nibTex: nib, direct: direct, els: list, show: show)
    }

    private func tile(_ id: UInt32, _ L: Float, _ i: Int32, _ j: Int32) -> Tile {
        if let t = tiles[id] { return t }
        let T = Self.tileSize
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: T, height: T, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        let tex = device.makeTexture(descriptor: d)!
        let x = Float(i) * Float(T) / L, y = Float(j) * Float(T) / L, w = Float(T) / L
        let t = Tile(id: id, tex: tex, slot: newItem(SIMD4(0, 0, 0, 1), SIMD4(x, y, x + w, y + w)), L: L, i: i, j: j)
        tiles[id] = t
        return t
    }

    // MARK: drawing

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    private func globals(_ f: Frame, s: Float, ox: Float, oy: Float, W: Float, H: Float, dim: Float, grid: Bool) -> [SIMD4<Float>] {
        let gc: SIMD4<Float> = f.gridDark ? SIMD4(1, 1, 1, f.gridKind == 1 ? 0.14 : 0.07) : SIMD4(120 / 255, 105 / 255, 80 / 255, f.gridKind == 1 ? 0.18 : 0.1)
        return [
            SIMD4(s, ox, oy, dim),
            SIMD4(W, H, f.dpr, 0.75),
            SIMD4(f.gridSp * f.dpr, f.gridX * f.dpr, f.gridY * f.dpr, 2 * f.dpr),
            SIMD4(grid ? Float(f.gridKind) : 0, f.dpr, f.gridT, 0),
            gc,
        ]
    }

    func draw(in view: MTKView) {
        guard let f = frame, let cb = queue.makeCommandBuffer() else { return }
        let t0 = CACurrentMediaTime()
        cover.removeAll(keepingCapacity: true)
        // every part draws at most one cover-type instance: room for all, before encoding
        var bound = 8 + f.show.count
        for h in f.els { bound += els[h]?.parts.count ?? 0 }
        for (_, hs) in builds { for h in hs { bound += els[h]?.parts.count ?? 0 } }
        coverTurn = (coverTurn + 1) % 3
        if (coverBufs[coverTurn]?.length ?? 0) < bound * 4 {
            coverBufs[coverTurn] = device.makeBuffer(length: max(16384, bound * 8), options: .storageModeShared)
        }
        coverBuf = coverBufs[coverTurn]
        // far tiles first, each into its bitmap
        for (t, hs) in builds { encodeTile(cb, t, hs, f) }
        builds.removeAll()
        let size = view.drawableSize
        guard let rpd = view.currentRenderPassDescriptor, let drawable = view.currentDrawable else { return }
        rpd.colorAttachments[0].clearColor = MTLClearColor(red: Double(f.paper.x), green: Double(f.paper.y), blue: Double(f.paper.z), alpha: 1)
        rpd.colorAttachments[0].loadAction = .clear
        rpd.stencilAttachment.clearStencil = 0
        rpd.stencilAttachment.loadAction = .clear
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rpd) else { return }
        // (the page's device px; the drawable may lag a resize by a frame)
        let W = Float(size.width), H = Float(size.height)
        var g = globals(f, s: f.s, ox: f.ox, oy: f.oy, W: W, H: H, dim: f.dim, grid: true)
        enc.setVertexBytes(&g, length: 80, index: 3)
        enc.setFragmentBytes(&g, length: 80, index: 3)
        enc.setVertexBuffer(items.buf, offset: 0, index: 0)
        enc.setFragmentBuffer(items.buf, offset: 0, index: 0)
        if !f.direct {
            // far: the tiles (opaque: paper and ink), then the paper's marks over them
            enc.setRenderPipelineState(pipes["tex0"]!)
            enc.setDepthStencilState(stencils["keep"])
            enc.setVertexBuffer(coverBuf, offset: 0, index: 1)
            enc.setFragmentSamplerState(samplers["clamp"], index: 0)
            for id in f.show {
                guard let t = tiles[id] else { continue }
                enc.setFragmentTexture(t.tex, index: 0)
                enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: 1, baseInstance: pushCover(t.slot))
            }
            if f.gridKind != 0 {
                enc.setRenderPipelineState(pipes[f.gridDark ? "gridScreen" : "gridMultiply"]!)
                enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }
        } else {
            if f.gridKind != 0 {
                enc.setRenderPipelineState(pipes["grid"]!)
                enc.setDepthStencilState(stencils["keep"])
                enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }
            encode(enc, f.els, s: f.s, nib: f.nibTex)
        }
        enc.endEncoding()
        if let cbuf = coverBuf { cover.withUnsafeBytes { memcpy(cbuf.contents(), $0.baseAddress!, $0.count) } }
        if packets <= 3 { cb.addCompletedHandler { b in if let e = b.error { NSLog("[izine] metal: command buffer failed: \(e)") } } }
        if packets == 240, ProcessInfo.processInfo.arguments.contains("-izineMetalShot") {
            // debug: what Metal drew, saved to Documents (fetched with devicectl)
            let tex = drawable.texture
            cb.addCompletedHandler { _ in
                let w = tex.width, h = tex.height
                var bytes = [UInt8](repeating: 0, count: w * h * 4)
                tex.getBytes(&bytes, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
                let cs = CGColorSpaceCreateDeviceRGB()
                let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
                if let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: info.rawValue), let img = ctx.makeImage(),
                   let png = UIImage(cgImage: img).pngData() {
                    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("metal-shot.png")
                    try? png.write(to: url)
                    NSLog("[izine] metal shot saved")
                }
            }
        }
        cb.present(drawable)
        cb.commit()
        lastDrawMs = (CACurrentMediaTime() - t0) * 1000
    }

    private func encodeTile(_ cb: MTLCommandBuffer, _ t: Tile, _ hs: [UInt32], _ f: Frame) {
        let T = Self.tileSize
        if tileMSAA == nil {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: T, height: T, mipmapped: false)
            d.textureType = .type2DMultisample; d.sampleCount = 4; d.usage = .renderTarget; d.storageMode = .memoryless
            tileMSAA = device.makeTexture(descriptor: d)
            let s = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .stencil8, width: T, height: T, mipmapped: false)
            s.textureType = .type2DMultisample; s.sampleCount = 4; s.usage = .renderTarget; s.storageMode = .memoryless
            tileStencil = device.makeTexture(descriptor: s)
        }
        let rpd = MTLRenderPassDescriptor()
        rpd.colorAttachments[0].texture = tileMSAA
        rpd.colorAttachments[0].resolveTexture = t.tex
        rpd.colorAttachments[0].loadAction = .clear
        rpd.colorAttachments[0].storeAction = .multisampleResolve
        rpd.colorAttachments[0].clearColor = MTLClearColor(red: Double(f.paper.x), green: Double(f.paper.y), blue: Double(f.paper.z), alpha: 1)
        rpd.stencilAttachment.texture = tileStencil
        rpd.stencilAttachment.loadAction = .clear
        rpd.stencilAttachment.storeAction = .dontCare
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rpd) else { return }
        let L = t.L
        var g = globals(f, s: L, ox: -Float(t.i) * Float(T), oy: -Float(t.j) * Float(T), W: Float(T), H: Float(T), dim: 1, grid: false)
        enc.setVertexBytes(&g, length: 80, index: 3)
        enc.setFragmentBytes(&g, length: 80, index: 3)
        enc.setVertexBuffer(items.buf, offset: 0, index: 0)
        enc.setFragmentBuffer(items.buf, offset: 0, index: 0)
        encode(enc, hs, s: L, nib: f.nibTex)
        enc.endEncoding()
    }
    private func pushCover(_ slot: Int) -> Int {
        cover.append(UInt32(slot))
        return cover.count - 1
    }

    /// The elements, fills that don't overlap batched (their windings into the stencil, one cover for all).
    private func encode(_ enc: MTLRenderCommandEncoder, _ hs: [UInt32], s: Float, nib: UInt32) {
        var cur: MTLRenderPipelineState?
        var curDS: MTLDepthStencilState?
        func use(_ p: String, _ ds: String) {
            let ps = pipes[p]!
            if ps !== cur { enc.setRenderPipelineState(ps); cur = ps }
            let d = stencils[ds]!
            if d !== curDS { enc.setDepthStencilState(d); curDS = d }
        }
        var vb: MTLBuffer?
        func vbuf(_ b: MTLBuffer?) { if b !== vb { enc.setVertexBuffer(b, offset: 0, index: 1); vb = b } }
        var batch: [(Part, SIMD2<Float>)] = []
        var batchBlend = 0
        let pad = 2 / s
        func flush() {
            guard !batch.isEmpty else { return }
            use("fanStencil", "fan")
            vbuf(fan.buf)
            for (p, _) in batch { enc.drawPrimitives(type: .triangle, vertexStart: p.v, vertexCount: p.vn, instanceCount: 1, baseInstance: p.slot) }
            let first = cover.count
            for (p, _) in batch { cover.append(UInt32(p.slot)) }
            use("cover\(batchBlend)", "cover")
            vbuf(coverBuf)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: batch.count, baseInstance: first)
            batch.removeAll(keepingCapacity: true)
        }
        func overlaps(_ p: Part, _ o: SIMD2<Float>) -> Bool {
            let a = p.box
            for (q, qo) in batch {
                let b = q.box
                if a.x + o.x - pad < b.z + qo.x && a.z + o.x + pad > b.x + qo.x && a.y + o.y - pad < b.w + qo.y && a.w + o.y + pad > b.y + qo.y { return true }
            }
            return false
        }
        func addFan(_ p: Part, _ o: SIMD2<Float>) {
            if !batch.isEmpty && (p.blend != batchBlend || batch.count >= 256 || overlaps(p, o)) { flush() }
            batchBlend = p.blend
            batch.append((p, o))
        }
        for h in hs {
            guard let e = els[h] else { continue }
            for p in e.parts {
                switch p.kind {
                case 0: addFan(p, e.off)
                case 3 where p.r * s < 0.35: if let t = p.tint.first { addFan(t, e.off) } // (dots under a third of a pixel: their tint)
                case 4 where p.cell > 0 && p.cell * s < 0.6: if let t = p.tint.first { addFan(t, e.off) } // (pixel cells under half a pixel: theirs)
                case 1:
                    flush()
                    guard let tex = textures[p.tex] else { continue }
                    use("fanStencil", "fan")
                    vbuf(fan.buf)
                    enc.drawPrimitives(type: .triangle, vertexStart: p.v, vertexCount: p.vn, instanceCount: 1, baseInstance: p.slot)
                    use("pat\(p.blend)", "cover")
                    enc.setFragmentTexture(tex, index: 0)
                    enc.setFragmentSamplerState(samplers["repeat"], index: 0)
                    vbuf(coverBuf)
                    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: 1, baseInstance: pushCover(p.slot))
                case 2:
                    flush()
                    guard let nt = textures[nib] else { continue }
                    use("stamps", "keep")
                    enc.setFragmentTexture(nt, index: 0)
                    enc.setFragmentSamplerState(samplers["clamp"], index: 0)
                    vbuf(stampsA.buf)
                    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: p.n, baseInstance: p.inst)
                case 3:
                    flush()
                    use("dots\(p.blend)", "dots")
                    enc.setStencilReferenceValue(1)
                    vbuf(dotsA.buf)
                    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: p.n, baseInstance: p.inst)
                    use("stencilClear", "clear")
                    vbuf(coverBuf)
                    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: 1, baseInstance: pushCover(p.slot))
                    enc.setStencilReferenceValue(0)
                default:
                    flush()
                    guard let tex = textures[p.tex] else { continue }
                    use("tex\(p.blend)", "keep")
                    enc.setFragmentTexture(tex, index: 0)
                    // pixel cells: sharp while a cell is a pixel and a half or more, averaged below that
                    enc.setFragmentSamplerState(samplers[p.cell > 0 && p.cell * s >= 1.5 ? "nearest" : "clamp"], index: 0)
                    vbuf(coverBuf)
                    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: 1, baseInstance: pushCover(p.slot))
                }
            }
        }
        flush()
    }

    // MARK: pipelines

    private func makePipelines() throws {
        let lib = try device.makeLibrary(source: Self.shaders, options: nil)
        func pipe(_ name: String, _ vs: String, _ fs: String, blend: Int?, write: Bool = true) throws {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: vs)
            d.fragmentFunction = lib.makeFunction(name: fs)
            d.rasterSampleCount = 4
            d.stencilAttachmentPixelFormat = .stencil8
            let c = d.colorAttachments[0]!
            c.pixelFormat = .bgra8Unorm
            c.writeMask = write ? .all : []
            if let b = blend {
                c.isBlendingEnabled = true
                c.rgbBlendOperation = .add; c.alphaBlendOperation = .add
                c.sourceAlphaBlendFactor = .one; c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
                switch b {
                case 1: c.sourceRGBBlendFactor = .destinationColor; c.destinationRGBBlendFactor = .oneMinusSourceAlpha // multiply over the opaque paper
                case 2: c.sourceRGBBlendFactor = .one; c.destinationRGBBlendFactor = .oneMinusSourceColor // screen
                default: c.sourceRGBBlendFactor = .one; c.destinationRGBBlendFactor = .oneMinusSourceAlpha // over (premultiplied)
                }
            }
            pipes[name] = try device.makeRenderPipelineState(descriptor: d)
        }
        try pipe("fanStencil", "vs_fan", "fs_none", blend: nil, write: false)
        try pipe("stencilClear", "vs_cover", "fs_none", blend: nil, write: false)
        for b in 0..<3 {
            try pipe("cover\(b)", "vs_cover", "fs_solid", blend: b)
            try pipe("pat\(b)", "vs_cover", "fs_pat", blend: b)
            try pipe("dots\(b)", "vs_dot", "fs_dot", blend: b)
            try pipe("tex\(b)", "vs_tex", "fs_tex", blend: b)
        }
        try pipe("stamps", "vs_stamp", "fs_stamp", blend: 0)
        try pipe("grid", "vs_full", "fs_grid", blend: 0)
        try pipe("gridMultiply", "vs_full", "fs_grid", blend: 1)
        try pipe("gridScreen", "vs_full", "fs_grid", blend: 2)
        func ds(_ name: String, _ compare: MTLCompareFunction, _ pass: MTLStencilOperation, back: MTLStencilOperation? = nil) {
            let d = MTLDepthStencilDescriptor()
            let f = MTLStencilDescriptor(); f.stencilCompareFunction = compare; f.depthStencilPassOperation = pass; f.stencilFailureOperation = .keep
            let k = MTLStencilDescriptor(); k.stencilCompareFunction = compare; k.depthStencilPassOperation = back ?? pass; k.stencilFailureOperation = .keep
            d.frontFaceStencil = f; d.backFaceStencil = k
            stencils[name] = device.makeDepthStencilState(descriptor: d)
        }
        ds("fan", .always, .incrementWrap, back: .decrementWrap)
        ds("cover", .notEqual, .zero)
        ds("dots", .notEqual, .replace)
        ds("clear", .always, .zero)
        ds("keep", .always, .keep)
        func sm(_ name: String, _ filter: MTLSamplerMinMagFilter, _ mip: MTLSamplerMipFilter, _ address: MTLSamplerAddressMode) {
            let d = MTLSamplerDescriptor()
            d.minFilter = filter; d.magFilter = filter; d.mipFilter = mip
            d.sAddressMode = address; d.tAddressMode = address
            samplers[name] = device.makeSamplerState(descriptor: d)
        }
        sm("repeat", .linear, .linear, .repeat)
        sm("clamp", .linear, .linear, .clampToEdge)
        sm("nearest", .nearest, .nearest, .clampToEdge)
    }

    // the same shaders as src/webgpu.ts, in MSL
    static let shaders = """
    #include <metal_stdlib>
    using namespace metal;
    struct G { float4 view; float4 size; float4 grid; float4 gridKind; float4 gridColor; };
    struct Item { float4 color; float4 bbox; float4 p; float4 off; };
    static float4 toClip(float2 w, constant G& g, device const Item& it) {
      float2 d = (w + it.off.xy) * g.view.x + g.view.yz;
      return float4(d.x / g.size.x * 2.0 - 1.0, 1.0 - d.y / g.size.y * 2.0, 0.0, 1.0);
    }
    static float4 premul(device const Item& it, constant G& g, float a) { float k = it.color.a * g.view.w * a; return float4(it.color.rgb * k, k); }
    static float2 corner(uint i) { return float2(float(i & 1u), float(i >> 1u)); }

    struct FanOut { float4 pos [[position]]; };
    vertex FanOut vs_fan(uint vid [[vertex_id]], uint iid [[instance_id]], device const float2* fan [[buffer(1)]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      FanOut o; o.pos = toClip(fan[vid], g, items[iid]); return o;
    }
    fragment float4 fs_none() { return float4(0.0); }

    struct CoverOut { float4 pos [[position]]; float2 world; uint idx [[flat]]; };
    vertex CoverOut vs_cover(uint vid [[vertex_id]], uint iid [[instance_id]], device const uint* cover [[buffer(1)]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      uint idx = cover[iid];
      device const Item& it = items[idx];
      float pad = 1.0 / g.view.x;
      float2 w = mix(it.bbox.xy - pad, it.bbox.zw + pad, corner(vid));
      CoverOut o; o.pos = toClip(w, g, it); o.world = w; o.idx = idx; return o;
    }
    fragment float4 fs_solid(CoverOut in [[stage_in]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) { return premul(items[in.idx], g, 1.0); }
    fragment float4 fs_pat(CoverOut in [[stage_in]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]], texture2d<float> tex [[texture(0)]], sampler sm [[sampler(0)]]) {
      device const Item& it = items[in.idx];
      float2 w = in.world;
      float2 uv = float2(w.x * it.p.x + w.y * it.p.y, -w.x * it.p.y + w.y * it.p.x) * it.p.z;
      return premul(it, g, tex.sample(sm, uv).a);
    }

    struct TOut { float4 pos [[position]]; float2 uv; uint idx [[flat]]; };
    vertex TOut vs_tex(uint vid [[vertex_id]], uint iid [[instance_id]], device const uint* cover [[buffer(1)]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      uint idx = cover[iid];
      device const Item& it = items[idx];
      float2 c = corner(vid);
      TOut o; o.pos = toClip(mix(it.bbox.xy, it.bbox.zw, c), g, it); o.uv = c; o.idx = idx; return o;
    }
    fragment float4 fs_tex(TOut in [[stage_in]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]], texture2d<float> tex [[texture(0)]], sampler sm [[sampler(0)]]) {
      return tex.sample(sm, in.uv) * (items[in.idx].color.a * g.view.w);
    }

    struct DOut { float4 pos [[position]]; float2 local [[sample_perspective]]; uint idx [[flat]]; };
    vertex DOut vs_dot(uint vid [[vertex_id]], uint iid [[instance_id]], device const float* dots [[buffer(1)]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      uint b = iid * 3u;
      uint idx = as_type<uint>(dots[b + 2u]);
      device const Item& it = items[idx];
      float ext = it.p.x + 1.5 / g.view.x;
      float2 k = corner(vid) * 2.0 - 1.0;
      DOut o; o.pos = toClip(float2(dots[b], dots[b + 1u]) + k * ext, g, it); o.local = k * ext; o.idx = idx; return o;
    }
    fragment float4 fs_dot(DOut in [[stage_in]], uint sid [[sample_id]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      device const Item& it = items[in.idx];
      if (dot(in.local, in.local) > it.p.x * it.p.x) discard_fragment();
      return premul(it, g, 1.0);
    }

    struct SOut { float4 pos [[position]]; float2 uv; uint layer [[flat]]; float a; uint idx [[flat]]; };
    vertex SOut vs_stamp(uint vid [[vertex_id]], uint iid [[instance_id]], device const float* st [[buffer(1)]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]]) {
      uint b = iid * 7u;
      uint idx = as_type<uint>(st[b + 6u]);
      device const Item& it = items[idx];
      float2 k = corner(vid) * 2.0 - 1.0;
      float r = st[b + 2u];
      float a = st[b + 4u];
      float rpx = r * g.view.x;
      if (rpx < g.size.w) { a = a * (rpx / g.size.w) * (rpx / g.size.w); r = g.size.w / g.view.x; }
      float c = cos(st[b + 3u]), sn = sin(st[b + 3u]);
      float2 l = k * r;
      SOut o;
      o.pos = toClip(float2(st[b], st[b + 1u]) + float2(c * l.x - sn * l.y, sn * l.x + c * l.y), g, it);
      o.uv = k * 0.5 + 0.5; o.layer = uint(st[b + 5u]); o.a = a; o.idx = idx;
      return o;
    }
    fragment float4 fs_stamp(SOut in [[stage_in]], device const Item* items [[buffer(0)]], constant G& g [[buffer(3)]], texture2d_array<float> nibs [[texture(0)]], sampler sm [[sampler(0)]]) {
      return premul(items[in.idx], g, nibs.sample(sm, in.uv, in.layer).a * in.a);
    }

    struct FullOut { float4 pos [[position]]; };
    vertex FullOut vs_full(uint vid [[vertex_id]]) {
      float2 p = float2(float((vid << 1u) & 2u), float(vid & 2u));
      FullOut o; o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0); return o;
    }
    // two levels: the coarse marks (2·sp) always, the in-between ones (sp) at t
    static float gridCov(float2 q, float sp, constant G& g) {
      float2 f = q - round(q / sp) * sp;
      if (g.gridKind.x == 1.0) {
        float m = g.grid.w;
        float2 ov = clamp(float2(m * 0.5 + 0.5) - abs(f), float2(0.0), float2(min(m, 1.0)));
        return ov.x * ov.y;
      }
      float lw = g.gridKind.y;
      float h = clamp(lw * 0.5 + 0.5 - abs(f.y), 0.0, min(lw, 1.0));
      float v = 0.0;
      if (g.gridKind.x == 3.0) { v = clamp(lw * 0.5 + 0.5 - abs(f.x), 0.0, min(lw, 1.0)); }
      return max(h, v);
    }
    fragment float4 fs_grid(FullOut in [[stage_in]], constant G& g [[buffer(3)]]) {
      float2 q = in.pos.xy - g.grid.yz;
      float cov = max(gridCov(q, 2.0 * g.grid.x, g), g.gridKind.z * gridCov(q, g.grid.x, g));
      float a = g.gridColor.a * cov;
      return float4(g.gridColor.rgb * a, a);
    }
    """
}

/// A first-fit allocator over a growable shared Metal buffer.
final class Arena {
    private let device: MTLDevice
    let unit: Int
    private(set) var buf: MTLBuffer
    private(set) var cap: Int
    private var free: [(Int, Int)]
    private(set) var used = 0
    init(_ device: MTLDevice, unit: Int, cap: Int) {
        self.device = device; self.unit = unit; self.cap = cap
        buf = device.makeBuffer(length: cap * unit, options: .storageModeShared)!
        free = [(0, cap)]
    }
    func alloc(_ n: Int) -> Int {
        guard n > 0 else { return 0 }
        for k in 0..<free.count where free[k].1 >= n {
            let (s, l) = free[k]
            if l == n { free.remove(at: k) } else { free[k] = (s + n, l - n) }
            used += n
            return s
        }
        // grow (at least double), keeping what's there (the old buffer lives on while frames in flight use it)
        var c = cap * 2
        while c - cap < n { c *= 2 }
        let nb = device.makeBuffer(length: c * unit, options: .storageModeShared)!
        memcpy(nb.contents(), buf.contents(), cap * unit)
        let old = cap
        buf = nb; cap = c
        release(old, c - old, counted: false)
        return alloc(n)
    }
    func release(_ s: Int, _ n: Int, counted: Bool = true) {
        guard n > 0 else { return }
        if counted { used -= n }
        var k = 0
        while k < free.count && free[k].0 < s { k += 1 }
        free.insert((s, n), at: k)
        if k + 1 < free.count && free[k].0 + free[k].1 == free[k + 1].0 { free[k].1 += free[k + 1].1; free.remove(at: k + 1) }
        if k > 0 && free[k - 1].0 + free[k - 1].1 == free[k].0 { free[k - 1].1 += free[k].1; free.remove(at: k) }
    }
    func write(at i: Int, _ bytes: UnsafeRawBufferPointer, byteOffset: Int = 0) {
        memcpy(buf.contents() + i * unit + byteOffset, bytes.baseAddress!, bytes.count)
    }
}

/// Little-endian reader over a packet.
struct Reader {
    let raw: UnsafeRawBufferPointer
    var at = 0
    init(_ raw: UnsafeRawBufferPointer) { self.raw = raw }
    var left: Int { raw.count - at }
    mutating func u32() -> UInt32 { let v = raw.loadUnaligned(fromByteOffset: at, as: UInt32.self); at += 4; return UInt32(littleEndian: v) }
    mutating func f32() -> Float { Float(bitPattern: u32()) }
    /// `n` bytes (padded to 4 in the packet)
    mutating func bytes(_ n: Int) -> UnsafeRawBufferPointer {
        let out = UnsafeRawBufferPointer(rebasing: raw[at..<(at + n)])
        at += (n + 3) & ~3
        return out
    }
}
