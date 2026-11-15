// Compares the HTML copies of the doku screens (docs/doku/pages/<id>.html) with their pictures
// (docs/doku/assets/screens/<id>.png): opens each copy at the picture's size and scroll position (meta doku-scroll),
// photographs it and counts the pixels that differ clearly. Writes picture | copy | difference side by side to
// <outdir>/<id>.png for a look. Not a pixel test – fonts and animations differ a little; layout, colours, texts and
// icons must match.
// Usage: node tools/design/doku-pages-check.mjs <outdir> [id,id …]   (run under: sh tools/heavy.sh browser …)
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../pw.mjs';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'doku');
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node tools/design/doku-pages-check.mjs <outdir> [ids]');
mkdirSync(OUT, { recursive: true });
const only = process.argv[3]?.split(',');
const ids = readdirSync(join(DOC, 'pages')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).filter((id) => !only || only.includes(id));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
// served over http: browsers refuse fonts from file:// pages
const server = http.createServer((req, res) => {
  const f = join(DOC, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(DOC) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
const page = await ctx.newPage();
const rows = [];
for (const id of ids) {
  const png = join(DOC, 'assets', 'screens', `${id}.png`);
  if (!existsSync(png)) { rows.push(`${id}: no picture`); continue; }
  await page.goto(`${origin}/pages/${id}.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const [x, y] = (await page.evaluate(() => document.querySelector('meta[name=doku-scroll]')?.content ?? '0,0')).split(',').map(Number);
  await page.evaluate(([x, y]) => window.scrollTo(x, y), [x, y]);
  await page.waitForTimeout(400);
  const copy = await page.screenshot();
  // compare in the browser: share of pixels whose colour differs by more than 48 (sum of channels)
  const res = await page.evaluate(async ([a, b]) => {
    const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.naturalWidth, h = ia.naturalHeight;
    const px = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    const out = new OffscreenCanvas(w * 3, h); const g = out.getContext('2d');
    g.drawImage(ia, 0, 0); g.drawImage(ib, w, 0);
    const diff = g.createImageData(w, h);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 48) { bad++; diff.data[i] = 255; diff.data[i + 3] = 255; } else { diff.data[i] = diff.data[i + 1] = diff.data[i + 2] = 255 - (da[i] + da[i + 1] + da[i + 2]) / 12; diff.data[i + 3] = 255; }
    }
    g.putImageData(diff, w * 2, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { share: bad / (w * h), img: btoa(s) };
  }, [readFileSync(png).toString('base64'), copy.toString('base64')]);
  writeFileSync(join(OUT, `${id}.png`), Buffer.from(res.img, 'base64'));
  rows.push(`${id}: ${(res.share * 100).toFixed(1)} % of the pixels differ`);
}
console.log(rows.join('\n'));
await browser.close();
server.close();
