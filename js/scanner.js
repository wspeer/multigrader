/* MultiGrader — answer-sheet scanner (pure JavaScript, no dependencies).
 *
 * Pipeline for one image:
 *   1. Greyscale, then a downscaled copy for detection.
 *   2. Adaptive threshold + connected components to find the four QR-style
 *      corner markers (a ring with a concentric solid centre).
 *   3. Refine each marker centre at full resolution.
 *   4. For each way the sheet could be rotated, fit a homography (page mm →
 *      image pixels) and try to read the 38-cell ID strip. A valid checksum
 *      tells us both the orientation and which test/sheet this is.
 *   5. Fine-align blocks of bubbles against their printed outlines (absorbs
 *      paper curl), then measure how dark each bubble is and decide answers.
 */
(function (root) {
  "use strict";
  const L = root.MGLayout;

  /* ---------------- image helpers ---------------- */

  function toGray(img) {
    const { width: w, height: h, data } = img;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    return { w, h, g };
  }

  function downscale(G, maxDim) {
    const s = Math.max(1, Math.ceil(Math.max(G.w, G.h) / maxDim));
    if (s === 1) return { img: G, scale: 1 };
    const w = Math.floor(G.w / s), h = Math.floor(G.h / s);
    const out = new Uint8ClampedArray(w * h);
    const n = s * s;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let yy = 0; yy < s; yy++) {
          let idx = (y * s + yy) * G.w + x * s;
          for (let xx = 0; xx < s; xx++) sum += G.g[idx++];
        }
        out[y * w + x] = sum / n;
      }
    }
    return { img: { w, h, g: out }, scale: s };
  }

  function sample(G, u, v) {
    const { w, h, g } = G;
    if (!(u >= 0 && v >= 0 && u < w - 1 && v < h - 1)) return 255;
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
    const i = y0 * w + x0;
    const a = g[i], b = g[i + 1], c = g[i + w], d = g[i + w + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /* ---------------- geometry ---------------- */

  function solveHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    h.push(1);
    return h;
  }

  function project(H, x, y) {
    const z = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
  }

  function sampleAt(G, H, x, y) {
    const z = H[6] * x + H[7] * y + H[8];
    return sample(G, (H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z);
  }

  /* ---------------- marker detection ---------------- */

  function threshold(G) {
    const { w, h, g } = G;
    const W = w + 1;
    const integ = new Uint32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += g[y * w + x];
        integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.max(w, h) / 14));
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        const area = (y1 - y0) * (x1 - x0);
        if (g[y * w + x] * area < sum * 0.78) dark[y * w + x] = 1;
      }
    }
    return dark;
  }

  function components(dark, w, h) {
    const lab = new Int32Array(w * h);
    let parent = new Int32Array(4096);
    let next = 1;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!dark[i]) continue;
        let l = 0;
        const nb = [];
        if (x > 0 && lab[i - 1]) nb.push(lab[i - 1]);
        if (y > 0) {
          if (lab[i - w]) nb.push(lab[i - w]);
          if (x > 0 && lab[i - w - 1]) nb.push(lab[i - w - 1]);
          if (x < w - 1 && lab[i - w + 1]) nb.push(lab[i - w + 1]);
        }
        if (nb.length === 0) {
          if (next >= parent.length) { const p2 = new Int32Array(parent.length * 2); p2.set(parent); parent = p2; }
          parent[next] = next;
          l = next++;
        } else {
          l = nb[0];
          for (let k = 1; k < nb.length; k++) { union(l, nb[k]); }
          l = find(l);
        }
        lab[i] = l;
      }
    }
    const area = new Float64Array(next), sx = new Float64Array(next), sy = new Float64Array(next);
    const minx = new Int32Array(next).fill(1e9), miny = new Int32Array(next).fill(1e9);
    const maxx = new Int32Array(next).fill(-1), maxy = new Int32Array(next).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!lab[i]) continue;
        const l = find(lab[i]);
        lab[i] = l;
        area[l]++; sx[l] += x; sy[l] += y;
        if (x < minx[l]) minx[l] = x; if (x > maxx[l]) maxx[l] = x;
        if (y < miny[l]) miny[l] = y; if (y > maxy[l]) maxy[l] = y;
      }
    }
    return { lab, area, sx, sy, minx, miny, maxx, maxy, count: next };
  }

  function findMarkerCandidates(G) {
    const { w, h } = G;
    const dark = threshold(G);
    const C = components(dark, w, h);
    const out = [];
    for (let l = 1; l < C.count; l++) {
      const a = C.area[l];
      if (a < 20) continue;
      const bw = C.maxx[l] - C.minx[l] + 1, bh = C.maxy[l] - C.miny[l] + 1;
      if (bw < 7 || bh < 7) continue;
      const asp = bw / bh;
      if (asp < 0.4 || asp > 2.5) continue;
      const fill = a / (bw * bh);
      if (fill < 0.15 || fill > 0.8) continue;
      const cx = C.sx[l] / a, cy = C.sy[l] / a;
      if (Math.abs(cx - (C.minx[l] + C.maxx[l]) / 2) > 0.15 * bw) continue;
      if (Math.abs(cy - (C.miny[l] + C.maxy[l]) / 2) > 0.15 * bh) continue;
      // The pixel at the ring's centroid must belong to a separate solid blob.
      const il = C.lab[Math.round(cy) * w + Math.round(cx)];
      if (!il || il === l) continue;
      const ia = C.area[il];
      const iw = C.maxx[il] - C.minx[il] + 1, ih = C.maxy[il] - C.miny[il] + 1;
      if (C.minx[il] <= C.minx[l] || C.maxx[il] >= C.maxx[l] || C.miny[il] <= C.miny[l] || C.maxy[il] >= C.maxy[l]) continue;
      const ratio = ia / a;
      if (ratio < 0.1 || ratio > 1.3) continue;
      const rw = iw / bw, rh = ih / bh;
      if (rw < 0.2 || rw > 0.7 || rh < 0.2 || rh > 0.7) continue;
      if (ia / (iw * ih) < 0.45) continue;
      const icx = C.sx[il] / ia, icy = C.sy[il] / ia;
      if (Math.hypot(icx - cx, icy - cy) > 0.12 * Math.max(bw, bh)) continue;
      out.push({ x: (C.sx[l] + C.sx[il]) / (a + ia), y: (C.sy[l] + C.sy[il]) / (a + ia), size: Math.sqrt(bw * bh) });
    }
    return out;
  }

  /* Refine a marker centre on the full-resolution image. */
  function refineMarker(G, m) {
    const half = Math.max(3, Math.round(m.size * 0.75));
    const x0 = Math.max(0, Math.round(m.x - half)), x1 = Math.min(G.w - 1, Math.round(m.x + half));
    const y0 = Math.max(0, Math.round(m.y - half)), y1 = Math.min(G.h - 1, Math.round(m.y + half));
    let lo = 255, hi = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = G.g[y * G.w + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 30) return m;
    const thr = (lo + hi) / 2;
    let sw = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = G.g[y * G.w + x];
        if (v < thr) { const wt = thr - v; sw += wt; sx += wt * x; sy += wt * y; }
      }
    }
    if (!sw) return m;
    const nx = sx / sw, ny = sy / sw;
    if (Math.hypot(nx - m.x, ny - m.y) > m.size * 0.3) return m;
    return { x: nx, y: ny, size: m.size };
  }

  function orderClockwise(pts) {
    const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
    return pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  }

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; }
    return a / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const s = Math.sign(cr);
      if (!s) return false;
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  function candidateQuads(cands) {
    const c = cands.slice().sort((a, b) => b.size - a.size).slice(0, 10);
    const quads = [];
    for (let a = 0; a < c.length; a++) for (let b = a + 1; b < c.length; b++)
      for (let d = b + 1; d < c.length; d++) for (let e = d + 1; e < c.length; e++) {
        const pts = [c[a], c[b], c[d], c[e]];
        const sizes = pts.map((p) => p.size);
        if (Math.max(...sizes) / Math.min(...sizes) > 1.8) continue;
        const q = orderClockwise(pts);
        if (!isConvex(q)) continue;
        const area = Math.abs(quadArea(q));
        // Markers should be far apart relative to their own size.
        const ms = sizes.reduce((s, v) => s + v, 0) / 4;
        if (area < ms * ms * 60) continue;
        quads.push({ q, area });
      }
    quads.sort((x, y) => y.area - x.area);
    return quads.map((x) => x.q);
  }

  /* ---------------- reading ---------------- */

  const PAGE_CORNERS = [L.FIDUCIALS.tl, L.FIDUCIALS.tr, L.FIDUCIALS.br, L.FIDUCIALS.bl];

  function meanPatch(G, H, cx, cy, hx, hy, n) {
    let s = 0, k = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      s += sampleAt(G, H, cx + hx * ((2 * i) / (n - 1) - 1), cy + hy * ((2 * j) / (n - 1) - 1));
      k++;
    }
    return s / k;
  }

  function readCode(G, H) {
    const cells = L.codeCellCenters();
    const d = cells.map(([x, y]) => {
      const v = meanPatch(G, H, x, y, L.CODE_CELL_W * 0.3, L.CODE_CELL_H * 0.25, 3);
      const w1 = meanPatch(G, H, x, y - 4.6, L.CODE_CELL_W * 0.3, 0.4, 3);
      const w2 = meanPatch(G, H, x, y + 4.6, L.CODE_CELL_W * 0.3, 0.4, 3);
      const white = Math.max(w1, w2, 1);
      return 1 - v / white;
    });
    const bits = d.map((x) => (x > 0.4 ? 1 : 0));
    const ambiguous = d.filter((x) => x > 0.25 && x < 0.55).length;
    if (ambiguous > 3) return null;
    return L.decodeSheetCode(bits);
  }

  const R = L.BUBBLE_R;
  const RING = [];
  for (let k = 0; k < 10; k++) RING.push([Math.cos((k * Math.PI) / 5), Math.sin((k * Math.PI) / 5)]);
  const INTERIOR = [[0, 0]];
  for (let k = 0; k < 6; k++) INTERIOR.push([0.35 * R * Math.cos((k * Math.PI) / 3), 0.35 * R * Math.sin((k * Math.PI) / 3)]);
  for (let k = 0; k < 12; k++) INTERIOR.push([0.68 * R * Math.cos((k * Math.PI) / 6 + 0.26), 0.68 * R * Math.sin((k * Math.PI) / 6 + 0.26)]);

  function outlineScore(G, H, bubbles, dx, dy) {
    let s = 0;
    for (const b of bubbles) {
      const cx = b.cx + dx, cy = b.cy + dy;
      for (const [c, si] of RING) {
        const on = sampleAt(G, H, cx + c * R, cy + si * R);
        const off = sampleAt(G, H, cx + c * (R + 0.75), cy + si * (R + 0.75));
        const inn = sampleAt(G, H, cx + c * (R - 0.7), cy + si * (R - 0.7));
        s += off - on + (inn > on ? Math.min(inn - on, off - on) : 0);
      }
    }
    return s;
  }

  function searchOffset(G, H, bubbles, cx, cy, range, step, best) {
    let b = best || { dx: cx, dy: cy, sc: outlineScore(G, H, bubbles, cx, cy) };
    for (let dy = cy - range; dy <= cy + range + 1e-9; dy += step)
      for (let dx = cx - range; dx <= cx + range + 1e-9; dx += step) {
        const sc = outlineScore(G, H, bubbles, dx, dy);
        if (sc > b.sc) b = { dx, dy, sc };
      }
    return b;
  }

  /* Align the bubble grid against the printed outlines: first each whole
   * column (wide search), then blocks of rows within it (absorbs paper curl).
   * Returns per-question offsets (mm) and a per-question "weak alignment" flag. */
  function alignBlocks(G, H, layout) {
    const offsets = new Array(layout.questions.length);
    const weak = new Array(layout.questions.length).fill(false);
    const BLOCK = 8;
    const byCol = {};
    for (const q of layout.questions) (byCol[q.col] = byCol[q.col] || []).push(q);
    const blocks = [];
    for (const col of Object.values(byCol)) {
      const sparse = col.filter((q, i) => i % 2 === 0).flatMap((q) => q.bubbles);
      let cb = searchOffset(G, H, sparse, 0, 0, 4.5, 0.75);
      cb = searchOffset(G, H, sparse, cb.dx, cb.dy, 0.75, 0.25, cb);
      let prev = { dx: cb.dx, dy: cb.dy };
      for (let s = 0; s < col.length; s += BLOCK) {
        const qs = col.slice(s, s + BLOCK);
        const bubbles = qs.flatMap((q) => q.bubbles);
        // Start from the better of the column offset and the previous block's.
        const a = outlineScore(G, H, bubbles, cb.dx, cb.dy), b = outlineScore(G, H, bubbles, prev.dx, prev.dy);
        const start = a >= b ? { dx: cb.dx, dy: cb.dy, sc: a } : { dx: prev.dx, dy: prev.dy, sc: b };
        let best = searchOffset(G, H, bubbles, start.dx, start.dy, 2, 0.5, start);
        best = searchOffset(G, H, bubbles, best.dx, best.dy, 0.5, 0.125, best);
        prev = best;
        for (const q of qs) offsets[q.index] = [best.dx, best.dy];
        blocks.push({ qs, per: best.sc / bubbles.length });
      }
    }
    const med = percentile(blocks.map((b) => b.per), 0.5);
    for (const b of blocks) if (b.per < 0.4 * med) for (const q of b.qs) weak[q.index] = true;
    return { offsets, weak };
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  }

  function measureBubbles(G, H, layout, offsets) {
    return layout.questions.map((q) => {
      const [dx, dy] = offsets[q.index];
      // Paper white is measured in the gaps directly above and below each
      // bubble, so a shadow edge crossing the row doesn't skew the reading.
      const gaps = q.bubbles.map((b) =>
        [-1, 1].map((sgn) => meanPatch(G, H, b.cx + dx, q.cy + dy + sgn * L.PITCH_Y / 2, 0.6, 0.15, 3))
      );
      const rowWhite = percentile(gaps.flat(), 0.75);
      return q.bubbles.map((b, k) => {
        // Brighter of above/below (ignores a smudge in one gap); never trust a
        // local value far brighter than the row (glare) — cap at the row level.
        const white = Math.max(1, Math.min(Math.max(gaps[k][0], gaps[k][1]), rowWhite * 1.08));
        let s = 0;
        for (const [ox, oy] of INTERIOR) s += sampleAt(G, H, b.cx + dx + ox, b.cy + dy + oy);
        const v = s / INTERIOR.length;
        return Math.max(0, Math.min(1, 1 - v / white));
      });
    });
  }

  /* Turn darkness values into answers + flags. */
  function classify(layout, darkness) {
    const all = darkness.flat();
    const B = percentile(all, 0.5);
    const maxes = darkness.map((row) => Math.max(...row));
    const filled = maxes.filter((m) => m - B > 0.15);
    const F = filled.length ? percentile(filled, 0.5) : B + 0.45;
    const span = Math.max(0.2, F - B);
    const tMark = B + 0.5 * span;
    const tFaint = B + 0.25 * span;
    const responses = [], flags = [];
    layout.questions.forEach((q, qi) => {
      const d = darkness[qi];
      const order = d.map((v, i) => i).sort((a, b) => d[b] - d[a]);
      const marked = order.filter((i) => d[i] >= tMark);
      let resp = "", flag = null;
      if (marked.length === 0) {
        if (d[order[0]] >= tFaint) flag = "faint";
      } else if (marked.length === 1) {
        resp = q.bubbles[marked[0]].label;
        if (order.length > 1 && d[order[1]] >= tFaint) flag = "erasure";
      } else {
        const d1 = d[marked[0]] - B, d2 = d[marked[1]] - B;
        if (d2 < 0.6 * d1) {
          resp = q.bubbles[marked[0]].label;
          flag = "erasure";
        } else {
          resp = marked.map((i) => q.bubbles[i].label).sort().join("");
          flag = "multiple";
        }
      }
      responses.push(resp);
      flags.push(flag);
    });
    return { responses, flags, stats: { baseline: B, fill: F, tMark, tFaint } };
  }

  /* Produce a straightened greyscale image of the page (for review). */
  function rectify(G, H, outW) {
    const outH = Math.round((outW * L.PAGE.h) / L.PAGE.w);
    const out = new Uint8ClampedArray(outW * outH);
    const k = L.PAGE.w / outW;
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) out[y * outW + x] = sampleAt(G, H, (x + 0.5) * k, (y + 0.5) * k);
    return { w: outW, h: outH, g: out };
  }

  /**
   * Scan one image.
   * opts.getTest(testCode) → test object or null
   * opts.rectifyWidth → also return a straightened page image of this width
   */
  function scan(imageData, opts = {}) {
    const t0 = Date.now();
    const G = imageData.g ? imageData : toGray(imageData);
    const { img: S, scale } = downscale(G, opts.detectMaxDim || 1200);
    const cands = findMarkerCandidates(S).map((m) => refineMarker(G, { x: m.x * scale + (scale - 1) / 2, y: m.y * scale + (scale - 1) / 2, size: m.size * scale }));
    const base = { markers: cands, width: G.w, height: G.h };
    if (cands.length < 4) return { ...base, status: "no-sheet", ms: Date.now() - t0 };
    const quads = candidateQuads(cands).slice(0, 8);
    let found = null;
    for (const q of quads) {
      for (let rot = 0; rot < 4 && !found; rot++) {
        const dst = [0, 1, 2, 3].map((i) => [q[(i + rot) % 4].x, q[(i + rot) % 4].y]);
        const H = solveHomography(PAGE_CORNERS, dst);
        if (!H) continue;
        const code = readCode(G, H);
        if (code) found = { H, code, corners: dst };
      }
      if (found) break;
    }
    if (!found) return { ...base, status: quads.length ? "no-code" : "no-sheet", ms: Date.now() - t0 };
    const { H, code, corners } = found;
    const res = { ...base, corners, H, testCode: code.testCode, sheetCode: code.sheetCode };
    const test = opts.getTest ? opts.getTest(code.testCode) : null;
    if (!test) return { ...res, status: "unknown-test", ms: Date.now() - t0 };
    const layout = L.computeLayout(test);
    if (layout.error) return { ...res, status: "layout-error", ms: Date.now() - t0 };
    const { offsets, weak } = alignBlocks(G, H, layout);
    const darkness = measureBubbles(G, H, layout, offsets);
    const cls = classify(layout, darkness);
    weak.forEach((w, i) => { if (w) cls.flags[i] = "unclear"; });
    const out = {
      ...res,
      status: "ok",
      test,
      responses: cls.responses,
      flags: cls.flags,
      stats: cls.stats,
      darkness: darkness.map((r) => r.map((v) => Math.round(v * 100) / 100)),
      offsets: offsets.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]),
    };
    if (opts.rectifyWidth) out.rectified = rectify(G, H, opts.rectifyWidth);
    out.ms = Date.now() - t0;
    return out;
  }

  root.MGScanner = { scan, toGray, solveHomography, project, rectify, _internal: { findMarkerCandidates, downscale, classify, readCode } };
})(typeof window !== "undefined" ? window : globalThis);
