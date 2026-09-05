// Smoke test for the IndexedDB persistence (run: bun run test:store). Not a browser: fake-indexeddb + shims.
import 'fake-indexeddb/auto';
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
(globalThis as any).window = globalThis;
(globalThis as any).__APP_VERSION__ = 'test';
(globalThis as any).CustomEvent = class extends Event { detail: unknown; constructor(t: string, i: any) { super(t); this.detail = i?.detail; } };
const { Store } = await import('../src/store');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idbOpen = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('infinizine', 2); r.onupgradeneeded = () => { for (const n of ['docs','meta','els']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); }; r.onsuccess = () => res(r.result); r.onerror = rej; });
const disk = async (id: string) => {
  const db = await idbOpen();
  const cnt = await new Promise((res) => { const r = db.transaction('els').objectStore('els').count(IDBKeyRange.bound([id, ''], [id, '￿'])); r.onsuccess = () => res(r.result); });
  const meta: any = await new Promise((res) => { const r = db.transaction('meta').objectStore('meta').get(id); r.onsuccess = () => res(r.result); });
  const legacy = await new Promise((res) => { const r = db.transaction('docs').objectStore('docs').count(); r.onsuccess = () => res(r.result); });
  return `disk: els=${cnt} order=${meta?.order?.length} legacyBlobs=${legacy}`;
};
const state = (s: any) => `doc=${s.docId} name=${s.doc.name} els=${s.doc.elements.length} pages=${s.doc.pages.length} first=${s.doc.elements[0]?.id} last=${s.doc.elements.at(-1)?.id}`;
// a synthetic v1-era zine: 300 strokes, 2 pages
const synth = { version: 2, name: 'smoke', palette: 'ink', pages: [{ id: 'p1', x: 0, y: 0, w: 270, h: 480, name: 'Page 1', order: 0 }, { id: 'p2', x: 330, y: 0, w: 270, h: 480, name: 'Page 2', order: 1 }], areas: [],
  elements: Array.from({ length: 300 }, (_, i) => ({ id: `st_${i}`, kind: 'stroke', tool: 'pen', color: '#000', baseWidth: 1, opacity: 1, layer: 'front', points: Array.from({ length: 20 }, (_, k) => ({ x: i + k, y: k, p: 0.5, t: k / 100 })) })) };
const txt = JSON.stringify(synth);
const db = await idbOpen();
await new Promise((res, rej) => { const tx = db.transaction('docs', 'readwrite'); tx.objectStore('docs').put(txt, 'doc_legacy1'); tx.oncomplete = res; tx.onerror = rej; });
localStorage.setItem('infinizine-docs', JSON.stringify([{ id: 'doc_legacy1', name: 'legacy', updated: Date.now() }]));
localStorage.setItem('infinizine-current', 'doc_legacy1');
console.log('planted;', await disk('doc_legacy1'));
let t = performance.now();
const s1 = new Store(); await s1.ready; console.log('load ms', Math.round(performance.now() - t)); await sleep(800);
console.log('s1 legacy load:', state(s1), await disk(s1.docId));
t = performance.now();
s1.addElement({ id: 'st_added', kind: 'stroke', tool: 'pen', color: '#000', baseWidth: 1, opacity: 1, layer: 'front', points: [{ x: 0, y: 0, p: 0.5, t: 0 }, { x: 10, y: 10, p: 0.5, t: 0.1 }] } as any);
await sleep(700); console.log('s1 added;', await disk(s1.docId));
const s2 = new Store(); await s2.ready; console.log('s2 reload:', state(s2));
s2.deleteElements([s2.doc.elements[0]]); s2.renameDoc('renamed'); s2.setPalette('nes'); await sleep(700);
console.log('s2 deleted+renamed;', await disk(s2.docId));
const s3 = new Store(); await s3.ready; console.log('s3 reload:', state(s3), 'palette=' + s3.doc.palette, 'order-ok=' + (s3.doc.elements[0].id === s2.doc.elements[0].id && s3.doc.elements.at(-1)!.id === 'st_added'));
s3.newDoc(); await sleep(700); console.log('s3 newDoc:', state(s3), await disk(s3.docId));
const s4 = new Store(); await s4.ready; console.log('s4 reload current:', state(s4));
const renamed = s4.listDocs().find((m) => m.name === 'renamed')!;
await s4.openDoc(renamed.id); await sleep(300); console.log('s4 reopen:', state(s4));
s4.deleteDoc(renamed.id); await sleep(700); console.log('s4 deleted renamed;', await disk(renamed.id), JSON.stringify(s4.listDocs().map((m) => m.name)));
