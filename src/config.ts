import { validMediaControls } from './media-controls';
import type { FloorConfig, FloorplanCardConfig, HassArea, HomeAssistant, Point, RoomConfig } from './types';
import { suggestForArea } from './ha';
import { t } from './i18n';

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/** Deep-copies (HA hands us frozen objects) and fills in defaults/ids. Accepts a single-floor shorthand. */
export function normalizeConfig(input: FloorplanCardConfig & { rooms?: RoomConfig[]; devices?: any[] }): FloorplanCardConfig {
  const cfg: any = JSON.parse(JSON.stringify(input));
  if (!Array.isArray(cfg.floors)) {
    cfg.floors = [{ id: 'floor_1', name: t('card.default_floor'), rooms: cfg.rooms ?? [], devices: cfg.devices ?? [] }];
    delete cfg.rooms;
    delete cfg.devices;
  }
  if (!cfg.floors.length) cfg.floors.push({ id: 'floor_1', name: t('card.default_floor'), rooms: [], devices: [] });
  const seen = new Set<string>();
  const ensureId = (o: any, prefix: string) => {
    if (!o.id || seen.has(o.id)) o.id = uid(prefix);
    seen.add(o.id);
  };
  for (const f of cfg.floors as FloorConfig[]) {
    ensureId(f, 'floor');
    f.name ??= t('editor.floor');
    f.rooms = (f.rooms ?? []).filter((r) => Array.isArray(r.points));
    f.devices = (f.devices ?? []).filter((d) => d && d.entity);
    f.openings = (f.openings ?? []).filter((o) => o && Array.isArray(o.a) && Array.isArray(o.b));
    f.furniture = (f.furniture ?? []).filter((x) => x && x.kind);
    for (const o of f.openings) ensureId(o, 'open');
    for (const x of f.furniture) {
      ensureId(x, 'furn');
      x.x = Number(x.x) || 0;
      x.y = Number(x.y) || 0;
      x.w = Number(x.w) || 60;
      x.h = Number(x.h) || 60;
    }
    for (const r of f.rooms) {
      ensureId(r, 'room');
      r.points = r.points.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]), Number(p[1])] as Point);
    }
    for (const d of f.devices) {
      ensureId(d, 'dev');
      d.x = Number(d.x) || 0;
      d.y = Number(d.y) || 0;
    }
    // a trace image needs a picture and a size
    if (f.trace && (typeof f.trace !== 'object' || (!f.trace.image && !f.trace.src) || !(Number(f.trace.w) > 0))) delete f.trace;
    else if (f.trace) {
      f.trace.x = Number(f.trace.x) || 0;
      f.trace.y = Number(f.trace.y) || 0;
      f.trace.w = Number(f.trace.w);
      f.trace.ratio = Number(f.trace.ratio) > 0 ? Number(f.trace.ratio) : 1;
    }
  }
  return cfg as FloorplanCardConfig;
}

/** Strips runtime-only noise so the saved YAML stays small and readable. */
export function cleanConfig(cfg: FloorplanCardConfig): FloorplanCardConfig {
  const out: any = JSON.parse(JSON.stringify(cfg));
  const prune = (o: any) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length && k !== 'rooms' && k !== 'devices' && k !== 'points'))
        delete o[k];
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        prune(v);
        if (!Object.keys(v).length) delete o[k];
      } else if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && !Array.isArray(x) && prune(x));
    }
  };
  prune(out);
  return out;
}

/**
 * Example plan for the card picker: one rectangle per HA area, laid out in two rows,
 * with lights/sensors suggested from the area.
 */
export function stubConfig(hass: HomeAssistant): FloorplanCardConfig {
  const areas = Object.values(hass?.areas ?? {}).slice(0, 8);
  const rooms: RoomConfig[] = [];
  const cols = Math.max(1, Math.ceil(areas.length / 2));
  const w = 400;
  const h = 320;
  areas.forEach((a, i) => {
    const x = (i % cols) * w;
    const y = Math.floor(i / cols) * h;
    const s = suggestForArea(hass, a.area_id);
    rooms.push({
      id: `room_${a.area_id}`,
      name: a.name,
      area: a.area_id,
      points: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      lights: s.lights,
      temperature: s.temperature,
      humidity: s.humidity,
      climate: s.climate,
    });
  });
  return {
    type: 'custom:floorplan-card',
    card_id: uid('fp'),
    floors: [{ id: 'floor_1', name: t('card.default_floor'), rooms, devices: [] }],
  };
}

/**
 * First steps "start from Home Assistant": one simple rectangle per area, one floor per HA floor (areas without a
 * floor go to the first one). Laid out in rows of three, so the user can then shape them in the editor.
 */
export function areasConfig(hass: HomeAssistant): FloorplanCardConfig {
  const areas = Object.values(hass?.areas ?? {});
  const haFloors = Object.values(hass?.floors ?? {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const used = haFloors.filter((f) => areas.some((a) => a.floor_id === f.floor_id));
  const loose = areas.filter((a) => !a.floor_id || !used.some((f) => f.floor_id === a.floor_id));
  const groups: { id: string; name: string; floor?: string; level?: number; areas: HassArea[] }[] = used.map((f) => ({
    id: `floor_${f.floor_id}`,
    name: f.name,
    floor: f.floor_id,
    level: f.level ?? undefined,
    areas: areas.filter((a) => a.floor_id === f.floor_id),
  }));
  if (groups.length) groups[0].areas.push(...loose);
  else groups.push({ id: 'floor_1', name: t('card.default_floor'), areas: loose });
  const w = 400;
  const h = 320;
  const floors: FloorConfig[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    ...(g.floor ? { floor: g.floor } : {}),
    ...(g.level !== undefined ? { level: g.level } : {}),
    devices: [],
    rooms: g.areas.slice(0, 40).map((a, i): RoomConfig => {
      const x = (i % 3) * w;
      const y = Math.floor(i / 3) * h;
      const s = suggestForArea(hass, a.area_id);
      return {
        id: `room_${a.area_id}`,
        name: a.name,
        area: a.area_id,
        points: [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ],
        lights: s.lights,
        temperature: s.temperature,
        humidity: s.humidity,
        climate: s.climate,
      };
    }),
  }));
  return { type: 'custom:floorplan-card', floors };
}

// ---------- Export / import of a floor plan (editor → settings → "Grundriss sichern") ----------

export const PLAN_FORMAT = 'roomwise_floorplan';
export const PLAN_VERSION = 1;
export const PLAN_MAX_BYTES = 5_000_000;

/** The file the editor offers for download: the cleaned card config (without this card's id) in a small versioned frame. */
export function planFile(cfg: FloorplanCardConfig): { format: string; version: number; created: string; config: FloorplanCardConfig } {
  const config = cleanConfig(cfg);
  delete (config as Partial<FloorplanCardConfig>).card_id;
  return { format: PLAN_FORMAT, version: PLAN_VERSION, created: new Date().toISOString(), config };
}

const isPoint = (p: unknown) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));

/**
 * Checks a card config from outside (a file): the frame of every floor, room, opening, piece of furniture and
 * device. Returns translated sentences for what is wrong (empty = fine); normalizeConfig fills in the rest.
 */
export function validateConfig(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [t('plan_io.not_object')];
  const cfg = input as Record<string, any>;
  if (cfg.type !== undefined && cfg.type !== 'custom:floorplan-card') errors.push(t('plan_io.wrong_type', { x: String(cfg.type) }));
  const floors = Array.isArray(cfg.floors) ? cfg.floors : cfg.floors === undefined && Array.isArray(cfg.rooms) ? [{ rooms: cfg.rooms, devices: cfg.devices ?? [] }] : null;
  if (!floors) return [...errors, t('plan_io.no_floors')];
  if (floors.length > 20) errors.push(t('plan_io.too_many_floors', { n: 20 }));
  floors.forEach((f: any, i: number) => {
    const where = typeof f?.name === 'string' && f.name ? f.name : t('editor.new_floor', { n: i + 1 });
    if (!f || typeof f !== 'object') return errors.push(t('plan_io.bad_floor', { floor: where }));
    for (const key of ['rooms', 'devices', 'openings', 'furniture']) if (f[key] !== undefined && !Array.isArray(f[key])) errors.push(t('plan_io.bad_list', { floor: where, what: key }));
    (Array.isArray(f.rooms) ? f.rooms : []).forEach((r: any, j: number) => {
      if (!r || !Array.isArray(r.points) || r.points.filter(isPoint).length < 3) errors.push(t('plan_io.bad_room', { floor: where, room: r?.name || String(j + 1) }));
    });
    (Array.isArray(f.openings) ? f.openings : []).forEach((o: any) => {
      if (!o || !isPoint(o.a) || !isPoint(o.b) || !['door', 'window'].includes(o.type ?? 'door')) errors.push(t('plan_io.bad_opening', { floor: where }));
    });
    (Array.isArray(f.furniture) ? f.furniture : []).forEach((x: any) => {
      if (!x || typeof x.kind !== 'string') errors.push(t('plan_io.bad_furniture', { floor: where }));
      else if (!validMediaControls(x.media)) errors.push(t('plan_io.bad_media', { floor: where, x: String(x.name ?? x.kind) }));
      else if (x.contents !== undefined && (!Array.isArray(x.contents) || x.contents.some((c: any) => !c || (c.kind === 'wifi' ? c.entity !== undefined : typeof c.entity !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(c.entity)))))
        errors.push(t('plan_io.bad_contents', { floor: where, x: String(x.name ?? x.kind) }));
      else if (x.pet?.figure !== undefined && x.pet.figure !== 'simple' && x.pet.figure !== 'realistic') errors.push(t('plan_io.bad_pet_figure', { floor: where, x: String(x.pet.figure) }));
    });
    (Array.isArray(f.devices) ? f.devices : []).forEach((d: any) => {
      if (!d || typeof d.entity !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(d.entity)) errors.push(t('plan_io.bad_device', { floor: where, x: String(d?.entity ?? '?') }));
      else if (!validMediaControls(d.media)) errors.push(t('plan_io.bad_media', { floor: where, x: d.name ?? d.entity }));
    });
  });
  return [...new Set(errors)].slice(0, 12);
}

/**
 * Reads a plan file (or a bare card config) for the editor. The result keeps this card's identity (type and
 * card_id), so the dashboard and the companion's settings for this card stay as they are.
 */
export function readPlanFile(raw: unknown, current: FloorplanCardConfig): { config?: FloorplanCardConfig; errors: string[] } {
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format !== undefined) {
    const f = raw as { format?: unknown; version?: unknown; config?: unknown };
    if (f.format !== PLAN_FORMAT) return { errors: [t('plan_io.not_ours')] };
    if (typeof f.version !== 'number' || f.version > PLAN_VERSION) return { errors: [t('plan_io.newer')] };
    raw = f.config;
  }
  const errors = validateConfig(raw);
  if (errors.length) return { errors };
  const next = normalizeConfig({ ...(raw as FloorplanCardConfig), type: current.type, card_id: current.card_id });
  if (!current.card_id) delete (next as Partial<FloorplanCardConfig>).card_id;
  return { config: next, errors: [] };
}
