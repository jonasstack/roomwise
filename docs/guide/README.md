# roomwise user guide

[Deutsch](README.de.md)

This guide walks you from installation to a finished wall tablet. It assumes you know your way around Home
Assistant's settings, but not roomwise. The interface is German first; menu names are given in English here,
with the German label in brackets where the Hausregeln panel only exists in German.

1. [Installation](#1-installation)
2. [Your first floor plan](#2-your-first-floor-plan)
3. [Devices on the plan](#3-devices-on-the-plan)
4. [Rules](#4-rules)
5. [Heating](#5-heating)
6. [Alarm system](#6-alarm-system)
7. [Wall tablet tips](#7-wall-tablet-tips)
8. [Updates](#8-updates)
9. [Backup](#9-backup)
10. [Who may do what](#10-who-may-do-what)
11. [Removing roomwise](#11-removing-roomwise)

## 1. Installation

roomwise has two parts today: the companion integration *Grundriss-Karte*, which brings the card, and the optional
rules integration *Hausregeln*. Both will become one integration later; your settings will be carried over.

**Card and companion integration**

1. In HACS: ⋮ → **Custom repositories** → `https://github.com/jonasstack/roomwise`, type **Integration**.
2. Open *roomwise* → **Download**.
3. Restart Home Assistant.
4. Settings → Devices & services → **Add integration** → *Grundriss-Karte*. Nothing to fill in.
5. Reload the browser. The card is now available on every dashboard.

**Hausregeln (optional)**

1. Download `house_rules.zip` from the latest release on GitHub and unpack it into
   `<config>/custom_components/house_rules/`, so that `manifest.json` lies directly in that folder.
2. Restart Home Assistant, then Settings → Devices & services → **Add integration** → *Hausregeln*.
3. Open **Hausregeln** in the sidebar. The setup assistant (*Einrichtung*) asks about residents, rooms and sensors,
   example rules, alarm, window warning, light, heating, vacation, robot vacuum, AI and the wall tablet. Skip
   whatever you don't need; you can run it again under Settings → Setup.

Only the automatic house mode runs after installation. Everything else stays off until you turn it on in
Hausregeln under Settings → Features (*Funktionen*).

## 2. Your first floor plan

1. Create a dashboard for the tablet (Settings → Dashboards → **Add dashboard**). Open it, edit it, and set the view
   type to **Panel** so the card fills the screen.
2. **Add card** → *Floorplan Card*. If your home uses areas, you start with one rectangle per area. Otherwise you
   get an empty plan with a button to start drawing.
3. Tap the **pencil** in the card. The editor works on a copy, nothing is saved until you tap **Save**.
4. **Draw rooms** with the room tool: tap the corners one by one, or drag a rectangle. Points snap to each other and
   to guides. Drag a point to move a wall, or select a room and type exact lengths in the panel. 1 unit is 1 cm.
5. **Name each room and pick its area.** The panel then offers *Use suggestions from area*: lights, thermometer,
   humidity sensor, thermostat and window contacts of that area are linked in one go.
6. **Doors and windows** go on walls: choose the tool, drag along a wall. Give them their contact sensor, and they
   open and close on the plan.
7. **Outdoor areas** such as a terrace, garden or driveway are rooms marked as outdoor: no walls, ground level.
8. **More floors:** the floor button at the top adds a floor. Stairs link floors; tapping them on the plan takes you
   up or down. Each floor can be linked to a Home Assistant floor.
9. Tap **Save**. The plan is written into the dashboard's card configuration.

Use **Undo** and **Redo** freely. The `{}` button shows the YAML, for example to keep a copy or to paste it into a
YAML dashboard.

### Trace a floor plan from a picture

Have a plan of your home as a photo, scan or screenshot? In the editor, open **Trace image** (picture icon in the tool
bar) and **Load picture**. It lies under the current floor, made smaller automatically (PDF: save the page as a
picture first). Then:

1. **Set the scale:** tap two points whose distance you know (a wall, say) and enter the distance in cm.
2. **Place it:** *Move picture* lets you drag it (or nudge it with the arrow keys); width, rotation and opacity are in
   the same panel.
3. **Draw the rooms** on top with the room tool.

The picture shows only in the editor unless you switch on *Also show on the card* (2D view). With the companion
integration it is stored there; without it, a much smaller copy goes into the card configuration.

### The same plan on several dashboards

With the companion integration a plan can be shared: editor → Settings → **On several dashboards** → *Use on several
dashboards*. After **Save**, the plan is stored by the companion and the card only refers to it (`plan: <id>`). On
another dashboard, add the card and choose **Use a shared floor plan** (or pick it in the same settings section).
Editing from any dashboard updates all of them, and open cards follow at once. Floors, rooms, furniture, devices,
walls, north and the front door warning are shared; title, height, view and per-person settings stay per card.
*Stop sharing* gives a card its own copy again. If two people save the same plan at the same time, the second one is
asked before overwriting.

## 3. Devices on the plan

There are two ways to show a device:

- **As an object.** The object library (sofa icon) has more than 130 pieces of furniture and appliances. Link a
  lamp, radiator, fan, TV, speaker or robot vacuum to its entity and it comes alive: lamps shine in their colour,
  radiators show heat, fans spin. Tap switches, a long press opens the popup.
- **As a marker.** Drag any entity from the entity list onto the plan. It appears as an icon, or as a plain value
  (for example the outdoor temperature).

Every object, marker, room, door and window has its own actions for tap, double tap and long press: switch, open
the popup, open Home Assistant's more-info dialog, run a script, navigate, or do nothing. Locks, alarm panels and
sirens always ask before they switch.

A few objects have extra settings: the **robot vacuum** can show its live position (Roborock with the companion
integration; align its map in the editor with *Align automatically*), a **car** takes battery, range, charging
and location entities, a **dog** gets walk times and reminders.

## 4. Rules

Rules live in the Hausregeln panel under **Rules** (*Regeln*). A rule is a sentence:

> **When** the front door opens **and** nobody is home, **then** send a message to everyone.

- **When** (*Wenn*) reacts to an event: a door opens, someone comes home, a time, sunset.
- **While** (*Solange*) holds a state: *While the bathroom window is open, the bathroom heating is off.* When the
  condition ends, things go back.
- **And** (*und*) adds conditions, **only** (*nur*) adds limits such as times, days or the house mode.

Build the sentence by tapping its parts, or type it in the text field and let roomwise turn it into a draft. The
built-in parser understands German sentences; for harder sentences you can connect an AI provider under Settings
→ AI (*KI-Anbindung*). The AI only fills in a draft from your real devices; you always check it before saving.

Before saving, **Test run** (*Probelauf*) shows which conditions are true right now and what the rule would do,
without switching anything. Afterwards, **History** (*Verlauf*) lists every run with its reason, including runs
that were skipped and why.

Every run of a rule, and what the alarm, the window warning and the light and heating plans decide, also appears in
Home Assistant's **logbook** with a readable sentence, linked to the rule's switch or the device. Skipped runs and
small adjustments stay in Hausregeln's own history, so the logbook doesn't fill up.

**Undo and earlier versions.** Every time you save a rule, the old state is kept: in the rule editor, **History**
(*Verlauf*) lists the last 20 versions with who changed what and when, and **Restore** (*Wiederherstellen*) brings an
earlier one back. A deleted rule goes to the trash: right after deleting, tap **Undo** (*Rückgängig*) in the
message at the bottom; later, Settings → Trash (*Papierkorb*) keeps it for 30 days.

**As a Home Assistant automation.** In the rule editor, **Export as Home Assistant automation** (*Als
Home-Assistant-Automation exportieren*) shows the rule as automation YAML to copy or download. Placeholders such as
"any window" become the list of your windows as they are today. What an automation cannot express (for example "the
room is dark", "afterwards back as before", leaving devices alone that someone just switched by hand) is listed
above the YAML and marked in place as a step "Nicht übertragbar: …" that does nothing. Home Assistant admins can
create the automation directly; the rule is then switched off in Hausregeln, not deleted.

**Light** and **heating** have their own planners per room instead of loose rules, see the next section. The
**rooms** page decides which sensors tell whether someone is in a room; everything else builds on that.

## 5. Heating

Turn on *Heating* under Settings → Features, then open **Heating** (*Heizung*). Each room with a thermostat gets
its own plan:

- **Times and temperatures:** comfort and eco blocks for weekdays and weekends, plus what *away*, *sleeping* and
  *vacation* mean for the room.
- **Windows:** when a window has been open for a while (default 2 minutes) the room goes off or to frost
  protection, and back after the window is closed and the air has settled. Airing can also be recognised from a
  sudden temperature drop.
- **Manual changes** are respected: choose whether they last until the next time block, a few hours, until the room
  was empty, or until you change them back.
- **Pre-heating:** roomwise learns how fast each room warms up, or you set a fixed rate, so the room is warm at the
  start of a comfort block.
- **Airing reminders** by time, humidity, CO₂ or mould risk, with the recommended airing time depending on the
  outdoor temperature. They work even if roomwise doesn't control the heating in that room.

Every room shows a status line explaining what it is doing and why, and every change lands in the history.

## 6. Alarm system

Turn on *Alarm system* under Settings → Features and open **Alarm** (*Alarmanlage*). The alarm does nothing until it
is set up and switched on.

1. **Set a PIN.** Only then can you choose PIN or Face ID / Touch ID (passkeys) as the confirmation for disarming.
   Passkeys need a secure connection (HTTPS or localhost).
2. **Modes:** for *away*, *night* and *home*, choose which sensors count, the entry and exit delays and the
   reaction: loud (sirens, sound, light), silent (lights and messages only) or messages only.
3. **Who gets messages:** residents' phones via the companion app, plus optional e-mail (your SMTP server),
   Telegram or Signal (via CallMeBot). The disarm button in a message is protected by the phone's own lock and can
   be switched off under *Disarming and security*.
4. **Automation:** arm when everyone has left, disarm when someone comes home, or arm at fixed times.
5. **Test** checks that the messages reach the chosen people before you rely on them.

The **window warning** (*Fenster-Warnung*, under Features) is related: when the front door opens while windows are
still open, the house warns you, and the card shows the warning on every tablet until someone taps it.

## 7. Wall tablet tips

- **A separate user for the tablet**, without admin rights: no pencil, no settings, and per-user defaults
  (`users.<user id>` in the card) for view and performance.
- **A kiosk app** such as Fully Kiosk Browser: full screen, no Home Assistant header and sidebar, screen dimming,
  restart after a crash. With the header hidden, set the card height to `100vh`; otherwise
  `calc(100vh - var(--header-height, 56px))`.
- **Effects & performance** (*Effekte & Leistung*) in the editor: *Saver* for older or cheap tablets, *Off* if it
  should be as calm as possible. 2D is the lightest view.
- **Back to the start:** `idle_reset` (seconds) turns the view back to its default rotation and floor after nobody
  has touched the tablet for a while.
- **Check the load:** hold the compass for two seconds to see frames per second and frame time.
- Keep the tablet on a charger with a battery limit if the tablet offers one.

### Keyboard and screen readers

The plan works without a mouse: **Tab** moves into the plan, the **arrow keys** go from room to room and device to
device by where they are on screen, **Enter** or **Space** taps, **Shift+Enter** or the context menu key acts like a
long press. Screen readers announce each item with its state ("Living room, light on, 21 °C"). Popups are dialogs:
the focus stays inside, **Escape** closes them and the focus returns. In the editor all buttons are reachable with Tab;
**Enter** selects an item on the plan, the arrow keys move it (Shift: 10 cm), **Delete** removes it, and while drawing
a room the arrow keys move a cross on the grid and **Enter** sets a corner. With *reduce motion* switched on in the
system, views jump instead of gliding.

## 8. Updates

HACS shows new versions of the card and companion integration. After **Update**:

- If the release notes mention Python changes, restart Home Assistant. A change to the card alone only needs a
  browser reload (on tablets: reload the kiosk app; clear its cache if the old version sticks).
- Hausregeln: download the new `house_rules.zip`, replace the folder `custom_components/house_rules/` and restart.

The [changelog](../../CHANGELOG.md) lists what changed. During the beta, settings formats can still change;
roomwise converts old settings itself, but read the notes before you update.

## 9. Backup

Everything roomwise stores is part of a normal Home Assistant backup (Settings → System → Backups):

- the floor plan lives in the dashboard configuration,
- the companion integration and Hausregeln keep their data in Home Assistant's `.storage/` folder.

For an extra copy of the plan, open the editor, tap `{}` and save the YAML somewhere. To restore it, paste it into
the card's code editor (edit card → *Show code editor*). Restoring a full Home Assistant backup brings back rules,
plans and alarm settings together with everything else.

## 10. Who may do what

Hausregeln gives every Home Assistant user a role (Settings → Roles, *Rollen*):

- **Admin** may do everything: rules, plans, setting up the alarm, settings and features. Home Assistant admins are
  always admins here.
- **Resident** (*Bewohner*, the default for everyone else) creates and changes rules and plans, switches the house
  mode and uses the alarm with its confirmation (PIN or Face ID, as set up). Security, settings and features stay
  with the admins, and so do rules that switch the alarm or may unlock doors.
- **Guest** (*Gast*) sees everything and may use it, for example run a rule now or acknowledge the window warning,
  but changes nothing. A good choice for a shared wall tablet account.

The roles are checked by Hausregeln itself for every action, not only hidden in the interface. The entities
Hausregeln creates (a switch per rule, the alarm panel) follow Home Assistant's own permissions.

## 11. Removing roomwise

Disabling or reloading an integration keeps everything. Only **deleting** it (Settings → Devices & services →
the integration → ⋮ → Delete) removes it cleanly:

- **Hausregeln** deletes its rules, plans, history, rule versions, trash, learned data and diagnostics settings,
  its hints under Repairs and its messages on your phones; Home Assistant removes its entities and the sidebar
  entry. Make a backup first (Hausregeln → Settings → Back up and restore, *Sichern und wiederherstellen*) if you want to keep your rules.
- **The companion integration** deletes its stored settings and hints, stops loading the card on your dashboards and
  removes dashboard resources that point to its files. Cards on your dashboards stay in place and show an error until
  you remove them or install roomwise again.

Neither part creates helpers, automations (unless you export one yourself) or notification categories, so nothing
else is left behind. Finally, remove the downloaded files in HACS (or the `custom_components` folders) and restart.
