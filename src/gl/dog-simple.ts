/**
 * The simple dog figure: the code-drawn rig (`buildRig`, the same figure as in the CSS 3D view) as a light actor
 * with the same interface as the skinned model (`DogActor`), so the dog on the plan walks, lies down, eats and
 * waits at the door with it just the same. No model file is loaded. Static parts are merged per joint and
 * coloured per vertex: about a dozen draw calls per dog and a few thousand triangles.
 */
import { BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Float32BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, Object3D, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildRig, type Blob, type PetLook } from '../pets';
import type { PetPaint } from '../types';
import type { DogAnim } from './pet-model';

const DEG = Math.PI / 180;
// low-poly unit shapes (the figure is small on the plan); spheres centred, cylinders and cones stand on z = 0
// (the editor's close-up uses finer ones)
const shapes = (seg: number) => ({
  sphere: new SphereGeometry(0.5, seg, Math.round(seg * 0.62)).rotateX(Math.PI / 2),
  cyl: new CylinderGeometry(0.5, 0.5, 1, seg, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5),
  cone: new ConeGeometry(0.5, 1, seg).rotateX(Math.PI / 2).translate(0, 0, 0.5),
  box: new BoxGeometry(1, 1, 1),
});
const COARSE = shapes(16);
let fineShapes: ReturnType<typeof shapes> | undefined;
// shared by every simple dog (never disposed: three small materials)
const MATTE = new MeshPhongMaterial({ vertexColors: true, shininess: 7, specular: new Color(0.07, 0.07, 0.07) });
const GLOSS = new MeshPhongMaterial({ vertexColors: true, shininess: 90, specular: new Color(0.55, 0.55, 0.55) });
const GLINT = new MeshBasicMaterial({ color: 0xffffff });

const colorOf = (c: string) => {
  const col = new Color(0x8a8a8e);
  if (/^#[0-9a-f]{3,8}$/i.test(c) || /^rgb/i.test(c)) col.setStyle(c);
  return col;
};

/** One blob as a geometry in its joint's space (relative to `origin`), coloured per vertex */
function blobGeometry(b: Blob, origin: Vector3, set: ReturnType<typeof shapes>): BufferGeometry {
  const base = b.s === 'ell' ? set.sphere : b.s === 'cyl' || b.s === 'wheel' ? set.cyl : b.s === 'cone' ? set.cone : set.box;
  const g = base.clone();
  const m = new Matrix4().compose(
    new Vector3(b.x - origin.x, b.y - origin.y, b.z - origin.z),
    new Quaternion().setFromEuler(new Euler((b.rx ?? 0) * DEG, (b.ry ?? 0) * DEG, (b.rz ?? 0) * DEG)),
    new Vector3(b.w, b.d, b.h),
  );
  g.applyMatrix4(m);
  const col = colorOf(b.c);
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) cols.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(cols, 3));
  return g;
}

/** Pose and motion of the figure (all blended when the animation changes) */
interface Pose {
  z: number;
  pitch: number;
  legs: number[];
  legScale: number;
  headTurn: number;
  headNod: number;
  tailZ: number;
  tailUp: number;
  /** leg swing (rad), steps per second, body bounce (cm), gallop pattern 0..1 */
  gait: number;
  rate: number;
  bounce: number;
  gallop: number;
  /** tail wag (rad) and its rate (per second) */
  wag: number;
  wagRate: number;
  /** jumping up and down (0..1), nodding while eating (0..1), looking around (0..1) */
  hop: number;
  bob: number;
  look: number;
}

const ANIMS: DogAnim[] = ['Idle', 'Idle_2', 'Idle_2_HeadLow', 'Walk', 'Gallop', 'Gallop_Jump', 'Eating', 'Attack', 'Death', 'Jump_ToIdle', 'Lie', 'Sleep', 'Sit'];

export class SimpleDog {
  readonly group = new Group();
  current?: DogAnim;
  private rigG = new Group();
  private head = new Group();
  private tail = new Group();
  private legs: Group[] = [];
  private eyes: Mesh[] = [];
  private glints: Mesh[] = [];
  private ears: Object3D[] = [];
  private tongue?: Mesh;
  private legLen: number;
  private height: number;
  private p: Pose;
  private from?: Pose;
  private to: Pose;
  private fade = 0;
  private k = 1;
  private t = 0;
  private phase = 0;
  private wagPhase = 0;
  private hopPhase = 0;
  private seed: number;

  private shapes: ReturnType<typeof shapes>;

  constructor(look: PetLook, dims: { length: number; height: number; width: number }, opts: { fine?: boolean } = {}) {
    this.shapes = opts.fine ? (fineShapes ??= shapes(32)) : COARSE;
    const rig = buildRig(look, dims);
    this.legLen = rig.legLen;
    this.height = dims.height;
    this.seed = (look.seed * 7.3) % 10;
    this.group.add(this.rigG);
    this.fill(this.rigG, rig.body);
    // joint parts are given relative to the joint's pivot
    const joint = (g: Group, j: { pivot: [number, number, number]; parts: Blob[] }) => {
      g.position.set(...j.pivot);
      this.fill(g, j.parts);
      this.rigG.add(g);
      return g;
    };
    joint(this.head, rig.head);
    this.head.name = 'Head';
    joint(this.tail, rig.tail);
    this.legs = rig.legs.map((j) => joint(new Group(), j));
    this.p = this.pose('Lie', 1);
    this.to = this.p;
    this.apply();
  }

  /** Merged meshes of one joint: matte and glossy parts; eyes, glints, ears and tongue on their own (they move) */
  private fill(parent: Group, blobs: Blob[]) {
    const own = (list: Blob[], mat: MeshPhongMaterial | MeshBasicMaterial, pivot?: Blob) => {
      if (!list.length) return undefined;
      const at = pivot ? new Vector3(pivot.x, pivot.y, pivot.z) : new Vector3();
      const geo = mergeGeometries(list.map((b) => blobGeometry(b, at, this.shapes)));
      const m = new Mesh(geo, mat);
      m.position.copy(at);
      parent.add(m);
      return m;
    };
    const rest = blobs.filter((b) => !b.name);
    own(rest.filter((b) => !b.gloss), MATTE);
    own(rest.filter((b) => b.gloss), GLOSS);
    const glints = own(blobs.filter((b) => b.name === 'glint'), GLINT);
    if (glints) this.glints.push(glints);
    for (const b of blobs.filter((b) => b.name === 'eye')) this.eyes.push(own([b], GLOSS, b)!);
    const tongue = blobs.find((b) => b.name === 'tongue');
    if (tongue) this.tongue = own([tongue], MATTE, tongue);
    for (const nm of ['earL', 'earR']) {
      const ear = blobs.filter((b) => b.name === nm);
      if (ear.length) this.ears.push(own(ear, MATTE, ear[0])!);
    }
  }

  private pose(name: DogAnim, speed: number): Pose {
    const L = this.legLen;
    const stand: Pose = { z: 0, pitch: 0, legs: [0, 0, 0, 0], legScale: 1, headTurn: 0, headNod: 0, tailZ: 0, tailUp: 1, gait: 0, rate: 1.6, bounce: 0, gallop: 0, wag: 0.3, wagRate: 1.6, hop: 0, bob: 0, look: 0.6 };
    const lie: Pose = { ...stand, z: -L * 0.78, legs: [-1.45, -1.35, -1.25, -1.2], legScale: 0.8, tailZ: 0.5, wag: 0.12, wagRate: 1.2, look: 0.5 };
    switch (name) {
      case 'Idle_2':
        return { ...stand, headNod: -0.12, wag: 0.55, wagRate: 3 * speed, bounce: 0.4, rate: 1.5 * speed };
      case 'Idle_2_HeadLow':
        return { ...stand, headNod: 0.55, wag: 0.2, bob: 0.4, look: 0.2 };
      case 'Eating':
        return { ...stand, pitch: 0.06, headNod: 0.75, wag: 0.2, bob: 1, look: 0 };
      case 'Walk':
        return { ...stand, gait: 0.45, rate: 1.7 * speed, bounce: 1.1, wag: 0.25, wagRate: 2, look: 0 };
      case 'Gallop':
        return { ...stand, gait: 0.8, rate: 2.6 * speed, bounce: 2.4, gallop: 1, headNod: -0.08, wag: 0.15, wagRate: 2.6, look: 0 };
      case 'Gallop_Jump':
      case 'Jump_ToIdle':
        return { ...stand, headNod: -0.15, wag: 0.5, wagRate: 3, hop: 1, look: 0 };
      case 'Lie':
        return lie;
      case 'Sleep':
        return { ...lie, z: -L * 0.82, legs: [-1.4, -1.4, -1.2, -1.2], legScale: 0.65, headTurn: 0.55, headNod: 0.28, tailZ: 1.6, tailUp: 0.3, wag: 0, look: 0 };
      case 'Sit':
        return { ...stand, z: -L * 0.32, pitch: -0.42, legs: [0.42, 0.42, -1.25, -1.25], tailZ: 0.9, wag: 0.25 };
      default:
        return stand;
    }
  }

  has(name: string) {
    return ANIMS.includes(name as DogAnim);
  }

  bone(name: string): Object3D | undefined {
    return name === 'Head' ? this.head : undefined;
  }

  /** Cross-fade to an animation (`once` and `reverse` mean nothing here: every pose holds) */
  play(name: DogAnim, opts: { fade?: number; once?: boolean; speed?: number; reverse?: boolean } = {}) {
    const next = this.pose(this.has(name) ? name : 'Idle', opts.speed ?? 1);
    if (this.current === name) {
      // same animation, other speed
      this.to = { ...this.to, rate: next.rate, wagRate: next.wagRate };
      return;
    }
    this.current = name;
    this.from = structuredClone(this.p);
    this.to = next;
    this.fade = opts.fade ?? 0.3;
    this.k = this.fade > 0 ? 0 : 1;
    if (this.k >= 1) this.p = structuredClone(next);
  }

  update(dt: number) {
    this.t += dt;
    if (this.k < 1 && this.from) {
      this.k = Math.min(1, this.k + dt / this.fade);
      const s = this.k * this.k * (3 - 2 * this.k);
      const a = this.from;
      const b = this.to;
      const mix = (x: number, y: number) => x + (y - x) * s;
      const p = {} as Pose;
      for (const key of Object.keys(b) as (keyof Pose)[]) (p as unknown as Record<string, unknown>)[key] = key === 'legs' ? a.legs.map((v, i) => mix(v, b.legs[i])) : mix(a[key] as number, b[key] as number);
      this.p = p;
    } else this.p = { ...this.p, rate: this.to.rate, wagRate: this.to.wagRate };
    this.phase += dt * this.p.rate;
    this.wagPhase += dt * this.p.wagRate;
    this.hopPhase += dt * 1.6;
    this.apply();
  }

  private apply() {
    const p = this.p;
    const T = Math.PI * 2;
    // trot: diagonal pairs; gallop: front pair, then back pair
    const trot = [0, Math.PI, Math.PI, 0];
    const gal = [0, 0.5, Math.PI, Math.PI + 0.5];
    this.legs.forEach((lg, i) => {
      const off = trot[i] + (gal[i] - trot[i]) * p.gallop;
      lg.rotation.y = p.legs[i] + Math.sin(this.phase * T + off) * p.gait;
      lg.scale.setScalar(p.legScale);
    });
    const hop = Math.max(0, Math.sin(this.hopPhase * T)) * this.height * 0.16 * p.hop;
    this.rigG.position.z = p.z + Math.abs(Math.sin(this.phase * T)) * p.bounce + hop;
    this.rigG.rotation.y = p.pitch - (p.gallop * Math.sin(this.phase * T) * 0.08);
    // breathing
    this.rigG.scale.z = 1 + Math.sin((this.t * T) / 2.4) * 0.014;
    // looks around now and then; nods while eating or sniffing
    const look = Math.max(0, Math.sin(this.t / 7.3 + this.seed)) * p.look;
    this.head.rotation.z = p.headTurn + Math.sin(this.t / 3.9) * 0.3 * look;
    this.head.rotation.y = p.headNod - 0.12 * look + Math.sin(this.t * T * 1.8) * 0.08 * p.bob;
    this.tail.rotation.z = p.tailZ + Math.sin(this.wagPhase * T) * p.wag;
    this.tail.rotation.y = -0.45 * p.tailUp;
    // ears: a quick twitch every few seconds
    const k = (this.t + this.seed * 3.1) % 6.5;
    const tw = k < 0.25 ? Math.sin((k / 0.25) * Math.PI) * 0.35 : 0;
    this.ears.forEach((m, i) => (m.rotation.x = i % 2 ? -tw : tw));
    // panting while running or excited
    if (this.tongue) this.tongue.visible = this.current === 'Gallop' || this.current === 'Idle_2' || this.current === 'Gallop_Jump' || this.current === 'Jump_ToIdle';
  }

  /** Eyes shut while sleeping (a thin line) */
  set eyesClosed(on: boolean) {
    for (const e of this.eyes) e.scale.z = on ? 0.18 : 1;
    for (const g of this.glints) g.visible = !on;
  }

  /** The simple figure has no paintable coat */
  setPaint(_paint: PetPaint[]) {}

  dispose() {
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}
