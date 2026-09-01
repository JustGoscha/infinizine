# InfiniZine

An infinite canvas for writing and human creativity — journals, zines, comics, books.

Pages are the manuscript; the endless canvas around them holds the mess: sketches, research, notes. Presentation mode lifts the pages out of the mess and shows them one by one.

## Features

- Vector ink: pressure pen, fineliner, marker — smooth, zoomable strokes
- Limited, per-document color palettes (with light→dark shades per color)
- Pages as thin frames: any format, snapping, reorderable, presentable
- Markdown textboxes: live WYSIWYG, 5 typefaces, resizable
- Frame-by-frame animation areas: per-layer timelines, onion skinning, fps/loop/clip
- Paint behind/in front, lasso fill, whole-stroke eraser
- Everything undoable, autosaved locally

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173 — works in the browser and on iPad (Apple Pencil supported).

## Stack

Vite + TypeScript, HTML canvas, [perfect-freehand](https://github.com/steveruizok/perfect-freehand) for stroke geometry. No backend; documents live in localStorage for now.
