// Fridge with a shopping list on the mock harness: the number of open items is engraved on the fridge (WebGL door,
// 2D and CSS-3D top), hidden at 0, follows the list live.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/fridge-list.mjs [outDir]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = demoHome();
cfg.floors[0].furniture.push({ id: 'fridge', kind: 'fridge', x: 950, y: 40, w: 60, h: 65, entity: 'todo.einkauf' });
const list = (n) => ({ 'todo.einkauf': { state: String(n), attributes: { friendly_name: 'Einkauf' } } });

const m = await openMock({ config: { ...cfg, view_mode: '3d' }, states: { ...demoStates(), ...list(3) }, entities: demoEntities, size: '1280x900' });
const { page } = m;
await wait(2500);
const glDoor = () => m.card(`(() => { const g = plan.glScene?.furniture.children.find((c) => c.userData.id === 'fridge'); if (!g) return null; return g.children.filter((c) => c.userData.ownTex).length; })()`);
ok(await m.card('plan.is3d && !!plan.glScene'), 'WebGL 3D');
ok((await glDoor()) === 1, 'WebGL: „3“ in die Kühlschranktür graviert', await glDoor());
await page.screenshot({ path: `${out}/fridge-list-3d.png` });
await m.setStates(list(0));
await wait(1200);
ok((await glDoor()) === 0, 'WebGL: 0 offen → nichts graviert', await glDoor());
await m.setStates(list(5));
await wait(1200);
ok((await glDoor()) === 1, 'WebGL: wieder offen → live graviert', await glDoor());

// 2D
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '2d' }), true)`);
await wait(1500);
const flat = () => m.card(`[...plan.shadowRoot.querySelectorAll('[data-furniture="fridge"] .engraved text')].map((t) => t.textContent)`);
const t2 = await flat();
ok(t2.length === 3 && t2.every((x) => x === '5'), `2D: „5“ graviert (${JSON.stringify(t2)})`);
await page.screenshot({ path: `${out}/fridge-list-2d.png` });
await m.setStates(list(0));
await wait(800);
ok((await flat()).length === 0, '2D: 0 offen → nichts');

// CSS-3D
await m.setStates(list(3));
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '3d', renderer: 'css' }), true)`);
await wait(1800);
const css = () => m.card(`[...plan.shadowRoot.querySelectorAll('.furn3d .engraved text')].map((t) => t.textContent)`);
const t3 = await css();
ok(t3.length >= 3 && t3.every((x) => x === '3'), `CSS-3D: „3“ graviert (${JSON.stringify(t3)})`);
await m.setStates(list(0));
await wait(800);
ok((await css()).length === 0, 'CSS-3D: 0 offen → nichts');

// no list linked: nothing
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '2d', floors: card.rawConfig.floors.map((f) => ({ ...f, furniture: f.furniture.map((x) => x.id === 'fridge' ? { ...x, entity: undefined } : x) })) }), true)`);
await m.setStates(list(4));
await wait(1200);
ok((await flat()).length === 0, 'ohne verknüpfte Liste: nichts');
const errs = m.errors.filter((x) => !/GL Driver Message/.test(x));
ok(!errs.length, 'keine Fehler in der Konsole', errs);
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
