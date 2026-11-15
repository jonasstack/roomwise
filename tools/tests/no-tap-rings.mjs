// No decorative feedback: tapping a piece (switch, scene), a room, or checking off a dog's walk creates no rings,
// ripples, pulses or flashes — in 2D, WebGL 3D and CSS 3D. Only calm state feedback stays (a lamp lighting up, a
// popup, a message) and one short, light bounce of a tapped lamp (a lamp kind or a piece linked to a light) —
// never of other devices. Mock harness, neutral demo home (no Home Assistant).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/no-tap-rings.mjs [outDir]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a walk that is due right now (started 10 minutes ago, local time)
const d = new Date(Date.now() - 10 * 60000);
const slot = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const cfg = demoHome();
cfg.floors[0].furniture.push(
  { id: 'scenebtn', kind: 'speaker', entity: 'scene.demo_evening', x: 150, y: 150, w: 30, h: 30, tap_action: { action: 'perform-action', perform_action: 'scene.turn_on', target: { entity_id: 'scene.demo_evening' } } },
  { id: 'lamp', kind: 'floor_lamp', entity: 'light.demo_garden', x: 60, y: 60, w: 40, h: 40 },
  { id: 'dog', kind: 'dog', variant: 'medium', name: 'Rex', x: 420, y: 250, w: 72, h: 26, pet: { walks: [slot] } },
);
const states = { ...demoStates(), 'scene.demo_evening': { state: 'scening', attributes: { friendly_name: 'Abend' } } };

// what counts as decorative feedback
const FORBIDDEN = ['fp-tap-ring', 'fp-hr-pulse', 'fp-flash', 'fp-flash-2d', 'fp-floor-pulse'];
const probe = (m) =>
  m.card(`(() => {
    const roots = [plan.shadowRoot, card.shadowRoot, ...[...card.shadowRoot.querySelectorAll('fp-floor-slider')].map((s) => s.shadowRoot)].filter(Boolean);
    const els = roots.flatMap((r) => [...r.querySelectorAll('.tapfx, .hrpulse, .piece.flash, .p3.flash, .item.pulse')]).length;
    const anims = roots.flatMap((r) => r.getAnimations()).map((a) => a.animationName).filter(Boolean);
    const bounced = [...new Set([...plan.shadowRoot.querySelectorAll('.pb.bounce, .b3.bounce')].map((e) => e.closest('[data-furniture]')?.dataset.furniture))];
    const g = plan.glScene;
    const gl = g ? { pulses: g.pulses?.length ?? 0, scaled: g.furniture.children.filter((c) => Math.abs(c.scale.x - 1) > 1e-3).map((c) => c.userData.id) } : null;
    return { els, anims, gl, bounced };
  })()`);
// `bounce`: the id of the lamp that must bounce once (nothing else may move)
const quiet = async (m, what, bounce) => {
  const seen = { els: 0, anims: new Set(), pulses: 0, bounced: new Set() };
  let last;
  for (let i = 0; i < 10; i++) {
    const p = await probe(m);
    seen.els = Math.max(seen.els, p.els);
    for (const a of p.anims) if (FORBIDDEN.includes(a)) seen.anims.add(a);
    seen.pulses = Math.max(seen.pulses, p.gl?.pulses ?? 0);
    for (const id of [...p.bounced, ...(p.gl?.scaled ?? [])]) seen.bounced.add(id);
    last = p;
    await wait(90);
  }
  ok(!seen.els && !seen.anims.size && !seen.pulses, `${what}: no ring, pulse or flash (${JSON.stringify({ els: seen.els, anims: [...seen.anims], glPulses: seen.pulses })})`);
  const b = [...seen.bounced];
  if (bounce) ok(b.length === 1 && b[0] === bounce && !last.bounced.length && !(last.gl?.scaled ?? []).length, `${what}: the lamp bounced once and settled (${JSON.stringify(b)})`);
  else ok(!b.length, `${what}: nothing bounces (${JSON.stringify(b)})`);
};
// a real tap where the piece is drawn (2D piece, CSS-3D or WebGL body); the dog in WebGL walks on its own layer:
// the card's tap handler then, the same path a tap takes
const center = (m, id) =>
  m.card(`(() => { const r = plan.pieceRect(${JSON.stringify(id)}) ?? plan.shadowRoot.querySelector('.piece[data-furniture="${id}"]')?.getBoundingClientRect(); return r && r.width ? [r.x + r.width / 2 || r.x + r.w / 2, r.y + (r.height ?? r.h) / 2] : r && r.w ? [r.x + r.w / 2, r.y + r.h / 2] : null; })()`);
const tapPiece = async (m, id) => {
  const c = await center(m, id);
  const is3d = await m.card('plan.is3d');
  const hit = c && is3d ? await m.card(`plan.pieceAt(${c[0]}, ${c[1]}) ?? null`) : undefined;
  if (c && (!is3d || hit === id)) await m.page.mouse.click(c[0], c[1]);
  else await m.card(`(card.handlers.onTapDown({ kind: 'furniture', id: ${JSON.stringify(id)} }), card.handlers.onTap({ kind: 'furniture', id: ${JSON.stringify(id)} }), true)`);
  return true;
};
const walkMode = async (m) => {
  await m.setStates({ 'sensor.demo_mower_battery': { state: String(80 + Math.floor(Math.random() * 10)) } });
  await wait(300);
  return m.card(`card.pets?.states?.get('dog')?.mode`);
};

for (const [mode, extra] of [['2d', { view_mode: '2d' }], ['webgl', { view_mode: '3d' }], ['css3d', { view_mode: '3d', renderer: 'css' }]]) {
  const m = await openMock({ config: { ...cfg, ...extra }, states, entities: demoEntities, size: '1280x1024' });
  await wait(mode === 'webgl' ? 3500 : 1500);
  if (mode === 'webgl') ok(await m.card('!!plan.glScene'), 'WebGL scene up');
  ok(await tapPiece(m, 'lamp'), `${mode}: tap the lamp`);
  await quiet(m, `${mode}, lamp`, 'lamp');
  ok(await tapPiece(m, 'socket'), `${mode}: tap the socket (switch)`);
  await quiet(m, `${mode}, switch piece`);
  ok(await tapPiece(m, 'scenebtn'), `${mode}: tap the scene piece`);
  await quiet(m, `${mode}, scene piece`);
  ok((await m.calls()).some((c) => c.domain === 'scene' || c.service === 'turn_on'), `${mode}: the scene ran (${JSON.stringify((await m.calls()).map((c) => c.domain + '.' + c.service))})`);
  // a room: pressed and released
  const room = await m.card(`(() => { const p = plan.shadowRoot.querySelector('path.room[data-room="kitchen"]'); const r = p?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (room && mode === '2d') {
    await m.page.mouse.click(room[0], room[1]);
    await quiet(m, `${mode}, room`);
  }
  // the dog wants out: a tap checks the walk off
  ok((await walkMode(m)) === 'due', `${mode}: the walk is due (${slot})`);
  ok(await tapPiece(m, 'dog'), `${mode}: tap the dog`);
  await quiet(m, `${mode}, walk checked off`);
  ok((await walkMode(m)) !== 'due', `${mode}: the walk counts as done`);
  if (out) await m.page.screenshot({ path: `${out}/no-tap-rings-${mode}.png` });
  ok(!m.errors.filter((e) => !/unknown_command|Unknown command|WebGL|GPU stall/.test(e)).length, `${mode}: console ${m.errors.join(' | ') || 'clean'}`);
  await m.browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
