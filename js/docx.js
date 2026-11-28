/* MultiGrader — find the questions in a Word (.docx) test and reorder them.
 *
 * A .docx file is a zip of XML. The questions live in word/document.xml as a
 * sequence of paragraphs (and tables). Pictures, MathType and old Equation
 * Editor objects, and Word's own equations are elements inside those
 * paragraphs that point to files elsewhere in the zip, so moving whole
 * paragraphs moves them intact. Nothing is redrawn or converted; every other
 * part of the file is copied byte for byte.
 *
 * Questions are found either by Word's automatic numbering (the main numbered
 * list) or by typed numbers ("1.", "2)", "3<tab>") at the start of a
 * paragraph, counting up from 1. A typed number repeated ("12. (continued)")
 * continues the previous question. If a number is skipped and the previous
 * question contains a picture on its own line, that picture is taken to be the
 * missing question (a screenshot with its number inside it).
 *
 * A question runs from its number to the next question, except that page
 * breaks, section breaks and headings ("Part Two…", ALL-CAPS lines) and
 * everything after them stay in place between the questions. A page break at
 * the very start or end of a question also stays with its position.
 * Blank lines after a question also stay with the position.
 * Reordering swaps question contents between positions; typed numbers are
 * rewritten so each position keeps its number (automatic numbering renumbers
 * itself). A number that is part of a picture can't be rewritten, so those
 * questions should stay in place.
 */
(function (root) {
  "use strict";

  /* ---------------- zip ---------------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const inflateRaw = (b) => pipe(b, new DecompressionStream("deflate-raw"));
  const deflateRaw = (b) => pipe(b, new CompressionStream("deflate-raw"));

  function readZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This isn't a Word .docx file (it isn't a zip archive).");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error("This file is too large to open.");
    const dec = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("The .docx file looks damaged.");
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
      const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const nameBytes = u8.subarray(p + 46, p + 46 + nlen);
      const name = dec.decode(nameBytes);
      const lnlen = dv.getUint16(off + 26, true), lxlen = dv.getUint16(off + 28, true);
      const start = off + 30 + lnlen + lxlen;
      entries.push({ name, nameBytes, flags: flags & 0x0800, method, time, date, crc, csize, size, data: u8.subarray(start, start + csize) });
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  async function entryBytes(e) {
    if (e.method === 0) return e.data;
    if (e.method === 8) return inflateRaw(e.data);
    throw new Error("Unsupported compression in the .docx file.");
  }

  /* Write the zip back: unchanged entries are copied as they were. */
  async function writeZip(entries, replaced) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      let { method, crc, csize, size, data } = e;
      if (replaced.has(e.name)) {
        const raw = enc.encode(replaced.get(e.name));
        data = await deflateRaw(raw);
        method = 8; crc = crc32(raw); csize = data.length; size = raw.length;
      }
      const lh = new Uint8Array(30 + e.nameBytes.length);
      const ldv = new DataView(lh.buffer);
      ldv.setUint32(0, 0x04034b50, true); ldv.setUint16(4, 20, true); ldv.setUint16(6, e.flags, true);
      ldv.setUint16(8, method, true); ldv.setUint16(10, e.time, true); ldv.setUint16(12, e.date, true);
      ldv.setUint32(14, crc, true); ldv.setUint32(18, csize, true); ldv.setUint32(22, size, true);
      ldv.setUint16(26, e.nameBytes.length, true); ldv.setUint16(28, 0, true);
      lh.set(e.nameBytes, 30);
      const ch = new Uint8Array(46 + e.nameBytes.length);
      const cdv = new DataView(ch.buffer);
      cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
      cdv.setUint16(8, e.flags, true); cdv.setUint16(10, method, true); cdv.setUint16(12, e.time, true); cdv.setUint16(14, e.date, true);
      cdv.setUint32(16, crc, true); cdv.setUint32(20, csize, true); cdv.setUint32(24, size, true);
      cdv.setUint16(28, e.nameBytes.length, true); cdv.setUint32(42, offset, true);
      ch.set(e.nameBytes, 46);
      parts.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    }
    const csize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true); edv.setUint16(10, entries.length, true);
    edv.setUint32(12, csize, true); edv.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  /* ---------------- XML helpers ---------------- */

  const decodeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" :
    String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const encodeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* The top-level elements between from and to: [{s, e, tag}]. */
  function children(xml, from, to) {
    const out = [];
    const re = /<[^>]*>/g;
    re.lastIndex = from;
    let depth = 0, cur = null, m;
    while ((m = re.exec(xml)) && m.index < to) {
      const tag = m[0];
      if (tag[1] === "?" || tag[1] === "!") continue;
      if (tag[1] === "/") {
        depth--;
        if (depth === 0 && cur) { cur.e = re.lastIndex; out.push(cur); cur = null; }
      } else if (tag.endsWith("/>")) {
        if (depth === 0) out.push({ s: m.index, e: re.lastIndex, tag: tag.match(/^<([\w:.-]+)/)[1] });
      } else {
        if (depth === 0) cur = { s: m.index, tag: tag.match(/^<([\w:.-]+)/)[1] };
        depth++;
      }
    }
    return out;
  }

  // Text runs in order: w:t (document text), m:t (Word equations), tabs.
  const TEXT_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>|<w:tab\/>/g;
  // Text boxes (and the copy of a drawing kept for old Word versions) aren't
  // part of the paragraph's own text.
  const HIDDEN_RE = /<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>|<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g;
  function mask(xml) {
    const saved = [];
    const masked = xml.replace(HIDDEN_RE, (m) => { saved.push(m); return `\u0000${saved.length - 1}\u0000`; });
    return { masked, restore: (x) => x.replace(/\u0000(\d+)\u0000/g, (m, i) => saved[+i]) };
  }
  function textOf(xml) {
    let s = "";
    for (const m of xml.replace(HIDDEN_RE, "").matchAll(TEXT_RE)) s += m[0] === "<w:tab/>" ? "\t" : decodeXml(m[1] || m[2] || "");
    return s;
  }
  // A table's text, one line per paragraph.
  const tableText = (xml) => xml.split(/<\/w:p>/).map(textOf).join("\n");
  // For previews: also show where equation objects and pictures are.
  const PREVIEW_RE = new RegExp(TEXT_RE.source + "|<w:object\\b|<w:drawing\\b|<w:pict\\b", "g");
  function previewOf(xml) {
    let s = "";
    for (const m of xml.replace(HIDDEN_RE, "").matchAll(PREVIEW_RE)) {
      if (m[0] === "<w:tab/>") s += " ";
      else if (m[0] === "<w:object") s += " ▢ ";
      else if (m[0] === "<w:drawing" || m[0] === "<w:pict") s += " [picture] ";
      else s += decodeXml(m[1] || m[2] || "");
    }
    return s;
  }

  const PAGE_BR = /<w:br\s+w:type="page"\s*\/>/g;
  const PIC_RE = /<w:drawing\b|<w:pict\b/;
  const CONTENT_RE = /<w:t(?:\s[^>]*)?>[^<]*\S[^<]*<\/w:t>|<m:t(?:\s[^>]*)?>[^<]*<\/m:t>|<w:drawing\b|<w:pict\b|<w:object\b/g;

  function paraInfo(xml, styleNum) {
    const pPr = (xml.match(/^<w:p\b[^>]*>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/) || [])[1] || "";
    const info = { xml, pPr, text: textOf(xml) };
    const np = pPr.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    const style = (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    if (np) {
      info.numId = (np[1].match(/<w:numId w:val="(\d+)"/) || [])[1];
      info.ilvl = +((np[1].match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0);
    } else if (style && styleNum[style]) {
      info.numId = styleNum[style].numId; info.ilvl = styleNum[style].ilvl;
    }
    if (info.numId === "0") info.numId = undefined;
    info.sect = /<w:sectPr\b/.test(pPr);
    info.center = /<w:jc w:val="center"\/>/.test(pPr);
    info.pic = PIC_RE.test(xml);
    // Where page breaks sit relative to the paragraph's content.
    const brs = [...xml.matchAll(PAGE_BR)].map((m) => m.index);
    const content = [...xml.matchAll(CONTENT_RE)].map((m) => m.index);
    info.hasContent = content.length > 0;
    info.breakOnly = brs.length > 0 && !content.length;
    info.pbBefore = /<w:pageBreakBefore(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(pPr);
    // Page breaks before the first content (counting "page break before") and after the last.
    info.leadN = content.length ? brs.filter((b) => b < content[0]).length + (info.pbBefore ? 1 : 0) : 0;
    info.trailN = content.length ? brs.filter((b) => b > content[content.length - 1]).length : 0;
    info.leadBreak = info.leadN > 0 && !info.pbBefore;
    info.trailBreak = info.trailN > 0;
    return info;
  }

  /* ---------------- open ---------------- */

  async function open(buf) {
    const entries = readZip(buf);
    const get = async (name) => {
      const e = entries.find((x) => x.name === name);
      return e ? new TextDecoder().decode(await entryBytes(e)) : null;
    };
    const docXml = await get("word/document.xml");
    if (!docXml) throw new Error("This doesn't look like a Word document (word/document.xml is missing).");
    const numbering = await get("word/numbering.xml");
    const styles = await get("word/styles.xml");
    // numId → abstractNumId, and each abstract list's number format per level.
    const nums = {}, absFmt = {}, absStart = {}, restart = {};
    if (numbering) {
      for (const m of numbering.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
        absFmt[m[1]] = {};
        for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
          absFmt[m[1]][l[1]] = (l[2].match(/<w:numFmt w:val="(\w+)"/) || [])[1];
          if (l[1] === "0") absStart[m[1]] = +((l[2].match(/<w:start w:val="(\d+)"/) || [])[1] || 1);
        }
      }
      for (const m of numbering.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
        nums[m[1]] = (m[2].match(/<w:abstractNumId w:val="(\d+)"/) || [])[1];
        const so = m[2].match(/<w:lvlOverride w:ilvl="0"\s*>[\s\S]*?<w:startOverride w:val="(\d+)"/);
        if (so) restart[m[1]] = +so[1];
      }
    }
    const styleNum = {};
    if (styles) {
      for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
        const np = m[2].match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
        if (np) styleNum[m[1]] = { numId: (np[1].match(/<w:numId w:val="(\d+)"/) || [])[1], ilvl: +((np[1].match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0) };
      }
    }
    const bodyOpen = docXml.indexOf("<w:body>");
    const bodyClose = docXml.lastIndexOf("</w:body>");
    if (bodyOpen < 0 || bodyClose < 0) throw new Error("Couldn't read the document body.");
    const kids = children(docXml, bodyOpen + 8, bodyClose).map((c) => {
      const xml = docXml.slice(c.s, c.e);
      if (c.tag === "w:p") return { ...c, kind: "p", ...paraInfo(xml, styleNum) };
      // Tables, content controls, and markers such as bookmarks between paragraphs.
      const hasContent = CONTENT_RE.test(xml);
      CONTENT_RE.lastIndex = 0;
      return { ...c, kind: c.tag === "w:tbl" ? "tbl" : c.tag === "w:sectPr" ? "sectPr" : "other", xml, text: tableText(xml), hasContent, pic: PIC_RE.test(xml) };
    });
    const fmt = (numId, ilvl) => (absFmt[nums[numId]] || {})[ilvl];
    const extra = [];
    for (const e of entries) if (/^word\/(header|footer)\d*\.xml$/.test(e.name)) extra.push({ name: e.name, xml: await get(e.name) });
    return { entries, docXml, kids, fmt, nums, absStart, restart, extra };
  }

  /* ---------------- find questions ---------------- */

  // "1." "1)" "(1)" "1:" "1<tab>", or "Question 1" / "Problem 1" / "Q1." / "#1"
  const TYPED_RE = /^\s*(?:(?:question|problem|q)\s*#?\s*(\d{1,3})\b\s*[.):]?|#\s*(\d{1,3})\b\s*[.):]?|\(?(\d{1,3})\s*(?:[.):]|\t))/i;
  const typedNum = (t) => { const m = t.match(TYPED_RE); return m ? { n: +(m[1] || m[2] || m[3]), len: m[0].length } : null; };
  const isHeading = (k) => {
    if (k.kind !== "p") return false;
    const t = k.text.trim();
    if (!t) return false;
    if (/^(part|section)\s+(\w+)\b/i.test(t)) return true;
    if (/^(?:the\s+)?end(?:\s+of\s+(?:the\s+)?(?:test|exam|quiz|section|part))?\b|^stop\b|^(?:check|review) (?:your|all) (?:work|answers)|^good luck|^have a (?:great|good)/i.test(t)) return true;
    const letters = t.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 6 && letters === letters.toUpperCase() && !/^\(?[a-fA-F][.)]/.test(t)) return true;
    return false;
  };
  const ESSAY_RE = /essay|show (?:all |your )*work|free[- ]response|open[- ]response|short answer|long answer|constructed response/i;
  const MC_RE = /multiple[- ]choice|circle (?:the |your )?(?:best |correct )?answers?|choose the|bubble/i;
  const TF_RE = /\btrue\s*(?:or|\/|-|,)\s*false\b/i;
  const ASN_RE = /\balways\b[\s\S]{0,40}\bsometimes\b[\s\S]{0,40}\bnever\b/i;

  /* All numbered questions in the file, with their extent. */
  function findItems(doc) {
    const K = doc.kids;
    // Mode 1: Word's automatic numbering — the most used list at level 0
    // (plus other lists sharing its definition).
    const counts = {};
    K.forEach((k) => { if (k.numId && k.ilvl === 0 && /^decimal/.test(doc.fmt(k.numId, 0) || "decimal")) counts[k.numId] = (counts[k.numId] || 0) + 1; });
    const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const auto = [];
    if (main) {
      const abs = doc.nums[main];
      const seen = new Set();
      let counter = null;
      K.forEach((k, i) => {
        if (!(k.numId && k.ilvl === 0 && (k.numId === main || (abs && doc.nums[k.numId] === abs)))) return;
        if (!seen.has(k.numId)) { seen.add(k.numId); if (doc.restart[k.numId] != null) counter = doc.restart[k.numId] - 1; }
        if (counter == null) counter = (doc.absStart[abs] || 1) - 1;
        counter++;
        auto.push({ num: counter, start: i });
      });
      // Numbers must identify questions; if a list restarts, count instead.
      if (auto.some((it, j) => j && it.num <= auto[j - 1].num)) auto.forEach((it, j) => (it.num = j + 1));
    }
    // Mode 2: typed numbers counting up. The longest such run in the file is
    // taken (it may start anywhere, e.g. at 16 for a second part). A repeated
    // number continues the question ("12. (continued)"). A small jump is
    // allowed; if the question before ends with as many pictures on their
    // own lines as numbers were skipped, those pictures are the missing
    // questions (their numbers are inside the pictures).
    const cands = [];
    K.forEach((k, i) => {
      if (k.kind !== "p" || k.numId) return;
      const t = typedNum(k.text);
      if (t) cands.push({ i, n: t.n });
    });
    const picOnly = K.map((k) => k.kind === "p" && k.pic && !k.text.trim());
    const picsBetween = (a, b) => { let n = 0; for (let j = a + 1; j < b; j++) if (picOnly[j]) n++; return n; };
    const chain = (from) => {
      const out = [cands[from]];
      for (let c = from + 1; c < cands.length; c++) {
        const last = out[out.length - 1];
        const jump = cands[c].n - last.n;
        if (jump > 0 && (jump <= 3 || picsBetween(last.i, cands[c].i) >= jump - 1)) out.push(cands[c]);
      }
      return out;
    };
    let best = [];
    for (let c = 0; c < cands.length; c++) {
      if (best.length && cands.length - c <= best.length) break;
      const ch = chain(c);
      if (ch.length > best.length) best = ch;
    }
    const typed = [];
    for (const c of best.length >= 2 || (best.length === 1 && best[0].n === 1) ? best : []) {
      const prev = typed[typed.length - 1];
      const gap = prev ? c.n - prev.num - 1 : 0;
      if (gap > 0) {
        // The last pictures on their own lines before this question fill the gap.
        const pics = [];
        for (let j = prev.start + 1; j < c.i; j++) if (picOnly[j]) pics.push(j);
        if (pics.length >= gap) pics.slice(-gap).forEach((j, g) => typed.push({ num: prev.num + 1 + g, start: j, picNum: true }));
      }
      typed.push({ num: c.n, start: c.i });
    }
    const mode = auto.length >= typed.length ? (auto.length ? "auto" : null) : "typed";
    const items = mode === "auto" ? auto : mode === "typed" ? typed : [];
    const last = K.length && K[K.length - 1].kind === "sectPr" ? K.length - 1 : K.length;
    items.forEach((it, n) => {
      it.end = n + 1 < items.length ? items[n + 1].start : last;
      // Content stops at a page break, section break or heading; from there on
      // it's between questions and stays in place.
      let ce = it.end;
      for (let j = it.start; j < it.end; j++) {
        const k = K[j];
        if (j > it.start && (k.breakOnly || k.sect || isHeading(k) || k.leadBreak || k.pbBefore)) { ce = j; break; }
        if (k.trailBreak || (j === it.start && k.sect)) { ce = j + 1; break; }
      }
      it.contentEnd = ce;
      // Blank lines after the question (room to work) stay with the position,
      // so each page keeps the spacing it was laid out with.
      let be = ce;
      while (be > it.start + 1 && K[be - 1].kind === "p" && !K[be - 1].hasContent && !K[be - 1].sect) be--;
      it.bodyEnd = be;
      it.leadN = K[it.start].leadN || 0;
      const lastK = K[be - 1];
      it.trailN = lastK && lastK.kind === "p" ? lastK.trailN || 0 : 0;
      const text = K.slice(it.start, be).map((k) => previewOf(k.xml)).join(" ").replace(/\s+/g, " ").trim();
      const tn = mode === "typed" && !it.picNum ? typedNum(text) : null;
      const body = tn ? text.slice(tn.len).trim() : text;
      it.preview = it.picNum ? "(picture)" : body.length > 90 ? body.slice(0, 88) + "…" : body || "(equation or picture)";
      it.choices = countChoices(doc, K.slice(it.start, be));
      it.between = K.slice(ce, it.end);
    });
    // What the text between questions says about the questions after it:
    // written answers, multiple choice, true/false or always/sometimes/never.
    let ctx = null, kind = null;
    const intro = K.slice(0, items.length ? items[0].start : 0);
    let heading = false; // a multiple-choice heading just before this question
    const readCtx = (ks) => {
      heading = false;
      for (const k of ks) {
        if (!k.text.trim()) continue;
        if (ESSAY_RE.test(k.text)) { ctx = "essay"; kind = null; }
        else if (TF_RE.test(k.text)) { ctx = "mc"; kind = "TF"; heading = true; }
        else if (ASN_RE.test(k.text)) { ctx = "mc"; kind = "ASN"; heading = true; }
        else if (MC_RE.test(k.text)) { ctx = "mc"; kind = null; heading = true; }
      }
    };
    readCtx(intro);
    items.forEach((it) => {
      it.ctx = ctx;
      it.mcHeading = heading;
      // A question's own choices win over its heading.
      const own = K.slice(it.start, it.bodyEnd).map((k) => k.text).join(" ");
      it.kind = it.choices >= 2 ? null : TF_RE.test(own) || /(?:^|\s)T\s*\/?\s*F(?:\s|$)/.test(own) ? "TF" : ASN_RE.test(own) ? "ASN" : kind;
      readCtx(it.between);
    });
    // Multiple choice: four or more lettered choices, or two or more (or
    // true/false…) under a multiple-choice heading; two or three choices
    // between multiple-choice questions; a picture question between them.
    const near = (i, d) => { for (let j = i + d; j >= 0 && j < items.length; j += d) if (!items[j].picNum) return items[j]; return null; };
    items.forEach((it) => {
      it.mc = it.ctx !== "essay" && !!(it.choices >= 4 || (it.ctx === "mc" && (it.choices >= 2 || it.kind)));
    });
    items.forEach((it, i) => {
      if (it.mc || it.ctx === "essay") return;
      const a = near(i, -1), b = near(i, 1);
      if ((it.picNum || it.choices >= 2) && (!a || a.mc) && (!b || b.mc) && (a || b)) it.mc = true;
    });
    // Answers marked in the file (an answer key or scoring guide): an
    // "Answer: B" line, or highlighted answer choices (several = all required).
    items.forEach((it) => {
      const ks = K.slice(it.start, it.end);
      let ans = null;
      for (const k of ks) {
        const m = k.text.match(/^\s*(?:correct\s+)?answers?\s*(?:is)?\s*[:\-]?\s*\(?([A-F]|True|False|T)\)?(?=$|[\s.,;])/i);
        if (m && /^[A-FT]|^(?:true|false)$/i.test(m[1]) && (m[1].length > 1 || m[1] === m[1].toUpperCase())) { ans = m[1]; break; }
      }
      if (ans) { it.key = [/^true$/i.test(ans) ? "T" : /^false$/i.test(ans) ? "F" : ans.toUpperCase()]; it.keyAll = false; return; }
      const hl = [];
      for (const k of ks) {
        if (!k.hl) continue;
        // A highlighted line holding one answer choice (a line with several
        // choices doesn't say which one is meant).
        const m = k.text.match(/^\s*\(?([A-Fa-f])[).]/);
        const labels = (k.text.match(/(?:^|\s)\(?[A-Fa-f][).]/g) || []).length;
        if (m && labels === 1 && !hl.includes(m[1].toUpperCase())) hl.push(m[1].toUpperCase());
      }
      if (hl.length) { it.key = hl.sort(); it.keyAll = hl.length > 1; }
    });
    // Once a question with no answer choices appears (written answer), later
    // ones count as multiple choice only after a multiple-choice heading.
    let free = false;
    items.forEach((it) => {
      if (it.mcHeading) free = false;
      if (free) it.mc = false;
      if (!it.mc && !it.picNum && it.choices < 2 && !it.kind) free = true;
    });
    return { mode, items };
  }

  /* Answer choices: labels a) b) c)… / (A) (B)… / A. B. … counted up from A,
   * or items of a lettered Word list. */
  function countChoices(doc, ks) {
    const seen = new Set();
    const lists = {};
    for (const k of ks) {
      // "a)" and "(a)" may run straight into an equation (no space after, as in
      // some PDFs); "a." needs a space after it.
      for (const m of k.text.matchAll(/(?:^|\s)(?:\(([a-fA-F])\)|([a-fA-F])\)|([a-fA-F])\.(?=\s|$))/g)) seen.add((m[1] || m[2] || m[3]).toLowerCase());
      if (k.numId && /letter/i.test(doc.fmt(k.numId, k.ilvl) || "")) lists[k.numId + "/" + k.ilvl] = (lists[k.numId + "/" + k.ilvl] || 0) + 1;
    }
    let n = 0;
    while (seen.has("abcdef"[n])) n++;
    return Math.max(n, ...Object.values(lists), 0);
  }

  /* Pick which numbered questions are on the answer sheet, given how many the
   * test has: the multiple-choice-looking ones, else the first n. */
  function guessSelection(items, n) {
    const mc = items.filter((it) => it.mc);
    if (mc.length === n) return mc.map((it) => it.num);
    if (mc.length > n) return mc.slice(0, n).map((it) => it.num);
    return items.slice(0, n).map((it) => it.num);
  }

  /* Questions (in the shape MultiGrader's LaTeX support uses) for the chosen
   * file numbers. Groups: consecutive chosen questions with no other question,
   * heading or text between them. */
  function parse(doc, found, sel) {
    const { mode, items } = found;
    if (!items.length) return { mode, items, questions: [], error: "No numbered questions found. MultiGrader looks for questions numbered with Word's automatic numbering, or typed as 1. 2. 3. at the start of a line." };
    const chosen = new Set(sel);
    const questions = [];
    let block = 0, prevIdx = -2;
    items.forEach((it, idx) => {
      if (!chosen.has(it.num)) return;
      if (questions.length) {
        const prev = items[prevIdx];
        const textBetween = prev.between.some((k) => k.sect || (k.kind === "tbl") || (k.kind === "other" && k.hasContent) || (k.kind === "p" && k.text.trim() && !k.breakOnly));
        if (idx !== prevIdx + 1 || textBetween) block++;
      }
      questions.push({ ...it, block, correctIdx: [], key: it.key || null, keyAll: !!it.keyAll });
      prevIdx = idx;
    });
    return { mode, items, questions, error: null };
  }

  /* ---------------- write a version ---------------- */

  /* Replace characters [a, b) of a paragraph's w:t text with s. */
  function editText(xml0, a, b, s) {
    const { masked: xml, restore } = mask(xml0);
    let pos = 0, done = false;
    return restore(xml.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)|<w:tab\/>/g, (m, open, raw, close) => {
      if (!open) { pos++; return m; } // a tab counts as one character
      const txt = decodeXml(raw);
      const from = pos, to = pos + txt.length;
      pos = to;
      if (to <= a || from >= b) return m;
      const keepL = txt.slice(0, Math.max(0, a - from)), keepR = txt.slice(Math.max(0, b - from));
      const mid = done ? "" : s;
      done = true;
      const t = keepL + mid + keepR;
      const o = /xml:space=/.test(open) || !/^\s|\s$/.test(t) ? open : open.replace(/<w:t/, '<w:t xml:space="preserve"');
      return o + encodeXml(t) + close;
    }));
  }
  // A paragraph's text as editText counts it: w:t text and tabs.
  const wText = (xml) => [...mask(xml).masked.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[0] === "<w:tab/>" ? "\t" : decodeXml(m[1]))).join("");

  function renumber(pxml, num) {
    const t = wText(pxml);
    const m = t.match(TYPED_RE);
    if (!m) return pxml;
    const digits = m[1] || m[2] || m[3];
    const at = m.index + m[0].indexOf(digits);
    return editText(pxml, at, at + digits.length, String(num));
  }

  /* After moving questions, a bookmark or comment range could start in one
   * question and end in another, or end before it starts. Those markers are
   * removed (the bookmark or comment itself stays). */
  const RANGES = [["w:bookmarkStart", "w:bookmarkEnd"], ["w:commentRangeStart", "w:commentRangeEnd"], ["w:permStart", "w:permEnd"],
    ["w:moveFromRangeStart", "w:moveFromRangeEnd"], ["w:moveToRangeStart", "w:moveToRangeEnd"]];
  function fixRanges(xml, before) {
    for (const [a, b] of RANGES) {
      const pos = (tag, src) => {
        const map = {};
        for (const m of src.matchAll(new RegExp(`<${tag}\\b[^>]*\\bw:id="([^"]+)"[^>]*\\/>`, "g"))) (map[m[1]] = map[m[1]] || []).push(m.index);
        return map;
      };
      const s0 = pos(a, before), e0 = pos(b, before), s1 = pos(a, xml), e1 = pos(b, xml);
      const bad = new Set();
      for (const id of new Set([...Object.keys(s1), ...Object.keys(e1)])) {
        const wasOk = s0[id] && e0[id] && s0[id].length === 1 && e0[id].length === 1 && s0[id][0] < e0[id][0];
        const isOk = s1[id] && e1[id] && s1[id].length === 1 && e1[id].length === 1 && s1[id][0] < e1[id][0];
        if (wasOk && !isOk) bad.add(id);
      }
      if (bad.size) xml = xml.replace(new RegExp(`<(?:${a}|${b})\\b[^>]*\\bw:id="([^"]+)"[^>]*\\/>`, "g"), (m, id) => (bad.has(id) ? "" : m));
    }
    return xml;
  }

  const BREAK_RUN = '<w:r><w:br w:type="page"/></w:r>';
  function removeFirst(xml, re) {
    const m = xml.match(re);
    return m ? xml.slice(0, m.index) + xml.slice(m.index + m[0].length) : xml;
  }
  function removeLast(xml, re) {
    const all = [...xml.matchAll(new RegExp(re.source, "g"))];
    if (!all.length) return xml;
    const m = all[all.length - 1];
    return xml.slice(0, m.index) + xml.slice(m.index + m[0].length);
  }
  const PB_ONE = /<w:br\s+w:type="page"\s*\/>/;
  const PBB = /<w:pageBreakBefore(?:\s+w:val="(?:1|true|on)")?\s*\/>/;
  function addLeadBreak(pxml) {
    const m = pxml.match(/^<w:p\b[^>]*>(\s*<w:pPr>[\s\S]*?<\/w:pPr>)?/);
    return pxml.slice(0, m[0].length) + BREAK_RUN + pxml.slice(m[0].length);
  }
  function addTrailBreak(pxml) {
    const i = pxml.lastIndexOf("</w:p>");
    return pxml.slice(0, i) + BREAK_RUN + pxml.slice(i);
  }

  /* document.xml with question perm[k] in position k. */
  function reorder(doc, parsed, perm) {
    const K = doc.kids, xml = doc.docXml;
    const qs = parsed.questions;
    // The content of each question, without the page breaks at its edges.
    const content = qs.map((q) => {
      const parts = K.slice(q.start, q.bodyEnd).map((k) => k.xml);
      if (q.leadN) {
        const pbb = PBB.test(parts[0]);
        parts[0] = removeFirst(parts[0], PBB);
        for (let i = pbb ? 1 : 0; i < q.leadN; i++) parts[0] = removeFirst(parts[0], PB_ONE);
      }
      for (let i = 0; i < q.trailN; i++) parts[parts.length - 1] = removeLast(parts[parts.length - 1], PB_ONE);
      return parts;
    });
    let out = "", prev = 0, moved = false;
    qs.forEach((slot, k) => {
      const q = qs[perm[k]];
      if (q !== slot) moved = true;
      if (q === slot) { // unchanged position: copy as is
        out += xml.slice(prev, K[slot.bodyEnd - 1].e);
        prev = K[slot.bodyEnd - 1].e;
        return;
      }
      const parts = content[perm[k]].slice();
      if (parsed.mode === "typed" && !q.picNum && q.num !== slot.num) parts[0] = renumber(parts[0], slot.num);
      for (let i = 0; i < slot.leadN; i++) parts[0] = addLeadBreak(parts[0]);
      for (let i = 0; i < slot.trailN; i++) {
        const lastK = K[q.bodyEnd - 1];
        if (lastK.kind === "p") parts[parts.length - 1] = addTrailBreak(parts[parts.length - 1]);
        else parts.push(`<w:p>${BREAK_RUN}</w:p>`);
      }
      out += xml.slice(prev, K[slot.start].s) + parts.join("");
      prev = K[slot.bodyEnd - 1].e;
    });
    out += xml.slice(prev);
    return moved ? fixRanges(out, xml) : out;
  }

  /* "Version A" → "Version B" in the text (document, headers, footers). */
  function relabel(xml0, v) {
    let count = 0;
    // Text boxes first (each holds its own paragraphs), then the rest.
    const saved = [];
    const xml = xml0.replace(/<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g, (m) => {
      const r = relabel(m.replace(/^<w:txbxContent\b[^>]*>/, "").replace(/<\/w:txbxContent>$/, ""), v);
      count += r.count;
      saved.push(m.match(/^<w:txbxContent\b[^>]*>/)[0] + r.xml + "</w:txbxContent>");
      return `\u0001${saved.length - 1}\u0001`;
    });
    const out = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
      let t = wText(p), q = p;
      const re = /\bVersion\s*[:\-]?\s*A\b/g;
      let m;
      const hits = [];
      while ((m = re.exec(t))) hits.push(m.index + m[0].length - 1);
      for (const at of hits.reverse()) { q = editText(q, at, at + 1, v); count++; }
      return q;
    });
    return { xml: out.replace(/\u0001(\d+)\u0001/g, (m, i) => saved[+i]), count };
  }

  async function build(doc, parsed, perm, v) {
    const rl = relabel(reorder(doc, parsed, perm), v);
    const replaced = new Map([["word/document.xml", rl.xml]]);
    let count = rl.count;
    for (const x of doc.extra) {
      const r = relabel(x.xml, v);
      if (r.count) { replaced.set(x.name, r.xml); count += r.count; }
    }
    const moved = parsed.questions.filter((q, k) => q.picNum && perm.indexOf(k) !== k).map((q) => q.num);
    return { blob: await writeZip(doc.entries, replaced), count, picMoved: moved };
  }

  root.MGDocx = { open, findItems, guessSelection, parse, reorder, relabel, build, _internal: { readZip, writeZip, entryBytes, crc32, children, textOf, typedNum, fixRanges } };
})(typeof window !== "undefined" ? window : globalThis);
