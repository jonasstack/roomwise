import type { FloorConfig, OpeningConfig, Point, RoomConfig } from './types';
import { closestPointOnSegment, pointInPolygon } from './geometry';

export interface WallPiece {
  a: Point;
  b: Point;
  kind: 'wall' | 'window' | 'door' | 'garage';
  opening?: OpeningConfig;
  /** Unit normal pointing to the outside (no room) if this is an exterior wall, else undefined */
  outward?: Point;
  /** Room on the side of the local normal (−dy, dx) of a→b, and on the opposite side */
  front?: RoomConfig;
  back?: RoomConfig;
  /**
   * The wall ends inside a door/window opening of another wall (a room corner placed in the opening): it stops at
   * that wall's face instead of reaching into the passage (renderers shorten it by half a wall thickness there)
   */
  stopA?: boolean;
  stopB?: boolean;
}

const EPS = 0.5;
const key = (p: Point) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;

/**
 * Unique wall segments of a floor: room edges split at every vertex lying on them, deduplicated
 * (shared walls appear once), and cut into wall / window / door pieces by the openings.
 */
export function wallPieces(floor: FloorConfig): WallPiece[] {
  // outdoor areas (garden, terrace, driveway) have no walls
  const rooms = floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
  const vertices = rooms.flatMap((r) => r.points);
  const segs = new Map<string, [Point, Point]>();
  for (const r of rooms)
    for (let i = 0; i < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[(i + 1) % r.points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < EPS) continue;
      // split at vertices lying on this edge
      const ts = [0, 1];
      for (const v of vertices) {
        const c = closestPointOnSegment(v, a, b);
        if (c.dist < EPS && c.t > 0.001 && c.t < 0.999) ts.push(c.t);
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k < ts.length - 1; k++) {
        if (ts[k + 1] - ts[k] < 1e-4) continue;
        const p: Point = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
        const q: Point = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
        const id = [key(p), key(q)].sort().join('|');
        if (!segs.has(id)) segs.set(id, [p, q]);
      }
    }

  const roomAt = (p: Point) => rooms.find((r) => pointInPolygon(p, r.points));
  const out: WallPiece[] = [];
  for (const [a, b] of segs.values()) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n: Point = [-dir[1], dir[0]];
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const front = roomAt([mid[0] + n[0] * 3, mid[1] + n[1] * 3]);
    const back = roomAt([mid[0] - n[0] * 3, mid[1] - n[1] * 3]);
    const inA = !!front;
    const inB = !!back;
    const outward: Point | undefined = inA && !inB ? [-n[0], -n[1]] : !inA && inB ? n : undefined;

    // Openings on this segment as intervals along it
    const cuts: { s: number; e: number; o: OpeningConfig }[] = [];
    for (const o of floor.openings ?? []) {
      const ca = closestPointOnSegment(o.a, a, b);
      const cb = closestPointOnSegment(o.b, a, b);
      // Both endpoints on the wall's line (allow endpoints beyond this split segment)
      const lineDist = (p: Point) => Math.abs((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]);
      if (lineDist(o.a) > 2 || lineDist(o.b) > 2) continue;
      const sa = (o.a[0] - a[0]) * dir[0] + (o.a[1] - a[1]) * dir[1];
      const sb = (o.b[0] - a[0]) * dir[0] + (o.b[1] - a[1]) * dir[1];
      const s = Math.max(0, Math.min(sa, sb));
      const e = Math.min(len, Math.max(sa, sb));
      if (e - s > 1 && (ca.dist < len || cb.dist < len)) cuts.push({ s, e, o });
    }
    cuts.sort((x, y) => x.s - y.s);
    let pos = 0;
    const at = (s: number): Point => [a[0] + dir[0] * s, a[1] + dir[1] * s];
    for (const c of cuts) {
      if (c.s > pos + EPS) out.push({ a: at(pos), b: at(c.s), kind: 'wall', outward, front, back });
      out.push({ a: at(c.s), b: at(c.e), kind: c.o.type, opening: c.o, outward, front, back });
      pos = Math.max(pos, c.e);
    }
    if (len > pos + EPS) out.push({ a: at(pos), b: at(len), kind: 'wall', outward, front, back });
  }
  // An opening across a split point of its wall (another room's corner inside it) comes as one piece per wall
  // segment: join them, so frame, leaf and lintel are drawn once over the whole opening (no jambs in the middle)
  const merged: WallPiece[] = [];
  const byOpening = new Map<OpeningConfig, WallPiece>();
  for (const p of out) {
    const first = p.opening && p.kind !== 'wall' ? byOpening.get(p.opening) : undefined;
    if (!first) {
      if (p.opening && p.kind !== 'wall') byOpening.set(p.opening, p);
      merged.push(p);
      continue;
    }
    const dir: Point = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
    const along = (q: Point) => (q[0] - first.a[0]) * dir[0] + (q[1] - first.a[1]) * dir[1];
    const pts = [first.a, first.b, p.a, p.b].sort((x, y) => along(x) - along(y));
    first.a = pts[0];
    first.b = pts[3];
  }
  // walls ending inside an opening of another wall
  const spans = merged.filter((p) => p.kind !== 'wall');
  const inOpening = (q: Point, self: WallPiece) =>
    spans.some((s) => {
      const c = closestPointOnSegment(q, s.a, s.b);
      if (c.dist > 2 || c.t < 0.02 || c.t > 0.98) return false;
      // not a continuation of the same wall line
      const sx = s.b[0] - s.a[0], sy = s.b[1] - s.a[1];
      const wx = self.b[0] - self.a[0], wy = self.b[1] - self.a[1];
      return Math.abs(sx * wy - sy * wx) / ((Math.hypot(sx, sy) || 1) * (Math.hypot(wx, wy) || 1)) > 0.2;
    });
  for (const p of merged) {
    if (p.kind !== 'wall') continue;
    if (inOpening(p.a, p)) p.stopA = true;
    if (inOpening(p.b, p)) p.stopB = true;
  }
  return merged;
}

/**
 * Length and centre of a wall piece's body: half a wall thickness past each end (corners close), but stopping
 * at the face of a wall whose opening it ends in.
 */
export function wallBody(p: WallPiece, wall: number): { len: number; mid: Point } {
  const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) || 1;
  const ea = p.stopA ? -wall / 2 : wall / 2;
  const eb = p.stopB ? -wall / 2 : wall / 2;
  const k = (eb - ea) / 2 / len;
  return { len: Math.max(0.5, len + ea + eb), mid: [(p.a[0] + p.b[0]) / 2 + (p.b[0] - p.a[0]) * k, (p.a[1] + p.b[1]) / 2 + (p.b[1] - p.a[1]) * k] };
}

/** Room-side unit normal of a window (pointing into the building), or undefined for interior windows. */
export function windowInward(o: OpeningConfig, floor: FloorConfig): Point | undefined {
  const dx = o.b[0] - o.a[0];
  const dy = o.b[1] - o.a[1];
  const len = Math.hypot(dx, dy) || 1;
  const n: Point = [-dy / len, dx / len];
  const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
  const inside = (p: Point) => floor.rooms.some((r) => r.points.length >= 3 && !r.outdoor && pointInPolygon(p, r.points));
  const a = inside([mid[0] + n[0] * 6, mid[1] + n[1] * 6]);
  const b = inside([mid[0] - n[0] * 6, mid[1] - n[1] * 6]);
  if (a && !b) return n;
  if (b && !a) return [-n[0], -n[1]];
  return undefined;
}
