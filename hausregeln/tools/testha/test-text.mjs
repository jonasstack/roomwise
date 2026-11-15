// How well does text → rule work? Runs sentences through house_rules/from_text (Ollama if configured,
// else the simple parser) and checks the important parts. Usage: node tools/testha/test-text.mjs [ollama-url model]
import { token, wsConnect, ok, failures } from './lib.mjs';
const tok = await token();
const ws = await wsConnect(tok);
const [url, model] = process.argv.slice(2);
await ws.call({ type: 'house_rules/settings/set', settings: { ollama: url ? { url, model, enabled: true } : { enabled: false } } });

const CASES = [
  ['Wenn die Haustür aufgeht, mach das Flurlicht an', (r) => r.when[0]?.subject === 'binary_sensor.haustuer' && r.when[0]?.verb === 'opens' && r.then.some((c) => c.subject === 'light.flurlicht' && c.verb === 'turn_on')],
  ['Solange im Bad das Fenster offen ist, Heizung aus', (r) => r.type === 'while' && /window/.test(r.when[0]?.subject) && r.then.some((c) => /climate/.test(c.subject) && c.verb === 'turn_off')],
  ['Wenn alle weg sind, Staubsauger starten', (r) => r.when[0]?.subject === 'person:everyone' && r.then.some((c) => c.subject === 'vacuum.robo')],
  ['Wenn der Wassermelder Wasser meldet, schick allen eine Nachricht', (r) => /leak|wasser/.test(r.when[0]?.subject) && r.then.some((c) => c.subject.startsWith('notify:'))],
  ['Wenn jemand in die Küche kommt, Küchenlicht an', (r) => /kuche|kueche|fp2/.test(r.when[0]?.subject ?? '') && r.then.some((c) => /kuechenlicht|light@kuche/.test(c.subject))],
  ['Wenn der Wasserkocher länger als 10 Minuten an ist, ausschalten', (r) => r.when[0]?.subject === 'switch.wasserkocher' && r.when[0]?.verb === 'on_for' && r.then.some((c) => c.subject === 'switch.wasserkocher' && c.verb === 'turn_off')],
  ['Um 7 Uhr Heizung Bad auf 22 Grad', (r) => r.when[0]?.subject === 'time' && r.then.some((c) => /heizung_bad|climate/.test(c.subject))],
  // English sentences (the test house has German names): parse_en.py, language from the text
  ['When the Haustür opens after sunset, turn on the Flurlicht for 5 minutes', (r) => r.when[0]?.subject === 'binary_sensor.haustuer' && r.when[0]?.verb === 'opens' && r.only.some((c) => c.subject === 'sun' && c.verb === 'is_down') && r.then.some((c) => c.subject === 'light.flurlicht' && c.verb === 'turn_on' && c.for === '5m')],
  ['When everyone is away, start the robot vacuum', (r) => r.when[0]?.subject === 'person:everyone' && r.then.some((c) => c.subject === 'vacuum.robo')],
  ['When the Wasserkocher has been on for more than 10 minutes, turn it off', (r) => r.when[0]?.subject === 'switch.wasserkocher' && r.when[0]?.verb === 'on_for' && r.then.some((c) => c.subject === 'switch.wasserkocher' && c.verb === 'turn_off')],
];
for (const [text, check] of CASES) {
  const t0 = Date.now();
  const d = await ws.call({ type: 'house_rules/from_text', text }).catch((e) => ({ error: e.message }));
  const good = !d.error && check(d.rule);
  ok(good, `${text}  [${d.source ?? d.error}, ${((Date.now() - t0) / 1000).toFixed(1)} s]`, d.rule ? { when: d.rule.when, then: d.rule.then, unsure: d.unsure } : d);
  if (good) console.log('       →', d.sentence);
}
await ws.call({ type: 'house_rules/settings/set', settings: { ollama: { enabled: false } } });
console.log(failures() ? `${failures()} nicht erkannt` : 'alle erkannt');
ws.close();
