import { AnimationMixer, Box3, BufferAttribute, BufferGeometry, Color, Matrix4, MeshBasicMaterial, SphereGeometry, Group, LoopOnce, LoopRepeat, Mesh, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, Object3D, Vector3, type AnimationAction, type AnimationClip, type Material, type SkinnedMesh } from 'three';
import { applyStyle, restClip, smoothen, woolCurl } from './dog-style';
import { addBindPos, attachGear, coatMaterial, gearFor, markingSpots, measureBind, paintSpots, setCoat, setFur, type CoatSpot, type DogBind } from './dog-coat';
import { loopSubdivide, pickGroup } from './dog-mesh';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DOG_BREEDS, type PetLook } from '../pets';
import type { PetPaint } from '../types';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from '../assets';

/**
 * Animated dogs (CC0 models by Quaternius) with a real skeleton: walk, gallop, idle variants, sniffing,
 * eating, jumping, lying down. Loaded once per breed from the card's own folder, cloned per dog.
 */
export type DogModel = 'shiba' | 'husky';

export function dogModelFor(breed: string): DogModel {
  return breed === 'husky' ? 'husky' : 'shiba';
}

interface Loaded {
  scene: Object3D;
  clips: AnimationClip[];
}

/** The resting poses the model lacks, made once per model */
const rests = new WeakMap<Loaded, AnimationClip[]>();
function restClips(src: Loaded): AnimationClip[] {
  let r = rests.get(src);
  if (!r) {
    r = (['Lie', 'Sleep', 'Sit'] as const).map((k) => restClip(src, k)).filter((x): x is AnimationClip => !!x);
    rests.set(src, r);
  }
  return r;
}

/** A body part split together (fur + light parts; nose; each eye part): one geometry, faces grouped by role */
interface Part {
  roles: string[];
  geo: BufferGeometry;
  groups: Uint8Array;
}

/**
 * The low-poly body, smoothed by subdivision (plan: once, close-up: twice): fur and its light parts are split
 * together so their seam stays closed and shaded as one surface; nose and eyes on their own. Every part carries
 * its bind-pose position (`bindPos`, model space). Per model and level.
 */
const refined = new WeakMap<Loaded, Map<number, Part[]>>();
function refinedParts(src: Loaded, level: number): Part[] {
  let per = refined.get(src);
  if (!per) refined.set(src, (per = new Map()));
  const hit = per.get(level);
  if (hit) return hit;
  const out: Part[] = [];
  const byRole = new Map<string, BufferGeometry>();
  let toModel: Matrix4 | undefined;
  src.scene.updateMatrixWorld(true);
  src.scene.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const role = MAT_ROLE[(m.material as Material).name] ?? (m.material as Material).name;
    byRole.set(role, m.geometry);
    // skinned in bind pose: model = bone.matrixWorld · boneInverse · bindMatrix · position (the same for all bones)
    toModel ??= m.skeleton.bones[0].matrixWorld.clone().multiply(m.skeleton.boneInverses[0]).multiply(m.bindMatrix);
  });
  const split = (roles: string[], smooth: number) => {
    const parts = roles.map((r) => byRole.get(r)).filter((g): g is BufferGeometry => !!g);
    if (parts.length !== roles.length || !toModel) return;
    const clean = parts.map((g) => {
      const c = new BufferGeometry();
      for (const n of ['position', 'skinIndex', 'skinWeight']) if (g.attributes[n]) c.setAttribute(n, g.attributes[n]);
      c.setIndex(g.index);
      return c;
    });
    let geo = mergeVertices(mergeGeometries(clean)!, 1e-4);
    let groups: Uint8Array = new Uint8Array(geo.index!.count / 3);
    let f = 0;
    clean.forEach((c, i) => {
      const n = c.index!.count / 3;
      groups.fill(i, f, f + n);
      f += n;
    });
    for (let l = 0; l < level; l++) ({ geo, faceGroup: groups } = loopSubdivide(geo, groups, smooth));
    geo.computeVertexNormals();
    const bp = (geo.attributes.position.array as Float32Array).slice();
    new BufferAttribute(bp, 3).applyMatrix4(toModel);
    geo.setAttribute('bindPos', new BufferAttribute(bp, 3));
    geo.userData.toModel = toModel;
    out.push({ roles, geo, groups });
  };
  split(['Main', 'Main_Light'], 0.72);
  split(['Black'], 0.5);
  // eyes rounder (the catchlight needs a curved surface)
  for (const r of ['Eyes_White', 'Eyes_Pupil', 'Eyes_Black']) split([r], 1);
  per.set(level, out);
  return out;
}

/** How a breed's head differs from the base model: head size, muzzle length (1 = as modelled) */
const HEADS: Record<string, { head: number; snout: number }> = {
  small: { head: 1.07, snout: 0.82 },
  dachshund: { head: 1, snout: 1.18 },
  retriever: { head: 1.02, snout: 1.06 },
  shepherd: { head: 1, snout: 1.14 },
  poodle: { head: 0.98, snout: 1.12 },
  maltipoo: { head: 1.06, snout: 0.6 },
  pug: { head: 1.14, snout: 0.36 },
  frenchie: { head: 1.12, snout: 0.38 },
};

/** Head landmarks of a model in bind pose: centre of the skull, where the muzzle starts (z), head bones */
const heads = new WeakMap<Loaded, { c: Vector3; z0: number; bones: Set<number> }>();
function headOf(src: Loaded) {
  let h = heads.get(src);
  if (h) return h;
  const parts = refinedParts(src, 0);
  let names: string[] = [];
  src.scene.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && !names.length) names = m.skeleton.bones.map((b) => b.name);
  });
  const bones = new Set(names.map((n, i) => (/^(Head|Ear)/.test(n) ? i : -1)).filter((i) => i >= 0));
  const c = new Vector3();
  let n = 0;
  const eye = new Vector3();
  let ne = 0;
  for (const p of parts) {
    const bp = p.geo.attributes.bindPos;
    const si = p.geo.attributes.skinIndex;
    const sw = p.geo.attributes.skinWeight;
    for (let i = 0; i < bp.count; i++) {
      if (p.roles[0] === 'Eyes_Black') {
        eye.x += bp.getX(i);
        eye.y += bp.getY(i);
        eye.z += bp.getZ(i);
        ne++;
      }
      if (bones.has(si.getComponent(i, 0)) && sw.getComponent(i, 0) > 0.95 && !/Ear/.test(names[si.getComponent(i, 0)])) {
        c.x += bp.getX(i);
        c.y += bp.getY(i);
        c.z += bp.getZ(i);
        n++;
      }
    }
  }
  c.divideScalar(Math.max(1, n));
  h = { c, z0: ne ? eye.z / ne : c.z, bones };
  heads.set(src, h);
  return h;
}

/** Move a bind-pose point (model space) for the breed's head; `w` = how much it belongs to the head */
export function shapeHead(p: Vector3, w: number, h: { c: Vector3; z0: number }, s: { head: number; snout: number }): Vector3 {
  const d = p.clone().sub(h.c).multiplyScalar((s.head - 1) * w);
  if (p.z > h.z0) d.z += (p.z - h.z0) * (s.snout - 1) * w;
  return p.clone().add(d);
}

/** The body for one dog: refined, and shaped for the breed (positions only — bindPos stays, painting stays put) */
const shaped = new WeakMap<Loaded, Map<string, Map<string, BufferGeometry>>>();
function bodyFor(src: Loaded, level: number, breed: string): Map<string, BufferGeometry> {
  const s = HEADS[breed];
  const key = `${level}|${s ? breed : ''}`;
  let per = shaped.get(src);
  if (!per) shaped.set(src, (per = new Map()));
  const hit = per.get(key);
  if (hit) return hit;
  const out = new Map<string, BufferGeometry>();
  const h = s ? headOf(src) : undefined;
  for (const p of refinedParts(src, level)) {
    let geo = p.geo;
    if (s && h) {
      geo = new BufferGeometry();
      for (const n of ['skinIndex', 'skinWeight', 'bindPos']) geo.setAttribute(n, p.geo.attributes[n]);
      geo.setIndex(p.geo.index);
      const bp = p.geo.attributes.bindPos;
      const si = p.geo.attributes.skinIndex;
      const sw = p.geo.attributes.skinWeight;
      const toLocal = (p.geo.userData.toModel as Matrix4).clone().invert();
      const pos = new Float32Array(bp.count * 3);
      const v = new Vector3();
      for (let i = 0; i < bp.count; i++) {
        let w = 0;
        for (let c = 0; c < 4; c++) if (h.bones.has(si.getComponent(i, c))) w += sw.getComponent(i, c);
        v.fromBufferAttribute(bp, i);
        const q = w > 0 ? shapeHead(v, w, h, s) : v;
        q.applyMatrix4(toLocal);
        pos[i * 3] = q.x;
        pos[i * 3 + 1] = q.y;
        pos[i * 3 + 2] = q.z;
      }
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.computeVertexNormals();
    }
    p.roles.forEach((r, i) => out.set(r, pickGroup(geo, p.groups, i)));
  }
  per.set(key, out);
  return out;
}

/** The head shaping of a breed for things built in model space (wool on the head) */
export function headShaper(src: Loaded, breed: string): ((p: Vector3) => Vector3) | undefined {
  const s = HEADS[breed];
  if (!s) return undefined;
  const h = headOf(src);
  return (p) => shapeHead(p, 1, h, s);
}

const cache = new Map<DogModel, Promise<Loaded | undefined>>();

/** The models sit next to the card's script (…/floorplan-card/models/…) */
function modelUrl(name: string): string {
  return assetUrl(`models/${name}.glb`);
}

export function loadDog(model: DogModel): Promise<Loaded | undefined> {
  let p = cache.get(model);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(modelUrl(`dog-${model}`))
      .then((g) => {
        smoothen(g.scene);
        faceOffEars(g.scene);
        eyesOut(g.scene);
        return { scene: g.scene, clips: g.animations };
      })
      .catch((err) => {
        console.info('[floorplan-card] dog model not available', err);
        return undefined;
      });
    cache.set(model, p);
  }
  return p;
}

/**
 * The models weigh eyes and skull partly to the ear bones (a quarter, for the eyes): folding the pointed ears away
 * (floppy ears) or scaling them dragged the eyes up and flattened the head. Only the ears themselves (mostly on the
 * ear bones) keep following them; the rest of the face follows the head alone.
 */
function faceOffEars(root: Object3D) {
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const names = m.skeleton.bones.map((b) => b.name);
    const head = names.indexOf('Head');
    if (head < 0) return;
    const eye = /^Eyes_/.test(MAT_ROLE[(m.material as Material).name] ?? (m.material as Material).name);
    const si = m.geometry.attributes.skinIndex;
    const sw = m.geometry.attributes.skinWeight;
    for (let i = 0; i < si.count; i++) {
      let ear = 0;
      for (let c = 0; c < 4; c++) if (names[si.getComponent(i, c)]?.startsWith('Ear')) ear += sw.getComponent(i, c);
      if (!ear || (!eye && ear >= 0.6)) continue;
      for (let c = 0; c < 4; c++) if (names[si.getComponent(i, c)]?.startsWith('Ear')) si.setComponent(i, c, head);
    }
    si.needsUpdate = true;
  });
}

/**
 * The eyes sit deep under the brow (a cross look from the side): they come a little out of their sockets and grow
 * a touch, each about its own centre along its own facing (bind-pose model space). The black parts close round
 * an eye (lids) come along.
 */
function eyesOut(root: Object3D) {
  root.updateMatrixWorld(true);
  const meshes: { m: SkinnedMesh; eye: boolean; M: Matrix4 }[] = [];
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const role = MAT_ROLE[(m.material as Material).name] ?? (m.material as Material).name;
    if (!/^Eyes_|^Black$/.test(role)) return;
    const M = m.skeleton.bones[0].matrixWorld.clone().multiply(m.skeleton.boneInverses[0]).multiply(m.bindMatrix);
    meshes.push({ m, eye: role !== 'Black', M });
  });
  const v = new Vector3();
  const sides = [[], []] as Vector3[][];
  for (const { m, eye, M } of meshes) {
    if (!eye) continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(M);
      sides[v.x >= 0 ? 0 : 1].push(v.clone());
    }
  }
  const eyes = sides.filter((pts) => pts.length >= 3).map((pts) => {
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
    const n = flattest(pts, c);
    if (n.x * c.x < 0) n.negate();
    const r = Math.max(...pts.map((p) => p.clone().sub(c).addScaledVector(n, -p.clone().sub(c).dot(n)).length()));
    return { c, n, r };
  });
  if (eyes.length !== 2) return;
  for (const { m, eye, M } of meshes) {
    const inv = M.clone().invert();
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(M);
      const e = eyes[v.x * eyes[0].c.x >= 0 ? 0 : 1];
      // lids: full move close to the eye, fading out by twice its size (the nose stays)
      const w = eye ? 1 : Math.max(0, 1 - Math.max(0, v.distanceTo(e.c) - e.r * 1.2) / e.r);
      if (!w) continue;
      v.sub(e.c).multiplyScalar(1 + 0.1 * w).add(e.c).addScaledVector(e.n, e.r * 0.3 * w);
      v.applyMatrix4(inv);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    p.needsUpdate = true;
    m.geometry.computeVertexNormals();
    m.geometry.computeBoundingSphere();
  }
}

export type DogAnim = 'Idle' | 'Idle_2' | 'Idle_2_HeadLow' | 'Walk' | 'Gallop' | 'Gallop_Jump' | 'Eating' | 'Attack' | 'Death' | 'Jump_ToIdle' | 'Lie' | 'Sleep' | 'Sit';

/** The roles of the materials of both models (the husky's are only numbered) */
const MAT_ROLE: Record<string, string> = { Material: 'Main', 'Material.001': 'Main_Light', 'Material.006': 'Black', 'Material.003': 'Eyes_White', 'Material.002': 'Eyes_Black' };

/** Whether a breed is one colour all over (its light parts take the fur colour unless markings say otherwise) */
const PLAIN = new Set(['poodle', 'maltipoo']);

export type DogLook = PetLook & { model: DogModel };

const SPARK = new MeshBasicMaterial({ color: 0xffffff });

/**
 * A small white highlight on each eye (up and to the front), riding on the head: the face looks alive from every
 * side, in any light. Found from the dark part of the eyes in bind pose.
 */
function catchlights(src: Loaded, model: Object3D, breed: string, fine?: boolean): Object3D[] {
  const head = model.getObjectByName('Head');
  if (!head) return [];
  model.updateMatrixWorld(true);
  const shape = headShaper(src, breed) ?? ((p: Vector3) => p);
  // the iris (the husky has none of its own: its white part is drawn as the iris)
  const parts = refinedParts(src, 0);
  const iris = parts.find((p) => p.roles[0] === 'Eyes_Pupil') ?? parts.find((p) => p.roles[0] === 'Eyes_White');
  if (!iris) return [];
  const sides = [[], []] as Vector3[][];
  const bp = iris.geo.attributes.bindPos;
  for (let i = 0; i < bp.count; i++) {
    const v = shape(new Vector3().fromBufferAttribute(bp, i));
    sides[v.x >= 0 ? 0 : 1].push(v);
  }
  // model space → the head bone's own space through the bind matrices (the bones' current pose may differ)
  let skinned: SkinnedMesh | undefined;
  model.traverse((o) => {
    if (!skinned && (o as SkinnedMesh).isSkinnedMesh) skinned = o as SkinnedMesh;
  });
  const hi = skinned?.skeleton.bones.findIndex((b) => b.name === 'Head') ?? -1;
  if (!skinned || hi < 0 || !iris.geo.userData.toModel) return [];
  const toHead = skinned.skeleton.boneInverses[hi].clone().multiply(skinned.bindMatrix).multiply((iris.geo.userData.toModel as Matrix4).clone().invert());
  const out: Object3D[] = [];
  for (const pts of sides) {
    if (pts.length < 3) continue;
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
    // the eye's facing: the direction its points spread least in, turned outwards
    const n = flattest(pts, c);
    if (n.x * c.x < 0) n.negate();
    const up = new Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const fwd = new Vector3(0, 0, 1).addScaledVector(n, -n.z).normalize();
    let r = 0;
    let h = 0;
    for (const p of pts) {
      const d = p.clone().sub(c);
      h = Math.max(h, d.dot(n));
      r = Math.max(r, d.addScaledVector(n, -d.dot(n)).length());
    }
    r ||= 0.05;
    const p = c.clone().addScaledVector(n, h + r * 0.05).addScaledVector(up, r * 0.3).addScaledVector(fwd, r * 0.22);
    const g = new SphereGeometry(r * 0.2, fine ? 12 : 6, fine ? 8 : 4);
    g.scale(1, 1, 0.35);
    g.lookAt(n);
    g.translate(p.x, p.y, p.z);
    g.applyMatrix4(toHead);
    const m = new Mesh(g, SPARK);
    m.name = 'eye-spark';
    m.userData.ownGeo = true;
    m.frustumCulled = false;
    head.add(m);
    out.push(m);
  }
  return out;
}

/** The direction in which points spread least (the normal of a flat patch): power iteration on the inverse spread */
function flattest(pts: Vector3[], c: Vector3): Vector3 {
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const p of pts) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    const z = p.z - c.z;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  const eps = (xx + yy + zz) * 1e-6 + 1e-12;
  const e = new Matrix4().set(xx + eps, xy, xz, 0, xy, yy + eps, yz, 0, xz, yz, zz + eps, 0, 0, 0, 0, 1).invert().elements;
  const v = new Vector3(1, 0.3, 0.2);
  for (let i = 0; i < 24; i++) v.set(e[0] * v.x + e[4] * v.y + e[8] * v.z, e[1] * v.x + e[5] * v.y + e[9] * v.z, e[2] * v.x + e[6] * v.y + e[10] * v.z).normalize();
  return v;
}

/** Glossy eyes: the light gives a soft glint, the catchlight (above) the life */
function eyeMaterial(c: Color): MeshPhongMaterial {
  return new MeshPhongMaterial({ color: c, shininess: 90, specular: new Color(0.35, 0.35, 0.35) });
}

const luma = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Signature of everything that changes how a dog looks (rebuild when it changes) */
export function dogLookKey(l: PetLook): string {
  return JSON.stringify([l.breed, l.fur, l.marks, l.markings, l.ears, l.tail, l.collar, l.tag, l.harness, l.bandana, l.eyes, l.seed, l.paint, !!l.detail, l.figure]);
}

/** One dog: the model turned to the card's frame (z up, nose +x), scaled to the piece, with its animations */
export class DogActor {
  readonly group = new Group();
  readonly mixer: AnimationMixer;
  private actions = new Map<string, AnimationAction>();
  current?: string;
  /** body length the model was scaled to (cm) */
  readonly length: number;
  /** the model itself (bind-pose model space = the coat's space) */
  readonly model: Object3D;
  /** coat materials (fur, light parts, wool): markings and painting */
  readonly coats: Material[] = [];
  readonly bind: DogBind;

  /** re-applied after every animation step (breed look) */
  private fix: () => void;
  private eyes: Object3D[] = [];
  private markings: CoatSpot[] = [];
  private look: DogLook;

  constructor(src: Loaded, dims: { length: number; height?: number; width?: number }, look: DogLook, opts: { fine?: boolean } = {}) {
    const length = dims.length;
    const model = cloneSkinned(src.scene);
    this.model = model;
    this.look = look;
    const fur = new Color(look.fur);
    const marks = new Color(look.marks);
    const plain = PLAIN.has(look.breed);
    // the model's own light parts (belly, muzzle, throat): the marking colour where the markings use them — a dark
    // mask (pug, shepherd) only darkens the muzzle, throat and belly keep the coat
    const darkMask = look.markings === 'mask' && luma(marks) < luma(fur);
    const lightIsMarks = !plain && (look.markings === 'belly' || (look.markings === 'mask' && !darkMask));
    // smooth body (subdivided: close-up finest, on the plan only when the dog is set to "detailed"); fur parts carry
    // their bind-pose position (shared geometry)
    const body = bodyFor(src, opts.fine ? 2 : look.detail ? 1 : 0, look.breed);
    const base: BufferGeometry[] = [];
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const m = o as SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const role = MAT_ROLE[(m.material as Material).name] ?? (m.material as Material).name;
      const coat = role === 'Main' || role === 'Main_Light';
      // the original body is measured too (seeded markings keep their place)
      if (coat) {
        addBindPos(m);
        base.push(m.geometry);
      }
      const g = body.get(role);
      if (g) m.geometry = g;
      if (coat) addBindPos(m);
    });
    // breed look (wool, ears, tail), in bind pose
    const style = applyStyle(
      model,
      { breed: look.breed, ears: look.ears, tail: look.tail, breedTail: DOG_BREEDS[look.breed]?.tail },
      (o) => {
        const m = coatMaterial(fur.clone(), { vertexColors: o.vertexColors, curl: o.wool ? woolCurl(o.wool) : undefined });
        this.coats.push(m);
        return m;
      },
      { fine: opts.fine, modelKey: look.model, head: headShaper(src, look.breed) },
    );
    this.fix = style.fix;
    this.bind = measureBind(model, style.geos, base);
    // gear measured on this dog's shape
    const gear = gearFor(src, `${look.breed}|${look.ears}|${look.tail}`, this.bind, opts.fine);
    const ref = refinedParts(src, 0)[0]?.geo;
    let coatMesh: SkinnedMesh | undefined;
    model.traverse((o) => {
      const m = o as SkinnedMesh;
      if (!coatMesh && m.isSkinnedMesh && m.geometry.attributes.bindPos && m.name !== 'wool') coatMesh = m;
    });
    attachGear(model, gear, look, ref && coatMesh ? { body: coatMesh, ref, toLocal: (ref.userData.toModel as Matrix4).clone().invert() } : undefined);
    this.eyes.push(...catchlights(src, model, look.breed, opts.fine));
    // glTF: y up → our z up
    const size0 = dims;
    const holder = new Group();
    holder.rotation.x = Math.PI / 2;
    holder.add(model);
    // measure in bind pose, find the nose (head bone) to turn it to +x, scale to the wanted length
    holder.updateMatrixWorld(true);
    const box = new Box3();
    // the body only (gear and wool would make the dog smaller)
    model.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) box.expandByObject(o);
    });
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const head = model.getObjectByName('Head');
    const hp = head ? head.getWorldPosition(new Vector3()) : new Vector3(box.max.x, center.y, center.z);
    const along = Math.abs(size.x) >= Math.abs(size.y) ? 'x' : 'y';
    const turn = new Group();
    turn.add(holder);
    if (along === 'x') turn.rotation.z = hp.x < center.x ? Math.PI : 0;
    else turn.rotation.z = hp.y < center.y ? Math.PI / 2 : -Math.PI / 2;
    const k = length / Math.max(1e-3, along === 'x' ? size.x : size.y);
    // breed proportions: taller / lower and broader than the base model, within reason
    const kz = size0.height ? Math.max(0.8 * k, Math.min(1.25 * k, size0.height / Math.max(1e-3, size.z))) : k;
    const kw = size0.width ? Math.max(0.85 * k, Math.min(1.2 * k, size0.width / Math.max(1e-3, along === 'x' ? size.y : size.x) * 1.6)) : k;
    turn.scale.set(along === 'x' ? k : kw, along === 'x' ? kw : k, kz);
    // stand on the floor, centred
    turn.position.set(0, 0, -box.min.z * kz);
    holder.position.set(-center.x, -center.y, 0);
    this.group.add(turn);
    this.length = length;
    // materials: fur and light parts become coat materials (markings, painting); eyes and nose a little glossy
    const eyeC = new Color(look.eyes);
    const hasIris = refinedParts(src, 0).some((p) => p.roles[0] === 'Eyes_Pupil');
    model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if (m.name === 'wool' || m.name === 'eye-spark' || m.name.startsWith('gear-')) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
        const role = MAT_ROLE[mat.name] ?? mat.name;
        const src = mat as MeshStandardMaterial;
        let l: Material;
        if (role === 'Main' || role === 'Main_Light') {
          const c = role === 'Main_Light' && lightIsMarks ? marks : fur;
          l = coatMaterial(c.clone());
          this.coats.push(l);
        } else if (role === 'Eyes_White') {
          // dogs show next to no white: the model's white becomes the iris where it has no iris of its own
          // (husky), else a dark rim round the iris
          l = eyeMaterial(hasIris ? eyeC.clone().multiplyScalar(0.4) : eyeC);
        } else if (role === 'Eyes_Pupil') l = eyeMaterial(eyeC);
        else if (role === 'Eyes_Black') l = eyeMaterial(new Color(0x141210));
        else if (role === 'Black') l = new MeshPhongMaterial({ color: new Color(0x1a1716), shininess: 60, specular: new Color(0.4, 0.4, 0.4) });
        else l = new MeshLambertMaterial({ color: src.color, map: src.map ?? null });
        l.name = role;
        return l;
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
      if (/Eyes_(White|Pupil|Black)/.test((Array.isArray(m.material) ? m.material[0] : m.material).name)) this.eyes.push(m);
    });
    this.markings = markingSpots(look, this.bind, marks);
    this.applyCoat();
    // coat details to scale: the bump of the curls in view units, belly and paws a little darker
    const torsoY = this.bind.bone('Torso2')?.y ?? 1.7;
    for (const m of this.coats) setFur(m, k, 0.1, torsoY - this.bind.girth * 0.35);
    this.mixer = new AnimationMixer(model);
    for (const clip of [...src.clips, ...restClips(src)]) {
      const name = clip.name.replace(/^.*\|/, '').replace(/^Run$/, 'Gallop').replace(/^Run_Jump$/, 'Gallop_Jump');
      this.actions.set(name, this.mixer.clipAction(clip));
    }
  }

  /** Markings + painting onto every coat material */
  applyCoat(paint = paintSpots(this.look)) {
    const all = [...this.markings, ...paint];
    for (const m of this.coats) setCoat(m, all);
  }

  /** Painting preview (the editor): replaces the painted strokes */
  setPaint(paint: PetPaint[]) {
    this.look = { ...this.look, paint };
    this.applyCoat();
  }

  has(name: string) {
    return this.actions.has(name);
  }

  bone(name: string): Object3D | undefined {
    return this.group.getObjectByName(name) ?? undefined;
  }

  /** Cross-fade to an animation; `once` holds the last frame (lying down) */
  play(name: DogAnim, opts: { fade?: number; once?: boolean; speed?: number; reverse?: boolean } = {}) {
    const next = this.actions.get(name) ?? this.actions.get('Idle');
    if (!next) return;
    const speed = opts.speed ?? 1;
    if (this.current === name && !opts.reverse) {
      next.timeScale = speed;
      return;
    }
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset();
    next.enabled = true;
    next.setLoop(opts.once ? LoopOnce : LoopRepeat, opts.once ? 1 : Infinity);
    next.clampWhenFinished = !!opts.once;
    next.timeScale = opts.reverse ? -speed : speed;
    if (opts.reverse) next.time = next.getClip().duration;
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, opts.fade ?? 0.3, false);
    this.current = name;
  }

  update(dt: number) {
    this.mixer.update(dt);
    this.fix();
  }

  /** Eyes shut while sleeping */
  set eyesClosed(on: boolean) {
    for (const e of this.eyes) e.visible = !on;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat !== SPARK) mat.dispose();
      // gear is merged per dog
      if (m.userData.ownGeo) m.geometry.dispose();
    });
  }
}
