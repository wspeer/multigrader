// End-to-end test: uploading a test file on the Build tab sets up the
// question format from its multiple-choice questions (free response left
// out), and the teacher can still change it.
//   node tests/e2e-upload.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
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
function assert(cond, msg) { if (!cond) throw new Error("ASSERT: " + msg); console.log("  ok  " + msg); }

// A LaTeX test with a free-response part between two multiple-choice parts.
const MIXED_TEX = String.raw`\documentclass{exam}
\begin{document}
\begin{questions}
\uplevel{Part I. True or False}
\question A square is a rectangle.
\question Every rhombus is a square.
\uplevel{Part II. Multiple choice}
\question Pick one.
\begin{choices} \choice 1 \CorrectChoice 2 \choice 3 \end{choices}
\question Pick another.
\begin{choices} \CorrectChoice 1 \choice 2 \choice 3 \end{choices}
\uplevel{Part III. Free response. Show your work below.}
\question Prove that the angles of a triangle add to $180^\circ$.
\vspace{2in}
\uplevel{Part IV. Multiple choice}
\question Pick a letter.
\begin{choices} \choice a \choice b \choice c \CorrectChoice d \choice e \end{choices}
\end{questions}
\end{document}
`;


// Runs in the page: a small test as a PDF (MultiGrader's PDF writer), or as a
// scan of that PDF (page images only, no text).
async function makeTestPdf(scan, keyed) {
  const lines = [
    ["Part 1: True or False", 1], ["1.  A square is a rectangle.", 0], ["2.  Every rhombus is a square.", 0],
    ["Part 2: Multiple choice", 1], ["3.  What is 2 + 2?", 0], ["a) 3", 2], ["b) 4", 2], ["c) 5", 2], ["d) 6", 2],
    ["4.  What is 3 x 3?", 0], ["a) 6", 2], ["b) 9", 2], ["c) 12", 2], ["d) 15", 2],
    ["5.  What is 10 - 4?", 0], ["a) 4", 2], ["b) 5", 2], ["c) 6", 2], ["d) 7", 2],
    ["Part 3: Free response. Show all work.", 1], ["6.  Prove that the angles of a triangle add to 180 degrees.", 0],
    ["Part 4: Multiple choice", 1], ["7.  Which is prime?", 0], ["a) 4    b) 6    c) 7    d) 8    e) 9", 2],
    ["8.  Which is even?", 0], ["a) 1    b) 3    c) 5    d) 8    e) 9", 2],
  ];
  const ops = [];
  let y = 24;
  ops.push({ t: "text", x: 18, y: 14, size: 4.5, text: "Unit Quiz - Version A", bold: true });
  for (const [text, kind] of lines) {
    if (kind === 1) y += 4;
    // An answer key: Q3's answer highlighted in green (as in a scoring guide),
    // Q4's given on an "Answer B" line, Q8's highlighted in yellow.
    if (keyed && (text === "b) 4" || text.startsWith("a) 1    b) 3"))) ops.push({ t: "rect", x: 16, y: y - 4.2, w: 150, h: 6, fill: text === "b) 4" ? "#e6ffe6" : "#ffff66" });
    ops.push({ t: "text", x: kind === 2 ? 26 : 18, y, size: 4.2, text, bold: kind === 1 });
    if (keyed && text === "d) 15") { y += 7.5; ops.push({ t: "text", x: 22, y, size: 4.2, text: "Answer B", bold: true }); }
    y += kind === 0 && /^6\./.test(text) ? 30 : 7.5;
  }
  let blob = await MGPdf.sheetsToPDF([ops], { title: "quiz" });
  if (scan) {
    // Draw the page and keep only the picture, as a scanner would.
    const L = await (async () => { if (!window.pdfjsLib) await MGPdfRead.readLines(await blob.arrayBuffer()); return window.pdfjsLib; })();
    const pdf = await L.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 3 });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const jpeg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9))).arrayBuffer());
    blob = await MGPdf.sheetsToPDF([[{ t: "image", x: 0, y: 0, w: 215.9, h: 279.4, jpeg }]], { title: "scan" });
  }
  const b = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const secs = () => page.evaluate(() => MGStore.db.tests[0].sections.map((s) => `${s.count}${s.type}`).join(","));
  const keyCount = () => page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]).filter(Boolean).length);
  const card = async () => (await page.textContent("#upload-card")).replace(/\s+/g, " ");
  const newTest = async () => {
    await page.goto(base + "/#/tests");
    await page.click("#new-test");
    await page.waitForSelector("#upload-card #tex-in");
  };

  // ---- Word: a new test takes its format from the file ----
  await newTest();
  const order = await page.$$eval(".build-main > section", (els) => els.map((e) => e.id || e.querySelector("h2").textContent));
  assert(order[0] === "Details" && order[1] === "upload-card" && order[2] === "Question format", "upload card sits under Details, above Question format: " + order.join(", "));
  await page.setInputFiles("#tex-in", path.join(FIX, "word-typed-sample.docx"));
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "9AD", "format set from the file: 9 × A–D (free-response 7 and 8 left out)");
  assert(/Question format set from the file: 9 × A–D/.test(await page.textContent("#toast")), "toast says what was set");
  assert((await page.inputValue("#src-sel")) === "1–6, 9–11", "answer-sheet questions: 1–6, 9–11");
  assert(/the other 2 stay where they are/.test(await card()), "free-response questions mentioned");
  assert((await page.$$(".sec-row")).length === 1 && (await page.inputValue(".sec-row .sec-count")) === "9", "Question format card shows it");

  // changing the list of questions updates the format while it's still the file's
  await page.fill("#src-sel", "1-6");
  await page.dispatchEvent("#src-sel", "change");
  await page.waitForFunction(() => /found all 6 questions/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "6AD", "format follows the chosen questions: 6 × A–D");

  // the teacher changes the format by hand: the file's format is offered back
  await page.fill(".sec-row .sec-count", "8");
  await page.dispatchEvent(".sec-row .sec-count", "change");
  await page.waitForSelector("#use-detected");
  assert(/Found in the file: 6 × A–D. The question format below is different/.test(await card()), "a hand-made format is kept, and the difference shown");
  await page.click("#use-detected");
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "6AD", "Use the format from the file restores it");

  // with a key typed in, choosing other questions doesn't change the format
  await (await page.$$(".key-quick"))[0].fill("ABCDAB");
  await page.waitForTimeout(200);
  await page.fill("#src-sel", "1-6, 9-11");
  await page.dispatchEvent("#src-sel", "change");
  await page.waitForSelector("#upload-card .notice.bad");
  assert((await secs()) === "6AD" && (await keyCount()) === 6, "with a key entered, the format and key stay");
  page.once("dialog", (d) => d.accept());
  await page.click("#use-detected");
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "9AD" && (await keyCount()) === 0, "after confirming, the file's format replaces it (key cleared)");

  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], "upload-card.png"), fullPage: true });

  // ---- a test that already has a key keeps its format ----
  await newTest();
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "AE");
  await (await page.$$(".key-quick"))[0].fill("ABCDEABCDE");
  await page.waitForTimeout(200);
  assert(!!(await page.$("#copy-fmt")), "before an upload: Copy the format of another test is offered");
  await page.setInputFiles("#tex-in", path.join(FIX, "word-typed-sample.docx"));
  await page.waitForSelector("#use-detected");
  assert(!(await page.$("#copy-fmt")) && !/Copy the format of another test/.test(await page.textContent("main")), "after an upload: Copy the format line is gone");
  assert((await secs()) === "10AE" && (await keyCount()) === 10, "existing format and key untouched by an upload");

  // ---- LaTeX: question macros; the file's answers fill the key ----
  await newTest();
  await page.setInputFiles("#tex-in", path.join(FIX, "exam-macros-sample.tex"));
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "3TF,9AD", "macros: 3 × True/False, 9 × A–D");
  assert((await keyCount()) === 12 && !/key/i.test(await page.textContent("#toast")), "key filled in from the file, without announcing it");
  assert((await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0])[11])) === "&AC", "all-required answer kept");

  // ---- LaTeX: a "True or False" heading, choices, and a free-response part ----
  await newTest();
  await page.setInputFiles("#tex-in", { name: "mixed.tex", mimeType: "text/x-tex", buffer: Buffer.from(MIXED_TEX) });
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "2TF,2AC,1AE", "heading, choices and free response: 2 × T/F, 2 × A–C, 1 × A–E");
  assert((await page.inputValue("#src-sel")) === "1–4, 6", "the free-response question (5) is left out");
  assert((await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]).join(","))) === ",,B,A,D", "\\CorrectChoice answers filled in");
  assert(/Numbering on the answer sheet: Q1–4 = file 1–4, Q5 = file 6/.test(await card()), "file and answer-sheet numbering shown");

  // ---- LaTeX: answer-only macros, choices listed once in each part's instructions ----
  const PARTS_TEX = String.raw`\documentclass{exam}
\newcommand\MCQuestion[2]{#2}
\begin{document}
\begin{questions}
\fullwidth{\textbf{Part I.} For each quantity, bubble \textbf{(A)} if it is positive, \textbf{(B)} if it is negative, or \textbf{(C)} if it is zero.}
\question\MCQuestion{B}{$f_x(R)$}
\question\MCQuestion{A}{$f_y(T)$}
\question\MCQuestion{B}{$f_x(P)$}
\fullwidth{\textbf{Part II.} Five arrows labeled \textbf{A}--\textbf{E} start at the point $Z$. Which arrow points in}
\question\MCQuestion{D}{the direction of $\nabla g(Z)$}
\question\MCQuestion{A}{a direction with $D_u g(Z)=0$}
\end{questions}
\end{document}
`;
  await newTest();
  await page.setInputFiles("#tex-in", { name: "parts.tex", mimeType: "text/x-tex", buffer: Buffer.from(PARTS_TEX) });
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent));
  assert((await secs()) === "3AC,2AE", "parts keep their own letters from their instructions: 3 × A–C, 2 × A–E (not A–D)");
  assert((await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]).join(""))) === "BABDA", "and the key comes from the macros");

  // ---- versions: download still works from the Versions card ----
  await page.selectOption("#v-count", "2");
  await page.waitForSelector(".ver-block[data-v='B'] [data-texdl]:not([disabled])");
  assert(/\.tex/.test(await page.textContent(".ver-block[data-v='B'] [data-texdl]")) && !!(await page.$("#tex-fixed")), "Versions card: download button and keep-in-place box");


  // ---- PDF: the question format from a PDF's text ----
  await page.evaluate(`window.__makeTestPdf = ${makeTestPdf.toString()}`);
  const pdfB64 = await page.evaluate(() => window.__makeTestPdf(false));
  await newTest();
  assert(/Upload your Word, LaTeX or PDF file here/.test(await card()), "upload card mentions PDF");
  await page.setInputFiles("#tex-in", { name: "quiz.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdfB64, "base64") });
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent), null, { timeout: 60000 });
  assert((await secs()) === "2TF,3AD,2AE", "PDF: 2 × True/False, 3 × A–D, 2 × A–E");
  assert((await page.inputValue("#src-sel")) === "1–5, 7–8", "PDF: the free-response question (6) is left out");
  await page.selectOption("#v-count", "2");
  await page.waitForSelector(".ver-block[data-v='B']");
  assert(!(await page.$("[data-texdl]")) && /can't make reordered copies of it/.test(await card()), "PDF: no reordered download; the card says to upload the Word or LaTeX file");


  // ---- a PDF answer key: highlighted answers and "Answer B" lines fill the key ----
  const keyB64 = await page.evaluate(() => window.__makeTestPdf(false, true));
  await newTest();
  await page.setInputFiles("#tex-in", { name: "key.pdf", mimeType: "application/pdf", buffer: Buffer.from(keyB64, "base64") });
  await page.waitForFunction(() => /as found in the file/.test(document.querySelector("#upload-card").textContent), null, { timeout: 60000 });
  assert((await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]).join(","))) === ",,B,B,,,", "PDF key: Q3 from a green highlight, Q4 from \"Answer B\"; Q8's choices are on one line, so its highlight can't say which");

  // ---- a scanned PDF (no text) is read with OCR ----
  const scanB64 = await page.evaluate(() => window.__makeTestPdf(true));
  await newTest();
  await page.setInputFiles("#tex-in", { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(scanB64, "base64") });
  await page.waitForFunction(() => /as found in the file|found all|No numbered/.test(document.querySelector("#upload-card").textContent), null, { timeout: 180000 });
  assert(/text recognition/.test(await card()), "scan: read with text recognition (and says so)");
  assert((await secs()) === "2TF,3AD,2AE", "scan: same format found: " + (await secs()));

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nUpload E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
