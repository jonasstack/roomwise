// Checks the built bundles against the supported browsers (tools/browsers.mjs), for CI and before a release:
//   node tools/compat-check.mjs [files…]   (default: the card with its chunks and the Hausregeln panel; build them first)
// 1. Syntax: esbuild lowers the bundle for the target again — any change beyond whitespace means syntax newer than
//    the browsers slipped in (e.g. a dependency that bypassed the build target).
// 2. Platform features (CSS, browser APIs) newer than the browsers, unless guarded, ignorable or in a rule of their own.
import * as esbuild from 'esbuild';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { BROWSERS, FEATURES, TARGET } from './browsers.mjs';

// the card is an entry plus lazily loaded chunks (tools/build.mjs): all of them
const chunks = existsSync('dist/chunks') ? readdirSync('dist/chunks').filter((f) => f.endsWith('.js')).map((f) => `dist/chunks/${f}`) : [];
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['dist/floorplan-card.js', ...chunks, 'hausregeln/dist/house-rules-panel.js'];
let fail = 0;
const tooNew = (f) => f.chrome > BROWSERS.chrome || f.firefox > BROWSERS.firefox || f.safari > BROWSERS.safari;
for (const file of files) {
  if (!existsSync(file)) {
    console.log(`• FAIL: ${file} missing (build first)`);
    fail++;
    continue;
  }
  const code = readFileSync(file, 'utf8');
  // 1. syntax
  const strip = (s) => s.replace(/\s+/g, '');
  const once = (await esbuild.transform(code, { target: TARGET, minify: true, format: 'esm', legalComments: 'none' })).code;
  const lowered = (await esbuild.transform(code, { target: 'esnext', minify: true, format: 'esm', legalComments: 'none' })).code;
  if (strip(once) !== strip(lowered)) {
    console.log(`• FAIL: ${file}: syntax newer than ${TARGET.join(', ')} (esbuild had to lower it)`);
    fail++;
  } else console.log(`  ok: ${file}: syntax fits ${TARGET.join(', ')}`);
  // 2. platform features
  for (const f of FEATURES) {
    if (!tooNew(f) || f.ignorable) continue;
    const re = new RegExp(f.re.source, 'g');
    for (const m of code.matchAll(re)) {
      const around = code.slice(Math.max(0, m.index - 200), m.index + 200);
      if (f.guard && f.guard.test(around)) continue;
      if (f.ownRule) {
        // the selector list of this rule: from the last '}' or '{' before it up to the next '{'
        const start = Math.max(code.lastIndexOf('}', m.index), code.lastIndexOf('{', m.index)) + 1;
        const sel = code.slice(start, code.indexOf('{', m.index));
        if (!sel.includes(',')) continue;
      }
      const where = code.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ');
      console.log(`• FAIL: ${file}: ${f.name} (Chrome ${f.chrome}, Safari ${f.safari}, Firefox ${f.firefox}) … ${where} …`);
      fail++;
    }
  }
}
console.log(fail ? `${fail} problem(s)` : `all bundles fit Chrome/Edge ${BROWSERS.chrome}+, Safari ${BROWSERS.safari}+, Firefox ${BROWSERS.firefox}+`);
process.exit(fail ? 1 : 0);
