# MultiGrader

Build multiple-choice tests with the answer sheet built in, print a **named sheet
for every student**, and grade them with a phone or webcam.

No accounts, no server, no build step. It's a static web page, and everything is
stored in your browser on your device.

## How it works

1. **Classes.** Create a class and paste in the roster (`Last, First`, `First Last`,
   or two columns copied from a spreadsheet).
2. **Build.** Create a test and list its sections, for example *5 × True/False,
   4 × Always/Sometimes/Never, 16 × A–E*, with points per question. The answer
   sheet is generated from that format, so there's no separate sheet to set up
   and no library of old sheets. Enter the key by typing letters into each
   section's box (`TFFTF`, `CADBE`…) or by clicking bubbles. Shift-click, or
   type `(AC)`, to accept more than one answer.
3. **Print.** One sheet per student with their name printed on it, plus optional
   blank sheets (the student writes a name, and you match it after scanning) and an
   answer-key sheet you can scan to double-check the key.
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

### Question types

True/False, Always/Sometimes/Never, Yes/No, A–B through A–F, or any custom set of
up to 6 single-character choices. One sheet holds up to 108 questions (fewer when
questions have six choices).

### Things to know

- **Format lock.** Once sheets are printed, the bubble layout of that test is locked
  so printed sheets stay readable. (Points and the key can still change.) Choosing
  *Change format anyway* gives the test a new code, so old sheets are rejected
  instead of misread, and you reprint.
- **Flags.** The scanner flags questions it isn't sure about: two bubbles filled,
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
js/layout.js      sheet geometry, ID code, SVG rendering
js/scanner.js     image → answers
js/store.js       localStorage / IndexedDB data, grading, backup merge
js/app.js         UI
tests/            synthetic scanner tests + end-to-end test (Playwright)
```

Run the tests (needs Node and Playwright):

```bash
node tests/run-scanner-tests.js   # 13 synthetic photos: tilt, rotation, curl, shadow, blur, low-res…
node tests/e2e.js                 # class → test → print → fill + photograph → scan → results
```

## Deploying

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`. If
Pages isn't enabled yet, turn it on under **Settings → Pages → Source: GitHub
Actions**.
