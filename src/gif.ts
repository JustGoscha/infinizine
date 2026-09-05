// Animated GIF encoder (GIF89a, LZW), dependency-free. Frames share one global
// palette of up to 256 colours built from the most common colours of every frame
// (a zine has few colours; ink over paper quantises cleanly).

export interface GifFrame { data: Uint8ClampedArray; delayMs: number }

/** Build a ≤256-colour palette: the most frequent colours (at 5 bits per channel),
 * then exact averages within each bucket. */
function buildPalette(frames: GifFrame[]): { palette: Uint8Array; lookup: Map<number, number> } {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      const b = buckets.get(key);
      if (b) { b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; }
      else buckets.set(key, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] });
    }
  }
  const top = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 256);
  const palette = new Uint8Array(256 * 3);
  const lookup = new Map<number, number>();
  top.forEach(([key, b], i) => {
    palette[i * 3] = Math.round(b.r / b.n);
    palette[i * 3 + 1] = Math.round(b.g / b.n);
    palette[i * 3 + 2] = Math.round(b.b / b.n);
    lookup.set(key, i);
  });
  // colours that didn't make the cut map to the nearest palette entry
  const n = top.length;
  for (const key of buckets.keys()) {
    if (lookup.has(key)) continue;
    const r = ((key >> 10) & 31) << 3, g = ((key >> 5) & 31) << 3, b = (key & 31) << 3;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) { bestD = dist; best = i; }
    }
    lookup.set(key, best);
  }
  return { palette, lookup };
}

/** LZW-compress 8-bit indices into GIF sub-blocks. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const out: number[] = [];
  let cur = 0, curBits = 0;
  const emit = (code: number, size: number) => {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) { out.push(cur & 255); cur >>>= 8; curBits -= 8; }
  };
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let dict = new Map<number, number>();
  let next = eoi + 1, size = minCodeSize + 1;
  emit(clear, size);
  let prefix = -1;
  for (const k of indices) {
    if (prefix < 0) { prefix = k; continue; }
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear, size);
      dict = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix, size);
  emit(eoi, size);
  if (curBits > 0) out.push(cur & 255);
  // sub-blocks of ≤255 bytes
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n, ...out.slice(i, i + n));
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export function makeGif(width: number, height: number, frames: GifFrame[]): Blob {
  const { palette, lookup } = buildPalette(frames);
  const parts: Uint8Array[] = [];
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height), 0xf7, 0, 0])); // GIF89a, 256-colour GCT
  parts.push(palette);
  // NETSCAPE loop forever
  parts.push(Uint8Array.from([0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, 0, 0, 0]));
  for (const f of frames) {
    const delay = Math.max(2, Math.round(f.delayMs / 10)); // centiseconds; browsers clamp anything under 2
    parts.push(Uint8Array.from([0x21, 0xf9, 4, 0, ...u16(delay), 0, 0])); // graphic control: no disposal, no transparency
    parts.push(Uint8Array.from([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, 8])); // image descriptor, LZW min code size 8
    const idx = new Uint8Array(width * height);
    const d = f.data;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      idx[p] = lookup.get(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)) ?? 0;
    }
    parts.push(lzw(idx, 8));
  }
  parts.push(Uint8Array.from([0x3b]));
  return new Blob(parts as BlobPart[], { type: 'image/gif' });
}
