// Live camera scanning, end to end, using Chromium's fake camera fed with a
// video of a filled-in sheet (needs ffmpeg).
//   node tests/camera-test.js [screenshot-dir]
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
function serve(port) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { resp.writeHead(404); return resp.end(); }
      resp.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(resp);
    }).listen(port || 0, () => res(srv));
  });
}
function assert(c, m) { if (!c) throw new Error("ASSERT: " + m); console.log("  ok  " + m); }

(async () => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch (e) { console.log("ffmpeg not installed: skipping"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-cam-"));
  const profile = path.join(tmp, "profile");
  const srv = await serve();
  const port = srv.address().port; // same origin in both phases, so saved data carries over
  const base = `http://localhost:${port}`;

  // Phase 1: create a class + test, and a webcam-like photo of a filled sheet.
  let ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 900 } });
  let page = await ctx.newPage();
  await page.goto(base + "/index.html");
  const made = await page.evaluate(() => {
    const St = MGStore, L = MGLayout;
    const c = St.addClass("Period 1");
    c.students.push({ id: St.uid(), first: "Maria", last: "Garcia" });
    const t = St.addTest();
    t.title = "Camera quiz";
    t.classIds = [c.id];
    t.sections = [{ id: St.uid(), count: 5, type: "TF", points: 1, key: ["T", "F", "T", "T", "F"] }, { id: St.uid(), count: 15, type: "AE", points: 1, key: "ABCDEABCDEABCDE".split("") }];
    const sh = St.sheetFor(t, c.students[0].id, c.id);
    St.save();
    return { test: t, svg: L.renderSheetSVG(t, { testCode: t.code, sheetCode: sh.code, studentName: "Maria Garcia", className: c.name }) };
  });
  const answers = ["T", "F", "F", "T", "F", ..."ABCDEABCDEABCDA".split("")]; // 2 wrong → 18/20
  const helper = await ctx.newPage();
  await helper.goto(base + "/tests/scanner-test.html");
  const url = await helper.evaluate(([svg, t, a]) => window.makePhoto(svg, t, a, { seed: 3, outW: 1280, outH: 720, fill: 0.62, tilt: 4, noise: 6, blur: 0.8, light: 0.25 }), [made.svg, made.test, answers]);
  await ctx.close();
  const jpg = path.join(tmp, "frame.jpg");
  fs.writeFileSync(jpg, Buffer.from(url.split(",")[1], "base64"));
  if (SHOTS) fs.copyFileSync(jpg, path.join(SHOTS, "camera-frame.jpg"));
  const y4m = path.join(tmp, "cam.y4m");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-loop", "1", "-i", jpg, "-t", "4", "-r", "15", "-pix_fmt", "yuv420p", y4m]);

  // Phase 2: same profile, with the video as the camera.
  ctx = await chromium.launchPersistentContext(profile, {
    viewport: { width: 1280, height: 900 },
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
    permissions: ["camera"],
  });
  page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  // Scan from inside the test (its "3 · Scan" tab).
  await page.goto(base + `/#/test/${made.test.id}/build`);
  await page.waitForSelector(".subnav");
  await page.click(".subnav a:has-text('3 · Scan')");
  await page.waitForSelector("#cam-start");
  assert((await page.textContent(".subnav a.active")).trim() === "3 · Scan" && (await page.textContent("#th-title")).trim() === "Camera quiz", "3 · Scan stays inside the test (tabs and title still shown)");
  assert(/0 of 1/.test(await page.textContent("#scan-progress")), "progress line: 0 of 1 students scanned");
  await page.click("#cam-start");
  const t0 = Date.now();
  try {
    await page.waitForFunction(() => /✓/.test(document.querySelector("#scan-status").textContent), null, { timeout: 30000 });
  } catch (e) {
    console.log("  status was: " + (await page.textContent("#scan-status")));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "camera-fail.png") });
    throw new Error("ASSERT: camera never recorded the sheet");
  }
  const status = (await page.textContent("#scan-status")).replace(/\s+/g, " ").trim();
  console.log(`     recorded after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${status}`);
  assert(/Maria Garcia/.test(status) && /18\/20/.test(status), "live camera records the sheet: Maria Garcia, 18/20");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "camera-ok.png") });
  const n = await page.evaluate(() => MGStore.db.scans.length);
  assert(n === 1, "one scan saved (not re-recorded while the sheet stays in view)");
  assert(/1 of 1/.test(await page.textContent("#scan-progress")), "progress line updates: 1 of 1 students scanned");
  await page.click("text=See results →");
  await page.waitForSelector(".stats");
  assert(page.url().endsWith(`/#/test/${made.test.id}/results`) && (await page.textContent(".subnav a.active")).trim() === "4 · Results", "See results → goes straight to this test's results");
  assert(errors.length === 0, "no page errors " + errors.join(" | "));
  await ctx.close();
  srv.close();
  console.log("\nCamera test passed");
})().catch((e) => { console.error(e); process.exit(1); });
