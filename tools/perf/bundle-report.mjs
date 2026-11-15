// What the card bundle is made of: size per output file (entry and lazy chunks) and per source group.
// Usage: node tools/perf/bundle-report.mjs [--json]   (builds in memory, writes nothing)
import * as esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';
import { options } from '../build.mjs';

const r = await esbuild.build({ ...options, write: false, metafile: true, logLevel: 'silent' });
const files = r.outputFiles.filter((f) => f.path.endsWith('.js'));
const gz = Object.fromEntries(files.map((f) => [f.path, gzipSync(f.contents).length]));
const group = (k) => {
  k = k.replace(/^.*node_modules\//, 'node_modules/'); // node_modules may be a link to another checkout
  if (k.startsWith('node_modules/three/examples')) return 'three/examples';
  if (k.startsWith('node_modules/')) return k.split('/')[1];
  const p = k.replace(/^src\//, '').split('/');
  return p.length > 1 ? p[0] + '/' : 'src/*';
};
const outputs = [];
for (const [path, out] of Object.entries(r.metafile.outputs)) {
  if (!path.endsWith('.js')) continue;
  const groups = {};
  for (const [k, v] of Object.entries(out.inputs)) groups[group(k)] = (groups[group(k)] ?? 0) + v.bytesInOutput;
  const abs = files.find((f) => f.path.endsWith(path))?.path;
  outputs.push({ file: path.replace(/^.*\//, ''), entry: !!out.entryPoint, bytes: out.bytes, gzip: abs ? gz[abs] : 0, groups });
}
outputs.sort((a, b) => Number(b.entry) - Number(a.entry) || b.bytes - a.bytes);
// what a dashboard loads before the card can draw: the entry and everything it imports statically
const start = new Set();
const walk = (path) => {
  if (start.has(path)) return;
  start.add(path);
  for (const i of r.metafile.outputs[path].imports) if (i.kind === 'import-statement') walk(i.path);
};
walk(Object.keys(r.metafile.outputs).find((p) => p.endsWith('/floorplan-card.js') || p === 'dist/floorplan-card.js'));
const startup = outputs.filter((o) => [...start].some((p) => p.endsWith('/' + o.file)));
const summary = { startupFiles: startup.length, startupBytes: startup.reduce((a, o) => a + o.bytes, 0), startupGzip: startup.reduce((a, o) => a + o.gzip, 0), totalBytes: outputs.reduce((a, o) => a + o.bytes, 0) };
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...summary, outputs }));
else {
  const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';
  for (const o of outputs) {
    console.log(`${startup.includes(o) ? 'START' : o.entry ? 'lazy ' : 'chunk'} ${o.file.padEnd(40)} ${kb(o.bytes)}  (gzip ${kb(o.gzip)})`);
    for (const [g, b] of Object.entries(o.groups).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`        ${g.padEnd(24)} ${kb(b)}`);
  }
  console.log(`at start: ${summary.startupFiles} files, ${kb(summary.startupBytes)} (gzip ${kb(summary.startupGzip)}); everything: ${kb(summary.totalBytes)}`);
}
