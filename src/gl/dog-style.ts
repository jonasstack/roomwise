import {
  AnimationClip,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  Object3D,
  type Material,
  Quaternion,
  QuaternionKeyframeTrack,
  SkinnedMesh,
  SphereGeometry,
  Vector3,
  VectorKeyframeTrack,
  type Bone,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { woolSurface, type WoolBlob } from './dog-mesh';

/**
 * Breed looks on the animated dog skeleton (Quaternius): the base body is restyled per breed — a poodle gets a
 * curly coat: one soft surface melted from wool blobs, skinned to the bones (so every animation keeps working),
 * its curls drawn by the coat shader; floppy-eared breeds get
 * hanging ears instead of the pointed ones. Plus the poses the model lacks: lying (head up) and sleeping
 * (curled up, head on the paws), solved with a small two-bone IK on a copy of the skeleton and stored as clips.
 *
 * Coordinates below are the model's own space in bind pose: x = side, y = up, z = forward (nose at +z).
 */
type V3 = [number, number, number];

interface Tuft {
  bone: string;
  c: V3;
  r: V3;
  /** mirror to the right side (x → −x, bone …L → …R) */
  pair?: boolean;
  /** bobble size relative to the tuft */
  curl?: number;
  /** a woolly ear (left out when the ears are set to pointed / small) */
  ear?: boolean;
  /** how much it melts into its neighbours (× the coat's own) */
  melt?: number;
}

/** Curly (poodle), soft waves (maltipoo) or a smooth plume (a fluffy tail on a short coat) */
export type WoolKind = 'curly' | 'wavy' | 'plume';

export interface BreedStyle {
  /** pointed ears of the base model collapse */
  hideEars: boolean;
  /** pointed ears of the base model, smaller */
  earScale?: number;
  /** the curled tail folds away (a tail of its own instead) */
  hideTail?: boolean;
  /** a long straight tail of its own */
  longTail?: boolean;
  wool?: Tuft[];
  woolKind?: WoolKind;
  /** a plume of soft hair along the curled tail */
  plume?: boolean;
  /** smooth hanging ears (not wool) */
  floppy?: { len: number; wide: number };
}

const POODLE: Tuft[] = [
  // coat (the base body spans y 1.1–2.2, half width ~0.5)
  { bone: 'Back', c: [0, 1.72, -0.66], r: [0.57, 0.62, 0.5] },
  { bone: 'Torso', c: [0, 1.7, -0.06], r: [0.53, 0.62, 0.5] },
  { bone: 'Torso2', c: [0, 1.74, 0.52], r: [0.57, 0.64, 0.48] },
  { bone: 'Torso3', c: [0, 1.8, 1.04], r: [0.52, 0.7, 0.46] },
  { bone: 'Torso3', c: [0.34, 1.42, 0.96], r: [0.27, 0.36, 0.3], pair: true },
  { bone: 'Neck2', c: [0, 2.32, 1.54], r: [0.44, 0.52, 0.42] },
  // head: top knot and cheeks; the slender muzzle stays free
  { bone: 'Head', c: [0, 3.02, 1.74], r: [0.44, 0.36, 0.44], curl: 0.9 },
  { bone: 'Head', c: [0, 2.72, 1.56], r: [0.44, 0.32, 0.32] },
  // long woolly ears
  { bone: 'Head', c: [0.44, 2.44, 1.72], r: [0.17, 0.46, 0.23], pair: true, curl: 0.8, ear: true },
  // legs: woolly trousers, a little cuff at the paw
  { bone: 'FrontUpperLegL', c: [0.36, 1.0, 0.95], r: [0.26, 0.36, 0.29], pair: true },
  { bone: 'FrontLowerLegL', c: [0.34, 0.5, 0.98], r: [0.2, 0.3, 0.21], pair: true },
  { bone: 'FrontLowerLegL', c: [0.34, 0.14, 1.06], r: [0.2, 0.13, 0.23], pair: true, curl: 0.8 },
  { bone: 'BackLegL', c: [0.45, 1.45, -0.75], r: [0.31, 0.46, 0.43], pair: true },
  { bone: 'BackUpperLegL', c: [0.42, 0.85, -0.95], r: [0.23, 0.33, 0.26], pair: true },
  { bone: 'BackLowerLegL', c: [0.4, 0.32, -1.05], r: [0.19, 0.3, 0.21], pair: true },
  // upright tail with a pompon (the base model's curled tail is folded away)
  { bone: 'Tail1', c: [0, 2.12, -1.1], r: [0.11, 0.27, 0.11], curl: 0.9 },
  { bone: 'Tail1', c: [0, 2.52, -1.16], r: [0.24, 0.24, 0.24], curl: 0.85 },
];

/** Maltese × poodle: a small teddy — soft wavy coat all over, round fluffy face over the short muzzle, long
 * fluffy ears and a plumed tail curled over the back (no clipped pompons) */
const MALTIPOO: Tuft[] = [
  ...POODLE.filter((t) => !/Tail|Head/.test(t.bone) && !(t.bone.startsWith('Front') && t.c[1] < 0.3)).map((t) => ({ ...t, r: [t.r[0] * 1.06, t.r[1] * 1.04, t.r[2] * 1.04] as V3, curl: 0.8, ear: false })),
  // round teddy head: crown, full cheeks and a little beard under the nose — eyes and nose stay free
  // (eyes at about [±0.25, 2.71, 2.08], the shortened nose at about z 2.3)
  { bone: 'Head', c: [0, 3.0, 1.66], r: [0.48, 0.36, 0.44], curl: 0.75 },
  { bone: 'Head', c: [0.28, 2.46, 1.8], r: [0.24, 0.26, 0.26], pair: true, curl: 0.7 },
  { bone: 'Head', c: [0, 2.38, 2.1], r: [0.22, 0.15, 0.2], curl: 0.65 },
  { bone: 'Head', c: [0.46, 2.38, 1.7], r: [0.19, 0.52, 0.26], pair: true, curl: 0.7, ear: true },
  // fluffy feet
  { bone: 'FrontLowerLegL', c: [0.34, 0.14, 1.06], r: [0.22, 0.15, 0.25], pair: true, curl: 0.7 },
  // plume along the curled tail
  { bone: 'Tail1', c: [0, 2.05, -1.15], r: [0.2, 0.27, 0.2], curl: 0.75 },
  { bone: 'Tail2', c: [0, 2.5, -1.42], r: [0.24, 0.27, 0.24], curl: 0.75 },
  { bone: 'Tail3', c: [0, 2.58, -1.12], r: [0.24, 0.22, 0.26], curl: 0.75 },
];


const FLOPPY: Record<string, { len: number; wide: number }> = {
  medium: { len: 0.5, wide: 0.24 },
  retriever: { len: 0.5, wide: 0.24 },
  dachshund: { len: 0.58, wide: 0.24 },
  pug: { len: 0.24, wide: 0.2 },
};

/** Breed defaults (wool, ear shape) with the ears and tail chosen for this dog */
export function breedStyle(breed: string, ears?: string, tail?: string, breedTail?: string): BreedStyle {
  const wool0 = breed === 'maltipoo' ? MALTIPOO : breed === 'poodle' ? POODLE : undefined;
  const st: BreedStyle = { hideEars: false };
  let wool = wool0 ? [...wool0] : undefined;
  // ears
  const earsNow = ears ?? (wool0 || FLOPPY[breed] ? 'floppy' : 'pointy');
  if (earsNow === 'floppy') {
    st.hideEars = true;
    if (!wool0) st.floppy = FLOPPY[breed] ?? { len: 0.44, wide: 0.22 };
  } else {
    wool = wool?.filter((t) => !t.ear);
    if (earsNow === 'small') st.earScale = 0.55;
    // the French bulldog's big bat ears
    else if (breed === 'frenchie') st.earScale = 1.3;
  }
  // tail: wool breeds keep their own tail as long as it is the breed's
  const own = !tail || tail === breedTail;
  if (wool0 && own) {
    st.hideTail = breed === 'poodle';
    if (breed === 'maltipoo') {
      wool = wool?.filter((t) => !/Tail/.test(t.bone));
      st.plume = true;
    }
  } else {
    wool = wool?.filter((t) => !/Tail/.test(t.bone));
    if (tail === 'fluffy') st.plume = true;
    else if (tail === 'short') st.hideTail = true;
    else if (tail === 'long') {
      st.hideTail = true;
      st.longTail = true;
    }
  }
  if (wool?.length || st.plume) {
    st.wool = wool ?? [];
    st.woolKind = breed === 'poodle' ? 'curly' : breed === 'maltipoo' ? 'wavy' : 'plume';
  }
  return st;
}

// ---------- wool ----------

/** How the coat is laid: grid cell of the surface and its curls (model units) for plan / close-up */
const WOOL_LOOK: Record<WoolKind, { melt: number; curl: number; depth: number; crease: number }> = {
  curly: { melt: 0.16, curl: 0.13, depth: 0.062, crease: 0.3 },
  wavy: { melt: 0.2, curl: 0.23, depth: 0.034, crease: 0.2 },
  plume: { melt: 0.24, curl: 0, depth: 0, crease: 0 },
};

/** The wool's curl pattern for the coat shader: cell, depth, crease darkening */
export function woolCurl(kind: WoolKind | undefined): [number, number, number] {
  const w = kind ? WOOL_LOOK[kind] : undefined;
  return w && w.curl > 0 ? [w.curl, w.depth, w.crease] : [0, 0, 0];
}

/** Hanging ear: a soft, slightly cupped leaf — thick at the root, rounded tip turning a little outwards */
function earGeometry(len: number, wide: number, mirror: boolean): BufferGeometry {
  const g = new SphereGeometry(1, 14, 10);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    const y = p.getY(i);
    let z = p.getZ(i);
    // wider towards the tip, thinner at the edges, cupped towards the head
    const t = (1 - y) / 2;
    z *= 0.75 + 0.35 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    x = x * (0.55 + 0.45 * (1 - Math.abs(z))) + (Math.abs(z) ** 2) * 0.25;
    p.setXYZ(i, x * wide * 0.3 + (mirror ? -1 : 1) * Math.max(0, -y) * 0.07, y * len * 0.5, z * wide * 0.5);
  }
  g.computeVertexNormals();
  return g;
}

const geoCache = new Map<string, { extras: Map<string, BufferGeometry>; wool?: BufferGeometry }>();

/** A long, slightly drooping tail from the tail root (smooth, tapering) */
function longTailGeometry(root: Vector3, len: number): BufferGeometry {
  const g = new SphereGeometry(1, 12, 10);
  // a long drop: thick at the root, thin at the tip
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 0.3 + 0.7 * ((y + 1) / 2) ** 0.8;
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.scale(len * 0.075, len * 0.5, len * 0.075);
  g.computeVertexNormals();
  // pointing back and a little down from the root
  g.translate(0, -len * 0.5, 0);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), new Vector3(0, -0.45, -1).normalize()));
  g.translate(root.x, root.y, root.z);
  return g;
}

/** Soft hair along the curled tail: blobs following the tail bones, thin at the root, full in the middle */
function plumeBlobs(model: Object3D, names: string[], melt: number): WoolBlob[] {
  const chain = ['Tail1', 'Tail2', 'Tail3'].map((n) => model.getObjectByName(n));
  if (chain.some((b) => !b)) return [];
  const p = chain.map((b) => b!.getWorldPosition(new Vector3()));
  // the tip: on along the last segment
  p.push(p[2].clone().add(p[2].clone().sub(p[1]).multiplyScalar(0.9)));
  const segLen = [p[0].distanceTo(p[1]), p[1].distanceTo(p[2]), p[2].distanceTo(p[3])];
  const total = segLen[0] + segLen[1] + segLen[2];
  const out: WoolBlob[] = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    let d = t * total;
    let s = 0;
    while (s < 2 && d > segLen[s]) d -= segLen[s++];
    const c = p[s].clone().lerp(p[s + 1], Math.min(1, d / Math.max(1e-4, segLen[s])));
    const r = 0.08 + 0.17 * Math.sin(Math.PI * Math.min(1, t * 1.08)) ** 0.7;
    out.push({ c, r: new Vector3(r, r, r), bone: Math.max(0, names.indexOf(['Tail1', 'Tail2', 'Tail3'][s])), melt: melt * 0.8 });
  }
  return out;
}

/** The skinned body part of the model (its skeleton carries the wool) */
function bodyMesh(model: Object3D): SkinnedMesh | undefined {
  let found: SkinnedMesh | undefined;
  model.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!found && m.isSkinnedMesh) found = m;
  });
  return found;
}

/**
 * Wool (one skinned surface, local space of the body mesh, with bindPos), ears and tail (in bone space, per bone),
 * cached per model + breed look
 */
function styleGeometry(model: Object3D, key: string, style: BreedStyle, fine: boolean, head?: (p: Vector3) => Vector3) {
  const hit = geoCache.get(key);
  if (hit) return hit;
  const perBone = new Map<string, BufferGeometry[]>();
  const add = (bone: string, g: BufferGeometry) => {
    const b = model.getObjectByName(bone);
    if (!b) return;
    // remember the bind-pose position (the coat is painted there), then model space → bone space
    const pos = g.attributes.position;
    g.setAttribute('bindPos', new BufferAttribute(new Float32Array(pos.array as ArrayLike<number>), 3));
    g.applyMatrix4(b.matrixWorld.clone().invert());
    if (!perBone.has(bone)) perBone.set(bone, []);
    perBone.get(bone)!.push(g);
  };
  model.updateMatrixWorld(true);
  let wool: BufferGeometry | undefined;
  const body = bodyMesh(model);
  if ((style.wool?.length || style.plume) && body) {
    const look = WOOL_LOOK[style.woolKind ?? 'curly'];
    const bones = body.skeleton.bones;
    const blobs: WoolBlob[] = [];
    for (const t of style.wool ?? []) {
      for (const mirror of t.pair ? [false, true] : [false]) {
        const name = mirror ? t.bone.replace(/L$/, 'R') : t.bone;
        const bone = bones.findIndex((b) => b.name === name);
        if (bone < 0) continue;
        // the old tufts reached ~1.05 r with their curls
        const k = 1.0 + 0.06 * (t.curl ?? 1);
        // wool on the head follows the breed's head shape (shorter muzzle, rounder head)
        const c0 = new Vector3(mirror ? -t.c[0] : t.c[0], t.c[1], t.c[2]);
        blobs.push({ c: head && name === 'Head' ? head(c0) : c0, r: new Vector3(t.r[0] * k, t.r[1] * k, t.r[2] * k), bone, melt: look.melt * (t.melt ?? 1) });
      }
    }
    if (style.plume) blobs.push(...plumeBlobs(model, bones.map((b) => b.name), look.melt));
    // close-up: fine grid with curls in the silhouette; plan: coarser, the shader draws the curls
    wool = woolSurface(blobs, fine ? 0.042 : 0.09, fine && look.curl > 0 ? { cell: look.curl, depth: look.depth } : undefined);
    if (wool) {
      const pos = wool.attributes.position;
      wool.setAttribute('bindPos', new BufferAttribute(new Float32Array(pos.array as ArrayLike<number>), 3));
      // model space → the body's own vertex space. Skinned ('attached'): world = bone.matrixWorld · boneInverse ·
      // bindMatrix · position — the same for every bone in bind pose (these models' bind transform is not identity)
      const T = body.skeleton.bones[0].matrixWorld.clone().multiply(body.skeleton.boneInverses[0]);
      const toLocal = body.bindMatrix.clone().invert().multiply(T.invert());
      wool.applyMatrix4(toLocal);
      // a mirroring mesh transform: three.js turns the faces round for it, so turn them back
      if (toLocal.determinant() < 0) {
        const ix = wool.index!;
        for (let i = 0; i < ix.count; i += 3) {
          const a = ix.getX(i + 1);
          ix.setX(i + 1, ix.getX(i + 2));
          ix.setX(i + 2, a);
        }
      }
    }
  }
  if (style.floppy) {
    for (const side of [1, -1]) {
      const g = earGeometry(style.floppy.len, style.floppy.wide, side < 0);
      g.rotateZ(side * 0.12);
      g.translate(side * 0.37, 2.76 - style.floppy.len * 0.32, 1.68);
      if (head) {
        const gp = g.attributes.position;
        const v = new Vector3();
        for (let i = 0; i < gp.count; i++) {
          // the root follows the head's shape, the ear itself keeps its size
          v.fromBufferAttribute(gp, i);
          gp.setXYZ(i, ...head(v).toArray());
        }
        g.computeVertexNormals();
      }
      // a shade darker than the coat, lighter at the root
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.fill(0.8 + 0.08 * Math.max(0, (g.attributes.position.getY(i) - 2.4) / 0.4), i * 3, i * 3 + 3);
      g.setAttribute('color', new BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      add('Head', g.index ? g.toNonIndexed() : g);
    }
  }
  if (style.longTail) {
    const root = model.getObjectByName('Tail1');
    const head = model.getObjectByName('Head');
    if (root && head) {
      const rp = root.getWorldPosition(new Vector3());
      const g = longTailGeometry(rp, rp.distanceTo(head.getWorldPosition(new Vector3())) * 0.42);
      const col = new Float32Array(g.attributes.position.count * 3).fill(0.95);
      g.setAttribute('color', new BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      add('Tail1', g.index ? g.toNonIndexed() : g);
    }
  }
  const extras = new Map<string, BufferGeometry>();
  for (const [bone, list] of perBone) {
    const m = mergeGeometries(list)!;
    for (const g of list) g.dispose();
    extras.set(bone, m);
  }
  const out = { extras, wool };
  geoCache.set(key, out);
  return out;
}

/**
 * Restyle one dog (a fresh clone, still in bind pose): the wool is one skinned surface on the dog's skeleton,
 * hanging ears / a long tail ride on their bones; all coloured by coat materials. Returns what has to be
 * re-applied after every animation step (collapsed ears) and the added geometry (carrying bindPos, for measuring).
 */
export function applyStyle(
  model: Object3D,
  look: { breed: string; ears?: string; tail?: string; breedTail?: string },
  makeMat: (opts: { vertexColors: boolean; wool?: WoolKind }) => Material,
  opts: { fine?: boolean; modelKey?: string; head?: (p: Vector3) => Vector3 } = {},
): { fix: () => void; geos: BufferGeometry[] } {
  const fine = !!opts.fine;
  const style = breedStyle(look.breed, look.ears, look.tail, look.breedTail);
  const key = `${opts.modelKey ?? ''}|${look.breed}|${look.ears ?? ''}|${look.tail ?? ''}|${fine ? 'fine' : ''}`;
  const { extras, wool } = styleGeometry(model, key, style, fine, opts.head);
  const geos: BufferGeometry[] = [];
  if (extras.size) {
    const mat = makeMat({ vertexColors: true });
    mat.name = 'Wool';
    for (const [bone, geo] of extras) {
      const m = new Mesh(geo, mat);
      m.castShadow = true;
      m.frustumCulled = false;
      m.name = 'wool';
      model.getObjectByName(bone)?.add(m);
      geos.push(geo);
    }
  }
  const body = bodyMesh(model);
  if (wool && body) {
    const mat = makeMat({ vertexColors: false, wool: style.woolKind ?? 'curly' });
    mat.name = 'Wool';
    const m = new SkinnedMesh(wool, mat);
    m.name = 'wool';
    m.castShadow = true;
    m.frustumCulled = false;
    m.position.copy(body.position);
    m.quaternion.copy(body.quaternion);
    m.scale.copy(body.scale);
    body.parent?.add(m);
    m.bind(body.skeleton, body.bindMatrix);
    geos.push(wool);
  }
  const hide = [...(style.hideEars ? ['Ear1L', 'Ear1R'] : []), ...(style.hideTail ? ['Tail2'] : [])].map((n) => model.getObjectByName(n)).filter((x): x is Object3D => !!x);
  const small = style.earScale ? ['Ear1L', 'Ear1R'].map((n) => model.getObjectByName(n)).filter((x): x is Object3D => !!x) : [];
  return {
    fix: () => {
      for (const e of hide) e.scale.setScalar(0.001);
      for (const e of small) e.scale.setScalar(style.earScale!);
    },
    geos,
  };
}

// ---------- lying and sleeping poses ----------

const W = () => new Vector3();

/** Turn a bone (in world space) so that a point carried by it moves from `from` towards `to` */
function aim(bone: Object3D, from: Vector3, to: Vector3) {
  const o = bone.getWorldPosition(W());
  const a = from.clone().sub(o).normalize();
  const b = to.clone().sub(o).normalize();
  if (a.lengthSq() < 1e-8 || b.lengthSq() < 1e-8) return;
  const dq = new Quaternion().setFromUnitVectors(a, b);
  const wq = bone.getWorldQuaternion(new Quaternion());
  const pq = bone.parent!.getWorldQuaternion(new Quaternion());
  bone.quaternion.copy(pq.invert().multiply(dq.multiply(wq)));
  bone.updateMatrixWorld(true);
}

/** Keep a bone's world orientation while its parents move */
function keepWorld(bone: Object3D, wq: Quaternion) {
  const pq = bone.parent!.getWorldQuaternion(new Quaternion());
  bone.quaternion.copy(pq.invert().multiply(wq.clone()));
  bone.updateMatrixWorld(true);
}

/** A point carried by a bone (stored in its local space) */
function carried(bone: Object3D, world: Vector3) {
  const local = bone.worldToLocal(world.clone());
  return () => bone.localToWorld(local.clone());
}

/** Two bones: upper from `hip`, joint at `knee`, end point `end()`; the knee bends towards `pole` */
function twoBone(upper: Object3D, lower: Object3D, end: () => Vector3, target: Vector3, pole: Vector3) {
  const H = upper.getWorldPosition(W());
  const K = lower.getWorldPosition(W());
  const a = H.distanceTo(K);
  const b = K.distanceTo(end());
  const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, H.distanceTo(target)));
  const dir = target.clone().sub(H).normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const knee = H.clone().addScaledVector(dir, x).addScaledVector(perp, y);
  aim(upper, K, knee);
  aim(lower, end(), H.clone().addScaledVector(dir, d));
}

function bones(model: Object3D) {
  const get = (n: string) => model.getObjectByName(n) as Bone | undefined;
  return get;
}

/**
 * Lying (head up) or sleeping (head resting on the front paws, curled a little to one side) — built from the
 * idle pose with IK and stored as a looping clip with calm breathing.
 */
export function restClip(src: { scene: Object3D; clips: AnimationClip[] }, kind: 'Lie' | 'Sleep' | 'Sit'): AnimationClip | undefined {
  const model = cloneSkinned(src.scene);
  const idle = src.clips.find((c) => /(^|\|)Idle$/.test(c.name));
  if (!idle) return undefined;
  const mixer = new AnimationMixer(model);
  mixer.clipAction(idle).play();
  mixer.update(0);
  model.updateMatrixWorld(true);
  const get = bones(model);
  const body = get('Body');
  const head = get('Head');
  const neck1 = get('Neck1');
  if (!body || !head || !neck1) return undefined;
  // end points of the legs (the IK targets of the rig sit at the paws)
  const ends = new Map<string, () => Vector3>();
  for (const [bone, tip] of [
    ['FrontLowerLegL', 'FFL'],
    ['FrontLowerLegR', 'FFR'],
    ['BackLowerLegL', 'FFBL'],
    ['BackLowerLegR', 'FFBR'],
  ] as const) {
    const b = get(bone);
    const t = get(tip);
    if (b && t) ends.set(bone, carried(b, t.getWorldPosition(W())));
  }
  const headQ = head.getWorldQuaternion(new Quaternion());
  if (kind === 'Sit') return sitClip(model, mixer, get, ends, headQ);
  // 1) the body sinks to the floor
  const drop = 1.12;
  const bw = body.getWorldPosition(W());
  bw.y -= drop;
  body.position.copy(body.parent!.worldToLocal(bw));
  body.updateMatrixWorld(true);
  const sleep = kind === 'Sleep';
  // 2) front legs stretched forward on the floor, elbows down
  for (const s of ['L', 'R']) {
    const up = get(`FrontUpperLeg${s}`);
    const lo = get(`FrontLowerLeg${s}`);
    const end = ends.get(`FrontLowerLeg${s}`);
    if (!up || !lo || !end) continue;
    const H = up.getWorldPosition(W());
    const sx = s === 'L' ? 1 : -1;
    const target = new Vector3(H.x * 0.85 + (sleep ? sx * 0.02 : 0), 0.1, H.z + 1.05);
    twoBone(up, lo, end, target, new Vector3(0, -0.4, -1));
  }
  // 3) hind legs folded: thigh forward along the belly, hock on the floor, paw forward
  for (const s of ['L', 'R']) {
    const thigh = get(`BackLeg${s}`);
    const shin = get(`BackUpperLeg${s}`);
    const foot = get(`BackLowerLeg${s}`);
    const end = ends.get(`BackLowerLeg${s}`);
    if (!thigh || !shin || !foot || !end) continue;
    const sx = s === 'L' ? 1 : -1;
    const hip = thigh.getWorldPosition(W());
    const knee = shin.getWorldPosition(W());
    const lenT = hip.distanceTo(knee);
    aim(thigh, knee, hip.clone().add(new Vector3(sx * 0.18, -0.55, 0.85).normalize().multiplyScalar(lenT)));
    const k2 = shin.getWorldPosition(W());
    const hock = foot.getWorldPosition(W());
    const lenS = k2.distanceTo(hock);
    const hockT = new Vector3(k2.x + sx * 0.08, 0.13, 0);
    hockT.z = k2.z - Math.sqrt(Math.max(0.01, lenS * lenS - (k2.y - 0.13) ** 2));
    aim(shin, hock, hockT);
    const h2 = foot.getWorldPosition(W());
    const lenF = h2.distanceTo(end());
    aim(foot, end(), new Vector3(h2.x + sx * 0.04, 0.08, h2.z + lenF));
  }
  // 4) neck and head: up and looking ahead, or lowered onto the paws
  const n1 = neck1.getWorldPosition(W());
  const hp = head.getWorldPosition(W());
  const reach = n1.distanceTo(hp);
  const want = sleep ? new Vector3(sleep ? 0.12 : 0, 0.5, n1.z + 0.85) : new Vector3(0, n1.y + reach * 0.82, n1.z + reach * 0.55);
  want.sub(n1).normalize().multiplyScalar(reach).add(n1);
  aim(neck1, hp, want);
  const q = headQ.clone();
  if (sleep) q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.22)).premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.12));
  keepWorld(head, q);
  // record: every bone's rotation (+ the body's position), breathing on the chest
  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];
  const T = sleep ? 4.2 : 3.2;
  model.traverse((o) => {
    if (!(o as Bone).isBone) return;
    const qv = o.quaternion.toArray();
    if (o.name === 'Torso2') {
      const deep = sleep ? 0.035 : 0.025;
      const qb = o.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deep)).toArray();
      tracks.push(new QuaternionKeyframeTrack(`${o.name}.quaternion`, [0, T / 2, T], [...qv, ...qb, ...qv]));
    } else tracks.push(new QuaternionKeyframeTrack(`${o.name}.quaternion`, [0, T], [...qv, ...qv]));
    if (o === body) {
      const p = o.position.toArray();
      tracks.push(new VectorKeyframeTrack(`${o.name}.position`, [0, T], [...p, ...p]));
    }
  });
  mixer.stopAllAction();
  return new AnimationClip(kind, T, tracks);
}

/**
 * Sitting: the body tips back about the shoulders until the rump is on the floor, the front legs stand straight,
 * the hind legs fold forward beside the belly, the head keeps looking ahead.
 */
function sitClip(model: Object3D, mixer: AnimationMixer, get: (n: string) => Bone | undefined, ends: Map<string, () => Vector3>, headQ: Quaternion): AnimationClip | undefined {
  const body = get('Body');
  const head = get('Head');
  const fl = get('FrontUpperLegL');
  const fr = get('FrontUpperLegR');
  const hip = get('BackLegL');
  if (!body || !head || !fl || !fr || !hip) return undefined;
  const pivot = fl.getWorldPosition(W()).add(fr.getWorldPosition(W())).multiplyScalar(0.5);
  const hp = hip.getWorldPosition(W());
  // tip back until the hips are low (the rump rests on the floor)
  const reach = pivot.distanceTo(hp);
  const want = 0.55;
  const ang = Math.min(0.85, Math.asin(Math.max(0, Math.min(0.95, (hp.y - want) / Math.max(0.1, reach)))));
  const R = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -ang);
  const bw = body.getWorldPosition(W());
  const nb = bw.clone().sub(pivot).applyQuaternion(R).add(pivot);
  const bq = body.getWorldQuaternion(new Quaternion());
  body.position.copy(body.parent!.worldToLocal(nb));
  keepWorld(body, R.clone().multiply(bq));
  // front legs: straight down to the floor, just ahead of the shoulders
  for (const s of ['L', 'R']) {
    const up = get(`FrontUpperLeg${s}`);
    const lo = get(`FrontLowerLeg${s}`);
    const end = ends.get(`FrontLowerLeg${s}`);
    if (!up || !lo || !end) continue;
    const H = up.getWorldPosition(W());
    twoBone(up, lo, end, new Vector3(H.x * 0.92, 0.08, H.z + 0.12), new Vector3(0, 0, -1));
  }
  // hind legs: thigh forward along the floor, hock down, paw forward
  for (const s of ['L', 'R']) {
    const thigh = get(`BackLeg${s}`);
    const shin = get(`BackUpperLeg${s}`);
    const foot = get(`BackLowerLeg${s}`);
    const end = ends.get(`BackLowerLeg${s}`);
    if (!thigh || !shin || !foot || !end) continue;
    const sx = s === 'L' ? 1 : -1;
    const h = thigh.getWorldPosition(W());
    const knee = shin.getWorldPosition(W());
    const lenT = h.distanceTo(knee);
    aim(thigh, knee, h.clone().add(new Vector3(sx * 0.3, -0.25, 1).normalize().multiplyScalar(lenT)));
    const k2 = shin.getWorldPosition(W());
    const hock = foot.getWorldPosition(W());
    const lenS = k2.distanceTo(hock);
    const hockT = new Vector3(k2.x + sx * 0.04, 0.12, 0);
    hockT.z = k2.z - Math.sqrt(Math.max(0.01, lenS * lenS - (k2.y - 0.12) ** 2));
    aim(shin, hock, hockT);
    const h2 = foot.getWorldPosition(W());
    const lenF = h2.distanceTo(end());
    aim(foot, end(), new Vector3(h2.x + sx * 0.02, 0.07, h2.z + lenF));
  }
  // tail: back along the floor
  const t1 = get('Tail1');
  const t2 = get('Tail2');
  if (t1 && t2) {
    const a = t1.getWorldPosition(W());
    aim(t1, t2.getWorldPosition(W()), new Vector3(a.x, Math.max(0.1, a.y - 0.25), a.z - 0.6));
  }
  keepWorld(head, headQ);
  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];
  const T = 3.6;
  model.traverse((o) => {
    if (!(o as Bone).isBone) return;
    const qv = o.quaternion.toArray();
    if (o.name === 'Torso2') {
      const qb = o.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.025)).toArray();
      tracks.push(new QuaternionKeyframeTrack(`${o.name}.quaternion`, [0, T / 2, T], [...qv, ...qb, ...qv]));
    } else tracks.push(new QuaternionKeyframeTrack(`${o.name}.quaternion`, [0, T], [...qv, ...qv]));
    if (o === body) {
      const p = o.position.toArray();
      tracks.push(new VectorKeyframeTrack(`${o.name}.position`, [0, T], [...p, ...p]));
    }
  });
  mixer.stopAllAction();
  return new AnimationClip('Sit', T, tracks);
}

/** Merge vertices of a low-poly model and recompute normals for soft shading (dequantized first) */
export function smoothen(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry as BufferGeometry;
    geo.deleteAttribute('normal');
    for (const name of Object.keys(geo.attributes)) {
      const a = geo.attributes[name] as BufferAttribute;
      const n = a.count * a.itemSize;
      const arr = name === 'skinIndex' ? new Uint16Array(n) : new Float32Array(n);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c);
      geo.setAttribute(name, new BufferAttribute(arr, a.itemSize));
    }
    const merged = mergeVertices(geo, 1e-4);
    merged.computeVertexNormals();
    m.geometry = merged;
    geo.dispose();
  });
}
