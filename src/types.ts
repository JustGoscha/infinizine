// InfiniCanvas document model (see SPEC.md).
// Strokes store raw input samples; outlines are generated at render/export time.
// Every element has a stable id + transform-ready fields so keyframe timelines
// can reference them later without a migration.

export interface StrokePoint {
  x: number; // world coords
  y: number;
  p: number; // pressure 0..1 (0.5 if the device reported none)
  t: number; // seconds since stroke start
  a?: number; // tilt 0..1 (0 = upright, 1 = flat on the glass); undefined = unknown
  r?: number; // azimuth (lean direction) in radians, screen plane; undefined = unknown
}

export type ToolKind = 'pen' | 'pencil' | 'sketch' | 'fineliner' | 'marker';

export type Layer = 'back' | 'front';

// Frame-by-frame animation area (RoughAnimator-style)
export interface AnimFrame {
  id: string;
  duration: number; // in frame-ticks (1 = one 1/fps step)
}

export interface AnimLayer {
  id: string;
  name: string;
  hidden?: boolean; // hidden layers don't render (eye toggle)
  kind?: 'frames' | 'live'; // live layers hold timed live-ink strokes, no frames
  liveMode?: 'additive' | 'continuous'; // legacy, unused
  loop?: boolean; // live layers: loop immediately on their own cycle (default) or play once on the pipeline
  frames: AnimFrame[]; // each layer has its own frame track (empty for live layers)
}

export interface AnimArea {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  fps: number;
  loop: boolean;
  clip?: boolean; // cut off frame ink outside the area rect
  hideFrames?: boolean; // hide all keyframe layers (group eye)
  hideLive?: boolean; // hide all live-ink layers (group eye)
  layers: AnimLayer[]; // index 0 = bottom
}

export interface Stroke {
  id: string;
  kind: 'stroke';
  tool: ToolKind;
  color: string;
  baseWidth: number; // world units at zoom 1
  opacity: number;
  layer?: Layer; // paint behind / in front toggle; undefined = front
  frame?: string; // animation frame id (element only shows on that frame)
  alayer?: string; // animation layer id within its area
  // timed "live ink": drawn while an area was playing, keyed to the loop clock
  area?: string; // owning anim area (timed strokes have no frame)
  animStart?: number; // tick (within the area's loop) when the stroke appears
  animLife?: number; // how many ticks it stays visible
  animTaper?: boolean; // tail eats away toward the stroke's start over its life
  points: StrokePoint[];
  startTime: number; // epoch seconds, for future replay/timelines
}

export interface FillShape {
  id: string;
  kind: 'fill';
  color: string;
  opacity: number;
  layer?: Layer;
  frame?: string;
  alayer?: string;
  pattern?: string; // fill pattern id (see patterns.ts) drawn in `color` — manga tones, dithers
  patternAngle?: number; // rotation of the pattern in degrees (randomised per fill; rotate from the selection menu)
  ink?: number; // ink coverage 0..1 for pattern fills (CMYK-like: <1 lets paper through, overlaps mix and darken)
  points: { x: number; y: number }[]; // closed polygon, world coords
}

export interface TextBox {
  id: string;
  kind: 'text';
  x: number; // world coords of top-left
  y: number;
  w: number; // measured extents (kept up to date on edit)
  h: number;
  color: string;
  fontSize: number; // world units
  font?: string; // typeface key (see text.ts FONTS); default 'franklin'
  text: string; // markdown: # headings, - bullets, **bold**, *italic*
  auto?: boolean; // width follows the content (tap-created box) until the user resizes it
  layer?: Layer;
  frame?: string;
  alayer?: string;
}

export interface ImageBox {
  id: string;
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string; // data URL — keeps documents self-contained
  layer?: Layer;
  frame?: string;
  alayer?: string;
}

export type Element = Stroke | FillShape | TextBox | ImageBox;

export interface Page {
  id: string;
  x: number; // world coords of top-left
  y: number;
  w: number;
  h: number;
  name: string;
  order: number; // manual order; seeded spatially
  format?: string; // the preset it was created as ("A4", "Screen 16:9", …); derived from size when absent
}

export interface Doc {
  version: number; // zine FORMAT version (see FORMAT_VERSION); bumped only when the schema changes
  app?: string; // InfiniZine app version that last saved it (informational)
  savedAt?: number; // epoch ms of the last save
  name: string;
  palette: string; // active palette preset id
  paper?: string; // canvas/paper background color (default warm cream)
  pattern?: 'blank' | 'dots' | 'grid' | 'lines'; // paper pattern (default dots)
  faces?: Record<string, string>; // per-zine typeface picks by role (overrides the app-wide defaults)
  elements: Element[];
  pages: Page[];
  areas: AnimArea[];
}

/** Zine file format version. History:
 *  1 — original (strokes/fills/text/images, pages, areas; many optional fields
 *      were added compatibly over time: layers, live ink, tilt/azimuth, text.auto).
 *  2 — explicit format/app stamps; inline text spans {role|…}/{w600|…}/__u__.
 * Loading an OLDER version runs the migration chain in store.ts; a NEWER one is
 * refused with a message rather than silently mangled. */
export const FORMAT_VERSION = 2;

// World units are ~2 per mm (A4 → 420×594)
export const UNITS_PER_MM = 2;

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function emptyDoc(): Doc {
  return { version: FORMAT_VERSION, name: 'Untitled', palette: 'ink', elements: [], pages: [], areas: [] };
}
