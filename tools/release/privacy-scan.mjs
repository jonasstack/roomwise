// Privacy scan: fails when the repository (or an exported tree) contains things that must never be public –
// LAN addresses, absolute home folders, e-mail addresses, access tokens, real device ids, work notes, and the
// private words of the maintainer (names, places …).
//
//   node tools/release/privacy-scan.mjs            scan the files git knows about (tracked + untracked, not ignored)
//   node tools/release/privacy-scan.mjs <dir>      scan every file below <dir> (used by export.mjs on the exported tree)
//   --export                                       stricter: owner tooling (.claude/, CLAUDE.md) must not be there either
//
// The private words are never stored in the repository. They come from, in this order:
//   ROOMWISE_DENYLIST       environment variable, words separated by newlines or commas (a CI secret)
//   ROOMWISE_DENYLIST_FILE  path to a text file, one word per line
//   ../roomwise-dev/denylist.txt next to the repository (the maintainer's local file)
// One entry per line; `#` starts a comment; `re:<regex>` adds a regular expression instead of a plain word.
// A line that really needs one of the matches can carry the marker `privacy-scan: allow`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** rules that are safe to publish (they contain no private data themselves) */
export const RULES = [
  { id: 'lan-ip', re: /\b(?:192\.168|10\.(?:\d{1,3})|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, why: 'private LAN address' },
  { id: 'cgnat-ip', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, why: 'CGNAT / Tailscale address' },
  { id: 'home-path', re: /(?:\/home\/[a-z_][a-z0-9_-]*\/|\/Users\/[A-Za-z][\w.-]*\/|[A-Z]:\\Users\\[^\\\s]+)/g, why: 'absolute home folder' },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, why: 'e-mail address', allow: /^(?:noreply@anthropic\.com|[^@]+@example\.(?:com|org|net)|[^@]+@beispiel\.(?:de|com)|[^@]+@users\.noreply\.github\.com|git@github\.com)$/i },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, why: 'token (JWT, e.g. a Home Assistant long-lived token)' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/g, why: 'GitHub token' },
  { id: 'api-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/g, why: 'API key' },
  { id: 'telegram-bot-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, why: 'Telegram bot token' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, why: 'private key' },
  // real devices carry the end of their MAC address in the entity id (light.wiz_rgbw_tunable_a1b2c3)  privacy-scan: allow
  { id: 'device-mac-id', re: /\b(?:light|switch|sensor|binary_sensor|climate|fan|cover|media_player|vacuum|lock|camera|button|select|number)\.[a-z0-9_]*_(?=[a-f]*\d)(?=\d*[a-f])[0-9a-f]{6}\b/g, why: 'entity id of a real device (MAC suffix)' },
  { id: 'phone-number', re: /(?<![\w.])\+\d{2}[ -]?\d{2,4}[ -]?\d{4,}\b/g, why: 'phone number', allow: /123456|0000|555/ },
];

/** files and folders that must not exist at all */
const FORBIDDEN_PATHS = [
  [/(^|\/)FORTSCHRITT\.md$/, 'work notes'],
  [/(^|\/)PLAN\.md$/, 'work notes'],
  [/(^|\/)\.env(\..*)?$/, 'secrets file'],
  [/(^|\/)set-token\.sh$/, 'token helper'],
  [/(^|\/)\.cache\//, 'local cache'],
  [/\.cache$/, 'local cache'],
  [/(^|\/)screenshots\/tmp\//, 'temporary screenshots'],
];
const EXPORT_ONLY_PATHS = [
  [/^\.claude\//, 'owner tooling'],
  [/^CLAUDE\.md$/, 'owner tooling'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|mp3|wav|ogg|zip|gz|woff2?|ttf|pdf)$/i;
// bundled third-party code carries authors' e-mail addresses in its license headers
const BUNDLES = /(^|\/)(frontend\/floorplan-card\.js|frontend\/house-rules-panel\.js)$/;

/** the main checkout when running in a git worktree (the local word list lives next to it) */
function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(common);
  } catch {
    return null;
  }
}

export function loadPrivateWords(root = ROOT) {
  const raw = [];
  if (process.env.ROOMWISE_DENYLIST) raw.push(...process.env.ROOMWISE_DENYLIST.split(/[\n,]/));
  const file = process.env.ROOMWISE_DENYLIST_FILE || [root, mainCheckout(root)].filter(Boolean).map((r) => join(r, '..', 'roomwise-dev', 'denylist.txt')).find((p) => existsSync(p));
  if (file && existsSync(file)) raw.push(...readFileSync(file, 'utf8').split('\n'));
  const words = [];
  for (let line of raw) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('re:')) words.push(new RegExp(line.slice(3), 'gi'));
    else words.push(new RegExp(`(?<![\\p{L}\\p{N}])${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'));
  }
  return words;
}

function listFiles(dir) {
  if (!dir) {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    return { base: ROOT, files: [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()) };
  }
  const base = resolve(dir);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile()) files.push(relative(base, join(d, e.name)).split(sep).join('/'));
    }
  };
  walk(base);
  return { base, files };
}

const mask = (s) => (s.length <= 2 ? '**' : s[0] + '*'.repeat(Math.min(s.length - 1, 8)));

/** returns a list of findings { file, line, rule, text } */
export function scan({ dir, exportMode = false, words = loadPrivateWords() } = {}) {
  const { base, files } = listFiles(dir);
  const findings = [];
  for (const f of files) {
    for (const [re, why] of [...FORBIDDEN_PATHS, ...(exportMode ? EXPORT_ONLY_PATHS : [])]) if (re.test(f)) findings.push({ file: f, line: 0, rule: 'path', text: why });
    if (BINARY.test(f)) {
      // binaries can't be read for text, but their names can still give things away
      for (const w of words) for (const m of f.matchAll(w)) findings.push({ file: f, line: 0, rule: 'private-word', text: mask(m[0]) });
      continue;
    }
    const buf = readFileSync(join(base, f));
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    const bundle = BUNDLES.test(f);
    lines.forEach((line, i) => {
      if (line.includes('privacy-scan: allow')) return;
      for (const r of RULES) {
        if (bundle && (r.id === 'email' || r.id === 'phone-number')) continue;
        for (const m of line.matchAll(r.re)) {
          if (r.allow && r.allow.test(m[0])) continue;
          findings.push({ file: f, line: i + 1, rule: r.id, text: `${r.why}: ${m[0].slice(0, 60)}` });
        }
      }
      for (const w of words) for (const m of line.matchAll(w)) findings.push({ file: f, line: i + 1, rule: 'private-word', text: mask(m[0]) });
    });
    for (const w of words) for (const m of f.matchAll(w)) findings.push({ file: f, line: 0, rule: 'private-word', text: `in file name: ${mask(m[0])}` });
  }
  return { findings, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const exportMode = args.includes('--export');
  const dir = args.find((a) => !a.startsWith('--'));
  const words = loadPrivateWords();
  const { findings, files } = scan({ dir, exportMode, words });
  for (const x of findings) console.log(`${x.file}${x.line ? ':' + x.line : ''}  [${x.rule}]  ${x.text}`);
  console.log(`privacy scan: ${files} files, ${words.length} private words, ${findings.length} finding(s)`);
  if (!words.length) console.log('note: no private word list found (ROOMWISE_DENYLIST, ROOMWISE_DENYLIST_FILE or ../roomwise-dev/denylist.txt) – only the generic rules ran');
  process.exit(findings.length ? 1 : 0);
}
