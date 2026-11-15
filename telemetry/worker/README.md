# roomwise-Diagnoseserver (Cloudflare Worker + D1)

Nimmt die **freiwilligen, anonymen Diagnosedaten** von roomwise an (Einstellungen → Diagnosedaten in Hausregeln,
standardmäßig aus) und zeigt den Entwicklern zusammengefasste Zahlen: welche Versionen, Geräteklassen,
Integrationen, Browser und Fehler es bei echten Nutzern gibt. Was gesendet wird und was nie: [PRIVACY.md](../../PRIVACY.md).

| Pfad | Wer | Was |
|---|---|---|
| `POST /v1/report` | roomwise | Wochenbericht (streng geprüft, höchstens 64 KB, unbekannte Felder abgelehnt), je Installation und Tag eine Zeile |
| `POST /v1/error` | roomwise | ein Fehler (Typ + eigene Code-Zeilen, höchstens 16 KB), nach Fingerabdruck zusammengezählt |
| `DELETE /v1/install/<id>` | roomwise | löscht alles zu einer Kennung („Meine Daten löschen“, Ausschalten) |
| `GET /v1/stats?days=30` | Entwickler (Token) | Zusammenfassung |
| `GET /v1/errors?days=30` | Entwickler (Token) | häufigste Fehler |
| `GET /v1/install/<id>` | Entwickler (Token) | Rohdaten einer Kennung zum Fehlersuchen |

Der Worker speichert **keine IP-Adressen und keine Header** und schreibt keine Logs. Je Kennung gilt eine
Ratenbegrenzung (5 Berichte, 30 Fehler, 10 Löschungen am Tag). Ein täglicher Cron löscht alte Daten
(Berichte nach 400 Tagen, Fehler nach 180 Tagen ohne neues Auftreten).

## Einrichten mit dem eigenen Cloudflare-Konto

Voraussetzung: Node.js 20 oder neuer und ein (kostenloses) Cloudflare-Konto. Alles in diesem Ordner:

```sh
cd telemetry/worker
npm install
npx wrangler login                                   # öffnet den Browser, einmalig
npx wrangler d1 create roomwise-telemetry            # gibt eine database_id aus
```

Die ausgegebene `database_id` in `wrangler.toml` statt `REPLACE_WITH_YOUR_D1_DATABASE_ID` eintragen (die
Datei mit der echten ID nicht einchecken, wenn das Repository öffentlich ist), dann:

```sh
npx wrangler d1 migrations apply roomwise-telemetry --remote   # Tabellen anlegen
openssl rand -hex 32                                           # Token erzeugen und sicher aufbewahren
npx wrangler secret put READ_TOKEN                             # Token einfügen (Lese-Schnittstelle)
npx wrangler deploy                                            # gibt die Adresse aus, z. B. https://roomwise-telemetry.<konto>.workers.dev
```

In den Einstellungen des Workers (Cloudflare-Dashboard → Workers → roomwise-telemetry → Einstellungen →
Beobachtbarkeit) bleiben „Workers Logs“ und „Logpush“ aus; `wrangler.toml` schaltet sie ebenfalls ab.

## roomwise auf den Server zeigen lassen

In `hausregeln/custom_components/house_rules/telemetry.py` die Konstante setzen und eine neue Version ausliefern:

```python
ENDPOINT = "https://roomwise-telemetry.<konto>.workers.dev"
```

Solange `ENDPOINT` leer ist, zeigt der Schalter „noch nicht verfügbar“, der Einrichtungsassistent fragt nicht
und es wird nichts gesendet.

## Zahlen ansehen

```sh
export ROOMWISE_TELEMETRY_URL=https://roomwise-telemetry.<konto>.workers.dev
export ROOMWISE_TELEMETRY_TOKEN=…        # nur in der Umgebung, nie in eine Datei im Repository
node tools/telemetry/report.mjs                 # Zusammenfassung der letzten 30 Tage
node tools/telemetry/report.mjs errors --days 7 # häufigste Fehler
node tools/telemetry/report.mjs install <id>    # Rohdaten einer Kennung (der Nutzer nennt sie aus seinen Einstellungen)
node tools/telemetry/report.mjs stats --json    # alles als JSON
```

## Lokal entwickeln und testen

```sh
npm test            # Miniflare (gleiche Laufzeit wie Cloudflare) mit D1 im Speicher, nichts geht ins Netz
npm run typecheck
npx wrangler dev    # lokaler Server auf http://localhost:8787 (vorher: npx wrangler d1 migrations apply roomwise-telemetry --local)
```

`node test/run.mjs ../../hausregeln/.cache/telemetry-sample.json` prüft zusätzlich die Berichte, die die echte
Integration in der Test-Home-Assistant gesendet hat (`hausregeln/tools/testha/test-telemetry.mjs` legt sie dort ab).

## Schema ändern

Das Schema steht in `src/schema.ts` und muss zu `telemetry.py` passen (`schema: 1`). Neue Felder erst im
Worker erlauben und ausrollen, dann in roomwise senden. Neue Tabellen oder Spalten als weitere Datei in
`migrations/` (`npx wrangler d1 migrations create roomwise-telemetry <name>`).
