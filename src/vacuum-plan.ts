import type { FloorConfig, FloorplanCardConfig, FurnitureConfig, HomeAssistant, OpeningConfig, Point, RoomConfig, VacuumTransform } from './types';
import { sameRoom, toPlan, type VacuumMap } from './vacuum-live';
import { suggestForArea } from './ha';
import { t } from './i18n';
import type { VacuumMapEntry } from './entry-server';
import { floorNameFor, haFloorsSorted, skeletonFloors, type HomeKind } from './home-floors';

/**
 * A floor plan from a robot vacuum's own map (first steps "from the vacuum's map").
 *
 * The map (companion: Roborock, map camera, Valetudo) has, per room, the floor it painted as sample points and the
 * walls as points, in robot millimetres. From that:
 *   1. the map's main direction (walls are mostly at right angles): the plan is turned so walls run straight;
 *   2. every room's floor on a grid (one cell = the map's floor resolution), cleaned up: the biggest piece of each
 *      room, holes (furniture the robot cannot reach) filled, rooms grown into the walls between them so
 *      neighbours meet in the middle and outer walls sit where the map's walls are;
 *   3. each room's outline, simplified (staircases straightened, near-right angles snapped, tiny jogs dropped) and
 *      walls of all rooms that lie on one line put onto exactly that line — no gaps, no overlaps;
 *   4. doors where two rooms' floors touch with wall on both sides of the gap (a doorway), only when clearly so;
 *   5. the vacuum and its dock as pieces, the vacuum already aligned (the same transform), so the live view works
 *      without "lay the map onto the plan".
 * Plan units are cm. Nothing is saved here — the editor opens with the result as an unsaved draft.
 */

export interface VacuumPlanResult {
  floor: FloorConfig;
  transform: VacuumTransform;
  /** rooms that were too small or had no outline (left out) */
  skipped: number;
}

type Line = { k: 'h' | 'v' | 'd'; c: number; a: Point; b: Point; len: number };

const DEG = Math.PI / 180;
/** how far (cm) a corner may move from where the outline had it when two walls are made to meet */
let reach = 40;

/** The angle (degrees, -45…45) that turns the map so most walls run along x and y */
export function mainAngle(pts: [number, number][], mirror: boolean): number {
  if (pts.length < 20) return 0;
  const step = Math.max(1, Math.floor(pts.length / 6000));
  const sample: [number, number][] = [];
  for (let i = 0; i < pts.length; i += step) sample.push([pts[i][0], mirror ? -pts[i][1] : pts[i][1]]);
  const score = (deg: number) => {
    const a = deg * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const hx = new Map<number, number>();
    const hy = new Map<number, number>();
    for (const [x, y] of sample) {
      const bx = Math.round((x * c - y * s) / 50);
      const by = Math.round((x * s + y * c) / 50);
      hx.set(bx, (hx.get(bx) ?? 0) + 1);
      hy.set(by, (hy.get(by) ?? 0) + 1);
    }
    let sum = 0;
    for (const v of hx.values()) sum += v * v;
    for (const v of hy.values()) sum += v * v;
    return sum;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -45; d < 45; d += 1) {
    const sc = score(d);
    if (sc > bestScore) [best, bestScore] = [d, sc];
  }
  for (let d = best - 1; d <= best + 1; d += 0.2) {
    const sc = score(d);
    if (sc > bestScore) [best, bestScore] = [d, sc];
  }
  // a map that is already straight stays exactly straight
  return Math.abs(best) < 0.6 ? 0 : Math.round(best * 10) / 10;
}

/** Grid of room labels with helpers */
class Grid {
  lab: Int16Array;
  wall: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.lab = new Int16Array(w * h).fill(-1);
    this.wall = new Uint8Array(w * h);
  }
  at(i: number, j: number) {
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : this.lab[j * this.w + i];
  }
}

const N4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Keep only the biggest 4-connected piece of every label */
function keepBiggest(g: Grid, labels: number) {
  const seen = new Uint8Array(g.w * g.h);
  const best: number[][] = Array.from({ length: labels }, () => []);
  for (let p = 0; p < g.lab.length; p++) {
    const l = g.lab[p];
    if (l < 0 || seen[p]) continue;
    const comp: number[] = [];
    const stack = [p];
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      comp.push(q);
      const i = q % g.w;
      const j = (q - i) / g.w;
      for (const [di, dj] of N4) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const r = nj * g.w + ni;
        if (!seen[r] && g.lab[r] === l) {
          seen[r] = 1;
          stack.push(r);
        }
      }
    }
    if (comp.length > best[l].length) {
      for (const q of best[l]) g.lab[q] = -1;
      best[l] = comp;
    } else for (const q of comp) g.lab[q] = -1;
  }
  return best.map((c) => c.length);
}

/** Empty cells that take the label most of their 4 neighbours have (all at once per round) */
function grow(g: Grid, rounds: number, may: (p: number) => boolean) {
  for (let r = 0; r < rounds; r++) {
    const next: [number, number][] = [];
    for (let j = 0; j < g.h; j++)
      for (let i = 0; i < g.w; i++) {
        const p = j * g.w + i;
        if (g.lab[p] >= 0 || !may(p)) continue;
        const votes = new Map<number, number>();
        for (const [di, dj] of N4) {
          const l = g.at(i + di, j + dj);
          if (l >= 0) votes.set(l, (votes.get(l) ?? 0) + 1);
        }
        let bl = -1;
        let bv = 0;
        for (const [l, v] of votes) if (v > bv) [bl, bv] = [l, v];
        if (bl >= 0) next.push([p, bl]);
      }
    if (!next.length) return;
    for (const [p, l] of next) g.lab[p] = l;
  }
}

/** Smooth: a cell whose 8 neighbours mostly disagree takes their majority (spikes, single-cell bites) */
function smooth(g: Grid) {
  const next = g.lab.slice();
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      const p = j * g.w + i;
      const votes = new Map<number, number>();
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const l = g.at(i + di, j + dj);
          votes.set(l, (votes.get(l) ?? 0) + 1);
        }
      let bl = g.lab[p];
      let bv = 0;
      for (const [l, v] of votes) if (v > bv) [bl, bv] = [l, v];
      if (bv >= 6 && bl !== g.lab[p]) next[p] = bl;
    }
  g.lab = next;
}

/** Outline of one label's cells (grid corners, counter-clockwise in grid space), the biggest loop */
function outline(g: Grid, l: number): Point[] {
  // directed boundary edges with the room on the left: corners (i, j) = cell corner top-left of cell (i, j)
  const out = new Map<number, number[]>();
  const W = g.w + 1;
  const key = (i: number, j: number) => j * W + i;
  const add = (a: number, b: number) => {
    const l2 = out.get(a);
    if (l2) l2.push(b);
    else out.set(a, [b]);
  };
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      if (g.lab[j * g.w + i] !== l) continue;
      if (g.at(i, j - 1) !== l) add(key(i + 1, j), key(i, j)); // top edge, right → left
      if (g.at(i, j + 1) !== l) add(key(i, j + 1), key(i + 1, j + 1)); // bottom, left → right
      if (g.at(i - 1, j) !== l) add(key(i, j), key(i, j + 1)); // left, top → bottom
      if (g.at(i + 1, j) !== l) add(key(i + 1, j + 1), key(i + 1, j)); // right, bottom → top
    }
  let best: Point[] = [];
  let bestArea = 0;
  const dir = (a: number, b: number): Point => [(b % W) - (a % W), Math.floor(b / W) - Math.floor(a / W)];
  while (out.size) {
    const start = out.keys().next().value as number;
    const loop: number[] = [start];
    let cur = start;
    let prev: Point | undefined;
    for (let guard = 0; guard < 200000; guard++) {
      const nexts = out.get(cur);
      if (!nexts?.length) break;
      let pick = 0;
      if (nexts.length > 1 && prev) {
        // at a corner where two pieces touch diagonally: turn left (keeps one 4-connected piece together)
        const left: Point = [prev[1], -prev[0]];
        const k = nexts.findIndex((n) => {
          const d = dir(cur, n);
          return d[0] === left[0] && d[1] === left[1];
        });
        if (k >= 0) pick = k;
      }
      const nxt = nexts.splice(pick, 1)[0];
      if (!nexts.length) out.delete(cur);
      prev = dir(cur, nxt);
      cur = nxt;
      if (cur === start) break;
      loop.push(cur);
    }
    const pts = loop.map((k): Point => [k % W, Math.floor(k / W)]);
    let area = 0;
    for (let a = 0; a < pts.length; a++) {
      const [x0, y0] = pts[a];
      const [x1, y1] = pts[(a + 1) % pts.length];
      area += x0 * y1 - x1 * y0;
    }
    if (Math.abs(area) > bestArea) [best, bestArea] = [pts, Math.abs(area)];
  }
  return best;
}

/** Douglas–Peucker on a closed polygon */
function simplify(pts: Point[], eps: number): Point[] {
  if (pts.length <= 4) return pts;
  // split at the two points farthest apart
  let ia = 0;
  let ib = 0;
  let far = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > far) [ib, far] = [i, d];
  }
  const dp = (a: number, b: number, list: Point[]): Point[] => {
    const [x0, y0] = list[a];
    const [x1, y1] = list[b];
    const L = Math.hypot(x1 - x0, y1 - y0) || 1;
    let idx = -1;
    let md = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((x1 - x0) * (y0 - list[i][1]) - (x0 - list[i][0]) * (y1 - y0)) / L;
      if (d > md) [idx, md] = [i, d];
    }
    if (md <= eps || idx < 0) return [list[a]];
    return [...dp(a, idx, list), ...dp(idx, b, list)];
  };
  const ring = [...pts, pts[0]];
  return [...dp(ia, ib, ring), ...dp(ib, ring.length - 1, ring)];
}

/** Edges of a polygon as lines: near-horizontal / near-vertical ones straight (h: y = c, v: x = c) */
function lines(pts: Point[], tol: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const k: Line['k'] = Math.abs(dy) <= Math.abs(dx) * tol ? 'h' : Math.abs(dx) <= Math.abs(dy) * tol ? 'v' : 'd';
    out.push({ k, c: k === 'h' ? (a[1] + b[1]) / 2 : k === 'v' ? (a[0] + b[0]) / 2 : 0, a, b, len });
  }
  return out;
}

/** Neighbouring lines of the same direction become one (length-weighted) */
function mergeRuns(ls: Line[]): Line[] {
  const join = (p: Line, q: Line): Line => {
    const len = p.len + q.len;
    return { k: p.k, c: (p.c * p.len + q.c * q.len) / len, a: p.a, b: q.b, len };
  };
  const out: Line[] = [];
  for (const l of ls) {
    const last = out[out.length - 1];
    if (last && last.k !== 'd' && last.k === l.k) out[out.length - 1] = join(last, l);
    else out.push(l);
  }
  while (out.length > 3 && out[0].k !== 'd' && out[0].k === out[out.length - 1].k) out.splice(0, 1, join(out.pop()!, out[0]));
  return out;
}

function meet(p: Line, q: Line): Point {
  if (p.k === 'h' && q.k === 'v') return [q.c, p.c];
  if (p.k === 'v' && q.k === 'h') return [p.c, q.c];
  const seg = (l: Line): [Point, Point] => (l.k === 'h' ? [[l.a[0], l.c], [l.b[0], l.c]] : l.k === 'v' ? [[l.c, l.a[1]], [l.c, l.b[1]]] : [l.a, l.b]);
  const [a1, a2] = seg(p);
  const [b1, b2] = seg(q);
  const d1: Point = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2: Point = [b2[0] - b1[0], b2[1] - b1[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return [(a2[0] + b1[0]) / 2, (a2[1] + b1[1]) / 2];
  const s = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
  const x = a1[0] + s * d1[0];
  const y = a1[1] + s * d1[1];
  // far off (nearly parallel lines): the original corner
  if (Math.hypot(x - a2[0], y - a2[1]) > reach) return [(a2[0] + b1[0]) / 2, (a2[1] + b1[1]) / 2];
  return [x, y];
}

function corners(ls: Line[]): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < ls.length; i++) pts.push(meet(ls[(i + ls.length - 1) % ls.length], ls[i]));
  // drop repeated and collinear corners
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.5) out.pop();
  const clean: Point[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i + out.length - 1) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 0.5) clean.push(b);
  }
  return clean;
}

/** Short edges (jogs and cut corners under `min` cm) dropped: their neighbours meet instead */
function dropJogs(ls: Line[], min: number): Line[] {
  let list = ls.slice();
  for (let round = 0; round < 200 && list.length > 4; round++) {
    const pts = list.map((l, i) => meet(list[(i + list.length - 1) % list.length], l));
    let k = -1;
    let shortest = Infinity;
    for (let i = 0; i < list.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // a slanted bit between a straight wall and one at right angles to it is a cut corner (up to 3× as long)
      const p = list[(i + list.length - 1) % list.length].k;
      const n = list[(i + 1) % list.length].k;
      const cutCorner = list[i].k === 'd' && p !== 'd' && n !== 'd' && p !== n;
      if (len < (cutCorner ? min * 3 : min) && len < shortest) [k, shortest] = [i, len];
    }
    if (k < 0) break;
    list.splice(k, 1);
    list = mergeRuns(list);
  }
  return list;
}

/** Walls of all rooms that lie (almost) on one line go onto exactly that line */
function snapAll(rooms: Line[][], tol: number) {
  for (const k of ['h', 'v'] as const) {
    const all = rooms.flat().filter((l) => l.k === k).sort((a, b) => a.c - b.c);
    let group: Line[] = [];
    const flush = () => {
      if (!group.length) return;
      const len = group.reduce((s, l) => s + l.len, 0);
      const c = Math.round(group.reduce((s, l) => s + l.c * l.len, 0) / len);
      for (const l of group) l.c = c;
      group = [];
    };
    for (const l of all) {
      if (group.length && l.c - group[0].c > tol) flush();
      group.push(l);
    }
    flush();
  }
}

/**
 * Plan of one floor from the vacuum's map. `adapter`: where the map comes from (decides which way up it is);
 * `hass`: links rooms to Home Assistant areas of the same name (with their lights and sensors).
 */
export function planFromVacuumMap(map: VacuumMap, opts: { entity: string; adapter?: string | null; hass?: HomeAssistant; floorId?: string; floorName?: string; idPrefix?: string; robot?: boolean }): VacuumPlanResult | undefined {
  const px = opts.idPrefix ?? '';
  const rooms = map.rooms.filter((r) => r.pts.length >= 4);
  if (!rooms.length) return undefined;
  // Roborock and map cameras count y up (like a drawing), Valetudo down (like an image); the plan counts down
  const mirror = opts.adapter !== 'valetudo';
  const cellMm = Math.max(50, Math.min(200, map.floor_res ?? 100));
  const cell = cellMm / 10;
  reach = cell * 4;
  const allFloor = rooms.flatMap((r) => r.pts);
  const rot = mainAngle(map.walls.length >= 200 ? map.walls : allFloor, mirror);
  const tf0: VacuumTransform = { x: 0, y: 0, rot, scale: 0.1, ...(mirror ? { mirror: true } : {}) };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of allFloor) {
    const [px, py] = toPlan(tf0, x, y);
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  // the plan starts at (0, 0) with a little margin for the outer walls
  const tf: VacuumTransform = { ...tf0, x: Math.round(-minX + 30), y: Math.round(-minY + 30) };
  const pad = 14; // room around the floor for the outer walls and what lies outside them (the gap closing needs it)
  const ox = 30 - pad * cell;
  const oy = 30 - pad * cell;
  const W = Math.ceil((maxX - minX) / cell) + 2 * pad + 1;
  const H = Math.ceil((maxY - minY) / cell) + 2 * pad + 1;
  if (W * H > 4_000_000) return undefined;
  const g = new Grid(W, H);
  const cellOf = (x: number, y: number): number => {
    const [px, py] = toPlan(tf, x, y);
    const i = Math.round((px - ox) / cell);
    const j = Math.round((py - oy) / cell);
    return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
  };
  rooms.forEach((r, l) => {
    for (const [x, y] of r.pts) {
      const p = cellOf(x, y);
      if (p >= 0 && g.lab[p] < 0) g.lab[p] = l;
    }
  });
  for (const [x, y] of map.walls) {
    const p = cellOf(x, y);
    if (p >= 0) g.wall[p] = 1;
  }
  // a turned map leaves single empty cells between samples: close them first
  grow(g, 1, (p) => !g.wall[p] && countAround(g, p) >= 3);
  keepBiggest(g, rooms.length);
  // the raw floor (for doors): where two rooms touch without a wall between them
  const raw = g.lab.slice();
  // Everything inside the home goes to the nearest room: walls between rooms are split in their middle, furniture
  // and obstacles the robot drives around (drawn like walls) become floor of their room. "Outside" is what can be
  // reached from the map's edge without crossing floor or wall.
  // wall seen far from any floor (through a window, a mirror) is not a wall of the home
  dropStrayWalls(g, Math.round(50 / cell));
  const outside = outsideOf(g, Math.round(70 / cell));
  // the thickened walls must not leave a seam of "inside" along the outer walls: outside grows back up to them
  nearest(g, (p) => !outside[p]);
  // outer walls: the outermost layer stays outside, so the room ends about in the middle of the wall
  trimOuter(g, outside);
  // per room: thin bits sticking out (under about 30 cm wide) cut off, narrow bays (under 80 cm) filled where free
  shape(g, rooms.length, Math.max(1, Math.round(10 / cell)), Math.max(1, Math.round(40 / cell)));
  smooth(g);
  smooth(g);
  const sizes = keepBiggest(g, rooms.length);

  // outlines → straight walls
  const minCells = Math.ceil(5000 / (cell * cell)); // 0.5 m²
  const outlines: { l: number; ls: Line[] }[] = [];
  let skipped = 0;
  rooms.forEach((_, l) => {
    if (sizes[l] < minCells) {
      skipped++;
      return;
    }
    const grid = outline(g, l);
    if (grid.length < 4) {
      skipped++;
      return;
    }
    const pts = grid.map(([i, j]): Point => [ox + (i - 0.5) * cell, oy + (j - 0.5) * cell]);
    const simple = simplify(pts, cell * 0.9);
    let ls = mergeRuns(lines(simple, Math.tan(14 * DEG)));
    ls = dropJogs(ls, cell * 3);
    if (ls.length < 3) {
      skipped++;
      return;
    }
    outlines.push({ l, ls });
  });
  snapAll(
    outlines.map((o) => o.ls),
    cell * 1.5,
  );
  const areas = Object.values(opts.hass?.areas ?? {});
  const usedAreas = new Set<string>();
  let unnamed = 0;
  const roomCfgs: RoomConfig[] = [];
  const idOf = new Map<number, string>();
  for (const { l, ls } of outlines) {
    const pts = corners(ls).map(([x, y]): Point => [Math.round(x), Math.round(y)]);
    if (pts.length < 3) {
      skipped++;
      continue;
    }
    const src = rooms[l];
    const name = src.name?.trim() || t('vacplan.room_n', { n: ++unnamed });
    const area = src.name ? areas.find((a) => !usedAreas.has(a.area_id) && sameRoom(a.name, src.name!)) : undefined;
    const id = `room_vac_${px}${String(src.id).replace(/[^a-zA-Z0-9_]/g, '') || l}`;
    idOf.set(l, id);
    const room: RoomConfig = { id, name, points: pts };
    if (area && opts.hass) {
      usedAreas.add(area.area_id);
      const s = suggestForArea(opts.hass, area.area_id);
      Object.assign(room, { area: area.area_id, lights: s.lights, temperature: s.temperature, humidity: s.humidity, climate: s.climate });
      for (const k of ['temperature', 'humidity', 'climate'] as const) if (!room[k]) delete room[k];
    }
    roomCfgs.push(room);
  }
  if (!roomCfgs.length) return undefined;

  const openings = doors(g.w, g.h, raw, g.wall, ox, oy, cell, roomCfgs, idOf).map((o) => ({ ...o, id: `${o.id}${px ? '_' + px : ''}` }));

  const furniture: FurnitureConfig[] = [];
  const charger = map.charger ? toPlan(tf, map.charger[0], map.charger[1]) : undefined;
  const at: Point = charger ?? centre(roomCfgs[0].points);
  if (charger) furniture.push({ id: `vac_dock${px ? '_' + px : ''}`, kind: 'robot_dock', x: Math.round(at[0]), y: Math.round(at[1]), w: 45, h: 45 });
  // the vacuum just in front of its dock, towards the middle of the home
  const all = roomCfgs.flatMap((r) => r.points);
  const mid = centre(all);
  const len = Math.hypot(mid[0] - at[0], mid[1] - at[1]) || 1;
  const off = charger ? 40 : 0;
  if (opts.robot !== false)
    furniture.push({ id: `vac_robot${px ? '_' + px : ''}`, kind: 'robot_vacuum', x: Math.round(at[0] + ((mid[0] - at[0]) / len) * off), y: Math.round(at[1] + ((mid[1] - at[1]) / len) * off), w: 35, h: 35, entity: opts.entity, vacuum: { transform: tf } });

  return {
    floor: { id: opts.floorId ?? 'floor_vacuum', name: opts.floorName ?? t('card.default_floor'), rooms: roomCfgs, devices: [], openings, furniture, grid_snap: false },
    transform: tf,
    skipped,
  };
}

/** Cells reachable from the grid's border through cells that are neither floor nor wall. Gaps in the walls up to
 * about `gap` cells (windows, a door to the balcony the robot never went through) count as closed. */
function outsideOf(g: Grid, gap: number): Uint8Array {
  // walls thickened by gap/2 on each side: a barrier with the small gaps closed
  const r = Math.max(0, Math.round(gap / 2));
  const rows = new Uint8Array(g.w * g.h);
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      if (!g.wall[j * g.w + i]) continue;
      for (let d = -r; d <= r; d++) if (i + d >= 0 && i + d < g.w) rows[j * g.w + i + d] = 1;
    }
  const barrier = new Uint8Array(g.w * g.h);
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      if (!rows[j * g.w + i]) continue;
      for (let d = -r; d <= r; d++) if (j + d >= 0 && j + d < g.h) barrier[(j + d) * g.w + i] = 1;
    }
  const out = new Uint8Array(g.w * g.h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (g.lab[p] < 0 && !barrier[p] && !out[p]) {
      out[p] = 1;
      stack.push(p);
    }
  };
  for (let i = 0; i < g.w; i++) {
    push(i);
    push((g.h - 1) * g.w + i);
  }
  for (let j = 0; j < g.h; j++) {
    push(j * g.w);
    push(j * g.w + g.w - 1);
  }
  while (stack.length) {
    const q = stack.pop()!;
    const i = q % g.w;
    const j = (q - i) / g.w;
    for (const [di, dj] of N4) {
      const ni = i + di;
      const nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < g.w && nj < g.h) push(nj * g.w + ni);
    }
  }
  // back up to the real walls (the thickening only closes gaps): a few steps through free cells
  let front: number[] = [];
  for (let p = 0; p < out.length; p++) if (out[p]) front.push(p);
  for (let step = 0; step <= r && front.length; step++) {
    const next: number[] = [];
    for (const q of front) {
      const i = q % g.w;
      const j = (q - i) / g.w;
      for (const [di, dj] of N4) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const k = nj * g.w + ni;
        if (!out[k] && g.lab[k] < 0 && !g.wall[k]) {
          out[k] = 1;
          next.push(k);
        }
      }
    }
    front = next;
  }
  return out;
}

/** Square dilation (grow) or erosion (shrink) of a mask by r cells */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const pass = (src: Uint8Array, horiz: boolean) => {
    const out = new Uint8Array(src.length);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        let v = grow ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const ii = horiz ? i + d : i;
          const jj = horiz ? j : j + d;
          const x = ii < 0 || jj < 0 || ii >= w || jj >= h ? 0 : src[jj * w + ii];
          if (grow ? x : !x) {
            v = grow ? 1 : 0;
            break;
          }
        }
        out[j * w + i] = v;
      }
    return out;
  };
  return pass(pass(m, true), false);
}

/** Opening (thin spikes off) and closing (narrow bays filled, only where no other room is) of every room */
function shape(g: Grid, labels: number, open: number, close: number) {
  for (let l = 0; l < labels; l++) {
    const m = new Uint8Array(g.lab.length);
    let any = false;
    for (let p = 0; p < m.length; p++)
      if (g.lab[p] === l) {
        m[p] = 1;
        any = true;
      }
    if (!any) continue;
    const opened = morph(morph(m, g.w, g.h, open, false), g.w, g.h, open, true);
    for (let p = 0; p < m.length; p++) if (m[p] && !opened[p]) g.lab[p] = -1;
    const closed = morph(morph(opened, g.w, g.h, close, true), g.w, g.h, close, false);
    for (let p = 0; p < m.length; p++) if (closed[p] && g.lab[p] < 0) g.lab[p] = l;
  }
}

/** Wall cells more than `d` cells away from any floor are dropped */
function dropStrayWalls(g: Grid, d: number) {
  const dist = new Int16Array(g.w * g.h).fill(-1);
  let front: number[] = [];
  for (let p = 0; p < g.lab.length; p++)
    if (g.lab[p] >= 0) {
      dist[p] = 0;
      front.push(p);
    }
  for (let step = 1; step <= d && front.length; step++) {
    const next: number[] = [];
    for (const q of front) {
      const i = q % g.w;
      const j = (q - i) / g.w;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
          const k = nj * g.w + ni;
          if (dist[k] < 0) {
            dist[k] = step;
            next.push(k);
          }
        }
    }
    front = next;
  }
  for (let p = 0; p < g.wall.length; p++) if (g.wall[p] && dist[p] < 0) g.wall[p] = 0;
}

/** Every free cell that `may` be taken goes to the room nearest to it (breadth first from all rooms at once) */
function nearest(g: Grid, may: (p: number) => boolean) {
  let front: number[] = [];
  for (let p = 0; p < g.lab.length; p++) if (g.lab[p] >= 0) front.push(p);
  while (front.length) {
    const next: number[] = [];
    for (const q of front) {
      const i = q % g.w;
      const j = (q - i) / g.w;
      for (const [di, dj] of N4) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const r = nj * g.w + ni;
        if (g.lab[r] < 0 && may(r)) {
          g.lab[r] = g.lab[q];
          next.push(r);
        }
      }
    }
    front = next;
  }
}

/** Wall cells of a room right next to the outside go back to outside (one layer) */
function trimOuter(g: Grid, outside: Uint8Array) {
  const drop: number[] = [];
  for (let p = 0; p < g.lab.length; p++) {
    if (g.lab[p] < 0 || !g.wall[p]) continue;
    const i = p % g.w;
    const j = (p - i) / g.w;
    for (const [di, dj] of N4) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h || outside[nj * g.w + ni]) {
        drop.push(p);
        break;
      }
    }
  }
  for (const p of drop) g.lab[p] = -1;
}

function countAround(g: Grid, p: number): number {
  const i = p % g.w;
  const j = (p - i) / g.w;
  let n = 0;
  for (const [di, dj] of N4) if (g.at(i + di, j + dj) >= 0) n++;
  return n;
}

function centre(pts: Point[]): Point {
  const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [x, y];
}

/**
 * Doors: two rooms whose painted floor touches directly (no wall in between) over 55–130 cm, with wall on both
 * ends of that gap — a doorway. Placed on the wall the two finished rooms share there; left out when unsure.
 */
function doors(W: number, H: number, raw: Int16Array, wall: Uint8Array, ox: number, oy: number, cell: number, rooms: RoomConfig[], idOf: Map<number, string>): OpeningConfig[] {
  // contacts: [pair, orientation, line coordinate (grid), position along (grid)]
  const runs = new Map<string, number[]>();
  const put = (k: string, v: number) => {
    const l = runs.get(k);
    if (l) l.push(v);
    else runs.set(k, [v]);
  };
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const a = raw[p];
      if (a < 0 || wall[p]) continue;
      // right neighbour → a vertical boundary at i + 0.5; below → horizontal at j + 0.5
      if (i + 1 < W) {
        const b = raw[p + 1];
        if (b >= 0 && b !== a && !wall[p + 1]) put(`${Math.min(a, b)}|${Math.max(a, b)}|v|${i}`, j);
      }
      if (j + 1 < H) {
        const b = raw[p + W];
        if (b >= 0 && b !== a && !wall[p + W]) put(`${Math.min(a, b)}|${Math.max(a, b)}|h|${j}`, i);
      }
    }
  const out: OpeningConfig[] = [];
  const byPair = new Map<string, number>();
  for (const [k, along] of runs) {
    const [la, lb, o, lineS] = k.split('|');
    const line = Number(lineS);
    along.sort((x, y) => x - y);
    // contiguous pieces along the line
    let s = 0;
    for (let e = 1; e <= along.length; e++) {
      if (e < along.length && along[e] - along[e - 1] <= 1) continue;
      const from = along[s];
      const to = along[e - 1];
      s = e;
      const len = (to - from + 1) * cell;
      if (len < 55 || len > 130) continue;
      // wall on both ends of the gap (within two cells beyond it), on either side of the line
      const wallNear = (q: number, dir: number) => {
        for (let d = 0; d <= 2; d++)
          for (const side of [0, 1]) {
            const along2 = q + dir * d;
            const ii = o === 'v' ? line + side : along2;
            const jj = o === 'v' ? along2 : line + side;
            if (ii >= 0 && jj >= 0 && ii < W && jj < H && wall[jj * W + ii]) return true;
          }
        return false;
      };
      if (!wallNear(from - 1, -1) || !wallNear(to + 1, 1)) continue;
      const ida = idOf.get(Number(la));
      const idb = idOf.get(Number(lb));
      if (!ida || !idb) continue;
      const pairKey = `${ida}|${idb}`;
      if ((byPair.get(pairKey) ?? 0) >= 2) continue;
      // where the gap is in plan cm
      const mid = ((from + to) / 2) * cell + (o === 'v' ? oy : ox);
      const at = (line + 0.5) * cell + (o === 'v' ? ox : oy);
      // the shared wall of the finished rooms near there
      const ra = rooms.find((r) => r.id === ida)!;
      const rb = rooms.find((r) => r.id === idb)!;
      const c = sharedLine(ra.points, rb.points, o, at, mid, cell * 2.5);
      if (c === undefined) continue;
      const w = Math.max(70, Math.min(100, Math.round(len / 5) * 5));
      const a: Point = o === 'v' ? [c, Math.round(mid - w / 2)] : [Math.round(mid - w / 2), c];
      const b: Point = o === 'v' ? [c, Math.round(mid + w / 2)] : [Math.round(mid + w / 2), c];
      byPair.set(pairKey, (byPair.get(pairKey) ?? 0) + 1);
      out.push({ id: `vac_door_${out.length + 1}`, type: 'door', a, b });
    }
  }
  return out;
}

/** The coordinate of a wall both rooms have along `o` near `at`, covering `mid` (undefined: none) */
function sharedLine(pa: Point[], pb: Point[], o: string, at: number, mid: number, tol: number): number | undefined {
  const edges = (pts: Point[]) =>
    pts
      .map((p, i) => [p, pts[(i + 1) % pts.length]] as [Point, Point])
      .filter(([p, q]) => (o === 'v' ? p[0] === q[0] && Math.abs(p[0] - at) <= tol && Math.min(p[1], q[1]) <= mid && Math.max(p[1], q[1]) >= mid : p[1] === q[1] && Math.abs(p[1] - at) <= tol && Math.min(p[0], q[0]) <= mid && Math.max(p[0], q[0]) >= mid))
      .map(([p]) => (o === 'v' ? p[0] : p[1]));
  const ea = edges(pa);
  const eb = edges(pb);
  for (const c of ea) if (eb.some((d) => Math.abs(d - c) <= 1)) return c;
  return undefined;
}

/** The whole card config for a brand-new card from the vacuum's map */
export function vacuumPlanConfig(res: VacuumPlanResult | VacuumHomeResult): FloorplanCardConfig {
  return { type: 'custom:floorplan-card', floors: 'floors' in res ? res.floors : [res.floor] };
}

// ---------- a house: several maps (one per floor), several vacuums, Home Assistant's floors ----------

/** One vacuum's maps for the house plan */
export interface VacuumSource {
  entity: string;
  adapter?: string | null;
  maps: VacuumMapEntry[];
}

export interface VacuumHomeResult {
  floors: FloorConfig[];
  skipped: number;
  /** maps the robot keeps but the integration has not loaded (no floor made for them) */
  missing: { entity: string; id: string; name: string }[];
}

/** Short storey names and their level, to match a map's name ("OG", "Keller") with Home Assistant's floors */
const STOREYS: [RegExp, number][] = [
  [/^(eg|erdgeschoss|parterre|ground|groundfloor|gf)$/, 0],
  [/^(og|1og|obergeschoss|ersterstock|upstairs|firstfloor|upper|upperfloor)$/, 1],
  [/^(2og|dg|dachgeschoss|dachboden|zweiterstock|attic|secondfloor)$/, 2],
  [/^(ug|kg|keller|untergeschoss|basement|cellar|downstairs)$/, -1],
];
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
function storeyOf(name?: string | null): number | undefined {
  const n = plain(name ?? '');
  return STOREYS.find(([re]) => re.test(n))?.[1];
}
/** "Map 1", "Karte 2", a bare number: a name the robot made up, not one to show */
const madeUp = (name?: string | null) => !name || /^(map|karte|floor|etage)?\s*\d+$/i.test(name.trim());

/**
 * The plan of a home from every map of every vacuum: one floor per map with geometry. Each floor is put on Home
 * Assistant's floor whose areas its rooms match (most rooms win), else the floor whose name or storey matches the
 * map's name; names come from Home Assistant, else from the map. The vacuum stands on the floor of the map it
 * uses right now. `kind`/`n`: a house with that many floors — floors the maps do not cover stay empty (named after
 * Home Assistant's floors, else by storey). Maps the robot keeps without geometry are listed in `missing`.
 */
export function planFromVacuumMaps(sources: VacuumSource[], opts: { hass?: HomeAssistant; kind: HomeKind; n: number }): VacuumHomeResult | undefined {
  const hass = opts.hass;
  const ha = haFloorsSorted(hass);
  const made: { f: FloorConfig; mapName?: string | null }[] = [];
  const missing: VacuumHomeResult['missing'] = [];
  let skipped = 0;
  let k = 0;
  for (const src of sources) {
    const withGeo = src.maps.filter((m) => m.map && m.map.rooms.some((r) => r.pts.length));
    // the vacuum stands on the map it uses now (or the only one)
    const here = withGeo.find((m) => m.current) ?? withGeo[0];
    for (const m of src.maps) {
      if (!m.map || !m.map.rooms.some((r) => r.pts.length)) {
        missing.push({ entity: src.entity, id: m.id, name: m.name || m.id });
        continue;
      }
      k++;
      const multi = sources.length > 1 || withGeo.length > 1;
      const res = planFromVacuumMap(m.map, { entity: src.entity, adapter: src.adapter, hass, floorId: `floor_vac_${k}`, floorName: m.name ?? undefined, idPrefix: multi ? `${k}_` : '', robot: m === here });
      if (!res) continue;
      skipped += res.skipped;
      made.push({ f: res.floor, mapName: m.name });
    }
  }
  if (!made.length) return undefined;
  // which Home Assistant floor: the one most of its rooms' areas are on, else by the map's name
  const taken = new Set<string>();
  const areaFloor = (id?: string) => (id ? hass?.areas?.[id]?.floor_id ?? undefined : undefined);
  const assign = made.map(({ f, mapName }) => {
    const votes = new Map<string, number>();
    for (const r of f.rooms) {
      const fl = areaFloor(r.area);
      if (fl) votes.set(fl, (votes.get(fl) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { f, mapName, best };
  });
  // most votes first, so a floor goes to the map that fits it best
  for (const a of assign.filter((x) => x.best).sort((x, y) => (y.f.rooms.length - x.f.rooms.length))) {
    if (a.best && !taken.has(a.best)) {
      taken.add(a.best);
      link(a.f, a.best);
    }
  }
  for (const a of assign) {
    if (a.f.floor) continue;
    const st = storeyOf(a.mapName);
    const byName = ha.find((h) => !taken.has(h.floor_id) && (plain(h.name) === plain(a.mapName ?? '') || (st !== undefined && (storeyOf(h.name) === st || h.level === st))));
    if (byName) {
      taken.add(byName.floor_id);
      link(a.f, byName.floor_id);
    } else if (st !== undefined) a.f.level = st;
  }
  function link(f: FloorConfig, id: string) {
    const h = hass?.floors?.[id];
    if (!h) return;
    f.floor = id;
    // linked: Home Assistant's name (the map's own name is only used for floors Home Assistant does not know)
    f.name = h.name;
    if (typeof h.level === 'number') f.level = h.level;
  }
  // levels for the rest: the current map's floor at the bottom of what is left, then upwards
  const levels = new Set(made.map((m) => m.f.level).filter((l): l is number => typeof l === 'number'));
  for (const { f } of made) {
    if (typeof f.level !== 'number') {
      let l = 0;
      while (levels.has(l)) l++;
      f.level = l;
      levels.add(l);
    }
    if (madeUp(f.name) || f.name === t('card.default_floor')) f.name = floorNameFor(f.level, made.length > 1 || opts.kind === 'house' ? 'house' : 'flat');
  }
  const n = opts.kind === 'house' ? Math.max(opts.n, made.length) : made.length;
  const floors = skeletonFloors(hass, made.length > 1 ? 'house' : opts.kind, n, made.map((m) => m.f));
  floors.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  return { floors, skipped, missing };
}
