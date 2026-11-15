// Heater close-up with faked heating (nothing reaches HA): zooms the 3D view onto each radiator.
import { openHA } from '../pw.mjs';
import { cardFn, fakeStates } from '../design/fake.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: process.env.SIZE ?? '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'select', 'house_rules'] });
const card = cardFn(page);
await page.waitForTimeout(3000);
await fakeStates(page, { heat: true });
const heaters = await card(`card.rawConfig.floors[0].furniture.filter((f) => f.kind === 'radiator' || /heiz|radiator/i.test(f.kind)).map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, entity: f.entity }))`);
console.log('heaters', JSON.stringify(heaters));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/heat-all.png` });
for (const h of heaters.slice(0, Number(process.env.N ?? 2))) {
  await card(`(plan.panZoom.reset(false), true)`);
  await page.waitForTimeout(500);
  const r = await card(`plan.gl.screenRect(${JSON.stringify(h.id)})`);
  if (!r) continue;
  await card(`(plan.panZoom.zoomBy(${process.env.Z ?? 4}, ${r.x + r.w / 2}, ${r.y + r.h / 2}), true)`);
  await page.waitForTimeout(1600);
  for (const k of [0, 1]) {
    await page.screenshot({ path: `${out}/heat-${h.id}-${k}.png` });
    await page.waitForTimeout(700);
  }
}
console.log(errors.join('\n'));
await browser.close();
