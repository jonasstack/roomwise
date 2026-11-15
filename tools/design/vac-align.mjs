// Editor: select the robot vacuum, screenshot its map on the plan, press auto-align, screenshot again. Never saves.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: '1280x900', kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const ED = 'floorplan-card-editor-ui';
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1200);
await ed(`(e) => e.select({ kind: 'furniture', id: e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').id })`);
await page.waitForTimeout(4000);
console.log('saved tf', JSON.stringify(await ed(`(e) => e.findSel(e._sel).vacuum?.transform`)), 'map', await ed(`(e) => { const m = [...e.vacMaps.values()][0]; return m ? m.rooms.length + ' rooms ' + m.walls.length + ' walls' : String(m); }`));
await page.screenshot({ path: `${out}/vac-before.png` });
if (process.argv[3] !== 'nofit') {
  await page.locator(`${ED} .panel button.row.add`, { hasText: 'utomatisch' }).click();
  await page.waitForTimeout(1500);
  console.log('fit tf', JSON.stringify(await ed(`(e) => e.findSel(e._sel).vacuum?.transform`)));
  await page.screenshot({ path: `${out}/vac-after.png` });
}
// stretch handles: drag each by 40 px outwards
for (const hd of ['vac-sx', 'vac-sy', 'vac-s']) {
  const b = await page.locator(`${ED} .h[data-handle="${hd}"]`).boundingBox();
  if (!b) { console.log('no handle', hd); continue; }
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const before = await ed(`(e) => e.findSel(e._sel).vacuum.transform`);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (hd === 'vac-sy' ? 0 : 5 * i), y + (hd === 'vac-sx' ? 0 : 5 * i));
  await page.mouse.up(); await page.waitForTimeout(300);
  const after = await ed(`(e) => e.findSel(e._sel).vacuum.transform`);
  console.log(hd, 'scale', before.scale, '->', after.scale, 'scaleY', before.scaleY ?? before.scale, '->', after.scaleY ?? after.scale);
}
await page.screenshot({ path: `${out}/vac-stretched.png` });
// discard
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
