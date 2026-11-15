# Third-party material

roomwise's own code is under the [MIT License](LICENSE). The release bundles include the following
third-party work. All of it allows redistribution, also commercially.

## Libraries bundled into the card and the panel

| Library | Used in | License | Copyright |
|---|---|---|---|
| [Lit](https://lit.dev) (`lit`, `lit-html`, `lit-element`, `@lit/reactive-element`) | card, Hausregeln panel | BSD-3-Clause | Google LLC |
| [three.js](https://threejs.org) (core plus `GLTFLoader`, `BufferGeometryUtils`, `SkeletonUtils` from `examples/jsm`) | card | MIT | three.js authors |
| [Material Design Icons](https://pictogrammers.com/library/mdi/) (`@mdi/js`, only the icons used) | Hausregeln panel | Apache-2.0 | Pictogrammers |

## Loaded separately, only in the editor (reading a Wi-Fi QR code from a picture)

Part of the editor's lazily loaded chunk, never the card's entry file. Vendored in
[`src/vendor/jsqr/`](src/vendor/jsqr/README.md) (origin, checksum, license text).

| Library | License | Copyright |
|---|---|---|
| [jsQR](https://github.com/cozmo/jsQR) 1.4.0 | Apache-2.0 | Cosmo Wolfe |

## Loaded separately, only for song recognition

Not part of the card's entry file: a lazily loaded chunk (`chunks/song-capture-*.js`) and the WebAssembly file
`chunks/chromaprint.wasm`, fetched only when a browser the owner picked actually listens for a song. Vendored in
[`src/vendor/chromaprint/`](src/vendor/chromaprint/README.md) (origin, checksums).

| Library | License | Copyright |
|---|---|---|
| [Chromaprint](https://github.com/acoustid/chromaprint) (compiled to WebAssembly, `chromaprint.wasm`) | LGPL-2.1-or-later (its own code is MIT; it includes parts of FFmpeg under LGPL-2.1) | Lukas Lalinsky, FFmpeg authors |
| [KissFFT](https://github.com/mborgerding/kissfft) (inside `chromaprint.wasm`) | BSD-3-Clause | Mark Borgerding |
| [`@unimusic/chromaprint`](https://github.com/unimusic-app/unimusic-chromaprint) 0.1.4 (the WebAssembly build and its Emscripten glue `chromaprint.js`) | MIT | Im-Beast |

LGPL: Chromaprint is used as a separate, dynamically loaded file and only through its public C API. You may replace
`chromaprint.wasm` (together with the glue in the chunk) with your own build of Chromaprint, for example with the
`build-wasm.sh` script of `@unimusic/chromaprint`; the complete source code is available at the links above. The
LGPL-2.1 text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

The license headers of these libraries stay in the built files (`floorplan-card.js`, `house-rules-panel.js`).
In the card, icons are not bundled: it uses the Material Design Icons that Home Assistant provides at runtime.
No fonts are bundled; both use the system font of the device.

## 3D models

In `models/` (copied to `custom_components/floorplan_card/frontend/models/` by the build). Details in
[`models/LICENSE.md`](models/LICENSE.md).

| File | Author | License |
|---|---|---|
| `dog-shiba.glb`, `dog-husky.glb` | [Quaternius](https://quaternius.com), via [poly.pizza](https://poly.pizza) | CC0 1.0 (public domain) |
| `car-hatch.glb`, `car-sedan.glb`, `car-suv.glb` ("Normal Car 1/2", "SUV") | [Quaternius](https://quaternius.com), via [poly.pizza](https://poly.pizza) | CC0 1.0 (public domain) |

The models were slimmed down (duplicate animations removed, vertex data quantized); paint, lights and glass are
restyled by the card. All furniture, appliances, floors and the dog and cat figures of the plan are drawn in code.

## Sounds of the Hausregeln alarm

In `hausregeln/custom_components/house_rules/sounds/`. Details in
[`QUELLEN.md`](hausregeln/custom_components/house_rules/sounds/QUELLEN.md).

| File | Source | License |
|---|---|---|
| `sirene.mp3` | [BigSoundBank](https://bigsoundbank.com) #3258 "National alert signal, test" (first 60 s) | CC0 |
| `martinshorn.mp3` | BigSoundBank #2031 "Ambulance, 3 tons siren, passage" | CC0 |
| `evakuierung.mp3` | BigSoundBank #3411 "Evacuation Alarm #1" (repeated 10 times) | CC0 |
| `alarm.mp3` | BigSoundBank #3413 "Evacuation Alarm #3" (repeated 3 times) | CC0 |
| `gong.mp3` | BigSoundBank #2153 "Subway Door Bell #1" | CC0 |
| `piepen.mp3` | generated for roomwise (1760 Hz, 30 beeps) | public domain |

Loudness was normalised and the files converted to mono, 128 kbit/s.

## Python

Neither integration installs Python packages of its own (`requirements` is empty). They use `aiohttp`,
`cryptography` and `voluptuous`, which ship with Home Assistant.

## Services roomwise can talk to

Only when an administrator sets them up in Hausregeln: the chosen AI provider (a local Ollama, or Google Gemini,
OpenAI, Anthropic, Mistral or an OpenAI-compatible service), CallMeBot for Telegram and Signal alarm messages,
and your own SMTP server for alarm e-mails. Their terms apply to your use of them; nothing of theirs is bundled.
