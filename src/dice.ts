// The typeface dice on a text box: roll another face of its role.

import { Store } from './store';
import { TextBox } from './types';
import { roleOf, boxFamily, fitBox } from './text';
import { rollFace, loadFace } from './facepool';
import { InputState } from './state';

/** The dice: pick another face of the box's role, spin until it has loaded, then apply (undoable). */
export async function rollTextFace(store: Store, state: InputState, invalidate: () => void, el: TextBox) {
  if (state.rolling.has(el.id)) return;
  const role = roleOf(el.font ?? 'franklin');
  const started = performance.now();
  state.rolling.set(el.id, 1 + Math.floor(Math.random() * 6));
  let last = started;
  const spin = () => {
    if (!state.rolling.has(el.id)) return;
    const now = performance.now();
    if (now - last > 90) {
      last = now;
      const cur = state.rolling.get(el.id)!;
      let pip = 1 + Math.floor(Math.random() * 6);
      if (pip === cur) pip = (pip % 6) + 1;
      state.rolling.set(el.id, pip);
      invalidate();
    }
    requestAnimationFrame(spin);
  };
  invalidate();
  requestAnimationFrame(spin);
  let face = el.face;
  for (let tries = 0; tries < 4; tries++) {
    const pick = rollFace(role, face);
    if (!pick) break;
    if (await loadFace(pick.id)) { face = pick.id; break; }
  }
  // a roll that came back instantly still shows its spin
  const wait = 450 - (performance.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state.rolling.delete(el.id);
  const live = store.doc.elements.find((e) => e.id === el.id);
  if (!live || live.kind !== 'text' || face === live.face) { invalidate(); return; }
  // the new face has its own metrics: re-measure the box like an edit would
  const { w, h } = fitBox(live.text, boxFamily({ font: live.font, face }), live.fontSize, live);
  store.updateText(
    live.id,
    { text: live.text, w: live.w, h: live.h, face: live.face ?? null },
    { text: live.text, w, h, face },
  );
  invalidate();
}
