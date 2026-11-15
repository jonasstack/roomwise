// Object library in the editor: all (grouped), a few categories and searches. Opens the editor, never saves.
// Usage: FP_LOCAL=1 node tools/design/library-shots.mjs <outdir> [light|dark] [size]
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const size = process.argv[4] ?? '1280x900';
const { browser, page, errors } = await openHA({ size, scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'lock', 'siren', 'alarm_control_panel'] });
const ED = 'floorplan-card-editor-ui';
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1000);
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.waitForTimeout(600);
const panel = page.locator(`${ED} .panel`).first();
const shot = async (n) => {
  await page.waitForTimeout(400);
  await panel.screenshot({ path: `${out}/lib-${n}-${scheme}.png` });
};
const chip = async (label) => {
  await page.locator(`${ED} .cat-chips .chip`, { hasText: label }).first().click();
  await page.waitForTimeout(300);
};
await chip('Alle');
await shot('all');
// scroll the grouped list a few screens down
for (const [i, y] of [[1, 1400], [2, 3200], [3, 5200]]) {
  await page.evaluate((y) => {
    const deep = (root, tag) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === tag) return el; if (el.shadowRoot) { const f = deep(el.shadowRoot, tag); if (f) return f; } } };
    deep(document, 'FLOORPLAN-CARD-EDITOR-UI').shadowRoot.querySelector('.panel-body').scrollTop = y;
  }, y);
  await shot(`all${i}`);
}
for (const [n, label] of [['vehicle', 'Fahrzeuge'], ['security', 'Sensoren'], ['network', 'Netzwerk'], ['energy', 'Energie'], ['leisure', 'Freizeit']]) {
  await chip(label);
  await shot(n);
}
for (const q of ['fahrrad', 'rauchmelder', 'balkon', 'nas', 'wlan']) {
  await page.locator(`${ED} .lib-search`).fill(q);
  await shot(`q-${q}`);
}
const n = await page.locator(`${ED} .furn`).count();
console.log('tiles for last search', n);
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
