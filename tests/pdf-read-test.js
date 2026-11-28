// Reading tests from PDFs: builds random test PDFs (one or two columns,
// multiple-choice / true-false / always-sometimes-never / written parts,
// questions that are only a picture, page headers and footers) with
// MultiGrader's own PDF writer, reads them back with the bundled pdf.js, and
// checks that every question, its kind and the multiple-choice ones are found.
// Also reads PDFs of the Word sample made by LibreOffice when it's installed.
//   node tests/pdf-read-test.js [count] [firstSeed]
const path = require("path");
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");
const os = require("os");
const { chromium } = require("playwright");

const N = +process.argv[2] || 120, START = +process.argv[3] || 1;
const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { resp.writeHead(404); return resp.end(); }
      resp.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(resp);
    }).listen(0, () => res(srv));
  });
}

// Runs in the page: make one random test PDF, read it back, compare.
async function runCase(seed) {
  let s = (seed * 7919 + 3) >>> 0;
  const R = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const chance = (p) => R() < p;
  const twoCol = chance(0.35);
  const W = 215.9, H = 279.4, M = 18, GUT = 10;
  const colW = twoCol ? (W - 2 * M - GUT) / 2 : W - 2 * M;
  const pages = [];
  let ops = null, col = 0, y = 0;
  const truth = [];
  // a small grey JPEG for picture questions
  const cv = document.createElement("canvas"); cv.width = 120; cv.height = 80;
  const cx = cv.getContext("2d"); cx.fillStyle = "#ddd"; cx.fillRect(0, 0, 120, 80); cx.fillStyle = "#333"; cx.font = "20px sans-serif"; cx.fillText("graph", 20, 45);
  const jpeg = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.8))).arrayBuffer());
  const newPage = () => {
    ops = [];
    pages.push(ops);
    ops.push({ t: "text", x: M, y: 12, size: 3.4, text: "Algebra 2 Unit Test · Version A" });
    ops.push({ t: "text", x: W / 2, y: H - 8, size: 3, text: `Page ${pages.length}`, anchor: "middle" });
    col = 0; y = 24;
  };
  const x0 = () => M + col * (colW + GUT);
  const need = (h) => { if (y + h > H - 16) { if (twoCol && col === 0) { col = 1; y = 24; } else newPage(); } };
  const line = (text, opts = {}) => { need(6); ops.push({ t: "text", x: x0() + (opts.indent || 0), y, size: opts.size || 3.6, text, bold: !!opts.bold }); y += opts.gap || 5.6; };
  newPage();
  line("Name: ____________________");
  let num = 1;
  const words = ["Which", "value", "solves", "the", "equation", "below", "for", "x", "graph", "slope", "of", "line", "shown", "number", "true", "sum"];
  const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(" ");
  const nParts = 1 + Math.floor(R() * 3);
  for (let part = 0; part < nParts; part++) {
    const pk = pick(["MC", "MC", "MC", "TF", "ASN"]);
    if (part > 0 || pk !== "MC" || chance(0.5)) {
      y += 3;
      line(pk === "TF" ? `Part ${part + 1}: True or False` : pk === "ASN" ? `Part ${part + 1}: Always, Sometimes, or Never` : twoCol ? `Part ${part + 1}: Multiple choice` : `Part ${part + 1}: Multiple choice. Circle the best answer.`, { bold: true });
    }
    const nq = 2 + Math.floor(R() * 7);
    for (let i = 0; i < nq; i++) {
      if (pk === "MC" && !twoCol && i > 0 && i < nq - 1 && chance(0.08)) { // a question that is only a picture
        need(32);
        ops.push({ t: "image", x: x0(), y, w: 45, h: 30, jpeg });
        y += 34;
        truth.push({ num, mc: true, pic: true });
        num++;
        continue;
      }
      need(pk === "MC" ? 30 : 12);
      const label = pick(["%n.", "%n)", "(%n)"]).replace("%n", num);
      // Lines fit their column (about 6 words in two columns).
      line(`${label}  ${sentence(twoCol ? 3 + Math.floor(R() * 3) : 5 + Math.floor(R() * 6))}`);
      if (chance(0.3)) line(sentence(twoCol ? 5 : 6), { indent: 7 });
      let k = 0;
      if (pk === "MC") {
        k = 4 + (chance(0.4) ? 1 : 0);
        const L = pick([["a)", "b)", "c)", "d)", "e)"], ["(A)", "(B)", "(C)", "(D)", "(E)"], ["A.", "B.", "C.", "D.", "E."]]);
        const style = pick(["lines", "oneline", "two"]);
        if (style === "lines") for (let c = 0; c < k; c++) line(`${L[c]} ${Math.floor(R() * 90)}`, { indent: 7 });
        else if (style === "oneline" && !twoCol) { need(6); for (let c = 0; c < k; c++) ops.push({ t: "text", x: x0() + 7 + c * 30, y, size: 3.6, text: `${L[c]} ${Math.floor(R() * 90)}` }); y += 5.6; }
        else { for (let c = 0; c < k; c += 2) { need(6); ops.push({ t: "text", x: x0() + 7, y, size: 3.6, text: `${L[c]} ${Math.floor(R() * 90)}` }); if (c + 1 < k) ops.push({ t: "text", x: x0() + 7 + colW / 2, y, size: 3.6, text: `${L[c + 1]} ${Math.floor(R() * 90)}` }); y += 5.6; } }
      }
      y += 2 + Math.floor(R() * 3) * 4;
      truth.push({ num, mc: true, pic: false, type: pk === "MC" ? ["", "", "AB", "AC", "AD", "AE"][k] : pk });
      num++;
    }
    if (part < nParts - 1 && chance(0.5)) {
      y += 3;
      line(twoCol ? `Part ${part + 1}B: Show all work.` : `Part ${part + 1}B: Free response. Show all work.`, { bold: true });
      for (let e = 1 + Math.floor(R() * 2); e > 0; e--) {
        need(30);
        line(`${num}.  Solve and explain your reasoning.`);
        line("a) find the vertex", { indent: 7 });
        line("b) find the roots", { indent: 7 });
        y += 14;
        truth.push({ num, mc: false, pic: false });
        num++;
      }
    }
  }
  const blob = await MGPdf.sheetsToPDF(pages, { title: "test" });
  const o = await MGPdfRead.open(await blob.arrayBuffer());
  const found = MGDocx.findItems(o.doc);
  const errs = [];
  const got = found.items.map((it) => it.num + (it.picNum ? "p" : "")).join(",");
  const want = truth.map((t) => t.num + (t.pic ? "p" : "")).join(",");
  if (got !== want) errs.push(`found ${got}, expected ${want}`);
  else {
    const typeOf = (it) => it.kind || ["", "", "AB", "AC", "AD", "AE", "AF"][Math.min(6, it.choices)] || "?";
    found.items.forEach((it, i) => { if (truth[i].type && typeOf(it) !== truth[i].type) errs.push(`Q${it.num} read as ${typeOf(it)}, expected ${truth[i].type}`); });
    const mc = truth.filter((t) => t.mc).map((t) => t.num);
    const sel = MGDocx.guessSelection(found.items, mc.length);
    if (sel.join() !== mc.join()) errs.push(`multiple choice guessed ${sel.join(",")}, expected ${mc.join(",")}`);
  }
  return { seed, twoCol, pages: pages.length, n: truth.length, errs };
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${srv.address().port}/index.html`);
  await page.evaluate(`window.__runCase = ${runCase.toString()}`);
  let fails = 0, qs = 0, twoCols = 0;
  for (let seed = START; seed < START + N; seed++) {
    const r = await page.evaluate((sd) => window.__runCase(sd), seed);
    qs += r.n; if (r.twoCol) twoCols++;
    if (r.errs.length) { fails++; if (fails <= 20) console.log(`FAIL seed ${seed} (${r.twoCol ? "two columns" : "one column"}, ${r.pages} pages): ${r.errs.slice(0, 3).join("; ")}`); }
  }
  console.log(`${N} PDFs (${twoCols} in two columns), ${qs} questions; ${fails} with problems`);

  // A PDF made from the Word sample by LibreOffice (when installed).
  let lo = true;
  try { execFileSync("soffice", ["--version"], { stdio: "ignore" }); } catch (e) { lo = false; }
  if (lo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-pdf-"));
    fs.copyFileSync(path.join(__dirname, "fixtures", "word-typed-sample.docx"), path.join(dir, "sample.docx"));
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, path.join(dir, "sample.docx")], { stdio: "ignore", timeout: 120000 });
    const b64 = fs.readFileSync(path.join(dir, "sample.pdf")).toString("base64");
    const r = await page.evaluate(async (d) => {
      const o = await MGPdfRead.open(Uint8Array.from(atob(d), (c) => c.charCodeAt(0)).buffer);
      const f = MGDocx.findItems(o.doc);
      return { nums: f.items.map((it) => it.num + (it.picNum ? "p" : "")).join(","), sel: MGDocx.guessSelection(f.items, 9).join(",") };
    }, b64);
    const ok = r.nums === "1,2,3,4p,5,6,7,8,9,10,11" && r.sel === "1,2,3,4,5,6,9,10,11";
    if (!ok) fails++;
    console.log(`Word sample as PDF (LibreOffice): ${r.nums} → answer sheet ${r.sel} ${ok ? "ok" : "WRONG"}`);
  } else console.log("(LibreOffice not installed: skipped the Word-sample PDF)");

  if (errors.length) { fails++; console.log("page errors:", errors.slice(0, 3)); }
  await browser.close();
  srv.close();
  console.log(fails ? "\nFAILED" : "\nall passing");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
