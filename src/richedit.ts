// WYSIWYG editing helpers: markdown <-> contenteditable HTML, plus live
// typing transforms so markdown converts the moment it's completed.

import { FONTS } from './text';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `{attrs|text}` spans (nesting) → <span data-font data-weight>, then marks. */
function inlineToHtml(s: string): string {
  let out = '';
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '{') {
      const m = /^\{([a-z0-9 ]+)\|/.exec(s.slice(k));
      if (m) {
        let font = '', weight = '';
        for (const a of m[1].split(' ')) {
          if (FONTS[a]) font = a;
          else if (/^w[1-9]00$/.test(a)) weight = a.slice(1);
        }
        const style = `${font ? `font-family:${FONTS[font].css};` : ''}${weight ? `font-weight:${weight};` : ''}`;
        out += `<span${font ? ` data-font="${font}"` : ''}${weight ? ` data-weight="${weight}"` : ''} style="${style}">`;
        depth++;
        k += m[0].length - 1;
        continue;
      }
    }
    if (s[k] === '}' && depth) { out += '</span>'; depth--; continue; }
    out += escapeHtml(s[k]);
  }
  while (depth-- > 0) out += '</span>';
  // marks may cross span boundaries — the regexes see through the tags
  out = out.replace(/\*\*((?:(?!\*\*).)+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__((?:(?!__).)+)__/g, '<u>$1</u>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out || '<br>';
}

export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
  };
  for (const line of md.split('\n')) {
    if (line.startsWith('- ') || line.startsWith('* ')) {
      (list ??= []).push(`<li>${inlineToHtml(line.slice(2))}</li>`);
      continue;
    }
    flush();
    if (line.startsWith('# ')) out.push(`<h1>${inlineToHtml(line.slice(2))}</h1>`);
    else if (line.startsWith('## ')) out.push(`<h2>${inlineToHtml(line.slice(3))}</h2>`);
    else if (line.startsWith('### ')) out.push(`<h3>${inlineToHtml(line.slice(4))}</h3>`);
    else out.push(`<div>${inlineToHtml(line)}</div>`);
  }
  flush();
  return out.join('') || '<div><br></div>';
}

type Ctx = { f?: string; w?: number };
const attrsOf = (c: Ctx) => [c.f, c.w ? `w${c.w}` : ''].filter(Boolean).join(' ');
function inlineToMd(node: Node, ctx: Ctx = {}): string {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/\u200b/g, '');
      if (!t) return;
      out += ctx.f || ctx.w ? `{${attrsOf(ctx)}|${t}}` : t;
    } else if (n instanceof HTMLElement) {
      switch (n.tagName) {
        case 'BR': break;
        case 'STRONG': case 'B': out += `**${inlineToMd(n, ctx)}**`; break;
        case 'EM': case 'I': out += `*${inlineToMd(n, ctx)}*`; break;
        case 'U': out += `__${inlineToMd(n, ctx)}__`; break;
        default: {
          // per-word typeface / weight: nested spans merge, innermost wins
          const c: Ctx = { ...ctx };
          if (n.dataset.font) c.f = n.dataset.font;
          if (n.dataset.weight) c.w = Number(n.dataset.weight);
          out += inlineToMd(n, c);
        }
      }
    }
  });
  return out;
}

export function htmlToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/​/g, '');
      if (t) lines.push(t);
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    switch (n.tagName) {
      case 'H1': lines.push(`# ${inlineToMd(n)}`); break;
      case 'H2': lines.push(`## ${inlineToMd(n)}`); break;
      case 'H3': lines.push(`### ${inlineToMd(n)}`); break;
      case 'UL':
        n.querySelectorAll(':scope > li').forEach((li) => lines.push(`- ${inlineToMd(li)}`));
        break;
      case 'BR': lines.push(''); break;
      default: lines.push(inlineToMd(n));
    }
  });
  return lines.join('\n');
}

function blockOf(root: HTMLElement, n: Node): HTMLElement | null {
  let cur: Node | null = n;
  while (cur && cur.parentNode !== root) cur = cur.parentNode;
  return cur instanceof HTMLElement ? cur : null;
}

function firstTextNode(el: HTMLElement): Node | null {
  let n: Node | null = el;
  while (n && n.nodeType !== Node.TEXT_NODE) n = n.firstChild;
  return n;
}

function placeCaret(node: Node, off: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  try {
    r.setStart(node, off);
  } catch {
    r.selectNodeContents(node);
    r.collapse(false);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function caretToEnd(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(root);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Live transforms while typing: '# ' / '- ' prefixes, completed **bold** / *italic*. */
export function autoTransform(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return;
  const text = node.textContent ?? '';
  const off = sel.anchorOffset;

  // block prefixes at line start ('# ', '## ', '### ', '- ')
  const block = blockOf(root, node);
  if (block && (block.tagName === 'DIV' || block.tagName === 'P')) {
    const m = (block.textContent ?? '').match(/^(#{1,3}|-|\*)\s/);
    if (m && node === firstTextNode(block) && off >= m[0].length) {
      node.textContent = text.slice(m[0].length);
      placeCaret(node.textContent ? node : block, Math.max(0, off - m[0].length));
      if (m[1] === '-' || m[1] === '*') document.execCommand('insertUnorderedList');
      else document.execCommand('formatBlock', false, `H${m[1].length}`);
      return;
    }
  }

  // completed inline marks just before the caret
  const upto = text.slice(0, off);
  let full = '', inner = '', tag = '';
  const mb = upto.match(/\*\*([^*\n]+)\*\*$/);
  if (mb) { full = mb[0]; inner = mb[1]; tag = 'strong'; }
  else {
    const mu = upto.match(/__([^_\n]+)__$/);
    if (mu) { full = mu[0]; inner = mu[1]; tag = 'u'; }
    else {
      const mi = upto.match(/(?:^|[^*])(\*([^*\n]+)\*)$/);
      if (mi) { full = mi[1]; inner = mi[2]; tag = 'em'; }
    }
  }
  if (!tag) return;
  const range = document.createRange();
  range.setStart(node, off - full.length);
  range.setEnd(node, off);
  range.deleteContents();
  const el = document.createElement(tag);
  el.textContent = inner;
  range.insertNode(el);
  const after = document.createTextNode('​'); // caret lands outside the styling
  el.after(after);
  placeCaret(after, 1);
}

/** Wrap the editor's current selection in a span carrying a typeface and/or
 * weight. With nothing selected the whole box is wrapped. Existing spans inside
 * the selection lose the attribute being set (so the new pick wins). */
export function applyInlineStyle(root: HTMLElement, style: { font?: string; css?: string; weight?: number }): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  let range: Range;
  if (sel.rangeCount && !sel.isCollapsed && root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
  } else {
    if (style.font) return false; // typeface with no selection → whole-box font (caller handles)
    range = document.createRange();
    range.selectNodeContents(root);
  }
  const frag = range.extractContents();
  frag.querySelectorAll('span[data-font],span[data-weight]').forEach((sp) => {
    const el = sp as HTMLElement;
    if (style.font) { delete el.dataset.font; el.style.fontFamily = ''; }
    if (style.weight) { delete el.dataset.weight; el.style.fontWeight = ''; }
    if (!el.dataset.font && !el.dataset.weight) el.replaceWith(...Array.from(el.childNodes));
  });
  const span = document.createElement('span');
  if (style.font) { span.dataset.font = style.font; span.style.fontFamily = style.css ?? ''; }
  if (style.weight) { span.dataset.weight = String(style.weight); span.style.fontWeight = String(style.weight); }
  span.appendChild(frag);
  range.insertNode(span);
  const r = document.createRange();
  r.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}
