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
    { seed: 1, tilt: 4, noise: 6, finger: true },
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
  const scannedBox = async () => (await page.$eval(".stats .stat", (s) => s.textContent)).replace(/\s+/g, " ").trim();
  let sb = await scannedBox();
  assert(/^4\/4 \+ 1 unmatched blank sheet students scanned$/.test(sb), "Scanned box: 4/4 students, + 1 unmatched blank sheet (" + sb + ")");
  // assign the blank sheet to a student
  page.once("dialog", (d) => d.accept());
  await page.selectOption("select[data-assign]", { index: 1 });
  await page.waitForTimeout(300);
  sb = await scannedBox();
  assert(/^4\/4 1 student has 2\+ sheets students scanned$/.test(sb), "after matching it to a student who already had a sheet: still 4/4, and it says one student has 2+ sheets (" + sb + ")");
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

  // ---- confirming flagged answers ("to check") ----
  // David Chen's sheet: both A and C bubbled on Q20 → flagged "two bubbles filled".
  const flagged = await page.evaluate(() => {
    const t = MGStore.db.tests[0];
    const s = MGStore.db.scans.find((x) => MGStore.flagCount(x, MGStore.grade(t, x)) > 0);
    return s && { id: s.id, n: MGStore.flagCount(s, MGStore.grade(t, s)) };
  });
  assert(flagged && flagged.n >= 1, `a scan has ${flagged && flagged.n} to check`);
  await page.goto(base + `/#/test/${testId}/results`);
  await page.waitForSelector(`[data-review='${flagged.id}']`);
  const rowCheck = async () => page.$eval(`[data-review='${flagged.id}']`, (b) => (b.closest("tr").textContent.match(/(\d+) to check/) || [0, 0])[1]);
  assert(+(await rowCheck()) === flagged.n, `results row says "${flagged.n} to check"`);
  await page.click(`[data-review='${flagged.id}']`);
  await page.waitForSelector(".check-bar");
  const firstFlag = await page.$eval(".ov-row.flag", (r) => r.dataset.i);
  const scoreBefore = await page.textContent(".score-big");
  await page.click(`.ov-row[data-i='${firstFlag}'] [data-ok]`);
  assert(!(await page.$(`.ov-row[data-i='${firstFlag}'].flag`)), "✓ Looks right clears that question's highlight");
  assert((await page.textContent(`.ov-row[data-i='${firstFlag}']`)).includes("checked ✓"), "the row shows it was checked");
  assert((await page.textContent(".score-big")) === scoreBefore, "confirming doesn't change the score");
  await page.click(`.ov-row[data-i='${firstFlag}'] [data-unok]`);
  assert(!!(await page.$(`.ov-row[data-i='${firstFlag}'].flag`)), "undo puts the flag back");
  await page.click("#ok-all");
  assert(!(await page.$(".ov-row.flag")) && /Everything has been checked/.test(await page.textContent(".check-bar")), "Confirm all as read clears every flag");
  await page.click("#m-done");
  await page.waitForSelector(`[data-review='${flagged.id}']`);
  assert(+(await rowCheck()) === 0, "results row no longer says \"to check\"");
  await page.reload();
  await page.waitForSelector(`[data-review='${flagged.id}']`);
  assert(+(await rowCheck()) === 0, "still checked after a reload");

  // Blank answers are flagged "to check" too (Lee Jordan answered only Q1–9).
  const lee = await page.evaluate(() => {
    const t = MGStore.db.tests[0];
    const s = MGStore.db.scans.find((x) => { const f = x.studentId && MGStore.findStudent(x.studentId); return f && f.student.last === "Jordan"; });
    const g = MGStore.grade(t, s);
    return { id: s.id, blanks: g.byPos.filter((it) => !it.resp).length, n: MGStore.flagCount(s, g) };
  });
  assert(lee.blanks === 16 && lee.n >= 16, `16 blank answers count as "to check" (${lee.n})`);
  await page.click(`[data-review='${lee.id}']`);
  await page.waitForSelector(".check-bar");
  assert((await page.$$eval(".ov-row.flag", (rs) => rs.filter((r) => /left blank/.test(r.textContent)).length)) === 16, "Review highlights each blank as \"left blank\"");
  const bl = await page.$eval(".ov-row.flag", (r) => r.dataset.i);
  await page.click(`.ov-row[data-i='${bl}'] [data-ok]`);
  assert((await page.textContent(`.ov-row[data-i='${bl}']`)).includes("checked ✓"), "a confirmed blank shows \"checked ✓\"");
  await page.click("#ok-all");
  await page.click("#m-done");
  await page.waitForSelector(`[data-review='${lee.id}']`);
  assert(+(await page.$eval(`[data-review='${lee.id}']`, (b) => (b.closest("tr").textContent.match(/(\d+) to check/) || [0, 0])[1])) === 0, "after Confirm all, no blanks left to check");

  // ---- item analysis: sort by % correct ----
  const order = () => page.$$eval(".items tbody tr", (trs) => trs.map((tr) => [+tr.cells[0].textContent, parseFloat(tr.cells[2].textContent)]));
  const o0 = await order();
  assert(o0.map((r) => r[0]).join() === o0.map((_, i) => i + 1).join(), "item analysis starts in question order");
  await page.click("#item-sort");
  const o1 = await order();
  assert(o1.every((r, k) => k === 0 || r[1] >= o1[k - 1][1]), "1st click: lowest % first (" + o1.slice(0, 4).map((r) => `Q${r[0]} ${r[1]}%`).join(", ") + ", …)");
  await page.click("#item-sort");
  const o2 = await order();
  assert(o2.every((r, k) => k === 0 || r[1] <= o2[k - 1][1]), "2nd click: highest % first");
  await page.click("#item-sort");
  assert((await order()).map((r) => r[0]).join() === o0.map((r) => r[0]).join(), "3rd click: back to question order");

  // ---- students: sort by score ----
  const sOrder = () => page.$$eval("section.card:first-of-type table tbody tr:not(.missing)", (trs) => trs.map((tr) => [tr.cells[0].textContent.trim(), parseFloat(tr.querySelector("td.num strong").textContent)]));
  const s0 = await sOrder();
  assert(s0.some((r) => r[0] === "Chen, David") && s0.some((r) => r[0] === "Garcia, Maria"), "Students table lists names as Last, First");
  // Summary boxes: points (2 decimals max) over possible, with the percent.
  const want = await page.evaluate(() => {
    const t = MGStore.db.tests[0];
    const sc = MGStore.db.scans.map((s) => MGStore.grade(t, s).score).sort((a, b) => a - b);
    const r2 = (x) => String(Math.round(x * 100) / 100);
    const mean = sc.reduce((a, b) => a + b, 0) / sc.length, med = (sc[Math.floor((sc.length - 1) / 2)] + sc[Math.ceil((sc.length - 1) / 2)]) / 2;
    return [mean, med, sc[sc.length - 1], sc[0]].map((v) => `${r2(v)}/41${Math.round((100 * v) / 41)}%`);
  });
  const got = await page.$$eval(".stats .stat", (st) => st.slice(1).map((s) => s.querySelector(".stat-n").textContent + s.querySelector(".stat-p").textContent));
  assert(JSON.stringify(got) === JSON.stringify(want), "mean / median / high / low shown as points and percent: " + got.join(" · "));
  assert(!(await page.$eval("#student-sort", (b) => b.classList.contains("on"))) && /⇅/.test(await page.textContent("#student-sort")), "Score header shows it's sortable (⇅) and starts unsorted");
  await page.click("#student-sort");
  const s1 = await sOrder();
  assert(s1.every((r, k) => k === 0 || r[1] >= s1[k - 1][1]) && /lowest first/.test(await page.textContent("#student-sort")), "1st click: lowest score first, header says so (" + s1.map((r) => r[1] + "%").join(", ") + ")");
  await page.click("#student-sort");
  const s2 = await sOrder();
  assert(s2.every((r, k) => k === 0 || r[1] <= s2[k - 1][1]) && /highest first/.test(await page.textContent("#student-sort")), "2nd click: highest score first");
  await page.click("#student-sort");
  assert(JSON.stringify(await sOrder()) === JSON.stringify(s0), "3rd click: back to name order");

  // ---- students: sort by name (last name), and switching columns ----
  const lastOf = (rows) => rows.filter((r) => !/Blank sheet/.test(r[0])).map((r) => r[0].split(",")[0]);
  await page.click("#name-sort");
  const nm1 = lastOf(await sOrder());
  assert(nm1.join() === [...nm1].sort((a, b) => a.localeCompare(b)).join() && /A–Z/.test(await page.textContent("#name-sort")), "Student header: 1st click A–Z by last name (" + nm1.join(", ") + ")");
  await page.click("#name-sort");
  const nm2 = lastOf(await sOrder());
  assert(nm2.join() === [...nm1].reverse().join() && /Z–A/.test(await page.textContent("#name-sort")), "2nd click: Z–A");
  await page.click("#student-sort");
  assert(!(await page.$eval("#name-sort", (b) => b.classList.contains("on"))) && (await page.$eval("#student-sort", (b) => b.classList.contains("on"))), "clicking Score switches the sort to Score (one column at a time)");
  await page.click("#student-sort");
  await page.click("#student-sort");
  assert(JSON.stringify(await sOrder()) === JSON.stringify(s0), "back to the usual order");

  // ---- item analysis: sort by question number ----
  await page.click("#q-sort");
  assert((await order()).map((r) => r[0]).join() === o0.map((r) => r[0]).join() && /1 → last/.test(await page.textContent("#q-sort")), "Q header: 1st click first to last");
  await page.click("#q-sort");
  assert((await order()).map((r) => r[0]).join() === o0.map((r) => r[0]).reverse().join() && /last → 1/.test(await page.textContent("#q-sort")), "2nd click: last to first");
  await page.click("#q-sort");
  assert((await order()).map((r) => r[0]).join() === o0.map((r) => r[0]).join() && !(await page.$eval("#q-sort", (b) => b.classList.contains("on"))), "3rd click: off, question order");

  // ---- item analysis: who gave a particular answer ----
  const whoExpected = (q, c) => page.evaluate(([q, c]) => {
    const t = MGStore.db.tests[0];
    return MGStore.db.scans.map((s) => ({ s, it: MGStore.grade(t, s).items[q] }))
      .filter(({ it }) => (c === "blank" ? !it.resp : c === "multiple" ? it.resp.length > 1 : it.resp === c))
      .map(({ s }) => { const f = s.studentId && MGStore.findStudent(s.studentId); return f ? `${f.student.last}, ${f.student.first}` : `Blank sheet #${s.sheetCode}`; }).sort();
  }, [q, c]);
  const whoShown = () => page.$$eval(".who-row .who-name", (bs) => bs.map((b) => b.childNodes[0].textContent.trim()).sort());
  const wantF = await whoExpected(0, "F");
  await page.click(".items [data-iq='0'][data-ic='F']");
  await page.waitForSelector(".who-row");
  assert(JSON.stringify(await whoShown()) === JSON.stringify(wantF), `Q1 → F lists who answered F: ${wantF.join(", ")}`);
  assert(/Q1: \d+ answered F/.test(await page.textContent(".who-row")), "the list says which question and answer");
  const wantMulti = await whoExpected(19, "multiple");
  await page.click(".items [data-iq='19'][data-ic='multiple']");
  await page.waitForSelector(".who-row");
  assert((await page.$$(".who-row")).length === 1, "only one list open at a time");
  assert(JSON.stringify(await whoShown()) === JSON.stringify(wantMulti) && /\(A, C\)/.test(await page.textContent(".who-row")), `Q20 → multiple shows ${wantMulti.join(", ")} with the letters bubbled (A, C)`);
  await page.click(".who-row .who-name");
  await page.waitForSelector(".review");
  assert((await page.textContent(".review h2")).trim() === wantMulti[0].split(", ").reverse().join(" "), "clicking a name opens that student's sheet");
  await page.click("#m-done");
  await page.waitForSelector(".who-row");
  await page.click(".items [data-iq='19'][data-ic='multiple']");
  assert(!(await page.$(".who-row")), "clicking the response again closes the list");
  if (SHOTS) {
    await page.click(".items [data-iq='0'][data-ic='F']");
    await (await page.$(".who-row")).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "who-answered.png") });
    await page.click(".items [data-iq='0'][data-ic='F']");
  }

  // ---- graded copies to hand back (PDF) ----
  const [gdl] = await Promise.all([page.waitForEvent("download"), page.click("#r-graded")]);
  const gfile = await gdl.path();
  assert(gdl.suggestedFilename() === "Unit 4 Test Quadratics - graded copies.pdf", "graded copies file: " + gdl.suggestedFilename());
  const gbytes = fs.readFileSync(gfile, "latin1");
  assert((gbytes.match(/\/Type \/Page\b(?!s)/g) || []).length === 5, "one graded copy per scanned sheet (5)");
  assert((gbytes.match(/\/Subtype \/Image/g) || []).length === 5 && /\/DCTDecode/.test(gbytes), "each copy uses the student's own scanned image (5 JPEGs embedded)");
  let havePoppler = true;
  try { require("child_process").execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch (e) { havePoppler = false; }
  if (havePoppler) {
    const { execFileSync } = require("child_process");
    const gtext = execFileSync("pdftotext", ["-layout", gfile, "-"]).toString();
    const scores = await page.evaluate(() => { const t = MGStore.db.tests[0]; return MGStore.db.scans.filter((s) => s.studentId).map((s) => { const f = MGStore.findStudent(s.studentId); return [MGStore.studentName(f.student), MGStore.grade(t, s).score]; }); });
    assert(scores.every(([name, sc]) => gtext.includes(name) && gtext.includes(`${sc} / 41`)), "each copy shows the student's name and score");
    assert((gtext.match(/GRADED COPY/g) || []).length === 5, "every page is labeled GRADED COPY");
    assert(/\(graded as F\)/.test(gtext), "an answer corrected in Review is noted on the copy (graded as F)");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "mg-g-"));
    // Fingers in the margins of a scan don't show up on any graded copy.
    execFileSync("pdftoppm", ["-r", "40", "-png", gfile, path.join(dir, "m")]);
    const margins = await page.evaluate(async (urls) => {
      const out = [];
      for (const u of urls) {
        const img = new Image(); img.src = u; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
        const mm = img.width / 215.9;
        const dark = (x0, y0, x1, y1) => {
          const d = ctx.getImageData(x0 * mm, y0 * mm, (x1 - x0) * mm, (y1 - y0) * mm).data;
          let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n++;
          return n;
        };
        out.push({ left: dark(0, 60, 10, 250), right: dark(206, 60, 215, 250), grid: dark(40, 70, 180, 160) });
      }
      return out;
    }, fs.readdirSync(dir).filter((f) => f.startsWith("m") && f.endsWith(".png")).sort().map((f) => "data:image/png;base64," + fs.readFileSync(path.join(dir, f)).toString("base64")));
    assert(margins.length === 5 && margins.every((m) => m.left === 0 && m.right === 0), "no fingers (or anything else) in the margins of any graded copy");
    assert(margins.every((m) => m.grid > 20), "the students' pencil marks are still there");
    execFileSync("pdftoppm", ["-r", "100", "-f", "1", "-l", "1", "-png", gfile, path.join(dir, "g")]);
    const g1 = fs.readdirSync(dir).find((f) => f.endsWith(".png"));
    if (SHOTS) fs.copyFileSync(path.join(dir, g1), path.join(SHOTS, "graded-copy.png"));
    const st = await page.evaluate(async (u) => {
      const img = new Image(); img.src = u; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      return MGScanner.scan(c.getContext("2d").getImageData(0, 0, c.width, c.height), { getTest: MGStore.testByCode }).status;
    }, "data:image/png;base64," + fs.readFileSync(path.join(dir, g1)).toString("base64"));
    assert(st !== "ok", "a graded copy can't be scanned as an answer sheet (" + st + ")");
  }

  // ---- export / import round trip ----
  await page.goto(base + "/#/data");
  await page.waitForFunction(() => /5 images/.test(document.querySelector("#d-images-size").textContent));
  assert(/5 images, about [\d.]+ MB/.test(await page.textContent("#d-images-size")), "Import/export shows the images and their size: " + (await page.textContent("#d-images-size")));
  const [bdl] = await Promise.all([page.waitForEvent("download"), page.click("#d-export")]);
  const json = fs.readFileSync(await bdl.path(), "utf8");
  await page.uncheck("#d-images");
  const [bdl2] = await Promise.all([page.waitForEvent("download"), page.click("#d-export")]);
  const jsonNoImg = fs.readFileSync(await bdl2.path(), "utf8");
  assert(Object.keys(JSON.parse(json).images || {}).length === 5 && !JSON.parse(jsonNoImg).images && jsonNoImg.length < json.length / 5,
    `backup includes the 5 scan images (${(json.length / 1e6).toFixed(2)} MB; without images ${(jsonNoImg.length / 1e3).toFixed(0)} KB)`);
  const page2 = await (await browser.newContext()).newPage();
  await page2.goto(base + "/#/data");
  await page2.setInputFiles("#d-import", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await page2.waitForFunction(() => /Imported/.test(document.querySelector("#toast").textContent));
  assert(/and 5 scanned images/.test(await page2.textContent("#toast")), "import reports the images: " + (await page2.textContent("#toast")));
  const n2 = await page2.evaluate(() => [MGStore.db.classes.length, MGStore.db.tests.length, MGStore.db.scans.length]);
  assert(n2.join() === "1,1,5", "backup imports on a fresh device: " + n2);
  const imgs2 = await page2.evaluate(async () => { let n = 0; for (const s of MGStore.db.scans) if (await MGStore.getImage(s.id)) n++; return n; });
  assert(imgs2 === 5, "all 5 scan images restored on the new device");
  await page2.goto(base + `/#/test/${testId}/results`);
  await page2.click("[data-review]");
  await page2.waitForSelector(".review .img-wrap img");
  assert(await page2.$eval(".review .img-wrap img", (i) => i.complete && i.naturalWidth > 500), "Review on the new device shows the scanned sheet");
  await page2.click("#m-done");

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
