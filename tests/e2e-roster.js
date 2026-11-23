// Roster import: pasted text (CSV with header), duplicates, and screenshots
// read with the bundled OCR (file picker and Ctrl/Cmd+V). Made-up names only.
//   node tests/e2e-roster.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".gz": "application/octet-stream" };
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

// A roster screenshot in the style of a school information system.
const ROSTER = [
  ["Abbott", "Jordan", "V", ""], ["Baker", "Lin", "IV", ""], ["Castillo", "Mia", "V", "Advanced"],
  ["Dunn", "Eli", "IV", ""], ["Foster", "Noah", "V", "Advanced"], ["Kowalski", "Ava", "V", ""],
  ["Nguyen", "Sam", "V", "Advanced"], ["Ortiz", "Leo", "IV", "AP"], ["Patel", "Rhea", "V", ""],
];
const rosterHTML = `<html><body style="margin:0;font-family:'Source Sans Pro',Helvetica,Arial,sans-serif;background:#fff">
  <div id="r" style="width:430px">${ROSTER.map(([l, f, g, x], i) => `<div style="padding:16px 10px;font-size:27px;background:${i % 2 ? "#f3f4f8" : "#fff"}">
    <b>${l},</b> ${f} <span style="color:#777;font-size:19px">(${g})</span>${x ? ` <span style="color:#777;font-size:19px;margin-left:6px">${x}</span>` : ""}</div>`).join("")}</div></body></html>`;

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Make the "screenshot".
  const shotPage = await ctx.newPage();
  await shotPage.setContent(rosterHTML);
  const png = await (await shotPage.$("#r")).screenshot();
  await shotPage.close();
  if (process.argv[2]) fs.writeFileSync(path.join(process.argv[2], "roster-shot.png"), png);

  await page.goto(base + "/#/classes");
  page.once("dialog", (d) => d.accept("Algebra II"));
  await page.click("#c-new");
  await page.waitForSelector("#c-paste");

  // 1. CSV export with a header row.
  await page.fill("#c-paste", "Last Name,First Name,Grade,Email\nGarcia,Maria,11,mg@x.org\nChen,David,10,dc@x.org");
  await page.waitForSelector(".import-preview");
  const prev = await page.$$eval(".import-preview tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("input[data-f]")].map((i) => i.value).join("|")));
  assert(prev.join(" ; ") === "Maria|Garcia|11 ; David|Chen|10", "CSV with header previews as names + form: " + prev.join(" ; "));
  await page.click("#imp-add");
  await page.waitForSelector("tr[data-sid]");
  let roster = await page.evaluate(() => MGStore.db.classes[0].students.map((s) => `${s.first} ${s.last} ${s.form || ""}`.trim()));
  assert(roster.join(", ") === "Maria Garcia 11, David Chen 10", "added with forms: " + roster.join(", "));

  // 2. Pasting the same people again: marked as already in class, nothing to add.
  await page.fill("#c-paste", "Garcia, Maria\nChen, David");
  await page.waitForSelector(".import-preview tr.dup");
  assert((await page.$$(".import-preview tr.dup")).length === 2 && (await page.$eval("#imp-add", (b) => b.disabled)), "duplicates are unchecked and flagged 'already in class'");
  await page.click("#imp-clear");

  // 3. Screenshot via the file picker (bundled OCR, first load).
  const t0 = Date.now();
  await page.setInputFiles("#c-img", { name: "roster.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => /Found \d+ name|No names|Couldn't/.test(document.querySelector("#c-status").textContent), null, { timeout: 120000 });
  console.log(`     OCR took ${((Date.now() - t0) / 1000).toFixed(1)} s (including first-time engine load)`);
  console.log("     status: " + (await page.textContent("#c-status")));
  const rows = await page.$$eval(".import-preview tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("input[data-f]")].map((i) => i.value)));
  console.log("     read: " + rows.map((r) => r.join("|")).join(" ; "));
  const want = ROSTER.map(([l, f, g]) => [f, l, g]);
  const exact = rows.filter((r, i) => want[i] && r.join("|") === want[i].join("|")).length;
  console.log("     raw: " + JSON.stringify(await page.inputValue("#c-paste")));
  assert(rows.length === ROSTER.length, `all ${ROSTER.length} students found`);
  assert(exact === ROSTER.length, `${exact}/${ROSTER.length} rows exactly right (first | last | form); "Advanced"/"AP" dropped`);
  assert(/text recognition can misread/.test(await page.textContent("#c-preview")), "preview asks the teacher to check the names");
  if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], "roster-import.png"), fullPage: true });

  // Swap, edit one, uncheck one, add.
  await page.click("#imp-swap");
  assert((await page.$eval(".import-preview tbody tr input[data-f='first']", (i) => i.value)) === "Abbott", "Swap first ↔ last works");
  await page.click("#imp-swap");
  await page.fill(".import-preview tbody tr:nth-child(2) input[data-f='first']", "Linnea");
  await page.uncheck(".import-preview tbody tr:nth-child(3) input[data-inc]");
  assert(/Add 8 students/.test(await page.textContent("#imp-add")), "button counts checked rows");
  await page.click("#imp-add");
  await page.waitForFunction(() => MGStore.db.classes[0].students.length === 10);
  roster = await page.evaluate(() => MGStore.db.classes[0].students.map((s) => `${s.first} ${s.last}`));
  assert(roster.includes("Linnea Baker") && !roster.includes("Mia Castillo"), "edits and unchecked rows respected");

  // 4. Screenshot pasted with Ctrl/Cmd+V (second run: engine already loaded).
  const t1 = Date.now();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, png.toString("base64"));
  await page.waitForFunction(() => /Found \d+ name/.test(document.querySelector("#c-status").textContent), null, { timeout: 60000 });
  console.log(`     pasted screenshot read in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  const dups = await page.$$eval(".import-preview tr.dup", (trs) => trs.length);
  assert(dups === 7, `pasted screenshot works; the 7 students already added are flagged as duplicates (${dups})`);

  // Form shows in the roster table and survives a reload.
  await page.reload();
  await page.waitForSelector("tr[data-sid] .s-form");
  const forms = await page.$$eval("tr[data-sid] .s-form", (is) => is.map((i) => i.value).filter(Boolean).length);
  assert(forms === 10, "Form column filled for all 10 students after reload");

  assert(errors.length === 0, "no page errors " + errors.join(" | "));
  await browser.close();
  srv.close();
  console.log("\nRoster import E2E passed");
})().catch((e) => { console.error(e); process.exit(1); });
