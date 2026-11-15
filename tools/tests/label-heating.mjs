// Tapping a room label opens the room's heating (option); outdoor temperature as a quiet value. Temporary config only.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'switch', 'fan', 'climate', 'media_player', 'vacuum', 'cover', 'todo'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
const info = await card(`(() => { const st = card._hass.states; const climate = Object.keys(st).find((e) => e.startsWith('climate.'));
  const temp = Object.keys(st).find((e) => e.startsWith('sensor.') && st[e].attributes.device_class === 'temperature' && !isNaN(parseFloat(st[e].state)));
  const f = card.rawConfig.floors[0]; const room = f.rooms.find((r) => !r.hide_label && r.points.length >= 3);
  const xs = f.rooms.flatMap((r) => r.points.map((p) => p[0])); const ys = f.rooms.flatMap((r) => r.points.map((p) => p[1]));
  return { climate, temp, room: room.id, x: Math.min(...xs) - 70, y: (Math.min(...ys) + Math.max(...ys)) / 2, value: st[temp]?.state }; })()`);
console.log('using', JSON.stringify(info));
await card(`(card.setConfig({ ...card.rawConfig, label_style: undefined, label_tap: 'heating', floors: card.rawConfig.floors.map((f, i) => i ? f : ({ ...f,
  rooms: f.rooms.map((r) => r.id === '${info.room}' ? { ...r, climate: '${info.climate}' } : r),
  devices: [...(f.devices ?? []), { id: 'fp_out', entity: '${info.temp}', x: ${info.x}, y: ${info.y}, display: 'value' }] })) }), true)`);
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__mi = []; window.addEventListener('hass-more-info', (e) => window.__mi.push(e.detail?.entityId), true); });
const label = await card(`(() => { const r = plan.shadowRoot.querySelector('.labels .label[data-label="${info.room}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
ok(await card(`plan.shadowRoot.querySelector('.labels .label[data-label="${info.room}"]').classList.contains('tap')`), 'label with a thermostat takes taps');
await tapAt(page, label[0], label[1]);
await page.waitForTimeout(900);
const popup = await page.evaluate(() => { const l = document.querySelector('floorplan-card-layer'); const p = l?.shadowRoot?.querySelector('fp-popup, .popup, [class*="popup"]'); return p ? (p.entity ?? p.getAttribute('class')) : null; });
const opened = await page.evaluate(() => document.querySelector('floorplan-card-layer')?._stack?.at(-1)?.entity ?? null);
ok(!!opened, `tap on the label opens the heating popup (${opened ?? popup})`);
await page.screenshot({ path: `${out}/label-heating-${scheme}.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.evaluate(() => { const l = document.querySelector('floorplan-card-layer'); if (l) l._stack = []; });
await page.waitForTimeout(400);
// outdoor value
const txt = await card(`plan.shadowRoot.querySelector('.value-tag .v')?.textContent ?? ''`);
ok(/°$/.test(txt.trim()), `outdoor temperature shown as a quiet number (${txt.trim()})`);
ok(!(await card(`!!plan.shadowRoot.querySelector('.value-wrap .marker')`)), 'no marker circle for value-only devices');
await page.screenshot({ path: `${out}/outdoor-value-${scheme}.png` });
const v = await card(`(() => { const r = plan.shadowRoot.querySelector('.value-tag').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await tapAt(page, v[0], v[1]);
await page.waitForTimeout(700);
ok((await page.evaluate(() => window.__mi)).includes(info.temp) || !!(await card('card.layer?.popup?.entity ?? null')), 'tapping the value opens its details');
// option off: label tap = room tap
await card(`(card.setConfig({ ...card.rawConfig, label_tap: undefined }), true)`);
await page.waitForTimeout(800);
ok(!(await card(`plan.shadowRoot.querySelector('.labels .label.tap')`)), 'without the option labels pass taps to the room');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
