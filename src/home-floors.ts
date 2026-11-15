import type { FloorConfig, HassFloor, HomeAssistant } from './types';
import { t } from './i18n';

/**
 * Flat or house, and how many floors — for the first steps. Suggested from what Home Assistant already knows
 * (its floors, areas like a garden, garage or stairs, a robot vacuum with several maps); always only a suggestion
 * the person can change.
 */

export type HomeKind = 'flat' | 'house';
export interface HomeGuess {
  kind: HomeKind;
  /** floors to start with */
  n: number;
  /** why: 'ha' (Home Assistant has floors), 'areas' (garden, garage, stairs …), 'maps' (the vacuum keeps several maps) */
  why?: 'ha' | 'areas' | 'maps';
}

/** Home Assistant's floors, lowest first */
export function haFloorsSorted(hass?: HomeAssistant): HassFloor[] {
  return Object.values(hass?.floors ?? {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
}

const HOUSE_WORDS = /garten|garage|treppe|keller|dachboden|speicher|obergeschoss|erdgeschoss|untergeschoss|dachgeschoss|carport|einfahrt|garden|garage|stair|basement|cellar|attic|upstairs|downstairs|driveway/i;

/** A suggestion: several HA floors → a house with as many; areas like a garden or stairs, or several vacuum maps →
 * a house (with at least that many floors); else a flat on one floor */
export function guessHome(hass?: HomeAssistant, maps = 0): HomeGuess {
  const ha = haFloorsSorted(hass).length;
  if (ha > 1) return { kind: 'house', n: Math.max(ha, maps), why: 'ha' };
  if (maps > 1) return { kind: 'house', n: maps, why: 'maps' };
  if (Object.values(hass?.areas ?? {}).some((a) => HOUSE_WORDS.test(a.name))) return { kind: 'house', n: 2, why: 'areas' };
  return { kind: 'flat', n: 1 };
}

/** A floor's name by its storey when Home Assistant has none: ground floor, upper floor, attic, n-th upper floor */
export function floorNameFor(level: number, kind: HomeKind): string {
  if (kind === 'flat') return t('card.default_floor');
  if (level < 0) return t('home.floor_basement');
  if (level === 0) return t('home.floor_ground');
  if (level === 1) return t('home.floor_upper');
  if (level === 2) return t('home.floor_attic');
  return t('home.floor_upper_n', { n: level });
}

/** Empty floors for a new card: Home Assistant's floors first (linked, with their names and levels), the rest
 * named by storey above them. `have`: floors already made (from a map), filled up to `n` */
export function skeletonFloors(hass: HomeAssistant | undefined, kind: HomeKind, n: number, have: FloorConfig[] = []): FloorConfig[] {
  const out = [...have];
  const used = new Set(have.map((f) => f.floor).filter(Boolean));
  const levels = new Set(have.map((f) => f.level).filter((l): l is number => typeof l === 'number'));
  for (const h of haFloorsSorted(hass)) {
    if (out.length >= n) break;
    if (used.has(h.floor_id)) continue;
    const level = typeof h.level === 'number' && !levels.has(h.level) ? h.level : nextLevel(levels);
    levels.add(level);
    out.push({ id: `floor_${h.floor_id}`, name: h.name, floor: h.floor_id, level, rooms: [], devices: [], openings: [], furniture: [] });
  }
  while (out.length < n) {
    const level = nextLevel(levels);
    levels.add(level);
    out.push({ id: `floor_${level < 0 ? 'm' + -level : level}_${out.length}`, name: floorNameFor(level, kind), level, rooms: [], devices: [], openings: [], furniture: [] });
  }
  return out;
}

function nextLevel(levels: Set<number>): number {
  let l = 0;
  while (levels.has(l)) l++;
  return l;
}
