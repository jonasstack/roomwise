// Long-run check: states change every few seconds (faked, nothing reaches HA); every 30 s heap, GPU objects,
// DOM size and render rate are logged. Usage: node tools/design/soak.mjs [minutes] [scenario: mixed|rain]
import { openHA } from '../pw.mjs';
import { fakeStates, cardFn } from './fake.mjs';
const minutes = Number(process.argv[2] ?? 10);
const mode = process.argv[3] ?? 'mixed';
process.env.PW_ARGS = (process.env.PW_ARGS ?? '') + ' --enable-precise-memory-info --js-flags=--expose-gc';
const { browser, page, errors } = await openHA({ size: process.env.SOAK_SIZE ?? '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'tts', 'notify', 'scene', 'script', 'automation', 'input_boolean', 'remote', 'lock', 'button'] });
const card = cardFn(page);
await page.waitForTimeout(2000);
// count rAF callbacks and renders
await page.evaluate(() => {
  window.__raf = 0;
  const o = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => o((t) => { window.__raf++; cb(t); });
});
const sample = () => card(`(async () => {
  window.gc?.();
  const gl = plan.gl; const r = gl?.renderer;
  let nodes = 0; const walk = (root) => { for (const el of root.querySelectorAll('*')) { nodes++; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document);
  const s = { heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), nodes,
    geo: r?.info.memory.geometries, tex: r?.info.memory.textures, progs: r?.info.programs?.length,
    mats: gl?.materials?.size, texCache: gl?.textures?.size, colors: gl?.colorCache?.size, shimmer: gl?.shimmer?.length,
    renders: gl?.renders ?? null, wx: [...card.shadowRoot.querySelectorAll('fp-ambient')].reduce((n, a) => n + (a.wx?.draws ?? 0), 0), raf: window.__raf };
  return s; })()`);
const t0 = Date.now();
let i = 0;
let prev = await sample();
console.log('t=0', JSON.stringify(prev));
let nextLog = t0 + 30000;
const conds = mode === 'rain' ? ['rainy', 'pouring', 'rainy'] : ['sunny', 'rainy', 'cloudy', 'partlycloudy', 'pouring', 'fog'];
while (Date.now() - t0 < minutes * 60000) {
  i++;
  const sc = { weather: conds[Math.floor(i / 6) % conds.length], cover: 30 + (i % 7) * 10, lights: i % 2 === 0, heat: i % 3 !== 0, open: i % 4 === 0 ? ['binary_sensor.fenster_kueche', 'binary_sensor.tuer_wohnzimmer'] : [] };
  await fakeStates(page, sc);
  await page.waitForTimeout(3000);
  if (Date.now() >= nextLog) {
    const s = await sample();
    const sec = (Date.now() - nextLog + 30000) / 1000;
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ ...s, rafPerS: +((s.raf - prev.raf) / sec).toFixed(1), rendersPerS: +((s.renders - prev.renders) / sec).toFixed(1), wxPerS: +((s.wx - prev.wx) / sec).toFixed(1) }));
    prev = s;
    nextLog = Date.now() + 30000;
  }
}
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'console: ok');
await browser.close();
