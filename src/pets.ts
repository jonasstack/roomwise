import { subscribePets, subscribeWalks } from './entry-server';
import type { FloorConfig, FurnitureConfig, HassEntity, HomeAssistant, OpeningConfig, PetPaint, Point, RoomConfig } from './types';
import { resolveFurniture } from './furniture';
import { pointInPolygon } from './geometry';
import { domainOf } from './ha';
import { tone } from './colors';

/**
 * Pets: articulated 3D models (dog, cat) and the dog's walk schedule.
 * Model frame: x = forward (nose at +x), y = left/right, z = up; centimetres; origin on the floor below the body.
 */

// ---------- model ----------

/**
 * Ellipsoid / cylinder / box / wheel (axis across, y) / cone; x, y, z = centre (cylinder, cone: z = bottom).
 * `r` rounds a box's vertical edges; glass, emit (glowing) and op (opacity) style it; name marks animated parts.
 */
export interface Blob {
  s: 'ell' | 'cyl' | 'box' | 'wheel' | 'cone';
  r?: number;
  glass?: boolean;
  emit?: boolean;
  op?: number;
  name?: string;
  /** glossy surface (shininess) — noses, eyes, collar tag */
  gloss?: number;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  c: string;
  /** rotation about the lateral axis (deg, + tips the front down) */
  ry?: number;
  /** rotation about the forward axis (deg) */
  rx?: number;
  rz?: number;
}

export interface Joint {
  pivot: [number, number, number];
  parts: Blob[];
}

export interface Rig {
  kind: 'dog' | 'cat';
  body: Blob[];
  head: Joint;
  tail: Joint;
  /** front left, front right, back left, back right */
  legs: Joint[];
  /** Leash carried in the mouth (child of the head) */
  leash: Blob[];
  /** Height of the hips above the floor (standing) */
  legLen: number;
  length: number;
}

export type PetPose = 'lying' | 'standing' | 'sitting' | 'curled';
export type Markings = 'none' | 'belly' | 'socks' | 'mask' | 'patches';

export interface PetLook {
  breed: string;
  fur: string;
  marks: string;
  markings: Markings;
  ears: 'floppy' | 'pointy' | 'small';
  tail: 'long' | 'curled' | 'short' | 'fluffy';
  collar: string;
  pose: PetPose;
  /** dog extras (3D) */
  tag?: string;
  harness?: string;
  bandana?: string;
  eyes: string;
  seed: number;
  paint: PetPaint[];
  /** smoother dog on the plan */
  detail?: boolean;
  /** dog figure on the plan and in the editor: the skinned model (default) or the light code-drawn one */
  figure: DogFigure;
}

export type DogFigure = 'simple' | 'realistic';

export const DOG_BREEDS: Record<string, { ears: PetLook['ears']; tail: PetLook['tail']; snout: number; fluffy?: boolean; stocky?: number }> = {
  medium: { ears: 'floppy', tail: 'long', snout: 0.8 },
  small: { ears: 'pointy', tail: 'long', snout: 0.75 },
  dachshund: { ears: 'floppy', tail: 'long', snout: 0.95 },
  retriever: { ears: 'floppy', tail: 'fluffy', snout: 0.85 },
  shepherd: { ears: 'pointy', tail: 'fluffy', snout: 0.95 },
  husky: { ears: 'pointy', tail: 'curled', snout: 0.8, fluffy: true },
  poodle: { ears: 'floppy', tail: 'short', snout: 0.75, fluffy: true },
  maltipoo: { ears: 'floppy', tail: 'fluffy', snout: 0.55, fluffy: true },
  pug: { ears: 'small', tail: 'curled', snout: 0.3, stocky: 1.2 },
  frenchie: { ears: 'pointy', tail: 'short', snout: 0.3, stocky: 1.25 },
};

/** Look of a placed pet (defaults from breed / variant) */
export function petLook(f: FurnitureConfig): PetLook {
  const r = resolveFurniture(f);
  const p = f.pet ?? {};
  const isCat = r.k?.kind === 'cat';
  const breed = isCat ? 'cat' : r.variant || 'medium';
  const b = DOG_BREEDS[breed];
  return {
    breed,
    fur: r.color,
    marks: r.accent,
    markings: p.markings ?? (isCat ? 'none' : breed === 'husky' ? 'mask' : 'belly'),
    ears: p.ears ?? (isCat ? 'pointy' : (b?.ears ?? 'floppy')),
    tail: p.tail ?? (isCat ? 'long' : (b?.tail ?? 'long')),
    collar: p.collar ?? (isCat ? '#5a8fd8' : '#d8483a'),
    pose: p.pose ?? (isCat ? 'curled' : 'lying'),
    tag: p.tag === 'none' ? undefined : (p.tag ?? '#d4af37'),
    harness: p.harness,
    bandana: p.bandana,
    eyes: p.eyes ?? '#3a2618',
    seed: p.seed ?? 1,
    paint: p.paint ?? [],
    detail: p.detail === true,
    figure: p.figure === 'simple' ? 'simple' : 'realistic',
  };
}

const NOSE = '#2a2222';

/** Dog / cat rig scaled to the piece (w = length, h = width, height = shoulder height) */
export function petRig(f: FurnitureConfig): Rig {
  const r = resolveFurniture(f);
  return buildRig(petLook(f), { length: f.w, width: f.h, height: r.height }, r.k?.kind === 'cat');
}

/** The rig from a look and the body size (cm) */
export function buildRig(look: PetLook, dims: { length: number; width: number; height: number }, cat = false): Rig {
  const L = Math.max(20, dims.length);
  const W = Math.max(8, dims.width);
  const H = Math.max(14, dims.height);
  const breed = DOG_BREEDS[look.breed];
  const stocky = breed?.stocky ?? 1;
  const fluff = breed?.fluffy ? 1.12 : 1;
  const fur = look.fur;
  const mk = look.marks;
  const dark = tone(fur, -0.1);
  const light = tone(fur, 0.08);
  const legLen = H * (cat ? 0.5 : look.breed === 'dachshund' ? 0.3 : look.breed === 'pug' || look.breed === 'frenchie' ? 0.42 : 0.53);
  const bodyH = H - legLen;
  const torsoZ = legLen + bodyH * 0.42;
  const BW = W * stocky * fluff;
  const body: Blob[] = [
    // chest (deep, in front), belly, hips — a natural top line
    { s: 'ell', x: L * 0.16, y: 0, z: torsoZ + bodyH * 0.02, w: L * 0.38, d: BW * 0.88, h: bodyH * 1.12, c: fur },
    { s: 'ell', x: -L * 0.02, y: 0, z: torsoZ + bodyH * 0.06, w: L * 0.42, d: BW * 0.76, h: bodyH * 0.86, c: fur },
    { s: 'ell', x: -L * 0.22, y: 0, z: torsoZ + bodyH * 0.08, w: L * 0.32, d: BW * 0.8, h: bodyH * 0.92, c: fur },
    // back line (slightly darker: saddle)
    { s: 'ell', x: -L * 0.02, y: 0, z: torsoZ + bodyH * 0.3, w: L * 0.6, d: BW * 0.58, h: bodyH * 0.5, c: look.breed === 'shepherd' ? '#2c2c2e' : cat ? fur : dark },
    // neck rising to the head
    { s: 'ell', x: L * 0.3, y: 0, z: torsoZ + bodyH * 0.42, w: L * 0.22, d: BW * 0.52, h: bodyH * 0.92, c: fur, ry: cat ? 28 : 38 },
  ];
  if (look.markings === 'belly' || look.markings === 'socks' || look.markings === 'patches' || look.breed === 'husky')
    body.push({ s: 'ell', x: L * 0.1, y: 0, z: torsoZ - bodyH * 0.18, w: L * 0.5, d: BW * 0.66, h: bodyH * 0.62, c: mk }, { s: 'ell', x: L * 0.26, y: 0, z: torsoZ + bodyH * 0.1, w: L * 0.18, d: BW * 0.6, h: bodyH * 0.9, c: mk, ry: 30 });
  if (look.markings === 'patches') {
    body.push({ s: 'ell', x: -L * 0.16, y: BW * 0.16, z: torsoZ + bodyH * 0.3, w: L * 0.24, d: BW * 0.52, h: bodyH * 0.46, c: mk });
    body.push({ s: 'ell', x: L * 0.06, y: -BW * 0.18, z: torsoZ + bodyH * 0.26, w: L * 0.18, d: BW * 0.48, h: bodyH * 0.42, c: mk });
  }
  // collar with a little tag
  const collarZ = torsoZ + bodyH * 0.55;
  const strap = look.collar === 'none' ? '#d8483a' : look.collar;
  if (look.collar !== 'none') {
    body.push({ s: 'cyl', x: L * 0.31, y: 0, z: collarZ, w: L * 0.15, d: BW * 0.55, h: Math.max(1.6, H * 0.05), c: look.collar, ry: cat ? 28 : 38, gloss: 30 });
    if (look.tag) body.push({ s: 'ell', x: L * 0.37, y: 0, z: collarZ - H * 0.04, w: H * 0.05, d: H * 0.02, h: H * 0.06, c: look.tag, gloss: 90 });
  }

  const sz = (cat ? H * 0.42 : H * 0.37) * (stocky > 1 ? 1.1 : 1);
  // head (pivot at the top of the neck): sits on the neck, no gap
  const hp: [number, number, number] = [L * 0.38, 0, torsoZ + bodyH * (cat ? 0.95 : 0.8)];
  const snout = cat ? 0.32 : (breed?.snout ?? 0.8);
  const muzzleC = look.markings === 'mask' || look.markings === 'patches' || look.breed === 'husky' ? mk : look.breed === 'shepherd' ? '#2c2c2e' : light;
  const head: Blob[] = [
    { s: 'ell', x: sz * 0.12, y: 0, z: sz * 0.32, w: sz * 1.05, d: sz * (cat ? 1.04 : 0.92) * stocky, h: sz * 0.92, c: fur },
    // cheeks
    { s: 'ell', x: sz * 0.36, y: sz * 0.24 * stocky, z: sz * 0.12, w: sz * 0.5, d: sz * 0.36, h: sz * 0.46, c: fur },
    { s: 'ell', x: sz * 0.36, y: -sz * 0.24 * stocky, z: sz * 0.12, w: sz * 0.5, d: sz * 0.36, h: sz * 0.46, c: fur },
    // muzzle: broad at the base, narrower at the tip
    { s: 'ell', x: sz * (0.5 + snout * 0.25), y: 0, z: sz * 0.08, w: sz * (0.5 + snout * 0.38), d: sz * 0.54 * stocky, h: sz * 0.46, c: muzzleC },
    { s: 'ell', x: sz * (0.62 + snout * 0.5), y: 0, z: sz * 0.06, w: sz * (0.3 + snout * 0.25), d: sz * 0.4 * stocky, h: sz * 0.34, c: muzzleC },
    // nose, eyes with a highlight, brows
    { s: 'ell', x: sz * (0.76 + snout * 0.66), y: 0, z: sz * 0.16, w: sz * 0.18, d: sz * 0.24, h: sz * 0.15, c: NOSE, gloss: 80 },
    { s: 'ell', x: sz * 0.56, y: sz * 0.27, z: sz * 0.47, w: sz * 0.14, d: sz * 0.11, h: sz * 0.15, c: look.eyes, gloss: 120, name: 'eye' },
    { s: 'ell', x: sz * 0.56, y: -sz * 0.27, z: sz * 0.47, w: sz * 0.14, d: sz * 0.11, h: sz * 0.15, c: look.eyes, gloss: 120, name: 'eye' },
    { s: 'ell', x: sz * 0.62, y: sz * 0.29, z: sz * 0.52, w: sz * 0.04, d: sz * 0.04, h: sz * 0.04, c: '#ffffff', emit: true, name: 'glint' },
    { s: 'ell', x: sz * 0.62, y: -sz * 0.25, z: sz * 0.52, w: sz * 0.04, d: sz * 0.04, h: sz * 0.04, c: '#ffffff', emit: true, name: 'glint' },
    { s: 'ell', x: sz * 0.5, y: sz * 0.22, z: sz * 0.6, w: sz * 0.22, d: sz * 0.14, h: sz * 0.08, c: dark },
    { s: 'ell', x: sz * 0.5, y: -sz * 0.22, z: sz * 0.6, w: sz * 0.22, d: sz * 0.14, h: sz * 0.08, c: dark },
    // tongue (shown while panting)
    { s: 'ell', x: sz * (0.6 + snout * 0.5), y: 0, z: -sz * 0.12, w: sz * 0.26, d: sz * 0.2, h: sz * 0.3, c: '#e07a8a', name: 'tongue', ry: 20 },
  ];
  if (cat) {
    // whisker pads
    head.push({ s: 'ell', x: sz * 0.66, y: sz * 0.1, z: sz * 0.06, w: sz * 0.2, d: sz * 0.2, h: sz * 0.16, c: light }, { s: 'ell', x: sz * 0.66, y: -sz * 0.1, z: sz * 0.06, w: sz * 0.2, d: sz * 0.2, h: sz * 0.16, c: light });
  }
  for (const side of [1, -1]) {
    const nm = side > 0 ? 'earL' : 'earR';
    if (look.ears === 'floppy')
      head.push(
        { s: 'ell', x: sz * 0.0, y: side * sz * 0.5, z: sz * 0.28, w: sz * 0.42, d: sz * 0.14, h: sz * 0.72, c: look.markings === 'patches' ? mk : dark, rx: side * 14, name: nm },
        { s: 'ell', x: sz * 0.04, y: side * sz * 0.46, z: sz * 0.62, w: sz * 0.34, d: sz * 0.16, h: sz * 0.22, c: dark, rx: side * 30, name: nm },
      );
    else if (look.ears === 'pointy')
      head.push({ s: 'cone', x: sz * 0.0, y: side * sz * 0.3, z: sz * 0.62, w: sz * (cat ? 0.36 : 0.32), d: sz * 0.16, h: sz * (cat ? 0.44 : 0.52), c: fur, rx: -side * 12, name: nm }, { s: 'cone', x: sz * 0.03, y: side * sz * 0.3, z: sz * 0.66, w: sz * 0.2, d: sz * 0.06, h: sz * 0.34, c: '#e9b7b0', rx: -side * 12, name: nm });
    else head.push({ s: 'ell', x: -sz * 0.02, y: side * sz * 0.42, z: sz * 0.62, w: sz * 0.24, d: sz * 0.12, h: sz * 0.3, c: dark, rx: side * 34, name: nm });
  }
  if (look.markings === 'mask') head.push({ s: 'ell', x: sz * 0.42, y: 0, z: sz * 0.26, w: sz * 0.56, d: sz * 0.72, h: sz * 0.5, c: mk });
  // tail (pivot at the croup); tapered, pointing backwards
  const tp: [number, number, number] = [-L * 0.37, 0, torsoZ + bodyH * 0.32];
  const tl = cat ? L * 0.62 : L * (look.tail === 'short' ? 0.12 : look.tail === 'curled' ? 0.24 : 0.38);
  const tw = W * (look.tail === 'fluffy' ? 0.3 : cat ? 0.15 : 0.17) * fluff;
  const tip = look.markings === 'none' || cat ? dark : mk;
  const tail: Blob[] =
    look.tail === 'curled'
      ? [
          { s: 'ell', x: -tl * 0.2, y: 0, z: tl * 0.32, w: tl * 0.62, d: tw, h: tw * 1.1, c: fur, ry: 62 },
          { s: 'ell', x: -tl * 0.02, y: 0, z: tl * 0.6, w: tl * 0.56, d: tw * 0.95, h: tw, c: fur, ry: -15 },
          { s: 'ell', x: tl * 0.18, y: 0, z: tl * 0.56, w: tl * 0.26, d: tw * 0.85, h: tw * 0.85, c: tip, ry: -60 },
        ]
      : [
          { s: 'ell', x: -tl * 0.22, y: 0, z: 0, w: tl * 0.5, d: tw * 1.1, h: tw * 1.1, c: fur },
          { s: 'ell', x: -tl * 0.58, y: 0, z: 0, w: tl * 0.5, d: tw * 0.9, h: tw * 0.9, c: fur },
          { s: 'ell', x: -tl * 0.9, y: 0, z: 0, w: tl * 0.26, d: tw * 0.7, h: tw * 0.7, c: tip },
        ];
  // legs: pivot at hip / shoulder; thigh, slim lower leg, paw
  const lr = W * (cat ? 0.09 : 0.11) * stocky;
  const legs: Joint[] = [
    [L * 0.2, W * 0.25, false],
    [L * 0.2, -W * 0.25, false],
    [-L * 0.25, W * 0.24, true],
    [-L * 0.25, -W * 0.24, true],
  ].map(([lx, ly, back]) => ({
    pivot: [lx as number, (ly as number) * stocky, legLen + bodyH * 0.1] as [number, number, number],
    parts: [
      { s: 'ell', x: back ? -lr * 0.4 : 0, y: 0, z: -legLen * 0.18, w: lr * (back ? 3.4 : 2.6), d: lr * 2.3, h: legLen * 0.62, c: fur },
      { s: 'cyl', x: back ? lr * 0.2 : 0, y: 0, z: -legLen * 1.02, w: lr * 1.7, d: lr * 1.7, h: legLen * 0.86, c: fur },
      { s: 'ell', x: lr * 0.55, y: 0, z: -legLen * 1.02 + lr * 0.5, w: lr * 2.6, d: lr * 2.1, h: lr * 1.2, c: look.markings === 'socks' ? mk : tone(fur, -0.04) },
    ] as Blob[],
  }));
  // leash: from the mouth down to a loose loop on the floor
  const leash: Blob[] = [
    { s: 'box', x: sz * 1.0, y: sz * 0.12, z: -hp[2] * 0.42, w: 1.4, d: 1.4, h: hp[2] * 0.95, c: strap, ry: 14 },
    { s: 'cyl', x: sz * 1.3, y: sz * 0.2, z: -hp[2] + 0.5, w: sz * 1.3, d: sz * 0.9, h: 1.2, c: strap },
    { s: 'ell', x: sz * 0.95, y: 0, z: sz * 0.02, w: sz * 0.22, d: sz * 0.62, h: sz * 0.14, c: strap },
  ];
  return { kind: cat ? 'cat' : 'dog', body, head: { pivot: hp, parts: head }, tail: { pivot: tp, parts: tail }, legs, leash, legLen, length: L };
}

// ---------- presence & walks ----------

export interface PetState {
  /** idle at home, wants to go out (dog), out (presence says away) */
  mode: 'idle' | 'due' | 'away';
  /** walk slot that is due ("HH:MM") */
  slot?: string;
  /** next walk today */
  next?: string;
  /** slots already done today */
  done: string[];
  /** since when the dog is out (ms) */
  awaySince?: number;
}

/** Whether a presence entity says "at home" */
export function isHome(s: HassEntity | undefined): boolean | undefined {
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return undefined;
  const d = domainOf(s.entity_id);
  if (d === 'device_tracker' || d === 'person') return s.state === 'home';
  if (d === 'binary_sensor' || d === 'input_boolean' || d === 'switch') return s.state === 'on';
  const v = s.state.toLowerCase();
  return ['home', 'on', 'true', 'zuhause', 'daheim', 'anwesend', 'drinnen'].includes(v);
}

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function normalizeTime(v: string): string | undefined {
  const m = minutes(v);
  if (isNaN(m) || m < 0 || m >= 24 * 60) return undefined;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Walk window after a slot in which the dog shows that he wants to go out (minutes) */
export const WALK_WINDOW = 120;
/** A walk that started up to this long before a slot counts for it (minutes) */
const EARLY = 60;

export interface AwayInterval {
  from: number;
  to: number;
}

/**
 * Walk status of a dog from its slots, the presence history of today and manual check-offs.
 * A walk that is due stays due until it is done (an outing or a check-off) — it does not expire. When the
 * next slot begins while one is still open, the open one is carried along: one walk then settles both.
 */
export function walkState(slots: string[], _window: number, now: Date, home: boolean | undefined, away: AwayInterval[], manual: Set<string>): PetState {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const t = now.getTime();
  const sorted = slots.map(normalizeTime).filter((x): x is string => !!x).sort();
  const starts = sorted.map((sl) => day.getTime() + minutes(sl) * 60000);
  const done: string[] = [];
  let slot: string | undefined;
  let next: string | undefined;
  // a check-off or an outing settles its slot and every open one before it
  let settledUpTo = -1;
  sorted.forEach((sl, i) => {
    const start = starts[i];
    const walked = away.some((a) => a.to - a.from >= 5 * 60000 && a.to > start - EARLY * 60000 && a.from < t);
    if (manual.has(sl) || (walked && start <= t)) settledUpTo = i;
    else if (walked && start - EARLY * 60000 <= t) settledUpTo = i;
  });
  sorted.forEach((sl, i) => {
    const start = starts[i];
    if (i <= settledUpTo) done.push(sl);
    else if (start <= t) slot = sl; // the latest open one is the one shown
    else if (!next) next = sl;
  });
  const last = away[away.length - 1];
  if (home === false) return { mode: 'away', done, next, awaySince: last && last.to >= t - 60000 ? last.from : undefined };
  return { mode: slot ? 'due' : 'idle', slot, next, done };
}

/** Away intervals of today from a compressed history response ([{s, lu}] or full states) */
export function awayIntervals(rows: { s?: string; state?: string; lu?: number; last_changed?: string; last_updated?: string }[], entityId: string, now: number): AwayInterval[] {
  const out: AwayInterval[] = [];
  let from: number | undefined;
  for (const r of rows) {
    const st = r.s ?? r.state ?? '';
    const ts = r.lu != null ? r.lu * 1000 : Date.parse(r.last_changed ?? r.last_updated ?? '');
    if (isNaN(ts)) continue;
    const home = isHome({ entity_id: entityId, state: st, attributes: {} } as HassEntity);
    if (home === false && from == null) from = ts;
    else if (home === true && from != null) {
      out.push({ from, to: ts });
      from = undefined;
    }
  }
  if (from != null) out.push({ from, to: now });
  return out;
}

// ---------- the way to the front door ----------

const centroid = (pts: Point[]): Point => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

function sides(o: OpeningConfig, rooms: RoomConfig[]): { n: Point; mid: Point; a?: RoomConfig; b?: RoomConfig } {
  const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
  const len = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
  const n: Point = [-(o.b[1] - o.a[1]) / len, (o.b[0] - o.a[0]) / len];
  const at = (k: number) => rooms.find((r) => r.points.length >= 3 && !r.outdoor && pointInPolygon([mid[0] + n[0] * k, mid[1] + n[1] * k], r.points));
  return { n, mid, a: at(25), b: at(-25) };
}

/** The front door: configured (front door warning) or the first door leading outside */
export function frontDoor(floor: FloorConfig, doorId?: string): OpeningConfig | undefined {
  const doors = (floor.openings ?? []).filter((o) => o.type === 'door');
  const set = doorId ? doors.find((o) => o.id === doorId) : undefined;
  if (set) return set;
  return doors.find((o) => {
    const sd = sides(o, floor.rooms);
    return !!sd.a !== !!sd.b;
  });
}

/** Way (plan points) from a spot to just inside the front door, through the doors between rooms */
export function wayToDoor(floor: FloorConfig, from: Point, door: OpeningConfig): { path: Point[]; face: Point } | undefined {
  const rooms = floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
  const fd = sides(door, rooms);
  const inside = fd.a ?? fd.b;
  if (!inside) return undefined;
  const k = fd.a ? 1 : -1;
  const target: Point = [fd.mid[0] + fd.n[0] * 42 * k, fd.mid[1] + fd.n[1] * 42 * k];
  const start = rooms.find((r) => pointInPolygon(from, r.points));
  // breadth-first search over rooms joined by doors
  const links = (floor.openings ?? []).filter((o) => o.type === 'door' && o !== door).map((o) => ({ o, ...sides(o, rooms) })).filter((l) => l.a && l.b);
  const prev = new Map<RoomConfig, { room: RoomConfig; link: (typeof links)[number] } | null>();
  if (start) {
    prev.set(start, null);
    const queue = [start];
    while (queue.length) {
      const r = queue.shift()!;
      if (r === inside) break;
      for (const l of links) {
        const other = l.a === r ? l.b : l.b === r ? l.a : undefined;
        if (other && !prev.has(other)) {
          prev.set(other, { room: r, link: l });
          queue.push(other);
        }
      }
    }
  }
  const path: Point[] = [from];
  if (start && prev.has(inside)) {
    const steps: { room: RoomConfig; link: (typeof links)[number] }[] = [];
    for (let r: RoomConfig = inside; prev.get(r); r = prev.get(r)!.room) steps.unshift({ room: prev.get(r)!.room, link: prev.get(r)!.link });
    for (const st of steps) {
      // through the door: just before it, the doorway, just after it
      const sgn = st.link.a === st.room ? 1 : -1;
      path.push([st.link.mid[0] + st.link.n[0] * 30 * sgn, st.link.mid[1] + st.link.n[1] * 30 * sgn]);
      path.push(st.link.mid);
      path.push([st.link.mid[0] - st.link.n[0] * 30 * sgn, st.link.mid[1] - st.link.n[1] * 30 * sgn]);
    }
  } else if (start && start !== inside) {
    // no way through doors known: go via the room centres
    path.push(centroid(start.points), centroid(inside.points));
  }
  path.push(target);
  return { path, face: fd.mid };
}

// ---------- controller (card side) ----------

const STORE = 'fp-walks';

/** Keeps the walk status of every dog / cat with a schedule or presence entity up to date */
export class PetController {
  private history = new Map<string, AwayInterval[]>();
  private fetched = new Map<string, number>();
  private lastState = new Map<string, string>();
  private timer?: number;
  states = new Map<string, PetState>();

  constructor(private onChange: () => void) {}

  /** Checked-off walks from the companion integration (shared by every device), per pet */
  private server = new Map<string, string[]>();
  private serverSub?: Promise<() => void>;
  private serverKey = '';

  /** Walk state computed by the server (companion integration), per dog */
  private serverStates = new Map<string, PetState>();
  private statesSub?: Promise<() => void>;

  /** Follow the server's check-offs and walk state (when the companion integration is there) */
  watchServer(hass: HomeAssistant, cardId: string, on: boolean) {
    const key = on ? `${cardId}` : '';
    if (key === this.serverKey) return;
    this.serverKey = key;
    for (const s of [this.serverSub, this.statesSub]) void s?.then((u) => u()).catch(() => {});
    this.serverSub = this.statesSub = undefined;
    this.server.clear();
    this.serverStates.clear();
    if (!on) return;
    this.serverSub = subscribeWalks(hass, cardId, (w) => {
      this.server = new Map(Object.entries(w));
      this.sig = '';
      this.onChange();
    });
    this.serverSub.catch(() => (this.serverKey = ''));
    this.statesSub = subscribePets(hass, cardId, (st) => {
      this.serverStates = new Map(Object.entries(st ?? {}).map(([k, v]) => [k, { ...v, awaySince: v.awaySince ?? undefined } as PetState]));
      this.sig = '';
      if (!this.decided) this.decide(true);
      else this.onChange();
    });
    this.statesSub.catch(() => {});
  }

  start() {
    // walk times pass by the minute (only when there are pets at all)
    if (!this.timer) this.timer = window.setInterval(() => this.states.size && this.onChange(), 60000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of [this.serverSub, this.statesSub]) void s?.then((u) => u()).catch(() => {});
    this.serverSub = this.statesSub = undefined;
    this.serverKey = '';
  }

  private manual(id: string): Set<string> {
    try {
      const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string[]>;
      return new Set(all[`${id}|${new Date().toDateString()}`] ?? []);
    } catch {
      return new Set();
    }
  }

  /** Tap on the dog while he wants out: this walk counts as done (on this device) */
  markDone(id: string, slot: string) {
    try {
      const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string[]>;
      const key = `${id}|${new Date().toDateString()}`;
      // keep only today's entries
      for (const k of Object.keys(all)) if (!k.endsWith(new Date().toDateString())) delete all[k];
      all[key] = [...new Set([...(all[key] ?? []), slot])];
      this.sig = '';
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch {
      /* storage blocked */
    }
    this.onChange();
  }

  /** Today's away intervals of a presence entity (history, refreshed on changes and every 10 min) */
  private async load(hass: HomeAssistant, entity: string) {
    const now = Date.now();
    const st = hass.states[entity]?.state ?? '';
    if (this.lastState.get(entity) === st && now - (this.fetched.get(entity) ?? 0) < 600000) return;
    this.lastState.set(entity, st);
    this.fetched.set(entity, now);
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    try {
      const res = (await hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(day.getTime() - 3 * 3600000).toISOString(),
        entity_ids: [entity],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      })) as Record<string, { s?: string; lu?: number }[]>;
      this.history.set(entity, awayIntervals(res[entity] ?? [], entity, Date.now()));
    } catch {
      // no history: fall back to the current state's last change
      const s = hass.states[entity];
      if (s && isHome(s) === false) this.history.set(entity, [{ from: Date.parse(s.last_changed), to: Date.now() }]);
    }
    this.onChange();
  }

  /**
   * Nothing is shown until it is clear who decides: with the companion integration its state (first push),
   * without it the card's own — so a walk that is already done never flashes up as "wants out" on load.
   */
  private decided = false;
  private decideTimer?: number;
  decide(viaServer: boolean) {
    if (this.decided || (viaServer && !this.serverKey)) return;
    if (!viaServer && this.serverKey) return; // the server's first push decides
    this.decided = true;
    clearTimeout(this.decideTimer);
    this.sig = '';
    this.onChange();
  }

  update(hass: HomeAssistant, floor: FloorConfig | undefined) {
    if (!this.decided) {
      // never wait forever (no answer from the server)
      if (!this.decideTimer) this.decideTimer = window.setTimeout(() => ((this.decided = true), (this.sig = ''), this.onChange()), 5000);
      return this.states;
    }
    const next = new Map<string, PetState>();
    for (const f of floor?.furniture ?? []) {
      const kind = resolveFurniture(f).k?.kind;
      if (kind !== 'dog' && kind !== 'cat') continue;
      // the server knows (history, check-offs from every device and from phone notifications)
      const ss = this.serverStates.get(f.id);
      if (ss) {
        next.set(f.id, ss);
        continue;
      }
      const presence = f.entity;
      const home = presence ? isHome(hass.states[presence]) : undefined;
      if (presence) void this.load(hass, presence);
      const away = presence ? [...(this.history.get(presence) ?? [])] : [];
      // the current outing (history may lag a moment behind)
      if (home === false && !away.some((a) => a.to >= Date.now() - 60000)) away.push({ from: Date.parse(hass.states[presence!]?.last_changed ?? '') || Date.now(), to: Date.now() });
      const slots = kind === 'dog' ? (f.pet?.walks ?? []) : [];
      const manual = this.manual(f.id);
      for (const sl of this.server.get(f.id) ?? []) manual.add(sl);
      next.set(f.id, walkState(slots, f.pet?.walk_window ?? WALK_WINDOW, new Date(), home, away, manual));
    }
    // same content → same map (the plan only re-renders on a real change)
    const sig = JSON.stringify([...next]);
    if (sig === this.sig) return this.states;
    this.sig = sig;
    this.states = next;
    return next;
  }
  private sig = '';
}
