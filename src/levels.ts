import type { FloorConfig, FloorplanCardConfig, FurnitureConfig, HassArea, HomeAssistant } from './types';

/**
 * Storeys ("Etagen"): order, short labels, neighbours, where things are.
 * A floor's level is its own `level`, else the level of the linked Home Assistant floor, else its position
 * in the list (the first floor is the ground floor, floors added later stack on top) — so old configs keep
 * their order and single-floor configs never notice any of this.
 */

/** Effective level of a floor (higher = further up) */
export function floorLevel(cfg: Pick<FloorplanCardConfig, 'floors'>, f: FloorConfig, hass?: HomeAssistant): number {
  if (typeof f.level === 'number' && isFinite(f.level)) return f.level;
  const ha = f.floor ? hass?.floors?.[f.floor] : undefined;
  if (ha && typeof ha.level === 'number') return ha.level;
  return Math.max(0, cfg.floors.indexOf(f));
}

/** Floors from the top down (ties: later in the list is higher) */
export function orderedFloors(cfg: Pick<FloorplanCardConfig, 'floors'>, hass?: HomeAssistant): FloorConfig[] {
  return cfg.floors
    .map((f, i) => ({ f, i, l: floorLevel(cfg, f, hass) }))
    .sort((a, b) => b.l - a.l || b.i - a.i)
    .map((x) => x.f);
}

/** The floor right below (undefined on the lowest) */
export function floorBelow(cfg: Pick<FloorplanCardConfig, 'floors'>, id: string | undefined, hass?: HomeAssistant): FloorConfig | undefined {
  const o = orderedFloors(cfg, hass);
  const i = o.findIndex((f) => f.id === id);
  return i >= 0 ? o[i + 1] : undefined;
}

/** The floor right above (undefined on the top floor) */
export function floorAbove(cfg: Pick<FloorplanCardConfig, 'floors'>, id: string | undefined, hass?: HomeAssistant): FloorConfig | undefined {
  const o = orderedFloors(cfg, hass);
  const i = o.findIndex((f) => f.id === id);
  return i > 0 ? o[i - 1] : undefined;
}

/** Where stairs on a floor lead: their own target, else up, on the top floor down */
export function stairsTarget(cfg: Pick<FloorplanCardConfig, 'floors'>, floorId: string | undefined, piece: FurnitureConfig, hass?: HomeAssistant): FloorConfig | undefined {
  const own = piece.stairs_to && piece.stairs_to !== floorId ? cfg.floors.find((f) => f.id === piece.stairs_to) : undefined;
  return own ?? floorAbove(cfg, floorId, hass) ?? floorBelow(cfg, floorId, hass);
}

const SHORT: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/(\d+)\s*\.?\s*(ober|og\b)/i, (m) => `${m[1]}.OG`],
  [/(\d+)\s*\.?\s*(unter|ug\b)/i, (m) => `${m[1]}.UG`],
  [/spitzboden/i, 'SB'],
  [/dachgeschoss|dachboden|^dach/i, 'DG'],
  [/obergeschoss|^ober/i, 'OG'],
  [/erdgeschoss|^erd/i, 'EG'],
  [/keller/i, 'KG'],
  [/untergeschoss|^unter/i, 'UG'],
  [/galerie/i, 'GA'],
  [/ground/i, 'GF'],
  [/basement|cellar/i, 'B'],
  [/attic|loft/i, 'A'],
  [/upper|upstairs/i, 'UP'],
  [/(\d+)(st|nd|rd|th)?\s*floor/i, (m) => `${m[1]}F`],
  [/first floor/i, '1F'],
  [/second floor/i, '2F'],
  [/third floor/i, '3F'],
];

/** Short label for the compact slider ("EG", "1.OG", "DG"): own, from known names, initials or the start */
export function floorShort(f: FloorConfig): string {
  if (f.short?.trim()) return f.short.trim().slice(0, 4);
  const name = (f.name ?? '').trim();
  if (name.length <= 3) return name || '·';
  for (const [re, out] of SHORT) {
    const m = name.match(re);
    if (m) return typeof out === 'string' ? out : out(m);
  }
  const words = name.split(/[\s\-–_/]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('');
  return name.slice(0, 2).toUpperCase();
}

/** The floor that holds a room / piece / marker / door (by id) */
export function floorOfItem(cfg: Pick<FloorplanCardConfig, 'floors'>, id: string): FloorConfig | undefined {
  return cfg.floors.find(
    (f) => f.rooms.some((r) => r.id === id) || f.devices.some((d) => d.id === id) || !!f.furniture?.some((x) => x.id === id) || !!f.openings?.some((o) => o.id === id),
  );
}

/** The floor an entity is shown on (marker, linked piece, door / window, or a room's light / climate / sensor) */
export function floorOfEntity(cfg: Pick<FloorplanCardConfig, 'floors'>, entity: string): FloorConfig | undefined {
  return (
    cfg.floors.find((f) => f.devices.some((d) => d.entity === entity) || !!f.furniture?.some((x) => x.entity === entity || Object.values(x.entities ?? {}).includes(entity)) || !!f.openings?.some((o) => o.entity === entity)) ??
    cfg.floors.find((f) => f.rooms.some((r) => r.lights?.includes(entity) || r.climate === entity || r.temperature === entity || r.humidity === entity || !!r.sensors?.some((s) => s.entity === entity)))
  );
}

/** Home Assistant areas that belong to a HA floor (sorted by name) */
export function areasOnFloor(hass: HomeAssistant | undefined, haFloor: string | undefined): HassArea[] {
  if (!hass || !haFloor) return [];
  return Object.values(hass.areas ?? {})
    .filter((a) => a.floor_id === haFloor)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** New levels after moving a floor one step up (dir 1) or down (-1) in the order: the lowest level stays */
export function reorderLevels(cfg: Pick<FloorplanCardConfig, 'floors'>, id: string, dir: 1 | -1, hass?: HomeAssistant): Map<string, number> | undefined {
  const top = orderedFloors(cfg, hass);
  const i = top.findIndex((f) => f.id === id);
  const j = i - dir;
  if (i < 0 || j < 0 || j >= top.length) return undefined;
  const base = Math.min(...cfg.floors.map((f) => floorLevel(cfg, f, hass)));
  [top[i], top[j]] = [top[j], top[i]];
  const out = new Map<string, number>();
  top.forEach((f, k) => out.set(f.id, base + (top.length - 1 - k)));
  return out;
}
