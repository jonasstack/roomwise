import type { FloorConfig, Point, VacuumRoomFit, VacuumTransform } from './types';

/**
 * Turning a whole floor "the right way round": quarter turns, a fine angle and a mirror (some robot maps come
 * mirrored). Everything on the floor goes along – rooms (outline, label anchor), doors and windows, devices, pieces
 * (with their rotation), the tracing image – and a robot vacuum's live alignment (its transform and the rooms placed
 * by hand) is turned with it, so the vacuum still drives where it really is.
 *
 * The turn happens about the middle of what is drawn; afterwards the floor's top-left corner is where it was (or at
 * `origin`). Values that depend on the old orientation and are found again by themselves (engraved-value spots, a
 * room's zoom side) are dropped.
 */
export interface FloorTurn {
  /** degrees, clockwise (screen), any angle – usually quarter turns plus a small correction */
  deg: number;
  /** mirror left ↔ right (before turning) */
  mirror?: boolean;
}

type M = [number, number, number, number]; // a b / c d: x' = a x + b y, y' = c x + d y

function matrix(t: FloorTurn): M {
  const r = (t.deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const f = t.mirror ? -1 : 1;
  // R(deg) · diag(f, 1)
  return [c * f, -s, s * f, c];
}

const round = (v: number) => Math.round(v * 10) / 10;

/** The bounding box of what is drawn on a floor (rooms, else everything else) */
export function floorBox(f: FloorConfig): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const pts: Point[] = [...f.rooms.flatMap((r) => r.points), ...(f.openings ?? []).flatMap((o) => [o.a, o.b]), ...f.devices.map((d): Point => [d.x, d.y]), ...(f.furniture ?? []).map((p): Point => [p.x, p.y])];
  if (!pts.length) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** A copy of the floor, turned (see above). `origin`: where its top-left corner goes (default: where it was). */
export function turnFloor(floor: FloorConfig, turn: FloorTurn, origin?: Point): FloorConfig {
  const f: FloorConfig = structuredClone(floor);
  if (!turn.deg && !turn.mirror) {
    if (origin) shiftTo(f, origin);
    return f;
  }
  const box = floorBox(f);
  if (!box) return f;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const [a, b, c, d] = matrix(turn);
  const lin = (x: number, y: number): Point => [a * x + b * y, c * x + d * y];
  const map = (p: Point): Point => {
    const [x, y] = lin(p[0] - cx, p[1] - cy);
    return [x + cx, y + cy];
  };
  const mp = (p: Point): Point => {
    const q = map(p);
    return [round(q[0]), round(q[1])];
  };
  /** a direction in degrees (clockwise) after the turn */
  const dir = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    const [x, y] = lin(Math.cos(r), Math.sin(r));
    return norm((Math.atan2(y, x) * 180) / Math.PI);
  };
  const flipped = !!turn.mirror;
  for (const r of f.rooms) {
    r.points = r.points.map(mp);
    if (r.label) r.label = mp(r.label);
    delete r.label_spots;
    delete r.view_angle;
  }
  for (const o of f.openings ?? []) {
    o.a = mp(o.a);
    o.b = mp(o.b);
    // a mirror swaps the wall's sides: the door still swings into the same room
    if (flipped) o.flip = !o.flip || undefined;
  }
  for (const dv of f.devices) [dv.x, dv.y] = mp([dv.x, dv.y]);
  for (const p of f.furniture ?? []) {
    [p.x, p.y] = mp([p.x, p.y]);
    if (p.rotation || turn.deg) {
      const rot = Math.round(dir(p.rotation ?? 0));
      p.rotation = rot ? rot : undefined;
      if (p.rotation === undefined) delete p.rotation;
    }
    if (p.vacuum?.transform) p.vacuum.transform = turnTransform(p.vacuum.transform, [a, b, c, d], [cx, cy]);
    if (p.vacuum?.rooms) for (const fit of Object.values(p.vacuum.rooms)) turnFit(fit, [a, b, c, d], flipped, turn.deg);
  }
  if (f.trace) {
    const h = f.trace.w * f.trace.ratio;
    const m = map([f.trace.x + f.trace.w / 2, f.trace.y + h / 2]);
    f.trace.x = round(m[0] - f.trace.w / 2);
    f.trace.y = round(m[1] - h / 2);
    const rot = Math.round(norm((f.trace.rotation ?? 0) + turn.deg));
    f.trace.rotation = rot || undefined;
    if (!f.trace.rotation) delete f.trace.rotation;
  }
  shiftTo(f, origin ?? [box.minX, box.minY]);
  return f;
}

/** The robot's alignment after the plan was turned: toPlan(new, q) = G(toPlan(old, q)) */
export function turnTransform(tf: VacuumTransform, m: M, c: Point): VacuumTransform {
  const [a, b, cc, d] = m;
  const r = ((tf.rot ?? 0) * Math.PI) / 180;
  // the map's x axis in the plan, turned: its angle is the new rotation; a mirror flips the robot's y
  const vx = a * Math.cos(r) + b * Math.sin(r);
  const vy = cc * Math.cos(r) + d * Math.sin(r);
  const det = a * d - b * cc;
  const px = tf.x - c[0];
  const py = tf.y - c[1];
  const out: VacuumTransform = { ...tf, x: round(a * px + b * py + c[0]), y: round(cc * px + d * py + c[1]), rot: round((Math.atan2(vy, vx) * 180) / Math.PI) };
  const mirror = !!tf.mirror !== det < 0;
  if (mirror) out.mirror = true;
  else delete out.mirror;
  // a quarter turn swaps a plan drawn a little out of proportion
  if (tf.scaleY !== undefined && Math.abs(b) > Math.abs(a)) {
    out.scaleY = tf.scale ?? 0.1;
    out.scale = tf.scaleY;
  }
  return out;
}

function turnFit(fit: VacuumRoomFit, m: M, flipped: boolean, deg: number) {
  const [a, b, c, d] = m;
  const x = fit.x ?? 0;
  const y = fit.y ?? 0;
  if (x || y) {
    fit.x = round(a * x + b * y);
    fit.y = round(c * x + d * y);
  }
  if (fit.rot) fit.rot = round(flipped ? -fit.rot : fit.rot);
  if (fit.scaleY !== undefined && Math.round(deg / 90) % 2 !== 0) [fit.scale, fit.scaleY] = [fit.scaleY, fit.scale ?? 1];
}

/** Move everything so the drawn part's top-left corner is at `to` */
function shiftTo(f: FloorConfig, to: Point) {
  const box = floorBox(f);
  if (!box) return;
  const dx = round(to[0] - box.minX);
  const dy = round(to[1] - box.minY);
  if (!dx && !dy) return;
  const mv = (p: Point): Point => [round(p[0] + dx), round(p[1] + dy)];
  for (const r of f.rooms) {
    r.points = r.points.map(mv);
    if (r.label) r.label = mv(r.label);
  }
  for (const o of f.openings ?? []) {
    o.a = mv(o.a);
    o.b = mv(o.b);
  }
  for (const dv of f.devices) [dv.x, dv.y] = mv([dv.x, dv.y]);
  for (const p of f.furniture ?? []) {
    [p.x, p.y] = mv([p.x, p.y]);
    if (p.vacuum?.transform) p.vacuum.transform = { ...p.vacuum.transform, x: round(p.vacuum.transform.x + dx), y: round(p.vacuum.transform.y + dy) };
  }
  if (f.trace) {
    f.trace.x = round(f.trace.x + dx);
    f.trace.y = round(f.trace.y + dy);
  }
}

function norm(deg: number) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.abs(d) < 1e-6 ? 0 : d;
}
