# roomwise – Anleitung

[English](README.md)

Diese Anleitung führt von der Installation bis zum fertigen Wandtablet. Sie setzt voraus, dass du dich in den
Einstellungen von Home Assistant zurechtfindest, aber roomwise noch nicht kennst.

1. [Installation](#1-installation)
2. [Der erste Grundriss](#2-der-erste-grundriss)
3. [Geräte im Plan](#3-geräte-im-plan)
4. [Regeln](#4-regeln)
5. [Heizung](#5-heizung)
6. [Alarmanlage](#6-alarmanlage)
7. [Tipps fürs Wandtablet](#7-tipps-fürs-wandtablet)
8. [Updates](#8-updates)
9. [Sicherung](#9-sicherung)
10. [Wer was darf](#10-wer-was-darf)
11. [roomwise entfernen](#11-roomwise-entfernen)

## 1. Installation

roomwise besteht heute aus zwei Teilen: der Begleit-Integration *Grundriss-Karte*, die die Karte mitbringt, und der
optionalen Regel-Integration *Hausregeln*. Später werden beide eine Integration; deine Einstellungen werden dabei
übernommen.

**Karte und Begleit-Integration**

1. In HACS: ⋮ → **Benutzerdefinierte Repositories** → `https://github.com/jonasstack/roomwise`, Typ **Integration**.
2. *roomwise* öffnen → **Herunterladen**.
3. Home Assistant neu starten.
4. Einstellungen → Geräte & Dienste → **Integration hinzufügen** → *Grundriss-Karte*. Nichts auszufüllen.
5. Browser neu laden. Die Karte steht jetzt auf jedem Dashboard bereit.

**Hausregeln (optional)**

1. `house_rules.zip` aus dem neuesten Release auf GitHub laden und nach `<config>/custom_components/house_rules/`
   entpacken, sodass `manifest.json` direkt in diesem Ordner liegt.
2. Home Assistant neu starten, dann Einstellungen → Geräte & Dienste → **Integration hinzufügen** → *Hausregeln*.
3. **Hausregeln** in der Seitenleiste öffnen. Der Einrichtungsassistent fragt nach Bewohnern, Räumen und Meldern,
   Beispielregeln, Alarmanlage, Fenster-Warnung, Licht, Heizung, Urlaub, Saugroboter, KI und Wandtablet. Was du
   nicht brauchst, überspringst du; den Assistenten gibt es jederzeit wieder unter Einstellungen → Einrichtung.

Nach der Installation läuft nur der automatische Hausmodus. Alles andere bleibt aus, bis du es in Hausregeln unter
Einstellungen → **Funktionen** einschaltest.

## 2. Der erste Grundriss

1. Ein Dashboard für das Tablet anlegen (Einstellungen → Dashboards → **Dashboard hinzufügen**). Öffnen, bearbeiten
   und den Ansichtstyp **Panel** wählen, damit die Karte den Bildschirm füllt.
2. **Karte hinzufügen** → *Floorplan Card*. Nutzt dein Zuhause Bereiche, beginnst du mit einem Rechteck pro Bereich,
   sonst mit einem leeren Plan und einem Knopf zum Loszeichnen.
3. Auf den **Stift** in der Karte tippen. Der Editor arbeitet an einer Kopie; gespeichert wird erst mit
   **Speichern**.
4. **Räume zeichnen** mit dem Raum-Werkzeug: Ecken nacheinander antippen oder ein Rechteck aufziehen. Punkte rasten
   aneinander und an Hilfslinien ein. Einen Punkt ziehen verschiebt eine Wand, oder du wählst den Raum und tippst
   genaue Längen ein. 1 Einheit ist 1 cm.
5. **Jedem Raum einen Namen und seinen Bereich geben.** Dann bietet das Feld *Vorschläge aus Bereich übernehmen* an:
   Lichter, Thermometer, Feuchtesensor, Thermostat und Fensterkontakte des Bereichs werden auf einmal verknüpft.
6. **Türen und Fenster** kommen an Wände: Werkzeug wählen, an der Wand entlang ziehen. Mit ihrem Kontaktsensor
   gehen sie im Plan auf und zu.
7. **Außenbereiche** wie Terrasse, Garten oder Einfahrt sind Räume mit dem Haken „draußen“: keine Wände,
   Bodenhöhe.
8. **Weitere Etagen:** Der Etagen-Knopf oben fügt eine Etage hinzu. Treppen verbinden Etagen; antippen im Plan führt
   nach oben oder unten. Jede Etage lässt sich mit einer Etage von Home Assistant verknüpfen.
9. **Speichern** antippen. Der Plan landet in der Konfiguration der Karte im Dashboard.

Rückgängig und Wiederholen helfen jederzeit. Der Knopf `{}` zeigt das YAML, etwa für eine Sicherungskopie oder ein
YAML-Dashboard.

### Grundriss von einem Bild abzeichnen

Du hast einen Plan deiner Wohnung als Foto, Scan oder Bildschirmfoto? Öffne im Editor **Vorlage** (Bild-Symbol in der
Werkzeugleiste) und tippe auf **Bild laden**. Es liegt unter der aktuellen Etage und wird automatisch verkleinert
(PDF: die Seite vorher als Bild speichern). Dann:

1. **Maßstab festlegen:** zwei Punkte mit bekanntem Abstand antippen (z. B. eine Wand) und den Abstand in cm eingeben.
2. **Lage anpassen:** Mit *Bild verschieben* ziehst du es zurecht (oder schiebst es mit den Pfeiltasten); Breite,
   Drehung und Deckkraft stehen im selben Bereich.
3. **Räume nachzeichnen** mit dem Raum-Werkzeug.

Das Bild ist nur im Editor zu sehen, außer du schaltest *Auch auf der Karte zeigen* ein (2D-Ansicht). Mit der
Begleit-Integration wird es dort gespeichert, ohne sie landet eine stark verkleinerte Kopie in der Kartenkonfiguration.

### Derselbe Grundriss auf mehreren Dashboards

Mit der Begleit-Integration lässt sich ein Grundriss teilen: Editor → Einstellungen → **Auf mehreren Dashboards** →
*Auf mehreren Dashboards verwenden*. Nach **Sichern** liegt der Grundriss in der Begleit-Integration, die Karte verweist
nur noch darauf (`plan: <id>`). Auf einem anderen Dashboard die Karte hinzufügen und **Geteilten Grundriss verwenden**
wählen (oder im selben Einstellungs-Abschnitt auswählen). Änderungen von einem Dashboard aus erscheinen auf allen,
offene Karten ziehen sofort nach. Geteilt werden Etagen, Räume, Möbel, Geräte, Wände, Nordrichtung und die
Haustür-Warnung; Titel, Höhe, Ansicht und Personen-Einstellungen bleiben je Karte. *Nicht mehr teilen* gibt einer Karte
wieder eine eigene Kopie. Sichern zwei Personen gleichzeitig, wird die zweite vor dem Überschreiben gefragt.

## 3. Geräte im Plan

Ein Gerät lässt sich auf zwei Arten zeigen:

- **Als Objekt.** Die Objekt-Bibliothek (Sofa-Symbol) hat über 130 Möbel und Geräte. Verknüpfst du eine Lampe,
  einen Heizkörper, Ventilator, Fernseher, Lautsprecher oder Saugroboter mit seiner Entität, wird er lebendig:
  Lampen leuchten in ihrer Farbe, Heizkörper zeigen Wärme, Ventilatoren drehen sich. Antippen schaltet, langes
  Drücken öffnet das Bedienfeld.
- **Als Markierung.** Eine beliebige Entität aus der Liste in den Plan ziehen. Sie erscheint als Symbol oder als
  schlichter Wert (etwa die Außentemperatur).

Jedes Objekt, jede Markierung, jeder Raum, jede Tür und jedes Fenster hat eigene Aktionen für Antippen,
Doppeltippen und langes Drücken: schalten, Bedienfeld öffnen, den Dialog von Home Assistant öffnen, ein Skript
starten, eine Seite öffnen oder nichts tun. Schlösser, Alarmanlagen und Sirenen fragen immer vorher.

Einige Objekte haben mehr Einstellungen: Der **Saugroboter** kann live fahren (Roborock mit Begleit-Integration;
seine Karte im Editor mit *Automatisch ausrichten* an den Plan anpassen), ein **Auto** bekommt Entitäten für Akku,
Reichweite, Laden und Ort, ein **Hund** Gassi-Zeiten und Erinnerungen.

## 4. Regeln

Regeln stehen in Hausregeln unter **Regeln**. Eine Regel ist ein Satz:

> **Wenn** die Haustür aufgeht **und** niemand zuhause ist, **dann** schick allen eine Nachricht.

- **Wenn** reagiert auf ein Ereignis: eine Tür geht auf, jemand kommt heim, eine Uhrzeit, Sonnenuntergang.
- **Solange** hält einen Zustand: *Solange das Badfenster offen ist, ist die Heizung im Bad aus.* Endet die
  Bedingung, geht alles zurück.
- **und** fügt Bedingungen hinzu, **nur** Grenzen wie Uhrzeiten, Tage oder den Hausmodus.

Den Satz baust du durch Antippen seiner Teile, oder du tippst ihn ins Textfeld und roomwise macht einen Entwurf
daraus. Die eingebaute Satzerkennung versteht deutsche Sätze; für schwierigere kannst du unter Einstellungen →
KI-Anbindung einen KI-Anbieter verbinden. Die KI füllt nur einen Entwurf aus deinen echten Geräten; du prüfst ihn
immer vor dem Speichern.

Vor dem Speichern zeigt der **Probelauf**, welche Bedingungen gerade stimmen und was die Regel tun würde, ohne etwas
zu schalten. Danach steht im **Verlauf** jeder Lauf mit seinem Grund, auch übersprungene Läufe und warum.

Jeder Lauf einer Regel und was Alarmanlage, Fenster-Warnung, Licht- und Heizplan entscheiden, steht auch im
**Logbuch** von Home Assistant, mit einem lesbaren Satz und verknüpft mit dem Schalter der Regel oder dem Gerät.
Übersprungene Läufe und kleine Abgleiche bleiben im eigenen Verlauf von Hausregeln, damit das Logbuch nicht vollläuft.

**Rückgängig und frühere Versionen.** Bei jedem Speichern bleibt der alte Stand erhalten: Im Regel-Editor zeigt
**Verlauf** die letzten 20 Versionen mit wer was wann geändert hat, **Wiederherstellen** holt eine frühere zurück.
Eine gelöschte Regel landet im Papierkorb: Direkt nach dem Löschen tippst du unten in der Meldung auf
**Rückgängig**, später findest du sie 30 Tage lang unter Einstellungen → Papierkorb.

**Als Home-Assistant-Automation.** Im Regel-Editor zeigt **Als Home-Assistant-Automation exportieren** die Regel als
Automation in YAML, zum Kopieren oder Herunterladen. Platzhalter wie „irgendein Fenster“ werden zur Liste deiner
Fenster, so wie sie heute sind. Was eine Automation nicht ausdrücken kann (zum Beispiel „der Raum ist dunkel“,
„danach wieder wie vorher“, Geräte in Ruhe lassen, die gerade jemand von Hand geschaltet hat), steht über der YAML
und an der Stelle als Schritt „Nicht übertragbar: …“, der nichts tut. Admins von Home Assistant können die Automation
direkt anlegen; die Regel wird dann in Hausregeln ausgeschaltet, nicht gelöscht.

**Licht** und **Heizung** haben je Raum einen eigenen Plan statt loser Regeln, siehe nächster Abschnitt. Die Seite
**Räume** legt fest, welche Melder sagen, ob jemand im Raum ist; alles andere baut darauf auf.

## 5. Heizung

Unter Einstellungen → Funktionen *Heizung* einschalten, dann **Heizung** öffnen. Jeder Raum mit Thermostat bekommt
einen eigenen Plan:

- **Zeiten und Temperaturen:** Komfort- und Spar-Zeiten für Werktage und Wochenende, dazu was *Weg*, *Schlafen*
  und *Urlaub* für den Raum bedeuten.
- **Fenster:** Ist ein Fenster eine Weile offen (Standard 2 Minuten), geht der Raum aus oder auf Frostschutz und
  zurück, wenn das Fenster zu ist und sich die Luft beruhigt hat. Lüften lässt sich auch am Temperatursturz
  erkennen.
- **Von Hand verstellt** bleibt verstellt: wahlweise bis zur nächsten Zeit, ein paar Stunden, bis der Raum leer war
  oder bis du es zurückstellst.
- **Vorheizen:** roomwise lernt, wie schnell jeder Raum warm wird, oder du stellst ein festes Tempo ein, damit der
  Raum zu Beginn der Komfortzeit warm ist.
- **Lüft-Erinnerungen** nach Uhrzeit, Feuchte, CO₂ oder Schimmelgefahr, mit einer Lüftdauer passend zur
  Außentemperatur. Sie funktionieren auch, wenn roomwise die Heizung im Raum nicht regelt.

Jeder Raum zeigt eine Statuszeile, was er gerade tut und warum, und jede Änderung steht im Verlauf.

## 6. Alarmanlage

Unter Einstellungen → Funktionen *Alarmanlage* einschalten und **Alarmanlage** öffnen. Sie tut nichts, bis sie
eingerichtet und eingeschaltet ist.

1. **PIN setzen.** Erst dann lassen sich PIN oder Face ID / Touch ID (Passkeys) als Bestätigung zum Ausschalten
   wählen. Passkeys brauchen eine sichere Verbindung (HTTPS oder localhost).
2. **Arten:** Für *Weg*, *Nacht* und *Zuhause* festlegen, welche Melder zählen, die Ein- und Ausgangsverzögerung und
   die Reaktion: laut (Sirenen, Ton, Licht), still (nur Licht und Nachrichten) oder nur Nachrichten.
3. **Wer Nachrichten bekommt:** die Handys der Bewohner über die Companion-App, dazu wahlweise E-Mail (dein
   SMTP-Server), Telegram oder Signal (über CallMeBot). Den Ausschalt-Knopf in der Nachricht sichert das Handy mit
   seiner eigenen Sperre; unter *Ausschalten und Sicherheit* lässt er sich abschalten.
4. **Automatik:** scharf, wenn alle weg sind, aus, wenn jemand heimkommt, oder zu festen Zeiten.
5. **Test** prüft, ob die Nachrichten bei den gewählten Personen ankommen, bevor du dich darauf verlässt.

Verwandt ist die **Fenster-Warnung** (unter Funktionen): Geht die Haustür auf, während noch Fenster offen sind, warnt
das Haus, und die Karte zeigt die Warnung auf jedem Tablet, bis jemand sie antippt.

## 7. Tipps fürs Wandtablet

- **Eine eigene Person fürs Tablet**, ohne Administratorrechte: kein Stift, keine Einstellungen, und eigene Vorgaben
  (`users.<user id>` in der Karte) für Ansicht und Leistung.
- **Eine Kiosk-App** wie Fully Kiosk Browser: Vollbild, ohne Kopfzeile und Seitenleiste von Home Assistant,
  Bildschirm dimmen, Neustart nach einem Absturz. Ohne Kopfzeile die Höhe der Karte auf `100vh` setzen, sonst
  `calc(100vh - var(--header-height, 56px))`.
- **Effekte & Leistung** im Editor: *Sparsam* für ältere oder günstige Tablets, *Aus*, wenn es so ruhig wie möglich
  sein soll. 2D ist die leichteste Ansicht.
- **Zurück zum Anfang:** `idle_reset` (Sekunden) dreht die Ansicht auf Ausrichtung und Etage zurück, wenn eine Weile
  niemand das Tablet berührt hat.
- **Last prüfen:** den Kompass zwei Sekunden halten zeigt Bilder pro Sekunde und Bildzeit.
- Das Tablet am Ladegerät mit Ladegrenze betreiben, wenn das Tablet eine anbietet.

### Tastatur und Bildschirmleser

Der Plan geht auch ohne Maus: **Tab** springt in den Plan, die **Pfeiltasten** wechseln nach Lage auf dem Bildschirm
zwischen Räumen und Geräten, **Eingabe** oder **Leertaste** tippt, **Umschalt+Eingabe** oder die Kontextmenü-Taste wirkt
wie langes Drücken. Bildschirmleser sagen jedes Element mit Zustand an („Wohnzimmer, Licht an, 21 °C“). Popups sind
Dialoge: Der Fokus bleibt darin, **Escape** schließt sie und der Fokus kehrt zurück. Im Editor sind alle Knöpfe mit Tab
erreichbar; **Eingabe** wählt ein Element im Plan aus, die Pfeiltasten verschieben es (Umschalt: 10 cm), **Entfernen**
löscht es, und beim Raum zeichnen bewegen die Pfeiltasten ein Kreuz auf dem Raster und **Eingabe** setzt eine Ecke. Ist
im System *Bewegung reduzieren* eingeschaltet, springen Ansichten statt zu gleiten.

## 8. Updates

HACS zeigt neue Versionen von Karte und Begleit-Integration. Nach **Aktualisieren**:

- Nennen die Release-Hinweise Python-Änderungen, Home Assistant neu starten. Hat sich nur die Karte geändert,
  genügt es, den Browser neu zu laden (auf Tablets die Kiosk-App; bleibt die alte Version hängen, ihren Cache
  leeren).
- Hausregeln: das neue `house_rules.zip` laden, den Ordner `custom_components/house_rules/` ersetzen und neu starten.

Was sich geändert hat, steht im [Changelog](../../CHANGELOG.md). In der Beta können sich Einstellungsformate noch
ändern; roomwise rechnet alte Einstellungen selbst um, aber lies vor dem Update die Hinweise.

## 9. Sicherung

Alles, was roomwise speichert, gehört zu einer normalen Sicherung von Home Assistant (Einstellungen → System →
Sicherungen):

- der Grundriss steht in der Konfiguration des Dashboards,
- Begleit-Integration und Hausregeln legen ihre Daten im Ordner `.storage/` von Home Assistant ab.

Für eine zusätzliche Kopie des Plans den Editor öffnen, `{}` antippen und das YAML irgendwo ablegen. Zum
Zurückholen in den Code-Editor der Karte einfügen (Karte bearbeiten → *Code-Editor anzeigen*). Eine vollständige
Sicherung von Home Assistant bringt Regeln, Pläne und Alarm-Einstellungen zusammen mit allem anderen zurück.

## 10. Wer was darf

Hausregeln gibt jedem Benutzer von Home Assistant eine Rolle (Einstellungen → Rollen):

- **Admin** darf alles: Regeln, Pläne, die Alarmanlage einrichten, Einstellungen und Funktionen. Admins von Home
  Assistant sind hier immer Admin.
- **Bewohner** (Standard für alle anderen) legt Regeln und Pläne an und ändert sie, wechselt den Hausmodus und
  bedient die Alarmanlage mit ihrer Bestätigung (PIN oder Face ID, wie eingestellt). Sicherheit, Einstellungen und
  Funktionen bleiben den Admins, ebenso Regeln, die die Alarmanlage schalten oder Schlösser öffnen dürfen.
- **Gast** sieht alles und darf bedienen, zum Beispiel eine Regel jetzt ausführen oder die Fenster-Warnung
  bestätigen, ändert aber nichts. Passt gut für ein gemeinsames Benutzerkonto am Wandtablet.

Hausregeln prüft die Rollen bei jeder Aktion selbst, nicht nur in der Oberfläche. Die Entitäten von Hausregeln
(ein Schalter je Regel, die Alarmzentrale) folgen den Rechten von Home Assistant.

## 11. roomwise entfernen

Ausschalten oder Neuladen einer Integration behält alles. Erst **Löschen** (Einstellungen → Geräte & Dienste →
die Integration → ⋮ → Löschen) räumt sauber auf:

- **Hausregeln** löscht Regeln, Pläne, Verlauf, Versionen, Papierkorb, Gelerntes und die Einstellung der
  Diagnosedaten, seine Hinweise unter Reparaturen und seine Nachrichten auf den Handys; Home Assistant entfernt die
  Entitäten und den Eintrag in der Seitenleiste. Sichere vorher (Hausregeln → Einstellungen → Sichern und wiederherstellen), wenn du
  deine Regeln behalten willst.
- **Die Begleit-Integration** löscht ihre gespeicherten Einstellungen und Hinweise, lädt die Karte nicht mehr auf
  den Dashboards und entfernt Dashboard-Ressourcen, die auf ihre Dateien zeigen. Karten auf den Dashboards bleiben
  stehen und zeigen einen Fehler, bis du sie entfernst oder roomwise wieder installierst.

Keiner der Teile legt Helfer, Automationen (außer du exportierst selbst eine) oder Benachrichtigungs-Kategorien an,
also bleibt nichts weiter zurück. Zum Schluss die heruntergeladenen Dateien in HACS entfernen (oder die Ordner unter
`custom_components`) und neu starten.
