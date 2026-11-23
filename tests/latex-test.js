// Unit tests for js/latex.js (finding and reordering questions in a .tex file).
//   node tests/latex-test.js
const fs = require("fs");
const path = require("path");
require("../js/latex.js");
const X = globalThis.MGLatex;

let fails = 0;
function check(cond, msg) { console.log((cond ? "  ok  " : "  FAIL ") + msg); if (!cond) fails++; }
const read = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const firstWords = (src, parsed) => parsed.questions.map((q) => src.slice(q.start, q.bodyEnd).replace(/^\\question(\[\d+\])?\s*/, "").slice(0, 12));

// ---- exam class ----
{
  const src = read("exam-sample.tex");
  const p = X.parse(src);
  check(!p.error && p.mode === "exam", "exam: parsed in exam mode");
  check(p.questions.length === 7, "exam: 7 questions found (commented one ignored) — got " + p.questions.length);
  check(p.questions.map((q) => q.choices).join() === "0,0,0,4,4,4,4", "exam: choice counts " + p.questions.map((q) => q.choices).join());
  check(p.questions.map((q) => q.correctIdx.join("")).join() === ",,,1,2,0,3", "exam: \\CorrectChoice positions " + p.questions.map((q) => q.correctIdx.join("")).join());
  // Question 3's slot is followed by the Part II heading, Q6's by \newpage: both stay put.
  const perm = [2, 0, 1, 6, 4, 3, 5];
  const out = X.reorder(src, p, perm);
  const p2 = X.parse(out);
  check(p2.questions.length === 7, "exam: reordered file still has 7 questions");
  const before = firstWords(src, p), after = firstWords(out, p2);
  check(perm.every((m, k) => after[k] === before[m]), "exam: questions appear in the new order");
  const iPartII = out.indexOf("Part II");
  // The Part II heading must still sit between slot 3 and slot 4.
  check(iPartII > p2.questions[2].start && iPartII < p2.questions[3].start, "exam: 'Part II' heading stays between the sections");
  const iNew = out.indexOf("\\newpage");
  check(iNew > p2.questions[5].start && iNew < p2.questions[6].start, "exam: \\newpage stays before the last slot");
  check(out.includes("\\begin{solution}\n  $x = -b/(2a)"), "exam: solution environment moved with its question");
  check(out.includes("% \\question this commented-out question must be ignored"), "exam: comments preserved");
  check(out.length === src.length, "exam: no text lost or added (" + src.length + " vs " + out.length + ")");
  check(X.reorder(src, p, [0, 1, 2, 3, 4, 5, 6]) === src, "exam: identity order reproduces the file exactly");
  const r = X.relabel(out, "B");
  check(r.count === 2 && r.text.includes("\\newcommand{\\version}{B}") && r.text.includes("{Version B}"), "exam: version labels changed to B (" + r.count + ")");
}

// ---- enumerate ----
{
  const src = read("enumerate-sample.tex");
  const p = X.parse(src);
  check(!p.error && p.mode === "enumerate", "enumerate: parsed in enumerate mode");
  check(p.questions.length === 5, "enumerate: 5 top-level items across two lists — got " + p.questions.length);
  check(p.questions.map((q) => q.choices).join() === "0,0,3,3,3", "enumerate: nested choice counts " + p.questions.map((q) => q.choices).join());
  const perm = [1, 0, 4, 2, 3];
  const out = X.reorder(src, p, perm);
  const p2 = X.parse(out);
  const before = p.questions.map((q) => src.slice(q.start, q.start + 25)), after = p2.questions.map((q) => out.slice(q.start, q.start + 25));
  check(p2.questions.length === 5 && perm.every((m, k) => after[k] === before[m]), "enumerate: items appear in the new order");
  check(out.indexOf("\\textbf{Multiple choice}") > p2.questions[1].start && out.indexOf("\\textbf{Multiple choice}") < p2.questions[2].start, "enumerate: heading between lists stays put");
  check(out.includes("(an itemize inside a question stays with it)"), "enumerate: nested itemize kept");
  check(out.length === src.length, "enumerate: no text lost or added");
  const r = X.relabel(out, "C");
  check(r.count === 1 && r.text.includes("Quiz 3 --- Version C"), "enumerate: title relabeled to Version C");
}

// ---- exam class with answer macros, multicols, headings, label ranges ----
{
  const src = read("exam-macros-sample.tex");
  const p = X.parse(src);
  const qs = p.questions;
  check(!p.error && qs.length === 12, "macros: 12 questions (3 inside multicols) — got " + qs.length);
  check(qs.map((q) => (q.key || []).join("") + (q.keyAll ? "*" : "")).join(",") === "T,F,F,B,A,C,A,B,D,A,C,AC*", "macros: answers read from \\TFQuestion/\\MCQuestion/\\CAQuestion — " + qs.map((q) => (q.key || []).join("")).join(","));
  check(qs.map((q) => q.block).join("") === "000111223334", "macros: groups split at headings — " + qs.map((q) => q.block).join(""));
  check(qs[2].end <= src.indexOf("\\begin{multicols}") && !src.slice(qs[2].start, qs[2].bodyEnd).includes("fullwidth"), "macros: Q3 stops before the Part II heading and multicols");
  check(qs[5].end <= src.indexOf("\\end{multicols}"), "macros: last multicols question ends inside multicols");
  check(qs[0].preview === "Statement one.", "macros: preview shows the statement — " + qs[0].preview);
  // reverse inside each group
  const perm = [2, 1, 0, 5, 4, 3, 7, 6, 10, 9, 8, 11];
  const out = X.reorder(src, p, perm);
  const p2 = X.parse(out);
  check(p2.questions.map((q) => (q.key || []).join("")).join(",") === perm.map((m) => (qs[m].key || []).join("")).join(","), "macros: answers follow the new order");
  check(out.indexOf("Bubble A, B or C") > p2.questions[2].start && out.indexOf("Bubble A, B or C") < p2.questions[3].start, "macros: Part II heading stays in place");
  check(out.indexOf("\\setlength{\\itemsep}{8pt}") < p2.questions[3].start && out.indexOf("\\setlength{\\itemsep}{8pt}") > p2.questions[2].start, "macros: spacing command stays with the heading");
  const lab = (q) => out.slice(q.labelStart, q.labelEnd).trim();
  check(lab(p2.questions[8]) === "\\label{q:first}" && lab(p2.questions[10]) === "\\label{q:last}", "macros: \\label ranges stay on the first/last slot");
  check(out.includes("\\question\\label{q:first}\\MCQuestion{C}{Arrow eleven}"), "macros: moved question takes the slot's label");
  check(out.includes("\\question\\TFQuestion{F}{Statement three.} %note on three"), "macros: same-line comment moves with its question");
  check(out.indexOf("% ---------- topic 2 ----------") > p2.questions[1].start && out.indexOf("% ---------- topic 2 ----------") < p2.questions[2].start, "macros: comment-only lines stay in place");
  check(out.length === src.length && X.reorder(src, p, qs.map((_, i) => i)) === src, "macros: nothing lost; identity reproduces the file");
}

// ---- nothing found ----
{
  const p = X.parse("\\documentclass{article}\\begin{document}Hello\\end{document}");
  check(!!p.error && p.questions.length === 0, "no questions → helpful error");
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
