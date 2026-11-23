/* MultiGrader — find the questions in a LaTeX test and reorder them.
 *
 * Supported layouts:
 *   • exam class:  \begin{questions} \question … \end{questions}
 *     (also \titledquestion and \bonusquestion; questions may sit inside
 *     environments such as multicols within the questions list)
 *   • any class:   a numbered list \begin{enumerate} \item … \end{enumerate}
 *     (only items of top-level enumerate lists; nested lists stay inside
 *     their question, so answer choices move with it)
 *
 * Reordering swaps question *contents* between the existing slots. Anything
 * between questions stays where it is: headings and instructions such as
 * \fullwidth{…} / \uplevel{…}, \setlength…, page breaks, comment-only lines,
 * and environment boundaries (e.g. \begin{multicols}). Questions are also
 * grouped into "blocks": consecutive questions with nothing but blank lines or
 * comments between them. A question never moves outside its block, so it
 * never crosses a heading.
 *
 * A \label placed right after \question stays with the *position* (so ranges
 * like "problems \ref{first} through \ref{last}" stay correct).
 *
 * Answers are read from the file when it marks them:
 *   • \CorrectChoice (exam class), or
 *   • a question macro whose first argument is the answer, e.g.
 *     \TFQuestion{F}{…}, \MCQuestion{B}{…}, \CAQuestion{A, C}{…}
 *     (several letters = all required).
 */
(function (root) {
  "use strict";

  const VERBATIM = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim"]);
  const LISTS = new Set(["enumerate", "itemize", "description", "questions", "parts", "subparts", "subsubparts", "choices", "oneparchoices", "checkboxes", "oneparcheckboxes"]);
  const QUESTION_CMDS = new Set(["question", "titledquestion", "bonusquestion"]);
  const FIXED_CMDS = new Set([
    "newpage", "clearpage", "cleardoublepage", "pagebreak", "uplevel", "fullwidth",
    "section", "subsection", "subsubsection", "section*", "subsection*", "subsubsection*",
    "setlength", "addtolength", "setcounter", "addtocounter",
  ]);

  /* Walk the source, skipping comments and verbatim, calling visit(kind, info). */
  function walk(src, from, to, visit) {
    let i = from;
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
            visit(name, { pos: i, env, len: mm[0].length });
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
        visit("cmd", { pos: i, name, len: m[0].length });
        i += m[0].length;
        continue;
      }
      if (c === "{" || c === "}") visit(c, { pos: i });
      i++;
    }
  }

  /* End of a command's arguments: optional *, then [..] and {..} groups.
   * Also accepts a bare control-sequence argument (\setlength\foo{..}). */
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
      } else if (src[k] === "\\" && /[A-Za-z]/.test(src[k + 1] || "") && j === i) {
        const m = /^\\[A-Za-z]+/.exec(src.slice(k, k + 64));
        j = k + m[0].length;
      } else return j;
    }
  }

  const blankish = (s) => s.replace(/(^|[^\\])%.*$/gm, "$1").trim() === "";

  /**
   * Parse a LaTeX test. Returns { mode, questions, error }. Each question has
   *   start..bodyEnd  the question itself (moves),
   *   headEnd         end of "\question[2]" (always travels with the question),
   *   labelStart/End  a \label right after the head (stays with the slot),
   *   bodyEnd..end    trailing material that stays in the slot,
   *   block           questions only move within their block,
   *   key             answer letters found in the file (or null), keyAll,
   *   choices         number of answer choices found (0 if none),
   *   preview         short plain-text preview.
   */
  function parse(src) {
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
          qStarts.push({ pos: info.pos, name: info.name, chain: open.slice() });
        } else if (info.name === "item" && top && top.name === "enumerate" && open.filter((e) => LISTS.has(e.name)).length === 1) {
          itemStarts.push({ pos: info.pos, name: info.name, chain: open.slice() });
        }
      }
    });
    const mode = qStarts.length ? "exam" : "enumerate";
    const starts = qStarts.length ? qStarts : itemStarts;
    if (!starts.length) {
      return { mode, questions: [], error: "No questions found. MultiGrader looks for \\question inside \\begin{questions} (exam class), or \\item in a numbered \\begin{enumerate} list. If your questions are in separate files pulled in with \\input, upload a single combined file." };
    }

    // A question ends at the next question, at the start of an environment
    // that holds the next question (e.g. \begin{multicols}), or at the end
    // of its own environment.
    const questions = starts.map((s, k) => {
      const P = s.chain[s.chain.length - 1];
      let end = envEnd.has(P) ? envEnd.get(P) : src.length;
      const nx = starts[k + 1];
      if (nx) {
        const idx = nx.chain.indexOf(P);
        if (idx === nx.chain.length - 1) end = Math.min(end, nx.pos);
        else if (idx >= 0) end = Math.min(end, nx.chain[idx + 1].pos);
      }
      return { start: s.pos, end, cmd: s.name };
    });

    for (const q of questions) {
      // Trailing headings / spacing commands stay in the slot.
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
      // Then trailing whitespace and whole-line comments (not a comment on
      // the question's own last line).
      let b = t;
      for (;;) {
        while (b > q.start && /\s/.test(src[b - 1])) b--;
        const ls = src.lastIndexOf("\n", b - 1) + 1;
        if (ls > q.start && /^[ \t]*%/.test(src.slice(ls, b))) { b = ls; continue; }
        break;
      }
      q.bodyEnd = b;

      // Head (\question[pts]) and a \label right after it.
      const body = src.slice(q.start, q.bodyEnd);
      const head = q.cmd === "titledquestion"
        ? /^\\titledquestion\*?\s*\{[^{}]*\}(\s*\[[^\]]*\])?/.exec(body)
        : /^\\[A-Za-z]+\*?(\s*\[[^\]]*\])?/.exec(body);
      q.headEnd = q.start + (head ? head[0].length : 0);
      const lab = /^\s*(\\label\s*\{[^}]*\}\s*)+/.exec(src.slice(q.headEnd, q.bodyEnd));
      q.labelStart = q.headEnd;
      q.labelEnd = q.headEnd + (lab ? lab[0].length : 0);

      // Answers marked in the file.
      const choices = [];
      walk(body, 0, body.length, (kind, info) => {
        if (kind === "cmd" && (info.name === "choice" || info.name === "CorrectChoice")) choices.push(info.name === "CorrectChoice");
      });
      q.key = null;
      q.keyAll = false;
      if (choices.length) {
        q.choices = choices.length;
        q.correctIdx = choices.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      } else {
        q.choices = mode === "enumerate" ? countItemChoices(body) : 0;
        q.correctIdx = [];
      }
      const mk = /^\s*\\([A-Za-z]*Question)\s*\{([^{}]*)\}/.exec(src.slice(q.labelEnd, q.bodyEnd));
      if (mk) {
        const letters = mk[2].split(/[\s,;]+/).filter(Boolean);
        if (letters.length && letters.every((x) => /^[A-Za-z0-9]$/.test(x))) {
          q.key = letters.map((x) => x.toUpperCase());
          q.keyAll = letters.length > 1;
          q.keyMacro = mk[1];
        }
      }

      let text = src.slice(q.labelEnd, q.bodyEnd);
      if (mk && q.key) text = text.slice(mk[0].length);
      text = text.replace(/%.*$/gm, "").replace(/\\(makebox|parbox)\s*(\[[^\]]*\])*/g, "").replace(/\s+/g, " ").trim();
      if (mk && q.key) text = text.replace(/^\{/, "").replace(/\}$/, "").trim();
      q.preview = text.length > 90 ? text.slice(0, 88) + "…" : text;
    }

    // Blocks: consecutive questions with only blank lines / comments between them.
    let block = 0;
    questions.forEach((q, k) => {
      if (k > 0 && !blankish(src.slice(questions[k - 1].bodyEnd, q.start))) block++;
      q.block = block;
    });
    return { mode, questions, error: null };
  }

  function countItemChoices(body) {
    let depth = 0, n = 0, list = 0, inChoices = false;
    walk(body, 0, body.length, (kind, info) => {
      if (kind === "begin" && LISTS.has(info.env)) {
        depth++;
        if (depth === 1) { list++; inChoices = list === 1 && info.env === "enumerate"; }
      } else if (kind === "end" && LISTS.has(info.env)) depth--;
      else if (kind === "cmd" && info.name === "item" && depth === 1 && inChoices) n++;
    });
    return n;
  }

  /* Rebuild the document with question perm[k] in slot k. */
  function reorder(src, parsed, perm) {
    const qs = parsed.questions;
    let out = "", prev = 0;
    qs.forEach((slot, k) => {
      const q = qs[perm[k]];
      out += src.slice(prev, slot.start) +
        src.slice(q.start, q.headEnd) + // \question[pts] of the moved question
        src.slice(slot.labelStart, slot.labelEnd) + // the slot's own \label
        src.slice(q.labelEnd, q.bodyEnd) + // the moved question's content
        src.slice(slot.bodyEnd, slot.end); // what follows the slot
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
