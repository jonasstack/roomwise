// Screenshots of the setup wizard (Einstellungen → Einrichtung) in the preview (example data), every step, desktop + phone.
// Usage: node tools/shots-wizard.mjs <outdir>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2] || 'dist/shots-wizard';
mkdirSync(out, { recursive: true });
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
const url = 'file://' + process.cwd() + '/dist/preview-local.html';
const browser = await chromium.launch();
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [w, h, scheme, tag] of [
  [1280, 900, 'light', 'D'],
  [390, 844, 'dark', 'P'],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(url);
  await sleep(400);
  await p.evaluate(() => document.querySelector('house-rules-panel').dispatchEvent(new CustomEvent('hr-setup', { detail: { restart: true } })));
  await sleep(500);
  const wiz = p.locator('hr-setup-wizard');
  for (let i = 1; i <= 18; i++) {
    const head = await wiz.locator('hr-pop').getAttribute('heading');
    await p.screenshot({ path: join(out, `${tag}-${String(i).padStart(2, '0')}.png`) });
    console.log(tag, i, head);
    const next = wiz.locator('footer .btn.primary');
    if ((await next.textContent())?.includes('Fertig')) break;
    await next.click();
    await sleep(450);
  }
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `Fehler: ${errors.join('\n')}` : 'keine Fehler');
