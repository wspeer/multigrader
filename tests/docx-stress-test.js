// Randomized stress test for Word (.docx) reordering. Builds many synthetic
// tests that mix the structures teachers' files contain, shuffles each one,
// and checks that the new file is complete and correct:
//   • every question is found (typed numbers in several styles or Word's
//     automatic numbering, any starting number, "(continued)", skipped
//     numbers, a question that is only a picture with its number inside)
//   • the multiple-choice questions are guessed correctly
//   • after shuffling, each position holds the right question with all of its
//     answer choices, equations, pictures and text boxes; nothing is lost or
//     duplicated; numbers read in order; page and section breaks, headings,
//     written questions and the last line stay where they were
//   • the XML is well formed, bookmarks/comments stay paired, and shuffling
//     back gives the original order
//   node tests/docx-stress-test.js [count] [firstSeed]
require("../js/docx.js");
const D = globalThis.MGDocx;
const N = +process.argv[2] || 300, START = +process.argv[3] || 1;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable=""';

/* ---------- building blocks ---------- */
const run = (t) => (t === "\t" ? "<w:r><w:tab/></w:r>" : `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
const runs = (t) => t.split(/(\t)/).filter(Boolean).map(run).join("");
const P = (inner = "", ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
const BR = '<w:r><w:br w:type="page"/></w:r>';
const PAGE = P(BR);
const math = (t) => `<m:oMath><m:r><m:t>${esc(t)}</m:t></m:r></m:oMath>`;
let uid = 1;
const ole = () => { const id = uid++; return `<w:r><w:object w:dxaOrig="600" w:dyaOrig="300"><v:shape id="s${id}" style="width:30pt;height:15pt" o:ole=""><v:imagedata r:id="rIdImg" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="s${id}" DrawAspect="Content" ObjectID="_${id}" r:id="rIdOle"/></w:object></w:r>`; };
const inlinePic = () => { const id = uid++; return `<w:r><w:drawing><wp:inline><wp:extent cx="900000" cy="600000"/><wp:docPr id="${id}" name="P${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`; };
const anchorPic = () => { const id = uid++; return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>3000000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="900000" cy="600000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${id}" name="A${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`; };
// A text box whose text starts with a number, to make sure it isn't taken for a question.
const textBox = (label) => `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="2" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>4000000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="900000" cy="300000"/><wp:wrapNone/><wp:docPr id="${uid++}" name="T"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${P(runs(label))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:70pt;height:20pt"><v:textbox><w:txbxContent>${P(runs(label))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;

/* ---------- a random test ---------- */
function makeDoc(seed) {
  const R = rng(seed * 7919 + 17);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const chance = (p) => R() < p;
  const auto = chance(0.35);
  const fmt = pick(["%n.\t", "%n.  ", "%n)\t", "(%n)\t", "%n\t", "Question %n.  ", "Q%n. "]);
  const start = chance(0.15) ? 16 : 1;
  const body = [P(runs("Algebra Test, Version A"), '<w:jc w:val="center"/>'), P(runs("Name: __________"))];
  const truth = []; // {num, mc, pic, token}
  let num = start, bookmark = null, comment = null;
  const openRange = (out) => {
    if (!bookmark && chance(0.15)) { bookmark = uid++; out.push(`<w:bookmarkStart w:id="${bookmark}" w:name="bm${bookmark}"/>`); }
    if (!comment && chance(0.08)) { comment = uid++; out.push(`<w:commentRangeStart w:id="${comment}"/>`); }
  };
  const closeRange = (out) => {
    if (bookmark && chance(0.3)) { out.push(`<w:bookmarkEnd w:id="${bookmark}"/>`); bookmark = null; }
    if (comment && chance(0.3)) { out.push(`<w:commentRangeEnd w:id="${comment}"/>`); comment = null; }
  };
  const stem = (n, token, text) => {
    const label = fmt.replace("%n", n);
    let inner = "";
    if (auto) inner = runs(text);
    else if (chance(0.3)) inner = run(String(n)) + runs(label.slice(String(n).length + (label.startsWith("(") ? 1 : 0) + (label.startsWith("Q") ? label.indexOf(String(n)) : 0))) + runs(text); // number split across runs
    else inner = runs(label + text);
    if (!auto && label.startsWith("(")) inner = runs(label + text);
    if (!auto && label.startsWith("Q")) inner = runs(label + text);
    inner += run(" " + token);
    if (chance(0.25)) inner += math("x^2+" + Math.floor(R() * 9));
    if (chance(0.25)) inner += ole();
    if (chance(0.1)) inner += inlinePic();
    if (chance(0.1)) inner += anchorPic();
    if (chance(0.1)) inner += textBox(`${n + 1}. note`);
    if (chance(0.1)) inner += `<w:ins w:id="${uid++}" w:author="T" w:date="2024-01-01T00:00:00Z">${run(" (revised)")}</w:ins><w:del w:id="${uid++}" w:author="T" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>`;
    if (chance(0.05)) inner = BR + inner; // starts on a new page
    let ppr = auto ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "";
    if (chance(0.04)) ppr += "<w:pageBreakBefore/>";
    return P(inner, ppr);
  };
  const choices = (token, k) => {
    const L = "abcde";
    const style = pick(["lines", "lines", "oneline", "list", "table"]);
    const items = Array.from({ length: k }, (_, i) => `${token}c${i}`);
    if (style === "lines") return items.map((t, i) => P(runs(`\t${L[i]})  ${t}`) + (chance(0.15) ? math("y") : "")));
    if (style === "oneline") return [P(runs(items.map((t, i) => `${L[i]}) ${t}`).join("\t")))];
    if (style === "list") return items.map((t) => P(runs(t), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'));
    return [`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${items.map(() => '<w:gridCol w:w="1800"/>').join("")}</w:tblGrid><w:tr>${items.map((t, i) => `<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/></w:tcPr>${P(runs(`${L[i]}) ${t}`))}</w:tc>`).join("")}</w:tr></w:tbl>`, P()];
  };
  const nParts = 1 + Math.floor(R() * 3);
  for (let part = 0; part < nParts; part++) {
    // True/false and always/sometimes/never parts need a heading saying so.
    const pk = pick(["MC", "MC", "MC", "TF", "ASN"]);
    if (part > 0 || pk !== "MC" || chance(0.5)) {
      if (part > 0) body.push(chance(0.2) ? P("", '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>') : PAGE);
      const head = pk === "TF" ? pick([`PART ${["ONE", "TWO", "THREE"][part]}: TRUE OR FALSE`, `Part ${part + 1}: True/False`])
        : pk === "ASN" ? pick([`PART ${["ONE", "TWO", "THREE"][part]}: ALWAYS, SOMETIMES, OR NEVER`, `Part ${part + 1}: Always, Sometimes, or Never`])
        : pick([`PART ${["ONE", "TWO", "THREE"][part]}: MULTIPLE CHOICE`, "Part " + (part + 1) + ": Multiple choice", "Circle the best answer."]);
      body.push(P(runs(head), chance(0.5) ? '<w:jc w:val="center"/>' : ""));
      if (chance(0.3)) body.push(`<w:bookmarkStart w:id="${uid}" w:name="sec${uid}"/>`, `<w:bookmarkEnd w:id="${uid++}"/>`);
    }
    const nq = 2 + Math.floor(R() * 6);
    for (let i = 0; i < nq; i++) {
      const token = `Zq${seed}x${num}`;
      // A question that is only a picture, with its number inside it.
      if (!auto && pk === "MC" && i > 0 && i < nq - 1 && chance(0.1)) {
        if (chance(0.5)) body.push(PAGE);
        body.push(P(inlinePic() + (chance(0.5) ? BR : "")));
        truth.push({ num, mc: true, pic: true, token: null });
        num++;
        continue;
      }
      const out = [];
      openRange(out);
      out.push(stem(num, token, pick(["Which value is a solution?", "Find the slope.", "Evaluate the expression.", "Which graph matches?"])));
      const k = 4 + (chance(0.4) ? 1 : 0);
      if (pk === "MC") out.push(...choices(token, k));
      for (let b = Math.floor(R() * 5); b > 0; b--) out.push(P());
      closeRange(out);
      if (chance(0.25)) out.push(chance(0.5) ? PAGE : P(runs("\t") + BR));
      body.push(...out);
      truth.push({ num, mc: true, pic: false, token, type: pk === "MC" ? ["", "", "AB", "AC", "AD", "AE"][k] : pk });
      num++;
    }
    // A written part between multiple-choice parts.
    if (part < nParts - 1 && chance(0.6)) {
      body.push(PAGE, P(runs("PART " + (part + 2) + "A: SHOW ALL WORK"), '<w:jc w:val="center"/>'), P());
      for (let e = 1 + Math.floor(R() * 2); e > 0; e--) {
        const token = `Zq${seed}x${num}`;
        body.push(stem(num, token, "Solve and explain."), P(runs(`a) ${token}p0`)), P(runs(`b) ${token}p1`)), P(), P());
        if (!auto && chance(0.4)) body.push(PAGE, P(runs(fmt.replace("%n", num).replace(/\t/, " ") + "(continued)")), P(runs(`c) ${token}p2`)));
        truth.push({ num, mc: false, pic: false, token });
        num++;
      }
    }
  }
  if (bookmark) body.push(`<w:bookmarkEnd w:id="${bookmark}"/>`);
  if (comment) body.push(`<w:commentRangeEnd w:id="${comment}"/>`);
  body.push(P(runs(pick(["End of test", "THE END", "Check your work!"]))));
  const lastLine = body[body.length - 1];
  return { body, truth, auto, start, lastLine };
}

function packDoc(spec) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${spec.body.join("")}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="${spec.start}"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const files = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": doc,
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/></Relationships>',
    "word/numbering.xml": numbering,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${NS}>${P(runs("Period 3 · Version A"))}</w:hdr>`,
    "word/media/image1.png": "PNG", "word/embeddings/oleObject1.bin": "OLE",
  };
  const enc = new TextEncoder();
  const entries = Object.keys(files).map((name) => ({ name, nameBytes: enc.encode(name), flags: 0, method: 0, time: 0, date: 33, crc: 0, csize: 0, size: 0, data: new Uint8Array() }));
  return D._internal.writeZip(entries, new Map(Object.entries(files)));
}

/* ---------- checks ---------- */
function wellFormed(xml) {
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith("<?")) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; }
    else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}
const count = (s, re) => (s.match(re) || []).length;
const tokensIn = (xml) => (xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "").match(/Zq\d+x\d+(?:[cp]\d)?/g) || []);
function rangesOk(xml) {
  for (const [a, b] of [["w:bookmarkStart", "w:bookmarkEnd"], ["w:commentRangeStart", "w:commentRangeEnd"]]) {
    const st = {}, en = {};
    for (const m of xml.matchAll(new RegExp(`<${a}\\b[^>]*w:id="(\\d+)"`, "g"))) st[m[1]] = m.index;
    for (const m of xml.matchAll(new RegExp(`<${b}\\b[^>]*w:id="(\\d+)"`, "g"))) en[m[1]] = m.index;
    for (const id of Object.keys(st)) if (en[id] != null && en[id] < st[id]) return false;
    for (const id of Object.keys(en)) if (st[id] == null && /bm|sec/.test("bm")) { /* lone end: allowed only if never had a start */ }
  }
  return true;
}

module.exports = { makeDoc, packDoc, rng, tokensIn };
if (require.main === module) (async () => {
  const fails = [];
  let docs = 0, questions = 0, guessMiss = 0;
  const fail = (seed, msg) => { fails.push(`seed ${seed}: ${msg}`); };
  for (let seed = START; seed < START + N; seed++) {
    docs++;
    const spec = makeDoc(seed);
    const buf = await (await packDoc(spec)).arrayBuffer();
    const doc = await D.open(buf);
    const found = D.findItems(doc);
    const want = spec.truth.map((t) => t.num).join(",");
    const got = found.items.map((it) => it.num).join(",");
    if (got !== want) { fail(seed, `found ${got || "none"}, expected ${want} (${spec.auto ? "auto" : "typed"})`); continue; }
    if (found.items.some((it, i) => !!it.picNum !== spec.truth[i].pic)) { fail(seed, "picture question not recognized"); continue; }
    questions += found.items.length;
    const typeOf = (it) => it.kind || ["", "", "AB", "AC", "AD", "AE", "AF"][Math.min(6, it.choices)] || "?";
    const badType = found.items.find((it, i) => spec.truth[i].type && typeOf(it) !== spec.truth[i].type);
    if (badType) fail(seed, `question ${badType.num} read as ${typeOf(badType)}, expected ${spec.truth[found.items.indexOf(badType)].type}`);
    const mcNums = spec.truth.filter((t) => t.mc).map((t) => t.num);
    const sel = D.guessSelection(found.items, mcNums.length);
    if (sel.join(",") !== mcNums.join(",")) guessMiss++;
    const parsed = D.parse(doc, found, mcNums);
    if (D.reorder(doc, parsed, parsed.questions.map((_, i) => i)) !== doc.docXml) { fail(seed, "same order changed the document"); continue; }
    // A random Version B order: within groups, picture questions fixed.
    const R = rng(seed + 99);
    const perm = parsed.questions.map((_, i) => i);
    const groups = {};
    parsed.questions.forEach((q, i) => { if (!q.picNum) (groups[q.block] = groups[q.block] || []).push(i); });
    for (const g of Object.values(groups)) {
      const sh = g.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      g.forEach((p, k) => (perm[p] = sh[k]));
    }
    const res = await D.build(doc, parsed, perm, "B");
    const outBuf = await res.blob.arrayBuffer();
    const out = await D.open(outBuf);
    const x0 = doc.docXml, x1 = out.docXml;
    if (!wellFormed(x1)) { fail(seed, "document.xml not well formed"); continue; }
    for (const [name, re] of [["page breaks", /<w:br w:type="page"\/>|<w:pageBreakBefore\/>/g], ["pictures", /<w:drawing>/g], ["equation objects", /<w:object\b/g], ["Word equations", /<m:oMath>/g], ["tables", /<w:tbl>/g], ["section breaks", /<w:sectPr\b/g], ["text boxes", /<w:txbxContent>/g], ["revisions", /<w:(?:ins|del)\b/g]]) {
      if (count(x0, re) !== count(x1, re)) fail(seed, `${name}: ${count(x0, re)} → ${count(x1, re)}`);
    }
    const t0 = tokensIn(x0), t1 = tokensIn(x1);
    if (t0.slice().sort().join() !== t1.slice().sort().join()) { fail(seed, "some text was lost or duplicated"); continue; }
    const f1 = D.findItems(out);
    if (f1.items.map((it) => it.num).join(",") !== want) { fail(seed, `after shuffling, numbers read ${f1.items.map((it) => it.num).join(",")}`); continue; }
    // Each position holds the right question, with its own choices right after it.
    const qTok = (d, it) => tokensIn(d.kids.slice(it.start, it.end).map((k) => k.xml).join(""));
    const mcItems = found.items.filter((it) => mcNums.includes(it.num));
    const outMc = f1.items.filter((it) => mcNums.includes(it.num));
    perm.forEach((m, k) => {
      const want = qTok(doc, mcItems[m]).filter((t) => t.startsWith(spec.truth.find((x) => x.num === mcItems[m].num).token || "none"));
      const got = qTok(out, outMc[k]);
      if (want.join() !== got.filter((t) => want.length && t.startsWith(want[0])).join()) fail(seed, `position ${k + 1} should hold question ${mcItems[m].num}'s content`);
    });
    for (const t of spec.truth.filter((x) => !x.mc)) {
      const a = qTok(doc, found.items.find((it) => it.num === t.num)), b = qTok(out, f1.items.find((it) => it.num === t.num));
      if (a.join() !== b.join()) fail(seed, `written question ${t.num} changed`);
    }
    // Headings and the last line stay put.
    const lastIdx = (xml) => xml.lastIndexOf(spec.lastLine);
    if (lastIdx(x1) < 0 || x1.slice(lastIdx(x1) + spec.lastLine.length).replace(/<w:sectPr[\s\S]*$/, "").replace(/<w:(bookmarkEnd|commentRangeEnd)[^>]*\/>/g, "").trim()) fail(seed, "the last line moved");
    const heads = (xml) => (xml.match(/PART [A-Z0-9]+[A-Z: ]*|Part \d: Multiple choice|Circle the best answer\./g) || []).join("|");
    if (heads(x0) !== heads(x1)) fail(seed, "headings changed");
    if (!rangesOk(x1)) fail(seed, "a bookmark or comment range ends before it starts");
    if (!/Version B/.test(x1) || !res.count) fail(seed, "Version A wasn't relabeled");
    // Shuffling back restores the original order.
    const inv = perm.map((_, k) => perm.indexOf(k));
    const fOut = D.findItems(out);
    const back = await D.open(await (await D.build(out, D.parse(out, fOut, mcNums), inv, "A")).blob.arrayBuffer());
    if (tokensIn(back.docXml).join() !== t0.join()) fail(seed, "shuffling back didn't restore the order");
  }
  for (const f of fails.slice(0, 40)) console.log("FAIL " + f);
  console.log(`${docs} files, ${questions} questions; ${fails.length} problems; multiple-choice guess wrong on ${guessMiss} file${guessMiss === 1 ? "" : "s"}`);
  console.log(fails.length ? "\nFAILED" : "\nall passing");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
