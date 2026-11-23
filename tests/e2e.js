// End-to-end test of the app: class → test → print → fill + photograph → scan → results.
//   node tests/e2e.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2];
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

function assert(cond, msg) { if (!cond) { throw new Error("ASSERT: " + msg); } console.log("  ok  " + msg); }

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); };

  await page.goto(base + "/index.html");
  await shot("01-empty");

  // ---- class ----
  await page.goto(base + "/#/classes");
  page.once("dialog", (d) => d.accept("Algebra II – Period 3"));
  await page.click("#c-new");
  await page.waitForSelector("#c-paste");
  await page.fill("#c-paste", "Garcia, Maria\nChen, David\nSam Okafor\nLee\tJordan");
  await page.waitForSelector("#imp-add:not([disabled])");
  await page.click("#imp-add");
  await page.waitForSelector("tr[data-sid]");
  assert((await page.$$("tr[data-sid]")).length === 4, "roster has 4 students");
  await shot("02-class");

  // ---- test ----
  await page.goto(base + "/#/tests");
  await page.click("#new-test");
  await page.waitForSelector("#t-title");
  await page.fill("#t-title", "Unit 4 Test: Quadratics");
  // section 1: change default (10 × A–E) to 5 × T/F
  await page.fill(".sec-row[data-i='0'] .sec-count", "5");
  await page.dispatchEvent(".sec-row[data-i='0'] .sec-count", "change");
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "TF");
  await page.click("[data-add='ASN']");
  await page.fill(".sec-row[data-i='1'] .sec-count", "4");
  await page.dispatchEvent(".sec-row[data-i='1'] .sec-count", "change");
  await page.click("[data-add='AE']");
  await page.fill(".sec-row[data-i='2'] .sec-count", "16");
  await page.dispatchEvent(".sec-row[data-i='2'] .sec-count", "change");
  await page.fill(".sec-row[data-i='2'] .sec-points", "2");
  const quick = await page.$$(".key-quick");
  assert(quick.length === 3, "three answer-key sections");
  await quick[0].fill("TFFTF");
  await quick[1].fill("ASNS");
  await quick[2].fill("ABCDE EDCBA (AC)BDE A");
  // a click on a bubble: Q25 (last) → change to E
  const last = await page.$$(".key-sec[data-si='2'] .key-row");
  await (await last[15].$(".kb[data-c='E']")).click();
  await page.waitForTimeout(400);
  await shot("03-build");
  const status = await page.textContent("#key-status");
  assert(/All 25/.test(status), "key complete: " + status.trim());

  const testId = await page.evaluate(() => MGStore.db.tests[0].id);
  const key = await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]));
  assert(key.join(",") === "T,F,F,T,F,A,S,N,S,A,B,C,D,E,E,D,C,B,A,AC,B,D,E,A,E", "key stored per question: " + key.join(","));

  // ---- answer sheets (PDF) ----
  await page.goto(base + `/#/test/${testId}/print`);
  await page.waitForSelector("#p-pdf");
  await page.fill("#p-blanks", "1");
  await page.check("#p-key");
  await shot("04-print");
  assert(!(await page.$("#p-go")) && !(await page.$("#print-root")), "no browser-print path (PDF download only)");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#p-pdf")]);
  const pdfBytes = fs.readFileSync(await dl.path(), "latin1");
  const pdfPages = (pdfBytes.match(/\/Type \/Page\b(?!s)/g) || []).length;
  assert(pdfPages === 6, "PDF has 4 named + 1 blank + 1 key sheet = " + pdfPages);
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "sheets.pdf"), pdfBytes, "latin1");
  // The same sheets as SVG (drawn from the same shapes as the PDF), to fill in and photograph.
  const svgs = await page.evaluate(() => {
    const t = MGStore.db.tests[0];
    const opts = t.sheets.map((s) => {
      const f = s.studentId ? MGStore.findStudent(s.studentId) : null;
      return { testCode: t.code, sheetCode: s.code, studentName: f ? MGStore.studentName(f.student) : "", className: f ? f.cls.name : "" };
    });
    opts.push({ testCode: t.code, sheetCode: MGLayout.SHEET_KEY, key: MGStore.flatKey(t) });
    return opts.map((o) => MGLayout.renderSheetSVG(t, o));
  });
  const test = await page.evaluate(() => MGStore.db.tests[0]);
  const sheets = test.sheets;
  assert(sheets.length === 5 && sheets.filter((s) => s.studentId).length === 4, "sheet codes assigned (4 named, 1 blank)");

  // ---- fill in + photograph (in a helper page) ----
  const helper = await ctx.newPage();
  await helper.goto(base + "/tests/scanner-test.html");
  const fullKey = key;
  const choices = await page.evaluate(() => MGLayout.questionChoices(MGStore.db.tests[0]));
  const studentAnswers = [
    key.slice(), // perfect
    key.map((k, i) => (i % 3 === 0 ? choices[i][(choices[i].indexOf(k[0]) + 1) % choices[i].length] : k[0])),
    key.map((k, i) => (i < 9 ? k[0] : "")),
    key.map((k) => k[0]),
    key.map((k, i) => (i % 2 ? k[0] : "")),
  ];
  const opts = [
    { seed: 1, tilt: 4, noise: 6 },
    { seed: 2, rotate: 2, tilt: -3, noise: 8, light: 0.3, blur: 1 },
    { seed: 3, rotate: 1, outW: 3000, outH: 2250, tilt: 2, noise: 5 },
    { seed: 4, tilt: -7, bow: 2, noise: 6 },
    { seed: 5, tilt: 1, noise: 4 },
  ];
  const files = [];
  for (let i = 0; i < 5; i++) {
    const url = await helper.evaluate(([svg, t, a, o]) => window.makePhoto(svg, t, a, o), [svgs[i], test, studentAnswers[i], opts[i]]);
    files.push({ name: `IMG_${100 + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(url.split(",")[1], "base64") });
  }
  // answer key sheet photo (already filled by the printer)
  const keyUrl = await helper.evaluate(([svg, t]) => window.makePhoto(svg, t, [], { seed: 9, tilt: 3 }), [svgs[5], test]);
  files.push({ name: "IMG_KEY.jpg", mimeType: "image/jpeg", buffer: Buffer.from(keyUrl.split(",")[1], "base64") });
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "photo-sample.jpg"), files[1].buffer);
  await helper.close();

  // ---- scan photos ----
  await page.goto(base + "/#/scan");
  await page.setInputFiles("#photo-in", files);
  await page.waitForFunction(() => /Scanned \d+ of 6/.test(document.querySelector("#scan-status").textContent), null, { timeout: 60000 });
  const st = await page.textContent("#scan-status");
  console.log("  scan status: " + st.replace(/\s+/g, " ").trim());
  assert(/Scanned 6 of 6/.test(st), "all 6 photos read");
  assert(/matches your saved key/.test(st), "answer-key sheet verified against saved key");
  await page.waitForTimeout(500);
  await shot("05-scan");

  // ---- results ----
  const scans = await page.evaluate(() => MGStore.db.scans.map((s) => ({ sheet: s.sheetCode, student: s.studentId, g: MGStore.grade(MGStore.db.tests[0], s), resp: s.responses })));
  assert(scans.length === 5, "5 scans saved (key sheet not saved)");
  const pts = [1, 1, 1, 1, 1, 1, 1, 1, 1, ...Array(16).fill(2)];
  const possible = pts.reduce((a, b) => a + b);
  for (let i = 0; i < 5; i++) {
    const sc = scans.find((s) => s.sheet === sheets[i].code);
    const expect = studentAnswers[i].reduce((a, r, q) => a + (r.length === 1 && fullKey[q].includes(r) ? pts[q] : 0), 0);
    if (sc && sc.resp.join(",") !== studentAnswers[i].join(",")) console.log("   want", studentAnswers[i].join(","), "\n   got ", sc.resp.join(","));
    assert(sc && sc.resp.join(",") === studentAnswers[i].join(","), `sheet ${i + 1}: responses read exactly`);
    assert(sc.g.score === expect && sc.g.possible === possible, `sheet ${i + 1}: score ${sc.g.score}/${sc.g.possible} (expected ${expect}/${possible})`);
  }
  await page.goto(base + `/#/test/${testId}/results`);
  await page.waitForSelector(".stats");
  await shot("06-results");
  // assign the blank sheet to a student
  await page.selectOption("select[data-assign]", { index: 1 });
  await page.waitForTimeout(200);
  // review + override
  await page.click("[data-review]");
  await page.waitForSelector(".review");
  await page.waitForTimeout(500);
  await shot("07-review");
  const before = await page.textContent(".score-big");
  await page.click(".ov-row[data-i='0'] .ob[data-c='F']");
  const after = await page.textContent(".score-big");
  assert(before !== after, `override changes score (${before.trim()} → ${after.trim()})`);
  await page.click("#m-done");

  // ---- export / import round trip ----
  const json = await page.evaluate(() => MGStore.exportJSON());
  const page2 = await (await browser.newContext()).newPage();
  await page2.goto(base + "/#/data");
  await page2.setInputFiles("#d-import", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await page2.waitForTimeout(300);
  const n2 = await page2.evaluate(() => [MGStore.db.classes.length, MGStore.db.tests.length, MGStore.db.scans.length]);
  assert(n2.join() === "1,1,5", "backup imports on a fresh device: " + n2);

  // ---- phone-sized layout ----
  if (SHOTS) {
    const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pp = await ph.newPage();
    await pp.goto(base + "/#/data");
    await pp.setInputFiles("#d-import", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(json) });
    await pp.goto(base + `/#/test/${testId}/build`);
    await pp.waitForTimeout(400);
    await pp.screenshot({ path: path.join(SHOTS, "08-phone-build.png"), fullPage: false });
    await pp.goto(base + `/#/test/${testId}/results`);
    await pp.waitForTimeout(300);
    await pp.screenshot({ path: path.join(SHOTS, "09-phone-results.png"), fullPage: false });
  }

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nE2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
