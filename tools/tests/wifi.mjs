// Wi-Fi QR codes. Part 1 (node only): the join text and its escaping, the QR encoder (known matrices, checked once against
// jsQR for all versions 1–15), reading a code back with the vendored jsQR into the editor's fields.
// Part 2 (mock harness): a tap on the router opens the popup with the QR code from the companion's networks (never from
// the dashboard config), "show password", a FRITZ!Box found by its entities (guest QR image, guest switch, connection,
// devices), the guest Wi-Fi switch asks before switching off and calls the switch.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/wifi.mjs [outDir]
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- part 1: payload, encoder, reader ----------
const bundle = async (entry) => {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
};
const qr = await bundle('src/wifi-qr.ts');
// the vendored reader is a UMD file: run it as CommonJS
const jsQR = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', readFileSync('src/vendor/jsqr/jsQR.js', 'utf8'))(module, module.exports);
  return module.exports.default ?? module.exports;
})();
const hash = (m) => createHash('sha256').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);
const decode = (m) => {
  const s = 4;
  const px = (m.length + 8) * s;
  const d = new Uint8ClampedArray(px * px * 4).fill(255);
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) d.fill(0, (((y + 4) * s + dy) * px + (x + 4) * s + dx) * 4, (((y + 4) * s + dy) * px + (x + 4) * s + dx) * 4 + 3);
  }));
  return jsQR(d, px, px)?.data;
};
const special = qr.wifiPayload({ ssid: 'Demo Home', password: 'pa;ss:w,o"rd\\', security: 'wpa2' });
ok(special === 'WIFI:T:WPA;S:Demo Home;P:pa\\;ss\\:w\\,o\\"rd\\\\;H:false;;', `escaping \\ ; , : " (${special})`);
ok(qr.wifiPayload({ ssid: 'Cafe', password: 'egal', security: 'nopass' }) === 'WIFI:T:nopass;S:Cafe;H:false;;', 'open network: no password');
ok(qr.wifiPayload({ ssid: 'Demo', password: '12345678', security: 'wpa3', hidden: true }) === 'WIFI:T:WPA;R:1;S:Demo;P:12345678;H:true;;', 'WPA3 (R:1), hidden');
ok(qr.wifiEscape('ABCD12') === 'ABCD12', 'hex-looking text stays as it is (no quotes a phone could take literally)');
const known = [
  [special, '070a824d374d064a'],
  [qr.wifiPayload({ ssid: 'Wöhnzimmer 🏠', password: 'äöü-ß-€€€€', security: 'wpa3', hidden: true }), 'ed3575439344f59b'],
  [qr.wifiPayload({ ssid: 'Demo-Gast', password: 'gast-demo-2026', security: 'wpa2' }), 'e8fffd903575bbf3'],
];
for (const [text, h] of known) {
  const m = qr.qrMatrix(text);
  ok(hash(m) === h && decode(m) === text, `QR matrix as verified (${text.slice(0, 30)}…)`, hash(m));
}
let readBack = 0;
for (let len = 1; len <= 380; len += 19) if (decode(qr.qrMatrix('x'.repeat(len))) === 'x'.repeat(len)) readBack++;
ok(readBack === 20, `20 lengths up to version 15 read back by jsQR (${readBack})`);
const parsed = qr.wifiParse(decode(qr.qrMatrix(special)));
ok(parsed?.ssid === 'Demo Home' && parsed.password === 'pa;ss:w,o"rd\\' && parsed.security === 'wpa2' && parsed.hidden === false, 'read from a picture: fields back', parsed);
ok(qr.wifiParse('WIFI:T:SAE;S:"ABCD12";P:x\\;y12345;H:true;;')?.security === 'wpa3' && qr.wifiParse('WIFI:T:SAE;S:"ABCD12";P:x;H:true;;').ssid === 'ABCD12', 'SAE → WPA3, quotes removed');
ok(qr.wifiParse('https://example.org') === undefined, 'another QR code: not Wi-Fi');

// ---------- part 2: the popup on the mock harness ----------
const PW = 'gast-demo-2026';
const cfg = demoHome();
cfg.floors[0].furniture.push({ id: 'router', kind: 'router', variant: 'fritzbox', x: 300, y: 60, w: 25, h: 17 });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const box = { platform: 'fritz', device_id: 'dev_box' };
const entities = {
  ...demoEntities,
  'image.demo_box_gast': { entity_id: 'image.demo_box_gast', ...box },
  'switch.demo_box_wi_fi_guest': { entity_id: 'switch.demo_box_wi_fi_guest', translation_key: 'wi_fi_guest', ...box },
  'switch.demo_box_wi_fi_main_2_4ghz': { entity_id: 'switch.demo_box_wi_fi_main_2_4ghz', translation_key: 'wi_fi_main_2_4ghz', ...box },
  'binary_sensor.demo_box_connection': { entity_id: 'binary_sensor.demo_box_connection', translation_key: 'is_connected', ...box },
  'device_tracker.phone_a': { entity_id: 'device_tracker.phone_a', platform: 'fritz' },
  'device_tracker.phone_b': { entity_id: 'device_tracker.phone_b', platform: 'fritz' },
  'device_tracker.laptop': { entity_id: 'device_tracker.laptop', platform: 'fritz' },
};
const states = {
  ...demoStates(),
  'image.demo_box_gast': { state: '2026-01-01T00:00:00+00:00', attributes: { friendly_name: 'Demo-Gast', entity_picture: png } },
  'switch.demo_box_wi_fi_guest': { state: 'on', attributes: { friendly_name: 'Wi-Fi Guest' } },
  'switch.demo_box_wi_fi_main_2_4ghz': { state: 'on', attributes: { friendly_name: 'Wi-Fi Main 2.4Ghz' } },
  'binary_sensor.demo_box_connection': { state: 'on', attributes: { device_class: 'connectivity' } },
  'device_tracker.phone_a': { state: 'home' },
  'device_tracker.phone_b': { state: 'home' },
  'device_tracker.laptop': { state: 'not_home' },
};
const networks = [{ id: 'net_1', name: 'Gäste', ssid: 'Demo-Gast', password: PW, security: 'wpa2', hidden: false }];
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states, entities, size: '1280x900', ws: { 'floorplan_card/wifi/get': { networks } } });
const { page } = m;
const pop = (expr) => page.evaluate(`(() => { const p = document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('fp-wifi-popup'); const r = p?.shadowRoot; return ${expr}; })()`);

ok(!JSON.stringify(await m.card('card.rawConfig ?? card._config')).includes(PW), 'password not in the dashboard config');
await m.card(`(card.gesture({ kind: 'furniture', id: 'router' }, 'tap'), true)`);
await page.waitForFunction(() => document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('fp-wifi-popup')?.shadowRoot?.querySelector('.qr'), null, { timeout: 8000 }).catch(() => {});
ok(await pop(`!!r?.querySelector('svg.qr path')?.getAttribute('d')?.length`), 'tap on the router: popup with a QR code');
ok((await page.evaluate(() => window.__fpWs.map((w) => w.type))).includes('floorplan_card/wifi/get'), 'networks asked from the companion');
ok((await pop(`r.querySelector('.ssid')?.textContent`)) === 'Demo-Gast', 'SSID shown');
ok(!(await pop(`r.textContent`)).includes(PW), 'password hidden at first');
ok((await pop(`r.querySelector('.head-sub')?.textContent`))?.includes('2'), 'router info: connected, devices', await pop(`r.querySelector('.head-sub')?.textContent`));
await page.screenshot({ path: `${out}/wifi-popup.png` });
await pop(`(r.querySelector('button.show').click(), true)`);
await wait(150);
ok((await pop(`r.querySelector('.pw')?.textContent`)) === PW, '"Passwort anzeigen" shows it');
const chips = await pop(`[...r.querySelectorAll('.pick .chip')].map((c) => c.textContent.trim())`);
ok(chips?.length === 2 && chips[1] === 'Gäste-WLAN', 'FRITZ!Box guest Wi-Fi found automatically', chips);
await pop(`(r.querySelectorAll('.pick .chip')[1].click(), true)`);
await wait(150);
ok((await pop(`r.querySelector('img.qr')?.getAttribute('src')`)) === png, 'guest QR image of the router shown');
ok(await pop(`r.querySelector('.guest-switch')?.getAttribute('aria-checked') === 'true'`), 'guest Wi-Fi switch: on');
await page.screenshot({ path: `${out}/wifi-popup-guest.png` });
await m.clearCalls();
await pop(`(r.querySelector('.guest-switch').click(), true)`);
await wait(200);
const confirmBtn = await page.evaluate(() => !!document.querySelector('floorplan-card-layer').shadowRoot.querySelector('.alert .btn.accent'));
ok(confirmBtn, 'switching off asks first');
await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('.alert .btn.accent').click());
await wait(200);
const calls = await m.calls();
ok(calls.some((c) => c.domain === 'switch' && c.service === 'turn_off' && c.data?.entity_id === 'switch.demo_box_wi_fi_guest'), 'guest switch turned off', calls);
await m.setStates({ 'switch.demo_box_wi_fi_guest': { state: 'off' } });
await m.clearCalls();
await pop(`(r.querySelector('.guest-switch').click(), true)`);
await wait(200);
ok((await m.calls()).some((c) => c.service === 'turn_on'), 'switching on: at once');
ok(!m.errors.length, 'no console errors', m.errors);
await m.browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
