import { nothing, svg, type SVGTemplateResult } from 'lit';
import type { FurnitureConfig, FurnitureContentConfig, HassEntity } from './types';
import { getLanguage } from './i18n';
import { paint, tone } from './colors';
import { CARS } from './cars';
import type { CarOpen } from './car-info';

/**
 * Furniture & appliance catalog. Every piece is drawn parametrically as a clean top view in a local
 * box centered on 0,0 (width w, depth h in cm) from its variant, count and colors.
 */

export type FurnitureCategory =
  | 'living' | 'lighting' | 'climate' | 'tech' | 'dining' | 'sleeping' | 'work' | 'kitchen' | 'appliance' | 'bath' | 'home' | 'hall' | 'outdoor' | 'pets' | 'garden' | 'energy' | 'vehicle'
  | 'network' | 'security' | 'leisure';

/**
 * What a linked entity does to the piece (and which entities fit): light glows, heat glows warm, fans spin,
 * sensors/alarms/locks/covers/cameras show a coloured ring when something is going on, network devices when offline.
 */
export type FurnitureRole =
  | 'light' | 'heat' | 'fan' | 'air' | 'ac' | 'media' | 'pet' | 'mower' | 'water' | 'energy' | 'car'
  | 'battery' | 'network' | 'sensor' | 'alarm' | 'lock' | 'cover' | 'camera' | 'meter';

export interface Variant {
  id: string;
  de: string;
  en: string;
  w?: number;
  h?: number;
  height?: number;
  /** Mounting height above the floor (wall variants) */
  elevation?: number;
  /** Hangs from the ceiling: floats just above the cut-away walls in the 3D overview */
  ceiling?: boolean;
  /** Default count for this variant (e.g. 2 panels for a balcony power plant) */
  n?: number;
  /** Own tile in the object library (true: the variant's label, or its own label) */
  lib?: boolean | { de: string; en: string };
}

export interface DrawCtx {
  w: number;
  h: number;
  v: string;
  n: number;
  c: string;
  a: string;
  flip: boolean;
  /** Live state for pieces that move (gate, garage door: how far open 0…1; irrigation zone: watering) */
  live?: PieceLive;
}

/** Live state handed to the drawing of a moving piece (the plan only; library previews draw it closed) */
export interface PieceLive {
  open?: number;
  on?: boolean;
  /** open (alert colour) */
  alert?: boolean;
  /** car: what is open (tailgate, frunk, sunroof, doors, windows) */
  car?: CarOpen;
  /** fridge: open items of its linked to-do / shopping list, engraved on the door */
  count?: number;
}

/** A piece that shows the Wi-Fi QR codes on a tap: a router (not a bare fibre modem) or a Wi-Fi access point */
export function isWifiPiece(f: FurnitureConfig): boolean {
  const r = resolveFurniture(f);
  return (r.k?.kind === 'router' && r.variant !== 'ont') || r.k?.kind === 'access_point';
}

/** A piece whose "devices inside" hold the Wi-Fi QR codes item (any piece: a cabinet with the router in it …) */
export function hasWifiContent(f: FurnitureConfig): boolean {
  return !!f.contents?.some((c) => c && isWifiContent(c));
}

/** What the Wi-Fi popup gets for the QR codes item inside a piece: the piece named like the item, without the
 *  piece's own entity (that is not the router) */
export function wifiContentTarget(f: FurnitureConfig): FurnitureConfig {
  const c = f.contents?.find((x) => x && isWifiContent(x));
  return { ...f, name: c?.name, entity: undefined };
}

/** Open items of the to-do / shopping list linked to a fridge (Home Assistant's todo state is that number); 0 = none */
export function fridgeList(f: FurnitureConfig, getState: (id: string) => HassEntity | undefined): number {
  if (resolveFurniture(f).k?.kind !== 'fridge') return 0;
  const id = [f.entity, ...Object.values(f.entities ?? {})].find((e) => typeof e === 'string' && e.startsWith('todo.'));
  const n = id ? parseInt(getState(id)?.state ?? '', 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A number engraved into a surface (2D / CSS-3D top view): light edge below, dark edge above, the recessed face */
function engraved(text: string, x: number, y: number, size: number, c: string) {
  const at = (dy: number, fill: string) =>
    svg`<text x=${x} y=${y + dy} font-size=${size} font-weight="500" text-anchor="middle" dominant-baseline="central" fill=${fill} style="font-family:Roboto,'Helvetica Neue',Arial,sans-serif;font-variant-numeric:tabular-nums">${text}</text>`;
  return svg`<g class="engraved" pointer-events="none">${at(size * 0.035, 'rgba(255,255,255,0.45)')}${at(-size * 0.03, 'rgba(0,0,0,0.22)')}${at(0, tone(c, -0.32))}</g>`;
}

export interface FurnitureKind {
  kind: string;
  cat: FurnitureCategory;
  de: string;
  en: string;
  icon: string;
  w: number;
  h: number;
  /** Real height in cm (3D) */
  height: number;
  color: string;
  accent?: string;
  variants?: Variant[];
  count?: { de: string; en: string; min: number; max: number; def: number };
  /** Small item: stands on a counter/table when placed over one */
  onTop?: boolean;
  /** Has a usable top surface for onTop items */
  support?: boolean;
  /** Default height above the floor (wall-mounted) */
  elevation?: number;
  /** 3D: render as floating top (round/flat things) instead of a box */
  top3d?: boolean;
  /** Color palette for the inspector */
  palette: PaletteId;
  /** Hangs from the ceiling (see Variant.ceiling) */
  ceiling?: boolean;
  /** Effect of a linked entity */
  role?: FurnitureRole;
  /** Extra search words for the library (German and English synonyms, brands) */
  keys?: string;
  draw(c: DrawCtx): SVGTemplateResult;
}

export type PaletteId = 'fabric' | 'wood' | 'white' | 'metal' | 'appliance' | 'plant' | 'rug' | 'fur' | 'car' | 'stone';

export const FURNITURE_PALETTES: Record<PaletteId, string[]> = {
  fabric: ['#b7b4ae', '#8f8a84', '#5c5d61', '#d9cfc1', '#a8b39a', '#8aa0b5', '#b98c76', '#3f4a5a', '#e7e1d6'],
  wood: ['#e3c9a0', '#d2a878', '#b9875a', '#8b5e3c', '#5e4030', '#c8c0b4', '#f1ebe1', '#2f2b28'],
  white: ['#f4f4f2', '#e9e6df', '#d4d4d0', '#9aa0a6', '#4b4d52', '#2c2c2e', '#c9b9a0', '#7f9a8b'],
  metal: ['#d7dadd', '#b8bcc1', '#8d9297', '#4b4f54', '#2c2c2e', '#f4f4f2', '#c9a46a', '#a85b3f'],
  appliance: ['#f4f4f2', '#d7dadd', '#9aa0a6', '#3a3a3c', '#1f1f21', '#c94a3a', '#6f8f7a', '#e8d9c0'],
  plant: ['#8fbf7f', '#6f9f62', '#4f7f4a', '#a6c48a', '#7aa58f'],
  fur: ['#c8a27a', '#e0a55a', '#8b5a3c', '#6b4a36', '#2c2c2e', '#4a4f57', '#9aa0a6', '#d8c3a5', '#f1ebe1', '#fbf8f2'],
  car: ['#f4f4f2', '#1f1f21', '#9aa0a6', '#c9ccd0', '#3a4a5c', '#8a1f24', '#2f5e8e', '#4f6b54', '#c94a3a', '#d9b84a', '#7d8f9c'],
  stone: ['#c8c0b4', '#a8a29a', '#8d8780', '#d9cfc1', '#6f6a64', '#b98c76'],
  rug: ['#e7e1d6', '#d9cfc1', '#b7b4ae', '#8f8a84', '#5c5d61', '#b98c76', '#8aa0b5', '#a8b39a', '#c9a46a', '#3f4a5a'],
};

// ---------- drawing helpers (theme-aware fills) ----------

const LINE = 'rgba(0, 0, 0, 0.18)';
const P = (c: string) => paint(c);

function R(x: number, y: number, w: number, h: number, rx: number, fill: string, stroke = true) {
  return svg`<rect x=${x} y=${y} width=${Math.max(0, w)} height=${Math.max(0, h)} rx=${Math.max(0, Math.min(rx, w / 2, h / 2))}
    style=${`fill:${P(fill)};${stroke ? `stroke:${LINE};stroke-width:1;vector-effect:non-scaling-stroke` : ''}`}></rect>`;
}
function C(cx: number, cy: number, r: number, fill: string, stroke = true) {
  return svg`<circle cx=${cx} cy=${cy} r=${Math.max(0, r)} style=${`fill:${P(fill)};${stroke ? `stroke:${LINE};stroke-width:1;vector-effect:non-scaling-stroke` : ''}`}></circle>`;
}
function E(cx: number, cy: number, rx: number, ry: number, fill: string, stroke = true) {
  return svg`<ellipse cx=${cx} cy=${cy} rx=${Math.max(0, rx)} ry=${Math.max(0, ry)} style=${`fill:${P(fill)};${stroke ? `stroke:${LINE};stroke-width:1;vector-effect:non-scaling-stroke` : ''}`}></ellipse>`;
}
function L(x1: number, y1: number, x2: number, y2: number, color = LINE, width = 1) {
  return svg`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} style=${`stroke:${color.startsWith('#') ? P(color) : color};stroke-width:${width};vector-effect:non-scaling-stroke;stroke-linecap:round`}></line>`;
}
function Ring(cx: number, cy: number, r: number, color: string, width = 1.5) {
  return svg`<circle cx=${cx} cy=${cy} r=${Math.max(0, r)} style=${`fill:none;stroke:${P(color)};stroke-width:${width};vector-effect:non-scaling-stroke`}></circle>`;
}
function PathD(d: string, fill: string, stroke = true) {
  return svg`<path d=${d} style=${`fill:${P(fill)};${stroke ? `stroke:${LINE};stroke-width:1;vector-effect:non-scaling-stroke` : ''}`}></path>`;
}
/** Dashed outline: wall-mounted things above head height (architectural convention). */
function Dash(x: number, y: number, w: number, h: number, rx: number, fill: string) {
  return svg`<rect x=${x} y=${y} width=${w} height=${h} rx=${rx} style=${`fill:${P(fill)};fill-opacity:0.55;stroke:${LINE};stroke-width:1.2;stroke-dasharray:4 3;vector-effect:non-scaling-stroke`}></rect>`;
}

/** Light-emitting part: neutral when off, takes the lamp color when the linked light is on (CSS .lit) */
function Bulb(cx: number, cy: number, r: number) {
  return svg`<circle class="bulb" cx=${cx} cy=${cy} r=${Math.max(0, r)} style=${`fill:${P('#efe6cf')}`}></circle>`;
}
function BulbRect(x: number, y: number, w: number, h: number, rx: number) {
  return svg`<rect class="bulb" x=${x} y=${y} width=${Math.max(0, w)} height=${Math.max(0, h)} rx=${Math.max(0, Math.min(rx, w / 2, h / 2))} style=${`fill:${P('#efe6cf')}`}></rect>`;
}
/** Dashed circle: things hanging from the ceiling */
function DashC(cx: number, cy: number, r: number, fill: string, opacity = 0.55) {
  return svg`<circle cx=${cx} cy=${cy} r=${Math.max(0, r)} style=${`fill:${P(fill)};fill-opacity:${opacity};stroke:${LINE};stroke-width:1.2;stroke-dasharray:4 3;vector-effect:non-scaling-stroke`}></circle>`;
}
/** Fan blades (spin when the linked fan runs, CSS .spin) */
function Blades(r: number, n: number, color: string, width = 0.22) {
  const b = Array.from({ length: n }, (_, i) => svg`<g transform=${`rotate(${(i * 360) / n})`}>${E(0, -r * 0.5, r * width, r * 0.46, color, false)}</g>`);
  return svg`<g class="blades">${b}</g>`;
}

const dark = (c: string, k = 0.18) => tone(c, -k);
const light = (c: string, k = 0.14) => tone(c, k);

/** n chairs around a rectangle (top/bottom first, ends for larger counts). */
function chairsAround(w: number, h: number, n: number, color: string, round = false): SVGTemplateResult[] {
  const out: SVGTemplateResult[] = [];
  const cw = 44;
  const cd = 42;
  if (round) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rx = w / 2 + 12;
      const ry = h / 2 + 12;
      out.push(svg`<g transform=${`translate(${Math.cos(a) * rx} ${Math.sin(a) * ry}) rotate(${(a * 180) / Math.PI + 90})`}>${R(-cw / 2, -cd / 2, cw, cd, 10, color)}${R(-cw / 2 + 4, cd / 2 - 9, cw - 8, 6, 3, dark(color))}</g>`);
    }
    return out;
  }
  const ends = n >= 6 ? 2 : 0;
  const side = n - ends;
  const top = Math.ceil(side / 2);
  const bottom = Math.floor(side / 2);
  const row = (k: number, y: number, rot: number) => {
    for (let i = 0; i < k; i++) {
      const x = -w / 2 + (w / k) * (i + 0.5);
      out.push(svg`<g transform=${`translate(${x} ${y}) rotate(${rot})`}>${R(-cw / 2, -cd / 2, cw, cd, 10, color)}${R(-cw / 2 + 4, -cd / 2 + 3, cw - 8, 6, 3, dark(color))}</g>`);
    }
  };
  row(top, -h / 2 - 8, 0);
  row(bottom, h / 2 + 8, 180);
  if (ends) {
    out.push(svg`<g transform=${`translate(${-w / 2 - 8} 0) rotate(-90)`}>${R(-cw / 2, -cd / 2, cw, cd, 10, color)}${R(-cw / 2 + 4, -cd / 2 + 3, cw - 8, 6, 3, dark(color))}</g>`);
    out.push(svg`<g transform=${`translate(${w / 2 + 8} 0) rotate(90)`}>${R(-cw / 2, -cd / 2, cw, cd, 10, color)}${R(-cw / 2 + 4, -cd / 2 + 3, cw - 8, 6, 3, dark(color))}</g>`);
  }
  return out;
}

// ---------- catalog ----------

const V = (id: string, de: string, en: string, extra: Partial<Variant> = {}): Variant => ({ id, de, en, ...extra });

/** Geometry of stairs in the piece's box: straight / L flights as tread rectangles, spiral as wedges (shared with 3D) */
export interface StairPlan {
  /** straight / L: tread rectangles in walking order [x0, y0, x1, y1] */
  treads: [number, number, number, number][];
  /** L: the landing square, reached after `split` treads */
  landing?: [number, number, number, number];
  split?: number;
  /** spiral: centre post radius, outer radius, start angle and sweep (rad, clockwise from +y) */
  spiral?: { r0: number; r1: number; a0: number; sweep: number };
  /** walking line (from the first step up) */
  line: Point2[];
}
type Point2 = [number, number];

/** Treads run from the front (+y) up towards the back; an L turns left at the top (flip: right) */
export function stairPlan(w: number, h: number, v: string, n: number): StairPlan {
  n = Math.max(3, Math.round(n));
  if (v === 'spiral') {
    const r1 = Math.min(w, h) / 2;
    const r0 = Math.max(6, r1 * 0.09);
    const sweep = Math.PI * 1.75;
    const a0 = 0;
    const rm = (r0 + r1) / 2 + r1 * 0.06;
    const line: Point2[] = [];
    const half = sweep / n / 2;
    for (let i = 0; i <= 24; i++) {
      const a = a0 + half + ((sweep - half * 2) * i) / 24;
      line.push([rm * Math.sin(-a), rm * Math.cos(a)]);
    }
    return { treads: [], spiral: { r0, r1, a0, sweep }, line };
  }
  if (v === 'l') {
    const sw = Math.min(100, w * 0.5, h * 0.5);
    const x0 = -w / 2;
    const x1 = w / 2;
    const y0 = -h / 2;
    const y1 = h / 2;
    const l1 = h - sw;
    const l2 = w - sw;
    const n1 = Math.max(1, Math.round((n * l1) / (l1 + l2)));
    const n2 = Math.max(1, n - n1);
    const treads: [number, number, number, number][] = [];
    for (let i = 0; i < n1; i++) treads.push([x1 - sw, y1 - (l1 * (i + 1)) / n1, x1, y1 - (l1 * i) / n1]);
    for (let i = 0; i < n2; i++) treads.push([x1 - sw - (l2 * (i + 1)) / n2, y0, x1 - sw - (l2 * i) / n2, y0 + sw]);
    const cx = x1 - sw / 2;
    const cy = y0 + sw / 2;
    return {
      treads,
      landing: [x1 - sw, y0, x1, y0 + sw],
      split: n1,
      line: [
        [cx, y1 - l1 / n1 / 2],
        [cx, cy + sw * 0.18],
        [cx - sw * 0.18, cy],
        [x0 + l2 / n2 / 2, cy],
      ],
    };
  }
  const treads: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) treads.push([-w / 2, h / 2 - (h * (i + 1)) / n, w / 2, h / 2 - (h * i) / n]);
  return { treads, line: [[0, h / 2 - h / n / 2], [0, -h / 2 + h / n / 2]] };
}

/** Stairs from above: treads, the walking line (dot at the bottom, arrow at the top — the architects' way) */
function drawStairs({ w, h, v, n, c, a }: DrawCtx): SVGTemplateResult {
  const sp = stairPlan(w, h, v, n);
  const ink = 'rgba(0, 0, 0, 0.42)';
  const line = sp.line;
  const [ex, ey] = line[line.length - 1];
  const [px, py] = line[line.length - 2];
  const dl = Math.hypot(ex - px, ey - py) || 1;
  const ux = (ex - px) / dl;
  const uy = (ey - py) / dl;
  const ah = Math.min(14, Math.max(7, Math.min(w, h) * 0.08));
  const arrow = `M ${ex - ux * ah - uy * ah * 0.6} ${ey - uy * ah + ux * ah * 0.6} L ${ex} ${ey} L ${ex - ux * ah + uy * ah * 0.6} ${ey - uy * ah - ux * ah * 0.6}`;
  const walk = svg`<polyline points=${line.map((p) => p.join(',')).join(' ')} style=${`fill:none;stroke:${ink};stroke-width:1.3;vector-effect:non-scaling-stroke;stroke-linejoin:round`}></polyline>
    <circle cx=${line[0][0]} cy=${line[0][1]} r=${Math.max(3, ah * 0.32)} style=${`fill:${ink}`}></circle>
    <path d=${arrow} style=${`fill:none;stroke:${ink};stroke-width:1.3;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round`}></path>`;
  if (sp.spiral) {
    const { r0, r1, a0, sweep } = sp.spiral;
    const steps = Math.max(3, Math.round(n));
    const at = (r: number, ang: number): Point2 => [r * Math.sin(-ang), r * Math.cos(ang)];
    const wedges = Array.from({ length: steps }, (_, i) => {
      const a = a0 + (sweep * i) / steps;
      const b = a0 + (sweep * (i + 1)) / steps;
      const p = [at(r0, a), at(r1, a), at(r1, b), at(r0, b)];
      const large = b - a > Math.PI ? 1 : 0;
      return PathD(`M ${p[0][0]} ${p[0][1]} L ${p[1][0]} ${p[1][1]} A ${r1} ${r1} 0 ${large} 1 ${p[2][0]} ${p[2][1]} L ${p[3][0]} ${p[3][1]} Z`, i % 2 ? c : light(c, 0.04));
    });
    return svg`${C(0, 0, r1, light(a, 0.0))}${wedges}${C(0, 0, r0, tone(c, -0.25))}${walk}`;
  }
  const treads = sp.treads.map(([x0, y0, x1, y1], i) => R(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 0.5, i % 2 ? c : light(c, 0.04)));
  return svg`${sp.landing ? R(sp.landing[0], sp.landing[1], sp.landing[2] - sp.landing[0], sp.landing[3] - sp.landing[1], 0.5, light(c, 0.06)) : nothing}${treads}${walk}`;
}


// ----- Garten / Energie / Fahrzeug (3D models in models.ts) -----
const lobes = (r: number, c: string, n = 7) =>
  svg`${C(0, 0, r * 0.62, c)}${Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return C(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.46, tone(c, (i % 3) * 0.04 - 0.04), false);
  })}${C(-r * 0.18, -r * 0.2, r * 0.3, tone(c, 0.08), false)}`;

/** Bicycle / e-bike from above: two slim tyres, frame, saddle, handlebar across (front = +x) */
const bikeTop = (w: number, h: number, v: string, c: string, a: string, e: boolean) => {
  const cargo = v === 'cargo';
  const D = cargo ? Math.min(66, w * 0.26) : Math.min(72, w * 0.4);
  const Df = cargo ? D * 0.76 : D;
  const xr = -w / 2 + D / 2;
  const xf = w / 2 - Df / 2;
  const bar = cargo ? xf - Df / 2 - w * 0.3 : xf - 9;
  const tyre = (x: number, d: number) => R(x - d / 2, -2.6, d, 5.2, 2.6, a);
  return svg`${tyre(xr, D)}${tyre(xf, Df)}
    ${cargo ? R(bar + 8, -h / 2 + 3, xf - Df / 2 - bar - 12, h - 6, 4, light(c, 0.12)) : nothing}
    ${L(xr, 0, xf, 0, c, 3.5)}
    ${e ? svg`${R(xr + D * 0.55, -3.6, Math.min(D * 0.6, bar - xr - D * 0.6), 7.2, 3, dark(c, 0.3))}${BulbRect(xr + D * 0.62, -1, 5, 2, 1)}` : nothing}
    ${E(xr + D * 0.38, 0, 13, 7, a)}
    ${L(bar, -h / 2 + 4, bar, h / 2 - 4, a, 3)}${R(bar - 2, -h / 2 + 1, 4, 7, 2, a, false)}${R(bar - 2, h / 2 - 8, 4, 7, 2, a, false)}`;
};

/** E-scooter / kick scooter from above */
const scooterTop = (w: number, h: number, c: string, a: string) =>
  svg`${R(-w / 2, -2.5, 20, 5, 2.5, a)}${R(w / 2 - 20, -2.5, 20, 5, 2.5, a)}${R(-w / 2 + 12, -7, w - 36, 14, 5, c)}
    ${L(w / 2 - 14, -h / 2 + 3, w / 2 - 14, h / 2 - 3, a, 3)}${R(w / 2 - 16, -3, 6, 6, 2, dark(c, 0.2))}`;

/** Motorcycle / scooter from above */
const motoTop = (w: number, h: number, v: string, c: string, a: string) => {
  const tyre = '#1d1d1f';
  const bars = svg`${L(w * 0.26, -h / 2 + 3, w * 0.26, h / 2 - 3, a, 3)}${C(w * 0.25, -h / 2 + 5, 3.5, a, false)}${C(w * 0.25, h / 2 - 5, 3.5, a, false)}`;
  if (v === 'scooter')
    return svg`${R(-w / 2 + 4, -5, 44, 10, 5, tyre)}${R(w / 2 - 44, -5, 42, 10, 5, tyre)}
      ${E(-w * 0.2, 0, w * 0.26, h * 0.3, c)}${R(-w * 0.05, -h * 0.2, w * 0.28, h * 0.4, 6, light(c, 0.06))}
      ${R(-w * 0.38, -h * 0.15, w * 0.32, h * 0.3, h * 0.15, a)}${R(w * 0.2, -h * 0.27, w * 0.1, h * 0.54, 8, c)}${bars}`;
  return svg`${R(-w / 2, -6.5, 64, 13, 6.5, tyre)}${R(w / 2 - 60, -5.5, 60, 11, 5.5, tyre)}
    ${E(-w * 0.02, 0, w * 0.3, h * 0.24, c)}${E(w * 0.12, 0, w * 0.12, h * 0.23, light(c, 0.08))}
    ${R(-w * 0.32, -h * 0.15, w * 0.3, h * 0.3, h * 0.15, a)}${R(-w * 0.15, h * 0.18, w * 0.3, 7, 3.5, '#9aa0a6')}${bars}`;
};

/** Open parts of a car seen from above, in the alert colour: lids lifted, sunroof slid back, doors swung out, windows down */
const carOpenTop = (w: number, h: number, cabin: number[], o: CarOpen) => {
  const x = (f: number) => -w / 2 + w * f;
  const out: SVGTemplateResult[] = [];
  const red = (px: number, py: number, pw: number, ph: number, r = 4) => svg`<rect class="car-open" x=${px} y=${py} width=${pw} height=${ph} rx=${r}></rect>`;
  if (o.trunk) out.push(red(-w / 2 - 6, -h / 2 + 14, w * cabin[0] + 4, h - 28, 6));
  if (o.frunk) out.push(red(x(cabin[1]) + w * 0.04, -h / 2 + 14, w * (1 - cabin[1]) - w * 0.02, h - 28, 8));
  if (o.sunroof) out.push(red(x(cabin[0] + (cabin[1] - cabin[0]) * 0.3), -h / 2 + h * 0.3, w * (cabin[1] - cabin[0]) * 0.35, h * 0.4, 6));
  if (o.flap) out.push(svg`<circle class="car-open" cx=${x(0.16)} cy=${h / 2 - 6} r="7"></circle>`);
  // doors: fl, fr, rl, rr (front = +x, left = -y); swung out about their front edge
  const mid = (cabin[0] + cabin[1]) / 2;
  o.doors.forEach((open, i) => {
    if (!open) return;
    const front = i < 2;
    const left = i % 2 === 0;
    const x1 = x(front ? cabin[1] - 0.02 : mid);
    const len = w * (cabin[1] - cabin[0]) * 0.46;
    const y = left ? -h / 2 + 2 : h / 2 - 2;
    out.push(svg`<rect class="car-open" x=${x1 - len} y=${y - 3} width=${len} height="6" rx="3" transform=${`rotate(${left ? 35 : -35} ${x1} ${y})`}></rect>`);
  });
  o.windows.forEach((open, i) => {
    if (!open) return;
    const front = i < 2;
    const left = i % 2 === 0;
    const len = w * (cabin[1] - cabin[0]) * 0.4;
    const x0 = x(front ? mid + 0.02 : cabin[0] + 0.04);
    out.push(red(x0, left ? -h / 2 + 12 : h / 2 - 18, len, 6, 3));
  });
  return out;
};

const carTop = (w: number, h: number, c: string, a: string, v: string, open?: CarOpen) => {
  const cabin = v === 'smart_fortwo' ? [0.08, 0.86] : v.includes('v') && v.startsWith('merc_v') ? [0.04, 0.86] : [0.1, 0.7];
  const x = (f: number) => -w / 2 + w * f;
  return svg`${R(-w / 2 - 2, -h / 2 + 10, 26, 12, 4, '#1d1d1f', false)}${R(-w / 2 - 2, h / 2 - 22, 26, 12, 4, '#1d1d1f', false)}
    ${R(w / 2 - 30, -h / 2 + 10, 26, 12, 4, '#1d1d1f', false)}${R(w / 2 - 30, h / 2 - 22, 26, 12, 4, '#1d1d1f', false)}
    ${R(-w / 2, -h / 2 + 4, w, h - 8, Math.min(h, w) * 0.22, c)}
    ${R(x(cabin[0]), -h / 2 + 14, w * (cabin[1] - cabin[0]), h - 28, 18, '#2c3a46', false)}
    ${R(x(cabin[0]) + w * 0.06, -h / 2 + 22, w * (cabin[1] - cabin[0]) - w * 0.14, h - 44, 12, a, false)}
    ${R(w / 2 - 4, -h / 2 + 12, 4, 20, 2, '#fff7d6', false)}${R(w / 2 - 4, h / 2 - 32, 4, 20, 2, '#fff7d6', false)}
    ${R(-w / 2, -h / 2 + 12, 3, h - 24, 2, '#d8302a', false)}${open ? carOpenTop(w, h, cabin, open) : nothing}`;
};

export const FURNITURE: FurnitureKind[] = [
  // ----- Wohnen -----
  {
    kind: 'sofa', cat: 'living', de: 'Sofa', en: 'Sofa', icon: 'mdi:sofa-outline', w: 220, h: 95, height: 82, color: '#b7b4ae', accent: '#d9cfc1', palette: 'fabric',
    variants: [V('2', '2-Sitzer', '2-seater', { w: 170, h: 92 }), V('3', '3-Sitzer', '3-seater', { w: 220, h: 95 }), V('l', 'Ecksofa', 'Corner sofa', { w: 270, h: 180 }), V('u', 'Wohnlandschaft U', 'U-shaped', { w: 330, h: 200 })],
    draw: ({ w, h, v, c, a, flip }) => {
      const arm = Math.min(20, w * 0.09);
      const back = Math.min(22, h * 0.24);
      const x0 = -w / 2;
      const y0 = -h / 2;
      if (v === 'l' || v === 'u') {
        const d = Math.min(h * 0.55, 98);
        const cw = Math.min(w * 0.36, 100);
        const parts = [R(x0, y0, w, d, 14, c)];
        const chaise = (x: number) => parts.push(R(x, y0, cw, h, 14, c), R(x + (x < 0 ? back : 0) + 4, y0 + d, cw - back - 8, h - d - back * 0.4 - 6, 9, a));
        if (v === 'u') {
          chaise(x0);
          chaise(w / 2 - cw);
        } else chaise(flip ? x0 : w / 2 - cw);
        const seatsX0 = v === 'u' || flip ? x0 + cw : x0 + arm;
        const seatsX1 = v === 'u' || !flip ? w / 2 - cw : w / 2 - arm;
        const n = Math.max(1, Math.round((seatsX1 - seatsX0) / 70));
        const sw = (seatsX1 - seatsX0) / n;
        for (let i = 0; i < n; i++) parts.push(R(seatsX0 + i * sw + 2, y0 + back, sw - 4, d - back - 6, 9, a));
        return svg`${parts}`;
      }
      const n = v === '2' ? 2 : 3;
      const sw = (w - arm * 2) / n;
      const seats = Array.from({ length: n }, (_, i) => R(x0 + arm + i * sw + 2, y0 + back, sw - 4, h - back - 6, 9, a));
      return svg`${R(x0, y0, w, h, 14, c)}${seats}`;
    },
  },
  {
    kind: 'armchair', cat: 'living', de: 'Sessel', en: 'Armchair', icon: 'mdi:seat-outline', w: 85, h: 85, height: 80, color: '#c9b79c', accent: '#e7e1d6', palette: 'fabric',
    variants: [V('classic', 'Klassisch', 'Classic'), V('lounge', 'Lounge (rund)', 'Lounge (round)', { w: 90, h: 90 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'lounge'
        ? svg`${E(0, 0, w / 2, h / 2, c)}${E(0, h * 0.08, w * 0.34, h * 0.32, a)}`
        : svg`${R(-w / 2, -h / 2, w, h, 14, c)}${R(-w / 2 + 15, -h / 2 + 20, w - 30, h - 26, 9, a)}`,
  },
  {
    kind: 'coffee_table', cat: 'living', de: 'Couchtisch', en: 'Coffee table', icon: 'mdi:table-furniture', w: 110, h: 60, height: 42, color: '#d2a878', palette: 'wood', support: true,
    variants: [V('rect', 'Eckig', 'Rectangular'), V('round', 'Rund', 'Round', { w: 80, h: 80 }), V('oval', 'Oval', 'Oval', { w: 120, h: 70 })],
    draw: ({ w, h, v, c }) =>
      v === 'rect' ? svg`${R(-w / 2, -h / 2, w, h, 6, c)}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 4, light(c, 0.06), false)}` : svg`${E(0, 0, w / 2, h / 2, c)}${E(0, 0, w / 2 - 6, h / 2 - 6, light(c, 0.06), false)}`,
  },
  {
    kind: 'side_table', cat: 'living', de: 'Beistelltisch', en: 'Side table', icon: 'mdi:circle-outline', w: 45, h: 45, height: 50, color: '#d2a878', palette: 'wood', support: true, top3d: true,
    draw: ({ w, h, c }) => svg`${E(0, 0, w / 2, h / 2, c)}`,
  },
  {
    kind: 'tv_stand', cat: 'living', de: 'TV-Möbel', en: 'TV unit', icon: 'mdi:television-classic', w: 180, h: 42, height: 50, color: '#f4f4f2', accent: '#2c2c2e', palette: 'white', support: true,
    count: { de: 'Fächer', en: 'Compartments', min: 1, max: 6, def: 3 },
    draw: ({ w, h, n, c }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), -h / 2 + 4, -w / 2 + (w / n) * (i + 1), h / 2 - 4))}`,
  },
  {
    kind: 'tv', cat: 'tech', de: 'Fernseher', en: 'TV', icon: 'mdi:television', w: 145, h: 8, height: 85, color: '#1f1f21', keys: 'fernseher television screen bildschirm', palette: 'appliance', onTop: true, role: 'media',
    variants: [V('stand', 'Mit Standfuß', 'On stand'), V('wall', 'An der Wand', 'Wall mounted', { h: 6, elevation: 100 })],
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w * 0.12, h / 2 - 1, w * 0.24, 6, 2, dark(c, -0.3))}`,
  },
  {
    kind: 'sideboard', cat: 'living', de: 'Sideboard', en: 'Sideboard', icon: 'mdi:dresser-outline', w: 180, h: 45, height: 80, color: '#e9e6df', palette: 'white', support: true,
    count: { de: 'Türen', en: 'Doors', min: 2, max: 6, def: 4 },
    draw: ({ w, h, n, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), -h / 2 + 3, -w / 2 + (w / n) * (i + 1), h / 2 - 3))}`,
  },
  {
    kind: 'shelf', cat: 'living', de: 'Regal', en: 'Shelf', icon: 'mdi:bookshelf', w: 120, h: 35, height: 180, color: '#f4f4f2', accent: '#b98c76', palette: 'white',
    variants: [V('open', 'Offen', 'Open'), V('books', 'Mit Büchern', 'With books')],
    count: { de: 'Felder', en: 'Sections', min: 1, max: 8, def: 3 },
    draw: ({ w, h, n, v, c, a }) => {
      const parts = [R(-w / 2, -h / 2, w, h, 2, c)];
      for (let i = 1; i < n; i++) parts.push(L(-w / 2 + (w / n) * i, -h / 2, -w / 2 + (w / n) * i, h / 2));
      if (v === 'books') {
        const cols = [a, dark(a, 0.2), light(a, 0.2), '#8aa0b5', '#a8b39a'];
        for (let i = 0; i < n; i++) {
          let x = -w / 2 + (w / n) * i + 3;
          let k = 0;
          while (x < -w / 2 + (w / n) * (i + 1) - 6) {
            const bw = 3 + ((i * 7 + k * 3) % 4);
            parts.push(R(x, -h / 2 + 4, bw, h - 10 - ((k * 5) % 6), 0.5, cols[(i + k) % cols.length], false));
            x += bw + 0.6;
            k++;
          }
        }
      }
      return svg`${parts}`;
    },
  },
  {
    kind: 'floor_lamp', cat: 'lighting', de: 'Stehlampe', en: 'Floor lamp', icon: 'mdi:floor-lamp-outline', w: 40, h: 40, height: 160, color: '#f4f4f2', accent: '#2c2c2e', keys: 'lampe licht leuchte', palette: 'white', top3d: true, role: 'light',
    variants: [V('round', 'Rund', 'Round'), V('arc', 'Bogenlampe', 'Arc lamp', { w: 160, h: 40 }), V('uplight', 'Deckenfluter', 'Uplight', { w: 34, h: 34, height: 180 }), V('tripod', 'Dreibein', 'Tripod', { w: 55, h: 55, height: 150 })],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'arc') return svg`${C(-w / 2 + 14, 0, 12, a)}${L(-w / 2 + 14, 0, w / 2 - 20, 0, a, 2)}${C(w / 2 - 20, 0, 20, c)}${Bulb(w / 2 - 20, 0, 8)}`;
      const r = Math.min(w, h) / 2;
      if (v === 'tripod')
        return svg`${[0, 120, 240].map((d) => L(0, 0, Math.sin((d * Math.PI) / 180) * r, -Math.cos((d * Math.PI) / 180) * r, a, 1.5))}${C(0, 0, r * 0.55, c)}${Bulb(0, 0, r * 0.22)}`;
      if (v === 'uplight') return svg`${C(0, 0, r, c)}${Bulb(0, 0, r * 0.72)}`;
      return svg`${C(0, 0, r, c)}${Bulb(0, 0, r / 3)}`;
    },
  },
  {
    kind: 'plant', cat: 'living', de: 'Pflanze', en: 'Plant', icon: 'mdi:sprout-outline', w: 50, h: 50, height: 120, color: '#6f9f62', accent: '#c9b9a0', palette: 'plant', top3d: true,
    variants: [V('large', 'Groß', 'Large'), V('small', 'Klein', 'Small', { w: 30, h: 30, height: 45 }), V('palm', 'Palme', 'Palm', { w: 80, h: 80, height: 170 })],
    draw: ({ w, h, v, c, a }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'palm') {
        const leaves = Array.from({ length: 7 }, (_, i) => {
          const ang = (i / 7) * Math.PI * 2;
          return E(Math.cos(ang) * r * 0.5, Math.sin(ang) * r * 0.5, r * 0.5, r * 0.16, i % 2 ? c : light(c), false);
        });
        return svg`${C(0, 0, r * 0.32, a)}<g>${leaves.map((l, i) => svg`<g transform=${`rotate(${(i / 7) * 360} 0 0)`}>${l}</g>`)}</g>${C(0, 0, r * 0.12, dark(c))}`;
      }
      return svg`${C(0, 0, r, a)}${C(-r * 0.25, -r * 0.2, r * 0.62, c, false)}${C(r * 0.3, r * 0.15, r * 0.55, light(c), false)}${C(-r * 0.1, r * 0.3, r * 0.45, dark(c, 0.1), false)}`;
    },
  },
  {
    kind: 'rug', cat: 'living', de: 'Teppich', en: 'Rug', icon: 'mdi:rug', w: 200, h: 140, height: 1, color: '#d9cfc1', accent: '#b98c76', palette: 'rug', top3d: true,
    variants: [V('rect', 'Eckig', 'Rectangular'), V('round', 'Rund', 'Round', { w: 160, h: 160 }), V('runner', 'Läufer', 'Runner', { w: 240, h: 80 }), V('stripes', 'Gestreift', 'Striped'), V('border', 'Mit Bordüre', 'With border'), V('shaggy', 'Hochflor', 'Shaggy')],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'round') return svg`${E(0, 0, w / 2, h / 2, c)}${svg`<ellipse cx="0" cy="0" rx=${w / 2 - 8} ry=${h / 2 - 8} style=${`fill:none;stroke:${P(a)};stroke-width:1.5;vector-effect:non-scaling-stroke`}></ellipse>`}`;
      const base = R(-w / 2, -h / 2, w, h, v === 'shaggy' ? 10 : 3, c);
      if (v === 'stripes') {
        const n = Math.max(3, Math.round(w / 30));
        return svg`${base}${Array.from({ length: n }, (_, i) => (i % 2 ? R(-w / 2 + (w / n) * i, -h / 2, w / n, h, 0, a, false) : ''))}`;
      }
      if (v === 'border') return svg`${base}${R(-w / 2 + 10, -h / 2 + 10, w - 20, h - 20, 2, light(c, 0.08))}${svg`<rect x=${-w / 2 + 16} y=${-h / 2 + 16} width=${w - 32} height=${h - 32} style=${`fill:none;stroke:${P(a)};stroke-width:1.5;vector-effect:non-scaling-stroke`}></rect>`}`;
      if (v === 'shaggy') {
        const dots = [];
        for (let x = -w / 2 + 8; x < w / 2 - 4; x += 10) for (let y = -h / 2 + 8; y < h / 2 - 4; y += 10) dots.push(C(x + ((y * 3) % 4), y, 2.2, dark(c, 0.06), false));
        return svg`${base}${dots}`;
      }
      return svg`${base}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 2, light(c, 0.05), false)}`;
    },
  },
  {
    kind: 'pouf', cat: 'living', de: 'Pouf / Hocker', en: 'Pouf', icon: 'mdi:circle-slice-8', w: 50, h: 50, height: 42, color: '#b98c76', palette: 'fabric', top3d: true,
    draw: ({ w, h, c }) => svg`${E(0, 0, w / 2, h / 2, c)}${E(0, 0, w / 2 - 7, h / 2 - 7, light(c, 0.08), false)}`,
  },
  {
    kind: 'piano', cat: 'living', de: 'Klavier', en: 'Piano', icon: 'mdi:piano', w: 150, h: 60, height: 125, color: '#1f1f21', palette: 'wood',
    draw: ({ w, h, c }) => {
      const keys = [];
      const kw = (w - 20) / 26;
      for (let i = 0; i < 26; i++) keys.push(R(-w / 2 + 10 + i * kw, h / 2 - 16, kw - 0.6, 14, 0.5, '#f4f4f2', false));
      return svg`${R(-w / 2, -h / 2, w, h, 4, c)}${keys}`;
    },
  },
  // ----- Essen -----
  {
    kind: 'dining_table', cat: 'dining', de: 'Esstisch', en: 'Dining table', icon: 'mdi:table-chair', w: 180, h: 90, height: 75, color: '#d2a878', accent: '#5c5d61', palette: 'wood', support: true,
    variants: [V('rect', 'Eckig', 'Rectangular'), V('round', 'Rund', 'Round', { w: 120, h: 120 }), V('oval', 'Oval', 'Oval', { w: 200, h: 100 })],
    count: { de: 'Stühle', en: 'Chairs', min: 0, max: 12, def: 6 },
    draw: ({ w, h, v, n, c, a }) => {
      const round = v !== 'rect';
      const chairs = chairsAround(w, h, n, a, round);
      const top = round ? E(0, 0, w / 2, h / 2, c) : R(-w / 2, -h / 2, w, h, 6, c);
      return svg`${chairs}${top}`;
    },
  },
  {
    kind: 'chair', cat: 'dining', de: 'Stuhl', en: 'Chair', icon: 'mdi:chair-rolling', w: 46, h: 48, height: 85, color: '#5c5d61', palette: 'fabric',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 10, c)}${R(-w / 2 + 4, -h / 2 + 3, w - 8, 7, 3, dark(c))}`,
  },
  {
    kind: 'bar_stool', cat: 'dining', de: 'Barhocker', en: 'Bar stool', icon: 'mdi:stool-outline', w: 40, h: 40, height: 75, color: '#3a3a3c', palette: 'metal', top3d: true,
    draw: ({ w, h, c }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) / 2 - 5, light(c, 0.15), false)}`,
  },
  {
    kind: 'bench', cat: 'dining', de: 'Bank', en: 'Bench', icon: 'mdi:table-picnic', w: 140, h: 38, height: 45, color: '#d2a878', palette: 'wood', support: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${L(-w / 2 + 6, 0, w / 2 - 6, 0)}`,
  },
  // ----- Schlafen -----
  {
    kind: 'bed', cat: 'sleeping', de: 'Bett', en: 'Bed', icon: 'mdi:bed-outline', w: 180, h: 205, height: 50, color: '#d2a878', accent: '#f4f4f2', palette: 'wood',
    variants: [V('double', 'Doppelbett', 'Double', { w: 180, h: 205 }), V('single', 'Einzelbett', 'Single', { w: 100, h: 205 }), V('king', 'Kingsize', 'King size', { w: 200, h: 215 }), V('box', 'Boxspring', 'Box spring', { w: 180, h: 210, height: 65 }), V('kids', 'Kinderbett', 'Kids bed', { w: 70, h: 140 })],
    draw: ({ w, h, v, c, a }) => {
      const x0 = -w / 2;
      const y0 = -h / 2;
      const two = w >= 140;
      const pw = two ? (w - 30) / 2 : w - 20;
      const frame = v === 'box' ? 4 : 7;
      return svg`${R(x0, y0, w, h, 10, c)}
        ${R(x0, y0, w, 14, 6, dark(c, 0.12))}
        ${R(x0 + frame, y0 + 18, w - frame * 2, h - 18 - frame, 6, light(a, 0.0))}
        ${R(x0 + 10, y0 + 22, pw, 30, 9, tone(a, -0.04))}${two ? R(x0 + 20 + pw, y0 + 22, pw, 30, 9, tone(a, -0.04)) : ''}
        ${R(x0 + frame, y0 + h * 0.42, w - frame * 2, h * 0.58 - frame, 6, tone(a, -0.08))}
        ${L(x0 + frame, y0 + h * 0.42 + 10, x0 + w - frame, y0 + h * 0.42 + 10, LINE)}`;
    },
  },
  {
    kind: 'nightstand', cat: 'sleeping', de: 'Nachttisch', en: 'Nightstand', icon: 'mdi:table-furniture', w: 45, h: 40, height: 50, color: '#d2a878', palette: 'wood', support: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${L(-w / 2 + 6, h / 2 - 8, w / 2 - 6, h / 2 - 8)}`,
  },
  {
    kind: 'wardrobe', cat: 'sleeping', de: 'Kleiderschrank', en: 'Wardrobe', icon: 'mdi:wardrobe-outline', w: 200, h: 60, height: 220, color: '#f4f4f2', palette: 'white',
    variants: [V('doors', 'Drehtüren', 'Hinged doors'), V('sliding', 'Schiebetüren', 'Sliding doors')],
    count: { de: 'Türen', en: 'Doors', min: 1, max: 8, def: 4 },
    draw: ({ w, h, v, n, c }) => {
      const parts = [R(-w / 2, -h / 2, w, h, 3, c)];
      if (v === 'sliding') {
        parts.push(L(-w / 2 + 4, h / 2 - 8, w / 2 - 4, h / 2 - 8), L(-w / 2 + 4, h / 2 - 4, w / 2 - 4, h / 2 - 4));
        for (let i = 1; i < n; i++) parts.push(L(-w / 2 + (w / n) * i, h / 2 - 9, -w / 2 + (w / n) * i, h / 2 - 3));
      } else for (let i = 1; i < n; i++) parts.push(L(-w / 2 + (w / n) * i, -h / 2 + 4, -w / 2 + (w / n) * i, h / 2 - 4));
      parts.push(L(-w / 2 + 6, -h / 2 + 8, w / 2 - 6, -h / 2 + 8, 'rgba(0,0,0,0.1)'));
      return svg`${parts}`;
    },
  },
  {
    kind: 'dresser', cat: 'sleeping', de: 'Kommode', en: 'Dresser', icon: 'mdi:dresser-outline', w: 120, h: 50, height: 90, color: '#f4f4f2', palette: 'white', support: true,
    count: { de: 'Schubladen', en: 'Drawers', min: 1, max: 6, def: 3 },
    draw: ({ w, h, n, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), -h / 2 + 3, -w / 2 + (w / n) * (i + 1), h / 2 - 3))}`,
  },
  {
    kind: 'vanity', cat: 'sleeping', de: 'Schminktisch', en: 'Vanity', icon: 'mdi:mirror-variant', w: 100, h: 45, height: 76, color: '#f4f4f2', accent: '#d9cfc1', palette: 'white', support: true,
    draw: ({ w, h, c, a }) => svg`${C(0, h / 2 + 14, 16, a)}${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w * 0.3, -h / 2, w * 0.6, 4, 1, '#c9d8e6', false)}`,
  },
  {
    kind: 'crib', cat: 'sleeping', de: 'Babybett', en: 'Crib', icon: 'mdi:baby-carriage', w: 70, h: 130, height: 90, color: '#f4f4f2', accent: '#e6c9c1', palette: 'white',
    draw: ({ w, h, c, a }) => {
      const bars = [];
      for (let x = -w / 2 + 6; x < w / 2 - 3; x += 7) bars.push(L(x, -h / 2 + 2, x, -h / 2 + 6), L(x, h / 2 - 6, x, h / 2 - 2));
      return svg`${R(-w / 2, -h / 2, w, h, 6, c)}${R(-w / 2 + 6, -h / 2 + 8, w - 12, h - 16, 4, a)}${bars}`;
    },
  },
  // ----- Arbeiten -----
  {
    kind: 'desk', cat: 'work', de: 'Schreibtisch', en: 'Desk', icon: 'mdi:desk', w: 140, h: 70, height: 75, color: '#e9e6df', accent: '#3a3a3c', palette: 'wood', support: true,
    variants: [V('straight', 'Gerade', 'Straight'), V('l', 'L-Form', 'L-shaped', { w: 160, h: 140 }), V('standing', 'Höhenverstellbar', 'Standing desk', { w: 160, h: 80 })],
    draw: ({ w, h, v, c, a, flip }) => {
      if (v === 'l') {
        const d = Math.min(70, h * 0.5);
        const legx = flip ? -w / 2 : w / 2 - d;
        return svg`${R(-w / 2, -h / 2, w, d, 4, c)}${R(legx, -h / 2, d, h, 4, c)}${R(-w / 4, -h / 2 + 6, w / 3, 5, 2, a, false)}`;
      }
      return svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w * 0.22, -h / 2 + 7, w * 0.44, 5, 2, a, false)}${v === 'standing' ? R(-w / 2 + 6, h / 2 - 10, 14, 6, 2, a, false) : ''}`;
    },
  },
  {
    kind: 'office_chair', cat: 'work', de: 'Bürostuhl', en: 'Office chair', icon: 'mdi:chair-rolling', w: 60, h: 60, height: 110, color: '#3a3a3c', palette: 'fabric', top3d: true,
    draw: ({ w, h, c }) => {
      const r = Math.min(w, h) / 2;
      const legs = Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return L(0, 0, Math.cos(a) * r, Math.sin(a) * r, dark(c, -0.4), 2);
      });
      return svg`${legs}${C(0, 4, r * 0.62, c)}${R(-r * 0.62, -r * 0.72, r * 1.24, r * 0.32, 6, dark(c, -0.2))}`;
    },
  },
  {
    kind: 'monitor', cat: 'work', de: 'Monitor', en: 'Monitor', icon: 'mdi:monitor', w: 60, h: 18, height: 45, color: '#1f1f21', palette: 'appliance', onTop: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, 3, 1, c)}${R(-8, -h / 2 + 3, 16, h - 3, 3, dark(c, -0.3))}`,
  },
  {
    kind: 'computer', cat: 'work', de: 'PC', en: 'Computer', icon: 'mdi:desktop-tower', w: 22, h: 45, height: 45, color: '#2c2c2e', palette: 'appliance',
    variants: [V('tower', 'Tower', 'Tower'), V('big', 'Großer PC (Glas, RGB)', 'Big PC (glass, RGB)', { w: 24, h: 50, height: 52 })],
    draw: ({ w, h, v, c }) =>
      v === 'big'
        ? svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 2, -h / 2 + 3, w * 0.55, h - 6, 2, '#3a4458')}${BulbRect(-w / 2 + 3, h / 2 - 6, w * 0.5, 2, 1)}`
        : svg`${R(-w / 2, -h / 2, w, h, 3, c)}${C(0, -h / 2 + 6, 2, '#6fb6ff', false)}`,
  },
  {
    kind: 'printer', cat: 'work', de: 'Drucker', en: 'Printer', icon: 'mdi:printer-outline', w: 45, h: 38, height: 25, color: '#f4f4f2', palette: 'appliance', onTop: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 6, -h / 2 + 4, w - 12, 8, 2, dark(c, 0.1))}`,
  },
  // ----- Küche: Möbel -----
  {
    kind: 'counter', cat: 'kitchen', de: 'Küchenzeile', en: 'Kitchen counter', icon: 'mdi:countertop-outline', w: 240, h: 62, height: 90, color: '#f4f4f2', accent: '#c8c0b4', palette: 'white', support: true,
    variants: [V('straight', 'Gerade', 'Straight'), V('l', 'L-Form', 'L-shaped', { w: 240, h: 180 })],
    count: { de: 'Module', en: 'Modules', min: 1, max: 10, def: 4 },
    draw: ({ w, h, v, n, c, a, flip }) => {
      const d = 62;
      if (v === 'l') {
        const lx = flip ? -w / 2 : w / 2 - d;
        return svg`${R(-w / 2, -h / 2, w, d, 2, a)}${R(lx, -h / 2, d, h, 2, a)}
          ${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + ((w - d) / n) * (i + 1) + (flip ? d : 0), -h / 2 + d - 4, -w / 2 + ((w - d) / n) * (i + 1) + (flip ? d : 0), -h / 2 + d, tone(c, -0.3)))}
          ${L(-w / 2, -h / 2 + d - 3, w / 2, -h / 2 + d - 3, tone(c, -0.15))}`;
      }
      return svg`${R(-w / 2, -h / 2, w, h, 2, a)}${L(-w / 2 + 2, h / 2 - 3, w / 2 - 2, h / 2 - 3, tone(c, -0.15))}
        ${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), h / 2 - 5, -w / 2 + (w / n) * (i + 1), h / 2, tone(c, -0.3)))}`;
    },
  },
  {
    kind: 'island', cat: 'kitchen', de: 'Kücheninsel', en: 'Kitchen island', icon: 'mdi:island', w: 180, h: 90, height: 92, color: '#f4f4f2', accent: '#c8c0b4', palette: 'white', support: true,
    count: { de: 'Barhocker', en: 'Stools', min: 0, max: 6, def: 0 },
    draw: ({ w, h, n, a }) => {
      const stools = Array.from({ length: n }, (_, i) => C(-w / 2 + (w / n) * (i + 0.5), h / 2 + 22, 17, '#3a3a3c'));
      return svg`${stools}${R(-w / 2, -h / 2, w, h, 3, a)}${L(-w / 2 + 4, h / 2 - 12, w / 2 - 4, h / 2 - 12, 'rgba(0,0,0,0.08)')}`;
    },
  },
  {
    kind: 'tall_cabinet', cat: 'kitchen', de: 'Hochschrank', en: 'Tall cabinet', icon: 'mdi:fridge-industrial-outline', w: 60, h: 60, height: 220, color: '#f4f4f2', palette: 'white',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${L(-w / 2 + 3, h / 2 - 4, w / 2 - 3, h / 2 - 4, tone(c, -0.25))}`,
  },
  {
    kind: 'wall_cabinet', cat: 'kitchen', de: 'Hängeschrank', en: 'Wall cabinet', icon: 'mdi:wardrobe', w: 120, h: 35, height: 70, color: '#f4f4f2', palette: 'white', elevation: 145,
    count: { de: 'Türen', en: 'Doors', min: 1, max: 8, def: 2 },
    draw: ({ w, h, n, c }) => svg`${Dash(-w / 2, -h / 2, w, h, 2, c)}${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), -h / 2 + 3, -w / 2 + (w / n) * (i + 1), h / 2 - 3, 'rgba(0,0,0,0.12)'))}`,
  },
  {
    kind: 'pantry', cat: 'kitchen', de: 'Vorratsregal', en: 'Pantry shelf', icon: 'mdi:shelf', w: 80, h: 40, height: 190, color: '#d2a878', accent: '#e3c9a0', palette: 'wood',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${[0, 1, 2, 3].map((i) => R(-w / 2 + 5 + i * ((w - 10) / 4), -h / 2 + 6, (w - 10) / 4 - 3, h - 12, 3, i % 2 ? a : light(a, 0.1), false))}`,
  },
  // ----- Küche: Geräte -----
  {
    kind: 'cooktop', cat: 'appliance', de: 'Kochfeld', en: 'Cooktop', icon: 'mdi:stove', w: 60, h: 52, height: 1, color: '#1f1f21', accent: '#9aa0a6', palette: 'appliance', onTop: true, top3d: true,
    variants: [V('induction', 'Induktion', 'Induction'), V('electric', 'Ceran', 'Ceramic'), V('gas', 'Gas', 'Gas'), V('flex', 'Flex-Zonen', 'Flex zones', { w: 80, h: 52 })],
    draw: ({ w, h, v, c, a }) => {
      const base = R(-w / 2, -h / 2, w, h, 4, c);
      if (v === 'flex') return svg`${base}${R(-w / 2 + 5, -h / 2 + 5, w * 0.45 - 6, h - 10, 4, light(c, 0.12), false)}${R(2, -h / 2 + 5, w / 2 - 7, h - 10, 4, light(c, 0.12), false)}`;
      const pos: [number, number, number][] = [[-w * 0.22, -h * 0.2, 0.2], [w * 0.22, -h * 0.2, 0.15], [-w * 0.22, h * 0.22, 0.15], [w * 0.22, h * 0.22, 0.2]];
      if (v === 'gas') return svg`${R(-w / 2, -h / 2, w, h, 4, dark(a, 0.1))}${pos.map(([x, y, r]) => svg`${C(x, y, Math.min(w, h) * r, '#2c2c2e')}${C(x, y, Math.min(w, h) * r * 0.45, a)}`)}`;
      return svg`${base}${pos.map(([x, y, r]) => Ring(x, y, Math.min(w, h) * r, v === 'induction' ? light(c, 0.35) : '#c94a3a', v === 'induction' ? 1.2 : 1.6))}`;
    },
  },
  {
    kind: 'range', cat: 'appliance', de: 'Herd (Standgerät)', en: 'Range', icon: 'mdi:stove', w: 60, h: 60, height: 90, color: '#f4f4f2', accent: '#1f1f21', palette: 'appliance', support: true,
    draw: ({ w, h, c, a }) =>
      svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 14, 3, a)}${[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => Ring(x * w * 0.2, -5 + y * h * 0.18, Math.min(w, h) * 0.13, light(a, 0.4)))}${[0, 1, 2, 3].map((i) => C(-w / 2 + 12 + i * ((w - 24) / 3), h / 2 - 5, 2.4, tone(c, -0.35), false))}`,
  },
  {
    kind: 'oven', cat: 'appliance', de: 'Backofen (Hochschrank)', en: 'Wall oven', icon: 'mdi:toaster-oven', w: 60, h: 60, height: 220, color: '#f4f4f2', accent: '#1f1f21', palette: 'white',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w / 2 + 4, h / 2 - 10, w - 8, 6, 2, a, false)}`,
  },
  {
    kind: 'hood', cat: 'appliance', de: 'Dunstabzug', en: 'Range hood', icon: 'mdi:fan', w: 60, h: 50, height: 60, color: '#b8bcc1', palette: 'metal', elevation: 160,
    variants: [V('wall', 'Wandhaube', 'Wall hood'), V('island', 'Inselhaube', 'Island hood', { w: 90, h: 60 })],
    draw: ({ w, h, c }) => svg`${Dash(-w / 2, -h / 2, w, h, 3, c)}${Dash(-w * 0.18, -h * 0.18, w * 0.36, h * 0.36, 2, dark(c, 0.1))}`,
  },
  {
    kind: 'sink', cat: 'appliance', de: 'Spüle', en: 'Sink', icon: 'mdi:faucet-variant', w: 80, h: 50, height: 1, color: '#d7dadd', palette: 'metal', onTop: true, top3d: true,
    variants: [V('single', 'Einzelbecken', 'Single bowl'), V('double', 'Doppelbecken', 'Double bowl', { w: 116, h: 50 }), V('drainer', 'Mit Abtropffläche', 'With drainer', { w: 100, h: 50 })],
    draw: ({ w, h, v, c }) => {
      const base = R(-w / 2, -h / 2, w, h, 5, c);
      const bowl = (x: number, bw: number) => R(x, -h / 2 + 9, bw, h - 15, 8, dark(c, 0.14));
      const tap = svg`${C(0, -h / 2 + 4.5, 2.6, dark(c, 0.4), false)}`;
      if (v === 'double') return svg`${base}${bowl(-w / 2 + 6, w / 2 - 9)}${bowl(3, w / 2 - 9)}${tap}`;
      if (v === 'drainer') {
        const lines = Array.from({ length: 5 }, (_, i) => L(w * 0.06, -h / 2 + 12 + i * ((h - 22) / 4), w / 2 - 6, -h / 2 + 12 + i * ((h - 22) / 4), tone(c, -0.18)));
        return svg`${base}${bowl(-w / 2 + 6, w * 0.48)}${lines}${svg`<g transform=${`translate(${-w * 0.2} 0)`}>${tap}</g>`}`;
      }
      return svg`${base}${bowl(-w / 2 + 7, w - 14)}${tap}`;
    },
  },
  {
    kind: 'fridge', cat: 'appliance', de: 'Kühlschrank', en: 'Fridge', icon: 'mdi:fridge-outline', w: 60, h: 65, height: 185, color: '#d7dadd', keys: 'kühlschrank refrigerator', palette: 'appliance',
    variants: [V('single', 'Standard', 'Standard'), V('side', 'Side-by-Side', 'Side by side', { w: 91, h: 72, height: 178 }), V('under', 'Unterbau', 'Under counter', { w: 60, h: 60, height: 85 })],
    draw: ({ w, h, v, c, live }) =>
      svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 3, -h / 2 + 3, w - 6, h - 10, 3, light(c, 0.08), false)}${L(-w / 2 + 4, h / 2 - 4, w / 2 - 4, h / 2 - 4, dark(c, 0.3))}${v === 'side' ? L(0, -h / 2 + 3, 0, h / 2 - 2, dark(c, 0.3)) : ''}${live?.count ? engraved(String(live.count), 0, -3, Math.min(w, h) * 0.5, c) : ''}`,
  },
  {
    kind: 'freezer', cat: 'appliance', de: 'Gefrierschrank', en: 'Freezer', icon: 'mdi:snowflake', w: 60, h: 65, height: 85, color: '#f4f4f2', palette: 'appliance',
    draw: ({ w, h, c }) => {
      const r = Math.min(w, h) * 0.18;
      const star = [0, 60, 120].map((a) => {
        const x = Math.cos((a * Math.PI) / 180) * r;
        const y = Math.sin((a * Math.PI) / 180) * r;
        return L(-x, -y, x, y, '#6fa8d0', 1.5);
      });
      return svg`${R(-w / 2, -h / 2, w, h, 4, c)}${L(-w / 2 + 4, h / 2 - 4, w / 2 - 4, h / 2 - 4, dark(c, 0.3))}${star}`;
    },
  },
  {
    kind: 'dishwasher', cat: 'appliance', de: 'Geschirrspüler', en: 'Dishwasher', icon: 'mdi:dishwasher', w: 60, h: 60, height: 85, color: '#d7dadd', palette: 'appliance', support: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 6, h / 2 - 9, w - 12, 4, 2, dark(c, 0.3), false)}`,
  },
  {
    kind: 'microwave', cat: 'appliance', de: 'Mikrowelle', en: 'Microwave', icon: 'mdi:microwave', w: 48, h: 38, height: 28, color: '#2c2c2e', accent: '#9aa0a6', palette: 'appliance', onTop: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 4, -h / 2 + 4, w * 0.62, h - 8, 3, light(c, 0.15), false)}${[0, 1, 2].map((i) => C(w / 2 - 8, -h / 2 + 9 + i * 8, 2, a, false))}`,
  },
  {
    kind: 'airfryer', cat: 'appliance', de: 'Airfryer', en: 'Air fryer', icon: 'mdi:pot-steam-outline', w: 30, h: 36, height: 32, color: '#2c2c2e', accent: '#9aa0a6', palette: 'appliance', onTop: true,
    variants: [V('single', 'Einzelkorb', 'Single basket'), V('dual', 'Doppelkorb', 'Dual basket', { w: 40, h: 38 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'dual'
        ? svg`${R(-w / 2, -h / 2, w, h, 7, c)}${R(-w / 2 + 3, -h / 2 + 4, w / 2 - 4, h - 12, 5, light(c, 0.12), false)}${R(1, -h / 2 + 4, w / 2 - 4, h - 12, 5, light(c, 0.12), false)}${R(-w / 2 + 4, h / 2 - 6, w - 8, 3, 1.5, a, false)}`
        : svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.4, c)}${C(0, -h * 0.08, Math.min(w, h) * 0.3, light(c, 0.12), false)}${R(-w * 0.18, h / 2 - 6, w * 0.36, 3, 1.5, a, false)}`,
  },
  {
    kind: 'thermomix', cat: 'appliance', de: 'Thermomix', en: 'Thermomix', icon: 'mdi:blender-outline', w: 33, h: 33, height: 32, color: '#f4f4f2', accent: '#9aa0a6', palette: 'appliance', onTop: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 9, c)}${C(0, -h * 0.08, Math.min(w, h) * 0.3, a)}${C(0, -h * 0.08, Math.min(w, h) * 0.16, light(a, 0.3), false)}${R(-w * 0.2, h / 2 - 7, w * 0.4, 4, 2, '#3a3a3c', false)}`,
  },
  {
    kind: 'kettle', cat: 'appliance', de: 'Wasserkocher', en: 'Kettle', icon: 'mdi:kettle-outline', w: 24, h: 20, height: 25, color: '#d7dadd', accent: '#2c2c2e', palette: 'metal', onTop: true, top3d: true,
    draw: ({ w, h, c, a }) => svg`${C(0, 0, Math.min(w, h) / 2.2, c)}${R(w * 0.24, -3, w * 0.24, 6, 3, a)}${L(-w * 0.22, -h * 0.1, -w * 0.48, -h * 0.25, dark(c, 0.3), 2.5)}`,
  },
  {
    kind: 'coffee', cat: 'appliance', de: 'Kaffeevollautomat', en: 'Coffee machine', icon: 'mdi:coffee-maker-outline', w: 26, h: 44, height: 38, color: '#2c2c2e', accent: '#c9a46a', palette: 'appliance', onTop: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.32, 3, light(c, 0.15), false)}${C(0, h * 0.22, w * 0.18, a, false)}`,
  },
  {
    kind: 'espresso', cat: 'appliance', de: 'Siebträger', en: 'Espresso machine', icon: 'mdi:coffee-outline', w: 36, h: 40, height: 40, color: '#b8bcc1', accent: '#2c2c2e', palette: 'metal', onTop: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.35, 2, light(c, 0.12), false)}${L(0, h * 0.1, 0, h / 2 + 8, a, 3)}${C(0, h * 0.1, w * 0.13, a)}`,
  },
  {
    kind: 'toaster', cat: 'appliance', de: 'Toaster', en: 'Toaster', icon: 'mdi:toaster', w: 30, h: 18, height: 20, color: '#d7dadd', palette: 'metal', onTop: true,
    variants: [V('2', '2 Scheiben', '2 slices'), V('4', '4 Scheiben', '4 slices', { w: 36, h: 28 })],
    draw: ({ w, h, v, c }) => {
      const slots = v === '4' ? [[-1, -1], [1, -1], [-1, 1], [1, 1]] : [[0, -1], [0, 1]];
      return svg`${R(-w / 2, -h / 2, w, h, 6, c)}${slots.map(([x, y]) => R(x * w * 0.22 - (v === '4' ? w * 0.18 : w * 0.34), y * h * 0.18 - 1.5, v === '4' ? w * 0.36 : w * 0.68, 3, 1.5, '#2c2c2e', false))}`;
    },
  },
  {
    kind: 'mixer', cat: 'appliance', de: 'Küchenmaschine', en: 'Stand mixer', icon: 'mdi:blender', w: 22, h: 36, height: 36, color: '#c94a3a', accent: '#d7dadd', palette: 'appliance', onTop: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 9, c)}${C(0, h * 0.12, w * 0.38, a)}${R(-w * 0.2, -h / 2 + 4, w * 0.4, h * 0.4, 6, dark(c, 0.1), false)}`,
  },
  {
    kind: 'blender', cat: 'appliance', de: 'Mixer', en: 'Blender', icon: 'mdi:blender-outline', w: 18, h: 18, height: 42, color: '#2c2c2e', accent: '#c9d8e6', palette: 'appliance', onTop: true, top3d: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${C(0, 0, Math.min(w, h) * 0.34, a)}`,
  },
  {
    kind: 'bread_maker', cat: 'appliance', de: 'Brotbackautomat', en: 'Bread maker', icon: 'mdi:baguette', w: 28, h: 36, height: 30, color: '#f4f4f2', palette: 'appliance', onTop: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 6, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h * 0.55, 4, '#9aa0a6', false)}`,
  },
  {
    kind: 'trash', cat: 'appliance', de: 'Mülleimer', en: 'Trash bin', icon: 'mdi:trash-can-outline', w: 32, h: 32, height: 65, color: '#d7dadd', palette: 'metal', top3d: true,
    variants: [V('round', 'Rund', 'Round'), V('sorting', 'Trennsystem', 'Sorting', { w: 60, h: 35 })],
    draw: ({ w, h, v, c }) =>
      v === 'sorting'
        ? svg`${R(-w / 2, -h / 2, w, h, 4, c)}${[0, 1, 2].map((i) => R(-w / 2 + 3 + i * ((w - 6) / 3), -h / 2 + 3, (w - 6) / 3 - 2, h - 6, 3, ['#c94a3a', '#e8c547', '#6f8f7a'][i], false))}`
        : svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) / 2 - 4, dark(c, 0.08), false)}`,
  },
  // ----- Bad -----
  {
    kind: 'bathtub', cat: 'bath', de: 'Badewanne', en: 'Bathtub', icon: 'mdi:bathtub-outline', w: 170, h: 75, height: 60, color: '#f4f4f2', palette: 'white',
    variants: [V('built', 'Eingebaut', 'Built-in'), V('free', 'Freistehend', 'Freestanding', { w: 170, h: 80 }), V('corner', 'Eckwanne', 'Corner', { w: 140, h: 140 })],
    draw: ({ w, h, v, c }) => {
      if (v === 'free') return svg`${E(0, 0, w / 2, h / 2, c)}${E(0, 0, w / 2 - 8, h / 2 - 8, light(c, 0.02))}${C(w / 2 - 18, 0, 3, '#9aa0a6', false)}`;
      if (v === 'corner') return svg`${PathD(`M ${-w / 2} ${-h / 2} H ${w / 2} V ${-h / 2 + h * 0.35} A ${w * 0.65} ${h * 0.65} 0 0 1 ${-w / 2 + w * 0.35} ${h / 2} H ${-w / 2} Z`, c)}${E(-w * 0.08, -h * 0.08, w * 0.3, h * 0.3, light(c, 0.02))}`;
      return svg`${R(-w / 2, -h / 2, w, h, 10, c)}${R(-w / 2 + 8, -h / 2 + 8, w - 16, h - 16, Math.min(w, h) / 2 - 8, light(c, 0.02))}${C(w / 2 - 16, 0, 3, '#9aa0a6', false)}`;
    },
  },
  {
    kind: 'shower', cat: 'bath', de: 'Dusche', en: 'Shower', icon: 'mdi:shower', w: 90, h: 90, height: 200, color: '#e9e6df', accent: '#a6d4f2', palette: 'white', top3d: true,
    variants: [V('square', 'Eckig', 'Square'), V('quarter', 'Viertelkreis', 'Quarter circle'), V('walkin', 'Walk-in', 'Walk-in', { w: 120, h: 90 })],
    draw: ({ w, h, v, c, a }) => {
      const drain = C(0, 0, 4, '#9aa0a6', false);
      if (v === 'quarter') return svg`${PathD(`M ${-w / 2} ${-h / 2} H ${w / 2} V ${-h / 2 + h * 0.3} A ${w * 0.7} ${h * 0.7} 0 0 1 ${-w / 2 + w * 0.3} ${h / 2} H ${-w / 2} Z`, c)}${svg`<path d=${`M ${w / 2} ${-h / 2 + h * 0.3} A ${w * 0.7} ${h * 0.7} 0 0 1 ${-w / 2 + w * 0.3} ${h / 2}`} style=${`fill:none;stroke:${P(a)};stroke-width:2.5;vector-effect:non-scaling-stroke`}></path>`}${drain}`;
      const glass = v === 'walkin' ? L(-w / 2 + w * 0.5, h / 2, w / 2, h / 2, a, 3) : svg`${L(-w / 2, h / 2, w / 2, h / 2, a, 3)}${L(w / 2, -h / 2, w / 2, h / 2, a, 3)}`;
      return svg`${R(-w / 2, -h / 2, w, h, 3, c)}${L(-w / 2, -h / 2, w / 2, h / 2, 'rgba(0,0,0,0.08)')}${L(w / 2, -h / 2, -w / 2, h / 2, 'rgba(0,0,0,0.08)')}${glass}${drain}`;
    },
  },
  {
    kind: 'toilet', cat: 'bath', de: 'WC', en: 'Toilet', icon: 'mdi:toilet', w: 38, h: 60, height: 40, color: '#f4f4f2', palette: 'white',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h * 0.28, 5, c)}${E(0, h * 0.12, w / 2 - 1, h * 0.36, c)}${E(0, h * 0.14, w / 2 - 7, h * 0.26, light(c, 0.02))}`,
  },
  {
    kind: 'washbasin', cat: 'bath', de: 'Waschtisch', en: 'Vanity basin', icon: 'mdi:hand-wash-outline', w: 60, h: 46, height: 85, color: '#f4f4f2', accent: '#d2a878', palette: 'white', support: true,
    variants: [V('single', 'Einzeln', 'Single'), V('double', 'Doppelwaschtisch', 'Double', { w: 120, h: 48 }), V('cabinet', 'Mit Unterschrank', 'With cabinet', { w: 80, h: 48 })],
    draw: ({ w, h, v, c, a }) => {
      const basin = (x: number) => svg`${E(x, 3, Math.min(w / (v === 'double' ? 4 : 2) - 8, 22), h / 2 - 9, light(c, 0.02))}${C(x, -h / 2 + 5, 2.2, '#9aa0a6', false)}`;
      const top = R(-w / 2, -h / 2, w, h, 6, v === 'single' ? c : a);
      return v === 'double' ? svg`${top}${basin(-w / 4)}${basin(w / 4)}` : svg`${top}${basin(0)}`;
    },
  },
  {
    kind: 'washer', cat: 'bath', de: 'Waschmaschine', en: 'Washer', icon: 'mdi:washing-machine', w: 60, h: 60, height: 85, color: '#f4f4f2', keys: 'waschmaschine washing machine', palette: 'appliance', support: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 5, c)}${Ring(0, 3, Math.min(w, h) * 0.3, dark(c, 0.3), 2)}${R(-w / 2 + 5, -h / 2 + 4, w - 10, 6, 2, dark(c, 0.08), false)}`,
  },
  {
    kind: 'dryer', cat: 'bath', de: 'Trockner', en: 'Dryer', icon: 'mdi:tumble-dryer', w: 60, h: 60, height: 85, color: '#f4f4f2', palette: 'appliance', support: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 5, c)}${Ring(0, 3, Math.min(w, h) * 0.3, dark(c, 0.3), 2)}${Ring(0, 3, Math.min(w, h) * 0.2, dark(c, 0.2), 1)}`,
  },
  {
    kind: 'towel_radiator', cat: 'bath', de: 'Handtuchheizkörper', en: 'Towel radiator', icon: 'mdi:radiator', w: 60, h: 8, height: 120, color: '#f4f4f2', palette: 'metal', elevation: 30, role: 'heat',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${L(-w / 2 + 4, 0, w / 2 - 4, 0, dark(c, 0.2))}`,
  },
  {
    kind: 'bath_cabinet', cat: 'bath', de: 'Spiegelschrank', en: 'Mirror cabinet', icon: 'mdi:mirror-rectangle', w: 80, h: 16, height: 70, color: '#c9d8e6', palette: 'metal', elevation: 130,
    draw: ({ w, h, c }) => svg`${Dash(-w / 2, -h / 2, w, h, 2, c)}`,
  },
  // ----- Haushalt & Technik -----
  {
    kind: 'robot_vacuum', cat: 'home', de: 'Saugroboter', en: 'Robot vacuum', icon: 'mdi:robot-vacuum', w: 35, h: 35, height: 10, color: '#2c2c2e', accent: '#9aa0a6', keys: 'roborock roomba dreame ecovacs staubsauger vacuum', palette: 'appliance', top3d: true,
    draw: ({ w, h, c, a }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, -Math.min(w, h) * 0.12, Math.min(w, h) * 0.15, a)}${R(-Math.min(w, h) * 0.4, Math.min(w, h) * 0.18, Math.min(w, h) * 0.8, 3, 1.5, light(c, 0.2), false)}`,
  },
  {
    kind: 'robot_dock', cat: 'home', de: 'Saugstation', en: 'Vacuum dock', icon: 'mdi:home-import-outline', w: 45, h: 45, height: 50, color: '#f4f4f2', accent: '#2c2c2e', palette: 'appliance',
    variants: [V('station', 'Absaug-/Wischstation', 'Self-empty/mop station'), V('dock', 'Ladestation', 'Charging dock', { w: 30, h: 12, height: 10 })],
    draw: ({ w, h, v, c }) =>
      v === 'dock'
        ? svg`${R(-w / 2, -h / 2, w, h * 0.8, 3, c)}${R(-w * 0.15, h * 0.3 - 1, w * 0.3, 1.5, 0.75, '#5fd0c6', false)}`
        : svg`${R(-w / 2 + 2, -h / 2 + h * 0.2, w - 4, h * 0.8, 6, '#3a3a3c')}${R(-w / 2, -h / 2, w, h * 0.76, 6, c)}${R(-w / 2 + 3, -h / 2 + 3, w / 2 - 4, h * 0.5, 3, light(c, 0.05))}${R(1, -h / 2 + 3, w / 2 - 4, h * 0.5, 3, light(c, 0.05))}${R(-w * 0.12, h * 0.24 - 1, w * 0.24, 1.6, 0.8, '#5fd0c6', false)}`,
  },
  {
    kind: 'stick_vacuum', cat: 'home', de: 'Akkusauger (Wand)', en: 'Stick vacuum', icon: 'mdi:vacuum-outline', w: 26, h: 22, height: 120, color: '#8d9297', accent: '#c94a3a', palette: 'appliance',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h * 0.4, 3, c)}${C(0, h * 0.15, Math.min(w, h) * 0.3, a)}`,
  },
  {
    kind: 'air_purifier', cat: 'climate', de: 'Luftreiniger', en: 'Air purifier', icon: 'mdi:air-purifier', w: 30, h: 30, height: 60, color: '#f4f4f2', accent: '#9aa0a6', palette: 'appliance', top3d: true, role: 'air',
    variants: [V('round', 'Rund', 'Round'), V('tower', 'Säule', 'Tower', { w: 32, h: 22, height: 80 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'tower'
        ? svg`${R(-w / 2, -h / 2, w, h, 6, c)}${BulbRect(-w / 2 + 5, -h / 2 + 4, w - 10, h - 8, 4)}${L(-w / 2 + 7, 0, w / 2 - 7, 0, a)}`
        : svg`${C(0, 0, Math.min(w, h) / 2, c)}${Bulb(0, 0, Math.min(w, h) * 0.34)}${Ring(0, 0, Math.min(w, h) * 0.18, a)}`,
  },
  {
    kind: 'fan', cat: 'climate', de: 'Ventilator', en: 'Fan', icon: 'mdi:fan', w: 40, h: 40, height: 110, color: '#f4f4f2', accent: '#9aa0a6', palette: 'appliance', top3d: true, role: 'fan',
    variants: [V('pedestal', 'Standventilator', 'Pedestal'), V('tower', 'Turmventilator', 'Tower', { w: 28, h: 28 }), V('desk', 'Tischventilator', 'Desk fan', { w: 26, h: 22, height: 36 })],
    draw: ({ w, h, v, c, a }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'tower') return svg`${C(0, 0, r, c)}${Ring(0, 0, r * 0.62, a)}${C(0, 0, r * 0.2, dark(a, 0.2), false)}`;
      return svg`${C(0, 0, r, c)}${Blades(r, 3, a)}${C(0, 0, r * 0.15, dark(a, 0.2), false)}`;
    },
  },
  {
    kind: 'radiator', cat: 'climate', de: 'Heizkörper', en: 'Radiator', icon: 'mdi:radiator', w: 100, h: 10, height: 60, color: '#f4f4f2', keys: 'heizung heizkörper thermostat', palette: 'white', elevation: 15, role: 'heat',
    draw: ({ w, h, c }) => {
      const fins = [];
      for (let x = -w / 2 + 5; x < w / 2 - 2; x += 6) fins.push(L(x, -h / 2 + 2, x, h / 2 - 2, 'rgba(0,0,0,0.12)'));
      return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${fins}`;
    },
  },
  {
    kind: 'ac', cat: 'climate', de: 'Klimagerät', en: 'Air conditioner', icon: 'mdi:air-conditioner', w: 85, h: 25, height: 30, color: '#f4f4f2', keys: 'klimaanlage aircon split', palette: 'appliance', elevation: 200, role: 'ac',
    variants: [V('split', 'Split-Wandgerät', 'Split unit'), V('portable', 'Mobil', 'Portable', { w: 45, h: 38, height: 75, elevation: 0 })],
    draw: ({ w, h, v, c }) =>
      v === 'portable'
        ? svg`${R(-w / 2, -h / 2, w, h, 6, c)}${BulbRect(-w / 2 + 6, -h / 2 + 5, w - 12, h * 0.35, 3)}${C(0, h * 0.18, Math.min(w, h) * 0.18, 'rgba(0,0,0,0.08)', false)}`
        : svg`${Dash(-w / 2, -h / 2, w, h, 6, c)}${BulbRect(-w / 2 + 6, h / 2 - 8, w - 12, 4, 2)}`,
  },
  {
    kind: 'speaker', cat: 'tech', de: 'Lautsprecher', en: 'Speaker', icon: 'mdi:speaker', w: 14, h: 14, height: 17, color: '#2c2c2e', accent: '#5c5d61', keys: 'sonos homepod echo alexa google nest box musik music soundbar', palette: 'appliance', onTop: true, top3d: true, role: 'media',
    variants: [
      V('round', 'HomePod', 'HomePod'),
      V('mini', 'HomePod mini', 'HomePod mini', { w: 10, h: 10, height: 8.5 }),
      V('box', 'Standlautsprecher', 'Floor speaker', { w: 20, h: 25, height: 100 }),
      V('soundbar', 'Soundbar', 'Soundbar', { w: 90, h: 10, height: 7 }),
    ],
    draw: ({ w, h, v, c, a }) => (v === 'box' ? svg`${R(-w / 2, -h / 2, w, h, 3, c)}${C(0, 0, Math.min(w, h) * 0.32, a)}` : svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.25, a, false)}`),
  },
  {
    kind: 'router', cat: 'network', de: 'Internet-Router', en: 'Internet router', icon: 'mdi:router-wireless', w: 25, h: 18, height: 6, color: '#f4f4f2', palette: 'appliance', onTop: true, role: 'network', keys: 'router wlan wifi internet fritzbox modem dsl glasfaser fiber speedport qr gäste-wlan guest',
    variants: [
      V('flat', 'Router', 'Router'),
      V('fritzbox', 'FRITZ!Box (flach)', 'FRITZ!Box (flat)', { w: 25, h: 17, height: 5 }),
      V('fritzbox_upright', 'FRITZ!Box (stehend)', 'FRITZ!Box (upright)', { w: 22, h: 6, height: 17 }),
      V('mesh', 'Mesh-Repeater', 'Mesh repeater', { w: 9, h: 9, height: 11, lib: true }),
      V('ont', 'Glasfaser-Modem (ONT)', 'Fibre modem (ONT)', { w: 16, h: 4, height: 20, lib: true }),
    ],
    draw: ({ w, h, v, c }) => {
      const leds = (n: number) => Array.from({ length: n }, (_, i) => C(-w / 2 + 5 + i * 3, h / 2 - 3, 0.9, '#34c759', false));
      if (v === 'fritzbox') return svg`${R(-w / 2, -h / 2, w, h, 4, '#f4f4f2')}${R(-w / 2 + 2, -h / 2 + 2, w - 4, h * 0.45, 3, '#d4222a')}${leds(5)}`;
      if (v === 'fritzbox_upright') return svg`${R(-w / 2, -h / 2, w, h, 2, '#f4f4f2')}${R(-w / 2, -h / 2, w * 0.3, h, 2, '#d4222a')}`;
      if (v === 'mesh') return svg`${R(-w / 2, -h / 2, w, h, 3, c)}${C(0, 0, 1.2, '#34c759', false)}`;
      if (v === 'ont') return svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${[0, 1, 2].map((i) => C(-w / 2 + 4 + i * 3, h / 2 - 1.2, 0.6, '#34c759', false))}`;
      return svg`${R(-w / 2, -h / 2, w, h, 3, c)}${leds(3)}`;
    },
  },
  {
    kind: 'laundry_rack', cat: 'bath', de: 'Wäscheständer', en: 'Drying rack', icon: 'mdi:hanger', w: 170, h: 55, height: 95, color: '#d7dadd', palette: 'metal',
    draw: ({ w, h, c }) => {
      const lines = [];
      for (let y = -h / 2 + 5; y < h / 2 - 2; y += 6) lines.push(L(-w / 2 + 4, y, w / 2 - 4, y, tone(c, -0.3)));
      return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${lines}`;
    },
  },
  {
    kind: 'ironing_board', cat: 'bath', de: 'Bügelbrett', en: 'Ironing board', icon: 'mdi:iron-outline', w: 120, h: 38, height: 90, color: '#8aa0b5', palette: 'fabric',
    draw: ({ w, h, c }) => PathD(`M ${-w / 2 + 8} ${-h / 2} H ${w / 2 - 22} Q ${w / 2} 0 ${w / 2 - 22} ${h / 2} H ${-w / 2 + 8} Q ${-w / 2} 0 ${-w / 2 + 8} ${-h / 2} Z`, c),
  },
  // ----- Flur -----
  {
    kind: 'coat_rack', cat: 'hall', de: 'Garderobe', en: 'Coat rack', icon: 'mdi:coat-rack', w: 100, h: 35, height: 180, color: '#e9e6df', accent: '#5c5d61', palette: 'wood',
    count: { de: 'Haken', en: 'Hooks', min: 2, max: 10, def: 5 },
    draw: ({ w, h, n, c, a }) => svg`${R(-w / 2, -h / 2, w, h * 0.3, 2, c)}${Array.from({ length: n }, (_, i) => C(-w / 2 + (w / n) * (i + 0.5), -h / 2 + h * 0.15, 3, a, false))}${R(-w / 2, h * 0.1, w, h * 0.4, 3, light(c, 0.05))}`,
  },
  {
    kind: 'shoe_cabinet', cat: 'hall', de: 'Schuhschrank', en: 'Shoe cabinet', icon: 'mdi:shoe-formal', w: 90, h: 30, height: 100, color: '#f4f4f2', palette: 'white', support: true,
    count: { de: 'Klappen', en: 'Flaps', min: 1, max: 5, def: 2 },
    draw: ({ w, h, n, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${Array.from({ length: n - 1 }, (_, i) => L(-w / 2 + (w / n) * (i + 1), -h / 2 + 3, -w / 2 + (w / n) * (i + 1), h / 2 - 3))}`,
  },
  {
    kind: 'mirror', cat: 'hall', de: 'Spiegel', en: 'Mirror', icon: 'mdi:mirror', w: 60, h: 5, height: 160, color: '#c9d8e6', palette: 'metal', elevation: 30,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}`,
  },
  {
    kind: 'stairs', cat: 'hall', de: 'Treppe', en: 'Stairs', icon: 'mdi:stairs', w: 100, h: 300, height: 100, color: '#d2a878', accent: '#f4f4f2', palette: 'wood',
    keys: 'treppe stufen stiege treppenhaus wendeltreppe stairs staircase steps spiral obergeschoss keller',
    variants: [
      V('straight', 'Gerade', 'Straight'),
      V('l', 'L-förmig (Podest)', 'L-shaped (landing)', { w: 200, h: 300, lib: { de: 'L-Treppe', en: 'L-shaped stairs' } }),
      V('spiral', 'Wendeltreppe', 'Spiral', { w: 160, h: 160, n: 12, lib: { de: 'Wendeltreppe', en: 'Spiral stairs' } }),
    ],
    count: { de: 'Stufen', en: 'Steps', min: 3, max: 24, def: 14 },
    draw: (c) => drawStairs(c),
  },
  // ----- Balkon -----
  {
    kind: 'patio_set', cat: 'outdoor', de: 'Balkontisch mit Stühlen', en: 'Patio set', icon: 'mdi:table-chair', w: 70, h: 70, height: 72, color: '#8d9297', accent: '#b98c76', palette: 'metal', support: true,
    count: { de: 'Stühle', en: 'Chairs', min: 0, max: 6, def: 2 },
    draw: ({ w, h, n, c, a }) => svg`${chairsAround(w, h, n, a, true)}${E(0, 0, w / 2, h / 2, c)}`,
  },
  {
    kind: 'lounger', cat: 'outdoor', de: 'Liege', en: 'Lounger', icon: 'mdi:beach', w: 190, h: 65, height: 40, color: '#e7e1d6', accent: '#8d9297', palette: 'fabric',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 10, a)}${R(-w / 2 + 6, -h / 2 + 6, w * 0.3, h - 12, 8, light(c, 0.05))}${R(-w / 2 + w * 0.33, -h / 2 + 6, w * 0.64, h - 12, 8, c)}`,
  },
  {
    kind: 'grill', cat: 'outdoor', de: 'Grill', en: 'Grill', icon: 'mdi:grill-outline', w: 60, h: 60, height: 95, color: '#2c2c2e', palette: 'metal', top3d: true,
    variants: [V('kettle', 'Kugelgrill', 'Kettle'), V('gas', 'Gasgrill', 'Gas grill', { w: 120, h: 55 })],
    draw: ({ w, h, v, c }) => {
      if (v === 'gas') {
        const bars = [];
        for (let x = -w * 0.3; x < w * 0.25; x += 6) bars.push(L(x, -h / 2 + 8, x, h / 2 - 8, tone(c, 0.35)));
        return svg`${R(-w / 2, -h / 2, w, h, 4, tone(c, 0.25))}${R(-w * 0.35, -h / 2 + 5, w * 0.62, h - 10, 4, c)}${bars}`;
      }
      const bars = [];
      for (let x = -Math.min(w, h) * 0.35; x <= Math.min(w, h) * 0.35; x += 6) bars.push(L(x, -Math.sqrt(Math.max(0, (Math.min(w, h) * 0.4) ** 2 - x * x)), x, Math.sqrt(Math.max(0, (Math.min(w, h) * 0.4) ** 2 - x * x)), tone(c, 0.35)));
      return svg`${C(0, 0, Math.min(w, h) / 2, c)}${bars}`;
    },
  },
  {
    kind: 'planter', cat: 'outdoor', de: 'Pflanzkasten', en: 'Planter', icon: 'mdi:flower-outline', w: 80, h: 25, height: 40, color: '#b98c76', accent: '#6f9f62', palette: 'wood',
    draw: ({ w, h, c, a }) => {
      const n = Math.max(2, Math.round(w / 18));
      return svg`${R(-w / 2, -h / 2, w, h, 3, c)}${Array.from({ length: n }, (_, i) => C(-w / 2 + (w / n) * (i + 0.5), 0, h * 0.34, i % 2 ? a : tone(a, 0.15), false))}`;
    },
  },
  // ----- Haustier -----
  {
    kind: 'pet_bed', cat: 'pets', de: 'Tierbett', en: 'Pet bed', icon: 'mdi:paw', w: 70, h: 55, height: 20, color: '#8f8a84', accent: '#e7e1d6', palette: 'fabric', top3d: true,
    draw: ({ w, h, c, a }) => svg`${E(0, 0, w / 2, h / 2, c)}${E(0, h * 0.05, w / 2 - 9, h / 2 - 9, a)}`,
  },
  {
    kind: 'cat_tree', cat: 'pets', de: 'Kratzbaum', en: 'Cat tree', icon: 'mdi:cat', w: 55, h: 55, height: 150, color: '#c9b79c', accent: '#8f8a84', palette: 'fabric',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 6, a)}${C(-w * 0.15, -h * 0.12, Math.min(w, h) * 0.22, c)}${C(w * 0.18, h * 0.16, Math.min(w, h) * 0.18, c)}`,
  },
  {
    kind: 'litter_box', cat: 'pets', de: 'Katzenklo', en: 'Litter box', icon: 'mdi:paw-outline', w: 50, h: 40, height: 40, color: '#d4d4d0', palette: 'white',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 8, c)}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 6, '#e3d3b5', false)}`,
  },
  {
    kind: 'food_bowls', cat: 'pets', de: 'Futternäpfe', en: 'Food bowls', icon: 'mdi:bowl-mix-outline', w: 40, h: 20, height: 6, color: '#8aa0b5', palette: 'appliance', top3d: true,
    draw: ({ w, h, c }) => svg`${C(-w / 4, 0, Math.min(w / 2, h) / 2 - 1, c)}${C(w / 4, 0, Math.min(w / 2, h) / 2 - 1, c)}`,
  },
  {
    kind: 'dog', cat: 'pets', de: 'Hund', en: 'Dog', icon: 'mdi:dog', w: 72, h: 26, height: 50, color: '#c8a27a', accent: '#f1ebe1', palette: 'fur', role: 'pet',
    variants: [
      V('medium', 'Mittelgroß', 'Medium', { w: 72, h: 26, height: 50 }),
      V('small', 'Klein', 'Small', { w: 44, h: 18, height: 30 }),
      V('dachshund', 'Dackel', 'Dachshund', { w: 60, h: 18, height: 26 }),
      V('retriever', 'Retriever', 'Retriever', { w: 92, h: 30, height: 60 }),
      V('shepherd', 'Schäferhund', 'Shepherd', { w: 95, h: 30, height: 63 }),
      V('husky', 'Husky', 'Husky', { w: 85, h: 30, height: 56 }),
      V('poodle', 'Pudel', 'Poodle', { w: 62, h: 24, height: 48 }),
      V('maltipoo', 'Maltipoo', 'Maltipoo', { w: 40, h: 18, height: 30 }),
      V('pug', 'Mops', 'Pug', { w: 44, h: 24, height: 30 }),
      V('frenchie', 'Franz. Bulldogge', 'French bulldog', { w: 46, h: 26, height: 32 }),
    ],
    draw: ({ w, h, c, a }) => {
      const hr = Math.min(h * 0.62, w * 0.2);
      return svg`${E(-w * 0.44, 0, w * 0.12, h * 0.12, c)}${E(-w * 0.04, 0, w * 0.36, h * 0.46, c)}${E(0, 0, w * 0.22, h * 0.26, a, false)}
        ${E(w * 0.3, 0, hr, hr * 0.95, c)}${E(w * 0.29, -hr * 0.85, hr * 0.42, hr * 0.28, tone(c, -0.12), false)}${E(w * 0.29, hr * 0.85, hr * 0.42, hr * 0.28, tone(c, -0.12), false)}
        ${E(w * 0.3 + hr * 0.75, 0, hr * 0.45, hr * 0.38, a, false)}${C(w * 0.3 + hr * 1.15, 0, Math.max(1, hr * 0.14), '#2a2222', false)}`;
    },
  },
  {
    kind: 'cat', cat: 'pets', de: 'Katze', en: 'Cat', icon: 'mdi:cat', w: 46, h: 20, height: 26, color: '#9aa0a6', accent: '#f1ebe1', palette: 'fur', role: 'pet',
    variants: [V('cat', 'Katze', 'Cat', { w: 46, h: 20, height: 26 }), V('large', 'Große Katze', 'Large cat', { w: 56, h: 24, height: 30 }), V('kitten', 'Kätzchen', 'Kitten', { w: 30, h: 13, height: 17 })],
    draw: ({ w, h, c, a }) => {
      const hr = Math.min(h * 0.6, w * 0.2);
      return svg`<path d=${`M ${-w * 0.36} 0 q ${-w * 0.2} ${h * 0.1} ${-w * 0.12} ${h * 0.55}`} fill="none" stroke=${c} stroke-width=${Math.max(2, h * 0.16)} stroke-linecap="round"></path>
        ${E(-w * 0.04, 0, w * 0.34, h * 0.45, c)}${E(w * 0.02, 0, w * 0.18, h * 0.22, a, false)}${E(w * 0.32, 0, hr, hr, c)}
        <path d=${`M ${w * 0.3} ${-hr * 0.6} l ${-hr * 0.2} ${-hr * 0.6} l ${hr * 0.5} ${hr * 0.35} Z M ${w * 0.3} ${hr * 0.6} l ${-hr * 0.2} ${hr * 0.6} l ${hr * 0.5} ${-hr * 0.35} Z`} fill=${tone(c, -0.1)}></path>`;
    },
  },


  // ---------- tech & media ----------
  {
    kind: 'console', cat: 'tech', de: 'Spielkonsole', en: 'Game console', icon: 'mdi:microsoft-xbox', w: 15, h: 15, height: 30, color: '#1f1f21', accent: '#4caf50', keys: 'playstation xbox nintendo switch spiele games', palette: 'appliance', onTop: true, role: 'media',
    variants: [
      V('xbox_x', 'Xbox Series X', 'Xbox Series X'),
      V('xbox_s', 'Xbox Series S', 'Xbox Series S', { w: 27.5, h: 15, height: 6.5 }),
      V('ps5', 'PlayStation 5', 'PlayStation 5', { w: 10, h: 26, height: 39 }),
      V('switch', 'Nintendo Switch (Dock)', 'Nintendo Switch (dock)', { w: 17, h: 5.5, height: 10.5 }),
    ],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'xbox_s') return svg`${R(-w / 2, -h / 2, w, h, 2, '#f4f4f2')}${C(w * 0.22, 0, Math.min(w, h) * 0.22, '#1f1f21', false)}`;
      if (v === 'ps5') return svg`${R(-w / 2, -h / 2, w, h, 4, '#f4f4f2')}${R(-w * 0.18, -h / 2 + 1, w * 0.36, h - 2, 2, '#1f1f21')}`;
      if (v === 'switch') return svg`${R(-w / 2, -h / 2, w, h, 1.5, '#2c2c2e')}${R(-w / 2 - 1, -h / 2, 2, h, 1, '#e4002b')}${R(w / 2 - 1, -h / 2, 2, h, 1, '#00a8e8')}`;
      return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${C(0, 0, Math.min(w, h) * 0.32, '#111', false)}${Ring(0, 0, Math.min(w, h) * 0.32, a, 1)}`;
    },
  },
  {
    kind: 'streaming_box', cat: 'tech', de: 'Streaming-Box', en: 'Streaming box', icon: 'mdi:apple', w: 9.3, h: 9.3, height: 3.1, color: '#1f1f21', keys: 'apple tv fire tv chromecast shield', palette: 'appliance', onTop: true, role: 'media',
    variants: [V('appletv', 'Apple TV', 'Apple TV'), V('stick', 'Streaming-Stick', 'Streaming stick', { w: 10, h: 3, height: 1.5 })],
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.22, c)}${C(0, 0, Math.min(w, h) * 0.12, '#3a3a3c', false)}`,
  },
  {
    kind: 'remote', cat: 'tech', de: 'Fernbedienung', en: 'Remote control', icon: 'mdi:remote', w: 4, h: 15, height: 1.5, color: '#2c2c2e', accent: '#9aa0a6', palette: 'appliance', onTop: true,
    variants: [V('tv', 'TV-Fernbedienung', 'TV remote', { w: 5, h: 18 }), V('siri', 'Siri Remote', 'Siri Remote', { w: 3.5, h: 13.5, height: 0.9 })],
    draw: ({ w, h, v, c, a }) => svg`${R(-w / 2, -h / 2, w, h, w / 2, v === 'siri' ? '#c9cdd2' : c)}${C(0, -h / 2 + w * 0.9, w * 0.32, v === 'siri' ? '#2c2c2e' : a, false)}${v === 'siri' ? '' : [0, 1, 2, 3].map((i) => C(0, -h * 0.05 + i * h * 0.1, w * 0.12, a, false))}`,
  },
  {
    kind: 'mini_pc', cat: 'network', de: 'Mini-PC / Home-Server', en: 'Mini PC / home server', icon: 'mdi:desktop-classic', w: 18, h: 18, height: 3.5, color: '#2c2c2e', palette: 'appliance', onTop: true, role: 'network', keys: 'nuc mac mini raspberry pi server home assistant tiny',
    variants: [V('tiny', 'Tiny PC', 'Tiny PC'), V('macmini', 'Mac mini', 'Mac mini', { w: 12.7, h: 12.7, height: 5 }), V('nuc', 'NUC', 'NUC', { w: 11.7, h: 11.2, height: 5.4 }), V('pi', 'Raspberry Pi', 'Raspberry Pi', { w: 9.5, h: 6.5, height: 3 })],
    draw: ({ w, h, v, c }) =>
      svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * (v === 'macmini' ? 0.18 : 0.08), v === 'macmini' ? '#d7dadd' : v === 'pi' ? '#c94a3a' : c)}${C(w / 2 - 2.5, h / 2 - 2, 0.8, '#6fb6ff', false)}`,
  },
  {
    kind: 'laptop', cat: 'work', de: 'Laptop', en: 'Laptop', icon: 'mdi:laptop', w: 31, h: 22, height: 21, color: '#b8bcc1', palette: 'metal', onTop: true, keys: 'notebook macbook',
    variants: [V('open', 'Aufgeklappt', 'Open'), V('closed', 'Zugeklappt', 'Closed', { height: 1.6 }), V('large', '16 Zoll aufgeklappt', '16 inch open', { w: 36, h: 25, height: 24 })],
    draw: ({ w, h, v, c }) =>
      v === 'closed'
        ? svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${C(0, 0, 1.5, tone(c, 0.15), false)}`
        : svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${R(-w / 2 + 1.5, -h / 2 + 2, w - 3, h * 0.55, 1, '#3a3a3c', false)}${R(-w * 0.18, h * 0.22, w * 0.36, h * 0.18, 1, tone(c, -0.08), false)}`,
  },
  {
    kind: 'hdmi_switch', cat: 'tech', de: 'HDMI-Switch', en: 'HDMI switch', icon: 'mdi:video-switch-outline', w: 20, h: 8, height: 2.5, color: '#1f1f21', palette: 'appliance', onTop: true,
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 1, c)}${[0, 1, 2, 3].map((i) => C(-w / 2 + 3 + i * 3, h / 2 - 2, 0.7, '#34c759', false))}`,
  },
  {
    kind: 'network', cat: 'network', de: 'Switch / NAS / Firewall', en: 'Switch / NAS / firewall', icon: 'mdi:lan', w: 21, h: 12, height: 4, color: '#1f1f21', accent: '#e86a2c', palette: 'appliance', onTop: true, role: 'network', keys: 'netzwerk network lan ethernet synology qnap speicher storage',
    variants: [V('firewall', 'Firewall', 'Firewall'), V('switch', 'Netzwerk-Switch', 'Network switch', { w: 28, h: 12, height: 3, lib: true }), V('nas', 'NAS', 'NAS', { w: 15, h: 22, height: 17, lib: { de: 'NAS (Netzwerkspeicher)', en: 'NAS (network storage)' } }), V('rack', 'Netzwerkschrank', 'Network rack', { w: 60, h: 60, height: 60 })],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'rack') return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 1, '#2c2c2e')}`;
      if (v === 'nas') return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${[0, 1].map((i) => R(-w / 2 + 2 + i * (w / 2 - 1), h / 2 - 3, w / 2 - 3, 1.5, 0.5, '#3a3a3c', false))}`;
      return svg`${R(-w / 2, -h / 2, w, h, 1, c)}${R(-w / 2, -h / 2, w, 1.5, 0.5, v === 'firewall' ? a : '#3a3a3c', false)}${Array.from({ length: v === 'switch' ? 8 : 4 }, (_, i) => C(-w / 2 + 3 + i * 3, h / 2 - 2, 0.6, '#34c759', false))}`;
    },
  },
  {
    kind: 'sensor', cat: 'security', de: 'Sensor / Melder', en: 'Sensor / detector', icon: 'mdi:motion-sensor', w: 4, h: 1.5, height: 4, color: '#f4f4f2', palette: 'appliance', elevation: 150, role: 'sensor', keys: 'temperatur thermometer hygrometer feuchte bewegung präsenz kontakt fenster tür rauch co kohlenmonoxid wasser leck taster schalter zigbee aqara motion presence contact smoke leak',
    variants: [
      V('temp', 'Temperatur / Feuchte', 'Temperature / humidity', { lib: { de: 'Temperatursensor', en: 'Temperature sensor' } }),
      V('display', 'Klima mit Display', 'Climate with display', { w: 6, h: 2, height: 6 }),
      V('motion', 'Bewegungsmelder', 'Motion sensor', { w: 4, h: 4, height: 4, elevation: 215, lib: true }),
      V('presence', 'Präsenzmelder (Decke)', 'Presence sensor (ceiling)', { w: 7, h: 7, height: 3, elevation: 248, ceiling: true, lib: true }),
      V('contact', 'Tür-/Fensterkontakt', 'Door/window contact', { w: 4.5, h: 1.5, height: 2, elevation: 110, lib: true }),
      V('smoke', 'Rauchmelder', 'Smoke detector', { w: 10, h: 10, height: 4, elevation: 246, ceiling: true, lib: true }),
      V('co', 'CO-Melder', 'CO detector', { w: 9, h: 3.5, height: 12, elevation: 150, lib: true }),
      V('leak', 'Wassermelder', 'Water leak', { w: 5, h: 5, height: 1.5, elevation: 0, lib: true }),
      V('button', 'Taster / Schalter', 'Button / switch', { w: 8.5, h: 1.5, height: 8.5, elevation: 110, lib: true }),
    ],
    draw: ({ w, h, v, c }) => {
      if (v === 'smoke' || v === 'leak') return svg`${v === 'smoke' ? DashC(0, 0, Math.min(w, h) / 2, c, 0.7) : C(0, 0, Math.min(w, h) / 2, c)}${Bulb(0, 0, Math.min(w, h) * 0.12)}`;
      if (v === 'motion') return svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.28, tone(c, -0.08), false)}${Bulb(0, 0, Math.min(w, h) * 0.1)}`;
      if (v === 'presence') return svg`${DashC(0, 0, Math.min(w, h) / 2, c, 0.7)}${Ring(0, 0, Math.min(w, h) * 0.3, tone(c, -0.2), 1)}${Bulb(0, 0, Math.min(w, h) * 0.1)}`;
      if (v === 'co') return svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${BulbRect(-w * 0.3, h / 2 - 1, w * 0.6, 0.8, 0.4)}`;
      return svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.3, c)}${v === 'display' ? BulbRect(-w / 2 + 1, -h / 2 + 0.3, w - 2, h - 0.6, 0.3) : ''}`;
    },
  },
  {
    kind: 'smart_plug', cat: 'security', de: 'Smarte Steckdose', en: 'Smart plug', icon: 'mdi:power-socket-de', w: 6, h: 4, height: 6, color: '#f4f4f2', palette: 'appliance', elevation: 30, keys: 'zwischenstecker steckdosenleiste shelly plug outlet power strip',
    variants: [V('plug', 'Zwischenstecker', 'Plug'), V('wall', 'Unterputz', 'In-wall', { w: 8.5, h: 1.5, height: 8.5 }), V('strip', 'Steckdosenleiste', 'Power strip', { w: 40, h: 6, height: 4, elevation: 0 })],
    draw: ({ w, h, v, c }) =>
      v === 'strip'
        ? svg`${R(-w / 2, -h / 2, w, h, 2, c)}${Array.from({ length: 5 }, (_, i) => C(-w / 2 + 6 + i * ((w - 12) / 4), 0, Math.min(h, 6) * 0.28, tone(c, -0.1), false))}${BulbRect(w / 2 - 4, -1, 2, 2, 1)}`
        : svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.3, c)}${BulbRect(-w / 2 + 1, h / 2 - 1, w - 2, 0.8, 0.4)}`,
  },

  // ---------- lighting ----------
  {
    kind: 'table_lamp', cat: 'lighting', de: 'Tischleuchte', en: 'Table lamp', icon: 'mdi:lamp-outline', w: 30, h: 30, height: 48, color: '#f1ebe1', accent: '#b8bcc1', keys: 'lampe licht leuchte nachttischlampe', palette: 'white', onTop: true, top3d: true, role: 'light',
    variants: [V('shade', 'Lampenschirm', 'Shade'), V('globe', 'Kugel', 'Globe', { w: 25, h: 25, height: 32 }), V('mushroom', 'Pilz', 'Mushroom', { w: 28, h: 28, height: 34 }), V('night', 'Nachtlicht', 'Night light', { w: 14, h: 14, height: 16 })],
    draw: ({ w, h, v, c }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'globe' || v === 'night') return svg`${Bulb(0, 0, r)}${Ring(0, 0, r, c, 1)}`;
      return svg`${C(0, 0, r, c)}${Bulb(0, 0, r * (v === 'mushroom' ? 0.55 : 0.4))}`;
    },
  },
  {
    kind: 'ceiling_lamp', cat: 'lighting', de: 'Deckenleuchte', en: 'Ceiling light', icon: 'mdi:ceiling-light-outline', w: 50, h: 50, height: 10, color: '#f4f4f2', accent: '#2c2c2e', keys: 'lampe licht leuchte deckenlampe spots', palette: 'white', elevation: 240, ceiling: true, top3d: true, role: 'light',
    variants: [
      V('flush', 'Flach', 'Flush'),
      V('pendant', 'Pendelleuchte', 'Pendant', { w: 40, h: 40, height: 28, elevation: 170 }),
      V('panel', 'LED-Panel', 'LED panel', { w: 120, h: 30, height: 5, elevation: 245 }),
      V('spots', 'Spots / Schiene', 'Spots / track', { w: 100, h: 12, height: 10, elevation: 240 }),
      V('chandelier', 'Kronleuchter', 'Chandelier', { w: 70, h: 70, height: 45, elevation: 185 }),
    ],
    count: { de: 'Spots', en: 'Spots', min: 1, max: 8, def: 3 },
    draw: ({ w, h, v, n, c, a }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'panel') return svg`${Dash(-w / 2, -h / 2, w, h, 3, c)}${BulbRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 2)}`;
      if (v === 'spots') {
        const k = Math.max(1, n);
        return svg`${Dash(-w / 2, -h / 4, w, h / 2, 2, a)}${Array.from({ length: k }, (_, i) => Bulb(-w / 2 + (w / k) * (i + 0.5), 0, Math.min(h / 2, w / k / 2.6)))}`;
      }
      if (v === 'chandelier')
        return svg`${DashC(0, 0, r, c, 0.25)}${Array.from({ length: 6 }, (_, i) => Bulb(Math.cos((i * Math.PI) / 3) * r * 0.7, Math.sin((i * Math.PI) / 3) * r * 0.7, r * 0.16))}${C(0, 0, r * 0.18, a)}`;
      return svg`${DashC(0, 0, r, c)}${Bulb(0, 0, r * (v === 'pendant' ? 0.5 : 0.7))}`;
    },
  },
  {
    kind: 'wall_lamp', cat: 'lighting', de: 'Wandleuchte', en: 'Wall light', icon: 'mdi:wall-sconce-outline', w: 22, h: 12, height: 22, color: '#f4f4f2', accent: '#2c2c2e', palette: 'white', elevation: 175, role: 'light',
    variants: [V('sconce', 'Wandleuchte', 'Sconce'), V('updown', 'Up & Down', 'Up & down', { w: 12, h: 12, height: 26 }), V('reading', 'Leselampe (Arm)', 'Reading arm', { w: 20, h: 40, height: 18, elevation: 120 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'reading'
        ? svg`${R(-5, -h / 2, 10, 4, 1, a)}${L(0, -h / 2 + 4, 0, h / 2 - 9, a, 1.5)}${C(0, h / 2 - 8, 8, c)}${Bulb(0, h / 2 - 8, 4)}`
        : svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) / 2, c)}${BulbRect(-w / 2 + 3, -h / 2 + h * 0.45, w - 6, h * 0.45, 3)}`,
  },
  {
    kind: 'light_strip', cat: 'lighting', de: 'LED-Streifen', en: 'LED strip', icon: 'mdi:led-strip-variant', w: 200, h: 3, height: 2, color: '#e9e6df', keys: 'led stripe lightstrip hue', palette: 'white', elevation: 90, role: 'light',
    variants: [
      V('behind', 'Hinter TV / Bett', 'Behind TV / bed'),
      V('floor', 'Sockelleiste', 'Baseboard', { elevation: 4 }),
      V('cabinet', 'Unter Hängeschrank', 'Under cabinet', { elevation: 143 }),
      V('desk', 'Tischkante', 'Desk edge', { elevation: 73 }),
      V('ceiling', 'Decke / Voute', 'Ceiling cove', { elevation: 246, ceiling: true }),
    ],
    draw: ({ w, h }) => BulbRect(-w / 2, -h / 2, w, Math.max(2, h), 2),
  },
  {
    kind: 'light_bar', cat: 'lighting', de: 'Lightbar / Ambiente', en: 'Light bar', icon: 'mdi:lightbulb-variant-outline', w: 6, h: 5, height: 25, color: '#2c2c2e', palette: 'appliance', onTop: true, top3d: true, role: 'light',
    variants: [V('bar', 'Lightbar', 'Bar'), V('cube', 'Würfel / Kugel', 'Cube / orb', { w: 14, h: 14, height: 14 }), V('go', 'Tragbar (Go)', 'Portable', { w: 15, h: 15, height: 8 })],
    draw: ({ w, h, v, c }) => (v === 'bar' ? svg`${R(-w / 2, -h / 2, w, h, 1, c)}${BulbRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 1)}` : Bulb(0, 0, Math.min(w, h) / 2)),
  },

  // ---------- climate & air ----------
  {
    kind: 'ceiling_fan', cat: 'climate', de: 'Deckenventilator', en: 'Ceiling fan', icon: 'mdi:ceiling-fan', w: 120, h: 120, height: 35, color: '#f4f4f2', accent: '#d2a878', palette: 'appliance', elevation: 215, ceiling: true, top3d: true, role: 'fan',
    count: { de: 'Flügel', en: 'Blades', min: 3, max: 6, def: 4 },
    draw: ({ w, h, n, c, a }) => {
      const r = Math.min(w, h) / 2;
      return svg`${DashC(0, 0, r, c, 0.12)}${Blades(r, Math.max(3, n), a, 0.12)}${C(0, 0, r * 0.14, c)}${Bulb(0, 0, r * 0.08)}`;
    },
  },
  {
    kind: 'space_heater', cat: 'climate', de: 'Heizgerät', en: 'Heater', icon: 'mdi:heat-wave', w: 34, h: 20, height: 38, color: '#f4f4f2', accent: '#3a3a3c', palette: 'appliance', role: 'heat',
    variants: [V('fan', 'Heizlüfter', 'Fan heater'), V('oil', 'Ölradiator', 'Oil radiator', { w: 60, h: 24, height: 65 }), V('infrared', 'Infrarot (Wand)', 'Infrared panel', { w: 100, h: 3, height: 60, elevation: 140 }), V('fireplace', 'Elektrokamin', 'Electric fireplace', { w: 100, h: 30, height: 60, lib: true })],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'oil') {
        const fins = [];
        for (let x = -w / 2 + 6; x < w / 2 - 3; x += 7) fins.push(R(x, -h / 2, 5, h, 2, c));
        return svg`${fins}${BulbRect(-w / 2 + 2, -1, w - 4, 2, 1)}`;
      }
      if (v === 'fireplace') return svg`${R(-w / 2, -h / 2, w, h, 3, a)}${BulbRect(-w / 2 + 8, -h / 2 + 6, w - 16, h - 12, 2)}`;
      return svg`${R(-w / 2, -h / 2, w, h, Math.min(4, h / 3), c)}${BulbRect(-w / 2 + 4, h / 2 - Math.max(2, h * 0.3), w - 8, Math.max(1.5, h * 0.22), 1)}`;
    },
  },
  {
    kind: 'humidifier', cat: 'climate', de: 'Luftbefeuchter', en: 'Humidifier', icon: 'mdi:air-humidifier', w: 26, h: 26, height: 35, color: '#f4f4f2', accent: '#9ac7e6', palette: 'appliance', top3d: true, role: 'air',
    variants: [V('humid', 'Luftbefeuchter', 'Humidifier'), V('dehumid', 'Luftentfeuchter', 'Dehumidifier', { w: 36, h: 25, height: 58, lib: true }), V('diffuser', 'Aroma-Diffuser', 'Diffuser', { w: 16, h: 16, height: 18 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'dehumid'
        ? svg`${R(-w / 2, -h / 2, w, h, 5, c)}${BulbRect(-w / 2 + 5, -h / 2 + 4, w - 10, 5, 2)}${L(-w / 2 + 6, 3, w / 2 - 6, 3, 'rgba(0,0,0,0.12)')}`
        : svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.3, a, false)}${Bulb(0, 0, Math.min(w, h) * 0.12)}`,
  },
  {
    kind: 'thermostat', cat: 'climate', de: 'Thermostat (Wand)', en: 'Wall thermostat', icon: 'mdi:thermostat', w: 10, h: 3, height: 10, color: '#f4f4f2', keys: 'thermostat heizung tado', palette: 'appliance', elevation: 150, role: 'heat',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 1, c)}${BulbRect(-w / 2 + 2, -h / 2 + 0.6, w - 4, Math.max(0.8, h - 1.2), 0.5)}`,
  },

  // ----- Garten -----
  {
    kind: 'tree', cat: 'garden', de: 'Baum', en: 'Tree', icon: 'mdi:tree-outline', w: 300, h: 300, height: 500, color: '#6f9f5a', accent: '#7d5639', palette: 'plant',
    variants: [V('deciduous', 'Laubbaum', 'Deciduous'), V('conifer', 'Nadelbaum', 'Conifer', { w: 200, h: 200, height: 600 }), V('fruit', 'Obstbaum', 'Fruit tree', { w: 260, h: 260, height: 380 }), V('birch', 'Birke', 'Birch', { w: 220, h: 220, height: 620 })],
    draw: ({ w, h, v, c }) => (v === 'conifer' ? svg`${C(0, 0, Math.min(w, h) / 2, tone(c, -0.06))}${C(0, 0, Math.min(w, h) * 0.34, c, false)}${C(0, 0, Math.min(w, h) * 0.16, tone(c, 0.06), false)}` : lobes(Math.min(w, h) / 2, c)),
  },
  {
    kind: 'bush', cat: 'garden', de: 'Strauch / Hecke', en: 'Bush / hedge', icon: 'mdi:sprout-outline', w: 100, h: 100, height: 90, color: '#5f8f4e', accent: '#e46aa0', palette: 'plant',
    variants: [V('round', 'Strauch', 'Bush'), V('flowering', 'Blühstrauch', 'Flowering'), V('hedge', 'Hecke', 'Hedge', { w: 300, h: 60, height: 150 })],
    draw: ({ w, h, v, c, a }) => (v === 'hedge' ? svg`${R(-w / 2, -h / 2, w, h, h * 0.45, c)}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, h * 0.35, tone(c, 0.06), false)}` : svg`${lobes(Math.min(w, h) / 2, c, 5)}${v === 'flowering' ? [0, 1, 2, 3, 4, 5].map((i) => C(Math.cos(i) * w * 0.28, Math.sin(i * 1.7) * h * 0.28, 4, a, false)) : nothing}`),
  },
  {
    kind: 'flower_bed', cat: 'garden', de: 'Blumenbeet', en: 'Flower bed', icon: 'mdi:flower-tulip-outline', w: 200, h: 100, height: 30, color: '#e8586b', accent: '#6b4a36', palette: 'plant',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.2, '#6b4a36')}${Array.from({ length: 14 }, (_, i) => C(-w / 2 + 12 + ((i * 37) % (w - 24)), -h / 2 + 12 + ((i * 23) % (h - 24)), 5, i % 3 ? ['#f2c14e', '#b07cd8', '#f4f4f2'][i % 3] : c, false))}`,
  },
  {
    kind: 'raised_bed', cat: 'garden', de: 'Hochbeet', en: 'Raised bed', icon: 'mdi:sprout', w: 200, h: 80, height: 85, color: '#6f9f5a', accent: '#b9875a', palette: 'wood',
    draw: ({ w, h, a }) => svg`${R(-w / 2, -h / 2, w, h, 3, a)}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 2, '#6b4a36', false)}${Array.from({ length: 6 }, (_, i) => C(-w / 2 + 20 + i * ((w - 40) / 5), 0, Math.min(10, h * 0.18), '#6f9f5a', false))}`,
  },
  {
    kind: 'lawn_mower', cat: 'garden', de: 'Mähroboter', en: 'Robotic mower', icon: 'mdi:robot-mower-outline', w: 62, h: 48, height: 26, color: '#f4f4f2', accent: '#3a3a3c', keys: 'mähroboter rasenmäher automower mower', palette: 'appliance', role: 'mower',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.32, c)}${R(-w / 2 + 6, -h / 2 + 5, w - 18, h - 10, Math.min(w, h) * 0.25, a, false)}${C(w * 0.18, 0, 4, '#d8483a', false)}`,
  },
  {
    kind: 'mower_dock', cat: 'garden', de: 'Mähroboter-Station', en: 'Mower dock', icon: 'mdi:home-lightning-bolt-outline', w: 70, h: 60, height: 30, color: '#f4f4f2', palette: 'appliance',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 8, '#3a3a3c')}${R(-w / 2, -h * 0.25, 14, h * 0.5, 4, c)}`,
  },
  {
    kind: 'sprinkler', cat: 'garden', de: 'Rasensprenger', en: 'Sprinkler', icon: 'mdi:sprinkler-variant', w: 20, h: 20, height: 15, color: '#3a3a3c', accent: '#5a8fd8', palette: 'appliance', role: 'water',
    variants: [V('popup', 'Versenkregner', 'Pop-up'), V('oscillating', 'Viereckregner', 'Oscillating', { w: 50, h: 20, height: 12 })],
    draw: ({ w, h, v, c, a }) => (v === 'oscillating' ? svg`${R(-w / 2, -h * 0.2, w, h * 0.4, 3, c)}${R(-w / 2 + 4, -2, w - 12, 4, 2, a, false)}` : svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) / 4, a, false)}`),
  },
  {
    kind: 'garden_light', cat: 'garden', de: 'Gartenleuchte', en: 'Garden light', icon: 'mdi:outdoor-lamp', w: 15, h: 15, height: 70, color: '#2c2c2e', palette: 'metal', role: 'light',
    variants: [V('bollard', 'Pollerleuchte', 'Bollard'), V('spot', 'Strahler', 'Spot', { w: 12, h: 12, height: 25 }), V('string', 'Lichterkette', 'String lights', { w: 400, h: 10, height: 250 })],
    draw: ({ w, h, v, c }) => (v === 'string' ? svg`${L(-w / 2, 0, w / 2, 0, c, 1.5)}${((n) => Array.from({ length: n + 1 }, (_, i) => Bulb(-w / 2 + (w * i) / n, 0, 3)))(Math.max(4, Math.round(w / 35)))}` : svg`${C(0, 0, Math.min(w, h) / 2, c)}${Bulb(0, 0, Math.min(w, h) * 0.3)}`),
  },
  {
    kind: 'parasol', cat: 'outdoor', de: 'Sonnenschirm', en: 'Parasol', icon: 'mdi:umbrella-beach-outline', w: 300, h: 300, height: 250, color: '#e9e6df', palette: 'fabric',
    variants: [V('classic', 'Mittelmast', 'Centre pole'), V('cantilever', 'Ampelschirm', 'Cantilever')],
    draw: ({ w, h, c }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${Array.from({ length: 8 }, (_, i) => L(0, 0, (Math.cos((i * Math.PI) / 4) * Math.min(w, h)) / 2, (Math.sin((i * Math.PI) / 4) * Math.min(w, h)) / 2, 'rgba(0,0,0,0.12)'))}`,
  },
  {
    kind: 'garden_bench', cat: 'outdoor', de: 'Gartenbank', en: 'Garden bench', icon: 'mdi:bench', w: 150, h: 60, height: 82, color: '#b9875a', palette: 'wood',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${[1, 2, 3].map((i) => L(-w / 2 + 3, -h / 2 + (h * i) / 4, w / 2 - 3, -h / 2 + (h * i) / 4))}`,
  },
  {
    kind: 'garden_lounge', cat: 'outdoor', de: 'Lounge-Möbel', en: 'Garden lounge', icon: 'mdi:sofa-outline', w: 220, h: 90, height: 70, color: '#8d9297', accent: '#e7e1d6', palette: 'fabric',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 8, c)}${R(-w / 2 + 6, -h / 2 + 20, w - 12, h - 26, 8, a)}`,
  },
  {
    kind: 'shed', cat: 'garden', de: 'Gartenhaus', en: 'Garden shed', icon: 'mdi:home-outline', w: 250, h: 200, height: 230, color: '#b9875a', accent: '#5e4030', palette: 'wood',
    draw: ({ w, h, a }) => svg`${R(-w / 2 - 8, -h / 2 - 8, w + 16, h + 16, 2, a)}${L(-w / 2 - 8, 0, w / 2 + 8, 0, 'rgba(0,0,0,0.25)', 1.5)}`,
  },
  {
    kind: 'greenhouse', cat: 'garden', de: 'Gewächshaus', en: 'Greenhouse', icon: 'mdi:greenhouse', w: 300, h: 200, height: 230, color: '#cfe3d6', palette: 'white',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${L(-w / 2, 0, w / 2, 0)}${[1, 2].map((i) => L(-w / 2 + (w * i) / 3, -h / 2, -w / 2 + (w * i) / 3, h / 2))}`,
  },
  {
    kind: 'trampoline', cat: 'garden', de: 'Trampolin', en: 'Trampoline', icon: 'mdi:circle-double', w: 300, h: 300, height: 250, color: '#3a6fb0', palette: 'appliance',
    draw: ({ w, h, c }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.43, '#2c2c2e', false)}`,
  },
  {
    kind: 'pool', cat: 'garden', de: 'Pool', en: 'Pool', icon: 'mdi:pool', w: 600, h: 300, height: 120, color: '#d9d9d6', palette: 'stone',
    keys: 'schwimmbad whirlpool hot tub jacuzzi swimming',
    variants: [V('rect', 'Eckig', 'Rectangular'), V('round', 'Rund (Aufstellpool)', 'Round', { w: 400, h: 400, height: 120 }), V('hottub', 'Whirlpool', 'Hot tub', { w: 210, h: 210, height: 90, lib: true })],
    draw: ({ w, h, v, c }) =>
      v === 'round'
        ? svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) / 2 - 5, '#5ec3e8', false)}`
        : v === 'hottub'
          ? svg`${R(-w / 2, -h / 2, w, h, 22, c)}${R(-w / 2 + 16, -h / 2 + 16, w - 32, h - 32, 26, '#5ec3e8', false)}${[0.3, 0.7].flatMap((fx) => [0.3, 0.7].map((fy) => C(-w / 2 + w * fx, -h / 2 + h * fy, 3, '#e9f6fb', false)))}`
          : svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 14, -h / 2 + 14, w - 28, h - 28, 3, '#4fb6e0', false)}`,
  },
  {
    kind: 'pond', cat: 'garden', de: 'Teich', en: 'Pond', icon: 'mdi:waves', w: 250, h: 180, height: 6, color: '#3f7f9a', palette: 'stone',
    draw: ({ w, h, c }) => svg`${E(0, 0, w / 2, h / 2, '#a8a29a')}${E(0, 0, w / 2 - 10, h / 2 - 10, c, false)}`,
  },
  {
    kind: 'fence', cat: 'garden', de: 'Zaun', en: 'Fence', icon: 'mdi:fence', w: 300, h: 8, height: 120, color: '#b9875a', accent: '#8b5e3c', palette: 'wood',
    variants: [V('wood', 'Holz', 'Wood'), V('metal', 'Metall', 'Metal', { color: '#2c2c2e' } as Partial<Variant>), V('gabion', 'Gabione', 'Gabion', { h: 30, height: 100 })],
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 1, c)}${Array.from({ length: Math.floor(w / 200) + 1 }, (_, i) => R(-w / 2 + i * 200 - 4, -h / 2 - 2, 8, h + 4, 1, tone(c, -0.15)))}`,
  },
  {
    kind: 'rain_barrel', cat: 'garden', de: 'Regentonne', en: 'Rain barrel', icon: 'mdi:barrel-outline', w: 60, h: 60, height: 95, color: '#4f7f42', palette: 'plant',
    draw: ({ w, h, c }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) / 2 - 4, tone(c, -0.08), false)}`,
  },
  {
    kind: 'compost', cat: 'garden', de: 'Komposter', en: 'Compost bin', icon: 'mdi:compost', w: 100, h: 100, height: 90, color: '#8b5e3c', palette: 'wood',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 2, '#6b4a36', false)}`,
  },
  {
    kind: 'firepit', cat: 'outdoor', de: 'Feuerschale', en: 'Fire pit', icon: 'mdi:fire', w: 80, h: 80, height: 40, color: '#3a3a3c', palette: 'metal',
    draw: ({ w, h, c }) => svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.3, '#ff9a3a', false)}`,
  },
  {
    kind: 'swing', cat: 'garden', de: 'Schaukel', en: 'Swing', icon: 'mdi:human-child', w: 250, h: 150, height: 220, color: '#d8483a', accent: '#b9875a', palette: 'wood',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, 'none')}${L(-w / 2, -h / 2, -w / 2, h / 2, a, 4)}${L(w / 2, -h / 2, w / 2, h / 2, a, 4)}${L(-w / 2, 0, w / 2, 0, a, 4)}${R(-w * 0.2 - 20, -20, 40, 40, 3, c)}${R(w * 0.2 - 20, -20, 40, 40, 3, c)}`,
  },
  {
    kind: 'sandbox', cat: 'garden', de: 'Sandkasten', en: 'Sandbox', icon: 'mdi:shovel', w: 150, h: 150, height: 25, color: '#e8d9b0', accent: '#b9875a', palette: 'wood',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, a)}${R(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 2, c, false)}`,
  },
  // ----- Energie -----
  {
    kind: 'solar_panels', cat: 'energy', de: 'Solaranlage', en: 'Solar panels', icon: 'mdi:solar-panel', w: 340, h: 200, height: 0, color: '#1d2a44', accent: '#c9ccd0', keys: 'pv photovoltaik solar balkonkraftwerk module', palette: 'metal', role: 'energy',
    variants: [V('ground', 'Aufgeständert', 'Ground mount'), V('flat', 'Flach (Dach / Carport)', 'Flat (roof / carport)'), V('balcony', 'Balkonkraftwerk', 'Balcony power plant', { w: 230, h: 10, n: 2, lib: true })],
    count: { de: 'Module', en: 'Panels', min: 1, max: 40, def: 6 },
    draw: ({ w, h, v, n, c, a }) => {
      const cols = v === 'balcony' ? Math.max(1, n) : Math.max(1, Math.round(Math.sqrt((n * w) / Math.max(1, h) / 1.7)));
      const rows = Math.max(1, Math.ceil(n / cols));
      const pw = w / cols;
      const ph = h / rows;
      return svg`${Array.from({ length: n }, (_, i) => {
        const x = -w / 2 + pw * (i % cols);
        const y = -h / 2 + ph * Math.floor(i / cols);
        // panel with its cell grid (reads as solar even when small)
        return svg`${R(x + 1, y + 1, pw - 2, ph - 2, 1, c)}${ph > 20 ? L(x + 3, y + ph / 2, x + pw - 3, y + ph / 2, light(c, 0.22)) : nothing}${pw > 20 ? L(x + pw / 2, y + 3, x + pw / 2, y + ph - 3, light(c, 0.22)) : nothing}`;
      })}${L(-w / 2, -h / 2, w / 2, -h / 2, a)}`;
    },
  },
  {
    kind: 'inverter', cat: 'energy', de: 'Wechselrichter', en: 'Inverter', icon: 'mdi:sine-wave', w: 50, h: 20, height: 60, color: '#f4f4f2', keys: 'wechselrichter inverter pv', palette: 'appliance', elevation: 120, role: 'energy',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${BulbRect(-w * 0.3, h / 2 - 3, w * 0.4, 2, 1)}`,
  },
  {
    kind: 'home_battery', cat: 'energy', de: 'Batteriespeicher', en: 'Home battery', icon: 'mdi:home-battery-outline', w: 60, h: 22, height: 110, color: '#f4f4f2', accent: '#c9ccd0', keys: 'akku speicher batterie powerwall battery storage', palette: 'appliance', role: 'energy',
    variants: [V('wall', 'Wandspeicher', 'Wall unit'), V('tower', 'Turm (Module)', 'Tower (modules)', { w: 60, h: 30, height: 120 })],
    count: { de: 'Module (Turm)', en: 'Modules (tower)', min: 2, max: 6, def: 3 },
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-3, h / 2 - 3, 6, 2, 1, '#5fd06b', false)}`,
  },
  {
    kind: 'wallbox', cat: 'energy', de: 'Wallbox', en: 'Wallbox', icon: 'mdi:ev-station', w: 25, h: 15, height: 40, color: '#f4f4f2', accent: '#2c2c2e', keys: 'ladestation ladesäule ev charger laden e-auto elektroauto', palette: 'appliance', elevation: 110, role: 'energy',
    variants: [V('wall', 'Wandmontage', 'Wall mounted'), V('pillar', 'Ladesäule', 'Charging post', { w: 30, h: 25, height: 140, elevation: 0, lib: true })],
    draw: ({ w, h, v, c, a }) =>
      v === 'pillar'
        ? svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w * 0.4, h / 2 - 3, w * 0.8, 2.5, 1, a, false)}${C(0, -h * 0.05, Math.min(w, h) * 0.18, tone(c, -0.1), false)}`
        : svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w * 0.4, h / 2 - 3, w * 0.8, 2.5, 1, a, false)}`,
  },
  {
    kind: 'heat_pump', cat: 'energy', de: 'Wärmepumpe', en: 'Heat pump', icon: 'mdi:heat-pump-outline', w: 100, h: 40, height: 90, color: '#e9e6df', keys: 'wärmepumpe außengerät heat pump', palette: 'appliance', role: 'energy',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${C(-w * 0.12, 0, Math.min(h * 0.4, w * 0.3), '#2f3134', false)}`,
  },
  // ----- Fahrzeug -----
  {
    kind: 'car', cat: 'vehicle', de: 'Auto', en: 'Car', icon: 'mdi:car-side', w: 430, h: 180, height: 148, color: '#c9ccd0', accent: '#1f1f21', keys: 'auto pkw elektroauto e-auto vehicle', palette: 'car', role: 'car',
    variants: Object.entries(CARS).map(([id, c]) => V(id, c.de, c.en, { w: c.L, h: c.W, height: c.H })),
    draw: ({ w, h, v, c, a, live }) => carTop(w, h, c, a, v, live?.car),
  },
  {
    kind: 'bicycle', cat: 'vehicle', de: 'Fahrrad', en: 'Bicycle', icon: 'mdi:bicycle', w: 180, h: 60, height: 105, color: '#2f5e8e', accent: '#2c2c2e', palette: 'car',
    keys: 'rad velo bike citybike rennrad mountainbike mtb kinderrad lastenrad cargo',
    variants: [
      V('city', 'Citybike', 'City bike'),
      V('sport', 'Rennrad / Mountainbike', 'Road / mountain bike', { w: 178, h: 64, height: 100 }),
      V('kids', 'Kinderrad', 'Kids bike', { w: 125, h: 48, height: 75, lib: true }),
      V('cargo', 'Lastenrad', 'Cargo bike', { w: 260, h: 66, height: 110, lib: true }),
    ],
    draw: ({ w, h, v, c, a }) => bikeTop(w, h, v, c, a, false),
  },
  {
    kind: 'ebike', cat: 'vehicle', de: 'E-Bike', en: 'E-bike', icon: 'mdi:bicycle-electric', w: 185, h: 62, height: 108, color: '#3a3a3c', accent: '#2c2c2e', palette: 'car', role: 'battery',
    keys: 'pedelec elektrofahrrad e-mtb e-lastenrad akku',
    variants: [
      V('city', 'E-Citybike', 'E-city bike'),
      V('mtb', 'E-Mountainbike', 'E-mountain bike', { w: 190, h: 72, height: 110 }),
      V('cargo', 'E-Lastenrad', 'E-cargo bike', { w: 265, h: 68, height: 112, lib: true }),
    ],
    draw: ({ w, h, v, c, a }) => bikeTop(w, h, v, c, a, true),
  },
  {
    kind: 'scooter', cat: 'vehicle', de: 'E-Scooter', en: 'E-scooter', icon: 'mdi:scooter-electric', w: 110, h: 46, height: 115, color: '#2c2c2e', accent: '#5c5d61', palette: 'car', role: 'battery',
    keys: 'roller tretroller kickscooter scooter',
    variants: [V('escooter', 'E-Scooter', 'E-scooter'), V('kick', 'Tretroller', 'Kick scooter', { w: 80, h: 36, height: 80 })],
    draw: ({ w, h, c, a }) => scooterTop(w, h, c, a),
  },
  {
    kind: 'motorbike', cat: 'vehicle', de: 'Motorrad', en: 'Motorcycle', icon: 'mdi:motorbike', w: 215, h: 80, height: 115, color: '#8a1f24', accent: '#2c2c2e', palette: 'car',
    keys: 'motorroller roller moped vespa motorcycle scooter',
    variants: [V('motorcycle', 'Motorrad', 'Motorcycle'), V('scooter', 'Motorroller', 'Moped / scooter', { w: 185, h: 70, height: 115, lib: true })],
    draw: ({ w, h, v, c, a }) => motoTop(w, h, v, c, a),
  },
  {
    kind: 'bike_rack', cat: 'vehicle', de: 'Fahrradständer', en: 'Bike rack', icon: 'mdi:bicycle-basket', w: 160, h: 45, height: 75, color: '#8d9297', palette: 'metal',
    count: { de: 'Stellplätze', en: 'Spaces', min: 1, max: 10, def: 4 },
    draw: ({ w, h, n, c }) =>
      svg`${R(-w / 2, -2, w, 4, 2, dark(c, 0.1))}${Array.from({ length: n }, (_, i) => R(-w / 2 + (w / n) * (i + 0.5) - 2, -h / 2, 4, h, 2, c))}`,
  },
  {
    kind: 'garage_door', cat: 'vehicle', de: 'Garagentor', en: 'Garage door', icon: 'mdi:garage', w: 250, h: 10, height: 210, color: '#e9e6df', accent: '#5c5d61', palette: 'white', role: 'cover',
    keys: 'garage tor sektionaltor torantrieb hörmann opener door',
    variants: [V('single', 'Einzelgarage', 'Single garage'), V('double', 'Doppelgarage', 'Double garage', { w: 500 })],
    draw: ({ w, h, c, a, live }) => {
      const k = Math.max(3, Math.round(w / 60));
      const o = live?.open ?? 0;
      // as it opens the door fades from the wall line and its run under the ceiling grows in front of it (into the garage)
      return svg`${R(-w / 2 - 6, -h / 2 - 2, 6, h + 4, 1, a)}${R(w / 2, -h / 2 - 2, 6, h + 4, 1, a)}
        <g class=${`gtrack ${live?.alert ? 'alert' : ''}`} style=${`transform:translateY(${h / 2}px) scaleY(${o.toFixed(3)})`}><rect x=${-w / 2 + 3} y="0" width=${w - 6} height=${Math.min(210, w * 0.85)} rx="2"></rect></g>
        <g class="gpanel" style=${`opacity:${(1 - o * 0.8).toFixed(2)}`}>${R(-w / 2, -h / 2, w, h, 1, c)}${Array.from({ length: k - 1 }, (_, i) => L(-w / 2 + (w / k) * (i + 1), -h / 2 + 1, -w / 2 + (w / k) * (i + 1), h / 2 - 1))}</g>`;
    },
  },
  {
    kind: 'ebike_battery', cat: 'vehicle', de: 'E-Bike-Akku', en: 'E-bike battery', icon: 'mdi:battery-charging-high', w: 26, h: 9, height: 9, color: '#2c2c2e', accent: '#3a3a3c', palette: 'appliance', onTop: true, role: 'battery', keys: 'akku ladegerät charger',
    variants: [V('charging', 'Mit Ladegerät', 'With charger', { w: 26, h: 20 }), V('battery', 'Nur Akku', 'Battery only'), V('upright', 'Stehend', 'Upright', { w: 9, h: 9, height: 28 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'charging'
        ? svg`${R(-w / 2, -h / 2, w, h * 0.45, 3, c)}${R(-w / 2 + 2, h * 0.08, w * 0.45, h * 0.38, 2, a)}${BulbRect(-w / 2 + 3, -h / 2 + 2, w * 0.3, 1.2, 0.6)}`
        : svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.3, c)}${BulbRect(-w / 2 + 2, -h / 2 + 1.5, Math.min(6, w * 0.3), 1.2, 0.6)}`,
  },
  {
    kind: 'carport', cat: 'vehicle', de: 'Carport', en: 'Carport', icon: 'mdi:garage-open-variant', w: 300, h: 550, height: 240, color: '#e9e6df', accent: '#4b4f54', keys: 'garage stellplatz parking', palette: 'metal', support: true,
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${[-1, 1].flatMap((sx) => [-1, 1].map((sy) => R(sx * (w / 2 - 8) - 6, sy * (h / 2 - 8) - 6, 12, 12, 1, a)))}`,
  },
  // ----- Energie & Haustechnik (neu) -----
  {
    kind: 'meter', cat: 'energy', de: 'Zähler', en: 'Meter', icon: 'mdi:meter-electric-outline', w: 22, h: 14, height: 30, color: '#f4f4f2', accent: '#2c2c2e', palette: 'appliance', elevation: 120, role: 'meter',
    keys: 'stromzähler gaszähler wasserzähler smart meter lesekopf ir tibber shelly em verbrauch electricity gas water',
    variants: [
      V('power', 'Stromzähler', 'Electricity meter', { lib: true }),
      V('smart', 'Smart Meter mit Lesekopf', 'Smart meter with reader', { lib: { de: 'Smart Meter / Lesekopf', en: 'Smart meter / reader' } }),
      V('gas', 'Gaszähler', 'Gas meter', { w: 32, h: 20, height: 24, lib: true }),
      V('water', 'Wasserzähler', 'Water meter', { w: 14, h: 10, height: 12, elevation: 40, lib: true }),
    ],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'water') return svg`${R(-w / 2, -1.5, w, 3, 1.5, '#b87333')}${C(0, 0, Math.min(w, h) * 0.42, '#5a8fd8')}${C(0, 0, Math.min(w, h) * 0.26, '#f4f4f2', false)}`;
      if (v === 'gas') return svg`${R(-w / 2, -h / 2, w, h, 3, '#d9c27a')}${R(-w * 0.3, h / 2 - 5, w * 0.6, 3, 1, a, false)}`;
      return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w * 0.32, h / 2 - 4, w * 0.64, 2.5, 1, a, false)}${v === 'smart' ? C(w * 0.18, h / 2 + 1.5, 2.2, '#2c2c2e') : nothing}${BulbRect(-w * 0.28, -h / 2 + 2, w * 0.25, 1.4, 0.7)}`;
    },
  },
  {
    kind: 'fuse_box', cat: 'energy', de: 'Sicherungskasten', en: 'Fuse box', icon: 'mdi:fuse', w: 55, h: 12, height: 75, color: '#f4f4f2', accent: '#9aa0a6', palette: 'white', elevation: 90,
    keys: 'verteiler stromkasten zählerschrank sicherungen breaker panel',
    count: { de: 'Reihen', en: 'Rows', min: 1, max: 6, def: 3 },
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${L(-w / 2 + 4, h / 2 - 2.5, w / 2 - 4, h / 2 - 2.5, a, 1.5)}${C(w / 2 - 6, h / 2 - 2.5, 1.5, a, false)}`,
  },
  {
    kind: 'water_softener', cat: 'energy', de: 'Enthärtungsanlage', en: 'Water softener', icon: 'mdi:water-plus-outline', w: 35, h: 50, height: 110, color: '#f4f4f2', accent: '#5a8fd8', palette: 'appliance',
    keys: 'wasserenthärter kalk filter hauswasserfilter wasser water filter',
    variants: [V('softener', 'Enthärtungsanlage', 'Water softener'), V('filter', 'Hauswasserfilter', 'Water filter', { w: 16, h: 16, height: 40, lib: true })],
    draw: ({ w, h, v, c, a }) =>
      v === 'filter'
        ? svg`${C(0, 0, Math.min(w, h) / 2, '#c9d8e6')}${C(0, 0, Math.min(w, h) * 0.3, a, false)}`
        : svg`${R(-w / 2, -h / 2, w, h, 6, c)}${C(0, -h * 0.12, Math.min(w, h) * 0.3, tone(c, -0.06))}${BulbRect(-w * 0.25, h / 2 - 6, w * 0.5, 2.5, 1)}`,
  },
  // ----- Heizung (neu) -----
  {
    kind: 'boiler', cat: 'climate', de: 'Heizkessel / Therme', en: 'Boiler / furnace', icon: 'mdi:water-boiler', w: 44, h: 35, height: 72, color: '#f4f4f2', accent: '#3a3a3c', palette: 'appliance', elevation: 120, role: 'heat',
    keys: 'gastherme heizung brenner ölheizung pelletheizung kessel heater',
    variants: [
      V('wall', 'Gastherme (Wand)', 'Wall-hung boiler'),
      V('floor', 'Heizkessel (Stand)', 'Floor-standing boiler', { w: 60, h: 70, height: 130, elevation: 0 }),
      V('pellet', 'Pelletkessel', 'Pellet boiler', { w: 80, h: 80, height: 150, elevation: 0 }),
    ],
    draw: ({ w, h, v, c, a }) =>
      v === 'wall'
        ? svg`${Dash(-w / 2, -h / 2, w, h, 3, c)}${BulbRect(-w * 0.25, h / 2 - 7, w * 0.5, 3, 1)}`
        : svg`${R(-w / 2, -h / 2, w, h, 4, c)}${v === 'pellet' ? R(-w / 2 + 4, -h / 2 + 4, w * 0.4, h - 8, 3, tone(c, -0.08)) : nothing}${R(w * (v === 'pellet' ? 0.05 : -0.3), h / 2 - 10, w * 0.4, 5, 2, a, false)}${BulbRect(w * (v === 'pellet' ? 0.1 : -0.25), h / 2 - 9, w * 0.2, 3, 1)}`,
  },
  {
    kind: 'water_heater', cat: 'climate', de: 'Warmwasserspeicher', en: 'Water heater', icon: 'mdi:water-boiler', w: 60, h: 60, height: 165, color: '#f4f4f2', accent: '#3a3a3c', palette: 'appliance', role: 'heat',
    keys: 'boiler warmwasser speicher durchlauferhitzer brauchwasser wärmepumpe hot water tank',
    variants: [
      V('tank', 'Speicher (Stand)', 'Storage tank'),
      V('wall', 'Boiler (Wand)', 'Wall boiler', { w: 45, h: 45, height: 80, elevation: 120 }),
      V('instant', 'Durchlauferhitzer', 'Tankless heater', { w: 24, h: 10, height: 40, elevation: 120, lib: true }),
    ],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'instant') return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${BulbRect(-w * 0.25, h / 2 - 2.5, w * 0.5, 1.5, 0.7)}`;
      const r = Math.min(w, h) / 2;
      return svg`${v === 'wall' ? DashC(0, 0, r, c, 0.7) : C(0, 0, r, c)}${Ring(0, 0, r * 0.72, tone(c, -0.12), 1)}${C(0, 0, r * 0.18, a, false)}${BulbRect(-r * 0.3, r * 0.45, r * 0.6, r * 0.14, 1)}`;
    },
  },
  {
    kind: 'ventilation', cat: 'climate', de: 'Lüftungsanlage', en: 'Ventilation unit', icon: 'mdi:hvac', w: 70, h: 55, height: 90, color: '#f4f4f2', accent: '#9aa0a6', palette: 'appliance', role: 'fan',
    keys: 'kwl lüftung wohnraumlüftung wärmerückgewinnung lüfter ventilator abluft zuluft mvhr ventilation',
    variants: [
      V('central', 'Zentralgerät (KWL)', 'Central unit (MVHR)'),
      V('room', 'Einzelraumlüfter (Wand)', 'Room ventilator (wall)', { w: 22, h: 8, height: 22, elevation: 200, lib: { de: 'Einzelraumlüfter', en: 'Room ventilator' } }),
      V('vent', 'Lüftungsventil (Decke)', 'Ceiling vent', { w: 16, h: 16, height: 3, elevation: 247, ceiling: true }),
    ],
    draw: ({ w, h, v, c, a }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'vent') return svg`${DashC(0, 0, r, c, 0.7)}${Ring(0, 0, r * 0.6, a, 1)}${C(0, 0, r * 0.25, a, false)}`;
      if (v === 'room') return svg`${Dash(-w / 2, -h / 2, w, h, 3, c)}${Ring(0, h * 0.1, Math.min(w * 0.3, h * 0.35), a, 1)}`;
      return svg`${R(-w / 2, -h / 2, w, h, 4, c)}${[-1, 1].flatMap((sx) => [-1, 1].map((sy) => C(sx * w * 0.3, sy * h * 0.28, Math.min(w, h) * 0.12, tone(c, -0.12))))}${C(0, 0, r * 0.42, tone(c, -0.05))}${svg`<g transform="translate(0 0)">${Blades(r * 0.4, 4, a)}</g>`}`;
    },
  },
  {
    kind: 'fireplace', cat: 'climate', de: 'Kamin / Ofen', en: 'Fireplace / stove', icon: 'mdi:fireplace', w: 55, h: 45, height: 110, color: '#2c2c2e', accent: '#3a3a3c', palette: 'metal', role: 'heat',
    keys: 'kaminofen schwedenofen holzofen pelletofen kamin feuer wood stove fire',
    variants: [
      V('stove', 'Kaminofen', 'Wood stove'),
      V('open', 'Kamin (offen)', 'Open fireplace', { w: 140, h: 50, height: 120 }),
      V('pellet', 'Pelletofen', 'Pellet stove', { w: 50, h: 55, height: 105 }),
    ],
    draw: ({ w, h, v, c, a }) =>
      v === 'open'
        ? svg`${R(-w / 2, -h / 2, w, h, 3, '#c8c0b4')}${R(-w * 0.3, -h / 2 + 8, w * 0.6, h - 10, 3, a)}${BulbRect(-w * 0.22, -h / 2 + 14, w * 0.44, h * 0.4, 3)}`
        : svg`${R(-w / 2, -h / 2, w, h, 6, c)}${C(0, -h * 0.12, Math.min(w, h) * 0.12, tone(c, 0.15))}${BulbRect(-w * 0.32, h / 2 - 9, w * 0.64, 5, 2)}`,
  },
  // ----- Netzwerk & IT (neu) -----
  {
    kind: 'access_point', cat: 'network', de: 'WLAN-Access-Point', en: 'Wi-Fi access point', icon: 'mdi:access-point', w: 20, h: 20, height: 4, color: '#f4f4f2', accent: '#5fb0ff', palette: 'appliance', elevation: 246, ceiling: true, role: 'network',
    keys: 'wlan wifi ap unifi omada mesh funk',
    variants: [
      V('ceiling', 'Decke', 'Ceiling'),
      V('wall', 'Wand', 'Wall', { w: 15, h: 4, height: 15, elevation: 200, ceiling: false }),
      V('outdoor', 'Außen', 'Outdoor', { w: 12, h: 6, height: 26, elevation: 250, ceiling: false }),
    ],
    draw: ({ w, h, v, c }) =>
      v === 'ceiling' ? svg`${DashC(0, 0, Math.min(w, h) / 2, c, 0.8)}${Bulb(0, 0, Math.min(w, h) * 0.12)}` : svg`${Dash(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.3, c)}${BulbRect(-1.5, h / 2 - 1, 3, 0.8, 0.4)}`,
  },
  {
    kind: 'server_rack', cat: 'network', de: 'Serverschrank', en: 'Server rack', icon: 'mdi:server', w: 60, h: 100, height: 200, color: '#2c2c2e', accent: '#5fd06a', palette: 'metal', role: 'network',
    keys: 'rack 19 zoll netzwerkschrank server homelab patchpanel',
    variants: [
      V('floor', 'Standschrank', 'Floor rack'),
      V('wall', 'Wandschrank', 'Wall rack', { w: 60, h: 45, height: 64, elevation: 140 }),
      V('mini', 'Mini-Rack (10")', 'Mini rack (10")', { w: 30, h: 30, height: 50 }),
    ],
    count: { de: 'Geräte', en: 'Devices', min: 1, max: 8, def: 4 },
    draw: ({ w, h, v, c }) =>
      svg`${v === 'wall' ? Dash(-w / 2, -h / 2, w, h, 2, c) : R(-w / 2, -h / 2, w, h, 2, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 10, 1, tone(c, 0.1), false)}${L(-w / 2 + 3, h / 2 - 3, w / 2 - 3, h / 2 - 3, '#5a6b7c', 2)}${BulbRect(w / 2 - 9, h / 2 - 5, 4, 1.4, 0.7)}`,
  },
  {
    kind: 'ups', cat: 'network', de: 'USV', en: 'UPS', icon: 'mdi:power-plug-battery-outline', w: 15, h: 40, height: 23, color: '#2c2c2e', palette: 'appliance', role: 'battery',
    keys: 'unterbrechungsfreie stromversorgung ups apc eaton notstrom batterie',
    variants: [V('tower', 'Tower', 'Tower'), V('rack', '19"-Einschub', '19" rack unit', { w: 48, h: 45, height: 9 })],
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 2, c)}${BulbRect(-w / 2 + 2, h / 2 - 4, Math.min(8, w - 4), 2, 1)}`,
  },
  // ----- Smart Home & Sicherheit (neu) -----
  {
    kind: 'camera', cat: 'security', de: 'Kamera', en: 'Camera', icon: 'mdi:cctv', w: 8, h: 8, height: 11, color: '#f4f4f2', accent: '#1f1f21', palette: 'appliance', onTop: true, role: 'camera',
    keys: 'überwachungskamera ip kamera cctv webcam reolink ring eufy security camera',
    variants: [
      V('indoor', 'Innenkamera', 'Indoor camera'),
      V('outdoor', 'Außenkamera (Wand)', 'Outdoor camera (wall)', { w: 9, h: 20, height: 9, elevation: 250, lib: { de: 'Außenkamera', en: 'Outdoor camera' } }),
      V('dome', 'Dome-Kamera (Decke)', 'Dome camera (ceiling)', { w: 12, h: 12, height: 8, elevation: 242, ceiling: true }),
      V('ptz', 'Schwenk-/Neigekamera', 'Pan-tilt camera', { w: 10, h: 10, height: 12 }),
    ],
    draw: ({ w, h, v, c, a }) => {
      const r = Math.min(w, h) / 2;
      if (v === 'outdoor') return svg`${Dash(-w * 0.2, -h / 2, w * 0.4, h * 0.3, 1, c)}${Dash(-w / 2, -h * 0.25, w, h * 0.75, w * 0.3, c)}${C(0, h / 2 - 2.5, w * 0.24, a, false)}`;
      if (v === 'dome') return svg`${DashC(0, 0, r, c, 0.8)}${C(0, r * 0.2, r * 0.45, '#3a3f48', false)}${C(0, r * 0.2, r * 0.18, a, false)}`;
      return svg`${C(0, 0, r, c)}${C(0, r * 0.25, r * 0.48, a, false)}${C(0, r * 0.25, r * 0.18, '#5a6b7c', false)}${Bulb(r * 0.55, -r * 0.45, r * 0.12)}`;
    },
  },
  {
    kind: 'doorbell', cat: 'security', de: 'Video-Türklingel', en: 'Video doorbell', icon: 'mdi:doorbell-video', w: 5, h: 3, height: 15, color: '#2c2c2e', accent: '#5fb0ff', palette: 'appliance', elevation: 125, role: 'camera',
    keys: 'klingel türklingel ring doorbell türsprechanlage gegensprechanlage intercom',
    draw: ({ w, h, c }) => svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${Bulb(0, h / 2 - 0.8, Math.min(w, h) * 0.3)}`,
  },
  {
    kind: 'alarm_panel', cat: 'security', de: 'Alarmanlage', en: 'Alarm system', icon: 'mdi:shield-home-outline', w: 15, h: 3, height: 20, color: '#f4f4f2', accent: '#3a3a3c', palette: 'appliance', elevation: 140, role: 'alarm',
    keys: 'alarm einbruch sicherheit bedienteil zentrale ajax alarmo security keypad',
    variants: [V('keypad', 'Bedienteil (Wand)', 'Keypad (wall)'), V('hub', 'Zentrale', 'Base station', { w: 20, h: 14, height: 6, elevation: 0 })],
    draw: ({ w, h, v, c }) =>
      v === 'hub'
        ? svg`${R(-w / 2, -h / 2, w, h, 4, c)}${Bulb(0, 0, Math.min(w, h) * 0.18)}`
        : svg`${R(-w / 2, -h / 2, w, h, 1.5, c)}${BulbRect(-w * 0.3, h / 2 - 1.1, w * 0.6, 0.8, 0.4)}`,
  },
  {
    kind: 'smart_lock', cat: 'security', de: 'Smartes Türschloss', en: 'Smart lock', icon: 'mdi:lock-smart', w: 6, h: 6, height: 14, color: '#2c2c2e', accent: '#f4f4f2', palette: 'appliance', elevation: 100, role: 'lock',
    keys: 'nuki schloss türschloss tedee danalock lock türöffner',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.3, c)}${C(0, h * 0.1, Math.min(w, h) * 0.28, a, false)}${Bulb(0, h * 0.1, Math.min(w, h) * 0.12)}`,
  },
  {
    kind: 'siren', cat: 'security', de: 'Sirene', en: 'Siren', icon: 'mdi:alarm-light-outline', w: 12, h: 12, height: 8, color: '#f4f4f2', accent: '#ff453a', palette: 'appliance', elevation: 230, role: 'alarm',
    keys: 'alarm sirene blitzleuchte strobe siren alarm light',
    variants: [V('indoor', 'Innen', 'Indoor'), V('outdoor', 'Außen mit Blitzlicht', 'Outdoor with strobe', { w: 20, h: 8, height: 28, elevation: 260 })],
    draw: ({ w, h, v, c }) =>
      v === 'outdoor' ? svg`${Dash(-w / 2, -h / 2, w, h, 2, c)}${BulbRect(-w * 0.3, -h / 2 + 1.5, w * 0.6, h - 3, 1.5)}` : svg`${DashC(0, 0, Math.min(w, h) / 2, c, 0.8)}${Bulb(0, 0, Math.min(w, h) * 0.26)}`,
  },
  // ----- Freizeit & Sport (neu) -----
  {
    kind: 'fitness', cat: 'leisure', de: 'Fitnessgerät', en: 'Fitness equipment', icon: 'mdi:dumbbell', w: 180, h: 80, height: 140, color: '#2c2c2e', accent: '#5c5d61', palette: 'metal',
    keys: 'laufband heimtrainer ergometer spinning rudergerät hantelbank sport gym treadmill exercise bike rower bench',
    variants: [
      V('treadmill', 'Laufband', 'Treadmill', { lib: true }),
      V('bike', 'Heimtrainer / Spinning', 'Exercise bike', { w: 110, h: 55, height: 120, lib: true }),
      V('rower', 'Rudergerät', 'Rowing machine', { w: 210, h: 55, height: 50, lib: true }),
      V('bench', 'Hantelbank', 'Weight bench', { w: 120, h: 50, height: 45 }),
    ],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'bike')
        return svg`${R(-w / 2, -h / 2 + 4, 8, h - 8, 3, c)}${R(w / 2 - 8, -h / 2 + 4, 8, h - 8, 3, c)}${L(-w / 2 + 4, 0, w / 2 - 4, 0, c, 4)}
          ${R(w * 0.12, -5, w * 0.28, 10, 5, a)}${E(-w * 0.18, 0, 12, 7, '#1f1f21')}${L(w * 0.3, -h * 0.32, w * 0.3, h * 0.32, a, 3)}`;
      if (v === 'rower')
        return svg`${L(-w / 2 + 10, 0, w / 2 - 30, 0, '#8d9297', 4)}${R(w / 2 - 30, -h / 2 + 6, 30, h - 12, 8, c)}${R(-w * 0.1, -12, 28, 24, 6, a)}${R(w / 2 - 50, -h / 2 + 4, 12, 10, 2, a)}${R(w / 2 - 50, h / 2 - 14, 12, 10, 2, a)}`;
      if (v === 'bench')
        return svg`${R(-w / 2, -h * 0.2, w, h * 0.4, 5, a)}${L(-w * 0.15, -h / 2, -w * 0.15, h / 2, '#8d9297', 2.5)}${C(-w * 0.15, -h / 2 + 3, 5, c)}${C(-w * 0.15, h / 2 - 3, 5, c)}`;
      return svg`${R(-w / 2, -h / 2, w, h, 8, c)}${R(-w / 2 + 6, -h / 2 + 12, w - 40, h - 24, 4, a)}${R(w / 2 - 26, -h / 2 + 2, 22, h - 4, 4, tone(c, 0.12))}${BulbRect(w / 2 - 20, -h * 0.2, 6, h * 0.4, 2)}`;
    },
  },
  {
    kind: 'sauna', cat: 'leisure', de: 'Sauna', en: 'Sauna', icon: 'mdi:thermometer-high', w: 200, h: 180, height: 205, color: '#c8a06a', accent: '#8b5e3c', palette: 'wood', role: 'heat',
    keys: 'saunakabine fasssauna infrarotkabine wellness',
    variants: [
      V('cabin', 'Saunakabine', 'Sauna cabin'),
      V('barrel', 'Fasssauna (außen)', 'Barrel sauna (outdoor)', { w: 240, h: 200, height: 210 }),
      V('infrared', 'Infrarotkabine', 'Infrared cabin', { w: 120, h: 105, height: 195 }),
    ],
    draw: ({ w, h, v, c, a }) => {
      const benches = svg`${R(-w / 2 + 6, -h / 2 + 6, w - 12, h * 0.28, 2, light(c, 0.12))}${R(-w / 2 + 6, -h / 2 + 6 + h * 0.3, w - 12, h * 0.16, 2, light(c, 0.06))}`;
      const heater = v === 'infrared' ? BulbRect(-w / 2 + 8, h / 2 - 16, w - 16, 6, 2) : svg`${R(w / 2 - 34, h / 2 - 34, 26, 26, 3, '#3a3a3c')}${BulbRect(w / 2 - 30, h / 2 - 30, 18, 18, 2)}`;
      const glass = L(-w * 0.2, h / 2, w * 0.15, h / 2, '#a6d4f2', 3);
      if (v === 'barrel')
        return svg`${R(-w / 2, -h / 2, w, h, h * 0.35, a)}${R(-w / 2 + 8, -h / 2 + 8, w - 16, h - 16, h * 0.3, c)}${Array.from({ length: 5 }, (_, i) => L(-w / 2 + 8, -h / 2 + 8 + ((h - 16) * (i + 1)) / 6, w / 2 - 8, -h / 2 + 8 + ((h - 16) * (i + 1)) / 6, 'rgba(0,0,0,0.12)'))}${heater}`;
      return svg`${R(-w / 2, -h / 2, w, h, 3, a)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 2, c)}${benches}${heater}${glass}`;
    },
  },
  {
    kind: 'printer_3d', cat: 'work', de: '3D-Drucker', en: '3D printer', icon: 'mdi:printer-3d', w: 45, h: 45, height: 48, color: '#2c2c2e', accent: '#ff8a3a', palette: 'appliance', onTop: true,
    keys: 'bambu prusa creality octoprint drucker printer',
    variants: [V('open', 'Offen', 'Open frame'), V('enclosed', 'Geschlossen', 'Enclosed', { w: 40, h: 40, height: 48 })],
    draw: ({ w, h, v, c, a }) =>
      v === 'enclosed'
        ? svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 2, '#5a6b7c', false)}${R(-w * 0.12, -h * 0.12, w * 0.24, h * 0.2, 1.5, a, false)}${BulbRect(-w * 0.2, h / 2 - 2.5, w * 0.4, 1.4, 0.7)}`
        : svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 5, -h / 2 + 5, w - 10, h - 12, 2, '#5a5f66', false)}${L(-w / 2 + 2, -h * 0.05, w / 2 - 2, -h * 0.05, '#8d9297', 2.5)}${R(-4, -h * 0.05 - 4, 8, 8, 1.5, a)}${BulbRect(w * 0.15, h / 2 - 4, w * 0.25, 2, 1)}`,
  },
  {
    kind: 'sewing_machine', cat: 'leisure', de: 'Nähmaschine', en: 'Sewing machine', icon: 'mdi:needle', w: 40, h: 20, height: 30, color: '#f4f4f2', accent: '#c94a3a', palette: 'appliance', onTop: true,
    keys: 'nähen overlock sewing',
    draw: ({ w, h, c, a }) => svg`${R(-w / 2, -h / 2, w, h, 4, c)}${R(-w / 2 + 2, -h * 0.25, w - 4, h * 0.42, 3, tone(c, -0.06))}${R(w / 2 - 10, -h / 2 + 2, 7, h - 4, 2, a, false)}${C(-w / 2 + 7, h * 0.08, 1.6, '#3a3a3c', false)}`,
  },
  {
    kind: 'aquarium', cat: 'pets', de: 'Aquarium', en: 'Aquarium', icon: 'mdi:fishbowl-outline', w: 100, h: 40, height: 140, color: '#2c2c2e', accent: '#4fb6e0', palette: 'wood',
    keys: 'fische becken terrarium fish tank',
    variants: [V('cabinet', 'Mit Unterschrank', 'On cabinet'), V('large', 'Groß', 'Large', { w: 160, h: 55, height: 150 }), V('nano', 'Nano', 'Nano', { w: 40, h: 30, height: 110 })],
    draw: ({ w, h, c, a }) =>
      svg`${R(-w / 2, -h / 2, w, h, 2, c)}${R(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 1.5, a)}${[0.2, 0.45, 0.75].map((f, i) => C(-w / 2 + w * f, -h * 0.1 + (i % 2) * h * 0.2, Math.min(h * 0.16, 5), '#4f8f4e', false))}${BulbRect(-w / 2 + 6, -h / 2 + 4, w - 12, 2, 1)}`,
  },
  {
    kind: 'pet_feeder', cat: 'pets', de: 'Futterautomat', en: 'Pet feeder', icon: 'mdi:food-drumstick-outline', w: 25, h: 32, height: 35, color: '#f4f4f2', accent: '#8aa0b5', palette: 'appliance',
    keys: 'futter napf trinkbrunnen wasser katze hund feeder fountain',
    variants: [V('feeder', 'Futterautomat', 'Feeder'), V('fountain', 'Trinkbrunnen', 'Water fountain', { w: 22, h: 22, height: 16, lib: true })],
    draw: ({ w, h, v, c, a }) =>
      v === 'fountain'
        ? svg`${C(0, 0, Math.min(w, h) / 2, c)}${C(0, 0, Math.min(w, h) * 0.36, '#9fd3ef', false)}${C(0, 0, Math.min(w, h) * 0.12, a, false)}`
        : svg`${R(-w / 2, -h / 2, w, h * 0.62, 5, c)}${C(0, -h * 0.2, Math.min(w, h) * 0.28, light(a, 0.2))}${E(0, h * 0.25, w * 0.38, h * 0.2, a)}${E(0, h * 0.25, w * 0.26, h * 0.12, '#b98c5a', false)}${BulbRect(-w * 0.2, -h / 2 + 2, w * 0.4, 1.4, 0.7)}`,
  },
  {
    kind: 'christmas_tree', cat: 'living', de: 'Weihnachtsbaum', en: 'Christmas tree', icon: 'mdi:pine-tree', w: 110, h: 110, height: 200, color: '#2f6b3a', accent: '#d8483a', palette: 'plant', top3d: true, role: 'light',
    keys: 'tannenbaum christbaum lichterkette weihnachten xmas',
    draw: ({ w, h, c, a }) => {
      const r = Math.min(w, h) / 2;
      const star = (rr: number, n: number, fill: string, rot = 0) =>
        PathD(Array.from({ length: n * 2 }, (_, i) => { const ang = (i / (n * 2)) * Math.PI * 2 + rot; const k = i % 2 ? rr * 0.72 : rr; return `${i ? 'L' : 'M'} ${(Math.cos(ang) * k).toFixed(1)} ${(Math.sin(ang) * k).toFixed(1)}`; }).join(' ') + ' Z', fill, false);
      return svg`${star(r, 9, dark(c, 0.06))}${star(r * 0.7, 8, c, 0.2)}${star(r * 0.42, 7, light(c, 0.08), 0.4)}
        ${Array.from({ length: 9 }, (_, i) => { const ang = i * 2.4; const rr = r * (0.3 + (i % 3) * 0.22); return Bulb(Math.cos(ang) * rr, Math.sin(ang) * rr, Math.max(2, r * 0.05)); })}
        ${[0, 1, 2, 3].map((i) => C(Math.cos(i * 1.7 + 0.5) * r * 0.55, Math.sin(i * 1.7 + 0.5) * r * 0.55, Math.max(2.5, r * 0.07), a, false))}${C(0, 0, Math.max(3, r * 0.08), '#e8c547', false)}`;
    },
  },
  {
    kind: 'projector', cat: 'tech', de: 'Beamer', en: 'Projector', icon: 'mdi:projector', w: 30, h: 25, height: 12, color: '#f4f4f2', accent: '#2c2c2e', palette: 'appliance', elevation: 235, ceiling: true, onTop: true, role: 'media',
    keys: 'projektor heimkino leinwand projector home cinema',
    variants: [V('ceiling', 'Decke', 'Ceiling'), V('table', 'Tisch / Regal', 'Table / shelf', { elevation: 0, ceiling: false })],
    draw: ({ w, h, v, c, a }) => svg`${v === 'ceiling' ? Dash(-w / 2, -h / 2, w, h, 3, c) : R(-w / 2, -h / 2, w, h, 3, c)}${C(-w * 0.2, h / 2 - h * 0.22, Math.min(w, h) * 0.17, a, false)}${C(-w * 0.2, h / 2 - h * 0.22, Math.min(w, h) * 0.08, '#5a6b7c', false)}${BulbRect(w * 0.1, h / 2 - 3, w * 0.25, 1.5, 0.7)}`,
  },
  // ----- Garten & Außen (neu) -----
  {
    kind: 'mailbox', cat: 'garden', de: 'Briefkasten', en: 'Mailbox', icon: 'mdi:mailbox-outline', w: 38, h: 14, height: 38, color: '#2c2c2e', accent: '#c9a46a', palette: 'metal', elevation: 100, role: 'sensor',
    keys: 'post briefkasten paket paketbox mail letterbox parcel',
    variants: [V('wall', 'Wand', 'Wall'), V('post', 'Standbriefkasten', 'On a post', { w: 40, h: 30, height: 120, elevation: 0 }), V('parcel', 'Paketbox', 'Parcel box', { w: 60, h: 50, height: 100, elevation: 0, lib: true })],
    draw: ({ w, h, v, c, a }) =>
      v === 'parcel'
        ? svg`${R(-w / 2, -h / 2, w, h, 3, c)}${R(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 2, tone(c, 0.08))}${R(-w * 0.15, h / 2 - 6, w * 0.3, 3, 1, a, false)}`
        : svg`${v === 'post' ? C(0, 0, 4, '#5c5d61') : nothing}${R(-w / 2, -h / 2, w, v === 'post' ? h * 0.6 : h, 3, c)}${R(-w * 0.3, -h / 2 + 2, w * 0.6, 2, 1, a, false)}${Bulb(w / 2 - 5, -h / 2 + 5, 1.6)}`,
  },
  {
    kind: 'gate', cat: 'garden', de: 'Tor', en: 'Gate', icon: 'mdi:gate', w: 300, h: 8, height: 140, color: '#2c2c2e', accent: '#5c5d61', palette: 'metal', role: 'cover',
    keys: 'einfahrtstor hoftor gartentor gartentür schiebetor drehtor torantrieb gate door',
    variants: [V('swing', 'Drehtor (zweiflügelig)', 'Swing gate'), V('sliding', 'Schiebetor', 'Sliding gate', { w: 400 }), V('door', 'Gartentür', 'Garden door', { w: 100, height: 120, lib: true })],
    draw: ({ w, h, v, c, a, live }) => {
      const o = live?.open ?? 0;
      // a leaf from its hinge along +x, turned open towards +y (the side the piece faces)
      const leaf = (L: number) => {
        const bars = Math.max(2, Math.round(L / 25));
        return svg`${R(0, -h / 2 + 1, L, h - 2, 1, c)}${Array.from({ length: bars - 1 }, (_, i) => C((L / bars) * (i + 1), 0, 1.2, light(c, 0.25), false))}`;
      };
      const turn = (deg: number) => `transform:rotate(${(deg * o).toFixed(1)}deg)`;
      const leaves =
        v === 'sliding'
          ? svg`${R(-w / 2, h / 2 + 3, w * 2, 2, 1, '#8d9297', false)}<g transform=${`translate(${-w / 2} 0)`}><g class="gleaf" style=${`transform:translateX(${(o * w).toFixed(1)}px)`}>${leaf(w)}</g></g>`
          : v === 'door'
            ? svg`<g transform=${`translate(${-w / 2} 0)`}><g class="gleaf" style=${turn(85)}>${leaf(w)}</g></g>`
            : svg`<g transform=${`translate(${-w / 2} 0)`}><g class="gleaf" style=${turn(85)}>${leaf(w / 2)}</g></g>
              <g transform=${`translate(${w / 2} 0) scale(-1 1)`}><g class="gleaf" style=${turn(85)}>${leaf(w / 2)}</g></g>`;
      return svg`<g class=${`gate-live ${live?.alert ? 'alert' : ''}`}>${R(-w / 2 - 12, -6, 12, 12, 1.5, a)}${R(w / 2, -6, 12, 12, 1.5, a)}${leaves}</g>`;
    },
  },
  {
    kind: 'irrigation', cat: 'garden', de: 'Bewässerungscomputer', en: 'Irrigation controller', icon: 'mdi:water-pump', w: 14, h: 10, height: 20, color: '#3a3a3c', accent: '#5a8fd8', palette: 'appliance', role: 'water',
    keys: 'bewässerung gardena ventil ventilbox wasserhahn timer irrigation valve',
    variants: [
      V('tap', 'Am Wasserhahn', 'Tap timer'),
      V('box', 'Ventilbox (Boden)', 'Valve box (ground)', { w: 50, h: 36, height: 25 }),
      V('controller', 'Steuergerät (Wand)', 'Controller (wall)', { w: 22, h: 8, height: 22, elevation: 120 }),
    ],
    draw: ({ w, h, v, c, a }) => {
      if (v === 'box') return svg`${R(-w / 2, -h / 2, w, h, 4, '#3f6b3a')}${R(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 3, '#4f7f42')}`;
      if (v === 'controller') return svg`${R(-w / 2, -h / 2, w, h, 2, c)}${BulbRect(-w * 0.3, h / 2 - 2, w * 0.6, 1.4, 0.7)}`;
      return svg`${R(-w / 2, -h / 2, w, h, 3, c)}${C(0, 0, Math.min(w, h) * 0.3, a)}${Bulb(w / 2 - 2.5, -h / 2 + 2.5, 1)}`;
    },
  },
  {
    kind: 'irrigation_zone', cat: 'garden', de: 'Bewässerungszone', en: 'Irrigation zone', icon: 'mdi:sprinkler-variant', w: 400, h: 300, height: 14, color: '#3a3a3c', accent: '#5a8fd8', palette: 'appliance', role: 'water',
    keys: 'bewässerung zone kreis ventil regner gardena rain bird hunter irrigation zone valve sprinkler',
    variants: [V('area', 'Fläche', 'Area'), V('round', 'Rund', 'Round', { w: 360, h: 360 })],
    draw: ({ w, h, v, c, a, live }) => {
      const on = !!live?.on;
      const outline = v === 'round'
        ? svg`<ellipse class=${`zone ${on ? 'on' : ''}`} cx="0" cy="0" rx=${w / 2} ry=${h / 2}></ellipse>`
        : svg`<rect class=${`zone ${on ? 'on' : ''}`} x=${-w / 2} y=${-h / 2} width=${w} height=${h} rx=${Math.min(w, h) * 0.08}></rect>`;
      return svg`${outline}${C(0, 0, 6, c)}${C(0, 0, 3, a, false)}`;
    },
  },
  {
    kind: 'garden_socket', cat: 'garden', de: 'Außensteckdose', en: 'Outdoor socket', icon: 'mdi:power-socket-de', w: 10, h: 6, height: 10, color: '#4b4f54', accent: '#2c2c2e', palette: 'metal', elevation: 40,
    keys: 'steckdose außen garten zwischenstecker outdoor plug socket power',
    variants: [V('wall', 'An der Wand', 'On a wall'), V('post', 'Steckdosensäule', 'Socket post', { w: 14, h: 12, height: 60, elevation: 0, lib: { de: 'Steckdosensäule', en: 'Socket post' } })],
    draw: ({ w, h, v, c, a }) =>
      v === 'post'
        ? svg`${R(-w / 2, -h / 2, w, h, 3, c)}${C(0, h * 0.1, Math.min(w, h) * 0.28, a)}${Bulb(0, -h / 2 + 2.5, 1)}`
        : svg`${R(-w / 2, -h / 2, w, h, 2, c)}${C(0, 0, Math.min(w, h) * 0.32, a)}`,
  },
  {
    kind: 'pool_pump', cat: 'garden', de: 'Poolpumpe / Filter', en: 'Pool pump / filter', icon: 'mdi:pump', w: 60, h: 40, height: 60, color: '#3a6fb0', accent: '#2c2c2e', palette: 'appliance',
    keys: 'pool filter sandfilter pumpe wärmepumpe pool pump heat pump',
    variants: [V('filter', 'Sandfilteranlage', 'Sand filter'), V('heatpump', 'Pool-Wärmepumpe', 'Pool heat pump', { w: 90, h: 40, height: 65, lib: true })],
    draw: ({ w, h, v, c, a }) =>
      v === 'heatpump'
        ? svg`${R(-w / 2, -h / 2, w, h, 4, '#e9e6df')}${C(-w * 0.12, 0, Math.min(h * 0.4, w * 0.3), '#2f3134', false)}${svg`<g transform=${`translate(${-w * 0.12} 0)`}>${Blades(Math.min(h * 0.38, w * 0.28), 3, '#8d9297')}</g>`}`
        : svg`${C(-w * 0.15, 0, Math.min(w * 0.33, h / 2), c)}${C(-w * 0.15, 0, Math.min(w * 0.12, h * 0.2), a, false)}${R(w * 0.12, -h * 0.25, w * 0.36, h * 0.5, 4, a)}${BulbRect(w * 0.18, -1, w * 0.12, 2, 1)}`,
  },
];

export const FURNITURE_BY_KIND = new Map(FURNITURE.map((f) => [f.kind, f]));

// Legacy kinds from earlier versions
const ALIASES: Record<string, { kind: string; variant?: string }> = {
  table: { kind: 'dining_table', variant: 'rect' },
  round_table: { kind: 'dining_table', variant: 'round' },
  stove: { kind: 'cooktop', variant: 'electric' },
};

export function furnitureKind(kind: string): FurnitureKind | undefined {
  return FURNITURE_BY_KIND.get(kind) ?? FURNITURE_BY_KIND.get(ALIASES[kind]?.kind ?? '');
}

export const CATEGORIES: { id: FurnitureCategory; de: string; en: string; icon: string }[] = [
  { id: 'living', de: 'Wohnen', en: 'Living', icon: 'mdi:sofa-outline' },
  { id: 'dining', de: 'Essen', en: 'Dining', icon: 'mdi:table-chair' },
  { id: 'sleeping', de: 'Schlafen', en: 'Sleeping', icon: 'mdi:bed-outline' },
  { id: 'kitchen', de: 'Küche', en: 'Kitchen', icon: 'mdi:countertop-outline' },
  { id: 'appliance', de: 'Küchengeräte', en: 'Kitchen appliances', icon: 'mdi:blender-outline' },
  { id: 'bath', de: 'Bad & Wäsche', en: 'Bath & laundry', icon: 'mdi:shower' },
  { id: 'work', de: 'Arbeiten', en: 'Work', icon: 'mdi:desk' },
  { id: 'hall', de: 'Flur', en: 'Hallway', icon: 'mdi:coat-rack' },
  { id: 'home', de: 'Haushalt', en: 'Household', icon: 'mdi:robot-vacuum' },
  { id: 'lighting', de: 'Licht', en: 'Lighting', icon: 'mdi:lightbulb-outline' },
  { id: 'climate', de: 'Heizung & Klima', en: 'Heating & climate', icon: 'mdi:radiator' },
  { id: 'tech', de: 'TV & Medien', en: 'TV & media', icon: 'mdi:television' },
  { id: 'network', de: 'Netzwerk & IT', en: 'Network & IT', icon: 'mdi:router-wireless' },
  { id: 'security', de: 'Sensoren & Sicherheit', en: 'Sensors & security', icon: 'mdi:shield-home-outline' },
  { id: 'energy', de: 'Energie & Haustechnik', en: 'Energy & utilities', icon: 'mdi:solar-power-variant' },
  { id: 'vehicle', de: 'Fahrzeuge', en: 'Vehicles', icon: 'mdi:car-electric' },
  { id: 'leisure', de: 'Freizeit & Sport', en: 'Leisure & sport', icon: 'mdi:dumbbell' },
  { id: 'pets', de: 'Haustiere', en: 'Pets', icon: 'mdi:paw' },
  { id: 'outdoor', de: 'Balkon & Terrasse', en: 'Balcony & terrace', icon: 'mdi:flower-outline' },
  { id: 'garden', de: 'Garten', en: 'Garden', icon: 'mdi:tree-outline' },
];

/** One tile of the object library: a kind, or one of its variants that deserves its own tile */
export interface LibraryItem {
  k: FurnitureKind;
  v?: Variant;
  /** German / English label */
  de: string;
  en: string;
  /** Lower-case text the search looks through */
  text: string;
}

/** Most-used kinds first within their category (the rest follows in catalogue order) */
const LIB_FIRST = [
  'ceiling_lamp', 'floor_lamp', 'table_lamp', 'wall_lamp', 'light_strip',
  'radiator', 'thermostat', 'towel_radiator', 'space_heater', 'boiler', 'water_heater', 'fireplace', 'ac', 'fan', 'ceiling_fan',
  'tv', 'speaker', 'streaming_box', 'console', 'projector',
  'router', 'access_point', 'network', 'mini_pc', 'server_rack', 'ups',
  'sensor', 'camera', 'doorbell', 'smart_lock', 'alarm_panel', 'siren', 'smart_plug',
  'solar_panels', 'inverter', 'home_battery', 'wallbox', 'heat_pump', 'meter',
  'car', 'bicycle', 'ebike', 'scooter', 'motorbike',
  'dog', 'cat', 'pet_bed', 'food_bowls', 'pet_feeder',
  'washer', 'dryer',
];

/** Library tiles: every kind (most-used first per category), followed by its variants marked `lib` */
export const LIBRARY: LibraryItem[] = [...FURNITURE].sort((a, b) => libRank(a) - libRank(b)).flatMap((k) => {
  const base = `${k.de} ${k.en} ${k.kind} ${k.keys ?? ''} ${(k.variants ?? []).map((v) => `${v.de} ${v.en}`).join(' ')}`.toLowerCase();
  const items: LibraryItem[] = [{ k, de: k.de, en: k.en, text: base }];
  for (const v of k.variants ?? []) {
    if (!v.lib || v === k.variants?.[0]) continue;
    const lbl = typeof v.lib === 'object' ? v.lib : v;
    items.push({ k, v, de: lbl.de, en: lbl.en, text: `${lbl.de} ${lbl.en} ${v.de} ${v.en} ${k.de} ${k.en}`.toLowerCase() });
  }
  return items;
});

function libRank(k: FurnitureKind): number {
  const i = LIB_FIRST.indexOf(k.kind);
  return i >= 0 ? i : 1000 + FURNITURE.indexOf(k);
}

const en = () => getLanguage() === 'en';
export const furnitureLabel = (k: FurnitureKind) => (en() ? k.en : k.de);
export const variantLabel = (v: Variant) => (en() ? v.en : v.de);
export const categoryLabel = (c: { de: string; en: string }) => (en() ? c.en : c.de);

/** Effective values of a placed piece (defaults from its kind/variant). */
export function resolveFurniture(f: FurnitureConfig) {
  const k = furnitureKind(f.kind);
  const variantId = f.variant ?? ALIASES[f.kind]?.variant ?? k?.variants?.[0]?.id ?? '';
  const variant = k?.variants?.find((v) => v.id === variantId);
  return {
    k,
    variant: variantId,
    count: f.count ?? variant?.n ?? k?.count?.def ?? 0,
    color: f.color ?? k?.color ?? '#d4d4d0',
    accent: f.accent ?? k?.accent ?? tone(f.color ?? k?.color ?? '#d4d4d0', 0.12),
    height: f.height ?? variant?.height ?? k?.height ?? 60,
    elevation: f.elevation ?? variant?.elevation ?? k?.elevation ?? 0,
    flip: !!f.flip,
    ceiling: !!(variant?.ceiling ?? k?.ceiling),
    role: k?.role,
  };
}

/** The Wi-Fi QR codes item of a piece's contents (no entity) */
export function isWifiContent(c: FurnitureContentConfig): boolean {
  return c.kind === 'wifi' && !c.entity;
}

/**
 * What a piece holds (cabinet, shelf, sideboard …): its own entity first, then the devices added inside it and the
 * Wi-Fi QR codes item (at most one). Empty unless `contents` lists something — a piece with only `entity` keeps
 * acting like that device.
 */
export function furnitureContents(f: FurnitureConfig): FurnitureContentConfig[] {
  let wifi = false;
  const inside = (f.contents ?? []).filter((c) => {
    if (!c) return false;
    if (isWifiContent(c)) return !wifi && (wifi = true);
    return typeof c.entity === 'string' && !!c.entity;
  });
  if (!inside.length) return [];
  return f.entity && !inside.some((c) => c.entity === f.entity) ? [{ entity: f.entity }, ...inside] : inside;
}

/** Top-view drawing of a placed piece in its local box (centered at 0,0). */
export function drawFurniture(f: FurnitureConfig, live?: PieceLive): SVGTemplateResult {
  const r = resolveFurniture(f);
  if (!r.k) return R(-f.w / 2, -f.h / 2, f.w, f.h, 6, r.color);
  const body = r.k.draw({ w: f.w, h: f.h, v: r.variant, n: r.count, c: r.color, a: r.accent, flip: r.flip, live });
  return r.flip && !['sofa', 'desk', 'counter'].includes(r.k.kind) ? svg`<g transform="scale(-1 1)">${body}</g>` : body;
}

/** Draw order: rugs, then furniture, then things standing on top, then wall-mounted items. */
export function furnitureLayer(f: FurnitureConfig): number {
  const r = resolveFurniture(f);
  if (r.k?.kind === 'rug' || r.k?.kind === 'irrigation_zone') return 0;
  if (r.elevation > 0) return 3;
  if (r.k?.onTop) return 2;
  return 1;
}


/** Pieces that dock against walls when dragged near one (back side to the wall). */
const WALL_SNAP = new Set([
  'sofa', 'tv_stand', 'sideboard', 'shelf', 'piano', 'bed', 'wardrobe', 'dresser', 'vanity', 'desk', 'counter', 'tall_cabinet',
  'pantry', 'range', 'oven', 'fridge', 'freezer', 'dishwasher', 'bathtub', 'toilet', 'washbasin', 'washer', 'dryer', 'coat_rack',
  'shoe_cabinet', 'robot_dock', 'computer', 'light_strip', 'space_heater', 'network',
  'garage_door', 'water_heater', 'boiler', 'server_rack', 'fireplace', 'ventilation', 'water_softener', 'aquarium', 'sauna', 'fuse_box',
]);

/** Whether a placed piece should dock against a wall (wall-mounted items always do). */
export function snapsToWall(f: FurnitureConfig): boolean {
  const r = resolveFurniture(f);
  if (!r.k) return false;
  if (r.ceiling && r.k.kind !== 'light_strip') return false; // hangs freely from the ceiling
  if (r.elevation > 0) return true;
  if (r.k.kind === 'bathtub' && r.variant === 'free') return false;
  if (r.k.kind === 'space_heater' && r.variant !== 'infrared' && r.variant !== 'fireplace') return false;
  return WALL_SNAP.has(r.k.kind);
}
