// Release export: builds everything, runs the quick checks and writes a clean copy of the repository (no git
// history, no owner tooling) into a separate folder that is its own git repository – the public one.
//
//   node tools/release/export.mjs [target] [options]
//     target              default: ../roomwise-public (next to this repository)
//     --owner <name>      GitHub account of the public repository: replaces the OWNER placeholder in links
//     --maintainer <text> name shown in the README's development note (replaces jonasstack; default: --owner)
//     --copyright <text>  copyright holder written into LICENSE (default: as in LICENSE)
//     --skip-build        use the bundles as they are
//     --skip-checks       no typecheck / translation / version / Python checks (the privacy scan always runs)
//     --dry-run           build, check and scan, but don't touch the target
//
// The target keeps its own .git and every file the export did not write; files written by an earlier export that
// no longer exist are removed (the list lives in .roomwise-export.json in the target). Nothing is committed or
// pushed – that stays a manual step after a look at `git diff` in the target.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './privacy-scan.mjs';
import { readVersions } from './version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
const valued = new Set(['--owner', '--copyright', '--maintainer']);
const target = resolve(args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? join(ROOT, '..', 'roomwise-public'));
const owner = opt('--owner');
const copyright = opt('--copyright');
const maintainer = opt('--maintainer') ?? owner;

/** paths (relative, forward slashes) that never go public */
const EXCLUDE = [
  /^\.claude\//, // the maintainer's documentation tooling
  /^CLAUDE\.md$/,
  /^docs\/doku\//, // internal technical documentation (rewritten for the public later)
  /(^|\/)FORTSCHRITT\.md$/,
  /(^|\/)PLAN\.md$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)set-token\.sh$/,
  /(^|\/)\.cache\//,
  /\.cache$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)__pycache__\//,
  /(^|\/)screenshots\/tmp\//,
];
/** built files that git doesn't know about but the export carries (fresh from the build) */
const BUILT = [
  'custom_components/floorplan_card/frontend',
  'hausregeln/custom_components/house_rules/frontend/house-rules-panel.js',
];

const run = (cmd, argv, cwd = ROOT) => {
  console.log(`$ ${[cmd, ...argv].join(' ')}${cwd !== ROOT ? `   (in ${relative(ROOT, cwd)})` : ''}`);
  execFileSync(cmd, argv, { cwd, stdio: 'inherit' });
};
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// --- safety: never export into this repository or one of its folders
const rel = relative(ROOT, target);
if (!rel || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))) {
  console.error(`target ${target} is inside the repository – pick a folder outside`);
  process.exit(1);
}

// --- 1. build
if (!flag('--skip-build')) {
  run('node', ['tools/build.mjs']);
  run('node', ['tools/build.mjs'], join(ROOT, 'hausregeln'));
}

// --- 2. quick checks
if (!flag('--skip-checks')) {
  const versions = [...new Set(readVersions().map(([, v]) => v))];
  if (versions.length !== 1) {
    console.error(`versions differ (${versions.join(', ')}) – node tools/release/version.mjs <version>`);
    process.exit(1);
  }
  run('npx', ['tsc', '-p', '.']);
  run('npx', ['tsc', '-p', '.'], join(ROOT, 'hausregeln'));
  run('node', ['tools/tests/i18n.mjs', '--strict']);
  run('python3', ['-m', 'compileall', '-q', 'custom_components', 'hausregeln/custom_components']);
  run('python3', ['hausregeln/tools/testha/test_webauthn.py']);
  if (has('ruff')) run('ruff', ['check', 'custom_components', 'hausregeln/custom_components']);
  else console.log('(ruff not installed – Python lint runs in CI)');
}

// --- 3. collect the files
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = new Set(tracked.filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()));
const walk = (p) => (statSync(join(ROOT, p)).isDirectory() ? readdirSync(join(ROOT, p)).flatMap((n) => walk(`${p}/${n}`)) : [p]);
for (const b of BUILT) if (existsSync(join(ROOT, b))) for (const f of walk(b)) files.add(f);
const list = [...files].filter((f) => !EXCLUDE.some((re) => re.test(f))).sort();

// --- 4. stage, rewrite placeholders, scan
const stage = mkdtempSync(join(tmpdir(), 'roomwise-export-'));
const TEXT = /\.(md|json|ya?ml|py|mjs|js|ts|txt|toml|cfg|sh|html|css|svg)$|(^|\/)(LICENSE|CODEOWNERS)$/;
for (const f of list) {
  const dst = join(stage, f);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(ROOT, f), dst);
  if (!TEXT.test(f)) continue;
  let t = readFileSync(dst, 'utf8');
  const before = t;
  if (owner) t = t.replaceAll('jonasstack/roomwise', `${owner}/roomwise`).replaceAll('github.com/jonasstack', `github.com/${owner}`).replaceAll('"@jonasstack"', `"@${owner}"`);
  if (maintainer) t = t.replaceAll('jonasstack', maintainer);
  if (copyright && f === 'LICENSE') t = t.replace(/^Copyright \(c\) .*$/m, `Copyright (c) ${new Date().getFullYear()} ${copyright}`);
  if (t !== before) writeFileSync(dst, t);
}
const { findings } = scan({ dir: stage, exportMode: true });
if (findings.length) {
  for (const x of findings) console.log(`${x.file}${x.line ? ':' + x.line : ''}  [${x.rule}]  ${x.text}`);
  console.error(`\nprivacy scan found ${findings.length} problem(s) – nothing was written to ${target}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
const left = list.filter((f) => TEXT.test(f) && /OWNER\/roomwise|github\.com\/OWNER|"@jonasstack"|jonasstack/.test(readFileSync(join(stage, f), 'utf8')));
if (left.length) console.log(`note: placeholders left (pass --owner / --maintainer): ${left.join(', ')}`);
console.log(`staged ${list.length} files, privacy scan clean`);

if (flag('--dry-run')) {
  console.log(`dry run: staged copy left in ${stage}`);
  process.exit(0);
}

// --- 5. sync into the target (keep .git and files the export didn't write)
mkdirSync(target, { recursive: true });
const MANIFEST = join(target, '.roomwise-export.json');
const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).files ?? [] : [];
if (!existsSync(MANIFEST) && readdirSync(target).some((n) => n !== '.git')) {
  if (!flag('--force')) {
    console.error(`${target} already has files that no export wrote – run with --force to write into it anyway`);
    process.exit(1);
  }
}
const now = new Set(list);
for (const f of previous) if (!now.has(f) && existsSync(join(target, f))) rmSync(join(target, f));
for (const f of list) {
  mkdirSync(dirname(join(target, f)), { recursive: true });
  cpSync(join(stage, f), join(target, f));
}
// remove folders the stale files left empty
const prune = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git') prune(join(d, e.name));
  if (d !== target && !readdirSync(d).length) rmSync(d, { recursive: true });
};
prune(target);
writeFileSync(MANIFEST, JSON.stringify({ note: 'written by tools/release/export.mjs', version: readVersions()[0]?.[1], files: list }, null, 2) + '\n');
rmSync(stage, { recursive: true, force: true });
console.log(`\nexported ${list.length} files to ${target}`);
console.log(existsSync(join(target, '.git')) ? `next: cd ${target} && git status && git add -A && git commit` : `next: cd ${target} && git init && git add -A && git commit`);
