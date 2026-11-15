// Shows or sets the version of every part of roomwise at once (card, companion integration, Hausregeln).
//   node tools/release/version.mjs              print all versions, exit 1 if they differ
//   node tools/release/version.mjs 0.1.0-beta.3
//   node tools/release/version.mjs --bump       next pre-release: 0.1.0-beta.2 -> 0.1.0-beta.3
// When both integrations become the single `roomwise` integration, drop the entries that no longer exist below.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** every place a version lives: [file, read(text) -> version, write(text, version) -> text] */
const json = (key = 'version') => [
  (t) => JSON.parse(t)[key],
  (t, v) => t.replace(new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`), `$1"${v}"`),
];
const pyConst = [
  (t) => t.match(/^VERSION = "([^"]*)"/m)?.[1],
  (t, v) => t.replace(/^VERSION = "[^"]*"/m, `VERSION = "${v}"`),
];
export const FILES = [
  ['package.json', ...json()],
  ['custom_components/roomwise/manifest.json', ...json()],
  ['custom_components/roomwise/const.py', ...pyConst],
  ['hausregeln/package.json', ...json()],
];
// package-lock.json files carry the version twice (root and packages[""])
const LOCKS = ['package-lock.json', 'hausregeln/package-lock.json'];

export function readVersions() {
  return FILES.filter(([f]) => existsSync(join(ROOT, f))).map(([f, read]) => [f, read(readFileSync(join(ROOT, f), 'utf8'))]);
}

const VALID = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

function setAll(v) {
  if (!VALID.test(v)) throw new Error(`not a version like 0.1.0-alpha.2: ${v}`);
  for (const [f, , write] of FILES) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    writeFileSync(p, write(readFileSync(p, 'utf8'), v));
  }
  for (const f of LOCKS) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const lock = JSON.parse(readFileSync(p, 'utf8'));
    lock.version = v;
    if (lock.packages?.['']) lock.packages[''].version = v;
    writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
  }
}

function next(v) {
  const m = v.match(/^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/);
  if (!m) throw new Error(`--bump only counts up pre-releases (${v}); pass the new version instead`);
  return `${m[1]}-${m[2]}.${Number(m[3]) + 1}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const now = readVersions();
  const distinct = [...new Set(now.map(([, v]) => v))];
  if (!arg) {
    for (const [f, v] of now) console.log(`${v.padEnd(16)} ${f}`);
    if (distinct.length > 1) {
      console.log('versions differ – set them with: node tools/release/version.mjs <version>');
      process.exit(1);
    }
    process.exit(0);
  }
  if (arg === '--bump' && distinct.length > 1) {
    console.error('versions differ; set one explicitly first');
    process.exit(1);
  }
  const v = arg === '--bump' ? next(distinct[0]) : arg;
  setAll(v);
  for (const [f, val] of readVersions()) console.log(`${val.padEnd(16)} ${f}`);
}
