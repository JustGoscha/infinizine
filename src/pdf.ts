// Minimal PDF writer: one JPEG image per page, page sized in points. No
// compression library needed — JPEG data is embedded as-is (DCTDecode).

export interface PdfPage { jpeg: Uint8Array; wPx: number; hPx: number; wPt: number; hPt: number }

const enc = new TextEncoder();

export function makePdf(pages: PdfPage[], title = 'InfiniZine'): Blob {
  const parts: (Uint8Array | string)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (s: Uint8Array | string) => {
    parts.push(s);
    length += typeof s === 'string' ? enc.encode(s).length : s.length;
  };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  // 1 catalog, 2 pages tree, 3 info; then per page: page, content, image (3 objects each)
  const count = pages.length;
  const pageObj = (i: number) => 4 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${count} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, '');
  obj(3, `<< /Title (${esc(title)}) /Producer (InfiniZine) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
  pages.forEach((p, i) => {
    const n = pageObj(i);
    const w = p.wPt.toFixed(2), h = p.hPt.toFixed(2);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    obj(n + 1, `<< /Length ${content.length} >>`, content);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.wPx} /Height ${p.hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
  });
  const xref = length;
  const total = 4 + count * 3;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p)) as BlobPart[], { type: 'application/pdf' });
}
