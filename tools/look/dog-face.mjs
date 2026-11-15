// Close-ups of the dog's face in a standalone studio (no Home Assistant, nothing saved): every breed from the
// front, three-quarter and side, plus the whole dog. Usage: node tools/look/dog-face.mjs <outdir> [tag]
// PW_ENGINE=chromium|webkit|firefox; BREEDS=medium,husky,… to limit; COARSE=1 for the plan's level of detail.
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { launch } from '../pw.mjs';
const out = process.argv[2] ?? 'dog-face';
const tag = process.argv[3] ?? 'face';
mkdirSync(out, { recursive: true });
const js = (await esbuild.build({ entryPoints: ['tools/look/harness/dog-face-entry.ts'], bundle: true, format: 'esm', write: false, logLevel: 'error' })).outputFiles[0].text;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.route('http://fp.local/**', (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p === '/') return r.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#e9e5df"><canvas></canvas><script type="module" src="/s.js"></script>' });
  if (p === '/s.js') return r.fulfill({ contentType: 'text/javascript', body: js });
  if (p.startsWith('/models/')) return r.fulfill({ contentType: 'model/gltf-binary', body: readFileSync('.' + p) });
  r.fulfill({ status: 404, body: '' });
});
await page.goto('http://fp.local/');
await page.waitForFunction(() => window.renderDog);
const LOOKS = {
  medium: { fur: '#c8a27a', marks: '#f1ebe1' },
  small: { fur: '#e0c9a6', marks: '#f6efe4' },
  husky: { fur: '#4a4f57', marks: '#f1ebe1', markings: 'mask' },
  poodle: { fur: '#2c2c2e', marks: '#2c2c2e' },
  retriever: { fur: '#e0a55a', marks: '#f1ebe1' },
  dachshund: { fur: '#6b4a36', marks: '#c8a27a' },
  pug: { fur: '#d8c3a5', marks: '#2c2c2e', markings: 'mask' },
  maltipoo: { fur: '#e6d3b8', marks: '#e6d3b8' },
  shepherd: { fur: '#7a5230', marks: '#2c2420', markings: 'mask' },
  frenchie: { fur: '#3a3533', marks: '#f1ebe1' },
};
const breeds = (process.env.BREEDS ?? Object.keys(LOOKS).join(',')).split(',');
const VIEWS = (process.env.VIEWS ?? 'front,q34,side,full').split(',');
const CAM = { front: [0, 0.1, 0.28], q34: [-0.6, 0.18, 0.3], side: [-Math.PI / 2, 0.06, 0.34], full: [-0.75, 0.32, 1], eye: [-1.25, 0.12, 0.13], efront: [0, 0.05, 0.16] };
for (const b of breeds) {
  for (const v of VIEWS) {
    const [az, el, zoom] = CAM[v];
    // face views look at the head (front of the dog, up)
    const face = v !== 'full';
    await page.evaluate((o) => window.renderDog(o), { look: { breed: b, ...LOOKS[b] }, az, el, zoom, face, size: face ? [400, 340] : [480, 400], fine: !process.env.COARSE });
    await page.locator('canvas').screenshot({ path: `${out}/${tag}-${b}-${v}.png` });
  }
}
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
