# Privacy

roomwise runs entirely inside your Home Assistant. There is no roomwise account and no tracking. The only
roomwise service is the optional, anonymous diagnostics server described below. [Deutsch](#deutsch)

## What is stored, and where

Everything lives in your Home Assistant's own storage (`.storage/` in the config folder) and in the dashboard
configuration, never in this repository or anywhere else:

- **Card:** the floor plan, the links between plan and entities, view settings per user. Part of the dashboard.
- **Companion integration:** walk times and check-offs, the state of the front door alert, learned robot vacuum
  paths and the vacuum map alignment.
- **Wi-Fi QR codes:** the Wi-Fi networks an admin enters for the QR codes on the tablets (name, SSID, password,
  encryption) are stored locally in Home Assistant (`.storage/floorplan_card.wifi`, in plain text like every
  Home Assistant storage file), never in the dashboard configuration, the diagnostics (only their number) or the log.
  Every signed-in user can read the networks not marked "admins only" (whoever may open the popup on a tablet sees
  the QR code anyway). A QR code read from a picture in the editor is decoded in the browser; the picture is not
  uploaded or kept.
- **Hausregeln:** rules, rooms and their sensors, light and heating plans, house mode settings, alarm settings
  (the PIN only as a salted PBKDF2 hash, passkeys only as public keys), the history of what ran and why, and the
  daily patterns the vacation mode learns from your recorder.

Removing an integration keeps its files in `.storage/` (`floorplan_card`, `house_rules`, `house_rules.*`), so a
reinstall picks up where you left off. Delete those files while Home Assistant is stopped if you want the data gone.

## What leaves your network

- **Card and the card part of roomwise:** nothing. Even the 3D models are served by your own Home Assistant.
  Notifications and announcements use your own `notify` and `tts` services, and only when you set them up.
- **Hausregeln:** only what an administrator configures:
  - the **AI provider** you choose for sentence rules (a local Ollama, or Gemini, OpenAI, Anthropic, Mistral or
    an OpenAI-compatible service). It receives the sentence you typed and the names of your rooms, devices and
    people that are needed to turn it into a rule.
  - **CallMeBot** for alarm calls and messages via Telegram or Signal: the alarm text and your Telegram user name
    or Signal number.
  - **your own SMTP server** for alarm e-mails.
  - **OpenStreetMap Nominatim** (on by default, can be switched off; switch "Look up place names online" in Hausregeln → Zuhause →
    Orte): only for phones that give no place name themselves – when somebody stops at an unknown spot, the
    position rounded to about 10 m goes to nominatim.openstreetmap.org to get the name of the place (at most once
    per second, answers are cached locally, a neutral User-Agent without personal data).

None of these is used unless you enter or switch it on in Hausregeln.
- **Anonymous diagnostics** (Hausregeln, opt-in, off by default): see below.

## Anonymous diagnostics (opt-in, off by default)

To make roomwise work with as many devices, integrations and browsers as possible, you can send anonymous
diagnostics once a week. Only an administrator can switch it on: in the setup wizard or under Hausregeln →
Einstellungen → Diagnosedaten. **"Vorschau: genau das wird gesendet"** (preview) always shows the exact content
that would be sent.

**What is sent**

- a random id (UUID), created anew whenever you switch it on, linked to nothing else
- versions of roomwise, Home Assistant and Python, the installation type (e.g. "Home Assistant OS")
- Home Assistant's language and unit system
- counts: entities per domain and per device class
- integrations with counts per domain (e.g. "climate via zha: 4"). Private, unpublished custom integrations are
  reported only as "custom"; only built-in and published ones (GitHub link in their manifest) are named
- device capabilities as standard values (e.g. hvac modes, temperature step, whether a valve position exists,
  light color modes, number of fan speeds)
- which roomwise features are on, and counts (rules, rooms, light and heating schedules, groups, persons)
- from the floor plan card, once per day and browser: browser family and engine major version, WebGL level,
  graphics chip family, measured 3D performance tier, screen class, CPU core range
- errors in roomwise code: exception type and the affected lines of roomwise code (file, line, function) –
  **without** the message. At most 10 error reports a day, each error at most once a day

**What is never sent**

Entity ids, names of devices, areas, zones, persons or users, location and coordinates, time zone, country, IP
addresses (roomwise sends none; see below about the server), credentials, tokens and any free text (rule names,
messages, error messages). The report is built from enumerations and numbers only; before sending, a last check
drops any value that equals an entity id or a name from your home.

**Switching off and deleting**

- Switching off stops sending immediately, forgets the id and deletes your data on the server (retried
  automatically if the server cannot be reached).
- "Meine Daten löschen" (delete my data) deletes everything stored under your current id; a new id is used from then on.
- Error totals that were already summed up (without any id) remain, anonymously.

**The server**

The data goes to a Cloudflare Worker run by the roomwise developers (code: `telemetry/worker/`). It stores only
the validated report – no IP addresses, no headers – and writes no logs. Cloudflare, as the network operator,
briefly processes the connection's IP address to deliver the request and protect against abuse
([Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/)); Workers logging ("Workers Logs",
"Logpush") is turned off. Retention: reports 400 days, errors 180 days after they were last seen. The legal basis
is your consent (Art. 6(1)(a) GDPR), which you can withdraw at any time by switching it off.

As long as the server is not deployed, the switch shows "noch nicht verfügbar" (not available yet) and nothing is sent.

## Bug reports

Home Assistant offers "Download diagnostics" for both integrations (Settings → Devices & services). The file
stays on your computer until you attach it somewhere yourself, e.g. to a GitHub issue. Secrets and free text are
removed (PIN, passkeys, API keys, messenger and mail accounts, names, messages) and all entity ids, areas,
persons, zones and device names are replaced by stable pseudonyms (e.g. `light.e3b0c4`).

When you attach logs or diagnostics to an issue, look through them first. Remove names, addresses, camera links
and anything else you don't want public.

## Deutsch

### WLAN-QR-Codes

Die WLAN-Netze, die ein Administrator für die QR-Codes auf den Tablets einträgt (Name, SSID, Passwort,
Verschlüsselung), liegen lokal in Home Assistant (`.storage/floorplan_card.wifi`, im Klartext wie jede
Speicherdatei von Home Assistant) – nie in der Dashboard-Konfiguration, in der Diagnose (nur ihre Anzahl) oder im
Log. Alle angemeldeten Benutzer können die Netze lesen, die nicht „Nur für Admins“ sind (wer das Popup auf einem
Tablet öffnen darf, sieht den QR-Code ohnehin). Ein QR-Code, der im Editor aus einem Bild gelesen wird, wird im
Browser entschlüsselt; das Bild wird weder hochgeladen noch gespeichert. Beim Löschen der Integration wird die
Datei mit entfernt.

### Ortsnamen von OpenStreetMap (Hausregeln, standardmäßig an, abschaltbar)

„Wo ist wer“ nennt Orte so, wie das Handy (Home-Assistant-App, Adress-Sensor) sie nennt – das bleibt lokal. Für
Handys ohne eigenen Ortsnamen fragt Home Assistant bei nominatim.openstreetmap.org nach („Ortsnamen im Internet
nachschlagen (OpenStreetMap)“, standardmäßig an; ein Administrator kann es ausschalten): Hält jemand an einem unbekannten Ort an, geht
die auf etwa 10 m gerundete Position dorthin (höchstens einmal pro Sekunde, Antworten werden lokal gemerkt, ein
neutraler User-Agent ohne persönliche Daten). Ausschalten beendet das sofort.

### Anonyme Diagnosedaten (freiwillig, standardmäßig aus)

Damit roomwise mit möglichst vielen Geräten, Integrationen und Browsern funktioniert, kannst du einmal pro
Woche anonyme Diagnosedaten senden. Einschalten nur durch einen Administrator: im Einrichtungsassistenten oder
unter Hausregeln → Einstellungen → Diagnosedaten. Dort siehst du unter **„Vorschau: genau das wird gesendet“**
jederzeit genau den Inhalt, der gesendet würde.

**Was gesendet wird**

- eine zufällige Kennung (UUID), die beim Einschalten neu erzeugt wird; sie hängt an nichts anderem
- Versionen von roomwise, Home Assistant und Python, die Art der Installation (z. B. „Home Assistant OS“)
- Sprache von Home Assistant und Einheitensystem (metrisch / US)
- Anzahlen: Entitäten je Domäne (z. B. 12 Lichter), je Geräteklasse (z. B. 6 Fenstersensoren)
- Integrationen mit Anzahl je Domäne (z. B. „Heizung über zha: 4“). Eigene, nicht veröffentlichte Integrationen
  erscheinen nur als „custom“; genannt werden nur eingebaute und veröffentlichte (mit GitHub-Link im Manifest)
- Fähigkeiten der Geräte als Standardwerte (z. B. Heizmodi, Temperaturschritt, ob es eine Ventilstellung gibt,
  Farbmodi von Lampen, Anzahl der Saugstufen)
- welche Funktionen von roomwise an sind, und Anzahlen (Regeln, Räume, Licht- und Heizpläne, Bereiche, Personen)
- von der Grundriss-Karte, einmal pro Tag und Browser: Browserfamilie und Hauptversion der Engine,
  WebGL-Stufe, Familie des Grafikchips (z. B. „adreno“), gemessene 3D-Leistungsstufe, Bildschirmklasse
  (Handy/Tablet/PC), CPU-Kerne als Bereich
- Fehler im Code von roomwise: Art des Fehlers (z. B. `KeyError`) und die betroffenen Zeilen im roomwise-Code
  (Datei, Zeile, Funktion) – **ohne** Fehlermeldung. Höchstens 10 Fehlerberichte am Tag, jeder Fehler höchstens
  einmal am Tag

**Was nie gesendet wird**

Entitäts-IDs, Namen von Geräten, Räumen, Zonen, Personen oder Benutzern, Standort und Koordinaten, Zeitzone,
Land, IP-Adressen (roomwise sendet keine; siehe unten zum Server), Zugangsdaten, Tokens und jeder freie Text
(Regelnamen, Nachrichten, Fehlermeldungen). Der Bericht wird nur aus Aufzählungswerten und Zahlen gebaut; vor
dem Senden entfernt eine letzte Prüfung jeden Wert, der einer Entitäts-ID oder einem Namen aus deinem Zuhause
entspricht.

**Ausschalten und Löschen**

- Ausschalten beendet das Senden sofort, vergisst die Kennung und löscht deine Daten auf dem Server (ist er
  nicht erreichbar, wird das Löschen automatisch wiederholt).
- „Meine Daten löschen“ löscht alles zu deiner aktuellen Kennung auf dem Server; danach gilt eine neue Kennung.
- Bereits zusammengezählte Fehlerzahlen (ohne Kennung) bleiben anonym erhalten.

**Der Server**

Die Daten gehen an einen Cloudflare Worker der roomwise-Entwickler (Code: `telemetry/worker/`). Er speichert nur
den geprüften Bericht – keine IP-Adressen, keine Header – und schreibt keine Logs. Cloudflare selbst verarbeitet
als Betreiber des Netzes die IP-Adresse der Verbindung kurzzeitig, um die Anfrage zuzustellen und vor Missbrauch
zu schützen ([Datenschutz von Cloudflare](https://www.cloudflare.com/privacypolicy/)); die Protokollierung von
Workers („Workers Logs“, „Logpush“) ist abgeschaltet. Aufbewahrung: Berichte 400 Tage, Fehler 180 Tage nach dem
letzten Auftreten. Rechtsgrundlage ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit durch
Ausschalten widerrufen kannst.

Solange der Server nicht eingerichtet ist, zeigt der Schalter „noch nicht verfügbar“ und es wird nichts gesendet.

### Diagnose-Download für Fehlerberichte

Home Assistant bietet für beide Integrationen „Diagnose herunterladen“ (Einstellungen → Geräte & Dienste). Die
Datei bleibt auf deinem Rechner, bis du sie selbst z. B. an ein GitHub-Issue hängst. Darin sind Geheimnisse und
freie Texte entfernt (PIN, Passkeys, API-Schlüssel, Messenger- und Mailkonten, Namen, Nachrichten) und alle
Entitäts-IDs, Räume, Personen, Zonen und Gerätenamen durch feste Pseudonyme ersetzt (z. B. `light.e3b0c4`).
