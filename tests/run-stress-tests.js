// Randomized scanner stress test: many synthetic photos with varied marking
// (solid, light, partial, off-centre, pen, scribble, erasures, stray marks) and
// photo conditions (webcam to phone resolution, any rotation, tilt, perspective,
// curl, blur, shake, shadow, glare, JPEG). Fails if any misread would go into a
// grade unflagged, or if too many questions are misread overall.
//
//   node tests/run-stress-tests.js [count] [firstSeed]
const path = require("path");
const { chromium } = require("playwright");

const N = +process.argv[2] || 60, START = +process.argv[3] || 1;
const MAX_WRONG = 0.01; // misreads overall (flagged ones the teacher is asked to check)
const MAX_UNREAD = 0.05; // sheets not found at all (rescanned by the teacher)

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file://" + path.resolve(__dirname, "scanner-test.html"));
  const all = [];
  for (let i = 0; i < N; i += 10) {
    all.push(...(await page.evaluate(([n, s]) => window.runStress(n, s), [Math.min(10, N - i), START + i])));
  }
  await browser.close();

  let q = 0, wrong = 0, silent = 0, unread = 0;
  for (const r of all) {
    if (r.status !== "ok") { unread++; console.log(`seed ${r.params.seed}: not read (${r.status})`); continue; }
    q += r.n; wrong += r.errs.length;
    const s = r.errs.filter((e) => e.silent);
    silent += s.length;
    for (const e of s) console.log(`seed ${r.params.seed}: SILENT Q${e.q} want "${e.want}" got "${e.got}" ${JSON.stringify(r.params)}`);
  }
  const pct = (a, b) => ((100 * a) / Math.max(b, 1)).toFixed(2) + "%";
  console.log(`${all.length} sheets, ${unread} not read (${pct(unread, all.length)}); ${q} questions, ` +
    `${wrong} misread (${pct(wrong, q)}), ${silent} of them not flagged`);
  const fail = errors.length || silent > 0 || wrong / Math.max(q, 1) > MAX_WRONG || unread / all.length > MAX_UNREAD;
  if (errors.length) console.log("page errors:", errors);
  console.log(fail ? "\nFAILED" : "\nall passing");
  process.exit(fail ? 1 : 0);
})();
