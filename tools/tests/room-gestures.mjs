// Rooms by default: a tap focuses the room (zooms in, its label on top), a double tap switches its lights, a tap beside
// it goes back to the overview; an own tap action of the room still wins. "Grundriss zurücksetzen" in the editor's
// settings empties the plan (one empty floor, the card's settings stay), undoable until saved. Mock harness.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/room-gestures.mjs
import { openMock } from './mock.mjs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER = `document.querySelector('floorplan-card-layer').shadowRoot`;
const ED = `${LAYER}.querySelector('floorplan-card-editor-ui')`;
const wohn = { id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [500, 0], [500, 400], [0, 400]], lights: ['light.demo_wohn'] };
const kueche = { id: 'r2', name: 'Küche', points: [[500, 0], [900, 0], [900, 400], [500, 400]], lights: ['light.demo_kueche'], tap_action: { action: 'toggle-lights' } };
const config = { type: 'custom:floorplan-card', card_id: 'room_gestures', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off', floors: [{ id: 'f0', name: 'Erdgeschoss', rooms: [wohn, kueche], devices: [] }] };
const states = {
  'light.demo_wohn': { state: 'off', attributes: { friendly_name: 'Wohnzimmerlicht', supported_color_modes: ['onoff'] } },
  'light.demo_kueche': { state: 'off', attributes: { friendly_name: 'Küchenlicht', supported_color_modes: ['onoff'] } },
};
const m = await openMock({ config, states });
const { page } = m;
await wait(900);
const plan = `window.__fpCard.shadowRoot.querySelector('fp-plan')`;
const lightCalls = async () => (await m.calls()).filter((c) => c.domain === 'light' || c.domain === 'homeassistant');

await m.clearCalls();
await m.card(`(card.gesture({ kind: 'room', id: 'r1' }, 'tap'), true)`);
await wait(900);
ok(await page.evaluate(`${plan}.focused`), 'tap on a room: it is focused (zoomed in)');
ok((await lightCalls()).length === 0, 'tap on a room: no light switched', await m.calls());
await m.card(`(card.gesture({ kind: 'background' }, 'tap'), true)`);
await wait(900);
ok(!(await page.evaluate(`${plan}.focused`)), 'tap beside it: back to the overview');

await m.clearCalls();
await m.card(`(card.gesture({ kind: 'room', id: 'r1' }, 'double_tap'), true)`);
await wait(500);
const c1 = await lightCalls();
ok(c1.some((c) => JSON.stringify(c).includes('light.demo_wohn')), 'double tap on a room: its light switches', c1);
ok(!(await page.evaluate(`${plan}.focused`)), 'double tap: no zoom');

await m.clearCalls();
await m.card(`(card.gesture({ kind: 'room', id: 'r2' }, 'tap'), true)`);
await wait(500);
const c2 = await lightCalls();
ok(c2.some((c) => JSON.stringify(c).includes('light.demo_kueche')), 'a room with its own tap action keeps it (Küche: tap switches the light)', c2);

// "Grundriss zurücksetzen"
await page.evaluate(`window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click()`);
await page.waitForFunction(`!!${ED}`, null, { timeout: 8000 }).catch(() => {});
await wait(900);
const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
await ed('(ed._panel = "settings", true)');
await wait(500);
ok(await ed('!!ed.shadowRoot.querySelector("[data-plan-reset]")'), 'settings offer "Grundriss zurücksetzen"');
await ed('ed.shadowRoot.querySelector("[data-plan-reset]").click()');
await wait(400);
ok(await page.evaluate(`!!${LAYER}.querySelector('.alert')`), 'it asks first');
await page.evaluate(`[...${LAYER}.querySelectorAll('.alert .btn')].find((b) => b.classList.contains('accent'))?.click()`);
await wait(500);
const d = JSON.parse(await ed('JSON.stringify({ floors: ed._draft.floors.map((f) => ({ rooms: f.rooms.length, devices: f.devices.length })), view: ed._draft.view_mode, id: ed._draft.card_id })'));
ok(d.floors.length === 1 && d.floors[0].rooms === 0 && d.floors[0].devices === 0, 'confirmed: one empty floor', d);
ok(d.view === '2d' && d.id === 'room_gestures', "the card's settings and id stay", d);
ok((await m.card('card.rawConfig.floors[0].rooms.length')) === 2, 'nothing saved yet (draft only)');
await ed('ed.undo()');
await wait(300);
ok((await ed('ed._draft.floors[0].rooms.length')) === 2, 'undo brings the plan back');

ok(!m.errors.length, 'no page errors or warnings', m.errors);
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
