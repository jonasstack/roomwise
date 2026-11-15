# Sicherheit / Security

[Deutsch](#deutsch) · [English](#english)

---

## Deutsch

### Unterstützte Versionen

roomwise ist noch in der Beta. Sicherheitskorrekturen gibt es nur für die **neueste Beta-Version** (`0.1.0-beta.x`). Bitte vor einer Meldung auf die neueste Version aktualisieren.

| Version | Unterstützt |
| --- | --- |
| neueste `0.1.0-beta.x` | ja |
| ältere Versionen | nein |

### Eine Sicherheitslücke melden

Bitte **nicht** als öffentliches Issue melden. Stattdessen privat über GitHub:
**[Security → Report a vulnerability](https://github.com/jonasstack/roomwise/security/advisories/new)** (GitHub Security Advisories).

Hilfreich sind: betroffene Version, Teil (Karte, Begleit-Integration `floorplan_card`, Hausregeln `house_rules`), Schritte zum Nachstellen und was jemand damit erreichen kann. Du bekommst eine Antwort, sobald die Meldung gesichtet ist; die Korrektur erscheint in einer neuen Alpha-Version, danach wird die Meldung veröffentlicht. Bitte keine Tests gegen fremde Home-Assistant-Installationen.

### Was roomwise speichert

Alles liegt nur im eigenen Home Assistant:

- **Karte:** der Grundriss in der Dashboard-Konfiguration (Räume, Türen, Fenster, Möbel, Zuordnung zu Entitäten).
- **Begleit-Integration** (`.storage/floorplan_card`): Einstellungen der Haustür-Warnung, Gassi-Zeiten und heute abgehakte Runden, gelernte Fahrwege der Saugroboter.
- **Hausregeln** (`.storage/house_rules` und weitere Dateien `house_rules*`): Regeln, Räume, Hausmodus, Licht- und Heizpläne, Verlauf (höchstens 400 Einträge), Einstellungen der Alarmanlage. Die Alarm-PIN nur als gesalzener, langsamer Hash (PBKDF2-SHA256), Passkeys nur als öffentliche Schlüssel. Zugangsdaten für KI-Anbieter, SMTP und CallMeBot liegen im Klartext im Speicher von Home Assistant (wie bei Home Assistant üblich) und werden **nie** an den Browser zurückgegeben – die Oberfläche erfährt nur, ob etwas gesetzt ist.

### Was roomwise sendet

- **Karte und Begleit-Integration:** keine Verbindungen ins Internet. Auch die 3D-Modelle kommen vom eigenen Home Assistant.
- **Hausregeln**, nur wenn ein Administrator es einrichtet:
  - an den gewählten **KI-Anbieter** (Ollama, Gemini, OpenAI, Anthropic, Mistral oder OpenAI-kompatibel): Regeltexte, Regeln und Namen von Geräten, Räumen und Personen. Der Schlüssel geht nur an die gespeicherte Adresse.
  - bei Alarm an **CallMeBot** (Telegram/Signal, HTTPS) und an den eingetragenen **SMTP-Server** (STARTTLS als Standard; „unverschlüsselt“ ist wählbar und schickt das Passwort im Klartext).
  - an die **notify-Dienste** von Home Assistant (Handys, auch mit Kamerabild).
- Ohne Anmeldung abrufbar sind nur Programmcode und Töne: `/floorplan_card_loader.js`, `/floorplan_card_files/…` (Karte, 3D-Modelle), `/house_rules_static/…` (Oberfläche), `/house_rules_sounds/…` (Alarmtöne, die Lautsprecher abspielen). Keine Daten, kein Verzeichnis-Listing.

### Bedrohungsmodell (Kurzfassung)

- **Administratoren** sind vertrauenswürdig. Sie können ohnehin alles in Home Assistant.
- **Nicht-Admin-Nutzer** (typisch: das Wandtablet, Mitbewohner) haben in Hausregeln eine Rolle: standardmäßig **Bewohner**, von einem Admin auf **Gast** oder **Admin** umstellbar (Einstellungen → Rollen). Jeder Websocket-Befehl hat eine feste Mindestrolle, die der Server vor dem Befehl prüft; automatische Tests rufen alle als Bewohner und als Gast auf. Bewohner dürfen Regeln und Pläne anlegen und ändern (nicht solche, die die Alarmanlage schalten oder Schlösser öffnen bzw. den Alarm ausschalten dürfen), den Hausmodus setzen, Regeln starten, die Alarmanlage scharf schalten, die Sirene stummschalten und – mit der eingestellten Bestätigung (PIN oder Face ID / Touch ID) – ausschalten. Gäste sehen und bedienen nur (Regel starten, Fenster-Warnung bestätigen). Einstellungen bleiben Admins.
- **Eine Rolle in Hausregeln gibt nie mehr Rechte als Home Assistant.** Wer in Hausregeln Admin ist, aber kein Administrator in Home Assistant, darf Einstellungen, Räume, Geräte, Heizung und Licht ändern – aber nicht, was die Sicherheit betrifft oder Daten aus dem Haus schickt: Alarmanlage einrichten (auch der Alarm-Assistent), Face-ID-Geräte verwalten (ein eigenes Gerät nur mit der Alarm-PIN), Weitere Alarme anlegen, löschen und testen, KI-Verbindung (Adressen und Schlüssel) setzen und testen, Diagnosedaten an/aus/löschen/senden, Funktionen schalten, eine Sicherung zurückspielen, Rollen vergeben und alles, was Home Assistant selbst ändert (Automationen, Zonen). Das prüft der Server (Stufe „ha_admin“); die Tests rufen diese Befehle als zum Admin gemachter Nicht-Administrator auf.
- Nach 5 falschen PINs wird je Nutzer gesperrt, mit wachsender Dauer.
- **Handys in der Companion-App** können Ereignisse mit beliebigem Inhalt senden. Knöpfe in Alarm-Nachrichten zählen deshalb nur von Administratoren und von Personen, die die Alarm-Nachrichten bekommen. Der Gassi-Knopf kann nur abhaken.
- **Gerätenamen, Attribute und Konfiguration** gelten im Browser als nicht vertrauenswürdig: Die Oberflächen setzen Texte nur über Lit-Vorlagen ein (kein `innerHTML`), „URL öffnen“ nur mit http(s).
- **Übergroße Eingaben:** Längen und Anzahlen sind begrenzt, damit niemand den Speicher füllt.

### Bekannte Grenzen

- Ist die Alarmanlage so eingestellt, dass sie bei einem Hausmodus oder beim Heimkommen **automatisch unscharf** wird, ist sie nur so sicher wie Hausmodus und Anwesenheit – beides können Nicht-Admins bzw. ihre Handys beeinflussen. Mit PIN-Schutz nur das automatische Scharfschalten nutzen.
- Bewohner können Regeln ändern, abschalten oder pausieren und Entwürfe von der KI prüfen lassen (wer das nicht will, stellt Personen auf Gast) (bei bezahlten Anbietern kostet das – ein Ausgabenlimit beim Anbieter setzen).
- Alle angemeldeten Nutzer sehen in der Oberfläche von Hausregeln die Einstellungen ohne Geheimnisse – auch Empfänger der Alarm-Kanäle (Mail-Adressen, Telefonnummern, Telegram-Namen), den SMTP-Benutzernamen und Adresse und Modell der KI. Passwörter, Schlüssel und PIN-Hash nie.
- Die Datei `house_rules_pin_reset` im Konfigurationsordner hebt die PIN-Sperre ohne Anmeldung auf. Wer dort schreiben kann, hat aber ohnehin vollen Zugriff auf Home Assistant.

---

## English

### Supported versions

roomwise is still beta software. Security fixes are made for the **latest beta release** (`0.1.0-beta.x`) only. Please update to the latest release before reporting.

| Version | Supported |
| --- | --- |
| latest `0.1.0-beta.x` | yes |
| older releases | no |

### Reporting a vulnerability

Please do **not** open a public issue. Report privately through GitHub instead:
**[Security → Report a vulnerability](https://github.com/jonasstack/roomwise/security/advisories/new)** (GitHub Security Advisories).

Useful details: affected version, part (card, companion integration `floorplan_card`, house rules `house_rules`), steps to reproduce and what an attacker gains. You will get an answer once the report has been triaged; the fix ships in a new alpha release, after which the advisory is published. Please do not test against other people's Home Assistant installations.

### What roomwise stores

Everything stays inside your own Home Assistant:

- **Card:** the floor plan in the dashboard configuration (rooms, doors, windows, furniture, entity assignments).
- **Companion integration** (`.storage/floorplan_card`): front door warning settings, dog walk times and today's check-offs, learned robot vacuum paths.
- **House rules** (`.storage/house_rules` and other `house_rules*` files): rules, rooms, house mode, light and heating plans, history (at most 400 entries), alarm settings. The alarm PIN only as a salted, slow hash (PBKDF2-SHA256), passkeys only as public keys. Credentials for AI providers, SMTP and CallMeBot are kept in plain text in Home Assistant's storage (as usual for Home Assistant) and are **never** sent back to the browser – the UI only learns whether they are set.

### What roomwise sends

- **Card and companion:** no connections to the internet. Even the 3D models are served by your own Home Assistant.
- **House rules**, only when an administrator sets it up:
  - to the chosen **AI provider** (Ollama, Gemini, OpenAI, Anthropic, Mistral or OpenAI-compatible): rule texts, rules and names of devices, rooms and persons. The key is only ever sent to the stored address.
  - on alarm to **CallMeBot** (Telegram/Signal, HTTPS) and to your **SMTP server** (STARTTLS by default; "none" can be selected and sends the password in clear text).
  - to Home Assistant's **notify services** (phones, optionally with a camera snapshot).
- Without authentication only code and sounds are served: `/floorplan_card_loader.js`, `/floorplan_card_files/…` (card, 3D models), `/house_rules_static/…` (panel), `/house_rules_sounds/…` (alarm tones for speakers). No data, no directory listing.

### Threat model (summary)

- **Administrators** are trusted; they can do anything in Home Assistant anyway.
- **Non-admin users** (typically the wall tablet, other household members) have a role in Hausregeln: **Resident** by default, changeable by an admin to **Guest** or **Admin** (Settings → Roles). Every websocket command has a fixed minimum role that the server checks before the command; automated tests call each one as a resident and as a guest. Residents may create and change rules and plans (not rules that switch the alarm or may unlock locks / disarm), set the house mode, run rules, arm the alarm, silence the siren and – with the configured confirmation (PIN or Face ID / Touch ID) – disarm it. Guests only look and use (run a rule, acknowledge the window warning). Settings stay with admins.
- **A role in Hausregeln never grants more than Home Assistant does.** Someone who is Admin in Hausregeln but no Home Assistant administrator may change settings, rooms, devices, heating and light – but nothing that concerns security or sends data out of the house: setting up the alarm (including the alarm assistant), managing Face ID devices (their own device only with the alarm PIN), creating, deleting and testing other alarms, setting and testing the AI connection (addresses and keys), switching/deleting/sending diagnostics, switching features, restoring a backup, assigning roles and anything that changes Home Assistant itself (automations, zones). The server checks this (level "ha_admin"); the tests call these commands as a non-administrator promoted to Admin.
- After 5 wrong PINs a growing per-user lockout applies.
- **Phones in the companion app** can fire events with arbitrary content. Buttons in alarm notifications therefore only count from administrators and from persons who receive the alarm notifications. The dog walk button can only check off a walk.
- **Entity names, attributes and configuration** are treated as untrusted in the browser: the UIs insert text only through Lit templates (no `innerHTML`), "open URL" actions only allow http(s).
- **Oversized input:** lengths and counts are bounded so nobody can fill the storage.

### Known limitations

- If the alarm is set to **disarm automatically** on a house mode or when someone comes home, it is only as safe as the house mode and presence – both can be influenced by non-admins or their phones. With PIN protection, use automatic arming only.
- Residents can change, disable or pause rules and let the AI review drafts (set people to Guest if you do not want that) (with paid providers this costs money – set a spending limit at the provider).
- All logged-in users see the house rules settings without secrets in the panel – including recipients of the alarm channels (email addresses, phone numbers, Telegram names), the SMTP user name and the AI address and model. Never passwords, keys or the PIN hash.
- The file `house_rules_pin_reset` in the configuration folder lifts the PIN lockout without authentication. Anyone who can write there has full access to Home Assistant anyway.
