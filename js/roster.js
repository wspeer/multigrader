/* MultiGrader — turn pasted or recognized (OCR) roster text into names.
 *
 * Handles, one student per line:
 *   Garcia, Maria            Maria Garcia            "Garcia, Maria"
 *   Abbott, Jordan (V)       Baker, Lin (IV) Advanced        (tags dropped)
 *   1. Maria Garcia          • Garcia, Maria         Garcia, Maria  mg@school.org
 * and tables pasted from a spreadsheet or CSV export, with or without a header
 * row (First Name / Last Name / Name / Student, plus any other columns).
 *
 * A grade tag in brackets right after the name ("(V)", "(IV)", "(11)",
 * "(Gr 11)") or a Form/Grade/Year column becomes the optional "form"; other
 * descriptors ("Advanced", "AP", emails, IDs) are dropped.
 *
 * Returns [{ first, last, form }]. Callers show the result for checking, since
 * text recognition can misread letters (e.g. drop an accent).
 */
(function (root) {
  "use strict";

  const HEADER_WORDS = /^(first|last|given|family|sur|preferred|legal|student|full|display)?\s*_?\s*(name|names)?$|^(student|students|roster|class|email|e-mail|id|student id|grade|period|section|level|course)$/i;

  function splitCSV(line) {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  /* Remove things that aren't part of a name. */
  function scrub(s) {
    return s
      .replace(/^\s*(\d+[.)]|[-•·*▪◦])\s+/, "") // "1. ", "• "
      .replace(/\S+@\S+/g, " ") // emails
      .replace(/\s+/g, " ")
      .trim();
  }

  /* "(v)", "(1v)", "(Iv)", "Form IV", "Gr 11", "11th" → "V", "IV", "IV", "IV", "11", "11". */
  function normalizeForm(raw) {
    let t = String(raw || "").trim().replace(/^(form|grade|gr|yr|year|class)\.?\s*/i, "").replace(/(st|nd|rd|th)$/i, "").trim();
    if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 13) return String(+t);
    // Text recognition confuses I with 1, l and |.
    const roman = t.replace(/[1l|!]/g, "I").toUpperCase();
    if (/^(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)$/.test(roman)) return roman;
    return "";
  }

  const isNameWord = (w) => /^[\p{L}][\p{L}'’.\-]*$/u.test(w);

  /* Keep the leading run of name-like words (stops at tags/numbers). */
  function nameWords(s) {
    const out = [];
    for (const w of s.split(" ")) {
      if (!w) continue;
      if (isNameWord(w)) out.push(w);
      else break;
    }
    return out;
  }

  /* One free-text line → { first, last } or null. */
  function parseLine(raw) {
    let s = scrub(raw.replace(/^"|"$/g, ""));
    if (!s) return null;
    // Text from the first bracket on is tags: a grade/form ("(V)") is kept,
    // anything else ("Advanced", "AP") is dropped.
    let form = "";
    const cut = s.search(/[([{]/);
    if (cut > 0) {
      const m = /^[([{]\s*([^)\]}]*)[)\]}]/.exec(s.slice(cut));
      if (m) form = normalizeForm(m[1]);
      s = s.slice(0, cut).trim();
    }
    if (s.includes(",")) {
      const [l, ...rest] = s.split(",");
      const last = nameWords(l.trim()).join(" ");
      const first = nameWords(rest.join(" ").trim()).join(" ");
      if (!last && !first) return null;
      return { first, last, form };
    }
    const words = nameWords(s);
    if (!words.length) return null;
    if (words.length === 1) {
      if (HEADER_WORDS.test(words[0])) return null;
      return { first: words[0], last: "", form };
    }
    if (HEADER_WORDS.test(words.join(" "))) return null;
    return { first: words.slice(0, -1).join(" "), last: words[words.length - 1], form };
  }

  /* Column roles from a header row, or null if it isn't one. */
  function headerRoles(cells) {
    const roles = cells.map((c) => {
      const h = c.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      if (/^(first|given|preferred)( name)?$|^first name$|^given name$/.test(h)) return "first";
      if (/^(last|family|sur)( ?name)?$|^surname$/.test(h)) return "last";
      if (/^(name|student|student name|full name|display name|name full)$/.test(h)) return "full";
      if (/^(form|grade|grade level|year|yr|class year|year group)$/.test(h)) return "form";
      return HEADER_WORDS.test(h) || /\b(email|id|grade|period|section|level|course|number)\b/.test(h) ? "other" : null;
    });
    const known = roles.filter((r) => r && r !== "other").length;
    if (!known || roles.some((r) => r === null)) return null;
    return roles;
  }

  function parse(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const tabbed = lines.filter((l) => l.includes("\t")).length >= Math.max(1, lines.length / 2);
    const splitter = tabbed ? (l) => l.split("\t").map((x) => x.trim()) : splitCSV;
    const first = splitter(lines[0]);
    const roles = first.length > 1 ? headerRoles(first) : null;

    // A table with a header row: use the named columns.
    if (roles) {
      const out = [];
      for (const l of lines.slice(1)) {
        const cells = splitter(l);
        const get = (role) => cells[roles.indexOf(role)] || "";
        let p;
        if (roles.includes("first") || roles.includes("last")) p = { first: nameWords(scrub(get("first"))).join(" "), last: nameWords(scrub(get("last"))).join(" "), form: "" };
        else p = parseLine(get("full"));
        if (p && roles.includes("form")) p.form = normalizeForm(get("form")) || p.form;
        if (p && (p.first || p.last)) out.push(p);
      }
      return out;
    }

    // A spreadsheet paste without a header: "First<TAB>Last", or a "Last, First" cell.
    if (tabbed) {
      const out = [];
      for (const l of lines) {
        const cells = l.split("\t").map((x) => scrub(x)).filter(Boolean);
        const nameCells = cells.filter((c) => nameWords(c).length && !/\d/.test(c));
        let p = null;
        if (nameCells.length === 1 || (nameCells[0] && nameCells[0].includes(","))) p = parseLine(nameCells[0]);
        else if (nameCells.length >= 2) p = { first: nameWords(nameCells[0]).join(" "), last: nameWords(nameCells[1]).join(" "), form: "" };
        if (p && !HEADER_WORDS.test(`${p.first} ${p.last}`.trim())) out.push(p);
      }
      return out;
    }

    // Free text / OCR / one name per line (a quoted "Last, First" CSV line too).
    return lines.map((l) => parseLine(/^".*"$/.test(l) ? splitCSV(l)[0] : l)).filter(Boolean);
  }

  root.MGRoster = { parse, normalizeForm, _internal: { parseLine, splitCSV, headerRoles } };
})(typeof window !== "undefined" ? window : globalThis);
