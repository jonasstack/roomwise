// Keyboard and screen reader access on the mock harness (no Home Assistant; neutral demo flat): Tab into the plan,
// arrow keys between rooms and devices, labels with state, Enter / Space = tap, Shift+Enter = hold, popups as dialogs
// with focus trap, Escape and focus return, reduced motion, and the editor's main actions by keyboard.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/a11y.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const config = {
  type: 'custom:floorplan-card',
  card_id: 'a11y',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [
    {
      id: 'f1',
      name: 'Wohnung',
      rooms: [
        { id: 'living', name: 'Wohnzimmer', points: rect(0, 0, 500, 400), lights: ['light.demo_ceiling'], temperature: 'sensor.demo_temp', humidity: 'sensor.demo_hum' },
        { id: 'kitchen', name: 'Küche', points: rect(500, 0, 850, 400), lights: ['light.demo_kitchen', 'light.demo_counter'] },
        { id: 'bath', name: 'Bad', points: rect(0, 400, 500, 700) },
      ],
      devices: [{ id: 'lamp', entity: 'light.demo_lamp', x: 380, y: 300 }],
      openings: [{ id: 'win', type: 'window', a: [100, 0], b: [220, 0], entity: 'binary_sensor.demo_window', name: 'Fenster Wohnzimmer' }],
      furniture: [{ id: 'sofa', kind: 'sofa', x: 200, y: 300, w: 200, h: 90 }],
    },
  ],
};
const states = {
  'light.demo_ceiling': { state: 'on', attributes: { friendly_name: 'Deckenlicht', brightness: 200, supported_color_modes: ['brightness'], color_mode: 'brightness' } },
  'light.demo_kitchen': { state: 'on', attributes: { friendly_name: 'Küchenlicht', supported_color_modes: ['onoff'], color_mode: 'onoff' } },
  'light.demo_counter': { state: 'off', attributes: { friendly_name: 'Arbeitslicht', supported_color_modes: ['onoff'] } },
  'light.demo_lamp': { state: 'off', attributes: { friendly_name: 'Stehlampe', supported_color_modes: ['brightness'] } },
  'sensor.demo_temp': { state: '21.5', attributes: { friendly_name: 'Temperatur', unit_of_measurement: '°C', device_class: 'temperature' } },
  'sensor.demo_hum': { state: '48', attributes: { friendly_name: 'Feuchte', unit_of_measurement: '%', device_class: 'humidity' } },
  'binary_sensor.demo_window': { state: 'off', attributes: { friendly_name: 'Fenster', device_class: 'window' } },
};

const m = await openMock({ config, states, size: '1280x800' });
const { page } = m;
await wait(800);
// deep active element: its data-kb, role, label and whether it sits in the layer (dialogs) or the editor
const active = () =>
  page.evaluate(() => {
    let a = document.activeElement;
    const path = [];
    while (a) {
      path.push(a.tagName.toLowerCase());
      if (!a.shadowRoot?.activeElement) break;
      a = a.shadowRoot.activeElement;
    }
    return { kb: a?.dataset?.kb ?? null, label: a?.getAttribute?.('aria-label') ?? null, tag: a?.tagName?.toLowerCase(), text: a?.textContent?.trim().slice(0, 40), path: path.join('>'), inLayer: path.includes('floorplan-card-layer'), inEditor: path.includes('floorplan-card-editor-ui') };
  });
const kbs = () => m.card(`[...plan.shadowRoot.querySelectorAll('.kb')].map((k) => ({ kb: k.dataset.kb, tab: k.tabIndex, label: k.getAttribute('aria-label'), role: k.getAttribute('role') }))`);

// ---------- the plan by keyboard ----------
const items = await kbs();
ok(items.length === 5, `focusable stand-ins: rooms, device, window (${items.map((i) => i.kb).join(' ')})`);
ok(items.map((i) => i.kb).join(' ') === 'room:living opening:win device:lamp room:kitchen room:bath', 'reading order: a room, then what is in it', items.map((i) => i.kb));
ok(!items.some((i) => i.kb === 'furniture:sofa'), 'unlinked furniture is not a stop on the card');
ok(items.filter((i) => i.tab === 0).length === 1, 'one Tab stop for the whole plan (roving focus)');
ok(items.every((i) => i.role === 'button' && i.label), 'every stand-in is a named button');
const living = items.find((i) => i.kb === 'room:living').label;
ok(/^Wohnzimmer, Licht an, 21,5 °C, 48 % Luftfeuchte$/.test(living), `room label with state: "${living}"`);
ok(items.find((i) => i.kb === 'room:kitchen').label === 'Küche, 1 von 2 Lichtern an', 'some lights on: counted');
ok(/^Stehlampe, /.test(items.find((i) => i.kb === 'device:lamp').label), 'device label with name and state');
ok(await m.card(`plan.shadowRoot.querySelector('.devices').getAttribute('aria-hidden') === 'true' && plan.shadowRoot.querySelector('.labels').getAttribute('aria-hidden') === 'true'`), 'visual markers and labels are hidden from screen readers (no doubles)');
ok(await m.card(`!!plan.shadowRoot.querySelector('.kb-layer[role=group]')?.getAttribute('aria-label') && !!plan.shadowRoot.getElementById('kb-help')?.textContent`), 'plan is a named group with a keyboard hint');

// Tab from the page start into the plan
await page.evaluate(() => document.body.focus());
let a;
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  a = await active();
  if (a.kb) break;
}
ok(a.kb === 'room:living', `Tab reaches the plan at its first room (${a.kb ?? a.path})`);
ok(await m.card(`!!plan.shadowRoot.querySelector('.kb-ring')`), 'focused room: its outline is drawn');
const ring = await m.card(`(() => { const k = plan.shadowRoot.querySelector('.kb:focus'); return getComputedStyle(k).boxShadow; })()`);
ok(ring && ring !== 'none', `visible focus ring (${ring?.slice(0, 40)})`);
await page.screenshot({ path: `${out}/a11y-focus-room.png` });
// arrows by position
await page.keyboard.press('ArrowRight');
a = await active();
ok(a.kb === 'device:lamp' || a.kb === 'room:kitchen', `ArrowRight goes to what is right of it (${a.kb})`);
await page.keyboard.press('Home');
await page.keyboard.press('ArrowDown');
a = await active();
ok(a.kb === 'room:bath' || a.kb === 'device:lamp', `ArrowDown goes down (${a.kb})`);
await page.keyboard.press('End');
a = await active();
ok(a.kb === items[items.length - 1].kb, 'End: the last item');
// Tab leaves the plan in one step, Shift+Tab comes back to where it was
await page.keyboard.press('Tab');
a = await active();
ok(!a.kb, `Tab leaves the plan (${a.path} ${a.label ?? a.text})`);
await page.keyboard.press('Shift+Tab');
a = await active();
ok(a.kb === items[items.length - 1].kb, `Shift+Tab returns to the last focused item (${a.kb})`);

// Enter on a room = tap: focuses the room (the default tap since 0.1.0-beta.8; the double tap switches its lights)
await page.keyboard.press('Home');
await m.clearCalls();
await page.keyboard.press('Enter');
await wait(600);
let calls = await m.calls();
const focusedRoom = await page.evaluate(`window.__fpCard.shadowRoot.querySelector('fp-plan').focused`);
ok(focusedRoom && !calls.some((c) => c.domain === 'light'), `Enter on a room = tap (focused: ${focusedRoom}, calls: ${calls.map((c) => c.domain + '.' + c.service).join(',') || 'none'})`);

// Enter on the device = tap: its popup as a dialog, focus inside, trapped, Escape closes, focus back
await page.keyboard.press('ArrowRight');
a = await active();
if (a.kb !== 'device:lamp') {
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
}
a = await active();
ok(a.kb === 'device:lamp', `on the lamp (${a.kb})`);
await page.keyboard.press('Enter');
await wait(600);
const dlg = await page.evaluate(() => {
  const s = document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.sheet');
  return s ? { role: s.getAttribute('role'), modal: s.getAttribute('aria-modal'), label: s.getAttribute('aria-label') } : null;
});
ok(dlg?.role === 'dialog' && dlg.modal === 'true' && dlg.label === 'Stehlampe', `popup is a named modal dialog (${JSON.stringify(dlg)})`);
a = await active();
ok(a.inLayer, `focus moved into the popup (${a.path})`);
let trapped = true;
for (let i = 0; i < 25; i++) {
  await page.keyboard.press('Tab');
  if (!(await active()).inLayer) trapped = false;
}
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('Shift+Tab');
  if (!(await active()).inLayer) trapped = false;
}
ok(trapped, 'Tab and Shift+Tab stay inside the popup');
await page.screenshot({ path: `${out}/a11y-popup.png` });
await page.keyboard.press('Escape');
await wait(500);
ok(!(await page.evaluate(() => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.sheet'))), 'Escape closes the popup');
a = await active();
ok(a.kb === 'device:lamp', `focus is back on the lamp (${a.kb ?? a.path})`);

// Shift+Enter = hold: on a device opens more-info (HA's dialog), on a room its popup
const moreInfo = page.evaluate(() => new Promise((r) => { window.addEventListener('hass-more-info', (e) => r(e.detail?.entityId ?? true), { once: true }); setTimeout(() => r(null), 1500); }));
await page.keyboard.press('Shift+Enter');
ok((await moreInfo) === 'light.demo_lamp', 'Shift+Enter on a device = hold (more-info)');
await page.keyboard.press('Home');
await page.keyboard.press('ContextMenu');
await wait(600);
ok(await page.evaluate(() => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.sheet fp-room-popup')), 'context menu key on a room = hold (room popup)');
await page.keyboard.press('Escape');
await wait(500);

// state changes reach the label
await m.setStates({ 'light.demo_ceiling': { state: 'off' } });
await wait(200);
ok(/Licht aus/.test((await kbs()).find((i) => i.kb === 'room:living').label), 'label follows the state (Licht aus)');
ok(m.errors.length === 0, `no console errors (${m.errors.slice(0, 3).join(' | ')})`);

// ---------- the editor by keyboard ----------
// the pencil is a button reachable with Tab
let found = false;
await page.evaluate(() => document.body.focus());
for (let i = 0; i < 20 && !found; i++) {
  await page.keyboard.press('Tab');
  found = (await active()).label === 'Grundriss bearbeiten';
}
ok(found, 'the edit pencil is reachable with Tab');
await page.keyboard.press('Enter');
await wait(1500);
// the tour sits inside the editor's own shadow root: end it there (as its "Skip" would)
await page.evaluate(() => {
  const ed = document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('floorplan-card-editor-ui');
  (ed?.shadowRoot?.querySelector('fp-editor-tour') ?? document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('fp-editor-tour'))?.dispatchEvent(new CustomEvent('tour-end', { bubbles: true, composed: true }));
});
await wait(300);
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
ok(await page.evaluate((ed) => eval(ed)?.getAttribute('role') === 'dialog' && eval(ed)?.getAttribute('aria-modal') === 'true', ED), 'editor is a modal dialog');
a = await active();
ok(a.inEditor, `focus moved into the editor (${a.path} ${a.label ?? a.text})`);
// Tab reaches the save button and the tools, never leaves the editor
const seen = new Set();
let left = false;
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab');
  const x = await active();
  if (!x.inEditor) left = true;
  seen.add(x.label ?? x.text);
}
ok(!left, 'Tab stays inside the editor');
ok(seen.has('Sichern') && seen.has('Raum zeichnen') && seen.has('Etage hinzufügen') && seen.has('Objekte'), `toolbar and tools reachable (${[...seen].slice(0, 14).join(', ')})`);
// Space presses a tool button (it does not grab the view)
const focusBtn = (sel) => page.evaluate(([ed, s]) => eval(ed).shadowRoot.querySelector(s).focus(), [ED, sel]);
await focusBtn('[data-tool="draw"]');
await page.keyboard.press(' ');
await wait(200);
ok((await page.evaluate((ed) => eval(ed)._tool, ED)) === 'draw', 'Space on "Raum zeichnen" picks the tool');
// draw a room with the keyboard: arrows move the cross on the grid, Enter sets corners, Enter on the first closes it
const roomsBefore = await page.evaluate((ed) => eval(ed).floor.rooms.length, ED);
// blur the element that really has the focus (inside the shadow roots): blurring only the outer host does not
// move the focus in every browser (Firefox keeps it on the tool button)
await page.evaluate(() => {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  a?.blur?.();
});
const key = async (k, n = 1) => {
  for (let i = 0; i < n; i++) await page.keyboard.press(k);
};
await key('ArrowRight');
await key('Shift+ArrowDown', 6); // somewhere below the flat (grid 20 cm × 5 per step)
await key('Enter');
await key('Shift+ArrowRight', 3);
await key('Enter');
await key('Shift+ArrowDown', 2);
await key('Enter');
await key('Shift+ArrowLeft', 3);
await key('Enter');
await key('Shift+ArrowUp', 2);
await key('Enter');
await wait(300);
const drawn = await page.evaluate((ed) => ({ n: eval(ed).floor.rooms.length, tool: eval(ed)._tool, last: eval(ed).floor.rooms.at(-1)?.points }), ED);
ok(drawn.n === roomsBefore + 1 && drawn.tool === 'select' && drawn.last?.length === 4, `room drawn by keyboard (${JSON.stringify(drawn)})`);
// arrows move the selection (here: the new room), Shift 10 cm; Delete removes it
const p0 = drawn.last?.[0];
await key('ArrowRight');
await key('Shift+ArrowDown');
const p1 = await page.evaluate((ed) => eval(ed).floor.rooms.at(-1).points[0], ED);
ok(p0 && p1[0] === p0[0] + 1 && p1[1] === p0[1] + 10, `arrows move the selection (${p0} → ${p1})`);
// the plan's stand-ins work in the editor too: Enter selects
await page.evaluate((ed) => eval(ed).plan.shadowRoot.querySelector('.kb[data-kb="room:kitchen"]').focus(), ED);
await key('Enter');
await wait(200);
ok((await page.evaluate((ed) => eval(ed)._sel, ED))?.id === 'kitchen', 'Enter on a room in the editor selects it');
ok(await page.evaluate((ed) => eval(ed).plan.shadowRoot.querySelector('.kb[data-kb="room:kitchen"]').getAttribute('aria-pressed') === 'true', ED), 'selected item: aria-pressed');
ok(await page.evaluate((ed) => !!eval(ed).plan.shadowRoot.querySelector('.kb[data-kb="furniture:sofa"]'), ED), 'editor: every piece of furniture is a stop');
// the 2D/3D switch is a radio group: arrows change it
await focusBtn('fp-segmented.dim');
const seg = await page.evaluate((ed) => {
  const s = eval(ed).shadowRoot.querySelector('fp-segmented.dim');
  const b = s.shadowRoot.querySelector('button[aria-checked="true"]');
  b.focus();
  return { role: s.shadowRoot.querySelector('.segmented').getAttribute('role'), checked: b.textContent.trim() };
}, ED);
await key('ArrowRight');
await wait(200);
ok(seg.role === 'radiogroup' && (await page.evaluate((ed) => eval(ed)._view3d, ED)) === true, `2D/3D: radio group, arrow switches (${JSON.stringify(seg)})`);
await key('ArrowLeft');
await page.screenshot({ path: `${out}/a11y-editor.png` });
await m.browser.close();

// ---------- reduced motion ----------
const r = await openMock({ config, states, size: '1000x700', reducedMotion: 'reduce' });
const dur = await r.card(`getComputedStyle(card).getPropertyValue('--fp-dur').trim()`);
ok(dur === '1ms', `reduced motion: transitions instant (--fp-dur ${dur})`);
const before = await r.card(`plan.shadowRoot.querySelector('.world').style.transform`);
const after = await r.card(`(await plan.focusRoom('kitchen'), plan.shadowRoot.querySelector('.world').style.transform)`);
await wait(400);
const settled = await r.card(`plan.shadowRoot.querySelector('.world').style.transform`);
ok(before !== after && after === settled, 'reduced motion: zooming onto a room jumps, no glide');
ok(r.errors.length === 0, `no console errors (${r.errors.slice(0, 3).join(' | ')})`);
await r.browser.close();

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
