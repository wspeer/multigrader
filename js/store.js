/* MultiGrader — data storage.
 *
 * Classes, tests and scan results live in localStorage as one JSON document.
 * Straightened sheet images (for reviewing a scan) live in IndexedDB, since
 * they are too big for localStorage. Nothing ever leaves this browser except
 * through an explicit Export.
 */
(function (root) {
  "use strict";
  const L = root.MGLayout;
  const KEY = "multigrader.db.v1";

  function empty() {
    return { v: 1, classes: [], tests: [], scans: [] };
  }

  let db = empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) db = Object.assign(empty(), JSON.parse(raw));
  } catch (e) {
    console.warn("Could not load saved data", e);
  }

  const listeners = [];
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      alert("Could not save — browser storage may be full. Export a backup and delete old tests.\n\n" + e.message);
    }
    listeners.forEach((f) => f());
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);

  /* ---------------- classes & students ---------------- */

  function getClass(id) { return db.classes.find((c) => c.id === id); }

  function studentName(s) { return s ? `${s.first} ${s.last}`.trim() : ""; }
  function sortName(s) { return `${s.last} ${s.first}`.toLowerCase(); }

  function sortedStudents(cls) {
    return (cls ? cls.students : []).slice().sort((a, b) => sortName(a).localeCompare(sortName(b)));
  }

  function findStudent(id) {
    for (const c of db.classes) {
      const s = c.students.find((x) => x.id === id);
      if (s) return { student: s, cls: c };
    }
    return null;
  }

  /* Pasted or recognized roster text → [{ first, last, form }] (see js/roster.js). */
  function parseRoster(text) {
    return root.MGRoster.parse(text);
  }

  function addClass(name) {
    const c = { id: uid(), name: name || "New class", students: [], updatedAt: now() };
    db.classes.push(c);
    save();
    return c;
  }

  /* ---------------- tests ---------------- */

  function getTest(id) { return db.tests.find((t) => t.id === id); }
  function testByCode(code) { return db.tests.find((t) => t.code === code) || null; }

  function newTestCode() {
    let c;
    do { c = 1 + Math.floor(Math.random() * 65534); } while (db.tests.some((t) => t.code === c));
    return c;
  }

  function addTest() {
    const t = {
      id: uid(),
      code: newTestCode(),
      title: "Untitled test",
      date: today(),
      classIds: db.classes.length === 1 ? [db.classes[0].id] : [],
      sections: [{ id: uid(), count: 10, type: "AE", points: 1, key: [] }],
      sheets: [],
      nextSheet: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    db.tests.unshift(t);
    save();
    return t;
  }

  function duplicateTest(src) {
    const t = JSON.parse(JSON.stringify(src));
    Object.assign(t, { id: uid(), code: newTestCode(), title: src.title + " (copy)", sheets: [], nextSheet: 1, createdAt: now(), updatedAt: now() });
    const orders = t.versionOrders || {};
    t.versionOrders = {};
    t.sections.forEach((s) => {
      const old = s.id;
      s.id = uid();
      for (const v of Object.keys(orders)) if (orders[v][old]) (t.versionOrders[v] = t.versionOrders[v] || {})[s.id] = orders[v][old];
    });
    db.tests.unshift(t);
    save();
    return t;
  }

  function deleteTest(t) {
    const ids = db.scans.filter((s) => s.testId === t.id).map((s) => s.id);
    db.scans = db.scans.filter((s) => s.testId !== t.id);
    db.tests = db.tests.filter((x) => x.id !== t.id);
    ids.forEach(deleteImage);
    save();
  }

  /* The answer key lives on each section (so inserting a section never shifts
   * later answers). flatKey() gives one accepted-letters string per question,
   * dropping letters that are no longer valid choices. */
  /* Key strings: "B" one answer; "AC" either A or C earns credit;
   * "&AC" both A and C must be bubbled (and nothing else), no partial credit. */
  function keyInfo(k) {
    k = k || "";
    const all = k[0] === "&";
    const letters = all ? k.slice(1) : k;
    return { letters, all: all && letters.length > 1 };
  }
  function makeKey(letters, all) {
    const l = [...new Set(letters.split(""))].sort().join("");
    return all && l.length > 1 ? "&" + l : l;
  }
  function keyCorrect(k, resp) {
    const { letters, all } = keyInfo(k);
    if (!letters) return null;
    if (all) return resp.split("").sort().join("") === letters;
    return resp.length === 1 && letters.includes(resp);
  }
  /* Human-readable: "B", "A or C", "A + C". */
  function keyText(k) {
    const { letters, all } = keyInfo(k);
    return letters.split("").join(all ? " + " : " or ");
  }

  function flatKey(t) {
    const out = [];
    for (const s of t.sections) {
      const ch = L.sectionChoices(s);
      const n = Math.max(0, parseInt(s.count, 10) || 0);
      for (let i = 0; i < n; i++) {
        const { letters, all } = keyInfo(s.key && s.key[i]);
        out.push(makeKey(letters.split("").filter((c) => ch.includes(c)).join(""), all));
      }
    }
    return out;
  }

  /* ---------------- versions ---------------- */

  /* Order of one section on a version: list of Version-A positions (0-based,
   * within the section). Invalid or missing entries are repaired. */
  function sectionOrder(t, label, s) {
    const n = Math.max(0, parseInt(s.count, 10) || 0);
    const base = Array.from({ length: n }, (_, i) => i);
    if (label === "A") return base;
    const saved = (t.versionOrders && t.versionOrders[label] && t.versionOrders[label][s.id]) || [];
    const seen = new Set();
    const out = [];
    for (const x of saved) if (Number.isInteger(x) && x >= 0 && x < n && !seen.has(x)) { seen.add(x); out.push(x); }
    for (const x of base) if (!seen.has(x)) out.push(x);
    return out;
  }

  function setSectionOrder(t, label, s, order) {
    if (t.versionLocks && t.versionLocks[label]) return; // locked versions never change
    t.versionOrders = t.versionOrders || {};
    t.versionOrders[label] = t.versionOrders[label] || {};
    t.versionOrders[label][s.id] = order;
  }

  /* perm[sheet position] = Version-A question index, for the whole test. */
  function versionMap(t, label) {
    const perm = [];
    let start = 0;
    for (const s of t.sections) {
      const o = sectionOrder(t, label, s);
      for (const x of o) perm.push(start + x);
      start += o.length;
    }
    return perm;
  }

  /* The key in a version's own question order. */
  function versionKey(t, label) {
    const fk = flatKey(t);
    return versionMap(t, label).map((m) => fk[m]);
  }

  function questionPoints(t) {
    const out = [];
    for (const s of t.sections) {
      const n = Math.max(0, parseInt(s.count, 10) || 0);
      const p = parseFloat(s.points);
      for (let i = 0; i < n; i++) out.push(isFinite(p) && p >= 0 ? p : 1);
    }
    return out;
  }

  function isPrinted(t) { return t.sheets && t.sheets.length > 0; }

  /* Changing the bubble format invalidates printed sheets: give the test a new
   * code so old sheets are rejected instead of being mis-read. */
  function resetFormat(t) {
    t.code = newTestCode();
    t.sheets = [];
    t.nextSheet = 1;
    t.updatedAt = now();
    save();
  }

  /* The sheet code for a student on a test (created on first print). */
  function sheetFor(t, studentId, classId) {
    let s = t.sheets.find((x) => x.studentId === studentId);
    if (!s) {
      s = { code: t.nextSheet++, studentId, classId, printedAt: now() };
      t.sheets.push(s);
    }
    return s;
  }

  function newBlankSheet(t, classId) {
    const s = { code: t.nextSheet++, studentId: null, classId: classId || null, printedAt: now() };
    t.sheets.push(s);
    return s;
  }

  function sheetInfo(t, code) { return t.sheets.find((s) => s.code === code) || null; }

  /* ---------------- scans & grading ---------------- */

  function scansFor(t) { return db.scans.filter((s) => s.testId === t.id); }

  function effectiveResponse(scan, i) {
    const o = scan.overrides && scan.overrides[i];
    return o != null ? o : scan.responses[i] || "";
  }

  /* Grade a scan as a given version. items[] is in Version-A order (for
   * stats); byPos[] is in the order printed on this student's version. */
  function gradeAs(t, scan, label) {
    const pts = questionPoints(t);
    const fk = flatKey(t);
    const perm = versionMap(t, label);
    let score = 0, possible = 0;
    const items = new Array(fk.length);
    const byPos = perm.map((m, pos) => {
      const resp = effectiveResponse(scan, pos);
      const key = fk[m];
      const correct = keyCorrect(key, resp);
      const it = { pos, q: m, resp, key, correct, points: correct ? pts[m] : 0 };
      if (correct !== null) possible += pts[m];
      if (correct) score += pts[m];
      items[m] = it;
      return it;
    });
    return { score, possible, pct: possible ? (100 * score) / possible : 0, items, byPos };
  }

  /* Which version a scan is: the bubbled one (or the teacher's override);
   * if it's blank or unclear, the version whose key fits best (flagged). */
  function scanVersion(t, scan) {
    const labels = L.versionLabels(t);
    if (labels.length < 2) return { label: "A", inferred: false };
    const v = scan.versionOverride != null ? scan.versionOverride : scan.version || "";
    if (v.length === 1 && labels.includes(v)) return { label: v, inferred: false, read: scan.version };
    let best = labels[0], bestScore = -1;
    for (const l of labels) {
      const sc = gradeAs(t, scan, l).score;
      if (sc > bestScore) { best = l; bestScore = sc; }
    }
    return { label: best, inferred: true, read: scan.version || "" };
  }

  function grade(t, scan) {
    const v = scanVersion(t, scan);
    const g = gradeAs(t, scan, v.label);
    g.version = v.label;
    g.versionInferred = v.inferred;
    return g;
  }

  /* Flag to show for a sheet position, hiding "two bubbles" when the key
   * actually requires several answers, and anything the teacher corrected or
   * confirmed as read. */
  function shownFlag(scan, g, pos) {
    if (scan.overrides && scan.overrides[pos] != null) return null;
    if (scan.confirmed && scan.confirmed[pos]) return null;
    const f = scan.flags[pos];
    if (f === "multiple" && keyInfo(g.byPos[pos] && g.byPos[pos].key).all) return null;
    return f || null;
  }
  function flagCount(scan, g) {
    let n = 0;
    for (let i = 0; i < scan.flags.length; i++) if (shownFlag(scan, g, i)) n++;
    if (g.versionInferred) n++;
    return n;
  }

  /* Store a scanner result. Re-scanning the same sheet replaces the old scan. */
  function saveScan(t, result) {
    const sheet = sheetInfo(t, result.sheetCode);
    let scan = db.scans.find((s) => s.testId === t.id && s.sheetCode === result.sheetCode);
    const replaced = !!scan;
    if (!scan) {
      scan = { id: uid(), testId: t.id, sheetCode: result.sheetCode, studentId: sheet ? sheet.studentId : null };
      db.scans.push(scan);
    }
    Object.assign(scan, {
      responses: result.responses,
      flags: result.flags,
      darkness: result.darkness,
      offsets: result.offsets,
      version: result.version,
      versionFlag: result.versionFlag,
      versionOffset: result.versionOffset,
      versionOverride: null,
      overrides: {},
      confirmed: {}, // flagged questions the teacher checked and accepted as read
      scannedAt: now(),
      updatedAt: now(),
    });
    if (sheet && sheet.studentId && !scan.studentId) scan.studentId = sheet.studentId;
    save();
    return { scan, replaced };
  }

  function deleteScan(scan) {
    db.scans = db.scans.filter((s) => s.id !== scan.id);
    deleteImage(scan.id);
    save();
  }

  /* ---------------- images (IndexedDB) ---------------- */

  let idbP = null;
  function idb() {
    if (!idbP) {
      idbP = new Promise((res, rej) => {
        if (!root.indexedDB) return rej(new Error("no IndexedDB"));
        const r = indexedDB.open("multigrader", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("images");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return idbP;
  }
  async function putImage(id, blob) {
    try {
      const d = await idb();
      await new Promise((res, rej) => { const tx = d.transaction("images", "readwrite"); tx.objectStore("images").put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn("image not saved", e); }
  }
  async function getImage(id) {
    try {
      const d = await idb();
      return await new Promise((res, rej) => { const r = d.transaction("images").objectStore("images").get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
    } catch (e) { return null; }
  }
  async function deleteImage(id) {
    try {
      const d = await idb();
      d.transaction("images", "readwrite").objectStore("images").delete(id);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- backup ---------------- */

  function exportJSON() {
    return JSON.stringify({ app: "multigrader", exportedAt: now(), ...db }, null, 1);
  }

  const newer = (a, b) => (a.updatedAt || "") >= (b.updatedAt || "");

  /* Merge a backup into this device. Newer edits win; scans of the same sheet keep the latest. */
  function importJSON(text) {
    const inc = JSON.parse(text);
    if (!inc || !Array.isArray(inc.tests) || !Array.isArray(inc.classes)) throw new Error("This doesn't look like a MultiGrader backup.");
    const counts = { classes: 0, tests: 0, scans: 0 };
    for (const c of inc.classes) {
      const i = db.classes.findIndex((x) => x.id === c.id);
      if (i < 0) { db.classes.push(c); counts.classes++; } else if (newer(c, db.classes[i])) { db.classes[i] = c; counts.classes++; }
    }
    for (const t of inc.tests) {
      const i = db.tests.findIndex((x) => x.id === t.id);
      if (i < 0) { db.tests.push(t); counts.tests++; continue; }
      const cur = db.tests[i];
      const win = newer(t, cur) ? t : cur, lose = win === t ? cur : t;
      // Keep every printed sheet either device knows about.
      if (win.code === lose.code) {
        for (const s of lose.sheets || []) if (!win.sheets.some((x) => x.code === s.code)) win.sheets.push(s);
        win.nextSheet = Math.max(win.nextSheet || 1, lose.nextSheet || 1);
      }
      db.tests[i] = win;
      if (win === t) counts.tests++;
    }
    for (const s of inc.scans || []) {
      const i = db.scans.findIndex((x) => x.id === s.id || (x.testId === s.testId && x.sheetCode === s.sheetCode));
      if (i < 0) { db.scans.push(s); counts.scans++; } else if (newer(s, db.scans[i])) { db.scans[i] = s; counts.scans++; }
    }
    save();
    return counts;
  }

  function eraseAll() {
    db = empty();
    save();
    idb().then((d) => d.transaction("images", "readwrite").objectStore("images").clear()).catch(() => {});
  }

  root.MGStore = {
    get db() { return db; },
    save, uid, now, today, onChange: (f) => listeners.push(f),
    getClass, studentName, sortedStudents, findStudent, parseRoster, addClass,
    getTest, testByCode, addTest, duplicateTest, deleteTest, flatKey, questionPoints,
    keyInfo, makeKey, keyCorrect, keyText, sectionOrder, setSectionOrder, versionMap, versionKey,
    gradeAs, scanVersion, shownFlag, flagCount,
    isPrinted, resetFormat, sheetFor, newBlankSheet, sheetInfo,
    scansFor, effectiveResponse, grade, saveScan, deleteScan,
    putImage, getImage, exportJSON, importJSON, eraseAll,
  };
})(window);
