#!/bin/bash
# Scripted-Pencil benchmark in the simulator: the same strokes, once through the app's
# native Pencil path and once degraded to what Safari < 26.2 hands a page.
# Prints precision (RMS distance to the true path, px) and lag (ms the drawn tip trails the pen).
cd "$(dirname "$0")/.."
LOG=$(mktemp)
for MODE in native web; do
  ./scripts/run.sh -izineTest $MODE > "$LOG" 2>&1 &
  for i in $(seq 1 240); do sleep 1; grep -aq "bench written" "$LOG" && break; done
  F=$(grep -ao "bench written: .*" "$LOG" | sed 's/bench written: //' | tr -d '\r')
  kill %1 2>/dev/null; wait 2>/dev/null
  python3 - "$F" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"\n== {d['mode']} · page {d['fps']:.0f} fps")
ov = d.get('extra', {}).get('overlayLag', {})
for r in d['results']:
    l = r['lag'] or {}; o = ov.get(f"{r['stroke']}|{r['sigma']:.1f}", {})
    print(f"{r['stroke']:18} smoothing {r['sigma']:.0f}px  error {r['errRms']:.3f}px  lag {l.get('median', float('nan')):5.1f}ms (p90 {l.get('p90', float('nan')):5.1f})"
          + (f"  overlay {o['median']:5.1f}ms" if o else '') + f"  · {r['input']}")
PY
done
rm -f "$LOG"
