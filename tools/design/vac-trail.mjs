// Trail while cleaning (state faked, positions fed into the plan — nothing reaches HA or the robot) and the
// popup with mopping settings (service calls intercepted).
import { openHA, tapAt } from '../pw.mjs';
import { cardFn, fakeStates } from './fake.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors, calls } = await openHA({ size: '1280x800', kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'select', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'button'] });
const card = cardFn(page);
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
await page.waitForTimeout(3000);
const base = { weather: 'sunny', cover: 10 };
// the first robot vacuum placed in the plan (its Roborock sensors are named after it)
const VAC = await card(`card.rawConfig.floors.flatMap((f) => f.furniture ?? []).find((f) => f.kind === 'robot_vacuum' && f.entity)?.entity`);
if (!VAC) throw new Error('no robot vacuum with an entity in the plan');
const S = `sensor.${VAC.split('.')[1]}`;
await fakeStates(page, { ...base, states: { [VAC]: { state: 'cleaning' }, [`${S}_aktueller_raum`]: { state: 'Küche' }, [`${S}_reinigungsfortschritt`]: { state: '35' }, [`${S}_reinigungsbereich`]: { state: '6.4' }, [`${S}_reinigungszeit`]: { state: '7' } } });
await page.waitForTimeout(1500);
const id = await card(`[...plan.gl.vacs][0][0]`);
const start = await card(`(() => { const v = [...plan.gl.vacs][0][1]; const r = card.rawConfig.floors[0].rooms.find((x) => x.name === 'Küche'); const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]); return v.m.toRobot((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2); })()`);
// a zigzag like a real clean
const route = [];
for (let lane = 0; lane < 5; lane++) for (let i = 0; i <= 6; i++) route.push([start[0] - 900 + (lane % 2 ? 6 - i : i) * 300, start[1] - 800 + lane * 330]);
let seq = 3e9;
for (const p of route) {
  await card(`(plan.gl.feedVacuum(${JSON.stringify(id)}, ${p[0]}, ${p[1]}, ${seq++}), true)`);
  await page.waitForTimeout(350);
}
await page.waitForTimeout(3500);
const tr = await card(`(() => { const v = [...plan.gl.vacs][0][1]; return { n: v.trail.pts.length, vis: !!v.trail.mesh?.visible }; })()`);
ok(tr.n > 20 && tr.vis, `trail while cleaning (${tr.n} points)`);
await page.screenshot({ path: `${out}/trail.png` });
// the popup
const vr = await card(`(() => { const g = [...plan.gl.vacs][0][1].group; const v = g.getWorldPosition(g.position.clone()); v.z += 4; v.project(plan.gl.camera); const rc = plan.gl.renderer.domElement.getBoundingClientRect(); return [rc.left + (v.x + 1) / 2 * rc.width, rc.top + (1 - v.y) / 2 * rc.height]; })()`);
// tap the driving vacuum itself
console.log('  vacuum on screen', vr.map(Math.round), 'piece there:', await card(`plan.pieceAt(${vr[0]}, ${vr[1]})`));
await tapAt(page, vr[0], vr[1]);
await page.waitForTimeout(1500);
const pop = () => card(`(() => { const p = card.layer?.shadowRoot?.querySelector('fp-vacuum-popup'); return p ? p.shadowRoot.textContent.replace(/\\s+/g, ' ') : ''; })()`);
const txt = await pop();
console.log('  calls', JSON.stringify((await calls()).map((c) => c.domain + '.' + c.service + ' ' + JSON.stringify(c.data).slice(0, 300))));
ok(/Wischen/.test(txt) && /Mittel|medium/i.test(txt), 'popup shows mopping settings');
ok(/35/.test(txt) && /Küche/.test(txt), 'popup shows the running clean (room, progress)');
await page.screenshot({ path: `${out}/popup.png` });
// choose a mop intensity: select.select_option (intercepted)
await card(`(() => { const p = card.layer.shadowRoot.querySelector('fp-vacuum-popup'); [...p.shadowRoot.querySelectorAll('.chip')].find((c) => /hoch|high/i.test(c.textContent)).click(); return true; })()`);
await page.waitForTimeout(500);
const c = (await calls()).filter((x) => x.domain === 'select');
ok(c.length === 1 && c[0].service === 'select_option' && c[0].blocked, `mop intensity → select.select_option (intercepted: ${JSON.stringify(c[0]?.data ?? c[0]?.target)})`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
// docked: the trail goes
await fakeStates(page, { ...base, states: { [VAC]: { state: 'docked' } } });
await page.waitForTimeout(1500);
const tr2 = await card(`(() => { const v = [...plan.gl.vacs][0][1]; return { n: v.trail.pts.length, vis: !!v.trail.mesh?.visible }; })()`);
ok(tr2.n === 0 && !tr2.vis, 'docked: trail gone');
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
