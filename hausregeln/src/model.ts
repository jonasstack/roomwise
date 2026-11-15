/**
 * Data model of a house rule.
 *
 * Deliberately flat so that a small local language model can write it:
 * every part of a rule is a "clause" = subject + verb (+ a few named values).
 *
 *   { "subject": "binary_sensor.haustur", "verb": "opens" }
 *   { "subject": "any:window", "verb": "is_open" }
 *   { "subject": "light.flurlicht", "verb": "turn_on", "brightness": 70, "for": "5m" }
 *
 * Subjects are strings:
 *   <entity_id>                a single device            light.flurlicht
 *   any:<kind>[@<room>]        any device of a kind       any:window, any:window@kuche, any:window@same
 *   all:<kind>[@<room>]        every device of a kind     all:light@wohnzimmer
 *   room:<room>                a room (its presence)      room:flur
 *   zone:<entity_id>           a zone inside a room       zone:binary_sensor.fp2_sofa
 *   person:<id>|someone|everyone   people                 person:alex, person:everyone
 *   time | sun | mode | wait   time, sun, house mode, a pause between steps
 *   rule:<rule_id>             another rule (link rules)
 *   notify:<person>|everyone   a message to people's phones
 *
 * "@same" means: the same room as the device that triggered the rule. That turns one rule into a
 * rule for every room ("window open → heating in that room off").
 */

export type RuleType = 'when' | 'while';

export interface Clause {
  subject: string;
  verb: string;
  /** Duration like "30s", "5m", "1h" */
  for?: string;
  /** conditions only: alternatives, one of them is enough ("… oder …") */
  or?: Clause[];
  [param: string]: unknown;
}

export interface RuleOptions {
  /** At most once per … */
  cooldown?: string;
  /** Someone switched a device by hand: leave it alone for … ("" = never) */
  manual_pause?: string;
  /** Tell me when it ran */
  notify_me?: boolean;
  /** Allow locks, alarm and garage doors to be opened automatically */
  allow_sensitive?: boolean;
  /** the language model checks right before every run whether it makes sense now */
  ai_check?: boolean;
  /** while rules: put back what was changed when it no longer holds (default true) */
  restore?: boolean;
  /** set off again while it still runs: single (ignore) · restart · queued · parallel (like an automation's mode) */
  mode?: 'single' | 'restart' | 'queued' | 'parallel';
  /** queued / parallel: at most this many at once */
  max?: number;
}

export interface Rule {
  id: string;
  name: string;
  /** the rule as a sentence, filled in by the integration (read only) */
  sentence?: string;
  type: RuleType;
  /** when: any of these happens (or). while: all of these hold. */
  when: Clause[];
  /** extra conditions (and) */
  and: Clause[];
  /** steps, in order */
  then: Clause[];
  /** limits: time windows, house modes, presence */
  only: Clause[];
  /** while rules ("Wechselnd"): steps for when it no longer holds, instead of putting things back */
  else?: Clause[];
  enabled: boolean;
  /** ISO time until the rule is paused */
  paused_until?: string;
  options: RuleOptions;
  /** topic tags for filters: light, heating, safety, presence, media, cleaning, energy */
  tags?: string[];
  /** own group on the rules page ("g_…", see UiLayout.groups); only for the layout */
  group?: string;
  meta?: RuleMeta;
}

/** an own group of rules on the rules page ("Abendroutine") */
export interface RuleGroup {
  id: string;
  name: string;
  /** not shown on the page (its rules keep running) */
  hidden: boolean;
}

/** pages with room tiles */
export type RoomPage = 'light' | 'heat' | 'rooms' | 'devices';

/** Page layout of the panel (settings "ui", ui_layout.py): nothing here changes what runs. */
export interface UiLayout {
  /** rules page: grouped by topic (auto) or in own groups (manual) */
  grouping: 'auto' | 'manual';
  groups: RuleGroup[];
  /** one order of the room tiles for all pages (room ids; rooms not listed follow in their usual order) */
  room_order: string[];
  /** rooms a page leaves out (their rules and plans stay) */
  room_hidden: Partial<Record<RoomPage, string[]>>;
}

export interface RuleMeta {
  created?: string;
  origin?: 'user' | 'suggestion' | 'text' | 'room' | 'import';
  last_run?: string;
  runs_week?: number;
  /** HA automations this rule replaced */
  replaces?: string[];
  /** the rule was taken over as a Home Assistant automation (and switched off here) */
  exported?: { automation_id: string; at: string; by?: string | null };
}

/** Roles in Hausregeln (house_rules/permissions, docs/API.md) */
export type Role = 'admin' | 'resident' | 'guest';
export interface Me {
  user_id: string | null;
  name: string;
  role: Role;
  label: string;
  ha_admin: boolean;
  can: { edit_rules: boolean; edit_plans: boolean; use_alarm: boolean; settings: boolean; security: boolean; features: boolean };
}
export interface RoleUser {
  id: string;
  name: string;
  role: Role;
  label: string;
  ha_admin: boolean;
  /** Home Assistant admins are always admins here */
  fixed: boolean;
  owner: boolean;
}

/** A Home Assistant user whose changes may come from another automation system (Node-RED, AppDaemon …) */
export interface AutomationUser {
  id: string;
  name: string;
  /** made by Home Assistant itself (e.g. "Supervisor": add-ons call as this user) */
  system: boolean;
  /** the name looks like an automation system */
  suggested: boolean;
  /** counts as automation, not as a person (own choice, else the suggestion) */
  automation: boolean;
}

/** One saved state of a rule (house_rules/rule/versions), newest first */
export interface RuleVersion {
  id: string;
  at: string;
  by: string | null;
  by_name: string;
  kind: 'create' | 'edit' | 'restore' | 'before' | 'trash_restore' | 'import';
  changes: string[];
  /** whole sentences, ready to show */
  summary: string;
  sentence: string;
  current: boolean;
}

/** A deleted rule in the trash (30 days) */
export interface TrashItem {
  id: string;
  name: string;
  deleted: string | null;
  deleted_by: string | null;
  deleted_by_name: string;
  until: string | null;
  sentence: string;
  rule: Rule;
}

/** A rule as a Home Assistant automation (house_rules/rule/export) */
export interface RuleExport {
  id: string;
  automation: Record<string, unknown>;
  yaml: string;
  /** what could not be carried over, as sentences */
  notes: string[];
  complete: boolean;
}

export type HouseMode = 'home' | 'away' | 'sleep' | 'vacation' | 'guests';

/** A room as Hausregeln sees it: which sensors tell whether someone is there. */
export interface Room {
  id: string;
  name: string;
  /** "in der Küche", "im Flur" */
  in: string;
  icon: string;
  /** presence sensors (mmWave etc.): reliable, also when someone sits still */
  presence: string[];
  /** motion sensors: fast, but forget a person who does not move */
  motion: string[];
  /** door contacts of the room: a closed door keeps the room occupied */
  doors: string[];
  /** zones inside the room (e.g. FP2 areas): sofa, bed, desk */
  zones: string[];
  /** brightness sensor and the level below which the room counts as dark */
  lux?: string;
  dark_below?: number;
  /** room counts as empty after this many minutes without presence */
  empty_after: number;
  /** door logic: someone went in and closed the door → stays occupied until the door opens */
  door_logic: boolean;
  /** these doors (anywhere in the house) opening make the room occupied for door_pulse_for seconds */
  door_pulse?: string[];
  door_pulse_for?: number;
  /** the dark signal: lux below dark_below OR the sun below `sun`° OR inside from–to; bright again only margin %
   * above dark_below (sun 3° above) for bright_for minutes; lux_when: only while the room's lights are off / always */
  dark?: RoomDark;
  /** room behaviours on/off; undefined = follows "all rooms" */
  behaviours: Partial<Record<BehaviourId, boolean>>;
}

export interface RoomDark {
  /** sun limit in degrees; null = only without a light sensor (below the horizon) */
  sun: number | null;
  /** evening window "HH:MM" (empty = none) */
  from: string;
  to: string;
  margin: number;
  bright_for: number;
  lux_when: 'lights_off' | 'always';
}

export type BehaviourId ='light_on_enter' | 'light_off_empty' | 'heat_eco_empty' | 'media_pause_empty' | 'night_dim';

export interface Behaviour {
  id: BehaviourId;
  title: string;
  detail: string;
  icon: string;
  /** default for all rooms */
  all: boolean;
}

export interface Device {
  entity_id: string;
  name: string;
  /** kind from the vocabulary (light, window, door, presence …) */
  kind: string;
  room?: string;
  state: string;
  /** shown under the name: "48 lx", "21,5 °C" */
  detail?: string;
  /** HA calls it a door but the name says window etc. */
  kind_hint?: string;
  /** device has no room; its name suggests this one */
  room_guess?: string;
  /** belongs to no room: set by the user, or likely (groups, scripts, phones, cars) */
  no_room?: 'set' | 'likely';
  /** what was detected, when the user changed kind / room / name */
  auto_kind?: string | null;
  auto_room?: string | null;
  auto_name?: string;
  /** own mdi icon ("mdi:…") */
  icon?: string;
  /** added by hand */
  manual?: boolean;
  /** the vehicle this tracker belongs to (kind "vehicle") */
  vehicle?: string;
  /** lights: what the lamp can do (colour modes, Kelvin range, effects; from its state) */
  light?: import('./lightspec').LightCaps;
}

/** A change of the central override store (house_rules/devices/set). */
export interface DeviceChange {
  entity_id: string;
  kind?: string | null;
  room?: string | null;
  no_room?: boolean;
  /** "nicht verwenden" */
  hidden?: boolean;
  name?: string;
  icon?: string;
  /** added by hand */
  manual?: boolean;
  /** back to what was detected (a manual device is removed) */
  reset?: boolean;
}

/** Not used: excluded by the user, or a part of a vehicle (car door, lock …). */
export interface UnusedDevice {
  entity_id: string;
  name: string;
  kind: string;
  room?: string | null;
  reason: 'user' | 'vehicle';
  vehicle?: string;
}

export type ObjectAlarmKind = 'bike' | 'car' | 'garage' | 'shed' | 'building' | 'other';
export type ObjectAlarmState = 'disarmed' | 'armed' | 'pending' | 'triggered';

/** A small alarm besides the house alarm ("Weitere Alarme"): bike, car, garage, shed … */
export interface ObjectAlarm {
  id: string;
  name: string;
  kind: ObjectAlarmKind;
  icon: string;
  sensors: string[];
  delay: number;
  confirm: boolean;
  auto: { with_alarm: boolean; arm_on: string[]; disarm_on: string[] };
  notify: { persons: 'everyone' | string[]; critical: boolean };
  sirens: string[];
  lights: string[];
  camera: string;
  duration: number;
  state: ObjectAlarmState;
  label: string;
  since?: number;
  until?: number | null;
  cause?: string | null;
  cause_name?: string | null;
  by_auto: boolean;
  /** contacts / locks that are open right now */
  open: string[];
  /** start-up phase after a start of Home Assistant: no sensor counts yet */
  settling?: boolean;
}

export interface Person {
  id: string;
  name: string;
  home: boolean;
  where: string;
  phone?: string;
  /** phones that get messages; phones_found: all found (the others are switched off by the user) */
  phones?: string[];
  phones_found?: string[];
  entity_id?: string;
  /** raw state of the person: home, not_home or a zone name */
  zone?: string;
}

/** An existing Home Assistant automation, shown read-only. */
export interface HaAutomation {
  entity_id: string;
  name: string;
  enabled: boolean;
  last?: string;
  /** devices it touches, as trigger / condition / action */
  uses: { entity_id: string; as: 'trigger' | 'condition' | 'action' }[];
  /** plain-language summary */
  summary: string;
}

export interface HistoryEntry {
  at: string;
  rule?: string;
  automation?: string;
  /** device that changed */
  entity_id?: string;
  /** "Flurlicht an (70 %)" */
  what: string;
  /** "weil die Haustür aufging und es dunkel war" */
  why: string;
  kind: 'rule' | 'automation' | 'manual' | 'skipped' | 'alarm';
  /** name of the rule (also for room behaviours, which are not in the rule list) */
  rule_name?: string;
  entities?: string[];
}

export interface Suggestion {
  id: string;
  title: string;
  why: string;
  icon: string;
  /** a ready rule to adopt, or a housekeeping task */
  rule?: Rule;
  task?: 'fix_kinds' | 'assign_rooms' | 'merge' | 'behaviours' | 'heat_block';
  badge?: string;
  /** a proposal of the smart heating: becomes a fixed time of the room when accepted */
  heat?: { room: string; kind: 'habit' | 'manual'; block: HeatBlock };
}

/** An own group ("Gruppe") like "Heizung" or "Fernseher": devices of any kind under one name. */
export interface Group {
  id: string;
  name: string;
  /** icon name (heating, tv, light, …) or mdi:… */
  icon: string;
  members: string[];
  /** counts as on / open when any member is, or only when all are */
  match: 'any' | 'all';
}

/** "Wo ist wer" (places.py, snapshot part `places`): one person. */
export interface PlacePerson {
  id: string;
  entity_id: string;
  name: string;
  picture?: string | null;
  /** zone | place (learned/unknown spot, confirmed) | stay (stopped a few minutes) | moving | unknown */
  state: 'zone' | 'place' | 'stay' | 'moving' | 'unknown';
  /** zone id or learned place id ("lp_…") when known by name */
  place?: string | null;
  place_name?: string | null;
  since?: string | null;
  /** status line from the server: "Arbeit · seit 8:12", "Unterwegs · wahrscheinlich nach Hause · ca. 12 Min." */
  line: string;
  street?: string | null;
  lat?: number | null;
  lon?: number | null;
  speed_kmh?: number | null;
  trend?: 'closer' | 'away' | null;
  distance_home_km?: number | null;
  prediction?: { destination: string; name: string; probability: number; eta_min: number | null; basis?: string } | null;
}

/** A learned place: stays of 10+ minutes outside the zones, 3+ visits (or named). */
export interface LearnedPlace {
  id: string;
  name: string;
  label: string;
  lat: number;
  lon: number;
  radius: number;
  visits: number;
  street?: string | null;
  /** the name of the spot (point of interest, else the address) from the phone or OpenStreetMap; `name` wins */
  auto?: string | null;
  typical: { days: 'workdays' | 'weekend' | 'mixed'; arrive: string | null; stay_min: number };
  last?: string | null;
}

export interface PlacesView {
  persons: PlacePerson[];
  learned: LearnedPlace[];
  settings: { learn: boolean; nominatim: boolean };
  stats: { trips: number; warming: boolean; nominatim_requests?: number };
}

/** house_rules/places/person: today's stays and trips */
export type PlaceStep =
  | { kind: 'stay'; place: string; name: string; from: string; to: string | null }
  | { kind: 'trip'; from_place: string | null; to_place: string | null; from_name: string; to_name: string | null; from: string; to: string | null };
export interface PlaceDetail {
  person: PlacePerson;
  timeline: PlaceStep[];
  trips: { from: string | null; to: string; start: string; minutes: number }[];
}

/** A Home Assistant zone ("Ort"): Zuhause, Arbeit, … */
export interface Zone {
  id: string;
  entity_id: string;
  name: string;
  icon: string;
  radius?: number;
  passive?: boolean;
  /** person entity ids currently in the zone */
  persons: string[];
}

export type AlarmMode = 'away' | 'night' | 'home';

export type AlarmEvent = 'triggered' | 'pending' | 'armed' | 'disarmed' | 'test' | 'repeat';
export type Recipients = 'same' | 'everyone' | string[];

/** more ways besides the phone app; secrets are never sent to the frontend */
export interface AlarmChannels {
  email: { on: boolean; host: string; port: number; security: 'starttls' | 'ssl' | 'none'; user: string; sender: string; to: string[]; events: AlarmEvent[]; has_password?: boolean; password?: string };
  telegram: { on: boolean; users: string[]; call: boolean; text: boolean; events: AlarmEvent[] };
  signal: { on: boolean; numbers: { phone: string; has_key?: boolean; apikey?: string }[]; events: AlarmEvent[] };
  services: { on: boolean; list: string[]; events: AlarmEvent[] };
}

export interface AlarmModeConfig {
  /** loud: siren, sound, lights, devices · silent: message + devices · notify: only messages */
  reaction?: 'loud' | 'silent' | 'notify';
  sensors: string[];
  entry_delay: number;
  exit_delay: number;
  /** false = silent alarm: only the message, no siren, sound, announcement or lights */
  loud: boolean;
  lights: { mode: 'on' | 'flash' | 'red' | 'none'; entities: string[] };
  /** switched on at an alarm: cameras, switches (e.g. recording), scenes, scripts */
  activate: string[];
  smart: {
    /** door opened shortly after someone was in its room: from inside, no alarm */
    inside: { on: boolean; seconds: number };
    /** someone came home a moment ago (phone): no alarm, or disarm */
    arrival: { on: boolean; minutes: number; disarm?: boolean };
  };
  auto: {
    arm_on: string[];
    disarm_on: string[];
    arm_at: string;
    disarm_at: string;
    only_auto: boolean;
    /** arm when the persons of `presence` are all away (for `away_for` minutes) */
    arm_away?: boolean;
    away_for?: number;
    /** disarm when one of them comes home */
    disarm_home?: boolean;
  };
}

export interface AlarmConfig {
  version?: number;
  enabled: boolean;
  has_code?: boolean;
  /** users locked out right now after too many wrong PINs */
  pin_locked?: number;
  /** how disarming in the app is confirmed; "pin" and "device" need a PIN (server refuses otherwise) */
  confirm: 'none' | 'pin' | 'device';
  /** "Alarm aus" in the phone message (the phone asks for Face ID / its code first) */
  notify_disarm?: boolean;
  modes: Record<AlarmMode, AlarmModeConfig>;
  notify: {
    persons: 'everyone' | string[];
    pending_persons?: Recipients;
    armed_persons?: Recipients;
    disarmed_persons?: Recipients;
    test_persons?: Recipients;
    critical: boolean;
    pre_alarm: boolean;
    armed: boolean;
    disarmed?: boolean;
    repeat?: { on: boolean; every: number; max: number; channels: boolean };
  };
  channels?: AlarmChannels;
  /** who counts for "everyone away" and "just came home" */
  presence?: { persons: 'everyone' | string[] };
  announce: { players: string[]; pending_text: string; triggered_text: string };
  sirens: string[];
  sound: { players: string[]; tone: string; url: string; volume: number; pre_tone: string };
  cameras: string[];
  buttons: string[];
  phone: string;
  duration: number;
  devices: { id: string; name: string; created?: number }[];
}

export type PlanDays = 'all' | 'workdays' | 'weekend';
/** a preset, a white of its own ('k:3200') or any colour ('#ff8800') */
/** colour strings (lightspec.ts / lightspec.py): presets, Kelvin, hex RGB, RGBW, RGBWW, HS, XY, the white channel, keep */
export type LightColor = 'kerze' | 'warm' | 'neutral' | 'kalt' | `k:${number}` | `#${string}` | `rgbw:${string}` | `rgbww:${string}` | `hs:${string}` | `xy:${string}` | 'white' | 'none';
/** how lights should look (like light.turn_on); the lamp's colour modes decide what is sent */
export interface LightAction {
  mode: 'on' | 'off' | 'scene';
  /** % (or "$name": a value of the rule) */
  brightness: number;
  color: LightColor;
  /** 1-255, wins over brightness */
  bri?: number;
  /** a name from the lamp's effect_list */
  effect?: string;
  /** fade, seconds */
  transition?: number;
  flash?: 'short' | 'long';
  /** mode "scene": the HA scene to activate */
  scene?: string;
  /** each lamp its own (missing keys: as for all) */
  per_light?: Record<string, Partial<Omit<LightAction, 'per_light' | 'scene'>>>;
}
export type LightRuleKind = 'when' | 'while' | 'never_on' | 'keep_on';
/** a light rule of a room (Licht tab) */
export interface LightRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: LightRuleKind;
  /** when: one of these becomes true */
  trigger: Clause[];
  /** when: only if …; while/never_on/keep_on: as long as … */
  when: Clause[];
  /** empty = all lights of the room */
  lights: string[];
  action: LightAction;
  /** "je nach …": the first variant whose conditions hold wins */
  variants: (LightAction & { id: string; when: Clause[] })[];
  /** while: when it no longer holds */
  after: 'restore' | 'off' | 'nothing' | 'others';
  /** keep_on: when it no longer holds and the room is empty */
  empty_after: 'off' | 'dim' | 'keep';
  /** while: before "after", first wait the room's "nobody there any more" time and dim as set there (default true) */
  follow_empty?: boolean;
  /** while, follow_empty off: an own cool-down (minutes; dim 0 = no dimming, dim_for 0 = stays dimmed) */
  own_end?: { delay: number; dim: number; dim_for: number };
  /** while: these lights may not go on while it holds */
  block_lights?: string[];
  /** never_on / keep_on / the block of a while rule: not while one of these holds ("außer wenn …") */
  except?: Clause[];
  /** never_on / keep_on: only while these light rules (while) of the room hold */
  linked?: string[];
  /** never_on / block of a while rule: these may switch on anyway ('light:<id>' light rule, 'rule:<id>' house rule) */
  allow?: string[];
}
/** intelligent light: starting values per time of day (blended with what was learned) */
export interface SmartSlot {
  id: 'morning' | 'day' | 'evening' | 'late' | 'night';
  from: string;
  brightness: number;
  color: LightColor;
}
/** intelligent light of a room (lightlearn.py): learns from hand changes; guardrails always win */
export interface LightSmart {
  /** off · shadow = "Probelauf" (only shows "so hätte ich geschaltet") · on = acts */
  mode: 'off' | 'shadow' | 'on';
  /** empty = all lights of the room */
  lights: string[];
  only_dark: boolean;
  slots: SmartSlot[];
  guards: { max: number; night_max: number; night_warm: boolean; off_while: Clause[] };
}
/** what the intelligent light wants for one light right now, and why */
export interface SmartWant {
  mode: 'on' | 'off';
  brightness?: number;
  kelvin?: number;
  color?: LightColor;
  why: string[];
}
export interface SmartLearned {
  slots: { id: string; label: string; from: string; to: string; lights: Record<string, { on: boolean; p_on: number; brightness: number; kelvin: number; learned: number; slot: string; prior: { brightness: number; kelvin: number } }> }[];
  samples: number;
  agree: { n: number; same: number };
}
export interface LightPlan {
  on: boolean;
  smart?: LightSmart;
  rules: LightRule[];
  empty: { mode: 'off' | 'dim' | 'keep'; delay: number; dim: number; dim_for: number };
  manual: 'room_empty' | '30m' | 'none';
  guests_keep: boolean;
  vacation: { on: boolean; lights: string[]; start: 'sunset' | 'time'; offset: number; time: string; end: string; brightness: number; color: LightColor; random: boolean };
  /** Reinschau-Licht (glow.py): glows softly while someone is next door; becomes two rules of this plan */
  glow?: LightGlow;
  /** only when saving: rules made by hand for the same that the Reinschau-Licht replaces */
  glow_replace?: string[];
}
/** Reinschau-Licht of a room */
export interface LightGlow {
  on: boolean;
  /** other rooms that make it glow: someone in there, a light on there or either, optionally only with a door open/closed */
  sources: { room: string; by: 'occupied' | 'light' | 'either' | 'door'; door: string | null; door_state: 'open' | 'closed' }[];
  lights: string[];
  brightness: number;
  per_light: Record<string, number>;
  color: string;
  dark: 'night' | 'dark' | 'always';
  not_sleep: boolean;
  not_guests: boolean;
  /** only while these are off (e.g. the TV) */
  only_off: string[];
}
/** vacation "look lived-in", learned from everyday life (house-wide) */
export interface SimConfig {
  smart: boolean;
  /** simulated people; 0 = like the residents (max. 2) */
  people: number;
  morning: boolean;
  night: boolean;
  /** when it is dark enough for a light: every check that is on must agree */
  dark: SimDark;
}
export interface SimDark {
  sun: boolean;
  /** sun lower than this many degrees above the horizon */
  sun_below: number;
  lux: boolean;
  /** 0 = automatic (learned where you switch on, else the room's limit) */
  lux_below: number;
  /** only at times of day you use light in that room */
  habits: boolean;
  never: boolean;
  never_from: string;
  never_to: string;
}
export interface SimSegment {
  room: string;
  start: string;
  end: string;
  /** minutes since 04:00 */
  from: number;
  to: number;
  kind: 'stay' | 'pass' | 'wake' | 'bed' | 'night';
  walker: number;
}
export interface SimView {
  config: SimConfig;
  enabled: boolean;
  learning: boolean;
  days: number;
  first?: string;
  last?: string;
  bedroom: string | null;
  night_room: string | null;
  entrance: string | null;
  floorplan: boolean;
  neighbours: Record<string, { room: string; source: string }[]>;
  times: Record<string, { wake: string | null; bed: string | null; night_p: number | null; days: number }>;
  rooms: string[];
  /** rooms with a light sensor: below which level a light makes sense, and where it comes from */
  lux?: Record<string, { limit: number; source: 'eingestellt' | 'gelernt' | 'Raum'; now: number | null }>;
  /** right now, per room: dark enough? */
  now?: Record<string, { dark: boolean; why: string }>;
  /** per room the times of day (morning/day/evening/night) you use light there */
  habits?: Record<string, string[]>;
  sun?: number | null;
  people: number;
  day: string;
  timeline: SimSegment[];
}
export interface LightStatus {
  occupied: boolean;
  empty: boolean;
  lux: number | null;
  active: string[];
  /** per light: why it is as it is */
  lights: Record<string, string>;
  held: string[];
  /** intelligent light (when not off): per light what it wants (shadow: "so hätte ich geschaltet") */
  smart?: { mode: 'shadow' | 'on'; lights: Record<string, SmartWant>; agree: { n: number; same: number }; samples: number } | null;
}
export interface HeatWindow {
  from: string;
  to: string;
  days: PlanDays;
  temp: number;
  level?: HeatBlockLevel;
}
/** heating (heating.py): temperature levels of a room */
export type HeatLevel = 'comfort' | 'base' | 'eco' | 'night' | 'frost';
export type HeatBlockLevel = 'comfort' | 'eco' | 'night' | 'custom';
export interface HeatBlock {
  from: string;
  to: string;
  days: PlanDays;
  level: HeatBlockLevel;
  /** used when level is 'custom' */
  temp: number;
}
/** heating per room; durations in minutes (fractions allowed) */
export interface HeatPlan {
  v?: number;
  on: boolean;
  /** empty = all thermostats of the room */
  thermostats: string[];
  /** own room thermometer; null = the thermostat's reading */
  sensor: string | null;
  calibrate: 'auto' | 'offset' | 'target' | 'off';
  temps: Record<HeatLevel, number>;
  blocks: HeatBlock[];
  presence: { away: boolean; away_after: number; empty: boolean; empty_after: number; home_soon: boolean };
  sleep: boolean;
  guests: boolean;
  /** smart: until the circumstances really change (house mode, everyone leaves, room long empty, next change of the plan), at most manual_max hours */
  manual: 'smart' | 'next_block' | 'hours' | 'room_empty' | 'never';
  manual_hours: number;
  manual_max: number;
  /** contacts empty = all window contacts of the room; extra = more (doors, next room) */
  window: { on: boolean; contacts: string[]; extra: string[]; delay: number; resume: number; action: 'off' | 'frost'; drop: boolean; drop_k: number };
  /** learn: heat-up rate learned from the room, otherwise the fixed `rate` (°C per hour) */
  preheat: { on: boolean; max: number; learn?: boolean; rate?: number };
  vent: {
    on: boolean;
    times: string[];
    humidity_on: boolean;
    humidity: number;
    humidity_sensor: string | null;
    co2_on: boolean;
    co2: number;
    co2_sensor: string | null;
    mould: boolean;
    close: boolean;
    /** 0 = from the outside temperature */
    close_after: number;
    wait: number;
  };
  valves: { stuck: boolean };
  /** smart heating (smart_heat.py); missing = time plan */
  smart?: HeatSmart;
  /** sections with an own setting; all others follow the house-wide defaults (HeatingConfig.defaults) */
  own?: HeatSection[];
  /** only when saving: these sections go back to "wie im ganzen Haus" */
  reset?: HeatSection[];
}
/** settings a room takes from the house-wide defaults unless it has its own (heating.py SECTIONS) */
export type HeatSection = 'comfort' | 'temps' | 'presence' | 'modes' | 'manual' | 'window' | 'vent' | 'preheat' | 'style' | 'valve' | 'building' | 'shadow';
/** building type: prior for heating up and cooling down until the room model has learned enough */
export type HeatBuilding = 'unknown' | 'old' | 'partial' | 'new' | 'passive' | 'floor';
export type HeatStyle = 'comfort' | 'eco' | 'sport';
/** guardrails: they always win over the smart logic */
export interface HeatGuard {
  max: number;
  min: number;
  /** at least this with someone in the room */
  occupied_min: number;
  /** set back at most this far below comfort */
  max_setback: number;
  /** never heat above `min` in this time window */
  never: { on: boolean; from: string; to: string };
}
export interface HeatSmart {
  mode: 'schedule' | 'smart';
  style: HeatStyle;
  /** own ramp when warming up (null = the style's) */
  ramp: { step: number | null; minutes: number | null };
  shadow_days: number;
  /** shadow mode since (s); null = not in shadow mode */
  shadow_since: number | null;
  /** per-room overrides of the house-wide guardrails */
  guard: Partial<HeatGuard>;
  /** direct valve control (thermostats with writable valve entities) */
  valve: { on: boolean };
  radiator_w: number | null;
  area: number | null;
  building?: HeatBuilding;
  /** style version (2 = re-scaled: the old "Eco" is "Komfort" now) */
  sv?: number;
  /** room kind ("Raumart"): auto = detected from the Home Assistant area */
  room_type?: HeatRoomType;
  /** "Abends ausklingen": from `from` (null = an hour before the learned bedtime) until the night at most `temp` */
  evening?: { on: boolean; temp: number; from: string | null };
  /** "Kurz daheim": a usual stay of at most `hours` is heated only to `temp` */
  short?: { on: boolean; temp: number; hours: number };
}
export type HeatEnergyKind = 'auto' | 'gas' | 'oil' | 'heat_pump' | 'heat' | 'electric';
export interface HeatEnergyConfig {
  kind: HeatEnergyKind;
  /** null = from the energy dashboard */
  meter: string | null;
  /** € per kWh; null = from the energy dashboard */
  price: number | null;
  gas_kwh_m3: number;
  cop: number;
  efficiency: number;
}
export interface HeatGuardHit {
  guard: 'max' | 'min' | 'never' | 'occupied';
  wanted: number;
  got: number;
}
export interface HeatSmartStatus {
  mode: 'schedule' | 'smart';
  phase: 'schedule' | 'shadow' | 'active';
  style: HeatStyle;
  valve: { available: boolean; on: boolean; state: 'off' | 'on' | 'shadow' | 'none' | 'setpoint' | 'fallback' | 'window'; why: string; u: number | null; commands: number };
  shadow?: { since: number; days: number; left: number; ready: boolean };
  /** shadow mode: what the smart heating would do now */
  would?: { temp: number | null; why: string; level: string };
  confidence?: number | null;
  /** the reasons, in plain German */
  chain?: string[];
  guards?: HeatGuardHit[];
  next?: { at: string; temp: number; preheat?: string } | null;
  learned_days?: number;
  /** learning phase (too few learned days): heats by presence until the habits take over */
  learning?: boolean;
  building?: HeatBuilding;
  /** normal | short (bathroom, WC: short windows) | pass (hall: only passed through) */
  kind?: HeatRoomKind;
  /** the room kind with what it was detected from (smart_heat.kind_info) */
  room_type?: HeatRoomTypeInfo;
}
export type HeatRoomKind = 'normal' | 'short' | 'pass';
export type HeatRoomType = 'auto' | HeatRoomKind;
export interface HeatRoomTypeInfo {
  /** what counts (the setting, else the detected kind) */
  kind: HeatRoomKind;
  setting: HeatRoomType;
  /** detected */
  auto: HeatRoomKind;
  source: 'label' | 'icon' | 'name' | 'devices' | 'humidity' | 'usage' | 'default';
  /** what matched: the label, icon, name, device; number of days (humidity); median minutes (usage) */
  detail: string;
}
export interface HeatPlanSegment {
  from: string;
  to: string;
  temp: number;
  /** comfort | setback | night | preheat | custom | airing */
  level: string;
  why: string;
  confidence: number;
}
export interface HeatWindowLearned {
  from: string;
  to: string;
  mean: number;
  joined?: boolean;
  /** airing: learned from the window contacts or the prior from the heating assistant */
  source?: 'learned' | 'prior';
}
/** the learned plan of an intelligent room (house_rules/heating/plan) */
export interface HeatPlanView {
  room: string;
  kind: HeatRoomKind;
  room_type?: HeatRoomTypeInfo;
  phase: 'schedule' | 'shadow' | 'active';
  style: HeatStyle;
  building: HeatBuilding;
  today: HeatPlanSegment[];
  tomorrow: HeatPlanSegment[];
  windows: { today: HeatWindowLearned[]; tomorrow: HeatWindowLearned[] };
  airing: { today: HeatWindowLearned[]; tomorrow: HeatWindowLearned[]; pattern: { kind: 'stoss' | 'tilt' | 'mixed' | null; n: number; median_min: number | null }; days: number };
  model: { lead_min: number; lag_min: number; rate_now: number; learned: boolean; confidence: number; inert: boolean };
  learned_days: number;
  min_days: number;
  home_known: boolean;
  confidence: number;
  blocks: HeatBlock[];
}
export interface HeatAiring {
  /** aired in the morning after getting up; null = not asked yet */
  morning: boolean | null;
  minutes: number;
  /** empty = all rooms */
  rooms: string[];
}
export interface HeatEnergyPeriod {
  kwh: number;
  fuel_kwh: number;
  cost: number | null;
  saved_kwh: number;
  saved_cost: number | null;
  rooms: Record<string, { kwh: number; cost: number; saved_kwh: number; saved_cost: number }>;
}
export interface HeatEnergySummary {
  /** always an estimate */
  estimate: boolean;
  meter: { kind: HeatEnergyKind; entity: string | null; unit: string; price: number | null; price_unit: 'unit' | 'kWh'; source: 'energy' | 'manual' | null; label: string };
  from_meter: boolean;
  efficiency: number;
  today: HeatEnergyPeriod;
  week: HeatEnergyPeriod;
  month: HeatEnergyPeriod;
  radiator_w: Record<string, number>;
}
export interface HeatDecision {
  t: number;
  temp: number | null;
  level: string;
  why: string;
  chain: string[];
  confidence: number | null;
}
/** "So denkt deine Heizung" (house_rules/heating/explain) */
export interface HeatExplain {
  room: string;
  status: HeatSmartStatus | null;
  /** today, segments with the reason and how sure */
  today: { from: string; to: string; temp: number; level: string; why: string; confidence: number }[];
  /** learned occupancy: Monday … Sunday × 96 quarter hours in % */
  heatmap: number[][];
  habits: { wake: { work: string | null; free: string | null }; sleep: { work: string | null; free: string | null }; days: Record<string, number>; warm: number; since: string | null };
  days: number;
  decisions: HeatDecision[];
  guards: { t: number; guards: HeatGuardHit[] }[];
  forecast: { t: string; target: number; temp: number | null }[];
  /** rows: [time (s), real target, would, room temperature] per quarter hour */
  shadow: { rows: [number, number | null, number | null, number | null][]; kh_real: number; kh_would: number; saved_pct: number | null };
  model: { k_l: number; k_h: number; n_c: number; n_h: number; confidence: number; rate_now: number; heat_3k_min: number; cool_per_h: number; lag_min?: number; building?: HeatBuilding; k_d?: number; n_d?: number; k_w?: number; n_w?: number; door_per_h?: number | null; window_per_h?: number | null };
  energy: HeatEnergySummary;
  outside: number | null;
}
export interface HeatAssistantRoom {
  id: string;
  name: string;
  thermostats: string[];
  has_temp: boolean;
  valves: Record<string, { kind: 'pair' | 'single'; open?: string; close?: string; entity?: string }>;
  area: number | null;
  area_from_plan: boolean;
  /** suggested comfort temperature by the room's name */
  comfort: number;
  on: boolean;
  mode: 'schedule' | 'smart';
  style: HeatStyle;
  temps: Record<HeatLevel, number>;
  senses: boolean;
  building?: HeatBuilding;
  own?: HeatSection[];
  /** the room has window contacts (airing can be learned) */
  windows?: boolean;
  kind?: HeatRoomKind;
}
export interface HeatAssistant {
  rooms: HeatAssistantRoom[];
  energy: { detected: { kind?: HeatEnergyKind; meter?: string; price?: number | null; grid_price?: number | null }; meter: HeatEnergySummary['meter']; config: HeatEnergyConfig };
  guard: HeatGuard;
  airing?: HeatAiring;
  /** house-wide default style and building type */
  style?: HeatStyle;
  building?: HeatBuilding;
  /** learned wake-up times ("HH:MM" or null) */
  wake?: { work: string | null; free: string | null };
  setup_done: boolean;
  persons: number;
}
/** house-wide defaults: per section the same fields as in the room's plan */
export interface HeatDefaults {
  comfort: { comfort: number };
  temps: { base: number; eco: number; night: number; frost: number };
  presence: HeatPlan['presence'];
  modes: { sleep: boolean; guests: boolean };
  manual: { manual: HeatPlan['manual']; manual_hours: number; manual_max: number };
  window: Omit<HeatPlan['window'], 'contacts' | 'extra'>;
  vent: Omit<HeatPlan['vent'], 'times' | 'humidity_sensor' | 'co2_sensor'>;
  preheat: HeatPlan['preheat'];
  style: { style: HeatStyle; ramp: HeatSmart['ramp'] };
  valve: { valve: { on: boolean } };
  building: { building: HeatBuilding };
  shadow: { shadow_days: number };
}
export interface HeatThermostat {
  entity_id: string;
  name: string;
  available: boolean;
  mode: string | null;
  target: number | null;
  current: number | null;
  valve: number | null;
  valve_source: string | null;
  action: string | null;
  own_window: boolean;
  calibration: { entity: string; value: number | null } | null;
  correction: number;
}
export interface HeatVent {
  state: 'ok' | 'ventilate' | 'airing' | 'close_window' | 'off';
  reason: string;
  minutes: number;
  humidity: number | null;
  co2: number | null;
  outside: number | null;
  mould: number | null;
}
/** live status of a room's heating */
export interface HeatStatus {
  /** plain German, e.g. "Bad: 21 °C Komfort bis 22:00 · jetzt 19,5 °C · Ventil 40 % · heizt" */
  line: string;
  mode: 'heat' | 'off' | 'hands_off';
  /** target temperature */
  temp: number | null;
  level: string;
  why: string;
  until?: string | null;
  /** room temperature */
  current?: number | null;
  window?: { state: 'closed' | 'waiting' | 'open' | 'settling' | 'resumed'; since?: number; left?: number; names?: string; flapping?: boolean };
  valve?: number | null;
  heating?: boolean;
  reached?: boolean;
  manual?: { temp: number | null; off: boolean; at: number; who: string } | null;
  unreachable?: string[];
  thermostats?: HeatThermostat[];
  hints?: string[];
  vent?: HeatVent;
  rate?: number;
  rate_learned?: boolean;
  preheat?: string | null;
  smart?: HeatSmartStatus;
}
export interface HeatingConfig {
  outside: string | null;
  summer: { on: boolean; above: number; hold: number };
  demand: { on: boolean; entity: string | null; above: number; min_on: number; min_off: number };
  exercise: { on: boolean; weekday: number; time: string; minutes: number };
  notify: string[];
  quiet: { on: boolean; from: string; to: string };
  gap: number;
  smart?: { guard: HeatGuard; energy: HeatEnergyConfig; airing?: HeatAiring; setup_done: boolean };
  /** house-wide defaults of the room settings, per section */
  defaults?: HeatDefaults;
}
/** what a room has (suggestions; the user confirms) */
export interface HeatFound {
  thermostats: string[];
  sensors: string[];
  contacts: string[];
  doors: string[];
  humidity: string[];
  co2: string[];
  valves: Record<string, string>;
  calibration: Record<string, string>;
  own_window: Record<string, string>;
}
export interface HeatingView {
  config: HeatingConfig;
  enabled: boolean;
  outside: { entity: string | null; name: string; value: number | null; auto: boolean };
  summer: boolean;
  demand: { on: boolean; why: string; wait: number | null };
  exercise_until: number | null;
  last_exercise: string | null;
  rooms: Record<string, HeatFound>;
}
/** Lampen abgleichen (lightcal.py): one lamp's corrections – per colour reference the hue/saturation it is sent,
 * per white reference the Kelvin, and a brightness factor */
export interface LightCalEntry {
  hs: Record<string, [number, number]>;
  k: Record<string, number>;
  bri: number;
}
export interface LightCalView {
  lights: Record<string, LightCalEntry>;
  /** reference colours: key → [hue, saturation] */
  colors: Record<string, [number, number]>;
  /** reference whites: key → Kelvin */
  whites: Record<string, number>;
}

/** when the Reinschau-Licht may glow at all: one setting for every room (glow.py) */
export interface GlowGlobal {
  dark: 'night' | 'dark' | 'time' | 'always';
  from: string;
  to: string;
  not_sleep: boolean;
  not_guests: boolean;
}

export interface PlansView {
  light: Record<string, LightPlan>;
  glow?: GlowGlobal;
  heat: Record<string, HeatPlan>;
  heating?: HeatingView;
  now: Record<string, { light: LightStatus | null; heat: HeatStatus | null }>;
}

export interface CleaningView {
  on: boolean;
  vacuums: string[];
  sensors: 'all' | string[];
  /** minutes after the robot is back */
  after: number;
  active: boolean;
  since: number | null;
  until: number | null;
}

export interface Resident {
  entity_id: string;
  name: string;
  counts: boolean;
  tracked: boolean;
  state: string;
}

export interface AlarmView {
  state: 'disarmed' | 'arming' | 'armed_away' | 'armed_night' | 'armed_home' | 'pending' | 'triggered';
  label: string;
  mode: AlarmMode | null;
  since: number;
  until: number | null;
  cause: string | null;
  cause_name: string | null;
  bypassed: string[];
  config: AlarmConfig;
  suggested: Record<AlarmMode, string[]>;
  silenced?: boolean;
  last_exception?: { at: number; sensor: string; reason: string } | null;
  /** right after a start of HA: sensors do not count yet, doors/windows are compared with before the restart */
  settling?: boolean;
  tones?: Record<string, string>;
  notify_services?: string[];
  sounds_url?: string;
}

export interface AiReview {
  verdict: 'ok' | 'hinweis' | 'problem';
  summary: string;
  notes: string[];
  improved?: Rule;
  improved_sentence?: string;
  model?: string;
}

export interface AiProvider {
  label: string;
  needs_url: boolean;
  needs_key: boolean;
  url?: string;
  hint: string;
}

export interface AiPublic {
  provider: string;
  url: string;
  model: string;
  has_key: boolean;
  key_hint: string;
  status?: 'ok' | 'error' | null;
  checked?: number;
  providers: Record<string, AiProvider>;
}

export type AutoMode = 'away' | 'sleep' | 'guests' | 'vacation';

/** optional own end of a mode: it stays until these hold (for the set time), also when set by hand */
export interface ModeEnd {
  on: boolean;
  when: Clause[];
  for: string;
}

/** Automatic house mode: for every mode the conditions under which it is chosen */
export interface ModeAutoView {
  enabled: boolean;
  modes: Record<AutoMode, { on: boolean; when: Clause[]; for: string; end?: ModeEnd }>;
  /** what the automatic would choose right now, and why */
  target: string | null;
  why: string;
  /** the mode was set by hand and is kept */
  held: boolean;
  /** "Aufstehen erkennen": ends "Schlafen" when getting up for the day was detected (absent in old backends) */
  wakeup?: WakeupView;
}

/** What the wakeup detection learned for one kind of day */
export interface WakeupLearned {
  /** usual get-up time, "HH:MM" … "HH:MM" */
  from: string;
  to: string;
  /** examples behind it (weighted) */
  n: number;
  /** minutes the bed must be empty */
  need: number;
  /** room most often occupied after getting up */
  room: string | null;
}

/** "Aufstehen erkennen" (settings in mode_auto.wakeup, what was learned stays in the backend) */
export interface WakeupView {
  on: boolean;
  action: 'direct' | 'ask';
  feedback: boolean;
  /** chosen bed sensors / rooms (empty = found automatically) */
  beds: string[];
  rooms: string[];
  found_beds: { entity_id: string; name: string }[];
  found_rooms: string[];
  learned: { work: WakeupLearned; free: WakeupLearned };
  detections: number;
  trips: number;
  /** what the detection waits for right now (only while the house sleeps) */
  status: string;
  last: { at: number; up: number; answer: string | null; conf: number } | null;
}

/** Parts of Hausregeln that can be switched off (Einstellungen → Funktionen). Off = stopped in the backend and hidden here. */
export type FeatureId = 'alarm' | 'light' | 'heating' | 'vacation' | 'mode_auto' | 'vacuum' | 'ai' | 'behaviours' | 'window_warning';
export type Features = Record<FeatureId, boolean>;

export type SetupStep = 'welcome' | 'people' | 'rooms' | 'rules' | 'features' | 'alarm' | 'windows' | 'light' | 'heating' | 'vacation' | 'vacuum' | 'ai' | 'tablet' | 'glow' | 'diagnostics' | 'done';

/** Setup wizard progress (kept in the integration, so it can be resumed on any device) */
export interface SetupView {
  done: boolean;
  step: SetupStep;
  answers: Record<string, any>;
  migrated?: boolean;
  /** the floor plan card (integration floorplan_card, part of roomwise) is installed */
  floorplan: boolean;
  /** the small assistant per feature: set up / put off / something configured already */
  assistants?: Partial<Record<AssistantId, AssistantState>>;
}

/** features with their own small assistant (heating has its own) */
export type AssistantId = 'light' | 'alarm' | 'window_warning' | 'vacation' | 'vacuum' | 'mode_auto';
export interface AssistantState {
  done: boolean;
  dismissed: boolean;
  configured: boolean;
  at: string | null;
}

export interface SetupDevice {
  entity_id: string;
  name: string;
  kind?: string;
  room?: string | null;
  guess?: boolean;
}

/** What the wizard proposes from the real home (house_rules/setup/suggest) */
export interface SetupSuggest {
  residents: Resident[];
  persons: Person[];
  rooms: { id: string; name: string; icon: string; presence: string[]; motion: string[]; candidates: SetupDevice[]; lights: string[]; climate: string[]; doors: string[]; door_logic: boolean }[];
  alarm: { away: SetupDevice[]; night: string[]; home: string[]; sirens: SetupDevice[]; players: SetupDevice[]; cameras: SetupDevice[] };
  vacuums: SetupDevice[];
  window_warning: { doors: SetupDevice[]; windows: SetupDevice[]; lights: SetupDevice[] };
  examples: { id: string; title: string; why: string; rule: Rule; sentence: string }[];
  floorplan: boolean;
  features: Features;
}

/** Fenster-Warnung beim Gehen (feature "window_warning", house_rules/window_warning/*) */
export interface WindowWarningConfig {
  doors: string[];
  windows: 'all' | string[];
  only_last: boolean;
  delay: number;
  timeout: number;
  blink: boolean;
  lights: { mode: 'none' | 'red' | 'flash'; entities: string[] };
  ack_entity: string;
  announce: { mode: 'none' | 'general' | 'all' | 'sequential'; players: string[]; tts: string; language: string; texts: { general: string; all: string; single: string } };
  notify: { on: boolean; persons: 'everyone' | string[] };
  users: string[];
  imported: { from: string; at: string } | null;
}
export interface WindowWarningView {
  on: boolean;
  active: boolean;
  phase: 'alarm' | 'linger' | null;
  door: string | null;
  windows: string[];
  names: string[];
  since: number | null;
  deadline: number | null;
  spoken: boolean;
  config: WindowWarningConfig;
  doors: string[];
  suggested_doors: string[];
}
