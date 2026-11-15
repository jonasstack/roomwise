import type { FloorConfig, HassEntity, Point } from './types';
import { resolveFurniture } from './furniture';
import { closestPointOnSegment, pointInPolygon } from './geometry';
import { wallPieces } from './walls';
import { openingState } from './openings';

/**
 * Where a pet can walk: a grid over the home (indoor rooms) where walls, windows, furniture and closed doors
 * block, plus A* path finding with smoothed (string-pulled) paths.
 */
export interface NavGrid {
  cell: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  free: Uint8Array;
  /** distance to the nearest blocked cell (in cells, chamfer metric) */
  clear: Float32Array;
  key: string;
}

/** Pieces a dog walks over or under (or that hang on the wall / stand on counters) */
const PASSABLE = new Set(['rug', 'pet_bed', 'food_bowls', 'dog', 'cat', 'light_strip', 'robot_vacuum', 'robot_dock', 'smart_plug', 'sensor', 'remote']);

const cache = new Map<string, NavGrid>();

export function navKey(floor: FloorConfig, getState: (id: string) => HassEntity | undefined, allowClosed: boolean): string {
  const doors = (floor.openings ?? []).filter((o) => o.type === 'door' && o.entity).map((o) => openingState(getState(o.entity!)));
  return `${floor.id}|${allowClosed ? 1 : 0}|${doors.join(',')}`;
}

export function buildNav(floor: FloorConfig, getState: (id: string) => HassEntity | undefined, allowClosed: boolean, radius = 16, furniture = true): NavGrid | undefined {
  const key = `${navKey(floor, getState, allowClosed)}|${radius}|${furniture ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && (hit as any).floor === floor) return hit;
  const rooms = floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
  if (!rooms.length) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rooms)
    for (const [x, y] of r.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const cell = 12;
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const ny = Math.ceil((maxY - minY) / cell) + 1;
  // walls and windows always block; doors when closed (unless allowed)
  const blockers: [Point, Point, number][] = [];
  for (const p of wallPieces(floor)) {
    if (p.kind === 'door') {
      const st = p.opening?.entity ? openingState(getState(p.opening.entity)) : 'open';
      if (allowClosed || st !== 'closed') continue;
    }
    blockers.push([p.a, p.b, radius + 4]);
  }
  // furniture footprints (rotated rectangles) grown by the pet's radius
  const solids: { c: Point; ax: Point; ay: Point; hw: number; hh: number }[] = [];
  for (const f of furniture ? (floor.furniture ?? []) : []) {
    const r = resolveFurniture(f);
    const kind = r.k?.kind ?? '';
    if (PASSABLE.has(kind) || r.k?.onTop || r.ceiling || r.elevation >= 45 || r.k?.cat === 'garden' || r.k?.cat === 'vehicle') continue;
    const a = ((f.rotation ?? 0) * Math.PI) / 180;
    solids.push({ c: [f.x, f.y], ax: [Math.cos(a), Math.sin(a)], ay: [-Math.sin(a), Math.cos(a)], hw: f.w / 2 + radius, hh: f.h / 2 + radius });
  }
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p: Point = [minX + i * cell, minY + j * cell];
      if (!rooms.some((r) => pointInPolygon(p, r.points))) continue;
      if (blockers.some(([a, b, d]) => closestPointOnSegment(p, a, b).dist < d)) continue;
      if (
        solids.some((s) => {
          const dx = p[0] - s.c[0];
          const dy = p[1] - s.c[1];
          return Math.abs(dx * s.ax[0] + dy * s.ax[1]) < s.hw && Math.abs(dx * s.ay[0] + dy * s.ay[1]) < s.hh;
        })
      )
        continue;
      free[j * nx + i] = 1;
    }
  const grid: NavGrid = { cell, x0: minX, y0: minY, nx, ny, free, clear: distanceField(free, nx, ny), key };
  (grid as any).floor = floor;
  if (cache.size > 6) cache.clear();
  cache.set(key, grid);
  return grid;
}

/** Two-pass chamfer distance (in cells) from every free cell to the nearest blocked one */
function distanceField(free: Uint8Array, nx: number, ny: number): Float32Array {
  const d = new Float32Array(nx * ny);
  const BIG = 1e6;
  for (let k = 0; k < d.length; k++) d[k] = free[k] ? BIG : 0;
  const D = Math.SQRT2;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      else v = Math.min(v, 1);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + 1);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + D);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + D);
      } else v = Math.min(v, 1);
      d[k] = v;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + 1] + 1);
      else v = Math.min(v, 1);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + 1);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + D);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + D);
      } else v = Math.min(v, 1);
      d[k] = v;
    }
  return d;
}

const idxOf = (g: NavGrid, p: Point) => {
  const i = Math.round((p[0] - g.x0) / g.cell);
  const j = Math.round((p[1] - g.y0) / g.cell);
  return i < 0 || j < 0 || i >= g.nx || j >= g.ny ? -1 : j * g.nx + i;
};
const pointOf = (g: NavGrid, k: number): Point => [g.x0 + (k % g.nx) * g.cell, g.y0 + Math.floor(k / g.nx) * g.cell];

/** Nearest walkable cell to a point (with at least `room` cells of free space around it, if possible) */
export function nearestFree(g: NavGrid, p: Point, maxR = 120, room = 0): Point | undefined {
  const k = idxOf(g, p);
  if (k >= 0 && g.free[k] && g.clear[k] >= room) return pointOf(g, k);
  const ci = Math.round((p[0] - g.x0) / g.cell);
  const cj = Math.round((p[1] - g.y0) / g.cell);
  const steps = Math.ceil(maxR / g.cell);
  let best: Point | undefined;
  let bd = Infinity;
  for (let dj = -steps; dj <= steps; dj++)
    for (let di = -steps; di <= steps; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny || !g.free[j * g.nx + i] || g.clear[j * g.nx + i] < room) continue;
      const d = di * di + dj * dj;
      if (d < bd) {
        bd = d;
        best = pointOf(g, j * g.nx + i);
      }
    }
  return best;
}

/** Free space around a plan point (cm) — 0 where the pet cannot stand */
export function clearance(g: NavGrid, p: Point): number {
  const k = idxOf(g, p);
  return k < 0 ? 0 : g.clear[k] * g.cell;
}

/** Straight line over walkable cells that keep a margin from obstacles (shortcuts never hug corners) */
function lineFree(g: NavGrid, a: Point, b: Point, margin = 1.5): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / (g.cell * 0.34)));
  for (let s = 0; s <= n; s++) {
    const k = idxOf(g, [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    if (k < 0 || !g.free[k]) return false;
    // the ends may sit close to things (that is where the pet starts / wants to be)
    if (s > 1 && s < n - 1 && g.clear[k] < margin) return false;
  }
  return true;
}

/** A* over the grid (8 neighbours), smoothed; undefined when unreachable */
export function findPath(g: NavGrid, from: Point, to: Point): Point[] | undefined {
  const s = nearestFree(g, from);
  const t = nearestFree(g, to);
  if (!s || !t) return undefined;
  const sk = idxOf(g, s);
  const tk = idxOf(g, t);
  const N = g.nx * g.ny;
  const gs = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open: number[] = [sk];
  const fs = new Float32Array(N).fill(Infinity);
  const h = (k: number) => Math.hypot((k % g.nx) - (tk % g.nx), Math.floor(k / g.nx) - Math.floor(tk / g.nx));
  gs[sk] = 0;
  fs[sk] = h(sk);
  const nb = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  let guard = 0;
  while (open.length && guard++ < 60000) {
    // small grids: a linear scan for the best node is fast enough
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fs[open[i]] < fs[open[bi]]) bi = i;
    const k = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (k === tk) break;
    if (closed[k]) continue;
    closed[k] = 1;
    const ki = k % g.nx;
    const kj = Math.floor(k / g.nx);
    for (const [di, dj, c] of nb) {
      const i = ki + di;
      const j = kj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const n = j * g.nx + i;
      if (!g.free[n] || closed[n]) continue;
      // no corner cutting
      if (di && dj && (!g.free[kj * g.nx + i] || !g.free[j * g.nx + ki])) continue;
      // paths prefer the middle of the free space (away from furniture and walls)
      const near = Math.max(0, 3 - g.clear[n]);
      const ng = gs[k] + c * (1 + near * near * 0.6);
      if (ng < gs[n]) {
        gs[n] = ng;
        fs[n] = ng + h(n);
        came[n] = k;
        open.push(n);
      }
    }
  }
  if (came[tk] < 0 && tk !== sk) return undefined;
  const raw: Point[] = [];
  for (let k = tk; k >= 0; k = came[k]) {
    raw.unshift(pointOf(g, k));
    if (k === sk) break;
  }
  // string pulling: keep only the corners that are needed
  const out: Point[] = [from];
  let anchor: Point = from;
  for (let i = 1; i < raw.length; i++) {
    if (!lineFree(g, anchor, raw[i], 1.5)) {
      anchor = raw[i - 1];
      out.push(anchor);
    }
  }
  out.push(to && lineFree(g, raw[raw.length - 1], to) ? to : raw[raw.length - 1]);
  return out;
}

/** A random walkable spot in open space (deterministic per seed), preferably at least `min` away from `from` */
export function randomSpot(g: NavGrid, seed: number, from?: Point, min = 120, room = 2.5): Point | undefined {
  let free: number[] = [];
  for (let k = 0; k < g.free.length; k++) if (g.free[k] && g.clear[k] >= room) free.push(k);
  if (!free.length) for (let k = 0; k < g.free.length; k++) if (g.free[k]) free.push(k);
  if (!free.length) return undefined;
  for (let tries = 0; tries < 12; tries++) {
    const x = Math.sin(seed * 12.9898 + tries * 78.233) * 43758.5453;
    const p = pointOf(g, free[Math.floor((x - Math.floor(x)) * free.length)]);
    if (!from || Math.hypot(p[0] - from[0], p[1] - from[1]) >= min) return p;
  }
  return pointOf(g, free[0]);
}
