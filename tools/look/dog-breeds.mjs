// Every breed in the dog editor (draft only, cancelled at the end): one picture per breed.
import { openHA } from '../pw.mjs';
import { cardFn } from '../design/fake.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: '1366x900', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'select', 'house_rules'] });
const card = cardFn(page);
await page.waitForTimeout(3000);
await card(`(card.openEditor(), true)`);
await page.waitForTimeout(2500);
const E = (e) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); return ${e}; })()`);
const id = await E(`ed.floor.furniture.find((x) => x.kind === 'dog')?.id`);
await E(`(ed.select({ kind: 'furniture', id: ${JSON.stringify(id)} }), true)`);
await page.waitForTimeout(1500);
await page.locator('floorplan-card-layer floorplan-card-editor-ui [data-dog-design]').click();
await page.waitForTimeout(3000);
const D = (e) => page.evaluate(`(() => { const d = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('fp-dog-editor'); return ${e}; })()`);
const breeds = (process.env.BREEDS ?? 'medium,husky,poodle,retriever,dachshund,pug').split(',');
const looks = { medium: ['#c8a27a', '#f1ebe1'], husky: ['#4a4f57', '#f1ebe1'], poodle: ['#2c2c2e', '#2c2c2e'], retriever: ['#e0a55a', '#f1ebe1'], dachshund: ['#6b4a36', '#c8a27a'], pug: ['#d8c3a5', '#2c2c2e'] };
for (const b of breeds) {
  await D(`(d.setF((x) => { x.variant = ${JSON.stringify(b)}; x.color = ${JSON.stringify(looks[b]?.[0] ?? '#c8a27a')}; x.accent = ${JSON.stringify(looks[b]?.[1] ?? '#f1ebe1')}; x.pet = { ...x.pet, markings: undefined, ears: undefined, tail: undefined, paint: undefined }; }), true)`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/breed-${b}.png`, clip: { x: 93, y: 80, width: 820, height: 720 } });
}
await page.locator('floorplan-card-layer fp-dog-editor .bar .btn.plain').click();
await E(`(ed.shadowRoot.querySelector('.tb-left .btn').click(), true)`);
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
