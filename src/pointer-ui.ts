// Pointer helpers for the chrome: press-and-drag items (timeline tiles, page
// thumbs), Pencil taps that iPadOS drops, and range sliders driven by touch.

/** Timeline item interaction. Mouse: drag right away. Pen/finger: moving lets
 * the tracks scroll natively; holding still for 0.5s "lifts" the item, then it
 * drags (scroll is blocked for that gesture). A short tap without moving = tap. */
const HOLD_MS = 500; // press still this long: the item lifts
const HOLD2_MS = 450; // keep holding after the lift: the hold menu opens under the finger

/** A ring that fills around the pointer over `ms` — the wait for a hold made visible. */
function showHoldRing(x: number, y: number, ms: number): () => void {
  const ring = document.createElement('div');
  ring.className = 'hold-ring';
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.setProperty('--hold-ms', `${ms}ms`);
  document.body.appendChild(ring);
  return () => ring.remove();
}

export function pressDrag(
  el: HTMLElement,
  h: {
    onLift?: () => void;
    onMove: (ev: PointerEvent, dx: number) => void;
    onEnd: (ev: PointerEvent) => void; // dragged
    onTap: (ev: PointerEvent) => void; // no drag
    /** held still for HOLD_MS (the ring fills, the item lifts), then either kept still for
     * HOLD2_MS more (`down` = true: the pointer is still down, the caller may track it) or
     * released in place */
    onHold?: (ev: PointerEvent, down: boolean) => void;
  },
) {
  el.addEventListener('pointerdown', (e) => {
    // fingers hold before dragging so a swipe can still scroll the strip; a pen taps and
    // drags like a mouse (a pencil tap wobbles and may lift a little off the tile — with
    // immediate capture the pointerup still reaches us and counts as the tap)
    const touchy = e.pointerType === 'touch';
    const startX = e.clientX, startY = e.clientY;
    let lifted = !touchy;
    let held = false; // stayed put for HOLD_MS
    let menu = false; // the hold menu opened while still down
    let dragging = false;
    let done = false;
    let timer = 0;
    let hideRing: (() => void) | null = null;
    // while lifted, the strip must not scroll natively: a pencil also raises touch events on
    // iPad, so the block applies to it too (or Safari pans the strip and cancels the drag)
    const blockScroll = (te: TouchEvent) => { if (lifted) te.preventDefault(); };
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      hideRing?.(); hideRing = null;
      el.classList.remove('lifted');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', blockScroll);
    };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!lifted) {
        if (Math.hypot(dx, dy) > 8) cleanup(); // finger moved before the hold: it's a scroll
        return;
      }
      if (menu) return; // the menu tracks the pointer itself
      if (!held && Math.hypot(dx, dy) > 8) { clearTimeout(timer); hideRing?.(); hideRing = null; } // moved: not a hold
      if (!dragging && Math.abs(dx) > (touchy ? 2 : 8)) { dragging = true; clearTimeout(timer); }
      if (dragging) h.onMove(ev, dx);
    };
    const onUp = (ev: PointerEvent) => {
      const wasDragging = dragging, wasHeld = held, hadMenu = menu;
      cleanup();
      if (hadMenu) return; // the menu handles the release
      if (wasDragging) h.onEnd(ev);
      else if (wasHeld && h.onHold) h.onHold(ev, false);
      else h.onTap(ev);
    };
    const onCancel = () => cleanup();
    if (e.pointerType !== 'mouse') document.addEventListener('touchmove', blockScroll, { passive: false });
    const wantsHold = touchy || !!h.onHold;
    if (!touchy) el.setPointerCapture(e.pointerId);
    if (wantsHold) {
      hideRing = showHoldRing(e.clientX, e.clientY, HOLD_MS);
      timer = window.setTimeout(() => {
        if (done || dragging) return;
        hideRing?.(); hideRing = null;
        held = true;
        lifted = true;
        el.classList.add('lifted');
        if (touchy) try { el.setPointerCapture(e.pointerId); } catch { /* pointer may be gone */ }
        h.onLift?.();
        if (h.onHold) {
          // keep holding: the menu opens under the finger
          timer = window.setTimeout(() => {
            if (done || dragging) return;
            menu = true;
            h.onHold!(e, true);
          }, HOLD2_MS);
        }
      }, HOLD_MS);
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  });
}

/** iPadOS doesn't reliably turn a Pencil tap on a button into a click (the tip wobbles and
 * lifts a hair off the target). Track pen presses on buttons and click them ourselves on
 * release when no native click followed. */
export function installPenTaps() {
  const TARGET = 'button, .tl-track-head, .present-tap, .tl-tab-eye';
  let press: { el: HTMLElement; id: number; x: number; y: number; t: number } | null = null;
  let nativeClickAt = 0;
  document.addEventListener('click', () => { nativeClickAt = performance.now(); }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    const el = (e.target as HTMLElement).closest?.(TARGET) as HTMLElement | null;
    press = el && !el.closest('canvas') ? { el, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (performance.now() - p.t > 600 || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 14) return;
    const t0 = performance.now();
    window.setTimeout(() => { if (nativeClickAt < t0 && p.el.isConnected) p.el.click(); }, 60);
  }, true);
  document.addEventListener('pointercancel', () => { press = null; }, true);
}

/** The fat bar sliders fill up to their value: keep the --fill custom property in step
 * (on every input event, and after code sets a value). */
export function syncRangeFill(input: HTMLInputElement) {
  const min = Number(input.min) || 0, max = Number(input.max) || 100;
  const f = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${Math.round(Math.max(0, Math.min(1, f)) * 1000) / 10}%`);
}
export function syncRangeFills(root: ParentNode = document) {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncRangeFill);
}

/** Range sliders driven by the pointer directly: on iPad a finger or pen on a native
 * <input type=range> often just scrolls or does nothing. The value follows the pointer's
 * x across the track and the usual `input` / `change` events fire. */
export function installPointerSliders() {
  const isRange = (t: EventTarget | null): t is HTMLInputElement =>
    t instanceof HTMLInputElement && t.type === 'range';
  document.addEventListener('touchstart', (e) => { if (isRange(e.target)) e.preventDefault(); }, { passive: false, capture: true });
  document.addEventListener('input', (e) => { if (isRange(e.target)) syncRangeFill(e.target); }, true);
  document.addEventListener('pointerdown', (e) => { if (isRange(e.target)) syncRangeFill(e.target); }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !isRange(e.target)) return;
    const input = e.target;
    e.preventDefault();
    const min = Number(input.min) || 0, max = Number(input.max) || 100, step = Number(input.step) || 1;
    const apply = (ev: PointerEvent) => {
      const r = input.getBoundingClientRect();
      const pad = Math.min(14, r.width / 4); // half a thumb: the track ends inside the box
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left - pad) / Math.max(1, r.width - 2 * pad)));
      let v = min + f * (max - min);
      v = Math.round((v - min) / step) * step + min;
      const digits = (String(step).split('.')[1] ?? '').length;
      const next = Math.max(min, Math.min(max, Number(v.toFixed(digits))));
      if (String(next) === input.value) return;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input.setPointerCapture(e.pointerId);
    apply(e);
    const onMove = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) apply(ev); };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      input.removeEventListener('pointermove', onMove);
      input.removeEventListener('pointerup', onUp);
      input.removeEventListener('pointercancel', onUp);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('pointermove', onMove);
    input.addEventListener('pointerup', onUp);
    input.addEventListener('pointercancel', onUp);
  }, true);
}

