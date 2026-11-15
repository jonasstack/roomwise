// Dog figure on the mock harness (no Home Assistant): pet.figure 'simple' builds the light code-drawn figure without
// loading a model file and still walks to the front door when a walk is due; 'realistic' (default) loads the GLB model.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/dog-figure.mjs [outDir] [light|dark]
import { readdirSync } from 'node:fs';
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a walk that is due right now: the dog heads for the front door
const d = new Date(Date.now() - 10 * 60000);
const slot = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

for (const figure of ['simple', 'realistic', undefined]) {
  const cfg = demoHome();
  cfg.floors[0].furniture.push({ id: 'dog', kind: 'dog', variant: 'retriever', name: 'Rex', x: 420, y: 250, w: 80, h: 28, color: '#e0a55a', pet: { walks: [slot], ...(figure ? { figure } : {}) } });
  const m = await openMock({ config: { ...cfg, view_mode: '3d' }, states: demoStates(), entities: demoEntities, size: '1280x900', scheme });
  await wait(3500);
  // every file the page fetched (the page is open before a listener could be attached)
  const glb = await m.page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/dog-[^/]*\.glb$/.test(u)));
  const name = figure ?? 'default';
  const dog = () =>
    m.card(`(() => { const s = plan.glScene; const g = s?.petGroup.children.find((c) => c.userData.id === 'dog'); const a = s?.dogs.get('dog')?.actor;
      return g ? { x: Math.round(g.position.x), y: Math.round(g.position.y), actor: !a ? 'none' : 'mixer' in a ? 'glb' : 'simple', meshes: (() => { let n = 0; g.traverse((o) => o.isMesh && n++); return n; })() } : null; })()`);
  const d0 = await dog();
  ok(!!d0, `${name}: dog on the plan (${JSON.stringify(d0)})`);
  const want = figure === 'simple' ? 'simple' : 'glb';
  ok(d0?.actor === want, `${name}: figure is ${want} (${d0?.actor})`);
  ok(figure === 'simple' ? glb.length === 0 : glb.length > 0, `${name}: dog model files loaded: ${glb.length}`);
  if (figure === 'simple') ok(d0.meshes <= 20, `simple: light (${d0.meshes} meshes incl. shadow and leash)`);
  await wait(1500);
  const d1 = await dog();
  ok(d0 && d1 && (d0.x !== d1.x || d0.y !== d1.y), `${name}: walks (${d0?.x},${d0?.y} → ${d1?.x},${d1?.y})`);
  if (figure) await m.page.screenshot({ path: `${out}/dog-figure-${figure}-${scheme}.png` });
  const errs = m.errors.filter((e) => !/favicon|404|GL Driver Message/.test(e));
  ok(!errs.length, `${name}: no page errors ${errs.slice(0, 3).join(' | ')}`);
  await m.browser.close();
}
// the dog editor: chips "Figur: Einfach / Realistisch"; simple shows the simple figure and no paint tool
{
  const chunk = readdirSync('dist/chunks').find((f) => f.startsWith('dog-editor-'));
  const m = await openMock({ config: { ...demoHome(), view_mode: '2d' }, states: demoStates(), entities: demoEntities, size: '1280x900', scheme });
  const ed = (expr) => m.page.evaluate(`(async () => { const ed = document.querySelector('fp-dog-editor'); const root = ed?.shadowRoot; return ${expr}; })()`);
  await m.page.evaluate(async (c) => {
    await import(`/chunks/${c}`);
    const ed = document.createElement('fp-dog-editor');
    ed.furniture = { id: 'dog', kind: 'dog', variant: 'medium', x: 0, y: 0, w: 72, h: 26 };
    ed.style.cssText = 'position:fixed;inset:0;z-index:9;background:#fff';
    document.body.append(ed);
  }, chunk);
  await wait(2500);
  ok((await ed(`root.querySelector('[data-figure="realistic"]')?.getAttribute('aria-pressed')`)) === 'true', 'editor: realistic chip pressed by default');
  ok((await ed(`!!root.querySelector('[data-mode="paint"]')`)) === true, 'editor: realistic has the paint tool');
  await ed(`(root.querySelector('[data-figure="simple"]').click(), true)`);
  await wait(800);
  ok((await ed(`ed._f.pet?.figure`)) === 'simple', 'editor: "Einfach" sets pet.figure = simple');
  ok((await ed(`!root.querySelector('[data-mode="paint"]') && !root.querySelector('[data-detail]')`)) === true, 'editor: simple hides painting and plan detail');
  ok((await ed(`ed.studio?.actor && !('mixer' in ed.studio.actor)`)) === true, 'editor: the studio shows the simple figure');
  await m.page.screenshot({ path: `${out}/dog-figure-editor-${scheme}.png` });
  await ed(`(root.querySelector('[data-figure="realistic"]').click(), true)`);
  await wait(300);
  ok((await ed(`ed._f.pet?.figure`)) === undefined, 'editor: "Realistisch" removes the key again (default)');
  const errs = m.errors.filter((e) => !/favicon|404|GL Driver Message/.test(e));
  ok(!errs.length, `editor: no page errors ${errs.slice(0, 3).join(' | ')}`);
  await m.browser.close();
}
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
