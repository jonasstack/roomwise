# Hausregeln: Schnittstelle für die Grundriss-Karte (und andere Oberflächen)

Diese Datei ist der Schnittstellen-Vertrag zwischen Hausregeln und der Grundriss-Karte von roomwise (Ordner `src/` dieses Repositorys).
Sie beschreibt alles, was die Karte von der Integration **Hausregeln** (`custom_components/house_rules`, Domain `house_rules`)
nutzen kann: fertige Oberflächen-Elemente zum Einbetten, das Regelformat, alle Websocket-Befehle, Live-Updates,
Entitäten, Ereignisse und Dienste. API-Version: **1** (steht in `house_rules/info`).

> Code: `hausregeln/custom_components/house_rules` (Integration) und `hausregeln/src` (Oberfläche) in diesem Repository.

---

## 1. Was Hausregeln ist (in drei Sätzen)

Automationen als deutsche Sätze: **Wenn** die Haustür aufgeht **und** es dunkel ist, **dann** Flurlicht an, **nur** abends.
Dazu: Räume mit Anwesenheit (aus Präsenz-/Bewegungssensoren und Zonen), Gruppen („Heizung“, „Fernseher“; früher „eigene Bereiche“, Schlüssel `groups`),
Orte (HA-Zonen), Hausmodus (Zuhause/Weg/Schlafen/Urlaub/Gäste), Alarmanlage, Verlauf mit „warum“.
Die Integration hat eine eigene Seite in der HA-Seitenleiste (`/hausregeln`) und liefert dieselben Bausteine zum Einbetten.

---

## 2. Schnellstart für die Karte

### 2.1 Ist Hausregeln da?

```ts
const info = await hass.callWS<{ version: string; api: number; loaded: boolean }>({ type: 'house_rules/info' })
  .catch(() => null);          // Fehler "unknown_command" = nicht installiert → Funktionen ausblenden
const available = !!info?.loaded && info.api === 1;
```

### 2.2 Die Oberfläche laden (einmal pro Seite)

Die Integration liefert ein ES-Modul. Es definiert die Elemente unten und registriert nichts doppelt.

```ts
if (!customElements.get('house-rules-device')) await import('/house_rules_static/house-rules-panel.js');
```

Alle Elemente bekommen nur `.hass` (das normale HA-Objekt). Sie teilen sich automatisch **eine** Live-Verbindung
(`house_rules/subscribe`), egal wie viele Elemente offen sind.

### 2.3 Variante A (empfohlen): Gerät antippen → alles zu diesem Gerät

```ts
const el = document.createElement('house-rules-device');
el.setAttribute('standalone', '');        // eigene Design-Tokens + öffnet den Regel-Editor selbst
el.setAttribute('entity-id', 'light.flurlicht');
el.closable = true;                       // zeigt ein ✕, feuert dann "close"
el.hass = hass;                           // bei jedem hass-Update erneut setzen
el.toggleAttribute('dark', hass.themes?.darkMode);
el.addEventListener('close', () => closePopup());
popupBody.append(el);                     // braucht eine Höhe: display:flex; flex-direction:column; height/max-height
```

Das Element zeigt: welche Regeln das Gerät **startet**, wo es **geprüft** wird, wer es **schaltet**, die bestehenden
HA-Automationen dazu (mit An/Aus-Schalter), „Warum hat es sich zuletzt geändert?“ und Schnellstarts
(„Wenn Haustür aufgeht …“, „Solange …“, „… dann Flurlicht einschalten“). Ein Tipp auf eine Regel oder einen
Schnellstart öffnet den Satz-Editor **im selben Element** (wegen `standalone`). Gespeichert wird direkt in Hausregeln.

Ohne `standalone` feuert das Element stattdessen `hr-open-rule` (siehe 2.5), damit die Karte den Editor selbst zeigt.

### 2.4 Variante B: nur der Satz-Editor

```ts
const ed = document.createElement('house-rules-editor');
ed.setAttribute('standalone', '');
ed.hass = hass;
ed.isNew = true;
ed.rule = {                               // optional: vorbefüllt (Format siehe Kapitel 3)
  id: '', name: '', type: 'when',
  when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }],
  and: [], then: [], only: [], enabled: true, options: {},
};
ed.addEventListener('rule-saved', (e) => { /* e.detail.rule */ closePopup(); });
ed.addEventListener('closed', () => closePopup());
```

Bestehende Regel bearbeiten: `ed.rule = rule` aus `house_rules/snapshot` bzw. dem Abo, `isNew = false`.

### 2.5 Ereignisse der Elemente (alle `bubbles` + `composed`)

| Ereignis | detail | Bedeutung |
|---|---|---|
| `hr-open-rule` | `{ rule?: Rule, isNew?: boolean }` | Nutzer will eine Regel öffnen/anlegen (nur ohne `standalone` relevant) |
| `hr-open-device` | `{ entity_id }` | Nutzer tippt ein Gerät an (Verlauf, Geräteliste) |
| `hr-open-room` | `{ id }` | Raum antippen (area_id) |
| `rule-saved` | `{ rule }` | Editor hat gespeichert |
| `closed` | – | Editor „Abbrechen“ |
| `close` | – | Geräte-Element ✕ |

### 2.6 Die ganze Seite einbetten

`<house-rules-panel>` ist die komplette Seite. Bereiche (seit 2026-10-25): **Regeln · Licht · Heizung · Alarmanlage** (die drei nur, wenn die Funktion an ist)
**· Zuhause** (Wo ist wer mit Schalter „zählt mit“ je Person, Hausmodus, Orte, Status von Urlaub und Gästen) **· Räume** (Anwesenheit; Saugroboter-Pause hinter dem Zahnrad) **· Geräte** (Gruppen, alle Geräte)
**· Verlauf · Einstellungen** (Funktionen, Einrichtung, Urlaubsmodus, Wörter in Regeln, Benachrichtigungen, Rollen, KI, Grundriss-Karte, Sichern & Wiederherstellen, Papierkorb, Diagnosedaten, Entfernen). Die Alarmanlage enthält auch die Fenster-Warnung und ist sichtbar, solange eins von beiden an ist. Beim ersten Start öffnet sich der Einrichtungsassistent.
Seit 2026-11-14 (neues Design): jeder Bereich zeigt gleich große Kacheln, Antippen öffnet ein Pop-up (`<hr-pop>`). Der Seitenkopf zeigt Titel, Unterzeile, einen Hausmodus-Knopf (Pop-up zum Umschalten), wo vorhanden ein Seiten-Zahnrad und „Zum Grundriss“. Räume, Licht und Heizung öffnen für die Sensoren eines Raums dasselbe Pop-up „Raum einstellen“ (Ereignis `hr-room-settings` mit `{ id }`, intern). Licht, Heizung, Räume und Geräte zeigen die Räume in einer gemeinsamen Reihenfolge („Räume anordnen“, gespeichert in `settings.ui`, siehe `house_rules/ui/set`).
Direktlinks (Panel-Route): `/hausregeln/<bereich>` (`rules`, `light`, `heat`, `home`, `rooms`, `devices`, `history`, `settings`), `/hausregeln/setup` (Assistent), `/hausregeln/alarm` ist die Alarm-Zentrale; an eine Stelle: `/hausregeln/window-warning` (auch der alte `/hausregeln/home/window-warning`), `/hausregeln/residents`; `/hausregeln/vacation` führt auf `settings#urlaub`. Die Einstellungen öffnen ihre Pop-ups mit `settings#<stelle>`: `urlaub`, `woerter`, `features`, `setup`, `notifications`, `roles`, `ai`, `floorplan`, `backup`, `trash`, `telemetry`, `remove`.
`.hass` setzen, fertig. Für einen Vollbild-Dialog im Tablet-Dashboard möglich, normalerweise reicht die Seitenleiste.

### 2.7 Aussehen

Gleiche Designsprache wie die Karte (iOS-Palette, 4-pt-Raster). Tokens heißen `--hr-*` und hängen an `:host([standalone])`,
Dunkelmodus über das Attribut `dark`. Satzfarben: Wenn orange (`--hr-when`), Solange lila (`--hr-while`),
und türkis (`--hr-and`), dann blau (`--hr-then`), nur indigo (`--hr-only`). Wer die Farben im Plan wiederverwenden will
(z. B. Linien zwischen Auslöser und Aktion), nimmt dieselben Werte: `#f08a00`, `#a24fd6`, `#1a9fb5`, `#007aff`, `#5856d6`
(dunkel: `#ff9f0a`, `#c77dff`, `#40c8e0`, `#3d9bff`, `#8e8cff`).

Popups/Sheets der Elemente sind `position: fixed`. Die Karte hängt Popups bereits an `document.body` (Portal) – dort einbetten.

---

## 3. Das Regelformat

Absichtlich flach, damit auch ein kleines Sprachmodell es schreiben kann. Jeder Satzteil ist eine **Klausel**:
`{ subject, verb, ...werte }`.

```json
{
  "id": "r_8f2c1a",
  "name": "Licht beim Heimkommen",
  "type": "when",
  "when": [{ "subject": "binary_sensor.haustuer", "verb": "opens" }],
  "and":  [{ "subject": "person:everyone", "verb": "is_away" }],
  "then": [
    { "subject": "light.flurlicht", "verb": "turn_on", "brightness": 70, "for": "5m" },
    { "subject": "notify:alex", "verb": "send", "message": "Haustür ist aufgegangen." }
  ],
  "only": [{ "subject": "sun", "verb": "is_down" }],
  "enabled": true,
  "paused_until": null,
  "options": { "cooldown": "", "manual_pause": "", "notify_me": false, "allow_sensitive": false, "ai_check": false, "restore": true },
  "tags": ["light", "presence"],
  "meta": { "origin": "user", "created": "…", "last_run": "…", "runs_week": 3, "replaces": [] }
}
```

| Feld | Bedeutung |
|---|---|
| `type` | `when` = läuft einmal, wenn ein Auslöser kommt. `while` = **Solange**: gilt, solange alle `when`-Klauseln stimmen; danach stellt Hausregeln alles zurück (außer was jemand inzwischen von Hand geändert hat), außer `options.restore: false`. |
| `else` | nur bei `while` (**„Wechselnd“**): Schritte, sobald es nicht mehr gilt, statt zurückzustellen, z. B. belegt: Licht an, sonst: Licht aus. Fehlt das Feld, ist es eine normale Solange-Regel; `else: []` = Wechselnd ohne Schritte. |
| `when` | `type=when`: Auslöser (**oder**-verknüpft, Verben mit `flavour: event`). `type=while`: Zustände (**und**-verknüpft, `flavour: state`). |
| `and` | zusätzliche Bedingungen (Zustände). Jede Bedingung (auch in `only` und im `when` von Solange-Regeln) kann `"or": [Klauseln]` haben: eine davon reicht, z. B. `{ "subject": "room:wohnzimmer", "verb": "is_dark", "or": [{ "subject": "light.sofa", "verb": "is_on" }] }` |
| `then` | Schritte der Reihe nach (`flavour: action`). `"for": "5m"` an einer Aktion = danach zurückstellen. |
| `only` | Grenzen: Zeit, Hausmodus, Sonne … (Zustände) |
| `options.cooldown` | höchstens alle … (`"30m"`, `"1h"`, `"1d"`, leer = immer) |
| `options.manual_pause` | wenn jemand von Hand schaltet, dieses Gerät … in Ruhe lassen (`""`, `"30m"`, `"1h"`, `"room_empty"`) |
| `options.allow_sensitive` | erlaubt Schlösser aufschließen / Alarm ausschalten |
| `options.restore` | Solange-Regeln: danach wieder herstellen (Standard `true`) |
| `options.ai_check` | die KI schaut vor jedem Lauf drüber |
| `options.mode` | löst die Regel erneut aus, während sie noch läuft: `single` (Standard: der neue Lauf fällt weg), `restart` (der laufende hört auf), `queued` (der neue wartet), `parallel` (beide laufen); `options.max` (queued/parallel, Standard 10) – wie `mode` einer HA-Automation |
| `tags` | werden von der Integration gesetzt (light, heating, presence, safety, media, cleaning, energy) |
| `group` | optional: Kennung einer eigenen Gruppe der Regelseite (`g_…`, 1–30 Zeichen `a-z0-9_`, etwa „Abendroutine“). Nur für die Anzeige; die Gruppen selbst stehen in `settings.ui.groups` (siehe `house_rules/ui/set`). Ungültige Werte fallen beim Speichern weg |
| `meta.origin` | woher die Regel kommt, z. B. `user`; `room` = entstand einmalig aus einem früheren Raumverhalten (siehe `behaviour/set`) |

Dauern: `"30s"`, `"5m"`, `"1h"`, `"1d"`. Uhrzeiten: `"07:00"`. Versatz bei Sonne: `"-30m"` / `"15m"`.

### 3.1 Subjekte

| Subjekt | Bedeutung | Beispiel |
|---|---|---|
| `<entity_id>` | ein Gerät, **auch jede andere HA-Entität** (Art = ihre Domain, siehe 3.2) | `light.flurlicht`, `input_select.waschprogramm` |
| `any:<kind>[@<raum>]` | irgendein Gerät dieser Art (auch neue) | `any:window`, `any:window@kuche` |
| `all:<kind>[@<raum>]` | alle Geräte dieser Art | `all:light@wohnzimmer` |
| `…@same` | **im selben Raum** wie das auslösende Gerät; bei Solange-Regeln läuft die Regel je Raum | `all:climate@same` |
| `room:<area_id>` | ein Raum (seine Anwesenheit) | `room:flur` |
| `zone:<entity_id>` | eine Zone **im Raum** (z. B. FP2-Bereich „Sofa“) | `zone:binary_sensor.praesenz_wohnzimmer_zone_3` |
| `group:<id>` | eigener Bereich („Heizung“, „Fernseher“) | `group:g_3fa21c` |
| `person:<id>` / `person:someone` / `person:everyone` | Personen (id = object_id der person-Entität) | `person:alex` |
| `notify:<person>` / `notify:everyone` | Nachricht an die Handys | `notify:sam` |
| `time`, `sun`, `mode`, `wait` | Uhrzeit/Zeitfenster, Sonne, Hausmodus, Pause zwischen Schritten | |
| `alarm` | die Alarmanlage | |
| `rule:<id>` | eine andere Regel (verknüpfen) | `rule:r_8f2c1a` |

Achtung bei den Namen: `zone:` meint die Bereiche **eines Präsenzsensors im Raum**. HA-Zonen (Orte wie „Arbeit“)
stecken im Wert `zone` der Personen-Verben (`enters_zone`, `leaves_zone`, `in_zone`, `not_in_zone`), z. B.
`{ "subject": "person:alex", "verb": "leaves_zone", "zone": "alex_arbeit" }` (Wert = object_id von `zone.alex_arbeit`, `home` = Zuhause).

### 3.2 Arten und Verben

Die vollständige, maschinenlesbare Liste liefert `house_rules/vocabulary` (gleich `custom_components/house_rules/vocabulary.json`,
erzeugt aus `src/vocabulary.ts`). Jede Art hat `label`, `plural`, `any` („irgendein Fenster“), `icon` (SVG-Pfad) und Verben mit
`id`, `flavour` (`event` | `state` | `action`), `label` (deutscher Nebensatz, z. B. „aufgeht“), `pl` (Plural),
`params` (`key`, `type`, `label`, `default`, `min`, `max`, `step`, `unit`), `hint`, `sensitive`.
Die englischen Wörter stehen daneben unter `en: { kinds, modes }` (gleiche ids, nur `label`, `plural`, `any`, Verben als
`{ verb-id: { label, pl, hint, params: { key: label } } }`, Quelle `src/vocabulary-en.ts`). Englische Aktionen sagen mit `{s}`, wo
das Subjekt steht („turn on {s}“); ohne `{s}` steht das Subjekt vorn.

Arten: `light, window, door, motion, zone, presence, room, climate, cover, media, switch, outlet, script, fan, purifier,
leak, temperature, illuminance, lock, vehicle, vacuum, person, time, sun, mode, notify, wait, group, alarm, rule`.
`vehicle` (Fahrzeug) ist der GPS-Tracker eines Autos, E-Bikes oder Trackers: `arrives`, `leaves`, `is_home`, `is_away`.

Dazu **Domain-Arten** für alle anderen Entitäten (Art = Domain, unbekannte Domains = `entity`): `binary_sensor`, `sensor`,
`number`, `input_number`, `select`, `input_select`, `input_text`, `button`, `input_button`, `scene`, `input_boolean`, `siren`,
`humidifier`, `water_heater`, `automation`, `camera`, `device_tracker`, `event`, `media_player`, `entity`. Wichtige Verben:
`changes` (jede Änderung), `becomes`/`is`/`is_not` (Wert `state`), `above`/`below`/`is_above`/`is_below` (Wert `value`),
`pressed`/`press` (Knöpfe), `activated`/`activate` (Szenen), `select` (`state`), `set_value` (`value`), `set_text`, `trigger` (HA-Automation).

Häufige Verben (Auszug):

| Art | Ereignis (`when`) | Zustand (`and`/`only`/Solange) | Aktion (`then`) |
|---|---|---|---|
| window/door | `opens`, `closes`, `open_for` | `is_open`, `is_closed` | – |
| light | `turns_on`, `turns_off`, `on_for` | `is_on`, `is_off` | `turn_on` (+`brightness`), `turn_off`, `toggle`, `dim`, `color`, `blink` |
| room | `entered`, `empty`, `empty_for` | `is_occupied`, `is_empty`, `is_dark` | – |
| presence/zone | `occupied`, `free_for` | `is_occupied`, `is_free` | – |
| climate | `starts_heating` | `is_heating` | `set_temp`, `eco`, `turn_off`, `boost` |
| person | `arrives`, `leaves`, `coming_home` (`distance` km, Standard 2), `enters_zone`, `leaves_zone`, `far_from` (`distance` km, `zone`), `heading_home` (`value` %, Standard 60), `arrives_within` (`value` Min., Standard 10), `moving_for` (`value` Min., Standard 30) | `is_home`, `is_away`, `is_near` (`distance`), `in_zone`, `not_in_zone`, `is_far`, `is_heading_home`, `is_arriving_within`, `is_moving_for` | – |
| time | `at` (`time`) | `night`, `morning`, `evening`, `workdays`, `weekend`, `between` | – |
| sun | `sets`, `rises` (`offset`) | `is_down`, `is_up` | – |
| mode | `changes_to` (`mode`) | `is`, `is_not` | `set` |
| notify | – | – | `send`, `ask` (Ja/Nein, wartet), `alarm` (kritisch) |
| alarm | `triggered`, `armed`, `disarmed` | `is_armed`, `is_disarmed`, `is_triggered` | `arm_away`, `arm_night`, `arm_home`, `disarm`, `trigger` |
| rule | `ran` | `is_active` | `run`, `pause` |
| wait | – | – | `wait` (`for`), `wait_until_empty` |

**Orte und Vorhersagen (places.py, „Wo ist wer“).** `zone` in `enters_zone`/`leaves_zone`/`in_zone`/`not_in_zone` ist eine
Zonen-Id (`home`, `arbeit` …) **oder ein gelernter Ort** (`lp_…`, siehe `house_rules/places/get`). `heading_home`/`is_heading_home`:
die Vorhersage sagt „nach Hause“ mit mindestens `value` % Sicherheit (gelernt aus Startort, Wochentag, Uhrzeit und Richtung früherer
Wege; ohne Gelerntes nur „kommt näher und fährt Richtung Zuhause“, höchstens 70 %). `arrives_within`: Vorhersage Zuhause (≥ 50 %) und
geschätzte Ankunft ≤ `value` Minuten (Dauer früherer Wege, angepasst an Restweg und Tempo). `moving_for`: unterwegs (weder in einer Zone
noch an einem Ort stehen geblieben) seit mindestens `value` Minuten. `coming_home`/`is_near`: näher als `distance` km und entfernt sich
nicht (ohne Richtungsdaten: nur die Entfernung). Mit `person:everyone` zählen bei den Heimweg-Verben nur, wer nicht zuhause ist
(„alle sind auf dem Heimweg“). Diese Bausteine prüfen die Regeln bei jeder verarbeiteten Position und einmal pro Minute.

**Satzerkennung:** die Wendungen dafür stehen datengetrieben in `vocabulary.json` → `phrases.<sprache>`
(`{ re, event, state, params?, number?, place? }`, Quelle `PHRASES` in `src/vocabulary.ts`); eine weitere Sprache ergänzt nur Einträge.

### 3.2a Erweiterte Logik („Erweitert“, `logic.py`)

Alles ist eine Klausel mit `subject: "logic"`, verschachtelt bis 5 Ebenen, Listen bis 20 Einträge; alte Regeln bleiben, wie sie sind.

| Klausel | Bedeutung |
|---|---|
| `{ verb: "all" \| "any" \| "not", items: [Klauseln] }` | Bedingungsgruppe: alle / eine / keine davon (in `and`, `only`, im `when` von Solange-Regeln, in Lichtregeln) |
| `{ verb: "if", if: [Bedingungen], then: [Schritte], else: [Schritte] }` | Wenn/Sonst (Schritt) |
| `{ verb: "choose", cases: [{ trigger: [ids], when: [Bedingungen], then: [Schritte] }], else: [Schritte] }` | der erste passende Fall läuft; `trigger` = Kennungen der Auslöser (leer = egal) |
| `{ verb: "repeat", count: n \| while: [Bed.] \| until: [Bed.], then: [Schritte] }` | wiederholen (höchstens 100 Runden) |
| `{ verb: "parallel", then: [Schritte] }` | alle Schritte gleichzeitig, weiter wenn alle fertig |
| `{ verb: "wait_until", items: [Bedingungen], timeout: "5m", continue: true }` | warten, bis alle stimmen (`continue: false` = nach der Zeitgrenze aufhören) |
| `{ verb: "wait_trigger", items: [Auslöser], timeout, continue }` | warten, bis einer der Auslöser kommt (Geräte, Räume, `ha_event`) |
| `{ verb: "set", name, from: "trigger" \| entity_id, attr?, in_min?, in_max?, out_min?, out_max? }` | einen Wert merken (optional linear umgerechnet, begrenzt) |
| `{ verb: "stop" }` | hier aufhören |

Auslöser bekommen mit `"id": "…"` eine Kennung (für `choose`). Werte eines Schritts können `"$trigger"` (Zustand des Auslösers),
`"$trigger.<Attribut>"`, `"$trigger.event.<Schlüssel>"` (Daten eines HA-Ereignisses) oder `"$<name>"` (ein `set`-Wert) sein, z. B.
`{ "subject": "light.x", "verb": "turn_on", "brightness": "$level" }`. Weitere Bausteine: Auslöser `{ subject: "ha_event", verb: "fired",
event_type, event_data: "k=v, k2=v2" }` (Ereignis auf dem Bus, `state_changed` nie) und `{ subject: "event.<id>", verb: "fired", event_type }`
(Ereignis-Entität dieser Art, z. B. `double_press`); Zahlen `is_between` / `between` (`min`, `max`, bei Lichtern die Helligkeit in %);
Zeit `weekdays` (`days: "mon,tue,…"`); Sonne `after_sunset`, `before_sunset`, `after_sunrise`, `before_sunrise` (`offset`). „Seit N Minuten“
ist `for` an jeder Bedingung.

**Licht einstellen** (`{ subject: <Licht>, verb: "set", light: LightSetting }`, auch `action`/`variants` der Lichtregeln): LightSetting
`{ mode: on/off/scene, brightness (%), bri (1–255, gewinnt), color, effect (aus `effect_list`), transition (s), flash: short/long,
scene (mode scene), per_light: { entity_id: { mode, brightness, bri, color, effect, transition, flash } } }`. `color`: `kerze`/`warm`/`neutral`/`kalt`,
`k:3200`, `#rrggbb`, `rgbw:r,g,b,w`, `rgbww:r,g,b,cw,ww`, `hs:h,s`, `xy:x,y`, `white` (Weißkanal), `none` (Farbe lassen). Gesendet wird je
Lampe, was ihre `supported_color_modes` können (eigener Modus, sonst umgerechnet; Nur-Weiß-Lampen bekommen den ähnlichsten Weißton,
an/aus-Lampen nur „an“); Effekt, Übergang und Blitz nur, wenn die Lampe sie kann. RGB → xy rechnet wie Home Assistants
`color_RGB_to_xy` („Wide RGB D65“, 3 Nachkommastellen). Die Live-Vorschau der Oberfläche („Live an der Lampe“) läuft über
`house_rules/light/preview` (unten); nur bei einer älteren Integration ohne diesen Befehl (`unknown_command`) ruft die Oberfläche
`light.turn_on`/`turn_off` selbst über Home Assistants `call_service` mit den Rechten des angemeldeten Benutzers auf.

### 3.3 Satzbau

Die Oberfläche setzt Sätze aus `joiner + Subjekt + Verb-Label + Zusätze` zusammen:
„**Wenn** Haustür aufgeht, **dann** Flurlicht einschalten für 5 Min. · 70 % **nur** wenn es draußen dunkel ist.“
Fertige Sätze stehen an jeder Regel im Snapshot (`rule.sentence`, wird bei Änderungen mitgeschickt); für Entwürfe liefert sie `house_rules/rule/describe`, außerdem jeder Regel-Schalter im Attribut `sentence`.

---

## 4. Websocket-Befehle

Alle mit `hass.callWS({ type, ... })`. Jeder Befehl prüft auf dem Server die **Rolle** des Nutzers in Hausregeln
(`permissions.py`, Tabelle `COMMANDS`), egal was eine Oberfläche zeigt; zu wenig Rechte = Fehler `unauthorized` mit einem Satz.

* ohne Zeichen = alle Rollen, auch **Gast** (ansehen und bedienen: Regel jetzt ausführen, Fenster-Warnung bestätigen)
* **(bewohner)** = Bewohner und Admin (Regeln und Pläne anlegen und ändern, Hausmodus, Alarmanlage mit ihrer Bestätigung)
* **(admin)** = nur die Rolle Admin (Einstellungen, Räume, Geräte, Heizung, Licht …)
* **(HA-Admin)** = nur ein echter Admin von Home Assistant, egal welche Rolle er in Hausregeln hat: Sicherheit (Alarmanlage
  einrichten, Face-ID-Geräte verwalten, Weitere Alarme anlegen/löschen/testen, Alarm-Assistent), was Daten aus dem Haus schickt
  (KI-Verbindung, Diagnosedaten), Funktionen schalten, Sicherung zurückspielen, Rollen vergeben und alles, was Home Assistant selbst
  ändert. Eine Rolle in Hausregeln gibt nie mehr Rechte als Home Assistant.

Standard: Admins von Home Assistant sind immer Admin, alle anderen Bewohner. Admins von Home Assistant vergeben die Rollen unter
Einstellungen → Rollen (`house_rules/roles/*`; ansehen dürfen alle Admins). Regeln, die die Alarmanlage schalten oder Schlösser öffnen / den Alarm ausschalten dürfen (`options.allow_sensitive`),
speichern, ändern, löschen, pausieren und an/aus schalten nur Admins; von Hand starten (`rule/run`) nur Admins, wenn sie `allow_sensitive` hat.

Die vollständige Rechte-Tabelle prüft `tools/testha/test-permissions.mjs`. Ein `rule`, das jeder schicken kann (`rule/describe`, `rule/test`, `rule/entities`, `ai/review`, `ai/improve`), darf als JSON höchstens 64 kB groß sein, sonst `invalid_format`.

### Lesen

| Befehl | Parameter | Antwort |
|---|---|---|
| `house_rules/info` | – | `{ version, api, loaded }` |
| `house_rules/snapshot` | – | alles auf einmal (siehe 5.1) |
| `house_rules/subscribe` | – | Abo: erst `snapshot`, dann Änderungen (siehe 5) |
| `house_rules/vocabulary` | – | `{ kinds, modes, en }` (`en`: englische Wörter, siehe oben) |
| `house_rules/for_entity` | `entity_id` | `{ starts: [rule_id], checks: [rule_id], switches: [rule_id], automations: [HaAutomation], history: [Entry], device, subject, kind }` |
| `house_rules/for_entities` | `entity_ids` (Liste, höchstens 1000) | `{ <entity_id>: { starts: [rule_id], checks: [rule_id], switches: [rule_id], automations: [automation entity_id] } }`, ein Aufruf für alle Zähler im Plan, ohne Verlauf |
| `house_rules/rule/entities` | `rule` | je Teil die betroffenen Geräte, Platzhalter aufgelöst: `{ when: [{ subject, entities: [...], room }], and, then, only }` – ideal zum Hervorheben im Plan |
| `house_rules/rule/describe` | `rule` | `{ sentence, clauses: { when: [text], … } }` |
| `house_rules/rule/test` | `rule` | Probelauf ohne Schalten: `{ checks: [{ section, index, ok, now }], would: [text], verdict }` |
| `house_rules/history` | `entity_id?`, `limit?` (≤ 400) | Verlauf, neueste zuerst |
| `house_rules/from_text` **(bewohner)** | `text`, `language`? | Regel-Entwurf aus einem deutschen oder englischen Satz: `{ rule, unsure: [text], source, sentence, language }`. Die Sprache erkennt Hausregeln am Satz; ist er nicht eindeutig, entscheidet `language` (Sprache der Person, z. B. `en`), sonst die von Home Assistant. `unsure` und `sentence` kommen in der Sprache des Satzes. |

### Regeln

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/rule/save` **(bewohner)** | `rule` | legt an oder ersetzt (gleiche `id`); prüft und bereinigt; braucht ≥ 1 `when` und ≥ 1 `then`. Antwort `{ rule, sentence }` |
| `house_rules/rule/delete` **(bewohner)** | `rule_id` | landet im Papierkorb (30 Tage, siehe `trash/*`); Antwort `{ ok }` (`false` = gab es nicht) |
| `house_rules/rule/enable` **(bewohner)** | `rule_id`, `enabled` | an/aus |
| `house_rules/rule/pause` **(bewohner)** | `rule_id`, `minutes?` (0 bis 527 040, höchstens ein Jahr) oder `until?` (ISO) / `null` | pausieren bzw. Pause aufheben |
| `house_rules/rule/run` | `rule_id` | sofort ausführen (Bedingungen werden übergangen); Regeln mit `allow_sensitive` nur Admins |
| `house_rules/rule/run_actions` **(bewohner)** | `rule` (auch Entwurf), `index?` | Schritte wirklich ausführen, ohne Auslöser und Bedingungen; `index` = nur dieser Schritt. Antwort `{ done: [text] }` |
| `house_rules/rule/versions` | `rule_id` | Verlauf der Regel, neueste zuerst (höchstens 20): `[{ id, at, by (user id), by_name, kind: create/edit/restore/before/trash_restore/import, changes: [name/type/when/conditions/then/else/options], summary (Sätze), sentence, current }]`. Jedes Speichern mit geändertem Inhalt ist eine Version; an/aus, Pause und Läufe nicht |
| `house_rules/rule/restore_version` **(bewohner)** | `rule_id`, `version` | eine frühere Version zurück (selbst wieder eine neue Version; an/aus bleibt). Fehler `invalid`, wenn die Regel gelöscht ist (erst aus dem Papierkorb holen). Antwort `{ rule, sentence }` |
| `house_rules/trash/list` | – | gelöschte Regeln der letzten 30 Tage, neueste zuerst: `[{ id, name, deleted, deleted_by, deleted_by_name, until, sentence, rule }]` (älteres fällt von selbst heraus, samt Verlauf) |
| `house_rules/trash/restore` **(bewohner)** | `rule_id` | holt die Regel zurück („Rückgängig“ direkt nach dem Löschen nutzt dasselbe). Gibt es die id inzwischen wieder, kommt sie mit neuer id. Antwort `{ rule, sentence }` |
| `house_rules/trash/purge` **(admin)** | `rule_id?` | endgültig löschen: diese Regel, ohne `rule_id` den ganzen Papierkorb. Antwort `{ removed }` |
| `house_rules/rule/export` | `rule_id` oder `rule` (Entwurf) | die Regel als Home-Assistant-Automation (`export.py`): `{ id ("hausregeln_<rule_id>"), automation (triggers/conditions/actions, neue Schreibweise ab HA 2024.10), yaml, notes: [Satz], complete }`. Platzhalter („irgendein Fenster“, „alle Lichter im selben Raum“) werden zu Entitätslisten von heute; „im selben Raum“ wird ein `choose` je Raum. Nicht Übertragbares steht in `notes` und an der Stelle als Schritt/Bedingung mit `alias: "Nicht übertragbar: …"`, die nichts tut. Hausregeln-eigene Teile (Hausmodus, Raumbelegung, Alarmanlage) nutzen die Entitäten von Hausregeln |
| `house_rules/rule/exported` **(admin)** | `rule_id`, `automation_id` | nachdem die Oberfläche die Automation über die Konfig-API von Home Assistant angelegt hat (`POST /api/config/automation/config/<id>`, nur HA-Admins): Regel hier aus (nicht gelöscht), `meta.exported = { automation_id, at, by }`. Antwort `{ rule }` |

### Rollen

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/permissions` | – | die eigene Rolle: `{ user_id, name, role: admin/resident/guest, label, ha_admin, can: { edit_rules, edit_plans, use_alarm, settings, security, features } }` (steht auch als `me` in jedem Snapshot). `can.security` und `can.features` = `ha_admin` (nur ein Admin von Home Assistant), `can.settings` = Rolle Admin |
| `house_rules/roles/get` **(admin)** | – | `{ users: [{ id, name, role, label, ha_admin, fixed, owner }], roles: [{ id, label }], automation_users: [{ id, name, system, suggested, automation }] }` (`users` ohne System-Benutzer; `automation_users`: alle aktiven Benutzer, auch System-Benutzer wie „Supervisor“, mit dem Vorschlag nach dem Namen – Node-RED, AppDaemon, Supervisor … – und ob er als Automation zählt) |
| `house_rules/roles/set` **(HA-Admin)** | `user_id`, `role` (`admin`/`resident`/`guest`) | Fehler `invalid` für HA-Admins (immer Admin) und unbekannte Nutzer. Alle offenen Oberflächen bekommen einen neuen Snapshot. Antwort wie `get` (`users`) |

### Haus, Räume, Geräte, Bereiche

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/mode/set` **(bewohner)** | `mode` (`home`/`away`/`sleep`/`vacation`/`guests`) | |
| `house_rules/room/save` **(admin)** | `room` (`id` = area_id + geänderte Felder) | `presence`, `motion`, `doors`, `zones`, `lux`, `dark_below`, `empty_after` (Min.), `door_logic`, `door_pulse` ([Türkontakte irgendwo im Haus]: geht eine auf, gilt der Raum `door_pulse_for` Sek. als belegt, Standard 30, 1–600; kommt niemand, sofort wieder leer), `dark` (Teil reicht: `{ sun (Grad, null = nur ohne Lichtsensor: unter dem Horizont), from, to ("HH:MM", leer = kein Zeitfenster), margin (% über `dark_below`, ab dem es wieder hell ist, Standard 50), bright_for (Min., so lange müssen alle Quellen hell sagen, Standard 10), lux_when: lights_off (Standard: Lux zählt nur, solange die Lichter des Raums aus sind) / always }`), `behaviours` (veraltet, wirkungslos), `in` |
| `house_rules/behaviour/set` **(admin)** | `behaviour`, `on` | **veraltet, wirkungslos** (seit 2026-11-14). Die Raumverhalten („Für alle Räume“) sind aufgelöst: `behaviours.migrate()` hat beim ersten Start jedes eingeschaltete Verhalten einmal zu einer normalen Regel mit `meta.origin: "room"` gemacht (lief es, ist die Regel an, sonst aus; danach `behaviours_migrated: true` im Speicher). Die versteckten Regeln `b_…` gibt es nicht mehr. Der Befehl speichert die Auswahl noch, sie wird aber nicht mehr ausgeführt |
| `house_rules/devices/set` **(admin)** | `changes: [{ entity_id, kind?, room?, no_room?, hidden?, name?, icon?, manual?, reset? }]` | Der eine Speicher für alle Korrekturen (nur in Hausregeln, HA bleibt unverändert); jede Funktion liest ihn über die Bestandsaufnahme, er gilt also überall (Alarm, Fenster-Warnung, Heizung, Licht, Räume, Assistent, Regeln). `kind` (auch `vehicle`; `null` = wie erkannt), `room` (area_id oder `null`), `hidden: true` = „nicht verwenden“ (zählt nirgends, steht in `devices_unused`), `name` / `icon` (`mdi:…`, leer = wie erkannt), `manual: true` + `kind` = von Hand hinzugefügt (jede Entität, auch Helfer, Vorlagen, ausgeblendete), `reset: true` = alles wie erkannt (ein eigenes Gerät wird entfernt). Ein Teil eines Fahrzeugs zählt erst, wenn man ihm ausdrücklich eine `kind` gibt |
| `house_rules/group/save` **(admin)** | `group: { id?, name, icon, members: [entity_id], match: 'any'|'all' }` | Antwort `{ group }` |
| `house_rules/group/delete` **(admin)** | `group_id` | |
| `house_rules/suggestion/dismiss` **(bewohner)** | `suggestion_id` (1–80 Zeichen) | höchstens 500 ausgeblendete werden gemerkt, die ältesten fallen heraus |
| `house_rules/suggestion/restore` **(admin)** | – | ausgeblendete Vorschläge wieder zeigen |
| `house_rules/automation/enable` **(HA-Admin)** | `entity_id`, `enabled` | bestehende HA-Automation an/aus |
| `house_rules/settings/set` **(admin)** | `settings: { auto_mode?, eco_temp?, times?, persons_excluded?, phones_excluded?, ui? }` | `times: { night: [22, 6], morning: [6, 10], evening: [18, 22] }`; `persons_excluded: [person.entity_id]` = zählen nicht als Bewohner; `phones_excluded: [notify-Dienst]` = gefundene Handys, die keine Nachrichten bekommen (Alarm, Weitere Alarme, Fenster-Warnung, Erinnerungen) |
| `house_rules/settings/set` **(admin)** | `settings: { auto_mode?, eco_temp?, times?, persons_excluded?, notifications?, automation_users?, ui? }` | `times: { night: [22, 6], morning: [6, 10], evening: [18, 22] }`; `persons_excluded: [person.entity_id]` = zählen nicht als Bewohner; `notifications` (Teil reicht): siehe „Benachrichtigungen“; `automation_users: { user_id: true/false }` = was dieser Benutzer schaltet, zählt als Automation (Node-RED, AppDaemon …) bzw. als Person; fehlt ein Benutzer, gilt der Vorschlag nach dem Namen. Gilt für Lichtplan, Heizung und Verlauf („von Hand“) – ersetzt die ganze Auswahl |
| `house_rules/ui/set` **(bewohner)** | `ui: { grouping?, groups?, room_order?, room_hidden? }` | Seitenlayout der Oberfläche (`ui_layout.py`, `clean_ui`), gespeichert in `settings.ui`; ändert nichts, was läuft (ein ausgeblendeter Raum behält Regeln und Pläne), deshalb auch für Bewohner. Teil reicht, wird mit dem Gespeicherten zusammengeführt. `grouping`: `auto` (Regeln nach Thema) / `manual` (eigene Gruppen); `groups: [{ id: "g_…", name (bis 60 Zeichen), hidden }]` (höchstens 40); `room_order: [area_id]` = eine Reihenfolge der Raum-Kacheln für alle Seiten; `room_hidden: { light?, heat?, rooms?, devices?: [area_id] }` = je Seite ausgeblendet. Admins können dasselbe als `settings.ui` mit `settings/set` schicken. Antwort `{ ok }`, danach Live-Update |
| `house_rules/lightcal/get` **(bewohner)** | – | Lampen abgleichen: `{ lights: { entity_id: { hs: { ref: [h, s] }, k: { ref: kelvin }, bri } }, colors: { ref: [h, s] }, whites: { ref: kelvin } }` (Referenzen: rot, orange, gelb, gruen, tuerkis, blau, lila, pink; warmweiss, neutralweiss, kaltweiss) |
| `house_rules/lightcal/set` **(bewohner)** | `lights: { entity_id: Eintrag oder null }` | zusammengeführt; `null` vergisst eine Lampe. Danach schickt jede Lichtregel der Lampe die korrigierte Farbe; `light/preview` mit `raw: true` in einer Lampen-Einstellung schickt sie unkorrigiert (zum Abgleichen) |
| `house_rules/plan/set` **(bewohner)** | `kind` (`light`/`heat`), `room` (area_id), `plan` (ganzer Plan, siehe 5.1 `plans`) | Licht- bzw. Heizplan je Raum. Beide sind eigene Regler (keine Regeln; die früheren Heizplan-Regeln `p_…` gibt es seit 2026-10-25 nicht mehr). Heizung: alte Felder (`base`, `windows: [{from,to,days,temp}]`, `away_eco`, `sleep{on,temp}`, `vacation`, `window_off`, `preheat: bool`) werden weiter verstanden und umgerechnet. Antwort: `plans` |
| `house_rules/plan/habits` | `room` | `{ windows: [{ from, to, days, temp, level }], note }`: Heizzeiten aus den belegten Zeiten der letzten 14 Tage (Recorder) |
| `house_rules/heating/set` **(admin)** | `config` (Teil von HeatingConfig, siehe 5.1 `plans.heating`) | Heizung fürs ganze Haus: Außenthermometer, Sommer, Wärmeanforderung, Ventilschutz, wer Lüft-Erinnerungen bekommt, Ruhezeit, Mindestabstand kleiner Korrekturen. Antwort: `plans` |
| `house_rules/heating/do` **(bewohner: nur `clear_manual`, sonst admin)** | `action`: `exercise` (Ventilschutz jetzt) / `clear_manual` (+ `room`: von Hand verstellte Heizung zurück zum Plan) / `takeover` (+ `room`: intelligenter Raum beendet den Schattenbetrieb) / `shadow` (+ `room`: wieder nur beobachten) / `accept_proposal` (+ `proposal`: Heiz-Vorschlag wird feste Zeit, wird nicht wieder vorgeschlagen) / `reset_learning` (+ `room`: Gelerntes vergessen) | `{ ok }` |
| `house_rules/heating/set` **(admin)** | `config` (Teil von HeatingConfig, siehe 5.1 `plans.heating`) | Heizung fürs ganze Haus: Außenthermometer, Sommer, Wärmeanforderung, Ventilschutz, wer Lüft-Erinnerungen bekommt, Ruhezeit, Mindestabstand kleiner Korrekturen; `smart.airing` (Lüft-Vorwissen); `defaults` = Hausvorgaben der Raum-Einstellungen in der Form eines HeatPlan (Teil reicht, z. B. `{ window: { delay: 3 }, temps: { comfort: 21 }, smart: { style, building, shadow_days, valve } }`, gleiche Prüfung wie ein Raum) – Räume ohne eigene Einstellung folgen sofort. Antwort: `plans` |
| `house_rules/heating/do` **(admin)** | `action`: `exercise` (Ventilschutz jetzt) / `clear_manual` (+ `room`: von Hand verstellte Heizung zurück zum Plan) / `takeover` (+ `room`: intelligenter Raum beendet den Schattenbetrieb) / `shadow` (+ `room`: wieder nur beobachten) / `accept_proposal` (+ `proposal`: Heiz-Vorschlag wird feste Zeit, wird nicht wieder vorgeschlagen) / `reset_learning` (+ `room`: Gelerntes vergessen) | `{ ok }` |
| `house_rules/heating/explain` | `room` (area_id, oder `_house` für Kosten des ganzen Hauses) | „So denkt deine Heizung“ (HeatExplain, siehe 5.2) |
| `house_rules/heating/plan` | `room` (area_id) | Gelernter Plan eines Raums für den Reiter „Zeiten“ (HeatPlanView, siehe 5.2): `{ room, kind: normal/short/pass, room_type (wie in HeatSmartStatus), phase, style, building, today, tomorrow: [{ from, to, temp, level: comfort/setback/night/preheat/custom/airing, why, confidence }], windows { today, tomorrow: [{ from, to, mean, joined }] } (gelernte Komfort-Fenster), airing { today, tomorrow: [{ from, to, mean, source: learned/prior }], pattern { kind: stoss/tilt/mixed/null, n, median_min }, days }, model { lead_min, lag_min, rate_now, learned, confidence, inert }, learned_days, min_days, home_known, confidence, blocks }` |
| `house_rules/heating/assistant` **(admin)** | – | Für den Heizungs-Assistenten: `{ rooms: [{ id, name, thermostats, has_temp, valves: { climate: { kind: pair/single, open, close, entity } }, area, area_from_plan, comfort (Vorschlag nach Raumname), on, mode, style, building, own, windows (hat Fensterkontakte), kind, temps, senses }], energy: { detected, meter, config }, guard, airing, style (Hausvorgabe), building (Hausvorgabe), wake { work, free } (gelernte Aufstehzeit), setup_done, persons }` |
| `house_rules/heating/test` **(admin)** | `action`: `factor` (`value`: Lernen und Ventilregler laufen N-mal schneller, nur im Speicher) / `seed` (`key` = area_id, `p:<person>` oder `w:<area_id>` (Fenster offen = Lüften), `intervals`: [[von, bis] in Sekunden], `days`: ["JJJJ-MM-TT"]) / `model` (`room`, `k_l`, `k_h`, `n`) / `setback` (`room`, `minutes`, `comfort`, `setback`, `tout`, `current`, `style`) / `tick` / `startup` (`value`: die Startphase endet in so vielen Sekunden, 0 = jetzt; mit factor endet auch „Raum 45 Min. leer“ bei „Von Hand: intelligent“ entsprechend schneller) | Nur für automatische Tests |
| `house_rules/cleaning/set` **(admin)** | `config: { on, vacuums: [vacuum.…], sensors: "all" \| [entity_id], after (Min.) }` | Saugroboter-Pause: solange er reinigt (und `after` Min. danach), zählen neu anschlagende Bewegungs-/Anwesenheitsmelder nicht (Alarm, Regeln, Raumbelegung) |

### Hausmodus automatisch

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/mode_auto/set` **(admin)** | `mode` (`sleep`/`away`/`guests`/`vacation` oder `_enabled`), `config` (`{ on, when: [Klauseln], for, end?: { on, when: [Klauseln], for } }` bzw. `{ enabled }`) | Bedingungen, wann der Modus von selbst gesetzt wird. Rangfolge: Urlaub > Weg > Schlafen > Gäste, sonst Zuhause. Von Hand gesetzt bleibt, bis sich die automatische Wahl ändert. Mit eigenem Ende (`end.on`) bleibt der Modus – auch von Hand gesetzt –, bis die Endbedingungen (alle, `for` lang) stimmen; galten sie beim Start schon, zählen sie erst, nachdem sie einmal nicht mehr galten. Ein laufender Modus bleibt, solange seine Bedingungen ohne die Wartezeiten (`for`) stimmen (Neustart, Sensor-Aussetzer: Schlafen hat 60 s Kulanz); in der Startphase wechselt nichts von selbst. Nach eigenem Ende oder Aufstehen startet der Modus erst wieder von selbst, wenn seine Startbedingungen einmal nicht galten. Hat Schlafen „Gäste“ (von Hand) abgelöst, kommt danach wieder Gäste. Mit `wakeup.on` zählt das eigene Ende von Schlafen nicht. |
| `house_rules/wakeup/set` **(admin)** | `config: { on?, action?: "direct"/"ask", feedback?, beds?: [binary_sensor-ids], rooms?: [Raum-ids] }` (Teil reicht, Ungültiges wird verworfen) | „Aufstehen erkennen“: beendet Schlafen, wenn das Aufstehen für den Tag erkannt ist (Bett länger leer als die gelernte Schwelle, andere Räume belegt, Licht von Hand, Türen, Uhrzeit gegen gelernte Aufstehzeit je Werktag/freiem Tag, Dauer der Nacht; nie vor dem Morgenfenster, nie in den ersten 4 h außer sehr sicher; nach 90 Min. leerem Bett in jedem Fall). `beds` leer = Zonen/Anwesenheitssensoren mit dem Wort „Bett“/„Bed“ im Namen; `rooms` leer = alle anderen Räume mit Anwesenheit. `ask`: Frage an die Admins mit `HR_WAKE_END_<id>` / `HR_WAKE_KEEP_<id>`; `feedback`: nach direktem Ende die ersten 7 Male, wenn unsicher, sonst etwa wöchentlich „stimmt das?“ mit `HR_WAKE_YES_<id>` / `HR_WAKE_EARLY_<id>` / `HR_WAKE_LATE_<id>`. Knöpfe zählen nur von einem Benutzer, an den die Nachricht ging, für die letzte Erkennung, höchstens 3 h lang. Antwort: `mode_auto` (mit `wakeup`) |
| `house_rules/wakeup/reset` **(admin)** | – | Vergisst das Gelernte (Aufstehzeiten, Schwelle, Nachtgänge); die Einstellungen bleiben. Antwort: `mode_auto` |
| `house_rules/sim/view` | `day?` (`YYYY-MM-DD`, Standard: heute) | Urlaub „bewohnt wirken“, gelernt: `{ config { smart, people (0 = wie Bewohner, max. 2), morning, night, dark { sun, sun_below (Grad), lux, lux_below (0 = automatisch: gelernt, wo ihr Licht anmacht, sonst Raum-Grenze), habits (nur zu Tageszeiten, in denen ihr dort Licht nutzt; Räume mit Licht auch tagsüber: Sonne zählt nicht), never, never_from, never_to } }, lux { raum: { limit, source, now } }, now { raum: { dark, why } }, habits { raum: [morning/day/evening/night] }, sun, enabled, learning, days, first, last, bedroom, night_room, entrance, floorplan, neighbours { raum: [{ room, source: Karte/gelernt/angenommen }] }, times { workday/weekend/all: { wake, bed, night_p, days } }, rooms (machen mit), people, day, timeline: [{ room, from, to (Min. seit 04:00), start, end, kind: stay/pass/wake/bed/night, walker }] }`. Gelernt wird jede Nacht 04:20 aus dem Recorder (Belegung der „… belegt“-Sensoren, Lichter mit Helligkeit), 6 Wochen als Tageszusammenfassung; Nachbarräume aus den Türen der Grundriss-Karte und aus Raumwechseln. Licht nur, wenn alle eingeschalteten Prüfungen von `dark` zustimmen. Mitmachen: Räume mit Lichtplan an und „Urlaub“ an. |
| `house_rules/sim/set` **(admin)** | `config` | Einstellungen (s. o.), Antwort wie `sim/view` |
| `house_rules/sim/learn` **(admin)** | – | Jetzt neu lernen, Antwort wie `sim/view` |

### Alarmanlage

| Befehl | Parameter | Antwort / Hinweis |
|---|---|---|
| `house_rules/alarm/arm` **(bewohner)** | `mode` (`away`/`night`/`home`), `force?` | `{ ok }` oder `{ ok: false, error: 'open', open: [{ entity_id, name }] }` → nachfragen, dann mit `force: true` (offene werden ausgenommen) |
| `house_rules/alarm/disarm` **(bewohner)** | `code?` oder `webauthn` + `rp_id` | `{ ok, error?, retry_in? }` – je nach Einstellung `confirm`: `none`, `pin`, `device` (Face ID / Touch ID per Passkey, PIN als Ausweg). Fehler: `wrong_code`, `locked` (nach 5 falschen PINs je Nutzer gesperrt, 30 s, dann doppelt so lange, höchstens 1 h; `retry_in` Sek.; die Sperre übersteht einen Neustart, aufheben mit `house_rules.reset_alarm_pin` oder der Datei `house_rules_pin_reset`, siehe Dienste), `no_pin`, `needs_device`. Dieselbe Prüfung gilt für `alarm_control_panel.alarmanlage` (Code = PIN, sobald `pin`/`device` gilt) |
| `house_rules/alarm/challenge` | – | `{ challenge, credentials, user }` für Face ID / Touch ID; gültig 3 Min., höchstens 20 gleichzeitig (die neuesten) |
| `house_rules/alarm/register_device` **(bewohner)** | `payload`, `name`, `rp_id`, `code?` | ohne `code` nur ein Admin von Home Assistant, alle anderen (auch die Rolle Admin) mit der Alarm-PIN; dieses Gerät für Face ID / Touch ID einrichten (siehe `src/passkey.ts`). Nur Admins, oder wer die PIN der Alarmanlage mitschickt (sonst `unauthorized`): ein eingerichtetes Gerät kann die Anlage ausschalten |
| `house_rules/alarm/preview_tone` **(admin)** | `tone`, `player` | Ton leise auf einem Lautsprecher probehören |
| `house_rules/alarm/silence` **(bewohner)** | – | Sirene/Ton aus, Anlage bleibt im Alarm |
| `house_rules/alarm/test` **(admin)** | – | Probealarm: nur Nachricht + Durchsage |
| `house_rules/alarm/channel_test` **(admin)** | `channel` (`email`/`telegram`/`signal`/`services`) | `{ ok, errors }` – Testnachricht über einen weiteren Weg |
| `house_rules/alarm/config` **(HA-Admin)** | `config` (Teilobjekt, siehe 5.1 `alarm.config`; `code: "1234"` setzt, `code: null` löscht die PIN; `remove_device: id`) | neue Ansicht. Je Art (`modes.away/night/home`): `sensors`, `entry_delay`, `exit_delay`, `reaction` (`loud` | `silent` = nur Licht: Lichter blinken (lights.mode „on“ wird zu „flash“), Nachricht + zusätzliche Geräte, kein Ton | `notify` = nur Nachrichten; `loud` bleibt als bool für ältere Oberflächen), `lights { mode: none/on/flash/red, entities }`, `activate` (Kameras, Schalter, Szenen, Skripte), `smart { inside { on, seconds }, arrival { on, minutes, disarm } }`, `auto { arm_on, disarm_on, arm_at, disarm_at, only_auto, arm_away, away_for, disarm_home }` (`arm_away`: scharf, wenn die Personen aus `presence` alle `away_for` Min. weg sind; `disarm_home`: aus, wenn eine heimkommt). Für alle: `presence { persons: "everyone" | [person-ids] }` (zählt für „alle weg“, „heimgekommen“), `notify { persons, pending_persons, armed_persons, disarmed_persons, test_persons ("same" = wie beim Alarm | "everyone" | [ids]), critical, pre_alarm, armed, disarmed, repeat { on, every (s), max, channels } }`, `channels { email { on, host, port, security, user, sender, to, events, has_password }, telegram { on, users, call, text, events }, signal { on, numbers: [{ phone, has_key }], events }, services { on, list, events } }` (Ereignisse: `triggered`, `pending`, `armed`, `disarmed`, `test`; Passwörter/Schlüssel nur schreiben, nie lesen), `announce`, `sound { players, tone, pre_tone, url, volume }`, `sirens`, `cameras`, `buttons`, `phone`, `duration`, `confirm` (`pin` und `device` nur mit gesetzter PIN, sonst Fehler `invalid`; PIN entfernen nur zusammen mit `confirm: "none"`), `notify_disarm` („Aus der Nachricht ausschalten erlaubt“, Standard `true`: Knopf „Alarm aus“ (`HR_ALARM_DISARM`) in der Alarm- und Voralarm-Nachricht schickt eine zweite Nachricht an die Handys der Person, die getippt hat (unbekannt: an alle Empfänger des Alarms), mit „Nur diesen Alarm aus“ (`HR_ALARM_STOP`: Sirene, Ton, Licht, Countdown und zusätzliche Geräte aus, zurück auf scharf im selben Modus) und „Ganz unscharf schalten“ (`HR_ALARM_DISARM_ALL`); in der Nachricht „ist scharf“ heißt der Knopf direkt „Unscharf schalten“. Das Handy verlangt vor jedem dieser Knöpfe Face ID bzw. seinen Code; `false` = Knöpfe fehlen, trotzdem gesendete werden abgelehnt). Alle Knöpfe (`HR_ALARM_*`) zählen nur, wenn der Nutzer des Handys (Kontext des Ereignisses) Admin ist oder zu einer Person gehört, deren Handys die Alarm-Nachrichten bekommen; sonst abgelehnt und im Verlauf vermerkt. Antwort enthält zusätzlich `pin_locked` (Anzahl gerade gesperrter Nutzer). Die PIN wird gesalzen und langsam gespeichert (PBKDF2-SHA256); alte Hashes werden beim nächsten richtigen Eingeben umgestellt |
| `house_rules/alarm/config` **(admin)** | `config` (Teilobjekt, siehe 5.1 `alarm.config`; `code: "1234"` setzt, `code: null` löscht die PIN; `remove_device: id`) | neue Ansicht. Je Art (`modes.away/night/home`): `sensors`, `entry_delay`, `exit_delay`, `reaction` (`loud` | `silent` = nur Licht: Lichter blinken (lights.mode „on“ wird zu „flash“), Nachricht + zusätzliche Geräte, kein Ton | `notify` = nur Nachrichten; `loud` bleibt als bool für ältere Oberflächen), `lights { mode: none/on/flash/red, entities }`, `activate` (Kameras, Schalter, Szenen, Skripte), `smart { inside { on, seconds }, arrival { on, minutes, disarm } }`, `auto { arm_on, disarm_on, arm_at, disarm_at, only_auto, arm_away, away_for, disarm_home }` (`arm_away`: scharf, wenn die Personen aus `presence` alle `away_for` Min. weg sind; `disarm_home`: aus, wenn eine heimkommt). Für alle: `presence { persons: "everyone" | [person-ids], v? }` (zählt für „alle weg“, „heimgekommen“; `"everyone"` = die Bewohner aus `settings.persons_excluded`, also dieselbe Auswahl wie der Schalter „zählt mit“ an den Personen unter Zuhause, eine Liste ist eine Abweichung nur für die Alarmanlage; `v: 2` markiert, dass eine ältere getrennte Auswahl einmalig umgestellt wurde – eine Liste mit allen Bewohnern wurde dabei zu `"everyone"`), `notify { persons, pending_persons, armed_persons, disarmed_persons, test_persons ("same" = wie beim Alarm | "everyone" | [ids]), critical, pre_alarm, armed, disarmed, repeat { on, every (s), max, channels } }`, `channels { email { on, host, port, security, user, sender, to, events, has_password }, telegram { on, users, call, text, events }, signal { on, numbers: [{ phone, has_key }], events }, services { on, list, events } }` (Ereignisse: `triggered`, `pending`, `armed`, `disarmed`, `test`; Passwörter/Schlüssel nur schreiben, nie lesen), `announce`, `sound { players, tone, pre_tone, url, volume }`, `sirens`, `cameras`, `buttons`, `phone`, `duration`, `confirm` (`pin` und `device` nur mit gesetzter PIN, sonst Fehler `invalid`; PIN entfernen nur zusammen mit `confirm: "none"`), `notify_disarm` („Aus der Nachricht ausschalten erlaubt“, Standard `true`: Knopf „Alarm aus“ (`HR_ALARM_DISARM`) in der Alarm- und Voralarm-Nachricht schickt eine zweite Nachricht an die Handys der Person, die getippt hat (unbekannt: an alle Empfänger des Alarms), mit „Nur diesen Alarm aus“ (`HR_ALARM_STOP`: Sirene, Ton, Licht, Countdown und zusätzliche Geräte aus, zurück auf scharf im selben Modus) und „Ganz unscharf schalten“ (`HR_ALARM_DISARM_ALL`); in der Nachricht „ist scharf“ heißt der Knopf direkt „Unscharf schalten“. Das Handy verlangt vor jedem dieser Knöpfe Face ID bzw. seinen Code; `false` = Knöpfe fehlen, trotzdem gesendete werden abgelehnt). Alle Knöpfe (`HR_ALARM_*`) zählen nur, wenn der Nutzer des Handys (Kontext des Ereignisses) Admin ist oder zu einer Person gehört, deren Handys die Alarm-Nachrichten bekommen; sonst abgelehnt und im Verlauf vermerkt. Antwort enthält zusätzlich `pin_locked` (Anzahl gerade gesperrter Nutzer). Die PIN wird gesalzen und langsam gespeichert (PBKDF2-SHA256); alte Hashes werden beim nächsten richtigen Eingeben umgestellt |

### Weitere Alarme (Fahrrad, Auto, Garage …)

Kleine Alarme neben der Alarmanlage (`objects.py`). Die Alarmanlage selbst ändert sich dadurch nicht.

| Befehl | Parameter | Antwort / Hinweis |
|---|---|---|
| `house_rules/objects/save` **(HA-Admin)** | `object` (Teilobjekt; ohne `id` = neu, höchstens 20) | `{ ok, id, objects }`. Felder: `name`, `kind` (`bike`/`car`/`garage`/`shed`/`building`/`other`), `icon` (`mdi:…`), `sensors: [entity_id]` (binary_sensor: an = Alarm; `lock`: aufgeschlossen; `device_tracker`: verlässt den Ort, an dem scharf geschaltet wurde, oder bewegt sich mehr als 150 m; `alarm_control_panel`: `triggered`; `sensor`/`select`: Werte wie `vibration`, `tilt`, `tamper`, `alarm`; `event`: jedes Ereignis), `delay` (s bis zum Alarm, 0–300), `confirm` (Ausschalten mit der Bestätigung der Alarmanlage, Standard `true`), `auto { with_alarm (scharf mit der Alarmanlage, aus mit ihr, wenn automatisch scharf), arm_on: [Hausmodus], disarm_on: [Hausmodus] }`, `notify { persons: "everyone" \| [person-ids], critical }`, `sirens`, `lights`, `camera`, `duration` (s Sirene) |
| `house_rules/objects/delete` **(HA-Admin)** | `object_id` | `{ ok }` (scharf: wird vorher ausgeschaltet) |
| `house_rules/objects/arm` **(bewohner)** | `object_id` | `{ ok }` oder `{ ok: false, error: 'no_sensors' }` |
| `house_rules/objects/disarm` **(bewohner)** | `object_id`, `only_alarm?`, `code?` oder `webauthn` + `rp_id` | `{ ok, error?, retry_in? }` wie `alarm/disarm`: dieselbe PIN, dieselbe Sperre je Nutzer, dieselben Passkeys (bei `confirm: false` ohne). `only_alarm: true` = nur den laufenden Alarm beenden, bleibt scharf |
| `house_rules/objects/test` **(HA-Admin)** | `object_id` | Probealarm: nur die Nachricht |

Nachricht beim Alarm: Titel „Alarm: <Name>“, Knöpfe wie bei der Alarmanlage: „Alarm aus“ (`HR_OBJ_DISARM:<id>`, verlangt am Handy Face ID / Code) schickt die Rückfrage „Alarm aus – wie?“ mit „Nur diesen Alarm aus“ (`HR_OBJ_STOP:<id>`, bleibt scharf) und „Ganz unscharf schalten“ (`HR_OBJ_DISARMALL:<id>`); „Sirene stumm“ (`HR_OBJ_SILENCE:<id>`), „Kamera ansehen“. Es gilt `notify_disarm` der Alarmanlage. Knöpfe wirken nur, wenn sie von einem Admin oder einer Person kommen, deren Handy die Nachrichten dieses Alarms bekommt (sonst Eintrag im Verlauf). Texte in der Sprache von Home Assistant (`texts/objects.json`). Nach einem Start von HA wartet jeder Alarm wie die Alarmanlage 60 s, bevor Sensoren zählen.

### Funktionen und Einrichtung

Jeder Teil von Hausregeln lässt sich unter Einstellungen → **Funktionen** ein- und ausschalten. Aus = im Backend wirklich gestoppt
(keine Listener, keine Aktionen, zugehörige Entitäten `unavailable`) und im Panel ausgeblendet. Schlüssel: `alarm` (= `alarm.config.enabled`
= `switch.alarmanlage_aktiv`), `light` (Lichtregeln je Raum), `heating` (Heizpläne/Heizungsregler),
`vacation` (Urlaubssimulation, braucht `light`), `mode_auto` (= `mode_auto.enabled`), `vacuum` (= `cleaning.on`), `ai` (KI-Anbindung; Verbindungsdaten bleiben
gespeichert), `window_warning` (Fenster-Warnung beim Gehen). `behaviours` (Raumverhalten) ist seit 2026-11-14 keine Funktion mehr (wird ignoriert). Neu installiert: nur `mode_auto` an, der Assistent schaltet den Rest;
bestehende Installationen behalten alles, was lief (`window_warning` startet aus). Im Backend: `core.feature("heating")`, Änderungen über
`core.features.add_listener(cb)` (der Heizungsregler nutzt das).

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/features/set` **(HA-Admin)** | `features: { <schlüssel>: bool }` | Antwort: alle Funktionen. Beim ersten Einschalten der Alarmanlage werden die Sensoren der Räume vorgeschlagen, bei der Saugroboter-Pause die Saugroboter. |
| `house_rules/setup/save` **(admin)** | `step?`, `answers?` (wird zusammengeführt), `done?`, `restart?` | Fortschritt des Einrichtungsassistenten (fortsetzbar auf jedem Gerät). Antwort wie `setup` im Snapshot |
| `house_rules/setup/suggest` **(admin)** | – | Vorschläge aus dem echten Zuhause: `{ residents, persons, rooms: [{ id, name, presence, motion, candidates: [{ entity_id, name, kind, guess? }], lights, climate, doors, door_logic }], alarm: { away, night, home, sirens, players, cameras }, vacuums, window_warning: { doors, windows, lights }, examples: [{ id, title, why, rule, sentence }], floorplan, features }` |
| `house_rules/setup/apply` **(admin)** | `step`: `rooms` (`data.rooms: [{ id, presence, motion }]`, Melder ohne Raum bekommen den Raum), `light` (`data.rooms: [area_id]`: Lichtplan an + erste Lichtregel „an, solange jemand da und dunkel“), `vacation` (Urlaub in allen Räumen mit Lichtregeln, intelligent), `modes` (`data: { away, sleep, vacation }`) | zusammengesetzte Schritte des Assistenten |

#### Assistenten je Funktion

Licht, Alarmanlage, Fenster-Warnung, Urlaub, Saugroboter-Pause und Hausmodus haben je einen kleinen Assistenten (die Heizung hat einen eigenen).
Das Panel öffnet ihn von selbst, wenn der Bereich der Funktion zum ersten Mal geöffnet wird, die Funktion an ist und `setup.assistants[f]` weder
`done` noch `dismissed` noch `configured` (es ist schon etwas eingerichtet, z. B. Räume mit Lichtregeln) ist – nicht, solange der Einrichtungsassistent
noch offen ist. Im Bereich: „Assistent erneut starten“; ist die Funktion aus, steht im Hinweis „Mit Assistent einrichten“.

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/assistant/suggest` **(admin)** | `feature` | Vorschläge aus dem echten Zuhause, je Funktion: `light` `{ rooms: [{ id, name, in, lights: [{ entity_id, name, white, color }], presence, door_logic, lux, media, plan_on, rules, smart }], night: [von, bis], slots, learned }`; `alarm` `{ sensors, night, home, sirens, players, cameras, current { modes, entry_delay, exit_delay, has_code, notify_disarm, persons, sirens } }`; `window_warning` `{ doors, suggested, windows, players, current }`; `vacation` `{ rooms: [{ id, name, lights, plan_on, vacation }], config, days, residents, light_on }`; `vacuum` `{ vacuums, sensors, current }`; `mode_auto` `{ current, night, residents, wakeup: { on, beds: [Namen] } }`. Immer dabei: `feature, on, state, persons` |
| `house_rules/assistant/apply` **(admin)** | `feature`, `answers` | `feature: "alarm"` nur ein Admin von Home Assistant (schreibt die Alarm-Einstellungen). Richtet alles auf einmal ein, schaltet die Funktion ein und setzt `done`. Fehlende Schlüssel = bleibt, wie es ist (übersprungene Schritte). `light`: `{ rooms, mode: smart/rules, active (false = Probelauf), only_dark, slots, empty, manual, guards, tv_off }` – smart: `smart` im Plan, eigene Lichtregeln bleiben; rules: eine Solange-Regel mit einer Variante je Tageszeit (Grenzen schon angewendet) plus „nie an, solange …“ (Regel-ids `as_…`, werden beim nächsten Lauf ersetzt). `alarm`: `{ sensors, night?, home? (sonst Vorschlag ∩ sensors), entry_delay, exit_delay, persons, sirens, flash, notify_disarm, arm_away, disarm_home, code? }` (PIN nur als Hash, `confirm: pin`). `window_warning`: `{ doors, only_last, lights (rot, Lichter im Raum der Tür), announce, notify, timeout }`. `vacation`: `{ rooms, smart, people, morning, night, end, never { on, from, to }, brightness }` (Räume ohne Lichtplan: nur für den Urlaub an, „niemand mehr da“ = anlassen, „von Hand“ = gar nicht). `vacuum`: `{ vacuums, sensors, after }`. `mode_auto`: `{ away, sleep, vacation, guests: bool oder { on, for, when }, wakeup?: bool }` (`wakeup` = „Aufstehen erkennen“; die Oberfläche schlägt es vor, sobald ein Bett-Sensor gefunden ist) |
| `house_rules/assistant/mark` **(admin)** | `feature`, `done?`, `dismissed?` | Nur das Kennzeichen (✕ im Assistenten = `dismissed`). Antwort: alle `assistants` |

Wandtablet/Grundriss: Der Assistent legt auf Wunsch (nur nach Bestätigung) ein **neues** Dashboard an (`grundriss-tablet` bzw. `grundriss-ansicht`, bei
Belegung `-2`, `-3` …; eine Panel-Ansicht mit `custom:floorplan-card`, Tablet mit `height: calc(100vh - var(--header-height, 56px))`). Ein schon gezeichneter
Grundriss aus einem bestehenden Dashboard wird nur gelesen und kopiert; bestehende Dashboards werden nie geändert. Ob die Karte da ist: `setup.floorplan`
(Integration `floorplan_card` geladen) oder `customElements.get('floorplan-card')`.

### Intelligentes Licht

Je Raum im Lichtplan (`smart`, siehe 5.1 `plans`). Lernt aus Änderungen von Personen (App, Schalter, Sprache) an den Lichtern des Raums: Uhrzeit,
Werktag/Wochenende, an/aus, Helligkeit, Weißton, Zahl der Bewohner zuhause, Tageslicht (Lichtsensor des Raums, sonst Sonnenhöhe). Änderungen
innerhalb von 20 s ersetzen das vorige Beispiel (Dimmen in Schritten; Ausschalten nach dem Einstellen bleibt ein eigenes Beispiel); „aus“ und der Raum ist binnen 2 Min. leer = Gehen, zählt nicht. Je Licht die neuesten 150
Beispiele, gespeichert nur lokal (Speicher `house_rules.light_learn`). Entscheidung nur, solange jemand im Raum ist: ähnliche Beispiele (Tageszeit,
Alter, Tageslicht, Gesellschaft, Wochentag gewichtet) gemischt mit den Startwerten der Tageszeit. Grenzen (`guards`) gewinnen immer, eigene Lichtregeln
des Raums gehen vor (das intelligente Licht bekommt nur Lichter, über die gerade keine Regel entscheidet). Es schaltet nur aus, was es selbst
eingeschaltet hat. `shadow` = Probelauf: schaltet nichts, `now.light.smart` zeigt, wie es geschaltet hätte, `agree` zählt, wie oft das zu dem passte,
was dann von Hand eingestellt wurde.

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/light/learned` | `room` | `{ slots: [{ id, label, from, to, lights: { entity_id: { on, p_on, brightness, kelvin, learned (Gewicht der Beispiele), slot, prior { brightness, kelvin } } } }], samples, agree { n, same }, recent: [{ entity_id, at (s), on, brightness, kelvin }] (die letzten 5 Beispiele) }` |
| `house_rules/light/forget` **(admin)** | `room` | vergisst das Gelernte des Raums |
| `house_rules/light/preview` **(bewohner)** | `action`: `start` (`lights`: nur `light.*`) · `apply` (`session`, `settings`: `{ entity_id: LightSetting }`) · `keep` (`session`) · `stop` (`session`, `restore` = true) | Live-Vorschau beim Einstellen von Licht. `start` prüft jede Lampe gegen das Home-Assistant-Recht „steuern“ des Benutzers (`unauthorized` mit Namen der Lampe; keine Lampe → `invalid`), Antwort `{ session, idle (s), lights }`. `apply` schickt, was eine Regel schicken würde (ohne Übergang/Blitz), mit einem eigenen Kontext: zählt für den Lichtplan nicht „von Hand“, nichts wird gelernt, kein Verlaufseintrag; Antwort `{ failed: [entity_id] }`. Solange die Sitzung läuft und 5 s danach lässt der Lichtplan die berührten Lampen in Ruhe. `stop` stellt genau die berührten Lampen zurück (vorher gemerkt: an/aus, Helligkeit, Farbmodus und Farbe, Effekt); `restore: false` lässt sie so und zählt für den Lichtplan wie von Hand. Ohne `apply`/`keep` 180 s lang oder wenn die Verbindung abbricht, endet die Sitzung von selbst (Lampen zurück). Nur die eigene Sitzung (`not_found` sonst und nach dem Ende); höchstens 20 gleichzeitig (`busy`). |

### Fenster-Warnung beim Gehen

Geht eine der Türen auf, während Fenster offen sind (optional nur, wenn höchstens eine zählende Person zuhause ist, optional nach `delay` s): Lichter blinken
3× rot (farblose hell) und sind danach wie vorher, die Karte lässt die offenen Fenster rot pulsieren (`blink`). Ohne Bestätigung nach `timeout` s: Durchsage
(`general` / `all` / `sequential` = ein Fenster nach dem anderen, das nächste, sobald es zu ist; Platzhalter `{fenster}`, `{anzahl}`; Lautsprecher leer = die der
Alarmanlage) und optional Nachricht ans Handy. Endet mit Bestätigen oder wenn alle Fenster zu sind. Ersetzt die Haustür-Warnung der Karte (`entry_alert`).

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/window_warning/get` | – | `{ on, active, phase: alarm/linger/null, door, windows: [entity_id offen], names, since, deadline (Unix-Sek., Countdown bis zur Durchsage), spoken, config, doors (wirksam), suggested_doors (nie Türen von Fahrzeugen), window_entities (beobachtete Fenster), window_candidates (alle Fenster des Hauses) }` |
| `house_rules/window_warning/set` **(admin)** | `config` (Teilobjekt): `{ doors: [entity_id] (leer = vorgeschlagene Haustür), windows: "all" \| [entity_id] (Reihenfolge = Ansage-Reihenfolge), only_last, delay, timeout, blink, lights { mode: none/red/flash, entities }, ack_entity, announce { mode: none/general/all/sequential, players, tts, language, texts { general, all, single } }, notify { on, persons: "everyone" \| [person-ids] }, users: [HA-User-ids, deren Karten-Geräte mitmachen] }` | Antwort wie `get` |
| `house_rules/window_warning/ack` | – | bestätigen (alle Nutzer, z. B. Tablet-Tipp): `{ ok }`. Auch jede Änderung von `ack_entity` bestätigt |
| `house_rules/window_warning/import` **(admin)** | `entry_alert` (Kartenkonfiguration), `openings: [{ id, type, entity, name }]` (alle Öffnungen des Plans), `source` (Name des Dashboards) | einmalige Übernahme der Karten-Einstellungen; `door`/`order` sind Öffnungs-ids und werden zu Sensoren aufgelöst. Das Panel liest die Karte read-only per `lovelace/config` |

Live: Abo-Teil `window_warning` (wie `get`), Ereignis `house_rules_window_warning` (ohne `config`), Entität `binary_sensor.fenster_warnung` (Attribute `phase`, `door`, `windows`, `names`, `deadline`, `spoken`).

### KI

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/ai/set` **(HA-Admin)** | `ai: { provider, url?, model?, key? }` | `provider`: `none`, `ollama`, `gemini`, `openai`, `anthropic`, `mistral`, `openai_compatible`. Der Schlüssel wird nie zurückgegeben (`key_hint: "…abcd"`). |
| `house_rules/ai/test` **(HA-Admin)** | `ai?` (wie oben; ohne `key` = gespeicherter) | `{ ok, error, models: [] }` |
| `house_rules/ai/review` **(bewohner)** | `rule` | die KI prüft eine Regel: `{ verdict: ok/hinweis/problem, summary, notes, improved?, improved_sentence?, model }` |

**Sprache:** Texte, die die Integration selbst schreibt (Verlauf `what`/`why`, Status- und Begründungszeilen, Nachrichten, Durchsagen, `sentence`, Namen der Entitäten), kommen in der Sprache von Home Assistant (`hass.config.language`: Deutsch für `de*`, sonst Englisch) und entstehen beim Schreiben – ältere Verlaufseinträge bleiben in ihrer Sprache. Quelle: `custom_components/house_rules/texts/*.json`. Entitäts-IDs, Zustände und die Optionen von `select.hausmodus` bleiben in jeder Sprache gleich.
### Sichern und wiederherstellen

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/backup/export` **(admin)** | – | `{ format: "house_rules_backup", version: 1, app_version, created, data }`. `data`: `rules, groups, rooms, devices, behaviours, features, settings, light, heating {rooms, global}, alarm, object_alarms, window_warning, mode_auto, cleaning, vacation, setup, dismissed`. Ohne PIN-Hash, Passkeys, Passwörter/Schlüssel der Alarm-Kanäle, KI-Anbindung, Verlauf, Gelerntes, Laufzeit. `settings` enthält `eco_temp, times, persons_excluded, phones_excluded, ui` (Seitenlayout); Regeln behalten ihre `group`. `behaviours` steht noch drin (ältere Sicherungen), bewirkt beim Einspielen aber nichts mehr. |
| `house_rules/backup/preview` **(admin)** | `backup`, `remap?: {alt: neu}` | prüft die Datei (Fehler `invalid` mit Satz: fremde Datei, neuere Version, beschädigter Teil, > 2 MB, zu viele Einträge) → `{ sections: [{key, label, incoming, current, new?, same?, only_here?, unknown_rooms?, changed?}], missing: [{entity_id, used_in, candidates: [{entity_id, name}]}], alarm_armed, notes, created, app_version }` |
| `house_rules/backup/restore` **(HA-Admin)** | `backup`, `mode: merge\|replace`, `sections?: [key]`, `remap?` | spielt die Teile über die normalen Speicherwege ein. `merge`: gleiche Regeln/Bereiche/Pläne überschreiben, eigene bleiben; `replace`: genau die Sicherung (übrige Regeln in den Papierkorb). PIN, Passkeys, Passwörter von hier bleiben. Fehler `invalid`, wenn der Alarm-Teil dabei ist und die Anlage scharf ist. → `{ ok, sections, skipped: [Satz], notes: [Satz] }` |

### Wo ist wer (Orte, Wege, Vorhersage)

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/places/get` | – | wie der Snapshot-Teil `places` |
| `house_rules/places/person` | `person_id` (Id oder `person.…`) | `{ person, timeline: [{ kind: stay, place, name, from, to } \| { kind: trip, from_place, to_place, from_name, to_name, from, to }] (heute), trips: [{ from, to, start, minutes }] (die letzten 20), prediction }` |
| `house_rules/places/predict` | `person_id` | `{ destination, name, eta_min, probability, basis: learned/direction, mode, mode_confidence }`; `destination` = Zonen-Id oder `lp_…`, `null` wenn nicht unterwegs. Im Backend: `core.places.predict(person_id)` (gleiche Felder) |
| `house_rules/places/name` **(admin)** | `place_id`, `name` (≤ 60) | gelernten Ort benennen → `places` |
| `house_rules/places/delete` **(admin)** | `place_id` | Ort und Wege dorthin vergessen → `places` |
| `house_rules/places/to_zone` **(HA-Admin)** | `place_id`, `name?`, `radius?` (m) | legt eine Zone in Home Assistant an (Zonen-Speicher wie Einstellungen → Zonen) → `{ zone_id }`; der Ort verschwindet aus der Liste, neue Aufenthalte zählen zur Zone |
| `house_rules/places/settings` **(admin)** | `learn?`, `nominatim?` (bool) | `learn` (Standard an): Orte und Wege lernen; `nominatim` (Standard **aus**): Straßennamen von nominatim.openstreetmap.org, nur beim Anhalten an einem unbekannten Ort ohne Adress-Sensor, ≤ 1 Anfrage/s, Antworten zwischengespeichert, eigener User-Agent |
| `house_rules/places/relearn` **(admin)** | `days?` (1–60, Standard 30) | aus dem Recorder neu lernen (Executor, begrenzt); Namen wiedergefundener Orte bleiben → `{ ok, persons, fixes, places, trips }` |
| `house_rules/places/forget` **(admin)** | – | alles Gelernte löschen → `places` |

Datenschutz: alles bleibt lokal (`.storage/house_rules.places`): gelernte Orte (Mitte, Radius, Besuche, typische Tage/Uhrzeit), Weg-Zusammenfassungen
der letzten 60 Tage (`{ von, nach, Start, Dauer, Startrichtung, Luftlinie }`, keine Spur), der Tagesverlauf von heute/gestern und gemerkte Straßennamen.
Beim ersten Start lernt Hausregeln einmal aus den letzten 30 Tagen des Recorders. Die Übersicht dürfen alle angemeldeten Personen lesen (wie die
Personen-Entitäten in Home Assistant), ändern nur Admins.

### Benachrichtigungen (Handy)

Jede Handy-Nachricht von Hausregeln läuft durch `notify.py` (Einstellungen → Benachrichtigungen, gespeichert mit `settings/set`
`{ notifications: … }`, gelesen aus `settings.notifications`):

```
{ kinds: { vent|window|alarm_info|rule|rule_report|wakeup: { on, gap (Min. je Anlass und Person, 0 = jedes Mal), daily (je Person und Tag, 0 = unbegrenzt) } },
  quiet: { on, from: "22:00", to: "07:00" }, persons: { person-id: { off: [kinds] } },
  defaults: { kind: { on, gap, daily } }, today: { kind: Anzahl }, quiet_now }   // die letzten drei nur zum Lesen
```

Standard: Lüften 120 Min./3 am Tag (je Raum), Fenster-Warnung 15/8, Alarm-Hinweise (scharf/aus) 5/10,
Nachrichten aus Regeln 1/30 (derselbe Text derselben Regel), „Sag mir, wenn sie lief“ 30/10, „Aufstehen erkannt“ 0/3 (leise, auch in der Ruhezeit). In der Ruhezeit warten Lüften
und Berichte (fallen aus), Fenster-Warnung und Alarm-Hinweise kommen ohne Ton, Regel-Nachrichten normal. Lüften,
Alarm-Hinweise und Berichte kommen immer leise (`push.interruption-level: passive`, Android-Kanal „Hausregeln Hinweise“ mit
`importance: low`); jede Nachricht hat einen festen `tag` je Anlass (ersetzt die vorige), `group` je Art und `alert_once`.
Echte Alarme (Voralarm, ausgelöst, Erinnerungen dabei, Test), Fragen mit Ja/Nein und „Alarm senden“ aus Regeln gehen immer sofort
und laut raus. Was wann ging, steht in der Ablage (`runtime.notify`), Neustart und Einstellungen zählen nicht neu; `notifications:
{ reset: true }` setzt die Zähler zurück.

### Nach einem Neustart

Nach „HA gestartet“ läuft 120 s die Anlaufphase (`starting`): Geräte melden sich zurück, andere Abläufe (z. B. Flows, die bei jedem
Start einmal laufen) schalten – das zählt nicht als „von Hand“; Heizung und Lichtplan stellen es sofort zurück. Am Ende wird einmal
alles geprüft: jeder Raum der Heizung bekommt sein Ziel, der Lichtplan setzt den Zustand von jetzt durch, die Räume werden neu
bewertet, und jede Solange-Regel, die gilt, bringt ihre Geräte wieder in ihren Zustand (nur Zustands-Schritte wie an/aus,
Helligkeit, Temperatur, Position – keine Nachrichten, Wartezeiten, Tasten oder zeitlich begrenzte Schritte; nur Geräte, die
anders stehen); eine Wechselnd-Regel, die vor dem Neustart im Sonst-Zustand war, ihre Sonst-Schritte. Alarmanlage und
Fenster-Warnung haben ihre eigene Anlaufphase (siehe `alarm.settling`; die Fenster-Warnung reagiert nur auf echtes Öffnen der
Haustür). Im Verlauf steht „Nach dem Start alles geprüft“.

### Hinweise unter „Reparaturen“

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/issues/check` **(admin)** | – | prüft sofort (sonst nach Änderungen und alle 30 min) → `[{ id, key, placeholders }]` |

Hinweise (issue_registry, Domain `house_rules`, `translation_key`): `entity_missing` / `entity_unavailable` (> 24 h; Id `missing_<entity>` / `unavailable_<entity>`, behebbar: Reparatur-Dialog „Gerät ersetzen“), `alarm_notify_missing`, `alarm_no_target` (Fehler), `heating_no_thermostat` (Id `heating_no_thermostat_<raum>`), `card_not_loaded`. Sie verschwinden von selbst, wenn das Problem weg ist. Die Begleit-Integration meldet `floorplan_card` / `frontend_missing`, wenn die Kartendatei im Paket fehlt.

### Anonyme Diagnosedaten (freiwillig, standardmäßig aus)

Was gesendet wird und was nie: `PRIVACY.md` im Wurzelordner des Repositorys; Server: `telemetry/worker/`. Solange in `telemetry.py` kein
`ENDPOINT` steht, ist `available` false, Einschalten wird abgelehnt und nichts gesendet. Gespeichert in `.storage/house_rules.telemetry`
(nicht im Snapshot). Einrichtungsassistent: Schritt `diagnostics` vor `done`, nur wenn `available`.

| Befehl | Parameter | Hinweis |
|---|---|---|
| `house_rules/telemetry/get` | – | `{ on, available, asked, last_report, next_report, errors_pending, privacy_url, last_result, install_id (nur Admins, nur wenn an) }` |
| `house_rules/telemetry/set` **(HA-Admin)** | `on: bool` | an = neue zufällige Kennung (uuid4); aus = Kennung vergessen und Daten auf dem Server löschen (wird wiederholt, wenn offline). Fehler `not_available` ohne Server. Antwort wie `get` |
| `house_rules/telemetry/preview` **(admin)** | – | genau das, was als Nächstes gesendet würde: `{ available, endpoint, report, errors: [] }` |
| `house_rules/telemetry/delete` **(HA-Admin)** | – | „Meine Daten löschen“: `{ ok, deleted, retry? }` oder `{ ok: false, error: "not_available" }`; danach neue Kennung |
| `house_rules/telemetry/send_now` **(HA-Admin)** | – | Wochenbericht und fällige Fehler sofort senden: `{ ok, error?: "off" \| "not_available" }` |
| `house_rules/telemetry/client` | `browser`, `engine`, `engine_version`, `webgl`, `gpu`, `tier`, `profile`, `view`, `screen`, `cores` (alle optional, feste Wertelisten, Unbekanntes wird `other`; andere Felder = Fehler) | die Grundriss-Karte meldet einmal am Tag und Browser ihre Umgebung (alle Nutzer). `{ accepted }`: false, solange aus (dann wird nichts gespeichert) |

Diagnose-Download (Home Assistant, Einstellungen → Geräte & Dienste → … → Diagnose herunterladen): `diagnostics.py` in beiden Integrationen,
Geheimnisse und freie Texte entfernt, Entitäts-IDs, Räume, Personen, Zonen und Gerätenamen als Pseudonyme (`light.e3b0c4`, `area_9f86d0`).

`house_rules/from_text` liefert sofort den Entwurf der eingebauten Satzerkennung (`{ rule, unsure, unknown, sure, sentence }`); ist sie unsicher, fragt der Editor danach `house_rules/ai/improve` (Vorschlag zum Übernehmen). Regel-Option `options.ai_check`: vor jedem Lauf fragt Hausregeln die KI, ob es gerade sinnvoll ist.

---

## 5. Live-Updates: `house_rules/subscribe`

```ts
const unsub = await hass.connection.subscribeMessage((msg) => handle(msg), { type: 'house_rules/subscribe' });
```

Nachrichten:

* `{ kind: 'snapshot', ...Snapshot }` – sofort nach dem Abonnieren und nach größeren Änderungen (Registrierungen, Einstellungen)
* `{ kind: 'update', ...Teile }` – nur die geänderten Teile, gebündelt (≤ 4×/s): `rules`+`active`, `rooms`+`occupancy`+`today`,
  `mode`, `persons`+`residents`, `behaviours`, `suggestions`, `automations`, `devices`+`devices_unused`, `groups`, `zones`, `alarm`, `objects`, `ai`, `mode_auto`, `cleaning`, `plans`,
  `features`+`settings`, `setup`, `window_warning`, `places`
* `{ kind: 'history_add', entry }` – ein neuer Verlaufseintrag (gut für einen „Puls“ im Plan: `entry.rule`, `entry.entities`)

### 5.1 Snapshot

| Feld | Inhalt |
|---|---|
| `version`, `api` | |
| `me` | die eigene Rolle (wie `house_rules/permissions`); in jedem Snapshot je Verbindung |
| `mode` | Hausmodus |
| `rules` | Regeln (Format Kapitel 3; `sentence` = die Regel als lesbarer Satz, `meta.runs_week` = Läufe in 7 Tagen) |
| `active` | `{ rule_id: [instanz] }` – Solange-Regeln, die gerade gelten (`"*"` oder area_id bei „@same“) |
| `rooms` | `[{ id (area_id), name, in, icon (mdi:…), presence, motion, doors, zones, lux, dark_below, empty_after, door_logic, door_pulse, door_pulse_for, dark, behaviours (veraltet) }]` (siehe `room/save`) |
| `occupancy` | `{ area_id: { occupied, since (ISO), by (Sensor/Zone-Name, „Tür geöffnet“), dark, dark_why: [lux/sun/time] (welche Quellen gerade dunkel sagen; leer bei dunkel = gehalten bis es lange genug hell ist), bright_since?, empty_at? } }`. `dark` ist das Dunkel-Signal des Raums: dunkel, sobald Lux unter `dark_below` (nur bei ausgeschaltetem Licht, siehe `dark.lux_when`) ODER Sonne unter `dark.sun` ODER im Zeitfenster; hell erst, wenn alle Quellen `dark.bright_for` Min. lang hell sagen (Hysterese). Dasselbe gilt für `room:<id> is_dark` in Regeln, Lichtplan und intelligentem Licht |
| `today` | `{ area_id: [[von, bis], …] }` belegte Zeiten heute in Stunden (0–24) |
| `devices` | `[{ entity_id, name, kind, room, kind_hint?, room_guess?, no_room?, auto_kind?, auto_room?, auto_name?, icon?, manual?, vehicle? }]` (Zustände selbst aus `hass.states` lesen). `auto_*` = was erkannt wurde, wenn der Nutzer es geändert hat; `manual` = von Hand hinzugefügt; `vehicle` = Name des Fahrzeugs (Art `vehicle`) |
| `devices_unused` | `[{ entity_id, name, kind, room?, reason: user/vehicle, vehicle? }]` – zählen nirgends: vom Nutzer ausgeschlossen oder Teil eines Fahrzeugs (Autotür, Schloss, Bewegung im Auto … – erkannt an Auto-/E-Bike-/Tracker-Integrationen, Herstellern, die nur Fahrzeuge bauen, einem GPS-Tracker am Gerät, der keiner Person gehört und kein Handy ist, oder Fahrzeug-Sensoren wie Kilometerstand und Reichweite) |
| `objects` | Weitere Alarme: `[{ …Einstellungen (siehe objects/save), state: disarmed/armed/pending/triggered, label, since, until, cause, cause_name, by_auto, open }]` |
| `persons` | `[{ id, entity_id, name, home, where, phone, phones, phones_found }]` (`phones_found` = gefundene Handys, `phones` = ohne die abgeschalteten) |
| `zones` | `[{ id, entity_id, name, icon, radius, passive, persons }]` (Orte, `home` zuerst) |
| `groups` | eigene Bereiche |
| `automations` | bestehende HA-Automationen: `[{ entity_id, id, name, enabled, last, uses: [{ entity_id, as: trigger|condition|action }], summary }]` |
| `history` | die letzten 150 Einträge: `{ id, at, kind: rule|automation|manual|skipped|alarm, what, why, rule?, rule_name?, entity_id?, entities? }` |
| `suggestions` | `[{ id, title, why, icon, badge?, rule?, task?: fix_kinds|assign_rooms }]` (die Aufgabe `behaviours` gibt es nicht mehr; dafür je Raum mit Melder und Lautsprecher der Regel-Vorschlag `s_media_pause_<raum>` „Musik pausieren, wenn keiner mehr da ist“) |
| `behaviours` | veraltet: frühere Raumverhalten mit Grundeinstellung `all`; wird nicht mehr ausgeführt (siehe `behaviour/set`) |
| `alarm` | `{ state, label, mode, since, until, cause, cause_name, bypassed, config, suggested }` – `state`: `disarmed`, `arming`, `armed_away`, `armed_night`, `armed_home`, `pending`, `triggered`; `until` = Ende des Countdowns (Unix-Sek.); `settling` = Anlaufphase nach einem Start von HA (60 s nach „gestartet“): nichts löst aus, danach werden Türen/Fenster mit dem beim Herunterfahren gespeicherten Stand verglichen (zu → jetzt offen oder in der Anlaufphase geöffnet = geöffnet, mit Eingangsverzögerung); Bewegungs-/Anwesenheitsmelder zählen erst danach. Ein laufender Countdown (Scharf-/Voralarm-Verzögerung) läuft nach dem Neustart weiter (mind. 30 s). Personen „unbekannt“ → kein automatisches Scharf/Unscharf. |
| `ai` | `{ provider, url, model, has_key, key_hint, status, providers }` |
| `settings` | `{ eco_temp, times?, persons_excluded?, ai_connected, features, notifications, ui? }` (`ui` = Seitenlayout, siehe `house_rules/ui/set`) (`auto_mode` gibt es nicht mehr, siehe `mode_auto.enabled`; `notifications` siehe „Benachrichtigungen“) |
| `starting` | `true` in der Anlaufphase nach einem Start (120 s nach „HA gestartet“): Änderungen durch andere zählen nicht als „von Hand“, danach wird einmal alles geprüft (siehe „Nach einem Neustart“) |
| `features` | `{ alarm, light, heating, vacation, mode_auto, vacuum, ai, window_warning }` (bool, siehe „Funktionen und Einrichtung“) |
| `setup` | Einrichtungsassistent: `{ done, step, answers, migrated?, floorplan, steps, assistants }`; `assistants`: je Funktion mit eigenem Assistenten (`light`, `alarm`, `window_warning`, `vacation`, `vacuum`, `mode_auto`) `{ done, dismissed, configured, at }` |
| `window_warning` | Fenster-Warnung beim Gehen (wie `house_rules/window_warning/get`) |
| `mode_auto` | Hausmodus-Automatik: `{ enabled, modes, target, why, held, wakeup }`; `wakeup`: `{ on, action, feedback, beds, rooms, found_beds: [{ entity_id, name }], found_rooms: [Namen], learned: { work, free: { from, to ("HH:MM", übliche Aufstehzeit), n (Beispiele), need (Min. Bett leer), room (meist belegt danach) | null } }, detections, trips, status (was die Erkennung gerade abwartet, nur während Schlafen), last: { at, up (Minute des Tages), answer, conf } | null }` |
| `plans` | `{ light: { area_id: LightPlan }, heat: { area_id: HeatPlan }, now: { area_id: { light: { occupied, dark, lux, situation, why, held, target }, heat: { temp, why } } } }`. LightPlan: `{ on, rules: [LightRule], empty { mode: off/dim/keep, delay (Min.), dim (%; Dimmen behält Farbe und Farbmodus und macht nie heller als jetzt – auch `own_end.dim`), dim_for (Min., 0 = bleibt gedimmt) }, manual: room_empty/30m/none, guests_keep, vacation { on, lights, start: sunset/time, offset, time, end, brightness, color, random }, smart { mode: off/shadow/on, lights: [ids] (leer = alle im Raum), only_dark, slots: [{ id: morning/day/evening/late/night, from: "HH:MM", brightness, color }] (Startwerte je Tageszeit), guards { max (%), night_max (%), night_warm, off_while: [Klauseln] } }, glow { on, sources: [{ room, by: occupied/light/either/door (door = nur die Tür, ohne Belegung; braucht `door`), door (binary_sensor oder null), door_state: open/closed }] (einer reicht), lights, brightness (%), per_light { light: % }, color, color (Farbtext oder `rules` = wie die Lichtregeln des Raums gerade), only_off: [entity] (nur solange aus, z. B. Fernseher) } }`; `plans.glow` = wann es überhaupt glimmt, für alle Räume: `{ dark: night/dark/time/always, from, to (bei time), not_sleep, not_guests }`, gesetzt mit `house_rules/glow/set` `{ glow }` (Bewohner) (Reinschau-Licht, `glow.py`: wird beim Speichern zu den zwei Lichtregeln `glowauto` (solange) und `glowautok` (bleibt an); `plan/set` nimmt zusätzlich `glow_replace: [Regel-ids]` – von Hand angelegte Regeln für dasselbe, die dabei wegfallen; intelligentes Licht, siehe „Intelligentes Licht“ in 4); LightRule: `{ id, name, enabled, kind: when/while/never_on/keep_on, trigger: [Klauseln] (when: eine wird wahr), when: [Klauseln] (when: nur wenn; sonst: solange), lights: [ids] (leer = alle im Raum), action: LightSetting (siehe 3.2a: an/aus/Szene, Helligkeit % oder 0–255, jede Farbe, Effekt, Übergang, Blitz, `per_light` = jede Lampe einzeln; alte Regeln mit nur `mode`, `brightness`, `color` gelten weiter), variants: [{ id, when, …LightSetting }] („je nach …“; Bedingungen auch als Gruppen), after: restore/off/nothing/others (while), empty_after: off/dim/keep (keep_on), follow_empty (while), own_end { delay, dim (0 = nicht dimmen), dim_for (0 = bleibt gedimmt) } (while, follow_empty aus: eigene Abklingzeit), block_lights: [ids] (while: gesperrt, solange sie gilt), except: [Klauseln] (never_on/keep_on/Sperre: „außer wenn …“, eine reicht), linked: [Lichtregel-ids] (never_on/keep_on: nur solange diese while-Regeln gelten), allow: [`light:<id>` / `rule:<id>`] (never_on/Sperre: diese Regeln dürfen trotzdem einschalten) }`. Wer da ist und der Lichtsensor kommen aus dem Raum (`rooms`). Der Plan setzt sich gegen andere Automationen durch (nur Änderungen von Personen – App, Schalter am Gerät, Sprache – bleiben; Benutzer, die als Automation eingestellt sind – `settings.automation_users`, z. B. Node-RED –, zählen nicht als Person). Eine Sperre gilt für alles außer Personen: schaltet eine andere Lichtregel, Hausregel oder HA-Automation ein gesperrtes Licht ein, geht es sofort wieder aus. now.light: `{ occupied, empty, lux, dark (Dunkel-Signal des Raums), active: [Regelnamen], lights: { entity_id: warum }, held, smart }`; `smart` (nur wenn nicht aus): `{ mode: shadow/on, lights: { entity_id: { mode: on/off, brightness, kelvin, color, why: [Sätze] } }, agree { n, same }, samples }` – was das intelligente Licht gerade will (im Probelauf: „so hätte ich geschaltet“) und warum. HeatPlan (Regler `heating.py`, Zeiten in Minuten, Bruchteile erlaubt): `{ v: 2, on, thermostats: [climate] (leer = alle im Raum), sensor: Raumthermometer oder null, calibrate: auto/offset/target/off, temps { comfort, base, eco, night, frost }, blocks: [{ from, to, days: all/workdays/weekend, level: comfort/eco/night/custom, temp (bei custom) }], presence { away, away_after, empty, empty_after, home_soon }, sleep, guests, manual: smart/next_block/hours/room_empty/never (Standard smart: bis Hausmodus wechselt, alle weg, Raum 45 Min. leer, nächster echter Planwechsel Komfort/Absenken/Nacht; Fenster unterbricht nur), manual_hours (bei hours), manual_max (Std., 1–12, Standard 4: Höchstdauer bei smart), window { on, contacts (leer = Fenster des Raums), extra, delay, resume, action: off/frost, drop, drop_k }, preheat { on, max, learn (Standard true = Aufheiztempo aus dem Raum lernen), rate (°C/h, gilt bei learn: false) }, vent { on (auch ohne Regelung: Plan aus, Erinnerungen an), times: ["08:00"], humidity_on, humidity (%), humidity_sensor, co2_on, co2 (ppm), co2_sensor (null = im Raum gefunden), mould, close, close_after (0 = nach Außentemperatur), wait }, valves { stuck }, smart { mode: schedule/smart, style: comfort/eco/sport, ramp { step (°C), minutes } (null = wie der Stil), shadow_days (0 = ohne Beobachten: übernimmt sofort, auch aus einem laufenden Schattenbetrieb), shadow_since (Sekunden; gesetzt = Schattenbetrieb, beim Wechsel auf smart automatisch), guard { max, min, occupied_min, max_setback, never { on, from, to } } (nur die Schlüssel, die vom ganzen Haus abweichen), valve { on } (Ventil direkt steuern), radiator_w, area, building: unknown/old/partial/new/passive/floor (Vorwissen für Aufheizen/Abkühlen), sv (Stil-Version, 2 = neu skaliert: Komfort = früheres Eco), room_type: auto/normal/short/pass (Raumart; auto = aus dem Bereich erkannt) }, own: [Abschnitte mit eigener Einstellung] }`. Abschnitte (`own`, Hausvorgaben `plans.heating.config.defaults`): `comfort` (temps.comfort), `temps` (base, eco, night, frost), `presence`, `modes` (sleep, guests), `manual` (manual, manual_hours, manual_max), `window` (on, delay, resume, action, drop, drop_k – nicht die Kontakte), `vent` (on, humidity_on, humidity, co2_on, co2, mould, close, close_after, wait – nicht Sensoren und Zeiten), `preheat`, `style` (smart.style, smart.ramp), `valve` (smart.valve), `building` (smart.building), `shadow` (smart.shadow_days). Ohne eigene Einstellung liefert der Snapshot die Werte der Hausvorgabe. Beim Speichern (`plan/set`) wird ein Abschnitt zur eigenen Einstellung, wenn seine Werte von der Hausvorgabe abweichen oder `own` ihn nennt; `reset: [Abschnitte]` stellt zurück auf „wie im ganzen Haus“. Wechselt ein Raum auf smart, fällt der unveränderte Werks-Block (06–22 täglich Komfort) weg. Intelligent (smart, nach dem Schattenbetrieb) ersetzt die Schritte ab „Weg / alle weg“: Schlafen → Nacht, Gäste → Komfort, alle weg → absenken, wenn es sich bis zur üblichen Rückkehr lohnt (Ortsmodul `core.places` oder Heimweg), jemand im Raum → Komfort, feste Zeit → ihre Temperatur, übliche Lüftzeit jetzt → niedrig (level `airing`), gelernte Belegung ≥ Schwelle des Stils (gekappt durch „jemand zuhause“, wenn gelernt; Bad/WC: nur in gelernten kurzen Fenstern, Flur: nie) → Komfort, sonst bis zur nächsten Nutzung absenken und rechtzeitig vorheizen, aber erst nach einer üblichen Lüftzeit dazwischen (level `setback`/`preheat`/`night`/`airing`); danach Rampe/Schub des Stils und die Grenzen (immer zuletzt). Lernphase (weniger als 5 gelernte Tage der Art von heute): statt Gewohnheit nach Anwesenheit – jemand zuhause (oder keine Personen erfasst) → Komfort, alle weg (mit `presence.away`) → eco (Spar-Temperatur, höchstens `max_setback` unter Komfort), Flur → eco, Raum leer (mit `presence.empty`) → eco, gelernte Schlafenszeit → night (level `comfort`/`eco`/`night`, `smart.learning: true`). Vorrang: Funktion/Plan aus → Ventilschutz → Fenster offen (nach `delay`, 0 = sofort) bzw. Temperatursturz, nach dem Schließen `resume` warten (Bruchteile = Sekunden; 3 Öffnungen binnen 10 Min. → mindestens 2 Min., `window.flapping`); Thermostat meldet selbst offenes Fenster → Finger weg → Sommer → Urlaub (frost) → von Hand → Weg / alle weg (eco, außer jemand auf dem Heimweg) → Schlafen (night) → Gäste (comfort) → Raum leer (eco) → Zeitblock oder Vorheizen → base. now.heat (HeatStatus): `{ line (Statuszeile auf Deutsch), mode: heat/off/hands_off, temp (Ziel), level, why, until, current (Raumtemperatur), window { state: closed/waiting/open/settling, since, left, names, flapping }, valve (%), heating, reached, manual (`{ entity, temp, off, at, key, who, mode, home, edge { at, cls: comfort/low/night } | null, win }` – mode/home/edge nur bei smart: Hausmodus und ob jemand zuhause war beim Verstellen, nächster Planwechsel; win = ein Fenster hat unterbrochen, der Wert kommt danach zurück; bleibt über Neustarts im Speicher `runtime.heat_manual`), unreachable, thermostats: [{ entity_id, name, available, mode, target, current, valve, valve_source, action, own_window, calibration, correction }], hints, vent { state: ok/ventilate/airing/close_window/off, reason, minutes, humidity, co2, outside, mould }, rate (°C/h), rate_learned, preheat, smart (HeatSmartStatus) }`. HeatSmartStatus: `{ mode, phase: schedule/shadow/active, style, valve { available, on, state: off/on/shadow/none/setpoint/fallback/window (Fenster offen: Ventil zu), why, u (%), commands }, shadow { since, days, left (Tage), ready }, would { temp, why, level } (Schatten: was die intelligente Heizung jetzt täte), confidence (0…1), chain [Gründe auf Deutsch], guards [{ guard: max/min/never/occupied, wanted, got }], next { at, temp, preheat }, learned_days, learning (Lernphase: heizt nach Anwesenheit), building, kind: normal/short/pass, room_type `{ kind (was gilt), setting: auto/normal/short/pass, auto (erkannt), source: label/icon/name/devices/humidity/usage/default, detail (Label, Symbol, Name, Gerät, Tage mit schnellem Feuchte-Anstieg, mittlere Besuchsdauer in Min.) }` }`. Raumart (auto): erkannt aus dem Home-Assistant-Bereich, in dieser Reihenfolge – Labels des Bereichs (Name oder Symbol), Symbol des Bereichs (z. B. `mdi:shower`, `mdi:bathtub`, `mdi:toilet` = kurz genutzt; `mdi:stairs`, `mdi:door…`, `mdi:coat-rack` = Durchgang), Name (deutsch/englisch; ein klarer Wohnraum-Name wie „Küche“ bleibt normal), Geräte im Bereich (Dusche, WC, Handtuchheizkörper …), Luftfeuchte steigt an mindestens 3 Tagen schnell um 10 Prozentpunkte (Duschen), gelernte Besuche (mindestens 15, nur kurze: kurz genutzt bzw. Durchgang). Eine eigene Raumart gewinnt immer. plans.heating: `{ config: HeatingConfig { outside, summer { on, above, hold }, demand { on, entity, above (%), min_on, min_off }, exercise { on, weekday (0 = Mo), time, minutes }, notify: [person-id], quiet { on, from, to }, gap }, enabled, outside { entity, name, value, auto }, summer, demand { on, why, wait }, exercise_until, last_exercise, config.smart { guard { max, min, occupied_min, max_setback, never { on, from, to } } (Grenzen, gelten immer zuletzt), energy { kind: auto/gas/oil/heat_pump/heat/electric, meter (null = aus dem Energie-Dashboard), price (€/kWh, null = aus dem Energie-Dashboard), gas_kwh_m3, cop, efficiency }, airing { morning (true/false/null = nicht gefragt), minutes, rooms (leer = alle) } (Lüft-Vorwissen, bis die Fensterkontakte es gezeigt haben), setup_done (Heizungs-Assistent fertig) }, config.defaults { comfort, temps, presence, modes, manual, window, vent, preheat, style, valve, building, shadow } (Hausvorgaben je Abschnitt), config.defaults_v (1 = einmalige Umstellung erledigt), config.manual_v (1 = „bis zur nächsten Zeit“ einmal zu „Intelligent“ umgestellt), rooms: { area_id: { thermostats, sensors, contacts, doors, humidity, co2, valves, calibration, own_window } } (Vorschläge aus den Geräten) }` |
| `cleaning` | Saugroboter-Pause: `{ on, vacuums, sensors, after, active, since, until }` |
| `places` | Wo ist wer: `{ persons: [{ id, entity_id, name, picture, state: zone/place/stay/moving/unknown, place (Zonen-Id oder lp_…, nur wenn mit Namen bekannt), place_name, since, line (Statuszeile, z. B. „Arbeit · seit 8:12“, „Unterwegs · wahrscheinlich nach Hause · ca. 12 Min.“, „Hauptstraße 12 · seit 9:40“), street, lat, lon, speed_kmh, trend: closer/away, distance_home_km, prediction { destination, name, probability, eta_min (Restminuten jetzt, zählen zwischen zwei Positionen herunter), arrive_at (Sekunden: voraussichtliche Ankunft, geschätzt an der letzten Position), as_of (Sekunden: diese Position), basis, distance_km (Luftlinie bis zum Ziel) }, mode: walk/bike/car/transit/null (wie unterwegs; null = unsicher oder nicht unterwegs), mode_confidence (0…1), mode_basis: activity (Aktivitäts-Sensor der Companion-App: Android `*_detected_activity`, iOS `*_activity`)/vehicle (ein Fahrzeug-Tracker fährt mit)/speed (Tempoprofil: ab 40 km/h Motor – Auto, sehr gerade ab 60 km/h Bahn –, nie über 9 km/h zu Fuß, gleichmäßig bis 30 km/h Rad, sonst null; ab 160 km/h schnurgerade Bahn)/null, updated (letzte Position) }], learned: [{ id, name, label, lat, lon, radius, visits, street, typical { days: workdays/weekend/mixed, arrive, stay_min }, last }], settings { learn, nominatim }, stats { trips, warming, nominatim_requests } }` |
| `residents` | alle Personen: `[{ entity_id, name, counts, tracked, state }]` (`counts: false` = herausgenommen) |

---

### 5.2 „So denkt deine Heizung“ (HeatExplain)

Antwort von `house_rules/heating/explain`: `{ room, status (HeatSmartStatus), today: [{ from, to, temp, level, why, confidence }] (ein üblicher Tag), heatmap: [7 Tage Mo–So × 96 Viertelstunden in %] (gelernte Belegung), habits { wake { work, free }, sleep { work, free }, days { key: Tage }, warm, since }, days, decisions: [{ t, temp, level, why, chain, confidence }] (neueste zuerst), guards: [{ t, guards }], forecast: [{ t, target, temp }] (12 Std., halbstündlich; temp = vom Raummodell erwartet), shadow { rows: [[t, real, would, Raumtemperatur]], kh_real, kh_would, saved_pct }, model { k_l (1/h), k_h (°C/h bei offenem Ventil; bis 6 Proben mit der Bauweise gemischt), n_c, n_h, confidence, rate_now, heat_3k_min, cool_per_h, lag_min (Verzögerung aus der Bauweise), building, k_d (1/h, zusätzlicher Verlust bei offener Tür zur übrigen Wohnung – Türkontakte des Raums, die keine Fensterkontakte der Heizung sind; negativ = Wärme kommt herein), n_d, k_w (1/h, offenes Fenster, aus kurzen Lüftungen gelernt), n_w, door_per_h / window_per_h (°C/h jetzt, null bis gelernt) }, energy (HeatEnergySummary), outside }`. HeatEnergySummary (immer eine Schätzung): `{ estimate: true, meter { kind, entity, unit, price, price_unit: unit/kWh, source: energy/manual/null, label }, from_meter, efficiency, today|week|month { kwh (Wärme), fuel_kwh, cost (€ oder null ohne Preis), saved_kwh, saved_cost, rooms { area_id: { kwh, cost, saved_kwh, saved_cost } } }, radiator_w { area_id: W } }`. Mit Zähler wird dessen Verbrauch nach Ventilstunden auf die Räume verteilt, ohne Zähler: Heizkörperleistung × Ventilstunden ÷ Wirkungsgrad (Wärmepumpe: COP). „Gespart“ = verglichen mit immer Komfort (Verhältnis der Gradstunden). Mit `room: "_house"` nur `{ energy, habits, outside }` für alle Räume.

Heiz-Vorschläge (nur für Räume mit Zeitplan und aus wiederholten Handänderungen; aus echten Belegungsspitzen, Bad/WC nur kurze Fenster) stehen in `suggestions` mit `task: "heat_block"` und `heat { room, kind: habit/manual, block }`; übernehmen mit `heating/do` `accept_proposal`, ablehnen wie jeder Vorschlag mit `suggestion/dismiss`.

## 6. Entitäten, Ereignisse, Dienste


`switch.hausmodus_schlafen`, `switch.hausmodus_weg`, `switch.hausmodus_urlaub`, `switch.hausmodus_gaeste`: der Hausmodus als an/aus (an, solange dieser Modus gilt; einschalten setzt ihn, ausschalten setzt „Zuhause“). Dazu wie bisher `select.hausmodus` und `sensor.hausmodus`.

| Was | Entität | Hinweis |
|---|---|---|
| je Regel | `switch.hausregel_<name>` | an = Regel aktiv. Attribute: `rule_id`, `sentence`, `type`, `last_run`, `paused_until`, `active` |
| Hausmodus | `select.hausmodus` | Optionen: Zuhause, Weg, Schlafen, Urlaub, Gäste |
| je Raum | `binary_sensor.<raum>_belegt` | device_class occupancy; Attribute `since`, `detected_by`, `dark` |
| Alarmanlage | `alarm_control_panel.alarmanlage` | Standard-Alarmzentrale von HA (Code, falls PIN gesetzt) |
| je weiterem Alarm | `alarm_control_panel.alarm_<name>` | `disarmed` / `armed_away` / `pending` / `triggered`; Code = PIN der Alarmanlage, wenn der Alarm sie verlangt. Attribute `object_id`, `kind`, `cause`, `cause_name`, `sensors`. Die Entitäts-ID kommt vom ersten Namen, Umbenennen ändert nur den Namen |
| Alarm-Zustände | `binary_sensor.alarmanlage_scharf`, `binary_sensor.alarmanlage_voralarm`, `binary_sensor.alarmanlage_alarm`, `sensor.alarmanlage_zustand` | für Auslöser in anderen Automationen und Dashboards |
| Hauptschalter | `switch.alarmanlage_aktiv` | = Funktion „Alarmanlage“. Aus geht nur, wenn sie unscharf ist (sonst Fehler „erst ausschalten“) – kein Umweg um die PIN |
| Hausmodus | `sensor.hausmodus` | Zustand `home/away/sleep/vacation/guests`, Attribute zur Automatik |
| Heizung je Raum | `sensor.<raum>_heizplan` | Zieltemperatur (°C; kein Wert = Heizung aus), Attribute `status` (Statuszeile), `level`, `reason`, `until`, `heating_off`, `current_temperature`, `valve`, `heating`, `reached`, `window` (closed/waiting/open/settling), `manual`, `hints`. Nur für Räume mit Heizplan oder Lüft-Erinnerung; nicht verfügbar, solange der Plan oder die Funktion Heizung aus ist |
| Lüften je Raum | `sensor.<raum>_lueften` | `ok` / `lueften` / `lueftet` (Fenster offen) / `fenster_zu` (beim Heizen zu lange offen) / `aus`; Attribute `reason`, `minutes` (empfohlene Stoßlüft-Dauer nach Außentemperatur), `humidity`, `co2`, `outside`, `mould_risk` (% Feuchte an kalter Außenwand) |
| Wärmeanforderung | `binary_sensor.heizung_waermeanforderung` | an, solange ein Ventil weiter offen ist als eingestellt (oder ein Thermostat ohne Ventilwert heizt), mit Mindestlauf-/Pausenzeit; Attribute `reason`, `summer`, `outside` |
| Alarm-Zentrale | Seite `/hausregeln/alarm` | öffnet sich aus der Handy-Nachricht: Status, Ausschalten (PIN / Face ID), Live-Kameras |

Ereignisse auf dem HA-Bus (`hass.connection.subscribeEvents(cb, 'house_rules_fired')`):

* `house_rules_fired` – `{ rule_id, name, what: [text], why, entities: [entity_id] }` bei jedem Lauf
* `house_rules_logbook` – `{ kind, what, why, entity_id? }`: eine Zeile für das Logbuch von Home Assistant (nur Lohnendes: scharf/unscharf, Alarm,
  PIN-Sperre, Fenster-Warnung und Bestätigung, Entscheidungen von Heiz- und Lichtplan, Sommer-/Heizbetrieb, Ventilschutz, Lüft-Erinnerung,
  automatischer Hausmodus). `logbook.py` beschreibt dieses Ereignis und `house_rules_fired` („<Regel> hat ausgeführt: … Grund“, verknüpft mit
  dem Schalter der Regel); übersprungene Läufe, Tests und kleine Abgleiche bleiben im eigenen Verlauf
* `house_rules_alarm` – `{ state, mode, cause }` bei jeder Änderung der Alarmanlage
* `house_rules_object_alarm` – `{ id, state, cause }` bei jeder Änderung eines weiteren Alarms
* `house_rules_ventilate` – `{ room, room_name, reason: humidity/co2/mould/time/close_window, message, minutes }` bei jeder Lüft-Erinnerung (je Grund höchstens stündlich; kommt auch in der Ruhezeit, nur die Handy-Nachricht nicht)
* `house_rules_ventilate` – `{ room, room_name, reason: humidity/co2/mould/time/close_window, message, minutes }` einmal je Anlass (Feuchte/CO₂/Schimmelgefahr: von „über der Grenze“ bis deutlich darunter; Lüftungsplan: je Zeit und Tag; Fenster: je Öffnen). Kommt auch in der Ruhezeit und wenn die Handy-Nachricht durch die Grenzen von „Benachrichtigungen“ ausfällt. Speichern von Einstellungen beginnt keinen neuen Anlass; ein Anlass, den es nur durch eine geänderte Einstellung gibt (z. B. niedrigere Grenze), bleibt ohne Handy-Nachricht

Dienste (folgen den Rollen, wenn eine Person sie aufruft; aus Automationen/Skripten ohne Person immer): `house_rules.run` (`rule_id`), `house_rules.pause` **(bewohner)** (`rule_id`, `minutes`, 0 = Pause aufheben), `house_rules.reset_alarm_pin` **(admin)** (`remove_pin`, Standard `false`: hebt jede PIN-Sperre auf; `true` löscht zusätzlich die PIN, Bestätigung dann „ohne“).

PIN-Sperre über die Kommandozeile (ohne Anmeldung, wer an den Konfigurationsordner kommt, besitzt Home Assistant ohnehin): `touch /config/house_rules_pin_reset` hebt die Sperre auf, `echo pin > /config/house_rules_pin_reset` entfernt zusätzlich die PIN. Die Datei wird beim nächsten PIN-Versuch oder Start gelesen, danach gelöscht; beides steht im Verlauf.

---

## 7. Ideen für die Grundriss-Karte (abgesprochen mit dem Nutzer)

1. **Bearbeiten-Modus: Gerät antippen → Regeln** – `<house-rules-device standalone>` im Gerät-Popup (Variante A). Im Plan
   kleine Zähler am Gerät aus `house_rules/for_entities` (alle Geräte in einem Aufruf; `starts.length`, `switches.length`).
2. **Regel im Plan zeigen** – `house_rules/rule/entities` liefert die Geräte je Satzteil: Auslöser orange, Bedingungen türkis,
   Aktionen blau umranden und mit einer Linie verbinden (Farben 2.7). Räume (`room`) als Fläche hervorheben.
3. **Puls beim Auslösen** – auf `history_add` (Abo) oder `house_rules_fired` reagieren: betroffene Geräte kurz aufleuchten lassen.
4. **Belegte Räume** – `occupancy[area_id].occupied` bzw. `binary_sensor.<raum>_belegt`; Räume der Karte über `area` zuordnen.
5. **Alarmanlage** – Zustand aus `alarm` (Abo) oder `alarm_control_panel.alarmanlage`; bei `pending`/`triggered` den auslösenden
   Sensor (`cause`) im Plan rot markieren, Countdown aus `until`.
6. **Hausmodus** – `select.hausmodus` oder `house_rules/mode/set`, z. B. als Schalter im Kopf der Karte.
7. **Schnell eine Regel** – „Beschreib einfach …“ (`house_rules/from_text`) und den Entwurf im Editor (Variante B) öffnen.

## 8. Grenzen und Hinweise

* Speichern, Löschen, Räume/Bereiche/Alarm einrichten: **nur Admins**. An/Aus, Pause, Hausmodus, Alarm scharf/unscharf: alle Nutzer.
* Nach der Installation ist nur „Hausmodus automatisch“ an; der Einrichtungsassistent öffnet sich und schaltet ein, was gewünscht ist. Es schaltet nichts von selbst.
* Ist eine Funktion aus (`features`), ist ihr Teil wirklich gestoppt; die Karte sollte dann z. B. keine Alarmanlage oder Fenster-Warnung anbieten.
* Hausregeln ändert nichts an HA-Bereichen oder Gerätearten; Korrekturen bleiben in der Integration.
* Text → Regel nutzt zurzeit die eingebaute Satzerkennung. Ein angebundenes Sprachmodell (`ai`) wird im nächsten Schritt eingebaut.
* Python-Änderungen an der Integration brauchen einen HA-Neustart, das Frontend (`frontend/house-rules-panel.js`) nur ein Neuladen.

## 8. Entfernen

Ausschalten oder Neuladen der Integration behält alles. Erst **Löschen** (Einstellungen → Geräte & Dienste → Hausregeln → Löschen) räumt auf
(`async_remove_entry`, `uninstall.py`): alle Speicherdateien (`house_rules`, `.history`, `.habits`, `.smart_heat`, `.telemetry`, `.versions`),
die Hinweise unter Reparaturen, die Daten auf dem Diagnose-Server (falls je eingeschaltet), Alarm- und Fenster-Warnungs-Nachrichten auf den Handys
(per `clear_notification`). Entitäten und Gerät entfernt Home Assistant selbst, Seitenleiste und Dienste entfernt schon das Entladen. Hausregeln legt
keine Helfer, Dashboard-Ressourcen oder Benachrichtigungs-Kategorien an. Die Begleit-Integration löscht beim Entfernen ihre Datei
`floorplan_card`, ihre Reparatur-Hinweise, das Ladeskript für die Dashboards und Dashboard-Ressourcen, die auf ihre Dateien zeigen.
