/* MultiGrader — write answer sheets as a PDF (no libraries).
 *
 * Draws the same shape list as the on-screen sheet (MGLayout.sheetOps) as
 * vector graphics on exact Letter-size pages, using the PDF built-in
 * Helvetica fonts (nothing to embed). The PDF asks viewers to print at actual
 * size (/PrintScaling /None).
 */
(function (root) {
  "use strict";
  const L = root.MGLayout;
  const K = 72 / 25.4; // mm → pt
  const PAGE_W = 612, PAGE_H = 792; // Letter in points

  // Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32–126.
  const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

  // Unicode → WinAnsiEncoding byte for characters outside Latin-1.
  const WIN = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
  // Letters with no Unicode decomposition to a plain letter.
  const PLAIN = { "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ħ": "H", "ħ": "h", "ı": "i", "Ŀ": "L", "ŀ": "l", "Ŧ": "T", "ŧ": "t", "ʼ": "'", "‐": "-", "‑": "-", "−": "-" };
  const WIDE = { 0x85: 1000, 0x89: 1000, 0x8c: 1000, 0x97: 1000, 0x99: 1000, 0x9c: 944, 0x96: 556, 0x95: 350, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0xb7: 278, 0xa0: 278 };

  /* Encode text as WinAnsi bytes; characters it can't hold fall back to their
   * unaccented letter, or "?". */
  function winAnsi(str) {
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c >= 32 && c < 127) out.push(c);
      else if (c >= 0xa0 && c <= 0xff) out.push(c);
      else if (WIN[ch]) out.push(WIN[ch]);
      else {
        const base = (PLAIN[ch] || ch.normalize("NFD").replace(/[̀-ͯ]/g, ""));
        const b = base.codePointAt(0);
        out.push(base && b >= 32 && b < 127 ? b : 63);
      }
    }
    return out;
  }

  function widthOf(bytes, bold) {
    const tbl = bold ? W_BOLD : W_REG;
    let w = 0;
    for (const b of bytes) {
      if (b >= 32 && b < 127) w += tbl[b - 32];
      else if (WIDE[b]) w += WIDE[b];
      else {
        // Accented Latin-1 letters: use the width of the plain letter.
        const base = String.fromCharCode(b).normalize("NFD").charCodeAt(0);
        w += base >= 32 && base < 127 ? tbl[base - 32] : 556;
      }
    }
    return w / 1000;
  }

  function pdfString(bytes) {
    let s = "(";
    for (const b of bytes) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
      else if (b < 32 || b > 126) s += "\\" + b.toString(8).padStart(3, "0");
      else s += String.fromCharCode(b);
    }
    return s + ")";
  }

  const f = (v) => (Math.round(v * 100) / 100).toString();
  const X = (x) => f(x * K);
  const Y = (y) => f((L.PAGE.h - y) * K);
  function rgb(hex) {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => f(parseInt(full.slice(i, i + 2), 16) / 255)).join(" ");
  }

  const KAPPA = 0.5522847498;
  function circlePath(cx, cy, r) {
    const k = r * KAPPA;
    const p = (x, y) => `${X(x)} ${Y(y)}`;
    return `${p(cx + r, cy)} m ` +
      `${p(cx + r, cy + k)} ${p(cx + k, cy + r)} ${p(cx, cy + r)} c ` +
      `${p(cx - k, cy + r)} ${p(cx - r, cy + k)} ${p(cx - r, cy)} c ` +
      `${p(cx - r, cy - k)} ${p(cx - k, cy - r)} ${p(cx, cy - r)} c ` +
      `${p(cx + k, cy - r)} ${p(cx + r, cy - k)} ${p(cx + r, cy)} c h`;
  }
  function roundRectPath(x, y, w, h, r) {
    if (!r) return `${X(x)} ${Y(y + h)} ${f(w * K)} ${f(h * K)} re`;
    const k = r * KAPPA;
    const p = (a, b) => `${X(a)} ${Y(b)}`;
    return `${p(x + r, y)} m ${p(x + w - r, y)} l ${p(x + w - r + k, y)} ${p(x + w, y + r - k)} ${p(x + w, y + r)} c ` +
      `${p(x + w, y + h - r)} l ${p(x + w, y + h - r + k)} ${p(x + w - r + k, y + h)} ${p(x + w - r, y + h)} c ` +
      `${p(x + r, y + h)} l ${p(x + r - k, y + h)} ${p(x, y + h - r + k)} ${p(x, y + h - r)} c ` +
      `${p(x, y + r)} l ${p(x, y + r - k)} ${p(x + r - k, y)} ${p(x + r, y)} c h`;
  }

  /* PDF page content for one sheet's shape list. */
  /* Width, height and colour components of a JPEG, from its SOF marker. */
  function jpegInfo(b) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }

  /* PDF page content for one sheet's shape list. images: name → op, filled in
   * for { t: "image", x, y, w, h, jpeg: Uint8Array } shapes. */
  function pageContent(ops, images) {
    const out = ["1 J 1 j"]; // round caps/joins (check marks)
    for (const o of ops) {
      if (o.t === "image" && images) {
        const name = "Im" + (Object.keys(images).length + 1);
        images[name] = o;
        out.push(`q ${f(o.w * K)} 0 0 ${f(o.h * K)} ${X(o.x)} ${Y(o.y + o.h)} cm /${name} Do Q`);
      } else if (o.t === "rect" || o.t === "circle") {
        const path = o.t === "rect" ? roundRectPath(o.x, o.y, o.w, o.h, o.rx) : circlePath(o.cx, o.cy, o.r);
        if (o.fill && o.fill !== "none") out.push(`${rgb(o.fill)} rg ${path} f`);
        if (o.stroke) out.push(`${rgb(o.stroke)} RG ${f(o.sw * K)} w ${path} S`);
      } else if (o.t === "line") {
        out.push(`${rgb(o.stroke)} RG ${f(o.sw * K)} w ` + o.pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? "l" : "m"}`).join(" ") + " S");
      } else if (o.t === "text") {
        const bytes = winAnsi(o.text);
        const size = o.size * K;
        const w = widthOf(bytes, o.bold) * size;
        let x = o.x * K;
        if (o.anchor === "end") x -= w;
        else if (o.anchor === "middle") x -= w / 2;
        out.push(`BT ${rgb(o.fill || "#000")} rg /${o.bold ? "F2" : "F1"} ${f(size)} Tf ${f(x)} ${Y(o.y)} Td ${pdfString(bytes)} Tj ET`);
      }
    }
    return out.join("\n");
  }

  const enc = new TextEncoder();

  async function deflate(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("deflate");
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  /**
   * Build a PDF from a list of sheets (each a shape list from sheetOps).
   * Returns a Blob (application/pdf).
   */
  async function sheetsToPDF(sheets, info = {}) {
    const objs = []; // index = object number - 1; each entry: array of Uint8Array/string parts
    const add = (parts) => { objs.push(parts); return objs.length; };
    const catalogNo = add(null), pagesNo = add(null);
    const f1 = add([`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`]);
    const f2 = add([`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`]);
    const pageNos = [];
    for (const ops of sheets) {
      const images = {};
      const raw = enc.encode(pageContent(ops, images));
      const z = await deflate(raw);
      const data = z || raw;
      const contentNo = add([`<< /Length ${data.length}${z ? " /Filter /FlateDecode" : ""} >>\nstream\n`, data, `\nendstream`]);
      // Photos are embedded as-is (JPEG = DCTDecode), no re-encoding.
      const xo = [];
      for (const [name, im] of Object.entries(images)) {
        const info = jpegInfo(im.jpeg);
        if (!info) continue;
        const cs = info.comps === 1 ? "/DeviceGray" : info.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
        const n = add([`<< /Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`, im.jpeg, `\nendstream`]);
        xo.push(`/${name} ${n} 0 R`);
      }
      const xres = xo.length ? ` /XObject << ${xo.join(" ")} >>` : "";
      pageNos.push(add([`<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xres} >> /Contents ${contentNo} 0 R >>`]));
    }
    objs[pagesNo - 1] = [`<< /Type /Pages /Kids [${pageNos.map((n) => n + " 0 R").join(" ")}] /Count ${pageNos.length} >>`];
    objs[catalogNo - 1] = [`<< /Type /Catalog /Pages ${pagesNo} 0 R /ViewerPreferences << /PrintScaling /None >> >>`];
    // Document info strings use UTF-16 (with a byte-order mark), not WinAnsi.
    const utf16 = (s) => "<FEFF" + Array.from(String(s)).map((ch) => {
      const c = ch.codePointAt(0);
      const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
      return units.map((u) => u.toString(16).padStart(4, "0").toUpperCase()).join("");
    }).join("") + ">";
    const title = utf16(info.title || "MultiGrader answer sheets");
    const infoNo = add([`<< /Title ${title} /Producer (MultiGrader) >>`]);

    const chunks = [];
    let offset = 0;
    const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); offset += b.length; };
    push("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "binary file" marker comment
    const xref = [];
    objs.forEach((parts, i) => {
      xref.push(offset);
      push(`${i + 1} 0 obj\n`);
      parts.forEach(push);
      push(`\nendobj\n`);
    });
    const xrefAt = offset;
    push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + xref.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join(""));
    push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  root.MGPdf = { sheetsToPDF, jpegInfo, _internal: { winAnsi, widthOf, pageContent } };
})(typeof window !== "undefined" ? window : globalThis);
