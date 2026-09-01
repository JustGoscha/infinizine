// WYSIWYG editing helpers: markdown <-> contenteditable HTML, plus live
// typing transforms so markdown converts the moment it's completed.

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineToHtml(s: string): string {
  let h = escapeHtml(s);
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return h || '<br>';
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

function inlineToMd(node: Node): string {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? '').replace(/​/g, '');
    else if (n instanceof HTMLElement) {
      switch (n.tagName) {
        case 'BR': break;
        case 'STRONG': case 'B': out += `**${inlineToMd(n)}**`; break;
        case 'EM': case 'I': out += `*${inlineToMd(n)}*`; break;
        default: out += inlineToMd(n);
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
    const mi = upto.match(/(?:^|[^*])(\*([^*\n]+)\*)$/);
    if (mi) { full = mi[1]; inner = mi[2]; tag = 'em'; }
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
