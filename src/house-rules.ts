/**
 * Hausregeln (custom integration `house_rules`, see house-rules/docs/API.md) — optional.
 *
 * The card checks once whether it is installed (`house_rules/info`); without it nothing here does anything and
 * the card works as before. With it, one live subscription per Home Assistant connection (shared by every card)
 * keeps: house mode, alarm, room occupancy, rules — and reports runs (`history_add`) so the plan can pulse the
 * devices involved. The integration's own UI elements (`<house-rules-device>`, `<house-rules-editor>`) are loaded
 * on demand from `/house_rules_static/house-rules-panel.js`.
 *
 * One source for what both know: with Hausregeln, a room's lights and thermostat come from Hausregeln' room
 * assignment (its device list with corrections, the heating plan's thermostats and thermometer) and a person's
 * phone from its person list – nothing is set up twice. See `hrRoom()` and `hrPhone()`.
 */
import type { FloorplanCardConfig, HomeAssistant, RoomConfig } from './types';

export type HrMode = 'home' | 'away' | 'sleep' | 'vacation' | 'guests';
export const HR_MODES: HrMode[] = ['home', 'away', 'sleep', 'vacation', 'guests'];

export interface HrAlarm {
  state: 'disarmed' | 'arming' | 'armed_away' | 'armed_night' | 'armed_home' | 'pending' | 'triggered' | string;
  label?: string;
  mode?: string | null;
  since?: string | null;
  /** end of the countdown (unix seconds) */
  until?: number | null;
  cause?: string | null;
  cause_name?: string | null;
}

export interface HrClause {
  subject: string;
  verb: string;
  [k: string]: unknown;
}

export interface HrRule {
  id: string;
  name: string;
  type: 'when' | 'while';
  when: HrClause[];
  and: HrClause[];
  then: HrClause[];
  only: HrClause[];
  enabled: boolean;
  paused_until?: string | null;
  options?: Record<string, unknown>;
  tags?: string[];
  meta?: { runs_week?: number; last_run?: string | null; [k: string]: unknown };
}

export interface HrOccupancy {
  occupied: boolean;
  since?: string | null;
  by?: string | null;
  dark?: boolean;
}

/** Fenster-Warnung beim Gehen as Hausregeln runs it (house_rules/window_warning/get) */
export interface HrWindowWarning {
  on: boolean;
  active: boolean;
  phase: 'alarm' | 'linger' | null;
  /** open windows (entity ids) */
  windows: string[];
  /** when the announcement comes (Unix seconds) */
  deadline?: number | null;
  spoken?: boolean;
  /** its settings (only `blink` matters to the card: open windows pulse red) */
  config?: { blink?: boolean };
}

/** What Hausregeln knows about one room (an HA area): its lights, thermostats, own thermometer */
export interface HrRoomDevices {
  lights: string[];
  climates: string[];
  /** the heating plan's room thermometer (null: the thermostat's reading) */
  sensor?: string | null;
}

/** Wo ist wer (snapshot part `places`): the status line per person, made by Hausregeln */
export interface HrPlacePerson {
  entity_id: string;
  name: string;
  picture?: string | null;
  state: 'zone' | 'place' | 'stay' | 'moving' | 'unknown';
  place?: string | null;
  /** "Arbeit · seit 8:12", "Unterwegs · wahrscheinlich nach Hause · ca. 12 Min." */
  line: string;
  /** ISO: in the zone / at the place / on the way since */
  since?: string | null;
  speed_kmh?: number | null;
  /** while on the way: walk / bike / car / transit, null when not sure */
  mode?: 'walk' | 'bike' | 'car' | 'transit' | null;
  mode_confidence?: number;
  /** ISO: the newest position */
  updated?: string | null;
  /** eta_min: left now; arrive_at / as_of (seconds): the arrival estimated at the last position, and when that was */
  prediction?: { destination: string; name?: string | null; probability?: number; eta_min?: number | null; arrive_at?: number | null; as_of?: number | null; distance_km?: number | null } | null;
}

export interface HrState {
  mode?: HrMode;
  alarm?: HrAlarm;
  /** which parts of Hausregeln are switched on (alarm, light, heating, window_warning …) */
  features?: Record<string, boolean>;
  windowWarning?: HrWindowWarning;
  places?: { persons: HrPlacePerson[] };
  occupancy: Record<string, HrOccupancy>;
  rules: HrRule[];
  /** Solange rules in force: rule id → instances */
  active: Record<string, string[]>;
  admin: boolean;
}

/** Which devices a rule touches, per part (placeholders resolved) */
export interface HrRuleEntities {
  when: { subject: string; entities: string[]; room?: string | null }[];
  and: { subject: string; entities: string[]; room?: string | null }[];
  then: { subject: string; entities: string[]; room?: string | null }[];
  only: { subject: string; entities: string[]; room?: string | null }[];
}

export interface HrForEntity {
  starts: string[];
  checks: string[];
  switches: string[];
}

/** Colours of the sentence parts (API.md 2.7): light / dark */
export const HR_COLORS = {
  when: ['#f08a00', '#ff9f0a'],
  while: ['#a24fd6', '#c77dff'],
  and: ['#1a9fb5', '#40c8e0'],
  then: ['#007aff', '#3d9bff'],
  only: ['#5856d6', '#8e8cff'],
} as const;
export const hrColor = (part: keyof typeof HR_COLORS, dark = false) => HR_COLORS[part][dark ? 1 : 0];

type Listener = (s: HrState) => void;
type PulseListener = (entities: string[], kind: string) => void;

class HouseRulesLink {
  available?: boolean;
  state: HrState = { occupancy: {}, rules: [], active: {}, admin: false };
  private listeners = new Set<Listener>();
  private pulses = new Set<PulseListener>();
  private starting?: Promise<boolean>;
  private unsub?: () => Promise<void> | void;
  private forEntityCache = new Map<string, Promise<HrForEntity | undefined>>();
  hass: HomeAssistant;
  /** HA area → what Hausregeln assigns to it; changes only when its device list or heating plans change */
  rooms = new Map<string, HrRoomDevices>();
  /** counts up whenever `rooms` changed (caches compare it) */
  roomsVersion = 0;
  /** person entity → notify service of the phone Hausregeln found for it */
  phones = new Map<string, string>();
  private devices: { entity_id: string; kind: string; room?: string | null }[] = [];
  private heat: Record<string, { on?: boolean; thermostats?: string[]; sensor?: string | null }> = {};
  private roomsKey = '';

  constructor(hass: HomeAssistant) {
    this.hass = hass;
  }

  /** Detect the integration and subscribe (once); resolves to whether it is there */
  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const info = await this.hass.callWS<{ version: string; api: number; loaded: boolean }>({ type: 'house_rules/info' }).catch(() => null);
      this.available = !!info?.loaded && info.api === 1;
      if (!this.available) return false;
      this.state.admin = !!this.hass.user?.is_admin;
      try {
        this.unsub = await this.hass.connection.subscribeMessage<Record<string, any>>((msg) => this.onMessage(msg), { type: 'house_rules/subscribe' });
      } catch {
        this.available = false;
      }
      return !!this.available;
    })();
    return this.starting;
  }

  private onMessage(msg: Record<string, any>) {
    if (msg.kind === 'history_add') {
      const e = msg.entry ?? {};
      const ents: string[] = [...(e.entities ?? []), ...(e.entity_id ? [e.entity_id] : [])];
      if (ents.length && e.kind !== 'skipped') for (const p of this.pulses) p([...new Set(ents)], e.kind ?? 'rule');
      return;
    }
    if (msg.kind !== 'snapshot' && msg.kind !== 'update') return;
    const s = { ...this.state };
    if ('mode' in msg) s.mode = msg.mode;
    if ('alarm' in msg) s.alarm = msg.alarm;
    if ('occupancy' in msg) s.occupancy = msg.occupancy ?? {};
    if ('rules' in msg) {
      s.rules = msg.rules ?? [];
      this.forEntityCache.clear();
    }
    if ('active' in msg) s.active = msg.active ?? {};
    if ('features' in msg) s.features = msg.features ?? undefined;
    if ('window_warning' in msg) s.windowWarning = msg.window_warning ?? undefined;
    if ('devices' in msg || 'plans' in msg) {
      if ('devices' in msg) this.devices = Array.isArray(msg.devices) ? msg.devices : [];
      if ('plans' in msg) this.heat = msg.plans?.heat ?? {};
      this.buildRooms();
    }
    if ('persons' in msg && Array.isArray(msg.persons))
      this.phones = new Map(msg.persons.filter((p: { entity_id?: string; phone?: string }) => p.entity_id && p.phone).map((p: { entity_id: string; phone: string }) => [p.entity_id, `notify.${p.phone}`]));
    if ('places' in msg) s.places = msg.places ?? undefined;
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  /** room → lights / thermostats / thermometer from Hausregeln' devices (with its corrections) and heating plans */
  private buildRooms() {
    const rooms = new Map<string, HrRoomDevices>();
    const get = (r: string) => rooms.get(r) ?? (rooms.set(r, { lights: [], climates: [] }), rooms.get(r)!);
    for (const d of this.devices) {
      if (!d.room) continue;
      if (d.kind === 'light') get(d.room).lights.push(d.entity_id);
      else if (d.kind === 'climate') get(d.room).climates.push(d.entity_id);
    }
    for (const [r, p] of Object.entries(this.heat)) {
      if (!p?.on) continue;
      // the heating plan's own choice wins (empty = every thermostat of the room)
      if (p.thermostats?.length) get(r).climates = [...p.thermostats];
      if (p.sensor) get(r).sensor = p.sensor;
    }
    const key = JSON.stringify([...rooms]);
    if (key === this.roomsKey) return;
    this.roomsKey = key;
    this.rooms = rooms;
    this.roomsVersion++;
  }

  listen(l: Listener): () => void {
    this.listeners.add(l);
    if (this.available) l(this.state);
    return () => this.listeners.delete(l);
  }

  onPulse(l: PulseListener): () => void {
    this.pulses.add(l);
    return () => this.pulses.delete(l);
  }

  /** Rules an entity starts / is checked in / is switched by (cached until the rules change) */
  forEntity(entityId: string): Promise<HrForEntity | undefined> {
    let p = this.forEntityCache.get(entityId);
    if (!p) {
      p = this.hass.callWS<HrForEntity>({ type: 'house_rules/for_entity', entity_id: entityId }).catch(() => undefined);
      this.forEntityCache.set(entityId, p);
    }
    return p;
  }

  ruleEntities(rule: HrRule): Promise<HrRuleEntities | undefined> {
    return this.hass.callWS<HrRuleEntities>({ type: 'house_rules/rule/entities', rule }).catch(() => undefined);
  }

  describe(rule: HrRule): Promise<string | undefined> {
    return this.hass
      .callWS<{ sentence: string }>({ type: 'house_rules/rule/describe', rule })
      .then((r) => r.sentence)
      .catch(() => undefined);
  }

  setMode(mode: HrMode): Promise<unknown> {
    return this.hass.callWS({ type: 'house_rules/mode/set', mode });
  }

  /** Hausregeln runs the window warning: the card shows it instead of its own */
  get windowWarningOn(): boolean {
    return !!this.available && this.state.features?.window_warning === true;
  }

  /** A tap on the tablet acknowledges Hausregeln' window warning (any user) */
  ackWindowWarning(): Promise<unknown> {
    return this.hass.callWS({ type: 'house_rules/window_warning/ack' });
  }

  /** Anonymous diagnostics: the browser / performance tier of this card (dropped unless the owner opted in) */
  reportClient(info: object): Promise<unknown> {
    return this.hass.callWS({ type: 'house_rules/telemetry/client', ...info });
  }

  setEnabled(ruleId: string, enabled: boolean): Promise<unknown> {
    return this.hass.callWS({ type: 'house_rules/rule/enable', rule_id: ruleId, enabled });
  }

  stop() {
    void this.unsub?.();
    this.unsub = undefined;
  }
}

const links = new WeakMap<object, HouseRulesLink>();

/** The shared link of this Home Assistant connection (keeps the newest hass for calls) */
export function houseRules(hass: HomeAssistant): HouseRulesLink {
  const key = hass.connection as unknown as object;
  let link = links.get(key);
  if (!link) {
    link = new HouseRulesLink(hass);
    links.set(key, link);
  } else link.hass = hass;
  return link;
}

export type { HouseRulesLink };

const hrRooms = new WeakMap<RoomConfig, { v: number; link: HouseRulesLink; room: RoomConfig }>();

/**
 * A plan room as shown: with Hausregeln, its lights and thermostat (and the heating plan's thermometer) are the
 * ones Hausregeln assigns to the room's HA area – the one place to change them. The card's own lists stay in the
 * configuration as the fallback without Hausregeln (or for a room Hausregeln has nothing for).
 */
export function hrRoom(room: RoomConfig, hass: HomeAssistant | undefined): RoomConfig {
  if (!hass?.connection || !room.area) return room;
  const link = links.get(hass.connection as unknown as object);
  if (!link?.available) return room;
  const hit = hrRooms.get(room);
  if (hit && hit.v === link.roomsVersion && hit.link === link) return hit.room;
  const hr = link.rooms.get(room.area);
  let out = room;
  if (hr && (hr.lights.length || hr.climates.length || hr.sensor)) {
    out = { ...room };
    if (hr.lights.length) out.lights = preferLamps(hass, hr.lights);
    if (hr.climates.length) out.climate = hr.climates[0];
    if (hr.sensor) out.temperature = hr.sensor;
  }
  hrRooms.set(room, { v: link.roomsVersion, link, room: out });
  return out;
}

/** The configuration as shown: every room through hrRoom(); the same object when Hausregeln changes nothing */
export function withHrRooms(cfg: FloorplanCardConfig, hass: HomeAssistant | undefined): FloorplanCardConfig {
  let changed = false;
  const floors = cfg.floors.map((f) => {
    const rooms = f.rooms.map((r) => hrRoom(r, hass));
    if (rooms.every((r, i) => r === f.rooms[i])) return f;
    changed = true;
    return { ...f, rooms };
  });
  return changed ? { ...cfg, floors } : cfg;
}

/** What Hausregeln assigns to a plan room's area (for the editor: shown instead of the card's own lists) */
export function hrRoomDevices(room: RoomConfig, hass: HomeAssistant): HrRoomDevices | undefined {
  if (!room.area) return undefined;
  const link = links.get(hass.connection as unknown as object);
  if (!link?.available) return undefined;
  const hr = link.rooms.get(room.area);
  return hr && (hr.lights.length || hr.climates.length || hr.sensor) ? { ...hr, lights: preferLamps(hass, hr.lights) } : undefined;
}

/** The phone (notify service) Hausregeln found for a person, if it runs */
export function hrPhone(hass: HomeAssistant, person: string): string | undefined {
  const link = links.get(hass.connection as unknown as object);
  return link?.available ? link.phones.get(person) : undefined;
}

/** Prefer real lamps over light groups when both are in the list (same as the card's own area suggestion) */
function preferLamps(hass: HomeAssistant, lights: string[]): string[] {
  const members = new Set(lights.flatMap((id) => (hass.states[id]?.attributes.entity_id as string[] | undefined) ?? []));
  return lights.filter((id) => !hass.states[id]?.attributes.entity_id || !lights.some((l) => members.has(l)));
}

const norm = (x: string) => x.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

/** The HA area of a plan room: its own setting, else an area of the same name */
export function roomArea(room: { area?: string; name?: string }, hass: HomeAssistant): string | undefined {
  if (room.area) return room.area;
  if (!room.name) return undefined;
  const n = norm(room.name);
  return Object.values(hass.areas ?? {}).find((a) => norm(a.name) === n)?.area_id;
}

/** A rule's sentence: from its switch (attribute `sentence`), else a short "Wenn … dann …" from its subjects */
export function ruleSentence(rule: HrRule, hass: HomeAssistant): string {
  for (const id in hass.states) {
    if (!id.startsWith('switch.')) continue;
    const a = hass.states[id].attributes;
    if (a.rule_id === rule.id && typeof a.sentence === 'string') return a.sentence;
  }
  const name = (c: HrClause) => (c.subject.includes('.') ? String(hass.states[c.subject]?.attributes.friendly_name ?? c.subject) : c.subject.replace(/^[a-z]+:/, ''));
  const when = rule.when.map(name).join(', ');
  const then = rule.then.map(name).join(', ');
  return `${rule.type === 'while' ? 'Solange' : 'Wenn'} ${when} → ${then}`;
}

let uiLoading: Promise<boolean> | undefined;
let HR_UI = '/house_rules_static/house-rules-panel.js';

/** Load the integration's UI elements once (house-rules-device, house-rules-editor …) */
export function loadHouseRulesUi(): Promise<boolean> {
  if (customElements.get('house-rules-device')) return Promise.resolve(true);
  if (!uiLoading)
    uiLoading = import(/* the bundler must leave it alone: */ HR_UI)
      .then(() => true)
      .catch((err) => {
        console.warn('floorplan-card: Hausregeln UI not available', err);
        uiLoading = undefined;
        return false;
      });
  return uiLoading;
}
