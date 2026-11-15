// HTML copies of the doku screens (docs/doku/pages/<id>.html) for interfaces that live in shadow DOM.
// The doku tool's capturePage() only reads the light DOM and the document's style sheets; the card and the Hausregeln
// panel render everything inside shadow roots. So the page is first flattened into a plain document, then captured:
//   - every shadow host gets its shadow root's content as children; each <slot> is replaced by its assigned light-DOM
//     nodes (marked data-sl="<scope> <scope>.<slot name>" for ::slotted()), so outer rules like `host > *` still hold
//   - every shadow root's style sheets (<style> and adoptedStyleSheets) become one plain sheet, scoped with data
//     attributes: data-h="<scope>" on the host (:host), data-s="<scope>" on the elements of that shadow tree
//     (added as :where(), so specificity stays). Deeper shadow trees go into weaker cascade layers, so an outer
//     rule still wins over :host as in the shadow cascade. Scopes are named by a hash of their CSS, so the same
//     component gives the same file in pages/_css/ on every screen (shared, not duplicated).
//     The CSS is taken from its source text (<style>, Lit's css``), not from the CSSOM, which loses shorthands with
//     var() (see scopeCss); SVG ids that repeat across shadow trees are made unique with their references.
//   - canvases (WebGL) are photographed alone (everything else hidden, transparent background) and become images
//   - inline styles (theme variables HA sets on html and hosts) and form state are kept
// The flat document is served from a small local server and opened in a second tab of the same browser context;
// capturePage() runs there. The original page is only read (canvas markers are removed again), so the script can
// go on with the next screen.
// Usage: const pages = await docPages(); await pages.save(page, { id, url }); … await pages.close();
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_DIR = 'docs/doku';
const LAYERS = 40; // cascade layers d40 (deepest shadow tree, weakest) … d1; the document's own sheets stay unlayered

/** In the page: marks the visible canvases (composed tree) with data-doku-canvas and returns their count. */
const MARK_CANVASES = () => {
  let n = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.localName === 'canvas') {
        const r = el.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2 && getComputedStyle(el).visibility !== 'hidden') el.setAttribute('data-doku-canvas', String(n++));
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return n;
};
/** In the page: hides everything but one canvas with an extra adopted style sheet in the document and every shadow
 *  root (removed by RESTORE_VISIBILITY). Not inline styles: a re-render would overwrite them, and the card watches its
 *  plan SVG for changes. Transitions are off meanwhile (a transition outranks !important and would keep e.g. HA's
 *  ha-card visible for its 0.3 s). The page background goes too (the root's background is painted even when hidden), so the
 *  picture keeps its transparency. */
const ONLY_CANVAS = (i) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`* { visibility: hidden !important; transition: none !important; } canvas[data-doku-canvas="${i}"] { visibility: visible !important; } html, body { background: transparent !important; }`);
  const roots = [];
  const walk = (root) => {
    roots.push(root);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  window.__dokuHide = { sheet, roots };
};
const RESTORE_VISIBILITY = () => {
  const { sheet, roots } = window.__dokuHide ?? { roots: [] };
  for (const root of roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
  delete window.__dokuHide;
};
const UNMARK_CANVASES = () => {
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      el.removeAttribute?.('data-doku-canvas');
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
};
/** In the page: PNG (base64) → WebP data URL, far smaller for the photographed 3D scenes. */
const TO_WEBP = (b64) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c.toDataURL('image/webp', 0.9).split(',')[1]);
    };
    img.onerror = () => resolve(null);
    img.src = 'data:image/png;base64,' + b64;
  });

/** In the page: the flattened document as HTML text. opts: { canvases: { index: url }, layers, keepLinks } */
const FLATTEN = (opts) => {
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    let g = 0x9e3779b9;
    for (let i = s.length - 1; i >= 0; i--) g = Math.imul(g ^ s.charCodeAt(i), 2246822519);
    return ((h >>> 0).toString(36) + (g >>> 0).toString(36)).slice(0, 10);
  };
  const absUrls = (text, base) =>
    String(text).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      if (/^(data:|#|about:)/i.test(u)) return m;
      try {
        return `url("${new URL(u, base).href}")`;
      } catch {
        return m;
      }
    });
  // nothing is defined in the copy: what was defined counts as defined
  const fixDefined = (text) => text.replace(/:defined\b/g, ':where(*)');

  // ── selectors: split at top level (outside (), [] and strings)
  const scan = (s, at) => {
    const out = [];
    let depth = 0, quote = '', last = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') i++;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        const len = at(s, i);
        if (len) {
          out.push(s.slice(last, i), s.slice(i, i + len));
          last = i + len;
          i += len - 1;
        }
      }
    }
    out.push(s.slice(last));
    return out;
  };
  const splitList = (s) => scan(s, (t, i) => (t[i] === ',' ? 1 : 0)).filter((_, i) => i % 2 === 0).map((x) => x.trim());
  // compounds and combinators alternate: [compound, combinator, compound, …]
  const splitComplex = (s) => {
    const parts = scan(s.trim(), (t, i) => {
      const m = /^\s*[>+~]\s*|^\s+/.exec(t.slice(i));
      return m ? m[0].length : 0;
    });
    return parts.map((p, i) => (i % 2 ? (p.trim() || ' ') : p));
  };
  /** replaces name(…) (with balanced parentheses) via fn(inner) */
  const replaceFn = (s, name, fn) => {
    let out = '', i = 0;
    for (;;) {
      const j = s.indexOf(name + '(', i);
      if (j < 0) return out + s.slice(i);
      let depth = 0, k = j + name.length;
      for (; k < s.length; k++) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')' && --depth === 0) break;
      }
      out += s.slice(i, j) + fn(s.slice(j + name.length + 1, k));
      i = k + 1;
    }
  };
  const hostSel = (s, K) => {
    const H = `[data-h="${K}"]`;
    s = replaceFn(s, ':host-context', (x) => `${H}:is(${x}, :is(${x}) *)`);
    s = replaceFn(s, ':host', (x) => `${H}:is(${x})`);
    return s.replace(/:host(?![\w-])/g, H);
  };
  /** position of the first top-level pseudo-element in a compound (or its length) */
  const pseudoAt = (c) => {
    const parts = scan(c, (t, i) => (t.startsWith('::', i) || /^:(before|after|first-line|first-letter)(?![\w-])/.test(t.slice(i)) ? 1 : 0));
    return parts.length > 1 ? parts[0].length : c.length;
  };
  const scopeSelector = (sel, K) => {
    const S = `:where([data-s="${K}"])`;
    return splitList(sel)
      .map((complex) => {
        const parts = splitComplex(complex);
        const last = parts.length - 1;
        let subject = parts[last];
        const isHost = /:host(?![\w-])|:host\(|:host-context\(/.test(subject);
        for (let i = 0; i < parts.length; i += 2) parts[i] = hostSel(parts[i], K);
        subject = parts[last];
        let m;
        if ((m = /::slotted\(/.exec(subject))) {
          // slots are unwrapped, their nodes carry data-sl="<scope> <scope>.<slot name>": slot[name=a]::slotted(x) → x[…]
          let depth = 0, k = m.index + 9;
          for (; k < subject.length; k++) {
            if (subject[k] === '(') depth++;
            else if (subject[k] === ')' && --depth === 0) break;
          }
          const named = /^slot\[name=["']?([\w-]+)["']?\]$/.exec(subject.slice(0, m.index));
          parts[last] = `${subject.slice(m.index + 10, k)}:where([data-sl~="${named ? `${K}.${named[1]}` : K}"])${subject.slice(k + 1)}`;
        } else if ((m = /::part\(([^)]*)\)/.exec(subject))) {
          // the part's element sits inside the host now
          const before = subject.slice(0, m.index);
          parts[last] = `${before ? (isHost ? before : before + S) : ''} [part~="${m[1].trim()}"]${subject.slice(m.index + m[0].length)}`;
        } else if (!isHost) {
          const at = pseudoAt(subject);
          parts[last] = subject.slice(0, at) + S + subject.slice(at);
        }
        return parts.join('');
      })
      .join(', ');
  };
  /** scopes a style sheet's source text. Works on the text, not the CSSOM: Chrome serializes a shorthand with var()
   *  whose longhand is overridden later in the rule as empty longhands (`padding: 0 var(--x); padding-top: …`). */
  const scopeCss = (src, K) => {
    let out = '';
    let i = 0;
    const end = (from, stops) => {
      let depth = 0, quote = '';
      for (let j = from; j < src.length; j++) {
        const ch = src[j];
        if (quote) {
          if (ch === '\\') j++;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '\\') j++;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth <= 0 && stops.includes(ch)) return j;
      }
      return src.length;
    };
    while (i < src.length) {
      const j = end(i, '{;}');
      const prelude = src.slice(i, j).trim().replace(/\s+/g, ' ');
      if (j >= src.length) break;
      if (src[j] !== '{') {
        if (src[j] === ';' && prelude.startsWith('@') && !/^@(import|charset)/i.test(prelude)) out += prelude + ';\n';
        i = j + 1;
        continue;
      }
      let k = j + 1;
      for (let d = 1; k < src.length; k++) {
        k = end(k, '{}');
        if (src[k] === '{') d++;
        else if (--d === 0) break;
      }
      const body = src.slice(j + 1, k);
      if (/^@(media|supports|container|layer|scope|starting-style)\b/i.test(prelude)) out += `${prelude} {\n${scopeCss(body, K)}}\n`;
      else if (/^@font-face/i.test(prelude)) {
        /* not applied inside shadow roots */
      } else if (prelude.startsWith('@')) out += `${prelude} {${body}}\n`;
      else if (prelude) out += `${scopeSelector(prelude, K)} {${body}}\n`;
      i = k + 1;
    }
    return out;
  };
  // source text of a sheet: <style> text, the Lit style it was built from (css`` keeps its text), else the CSSOM
  const litText = new WeakMap();
  const learnLit = (host) => {
    for (const s of host.constructor?.elementStyles ?? []) {
      try {
        if (s && typeof s.cssText === 'string' && s.styleSheet) litText.set(s.styleSheet, s.cssText);
      } catch {
        /* not a Lit style */
      }
    }
  };
  const texts = new WeakMap();
  const sheetText = (sh) => {
    if (texts.has(sh)) return texts.get(sh);
    let t = null;
    if (sh.ownerNode?.localName === 'style') t = sh.ownerNode.textContent;
    else if (litText.has(sh)) t = litText.get(sh);
    else {
      try {
        t = [...sh.cssRules].map((r) => r.cssText).join('\n');
      } catch {
        /* other origin */
      }
    }
    if (t != null) t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    texts.set(sh, t);
    return t;
  };

  // ── scopes: one per distinct style set of a shadow root
  const scopes = new Map(); // ShadowRoot → K
  const css = new Map(); // K → { depth, text }
  const scopeOf = (sr, depth) => {
    if (scopes.has(sr)) return scopes.get(sr);
    learnLit(sr.host);
    const sheets = [...sr.styleSheets, ...(sr.adoptedStyleSheets ?? [])].filter((s) => !s.disabled && !(s.href && sheetText(s) == null));
    const raw = sheets.map((s) => sheetText(s) ?? '').join('\n');
    const K = raw.trim() ? 's' + hash(raw).slice(0, 7) : '';
    scopes.set(sr, K);
    if (K && !css.has(K)) {
      const text = sheets.map((sh) => absUrls(scopeCss(sheetText(sh) ?? '', K), sh.href || document.baseURI)).join('');
      css.set(K, { depth: Math.min(depth, opts.layers), text: fixDefined(text) });
    }
    return K;
  };
  const scopeOfNode = (n) => {
    const r = n.getRootNode();
    return r instanceof ShadowRoot ? (scopes.get(r) ?? '') : '';
  };

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'base', 'link']);
  const made = []; // [clone, number of its tree]
  const trees = new Map();
  const treeOf = (el) => {
    const r = el.getRootNode();
    if (!trees.has(r)) trees.set(r, trees.size);
    return trees.get(r);
  };
  /** SVG ids (patterns, masks, gradients …) are unique per shadow tree only: duplicates get the tree's number, and the
   *  references in the same tree (url(#id), href="#id") follow – else the first, maybe hidden, definition would win */
  const uniqueSvgIds = () => {
    const count = new Map();
    for (const [c] of made) if (c.id) count.set(c.id, (count.get(c.id) ?? 0) + 1);
    const renamed = new Map(); // tree → Map(old id → new id)
    for (const [c, t] of made) {
      if (!c.id || count.get(c.id) < 2 || c.namespaceURI !== 'http://www.w3.org/2000/svg') continue;
      if (!renamed.has(t)) renamed.set(t, new Map());
      renamed.get(t).set(c.id, `${c.id}--${t}`);
      c.id = `${c.id}--${t}`;
    }
    for (const [c, t] of made) {
      const ids = renamed.get(t);
      if (!ids) continue;
      for (const a of [...c.attributes]) {
        const v = a.value.replace(/url\(\s*(['"]?)#([^'")]+)\1\s*\)/g, (m, q, id) => (ids.has(id) ? `url(#${ids.get(id)})` : m));
        const w = /^#/.test(v) && ids.has(v.slice(1)) ? `#${ids.get(v.slice(1))}` : v;
        if (w !== a.value) c.setAttribute(a.name, w);
      }
    }
  };
  const clone = (node, depth) => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag)) return null;
    const K = scopeOfNode(el);
    if (tag === 'canvas') {
      const r = el.getBoundingClientRect();
      const url = opts.canvases[el.getAttribute('data-doku-canvas')];
      const c = document.createElement(url ? 'img' : 'div');
      if (url) {
        c.setAttribute('src', url);
        c.setAttribute('alt', '');
      }
      for (const a of ['class', 'id', 'part']) if (el.hasAttribute(a)) c.setAttribute(a, el.getAttribute(a));
      c.setAttribute('style', `${el.getAttribute('style') || ''};width:${r.width}px;height:${r.height}px`);
      if (K) c.setAttribute('data-s', K);
      return c;
    }
    if (tag === 'slot' && el.getRootNode() instanceof ShadowRoot) {
      // unwrapped: the assigned nodes (they belong to the host's tree, one level up), else the fallback content
      const f = document.createDocumentFragment();
      const assigned = el.assignedNodes();
      const tokens = K ? [K, el.name && `${K}.${el.name}`].filter(Boolean) : [];
      for (const n of assigned.length ? assigned : el.childNodes) {
        const k = clone(n, assigned.length ? depth - 1 : depth);
        if (!k) continue;
        if (assigned.length && tokens.length && k.nodeType === Node.ELEMENT_NODE) k.setAttribute('data-sl', [k.getAttribute('data-sl'), ...tokens].filter(Boolean).join(' '));
        f.appendChild(k);
      }
      return f;
    }
    const c = el.cloneNode(false);
    c.removeAttribute('data-doku-canvas');
    if (K) c.setAttribute('data-s', K);
    made.push([c, treeOf(el)]);
    if (c.hasAttribute('style')) c.setAttribute('style', absUrls(c.getAttribute('style'), document.baseURI));
    if (tag === 'img' && (el.currentSrc || el.src)) {
      c.setAttribute('src', el.currentSrc || el.src);
      c.removeAttribute('srcset');
    }
    if (tag === 'a' && !opts.keepLinks) c.removeAttribute('href');
    if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked');
      else if (el.type !== 'file' && el.type !== 'password') c.setAttribute('value', el.value);
    }
    if (tag === 'textarea') c.textContent = el.value;
    if (tag === 'option') el.selected ? c.setAttribute('selected', '') : c.removeAttribute('selected');
    if ((tag === 'dialog' || tag === 'details') && el.open) c.setAttribute('open', '');
    let kids = el.childNodes;
    let childDepth = depth;
    if (el.shadowRoot) {
      childDepth = depth + 1;
      const HK = scopeOf(el.shadowRoot, childDepth);
      if (HK) c.setAttribute('data-h', HK);
      kids = el.shadowRoot.childNodes;
    }
    for (const n of kids) {
      const k = clone(n, childDepth);
      if (k) c.appendChild(k);
    }
    return c;
  };

  // style sheets in cascade order: layer order, the document's own sheets (unlayered), one per shadow scope
  const sheets = [{ text: `@layer ${Array.from({ length: opts.layers }, (_, i) => `d${opts.layers - i}`).join(', ')};\n` }];
  for (const sh of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
    if (sh.disabled) continue;
    const text = sheetText(sh);
    const media = sh.media && sh.media.mediaText && sh.media.mediaText !== 'all' ? sh.media.mediaText : '';
    if (text == null) {
      if (sh.href) sheets.push({ href: sh.href, media });
    } else if (text.trim()) sheets.push({ text: fixDefined(absUrls(text, sh.href || document.baseURI)), media });
  }
  const body = clone(document.body, 0);
  uniqueSvgIds();
  for (const [, { depth, text }] of css) sheets.push({ text: `@layer d${depth} {\n${text}}\n` });
  const html = document.documentElement.cloneNode(false);
  const head =
    `<head>\n<meta charset="utf-8">\n${opts.base ? `<base href="${opts.base}">\n` : ''}<title>${document.title.replace(/</g, '&lt;')}</title>\n` +
    `<meta name="doku-scroll" content="${Math.round(scrollX)},${Math.round(scrollY)}">\n<!--doku-sheets-->\n</head>`;
  const out = '<!doctype html>\n' + html.outerHTML.replace(/<\/html>$/, `${head}${body.outerHTML}</html>`);
  return { html: out, sheets, scopes: css.size, scroll: [scrollX, scrollY] };
};

/** Saves HTML copies of screens; one instance per browser session. */
export async function docPages({ root = ROOT, docDir = DOC_DIR } = {}) {
  const docTool = join(root, '.claude', 'doku', 'doku.mjs');
  if (!existsSync(docTool)) throw new Error('the doku tool (.claude/doku/doku.mjs) is missing – page copies need it');
  const { capturePage, prunePageFiles } = await import(docTool);
  // local server: the flat documents and the canvas pictures (capturePage downloads the pictures into pages/_files/)
  const files = new Map();
  const serve = (req, res) => {
    const f = files.get(req.url.split('?')[0]);
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store' }).end(f.body);
  };
  // two ports = two origins: the pages on one, their style sheets on the other (see save())
  const servers = [http.createServer(serve), http.createServer(serve)];
  await Promise.all(servers.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const [origin, cssOrigin] = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  const results = [];

  // a page's open menus, tabs and dialogs: pages/<id>.s<n>.html (the copy has no scripts, so every open state is its own copy)
  const stateRe = (id) => new RegExp(`^${id.replace(/[.]/g, '\\.')}\\.s\\d{1,2}\\.html$`);
  const dropStates = (id) => {
    const dir = join(root, docDir, 'pages');
    for (const f of existsSync(dir) ? readdirSync(dir) : []) if (stateRe(id).test(f)) rmSync(join(dir, f), { force: true });
  };
  const stateCount = new Map();

  /** The page as it is now as state <n> of screen <id> (call after save() of that screen; label names the state). */
  async function state(page, { id, url, label, trigger = '', height }) {
    const k = (stateCount.get(id) ?? 0) + 1;
    const res = await save(page, { id, url, height, outRel: `${id}.s${k}.html`, extra: { state: { trigger: trigger || label, label } } });
    if (res) stateCount.set(id, k);
    return res;
  }

  async function save(page, { id, url, height = page.viewportSize()?.height ?? 800, outRel = null, extra = null }) {
    if (!outRel) { dropStates(id); stateCount.set(id, 0); }
    // canvases: one picture each, alone on a transparent background
    const canvases = {};
    const n = await page.evaluate(MARK_CANVASES);
    for (let i = 0; i < n; i++) {
      await page.evaluate(ONLY_CANVAS, i);
      try {
        // a clip of the page, not locator.screenshot(): that waits for the element to stand still (3D floor changes)
        const box = await page.locator(`canvas[data-doku-canvas="${i}"]`).boundingBox({ timeout: 2000 });
        const vp = page.viewportSize();
        const x = Math.max(0, box.x), y = Math.max(0, box.y);
        const clip = { x, y, width: Math.min(box.x + box.width, vp.width) - x, height: Math.min(box.y + box.height, vp.height) - y };
        if (clip.width < 2 || clip.height < 2 || Math.abs(clip.width - box.width) > 1 || Math.abs(clip.height - box.height) > 1) throw new Error('partly outside the window');
        const png = await page.screenshot({ clip, omitBackground: true, timeout: 5000 });
        const webp = await page.evaluate(TO_WEBP, png.toString('base64'));
        const body = webp ? Buffer.from(webp, 'base64') : png;
        const name = `/c/${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}.${webp ? 'webp' : 'png'}`;
        files.set(name, { body, type: webp ? 'image/webp' : 'image/png' });
        canvases[i] = origin + name;
      } catch (e) {
        // not visible: an empty box instead
        console.error(`page ${id}: canvas ${i} not photographed (${String(e.message).split('\n')[0]})`);
      } finally {
        await page.evaluate(RESTORE_VISIBILITY);
      }
    }
    const pageUrl = page.url();
    const http_ = /^https?:/.test(pageUrl);
    let flat;
    try {
      flat = await page.evaluate(FLATTEN, { canvases, layers: LAYERS, base: http_ ? pageUrl : '', keepLinks: http_ });
    } finally {
      await page.evaluate(UNMARK_CANVASES);
    }
    // the style sheets come from another origin (other port): the page's CSSOM can't read them, so
    // capturePage downloads their text as it is (its CSSOM path would hit the same var() shorthand problem)
    const links = flat.sheets.map((s) => {
      const media = s.media ? ` media="${s.media.replace(/"/g, '&quot;')}"` : '';
      if (s.href) return `<link rel="stylesheet" href="${s.href}"${media}>`;
      const name = `/s/${crypto.createHash('sha1').update(s.text).digest('hex').slice(0, 16)}.css`;
      files.set(name, { body: s.text, type: 'text/css; charset=utf-8' });
      return `<link rel="stylesheet" href="${cssOrigin}${name}"${media}>`;
    });
    const key = `/p/${(outRel ?? id).replace(/\.html$/, '')}.html`;
    files.set(key, { body: flat.html.replace('<!--doku-sheets-->', links.join('\n')), type: 'text/html; charset=utf-8' });
    const p2 = await page.context().newPage();
    try {
      await p2.goto(origin + key, { waitUntil: 'load', timeout: 30_000 });
      await p2.evaluate(() => document.fonts.ready);
      const res = await capturePage(p2, { root, docDir, id, url, shot: height, outRel, extra });
      if (res) results.push({ id: outRel ? outRel.replace(/\.html$/, '') : id, ...res, scopes: flat.scopes, scroll: flat.scroll });
      return res && { ...res, scroll: flat.scroll };
    } finally {
      await p2.close();
      files.delete(key);
    }
  }
  async function close({ prune = false } = {}) {
    for (const s of servers) s.close();
    return prune ? prunePageFiles(root, docDir) : 0;
  }
  return { save, state, close, results };
}
