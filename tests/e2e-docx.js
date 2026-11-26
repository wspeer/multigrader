// End-to-end test: upload a Word (.docx) test, choose the answer-sheet
// questions, shuffle a version and download the reordered .docx.
//   node tests/e2e-docx.js [screenshot-dir]
// The sample files are made by tests/fixtures/make-docx-fixtures.py.
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
require("../js/docx.js");
const D = globalThis.MGDocx;

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

// The question text (without its number) of each numbered question.
const qText = (doc, it) => doc.kids.slice(it.start, it.contentEnd).map((k) => k.text).join(" ").replace(/^\s*\d+\s*[.):]?\s*/, "").replace(/\s+/g, " ").trim();
const firstText = (doc, it) => doc.kids[it.start].text;

(async () => {
  // ---- module checks (no browser) ----
  const typedBuf = fs.readFileSync(path.join(FIX, "word-typed-sample.docx"));
  const typed = await D.open(typedBuf);
  const ft = D.findItems(typed);
  assert(ft.mode === "typed" && ft.items.length === 11, "typed numbers: 11 questions (a repeated '7. (continued)' isn't a new one)");
  assert(ft.items[3].picNum && ft.items[3].preview === "(picture)", "a skipped number is taken from the picture on its own line");
  assert(D.guessSelection(ft.items, 9).join(",") === "1,2,3,4,5,6,9,10,11", "answer-sheet questions guessed from the headings and choices: 1–6, 9–11");
  assert(!/End of test/.test(ft.items[10].preview), "'End of test' stays in place instead of moving with Q11");
  const pt = D.parse(typed, ft, [1, 2, 3, 4, 5, 6, 9, 10, 11]);
  assert(pt.questions.map((q) => q.block).join("") === "000000111", "two groups (Part One, Part Three)");
  assert(D.reorder(typed, pt, pt.questions.map((_, i) => i)) === typed.docXml, "same order → document unchanged, byte for byte");

  const auto = await D.open(fs.readFileSync(path.join(FIX, "word-auto-sample.docx")));
  const fa = D.findItems(auto);
  assert(fa.mode === "auto" && fa.items.length === 5 && fa.items.every((it) => it.choices === 4), "automatic numbering: 5 questions, each with a 4-choice lettered list");
  const pa = D.parse(auto, fa, [1, 2, 3, 4, 5]);
  const permA = [4, 2, 0, 1, 3];
  const outA = await D.open(await (await D.build(auto, pa, permA, "B")).blob.arrayBuffer());
  const fo = D.findItems(outA);
  assert(fo.items.map((it) => firstText(outA, it)).join("|") === permA.map((m) => firstText(auto, fa.items[m])).join("|"), "automatic numbering: questions in the new order");
  assert(fo.items.every((it, k) => qText(outA, it) === qText(auto, fa.items[permA[k]])), "answer choices moved with their questions");
  assert(/Quiz, Version B/.test(outA.kids.map((k) => k.text).join(" ")), "'Version A' in the title became 'Version B'");

  // ---- in the app ----
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base + "/#/tests");
  await page.click("#new-test");
  await page.waitForSelector("#t-title");
  await page.fill("#t-title", "Unit 5 Test");
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "AD");
  await page.fill(".sec-row[data-i='0'] .sec-count", "9");
  await page.dispatchEvent(".sec-row[data-i='0'] .sec-count", "change");
  await (await page.$$(".key-quick"))[0].fill("CCCABBBBB");
  await page.selectOption("#v-count", "2");
  await page.waitForSelector("#upload-card");

  // an old .doc is explained, not misread
  let alertText = "";
  page.once("dialog", (d) => { alertText = d.message(); d.accept(); });
  await page.setInputFiles("#tex-in", { name: "old-test.doc", mimeType: "application/msword", buffer: Buffer.from("not a docx") });
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 300));
  assert(/Save As → Word Document \(\.docx\)/.test(alertText), ".doc upload: asks to save as .docx");

  await page.setInputFiles("#tex-in", path.join(FIX, "word-typed-sample.docx"));
  await page.waitForFunction(() => /found all 9 questions for the answer sheet/.test(document.querySelector("#upload-card").textContent));
  const box = (await page.textContent("#upload-card")).replace(/\s+/g, " ");
  assert(/found 11 numbered questions \(typed question numbers\)/.test(box), "panel: 11 numbered questions found");
  assert((await page.inputValue("#src-sel")) === "1–6, 9–11", "answer-sheet questions prefilled: 1–6, 9–11");
  assert(/Numbering on the answer sheet: Q1–6 = file 1–6, Q7–9 = file 9–11/.test(box), "file numbers vs answer-sheet numbers explained");
  assert(/Q4 is a picture with its number inside, so it stays in place/.test(box), "picture question is kept in place");
  assert(/2 groups of questions/.test(box), "groups explained");
  assert(/\.docx/.test(await page.textContent(".ver-block[data-v='B'] [data-texdl]")), "download button says .docx");

  // a wrong selection is explained; fixing it re-enables the download
  await page.fill("#src-sel", "1-6");
  await page.dispatchEvent("#src-sel", "change");
  await page.waitForSelector("#upload-card .notice.bad");
  assert(/You've chosen 6 questions from the file for the answer sheet, but this test's format has 9/.test(await page.textContent("#upload-card")), "count mismatch explained");
  assert(await page.$eval("[data-texdl]", (b) => b.disabled), "download disabled while the count is wrong");
  await page.fill("#src-sel", "1 to 6, 9-11");
  await page.dispatchEvent("#src-sel", "change");
  await page.waitForFunction(() => /found all 9 questions/.test(document.querySelector("#upload-card").textContent));
  assert(!(await page.$eval("[data-texdl]", (b) => b.disabled)), "fixed selection: download enabled");

  let perm;
  for (let i = 0; i < 5; i++) {
    await page.click(".ver-block[data-v='B'] [data-shuffle]");
    perm = await page.evaluate(() => MGStore.versionMap(MGStore.db.tests[0], "B"));
    assert(perm[3] === 3, `shuffle ${i + 1}: Q4 (picture) stays put: ${perm.map((m) => m + 1).join(" ")}`);
    assert(perm.slice(0, 6).every((m) => m < 6) && perm.slice(6).every((m) => m >= 6), "questions stay inside their part");
  }
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".ver-block[data-v='B'] [data-texdl]")]);
  assert(dl.suggestedFilename() === "word-typed-sample-version-B.docx", "file name: " + dl.suggestedFilename());
  await page.waitForFunction(() => /Downloaded Version B/.test(document.querySelector("#toast").textContent));
  assert(/Changed “Version A” to “Version B” in 2 places/.test(await page.textContent("#toast")), "toast: Version A → B in the title and header");

  const out = await D.open(fs.readFileSync(await dl.path()));
  const fb = D.findItems(out);
  assert(fb.items.length === 11 && fb.items.every((it, i) => it.num === i + 1), "new file: questions numbered 1–11 in order");
  const fileNums = [1, 2, 3, 4, 5, 6, 9, 10, 11];
  const srcIt = (n) => ft.items[n - 1];
  const outIt = (n) => fb.items[n - 1];
  assert(perm.every((m, k) => qText(out, outIt(fileNums[k])) === qText(typed, srcIt(fileNums[m]))), "each position holds Version B's question, with its choices");
  assert([7, 8].every((n) => qText(out, outIt(n)) === qText(typed, srcIt(n))), "essay questions 7 and 8 unchanged");
  const allText = out.kids.map((k) => k.text).join("\n").replace(/\s+/g, " ");
  const pos = (s) => allText.indexOf(s);
  assert(pos("PART TWO: SHOW ALL WORK") > pos(qText(out, outIt(6)).slice(0, 15)) && pos("Part Three") < pos(qText(out, outIt(9)).slice(0, 15)) && /End of test\s*$/.test(allText) && pos(qText(out, outIt(6)).slice(0, 12)) > 0 && pos(qText(out, outIt(9)).slice(0, 12)) > 0, "headings and the last line stay where they were");
  assert(out.extra.some((x) => /Version B/.test(x.xml)), "header says Version B");
  const pages = (doc) => (doc.docXml.match(/<w:br w:type="page"\/>/g) || []).length;
  assert(pages(out) === pages(typed), "same number of page breaks");
  const zipNames = (buf) => D._internal.readZip(buf).map((e) => e.name).join(",");
  assert(zipNames(fs.readFileSync(await dl.path())) === zipNames(typedBuf), "every part of the original file is kept (picture included)");

  if (process.argv[2]) {
    await (await page.$("#upload-card")).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.argv[2], "docx-panel.png"), fullPage: true });
  }

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nWord E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
