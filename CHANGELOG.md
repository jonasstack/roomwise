# Changelog

All notable changes to roomwise are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with `-alpha.N` / `-beta.N` pre-releases until the first stable release.

## [Unreleased]

## [0.1.0-beta.11] - 2026-11-15

### Added

- Editor: **"Raum teilen"** – a line right through a room cuts it into two rooms, open without a wall (an open
  kitchen: a passage on the cut) or with a wall; L-shapes and slanted walls too. The larger part keeps the room's
  area, lights and thermostat, furniture stays where it is. **"Mit … zusammenlegen"** joins two neighbouring rooms.
- Editor: **"Wand ziehen"** – walls standing on their own without a room (partition, counter, room divider): a
  polyline of straight pieces, thickness, full or half height and colour in the inspector. 2D and 3D like any wall,
  the dog walks around them, doors and windows can go on them; plan files keep them (`floor.walls`).

### Fixed

- Plan files: garage doors and passages ("Wand weg") were refused when loading a plan file.

### Changed

- Card with several floors: **scrolling moves the floor focus** – one wheel notch is one floor (wheel up = the floor
  above, a fast spin is one step), Ctrl/⌘ + wheel or pinching zooms; on a tablet two fingers swiping up/down change
  the floor. One floor, the editor, or "Scrolling changes the floor" off (`scroll_floors: false`): the wheel zooms.
- House rules "Wo ist wer": looking up place names at OpenStreetMap is **on by default** (only for phones without a
  place name of their own; an admin can switch it off, a choice made by hand is kept). PRIVACY.md updated.

### Fixed

- House rules "Wo ist wer": the arrival time is no longer the straight line at the speed of the moment – the way by
  road (straight line × detour per way of travel) at a typical speed (a car in town is slow; a fast stretch raises it by
  a quarter at most), plus the end of the trip (parking; stops and the walk for bus and train); a trip the person
  has made before counts first. The card shows the way left "by road, estimated" and rounds a rough arrival to
  5 minutes.
- House rules "Raum einstellen": buttons and boxes did not redraw after a click since 0.1.0-beta.9 (saved, but the
  window kept the old value until it was opened again).
- Light plan: dimming down with an inherited fade no longer sends again in the middle of the fade (lamps flickered).
- House rules light plan: lamps no longer flicker when Hausregeln changes the brightness – a lamp that reacted but
  reports the setting a little differently (rounded brightness, another colour mode, still fading) is not sent the
  same call again (only a lost call is repeated), no two calls to a lamp within 1.5 s, see-sawing wishes wait 8 s,
  and a brightness change of a lamp already in the right colour leaves the colour out.
- House rules light plan: a while rule's "afterwards" (off / as before) is done once the lamp got there or while it
  is set by hand – it no longer stays a lasting target that could switch a lamp off again later.

### Added

- Card editor: **passages – walls that are not there** ("Durchgang (Wand weg)"): the tool opens the wall a tap hits
  between two rooms over its whole length, a room's settings remove the wall to a neighbouring room and put it
  back; no wall, frame or lintel in 2D or 3D, only a faint line on the floor; the dog walks through. From the robot
  vacuum's map, a wide open contact between two rooms (1.5 m or more) becomes a passage.

### Added

- Card: **the floors lie stacked** – the shown floor in full, the one above and the one below faint and apart (3D:
  floors and low walls in the scene; 2D: offset outlines). Changing the floor only moves the focus: the stack glides
  until the new floor sits where the old one was, nothing sinks away or fades.
- Card: **news from other floors** – a washer done in the basement, water, a window open, the dog wanting out … on
  another floor: that floor in the stack a little clearer with a label at the spot ("Waschmaschine fertig · Keller");
  further away or out of sight, a small view of that floor at the bottom. A tap goes there and opens the thing.
  Editor: Darstellung → "Meldungen anderer Etagen einblenden" (on by default).

### Changed

- Card: outdoor things (garden, driveway, car, wallbox, mower …) show on every floor, not only on the floor they are on.

### Added

- Robot map preview and "Etage drehen": mirror **left ↔ right** and **top ↔ bottom**, both as seen on the screen
  (before, the one mirror flipped the map's own axis – after a quarter turn it looked upside down).
- Card 3D: a TV (or cabinet, wall light) on the wall shows whole as soon as the walls stand high enough to hold it
  – before it was cut off at the wall's top edge.
- Card: **cork** as a floor (fine warm grain, faint tile seams; natural, light, dark, grey, white).

### Changed

- Card: the floor picker rests as a slim strip on the right edge (a dot per floor) and opens over the plan only
  while it is touched, dragged, hovered or used with the keyboard – the plan gets the space and is shown larger.
- Card editor: "Beim Öffnen zeigen" (the floor the card opens on) is right under "Darstellung" and per floor as a
  switch; a person's own start floor now also wins on opening, not only after the idle time.

## [0.1.0-beta.10] - 2026-11-15

### Added

- House rules alarm: **"Live testen"** under "Ton und Sirene" – the alarm sound at the set volume on the chosen
  speakers and sirens for 3, 5 or 10 seconds, to set the volume by ear; asks before the first test, a big "Stopp",
  the volume follows a running test, the backend stops it after at most 10 s and gives the speakers their volume back.
  Never an alarm: no message, no announcement, no extra devices.

## [0.1.0-beta.9] - 2026-11-15

### Changed

- House rules light rules: the end of a rule ("Aus", its own cool-down, "erst dimmen") is shown and tested to touch only
  the lamps the rule picked – other lamps of the room, switched on by hand or by other rules, stay as they are; the
  wizard says so under "Aus" (new test `test-rule-end.mjs`).

### Added

- House rules "Raum einstellen": the room's **light sensor** can be any light sensor of the house, also one of
  another room (e.g. the living room's for the hallway), or none.
- Card first steps, from the robot vacuum's map: **"Welche Etage ist welche?"** – one choice per map (Home
  Assistant's floors, else basement, ground floor, upper floors, attic, an own name, or "leave out"); the
  suggestion is marked as one, an unsure one says "Bitte wählen" with the reason, and "Apply" waits until every map
  has a floor; picking a floor another map has makes the two swap.
- **"Richtig herum drehen"** in the same preview: quarter turns, mirror and a fine correction (±15°), the same for
  all floors by default; rooms, doors, the vacuum and its dock turn together, the vacuum's live alignment with them.
- Editor, floor settings: **"Etage drehen"** – a quarter turn or a mirror for everything on the floor (rooms,
  doors, devices, furniture, tracing image, the vacuum's alignment), undoable.
- House rules "Raum einstellen": **"Sensor suchen …"** – any sensor of Home Assistant can be a room's presence or
  motion sensor, also one without a fitting device class (radar / mmWave, ESPHome, templates, a people counter).
  A binary_sensor without a fitting class is now also recognised by its name (radar, Anwesenheit, Bewegung …),
  never a battery, link or status sensor.
- "Sensor aus anderem Raum" also offers the zones of multi-zone presence sensors (FP2 & co.) – they were missing.

### Changed

- House rules: every time setting goes down to 0 (= at once) – room empty after, door pulse, conditions "for", alarm
  windows, heating airing / manual / ramp / valve exercise, window warning confirmation; 0 no longer falls back to the preset.
- Which floor a robot map is: weighed by the area of its rooms that match a Home Assistant floor's areas (not the
  first hit), the map's name ("EG", "OG", "DG", "Keller", "oben", "unten", also as one word in it) as a second hint;
  rooms split over floors, a name pointing elsewhere or two maps on one floor leave it open instead of guessing.

## [0.1.0-beta.8] - 2026-11-15

### Added

- Light switches count as lamps: a `switch.*` or `input_boolean.*` named after a light (relay or smart switch behind a
  lamp, "Licht", "Lampe", "LED", "Lichterkette" …; not a mode or timer, a socket only when its name says lamp) is a
  lamp that only goes on and off – in Hausregeln (light plan, rules, vacation light, Reinschau, live preview, by-hand
  detection; switched by its own domain) and on the card (room lights, double tap). Detection can be changed or left
  out like any other.
- House rules: **"Licht hinzufügen"** – in a light rule and on a room without a lamp: search every lamp and light
  switch of the house, assign it to the room for good or use it only in this rule.

### Added

- Editor settings: **"Grundriss zurücksetzen"** – start over with one empty floor (the card's settings stay), asks
  first, undo brings the plan back until it is saved; then the card starts with its first steps again.
- House rules light rules: **"Lichter aus anderen Räumen"** – a rule can switch lamps of other rooms too (grouped by
  room; chosen ones stay visible with their room's name).

### Changed

- House rules light rules: the fade a rule switches a lamp on with is also used when the lamp goes off or dims
  down later (rule over, room empty); a fade of its own still wins.
- Rooms by default: a **tap focuses** the room (zooms in), a **double tap switches its lights**, holding opens its
  panel (before: a tap switched the lights). A room's own tap action still wins.
- Focused room in 3D: walls of other rooms between the camera and it are left out entirely, its own walls towards
  the camera sink to a line.

### Fixed

- Card on a wall tablet: after a reload in remembered full screen a bar of Home Assistant's sidebar stayed on the
  left until the first tap – the kiosk mode now hides it again while the page settles and refits the plan.
- House rules "Wo ist wer": standing somewhere is no longer taken for "on the way home". A single position a few
  hundred metres off (phones indoors, e.g. a sports hall) no longer ends a stay – leaving needs a fix 800 m away, a
  reported speed, a next fix clearly farther out or a third one outside; "home" needs a real approach (500 m nearer and
  nearer with each of the last two fixes), the habit alone never says it; the arrival time only while the last fix came
  nearer and is at most 10 minutes old – no more "gleich da" for somebody whose phone went quiet (card too).

## [0.1.0-beta.7] - 2026-11-15

### Added

- Card first steps: **flat or house?** with the number of floors – suggested from Home Assistant (several floors,
  areas like a garden, garage or stairs, a robot vacuum with several maps), always changeable; "draw it yourself"
  starts a house with its floors.
- From the robot vacuum's map, **a house**: one floor per map (Roborock keeps one per floor) or per vacuum ("all
  robot vacuums"), each put on the Home Assistant floor its rooms' areas belong to and named after it; the preview
  has a tab per floor; a map the robot keeps but Home Assistant has not loaded is named with a hint, and the robot
  switches to it only after a second tap and only while docked. Companion: `floorplan_card/vacuums/maps`.
- Editor: floors are always in the toolbar – the floor tabs, "+ Etage" and "Etagen einstellen", which opens the
  floor settings (rename, order, level, height, link to a Home Assistant floor, delete); "take the floors from
  Home Assistant" adds and links the missing ones.
- **Stairs**: the first library category "Bauteile" (and the search "Treppe"); the editor tool "Treppe setzen"
  (straight, L-shaped or spiral, one tap into the hallway); after laying out a house "Wo ist die Treppe?" (never
  guessed); a stair light and more devices (LED steps, motion sensors) – a tap switches the light, a hold lists them,
  the treads glow softly while a light is on or someone moves; on the floor above a faint stairwell at the same spot
  (2D and the 3D floor) with a chip back down; the dog now and then goes up the stairs in 3D and comes back.
- Card: washer, dryer and dishwasher show how long they still need (“noch 42 Min.”, counted down between two updates,
  a thin progress line) and a soft green “fertig” with a ring once done – until the door opens, someone taps
  “Gesehen” (shared through the companion) or 2 hours pass. Values come from the linked device (Home Connect, Miele,
  SmartThings, LG …: state, end time, time left, progress, program, door, power, on/off, further values), each
  linkable by hand in the editor and detection can be left out; without a maker integration a smart plug with
  power metering does (thresholds adjustable). A tap opens the appliance's popup with every value, never switches it.
- Card 3D: washer and dryer as front loaders (chrome porthole, dark glass, a drum that turns while running, control
  panel with display and knob), the dishwasher with door, control strip and handle; the display lights while running.

### Changed

- Stairs stay in the background: drawn under every other piece in a quieter colour; without a device they are no
  tap target any more (the tap goes to the room) – the chip above them leads to the other floor.
- Card editor: pulling rooms into shape lines up with what is already drawn – other rooms' corners and walls, the
  line of another corner (same x or y), the extension of a slanted wall – with dashed helper lines; the grid only
  when nothing is near, and not at all on a floor made from a robot vacuum's map (`grid_snap: false`), so nothing
  jumps onto the grid and slanted walls stay slanted. Dragging the middle point of a wall moves the whole wall (a tap
  there still adds a corner). A wall or corner two rooms share moves for both, doors and windows on it too; Alt or
  the new chain button in the toolbar moves only the room's own.
- House rules "Wo ist wer": places are called what they are instead of "Gelernter Ort" – "<point of interest>
  <district or town>" (e.g. a sports hall or a supermarket), else "<street no>, <town>", else the town, from the
  phone's geocoded location sensor (Home Assistant app, iOS and Android). Learned places take the name over on a
  visit, a better kind replaces a weaker one, a name given by hand always wins; the same names show in the status
  lines, the destination ("probably towards …"), the timeline and the card's people bar.
- The optional OpenStreetMap lookup (off by default) is now only for phones without a place name, sends the
  position rounded to about 10 m and also returns points of interest; documented in PRIVACY.md and THIRD_PARTY.md.
- Card: "Wer ist wo" (the people in the card's head) is on by default as soon as Home Assistant has persons – cards
  without the setting now show it; `people: false` switches it off. The pictures stand side by side with room for
  their ring (they used to overlap), more than four show as "+N". The switch moved up to "Darstellung".
- Editor: room labels are chosen with three small picture tiles (label outside, label inside, engraved in the wall)
  right under "Darstellung"; the editor tour asks "So erscheinen Temperaturen" with the same tiles. "In der Wand"
  is now called "In die Wand graviert".

### Fixed

- Card: the WebGL probes give their context back at once – browsers keep only a few live contexts per page and
  Firefox drops the oldest, which could be the 3D scene's own (then the CSS 3D view with flat labels showed).

## [0.1.0-beta.6] - 2026-11-15

### Added

- Card first steps: **from the robot vacuum's map** – rooms with their names, straight walls, doors, the vacuum and
  its dock, the vacuum already aligned for the live view; preview first, then an unsaved draft in the editor.
  Without a map yet it offers a mapping run (after a second tap) and picks the map up once it is there.

### Changed

- House rules → Licht shows every room, not only rooms with a lamp or presence sensor; a room without a lamp
  says so with a chip that opens "Raum einstellen".

## [0.1.0-beta.5] - 2026-11-15

### Fixed

- roomwise: the folders of the earlier version (HACS leaves `floorplan_card` behind when updating from 0.1.0-beta.3)
  no longer leave roomwise silently not starting – adding roomwise, or "Fix" under Settings → Repairs, moves them to
  `roomwise-alte-ordner/` in the configuration (nothing is deleted) and restarts Home Assistant.

## [0.1.0-beta.4] - 2026-11-15

### Changed

- **One integration, roomwise** (0.1.0-beta.4): the card's companion integration `floorplan_card` and Hausregeln
  `house_rules` are now one integration in `custom_components/roomwise` – HACS installs everything in one step
  (download, restart, add *roomwise*; nothing to fill in), Hausregeln is in the sidebar right away and its setup
  assistant opens on first use. The release carries one `roomwise.zip` (HACS installs it, `zip_release`).
- Coming from the two old integrations (beta.4; since beta.5 roomwise moves the old folders itself): install roomwise, delete the folders `custom_components/floorplan_card` and
  `custom_components/house_rules` (not the integrations under Devices & services), restart. roomwise takes over their
  entities with the same entity ids, their device and settings, and removes the old entries; as long as an old folder
  is still there, roomwise does not start and says so under Repairs.
- The actions are called `roomwise.run`, `roomwise.pause` and `roomwise.reset_alarm_pin` (before `house_rules.…`).
  Websocket commands, events and storage files keep their names.

## [0.1.0-beta.3] - 2026-11-15

### Fixed

- HACS: the installed integration missed the card file ("Kartendatei fehlt") – HACS installs the release package
  `floorplan_card.zip` again, which contains the built card.
- House rules heating: a temperature set by hand in smart mode now really ends once the room has been empty long
  enough – before, it only ended at the next sensor change in the room.

### Removed

- Song recognition (microphone of a wall tablet, AcoustID): gone from the card, the companion integration and the
  privacy notes; old settings and the last recognized songs are dropped, leftover "… now playing" sensors are
  removed from the entity list.

## [0.1.0-beta.2] - 2026-11-15

### Fixed

- HACS: the download failed (it looked for a release zip on a plain commit) – HACS now installs the integration folder
  straight from the repository; betas are regular releases, no "show beta versions" needed.

### Changed

- The companion integration and its HACS entry are called "roomwise".

## [0.1.0-beta.1] - 2026-11-15

First public beta.

### Added

- House rules setup: the setup wizard is rebuilt in the new design (a pop-up) and leads roughly through everything:
  one step switches every function on or off, after it only the steps of the functions that are on follow, each
  with "start its assistant" or a quick setup; the light step offers "Lampen abgleichen", a new step sets up the
  "Reinschau-Licht" (only with the floor plan card), each room links to "Raum einstellen", and the summary shows
  what is on and what is off.

- House rules light: "Lampen abgleichen" – set all lamps of a room live to a reference colour (red … pink, warm /
  neutral / cold white), correct each lamp by eye until they look alike; the correction is remembered per lamp and
  colour, interpolated in between, and every rule, the light plan and the live preview send each lamp its corrected
  colour and brightness.
- House rules light: "Reinschau-Licht" (peek-in light) as its own tile – on a plain map of the floor plan's rooms
  you choose per room which neighbouring rooms make it glow (someone there, a light on, a door open or closed), which
  lamps how bright and when; offered only when the floor plan card is set up.
- House rules heating: "Kurz daheim" per room – when you usually stay only an hour or two (e.g. in the evening),
  the room is heated to a lower temperature of its own instead of the full comfort temperature. The comfort slider
  is now called "Wohlfühltemperatur" and explains when it stays cooler.
- House rules heating: "Abends ausklingen" per room – from a time (an hour before the learned bedtime by default)
  until the night the room is held at a lower temperature while people are still up, so it cools down slowly
  instead of being heated right up to bedtime.

### Changed

- Card: the English texts are loaded only when the card speaks English – the start bundle is ~55 KB smaller
  (777 → 723 KB, budget 750 KB).
- House rules light: per suggested door of the Reinschau-Licht a direct choice "occupied + door open" / "door open only" /
  "occupied only" / off; easy colour fields (candle … pink, own colour) and "see it live on the lamps" for the vacation
  light and the Reinschau-Licht too (the light rule editor already had it).
- House rules "Reinschau-Licht": brightness in percent (all lamps and per lamp), colour either like the room's light
  rules right now (evening warm, night candle …) or an own colour, and when it glows at all (night, dark, a time
  window or always; not while sleeping or with guests) is one setting for all rooms.
- House rules "Reinschau-Licht": a room suggests the doors with a sensor that border on it on the floor plan (someone
  behind the door and the door open); the other triggers show only after switching on "Weitere Auslöser". The map
  shows those doors.
- House rules: what is switched off stays out of the way – in Heizung → Ganzes Haus switched-off parts (summer mode,
  heat demand, valve exercise, reminders) move to an "Ausgeschaltet" list at the end, the heat-demand chip only shows
  when it is set up, and Einstellungen → Funktionen lists everything switched off in one place.
- House rules places and card: the arrival time of somebody on the way counts down between two positions (the
  person keeps going) instead of standing still until the phone reports again; past it the card says "almost there".
- Card: full screen is remembered on the device once switched on – after reloading, a restart of Home Assistant or
  when the browser ends it by itself it comes back (first as kiosk mode, real full screen with the next tap); only
  the button (or Escape) switches it off.
- Card: while the "on the way" panel is shown under "Wer ist wo", the building moves down below it instead of
  lying under it.
- House rules: new design (tiles and pop-ups). Every area shows equal tiles that open a pop-up; a page head per area
  with title, a summary line, a house mode button (pop-up to switch) and a page gear. "Arrange rooms" sets one room
  order for Licht, Heizung, Räume and Geräte and hides rooms per page; one pop-up "Raum einstellen" holds a room's
  sensors, empty-after, door logic and darkness for all areas. The layout is stored as `settings.ui` (new websocket
  command `house_rules/ui/set` for residents, `settings/set` takes `ui`, rules get an optional `group`, backups include
  it). Vacation and guests moved to Settings → "Urlaubsmodus" (new switch "Gäste sind da"); Home shows person tiles
  with a "counts" switch. The robot vacuum pause sits behind the gear of the rooms page.
- House rules: the room behaviours ("Raumverhalten") are gone. On the first start each behaviour that was switched on
  becomes an ordinary rule once (on if it ran, off otherwise); the hidden `b_` rules and the feature `behaviours` are
  removed, "pause music when nobody is there" is now a rule suggestion per room. `behaviour/set` and `behaviours` in
  the snapshot remain but have no effect.

- House rules heating, direct valve control: the controller looks ahead (a radiator keeps heating after its valve
  closed; a cooling room gets the valve opened earlier), corrects a wrong temperature within an hour or two instead
  of the room's cooling time, opens less the warmer the room is above its target and shuts it 0.2 °C above, and
  learns the opening slowly and only while the room is steady; the styles
  open the valve less (Komfort 55 %, Eco 45 %, Sportlich 85 %, more only if the room would stay cold), and
  preheating is planned with that gentle opening, so it starts earlier instead of late with the valve wide open.

- House rules light plan: a lamp changed by a person, a house rule (a button …) or another automation counts as set
  by hand – the plan leaves it per the room's "by hand" setting, and a "when" light rule sets its lights once when
  it fires instead of taking them back later. Only users set up as automations, the start-up phase and what a
  "never on" forbids are put back.

### Changed

- Card: closing a garage door or gate from the plan or its popup needs the same slide as opening it – from afar nobody
  sees whether someone is underneath.
- Demo data of the house rules preview uses neutral example entities only.

### Fixed

- House rules "Aufstehen erkennen": only rooms that became occupied after leaving the bed count – a bathroom held by
  its door logic since the evening made a short trip look like getting up and ended sleep too early.
- House rules light plan: a lamp that comes back after being unreachable (power cut, Wi-Fi) no longer counts as
  switched by hand – unless a rule wants something else it goes back to how it was before the outage.
- House rules roles: the language model's address (an outbound URL) can only be set by a Home Assistant
  administrator, also through settings/set.
- Card: labels and chips (room names, "Auto · 80 %") no longer lie flat on the tilted 3D plan now and then – the
  counter-rotation is written again when a render replaced the stage's style.
- House rules places: how somebody travels no longer says "bike" for a car in town or a train with stops – it
  uses the trip's speed profile (top speed, steadiness) instead of the average, keeps the phone's last clear
  activity through "Unknown" in between, and leaves the mode open when unsure.
- House rules "Aufstehen erkennen": rooms count once they were occupied since leaving the bed (walking through
  the kitchen is enough), the bed sensor reporting "occupied" again while someone is in another room no longer
  restarts the wait, and with the kitchen or living room plus more signs half the wait is enough.
- House rules: an evening out (house mode away or vacation in the evening) no longer teaches its departure time as
  bedtime, which moved "Abends ausklingen" to the early evening; bedtimes learned so far are forgotten once and
  learned again.
- House rules: going to sleep is recognised again – a bed presence sensor dropping out for a few seconds no longer
  starts "occupied for 5 min." again, and an evening active until 04:00 no longer pulls the learned bedtime into the
  afternoon (which made the heating think it was night from mid-afternoon on); such a bedtime is forgotten once.
- House rules: a "while" rule that is switched off or paused no longer runs its "sonst" steps after a Home
  Assistant restart.
- House rules: "Aufstehen erkennen" really ends "Schlafen" – the empty bed made the start conditions fail at the
  same moment, which lifted the hold and kept the mode running.
- House rules light plan: a lamp switched on by hand while its room counted as empty (by voice from elsewhere, or
  the sensor lost someone lying still) is no longer switched off right away – with "until the room is empty" it
  stays on until the room was entered and left again.
- House rules light plan: no more re-sending loop for lamps that report differently than asked (rounded colours,
  another colour mode, fades reported in steps): colours are compared in a common colour space with tolerance, and
  the same setting is re-sent only after its fade plus 2.5 s, at most three times.
- Lamps that are off and get a colour no longer flash white first: they power up in the colour at a very low
  brightness without a fade, then go to the wanted brightness with the wanted fade (light plan and house rules).
- "Never on" exceptions: a command that switches several lamps is judged once it has arrived (a block that
  depends on another lamp of the same command no longer fires on the in-flight state), and late reports (after
  5 s) of a house rule's command count as that rule instead of "by hand".

### Added

- Hausregeln: "Detect getting up" for the house mode "Sleep" (off by default, in the Sleep sheet). Sleep ends when the
  residents got up for the day – not on a night trip: bed empty longer than a learned threshold (always above the
  usual night trips; a short return to bed does not count), other rooms occupied (kitchen/living room count more than
  hall/bath), lights switched on by hand, doors, the time against the learned get-up time per workday/day off and how
  long the night has lasted. Guardrails: only in a plausible morning window, never in the first 4 h unless very sure,
  more evidence the earlier it is; after 90 min of an empty bed sleep ends anyway. "End right away" or "Ask first";
  now and then (first 7 times, when unsure, else about weekly) the admins get "Getting up detected at 07:12 – is that
  right?" with Yes / No, too early / No, I was up earlier. Answers, switching sleep off or on again by hand and going
  back to bed right after a detection adjust what was learned. Buttons count only from recipients. New websocket
  commands `wakeup/set`, `wakeup/reset` (admin), new notification kind `wakeup`, `mode_auto.wakeup` in the snapshot.
- House rules heating: new default for changes by hand, "Intelligent": a value set at the thermostat or in the app
  stays until the circumstances really change (house mode, everyone leaves, room empty for 45 min, the next real
  change of the plan between comfort, setback and night), at most a configurable 1–12 h (default 4 h). An open
  window only interrupts it. Existing "until the next time" settings switch to it once; other choices stay.
- Devices inside furniture: a cabinet, shelf or any other piece can hold several devices (`contents`); a tap
  lists them with state and a quick switch for plain on/off devices, each row opens the device's own popup.
- Hausregeln: "Live on the lamp" wherever a light setting is edited (light rules, variants, the step "set light"):
  every change, even while a slider moves, shows on the real lamps (throttled, last value wins; each lamp its own:
  only the opened lamp), and the lamps go back to how they were when it is switched off, the editor closes or the
  page is left, unless "leave as is" is ticked. Next to it, what each lamp reports right now (brightness 0–255,
  colour mode, hs/xy/rgb) to copy or take over. Lights only; guests don't get it, and every lamp is checked against
  the user's Home Assistant control right. The integration runs the preview (`house_rules/light/preview`): its calls
  don't count as a change by hand for the light plan (no pause, nothing learned), the plan keeps its hands off the
  lamps meanwhile, and the lamps go back by themselves when the panel's connection drops or nothing comes for three
  minutes. With an older integration the panel switches the lamps itself.

### Fixed

- Hausregeln house mode: a running mode no longer ends because its waiting times ("for 10 min") start from zero after
  a restart of Home Assistant; nothing switches by itself during the start-up phase; "Sleep" survives a sensor
  drop-out of up to 60 s (bed zones that flicker). A mode that ended by its own end does not start again until its
  start conditions stopped holding once. "Guests" set by hand comes back after the night instead of "Home".
- Hausregeln: "all lights … are off" (and turn off) no longer stays false forever because one lamp of the room is
  unavailable (unplugged, off at the wall); it only counts when all of them are unavailable.
- Hausregeln: colours sent as `xy_color` now use Home Assistant's own RGB → xy conversion ("Wide RGB D65"), so a
  colour looks the same on an xy lamp as when Home Assistant converts `rgb_color` itself (needs a restart of Home
  Assistant to take effect).

### Fixed

- House rules heating: changes by hand survive a restart of Home Assistant; a person changing a thermostat in the app
  during the start-up phase counts as a change by hand; a value set by hand comes back after an open window.

## [0.1.0-alpha.1] - 2026-11-15

The first public alpha. roomwise has been in daily use in one home before this release, but not yet in others.

### Floor plan card

- Interactive floor plan in 3D (WebGL, with a lighter CSS fallback) or 2D, with pinch, drag, rotate and
  double-tap gestures, light and dark theme, portrait layout with room tiles.
- Editor inside the card: rooms as polygons or rectangles with real wall lengths, doors and windows on walls,
  several floors with stairs and a floor slider, outdoor areas, floor materials and wall colours, undo/redo, YAML
  export, saving straight into the dashboard. Areas suggest lights, sensors, thermostats and window contacts.
- Object library with more than 130 kinds of furniture and appliances, drawn in code; lamps, radiators, fans, TVs,
  speakers and more show their live state when linked to an entity.
- Live state: lit rooms, lamp colours with light on the floor, heating shown as rising warm air, doors and windows
  that open, temperature and humidity labels, sun position, clouds, rain, snow, fog and thunderstorms from the
  weather entity.
- Popups for lights, thermostats, covers, media players, robot vacuums, to-do lists, rooms and cars; configurable
  tap, double-tap and long-press actions; locks, alarm panels and sirens always ask first.
- Robot vacuum driving live across the plan with its cleaning trail (Roborock with the companion integration),
  map alignment in the editor.
- Cars (27 models) with battery, range, charging and location; solar, home battery, wall box and heat pump objects.
- Garages (attached or free-standing) with sectional, up-and-over or roller doors and gates that move live from
  their `cover`; garden with lawn, paths, beds, pond, pool, fences and lights, a robotic mower with popup, and
  irrigation zones linked to `valve` entities; the property line.
- Dogs and cats as animated figures with walk times, a dog editor, and reminders to phones.
- Wall tablet care: no polling, redraws only on change, idle animations throttled, *Saver* and *Off* modes per user,
  a stats overlay on the compass.
- German and English interface.

### Companion integration (`floorplan_card`)

- Serves the card to every dashboard without a manual resource.
- Front door alert that also works without a tablet: open windows pulse, lamps can flash, optional announcement.
- Walk reminders and shared walk check-offs across devices.
- Live robot vacuum position and learned cleaning paths.

### Hausregeln (`house_rules`, German interface)

- Rules as sentences (*when … and … then …*, *while …*), built in a sentence editor or typed as text; a built-in
  German parser, optionally helped by an AI provider (Ollama, Gemini, OpenAI, Anthropic, Mistral or
  OpenAI-compatible).
- Test run before saving, history with the reason for every run and every skipped run, suggestions from the devices
  found, an overview of existing Home Assistant automations.
- Rooms with occupancy from motion and presence sensors, door logic and light level; behaviours for all rooms.
- House mode (home, away, sleeping, vacation, guests) with automatic switching.
- Light plans per room with *when*, *while*, *never on* and *stays on* rules.
- Heating per room: schedules, window and airing detection, manual overrides, learned pre-heating, airing reminders,
  valve hints and valve protection.
- Alarm system with away, night and home modes, delays, sirens and lights, phone notifications with a protected
  disarm button, e-mail, Telegram and Signal channels, PIN and passkey confirmation with lockout.
- Window warning when the front door opens while windows are open; the card shows it on every tablet.
- Vacation simulation learned from the home's real daily patterns.
- Pause for motion sensors while a robot vacuum cleans.
- Setup assistant and per-feature switches; after installation only the automatic house mode runs.

[Unreleased]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.11...HEAD
[0.1.0-beta.11]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.10...v0.1.0-beta.11
[0.1.0-beta.10]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.9...v0.1.0-beta.10
[0.1.0-beta.9]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.8...v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.7...v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.6...v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.5...v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.4...v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.3...v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.2...v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/jonasstack/roomwise/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/jonasstack/roomwise/compare/v0.1.0-alpha.1...v0.1.0-beta.1
[0.1.0-alpha.1]: https://github.com/jonasstack/roomwise/releases/tag/v0.1.0-alpha.1
