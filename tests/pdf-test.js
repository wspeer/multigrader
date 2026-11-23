// PDF download test: make answer sheets as a PDF through the app, then check
// it with poppler (pdfinfo / pdftotext / pdftoppm) and by scanning each page.
//   node tests/pdf-test.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

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
function assert(c, m) { if (!c) throw new Error("ASSERT: " + m); console.log("  ok  " + m); }
const have = (cmd) => { try { execFileSync(cmd, ["-v"], { stdio: "ignore" }); return true; } catch (e) { return false; } };

(async () => {
  if (!have("pdfinfo") || !have("pdftoppm")) { console.log("poppler-utils (pdfinfo, pdftoppm) not installed: skipping"); return; }
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base + "/#/classes");
  page.once("dialog", (d) => d.accept("Calc — Period 2"));
  await page.click("#c-new");
  await page.waitForSelector("#c-paste");
  await page.fill("#c-paste", "Núñez, José\nO'Brien, Zoë\nWiśniewski, Łukasz\nChen, Ana (Annie)");
  await page.waitForSelector("#imp-add:not([disabled])");
  await page.click("#imp-add");
  await page.waitForSelector("tr[data-sid]");

  await page.goto(base + "/#/tests");
  await page.click("#new-test");
  await page.waitForSelector("#t-title");
  await page.fill("#t-title", "Conceptual Test #3: 11.2–11.8");
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "TF");
  await page.fill(".sec-row[data-i='0'] .sec-count", "10");
  await page.dispatchEvent(".sec-row[data-i='0'] .sec-count", "change");
  await page.click("[data-add='AE']");
  await page.fill(".sec-row[data-i='1'] .sec-count", "20");
  await page.dispatchEvent(".sec-row[data-i='1'] .sec-count", "change");
  const qk = await page.$$(".key-quick");
  await qk[0].fill("TFTFTFTFTF");
  await qk[1].fill("ABCDE EDCBA [AC]BDEA CEBDA");
  await page.selectOption("#v-count", "2");
  await page.waitForSelector(".ver-block[data-v='B'] [data-shuffle]");
  await page.click(".ver-block[data-v='B'] [data-shuffle]");

  const testId = await page.evaluate(() => MGStore.db.tests[0].id);
  await page.goto(base + `/#/test/${testId}/print`);
  await page.waitForSelector("#p-pdf");
  await page.fill("#p-blanks", "1");
  await page.check("#p-key");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#p-pdf")]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-pdf-"));
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  assert(dl.suggestedFilename() === "Conceptual Test 3 11.2-11.8 - answer sheets.pdf", "file name: " + dl.suggestedFilename());

  const info = execFileSync("pdfinfo", [file]).toString();
  const pages = +(/Pages:\s+(\d+)/.exec(info) || [])[1];
  assert(pages === 7, "7 pages: 4 students + 1 blank + 2 version keys (got " + pages + ")");
  assert(/Page size:\s+612 x 792 pts/.test(info), "exact Letter size (612 x 792 pt)");
  assert(/Title:\s+Conceptual Test #3: 11\.2–11\.8 — answer sheets/.test(info), "PDF title set");
  console.log("     size: " + fs.statSync(file).size + " bytes");

  const text = execFileSync("pdftotext", ["-layout", file, "-"]).toString();
  assert(text.includes("José Núñez") && text.includes("Zoë O'Brien"), "accented names come through (José Núñez, Zoë O'Brien)");
  assert(text.includes("Lukasz Wiśniewski") || text.includes("Lukasz Wisniewski"), "letters outside Latin-1 fall back to plain letters (Łukasz → Lukasz)");
  assert(text.includes("ANSWER KEY — VERSION B"), "version B key sheet");
  assert(text.includes("Calc — Period 2"), "class name with an em dash");

  // Scan every page.
  const t = await page.evaluate(() => MGStore.db.tests[0]);
  const keys = await page.evaluate(() => ["A", "B"].map((v) => MGStore.versionKey(MGStore.db.tests[0], v)));
  execFileSync("pdftoppm", ["-r", "110", "-png", file, path.join(tmp, "p")]);
  const pngs = fs.readdirSync(tmp).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
  const scanPage = await browser.newPage();
  await scanPage.goto(base + "/index.html");
  const results = [];
  for (const png of pngs) {
    const url = "data:image/png;base64," + fs.readFileSync(path.join(tmp, png)).toString("base64");
    results.push(await scanPage.evaluate(async ([u, test]) => {
      const img = new Image(); img.src = u; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      const r = MGScanner.scan(ctx.getImageData(0, 0, c.width, c.height), { getTest: (code) => (code === test.code ? test : null) });
      return { status: r.status, sheet: r.sheetCode, responses: r.responses, version: r.version };
    }, [url, t]));
  }
  const codes = t.sheets.map((s) => s.code);
  assert(results.slice(0, 5).every((r, i) => r.status === "ok" && r.sheet === codes[i] && r.responses.every((x) => x === "")), "pages 1–5 scan as their own sheet codes, with no marks");
  const letters = (k) => k.replace("&", "");
  assert(results[5].sheet === 4095 && results[5].version === "A" && results[5].responses.join() === keys[0].map(letters).join(), "page 6 (Version A key) scans back exactly as the A key");
  assert(results[6].version === "B" && results[6].responses.join() === keys[1].map(letters).join(), "page 7 (Version B key) scans back exactly as the B key");

  if (process.argv[2]) fs.copyFileSync(path.join(tmp, pngs[0]), path.join(process.argv[2], "pdf-page1.png"));
  assert(errors.length === 0, "no page errors " + errors.join(" | "));
  await browser.close();
  srv.close();
  console.log("\nPDF test passed");
})().catch((e) => { console.error(e); process.exit(1); });
