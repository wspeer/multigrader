// End-to-end test: upload a LaTeX test, fill the key from \CorrectChoice,
// shuffle a version (with a pinned question) and download the reordered .tex.
//   node tests/e2e-latex.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");
require("../js/latex.js");
const X = globalThis.MGLatex;

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
function assert(cond, msg) { if (!cond) throw new Error("ASSERT: " + msg); console.log("  ok  " + msg); }

(async () => {
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
  await page.fill("#t-title", "Unit 4 Test");
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "TF");
  await page.fill(".sec-row[data-i='0'] .sec-count", "3");
  await page.dispatchEvent(".sec-row[data-i='0'] .sec-count", "change");
  await page.click("[data-add='AD']");
  await page.fill(".sec-row[data-i='1'] .sec-count", "4");
  await page.dispatchEvent(".sec-row[data-i='1'] .sec-count", "change");
  await (await page.$$(".key-quick"))[0].fill("TFT");
  await page.selectOption("#v-count", "3");
  await page.waitForSelector(".tex-box");

  // wrong file first: count mismatch is explained
  await page.setInputFiles("#tex-in", path.join(__dirname, "fixtures", "enumerate-sample.tex"));
  await page.waitForSelector(".tex-box .notice.bad");
  assert(/Found 5 questions in the file, but this test has 7/.test(await page.textContent(".tex-box")), "question-count mismatch explained");
  assert(await page.$eval("[data-texdl]", (b) => b.disabled), "download disabled until the file matches");

  await page.setInputFiles("#tex-in", path.join(__dirname, "fixtures", "exam-sample.tex"));
  await page.waitForFunction(() => /found all 7 questions/.test(document.querySelector(".tex-box").textContent));
  assert(true, "exam file: all 7 questions found");
  assert(/differ from your answer key on Q4, Q5, Q6, Q7/.test((await page.textContent(".tex-box")).replace(/\s+/g, " ")), "\\CorrectChoice answers offered for the unkeyed questions");
  await page.click("#tex-usekey");
  const key = await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]));
  assert(key.join("") === "TFTBCAD", "key filled from the file: " + key.join(""));
  assert(/match your key on all 4/.test(await page.textContent(".tex-box")), "file and key now agree");

  // pin Q7 (the figure question), shuffle B, download
  await page.fill("#tex-fixed", "7");
  await page.click(".ver-block[data-v='B'] [data-shuffle]");
  const perm = await page.evaluate(() => MGStore.versionMap(MGStore.db.tests[0], "B"));
  assert(perm[6] === 6, "pinned Q7 stays in place: " + perm.map((m) => m + 1).join(" "));
  assert(perm.slice(0, 3).every((m) => m < 3) && perm.slice(3).every((m) => m >= 3), "shuffle stays within sections");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".ver-block[data-v='B'] [data-texdl]")]);
  assert(dl.suggestedFilename() === "exam-sample-version-B.tex", "file name: " + dl.suggestedFilename());
  const out = fs.readFileSync(await dl.path(), "utf8");
  const outBody = out.replace(/^(%.*\n)+/, "");
  const src = fs.readFileSync(path.join(__dirname, "fixtures", "exam-sample.tex"), "utf8");
  const pa = X.parse(src), pb = X.parse(outBody);
  const body = (s, q) => s.slice(q.start, q.bodyEnd);
  const relabeled = X.relabel(src, "B").text;
  const pr = X.parse(relabeled);
  assert(pb.questions.length === 7 && perm.every((m, k) => body(outBody, pb.questions[k]) === body(relabeled, pr.questions[m])), "downloaded file has the questions in version B's order");
  assert(/\\newcommand\{\\version\}\{B\}/.test(out) && /\{Version B\}/.test(out), "version labels changed to B");
  const vkey = await page.evaluate(() => MGStore.versionKey(MGStore.db.tests[0], "B"));
  assert(out.split("\n")[2].includes(vkey.map((k, i) => `${i + 1}:${k}`).join(" ")), "key comment at top of file: " + out.split("\n")[2]);
  const letters = pb.questions.map((q, i) => (q.correct.length ? "ABCD"[q.correct[0]] : vkey[i]));
  assert(letters.join("") === vkey.join(""), "\\CorrectChoice in the new file matches version B's key");
  const toast = await page.textContent("#toast");
  assert(/Changed “Version A” to “Version B” in 2 places/.test(toast), "toast reports relabel");
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], "latex-panel.png"), fullPage: true });

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nLaTeX E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
