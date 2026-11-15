// Labels and chips (room names, "Auto · 80 %") stay upright in 3D on the mock harness: a render that replaces the
// stage's style attribute took the counter-rotation variables with it, and the labels lay flat on the tilted plan
// ("pressed flat") until the camera moved. Here the variables are removed by hand, then the view zooms a little.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/labels-upright.mjs
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const m = await openMock({ config: { ...demoHome(), view_mode: '3d' }, states: demoStates(), entities: demoEntities, size: '1024x768' });
await wait(2500);
const PLAN = `card.shadowRoot.querySelector('fp-plan')`;
const tilt = () => m.card(`(() => { const st = ${PLAN}.shadowRoot.querySelector('.world-top .stage'); const chip = ${PLAN}.shadowRoot.querySelector('.world-top .pet-chip') ?? ${PLAN}.shadowRoot.querySelector('.world-top .label'); return { stage: st.style.getPropertyValue('--fp-tilt'), chip: chip ? getComputedStyle(chip).getPropertyValue('--fp-tilt').trim() : null }; })()`);
const before = await tilt();
ok(parseFloat(before.stage) > 5 && parseFloat(before.chip) === parseFloat(before.stage), '3D: Schilder kennen die Neigung (stehen aufrecht)', before);
// what a render that replaces the style attribute does
await m.card(`(() => { for (const st of ${PLAN}.shadowRoot.querySelectorAll('.stage')) for (const v of ['--fp-tilt', '--fp-spin', '--fp-walls', '--fp-lift']) st.style.removeProperty(v); return true; })()`);
ok(!(await tilt()).stage, 'Variablen weg (wie nach dem Ersetzen des Stil-Attributs)');
await m.page.mouse.move(500, 400);
await m.page.mouse.wheel(0, -60);
await wait(500);
const after = await tilt();
ok(parseFloat(after.stage) === parseFloat(before.stage) && parseFloat(after.chip) === parseFloat(before.stage), 'nach dem nächsten Kamerabild wieder da: nicht flach gedrückt', after);
// a render of the plan restores them too
await m.card(`(() => { for (const st of ${PLAN}.shadowRoot.querySelectorAll('.stage')) st.style.removeProperty('--fp-tilt'); ${PLAN}.requestUpdate(); return true; })()`);
await wait(300);
ok((await tilt()).stage === before.stage, 'nach einem Neuzeichnen ebenso', await tilt());
ok(!m.errors.filter((x) => !/GL Driver Message/.test(x)).length, 'keine Fehler in der Konsole', m.errors);
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
