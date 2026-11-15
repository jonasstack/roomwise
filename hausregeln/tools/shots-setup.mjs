// Screenshots of the new structure and the setup wizard in the preview (example data), phone + desktop, light + dark.
// Usage: node tools/shots-setup.mjs <outdir>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2] || 'dist/shots-setup';
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
const url = 'file://' + process.cwd() + '/dist/preview-local.html';
const browser = await chromium.launch();
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [w, h, scheme, tag] of [
  [1280, 900, 'light', 'D-light'],
  [390, 844, 'dark', 'P-dark'],
  [390, 844, 'light', 'P-light'],
  [1280, 900, 'dark', 'D-dark'],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(url);
  await sleep(400);
  const panel = p.locator('house-rules-panel');
  const shot = (name, full = false) => p.screenshot({ path: join(out, `${tag}-${name}.png`), fullPage: full });
  const tab = async (label) => {
    await panel.locator(`nav button:has-text("${label}")`).first().click();
    await sleep(350);
  };
  await shot('01-rules');
  for (const [label, name] of [['Zuhause', '02-home'], ['Räume', '03-rooms'], ['Geräte', '04-devices'], ['Licht', '05-light']]) {
    await tab(label);
    await shot(name, true);
  }
  await panel.locator('nav .gear').click();
  await sleep(350);
  await shot('06-settings', true);
  if (tag === 'D-light' || tag === 'P-dark' || tag === 'P-light') {
    await p.locator('hr-settings-view button:has-text("Starten")').click();
    await sleep(500);
    const wiz = p.locator('hr-setup-wizard');
    for (let i = 1; i <= 13; i++) {
      await shot(`10-wizard-${String(i).padStart(2, '0')}`);
      // answer yes on yes/no steps to show the guided part
      const yes = wiz.locator('.choice button').first();
      if (await yes.count()) {
        await yes.click();
        await sleep(250);
        await shot(`10-wizard-${String(i).padStart(2, '0')}b`);
      }
      const next = wiz.locator('footer .btn.primary');
      if ((await next.textContent())?.includes('Fertig')) break;
      await next.click();
      await sleep(450);
    }
  }
  await ctx.close();
}
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no console errors');
