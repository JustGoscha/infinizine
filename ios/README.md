# InfiniZine for iPad

A native iPad app around the same web app: same TypeScript code (built into the app),
same `.zine` format, same IndexedDB library. A zine exported from the app opens on the
web and vice versa. What the app adds:

- **Full-precision Pencil**: `PencilCapture` sees every touch event at the window
  (`PencilWindow.sendEvent`): sub-pixel `preciseLocation`, every coalesced sample
  (240 Hz) and UIKit's predicted touches. `src/native.ts` replays them on the canvas as
  pen PointerEvents, so `input.ts` treats them like any pen; the web view's own (on
  iPadOS < 26.2 whole-pixel, ~120 Hz) pen events on the canvas are dropped.
- **Latency hiding**: `InkOverlay` draws the newest piece of the live stroke (plus the
  prediction) straight from UIKit, until the page reports it has painted it (pen and
  fineliner; translucent ink would show the overlap).
- **Full frame rate**: the page renders at the display's rate (120 Hz on ProMotion)
  instead of Safari's default ~60 fps cap (a WebKit feature flag, set only if present).
- **Files**: exports go to the share sheet and the app's Documents (Files → On My iPad →
  InfiniZine); `.zine` files open into the library from Files / the share sheet.

Runs on iPadOS 16+ — every iPad Pro with a Pencil, back to the 2015 12.9" and 2016 9.7"
(on 60 Hz screens the frame-rate switch simply has nothing to do).

## Build

```sh
brew install xcodegen      # once
bun run ios                # builds the web app into ios/InfiniZine/web and generates the Xcode project
open ios/InfiniZine.xcodeproj
```

Xcode's build also rebuilds the web app (a pre-build script runs `bun run build:app`).
For a real iPad, pick your team under Signing & Capabilities (a free Apple ID works for
your own devices).

## Simulator

The simulator can't produce Pencil input, so there are two stand-ins:

```sh
ios/scripts/run.sh -izineMousePencil   # draw with the mouse: drags go through the real UIKit → PencilCapture path
ios/scripts/bench.sh                   # scripted Pencil benchmark, native vs web (see below)
SIM=<udid> ios/scripts/bench.sh        # on a specific simulator (e.g. an iPad Pro 1st gen on iOS 16.4)
```

`xcodebuild test` runs `InfiniZineUITests`, which drags with real simulator touches and
checks they become full-precision strokes.

### The benchmark

`PencilSimulator` (debug builds, `-izineTest native|web`) plays the same strokes — a slow
shallow line, a slow diagonal, a curve, small loops, a fast flick — through
`PencilCapture.deliver`, the way UIKit delivers a Pencil on a ProMotion iPad Pro: an
event every 1/120 s carrying the coalesced 240 Hz samples (with ~0.1 px noise) and a
predicted continuation. Mode `web` degrades them to what Safari < 26.2 hands a page: one
sample per event, rounded to whole pixels, no prediction, rendering capped near 60 fps,
no overlay. The page (`src/pentest.ts`) measures

- **error**: RMS distance of the committed stroke from the true path (CSS px)
- **lag**: at every painted frame, how far (in ms along the path) the drawn tip trails
  the pen; negative = the prediction runs ahead

and `PencilSimulator` measures the overlay's lag the same way. Lag is measured where each
layer is produced (the page's frame, the overlay's display-link tick), so it leaves out
the compositor — which costs the page's frames at least as much as the overlay's.

Other launch arguments: `-izineLogStrokes` (log every pen batch and committed stroke),
`-izineImport <file>` (import a .zine at launch), `-izineExport` (export the open zine
through the normal download path), `-izineSummary`, `-izineNoOverlay`, `-izine60`.
