// "Wer ist wo" in the card's head on the mock harness (no Home Assistant, so also without Hausregeln: zone/state from HA).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/people.mjs [outDir] [light|dark]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const persons = {
  'person.alex': { state: 'home', attributes: { friendly_name: 'Alex Beispiel' } },
  'person.sam': { state: 'not_home', attributes: { friendly_name: 'Sam Beispiel' } },
  'person.kim': { state: 'Arbeit', attributes: { friendly_name: 'Kim Beispiel' } },
};
const cfg = demoHome();

// on by default (persons in HA), off only with people: false
let m = await openMock({ config: { ...cfg, view_mode: '2d' }, states: { ...demoStates(), ...persons }, entities: demoEntities, size: '1024x768', scheme });
await wait(1500);
ok((await m.card('card.shadowRoot.querySelectorAll(".hr-chip.people .pp-av").length')) === 3, 'ohne Einstellung: „Wer ist wo“ ist an');
await m.browser.close();
m = await openMock({ config: { ...cfg, view_mode: '2d', people: false }, states: { ...demoStates(), ...persons }, entities: demoEntities, size: '1024x768', scheme });
await wait(1500);
ok((await m.card('!card.shadowRoot.querySelector(".hr-chip.people")')) === true, 'people: false → kein „Wer ist wo“');
await m.browser.close();

// many people: side by side, the rings (4 px around each picture) never overlap, "+N" beyond four; nothing pushed
// into the weather or the house mode
const many = { ...persons, 'person.lou': { state: 'home', attributes: { friendly_name: 'Lou Beispiel' } }, 'person.mo': { state: 'home', attributes: { friendly_name: 'Mo Beispiel' } } };
for (const size of ['1024x768', '390x844']) {
  m = await openMock({ config: { ...cfg, view_mode: '2d' }, states: { ...demoStates(), ...many }, entities: demoEntities, size, scheme });
  await wait(1500);
  const geo = await m.card(`(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const av = [...card.shadowRoot.querySelectorAll('.hr-chip.people .pp-av')].map(r);
    const chip = card.shadowRoot.querySelector('.hr-chip.people');
    const others = [...card.shadowRoot.querySelectorAll('.chrome.top .left > *')].filter((e) => !e.contains(chip)).map(r);
    return { av, chip: r(chip), others, more: card.shadowRoot.querySelector('.hr-chip.people .pp-n')?.textContent ?? null };
  })()`);
  const RING = 4;
  const overlap = geo.av.some((a, i) => geo.av.some((b, j) => j > i && a.l - RING < b.r + RING && b.l - RING < a.r + RING && a.t < b.b && b.t < a.b));
  ok(geo.av.length === 5 && !overlap, `${size}: 4 Bilder + „+N“ nebeneinander, Ringe überschneiden sich nicht (${geo.av.map((a) => Math.round(a.l)).join(', ')})`);
  ok(geo.more === '+1', `${size}: „+1“ für die fünfte Person (${geo.more})`);
  const inChip = geo.av.every((a) => a.l - RING >= geo.chip.l - 0.5 && a.r + RING <= geo.chip.r + 0.5);
  ok(inChip, `${size}: Ringe liegen ganz im Chip`);
  const clash = geo.others.some((o) => o.l < geo.chip.r && geo.chip.l < o.r && o.t < geo.chip.b && geo.chip.t < o.b);
  ok(!clash, `${size}: nichts überdeckt Wetter oder Hausmodus`);
  await m.page.screenshot({ path: `${out}/people-many-${size}-${scheme}.png` });
  await m.browser.close();
}

m = await openMock({ config: { ...cfg, view_mode: '2d', people: true }, states: { ...demoStates(), ...persons }, entities: demoEntities, size: '1024x768', scheme });
await wait(1500);
ok((await m.card('card.shadowRoot.querySelectorAll(".hr-chip.people .pp-av").length')) === 3, 'drei Personen im Kopf');
ok((await m.card('card.shadowRoot.querySelectorAll(".hr-chip.people .pp-av.home").length')) === 1, 'grüner Ring für die Person zuhause');
await m.page.evaluate(`document.querySelector('floorplan-card').shadowRoot.querySelector('.hr-chip.people').click()`);
await wait(400);
const lines = await m.card('[...card.shadowRoot.querySelectorAll(".hr-menu.people .pp-text")].map((e) => e.querySelector("b").textContent + " " + e.querySelector("small").textContent)');
ok(JSON.stringify(lines) === JSON.stringify(['Alex Zuhause', 'Sam Unterwegs', 'Kim Arbeit']), `Liste: ${JSON.stringify(lines)}`);
await m.page.screenshot({ path: `${out}/people-${scheme}.png` });
ok((await m.card('!card.shadowRoot.querySelector(".pp-trips, .pp-away")')) === true, 'ohne Hausregeln: kein Unterwegs-Panel');
await m.browser.close();

// with Hausregeln: who is on the way is pulled out of the group; the panel below says how, where to and how long
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
const hrPersons = [
  { entity_id: 'person.alex', name: 'Alex', state: 'zone', place: 'home', line: 'Zuhause · seit 8:00' },
  { entity_id: 'person.sam', name: 'Sam', state: 'moving', line: 'Unterwegs · wahrscheinlich nach Hause · ca. 12 Min.', since: iso(-14), speed_kmh: 46, mode: 'car', mode_confidence: 0.9, updated: iso(-1), prediction: { destination: 'home', name: 'Zuhause', probability: 0.8, eta_min: 12, distance_km: 7.4 } },
  { entity_id: 'person.kim', name: 'Kim', state: 'moving', line: 'Unterwegs seit 9:10', since: iso(-5), speed_kmh: 4, mode: 'walk', mode_confidence: 0.5, updated: iso(0), prediction: { destination: 'lp_1', name: 'Sportplatz', probability: 0.7, eta_min: 9, distance_km: 0.8, road_km: 1, rough: true } },
  { entity_id: 'person.lou', name: 'Lou', state: 'moving', line: 'Unterwegs', since: iso(-2), mode: null, updated: iso(0), prediction: null },
];
const hr = {
  ws: { 'house_rules/info': { version: 'test', api: 1, loaded: true } },
  subscribe: { 'house_rules/subscribe': { kind: 'snapshot', mode: 'home', rules: [], active: {}, occupancy: {}, features: {}, devices: [], plans: { light: {}, heat: {} }, persons: [], places: { persons: hrPersons } } },
};
m = await openMock({ config: { ...cfg, view_mode: '2d', people: true, house_rules: { mode: false } }, states: { ...demoStates(), ...persons, 'person.lou': { state: 'not_home', attributes: { friendly_name: 'Lou Beispiel' } } }, entities: demoEntities, size: '1024x768', scheme, ...hr });
await wait(1500);
const chip = await m.card('({ group: card.shadowRoot.querySelectorAll(".hr-chip.people .pp-stack:not(.pp-away) .pp-av").length, away: card.shadowRoot.querySelectorAll(".hr-chip.people .pp-away .pp-av").length, modes: [...card.shadowRoot.querySelectorAll(".pp-away .pp-mode")].map((i) => i.icon) })');
ok(chip.group === 1 && chip.away === 3, `Unterwegs aus der Gruppe gelöst (${JSON.stringify(chip)})`);
ok(JSON.stringify(chip.modes) === JSON.stringify(['mdi:car', 'mdi:walk', 'mdi:map-marker-path']), `Fortbewegung am Avatar: ${JSON.stringify(chip.modes)}`);
const rows = await m.card('[...card.shadowRoot.querySelectorAll(".pp-trips .pp-line")].map((r) => ({ icon: r.querySelector("ha-icon").icon, text: r.querySelector(".pp-what").textContent.replace(/\\s+/g, " ").trim(), eta: r.querySelector(".pp-eta")?.textContent ?? "" }))');
ok(rows.length === 3, `Panel: drei Zeilen (${rows.length})`);
ok(rows[0]?.icon === 'mdi:car' && rows[0].text === 'Sam nach Hause' && rows[0].eta === '12 Min.', `Zeile Auto nach Hause: ${JSON.stringify(rows[0])}`);
ok(rows[1]?.icon === 'mdi:walk' && rows[1].text === 'Kim nach Sportplatz' && rows[1].eta === '9 Min.', `Zeile zu Fuß zum Ort: ${JSON.stringify(rows[1])}`);
ok(rows[2]?.icon === 'mdi:map-marker-path' && rows[2].text === 'Lou unterwegs' && rows[2].eta === '', `Zeile ohne Ziel/Art: ${JSON.stringify(rows[2])}`);
// between two positions the minutes count down from the arrival estimated at the last one; past it: "gleich da"
const eta = (n) => m.card(`(async () => { const p = card._hr.places.persons.find((x) => x.entity_id === 'person.kim'); p.prediction = { ...p.prediction, arrive_at: Math.round(Date.now() / 1000) + ${n} }; card._hr = { ...card._hr }; card._tripNow = Date.now(); await card.updateComplete; return card.shadowRoot.querySelectorAll('.pp-trips .pp-eta')[1]?.textContent ?? ''; })()`);
ok((await eta(5 * 60 - 20)) === '5 Min.', 'Ankunft aus der letzten Position zählt herunter (5 Min.)');
ok((await eta(-30)) === 'gleich da', 'Ankunftszeit vorbei, noch unterwegs: „gleich da“');
// the last position is old (the phone went quiet, maybe the person stopped somewhere): no countdown, never "gleich da"
const stale = (n, ago) => m.card(`(async () => { const p = card._hr.places.persons.find((x) => x.entity_id === 'person.kim'); const now = Math.round(Date.now() / 1000); p.prediction = { ...p.prediction, as_of: now - ${ago}, arrive_at: now + ${n} }; card._hr = { ...card._hr }; card._tripNow = Date.now(); await card.updateComplete; return card.shadowRoot.querySelectorAll('.pp-trips .pp-eta')[1]?.textContent ?? ''; })()`);
ok((await stale(-30, 3 * 60)) === 'gleich da', 'frische Position (3 Min.), Zeit vorbei: „gleich da“');
ok((await stale(-30, 15 * 60)) === '', 'letzte Position 15 Min. alt: keine Zeit, kein „gleich da“');
ok((await stale(5 * 60, 15 * 60)) === '', 'letzte Position 15 Min. alt: auch keine Restminuten');
ok((await m.card('!card.shadowRoot.querySelector(".pp-more")')) === true, 'Details erst nach Tippen');
// the building moves down below the panel instead of lying under it
const below = await m.card('(() => { const p = card.shadowRoot.querySelector(".pp-trips").getBoundingClientRect(); const plan = card.shadowRoot.querySelector("fp-plan"); return { inset: plan.insetTop, panel: Math.round(p.bottom - plan.getBoundingClientRect().top) }; })()');
ok(below.inset >= below.panel, `Grundriss rückt unter das Unterwegs-Panel (${JSON.stringify(below)})`);
await m.page.click('floorplan-card .pp-trips .pp-line >> nth=0');
await wait(300);
const more = await m.card('Object.fromEntries([...card.shadowRoot.querySelectorAll(".pp-more dt")].map((d) => [d.textContent, d.nextElementSibling.textContent]))');
ok(more.Ziel === 'Zuhause' && /^ca\. \d{1,2}:\d{2} Uhr$/.test(more.Ankunft ?? '') && more['Noch (Luftlinie)'] === '7,4 km' && more.Tempo === '46 km/h' && more.Fortbewegung === 'Auto' && !!more['Unterwegs seit'] && !!more['Letzte Meldung'], `Details: ${JSON.stringify(more)}`);
await m.page.screenshot({ path: `${out}/people-trips-${scheme}.png` });
await m.page.click('floorplan-card .pp-trips .pp-line >> nth=0');
await wait(200);
ok((await m.card('!card.shadowRoot.querySelector(".pp-more")')) === true, 'nochmal tippen: Details zu');
// a rough estimate: the way by road (estimated) and the clock rounded to 5 minutes (Kim fresh again)
await stale(9 * 60 + 7, 30);
await m.page.click('floorplan-card .pp-trips .pp-line >> nth=1');
await wait(300);
const kim = await m.card('Object.fromEntries([...card.shadowRoot.querySelectorAll(".pp-more dt")].map((d) => [d.textContent, d.nextElementSibling.textContent]))');
const kimMin = Number((kim.Ankunft ?? '').match(/:(\d{2})/)?.[1]);
ok(kim['Noch ca. (Straße, geschätzt)'] === '1,0 km' && !kim['Noch (Luftlinie)'] && kimMin % 5 === 0, `grobe Schätzung: Weg auf der Straße, Uhrzeit auf 5 Min. gerundet: ${JSON.stringify(kim)}`);
await m.page.click('floorplan-card .pp-trips .pp-line >> nth=1');
await wait(200);
// the menu covers the panel while it is open
await m.page.evaluate(`document.querySelector('floorplan-card').shadowRoot.querySelector('.hr-chip.people').click()`);
await wait(300);
ok((await m.card('!!card.shadowRoot.querySelector(".hr-menu.people") && !card.shadowRoot.querySelector(".pp-trips")')) === true, 'Liste offen: Panel solange weg');
await wait(300);
ok((await m.card('card.shadowRoot.querySelector("fp-plan").insetTop')) === 0, 'Panel weg: Grundriss wieder in der Mitte');
ok(!m.errors.length, `keine Konsolenfehler ${m.errors.join(' | ')}`);
await m.browser.close();

m = await openMock({ config: { ...cfg, view_mode: '2d', people: true }, states: { ...demoStates(), ...persons }, entities: demoEntities, size: '1024x768', scheme, language: 'en', ...hr });
await wait(1500);
const en = await m.card('[...card.shadowRoot.querySelectorAll(".pp-trips .pp-line")].map((r) => r.querySelector(".pp-what").textContent.replace(/\\s+/g, " ").trim() + " " + (r.querySelector(".pp-eta")?.textContent ?? ""))');
ok(en[0] === 'Sam heading home 12 min' && en[1] === 'Kim to Sportplatz 9 min', `englisch: ${JSON.stringify(en)}`);
// house mode: only the symbol, the name as tooltip and for screen readers, the active one highlighted
const chipM = await m.card('(() => { const b = card.shadowRoot.querySelector(".hr-chip.mode-chip"); return b && { text: b.textContent.trim(), label: b.getAttribute("aria-label"), title: b.title }; })()');
ok(chipM?.text === '' && chipM.label === 'House mode: Home' && chipM.title === 'House mode: Home', `Hausmodus-Chip nur Symbol, Name als Tooltip/aria-label: ${JSON.stringify(chipM)}`);
await m.page.click('floorplan-card .hr-chip.mode-chip');
await wait(300);
const items = await m.card('[...card.shadowRoot.querySelectorAll(".hr-menu.modes .hr-item")].map((b) => ({ text: b.textContent.trim(), label: b.getAttribute("aria-label"), title: b.title, on: b.getAttribute("aria-checked") === "true" && b.classList.contains("on") }))');
ok(items.length === 5 && items.every((x) => x.text === '' && x.label && x.title === x.label), `Modus-Auswahl: fünf Symbole mit Namen als Tooltip: ${JSON.stringify(items)}`);
ok(items.filter((x) => x.on).length === 1 && items.find((x) => x.on)?.label === 'Home', 'aktiver Modus hervorgehoben');
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
