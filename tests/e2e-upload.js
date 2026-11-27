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
  await page.setInputFiles("#tex-in", path.join(FIX, "word-typed-sample.docx"));
  await page.waitForSelector("#use-detected");
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

  // ---- versions: download still works from the Versions card ----
  await page.selectOption("#v-count", "2");
  await page.waitForSelector(".ver-block[data-v='B'] [data-texdl]:not([disabled])");
  assert(/\.tex/.test(await page.textContent(".ver-block[data-v='B'] [data-texdl]")) && !!(await page.$("#tex-fixed")), "Versions card: download button and keep-in-place box");

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nUpload E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
