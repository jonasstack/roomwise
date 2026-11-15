// Gives the pieces of the doku design kit (docs/doku/pages/_kit.html, made by `doku kit`) their surroundings back.
// The page copies are flattened shadow DOM (doku-page.mjs): a piece's colours and sizes come from CSS variables and
// selectors of the components around it (:host → [data-h], parent classes). Lifted out on its own it loses them, so
// each piece is wrapped in its real ancestors from the page copy it came from (same tag and attributes, laid out with
// display: contents, so they add no boxes). Run after `doku kit`; running it twice changes nothing.
// Usage: sh tools/heavy.sh browser node tools/design/doku-kit.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES = join(ROOT, 'docs', 'doku', 'pages');
const KIT = join(PAGES, '_kit.html');
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(pathToFileURL(KIT).href, { waitUntil: 'load' });
  // pieces without surroundings yet
  const todo = await page.evaluate(() =>
    [...document.querySelectorAll('.doku-kit-item')]
      .filter((it) => it.firstElementChild && !it.firstElementChild.hasAttribute('data-kit-ctx'))
      .map((it) => ({ id: it.dataset.kit, html: it.firstElementChild.outerHTML })),
  );
  const chains = {};
  for (const f of readdirSync(PAGES).filter((n) => /^[a-z][\w-]*(\.s\d+)?\.html$/.test(n))) {
    const left = todo.filter((t) => !chains[t.id]);
    if (!left.length) break;
    await page.goto(pathToFileURL(join(PAGES, f)).href, { waitUntil: 'domcontentloaded' });
    Object.assign(
      chains,
      await page.evaluate((items) => {
        const found = {};
        const attrs = (el) => [...el.attributes].map((a) => [a.name, a.value]).filter(([n]) => n !== 'id');
        for (const { id, html } of items) {
          const tag = /^<([\w-]+)/.exec(html)?.[1];
          const el = [...document.getElementsByTagName(tag)].find((x) => x.outerHTML === html);
          if (!el) continue;
          const chain = [];
          // body and <details> become plain wrappers (a <details> without its <summary> would draw a default one)
          for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) chain.unshift({ tag: a === document.body || a.localName === 'details' ? 'div' : a.localName, attrs: attrs(a) });
          chain.unshift({ tag: 'div', attrs: attrs(document.documentElement) });
          found[id] = chain;
        }
        return found;
      }, left),
    );
  }
  await page.goto(pathToFileURL(KIT).href, { waitUntil: 'load' });
  const n = await page.evaluate((chains) => {
    let n = 0;
    for (const it of document.querySelectorAll('.doku-kit-item')) {
      const chain = chains[it.dataset.kit];
      const piece = it.firstElementChild;
      if (!chain || !piece) continue;
      let outer = null, inner = null;
      for (const { tag, attrs } of chain) {
        const w = document.createElement(tag);
        for (const [k, v] of attrs) {
          try { w.setAttribute(k, v); } catch { /* odd name */ }
        }
        w.setAttribute('style', `${w.getAttribute('style') ?? ''};display:contents!important`.replace(/^;/, ''));
        w.setAttribute('data-kit-ctx', '');
        if (inner) inner.append(w); else outer = w;
        inner = w;
      }
      // fixed and absolute pieces (tool bars, sheets) stay in their own box instead of lying over the others
      it.style.cssText = `position:relative;contain:layout paint;min-width:${Math.min(1200, Number(it.dataset.kitW) || 0)}px;min-height:${Number(it.dataset.kitH) || 0}px`;
      it.insertBefore(outer, piece);
      inner.append(piece);
      n++;
    }
    return n;
  }, chains);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const src = readFileSync(KIT, 'utf8');
  writeFileSync(KIT, src.slice(0, src.indexOf('<html')) + html + '\n');
  const missing = todo.filter((t) => !chains[t.id]).map((t) => t.id);
  console.log(`kit: ${n} piece(s) wrapped in their surroundings${missing.length ? `, not found in any page copy: ${missing.join(' ')}` : ''}`);
} finally {
  await browser.close();
}
