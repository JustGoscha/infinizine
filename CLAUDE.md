# InfiniZine

Infinite-canvas writing/zine app. Product decisions live in SPEC.md — read it before making product-level changes.

## Conventions

- Prefer **bun** over npm/node for everything: `bun install`, `bun run dev`, `bunx tsc --noEmit`.
- Type-check with `bunx tsc --noEmit` after changes; there are no tests yet.
- Vanilla TypeScript + Vite, no framework. Keep it dependency-light (perfect-freehand is the only runtime dep).
- Document model: elements store raw input samples; SVG/outlines are derived at render time. Every element has a stable id (future keyframe animation depends on this).
- No Claude attribution in commits.

## Module map (src/, flat on purpose)

- **Document**: `types.ts` (model, FORMAT_VERSION) · `store.ts` (undo/redo ops, IndexedDB, migrations) · `formats.ts` (page presets) · `export.ts` + `gif.ts` + `pdf.ts` + `zip.ts`.
- **Ink**: `geometry.ts` (denoise, blob closure, bboxes, hit tests) · `outline.ts` (samples → filled polygons, marker, pencil, live outliner) · `pressure.ts` (per-tool curves, brush settings) · `patterns.ts` (screentones, dithers).
- **Input**: `input.ts` (canvas pointer state machine: start/move/endAction) · `state.ts` (InputState, tool memory, prefs) · `handles.ts` (grabber rects) · `hover.ts` (mouse hover) · `clipboard.ts` · `dice.ts` (typeface roll).
- **Render**: `render.ts` (frame loop, static layers, areas, frozen-area bake) · `clock.ts` (shared animation clock, paused while inking) · `camera.ts`.
- **UI**: `ui.ts` (toolbar, palette, pages, settings, library, presenting) · `icons.ts` (icons, tool catalogue, cursors) · `pointer-ui.ts` (press-drag, pen taps, sliders) · `toolsample.ts` · `timeline.ts` (animation panel) · `playground.ts` (brush settings modal) · `feedback.ts` (toast, tip) · `style.css`.
- **Text**: `text.ts` (layout, roles, faces) · `richedit.ts` (markdown ↔ HTML) · `fonts.ts` · `facepool.ts` + `facepool-data.ts`.

## Versioning

- `package.json` version is the app version (shown in settings, stamped into every saved zine as `doc.app`).
- **Every commit that touches app code must bump it** — a pre-commit hook (`.githooks/pre-commit`, enabled via `postinstall`) refuses otherwise.
  - `bun run bump patch` — fixes, tuning, tweaks
  - `bun run bump minor` — new features / tools / settings
  - `bun run bump major` — breaking zine-format change; also bump `FORMAT_VERSION` in `src/types.ts` and add a migration step in `migrateDoc` (store.ts)
- `FORMAT_VERSION` is the zine *file* format; older files migrate on load, newer ones are refused with a message.
