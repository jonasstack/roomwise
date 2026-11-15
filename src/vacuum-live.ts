import type { VacuumRoomFit, FloorConfig, Point, VacuumTransform } from './types';
import { closestPointOnSegment, pointInPolygon } from './geometry';
import { wallPieces } from './walls';

/**
 * A robot vacuum driving through the plan, from the positions the companion integration reads every ~2 s.
 *
 * - Robot coordinates (mm, the robot's own map) are laid onto the plan (cm) with a transform: offset, rotation,
 *   scale, mirror — set in the editor or found automatically from what the vacuum has driven over.
 * - "delayed": shown ~2.5 s behind, so the next position is always known: it drives exactly from point to
 *   point (around walls, through the free floor it has learned) — smooth and never guessing.
 * - "live": shown as it is, guessing in between from its last motion and usual speed, but only over floor it
 *   is allowed on (no walls, nothing it has never driven over); new positions are blended in without jumps.
 */
export interface VacSample {
  t: number;
  p: Point;
}

export interface LearnedFloor {
  res: number;
  cells: [number, number, number][];
  dock?: [number, number] | null;
  speed?: number | null;
  runs?: number;
}

/** Robot (mm) → plan (cm): mirror, turn, then scale along the plan's axes (x and y may differ a little) */
export function toPlan(tf: VacuumTransform, x: number, y: number): Point {
  const s = tf.scale ?? 0.1;
  const sy = tf.scaleY ?? s;
  const yy = tf.mirror ? -y : y;
  const a = ((tf.rot ?? 0) * Math.PI) / 180;
  return [tf.x + s * (x * Math.cos(a) - yy * Math.sin(a)), tf.y + sy * (x * Math.sin(a) + yy * Math.cos(a))];
}

export function toRobot(tf: VacuumTransform, px: number, py: number): Point {
  const s = tf.scale ?? 0.1;
  const sy = tf.scaleY ?? s;
  const a = ((tf.rot ?? 0) * Math.PI) / 180;
  const dx = (px - tf.x) / s;
  const dy = (py - tf.y) / sy;
  const x = dx * Math.cos(a) + dy * Math.sin(a);
  const yy = -dx * Math.sin(a) + dy * Math.cos(a);
  return [x, tf.mirror ? -yy : yy];
}

/** Floor the vacuum may be on: what it has driven over plus the floor of its own map (without the cut-out
 * areas), from plan coordinates (one cell of tolerance) */
export function learnedLookup(learned: LearnedFloor | undefined, tf: VacuumTransform | VacuumMapper, map?: VacuumMap): ((p: Point) => boolean) | undefined {
  const res = learned?.res || 100;
  const mapper = tf instanceof VacuumMapper ? tf : undefined;
  const set = new Set((learned?.cells ?? []).map(([x, y]) => `${x},${y}`));
  for (const r of map?.rooms ?? []) for (const [x, y] of r.pts) if (!mapper?.cut(x, y)) set.add(`${Math.floor(x / res)},${Math.floor(y / res)}`);
  if (set.size < 150) return undefined; // too little known yet: walls only
  return (p) => {
    const [x, y] = mapper ? mapper.toRobot(p[0], p[1]) : toRobot(tf as VacuumTransform, p[0], p[1]);
    const cx = Math.floor(x / res);
    const cy = Math.floor(y / res);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (set.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  };
}

/**
 * Lay the learned floor onto the plan. Score of a candidate: points inside the rooms count, points on a wall
 * (where it cannot have been — doors excepted) count heavily against; the dock (when known) pulls gently onto
 * the dock piece, and decides between the ways a symmetric room fits. Searched over rotation (5°, then 0.5°), mirror and offset; scale stays real (mm → cm).
 */
export function autoFit(floor: FloorConfig, learned: LearnedFloor, dockPiece?: Point): VacuumTransform | undefined {
  const rooms = floor.rooms.filter((r) => !r.outdoor && r.points.length >= 3);
  if (!rooms.length || learned.cells.length < 30) return undefined;
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
  const G = 5;
  const nx = Math.ceil((maxX - minX) / G) + 1;
  const ny = Math.ceil((maxY - minY) / G) + 1;
  // 1 = inside a room, 2 = on a wall (or window) — where the vacuum can never be
  const mask = new Uint8Array(nx * ny);
  const walls = wallPieces(floor).filter((w) => w.kind !== 'door');
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (rooms.some((r) => pointInPolygon([minX + i * G, minY + j * G], r.points))) mask[j * nx + i] = 1;
  // walls drawn into the mask along their length (7 cm either side); the band along them (up to 22 cm) is
  // where the vacuum goes when it cleans the edges: points there show that the map reaches the walls
  const R = 7;
  const BAND = 22;
  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const n = Math.max(1, Math.ceil(len / (G / 2)));
    for (let k = 0; k <= n; k++) {
      const cx = w.a[0] + ((w.b[0] - w.a[0]) * k) / n;
      const cy = w.a[1] + ((w.b[1] - w.a[1]) * k) / n;
      const i0 = Math.floor((cx - BAND - minX) / G);
      const j0 = Math.floor((cy - BAND - minY) / G);
      for (let j = j0; j <= j0 + Math.ceil((2 * BAND) / G) + 1; j++)
        for (let i = i0; i <= i0 + Math.ceil((2 * BAND) / G) + 1; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny || mask[j * nx + i] !== 1) continue;
          if (closestPointOnSegment([minX + i * G, minY + j * G], w.a, w.b).dist < BAND) mask[j * nx + i] = 3;
        }
    }
  }
  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const n = Math.max(1, Math.ceil(len / (G / 2)));
    for (let k = 0; k <= n; k++) {
      const cx = w.a[0] + ((w.b[0] - w.a[0]) * k) / n;
      const cy = w.a[1] + ((w.b[1] - w.a[1]) * k) / n;
      const i0 = Math.floor((cx - R - minX) / G);
      const j0 = Math.floor((cy - R - minY) / G);
      for (let j = j0; j <= j0 + Math.ceil((2 * R) / G) + 1; j++)
        for (let i = i0; i <= i0 + Math.ceil((2 * R) / G) + 1; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny || !mask[j * nx + i] || mask[j * nx + i] === 2) continue;
          if (closestPointOnSegment([minX + i * G, minY + j * G], w.a, w.b).dist < R) mask[j * nx + i] = 2;
        }
    }
  }
  const res = learned.res || 100;
  // edge cells: where the vacuum could not go on (nothing driven further that way) — walls or furniture; at a
  // wall they show the scale: they belong right along it, not in it and not far off. The gap to its next lane
  // (it learns where its middle went, about a body width apart) is not an edge.
  const have = new Set(learned.cells.map(([x, y]) => `${x},${y}`));
  const reach = Math.max(1, Math.round(300 / res));
  const goesOn = (x: number, y: number, dx: number, dy: number) => {
    for (let k = 1; k <= reach; k++) if (have.has(`${x + dx * k},${y + dy * k}`)) return true;
    return false;
  };
  const isEdge = ([x, y]: [number, number, number]) => !goesOn(x, y, 1, 0) || !goesOn(x, y, -1, 0) || !goesOn(x, y, 0, 1) || !goesOn(x, y, 0, -1);
  const all = learned.cells.map((c) => [(c[0] + 0.5) * res, (c[1] + 0.5) * res] as Point);
  const edgeOf = learned.cells.map(isEdge);
  const step = Math.max(1, Math.floor(all.length / 700));
  const pick = all.map((p, i) => ({ p, e: edgeOf[i] })).filter((_, i) => i % step === 0);
  const pts = pick.map((q) => q.p);
  const edges = pick.map((q) => q.e);
  const roomC: Point = [0, 0];
  let area = 0;
  for (let k = 0; k < mask.length; k++)
    if (mask[k]) {
      roomC[0] += minX + (k % nx) * G;
      roomC[1] += minY + Math.floor(k / nx) * G;
      area++;
    }
  roomC[0] /= area || 1;
  roomC[1] /= area || 1;
  // per rotation the points are turned once; offsets then only shift them (fast)
  const turned = (rot: number, mirror: boolean, sample = pts, sx = 0.1, sy = 0.1, edge = edges) => {
    const base: VacuumTransform = { x: 0, y: 0, rot, scale: sx, scaleY: sy, mirror };
    const xy = new Float64Array(sample.length * 2);
    const ed = edge;
    sample.forEach(([x, y], k) => {
      const p = toPlan(base, x, y);
      xy[k * 2] = (p[0] - minX) / G;
      xy[k * 2 + 1] = (p[1] - minY) / G;
    });
    const dock = learned.dock ? toPlan(base, learned.dock[0], learned.dock[1]) : undefined;
    return { base, xy, dock, ed };
  };
  const scoreAt = (t: ReturnType<typeof turned>, ox: number, oy: number) => {
    const gx = ox / G;
    const gy = oy / G;
    let s = 0;
    for (let k = 0; k < t.xy.length; k += 2) {
      const i = Math.round(t.xy[k] + gx);
      const j = Math.round(t.xy[k + 1] + gy);
      const m = i >= 0 && j >= 0 && i < nx && j < ny ? mask[j * nx + i] : 0;
      // inside counts; along a wall an edge cell counts much more (the map reaches the wall), in a wall or
      // outside it counts against
      if (t.ed[k / 2]) s += m === 3 ? 3 : m === 1 ? 0.5 : m === 2 ? -4 : -3;
      else s += m === 1 || m === 3 ? 1 : m === 2 ? -3 : -1;
    }
    s /= t.xy.length / 2;
    if (t.dock && dockPiece) {
      // 1 m off ≈ one in fifty points; metres off (a symmetric room turned or mirrored the wrong way) count much more
      const d = Math.hypot(t.dock[0] + ox - dockPiece[0], t.dock[1] + oy - dockPiece[1]);
      s -= d / 5000 + Math.max(0, d - 80) / 500;
    }
    return s;
  };
  const centre = (t: ReturnType<typeof turned>): Point => {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < t.xy.length; k += 2) {
      cx += t.xy[k] * G + minX;
      cy += t.xy[k + 1] * G + minY;
    }
    return [roomC[0] - (cx * 2) / t.xy.length, roomC[1] - (cy * 2) / t.xy.length];
  };
  let best: { rot: number; mirror: boolean; x: number; y: number; sx: number; sy: number; s: number } | undefined;
  const search = (rot: number, mirror: boolean, cx: number, cy: number, span: number, stepT: number, sample = pts, sx = 0.1, sy = 0.1, edge = edges) => {
    const t = turned(rot, mirror, sample, sx, sy, edge);
    // the robot measures real millimetres: a plan off by a few percent needs clear evidence (points through
    // walls / outside, or the map not reaching the walls) before the scale moves away from 1:1
    const prior = 0.3 * (Math.abs(sx / 0.1 - 1) + Math.abs(sy / 0.1 - 1));
    for (let dx = -span; dx <= span; dx += stepT)
      for (let dy = -span; dy <= span; dy += stepT) {
        const s = scoreAt(t, cx + dx, cy + dy) - prior;
        if (!best || s > best.s) best = { rot, mirror, x: cx + dx, y: cy + dy, sx, sy, s };
      }
  };
  /** middle of the turned points (plan, without offset) */
  const mid = (t: ReturnType<typeof turned>): Point => {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < t.xy.length; k += 2) {
      cx += t.xy[k] * G + minX;
      cy += t.xy[k + 1] * G + minY;
    }
    return [(cx * 2) / t.xy.length, (cy * 2) / t.xy.length];
  };
  // coarse: a third of the points, 40 cm steps, three scales; the best few go on to the fine search
  const few = pts.filter((_, i) => i % 3 === 0);
  const fewEdges = edges.filter((_, i) => i % 3 === 0);
  const coarse: NonNullable<typeof best>[] = [];
  for (const sc of [0.1, 0.09, 0.11])
    for (const mirror of [false, true])
      for (let rot = 0; rot < 360; rot += 5) {
        best = undefined;
        const c = centre(turned(rot, mirror, few, sc, sc, fewEdges));
        search(rot, mirror, c[0], c[1], 320, 40, few, sc, sc, fewEdges);
        coarse.push(best!);
      }
  coarse.sort((p, q) => q.s - p.s);
  const picks: NonNullable<typeof best>[] = [];
  for (const cnd of coarse) {
    if (picks.some((p) => p.mirror === cnd.mirror && Math.abs(((cnd.rot - p.rot + 540) % 360) - 180) < 10)) continue;
    picks.push(cnd);
    if (picks.length >= 6) break;
  }
  // scale: the plan may be drawn a little bigger / smaller (or out of proportion) than the real flat — the
  // learned map is real: scaled about its middle until it reaches the walls, never through them
  const scaleAround = (sx: number, sy: number, span: number, stepT: number) => {
    const b0 = best!;
    const m0 = mid(turned(b0.rot, b0.mirror, pts, b0.sx, b0.sy));
    const m1 = mid(turned(b0.rot, b0.mirror, pts, sx, sy));
    search(b0.rot, b0.mirror, b0.x + m0[0] - m1[0], b0.y + m0[1] - m1[1], span, stepT, pts, sx, sy);
  };
  let winner: NonNullable<typeof best> | undefined;
  for (const cnd of picks) {
    best = { ...cnd, s: -Infinity };
    // finer turns and shifts, then the scale, then once more
    for (const [rs, ts, tstep] of [
      [5, 40, 8],
      [2, 10, 2],
    ] as const) {
      const b0 = best!;
      for (let dr = -rs; dr <= rs; dr += rs / 5) search(((((b0.rot + dr) % 360) + 360) % 360), b0.mirror, b0.x, b0.y, ts, tstep, pts, b0.sx, b0.sy);
    }
    for (const [range, step, span, stepT] of [
      [0.016, 0.004, 48, 8],
      [0.004, 0.002, 16, 4],
      [0.002, 0.001, 6, 2],
    ] as const) {
      const b0 = best!;
      for (let sx = b0.sx - range; sx <= b0.sx + range + 1e-9; sx += step)
        for (let sy = b0.sy - range; sy <= b0.sy + range + 1e-9; sy += step) if (Math.abs(sx / sy - 1) <= 0.12) scaleAround(sx, sy, span, stepT);
    }
    {
      const b0 = best!;
      for (let dr = -1; dr <= 1; dr += 0.25) search(((((b0.rot + dr) % 360) + 360) % 360), b0.mirror, b0.x, b0.y, 4, 1, pts, b0.sx, b0.sy);
    }
    if (!winner || best!.s > winner.s) winner = best!;
  }
  best = winner;
  const r = best!;
  const sx = Math.round(r.sx * 10000) / 10000;
  const sy = Math.round(r.sy * 10000) / 10000;
  return { x: Math.round(r.x), y: Math.round(r.y), rot: Math.round(r.rot * 10) / 10, scale: sx, scaleY: sy !== sx ? sy : undefined, mirror: r.mirror || undefined };
}

/** A point of the robot's map that stays put while the map is turned (centre of what it learned) */
export function learnedCentre(learned: LearnedFloor): Point {
  const res = learned.res || 100;
  let x = 0;
  let y = 0;
  for (const [cx, cy] of learned.cells) {
    x += (cx + 0.5) * res;
    y += (cy + 0.5) * res;
  }
  const n = learned.cells.length || 1;
  return [x / n, y / n];
}

/** Motion between the positions (plan coordinates, cm) */
export class LiveVacuum {
  samples: VacSample[] = [];
  shown?: Point;
  /** facing (radians, plan): direction of travel */
  heading = 0;
  private headingKnown = false;
  private headFrom?: Point;
  private want?: number;
  private lastStep = 0;
  private offset: Point = [0, 0];
  private offsetT = 0;
  private blend = 700;
  private routes = new WeakMap<VacSample, Point[]>();
  /** delay to move towards (ms), e.g. when the robot's integration reports less often than expected */
  delayTarget?: number;

  constructor(
    public mode: 'delayed' | 'live',
    public delay: number,
    /** may the vacuum be here (walls, learned floor) */
    public allowed: (p: Point) => boolean,
    /** a way between two points around walls (undefined: none) */
    public route: (a: Point, b: Point) => Point[] | undefined,
    /** usual speed (cm/s) */
    public speed = 25,
    /** may it get from one reported position straight to the next (walls only: it did drive there, even over
     * floor it had not learned yet) */
    public passable: (p: Point) => boolean = allowed,
  ) {}

  feed(s: VacSample) {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t <= last.t) return;
    if (this.mode === 'live' && this.shown) {
      // blend: what is shown now stays where it is and drifts onto the new truth
      const pred = this.predict(s.t, [...this.samples, s]);
      this.offset = [this.shown[0] - pred[0], this.shown[1] - pred[1]];
      this.offsetT = performance.now();
      // a big correction (it was somewhere else than guessed) is driven over at its pace, not snapped
      this.blend = Math.max(900, Math.min(3500, (Math.hypot(this.offset[0], this.offset[1]) / Math.max(10, this.speed)) * 1000));
    }
    this.samples.push(s);
    if (this.samples.length > 12) this.samples.shift();
  }

  /** Way from one sample to the next: straight when that is clear, otherwise around the walls */
  private path(a: VacSample, b: VacSample): Point[] {
    let r = this.routes.get(b);
    if (!r) {
      r = this.clear(a.p, b.p) ? [a.p, b.p] : (this.route(a.p, b.p) ?? [a.p, b.p]);
      // it was at both positions: the way starts and ends there (a route may end at the nearest free spot, and
      // the next way starting at the real position would make it jump)
      const end = r[r.length - 1];
      if (Math.hypot(end[0] - b.p[0], end[1] - b.p[1]) > 0.5) r = [...r, b.p];
      if (Math.hypot(r[0][0] - a.p[0], r[0][1] - a.p[1]) > 0.5) r = [a.p, ...r];
      this.routes.set(b, r);
    }
    return r;
  }

  private clear(a: Point, b: Point): boolean {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / 6));
    for (let i = 1; i < n; i++) if (!this.passable([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])) return false;
    return true;
  }

  private along(path: Point[], k: number): Point {
    let total = 0;
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    let want = total * Math.max(0, Math.min(1, k));
    for (let i = 1; i < path.length; i++) {
      const seg = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      if (want <= seg || i === path.length - 1) {
        const f = seg ? Math.min(1, want / seg) : 1;
        return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
      }
      want -= seg;
    }
    return path[path.length - 1];
  }

  /** Live guess at time t: keep going the way it went, at its usual speed, only over allowed floor */
  private predict(t: number, samples = this.samples): Point {
    const n = samples.length;
    const last = samples[n - 1];
    if (!last) return [0, 0];
    const prev = samples[n - 2];
    if (!prev || t <= last.t) return last.p;
    const dt = (last.t - prev.t) / 1000;
    let vx = dt > 0.2 ? (last.p[0] - prev.p[0]) / dt : 0;
    let vy = dt > 0.2 ? (last.p[1] - prev.p[1]) / dt : 0;
    const v = Math.hypot(vx, vy);
    if (v < 1) return last.p;
    const cap = Math.min(v, this.speed * 1.4);
    vx = (vx / v) * cap;
    vy = (vy / v) * cap;
    // not further than ~3 s ahead (then it waits for news)
    const ahead = Math.min(3, (t - last.t) / 1000);
    let p: Point = [last.p[0], last.p[1]];
    const steps = Math.ceil(ahead * 10);
    for (let i = 0; i < steps; i++) {
      const h = ahead / steps;
      const nxt: Point = [p[0] + vx * h, p[1] + vy * h];
      if (this.allowed(nxt)) p = nxt;
      else if (this.allowed([p[0] + vx * h, p[1]])) p = [p[0] + vx * h, p[1]]; // slide along the obstacle
      else if (this.allowed([p[0], p[1] + vy * h])) p = [p[0], p[1] + vy * h];
      else break; // in front of a wall / never-driven floor: it stops there
    }
    return p;
  }

  /** Still turning towards its direction of travel */
  get turning(): boolean {
    if (this.want === undefined) return false;
    let d = this.want - this.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) > 0.01;
  }

  /** Where to show it now; true while it is moving */
  step(now: number): { p: Point; heading: number; moving: boolean } | undefined {
    const n = this.samples.length;
    if (!n) return undefined;
    let p: Point;
    if (this.mode === 'delayed') {
      // a new delay is reached gradually (playing a little slower or faster), never by a jump back or ahead
      if (this.delayTarget !== undefined && this.delayTarget !== this.delay && this.lastStep) {
        const max = 0.35 * Math.min(250, now - this.lastStep);
        this.delay += Math.max(-max, Math.min(max, this.delayTarget - this.delay));
      }
      const t = now - this.delay;
      let i = this.samples.findIndex((s) => s.t > t);
      if (i === -1) p = this.samples[n - 1].p;
      else if (i === 0) p = this.samples[0].p;
      else {
        const a = this.samples[i - 1];
        const b = this.samples[i];
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        p = this.along(this.path(a, b), k);
      }
    } else {
      p = this.predict(now);
      const age = (performance.now() - this.offsetT) / this.blend;
      const f = age >= 1 ? 0 : 1 - age * age * (3 - 2 * age);
      p = [p[0] + this.offset[0] * f, p[1] + this.offset[1] * f];
      // the guess and the drift onto a new position together never drive much faster than it does (a wrong
      // guess at a turn is caught up at under twice its pace); only a far-off correction may go faster
      if (this.shown && this.lastStep && now > this.lastStep) {
        const d = Math.hypot(p[0] - this.shown[0], p[1] - this.shown[1]);
        const cap = Math.max(1.8 * this.speed, d / 2) * ((now - this.lastStep) / 1000);
        if (d > cap) p = [this.shown[0] + ((p[0] - this.shown[0]) * cap) / d, this.shown[1] + ((p[1] - this.shown[1]) * cap) / d];
      }
    }
    const prev = this.shown;
    this.shown = p;
    const moved = prev ? Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0;
    // facing: where it has gone over the last few centimetres (not frame to frame: no jitter), turning at most
    // ~170°/s like the real one; the very first direction is taken as it is
    const dt = this.lastStep ? Math.min(0.25, (now - this.lastStep) / 1000) : 0;
    this.lastStep = now;
    if (!this.headFrom) this.headFrom = p;
    if (Math.hypot(p[0] - this.headFrom[0], p[1] - this.headFrom[1]) > 4) {
      this.want = Math.atan2(p[1] - this.headFrom[1], p[0] - this.headFrom[0]);
      this.headFrom = p;
      if (!this.headingKnown) {
        this.heading = this.want;
        this.headingKnown = true;
      }
    }
    if (this.want !== undefined) {
      let d = this.want - this.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const max = 3 * dt;
      this.heading += Math.max(-max, Math.min(max, d));
    }
    const last = this.samples[n - 1];
    const moving = this.mode === 'delayed' ? now - this.delay < last.t + 400 : now - last.t < 3500;
    return { p, heading: this.heading, moving: moving || moved > 0.05 };
  }
}

// ---------- laying the vacuum's own map (rooms, walls) onto the plan ----------

/** The vacuum's own map (companion: Roborock), robot millimetres */
export interface VacuumMap {
  rooms: { id: string; name?: string | null; pts: [number, number][] }[];
  walls: [number, number][];
  charger?: [number, number] | null;
  floor_res?: number;
  wall_res?: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
const SYNONYMS: [string, string][] = [
  ['badezimmer', 'bad'],
  ['bathroom', 'bath'],
  ['wc', 'toilette'],
  ['gastewc', 'wc'],
  ['kuche', 'kitchen'],
  ['wohnzimmer', 'livingroom'],
  ['schlafzimmer', 'bedroom'],
  ['flur', 'diele'],
  ['flur', 'gang'],
  ['flur', 'hallway'],
  ['arbeitszimmer', 'buro'],
];
/** Same room? ("Bad" ~ "Badezimmer", "Küche" ~ "Kueche") */
export function sameRoom(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y))) return true;
  return SYNONYMS.some(([p, q]) => (x.startsWith(p) && y.startsWith(q)) || (x.startsWith(q) && y.startsWith(p)));
}

/** Rotation + uniform scale + offset (optionally mirrored) that best maps robot points onto plan points */
function procrustes(src: Point[], dst: Point[], w: number[], mirror: boolean): { tf: VacuumTransform; err: number } {
  const S = src.map(([x, y]) => [x, mirror ? -y : y] as Point);
  const W = w.reduce((a, b) => a + b, 0) || 1;
  const ms: Point = [0, 0];
  const md: Point = [0, 0];
  S.forEach((p, i) => {
    ms[0] += (p[0] * w[i]) / W;
    ms[1] += (p[1] * w[i]) / W;
    md[0] += (dst[i][0] * w[i]) / W;
    md[1] += (dst[i][1] * w[i]) / W;
  });
  let a = 0;
  let b = 0;
  let ss = 0;
  S.forEach((p, i) => {
    const sx = p[0] - ms[0];
    const sy = p[1] - ms[1];
    const dx = dst[i][0] - md[0];
    const dy = dst[i][1] - md[1];
    a += w[i] * (sx * dx + sy * dy);
    b += w[i] * (sx * dy - sy * dx);
    ss += w[i] * (sx * sx + sy * sy);
  });
  const ang = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / (ss || 1);
  const tf: VacuumTransform = { x: 0, y: 0, rot: ((ang * 180) / Math.PI + 360) % 360, scale, mirror };
  const m = toPlan(tf, src.reduce((s, p, i) => s + (p[0] * w[i]) / W, 0), src.reduce((s, p, i) => s + (p[1] * w[i]) / W, 0));
  tf.x = md[0] - m[0];
  tf.y = md[1] - m[1];
  let err = 0;
  src.forEach((p, i) => {
    const q = toPlan(tf, p[0], p[1]);
    err += w[i] * Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]);
  });
  return { tf, err: err / W };
}

/**
 * Lay the vacuum's own map onto the plan: rooms of the same name give rotation, mirror, scale and position at
 * once; then the map's walls are pulled onto the plan's walls and its floor into the rooms — fine turn, offset
 * and a scale per axis (a hand-drawn plan is rarely exact). Without matching names: a search like autoFit.
 */
export function autoFitMap(floor: FloorConfig, mapIn: VacuumMap, dockPiece?: Point, cut?: (x: number, y: number) => boolean): VacuumTransform | undefined {
  // areas cut out by hand (reflections, phantom rooms) do not count
  const map: VacuumMap = cut ? { ...mapIn, rooms: mapIn.rooms.map((r) => ({ ...r, pts: r.pts.filter(([x, y]) => !cut(x, y)) })), walls: mapIn.walls.filter(([x, y]) => !cut(x, y)) } : mapIn;
  const rooms = floor.rooms.filter((r) => !r.outdoor && r.points.length >= 3);
  if (!rooms.length || !map.rooms.length) return undefined;
  // plan mask: 1 room, 2 wall (7 cm), 3 near a wall (up to 20 cm, inside)
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
  const G = 5;
  minX -= 60;
  minY -= 60;
  maxX += 60;
  maxY += 60;
  const nx = Math.ceil((maxX - minX) / G) + 1;
  const ny = Math.ceil((maxY - minY) / G) + 1;
  // which room each cell lies in (index + 1, 0: none)
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = rooms.findIndex((r) => pointInPolygon([minX + i * G, minY + j * G], r.points));
      if (k >= 0) mask[j * nx + i] = k + 1;
    }
  // every wall line (doors included: the vacuum's map shows a wall line across a closed door, too)
  const walls = wallPieces(floor);
  const near = new Uint8Array(nx * ny); // 1: within 7 cm of a wall, 2: within 20 cm
  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const n = Math.max(1, Math.ceil(len / (G / 2)));
    for (let k = 0; k <= n; k++) {
      const cx = w.a[0] + ((w.b[0] - w.a[0]) * k) / n;
      const cy = w.a[1] + ((w.b[1] - w.a[1]) * k) / n;
      const i0 = Math.floor((cx - 20 - minX) / G);
      const j0 = Math.floor((cy - 20 - minY) / G);
      for (let j = j0; j <= j0 + 9; j++)
        for (let i = i0; i <= i0 + 9; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          const d = closestPointOnSegment([minX + i * G, minY + j * G], w.a, w.b).dist;
          const v = d < 7 ? 1 : d < 20 ? 2 : 0;
          if (v && (!near[j * nx + i] || v < near[j * nx + i])) near[j * nx + i] = v;
        }
    }
  }
  const look = (p: Point) => {
    const i = Math.round((p[0] - minX) / G);
    const j = Math.round((p[1] - minY) / G);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  // floor of the vacuum's rooms, each point with the plan room of the same name (0: no such room)
  const floorPts: Point[] = [];
  const floorRoom: number[] = [];
  for (const r of map.rooms) {
    const target = r.name ? rooms.findIndex((pr) => pr.name && sameRoom(pr.name, r.name!)) + 1 : 0;
    for (let i = 0; i < r.pts.length; i += Math.max(1, Math.floor(r.pts.length / 220))) {
      floorPts.push(r.pts[i]);
      floorRoom.push(target);
    }
  }
  const wallPts: Point[] = map.walls.filter((_, i) => i % Math.max(1, Math.floor(map.walls.length / 900)) === 0);
  const score = (tf: VacuumTransform) => {
    let s = 0;
    floorPts.forEach(([x, y], n) => {
      const k = look(toPlan(tf, x, y));
      // each room of the vacuum belongs into the plan's room of the same name: in another room is wrong; the
      // vacuum's map often shows more than the plan (balcony, closet, a niche): floor outside counts only a
      // little; floor on a wall line of the plan is wrong
      if (k < 0 || !mask[k]) s -= 0.25;
      else if (near[k] === 1) s -= 1.5;
      else if (floorRoom[n] && mask[k] !== floorRoom[n]) s -= 1;
      else s += 1;
    });
    let sw = 0;
    for (const [x, y] of wallPts) {
      const k = look(toPlan(tf, x, y));
      if (k < 0) continue;
      sw += near[k] === 1 ? 2 : near[k] === 2 ? 1 : mask[k] ? -1 : 0;
    }
    // the vacuum's "walls" also trace furniture: they only fine-tune, the rooms decide
    let v = s / floorPts.length + (0.6 * sw) / Math.max(1, wallPts.length);
    // a plan is drawn in proportion more often than not: different scales across / along need clear evidence
    const sx = tf.scale ?? 0.1;
    const sy = tf.scaleY ?? sx;
    v -= 1.5 * Math.abs(sx / sy - 1) + 0.2 * Math.abs((sx + sy) / 0.2 - 1);
    if (dockPiece && map.charger) {
      const d = toPlan(tf, map.charger[0], map.charger[1]);
      v -= Math.hypot(d[0] - dockPiece[0], d[1] - dockPiece[1]) / 4000;
    }
    return v;
  };
  // 1) rooms of the same name → first guess
  const centroid = (pts: Point[]): Point => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  const planCentroid = (r: (typeof rooms)[number]): Point => {
    const xs = r.points.map((p) => p[0]);
    const ys = r.points.map((p) => p[1]);
    const pts: Point[] = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 10) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 10) if (pointInPolygon([x, y], r.points)) pts.push([x, y]);
    return pts.length ? centroid(pts) : centroid(r.points);
  };
  const src: Point[] = [];
  const dst: Point[] = [];
  const wts: number[] = [];
  for (const mr of map.rooms) {
    if (!mr.name || mr.pts.length < 5) continue;
    const pr = rooms.find((r) => r.name && sameRoom(r.name, mr.name!));
    if (!pr) continue;
    src.push(centroid(mr.pts));
    dst.push(planCentroid(pr));
    wts.push(Math.sqrt(mr.pts.length));
  }
  let starts: VacuumTransform[] = [];
  if (src.length >= 2) {
    const a = procrustes(src, dst, wts, false);
    const b = procrustes(src, dst, wts, true);
    starts = [a.err <= b.err ? a.tf : b.tf, a.err <= b.err ? b.tf : a.tf];
  } else {
    // no names to go by: the learned-floor search on the map's floor
    const fit = autoFit(floor, { res: map.floor_res ?? 100, cells: map.rooms.flatMap((r) => r.pts.map(([x, y]) => [Math.floor(x / (map.floor_res ?? 100)), Math.floor(y / (map.floor_res ?? 100)), 1] as [number, number, number])), dock: map.charger ?? undefined }, dockPiece);
    if (fit) starts = [fit];
  }
  if (!starts.length) return undefined;
  // 2) refine each start: turn, offset, scale per axis (coordinate descent with shrinking steps); turning and
  // scaling keep the middle of the map where it is
  const mapMid = centroid(floorPts);
  const keepMid = (t: VacuumTransform, base: VacuumTransform): VacuumTransform => {
    const a = toPlan(base, mapMid[0], mapMid[1]);
    const b = toPlan(t, mapMid[0], mapMid[1]);
    return { ...t, x: t.x + a[0] - b[0], y: t.y + a[1] - b[1] };
  };
  let best: { tf: VacuumTransform; s: number } | undefined;
  for (const st of starts) {
    let cur = { ...st, scaleY: st.scaleY ?? st.scale };
    let cs = score(cur);
    for (const [dr, dt, ds] of [
      [2, 16, 0.004],
      [0.8, 6, 0.0015],
      [0.3, 2, 0.0005],
      [0.1, 1, 0.0002],
    ]) {
      for (let iter = 0; iter < 8; iter++) {
        let improved = false;
        const tries: VacuumTransform[] = [
          keepMid({ ...cur, rot: (cur.rot ?? 0) + dr }, cur),
          keepMid({ ...cur, rot: (cur.rot ?? 0) - dr }, cur),
          { ...cur, x: cur.x + dt },
          { ...cur, x: cur.x - dt },
          { ...cur, y: cur.y + dt },
          { ...cur, y: cur.y - dt },
          keepMid({ ...cur, scale: (cur.scale ?? 0.1) + ds }, cur),
          keepMid({ ...cur, scale: (cur.scale ?? 0.1) - ds }, cur),
          keepMid({ ...cur, scaleY: (cur.scaleY ?? 0.1) + ds }, cur),
          keepMid({ ...cur, scaleY: (cur.scaleY ?? 0.1) - ds }, cur),
        ];
        for (const t of tries) {
          const v = score(t);
          if (v > cs + 1e-6) {
            cur = { ...t, scaleY: t.scaleY ?? t.scale };
            cs = v;
            improved = true;
          }
        }
        if (!improved) break;
      }
    }
    if (!best || cs > best.s) best = { tf: cur, s: cs };
  }
  const r = best!.tf;
  const sx = Math.round((r.scale ?? 0.1) * 10000) / 10000;
  const sy = Math.round((r.scaleY ?? sx) * 10000) / 10000;
  return { x: Math.round(r.x), y: Math.round(r.y), rot: Math.round((((r.rot ?? 0) % 360) + 360) % 360 * 10) / 10, scale: sx, scaleY: sy !== sx ? sy : undefined, mirror: r.mirror || undefined };
}

/**
 * Pairs of points the user matched by hand (a spot on the vacuum's map ↔ the same spot on the plan): two pairs
 * give turn, size and position; from three pairs spread over the flat the width and height may differ a little.
 */
export function fitPairs(pairs: { robot: Point; plan: Point }[], mirror: boolean): VacuumTransform | undefined {
  if (pairs.length < 2) return undefined;
  const { tf } = procrustes(
    pairs.map((p) => p.robot),
    pairs.map((p) => p.plan),
    pairs.map(() => 1),
    mirror,
  );
  const s0 = tf.scale ?? 0;
  if (!(s0 > 0) || !isFinite(s0)) return undefined;
  let out: VacuumTransform = tf;
  if (pairs.length >= 3) {
    const a = ((tf.rot ?? 0) * Math.PI) / 180;
    const turned = pairs.map((p) => {
      const yy = mirror ? -p.robot[1] : p.robot[1];
      return [p.robot[0] * Math.cos(a) - yy * Math.sin(a), p.robot[0] * Math.sin(a) + yy * Math.cos(a)] as Point;
    });
    // per plan axis: plan = offset + scale · turned (least squares), only where the pairs spread along that axis
    const line = (u: number[], v: number[]) => {
      const mu = u.reduce((s, x) => s + x, 0) / u.length;
      const mv = v.reduce((s, x) => s + x, 0) / v.length;
      let num = 0;
      let den = 0;
      u.forEach((x, i) => {
        num += (x - mu) * (v[i] - mv);
        den += (x - mu) ** 2;
      });
      const k = den ? num / den : 0;
      return { k, d: mv - k * mu, spread: Math.sqrt(den / u.length) };
    };
    const lx = line(turned.map((p) => p[0]), pairs.map((p) => p.plan[0]));
    const ly = line(turned.map((p) => p[1]), pairs.map((p) => p.plan[1]));
    const ok = (l: { k: number; spread: number }) => l.k > 0 && l.spread * l.k > 60 && Math.abs(l.k / s0 - 1) < 0.25;
    if (ok(lx) && ok(ly)) out = { ...tf, x: lx.d, y: ly.d, scale: lx.k, scaleY: ly.k };
  }
  const sx = Math.round((out.scale ?? s0) * 10000) / 10000;
  const sy = Math.round((out.scaleY ?? out.scale ?? s0) * 10000) / 10000;
  return { x: Math.round(out.x), y: Math.round(out.y), rot: Math.round((((out.rot ?? 0) % 360) + 360) % 360 * 10) / 10, scale: sx, scaleY: sy !== sx ? sy : undefined, mirror: mirror || undefined };
}

/** How well each room of the vacuum's map lies in the plan's room of the same name (share of its floor, 0..1) */
export function roomMatch(floor: FloorConfig, map: VacuumMap, m: VacuumMapper): { id: string; name: string; plan?: string; share: number }[] {
  const rooms = floor.rooms.filter((r) => !r.outdoor && r.points.length >= 3);
  return map.rooms
    .filter((r) => r.pts.length)
    .map((r) => {
      const pr = r.name ? rooms.find((x) => x.name && sameRoom(x.name, r.name!)) : undefined;
      if (!pr) return { id: r.id, name: r.name ?? '?', share: 0 };
      const step = Math.max(1, Math.floor(r.pts.length / 160));
      let n = 0;
      let inside = 0;
      for (let i = 0; i < r.pts.length; i += step) {
        const [x, y] = r.pts[i];
        if (m.cut(x, y)) continue;
        n++;
        if (pointInPolygon(m.toPlan(x, y, r.id), pr.points)) inside++;
      }
      return { id: r.id, name: r.name ?? '?', plan: pr.id, share: n ? inside / n : 0 };
    });
}


/**
 * Robot (mm) → plan (cm) for a vacuum with its whole-map alignment, rooms placed on their own and areas cut out.
 * Which room a robot point belongs to comes from the vacuum's map (its floor cells, a few cells around).
 */
export class VacuumMapper {
  private grid = new Map<string, string>();
  private res: number;
  private centres = new Map<string, Point>();

  constructor(
    readonly tf: VacuumTransform,
    readonly rooms: Record<string, VacuumRoomFit> | undefined,
    readonly crop: [number, number][][] | undefined,
    readonly map?: VacuumMap | null,
  ) {
    this.res = map?.floor_res ?? 100;
    if (map)
      for (const r of map.rooms) for (const [x, y] of r.pts) this.grid.set(`${Math.floor(x / this.res)},${Math.floor(y / this.res)}`, r.id);
    for (const [id, a] of Object.entries(rooms ?? {})) this.centres.set(id, toPlan(tf, a.c[0], a.c[1]));
  }

  /** Inside an area cut out of the map */
  cut(x: number, y: number): boolean {
    return !!this.crop?.some((poly) => pointInPolygon([x, y], poly));
  }

  /** The vacuum-map room a robot point belongs to (its floor, or right next to it: walls) */
  roomOf(x: number, y: number): string | undefined {
    if (!this.grid.size) return undefined;
    const cx = Math.floor(x / this.res);
    const cy = Math.floor(y / this.res);
    for (let r = 0; r <= 3; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const id = this.grid.get(`${cx + dx},${cy + dy}`);
          if (id) return id;
        }
    return undefined;
  }

  /** Plan point of a robot point; `room` forces the room (undefined: looked up, null: the whole map only) */
  toPlan(x: number, y: number, room?: string | null): Point {
    const p = toPlan(this.tf, x, y);
    const id = room === null ? undefined : (room ?? this.roomOf(x, y));
    const a = id ? this.rooms?.[id] : undefined;
    return a ? adjust(a, this.centres.get(id!)!, p) : p;
  }

  /** Robot point of a plan point (inverse; the room is found from the whole-map guess, or given) */
  toRobot(px: number, py: number, room?: string | null): Point {
    const q = toRobot(this.tf, px, py);
    const id = room === null ? undefined : (room ?? this.roomOf(q[0], q[1]));
    const a = id ? this.rooms?.[id] : undefined;
    if (!a) return q;
    const p = unadjust(a, this.centres.get(id!)!, [px, py]);
    return toRobot(this.tf, p[0], p[1]);
  }
}

/** A room's own placement: stretch and turn about its middle (plan), then move */
export function adjust(a: VacuumRoomFit, c: Point, p: Point): Point {
  const sx = a.scale ?? 1;
  const sy = a.scaleY ?? sx;
  const r = ((a.rot ?? 0) * Math.PI) / 180;
  const vx = (p[0] - c[0]) * sx;
  const vy = (p[1] - c[1]) * sy;
  return [c[0] + vx * Math.cos(r) - vy * Math.sin(r) + (a.x ?? 0), c[1] + vx * Math.sin(r) + vy * Math.cos(r) + (a.y ?? 0)];
}

function unadjust(a: VacuumRoomFit, c: Point, p: Point): Point {
  const sx = a.scale ?? 1;
  const sy = a.scaleY ?? sx;
  const r = (-(a.rot ?? 0) * Math.PI) / 180;
  const ux = p[0] - (a.x ?? 0) - c[0];
  const uy = p[1] - (a.y ?? 0) - c[1];
  return [c[0] + (ux * Math.cos(r) - uy * Math.sin(r)) / sx, c[1] + (ux * Math.sin(r) + uy * Math.cos(r)) / sy];
}

/** The mapper of a vacuum piece's settings */
export function mapperOf(v: { transform?: VacuumTransform; rooms?: Record<string, VacuumRoomFit>; crop?: [number, number][][] } | undefined, map?: VacuumMap | null): VacuumMapper | undefined {
  return v?.transform ? new VacuumMapper(v.transform, v.rooms, v.crop, map) : undefined;
}
