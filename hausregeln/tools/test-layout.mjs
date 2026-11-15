// Where things are in the panel since the redesign (preview with example data, no Home Assistant): every area has
// its own head (title, a line below it, the house mode button, a gear for the page's settings where there is one),
// tiles that open pop-ups, the window warning as a pop-up of the alarm area with its deep links, vacation and guests
// in the settings (Urlaubsmodus), persons with "zählt mit" on their tile, "Räume anordnen" with one order for all
// pages and hiding per page, the rules page with its grouping, and on phones the settings at the end of the navigation.
// Usage (after node tools/build.mjs): sh ../tools/heavy.sh browser node tools/test-layout.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
const url = 'file://' + process.cwd() + '/dist/preview-local.html';
const browser = await chromium.launch();
const errors = [];

async function open(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(url);
  await p.waitForSelector('house-rules-panel');
  await p.evaluate(() => localStorage.clear());
  await p.waitForTimeout(300);
  return p;
}
/** run code with `panel` (the element) and wait for it to draw */
const P = (p, body) => p.evaluate(new Function(`return (async () => { const panel = document.querySelector('house-rules-panel'); ${body} })()`));
const view = (p, tag, body) => P(p, `await panel.updateComplete; const v = panel.shadowRoot.querySelector('${tag}'); if (!v) return null; await v.updateComplete; ${body}`);
const tab = async (p, t, anchor = '') => {
  await P(p, `panel._setTab(${JSON.stringify(t)}, ${JSON.stringify(anchor)}); await panel.updateComplete;`);
  await p.waitForTimeout(400);
};
/** headings of the open pop-ups, oldest first */
const pops = (p) => p.locator('hr-pop').evaluateAll((els) => els.map((e) => e.getAttribute('heading')));
const closeAll = async (p) => {
  for (let i = 0; i < 6 && (await p.locator('hr-sheet').count()); i++) {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  }
};

// ------------------------------------------------------------------ wide
let p = await open(1280, 900);
const AREAS = { rules: 'Regeln', light: 'Licht', heat: 'Heizung', alarm: 'Alarmanlage', home: 'Zuhause', rooms: 'Räume', devices: 'Geräte', history: 'Verlauf', settings: 'Einstellungen' };
const GEAR = ['rules', 'light', 'heat', 'alarm', 'rooms', 'devices'];
for (const [t, name] of Object.entries(AREAS)) {
  await tab(p, t);
  const head = await P(p, `const h = panel.shadowRoot.querySelector('.head'); return { title: h.querySelector('h1').textContent.trim(), sub: h.querySelector('.title p').textContent.trim(), gear: !!h.querySelector('.page-gear'), mode: !!h.querySelector('.mode-pill') };`);
  ok(head.title === name && head.sub.length > 3 && head.mode, `${name}: Kopf mit Titel, Zeile darunter und Hausmodus-Knopf`, head);
  ok(head.gear === GEAR.includes(t), `${name}: ${GEAR.includes(t) ? 'Zahnrad für die Seite' : 'kein Seiten-Zahnrad'}`, head);
}

// house mode from the head: a pop-up with the five modes
await tab(p, 'rules');
await p.locator('house-rules-panel .mode-pill').click();
await p.waitForTimeout(400);
const radios = await p.locator('house-rules-panel .mode-list [role=radio]').count();
ok(radios === 5, 'Hausmodus-Knopf: Pop-up mit fünf Modi', radios);
await p.locator('house-rules-panel .mode-list [role=radio]').nth(2).click();
await p.waitForTimeout(200);
ok((await P(p, `return panel.store.mode;`)) === 'sleep', 'Hausmodus umschalten im Pop-up');
await P(p, `await panel.store.setMode('home');`);
await closeAll(p);

// alarm: tiles, gear = Grundlagen, window warning as a pop-up
await tab(p, 'alarm');
const tiles = await view(p, 'hr-alarm-view', `return [...v.shadowRoot.querySelectorAll('.rl-tile h2, .rl-tile h3')].map((h) => h.textContent.trim());`);
ok(['Sensoren je Modus', 'Reaktion', 'Benachrichtigung', 'Sicherheit', 'Weitere Alarme', 'Fenster-Warnung'].every((x) => tiles?.includes(x)), 'Alarmanlage: Kacheln Sensoren je Modus, Reaktion, Benachrichtigung, Sicherheit, Weitere Alarme, Fenster-Warnung', tiles);
await p.locator('house-rules-panel .page-gear').click();
await p.waitForTimeout(400);
ok((await pops(p)).includes('Grundlagen'), 'Alarmanlage: Zahnrad öffnet „Grundlagen“', await pops(p));
await closeAll(p);

// deep links (route): window warning → its pop-up in the alarm area, vacation → Urlaubsmodus in the settings
for (const [path, t, pop] of [
  ['/window-warning', 'alarm', 'Fenster-Warnung beim Gehen'],
  ['/home/window-warning', 'alarm', 'Fenster-Warnung beim Gehen'],
  ['/vacation', 'settings', 'Urlaubsmodus'],
]) {
  await P(p, `panel._setTab('rules'); panel.route = { prefix: '/hausregeln', path: ${JSON.stringify(path)} }; await panel.updateComplete;`);
  await p.waitForTimeout(900);
  const open = await pops(p);
  ok((await P(p, `return panel._tab;`)) === t && open.some((h) => h?.startsWith(pop)), `Direktlink /hausregeln${path} → ${t}, Pop-up „${pop}“`, { tab: await P(p, `return panel._tab;`), open });
  await closeAll(p);
}
await P(p, `panel.route = undefined; await panel.updateComplete;`);

// Zuhause: persons with "zählt mit" on their tile, no extra "Wer wohnt hier?", vacation only as a status tile
await tab(p, 'home');
const home = await view(p, 'hr-home-view', `const s = v.shadowRoot; return { persons: s.querySelectorAll('.rl-tile .av').length, switches: s.querySelectorAll('.rl-tile:has(.av) .switch').length, heads: [...s.querySelectorAll('.rl-tile h2, .rl-tile h3')].map((h) => h.textContent.trim()), ww: !!s.querySelector('hr-window-warning'), vac: !!s.querySelector('hr-vacation') };`);
ok(home && home.persons >= 2 && home.switches === home.persons, 'Zuhause: jede Person als Kachel mit Schalter „zählt mit“', home);
ok(home && !home.heads.includes('Wer wohnt hier?') && home.heads.includes('Hausmodus') && home.heads.includes('Orte'), 'Zuhause: Kacheln Hausmodus und Orte, kein eigenes „Wer wohnt hier?“', home?.heads);
ok(home && !home.ww && !home.vac, 'Zuhause: keine Fenster-Warnung, Urlaub nur als Status (eingestellt in den Einstellungen)', home);

// Einstellungen: tiles; Funktionen without "Raumverhalten"; Urlaubsmodus holds the vacation content
await tab(p, 'settings');
const st = await view(p, 'hr-settings-view', `return [...v.shadowRoot.querySelectorAll('.rl-tile h2, .rl-tile h3')].map((h) => h.textContent.trim());`);
ok(['Funktionen', 'Einrichtung', 'Urlaubsmodus', 'Wörter in Regeln', 'KI-Anbindung', 'Papierkorb', 'Diagnosedaten', 'Hausregeln entfernen'].every((x) => st?.includes(x)), 'Einstellungen: Kacheln Funktionen, Einrichtung, Urlaubsmodus, Wörter, KI, Papierkorb, Diagnosedaten, Entfernen', st);
await tab(p, 'settings', 'features');
const feats = await p.locator('hr-pop[heading="Funktionen"]').evaluate((e) => e.textContent);
ok(!/Raumverhalten/.test(feats) && /Fenster-Warnung/.test(feats), 'Funktionen: ohne „Raumverhalten“ (aufgelöst)');
await closeAll(p);
await tab(p, 'settings', 'urlaub');
const vac = await view(p, 'hr-settings-view', `const u = v.shadowRoot.querySelector('hr-vacation'); if (!u) return null; await u.updateComplete; return { auto: !!u.shadowRoot.querySelector('hr-mode-auto[only="vacation"]'), text: u.shadowRoot.textContent };`);
ok(vac?.auto && /Heizung/.test(vac.text) && /Alarmanlage/.test(vac.text), 'Urlaubsmodus: Urlaub automatisch, bewohnt wirken, Heizung und Alarmanlage im Urlaub', vac && { auto: vac.auto });
await closeAll(p);

// the alarm area stays while only the window warning is on
await P(p, `await panel.store.featuresSet({ alarm: false }); await panel.updateComplete;`);
await tab(p, 'alarm');
const navAlarm = await P(p, `return [...panel.shadowRoot.querySelectorAll('nav button')].some((b) => b.textContent.trim() === 'Alarmanlage');`);
const offTiles = await view(p, 'hr-alarm-view', `return [...v.shadowRoot.querySelectorAll('.rl-tile h2, .rl-tile h3')].map((h) => h.textContent.trim());`);
ok(navAlarm && offTiles?.includes('Fenster-Warnung'), 'Alarmanlage aus, Fenster-Warnung an: Bereich bleibt, mit der Fenster-Warnung', { navAlarm, offTiles });
await P(p, `await panel.store.featuresSet({ window_warning: false }); await panel.updateComplete;`);
ok(!(await P(p, `return [...panel.shadowRoot.querySelectorAll('nav button')].some((b) => b.textContent.trim() === 'Alarmanlage');`)), 'beide aus: kein Bereich Alarmanlage');
await P(p, `panel._setTab('rules'); panel.route = { prefix: '/hausregeln', path: '/window-warning' }; await panel.updateComplete;`);
await p.waitForTimeout(700);
ok((await P(p, `return panel._tab;`)) === 'alarm', 'Direktlink bei ausgeschalteter Fenster-Warnung: Bereich öffnet trotzdem');
await closeAll(p);
await P(p, `panel.route = undefined; await panel.updateComplete;`);
await P(p, `await panel.store.featuresSet({ alarm: true, window_warning: true });`);

// Räume anordnen: one order for all pages, hiding per page
await tab(p, 'light');
const count = (t) => view(p, t, `return v.shadowRoot.querySelectorAll('.rl-tile .rl-open').length;`);
const lightBefore = await count('hr-light-plans');
const first = await P(p, `return panel.store.orderedRooms('light')[0].id;`);
await P(p, `await panel.store.saveUi({ room_hidden: { light: [${JSON.stringify(first)}] } }); await panel.updateComplete;`);
await p.waitForTimeout(300);
const lightAfter = await count('hr-light-plans');
await tab(p, 'rooms');
const roomsShown = await P(p, `return panel.store.orderedRooms('rooms').some((r) => r.id === ${JSON.stringify(first)});`);
ok(lightAfter === lightBefore - 1 && roomsShown, 'Raum auf „Licht“ ausgeblendet: dort eine Kachel weniger, auf „Räume“ weiter da', { lightBefore, lightAfter, roomsShown });
const ids = await P(p, `return panel.store.orderedRooms().map((r) => r.id);`);
await P(p, `await panel.store.saveUi({ room_hidden: {}, room_order: ${JSON.stringify([...ids].reverse())} });`);
const orders = await P(p, `return ['light', 'heat', 'rooms', 'devices'].map((pg) => panel.store.orderedRooms(pg)[0].id);`);
ok(orders.every((x) => x === ids[ids.length - 1]), 'Reihenfolge gilt auf allen Seiten', orders);
await P(p, `await panel.store.saveUi({ room_order: [] });`);
// "Raum einstellen": one pop-up, opened by an event from anywhere
await P(p, `panel.shadowRoot.querySelector('[data-view]').dispatchEvent(new CustomEvent('hr-room-settings', { detail: { id: ${JSON.stringify(first)} }, bubbles: true, composed: true })); await panel.updateComplete;`);
await p.waitForTimeout(500);
ok((await p.locator('hr-room-settings hr-pop').count()) === 1, '„Raum einstellen“ öffnet sich über das Ereignis hr-room-settings');
await closeAll(p);

// rules: grouped by topic, the kind filter only with own groups, describe box shows its examples only while writing
await tab(p, 'rules');
const kindChips = () => view(p, 'hr-rules-view', `return /Art/.test([...v.shadowRoot.querySelectorAll('.filters, .filter, [class*=chips]')].map((x) => x.textContent).join(' '));`);
ok((await kindChips()) === false, 'Regeln (automatisch gruppiert): kein Filter nach Art');
await P(p, `await panel.store.saveUi({ grouping: 'manual' });`);
await p.waitForTimeout(300);
ok((await kindChips()) === true, 'Regeln (eigene Gruppen): Filter nach Art');
await P(p, `await panel.store.saveUi({ grouping: 'auto' });`);
await p.locator('house-rules-panel .page-gear').click();
await p.waitForTimeout(400);
ok((await pops(p)).some((h) => /Gruppierung/.test(h ?? '')), 'Regeln: Zahnrad öffnet die Gruppierung', await pops(p));
await closeAll(p);
const ex = (sel) => view(p, 'hr-rules-view', `const e = v.shadowRoot.querySelector('${sel}'); return e ? getComputedStyle(e).display : 'none';`);
ok((await ex('.ask .examples')) === 'none', 'Beschreib-Feld: Beispiele erst beim Schreiben');
await view(p, 'hr-rules-view', `v.shadowRoot.querySelector('#ask')?.focus();`);
await p.waitForTimeout(150);
ok((await ex('.ask .examples')) !== 'none', 'Beschreib-Feld: beim Antippen erscheinen die Beispiele');

// Gruppen
await tab(p, 'devices');
const dv = await view(p, 'hr-devices-view', `return v.shadowRoot.textContent;`);
ok(/Gruppen/.test(dv) && !/Eigene Bereiche|Neuer Bereich/.test(dv), 'Geräte: „Gruppen“ statt „Eigene Bereiche“');
await p.close();

// ------------------------------------------------------------------ phone
p = await open(390, 844);
await tab(p, 'rules');
const gear = await P(p, `const n = panel.shadowRoot.querySelector('nav .gear'); return { nav: getComputedStyle(n).display, head: panel.shadowRoot.querySelectorAll('.head .gear').length };`);
ok(gear.nav !== 'none' && gear.head === 0, 'Telefon: „Einstellungen“ am Ende der Leiste, kein zweites Zahnrad im Kopf', gear);
const cols = await view(p, 'hr-rules-view', `const g = v.shadowRoot.querySelector('.rl-grid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null;`);
ok(cols === 1, 'Telefon: Kacheln einspaltig', cols);
await p.close();

console.log(errors.length ? '• FAIL: Fehler auf der Seite\n' + errors.join('\n') : '  ok: keine Fehler auf der Seite');
if (errors.length) fails++;
await browser.close();
console.log(fails ? `${fails} FEHLER` : 'alles ok');
process.exit(fails ? 1 : 0);
