// Runs the synthetic scanner tests in headless Chromium.
//   node tests/run-scanner-tests.js [name-filter]
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e));
  await page.goto("file://" + path.join(__dirname, "scanner-test.html"));
  const results = await page.evaluate((f) => window.runTests(f), process.argv[2] || "");
  let failed = 0;
  for (const r of results) {
    const ok = r.expectFail ? r.status !== "ok" : r.status === "ok" && r.codeOk && r.errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.name}  [${r.status}${r.ms != null ? `, ${r.ms} ms` : ""}${r.n ? `, ${r.n} q, ${r.flags} flagged` : ""}]`);
    if (r.status !== "ok") console.log(`      markers found: ${r.markers}`);
    else {
      if (!r.codeOk) console.log("      wrong sheet code");
      for (const e of r.errors.slice(0, 8)) console.log("      " + e);
      if (r.errors.length) console.log("      stats", JSON.stringify(r.stats));
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} failing` : "\nall passing");
  process.exit(failed ? 1 : 0);
})();
