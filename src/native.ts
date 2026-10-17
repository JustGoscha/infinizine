// Bridge to the native iPad app (ios/). The app captures the Pencil in UIKit — sub-pixel
// positions, every coalesced sample (240 Hz), UIKit's predicted touches — and sends it
// here; it's replayed as pen PointerEvents on the canvas, so input.ts treats it like any
// pen. While the native Pencil is live, the web view's own pen contact events on the
// canvas (rounded to whole pixels on iPadOS < 26.2, ~120 Hz) are dropped. Fingers, hover
// and the toolbar stay plain web. In a browser none of this runs.

/** [x, y (CSS px), t (s, native clock), pressure 0..1, altitude (rad), azimuth (rad)] */
type NSample = [number, number, number, number, number, number];
interface NMsg { ph: 'b' | 'm' | 'e' | 'c'; id: number; now: number; s: NSample[]; pr?: NSample[] }

interface NativeInfo { platform: string; version?: string; test?: string; logStrokes?: boolean; mousePencil?: boolean }
declare global {
  interface Window {
    __izineNativeApp?: NativeInfo;
    __izineNative?: { pen(m: NMsg): void };
    webkit?: { messageHandlers?: Record<string, { postMessage(v: unknown): void }> };
  }
}

export const nativeApp: NativeInfo | null = window.__izineNativeApp ?? null;
const NATIVE_POINTER = 7001; // pointerId of the replayed Pencil

/** performance.now() − native clock, in ms. The smallest difference seen has the least IPC delay in it. */
let clockOffset = Infinity;
export const nativeToPerf = (t: number) => t * 1000 + clockOffset;
export const perfToNative = (ms: number) => (ms - clockOffset) / 1000;

export function postNative(msg: unknown) {
  window.webkit?.messageHandlers?.izine?.postMessage(msg);
}

export function attachNativePen(canvas: HTMLCanvasElement) {
  if (!nativeApp) return;
  // Registered before input.ts: at the target these run first and stop the web view's own pen
  // contact events (hover — no buttons — still passes: the eraser ring follows a hovering Pencil).
  const swallow = (e: Event) => {
    const p = e as PointerEvent;
    if (nativeApp!.logStrokes && p.isTrusted && p.type !== 'pointermove') postNative({ type: 'log', msg: `web ${p.type} ${p.pointerType}` });
    // (simulator testing, -izineMousePencil: mouse drags arrive as touches and stand in for the Pencil)
    const pencilLike = p.pointerType === 'pen' || (nativeApp!.mousePencil && p.pointerType === 'touch');
    if (!p.isTrusted || !pencilLike || (p.type === 'pointermove' && p.buttons === 0)) return;
    // keep the rest of this contact on the canvas (and swallowed): a stroke that ends over the
    // toolbar must not click it
    if (p.type === 'pointerdown') try { canvas.setPointerCapture(p.pointerId); } catch { /* already gone */ }
    p.preventDefault();
    p.stopImmediatePropagation();
  };
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(t, swallow, { capture: true });

  const make = (type: string, s: NSample, extra: { coalesced?: PointerEvent[]; predicted?: PointerEvent[] } = {}) => {
    const down = type === 'pointerdown' || type === 'pointermove';
    const ev = new PointerEvent(type, {
      pointerId: NATIVE_POINTER, pointerType: 'pen', isPrimary: true,
      clientX: s[0], clientY: s[1],
      pressure: down ? s[3] : 0,
      buttons: down ? 1 : 0, button: type === 'pointermove' ? -1 : 0,
      width: 1, height: 1, bubbles: true, cancelable: true, composed: true,
    });
    // what the constructor can't set: sub-pixel positions (WebKit < 26.2 rounds clientX/Y to
    // whole pixels in the constructor too), the sample's own time and the Pencil's angles
    Object.defineProperty(ev, 'clientX', { value: s[0] });
    Object.defineProperty(ev, 'clientY', { value: s[1] });
    Object.defineProperty(ev, 'timeStamp', { value: nativeToPerf(s[2]) });
    Object.defineProperty(ev, 'altitudeAngle', { value: s[4] });
    Object.defineProperty(ev, 'azimuthAngle', { value: s[5] });
    if (extra.coalesced) Object.defineProperty(ev, 'getCoalescedEvents', { value: () => extra.coalesced });
    Object.defineProperty(ev, 'getPredictedEvents', { value: () => extra.predicted ?? [] });
    return ev;
  };
  const move = (s: NSample[], pr: NSample[] = []) => {
    if (!s.length) return;
    const coalesced = s.map((q) => make('pointermove', q));
    canvas.dispatchEvent(make('pointermove', s[s.length - 1], { coalesced, predicted: pr.map((q) => make('pointermove', q)) }));
  };

  let active: number | null = null; // native touch id being replayed onto the canvas
  let lastSample: NSample | null = null;
  window.__izineNative = {
    pen(m: NMsg) {
      if (nativeApp!.logStrokes && m.ph !== 'm') postNative({ type: 'log', msg: `pen ${m.ph} id ${m.id} on ${m.s[0] ? document.elementFromPoint(m.s[0][0], m.s[0][1])?.tagName : '-'} active ${active}` });
      clockOffset = Math.min(clockOffset, performance.now() - m.now * 1000);
      if (m.ph === 'b') {
        const s0 = m.s[0];
        // a Pencil touch that starts on the toolbar or a panel belongs to the web UI
        active = s0 && document.elementFromPoint(s0[0], s0[1]) === canvas ? m.id : null;
        if (active === null) return;
        lastSample = m.s[m.s.length - 1];
        canvas.dispatchEvent(make('pointerdown', s0));
        move(m.s.slice(1), m.pr);
        return;
      }
      if (active !== m.id) return;
      move(m.s, m.ph === 'm' ? m.pr : []);
      if (m.s.length) lastSample = m.s[m.s.length - 1];
      if (m.ph === 'e' || m.ph === 'c') {
        if (lastSample) canvas.dispatchEvent(make(m.ph === 'e' ? 'pointerup' : 'pointercancel', lastSample));
        active = null;
        lastSample = null;
      }
    },
  };
  postNative({ type: 'ready' });
}
