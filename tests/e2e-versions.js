// End-to-end test of test versions and "all required" answer keys.
//   node tests/e2e-versions.js [screenshot-dir]
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
function assert(cond, msg) { if (!cond) throw new Error("ASSERT: " + msg); console.log("  ok  " + msg); }

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); };

  // class
  await page.goto(base + "/#/classes");
  page.once("dialog", (d) => d.accept("Geometry"));
  await page.click("#c-new");
  await page.waitForSelector("#c-paste");
  await page.fill("#c-paste", "Adams, Ann\nBrown, Ben\nCruz, Cara\nDiaz, Dev");
  await page.waitForSelector("#imp-add:not([disabled])");
  await page.click("#imp-add");
  await page.waitForSelector("tr[data-sid]");

  // test: 6 × A–D, 4 × T/F
  await page.goto(base + "/#/tests");
  await page.click("#new-test");
  await page.waitForSelector("#t-title");
  await page.fill("#t-title", "Quiz 5");
  await page.fill(".sec-row[data-i='0'] .sec-count", "6");
  await page.dispatchEvent(".sec-row[data-i='0'] .sec-count", "change");
  await page.selectOption(".sec-row[data-i='0'] .sec-type", "AD");
  await page.click("[data-add='TF']");
  await page.fill(".sec-row[data-i='1'] .sec-count", "4");
  await page.dispatchEvent(".sec-row[data-i='1'] .sec-count", "change");

  // key: Q3 = A and C both required; Q5 = B or D
  const quick = await page.$$(".key-quick");
  await quick[0].fill("AB[AC]D(BD)C");
  await quick[1].fill("TFTF");
  let key = await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]));
  assert(key.join(",") === "A,B,&AC,D,BD,C,T,F,T,F", "typed key with all-required and either: " + key.join(","));
  // the tag on Q3 toggles all-required ↔ either and back
  const q3 = (await page.$$(".key-sec[data-si='0'] .key-row"))[2];
  assert((await (await q3.$(".kmode")).textContent()) === "all required", "Q3 tagged 'all required'");
  await (await q3.$(".kmode")).click();
  key = await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]));
  assert(key[2] === "AC", "tag click switches Q3 to 'either'");
  await (await q3.$(".kmode")).click();
  key = await page.evaluate(() => MGStore.flatKey(MGStore.db.tests[0]));
  assert(key[2] === "&AC", "and back to 'all required'");

  // versions: 2, version B order typed in
  await page.selectOption("#v-count", "2");
  await page.waitForSelector(".ver-block[data-v='B']");
  const orders = await page.$$(".ver-block[data-v='B'] .ver-order");
  await orders[0].fill("3 1 2 6");
  assert(/missing: 4, 5/.test(await page.textContent(".ver-block[data-v='B'] .ver-sec[data-si='0'] .ver-msg")), "incomplete order is rejected with a message");
  await orders[0].fill("3 1 2 6 4 5");
  await orders[1].fill("10 9 8 7");
  await page.waitForTimeout(400);
  const perm = await page.evaluate(() => MGStore.versionMap(MGStore.db.tests[0], "B"));
  assert(perm.join(",") === "2,0,1,5,3,4,9,8,7,6", "version B order stored: " + perm.join(","));
  const vkText = await page.textContent(".ver-block[data-v='B'] .vk-list");
  assert(/\[AC\]AB/.test(vkText.replace(/\s/g, "")), "version B key shown in B order: " + vkText.replace(/\s+/g, " ").trim());
  await shot("v1-build");

  // print 4 named + key sheet per version
  const testId = await page.evaluate(() => MGStore.db.tests[0].id);
  await page.goto(base + `/#/test/${testId}/print`);
  await page.waitForSelector("#p-pdf");
  await page.check("#p-key");
  assert(/6 sheets/.test(await page.textContent("#p-pdf")), "4 students + 2 version key sheets");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#p-pdf")]);
  const pdfBytes = fs.readFileSync(await dl.path(), "latin1");
  assert((pdfBytes.match(/\/Type \/Page\b(?!s)/g) || []).length === 6, "PDF has 6 pages");
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "v-sheets.pdf"), pdfBytes, "latin1");
  // The same sheets as SVG (drawn from the same shapes as the PDF), to fill in and photograph.
  const svgs = await page.evaluate(() => {
    const t = MGStore.db.tests[0];
    const opts = t.sheets.map((s) => {
      const f = MGStore.findStudent(s.studentId);
      return { testCode: t.code, sheetCode: s.code, studentName: MGStore.studentName(f.student), className: f.cls.name };
    });
    for (const v of ["A", "B"]) opts.push({ testCode: t.code, sheetCode: MGLayout.SHEET_KEY, key: MGStore.versionKey(t, v), version: v });
    return opts.map((o) => MGLayout.renderSheetSVG(t, o));
  });
  assert(svgs[0].includes(">VERSION<"), "sheets have a VERSION bubble row");
  assert(svgs[5].includes("ANSWER KEY — VERSION B"), "version B key sheet");
  const test = await page.evaluate(() => MGStore.db.tests[0]);
  const sheets = test.sheets; // Adams, Brown, Cruz, Diaz

  // Master (Version A order) answers
  const perfect = ["A", "B", "AC", "D", "B", "C", "T", "F", "T", "F"];
  const toB = (master) => perm.map((m) => master[m]);
  const cruzMaster = ["A", "C", "AC", "D", "D", "B", "T", "T", "T", "F"]; // Q2, Q6, Q8 wrong
  const diazMaster = ["A", "B", "A", "D", "B", "C", "T", "F", "T", "F"]; // Q3 only half → wrong
  const students = [
    { answers: perfect, version: "A" }, // Adams
    { answers: toB(perfect), version: "B" }, // Brown: same answers on version B
    { answers: toB(cruzMaster), version: "" }, // Cruz: version B, forgot to bubble it
    { answers: diazMaster, version: "A" }, // Diaz
  ];
  const helper = await ctx.newPage();
  await helper.goto(base + "/tests/scanner-test.html");
  const files = [];
  for (let i = 0; i < 4; i++) {
    const url = await helper.evaluate(([svg, t, a, o]) => window.makePhoto(svg, t, a, o), [svgs[i], test, students[i].answers, { seed: 20 + i, tilt: 3 - i * 2, noise: 6, version: students[i].version, rotate: i === 1 ? 2 : 0 }]);
    files.push({ name: `S${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(url.split(",")[1], "base64") });
  }
  for (const [i, v] of [[4, "A"], [5, "B"]]) {
    const url = await helper.evaluate(([svg, t, seed]) => window.makePhoto(svg, t, [], { seed, tilt: 2 }), [svgs[i], test, 30 + i]);
    files.push({ name: `KEY_${v}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(url.split(",")[1], "base64") });
  }
  await helper.close();

  await page.goto(base + "/#/scan");
  await page.setInputFiles("#photo-in", files);
  await page.waitForFunction(() => /Scanned \d+ of 6/.test(document.querySelector("#scan-status").textContent), null, { timeout: 60000 });
  const st = (await page.textContent("#scan-status")).replace(/\s+/g, " ");
  console.log("  scan status: " + st.trim());
  assert(/Scanned 6 of 6/.test(st), "all photos read");
  assert(/Version A answer key sheet matches/.test(st) && /Version B answer key sheet matches/.test(st), "both version key sheets match the saved key");

  const res = await page.evaluate((codes) => {
    const t = MGStore.db.tests[0];
    return codes.map((c) => {
      const s = MGStore.db.scans.find((x) => x.sheetCode === c);
      const g = MGStore.grade(t, s);
      return { read: s.version, version: g.version, inferred: g.versionInferred, score: g.score, possible: g.possible, items: g.items.map((it) => it.resp + (it.correct ? "+" : "-")), flags: MGStore.flagCount(s, g) };
    });
  }, sheets.map((s) => s.code));
  assert(res[0].version === "A" && res[0].score === 10 && res[0].possible === 10, "Adams (A): 10/10");
  assert(res[1].version === "B" && !res[1].inferred && res[1].score === 10, "Brown (B, same answers reordered): 10/10");
  assert(res[0].items.join() === res[1].items.join(), "Adams and Brown identical in Version A numbering (item analysis consistent)");
  assert(res[2].read === "" && res[2].version === "B" && res[2].inferred && res[2].score === 7, `Cruz (forgot version): inferred B, 7/10 (got ${res[2].version} ${res[2].score})`);
  assert(res[2].flags >= 1, "Cruz flagged for the missing version");
  assert(res[3].score === 9 && res[3].items[2] === "A-", "Diaz: only A on the all-required A+C question → wrong, 9/10");
  assert(res[0].flags === 0, "two bubbles on an all-required question is not flagged");

  // results page + item analysis
  await page.goto(base + `/#/test/${testId}/results`);
  await page.waitForSelector(".items");
  const q2 = await page.$eval(".items tbody tr:nth-child(2)", (tr) => tr.textContent.replace(/\s+/g, " "));
  assert(/75%/.test(q2), "item analysis Q2 (A numbering): 3 of 4 correct across versions — " + q2.trim());
  await shot("v2-results");

  // review: change Cruz's version manually
  const cruzScan = await page.evaluate((c) => MGStore.db.scans.find((x) => x.sheetCode === c).id, sheets[2].code);
  await page.click(`[data-review='${cruzScan}']`);
  await page.waitForSelector(".ver-bar");
  await page.waitForTimeout(400);
  await shot("v3-review");
  // Confirming the guessed version clears its flag without changing the grade.
  await page.click("#ver-ok");
  assert(!(await page.$(".ver-bar.flag")) && /^7\//.test((await page.textContent(".score-big")).trim()), "✓ Confirm B clears the version flag, still 7/10");
  const cruzFlags = await page.evaluate((id) => { const t = MGStore.db.tests[0]; const s = MGStore.db.scans.find((x) => x.id === id); return MGStore.flagCount(s, MGStore.grade(t, s)); }, cruzScan);
  assert(cruzFlags === 0, "Cruz no longer counts as 'to check'");
  await page.click(".ver-bar [data-ver='A']");
  const sc = await page.textContent(".score-big");
  assert(!/^7\//.test(sc.trim()), "choosing version A regrades Cruz: " + sc.trim());
  await page.click(".ver-bar [data-ver='B']");
  assert(/^7\//.test((await page.textContent(".score-big")).trim()), "back to B: 7/10");
  await page.click("#m-done");

  assert(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log("\nVersions E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
