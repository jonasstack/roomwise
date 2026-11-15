// Dog & cat: look, walk schedule (due → walks to the front door), check-off by tap, presence away. Temporary config, fake states.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.evaluate(() => localStorage.removeItem('fp-walks'));
await page.waitForTimeout(1500);
const now = new Date();
const slot = `${String(now.getHours()).padStart(2, '0')}:${String(Math.max(0, now.getMinutes() - 5)).padStart(2, '0')}`;
const info = await card(`(() => { const st = card._hass.states; const presence = Object.keys(st).find((e) => e.startsWith('person.')) ?? Object.keys(st).find((e) => e.startsWith('device_tracker.'));
  const f = card.rawConfig.floors[0]; const room = f.rooms.find((r) => r.name === 'Wohnzimmer') ?? f.rooms[0];
  const xs = room.points.map((p) => p[0]), ys = room.points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((fl, i) => i ? fl : { ...fl, furniture: [...(fl.furniture ?? []).filter((x) => x.kind !== 'dog' && x.kind !== 'cat'),
    { id: 'fp_dog', kind: 'dog', variant: 'retriever', x: cx - 60, y: cy + 40, w: 92, h: 30, rotation: 30, name: 'Bello', pet: { walks: ['${slot}'], collar: '#3f8ed8' } },
    { id: 'fp_cat', kind: 'cat', x: cx + 80, y: cy + 50, w: 46, h: 20, name: 'Mia', color: '#e0a55a', pet: { markings: 'socks' } }] }) });
  return { presence, room: room.id }; })()`);
await page.waitForTimeout(1500);
const pet = (id) => card(`(() => { const g = [...plan.glScene.furniture.children, ...plan.glScene.petGroup.children].find((c) => c.userData.id === '${id}'); return g ? { x: Math.round(g.position.x), y: Math.round(g.position.y), anim: !!g.userData.anim, meshes: g.children.length } : null; })()`);
ok((await card(`card.pets.states.get('fp_dog')?.mode`)) === 'due', `walk at ${slot} is due`);
const chip = () => card(`[...plan.shadowRoot.querySelectorAll('.pet-chip')].map((c) => c.className.replace('pet-chip ', '') + ':' + c.textContent.trim()).join(' | ')`);
ok((await chip()).includes('Bello will raus'), `chip at the front door: "${await chip()}"`);
await page.waitForTimeout(2500); // the dog model loads
const p0 = await pet('fp_dog');
await page.waitForTimeout(1200);
const p1 = await pet('fp_dog');
ok(p0 && p1 && (p0.x !== p1.x || p0.y !== p1.y), `the dog walks (${JSON.stringify(p0)} → ${JSON.stringify(p1)})`);
await page.screenshot({ path: `${out}/pet-walk-${scheme}.png` });
await page.waitForTimeout(6000);
await page.screenshot({ path: `${out}/pet-door-${scheme}.png` });
ok(!!(await pet('fp_cat')), 'cat is shown');
// tap the dog: walk checked off
// the dog can be hit where it is right now (it keeps moving at the door)
const hit = await card(`(() => { const g = plan.glScene; const d = g.petGroup.children.find((c) => c.userData.id === 'fp_dog'); if (!d) return null; const p = d.getWorldPosition(d.position.clone()); p.z += 25; p.project(g.camera); const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); return plan.glPick({ clientX: vp.left + (p.x + 1) / 2 * g.view.width, clientY: vp.top + (1 - p.y) / 2 * g.view.height }, 0, 0, true); })()`);
ok(hit === 'fp_dog', `the dog takes taps (${hit})`);
await card(`(card.gesture({ kind: 'furniture', id: 'fp_dog' }, 'tap'), true)`);
await page.waitForTimeout(900);
ok((await card(`card.pets.states.get('fp_dog')?.mode`)) === 'idle', 'tap on the dog checks the walk off');
// due again: a tap on the message checks it off too
await page.evaluate(() => localStorage.removeItem('fp-walks'));
await card(`(card.pets.sig = '', card.pets.update(card._hass, card.floor), card._tick++, true)`);
await page.waitForTimeout(900);
const chipBox = await card(`(() => { const c = plan.shadowRoot.querySelector('.pet-chip.due'); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
ok(!!chipBox, 'due again → message shown');
if (chipBox) {
  await tapAt(page, chipBox[0], chipBox[1]);
  await page.waitForTimeout(900);
  ok((await card(`card.pets.states.get('fp_dog')?.mode`)) === 'idle', 'tap on the message checks the walk off');
}
// presence away
await card(`(() => { let real = card._hass; const away = (st) => ({ ...st, '${info.presence}': { ...st['${info.presence}'], state: 'not_home', last_changed: new Date(Date.now() - 10 * 60000).toISOString() } });
  Object.defineProperty(card, '_hass', { configurable: true, get() { return real ? { ...real, states: away(real.states) } : real; }, set(v) { real = v; } });
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((fl, i) => i ? fl : { ...fl, furniture: fl.furniture.map((f) => f.id === 'fp_dog' ? { ...f, entity: '${info.presence}' } : f) }) }); return true; })()`);
await page.waitForTimeout(1500);
ok((await card(`card.pets.states.get('fp_dog')?.mode`)) === 'away', 'presence away → dog is out');
ok(!(await pet('fp_dog')), 'dog not shown while out');
ok((await chip()).includes('Bello ist Gassi'), `chip: "${await chip()}"`);
await page.screenshot({ path: `${out}/pet-away-${scheme}.png` });
// back home after a walk that covered the slot: checked off automatically (history of the presence entity)
await page.evaluate(() => localStorage.removeItem('fp-walks'));
const auto = await card(`(() => { let real = Object.getOwnPropertyDescriptor(card, '_hass').get.call({}) ?? document.querySelector('home-assistant').hass;
  delete card._hass; card._hass = document.querySelector('home-assistant').hass;
  const hs = card._hass; const fake = { ...hs, states: { ...hs.states, '${info.presence}': { ...hs.states['${info.presence}'], state: 'home' } } };
  const [h, m] = '${slot}'.split(':').map(Number); const t = new Date(); t.setHours(h, m, 0, 0);
  card.pets.history.set('${info.presence}', [{ from: t.getTime() - 10 * 60000, to: t.getTime() + 15 * 60000 }]);
  card.pets.fetched.set('${info.presence}', Date.now()); card.pets.lastState.set('${info.presence}', 'home');
  const st = card.pets.update(fake, card.floor).get('fp_dog'); return st.mode + ' done:' + st.done.join(','); })()`);
ok(auto === `idle done:${slot}`, `walk checked off automatically by the presence history (${auto})`);
await page.evaluate(() => localStorage.removeItem('fp-walks'));
// a walk that is due stays due (no time window): slot three hours ago, nothing done
const late = await card(`(() => { const t = new Date(); const h = (t.getHours() + 21) % 24; if (h > t.getHours()) return 'skip'; const sl = String(h).padStart(2, '0') + ':00';
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((fl, i) => i ? fl : { ...fl, furniture: fl.furniture.map((f) => f.id === 'fp_dog' ? { ...f, entity: undefined, pet: { ...f.pet, walks: [sl] } } : f) }) });
  card.pets.sig = ''; return card.pets.update(card._hass, card.floor).get('fp_dog').mode; })()`);
ok(late === 'due' || late === 'skip', `a missed walk stays due until it is done (${late})`);
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
