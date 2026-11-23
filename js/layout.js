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
  const VERSION_CY = 61.5; // version bubble row (only on tests with versions)
  const VERSION_AREA_TOP = 68; // answers start lower to make room for it
  const VERSION_LABEL_W = 19;
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

  /* Test versions (A, B, C…). One version means the feature is off. */
  const VERSION_LABELS = ["A", "B", "C", "D", "E", "F"];
  function versionLabels(test) {
    const n = Math.max(1, Math.min(VERSION_LABELS.length, parseInt(test.versionCount, 10) || 1));
    return VERSION_LABELS.slice(0, n);
  }

  /* A string that changes whenever the printed bubble layout would change. */
  function layoutSignature(test) {
    return questionChoices(test).map((c) => c.join("")).join("|") + "|v" + versionLabels(test).length;
  }

  /* Compute bubble positions. Returns {questions, columns, error}. */
  function computeLayout(test) {
    const qs = questionChoices(test);
    const n = qs.length;
    if (n === 0) return { questions: [], columns: [], error: "Add at least one question." };
    const avail = AREA_RIGHT - AREA_LEFT;
    // With versions, a "Version" bubble row sits above the answers.
    const vlabels = versionLabels(test);
    const top = vlabels.length > 1 ? VERSION_AREA_TOP : AREA_TOP;
    const maxRows = Math.floor((AREA_BOTTOM - top) / PITCH_Y);
    const minCols = Math.ceil(n / maxRows);
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
        const cy = top + PITCH_Y / 2 + row * PITCH_Y;
        const bubbles = qs[i].map((label, k) => ({
          label,
          cx: x + LABEL_W + PITCH_X / 2 + k * PITCH_X,
          cy,
        }));
        questions.push({ index: i, num: i + 1, col: ci, row, x, cy, bubbles });
      }
      x += col.width + gap;
    });
    let versionRow = null;
    if (vlabels.length > 1) {
      const w = VERSION_LABEL_W + vlabels.length * PITCH_X;
      const x0 = PAGE.w / 2 - w / 2;
      versionRow = {
        x: x0,
        cy: VERSION_CY,
        width: w,
        bubbles: vlabels.map((label, k) => ({ label, cx: x0 + VERSION_LABEL_W + PITCH_X / 2 + k * PITCH_X, cy: VERSION_CY })),
      };
    }
    return { questions, columns, versionRow, error: null };
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

  /* ---------------- drawing (shared by SVG and PDF) ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /**
   * Everything on one answer sheet as a list of simple shapes, in mm on a
   * Letter page (y down). Both the SVG and the PDF are drawn from this list,
   * so they always match each other and the scanner.
   *   { t: "rect", x, y, w, h, fill?, stroke?, sw?, rx? }
   *   { t: "circle", cx, cy, r, fill?, stroke?, sw? }
   *   { t: "line", pts: [[x, y], ...], stroke, sw }      (a polyline)
   *   { t: "text", x, y, size, text, bold?, anchor?, fill? }  (y = baseline)
   *
   * opts: { testCode, sheetCode, title, date, studentName, className, version,
   *         key (array of accepted-label strings, to draw an answer key),
   *         fills (array of label strings to draw as filled — used in tests) }
   */
  function sheetOps(test, opts = {}) {
    const layout = computeLayout(test);
    const ops = [];
    const rect = (x, y, w, h, o) => ops.push({ t: "rect", x, y, w, h, ...o });
    const circle = (cx, cy, r, o) => ops.push({ t: "circle", cx, cy, r, ...o });
    const line = (pts, stroke, sw) => ops.push({ t: "line", pts, stroke, sw });
    const text = (x, y, size, str, o) => ops.push({ t: "text", x, y, size, text: String(str), ...o });

    rect(0, 0, PAGE.w, PAGE.h, { fill: "#fff" });
    for (const k of ["tl", "tr", "br", "bl"]) {
      const [cx, cy] = FIDUCIALS[k];
      const h = FID_SIZE / 2, u = FID_UNIT;
      rect(cx - h, cy - h, FID_SIZE, FID_SIZE, { fill: "#000" });
      rect(cx - h + u, cy - h + u, 5 * u, 5 * u, { fill: "#fff" });
      rect(cx - 1.5 * u, cy - 1.5 * u, 3 * u, 3 * u, { fill: "#000" });
    }

    // ID strip
    encodeSheetCode(opts.testCode || 0, opts.sheetCode || 0).forEach((b, i) => {
      if (b) rect(CODE_X0 + i * CODE_CELL_W, CODE_Y - CODE_CELL_H / 2, CODE_CELL_W + 0.02, CODE_CELL_H, { fill: "#000" });
    });

    // Header
    const isKey = opts.sheetCode === SHEET_KEY;
    text(AREA_LEFT, 31, 5, opts.title || test.title || "Untitled test", { bold: true });
    if (opts.date) text(AREA_RIGHT, 31, 3.6, opts.date, { anchor: "end", fill: "#333" });
    if (isKey) {
      text(AREA_LEFT, 42, 7, "ANSWER KEY" + (opts.version ? " — VERSION " + opts.version : ""), { bold: true });
    } else if (opts.studentName) {
      text(AREA_LEFT, 42, 7, opts.studentName, { bold: true });
    } else {
      text(AREA_LEFT, 42, 4.2, "Name:");
      line([[AREA_LEFT + 13, 42.5], [AREA_LEFT + 95, 42.5]], "#000", 0.3);
    }
    if (opts.className) text(AREA_LEFT, 48.5, 3.6, opts.className, { fill: "#444" });

    // Instructions box (right of header)
    const bx = 128, by = 36, bw = AREA_RIGHT - bx, bh = 14;
    rect(bx, by, bw, bh, { rx: 1.5, stroke: "#999", sw: 0.25 });
    text(bx + 3, by + 5, 3, "Fill bubbles completely and darkly.", { fill: "#222" });
    text(bx + 3, by + 10.5, 3, "Right:", { fill: "#222" });
    circle(bx + 16, by + 9.5, 1.9, { fill: "#222" });
    text(bx + 22, by + 10.5, 3, "Wrong:", { fill: "#222" });
    circle(bx + 36, by + 9.5, 1.9, { stroke: "#555", sw: 0.3 });
    line([[bx + 34.8, by + 9.6], [bx + 35.7, by + 10.6], [bx + 37.5, by + 8.4]], "#222", 0.45);
    circle(bx + 41, by + 9.5, 1.9, { stroke: "#555", sw: 0.3 });
    line([[bx + 39.9, by + 8.4], [bx + 42.1, by + 10.6]], "#222", 0.45);
    line([[bx + 42.1, by + 8.4], [bx + 39.9, by + 10.6]], "#222", 0.45);
    text(bx + 45, by + 10.5, 3, "Erase cleanly.", { fill: "#222" });

    line([[AREA_LEFT, 54], [AREA_RIGHT, 54]], "#000", 0.35);

    if (layout.error) text(PAGE.w / 2, 120, 5, layout.error, { anchor: "middle", fill: "#b00" });

    const bubble = (b, filled) => {
      if (filled) circle(b.cx, b.cy, BUBBLE_R - 0.1, { fill: "#111" });
      else {
        circle(b.cx, b.cy, BUBBLE_R, { stroke: "#333", sw: 0.35 });
        text(b.cx, b.cy + 0.95, 2.6, b.label, { anchor: "middle", fill: "#8a8a8a" });
      }
    };

    // Version row: the student bubbles which version of the test they have.
    if (layout.versionRow) {
      const v = layout.versionRow;
      rect(v.x - 3, v.cy - 5, v.width + 5, 10, { rx: 2, stroke: "#777", sw: 0.3 });
      text(v.x + VERSION_LABEL_W - 2, v.cy + 1.2, 3.4, "VERSION", { bold: true, anchor: "end" });
      for (const b of v.bubbles) bubble(b, opts.version === b.label);
    }

    const fills = opts.fills || (isKey ? opts.key : null) || [];
    for (const q of layout.questions) {
      text(q.x + LABEL_W - 1.6, q.cy + 1.15, 3.2, q.num, { bold: true, anchor: "end" });
      const filled = fills[q.index] || "";
      for (const b of q.bubbles) bubble(b, filled.includes(b.label));
    }

    const foot = isKey
      ? "Answer key — scan to check the key; it is never recorded as a student."
      : `MultiGrader · test ${String(opts.testCode || 0).padStart(5, "0")} · sheet ${opts.sheetCode || 0}`;
    text(PAGE.w / 2, PAGE.h - FID_INSET + 1, 2.6, foot, { anchor: "middle", fill: "#888" });
    return ops;
  }

  /**
   * A graded copy of one student's sheet, to hand back: same layout as the
   * answer sheet, with their answers filled in, a ring around each correct
   * answer, ✓/✗ marks and the score. No corner squares or code strip, so it
   * can never be scanned by mistake. Works in black and white.
   *
   * o: { title, date, studentName, className, version,
   *      items: per printed position { resp, key, all, correct (true/false/null) },
   *      score, possible, pct }
   */
  function gradedSheetOps(test, o = {}) {
    const layout = computeLayout(test);
    const ops = [];
    const rect = (x, y, w, h, s) => ops.push({ t: "rect", x, y, w, h, ...s });
    const circle = (cx, cy, r, s) => ops.push({ t: "circle", cx, cy, r, ...s });
    const line = (pts, stroke, sw) => ops.push({ t: "line", pts, stroke, sw });
    const text = (x, y, size, str, s) => ops.push({ t: "text", x, y, size, text: String(str), ...s });
    const GREEN = "#1a7f45", RED = "#c62828";
    const tick = (x, y, s) => line([[x - 0.9 * s, y], [x - 0.2 * s, y + 0.8 * s], [x + 1.1 * s, y - 0.9 * s]], GREEN, 0.5);
    const cross = (x, y, s) => { line([[x - s, y - s], [x + s, y + s]], RED, 0.5); line([[x + s, y - s], [x - s, y + s]], RED, 0.5); };

    rect(0, 0, PAGE.w, PAGE.h, { fill: "#fff" });
    text(PAGE.w / 2, 16, 2.8, "GRADED COPY — NOT AN ANSWER SHEET", { anchor: "middle", fill: "#888", bold: true });
    text(AREA_LEFT, 31, 5, o.title || test.title || "Untitled test", { bold: true });
    if (o.date) text(AREA_LEFT, 23.5, 3.4, o.date, { fill: "#555" });
    text(AREA_LEFT, 42, 7, o.studentName || "", { bold: true });
    const sub = [o.className, o.version ? "Version " + o.version : ""].filter(Boolean).join(" · ");
    if (sub) text(AREA_LEFT, 48.5, 3.6, sub, { fill: "#444" });

    // Score box
    const bx = 150, by = 24, bw = AREA_RIGHT - bx, bh = 26;
    rect(bx, by, bw, bh, { rx: 2, stroke: "#333", sw: 0.4 });
    text(bx + bw / 2, by + 6, 3.2, "SCORE", { anchor: "middle", bold: true, fill: "#555" });
    const fmt = (x) => (Math.round(x * 100) / 100).toString();
    text(bx + bw / 2, by + 15.5, 8, `${fmt(o.score || 0)} / ${fmt(o.possible || 0)}`, { anchor: "middle", bold: true });
    text(bx + bw / 2, by + 22, 4.2, `${Math.round(o.pct || 0)}%`, { anchor: "middle", fill: "#333" });

    line([[AREA_LEFT, 54], [AREA_RIGHT, 54]], "#000", 0.35);

    if (layout.versionRow) {
      const v = layout.versionRow;
      rect(v.x - 3, v.cy - 5, v.width + 5, 10, { rx: 2, stroke: "#999", sw: 0.3 });
      text(v.x + VERSION_LABEL_W - 2, v.cy + 1.2, 3.4, "VERSION", { bold: true, anchor: "end" });
      for (const b of v.bubbles) {
        if (o.version === b.label) {
          circle(b.cx, b.cy, BUBBLE_R - 0.1, { fill: "#222" });
          text(b.cx, b.cy + 0.95, 2.6, b.label, { anchor: "middle", fill: "#fff", bold: true });
        } else {
          circle(b.cx, b.cy, BUBBLE_R, { stroke: "#777", sw: 0.3 });
          text(b.cx, b.cy + 0.95, 2.6, b.label, { anchor: "middle", fill: "#999" });
        }
      }
    }

    const items = o.items || [];
    for (const q of layout.questions) {
      const it = items[q.index] || { resp: "", key: "", correct: null };
      text(q.x + LABEL_W - 1.6, q.cy + 1.15, 3.2, q.num, { bold: true, anchor: "end" });
      const keyLetters = String(it.key || "").replace("&", "");
      for (const b of q.bubbles) {
        const picked = (it.resp || "").includes(b.label);
        if (picked) {
          circle(b.cx, b.cy, BUBBLE_R - 0.1, { fill: "#222" });
          text(b.cx, b.cy + 0.95, 2.6, b.label, { anchor: "middle", fill: "#fff", bold: true });
        } else {
          circle(b.cx, b.cy, BUBBLE_R, { stroke: "#777", sw: 0.3 });
          text(b.cx, b.cy + 0.95, 2.6, b.label, { anchor: "middle", fill: "#999" });
        }
        // Ring around each correct answer (whether or not it was chosen).
        if (keyLetters.includes(b.label)) circle(b.cx, b.cy, BUBBLE_R + 0.85, { stroke: GREEN, sw: 0.55 });
      }
      const last = q.bubbles[q.bubbles.length - 1];
      const mx = last.cx + BUBBLE_R + 3.2;
      if (it.correct === true) tick(mx, q.cy, 1.2);
      else if (it.correct === false) cross(mx, q.cy, 1.0);
    }

    // Legend
    const ly = PAGE.h - 22;
    let lx = AREA_LEFT;
    circle(lx + 2.4, ly, 2.2, { fill: "#222" });
    text(lx + 6, ly + 1.1, 3, "your answer", { fill: "#333" }); lx += 30;
    circle(lx + 2.4, ly, 2.2, { stroke: "#777", sw: 0.3 });
    circle(lx + 2.4, ly, 3.05, { stroke: GREEN, sw: 0.55 });
    text(lx + 7, ly + 1.1, 3, "ring = correct answer", { fill: "#333" }); lx += 46;
    tick(lx + 1.5, ly, 1.2);
    text(lx + 5, ly + 1.1, 3, "right", { fill: "#333" }); lx += 18;
    cross(lx + 1.5, ly, 1.0);
    text(lx + 5, ly + 1.1, 3, "wrong", { fill: "#333" });
    text(PAGE.w / 2, PAGE.h - 12, 2.6, "MultiGrader · graded copy", { anchor: "middle", fill: "#999" });
    return ops;
  }

  /**
   * A graded copy made from the student's own scanned sheet: the straightened
   * scan as the background, with a ring around each correct answer and ✓/✗
   * drawn on top. The corner squares and code strip are covered (with the
   * "graded copy" label and legend), and the instructions box with the score,
   * so the copy can't be scanned again.
   *
   * o: as for gradedSheetOps, plus image (JPEG bytes of the straightened
   *    scan, covering the whole page) and offsets (per question, from the scan).
   */
  function gradedScanOps(test, o = {}) {
    const layout = computeLayout(test);
    const ops = [];
    const rect = (x, y, w, h, s) => ops.push({ t: "rect", x, y, w, h, ...s });
    const circle = (cx, cy, r, s) => ops.push({ t: "circle", cx, cy, r, ...s });
    const line = (pts, stroke, sw) => ops.push({ t: "line", pts, stroke, sw });
    const text = (x, y, size, str, s) => ops.push({ t: "text", x, y, size, text: String(str), ...s });
    const GREEN = "#1a7f45", RED = "#c62828";
    const tick = (x, y, s) => line([[x - 0.9 * s, y], [x - 0.2 * s, y + 0.8 * s], [x + 1.1 * s, y - 0.9 * s]], GREEN, 0.6);
    const cross = (x, y, s) => { line([[x - s, y - s], [x + s, y + s]], RED, 0.6); line([[x + s, y - s], [x - s, y + s]], RED, 0.6); };

    rect(0, 0, PAGE.w, PAGE.h, { fill: "#fff" });
    // Show the scan only where there's content (header, version row, answer
    // columns); the margins, where fingers holding the sheet usually are,
    // stay white.
    const clip = [{ x: AREA_LEFT - 3, y: 26.5, w: AREA_RIGHT - AREA_LEFT + 6, h: 29 }];
    if (layout.versionRow) {
      const v = layout.versionRow;
      clip.push({ x: v.x - 5, y: v.cy - 7, w: v.width + 9, h: 14 });
    }
    const offs = o.offsets || [];
    for (const col of layout.columns) {
      const qs = layout.questions.filter((q) => q.index >= col.start && q.index < col.end);
      if (!qs.length) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of qs) {
        const [dx, dy] = offs[q.index] || [0, 0];
        x0 = Math.min(x0, q.x + dx); x1 = Math.max(x1, q.x + dx + col.width);
        y0 = Math.min(y0, q.cy + dy - PITCH_Y / 2); y1 = Math.max(y1, q.cy + dy + PITCH_Y / 2);
      }
      clip.push({ x: x0 - 1.5, y: y0 - 1, w: x1 - x0 + 3, h: y1 - y0 + 2 });
    }
    ops.push({ t: "image", x: 0, y: 0, w: PAGE.w, h: PAGE.h, jpeg: o.image, clip });

    // Cover the corner squares and code strip (top and bottom bands).
    rect(6, 6, PAGE.w - 12, 20.5, { fill: "#fff" });
    rect(6, PAGE.h - 26, PAGE.w - 12, 20, { fill: "#fff" });
    text(PAGE.w / 2, 17, 3, "GRADED COPY — NOT AN ANSWER SHEET", { anchor: "middle", fill: "#666", bold: true });
    text(AREA_LEFT, 23.5, 3.2, [o.studentName, o.date].filter(Boolean).join(" · "), { fill: "#444", bold: true });

    // Score box over the instructions box.
    const bx = 124, by = 31, bw = AREA_RIGHT + 3 - bx, bh = 22;
    rect(bx, by, bw, bh, { rx: 2, fill: "#fff", stroke: "#333", sw: 0.4 });
    text(bx + bw / 2, by + 5.5, 3, "SCORE", { anchor: "middle", bold: true, fill: "#555" });
    const fmt = (x) => (Math.round(x * 100) / 100).toString();
    text(bx + bw / 2, by + 13.5, 7, `${fmt(o.score || 0)} / ${fmt(o.possible || 0)}`, { anchor: "middle", bold: true });
    text(bx + bw / 2, by + 19.3, 3.8, `${Math.round(o.pct || 0)}%`, { anchor: "middle", fill: "#333" });

    const items = o.items || [];
    const offsets = o.offsets || [];
    for (const q of layout.questions) {
      const it = items[q.index] || { resp: "", key: "", correct: null };
      const [dx, dy] = offsets[q.index] || [0, 0];
      const keyLetters = String(it.key || "").replace("&", "");
      for (const b of q.bubbles) {
        if (keyLetters.includes(b.label)) circle(b.cx + dx, b.cy + dy, BUBBLE_R + 0.9, { stroke: GREEN, sw: 0.6 });
      }
      const last = q.bubbles[q.bubbles.length - 1];
      const mx = last.cx + dx + BUBBLE_R + 3.4, my = q.cy + dy;
      if (it.correct === true) tick(mx, my, 1.25);
      else if (it.correct === false) cross(mx, my, 1.05);
      // Answers the teacher corrected in Review: say what was graded.
      if (it.edited) text(mx + 2.6, my + 1, 2.5, `(graded as ${it.resp ? it.resp.split("").join("+") : "blank"})`, { fill: "#2457c5" });
    }

    // Legend in the bottom band.
    const ly = PAGE.h - 17;
    let lx = AREA_LEFT;
    circle(lx + 2.4, ly, 2.2, { stroke: "#777", sw: 0.3 });
    circle(lx + 2.4, ly, 3.1, { stroke: GREEN, sw: 0.6 });
    text(lx + 7, ly + 1.1, 3, "ring = correct answer", { fill: "#333" }); lx += 46;
    tick(lx + 1.5, ly, 1.25);
    text(lx + 5, ly + 1.1, 3, "right", { fill: "#333" }); lx += 18;
    cross(lx + 1.5, ly, 1.05);
    text(lx + 5, ly + 1.1, 3, "wrong", { fill: "#333" });
    text(AREA_RIGHT, ly + 1.1, 2.6, "MultiGrader · graded copy of the scanned sheet", { anchor: "end", fill: "#999" });
    return ops;
  }

  const n3 = (v) => (Math.round(v * 1000) / 1000).toString();

  /* Render one answer sheet as an SVG string sized to a Letter page. */
  function renderSheetSVG(test, opts = {}) {
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" class="sheet-svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" width="${PAGE.w}mm" height="${PAGE.h}mm" font-family="Helvetica, Arial, sans-serif">`,
    ];
    for (const o of sheetOps(test, opts)) {
      const paint = `fill="${o.fill || "none"}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw}"` : ""}`;
      if (o.t === "rect") parts.push(`<rect x="${n3(o.x)}" y="${n3(o.y)}" width="${n3(o.w)}" height="${n3(o.h)}"${o.rx ? ` rx="${o.rx}"` : ""} ${paint}/>`);
      else if (o.t === "circle") parts.push(`<circle cx="${n3(o.cx)}" cy="${n3(o.cy)}" r="${n3(o.r)}" ${paint}/>`);
      else if (o.t === "line") parts.push(`<polyline points="${o.pts.map((p) => n3(p[0]) + "," + n3(p[1])).join(" ")}" fill="none" stroke="${o.stroke}" stroke-width="${o.sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
      else if (o.t === "text") {
        parts.push(`<text x="${n3(o.x)}" y="${n3(o.y)}" font-size="${o.size}"${o.bold ? ' font-weight="700"' : ""}${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""}${o.fill ? ` fill="${o.fill}"` : ""}>${esc(o.text)}</text>`);
      }
    }
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
    versionLabels,
    VERSION_LABELS,
    computeLayout,
    encodeSheetCode,
    decodeSheetCode,
    codeCellCenters,
    renderSheetSVG,
    sheetOps,
    gradedSheetOps,
    gradedScanOps,
  };
})(typeof window !== "undefined" ? window : globalThis);
