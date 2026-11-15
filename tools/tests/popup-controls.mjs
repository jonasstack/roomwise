// The most used popup controls send exactly the right service call, and every way of closing a popup (✕, tap beside it,
// Escape) closes it without calling anything. Entities come from the dashboard's plan; all service calls are intercepted.
//   node tools/tests/popup-controls.mjs [outdir]   (test HA prepared by testha-setup.mjs)
import { openHA, tapAt, piecePoint, roomPoint } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const ALL = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant', 'remote', 'button', 'script', 'scene', 'lock'];
const { browser, page, errors, calls } = await openHA({ block: ALL });
await page.waitForTimeout(3000);
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const skip = (m) => console.log('• skip:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const C = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); return ${expr}; })()`);
const floor = await C('card.rawConfig.floors[0]');
const ids = [...floor.devices, ...floor.furniture].map((x) => x.entity).filter(Boolean);
const first = (prefix) => ids.find((e) => e.startsWith(prefix));
const open = (entity) => C(`(card.ensureLayer().openPopup({ entity: ${JSON.stringify(entity)} }), true)`);
const isOpen = async () => (await page.locator('floorplan-card-layer .sheet').count()) === 1;
const clear = () => page.evaluate(() => (window.__fpCalls.length = 0));
const svc = async (domain) => (await calls()).filter((c) => c.domain === domain && !c.service.startsWith('get'));
const close = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
};

// 1) closing: ✕, tap beside the sheet, Escape — no service call
const light = first('light.');
for (const [how, act] of [
  ['✕', () => page.locator('floorplan-card-layer .sheet .close').first().click()],
  ['tap beside it', () => page.mouse.click(8, 8)],
  ['Escape', () => page.keyboard.press('Escape')],
]) {
  await open(light);
  await page.waitForTimeout(600);
  const was = await isOpen();
  await clear();
  await act();
  // the closing animation can take a while when software WebGL keeps the page busy
  for (let i = 0; i < 8 && (await isOpen()); i++) await page.waitForTimeout(250);
  ok(was && !(await isOpen()) && !(await calls()).length, `popup closes with ${how}, nothing switched`);
}

// 2) light: big toggle or switch, colour temperature swatch
await open(light);
await page.waitForTimeout(600);
await clear();
const toggle = page.locator('fp-light-popup .big-toggle, fp-light-popup .switch').first();
const on0 = await C(`card._hass.states['${light}'].state === 'on'`);
await toggle.click();
await page.waitForTimeout(400);
let c = await svc('light');
ok(c.length === 1 && c[0].service === (on0 ? 'turn_off' : 'turn_on'), `light: on/off button → exactly one light.${on0 ? 'turn_off' : 'turn_on'} (${c.map((x) => x.service).join(', ')})`);
const sw = page.locator('fp-light-popup .swatches .swatch');
if (await sw.count()) {
  await clear();
  await sw.first().click();
  await page.waitForTimeout(400);
  c = await svc('light');
  ok(c.length === 1 && c[0].service === 'turn_on' && (c[0].data?.color_temp_kelvin || c[0].data?.rgb_color || c[0].data?.hs_color), `light: a colour swatch → one turn_on with a colour (${JSON.stringify(c[0]?.data)})`);
} else skip('light without colour or white tone');
await page.screenshot({ path: `${out}/pc-light.png` });
await close();

// 3) room popup: all lights on/off
const room = floor.rooms.find((r) => (r.lights ?? []).length);
const rp = await roomPoint(page, room.name);
if (rp) {
  await tapAt(page, rp[0], rp[1], 900);
  await page.waitForTimeout(900);
  await clear();
  const allBtn = page.locator('fp-room-popup .section-head .btn');
  if (await allBtn.count()) {
    const label = (await allBtn.textContent()).trim();
    await allBtn.click();
    await page.waitForTimeout(400);
    c = await svc('light');
    ok(c.length >= 1 && c.every((x) => x.service === (/aus/i.test(label) ? 'turn_off' : 'turn_on')), `room "${room.name}": "${label}" switches its lights (${c.map((x) => x.service).join(', ')})`);
  } else ok(false, `room "${room.name}": no all-on/off button`);
  await page.screenshot({ path: `${out}/pc-room.png` });
  await close();
} else ok(false, `no free floor point in room "${room.name}"`);

// 4) media player: next track and volume
const media = first('media_player.');
if (media) {
  await open(media);
  await page.waitForTimeout(700);
  await clear();
  const next = page.locator('fp-media-player-popup .icon-btn[aria-label="Weiter"], fp-media-player-popup .icon-btn[aria-label="Nächster Titel"]').first();
  if ((await next.count()) && !(await next.isDisabled())) {
    await next.click();
    await page.waitForTimeout(300);
    ok((await svc('media_player')).some((x) => x.service === 'media_next_track'), 'media: next → media_next_track');
  } else skip('media player without "next"');
  const vol = page.locator('fp-media-player-popup fp-slider').first();
  if (await vol.count()) {
    await clear();
    const b = await vol.boundingBox();
    await tapAt(page, b.x + b.width * 0.3, b.y + b.height / 2);
    await page.waitForTimeout(900);
    c = (await svc('media_player')).filter((x) => x.service === 'volume_set');
    ok(c.length === 1 && c[0].data.volume_level > 0 && c[0].data.volume_level < 1, `media: volume slider → one volume_set (${c[0]?.data?.volume_level})`);
  } else skip('media player without volume');
  await close();
} else skip('no media player in the plan');

// 5) vacuum: start or pause
const vac = first('vacuum.');
if (vac) {
  await open(vac);
  await page.waitForTimeout(700);
  await clear();
  const btn = page.locator('fp-vacuum-popup [data-action="start"], fp-vacuum-popup [data-action="pause"]').first();
  if (await btn.count()) {
    const action = await btn.getAttribute('data-action');
    await btn.click();
    await page.waitForTimeout(300);
    ok((await svc('vacuum')).some((x) => x.service === action), `vacuum: ${action} → vacuum.${action}`);
  } else skip('vacuum without start/pause');
  await close();
} else skip('no vacuum in the plan');

// 6) a lamp tapped on the plan toggles it (one call), long press opens its popup instead
const pt = await piecePoint(page, light);
if (pt) {
  await clear();
  await tapAt(page, pt[0], pt[1]);
  await page.waitForTimeout(500);
  ok((await svc('light')).length === 1 && !(await isOpen()), 'tap on a lamp: one light call, no popup');
  await clear();
  await tapAt(page, pt[0], pt[1], 900);
  await page.waitForTimeout(800);
  ok((await isOpen()) && !(await svc('light')).length, 'long press on a lamp: popup, no light call');
  await close();
}
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
