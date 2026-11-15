// "Live an der Lampe" (src/lightlive.ts, src/editor/light-action.ts).
// Part 1 (node only): what a lamp gets for a setting (per capability, like lightspec.py), what puts it back, the
// throttle (first call at once, then at most one per lamp every 150 ms, last value wins), restore of exactly the
// touched lamps, "so lassen", a refused call; with the integration's preview command: start, batched apply, keep-alive,
// stop, fallback for older integrations (unknown_command), refused / ended by the integration.
// Part 2 (preview with example data, browser): the switch in <hr-light-action> sends while a slider moves, throttled;
// closing the editor puts the lamps back; each lamp its own drives only the opened lamp; "so lassen"; a guest gets
// no switch; Home Assistant refusing a lamp ("unauthorized") ends live mode with a note; the reported values show.
// Usage (after node tools/build.mjs): sh ../tools/heavy.sh browser node tools/test-lightlive.mjs [shotdir]
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ part 1: node
const r = await esbuild.build({ entryPoints: ['src/lightlive.ts'], bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent' });
const L = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
const S = await (async () => {
  const b = await esbuild.build({ entryPoints: ['src/lightspec.ts'], bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
})();

console.log('conversions (same as lightspec.py / Home Assistant)');
ok(eq(S.rgbToXy(255, 0, 0), [0.701, 0.299]) && eq(S.rgbToXy(0, 0, 255), [0.136, 0.04]) && eq(S.rgbToXy(255, 255, 255), [0.323, 0.329]), 'rgb → xy wie Home Assistant', [S.rgbToXy(255, 0, 0), S.rgbToXy(0, 0, 255)]);
ok(eq(S.xyToRgb(0.35, 0.35), [255, 243, 222]) && eq(S.xyToRgb(0, 0), [0, 63, 255]), 'xy → rgb wie Home Assistant', S.xyToRgb(0.35, 0.35));

const lamp = (modes, extra = {}) => ({ state: 'on', attributes: { supported_color_modes: modes, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, supported_features: 4 | 8 | 32, effect_list: ['candle', 'off'], ...extra } });
const RGB = lamp(['rgb']), HS = lamp(['hs', 'color_temp']), XY = lamp(['xy']), RGBW = lamp(['rgbw']), CT = lamp(['color_temp']), DIM = lamp(['brightness']), ONOFF = lamp(['onoff']), WHITE = lamp(['hs', 'white']);
console.log('what a lamp gets');
ok(eq(L.previewCall(RGB, { mode: 'on', brightness: 40, color: '#ff8a3d' }), { service: 'turn_on', data: { brightness_pct: 40, rgb_color: [255, 138, 61] } }), 'RGB: Prozent + rgb_color');
ok(eq(L.previewCall(XY, { mode: 'on', bri: 77, color: '#ff8a3d' }).data, { brightness: 77, rgb_color: [255, 138, 61] }), 'XY-Lampe: genau 77/255, RGB als rgb_color (Home Assistant rechnet um)');
ok(eq(L.previewCall(XY, { mode: 'on', brightness: 50, color: 'xy:0.55,0.4' }).data, { brightness_pct: 50, xy_color: [0.55, 0.4] }), 'XY-Lampe: xy wie eingestellt');
ok(eq(L.previewCall(HS, { mode: 'on', brightness: 50, color: 'warm' }).data, { brightness_pct: 50, color_temp_kelvin: 2700 }), 'Weißton als Kelvin');
ok(eq(L.previewCall(HS, { mode: 'on', brightness: 50, color: 'k:9000' }).data.color_temp_kelvin, 6500), 'Kelvin auf den Bereich der Lampe begrenzt');
ok(eq(L.previewCall(RGB, { mode: 'on', brightness: 50, color: 'warm' }).data.rgb_color?.length, 3), 'Nur-Farb-Lampe: Weißton als Farbe');
ok(eq(L.previewCall(RGBW, { mode: 'on', brightness: 50, color: 'rgbw:255,0,0,40' }).data.rgbw_color, [255, 0, 0, 40]), 'RGBW wie eingestellt');
ok(eq(L.previewCall(RGB, { mode: 'on', brightness: 50, color: 'rgbw:255,0,0,40' }).data.rgb_color?.length, 3), 'RGBW an RGB-Lampe: als RGB');
const ct = L.previewCall(CT, { mode: 'on', brightness: 50, color: '#ff3000' }).data;
ok(ct.color_temp_kelvin && ct.color_temp_kelvin < 3000 && !ct.rgb_color, 'Nur-Weiß-Lampe: rot → warmer Weißton', ct);
ok(eq(L.previewCall(DIM, { mode: 'on', brightness: 30, color: '#ff0000' }).data, { brightness_pct: 30 }), 'nur dimmbar: nur Helligkeit');
ok(eq(L.previewCall(ONOFF, { mode: 'on', brightness: 30, color: '#ff0000' }).data, {}), 'nur an/aus: einfach an');
ok(eq(L.previewCall(WHITE, { mode: 'on', bri: 90, color: 'white' }).data, { white: 90 }), 'Weißkanal: Helligkeit in white');
ok(eq(L.previewCall(HS, { mode: 'on', brightness: 50, color: 'none', effect: 'rainbow', transition: 3, flash: 'short' }).data, { brightness_pct: 50 }), 'Farbe lassen; Effekt nur aus der Liste der Lampe, kein Übergang/Blitz');
ok(eq(L.previewCall(lamp(['hs'], { effect_list: ['candle'] }), { mode: 'on', brightness: 50, color: 'none', effect: 'candle' }).data.effect, 'candle'), 'Effekt der Lampe');
ok(eq(L.previewCall(RGB, { mode: 'off' }), { service: 'turn_off', data: {} }), 'aus');

console.log('restore');
ok(eq(L.restoreCall({ state: 'off', attributes: {} }), { service: 'turn_off', data: {} }), 'war aus → aus');
ok(eq(L.restoreCall({ state: 'on', attributes: { color_mode: 'hs', brightness: 120, hs_color: [30, 80], effect: 'off', effect_list: ['candle', 'off'] } }).data, { brightness: 120, hs_color: [30, 80], effect: 'off' }), 'hs + Helligkeit + Effekt aus');
ok(eq(L.restoreCall({ state: 'on', attributes: { color_mode: 'color_temp', brightness: 200, color_temp_kelvin: 3000 } }).data, { brightness: 200, color_temp_kelvin: 3000 }), 'Weißton');
ok(eq(L.restoreCall({ state: 'on', attributes: { color_mode: 'white', brightness: 99 } }).data, { white: 99 }), 'Weißkanal');
ok(L.restoreCall({ state: 'unavailable', attributes: {} }) === null && L.restoreCall(null) === null, 'nicht erreichbar → nichts');
ok(eq(L.settingOf({ state: 'on', attributes: { color_mode: 'xy', brightness: 128, xy_color: [0.55, 0.4] } }), { mode: 'on', bri: 128, brightness: 50, color: 'xy:0.55,0.4' }), 'Zustand der Lampe als Einstellung (übernehmen)');
ok(eq(L.reported({ state: 'on', attributes: { color_mode: 'hs', brightness: 128, hs_color: [30, 80], rgb_color: [255, 140, 51], xy_color: [0.55, 0.4] } }).values.map((v) => v[0]), ['bri', 'color_mode', 'hs', 'xy', 'rgb']), 'gemeldete Werte: bri, Modus, hs, xy, rgb');

console.log('throttle, restore, refusal');
function fakeIO(states, refuse = new Set()) {
  const calls = [];
  return {
    calls,
    io: {
      state: (e) => states[e],
      call: async (service, e, data) => {
        calls.push({ at: Date.now(), service, e, data });
        await wait(5);
        if (refuse.has(e)) throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' });
      },
    },
  };
}
{
  const states = { 'light.a': lamp(['hs', 'color_temp'], { color_mode: 'color_temp', brightness: 200, color_temp_kelvin: 3000 }), 'light.b': { state: 'off', attributes: { supported_color_modes: ['brightness'] } }, 'lock.door': { state: 'locked', attributes: {} } };
  const { calls, io } = fakeIO(states);
  const live = new L.LightLive(io, () => {});
  live.show(['light.a'], { mode: 'on', brightness: 10 });
  ok(calls.length === 0, 'aus: nichts wird gesendet');
  live.start(['light.a', 'light.b']);
  const t0 = Date.now();
  for (let i = 1; i <= 20; i++) {
    live.show(['light.a', 'lock.door'], { mode: 'on', brightness: i * 5, color: 'warm' });
    await wait(10);
  }
  await wait(200);
  const a = calls.filter((c) => c.e === 'light.a');
  ok(a.length >= 2 && a.length <= 4, `20 Änderungen in 200 ms → ${a.length} Aufrufe (gedrosselt)`);
  ok(a[0].at - t0 < 20 && a[0].data.brightness_pct === 5, 'der erste sofort');
  ok(a.at(-1).data.brightness_pct === 100, 'der letzte Wert gewinnt', a.at(-1).data);
  ok(a.slice(1).every((c, i) => c.at - a[i].at >= 140), 'höchstens alle ~150 ms', a.map((c) => c.at - t0));
  ok(!calls.some((c) => c.e === 'lock.door'), 'nie etwas anderes als Lampen (kein Schloss)');
  const n = calls.length;
  live.show(['light.a'], { mode: 'on', brightness: 100, color: 'warm' });
  await wait(200);
  ok(calls.length === n, 'gleicher Wert wird nicht noch einmal gesendet');
  await live.stop(true);
  const back = calls.slice(n);
  ok(back.length === 1 && back[0].e === 'light.a' && eq(back[0].data, { brightness: 200, color_temp_kelvin: 3000 }), 'Ende: nur die berührte Lampe zurück, wie sie war', back);
  live.show(['light.a'], { mode: 'on', brightness: 33 });
  await wait(200);
  ok(calls.length === n + 1, 'nach dem Ende wird nichts mehr gesendet');
}
{
  const states = { 'light.a': { state: 'off', attributes: { supported_color_modes: ['brightness'] } } };
  const { calls, io } = fakeIO(states);
  const live = new L.LightLive(io, () => {});
  live.start(['light.a']);
  live.show(['light.a'], { mode: 'on', brightness: 70 });
  live.show(['light.a'], { mode: 'on', brightness: 80 });
  await live.stop(false);
  await wait(200);
  ok(calls.length === 1 && calls[0].data.brightness_pct === 70, '„So lassen“: nichts zurückgestellt, ausstehende Werte verworfen', calls);
}
{
  const states = { 'light.a': lamp(['hs'], { color_mode: 'hs', hs_color: [10, 10], brightness: 10 }) };
  const { io } = fakeIO(states, new Set(['light.a']));
  const errs = [];
  const live = new L.LightLive(io, (err, e) => errs.push([err.code, e]));
  live.start(['light.a']);
  live.show(['light.a'], { mode: 'on', brightness: 70 });
  await wait(50);
  ok(eq(errs, [['unauthorized', 'light.a']]), 'abgelehnter Aufruf wird gemeldet (unauthorized)', errs);
  await live.stop(true);
  ok(errs.length === 1, 'Fehler beim Zurückstellen werden nicht noch einmal gemeldet');
}

console.log('with the integration (house_rules/light/preview)');
function fakeServer({ startError, keepError } = {}) {
  const msgs = [];
  const calls = [];
  return {
    msgs,
    calls,
    io: {
      state: () => lamp(['hs']),
      call: async (s, e, d) => calls.push({ s, e, d }),
      preview: async (m) => {
        msgs.push({ at: Date.now(), ...m });
        await wait(5);
        if (m.action === 'start') {
          if (startError) throw startError;
          return { session: 's1', idle: 180 };
        }
        if (m.action === 'keep' && keepError) throw keepError;
        return m.action === 'apply' ? { failed: m.settings['light.bad'] ? ['light.bad'] : [] } : { ok: true };
      },
    },
  };
}
{
  const { msgs, calls, io } = fakeServer();
  const errs = [];
  const live = new L.LightLive(io, (err, e) => errs.push([err.code, e]), 150, 100);
  live.start(['light.a', 'light.b', 'lock.door']);
  live.show(['light.a', 'light.b'], { mode: 'on', brightness: 10 });
  await wait(20);
  ok(msgs[0].action === 'start' && eq(msgs[0].lights, ['light.a', 'light.b']) && live.onServer, 'Start beim Server, nur Lampen', msgs[0]);
  ok(msgs[1]?.action === 'apply' && msgs[1].session === 's1' && eq(Object.keys(msgs[1].settings), ['light.a', 'light.b']) && msgs[1].settings['light.a'].brightness === 10, 'was vor der Antwort kam, geht danach als eine Nachricht für alle Lampen', msgs[1]);
  for (let i = 1; i <= 20; i++) {
    live.show(['light.a'], { mode: 'on', brightness: 10 + i });
    await wait(10);
  }
  await wait(250);
  const applies = msgs.filter((m) => m.action === 'apply');
  ok(applies.length >= 2 && applies.length <= 5 && applies.at(-1).settings['light.a'].brightness === 30, `20 Änderungen → ${applies.length} apply, der letzte Wert gewinnt`);
  ok(msgs.some((m) => m.action === 'keep'), 'hält die Sitzung am Leben (keep)');
  ok(calls.length === 0, 'keine direkten Aufrufe');
  live.show(['light.bad'], { mode: 'on', brightness: 50 });
  await wait(30);
  ok(eq(errs, [['failed', 'light.bad']]), 'Lampe, die der Server nicht schalten konnte: gemeldet', errs);
  const n = msgs.length;
  await live.stop(false);
  const stop = msgs.slice(n).find((m) => m.action === 'stop');
  ok(stop && stop.session === 's1' && stop.restore === false, '„So lassen“: stop ohne Zurückstellen', msgs.slice(n));
  const m = msgs.length;
  await wait(250);
  ok(!msgs.slice(m).some((x) => x.action === 'keep'), 'danach kein keep mehr');
}
{
  const { msgs, calls, io } = fakeServer({ startError: { code: 'unknown_command', message: 'Unknown command.' } });
  const live = new L.LightLive(io, () => {});
  live.start(['light.a']);
  live.show(['light.a'], { mode: 'on', brightness: 42 });
  await wait(30);
  ok(!live.onServer && calls.length === 1 && calls[0].d.brightness_pct === 42, 'ältere Integration (unknown_command): die Oberfläche sendet selbst', calls);
  await live.stop(true);
  ok(calls.length === 2 && msgs.length === 1, 'und stellt selbst zurück');
}
{
  const { calls, io } = fakeServer({ startError: { code: 'unauthorized', message: 'Du darfst Lampe A nicht steuern.' } });
  const errs = [];
  const live = new L.LightLive(io, (err, e) => errs.push([err.code, e, err.message]));
  live.start(['light.a']);
  live.show(['light.a'], { mode: 'on', brightness: 42 });
  await wait(30);
  ok(eq(errs, [['unauthorized', '', 'Du darfst Lampe A nicht steuern.']]) && calls.length === 0 && !live.active, 'Server lehnt ab: gemeldet, nichts gesendet, Live aus', errs);
}
{
  const { io } = fakeServer({ keepError: { code: 'not_found', message: 'Die Live-Vorschau ist schon beendet.' } });
  const errs = [];
  const live = new L.LightLive(io, (err, e) => errs.push([err.code, e]), 150, 50);
  live.start(['light.a']);
  await wait(120);
  ok(eq(errs, [['not_found', '']]) && !live.active, 'vom Server beendet (keep → not_found): gemeldet, Live aus', errs);
}

// ------------------------------------------------------------------ part 2: the editor in the preview
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
const browser = await chromium.launch();
const p = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto('file://' + process.cwd() + '/dist/preview-local.html');
await p.waitForSelector('house-rules-panel');
await p.waitForTimeout(300);
const E = (body) => p.evaluate(new Function(`return (async () => { const panel = document.querySelector('house-rules-panel'); const store = panel.store; const el = panel.shadowRoot.querySelector('hr-light-action'); const R = el?.shadowRoot; ${body} })()`));
// an editor for two example lamps, every light.turn_on/turn_off recorded (and refused for lamps in window.refuse)
const mount = (value, role = 'admin') =>
  E(`
  panel.shadowRoot.querySelector('hr-light-action')?.remove();
  window.calls = []; window.refuse = new Set();
  store.me = { user_id: 'u', name: 'Test', role: ${JSON.stringify(role)}, label: '', ha_admin: ${JSON.stringify(role === 'admin')}, can: {} };
  if (!store._orig) store._orig = store.lightCall.bind(store);
  store.lightCall = async (s, e, d) => { window.calls.push({ at: Date.now(), s, e, d }); if (window.refuse.has(e)) throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' }); return store._orig(s, e, d); };
  const x = document.createElement('hr-light-action');
  x.store = store; x.lights = ['light.sofalicht', 'light.stehlampe']; x.value = ${JSON.stringify(value)};
  x.addEventListener('change', (ev) => (x.value = ev.detail));
  x.style.cssText = 'display:flex;max-width:560px;margin:16px;padding:16px;background:var(--hr-surface-raised, #fff);border-radius:16px'; panel.shadowRoot.append(x);
  await x.updateComplete;`);
const sw = () => E(`R.querySelector('.live button.switch').click(); await el.updateComplete;`);

await mount({ mode: 'on', brightness: 40, color: 'warm' });
ok(await E(`return !!R.querySelector('.live button.switch') && R.querySelector('.live button.switch').getAttribute('aria-checked') === 'false';`), 'Schalter „Live an der Lampe“ da, aus');
const before = await E(`return [store.lightState('light.sofalicht'), store.lightState('light.stehlampe')];`);
await sw();
await p.waitForTimeout(50);
let c = await E(`return window.calls;`);
ok(c.length === 2 && c.every((x) => x.s === 'turn_on' && x.d.brightness_pct === 40 && x.d.color_temp_kelvin === 2700), 'einschalten: beide Lampen zeigen die Einstellung sofort', c);
ok(await E(`return !!R.querySelector('.live.on .pill.live');`), 'Live-Anzeige sichtbar');
// a slider moves: input events every 10 ms → throttled, the last one wins, nothing saved yet
await E(`window.calls = []; const r = R.querySelector('input[type=range]'); for (let v = 41; v <= 70; v++) { r.value = String(v); r.dispatchEvent(new Event('input')); await new Promise((q) => setTimeout(q, 10)); } await new Promise((q) => setTimeout(q, 250));`);
c = await E(`return window.calls.filter((x) => x.e === 'light.sofalicht');`);
ok(c.length >= 2 && c.length <= 5 && c.at(-1).d.brightness_pct === 70, `Schieben: 30 Werte → ${c.length} Aufrufe pro Lampe, der letzte (70 %) gewinnt`, c.map((x) => x.d.brightness_pct));
ok(await E(`return el.value.brightness === 40;`), 'beim Schieben noch nichts in die Regel übernommen');
await E(`const r = R.querySelector('input[type=range]'); r.value = '70'; r.dispatchEvent(new Event('change')); await el.updateComplete;`);
ok(await E(`return el.value.brightness === 70;`), 'Loslassen: Wert in der Einstellung');
ok(await E(`return store.lightState('light.sofalicht').attributes.brightness === Math.round(70 * 2.55);`), 'die Lampe meldet den Wert');
ok(await E(`const t = R.querySelector('details.now-box'); return !!t?.open && /bri 179\\/255/.test(t.textContent) && /color_mode color_temp/.test(t.textContent);`), 'gemeldete Werte stehen dabei (bri 0–255, Farbmodus)');
if (process.argv[2]) await p.locator('hr-light-action').screenshot({ path: `${process.argv[2]}/light-live.png` });
// colour picker while dragging
await E(`R.querySelectorAll('.seg')[0]; const tabs = [...R.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === 'Farbe'); tabs.click(); await el.updateComplete; await new Promise((q) => setTimeout(q, 200)); window.calls = []; const pk = R.querySelector('input.picker'); pk.value = '#00ff00'; pk.dispatchEvent(new Event('input')); await new Promise((q) => setTimeout(q, 200));`);
c = await E(`return window.calls;`);
ok(c.some((x) => eq(x.d.rgb_color, [0, 255, 0])), 'Farbwähler: schon beim Ziehen als rgb_color', c.map((x) => x.d));
// the editor closes (removed): both lamps back as they were
await E(`window.calls = []; el.remove(); await new Promise((q) => setTimeout(q, 100));`);
c = await E(`return window.calls;`);
const after = await E(`return [store.lightState('light.sofalicht'), store.lightState('light.stehlampe')];`);
ok(c.length === 2 && after[0].state === before[0].state && after[0].attributes.brightness === before[0].attributes.brightness && after[0].attributes.color_temp_kelvin === before[0].attributes.color_temp_kelvin && after[1].state === 'off', 'Schließen: beide Lampen wie vorher (an 60 % warm / aus)', { c, after, before });

// each lamp its own: only the opened lamp is driven
await mount({ mode: 'on', brightness: 40, color: 'warm', per_light: { 'light.stehlampe': { mode: 'on', brightness: 20, color: '#ff0000' } } });
await sw();
await p.waitForTimeout(50);
ok((await E(`return window.calls.length;`)) === 0 && (await E(`return /aufgeklappten|Klapp eine Lampe auf/.test(R.querySelector('.live').textContent);`)), 'jede Lampe einzeln, keine aufgeklappt: nichts gesendet, Hinweis');
await E(`[...R.querySelectorAll('.lamp > button.head')][1].click(); await el.updateComplete; await new Promise((q) => setTimeout(q, 80));`);
c = await E(`return window.calls;`);
ok(c.length === 1 && c[0].e === 'light.stehlampe' && c[0].d.brightness_pct === 20 && eq(c[0].d.hs_color ?? c[0].d.rgb_color, [255, 0, 0]), 'aufgeklappte Lampe zeigt ihre eigene Einstellung, die andere nicht', c);
await E(`window.calls = []; const r = [...R.querySelectorAll('.lamp input[type=range]')][0]; r.value = '55'; r.dispatchEvent(new Event('input')); await new Promise((q) => setTimeout(q, 250));`);
c = await E(`return window.calls;`);
ok(c.length === 1 && c[0].e === 'light.stehlampe' && c[0].d.brightness_pct === 55, 'Schieben bei der Lampe: nur diese Lampe', c);
// "so lassen" + switching off: nothing put back
await E(`window.calls = []; const k = R.querySelector('label.keep input'); k.checked = true; k.dispatchEvent(new Event('change')); await el.updateComplete;`);
await sw();
await p.waitForTimeout(80);
ok((await E(`return window.calls.length;`)) === 0 && (await E(`return store.lightState('light.stehlampe').state === 'on';`)), '„So lassen“ + aus: Lampe bleibt so');
await E(`await store.lightCall('turn_off', 'light.stehlampe', {});`);

// switched off without "so lassen": put back
await mount({ mode: 'on', brightness: 15, color: 'kalt' });
await sw();
await p.waitForTimeout(50);
await E(`window.calls = [];`);
await sw();
await p.waitForTimeout(80);
c = await E(`return window.calls;`);
ok(c.length === 2 && c.some((x) => x.e === 'light.stehlampe' && x.s === 'turn_off') && c.some((x) => x.e === 'light.sofalicht' && x.s === 'turn_on'), 'Live aus: zurückgestellt', c);

// pagehide (leaving the page): put back
await sw();
await p.waitForTimeout(50);
await E(`window.calls = []; window.dispatchEvent(new Event('pagehide')); await new Promise((q) => setTimeout(q, 80));`);
c = await E(`return window.calls;`);
ok(c.length === 2 && (await E(`return R.querySelector('.live button.switch').getAttribute('aria-checked') === 'false';`)), 'Seite verlassen (pagehide): zurückgestellt, Live aus', c);

// Home Assistant refuses a lamp: note, live off, the others back
await mount({ mode: 'on', brightness: 35, color: 'warm' });
await E(`window.refuse.add('light.stehlampe');`);
await sw();
await p.waitForTimeout(150);
ok(await E(`return R.querySelector('.live button.switch').getAttribute('aria-checked') === 'false' && /lässt dich Stehlampe nicht steuern/.test(R.querySelector('.live').textContent);`), 'abgelehnt (unauthorized): Hinweis, Live wieder aus');
ok((await E(`return store.lightState('light.sofalicht').attributes.brightness;`)) === before[0].attributes.brightness, 'die andere Lampe ist zurückgestellt');

// a guest: no live mode
await mount({ mode: 'on', brightness: 35, color: 'warm' }, 'guest');
ok(await E(`return R.querySelector('.live button.switch').disabled && /Als Gast/.test(R.querySelector('.live').textContent);`), 'Gast: Schalter gesperrt, Hinweis');
await E(`R.querySelector('.live button.switch').click(); el._startLive(); await el.updateComplete;`);
ok((await E(`return window.calls.length;`)) === 0, 'Gast: nichts gesendet, auch nicht über den Code-Weg');
ok(await E(`return !R.querySelector('.now-box button');`), 'Gast: kein „übernehmen“');

// no lamps (e.g. only switches): no live switch at all
await E(`el.lights = ['switch.kaffeemaschine', 'lock.haustuer']; await el.updateComplete;`);
ok(await E(`return !R.querySelector('.live');`), 'ohne Lampen (Schalter, Schloss): kein Live-Schalter');

ok(errors.length === 0, 'keine Fehler im Browser', errors);
await browser.close();
console.log(fails ? `\n${fails} Fehler` : '\nalles ok');
process.exit(fails ? 1 : 0);
