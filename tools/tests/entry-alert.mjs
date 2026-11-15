// Front door warning end to end. Door, windows and the remote button are faked inside the page,
// TTS calls are intercepted — nothing is spoken, switched or saved.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors, calls } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['tts', 'media_player', 'light', 'switch'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);

const setup = (entry) =>
  page.evaluate(`(() => { ${FIND} const card = find(document);
    if (!window.__fake) {
      window.__fake = {};
      const orig = card.optimistic.get.bind(card.optimistic);
      card.optimistic.get = (h, id) => window.__fake[id] ? { entity_id: id, attributes: {}, context: {}, last_updated: '', ...window.__fake[id] } : orig(h, id);
    }
    const f0 = card.rawConfig.floors[0];
    const door = f0.openings.find((o) => o.type === 'door');
    const wins = f0.openings.filter((o) => o.type === 'window').slice(0, 3);
    window.__ids = { door: door.id, wins: wins.map((w) => w.id) };
    // every other window gets a closed fake sensor, so real open windows do not interfere
    window.__fake['binary_sensor.fp_closed'] = { state: 'off', last_changed: '' };
    const openings = f0.openings.map((o) => o.id === door.id ? { ...o, entity: 'binary_sensor.fp_door' } : wins.includes(o) ? { ...o, entity: 'binary_sensor.fp_w' + wins.indexOf(o) } : o.type === 'window' && o.entity ? { ...o, entity: 'binary_sensor.fp_closed' } : o);
    card.setConfig({ ...card.rawConfig, entry_alert: { door: door.id, ...${JSON.stringify(entry)}, order: [wins[1].id, wins[0].id, wins[2].id] },
      floors: card.rawConfig.floors.map((f, i) => (i ? f : { ...f, openings })) });
    return window.__ids;
  })()`);
const fake = (o) =>
  card(`(() => { const now = new Date().toISOString(); for (const [k, v] of Object.entries(${JSON.stringify(o)})) window.__fake[k] = { state: v, last_changed: now + Math.random() }; card.entryAlert.update(card.hass, card._config); card.requestUpdate('_tick', -1); return true; })()`);
const popup = () => card(`!!card.shadowRoot.querySelector('.entry-alert')`);
const marked = () => card(`plan.shadowRoot.querySelectorAll('.win-beacon').length`);
const redSky = () => card(`!!card.shadowRoot.querySelector('fp-ambient[layer="back"]').shadowRoot.querySelector('.alarm')`);
const tts = async () => (await calls()).filter((c) => c.domain === 'tts');

const entry = { ack_entity: 'input_button.fp_ack', timeout: 8, mode: 'sequential', tts_entity: 'tts.fp_test', media_player: 'media_player.fp_test', tts_language: 'de' };
const ids = await setup(entry);
await page.waitForTimeout(800);
// a real alarm (real front door) must not interfere: switch it off and forget its intercepted calls
await card(`(card.entryAlert.acknowledge(), true)`);
await page.waitForTimeout(5500);
await page.evaluate(() => (window.__fpCalls.length = 0));
await fake({ 'binary_sensor.fp_door': 'off', 'binary_sensor.fp_w0': 'on', 'binary_sensor.fp_w1': 'on', 'binary_sensor.fp_w2': 'off', 'input_button.fp_ack': '2026-01-01' });
await page.waitForTimeout(300);
ok(!(await popup()), 'no warning while the door stays closed');
await fake({ 'binary_sensor.fp_door': 'on' });
const opened = Date.now();
await page.waitForTimeout(500);
ok(await popup(), 'door opens with windows open → red triangle at the top');
ok(!(await card(`!!card.shadowRoot.querySelector('.ea-ok, .ea-sheet')`)), 'no pop-up');
const names = await card(`card.entryAlert.state.windows.map((w) => w.name)`);
ok(names.length === 2 && (await marked()) === 2, `both open windows marked with a pulsing beacon (${names.join(', ')})`);
const blinking = await card(`plan.shadowRoot.querySelectorAll('.alert-line').length + plan.alertPanes()`);
ok(blinking >= 2, `open windows pulse red (${blinking} elements)`);
ok(await redSky(), 'the sky pulses red');
await page.screenshot({ path: `${out}/entry-alert-${scheme}.png` });
{ const early = await tts(); ok(early.length === 0, `no announcement before the timeout${early.length ? ' (got: ' + early.map((c) => c.data.message + ' via ' + c.target?.entity_id).join('; ') + ')' : ''}`); }
await page.waitForTimeout(Math.max(0, 8700 - (Date.now() - opened)));
let t1 = await tts();
ok(t1.length === 1 && t1[0].data.message.includes(names[0]) && !t1[0].data.message.includes(names[1]), `after the timeout: first window in checking order announced („${t1[0]?.data.message}“)`);
ok(t1[0]?.target?.entity_id === 'tts.fp_test' && t1[0]?.data.media_player_entity_id === 'media_player.fp_test', 'tts.speak with the chosen TTS entity and speaker');
ok(t1[0]?.data.language === 'de', `language from the setting (${t1[0]?.data.language})`);
// close the first window in the order (wins[1] = fp_w1) → next one is announced
await fake({ 'binary_sensor.fp_w1': 'off' });
await page.waitForTimeout(400);
t1 = await tts();
ok(t1.length === 2 && t1[1].data.message.includes(names[1]), `closed → next window announced („${t1[1]?.data.message}“)`);
// remote button acknowledges
await fake({ 'input_button.fp_ack': '2026-01-02' });
await page.waitForTimeout(400);
ok(!(await popup()) && !(await redSky()) && (await marked()) === 1, 'remote button: triangle and red sky off, open window still marked');
await page.waitForTimeout(5300);
ok((await marked()) === 0 && (await card(`plan.shadowRoot.querySelectorAll('.alert-line').length`)) === 0, '5 s later the window marking ends too');

// "all" mode, a tap anywhere on the tablet before the timeout switches the alarm off
await setup({ ...entry, mode: 'all' });
await page.waitForTimeout(600);
await fake({ 'binary_sensor.fp_door': 'off', 'binary_sensor.fp_w1': 'on' });
await fake({ 'binary_sensor.fp_door': 'on' });
await page.waitForTimeout(400);
const before = (await calls()).filter((c) => c.domain !== 'system_log').length;
// tap onto a room (would normally run the room action) — this first tap only acknowledges
const pt = await card(`(() => { const r = plan.shadowRoot.querySelector('path.room').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await page.mouse.click(pt[0], pt[1]);
await page.waitForTimeout(500);
ok(!(await popup()) && (await marked()) === 2 && (await card(`!plan.focused`)), 'tap anywhere: alarm off, windows still marked, the tap did nothing else');
ok((await calls()).filter((c) => c.domain !== 'system_log').length === before, 'the acknowledging tap triggered no action');
await page.waitForTimeout(8200);
ok((await tts()).length === 2, 'acknowledged by tap: no announcement');
await page.waitForTimeout(2000);
ok((await marked()) === 0, 'window marking ends 5 s after the tap');
// "all" mode, not acknowledged → one sentence with all windows
await fake({ 'binary_sensor.fp_door': 'off' });
await fake({ 'binary_sensor.fp_door': 'on' });
await page.waitForTimeout(9000);
t1 = await tts();
ok(t1.length === 3 && names.every((n) => t1[2].data.message.includes(n)), `all at once („${t1[2]?.data.message}“)`);
// all windows closed → warning ends by itself
await fake({ 'binary_sensor.fp_w0': 'off', 'binary_sensor.fp_w1': 'off' });
await page.waitForTimeout(300);
ok(!(await popup()), 'all windows closed → warning ends');
// lights flash red 3x and return to their previous state (all light calls intercepted)
await page.evaluate(() => {
  const now = new Date().toISOString();
  Object.assign(window.__fake, {
    'light.fp_a': { state: 'on', last_changed: now, attributes: { supported_color_modes: ['hs', 'color_temp'], color_mode: 'hs', hs_color: [30, 60], brightness: 120 } },
    'light.fp_b': { state: 'off', last_changed: now, attributes: { supported_color_modes: ['xy'] } },
    'light.fp_c': { state: 'on', last_changed: now, attributes: { supported_color_modes: ['color_temp'], color_mode: 'color_temp', color_temp_kelvin: 2700, brightness: 80 } },
  });
  window.__fpCalls.length = 0;
});
await setup({ ...entry, mode: 'none', flash_lights: ['light.fp_a', 'light.fp_b', 'light.fp_c'] });
await page.waitForTimeout(500);
await fake({ 'binary_sensor.fp_door': 'off', 'binary_sensor.fp_w0': 'on' });
await fake({ 'binary_sensor.fp_door': 'on' });
await page.waitForTimeout(9000);
const lc = (await calls()).filter((c) => c.domain === 'light');
const lid = (c) => [].concat(c.target?.entity_id ?? []);
const red = lc.filter((c) => c.service === 'turn_on' && JSON.stringify(c.data.rgb_color) === '[255,0,0]');
ok(red.length === 3 && red.every((c) => c.data.brightness === 255 && lid(c).join() === 'light.fp_a,light.fp_b'), `3× red at 100 % for color lights (${red.length})`);
const white = lc.filter((c) => c.service === 'turn_on' && !c.data.rgb_color && c.data.brightness === 255);
ok(white.length === 3 && white.every((c) => lid(c).join() === 'light.fp_c'), `3× 100 % for the light without color (${white.length})`);
ok(lc.filter((c) => c.service === 'turn_off' && lid(c).length === 3).length === 3, '3× off in between');
const last = lc.slice(-3);
const rA = last.find((c) => lid(c).join() === 'light.fp_a');
const rB = last.find((c) => lid(c).join() === 'light.fp_b');
const rC = last.find((c) => lid(c).join() === 'light.fp_c');
ok(rA?.service === 'turn_on' && JSON.stringify(rA.data.hs_color) === '[30,60]' && rA.data.brightness === 120, `restored: fp_a color + brightness (${JSON.stringify(rA?.data)})`);
ok(rB?.service === 'turn_off', 'restored: fp_b off again');
ok(rC?.service === 'turn_on' && rC.data.color_temp_kelvin === 2700 && rC.data.brightness === 80, `restored: fp_c color temperature + brightness (${JSON.stringify(rC?.data)})`);
// acknowledged while flashing → restore right away
await card(`(card.entryAlert.acknowledge(), true)`);
await page.waitForTimeout(5500);
await page.evaluate(() => (window.__fpCalls.length = 0));
await fake({ 'binary_sensor.fp_door': 'off' });
await fake({ 'binary_sensor.fp_door': 'on' });
await page.waitForTimeout(300);
await card(`(card.entryAlert.acknowledge(), true)`);
await page.waitForTimeout(2600);
const lc2 = (await calls()).filter((c) => c.domain === 'light');
const red2 = lc2.filter((c) => c.service === 'turn_on' && JSON.stringify(c.data.rgb_color) === '[255,0,0]');
const rA2 = lc2.slice(-3).find((c) => lid(c).join() === 'light.fp_a');
ok(red2.length === 1 && rA2?.service === 'turn_on' && JSON.stringify(rA2.data.hs_color) === '[30,60]', `switched off while flashing: stops after ${red2.length} flash and restores`);
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
