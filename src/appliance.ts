import type { FurnitureConfig, HassEntity, HomeAssistant } from './types';
import { carDeviceEntities } from './car-info';
import { entityKey } from './vehicles';
import { numOf } from './models';

/**
 * Washing machine, dryer, dishwasher: how long it still needs, and "done" until somebody has seen it.
 *
 * The values come from the entities of the linked device (Home Connect, Miele, SmartThings, LG ThinQ … name them
 * alike), found by role like the car (car-info.ts); `entities[role]` links one by hand, `exclude` leaves a detected
 * one out. Without a maker's integration a smart plug with power metering does: running above `run_w`, done once it
 * stayed below `idle_w` for `off_min` minutes after a run.
 *
 * "Done" is worked out from the states and their history (the same on every screen) and lasts until the door opens
 * after the end, somebody taps "Gesehen" (shared through the companion, else in this browser) or `hold` hours pass.
 */
export const APPLIANCE_KINDS = new Set(['washer', 'dryer', 'dishwasher']);
export const isAppliance = (f: FurnitureConfig, kind: string | undefined) => !!kind && APPLIANCE_KINDS.has(kind) && !!(f.entity || f.entities);

export type ApplianceRole = 'state' | 'end' | 'remaining' | 'progress' | 'program' | 'door' | 'running' | 'power' | 'switch';
export const APPLIANCE_ROLES: ApplianceRole[] = ['state', 'end', 'remaining', 'progress', 'program', 'door', 'running', 'power', 'switch'];
/** further values shown in the popup (temperature, spin speed, phase …): found by name, or added by hand (`extra`) */
const INFO = /temperatur|temperature|spin|schleuder|(^|_)phase($|_)|drying|trocken|dry_level|eco|water_forecast|energy_forecast|wasserverbrauch|energieverbrauch|rinse|spuel|detergent|dosier|i_dos|salt|salz|rinse_aid|klarspueler|delay|startzeit|start_time/;
export const APPLIANCE_ICON: Record<ApplianceRole, string> = {
  state: 'mdi:list-status',
  end: 'mdi:clock-check-outline',
  remaining: 'mdi:timer-sand',
  progress: 'mdi:progress-clock',
  program: 'mdi:format-list-bulleted',
  door: 'mdi:door',
  running: 'mdi:play-circle-outline',
  power: 'mdi:flash',
  switch: 'mdi:power',
};

interface RoleDef {
  key: ApplianceRole;
  domains: string[];
  re?: RegExp;
  not?: RegExp;
  dc?: string[];
}

const TIME = /remaining|restzeit|rest_zeit|verbleibend|time_left|remain|countdown|finish|fertig|completion|end_time|endzeit|programmende|program_end|ende/;
/** Order matters: the more specific roles first, every entity is used once */
const ROLES: RoleDef[] = [
  // a point in time (Home Connect's remaining_program_time, SmartThings' completion_time …)
  { key: 'end', domains: ['sensor'], re: TIME, dc: [] },
  { key: 'remaining', domains: ['sensor'], re: TIME, not: /energy|water|kwh/ },
  { key: 'progress', domains: ['sensor'], re: /progress|fortschritt/ },
  { key: 'door', domains: ['binary_sensor', 'sensor'], re: /(^|_)(door|tuer|tur|lid|deckel|klappe|luke)($|_)/, dc: ['door', 'opening'] },
  { key: 'running', domains: ['binary_sensor'], re: /running|laeuft|in_operation|in_betrieb|(^|_)active($|_)|(^|_)run($|_)/, dc: ['running'] },
  { key: 'state', domains: ['sensor', 'select'], re: /operation_state|operationstate|machine_state|run_state|job_state|(^|_)status($|_)|(^|_)state($|_)|zustand|betriebszustand|programmstatus|current_status|(^|_)phase($|_)|washer_state|dryer_state|dishwasher_state/, not: /door|tuer|remote|power_state|wifi|signal|connect|online|child|lock|water|detergent|rinse_aid|salt/ },
  { key: 'program', domains: ['sensor', 'select'], re: /program|programm|(^|_)cycle($|_)|(^|_)course($|_)|(^|_)mode($|_)/, not: /progress|remaining|time|zeit|start|end/ },
  { key: 'power', domains: ['sensor'], dc: ['power'], re: /(^|_)(power|leistung|watt|current_consumption)($|_)/, not: /energy|kwh|factor|apparent|reactive/ },
  // on / off or start: the plug, the machine's power switch, its start button
  { key: 'switch', domains: ['switch', 'button'], re: /(^|_)(power|start|ein_aus|on_off|an_aus|switch|steckdose|plug|outlet)($|_)|start_program|programm_starten/, not: /child|lock|sperre|light|licht|led|sound|ton|wifi|remote/ },
];

export interface ApplianceRoles {
  roles: Partial<Record<ApplianceRole, string>>;
  auto: Set<ApplianceRole>;
  /** further values: added by hand (`extra`) and found by name (not excluded) */
  info: { entity: string; name?: string; icon?: string; auto: boolean }[];
  /** all entities of the device (excluded ones left out) */
  ids: string[];
}

const roleCache = new WeakMap<object, WeakMap<FurnitureConfig, ApplianceRoles>>();

/** The roles of a washer's device: explicit links win, the rest is found by name and device class */
export function applianceRoles(hass: HomeAssistant, f: FurnitureConfig, get?: (id: string) => HassEntity | undefined): ApplianceRoles {
  const reg = hass.entities;
  let byPiece = reg ? roleCache.get(reg) : undefined;
  const hit = byPiece?.get(f);
  if (hit) return hit;
  const excluded = new Set(f.exclude ?? []);
  const ids = carDeviceEntities(hass, f).filter((id) => !excluded.has(id));
  const roles: Partial<Record<ApplianceRole, string>> = {};
  const auto = new Set<ApplianceRole>();
  for (const [k, v] of Object.entries(f.entities ?? {})) if (v && (APPLIANCE_ROLES as string[]).includes(k)) roles[k as ApplianceRole] = v;
  const used = new Set(Object.values(roles));
  for (const r of ROLES) {
    if (roles[r.key]) continue;
    const found = ids.find((id) => {
      if (used.has(id) || !r.domains.includes(id.split('.')[0])) return false;
      const s = hass.states[id];
      const dc = String(s?.attributes.device_class ?? '');
      const key = entityKey(hass, id);
      if (r.key === 'end') return dc === 'timestamp' && TIME.test(key);
      if (r.key === 'remaining' && dc === 'timestamp') return false;
      if (r.not?.test(key)) return false;
      return (!!r.re && r.re.test(key)) || (!!r.dc?.length && r.dc.includes(dc));
    });
    if (found) {
      roles[r.key] = found;
      auto.add(r.key);
      used.add(found);
    }
  }
  // the linked entity itself: a plug's switch has its power on the same device; a state sensor is the state
  const main = f.entity ? (get?.(f.entity) ?? hass.states[f.entity]) : undefined;
  const watts = !!main && (main.attributes.device_class === 'power' || /^k?w$/i.test(String(main.attributes.unit_of_measurement ?? '')));
  if (!roles.power && f.entity?.startsWith('sensor.') && !used.has(f.entity) && watts) roles.power = f.entity;
  if (!roles.state && f.entity && /^(sensor|select)\./.test(f.entity) && !used.has(f.entity) && !watts && isNaN(parseFloat(main?.state ?? ''))) roles.state = f.entity;
  if (!roles.switch && f.entity && /^switch\./.test(f.entity) && !used.has(f.entity)) roles.switch = f.entity;
  for (const id of Object.values(roles)) used.add(id!);
  const extraIds = new Set((f.extra ?? []).map((x) => x.entity));
  const info = [
    ...(f.extra ?? []).map((x) => ({ entity: x.entity, name: x.name, icon: x.icon, auto: false })),
    ...ids
      .filter((id) => !used.has(id) && !extraIds.has(id) && /^(sensor|binary_sensor|select|number)\./.test(id) && hass.entities?.[id]?.entity_category !== 'diagnostic' && INFO.test(entityKey(hass, id)))
      .slice(0, 8)
      .map((entity) => ({ entity, auto: true })),
  ];
  const out = { roles, auto, info, ids };
  if (reg) {
    if (!byPiece) roleCache.set(reg, (byPiece = new WeakMap()));
    byPiece.set(f, out);
  }
  return out;
}

export type AppliancePhase = 'idle' | 'running' | 'paused' | 'done';

const RUN = /run|running|in_progress|inprogress|in_use|(^|_)active($|_)|wash|rinse|rinsing|spin|drying|(^|_)dry($|_)|cooling|heating|laeuft|lauft|waschen|spuelen|schleudern|trocknen|reinigen|cleaning|anti_crease|knitterschutz|steam|main_wash|pre_wash/;
const DONE = /finish|finished|complete|completed|(^|_)end($|_)|ended|(^|_)done($|_)|fertig|beendet|abgeschlossen|program_ended|programmende|unload/;
const PAUSE = /pause|paused|pausiert|action_required|aktion_erforderlich/;
const IDLE = /off|aus|inactive|inaktiv|ready|bereit|idle|standby|stop|stopped|unavailable|unknown|none|programmed|waiting|delayed|verzoegert|power_off|not_running|abort|error|fehler|failure/;

const norm = (v: string) => v.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_');

/** What a state value says: running / paused / done / idle (unknown texts: idle) */
export function stateKind(v: string | undefined): AppliancePhase {
  const n = norm(v ?? '');
  if (!n) return 'idle';
  if (DONE.test(n)) return 'done';
  if (PAUSE.test(n)) return 'paused';
  if (IDLE.test(n)) return 'idle';
  if (RUN.test(n)) return 'running';
  return 'idle';
}

/** Minutes from a duration state: 42 (min), 0.7 (h), 2520 (s), "1:05" / "1:05:00" */
export function minutesOf(s: HassEntity | undefined): number | undefined {
  if (!s || s.state === 'unknown' || s.state === 'unavailable') return undefined;
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s.state.trim());
  if (m) return m[3] != null ? +m[1] * 60 + +m[2] + +m[3] / 60 : +m[1] * 60 + +m[2];
  const v = parseFloat(s.state);
  if (isNaN(v)) return undefined;
  const u = String(s.attributes.unit_of_measurement ?? 'min').toLowerCase();
  if (u === 's' || u.startsWith('sec')) return v / 60;
  if (u === 'h' || u.startsWith('hour') || u.startsWith('std')) return v * 60;
  return v;
}

const ts = (s: string | undefined) => (s ? Date.parse(s) : NaN);

export interface ApplianceLive {
  phase: AppliancePhase;
  /** minutes still to go (counted down between two updates) */
  mins?: number;
  /** when it will be done (ms) */
  endAt?: number;
  progress?: number;
  program?: string;
  door?: boolean;
  power?: number;
  /** when it finished (ms); with phase "done" */
  finishedAt?: number;
  roles: Partial<Record<ApplianceRole, string>>;
}

/** Thresholds of the plug fallback and how long "done" is shown */
export function applianceOpts(f: FurnitureConfig, kind: string | undefined) {
  const a = f.appliance ?? {};
  return {
    runW: a.run_w ?? 15,
    idleW: a.idle_w ?? 5,
    // a dishwasher dries for a long time with hardly any power
    offMin: a.off_min ?? (kind === 'dishwasher' ? 20 : 5),
    holdH: a.hold ?? 2,
  };
}

type Get = (id: string) => HassEntity | undefined;

/** Everything the plan and the popup show about one appliance, right now */
export function applianceLive(hass: HomeAssistant, f: FurnitureConfig, kind: string | undefined, get: Get, now = Date.now()): ApplianceLive {
  const { roles } = applianceRoles(hass, f, get);
  const o = applianceOpts(f, kind);
  const st = (r: ApplianceRole) => (roles[r] ? get(roles[r]!) : undefined);
  const stateE = st('state');
  const doorE = st('door');
  const door = doorE ? ['on', 'open', 'offen', 'true'].includes(norm(doorE.state)) : undefined;
  const program = st('program');
  const prog = numOf(st('progress'));
  const power = numOf(st('power'));
  let phase: AppliancePhase = 'idle';
  let finishedAt: number | undefined;
  if (stateE && stateE.state !== 'unavailable' && stateE.state !== 'unknown') {
    phase = stateKind(stateE.state);
    if (phase === 'done') finishedAt = ts(stateE.last_changed);
  } else if (st('running')) phase = st('running')!.state === 'on' ? 'running' : 'idle';
  // the end as a point in time, or the minutes left (counted down from their last update)
  let endAt: number | undefined;
  const endE = st('end');
  if (endE) {
    const e = ts(endE.state);
    if (!isNaN(e)) endAt = e;
  }
  const rem = minutesOf(st('remaining'));
  if (endAt == null && rem != null && rem > 0) endAt = ts(st('remaining')!.last_updated ?? st('remaining')!.last_changed) + rem * 60000;
  const hasState = !!stateE || !!st('running');
  if (!hasState) {
    if (endAt != null && endAt > now) phase = 'running';
    else if (power != null && power > o.runW) phase = 'running';
  }
  let mins: number | undefined;
  if (phase === 'running' && endAt != null) mins = Math.max(0, Math.ceil((endAt - now) / 60000));
  else if (phase === 'paused' && rem != null) mins = Math.ceil(rem);
  return { phase, mins, endAt: phase === 'running' ? endAt : undefined, progress: prog, program: program && !['unknown', 'unavailable', 'none', ''].includes(program.state) ? program.state : undefined, door, power, finishedAt, roles };
}

/** The entity whose history says when the last run ended, and how to read it */
function runSource(live: ApplianceLive, o: ReturnType<typeof applianceOpts>): RunSource | undefined {
  const r = live.roles;
  if (r.state) return { id: r.state, running: (s) => ['running', 'paused'].includes(stateKind(s)), done: (s) => stateKind(s) === 'done' };
  if (r.running) return { id: r.running, running: (s) => s === 'on' };
  if (r.power) return { id: r.power, running: (s) => parseFloat(s) > o.runW };
  return undefined;
}

interface RunSource {
  id: string;
  running: (s: string) => boolean;
  /** the source can say "finished" itself (a state sensor) */
  done?: (s: string) => boolean;
}

interface HistHit {
  /** last_changed of the source when fetched */
  key: string;
  at: number;
  /** end of the last run (ms) and whether the power still counts as within that run (a dip) */
  end?: number;
  dip?: boolean;
}

const ACK_KEY = 'fp-appliance-ack';

/**
 * Shared watcher (one per page): the history lookups behind "done", the "Gesehen" marks and a clock that redraws
 * the plan every 30 s while something runs or is done. Listeners redraw when anything changes.
 */
class ApplianceWatch {
  /** the current Home Assistant (set by the plan): the live look of the pieces (furniture-fx) needs the registry */
  hass?: HomeAssistant;
  private hist = new Map<string, HistHit>();
  private loading = new Set<string>();
  private acks: Record<string, number> = {};
  private acksAt = 0;
  private listeners = new Set<() => void>();
  private wanting = new Set<() => void>();
  private timer?: number;

  constructor() {
    try {
      this.acks = JSON.parse(localStorage.getItem(ACK_KEY) ?? '{}') ?? {};
    } catch {
      this.acks = {};
    }
  }

  listen(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
      this.clock(cb, false);
    };
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  /** the 30 s redraw while something runs or waits to be seen (on as long as one listener wants it) */
  clock(who: () => void, on: boolean) {
    if (on) this.wanting.add(who);
    else this.wanting.delete(who);
    if (this.wanting.size && !this.timer) this.timer = window.setInterval(() => this.changed(), 30000);
    else if (!this.wanting.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  ackOf(id: string): number {
    return this.acks[id] ?? 0;
  }

  /** "Gesehen": shared through the companion when it is there, always in this browser too */
  ack(hass: HomeAssistant | undefined, id: string, at = Date.now()) {
    this.acks[id] = at;
    this.saveLocal();
    hass?.callWS({ type: 'floorplan_card/appliance/ack', piece_id: id }).catch(() => {});
    this.changed();
  }

  private saveLocal() {
    try {
      const keep = Object.entries(this.acks).filter(([, t]) => Date.now() - t < 7 * 86400000);
      localStorage.setItem(ACK_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {
      /* private window */
    }
  }

  /** the companion's marks, at most once a minute */
  syncAcks(hass: HomeAssistant | undefined) {
    if (!hass || Date.now() - this.acksAt < 60000) return;
    this.acksAt = Date.now();
    hass
      .callWS<Record<string, number>>({ type: 'floorplan_card/appliance/acks' })
      .then((res) => {
        let any = false;
        for (const [id, sec] of Object.entries(res ?? {})) {
          const t = Number(sec) * 1000;
          if (t > (this.acks[id] ?? 0)) {
            this.acks[id] = t;
            any = true;
          }
        }
        if (any) {
          this.saveLocal();
          this.changed();
        }
      })
      .catch(() => {});
  }

  /** End of the last run from the source's history (cached until the source changes, at most once a minute) */
  lastRun(hass: HomeAssistant, src: RunSource, hours: number, offMin: number): HistHit | undefined {
    const s = hass.states[src.id];
    const key = `${s?.last_changed ?? ''}|${s?.state ?? ''}`;
    const hit = this.hist.get(src.id);
    if (hit && hit.key === key && Date.now() - hit.at < 60000) return hit;
    if (!this.loading.has(src.id)) {
      this.loading.add(src.id);
      const start = new Date(Date.now() - Math.max(1, hours + 1) * 3600000).toISOString();
      hass
        .callWS<Record<string, { s: string; lu?: number; lc?: number }[]>>({
          type: 'history/history_during_period',
          start_time: start,
          entity_ids: [src.id],
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        })
        .then((res) => {
          const rows = (res?.[src.id] ?? []).map((x) => ({ s: String(x.s), t: Number(x.lu ?? x.lc ?? 0) * 1000 })).filter((x) => x.t > 0);
          this.hist.set(src.id, { key, at: Date.now(), ...lastRunEnd(rows, src.running, offMin, Date.now(), src.done) });
        })
        .catch(() => this.hist.set(src.id, { key, at: Date.now() }))
        .finally(() => {
          this.loading.delete(src.id);
          this.changed();
        });
    }
    return hit;
  }
}

/** From a history (oldest first): when the last run ended — after at least 3 minutes running, and once the
 * source stayed off for `offMin` (a washer pausing to soak, a dishwasher drying, is still within the run) */
export function lastRunEnd(rows: { s: string; t: number }[], running: (s: string) => boolean, offMin: number, now = Date.now(), done?: (s: string) => boolean): { end?: number; dip?: boolean } {
  let lastOn = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (running(rows[i].s)) {
      lastOn = i;
      break;
    }
  if (lastOn < 0 || lastOn === rows.length - 1) return {};
  // where that run began (short gaps below offMin belong to it)
  let first = lastOn;
  for (let i = lastOn - 1; i >= 0; i--) {
    if (running(rows[i].s)) first = i;
    else if (rows[i + 1] && rows[i + 1].t - rows[i].t > offMin * 60000) break;
  }
  const end = rows[lastOn + 1].t;
  if (end - rows[first].t < 3 * 60000) return {};
  // a state that said "finished" itself and then went back to idle: somebody dealt with it already
  if (done && rows.slice(lastOn + 1).some((x) => done(x.s))) return {};
  if (now - end < offMin * 60000) return { dip: true };
  return { end };
}

export const applianceWatch = typeof window !== 'undefined' ? new ApplianceWatch() : (undefined as unknown as ApplianceWatch);

/**
 * The live state with "done" worked out completely: from the state itself, or from the history of the run source;
 * "done" ends when the door was opened after the end, somebody marked it as seen, or `hold` hours passed.
 */
export function applianceStatus(hass: HomeAssistant, f: FurnitureConfig, kind: string | undefined, get: Get, now = Date.now()): ApplianceLive {
  const live = applianceLive(hass, f, kind, get, now);
  const o = applianceOpts(f, kind);
  if (live.phase === 'idle') {
    const src = runSource(live, o);
    const hit = src && applianceWatch?.lastRun(hass, src, o.holdH || 24, src.id === live.roles.power ? o.offMin : 0);
    if (hit?.dip && src?.id === live.roles.power) live.phase = 'running';
    else if (hit?.end) {
      live.phase = 'done';
      live.finishedAt = hit.end;
    }
  }
  if (live.phase === 'done') {
    const end = live.finishedAt ?? now;
    const doorE = live.roles.door ? get(live.roles.door) : undefined;
    const doorAfter = !!doorE && ts(doorE.last_changed) > end + 5000;
    const seen = (applianceWatch?.ackOf(f.id) ?? 0) >= end;
    const old = o.holdH > 0 && now - end > o.holdH * 3600000;
    if (doorAfter || seen || old) live.phase = 'idle';
  }
  return live;
}
