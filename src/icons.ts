// Icons, tool catalogue (labels, keys, groups, sizes) and the canvas cursors.

import type { Tool } from './state';

export const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICON_PATHS: Record<string, string> = {
  // Phosphor icon set (regular weight): one consistent family for the draw tools
  pen: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M248,92.68a15.86,15.86,0,0,0-4.69-11.31L174.63,12.68a16,16,0,0,0-22.63,0L123.57,41.11l-58,21.77A16.06,16.06,0,0,0,55.35,75.23L32.11,214.68A8,8,0,0,0,40,224a8.4,8.4,0,0,0,1.32-.11l139.44-23.24a16,16,0,0,0,12.35-10.17l21.77-58L243.31,104A15.87,15.87,0,0,0,248,92.68Zm-69.87,92.19L63.32,204l47.37-47.37a28,28,0,1,0-11.32-11.32L52,192.7,71.13,77.86,126,57.29,198.7,130ZM112,132a12,12,0,1,1,12,12A12,12,0,0,1,112,132Zm96-15.32L139.31,48l24-24L232,92.68Z"/></g>',
  pencil: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM51.31,160,136,75.31,152.69,92,68,176.68ZM48,179.31,76.69,208H48Zm48,25.38L79.31,188,164,103.31,180.69,120Zm96-96L147.31,64l24-24L216,84.68Z"/></g>',
  fineliner: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31l83.67-83.66,3.48,13.9-36.8,36.79a8,8,0,0,0,11.31,11.32l40-40a8,8,0,0,0,2.11-7.6l-6.9-27.61L227.32,96A16,16,0,0,0,227.32,73.37ZM48,179.31,76.69,208H48Zm48,25.38L51.31,160,136,75.31,180.69,120Zm96-96L147.32,64l24-24L216,84.69Z"/></g>',
  marker: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M253.66,106.34a8,8,0,0,0-11.32,0L192,156.69,107.31,72l50.35-50.34a8,8,0,1,0-11.32-11.32L96,60.69A16,16,0,0,0,93.18,79.5L72,100.69a16,16,0,0,0,0,22.62L76.69,128,18.34,186.34a8,8,0,0,0,3.13,13.25l72,24A7.88,7.88,0,0,0,96,224a8,8,0,0,0,5.66-2.34L136,187.31l4.69,4.69a16,16,0,0,0,22.62,0l21.19-21.18A16,16,0,0,0,203.31,168l50.35-50.34A8,8,0,0,0,253.66,106.34ZM93.84,206.85l-55-18.35L88,139.31,124.69,176ZM152,180.69,83.31,112,104,91.31,172.69,160Z"/></g>',
  // lasso fill: a filled loop closed with a straight cut from where the pen lifted back to the start
  'lasso-fill': '<path d="M6.5 13.5 C4 9.5 7.5 5 12.5 4.6 C17 4.3 20.5 7.5 19.5 11.5 C18.8 14.2 16.5 16 14 16.5 Z" fill="currentColor" fill-opacity="0.85"/><path d="M6.5 13.5 L14 16.5" stroke-width="2.2"/><path d="M8.5 15.5 C6.5 17.5 10 19 8 21"/>',
  // blob fill: the loop rounds itself off like a drop of ink
  'lasso-blob': '<path d="M5.5 10.5 C5 6.5 9 4.2 12.5 5 C15.5 5.7 19.5 5.5 19.8 9.5 C20 13 17.5 16.5 13.5 16.8 C9.5 17 6 14.5 5.5 10.5 Z" fill="currentColor" fill-opacity="0.85"/><path d="M8.5 16.5 C6.5 18.5 10 19.5 8 21.5"/>',
  eraser: '<path d="M9.5 18.5 L4.5 13.5 L13 5 L18.5 10.5 L10.5 18.5 Z"/><path d="M8 20 H20"/>',
  'lasso-select': '<ellipse cx="12" cy="10.5" rx="7.5" ry="5.5" stroke-dasharray="3.4 2.6"/><path d="M8.5 15.5 C6.5 17.5 10 19 8 21"/>',
  cursor: '<path d="M6.5 3.5 L18 13 L12.8 13.8 L15.6 19.6 L13 20.8 L10.3 14.9 L6.5 17.8 Z"/>',
  text: '<path d="M5 7 V4.5 H19 V7 M12 4.5 V19.5 M9 19.5 H15"/>',
  anim: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7.5 6v12 M16.5 6v12 M3.5 12h4 M16.5 12h4"/>',
  hand: '<path d="M12 3 V21 M3 12 H21"/><path d="M12 3 L9.6 5.4 M12 3 L14.4 5.4 M12 21 L9.6 18.6 M12 21 L14.4 18.6 M3 12 L5.4 9.6 M3 12 L5.4 14.4 M21 12 L18.6 9.6 M21 12 L18.6 14.4"/>',
};
// pointing finger, shared by the three finger-mode glyphs (a small badge is added bottom-right)
export const FINGER_ICON = '<path d="M9 12.5 V5.5 a1.5 1.5 0 0 1 3 0 V11"/><path d="M9 12.5 L7.2 10.8 a1.4 1.4 0 0 0 -2 2 L8.5 17.5 a5 5 0 0 0 4.2 2.5 H13"/><path d="M12 11 V9.5 a1.4 1.4 0 0 1 2.8 0 V11.5"/>';
export const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(ICON_PATHS).map(([k, inner]) => [k, svg(inner)]),
);

/** Custom canvas cursors: brush tools get a circle at brush size; the rest get a
 * precise crosshair with the tool icon beside it. */
export function cursorFor(tool: Tool, zoom: number, baseWidth: number): string {
  const enc = (v: string) => `url("data:image/svg+xml,${encodeURIComponent(v)}")`;
  if (tool === 'pen' || tool === 'pencil' || tool === 'fineliner' || tool === 'marker' || tool === 'eraser') {
    let d = baseWidth * (tool === 'marker' ? 2.4 : 1) * zoom;
    if (tool === 'eraser') d = Math.max(3, baseWidth * zoom);
    d = Math.max(4, Math.min(80, d));
    const s = Math.ceil(d + 6);
    const c = s / 2;
    const img = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'>` +
      `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='none' stroke='#fff' stroke-width='2.6' opacity='0.85'/>` +
      `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='none' stroke='#2A241A' stroke-width='1.2' opacity='0.9'/>` +
      `</svg>`;
    return `${enc(img)} ${c} ${c}, crosshair`;
  }
  if (tool === 'cursor') return 'default';
  if (tool === 'hand') return 'grab';
  // precise crosshair + tool icon beside it
  const inner = ICON_PATHS[tool] ?? '';
  const img = `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'>` +
    `<path d='M8 1v14M1 8h14' stroke='#fff' stroke-width='3.4' stroke-linecap='round'/>` +
    `<path d='M8 1v14M1 8h14' stroke='#2A241A' stroke-width='1.4' stroke-linecap='round'/>` +
    `<g transform='translate(16,16) scale(0.9)' fill='none' stroke='#2A241A' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>${inner}</g>` +
    `</svg>`;
  return `${enc(img)} 8 8, crosshair`;
}

export const TOOL_INFO: Record<Tool, { label: string; key: string }> = {
  pen: { label: 'Pen', key: 'P' },
  pencil: { label: 'Pencil', key: 'B' },
  sketch: { label: 'Sketch', key: 'K' },
  fineliner: { label: 'Fineliner', key: 'F' },
  marker: { label: 'Marker', key: 'M' },
  'lasso-fill': { label: 'Lasso fill', key: 'G' },
  'lasso-blob': { label: 'Blob fill', key: 'O' },
  eraser: { label: 'Eraser', key: 'E' },
  cursor: { label: 'Cursor', key: 'V' },
  'lasso-select': { label: 'Lasso select', key: 'S' },
  text: { label: 'Text', key: 'T' },
  anim: { label: 'Animation', key: 'A' },
  hand: { label: 'Move', key: 'H' },
};

// Tools are grouped: the toolbar shows one slot per group; tapping an active
// group expands a flyout with the group's tools.
export const TOOL_GROUPS: { id: string; tools: Tool[] }[] = [
  { id: 'draw', tools: ['pen', 'pencil', 'fineliner', 'marker', 'lasso-fill', 'lasso-blob'] },
  { id: 'eraser', tools: ['eraser'] },
  { id: 'select', tools: ['cursor', 'lasso-select', 'hand'] },
  { id: 'text', tools: ['text'] },
  { id: 'anim', tools: ['anim'] },
];

export const SIZES = [
  { w: 0.8, label: 'XS' },
  { w: 1.2, label: 'S' },
  { w: 1.6, label: 'M' },
  { w: 2.4, label: 'L' },
  { w: 4, label: 'XL' },
];
