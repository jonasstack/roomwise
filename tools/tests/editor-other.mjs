// Editor: no separate devices panel any more — "Other" at the top of the furniture library places any Home Assistant
// entity as a device marker, by tap (centre of the view) and by dragging it onto the plan. Devices already on the
// plan stay as they are. Mock harness (no Home Assistant, neutral demo home).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/editor-other.mjs [outDir]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;

const cfg = demoHome();
// a device placed earlier (with the old devices panel) must survive untouched
cfg.floors[0].devices = [{ id: 'dev_old', entity: 'light.demo_garden', x: 120, y: 120 }];
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states: demoStates(), entities: demoEntities, size: '1280x900' });
const { page } = m;
await m.card(`(card.openEditor(), true)`);
await wait(2000);
ok(await page.evaluate(`!!${ED}`), 'editor open');
const q = (sel) => page.evaluate(`${ED}.shadowRoot.querySelectorAll(${JSON.stringify(sel)}).length`);
ok((await q('.tool[data-panel="devices"]')) === 0, 'no separate devices panel');
ok((await q('.tool[data-panel="furniture"]')) === 1, 'furniture panel is there');
await page.evaluate(`${ED}.shadowRoot.querySelector('.tool[data-panel="furniture"]').click()`);
await wait(500);
// "Other" is the first thing in the library
const first = await page.evaluate(`(() => { const b = ${ED}.shadowRoot.querySelector('.panel-body'); const el = b.querySelector('.furn-other, .search, .cat-chips, .furn-grid'); return el?.className ?? null; })()`);
ok(/furn-other/.test(first ?? ''), `"Other" at the top of the furniture library (${first})`);
const chip = await page.evaluate(`${ED}.shadowRoot.querySelector('.cat-chips .chip')?.textContent.trim()`);
ok(chip === 'Sonstige', `first category chip: ${chip}`);
if (out) await page.screenshot({ path: `${out}/editor-library.png` });
await page.evaluate(`${ED}.shadowRoot.querySelector('.furn-other').click()`);
await wait(500);
ok((await q('.panel-body fp-entity-list')) === 1, 'Other shows the entity list');
if (out) await page.screenshot({ path: `${out}/editor-other.png` });
const devs = () => page.evaluate(`${ED}._draft.floors[0].devices.map((d) => ({ entity: d.entity, x: Math.round(d.x), y: Math.round(d.y) }))`);
const n0 = (await devs()).length;
// tap: placed in the middle of the view
const list = `${ED}.shadowRoot.querySelector('fp-entity-list').shadowRoot`;
await page.evaluate(`${list}.querySelector('.row[data-entity="switch.demo_socket"]').click()`);
await wait(500);
const d1 = await devs();
ok(d1.length === n0 + 1 && d1.at(-1).entity === 'switch.demo_socket', `tap places the entity as a device (${JSON.stringify(d1.at(-1))})`);
ok(d1.some((d) => d.entity === 'light.demo_garden' && d.x === 120 && d.y === 120), 'the device placed earlier is unchanged');
ok((await page.evaluate(`${ED}._sel?.kind`)) === 'device', 'the new device is selected (inspector with all device options)');
if (out) await page.screenshot({ path: `${out}/editor-other-placed.png` });
// drag: out of the list onto the plan, dropped where the pointer is
await page.evaluate(`${ED}.shadowRoot.querySelector('.tool[data-panel="furniture"]').click()`);
await wait(400);
ok((await q('.panel-body fp-entity-list')) === 1, 'the library opens again on "Other"');
const row = await page.evaluate(`(() => { const r = ${list}.querySelector('.row[data-entity="valve.demo_zone_1"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const target = await page.evaluate(`(() => { const p = ${ED}.shadowRoot.querySelector('fp-plan'); const r = p.panZoom.viewport_.getBoundingClientRect(); const v = p.panZoom.view; return [r.left + v.tx + 300 * v.s, r.top + v.ty + 250 * v.s]; })()`);
await page.mouse.move(row[0], row[1]);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(row[0] + ((target[0] - row[0]) * i) / 12, row[1] + ((target[1] - row[1]) * i) / 12);
await page.mouse.up();
await wait(500);
const d2 = await devs();
const dropped = d2.find((d) => d.entity === 'valve.demo_zone_1');
ok(!!dropped && Math.abs(dropped.x - 300) < 30 && Math.abs(dropped.y - 250) < 30, `drag onto the plan places it at the drop point (${JSON.stringify(dropped)})`);
ok(!m.errors.length, `console: ${m.errors.join(' | ') || 'no errors'}`);
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
