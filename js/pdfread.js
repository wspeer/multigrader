/* MultiGrader — read a test from a PDF, to set up the question format.
 *
 * Uses the bundled pdf.js (vendor/pdfjs), loaded the first time a PDF is
 * uploaded; the file never leaves the device. Each page's text is put back
 * into lines in reading order (two-column pages are read one column at a
 * time), and larger pictures are noted as lines of their own. The lines are
 * then handed to the Word-file question finder (MGDocx.findItems) as if they
 * were paragraphs, so numbering, answer choices and headings are read the
 * same way. A PDF with no text (a scan) is read with the bundled OCR instead.
 *
 * A PDF can't be rearranged, so it is used for the question format only;
 * reordered versions need the Word or LaTeX file.
 */
(function (root) {
  "use strict";
  const BASE = "vendor/pdfjs/";
  let loading = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error("couldn't load " + src));
      document.head.appendChild(s);
    });
  }
  async function lib() {
    if (root.pdfjsLib) return root.pdfjsLib;
    if (!loading) {
      loading = loadScript(BASE + "pdf.min.js").then(() => {
        const l = root.pdfjsLib;
        l.GlobalWorkerOptions.workerSrc = new URL(BASE + "pdf.worker.min.js", location.href).href;
        return l;
      });
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  /* ---------- text items → lines ---------- */

  // One page's items {x, y (top, downwards), w, h, str} → lines of text.
  // Lines starting with a question number.
  const QSTART = /^\s*(?:\(?\d{1,3}\s*[.):]|(?:question|problem|q)\s*\d)/i;
  function pageLines(items, pageW) {
    if (!items.length) return [];
    // Two columns: a vertical strip near the middle that (almost) no text
    // crosses. Gaps left by equations or pictures in a single column can look
    // like one too, so the page is read both ways and the reading with more
    // lines starting with a question number wins.
    const cols = splitColumns(items, pageW);
    const one = linesOf([items]);
    if (cols.length < 2) return one;
    const two = linesOf(cols);
    const score = (ls) => ls.filter((l) => QSTART.test(l.text)).length;
    return score(two) > score(one) ? two : one;
  }

  function linesOf(cols) {
    const out = [];
    for (const col of cols) {
      const rows = [];
      for (const it of col.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
        const r = rows.find((row) => Math.abs(row.y - it.y) <= Math.max(2, 0.45 * Math.min(row.h, it.h || row.h)));
        if (r) { r.items.push(it); r.h = Math.max(r.h, it.h); } else rows.push({ y: it.y, h: it.h || 10, items: [it] });
      }
      rows.sort((a, b) => a.y - b.y);
      for (const row of rows) {
        const its = row.items.sort((a, b) => a.x - b.x);
        let text = "", end = null, pic = false;
        for (const it of its) {
          if (it.pic) { pic = true; continue; }
          if (end != null) {
            const gap = it.x - end;
            if (gap > 1.6 * row.h) text += "\t";
            else if (gap > 0.15 * row.h && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
          }
          text += it.str;
          end = it.x + it.w;
        }
        out.push({ text: text.replace(/[ \u00a0]+/g, " "), pic: pic && !text.trim(), x: its[0].x, x2: end == null ? its[0].x : end, y: row.y, h: row.h });
      }
    }
    return out;
  }

  function splitColumns(items, pageW) {
    const text = items.filter((it) => !it.pic && it.str.trim());
    if (text.length < 12 || !pageW) return [items];
    const bin = 2, n = Math.ceil(pageW / bin);
    const cover = new Array(n).fill(0);
    for (const it of text) for (let b = Math.max(0, Math.floor(it.x / bin)); b <= Math.min(n - 1, Math.floor((it.x + it.w) / bin)); b++) cover[b]++;
    // The widest stretch in the middle 30–70% crossed by at most 3% of the text.
    const lim = Math.max(1, Math.floor(text.length * 0.03));
    let best = null;
    for (let a = Math.floor((0.3 * pageW) / bin); a < (0.7 * pageW) / bin; a++) {
      if (cover[a] > lim) continue;
      let b = a;
      while (b + 1 < n && cover[b + 1] <= lim && b + 1 < (0.7 * pageW) / bin) b++;
      if (!best || b - a > best.b - best.a) best = { a, b };
      a = b;
    }
    if (!best || (best.b - best.a + 1) * bin < 10) return [items];
    const mid = ((best.a + best.b + 1) / 2) * bin;
    const left = items.filter((it) => it.x + (it.w || 0) / 2 < mid), right = items.filter((it) => it.x + (it.w || 0) / 2 >= mid);
    const lt = left.filter((it) => !it.pic).length, rt = right.filter((it) => !it.pic).length;
    if (!lt || !rt) return [items];
    return [left, right];
  }

  /* Pictures drawn on a page, and highlight boxes (light green or yellow
   * fills behind a line, as in a scoring guide or a highlighted key), as
   * boxes in page coordinates (top-left origin). */
  async function pageGraphics(lib, page, vp) {
    const ops = await page.getOperatorList();
    const OPS = lib.OPS;
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0], fill = null, path = null;
    const stack = [];
    const pics = [], marks = [];
    const boxOf = (pts) => {
      const vs = pts.map(([u, v]) => vp.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const xs = vs.map((p) => p[0]), ys = vs.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const rgbOf = (args) => {
      if (!args) return null;
      if (typeof args[0] === "string" && /^#[0-9a-f]{6}$/i.test(args[0])) return [1, 3, 5].map((i) => parseInt(args[0].slice(i, i + 2), 16));
      return [args[0], args[1], args[2]].map(Number);
    };
    const highlight = (c) => c && ((c[1] > 190 && c[1] - c[0] > 12 && c[1] - c[2] > 12) || (c[0] > 200 && c[1] > 200 && c[2] < 150));
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push({ ctm, fill });
      else if (fn === OPS.restore) { const st = stack.pop(); if (st) ({ ctm, fill } = st); }
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin && args && args[0]) { stack.push({ ctm, fill }); ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) { const st = stack.pop(); if (st) ({ ctm, fill } = st); }
      else if (fn === OPS.setFillRGBColor) fill = rgbOf(args);
      else if (fn === OPS.setFillGray) fill = [args[0] * 255, args[0] * 255, args[0] * 255];
      else if (fn === OPS.constructPath) path = args && args[2];
      else if ((fn === OPS.fill || fn === OPS.eoFill) && path && highlight(fill)) {
        const [x0, x1, y0, y1] = path;
        const box = boxOf([[x0, y0], [x1, y0], [x0, y1], [x1, y1]]);
        if (box.w > 8 && box.h > 6 && box.h < 72) marks.push(box);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
        const box = boxOf([[0, 0], [1, 0], [0, 1], [1, 1]]);
        // Big enough to be a figure or a screenshot (not an inline symbol).
        if (box.w > 72 && box.h > 54) pics.push(box);
      }
    }
    return { pics, marks };
  }

  /* ---------- the PDF → lines ---------- */

  async function readLines(buf, onProgress) {
    const L = await lib();
    const pdf = await L.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
    const pages = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress && onProgress("Reading the PDF…", (p - 1) / pdf.numPages);
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        items.push({ x, y: y - h * 0.8, w: it.width, h, str: it.str });
        chars += it.str.trim().length;
      }
      let g = { pics: [], marks: [] };
      try { g = await pageGraphics(L, page, vp); } catch (e) { /* optional */ }
      for (const b of g.pics) items.push({ x: b.x, y: b.y, w: b.w, h: 12, str: "", pic: true });
      const lines = pageLines(items, vp.width);
      // A line inside a highlight box is highlighted (a marked answer).
      for (const l of lines) {
        const mid = l.y + (l.h || 10) / 2;
        if (l.text.trim() && g.marks.some((m) => mid >= m.y - 1 && mid <= m.y + m.h + 1 && l.x <= m.x + m.w && (l.x2 || l.x) >= m.x)) l.hl = true;
      }
      pages.push({ page, vp, items, lines, height: vp.height });
    }
    let ocr = false;
    // No text at all: a scanned test. Read it with OCR.
    if (chars < 20 * pdf.numPages && root.MGOcr && root.MGOcr.readLines) {
      ocr = true;
      for (let p = 0; p < pages.length; p++) {
        const { page } = pages[p];
        const vp = page.getViewport({ scale: 2.5 });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const lines = await root.MGOcr.readLines(c, (label, f) => onProgress && onProgress(`Reading page ${p + 1} of ${pages.length} with text recognition…`, (p + (f || 0)) / pages.length));
        pages[p].lines = lines.map((l) => ({ text: l.text, pic: false, x: l.bbox.x0 / 2.5, y: l.bbox.y0 / 2.5, h: (l.bbox.y1 - l.bbox.y0) / 2.5 }));
      }
    }
    onProgress && onProgress("Reading the PDF…", 1);
    // Page headers and footers (the same line, at the same height, at the top
    // or bottom of most pages) are dropped. A line starting with a question
    // number never is.
    const norm = (t) => t.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    const edge = (pg, l) => (l.y < pg.height * 0.1 || l.y > pg.height * 0.9) && l.text.trim() && !QSTART.test(l.text);
    const key = (pg, l) => norm(l.text) + "@" + Math.round(l.y / 6);
    const seen = {};
    for (const pg of pages) for (const k of new Set(pg.lines.filter((l) => edge(pg, l)).map((l) => key(pg, l)))) seen[k] = (seen[k] || 0) + 1;
    const lines = [];
    for (const pg of pages) for (const l of pg.lines) if (!(pages.length >= 3 && edge(pg, l) && seen[key(pg, l)] >= Math.ceil(pages.length * 0.6))) lines.push(l);
    return { pages: pdf.numPages, lines, ocr, chars };
  }

  /* Lines as the paragraphs MGDocx.findItems reads. */
  function toDoc(lines) {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const kids = lines.map((l) => {
      const xml = "<w:p>" + l.text.split("\t").map((part, i) => (i ? "<w:r><w:tab/></w:r>" : "") + (part ? `<w:r><w:t xml:space="preserve">${esc(part)}</w:t></w:r>` : "")).join("") + (l.pic ? "<w:r><w:drawing/></w:r>" : "") + "</w:p>";
      return { kind: "p", xml, text: l.text, pic: !!l.pic, hl: !!l.hl, hasContent: !!l.text.trim() || !!l.pic, breakOnly: false, sect: false, leadBreak: false, trailBreak: false, pbBefore: false, leadN: 0, trailN: 0 };
    });
    return { kids, docXml: "", entries: [], extra: [], fmt: () => undefined, nums: {}, absStart: {}, restart: {} };
  }

  async function open(buf, onProgress) {
    const r = await readLines(buf, onProgress);
    return { doc: toDoc(r.lines), ocr: r.ocr, pages: r.pages, hasText: r.lines.some((l) => l.text.trim()) };
  }

  root.MGPdfRead = { open, readLines, toDoc, _internal: { pageLines, splitColumns } };
})(typeof window !== "undefined" ? window : globalThis);
