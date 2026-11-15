// Close-up of the live dog (3D), read-only. Optional PET='{"harness":"#3a6fd8"}' overrides the dog's pet config
// in the page only (nothing is saved).
import { openHA } from '../pw.mjs';
import { cardFn } from '../design/fake.mjs';
const out = process.argv[2] ?? '/tmp';
const tag = process.env.TAG ?? 'dog';
const { browser, page, errors } = await openHA({ size: process.env.SIZE ?? '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'select', 'house_rules'] });
const card = cardFn(page);
await page.waitForTimeout(3500);
if (process.env.PET || process.env.FURN) {
  await card(`(() => { const c = structuredClone(card.rawConfig); const d = c.floors[0].furniture.find((f) => f.kind === 'dog'); Object.assign(d, ${process.env.FURN ?? '{}'}); d.pet = { ...d.pet, ...${process.env.PET ?? '{}'} }; card.setConfig(c); return true; })()`);
  await page.waitForTimeout(3000);
}
const id = await card(`card.rawConfig.floors[0].furniture.find((f) => f.kind === 'dog').id`);
const pos = await card(`(() => { const d = plan.gl.dogs.get(${JSON.stringify(id)}); return d ? [d.pos.x, d.pos.y, d.task] : null; })()`);
console.log('dog', id, JSON.stringify(pos));
const r = pos && (await card(`(() => { const q = plan.viewMatrix(plan.panZoom.view).transformPoint(new DOMPoint(${pos[0]}, ${pos[1]}, 15, 1)); return { x: q.x / q.w, y: q.y / q.w, w: 0, h: 0 }; })()`));
console.log('rect', JSON.stringify(r));
if (r) {
  await card(`(plan.panZoom.zoomBy(${process.env.Z ?? 6}, ${r.x + r.w / 2}, ${r.y + r.h / 2}), true)`);
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: `${out}/${tag}.png` });
console.log(errors.join('\n'));
await browser.close();
