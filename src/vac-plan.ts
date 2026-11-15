/**
 * The other way round: the plan learns from the vacuum's map.
 *
 * - `roomOutline`: a room of the vacuum's map as a clean polygon on the plan (its floor cells closed over
 *   furniture, holes filled, the outer border traced, small steps removed, edges squared to the plan's axes).
 * - `wallLines`: where the vacuum's map shows a wall along a plan wall, and how much of it.
 * - `planWalls` / `moveWalls` / `snapToMap`: the plan's straight walls (a wall two rooms share is one) move
 *   along their normals, onto those lines; every corner on a moved wall goes along, doors and windows too —
 *   the plan stays closed and square.
 * - `roomFromMap`: a new plan room from a room of the vacuum's map (name included).
 */
import type { FloorConfig, Point, RoomConfig } from './types';
import { closestPointOnSegment, polygonArea } from './geometry';
import type { VacuumMap, VacuumMapper } from './vacuum-live';

/** Outline (plan cm) of a room of the vacuum's map, or undefined when it has too little floor */
export function roomOutline(map: VacuumMap, roomId: string, m: VacuumMapper): Point[] | undefined {
  const room = map.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;
  const res = map.floor_res ?? 100;
  const cells = new Set<string>();
  let i0 = Infinity;
  let j0 = Infinity;
  let i1 = -Infinity;
  let j1 = -Infinity;
  for (const [x, y] of room.pts) {
    if (m.cut(x, y)) continue;
    const i = Math.floor(x / res);
    const j = Math.floor(y / res);
    cells.add(`${i},${j}`);
    i0 = Math.min(i0, i);
    j0 = Math.min(j0, j);
    i1 = Math.max(i1, i);
    j1 = Math.max(j1, j);
  }
  if (cells.size < 12) return undefined;
  // grid with a margin, closed over furniture (dilate, then erode by 3 cells), largest piece, holes filled
  const R = 3;
  const ox = i0 - R - 1;
  const oy = j0 - R - 1;
  const nx = i1 - i0 + 2 * R + 3;
  const ny = j1 - j0 + 2 * R + 3;
  let g = new Uint8Array(nx * ny);
  for (const k of cells) {
    const [i, j] = k.split(',').map(Number);
    g[(j - oy) * nx + (i - ox)] = 1;
  }
  const morph = (src: Uint8Array, grow: boolean) => {
    const out = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let v = grow ? 0 : 1;
        for (let dj = -R; dj <= R && v === (grow ? 0 : 1); dj++)
          for (let di = -R; di <= R; di++) {
            if (di * di + dj * dj > R * R) continue;
            const ii = i + di;
            const jj = j + dj;
            const s = ii < 0 || jj < 0 || ii >= nx || jj >= ny ? 0 : src[jj * nx + ii];
            if (grow && s) {
              v = 1;
              break;
            }
            if (!grow && !s) {
              v = 0;
              break;
            }
          }
        out[j * nx + i] = v;
      }
    return out;
  };
  g = morph(morph(g, true), false);
  // largest 4-connected piece
  const comp = new Int32Array(nx * ny).fill(-1);
  let best = -1;
  let bestN = 0;
  let c = 0;
  for (let k = 0; k < nx * ny; k++) {
    if (!g[k] || comp[k] >= 0) continue;
    let n = 0;
    const stack = [k];
    comp[k] = c;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qi = q % nx;
      const qj = (q - qi) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = qi + di;
        const jj = qj + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const kk = jj * nx + ii;
        if (g[kk] && comp[kk] < 0) {
          comp[kk] = c;
          stack.push(kk);
        }
      }
    }
    if (n > bestN) {
      bestN = n;
      best = c;
    }
    c++;
  }
  // keep that piece and fill its holes (everything not reachable from outside)
  const outside = new Uint8Array(nx * ny);
  const stack: number[] = [0];
  outside[0] = 1;
  while (stack.length) {
    const q = stack.pop()!;
    const qi = q % nx;
    const qj = (q - qi) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = qi + di;
      const jj = qj + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const kk = jj * nx + ii;
      if (!outside[kk] && comp[kk] !== best) {
        outside[kk] = 1;
        stack.push(kk);
      }
    }
  }
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && !outside[j * nx + i];
  // border edges between inside and outside cells, chained into a loop (corners of cells, grid units)
  const next = new Map<string, [number, number]>();
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!inside(i, j)) continue;
      // clockwise around the inside (y down): top, right, bottom, left
      if (!inside(i, j - 1)) next.set(`${i},${j}`, [i + 1, j]);
      if (!inside(i + 1, j)) next.set(`${i + 1},${j}`, [i + 1, j + 1]);
      if (!inside(i, j + 1)) next.set(`${i + 1},${j + 1}`, [i, j + 1]);
      if (!inside(i - 1, j)) next.set(`${i},${j + 1}`, [i, j]);
    }
  const start = next.keys().next().value as string | undefined;
  if (!start) return undefined;
  const loop: Point[] = [];
  let k = start;
  for (let guard = 0; guard < 20000; guard++) {
    const [a, b] = k.split(',').map(Number);
    loop.push([a, b]);
    const n = next.get(k);
    if (!n) break;
    k = `${n[0]},${n[1]}`;
    if (k === start) break;
  }
  // to plan coordinates (the room's own placement), then simplify and square the corners
  const plan = loop.map(([a, b]) => m.toPlan((a + ox) * res, (b + oy) * res, roomId));
  const tol = Math.max(8, res * (m.tf.scale ?? 0.1) * 1.6);
  return squareUp(dp(plan, tol));
}

/** Douglas–Peucker on a closed polygon */
function dp(pts: Point[], eps: number): Point[] {
  if (pts.length < 4) return pts;
  // split at the two points farthest apart
  let a = 0;
  let b = 0;
  let far = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > far) {
      far = d;
      b = i;
    }
  }
  const run = (s: number, e: number): Point[] => {
    const seq: Point[] = [];
    for (let i = s; ; i = (i + 1) % pts.length) {
      seq.push(pts[i]);
      if (i === e) break;
    }
    const keep = new Uint8Array(seq.length);
    keep[0] = keep[seq.length - 1] = 1;
    const rec = (i: number, j: number) => {
      let md = 0;
      let mi = -1;
      for (let k = i + 1; k < j; k++) {
        const d = closestPointOnSegment(seq[k], seq[i], seq[j]).dist;
        if (d > md) {
          md = d;
          mi = k;
        }
      }
      if (mi >= 0 && md > eps) {
        keep[mi] = 1;
        rec(i, mi);
        rec(mi, j);
      }
    };
    rec(0, seq.length - 1);
    return seq.filter((_, i) => keep[i]);
  };
  const first = run(a, b);
  const second = run(b, a);
  return [...first, ...second.slice(1, -1)];
}

/** Edges within 15° of the plan's axes become exactly horizontal / vertical; corners re-intersected */
function squareUp(pts: Point[]): Point[] {
  const n = pts.length;
  if (n < 3) return pts;
  type Line = { kind: 'h' | 'v' | 'f'; v: number; a: Point; b: Point };
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ang = Math.abs((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 180;
    if (ang < 15 || ang > 165) lines.push({ kind: 'h', v: (a[1] + b[1]) / 2, a, b });
    else if (Math.abs(ang - 90) < 15) lines.push({ kind: 'v', v: (a[0] + b[0]) / 2, a, b });
    else lines.push({ kind: 'f', v: 0, a, b });
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const l0 = lines[(i - 1 + n) % n];
    const l1 = lines[i];
    const p = pts[i];
    let q: Point = p;
    if (l0.kind === 'h' && l1.kind === 'v') q = [l1.v, l0.v];
    else if (l0.kind === 'v' && l1.kind === 'h') q = [l0.v, l1.v];
    else if (l0.kind === 'h' && l1.kind === 'h') q = [p[0], l1.v];
    else if (l0.kind === 'v' && l1.kind === 'v') q = [l1.v, p[1]];
    else if (l0.kind === 'h') q = [p[0], l0.v];
    else if (l0.kind === 'v') q = [l0.v, p[1]];
    else if (l1.kind === 'h') q = [p[0], l1.v];
    else if (l1.kind === 'v') q = [l1.v, p[1]];
    out.push([Math.round(q[0]), Math.round(q[1])]);
  }
  // drop duplicates and points on a straight line
  const clean: Point[] = [];
  for (const p of out) if (!clean.length || Math.hypot(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 0.5) clean.push(p);
  if (clean.length > 1 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 0.5) clean.pop();
  const res: Point[] = [];
  for (let i = 0; i < clean.length; i++) {
    const a = clean[(i - 1 + clean.length) % clean.length];
    const b = clean[i];
    const c = clean[(i + 1) % clean.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1) res.push(b);
  }
  return res.length >= 3 ? res : clean;
}

/** Lines of the vacuum's map along a plan wall: where along its normal (plan cm) the map shows a wall and how much
 * of the wall's length that line covers (0..1). Sorted best first.
 * `rooms`: only the walls of these rooms of the vacuum's map, each placed the way that room is placed (a room laid
 * on its own sits elsewhere than the whole map would put it: mixing both shows a wall twice, apart). */
export function wallLines(map: VacuumMap, m: VacuumMapper, a: Point, b: Point, reach = 80, rooms?: string[]): { off: number; cover: number }[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 20) return [];
  const d: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const nrm: Point = [-d[1], d[0]];
  const off = a[0] * nrm[0] + a[1] * nrm[1];
  const s0 = a[0] * d[0] + a[1] * d[1];
  // the ends belong to the walls across: leave 12 % out on each side
  const lo = s0 + len * 0.12;
  const hi = s0 + len * 0.88;
  const BIN = 4;
  const STEP = 5;
  const bins = new Map<number, Set<number>>();
  for (const [x, y] of map.walls) {
    if (m.cut(x, y)) continue;
    const room = rooms ? m.roomOf(x, y) : undefined;
    if (rooms && (!room || !rooms.includes(room))) continue;
    const p = m.toPlan(x, y, room);
    const t = p[0] * d[0] + p[1] * d[1];
    if (t < lo || t > hi) continue;
    const o = p[0] * nrm[0] + p[1] * nrm[1] - off;
    if (Math.abs(o) > reach) continue;
    const k = Math.round(o / BIN);
    let set = bins.get(k);
    if (!set) bins.set(k, (set = new Set()));
    set.add(Math.floor(t / STEP));
  }
  const need = (hi - lo) / STEP;
  const ks = [...bins.keys()].sort((x, y) => x - y);
  // a wall is a few bins thick: neighbouring bins together, weighted by how much each covers
  const out: { off: number; cover: number }[] = [];
  for (const k of ks) {
    const run = [k - 1, k, k + 1].filter((q) => bins.has(q));
    const span = new Set<number>();
    let w = 0;
    let wo = 0;
    for (const q of run) {
      const n = bins.get(q)!.size;
      for (const t of bins.get(q)!) span.add(t);
      w += n;
      wo += n * q * BIN;
    }
    const cover = Math.min(1, span.size / need);
    if (cover >= 0.3) out.push({ off: Math.round(off + wo / w), cover });
  }
  // keep local best ones only (no two within 8 cm)
  out.sort((x, y) => y.cover - x.cover);
  const keep: { off: number; cover: number }[] = [];
  for (const c of out) if (!keep.some((k) => Math.abs(k.off - c.off) < 8)) keep.push(c);
  return keep;
}

/** A straight wall of the plan: all room edges on one line that touch each other (a wall two rooms share is one
 * line). `nrm`: unit normal, `off`: its offset along it, `t0..t1`: its extent along the line. */
export interface PlanWall {
  nrm: Point;
  off: number;
  t0: number;
  t1: number;
  /** rooms with an edge on it */
  rooms: Set<string>;
}

const along = (nrm: Point, p: Point) => p[0] * -nrm[1] + p[1] * nrm[0];

export function planWalls(floor: FloorConfig): PlanWall[] {
  const walls: PlanWall[] = [];
  for (const r of floor.rooms) {
    if (r.points.length < 3) continue;
    for (let i = 0; i < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[(i + 1) % r.points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      // one orientation per line: normal pointing to +x (or +y for horizontal lines)
      let nrm: Point = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      if (nrm[0] < -1e-9 || (Math.abs(nrm[0]) < 1e-9 && nrm[1] < 0)) nrm = [-nrm[0], -nrm[1]];
      const off = a[0] * nrm[0] + a[1] * nrm[1];
      const ta = along(nrm, a);
      const tb = along(nrm, b);
      const t0 = Math.min(ta, tb);
      const t1 = Math.max(ta, tb);
      const w = walls.find((x) => Math.abs(x.nrm[0] * nrm[1] - x.nrm[1] * nrm[0]) < 0.02 && Math.abs(x.off - off) < 1 && t0 <= x.t1 + 1 && t1 >= x.t0 - 1);
      if (w) {
        w.t0 = Math.min(w.t0, t0);
        w.t1 = Math.max(w.t1, t1);
        w.rooms.add(r.id);
      } else walls.push({ nrm, off, t0, t1, rooms: new Set([r.id]) });
    }
  }
  // lines that grew into each other: merge
  for (let i = 0; i < walls.length; i++)
    for (let j = walls.length - 1; j > i; j--) {
      const x = walls[i];
      const y = walls[j];
      if (Math.abs(x.nrm[0] * y.nrm[1] - x.nrm[1] * y.nrm[0]) < 0.02 && Math.abs(x.off - y.off) < 1 && y.t0 <= x.t1 + 1 && y.t1 >= x.t0 - 1) {
        x.t0 = Math.min(x.t0, y.t0);
        x.t1 = Math.max(x.t1, y.t1);
        for (const id of y.rooms) x.rooms.add(id);
        walls.splice(j, 1);
      }
    }
  return walls;
}

/** The two ends of a plan wall */
export function wallEnds(w: PlanWall): [Point, Point] {
  const d: Point = [-w.nrm[1], w.nrm[0]];
  return [
    [w.nrm[0] * w.off + d[0] * w.t0, w.nrm[1] * w.off + d[1] * w.t0],
    [w.nrm[0] * w.off + d[0] * w.t1, w.nrm[1] * w.off + d[1] * w.t1],
  ];
}

/**
 * Move plan walls along their normals (plan cm). Every corner on a moved wall — of any room — moves with it, so a
 * wall two rooms share stays shared and walls meeting at a corner stay joined; doors and windows on it move too.
 * Works on the given (draft) floor; `walls` must come from `planWalls` of that floor before the move.
 */
export function moveWalls(floor: FloorConfig, walls: PlanWall[], deltas: number[]): number {
  const moved = walls.map((w, i) => ({ w, d: deltas[i] ?? 0 })).filter((x) => x.d);
  if (!moved.length) return 0;
  const shift = (p: Point): Point => {
    let x = p[0];
    let y = p[1];
    for (const { w, d } of moved) {
      const t = along(w.nrm, p);
      if (Math.abs(p[0] * w.nrm[0] + p[1] * w.nrm[1] - w.off) < 1 && t >= w.t0 - 1 && t <= w.t1 + 1) {
        x += w.nrm[0] * d;
        y += w.nrm[1] * d;
      }
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  };
  for (const r of floor.rooms) r.points = r.points.map(shift);
  for (const o of floor.openings ?? []) {
    o.a = shift(o.a);
    o.b = shift(o.b);
  }
  return moved.length;
}

/** For a plan wall: how far to move it onto the vacuum's map (0: no clear line). A long line close by wins; far
 * moves need a line along most of the wall (doors and furniture break lines up). */
export function wallSnap(map: VacuumMap, m: VacuumMapper, w: PlanWall, reach = 60, rooms?: string[]): number {
  if (w.t1 - w.t0 < 60) return 0;
  // ends ordered so that the measuring normal is the wall's own
  const [b, a] = wallEnds(w);
  const c = wallLines(map, m, a, b, reach, rooms)
    .map((x) => ({ ...x, score: x.cover * (1 - (0.6 * Math.abs(x.off - w.off)) / reach) }))
    .filter((x) => Math.abs(x.off - w.off) <= 15 || x.cover >= 0.6)
    .sort((x, y) => y.score - x.score)[0];
  if (!c) return 0;
  const d = Math.round(c.off - w.off);
  return Math.abs(d) >= 2 ? d : 0;
}

/**
 * Walls of the plan (of one room, or all) onto the lines of the vacuum's map; returns walls moved.
 * `mapRooms(planRoomIds)`: the rooms of the vacuum's map that belong to these plan rooms (by name) — a wall then
 * only looks at their walls, placed the way they are placed. A snap never bends a room out of shape: walls that
 * would change a room's area or a side of it by much stay where they are (the map can be wrong: mirrors, glass,
 * furniture along a wall, a room laid on its own).
 */
export function snapToMap(floor: FloorConfig, map: VacuumMap, m: VacuumMapper, roomId?: string, mapRooms?: (ids: Set<string>) => string[] | undefined): number {
  const walls = planWalls(floor);
  const deltas = walls.map((w) => (!roomId || w.rooms.has(roomId) ? wallSnap(map, m, w, 60, mapRooms?.(w.rooms)) : 0));
  keepShapes(floor, walls, deltas);
  return moveWalls(floor, walls, deltas);
}

/** Largest change of a room by a wall move that still counts as fitting (not reshaping) */
const MAX_AREA = 0.15;
const MAX_SIDE = 0.2;

/** Drop the moves of walls whose room would change too much (area or width/depth), until every room keeps its shape */
export function keepShapes(floor: FloorConfig, walls: PlanWall[], deltas: number[]) {
  const box = (pts: Point[]) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  for (let round = 0; round < 8; round++) {
    const trial = { ...floor, rooms: floor.rooms.map((r) => ({ ...r, points: r.points.map((p) => [...p] as Point) })), openings: [] } as FloorConfig;
    moveWalls(trial, walls, deltas);
    const bad = floor.rooms.filter((r, i) => {
      if (r.points.length < 3) return false;
      const a0 = Math.abs(polygonArea(r.points));
      const a1 = Math.abs(polygonArea(trial.rooms[i].points));
      const [w0, h0] = box(r.points);
      const [w1, h1] = box(trial.rooms[i].points);
      return a0 > 0 && (Math.abs(a1 / a0 - 1) > MAX_AREA || Math.abs(w1 - w0) > Math.max(10, w0 * MAX_SIDE) || Math.abs(h1 - h0) > Math.max(10, h0 * MAX_SIDE));
    });
    if (!bad.length) return;
    for (const r of bad) walls.forEach((w, i) => w.rooms.has(r.id) && (deltas[i] = 0));
  }
}

/** A plan room from a room of the vacuum's map: its floor's outline, each wall then pushed out onto the map's
 * wall line just outside (furniture along a wall keeps the floor away from it) */
export function roomFromMap(map: VacuumMap, roomId: string, m: VacuumMapper, id: string): RoomConfig | undefined {
  let outline = roomOutline(map, roomId, m);
  if (!outline || Math.abs(polygonArea(outline)) < 4000) return undefined; // < 0.4 m²
  // most rooms are rectangles: furniture only bites into the floor — an outline that fills most of its box
  // becomes that box; L-shapes and the like keep their (squared) outline
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const box: Point[] = [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
    [Math.min(...xs), Math.max(...ys)],
  ];
  if (Math.abs(polygonArea(outline)) / Math.abs(polygonArea(box)) >= 0.7 || outline.length > 14) outline = box;
  const name = map.rooms.find((r) => r.id === roomId)?.name ?? undefined;
  const room: RoomConfig = { id, name: name ?? undefined, points: outline };
  const floor = { id: '_', name: '_', rooms: [room], devices: [], openings: [] } as unknown as FloorConfig;
  const walls = planWalls(floor);
  const deltas = walls.map((w) => {
    const [b, a] = wallEnds(w);
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // + along the normal leads outside?
    const outward = pointInPolygonLocal([mid[0] + w.nrm[0] * 3, mid[1] + w.nrm[1] * 3], room.points) ? -1 : 1;
    // the nearest wall line just outside (up to 45 cm) — the floor stops at furniture, the wall is behind it
    const c = wallLines(map, m, a, b, 45)
      .filter((x) => (x.off - w.off) * outward > -3)
      .sort((x, y) => Math.abs(x.off - w.off) - Math.abs(y.off - w.off))[0];
    return c ? Math.round(c.off - w.off) : 0;
  });
  moveWalls(floor, walls, deltas);
  return room;
}

function pointInPolygonLocal(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}
