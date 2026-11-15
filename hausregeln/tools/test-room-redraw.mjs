// "Raum einstellen" redraws after every change: a click on a stepper or a sensor box shows the new value at once
// (a willUpdate without super once broke the store subscription – everything saved, nothing showed). Preview.
//   node tools/build.mjs && sh ../tools/heavy.sh browser node tools/test-room-redraw.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
let fails = 0;
const ok = (c, m, x) => { if (!c) fails++; console.log(c ? '  ok:' : '  FEHLER:', m, !c && x !== undefined ? JSON.stringify(x) : ''); };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto('file://' + process.cwd() + '/dist/preview-local.html');
await p.waitForSelector('house-rules-panel'); await p.waitForTimeout(600);
const deep = `const deep = (root, sel, out=[]) => { root.querySelectorAll(sel).forEach(e=>out.push(e)); root.querySelectorAll('*').forEach(e=>{ if (e.shadowRoot) deep(e.shadowRoot, sel, out); }); return out; };`;
await p.evaluate(new Function(`${deep} const pn = deep(document,'house-rules-panel')[0]; pn.dispatchEvent(new CustomEvent('hr-room-settings', { detail: { id: 'wohnzimmer' }, bubbles: true, composed: true })); return true;`));
await p.waitForTimeout(700);
const sun = new Function(`${deep} return deep(document, '.line').find(l => l.querySelector('b')?.textContent.trim() === 'Sonne tiefer als')?.querySelector('output')?.textContent;`);
const before = await p.evaluate(sun);
await p.evaluate(new Function(`${deep} const line = deep(document, '.line').find(l => l.querySelector('b')?.textContent.trim() === 'Sonne tiefer als'); [...line.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'mehr').click(); return true;`));
await p.waitForTimeout(300);
const after = await p.evaluate(sun);
ok(after !== before && /°/.test(after ?? ''), `„Sonne tiefer als“ zeigt den neuen Wert sofort (${before} → ${after})`);
const box = new Function(`${deep} const b = deep(document, '.rl-item.fix button.main')[0]; return b?.getAttribute('aria-pressed');`);
const b0 = await p.evaluate(box);
await p.evaluate(new Function(`${deep} deep(document, '.rl-item.fix button.main')[0].click(); return true;`));
await p.waitForTimeout(300);
const b1 = await p.evaluate(box);
ok(b0 !== b1, `Häkchen eines Sensors wechselt sichtbar (${b0} → ${b1})`);
const sub = await p.evaluate(new Function(`${deep} const rs = deep(document,'hr-room-settings')[0]; const pn = deep(document,'house-rules-panel')[0]; return rs._sub === pn.store;`));
ok(sub, 'Raum einstellen hört auf Änderungen der Daten');
ok(!errs.length, 'keine Fehler auf der Seite', errs);
await b.close();
console.log(fails ? `\n${fails} Fehler` : '\nalles ok');
process.exit(fails ? 1 : 0);
