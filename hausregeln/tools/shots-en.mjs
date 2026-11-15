// Screenshots of the preview in English (?lang=en): every area once, the editor and a phone view.
// Usage: node tools/build.mjs && node tools/shots-en.mjs <outdir>   (run through tools/heavy.sh browser)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2] || 'dist/shots-en';
mkdirSync(out, { recursive: true });
const page0 = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`;
writeFileSync('dist/preview-en.html', page0);
const url = 'file://' + process.cwd() + '/dist/preview-en.html?lang=en';
const browser = await chromium.launch();
const errors = [];
async function open(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light', deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(url);
  await p.waitForTimeout(500);
  return p;
}
const shot = (p, name, full = false) => p.screenshot({ path: join(out, name + '.png'), fullPage: full });
const tab = async (p, i) => {
  await p.locator('house-rules-panel nav button').nth(i).click();
  await p.waitForTimeout(350);
};

let p = await open(1280, 860);
await shot(p, 'en-01-rules', true);
await p.locator('hr-rules-view article.rule').first().click();
await p.waitForTimeout(400);
await shot(p, 'en-02-editor');
await p.locator('house-rules-editor .tap.verb').first().click();
await p.waitForTimeout(300);
await shot(p, 'en-03-picker');
await p.keyboard.press('Escape');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
const names = await p.locator('house-rules-panel nav button').allInnerTexts();
for (const [i, n] of names.entries()) {
  if (i === 0) continue;
  await tab(p, i);
  await shot(p, `en-1${i}-${n.trim().toLowerCase().replace(/[^a-z]+/g, '-') || 'tab'}`, true);
}
await p.close();
p = await open(390, 844);
await shot(p, 'en-30-phone-rules', true);
await p.close();
await browser.close();
console.log('tabs:', names.map((n) => n.trim()).join(' | '));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
