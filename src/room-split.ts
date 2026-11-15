/**
 * "Raum teilen" and "Räume zusammenlegen": cut a room's outline along a line into two rooms (an open kitchen in the
 * living room: with or without a wall between), and join two neighbouring rooms into one. Pure geometry on the
 * outlines (plan units, cm); the editor turns the result into rooms, a passage on the cut, and undo.
 */
import { closestPointOnSegment, pointInPolygon, polygonArea, round } from './geometry';
import type { Point } from './types';

const EPS = 0.5;
const same = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < EPS;
const r2 = (p: Point): Point => [round(p[0]), round(p[1])];

/** Where segment p→q crosses segment a→b: the parameters along both (0..1), or undefined */
function cross(p: Point, q: Point, a: Point, b: Point): { s: number; t: number } | undefined {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return undefined;
  const s = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / den;
  const t = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / den;
  return s >= -1e-9 && s <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9 ? { s, t } : undefined;
}

/** Drops corners lying on the straight line between their neighbours (and repeated corners) */
export function cleanOutline(pts: Point[]): Point[] {
  let out = pts.filter((p, i) => !same(p, pts[(i + 1) % pts.length]));
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      if (closestPointOnSegment(b, a, c).dist < 0.05) {
        out = out.filter((_p, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export type SplitResult =
  | { ok: true; pieces: [Point[], Point[]]; chord: [Point, Point] }
  | { ok: false; reason: 'through' | 'small' };

/**
 * Cuts an outline along the line a→b. The line has to go right through the room: it crosses the outline exactly
 * twice (ends on a wall or beyond it – a few cm short of the wall still count). L-shapes, slanted walls fine.
 * pieces[0] is the larger part.
 */
export function splitOutline(points: Point[], a: Point, b: Point): SplitResult {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 5) return { ok: false, reason: 'through' };
  // a little longer at both ends: a line drawn onto the wall (snapped) still counts as reaching it
  const ext = 6;
  const d: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const p: Point = [a[0] - d[0] * ext, a[1] - d[1] * ext];
  const q: Point = [b[0] + d[0] * ext, b[1] + d[1] * ext];
  const hits: { s: number; edge: number; at: Point }[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const e0 = points[i];
    const e1 = points[(i + 1) % n];
    const c = cross(p, q, e0, e1);
    if (!c) continue;
    const at: Point = [e0[0] + (e1[0] - e0[0]) * c.t, e0[1] + (e1[1] - e0[1]) * c.t];
    // a corner is hit by both of its edges: count it once
    if (hits.some((h) => same(h.at, at))) continue;
    hits.push({ s: c.s, edge: i, at });
  }
  if (hits.length !== 2) return { ok: false, reason: 'through' };
  hits.sort((x, y) => x.s - y.s);
  const [h0, h1] = hits;
  // the chord has to run inside the room (a line along a wall or outside it cuts nothing)
  const mid: Point = [(h0.at[0] + h1.at[0]) / 2, (h0.at[1] + h1.at[1]) / 2];
  if (!pointInPolygon(mid, points)) return { ok: false, reason: 'through' };
  const P = r2(h0.at);
  const Q = r2(h1.at);
  // walk the outline: from P along the corners to Q, and from Q on to P
  const walk = (i: number, j: number, start: Point, end: Point) => {
    const out: Point[] = [start];
    const count = (j - i + n) % n;
    for (let c = 0, k = (i + 1) % n; c < count; c++, k = (k + 1) % n) out.push(points[k]);
    out.push(end);
    return cleanOutline(out);
  };
  let one: Point[];
  let two: Point[];
  if (h0.edge === h1.edge) return { ok: false, reason: 'through' };
  one = walk(h0.edge, h1.edge, P, Q);
  two = walk(h1.edge, h0.edge, Q, P);
  if (one.length < 3 || two.length < 3) return { ok: false, reason: 'through' };
  const aOne = Math.abs(polygonArea(one));
  const aTwo = Math.abs(polygonArea(two));
  // a sliver is not a room: less than about 30 cm deep on average along the cut
  const chordLen = Math.hypot(Q[0] - P[0], Q[1] - P[1]) || 1;
  if (Math.min(aOne, aTwo) < 900 || Math.min(aOne, aTwo) / chordLen < 30) return { ok: false, reason: 'small' };
  if (aTwo > aOne) [one, two] = [two, one];
  return { ok: true, pieces: [one, two], chord: [P, Q] };
}

/** The outline split at every corner of `other` lying on its edges (so shared stretches have the same corners) */
function withCornersOf(pts: Point[], other: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const on = other
      .map((v) => ({ v, c: closestPointOnSegment(v, a, b) }))
      .filter(({ v, c }) => c.dist < EPS && c.t > 0.001 && c.t < 0.999 && !same(v, a) && !same(v, b))
      .sort((x, y) => x.c.t - y.c.t);
    for (const { c } of on) if (!out.some((p) => same(p, c.point))) out.push(c.point);
  }
  return out;
}

const ccw = (pts: Point[]) => (polygonArea(pts) < 0 ? [...pts].reverse() : pts);

/**
 * Joins two outlines that share a stretch of wall into one. Undefined when they do not touch along a wall or the
 * result would not be one simple outline (touching only at a corner, a ring around a hole …).
 */
export function mergeOutlines(a: Point[], b: Point[]): { outline: Point[]; shared: [Point, Point][] } | undefined {
  const A = ccw(withCornersOf(a, b));
  const B = ccw(withCornersOf(b, a));
  const edges = (pts: Point[]) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as [Point, Point]);
  const ea = edges(A);
  const eb = edges(B);
  // with both outlines the same way round, a shared stretch runs in opposite directions
  const sharedA = ea.filter(([p, q]) => eb.some(([u, v]) => same(p, v) && same(q, u)));
  if (!sharedA.length) return undefined;
  const isShared = (p: Point, q: Point) => sharedA.some(([u, v]) => (same(u, p) && same(v, q)) || (same(u, q) && same(v, p)));
  const rest = [...ea, ...eb].filter(([p, q]) => !isShared(p, q));
  if (rest.length < 3) return undefined;
  // chain the rest into one loop; a corner may only be passed once
  const loop: Point[] = [rest[0][0]];
  let cur = rest[0];
  const used = new Set<number>([0]);
  for (let k = 0; k < rest.length; k++) {
    const nextIdx = rest.findIndex(([p], i) => !used.has(i) && same(p, cur[1]));
    if (nextIdx < 0) break;
    if (same(rest[nextIdx][0], loop[0]) && used.size < rest.length) {
      // back at the start too early: more than one loop
      return undefined;
    }
    used.add(nextIdx);
    cur = rest[nextIdx];
    loop.push(cur[0]);
  }
  if (used.size !== rest.length || !same(cur[1], loop[0])) return undefined;
  const outline = cleanOutline(loop.map(r2));
  if (outline.length < 3) return undefined;
  // a corner visited twice: two outlines touching at a point, not one simple room
  for (let i = 0; i < outline.length; i++) for (let j = i + 1; j < outline.length; j++) if (same(outline[i], outline[j])) return undefined;
  const area = Math.abs(polygonArea(outline));
  if (Math.abs(area - (Math.abs(polygonArea(a)) + Math.abs(polygonArea(b)))) > Math.max(50, area * 0.01)) return undefined;
  return { outline, shared: sharedA.map(([p, q]) => [r2(p), r2(q)] as [Point, Point]) };
}
