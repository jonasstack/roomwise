// A piece of furniture holding several devices (`contents`): a tap on the cabinet lists what is inside (icon, name,
// state, a quick switch only for plain on / off devices), a row opens that device's own popup (back returns to the
// list), an opener (door buzzer) gets no quick switch, a piece with only
// `entity` acts as before, and the inspector adds / reorders / removes devices.
// The Wi-Fi QR codes item (`{ kind: 'wifi' }`, no entity): a cabinet without an own entity holding a light and the
// router's QR codes lists both, the row opens the Wi-Fi popup with a network stored in the companion (no FRITZ!Box
// entities anywhere); a piece holding only the QR codes opens them directly; validateConfig accepts the item; the
// inspector shows the network editor for such a piece and adds the item to any piece.
// Mock harness (no Home Assistant, neutral demo home).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/furniture-contents.mjs [outDir]
import * as esbuild from 'esbuild';
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = demoHome();
const fl = cfg.floors[0];
fl.furniture.push({
  id: 'cab',
  kind: 'sideboard',
  name: 'Sideboard',
  x: 300,
  y: 40,
  w: 180,
  h: 45,
  contents: [
    { entity: 'light.demo_cabinet', name: 'Vitrinenlicht' },
    { entity: 'media_player.demo_receiver', icon: 'mdi:audio-video' },
    { entity: 'switch.demo_door_buzzer' },
  ],
});
// a cabinet without an own entity: a light and the router's Wi-Fi QR codes (router not in Home Assistant)
fl.furniture.push({ id: 'hall', kind: 'wardrobe', x: 520, y: 40, w: 100, h: 60, contents: [{ entity: 'light.demo_cabinet' }, { kind: 'wifi' }] });
// a piece holding only the QR codes
fl.furniture.push({ id: 'qr', kind: 'shelf', name: 'Regal', x: 520, y: 200, w: 80, h: 30, contents: [{ kind: 'wifi', name: 'Gast-WLAN' }] });
// unchanged: a lamp with a single entity switches on tap
fl.furniture.push({ id: 'lamp', kind: 'floor_lamp', entity: 'light.demo_lamp', x: 80, y: 420, w: 40, h: 40 });

const states = {
  ...demoStates(),
  'light.demo_cabinet': { state: 'off', attributes: { friendly_name: 'Schranklicht', supported_color_modes: ['onoff'] } },
  'media_player.demo_receiver': { state: 'on', attributes: { friendly_name: 'Receiver', supported_features: 18877, volume_level: 0.4 } },
  'switch.demo_door_buzzer': { state: 'off', attributes: { friendly_name: 'Türöffner' } },
  'light.demo_lamp': { state: 'off', attributes: { friendly_name: 'Stehlampe', supported_color_modes: ['onoff'] } },
};
const NET = { id: 'n1', name: 'Demo', ssid: 'Demo-Net', password: 'demo-pass-123', security: 'wpa2', hidden: false };
ok(!Object.values(demoEntities).some((e) => e?.platform === 'fritz') && !Object.keys(states).some((e) => /fritz/i.test(e)), 'no FRITZ!Box entities in the mock');
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states, entities: demoEntities, size: '1280x900', ws: { 'floorplan_card/wifi/get': { networks: [NET] } } });
const { page } = m;
const LAYER = `document.querySelector('floorplan-card-layer').shadowRoot`;
const inLayer = (expr) => page.evaluate(`(() => { const L = ${LAYER}; const p = L.querySelector('fp-furniture-popup'); const r = p?.shadowRoot; return ${expr}; })()`);

// validateConfig (in the page: config.ts pulls in lit): the Wi-Fi item needs no entity; an item without either stays invalid
{
  const r = await esbuild.build({ entryPoints: ['src/config.ts'], bundle: true, format: 'iife', globalName: '__fpConfig', write: false, platform: 'browser', logLevel: 'silent' });
  await page.addScriptTag({ content: r.outputFiles[0].text });
  const n = (contents) => page.evaluate((c) => window.__fpConfig.validateConfig({ type: 'custom:floorplan-card', floors: [{ id: 'f', name: 'F', rooms: [], furniture: [{ id: 'c', kind: 'wardrobe', x: 0, y: 0, w: 60, h: 60, contents: c }] }] }).length, contents);
  ok((await n([{ kind: 'wifi' }, { entity: 'light.demo_cabinet' }])) === 0, 'validateConfig accepts the Wi-Fi item next to a device');
  ok((await n([{ kind: 'wifi', name: 'Router' }])) === 0, 'validateConfig accepts the Wi-Fi item alone');
  ok((await n([{ name: 'nothing' }])) === 1 && (await n([{ kind: 'wifi', entity: 'light.x' }])) === 1, 'validateConfig rejects an item with neither, or a Wi-Fi item with an entity');
}

// 1) tap → overview with the three devices
await m.card(`(card.gesture({ kind: 'furniture', id: 'cab' }, 'tap'), true)`);
await wait(600);
const rows = await inLayer(`r ? [...r.querySelectorAll('[data-content]')].map((x) => ({ id: x.dataset.content, title: x.querySelector('.title')?.textContent, sw: !!x.querySelector('.switch') })) : null`);
ok(rows?.length === 3, `overview lists 3 devices (${JSON.stringify(rows)})`);
ok(rows?.[0]?.title === 'Vitrinenlicht' && rows?.[1]?.title === 'Receiver', 'own name used, else the friendly name');
ok(rows?.[0]?.sw && !rows?.[1]?.sw && !rows?.[2]?.sw, 'quick switch only for the plain light (not the media player, not the door opener)');
if (out) await page.screenshot({ path: `${out}/furniture-contents.png` });

// 2) quick switch toggles the light
await m.clearCalls();
await inLayer(`(r.querySelector('[data-content="light.demo_cabinet"] .switch').click(), true)`);
await wait(200);
let c = await m.calls();
ok(c.length === 1 && c[0].domain === 'light' && c[0].service === 'toggle', `quick switch toggles the light (${JSON.stringify(c.map((x) => `${x.domain}.${x.service}`))})`);

// 3) a row opens the device's own popup; back returns to the list
await inLayer(`(r.querySelector('[data-content="media_player.demo_receiver"] .open').click(), true)`);
await wait(800);
const media = await page.evaluate(`!!${LAYER}.querySelector('fp-media-player-popup')`);
ok(media, 'row opens the media player popup');
await page.evaluate(`${LAYER}.querySelector('fp-media-player-popup').shadowRoot.querySelector('.back')?.click()`);
await wait(400);
ok(await inLayer('!!r'), 'back returns to the overview');
await page.keyboard.press('Escape');
await wait(500);

// 4) single-entity piece unchanged: tap toggles the lamp, no overview
await m.clearCalls();
await m.card(`(card.gesture({ kind: 'furniture', id: 'lamp' }, 'tap'), true)`);
await wait(400);
c = await m.calls();
ok(c.length === 1 && c[0].domain === 'light' && c[0].target?.entity_id === 'light.demo_lamp', `single-entity lamp still toggles (${JSON.stringify(c.map((x) => `${x.domain}.${x.service}`))})`);
ok(!(await inLayer('!!p')), 'single-entity lamp opens no overview');

// 4b) cabinet without entity + Wi-Fi item: overview lists both, the Wi-Fi row opens the popup with the stored network
await m.card(`(card.gesture({ kind: 'furniture', id: 'hall' }, 'tap'), true)`);
await wait(600);
const hall = await inLayer(`r ? [...r.querySelectorAll('[data-content]')].map((x) => ({ id: x.dataset.content, title: x.querySelector('.title')?.textContent })) : null`);
ok(hall?.length === 2 && hall[0].id === 'light.demo_cabinet' && hall[1].id === 'wifi' && hall[1].title === 'WLAN-QR-Code', `cabinet without entity lists the light and the Wi-Fi QR code (${JSON.stringify(hall)})`);
await inLayer(`(r.querySelector('[data-content="wifi"] .open').click(), true)`);
await wait(800);
const WIFI = `${LAYER}.querySelector('fp-wifi-popup')?.shadowRoot`;
const wifi = await page.evaluate(`(() => { const r = ${WIFI}; return r ? { ssid: r.querySelector('[data-net="n1"] .ssid')?.textContent, qr: !!r.querySelector('svg.qr path'), details: !!r.querySelector('.details') } : null; })()`);
ok(wifi?.ssid === 'Demo-Net' && wifi.qr, `Wi-Fi row opens the popup with the stored network's QR code (${JSON.stringify(wifi)})`);
ok(wifi && !wifi.details, 'no "details" of the cabinet in the Wi-Fi popup');
if (out) await page.screenshot({ path: `${out}/furniture-contents-wifi.png` });
await page.evaluate(`${LAYER}.querySelector('fp-wifi-popup').shadowRoot.querySelector('.back')?.click()`);
await wait(400);
ok(await inLayer('!!r'), 'back from the Wi-Fi popup returns to the overview');
await page.keyboard.press('Escape');
await wait(500);

// 4c) a piece holding only the QR codes: tap opens the Wi-Fi popup directly, titled like the item
await m.card(`(card.gesture({ kind: 'furniture', id: 'qr' }, 'tap'), true)`);
await wait(800);
const direct = await page.evaluate(`(() => { const L = ${LAYER}; const r = L.querySelector('fp-wifi-popup')?.shadowRoot; return { overview: !!L.querySelector('fp-furniture-popup'), ssid: r?.querySelector('[data-net="n1"] .ssid')?.textContent, title: r?.querySelector('.title, h2')?.textContent?.trim() }; })()`);
ok(!direct.overview && direct.ssid === 'Demo-Net', `only the Wi-Fi item: tap opens the Wi-Fi popup directly (${JSON.stringify(direct)})`);
await page.keyboard.press('Escape');
await wait(500);

// 5) inspector: the section lists, reorders and removes
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fp-tour-')) localStorage.removeItem(k); });
await m.card(`(card.openEditor(), true)`);
await wait(1500);
const ED = `${LAYER}.querySelector('floorplan-card-editor-ui')`;
const hasEd = await page.evaluate(`!!${ED}`);
if (hasEd) {
  await page.evaluate(`(() => { const ed = ${ED}; ed.select({ kind: 'furniture', id: 'cab' }); for (const d of ed.shadowRoot.querySelectorAll('details.fold')) d.open = true; })()`);
  await wait(500);
  const list = () => page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('[data-contents] [data-content]')].map((x) => x.dataset.content)`);
  const l1 = await list();
  ok(l1.length === 3, `inspector lists the 3 devices (${l1.join(', ')})`);
  await page.evaluate(`${ED}.shadowRoot.querySelector('[data-contents] [data-content="media_player.demo_receiver"] [aria-label="Nach oben"]').click()`);
  await wait(300);
  const l2 = await list();
  ok(l2[0] === 'media_player.demo_receiver', `move up reorders (${l2.join(', ')})`);
  const draft = await page.evaluate(`${ED}._draft.floors[0].furniture.find((f) => f.id === 'cab').contents.map((c) => c.entity)`);
  ok(draft[0] === 'media_player.demo_receiver', 'draft config follows the new order');
  ok(await page.evaluate(`!!${ED}.shadowRoot.querySelector('[data-add-content]')`), 'add button present');
  ok(await page.evaluate(`!!${ED}.shadowRoot.querySelector('[data-add-wifi]')`), 'add Wi-Fi QR code offered for any piece');
  ok(!(await page.evaluate(`!!${ED}.shadowRoot.querySelector('.wifi-add')`)), 'no network editor while the piece has no Wi-Fi item');
  // adding the Wi-Fi item: no entity asked, the network editor appears (networks from the companion)
  await page.evaluate(`${ED}.shadowRoot.querySelector('[data-add-wifi]').click()`);
  await wait(800);
  const after = await page.evaluate(`${ED}._draft.floors[0].furniture.find((f) => f.id === 'cab').contents`);
  ok(after.length === 4 && after[3].kind === 'wifi' && !after[3].entity, `Wi-Fi item added without an entity (${JSON.stringify(after[3])})`);
  const ed2 = await page.evaluate(`(() => { const r = ${ED}.shadowRoot; return { add: !!r.querySelector('.wifi-add'), scan: !!r.querySelector('.wifi-scan'), nets: r.querySelectorAll('.wifi-net').length, again: !!r.querySelector('[data-add-wifi]'), entEdit: !!r.querySelector('.ent-edit') }; })()`);
  ok(ed2.add && ed2.scan && ed2.nets === 1 && !ed2.again && !ed2.entEdit, `network editor with "add" and "read from picture", 1 stored network, no entity dialog (${JSON.stringify(ed2)})`);
  if (out) await page.screenshot({ path: `${out}/furniture-contents-inspector.png` });
  await page.evaluate(`${ED}.shadowRoot.querySelector('[data-content="wifi"] [data-remove-wifi]').click()`);
  await wait(300);
  const removed = await page.evaluate(`${ED}._draft.floors[0].furniture.find((f) => f.id === 'cab').contents.length`);
  ok(removed === 3, 'Wi-Fi item removed again');
} else ok(false, 'editor did not open');

const errs = m.errors.filter((e) => !/favicon|net::ERR/.test(e));
ok(!errs.length, `no console errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
await m.browser.close();
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
