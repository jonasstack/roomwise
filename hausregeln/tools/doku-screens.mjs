// Doku screens of the Hausregeln panel from its preview (example data, nothing real), plus the box of each view in
// percent of the picture (hotspots for docs/doku/screens/hr-*.md). Every screen is also saved as an HTML copy
// (docs/doku/pages/<id>.html, flattened shadow DOM: tools/design/doku-page.mjs); --no-html skips that.
// Usage (in hausregeln/): node tools/doku-screens.mjs <outdir> [--no-html]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2];
const html = !process.argv.includes('--no-html');
const pages = html ? await (await import('../../tools/design/doku-page.mjs')).docPages() : null;
mkdirSync(out, { recursive: true });
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto('file://' + process.cwd() + '/dist/preview-local.html');
await p.waitForTimeout(600);
const P = (body) => p.evaluate(`(async () => { const panel = document.querySelector('house-rules-panel'); ${body} })()`);
const W = 1280, H = 800;
const pct = (b) => (b ? [b.x / W, b.y / H, b.width / W, b.height / H].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10) : null);
const res = {};
let route = 'rules';
const tab = async (t) => { route = t; await P(`panel._setTab('${t}'); await panel.updateComplete;`); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(500); };
const shot = async (name, sel) => {
  let box = null;
  if (sel) {
    const loc = p.locator(sel).first();
    if (!(await loc.count())) { console.error('missing', name, sel); return; }
    await loc.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    // the section's top at the top of the picture
    await loc.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 76));
    await p.waitForTimeout(300);
    box = await loc.boundingBox();
  }
  await p.screenshot({ path: `${out}/${name}.png` });
  res[name] = pct(box && { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, H - box.y) });
  if (pages) await pages.save(p, { id: name, url: `/hausregeln/${route}` });
};
// open states of a screen (doku standard 9: pages/<id>.s<n>.html, HTML copy only): click, save, undo
const state = async (id, label, sel, undo = 'again') => {
  if (!pages) return;
  const sels = [].concat(sel);
  const vis = (one) => p.locator(`${one} >> visible=true`).first();
  try {
    for (const one of sels) {
      if (typeof one === 'function') await one();
      else {
        if (!(await vis(one).count())) throw new Error(`nothing visible: ${one}`);
        label ??= `${(await vis(one).innerText()).split('\n')[0].trim().slice(0, 40)} aufgeklappt`;
        await vis(one).click({ timeout: 5000 });
      }
      await p.waitForTimeout(600);
    }
    await pages.state(p, { id, url: `/hausregeln/${route}`, label, trigger: sels.map((x) => (typeof x === 'function' ? 'Knopf' : x)).join(' → ') });
  } catch (e) {
    console.error(`state ${id} „${label}“: ${String(e.message).split('\n')[0]}`);
  }
  if (undo === 'again' && sels.length === 1) await vis(sels[0]).click({ timeout: 3000 }).catch(() => {});
  else if (typeof undo === 'function') await undo().catch(() => {});
  await p.waitForTimeout(300);
};
// since the redesign most screens are pop-ups (<hr-pop> on an <hr-sheet>): the box is the topmost sheet
const SHEET = 'hr-sheet section.sheet';
const top = async (name) => {
  await p.waitForTimeout(700);
  const loc = p.locator(SHEET).last();
  if (!(await loc.count())) { console.error('missing pop-up', name); return; }
  const box = await loc.boundingBox();
  await p.screenshot({ path: `${out}/${name}.png` });
  res[name] = pct(box && { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, H - box.y) });
  if (pages) await pages.save(p, { id: name, url: `/hausregeln/${route}` });
};
const closeAll = async () => {
  for (let i = 0; i < 5 && (await p.locator(SHEET).count()); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(250); }
};
const click = async (sel, n = 0) => { await p.locator(`${sel} >> visible=true`).nth(n).click({ timeout: 5000 }); await p.waitForTimeout(600); };
const gear = () => click('house-rules-panel .page-gear');
const tile = (view, n = 0) => click(`${view} .rl-open`, n);
// a state of a page that opens a pop-up, closed again afterwards
const popState = (id, label, open) => state(id, label, [open], closeAll);
const place = async (t, anchor) => { route = t; await P(`panel._setTab('${t}', '${anchor}'); await panel.updateComplete;`); };

await tab('rules'); await shot('hr-rules-view', 'hr-rules-view');
await popState('hr-rules-view', 'Vorschläge geöffnet', () => click('hr-rules-view .sugg-line'));
await popState('hr-rules-view', 'Regel geöffnet', () => tile('hr-rules-view'));
await gear(); await top('hr-rule-groups'); await closeAll();
await tab('light'); await shot('hr-light-view', 'hr-light-plans');
await popState('hr-light-view', 'Raum geöffnet', () => tile('hr-light-plans', 3));
await tile('hr-light-plans', 3); await click('hr-pop button.icon-btn[slot=head]'); await top('hr-light-basics'); await closeAll();
// Reinschau-Licht: its tile comes first (the preview has an example floor plan)
await tile('hr-light-plans', 0); await top('hr-light-glow');
await click('hr-light-glow polygon[aria-label="Schlafzimmer"]'); await top('hr-light-glow-room'); await closeAll();
await click('hr-light-plans .rl-hidden button'); await top('hr-room-arrange'); await closeAll();
await tab('heat'); await shot('hr-plans-view', 'hr-heat-plans');
await popState('hr-plans-view', 'Raum geöffnet', () => tile('hr-heat-plans', 2 + 3));
await popState('hr-plans-view', 'Standard für alle Räume', () => tile('hr-heat-plans', 0));
await tab('alarm'); await shot('hr-alarm-view', 'hr-alarm-view');
await popState('hr-alarm-view', 'Grundlagen (Zahnrad)', gear);
await popState('hr-alarm-view', 'Sensoren je Modus', () => tile('hr-alarm-view', 0));
await place('alarm', 'window-warning'); await top('hr-window-warning'); await closeAll();
await tab('home'); await shot('hr-home-view', 'hr-home-view');
await popState('hr-home-view', 'Person „Alex“ geöffnet', () => tile('hr-home-view', 0));
await place('home', 'mode-auto'); await top('hr-mode-auto'); await closeAll();
await place('home', 'places'); await top('hr-places-view'); await closeAll();
await tab('rooms'); await shot('hr-rooms-view', 'hr-rooms-view');
await tile('hr-rooms-view', 0); await top('hr-room-detail');
await click('hr-pop button.icon-btn[slot=head]'); await top('hr-room-settings'); await closeAll();
await gear(); await click('hr-pop .rl-item:has-text("Saugroboter")'); await top('hr-home-extras'); await closeAll();
await tab('devices'); await shot('hr-devices-view', 'hr-devices-view');
const dev = await P(`return (panel.store.devices ?? []).find((d) => d.kind === 'light')?.entity_id ?? null;`);
if (dev) { await P(`panel._device = ${JSON.stringify(dev)}; await panel.updateComplete;`); await top('hr-device-detail'); await P(`panel._device = null;`); await closeAll(); }
await tab('history'); await shot('hr-history-view', 'hr-history-view');
await popState('hr-history-view', 'Eintrag geöffnet', () => click('hr-history-view button.entry'));
await tab('settings'); await shot('hr-settings-view', 'hr-settings-view');
await popState('hr-settings-view', 'Funktionen', () => tile('hr-settings-view', 0));
await place('settings', 'ai'); await top('hr-ai-settings'); await closeAll();
await place('settings', 'urlaub'); await top('hr-vacation'); await closeAll();
// alarm centre (route /alarm)
await P(`panel.route = { prefix: '/hausregeln', path: '/alarm' }; await panel.updateComplete;`);
route = 'alarm';
await p.waitForTimeout(700);
await shot('hr-alarm-center', 'hr-alarm-center');
console.log(JSON.stringify(res));
if (pages) {
  for (const r of pages.results) console.error(`page ${r.id}: ${Math.round(r.size / 1024)} KB, ${r.sheets} style sheets, ${r.files} files`);
  await pages.close();
}
console.error(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
