import type { Bounds, FloorConfig, Point } from './types';

export function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

export function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function boundsOf(points: Point[], into?: Bounds): Bounds {
  const b = into ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

export function floorBounds(floor: FloorConfig | undefined): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  if (floor) {
    for (const r of floor.rooms) boundsOf(r.points, b);
    for (const d of floor.devices) boundsOf([[d.x, d.y]], b);
  }
  if (!isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 700 };
  if (b.maxX - b.minX < 100) b.maxX = b.minX + 100;
  if (b.maxY - b.minY < 100) b.maxY = b.minY + 100;
  return b;
}

/** Bounds of the building (indoor rooms); falls back to the whole floor without indoor rooms */
export function buildingBounds(floor: FloorConfig | undefined): Bounds {
  const indoor = floor?.rooms.filter((r) => r.points.length >= 3 && !r.outdoor) ?? [];
  if (!floor || !indoor.length || indoor.length === floor.rooms.length) return floorBounds(floor);
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of indoor) boundsOf(r.points, b);
  return b;
}

export function closestPointOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number; dist: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

function segDistSq(px: number, py: number, a: Point, b: Point): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

function signedDistToPolygon(x: number, y: number, pts: Point[]): number {
  let minSq = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) minSq = Math.min(minSq, segDistSq(x, y, pts[i], pts[j]));
  return (pointInPolygon([x, y], pts) ? 1 : -1) * Math.sqrt(minSq);
}

/** Pole of inaccessibility (polylabel): best spot for a label inside concave rooms. */
export function polylabel(pts: Point[], precision = 2): Point {
  if (pts.length < 3) return pts[0] ?? [0, 0];
  const b = boundsOf(pts);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cell = Math.min(w, h);
  if (cell === 0) return [b.minX, b.minY];
  type Cell = { x: number; y: number; h: number; d: number; max: number };
  const mk = (x: number, y: number, hh: number): Cell => {
    const d = signedDistToPolygon(x, y, pts);
    return { x, y, h: hh, d, max: d + hh * Math.SQRT2 };
  };
  const queue: Cell[] = [];
  let hh = cell / 2;
  for (let x = b.minX; x < b.maxX; x += cell) for (let y = b.minY; y < b.maxY; y += cell) queue.push(mk(x + hh, y + hh, hh));
  const c = centroid(pts);
  let best = mk(c[0], c[1], 0);
  const bboxCell = mk(b.minX + w / 2, b.minY + h / 2, 0);
  if (bboxCell.d > best.d) best = bboxCell;
  let guard = 0;
  while (queue.length && guard++ < 4000) {
    queue.sort((a, z) => a.max - z.max);
    const cur = queue.pop()!;
    if (cur.d > best.d) best = cur;
    if (cur.max - best.d <= precision) continue;
    hh = cur.h / 2;
    queue.push(mk(cur.x - hh, cur.y - hh, hh), mk(cur.x + hh, cur.y - hh, hh), mk(cur.x - hh, cur.y + hh, hh), mk(cur.x + hh, cur.y + hh, hh));
  }
  return [best.x, best.y];
}

export function centroid(pts: Point[]): Point {
  const a = polygonArea(pts);
  if (Math.abs(a) < 1e-9) {
    const b = boundsOf(pts);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function pointsToPath(pts: Point[]): string {
  return pts.length ? 'M' + pts.map((p) => `${round(p[0])} ${round(p[1])}`).join('L') + 'Z' : '';
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export interface SnapResult {
  point: Point;
  kind: 'vertex' | 'edge' | 'grid' | 'none';
}

/**
 * Snap a world point: existing vertices first, then edges, then grid.
 * `tolerance` is in world units (screen px / scale).
 */
export function snapPoint(
  p: Point,
  polygons: Point[][],
  opts: { grid?: number; tolerance: number; snapGeometry?: boolean; snapGrid?: boolean },
): SnapResult {
  if (opts.snapGeometry !== false) {
    let best: Point | null = null;
    let bestD = opts.tolerance;
    for (const poly of polygons)
      for (const v of poly) {
        const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
        if (d <= bestD) {
          bestD = d;
          best = v;
        }
      }
    if (best) return { point: [best[0], best[1]], kind: 'vertex' };
    let edge: Point | null = null;
    bestD = opts.tolerance;
    for (const poly of polygons)
      for (let i = 0; i < poly.length; i++) {
        const r = closestPointOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
        if (r.dist <= bestD) {
          bestD = r.dist;
          edge = r.point;
        }
      }
    if (edge) {
      // Prefer a grid-aligned spot along the edge when it stays on the edge (keeps walls tidy).
      if (opts.snapGrid !== false && opts.grid) {
        const g: Point = [Math.round(edge[0] / opts.grid) * opts.grid, Math.round(edge[1] / opts.grid) * opts.grid];
        for (const poly of polygons)
          for (let i = 0; i < poly.length; i++)
            if (closestPointOnSegment(g, poly[i], poly[(i + 1) % poly.length]).dist < 0.01)
              return { point: g, kind: 'edge' };
      }
      return { point: [round(edge[0]), round(edge[1])], kind: 'edge' };
    }
  }
  if (opts.snapGrid !== false && opts.grid && opts.grid > 0) {
    return { point: [Math.round(p[0] / opts.grid) * opts.grid, Math.round(p[1] / opts.grid) * opts.grid], kind: 'grid' };
  }
  return { point: [round(p[0]), round(p[1])], kind: 'none' };
}
