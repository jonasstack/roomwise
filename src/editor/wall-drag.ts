import { round, snapDrag, type SnapResult } from '../geometry';
import type { FloorConfig, Point } from '../types';

/** One corner of one room */
export interface CornerRef {
  room: string;
  index: number;
}

/** Corners closer than this (cm) are the same corner (rooms drawn against each other, a plan from a vacuum's map) */
const SAME = 0.5;
/** A point this close (cm) to a wall's line lies on it */
const ON_LINE = 1;

/**
 * The corner being dragged and – `linked` – the corners of other rooms sitting on the same spot: they move together,
 * so rooms that meet there stay joined (no gap, no overlap).
 */
export function sharedCorners(floor: FloorConfig, roomId: string, index: number, linked: boolean): CornerRef[] {
  const room = floor.rooms.find((r) => r.id === roomId);
  const p = room?.points[index];
  if (!room || !p) return [];
  const out: CornerRef[] = [{ room: roomId, index }];
  if (!linked) return out;
  for (const r of floor.rooms) {
    if (r.id === roomId) continue;
    r.points.forEach((q, i) => {
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < SAME) out.push({ room: r.id, index: i });
    });
  }
  return out;
}

/** A wall being dragged: everything that moves with it along its normal */
export interface EdgeMove {
  /** unit normal of the wall */
  nrm: Point;
  /** the dragged edge's ends (before the move) */
  a: Point;
  b: Point;
  /** corners that move: the dragged edge's ends and – linked – those of other rooms' edges on the same wall */
  corners: CornerRef[];
  /** doors / windows on that wall (by index in floor.openings) */
  openings: number[];
}

/**
 * Dragging a wall (an edge of a room) – `linked`: edges of other rooms that lie on the same line and overlap it (a
 * wall two rooms share, also only partly) move with it, and so on along that wall; edges that only touch it at an
 * end (the next room along the same façade) stay. Doors and windows on the moved part go along.
 */
export function edgeMove(floor: FloorConfig, roomId: string, edge: number, linked: boolean): EdgeMove | undefined {
  const room = floor.rooms.find((r) => r.id === roomId);
  if (!room || room.points.length < 3) return undefined;
  const a = room.points[edge];
  const b = room.points[(edge + 1) % room.points.length];
  if (!a || !b) return undefined;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1) return undefined;
  const u: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const nrm: Point = [-u[1], u[0]];
  const off = (q: Point) => (q[0] - a[0]) * nrm[0] + (q[1] - a[1]) * nrm[1];
  const along = (q: Point) => (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1];
  const spans: [number, number][] = [[0, len]];
  const taken = new Set<string>([`${roomId}:${edge}`]);
  if (linked) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of floor.rooms) {
        for (let j = 0; j < r.points.length; j++) {
          const key = `${r.id}:${j}`;
          if (taken.has(key)) continue;
          const p = r.points[j];
          const q = r.points[(j + 1) % r.points.length];
          if (Math.abs(off(p)) > ON_LINE || Math.abs(off(q)) > ON_LINE) continue;
          const t0 = Math.min(along(p), along(q));
          const t1 = Math.max(along(p), along(q));
          // overlapping (more than a touch at one end)
          if (!spans.some(([s0, s1]) => Math.min(s1, t1) - Math.max(s0, t0) > ON_LINE)) continue;
          taken.add(key);
          spans.push([t0, t1]);
          grew = true;
        }
      }
    }
  }
  const corners: CornerRef[] = [];
  const seen = new Set<string>();
  for (const key of taken) {
    const [rid, js] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
    const r = floor.rooms.find((x) => x.id === rid)!;
    for (const i of [js, (js + 1) % r.points.length]) {
      const k = `${rid}:${i}`;
      if (seen.has(k)) continue;
      seen.add(k);
      corners.push({ room: rid, index: i });
    }
  }
  const lo = Math.min(...spans.map((s) => s[0])) - ON_LINE;
  const hi = Math.max(...spans.map((s) => s[1])) + ON_LINE;
  const inside = (q: Point) => Math.abs(off(q)) <= ON_LINE && along(q) >= lo && along(q) <= hi;
  const openings: number[] = [];
  (floor.openings ?? []).forEach((o, i) => {
    if (inside(o.a) && inside(o.b)) openings.push(i);
  });
  return { nrm, a, b, corners, openings };
}

/** Moves the wall by `delta` along its normal (on the given draft floor, as it was when the drag began) */
export function applyEdgeMove(floor: FloorConfig, mv: EdgeMove, delta: number) {
  const sh = (p: Point): Point => [round(p[0] + mv.nrm[0] * delta, 1), round(p[1] + mv.nrm[1] * delta, 1)];
  for (const c of mv.corners) {
    const r = floor.rooms.find((x) => x.id === c.room);
    if (r?.points[c.index]) r.points[c.index] = sh(r.points[c.index]);
  }
  for (const i of mv.openings) {
    const o = floor.openings?.[i];
    if (!o) continue;
    o.a = sh(o.a);
    o.b = sh(o.b);
  }
}

/**
 * Where the dragged wall goes: the finger's move along the normal, snapped onto the line of a corner that is not
 * moving (another room's corner, a wall's end), else – grid on and the wall along x or y – onto the grid.
 * Returns the move and helper lines for what it lines up with.
 */
export function snapEdge(floor: FloorConfig, mv: EdgeMove, raw: number, opts: { tolerance: number; grid?: number; snapGrid: boolean; snapGeometry: boolean; extra?: Point[] }): { delta: number; snap: SnapResult } {
  const moving = new Set(mv.corners.map((c) => `${c.room}:${c.index}`));
  const anchors: Point[] = [...(opts.extra ?? [])];
  for (const r of floor.rooms) r.points.forEach((p, i) => !moving.has(`${r.id}:${i}`) && anchors.push(p));
  const off = (q: Point) => (q[0] - mv.a[0]) * mv.nrm[0] + (q[1] - mv.a[1]) * mv.nrm[1];
  const mid = (d: number): Point => [(mv.a[0] + mv.b[0]) / 2 + mv.nrm[0] * d, (mv.a[1] + mv.b[1]) / 2 + mv.nrm[1] * d];
  if (opts.snapGeometry) {
    let best: Point | null = null;
    let bestD = opts.tolerance;
    for (const q of anchors) {
      const d = Math.abs(off(q) - raw);
      if (d < bestD - 1e-9) {
        bestD = d;
        best = q;
      }
    }
    if (best) {
      const delta = off(best);
      // helper line: along the wall's line to the corner it lines up with
      const a2: Point = [mv.a[0] + mv.nrm[0] * delta, mv.a[1] + mv.nrm[1] * delta];
      const b2: Point = [mv.b[0] + mv.nrm[0] * delta, mv.b[1] + mv.nrm[1] * delta];
      const end = Math.hypot(best[0] - a2[0], best[1] - a2[1]) < Math.hypot(best[0] - b2[0], best[1] - b2[1]) ? a2 : b2;
      return { delta: round(delta, 1), snap: { point: mid(delta), kind: 'align', guides: [[best, end]] } };
    }
  }
  const axis = Math.abs(mv.nrm[0]) < 1e-6 || Math.abs(mv.nrm[1]) < 1e-6;
  if (opts.snapGrid && opts.grid && opts.grid > 0 && axis) {
    const base = mv.a[0] * mv.nrm[0] + mv.a[1] * mv.nrm[1];
    const sign = mv.nrm[0] + mv.nrm[1] > 0 ? 1 : -1;
    const abs = (base + raw) * sign;
    const delta = Math.round(abs / opts.grid) * opts.grid * sign - base;
    return { delta, snap: { point: mid(delta), kind: 'grid' } };
  }
  return { delta: round(raw, 1), snap: { point: mid(raw), kind: 'none' } };
}

/**
 * Where a dragged corner goes (snapDrag): onto corners and walls that are not moving, in line with other corners
 * and with the room's own neighbouring corners (keeps walls straight and square), the grid only when nothing is near.
 */
export function snapCorner(floor: FloorConfig, moving: CornerRef[], p: Point, opts: { tolerance: number; grid?: number; snapGrid: boolean; snapGeometry: boolean; ghost?: Point[][] }): SnapResult {
  const mv = new Set(moving.map((c) => `${c.room}:${c.index}`));
  // the walls that stay as they are (each one on its own: a wall at a moving corner moves too) and their corners
  const polys: Point[][] = [];
  const anchors: Point[] = [];
  for (const r of floor.rooms) {
    const n = r.points.length;
    r.points.forEach((p, i) => {
      if (mv.has(`${r.id}:${i}`)) return;
      anchors.push(p);
      const j = (i + 1) % n;
      if (n >= 2 && !mv.has(`${r.id}:${j}`)) polys.push([p, r.points[j]]);
      else polys.push([p]);
    });
  }
  for (const g of opts.ghost ?? []) {
    polys.push(g);
    anchors.push(...g);
  }
  return snapDrag(p, polys, anchors, { tolerance: opts.tolerance, grid: opts.grid, snapGrid: opts.snapGrid, snapGeometry: opts.snapGeometry });
}
