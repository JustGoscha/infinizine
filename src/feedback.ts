// Small on-screen feedback: toasts (bottom) and tip bubbles (at a point).

export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));
}
/** A small bubble that pops up right above a point on screen and fades. */
let tipEl: HTMLElement | null = null;
let tipTimer = 0;
export function tip(x: number, y: number, text: string) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip-bubble'; document.body.appendChild(tipEl); }
  tipEl.textContent = text;
  tipEl.classList.remove('show');
  void tipEl.offsetWidth; // restart the animation
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, x))}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
  tipEl.classList.add('show');
  window.clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => tipEl?.classList.remove('show'), 1300);
}
export const tipAt = (el: Element, text: string) => { const r = el.getBoundingClientRect(); tip(r.left + r.width / 2, r.top - 6, text); };
