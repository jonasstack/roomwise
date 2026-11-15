import { idleFor, isActive, UNATTENDED } from '../activity';
import { LiveVacuum, VacuumMapper, learnedLookup, type LearnedFloor, type VacuumMap } from '../vacuum-live';
import {
  MultiplyBlending,
  PCFShadowMap,
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CatmullRomCurve3,
  CircleGeometry,
  RepeatWrapping,
  Float32BufferAttribute,
  ConeGeometry,
  CylinderGeometry,
  TubeGeometry,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  FrontSide,
  Group,
  HemisphereLight,
  LatheGeometry,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Ray,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  ShadowMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { render, svg } from 'lit';
import type { FloorConfig, FurnitureConfig, HassEntity, OpeningConfig, Point, RoomConfig, VacuumTransform } from '../types';
import { petLook, petRig, type Blob, type PetState } from '../pets';
import { DogActor, dogLookKey, dogModelFor, loadDog } from './pet-model';
import { SimpleDog } from './dog-simple';
import { buildNav, findPath, nearestFree, randomSpot, type NavGrid } from '../petnav';
import { CARS, GATE_SWING_DEG, carLive, chargePort, isOn, numOf, pieceModel, type ModelNode } from '../models';
import { buildCarMesh, carOpenParts } from './car';
import { carFromModel, carModelFor, loadCar, retryCar } from './car-model';
import type { CarOpen } from '../car-info';
import { FLOOR_TYPE } from '../floors';
import type { SunInfo } from '../ambient';
import { wallBody, wallPieces, windowInward } from '../walls';
import { DOOR_OPEN_DEG, coverLive, garageDepth, openingGeometry, openingState, windowOpenSign, windowSashes } from '../openings';
import { drawFurniture, fridgeList, resolveFurniture, stairPlan } from '../furniture';
import { furnitureParts, setDetail, type Part } from '../furniture3d';
import { furnitureFx, isStatusRing, type FurnitureFx } from '../furniture-fx';
import { DOOR_TOP, WINDOW_SILL, WINDOW_TOP, floatHeight, isFloating, onFootprint, paint } from '../plan3d';
import { closestPointOnSegment, floorBounds, pointInPolygon, polygonArea } from '../geometry';
import { tone } from '../colors';

/**
 * WebGL renderer for walls and furniture. The camera reproduces the CSS projection of the plan
 * (pan/zoom, tilt, spin, perspective) as a matrix, so the scene sits exactly on the SVG floor below
 * and the labels/markers above. One canvas instead of hundreds of CSS faces; real sun shadows.
 */
export interface GlView {
  s: number;
  tx: number;
  ty: number;
  cx: number;
  cy: number;
  persp: number;
  tilt: number;
  spin: number;
  /** viewport size in CSS px */
  width: number;
  height: number;
  /** 2D → 3D transition 0..1 (walls grow) */
  walls: number;
}

export interface GlBuild {
  wall: number;
  height: number;
  full: boolean;
  focus?: RoomConfig;
  backHeight?: number;
  alert?: Set<string>;
  sun?: SunInfo;
  spin: number;
  wallColor?: string;
  detail: number;
  editing: boolean;
  getState: (id: string) => HassEntity | undefined;
  /** A car's open parts (tailgate, frunk, sunroof, doors, windows) as the plan detects them */
  carOpen?: (f: FurnitureConfig) => CarOpen | undefined;
  /** Rooms (unlinked heaters follow their room's thermostat) */
  rooms?: RoomConfig[];
  /** Air streams through open windows (effects on) */
  wind?: boolean;
  /** All pieces of the floor (a charging car looks for its wallbox) */
  all?: FurnitureConfig[];
  /** stairs that lead down from this floor: drawn as the stairwell seen from above (flat, with their drawing) */
  stairsDown?: Set<string>;
  /** stairs to another floor (id → leads up): the dog now and then goes up (or down) them */
  stairsTo?: Map<string, boolean>;
  /** Pets: walk / presence state, the way to the front door, the walkable grid of the home */
  pet?: (f: FurnitureConfig) => { state?: PetState; way?: { path: Point[]; face: Point }; door?: { inside: Point; face: Point }; nav?: (allowClosed: boolean) => NavGrid | undefined };
}

const DEG = Math.PI / 180;
// depth mapping of the CSS perspective "w" (distance factor) to normalized device depth
/** Open sashes in 3D: turned like a real window, not flat against the wall */
const SASH_3D_DEG = 68;

const W_NEAR = 0.05;
const W_FAR = 20;
const DEPTH_C = 2 / (1 / W_NEAR - 1 / W_FAR);
const DEPTH_K = 1 + DEPTH_C / W_FAR;

const UNIT_BOX = new BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
const UNIT_CYL = new CylinderGeometry(0.5, 0.5, 1, 28, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const UNIT_SPHERE = new SphereGeometry(0.5, 24, 16).rotateX(Math.PI / 2);
const UNIT_PLANE = new PlaneGeometry(1, 1);
const UNIT_DISC = new CircleGeometry(0.5, 32);
/** Wheel: axis across (y), centred */
const UNIT_WHEEL = new CylinderGeometry(0.5, 0.5, 1, 26);
/** Cone: base at z = 0, tip at z = 1 */
const UNIT_CONE = new ConeGeometry(0.5, 1, 26).rotateX(Math.PI / 2).translate(0, 0, 0.5);

interface DogLife {
  key: string;
  actor?: DogActor | SimpleDog;
  pos: Vector2;
  heading: number;
  /** speed (cm/s) */
  v: number;
  task: 'sleep' | 'rest' | 'wake' | 'idle' | 'walk' | 'eat' | 'toDoor' | 'door' | 'toStairs' | 'climb' | 'away';
  until: number;
  last: number;
  seed: number;
  path?: Vector2[];
  seg?: number;
  after?: 'eat' | 'sniff' | 'look' | 'lie';
  /** heading to take on arrival (bowls) */
  face?: number;
  /** waiting at the door lying down */
  lying?: boolean;
  /** a pose change is still blending (full frame rate until then) */
  settle?: number;
  /** height above the floor (cm): on the stairs */
  z?: number;
  /** the stairs it takes (index into its trips), how far along, and whether it is on the way back */
  trip?: number;
  climbI?: number;
  climbBack?: boolean;
}

/** The dog's way over stairs (plan cm): from a free spot in front of them along the walking line, with the height
 *  at every point — up to the top (stairs up), or down into the stairwell (stairs leading down) */
function stairWay(s: FurnitureConfig, up: boolean, free: (p: [number, number]) => [number, number] | undefined): { foot: Vector2; pts: Vector2[]; zs: number[] } | undefined {
  const r = resolveFurniture(s);
  const sp = stairPlan(s.w, s.h, r.variant, r.count);
  if (sp.line.length < 2) return undefined;
  const a = ((s.rotation ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const world = (p: [number, number]) => new Vector2(s.x + p[0] * ca - p[1] * sa, s.y + p[0] * sa + p[1] * ca);
  // up: from the bottom step; down (seen from the upper floor): in at the top end, down to the bottom
  const line = (up ? sp.line : [...sp.line].reverse()).map((p) => world(p as [number, number]));
  const out = line[0].clone().sub(line[1]).normalize();
  const want = line[0].clone().add(out.multiplyScalar(Math.max(30, s.w * 0.25)));
  const f = free([want.x, want.y]);
  if (!f) return undefined;
  const foot = new Vector2(...f);
  const pts = [foot, ...line];
  let total = 0;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((total += pts[i].distanceTo(pts[i - 1])));
  const H = r.height;
  const zs = cum.map((c, i) => (i === 0 ? 0 : ((up ? 1 : -1) * H * c) / (total || 1)));
  return { foot, pts, zs };
}

interface FurnScene {
  group: Group;
  spinning: Object3D[];
  boxes: Map<string, { min: Vector3; max: Vector3 }>;
  geos: BufferGeometry[];
  sig: Map<string, string>;
}

/** A vacuum's trail of the current run (plan cm) and its canvas on the floor */
interface VacTrail {
  run: number;
  pts: Point[];
  lastDraw: number;
  dirty: boolean;
  width: number;
  mesh?: Mesh;
  canvas?: HTMLCanvasElement;
  box?: { minX: number; minY: number; k: number };
}

const IN_RUN = new Set(['cleaning', 'paused', 'returning']);

/** Furniture views kept ready (overview + room views) */
const FURN_CACHE = 8;

interface Anim {
  obj: Object3D;
  from: number;
  to: number;
  t0: number;
  dur: number;
  /** applies the value (default: the object's height scale) */
  apply?: (v: number) => void;
  /** linear instead of eased (a motor running at constant speed) */
  linear?: boolean;
  /** one running animation per key: a new one replaces it (a garage door rebuilt while it moves) */
  key?: string;
}

/** Lower the 3D resolution by itself when frames come late (see adaptRatio); off – sharpness wins */
const ADAPTIVE_RESOLUTION: boolean = false;

/** Tap feedback of a lamp: one short, light bounce */
const BOUNCE_MS = 450;
const BOUNCE_SCALE = 0.08;

export class GlScene {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  /** Plan coordinates live in `root`, mirrored on y so three.js' winding & lighting stay right-handed */
  private root = new Group();
  private camera = new PerspectiveCamera();
  private walls = new Group();
  /** Room values engraved into a free wall of each room (label style "wall") */
  private wallLabelGroup = new Group();
  private wallLabelSig = '';
  /** Animated dogs (own layer: they roam the whole home, independent of the cached furniture views) */
  private petGroup = new Group();
  private petSig = new Map<string, string>();
  /** Air streaming through open windows (rebuilt with the walls) */
  private windGroup = new Group();
  private windTex: { tex: Texture; speed: number }[] = [];
  private windSpeed = 8;
  private furniture = new Group();
  /** Floor drawn by WebGL (card 3D): static texture, night tint (multiply), dynamic texture */
  private floorGroup = new Group();
  private floorPlanes: Partial<Record<'static' | 'dynamic', Mesh>> = {};
  private night = new Group();
  private floorOn = false;
  private catcher: Mesh;
  private sunLight = new DirectionalLight(0xffffff, 1);
  private hemi = new HemisphereLight(0xffffff, 0xd8d2c8, 1.1);
  private view?: GlView;
  private raf = 0;
  private anims: Anim[] = [];
  private spinning: Object3D[] = [];
  private pulsing: MeshBasicMaterial[] = [];
  private probe: HTMLElement;
  private colorCache = new Map<string, Color>();
  private materials = new Map<string, Material>();
  private textures = new Map<string, Texture | Promise<Texture | undefined>>();
  private halo?: Texture;
  private loweredState = new Map<string, boolean>();
  /** World-space bounds per piece (kept when pieces are merged into batches) */
  private pieceBoxes = new Map<string, { min: Vector3; max: Vector3 }>();
  private raycaster = new Raycaster();
  destroyed = false;
  /** 'high' full quality; 'eco' lower resolution (even lower while moving), simple shadows, no looping animations */
  private profile: 'high' | 'eco' = 'high';
  private interacting = false;
  private size = { w: 0, h: 0, dpr: 1 };
  /** A popup, sheet or the editor covers the plan: looping animations wait (state changes still draw) */
  private covered = false;
  /** Covered since (performance.now()) and covered time so far: the animation clock leaves both out */
  private coveredAt = 0;
  private coveredMs = 0;
  /** Highest pixel ratio in 'high': lowered step by step when the graphics chip cannot keep the animation rate
   *  (a cheap tablet behind a sharp screen) — see adaptRatio */
  private ratioCap = 2;
  /** When the next loop frame was due, and how late the recent ones came (ms) */
  private dueAt = 0;
  private late: number[] = [];
  private lateWindows = 0;
  /** No judging before this time (start-up, models loading, a resize): those frames are late for other reasons */
  private judgeFrom = performance.now() + 15000;
  /** CPU time of the last render call (ms) and renders in the current second — for the stats overlay */
  lastFrameMs = 0;
  private frameCount = 0;
  private frameT0 = performance.now();
  fps = 0;

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      // three.js needs WebGL 2; devices with WebGL 1 only get the CSS 3D view
      const gl = c.getContext('webgl2');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return !!gl;
    } catch {
      return false;
    }
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    host: ShadowRoot,
    private weak = false,
  ) {
    // multisampling only where pixels are big: on high-density screens it costs a lot of fill rate for nothing
    const dense = (window.devicePixelRatio || 1) >= 1.5;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: !weak && !dense, powerPreference: 'high-performance', premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.root.scale.set(1, -1, 1);
    this.scene.add(this.root);
    this.root.add(this.floorGroup, this.walls, this.windGroup, this.wallLabelGroup, this.furniture, this.petGroup, this.sunLight, this.sunLight.target, this.hemi);
    this.floorGroup.add(this.night);
    this.floorGroup.visible = false;
    this.hemi.position.set(0, 0, 1);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(weak ? 1024 : 2048, weak ? 1024 : 2048);
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 1.2;
    this.sunLight.shadow.radius = 4;
    const shadowMat = new ShadowMaterial({ opacity: 0.25, transparent: true, depthWrite: false });
    this.catcher = new Mesh(UNIT_PLANE, shadowMat);
    this.catcher.receiveShadow = true;
    this.catcher.renderOrder = -1;
    this.root.add(this.catcher);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.probe = document.createElement('span');
    this.probe.style.display = 'none';
    host.appendChild(this.probe);
  }

  // ---------- colors ----------

  /** Any CSS color expression (tokens, color-mix, paint()) resolved in the plan's style context */
  color(expr: string): Color {
    const hit = this.colorCache.get(expr);
    if (hit) return hit;
    this.probe.style.color = '';
    this.probe.style.color = expr.startsWith('--') ? `var(${expr})` : expr;
    const cs = getComputedStyle(this.probe).color;
    const nums = (cs.match(/[\d.]+(e-?\d+)?/g) ?? ['0', '0', '0']).map(Number);
    const c = new Color();
    if (cs.startsWith('color(')) c.setRGB(nums[0], nums[1], nums[2], SRGBColorSpace);
    else c.setRGB(nums[0] / 255, nums[1] / 255, nums[2] / 255, SRGBColorSpace);
    // light colours change all day (tunable white): the cache must not grow forever
    if (this.colorCache.size > 600) this.colorCache.clear();
    this.colorCache.set(expr, c);
    return c;
  }

  private alpha(expr: string): number {
    this.probe.style.color = expr.startsWith('--') ? `var(${expr})` : expr;
    const cs = getComputedStyle(this.probe).color;
    const m = cs.match(/\/\s*([\d.]+)\s*\)|rgba\([^)]*,\s*([\d.]+)\)/);
    return m ? Number(m[1] ?? m[2]) : 1;
  }

  // ---------- floor (card 3D) ----------

  /** Show the WebGL floor (the SVG floor is hidden meanwhile) */
  setFloorVisible(on: boolean) {
    this.floorOn = on;
    this.floorGroup.visible = on;
    this.requestRender();
  }

  hasFloorLayer(kind: 'static' | 'dynamic') {
    return !!this.floorPlanes[kind];
  }

  /** Where a (moving) piece is right now (plan cm) */
  piecePos(id: string): [number, number] | undefined {
    const g = this.furniture.children.find((c) => c.userData.id === id);
    return g ? [g.position.x, g.position.y] : undefined;
  }

  /** A rasterized floor layer as a textured plane covering `region` (plan cm) */
  private fades: { mesh: Mesh; from: number; to: number; t0: number; dur: number; dispose?: boolean }[] = [];

  setFloorLayer(kind: 'static' | 'dynamic', canvas: HTMLCanvasElement | undefined, region: { x: number; y: number; w: number; h: number }) {
    if (kind === 'dynamic' && canvas && this.floorPlanes.dynamic) {
      // light changes blend over softly: the old layer fades out while the new one fades in
      const old = this.floorPlanes.dynamic;
      this.floorPlanes.dynamic = undefined;
      this.fades.push({ mesh: old, from: (old.material as MeshBasicMaterial).opacity, to: 0, t0: performance.now(), dur: 380, dispose: true });
      this.setFloorLayer('dynamic', canvas, region);
      const fresh = this.floorPlanes.dynamic as Mesh | undefined;
      if (fresh) {
        (fresh.material as MeshBasicMaterial).opacity = 0;
        this.fades.push({ mesh: fresh, from: 0, to: 1, t0: performance.now(), dur: 380 });
      }
      this.requestRender();
      return;
    }
    let mesh = this.floorPlanes[kind];
    if (!canvas) {
      if (mesh) mesh.visible = false;
      this.requestRender();
      return;
    }
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 4;
    if (!mesh) {
      mesh = new Mesh(UNIT_PLANE, new MeshBasicMaterial({ transparent: true, depthWrite: false }));
      mesh.renderOrder = kind === 'static' ? -4 : -2;
      mesh.raycast = () => {};
      this.floorPlanes[kind] = mesh;
      this.floorGroup.add(mesh);
    }
    const mat = mesh.material as MeshBasicMaterial;
    mat.map?.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
    mesh.visible = true;
    mesh.scale.set(region.w, region.h, 1);
    mesh.position.set(region.x + region.w / 2, region.y + region.h / 2, kind === 'static' ? 0 : 0.05);
    this.requestRender();
  }

  /** Hausregeln alarm: red rings at the devices that caused it (expanding, fading) */
  private pulses: { mesh: Mesh; t0: number }[] = [];
  /** Lamps that were just tapped: a short, light bounce (id → start) */
  private bounces = new Map<string, number>();
  private pulseTex?: Texture;

  pulseRings(pts: Point[], color: string) {
    if (!this.pulseTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      const gr = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,0.12)');
      gr.addColorStop(0.72, 'rgba(255,255,255,0.3)');
      gr.addColorStop(0.86, 'rgba(255,255,255,1)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, 128, 128);
      this.pulseTex = new CanvasTexture(c);
    }
    const mat = new MeshBasicMaterial({ map: this.pulseTex, color: this.color(color), transparent: true, opacity: 1, depthWrite: false, depthTest: false, side: DoubleSide });
    const now = performance.now();
    for (const p of pts) {
      const m = new Mesh(UNIT_PLANE, mat);
      m.position.set(p[0], p[1], 1.5);
      m.raycast = () => {};
      m.renderOrder = 7;
      m.scale.set(20, 20, 1);
      this.root.add(m);
      this.pulses.push({ mesh: m, t0: now });
    }
    this.requestRender();
  }

  /** Night: unlit rooms cool down (multiplied ambient colour) */
  setNightTint(polys: Point[][], color: string, k: number) {
    for (const c of [...this.night.children]) {
      c.removeFromParent();
      (c as Mesh).geometry.dispose();
    }
    if (k > 0.01 && polys.length) {
      const tint = new Color(1, 1, 1).lerp(this.color(color), Math.min(1, k));
      const mat = new MeshBasicMaterial({ color: tint, blending: MultiplyBlending, transparent: true, premultipliedAlpha: true, depthWrite: false });
      for (const poly of polys) {
        const sh = new Shape(poly.map(([x, y]) => new Vector2(x, y)));
        const m = new Mesh(new ShapeGeometry(sh), mat);
        m.position.z = 0.02;
        m.renderOrder = -3;
        m.raycast = () => {};
        this.night.add(m);
      }
    }
    this.requestRender();
  }

  get floorActive() {
    return this.floorOn;
  }

  /** Called when the theme changes */
  resetColors() {
    this.colorCache.clear();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const t of this.textures.values()) if (t instanceof Texture) t.dispose();
    this.textures.clear();
  }

  private lambert(color: Color, opts: { opacity?: number; side?: 'double'; depthWrite?: boolean } = {}): MeshLambertMaterial {
    color = quantize(color);
    const key = `l|${color.getHexString()}|${opts.opacity ?? 1}|${opts.side ?? ''}|${opts.depthWrite ?? ''}`;
    let m = this.materials.get(key) as MeshLambertMaterial | undefined;
    if (!m) {
      const op = opts.opacity ?? 1;
      m = new MeshLambertMaterial({ color, transparent: op < 1, opacity: op, side: opts.side === 'double' ? DoubleSide : FrontSide, depthWrite: opts.depthWrite ?? op >= 1 });
      this.materials.set(key, m);
    }
    return m;
  }

  private basic(color: Color, opacity = 1): MeshBasicMaterial {
    color = quantize(color);
    const key = `b|${color.getHexString()}|${opacity}`;
    let m = this.materials.get(key) as MeshBasicMaterial | undefined;
    if (!m) {
      m = new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: DoubleSide });
      this.materials.set(key, m);
    }
    return m;
  }

  // ---------- camera ----------

  setSize(width: number, height: number, dpr: number) {
    this.size = { w: width, h: height, dpr };
    // a resize costs a few slow frames: they say nothing about the chip
    this.judgeFrom = Math.max(this.judgeFrom, performance.now() + 5000);
    this.applyResolution();
  }

  /** Pixel ratio: full (capped) in 'high'; ~60 % in 'eco', ~45 % while a gesture moves the view */
  private applyResolution() {
    const { w, h, dpr } = this.size;
    if (!w || !h) return;
    let ratio = Math.min(dpr, this.weak ? 1.5 : 2, this.ratioCap);
    if (this.profile === 'eco') ratio = Math.max(0.75, dpr * (this.interacting ? 0.45 : 0.6));
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.01 || this.renderer.domElement.width !== Math.round(w * ratio)) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
    this.requestRender();
  }

  setProfile(p: 'high' | 'eco') {
    if (p === this.profile) return;
    this.profile = p;
    const soft = p === 'high' && !this.weak;
    this.renderer.shadowMap.type = soft ? PCFSoftShadowMap : PCFShadowMap;
    const size = soft ? 2048 : 1024;
    this.sunLight.shadow.mapSize.set(size, size);
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null as never;
    for (const m of this.materials.values()) m.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.applyResolution();
  }

  get profileName() {
    return this.profile;
  }

  /** Popups, sheets and the editor cover the plan: animations under them stop, so scrolling them stays smooth on
   *  tablets (the graphics chip no longer draws the scene underneath 30 times a second) */
  setCovered(on: boolean) {
    if (on === this.covered) return;
    if (on) this.coveredAt = performance.now();
    else this.coveredMs += performance.now() - this.coveredAt;
    this.covered = on;
    this.late = [];
    if (!on) this.requestRender();
  }

  /** Time of the living pieces (ms): like performance.now(), but it stands still while the plan is covered —
   *  after a popup closes, heat streams, fans, mower and dogs go on where they stopped instead of jumping */
  animNow(): number {
    return (this.covered ? this.coveredAt : performance.now()) - this.coveredMs;
  }

  /** Loop frames that keep coming more than a refresh late (two windows of 30 frames in a row): the chip is too
   *  slow for this many pixels — draw a quarter step coarser, down to three quarters of the screen's density
   *  (2 → 1.75 → 1.5 on a DPR 2 tablet), never below 1.25 */
  private adaptRatio(now: number) {
    // off: the owner prefers the sharp picture at full screen density; the popup rest already keeps scrolling smooth
    if (ADAPTIVE_RESOLUTION === false || !this.dueAt || this.profile !== 'high' || now < this.judgeFrom) return;
    this.late.push(now - this.dueAt);
    if (this.late.length < 30) return;
    const median = this.late.sort((a, b) => a - b)[15];
    this.late = [];
    this.lateWindows = median > 12 ? this.lateWindows + 1 : 0;
    const ratio = this.renderer.getPixelRatio();
    const floor = Math.max(1.25, this.size.dpr * 0.75);
    if (this.lateWindows < 2 || ratio <= floor + 0.01) return;
    this.lateWindows = 0;
    this.ratioCap = Math.max(floor, ratio - 0.25);
    this.judgeFrom = now + 5000;
    this.applyResolution();
  }

  /** Lower the resolution while the view moves (eco); back to the sharp image when it rests */
  setInteracting(on: boolean) {
    if (on === this.interacting) return;
    this.interacting = on;
    if (this.profile === 'eco') this.applyResolution();
  }

  /** The CSS chain world·T(c)·perspective·rotateX(tilt)·rotateZ(spin)·T(−c) as the camera projection */
  setView(v: GlView) {
    this.view = v;
    const persp = new DOMMatrix();
    persp.m34 = -1 / v.persp;
    const m = new DOMMatrix().translate(v.tx, v.ty).scale(v.s).translate(v.cx, v.cy).multiply(persp).rotate(v.tilt, 0, 0).rotate(0, 0, v.spin).translate(-v.cx, -v.cy);
    // DOMMatrix (column vectors, mCR) → row-major A
    const A = new Matrix4().set(m.m11, m.m21, m.m31, m.m41, m.m12, m.m22, m.m32, m.m42, m.m13, m.m23, m.m33, m.m43, m.m14, m.m24, m.m34, m.m44);
    const d = v.persp;
    const N = new Matrix4().set(2 / v.width, 0, 0, -1, 0, -2 / v.height, 0, 1, 0, 0, -DEPTH_C / d, DEPTH_K - DEPTH_C, 0, 0, 0, 1);
    // root mirrors y; undo it in the projection
    const mirror = new Matrix4().makeScale(1, -1, 1);
    this.camera.projectionMatrix.copy(N).multiply(A).multiply(mirror);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorld.identity();
    this.camera.matrixWorldInverse.identity();
    // walls grow when switching from 2D to 3D
    this.walls.scale.z = Math.max(0.001, v.walls);
    this.furniture.scale.z = Math.max(0.001, v.walls);
    this.canvas.style.opacity = this.floorOn ? '1' : String(Math.min(1, v.walls * 1.4));
    this.requestRender();
  }

  // ---------- lighting ----------

  setLighting(sun: SunInfo | undefined, b: { minX: number; minY: number; maxX: number; maxY: number }, night: number) {
    // light colours follow the time of day: always read fresh
    for (const k of ['--fp-sun-tint', '--fp-amb', '--fp-shadow-tint']) this.colorCache.delete(k);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 800;
    const up = !!sun?.up;
    const dir: Point = up ? sun!.dir : [-0.55, -0.85];
    const el = (up ? Math.max(6, sun!.elevation) : 50) * DEG;
    const dist = 3000;
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    this.sunLight.position.set(cx + (dir[0] / dl) * Math.cos(el) * dist, cy + (dir[1] / dl) * Math.cos(el) * dist, Math.sin(el) * dist);
    this.sunLight.target.position.set(cx, cy, 0);
    const strength = up ? sun!.strength : 0;
    this.sunLight.color.copy(up ? this.color('--fp-sun-tint') : this.color('rgb(205, 214, 255)'));
    // three.js (physically based units): Lambert diffuse ≈ irradiance / π
    this.sunLight.intensity = Math.PI * (up ? 0.45 + 1.0 * strength : 0.35 - 0.2 * night);
    this.sunLight.castShadow = up;
    const cam = this.sunLight.shadow.camera;
    cam.left = -size / 2;
    cam.right = size / 2;
    cam.top = size / 2;
    cam.bottom = -size / 2;
    cam.near = 10;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    // sky light: palette colors (bluish at night), a little softer when the sun is strong (it also lifts the
    // shadowed sides: shadows stay readable without going near black)
    const ambK = Number(getComputedStyle(this.probe).getPropertyValue('--fp-amb-k')) || 0;
    const sky = this.color('#ffffff').clone().lerp(this.color('--fp-amb'), Math.min(1, ambK * 1.4));
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(sky.clone().multiplyScalar(0.72));
    this.hemi.intensity = Math.PI * (up ? 0.8 - 0.1 * strength : 0.7) * (1 - 0.45 * night);
    // ground shadows: a shadow-only plane over the SVG floor
    (this.catcher.material as ShadowMaterial).color.copy(this.color('--fp-shadow-tint'));
    (this.catcher.material as ShadowMaterial).opacity = up ? 0.12 + 0.15 * strength : 0;
    this.catcher.position.set(cx, cy, 0.15);
    this.catcher.scale.set(size, size, 1);
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  // ---------- walls ----------

  buildWalls(floor: FloorConfig, o: GlBuild) {
    this.clear(this.walls);
    for (const c of [...this.windGroup.children]) {
      const m = c as Mesh;
      m.geometry?.dispose();
      ((m.material as MeshBasicMaterial)?.map as Texture | undefined)?.dispose();
      (m.material as Material)?.dispose();
      c.removeFromParent();
    }
    this.windTex = [];
    const sp = o.spin * DEG;
    const facing = (n: Point) => n[0] * Math.sin(sp) + n[1] * Math.cos(sp);
    const wallSide = this.color('--fp-wall-side');
    const wallTop = this.color('--fp-wall-top');
    const doorSide = this.color('--fp-door-3d');
    const doorTop = this.color('--fp-door');
    const glass = this.color('--fp-glass');
    const glassA = Math.max(0.25, Math.min(0.7, this.alpha('--fp-glass') * 0.55 + 0.12));
    const openC = this.color('--fp-state-alert');
    const frameC = this.color('--fp-window-frame');
    const sillC = this.color('--fp-wall-top');
    const handleC = this.color('--fp-handle');
    const ext = o.wallColor ? this.color(paint(o.wallColor)) : undefined;
    // zoomed onto a room: walls of other rooms between the camera and it are left out entirely
    const camDir: Point = [Math.sin(sp), Math.cos(sp)];
    const side: Point = [Math.cos(sp), -Math.sin(sp)];
    let inFront: ((a: Point, b: Point) => boolean) | undefined;
    if (o.focus && o.focus.points.length >= 3) {
      const pts = o.focus.points;
      const cx = pts.reduce((t, q) => t + q[0], 0) / pts.length;
      const cy = pts.reduce((t, q) => t + q[1], 0) / pts.length;
      const along = (q: Point) => (q[0] - cx) * camDir[0] + (q[1] - cy) * camDir[1];
      const across = (q: Point) => (q[0] - cx) * side[0] + (q[1] - cy) * side[1];
      const front = Math.max(...pts.map(along));
      const lo = Math.min(...pts.map(across)) - 40;
      const hi = Math.max(...pts.map(across)) + 40;
      inFront = (a, b) => Math.min(along(a), along(b)) >= front - 5 && Math.max(across(a), across(b)) > lo && Math.min(across(a), across(b)) < hi;
    }
    for (const p of wallPieces(floor)) {
      const dx = p.b[0] - p.a[0];
      const dy = p.b[1] - p.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const angle = Math.atan2(dy, dx);
      const mid: Point = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
      const segN: Point = [-dy / len, dx / len];
      const touchesFocus = !!o.focus && (p.front === o.focus || p.back === o.focus);
      if (!touchesFocus && inFront?.(p.a, p.b)) continue;
      const towards = touchesFocus ? false : p.outward ? facing(p.outward) > 0.5 : o.full && Math.abs(facing(segN)) > 0.5;
      const isBack = !!p.outward && facing(p.outward) < -0.3;
      const H = isBack && o.backHeight && o.backHeight > o.height ? o.backHeight : o.height;
      let lowered = false;
      if (touchesFocus) {
        const nIn: Point = p.front === o.focus ? segN : [-segN[0], -segN[1]];
        lowered = facing(nIn) < -0.3;
      }
      const other = !!o.focus && !touchesFocus;
      const opacity = towards ? 0.16 : other ? 0.2 : 1;
      const sideColor = (room?: { wall_color?: string }) => (room ? (room.wall_color ? this.color(paint(room.wall_color)) : wallSide) : (ext ?? wallSide));
      const front = sideColor(p.front);
      const back = sideColor(p.back);
      const g = new Group();
      g.position.set(mid[0], mid[1], 0);
      g.rotation.z = angle;
      const key = `${p.a.join(',')}|${p.b.join(',')}`;
      const was = this.loweredState.get(key);
      this.loweredState.set(key, lowered);
      // the focused room's own walls towards the camera sink almost to the floor (only a line stays)
      g.scale.z = (was ?? lowered) ? 0.03 : 1;
      if (was !== undefined && was !== lowered) {
        this.animate(g, lowered ? 0.03 : 1, 420);
        g.userData.keep = true; // animates: stays a separate object
      }
      const slab = (l: number, h: number, z = 0, x = 0) => {
        const mats = [wallSide, wallSide, front, back, wallTop, wallSide].map((c, i) =>
          this.lambert(c, { opacity: i === 4 && opacity < 1 ? Math.min(1, opacity + 0.3) : opacity }),
        );
        const m = new Mesh(UNIT_BOX, mats);
        m.scale.set(l, o.wall, Math.max(0.5, h));
        m.position.set(x, 0, z);
        m.castShadow = opacity >= 1;
        m.receiveShadow = true;
        if (opacity < 1) m.renderOrder = 2;
        g.add(m);
      };
      this.walls.add(g);
      if (p.kind === 'wall') {
        const body = wallBody(p, o.wall);
        slab(body.len, H, 0, (body.mid[0] - mid[0]) * Math.cos(angle) + (body.mid[1] - mid[1]) * Math.sin(angle));
        continue;
      }
      const st = openingState(p.opening?.entity ? o.getState(p.opening.entity) : undefined);
      const frameMat = this.lambert(frameC, { opacity });
      /** box centred at (x, y, z) in the piece's frame (x along the wall from its middle, y across, z up) */
      const box = (parent: Group, mat: Material, x: number, y: number, z: number, w: number, d: number, h: number) => {
        const m = new Mesh(UNIT_BOX, mat);
        m.scale.set(Math.max(0.2, w), Math.max(0.2, d), Math.max(0.2, h));
        m.position.set(x, y, z - h / 2); // z: centre (the unit box stands on its base)
        m.castShadow = opacity >= 1;
        m.receiveShadow = true;
        if (opacity < 1) m.renderOrder = 2;
        parent.add(m);
        return m;
      };
      if (p.kind === 'window') {
        const win = p.opening!;
        const sill = H * WINDOW_SILL;
        const top = H * WINDOW_TOP;
        slab(len, sill);
        slab(len, H - top, top);
        const wlen = Math.hypot(win.b[0] - win.a[0], win.b[1] - win.a[1]) || 1;
        const wang = Math.atan2(win.b[1] - win.a[1], win.b[0] - win.a[0]);
        const inward = windowInward(win, floor);
        const inSign = windowOpenSign(win, inward);
        // room side in the window's own frame (+1: local +y), independent of the opening direction
        const roomSide = inward ? (inward[0] * -Math.sin(wang) + inward[1] * Math.cos(wang) >= 0 ? 1 : -1) : 1;
        const wg = new Group();
        const alert = !!o.alert?.has(win.id);
        const open = st === 'open';
        const T = o.wall;
        const fd = Math.min(T * 0.7, 7); // frame depth
        // outer frame (white profile) and the inner window sill
        box(wg, frameMat, wlen / 2, 0, sill + 1.5, wlen, fd, 3);
        box(wg, frameMat, wlen / 2, 0, top - 1.5, wlen, fd, 3);
        box(wg, frameMat, 1.5, 0, (sill + top) / 2, 3, fd, top - sill);
        box(wg, frameMat, wlen - 1.5, 0, (sill + top) / 2, 3, fd, top - sill);
        box(wg, this.lambert(sillC, { opacity }), wlen / 2, roomSide * (T / 2 + 2), sill - 1, wlen + 8, 5, 2);
        for (const sh of windowSashes(wlen, !!win.hinge_b)) {
          const hinge = new Group();
          hinge.position.set(sh.x + (sh.dir > 0 ? 3 : -3), roomSide * 1, 0);
          hinge.rotation.z = open ? sh.dir * inSign * SASH_3D_DEG * DEG : 0;
          const sl = sh.length - 3.5; // sash between the frame and the middle
          const cx = (sh.dir > 0 ? 1 : -1) * (sl / 2);
          const z0 = sill + 3;
          const z1 = top - 3;
          // sash profile: amber while open, so an open window reads at a glance
          const sashMat = open && !alert ? this.lambert(openC, { opacity }) : frameMat;
          box(hinge, sashMat, cx, 0, z0 + 1.25, sl, 4.5, 2.5);
          box(hinge, sashMat, cx, 0, z1 - 1.25, sl, 4.5, 2.5);
          box(hinge, sashMat, (sh.dir > 0 ? 1.25 : -1.25), 0, (z0 + z1) / 2, 2.5, 4.5, z1 - z0);
          box(hinge, sashMat, (sh.dir > 0 ? sl - 1.25 : -sl + 1.25), 0, (z0 + z1) / 2, 2.5, 4.5, z1 - z0);
          // handle on the room side of the opening edge
          box(hinge, this.lambert(handleC), (sh.dir > 0 ? sl - 1.5 : -sl + 1.5), roomSide * 3.4, (z0 + z1) / 2, 1.4, 1.6, 7);
          let mat: Material;
          if (alert) {
            const am = new MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 1, side: DoubleSide });
            this.pulsing.push(am);
            mat = am;
          } else mat = this.glassMaterial(glass, glassA * (opacity < 1 ? 0.5 : 1));
          const pane = new Mesh(UNIT_PLANE, mat);
          pane.rotation.x = Math.PI / 2;
          pane.scale.set(sl - 4, z1 - z0 - 4, 1);
          pane.position.set(cx, 0, (z0 + z1) / 2);
          pane.renderOrder = 3;
          hinge.add(pane);
          wg.add(hinge);
        }
        if (alert) this.requestRender();
        if (open && o.wind) {
          const wmid: Point = [(win.a[0] + win.b[0]) / 2, (win.a[1] + win.b[1]) / 2];
          // room view: only that room's windows
          if (inward && (!o.focus || pointInPolygon([wmid[0] + inward[0] * 25, wmid[1] + inward[1] * 25], o.focus.points))) this.windFlow(win, inward, sill, top);
        }
        g.add(wg);
        wg.position.set(win.a[0] - mid[0], win.a[1] - mid[1], 0);
        wg.position.applyAxisAngle(new Vector3(0, 0, 1), -angle);
        wg.rotation.z = wang - angle;
        continue;
      }
      if (p.kind === 'garage') {
        this.garageDoor(g, p.opening!, floor, { len, angle, segN, H, opacity, frameMat, doorSide, doorTop, openC, getState: o.getState });
        slab(len, H - H * DOOR_TOP, H * DOOR_TOP);
        continue;
      }
      // door: lintel, frame (jambs + head, a little proud of the wall) and the leaf with handles
      const Hd = H * DOOR_TOP;
      slab(len, H - Hd, Hd);
      const T = o.wall;
      box(g, frameMat, -len / 2 + 1.75, 0, Hd / 2, 3.5, T + 2.5, Hd);
      box(g, frameMat, len / 2 - 1.75, 0, Hd / 2, 3.5, T + 2.5, Hd);
      box(g, frameMat, 0, 0, Hd - 1.75, len, T + 2.5, 3.5);
      const og = openingGeometry(p.opening!);
      const leafAngle = st === 'closed' ? 0 : og.sign * DOOR_OPEN_DEG * DEG;
      const dg = new Group();
      const hinge: Point = [og.hinge[0] - mid[0], og.hinge[1] - mid[1]];
      const hv = new Vector3(hinge[0], hinge[1], 0).applyAxisAngle(new Vector3(0, 0, 1), -angle);
      dg.position.copy(hv);
      dg.rotation.z = Math.atan2(og.dir[1], og.dir[0]) - angle + leafAngle;
      const L = og.length - 7;
      const leafMat = [doorSide, doorSide, doorSide, doorSide, doorTop, doorSide].map((c) => this.lambert(c, { opacity }));
      const leaf = new Mesh(UNIT_BOX, leafMat);
      leaf.scale.set(L, 4, Hd - 4.5);
      leaf.position.set(L / 2 + 3.5, 0, 0.5);
      leaf.castShadow = opacity >= 1;
      leaf.receiveShadow = true;
      if (opacity < 1) leaf.renderOrder = 2;
      dg.add(leaf);
      // lever handles on both faces near the free edge
      const hMat = this.lambert(handleC, { opacity });
      for (const side of [-1, 1]) {
        box(dg, hMat, L + 3.5 - 6, side * 2.6, Hd * 0.48, 2.2, 1.4, 4);
        box(dg, hMat, L + 3.5 - 9.5, side * 3.6, Hd * 0.48 + 1.2, 9, 1.4, 1.6);
      }
      g.add(dg);
    }
    this.bake(this.walls);
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  /** How far each garage door is open as last drawn (it runs on from there when its state changes) */
  private garagePos = new Map<string, number>();

  /**
   * Garage door in its wall opening (piece frame: x along the wall from its middle, y across, z up): frame and a
   * door that runs between closed and open — sectional panels go up and back under the ceiling, a roller door rolls
   * up into its box, an up-and-over leaf tilts inwards. It moves from where it was to the new state.
   */
  private garageDoor(
    g: Group,
    op: OpeningConfig,
    floor: FloorConfig,
    c: { len: number; angle: number; segN: Point; H: number; opacity: number; frameMat: Material; doorSide: Color; doorTop: Color; openC: Color; getState: (id: string) => HassEntity | undefined },
  ) {
    const { len, H, opacity } = c;
    const Hd = H * DOOR_TOP;
    const live = coverLive(op.entity ? c.getState(op.entity) : undefined);
    const inward = windowInward(op, floor) ?? c.segN;
    const side = (inward[0] * c.segN[0] + inward[1] * c.segN[1] >= 0 ? 1 : -1) * (op.flip ? -1 : 1);
    const add = (parent: Object3D, mat: Material | Material[]) => {
      const m = new Mesh(UNIT_BOX, mat);
      m.castShadow = opacity >= 1;
      m.receiveShadow = true;
      if (opacity < 1) m.renderOrder = 2;
      parent.add(m);
      return m;
    };
    // frame: jambs and head
    for (const x of [-len / 2 + 2, len / 2 - 2]) {
      const j = add(g, c.frameMat);
      j.scale.set(4, 12, Hd);
      j.position.set(x, 0, 0);
    }
    const head = add(g, c.frameMat);
    head.scale.set(len, 12, 4);
    head.position.set(0, 0, Hd - 4);
    const W = len - 8;
    const top = Hd - 4;
    const open = live.state === 'open';
    const mats = (open ? [c.openC, c.openC, c.doorSide, c.doorSide, c.doorTop, c.openC] : [c.doorSide, c.doorSide, c.doorSide, c.doorSide, c.doorTop, c.doorSide]).map((col) => this.lambert(col, { opacity }));
    const door = new Group();
    door.userData.keep = true; // moves: never merged into the static walls
    g.add(door);
    let apply: (k: number) => void;
    if (op.variant === 'up_over') {
      const pivot = new Group();
      pivot.position.set(0, 0, top);
      door.add(pivot);
      const leaf = add(pivot, mats);
      leaf.scale.set(W, 4, top);
      leaf.position.set(0, 0, -top);
      apply = (k) => (pivot.rotation.x = side * k * (Math.PI / 2) * 0.92);
    } else {
      const vert = add(door, mats);
      const roller = op.variant === 'roller';
      const flat = roller ? undefined : add(door, mats);
      if (roller) {
        // the coil's box inside, under the lintel
        const coil = add(door, this.lambert(c.doorSide, { opacity }));
        coil.scale.set(W + 4, 12, 12);
        coil.position.set(0, side * 9, top - 12);
      }
      const D = Math.min(top, garageDepth(op.variant, len));
      apply = (k) => {
        const z0 = (roller ? top - 12 : top) * k;
        vert.scale.set(W, 3.5, Math.max(0.2, (roller ? top - 12 : top) - z0));
        vert.position.set(0, 0, z0);
        vert.visible = vert.scale.z > 0.6;
        if (flat) {
          flat.scale.set(W, Math.max(0.2, D * k), 3);
          flat.position.set(0, side * ((D * k) / 2 + 2), top - 3);
          flat.visible = k > 0.01;
        }
      };
    }
    const key = op.id;
    const target = live.open;
    const from = this.garagePos.get(key) ?? target;
    const set = (k: number) => {
      this.garagePos.set(key, k);
      apply(k);
    };
    set(from);
    this.anims = this.anims.filter((a) => a.key !== key);
    if (Math.abs(target - from) > 0.005) {
      // a running door without a position report: at motor speed (~12 s end to end), else a short glide
      const dur = live.moving ? 12000 * Math.abs(target - from) : 500 + 1500 * Math.abs(target - from);
      this.anims.push({ obj: door, from, to: target, t0: performance.now(), dur, apply: set, linear: !!live.moving, key });
      this.requestRender();
    }
  }

  // ---------- furniture ----------

  /**
   * Furniture scenes are cached per view (overview, each room view): switching views swaps a prebuilt group
   * instead of rebuilding every piece. `key` names the view; `sig` is the live-state signature it was built with.
   */
  private furnCache = new Map<string, FurnScene>();
  private furnKey = '';
  private wallGeos: BufferGeometry[] = [];

  /** Show the cached furniture of a view; returns its state signature (undefined: not cached) */
  useFurniture(key: string): Map<string, string> | undefined {
    const s = this.furnCache.get(key);
    if (!s) return undefined;
    // most recently used last
    this.furnCache.delete(key);
    this.furnCache.set(key, s);
    this.showFurniture(key, s);
    return s.sig;
  }

  buildFurniture(floor: FloorConfig, o: GlBuild, key = '', sig = new Map<string, string>()) {
    const s = this.makeFurniture(floor, o);
    s.sig = sig;
    this.storeFurniture(key, s);
    this.showFurniture(key, s);
  }

  /** Build a view's furniture ahead of time (idle), without showing it */
  prebuildFurniture(floor: FloorConfig, o: GlBuild, key: string, sig: Map<string, string>) {
    if (this.furnCache.has(key)) return;
    const s = this.makeFurniture(floor, o);
    s.sig = sig;
    this.storeFurniture(key, s);
  }

  hasFurniture(key: string) {
    return this.furnCache.has(key);
  }

  get furnitureCacheFull() {
    return this.furnCache.size >= FURN_CACHE;
  }

  /** Forget all cached views (floor or theme changed) */
  dropFurnitureCache() {
    for (const s of this.furnCache.values()) if (s.group !== this.furniture) this.disposeFurn(s);
    this.furnCache.clear();
    if (this.furnKey) this.furnKey = '';
  }

  /** Live-state signature of the shown furniture after incremental updates */
  setFurnitureSig(sig: Map<string, string>) {
    const s = this.furnCache.get(this.furnKey);
    if (s) s.sig = sig;
  }

  private showFurniture(key: string, s: FurnScene) {
    const prev = this.furniture;
    if (prev !== s.group) {
      // the previous group stays in the cache (or is disposed when it was never cached)
      const cachedPrev = [...this.furnCache.values()].some((c) => c.group === prev);
      if (!cachedPrev && this.current) this.disposeFurn(this.current);
      s.group.scale.z = prev.scale.z;
      prev.removeFromParent();
      this.root.add(s.group);
    }
    this.furniture = s.group;
    this.spinning = s.spinning;
    this.pieceBoxes = s.boxes;
    this.current = s;
    this.furnKey = key;
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  private current?: FurnScene;

  private storeFurniture(key: string, s: FurnScene) {
    if (!key) return;
    const old = this.furnCache.get(key);
    if (old && old.group !== this.furniture) this.disposeFurn(old);
    this.furnCache.delete(key);
    this.furnCache.set(key, s);
    // keep a handful of views (least recently used go first, never the shown one)
    while (this.furnCache.size > FURN_CACHE) {
      const [k, v] = [...this.furnCache].find(([, c]) => c.group !== this.furniture) ?? [];
      if (!k || !v) break;
      this.furnCache.delete(k);
      this.disposeFurn(v);
    }
  }

  private disposeFurn(s: FurnScene) {
    s.group.removeFromParent();
    this.release(s.group);
    for (const g of s.geos) g.dispose();
    s.geos = [];
  }

  /**
   * Frees what a removed object owned on the GPU: geometry built for it after its scene (incremental
   * updates, vacuums) and its one-off materials (shared, cached materials stay). Without this every state
   * change left a few geometries behind and a tablet got slower by the hour.
   */
  private release(obj: Object3D) {
    const cached = new Set(this.materials.values());
    obj.traverse((o) => {
      const own = o.userData.own as { geos: BufferGeometry[] } | undefined;
      if (own) {
        for (const g of own.geos) g.dispose();
        own.geos = [];
      }
      if (o.userData.ownGeo) (o as Mesh).geometry?.dispose();
      if (o.userData.ownTex) ((o as Mesh).material as MeshBasicMaterial).map?.dispose();
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) if (!cached.has(x)) x.dispose();
    });
  }

  /** Builds furniture into a fresh group (the shown scene is left untouched) */
  private makeFurniture(floor: FloorConfig, o: GlBuild): FurnScene {
    const saved = { furniture: this.furniture, spinning: this.spinning, boxes: this.pieceBoxes };
    const s: FurnScene = { group: new Group(), spinning: [], boxes: new Map(), geos: [], sig: new Map() };
    this.furniture = s.group;
    this.spinning = s.spinning;
    this.pieceBoxes = s.boxes;
    this.bakeInto = s.geos;
    try {
      setDetail(Math.max(1.6, o.detail));
      const items = floor.furniture ?? [];
      const ctx = { cut: o.height, supports: items.filter((f) => resolveFurniture(f).k?.support), glassC: this.color('--fp-glass') };
      for (const f of items) {
        const g = this.buildPiece(f, o, ctx);
        if (g) this.furniture.add(g);
      }
      this.furniture.updateMatrixWorld(true);
      for (const g of this.furniture.children) {
        if (!g.userData.id || !g.visible) continue;
        const min = new Vector3(Infinity, Infinity, Infinity);
        const max = new Vector3(-Infinity, -Infinity, -Infinity);
        g.traverse((o) => {
          const m = o as Mesh;
          if (!m.isMesh || m.raycast !== Mesh.prototype.raycast) return;
          m.geometry.computeBoundingBox();
          const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
          min.min(bb.min);
          max.max(bb.max);
        });
        if (isFinite(min.x)) this.pieceBoxes.set(g.userData.id, { min, max });
      }
      this.bake(this.furniture);
    } finally {
      this.furniture = saved.furniture;
      this.spinning = saved.spinning;
      this.pieceBoxes = saved.boxes;
      this.bakeInto = undefined;
    }
    return s;
  }

  /** Geometry created for a piece belongs to the furniture scene being built (or the shown one) */
  private own(geo: BufferGeometry) {
    if (this.bakeInto) this.bakeInto.push(geo);
    else if (this.pieceOwn) this.pieceOwn.geos.push(geo);
    else (this.current?.geos ?? this.wallGeos).push(geo);
  }

  /** Geometry of the piece being built outside a scene build (freed with the piece, see release) */
  private pieceOwn?: { geos: BufferGeometry[] };

  /** Where bake() keeps the merged geometry it creates (furniture scene being built, else the walls) */
  private bakeInto?: BufferGeometry[];

  /**
   * Static batching: all opaque, non-animated meshes of a container are merged per material into one
   * draw call (pieces that are tapped, flash, spin, pulse or are edited stay separate).
   */
  private bake(container: Group) {
    container.updateMatrixWorld(true);
    const inv = container.matrixWorld.clone().invert();
    const buckets = new Map<string, { mat: Material; cast: boolean; recv: boolean; geos: BufferGeometry[]; ids: (string | undefined)[] }>();
    const remove: Mesh[] = [];
    container.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      // inside a kept group?
      for (let p: Object3D | null = m; p && p !== container; p = p.parent) if (p.userData.keep || !p.visible) return;
      if (this.spinning.includes(m)) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((x) => x.transparent || this.pulsing.includes(x as MeshBasicMaterial) || (x as MeshLambertMaterial).map === null && this.isPendingTexture(x))) return;
      let pieceId: string | undefined;
      for (let p: Object3D | null = m; p && p !== container; p = p.parent) if (p.userData.id) pieceId = p.userData.id;
      const rel = inv.clone().multiply(m.matrixWorld);
      const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      src.applyMatrix4(rel);
      const groups = Array.isArray(m.material) && src.groups.length ? src.groups : [{ start: 0, count: src.attributes.position.count, materialIndex: 0 }];
      for (const gr of groups) {
        const mat = mats[gr.materialIndex ?? 0];
        if (!mat) continue;
        const part = subGeometry(src, gr.start, gr.count);
        const key = `${mat.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { mat, cast: m.castShadow, recv: m.receiveShadow, geos: [], ids: [] }));
        b.geos.push(part);
        b.ids.push(pieceId);
      }
      src.dispose();
      remove.push(m);
    });
    if (!remove.length) return;
    for (const m of remove) m.removeFromParent();
    // drop emptied groups
    for (const g of [...container.children]) if (!g.userData.keep && g.children.length === 0) g.removeFromParent();
    const baked = new Group();
    baked.userData.baked = true;
    for (const b of buckets.values()) {
      // vertex ranges → piece ids, so taps on merged geometry still find their piece
      const ranges: { end: number; id?: string }[] = [];
      let n = 0;
      b.geos.forEach((g, i) => {
        n += g.attributes.position.count;
        ranges.push({ end: n, id: b.ids[i] });
      });
      const geo = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!geo) continue;
      (this.bakeInto ?? this.wallGeos).push(geo);
      const mesh = new Mesh(geo, b.mat);
      mesh.userData.ranges = ranges;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      baked.add(mesh);
    }
    container.add(baked);
  }

  /** Top-drawing materials still waiting for their texture are not baked (they change later) */
  private isPendingTexture(m: Material): boolean {
    for (const [k, v] of this.materials) if (v === m && k.startsWith('m|tex|')) return true;
    return false;
  }

  /** One piece as a group (or undefined when it is not shown in this view) */
  private buildPiece(f: FurnitureConfig, o: GlBuild, ctx: { cut: number; supports: FurnitureConfig[]; glassC: Color }): Group | undefined {
    const prev = this.pieceOwn;
    const own = { geos: [] as BufferGeometry[] };
    this.pieceOwn = own;
    try {
      const g = this.buildPieceInner(f, o, ctx);
      if (g) g.userData.own = own;
      else for (const x of own.geos) x.dispose();
      return g;
    } finally {
      this.pieceOwn = prev;
    }
  }

  private buildPieceInner(f: FurnitureConfig, o: GlBuild, ctx: { cut: number; supports: FurnitureConfig[]; glassC: Color }): Group | undefined {
    const { cut, supports, glassC } = ctx;
    const r = resolveFurniture(f);
    const itemCut = cut;
    // mounted above the cut-away walls (TV, wall cabinet, wall light): only shown in the room view
    // (outside the building nothing is cut away: wallbox, garden lights, …)
    const wallMounted = r.elevation > 0 && !r.ceiling;
    const outside = !!o.rooms && !o.rooms.some((rm) => !rm.outdoor && rm.points.length >= 3 && pointInPolygon([f.x, f.y], rm.points));
    if (wallMounted && r.elevation >= itemCut - 0.5 && !outside) return undefined;
    // a dog on its way to the front door may leave its room: always built
    // living dogs are not furniture: they have their own layer (see syncPets)
    if (r.k?.kind === 'dog' && !o.editing) return undefined;
    // editing: the dog as it really looks, resting in its pose (the same model as on the plan)
    if (r.k?.kind === 'dog') return this.buildDogStill(f);
    if (r.role === 'pet' && o.pet?.(f).state?.mode === 'due') return this.buildPet(f, o);
    // room view: pieces of other rooms are not built at all
    if (o.focus && !pointInPolygon([f.x, f.y], o.focus.points)) return undefined;
    if (r.role === 'pet') return this.buildPet(f, o);
    const fxModel = furnitureFx(f, o.getState, o.rooms);
    const model = pieceModel(f, { ghost: r.k?.kind === 'car' && carLive(f, o.getState).away && !o.editing });
    if (model) return this.buildModel(f, o, model, fxModel);
    let base = r.elevation;
    const onTop = !!r.k?.onTop && !base;
    if (onTop) for (const s of supports) if (s !== f && onFootprint([f.x, f.y], s)) base = Math.max(base, Math.min(resolveFurniture(s).height, cut));
    const floating = isFloating(f, cut);
    if (floating) base = floatHeight(cut);
    const isLight = r.role === 'light' && !wallMounted;
    let parts: Part[] = o.stairsDown?.has(f.id)
      ? [{ x: 0, y: 0, z: 0, w: f.w, d: f.h, h: 0.8, color: r.color, topSvg: true }]
      : (furnitureParts(f) ?? [{ x: 0, y: 0, z: 0, w: f.w, d: f.h, h: r.height, color: r.color, radius: 2, topSvg: true }]);
    if (floating) parts = parts.filter((p) => !p.cord);
    if (r.flip && !['sofa', 'desk', 'counter'].includes(r.k?.kind ?? '')) parts = parts.map((p) => ({ ...p, x: -p.x, rot: -(p.rot ?? 0) }));
    const fx = furnitureFx(f, o.getState, o.rooms);
    const hasEmit = parts.some((p) => p.emit);
    const g = new Group();
    g.position.set(f.x, f.y, 0);
    g.rotation.z = (f.rotation ?? 0) * DEG;
    // every piece except flat rugs takes taps (unlinked pieces then do nothing instead of passing the tap to the room)
    // stairs without a device stay in the background too (their chip leads to the other floor)
    const tappable = r.k?.kind !== 'rug' && !(r.k?.kind === 'stairs' && !f.entity && !f.contents?.length);
    g.userData = { id: f.id, linked: !!f.entity, fx, keep: o.editing || !!f.entity || r.role === 'heat', tappable };
    const capped = !onTop && !floating && !r.ceiling && !isLight;
    // merge runs of turned slices (lathe / sphere) into one smooth body
    for (const run of mergeTurned(parts)) {
      if (run.kind === 'lathe') {
        const z0 = base + run.z0;
        let z1 = base + run.z1;
        if (capped && z0 >= itemCut) continue;
        if (capped) z1 = Math.min(z1, itemCut);
        const pts = run.profile.filter((pt) => base + pt[1] <= z1 + 0.01).map(([rr, z]) => new Vector2(Math.max(0.01, rr), base + z));
        if (pts.length < 2) continue;
        const geo = new LatheGeometry(pts, 32).rotateX(Math.PI / 2);
        this.own(geo);
        const mat = this.partMaterial(run.part, fx, hasEmit, glassC);
        const m = new Mesh(geo, mat);
        m.position.set(run.part.x, run.part.y, 0);
        this.addPart(g, m, run.part, fx);
        continue;
      }
      const p = run.part;
      const z0 = base + p.z;
      let z1 = z0 + p.h;
      if (capped) {
        if (z0 >= itemCut) continue;
        z1 = Math.min(z1, itemCut);
      }
      const h = Math.max(0.5, z1 - z0);
      const mat = this.partMaterial(p, fx, hasEmit, glassC);
      let m: Mesh;
      if (p.sphere) {
        m = new Mesh(UNIT_SPHERE, mat);
        m.scale.set(p.w, p.d, h);
        m.position.set(p.x, p.y, z0 + h / 2);
      } else if (p.cyl) {
        m = new Mesh(UNIT_CYL, p.topSvg || p.clear ? [mat, this.topMaterial(f, p, mat, !!p.clear), mat] : mat);
        m.scale.set(p.w, p.d, h);
        m.position.set(p.x, p.y, z0);
      } else if (p.round != null || (p.radius ?? 0) >= 2) {
        const rad = Math.min(p.round ?? p.radius ?? 0, p.w / 2 - 0.01, p.d / 2 - 0.01);
        const geo = roundedBox(p.w, p.d, h, Math.max(0.2, rad));
        this.own(geo);
        m = new Mesh(geo, p.topSvg ? [this.topMaterial(f, p, mat, false), mat] : mat);
        m.position.set(p.x, p.y, z0);
      } else {
        m = new Mesh(UNIT_BOX, p.topSvg ? [mat, mat, mat, mat, this.topMaterial(f, p, mat, false), mat] : mat);
        m.scale.set(p.w, p.d, h);
        m.position.set(p.x, p.y, z0);
      }
      m.rotation.z = (p.rot ?? 0) * DEG;
      this.addPart(g, m, p, fx);
      if (p.clear && fx?.kind === 'fan') this.spinning.push(m);
    }
    // a status that matters (alarm, open lock, charging …): a quiet ring on the surface the piece stands on. A plainly
    // switched-on appliance gets none (its own lights show it), heaters show their rising warmth, lamps their light.
    if (isStatusRing(fx)) {
      const reach = Math.max(f.w, f.h);
      const ring = new Mesh(UNIT_PLANE, this.shimmerMaterial(fx!));
      ring.scale.set(reach + 26, reach + 26, 1);
      ring.position.set(0, 0, base + 0.4);
      ring.raycast = () => {};
      ring.renderOrder = 4;
      g.add(ring);
    }
    // heating: warm streams rising from the heater
    if (fx?.kind === 'heat') {
      const top = base + Math.min(r.height, capped ? Math.max(4, itemCut - base) : r.height);
      this.heatWisps(g, f.w, top, fx);
    }
    // a fridge with a shopping list: the open items engraved into its door (like the values on the walls)
    const list = r.k?.kind === 'fridge' ? fridgeList(f, o.getState) : 0;
    if (list) this.engraveDoor(g, f, String(list), base + Math.min(r.height, capped ? Math.max(4, itemCut - base) : r.height), this.color(paint(r.color)));
    return g;
  }

  /** A value engraved into the front (+y) of a piece, in its upper part (below the cut) */
  private engraveDoor(g: Group, f: FurnitureConfig, text: string, top: number, surface: Color) {
    const w = Math.min(f.w * 0.8, 48);
    const h = w / 2;
    const z = Math.max(h / 2 + 4, top - h / 2 - 10);
    const plane = new Mesh(UNIT_PLANE, new MeshBasicMaterial({ map: this.engrave(text, undefined, surface, 0.72), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    plane.scale.set(w, h, 1);
    // in the piece's own frame: just in front of the door, facing out, text upright
    plane.position.set(0, f.h / 2 + 0.3, z);
    // like a wall label: normal (+z) to the front (+y), up to +z
    plane.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)));
    plane.scale.x *= -1; // the plan is mirrored on y: undo it for the text
    plane.renderOrder = 2;
    plane.raycast = () => {};
    plane.userData.ownTex = true;
    g.add(plane);
  }



  private lastWind = 0;

  /** Wind speed (m/s) from the weather: the air flows a bit faster on windy days */
  setWindSpeed(v: number | undefined) {
    this.windSpeed = v ?? 8;
  }

  private airTex?: CanvasTexture;

  /** Soft dashes along a ribbon (scrolling = flowing air) */
  private airTexture(): CanvasTexture {
    if (this.airTex) return this.airTex;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    for (const [x0, len] of [[10, 70], [120, 45], [190, 40]]) {
      const gr = ctx.createLinearGradient(x0, 0, x0 + len, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.35, 'rgba(255,255,255,1)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(x0, 3, len, 10);
    }
    // soft edges across the ribbon
    const v = ctx.getImageData(0, 0, 256, 16);
    for (let y = 0; y < 16; y++) {
      const k = Math.sin((Math.PI * (y + 0.5)) / 16);
      for (let x = 0; x < 256; x++) v.data[(y * 256 + x) * 4 + 3] *= k;
    }
    ctx.putImageData(v, 0, 0);
    this.airTex = new CanvasTexture(c);
    this.airTex.wrapS = RepeatWrapping;
    return this.airTex;
  }

  /**
   * Air through an open window: a few wavy ribbons at the height of the opening, coming from outside,
   * passing the window and fading out in the room; walls hide them, only the opening lets them through.
   */
  private windFlow(win: OpeningConfig, inward: Point, sill: number, top: number) {
    const len = Math.hypot(win.b[0] - win.a[0], win.b[1] - win.a[1]) || 1;
    const t: Point = [(win.b[0] - win.a[0]) / len, (win.b[1] - win.a[1]) / len];
    const mid: Point = [(win.a[0] + win.b[0]) / 2, (win.a[1] + win.b[1]) / 2];
    const n = Math.max(3, Math.min(6, Math.round(len / 22)));
    const span = top - sill;
    const color = this.color('--fp-air').clone().lerp(new Color(1, 1, 1), 0.35);
    const up = new Vector3(0, 0, 1);
    const tv = new Vector3(t[0], t[1], 0);
    for (let i = 0; i < n; i++) {
      const lane = -len * 0.36 + (len * 0.72 * i) / Math.max(1, n - 1);
      const zc = sill + span * (0.32 + 0.36 * ((i * 0.618) % 1));
      const seg = 28;
      const pos: number[] = [];
      const uv: number[] = [];
      const col: number[] = [];
      const idx: number[] = [];
      const width = Math.max(7, Math.min(11, span * 0.07));
      const wdir = tv.clone().multiplyScalar(0.55).add(up).normalize().multiplyScalar(width / 2);
      for (let k = 0; k <= seg; k++) {
        const sN = k / seg;
        const d = -70 + 250 * sN;
        const wob = Math.sin(sN * Math.PI * 2.3 + i * 1.7) * 5;
        const x = mid[0] + inward[0] * d + t[0] * (lane + wob);
        const y = mid[1] + inward[1] * d + t[1] * (lane + wob);
        const z = zc + Math.sin(sN * Math.PI * 1.6 + i) * span * 0.05;
        pos.push(x - wdir.x, y - wdir.y, z - wdir.z, x + wdir.x, y + wdir.y, z + wdir.z);
        uv.push(sN * 1.4, 0, sN * 1.4, 1);
        // fade in outside, fade out deep in the room
        const a = Math.min(1, sN / 0.2) * Math.min(1, (1 - sN) / 0.35);
        col.push(1, 1, 1, a, 1, 1, 1, a);
        if (k < seg) {
          const b = k * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
      geo.setAttribute('color', new Float32BufferAttribute(col, 4));
      geo.setIndex(idx);
      const tex = this.airTexture().clone();
      tex.needsUpdate = true;
      tex.offset.x = (i * 0.37) % 1;
      const mat = new MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 1, depthWrite: false, side: DoubleSide, vertexColors: true });
      const m = new Mesh(geo, mat);
      m.raycast = () => {};
      m.renderOrder = 4;
      this.windGroup.add(m);
      this.windTex.push({ tex, speed: 0.55 + ((i * 0.29) % 1) * 0.3 });
    }
    this.requestRender();
  }


  // ---------- values engraved into the walls ----------

  /**
   * Label style "wall": each room's temperature (and name) appears engraved into the inner face of a free wall
   * that faces the viewer. Returns the rooms that got a wall (the others keep their floating label).
   */
  setWallLabels(floor: FloorConfig, o: GlBuild, items: { room: RoomConfig; value: string; sub?: string }[]): Set<string> {
    const placed = new Set<string>();
    const bucket = labelBucket(o.spin);
    const sig = JSON.stringify([items.map((i) => [i.room.id, i.value, i.sub, i.room.label_spots?.[bucket] ?? '']), round1(o.spin), o.height, o.focus?.id ?? '', this.color('--fp-wall-side').getHexString(), o.wall]);
    const current = () => {
      for (const c of this.wallLabelGroup.children) placed.add(c.userData.room);
      return placed;
    };
    if (sig === this.wallLabelSig) return current();
    // the spots are checked against the final view (nothing may stand in front of them): wait until the
    // camera rests
    clearTimeout(this.wallLabelTimer);
    const camSettled = !this.view || (Math.abs(((((this.view.spin - o.spin) % 360) + 540) % 360) - 180) < 0.5 && this.view.walls > 0.99);
    if (isActive() || !camSettled) {
      this.wallLabelTimer = window.setTimeout(() => this.setWallLabels(floor, o, items), 260);
      if (!items.length) this.clearWallLabels();
      return current();
    }
    this.wallLabelSig = sig;
    this.clearWallLabels();
    if (!items.length) return placed;
    this.root.updateMatrixWorld(true);
    const sp = o.spin * DEG;
    const facing = (n: Point) => n[0] * Math.sin(sp) + n[1] * Math.cos(sp);
    const pieces = wallPieces(floor);
    const H = o.height;
    const wallC = this.color('--fp-wall-side');
    const blockers = (floor.furniture ?? []).filter((f) => {
      const fr = resolveFurniture(f);
      return fr.k?.kind !== 'rug' && !fr.ceiling && fr.height + fr.elevation > 22;
    });
    /** a wall spot: centre on the wall line, inward normal, label width, height above the floor */
    const wallSpot = (c: Point, n: Point, dir: Point, w: number): { top: number; blocked: number } => {
      let blocked = 0;
      let top = 0;
      for (const fb of blockers) {
        const dx = fb.x - c[0];
        const dy = fb.y - c[1];
        const along = dx * dir[0] + dy * dir[1];
        const away = dx * n[0] + dy * n[1];
        const rad = Math.max(fb.w, fb.h) / 2;
        if (away > -10 && away < rad + 45 && Math.abs(along) < w / 2 + rad) {
          blocked++;
          const fr = resolveFurniture(fb);
          top = Math.max(top, Math.min(H, fr.elevation + fr.height));
        }
      }
      return { top, blocked };
    };
    const wallPlane = (it: (typeof items)[number], c: Point, n: Point, w0: number, top: number) => {
      const free = H - top;
      const h = Math.max(12, Math.min(w0 * 0.5, H * 0.5, top ? free - 8 : Infinity));
      const w = Math.min(w0, h * 2);
      const off = o.wall / 2 + 0.6;
      const z = top && free >= 30 ? top + 4 + h / 2 : Math.max(h / 2 + 4, H * 0.56);
      return { pos: new Vector3(c[0] + n[0] * off, c[1] + n[1] * off, Math.min(H - h / 2 - 2, z)), n, w, h, it };
    };
    for (const it of items) {
      if (o.focus && o.focus.id !== it.room.id) continue;
      const fixed = it.room.label_spots?.[bucket];
      if (fixed === 'hide') continue;
      // the admin chose a wall for this view direction
      if (fixed && fixed !== 'floor') {
        const pts = it.room.points;
        const a = pts[fixed.wall % pts.length];
        const b = pts[(fixed.wall + 1) % pts.length];
        const len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
        if (len > 20) {
          const dir: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
          // inward normal: the side the room lies on
          let n: Point = [-dir[1], dir[0]];
          const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (!pointInPolygon([mid[0] + n[0] * 8, mid[1] + n[1] * 8], pts)) n = [-n[0], -n[1]];
          const w0 = Math.min(len * 0.6, 72);
          const t = Math.max(w0 / 2 + 4, Math.min(len - w0 / 2 - 4, (fixed.t ?? 0.5) * len));
          const c: Point = [a[0] + dir[0] * t, a[1] + dir[1] * t];
          const { top } = wallSpot(c, n, dir, w0);
          this.addWallLabel(wallPlane(it, c, n, w0, H - top >= 30 ? top : 0), wallC);
          placed.add(it.room.id);
          continue;
        }
      }
      // automatic: the inner faces of this room's plain walls that look towards the viewer, along them the
      // spots with nothing tall in front (TV, lamps, shelves) — best first; the first one that is really
      // visible from the camera wins (walls and furniture may hide it in this view)
      const cands: { score: number; plane: ReturnType<typeof wallPlane> }[] = [];
      if (fixed !== 'floor')
        for (const p of pieces) {
          if (p.kind !== 'wall' || (p.front !== it.room && p.back !== it.room)) continue;
          const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
          if (len < 60) continue;
          const dir: Point = [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len];
          const sn: Point = [-dir[1], dir[0]];
          const n: Point = p.front === it.room ? sn : [-sn[0], -sn[1]];
          const f = facing(n);
          if (f < 0.35) continue;
          const w = Math.min(len * 0.6, 72);
          for (let t = w / 2 + 8; t <= len - w / 2 - 8 + 0.01; t += Math.max(10, (len - w - 16) / 8 || 10)) {
            const c: Point = [p.a[0] + dir[0] * t, p.a[1] + dir[1] * t];
            const { top, blocked } = wallSpot(c, n, dir, w);
            const above = H - top;
            if (blocked && above < 30) continue;
            cands.push({ score: f * 100 - blocked * 15 - Math.abs(t - len / 2) * 0.05, plane: wallPlane(it, c, n, w, blocked ? top : 0) });
          }
        }
      cands.sort((x, y) => y.score - x.score);
      const pick = cands.slice(0, 10).find((c) => this.spotVisible(c.plane.pos, c.plane.n, c.plane.w, c.plane.h));
      if (pick) {
        this.addWallLabel(pick.plane, wallC);
        placed.add(it.room.id);
        continue;
      }
      // no visible wall: engraved into the floor, at the most open spot the camera can see
      const spots = this.floorSpots(floor, it.room);
      const fw0 = (r: number) => Math.min(76, r * 1.5);
      const spot = spots.slice(0, 14).find((s) => this.spotVisible(new Vector3(s.c[0], s.c[1], 1.6), undefined, fw0(s.r), fw0(s.r) * 0.5)) ?? spots[0];
      if (!spot) continue;
      const fw = fw0(spot.r);
      // ink from the real floor (wood, tiles …), so the text reads on it
      const fm = it.room.floor;
      const ground = fm && fm.type !== 'none' ? this.color(fm.color ?? FLOOR_TYPE.get(fm.type)?.color ?? '#cccccc') : this.color('--fp-room');
      const tex = this.engrave(it.value, it.sub, ground, 0.62);
      const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95, side: DoubleSide });
      const plane = new Mesh(new PlaneGeometry(1, 1), mat);
      plane.scale.set(-fw, fw * 0.5, 1); // mirrored plan: undo it for the text
      plane.position.set(spot.c[0], spot.c[1], 1.6); // above rugs
      // readable from the viewer: the text's top points away from the camera
      plane.rotation.z = Math.PI - sp;
      plane.renderOrder = 1;
      plane.userData.room = it.room.id;
      this.wallLabelGroup.add(plane);
      placed.add(it.room.id);
    }
    this.requestRender();
    return placed;
  }
  private wallLabelTimer?: number;

  private clearWallLabels() {
    for (const c of [...this.wallLabelGroup.children]) {
      const m = c as Mesh;
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).map?.dispose();
      (m.material as Material).dispose();
      c.removeFromParent();
    }
  }

  private addWallLabel(pl: { pos: Vector3; n: Point; w: number; h: number; it: { room: RoomConfig; value: string; sub?: string } }, wallC: Color) {
    const tex = this.engrave(pl.it.value, pl.it.sub, wallC);
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: DoubleSide });
    const plane = new Mesh(new PlaneGeometry(1, 1), mat);
    plane.scale.set(pl.w, pl.h, 1);
    plane.position.copy(pl.pos);
    // face the room: the plane's normal (+z) turned to the inward normal, its up to +z
    plane.up.set(0, 0, 1);
    plane.lookAt(new Vector3(pl.pos.x + pl.n[0], pl.pos.y + pl.n[1], pl.pos.z));
    plane.scale.x *= -1; // the plan is mirrored on y: undo it for the text
    plane.renderOrder = 2;
    plane.userData.room = pl.it.room.id;
    this.wallLabelGroup.add(plane);
  }

  /** Whether a label (centre in plan coordinates, on a wall with normal n or on the floor) can be seen: rays
   * from the camera to its centre and both ends must not hit an opaque wall or piece first */
  private spotVisible(c: Vector3, n: Point | undefined, w: number, h: number): boolean {
    if (!this.view) return true;
    const along = n ? new Vector3(-n[1], n[0], 0) : new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 0, 1), 0);
    const pts = [c, c.clone().addScaledVector(along, w * 0.4), c.clone().addScaledVector(along, -w * 0.4), c.clone().add(new Vector3(0, 0, n ? h * 0.3 : 0))];
    const targets = [this.walls, this.furniture];
    let seen = 0;
    for (const p of pts) {
      const wp = this.wallLabelGroup.localToWorld(p.clone());
      const ndc = wp.clone().project(this.camera);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      const x = ((ndc.x + 1) / 2) * this.view.width;
      const y = ((1 - ndc.y) / 2) * this.view.height;
      this.raycaster.ray.copy(this.rayAt(x, y));
      const d = this.raycaster.ray.origin.distanceTo(wp);
      const hit = this.raycaster
        .intersectObjects(targets, true)
        .find((hh) => !(hh.object as Sprite).isSprite && visibleChain(hh.object) && !(((hh.object as Mesh).material as Material).transparent && (((hh.object as Mesh).material as MeshBasicMaterial).opacity ?? 1) < 0.6));
      if (!hit || hit.distance > d - 3) seen++;
    }
    return seen >= 3;
  }

  /** Room whose engraved value is under a viewport point (in front of everything else) */
  pickLabel(x: number, y: number): string | undefined {
    if (!this.view || !this.wallLabelGroup.children.length) return undefined;
    this.raycaster.camera = this.camera;
    this.raycaster.ray.copy(this.rayAt(x, y));
    // the engraving counts unless an opaque wall or a piece stands clearly in front of it
    const label = this.raycaster.intersectObjects(this.wallLabelGroup.children, false)[0];
    if (!label) return undefined;
    const block = this.raycaster
      .intersectObjects([this.walls, this.furniture, this.petGroup], true)
      .find((h) => !(h.object as Sprite).isSprite && visibleChain(h.object) && !((h.object as Mesh).material as Material).transparent);
    return !block || block.distance > label.distance - 3 ? label.object.userData.room : undefined;
  }

  /** Open floor spots of a room (far from walls and furniture), most open first, for an engraved value */
  private floorSpots(floor: FloorConfig, room: RoomConfig): { c: Point; r: number }[] {
    const xs = room.points.map((p) => p[0]);
    const ys = room.points.map((p) => p[1]);
    const solid = (floor.furniture ?? []).filter((f) => resolveFurniture(f).k?.kind !== 'rug' && !resolveFurniture(f).ceiling && pointInPolygon([f.x, f.y], room.points));
    const out: { c: Point; r: number }[] = [];
    const step = 20;
    for (let x = Math.min(...xs) + 30; x <= Math.max(...xs) - 30; x += step)
      for (let y = Math.min(...ys) + 30; y <= Math.max(...ys) - 30; y += step) {
        const c: Point = [x, y];
        if (!pointInPolygon(c, room.points)) continue;
        let r = Infinity;
        for (let i = 0; i < room.points.length; i++) r = Math.min(r, closestPointOnSegment(c, room.points[i], room.points[(i + 1) % room.points.length]).dist);
        for (const f of solid) r = Math.min(r, Math.max(0, Math.hypot(f.x - x, f.y - y) - Math.max(f.w, f.h) / 2));
        if (r >= 25) out.push({ c, r });
      }
    return out.sort((a, b) => b.r - a.r);
  }

  /** Text pressed into the wall: a shade of the wall colour with a light lower and a dark upper edge */
  private engrave(value: string, sub: string | undefined, wall: Color, depth = 0.8): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const lum = wall.r * 0.2126 + wall.g * 0.7152 + wall.b * 0.0722;
    const ink = wall.clone().multiplyScalar(lum > 0.5 ? depth : 2.1 - depth);
    const css = (col: Color, a = 1) => `rgba(${Math.round(Math.min(1, col.r) * 255)}, ${Math.round(Math.min(1, col.g) * 255)}, ${Math.round(Math.min(1, col.b) * 255)}, ${a})`;
    const font = 'Roboto, "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const draw = (text: string, y: number, size: number, weight: number) => {
      ctx.font = `${weight} ${size}px ${font}`;
      // engraved: light edge below, dark edge above, the recessed face in between
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(text, 256, y + size * 0.035);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillText(text, 256, y - size * 0.03);
      ctx.fillStyle = css(ink);
      ctx.fillText(text, 256, y);
    };
    if (sub) draw(sub, 58, 46, 600);
    draw(value, sub ? 160 : 128, 138, 500);
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // ---------- garden, energy, vehicles ----------

  /** Soft round sprite texture (shared) */
  private dot(): Texture {
    if (!this.halo) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)');
      gr.addColorStop(0.35, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, 64, 64);
      this.halo = new CanvasTexture(c);
    }
    return this.halo;
  }

  private sprite(color: string | Color, size: number, opacity = 0.8): Sprite {
    const m = new SpriteMaterial({ map: this.dot(), color: color instanceof Color ? color : this.color(color), transparent: true, opacity, blending: AdditiveBlending, depthWrite: false });
    const sp = new Sprite(m);
    sp.scale.set(size, size, 1);
    sp.raycast = () => {};
    sp.renderOrder = 5;
    return sp;
  }

  /** Materials of named meshes become the piece's own (they are animated) */
  private ownMaterials(g: Object3D, name: string | RegExp): Mesh[] {
    const out: Mesh[] = [];
    g.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !(typeof name === 'string' ? m.name === name : name.test(m.name))) return;
      m.material = (m.material as Material).clone();
      out.push(m);
    });
    return out;
  }

  private buildModel(f: FurnitureConfig, o: GlBuild, model: ModelNode, fx: FurnitureFx | undefined): Group {
    const r = resolveFurniture(f);
    const kind = r.k?.kind ?? '';
    const get = (id?: string) => (id ? o.getState(id) : undefined);
    const main = get(f.entity);
    const active = !f.entity || isOn(main);
    const glow = kind === 'garden_light' ? fx?.kind === 'light' : kind === 'firepit' ? active : kind !== 'car';
    const g = new Group();
    g.position.set(f.x, f.y, 0);
    g.rotation.z = (f.rotation ?? 0) * DEG;
    const animated = ['lawn_mower', 'sprinkler', 'irrigation_zone', 'solar_panels', 'home_battery', 'wallbox', 'heat_pump', 'firepit', 'car', 'gate', 'garage_door', 'washer', 'dryer', 'dishwasher'].includes(kind);
    g.userData = { id: f.id, linked: !!f.entity, fx, keep: o.editing || !!f.entity || animated, tappable: true };
    const matFn = (key: string, make: () => Material) => {
      let mm = this.materials.get(key);
      if (!mm) this.materials.set(key, (mm = make()));
      return mm;
    };
    let body: Group;
    if (kind === 'car') {
      const shape = CARS[r.variant] ?? CARS.compact;
      const ghost = carLive(f, o.getState).away && !o.editing;
      const cm = carModelFor(shape);
      const own = buildCarMesh;
      const cmats = { mat: matFn, own: (geo: BufferGeometry) => this.own(geo) };
      // open tailgate, frunk, sunroof, doors, windows (not on a car that is away)
      const open = !ghost && !o.editing ? o.carOpen?.(f) : undefined;
      const parts = open ? carOpenParts(f.w, f.h, r.height, r.color, open, cmats) : undefined;
      if (cm) {
        // a clean CC0 model (loaded once); the card's own model while it cannot be loaded — retried later, so a
        // tablet that woke up without network does not keep the simpler car
        body = new Group();
        const b = body;
        const show = (src: Object3D | undefined) => {
          b.clear();
          b.add(src ? carFromModel(src, f.w, f.h, r.height, r.color, ghost, matFn) : own(shape, f.w, f.h, r.height, r.color, f.accent ? r.accent : undefined, ghost, cmats));
          if (parts) b.add(parts);
          this.renderer.shadowMap.needsUpdate = true;
          this.requestRender();
        };
        void loadCar(cm).then((src) => {
          show(src);
          if (!src) void retryCar(cm).then((again) => again && b.parent && show(again));
        });
      } else {
        body = own(shape, f.w, f.h, r.height, r.color, f.accent ? r.accent : undefined, ghost, cmats);
        if (parts) body.add(parts);
      }
    } else body = this.buildNode(model, glow);
    body.position.z = r.elevation;
    g.add(body);
    if (o.editing) return g;
    const named = (n: string) => body.getObjectByName(n);
    switch (kind) {
      case 'garden_light':
        if (fx?.kind === 'light') body.traverse((m) => {
          const mesh = m as Mesh;
          if (!mesh.isMesh || !((mesh.material as MeshBasicMaterial).isMeshBasicMaterial)) return;
          mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox!;
          const c = bb.getCenter(new Vector3()).multiply(mesh.scale).add(mesh.position).add(body.position);
          const sp = this.sprite(fx.color, Math.max(30, bb.getSize(new Vector3()).x * mesh.scale.x * 5), 0.55);
          sp.position.copy(c);
          g.add(sp);
        });
        break;
      case 'firepit': {
        const flame = named('flame');
        if (!flame) break;
        flame.visible = active;
        if (!active) break;
        const sp = this.sprite('#ff8a3a', f.w * 1.6, 0.5);
        sp.position.set(0, 0, r.height + 14);
        g.add(sp);
        g.userData.anim = (now: number) => {
          flame.scale.set(1 + Math.sin(now / 70) * 0.06, 1 + Math.sin(now / 83) * 0.06, 1 + Math.sin(now / 90) * 0.16 + Math.sin(now / 37) * 0.08);
          (sp.material as SpriteMaterial).opacity = 0.42 + Math.sin(now / 110) * 0.08;
          return 50;
        };
        break;
      }
      case 'washer':
      case 'dryer':
      case 'dishwasher': {
        // running: the display lights and the drum turns slowly; done: a green display and a quiet ring until seen
        if (!fx) break;
        for (const m of this.ownMaterials(body, 'display')) {
          const mat = m.material as MeshLambertMaterial;
          mat.color.set(fx.color);
          mat.emissive?.set(fx.color).multiplyScalar(fx.level >= 1 ? 0.75 : 0.4);
        }
        if (isStatusRing(fx)) {
          const reach = Math.max(f.w, f.h);
          const ring = new Mesh(UNIT_PLANE, this.shimmerMaterial(fx));
          ring.scale.set(reach + 26, reach + 26, 1);
          ring.position.set(0, 0, r.elevation + 0.4);
          ring.raycast = () => {};
          ring.renderOrder = 4;
          g.add(ring);
        }
        const drum = named('drum');
        if (!drum || isStatusRing(fx) || fx.level < 1) break;
        let last = this.animNow();
        g.userData.anim = (now: number) => {
          drum.rotation.z += ((now - last) / 1000) * 1.4;
          last = now;
          return 50;
        };
        break;
      }
      case 'heat_pump': {
        const fan = named('fan');
        if (!fan || !isOn(main)) break;
        let last = this.animNow();
        g.userData.anim = (now: number) => {
          fan.rotation.z += ((now - last) / 1000) * 9;
          last = now;
          return 33;
        };
        break;
      }
      case 'wallbox': {
        const ring = this.ownMaterials(body, 'ring')[0];
        if (!ring) break;
        const st = (main?.state ?? '').toLowerCase();
        const charging = /charg|lad/.test(st) && !/not|nicht|complete|beendet/.test(st) ? true : main ? isOn(main) && !/connected|plugged|verbunden/.test(st) : false;
        const connected = /connected|plugged|verbunden|ready|bereit/.test(st);
        const error = /error|fault|fehler/.test(st);
        const col = new Color(error ? '#ff4a3a' : charging ? '#3ee07a' : connected ? '#5aa8ff' : '#e8eef4');
        const mat = ring.material as MeshBasicMaterial;
        mat.color.copy(col);
        if (!charging && !error) {
          mat.color.multiplyScalar(connected ? 1 : 0.6);
          break;
        }
        const sp = this.sprite(col, 40, 0.4);
        sp.position.copy(ring.position).add(body.position);
        g.add(sp);
        g.userData.anim = (now: number) => {
          const k = error ? (Math.sin(now / 160) > 0 ? 1 : 0.2) : 0.55 + 0.45 * Math.sin(now / 420);
          mat.color.copy(col).multiplyScalar(0.5 + 0.5 * k);
          (sp.material as SpriteMaterial).opacity = 0.15 + 0.35 * k;
          return 50;
        };
        break;
      }
      case 'solar_panels': {
        const panels = this.ownMaterials(body, 'panel');
        if (!panels.length || (numOf(main) ?? 0) <= 5) break;
        const n = Math.max(1, r.count);
        const tint = new Color(0.55, 0.72, 1);
        g.userData.anim = (now: number) => {
          const kw = (numOf(get(f.entity)) ?? 0) / 1000;
          const k = Math.min(1, kw / Math.max(0.3, n * 0.35));
          const sweep = ((now / 2600) % 1.6) - 0.3;
          panels.forEach((m, i) => {
            const d = Math.abs(sweep - i / panels.length);
            const glint = Math.max(0, 1 - d * 5);
            (m.material as MeshLambertMaterial).emissive.copy(tint).multiplyScalar(0.06 + 0.12 * k + glint * (0.25 + 0.45 * k));
          });
          return 50;
        };
        break;
      }
      case 'home_battery': {
        const segs = [0, 1, 2, 3, 4].map((i) => this.ownMaterials(body, `seg${i}`)[0]).filter(Boolean) as Mesh[];
        const paint = (now: number) => {
          const soc = numOf(get(f.entity)) ?? 0;
          const pw = (numOf(get(f.entities?.power)) ?? 0) * (f.invert_power ? -1 : 1);
          const lit = Math.max(soc > 0 ? 1 : 0, Math.ceil(soc / 20));
          const col = new Color(soc <= 15 ? '#ff4a3a' : soc <= 35 ? '#ffb02e' : '#3ee07a');
          const flow = pw > 20 ? 1 : pw < -20 ? -1 : 0;
          const head = flow ? ((now / 260) % (lit + 1)) : -1;
          segs.forEach((m, i) => {
            const mat = m.material as MeshLambertMaterial;
            if (i >= lit) {
              mat.color.set('#5a5f66');
              mat.emissive.setRGB(0, 0, 0);
              return;
            }
            const pos = flow > 0 ? i : lit - 1 - i;
            const boost = flow && Math.abs(pos - head) < 0.8 ? 1 : 0;
            mat.color.copy(col);
            mat.emissive.copy(col).multiplyScalar(0.55 + boost * 0.45);
          });
          return flow ? 60 : false;
        };
        paint(this.animNow());
        g.userData.anim = (now: number) => paint(now);
        break;
      }
      case 'sprinkler': {
        if (!isOn(main)) break;
        const nozzle = named('nozzle');
        const drops: Sprite[] = [];
        const N = 26;
        for (let i = 0; i < N; i++) {
          const sp = this.sprite('#bfe6ff', 7 + (i % 3) * 2, 0.7);
          g.add(sp);
          drops.push(sp);
        }
        const oscill = r.variant === 'oscillating';
        const R = oscill ? 260 : 320;
        const top = r.height + 4;
        g.userData.anim = (now: number) => {
          if (oscill) {
            const phi = Math.sin(now / 1400) * 0.9;
            if (nozzle) nozzle.rotation.x = phi;
            drops.forEach((sp, i) => {
              const col = (i % 5) / 4 - 0.5;
              const s2 = ((i / N) * 5 + now / 900) % 1;
              sp.position.set(col * f.w * 0.8, Math.sin(phi) * R * s2, top + 4 * 70 * s2 * (1 - s2) * Math.cos(phi * 0.6));
              (sp.material as SpriteMaterial).opacity = 0.75 * (1 - s2 * 0.6);
            });
          } else {
            const ang = now / 700;
            drops.forEach((sp, i) => {
              const s2 = ((i / N) * 3 + now / 1100) % 1;
              const a = ang - s2 * 0.5 + Math.floor((i / N) * 3) * ((Math.PI * 2) / 3);
              sp.position.set(Math.cos(a) * R * s2, Math.sin(a) * R * s2, top + 4 * 60 * s2 * (1 - s2));
              (sp.material as SpriteMaterial).opacity = 0.75 * (1 - s2 * 0.5);
            });
          }
          return 33;
        };
        break;
      }
      case 'lawn_mower': {
        const st = (main?.state ?? 'docked').toLowerCase();
        const led = this.ownMaterials(body, 'led')[0];
        const ledMat = led?.material as MeshBasicMaterial | undefined;
        if (st === 'error') {
          ledMat?.color.set('#ff4a3a');
          g.userData.anim = (now: number) => {
            if (ledMat) ledMat.color.set(Math.sin(now / 200) > 0 ? '#ff4a3a' : '#3a1010');
            return 100;
          };
          break;
        }
        if (st !== 'mowing' && st !== 'returning') break;
        ledMat?.color.set(st === 'mowing' ? '#3ee07a' : '#5aa8ff');
        // lanes over the lawn the dock sits on
        // (the smallest area around it: the lawn, not the whole plot)
        const area = (o.rooms ?? [])
          .filter((rm) => rm.points.length >= 3 && pointInPolygon([f.x, f.y], rm.points))
          .sort((a, b) => Number(a.kind === 'plot') - Number(b.kind === 'plot') || Math.abs(polygonArea(a.points)) - Math.abs(polygonArea(b.points)))[0];
        const lanes = mowLanes(area?.points ?? circle([f.x, f.y], 250), 42);
        const path = [new Vector2(f.x, f.y), ...lanes.map(([x, y]) => new Vector2(x, y))];
        if (st === 'returning') path.reverse();
        const segL: number[] = [];
        let total = 0;
        for (let i = 1; i < path.length; i++) {
          const dd = path[i].distanceTo(path[i - 1]);
          segL.push(dd);
          total += dd;
        }
        if (total < 1) break;
        const t0 = this.animNow();
        let heading = g.rotation.z;
        g.userData.anim = (now: number) => {
          let dist = st === 'mowing' ? ((now / 1000) * 48) % total : Math.min(total, ((now - t0) / 1000) * 48);
          let i = 0;
          while (i < segL.length - 1 && dist > segL[i]) dist -= segL[i++];
          const a = path[i];
          const b = path[i + 1] ?? a;
          const k = segL[i] ? Math.min(1, dist / segL[i]) : 1;
          g.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 0);
          const target = Math.atan2(b.y - a.y, b.x - a.x);
          let dh = target - heading;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          heading += dh * 0.18;
          g.rotation.z = heading;
          return 33;
        };
        break;
      }
      case 'car':
        this.carFx(f, o, g, body);
        break;
      case 'gate':
      case 'garage_door': {
        // runs from where it was drawn last to the new state
        const leaf0 = named('leaf0');
        const leaf1 = named('leaf1');
        const panel = named('panel');
        const x0 = leaf0?.position.x ?? 0;
        const apply = (k: number) => {
          this.garagePos.set(f.id, k);
          if (panel) {
            panel.scale.z = Math.max(0.03, 1 - k);
            panel.position.z = k * r.height;
          } else if (r.variant === 'sliding' && leaf0) leaf0.position.x = x0 + k * f.w;
          else {
            if (leaf0) leaf0.rotation.z = k * GATE_SWING_DEG * DEG;
            if (leaf1) leaf1.rotation.z = -k * GATE_SWING_DEG * DEG;
          }
        };
        const live = coverLive(main);
        const to = live.open;
        const from = this.garagePos.get(f.id) ?? to;
        apply(from);
        if (Math.abs(to - from) < 0.005) break;
        const dur = live.moving ? 12000 * Math.abs(to - from) : 500 + 1500 * Math.abs(to - from);
        // the real door keeps moving under a popup: real time, not the animation clock
        const t0 = performance.now();
        g.userData.anim = () => {
          const k = Math.min(1, (performance.now() - t0) / dur);
          const e = live.moving ? k : k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          apply(from + (to - from) * e);
          return k < 1;
        };
        break;
      }
      case 'irrigation_zone':
        if (isOn(main) || main?.state === 'open' || main?.state === 'opening') this.sprayFx(g, f, r.height);
        break;
    }
    return g;
  }

  /** Water spraying over an irrigation zone: a few droplet sprites turning around the nozzle (cheap: ~20 sprites) */
  private sprayFx(g: Group, f: FurnitureConfig, H: number) {
    const drops: Sprite[] = [];
    const N = 20;
    for (let i = 0; i < N; i++) {
      const sp = this.sprite('#bfe6ff', 8 + (i % 3) * 2, 0.7);
      g.add(sp);
      drops.push(sp);
    }
    const rx = f.w / 2;
    const ry = f.h / 2;
    const top = Math.max(14, H);
    // the wetted area, faintly
    const wet = new Mesh(resolveFurniture(f).variant === 'round' ? UNIT_DISC : UNIT_PLANE, new MeshBasicMaterial({ color: '#5aa8ff', transparent: true, opacity: 0.14, depthWrite: false }));
    wet.scale.set(f.w, f.h, 1);
    wet.position.z = 0.6;
    wet.renderOrder = 1;
    wet.raycast = () => {};
    g.add(wet);
    g.userData.anim = (now: number) => {
      const ang = now / 900;
      drops.forEach((sp, i) => {
        const s2 = ((i / N) * 4 + now / 1300) % 1;
        const a = ang - s2 * 0.4 + Math.floor((i / N) * 4) * (Math.PI / 2);
        sp.position.set(Math.cos(a) * rx * s2, Math.sin(a) * ry * s2, top + 4 * 50 * s2 * (1 - s2));
        (sp.material as SpriteMaterial).opacity = 0.75 * (1 - s2 * 0.5);
      });
      return 33;
    };
  }

  /** Car: charging cable with flowing light from the wallbox, or a red glow when the battery is empty */
  private carFx(f: FurnitureConfig, o: GlBuild, g: Group, body: Group) {
    const r = resolveFurniture(f);
    const live = carLive(f, o.getState);
    if (live.away) return;
    const H = r.height;
    const port = new Vector3(...chargePort(f.w, f.h, H));
    if (live.charging) {
      const rot = (f.rotation ?? 0) * DEG;
      // nearest wallbox within 9 m
      const wb = (o.all ?? [])
        .filter((x) => resolveFurniture(x).k?.kind === 'wallbox')
        .map((x) => ({ x, d: Math.hypot(x.x - f.x, x.y - f.y) }))
        .sort((a, b) => a.d - b.d)[0];
      const glowC = new Color('#3ee07a');
      const portGlow = this.sprite(glowC, 34, 0.6);
      portGlow.position.copy(port);
      g.add(portGlow);
      const pulses: Sprite[] = [];
      let curve: CatmullRomCurve3 | undefined;
      if (wb && wb.d < 900) {
        const wr = resolveFurniture(wb.x);
        const wrot = (wb.x.rotation ?? 0) * DEG;
        // the cable leaves the wallbox below its front, sags to the ground and plugs into the car
        const plugW = new Vector3(wb.x.x - Math.sin(wrot) * (wb.x.h / 2 + 5), wb.x.y + Math.cos(wrot) * (wb.x.h / 2 + 5), Math.max(40, wr.elevation - 10));
        const toLocal = (p: Vector3) => {
          const dx = p.x - f.x;
          const dy = p.y - f.y;
          return new Vector3(dx * Math.cos(-rot) - dy * Math.sin(-rot), dx * Math.sin(-rot) + dy * Math.cos(-rot), p.z);
        };
        const a = toLocal(plugW);
        const mid = a.clone().lerp(port, 0.5);
        mid.z = 3;
        const nearPort = port.clone().add(new Vector3(-6, -14, -port.z + 8));
        curve = new CatmullRomCurve3([a, a.clone().setZ(a.z * 0.5), mid, nearPort, port]);
        const tube = new Mesh(new TubeGeometry(curve, 40, 1.3, 6, false), this.lambert(this.color('#2a2a2c')));
        this.own(tube.geometry);
        tube.castShadow = true;
        g.add(tube);
        for (let i = 0; i < 5; i++) {
          const sp = this.sprite(glowC, 14, 0.85);
          g.add(sp);
          pulses.push(sp);
        }
      }
      g.userData.anim = (now: number) => {
        (portGlow.material as SpriteMaterial).opacity = 0.35 + 0.3 * Math.sin(now / 380);
        if (curve) pulses.forEach((sp, i) => {
          const t = (now / 1500 + i / pulses.length) % 1;
          sp.position.copy(curve!.getPoint(t));
          (sp.material as SpriteMaterial).opacity = 0.9 * Math.sin(Math.PI * t);
        });
        return 33;
      };
      return;
    }
    if (live.low) {
      const ring = new Mesh(UNIT_PLANE, new MeshBasicMaterial({ map: this.dot(), color: this.color('#ff3b30'), transparent: true, opacity: 0.5, depthWrite: false, blending: AdditiveBlending }));
      ring.scale.set(f.w * 1.25, f.h * 1.6, 1);
      ring.position.set(0, 0, 0.6);
      ring.raycast = () => {};
      ring.renderOrder = 4;
      g.add(ring);
      g.userData.anim = (now: number) => {
        (ring.material as MeshBasicMaterial).opacity = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(now / 520));
        return 60;
      };
    }
    void body;
  }


  // ---------- animated dogs (skeleton models) ----------

  /** Keep the dog layer in step with the plan: (re)build a dog only when its state changed */
  syncPets(floor: FloorConfig, o: GlBuild, sig: Map<string, string>) {
    const dogs = o.editing ? [] : (floor.furniture ?? []).filter((f) => resolveFurniture(f).k?.kind === 'dog');
    const ids = new Set(dogs.map((f) => f.id));
    for (const g of [...this.petGroup.children]) {
      if (ids.has(g.userData.id) || g.userData.vacuum) continue;
      g.removeFromParent();
      this.dogs.get(g.userData.id)?.actor?.dispose();
      this.dogs.delete(g.userData.id);
      this.petSig.delete(g.userData.id);
    }
    for (const f of dogs) {
      const key = `${sig.get(f.id) ?? ''}|${f.x},${f.y},${f.w},${f.variant},${f.color},${f.accent},${o.focus?.id ?? ''}|${dogLookKey(petLook(f))}`;
      if (this.petSig.get(f.id) === key && this.petGroup.children.some((c) => c.userData.id === f.id)) continue;
      this.petSig.set(f.id, key);
      for (const old of this.petGroup.children.filter((c) => c.userData.id === f.id)) old.removeFromParent();
      const g = this.buildDog(f, o);
      if (g) this.petGroup.add(g);
    }
    this.requestRender();
  }

  /** Per dog: where it is and what it does — kept across rebuilds */
  private dogs = new Map<string, DogLife>();

  // ---------- robot vacuums driving live (positions from the companion integration) ----------

  private vacs = new Map<string, { key: string; live: LiveVacuum; tf: VacuumTransform; group: Group; learned?: LearnedFloor; nav?: NavGrid; floor: FloorConfig; o: GlBuild; f: FurnitureConfig; trail: VacTrail }>();

  /** Vacuums with an aligned map drive on the pets' layer; their piece in the furniture stays hidden */
  syncVacuums(floor: FloorConfig, o: GlBuild, on: boolean) {
    const live = on && !o.editing ? (floor.furniture ?? []).filter((f) => f.kind === 'robot_vacuum' && f.entity?.startsWith('vacuum.') && f.vacuum?.transform) : [];
    const ids = new Set(live.map((f) => f.id));
    for (const [id, v] of this.vacs)
      if (!ids.has(id)) {
        v.group.removeFromParent();
        this.release(v.group);
        this.dropTrail(v.trail);
        this.vacs.delete(id);
      }
    for (const f of live) {
      const tf = f.vacuum!.transform!;
      const mode = f.vacuum?.mode ?? 'delayed';
      const key = JSON.stringify([f.w, f.h, f.color, f.accent, f.variant, tf, f.vacuum?.rooms, f.vacuum?.crop, mode, f.vacuum?.delay, o.focus?.id ?? '', floor.id]);
      const old = this.vacs.get(f.id);
      if (old && old.key === key) {
        old.o = o;
        // the run is over (docked, idle …): its trail goes
        if (!IN_RUN.has(o.getState(f.entity!)?.state ?? '') && old.trail.pts.length) this.clearTrail(old.trail);
        continue;
      }
      if (old) {
        old.group.removeFromParent();
        this.release(old.group);
      }
      const group = new Group();
      group.userData = { id: f.id, linked: true, tappable: true, keep: true, vacuum: true };
      // the vacuum's own model, built at the origin
      const body = this.buildPiece({ ...f, x: 0, y: 0, rotation: 0 }, { ...o, focus: undefined }, { cut: o.height, supports: [], glassC: this.color('--fp-glass') });
      if (body) group.add(body);
      // its side brush at the front corner: three bristles that spin while it drives
      const R0 = Math.min(f.w, f.h) / 2;
      const brush = new Group();
      brush.position.set(R0 * 0.62, R0 * 0.62, 0.5);
      const bristle = this.lambert(this.color('#3a3a3d'));
      for (let k = 0; k < 3; k++) {
        const arm = new Group();
        arm.rotation.z = (k * Math.PI * 2) / 3;
        const m = new Mesh(UNIT_BOX, bristle);
        m.scale.set(R0 * 0.5, 0.5, 0.4);
        m.position.set(R0 * 0.25, 0, 0);
        arm.add(m);
        brush.add(arm);
      }
      group.add(brush);
      const nav = buildNav(floor, o.getState, false, 12, false);
      // what it cannot pass: walls and windows (doors only when closed). The nav grid keeps a pet's distance from
      // them, but a vacuum is where it reports — often right along a wall (edge cleaning, or its map laid on a
      // few cm off): only the wall itself is out of bounds for it
      const rooms = floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
      const walls = wallPieces(floor).filter((p) => p.kind !== 'door' || (p.opening?.entity ? openingState(o.getState(p.opening.entity)) : 'open') === 'closed');
      // robot → plan: whole-map alignment, rooms placed on their own, cut-out areas (needs the map for the rooms)
      const mapperFor = (m?: VacuumMap) => new VacuumMapper(tf, f.vacuum?.rooms, f.vacuum?.crop, m);
      if (old) this.dropTrail(old.trail);
      const trail: VacTrail = { run: old?.trail.run ?? -1, pts: old?.trail.pts ?? [], lastDraw: 0, dirty: true, width: Math.min(f.w, f.h) * 0.9 };
      const rec = { key, tf, m: mapperFor((old as any)?.map), group, floor, o, f, nav, learned: old?.learned, live: undefined as unknown as LiveVacuum, trail, baseDelay: 2500, lags: (old as { lags?: number[] } | undefined)?.lags ?? [] };
      (rec as any).map = (old as any)?.map;
      const passable = (p: Point) => {
        if (!rec.nav) return true;
        const i = Math.round((p[0] - rec.nav.x0) / rec.nav.cell);
        const j = Math.round((p[1] - rec.nav.y0) / rec.nav.cell);
        if (i >= 0 && j >= 0 && i < rec.nav.nx && j < rec.nav.ny && rec.nav.free[j * rec.nav.nx + i]) return true;
        // near a wall (the grid's margin): inside a room and not on the wall line is fine
        return rooms.some((r) => pointInPolygon(p, r.points)) && !walls.some((w) => closestPointOnSegment(p, w.a, w.b).dist < 3);
      };
      // a guess (live) also stays on floor it has driven over
      const allowed = (p: Point) => passable(p) && (learnedOk ? learnedOk(p) : true);
      let learnedOk = learnedLookup(rec.learned, rec.m, (rec as any).map);
      const speed = rec.learned?.speed ? rec.learned.speed / 10 : 25;
      rec.live = new LiveVacuum(mode, (f.vacuum?.delay ?? 2.5) * 1000, allowed, (a, b) => (rec.nav ? findPath(rec.nav, a, b) : undefined), speed, passable);
      rec.baseDelay = (f.vacuum?.delay ?? 2.5) * 1000;
      if (old) for (const sm of old.live.samples) rec.live.feed(sm);
      (rec as any).setLearned = (l: LearnedFloor) => {
        rec.learned = l;
        learnedOk = learnedLookup(l, rec.m, (rec as any).map);
        if (l.speed) rec.live.speed = l.speed / 10;
      };
      (rec as any).setMap = (m: VacuumMap) => {
        (rec as any).map = m;
        rec.m = mapperFor(m);
        learnedOk = learnedLookup(rec.learned, rec.m, m);
      };
      group.userData.anim = () => {
        const st = rec.live.step(performance.now());
        // its static piece stays out of the way while it drives here
        const piece = this.furniture.children.find((c) => c.userData.id === f.id);
        if (piece) piece.visible = !st;
        if (!st) {
          group.visible = false;
          return false;
        }
        group.visible = !rec.o.focus || pointInPolygon(st.p, rec.o.focus.points);
        group.position.set(st.p[0], st.p[1], 0);
        // where it has cleaned in this run: a trail on the floor (only while it cleans)
        if (rec.o.getState(f.entity!)?.state === 'cleaning') {
          const last = trail.pts[trail.pts.length - 1];
          if (!last || Math.hypot(st.p[0] - last[0], st.p[1] - last[1]) > 3) {
            trail.pts.push([st.p[0], st.p[1]]);
            trail.dirty = true;
          }
        }
        if (trail.dirty && performance.now() - trail.lastDraw > 400) this.drawTrail(trail, rec.floor);
        // the model's front (bumper) is its +y: turn it into the direction of travel
        group.rotation.z = st.heading - Math.PI / 2;
        if (brush) brush.rotation.z -= 0.45;
        const turning = rec.live.turning;
        return st.moving || turning ? 33 : false;
      };
      this.petGroup.add(group);
      this.vacs.set(f.id, rec);
      if (trail.pts.length && IN_RUN.has(o.getState(f.entity!)?.state ?? '')) this.drawTrail(trail, floor);
    }
    this.requestRender();
  }
  /** A new position from the server (robot coordinates, mm); seq: the server's counter (each one once) */
  feedVacuum(id: string, x: number, y: number, seq: number, interval?: number, at?: number | null) {
    const v = this.vacs.get(id) as { live: LiveVacuum; m: VacuumMapper; seq?: number; baseDelay?: number; lags?: number[] } | undefined;
    if (!v || (v.seq !== undefined && seq <= v.seq)) return;
    v.seq = seq;
    // a robot whose integration reports only every few seconds (map cameras): shown that much further behind,
    // so the next position is still known before it is needed
    if (interval && v.baseDelay) {
      const want = Math.max(v.baseDelay, Math.min(12000, interval * 1.6 + 800));
      // nothing shown yet: take it at once; else glide there
      if (v.live.samples.length) v.live.delayTarget = want;
      else v.live.delay = want;
    }
    // when it was there: the server's time of the reading (at, epoch ms), on this page's clock. Arrival times
    // alone jitter by a few hundred ms (it would speed up and slow down between positions); the smallest lag of
    // the last readings counts as the network's own share (so the clocks of server and tablet need not agree)
    const now = performance.now();
    let t = now;
    if (at && v.lags) {
      const lag = Date.now() - at;
      v.lags.push(lag);
      if (v.lags.length > 10) v.lags.shift();
      t = now - (lag - Math.min(...v.lags));
    }
    const prev = v.live.samples[v.live.samples.length - 1]?.t;
    if (prev !== undefined) t = Math.min(now, Math.max(t, prev + 1));
    v.live.feed({ t, p: v.m.toPlan(x, y) });
    this.requestRender();
  }

  /** What the vacuum has learned about the floor */
  setVacuumLearned(id: string, learned: LearnedFloor) {
    const v = this.vacs.get(id) as { setLearned?: (l: LearnedFloor) => void } | undefined;
    v?.setLearned?.(learned);
  }

  /** The vacuum's own map (its whole floor counts as drivable at once) */
  setVacuumMap(id: string, map: VacuumMap) {
    (this.vacs.get(id) as { setMap?: (m: VacuumMap) => void } | undefined)?.setMap?.(map);
  }

  hasLiveVacuum(id: string) {
    return this.vacs.has(id);
  }

  /** The run is over: its trail goes */
  clearVacuumTrail(id: string) {
    const v = this.vacs.get(id);
    if (v?.trail.pts.length) this.clearTrail(v.trail);
  }

  /** The server's trail of the current run (robot mm): replaces what this tablet has seen so far */
  setVacuumTrail(id: string, run: number, robotPts: [number, number][]) {
    const v = this.vacs.get(id) as ({ m: VacuumMapper; trail: VacTrail; floor: FloorConfig } & object) | undefined;
    if (!v) return;
    v.trail.run = run;
    v.trail.pts = robotPts.filter(([x, y]) => !v.m.cut(x, y)).map(([x, y]) => v.m.toPlan(x, y));
    v.trail.dirty = true;
    this.drawTrail(v.trail, v.floor);
  }

  /** Trail: one canvas over the plan (1 px ≈ 1 cm), the path stroked once — overlaps do not get darker */
  private drawTrail(tr: VacTrail, floor: FloorConfig) {
    tr.dirty = false;
    tr.lastDraw = performance.now();
    if (tr.pts.length < 2) {
      if (tr.mesh) tr.mesh.visible = false;
      this.requestRender();
      return;
    }
    if (!tr.mesh) {
      const b = floorBounds(floor);
      const minX = b.minX - 120;
      const minY = b.minY - 120;
      const w = b.maxX - b.minX + 240;
      const h = b.maxY - b.minY + 240;
      const k = Math.min(1, 1400 / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(w * k);
      canvas.height = Math.ceil(h * k);
      const tex = new CanvasTexture(canvas);
      tex.flipY = false;
      tex.colorSpace = SRGBColorSpace;
      const mat = new MeshBasicMaterial({ map: tex, color: this.color('--fp-vac-trail'), transparent: true, opacity: 0.62, depthWrite: false });
      const mesh = new Mesh(new PlaneGeometry(w, h), mat);
      mesh.position.set(minX + w / 2, minY + h / 2, 0.35);
      mesh.raycast = () => {};
      mesh.renderOrder = 1;
      mesh.userData.vacuum = true;
      this.petGroup.add(mesh);
      tr.mesh = mesh;
      tr.canvas = canvas;
      tr.box = { minX, minY, k };
    }
    const ctx = tr.canvas!.getContext('2d')!;
    const { minX, minY, k } = tr.box!;
    ctx.clearRect(0, 0, tr.canvas!.width, tr.canvas!.height);
    ctx.save();
    ctx.scale(k, k);
    ctx.translate(-minX, -minY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    tr.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    // a soft edge, then the full width
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = tr.width * 1.18;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = tr.width;
    ctx.stroke();
    ctx.restore();
    (tr.mesh.material as MeshBasicMaterial).map!.needsUpdate = true;
    tr.mesh.visible = true;
    this.requestRender();
  }

  private clearTrail(tr: VacTrail) {
    tr.pts = [];
    tr.dirty = false;
    if (tr.mesh) tr.mesh.visible = false;
    this.requestRender();
  }

  private dropTrail(tr: VacTrail) {
    if (!tr.mesh) return;
    tr.mesh.removeFromParent();
    tr.mesh.geometry.dispose();
    (tr.mesh.material as MeshBasicMaterial).map?.dispose();
    (tr.mesh.material as MeshBasicMaterial).dispose();
    tr.mesh = undefined;
    tr.canvas = undefined;
  }

  /** Soft contact shadow under a pet (the shadow map is not redrawn while it moves) */
  private blobShadow(): Texture {
    if (!this.blobTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      const gr = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,0.55)');
      gr.addColorStop(0.55, 'rgba(0,0,0,0.28)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, 64, 64);
      this.blobTex = new CanvasTexture(c);
    }
    return this.blobTex;
  }
  private blobTex?: Texture;

  private buildDog(f: FurnitureConfig, o: GlBuild): Group | undefined {
    const info = o.pet?.(f) ?? {};
    const st = info.state;
    const g = new Group();
    g.userData = { id: f.id, linked: true, keep: true, tappable: true, pet: true };
    if (st?.mode === 'away') {
      this.dogs.delete(f.id);
      return undefined;
    }
    const r = resolveFurniture(f);
    const look = petLook(f);
    const L0 = f.w; // body length (cm)
    const navOpen = () => info.nav?.(false);
    let life = this.dogs.get(f.id);
    const lifeKey = `${f.x},${f.y},${f.w},${dogLookKey(look)}`;
    if (!life || life.key !== lifeKey) {
      life?.actor?.dispose();
      const nav = navOpen();
      const start = nav ? nearestFree(nav, [f.x, f.y], 200, 2) : undefined;
      life = { key: lifeKey, pos: new Vector2(...(start ?? [f.x, f.y])), heading: ((f.rotation ?? 0) * Math.PI) / 180, v: 0, task: 'sleep', until: this.animNow() + 30000 + Math.random() * 60000, last: this.animNow(), seed: Math.random() * 1000 };
      this.dogs.set(f.id, life);
    }
    const L = life;
    g.position.set(L.pos.x, L.pos.y, 0);
    g.rotation.z = L.heading;
    // contact shadow (cheap; follows the dog and its pose)
    const shadow = new Mesh(UNIT_PLANE, new MeshBasicMaterial({ map: this.blobShadow(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.7 }));
    shadow.position.z = 0.3;
    shadow.renderOrder = 1;
    shadow.raycast = () => {};
    g.add(shadow);
    const setShadow = (lying: boolean) => {
      shadow.scale.set(L0 * (lying ? 1.25 : 1.05), f.h * (lying ? 1.9 : 1.5), 1);
      shadow.position.x = lying ? L0 * 0.12 : 0;
    };
    setShadow(L.task === 'sleep' || L.task === 'rest');
    // the model loads once per breed; until then nothing is shown
    const model = dogModelFor(look.breed);
    const restPose = () => {
      const a = L.actor!;
      const lying = L.task === 'sleep' || L.task === 'rest' || (L.task === 'door' && L.lying);
      a.play(L.task === 'sleep' ? 'Sleep' : lying ? 'Lie' : 'Idle', { fade: 0 });
      a.eyesClosed = L.task === 'sleep';
      a.update(0.01);
    };
    const attach = (a: DogActor | SimpleDog) => {
      L.actor = a;
      a.group.traverse((m) => {
        (m as Mesh).castShadow = false; // the contact shadow stands in (no shadow-map redraws while walking)
      });
      g.add(a.group);
      restPose();
      this.requestRender();
    };
    if (L.actor) {
      g.add(L.actor.group);
    } else if (look.figure === 'simple') {
      // the light code-drawn figure: nothing to load
      attach(new SimpleDog(look, { length: f.w, height: r.height, width: f.h }));
    } else {
      void loadDog(model).then((src) => {
        if (!src || L.actor) return;
        attach(new DogActor(src, { length: f.w * 1.05, height: r.height, width: f.h }, { ...look, model }));
      });
    }
    // leash: from the mouth down to the floor (while waiting at the door)
    const leash = new Group();
    const strap = new Mesh(UNIT_CYL, this.lambert(this.color(look.collar)));
    leash.add(strap);
    const loop = new Mesh(UNIT_CYL, this.lambert(this.color(look.collar)));
    leash.add(loop);
    leash.visible = false;
    g.add(leash);
    const home = new Vector2(f.x, f.y);
    const nav0 = navOpen();
    const bed = (o.all ?? []).filter((x) => resolveFurniture(x).k?.kind === 'pet_bed').map((x) => new Vector2(x.x, x.y)).sort((a, b) => a.distanceTo(home) - b.distanceTo(home))[0];
    const homeFree = nav0 ? nearestFree(nav0, [home.x, home.y], 200, 2) : undefined;
    const restAt = bed && bed.distanceTo(home) < 250 ? bed : homeFree ? new Vector2(...homeFree) : home;
    // the bowls: a free spot right in front of them
    const bowls = (o.all ?? [])
      .filter((x) => resolveFurniture(x).k?.kind === 'food_bowls')
      .map((x) => {
        const p = nav0 ? nearestFree(nav0, [x.x, x.y], 120) : undefined;
        return p ? { at: new Vector2(...p), face: Math.atan2(x.y - p[1], x.x - p[0]) } : undefined;
      })
      .filter((x): x is { at: Vector2; face: number } => !!x);
    // stairs to another floor: now and then it goes up (or down) them, stays away a while, and comes back
    const trips = (o.all ?? [])
      .filter((s) => resolveFurniture(s).k?.kind === 'stairs' && o.stairsTo?.has(s.id))
      .map((s) => stairWay(s, o.stairsTo!.get(s.id)!, (p) => (nav0 ? nearestFree(nav0, p, 90) : p)))
      .filter((x): x is { foot: Vector2; pts: Vector2[]; zs: number[] } => !!x);
    const due = st?.mode === 'due';
    // speeds (cm/s) and how fast the legs move for them: the clips cover 0.405 (walk) and 1.3 (gallop) body
    // lengths per second at normal speed — the legs never slide
    const WALK = L0 * 0.78;
    const RUN = L0 * 2.3;
    const STRIDE_W = L0 * 1.05 * 0.405;
    const STRIDE_R = L0 * 1.05 * 1.3;
    const go = (target: Vector2, allowClosed = false): boolean => {
      const nav = navOpen();
      let path = nav ? findPath(nav, [L.pos.x, L.pos.y], [target.x, target.y]) : undefined;
      // only on the way out may it pass a closed door (when there is no other way)
      if (!path && allowClosed) {
        const nav2 = info.nav?.(true);
        path = nav2 ? findPath(nav2, [L.pos.x, L.pos.y], [target.x, target.y]) : undefined;
      }
      // no way there: it stays (never straight through furniture)
      if (!path || path.length < 2) {
        L.path = undefined;
        return false;
      }
      L.path = path.map(([x, y]) => new Vector2(x, y));
      L.seg = 1;
      return true;
    };
    const wrap = (d: number) => {
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    const turnTo = (target: number, rate: number, dt: number) => {
      const d = wrap(target - L.heading);
      const step = rate * dt;
      L.heading += Math.abs(d) <= step ? d : Math.sign(d) * step;
      return Math.abs(d);
    };
    /** Point on the path a little ahead of the dog (it steers towards it: smooth curves, no sliding) */
    const carrot = (ahead: number): { p: Vector2; left: number } => {
      const p = L.path!;
      // advance the segment once the dog has passed its end
      while (L.seg! < p.length - 1) {
        const a = p[L.seg! - 1];
        const b = p[L.seg!];
        const ab = b.clone().sub(a);
        const t = ab.lengthSq() ? L.pos.clone().sub(a).dot(ab) / ab.lengthSq() : 1;
        if (t < 1 && L.pos.distanceTo(b) > ahead * 0.6) break;
        L.seg!++;
      }
      let rest = ahead;
      let from = L.pos.clone();
      let left = 0;
      let pick: Vector2 | undefined;
      for (let i = L.seg!; i < p.length; i++) {
        const d = from.distanceTo(p[i]);
        if (!pick && d >= rest) pick = from.clone().add(p[i].clone().sub(from).multiplyScalar(rest / d));
        else if (!pick) rest -= d;
        left += d;
        from = p[i];
      }
      return { p: pick ?? p[p.length - 1].clone(), left };
    };
    /** Walk / run along the path; true when arrived */
    const move = (dt: number, vmax: number): boolean => {
      if (!L.path || L.seg === undefined) return true;
      const { p, left } = carrot(L0 * 0.45);
      if (left < 2 && L.v < L0 * 0.2) {
        L.v = 0;
        return true;
      }
      const want = Math.atan2(p.y - L.pos.y, p.x - L.pos.x);
      const err = turnTo(want, vmax > WALK * 1.5 ? 3.4 : 2.6, dt);
      // slow down for tight turns and towards the end; turn on the spot when facing away
      const cap = Math.min(vmax, Math.sqrt(2 * L0 * 1.6 * Math.max(0, left - 1)) + L0 * 0.1) * Math.max(0, Math.cos(Math.min(Math.PI / 2, err * 1.1)));
      const acc = L0 * 1.8;
      L.v = L.v < cap ? Math.min(cap, L.v + acc * dt) : Math.max(cap, L.v - acc * 1.6 * dt);
      const step = Math.min(L.v * dt, left);
      L.pos.x += Math.cos(L.heading) * step;
      L.pos.y += Math.sin(L.heading) * step;
      if (left - step < 1.5) {
        L.pos.copy(L.path[L.path.length - 1]);
        L.v = 0;
        return true;
      }
      return false;
    };
    /** Legs follow the speed */
    const gait = (a: DogActor | SimpleDog) => {
      if (L.v > WALK * 1.45) a.play('Gallop', { fade: 0.25, speed: Math.max(0.7, Math.min(1.6, L.v / STRIDE_R)) });
      else if (L.v > L0 * 0.04) a.play('Walk', { fade: 0.3, speed: Math.max(0.55, Math.min(2.4, L.v / STRIDE_W)) });
      else a.play('Walk', { fade: 0.3, speed: 0.6 }); // stepping round on the spot
    };
    const rnd = () => {
      L.seed = (L.seed * 9301 + 49297) % 233280;
      return L.seed / 233280;
    };
    const lieDown = (now: number, sleep: boolean, a: DogActor | SimpleDog) => {
      L.task = sleep ? 'sleep' : 'rest';
      L.until = now + (sleep ? 90000 + rnd() * 150000 : 25000 + rnd() * 35000);
      a.play(sleep ? 'Sleep' : 'Lie', { fade: 1.3 });
      L.settle = now + 1500;
    };
    // the dog wants out while it is on (or behind) the stairs: back at their foot first
    if (due && (L.task === 'climb' || L.task === 'away' || L.task === 'toStairs')) {
      const tr = trips[L.trip ?? 0];
      if (tr) L.pos.copy(tr.foot);
      L.z = 0;
    }
    // the dog wants out: to the front door
    if (due && info.door) {
      if (L.task !== 'toDoor' && L.task !== 'door') {
        L.task = go(new Vector2(...info.door.inside), true) ? 'toDoor' : 'door';
        L.until = this.animNow();
        L.lying = false;
      }
    } else if (L.task === 'toDoor' || L.task === 'door') {
      L.task = 'idle';
      L.until = this.animNow() + 2500;
    }
    const face = info.door ? Math.atan2(info.door.face[1] - info.door.inside[1], info.door.face[0] - info.door.inside[0]) : 0;
    g.userData.anim = (now: number) => {
      const a = L.actor;
      // slow devices: bigger steps (up to a quarter second) instead of a dog in slow motion
      const dt = Math.min(0.25, (now - L.last) / 1000);
      L.last = now;
      if (!a) return 200;
      // on an unattended tablet the dog settles down and the scene stops redrawing for it
      const attended = idleFor() < UNATTENDED;
      const eco = this.profile === 'eco';
      let next: number | boolean = eco ? 50 : 33;
      leash.visible = false;
      a.eyesClosed = L.task === 'sleep';
      switch (L.task) {
        case 'sleep':
        case 'rest':
          // breathing; nothing to redraw once nobody watches
          next = now < (L.settle ?? 0) ? 33 : attended ? 140 : false;
          if (now > L.until && attended) {
            if (L.task === 'sleep' && rnd() < 0.5) {
              // dozing on: lift the head for a while
              L.task = 'rest';
              L.until = now + 15000 + rnd() * 20000;
              a.play('Lie', { fade: 1.2 });
              L.settle = now + 1300;
            } else {
              L.task = 'wake';
              L.until = now + 1300;
              a.play('Idle', { fade: 1.2, speed: 0.8 });
            }
          }
          break;
        case 'wake':
          next = 40;
          if (now > L.until) {
            L.task = 'idle';
            L.until = now + 2000 + rnd() * 3500;
            a.play(rnd() < 0.5 ? 'Idle' : 'Idle_2', { fade: 0.5 });
          }
          break;
        case 'idle':
          next = 50;
          if (now > L.until) {
            if (!attended) {
              L.after = 'lie';
              L.task = go(restAt) ? 'walk' : 'idle';
              if (L.task === 'idle') lieDown(now, true, a);
              break;
            }
            // what next: a stroll, the bowls, a sniff around, or back to its place
            const x = rnd();
            const nav = navOpen();
            let ok = false;
            if (x < 0.2 && bowls.length) {
              L.after = 'eat';
              const b = bowls[Math.floor(rnd() * bowls.length)];
              L.face = b.face;
              ok = go(b.at);
            } else if (x < 0.7 && nav) {
              const spot = randomSpot(nav, Math.floor(rnd() * 1e6), [L.pos.x, L.pos.y], L0 * 2.2);
              L.after = rnd() < 0.55 ? 'sniff' : 'look';
              ok = !!spot && go(new Vector2(...spot));
            } else if (x < 0.8 && trips.length) {
              // up (or down) the stairs for a while
              L.trip = Math.floor(rnd() * trips.length);
              if (go(trips[L.trip].foot)) {
                L.task = 'toStairs';
                break;
              }
            } else {
              L.after = 'lie';
              ok = go(restAt);
            }
            if (ok) L.task = 'walk';
            else if (L.after === 'lie') lieDown(now, true, a);
            else L.until = now + 3000;
          }
          break;
        case 'walk':
          gait(a);
          if (move(dt, WALK)) {
            if (L.after === 'eat') {
              L.task = 'eat';
              L.until = now + 5000 + rnd() * 4000;
              a.play('Eating', { fade: 0.5 });
            } else if (L.after === 'sniff') {
              L.task = 'idle';
              L.until = now + 3500 + rnd() * 3000;
              a.play('Idle_2_HeadLow', { fade: 0.5 });
            } else if (L.after === 'lie') {
              lieDown(now, rnd() < 0.7, a);
            } else {
              L.task = 'idle';
              L.until = now + 3000 + rnd() * 4000;
              a.play(rnd() < 0.5 ? 'Idle' : 'Idle_2', { fade: 0.5 });
            }
          }
          break;
        case 'toStairs':
          gait(a);
          if (move(dt, WALK)) {
            L.task = 'climb';
            L.climbI = 0;
            L.climbBack = false;
          }
          break;
        case 'climb': {
          // step by step along the walking line, the body rising (or sinking) with the treads
          const tr = trips[L.trip ?? 0];
          if (!tr) {
            L.z = 0;
            L.task = 'idle';
            L.until = now + 2000;
            break;
          }
          const pts = L.climbBack ? [...tr.pts].reverse() : tr.pts;
          const zs = L.climbBack ? [...tr.zs].reverse() : tr.zs;
          let i = L.climbI ?? 0;
          let step = WALK * 0.5 * dt;
          L.v = WALK * 0.5;
          a.play('Walk', { fade: 0.3, speed: 0.75 });
          while (step > 0 && i < pts.length - 1) {
            const to = pts[i + 1];
            const d = L.pos.distanceTo(to);
            turnTo(Math.atan2(to.y - L.pos.y, to.x - L.pos.x), 5, dt);
            if (d <= step) {
              L.pos.copy(to);
              step -= d;
              i++;
            } else {
              L.pos.add(to.clone().sub(L.pos).multiplyScalar(step / d));
              step = 0;
            }
          }
          L.climbI = i;
          if (i < pts.length - 1) {
            const seg = pts[i].distanceTo(pts[i + 1]) || 1;
            const k = Math.min(1, pts[i].distanceTo(L.pos) / seg);
            L.z = zs[i] + (zs[i + 1] - zs[i]) * k;
          } else if (!L.climbBack) {
            // arrived on the other floor: out of sight for a while
            L.z = zs[zs.length - 1];
            L.v = 0;
            L.task = 'away';
            L.until = now + 40000 + rnd() * 80000;
          } else {
            L.z = 0;
            L.v = 0;
            L.task = 'idle';
            L.until = now + 2500 + rnd() * 3000;
            a.play('Idle', { fade: 0.5 });
          }
          next = 33;
          break;
        }
        case 'away':
          next = attended ? 500 : false;
          if (now > L.until) {
            const tr = trips[L.trip ?? 0];
            if (tr) {
              L.pos.copy(tr.pts[tr.pts.length - 1]);
              L.task = 'climb';
              L.climbI = 0;
              L.climbBack = true;
            } else {
              L.task = 'idle';
              L.z = 0;
            }
          }
          break;
        case 'eat':
          next = 50;
          if (L.face !== undefined) turnTo(L.face, 2.5, dt);
          if (now > L.until) {
            L.task = 'idle';
            L.until = now + 1500;
            a.play('Idle', { fade: 0.5 });
          }
          break;
        case 'toDoor': {
          const left = L.path ? carrot(0).left : 0;
          gait(a);
          if (move(dt, left > L0 * 4 ? RUN : WALK * 1.15)) {
            L.task = 'door';
            L.until = now;
            L.lying = false;
          }
          break;
        }
        case 'door': {
          // at the front door: excited (paws, jumps), then waiting lying down with the leash;
          // now and then it gets up again — only while somebody is around
          turnTo(face, 3, dt);
          const t = (now - L.until) / 1000;
          if (t < 7 || (attended && t % 45 > 39)) {
            const c = t % 3.6;
            if (L.lying) {
              L.lying = false;
              a.play('Idle', { fade: 0.9 });
            } else if (c < 2.2) a.play('Idle_2', { fade: 0.35, speed: 1.7 });
            else a.play(a.has('Gallop_Jump') ? 'Gallop_Jump' : 'Jump_ToIdle', { fade: 0.25 });
            next = 40;
          } else {
            if (!L.lying) {
              L.lying = true;
              a.play('Lie', { fade: 1.2 });
              L.settle = now + 1400;
            }
            leash.visible = true;
            next = now < (L.settle ?? 0) ? 33 : attended ? 150 : false;
          }
          break;
        }
      }
      a.update(dt);
      setShadow(L.task === 'sleep' || L.task === 'rest' || (L.task === 'door' && !!L.lying));
      g.position.set(L.pos.x, L.pos.y, L.task === 'climb' || L.task === 'away' ? (L.z ?? 0) : 0);
      g.rotation.z = L.heading;
      g.visible = L.task !== 'away' && (!o.focus || L.task === 'toDoor' || L.task === 'door' || pointInPolygon([L.pos.x, L.pos.y], o.focus.points));
      if (leash.visible) {
        const head = a.bone('Head');
        if (head) {
          const hp = head.getWorldPosition(new Vector3());
          g.updateMatrixWorld(true);
          const lp = g.worldToLocal(hp);
          strap.scale.set(1.4, 1.4, Math.max(2, lp.z));
          strap.position.set(lp.x + 6, lp.y, 0);
          loop.scale.set(f.w * 0.3, f.w * 0.22, 1.2);
          loop.position.set(lp.x + 14, lp.y + 6, 0.5);
        }
      }
      return next;
    };
    return g;
  }

  // ---------- pets ----------

  private blobMesh(b: Blob, glow = false, soft = false): Mesh {
    const col = this.color(paint(b.c));
    const phong = (shin: number, spec: number) => {
      const key = `ph|${col.getHexString()}|${shin}|${spec}`;
      let m = this.materials.get(key);
      if (!m) this.materials.set(key, (m = new MeshPhongMaterial({ color: col, shininess: shin, specular: new Color(spec, spec, spec) })));
      return m;
    };
    const mat =
      b.gloss && !b.emit
        ? phong(b.gloss, 0.55)
        : soft && !b.emit && !b.glass
          ? phong(7, 0.07)
          : b.glass
        ? this.lambert(this.color('--fp-glass').clone().lerp(col, 0.55), { opacity: 0.55, side: 'double', depthWrite: false })
        : b.op != null && b.op < 1
          ? this.lambert(col, { opacity: b.op, depthWrite: false })
          : b.emit && glow
            ? this.basic(col.clone().lerp(new Color(1, 1, 1), 0.15))
            : b.emit
              ? this.lambert(col.clone().multiplyScalar(0.7))
              : this.lambert(col);
    let m: Mesh;
    if (b.s === 'wheel') {
      m = new Mesh(UNIT_WHEEL, mat);
      m.scale.set(b.w, b.d, b.h);
      m.position.set(b.x, b.y, b.z);
    } else if (b.s === 'cone') {
      m = new Mesh(UNIT_CONE, mat);
      m.scale.set(b.w, b.d, b.h);
      m.position.set(b.x, b.y, b.z);
    } else if (b.s === 'box' && b.r) {
      const geo = roundedBox(b.w, b.d, b.h, Math.max(0.2, Math.min(b.r, b.w / 2 - 0.01, b.d / 2 - 0.01)));
      this.own(geo);
      m = new Mesh(geo, mat);
      m.position.set(b.x, b.y, b.z - b.h / 2);
    } else if (b.s === 'ell') {
      m = new Mesh(UNIT_SPHERE, mat);
      m.scale.set(b.w, b.d, b.h);
      m.position.set(b.x, b.y, b.z);
    } else if (b.s === 'cyl') {
      m = new Mesh(UNIT_CYL, mat);
      m.scale.set(b.w, b.d, b.h);
      m.position.set(b.x, b.y, b.z);
    } else {
      m = new Mesh(UNIT_BOX, mat);
      m.scale.set(b.w, b.d, b.h);
      m.position.set(b.x, b.y, b.z - b.h / 2);
    }
    m.rotation.set((b.rx ?? 0) * DEG, (b.ry ?? 0) * DEG, (b.rz ?? 0) * DEG);
    const solid = !b.glass && !(b.op != null && b.op < 1);
    m.castShadow = solid;
    m.receiveShadow = solid;
    if (!solid) m.renderOrder = 3;
    if (b.name) m.name = b.name;
    return m;
  }

  /** A model node tree as groups (named groups / meshes can be animated) */
  private buildNode(n: ModelNode, glow: boolean): Group {
    const g = new Group();
    if (n.at) g.position.set(...n.at);
    if (n.rot) g.rotation.set(n.rot[0] * DEG, n.rot[1] * DEG, n.rot[2] * DEG);
    if (n.name) g.name = n.name;
    for (const b of n.blobs) g.add(this.blobMesh(b, glow));
    for (const k of n.kids ?? []) g.add(this.buildNode(k, glow));
    return g;
  }

  /** A dog standing still in its resting pose (editor): the animated model, one frame */
  private buildDogStill(f: FurnitureConfig): Group {
    const r = resolveFurniture(f);
    const look = petLook(f);
    const g = new Group();
    g.position.set(f.x, f.y, 0);
    g.rotation.z = (f.rotation ?? 0) * DEG;
    g.userData = { id: f.id, linked: true, keep: true, tappable: true, pet: true };
    const lying = look.pose === 'lying';
    const shadow = new Mesh(UNIT_PLANE, new MeshBasicMaterial({ map: this.blobShadow(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.7 }));
    shadow.position.set(lying ? f.w * 0.12 : 0, 0, 0.3);
    shadow.scale.set(f.w * (lying ? 1.25 : 1.05), f.h * (lying ? 1.9 : 1.5), 1);
    shadow.renderOrder = 1;
    shadow.raycast = () => {};
    g.add(shadow);
    // something to tap while the model loads (and a hit area that is easy to grab)
    const hit = new Mesh(UNIT_BOX, new MeshBasicMaterial({ visible: false }));
    hit.scale.set(f.w, f.h * 1.2, r.height * (lying ? 0.6 : 1));
    g.add(hit);
    const still = (a: DogActor | SimpleDog) => {
      a.group.traverse((m) => ((m as Mesh).castShadow = false));
      a.play(lying ? 'Lie' : look.pose === 'sitting' ? 'Sit' : 'Idle', { fade: 0, once: lying || look.pose === 'sitting' });
      a.update(0.01);
      g.add(a.group);
      g.userData.dogActor = a;
      this.requestRender();
    };
    if (look.figure === 'simple') {
      still(new SimpleDog(look, { length: f.w, height: r.height, width: f.h }));
      return g;
    }
    const model = dogModelFor(look.breed);
    void loadDog(model).then((src) => {
      if (!src || this.destroyed) return;
      still(new DogActor(src, { length: f.w * 1.05, height: r.height, width: f.h }, { ...look, model }));
    });
    return g;
  }

  /**
   * Dog / cat: an articulated model (body, head, tail, legs) that breathes and wags at rest; a dog that
   * wants to go out walks to the front door, scratches at it, runs around excitedly and sits there with
   * the leash in its mouth. Out of the house (presence away): not shown.
   */
  private buildPet(f: FurnitureConfig, o: GlBuild): Group | undefined {
    const rig = petRig(f);
    const look = petLook(f);
    const info = o.pet?.(f) ?? {};
    const st = info.state;
    const g = new Group();
    g.position.set(f.x, f.y, 0);
    g.rotation.z = (f.rotation ?? 0) * DEG;
    g.userData = { id: f.id, linked: true, keep: true, tappable: true, pet: true };
    if (st?.mode === 'away' && !o.editing) return undefined;
    const rigG = new Group();
    g.add(rigG);
    for (const b of rig.body) rigG.add(this.blobMesh(b, true, true));
    const joint = (j: { pivot: [number, number, number]; parts: Blob[] }) => {
      const jg = new Group();
      jg.position.set(...j.pivot);
      for (const b of j.parts) jg.add(this.blobMesh(b, true, true));
      rigG.add(jg);
      return jg;
    };
    const head = joint(rig.head);
    const tail = joint(rig.tail);
    const legs = rig.legs.map(joint);
    const leash = new Group();
    for (const b of rig.leash) leash.add(this.blobMesh(b, true, true));
    leash.visible = false;
    head.add(leash);
    const cat = rig.kind === 'cat';
    const L = rig.length;
    const legLen = rig.legLen;
    // rest poses
    type Pose = { z: number; pitch: number; legs: number[]; headTurn: number; tailZ: number; legScale: number };
    const POSES: Record<string, Pose> = {
      standing: { z: 0, pitch: 0, legs: [0, 0, 0, 0], headTurn: 0, tailZ: 0, legScale: 1 },
      lying: { z: -legLen * 0.78, pitch: 0, legs: [-1.45, -1.35, -1.25, -1.2], headTurn: 0, tailZ: 0.5, legScale: 0.8 },
      sitting: { z: -legLen * 0.32, pitch: -0.42, legs: [0.42, 0.42, -1.25, -1.25], headTurn: 0, tailZ: 0.9, legScale: 1 },
      curled: { z: -legLen * 0.82, pitch: 0, legs: [-1.4, -1.4, -1.2, -1.2], headTurn: 1.1, tailZ: 2.5, legScale: 0.6 },
    };
    const apply = (p: Pose, k = 1, from?: Pose) => {
      const mix = (a: number, b: number) => (from ? a + (b - a) * k : b);
      rigG.position.z = mix(from?.z ?? 0, p.z);
      rigG.rotation.y = mix(from?.pitch ?? 0, p.pitch);
      legs.forEach((lg, i) => {
        lg.rotation.y = mix(from?.legs[i] ?? 0, p.legs[i]);
        lg.scale.setScalar(mix(from?.legScale ?? 1, p.legScale));
      });
      head.rotation.z = mix(from?.headTurn ?? 0, p.headTurn);
      tail.rotation.z = mix(from?.tailZ ?? 0, p.tailZ);
    };
    const rest = POSES[look.pose] ?? POSES.lying;
    apply(rest);
    const tailWag = (now: number, speed: number, amp: number, base = 0) => {
      tail.rotation.z = base + Math.sin(now / speed) * amp;
      tail.rotation.y = cat ? (look.pose === 'curled' ? 0.15 : -0.35 + Math.sin(now / (speed * 1.7)) * 0.12) : -0.45;
    };
    const t0 = this.animNow();
    const way = st?.mode === 'due' && !cat && !o.editing ? info.way : undefined;
    // named parts: tongue (panting), ears (flick)
    const tongue = head.getObjectByName('tongue');
    if (tongue) tongue.visible = false;
    const ears: Object3D[] = [];
    head.traverse((m) => (m.name === 'earL' || m.name === 'earR') && ears.push(m));
    const earBase = ears.map((m) => m.rotation.x);
    const flickEars = (now: number) => {
      // a quick twitch every few seconds
      const k = (now / 1000 + seed * 3.1) % 6.5;
      const tw = k < 0.25 ? Math.sin((k / 0.25) * Math.PI) * 0.35 : 0;
      ears.forEach((m, i) => (m.rotation.x = earBase[i] + (i % 2 ? -tw : tw)));
    };
    const seed = [...f.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 97;
    if (!way) {
      if (o.editing) return g;
      // a day of a pet: resting most of the time, now and then up and about in its room
      const home = new Vector2(f.x, f.y);
      const room = (o.rooms ?? []).find((rm) => rm.points.length >= 3 && pointInPolygon([f.x, f.y], rm.points));
      const inside = (p: Vector2) => !room || [[0, 0], [35, 0], [-35, 0], [0, 35], [0, -35]].every(([dx, dy]) => pointInPolygon([p.x + dx, p.y + dy], room.points));
      let spot: Vector2 | undefined;
      for (let i = 0; i < 10 && !spot; i++) {
        const ang = ((seed * 37 + i * 71) % 360) * DEG;
        const dist = (cat ? 60 : 90) + ((seed * 13 + i * 29) % 60);
        const p = home.clone().add(new Vector2(Math.cos(ang) * dist, Math.sin(ang) * dist));
        if (inside(p)) spot = p;
      }
      const C = cat ? 72 : 64;
      const t0 = ((seed * 7.3) % C) * 1000;
      let heading = g.rotation.z;
      let lastT = this.animNow();
      const turnTo = (target: number, k: number) => {
        let d = target - heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        heading += d * Math.min(1, k);
        g.rotation.z = heading;
      };
      const walk = (from: Vector2, to: Vector2, k: number, now: number, dt: number) => {
        const p = from.clone().lerp(to, Math.min(1, Math.max(0, k)));
        g.position.set(p.x, p.y, 0);
        const dir = to.clone().sub(from);
        if (dir.lengthSq() > 1) turnTo(Math.atan2(dir.y, dir.x), dt * 7);
        apply(POSES.standing);
        trotIdle(now, cat ? 120 : 105, cat ? 0.38 : 0.45);
      };
      const trotIdle = (now: number, rate: number, amp: number) => {
        const ph = now / rate;
        legs[0].rotation.y = Math.sin(ph) * amp;
        legs[3].rotation.y = Math.sin(ph) * amp;
        legs[1].rotation.y = -Math.sin(ph) * amp;
        legs[2].rotation.y = -Math.sin(ph) * amp;
        rigG.position.z = Math.abs(Math.sin(ph)) * 1.1;
      };
      const restPose = (now: number) => {
        g.position.set(home.x, home.y, 0);
        apply(rest);
        rigG.scale.z = 1 + Math.sin(now / 720) * 0.014;
        if (cat) tailWag(now, 1400, 0.22, rest.tailZ);
        else tailWag(now, 520, look.pose === 'lying' ? 0.12 : 0.3, rest.tailZ);
        // lifts the head and looks around now and then
        const look1 = Math.max(0, Math.sin(now / 7300 + seed));
        head.rotation.z = rest.headTurn + Math.sin(now / 3900) * 0.3 * look1;
        head.rotation.y = -0.12 * look1;
        flickEars(now);
      };
      g.userData.anim = (now: number) => {
        const dt = Math.min(0.1, (now - lastT) / 1000);
        lastT = now;
        const t = ((now + t0) / 1000) % C;
        rigG.scale.z = 1;
        rigG.rotation.y = 0;
        head.rotation.y = 0;
        head.rotation.x = 0;
        if (!spot) {
          restPose(now);
          return 80;
        }
        if (cat) {
          if (t < 40) return restPose(now), 80;
          if (t < 41) return apply(POSES.standing, t - 40, rest), 33;
          if (t < 43) {
            // arched stretch
            apply(POSES.standing);
            const k = Math.sin(((t - 41) / 2) * Math.PI);
            rigG.scale.z = 1 + 0.1 * k;
            rigG.position.z = legLen * 0.08 * k;
            tailWag(now, 300, 0.3, 0);
            return 33;
          }
          if (t < 47) {
            // grooming: sits, licks a raised paw
            apply(POSES.sitting);
            legs[0].rotation.y = -1.5 + Math.sin(now / 160) * 0.12;
            head.rotation.y = 0.45 + Math.sin(now / 180) * 0.08;
            head.rotation.z = 0.3;
            return 33;
          }
          if (t < 51) return walk(home, spot, (t - 47) / 4, now, dt), 33;
          if (t < 56) {
            g.position.set(spot.x, spot.y, 0);
            apply(POSES.sitting);
            tailWag(now, 600, 0.35, 0.9);
            head.rotation.z = Math.sin(now / 1200) * 0.5;
            flickEars(now);
            return 50;
          }
          if (t < 60) return walk(spot, home, (t - 56) / 4, now, dt), 33;
          if (t < 61) return apply(rest, t - 60, POSES.standing), 33;
          return restPose(now), 80;
        }
        // dog
        if (t < 30) return restPose(now), 80;
        if (t < 31) return apply(POSES.standing, t - 30, rest), 33;
        if (t < 32.6) {
          // play bow stretch
          apply(POSES.standing);
          const k = Math.sin(((t - 31) / 1.6) * Math.PI);
          rigG.rotation.y = 0.32 * k;
          rigG.position.z = -legLen * 0.12 * k;
          legs[0].rotation.y = legs[1].rotation.y = -0.9 * k;
          tailWag(now, 160, 0.4, 0);
          return 33;
        }
        const wd = spot.distanceTo(home);
        const wt = Math.max(2.5, wd / 70);
        if (t < 32.6 + wt) {
          walk(home, spot, (t - 32.6) / wt, now, dt);
          tailWag(now, 220, 0.35);
          return 33;
        }
        if (t < 40) {
          // sniffing around
          g.position.set(spot.x, spot.y, 0);
          apply(POSES.standing);
          head.rotation.y = 0.55 + Math.sin(now / 240) * 0.08;
          head.rotation.z = Math.sin(now / 700) * 0.35;
          tailWag(now, 260, 0.3);
          return 33;
        }
        if (t < 42.5) {
          // sits and scratches behind the ear
          g.position.set(spot.x, spot.y, 0);
          apply(POSES.sitting);
          legs[2].rotation.y = -1.9 + Math.sin(now / 45) * 0.35;
          head.rotation.x = 0.35;
          head.rotation.z = 0.25;
          return 33;
        }
        if (t < 42.5 + wt) {
          walk(spot, home, (t - 42.5) / wt, now, dt);
          tailWag(now, 220, 0.35);
          return 33;
        }
        const tt = t - 42.5 - wt;
        if (tt < 1.4) {
          // turns once on its place
          g.position.set(home.x, home.y, 0);
          heading += dt * ((Math.PI * 2) / 1.4);
          g.rotation.z = heading;
          apply(POSES.standing);
          trotIdle(now, 90, 0.3);
          return 33;
        }
        if (tt < 2.4) {
          g.position.set(home.x, home.y, 0);
          return apply(rest, tt - 1.4, POSES.standing), 33;
        }
        return restPose(now), 80;
      };
      return g;
    }
    // the way: lengths of the segments (plan coordinates)
    const pts = way.path.map(([x, y]) => new Vector2(x, y));
    const segs: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].distanceTo(pts[i - 1]);
      segs.push(d);
      total += d;
    }
    const at = (dist: number): { p: Vector2; dir: Vector2 } => {
      let rem = Math.max(0, Math.min(total, dist));
      for (let i = 0; i < segs.length; i++) {
        if (rem <= segs[i] || i === segs.length - 1) {
          const k = segs[i] ? rem / segs[i] : 1;
          return { p: pts[i].clone().lerp(pts[i + 1], Math.min(1, k)), dir: pts[i + 1].clone().sub(pts[i]).normalize() };
        }
        rem -= segs[i];
      }
      return { p: pts[pts.length - 1].clone(), dir: new Vector2(1, 0) };
    };
    const door = pts[pts.length - 1];
    const face = new Vector2(...way.face).sub(door).normalize();
    const speed = 115; // cm/s
    const standUp = 600;
    const walkMs = (total / speed) * 1000;
    let heading = g.rotation.z;
    const turnTo = (target: number, k: number) => {
      let d = target - heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      heading += d * Math.min(1, k);
      g.rotation.z = heading;
    };
    let last = t0;
    const trot = (now: number, rate: number, amp: number) => {
      const ph = now / rate;
      legs[0].rotation.y = Math.sin(ph) * amp;
      legs[3].rotation.y = Math.sin(ph) * amp;
      legs[1].rotation.y = -Math.sin(ph) * amp;
      legs[2].rotation.y = -Math.sin(ph) * amp;
      rigG.position.z = Math.abs(Math.sin(ph)) * 1.6;
    };
    g.userData.anim = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = now - t0;
      leash.visible = false;
      rigG.scale.z = 1;
      head.rotation.x = 0;
      head.rotation.y = 0;
      // excited: panting with the tongue out
      if (tongue) {
        tongue.visible = t > standUp;
        tongue.scale.y = 1 + Math.sin(now / 90) * 0.15;
      }
      flickEars(now);
      if (t < standUp) {
        // gets up
        apply(POSES.standing, t / standUp, rest);
        return true;
      }
      if (t < standUp + walkMs) {
        const { p, dir } = at(((t - standUp) / 1000) * speed);
        g.position.set(p.x, p.y, 0);
        turnTo(Math.atan2(dir.y, dir.x), dt * 9);
        apply(POSES.standing);
        trot(now, 85, 0.55);
        tailWag(now, 140, 0.45);
        head.rotation.z = 0;
        return true;
      }
      // at the door: scratch — run around — sit with the leash; again and again
      const c = ((t - standUp - walkMs) / 1000) % 9;
      const faceAngle = Math.atan2(face.y, face.x);
      if (c < 3) {
        g.position.set(door.x, door.y, 0);
        turnTo(faceAngle, dt * 8);
        apply(POSES.standing);
        rigG.rotation.y = -0.18;
        rigG.position.z = 1.5;
        legs[0].rotation.y = -1.25 + Math.sin(now / 85) * 0.42;
        legs[1].rotation.y = -0.15;
        tailWag(now, 120, 0.5);
        head.rotation.z = Math.sin(now / 900) * 0.12;
      } else if (c < 6) {
        const a = ((c - 3) / 3) * Math.PI * 3;
        const r = Math.max(22, L * 0.42);
        const center = door.clone().sub(face.clone().multiplyScalar(r + 8));
        g.position.set(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r, 0);
        turnTo(a + Math.PI / 2, dt * 14);
        apply(POSES.standing);
        trot(now, 60, 0.7);
        rigG.position.z += Math.max(0, Math.sin(now / 130)) * legLen * 0.25;
        tailWag(now, 90, 0.55);
        leash.visible = true;
      } else {
        g.position.set(door.x - face.x * 12, door.y - face.y * 12, 0);
        turnTo(faceAngle + Math.PI * 0.85, dt * 6);
        apply(POSES.sitting);
        leash.visible = true;
        tailWag(now, 110, 0.5, 0.9);
        head.rotation.x = Math.sin(now / 650) * 0.22;
      }
      return true;
    };
    return g;
  }

  /** Rebuild only the given pieces (their live state changed): no full rebuild when a lamp is switched */
  updatePieces(floor: FloorConfig, o: GlBuild, ids: string[]) {
    const items = floor.furniture ?? [];
    const ctx = { cut: o.height, supports: items.filter((f) => resolveFurniture(f).k?.support), glassC: this.color('--fp-glass') };
    for (const id of ids) {
      const old = this.furniture.children.find((c) => c.userData.id === id);
      if (old) {
        for (let i = this.spinning.length - 1; i >= 0; i--) {
          let p: Object3D | null = this.spinning[i];
          while (p && p !== old) p = p.parent;
          if (p) this.spinning.splice(i, 1);
        }
        old.removeFromParent();
        this.release(old);
      }
      const f = items.find((x) => x.id === id);
      const g = f ? this.buildPiece(f, o, ctx) : undefined;
      if (g) {
        this.furniture.add(g);
        g.updateMatrixWorld(true);
      }
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  private addPart(g: Group, m: Mesh, p: Part, fx?: FurnitureFx) {
    const emitting = !!fx && (p.emit || fx.kind === 'heat');
    m.castShadow = !p.glass && !p.clear && !emitting;
    m.receiveShadow = !emitting;
    if (p.glass) m.renderOrder = 3;
    g.add(m);
  }

  private partMaterial(p: Part, fx: FurnitureFx | undefined, hasEmit: boolean, glassC: Color): Material {
    if (p.glass) return this.lambert(glassC.clone().lerp(this.color(paint(p.color)), 0.25), { opacity: 0.4, side: 'double', depthWrite: false });
    if (fx && (p.emit || (fx.kind === 'heat' && !hasEmit))) {
      const fc = this.color(fx.color);
      if (fx.kind === 'heat' && !hasEmit) return this.lambert(this.color(paint(p.color)).clone().lerp(fc, 0.14));
      const white = new Color(1, 1, 1);
      const c = fx.kind === 'light' ? fc.clone().lerp(white, 0.45 - 0.25 * fx.level) : fx.kind === 'heat' ? fc.clone().lerp(new Color(1, 0.85, 0.66), 0.2) : fc.clone().lerp(white, 0.25);
      return this.basic(c);
    }
    return this.lambert(this.color(paint(p.color)));
  }

  private glassTex?: Texture;

  /** Window glass: tinted, see-through, with two soft diagonal reflections (one shared texture) */
  private glassMaterial(tint: Color, opacity: number): Material {
    const key = `glass|${tint.getHexString()}|${opacity.toFixed(2)}`;
    let m = this.materials.get(key);
    if (!m) {
      if (!this.glassTex) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = 'rgba(235,244,252,0.62)';
        ctx.fillRect(0, 0, 128, 128);
        const streak = (x: number, w: number, a: number) => {
          const gr = ctx.createLinearGradient(x - w, 0, x + w, 0);
          gr.addColorStop(0, 'rgba(255,255,255,0)');
          gr.addColorStop(0.5, `rgba(255,255,255,${a})`);
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.save();
          ctx.translate(64, 64);
          ctx.transform(1, 0, -0.6, 1, 0, 0);
          ctx.translate(-64, -64);
          ctx.fillStyle = gr;
          ctx.fillRect(x - w, -40, w * 2, 210);
          ctx.restore();
        };
        streak(52, 16, 0.95);
        streak(84, 6, 0.85);
        // a little brighter towards the top (sky reflection)
        const sky = ctx.createLinearGradient(0, 0, 0, 128);
        sky.addColorStop(0, 'rgba(255,255,255,0.25)');
        sky.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, 128, 128);
        this.glassTex = new CanvasTexture(c);
        this.glassTex.colorSpace = SRGBColorSpace;
      }
      m = new MeshLambertMaterial({ color: tint.clone().lerp(new Color(1, 1, 1), 0.35), map: this.glassTex, transparent: true, opacity, side: DoubleSide, depthWrite: false });
      this.materials.set(key, m);
    }
    return m;
  }

  private wispGeo?: PlaneGeometry;

  /** A standing ribbon (x across, z up, bottom edge at 0), shared by every heater */
  private wispGeometry(): PlaneGeometry {
    if (!this.wispGeo) {
      this.wispGeo = new PlaneGeometry(1, 1, 1, 1);
      // plane in x/y → stand it up (x/z), bottom at z = 0
      this.wispGeo.rotateX(Math.PI / 2);
      this.wispGeo.translate(0, 0, 0.5);
    }
    return this.wispGeo;
  }

  /**
   * Heating: thin warm threads of air rise from the heater — real upright ribbons that turn to face the viewer
   * (around the vertical axis only, so they always stand), drawn by a small shader: a soft line that sways
   * and climbs, warm orange at the bottom turning red and fading out above. Only a time value changes per frame.
   */
  private heatWisps(g: Group, width: number, top: number, fx: FurnitureFx) {
    const n = Math.max(2, Math.min(7, Math.round(width / 26)));
    const tint = this.color(fx.color);
    const c0 = new Color(1, 0.6, 0.36).lerp(tint, 0.08);
    const c1 = new Color(0.94, 0.27, 0.2).lerp(tint, 0.08);
    const mats: ShaderMaterial[] = [];
    const ribbons: Mesh[] = [];
    for (let i = 0; i < n; i++) {
      const m = new ShaderMaterial({
        uniforms: { t: { value: 0 }, ph: { value: (i * 0.618) % 1 }, sp: { value: 0.8 + ((i * 37) % 7) / 16 }, op: { value: 0.5 + 0.35 * fx.level }, c0: { value: c0 }, c1: { value: c1 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float t; uniform float ph; uniform float sp; uniform float op; uniform vec3 c0; uniform vec3 c1;
          varying vec2 vUv;
          void main() {
            float y = vUv.y;
            float tt = t * sp + ph * 7.0;
            // a fine thread that sways more the higher it gets; two slow waves climb at different speeds
            float sway = (sin(y * 6.0 - tt * 1.5) * 0.17 + sin(y * 13.0 - tt * 2.3 + ph * 4.0) * 0.05) * (0.2 + 0.8 * y);
            float d = abs(vUv.x - 0.5 - sway);
            float w = mix(0.085, 0.04, y);
            float core = (1.0 - smoothstep(w * 0.3, w, d)) * 0.8;
            float haze = (1.0 - smoothstep(0.0, 0.3, d)) * 0.16;
            // warm air comes in soft puffs that climb
            float puff = 0.55 + 0.45 * sin(y * 4.0 - tt * 1.8);
            float fade = smoothstep(0.0, 0.2, y) * (1.0 - smoothstep(0.42, 1.0, y));
            float a = (core + haze) * puff * fade * op;
            if (a < 0.004) discard;
            gl_FragColor = vec4(mix(c0, c1, smoothstep(0.1, 0.8, y)), a);
          }`,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const r = new Mesh(this.wispGeometry(), m);
      r.raycast = () => {};
      r.renderOrder = 5;
      r.frustumCulled = false;
      const x = (n === 1 ? 0 : i / (n - 1) - 0.5) * width * 0.8;
      const h = 52 + ((i * 37) % 5) * 5;
      r.scale.set(18, 1, h);
      r.position.set(x, 0, top + 1);
      g.add(r);
      mats.push(m);
      ribbons.push(r);
    }
    g.userData.anim = (now: number) => {
      // face the viewer: turn about z only (the view spins the plan; the piece has its own rotation)
      const face = -((this.view?.spin ?? 0) * Math.PI) / 180 - g.rotation.z;
      for (const r of ribbons) r.rotation.z = face;
      const t = now / 1000;
      for (const m of mats) m.uniforms.t.value = t;
      // calm motion: 25 frames/s, 10 on an unattended tablet
      return idleFor() > UNATTENDED ? 100 : 40;
    };
  }

  private ringTex?: Texture;

  /** Ring around a switched-on appliance (static: no animation, no extra frames) */
  private shimmerMaterial(fx: FurnitureFx): Material {
    const key = `ring|${fx.color}`;
    let m = this.materials.get(key);
    if (!m) {
      if (!this.ringTex) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const ctx = c.getContext('2d')!;
        const gr = ctx.createRadialGradient(64, 64, 30, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,255,255,0)');
        gr.addColorStop(0.62, 'rgba(255,255,255,0.7)');
        gr.addColorStop(0.75, 'rgba(255,255,255,0.25)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, 128, 128);
        this.ringTex = new CanvasTexture(c);
      }
      m = new MeshBasicMaterial({ map: this.ringTex, color: this.color(fx.color), transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide });
      this.materials.set(key, m);
    }
    return m;
  }

  /** The piece's 2D drawing as texture on a top face (rugs, beds, cooktops, fan blades, ...) */
  private topMaterial(f: FurnitureConfig, p: Part, fallback: Material, clear: boolean): Material {
    const r = resolveFurniture(f);
    const key = `tex|${f.kind}|${r.variant}|${f.w}|${f.h}|${r.count}|${r.color}|${r.accent}|${r.flip}|${p.x},${p.y},${p.w},${p.d}|${clear}`;
    const mkey = `m|${key}`;
    const ready = this.materials.get(mkey);
    if (ready) return ready;
    const mat = clear
      ? new MeshBasicMaterial({ transparent: true, opacity: 0, side: DoubleSide, depthWrite: false })
      : new MeshLambertMaterial({ color: (fallback as MeshLambertMaterial).color?.clone() ?? new Color(1, 1, 1) });
    this.materials.set(mkey, mat);
    let tex = this.textures.get(key);
    if (!tex) {
      tex = this.rasterize(f, p);
      this.textures.set(key, tex);
    }
    Promise.resolve(tex).then((t) => {
      if (!t || this.destroyed) return;
      (mat as MeshLambertMaterial).map = t;
      if (clear) {
        mat.opacity = 1;
        mat.alphaTest = 0.05;
      } else (mat as MeshLambertMaterial).color.set(0xffffff);
      mat.needsUpdate = true;
      this.requestRender();
    });
    return mat;
  }

  private async rasterize(f: FurnitureConfig, p: Part): Promise<Texture | undefined> {
    // render the SVG drawing in the plan's style context, inline the resolved colors, then rasterize
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    this.probe.parentNode!.appendChild(holder);
    const vb = `${p.x - p.w / 2} ${p.y - p.d / 2} ${p.w} ${p.d}`;
    render(svg`<svg xmlns="http://www.w3.org/2000/svg" viewBox=${vb} width="256" height=${Math.round((256 * p.d) / p.w)} preserveAspectRatio="none">${drawFurniture(f)}</svg>`, holder);
    const el = holder.querySelector('svg')!;
    for (const node of el.querySelectorAll('*')) {
      const cs = getComputedStyle(node);
      const st = (node as SVGElement).style;
      st.fill = cs.fill;
      st.stroke = cs.stroke;
      st.strokeWidth = cs.strokeWidth;
      st.opacity = cs.opacity;
      st.fillOpacity = cs.fillOpacity;
    }
    const text = new XMLSerializer().serializeToString(el);
    holder.remove();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return undefined;
    }
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = Math.max(8, Math.round((256 * p.d) / p.w));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = 4;
    return t;
  }

  // ---------- interaction ----------

  /** Furniture id under a viewport point (px) */
  pick(x: number, y: number, accept: (id: string) => boolean = () => true): string | undefined {
    if (!this.view) return undefined;
    const ray = this.rayAt(x, y);
    this.raycaster.camera = this.camera;
    this.raycaster.ray.copy(ray);
    // walls take part, so a piece behind an opaque wall cannot be tapped through it
    const hits = this.raycaster.intersectObjects([this.walls, this.furniture, this.petGroup], true);
    for (const h of hits) {
      let o: Object3D | null = h.object;
      if ((o as Sprite).isSprite || !visibleChain(o)) continue;
      let inWalls = false;
      for (let p: Object3D | null = o; p; p = p.parent) if (p === this.walls) inWalls = true;
      if (inWalls) {
        const mats = Array.isArray((o as Mesh).material) ? ((o as Mesh).material as Material[]) : [(o as Mesh).material as Material];
        if (mats.every((m) => !m.transparent || m.opacity >= 0.9)) return undefined;
        continue;
      }
      const ranges = o.userData.ranges as { end: number; id?: string }[] | undefined;
      if (ranges && h.face) {
        const v = h.face.a;
        const id = ranges.find((r) => v < r.end)?.id;
        if (id && accept(id)) return id;
        if (id) return undefined; // an untappable piece (e.g. not accepted) is still in front
        continue;
      }
      while (o && !o.userData.id) o = o.parent;
      if (o && accept(o.userData.id)) return o.userData.id;
      if (o) return undefined; // nearest piece is in front: nothing behind it reacts
    }
    return undefined;
  }

  private rayAt(x: number, y: number): Ray {
    const v = this.view!;
    const ndc = (z: number) => new Vector4((2 * x) / v.width - 1, 1 - (2 * y) / v.height, z, 1).applyMatrix4(this.camera.projectionMatrixInverse);
    const a = ndc(-1);
    const b = ndc(1);
    // back to root space is plan space mirrored on y — the projection already contains the mirror,
    // so these points are in three's world space
    const pa = new Vector3(a.x / a.w, a.y / a.w, a.z / a.w);
    const pb = new Vector3(b.x / b.w, b.y / b.w, b.z / b.w);
    return new Ray(pa, pb.sub(pa).normalize());
  }

  /** Screen rectangle (viewport px) of a piece — for tests and framing */
  screenRect(id: string): { x: number; y: number; w: number; h: number } | undefined {
    const g = this.furniture.children.find((c) => c.userData.id === id);
    if (!this.view) return undefined;
    if (!g) {
      // merged into a batch: project its stored bounds
      const b = this.pieceBoxes.get(id);
      if (!b) return undefined;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
        const p = new Vector4(cx, cy, cz, 1).applyMatrix4(this.camera.projectionMatrix);
        const sx = ((p.x / p.w + 1) / 2) * this.view.width;
        const sy = ((1 - p.y / p.w) / 2) * this.view.height;
        x0 = Math.min(x0, sx);
        y0 = Math.min(y0, sy);
        x1 = Math.max(x1, sx);
        y1 = Math.max(y1, sy);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    g.updateWorldMatrix(true, true);
    g.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        const p = new Vector4(cx, cy, cz, 1).applyMatrix4(m.matrixWorld).applyMatrix4(this.camera.projectionMatrix);
        const sx = ((p.x / p.w + 1) / 2) * this.view!.width;
        const sy = ((1 - p.y / p.w) / 2) * this.view!.height;
        x0 = Math.min(x0, sx);
        y0 = Math.min(y0, sy);
        x1 = Math.max(x1, sx);
        y1 = Math.max(y1, sy);
      }
    });
    return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
  }

  /** Debug/test info about a piece */
  info(id: string) {
    const g = this.furniture.children.find((c) => c.userData.id === id);
    if (!g) return undefined;
    let emissive = 0;
    g.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && (Array.isArray(m.material) ? m.material : [m.material]).some((x) => (x as MeshBasicMaterial).isMeshBasicMaterial && (x as MeshBasicMaterial).opacity > 0)) emissive++;
    });
    return { visible: g.visible, fx: (g.userData.fx as FurnitureFx | undefined)?.kind, emissive, spinning: this.spinning.some((s) => s.parent === g), z: g.children.reduce((m, c) => Math.min(m, c.position.z), Infinity) };
  }

  /** Graphics chip name (if the browser reveals it) */
  gpuName(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  stats() {
    let meshes = 0;
    this.root.traverse((o) => ((o as Mesh).isMesh ? meshes++ : 0));
    return { meshes, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, pulsing: this.pulsing.length };
  }

  // ---------- render loop (on demand) ----------

  /** A tapped lamp bounces once */
  bounce(id: string) {
    this.bounces.set(id, performance.now());
    this.requestRender();
  }

  requestRender() {
    this.dirty = true;
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Something other than a running animation asked for a frame */
  private dirty = true;
  private lastRender = 0;

  /** Next frame for running animations only (eco: they step at ~25 frames/s) */
  private loopRender() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    if (!this.view) return;
    // a loop frame asked for before a popup covered the plan: the loop rests until it is uncovered
    if (!this.dirty && this.covered) return;
    if (!this.dirty && now < this.waitUntil) return this.loopRender();
    if (!this.dirty) this.adaptRatio(now);
    this.dueAt = 0;
    if (!this.dirty && this.profile === 'eco' && now - this.lastRender < 38) return this.loopRender();
    this.dirty = false;
    this.lastRender = now;
    let again = false;
    // wall lowering
    this.anims = this.anims.filter((a) => {
      const k = Math.min(1, (now - a.t0) / a.dur);
      const e = a.linear ? k : k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const v = a.from + (a.to - a.from) * e;
      if (a.apply) a.apply(v);
      else a.obj.scale.z = v;
      if (k < 1) again = true;
      return k < 1;
    });
    const loops = this.profile !== 'eco';
    // floor light layer cross-fade
    if (this.fades.length) {
      this.fades = this.fades.filter((f) => {
        const k = Math.min(1, (now - f.t0) / f.dur);
        const e = k * k * (3 - 2 * k);
        (f.mesh.material as MeshBasicMaterial).opacity = f.from + (f.to - f.from) * e;
        if (k < 1) {
          again = true;
          return true;
        }
        if (f.dispose) {
          (f.mesh.material as MeshBasicMaterial).map?.dispose();
          (f.mesh.material as MeshBasicMaterial).dispose();
          f.mesh.removeFromParent();
        }
        return false;
      });
    }
    // Hausregeln pulses
    if (this.pulses.length) {
      this.pulses = this.pulses.filter((pl) => {
        const k = (now - pl.t0) / 1300;
        if (k >= 1) {
          pl.mesh.removeFromParent();
          if (!this.pulses.some((o) => o !== pl && o.mesh.material === pl.mesh.material && (now - o.t0) / 1300 < 1)) (pl.mesh.material as Material).dispose();
          return false;
        }
        const e = 1 - (1 - k) * (1 - k);
        const sc = 18 + e * 80;
        pl.mesh.scale.set(sc, sc, 1);
        (pl.mesh.material as MeshBasicMaterial).opacity = (1 - k) ** 1.4;
        again = true;
        return true;
      });
    }
    // looping animations run on the animation clock (it stands still under a popup)
    const at = this.animNow();
    // air through open windows
    if (this.windTex.length) {
      const dt = Math.min(0.25, (at - (this.lastWind || at)) / 1000);
      this.lastWind = at;
      const k = 0.5 + Math.min(1.2, this.windSpeed / 12);
      for (const w of this.windTex) w.tex.offset.x -= dt * w.speed * k;
    }
    // living pieces (heat streams, pets, mower, charging …): each piece animates itself and says when it
    // needs its next frame (true = right away; a number = in that many ms — calm animations step slower)
    // air through windows: 30 frames/s while somebody uses the card, 15 on an unattended tablet
    let nextIn = this.windTex.length ? (idleFor() > UNATTENDED ? 66 : 33) : Infinity;
    for (const g of this.petGroup.children) {
      const anim = g.userData.anim as ((now: number) => boolean | number) | undefined;
      if (!anim) continue;
      const r = anim(at);
      if (r === true) again = true;
      else if (typeof r === 'number') nextIn = Math.min(nextIn, r);
    }
    for (const g of this.furniture.children) {
      const anim = g.userData.anim as ((now: number) => boolean | number) | undefined;
      if (!anim || !g.visible) continue;
      const r = anim(at);
      if (r === true) again = true;
      else if (typeof r === 'number') nextIn = Math.min(nextIn, r);
    }
    // running fans: turn by time, 30 frames/s (15 on an unattended tablet)
    if (loops && this.spinning.length) {
      const dt = Math.min(0.25, (at - (this.lastSpin || at)) / 1000);
      this.lastSpin = at;
      for (const s of this.spinning) s.rotation.z += dt * 10.8;
      nextIn = Math.min(nextIn, idleFor() > UNATTENDED ? 66 : 33);
    } else this.lastSpin = 0;
    // a tapped lamp bounces once (a small scale pop, nothing else)
    for (const [id, t0] of this.bounces) {
      const k = (now - t0) / BOUNCE_MS;
      const g = this.furniture.children.find((c) => c.userData.id === id);
      if (!g || k >= 1) {
        this.bounces.delete(id);
        g?.scale.set(1, 1, 1);
        continue;
      }
      const s = 1 + BOUNCE_SCALE * Math.sin(k * Math.PI);
      g.scale.set(s, s, s);
      again = true;
    }
    // front door alarm: windows pulse
    if (this.pulsing.length) {
      // eco: steady red instead of pulsing
      const o = loops ? 0.35 + 0.65 * (0.5 + 0.5 * Math.cos((now / 1200) * Math.PI * 2)) : 0.9;
      for (const m of this.pulsing) m.opacity = o;
      if (loops) again = true;
    }
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.renders++;
    this.lastFrameMs = performance.now() - t0;
    this.frameCount++;
    if (now - this.frameT0 >= 1000) {
      this.fps = (this.frameCount * 1000) / (now - this.frameT0);
      this.frameCount = 0;
      this.frameT0 = now;
    }
    // transitions (walls lowering, fades, alarm rings) keep the full frame rate; loops may step slower
    clearTimeout(this.animTimer);
    const transitions = this.anims.length || this.fades.length || this.pulses.length || this.bounces.size;
    // under a popup only transitions finish; the loops go on once the plan is uncovered
    if (this.covered && !transitions) return;
    if (again) {
      if (transitions) this.requestRender();
      else {
        this.dueAt = now + 1000 / 60;
        this.loopRender();
      }
    } else if (nextIn <= 70) {
      this.dueAt = now + nextIn;
      // short steps stay on the display's beat (every 2nd / 4th refresh): even motion instead of timer jitter;
      // a timer wakes up about a refresh early, so the refreshes in between pass without waking the page
      this.waitUntil = now + nextIn - 6;
      if (nextIn > 30) this.animTimer = window.setTimeout(() => this.loopRender(), nextIn - 22);
      else this.loopRender();
    } else if (nextIn < Infinity) this.animTimer = window.setTimeout(() => this.loopRender(), Math.max(0, nextIn - 8));
  }
  private waitUntil = 0;
  /** frames drawn so far (diagnostics) */
  renders = 0;
  private lastSpin = 0;
  private animTimer?: number;

  private animate(obj: Object3D, to: number, dur: number) {
    this.anims.push({ obj, from: obj.scale.z, to, t0: performance.now(), dur });
    this.requestRender();
  }

  private clear(g: Group) {
    if (g === this.walls) this.pulsing = [];
    for (const c of [...g.children]) {
      g.remove(c);
      this.release(c);
    }
    this.anims = this.anims.filter((a) => {
      let o: Object3D | null = a.obj;
      while (o && o !== g) o = o.parent;
      return !o && a.obj.parent !== null;
    });
    if (g === this.walls) {
      for (const geo of this.wallGeos) geo.dispose();
      this.wallGeos = [];
    }
  }

  dispose() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.animTimer);
    this.clear(this.walls);
    this.dropFurnitureCache();
    if (this.current) this.disposeFurn(this.current);
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) if (t instanceof Texture) t.dispose();
    this.halo?.dispose();
    this.renderer.dispose();
    this.probe.remove();
  }
}

/** Colour rounded to 32 steps per channel (sRGB): lamps dimming and changing colour all day reuse a
 * handful of materials instead of creating new ones forever */
function quantize(c: Color): Color {
  const hsl = c.getHex(SRGBColorSpace);
  const q = (v: number) => Math.min(255, Math.round(v / 8) * 8);
  const out = new Color();
  out.setRGB(q((hsl >> 16) & 255) / 255, q((hsl >> 8) & 255) / 255, q(hsl & 255) / 255, SRGBColorSpace);
  return out;
}

/** View direction bucket of a map rotation (0 / 90 / 180 / 270) — per bucket the admin may fix the label spot */
export function labelBucket(spin: number): string {
  return String((((Math.round(spin / 90) * 90) % 360) + 360) % 360);
}

function visibleChain(o: Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Vertices [start, start + count) of a non-indexed geometry as its own geometry (position, normal, uv) */
function subGeometry(src: BufferGeometry, start: number, count: number): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.attributes[name];
    if (!a) continue;
    const arr = (a.array as Float32Array).slice(start * a.itemSize, (start + count) * a.itemSize);
    out.setAttribute(name, new (a.constructor as any)(arr, a.itemSize));
  }
  return out;
}

/** A box with rounded vertical edges (extruded rounded rectangle), bottom at z = 0 */
function roundedBox(w: number, d: number, h: number, r: number): BufferGeometry {
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const bevel = Math.min(r * 0.35, h * 0.2, 1.2);
  const geo = new ExtrudeGeometry(s, { depth: Math.max(0.1, h - bevel * 2), bevelEnabled: bevel > 0.15, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 6 });
  geo.translate(0, 0, bevel > 0.15 ? bevel : 0);
  // cap UVs normalized to the footprint (for drawings on the top)
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + d / 2) / d);
  uv.needsUpdate = true;
  return geo;
}

type Run = { kind: 'part'; part: Part } | { kind: 'lathe'; part: Part; profile: [number, number][]; z0: number; z1: number };

/** Consecutive turned slices (same axis and color) become one lathe body */
function mergeTurned(parts: Part[]): Run[] {
  const out: Run[] = [];
  let cur: { part: Part; profile: [number, number][]; z0: number; z1: number } | undefined;
  const flush = () => {
    if (cur) out.push({ kind: 'lathe', ...cur });
    cur = undefined;
  };
  for (const p of parts) {
    const turned = p.cyl && (p.shade || p.sphere) && !p.topSvg && !p.clear && !p.glass;
    if (!turned) {
      flush();
      out.push({ kind: 'part', part: p });
      continue;
    }
    const same = cur && cur.part.x === p.x && cur.part.y === p.y && cur.part.color === p.color && !!cur.part.emit === !!p.emit && Math.abs(cur.z1 - p.z) < 0.05;
    if (!same) {
      flush();
      cur = { part: p, profile: [[0, p.z], [p.w / 2, p.z]], z0: p.z, z1: p.z };
    }
    // radius at the slice middle; close the top at the end
    const mz = p.z + p.h / 2;
    cur!.profile.push([p.w / 2, mz]);
    cur!.z1 = p.z + p.h;
  }
  flush();
  // close each lathe at its top
  for (const r of out) if (r.kind === 'lathe') {
    const last = r.profile[r.profile.length - 1];
    r.profile.push([last[0], r.z1], [0, r.z1]);
  }
  return out;
}

export { tone };


const round1 = (v: number) => Math.round(v * 10) / 10;

/** Back-and-forth lanes over a polygon (mowing pattern), lane distance `gap` (plan cm) */
function mowLanes(poly: Point[], gap: number): Point[] {
  const ys = poly.map((p) => p[1]);
  const out: Point[] = [];
  let flip = false;
  for (let y = Math.min(...ys) + gap / 2; y < Math.max(...ys) - gap / 4; y += gap) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const x0 = xs[0] + 25;
    const x1 = xs[xs.length - 1] - 25;
    if (x1 <= x0) continue;
    out.push(flip ? [x1, y] : [x0, y], flip ? [x0, y] : [x1, y]);
    flip = !flip;
  }
  return out;
}

function circle(c: Point, r: number): Point[] {
  return Array.from({ length: 16 }, (_, i) => [c[0] + Math.cos((i / 16) * Math.PI * 2) * r, c[1] + Math.sin((i / 16) * Math.PI * 2) * r] as Point);
}
