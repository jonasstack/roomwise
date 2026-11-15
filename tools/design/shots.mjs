// Design screenshots of the user's plan under faked states.
// Usage: node tools/design/shots.mjs <outdir> [tag] [light|dark] [scenario json]
import { openHA, tapAt } from '../pw.mjs';
import { fakeStates, cardFn } from './fake.mjs';
const out = process.argv[2] ?? '/tmp';
const tag = process.argv[3] ?? 'a';
const scheme = process.argv[4] ?? 'light';
const sc = JSON.parse(process.argv[5] ?? 'null') ?? { weather: 'sunny', lights: true, heat: true, open: ['binary_sensor.fenster_wohnzimmer_1', 'binary_sensor.tuer_kueche'] };
const only = (process.env.SHOTS ?? '3d,living,bed,2d').split(',');
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'tts', 'notify', 'scene', 'script', 'automation', 'input_boolean', 'remote', 'lock', 'button'] });
const card = cardFn(page);
await page.waitForTimeout(1500);
await fakeStates(page, sc);
await page.waitForTimeout(2500);
if (only.includes('3d')) await page.screenshot({ path: `${out}/${tag}-3d.png` });
const focus = async (name) => {
  const p = await card(`(() => { const id = card.rawConfig.floors[0].rooms.find((r) => r.name === '${name}').id; const path = plan.shadowRoot.querySelector('path.room[data-room="' + id + '"]'); const r = path.getBoundingClientRect();
    for (let fy = 0.5; fy <= 0.9; fy += 0.05) for (let fx = 0.3; fx <= 0.8; fx += 0.05) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (plan.roomAt(x, y) === id && !plan.pieceAt(x, y)) return [x, y]; } })()`);
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(2800);
  if (!(await card('plan.focused'))) console.log('not focused:', name, p);
};
for (const [key, room] of [['living', 'Wohnzimmer'], ['bed', 'Schlafzimmer'], ['kitchen', 'Küche'], ['bath', 'Bad'], ['hall', 'Flur']]) {
  if (!only.includes(key)) continue;
  await focus(room);
  await page.screenshot({ path: `${out}/${tag}-${key}.png` });
  await card(`(plan.resetView(), true)`);
  await page.waitForTimeout(1500);
}
if (only.includes('2d')) {
  await page.locator('floorplan-card .chrome .icon-btn[aria-label="2D"]').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${tag}-2d.png` });
}
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
