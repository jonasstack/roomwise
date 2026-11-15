// i18n completeness check (pure node, no browser, no Home Assistant).
//   node tools/tests/i18n.mjs            report
//   node tools/tests/i18n.mjs --strict   exit code 1 on missing keys / missing translations / unknown t() keys
//   node tools/tests/i18n.mjs --all      also list every hard-coded string candidate (default: first 400)
//
// Checks
//  1. German (`de`, the base dictionary, src/i18n.ts) and English (`en`, src/i18n-en.ts) have the same keys
//     (English is a Partial: a missing English key silently falls back to German on English systems)
//  2. keys used via t('…') that do not exist
//  3. keys that are never used (neither t('…') nor any string literal in src/, nor covered by a dynamic t(`prefix${…}`))
//  4. user-visible hard-coded text in Lit templates (text nodes, title/placeholder/aria-label/label/… attributes)
//     and string literals with German umlauts outside i18n.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const strict = process.argv.includes('--strict');
const all = process.argv.includes('--all');

// ---------- dictionaries ----------
// German in src/i18n.ts, English (loaded on demand) in src/i18n-en.ts
const i18nSrc = readFileSync(join(SRC, 'i18n.ts'), 'utf8') + '\n' + readFileSync(join(SRC, 'i18n-en.ts'), 'utf8');

function objectLiteral(startRe) {
  const m = startRe.exec(i18nSrc);
  if (!m) throw new Error(`dictionary not found: ${startRe}`);
  let i = m.index + m[0].length - 1; // at '{'
  const start = i;
  let depth = 0, q = null;
  for (; i < i18nSrc.length; i++) {
    const c = i18nSrc[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  const body = i18nSrc.slice(start, i + 1);
  // the literals hold plain strings only; evaluate them instead of parsing by hand
  return { obj: new Function(`return (${body});`)(), offset: start };
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

const { obj: de } = objectLiteral(/const de\s*=\s*\{/);
const { obj: en } = objectLiteral(/const en\b[^=]*=\s*\{/);
const deKeys = new Set(Object.keys(de));
const enKeys = new Set(Object.keys(en));

// duplicates inside one literal (the evaluated object hides them)
function duplicates(re) {
  const m = re.exec(i18nSrc);
  const from = m.index;
  const to = i18nSrc.indexOf('\n};', from);
  const seen = new Map(), dups = [];
  for (const k of i18nSrc.slice(from, to).matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)) {
    if (seen.has(k[1])) dups.push(k[1]);
    seen.set(k[1], true);
  }
  return dups;
}
const dupDe = duplicates(/const de\s*=\s*\{/);
const dupEn = duplicates(/const en\b[^=]*=\s*\{/);

const missingEn = [...deKeys].filter((k) => !enKeys.has(k));
const extraEn = [...enKeys].filter((k) => !deKeys.has(k));
// English entries that are just the German text (copied, never translated) — only flag texts with umlauts/ß
const untranslatedEn = [...enKeys].filter((k) => en[k] === de[k] && /[äöüÄÖÜß]/.test(en[k]));
// placeholders must match: '{n} an' ↔ '{n} on'
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const varMismatch = [...enKeys].filter((k) => deKeys.has(k) && vars(de[k]) !== vars(en[k]));

// ---------- sources ----------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC).filter((f) => !f.endsWith('i18n.ts') && !f.endsWith('i18n-en.ts'));
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// strip comments but keep offsets (so line numbers stay right)
function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    out += c;
    i++;
  }
  return out;
}
const clean = new Map([...sources].map(([f, s]) => [f, stripComments(s)]));

// ---------- key usage ----------
const used = new Map(); // key → first "file:line"
const unknown = []; // t('x') with x not a key
const prefixes = new Set(); // t(`hr.mode_${…}`) / t('domain.' + d)
const literals = new Set(); // every string literal that looks like a key
for (const [f, src] of clean) {
  const rel = relative(ROOT, f);
  for (const m of src.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
    const key = m[2];
    if (!deKeys.has(key)) unknown.push(`${rel}:${lineOf(src, m.index)}  t('${key}')`);
    if (!used.has(key)) used.set(key, `${rel}:${lineOf(src, m.index)}`);
  }
  for (const m of src.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*(['"])([^'"]+)\1\s*\+/g)) prefixes.add(m[2]);
  // `prefix.${x}` as I18nKey / as never anywhere (keys built elsewhere and passed to t later)
  for (const m of src.matchAll(/`([a-z_]+\.[\w.]*)\$\{[^`]*`\s*as\s+(?:I18nKey|never|Key)/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/(['"])([a-z][\w]*\.[\w.]+)\1/g)) literals.add(m[2]);
}
const covered = (k) => used.has(k) || literals.has(k) || [...prefixes].some((p) => p && k.startsWith(p));
const unused = [...deKeys].filter((k) => !covered(k));

// ---------- hard-coded strings ----------
// letters that make a text "words" (not 'px', '°', '%', '—', '×', icons, entity ids …)
const WORDY = /[A-Za-zÄÖÜäöüß]{2,}/;
const IGNORE_TEXT = /^(?:mdi:[\w-]+|[\w-]+\.[\w-]+|#[0-9a-f]{3,8}|(?:px|em|rem|vh|vw|ms|s|deg|rad|cm|m|km|kW|kWh|W|Wh|V|A|°C|°F|hPa|lx|ppm|µg\/m³|dB|bar|rpm|fps|FPS|GPU|CPU|WebGL|CSS|2D|3D|YAML|HACS|TTS|OK|PM2\.5|CO2|CO₂|ID|URL|HA)|[A-Z]{1,3}\d*)$/;
const ATTRS = ['title', 'placeholder', 'aria-label', 'label', 'heading', 'alt', 'helper', 'header', 'hint', 'tooltip', 'confirmText', 'text'];
const findings = []; // { file, line, kind, text }

function scanTemplate(rel, src, start, body) {
  // replace ${…} expressions (with nesting) by a marker; keep offsets
  let t = '', i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < body.length; j++) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}' && --depth === 0) break;
      }
      t += '\u0001'.repeat(j + 1 - i).replace(/[^\n]/g, '\u0001');
      i = j + 1;
      continue;
    }
    t += body[i];
    i++;
  }
  // <style> blocks and css`` are not text
  t = t.replace(/<style[\s\S]*?<\/style>/g, (s) => s.replace(/[^\n]/g, ' '));
  // text nodes
  for (const m of t.matchAll(/>([^<>]+)</g)) {
    const raw = m[1].replace(/\u0001+/g, ' ').replace(/&nbsp;|&[a-z]+;/g, ' ').trim();
    if (!raw || !WORDY.test(raw) || IGNORE_TEXT.test(raw)) continue;
    findings.push({ rel, line: lineOf(sources.get(join(ROOT, rel)), start + m.index), kind: 'text', text: raw });
  }
  // literal attributes
  const attrRe = new RegExp(`\\s\\.?(${ATTRS.join('|')})=(["'])([^"'\\u0001]*?)\\2`, 'g');
  for (const m of t.matchAll(attrRe)) {
    const raw = m[3].trim();
    if (!raw || !WORDY.test(raw) || IGNORE_TEXT.test(raw)) continue;
    findings.push({ rel, line: lineOf(sources.get(join(ROOT, rel)), start + m.index), kind: `attr ${m[1]}`, text: raw });
  }
}

// index of the closing backtick of a template that starts at `from` (just after the opening backtick)
function templateEnd(src, from) {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i;
    if (c === '$' && src[i + 1] === '{') { i = exprEnd(src, i + 2) + 1; continue; }
    i++;
  }
  return i;
}
// index of the '}' that closes a ${…} expression starting at `from`
function exprEnd(src, from) {
  let i = from, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') { i = templateEnd(src, i + 1) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) return i; depth--; }
    i++;
  }
  return i;
}

for (const [f, src] of clean) {
  const rel = relative(ROOT, f);
  // html`…` and svg`…` templates (nested templates are found by their own tag)
  for (const m of src.matchAll(/\b(?:html|svg)`/g)) {
    const from = m.index + m[0].length;
    const i = templateEnd(src, from);
    scanTemplate(rel, src, from, src.slice(from, i));
  }
  // string literals with German letters (toasts, confirm texts, labels built in code …) outside templates
  // inline bilingual data is fine: { de: 'Kühlschrank', en: 'Fridge' } and V('id', 'Türen', 'Doors')
  const lines = src.split('\n');
  for (const m of src.matchAll(/(['"])((?:(?!\1)[^\\\n]|\\.)*[äöüÄÖÜß](?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const ln = lineOf(src, m.index);
    const line = lines[ln - 1];
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (/\bde\s*:\s*$/.test(before) && /\ben\s*:/.test(line)) continue; // de: '…', en: '…'
    if (/\b(?:de|isDe|german)\s*\?\s*\(?\s*$/.test(before)) continue; // de ? 'Kühlschrank' : 'Fridge'
    if (/\b(?:keys|keywords|search|tags)\s*:\s*$/.test(before)) continue; // search words (both languages), never shown
    if (/^\s*,\s*(['"])[^'"\n]*\1/.test(after) && /,\s*$/.test(before)) continue; // V(id, 'de', 'en')
    if (/\.replace\(|\/[^/\n]*[äöüß][^/\n]*\/[gimsuy]*/.test(line) && /replace|RegExp|\/g/.test(line)) continue; // transliteration
    findings.push({ rel, line: ln, kind: 'umlaut literal', text: m[2] });
  }
  // obvious user texts in code: toast('…'), confirm('…'), title: '…', label: '…', name: '…' with spaces
  for (const m of src.matchAll(/\b(toast|showToast|confirm|alert|title|label|heading|text|message|hint|placeholder|tooltip)\s*[:(]\s*(['"])([^'"\n]*\s[^'"\n]*)\2/g)) {
    const raw = m[3].trim();
    if (!WORDY.test(raw) || /^[\w.-]+$/.test(raw) || /[{};]|=>|\bvar\(/.test(raw)) continue;
    findings.push({ rel, line: lineOf(src, m.index), kind: `code ${m[1]}`, text: raw });
  }
}
// one finding per file:line:text
const seenF = new Set();
const hard = findings.filter((x) => {
  const k = `${x.rel}:${x.line}:${x.text}`;
  if (seenF.has(k)) return false;
  seenF.add(k);
  return true;
}).sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

// ---------- report ----------
const show = (title, list, max = 60) => {
  console.log(`\n${title}: ${list.length}`);
  for (const x of list.slice(0, max)) console.log(`  ${x}`);
  if (list.length > max) console.log(`  … ${list.length - max} more`);
};
console.log(`i18n: ${deKeys.size} German keys, ${enKeys.size} English keys, ${files.length} source files`);
console.log(`language: HA user language (hass.locale.language ?? hass.language) → 'de*' = German, everything else English`);
show('duplicate keys in de', dupDe);
show('duplicate keys in en', dupEn);
show('English translation missing (falls back to German)', missingEn, all ? 1e9 : 60);
show('English keys that do not exist in German', extraEn);
show('English text identical to German (with umlauts)', untranslatedEn);
show('placeholder mismatch ({n} …) between de and en', varMismatch.map((k) => `${k}: "${de[k]}" ↔ "${en[k]}"`));
show('t() with an unknown key', unknown, 1e9);
show('unused keys', unused, all ? 1e9 : 80);
const byFile = {};
for (const x of hard) byFile[x.rel] = (byFile[x.rel] ?? 0) + 1;
console.log(`\nhard-coded text candidates: ${hard.length}`);
for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${f}`);
const max = all ? 1e9 : 400;
for (const x of hard.slice(0, max)) console.log(`  ${x.rel}:${x.line}  [${x.kind}]  ${x.text.slice(0, 90)}`);
if (hard.length > max) console.log(`  … ${hard.length - max} more (--all)`);

const fail = dupDe.length + dupEn.length + missingEn.length + extraEn.length + unknown.length + varMismatch.length;
console.log(`\n${fail ? 'FAIL' : 'OK'}: ${missingEn.length} missing English, ${unknown.length} unknown t() keys, ${extraEn.length} orphan English keys, ${varMismatch.length} placeholder mismatches, ${unused.length} unused, ${hard.length} hard-coded candidates`);
if (strict && fail) process.exit(1);
