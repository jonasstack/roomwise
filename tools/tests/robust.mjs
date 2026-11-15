// Robustness of the card on the isolated test HA only (prepared by testha-setup.mjs): a user without admin
// rights, the card without Hausregeln and without the companion, unavailable and unknown entities, and a restart of
// Home Assistant while the page stays open (the tablet case). Service calls are intercepted; nothing is saved.
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node tools/tests/testha-setup.mjs && node tools/tests/robust.mjs'
import { execSync } from 'node:child_process';
import { openHA, tapAt, piecePoint } from '../pw.mjs';
import { testEnv } from '../ha.mjs';
import { userToken, rest, sleep, until } from '../../hausregeln/tools/testha/lib.mjs';

const { token, url } = testEnv();
if (url !== 'http://127.0.0.1:8124') throw new Error('robust.mjs restarts the container hr-test-ha: only on the test HA on port 8124');
const out = process.argv[2] ?? '/tmp';
const api = rest(token);
const ALL = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant', 'script', 'scene', 'lock', 'button', 'house_rules'];
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const cardOf = (page) => (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card?.shadowRoot?.querySelector('fp-plan'); return ${expr}; })()`);
const EDIT = '.chrome .icon-btn[aria-label="Grundriss bearbeiten"]';
const setState = (e, state, attributes = {}) => api('POST', `/api/states/${e}`, { state, attributes });

// 1) a user without admin rights (e.g. the wall tablet's account)
{
  const user = await userToken(token, 'tablet');
  const { browser, page, errors, calls } = await openHA({ user, block: ALL });
  const C = cardOf(page);
  await page.waitForTimeout(2500);
  ok(await C(`!!plan && card._config.floors[0].rooms.length === 5`), 'non-admin: the plan is shown');
  ok(await C(`!card.shadowRoot.querySelector('${EDIT}')`), 'non-admin: no edit button');
  const pt = await piecePoint(page, 'light.sofalicht');
  if (pt) await tapAt(page, pt[0], pt[1]);
  await page.waitForTimeout(600);
  ok((await calls()).some((c) => c.domain === 'light' && JSON.stringify(c.target ?? c.data).includes('light.sofalicht')), 'non-admin: tapping a lamp switches it');
  if (pt) await tapAt(page, pt[0], pt[1], 900);
  await page.waitForTimeout(900);
  ok((await page.locator('floorplan-card-layer .sheet').count()) === 1, 'non-admin: long press opens the popup');
  await page.keyboard.press('Escape');
  ok(!errors.length, `non-admin: no console errors ${errors.join(' | ')}`);
  await browser.close();
}

// 2) without Hausregeln (as if not installed) – and, as in every test, without the companion integration
{
  const { browser, page, errors } = await openHA({ hrOff: true, block: ALL });
  const C = cardOf(page);
  await page.waitForTimeout(2500);
  ok(await C(`!!plan && !card.shadowRoot.querySelector('.hr-chip')`), 'without Hausregeln: plan shown, no house mode chip');
  await page.locator(`floorplan-card ${EDIT}`).click();
  await page.waitForTimeout(900);
  ok((await page.locator('floorplan-card-editor-ui .tool[data-panel="rules"]').count()) === 0, 'without Hausregeln: the editor has no rules panel');
  ok((await page.locator('floorplan-card-editor-ui .tool[data-panel="furniture"]').count()) === 1, 'without Hausregeln: the rest of the editor is there');
  await page.locator('floorplan-card-editor-ui .tb-left .btn').click();
  await page.waitForTimeout(300);
  if (await page.locator('floorplan-card-editor-ui .alert').count()) await page.locator('floorplan-card-editor-ui .alert .btn.danger').click();
  ok(!errors.length, `without Hausregeln: no console errors ${errors.join(' | ')}`);
  await browser.close();
}

// 3) unavailable and unknown entities
{
  const { browser, page, errors, calls } = await openHA({ block: ALL });
  const C = cardOf(page);
  await page.waitForTimeout(2500);
  await setState('light.schlafzimmer', 'unavailable', { friendly_name: 'Schlafzimmer Decke' });
  await setState('sensor.temp_schlafzimmer', 'unknown', { friendly_name: 'Temperatur Schlafzimmer', unit_of_measurement: '°C', device_class: 'temperature' });
  // in this page only: things that point at entities that do not exist (deleted or renamed in HA)
  await C(`(card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f, i) => i ? f : { ...f,
    rooms: f.rooms.map((r) => r.name === 'Flur' ? { ...r, climate: 'climate.gone', temperature: 'sensor.gone', lights: ['light.gone'] } : r),
    devices: [...f.devices, { id: 'd_gone', entity: 'media_player.gone', x: 300, y: 300 }],
    furniture: [...f.furniture, { id: 'f_gone', kind: 'floor_lamp', x: 560, y: 60, w: 40, h: 40, entity: 'light.gone' }] }) }), true)`);
  await page.waitForTimeout(1500);
  ok(await C(`!!plan && plan.shadowRoot.querySelectorAll('.label').length > 0`), 'unknown/unavailable entities: plan and labels still drawn');
  await page.evaluate(() => (window.__fpCalls.length = 0));
  const pt = await piecePoint(page, 'light.schlafzimmer');
  if (pt) await tapAt(page, pt[0], pt[1]);
  await page.waitForTimeout(500);
  ok(!(await calls()).some((c) => JSON.stringify(c.target ?? c.data ?? '').includes('light.schlafzimmer')), 'tapping an unavailable lamp sends nothing');
  if (pt) await tapAt(page, pt[0], pt[1], 900);
  await page.waitForTimeout(900);
  const sheet = await page.locator('floorplan-card-layer .sheet').count();
  const sub = sheet ? await page.locator('floorplan-card-layer .head-sub').first().textContent().catch(() => '') : '';
  ok(sheet === 1 && /nicht verfügbar|unavailable/i.test(sub ?? ''), `the popup of an unavailable lamp opens and says so (${sub?.trim()})`);
  ok(sheet === 1 && (await page.locator('floorplan-card-layer .big-toggle[disabled], floorplan-card-layer [disabled]').count()) > 0, 'its controls are disabled');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const gone = await piecePoint(page, 'light.gone');
  if (gone) await tapAt(page, gone[0], gone[1], 900);
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${out}/robust-unavailable.png` });
  ok(!errors.length, `unknown/unavailable entities: no console errors ${errors.join(' | ')}`);
  await setState('light.schlafzimmer', 'off', { friendly_name: 'Schlafzimmer Decke', supported_color_modes: ['color_temp'], color_mode: null, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 });
  await setState('sensor.temp_schlafzimmer', '19.5', { friendly_name: 'Temperatur Schlafzimmer', unit_of_measurement: '°C', device_class: 'temperature' });
  await browser.close();
}

// 4) Home Assistant restarts while the tablet shows the card: afterwards the card shows live states again
{
  const { browser, page, errors } = await openHA({ block: ALL });
  const C = cardOf(page);
  await page.waitForTimeout(2500);
  ok(!!(await until(() => C(`!!card.shadowRoot.querySelector('.hr-chip')`), 15000, 500)), 'before the restart: the Hausregeln chip is there');
  execSync('docker restart hr-test-ha');
  for (let i = 0; i < 90; i++) {
    const r = await api('GET', '/api/config').catch(() => null);
    if (r?.status === 200 && r.body?.state === 'RUNNING') break;
    await sleep(2000);
  }
  await sleep(3000);
  // a state that only exists after the restart reaches the open page (the frontend reconnected and resubscribed)
  await setState('sensor.temp_schlafzimmer', '23.4', { friendly_name: 'Temperatur Schlafzimmer', unit_of_measurement: '°C', device_class: 'temperature' });
  const live = await until(() => C(`card._hass?.states['sensor.temp_schlafzimmer']?.state === '23.4'`), 60000, 1000);
  ok(!!live, 'after a restart of Home Assistant the open card gets live states again');
  ok(await C(`!!plan && plan.shadowRoot.querySelectorAll('.label').length > 0`), 'and still shows the plan');
  await page.waitForTimeout(1500);
  const hrBack = await until(() => C(`!!card.shadowRoot.querySelector('.hr-chip')`), 30000, 1000);
  ok(!!hrBack, 'the Hausregeln chip comes back after the restart');
  await page.screenshot({ path: `${out}/robust-restart.png` });
  // reconnecting may log websocket errors of HA's own frontend; the card must not throw
  const own = errors.filter((e) => /pageerror/.test(e) && !/Connection lost|socket|ERR_CONNECTION|^\[pageerror\] Object$/i.test(e));
  ok(!own.length, `restart: no page errors ${own.join(' | ')}`);
  await setState('sensor.temp_schlafzimmer', '19.5', { friendly_name: 'Temperatur Schlafzimmer', unit_of_measurement: '°C', device_class: 'temperature' });
  await browser.close();
}
