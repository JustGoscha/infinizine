# InfiniZine

Infinite-canvas writing/zine app. Product decisions live in SPEC.md — read it before making product-level changes.

## Conventions

- Prefer **bun** over npm/node for everything: `bun install`, `bun run dev`, `bunx tsc --noEmit`.
- Type-check with `bunx tsc --noEmit` after changes; there are no tests yet.
- Vanilla TypeScript + Vite, no framework. Keep it dependency-light (perfect-freehand is the only runtime dep).
- Document model: elements store raw input samples; SVG/outlines are derived at render time. Every element has a stable id (future keyframe animation depends on this).
- No Claude attribution in commits.
