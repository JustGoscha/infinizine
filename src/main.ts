import './style.css';
import { Camera, baseZoom } from './camera';
import { Store } from './store';
import { InputState, attachInput } from './input';
import { Renderer } from './render';
import { buildUI } from './ui';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const camera = new Camera();
const store = new Store();
const state = new InputState();

const renderer = new Renderer(canvas, store, camera, state);
const input = attachInput(canvas, camera, store, state, () => renderer.invalidate());
input.setDropCache((id) => renderer.dropFromCache(id));

const uiHooks = buildUI(ui, state, store, camera, () => renderer.invalidate(), {
  copy: () => input.copySelection(),
  cut: () => input.cutSelection(),
  paste: () => void input.pasteSmart(),
});

store.onChange = () => {
  renderer.clearCache(); // ops can add/remove/translate; cheap enough at prototype scale
  renderer.invalidate();
  uiHooks.docChanged();
};

// First run: start with one A4 page waiting (the journaler's greeting)
if (store.doc.pages.length === 0 && store.doc.elements.length === 0) {
  store.addPage({ w: 420, h: 594 }, { x: 0, y: 0 }); // A4
}

// Start at 100% (true physical scale), centered on the first page, zoom locked
requestAnimationFrame(() => {
  const page = store.doc.pages[0];
  camera.zoom = baseZoom();
  if (page) {
    camera.x = page.x + page.w / 2;
    camera.y = page.y + page.h / 2;
  }
  state.updateCursor();
  renderer.invalidate();
});
window.addEventListener('resize', () => renderer.invalidate());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
