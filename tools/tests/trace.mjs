// Trace image in the editor on the mock harness (no Home Assistant; an in-page stand-in for the dashboard storage and the
// companion): load a picture under a floor, set the scale with two points and a distance, opacity, rotation, move it by
// mouse and keys, draw a room on top, keep it in the companion (resized) or — without it — small in the config, hidden on
// the card unless chosen, removed again; PDFs are refused with a hint.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/trace.mjs [outDir]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMock } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const config = {
  type: 'custom:floorplan-card',
  card_id: 'trace',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [{ id: 'f1', name: 'Wohnung', rooms: [{ id: 'r1', name: 'Flur', points: rect(0, 0, 300, 200) }], devices: [] }],
};
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
const LAYER = `document.querySelector('floorplan-card-layer')`;

/** A picture made in the page: a floor plan drawing with noise (so it does not compress to nothing), as PNG file */
async function makePicture(page, w, h, file) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      const img = x.createImageData(w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 200 + Math.random() * 55;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      x.strokeStyle = '#000';
      x.lineWidth = Math.max(4, w / 200);
      x.strokeRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
      x.beginPath();
      x.moveTo(w * 0.5, h * 0.1);
      x.lineTo(w * 0.5, h * 0.9);
      x.stroke();
      return c.toDataURL('image/png').split(',')[1];
    },
    [w, h],
  );
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

async function openEditor(m) {
  await m.card(`(card.openEditor(), true)`);
  await wait(1200);
  await m.page.evaluate((l) => eval(l).shadowRoot.querySelector('fp-editor-tour')?.dispatchEvent(new CustomEvent('tour-end')), LAYER);
  await wait(200);
}
const ed = (m, expr) => m.page.evaluate(`(async () => { const ed = ${ED}; return ${expr}; })()`);
const click = (m, sel) => ed(m, `(ed.shadowRoot.querySelector(${JSON.stringify(sel)}).click(), true)`);
/** screen point of a plan point (editor, 2D) */
const screen = (m, x, y) => ed(m, `(() => { const pz = ed.plan.panZoom; const r = pz.viewport_.getBoundingClientRect(); return [r.left + pz.view.tx + ${x} * pz.view.s, r.top + pz.view.ty + ${y} * pz.view.s]; })()`);
async function loadFile(m, file) {
  const [chooser] = await Promise.all([m.page.waitForEvent('filechooser', { timeout: 5000 }), click(m, '[data-trace-load], [data-trace-replace]')]);
  await chooser.setFiles(file);
  await wait(1200);
}
const toast = (m) => m.page.evaluate((l) => eval(l)._toast?.text ?? '', LAYER);

// ---------- with the companion ----------
const m = await openMock({ config, size: '1280x860', fake: { companion: true } });
const { page } = m;
await openEditor(m);
await click(m, '[data-panel="trace"]');
await wait(300);
ok(await ed(m, `!!ed.shadowRoot.querySelector('[data-trace-load]')`), 'trace panel: "load picture" for an empty floor');
await page.screenshot({ path: `${out}/trace-empty.png` });

// a PDF is refused with a hint
const pdf = join(out, 'plan.pdf');
writeFileSync(pdf, '%PDF-1.4\n%EOF\n');
await loadFile(m, pdf);
ok(/PDF/.test(await toast(m)) && !(await ed(m, `!!ed.floor.trace`)), `PDF refused with a hint ("${(await toast(m)).slice(0, 50)}…")`);

// a big picture: resized in the browser before it is kept
const big = await makePicture(page, 3600, 2400, join(out, 'plan-big.png'));
await loadFile(m, big);
let st = await ed(m, `({ tr: ed.floor.trace, pending: [...ed.pendingImages.values()].map((p) => ({ w: p.width, h: p.height, len: p.data.length })), mode: ed._traceMode?.mode })`);
ok(st.tr?.image?.startsWith('new_') && st.pending.length === 1, 'picture loaded into the draft (kept in the editor until saved)', st);
ok(st.pending[0] && Math.max(st.pending[0].w, st.pending[0].h) <= 2400 && st.pending[0].len <= 1_400_000, `resized: ${st.pending[0]?.w}×${st.pending[0]?.h}, ${Math.round((st.pending[0]?.len ?? 0) / 1024)} KB`);
ok(Math.abs(st.tr.ratio - 2400 / 3600) < 0.01, `aspect ratio kept (${st.tr.ratio?.toFixed(3)})`);
ok(st.mode === 'calibrate', 'right after loading: set the scale');
ok(await ed(m, `!!ed.plan.shadowRoot.querySelector('svg.plan .trace image')`), 'the picture shows under the plan in the editor');
const json = await ed(m, `JSON.stringify(ed._draft).length`);
ok(json < 20000, `the picture's data stays out of the draft and its undo history (${json} chars)`);

// scale: two points 300 cm apart on the plan, the picture says they are 600 cm apart → twice as wide
const w0 = st.tr.w;
for (const [x, y] of [[100, 100], [400, 100]]) {
  const [sx, sy] = await screen(m, x, y);
  await page.mouse.click(sx, sy);
  await wait(150);
}
ok((await ed(m, `ed._traceMode.pts.length`)) === 2, 'two points marked');
ok(await ed(m, `ed.plan.shadowRoot.querySelectorAll('.ed-trace-pt').length === 2 && !!ed.plan.shadowRoot.querySelector('.ed-trace-line')`), 'the points and the distance are drawn');
await page.screenshot({ path: `${out}/trace-calibrate.png` });
await ed(m, `(ed.shadowRoot.querySelector('[data-trace-cm]').value = '600', ed.shadowRoot.querySelector('[data-trace-cm]').form.requestSubmit(), true)`);
await wait(200);
st = await ed(m, `({ tr: ed.floor.trace, mode: ed._traceMode?.mode })`);
ok(Math.abs(st.tr.w - w0 * 2) < 1 && !st.mode, `scale set: width ${Math.round(w0)} → ${Math.round(st.tr.w)} cm`);

// opacity, rotation
await ed(m, `(() => { const r = ed.shadowRoot.querySelector('[data-trace-opacity]'); r.value = '30'; r.dispatchEvent(new Event('change')); return true; })()`);
await ed(m, `(() => { const r = ed.shadowRoot.querySelector('[data-trace="rotation"]'); r.value = '90'; r.dispatchEvent(new Event('change')); return true; })()`);
await wait(150);
st = await ed(m, `({ tr: ed.floor.trace, g: ed.plan.shadowRoot.querySelector('svg.plan .trace')?.getAttribute('transform'), op: ed.plan.shadowRoot.querySelector('svg.plan .trace')?.style.opacity })`);
ok(st.tr.opacity === 0.3 && st.op === '0.3', `opacity 30 % (${st.op})`);
ok(st.tr.rotation === 90 && /rotate\(90 /.test(st.g ?? ''), `turned 90° (${st.g})`);
await ed(m, `(() => { const r = ed.shadowRoot.querySelector('[data-trace="rotation"]'); r.value = '0'; r.dispatchEvent(new Event('change')); return true; })()`);

// move: drag with the mouse, then arrow keys (1 cm, Shift 10 cm)
await click(m, '[data-trace-move]');
await wait(100);
let before = await ed(m, `({ ...ed.floor.trace })`);
const s = await ed(m, `ed.plan.panZoom.view.s`);
const [cx, cy] = await screen(m, 150, 100);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 50, cy + 25, { steps: 5 });
await page.mouse.move(cx + 100, cy + 50, { steps: 5 });
await page.mouse.up();
await wait(150);
let after = await ed(m, `({ ...ed.floor.trace })`);
ok(Math.abs(after.x - before.x - 100 / s) < 2 && Math.abs(after.y - before.y - 50 / s) < 2, `dragged: Δ ${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)} cm`);
await page.evaluate(() => document.activeElement?.blur?.());
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+ArrowDown');
before = after;
after = await ed(m, `({ ...ed.floor.trace })`);
ok(Math.abs(after.x - before.x - 1) < 0.01 && Math.abs(after.y - before.y - 10) < 0.01, 'arrow keys move it (1 cm, Shift 10 cm)');
const rooms0 = await ed(m, `ed.floor.rooms.map((r) => r.points.join())`);
ok((await ed(m, `JSON.stringify(ed.floor.rooms.map((r) => r.points.join()))`)) === JSON.stringify(rooms0), 'moving the picture leaves the rooms alone');
await page.screenshot({ path: `${out}/trace-placed.png` });

// draw a room on top (the picture stays, taps draw)
await click(m, '[data-tool="draw"]');
await wait(150);
ok(await ed(m, `!!ed.plan.shadowRoot.querySelector('svg.plan .trace image')`), 'still visible while drawing');
for (const [x, y] of [[300, 0], [440, 0], [440, 200], [300, 200], [300, 0]]) {
  const [sx, sy] = await screen(m, x, y);
  await page.mouse.click(sx, sy);
  await wait(120);
}
ok((await ed(m, `ed.floor.rooms.length`)) === 2, 'a room drawn on top of the picture', await ed(m, `({ drawing: ed._drawing, tool: ed._tool, sel: ed._sel, panel: ed._panel, rooms: ed.floor.rooms.length })`));

// save: the picture goes to the companion, the config only keeps its id
await click(m, '.save');
await wait(1200);
let fake = await m.fake();
const card0 = fake.dash.views[0].cards[0];
const imgIds = Object.keys(fake.images);
ok(imgIds.length === 1 && card0.floors[0].trace?.image === imgIds[0] && !card0.floors[0].trace.src, `saved: picture in the companion (${imgIds[0]}), the config references it`);
ok(JSON.stringify(card0).length < 20000, `the dashboard config stays small (${JSON.stringify(card0).length} chars)`);
ok(!(await m.card(`!!plan.shadowRoot.querySelector('svg.plan .trace')`)), 'the card does not show the picture (editor only)');

// show it on the card too
await openEditor(m);
await click(m, '[data-panel="trace"]');
await wait(500);
ok(await ed(m, `!!ed.plan.shadowRoot.querySelector('svg.plan .trace image')`), 'opened again: the stored picture is loaded from the companion');
await click(m, '[data-trace="hide"]');
await wait(100);
ok(!(await ed(m, `!!ed.plan.shadowRoot.querySelector('svg.plan .trace')`)), '"hide in the editor" hides it');
await click(m, '[data-trace="hide"]');
await click(m, '[data-trace="show"]');
await click(m, '.save');
await wait(1500);
ok(await m.card(`(plan.shadowRoot.querySelector('svg.plan .trace image')?.getAttribute('href') ?? '').startsWith('data:image/jpeg')`), 'chosen: the card shows it under the plan');
await page.screenshot({ path: `${out}/trace-card.png` });

// remove: gone from the config and from the companion
await openEditor(m);
await click(m, '[data-panel="trace"]');
await wait(300);
await click(m, '[data-trace-remove]');
await click(m, '.save');
await wait(1200);
fake = await m.fake();
ok(!fake.dash.views[0].cards[0].floors[0].trace && !Object.keys(fake.images).length, 'removed: config and stored picture gone');
ok(m.errors.length === 0, `no console errors (${m.errors.slice(0, 3).join(' | ')})`);
await m.browser.close();

// ---------- without the companion: small, right in the config ----------
const n = await openMock({ config, size: '1100x800', fake: { companion: false } });
await openEditor(n);
await click(n, '[data-panel="trace"]');
await wait(200);
ok(/Kartenkonfiguration/.test(await ed(n, `ed.shadowRoot.querySelector('.panel-body').textContent`)), 'says where the picture will be kept');
await loadFile(n, await makePicture(n.page, 2000, 1500, join(out, 'plan-mid.png')));
await click(n, '.save');
await wait(1200);
const cfg2 = (await n.fake()).dash.views[0].cards[0];
const src = cfg2.floors[0].trace?.src ?? '';
ok(src.startsWith('data:image/jpeg') && src.length <= 250_000 && !cfg2.floors[0].trace.image, `kept in the config, small (${Math.round(src.length / 1024)} KB)`);
ok(n.errors.length === 0, `no console errors (${n.errors.slice(0, 3).join(' | ')})`);
await n.browser.close();

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
