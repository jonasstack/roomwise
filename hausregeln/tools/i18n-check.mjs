// Completeness check for the texts of Hausregeln, German and English (pure node, no browser, no Home Assistant).
//   node tools/i18n-check.mjs            report
//   node tools/i18n-check.mjs --strict   exit code 1 on any error (CI)
//   node tools/i18n-check.mjs --list     also list every German text still hard-coded, per file (what is left to translate)
//
// Panel (src/): dictionaries in src/i18n/*.ts ({ de, en } per area)
//   - German and English have the same keys, the same {placeholders}, no English text that is just the German one
//   - every t('key') / tn('key', n) exists, every key is used (literally or through a t(`prefix${…}`) prefix)
// Integration (custom_components/roomwise/house_rules/, translations next to the manifest in ../): texts/*.json ({ "de": {…}, "en": {…} } per area)
//   - the same checks for tr(…, "key") / trn(…, "key", n)
// Vocabulary: every German kind, verb and parameter of src/vocabulary.ts has English words in src/vocabulary-en.ts
// Home Assistant translations: strings.json (English, the source) = translations/en.json, translations/de.json has the same keys
// Files marked "i18n: complete" (a comment) must not contain hard-coded German any more; a line can opt out with "i18n-ignore".
// Files marked "i18n: data" are German on purpose (the German base of the vocabulary, the German sentence parser).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = new URL('../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const PY = join(ROOT, '..', 'custom_components', 'roomwise', 'house_rules');
// the Home Assistant translations belong to the integration (roomwise), next to its manifest
const HA = join(PY, '..');
const strict = process.argv.includes('--strict');
const list = process.argv.includes('--list');
const errors = [];
const err = (area, msg) => errors.push(`[${area}] ${msg}`);
const walk = (dir, re) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : [];
  });
// {s} (where the subject goes) is a matter of word order, not a value
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((v) => v !== 's').sort().join(',');
const lineOf = (src, i) => src.slice(0, i).split('\n').length;
const rel = (f) => relative(ROOT, f);

// ---------------------------------------------------------------------------------------------- German text detection
const GERMAN_WORDS = /(?:^|[^\p{L}])(der|die|das|dem|den|des|und|oder|nicht|ist|sind|wird|werden|noch|schon|kein|keine|mit|für|bei|im|zum|zur|vom|auf|aus|ein|eine|einen|wenn|dann|nur|alle|jetzt|hier|Regel|Regeln|Raum|Räume|Licht|Gerät|Geräte|Heizung|Fenster|Tür|Uhr|Zuhause|Alarmanlage|Verlauf|Einstellungen|Sichern|Abbrechen|Löschen|Später|Übernehmen)(?=[^\p{L}]|$)/u;
const looksGerman = (s) => /[äöüÄÖÜß„]/.test(s) || GERMAN_WORDS.test(s);

/** String literals and template text of a TS/JS file with their line numbers (comments removed). */
function tsStrings(src) {
  const out = [];
  // code: strings, templates, comments; inside ${…} it stops at the closing brace and returns its index
  const code = (i, inExpr) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, s = '';
        while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j++]; }
        out.push({ text: s, line: lineOf(src, i) });
        i = j + 1;
        continue;
      }
      if (c === '`') { i = template(i) + 1; continue; }
      if (inExpr && c === '{') depth++;
      if (inExpr && c === '}' && depth-- === 0) return i;
      i++;
    }
    return i;
  };
  // a template from its opening backtick: the literal parts are text; returns the index of the closing backtick
  const template = (start) => {
    let j = start + 1, s = '';
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { s += ' '; j = code(j + 2, true) + 1; continue; }
      s += src[j++];
    }
    // markup and CSS are not text: keep what sits between tags and attribute values people read
    const text = s.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, (tag) => ' ' + [...tag.matchAll(/\b(?:title|aria-label|label|placeholder|heading|alt)="([^"]*)"/g)].map((m) => m[1]).join(' ') + ' ');
    out.push({ text, line: lineOf(src, start) });
    return j;
  };
  code(0, false);
  return { list: out };
}

/** String literals of a Python file (docstrings and comments removed). */
function pyStrings(src) {
  const out = [];
  const re = /#[^\n]*|(?:[rRbBuUfF]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('#') || m[1]?.startsWith('"""') || m[1]?.startsWith("'''")) continue;
    out.push({ text: m[1].slice(1, -1), line: lineOf(src, m.index) });
  }
  return out;
}

function hardcoded(file, src, strings) {
  const lines = src.split('\n');
  return strings
    .filter((x) => looksGerman(x.text) && !/i18n-ignore/.test(lines[x.line - 1] ?? ''))
    .map((x) => ({ file: rel(file), line: x.line, text: x.text.replace(/\s+/g, ' ').trim().slice(0, 100) }))
    .filter((x) => x.text);
}

// ---------------------------------------------------------------------------------------------- panel dictionaries
async function evalModule(file) {
  const r = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}

const dictFiles = walk(join(SRC, 'i18n'), /\.ts$/);
const panelDe = {}, panelEn = {};
for (const f of dictFiles) {
  const m = await evalModule(f);
  const area = rel(f);
  for (const k of Object.keys(m.de)) {
    if (k in panelDe) err('panel', `${area}: key "${k}" exists in two dictionaries`);
    panelDe[k] = m.de[k];
  }
  for (const k of Object.keys(m.en)) panelEn[k] = m.en[k];
  for (const k of Object.keys(m.de)) if (!(k in m.en)) err('panel', `${area}: English missing for "${k}"`);
  for (const k of Object.keys(m.en)) if (!(k in m.de)) err('panel', `${area}: English key "${k}" has no German`);
  for (const k of Object.keys(m.de)) {
    if (k in m.en && vars(m.de[k]) !== vars(m.en[k])) err('panel', `${area}: placeholders differ for "${k}": "${m.de[k]}" ↔ "${m.en[k]}"`);
    if (m.en[k] === m.de[k] && /[äöüÄÖÜß„]/.test(m.de[k])) err('panel', `${area}: English text of "${k}" is the German one`);
  }
}

const srcFiles = walk(SRC, /\.ts$/).filter((f) => !f.includes(`${join(SRC, 'i18n')}/`) && !f.endsWith('i18n.ts'));
const used = new Set(), prefixes = new Set(), literals = new Set();
const unknownT = [];
const leftovers = [];
for (const f of srcFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*(['"])([\w.]+)\1/g)) {
    used.add(m[2]);
    if (!(m[2] in panelDe)) unknownT.push(`${rel(f)}:${lineOf(src, m.index)} t('${m[2]}')`);
  }
  for (const m of src.matchAll(/\btn\(\s*(['"])([\w.]+)\1/g)) {
    for (const s of ['_one', '_other']) {
      used.add(m[2] + s);
      if (!(m[2] + s in panelDe)) unknownT.push(`${rel(f)}:${lineOf(src, m.index)} tn('${m[2]}') needs ${m[2]}${s}`);
    }
  }
  for (const m of src.matchAll(/\bt\(\s*`([\w.]*)\$\{/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*(['"])([\w.]+)\1\s*\+/g)) prefixes.add(m[2]);
  for (const m of src.matchAll(/`([a-z_]+\.[\w.]*)\$\{[^`]*`\s*as\s+I18nKey/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/(['"])([a-z_]+\.[\w.]+)\1/g)) literals.add(m[2]);
  const marked = /i18n: complete/.test(src);
  if (/i18n: data/.test(src)) continue; // German on purpose (the German base of the vocabulary, the German parser)
  const found = hardcoded(f, src, tsStrings(src).list);
  if (marked) for (const x of found) err('panel', `${x.file}:${x.line} hard-coded German in a file marked complete: ${x.text}`);
  else if (found.length) leftovers.push({ file: rel(f), items: found });
}
for (const u of unknownT) err('panel', `unknown key ${u}`);
const covered = (k) => used.has(k) || literals.has(k) || [...prefixes].some((p) => p && k.startsWith(p));
for (const k of Object.keys(panelDe)) if (!covered(k)) err('panel', `unused key "${k}"`);

// ---------------------------------------------------------------------------------------------- vocabulary
const voc = await evalModule(join(SRC, 'vocabulary.ts'));
for (const [id, k] of Object.entries(voc.KINDS)) {
  const e = voc.EN_KINDS[id];
  if (!e) { err('vocab', `kind "${id}" has no English words`); continue; }
  for (const key of ['label', 'plural', 'any']) if (!e[key]) err('vocab', `kind "${id}": English ${key} missing`);
  for (const v of k.verbs) {
    const ev = e.verbs[v.id];
    if (!ev) { err('vocab', `${id}.${v.id}: English label missing`); continue; }
    if (vars(v.label) !== vars(ev.label.replace('{s}', ''))) err('vocab', `${id}.${v.id}: placeholders differ: "${v.label}" ↔ "${ev.label}"`);
    if (v.pl && !ev.pl) err('vocab', `${id}.${v.id}: English plural missing`);
    if (v.hint && !ev.hint) err('vocab', `${id}.${v.id}: English hint missing`);
    if (v.flavour === 'action' && !ev.label.includes('{s}') && !k.hide_subject?.includes('then')) err('vocab', `${id}.${v.id}: English action without {s}`);
    for (const p of v.params ?? []) if (!ev.params?.[p.key]) err('vocab', `${id}.${v.id}: English label of parameter "${p.key}" missing`);
  }
  for (const vid of Object.keys(e.verbs)) if (!k.verbs.some((v) => v.id === vid)) err('vocab', `${id}.${vid}: English words for a verb that does not exist`);
}
for (const id of Object.keys(voc.MODES)) if (!voc.EN_MODES[id]) err('vocab', `mode "${id}" has no English name`);

// ---------------------------------------------------------------------------------------------- integration texts
const textFiles = walk(join(PY, 'texts'), /\.json$/);
const pyDe = {}, pyEn = {};
for (const f of textFiles) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const area = rel(f);
  for (const k of Object.keys(d.de ?? {})) {
    if (k in pyDe) err('server', `${area}: key "${k}" exists in two files`);
    pyDe[k] = d.de[k];
    if (!(k in (d.en ?? {}))) err('server', `${area}: English missing for "${k}"`);
    else if (vars(d.de[k]) !== vars(d.en[k])) err('server', `${area}: placeholders differ for "${k}": "${d.de[k]}" ↔ "${d.en[k]}"`);
    else if (d.de[k] === d.en[k] && /[äöüÄÖÜß„]/.test(d.de[k])) err('server', `${area}: English text of "${k}" is the German one`);
  }
  for (const k of Object.keys(d.en ?? {})) {
    pyEn[k] = d.en[k];
    if (!(k in (d.de ?? {}))) err('server', `${area}: English key "${k}" has no German`);
  }
}
const pyFiles = walk(PY, /\.py$/);
const pyUsed = new Set(), pyPrefixes = new Set(), pyLiterals = new Set();
for (const f of pyFiles) {
  const src = readFileSync(f, 'utf8');
  if (f.endsWith('i18n.py')) {
    // the helper itself: its docstring shows example keys; only the keys it builds count as used
    for (const m of src.matchAll(/\btrn?\([^,()]*,\s*f"([\w.]*)\{/g)) pyPrefixes.add(m[1]);
    for (const m of src.matchAll(/\btr\([^,()]*,\s*"([\w.]+)"/g)) pyUsed.add(m[1]);
    continue;
  }
  for (const m of src.matchAll(/\btr\([^,()]*(?:\([^()]*\))?[^,()]*,\s*"([\w.]+)"/g)) {
    pyUsed.add(m[1]);
    if (!(m[1] in pyDe)) err('server', `${rel(f)}:${lineOf(src, m.index)} unknown key tr(…, "${m[1]}")`);
  }
  for (const m of src.matchAll(/\btrn\([^,()]*(?:\([^()]*\))?[^,()]*,\s*"([\w.]+)"/g)) {
    for (const s of ['_one', '_other']) {
      pyUsed.add(m[1] + s);
      if (!(m[1] + s in pyDe)) err('server', `${rel(f)}:${lineOf(src, m.index)} trn(…, "${m[1]}") needs ${m[1]}${s}`);
    }
  }
  for (const m of src.matchAll(/\btrn?\([^,()]*(?:\([^()]*\))?[^,()]*,\s*f["']([\w.]*)\{/g)) pyPrefixes.add(m[1]);
  for (const m of src.matchAll(/"([a-z_]+\.[\w.]+)"/g)) pyLiterals.add(m[1]);
  const marked = /i18n: complete/.test(src);
  if (/i18n: data/.test(src)) continue; // German on purpose (the German base of the vocabulary, the German parser)
  const found = hardcoded(f, src, pyStrings(src));
  if (marked) for (const x of found) err('server', `${x.file}:${x.line} hard-coded German in a file marked complete: ${x.text}`);
  else if (found.length) leftovers.push({ file: rel(f), items: found });
}
const pyCovered = (k) => pyUsed.has(k) || pyLiterals.has(k) || [...pyPrefixes].some((p) => p && k.startsWith(p));
for (const k of Object.keys(pyDe)) if (!pyCovered(k)) err('server', `unused key "${k}"`);

// ---------------------------------------------------------------------------------------------- Home Assistant translations
const shape = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? shape(v, `${p}${k}.`) : [`${p}${k}`])).sort();
const flat = (o, p = '') => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(flat(v, `${p}${k}.`)) : [[`${p}${k}`, v]])));
const strings = JSON.parse(readFileSync(join(HA, 'strings.json'), 'utf8'));
const haEn = JSON.parse(readFileSync(join(HA, 'translations', 'en.json'), 'utf8'));
const haDe = JSON.parse(readFileSync(join(HA, 'translations', 'de.json'), 'utf8'));
if (JSON.stringify(strings) !== JSON.stringify(haEn)) err('ha', 'translations/en.json must equal strings.json (English is the source)');
if (shape(haDe).join() !== shape(haEn).join()) err('ha', 'translations/de.json and en.json have different keys');
for (const [k, v] of Object.entries(flat(haEn))) if (/[äöüÄÖÜß„]/.test(v) || GERMAN_WORDS.test(v)) err('ha', `translations/en.json ${k} looks German: ${v}`);
for (const [k, v] of Object.entries(flat(haDe))) if (v === flat(haEn)[k] && /\s/.test(v)) err('ha', `translations/de.json ${k} is not translated: ${v}`);

// ---------------------------------------------------------------------------------------------- report
console.log(`panel: ${Object.keys(panelDe).length} keys in ${dictFiles.length} dictionaries, ${srcFiles.length} source files`);
console.log(`server: ${Object.keys(pyDe).length} keys in ${textFiles.length} text files, ${pyFiles.length} Python files`);
console.log(`vocabulary: ${Object.keys(voc.KINDS).length} kinds`);
const total = leftovers.reduce((n, x) => n + x.items.length, 0);
console.log(`\nstill German (files not marked "i18n: complete"): ${total} texts in ${leftovers.length} files`);
for (const x of leftovers.sort((a, b) => b.items.length - a.items.length)) {
  console.log(`  ${String(x.items.length).padStart(4)}  ${x.file}`);
  if (list) for (const it of x.items) console.log(`          ${it.line}: ${it.text}`);
}
console.log(`\n${errors.length ? 'FAIL' : 'OK'}: ${errors.length} errors`);
for (const e of errors.slice(0, 300)) console.log(`  ${e}`);
if (errors.length > 300) console.log(`  … ${errors.length - 300} more`);
if (strict && errors.length) process.exit(1);
