// The card on a standalone page (no Home Assistant, a neutral demo plan): screenshots of the card in 2D and 3D,
// popups and the editor, across sizes, themes and languages — in any engine. Nothing reaches a real home.
//   node tools/look/card.mjs <outdir>       PW_ENGINE=chromium|firefox|webkit, PW_DPR=2, PW_NOGL=1 (no WebGL)
//   SIZES=390x844,1280x800  THEMES=light,dark,tinted  LANGS=de,en  SHOTS=card2d,card3d,room,light,climate,media,editor
//   MOTION=reduce, FONT=130 (root font size in %), TOUCH=1
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { launch } from '../pw.mjs';
import { CONFIG } from './harness/demo-config.mjs';

const out = process.argv[2] ?? 'card-shots';
mkdirSync(out, { recursive: true });
const js = (await esbuild.build({ entryPoints: ['tools/look/harness/card-entry.ts'], bundle: true, format: 'esm', write: false, logLevel: 'error', nodePaths: ['hausregeln/node_modules'], define: { __VERSION__: '"dev"' } })).outputFiles[0].text;


const SIZES = (process.env.SIZES ?? '390x844,1024x600,1280x800,1920x1080').split(',');
const THEMES = (process.env.THEMES ?? 'light,dark,tinted').split(',');
const LANGS = (process.env.LANGS ?? 'de,en').split(',');
const SHOTS = (process.env.SHOTS ?? 'card2d,card3d,room,light,climate,media,editor').split(',');
const browser = await launch();
const problems = [];
for (const size of SIZES) {
  const [width, height] = size.split('x').map(Number);
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(process.env.PW_DPR ?? 1), colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: process.env.MOTION === 'reduce' ? 'reduce' : 'no-preference', hasTouch: !!process.env.TOUCH });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror ' + e.message + (process.env.STACK ? ' ' + e.stack : '')));
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
      await page.route('http://fp.local/**', (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === '/') return r.fulfill({ contentType: 'text/html', body: `<!doctype html><html style="font-size:${process.env.FONT ?? 100}%"><meta name="viewport" content="width=device-width"><body style="margin:0;font-family:Roboto,system-ui,sans-serif"><div id="host"></div><script type="module" src="/s.js"></script>` });
        if (p === '/s.js') return r.fulfill({ contentType: 'text/javascript', body: js });
        if (p.startsWith('/models/')) return r.fulfill({ contentType: 'model/gltf-binary', body: readFileSync('.' + p) });
        r.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://fp.local/');
      await page.waitForFunction(() => window.mountCard);
      const tag = `${size}-${theme}-${lang}`;
      const card = (e) => page.evaluate(`(() => { const card = document.querySelector('floorplan-card'); return ${e}; })()`);
      const shot = async (name) => {
        await page.screenshot({ path: `${out}/${name}-${tag}.png` });
      };
      for (const s of SHOTS) {
        const cfg = { ...CONFIG, view_mode: s === 'card3d' ? '3d' : '2d' };
        if (s === 'card2d' || s === 'card3d' || !(await card('!!card'))) {
          await page.evaluate((o) => window.mountCard(o), { config: cfg, theme, lang, lightsOn: true });
          await page.waitForTimeout(s === 'card3d' ? 4000 : 1500);
        }
        if (s === 'card2d' || s === 'card3d') await shot(s);
        else if (s === 'editor') {
          await card(`(card.openEditor(), true)`);
          await page.waitForTimeout(2500);
          await shot('editor');
          await page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('floorplan-card-editor-ui'); ed?.select?.({ kind: 'furniture', id: 'dog' }); return true; })()`);
          await page.waitForTimeout(2000);
          await shot('editor-dog');
          await page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('floorplan-card-editor-ui'); ed?.select?.({ kind: 'room', id: 'room_living' }); return true; })()`);
          await page.waitForTimeout(1200);
          await shot('editor-room');
          await page.keyboard.press('Escape');
        } else {
          const target = { room: `{ room: card._config.floors[0].rooms[0] }`, light: `{ entity: 'light.living_room_floor_lamp' }`, climate: `{ entity: 'climate.living_room' }`, media: `{ entity: 'media_player.living_room_tv' }` }[s];
          if (!target) continue;
          await card(`(card.ensureLayer().openPopup(${target}), true)`);
          await page.waitForTimeout(1200);
          await shot('popup-' + s);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }
      }
      if (errors.length) problems.push(`${tag}: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
      await ctx.close();
    }
  }
}
console.log(problems.length ? problems.join('\n') : 'page: no errors');
await browser.close();
