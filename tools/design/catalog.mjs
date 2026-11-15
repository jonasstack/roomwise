// Catalogue overview: every object kind with all its variants, one temporary plan per category, in 2D and 3D.
// Nothing is saved (in-page config only), service calls blocked.
// Usage: FP_LOCAL=1 node tools/design/catalog.mjs <outdir> [cat,cat,…|all] [2d,3d] [kind,kind,… (only these)]
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openHA } from '../pw.mjs';
import { cardFn, fakeStates } from './fake.mjs';

const out = process.argv[2] ?? '/tmp';
const wantCats = (process.argv[3] ?? 'all').split(',');
const modes = (process.argv[4] ?? '2d,3d').split(',');
const onlyKinds = process.argv[5] ? process.argv[5].split(',') : undefined;
// CAT_SCALE=4: small devices enlarged and set on the floor (close look at their 3D shape)
const SCALE = Number(process.env.CAT_SCALE ?? 1);

// the catalogue straight from the source (lit renders fine in node)
const dir = mkdtempSync(join(tmpdir(), 'fpcat-'));
writeFileSync(join(dir, 'e.ts'), `import { FURNITURE, CATEGORIES } from ${JSON.stringify(resolve('src/furniture.ts'))};
console.log(JSON.stringify({ cats: CATEGORIES.map((c) => c.id), kinds: FURNITURE.map((k) => ({ kind: k.kind, cat: k.cat, w: k.w, h: k.h,
  variants: (k.variants ?? [{ id: undefined }]).map((v) => ({ id: v.id, w: v.w ?? k.w, h: v.h ?? k.h, height: v.height ?? k.height })) })) }));`);
await esbuild.build({ entryPoints: [join(dir, 'e.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'e.mjs'), logLevel: 'warning' });
const { execFileSync } = await import('node:child_process');
const cat = JSON.parse(execFileSync('node', [join(dir, 'e.mjs')]).toString());

const { browser, page, errors } = await openHA({ size: '1600x1000', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'lock', 'siren', 'alarm_control_panel', 'button', 'valve', 'tts', 'notify', 'input_boolean'] });
const card = cardFn(page);
await page.waitForTimeout(1500);
// CAT_DAY=1: midday sun (only faked in the page) so the 3D shapes are easy to see
if (process.env.CAT_DAY) await fakeStates(page, { weather: 'sunny', cover: 5, states: { 'sun.sun': { state: 'above_horizon', attributes: { elevation: 42, azimuth: 190 } } } });

// cats = "mix": the chosen kinds of every category on one plan
for (const c of wantCats.includes('mix') ? ['mix'] : cat.cats) {
  if (c !== 'mix' && !wantCats.includes('all') && !wantCats.includes(c)) continue;
  const items = cat.kinds.filter((k) => (c === 'mix' || k.cat === c) && (!onlyKinds || onlyKinds.includes(k.kind))).flatMap((k) => k.variants.map((v) => ({ kind: k.kind, variant: v.id, w: v.w * SCALE, h: v.h * SCALE, height: v.height * SCALE })));
  if (!items.length) continue;
  // shelf packing
  const gap = Number(process.env.CAT_GAP ?? 30);
  const area = items.reduce((a, it) => a + (it.w + gap) * (it.h + gap), 0);
  const W = Math.max(...items.map((it) => it.w + gap), Math.sqrt(area) * 1.5);
  let x = 0, y = 0, rowH = 0;
  const furniture = items.map((it, i) => {
    if (x + it.w > W) { x = 0; y += rowH + gap; rowH = 0; }
    const f = { id: `cat${i}`, kind: it.kind, ...(it.variant ? { variant: it.variant } : {}), x: x + it.w / 2, y: y + it.h / 2, w: it.w, h: it.h, ...(SCALE !== 1 ? { height: it.height, elevation: 0 } : {}) };
    x += it.w + gap;
    rowH = Math.max(rowH, it.h);
    return f;
  });
  const maxX = Math.max(...furniture.map((f) => f.x + f.w / 2)) + 40;
  const maxY = Math.max(...furniture.map((f) => f.y + f.h / 2)) + 40;
  const room = { id: 'catroom', name: c, outdoor: true, points: [[-40, -40], [maxX, -40], [maxX, maxY], [-40, maxY]] };
  await page.evaluate(`(() => { ${'const find = (root) => { for (const el of root.querySelectorAll("*")) { if (el.tagName === "FLOORPLAN-CARD") return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };'}
    const card = find(document);
    const raw = card.__catRaw ?? (card.__catRaw = card.rawConfig);
    card.setConfig({ ...raw, floors: [{ ...raw.floors[0], rooms: [${JSON.stringify(room)}], devices: [], openings: [], furniture: ${JSON.stringify(furniture)} }] });
  })()`);
  await page.waitForTimeout(1200);
  for (const m of modes) {
    await card(`(plan.viewMode = '${m}', true)`);
    await page.waitForTimeout(900);
    await card(`(plan.resetView?.(), true)`);
    await page.waitForTimeout(m === '3d' ? 2600 : 1000);
    await page.screenshot({ path: `${out}/cat-${c}-${m}.png` });
  }
  console.log(c, items.length);
}
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
