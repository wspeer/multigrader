// Print layout test: N answer sheets must print as exactly N pages, whatever
// page margins the browser/printer forces, with the sheet fully visible.
//   node tests/print-test.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");

function pdfPages(file) {
  // Count "/Type /Page" objects (not /Pages) — no external tools needed.
  const s = fs.readFileSync(file, "latin1");
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.join(ROOT, "index.html"));
  // The app empties the print area after each print, so refill it every time.
  const fill = () => page.evaluate(() => {
    const t = { title: "Print test", sections: [{ count: 30, type: "AE" }], versionCount: 2 };
    const svgs = [1, 2, 3].map((i) => MGLayout.renderSheetSVG(t, { testCode: 1234, sheetCode: i, studentName: "Student " + i, className: "Period " + i, date: "Nov 23, 2026" }));
    document.getElementById("print-root").innerHTML = svgs.map((s) => `<div class="print-page">${s}</div>`).join("");
  });
  await page.emulateMedia({ media: "print" });
  // Each case forces the page size/margins a browser or printer might impose,
  // overriding the app's own "@page { margin: 0 }".
  const cases = [
    { name: "no margins (as the app asks)", page: "" },
    { name: "Letter, 0.25in margins", page: "size: letter; margin: 0.25in;" },
    { name: "Letter, 0.4in margins (Chrome 'Default')", page: "size: letter; margin: 0.4in;" },
    { name: "Letter, 0.5in top/bottom only", page: "size: letter; margin: 0.5in 0;" },
    { name: "Letter, 1in margins", page: "size: letter; margin: 1in;" },
    { name: "A4, 0.4in margins", page: "size: A4; margin: 0.4in;" },
  ];
  let fails = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-print-"));
  let hasPdftoppm = true;
  try { execFileSync("pdftoppm", ["-v"], { stdio: "ignore" }); } catch (e) { hasPdftoppm = false; console.log("(pdftoppm not found: skipping the scan-the-printout check)"); }
  const scanPage = await browser.newPage();
  await scanPage.goto("file://" + path.join(ROOT, "index.html"));
  for (const c of cases) {
    const file = path.join(tmp, "out.pdf");
    await fill();
    await page.evaluate((css) => {
      let st = document.getElementById("force-page");
      if (!st) { st = document.createElement("style"); st.id = "force-page"; document.head.appendChild(st); }
      st.textContent = css ? `@media print { @page { ${css} } }` : "";
    }, c.page);
    await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
    const n = pdfPages(file);
    let ok = n === 3, scanNote = "";
    // Render page 2 and scan it: the scanner only succeeds if all four corner
    // squares and the code strip made it onto the page unclipped.
    if (hasPdftoppm) {
      execFileSync("pdftoppm", ["-r", "100", "-f", "2", "-l", "2", "-png", file, path.join(tmp, "pg")]);
      const png = fs.readdirSync(tmp).find((f) => f.startsWith("pg") && f.endsWith(".png"));
      const dataUrl = "data:image/png;base64," + fs.readFileSync(path.join(tmp, png)).toString("base64");
      fs.unlinkSync(path.join(tmp, png));
      const res = await scanPage.evaluate(async (u) => {
        const img = new Image(); img.src = u; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
        const r = MGScanner.scan(ctx.getImageData(0, 0, c.width, c.height), {});
        return { status: r.status, sheet: r.sheetCode };
      }, dataUrl);
      const scanned = res.sheet === 2 && (res.status === "unknown-test" || res.status === "ok");
      if (!scanned) ok = false;
      scanNote = scanned ? ", page 2 scans as sheet 2" : `, page 2 did NOT scan (${res.status})`;
    }
    if (!ok) fails++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: ${n} pages for 3 sheets${scanNote}`);
  }
  // The whole sheet (all four corner squares) must be visible, not clipped.
  await fill();
  const box = await page.evaluate(() => {
    const p = document.querySelector(".print-page"), s = p.querySelector("svg");
    const a = p.getBoundingClientRect(), b = s.getBoundingClientRect();
    return { inside: b.left >= a.left - 0.5 && b.right <= a.right + 0.5 && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5, ratio: b.height / b.width };
  });
  const okBox = box.inside && Math.abs(box.ratio - 279.4 / 215.9) < 0.01;
  if (!okBox) fails++;
  console.log(`${okBox ? "PASS" : "FAIL"}  sheet fully inside its page box, proportions kept (${box.ratio.toFixed(3)})`);
  await browser.close();
  console.log(fails ? `\n${fails} failing` : "\nall passing");
  process.exit(fails ? 1 : 0);
})();
