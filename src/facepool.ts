// The dice: extra typefaces per role, fetched on demand from jsDelivr's Fontsource
// CDN (the same OFL/Apache files @fontsource packages ship). Only the latin
// subset is loaded; a face is registered with the browser once and stays for the
// session. Nothing is fetched until a box actually uses one of these faces.
import { POOL, type PoolFace } from './facepool-data';
import { FACES, type FontRole } from './text';

export { POOL };
const CDN = 'https://cdn.jsdelivr.net/fontsource/fonts';
const byId = new Map<string, PoolFace>();
for (const faces of Object.values(POOL)) for (const f of faces) byId.set(f.id, f);

export function poolFace(id: string): PoolFace | undefined {
  return byId.get(id);
}

const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
/** Is the face ready to draw with? Bundled ones always are. */
export function faceReady(id: string): boolean {
  const f = byId.get(id);
  return !!f && (!!f.local || loaded.has(id));
}
/** CSS family list for a pool face (bundled faces use their bundled name). */
export function poolCss(id: string): string | undefined {
  const f = byId.get(id);
  if (!f) return undefined;
  if (f.local) {
    for (const faces of Object.values(FACES)) {
      const b = faces.find((x) => x.id === f.local);
      if (b) return b.css;
    }
  }
  return f.css;
}
export function poolWeights(id: string): [number, number] | undefined {
  const f = byId.get(id);
  if (!f) return undefined;
  if (f.local) {
    for (const faces of Object.values(FACES)) {
      const b = faces.find((x) => x.id === f.local);
      if (b) return b.weights;
    }
  }
  return f.wght;
}

/** Fetch + register a pool face. Resolves true once it can be drawn with. */
export function loadFace(id: string): Promise<boolean> {
  const f = byId.get(id);
  if (!f) return Promise.resolve(false);
  if (f.local || loaded.has(id)) return Promise.resolve(true);
  const pending = loading.get(id);
  if (pending) return pending;
  const files: { url: string; weight: string; style: string }[] = [];
  const styles = f.italic ? ['normal', 'italic'] : ['normal'];
  for (const style of styles) {
    if (f.wght) {
      files.push({ url: `${CDN}/${id}:vf@latest/latin-wght-${style}.woff2`, weight: `${f.wght[0]} ${f.wght[1]}`, style });
    } else {
      files.push({ url: `${CDN}/${id}@latest/latin-400-${style}.woff2`, weight: '400', style });
      if (f.bold) files.push({ url: `${CDN}/${id}@latest/latin-${f.bold}-${style}.woff2`, weight: String(f.bold), style });
    }
  }
  const p = (async () => {
    const faces = files.map((x) => new FontFace(f.name, `url(${x.url})`, { weight: x.weight, style: x.style, display: 'block' }));
    const results = await Promise.all(faces.map((ff) => ff.load().then(() => (document.fonts.add(ff), true), () => false)));
    // the regular cut is what matters; a missing italic/bold just falls back to synthesis
    const ok = results[0];
    if (ok) loaded.add(id);
    loading.delete(id);
    if (ok) window.dispatchEvent(new Event('izine-restyle'));
    return ok;
  })();
  loading.set(id, p);
  return p;
}

/** A random face of the role other than `not` (undefined when the pool is empty). */
export function rollFace(role: FontRole, not?: string): PoolFace | undefined {
  const pool = (POOL[role] ?? []).filter((f) => f.id !== not);
  if (!pool.length) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}
