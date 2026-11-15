import type { FurnitureConfig } from './types';
import { resolveFurniture, stairPlan } from './furniture';
import { tone } from './colors';
import { petRig, type Blob } from './pets';
import { flattenModel, pieceModel } from './models';

/**
 * 3D models of furniture, built from simple solids in real centimetres.
 * Local frame: x along the width (−w/2…w/2), y along the depth (−h/2 back … +h/2 front), z up.
 */
export interface Part {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  /** Top face color (default: a touch lighter than the sides) */
  top?: string;
  /** Rounded top (cm) */
  radius?: number;
  /** Extra rotation of this part (deg) */
  rot?: number;
  /** Cylinder / disc stack instead of a box */
  cyl?: boolean;
  /** Translucent (glass) */
  glass?: boolean;
  /** Show the piece's 2D drawing on this part's top face */
  topSvg?: boolean;
  /** Emits light / heat when the linked entity is active */
  emit?: boolean;
  /** Ceiling cord: dropped while the piece floats above the cut-away walls */
  cord?: boolean;
  /** Transparent faces (only the top drawing shows, e.g. fan blades) */
  clear?: boolean;
  /** Rounded body: stacked slabs with this corner radius (cm) — soft appliance shapes */
  round?: number;
  /** Side shading range [bottom, top] (0 = darkest) — keeps turned bodies smooth across slices */
  shade?: [number, number];
  /** Slice of a sphere (the WebGL renderer draws a real sphere) */
  sphere?: boolean;
}

const B = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: string, extra: Partial<Part> = {}): Part => ({
  x: (x0 + x1) / 2,
  y: (y0 + y1) / 2,
  z: z0,
  w: Math.abs(x1 - x0),
  d: Math.abs(y1 - y0),
  h: Math.max(0.5, z1 - z0),
  color,
  ...extra,
});

const LEG = '#3a3a3c';

/** A sphere from a few discs of varying radius (bottom at z0). */
function sphere(cx: number, cy: number, z0: number, dia: number, color: string, extra: Partial<Part> = {}, slices = 5): Part[] {
  const out: Part[] = [];
  const r = dia / 2;
  for (let i = 0; i < slices; i++) {
    const za = -r + (dia * i) / slices;
    const zb = za + dia / slices;
    const rr = Math.sqrt(Math.max(0, r * r - ((za + zb) / 2) ** 2));
    out.push({ ...B(cx - rr, cy - rr, cx + rr, cy + rr, z0 + r + za, z0 + r + zb, color), cyl: true, sphere: true, ...extra });
  }
  return out;
}
const cyl = (p: Part): Part => ({ ...p, cyl: true });

/** Level of detail: slice thickness (cm) of turned bodies; coarser when the plan is small on screen */
let SLICE = 1.6;
export function setDetail(cm: number) {
  SLICE = Math.max(1.6, cm);
}
/** Rounded-corner body (cm radius) */
const rnd = (p: Part, r: number): Part => ({ ...p, round: r });

/** Turned body from a profile [[z, radius], ...] around (cx, cy): kettles, jugs, bowls, pots. */
function lathe(cx: number, cy: number, profile: [number, number][], color: string, extra: Partial<Part> = {}): Part[] {
  const out: Part[] = [];
  const zMin = profile[0][0];
  const zMax = profile[profile.length - 1][0];
  const span = Math.max(1, zMax - zMin);
  for (let i = 0; i < profile.length - 1; i++) {
    const [za, ra] = profile[i];
    const [zb, rb] = profile[i + 1];
    // fine slices with interpolated radius and continuous shading
    const k = Math.max(1, Math.round((zb - za) / SLICE));
    for (let j = 0; j < k; j++) {
      const z0 = za + ((zb - za) * j) / k;
      const z1 = za + ((zb - za) * (j + 1)) / k;
      const t = (j + 0.5) / k;
      const rr = ra + (rb - ra) * t;
      out.push({ ...B(cx - rr, cy - rr, cx + rr, cy + rr, z0, z1, color), cyl: true, shade: [(z0 - zMin) / span, (z1 - zMin) / span], ...extra });
    }
  }
  return out;
}

const STEEL = '#c9cdd2';
const INK = '#1c1c1e';
const GLASS = '#a9c4d6';

/** Small appliances & gadgets, modelled from their real parts. Front = +y. */
function gadgetParts(kind: string, v: string, w: number, d: number, H: number, c: string, a: string, n: number): Part[] | undefined {
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const m = Math.min(w, d);
  switch (kind) {
    case 'thermomix': {
      // base with front display tower, stainless jug with handle, lid and measuring cup
      const by = y0 + d * 0.42;
      const R0 = m * 0.27;
      return [
        rnd(B(x0, y0, x1, y1, 0, 2, '#d4d4d0'), m * 0.24),
        rnd(B(x0, y0, x1, y1, 2, H * 0.36, c), m * 0.24),
        rnd(B(x0 + w * 0.22, y1 - d * 0.32, x1 - w * 0.22, y1 - 1, H * 0.36, H * 0.5, c), 3),
        B(x0 + w * 0.27, y1 - 1.6, x1 - w * 0.27, y1 - 0.8, H * 0.38, H * 0.48, INK, { emit: true }),
        cyl(B(-2.2, y1 - 1, 2.2, y1 + 1.2, H * 0.12, H * 0.27, '#3a3a3c')),
        ...lathe(0, by, [[H * 0.36, R0 * 0.82], [H * 0.55, R0 * 0.9], [H * 0.75, R0 * 0.98], [H * 0.88, R0]], STEEL),
        B(R0 * 0.85, by - 1.4, R0 + 3.2, by + 1.4, H * 0.42, H * 0.84, '#3a3a3c', { radius: 1 }),
        cyl(B(-R0 - 0.6, by - R0 - 0.6, R0 + 0.6, by + R0 + 0.6, H * 0.88, H * 0.93, a)),
        cyl(B(-R0 * 0.32, by - R0 * 0.32, R0 * 0.32, by + R0 * 0.32, H * 0.93, H, '#e9e6df', { glass: true })),
      ];
    }
    case 'kettle': {
      const cx = -w * 0.06;
      const R0 = m * 0.42;
      return [
        cyl(B(cx - R0 * 1.02, -R0 * 1.02, cx + R0 * 1.02, R0 * 1.02, 0, 1.8, a)),
        ...lathe(cx, 0, [[1.8, R0 * 0.98], [H * 0.3, R0], [H * 0.6, R0 * 0.92], [H * 0.82, R0 * 0.78], [H * 0.88, R0 * 0.7]], c),
        cyl(B(cx - R0 * 0.62, -R0 * 0.62, cx + R0 * 0.62, R0 * 0.62, H * 0.88, H * 0.93, a)),
        cyl(B(cx - 1.4, -1.4, cx + 1.4, 1.4, H * 0.93, H * 0.98, a)),
        // handle (side) and spout (opposite side)
        B(cx + R0 * 0.9, -1.3, cx + R0 + 3.2, 1.3, H * 0.2, H * 0.86, a, { radius: 1 }),
        B(cx + R0 * 0.6, -1.3, cx + R0 + 3.2, 1.3, H * 0.8, H * 0.9, a, { radius: 1 }),
        B(cx - R0 - 3.5, -1.6, cx - R0 * 0.7, 1.6, H * 0.66, H * 0.8, c, { radius: 1 }),
        // water level window
        B(cx - 1, R0 * 0.92, cx + 1, R0 * 1.0, H * 0.22, H * 0.7, GLASS, { glass: true }),
      ];
    }
    case 'airfryer': {
      const dual = v === 'dual';
      const fy = y1 - d * 0.36;
      const drawers = dual
        ? [
            rnd(B(x0 + 1.5, fy, -0.6, y1, 2, H * 0.6, tone(c, -0.04)), 3),
            rnd(B(0.6, fy, x1 - 1.5, y1, 2, H * 0.6, tone(c, -0.04)), 3),
            B(x0 + w * 0.12, y1, -w * 0.12, y1 + 3, H * 0.22, H * 0.4, a, { radius: 1 }),
            B(w * 0.12, y1, x1 - w * 0.12, y1 + 3, H * 0.22, H * 0.4, a, { radius: 1 }),
          ]
        : [rnd(B(x0 + 1.5, fy, x1 - 1.5, y1, 2, H * 0.6, tone(c, -0.04)), m * 0.2), B(-w * 0.17, y1, w * 0.17, y1 + 3.4, H * 0.18, H * 0.44, a, { radius: 1 })];
      return [
        rnd(B(x0, y0, x1, y1 - 1, 0, H, c), dual ? 6 : m * 0.38),
        ...drawers,
        rnd(B(-w * 0.2, y1 - d * 0.3, w * 0.2, y1 - d * 0.08, H, H + 0.4, INK, { emit: true }), 2),
        B(x0 + w * 0.2, y0 + 1.5, x1 - w * 0.2, y0 + 4, H * 0.55, H * 0.9, '#2a2a2c'),
      ];
    }
    case 'coffee': {
      const fy = y1 - d * 0.22;
      return [
        rnd(B(x0, y0, x1, fy, 0, H, c), 3),
        // front head with display above the cup bay
        rnd(B(x0, fy, x1, y1 - 1, H * 0.58, H, c), 3),
        B(x0 + 3, y1 - 1.2, x1 - 3, y1 - 0.5, H * 0.72, H * 0.93, INK, { emit: true }),
        B(-3.5, fy + 1, 3.5, y1 - 2.5, H * 0.46, H * 0.58, '#8d9297', { radius: 1 }),
        B(x0 + 1.5, fy - 2, x1 - 1.5, y1, 0, 2.5, '#8d9297', { radius: 1 }),
        cyl(B(-2.6, fy + 1.6, 2.6, fy + 6.8, 2.5, 9.5, '#f4f4f2')),
        // bean hopper lid and water tank (side)
        rnd(B(x0 + 3, y0 + 3, x1 - 3, y0 + d * 0.32, H, H + 0.8, tone(c, 0.14)), 3),
        B(x1 - 0.4, y0 + 4, x1 + 0.4, y0 + d * 0.5, H * 0.2, H * 0.85, GLASS, { glass: true }),
        B(x0 - 0.3, y0 + d * 0.3, x0 + 0.3, fy, H * 0.12, H * 0.3, a),
      ];
    }
    case 'espresso': {
      const fy = y1 - d * 0.3;
      const gy = fy + 4;
      return [
        rnd(B(x0, y0, x1, fy, 0, H, c), 2),
        B(x0 + 1.5, y0 + 1.5, x1 - 1.5, fy - 1.5, H, H + 2.2, '#d7dadd'),
        B(x0, fy, x1, fy + 6, H * 0.62, H, c, { radius: 1 }),
        // group head + portafilter with handle
        cyl(B(-4, gy - 4, 4, gy + 4, H * 0.52, H * 0.62, STEEL)),
        cyl(B(-3.6, gy - 3.6, 3.6, gy + 3.6, H * 0.45, H * 0.52, '#8d9297')),
        B(-1.4, gy + 2, 1.4, y1 + 3, H * 0.47, H * 0.52, a, { radius: 1 }),
        // gauges on the front head
        cyl(B(x0 + w * 0.18, fy + 5.6, x0 + w * 0.18 + 5, fy + 6.2, H * 0.72, H * 0.9, '#f4f4f2')),
        cyl(B(x1 - w * 0.18 - 5, fy + 5.6, x1 - w * 0.18, fy + 6.2, H * 0.72, H * 0.9, '#f4f4f2')),
        // steam wand and drip tray
        B(x1 - 4.5, fy + 2, x1 - 3.3, fy + 6, H * 0.18, H * 0.62, STEEL),
        B(x0 + 3, fy - 1, x1 - 3, y1, 0, 3.5, '#8d9297', { radius: 1 }),
        cyl(B(-2.4, gy - 2.4, 2.4, gy + 2.4, 3.5, 9, '#f4f4f2')),
      ];
    }
    case 'toaster': {
      const slots = v === '4' ? [-d * 0.3, -d * 0.12, d * 0.12, d * 0.3] : [-d * 0.15, d * 0.15];
      return [
        rnd(B(x0 + 1, y0 + 1, x1 - 1, y1 - 1, 0, 1.5, '#3a3a3c'), 3),
        rnd(B(x0, y0, x1, y1, 1.5, H, c), Math.min(6, m * 0.3)),
        ...slots.map((sy) => rnd(B(x0 + w * 0.14, sy - 1.1, x1 - w * 0.14, sy + 1.1, H, H + 0.3, '#151515'), 1)),
        B(x1 - 0.5, -1.2, x1 + 2.5, 1.2, H * 0.45, H * 0.62, a, { radius: 1 }),
        cyl(B(-w * 0.3 - 1.3, y1 - 0.4, -w * 0.3 + 1.3, y1 + 1, H * 0.3, H * 0.45, a)),
      ];
    }
    case 'mixer': {
      // stand mixer: base, column, tilting head, steel bowl, beater
      const by = y1 - d * 0.36;
      return [
        rnd(B(x0 + w * 0.08, y0, x1 - w * 0.08, y1, 0, H * 0.1, c), 5),
        rnd(B(x0 + w * 0.16, y0 + 1, x1 - w * 0.16, y0 + d * 0.3, H * 0.1, H * 0.74, c), 4),
        rnd(B(x0 + w * 0.12, y0 + 1, x1 - w * 0.12, y1 - d * 0.14, H * 0.68, H, c), 6),
        cyl(B(-2.4, y1 - d * 0.12 - 2.4, 2.4, y1 - d * 0.12 + 2.4, H * 0.76, H * 0.92, a)),
        ...lathe(0, by, [[H * 0.1, m * 0.22], [H * 0.25, m * 0.36], [H * 0.42, m * 0.44], [H * 0.5, m * 0.46]], STEEL),
        B(-0.8, by - 0.8, 0.8, by + 0.8, H * 0.2, H * 0.68, '#d7dadd'),
      ];
    }
    case 'blender':
      return [
        rnd(B(x0, y0, x1, y1, 0, H * 0.26, c), 4),
        B(x0 + w * 0.3, y1 - 0.4, x1 - w * 0.3, y1 + 0.4, H * 0.08, H * 0.2, INK, { emit: true }),
        rnd(B(x0 + 2, y0 + 2, x1 - 2, y1 - 2, H * 0.26, H * 0.88, a, { glass: true }), 3),
        rnd(B(x0 + 1.6, y0 + 1.6, x1 - 1.6, y1 - 1.6, H * 0.88, H * 0.95, '#2c2c2e'), 3),
        cyl(B(-2.5, -2.5, 2.5, 2.5, H * 0.95, H, '#2c2c2e')),
        B(x1 - 2, -1.5, x1 + 2.5, 1.5, H * 0.32, H * 0.82, '#2c2c2e', { radius: 1 }),
      ];
    case 'bread_maker':
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 6),
        rnd(B(x0 + 4, y0 + 4, x1 - 4, y1 - d * 0.32, H, H + 0.4, '#2c2c2e', { glass: true }), 4),
        rnd(B(x0 + 4, y1 - d * 0.28, x1 - 4, y1 - 3, H, H + 0.4, '#d7dadd'), 2),
        B(-w * 0.15, y1 - d * 0.22, w * 0.15, y1 - d * 0.12, H + 0.4, H + 0.7, INK, { emit: true }),
      ];
    case 'microwave':
      return [
        ...[x0 + 3, x1 - 5].flatMap((fx) => [B(fx, y0 + 3, fx + 2, y0 + 5, 0, 1, '#3a3a3c'), B(fx, y1 - 5, fx + 2, y1 - 3, 0, 1, '#3a3a3c')]),
        rnd(B(x0, y0, x1, y1, 1, H, c), 2),
        B(x0 + 2, y1 - 0.4, x0 + w * 0.7, y1 + 0.4, 3, H - 3, '#16181c'),
        B(x0 + 4, y1 + 0.3, x0 + w * 0.68, y1 + 0.5, 5, H - 5, '#2a2e36'),
        B(x0 + w * 0.73, y1 - 0.4, x1 - 2, y1 + 0.4, 3, H - 3, tone(c, 0.12)),
        B(x0 + w * 0.75, y1 + 0.3, x1 - 3, y1 + 0.6, H * 0.7, H * 0.85, INK, { emit: true }),
        B(x0 + w * 0.66, y1 + 0.4, x0 + w * 0.69, y1 + 2.2, H * 0.2, H * 0.8, a),
      ];
    case 'robot_vacuum': {
      // round body, a slightly lighter lid, the bumper as an arc around the front (+y), the laser turret a little
      // behind the middle with its window to the front, a status light
      const R0 = m / 2;
      const dark = '#18181a';
      const bumper = (deg: number) => {
        const a = (deg * Math.PI) / 180;
        const r = R0 * 0.97;
        const cx = Math.sin(a) * r;
        const cy = Math.cos(a) * r;
        return B(cx - R0 * 0.3, cy - 0.8, cx + R0 * 0.3, cy + 0.8, 1.4, H * 0.6, dark, { rot: -deg, radius: 0.6 });
      };
      return [
        cyl(B(-R0 * 0.93, -R0 * 0.93, R0 * 0.93, R0 * 0.93, 0, 1.4, '#0f0f10')),
        cyl(B(-R0, -R0, R0, R0, 1.4, H * 0.7, c, { top: tone(c, 0.06) })),
        cyl(B(-R0 * 0.92, -R0 * 0.92, R0 * 0.92, R0 * 0.92, H * 0.7, H * 0.74, tone(c, 0.14), { top: tone(c, 0.12) })),
        bumper(-52),
        bumper(-18),
        bumper(18),
        bumper(52),
        cyl(B(-R0 * 0.29, -R0 * 0.44, R0 * 0.29, R0 * 0.14, H * 0.74, H, a, { top: tone(a, 0.18) })),
        B(-R0 * 0.13, R0 * 0.1, R0 * 0.13, R0 * 0.16, H * 0.8, H * 0.95, '#0b0b0d'),
        B(-R0 * 0.16, R0 * 0.54, R0 * 0.16, R0 * 0.6, H * 0.72, H * 0.76, '#7fe0a0', { emit: true, radius: 0.4 }),
      ];
    }
    case 'robot_dock':
      if (v === 'dock')
        return [
          B(x0, y0, x1, y1 + 6, 0, 0.8, '#2c2c2e', { radius: 2 }),
          rnd(B(x0 + 1, y0, x1 - 1, y0 + d * 0.8, 0, H, c), 3),
          B(-w * 0.15, y0 + d * 0.8 - 0.2, w * 0.15, y0 + d * 0.8 + 0.3, H * 0.55, H * 0.75, '#5fd0c6', { emit: true }),
          B(-w * 0.3, y0 + d * 0.8, -w * 0.18, y0 + d * 0.8 + 1, 0.8, 2.5, STEEL),
          B(w * 0.18, y0 + d * 0.8, w * 0.3, y0 + d * 0.8 + 1, 0.8, 2.5, STEEL),
        ];
      {
        // self-empty / mop station: tower with clean & dirty water tanks, robot bay with ramp in front
        const ty = y0 + d * 0.58;
        return [
          rnd(B(x0 + 2, y0 + d * 0.2, x1 - 2, y1, 0, 2.2, '#2c2c2e'), 4),
          B(x0 + 4, y0 + d * 0.62, x1 - 4, y1 - 2, 2.2, 2.6, '#3a3a3c'),
          rnd(B(x0, y0, x1, ty, 0, H, c), 4),
          // overhang above the robot bay
          rnd(B(x0, ty - 2, x1, ty + d * 0.18, H * 0.32, H, c), 4),
          // two tanks seen through the front
          rnd(B(x0 + 2.5, ty + d * 0.18 - 0.6, -0.8, ty + d * 0.18 + 0.3, H * 0.45, H * 0.9, '#cfe2ef', { glass: true }), 2),
          rnd(B(0.8, ty + d * 0.18 - 0.6, x1 - 2.5, ty + d * 0.18 + 0.3, H * 0.45, H * 0.9, '#8f979e', { glass: true }), 2),
          // lid seam + status light
          rnd(B(x0 + 1.5, y0 + 1.5, x1 - 1.5, ty + d * 0.18 - 1.5, H, H + 0.5, tone(c, 0.08)), 3),
          B(-w * 0.12, ty + d * 0.18 - 0.2, w * 0.12, ty + d * 0.18 + 0.4, H * 0.36, H * 0.4, '#5fd0c6', { emit: true }),
        ];
      }
    case 'stick_vacuum':
      return [
        B(-6, y0, 6, y0 + 3, H * 0.6, H * 0.78, '#e9e6df', { radius: 1 }),
        rnd(B(x0 + 2, y0 + 3, x1 - 2, y1, 0, 6, c), 4),
        B(x0 + 3, y1 - 3, x1 - 3, y1, 0.5, 4, a, { radius: 1 }),
        B(-1.3, y0 + 7.5, 1.3, y0 + 10.1, 6, H * 0.64, '#b8bcc1'),
        cyl(B(-5, y0 + 4, 5, y0 + 14, H * 0.6, H * 0.8, c)),
        cyl(B(-3.2, y0 + 5.8, 3.2, y0 + 12.2, H * 0.62, H * 0.78, a, { glass: true })),
        B(-1.6, y0 + 4, 1.6, y0 + 7, H * 0.78, H, '#2c2c2e', { radius: 1 }),
      ];
    case 'speaker':
      if (v === 'box') return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), B(x0 + 2, y1 - 0.3, x1 - 2, y1 + 0.3, H * 0.08, H * 0.92, a, { emit: true })];
      if (v === 'soundbar') return [rnd(B(x0, y0, x1, y1, 0, H, c), Math.min(3, d / 2)), B(x0 + 3, y1 - 0.3, x1 - 3, y1 + 0.2, H * 0.2, H * 0.8, a), B(-3, y0 + 2, 3, y0 + 4, H, H + 0.2, '#e9e6df', { emit: true })];
      if (v === 'mini') return [...sphere(0, 0, -m * 0.08, m * 1.0, c, {}, 6).slice(1), cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, H - 0.4, H, a, { emit: true }))];
      return [
        ...lathe(0, 0, [[0, m * 0.4], [H * 0.12, m * 0.48], [H * 0.82, m * 0.5], [H, m * 0.4]], c),
        cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, H, H + 0.3, a, { emit: true })),
      ];
    case 'router':
      if (v === 'fritzbox')
        return [rnd(B(x0, y0, x1, y1, 0, H * 0.55, '#f4f4f2'), 4), rnd(B(x0 + 1, y0 + 1, x1 - 1, y1 - 1, H * 0.55, H, '#d4222a'), 4), ...[0, 1, 2, 3, 4].map((i) => B(x0 + 4 + i * 3, y1 - 0.2, x0 + 5 + i * 3, y1 + 0.3, H * 0.2, H * 0.4, '#5fd06a', { emit: true }))];
      if (v === 'fritzbox_upright')
        return [B(x0 - 1, y0 - 1, x1 + 1, y1 + 1, 0, 1, '#d7dadd', { radius: 2 }), rnd(B(x0, y0, x1, y1, 1, H, '#f4f4f2'), 2), B(x0, y0 - 0.3, x0 + w * 0.3, y1 + 0.3, H * 0.15, H, '#d4222a', { radius: 1 }), ...[0, 1, 2].map((i) => B(x0 + w * 0.45 + i * 2.5, y1, x0 + w * 0.45 + i * 2.5 + 1, y1 + 0.3, H * 0.8, H * 0.86, '#5fd06a', { emit: true }))];
      if (v === 'mesh') return [rnd(B(x0, y0, x1, y1, 0, H, c), m * 0.25), cyl(B(-0.8, y1 - 0.4, 0.8, y1 + 0.2, H * 0.7, H * 0.8, '#5fd06a', { emit: true }))];
      if (v === 'ont') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1.5), ...[0, 1, 2].map((i) => B(x0 + 3 + i * 3, y1 - 0.1, x0 + 4 + i * 3, y1 + 0.2, H * 0.75, H * 0.8, '#5fd06a', { emit: true }))];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 3),
        ...[x0 + 3, x0 + w * 0.36, x1 - w * 0.36, x1 - 3].slice(0, n || 4).map((ax) => rnd(B(ax - 0.8, y0 + 0.5, ax + 0.8, y0 + 2, H, H + 15, '#2c2c2e'), 0.8)),
        ...[0, 1, 2].map((i) => B(x0 + w * 0.3 + i * 3, y1 - 0.2, x0 + w * 0.3 + i * 3 + 1, y1 + 0.3, H * 0.4, H * 0.6, '#5fd06a', { emit: true })),
      ];
    case 'printer':
      return [
        rnd(B(x0, y0, x1, y1 - 4, 0, H, c), 3),
        rnd(B(x0 + 2, y0 + 2, x1 - 2, y1 - 8, H, H + 0.6, tone(c, 0.08)), 2),
        B(x0 + w * 0.15, y1 - 6, x1 - w * 0.15, y1, 3, 4.5, tone(c, -0.08)),
        B(x0 + w * 0.15, y1 - 4.5, x1 - w * 0.15, y1 - 4, H * 0.55, H * 0.62, '#1a1a1a'),
        B(x1 - 9, y1 - 4.4, x1 - 3, y1 - 3.8, H * 0.7, H * 0.88, INK, { emit: true }),
      ];
    case 'computer':
      if (v === 'big')
        return [
          rnd(B(x0, y0, x1, y1, 2, H, c), 2),
          ...legs(x0, y0, x1, y1, 2, 3, '#3a3a3c', 1),
          // tempered glass side with RGB glow inside
          B(x0 - 0.3, y0 + 3, x0 + 0.3, y1 - 3, 5, H - 3, '#2a3348', { glass: true }),
          B(x0 + 1, y0 + 5, x0 + 2, y1 - 5, 8, H - 6, '#7b5cff', { emit: true }),
          cyl(B(-4, y1 - 0.2, 4, y1 + 0.5, H * 0.55, H * 0.85, '#4b4f54')),
          cyl(B(-1.2, y1 + 0.3, 1.2, y1 + 0.8, H - 6, H - 4, '#5fb0ff', { emit: true })),
        ];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 2),
        B(x0 + 2, y1 - 0.3, x1 - 2, y1 + 0.3, 3, H - 3, tone(c, 0.08)),
        cyl(B(-1.4, y1 + 0.2, 1.4, y1 + 0.8, H * 0.86, H * 0.92, '#5fb0ff', { emit: true })),
        B(x0 - 0.3, y0 + 4, x0 + 0.3, y1 - 4, H * 0.2, H * 0.85, '#2a2a2c', { glass: true }),
      ];
    case 'console':
      if (v === 'xbox_s')
        return [rnd(B(x0, y0, x1, y1, 0, H, '#f4f4f2'), 1.5), cyl(B(w * 0.22 - m * 0.22, -m * 0.22, w * 0.22 + m * 0.22, m * 0.22, H, H + 0.2, '#1f1f21')), B(x0 + 2, y1 - 0.2, x0 + 3, y1 + 0.2, H * 0.4, H * 0.6, '#f4f4f2', { emit: true })];
      if (v === 'ps5')
        return [rnd(B(x0 + w * 0.2, y0 + 2, x1 - w * 0.2, y1 - 2, 0, H, '#1f1f21'), 2), rnd(B(x0, y0, x0 + w * 0.22, y1, 0, H, '#f4f4f2'), 3), rnd(B(x1 - w * 0.22, y0, x1, y1, 0, H, '#f4f4f2'), 3), B(x0 + w * 0.2, y1 - 1.6, x1 - w * 0.2, y1 - 1.2, H * 0.1, H * 0.9, '#5fb0ff', { emit: true })];
      if (v === 'switch')
        return [rnd(B(x0, y0, x1, y1, 0, H, '#2c2c2e'), 1.5), B(x0 - 1.2, y0 + 0.5, x0, y1 - 0.5, H * 0.3, H + 1.5, '#e4002b', { radius: 1 }), B(x1, y0 + 0.5, x1 + 1.2, y1 - 0.5, H * 0.3, H + 1.5, '#00a8e8', { radius: 1 }), B(x0 + 0.2, y0 + 1, x1 - 0.2, y1 - 1, H, H + 1.5, '#111')];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 2),
        cyl(B(-m * 0.36, -m * 0.36, m * 0.36, m * 0.36, H, H + 0.6, '#111')),
        cyl(B(-1.4, y1 - 0.2, 1.4, y1 + 0.3, H * 0.86, H * 0.94, '#f4f4f2', { emit: true })),
      ];
    case 'streaming_box':
      if (v === 'stick') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1)];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), m * 0.22), B(-1.5, -1.5, 1.5, 1.5, H, H + 0.1, '#3a3a3c'), B(x0 + 1, y1 - 0.2, x0 + 2, y1 + 0.1, H * 0.4, H * 0.6, '#f4f4f2', { emit: true })];
    case 'remote':
      if (v === 'siri') return [rnd(B(x0, y0, x1, y1, 0, H, '#c9cdd2'), w / 2), cyl(B(-w * 0.32, y0 + w * 0.55, w * 0.32, y0 + w * 1.2, H, H + 0.15, '#2c2c2e'))];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), w / 2), ...[0, 1, 2, 3, 4].map((i) => cyl(B(-0.6, y0 + 3 + i * 2.6, 0.6, y0 + 4.2 + i * 2.6, H, H + 0.3, i ? a : '#c94a3a')))];
    case 'mini_pc': {
      const col = v === 'macmini' ? '#d7dadd' : v === 'pi' ? '#c94a3a' : c;
      return [
        rnd(B(x0, y0, x1, y1, 0.4, H, col), m * (v === 'macmini' ? 0.18 : 0.06)),
        rnd(B(x0 + 1, y0 + 1, x1 - 1, y1 - 1, 0, 0.4, '#1f1f21'), 2),
        cyl(B(x1 - 3, y1 - 0.2, x1 - 1.8, y1 + 0.2, H * 0.4, H * 0.7, '#5fb0ff', { emit: true })),
      ];
    }
    case 'laptop':
      if (v === 'closed') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1.5)];
      return [
        rnd(B(x0, y0, x1, y1, 0, 1.2, c), 1.5),
        B(x0 + 1.5, y0 + 2, x1 - 1.5, y0 + d * 0.55, 1.2, 1.3, '#3a3a3c'),
        B(-w * 0.18, y1 - d * 0.38, w * 0.18, y1 - d * 0.12, 1.2, 1.25, tone(c, -0.06)),
        // screen, tilted back a little: modelled upright at the back edge
        B(x0, y0 - 0.2, x1, y0 + 0.5, 1.2, H, c, { radius: 1 }),
        B(x0 + 1, y0 + 0.5, x1 - 1, y0 + 0.7, 2.2, H - 1, '#1c1f26', { emit: true }),
      ];
    case 'hdmi_switch':
      return [rnd(B(x0, y0, x1, y1, 0, H, c), 1), ...[0, 1, 2, 3].map((i) => B(x0 + 3 + i * 3, y1 - 0.1, x0 + 3.8 + i * 3, y1 + 0.2, H * 0.4, H * 0.7, '#5fd06a', { emit: true }))];
    case 'network':
      if (v === 'rack')
        return [B(x0, y0, x1, y1, 0, H, c, { radius: 2 }), B(x0 + 3, y1 - 0.4, x1 - 3, y1 + 0.2, 4, H - 4, '#2a3040', { glass: true }), ...[0, 1, 2].map((i) => B(x0 + 6, y1 - 4, x1 - 6, y1 - 2, 12 + i * 12, 16 + i * 12, '#2c2c2e')), ...[0, 1, 2].map((i) => B(x0 + 8 + i * 4, y1 - 2.2, x0 + 9 + i * 4, y1 - 1.6, 14 + i * 12, 15 + i * 12, '#5fd06a', { emit: true }))];
      if (v === 'nas')
        return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), B(x0 + 1.5, y1 - 0.2, x1 - 1.5, y1 + 0.2, H * 0.12, H * 0.82, '#2c2c2e'), ...[0, 1].map((i) => B(x0 + 3 + i * 5, y1 + 0.2, x0 + 4 + i * 5, y1 + 0.4, H * 0.88, H * 0.92, '#5fd06a', { emit: true }))];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 1),
        B(x0, y0, x1, y0 + 1.2, H, H + 0.1, v === 'firewall' ? a : '#3a3a3c'),
        ...Array.from({ length: v === 'switch' ? 8 : 4 }, (_, i) => B(x0 + 3 + i * 3, y1 - 0.1, x0 + 4.4 + i * 3, y1 + 0.2, H * 0.35, H * 0.7, '#5fd06a', { emit: true })),
      ];
    case 'ebike_battery':
      if (v === 'upright') return [rnd(B(x0, y0, x1, y1, 0, H, c), m * 0.3), B(x0 + 1, y1 - 0.2, x0 + 3, y1 + 0.2, H * 0.8, H * 0.9, '#5fd06a', { emit: true })];
      if (v === 'charging')
        return [
          rnd(B(x0, y0, x1, y0 + d * 0.45, 0, H, c), 3),
          B(x0 + 2, y0 + 1, x0 + 8, y0 + 1.5, H, H + 0.1, '#5fd06a', { emit: true }),
          rnd(B(x0 + 2, y0 + d * 0.55, x0 + w * 0.5, y1, 0, H * 0.45, a), 2),
          B(x0 + w * 0.5, y0 + d * 0.7, x0 + w * 0.7, y0 + d * 0.74, 0, 0.6, '#1f1f21'),
          cyl(B(x0 + 3, y0 + d * 0.75, x0 + 4.5, y0 + d * 0.85, H * 0.45, H * 0.5, '#5fd06a', { emit: true })),
        ];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), m * 0.3), B(x0 + 2, y1 - 0.2, x0 + 7, y1 + 0.2, H * 0.6, H * 0.75, '#5fd06a', { emit: true })];
    case 'sensor':
      if (v === 'smoke') return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(-1, -1, 1, 1, -0.3, 0, '#c94a3a', { emit: true }))];
      if (v === 'leak') return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(-0.8, -0.8, 0.8, 0.8, H, H + 0.1, '#5fb0ff', { emit: true }))];
      if (v === 'motion') return [rnd(B(x0, y0, x1, y0 + 1, 0, H, c), 1), ...sphere(0, y0 + 2, 0, Math.min(w, H) * 0.9, c, {}, 4), cyl(B(-0.5, y1 - 0.6, 0.5, y1 - 0.2, H * 0.5, H * 0.6, '#c94a3a', { emit: true }))];
      if (v === 'display') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1), B(x0 + 0.6, y1 - 0.1, x1 - 0.6, y1 + 0.1, H * 0.2, H * 0.8, '#d7dadd', { emit: true })];
      if (v === 'presence') return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, -0.3, 0, '#3a3f48', { emit: true }))];
      if (v === 'co') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1.5), B(x0 + w * 0.25, y1 - 0.1, x1 - w * 0.25, y1 + 0.2, H * 0.7, H * 0.8, '#c94a3a', { emit: true }), ...[0, 1, 2].map((i) => B(x0 + w * 0.2, y1 - 0.1, x1 - w * 0.2, y1 + 0.15, H * (0.2 + i * 0.12), H * (0.2 + i * 0.12) + 0.6, tone(c, -0.15)))];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), Math.min(w, d) * 0.3), B(-0.4, y1 - 0.1, 0.4, y1 + 0.1, H * 0.15, H * 0.3, '#5fd06a', { emit: true })];
    case 'smart_plug':
      if (v === 'strip')
        return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), ...Array.from({ length: 5 }, (_, i) => cyl(B(x0 + 4 + i * ((w - 12) / 4), -1.6, x0 + 7 + i * ((w - 12) / 4), 1.6, H, H + 0.2, tone(c, -0.1)))), B(x1 - 4, -0.8, x1 - 2.4, 0.8, H, H + 0.3, '#f4f4f2', { emit: true })];
      if (v === 'wall') return [rnd(B(x0, y0, x1, y1, 0, H, c), 1), cyl(B(-2.5, y1 - 0.2, 2.5, y1 + 0.5, H * 0.2, H * 0.8, tone(c, -0.08))), B(x0 + 1, y1 + 0.4, x0 + 2, y1 + 0.6, H * 0.8, H * 0.9, '#f4f4f2', { emit: true })];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), Math.min(w, H) * 0.3), B(x0 + 1, y1 - 0.1, x1 - 1, y1 + 0.1, H * 0.1, H * 0.22, '#f4f4f2', { emit: true })];
    case 'trash':
      if (v === 'sorting') return undefined;
      return [
        ...lathe(0, 0, [[0, m * 0.44], [H * 0.9, m * 0.5]], c),
        cyl(B(-m * 0.51, -m * 0.51, m * 0.51, m * 0.51, H * 0.9, H, tone(c, -0.05), { top: tone(c, 0.12) })),
        B(-m * 0.18, m * 0.44, m * 0.18, m * 0.56, 0.5, 3, '#3a3a3c', { radius: 1 }),
      ];
  }
  return undefined;
}

const LED = '#5fd06a';

/** Smart-home devices, utilities, leisure: a handful of solids each (front = +y, back against the wall). */
function deviceParts(kind: string, v: string, w: number, d: number, H: number, c: string, a: string, n: number): Part[] | undefined {
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const m = Math.min(w, d);
  switch (kind) {
    case 'bike_rack': {
      const k = Math.max(1, n);
      const out: Part[] = [B(x0, -2, x1, 2, 0, 3, tone(c, -0.15))];
      for (let i = 0; i < k; i++) {
        const x = x0 + (w / k) * (i + 0.5);
        out.push(B(x - 1.5, y0, x + 1.5, y0 + 3, 0, H, c), B(x - 1.5, y1 - 3, x + 1.5, y1, 0, H, c), B(x - 1.5, y0, x + 1.5, y1, H - 3, H, c, { radius: 1 }));
      }
      return out;
    }
    case 'meter':
      if (v === 'water') return [cyl(B(x0, -1.5, x1, 1.5, H * 0.3, H * 0.6, '#b87333')), cyl(B(-m * 0.45, -m * 0.45, m * 0.45, m * 0.45, 0, H, '#5a8fd8')), cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, H, H + 0.4, '#f4f4f2', { emit: true }))];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, v === 'gas' ? '#d9c27a' : c), 2),
        B(x0 + w * 0.2, y1, x1 - w * 0.2, y1 + 0.4, H * 0.6, H * 0.8, '#1c2a33', { emit: true }),
        B(x0 + w * 0.15, y1, x1 - w * 0.15, y1 + 0.4, H * 0.15, H * 0.3, a),
        ...(v === 'smart' ? [cyl(B(w * 0.12, y1, w * 0.12 + 4.5, y1 + 4, H * 0.62, H * 0.62 + 4.5, '#2c2c2e'))] : []),
      ];
    case 'fuse_box': {
      const rows = Math.max(1, n);
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 2),
        B(x0 + 2, y1, x1 - 2, y1 + 0.3, 2, H - 2, tone(c, -0.04)),
        ...Array.from({ length: rows }, (_, i) => B(x0 + 5, y1 + 0.3, x1 - 5, y1 + 0.8, H * ((i + 0.7) / (rows + 0.6)) - 1.5, H * ((i + 0.7) / (rows + 0.6)) + 1.5, a)),
      ];
    }
    case 'water_softener':
      if (v === 'filter') return [cyl(B(-2, -2, 2, 2, H - 6, H, '#b87333')), cyl(B(-m * 0.48, -m * 0.48, m * 0.48, m * 0.48, 0, H - 6, '#c9d8e6')), cyl(B(-m * 0.28, -m * 0.28, m * 0.28, m * 0.28, H * 0.12, H * 0.7, a))];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), 6), cyl(B(-m * 0.3, y0 + d * 0.2, m * 0.3, y0 + d * 0.2 + m * 0.6, H, H + 1.5, tone(c, -0.06))), B(x0 + w * 0.25, y1, x1 - w * 0.25, y1 + 0.4, H * 0.8, H * 0.88, INK, { emit: true })];
    case 'boiler':
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), v === 'wall' ? 3 : 4),
        B(x0 + w * 0.25, y1, x1 - w * 0.25, y1 + 0.4, H * 0.12, H * 0.2, INK, { emit: true }),
        ...(v === 'wall' ? [-0.3, -0.1, 0.1, 0.3].map((f) => cyl(B(w * f - 1.1, y0 + 4, w * f + 1.1, y0 + 6.2, -22, 0, '#b87333'))) : []),
        ...(v === 'pellet' ? [rnd(B(x0, y0, x0 + w * 0.42, y1, H, H + 0.5, tone(c, -0.08)), 3), cyl(B(w * 0.15, y0 + 6, w * 0.15 + 14, y0 + 20, H, H + 30, '#8d9297'))] : []),
      ];
    case 'water_heater':
      if (v === 'instant') return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), B(x0 + w * 0.25, y1, x1 - w * 0.25, y1 + 0.3, H * 0.6, H * 0.7, INK, { emit: true }), ...[-0.2, 0.2].map((f) => cyl(B(w * f - 1, y0 + 2, w * f + 1, y0 + 4, -14, 0, '#b87333')))];
      return [
        // plain cylinders (not turned slices): tall bodies are cut at the wall height and must stay closed
        cyl(B(-m * 0.47, -m * 0.47, m * 0.47, m * 0.47, 0, 4, tone(c, -0.1))),
        cyl(B(-m * 0.5, -m * 0.5, m * 0.5, m * 0.5, 4, H - 4, c)),
        cyl(B(-m * 0.4, -m * 0.4, m * 0.4, m * 0.4, H - 4, H, tone(c, 0.05))),
        B(-m * 0.12, m * 0.49, m * 0.12, m * 0.52, H * 0.7, H * 0.78, INK, { emit: true }),
        ...(v === 'wall' ? [] : [cyl(B(-1.5, -1.5, 1.5, 1.5, H, H + 12, '#b87333'))]),
      ];
    case 'ventilation':
      if (v === 'vent') return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, -0.4, 0, a, { emit: true }))];
      if (v === 'room') return [rnd(B(x0, y0, x1, y1, 0, H, c), 3), cyl(B(-m * 0.5, y1 - 0.4, m * 0.5, y1 + 0.3, H * 0.25, H * 0.75, a, { emit: true }))];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 4),
        ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => cyl(B(sx * w * 0.3 - m * 0.12, sy * d * 0.28 - m * 0.12, sx * w * 0.3 + m * 0.12, sy * d * 0.28 + m * 0.12, H, H + 18, '#b8bcc1')))),
        B(x0 + w * 0.3, y1, x1 - w * 0.3, y1 + 0.4, H * 0.7, H * 0.8, INK, { emit: true }),
      ];
    case 'fireplace':
      if (v === 'open')
        return [
          B(x0, y0, x1, y1, 0, 12, '#a8a29a', { radius: 1 }),
          B(x0, y0, x1, y1 - 6, 12, H, '#c8c0b4', { radius: 1 }),
          B(x0 + w * 0.2, y1 - 6.4, x1 - w * 0.2, y1 - 5.8, 16, H * 0.6, '#3a2a22', { emit: true }),
          B(x0 - 4, y0, x1 + 4, y1 + 2, H * 0.62, H * 0.66, '#d9cfc1'),
        ];
      return [
        rnd(B(x0, y0, x1, y1, 6, H * 0.82, c), v === 'pellet' ? 4 : 6),
        B(x0 + 3, y0 + 3, x0 + 7, y0 + 7, 0, 6, LEG),
        B(x1 - 7, y0 + 3, x1 - 3, y0 + 7, 0, 6, LEG),
        B(x0 + 3, y1 - 7, x0 + 7, y1 - 3, 0, 6, LEG),
        B(x1 - 7, y1 - 7, x1 - 3, y1 - 3, 0, 6, LEG),
        B(x0 + w * 0.15, y1 - 0.4, x1 - w * 0.15, y1 + 0.2, H * 0.22, H * 0.62, '#3a2a22', { emit: true }),
        cyl(B(-m * 0.13, y0 + d * 0.3 - m * 0.13, m * 0.13, y0 + d * 0.3 + m * 0.13, H * 0.82, H, tone(c, 0.1))),
      ];
    case 'access_point':
      if (v === 'ceiling') return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(-m * 0.12, -m * 0.12, m * 0.12, m * 0.12, -0.3, 0, a, { emit: true }))];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), Math.min(w, d) * 0.3), B(-1.5, y1 - 0.1, 1.5, y1 + 0.2, H * 0.15, H * 0.22, a, { emit: true })];
    case 'server_rack': {
      const k = Math.max(1, Math.min(8, n));
      const out: Part[] = [B(x0, y0, x1, y1, 0, H, c, { radius: 1.5 })];
      const top = H - 8;
      const slot = (top - 8) / 8;
      for (let i = 0; i < k; i++) {
        const z = 8 + i * slot;
        out.push(B(x0 + 4, y1 - 3, x1 - 4, y1 - 1, z + 0.6, z + slot - 0.6, i % 3 === 2 ? '#3a3f48' : '#1f2228'));
        out.push(B(x1 - 10, y1 - 1, x1 - 7, y1 - 0.6, z + slot * 0.4, z + slot * 0.6, a, { emit: true }));
      }
      out.push(B(x0 + 2, y1 - 0.4, x1 - 2, y1, 3, H - 3, '#2a3040', { glass: true }));
      return out;
    }
    case 'ups':
      return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), B(x0 + w * 0.2, y1, x1 - w * 0.2, y1 + 0.4, H * 0.55, H * 0.8, '#1c2a33', { emit: true }), B(x0 + w * 0.4, y1, x0 + w * 0.6, y1 + 0.6, H * 0.25, H * 0.35, '#8d9297')];
    case 'camera':
      if (v === 'outdoor')
        return [
          B(-w * 0.2, y0, w * 0.2, y0 + d * 0.3, H * 0.2, H * 0.8, c),
          rnd(B(x0, y0 + d * 0.2, x1, y1, 0, H, c), w * 0.3),
          cyl(B(-w * 0.24, y1 - 0.2, w * 0.24, y1 + 0.6, H * 0.25, H * 0.75, a)),
          B(x1 - 2.5, y1, x1 - 1.5, y1 + 0.4, H * 0.75, H * 0.85, '#ff453a', { emit: true }),
        ];
      if (v === 'dome') return [cyl(B(x0, y0, x1, y1, H * 0.7, H, c)), ...sphere(0, 0, -m * 0.35, m * 0.75, '#2a2e36', { glass: true }, 4).slice(0, 2)];
      return [
        cyl(B(-m * 0.42, -m * 0.42, m * 0.42, m * 0.42, 0, 1.2, c)),
        B(-0.8, -0.8, 0.8, 0.8, 1.2, H * 0.4, c),
        ...sphere(0, 0, H - m, m, c, {}, 4),
        cyl(B(-m * 0.2, m * 0.42, m * 0.2, m * 0.52, H - m * 0.7, H - m * 0.3, a)),
        B(m * 0.25, m * 0.38, m * 0.33, m * 0.46, H - m * 0.35, H - m * 0.28, '#ff453a', { emit: true }),
      ];
    case 'doorbell':
      return [rnd(B(x0, y0, x1, y1, 0, H, c), 1.5), cyl(B(-1, y1 - 0.2, 1, y1 + 0.3, H * 0.72, H * 0.85, '#1c2a33')), cyl(B(-1.4, y1 - 0.2, 1.4, y1 + 0.3, H * 0.2, H * 0.38, a, { emit: true }))];
    case 'alarm_panel':
      if (v === 'hub') return [rnd(B(x0, y0, x1, y1, 0, H, c), 4), cyl(B(-m * 0.18, -m * 0.18, m * 0.18, m * 0.18, H, H + 0.3, '#ff453a', { emit: true }))];
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 1.5),
        B(x0 + 2, y1, x1 - 2, y1 + 0.3, H * 0.66, H * 0.88, '#1c2a33', { emit: true }),
        ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((q) => B(x0 + 3 + q * ((w - 6) / 3) + 0.6, y1, x0 + 3 + (q + 1) * ((w - 6) / 3) - 0.6, y1 + 0.4, H * (0.12 + r * 0.17), H * (0.12 + r * 0.17) + 2, '#d7dadd'))),
      ];
    case 'smart_lock':
      return [rnd(B(x0, y0, x1, y1, 0, H, c), m * 0.3), cyl(B(-m * 0.3, y1 - 0.2, m * 0.3, y1 + 1.2, H * 0.4, H * 0.62, a)), cyl(B(-m * 0.36, y1 - 0.2, m * 0.36, y1 + 0.6, H * 0.36, H * 0.66, '#5fb0ff', { emit: true }))];
    case 'siren':
      if (v === 'outdoor') return [rnd(B(x0, y0, x1, y1, 0, H, c), 3), rnd(B(x0 + w * 0.2, y1 - 0.5, x1 - w * 0.2, y1 + 1.2, H * 0.1, H * 0.9, a, { emit: true }), 2)];
      return [cyl(B(x0, y0, x1, y1, 0, H * 0.6, c)), cyl(B(-m * 0.3, -m * 0.3, m * 0.3, m * 0.3, -1.5, 0, a, { emit: true }))];
    case 'fitness':
      if (v === 'bike')
        return [
          B(x0, y0 + 4, x0 + 8, y1 - 4, 0, 4, c, { radius: 2 }),
          B(x1 - 8, y0 + 4, x1, y1 - 4, 0, 4, c, { radius: 2 }),
          B(x0 + 4, -2.5, x1 - 4, 2.5, 4, 9, c),
          rnd(B(w * 0.1, -6, w * 0.38, 6, 9, H * 0.42, a), 6),
          B(-w * 0.2, -2, -w * 0.15, 2, 9, H * 0.72, c),
          B(-w * 0.3, -7, -w * 0.06, 7, H * 0.72, H * 0.77, '#1f1f21', { radius: 3 }),
          B(w * 0.26, -2, w * 0.31, 2, 9, H * 0.92, c),
          B(w * 0.22, y0 + 6, w * 0.32, y1 - 6, H * 0.9, H, '#1f1f21', { radius: 2 }),
          B(w * 0.3, -6, w * 0.34, 6, H * 0.94, H, INK, { emit: true }),
        ];
      if (v === 'rower')
        return [
          B(x0 + 8, -3, x1 - 28, 3, 12, 17, '#8d9297'),
          B(x0 + 6, -10, x0 + 12, 10, 0, 17, c),
          rnd(B(x1 - 30, y0 + 8, x1, y1 - 8, 0, H * 0.75, c), 10),
          B(-w * 0.1, -12, -w * 0.1 + 28, 12, 17, 23, a, { radius: 4 }),
          B(x1 - 52, y0 + 5, x1 - 38, -6, 14, 26, a, { radius: 2 }),
          B(x1 - 52, 6, x1 - 38, y1 - 5, 14, 26, a, { radius: 2 }),
          B(x1 - 31, -5, x1 - 29, 5, H * 0.75, H, INK, { emit: true }),
        ];
      if (v === 'bench')
        return [
          ...legs(x0, -d * 0.2, x1, d * 0.2, 36, 4, '#8d9297', 4),
          B(x0, -d * 0.2, x1, d * 0.2, 36, H - 1, a, { radius: 4 }),
          B(-w * 0.15 - 2, y0, -w * 0.15 + 2, y0 + 4, 0, H + 40, '#8d9297'),
          B(-w * 0.15 - 2, y1 - 4, -w * 0.15 + 2, y1, 0, H + 40, '#8d9297'),
        ];
      return [
        B(x0, y0, x1, y1, 0, 10, c, { radius: 6 }),
        B(x0 + 6, y0 + 12, x1 - 34, y1 - 12, 10, 12, a, { radius: 3 }),
        B(x1 - 24, y0 + 3, x1 - 20, y0 + 7, 10, H - 18, '#8d9297'),
        B(x1 - 24, y1 - 7, x1 - 20, y1 - 3, 10, H - 18, '#8d9297'),
        B(x1 - 28, y0 + 2, x1 - 6, y1 - 2, H - 20, H - 6, tone(c, 0.12), { radius: 4 }),
        B(x1 - 26, -d * 0.2, x1 - 25.4, d * 0.2, H - 18, H - 8, '#1c2a33', { emit: true }),
      ];
    case 'sauna': {
      if (v === 'barrel') return [B(x0, y0, x1, y1, 0, 14, '#5e4030'), B(x0 + 4, y0, x1 - 4, y1, 14, H, c, { radius: d * 0.3, topSvg: true }), B(-w * 0.15, y1 - 0.2, w * 0.15, y1 + 0.6, 20, H * 0.8, GLASS, { glass: true })];
      return [B(x0, y0, x1, y1, 0, H, c, { radius: 2, topSvg: true }), B(-w * 0.2, y1 - 0.2, w * 0.15, y1 + 0.6, 4, H - 10, GLASS, { glass: true })];
    }
    case 'printer_3d':
      if (v === 'enclosed')
        return [
          rnd(B(x0, y0, x1, y1, 0, H, c), 2),
          B(x0 + 2, y1 - 0.2, x1 - 2, y1 + 0.3, 4, H - 4, '#5a6b7c', { glass: true }),
          B(x0 + 4, y0 + 4, x1 - 4, y1 - 4, 8, 9, '#3a3a3c'),
          B(-4, -4, 4, 4, H * 0.55, H * 0.7, a),
          B(x0 + w * 0.3, y1 + 0.3, x1 - w * 0.3, y1 + 0.6, 1, 3, INK, { emit: true }),
        ];
      return [
        B(x0, y0, x1, y1, 0, 8, c, { radius: 2 }),
        B(x0 + 5, y0 + 5, x1 - 5, y1 - 8, 10, 11, '#5a5f66'),
        B(x0 + 1, -3, x0 + 4, 3, 8, H, c),
        B(x1 - 4, -3, x1 - 1, 3, 8, H, c),
        B(x0 + 1, -2, x1 - 1, 2, H * 0.62, H * 0.68, '#8d9297'),
        B(-4, -4, 4, 4, H * 0.5, H * 0.72, a, { radius: 1 }),
        B(x0 + w * 0.6, y1 - 5, x1 - 4, y1 - 4.6, 2, 6, INK, { emit: true }),
      ];
    case 'sewing_machine':
      return [
        rnd(B(x0, y0, x1, y1, 0, H * 0.25, c), 3),
        rnd(B(x1 - 10, y0 + 3, x1 - 2, y1 - 3, H * 0.25, H, c), 2),
        rnd(B(x0 + 4, y0 + 3, x1 - 2, y1 - 3, H * 0.72, H, c), 3),
        B(x0 + 4, -2, x0 + 10, 2, H * 0.4, H * 0.72, c),
        B(x0 + 6.5, -0.3, x0 + 7.1, 0.3, H * 0.25, H * 0.4, '#8d9297'),
        B(x1 - 10, y1 - 3, x1 - 3, y1 - 2.6, H * 0.5, H * 0.65, a),
      ];
    case 'aquarium': {
      const tank = Math.min(55, H * 0.42);
      const base = H - tank;
      return [
        B(x0, y0, x1, y1, 0, base, c, { radius: 1.5 }),
        B(x0 + 2, y0 + 2, x1 - 2, y1 - 2, base, base + tank - 6, a, { emit: true }),
        B(x0, y0, x1, y1, base, H - 3, GLASS, { glass: true }),
        B(x0, y0, x1, y1, H - 3, H, c, { radius: 1 }),
        ...[0.25, 0.6].map((f) => cyl(B(x0 + w * f - 4, -4, x0 + w * f + 4, 4, base, base + tank * 0.6, '#4f8f4e'))),
      ];
    }
    case 'pet_feeder':
      if (v === 'fountain') return [...lathe(0, 0, [[0, m * 0.46], [H * 0.6, m * 0.5], [H * 0.7, m * 0.42]], c), cyl(B(-m * 0.36, -m * 0.36, m * 0.36, m * 0.36, H * 0.7, H * 0.72, '#9fd3ef', { emit: true })), cyl(B(-m * 0.12, -m * 0.12, m * 0.12, m * 0.12, H * 0.72, H, a))];
      return [
        rnd(B(x0, y0, x1, y0 + d * 0.62, 0, H, c), 5),
        cyl(B(-m * 0.3, y0 + d * 0.1, m * 0.3, y0 + d * 0.1 + m * 0.6, H, H + 2, tone(a, 0.2), { glass: true })),
        cyl(B(-w * 0.38, y1 - d * 0.42, w * 0.38, y1, 0, 6, a)),
        B(-w * 0.2, y0 + d * 0.62, w * 0.2, y0 + d * 0.62 + 0.4, H * 0.75, H * 0.85, INK, { emit: true }),
      ];
    case 'christmas_tree': {
      // one turned body: tiers getting smaller toward the top, baubles and a star
      const r0 = m / 2;
      const prof: [number, number][] = [[H * 0.1, r0 * 0.15]];
      const tiers = 5;
      for (let i = 0; i < tiers; i++) {
        const z = H * (0.12 + (i * 0.8) / tiers);
        const rr = r0 * (1 - i / (tiers + 0.6));
        prof.push([z, rr], [z + (H * 0.8) / tiers - 1, rr * 0.45]);
      }
      prof.push([H * 0.95, 1]);
      const out: Part[] = [cyl(B(-r0 * 0.22, -r0 * 0.22, r0 * 0.22, r0 * 0.22, 0, H * 0.1, '#8b5e3c')), ...lathe(0, 0, prof, c)];
      for (let i = 0; i < 8; i++) {
        const ang = i * 2.4;
        const zf = 0.2 + (i % 4) * 0.17;
        const rr = r0 * (1 - zf) * 0.95;
        out.push(...sphere(Math.cos(ang) * rr, Math.sin(ang) * rr, H * zf, 6, i % 2 ? a : '#e8c547', { emit: i % 2 === 0 }, 3));
      }
      out.push(...sphere(0, 0, H * 0.95, 8, '#e8c547', { emit: true }, 3));
      return out;
    }
    case 'projector':
      return [
        rnd(B(x0, y0, x1, y1, 0, H, c), 3),
        cyl(B(-w * 0.2 - m * 0.17, y1 - 0.2, -w * 0.2 + m * 0.17, y1 + 1, H * 0.2, H * 0.8, a)),
        B(w * 0.1, y1, w * 0.35, y1 + 0.3, H * 0.6, H * 0.75, INK, { emit: true }),
        ...(v === 'ceiling' ? [B(-2, -2, 2, 2, H, H + 8, '#8d9297', { cord: true })] : []),
      ];
    case 'mailbox':
      if (v === 'parcel') return [B(x0, y0, x1, y1, 0, H, c, { radius: 3 }), B(x0 + 4, y1, x1 - 4, y1 + 0.4, H * 0.1, H * 0.92, tone(c, 0.08)), B(-w * 0.15, y1 + 0.4, w * 0.15, y1 + 1, H * 0.6, H * 0.65, a)];
      if (v === 'post') return [B(-3, -3, 3, 3, 0, H * 0.65, '#5c5d61'), rnd(B(x0, y0, x1, y0 + d * 0.6, H * 0.65, H, c), 3), B(-w * 0.3, y0 + d * 0.6, w * 0.3, y0 + d * 0.6 + 0.5, H * 0.92, H * 0.95, a)];
      return [rnd(B(x0, y0, x1, y1, 0, H, c), 3), B(-w * 0.3, y1, w * 0.3, y1 + 0.5, H * 0.82, H * 0.88, a), B(-w * 0.2, y1, w * 0.2, y1 + 0.3, H * 0.4, H * 0.55, tone(c, 0.2))];
    case 'irrigation':
      if (v === 'box') return [B(x0, y0, x1, y1, 0, H, '#3f6b3a', { radius: 4 }), B(x0 + 5, y0 + 5, x1 - 5, y1 - 5, H, H + 0.5, '#4f7f42', { radius: 3 })];
      if (v === 'controller') return [rnd(B(x0, y0, x1, y1, 0, H, c), 2), B(x0 + w * 0.2, y1, x1 - w * 0.2, y1 + 0.4, H * 0.65, H * 0.82, '#1c2a33', { emit: true })];
      return [cyl(B(-1.2, -1.2, 1.2, 1.2, H, H + 8, '#b87333')), rnd(B(x0, y0, x1, y1, 0, H, c), 3), cyl(B(-m * 0.3, y1 - 0.2, m * 0.3, y1 + 1, H * 0.35, H * 0.7, a, { emit: true }))];
    case 'pool_pump':
      if (v === 'heatpump') return [B(x0, y0, x1, y1, 6, H, '#e9e6df', { radius: 4 }), B(x0 + 4, y0 + 4, x0 + 12, y1 - 4, 0, 6, LEG), B(x1 - 12, y0 + 4, x1 - 4, y1 - 4, 0, 6, LEG), B(x0 + w * 0.1, y1 - 0.2, x0 + w * 0.65, y1 + 0.4, H * 0.18, H * 0.9, '#2f3134'), B(x1 - w * 0.25, y1, x1 - w * 0.08, y1 + 0.4, H * 0.75, H * 0.85, INK, { emit: true })];
      return [
        ...lathe(-w * 0.15, 0, [[0, m * 0.32], [H * 0.15, m * 0.48], [H * 0.75, m * 0.48], [H * 0.9, m * 0.3]], c),
        cyl(B(-w * 0.15 - m * 0.16, -m * 0.16, -w * 0.15 + m * 0.16, m * 0.16, H * 0.9, H, a)),
        rnd(B(w * 0.12, -d * 0.25, x1, d * 0.25, 0, H * 0.4, a), 4),
        B(w * 0.2, d * 0.25, w * 0.35, d * 0.25 + 0.4, H * 0.25, H * 0.32, LED, { emit: true }),
      ];
  }
  return undefined;
}

function legs(x0: number, y0: number, x1: number, y1: number, z1: number, size: number, color = LEG, inset = 4): Part[] {
  const s = size;
  return [
    B(x0 + inset, y0 + inset, x0 + inset + s, y0 + inset + s, 0, z1, color),
    B(x1 - inset - s, y0 + inset, x1 - inset, y0 + inset + s, 0, z1, color),
    B(x0 + inset, y1 - inset - s, x0 + inset + s, y1 - inset, 0, z1, color),
    B(x1 - inset - s, y1 - inset - s, x1 - inset, y1 - inset, 0, z1, color),
  ];
}

/** Move/rotate a group of parts (sub-assemblies such as chairs). */
function place(parts: Part[], dx: number, dy: number, rot: number): Part[] {
  const a = (rot * Math.PI) / 180;
  return parts.map((p) => ({
    ...p,
    x: dx + p.x * Math.cos(a) - p.y * Math.sin(a),
    y: dy + p.x * Math.sin(a) + p.y * Math.cos(a),
    rot: (p.rot ?? 0) + rot,
  }));
}

function chair(color: string, seat = 46): Part[] {
  const w = 44;
  const d = 44;
  return [
    ...legs(-w / 2, -d / 2, w / 2, d / 2, seat - 4, 3, tone(color, -0.35), 2),
    B(-w / 2, -d / 2, w / 2, d / 2, seat - 4, seat, color, { radius: 6 }),
    B(-w / 2 + 2, -d / 2, w / 2 - 2, -d / 2 + 4, seat, seat + 42, color, { radius: 2 }),
  ];
}

function chairsAround(w: number, h: number, n: number, color: string, round: boolean): Part[] {
  const out: Part[] = [];
  if (round) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      out.push(...place(chair(color), Math.cos(a) * (w / 2 + 6), Math.sin(a) * (h / 2 + 6), (a * 180) / Math.PI - 90));
    }
    return out;
  }
  const ends = n >= 6 ? 2 : 0;
  const side = n - ends;
  const top = Math.ceil(side / 2);
  const bottom = Math.floor(side / 2);
  for (let i = 0; i < top; i++) out.push(...place(chair(color), -w / 2 + (w / top) * (i + 0.5), -h / 2 - 2, 0));
  for (let i = 0; i < bottom; i++) out.push(...place(chair(color), -w / 2 + (w / bottom) * (i + 0.5), h / 2 + 2, 180));
  if (ends) out.push(...place(chair(color), -w / 2 - 2, 0, -90), ...place(chair(color), w / 2 + 2, 0, 90));
  return out;
}

function cabinet(w: number, d: number, H: number, c: string, plinth = 8): Part[] {
  return [B(-w / 2 + 2, -d / 2 + 2, w / 2 - 2, d / 2 - 4, 0, plinth, tone(c, -0.3)), B(-w / 2, -d / 2, w / 2, d / 2, plinth, H, c, { radius: 1.5, topSvg: true })];
}

/** Sofa body along the back edge, with optional chaise wings left/right. */
function sofaParts(w: number, d: number, H: number, c: string, a: string, opts: { chaiseL?: number; chaiseR?: number; depth: number }): Part[] {
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const sd = opts.depth;
  const back = Math.min(22, sd * 0.24);
  const arm = Math.min(20, w * 0.09);
  const seatZ = 44;
  const frame = tone(c, -0.08);
  const parts: Part[] = [];
  const legsFor = (bx0: number, by0: number, bx1: number, by1: number) => parts.push(...legs(bx0, by0, bx1, by1, 8, 4, LEG, 6));
  // main section
  legsFor(x0, y0, x1, y0 + sd);
  parts.push(B(x0, y0, x1, y0 + sd, 8, 26, frame, { radius: 6 }));
  parts.push(B(x0, y0, x1, y0 + back, 26, H, c, { radius: 6 }));
  const cl = opts.chaiseL ?? 0;
  const cr = opts.chaiseR ?? 0;
  // chaises
  if (cl) {
    legsFor(x0, y0, x0 + cl, -y0);
    parts.push(B(x0, y0 + sd, x0 + cl, -y0, 8, 26, frame, { radius: 6 }));
    parts.push(B(x0, y0 + back, x0 + arm, -y0, 26, 62, c, { radius: 8 }));
    parts.push(B(x0 + arm + 2, y0 + back + 2, x0 + cl - 2, -y0 - 3, 26, seatZ, a, { radius: 9 }));
  } else parts.push(B(x0, y0, x0 + arm, y0 + sd, 26, 62, c, { radius: 8 }));
  if (cr) {
    legsFor(x1 - cr, y0, x1, -y0);
    parts.push(B(x1 - cr, y0 + sd, x1, -y0, 8, 26, frame, { radius: 6 }));
    parts.push(B(x1 - arm, y0 + back, x1, -y0, 26, 62, c, { radius: 8 }));
    parts.push(B(x1 - cr + 2, y0 + back + 2, x1 - arm - 2, -y0 - 3, 26, seatZ, a, { radius: 9 }));
  } else parts.push(B(x1 - arm, y0, x1, y0 + sd, 26, 62, c, { radius: 8 }));
  // seats + back cushions of the main section
  const sx0 = cl ? x0 + cl : x0 + arm;
  const sx1 = cr ? x1 - cr : x1 - arm;
  const n = Math.max(1, Math.round((sx1 - sx0) / 70));
  const sw = (sx1 - sx0) / n;
  for (let i = 0; i < n; i++) {
    const a0 = sx0 + i * sw + 1;
    const a1 = sx0 + (i + 1) * sw - 1;
    parts.push(B(a0, y0 + back + 1, a1, y0 + sd - 3, 26, seatZ, a, { radius: 9 }));
    parts.push(B(a0 + 1, y0 + back, a1 - 1, y0 + back + 15, seatZ, H - 6, tone(a, -0.04), { radius: 7 }));
  }
  if (cl) parts.push(B(x0 + arm + 1, y0 + back, x0 + cl - 1, y0 + back + 15, seatZ, H - 6, tone(a, -0.04), { radius: 7 }));
  if (cr) parts.push(B(x1 - cr + 1, y0 + back, x1 - arm - 1, y0 + back + 15, seatZ, H - 6, tone(a, -0.04), { radius: 7 }));
  return parts;
}

/**
 * Stairs: solid steps rising over the run to the piece's height (straight, L with landing), or floating
 * wedge treads around a post (spiral). The 2D drawing's geometry (stairPlan) keeps both views in step.
 */
function stairParts(w: number, d: number, H: number, c: string, v: string, n: number): Part[] {
  const sp = stairPlan(w, d, v, n);
  const out: Part[] = [];
  if (sp.spiral) {
    const { r0, r1, a0, sweep } = sp.spiral;
    const steps = Math.max(3, Math.round(n));
    const rise = H / steps;
    const len = r1 - r0;
    const rm = r0 + len / 2;
    for (let i = 0; i < steps; i++) {
      const ang = a0 + (sweep * (i + 0.5)) / steps;
      const wid = Math.max(8, (sweep / steps) * (r0 + len * 0.72));
      // a tread from the post outwards; rotation turns the box's width axis along the radius
      out.push({ ...B(-len / 2, -wid / 2, len / 2, wid / 2, rise * (i + 1) - 4, rise * (i + 1), i % 2 ? c : tone(c, 0.04)), x: rm * Math.sin(-ang), y: rm * Math.cos(ang), rot: 90 + (ang * 180) / Math.PI, radius: 1 });
    }
    out.push({ ...B(-r0, -r0, r0, r0, 0, H + 6, tone(c, -0.25)), cyl: true });
    // a slim handrail post at the top
    const top = a0 + sweep;
    out.push({ ...B(-1.5, -1.5, 1.5, 1.5, H, H + 90 > H * 1.9 ? H * 1.9 : H + 90, '#8d9297'), x: (r1 - 4) * Math.sin(-top), y: (r1 - 4) * Math.cos(top), cyl: true });
    return out;
  }
  const total = sp.treads.length + (sp.landing ? 1 : 0);
  const rise = H / Math.max(1, total);
  let k = 0;
  sp.treads.forEach(([tx0, ty0, tx1, ty1], i) => {
    if (sp.landing && i === sp.split) out.push(B(sp.landing[0], sp.landing[1], sp.landing[2], sp.landing[3], 0, rise * ++k, tone(c, 0.05)));
    out.push(B(tx0, ty0, tx1, ty1, 0, rise * ++k, i % 2 ? c : tone(c, 0.04)));
  });
  return out;
}

/** Parts for a placed piece, or undefined to use the generic body. */
export function furnitureParts(f: FurnitureConfig, live?: { open?: number }): Part[] | undefined {
  const r = resolveFurniture(f);
  const k = r.k;
  if (!k) return undefined;
  const w = f.w;
  const d = f.h;
  const H = r.height;
  const c = r.color;
  const a = r.accent;
  const v = r.variant;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const flip = r.flip;
  const gadget = gadgetParts(k.kind, v, w, d, H, c, a, r.count) ?? deviceParts(k.kind, v, w, d, H, c, a, r.count);
  if (gadget) return gadget;
  // garden, energy, vehicles: static stand-in from the WebGL model
  const model = pieceModel(f, { open: live?.open });
  if (model)
    return flattenModel(model)
      .filter((b) => !b.glass || b.w * b.d > 400)
      .map((b) => {
        const z0 = b.s === 'cyl' || b.s === 'cone' ? b.z : b.z - b.h / 2;
        return { ...B(b.x - b.w / 2, b.y - b.d / 2, b.x + b.w / 2, b.y + b.d / 2, Math.max(0, z0), Math.max(0.5, z0 + b.h), b.c), radius: b.s === 'box' ? Math.min(b.r ?? 1, b.w / 2, b.d / 2) : Math.min(b.w, b.d) / 2, cyl: b.s === 'cyl' || b.s === 'ell', glass: b.glass, emit: b.emit, rot: b.rz };
      });
  switch (k.kind) {
    case 'sofa': {
      if (v === 'l') {
        const cw = Math.min(w * 0.36, 100);
        return sofaParts(w, d, H, c, a, { depth: Math.min(d * 0.55, 98), ...(flip ? { chaiseL: cw } : { chaiseR: cw }) });
      }
      if (v === 'u') {
        const cw = Math.min(w * 0.3, 100);
        return sofaParts(w, d, H, c, a, { depth: Math.min(d * 0.5, 98), chaiseL: cw, chaiseR: cw });
      }
      return sofaParts(w, d, H, c, a, { depth: d });
    }
    case 'armchair':
      if (v === 'lounge')
        return [B(-6, -6, 6, 6, 0, 20, LEG), { ...B(x0, y0, x1, y1, 20, 40, c), cyl: true }, { ...B(x0 + 10, y0 + 10, x1 - 10, y1 - 6, 40, 44, a), cyl: true }, B(x0 + 8, y0, x1 - 8, y0 + 12, 40, H, c, { radius: 6 })];
      return sofaParts(w, d, H, c, a, { depth: d });
    case 'bed': {
      const box = v === 'box';
      const fz = box ? 40 : v === 'kids' ? 20 : 30;
      const mz = fz + (box ? 25 : 20);
      const two = w >= 140;
      const pw = two ? (w - 30) / 2 : w - 20;
      const sheet = tone(a, 0.03);
      const parts: Part[] = [
        ...(box ? [] : legs(x0, y0, x1, y1, 8, 6, tone(c, -0.3), 6)),
        B(x0, y0 + 6, x1, y1, box ? 0 : 8, fz, c, { radius: 4 }),
        B(x0 - 2, y0, x1 + 2, y0 + 8, 0, box ? 120 : 95, tone(c, -0.06), { radius: 3 }),
        B(x0 + 3, y0 + 10, x1 - 3, y1 - 3, fz, mz, sheet, { radius: 6 }),
        B(x0 + 10, y0 + 14, x0 + 10 + pw, y0 + 46, mz, mz + 9, tone(a, -0.03), { radius: 8 }),
        B(x0 + 2, y0 + d * 0.4, x1 - 2, y1 - 1, mz, mz + 5, tone(a, -0.09), { radius: 6 }),
      ];
      if (two) parts.push(B(x0 + 20 + pw, y0 + 14, x0 + 20 + pw * 2, y0 + 46, mz, mz + 9, tone(a, -0.03), { radius: 8 }));
      return parts;
    }
    case 'crib':
      return [
        B(x0 + 4, y0 + 4, x1 - 4, y1 - 4, 10, 30, a, { radius: 4 }),
        B(x0, y0, x1, y0 + 3, 0, H, c),
        B(x0, y1 - 3, x1, y1, 0, H, c),
        B(x0, y0, x0 + 3, y1, 0, H, c),
        B(x1 - 3, y0, x1, y1, 0, H, c),
      ];
    case 'dining_table':
    case 'patio_set': {
      const round = v === 'round' || v === 'oval' || k.kind === 'patio_set';
      const chairs = chairsAround(w, d, r.count, a, round);
      if (round)
        return [...chairs, { ...B(x0, y0, x1, y1, H - 4, H, c), cyl: true }, B(-5, -5, 5, 5, 0, H - 4, tone(c, -0.3)), { ...B(-w * 0.2, -d * 0.2, w * 0.2, d * 0.2, 0, 2, tone(c, -0.3)), cyl: true }];
      return [...chairs, B(x0, y0, x1, y1, H - 4, H, c, { radius: 2 }), ...legs(x0, y0, x1, y1, H - 4, 6, tone(c, -0.25), 6)];
    }
    case 'coffee_table':
      if (v !== 'rect') return [{ ...B(x0, y0, x1, y1, H - 4, H, c), cyl: true }, B(-6, -6, 6, 6, 0, H - 4, tone(c, -0.3)), { ...B(x0 * 0.5, y0 * 0.5, x1 * 0.5, y1 * 0.5, 0, 2, tone(c, -0.3)), cyl: true }];
      return [B(x0, y0, x1, y1, H - 4, H, c, { radius: 3 }), B(x0 + 6, y0 + 6, x1 - 6, y1 - 6, 10, 12, tone(c, -0.05)), ...legs(x0, y0, x1, y1, H - 4, 4, tone(c, -0.3), 4)];
    case 'side_table':
      return [{ ...B(x0, y0, x1, y1, H - 3, H, c), cyl: true }, B(-2, -2, 2, 2, 0, H - 3, LEG), { ...B(x0 * 0.6, y0 * 0.6, x1 * 0.6, y1 * 0.6, 0, 1.5, LEG), cyl: true }];
    case 'bench':
      return [B(x0, y0, x1, y1, H - 4, H, c, { radius: 2 }), ...legs(x0, y0, x1, y1, H - 4, 4, tone(c, -0.3), 4)];
    case 'chair':
      return chair(c, 46).map((p) => ({ ...p, x: p.x * (w / 44), y: p.y * (d / 44), w: p.w * (w / 44), d: p.d * (d / 44) }));
    case 'bar_stool':
      return [{ ...B(x0, y0, x1, y1, H - 5, H, c), cyl: true }, B(-2, -2, 2, 2, 0, H - 5, '#8d9297'), { ...B(x0 * 0.8, y0 * 0.8, x1 * 0.8, y1 * 0.8, 0, 2, '#8d9297'), cyl: true }];
    case 'office_chair': {
      const rr = Math.min(w, d) / 2;
      return [
        { ...B(-rr, -rr, rr, rr, 0, 3, tone(c, -0.2)), cyl: true },
        B(-2.5, -2.5, 2.5, 2.5, 3, 42, '#8d9297'),
        { ...B(-rr * 0.75, -rr * 0.7, rr * 0.75, rr * 0.8, 42, 50, c), cyl: true },
        B(-rr * 0.65, -rr * 0.8, rr * 0.65, -rr * 0.62, 52, H, c, { radius: 8 }),
      ];
    }
    case 'desk': {
      const top = tone(c, 0.02);
      if (v === 'l') {
        const dd = Math.min(70, d * 0.5);
        const lx0 = flip ? x0 : x1 - dd;
        return [
          B(x0, y0, x1, y0 + dd, H - 3, H, top, { radius: 2 }),
          B(lx0, y0 + dd, lx0 + dd, y1, H - 3, H, top, { radius: 2 }),
          B(flip ? x1 - 4 : x0, y0 + 2, flip ? x1 : x0 + 4, y0 + dd - 2, 0, H - 3, a),
          B(lx0 + 2, y1 - 4, lx0 + dd - 2, y1, 0, H - 3, a),
        ];
      }
      return [B(x0, y0, x1, y1, H - 3, H, top, { radius: 2 }), B(x0 + 3, y0 + 4, x0 + 7, y1 - 4, 0, H - 3, a), B(x1 - 7, y0 + 4, x1 - 3, y1 - 4, 0, H - 3, a), B(x0 + 7, y0 + 6, x1 - 7, y0 + 9, H - 20, H - 3, a)];
    }
    case 'wardrobe':
    case 'tall_cabinet':
    case 'oven':
    case 'fridge':
    case 'freezer':
    case 'pantry':
      return cabinet(w, d, H, c, k.kind === 'fridge' || k.kind === 'freezer' ? 2 : 8);
    case 'dresser':
    case 'sideboard':
    case 'tv_stand':
    case 'nightstand':
    case 'shoe_cabinet':
      return [...legs(x0, y0, x1, y1, 10, 3, tone(c, -0.35), 4), B(x0, y0, x1, y1, 10, H, c, { radius: 1.5, topSvg: true })];
    case 'shelf':
      return [B(x0, y0, x1, y1, 0, H, c, { topSvg: true })];
    case 'counter': {
      const top = a;
      const dd = 62;
      if (v === 'l') {
        const lx0 = flip ? x0 : x1 - dd;
        return [
          B(x0, y0 + 2, x1, y0 + dd - 6, 0, 10, tone(c, -0.35)),
          B(x0, y0, x1, y0 + dd - 2, 10, 86, c),
          B(lx0 + 2, y0 + dd, lx0 + dd - 6, y1, 0, 10, tone(c, -0.35)),
          B(lx0, y0 + dd - 2, lx0 + dd - 2, y1, 10, 86, c),
          B(x0, y0, x1, y0 + dd, 86, 90, top, { topSvg: true }),
          B(lx0, y0 + dd, lx0 + dd, y1, 86, 90, top, { topSvg: true }),
        ];
      }
      return [B(x0, y0, x1, y1 - 6, 0, 10, tone(c, -0.35)), B(x0, y0, x1, y1 - 2, 10, 86, c), B(x0, y0, x1, y1, 86, 90, top, { topSvg: true })];
    }
    case 'island': {
      const stools: Part[] = [];
      for (let i = 0; i < r.count; i++) {
        const sx = x0 + (w / r.count) * (i + 0.5);
        stools.push({ ...B(sx - 17, y1 + 5, sx + 17, y1 + 39, 72, 76, '#3a3a3c'), cyl: true }, B(sx - 2, y1 + 20, sx + 2, y1 + 24, 0, 72, '#8d9297'));
      }
      return [...stools, B(x0, y0 + 2, x1, y1 - 30, 0, 10, tone(c, -0.35)), B(x0, y0, x1, y1 - 26, 10, 88, c), B(x0, y0, x1, y1, 88, 92, a, { topSvg: true })];
    }
    case 'range':
    case 'dishwasher':
    case 'washer':
    case 'dryer':
      return [B(x0, y0, x1, y1, 0, H, c, { radius: 2, topSvg: true })];
    case 'tv':
      // wall variant: the mounting height comes from the piece's elevation
      return v === 'wall'
        ? [B(x0, y0, x1, y1, 0, H * 0.62, c, { radius: 1, emit: true })]
        : [B(-w * 0.15, -6, w * 0.15, 6, 0, 2, '#3a3a3c'), B(-3, -1, 3, 1, 2, 12, '#3a3a3c'), B(x0, -1.5, x1, 1.5, 12, 12 + H * 0.62, c, { radius: 1, emit: true })];
    case 'monitor':
      return [B(-8, -4, 8, 4, 0, 1.5, '#3a3a3c'), B(-2, -1, 2, 1, 1.5, 12, '#3a3a3c'), B(x0, -1, x1, 1, 12, H, c)];
    case 'plant': {
      const rr = Math.min(w, d) / 2;
      const potH = v === 'small' ? H * 0.4 : v === 'palm' ? H * 0.2 : H * 0.28;
      const pot = v === 'palm' ? lathe(0, 0, [[0, rr * 0.26], [potH, rr * 0.36]], a) : lathe(0, 0, [[0, rr * 0.4], [potH, rr * 0.55]], a);
      // closed ellipsoids (not turned slices): squashed instead of opened when the walls cut them
      const ball = (cx: number, cy: number, z0: number, dia: number, col: string): Part => ({ ...B(cx - dia / 2, cy - dia / 2, cx + dia / 2, cy + dia / 2, z0, z0 + dia, col), sphere: true });
      if (v === 'palm') {
        // trunk with three tiers of fronds (low enough to stay below the cut-away walls)
        const out: Part[] = [...pot, cyl(B(-2.5, -2.5, 2.5, 2.5, potH, H * 0.82, tone(a, -0.3)))];
        const tiers: [number, number, number][] = [[0.46, 1, 0], [0.56, 0.8, 0.45], [0.65, 0.55, 0.2]];
        tiers.forEach(([zf, lf, off], t) => {
          const k = t === 2 ? 5 : 7;
          for (let i = 0; i < k; i++) {
            const ang = (i / k) * Math.PI * 2 + off;
            const len = rr * lf;
            out.push({ ...B(-len / 2, -4, len / 2, 4, H * zf - t, H * zf - t + 2, tone(c, (i % 3) * 0.05 - 0.03), { radius: 2.5 }), x: (Math.cos(ang) * len) / 2, y: (Math.sin(ang) * len) / 2, rot: (ang * 180) / Math.PI });
          }
        });
        return out;
      }
      // foliage: a few overlapping soft spheres in slightly different greens
      const top = H - potH;
      if (v === 'small')
        return [...pot, ball(-rr * 0.15, 0, potH - 2, Math.min(rr * 1.7, top * 0.8), c), ball(rr * 0.2, rr * 0.1, potH + top * 0.3, Math.min(rr * 1.3, top * 0.7), tone(c, 0.08))];
      const dia = Math.min(rr * 1.45, top * 0.55);
      return [
        ...pot,
        ball(-rr * 0.22, -rr * 0.12, potH - 4, dia, tone(c, -0.05)),
        ball(rr * 0.24, rr * 0.14, potH + top * 0.18, dia * 0.95, c),
        ball(-rr * 0.05, rr * 0.2, H - dia * 0.98, dia * 0.98, tone(c, 0.08)),
      ];
    }
    case 'floor_lamp':
      if (v === 'arc')
        return [B(x0 + 4, -12, x0 + 28, 12, 0, 6, a), B(x0 + 14, -1.5, x0 + 17, 1.5, 6, H, '#8d9297'), B(x0 + 14, -1.5, x1 - 20, 1.5, H - 3, H, '#8d9297'), { ...B(x1 - 40, -20, x1, 20, H - 30, H - 4, c), cyl: true, emit: true }];
      if (v === 'uplight')
        return [cyl(B(-13, -13, 13, 13, 0, 2, a)), B(-1.5, -1.5, 1.5, 1.5, 2, H - 10, '#8d9297'), cyl(B(x0, y0, x1, y1, H - 10, H - 6, c)), cyl(B(x0 + 3, y0 + 3, x1 - 3, y1 - 3, H - 6, H, c, { emit: true }))];
      if (v === 'tripod')
        return [
          ...[0, 120, 240].map((deg) => {
            const rd = (deg * Math.PI) / 180;
            const rr = Math.min(w, d) * 0.36;
            return B(Math.sin(rd) * rr - 1.5, -Math.cos(rd) * rr - 1.5, Math.sin(rd) * rr + 1.5, -Math.cos(rd) * rr + 1.5, 0, H - 34, a);
          }),
          cyl(B(-w * 0.28, -d * 0.28, w * 0.28, d * 0.28, H - 36, H, c, { emit: true })),
        ];
      return [{ ...B(-12, -12, 12, 12, 0, 2, a), cyl: true }, B(-1.5, -1.5, 1.5, 1.5, 2, H - 32, '#8d9297'), { ...B(x0, y0, x1, y1, H - 32, H, c), cyl: true, emit: true }];
    case 'table_lamp': {
      const rr = Math.min(w, d) / 2;
      if (v === 'globe' || v === 'night') return [cyl(B(-rr * 0.5, -rr * 0.5, rr * 0.5, rr * 0.5, 0, 2, a)), ...sphere(0, 0, 1, Math.min(w, d, H), c, { emit: true })];
      if (v === 'mushroom')
        return [cyl(B(-rr * 0.55, -rr * 0.55, rr * 0.55, rr * 0.55, 0, 2, c)), cyl(B(-rr * 0.18, -rr * 0.18, rr * 0.18, rr * 0.18, 2, H * 0.6, c)), ...sphere(0, 0, H * 0.6 - rr * 0.9, rr * 2, c, { emit: true }, 4).slice(2)];
      return [cyl(B(-rr * 0.5, -rr * 0.5, rr * 0.5, rr * 0.5, 0, 2, a)), B(-1, -1, 1, 1, 2, H * 0.5, a), cyl(B(x0 + rr * 0.15, y0 + rr * 0.15, x1 - rr * 0.15, y1 - rr * 0.15, H * 0.5, H * 0.75, c, { emit: true })), cyl(B(x0 + rr * 0.3, y0 + rr * 0.3, x1 - rr * 0.3, y1 - rr * 0.3, H * 0.75, H, c, { emit: true }))];
    }
    case 'ceiling_lamp': {
      const rr = Math.min(w, d) / 2;
      // cord up to a 250 cm ceiling (elevation is the lamp's bottom)
      const cordLen = Math.max(0, 250 - r.elevation - H);
      const cord = cordLen > 2 ? [B(-0.6, -0.6, 0.6, 0.6, H, H + cordLen, '#5c5d61', { cord: true })] : [];
      if (v === 'pendant') return [cyl(B(-rr, -rr, rr, rr, 0, H * 0.45, c, { emit: true })), cyl(B(-rr * 0.6, -rr * 0.6, rr * 0.6, rr * 0.6, H * 0.45, H * 0.8, c)), cyl(B(-rr * 0.2, -rr * 0.2, rr * 0.2, rr * 0.2, H * 0.8, H, c)), ...cord];
      if (v === 'panel') return [B(x0, y0, x1, y1, 0, H, c, { emit: true, radius: 1 })];
      if (v === 'spots') {
        const k2 = Math.max(1, r.count);
        const out: Part[] = [B(x0, -d * 0.2, x1, d * 0.2, H - 2, H, a)];
        for (let i = 0; i < k2; i++) {
          const x = x0 + (w / k2) * (i + 0.5);
          const sr = Math.min(d / 2, w / k2 / 2.6);
          out.push(cyl(B(x - sr, -sr, x + sr, sr, 0, H - 2, c, { emit: true })));
        }
        return out;
      }
      if (v === 'chandelier') {
        const out: Part[] = [cyl(B(-rr * 0.18, -rr * 0.18, rr * 0.18, rr * 0.18, 0, H, a)), cyl(B(-rr * 0.75, -rr * 0.75, rr * 0.75, rr * 0.75, H * 0.3, H * 0.34, a)), ...cord];
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          out.push(...sphere(Math.cos(ang) * rr * 0.7, Math.sin(ang) * rr * 0.7, H * 0.34, rr * 0.32, c, { emit: true }, 3));
        }
        return out;
      }
      return [cyl(B(-rr, -rr, rr, rr, 0, H * 0.7, c, { emit: true })), cyl(B(-rr * 0.9, -rr * 0.9, rr * 0.9, rr * 0.9, H * 0.7, H, c))];
    }
    case 'wall_lamp':
      if (v === 'reading') return [B(-5, y0, 5, y0 + 2, H * 0.3, H * 0.9, a), B(-1, y0 + 2, 1, y1 - 14, H * 0.55, H * 0.65, a), cyl(B(-8, y1 - 16, 8, y1, 0, H * 0.6, c, { emit: true }))];
      if (v === 'updown') return [cyl(B(x0, y0, x1, y1, 0, H, c, { emit: true }))];
      return [B(x0 + w * 0.3, y0, x1 - w * 0.3, y0 + 2, H * 0.2, H * 0.8, a), B(x0, y0 + 2, x1, y1, 0, H, c, { radius: Math.min(w, d) / 3, emit: true })];
    case 'light_strip':
      return [B(x0, y0, x1, y1, 0, Math.max(1, H), c, { emit: true })];
    case 'light_bar':
      if (v === 'bar') return [B(x0, y0, x1, y1, 0, 2, c), B(x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5, 2, H, c, { emit: true, radius: 1 })];
      if (v === 'go') return [cyl(B(x0, y0, x1, y1, 0, H * 0.4, c)), ...sphere(0, 0, H * 0.1, Math.min(w, d), c, { emit: true }, 3).slice(1)];
      return sphere(0, 0, 0, Math.min(w, d, H), c, { emit: true });
    case 'ceiling_fan': {
      const rr = Math.min(w, d) / 2;
      const cordLen = Math.max(0, 250 - r.elevation - H);
      return [
        { ...B(x0, y0, x1, y1, H * 0.35, H * 0.38, c, { topSvg: true }), cyl: true, clear: true },
        cyl(B(-rr * 0.15, -rr * 0.15, rr * 0.15, rr * 0.15, 0, H * 0.35, c, { emit: true })),
        cyl(B(-rr * 0.12, -rr * 0.12, rr * 0.12, rr * 0.12, H * 0.38, H * 0.55, c)),
        B(-1, -1, 1, 1, H * 0.55, H + cordLen, '#8d9297', { cord: true }),
      ];
    }
    case 'space_heater':
      if (v === 'oil') {
        const out: Part[] = [];
        for (let x = x0 + 6; x < x1 - 3; x += 7) out.push(B(x, y0, x + 5, y1, 8, H, c, { radius: 2, emit: true }));
        out.push(...legs(x0, y0, x1, y1, 8, 3, a, 2));
        return out;
      }
      if (v === 'infrared') return [B(x0, y0, x1, y1, 0, H, c, { emit: true })];
      if (v === 'fireplace') return [B(x0, y0, x1, y1, 0, H, a, { radius: 2 }), B(x0 + 8, y1 - 1, x1 - 8, y1 + 0.5, 8, H - 12, '#3a2a22', { emit: true })];
      return [B(x0, y0, x1, y1, 0, H, c, { radius: 4 }), B(x0 + 4, y1 - 1, x1 - 4, y1 + 0.5, H * 0.15, H * 0.7, '#4b4d52', { emit: true })];
    case 'humidifier':
      if (v === 'dehumid') return [B(x0, y0, x1, y1, 0, H, c, { radius: 5 }), B(x0 + 5, y0 + 4, x1 - 5, y0 + 9, H, H + 0.5, a, { emit: true })];
      return [cyl(B(x0, y0, x1, y1, 0, H * 0.7, c)), cyl(B(x0 + w * 0.2, y0 + d * 0.2, x1 - w * 0.2, y1 - d * 0.2, H * 0.7, H, a, { emit: true }))];
    case 'thermostat':
      return [B(x0, y0, x1, y1, 0, H, c, { radius: 1 }), B(x0 + 2, y1 - 0.5, x1 - 2, y1 + 0.3, H * 0.3, H * 0.75, '#3a3a3c', { emit: true })];
    case 'ac':
      if (v === 'portable') return [B(x0, y0, x1, y1, 0, H, c, { radius: 6 }), B(x0 + 6, y0 + 5, x1 - 6, y0 + 5 + d * 0.35, H, H + 0.5, '#d7dadd', { emit: true })];
      return [B(x0, y0, x1, y1, 0, H, c, { radius: 6 }), B(x0 + 6, y1 - 1, x1 - 6, y1 + 0.5, 2, 6, '#d7dadd', { emit: true })];
    case 'rug':
      return [B(x0, y0, x1, y1, 0, 0.8, c, { topSvg: true, radius: v === 'round' ? Math.min(w, d) / 2 : 2 })];
    case 'pouf':
    case 'pet_bed':
      return [{ ...B(x0, y0, x1, y1, 0, H, c), cyl: true }, ...(k.kind === 'pet_bed' ? [{ ...B(x0 + 9, y0 + 9, x1 - 9, y1 - 9, 0, H * 0.65, a), cyl: true }] : [])];
    case 'toilet':
      return [B(x0, y0, x1, y0 + 17, 0, 78, c, { radius: 4 }), { ...B(x0 + 1, y0 + 12, x1 - 1, y1, 0, 40, c), cyl: true }, { ...B(x0 + 4, y0 + 16, x1 - 4, y1 - 3, 40, 42, tone(c, -0.04)), cyl: true }];
    case 'washbasin':
      return v === 'single'
        ? [B(-8, y0, 8, y0 + 18, 0, 80, c), B(x0, y0, x1, y1, 80, 86, c, { radius: 6, topSvg: true })]
        : [B(x0 + 2, y0, x1 - 2, y1 - 4, 20, 80, a), B(x0, y0, x1, y1, 80, 86, tone(c, 0.02), { radius: 4, topSvg: true })];
    case 'bathtub':
      return [B(x0, y0, x1, y1, 0, H, c, { radius: v === 'free' ? Math.min(w, d) / 2 : 10, topSvg: true })];
    case 'shower': {
      const tray = B(x0, y0, x1, y1, 0, 4, c, { topSvg: true });
      const g = (p: Part) => ({ ...p, glass: true });
      if (v === 'walkin') return [tray, g(B(x0 + w * 0.5, y1 - 1, x1, y1, 4, H, a))];
      if (v === 'quarter') return [tray, g(B(x1 - 1, y0, x1, y0 + d * 0.3, 4, H, a)), g(B(x0, y1 - 1, x0 + w * 0.3, y1, 4, H, a))];
      return [tray, g(B(x0, y1 - 1, x1, y1, 4, H, a)), g(B(x1 - 1, y0, x1, y1, 4, H, a))];
    }
    case 'air_purifier':
      if (v === 'tower') return [B(x0, y0, x1, y1, 0, H, c, { radius: 6 }), B(x0 + 5, y0 + 4, x1 - 5, y1 - 4, H, H + 0.6, a, { emit: true })];
      return [cyl(B(x0, y0, x1, y1, 0, H, c)), cyl(B(x0 + w * 0.16, y0 + d * 0.16, x1 - w * 0.16, y1 - d * 0.16, H, H + 0.6, a, { emit: true }))];
    case 'trash':
      if (v === 'sorting') return [B(x0, y0, x1, y1, 0, H, c, { radius: 3, topSvg: true })];
      break;
    case 'fan':
      if (v === 'tower') return [cyl(B(x0, y0, x1, y1, 0, 3, c)), cyl(B(x0 + 3, y0 + 3, x1 - 3, y1 - 3, 3, H, c))];
      if (v === 'desk') return [cyl(B(-8, -8, 8, 8, 0, 2, c)), B(-1.5, -1.5, 1.5, 1.5, 2, H * 0.4, '#8d9297'), B(x0, -3, x1, 3, H * 0.3, H, c, { radius: Math.min(w, H) / 2 })];
      return [{ ...B(-14, -14, 14, 14, 0, 2, c), cyl: true }, B(-2, -2, 2, 2, 2, H - 30, '#8d9297'), { ...B(x0, -4, x1, 4, H - 34, H, c, { rot: 0 }), cyl: false, radius: Math.min(w, d) / 2 }];
    case 'piano':
      return [B(x0, y0, x1, y1 - 18, 0, H, c, { radius: 2 }), B(x0 + 4, y1 - 22, x1 - 4, y1, 68, 74, c, { topSvg: true }), B(x0 + 8, y1 - 20, x0 + 12, y1, 0, 68, c), B(x1 - 12, y1 - 20, x1 - 8, y1, 0, 68, c)];
    case 'dog':
    case 'cat': {
      // static stand-in (the WebGL renderer builds the articulated model)
      const rig = petRig(f);
      const out: Part[] = [];
      const add = (b: Blob, dx = 0, dz = 0) => {
        const z0 = b.s === 'cyl' ? b.z + dz : b.z + dz - b.h / 2;
        out.push({ ...B(b.x + dx - b.w / 2, b.y - b.d / 2, b.x + dx + b.w / 2, b.y + b.d / 2, Math.max(0, z0), Math.max(0.5, z0 + b.h), b.c), radius: Math.min(b.w, b.d) / 2, cyl: b.s !== 'box' });
      };
      for (const b of rig.body) add(b);
      for (const j of [rig.head, rig.tail, ...rig.legs]) for (const b of j.parts) add(b, j.pivot[0], j.pivot[2]);
      return out;
    }
    case 'cat_tree':
      return [B(x0, y0, x1, y1, 0, 6, a), B(-5, -5, 5, 5, 6, H, tone(c, -0.1)), { ...B(x0 + 4, y0 + 4, x0 + w * 0.6, y0 + d * 0.6, H * 0.5, H * 0.55, c), cyl: true }, { ...B(x1 - w * 0.55, y1 - d * 0.55, x1 - 4, y1 - 4, H - 6, H, c), cyl: true }];
    case 'lounger':
      return [...legs(x0, y0, x1, y1, 22, 4, a, 6), B(x0, y0, x1, y1, 22, 28, a, { radius: 6 }), B(x0 + w * 0.32, y0 + 4, x1 - 4, y1 - 4, 28, 34, c, { radius: 6 }), B(x0 + 4, y0 + 4, x0 + w * 0.3, y1 - 4, 28, 48, tone(c, 0.05), { radius: 6 })];
    case 'grill':
      if (v === 'gas') return [B(x0, y0, x1, y1, 0, 85, tone(c, 0.25), { radius: 3 }), B(x0 + w * 0.15, y0 + 4, x1 - w * 0.25, y1 - 4, 85, H, c, { radius: 6, topSvg: true })];
      return [...legs(x0 + w * 0.2, y0 + d * 0.2, x1 - w * 0.2, y1 - d * 0.2, 60, 3, '#8d9297', 0), { ...B(x0, y0, x1, y1, 60, H, c), cyl: true, topSvg: true }];
    case 'laundry_rack':
    case 'ironing_board':
      return [...legs(x0, y0, x1, y1, H - 3, 2.5, '#8d9297', 8), B(x0, y0, x1, y1, H - 3, H, c, { topSvg: true })];
    case 'coat_rack':
      return [B(x0, y0, x1, y0 + 4, 40, H, c), B(x0, y0 + d * 0.4, x1, y1, 0, 45, tone(c, 0.04), { radius: 2 })];
    case 'stairs':
      return stairParts(w, d, H, c, v, r.count);
    case 'planter':
      return [B(x0, y0, x1, y1, 0, H * 0.6, c, { radius: 2 }), B(x0 + 3, y0 + 3, x1 - 3, y1 - 3, H * 0.6, H, a, { radius: Math.min(w, d) / 2 })];
  }
  return undefined;
}
