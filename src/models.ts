import type { FurnitureConfig, HassEntity } from './types';
import { coverLive } from './openings';
import { resolveFurniture } from './furniture';
import { tone } from './colors';
import type { Blob } from './pets';
import { CARS, type CarShape } from './cars';
export { CARS, type CarShape };

/**
 * 3D models of garden, energy and vehicle pieces, built from rounded primitives (see Blob).
 * Local frame: x along the width (−w/2…w/2), y along the depth, z up; centimetres.
 * Nodes may be turned (deg) around their own origin `at` — tilted solar panels, roof halves, …
 */
export interface ModelNode {
  name?: string;
  at?: [number, number, number];
  rot?: [number, number, number];
  blobs: Blob[];
  kids?: ModelNode[];
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: string, extra: Partial<Blob> = {}): Blob => ({
  s: 'box',
  x: (x0 + x1) / 2,
  y: (y0 + y1) / 2,
  z: (z0 + z1) / 2,
  w: Math.abs(x1 - x0),
  d: Math.abs(y1 - y0),
  h: Math.max(0.3, Math.abs(z1 - z0)),
  c,
  ...extra,
});
const ell = (x: number, y: number, z: number, w: number, d: number, h: number, c: string, extra: Partial<Blob> = {}): Blob => ({ s: 'ell', x, y, z, w, d, h, c, ...extra });
const cyl = (x: number, y: number, z0: number, w: number, d: number, h: number, c: string, extra: Partial<Blob> = {}): Blob => ({ s: 'cyl', x, y, z: z0, w, d, h, c, ...extra });
const cone = (x: number, y: number, z0: number, dia: number, h: number, c: string, extra: Partial<Blob> = {}): Blob => ({ s: 'cone', x, y, z: z0, w: dia, d: dia, h, c, ...extra });
const wheel = (x: number, y: number, z: number, dia: number, width: number, c: string, extra: Partial<Blob> = {}): Blob => ({ s: 'wheel', x, y, z, w: dia, d: width, h: dia, c, ...extra });

/** Tiny deterministic noise for natural variation (per piece) */
const rnd = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const seedOf = (id: string) => [...id].reduce((a, ch) => a + ch.charCodeAt(0), 0);

const LEAF = ['#5f8f4e', '#6f9f5a', '#4f7f42', '#7aa860'];
const FLOWERS = ['#e8586b', '#f2c14e', '#f28f3b', '#b07cd8', '#f4f4f2', '#e46aa0', '#5a8fd8'];
const SOIL = '#6b4a36';
const STEEL = '#8d9297';
const DARK = '#2c2c2e';

// ---------- garden ----------

function tree(v: string, w: number, d: number, H: number, c: string, a: string, seed: number): ModelNode {
  const r = Math.min(w, d) / 2;
  if (v === 'conifer') {
    const blobs: Blob[] = [cyl(0, 0, 0, r * 0.18, r * 0.18, H * 0.2, a)];
    for (let i = 0; i < 4; i++) {
      const z = H * (0.12 + i * 0.2);
      const dia = r * 2 * (1 - i * 0.2);
      blobs.push(cone(0, 0, z, dia, H * 0.42, tone(c, -0.04 + i * 0.03)));
    }
    return { blobs };
  }
  const blobs: Blob[] = [];
  const trunkC = v === 'birch' ? '#ece8e0' : a;
  const crownZ = H * (v === 'fruit' ? 0.62 : 0.66);
  blobs.push(cyl(0, 0, 0, r * 0.16, r * 0.16, crownZ, trunkC));
  if (v === 'birch') for (let i = 0; i < 5; i++) blobs.push(box(-r * 0.09, -r * 0.02, crownZ * (0.15 + i * 0.15), r * 0.09, r * 0.02, crownZ * (0.15 + i * 0.15) + 3, '#3a3a3c', { y: r * 0.075 }));
  // a few branches into the crown
  blobs.push(ell(r * 0.12, 0, crownZ * 0.9, r * 0.5, r * 0.08, r * 0.08, trunkC, { ry: -35 }));
  blobs.push(ell(-r * 0.1, r * 0.06, crownZ * 0.95, r * 0.45, r * 0.07, r * 0.07, trunkC, { ry: 40, rz: 30 }));
  // crown: overlapping soft clumps in slightly different greens
  const n = v === 'birch' ? 9 : 7;
  const cr = H - crownZ;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rnd(seed + i) * 0.8;
    const rad = i === 0 ? 0 : r * (0.38 + rnd(seed + i * 3) * 0.22);
    const s = (i === 0 ? 1.15 : 0.7 + rnd(seed + i * 7) * 0.25) * (v === 'birch' ? 0.75 : 1);
    blobs.push(ell(Math.cos(ang) * rad, Math.sin(ang) * rad, crownZ + cr * (i === 0 ? 0.42 : 0.3 + rnd(seed + i * 5) * 0.35), r * 1.15 * s, r * 1.15 * s, cr * 0.9 * s, tone(c, (rnd(seed + i * 11) - 0.5) * 0.14)));
  }
  if (v === 'fruit')
    for (let i = 0; i < 14; i++) {
      const ang = rnd(seed + i * 13) * Math.PI * 2;
      const zz = crownZ + cr * (0.15 + rnd(seed + i * 17) * 0.6);
      blobs.push(ell(Math.cos(ang) * r * 0.82, Math.sin(ang) * r * 0.82, zz, 7, 7, 7, a === trunkC ? '#d8483a' : a));
    }
  return { blobs };
}

function bush(v: string, w: number, d: number, H: number, c: string, a: string, seed: number): ModelNode {
  if (v === 'hedge') return { blobs: [box(-w / 2, -d / 2, 0, w / 2, d / 2, H, c, { r: Math.min(d, 30) * 0.45 }), box(-w / 2 + 3, -d / 2 + 3, H - 6, w / 2 - 3, d / 2 - 3, H + 4, tone(c, 0.05), { r: Math.min(d, 30) * 0.4 })] };
  const blobs: Blob[] = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rnd(seed + i);
    const rad = i === 0 ? 0 : Math.min(w, d) * 0.18;
    blobs.push(ell(Math.cos(ang) * rad, Math.sin(ang) * rad, H * 0.5, w * (i ? 0.7 : 0.9), d * (i ? 0.7 : 0.9), H * (i ? 0.75 : 1), tone(c, (rnd(seed + i * 3) - 0.5) * 0.1)));
  }
  if (v === 'flowering')
    for (let i = 0; i < 16; i++) {
      const ang = rnd(seed + i * 7) * Math.PI * 2;
      blobs.push(ell(Math.cos(ang) * w * 0.38, Math.sin(ang) * d * 0.38, H * (0.35 + rnd(seed + i * 9) * 0.55), 6, 6, 5, a));
    }
  return { blobs };
}

function flowerBed(w: number, d: number, c: string, a: string, seed: number, raised: boolean): ModelNode {
  const blobs: Blob[] = [];
  const base = raised ? 70 : 6;
  if (raised) {
    const t = 5;
    blobs.push(box(-w / 2, -d / 2, 0, w / 2, -d / 2 + t, base, a), box(-w / 2, d / 2 - t, 0, w / 2, d / 2, base, a));
    blobs.push(box(-w / 2, -d / 2, 0, -w / 2 + t, d / 2, base, tone(a, -0.05)), box(w / 2 - t, -d / 2, 0, w / 2, d / 2, base, tone(a, -0.05)));
    blobs.push(box(-w / 2 + t, -d / 2 + t, base - 8, w / 2 - t, d / 2 - t, base - 3, SOIL));
  } else blobs.push(box(-w / 2, -d / 2, 0, w / 2, d / 2, base, SOIL, { r: Math.min(w, d) * 0.2 }));
  const n = Math.max(6, Math.min(40, Math.round((w * d) / 900)));
  for (let i = 0; i < n; i++) {
    const x = (rnd(seed + i * 3) - 0.5) * (w - 14);
    const y = (rnd(seed + i * 5) - 0.5) * (d - 14);
    const hgt = (raised ? 14 : 22) + rnd(seed + i * 7) * 14;
    const z0 = raised ? base - 3 : base;
    if (raised) {
      // vegetables: lettuce heads and leafy rows
      blobs.push(ell(x, y, z0 + hgt * 0.35, 16, 16, hgt * 0.7, LEAF[i % LEAF.length]));
      continue;
    }
    blobs.push(ell(x, y, z0 + hgt * 0.4, 9, 9, hgt * 0.8, LEAF[i % LEAF.length]));
    blobs.push(ell(x + 1, y, z0 + hgt, 8, 8, 6, i % 3 === 0 ? c : FLOWERS[(i + seed) % FLOWERS.length]));
  }
  return { blobs };
}

function shed(w: number, d: number, H: number, c: string, a: string): ModelNode {
  const wallH = H * 0.7;
  const roofH = H - wallH;
  const half = Math.hypot(d / 2 + 10, roofH);
  const ang = (Math.atan2(roofH, d / 2 + 10) * 180) / Math.PI;
  return {
    blobs: [
      box(-w / 2, -d / 2, 0, w / 2, d / 2, wallH, c),
      // door and a small window on the front
      box(-w * 0.18, d / 2, 0, w * 0.18, d / 2 + 1, wallH * 0.85, a),
      box(w * 0.26, d / 2, wallH * 0.45, w * 0.42, d / 2 + 1, wallH * 0.75, '#9fb8c8', { glass: true }),
      box(-w / 2, -d / 2 + 0.5, wallH, w / 2, d / 2 - 0.5, wallH + roofH * 0.6, c),
    ],
    kids: [
      { at: [0, -d / 4 - 2.5, wallH + roofH / 2], rot: [-ang, 0, 0], blobs: [box(-w / 2 - 8, -half / 2, -2, w / 2 + 8, half / 2, 2, a)] },
      { at: [0, d / 4 + 2.5, wallH + roofH / 2], rot: [ang, 0, 0], blobs: [box(-w / 2 - 8, -half / 2, -2, w / 2 + 8, half / 2, 2, a)] },
    ],
  };
}

function greenhouse(w: number, d: number, H: number): ModelNode {
  const wallH = H * 0.65;
  const roofH = H - wallH;
  const half = Math.hypot(d / 2, roofH);
  const ang = (Math.atan2(roofH, d / 2) * 180) / Math.PI;
  const frame = '#dfe3e6';
  const blobs: Blob[] = [box(-w / 2, -d / 2, 0, w / 2, d / 2, wallH, '#cfe3d6', { glass: true })];
  for (const x of [-w / 2, 0, w / 2]) for (const y of [-d / 2, d / 2]) blobs.push(box(x - 1.5, y - 1.5, 0, x + 1.5, y + 1.5, wallH, frame));
  for (let i = 0; i < 6; i++) blobs.push(ell(-w / 2 + 18 + ((w - 36) * i) / 5, 0, 22, 18, 18, 30, LEAF[i % 4]));
  return {
    blobs,
    kids: [
      { at: [0, -d / 4, wallH + roofH / 2], rot: [-ang, 0, 0], blobs: [box(-w / 2, -half / 2, -1, w / 2, half / 2, 1, '#cfe3d6', { glass: true })] },
      { at: [0, d / 4, wallH + roofH / 2], rot: [ang, 0, 0], blobs: [box(-w / 2, -half / 2, -1, w / 2, half / 2, 1, '#cfe3d6', { glass: true })] },
    ],
  };
}

/** Gate between two posts; its leaves are named nodes (leaf0, leaf1) that turn or slide open by `k` (0 … 1) */
export const GATE_SWING_DEG = 85;
function gate(v: string, w: number, d: number, H: number, c: string, a: string, k: number): ModelNode {
  const blobs: Blob[] = [box(-w / 2 - 12, -6, 0, -w / 2, 6, H + 10, a, { r: 1.5 }), box(w / 2, -6, 0, w / 2 + 12, 6, H + 10, a, { r: 1.5 })];
  const leaf = (x0: number, L: number): Blob[] => {
    const out: Blob[] = [box(x0, -1.5, 8, x0 + L, 1.5, 12, c), box(x0, -1.5, H - 4, x0 + L, 1.5, H, c), box(x0, -2, 8, x0 + 3, 2, H, c), box(x0 + L - 3, -2, 8, x0 + L, 2, H, c)];
    const bars = Math.max(3, Math.round(L / 25));
    for (let i = 1; i < bars; i++) out.push(box(x0 + (L * i) / bars - 1, -1, 8, x0 + (L * i) / bars + 1, 1, H, c));
    return out;
  };
  if (v === 'sliding') {
    blobs.push(box(-w / 2, 6, 0, w / 2 + w, 9, 1.5, STEEL));
    return { blobs, kids: [{ name: 'leaf0', at: [-w / 2 + k * w, 7.5, 0], blobs: leaf(0, w) }] };
  }
  if (v === 'door') return { blobs, kids: [{ name: 'leaf0', at: [-w / 2, 0, 0], rot: [0, 0, k * GATE_SWING_DEG], blobs: leaf(0, w) }] };
  return {
    blobs,
    kids: [
      { name: 'leaf0', at: [-w / 2, 0, 0], rot: [0, 0, k * GATE_SWING_DEG], blobs: leaf(0, w / 2) },
      { name: 'leaf1', at: [w / 2, 0, 0], rot: [0, 0, -k * GATE_SWING_DEG], blobs: leaf(-w / 2, w / 2) },
    ],
  };
}

/** Garage door standing in front of a wall: frame and a door (node "panel") that has gone up by `k` (0 … 1) */
function garageDoorModel(w: number, d: number, H: number, c: string, a: string, k: number): ModelNode {
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const blobs: Blob[] = [box(x0 - 6, y0 - 2, 0, x0, y1 + 2, H + 6, a), box(x1, y0 - 2, 0, x1 + 6, y1 + 2, H + 6, a), box(x0 - 6, y0 - 2, H, x1 + 6, y1 + 2, H + 6, a)];
  const z0 = k * H;
  const h = Math.max(1, H - z0);
  const panel: Blob[] = [box(x0, y0, 0, x1, y1, H, c)];
  for (let i = 1; i < 4; i++) panel.push(box(x0 + 2, y1, (H * i) / 4 - 0.6, x1 - 2, y1 + 0.5, (H * i) / 4 + 0.6, tone(c, -0.15)));
  panel.push(box(-12, y1, H * 0.12, 12, y1 + 2, H * 0.15, STEEL));
  // CSS stand-in: the door already as far up as it is (WebGL scales the node while it runs)
  const scaled = k > 0 ? panel.map((b) => ({ ...b, z: z0 + (b.z * h) / H, h: Math.max(0.3, (b.h * h) / H) })) : panel;
  return { blobs, kids: [{ name: 'panel', blobs: scaled }] };
}

/** Irrigation zone: a nozzle in the middle of the area a valve waters (area and spray are drawn while it runs) */
function irrigationZone(w: number, d: number, c: string, a: string): ModelNode {
  return {
    blobs: [cyl(0, 0, 0, 14, 14, 3, DARK), cyl(0, 0, 3, 5, 5, 9, c)],
    kids: [{ name: 'nozzle', at: [0, 0, 12], blobs: [cyl(0, 0, 0, 6, 6, 2, a, { emit: true })] }],
  };
}

function gardenModel(kind: string, v: string, w: number, d: number, H: number, c: string, a: string, seed: number, n: number, k = 0): ModelNode | undefined {
  switch (kind) {
    case 'tree':
      return tree(v, w, d, H, c, a, seed);
    case 'bush':
      return bush(v, w, d, H, c, a, seed);
    case 'flower_bed':
      return flowerBed(w, d, c, a, seed, false);
    case 'raised_bed':
      return flowerBed(w, d, c, a, seed, true);
    case 'shed':
      return shed(w, d, H, c, a);
    case 'greenhouse':
      return greenhouse(w, d, H);
    case 'lawn_mower':
      return {
        blobs: [
          box(-w / 2, -d / 2, 4, w / 2, d / 2, H * 0.75, c, { r: Math.min(w, d) * 0.3, name: 'body' }),
          box(-w / 2 + 6, -d / 2 + 5, H * 0.75, w / 2 - 12, d / 2 - 5, H, a, { r: Math.min(w, d) * 0.25 }),
          cyl(w * 0.18, 0, H, 8, 8, 2.5, '#d8483a'),
          box(w / 2 - 10, -2, H * 0.78, w / 2 - 6, 2, H * 0.84, '#8fd3ff', { emit: true, name: 'led' }),
          wheel(-w * 0.3, -d / 2 + 2, 9, 18, 6, DARK),
          wheel(-w * 0.3, d / 2 - 2, 9, 18, 6, DARK),
          wheel(w * 0.32, -d * 0.3, 4.5, 9, 4, DARK),
          wheel(w * 0.32, d * 0.3, 4.5, 9, 4, DARK),
        ],
      };
    case 'mower_dock':
      return {
        blobs: [
          box(-w / 2, -d / 2, 0, w / 2, d / 2, 2.5, DARK, { r: 8 }),
          box(-w / 2, -d * 0.25, 0, -w / 2 + 14, d * 0.25, H, c, { r: 5 }),
          box(-w / 2 + 14, -3, H * 0.55, -w / 2 + 15, 3, H * 0.7, '#5fd0c6', { emit: true, name: 'led' }),
        ],
      };
    case 'sprinkler':
      if (v === 'oscillating')
        return {
          blobs: [box(-w / 2, -d * 0.2, 0, w / 2, d * 0.2, 4, c, { r: 3 }), cyl(-w / 2 + 3, 0, 4, 5, 5, 6, STEEL), cyl(w / 2 - 8, 0, 4, 5, 5, 6, STEEL)],
          kids: [{ name: 'nozzle', at: [0, 0, 10], blobs: [box(-w / 2 + 4, -1.5, -1.5, w / 2 - 8, 1.5, 1.5, a, { r: 1.4 })] }],
        };
      return { blobs: [cyl(0, 0, 0, w, d, 4, DARK), cyl(0, 0, 4, w * 0.5, d * 0.5, H - 4, a)], kids: [{ name: 'nozzle', at: [0, 0, H], blobs: [] }] };
    case 'garden_light':
      if (v === 'spot') return { blobs: [cyl(0, 0, 0, 4, 4, 14, DARK), cone(0, 0, 10, w, H - 10, c), cyl(0, 0, H - 1, w * 0.7, d * 0.7, 1, '#ffe2a8', { emit: true })] };
      if (v === 'string') {
        const blobs: Blob[] = [cyl(-w / 2, 0, 0, 5, 5, H, DARK), cyl(w / 2, 0, 0, 5, 5, H, DARK)];
        const k = Math.max(4, Math.round(w / 35));
        for (let i = 0; i <= k; i++) {
          const x = -w / 2 + (w * i) / k;
          const sag = Math.sin((Math.PI * i) / k) * Math.min(40, w * 0.08);
          blobs.push(ell(x, 0, H - 6 - sag, 6, 6, 8, '#ffe2a8', { emit: true }));
        }
        return { blobs };
      }
      return { blobs: [cyl(0, 0, 0, w, d, H - 14, c), cyl(0, 0, H - 14, w * 0.9, d * 0.9, 10, '#ffe2a8', { emit: true }), cyl(0, 0, H - 4, w * 1.15, d * 1.15, 4, c)] };
    case 'parasol': {
      const dia = Math.min(w, d);
      if (v === 'cantilever')
        return {
          blobs: [box(-w / 2, -16, 0, -w / 2 + 50, 16, 8, DARK), cyl(-w / 2 + 25, 0, 8, 6, 6, H, STEEL), box(-w / 2 + 25, -2, H - 6, 0, 2, H - 2, STEEL)],
          kids: [{ at: [w * 0.08, 0, H - 12], blobs: [cone(0, 0, 0, dia * 0.95, 30, c), cyl(0, 0, -6, dia * 0.95, dia * 0.95, 6, tone(c, -0.08))] }],
        };
      return { blobs: [cyl(0, 0, 0, 45, 45, 8, DARK), cyl(0, 0, 8, 4, 4, H - 10, '#e9e6df'), cone(0, 0, H - 34, dia, 30, c), cyl(0, 0, H - 40, dia, dia, 6, tone(c, -0.08))] };
    }
    case 'garden_bench':
      return {
        blobs: [
          ...[-w / 2 + 6, w / 2 - 12].flatMap((x) => [box(x, -d / 2 + 4, 0, x + 6, -d / 2 + 10, 44, DARK), box(x, d / 2 - 10, 0, x + 6, d / 2 - 4, 44, DARK), box(x, -d / 2 + 2, 40, x + 6, d / 2, 44, DARK)]),
          ...[0, 1, 2, 3].map((i) => box(-w / 2, -d / 2 + 4 + i * ((d - 14) / 4), 44, w / 2, -d / 2 + 4 + (i + 0.85) * ((d - 14) / 4), 47, c)),
          box(-w / 2, d / 2 - 6, 50, w / 2, d / 2 - 3, 62, c),
          box(-w / 2, d / 2 - 6, 66, w / 2, d / 2 - 3, 78, c),
          ...[-w / 2 + 6, w / 2 - 12].map((x) => box(x, d / 2 - 7, 44, x + 6, d / 2 - 2, 82, DARK)),
        ],
      };
    case 'garden_lounge':
      return {
        blobs: [
          box(-w / 2, -d / 2, 0, w / 2, d / 2, 34, c, { r: 6 }),
          box(-w / 2 + 4, -d / 2 + 18, 34, w / 2 - 4, d / 2 - 4, 44, a, { r: 8 }),
          box(-w / 2, -d / 2, 34, w / 2, -d / 2 + 18, 70, c, { r: 6 }),
          box(-w / 2 + 8, -d / 2 + 14, 42, -w / 2 + 50, -d / 2 + 24, 68, tone(a, 0.06), { r: 6 }),
          box(w / 2 - 50, -d / 2 + 14, 42, w / 2 - 8, -d / 2 + 24, 68, tone(a, 0.06), { r: 6 }),
        ],
      };
    case 'trampoline': {
      const dia = Math.min(w, d);
      const blobs: Blob[] = [cyl(0, 0, 70, dia, dia, 6, '#3a6fb0'), cyl(0, 0, 72, dia * 0.86, dia * 0.86, 5, DARK)];
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        blobs.push(cyl(Math.cos(ang) * dia * 0.48, Math.sin(ang) * dia * 0.48, 0, 4, 4, 70, STEEL));
        blobs.push(cyl(Math.cos(ang) * dia * 0.48, Math.sin(ang) * dia * 0.48, 70, 3, 3, H - 70, '#3a6fb0'));
      }
      blobs.push(cyl(0, 0, 76, dia * 0.98, dia * 0.98, H - 76, '#dfe7ef', { glass: true, op: 0.18 }));
      return { blobs };
    }
    case 'pool': {
      const rim = 14;
      if (v === 'round')
        return { blobs: [cyl(0, 0, 0, w, d, H, c), cyl(0, 0, H - 14, w - 8, d - 8, 4, '#5ec3e8', { emit: true, name: 'water' })] };
      if (v === 'hottub')
        return {
          blobs: [
            box(-w / 2, -d / 2, 0, w / 2, d / 2, H - 4, '#6b5a4a', { r: 18 }),
            box(-w / 2, -d / 2, H - 4, w / 2, d / 2, H, c, { r: 18 }),
            box(-w / 2 + 16, -d / 2 + 16, H - 10, w / 2 - 16, d / 2 - 16, H + 0.4, '#5ec3e8', { r: 26, emit: true, name: 'water' }),
          ],
        };
      return {
        blobs: [
          box(-w / 2, -d / 2, 0, w / 2, d / 2, 4, c),
          box(-w / 2 + rim, -d / 2 + rim, 1, w / 2 - rim, d / 2 - rim, 4.5, '#4fb6e0', { emit: true, name: 'water' }),
          box(w / 2 - rim - 40, -d / 2 + rim, 4, w / 2 - rim - 34, -d / 2 + rim + 4, 70, STEEL),
        ],
      };
    }
    case 'pond':
      return {
        blobs: [
          ell(0, 0, 0, w, d, 6, '#3f7f9a', { emit: true, name: 'water' }),
          ...Array.from({ length: 10 }, (_, i) => {
            const ang = (i / 10) * Math.PI * 2;
            return ell(Math.cos(ang) * w * 0.5, Math.sin(ang) * d * 0.5, 4, 22 + rnd(seed + i) * 14, 18 + rnd(seed + i * 3) * 10, 12, tone('#a8a29a', (rnd(seed + i * 5) - 0.5) * 0.2));
          }),
          ell(-w * 0.2, d * 0.1, 3.5, 22, 22, 2, '#5f8f4e'),
        ],
      };
    case 'fence': {
      const blobs: Blob[] = [];
      if (v === 'gabion') {
        blobs.push(box(-w / 2, -d / 2, 0, w / 2, d / 2, H, '#a8a29a', { r: 2 }));
        for (let x = -w / 2; x <= w / 2; x += 50) blobs.push(box(x - 1, -d / 2 - 0.5, 0, x + 1, d / 2 + 0.5, H, STEEL));
        return { blobs };
      }
      const metal = v === 'metal';
      for (let x = -w / 2; x <= w / 2 + 0.1; x += 200) blobs.push(box(x - 4, -4, 0, x + 4, 4, H + 4, metal ? DARK : a));
      if (metal) {
        for (const z of [H * 0.1, H * 0.95]) blobs.push(box(-w / 2, -1, z, w / 2, 1, z + 3, DARK));
        for (let x = -w / 2 + 8; x < w / 2; x += 10) blobs.push(box(x - 0.6, -0.6, H * 0.1, x + 0.6, 0.6, H * 0.95, DARK));
      } else {
        for (const z of [H * 0.2, H * 0.75]) blobs.push(box(-w / 2, -3, z, w / 2, 0, z + 6, a));
        for (let x = -w / 2 + 6; x < w / 2; x += 12) blobs.push(box(x - 4.5, 0, 2, x + 4.5, 2, H, c));
      }
      return { blobs };
    }
    case 'rain_barrel':
      return { blobs: [cyl(0, 0, 0, w, d, H, c), cyl(0, 0, H, w * 1.04, d * 1.04, 3, tone(c, -0.1)), box(w * 0.42, -2, 10, w * 0.52, 2, 14, STEEL)] };
    case 'compost': {
      const blobs: Blob[] = [];
      for (let z = 4; z < H; z += 14) {
        blobs.push(box(-w / 2, -d / 2, z, w / 2, -d / 2 + 3, z + 10, c), box(-w / 2, d / 2 - 3, z, w / 2, d / 2, z + 10, c));
        blobs.push(box(-w / 2, -d / 2, z, -w / 2 + 3, d / 2, z + 10, tone(c, -0.05)), box(w / 2 - 3, -d / 2, z, w / 2, d / 2, z + 10, tone(c, -0.05)));
      }
      blobs.push(box(-w / 2 + 3, -d / 2 + 3, 0, w / 2 - 3, d / 2 - 3, H * 0.7, SOIL));
      return { blobs };
    }
    case 'firepit':
      return {
        blobs: [
          cyl(0, 0, 0, w * 0.5, d * 0.5, 8, DARK),
          cyl(0, 0, 8, w, d, H - 8, c),
          cyl(0, 0, H - 3, w * 0.85, d * 0.85, 2, '#3a2a22'),
          ell(-w * 0.1, 0, H, w * 0.5, 8, 8, '#6b4a36', { rz: 30 }),
          ell(w * 0.1, 0, H + 2, w * 0.5, 8, 8, '#5e4030', { rz: -30 }),
        ],
        kids: [{ name: 'flame', at: [0, 0, H + 4], blobs: [cone(0, 0, 0, w * 0.32, w * 0.45, '#ff9a3a', { emit: true }), cone(0, 0, 0, w * 0.18, w * 0.3, '#ffe08a', { emit: true })] }],
      };
    case 'swing': {
      const blobs: Blob[] = [];
      for (const y of [-d / 2, d / 2]) {
        blobs.push(box(-w / 2, y - 3, 0, -w / 2 + 6, y + 3, H, a, { ry: 0 }));
        blobs.push(box(w / 2 - 6, y - 3, 0, w / 2, y + 3, H, a));
      }
      blobs.push(box(-w / 2, -d / 2, H - 6, w / 2, d / 2, H, a));
      for (const x of [-w * 0.2, w * 0.2]) {
        blobs.push(box(x - 0.6, -18, 45, x + 0.6, -17, H - 6, STEEL), box(x - 0.6, 17, 45, x + 0.6, 18, H - 6, STEEL));
        blobs.push(box(x - 20, -20, 42, x + 20, 20, 46, c, { r: 3 }));
      }
      return { blobs };
    }
    case 'sandbox':
      return { blobs: [box(-w / 2, -d / 2, 0, w / 2, -d / 2 + 6, 25, a), box(-w / 2, d / 2 - 6, 0, w / 2, d / 2, 25, a), box(-w / 2, -d / 2, 0, -w / 2 + 6, d / 2, 25, a), box(w / 2 - 6, -d / 2, 0, w / 2, d / 2, 25, a), box(-w / 2 + 6, -d / 2 + 6, 0, w / 2 - 6, d / 2 - 6, 18, c)] };
    case 'gate':
      return gate(v, w, d, H, c, a, k);
    case 'garage_door':
      return garageDoorModel(w, d, H, c, a, k);
    case 'irrigation_zone':
      return irrigationZone(w, d, c, a);
    case 'garden_socket':
      if (v === 'post')
        return { blobs: [box(-w / 2, -d / 2, 0, w / 2, d / 2, H, c, { r: 3 }), box(-w / 2 + 2, d / 2, H * 0.55, w / 2 - 2, d / 2 + 1.5, H * 0.85, a, { r: 1.5 }), box(-w / 2 + 2, d / 2, H * 0.2, w / 2 - 2, d / 2 + 1.5, H * 0.5, a, { r: 1.5 }), box(-2, d / 2 + 1.5, H * 0.9, 2, d / 2 + 2, H * 0.94, '#3ee07a', { emit: true, name: 'led' })] };
      return { blobs: [box(-w / 2, -d / 2, 0, w / 2, d / 2, H, c, { r: 2 }), box(-w / 2 + 1.5, d / 2, 2, w / 2 - 1.5, d / 2 + 1.5, H - 2, a, { r: 1.5 })] };
    case 'carport': {
      const blobs: Blob[] = [];
      for (const x of [-w / 2 + 8, w / 2 - 8]) for (const y of [-d / 2 + 8, d / 2 - 8]) blobs.push(box(x - 6, y - 6, 0, x + 6, y + 6, H - 12, a));
      blobs.push(box(-w / 2, -d / 2, H - 12, w / 2, d / 2, H, c));
      return { blobs };
    }
  }
  return undefined;
}

// ---------- energy ----------

function solar(v: string, w: number, d: number, n: number, c: string, a: string): ModelNode {
  const tilt = v === 'ground' ? 28 : v === 'balcony' ? 65 : v === 'flat' ? 12 : 0;
  const cols = v === 'balcony' ? n : Math.max(1, Math.round(Math.sqrt((n * w) / Math.max(1, d) / 1.7)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const pw = w / cols;
  const depth = v === 'balcony' ? 112 : d / Math.cos((tilt * Math.PI) / 180);
  const ph = depth / rows;
  const panels: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + pw * ((i % cols) + 0.5);
    const cy = -depth / 2 + ph * (Math.floor(i / cols) + 0.5);
    panels.push(box(cx - pw / 2 + 1, cy - ph / 2 + 1, 0, cx + pw / 2 - 1, cy + ph / 2 - 1, 3.5, a));
    panels.push(box(cx - pw / 2 + 3, cy - ph / 2 + 3, 3.5, cx + pw / 2 - 3, cy + ph / 2 - 3, 4, c, { name: 'panel' }));
    // cell grid
    for (let k = 1; k < 3; k++) panels.push(box(cx - pw / 2 + 3, cy - ph / 2 + 3 + ((ph - 6) * k) / 3 - 0.3, 4, cx + pw / 2 - 3, cy - ph / 2 + 3 + ((ph - 6) * k) / 3 + 0.3, 4.3, tone(c, 0.18)));
  }
  const lift = v === 'ground' ? 45 : 0;
  const blobs: Blob[] = [];
  if (v === 'ground') for (const x of [-w / 2 + 10, w / 2 - 10]) blobs.push(box(x - 3, -d / 2 + 10, 0, x + 3, -d / 2 + 16, 30, STEEL), box(x - 3, d / 2 - 16, 0, x + 3, d / 2 - 10, 80, STEEL));
  return { blobs, kids: [{ name: 'array', at: [0, 0, lift + (v === 'ground' ? 15 : v === 'balcony' ? 70 : 0)], rot: [-tilt, 0, 0], blobs: panels }] };
}

function energyModel(kind: string, v: string, w: number, d: number, H: number, c: string, a: string, n: number): ModelNode | undefined {
  switch (kind) {
    case 'solar_panels':
      return solar(v, w, d, Math.max(1, n), c, a);
    case 'inverter':
      return {
        blobs: [
          box(-w / 2, -d / 2, 0, w / 2, d / 2, H, c, { r: 3 }),
          box(-w * 0.3, d / 2, H * 0.6, w * 0.3, d / 2 + 0.6, H * 0.78, '#1f2a33'),
          box(-w * 0.26, d / 2 + 0.6, H * 0.63, w * 0.1, d / 2 + 1, H * 0.75, '#5fd0c6', { emit: true, name: 'led' }),
        ],
      };
    case 'home_battery': {
      const blobs: Blob[] = [];
      const modules = v === 'tower' ? Math.max(2, Math.min(6, n || 3)) : 1;
      const mh = (H - 6) / modules;
      for (let i = 0; i < modules; i++) blobs.push(box(-w / 2, -d / 2, 6 + i * mh, w / 2, d / 2, 6 + (i + 1) * mh - 1.2, i === modules - 1 ? c : tone(c, -0.03), { r: 3 }));
      blobs.push(box(-w / 2 + 2, -d / 2 + 2, 0, w / 2 - 2, d / 2 - 2, 6, DARK));
      // charge level bar on the front: five segments
      for (let i = 0; i < 5; i++) blobs.push(box(-w * 0.06, d / 2, H * 0.3 + i * (H * 0.09), w * 0.06, d / 2 + 0.8, H * 0.3 + i * (H * 0.09) + H * 0.06, '#5a5f66', { name: `seg${i}` }));
      blobs.push(box(-w * 0.32, d / 2, H - 9, w * 0.32, d / 2 + 0.5, H - 7, a));
      return { blobs };
    }
    case 'wallbox':
      if (v === 'pillar')
        return {
          blobs: [
            box(-w / 2 + 2, -d / 2 + 2, 0, w / 2 - 2, d / 2 - 2, 4, DARK),
            box(-w * 0.32, -d * 0.3, 4, w * 0.32, d * 0.3, H * 0.5, tone(c, -0.06), { r: 3 }),
            box(-w / 2, -d / 2, H * 0.5, w / 2, d / 2, H, c, { r: 4 }),
            box(-w * 0.4, d / 2, H * 0.58, w * 0.4, d / 2 + 0.6, H * 0.94, a, { r: 3 }),
            cyl(0, d / 2 + 0.6, H * 0.8, w * 0.36, 1, 1, '#9be7a8', { rx: 90, emit: true, name: 'ring' }),
            box(-w * 0.15, d / 2, H * 0.36, w * 0.15, d / 2 + 6, H * 0.46, DARK),
            ell(0, d / 2 + 5, H * 0.3, w * 0.9, 6, 30, DARK, { rx: 90 }),
          ],
        };
      return {
        blobs: [
          box(-w / 2, -d / 2, 0, w / 2, d / 2, H, c, { r: 4 }),
          box(-w * 0.4, d / 2, H * 0.12, w * 0.4, d / 2 + 0.6, H * 0.88, a, { r: 3 }),
          cyl(0, d / 2 + 0.6, H * 0.62, w * 0.36, 1, 1, '#9be7a8', { rx: 90, emit: true, name: 'ring' }),
          // holster and coiled cable
          box(-w * 0.15, d / 2, -20, w * 0.15, d / 2 + 6, -6, DARK),
          ell(0, d / 2 + 5, -30, w * 0.9, 6, 30, DARK, { rx: 90 }),
        ],
      };
    case 'heat_pump':
      return {
        blobs: [box(-w / 2, -d / 2, 8, w / 2, d / 2, H, c, { r: 4 }), box(-w / 2 + 4, -d / 2 + 4, 0, -w / 2 + 12, d / 2 - 4, 8, DARK), box(w / 2 - 12, -d / 2 + 4, 0, w / 2 - 4, d / 2 - 4, 8, DARK)],
        kids: [
          {
            name: 'fan',
            at: [-w * 0.12, d / 2, 8 + (H - 8) * 0.5],
            rot: [90, 0, 0],
            blobs: [cyl(0, 0, 0, (H - 8) * 0.72, (H - 8) * 0.72, 1, '#2f3134'), ...[0, 1, 2].map((i) => box(-1.5, 0, 1, 1.5, (H - 8) * 0.32, 2, '#8d9297', { rz: i * 120, x: Math.sin((i * 2 * Math.PI) / 3) * (H - 8) * 0.16, y: Math.cos((i * 2 * Math.PI) / 3) * (H - 8) * 0.16 }))],
          },
        ],
      };
  }
  return undefined;
}

// ---------- vehicles ----------

/** A straight tube between two points of the side view (x forward, z up), at lateral offset y */
const tube = (x0: number, z0: number, x1: number, z1: number, t: number, c: string, y = 0): Blob => {
  const len = Math.hypot(x1 - x0, z1 - z0) + t * 0.5;
  return box(-len / 2, y - t / 2, -t / 2, len / 2, y + t / 2, t / 2, c, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, ry: (-Math.atan2(z1 - z0, x1 - x0) * 180) / Math.PI });
};
const TYRE = '#1d1d1f';
/** Tyre with a lighter rim face (two discs): scooters, motorcycles */
const bikeWheel = (x: number, z: number, dia: number, width: number, rim = '#8d9297'): Blob[] => [wheel(x, 0, z, dia, width, TYRE), wheel(x, 0, z, dia * 0.62, width + 0.4, rim)];
/** Bicycle wheel: a tyre ring of short segments, see-through spokes, hub */
const spokedWheel = (x: number, z: number, dia: number, width: number): Blob[] => {
  const n = 16;
  // segments are laid from the outer edge inward (box origin sits on its bottom face)
  const r = dia / 2;
  const seg = ((2 * Math.PI * (dia / 2)) / n) * 1.08;
  const out: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    out.push(box(-seg / 2, -width / 2, -1.6, seg / 2, width / 2, 1.6, TYRE, { x: x + Math.cos(ang) * r, z: z + Math.sin(ang) * r + 1.6, ry: (-ang * 180) / Math.PI - 90 }));
  }
  out.push(wheel(x, 0, z, dia - 4, 0.6, '#c9ccd0', { op: 0.28 }), wheel(x, 0, z, 6, width + 2, '#8d9297'));
  return out;
};

/** Bicycle / e-bike (front = +x): wheels, diamond frame, saddle, handlebar; cargo bikes with a box up front */
function bike(v: string, e: boolean, w: number, d: number, H: number, c: string, a: string): ModelNode {
  const cargo = v === 'cargo';
  const D = cargo ? Math.min(66, w * 0.26) : Math.min(70, w * 0.4);
  const Df = cargo ? D * 0.76 : D;
  const xr = -w / 2 + D / 2;
  const xf = w / 2 - Df / 2;
  const zr = D / 2;
  const t = e ? 4.5 : 3.4;
  const blobs: Blob[] = [...spokedWheel(xr, zr, D, 4), ...spokedWheel(xf, Df / 2, Df, 4)];
  // steering: in front of the saddle (cargo: behind the box)
  const steerX = cargo ? xf - Df / 2 - w * 0.3 : xf - Df * 0.2;
  const bb: [number, number] = [xr + (steerX - xr) * 0.45, zr - 6];
  const seat: [number, number] = [bb[0] - (H * 0.72 - bb[1]) * 0.28, H * 0.72];
  const headTop: [number, number] = [steerX - 2, H * 0.84];
  const headLow: [number, number] = [steerX + 3, H * 0.62];
  blobs.push(
    tube(xr, zr, bb[0], bb[1], t * 0.8, c),
    tube(xr, zr, seat[0], seat[1] - 4, t * 0.8, c),
    tube(bb[0], bb[1], seat[0], seat[1], t, c),
    tube(bb[0], bb[1], headLow[0], headLow[1], t * 1.1, c),
    tube(headLow[0], headLow[1], headTop[0], headTop[1], t * 1.1, c),
  );
  // top tube (sport/kids: high; city: low step-through)
  if (v === 'city' || cargo) blobs.push(tube(seat[0] + (bb[0] - seat[0]) * 0.55, seat[1] - (seat[1] - bb[1]) * 0.55, headLow[0], headLow[1] + 4, t, c));
  else blobs.push(tube(seat[0], seat[1] - 3, headTop[0], headTop[1] - 3, t, c));
  // fork / front: cargo bikes carry a box between the steering and a small front wheel
  if (cargo) {
    const bx0 = steerX + 8;
    const bx1 = xf - Df / 2 - 4;
    blobs.push(tube(bb[0], bb[1], xf, Df / 2, t, c), box(bx0, -d / 2 + 3, Df * 0.5, bx1, d / 2 - 3, Df * 0.5 + 34, tone(c, 0.1), { r: 3 }), tube(xf, Df / 2, xf - 5, Df * 0.5 + 18, t, c));
  } else blobs.push(tube(headLow[0], headLow[1], xf, Df / 2, t * 0.8, '#8d9297'));
  // saddle, handlebar with grips, crank
  blobs.push(
    tube(seat[0], seat[1], seat[0] - 1, seat[1] + 6, 2.6, '#8d9297'),
    ell(seat[0] - 3, 0, seat[1] + 8, 26, 13, 6, a),
    tube(headTop[0], headTop[1], headTop[0] - 6, H - 2, 2.8, '#2c2c2e'),
    box(headTop[0] - 8, -d * 0.45, H - 3, headTop[0] - 4, d * 0.45, H, '#2c2c2e'),
    ell(headTop[0] - 6, -d * 0.4, H - 1.5, 5, 11, 4.5, a),
    ell(headTop[0] - 6, d * 0.4, H - 1.5, 5, 11, 4.5, a),
    wheel(bb[0], -4, bb[1], 18, 1, '#8d9297'),
  );
  if (e) {
    // battery along the down tube, motor at the bottom bracket
    const f0 = 0.2;
    const f1 = 0.75;
    blobs.push(tube(bb[0] + (headLow[0] - bb[0]) * f0, bb[1] + (headLow[1] - bb[1]) * f0 + 3, bb[0] + (headLow[0] - bb[0]) * f1, bb[1] + (headLow[1] - bb[1]) * f1 + 3, 8, '#2c2c2e'), ell(bb[0], 0, bb[1], 15, 11, 14, '#3a3a3c'));
  } else if (v === 'city') blobs.push(box(xr - D * 0.3, -8, zr + D * 0.42, xr + D * 0.28, 8, zr + D * 0.42 + 2, '#2c2c2e'));
  return { blobs };
}

function scooter(v: string, w: number, d: number, H: number, c: string, a: string): ModelNode {
  const D = v === 'kick' ? 14 : 20;
  const fx = w / 2 - D / 2;
  return {
    blobs: [
      ...bikeWheel(-w / 2 + D / 2, D / 2, D, 5, '#8d9297'),
      ...bikeWheel(fx, D / 2, D, 5, '#8d9297'),
      box(-w / 2 + D * 0.6, -7, D * 0.35, fx - D * 0.4, 7, D * 0.35 + 4, c, { r: 3 }),
      tube(fx - 2, D * 0.5, fx - 8, H - 3, 4, c),
      box(fx - 10, -d * 0.45, H - 3, fx - 6, d * 0.45, H, a),
      ...(v === 'kick' ? [] : [box(-w / 2 + D * 0.7, -6, D * 0.35 + 4, -w / 2 + D * 0.7 + 22, 6, D * 0.35 + 4.4, '#3a3a3c')]),
    ],
  };
}

function motorbike(v: string, w: number, d: number, H: number, c: string, a: string): ModelNode {
  if (v === 'scooter') {
    const D = 42;
    const xr = -w / 2 + D / 2 + 4;
    const xf = w / 2 - D / 2 - 2;
    return {
      blobs: [
        ...bikeWheel(xr, D / 2, D, 11, '#8d9297'),
        ...bikeWheel(xf, D / 2, D, 10, '#8d9297'),
        ell(-w * 0.2, 0, H * 0.5, w * 0.5, d * 0.56, H * 0.42, c),
        box(-w * 0.08, -d * 0.22, D * 0.42, w * 0.2, d * 0.22, D * 0.42 + 6, tone(c, -0.05), { r: 4 }),
        ell(-w * 0.2, 0, H * 0.72, w * 0.36, d * 0.36, 12, a),
        box(w * 0.21, -d * 0.26, D * 0.4, w * 0.26, d * 0.26, H * 0.8, c, { r: 2, ry: -14 }),
        tube(xf, D / 2, w * 0.27, H - 4, 5, '#3a3a3c'),
        box(w * 0.24, -d / 2 + 4, H - 3, w * 0.28, d / 2 - 4, H, '#2c2c2e'),
        ell(w * 0.32, 0, H * 0.72, 7, 14, 10, '#f4f8ff'),
      ],
    };
  }
  const D = 62;
  const xr = -w / 2 + D / 2;
  const xf = w / 2 - D / 2;
  return {
    blobs: [
      ...bikeWheel(xr, D / 2, D, 16, '#8d9297'),
      ...bikeWheel(xf, D / 2, D, 13, '#8d9297'),
      box(-w * 0.12, -d * 0.2, 26, w * 0.14, d * 0.2, 58, '#3a3a3c', { r: 5 }),
      ell(w * 0.1, 0, 78, w * 0.3, d * 0.46, 24, c),
      ell(-w * 0.17, 0, 80, w * 0.34, d * 0.34, 11, a),
      ell(-w * 0.36, 0, 82, w * 0.2, d * 0.24, 11, c),
      tube(-w * 0.32, D / 2, -w * 0.02, 50, 6, '#3a3a3c'),
      tube(xf, D / 2, w * 0.27, H * 0.86, 5, '#8d9297', -6),
      tube(xf, D / 2, w * 0.27, H * 0.86, 5, '#8d9297', 6),
      box(w * 0.25, -d / 2 + 4, H - 3, w * 0.29, d / 2 - 4, H, '#2c2c2e'),
      ell(w * 0.33, 0, H * 0.74, 8, 17, 15, '#f4f8ff'),
      tube(-w * 0.02, 30, -w * 0.43, 44, 9, '#b8bcc1', d * 0.28),
    ],
  };
}

/** Where the charge port sits (car frame: x forward = +w/2, left = −y) */
export const chargePort = (w: number, d: number, H: number): [number, number, number] => [-w * 0.36, -d / 2 - 1, H * 0.52];

/** A car from its shape class; the front points to +x */
export function carModel(shape: CarShape, w: number, d: number, H: number, c: string, roof: string | undefined, ghost: boolean): ModelNode {
  const op = ghost ? 0.22 : undefined;
  const g = (b: Blob): Blob => (ghost ? { ...b, op, emit: false, glass: false } : b);
  const L = w;
  const W = d;
  const wheelD = Math.min(78, H * (shape.body === 'micro' ? 0.36 : shape.body === 'van' || shape.body === 'box' ? 0.4 : 0.44));
  const clear = shape.body === 'suv' || shape.body === 'box' ? 18 : 13;
  const belt = H * (shape.body === 'van' ? 0.5 : shape.body === 'box' ? 0.58 : shape.body === 'micro' ? 0.5 : 0.56);
  // greenhouse: where the cabin starts / ends along the length (fraction from the back) and how it slopes
  const prof: Record<CarShape['body'], [number, number, number, number]> = {
    // [cabin back, cabin front, roof back, roof front] as fractions of the length (0 = rear, 1 = front)
    micro: [0.05, 0.86, 0.08, 0.66],
    hatch: [0.04, 0.7, 0.1, 0.55],
    sedan: [0.14, 0.68, 0.26, 0.55],
    estate: [0.03, 0.68, 0.05, 0.55],
    suv: [0.04, 0.7, 0.08, 0.56],
    coupe: [0.1, 0.72, 0.28, 0.56],
    onebow: [0.08, 0.73, 0.32, 0.6],
    van: [0.02, 0.86, 0.03, 0.8],
    box: [0.03, 0.72, 0.04, 0.66],
  };
  const [cb, cf, rb, rf] = prof[shape.body];
  const X = (f: number) => -L / 2 + L * f;
  const glassC = '#25313b';
  const blobs: Blob[] = [];
  // lower body with soft corners, a slightly lighter shoulder line and the bumpers
  blobs.push(g(box(-L / 2, -W / 2, clear, L / 2, W / 2, belt, c, { r: Math.min(W, L) * 0.14 })));
  blobs.push(g(box(-L / 2 + 6, -W / 2 + 1, belt - 4, L / 2 - 8, W / 2 - 1, belt, tone(c, 0.05), { r: Math.min(W, L) * 0.12 })));
  // bonnet slope: a slimmer block up front
  if (shape.body !== 'van' && shape.body !== 'micro') blobs.push(g(box(X(cf) - 10, -W / 2 + 6, belt, L / 2 - 14, W / 2 - 6, belt + 4, tone(c, -0.02), { r: 18 })));
  // cabin (glass) and roof
  const roofZ = H - 3;
  blobs.push(g(box(X(cb), -W / 2 + 8, belt, X(cf), W / 2 - 8, roofZ - 1, glassC, { r: 16, glass: !ghost })));
  blobs.push(g(box(X(rb), -W / 2 + 10, roofZ - 4, X(rf), W / 2 - 10, H, roof ?? tone(c, -0.03), { r: 14 })));
  // pillars between the windows
  for (const f of [cb + 0.01, (cb + cf) / 2, cf - 0.01]) for (const y of [-W / 2 + 8, W / 2 - 10]) blobs.push(g(box(X(f) - 3, y, belt, X(f) + 3, y + 2, roofZ - 2, roof ?? c)));
  // wheels: tyre + rim
  const wx = L / 2 - Math.max(wheelD * 0.9, L * 0.17);
  for (const x of [wx, -wx]) for (const y of [-W / 2 + 12, W / 2 - 12]) {
    blobs.push(g(wheel(x, y + (y < 0 ? -2 : 2), wheelD / 2, wheelD, 22, '#1d1d1f')));
    blobs.push(g(wheel(x, y + (y < 0 ? -13.5 : 13.5), wheelD / 2, wheelD * 0.62, 1.5, '#b8bcc1')));
  }
  // lights: headlights, an EQ light band, tail lights
  blobs.push(g(box(L / 2 - 3, -W / 2 + 10, belt - 16, L / 2 + 0.5, -W / 2 + 34, belt - 9, '#f4f8ff', { emit: true })));
  blobs.push(g(box(L / 2 - 3, W / 2 - 34, belt - 16, L / 2 + 0.5, W / 2 - 10, belt - 9, '#f4f8ff', { emit: true })));
  if (shape.band) blobs.push(g(box(L / 2 - 2, -W / 2 + 34, belt - 12, L / 2 + 0.8, W / 2 - 34, belt - 10.5, '#cfe6ff', { emit: true })));
  blobs.push(g(box(-L / 2 - 0.5, -W / 2 + 10, belt - 14, -L / 2 + 2, W / 2 - 10, belt - 9, '#d8302a', { emit: true })));
  // grille and the star
  if (!shape.ev || shape.star) blobs.push(g(box(L / 2 - 2, -W * 0.2, clear + 14, L / 2 + 0.6, W * 0.2, belt - 18, shape.ev ? '#1f1f21' : '#2a2a2c', { r: 4 })));
  if (shape.star) blobs.push(g(cyl(L / 2 + 0.6, 0, belt - 22, 8, 8, 8, '#e3e6ea', { ry: 90 })));
  // mirrors
  for (const y of [-W / 2 - 6, W / 2]) blobs.push(g(box(X(cf) - 14, y, belt + 2, X(cf) - 4, y + 6, belt + 10, c, { r: 3 })));
  // charge port (EVs) on the rear left
  const port = chargePort(L, W, H);
  if (shape.ev) blobs.push(g(box(port[0] - 5, port[1] - 0.5, port[2] - 4, port[0] + 5, port[1] + 1.5, port[2] + 4, '#3a3a3c', { name: 'port' })));
  return { blobs };
}

/** Model of a garden / energy / vehicle piece, or undefined for kinds built elsewhere */
export function pieceModel(f: FurnitureConfig, opts: { ghost?: boolean; open?: number } = {}): ModelNode | undefined {
  const r = resolveFurniture(f);
  const k = r.k;
  if (!k) return undefined;
  const seed = seedOf(f.id);
  if (k.kind === 'car') {
    const shape = CARS[r.variant] ?? CARS.compact;
    return carModel(shape, f.w, f.h, r.height, r.color, f.accent ? r.accent : undefined, !!opts.ghost);
  }
  if (k.kind === 'bicycle' || k.kind === 'ebike') return bike(r.variant, k.kind === 'ebike', f.w, f.h, r.height, r.color, r.accent);
  if (k.kind === 'scooter') return scooter(r.variant, f.w, f.h, r.height, r.color, r.accent);
  if (k.kind === 'motorbike') return motorbike(r.variant, f.w, f.h, r.height, r.color, r.accent);
  return gardenModel(k.kind, r.variant, f.w, f.h, r.height, r.color, r.accent, seed, r.count, opts.open ?? 0) ?? energyModel(k.kind, r.variant, f.w, f.h, r.height, r.color, r.accent, r.count);
}

/** All primitives of a model in piece coordinates (static stand-in: only turns about the vertical axis are kept) */
export function flattenModel(n: ModelNode, at: [number, number, number] = [0, 0, 0]): Blob[] {
  const o: [number, number, number] = [at[0] + (n.at?.[0] ?? 0), at[1] + (n.at?.[1] ?? 0), at[2] + (n.at?.[2] ?? 0)];
  const rz = n.rot?.[2] ?? 0;
  const turn = (b: Blob): Blob => {
    if (!rz) return b;
    const a = (rz * Math.PI) / 180;
    return { ...b, x: b.x * Math.cos(a) - b.y * Math.sin(a), y: b.x * Math.sin(a) + b.y * Math.cos(a), rz: (b.rz ?? 0) + rz };
  };
  return [
    ...n.blobs.map((b) => {
      const t = turn(b);
      return { ...t, x: t.x + o[0], y: t.y + o[1], z: t.z + o[2] };
    }),
    ...(n.kids ?? []).flatMap((k) => flattenModel(k, [0, 0, 0]).map((b) => {
      const t = turn(b);
      return { ...t, x: t.x + o[0], y: t.y + o[1], z: t.z + o[2] };
    })),
  ];
}

// ---------- live state of model pieces ----------

type GetState = (id: string) => HassEntity | undefined;

const ON = new Set(['on', 'open', 'opening', 'true', 'heat', 'heating', 'cool', 'active', 'charging', 'running']);

/** Numeric value of an entity in a base unit (W for power, % for levels) */
export function numOf(s: HassEntity | undefined): number | undefined {
  if (!s) return undefined;
  const v = parseFloat(s.state);
  if (isNaN(v)) return undefined;
  const u = String(s.attributes.unit_of_measurement ?? '').toLowerCase();
  if (u === 'kw') return v * 1000;
  if (u === 'mw') return v * 1e6;
  return v;
}

export const isOn = (s: HassEntity | undefined) => !!s && (ON.has(s.state.toLowerCase()) || (!isNaN(parseFloat(s.state)) && parseFloat(s.state) > 0 && !String(s.attributes.unit_of_measurement ?? '').includes('%')));

/** A car is away when its location entity says so (device_tracker / person: not "home") */
export function carAway(s: HassEntity | undefined): boolean {
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return false;
  const d = s.entity_id.split('.')[0];
  if (d === 'device_tracker' || d === 'person') return s.state !== 'home';
  if (d === 'binary_sensor' || d === 'input_boolean') return s.state === 'off';
  return !['home', 'zuhause', 'daheim', 'on'].includes(s.state.toLowerCase());
}

/** Charging from a status entity: binary on/off, or a text like "charging" (numbers are not trusted) */
export function chargingState(s: HassEntity): boolean {
  const v = s.state.toLowerCase();
  if (s.entity_id.startsWith('binary_sensor.') || s.entity_id.startsWith('switch.') || s.entity_id.startsWith('input_boolean.')) return v === 'on';
  if (/not|nicht|kein|disconn|complete|beendet|finished|stopped|idle/.test(v)) return false;
  return /charging|lädt|laden|ladevorgang/.test(v);
}

export interface CarLive {
  soc?: number;
  range?: number;
  charging: boolean;
  away: boolean;
  low: boolean;
  where?: string;
  power?: number;
}

export function carLive(f: FurnitureConfig, getState: GetState): CarLive {
  const e = f.entities ?? {};
  const soc = numOf(f.entity ? getState(f.entity) : undefined);
  const ch = e.charging ? getState(e.charging) : undefined;
  // a "limit" sensor is the maximum charging power, never the current one
  const power = e.power && !/limit|max/i.test(e.power) ? numOf(getState(e.power)) : undefined;
  // a charging status entity decides on its own; the power only when there is none
  const charging = ch ? chargingState(ch) : (power ?? 0) > 50;
  const loc = e.location ? getState(e.location) : undefined;
  const away = carAway(loc);
  const addr = e.address ? getState(e.address) : undefined;
  const where = addr && addr.state !== 'unknown' && addr.state !== 'unavailable' ? addr.state : (loc?.attributes.address as string | undefined) ?? (away && loc && loc.state !== 'not_home' ? loc.state : undefined);
  return { soc, range: numOf(e.range ? getState(e.range) : undefined), charging, away, low: soc != null && soc <= (f.low ?? 15), where, power };
}

/**
 * Discrete look of a model piece: when this changes the piece is rebuilt; continuous values (power,
 * state of charge) are read by its animation every frame.
 */
export function liveClass(f: FurnitureConfig, getState: GetState): string {
  const r = resolveFurniture(f);
  const s = f.entity ? getState(f.entity) : undefined;
  switch (r.k?.kind) {
    case 'car': {
      const c = carLive(f, getState);
      return `car:${c.away ? 1 : 0}${c.charging ? 1 : 0}${c.low ? 1 : 0}`;
    }
    case 'lawn_mower':
      return `mower:${s?.state ?? '-'}`;
    case 'home_battery': {
      const soc = numOf(s);
      return `bat:${soc == null ? '-' : Math.ceil(soc / 20)}`;
    }
    case 'solar_panels':
      return `pv:${(numOf(s) ?? 0) > 5 ? 1 : 0}`;
    case 'wallbox':
      return `wb:${s?.state ?? '-'}`;
    case 'gate':
    case 'garage_door': {
      const c = coverLive(s);
      return `cover:${c.state}:${c.open.toFixed(2)}:${c.moving ?? ''}`;
    }
  }
  return `${s ? (isOn(s) ? 'on' : s.state) : '-'}`;
}
