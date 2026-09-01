# InfiniCanvas — Product Spec (v1)

Name: InfiniZine.

## Identity

**The writer's desk.** Pages are the manuscript (journal, zine, book); the infinite canvas around them holds the mess — research, sketches, notes. Presentation/export lifts the pages out of the mess. One product serving journaler, zine-maker, and old-school book writer.

## Platform & stack

- **Prototype: web-first.** One TypeScript engine (Vite) that runs in the browser and on the iPad (simulator Safari / thin wrapper). The draw engine can be taken native (Swift/Metal, predicted touches, Pencil APIs) later without changing the document format.
- **Web render engine** is therefore the same codebase: renders the document format in any browser (perfect-freehand outline algorithm for stroke geometry).
- No backend for v1.

## Document format

- Self-contained package (zip): `document.json` + embedded media files. Non-proprietary, web-renderable.
- Strokes stored as raw input samples: `{x, y, pressure, t}` per point. Outlines generated at render/export time.
- Every element (stroke, image, shape, text, video) has a stable ID and animatable properties (transform, opacity) — reserved for future keyframe timelines.
- Coordinates: doubles; canvas effectively infinite in x/y.

## Canvas & pages

- Infinite canvas; zoom 1%–500%; viewport culling (only render what's visible at meaningful size).
- **Ink belongs to the canvas.** Pages are frames/viewports laid over it. Painting across borders is allowed; export clips to the frame.
- New page via a round "+" affordance; created with padding next to the previous page; movable by touch. (Later: second grabber that moves frame + contents together.)
- Page formats: A4, square, custom W×H, etc.
- Page order: spatial (top-to-bottom) by default, manually reorderable; order used by presentation mode and export.

## Tools (deliberately limited)

- **Fineliner** — fixed width, no pressure.
- **Pressure pen** — pressure-sensitive width via perfect-freehand: tapering, smoothing, and outlier-pressure filtering (Doodely's `pUncertain` interpolation approach).
- **Marker** — flat, semi-transparent.
- **Lasso fill** — draw a region, it becomes a filled shape.
- **Eraser** — whole-stroke deletion only.
- **Lasso select** — selects whole strokes with any point inside; move selection by touch.
- Palm rejection; pan/zoom with fingers.

## Color

- Palette-first: limited per-document palette, default 8 hues × gradations.
- Preset palette themes (pastel, vibrant, autumn, …); adjustable per document; extra colors addable via a general picker in palette settings.

## Content types (v1)

Ink, marker, lasso-fill shapes, droppable images, videos, typed text (Figma/Excalidraw-style textboxes). No embedded links in v1.

## Transcription

On-demand only: "convert page to text" button per page (on-device Vision handwriting recognition). Surfaced primarily in export options. No always-on recognition.

## Export & presentation

- Presentation mode: page-by-page viewing in-app.
- Export: SVG per page (variable-width strokes as path fills); web bundle = document JSON + JS viewer. Video/animation content is web-export-only.
- Handwriting-to-text as an export option.

## Deferred (data model must not block)

- Keyframe timeline animation for regions/areas (not just stroke replay).
- Pixel-style eraser (stroke splitting).
- Frame-with-contents grabber.
- Embedded links.
- iPhone/Mac.

## Prior art to reuse

- `../temporal-strokes` (Doodely): point format `{x,y,p,t}`, polygon renderer, pressure-uncertainty interpolation, palm rejection, undo/redo history manager, coalesced events, smoothing.
- tldraw (reference only): culling, spatial indexing, zoom-level rendering.

## Publishing

Fastlane via GitHub Action, manually triggerable. Keep it as simple as possible.
