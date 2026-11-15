// Bundles src/floorplan-card.ts into dist/: the entry dist/floorplan-card.js (name never changes, dashboards and
// the companion's loader point at it) plus lazily loaded ES module chunks in dist/chunks/ (editor, 3D, rare popups),
// so a wall tablet only parses what the plan needs to appear.
//   node tools/build.mjs            entry + chunks, copied into custom_components/floorplan_card/frontend/
//   node tools/build.mjs --single   one self-contained file dist/single/floorplan-card.js (card-only manual install)
//   node tools/build.mjs --watch    rebuild on change (dist/ only)
import * as esbuild from 'esbuild';
import { TARGET } from './browsers.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const single = process.argv.includes('--single');
export const options = {
  entryPoints: ['src/floorplan-card.ts'],
  bundle: true,
  format: 'esm',
  target: TARGET, // the supported browsers (tools/browsers.mjs)
  minify: !process.argv.includes('--dev'),
  sourcemap: false,
  legalComments: 'eof', // keeps the lit (BSD-3-Clause) and three.js (MIT) notices the licenses ask for
  // chunks are named by content: a changed chunk gets a new name, so no browser keeps a stale one
  ...(single ? { outfile: 'dist/single/floorplan-card.js' } : { splitting: true, outdir: 'dist', entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]' }),
  define: { __VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
};

/**
 * Puts the new chunks next to a card copy. Chunks of earlier builds stay a few days: a wall tablet that kept the page
 * open still holds the old entry and loads its chunks (3D scene, car popup …) by their old names — removing them at
 * once left it with the simpler CSS 3D view until somebody reloaded the page.
 */
export function syncChunks(dst, keepDays = 3) {
  mkdirSync(dst, { recursive: true });
  const fresh = new Set(existsSync('dist/chunks') ? readdirSync('dist/chunks') : []);
  for (const name of readdirSync(dst)) {
    if (fresh.has(name)) continue;
    try {
      if (Date.now() - statSync(`${dst}/${name}`).mtimeMs > keepDays * 86400000) rmSync(`${dst}/${name}`, { force: true });
    } catch {
      /* gone meanwhile */
    }
  }
  if (fresh.size) cpSync('dist/chunks', dst, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // chunks of earlier builds would pile up otherwise
  if (!single) rmSync('dist/chunks', { recursive: true, force: true });
  if (process.argv.includes('--watch')) {
    await (await esbuild.context(options)).watch();
  } else {
    await esbuild.build(options);
  }
  // 3D models (CC0) ship next to the script
  if (existsSync('models')) cpSync('models', 'dist/models', { recursive: true });
  // the HACS package (integration) carries the card, its chunks and its models: custom_components/floorplan_card/frontend
  const FE = 'custom_components/floorplan_card/frontend';
  if (!process.argv.includes('--watch') && !single) {
    mkdirSync(FE, { recursive: true });
    copyFileSync('dist/floorplan-card.js', `${FE}/floorplan-card.js`);
    syncChunks(`${FE}/chunks`);
    if (existsSync('models')) cpSync('models', `${FE}/models`, { recursive: true });
  }
}
