import { svg, type TemplateResult } from 'lit';
import type { FloorConfig, FurnitureConfig, HassEntity, RoomConfig } from './types';
import { furnitureContents, resolveFurniture } from './furniture';
import { domainOf, isActive, lightRgb, rgbCss } from './ha';
import { pointInPolygon, round } from './geometry';
import { APPLIANCE_KINDS, applianceStatus, applianceWatch } from './appliance';

/**
 * Live effect of a piece's linked entity: lamps glow in their light color, heaters glow warm,
 * fans spin and blow, purifiers/humidifiers breathe, screens light up.
 */
export type FxKind = 'light' | 'heat' | 'cool' | 'fan' | 'air' | 'media' | 'power';

export interface FurnitureFx {
  kind: FxKind;
  color: string;
  /** 0..1 (brightness, fan speed, ...) */
  level: number;
}

const WARM = '#ff7b3a';
const COOL = '#4fb3ff';
const AIR = '#5fd0c6';
const SCREEN = '#6f8fd8';
const LAMP = 'rgb(255, 214, 150)';
const POWER = '#8fd3ff';
/** Something to look at: motion, an open door/gate, an unlocked lock, mail */
const NOTICE = '#ffb340';
/** Alarm, smoke, leak, offline */
const ALARM = '#ff453a';
const CHARGE = '#3ee07a';
/** washer & co. done, not seen yet */
const DONE = '#34c759';

/** A ring that tells something (alarm, open lock, charging …) — not the plain "switched on" one, which the piece's
 * own status light shows calmly */
export const isStatusRing = (fx: FurnitureFx | undefined) => fx?.kind === 'power' && fx.color !== POWER;

/** Heaters that follow their room's thermostat when not linked themselves */
const ROOM_HEAT = new Set(['radiator', 'towel_radiator', 'thermostat', 'space_heater']);

/** Role of a piece for its live look: some variants act differently (a smoke detector is an alarm) */
export function fxRole(f: FurnitureConfig) {
  const r = resolveFurniture(f);
  if (r.k?.kind === 'sensor' && (r.variant === 'smoke' || r.variant === 'co' || r.variant === 'leak')) return 'alarm';
  return r.role;
}

/** Status pieces (sensors, alarms, locks, covers, cameras, network, batteries): a coloured ring when it matters */
function statusFx(role: string, d: string, s: HassEntity): FurnitureFx | undefined {
  const st = s.state.toLowerCase();
  const ring = (color: string, level = 1): FurnitureFx => ({ kind: 'power', color, level });
  if (st === 'unavailable' || st === 'unknown') return role === 'network' ? ring(ALARM, 0.6) : undefined;
  switch (role) {
    case 'alarm':
      if (d === 'alarm_control_panel') return st === 'triggered' ? ring(ALARM) : st === 'pending' || st === 'arming' ? ring(NOTICE) : st.startsWith('armed') ? ring(ALARM, 0.4) : undefined;
      return st === 'on' || st === 'triggered' || st === 'detected' ? ring(ALARM) : undefined;
    case 'lock':
      return st === 'jammed' ? ring(ALARM) : st === 'unlocked' || st === 'open' || st === 'opening' || st === 'unlocking' ? ring(NOTICE) : undefined;
    case 'cover':
      return st === 'open' || st === 'opening' || st === 'closing' || st === 'on' ? ring(NOTICE) : undefined;
    case 'camera':
      if (d === 'camera') return st === 'recording' ? ring(ALARM, 0.6) : undefined;
      return st === 'on' ? ring(NOTICE) : undefined;
    case 'sensor':
      return st === 'on' || st === 'open' || st === 'detected' ? ring(NOTICE) : undefined;
    case 'network':
      // connected is normal; offline / not home is worth a look
      return st === 'off' || st === 'not_home' || st === 'disconnected' ? ring(ALARM, 0.6) : undefined;
    case 'battery':
      return st === 'on' || st === 'charging' ? ring(CHARGE) : undefined;
    case 'meter':
      return undefined;
  }
  return undefined;
}

const OFF = new Set(['off', 'unavailable', 'unknown', 'idle', 'standby', 'closed']);

/** Motion / presence: binary sensors that say someone is there */
const MOTION = new Set(['motion', 'occupancy', 'presence', 'moving']);

/**
 * Stairs: lit while one of their lights (the main entity or one inside) is on, or one of their motion sensors sees
 * someone — always soft (they stay in the background of the plan): a low level, warm white.
 */
export function stairsLit(f: FurnitureConfig, getState: (id: string) => HassEntity | undefined): number {
  const ids = [f.entity, ...furnitureContents(f).map((c) => c.entity)].filter((e): e is string => !!e);
  let level = 0;
  for (const id of new Set(ids)) {
    const s = getState(id);
    if (!s) continue;
    const d = domainOf(id);
    if (d === 'light' && s.state === 'on') level = Math.max(level, 0.35 + 0.65 * ((s.attributes.brightness ?? 255) / 255));
    else if ((d === 'switch' || d === 'input_boolean') && s.state === 'on') level = Math.max(level, 1);
    else if (d === 'binary_sensor' && s.state === 'on' && MOTION.has(String(s.attributes.device_class ?? 'motion'))) level = Math.max(level, 0.6);
  }
  return level;
}

export function furnitureFx(f: FurnitureConfig, getState: (id: string) => HassEntity | undefined, rooms?: RoomConfig[]): FurnitureFx | undefined {
  if (resolveFurniture(f).k?.kind === 'stairs') {
    // stairs glow softly on their own (lit treads); a gentle pool, never the full lamp look
    const lit = stairsLit(f, getState);
    return lit ? { kind: 'light', color: LAMP, level: 0.25 * lit } : undefined;
  }
  // washer, dryer, dishwasher: the display lights while it runs; "fertig" shows as a soft green ring until seen
  const ak = resolveFurniture(f).k?.kind;
  if (ak && APPLIANCE_KINDS.has(ak) && (f.entity || f.entities) && applianceWatch?.hass) {
    const a = applianceStatus(applianceWatch.hass, f, ak, getState);
    if (a.phase === 'done') return { kind: 'power', color: DONE, level: 1 };
    if (a.phase === 'running' || a.phase === 'paused') return { kind: 'power', color: POWER, level: a.phase === 'running' ? 1 : 0.5 };
    return undefined;
  }
  if (!f.entity) {
    // an unlinked radiator / heater heats with its room's thermostat
    if (!rooms || resolveFurniture(f).role !== 'heat' || !ROOM_HEAT.has(resolveFurniture(f).k?.kind ?? '')) return undefined;
    const room = rooms.find((r) => r.climate && r.points.length >= 3 && pointInPolygon([f.x, f.y], r.points));
    if (!room?.climate) return undefined;
    const fx = furnitureFx({ ...f, entity: room.climate }, getState);
    return fx?.kind === 'heat' ? fx : undefined;
  }
  const s = getState(f.entity);
  if (!s) return undefined;
  const role = fxRole(f);
  // pets, garden robots, sprinklers, energy and cars have their own animations (not the generic glow)
  if (role === 'pet' || role === 'mower' || role === 'energy' || role === 'car') return undefined;
  if (role === 'water' && ['sprinkler', 'irrigation_zone'].includes(resolveFurniture(f).k?.kind ?? '')) return undefined;
  const d = domainOf(f.entity);
  const st = s.state;
  if (role === 'alarm' || role === 'lock' || role === 'cover' || role === 'camera' || role === 'sensor' || role === 'network' || role === 'battery' || role === 'meter') return statusFx(role, d, s);
  if (role === 'water') return isActive(s) || st === 'open' ? { kind: 'power', color: '#5aa8ff', level: 1 } : undefined;
  // robot vacuums show themselves (driving, docked): no glow or ring
  if (d === 'vacuum' || d === 'lawn_mower') return undefined;
  switch (d) {
    case 'light':
      if (st !== 'on') return undefined;
      return { kind: 'light', color: rgbCss(lightRgb(s)), level: (s.attributes.brightness ?? 255) / 255 };
    case 'climate': {
      const act = s.attributes.hvac_action as string | undefined;
      if (st === 'off' || act === 'off' || act === 'idle') return undefined;
      if (act === 'heating' || (!act && st === 'heat')) return { kind: 'heat', color: WARM, level: 1 };
      if (act === 'cooling' || (!act && st === 'cool')) return { kind: 'cool', color: COOL, level: 1 };
      if (act === 'fan' || act === 'drying' || (!act && (st === 'fan_only' || st === 'dry'))) return { kind: role === 'air' ? 'air' : 'fan', color: AIR, level: 0.6 };
      return undefined;
    }
    case 'fan':
      if (st !== 'on') return undefined;
      return { kind: role === 'air' ? 'air' : 'fan', color: AIR, level: Math.max(0.25, ((s.attributes.percentage as number | undefined) ?? 60) / 100) };
    case 'humidifier':
      return st === 'on' ? { kind: 'air', color: AIR, level: 0.7 } : undefined;
    case 'water_heater':
      return OFF.has(st) || st === 'eco' ? undefined : { kind: 'heat', color: WARM, level: 0.8 };
    case 'media_player':
      if (OFF.has(st)) return undefined;
      return { kind: 'media', color: SCREEN, level: st === 'playing' ? 1 : 0.6 };
  }
  // switch, input_boolean, sensors with on/off — or a power sensor (smart plug) above a few watts:
  // the piece's role decides the look
  const watts = d === 'sensor' ? powerW(s) : undefined;
  if (watts !== undefined) {
    if (watts <= 5) return undefined;
  } else if (st !== 'on') return isActive(s) ? { kind: 'power', color: POWER, level: 1 } : undefined;
  switch (role) {
    case 'light':
      return { kind: 'light', color: LAMP, level: 1 };
    case 'heat':
      return { kind: 'heat', color: WARM, level: 1 };
    case 'ac':
      return { kind: 'cool', color: COOL, level: 1 };
    case 'fan':
      return { kind: 'fan', color: AIR, level: 0.6 };
    case 'air':
      return { kind: 'air', color: AIR, level: 0.7 };
    case 'media':
      return { kind: 'media', color: SCREEN, level: 0.8 };
  }
  // any other appliance: displays and status lights come on
  return { kind: 'power', color: POWER, level: 1 };
}

/** Power in watts of a power sensor (W / kW), else undefined */
function powerW(s: HassEntity): number | undefined {
  const u = String(s.attributes.unit_of_measurement ?? '').toLowerCase();
  if (u !== 'w' && u !== 'kw') return undefined;
  const v = parseFloat(s.state);
  return isNaN(v) ? undefined : v * (u === 'kw' ? 1000 : 1);
}

/** Reach of a lamp's light pool on the floor (cm) */
function lightReach(f: FurnitureConfig): { rx: number; ry: number; dy: number } {
  const r = resolveFurniture(f);
  const k = r.k?.kind;
  const v = r.variant;
  switch (k) {
    case 'light_strip':
      return { rx: f.w / 2 + 35, ry: 55, dy: f.h / 2 + 30 };
    case 'ceiling_lamp':
      if (v === 'spots' || v === 'panel') return { rx: f.w / 2 + 110, ry: 150, dy: 0 };
      return { rx: 210, ry: 210, dy: 0 };
    case 'wall_lamp':
      return { rx: 120, ry: 100, dy: f.h / 2 + 60 };
    case 'table_lamp':
      return v === 'night' ? { rx: 45, ry: 45, dy: 0 } : { rx: 95, ry: 95, dy: 0 };
    case 'light_bar':
      return { rx: 75, ry: 75, dy: 0 };
    case 'floor_lamp':
      return v === 'arc' ? { rx: 140, ry: 140, dy: 0 } : { rx: 150, ry: 150, dy: 0 };
    case 'tv':
      return { rx: f.w / 2 + 40, ry: 90, dy: f.h / 2 + 70 };
  }
  return { rx: Math.max(f.w, f.h) / 2 + 60, ry: Math.max(f.w, f.h) / 2 + 60, dy: 0 };
}

/** Floor-level effects of active linked pieces (part of the plan SVG, so they lie on the floor in 3D). */
export function renderFurnitureFx(floor: FloorConfig, getState: (id: string) => HassEntity | undefined) {
  const defs: TemplateResult[] = [];
  /** static light pools (part of the plan) */
  const items: TemplateResult[] = [];
  /** animated effects (own layer, so the plan is not repainted every frame) */
  const live: TemplateResult[] = [];
  for (const f of floor.furniture ?? []) {
    const water = waterRings(f, getState);
    if (water) {
      live.push(water);
      continue;
    }
    const fx = furnitureFx(f, getState, floor.rooms);
    if (!fx) continue;
    if (fx.kind === 'power') {
      // a status that matters (alarm, open, charging): a ring around the piece; a plainly switched-on appliance
      // shows it with its own status light only (no blue circle after a tap)
      if (!isStatusRing(fx)) continue;
      live.push(svg`<g class="ffx power" transform=${`translate(${round(f.x)} ${round(f.y)})`}>
        <circle class="shimmer" r=${round(Math.max(f.w, f.h) / 2 + 14)} style=${`stroke:${fx.color}`}></circle>
      </g>`);
      continue;
    }
    const r = resolveFurniture(f);
    const at = `translate(${round(f.x)} ${round(f.y)}) rotate(${round(f.rotation ?? 0, 2)})`;
    const gid = `fp-ffx-${f.id}`;
    if (fx.kind === 'light' || fx.kind === 'media') {
      const reach = lightReach(f);
      const k = fx.kind === 'media' ? 0.55 : 0.7 + 0.3 * fx.level;
      // soft pool of light: the lamp's colour toward warm white, falling off smoothly (no hard rim)
      const c = fx.kind === 'media' ? fx.color : soften(fx.color);
      const a = fx.kind === 'media' ? 0.3 : 0.5 * (0.45 + 0.55 * fx.level);
      defs.push(svg`<radialGradient id=${gid}>
        ${[[0, 1], [0.25, 0.72], [0.5, 0.36], [0.75, 0.11], [1, 0]].map(([o, k]) => svg`<stop offset=${o} style=${`stop-color:${c};stop-opacity:${(a * k).toFixed(3)}`}></stop>`)}
      </radialGradient>`);
      items.push(svg`<g class=${`ffx ${fx.kind}`} transform=${at}>
        <ellipse cx="0" cy=${round(reach.dy)} rx=${round(reach.rx * k)} ry=${round(reach.ry * k)} fill=${`url(#${gid})`}></ellipse>
      </g>`);
      continue;
    }
    if (fx.kind === 'heat' || fx.kind === 'cool') {
      // thin threads of warm (red) or cool air drifting away from the device — no glow, no ring
      const n = Math.max(3, Math.min(6, Math.round(f.w / 22)));
      const front = r.k?.kind === 'thermostat' ? 0 : f.h / 2;
      live.push(svg`<g class=${`ffx ${fx.kind}`} transform=${at}>
        ${airStreaks(Math.max(24, f.w * 0.8), front, n, fx.kind === 'cool' ? 'cool' : 'warm', fx.kind === 'cool' ? 1.8 : 2.6)}
      </g>`);
      continue;
    }
    if (fx.kind === 'fan') {
      if (r.ceiling) {
        defs.push(svg`<radialGradient id=${gid}>
          <stop offset="0.35" style=${`stop-color:${fx.color};stop-opacity:0`}></stop>
          <stop offset="0.7" style=${`stop-color:${fx.color};stop-opacity:0.22`}></stop>
          <stop offset="1" style=${`stop-color:${fx.color};stop-opacity:0`}></stop>
        </radialGradient>`);
        live.push(svg`<g class="ffx fan" transform=${at}><circle class="ripple" r=${round(Math.min(f.w, f.h) * 0.75)} fill=${`url(#${gid})`}></circle></g>`);
      } else {
        const dur = 2.2 - 1.3 * fx.level;
        live.push(svg`<g class="ffx fan" transform=${at}>${airStreaks(Math.max(30, f.w * 0.9), f.h / 2, 4, 'air', dur)}</g>`);
      }
      continue;
    }
    // air: purifier / humidifier: soft expanding rings
    const rr = Math.max(f.w, f.h) / 2;
    live.push(svg`<g class="ffx air" transform=${at}>
      ${[0, 1, 2].map((i) => svg`<circle class="ring" r=${round(rr + 10)} style=${`animation-delay:-${(i * 1.2).toFixed(1)}s`}></circle>`)}
    </g>`);
  }
  return { defs, items, live };
}

/** Watering (irrigation zone, sprinkler): drops landing as small rings spread over the wetted area */
function waterRings(f: FurnitureConfig, getState: (id: string) => HassEntity | undefined) {
  const kind = resolveFurniture(f).k?.kind;
  if ((kind !== 'irrigation_zone' && kind !== 'sprinkler') || !f.entity) return undefined;
  const s = getState(f.entity);
  if (!s || !(isActive(s) || s.state === 'open' || s.state === 'opening')) return undefined;
  const rx = kind === 'sprinkler' ? 230 : f.w / 2;
  const ry = kind === 'sprinkler' ? 230 : f.h / 2;
  const n = Math.max(4, Math.min(9, Math.round((rx * ry) / 9000)));
  return svg`<g class="ffx water" transform=${`translate(${round(f.x)} ${round(f.y)}) rotate(${round(f.rotation ?? 0, 2)})`}>
    ${Array.from({ length: n }, (_, i) => {
      // a sunflower spread: evenly over the area, no clumps
      const a = i * 2.39996;
      const k = Math.sqrt((i + 0.5) / n) * 0.8;
      return svg`<circle class="ring" cx=${round(Math.cos(a) * rx * k)} cy=${round(Math.sin(a) * ry * k)} r="16" style=${`animation-delay:-${((i * 0.61) % 3.6).toFixed(2)}s`}></circle>`;
    })}
  </g>`;
}

/** Light colour mixed 40 % toward warm white: pools read as light, not as paint */
function soften(color: string): string {
  const m = color.match(/[\d.]+/g);
  let rgb: number[] | undefined;
  if (color.startsWith('#') && color.length === 7) rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  else if (m && m.length >= 3) rgb = m.slice(0, 3).map(Number);
  if (!rgb) return color;
  const w = [255, 244, 224];
  return `rgb(${rgb.map((v, i) => Math.round(v * 0.6 + w[i] * 0.4)).join(', ')})`;
}

/** Streaks flowing out of the device's front (+y) */
function airStreaks(width: number, front: number, n: number, tone: 'air' | 'cool' | 'warm', dur: number) {
  return svg`${Array.from({ length: n }, (_, i) => {
    const x = -width / 2 + (width * (i + 0.5)) / n;
    return svg`<path class=${`fstreak ${tone}`} d=${`M ${round(x)} ${round(front)} q ${i % 2 ? 4 : -4} 14 0 28 t 0 28 t 0 28`}
      style=${`animation-duration:${dur.toFixed(2)}s;animation-delay:-${(((i * 0.41) % 1) * dur).toFixed(2)}s`}></path>`;
  })}`;
}
