// The draw flyout's previews: a sample line per tool in its own colour, pattern and size.

import { baseZoom } from './camera';
import { patternTile, patternTileSize } from './patterns';
import { strokeOutline, markerPaths, outlineToPath } from './outline';
import { closeBlob } from './geometry';
import { FILL_TOOLS, type Tool } from './state';
import type { Stroke, StrokePoint } from './types';

/** A sample line as the tool would draw it right now: its colour (or pattern) at the current
 * size, with pressure and tilt varying along the way. Fill tools show a filled loop. */
export function paintToolSample(cv: HTMLCanvasElement, tool: Tool, style: { color: string; baseWidth: number; pattern: string | null }) {
  const W = 96, H = 30, dpr = window.devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const k = baseZoom(); // screen px per world unit at 100%: the sample is drawn at true size
  g.save();
  g.scale(k, k);
  let fill: string | CanvasPattern = style.color;
  if (style.pattern) {
    const T = patternTileSize(style.pattern);
    const tile = patternTile(style.pattern, style.color, Math.round(T * k * dpr));
    const pat = g.createPattern(tile, 'repeat');
    if (pat) { pat.setTransform(new DOMMatrix().scale(1 / (k * dpr))); fill = pat; }
  }
  g.fillStyle = fill;
  if (FILL_TOOLS.has(tool)) {
    // a loop drawn with the pen lifting early: the hard cut closes straight, the blob rounds off
    const loop: { x: number; y: number }[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = (i / 14) * Math.PI * 1.55 + Math.PI * 0.35;
      loop.push({ x: (W / 2 + Math.cos(t) * 30) / k, y: (H / 2 - Math.sin(t) * 9) / k });
    }
    const pts = tool === 'lasso-blob' ? closeBlob(loop) : loop;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
    g.restore();
    return;
  }
  const points: StrokePoint[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = (6 + u * (W - 12)) / k;
    const y = (H / 2 + Math.sin(u * Math.PI * 2.2) * 6) / k;
    const p = 0.22 + 0.7 * Math.sin(u * Math.PI) ** 1.3; // light → hard → light
    points.push({ x, y, p, t: u, a: 0.2 + 0.6 * u, r: 0 });
  }
  const s: Stroke = {
    id: 'sample', kind: 'stroke', tool: tool === 'fineliner' ? 'fineliner' : tool === 'marker' ? 'marker' : tool === 'pencil' ? 'pencil' : 'pen',
    color: style.color, baseWidth: style.baseWidth / (tool === 'fineliner' ? 1.4 : 1), opacity: 1, points, startTime: 0,
  };
  g.globalAlpha = tool === 'marker' ? 0.45 : tool === 'pencil' ? 0.8 : 1;
  if (tool === 'marker') g.fill(markerPaths(points, s.baseWidth, 1).fill);
  else g.fill(outlineToPath(strokeOutline(s, 1)));
  g.restore();
}

