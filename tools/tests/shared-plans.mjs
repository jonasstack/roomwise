// Shared floor plans on the mock harness (no Home Assistant; an in-page stand-in for the dashboard storage and the
// companion's plans): make a card's plan shared, show it on a second card by reference, edit from one card and watch the
// other follow live, a conflicting save asks first, take a shared plan from the first steps, stop sharing, a deleted plan
// and a missing companion are explained. The websocket side of the companion has its own test (tools/companion/test-plans.mjs).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/shared-plans.mjs [outDir]
import { openMock } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const A = {
  type: 'custom:floorplan-card',
  card_id: 'card_a',
  title: 'Erdgeschoss',
  view_mode: '2d',
  effects: 'off',
  north: 20,
  floors: [{ id: 'f1', name: 'Wohnung', rooms: [{ id: 'r1', name: 'Wohnen', points: rect(0, 0, 400, 300) }, { id: 'r2', name: 'Küche', points: rect(400, 0, 700, 300) }], devices: [] }],
};
const m = await openMock({ config: A, size: '1200x900', fake: { companion: true } });
const { page } = m;
await wait(500);
// the i-th card on the page and its layer
const C = (i) => `document.querySelectorAll('floorplan-card')[${i}]`;
const ED = (i) => `${C(i)}.layer.shadowRoot.querySelector('floorplan-card-editor-ui')`;
const run = (expr) => page.evaluate(`(async () => ${expr})()`);
const openEditor = async (i) => {
  await run(`(${C(i)}.openEditor(), true)`);
  await wait(1000);
  await run(`(${C(i)}.layer.shadowRoot.querySelector('fp-editor-tour')?.dispatchEvent(new CustomEvent('tour-end')), true)`);
  await wait(200);
};
const inEd = (i, expr) => run(`(() => { const ed = ${ED(i)}; return ${expr}; })()`);
const confirm = async (i, yes = true) => {
  const text = await run(`${C(i)}.layer._confirm?.text ?? ''`);
  await run(`(${C(i)}.layer.shadowRoot.querySelector('.alert .btn.${yes ? 'accent' : 'pressable:not(.accent)'}').click(), true)`);
  await wait(200);
  return text;
};
const save = async (i) => {
  await inEd(i, `(ed.shadowRoot.querySelector('.save').click(), true)`);
  await wait(900);
};
const rooms = (i) => run(`${C(i)}._config.floors[0].rooms.map((r) => r.name).join(',')`);

// 1. share card A's plan
await openEditor(0);
await inEd(0, `(ed.shadowRoot.querySelector('[data-panel="settings"]').click(), true)`);
await wait(300);
await inEd(0, `(ed.shadowRoot.querySelector('details[data-share]').open = true, true)`);
await wait(200);
await page.screenshot({ path: `${out}/share-settings.png` });
await inEd(0, `(ed.shadowRoot.querySelector('[data-share-new-name]').value = 'Haus', ed.shadowRoot.querySelector('[data-share-make]').click(), true)`);
await wait(200);
ok((await inEd(0, `ed._share?.name`)) === 'Haus' && (await inEd(0, `ed.dirty`)), 'shared on save (pending, counts as a change)');
await save(0);
let fake = await m.fake();
const plans = Object.values(fake.plans);
const id = plans[0]?.id;
const cardA = fake.dash.views[0].cards[0];
ok(plans.length === 1 && plans[0].name === 'Haus' && plans[0].plan.floors[0].rooms.length === 2 && plans[0].plan.north === 20, 'plan stored in the companion with floors and plan settings', plans[0]);
ok(cardA.plan === id && !cardA.floors && !cardA.north && cardA.title === 'Erdgeschoss' && cardA.card_id === 'card_a', 'card A now references it; title and id stay in the card', cardA);
ok((await rooms(0)) === 'Wohnen,Küche', 'card A still shows the plan');

// 2. a second card (another dashboard) shows the same plan by reference
const B = { type: 'custom:floorplan-card', card_id: 'card_b', title: 'Tablet Flur', plan: id, view_mode: '2d', effects: 'off' };
await run(`(window.__fpFake.dash.views.push({ title: 'B', cards: [${JSON.stringify(B)}] }), true)`);
await m.addCard(B);
await wait(800);
ok((await rooms(1)) === 'Wohnen,Küche', 'card B shows the shared plan');
ok((await run(`${C(1)}._config.title`)) === 'Tablet Flur' && (await run(`${C(1)}._config.north`)) === 20, 'card B: own title, the plan\'s north');

// 3. edit from card A: card B follows live
await openEditor(0);
ok(await inEd(0, `ed._share?.id === ${JSON.stringify(id)} && !ed.dirty`), 'editor knows the shared plan, nothing changed yet');
await inEd(0, `(ed.mutate((_d, f) => f.rooms.push({ id: 'r3', name: 'Bad', points: [[0, 300], [400, 300], [400, 500], [0, 500]] })), true)`);
const savesBefore = (await m.fake()).saves;
await save(0);
fake = await m.fake();
ok(fake.plans[id].rev === 2 && fake.plans[id].plan.floors[0].rooms.length === 3, 'saved as revision 2');
ok(fake.saves === savesBefore, 'the dashboard config is not rewritten when only the plan changed');
await wait(300);
ok((await rooms(1)) === 'Wohnen,Küche,Bad', 'card B updated live, without reloading');
await page.screenshot({ path: `${out}/share-two-cards.png` });

// 4. conflict: card B's editor started at revision 2, someone else saved revision 3 meanwhile
await openEditor(1);
await run(`(() => { const f = window.__fpFake; const p = f.plans[${JSON.stringify(id)}]; p.rev = 3; p.plan.floors[0].rooms[0].name = 'Wohnzimmer'; return true; })()`);
await inEd(1, `(ed.mutate((_d, f) => (f.rooms[1].name = 'Kochen')), true)`);
await inEd(1, `(ed.shadowRoot.querySelector('.save').click(), true)`);
await wait(500);
const ctext = await confirm(1, false);
ok(/anderen Dashboard/.test(ctext), `a save from elsewhere in between: asks first ("${ctext.slice(0, 50)}…")`);
ok((await m.fake()).plans[id].rev === 3, 'cancelled: nothing overwritten');
await inEd(1, `(ed.shadowRoot.querySelector('.save').click(), true)`);
await wait(500);
await confirm(1, true);
await wait(800);
fake = await m.fake();
ok(fake.plans[id].rev === 4 && fake.plans[id].plan.floors[0].rooms[1].name === 'Kochen', 'confirmed: overwritten as revision 4');
await wait(300);
ok((await rooms(0)).includes('Kochen'), 'card A follows');

// 5. first steps of a new card: "use a shared floor plan"
await run(`(() => { document.querySelectorAll('floorplan-card')[1].remove(); window.__fpFake.dash.views.push({ title: 'C', cards: [{ type: 'custom:floorplan-card', card_id: 'card_c' }] }); return true; })()`);
await m.addCard({ type: 'custom:floorplan-card', card_id: 'card_c' });
await wait(800);
ok(await run(`!!${C(1)}.shadowRoot.querySelector('.onboard-shared')`), 'a new card offers "use a shared floor plan"');
await run(`(${C(1)}.shadowRoot.querySelector('.onboard-shared').click(), true)`);
await wait(1200);
await run(`(${C(1)}.layer.shadowRoot.querySelector('fp-editor-tour')?.dispatchEvent(new CustomEvent('tour-end')), true)`);
await wait(300);
ok(await inEd(1, `ed._panel === 'settings' && ed.shadowRoot.querySelector('details[data-share]').open`), 'opens the settings at "several dashboards"');
await page.screenshot({ path: `${out}/share-pick.png` });
await inEd(1, `(ed.shadowRoot.querySelector('[data-share-use]').click(), true)`);
await wait(300);
await confirm(1, true);
await wait(400);
await save(1);
fake = await m.fake();
const cardC = fake.dash.views.find((v) => v.title === 'C').cards[0];
ok(cardC.plan === id && !cardC.floors, 'card C references the shared plan');
ok(fake.plans[id].rev === 4, 'taking it unchanged writes no new revision');
ok((await rooms(1)).split(',').length === 3, 'card C shows it');

// 6. stop sharing on card A: it keeps its own copy
await openEditor(0);
await inEd(0, `(ed.shadowRoot.querySelector('[data-panel="settings"]').click(), true)`);
await wait(300);
await inEd(0, `(ed.shadowRoot.querySelector('details[data-share]').open = true, ed.shadowRoot.querySelector('[data-share-unlink]').click(), true)`);
await wait(300);
await confirm(0, true);
await save(0);
fake = await m.fake();
const a2 = fake.dash.views[0].cards[0];
ok(!a2.plan && a2.floors?.[0].rooms.length === 3 && a2.north === 20, 'card A: own copy in its config again', a2);
ok(!!fake.plans[id], 'the shared plan stays for the other dashboards');

// 7. the plan is deleted: card C says so
await run(`(() => { const f = window.__fpFake; delete f.plans[${JSON.stringify(id)}]; for (const s of f.subs) if (s.id === ${JSON.stringify(id)}) s.cb({ id: ${JSON.stringify(id)}, deleted: true }); return true; })()`);
await wait(300);
const msg = await run(`${C(1)}.shadowRoot.querySelector('.plan-state')?.textContent ?? ''`);
ok(/nicht mehr da/.test(msg), `deleted plan: explained instead of an empty plan ("${msg.trim().slice(0, 60)}")`);
const errs = m.errors.filter((e) => !KNOWN.some((r) => r.test(e)));
ok(errs.length === 0, `no console errors (${errs.slice(0, 3).join(' | ')})`);
await m.browser.close();

// 8. a card with a shared plan but no companion
const n = await openMock({ config: { type: 'custom:floorplan-card', card_id: 'x', plan: 'plan_gone' }, size: '900x600', fake: { companion: false } });
await wait(500);
const t2 = await n.card(`card.shadowRoot.querySelector('.plan-state')?.textContent ?? ''`);
ok(/Begleit-Integration/.test(t2), `no companion: explained ("${t2.trim().slice(0, 60)}")`);
await n.browser.close();

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
