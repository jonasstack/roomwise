import {
  CanvasTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Triangle,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type SkinnedMesh,
} from 'three';
import type { PetLook } from '../pets';
import type { PetPaint } from '../types';
import { DogActor, dogModelFor, loadDog, type DogAnim } from './pet-model';
import { SimpleDog } from './dog-simple';

/**
 * A small studio for one dog: its own renderer with soft light and a contact shadow, turnable and zoomable,
 * with picking on the coat (bind-pose position under the pointer — for painting). Used by the dog editor and
 * for the preview pictures in the inspector. The dog is the same model as on the plan.
 */
export class DogStudio {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(28, 1, 1, 5000);
  actor?: DogActor | SimpleDog;
  private az = -0.75;
  private el = 0.32;
  private dist = 1;
  private zoomK = 1;
  private target = new Vector3();
  private raf = 0;
  private last = 0;
  private running = false;
  private pose: DogAnim = 'Idle';
  private token = 0;
  private dims = { length: 60, height: 40, width: 22 };
  /** a new picture is needed (when not animating) */
  private dirty = true;
  /** animate (idle breathing, walking); off: one still frame */
  animate = true;
  /** close-up detail (finer body and wool); off: the plan's level of detail */
  fine = true;
  private ground: Mesh;
  private sun: DirectionalLight;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new HemisphereLight(0xffffff, 0xcfc6b8, 1.25));
    this.sun = new DirectionalLight(0xffffff, 1.9);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.radius = 6;
    this.scene.add(this.sun, this.sun.target);
    // a soft round floor patch and a crisp shadow on it
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.16)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const patch = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: new CanvasTexture(c), transparent: true, depthWrite: false }));
    patch.renderOrder = -1;
    patch.name = 'patch';
    this.scene.add(patch);
    this.ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.22 }));
    this.ground.receiveShadow = true;
    this.ground.position.z = 0.05;
    this.scene.add(this.ground);
  }

  /** Show a dog (rebuilds when the look changed); resolves once it is there */
  async show(look: PetLook, dims: { length: number; height: number; width: number }, pose: DogAnim = this.pose): Promise<boolean> {
    const my = ++this.token;
    const old = this.actor;
    if (look.figure === 'simple') this.actor = new SimpleDog(look, dims, { fine: this.fine });
    else {
      const model = dogModelFor(look.breed);
      const src = await loadDog(model);
      if (!src || my !== this.token) return false;
      this.actor = new DogActor(src, { length: dims.length * 1.05, height: dims.height, width: dims.width }, { ...look, model }, { fine: this.fine });
    }
    this.actor.group.traverse((o) => {
      (o as Mesh).castShadow = true;
    });
    if (old) {
      this.scene.remove(old.group);
      old.dispose();
    }
    this.scene.add(this.actor.group);
    this.dims = dims;
    this.frame();
    this.setPose(pose, true);
    return true;
  }

  /** look at the middle of the dog in its pose (lying is low, sitting tall) */
  private targetZ() {
    const h = this.dims.height;
    const k = this.pose === 'Lie' || this.pose === 'Sleep' ? 0.3 : this.pose === 'Sit' ? 0.52 : 0.45;
    return Math.max(h * k, 6);
  }

  setPose(pose: DogAnim, now = false) {
    this.pose = pose;
    if (Math.abs(this.target.z - this.targetZ()) > 0.01) {
      this.target.z = this.targetZ();
      this.place();
    }
    const a = this.actor;
    if (!a) return;
    const still = pose === 'Lie' || pose === 'Sleep' || pose === 'Sit';
    a.play(pose, { fade: now ? 0 : 0.35, once: still });
    a.eyesClosed = pose === 'Sleep';
    a.update(now ? 0.01 : 0);
    this.dirty = true;
    this.kick();
  }

  setPaint(paint: PetPaint[]) {
    this.actor?.setPaint(paint);
    this.dirty = true;
    this.kick();
  }

  /** frame the dog: distance from its size */
  private frame() {
    const L = this.dims.length;
    this.target.set(0, 0, this.targetZ());
    this.dist = L * 2.6;
    const s = L * 3;
    for (const n of ['patch']) {
      const m = this.scene.getObjectByName(n);
      m?.scale.set(s * 0.9, s * 0.9, 1);
    }
    this.ground.scale.set(s, s, 1);
    this.sun.position.set(-L * 0.8, -L * 1.2, L * 3);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -L;
    cam.right = cam.top = L;
    cam.near = 1;
    cam.far = L * 8;
    cam.updateProjectionMatrix();
    this.camera.near = L * 0.05;
    this.camera.far = L * 40;
    this.place();
  }

  private place() {
    const d = this.dist * this.zoomK;
    const ce = Math.cos(this.el);
    this.camera.position.set(this.target.x + Math.cos(this.az) * ce * d, this.target.y + Math.sin(this.az) * ce * d, this.target.z + Math.sin(this.el) * d);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  orbit(dx: number, dy: number) {
    this.az -= dx * 0.008;
    this.el = Math.max(-0.05, Math.min(1.35, this.el + dy * 0.006));
    this.place();
    this.kick();
  }

  get zoomLevel() {
    return this.zoomK;
  }

  zoom(f: number) {
    this.zoomK = Math.max(0.35, Math.min(2.2, this.zoomK * f));
    this.place();
    this.kick();
  }

  /** looking at the dog from a side: 'front' | 'side' | 'top' | 'back' */
  view(v: 'front' | 'side' | 'top' | 'back' | 'default') {
    const set = { front: [0, 0.18], side: [-Math.PI / 2, 0.15], top: [-Math.PI / 2, 1.33], back: [Math.PI, 0.3], default: [-0.75, 0.32] }[v];
    [this.az, this.el] = set;
    this.place();
    this.kick();
  }

  setSize(w: number, h: number, dpr = Math.min(2, window.devicePixelRatio || 1)) {
    if (w < 2 || h < 2) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.place();
    this.kick();
  }

  start() {
    this.running = true;
    this.kick();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private kick() {
    if (!this.running || this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.animate && this.actor) {
      this.actor.update(dt);
      this.dirty = true;
    }
    if (this.dirty) this.render();
    if (this.animate) this.raf = requestAnimationFrame(this.loop);
  };

  render() {
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** The coat under a canvas point: bind-pose position (model space) or nothing */
  pick(x: number, y: number): [number, number, number] | undefined {
    const a = this.actor;
    if (!a) return undefined;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    a.group.updateMatrixWorld(true);
    const targets: Mesh[] = [];
    a.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.visible && (m.geometry as BufferGeometry).attributes.bindPos) {
        // the pose changes: measure the skinned bounds anew
        if ((m as SkinnedMesh).isSkinnedMesh) {
          (m as SkinnedMesh).boundingSphere = null as never;
          // the box from measuring in bind pose would cut the ray off in other poses (wool is skinned too)
          (m as SkinnedMesh).boundingBox = null as never;
        }
        targets.push(m);
      }
    });
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit?.face) return undefined;
    const m = hit.object as Mesh;
    const g = m.geometry as BufferGeometry;
    const A = new Vector3();
    const B = new Vector3();
    const C = new Vector3();
    m.getVertexPosition(hit.face.a, A);
    m.getVertexPosition(hit.face.b, B);
    m.getVertexPosition(hit.face.c, C);
    const local = m.worldToLocal(hit.point.clone());
    const bc = Triangle.getBarycoord(local, A, B, C, new Vector3());
    if (!bc) return undefined;
    const bp = g.attributes.bindPos;
    const p = new Vector3()
      .addScaledVector(new Vector3().fromBufferAttribute(bp, hit.face.a), bc.x)
      .addScaledVector(new Vector3().fromBufferAttribute(bp, hit.face.b), bc.y)
      .addScaledVector(new Vector3().fromBufferAttribute(bp, hit.face.c), bc.z);
    return [p.x, p.y, p.z];
  }

  /** Model units per cm of the shown dog (brush sizes in cm) */
  get unitsPerCm(): number {
    const a = this.actor;
    return a instanceof DogActor ? a.bind.len / (this.dims.length * 0.9) : 0.05;
  }

  snapshot(type = 'image/png'): string {
    this.render();
    return this.canvas.toDataURL(type);
  }

  dispose() {
    this.stop();
    this.actor?.dispose();
    this.actor = undefined;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** One shared offscreen studio for preview pictures (inspector): a still dog, three-quarter view */
let shared: { studio: DogStudio; busy: Promise<unknown> } | undefined;
const pictures = new Map<string, Promise<string | undefined>>();

export function dogPicture(look: PetLook, dims: { length: number; height: number; width: number }, pose: DogAnim = 'Idle', size = 360): Promise<string | undefined> {
  const key = JSON.stringify([look, dims, pose, size]);
  let p = pictures.get(key);
  if (p) return p;
  if (!shared) {
    const canvas = document.createElement('canvas');
    let studio: DogStudio;
    try {
      studio = new DogStudio(canvas);
    } catch {
      // no WebGL 2: the inspector keeps its icon
      return Promise.resolve(undefined);
    }
    studio.animate = false;
    shared = { studio, busy: Promise.resolve() };
  }
  const s = shared;
  p = (s.busy = s.busy.then(async () => {
    s.studio.setSize(size, Math.round(size * 0.72), 1);
    const ok = await s.studio.show(look, dims, pose);
    s.studio.view('default');
    s.studio.zoom(0.74 / s.studio.zoomLevel);
    if (!ok) return undefined;
    s.studio.render();
    return s.studio.snapshot();
  }).catch(() => undefined)) as Promise<string | undefined>;
  pictures.set(key, p);
  if (pictures.size > 24) pictures.delete(pictures.keys().next().value!);
  return p;
}

