// The card with Hausregeln, on the isolated Hausregeln test HA (127.0.0.1:8124, never the real home).
// Sets up an own dashboard + rules named "Grundriss-Test …" and removes the rules again. The card comes from
// this checkout's dist/ (the page's request is answered by the test browser).
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
const U = 'http://127.0.0.1:8124';
const out = process.argv[2] ?? '/tmp';
const token = readFileSync(new URL('../../hausregeln/.cache/test-token', import.meta.url), 'utf8').trim();
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket');
let id = 1;
const pend = new Map();
await new Promise((res) => {
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    else if (d.type === 'auth_ok') res();
    else if (d.type === 'result') pend.get(d.id)?.(d);
  };
});
const call = (msg) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });
const r = async (msg) => { const x = await call(msg); if (!x.success) throw new Error(msg.type + ': ' + JSON.stringify(x.error)); return x.result; };

// --- setup: card resource (answered from dist/), own dashboard, rules
const res = await r({ type: 'lovelace/resources' });
if (!res.some((x) => x.url.startsWith('/floorplan_card_files/'))) await r({ type: 'lovelace/resources/create', res_type: 'module', url: '/floorplan_card_files/floorplan-card.js' });
const dashes = await r({ type: 'lovelace/dashboards/list' });
if (!dashes.some((d) => d.url_path === 'fp-hr')) await r({ type: 'lovelace/dashboards/create', url_path: 'fp-hr', title: 'Grundriss-Test', icon: 'mdi:floor-plan', show_in_sidebar: false, require_admin: false, mode: 'storage' });
const card = {
  type: 'custom:floorplan-card', card_id: 'fp_hr_test', view_mode: '3d', height: '760px',
  floors: [{ id: 'f1', name: 'Wohnung', devices: [],
    rooms: [
      { id: 'r_wz', name: 'Wohnzimmer', area: 'wohnzimmer', points: [[0, 0], [420, 0], [420, 380], [0, 380]] },
      { id: 'r_fl', name: 'Flur', area: 'flur', points: [[420, 0], [580, 0], [580, 380], [420, 380]] },
      { id: 'r_ku', name: 'Küche', area: 'kuche', points: [[580, 0], [940, 0], [940, 380], [580, 380]] },
      { id: 'r_bd', name: 'Bad', area: 'bad', points: [[420, 380], [940, 380], [940, 600], [420, 600]] },
    ],
    openings: [
      { id: 'o_door', type: 'door', a: [460, 0], b: [540, 0], entity: 'binary_sensor.haustuer', name: 'Haustür' },
      { id: 'o_win', type: 'window', a: [700, 0], b: [820, 0], entity: 'binary_sensor.fenster_kueche' },
    ],
    furniture: [
      { id: 'p_fl', kind: 'ceiling_lamp', x: 500, y: 190, w: 40, h: 40, entity: 'light.flurlicht' },
      { id: 'p_ku', kind: 'ceiling_lamp', x: 760, y: 190, w: 50, h: 50, entity: 'light.kuechenlicht' },
      { id: 'p_sofa', kind: 'floor_lamp', x: 60, y: 60, w: 40, h: 40, entity: 'light.sofalicht' },
      { id: 'p_hz', kind: 'radiator', x: 760, y: 360, w: 100, h: 10, entity: 'climate.heizung_kueche' },
      { id: 'p_hp', kind: 'speaker', x: 380, y: 340, w: 20, h: 20, entity: 'media_player.homepod' },
    ] }],
};
await r({ type: 'lovelace/config/save', url_path: 'fp-hr', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [card] }] } });
const snap0 = await r({ type: 'house_rules/snapshot' });
const mode0 = snap0.mode;
for (const old of snap0.rules.filter((x) => x.name.startsWith('Grundriss-Test'))) await r({ type: 'house_rules/rule/delete', rule_id: old.id });
const r1 = (await r({ type: 'house_rules/rule/save', rule: { id: '', name: 'Grundriss-Test Haustür', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], and: [{ subject: 'room:flur', verb: 'is_empty' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }, { subject: 'light.kuechenlicht', verb: 'turn_on' }], only: [], enabled: true, options: {} } })).rule;
const r2 = (await r({ type: 'house_rules/rule/save', rule: { id: '', name: 'Grundriss-Test Fenster', type: 'when', when: [{ subject: 'binary_sensor.fenster_kueche', verb: 'opens' }], and: [], then: [{ subject: 'climate.heizung_kueche', verb: 'eco' }], only: [], enabled: true, options: {} } })).rule;
console.log('rules', r1.id, r2.id);

// --- browser
const browser = await chromium.launch({ args: (process.env.PW_ARGS ?? '').split(' ').filter(Boolean) });
// German like the texts the test expects (HA takes the browser's language when the user has not chosen one)
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block', locale: 'de-DE' });
await ctx.route(/\/floorplan_card_files\/([^?]*)/, (route) => {
  const f = 'dist/' + route.request().url().match(/\/floorplan_card_files\/([^?]*)/)[1];
  if (!existsSync(f)) return route.continue();
  route.fulfill({ body: readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
});
await ctx.addInitScript(([u, t]) => {
  localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
  localStorage.setItem('dockedSidebar', JSON.stringify('always_hidden'));
  window.__fpNoCompanion = true;
}, [U, token]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|Service Worker|addEventListener/.test(m.text()) && errors.push(m.text()));
await page.goto(U + '/fp-hr/plan', { waitUntil: 'networkidle' });
await page.waitForSelector('floorplan-card', { state: 'attached', timeout: 60000 });
await page.waitForTimeout(4000);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const C = (e) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${e}; })()`);
const fake = (entity_id, state) => r({ type: 'hr_fake/set', entity_id, state });
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; };

ok(await C(`!!card._hr`), 'card found Hausregeln (live state)');
// 6. house mode
ok(await C(`card.shadowRoot.querySelector('.hr-mode .hr-chip')?.textContent.trim()`) === ({ home: 'Zuhause', away: 'Weg', sleep: 'Schlafen', vacation: 'Urlaub', guests: 'Gäste' })[mode0], `mode chip shows the house mode (${mode0})`);
await page.screenshot({ path: `${out}/hr-plan.png` });
await C(`(card.shadowRoot.querySelector('.hr-mode .hr-chip').click(), true)`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/hr-mode-menu.png` });
const target = mode0 === 'home' ? 'guests' : 'home';
await C(`([...card.shadowRoot.querySelectorAll('.hr-item')].find((b) => b.textContent.includes(${JSON.stringify(target === 'home' ? 'Zuhause' : 'Gäste')})).click(), true)`);
ok(await until(async () => (await r({ type: 'house_rules/snapshot' })).mode === target), `menu sets the house mode (→ ${target})`);
ok(await until(() => C(`card._hr.mode === ${JSON.stringify(target)}`)), 'chip follows');
await r({ type: 'house_rules/mode/set', mode: mode0 });
// 4. occupancy
await fake('binary_sensor.praesenz_flur', 'on');
await page.waitForTimeout(1500);
ok(await C(`!plan.shadowRoot.querySelector('svg.plan g.occ path')`), 'occupied rooms not tinted by default');
await C(`(card.setConfig({ ...card._config, house_rules: { ...(card._config.house_rules ?? {}), occupancy: true } }), true)`);
ok(await until(() => C(`!!plan.hrOccupied?.has('r_fl') && !!plan.shadowRoot.querySelector('svg.plan g.occ path')`)), 'switched on: Flur occupied → tinted');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/hr-occupied.png` });
await fake('binary_sensor.praesenz_flur', 'off');
// 3. no rings when a rule runs (the devices' own state is the feedback)
await C(`(window.__pulses = 0, plan.pulseEntities = ((orig) => function (ids, c, l) { window.__pulses += ids.length; return orig.call(this, ids, c, l); })(plan.pulseEntities), true)`);
await r({ type: 'house_rules/rule/run', rule_id: r1.id });
await page.waitForTimeout(2500);
ok((await C(`window.__pulses`)) === 0, 'a rule run shows no rings on the plan (only an alarm marks its cause)');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/hr-pulse.png` });
// 5. alarm (state injected into the card: the alarm itself is tested by Hausregeln)
await C(`(card._hr = { ...card._hr, alarm: { state: 'pending', label: 'Voralarm', until: Date.now() / 1000 + 25, cause: 'binary_sensor.haustuer', cause_name: 'Haustür' } }, card.requestUpdate(), true)`);
await page.waitForTimeout(800);
ok(/Voralarm · 0:2/.test(await C(`card.shadowRoot.querySelector('.hr-chip.shield')?.textContent.replace(/\\s+/g, ' ')`) ?? ''), 'pre-alarm: shield with countdown');
ok(await C(`plan.hrAlarmCause === 'binary_sensor.haustuer'`), 'pre-alarm: the cause pulses red on the plan');
await page.screenshot({ path: `${out}/hr-alarm.png` });
await C(`(card._hr = { ...card._hr, alarm: { state: 'armed_away', label: 'Scharf · Abwesend' } }, card.requestUpdate(), true)`);
await page.waitForTimeout(400);
ok(/Scharf/.test(await C(`card.shadowRoot.querySelector('.hr-chip.shield.armed')?.textContent`) ?? '') && !(await C(`plan.hrAlarmCause`)), 'armed: quiet shield, no red');
await C(`(card._hr = { ...card._hr, alarm: { state: 'disarmed' } }, card.requestUpdate(), true)`);
// 1. popup → rules
await C(`(card.ensureLayer().openPopup({ entity: 'light.flurlicht' }), true)`);
await page.waitForTimeout(800);
const L = (e) => page.evaluate(`(() => { const l = document.querySelector('floorplan-card-layer'); return ${e}; })()`);
ok(await L(`!!l.shadowRoot.querySelector('fp-light-popup')?.shadowRoot.querySelector('.icon-btn.rules')`), 'device popup has "Regeln"');
await L(`(l.shadowRoot.querySelector('fp-light-popup').shadowRoot.querySelector('.icon-btn.rules').click(), true)`);
ok(await until(() => L(`!!l.shadowRoot.querySelector('house-rules-device') && !!customElements.get('house-rules-device')`)), 'opens <house-rules-device> (loaded from the integration)');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/hr-device.png` });
await L(`(l.closeHouseRules(), l.closePopup(), true)`);
await page.waitForTimeout(400);
// 1./2. editor: counters, inspector row, rules panel, marks
await C(`(card.openEditor(), true)`);
await page.waitForTimeout(2500);
const E = (e) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); const plan = ed.shadowRoot.querySelector('fp-plan'); return ${e}; })()`);
ok(await until(() => E(`plan.shadowRoot.querySelectorAll('.hrcount').length >= 3`)), `counters at the devices (${await E(`plan.shadowRoot.querySelectorAll('.hrcount').length`)})`);
await E(`(ed.select({ kind: 'furniture', id: 'p_fl' }), true)`);
await page.waitForTimeout(600);
ok(/schaltet 1/.test(await E(`ed.shadowRoot.querySelector('[data-hr-rules]')?.textContent.replace(/\\s+/g, ' ')`) ?? ''), 'inspector: "Regeln … schaltet 1" at the hall light');
await page.screenshot({ path: `${out}/hr-editor-inspector.png` });
// the sheet must be on top of the editor, not just in the page
const topAt = (x, y) => page.evaluate(([x, y]) => { let el = document.elementFromPoint(x, y); const path = []; while (el) { path.push(el.tagName.toLowerCase()); if (el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (inner && inner !== el) { el = inner; continue; } } break; } return path.join(' > '); }, [x, y]);
await page.locator('floorplan-card-layer floorplan-card-editor-ui [data-hr-rules]').click();
await page.waitForTimeout(2000);
ok((await topAt(640, 300)).includes('house-rules-device'), 'inspector → Regeln: the sheet is visible above the editor');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await E(`(ed.shadowRoot.querySelector('.tool[data-panel="rules"]').click(), true)`);
await page.waitForTimeout(500);
ok(await E(`ed.shadowRoot.querySelectorAll('.hr-rule').length`) >= 2, 'rules panel lists the rules');
await page.locator('floorplan-card-layer floorplan-card-editor-ui button:has-text("Neue Regel")').first().click();
await page.waitForTimeout(1500);
ok((await topAt(640, 300)).includes('house-rules-editor'), 'rules tab → Neue Regel: the editor is visible on top');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await E(`([...ed.shadowRoot.querySelectorAll('.hr-rule')].find((x) => x.textContent.includes('Grundriss-Test Haustür')).querySelector('.hr-pick').click(), true)`);
ok(await until(() => E(`!!plan.hrMarks && plan.hrMarks.devices.length >= 3 && !!plan.shadowRoot.querySelector('svg.plan g.hrmarks')`)), 'picked rule: devices marked on the plan');
const marks = await E(`plan.hrMarks`);
ok(marks.devices.find((d) => d.id === 'binary_sensor.haustuer')?.color === '#f08a00' && marks.devices.find((d) => d.id === 'light.flurlicht')?.color === '#007aff', 'trigger orange, action blue');
ok(marks.rooms.some((x) => x.id === 'r_fl') && marks.lines.length >= 2, `room of the condition as an area, lines trigger → action (${marks.lines.length})`);
await page.screenshot({ path: `${out}/hr-editor-rule.png` });
// back out of the editor without saving
await E(`(ed.shadowRoot.querySelector('.tb-left .btn').click(), true)`);
await page.waitForTimeout(400);
// Fenster-Warnung beim Gehen: Hausregeln runs it → the card shows that one (its own warning stands aside), a tap acknowledges it there
const feats0 = (await r({ type: 'house_rules/snapshot' })).features;
const ww0 = (await r({ type: 'house_rules/window_warning/get' })).config;
await C(`(card.setConfig({ ...card._config, entry_alert: { door: 'o_door', timeout: 60 } }), true)`);
await fake('binary_sensor.haustuer', 'off');
await fake('binary_sensor.fenster_kueche', 'off');
await r({ type: 'house_rules/features/set', features: { window_warning: true } });
await r({ type: 'house_rules/window_warning/set', config: { doors: ['binary_sensor.haustuer'], windows: 'all', only_last: false, delay: 0, timeout: 60, blink: true, lights: { mode: 'none', entities: [] }, announce: { mode: 'none' }, notify: { on: false } } });
ok(await until(() => C(`card.hrWarning === true`)), 'card notices that Hausregeln runs the window warning');
await fake('binary_sensor.fenster_kueche', 'on');
await page.waitForTimeout(400);
await fake('binary_sensor.haustuer', 'on');
ok(await until(() => C(`card.entryAlert.state.active && card.entryAlert.state.phase === 'alarm' && card.entryAlert.state.windows.some((w) => w.id === 'o_win')`)), 'Hausregeln warns → the card shows it with the open kitchen window');
ok(await C(`!!card.shadowRoot.querySelector('.entry-alert')`), 'red warning at the top of the card');
await page.screenshot({ path: `${out}/hr-window-warning.png` });
await page.mouse.click(640, 500);
ok(await until(async () => (await r({ type: 'house_rules/window_warning/get' })).phase !== 'alarm'), 'a tap on the tablet acknowledges it in Hausregeln');
await fake('binary_sensor.haustuer', 'off');
await fake('binary_sensor.fenster_kueche', 'off');
ok(await until(() => C(`!card.entryAlert.state.active`), 10000), 'warning over on the card');
await r({ type: 'house_rules/features/set', features: { window_warning: false } });
ok(await until(() => C(`card.hrWarning === false`)), 'switched off in Hausregeln → the card runs its own warning again');
await fake('binary_sensor.fenster_kueche', 'on');
await page.waitForTimeout(400);
await fake('binary_sensor.haustuer', 'on');
ok(await until(() => C(`card.entryAlert.state.active && card.entryAlert.state.phase === 'alarm'`)), 'own warning (fallback) starts when the door opens');
ok(!(await r({ type: 'house_rules/window_warning/get' })).active, 'Hausregeln stays quiet while switched off');
await C(`(card.entryAlert.acknowledge(true), true)`);
await fake('binary_sensor.haustuer', 'off');
await fake('binary_sensor.fenster_kueche', 'off');
if (ww0) await r({ type: 'house_rules/window_warning/set', config: ww0 });
if (feats0) await r({ type: 'house_rules/features/set', features: feats0 });

console.log(errors.length ? errors.slice(0, 6).join('\n') : 'page: no errors');
// --- clean up the test rules
for (const x of [r1, r2]) await r({ type: 'house_rules/rule/delete', rule_id: x.id });
await browser.close();
ws.close();
