// Heating shows warm streams above heaters (linked, or unlinked following the room thermostat). Fake states only.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['climate'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(1500);
// a radiator in a room with a thermostat (temporary config)
const info = await card(`(() => { const st = card._hass.states; const climate = Object.keys(st).find((e) => e.startsWith('climate.'));
  const f = card.rawConfig.floors[0]; const room = f.rooms.find((r) => r.name === 'Wohnzimmer') ?? f.rooms[0];
  const xs = room.points.map((p) => p[0]), ys = room.points.map((p) => p[1]);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = Math.min(...ys) + 12;
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((fl, i) => i ? fl : { ...fl, rooms: fl.rooms.map((r) => r.id === room.id ? { ...r, climate } : r), furniture: [...(fl.furniture ?? []), { id: 'fp_rad', kind: 'radiator', x, y, w: 100, h: 10 }] }) });
  const orig = card.optimistic.get.bind(card.optimistic);
  card.optimistic.get = (h, id) => { const s = orig(h, id); return id === climate && s ? { ...s, state: 'heat', attributes: { ...s.attributes, hvac_action: 'heating' } } : s; };
  card._tick++; /* a redraw: changes of other entities do not redraw the plan */ return { climate, room: room.id }; })()`);
await page.waitForTimeout(1800);
const anim = () => card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'fp_rad'); return g ? { anim: !!g.userData.anim, fx: g.userData.fx?.kind, sprites: g.children.filter((c) => c.isSprite).length } : null; })()`);
const a = await anim();
ok(a && a.fx === 'heat' && a.anim, `unlinked radiator heats with the room thermostat (${JSON.stringify(a)})`);
// the warm streams are upright shader ribbons: their time uniform moves on
const wisps = `(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'fp_rad'); const r = g.children.filter((c) => c.material?.uniforms?.t); return r.length ? r.length + ':' + r[0].material.uniforms.t.value.toFixed(2) : ''; })()`;
const o1 = await card(wisps);
await page.waitForTimeout(500);
const o2 = await card(wisps);
ok(o1 && o1 !== o2, `warm streams rise (animated: ${o1} → ${o2})`);
await card(`(plan.focusRoom('${info.room}'), true)`);
await page.waitForTimeout(1300);
await page.screenshot({ path: `${out}/heating-${scheme}.png` });
// heating stops
await card(`(() => { const orig = card.optimistic.get; card.optimistic.get = (h, id) => { const s = orig(h, id); return id === '${info.climate}' && s ? { ...s, state: 'heat', attributes: { ...s.attributes, hvac_action: 'idle' } } : s; }; card._tick++; return true; })()`);
await page.waitForTimeout(1600);
const b = await anim();
ok(b && !b.anim && !b.fx, 'idle thermostat: no streams (' + JSON.stringify(b) + ' sig ' + (await card("plan.furnSig(plan.floor).get('fp_rad')")) + ' glsig ' + (await card("plan.glFxSig.get('fp_rad') + ' key ' + plan.glFurnKey + ' n ' + plan.glScene.furniture.children.filter((c) => c.userData.id === 'fp_rad').length")) + ')');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
