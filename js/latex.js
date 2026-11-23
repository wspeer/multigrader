/* MultiGrader — find the questions in a LaTeX test and reorder them.
 *
 * Supported layouts:
 *   • exam class:  \begin{questions} \question … \question … \end{questions}
 *     (also \titledquestion and \bonusquestion)
 *   • any class:   a numbered list \begin{enumerate} \item … \end{enumerate}
 *     (only items of top-level enumerate lists; nested lists stay inside
 *     their question, so answer choices move with it)
 *
 * Questions can be spread over several lists (e.g. one per part). Reordering
 * swaps question *contents* between the existing slots, so anything between
 * questions that isn't part of one stays where it is. That includes page breaks
 * and headings right after a question, such as \newpage, \clearpage,
 * \pagebreak, \uplevel{…}, \fullwidth{…} and \section{…}.
 */
(function (root) {
  "use strict";

  const VERBATIM = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim"]);
  const LISTS = new Set(["enumerate", "itemize", "description", "questions", "parts", "subparts", "subsubparts", "choices", "oneparchoices", "checkboxes", "oneparcheckboxes"]);
  const QUESTION_CMDS = new Set(["question", "titledquestion", "bonusquestion"]);
  const FIXED_CMDS = new Set(["newpage", "clearpage", "cleardoublepage", "pagebreak", "uplevel", "fullwidth", "section", "subsection", "subsubsection", "section*", "subsection*", "subsubsection*"]);

  /* Walk the source, skipping comments and verbatim, calling visit(kind, info). */
  function walk(src, from, to, visit) {
    let i = from;
    const stack = [];
    while (i < to) {
      const c = src[i];
      if (c === "%") {
        const j = src.indexOf("\n", i);
        i = j < 0 || j > to ? to : j + 1;
        continue;
      }
      if (c === "\\") {
        const m = /^\\([A-Za-z]+\*?|.)/.exec(src.slice(i, i + 64));
        if (!m) { i++; continue; }
        const name = m[1];
        if (name === "begin" || name === "end") {
          const mm = /^\\(begin|end)\s*\{([^}]*)\}/.exec(src.slice(i, i + 96));
          if (mm) {
            const env = mm[2];
            if (name === "begin" && VERBATIM.has(env)) {
              const endTok = "\\end{" + env + "}";
              const j = src.indexOf(endTok, i + mm[0].length);
              i = j < 0 ? to : j + endTok.length;
              continue;
            }
            visit(name, { pos: i, env, len: mm[0].length, stack });
            if (name === "begin") stack.push({ name: env, pos: i });
            else {
              for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === env) { stack.length = k; break; }
            }
            i += mm[0].length;
            continue;
          }
        }
        if (name === "verb" || name === "verb*") {
          const d = src[i + 1 + name.length];
          const j = src.indexOf(d, i + 2 + name.length);
          i = j < 0 ? to : j + 1;
          continue;
        }
        visit("cmd", { pos: i, name, len: m[0].length, stack });
        i += m[0].length;
        continue;
      }
      if (c === "{" || c === "}") visit(c, { pos: i, stack });
      i++;
    }
  }

  /* End of a command's arguments: optional *, then [..] and {..} groups. */
  function argsEnd(src, i, limit) {
    let j = i;
    for (;;) {
      let k = j;
      while (k < limit && /[ \t]/.test(src[k])) k++;
      if (src[k] === "[" || src[k] === "{") {
        const open = src[k], close = open === "[" ? "]" : "}";
        let depth = 0, p = k;
        for (; p < limit; p++) {
          if (src[p] === "\\") { p++; continue; }
          if (src[p] === open) depth++;
          else if (src[p] === close && --depth === 0) break;
        }
        if (p >= limit) return j;
        j = p + 1;
      } else return j;
    }
  }

  const blankish = (s) => s.replace(/(^|[^\\])%.*$/gm, "$1").trim() === "";

  /**
   * Parse a LaTeX test. Returns
   *   { mode: "exam" | "enumerate", questions: [{ start, bodyEnd, end, preview,
   *     choices, correct }], error }
   * start..bodyEnd is the question itself; bodyEnd..end stays in its slot.
   */
  function parse(src) {
    // 1. Candidate question starts and the end of each enclosing environment.
    const envEnd = new Map();
    const open = [];
    const qStarts = [], itemStarts = [];
    walk(src, 0, src.length, (kind, info) => {
      if (kind === "begin") open.push({ name: info.env, pos: info.pos });
      else if (kind === "end") {
        for (let k = open.length - 1; k >= 0; k--) {
          if (open[k].name === info.env) {
            for (let q = open.length - 1; q >= k; q--) envEnd.set(open[q], info.pos);
            open.length = k;
            break;
          }
        }
      } else if (kind === "cmd") {
        const top = open[open.length - 1];
        if (QUESTION_CMDS.has(info.name) && open.some((e) => e.name === "questions")) {
          qStarts.push({ pos: info.pos, parent: top });
        } else if (info.name === "item" && top && top.name === "enumerate" && open.filter((e) => LISTS.has(e.name)).length === 1) {
          itemStarts.push({ pos: info.pos, parent: top });
        }
      }
    });
    const mode = qStarts.length ? "exam" : "enumerate";
    const starts = qStarts.length ? qStarts : itemStarts;
    if (!starts.length) {
      return { mode, questions: [], error: "No questions found. MultiGrader looks for \\question inside \\begin{questions} (exam class), or \\item in a numbered \\begin{enumerate} list. If your questions are in separate files pulled in with \\input, upload a single combined file." };
    }

    // 2. Each question runs until the next question in the same list, or the end of that list.
    const questions = starts.map((s, k) => {
      let end = envEnd.has(s.parent) ? envEnd.get(s.parent) : src.length;
      for (let j = k + 1; j < starts.length; j++) if (starts[j].parent === s.parent) { end = Math.min(end, starts[j].pos); break; }
      return { start: s.pos, end };
    });

    // 3. Trailing page breaks / headings stay in the slot, not with the question.
    for (const q of questions) {
      const spans = [];
      let braces = 0, envs = 0;
      walk(src, q.start, q.end, (kind, info) => {
        if (kind === "{") braces++;
        else if (kind === "}") braces--;
        else if (kind === "begin") envs++;
        else if (kind === "end") envs--;
        else if (kind === "cmd" && braces === 0 && envs === 0 && FIXED_CMDS.has(info.name)) {
          spans.push({ start: info.pos, end: argsEnd(src, info.pos + info.len, q.end) });
        }
      });
      let t = q.end;
      for (let k = spans.length - 1; k >= 0; k--) {
        if (spans[k].start <= q.start) break;
        if (blankish(src.slice(spans[k].end, t))) t = spans[k].start;
        else break;
      }
      let b = t;
      while (b > q.start && /\s/.test(src[b - 1])) b--;
      q.bodyEnd = b;

      // Answer choices (exam class \choice / \CorrectChoice) for checking.
      const body = src.slice(q.start, q.bodyEnd);
      const choices = [];
      walk(body, 0, body.length, (kind, info) => {
        if (kind === "cmd" && (info.name === "choice" || info.name === "CorrectChoice")) choices.push(info.name === "CorrectChoice");
      });
      if (!choices.length && mode === "enumerate") {
        // Items of the first nested numbered list = the answer choices.
        let depth = 0, n = 0, list = 0, inChoices = false;
        walk(body, 0, body.length, (kind, info) => {
          if (kind === "begin" && LISTS.has(info.env)) {
            depth++;
            if (depth === 1) { list++; inChoices = list === 1 && info.env === "enumerate"; }
          } else if (kind === "end" && LISTS.has(info.env)) depth--;
          else if (kind === "cmd" && info.name === "item" && depth === 1 && inChoices) n++;
        });
        q.choices = n;
      } else q.choices = choices.length;
      q.correct = choices.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

      const text = body.replace(/^\\[A-Za-z]+\*?(\[[^\]]*\])?/, "").replace(/%.*$/gm, "").replace(/\s+/g, " ").trim();
      q.preview = text.length > 90 ? text.slice(0, 88) + "…" : text;
    }
    return { mode, questions, error: null };
  }

  /* Rebuild the document with question perm[k] in slot k. */
  function reorder(src, parsed, perm) {
    const qs = parsed.questions;
    let out = "", prev = 0;
    qs.forEach((slot, k) => {
      const q = qs[perm[k]];
      out += src.slice(prev, slot.start) + src.slice(q.start, q.bodyEnd) + src.slice(slot.bodyEnd, slot.end);
      prev = slot.end;
    });
    return out + src.slice(prev);
  }

  /* Change visible "Version A" labels (and \newcommand{\version}{A}) to another version. */
  function relabel(src, v) {
    let count = 0;
    let text = src.replace(/(\bVersion\s*[:\-]?\s*)A\b/g, (m, a) => { count++; return a + v; });
    text = text.replace(/(\\(?:re)?newcommand\s*\{?\\(?:version|testversion|examversion|ver)\}?\s*\{\s*)A(\s*\})/g, (m, a, b) => { count++; return a + v + b; });
    text = text.replace(/(\\def\s*\\(?:version|testversion|examversion|ver)\s*\{\s*)A(\s*\})/g, (m, a, b) => { count++; return a + v + b; });
    return { text, count };
  }

  root.MGLatex = { parse, reorder, relabel };
})(typeof window !== "undefined" ? window : globalThis);
