/* MultiGrader — answer-sheet geometry, sheet ID code, and SVG rendering.
 *
 * Everything on the printed sheet is positioned in millimetres on a US Letter
 * page. The scanner uses the SAME functions to know where every bubble is, so
 * the printed sheet and the scanner can never disagree about the layout.
 */
(function (root) {
  "use strict";

  const PAGE = { w: 215.9, h: 279.4 };

  // Corner fiducials: QR-style finder squares (7u black, 5u white, 3u black).
  const FID_UNIT = 1.5;
  const FID_SIZE = 7 * FID_UNIT; // 10.5 mm
  const FID_INSET = 18; // centre distance from page edge
  const FIDUCIALS = {
    tl: [FID_INSET, FID_INSET],
    tr: [PAGE.w - FID_INSET, FID_INSET],
    br: [PAGE.w - FID_INSET, PAGE.h - FID_INSET],
    bl: [FID_INSET, PAGE.h - FID_INSET],
  };

  // Sheet ID strip (between the two top fiducials): 38 black/white cells.
  //   2 version bits (1,0) + 16-bit test code + 12-bit sheet code + CRC-8
  const CODE_BITS = 38;
  const CODE_CELL_W = 3.4;
  const CODE_CELL_H = 5;
  const CODE_Y = FID_INSET; // centre line
  const CODE_X0 = PAGE.w / 2 - (CODE_BITS * CODE_CELL_W) / 2;

  // Reserved sheet codes
  const SHEET_KEY = 4095; // printed answer key (scan to self-check, never saved)

  // Answer grid
  const BUBBLE_R = 2.4;
  const PITCH_X = 6.2;
  const PITCH_Y = 7.0;
  const LABEL_W = 8.5;
  const COL_GAP = 7;
  const AREA_TOP = 60;
  const AREA_BOTTOM = 252;
  const AREA_LEFT = 14;
  const AREA_RIGHT = 202;
  const MAX_ROWS = Math.floor((AREA_BOTTOM - AREA_TOP) / PITCH_Y); // 27
  const MAX_CHOICES = 6;

  /* Question-type presets. `choices` are single-character bubble labels. */
  const PRESETS = [
    { id: "TF", name: "True / False", choices: ["T", "F"] },
    { id: "ASN", name: "Always / Sometimes / Never", choices: ["A", "S", "N"] },
    { id: "AB", name: "A–B", choices: ["A", "B"] },
    { id: "AC", name: "A–C", choices: ["A", "B", "C"] },
    { id: "AD", name: "A–D", choices: ["A", "B", "C", "D"] },
    { id: "AE", name: "A–E", choices: ["A", "B", "C", "D", "E"] },
    { id: "AF", name: "A–F", choices: ["A", "B", "C", "D", "E", "F"] },
    { id: "YN", name: "Yes / No", choices: ["Y", "N"] },
  ];

  function sectionChoices(section) {
    if (section.type === "custom") {
      const chars = Array.from((section.custom || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
      const uniq = [...new Set(chars)].slice(0, MAX_CHOICES);
      return uniq.length >= 2 ? uniq : ["A", "B"];
    }
    const p = PRESETS.find((x) => x.id === section.type);
    return p ? p.choices.slice() : ["A", "B", "C", "D"];
  }

  /* One entry per question: the list of bubble labels. */
  function questionChoices(test) {
    const out = [];
    for (const s of test.sections || []) {
      const ch = sectionChoices(s);
      const n = Math.max(0, Math.min(200, parseInt(s.count, 10) || 0));
      for (let i = 0; i < n; i++) out.push(ch);
    }
    return out;
  }

  /* A string that changes whenever the printed bubble layout would change. */
  function layoutSignature(test) {
    return questionChoices(test).map((c) => c.join("")).join("|");
  }

  /* Compute bubble positions. Returns {questions, columns, error}. */
  function computeLayout(test) {
    const qs = questionChoices(test);
    const n = qs.length;
    if (n === 0) return { questions: [], columns: [], error: "Add at least one question." };
    const avail = AREA_RIGHT - AREA_LEFT;
    const minCols = Math.ceil(n / MAX_ROWS);
    // Prefer columns of about 15 rows so short tests spread across the page;
    // fall back to fewer, longer columns when wide questions don't fit.
    const build = (ncols) => {
      const rows = Math.ceil(n / ncols);
      const cols = [];
      for (let c = 0; c < ncols; c++) {
        const start = c * rows;
        const end = Math.min(n, start + rows);
        if (start >= end) break;
        let maxCh = 0;
        for (let i = start; i < end; i++) maxCh = Math.max(maxCh, qs[i].length);
        cols.push({ start, end, width: LABEL_W + maxCh * PITCH_X });
      }
      return cols;
    };
    const widthOf = (cols) => cols.reduce((a, c) => a + c.width, 0) + COL_GAP * (cols.length - 1);
    let columns = null;
    for (let nc = Math.max(minCols, Math.min(4, Math.ceil(n / 15))); nc >= minCols; nc--) {
      const cols = build(nc);
      if (widthOf(cols) <= avail + 1e-6) { columns = cols; break; }
    }
    if (!columns) {
      return {
        questions: [],
        columns: [],
        error: `Too many questions to fit on one sheet (${n}). Try fewer questions or fewer answer choices.`,
      };
    }
    // Spread spare width into the gaps (capped) and centre the block.
    let gap = COL_GAP;
    if (columns.length > 1) gap = Math.min(COL_GAP * 2.5, COL_GAP + (avail - widthOf(columns)) / (columns.length - 1));
    const used = columns.reduce((a, c) => a + c.width, 0) + gap * (columns.length - 1);
    let x = AREA_LEFT + (avail - used) / 2;
    const questions = [];
    columns.forEach((col, ci) => {
      col.x = x;
      for (let i = col.start; i < col.end; i++) {
        const row = i - col.start;
        const cy = AREA_TOP + PITCH_Y / 2 + row * PITCH_Y;
        const bubbles = qs[i].map((label, k) => ({
          label,
          cx: x + LABEL_W + PITCH_X / 2 + k * PITCH_X,
          cy,
        }));
        questions.push({ index: i, num: i + 1, col: ci, row, x, cy, bubbles });
      }
      x += col.width + gap;
    });
    return { questions, columns, error: null };
  }

  /* ---------------- Sheet ID code ---------------- */

  function crc8(bits) {
    let crc = 0x5a;
    for (const b of bits) {
      const top = (crc >> 7) & 1;
      crc = (crc << 1) & 0xff;
      if (top ^ b) crc ^= 0x07;
    }
    return crc;
  }

  function toBits(value, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
    return out;
  }

  function fromBits(bits) {
    return bits.reduce((v, b) => (v << 1) | b, 0);
  }

  function encodeSheetCode(testCode, sheetCode) {
    const payload = [1, 0, ...toBits(testCode & 0xffff, 16), ...toBits(sheetCode & 0xfff, 12)];
    return payload.concat(toBits(crc8(payload), 8));
  }

  function decodeSheetCode(bits) {
    if (bits.length !== CODE_BITS || bits[0] !== 1 || bits[1] !== 0) return null;
    const payload = bits.slice(0, 30);
    if (crc8(payload) !== fromBits(bits.slice(30))) return null;
    return { testCode: fromBits(bits.slice(2, 18)), sheetCode: fromBits(bits.slice(18, 30)) };
  }

  function codeCellCenters() {
    const out = [];
    for (let i = 0; i < CODE_BITS; i++) out.push([CODE_X0 + (i + 0.5) * CODE_CELL_W, CODE_Y]);
    return out;
  }

  /* ---------------- SVG rendering ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fiducialSVG([cx, cy]) {
    const h = FID_SIZE / 2;
    const u = FID_UNIT;
    return (
      `<rect x="${cx - h}" y="${cy - h}" width="${FID_SIZE}" height="${FID_SIZE}" fill="#000"/>` +
      `<rect x="${cx - h + u}" y="${cy - h + u}" width="${5 * u}" height="${5 * u}" fill="#fff"/>` +
      `<rect x="${cx - 1.5 * u}" y="${cy - 1.5 * u}" width="${3 * u}" height="${3 * u}" fill="#000"/>`
    );
  }

  /**
   * Render one answer sheet as an SVG string sized to a Letter page.
   * opts: { testCode, sheetCode, title, date, studentName, className,
   *         key (array of accepted-label strings, to draw an answer key),
   *         fills (array of label strings to draw as filled — used in tests) }
   */
  function renderSheetSVG(test, opts = {}) {
    const layout = computeLayout(test);
    const parts = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" class="sheet-svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" width="${PAGE.w}mm" height="${PAGE.h}mm" font-family="Helvetica, Arial, sans-serif">`
    );
    parts.push(`<rect x="0" y="0" width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>`);
    for (const k of ["tl", "tr", "br", "bl"]) parts.push(fiducialSVG(FIDUCIALS[k]));

    // ID strip
    const bits = encodeSheetCode(opts.testCode || 0, opts.sheetCode || 0);
    bits.forEach((b, i) => {
      if (b) {
        parts.push(
          `<rect x="${(CODE_X0 + i * CODE_CELL_W).toFixed(3)}" y="${CODE_Y - CODE_CELL_H / 2}" width="${CODE_CELL_W + 0.02}" height="${CODE_CELL_H}" fill="#000"/>`
        );
      }
    });

    // Header
    const isKey = opts.sheetCode === SHEET_KEY;
    parts.push(`<text x="${AREA_LEFT}" y="31" font-size="5" font-weight="700">${esc(opts.title || test.title || "Untitled test")}</text>`);
    if (opts.date) parts.push(`<text x="${AREA_RIGHT}" y="31" font-size="3.6" text-anchor="end" fill="#333">${esc(opts.date)}</text>`);
    if (isKey) {
      parts.push(`<text x="${AREA_LEFT}" y="42" font-size="7" font-weight="700">ANSWER KEY</text>`);
    } else if (opts.studentName) {
      parts.push(`<text x="${AREA_LEFT}" y="42" font-size="7" font-weight="700">${esc(opts.studentName)}</text>`);
    } else {
      parts.push(`<text x="${AREA_LEFT}" y="42" font-size="4.2">Name:</text>`);
      parts.push(`<line x1="${AREA_LEFT + 13}" y1="42.5" x2="${AREA_LEFT + 95}" y2="42.5" stroke="#000" stroke-width="0.3"/>`);
    }
    if (opts.className) parts.push(`<text x="${AREA_LEFT}" y="48.5" font-size="3.6" fill="#444">${esc(opts.className)}</text>`);

    // Instructions box (right of header)
    const bx = 128, by = 36, bw = AREA_RIGHT - bx, bh = 14;
    parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="1.5" fill="none" stroke="#999" stroke-width="0.25"/>`);
    parts.push(`<text x="${bx + 3}" y="${by + 5}" font-size="3" fill="#222">Fill one bubble completely, dark.</text>`);
    parts.push(`<text x="${bx + 3}" y="${by + 10.5}" font-size="3" fill="#222">Right:</text>`);
    parts.push(`<circle cx="${bx + 16}" cy="${by + 9.5}" r="1.9" fill="#222"/>`);
    parts.push(`<text x="${bx + 22}" y="${by + 10.5}" font-size="3" fill="#222">Wrong:</text>`);
    parts.push(`<circle cx="${bx + 36}" cy="${by + 9.5}" r="1.9" fill="none" stroke="#555" stroke-width="0.3"/>`);
    parts.push(`<path d="M${bx + 34.8} ${by + 9.6} l0.9 1 l1.8 -2.2" fill="none" stroke="#222" stroke-width="0.45"/>`);
    parts.push(`<circle cx="${bx + 41}" cy="${by + 9.5}" r="1.9" fill="none" stroke="#555" stroke-width="0.3"/>`);
    parts.push(`<path d="M${bx + 39.9} ${by + 8.4} l2.2 2.2 M${bx + 42.1} ${by + 8.4} l-2.2 2.2" stroke="#222" stroke-width="0.45"/>`);
    parts.push(`<text x="${bx + 45}" y="${by + 10.5}" font-size="3" fill="#222">Erase cleanly.</text>`);

    parts.push(`<line x1="${AREA_LEFT}" y1="54" x2="${AREA_RIGHT}" y2="54" stroke="#000" stroke-width="0.35"/>`);

    if (layout.error) {
      parts.push(`<text x="${PAGE.w / 2}" y="120" font-size="5" text-anchor="middle" fill="#b00">${esc(layout.error)}</text>`);
    }

    const fills = opts.fills || (isKey ? opts.key : null) || [];
    for (const q of layout.questions) {
      parts.push(
        `<text x="${q.x + LABEL_W - 1.6}" y="${q.cy + 1.15}" font-size="3.2" font-weight="700" text-anchor="end">${q.num}</text>`
      );
      const filled = fills[q.index] || "";
      for (const b of q.bubbles) {
        if (filled.includes(b.label)) {
          parts.push(`<circle cx="${b.cx.toFixed(3)}" cy="${b.cy.toFixed(3)}" r="${BUBBLE_R - 0.1}" fill="#111"/>`);
        } else {
          parts.push(
            `<circle cx="${b.cx.toFixed(3)}" cy="${b.cy.toFixed(3)}" r="${BUBBLE_R}" fill="none" stroke="#333" stroke-width="0.35"/>` +
              `<text x="${b.cx.toFixed(3)}" y="${(b.cy + 0.95).toFixed(3)}" font-size="2.6" text-anchor="middle" fill="#8a8a8a">${esc(b.label)}</text>`
          );
        }
      }
    }

    const foot = isKey
      ? "Answer key — scan to check the key; it is never recorded as a student."
      : `MultiGrader · test ${String(opts.testCode || 0).padStart(5, "0")} · sheet ${opts.sheetCode || 0}`;
    parts.push(`<text x="${PAGE.w / 2}" y="${PAGE.h - FID_INSET + 1}" font-size="2.6" text-anchor="middle" fill="#888">${esc(foot)}</text>`);
    parts.push(`</svg>`);
    return parts.join("");
  }

  root.MGLayout = {
    PAGE,
    FIDUCIALS,
    FID_SIZE,
    CODE_BITS,
    CODE_CELL_W,
    CODE_CELL_H,
    BUBBLE_R,
    PITCH_X,
    PITCH_Y,
    MAX_ROWS,
    MAX_CHOICES,
    SHEET_KEY,
    PRESETS,
    sectionChoices,
    questionChoices,
    layoutSignature,
    computeLayout,
    encodeSheetCode,
    decodeSheetCode,
    codeCellCenters,
    renderSheetSVG,
  };
})(typeof window !== "undefined" ? window : globalThis);
