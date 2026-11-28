/* MultiGrader — read text from an image (roster screenshots), in the browser.
 *
 * Uses the bundled Tesseract OCR engine in vendor/tesseract, loaded only the
 * first time it's needed. Images never leave the device.
 */
(function (root) {
  "use strict";
  const BASE = "vendor/tesseract/";
  let loading = null;
  let worker = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error("couldn't load " + src));
      document.head.appendChild(s);
    });
  }

  let progressCb = null;
  async function getWorker() {
    if (worker) return worker;
    if (!loading) {
      loading = (async () => {
        if (!root.Tesseract) await loadScript(BASE + "tesseract.min.js");
        const abs = (p) => new URL(BASE + p, location.href).href;
        return root.Tesseract.createWorker("eng", 1 /* LSTM only */, {
          workerPath: abs("worker.min.js"),
          corePath: abs(""),
          langPath: abs("lang"),
          gzip: true,
          workerBlobURL: false,
          logger: (m) => progressCb && progressCb(m),
        });
      })();
    }
    try {
      worker = await loading;
    } catch (e) {
      loading = null;
      throw e;
    }
    return worker;
  }

  /* Draw the image larger and in greyscale: small screenshots read better. */
  async function prepare(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.max(1, Math.min(3, 2400 / Math.max(bmp.width, bmp.height)));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "grayscale(1)";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Recognize the text in an image File/Blob.
   * onProgress(label, fraction) is called while it works.
   */
  async function readText(file, onProgress) {
    progressCb = (m) => {
      if (!onProgress) return;
      if (m.status === "recognizing text") onProgress("Reading names…", m.progress);
      else onProgress("Loading text recognition (first time only)…", m.progress || 0);
    };
    onProgress && onProgress("Loading text recognition (first time only)…", 0);
    const w = await getWorker();
    const img = await prepare(file);
    await w.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
    const { data } = await w.recognize(img, {}, { blocks: true, text: true });
    const lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l.words || []);
    if (!lines.length) { progressCb = null; return data.text || ""; }

    // Second pass on bracketed tags like "(IV)": small grey text is easily
    // misread as "(v)" or "(1v)", so read just that word again, expecting
    // only Roman numerals, digits and brackets.
    const tagWords = [];
    for (const words of lines) {
      const tw = words.find((wd) => /^[([{]/.test(wd.text) || /^[1lI|][vVxX]\)?$/.test(wd.text));
      if (tw) tagWords.push(tw);
    }
    if (tagWords.length) {
      onProgress && onProgress("Checking forms…", 0);
      await w.setParameters({ tessedit_char_whitelist: "()[]IVX0123456789", tessedit_pageseg_mode: "7" });
      for (let i = 0; i < tagWords.length; i++) {
        const wd = tagWords[i], bb = wd.bbox, pad = 12;
        const rectangle = { left: Math.max(0, bb.x0 - pad), top: Math.max(0, bb.y0 - pad), width: bb.x1 - bb.x0 + 2 * pad, height: bb.y1 - bb.y0 + 2 * pad };
        try {
          const { data: d2 } = await w.recognize(img, { rectangle });
          const t = (d2.text || "").trim().replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
          if (/^\(?[IVX]{1,4}\)?$|^\(?\d{1,2}\)?$/.test(t)) wd.text = "(" + t.replace(/[()]/g, "") + ")";
        } catch (e) { /* keep the first reading */ }
        onProgress && onProgress("Checking forms…", (i + 1) / tagWords.length);
      }
      await w.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
    }
    progressCb = null;
    // A capital I at the start of a name is often read as a lowercase l
    // ("lsabel" → "Isabel"); names don't start with a lowercase l.
    const fixWord = (t) => (/^l[a-z]{3,}[,.]?$/.test(t) ? "I" + t.slice(1) : t);
    return lines.map((words) => words.map((wd) => fixWord(wd.text)).join(" ")).join("\n");
  }

  /**
   * Read a page image (a canvas) into lines of text with their boxes, in
   * reading order. Used for scanned PDFs.
   */
  async function readLines(canvas, onProgress) {
    progressCb = (m) => {
      if (!onProgress) return;
      onProgress(m.status === "recognizing text" ? "Reading…" : "Loading text recognition (first time only)…", m.progress || 0);
    };
    const w = await getWorker();
    await w.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });
    progressCb = null;
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push({ text: (l.words || []).map((wd) => wd.text).join(" "), bbox: l.bbox });
    return out;
  }

  root.MGOcr = { readText, readLines };
})(window);
