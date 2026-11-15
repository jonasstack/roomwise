// Floor plan as a file (editor → settings): download the plan as JSON, load one back (checked by config.ts,
// confirmed, undoable, unsaved until "Save"), broken files are refused with a reason. The config is replaced
// inside the test page only — nothing is saved.
//   FP_LOCAL=1 node tools/tests/plan-io.mjs [outdir]
//   against the isolated test HA: node tools/tests/testha-card.mjs tools/tests/plan-io.mjs [outdir]
import { readFileSync } from 'node:fs';
import { openHA } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ block: ['light', 'switch', 'climate', 'cover', 'lock', 'button', 'vacuum', 'media_player', 'tts', 'notify', 'script', 'automation', 'scene', 'homeassistant'] });
const fail = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail.push(msg);
};
const findCard = `(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; return find(document); })()`;
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const plan = {
  type: 'custom:floorplan-card',
  card_id: 'fp_planio',
  title: 'Test',
  floors: [
    {
      id: 'f1',
      name: 'Erdgeschoss',
      rooms: [
        { id: 'r1', name: 'Eins', points: sq(0, 0, 300) },
        { id: 'r2', name: 'Zwei', points: sq(300, 0, 300) },
      ],
      devices: [],
      openings: [{ id: 'o1', type: 'door', a: [100, 300], b: [190, 300] }],
      furniture: [{ id: 'x1', kind: 'sofa', x: 150, y: 150, w: 200, h: 90 }],
    },
  ],
};
await page.evaluate(([sel, cfg]) => eval(sel).setConfig(cfg), [findCard, plan]);
await page.waitForTimeout(800);
// a tour must not get in the way here
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('fp-tour-')) localStorage.removeItem(k);
});
await page.evaluate((sel) => eval(sel).shadowRoot.querySelector('.chrome .right [aria-label]')?.click() ?? eval(sel).openEditor(), findCard);
await page.waitForTimeout(1500);
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
check(await page.evaluate((ed) => !!eval(ed), ED), 'editor open');
// settings panel → "floor plan as a file"
await page.evaluate((ed) => eval(ed).shadowRoot.querySelector('[data-panel="settings"]').click(), ED);
await page.waitForTimeout(500);
await page.evaluate((ed) => {
  const root = eval(ed).shadowRoot;
  const btn = root.querySelector('[data-plan-export]');
  btn.closest('details').open = true;
}, ED);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/plan-io-settings.png` });

// 1. download
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.evaluate((ed) => eval(ed).shadowRoot.querySelector('[data-plan-export]').click(), ED)]);
const file = JSON.parse(readFileSync(await download.path(), 'utf8'));
check(/^grundriss-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `file name ${download.suggestedFilename()}`);
check(file.format === 'roomwise_floorplan' && file.version === 1 && file.created, 'versioned frame');
check(file.config.floors[0].rooms.length === 2 && file.config.floors[0].openings.length === 1 && file.config.floors[0].furniture.length === 1 && file.config.title === 'Test', 'rooms, openings, furniture and settings in the file');
check(!('card_id' in file.config), 'without this card\'s id');

// 2. load a changed file back: confirm → replaces the draft, keeps the card id, unsaved, undoable
const changed = structuredClone(file);
changed.config.floors[0].rooms.push({ id: 'r3', name: 'Drei', points: sq(0, 300, 300) });
changed.config.floors[0].devices.push({ id: 'd1', entity: 'light.gibt_es_hier_nicht', x: 50, y: 50 });
const load = (obj, name = 'plan.json') =>
  page.evaluate(
    ([ed, text, name]) => {
      const p = eval(ed).loadPlanFile(new File([text], name, { type: 'application/json' }));
      window.__fpLoad = p;
      return true;
    },
    [ED, typeof obj === 'string' ? obj : JSON.stringify(obj), name],
  );
const layerState = () => page.evaluate(() => {
  const l = document.querySelector('floorplan-card-layer');
  return { confirm: l._confirm?.text, toast: l._toast?.text };
});
const draft = () => page.evaluate((ed) => { const e = eval(ed); return { rooms: e._draft.floors[0].rooms.length, devices: e._draft.floors[0].devices.length, cardId: e._draft.card_id, dirty: e.dirty, past: e._past.length }; }, ED);
await load(changed, 'neu.json');
await page.waitForTimeout(400);
let ls = await layerState();
check(/neu\.json/.test(ls.confirm ?? '') && /3/.test(ls.confirm ?? ''), `asks before replacing (${ls.confirm})`);
await page.screenshot({ path: `${out}/plan-io-confirm.png` });
await page.evaluate(() => [...document.querySelector('floorplan-card-layer').shadowRoot.querySelectorAll('.alert button')].pop().click());
check(await page.evaluate(() => window.__fpLoad), 'confirmed');
let d = await draft();
check(d.rooms === 3 && d.devices === 1 && d.cardId === 'fp_planio' && d.dirty, `draft replaced, card id kept, unsaved (${JSON.stringify(d)})`);
ls = await layerState();
check(/1/.test(ls.toast ?? ''), `says that one device does not exist here (${ls.toast})`);
await page.evaluate((ed) => eval(ed).undo(), ED);
d = await draft();
check(d.rooms === 2 && d.devices === 0, 'undo brings the old plan back');

// 3. cancelled: nothing changes
await load(changed);
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('.alert button').click());
check((await page.evaluate(() => window.__fpLoad)) === false && (await draft()).rooms === 2, 'cancel keeps the plan');

// 4. broken files are refused with a reason, the draft stays
const refused = async (obj, re, msg) => {
  await load(obj);
  const r = await page.evaluate(() => window.__fpLoad);
  const t = (await layerState()).toast ?? '';
  check(r === false && re.test(t) && (await draft()).rooms === 2, `${msg} (${t})`);
};
await refused('{ kaputt', /JSON/, 'not JSON');
await refused({ format: 'something_else', version: 1, config: {} }, /kein Grundriss|not a floor plan/, 'another format');
await refused({ ...file, version: 99 }, /neueren|newer/, 'a newer version');
await refused({ ...file, config: { ...file.config, floors: [{ name: 'X', rooms: [{ name: 'Kaputt', points: [[0, 0], [1, 1]] }] }] } }, /Kaputt/, 'a room with two corners is named');
await refused({ ...file, config: { ...file.config, type: 'custom:other-card' } }, /other-card/, 'another card');
await refused({ type: 'custom:floorplan-card' }, /Etagen|floors/, 'no floors at all');
// a bare card config (YAML pasted into a JSON file) is fine too
await load({ type: 'custom:floorplan-card', rooms: [{ name: 'Allein', points: sq(0, 0, 200) }] });
await page.waitForTimeout(300);
await page.evaluate(() => [...document.querySelector('floorplan-card-layer').shadowRoot.querySelectorAll('.alert button')].pop().click());
d = await draft();
check((await page.evaluate(() => window.__fpLoad)) === true && d.rooms === 1, 'a bare card config (single floor) loads');

await page.evaluate(() => document.querySelector('floorplan-card-layer').closeEditor());
check(errors.length === 0, `no console errors (${errors.length})`);
for (const e of errors) console.log('  ', e);
await browser.close();
console.log(fail.length ? `FAILED: ${fail.length}` : 'all ok');
process.exit(fail.length ? 1 : 0);
