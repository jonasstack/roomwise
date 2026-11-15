// Floors in the editor are easy to find: the toolbar always shows the floors, "+ Etage" next to them and a
// "Etagen einstellen" button that opens the settings' floor section right away (rename, order, height, link to
// Home Assistant, delete); Home Assistant's floors can be taken over in one go. Phones keep the floors button.
// Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/floors-bar.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
const room = { id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [500, 0], [500, 400], [0, 400]] };
const config = { type: 'custom:floorplan-card', card_id: 'floors_bar_demo', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off', floors: [{ id: 'f0', name: 'Erdgeschoss', rooms: [room], devices: [] }] };
const floors = { eg: { floor_id: 'eg', name: 'Erdgeschoss', level: 0 }, og: { floor_id: 'og', name: 'Obergeschoss', level: 1 } };

for (const [size, scheme] of [['1280x900', 'light'], ['390x844', 'dark']]) {
  const phone = size.startsWith('390');
  const m = await openMock({ config, floors, size, scheme });
  const { page } = m;
  await wait(900);
  await page.evaluate(`window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click()`);
  await page.waitForFunction(`!!${ED}`, null, { timeout: 8000 }).catch(() => {});
  await wait(900);
  const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
  const vis = (sel) => ed(`(() => { const e = ed.shadowRoot.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; })()`);
  ok(await vis('.tb-floors'), `${size}: toolbar has "Etagen einstellen"`);
  ok((await vis('.tb-add-floor')) === !phone, `${size}: "+ Etage" ${phone ? 'left out on phones (in the floor section)' : 'next to the floors'}`);
  if (!phone) ok(await vis('.tb-center fp-segmented.floors'), `${size}: the floor tabs show even with one floor`);
  await ed('ed.shadowRoot.querySelector(".tb-floors").click()');
  await wait(600);
  const sec = await ed(`(() => { const d = ed.shadowRoot.querySelector('details[data-fold="floors"]'); if (!d) return null; const r = d.getBoundingClientRect(); return { open: d.open, top: r.top, h: innerHeight, panel: ed._panel }; })()`);
  ok(sec?.open && sec.panel === 'settings' && sec.top >= 0 && sec.top < sec.h, `${size}: the floor section opens and is in view`, sec);
  ok(await ed('!!ed.shadowRoot.querySelector("[data-place-stairs]")'), `${size}: "Treppe setzen" in the floor section (stairs tool)`);
  ok(await ed('!!ed.shadowRoot.querySelector("[data-ha-floors]")'), `${size}: "Etagen aus Home Assistant übernehmen" offered`);
  if (out) await page.screenshot({ path: `${out}/floors-bar-${phone ? 'phone' : 'wide'}-${scheme}.png` });
  await ed('ed.shadowRoot.querySelector("[data-ha-floors]").click()');
  await wait(400);
  const fl = JSON.parse(await ed('JSON.stringify(ed._draft.floors.map((f) => ({ id: f.id, name: f.name, floor: f.floor, level: f.level })))'));
  ok(fl.length === 2 && fl.find((f) => f.id === 'f0')?.floor === 'eg' && fl.some((f) => f.floor === 'og' && f.level === 1 && f.name === 'Obergeschoss'), `${size}: the floor with that name links to "Erdgeschoss", "Obergeschoss" added above`, fl);
  ok(!(await ed('!!ed.shadowRoot.querySelector("[data-ha-floors]")')), `${size}: then nothing left to take over`);
  if (!phone) {
    await ed('ed.shadowRoot.querySelector(".tb-add-floor").click()');
    await wait(400);
    ok((await ed('ed._draft.floors.length')) === 3, `${size}: "+ Etage" adds a floor`);
    const tabs = await ed('ed.shadowRoot.querySelector(".tb-center fp-segmented.floors").options.map((o) => o.label)');
    ok(tabs.length === 3, `${size}: three floor tabs (${tabs})`);
    if (out) await page.screenshot({ path: `${out}/floors-bar-three-${scheme}.png` });
  }
  ok(!(await ed('ed.card.rawConfig.floors.length > 1')), `${size}: nothing saved (draft only)`);
  errs.push(...m.errors);
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
