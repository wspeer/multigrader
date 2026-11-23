/* MultiGrader — user interface. */
(function () {
  "use strict";
  const L = MGLayout, S = MGScanner, St = MGStore;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = $("#main");
  const uiState = {}; // per-test view state that shouldn't be saved
  const ui = (t) => uiState[t.id] || (uiState[t.id] = {});

  /* ---------------- small helpers ---------------- */

  function fmtDate(d) {
    if (!d) return "";
    const [y, m, dd] = d.split("-").map(Number);
    if (!y || !m || !dd) return d;
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const pct = (x) => (isFinite(x) ? Math.round(x) + "%" : "–");
  const fmtPts = (x) => (Math.round(x * 100) / 100).toString();

  function classNames(t) {
    return t.classIds.map(St.getClass).filter(Boolean).map((c) => c.name).join(", ");
  }
  function testRoster(t) {
    const out = [];
    for (const cid of t.classIds) {
      const c = St.getClass(cid);
      if (c) for (const s of St.sortedStudents(c)) out.push({ student: s, cls: c });
    }
    return out;
  }
  function presetName(s) {
    if (s.type === "custom") return "Custom (" + L.sectionChoices(s).join("") + ")";
    const p = L.PRESETS.find((x) => x.id === s.type);
    return p ? p.name : s.type;
  }
  function sectionRanges(t) {
    let start = 0;
    return t.sections.map((s) => {
      const n = Math.max(0, parseInt(s.count, 10) || 0);
      const r = { start, end: start + n - 1, n };
      start += n;
      return r;
    });
  }

  let toastTimer;
  function toast(msg, kind) {
    const el = $("#toast");
    el.className = "toast " + (kind || "");
    el.innerHTML = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
  }

  let saveTimer;
  function saveSoon(t) {
    if (t) t.updatedAt = St.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => St.save(), 300);
  }
  window.addEventListener("beforeunload", () => { clearTimeout(saveTimer); St.save(); });

  /* A readable, plain-ASCII file name from a title ("11.2–11.8" → "11.2-11.8",
   * "José" → "Jose"); some browsers refuse download names with other characters. */
  function safeFileName(title) {
    const s = String(title || "")
      .replace(/[‐-―−]/g, "-")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[\/\\:*?"<>|#%]+/g, " ")
      .replace(/\s+/g, " ").trim();
    return s || "test";
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function grayToBlob(img) {
    const c = document.createElement("canvas");
    c.width = img.w; c.height = img.h;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(img.w, img.h);
    for (let i = 0, j = 0; i < img.g.length; i++, j += 4) { id.data[j] = id.data[j + 1] = id.data[j + 2] = img.g[i]; id.data[j + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    return new Promise((res) => c.toBlob(res, "image/jpeg", 0.8));
  }

  /* ---------------- routing ---------------- */

  function route() {
    stopCamera();
    closeModal();
    clearTimeout(previewTimer);
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const view = parts[0] || "tests";
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (view === "test" ? "tests" : view)));
    window.scrollTo(0, 0);
    if (view === "test") {
      const t = St.getTest(parts[1]);
      if (!t) { location.hash = "#/tests"; return; }
      const sub = parts[2] || "build";
      if (sub === "print") viewPrint(t);
      else if (sub === "results") viewResults(t);
      else viewBuild(t);
    } else if (view === "classes") viewClasses(parts[1]);
    else if (view === "scan") viewScan();
    else if (view === "data") viewData();
    else viewTests();
  }
  window.addEventListener("hashchange", route);

  /* ================================================================
   * TESTS LIST
   * ================================================================ */

  function viewTests() {
    const tests = St.db.tests;
    const noClasses = St.db.classes.length === 0;
    main.innerHTML = `
      <div class="page-head">
        <h1>Tests</h1>
        <button class="btn primary" id="new-test">+ New test</button>
      </div>
      ${tests.length === 0 ? `
        <div class="card hero">
          <h2>Grade multiple-choice tests with your camera</h2>
          <ol class="steps">
            <li><strong>Add a class</strong> and paste in its roster. ${noClasses ? `<a href="#/classes">Add a class →</a>` : "✓"}</li>
            <li><strong>Build a test:</strong> the question format (T/F, A/S/N, A–E…) and answer key. The answer sheet is generated from it automatically.</li>
            <li><strong>Print named sheets</strong>, one for each student, then <strong>scan</strong> them with a phone or webcam.</li>
          </ol>
        </div>` : `
        ${noClasses ? `<div class="notice">Tip: <a href="#/classes">add a class</a> so you can print sheets with student names.</div>` : ""}
        <div class="test-list">${tests.map(testCard).join("")}</div>`}
    `;
    $("#new-test").onclick = () => { const t = St.addTest(); location.hash = `#/test/${t.id}/build`; };
    $$("[data-dup]").forEach((b) => (b.onclick = () => { const t = St.duplicateTest(St.getTest(b.dataset.dup)); toast("Duplicated — edit the copy's format or key."); location.hash = `#/test/${t.id}/build`; }));
    $$("[data-del]").forEach((b) => (b.onclick = () => {
      const t = St.getTest(b.dataset.del);
      const n = St.scansFor(t).length;
      if (confirm(`Delete "${t.title}"${n ? ` and its ${n} scanned sheet${n > 1 ? "s" : ""}` : ""}? This can't be undone.`)) { St.deleteTest(t); viewTests(); }
    }));
  }

  function testCard(t) {
    const nq = L.questionChoices(t).length;
    const scans = St.scansFor(t);
    const roster = testRoster(t).length;
    const keyed = St.flatKey(t).filter(Boolean).length;
    let avg = "";
    if (scans.length) {
      const g = scans.map((s) => St.grade(t, s).pct);
      avg = ` · avg ${pct(g.reduce((a, b) => a + b, 0) / g.length)}`;
    }
    return `
      <div class="card test-card">
        <div class="tc-main">
          <a class="tc-title" href="#/test/${t.id}/build">${esc(t.title)}</a>
          <div class="muted small">${esc(fmtDate(t.date))}${classNames(t) ? " · " + esc(classNames(t)) : ""}</div>
          <div class="tc-meta">
            <span class="pill">${nq} question${nq === 1 ? "" : "s"}</span>
            ${keyed < nq ? `<span class="pill warn">key ${keyed}/${nq}</span>` : `<span class="pill good">key ✓</span>`}
            ${St.isPrinted(t) ? `<span class="pill">printed</span>` : ""}
            <span class="pill">${scans.length}${roster ? "/" + roster : ""} scanned${avg}</span>
          </div>
        </div>
        <div class="tc-actions">
          <a class="btn" href="#/test/${t.id}/build">Edit</a>
          <a class="btn" href="#/test/${t.id}/print">Print</a>
          <a class="btn" href="#/test/${t.id}/results">Results</a>
          <button class="btn ghost small" data-dup="${t.id}" title="Make a copy (e.g. for another version)">Duplicate</button>
          <button class="btn ghost small danger" data-del="${t.id}">Delete</button>
        </div>
      </div>`;
  }

  function testHeader(t, sub) {
    return `
      <div class="test-head">
        <a class="back" href="#/tests">← Tests</a>
        <h1 id="th-title">${esc(t.title)}</h1>
        <nav class="subnav">
          <a href="#/test/${t.id}/build" class="${sub === "build" ? "active" : ""}">1 · Build</a>
          <a href="#/test/${t.id}/print" class="${sub === "print" ? "active" : ""}">2 · Print</a>
          <a href="#/scan" class="">3 · Scan</a>
          <a href="#/test/${t.id}/results" class="${sub === "results" ? "active" : ""}">4 · Results</a>
        </nav>
      </div>`;
  }

  /* ================================================================
   * BUILD (details, format, answer key, live sheet preview)
   * ================================================================ */

  function viewBuild(t) {
    const classes = St.db.classes;
    main.innerHTML = `
      ${testHeader(t, "build")}
      <div class="build-grid">
        <div class="build-main">
          <section class="card">
            <h2>Details</h2>
            <div class="form-row">
              <label class="grow">Title <input id="t-title" value="${esc(t.title)}" /></label>
              <label>Date <input id="t-date" type="date" value="${esc(t.date)}" /></label>
            </div>
            <div class="field">
              <div class="label">Classes taking this test</div>
              ${classes.length ? `<div class="check-row">${classes.map((c) => `
                <label class="check"><input type="checkbox" data-class="${c.id}" ${t.classIds.includes(c.id) ? "checked" : ""}/> ${esc(c.name)} <span class="muted">(${c.students.length})</span></label>`).join("")}</div>`
                : `<p class="muted">No classes yet. <a href="#/classes">Add a class</a> to print named sheets.</p>`}
            </div>
          </section>

          <section class="card">
            <h2>Question format</h2>
            <div id="format"></div>
          </section>

          <section class="card">
            <div class="card-head"><h2>Answer key</h2><span id="key-status" class="muted small"></span></div>
            <p class="muted small">Type answers into a section's box (e.g. <code>TFFTF</code> or <code>CADBE</code>), or click bubbles.
              For more than one letter, shift-click or type: <code>(AC)</code> = <strong>either</strong> A or C earns credit;
              <code>[AC]</code> = <strong>all required</strong> (the student must bubble exactly A and C; no partial credit).
              Click the small tag on a row to switch between the two. You can change the key after scanning; scores update automatically.</p>
            <div id="key-grid"></div>
          </section>

          <section class="card" id="versions-card"></section>
        </div>
        <aside class="build-preview">
          <div class="card sticky">
            <div class="card-head"><h2>Answer sheet</h2><a class="btn small primary" href="#/test/${t.id}/print">Print →</a></div>
            <div id="preview" class="sheet-preview"></div>
            <p id="preview-note" class="muted small"></p>
          </div>
        </aside>
      </div>`;

    $("#t-title").oninput = (e) => { t.title = e.target.value; $("#th-title").textContent = t.title || "Untitled test"; saveSoon(t); updatePreview(t); };
    $("#t-date").onchange = (e) => { t.date = e.target.value; saveSoon(t); updatePreview(t); };
    $$("[data-class]").forEach((cb) => (cb.onchange = () => {
      const id = cb.dataset.class;
      t.classIds = cb.checked ? [...new Set([...t.classIds, id])] : t.classIds.filter((x) => x !== id);
      saveSoon(t); updatePreview(t);
    }));
    renderFormat(t);
    renderKey(t);
    renderVersions(t);
    updatePreview(t);
  }

  function formatLocked(t) { return St.isPrinted(t); }

  function renderFormat(t) {
    const locked = formatLocked(t);
    const ranges = sectionRanges(t);
    const opts = (s) => L.PRESETS.map((p) => `<option value="${p.id}" ${s.type === p.id ? "selected" : ""}>${p.name}</option>`).join("") +
      `<option value="custom" ${s.type === "custom" ? "selected" : ""}>Custom letters…</option>`;
    $("#format").innerHTML = `
      ${locked ? `<div class="notice">Sheets have been printed for this test, so the bubble format is locked (points can still change).
        <button class="btn small" id="unlock">Change format anyway</button></div>` : ""}
      <div class="sections">
        ${t.sections.map((s, i) => `
          <div class="sec-row" data-i="${i}">
            <span class="sec-range">${ranges[i].n ? `Q${ranges[i].start + 1}${ranges[i].n > 1 ? "–" + (ranges[i].end + 1) : ""}` : "—"}</span>
            <label>Questions <input class="sec-count" type="number" min="1" max="${L.MAX_ROWS * 4}" value="${esc(s.count)}" ${locked ? "disabled" : ""}/></label>
            <label>Type <select class="sec-type" ${locked ? "disabled" : ""}>${opts(s)}</select></label>
            <label class="sec-custom-wrap ${s.type === "custom" ? "" : "hidden"}">Letters <input class="sec-custom" maxlength="6" placeholder="e.g. ABCD" value="${esc(s.custom || "")}" ${locked ? "disabled" : ""}/></label>
            <label>Points each <input class="sec-points" type="number" min="0" step="0.5" value="${esc(s.points == null ? 1 : s.points)}"/></label>
            ${locked ? "" : `<span class="sec-btns">
              <button class="icon-btn" data-up title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="icon-btn" data-down title="Move down" ${i === t.sections.length - 1 ? "disabled" : ""}>↓</button>
              <button class="icon-btn danger" data-rm title="Remove section" ${t.sections.length === 1 ? "disabled" : ""}>✕</button></span>`}
          </div>`).join("")}
      </div>
      ${locked ? "" : `<div class="add-row">
        <span class="muted small">Add section:</span>
        ${[["TF", "T/F"], ["ASN", "A/S/N"], ["AD", "A–D"], ["AE", "A–E"], ["custom", "Custom"]].map(([id, n]) => `<button class="btn small" data-add="${id}">+ ${n}</button>`).join("")}
      </div>`}
      <p id="format-summary" class="muted small"></p>`;

    const fmtChanged = () => { saveSoon(t); updateRanges(t); renderKey(t); renderVersions(t); updatePreview(t); };
    $$(".sec-row").forEach((row) => {
      const s = t.sections[+row.dataset.i];
      // Apply the count while typing (debounced), so leaving the field doesn't
      // redraw the key grid under the user's next click.
      let countTimer;
      const applyCount = (raw, fix) => {
        const v = parseInt(raw, 10);
        if (!fix && !(v >= 1)) return;
        const n = Math.max(1, Math.min(L.MAX_ROWS * 4, v || 1));
        if (fix) $(".sec-count", row).value = n;
        if (n === +s.count) return;
        s.count = n;
        fmtChanged();
      };
      $(".sec-count", row).oninput = (e) => { clearTimeout(countTimer); countTimer = setTimeout(() => applyCount(e.target.value, false), 350); };
      $(".sec-count", row).onchange = (e) => { clearTimeout(countTimer); applyCount(e.target.value, true); };
      $(".sec-type", row).onchange = (e) => { s.type = e.target.value; $(".sec-custom-wrap", row).classList.toggle("hidden", s.type !== "custom"); if (s.type === "custom" && !s.custom) s.custom = "ABCD"; $(".sec-custom", row).value = s.custom || ""; fmtChanged(); };
      $(".sec-custom", row).oninput = (e) => { s.custom = e.target.value.toUpperCase(); fmtChanged(); };
      $(".sec-points", row).oninput = (e) => { s.points = e.target.value === "" ? 1 : parseFloat(e.target.value); saveSoon(t); updateRanges(t); renderKeyStatus(t); };
      const mv = (d) => { const i = +row.dataset.i; const [x] = t.sections.splice(i, 1); t.sections.splice(i + d, 0, x); fmtChanged(); renderFormat(t); };
      const up = $("[data-up]", row), dn = $("[data-down]", row), rm = $("[data-rm]", row);
      if (up) up.onclick = () => mv(-1);
      if (dn) dn.onclick = () => mv(1);
      if (rm) rm.onclick = () => { t.sections.splice(+row.dataset.i, 1); fmtChanged(); renderFormat(t); };
    });
    $$("[data-add]").forEach((b) => (b.onclick = () => {
      t.sections.push({ id: St.uid(), count: 5, type: b.dataset.add, custom: b.dataset.add === "custom" ? "ABCD" : undefined, points: 1, key: [] });
      fmtChanged(); renderFormat(t);
    }));
    const un = $("#unlock");
    if (un) un.onclick = () => {
      const n = St.scansFor(t).length;
      if (!confirm(`Sheets you've already printed for this test will no longer scan once the format changes — you'll need to reprint them.${n ? `\n\nThe ${n} sheet(s) already scanned are kept, but their answers may no longer line up with the new questions.` : ""}\n\nContinue?`)) return;
      St.resetFormat(t);
      renderFormat(t); renderVersions(t); updatePreview(t);
    };
    updateRanges(t);
  }

  function updateRanges(t) {
    const ranges = sectionRanges(t);
    $$(".sec-row").forEach((row, i) => {
      const r = ranges[i];
      if (r) $(".sec-range", row).textContent = r.n ? `Q${r.start + 1}${r.n > 1 ? "–" + (r.end + 1) : ""}` : "—";
    });
    const nq = L.questionChoices(t).length;
    const pts = St.questionPoints(t).reduce((a, b) => a + b, 0);
    const lay = L.computeLayout(t);
    const el = $("#format-summary");
    if (el) el.innerHTML = lay.error ? `<span class="bad-txt">${esc(lay.error)}</span>` : `${nq} questions · ${fmtPts(pts)} points · ${lay.columns.length} column${lay.columns.length === 1 ? "" : "s"} on the sheet`;
  }

  /* --- answer key --- */

  function keyToQuick(key, n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      const { letters, all } = St.keyInfo(key[i]);
      out += letters.length > 1 ? (all ? `[${letters}]` : `(${letters})`) : letters || "-";
      if (i % 5 === 4 && i < n - 1) out += " ";
    }
    return out.replace(/[\s-]+$/, "");
  }

  function quickToKey(text, choices, n) {
    const out = [];
    const src = text.toUpperCase();
    let i = 0;
    while (i < src.length && out.length < n) {
      const c = src[i];
      if (c === "(" || c === "[") {
        const close = c === "(" ? ")" : "]";
        const j = src.indexOf(close, i);
        const grp = src.slice(i + 1, j < 0 ? src.length : j).split("").filter((x) => choices.includes(x)).join("");
        out.push(St.makeKey(grp, c === "["));
        i = j < 0 ? src.length : j + 1;
      } else if (c === "-" || c === "?" || c === "_" || c === ".") { out.push(""); i++; }
      else if (choices.includes(c)) { out.push(c); i++; }
      else i++;
    }
    return out;
  }

  function renderKey(t) {
    const ranges = sectionRanges(t);
    $("#key-grid").innerHTML = t.sections.map((s, si) => {
      const ch = L.sectionChoices(s);
      const r = ranges[si];
      s.key = s.key || [];
      if (!r.n) return "";
      return `
        <div class="key-sec" data-si="${si}">
          <div class="key-sec-head">
            <strong>Q${r.start + 1}${r.n > 1 ? "–" + (r.end + 1) : ""}</strong>
            <span class="muted small">${esc(presetName(s))}</span>
            <input class="key-quick" spellcheck="false" autocomplete="off" placeholder="Type ${r.n} answers, e.g. ${ch.slice(0, 3).join("")}…" value="${esc(keyToQuick(s.key, r.n))}" />
          </div>
          <div class="key-rows">
            ${Array.from({ length: r.n }, (_, i) => keyRow(r.start + i + 1, i, ch)).join("")}
          </div>
        </div>`;
    }).join("");
    $$(".key-sec").forEach((sec) => {
      const s = t.sections[+sec.dataset.si];
      $$(".key-row", sec).forEach((row, i) => paintKeyRow(row, s.key[i]));
      const ch = L.sectionChoices(s);
      const n = Math.max(0, parseInt(s.count, 10) || 0);
      $(".key-quick", sec).oninput = (e) => {
        const k = quickToKey(e.target.value, ch, n);
        s.key = Array.from({ length: n }, (_, i) => k[i] || "");
        $$(".key-row", sec).forEach((row, i) => paintKeyRow(row, s.key[i]));
        saveSoon(t); renderKeyStatus(t); renderVersions(t);
      };
      sec.onclick = (e) => {
        const mode = e.target.closest(".kmode");
        const b = e.target.closest(".kb");
        if (!b && !mode) return;
        const row = (b || mode).closest(".key-row");
        const i = +row.dataset.local;
        const { letters, all } = St.keyInfo(s.key[i]);
        let k;
        if (mode) k = St.makeKey(letters, !all);
        else {
          const c = b.dataset.c;
          if (e.shiftKey || e.metaKey || e.ctrlKey) k = St.makeKey(letters.includes(c) ? letters.replace(c, "") : letters + c, all);
          else k = letters === c ? "" : c;
        }
        s.key[i] = k;
        paintKeyRow(row, k);
        $(".key-quick", sec).value = keyToQuick(s.key, n);
        saveSoon(t); renderKeyStatus(t); renderVersions(t);
      };
    });
    renderKeyStatus(t);
  }

  function keyRow(num, local, ch) {
    return `<div class="key-row" data-local="${local}"><span class="qn">${num}</span>${ch.map((c) => `<button type="button" class="kb" data-c="${esc(c)}">${esc(c)}</button>`).join("")}<button type="button" class="kmode" title="Click to switch: either answer earns credit, or all of them are required"></button></div>`;
  }
  function paintKeyRow(row, k) {
    const { letters, all } = St.keyInfo(k);
    row.classList.toggle("unset", !letters);
    row.classList.toggle("multi", letters.length > 1);
    row.classList.toggle("all", all);
    $$(".kb", row).forEach((b) => b.classList.toggle("on", letters.includes(b.dataset.c)));
    $(".kmode", row).textContent = all ? "all required" : "either";
  }
  function renderKeyStatus(t) {
    const fk = St.flatKey(t);
    const done = fk.filter(Boolean).length;
    const el = $("#key-status");
    if (el) el.innerHTML = done === fk.length ? `<span class="good-txt">All ${fk.length} answers entered ✓</span>` : `${done} of ${fk.length} answers entered`;
  }

  /* --- versions --- */

  function versionKeyText(t, v) {
    const vk = St.versionKey(t, v);
    return sectionRanges(t).filter((r) => r.n).map((r) =>
      `<span class="vk"><span class="muted">${r.start + 1}${r.n > 1 ? "–" + (r.end + 1) : ""}</span> <code>${esc(keyToQuick(vk.slice(r.start, r.end + 1), r.n) || "—")}</code></span>`
    ).join(" ");
  }

  /* Random order of n questions; positions in `fixed` stay where they are. */
  function shuffled(n, fixed) {
    const a = Array.from({ length: n }, (_, i) => i);
    const free = a.filter((i) => !(fixed && fixed.has(i)));
    for (let tries = 0; tries < 5; tries++) {
      const vals = free.slice();
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      free.forEach((pos, k) => (a[pos] = vals[k]));
      if (free.length < 2 || free.some((pos) => a[pos] !== pos)) break;
    }
    return a;
  }

  const verLocked = (t, v) => !!(t.versionLocks && t.versionLocks[v]);

  /* Save a version's order so the next change can be undone. */
  function rememberOrder(t, v, force) {
    const u = ui(t).undo || (ui(t).undo = {});
    if (!force && u[v] !== undefined) return;
    const cur = t.versionOrders && t.versionOrders[v];
    u[v] = cur ? JSON.parse(JSON.stringify(cur)) : null;
  }

  /* Version A question numbers that must not move (1-based). */
  function fixedSet(t) { return new Set((t.fixedQuestions || []).filter((x) => Number.isInteger(x))); }

  /* Groups from the LaTeX file (questions separated by headings), if known. */
  function texBlocks(t) {
    const n = L.questionChoices(t).length;
    return t.texBlocks && t.texBlocks.length === n ? t.texBlocks : null;
  }

  /* Shuffle each section, keeping questions inside their group in the LaTeX
   * file (so none crosses a heading) and leaving "keep in place" ones alone. */
  function shuffleVersion(t, v) {
    // Try a few times so Shuffle visibly changes the order whenever it can.
    const before = St.versionMap(t, v).join(",");
    for (let tries = 0; tries < 12; tries++) {
      shuffleOnce(t, v);
      if (St.versionMap(t, v).join(",") !== before) return;
    }
  }

  function shuffleOnce(t, v) {
    const fixed = fixedSet(t);
    const blocks = texBlocks(t);
    sectionRanges(t).forEach((r, si) => {
      const order = Array.from({ length: r.n }, (_, i) => i);
      const groups = new Map();
      for (let i = 0; i < r.n; i++) {
        const g = blocks ? blocks[r.start + i] : 0;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(i);
      }
      for (const pos of groups.values()) {
        const local = new Set(pos.map((_, k) => k).filter((k) => fixed.has(r.start + pos[k] + 1)));
        const o = shuffled(pos.length, local);
        pos.forEach((p, k) => (order[p] = pos[o[k]]));
      }
      St.setSectionOrder(t, v, t.sections[si], order);
    });
  }

  /* --- LaTeX: find questions in the Version A file, write reordered versions --- */

  function texCheck(t) {
    const tex = ui(t).tex;
    if (!tex) return null;
    const qc = L.questionChoices(t);
    const fk = St.flatKey(t);
    const p = tex.parsed;
    const out = { ok: !p.error && p.questions.length === qc.length, warnings: [], keyFromTex: [], keyDiffs: [] };
    if (p.error) out.error = p.error;
    else if (p.questions.length !== qc.length) out.error = `Found ${p.questions.length} question${p.questions.length === 1 ? "" : "s"} in the file, but this test has ${qc.length}. Check the list of what was found below; the question count and order must match the test's format.`;
    if (!out.ok) return out;
    p.questions.forEach((q, i) => {
      if (q.choices && q.choices !== qc[i].length) out.warnings.push(`Q${i + 1} has ${q.choices} answer choices in the file, but the test format gives it ${qc[i].length} (${qc[i].join("")}).`);
      let letters = null, all = false;
      if (q.correctIdx.length) { letters = q.correctIdx.map((ix) => qc[i][ix]); all = q.correctIdx.length > 1; }
      else if (q.key) { letters = q.key; all = q.keyAll; }
      if (letters) {
        const bad = letters.filter((x) => !x || !qc[i].includes(x));
        if (bad.length) out.warnings.push(`Q${i + 1}: the file's answer ${letters.map((x) => x || "?").join(", ")} isn't among this question's bubbles (${qc[i].join("")}). Check the question format.`);
        const k = St.makeKey(letters.filter((x) => x && qc[i].includes(x)).join(""), all);
        if (k) {
          out.keyFromTex[i] = k;
          if (k !== fk[i]) out.keyDiffs.push(i);
        }
      }
    });
    return out;
  }

  function downloadVersionTex(t, v) {
    const tex = ui(t).tex;
    const perm = St.versionMap(t, v);
    const reordered = MGLatex.reorder(tex.text, tex.parsed, perm);
    const rl = MGLatex.relabel(reordered, v);
    const vk = St.versionKey(t, v);
    const orderTxt = sectionRanges(t).filter((r) => r.n).map((r) => perm.slice(r.start, r.end + 1).map((m) => m + 1).join(" ")).join(" | ");
    const keyTxt = vk.map((k, i) => `${i + 1}:${St.keyInfo(k).all ? "[" + St.keyInfo(k).letters + "]" : St.keyInfo(k).letters.length > 1 ? "(" + St.keyInfo(k).letters + ")" : k || "?"}`).join(" ");
    const head = `% Version ${v}, made by MultiGrader from ${tex.name} on ${new Date().toLocaleDateString()}.\n` +
      `% Question order (Version A numbers): ${orderTxt}\n` +
      `% Version ${v} answer key: ${keyTxt}\n`;
    const base = tex.name.replace(/\.tex$/i, "").replace(/[-_ ]?(version[-_ ]?)?A$/i, "");
    download(`${base}-version-${v}.tex`, head + rl.text, "application/x-tex");
    toast(rl.count ? `Downloaded Version ${v}. Changed “Version A” to “Version ${v}” in ${rl.count} place${rl.count > 1 ? "s" : ""}.`
      : `Downloaded Version ${v}. No “Version A” label was found in the file; add one to your header so students know which version to bubble.`);
  }

  function groupRanges(p) {
    const out = [];
    p.questions.forEach((q, i) => {
      if (i === 0 || q.block !== p.questions[i - 1].block) out.push([i + 1, i + 1]);
      else out[out.length - 1][1] = i + 1;
    });
    return out.map(([a, b]) => (a === b ? `Q${a}` : `Q${a}–${b}`));
  }

  function texPanel(t, labels) {
    const tex = ui(t).tex;
    const chk = texCheck(t);
    const fk = St.flatKey(t);
    const fixed = (t.fixedQuestions || []).join(" ");
    let body = "";
    if (tex) {
      const p = tex.parsed;
      body += chk.ok
        ? `<p class="good-txt small"><strong>${esc(tex.name)}</strong>: found all ${p.questions.length} questions (${p.mode === "exam" ? "exam class \\question" : "numbered list \\item"}) ✓</p>`
        : `<div class="notice bad small"><strong>${esc(tex.name)}</strong>: ${esc(chk.error)}</div>`;
      if (chk.ok) {
        const nb = new Set(p.questions.map((q) => q.block)).size;
        if (nb > 1) body += `<p class="muted small">Your file has ${nb} groups of questions separated by headings or instructions (${groupRanges(p).join(", ")}). Shuffle keeps each question inside its group.</p>`;
      }
      if (chk.ok && chk.warnings.length) body += `<div class="notice small">${chk.warnings.slice(0, 4).map(esc).join("<br>")}${chk.warnings.length > 4 ? `<br>…and ${chk.warnings.length - 4} more` : ""}</div>`;
      if (chk.ok && chk.keyFromTex.some(Boolean)) {
        const n = chk.keyFromTex.filter(Boolean).length;
        const describe = (k) => {
          if (!k) return "blank";
          const { letters, all } = St.keyInfo(k);
          return letters.length < 2 ? letters : `${St.keyText(k)} (${all ? "all required" : "either"})`;
        };
        const diffList = chk.keyDiffs.slice(0, 8).map((i) => `<li>Q${i + 1}: file <strong>${esc(describe(chk.keyFromTex[i]))}</strong>, your key <strong>${esc(describe(fk[i]))}</strong></li>`).join("") +
          (chk.keyDiffs.length > 8 ? `<li>…and ${chk.keyDiffs.length - 8} more</li>` : "");
        body += chk.keyDiffs.length
          ? `<div class="notice small">The file marks the answers to ${n} question${n > 1 ? "s" : ""}. ${chk.keyDiffs.length === n && fk.every((k) => !k) ? "Your answer key is empty." : `They differ from your answer key on ${chk.keyDiffs.length} question${chk.keyDiffs.length > 1 ? "s" : ""}:<ul class="diff-list">${diffList}</ul>`}
              <button class="btn small primary" id="tex-usekey">Use the file's answers</button></div>`
          : `<p class="good-txt small">The answers marked in the file match your key on all ${n} question${n > 1 ? "s" : ""} ✓</p>`;
      }
      if (p.questions.length) {
        body += `<details class="help"><summary>Questions found in the file (${p.questions.length})</summary><ol class="tex-list">${p.questions.map((q) => `<li>${q.block !== (p.questions[p.questions.indexOf(q) - 1] || q).block ? `<span class="tex-break"></span>` : ""}${esc(q.preview || "(empty)")}${q.key || q.correctIdx.length ? ` <span class="muted">· answer ${esc(q.key ? q.key.join(q.keyAll ? "+" : "") : q.correctIdx.map((x) => "ABCDEF"[x]).join("+"))}</span>` : ""}${q.choices ? ` <span class="muted">· ${q.choices} choices</span>` : ""}</li>`).join("")}</ol></details>`;
      }
    }
    return `
      <div class="tex-box">
        <div class="ver-head"><strong>From your LaTeX file</strong></div>
        <p class="muted small">Upload the <code>.tex</code> file for Version A. MultiGrader finds the questions (<code>\\question</code> in the exam class, or <code>\\item</code> in a numbered <code>enumerate</code> list),
          and for each version gives you a new <code>.tex</code> file with the questions in that version's order. That version's key is set automatically.
          Page breaks and headings between questions stay where they are; answer choices, figures and solutions move with their question.</p>
        <div class="btn-row">
          <label class="btn" for="tex-in">${tex ? "Upload a different .tex…" : "Upload Version A .tex…"}</label>
          <input type="file" id="tex-in" accept=".tex,text/x-tex,application/x-tex,text/plain" class="visually-hidden" />
        </div>
        ${body}
        <div class="form-row tex-fixed">
          <label class="grow">Keep in place when shuffling <span class="muted small">(Version A numbers, e.g. questions that share a figure)</span>
            <input id="tex-fixed" value="${esc(fixed)}" placeholder="e.g. 12 13 14" inputmode="numeric" /></label>
        </div>
      </div>`;
  }

  function renderVersions(t) {
    const el = $("#versions-card");
    if (!el) return;
    const labels = L.versionLabels(t);
    const locked = formatLocked(t);
    const ranges = sectionRanges(t);
    el.innerHTML = `
      <h2>Versions</h2>
      <div class="form-row">
        <label>Number of versions
          <select id="v-count" ${locked ? "disabled" : ""}>${L.VERSION_LABELS.map((l, i) => `<option value="${i + 1}" ${labels.length === i + 1 ? "selected" : ""}>${i === 0 ? "1 (no versions)" : `${i + 1} (A–${l})`}</option>`).join("")}</select>
        </label>
      </div>
      ${locked ? `<p class="muted small">The number of versions changes the printed sheet, so it's locked once sheets are printed (see Question format).</p>` : ""}
      ${labels.length < 2 ? `<p class="muted small">Use versions to give students the same questions in a different order. Each sheet gets a VERSION row for students to bubble, each sheet is graded with its version's key, and results and item analysis use Version A's question numbers.</p>` : `
      <p class="muted small">Version A uses the order above. For each other version, list the <strong>Version A question numbers in the order they appear on that version</strong>, or click Shuffle.
        Questions can move only within their own section, so every version uses the same answer sheet. Students bubble their version at the top of the sheet; if they forget, the sheet is graded as the version that fits best and flagged for you.</p>
      ${texPanel(t, labels)}
      ${labels.slice(1).map((v) => {
        const vLocked = verLocked(t, v);
        const canUndo = !vLocked && ui(t).undo && ui(t).undo[v] !== undefined;
        return `
        <div class="ver-block ${vLocked ? "locked" : ""}" data-v="${v}">
          <div class="ver-head"><strong>Version ${v}</strong>
            ${vLocked
              ? `<span class="pill lock-pill">🔒 Order locked</span>
                 <button class="btn small ghost" data-unlock>Unlock…</button>`
              : `<button class="btn small" data-shuffle>Shuffle</button>
                 ${canUndo ? `<button class="btn small ghost" data-undo title="Go back to the order before the last change">↶ Undo</button>` : ""}
                 <button class="btn small ghost" data-same>Same as A</button>
                 <button class="btn small" data-lock title="Keep this order: Shuffle and editing are turned off until you unlock">🔒 Lock order</button>`}
            ${ui(t).tex ? `<span class="spacer"></span><button class="btn small primary" data-texdl ${texCheck(t).ok ? "" : "disabled"}>⬇ Version ${v} .tex</button>` : ""}</div>
          ${t.sections.map((s, si) => {
            const r = ranges[si];
            if (!r.n) return "";
            const o = St.sectionOrder(t, v, s);
            return `<div class="ver-sec" data-si="${si}">
              <span class="ver-range">${v} ${r.start + 1}${r.n > 1 ? "–" + (r.end + 1) : ""}</span>
              <input class="ver-order" value="${o.map((x) => x + r.start + 1).join(" ")}" spellcheck="false" autocomplete="off" inputmode="numeric" ${vLocked ? 'readonly title="Unlock this version to change its order"' : ""} />
              <span class="ver-msg small"></span></div>`;
          }).join("")}
          <div class="ver-key small"><span class="muted">Version ${v} key:</span> <span class="vk-list">${versionKeyText(t, v)}</span></div>
        </div>`;
      }).join("")}`}`;

    const texIn = $("#tex-in");
    if (texIn) texIn.onchange = async () => {
      const f = texIn.files[0];
      if (!f) return;
      const text = await f.text();
      ui(t).tex = { name: f.name, text, parsed: MGLatex.parse(text) };
      const chk = texCheck(t);
      if (chk && chk.ok) { t.texBlocks = ui(t).tex.parsed.questions.map((q) => q.block); saveSoon(t); }
      renderVersions(t);
    };
    const fx = $("#tex-fixed");
    if (fx) fx.oninput = () => {
      const n = L.questionChoices(t).length;
      t.fixedQuestions = [...new Set((fx.value.match(/\d+/g) || []).map(Number).filter((x) => x >= 1 && x <= n))];
      saveSoon(t);
    };
    const uk = $("#tex-usekey");
    if (uk) uk.onclick = () => {
      const chk = texCheck(t);
      const ranges = sectionRanges(t);
      chk.keyFromTex.forEach((k, i) => {
        if (!k) return;
        const si = ranges.findIndex((r) => i >= r.start && i <= r.end);
        const sec = t.sections[si];
        sec.key = sec.key || [];
        sec.key[i - ranges[si].start] = k;
      });
      saveSoon(t); renderKey(t); renderVersions(t);
      toast("Answer key filled in from the answers marked in the file.");
    };

    const vc = $("#v-count");
    vc.onchange = () => {
      t.versionCount = +vc.value;
      saveSoon(t); updateRanges(t); renderVersions(t); updatePreview(t);
    };
    $$(".ver-block", el).forEach((blk) => {
      const v = blk.dataset.v;
      $$(".ver-sec", blk).forEach((row) => {
        const sec = t.sections[+row.dataset.si];
        const r = ranges[+row.dataset.si];
        const inp = $(".ver-order", row), msg = $(".ver-msg", row);
        if (verLocked(t, v)) return;
        inp.onfocus = () => rememberOrder(t, v);
        inp.oninput = () => {
          const nums = (inp.value.match(/\d+/g) || []).map(Number);
          const want = Array.from({ length: r.n }, (_, i) => r.start + 1 + i);
          const missing = want.filter((x) => !nums.includes(x));
          const dup = [...new Set(nums.filter((x, i) => nums.indexOf(x) !== i))];
          const bad = nums.filter((x) => x < r.start + 1 || x > r.end + 1);
          if (!missing.length && !dup.length && !bad.length && nums.length === r.n) {
            St.setSectionOrder(t, v, sec, nums.map((x) => x - r.start - 1));
            const blocks = texBlocks(t);
            const crossing = blocks ? nums.filter((x, k) => blocks[x - 1] !== blocks[r.start + k]) : [];
            msg.innerHTML = crossing.length
              ? `<span class="warn-txt">✓ saved, but Q${crossing.join(", Q")} would move across a heading in your LaTeX file</span>`
              : `<span class="good-txt">✓</span>`;
            inp.classList.remove("invalid");
            $(".vk-list", blk).innerHTML = versionKeyText(t, v);
            saveSoon(t);
          } else {
            const parts = [];
            if (bad.length) parts.push(`not in this section: ${bad.join(", ")}`);
            if (dup.length) parts.push(`repeated: ${dup.join(", ")}`);
            if (missing.length) parts.push(`missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
            msg.innerHTML = `<span class="bad-txt">${esc(parts.join("; "))}</span>`;
            inp.classList.add("invalid");
          }
        };
      });
      const dl = $("[data-texdl]", blk);
      if (dl) dl.onclick = () => downloadVersionTex(t, v);
      const on = (sel, fn) => { const b = $(sel, blk); if (b) b.onclick = fn; };
      on("[data-shuffle]", () => {
        rememberOrder(t, v, true);
        shuffleVersion(t, v);
        saveSoon(t); renderVersions(t);
      });
      on("[data-same]", () => {
        rememberOrder(t, v, true);
        if (t.versionOrders) delete t.versionOrders[v];
        saveSoon(t); renderVersions(t);
      });
      on("[data-undo]", () => {
        const prev = ui(t).undo[v];
        t.versionOrders = t.versionOrders || {};
        if (prev) t.versionOrders[v] = prev; else delete t.versionOrders[v];
        delete ui(t).undo[v];
        saveSoon(t); renderVersions(t);
      });
      on("[data-lock]", () => {
        t.versionLocks = t.versionLocks || {};
        t.versionLocks[v] = true;
        if (ui(t).undo) delete ui(t).undo[v];
        saveSoon(t); renderVersions(t);
        toast(`Version ${v}'s order is locked. You can still download its .tex file.`);
      });
      on("[data-unlock]", () => {
        const used = St.scansFor(t).filter((sc) => St.grade(t, sc).version === v).length;
        const msg = `Unlock Version ${v} so its order can change?` +
          (used ? `\n\n${used} scanned sheet${used > 1 ? "s are" : " is"} graded as Version ${v}. If you change the order, ${used > 1 ? "they" : "it"} will be regraded with the new order, which won't match the printed copies.` : "\n\nIf you've already printed or shared Version " + v + ", changing its order will make those copies not match the key.");
        if (!confirm(msg)) return;
        delete t.versionLocks[v];
        saveSoon(t); renderVersions(t);
      });
    });
  }

  let previewTimer;
  function updatePreview(t) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const el = $("#preview"), note = $("#preview-note");
      if (!el || !note) return; // left the Build page before the timer fired
      const cls = t.classIds.map(St.getClass).filter(Boolean)[0];
      el.innerHTML = L.renderSheetSVG(t, { testCode: t.code, sheetCode: 1, studentName: "Student Name", className: cls ? cls.name : "", date: fmtDate(t.date) });
      const lay = L.computeLayout(t);
      $("#preview-note").innerHTML = lay.error ? `<span class="bad-txt">${esc(lay.error)}</span>` : `Preview · Letter size · each student's sheet has their name and a code strip the scanner reads.`;
    }, 120);
  }

  /* ================================================================
   * ANSWER SHEETS (PDF)
   * ================================================================ */

  function viewPrint(t) {
    const classes = t.classIds.map(St.getClass).filter(Boolean);
    const lay = L.computeLayout(t);
    const sel = ui(t).print || (ui(t).print = { classes: classes.map((c) => c.id), student: "", blanks: 0, key: false });
    main.innerHTML = `
      ${testHeader(t, "print")}
      <div class="build-grid">
        <div class="build-main">
          <section class="card">
            <h2>Answer sheets</h2>
            ${lay.error ? `<div class="notice bad">${esc(lay.error)} <a href="#/test/${t.id}/build">Fix the format</a></div>` : ""}
            ${classes.length ? `
              <div class="field">
                <div class="label">Named sheets for</div>
                <div class="check-row">${classes.map((c) => `<label class="check"><input type="checkbox" data-pc="${c.id}" ${sel.classes.includes(c.id) ? "checked" : ""}/> ${esc(c.name)} <span class="muted">(${c.students.length})</span></label>`).join("")}</div>
              </div>
              <div class="field">
                <label>Only one student (e.g. a reprint or make-up)
                  <select id="p-student"><option value="">— everyone in the classes above —</option>
                    ${classes.map((c) => `<optgroup label="${esc(c.name)}">${St.sortedStudents(c).map((s) => `<option value="${s.id}" ${sel.student === s.id ? "selected" : ""}>${esc(St.studentName(s))}</option>`).join("")}</optgroup>`).join("")}
                  </select></label>
              </div>`
            : `<div class="notice">This test isn't assigned to a class yet. <a href="#/test/${t.id}/build">Choose classes</a> to make named sheets, or make blank sheets below.</div>`}
            <div class="form-row">
              <label>Extra blank sheets <span class="muted small">(student writes their name)</span>
                <input id="p-blanks" type="number" min="0" max="60" value="${sel.blanks}" /></label>
            </div>
            <label class="check"><input type="checkbox" id="p-key" ${sel.key ? "checked" : ""}/> Also include ${L.versionLabels(t).length > 1 ? "an answer-key sheet for each version" : "an answer-key sheet"} <span class="muted small">(scan it to double-check your key — it's never recorded as a student)</span></label>
            <div class="print-go">
              <button class="btn primary big" id="p-pdf" ${lay.error ? "disabled" : ""}>⬇ Download PDF</button>
            </div>
            <p class="muted small">One PDF with every sheet, each on its own Letter-size page. Open it and print at <strong>Actual size</strong> (100%), or send it to your copy room.</p>
            <details class="help">
              <summary>Printing tips</summary>
              <ul>
                <li>Letter paper, portrait, one-sided. "Fit to page" also works: the scanner finds the four corner squares, so a slightly smaller sheet scans the same.</li>
                <li>Each sheet's code strip identifies the test <em>and</em> the student, so sheets can be scanned in any order, upside down, or mixed with other tests.</li>
                <li>Downloading a student's sheet again gives the same code, so either copy can be scanned.</li>
              </ul>
            </details>
          </section>
          ${St.isPrinted(t) ? `<section class="card"><h2>Sheets made so far</h2><p class="muted">${t.sheets.filter((s) => s.studentId).length} named sheet(s), ${t.sheets.filter((s) => !s.studentId).length} blank sheet(s).</p></section>` : ""}
        </div>
        <aside class="build-preview"><div class="card sticky"><h2>Preview</h2><div id="preview" class="sheet-preview"></div></div></aside>
      </div>`;

    const jobs = () => {
      const list = [];
      if (sel.student) {
        const f = St.findStudent(sel.student);
        if (f) list.push({ student: f.student, cls: f.cls });
      } else {
        for (const c of classes) if (sel.classes.includes(c.id)) for (const s of St.sortedStudents(c)) list.push({ student: s, cls: c });
      }
      return list;
    };
    const vlabels = L.versionLabels(t);
    const update = () => {
      const n = jobs().length + sel.blanks + (sel.key ? vlabels.length : 0);
      $("#p-pdf").textContent = n ? `⬇ Download PDF (${n} sheet${n === 1 ? "" : "s"})` : "⬇ Download PDF";
      $("#p-pdf").disabled = !!lay.error || n === 0;
      const first = jobs()[0];
      $("#preview").innerHTML = L.renderSheetSVG(t, {
        testCode: t.code, sheetCode: first ? 1 : 2,
        studentName: first ? St.studentName(first.student) : "", className: first ? first.cls.name : "", date: fmtDate(t.date),
      });
    };
    $$("[data-pc]").forEach((cb) => (cb.onchange = () => { sel.classes = $$("[data-pc]").filter((x) => x.checked).map((x) => x.dataset.pc); update(); }));
    const ps = $("#p-student");
    if (ps) ps.onchange = () => { sel.student = ps.value; update(); };
    $("#p-blanks").oninput = (e) => { sel.blanks = Math.max(0, Math.min(60, parseInt(e.target.value, 10) || 0)); update(); };
    $("#p-key").onchange = (e) => { sel.key = e.target.checked; update(); };
    /* The sheets to produce (assigning sheet codes, which are saved). */
    const sheetOpts = () => {
      const date = fmtDate(t.date);
      const list = [];
      for (const j of jobs()) {
        const sh = St.sheetFor(t, j.student.id, j.cls.id);
        list.push({ testCode: t.code, sheetCode: sh.code, studentName: St.studentName(j.student), className: j.cls.name, date });
      }
      const blankCls = classes.length === 1 ? classes[0] : null;
      for (let i = 0; i < sel.blanks; i++) {
        const sh = St.newBlankSheet(t, blankCls && blankCls.id);
        list.push({ testCode: t.code, sheetCode: sh.code, className: blankCls ? blankCls.name : "", date });
      }
      if (sel.key) {
        for (const v of vlabels) list.push({ testCode: t.code, sheetCode: L.SHEET_KEY, key: St.versionKey(t, v), version: vlabels.length > 1 ? v : null, date });
      }
      t.updatedAt = St.now();
      St.save();
      return list;
    };
    $("#p-pdf").onclick = async () => {
      const btn = $("#p-pdf");
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "Making PDF…";
      try {
        const blob = await MGPdf.sheetsToPDF(sheetOpts().map((o) => L.sheetOps(t, o)), { title: `${t.title} — answer sheets` });
        const name = `${safeFileName(t.title)} - answer sheets.pdf`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast("PDF downloaded. Print it at <strong>Actual size</strong> (100%) for full-size sheets.");
      } catch (e) {
        alert("Couldn't make the PDF: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    update();
  }

  /* ================================================================
   * RESULTS
   * ================================================================ */

  /* A clickable column header that cycles: off → lowest first → highest first. */
  /* A clickable column header that cycles: off → ascending → descending → off.
   * state is { col, dir } for the table (one sorted column at a time). */
  function sortButton(id, label, state, col, notes, title) {
    const m = state && state.col === col ? state.dir : 0;
    const note = ["", notes[0], notes[1]][m];
    return `<button type="button" class="th-sort ${m ? "on" : ""}" id="${id}" title="${esc(title)}" aria-label="${esc(label)}: ${note || "not sorted"}. ${esc(title)}">` +
      `${esc(label)} <span class="sort-arrow">${["⇅", "▲", "▼"][m]}</span>${note ? `<span class="sort-note">${note}</span>` : ""}</button>`;
  }

  /* "Last, First" (or just the first name if there's no last name). */
  const lastFirst = (s) => (s.last ? `${s.last}, ${s.first}` : s.first);

  function viewResults(t) {
    const classes = t.classIds.map(St.getClass).filter(Boolean);
    const vlabels = L.versionLabels(t);
    const hasV = vlabels.length > 1;
    const filter = ui(t).filter || "";
    const vfilter = hasV ? ui(t).vfilter || "" : "";
    const scans = St.scansFor(t);
    const roster = testRoster(t);
    const rows = scans.map((scan) => {
      const f = scan.studentId ? St.findStudent(scan.studentId) : null;
      const g = St.grade(t, scan);
      return { scan, student: f && f.student, cls: f && f.cls, g, nflag: St.flagCount(scan, g) };
    });
    const inFilter = (r) => (!filter || (r.cls && r.cls.id === filter)) && (!vfilter || r.g.version === vfilter);
    const named = rows.filter((r) => r.student && inFilter(r)).sort((a, b) => (a.student.last + a.student.first).localeCompare(b.student.last + b.student.first));
    const unassigned = rows.filter((r) => !r.student && (!filter || !r.scan.studentId) && (!vfilter || r.g.version === vfilter));
    const scannedIds = new Set(rows.filter((r) => r.student).map((r) => r.student.id));
    const missing = vfilter ? [] : roster.filter((x) => !scannedIds.has(x.student.id) && (!filter || x.cls.id === filter));
    const graded = named.concat(unassigned);
    // Summary in points (e.g. 24.4/30) with the percent underneath.
    const pts = graded.map((r) => r.g.score).sort((a, b) => a - b);
    const possible = graded.length ? Math.max(...graded.map((r) => r.g.possible)) : 0;
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : NaN;
    const median = pts.length ? (pts[Math.floor((pts.length - 1) / 2)] + pts[Math.ceil((pts.length - 1) / 2)]) / 2 : NaN;
    const statBox = (v, label) => `<div class="stat"><div class="stat-n">${isFinite(v) && possible ? `${fmtPts(v)}<span class="muted">/${fmtPts(possible)}</span>` : "–"}</div>` +
      `<div class="stat-p">${isFinite(v) && possible ? pct((100 * v) / possible) : ""}</div><div class="stat-l">${label}</div></div>`;
    const fk = St.flatKey(t);
    const qc = L.questionChoices(t);
    const vcol = (r) => hasV ? `<td>${r.g.version}${r.g.versionInferred ? `<span class="warn-txt" title="Version not bubbled clearly; graded as the best-matching version">?</span>` : ""}</td>` : "";
    const ncols = 6 + (classes.length > 1 ? 1 : 0) + (hasV ? 1 : 0);

    main.innerHTML = `
      ${testHeader(t, "results")}
      <div class="results-top">
        ${classes.length > 1 ? `<label>Class <select id="r-filter"><option value="">All classes</option>${classes.map((c) => `<option value="${c.id}" ${filter === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : ""}
        ${hasV ? `<label>Version <select id="r-vfilter"><option value="">All versions</option>${vlabels.map((v) => `<option value="${v}" ${vfilter === v ? "selected" : ""}>Version ${v}</option>`).join("")}</select></label>` : ""}
        <div class="spacer"></div>
        <button class="btn" id="r-graded" ${graded.length ? "" : "disabled"} title="One graded copy per student to hand back: their answers, the correct answers and their score">⬇ Graded copies of all bubble sheets (PDF)</button>
        <button class="btn" id="r-csv" ${graded.length ? "" : "disabled"}>Export CSV</button>
      </div>
      ${fk.some((k) => !k) ? `<div class="notice">The answer key is incomplete (${fk.filter(Boolean).length}/${fk.length}). Unkeyed questions aren't scored. <a href="#/test/${t.id}/build">Finish the key</a></div>` : ""}
      <div class="stats">
        ${roster.length && !vfilter
          // Students scanned out of the class; unmatched blank sheets listed separately.
          ? (() => {
              // Count each student once, out of the class size (current filter).
              const studentsIn = new Set(named.map((r) => r.student.id)).size;
              const classSize = studentsIn + missing.length;
              const extra = named.length - studentsIn;
              const notes = [];
              if (unassigned.length) notes.push(`+ ${unassigned.length} unmatched blank sheet${unassigned.length === 1 ? "" : "s"}`);
              if (extra) notes.push(`${extra} student${extra === 1 ? " has" : "s have"} 2+ sheets`);
              return `<div class="stat"><div class="stat-n">${studentsIn}<span class="muted">/${classSize}</span></div>
              <div class="stat-p ${notes.length ? "warn-txt" : ""}">${notes.join("; ")}</div>
              <div class="stat-l">students scanned</div></div>`;
            })()
          : `<div class="stat"><div class="stat-n">${graded.length}</div><div class="stat-p"></div><div class="stat-l">sheets scanned</div></div>`}
        ${statBox(mean, "mean")}
        ${statBox(median, "median")}
        ${statBox(pts.length ? pts[pts.length - 1] : NaN, "high")}
        ${statBox(pts.length ? pts[0] : NaN, "low")}
      </div>

      <section class="card">
        <h2>Students</h2>
        ${graded.length === 0 && missing.length === 0 ? `<p class="muted">Nothing scanned yet. Go to <a href="#/scan">Scan</a>.</p>` : `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>${sortButton("name-sort", "Student", ui(t).studentSort, "name", ["A–Z", "Z–A"], "Sort by last name: A–Z, Z–A, or back to the usual order")}</th>${classes.length > 1 ? "<th>Class</th>" : ""}${hasV ? "<th>Ver.</th>" : ""}<th class="num">${sortButton("student-sort", "Score", ui(t).studentSort, "score", ["lowest first", "highest first"], "Sort by score: lowest first, highest first, or back to name order")}</th><th class="num">%</th><th>Check</th><th>Scanned</th><th></th></tr></thead>
          <tbody>
            ${(() => {
              const rowHTML = (r) => r.student ? `<tr>
              <td>${esc(lastFirst(r.student))}</td>${classes.length > 1 ? `<td>${esc(r.cls.name)}</td>` : ""}${vcol(r)}
              <td class="num">${fmtPts(r.g.score)}/${fmtPts(r.g.possible)}</td><td class="num"><strong>${pct(r.g.pct)}</strong></td>
              <td>${r.nflag ? `<span class="pill warn">${r.nflag} to check</span>` : ""}${Object.keys(r.scan.overrides || {}).length || r.scan.versionOverride ? `<span class="pill">edited</span>` : ""}</td>
              <td class="muted small">${fmtTime(r.scan.scannedAt)}</td>
              <td><button class="btn small" data-review="${r.scan.id}">Review</button></td></tr>` : `<tr class="unassigned">
              <td><em>Blank sheet #${r.scan.sheetCode}</em> → <select data-assign="${r.scan.id}"><option value="">who is this?</option>${roster.map((x) => `<option value="${x.student.id}">${esc(lastFirst(x.student))}</option>`).join("")}</select></td>${classes.length > 1 ? "<td></td>" : ""}${vcol(r)}
              <td class="num">${fmtPts(r.g.score)}/${fmtPts(r.g.possible)}</td><td class="num"><strong>${pct(r.g.pct)}</strong></td>
              <td>${r.nflag ? `<span class="pill warn">${r.nflag} to check</span>` : ""}</td>
              <td class="muted small">${fmtTime(r.scan.scannedAt)}</td>
              <td><button class="btn small" data-review="${r.scan.id}">Review</button></td></tr>`;
              // Default: by last name, blank sheets after. Or sorted by name / score.
              const st = ui(t).studentSort;
              const list = named.concat(unassigned);
              const nameKey = (r) => (r.student ? `${r.student.last} ${r.student.first}`.toLowerCase() : "\uffff" + String(r.scan.sheetCode).padStart(5, "0"));
              if (st && st.col === "score") list.sort((a, b) => (st.dir === 1 ? a.g.pct - b.g.pct : b.g.pct - a.g.pct) || list.indexOf(a) - list.indexOf(b));
              if (st && st.col === "name") list.sort((a, b) => (st.dir === 1 ? 1 : -1) * nameKey(a).localeCompare(nameKey(b)));
              return list.map(rowHTML).join("");
            })()}
            ${missing.map((x) => `<tr class="missing"><td>${esc(lastFirst(x.student))}</td>${classes.length > 1 ? `<td>${esc(x.cls.name)}</td>` : ""}<td colspan="${ncols - 1 - (classes.length > 1 ? 1 : 0)}" class="muted">not scanned</td></tr>`).join("")}
          </tbody>
        </table></div>`}
      </section>

      ${graded.length ? `<section class="card">
        <h2>Item analysis</h2>
        <p class="muted small">How often each answer was chosen; correct answers are highlighted, and questions most students missed are shaded.
          ${hasV ? "Questions are numbered as on <strong>Version A</strong>; answers from every version are matched to the same question." : ""}
          For “all required” questions, each bar counts how many students bubbled that letter.</p>
        <div class="table-wrap"><table class="table items">
          <thead><tr><th>${sortButton("q-sort", "Q", ui(t).itemSort, "q", ["1 → last", "last → 1"], "Sort by question number: first to last, last to first, or back to question order")}</th><th>Key</th><th class="num">${sortButton("item-sort", "Correct", ui(t).itemSort, "pct", ["lowest first", "highest first"], "Sort by percent correct: lowest first, highest first, or back to question order")}</th><th>Responses</th></tr></thead>
          <tbody>${(() => {
            const items = qc.map((ch, i) => {
              const ki = St.keyInfo(fk[i]);
              const counts = {};
              let blank = 0, multi = 0, correct = 0;
              for (const r of graded) {
                const it = r.g.items[i];
                if (!it) continue;
                if (!it.resp) blank++;
                else if (it.resp.length > 1 && !ki.all) multi++;
                else for (const c of it.resp) counts[c] = (counts[c] || 0) + 1;
                if (it.correct) correct++;
              }
              return { i, ch, ki, counts, blank, multi, p: fk[i] ? (100 * correct) / graded.length : NaN };
            });
            // Default: question order. Or by question number / % correct (unkeyed last).
            const st = ui(t).itemSort;
            if (st && st.col === "pct") items.sort((a, b) => (isNaN(a.p) - isNaN(b.p)) || (st.dir === 1 ? a.p - b.p : b.p - a.p) || a.i - b.i);
            if (st && st.col === "q" && st.dir === 2) items.reverse();
            // Each response is a button; clicking it lists who gave that answer.
            const open = ui(t).itemOpen;
            const isOpen = (i, c) => open && open.q === i && open.c === c;
            const bar = (i, c, n, isKey) => `<button type="button" class="resp ${isKey ? "key" : ""} ${isOpen(i, c) ? "open" : ""}" data-iq="${i}" data-ic="${esc(c)}" title="${n} chose ${esc(c)}: click to see who"><b>${esc(c)}</b> ${n}<i style="width:${(100 * n) / graded.length}%"></i></button>`;
            const other = (i, c, label, n) => `<button type="button" class="resp other ${isOpen(i, c) ? "open" : ""}" data-iq="${i}" data-ic="${c}" title="click to see who">${label} ${n}</button>`;
            const who = (i, c, ki) => {
              const match = (resp) => (c === "blank" ? !resp : c === "multiple" ? resp.length > 1 && !ki.all : ki.all ? resp.includes(c) : resp === c);
              const list = graded.filter((r) => r.g.items[i] && match(r.g.items[i].resp))
                .map((r) => ({ r, name: r.student ? lastFirst(r.student) : `Blank sheet #${r.scan.sheetCode}`, sort: r.student ? (r.student.last + " " + r.student.first).toLowerCase() : "~" + r.scan.sheetCode }))
                .sort((a, b) => a.sort.localeCompare(b.sort));
              const what = c === "blank" ? "left it blank" : c === "multiple" ? "bubbled more than one answer" : ki.all ? `bubbled ${esc(c)}` : `answered ${esc(c)}`;
              return `<tr class="who-row"><td colspan="4"><div class="who">
                <strong>Q${i + 1}: ${list.length} ${what}</strong>
                ${list.length ? `<div class="who-names">${list.map(({ r, name }) => `<button type="button" class="who-name" data-review="${r.scan.id}" title="Open ${esc(name)}'s sheet">${esc(name)}${(ki.all || c === "multiple") && r.g.items[i].resp.length > 1 ? ` <span class="muted">(${esc(r.g.items[i].resp.split("").join(", "))})</span>` : ""}${hasV ? ` <span class="muted">· ${r.g.version}</span>` : ""}</button>`).join("")}</div>` : ""}
              </div></td></tr>`;
            };
            return items.map(({ i, ch, ki, counts, blank, multi, p }) => `<tr class="${fk[i] && p < 50 ? "hard" : ""}"><td>${i + 1}</td><td>${esc(St.keyText(fk[i]) || "—")}${ki.all ? ` <span class="pill">all</span>` : ""}</td><td class="num">${pct(p)}</td>
              <td class="resp-cell">${ch.map((c) => bar(i, c, counts[c] || 0, ki.letters.includes(c))).join("")}${blank ? other(i, "blank", "blank", blank) : ""}${multi ? other(i, "multiple", "multiple", multi) : ""}</td></tr>
              ${open && open.q === i ? who(i, open.c, ki) : ""}`).join("");
          })()}</tbody>
        </table></div>
      </section>` : ""}`;

    const rf = $("#r-filter");
    if (rf) rf.onchange = () => { ui(t).filter = rf.value; viewResults(t); };
    const rerender = () => { const y = window.scrollY; viewResults(t); window.scrollTo(0, y); }; // stay at the table
    // Sort headers: click the same column to go ascending → descending → off;
    // clicking another column starts sorting by that one.
    const cycle = (key, col) => {
      const s = ui(t)[key];
      ui(t)[key] = s && s.col === col ? (s.dir === 1 ? { col, dir: 2 } : null) : { col, dir: 1 };
      rerender();
    };
    for (const [id, key, col] of [["item-sort", "itemSort", "pct"], ["q-sort", "itemSort", "q"], ["student-sort", "studentSort", "score"], ["name-sort", "studentSort", "name"]]) {
      const b = $("#" + id);
      if (b) b.onclick = () => cycle(key, col);
    }
    $$("[data-iq]").forEach((b) => (b.onclick = () => {
      const q = +b.dataset.iq, c = b.dataset.ic, o = ui(t).itemOpen;
      ui(t).itemOpen = o && o.q === q && o.c === c ? null : { q, c };
      rerender();
    }));
    const vf = $("#r-vfilter");
    if (vf) vf.onchange = () => { ui(t).vfilter = vf.value; viewResults(t); };
    $$("[data-review]").forEach((b) => (b.onclick = () => openReview(b.dataset.review, () => viewResults(t))));
    $$("[data-assign]").forEach((s) => (s.onchange = () => {
      const scan = St.db.scans.find((x) => x.id === s.dataset.assign);
      if (!s.value) return;
      const other = St.db.scans.find((x) => x.testId === t.id && x.studentId === s.value && x.id !== scan.id);
      if (other && !confirm("That student already has a scanned sheet for this test. Keep both?")) { s.value = ""; return; }
      scan.studentId = s.value; scan.updatedAt = St.now();
      St.save(); viewResults(t);
    }));
    $("#r-graded").onclick = async () => {
      const btn = $("#r-graded");
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Making PDF…";
      try {
        const date = fmtDate(t.date);
        const pages = graded.map((r) => L.gradedSheetOps(t, {
          title: t.title, date,
          studentName: r.student ? St.studentName(r.student) : `Blank sheet #${r.scan.sheetCode}`,
          className: r.cls ? r.cls.name : "",
          version: hasV ? r.g.version : null,
          items: r.g.byPos.map((it) => ({ resp: it.resp, key: it.key, correct: it.correct })),
          score: r.g.score, possible: r.g.possible, pct: r.g.pct,
        }));
        const blob = await MGPdf.sheetsToPDF(pages, { title: `${t.title} — graded copies` });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(t.title)} - graded copies.pdf`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        const unchecked = graded.filter((r) => r.nflag).length;
        toast(`Downloaded ${pages.length} graded cop${pages.length === 1 ? "y" : "ies"}.` + (unchecked ? ` Note: ${unchecked} still ha${unchecked === 1 ? "s" : "ve"} answers marked “to check”.` : ""));
      } catch (e) {
        alert("Couldn't make the PDF: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    $("#r-csv").onclick = () => {
      const quick = (k) => { const { letters, all } = St.keyInfo(k); return letters.length > 1 ? (all ? `[${letters}]` : `(${letters})`) : letters; };
      const hasForm = graded.some((r) => r.student && r.student.form);
      const head = ["Last", "First", ...(hasForm ? ["Form"] : []), "Class", ...(hasV ? ["Version"] : []), "Score", "Possible", "Percent", ...qc.map((_, i) => "Q" + (i + 1))];
      const lines = [head];
      for (const r of graded) {
        lines.push([r.student ? r.student.last : "", r.student ? r.student.first : `Blank sheet #${r.scan.sheetCode}`, ...(hasForm ? [(r.student && r.student.form) || ""] : []), r.cls ? r.cls.name : "",
          ...(hasV ? [r.g.version + (r.g.versionInferred ? "?" : "")] : []),
          fmtPts(r.g.score), fmtPts(r.g.possible), (Math.round(r.g.pct * 10) / 10).toString(), ...r.g.items.map((it) => (it ? it.resp : ""))]);
      }
      lines.push(["", "KEY", ...(hasForm ? [""] : []), "", ...(hasV ? ["A"] : []), "", "", "", ...fk.map(quick)]);
      const csv = lines.map((l) => l.map((v) => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\n");
      download(`${safeFileName(t.title)} results.csv`, csv, "text/csv");
    };
  }

  /* ---------------- review / override modal ---------------- */

  function closeModal() {
    const m = $("#modal");
    if (m._url) { URL.revokeObjectURL(m._url); m._url = null; }
    m.classList.add("hidden");
    m.innerHTML = "";
    document.body.classList.remove("modal-open");
  }

  async function openReview(scanId, onDone) {
    const scan = St.db.scans.find((s) => s.id === scanId);
    if (!scan) return;
    const t = St.getTest(scan.testId);
    const m = $("#modal");
    m.classList.remove("hidden");
    document.body.classList.add("modal-open");
    const blob = await St.getImage(scan.id);
    if (m._url) URL.revokeObjectURL(m._url);
    m._url = blob ? URL.createObjectURL(blob) : null;
    const lay = L.computeLayout(t);
    const vlabels = L.versionLabels(t);
    const hasV = vlabels.length > 1;
    const done = () => { closeModal(); if (onDone) onDone(); };
    const FLAG_TEXT = { multiple: "two bubbles filled", erasure: "possible erasure", faint: "very light mark", unclear: "hard to read", blank: "left blank" };

    const render = () => {
      const g = St.grade(t, scan);
      const f = scan.studentId ? St.findStudent(scan.studentId) : null;
      const ov = scan.overrides || (scan.overrides = {});
      let overlay = lay.questions.map((q) => {
        const it = g.byPos[q.index] || { resp: "", key: "" };
        const ki = St.keyInfo(it.key);
        const [dx, dy] = (scan.offsets && scan.offsets[q.index]) || [0, 0];
        const flag = St.shownFlag(scan, g, q.index);
        let s = flag ? `<rect x="${q.x + dx - 1}" y="${q.cy + dy - 3.3}" width="${q.bubbles[q.bubbles.length - 1].cx - q.x + 4.5}" height="6.6" rx="1.2" fill="#f5a623" opacity="0.28"/>` : "";
        for (const b of q.bubbles) {
          const picked = it.resp.includes(b.label), isKey = ki.letters.includes(b.label);
          if (picked) s += `<circle cx="${b.cx + dx}" cy="${b.cy + dy}" r="${L.BUBBLE_R + 0.7}" fill="none" stroke="${it.correct ? "#1a9b54" : it.key ? "#d93025" : "#2457c5"}" stroke-width="0.7"/>`;
          else if (isKey && !it.correct) s += `<circle cx="${b.cx + dx}" cy="${b.cy + dy}" r="${L.BUBBLE_R + 0.7}" fill="none" stroke="#1a9b54" stroke-width="0.5" stroke-dasharray="1 0.8"/>`;
        }
        return `<g data-q="${q.index}">${s}</g>`;
      }).join("");
      if (lay.versionRow) {
        const v = lay.versionRow;
        const [dx, dy] = scan.versionOffset || [0, 0];
        if (g.versionInferred) overlay += `<rect x="${v.x + dx - 2}" y="${v.cy + dy - 4}" width="${v.width + 3}" height="8" rx="1.5" fill="#f5a623" opacity="0.3"/>`;
        for (const b of v.bubbles) if (b.label === g.version) overlay += `<circle cx="${b.cx + dx}" cy="${b.cy + dy}" r="${L.BUBBLE_R + 0.7}" fill="none" stroke="#2457c5" stroke-width="0.7" ${g.versionInferred ? 'stroke-dasharray="1 0.8"' : ""}/>`;
      }
      const readV = scan.version || "";
      m.innerHTML = `
        <div class="modal-box review">
          <div class="modal-head">
            <div>
              <h2>${f ? esc(St.studentName(f.student)) : `Blank sheet #${scan.sheetCode}`}</h2>
              <div class="muted small">${esc(t.title)} · scanned ${fmtTime(scan.scannedAt)}</div>
            </div>
            <div class="score-big">${fmtPts(g.score)}/${fmtPts(g.possible)} <span>${pct(g.pct)}</span></div>
            <button class="icon-btn" id="m-close" title="Close">✕</button>
          </div>
          ${hasV ? `<div class="ver-bar ${g.versionInferred ? "flag" : ""}">
            <strong>Version</strong>
            <span class="ov-btns">${vlabels.map((v) => `<button class="ob ${g.version === v ? "on" : ""}" data-ver="${v}">${v}</button>`).join("")}</span>
            <span class="small">${scan.versionOverride ? `set by you (sheet read “${esc(readV || "blank")}”) <a href="#" id="ver-undo">undo</a>`
              : g.versionInferred ? `<span class="warn-txt">${readV ? `two versions bubbled (${esc(readV)})` : "not bubbled"}; graded as ${g.version}, the best match. Click a letter to change it, or</span> <button class="btn tiny" id="ver-ok">✓ Confirm ${g.version}</button>`
              : `<span class="muted">as bubbled</span>`}</span>
          </div>` : ""}
          <div class="review-body">
            <div class="review-img">
              ${m._url ? `<div class="img-wrap"><img src="${m._url}" alt="Scanned sheet"/><svg viewBox="0 0 ${L.PAGE.w} ${L.PAGE.h}" class="img-overlay">${overlay}</svg></div>`
                : `<p class="muted">No image saved for this scan (images stay on the device that scanned them).</p>`}
              <p class="legend small"><span class="lg good"></span>correct <span class="lg bad"></span>wrong <span class="lg key"></span>correct answer <span class="lg flag"></span>check this</p>
            </div>
            <div class="review-list">
              ${(() => {
                const n = St.flagCount(scan, g);
                return n ? `<div class="check-bar"><span><strong>${n} to check</strong>, highlighted below. Compare with the scan, then fix the letter or click <em>✓ Looks right</em>.</span>
                  <button class="btn small" id="ok-all">✓ Confirm all as read</button></div>`
                  : Object.keys(scan.confirmed || {}).length || Object.keys(ov).length ? `<div class="check-bar done">✓ Everything has been checked.</div>` : "";
              })()}
              <p class="muted small">Click letters to correct what the scanner read (shift-click to mark more than one).${hasV && g.version !== "A" ? ` Numbers are as printed on Version ${g.version}; “= A12” shows the matching Version A question.` : ""}</p>
              ${lay.questions.map((q) => {
                const i = q.index, it = g.byPos[i] || {};
                const ki = St.keyInfo(it.key);
                const flag = St.shownFlag(scan, g, i);
                const edited = ov[i] != null;
                return `<div class="ov-row ${flag ? "flag" : ""}" data-i="${i}">
                  <span class="qn">${i + 1}</span>
                  <span class="ov-btns"><button class="ob ${!it.resp ? "on" : ""}" data-c="" title="blank">–</button>${q.bubbles.map((b) => `<button class="ob ${it.resp && it.resp.includes(b.label) ? "on" : ""} ${ki.letters.includes(b.label) ? "is-key" : ""}" data-c="${esc(b.label)}">${esc(b.label)}</button>`).join("")}</span>
                  <span class="ov-mark">${it.correct === true ? "✓" : it.correct === false ? "✗" : ""}</span>
                  ${hasV && g.version !== "A" ? `<span class="muted small">= A${it.q + 1}</span>` : ""}
                  ${ki.letters.length > 1 ? `<span class="muted small">key ${esc(St.keyText(it.key))}${ki.all ? " (all)" : ""}</span>` : ""}
                  <span class="ov-note small">${edited ? `edited (read “${esc(scan.responses[i] || "blank")}”) <a href="#" data-undo="${i}">undo</a>`
                    : flag ? `${esc(FLAG_TEXT[flag] || flag)} <button class="btn tiny" data-ok="${i}" title="The scanner read this correctly">✓ Looks right</button>`
                    : scan.confirmed && scan.confirmed[i] ? `<span class="good-txt">checked ✓</span> <a href="#" data-unok="${i}">undo</a>` : ""}</span>
                </div>`;
              }).join("")}
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn danger ghost" id="m-del">Delete this scan</button>
            <div class="spacer"></div>
            <button class="btn primary" id="m-done">Done</button>
          </div>
        </div>`;
      const touch = () => { scan.updatedAt = St.now(); St.save(); render(); };
      $("#m-close").onclick = done;
      $("#m-done").onclick = done;
      $("#m-del").onclick = () => { if (confirm("Delete this scanned sheet?")) { St.deleteScan(scan); done(); } };
      $$("[data-ver]", m).forEach((b) => (b.onclick = () => {
        scan.versionOverride = b.dataset.ver === readV ? null : b.dataset.ver;
        touch();
      }));
      const vu = $("#ver-undo");
      if (vu) vu.onclick = (e) => { e.preventDefault(); scan.versionOverride = null; touch(); };
      const vok = $("#ver-ok");
      if (vok) vok.onclick = () => { scan.versionOverride = g.version; touch(); };
      const okAll = $("#ok-all");
      if (okAll) okAll.onclick = () => {
        scan.confirmed = scan.confirmed || {};
        for (let i = 0; i < scan.flags.length; i++) if (St.shownFlag(scan, g, i)) scan.confirmed[i] = true;
        if (g.versionInferred) scan.versionOverride = g.version;
        touch();
      };
      $$(".ov-row").forEach((row) => {
        const i = +row.dataset.i;
        $$(".ob[data-c]", row).forEach((b) => (b.onclick = (e) => {
          const c = b.dataset.c;
          const cur = St.effectiveResponse(scan, i);
          let next;
          if (!c) next = "";
          else if (e.shiftKey || e.metaKey || e.ctrlKey) next = (cur.includes(c) ? cur.replace(c, "") : cur + c).split("").sort().join("");
          else next = cur === c ? "" : c;
          if (next === (scan.responses[i] || "")) delete ov[i]; else ov[i] = next;
          touch();
        }));
        const u = $("[data-undo]", row);
        if (u) u.onclick = (e) => { e.preventDefault(); delete ov[i]; touch(); };
        const ok = $("[data-ok]", row);
        if (ok) ok.onclick = () => { (scan.confirmed = scan.confirmed || {})[i] = true; touch(); };
        const unok = $("[data-unok]", row);
        if (unok) unok.onclick = (e) => { e.preventDefault(); delete scan.confirmed[i]; touch(); };
      });
    };
    render();
    m.onclick = (e) => { if (e.target === m) done(); };
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) $("#m-done") ? $("#m-done").click() : closeModal(); });

  /* ================================================================
   * CLASSES
   * ================================================================ */

  function viewClasses(selId) {
    const classes = St.db.classes;
    const cls = St.getClass(selId) || classes[0];
    main.innerHTML = `
      <div class="page-head"><h1>Classes</h1><button class="btn primary" id="c-new">+ New class</button></div>
      ${classes.length === 0 ? `<div class="card"><p>Add a class, then paste in its roster: one student per line.</p></div>` : `
      <div class="classes-grid">
        <nav class="class-list card">
          ${classes.map((c) => `<a href="#/classes/${c.id}" class="${cls && c.id === cls.id ? "active" : ""}">${esc(c.name)} <span class="muted">${c.students.length}</span></a>`).join("")}
        </nav>
        <section class="card" id="class-editor"></section>
      </div>`}`;
    $("#c-new").onclick = () => {
      const name = prompt("Class name (e.g. “Algebra II – Period 3”)");
      if (!name) return;
      const c = St.addClass(name.trim());
      location.hash = `#/classes/${c.id}`;
    };
    if (cls) renderClassEditor(cls);
  }

  function renderClassEditor(cls) {
    const el = $("#class-editor");
    const students = St.sortedStudents(cls);
    el.innerHTML = `
      <div class="form-row"><label class="grow">Class name <input id="c-name" value="${esc(cls.name)}"/></label></div>
      <h2>Roster <span class="muted small">(${students.length})</span></h2>
      ${students.length ? `<div class="table-wrap"><table class="table roster">
        <thead><tr><th>First</th><th>Last</th><th class="form-col">Form <span class="muted">(optional)</span></th><th></th></tr></thead>
        <tbody>${students.map((s) => `<tr data-sid="${s.id}"><td><input class="s-first" value="${esc(s.first)}"/></td><td><input class="s-last" value="${esc(s.last)}"/></td><td class="form-col"><input class="s-form" value="${esc(s.form || "")}" placeholder="–"/></td><td><button class="icon-btn danger" data-rm title="Remove">✕</button></td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted">No students yet.</p>`}
      <div class="import-box" id="c-import">
        <h3>Add students</h3>
        <p class="muted small">Either paste a screenshot of your roster, drag and drop an image file on this box, or paste text:
          one student per line (<code>Last, First</code> or <code>First Last</code>) or rows copied from a spreadsheet.
          Adding a Form or grade in parentheses is optional. You can double-check the roster before the names are added.</p>
        <div class="btn-row">
          <label class="btn" for="c-img">Choose a screenshot…</label>
          <input type="file" id="c-img" accept="image/*" class="visually-hidden" />
        </div>
        <textarea id="c-paste" rows="4" placeholder="Garcia, Maria (IV)&#10;Chen, David (V)&#10;Sam Okafor"></textarea>
        <div id="c-status" class="small"></div>
        <div id="c-preview"></div>
      </div>
      <div class="danger-zone"><button class="btn ghost danger small" id="c-del">Delete class</button></div>`;
    $("#c-name").oninput = (e) => { cls.name = e.target.value; cls.updatedAt = St.now(); saveSoon(); const a = $(`.class-list a.active`); if (a) a.firstChild.textContent = cls.name + " "; };
    $$("tr[data-sid]", el).forEach((tr) => {
      const s = cls.students.find((x) => x.id === tr.dataset.sid);
      $(".s-first", tr).oninput = (e) => { s.first = e.target.value.trim(); cls.updatedAt = St.now(); saveSoon(); };
      $(".s-last", tr).oninput = (e) => { s.last = e.target.value.trim(); cls.updatedAt = St.now(); saveSoon(); };
      $(".s-form", tr).oninput = (e) => { s.form = e.target.value.trim(); cls.updatedAt = St.now(); saveSoon(); };
      $("[data-rm]", tr).onclick = () => {
        if (!confirm(`Remove ${St.studentName(s)} from ${cls.name}? Their scanned results stay in your tests.`)) return;
        cls.students = cls.students.filter((x) => x !== s); cls.updatedAt = St.now(); St.save(); viewClasses(cls.id);
      };
    });

    // ---- import: text or screenshot → preview → add ----
    let rows = [];
    const key = (f, l) => `${f} ${l}`.toLowerCase().replace(/\s+/g, " ").trim();
    const existing = new Set(cls.students.map((s) => key(s.first, s.last)));
    const status = (html, kind) => { $("#c-status").innerHTML = html; $("#c-status").className = "small " + (kind || ""); };
    const setRows = (list, fromImage) => {
      const seen = new Set();
      rows = list.map((p) => {
        const k = key(p.first, p.last);
        const dup = existing.has(k) || seen.has(k);
        seen.add(k);
        return { first: p.first, last: p.last, form: p.form || "", include: !dup, dup };
      });
      renderPreview(fromImage);
    };
    const renderPreview = (fromImage) => {
      const box = $("#c-preview");
      if (!rows.length) { box.innerHTML = ""; return; }
      const n = rows.filter((r) => r.include && (r.first || r.last)).length;
      box.innerHTML = `
        <p class="small ${fromImage ? "warn-txt" : "muted"}">${fromImage ? "Check the names against your roster: text recognition can misread letters or drop accents (e.g. Román → Roman)." : "Check the names, then add them."} Uncheck anyone you don't want; click a name to fix it.</p>
        <div class="table-wrap"><table class="table roster import-preview">
          <thead><tr><th><input type="checkbox" id="imp-all" ${rows.every((r) => r.include) ? "checked" : ""} title="All"/></th><th>First</th><th>Last</th><th class="form-col">Form</th><th></th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${r.dup ? "dup" : ""}">
            <td><input type="checkbox" data-inc ${r.include ? "checked" : ""}/></td>
            <td><input data-f="first" value="${esc(r.first)}"/></td>
            <td><input data-f="last" value="${esc(r.last)}"/></td>
            <td class="form-col"><input data-f="form" value="${esc(r.form)}" placeholder="–"/></td>
            <td class="muted small">${r.dup ? "already in class" : ""}</td></tr>`).join("")}</tbody>
        </table></div>
        <div class="btn-row">
          <button class="btn primary" id="imp-add" ${n ? "" : "disabled"}>Add ${n} student${n === 1 ? "" : "s"}</button>
          <button class="btn" id="imp-swap" title="If first and last names came out reversed">Swap first ↔ last</button>
          <button class="btn ghost" id="imp-clear">Clear</button>
        </div>`;
      $$("tr[data-i]", box).forEach((tr) => {
        const r = rows[+tr.dataset.i];
        $("[data-inc]", tr).onchange = (e) => { r.include = e.target.checked; renderPreview(fromImage); };
        $$("[data-f]", tr).forEach((inp) => (inp.oninput = () => { r[inp.dataset.f] = inp.value.trim(); }));
      });
      $("#imp-all").onchange = (e) => { rows.forEach((r) => (r.include = e.target.checked)); renderPreview(fromImage); };
      $("#imp-swap").onclick = () => { rows.forEach((r) => ([r.first, r.last] = [r.last, r.first])); renderPreview(fromImage); };
      $("#imp-clear").onclick = () => { rows = []; $("#c-paste").value = ""; status(""); renderPreview(); };
      $("#imp-add").onclick = () => {
        const add = rows.filter((r) => r.include && (r.first || r.last));
        for (const r of add) cls.students.push({ id: St.uid(), first: r.first, last: r.last, ...(r.form ? { form: r.form } : {}) });
        cls.updatedAt = St.now(); St.save();
        toast(`Added ${add.length} student${add.length === 1 ? "" : "s"}.`);
        viewClasses(cls.id);
      };
    };
    let parseTimer;
    $("#c-paste").oninput = () => {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(() => setRows(St.parseRoster($("#c-paste").value)), 250);
    };
    const readImage = async (file) => {
      if (!file || !/^image\//.test(file.type)) return;
      if (!window.MGOcr) { status("Text recognition isn't available here.", "bad-txt"); return; }
      status(`<span class="spinner"></span> Loading text recognition (first time only)…`);
      try {
        const text = await MGOcr.readText(file, (label, frac) => status(`<span class="spinner"></span> ${esc(label)} ${frac ? Math.round(frac * 100) + "%" : ""}`));
        const list = St.parseRoster(text);
        $("#c-paste").value = text.replace(/\n{2,}/g, "\n").trim();
        if (!list.length) { status("No names found in that image. Try a sharper or larger screenshot, or paste the names as text.", "warn-txt"); setRows([]); return; }
        status(`Found ${list.length} name${list.length === 1 ? "" : "s"} in the screenshot.`, "good-txt");
        setRows(list, true);
      } catch (e) {
        console.error(e);
        status("Couldn't read that image: " + esc(e.message || String(e)), "bad-txt");
      }
    };
    $("#c-img").onchange = (e) => { readImage(e.target.files[0]); e.target.value = ""; };
    const box = $("#c-import");
    box.ondragover = (e) => { e.preventDefault(); box.classList.add("drag"); };
    box.ondragleave = () => box.classList.remove("drag");
    box.ondrop = (e) => { e.preventDefault(); box.classList.remove("drag"); readImage([...e.dataTransfer.files].find((f) => /^image\//.test(f.type))); };
    classPasteHandler = (e) => {
      const img = [...(e.clipboardData && e.clipboardData.files || [])].find((f) => /^image\//.test(f.type));
      if (img) { e.preventDefault(); readImage(img); }
    };

    $("#c-del").onclick = () => {
      if (!confirm(`Delete the class "${cls.name}"? Tests and scanned results are kept.`)) return;
      St.db.classes = St.db.classes.filter((c) => c !== cls);
      for (const t of St.db.tests) t.classIds = t.classIds.filter((id) => id !== cls.id);
      St.save(); location.hash = "#/classes";
    };
  }

  // A screenshot pasted anywhere on a class page goes to the roster import.
  let classPasteHandler = null;
  document.addEventListener("paste", (e) => {
    if (classPasteHandler && $("#c-import")) classPasteHandler(e);
  });

  /* ================================================================
   * SCAN
   * ================================================================ */

  const cam = { stream: null, running: false, timer: null, lastSig: null, committed: null, lastSeen: 0, audio: null, busy: false };
  const session = []; // scans made since the page was opened

  function viewScan() {
    const secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    main.innerHTML = `
      <div class="page-head"><h1>Scan</h1></div>
      <div class="scan-grid">
        <section class="card scan-cam">
          <div class="scan-controls">
            <button class="btn primary" id="cam-start" ${secure ? "" : "disabled"}>Start camera</button>
            <button class="btn hidden" id="cam-stop">Stop</button>
            <select id="cam-select" class="hidden"></select>
            <div class="spacer"></div>
            <label class="btn" for="photo-in">Scan photos…</label>
            <input type="file" id="photo-in" accept="image/*" multiple class="visually-hidden" />
          </div>
          ${secure ? "" : `<div class="notice">The camera needs the app to be opened over https (e.g. the GitHub Pages link). You can still scan photos.</div>`}
          <div class="video-wrap hidden" id="video-wrap">
            <video id="video" playsinline muted></video>
            <canvas id="overlay"></canvas>
            <div id="flash" class="flash"></div>
          </div>
          <div id="scan-status" class="scan-status">Any sheet from any of your tests can be scanned here, in any order; each sheet's code tells MultiGrader which test and student it is.</div>
          <details class="help">
            <summary>Tips for clean scans</summary>
            <ul>
              <li>Lay the sheet flat on a darker surface with even light; avoid strong shadows across the bubbles.</li>
              <li>All four corner squares must be in view. Sideways or upside-down is fine.</li>
              <li>Hold still for a moment; the sheet is recorded when two frames agree, then you'll hear a beep.</li>
              <li>Phone: open this page in the browser and tap <em>Start camera</em> (uses the back camera). Or take photos with the camera app and use <em>Scan photos…</em> to grade a whole stack at once.</li>
              <li>Scanning a sheet again replaces its earlier result.</li>
            </ul>
          </details>
        </section>
        <section class="card scan-log">
          <h2>Scanned this session</h2>
          <div id="scan-list"></div>
        </section>
      </div>`;
    $("#cam-start").onclick = () => startCamera();
    $("#cam-stop").onclick = () => { stopCamera(); viewScanControls(false); };
    $("#cam-select").onchange = (e) => startCamera(e.target.value);
    $("#photo-in").onchange = (e) => scanFiles([...e.target.files]).then(() => (e.target.value = ""));
    renderSessionList();
  }

  function viewScanControls(on) {
    const s = $("#cam-start"), x = $("#cam-stop"), w = $("#video-wrap");
    if (!s) return;
    s.classList.toggle("hidden", on); x.classList.toggle("hidden", !on); w.classList.toggle("hidden", !on);
    $("#cam-select").classList.toggle("hidden", !on || $("#cam-select").options.length < 2);
  }

  function setStatus(html, kind) {
    const el = $("#scan-status");
    if (el) { el.innerHTML = html; el.className = "scan-status " + (kind || ""); }
  }

  async function startCamera(deviceId) {
    stopCamera();
    try {
      if (!cam.audio) { try { cam.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } }
      if (cam.audio && cam.audio.state === "suspended") cam.audio.resume();
      const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
      Object.assign(video, { width: { ideal: 1920 }, height: { ideal: 1080 } });
      cam.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const v = $("#video");
      if (!v) { stopCamera(); return; }
      // Show the video before playing: Safari may not deliver frames from a
      // video that's hidden when it starts.
      viewScanControls(true);
      v.muted = true;
      v.setAttribute("playsinline", "");
      v.srcObject = cam.stream;
      await v.play();
      // Wait until the first frame's size is known.
      for (let i = 0; i < 50 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const cur = cam.stream.getVideoTracks()[0].getSettings().deviceId;
      $("#cam-select").innerHTML = devs.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === cur ? "selected" : ""}>${esc(d.label || "Camera " + (i + 1))}</option>`).join("");
      viewScanControls(true);
      if (v.videoWidth) $("#video-wrap").style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
      cam.res = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "";
      cam.running = true;
      cam.lastSig = null; cam.committed = null;
      setStatus("Looking for a sheet…");
      loop();
    } catch (e) {
      setStatus(`Couldn't start the camera: ${esc(e.message || e.name)}. Check the browser's camera permission.`, "bad");
    }
  }

  function stopCamera() {
    cam.running = false;
    clearTimeout(cam.timer);
    if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
  }

  const work = document.createElement("canvas");
  const wctx = work.getContext("2d", { willReadFrequently: true });

  function loop() {
    if (!cam.running) return;
    const v = $("#video");
    if (!v) { stopCamera(); return; }
    if (v.readyState >= 2 && v.videoWidth && !cam.busy) {
      cam.busy = true;
      try { processFrame(v); } catch (e) { console.error(e); }
      cam.busy = false;
    }
    cam.timer = setTimeout(loop, 90);
  }

  function processFrame(v) {
    const w = v.videoWidth, h = v.videoHeight;
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    wctx.drawImage(v, 0, 0, w, h);
    const data = wctx.getImageData(0, 0, w, h);
    const res = S.scan(data, { getTest: St.testByCode });
    drawOverlay(res, w, h);
    const nowMs = Date.now();
    if (res.status === "ok") {
      const key = res.test.id + ":" + res.sheetCode;
      cam.lastSeen = nowMs;
      if (cam.committed === key) { return; }
      const sig = key + "|" + res.version + "|" + res.responses.join(",");
      if (cam.lastSig === sig) {
        cam.committed = key;
        cam.lastSig = null;
        commitScan(data, "camera");
      } else {
        cam.lastSig = sig;
        setStatus("Reading… hold steady");
      }
      return;
    }
    cam.lastSig = null;
    if (nowMs - cam.lastSeen > 1200) cam.committed = null;
    if (cam.committed) return; // keep the last result on screen until the sheet is removed
    if (res.status === "unknown-test") setStatus(`This sheet is for a test that isn't on this device (test ${res.testCode}). Import it from <a href="#/data">Data</a>.`, "warn");
    else if (res.status === "no-code") setStatus("Sheet found. Hold it flat, steady and fully in view…");
    else if (res.status === "layout-error") setStatus("This test's format can't be laid out on a sheet.", "bad");
    else {
      // Say how many corner squares it can see, so it's clear what to adjust.
      const n = Math.min(4, (res.markers || []).length);
      setStatus(`Looking for a sheet… <span class="muted small">corner squares seen: ${n} of 4${cam.res ? ` · camera ${cam.res}` : ""}</span><br><span class="muted small">${n === 0
        ? "Hold the sheet so it fills most of the picture, with even light (no glare)."
        : "Make sure all four corner squares are in the picture, then hold it still."}</span>`);
    }
  }

  function drawOverlay(res, w, h) {
    const c = $("#overlay");
    if (!c) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const lw = Math.max(2, w / 400);
    ctx.lineWidth = lw;
    for (const m of res.markers || []) {
      ctx.strokeStyle = "rgba(255,170,0,.9)";
      ctx.beginPath(); ctx.arc(m.x, m.y, m.size * 0.7, 0, Math.PI * 2); ctx.stroke();
    }
    if (res.corners) {
      ctx.strokeStyle = res.status === "ok" ? "rgba(26,155,84,.95)" : "rgba(255,170,0,.9)";
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      res.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath(); ctx.stroke();
    }
    if (res.status === "ok") {
      const lay = L.computeLayout(res.test);
      ctx.fillStyle = "rgba(36,87,197,.8)";
      if (lay.versionRow && res.version) {
        const [dx, dy] = res.versionOffset;
        for (const b of lay.versionRow.bubbles) {
          if (!res.version.includes(b.label)) continue;
          const [x, y] = S.project(res.H, b.cx + dx, b.cy + dy);
          ctx.beginPath(); ctx.arc(x, y, lw * 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
      for (const q of lay.questions) {
        const [dx, dy] = res.offsets[q.index];
        for (const b of q.bubbles) {
          if (!res.responses[q.index].includes(b.label)) continue;
          const [x, y] = S.project(res.H, b.cx + dx, b.cy + dy);
          ctx.beginPath(); ctx.arc(x, y, lw * 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  function beep(ok) {
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [40, 60, 40]);
    const a = cam.audio;
    if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.frequency.value = ok ? 880 : 330;
    g.gain.setValueAtTime(0.15, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.18);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.2);
  }

  /* Full-quality read of an accepted frame or photo, then save it. */
  async function commitScan(data, source, fileName) {
    const res = S.scan(data, { getTest: St.testByCode, rectifyWidth: 850 });
    if (res.status !== "ok") {
      return { ok: false, msg: { "unknown-test": `sheet for a test that isn't on this device (test ${res.testCode})`, "no-code": "found the sheet but couldn't read its code strip", "layout-error": "this test's format can't be laid out" }[res.status] || "no answer sheet found" };
    }
    const t = res.test;
    if (res.sheetCode === L.SHEET_KEY) {
      const labels = L.versionLabels(t);
      const v = labels.length > 1 && labels.includes(res.version) ? res.version : "A";
      const vk = St.versionKey(t, v);
      const diffs = vk.map((k, i) => (St.keyInfo(k).letters !== res.responses[i].split("").sort().join("") ? i + 1 : null)).filter(Boolean);
      const name = labels.length > 1 ? `Version ${v} answer key sheet` : "Answer key sheet";
      const msg = diffs.length ? `${name}: differs from the saved key on Q${diffs.join(", Q")}` : `${name} matches your saved key ✓`;
      if (source === "camera") { setStatus(msg, diffs.length ? "warn" : "good"); beep(!diffs.length); flash(!diffs.length); }
      return { ok: true, msg, keyCheck: true };
    }
    const { scan, replaced } = St.saveScan(t, res);
    if (res.rectified) grayToBlob(res.rectified).then((b) => b && St.putImage(scan.id, b));
    const g = St.grade(t, scan);
    const f = scan.studentId ? St.findStudent(scan.studentId) : null;
    const who = f ? St.studentName(f.student) : `Blank sheet #${scan.sheetCode}`;
    const nflag = St.flagCount(scan, g);
    const ver = L.versionLabels(t).length > 1 ? ` · version ${g.version}${g.versionInferred ? "?" : ""}` : "";
    const entry = { scanId: scan.id, who, test: t.title + ver, g, nflag, replaced, at: Date.now(), source: fileName || source };
    session.unshift(entry);
    if (source === "camera") {
      setStatus(`<strong>✓ ${esc(who)}</strong> · ${esc(t.title + ver)} · ${fmtPts(g.score)}/${fmtPts(g.possible)} (${pct(g.pct)})${nflag ? ` · <span class="warn-txt">${nflag} to check</span>` : ""}${replaced ? " · replaced earlier scan" : ""}<br><span class="muted small">Next sheet…</span>`, "good");
      beep(true); flash(true);
    }
    renderSessionList();
    return { ok: true, entry };
  }

  function flash(ok) {
    const f = $("#flash");
    if (!f) return;
    f.className = "flash " + (ok ? "ok" : "warn");
    setTimeout(() => (f.className = "flash"), 350);
  }

  async function scanFiles(files) {
    if (!files.length) return;
    let okN = 0;
    const fails = [];
    for (let i = 0; i < files.length; i++) {
      setStatus(`Scanning photo ${i + 1} of ${files.length}…`);
      await new Promise((r) => setTimeout(r, 0));
      try {
        const bmp = await createImageBitmap(files[i]);
        const k = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
        work.width = w; work.height = h;
        wctx.drawImage(bmp, 0, 0, w, h);
        const r = await commitScan(wctx.getImageData(0, 0, w, h), "photo", files[i].name);
        if (r.ok) { okN++; if (r.keyCheck) fails.push(`${files[i].name}: ${r.msg}`); } else fails.push(`${files[i].name}: ${r.msg}`);
      } catch (e) {
        fails.push(`${files[i].name}: couldn't open this image (${e.message || e.name})`);
      }
    }
    setStatus(`Scanned ${okN} of ${files.length} photo${files.length > 1 ? "s" : ""}.` + (fails.length ? `<ul class="small">${fails.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""), fails.length ? "warn" : "good");
  }

  function renderSessionList() {
    const el = $("#scan-list");
    if (!el) return;
    el.innerHTML = session.length ? `<ul class="scan-items">${session.map((e) => `
      <li><button class="linkish" data-review="${e.scanId}"><strong>${esc(e.who)}</strong></button>
        <span class="muted small">${esc(e.test)}</span>
        <span class="score">${fmtPts(e.g.score)}/${fmtPts(e.g.possible)} · ${pct(e.g.pct)}</span>
        ${e.nflag ? `<span class="pill warn">${e.nflag} to check</span>` : ""}${e.replaced ? `<span class="pill">rescanned</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="muted">Sheets you scan appear here. Click one to review it or fix a misread bubble.</p>`;
    $$("[data-review]", el).forEach((b) => (b.onclick = () => {
      const wasRunning = cam.running;
      if (!St.db.scans.some((x) => x.id === b.dataset.review)) return;
      cam.running = false;
      openReview(b.dataset.review, () => {
        const e = session.find((x) => x.scanId === b.dataset.review);
        const scan = St.db.scans.find((s) => s.id === b.dataset.review);
        if (e && scan) { e.g = St.grade(St.getTest(scan.testId), scan); e.nflag = St.flagCount(scan, e.g); }
        if (e && !scan) session.splice(session.indexOf(e), 1);
        renderSessionList();
        if (wasRunning && cam.stream) { cam.running = true; loop(); }
      });
    }));
  }

  /* ================================================================
   * DATA (backup / move between devices)
   * ================================================================ */

  function viewData() {
    const d = St.db;
    const size = new Blob([localStorage.getItem("multigrader.db.v1") || ""]).size;
    main.innerHTML = `
      <div class="page-head"><h1>Data</h1></div>
      <section class="card">
        <h2>Where your data lives</h2>
        <p>Everything (classes, tests, keys, and results) is stored <strong>only in this browser on this device</strong>. Nothing is uploaded anywhere.
          You have ${d.classes.length} class${d.classes.length === 1 ? "" : "es"}, ${d.tests.length} test${d.tests.length === 1 ? "" : "s"}, and ${d.scans.length} scanned sheet${d.scans.length === 1 ? "" : "s"} (${(size / 1024).toFixed(0)} KB).</p>
      </section>
      <section class="card">
        <h2>Back up or move to another device</h2>
        <p class="muted">Use this to scan on your phone with tests made on your laptop: export here, send the file to your phone (AirDrop, email, Drive), and import it there. After scanning, export from the phone and import back on the laptop. Imports <strong>merge</strong>: newer edits win, and nothing on this device is deleted.</p>
        <div class="btn-row">
          <button class="btn primary" id="d-export">Export backup</button>
          <label class="btn" for="d-import">Import / merge…</label>
          <input type="file" id="d-import" accept=".json,application/json" class="visually-hidden"/>
        </div>
        <p class="muted small">Backups contain student names and scores; treat the file like a gradebook. Scanned-sheet images aren't included.</p>
      </section>
      <section class="card">
        <h2>Start over</h2>
        <button class="btn danger ghost" id="d-erase">Erase everything on this device…</button>
      </section>`;
    $("#d-export").onclick = () => download(`multigrader-backup-${St.today()}.json`, St.exportJSON(), "application/json");
    $("#d-import").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const c = St.importJSON(await f.text());
        toast(`Imported: ${c.classes} class(es), ${c.tests} test(s), ${c.scans} scan(s) added or updated.`, "good");
        viewData();
      } catch (err) { alert("Import failed: " + err.message); }
      e.target.value = "";
    };
    $("#d-erase").onclick = () => {
      if (prompt('This deletes all classes, tests and results on this device. Type ERASE to confirm.') === "ERASE") { St.eraseAll(); toast("All data erased."); viewData(); }
    };
  }

  route();
})();
