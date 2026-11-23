# MultiGrader

Build multiple-choice tests with the answer sheet built in, print a **named sheet
for every student**, and grade them with a phone or webcam.

No accounts, no server, no build step. It's a static web page, and everything is
stored in your browser on your device.

## How it works

1. **Classes.** Create a class and add its roster. You can paste a
   **screenshot** of the roster (Ctrl+V / ⌘V), drop an image file, or paste text:
   one student per line (`Last, First` or `First Last`), or rows copied from a
   spreadsheet or CSV export, with or without a header row. A form or grade in
   brackets, such as `(IV)` or `(11)`, or a Form/Grade/Year column, is saved as
   the student's optional **Form**. Other tags like "Advanced" or "AP", and
   numbering, emails and IDs, are dropped. You check and edit the names in a
   preview before they're added, and students already in the class are skipped.
   Screenshots are read in the browser with the bundled Tesseract OCR engine
   (`vendor/tesseract`). Nothing is uploaded, but it can drop accents
   (Román → Roman), so check the preview.
2. **Build.** Create a test and list its sections, for example *5 × True/False,
   4 × Always/Sometimes/Never, 16 × A–E*, with points per question. The answer
   sheet is generated from that format, so there's no separate sheet to set up
   and no library of old sheets. Enter the key by typing letters into each
   section's box (`TFFTF`, `CADBE`…) or by clicking bubbles. For more than one
   letter, shift-click or type:
   - `(AC)`: **either**. Bubbling A alone or C alone earns full credit.
   - `[AC]`: **all required**. The student must bubble exactly A and C; there's
     no partial credit.

   A tag on each multi-letter row switches between the two.
3. **Print.** **⬇ Download PDF** gives one Letter-size page per sheet: one for
   each student with their name on it, plus optional blank sheets (the student
   writes a name, and you match it after scanning) and an answer-key sheet you
   can scan to double-check the key. Print the PDF at *Actual size*, or send it
   to your copy room. The PDF is made in the browser, with no upload.
4. **Scan.** Use *Start camera* (webcam, or a phone's back camera) and hold up
   sheets one after another. Each sheet beeps when it's recorded. Or take photos
   with the phone's camera app and grade a whole stack with *Scan photos…*.
   Sheets can be scanned in any order, sideways or upside down, and mixed across
   tests: each sheet's code strip says which test and which student it is.
5. **Results.** Scores, mean/median/high/low, who hasn't been scanned, and an
   item analysis (how often each answer was chosen, with low-scoring questions
   highlighted). Click **Review** to see the scanned sheet with every mark
   outlined, and click a letter to fix anything misread. Changing the key
   regrades everything. Export results as CSV.

### Versions

Under **Build → Versions**, choose 2–6 versions (A–F). Version A uses the
question order you built. For each other version, type the Version A question
numbers in the order they appear on that version (for example `3 1 2 6 4 5`), or
click **Shuffle**. Each version's key is worked out automatically and shown so
you can check it against your printed test.

- Questions move only within their own section, so every version uses the
  same answer sheet. The sheet gets a **VERSION** bubble row at the top.
- Each sheet is graded with its version's key. Results, item analysis and the
  CSV use **Version A numbering**, so a question's statistics combine every
  version.
- If a student leaves the version blank (or bubbles two), the sheet is graded as
  the version that fits best and flagged. You can change the version in Review.
- The answer-key sheet option prints one key sheet per version.
- **Keep in place:** Version A question numbers listed here never move when
  shuffling, for example questions that share a figure.
- **Shuffle, Undo, Lock:** every Shuffle gives a new order, and **↶ Undo**
  goes back one step. When you're happy with a version, click **🔒 Lock order**.
  Shuffle, "Same as A" and editing are then turned off for that version (you
  can still download its `.tex`). **Unlock…** asks for confirmation and warns
  you if scanned sheets already use that version.

#### Making the versions from your LaTeX file

In the Versions card, **Upload Version A .tex…**. MultiGrader finds the
questions: `\question` (also `\titledquestion` and `\bonusquestion`) inside
`questions` in the exam class, or `\item` in top-level numbered `enumerate`
lists, which may be spread over several lists. Click **Shuffle**, then
**⬇ Version B .tex** to get the reordered file. That version's answer key is
already set, and it's written as a comment at the top of the file.

- Answer choices, figures, `solution` blocks, same-line comments and anything
  else inside a question move with it. Everything between questions stays where
  it is: headings and instructions (`\fullwidth{…}`, `\uplevel{…}`,
  `\section{…}`), spacing (`\setlength…`), page breaks, comment-only lines, and
  environment boundaries such as `\begin{multicols}`.
- **Groups:** questions separated by a heading or instructions in the file form
  a group. Shuffle never moves a question out of its group, even when two parts
  share one MultiGrader section. For example, two A–C parts can be one section
  without being mixed.
- **Labels:** a `\label{…}` right after `\question` stays with the position, so
  "problems `\ref{first}` through `\ref{last}`" stays correct.
- **Answers in the file:** if the file marks answers with `\CorrectChoice`, or
  with a question macro whose first argument is the answer (`\TFQuestion{F}{…}`,
  `\MCQuestion{B}{…}`, `\CAQuestion{A, C}{…}`; several letters means all are
  required), MultiGrader checks them against your key and can fill the key in.
  With `\printanswers` on, the reordered file prints the new version's key.
- "Version A" in the text, and `\newcommand{\version}{A}`, become the new
  version letter. Tip: define `\newcommand{\version}{A}` and put
  `Version \version` in your header.
- The number of questions found must match the test's format; the list of
  what was found is shown so you can check it. Answer choices aren't shuffled,
  only questions.
- The uploaded file is kept only until you leave the page. Comments, `verbatim`
  and `\verb` are ignored when looking for questions. Questions pulled in with
  `\input{…}` aren't seen, so upload a single combined file.
- Results can be filtered by version.

### Question types

True/False, Always/Sometimes/Never, Yes/No, A–B through A–F, or any custom set of
up to 6 single-character choices. One sheet holds up to 108 questions (fewer when
questions have six choices).

### Things to know

- **Format lock.** Once sheets are printed, the bubble layout of that test is locked
  so printed sheets stay readable. (Points and the key can still change.) Choosing
  *Change format anyway* gives the test a new code, so old sheets are rejected
  instead of misread, and you reprint.
- **Flags.** The scanner flags questions it isn't sure about: two bubbles filled (unless the key requires several),
  a likely erasure, a very light mark, or a smudged area. Flagged questions are
  highlighted in Review and counted as "to check" in Results.
- **Camera access** needs the page to be served over `https` (GitHub Pages is fine)
  or from `localhost`. Opening `index.html` directly from disk works for
  everything except the live camera; *Scan photos…* still works.

## Data and privacy

Everything (rosters, tests, keys, results, and the scanned images used for review)
stays in this browser's storage on this device. Nothing is uploaded.

To scan on a phone with tests made on a laptop, use **Data → Export backup**, send
the file to the phone (AirDrop, email, Drive), and **Import** it there. Do the
same in reverse to bring results back. Imports merge: newer edits win, and
nothing is deleted. Backups contain student names and scores, so treat the file
like a gradebook.

## How the scanner works

`js/scanner.js` is plain JavaScript with no libraries:

1. Finds the four QR-style corner squares (adaptive threshold → connected
   components → "ring with a solid centre" test), then refines their centres at
   full resolution.
2. Tries each of the four possible orientations, maps page millimetres to image
   pixels with a homography, and reads the 38-cell ID strip (test code, sheet
   code, CRC-8). A valid checksum gives the orientation and identifies the
   sheet.
3. Aligns each column, then each block of rows, against the printed bubble
   outlines. This handles paper that isn't perfectly flat.
4. Measures how dark each bubble is compared with the paper right next to it
   (so shadows don't count as marks), then decides blank / answer / multiple and
   flags uncertain questions.

The sheet layout lives in `js/layout.js` and is used by both the printer and the
scanner, so the two can't disagree.

## Development

```
index.html        app shell
styles.css
js/layout.js      sheet geometry, ID code, shapes for SVG and PDF
js/scanner.js     image → answers
js/store.js       localStorage / IndexedDB data, grading, backup merge
js/latex.js       find and reorder questions in a LaTeX file
js/pdf.js         answer sheets as a PDF (vector, built-in Helvetica, no libraries)
js/roster.js      pasted / recognized roster text → names (+ optional Form)
js/ocr.js         read a roster screenshot (bundled Tesseract, loaded on demand)
vendor/tesseract/ OCR engine + English model (Apache-2.0; see its README)
js/app.js         UI
tests/            synthetic scanner tests + end-to-end test (Playwright)
```

Run the tests (needs Node and Playwright):

```bash
node tests/run-scanner-tests.js   # 15 synthetic photos: tilt, rotation, curl, shadow, blur, low-res…
node tests/e2e.js                 # class → test → print → fill + photograph → scan → results
node tests/e2e-versions.js        # versions, either / all-required keys, missing version bubble
node tests/latex-test.js          # finding and reordering questions in .tex files
node tests/e2e-latex.js           # upload .tex → key from \CorrectChoice → shuffle → download
node tests/pdf-test.js            # PDF download: page size, text, every page scans (needs poppler-utils)
node tests/roster-test.js         # roster text formats (CSV/spreadsheet/OCR lines, Form)
node tests/e2e-roster.js          # roster import: text, duplicates, screenshot via file and paste
```

## Deploying

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`. If
Pages isn't enabled yet, turn it on under **Settings → Pages → Source: GitHub
Actions**.
