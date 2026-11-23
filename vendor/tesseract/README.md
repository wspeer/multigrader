# Bundled text recognition (OCR)

Used only by **Classes → Import a roster from a screenshot**, and loaded only when
that's used. Everything runs in the browser; images are never uploaded.

| File | From | License |
| --- | --- | --- |
| `tesseract.min.js`, `worker.min.js` | [tesseract.js](https://github.com/naptha/tesseract.js) 6.0.1 (`dist/`) | Apache-2.0 (`LICENSE-tesseract.js.md`) |
| `tesseract-core-simd-lstm.wasm.js`, `tesseract-core-lstm.wasm.js` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) 6.0.0 | Apache-2.0 (`LICENSE-tesseract.js-core`) |
| `lang/eng.traineddata.gz` | `@tesseract.js-data/eng` 1.0.0, `4.0.0_best_int` (from [tesseract-ocr/tessdata_best](https://github.com/tesseract-ocr/tessdata_best)) | Apache-2.0 |

To update, copy the same files from newer versions of those npm packages.
