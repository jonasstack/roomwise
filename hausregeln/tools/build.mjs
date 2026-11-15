// Bundles the panel (dist/house-rules-panel.js) and a self-contained preview page with example data
// (dist/preview.html, no <html>/<head>: it is published as an artifact and wrapped there).
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TARGET } from '../../tools/browsers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
mkdirSync('dist', { recursive: true });
const result = await esbuild.build({
  entryPoints: ['src/panel.ts'],
  bundle: true,
  format: 'esm',
  target: TARGET, // the supported browsers (tools/browsers.mjs at the repository root)
  minify: !process.argv.includes('--dev'),
  legalComments: 'eof', // keeps the Lit (BSD-3-Clause) notices the license asks for
  outfile: 'dist/house-rules-panel.js',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: 'info',
});
const js = readFileSync('dist/house-rules-panel.js', 'utf8').replace(/<\/script/gi, '<\\/script');

const preview = `<title>Hausregeln</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
  :root { --page: #f2f2f7; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #000000; color-scheme: dark; } }
  :root[data-theme="dark"] { --page: #000000; color-scheme: dark; }
  html, body { min-height: 100%; }
  body { margin: 0; background: var(--page); }
  house-rules-panel { display: block; min-height: 100vh; }
</style>
<house-rules-panel></house-rules-panel>
<script type="module">
${js}
const el = document.querySelector('house-rules-panel');
const mq = matchMedia('(prefers-color-scheme: dark)');
const apply = () => {
  const t = document.documentElement.dataset.theme;
  el.toggleAttribute('dark', t === 'dark' || (t !== 'light' && mq.matches));
};
apply();
mq.addEventListener('change', apply);
new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
</script>
`;
writeFileSync('dist/preview.html', preview);
console.log(`preview: ${(preview.length / 1024).toFixed(0)} KB`);

// The vocabulary (kinds, verbs, German labels) for the integration and for other frontends
// (floorplan card, language model prompt): ../custom_components/roomwise/house_rules/vocabulary.json
const vocab = await esbuild.build({ entryPoints: ['src/vocabulary.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const mod = await import('data:text/javascript;base64,' + Buffer.from(vocab.outputFiles[0].text).toString('base64'));
writeFileSync(
  '../custom_components/roomwise/house_rules/vocabulary.json',
  // German words in kinds/modes/phrases.de (the base), English words under "en" and in phrases.en (same ids, only the texts)
  JSON.stringify({ kinds: mod.KINDS, modes: mod.MODES, phrases: mod.PHRASES, en: { kinds: mod.EN_KINDS, modes: mod.EN_MODES } }, null, 1),
);
// the integration serves the panel
const { copyFileSync } = await import('node:fs');
mkdirSync('../custom_components/roomwise/house_rules/frontend', { recursive: true }); // the built bundle is not in git
copyFileSync('dist/house-rules-panel.js', '../custom_components/roomwise/house_rules/frontend/house-rules-panel.js');
