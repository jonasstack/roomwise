import type { FloorConfig, FloorplanCardConfig, FurnitureConfig, HassEntity, HomeAssistant, Point } from './types';
import { APPLIANCE_KINDS, applianceStatus } from './appliance';
import { furnitureLabel, resolveFurniture } from './furniture';
import { pointInPolygon } from './geometry';
import { orderedFloors } from './levels';
import { t } from './i18n';

/**
 * "Etagen-Blick": something worth telling happens on another floor than the one shown (a washer done, a leak, a window
 * open in the rain …). The most important such thing of all other floors, with where it is – the card shows that floor
 * faintly below the shown one, with a label at the spot (components/floor-peek.ts).
 */
export type PeekKind = 'alarm' | 'leak' | 'smoke' | 'window' | 'appliance' | 'pet' | 'vacuum' | 'garage';

/** Most important first: alarm, then water / smoke, open windows, an appliance done, the dog, the vacuum, a garage door */
const ORDER: PeekKind[] = ['alarm', 'smoke', 'leak', 'window', 'appliance', 'pet', 'vacuum', 'garage'];

export interface PeekEvent {
  kind: PeekKind;
  floor: FloorConfig;
  /** where on that floor (plan units) */
  at: Point;
  /** "Waschmaschine fertig" */
  text: string;
  /** the piece / opening / device it is about */
  pieceId?: string;
  entity?: string;
  /** the room it is in (for focusing it) */
  roomId?: string;
  /** red (alarm, leak, smoke, window), warm (the rest) */
  severe: boolean;
}

export interface PeekContext {
  hass: HomeAssistant;
  getState: (id: string) => HassEntity | undefined;
  /** the windows of the front-door warning that are open right now (opening ids) */
  alertWindows?: Set<string>;
  /** dogs that want out (piece ids) */
  dueDogs?: Set<string>;
  /** the entity that set off the alarm (Hausregeln) */
  alarmCause?: string;
}

const SMOKE = new Set(['smoke', 'gas', 'carbon_monoxide']);

function nameOf(ctx: PeekContext, entity: string | undefined, own?: string) {
  if (own) return own;
  const s = entity ? ctx.getState(entity) : undefined;
  return String(s?.attributes.friendly_name ?? entity ?? '');
}

const pieceName = (f: FurnitureConfig) => f.name || (resolveFurniture(f).k ? furnitureLabel(resolveFurniture(f).k!) : f.kind);

/** Everything worth telling on one floor (unsorted) */
function floorEvents(floor: FloorConfig, ctx: PeekContext): PeekEvent[] {
  const out: PeekEvent[] = [];
  const add = (kind: PeekKind, at: Point, text: string, extra: Partial<PeekEvent> = {}) =>
    out.push({ kind, floor, at, text, severe: ['alarm', 'smoke', 'leak', 'window'].includes(kind), ...extra });
  const things: { id: string; entity: string; at: Point; name: string }[] = [
    ...(floor.devices ?? []).map((d) => ({ id: d.id, entity: d.entity, at: [d.x, d.y] as Point, name: nameOf(ctx, d.entity, d.name) })),
    ...(floor.furniture ?? []).filter((f) => f.entity).map((f) => ({ id: f.id, entity: f.entity!, at: [f.x, f.y] as Point, name: f.name || nameOf(ctx, f.entity) })),
    ...(floor.openings ?? []).filter((o) => o.entity).map((o) => ({ id: o.id, entity: o.entity!, at: [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2] as Point, name: nameOf(ctx, o.entity, o.name) })),
  ];
  for (const x of things) {
    if (ctx.alarmCause && x.entity === ctx.alarmCause) add('alarm', x.at, t('peek.alarm', { name: x.name }), { pieceId: x.id, entity: x.entity });
    const s = ctx.getState(x.entity);
    if (!s || !x.entity.startsWith('binary_sensor.') || s.state !== 'on') continue;
    const dc = String(s.attributes.device_class ?? '');
    if (dc === 'moisture') add('leak', x.at, t('peek.leak', { name: x.name }), { pieceId: x.id, entity: x.entity });
    else if (SMOKE.has(dc)) add('smoke', x.at, t('peek.smoke', { name: x.name }), { pieceId: x.id, entity: x.entity });
  }
  for (const o of floor.openings ?? []) {
    const at: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    if (ctx.alertWindows?.has(o.id)) add('window', at, t('peek.window', { name: nameOf(ctx, o.entity, o.name) }), { pieceId: o.id, entity: o.entity });
    else if (o.type === 'garage' && o.entity && ['open', 'opening', 'on'].includes(ctx.getState(o.entity)?.state ?? ''))
      add('garage', at, t('peek.garage', { name: nameOf(ctx, o.entity, o.name) }), { pieceId: o.id, entity: o.entity });
  }
  for (const f of floor.furniture ?? []) {
    const kind = resolveFurniture(f).k?.kind;
    if (kind && APPLIANCE_KINDS.has(kind) && (f.entity || f.entities)) {
      if (applianceStatus(ctx.hass, f, kind, ctx.getState).phase === 'done') add('appliance', [f.x, f.y], t('peek.appliance', { name: pieceName(f) }), { pieceId: f.id, entity: f.entity });
    } else if (ctx.dueDogs?.has(f.id)) add('pet', [f.x, f.y], t('peek.pet', { name: pieceName(f) }), { pieceId: f.id });
    else if (kind === 'robot_vacuum' && f.entity && ctx.getState(f.entity)?.state === 'error') add('vacuum', [f.x, f.y], t('peek.vacuum', { name: pieceName(f) }), { pieceId: f.id, entity: f.entity });
    else if (kind === 'garage_door' && f.entity && ['open', 'opening', 'on'].includes(ctx.getState(f.entity)?.state ?? ''))
      add('garage', [f.x, f.y], t('peek.garage', { name: pieceName(f) }), { pieceId: f.id, entity: f.entity });
  }
  for (const e of out) e.roomId = floor.rooms.find((r) => r.points.length >= 3 && pointInPolygon(e.at, r.points))?.id;
  return out;
}

/**
 * The one thing to show from another floor: the most important event of all floors but the shown one (on equal
 * importance the floor nearest to the shown one). Nothing with one floor or when switched off.
 */
export function peekEvent(cfg: FloorplanCardConfig, shownId: string | undefined, ctx: PeekContext): PeekEvent | undefined {
  if (cfg.floors.length < 2 || cfg.floor_peek === false) return undefined;
  const order = orderedFloors(cfg, ctx.hass);
  const here = order.findIndex((f) => f.id === shownId);
  let best: PeekEvent | undefined;
  let bestRank = Infinity;
  for (const [i, floor] of order.entries()) {
    if (floor.id === shownId) continue;
    for (const e of floorEvents(floor, ctx)) {
      const rank = ORDER.indexOf(e.kind) * 100 + Math.abs(i - here);
      if (rank < bestRank) {
        best = e;
        bestRank = rank;
      }
    }
  }
  return best;
}

/** A stable key: the card redraws the peek only when this changes */
export const peekKey = (e: PeekEvent | undefined) => (e ? `${e.floor.id}|${e.kind}|${e.pieceId ?? ''}|${e.text}` : '');
