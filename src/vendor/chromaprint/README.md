# Chromaprint (WebAssembly), vendored

Audio fingerprinting for the song recognition of media devices (`src/song-capture.ts`). Loaded only when a browser
actually listens: `song-capture.ts` is a lazily loaded chunk and fetches `chromaprint.wasm` next to it at runtime
(the build copies it to `chunks/chromaprint.wasm`). It is never part of the card's entry file.

| File | Origin |
|---|---|
| `chromaprint.js`, `chromaprint.wasm` | `@unimusic/chromaprint` 0.1.4 (npm, `dist/`), unmodified |
| `chromaprint.d.ts` | written for this project (types of the module) |

Licenses:

- [Chromaprint](https://github.com/acoustid/chromaprint) by Lukas Lalinsky: its own code is MIT, it includes parts of
  FFmpeg (the resampler) under LGPL-2.1, so the compiled library as a whole is **LGPL-2.1-or-later**.
- [KissFFT](https://github.com/mborgerding/kissfft) (the FFT it is built with): BSD-3-Clause.
- The Emscripten glue and the build (`@unimusic/chromaprint`, https://github.com/unimusic-app/unimusic-chromaprint,
  script `build-wasm.sh`): MIT, see `LICENSE-unimusic-chromaprint.md`.

LGPL compliance: the library stays a separate file that is loaded dynamically and used only through its public C API
(`chromaprint_new/start/feed/finish/get_fingerprint`). Anyone may replace `chromaprint.wasm` (together with
`chromaprint.js`) with their own build of Chromaprint made with the same script; the source code is available at the
links above. Details in `THIRD_PARTY.md`.

SHA-256 (as shipped):

- `chromaprint.js`   `6f2c33e45428a4f8824e3a3ae63ca3c75bfed7ca570f535005283a9cbbaff42c`
- `chromaprint.wasm` `7d31fa9acfc575b726f809e6441aff1d618c022b0d24f980db77075b0011b9ad`
