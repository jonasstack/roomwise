import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { guard } from 'lit/directives/guard.js';
import { styleMap } from 'lit/directives/style-map.js';
import { components } from '../design/components';
import type { Bounds, DeviceConfig, FloorConfig, FurnitureConfig, HassEntity, HitTarget, HomeAssistant, Point, RoomConfig, TraceImage, ViewTransform } from '../types';
import { PanZoom, type GestureHandlers } from '../pan-zoom';
import { boundsOf, buildingBounds, closestPointOnSegment, floorBounds, pointInPolygon, pointsToPath, polylabel, round } from '../geometry';
import { areaLights, domainOf, entityName, formatState, isActive, isUnavailable, stateIcon, stateStyle } from '../ha';
import { formatNumber, getLanguage, t } from '../i18n';
import { drawFurniture, fridgeList, furnitureLabel, furnitureLayer, resolveFurniture, type PieceLive } from '../furniture';
import { reducedMotion, spatialNext } from '../a11y';
import { floorPattern } from '../floors';
import { coverLive, coverLiveSig, drawOpening, openingMaskLines, openingState } from '../openings';
import { furnitureBaseHeight, paint, renderFurniture3d, renderSun, renderWalls3d, renderWind } from '../plan3d';
import { furnitureFx, renderFurnitureFx, stairsLit } from '../furniture-fx';
import { isWeakDevice, type SunInfo } from '../ambient';
import { reloadForChunk } from '../assets';
import type { GlScene } from '../gl/scene';
import { shaderPrecision } from '../gl/weather';
import { FLOOR_DYNAMIC, FLOOR_STATIC, layerSignature, rasterizeFloor, type Region } from '../gl/floor-raster';
import { windowInward } from '../walls';
import { isActive as isActiveView, markActive } from '../activity';
import { frontDoor as findFrontDoor, wayToDoor, type PetState } from '../pets';
import { buildNav } from '../petnav';
import { carLive, liveClass, numOf } from '../models';
import { hasMediaControls } from '../media-controls';
import { resolveAction } from '../actions';

/** Does a tap on the piece do something (an entity, or own media buttons of a pure infrared device)? */
const linked = (f: FurnitureConfig) => !!f.entity || hasMediaControls(f.media) || !!f.contents?.length;
import { carOpen, carOpenSig } from '../car-info';
import { APPLIANCE_KINDS, applianceStatus, applianceWatch } from '../appliance';

// Animatable custom properties for the 2D <-> 3D transition (must be registered on the document).
for (const [name, syntax, initialValue] of [
  ['--fp-tilt', '<angle>', '0deg'],
  ['--fp-lift', '<length>', '0px'],
  ['--fp-walls', '<number>', '0'],
  ['--fp-spin', '<angle>', '0deg'],
] as const) {
  try {
    (CSS as any).registerProperty({ name, syntax, inherits: true, initialValue });
  } catch {
    /* already registered or unsupported: falls back to an instant switch */
  }
}

export const TILT_3D = 48;
export const TILT_PORTRAIT = 34;

export type StateGetter = (entityId: string) => HassEntity | undefined;

/** A Hausregeln rule on the plan (ids of plan rooms, entity ids for devices) */
export interface HrMarks {
  devices: { id: string; color: string }[];
  rooms: { id: string; color: string }[];
  lines: { from: string; to: string; color: string }[];
}

export interface RoomStatus {
  lightsOn: number;
  lights: number;
  level: number; // 0..1 glow strength
}

/**
 * Renders one floor: rooms (SVG), light glow, labels and device markers (HTML overlays that keep a
 * constant screen size). Owns pan/zoom; emits gestures through `handlers`.
 */
/** Probe offsets (px) around a tap for the slightly enlarged hit area of linked devices */
/** auto view: zoom factors (× fit) for 3D → 2D and back */
/** Camera transitions (tilt, spin, 2D↔3D): duration and the token easing cubic-bezier(0.4, 0, 0.2, 1) */
const CAM_MS = 250;
function easeInOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // solve the bezier's x(t) = x (Newton), return y(t)
  const ax = 3 * 0.4 - 3 * 0.2 + 1, bx = -6 * 0.4 + 3 * 0.2, cx = 3 * 0.4;
  let t = x;
  for (let i = 0; i < 6; i++) {
    const f = ((ax * t + bx) * t + cx) * t - x;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= f / d;
  }
  t = Math.min(1, Math.max(0, t));
  const ay = 3 * 0 - 3 * 1 + 1, by = -6 * 0 + 3 * 1, cy = 0;
  return ((ay * t + by) * t + cy) * t;
}

/** Room view: space kept free at the top for the room's label */
const BADGE_SPACE = 84;


/** WebGL available in this browser (checked once, without loading three.js) */
let GL_OK: boolean | undefined;
/** Waits before loading the 3D scene again after it failed (ms) */
const GL_RETRY = [10000, 30000, 120000, 600000];
let glFails = 0;
/** Why the 3D view fell back to CSS 3D (shown in the performance overlay) */
let GL_WHY: 'chunk' | 'chunk-reload' | 'context' | undefined;
/** WebGL contexts that could not be created in a row */
let GL_FAILS = 0;
function webglSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') as WebGLRenderingContext | null) ?? c.getContext('webgl');
    // give the probe's context back at once: browsers keep only a few live contexts per page (Firefox drops the
    // oldest – which can be the 3D scene's own, leaving the CSS 3D view) and collect unused canvases late
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** The WebGL scene (three.js) is a chunk of its own, loaded once a 3D view needs it: 2D (the start on weak
 *  devices) never parses it */
let glScene: Promise<typeof GlScene> | undefined;
let GlSceneClass: typeof GlScene | undefined;
const loadGlScene = () => (glScene ??= import('../gl/scene').then((m) => (GlSceneClass = m.GlScene)));

const NEAR: [number, number][] = [[9, 0], [-9, 0], [0, 9], [0, -9], [7, 7], [-7, 7], [7, -7], [-7, -7]];

/** A focusable item of the plan (keyboard, screen readers) and where it sits (plan units) */
interface KbSpot {
  kind: 'room' | 'device' | 'furniture' | 'opening';
  id: string;
  x: number;
  y: number;
}

/** A floor of the house stacked above or below the shown one (see FpPlan.stack) */
export interface StackFloor {
  floor: FloorConfig;
  /** cm above (+) or below (−) the shown floor */
  dz: number;
  bright?: boolean;
  severe?: boolean;
  mark?: Point;
  /** the label at the mark ("Waschmaschine fertig"), and the piece it is about – a tap there goes to that floor */
  text?: string;
  piece?: string;
}

/** Floors between (1 for a neighbour, at most 2) from a stack lift */
const stackSteps = (dz: number) => Math.sign(dz) * Math.min(2, Math.max(1, Math.round(Math.abs(dz) / 400)));

export class FpPlan extends LitElement {
  static override properties = {
    hass: { attribute: false },
    floor: { attribute: false },
    below: { attribute: false },
    belowMode: { type: String },
    insetRight: { type: Number },
    insetTop: { type: Number },
    insetBottom: { type: Number },
    stack: { attribute: false },
    stackPlain: { type: Boolean },
    frameBounds: { attribute: false },
    stairs: { attribute: false },
    stairsBelow: { attribute: false },
    getState: { attribute: false },
    handlers: { attribute: false },
    wallWidth: { type: Number },
    editing: { type: Boolean, reflect: true },
    showGrid: { type: Boolean },
    grid: { type: Number },
    selected: { attribute: false },
    overlaySvg: { attribute: false },
    liveVacuums: { type: Boolean },
    overlayHtml: { attribute: false },
    fitBounds: { attribute: false },
    tick: { type: Number },
    viewMode: { type: String },
    wallHeight: { type: Number },
    sun: { attribute: false },
    night: { type: Number },
    alertWindows: { attribute: false },
    renderer: { type: String },
    perf: { type: String },
    covered: { type: Boolean, reflect: true },
    stats: { type: Boolean },
    portrait: { type: Boolean },
    effects: { type: Boolean },
    windSpeed: { type: Number },
    defaultSpin: { type: Number },
    wallColor: { type: String },
    labelMode: { type: String },
    threeD: { type: Boolean },
    fullWalls: { type: Boolean },
    roomHeight: { type: Number },
    backWallHeight: { type: Number },
    _tiltUser: { state: true },
    hideLabels: { type: Boolean },
    hideLabelsOnMove: { type: Boolean },
    focusBadge: { type: Boolean },
    labelTap: { type: Boolean },
    labelStyle: { type: String },
    _wallLabeled: { state: true },
    pets: { attribute: false },
    frontDoor: { type: String },
    hrOccupied: { attribute: false },
    hrMarks: { attribute: false },
    hrAlarmCause: { type: String },
    trace: { attribute: false },
    _pulses: { state: true },
    _badge: { state: true },
    _spin: { state: true },
    _spinning: { state: true },
    _focusId: { state: true },
    _pressed: { state: true },
    _kbFocus: { state: true },
    _zoomedIn: { state: true },
    _small: { state: true },
  };

  declare hass: HomeAssistant;
  declare floor?: FloorConfig;
  /** A trace image of the floor (picture + placement): editor above the room fills (below walls), card below the rooms */
  declare trace?: { t: TraceImage; href: string };
  /** The floor below (upper floors): 'outline' = faint footprint for context (card, 2D + 3D floor texture),
   * 'ghost' = dashed walls over everything (editor, to line up the walls) */
  declare below?: FloorConfig;
  declare belowMode?: 'outline' | 'ghost';
  /** px on the right the fitted building stays clear of (floor slider) */
  declare insetRight?: number;
  /** px at the top kept clear of the building (a panel over the plan) */
  declare insetTop?: number;
  /** px at the bottom kept clear of the building (another floor peeking in below) */
  declare insetBottom?: number;
  /** The other floors stacked above (dz > 0) and below (dz < 0) the shown one: faint, floors and walls only (3D in the
   * scene, 2D as offset outlines). `bright`: something worth telling there, with a mark at `mark`. */
  declare stack?: StackFloor[];
  /** the stack in 3D with plates only (eco) */
  declare stackPlain?: boolean;
  /** Framed together with the floor's building (several floors: all of them, so every floor sits at the same
   * place and size and the floors stack exactly when switching) */
  declare frameBounds?: Bounds;
  /** Stairs that lead to another floor: piece id → where (chip "↑ Obergeschoss", tap target) */
  declare stairs?: Map<string, { up: boolean; name: string; to?: string }>;
  /** Stairs on the floor below that lead up to this one: drawn here as a faint stairwell (2D and the 3D floor) */
  declare stairsBelow?: { pieces: FurnitureConfig[]; to: string; name: string };
  declare getState: StateGetter;
  declare handlers?: Partial<GestureHandlers>;
  declare wallWidth: number;
  declare editing: boolean;
  declare showGrid: boolean;
  declare grid: number;
  declare selected?: HitTarget;
  declare overlaySvg?: TemplateResult | typeof nothing;
  /** the companion integration reports where the vacuums are */
  declare liveVacuums?: boolean;
  declare overlayHtml?: TemplateResult | typeof nothing;
  /** Optional bounds override (editor uses a larger canvas). */
  declare fitBounds?: Bounds;
  /** Bumped by the host when optimistic state changes without a new hass object. */
  declare tick: number;
  declare _pressed?: HitTarget | null;
  /** Keyboard: the item that has the focus (its ring is drawn) and the one Tab comes back to */
  declare _kbFocus?: string;
  private kbHome?: string;
  private kbGeo?: { floor: FloorConfig; editing: boolean; items: KbSpot[] };
  /** auto: 3D overview that flattens when zooming in; 2d / 3d forced */
  declare viewMode: 'auto' | '2d' | '3d';
  declare wallHeight: number;
  declare sun?: SunInfo;
  /** 0 day … 1 night: unlit rooms cool down, lit rooms shine out of their windows */
  declare night?: number;
  /** Front door warning: these windows blink red */
  declare alertWindows?: Set<string>;
  /** 'auto' (WebGL when available), 'webgl' or 'css' */
  declare renderer?: 'auto' | 'webgl' | 'css';
  /** 3D quality profile */
  declare perf?: 'high' | 'eco';
  /** A popup, sheet or the editor covers the plan: looping animations rest (warnings keep blinking) */
  declare covered?: boolean;
  /** Show the performance overlay */
  declare stats?: boolean;

  // ---------- WebGL ----------
  private gl?: GlScene;
  private pendingGl?: { floor: FloorConfig; key: string; opts: Record<string, any> };
  private glWallsKey = '';
  private glFurnKey = '';
  private glLight = '';
  private glFloorRef?: FloorConfig;
  private glFxSig = new Map<string, string>();
  private glTheme = '';
  private glCenter: Point = [0, 0];
  private glResize?: ResizeObserver;

  /** Card 3D with WebGL: the floor is drawn by WebGL too (the SVG floor stays hidden for hit geometry/tests) */
  get glFloor(): boolean {
    return !!this.gl && this.is3d && !this.editing;
  }

  // ---------- WebGL floor ----------
  private floorObserver?: MutationObserver;
  private floorDirty = { static: true, dynamic: true };
  private floorTimer?: number;
  private floorBusy = false;
  private floorRegion?: Region;
  private nightSig = '';

  private floorWatch() {
    const svgEl = this.renderRoot.querySelector('svg.plan') as SVGSVGElement | null;
    if (!svgEl || this.floorObserver) return;
    this.floorObserver = new MutationObserver((muts) => {
      if (!this.glFloor) return;
      for (const m of muts) {
        // a whole layer came or went (e.g. occupied rooms, a rule's marks): judge it by its class
        if (m.target === svgEl) {
          for (const n of [...m.addedNodes, ...m.removedNodes]) {
            const cls = ((n as Element).getAttribute?.('class') ?? '').split(/\s+/);
            if (cls.some((c) => FLOOR_STATIC.includes(c))) this.floorDirty.static = true;
            else if (cls.some((c) => FLOOR_DYNAMIC.includes(c))) this.floorDirty.dynamic = true;
          }
          continue;
        }
        let el: Node | null = m.target;
        while (el && el.parentNode !== svgEl) el = el.parentNode;
        const top = el as Element | null;
        if (!top || !(top as Element).getAttribute) continue;
        const cls = (top.getAttribute('class') ?? '').split(/\s+/);
        if (top.tagName === 'defs') {
          // the definition (gradient, pattern, clip) that changed: its id names the layer it belongs to
          const ids: string[] = [];
          let d: Node | null = m.target;
          while (d && d.parentNode !== top) d = d.parentNode;
          if (d && (d as Element).id) ids.push((d as Element).id);
          for (const n of [...m.addedNodes, ...m.removedNodes]) if ((n as Element).id) ids.push((n as Element).id);
          for (const id of ids) {
            if (/^fp-(ffx|spill|glow)/.test(id)) this.floorDirty.dynamic = true;
            else if (/^fp-(floor|beam|clip|wall-mask|grid)/.test(id)) this.floorDirty.static = true;
            else if (/^fp-dark-rooms/.test(id)) continue;
            else this.floorDirty.dynamic = true;
          }
        } else if (cls.some((c) => FLOOR_STATIC.includes(c))) this.floorDirty.static = true;
        else if (cls.some((c) => FLOOR_DYNAMIC.includes(c))) this.floorDirty.dynamic = true;
      }
      this.scheduleFloor();
    });
    this.floorObserver.observe(svgEl, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  private floorSig = { static: '', dynamic: '' };
  private amb = { k: '', color: '' };
  private scheduleFloor(delay = 90) {
    if (!this.floorDirty.static && !this.floorDirty.dynamic) return;
    clearTimeout(this.floorTimer);
    this.floorTimer = window.setTimeout(() => this.rasterFloor(), delay);
  }

  /** Re-rasterize the dirty floor layers into WebGL textures */
  private async rasterFloor() {
    const gl = this.gl;
    const svgEl = this.renderRoot.querySelector('svg.plan') as SVGSVGElement | null;
    if (!gl || !svgEl || !this.glFloor) return;
    if (this.floorBusy) return this.scheduleFloor(120);
    // never in the middle of a gesture or camera flight: right after it
    if (isActiveView()) return this.scheduleFloor(160);
    this.floorBusy = true;
    try {
      // the floor texture covers the home and what is visible around it (up to 7 m of garden)
      const all = floorBounds(this.floor);
      const home = buildingBounds(this.floor);
      // the floor below shows its outline around a smaller upper floor
      if (this.below && this.belowMode === 'outline' && this.below.rooms.length) {
        const lb = buildingBounds(this.below);
        for (const b of [all, home]) {
          b.minX = Math.min(b.minX, lb.minX);
          b.minY = Math.min(b.minY, lb.minY);
          b.maxX = Math.max(b.maxX, lb.maxX);
          b.maxY = Math.max(b.maxY, lb.maxY);
        }
      }
      const m = 240;
      const g = 700;
      const b = { minX: Math.max(all.minX, home.minX - g), minY: Math.max(all.minY, home.minY - g), maxX: Math.min(all.maxX, home.maxX + g), maxY: Math.min(all.maxY, home.maxY + g) };
      const region: Region = { x: b.minX - m, y: b.minY - m, w: b.maxX - b.minX + m * 2, h: b.maxY - b.minY + m * 2 };
      const moved = !this.floorRegion || ['x', 'y', 'w', 'h'].some((k) => Math.abs((this.floorRegion as any)[k] - (region as any)[k]) > 0.5);
      if (moved) this.floorDirty = { static: true, dynamic: true };
      this.floorRegion = region;
      const max = Math.min(gl.renderer.capabilities.maxTextureSize, gl.profileName === 'eco' ? 1536 : 2048);
      const want = { ...this.floorDirty };
      this.floorDirty = { static: false, dynamic: false };
      // unchanged content (e.g. back from the 2D view): keep the texture
      const sigS = want.static ? layerSignature(svgEl, FLOOR_STATIC) : '';
      const sigD = want.dynamic ? layerSignature(svgEl, FLOOR_DYNAMIC) : '';
      if (want.static && !moved && sigS === this.floorSig.static && gl.hasFloorLayer('static')) want.static = false;
      if (want.dynamic && !moved && sigD === this.floorSig.dynamic && gl.hasFloorLayer('dynamic')) want.dynamic = false;
      if (want.static) this.floorSig.static = sigS;
      if (want.dynamic) this.floorSig.dynamic = sigD;
      if (want.static) gl.setFloorLayer('static', await rasterizeFloor(svgEl, region, max, FLOOR_STATIC), region);
      // soft layers: half resolution is plenty
      // soft light layers: a small texture is plenty and keeps toggling lights cheap
      if (want.dynamic) gl.setFloorLayer('dynamic', await rasterizeFloor(svgEl, region, gl.profileName === 'eco' ? 512 : 768, FLOOR_DYNAMIC), region);
      gl.setFloorVisible(this.glFloor);
    } finally {
      this.floorBusy = false;
      if (!this.floorDirty.static && !this.floorDirty.dynamic) this.flushReady();
    }
  }

  private readyWaiters: (() => void)[] = [];
  private flushReady() {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    w.forEach((f) => f());
  }

  /**
   * Resolves once the floor that was just set is on screen — in 3D after its floor texture is drawn (at most
   * `max` ms): the card fades a new floor in only when it is really there.
   */
  async floorReady(max = 420): Promise<void> {
    await this.updateComplete;
    const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    if (!this.glFloor) return frames();
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.readyWaiters.push(fin);
      window.setTimeout(fin, max);
      this.floorDirty.static = true;
      this.scheduleFloor(0);
    });
    return frames();
  }

  /** Night tint of unlit rooms as WebGL multiply layer */
  private updateNightTint() {
    const gl = this.gl;
    if (!gl || !this.floor) return;
    // ambient colour values come from updateGl's style read (no extra style pass per update)
    const k = this.glFloor ? Number(this.amb.k) || 0 : 0;
    // at night unlit rooms and the whole outside darken
    const dark = (this.night ?? 0) > 0.05 ? this.floor.rooms.filter((r) => r.points.length >= 3 && (r.outdoor || !this.roomStatus(r).lightsOn)) : [];
    // outside it gets darker than in an unlit room: the tint is applied twice there
    if (dark.length) dark.push(...dark.filter((r) => r.outdoor));
    const color = this.amb.color.trim() || '#6f7bb0';
    const sig = `${k.toFixed(3)}|${color}|${dark.map((r) => r.id).join(',')}`;
    if (sig === this.nightSig) return;
    this.nightSig = sig;
    gl.setNightTint(dark.map((r) => r.points), color, k);
  }

  /** World point on the floor under a client point (3D) */
  private floorPoint(e: { clientX: number; clientY: number }): Point | undefined {
    const vp = this.renderRoot.querySelector('.viewport') as HTMLElement;
    const r = vp.getBoundingClientRect();
    const z = this.dragZ;
    this.dragZ = 0;
    const p = this.unproject(e.clientX - r.left, e.clientY - r.top);
    this.dragZ = z;
    return p;
  }

  get useGl(): boolean {
    if (GL_OK === undefined) GL_OK = webglSupported();
    return GL_OK && this.renderer !== 'css';
  }

  private initGl() {
    // only once a 3D view wants it (pendingGl): 2D needs neither three.js nor a WebGL context
    if (!this.useGl || this.gl || !this.pendingGl) return;
    const canvas = this.renderRoot.querySelector('canvas.gl') as HTMLCanvasElement | null;
    if (!canvas) return;
    if (!GlSceneClass) {
      loadGlScene().then(
        () => this.isConnected && this.requestUpdate(),
        (err) => {
          // e.g. the card was updated on the server while this page stayed open, or the network dropped:
          // CSS 3D for now, and the page reloads by itself once nobody uses it (the browser keeps the failure)
          console.warn('floorplan-card: 3D scene could not be loaded, using CSS 3D', err);
          glScene = undefined;
          GL_OK = false;
          GL_WHY = reloadForChunk(err, () => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('floorplan-card-editor-ui')) ? 'chunk-reload' : 'chunk';
          this.requestUpdate();
          const wait = GL_RETRY[Math.min(glFails++, GL_RETRY.length - 1)];
          window.setTimeout(() => {
            GL_OK = undefined;
            if (this.isConnected) this.requestUpdate();
          }, wait);
        },
      );
      return;
    }
    try {
      this.gl = new GlSceneClass(canvas, this.renderRoot as ShadowRoot, isWeakDevice());
      GL_FAILS = 0;
    } catch (err) {
      // no WebGL context right now (GPU busy, too many contexts on the page): CSS 3D, and another try a little
      // later instead of giving up on 3D for the life of the page
      console.warn('floorplan-card: WebGL unavailable, using CSS 3D', err);
      GL_OK = false;
      GL_WHY = 'context';
      if (++GL_FAILS < 4)
        window.setTimeout(() => {
          if (GL_WHY !== 'context') return;
          GL_OK = undefined;
          GL_WHY = undefined;
          if (this.isConnected) this.requestUpdate();
        }, 20000 * GL_FAILS);
      this.requestUpdate();
      return;
    }
    const vp = this.renderRoot.querySelector('.viewport') as HTMLElement;
    this.glResize = new ResizeObserver(() => {
      const r = vp.getBoundingClientRect();
      this.vpSize = { w: vp.clientWidth, h: vp.clientHeight };
      this.gl?.setSize(r.width, r.height, window.devicePixelRatio || 1);
      this.syncGl();
    });
    this.glResize.observe(vp);
  }

  /** Camera = the current (JS-animated) projection — no style reads, so moving the view never forces a style pass */
  private syncGl = () => {
    const gl = this.gl;
    const pz = this.panZoom;
    if (!gl || !pz || !this.vpSize.w) return;
    const v = pz.view;
    gl.setView({
      s: v.s,
      tx: v.tx,
      ty: v.ty,
      cx: this.glCenter[0],
      cy: this.glCenter[1],
      persp: this.currentPersp || this.basePersp,
      tilt: this.cam.tilt,
      spin: this.cam.spin,
      width: this.vpSize.w,
      height: this.vpSize.h,
      walls: this.cam.walls,
    });
  };

  /** Viewport size (kept by the resize observer, so the camera never measures layout) */
  private vpSize = { w: 0, h: 0 };

  // ---------- camera animation (tilt, spin, wall growth, label lift) ----------

  /** What the stage shows right now; tweened towards the target in JS (drives labels and the WebGL camera) */
  private cam = { tilt: 0, spin: 0, walls: 0, lift: 0 };
  private camFrom = { tilt: 0, spin: 0, walls: 0, lift: 0 };
  private camTo = { tilt: 0, spin: 0, walls: 0, lift: 0 };
  private camT0 = 0;
  private camAnim = 0;
  private camReady = false;
  private camVars = '';

  private camTarget() {
    const is3d = this.is3d;
    return { tilt: is3d ? this.tilt : 0, spin: this.spin, walls: is3d ? 1 : 0, lift: is3d ? this.wallHeight + 6 : 0 };
  }

  /** Follow the target: instantly while a finger turns the view, else a short eased transition */
  private updateCam() {
    const to = this.camTarget();
    const same = (a: typeof to, b: typeof to) => (Object.keys(a) as (keyof typeof to)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-3);
    // reduced motion: the camera jumps instead of gliding
    if (!this.camReady || this._spinning || this.liveSpin != null || reducedMotion()) {
      this.camReady = true;
      if (this.camAnim) cancelAnimationFrame(this.camAnim);
      this.camAnim = 0;
      this.cam = { ...to };
      this.camTo = { ...to };
      this.applyCam(true);
      this.syncGl();
      return;
    }
    if (!same(to, this.camTo)) {
      this.camFrom = { ...this.cam };
      this.camTo = to;
      this.camT0 = performance.now();
      if (!this.camAnim) this.camAnim = requestAnimationFrame(this.camStep);
    }
    this.applyCam(true);
  }

  private camStep = (now: number) => {
    const k = Math.min(1, (now - this.camT0) / CAM_MS);
    const e = easeInOut(k);
    for (const key of ['tilt', 'spin', 'walls', 'lift'] as const) this.cam[key] = this.camFrom[key] + (this.camTo[key] - this.camFrom[key]) * e;
    markActive(120);
    this.labelsMoving();
    this.applyCam(false);
    this.syncGl();
    this.camAnim = k < 1 ? requestAnimationFrame(this.camStep) : 0;
  };

  /**
   * Write the camera onto both stages: the transform directly (changing it restyles nothing below), the
   * variables only when they changed (labels counter-rotate with them). `force`: after a render that may have
   * replaced the style attribute.
   */
  private applyCam(force: boolean) {
    const c = this.cam;
    const persp = Math.round(this.currentPersp || this.basePersp);
    const tr = `perspective(${persp}px) rotateX(${c.tilt.toFixed(3)}deg) rotateZ(${c.spin.toFixed(3)}deg)`;
    const vars = `${c.tilt.toFixed(3)}|${c.spin.toFixed(3)}|${c.walls.toFixed(4)}|${c.lift.toFixed(2)}`;
    const writeVars = force || vars !== this.camVars;
    this.camVars = vars;
    for (const st of this.renderRoot.querySelectorAll('.stage') as NodeListOf<HTMLElement>) {
      st.style.transform = tr;
      // a render that replaced the style attribute took the variables with it: without them the labels and chips no
      // longer counter-rotate and lie flat on the tilted plan ("pressed flat") until the camera moves – write them again
      if (!writeVars && st.style.getPropertyValue('--fp-tilt')) continue;
      st.style.setProperty('--fp-tilt', `${c.tilt.toFixed(3)}deg`);
      st.style.setProperty('--fp-spin', `${c.spin.toFixed(3)}deg`);
      st.style.setProperty('--fp-walls', c.walls.toFixed(4));
      st.style.setProperty('--fp-lift', `${c.lift.toFixed(2)}px`);
    }
  }

  /** Rebuild the WebGL scene when something it shows changed */
  private interactTimer?: number;
  /** A gesture moves the view: eco renders lower while moving */
  /** Optional: room labels fade out while the view moves and come back once it rests */
  private labelsMoving() {
    if (!this.hideLabelsOnMove || this.editing) return;
    const labels = this.renderRoot.querySelector('.world-top .labels');
    labels?.classList.add('moving');
    clearTimeout(this.labelsTimer);
    this.labelsTimer = window.setTimeout(() => labels?.classList.remove('moving'), 450);
  }

  private markInteracting() {
    markActive();
    this.lastInteract = performance.now();
    this.labelsMoving();
    // the room's label at the top goes away as soon as the view is moved again
    if (this._badge && performance.now() > this.badgeArmed) this._badge = undefined;
    if (!this.gl) return;
    this.gl.setInteracting(true);
    clearTimeout(this.interactTimer);
    this.interactTimer = window.setTimeout(() => this.gl?.setInteracting(false), 220);
  }

  private csCache?: { key: string; t: number; vals: Map<string, string> };

  private updateGl() {
    const gl = this.gl;
    const pg = this.pendingGl;
    if (gl) {
      gl.setProfile(this.perf ?? 'high');
      gl.setCovered(!!this.covered);
    }
    if (!gl || !pg) return;
    // theme colours are read at most every 1.5 s (reading them forces a style pass, and a tap can cause a
    // dozen updates in a row) — unless dark mode / night changed
    const styleKey = `${document.documentElement.classList.contains('dark') || this.closest?.('[dark]') ? 1 : 0}|${this.hass?.themes?.darkMode ? 1 : 0}|${(this.night ?? 0).toFixed(2)}|${this.sun?.up ? 1 : 0}`;
    if (!this.csCache || this.csCache.key !== styleKey || performance.now() - this.csCache.t > 1500) {
      const c = getComputedStyle(this);
      const vals = new Map<string, string>();
      for (const n of ['--fp-wall-side', '--fp-wall-top', '--fp-paint-mix', '--fp-room', '--fp-glass', '--fp-door', '--fp-door-3d', '--fp-state-alert', '--fp-amb-k', '--fp-amb', '--fp-sun-tint', '--fp-shadow-tint'])
        vals.set(n, c.getPropertyValue(n));
      this.csCache = { key: styleKey, t: performance.now(), vals };
    }
    const cs = { getPropertyValue: (n: string) => this.csCache!.vals.get(n) ?? '' };
    // material colours (theme) → everything is rebuilt; light colours / sun → only the lighting changes
    const theme = ['--fp-wall-side', '--fp-wall-top', '--fp-paint-mix', '--fp-room', '--fp-glass', '--fp-door', '--fp-door-3d', '--fp-state-alert']
      .map((n) => cs.getPropertyValue(n))
      .join('|');
    const floorChanged = pg.floor !== this.glFloorRef;
    if (theme !== this.glTheme || floorChanged) {
      if (theme !== this.glTheme) {
        gl.resetColors();
        this.floorSig = { static: '', dynamic: '' };
        this.floorDirty = { static: true, dynamic: true };
        this.scheduleFloor(0);
      }
      this.glTheme = theme;
      this.glFloorRef = pg.floor;
      gl.dropFurnitureCache();
      this.glWallsKey = this.glFurnKey = this.glLight = this.nightSig = '';
    }
    this.amb = { k: cs.getPropertyValue('--fp-amb-k'), color: cs.getPropertyValue('--fp-amb') };
    const sun = this.sun;
    const light = [
      ...['--fp-sun-tint', '--fp-amb', '--fp-amb-k', '--fp-shadow-tint'].map((n) => cs.getPropertyValue(n)),
      sun ? `${sun.up ? 1 : 0}:${round(sun.azimuth, 0)}:${round(sun.elevation, 0)}:${sun.strength.toFixed(2)}` : '',
      (this.night ?? 0).toFixed(2),
    ].join('|');
    if (light !== this.glLight) {
      this.glLight = light;
      gl.setLighting(sun, this.currentBounds(), this.night ?? 0);
    }
    const o = pg.opts;
    const build = this.glBuild(o);
    // walls: view side, heights, room view, door/window states
    const openSig = (pg.floor.openings ?? [])
      .map((op) => {
        if (!op.entity) return '';
        return op.type === 'garage' ? coverLiveSig(this.getState(op.entity)) : openingState(this.getState(op.entity));
      })
      .join(',');
    gl.setWindSpeed(this.windSpeed);
    const wallsKey = [this.effects && !this.editing ? 'w' : '', round(o.spin ?? 0, 1), o.height, o.full ? 1 : 0, o.focus?.id ?? '', o.backHeight ?? '', o.wall, o.wallColor ?? '', o.alert ? [...o.alert].join(',') : '', this.editing ? 1 : 0, openSig].join(';');
    if (wallsKey !== this.glWallsKey) {
      this.glWallsKey = wallsKey;
      gl.buildWalls(pg.floor, build);
    }
    // the other floors of the stack (not while editing or zoomed onto a room)
    gl.setStack(this.editing || o.focus ? [] : (this.stack ?? []), { wall: o.wall, height: o.height, plain: !!this.stackPlain });
    // furniture: one cached scene per view; live states update single pieces
    const fxSig = this.furnSig(pg.floor);
    const furnKey = this.furnKeyFor(o.height, o.focus?.id);
    let prev: Map<string, string> | undefined = this.glFxSig;
    if (furnKey !== this.glFurnKey) {
      this.glFurnKey = furnKey;
      prev = gl.useFurniture(furnKey);
      if (!prev) gl.buildFurniture(pg.floor, build, furnKey, fxSig);
    }
    if (prev) {
      const changed = [...new Set([...fxSig.keys(), ...prev.keys()])].filter((id) => prev!.get(id) !== fxSig.get(id));
      if (changed.length) gl.updatePieces(pg.floor, build, changed);
      gl.setFurnitureSig(fxSig);
    }
    this.glFxSig = fxSig;
    gl.syncPets(pg.floor, build, fxSig);
    gl.syncVacuums(pg.floor, build, !!this.liveVacuums);
    // label style "wall": temperatures engraved into a free wall of each room
    const wallItems =
      this.labelStyle === 'wall' && this.is3d && !this.editing
        ? pg.floor.rooms
            .filter((r) => !r.hide_label && !r.outdoor && r.points.length >= 3)
            .map((r) => ({ room: r, t: this.roomTemp(r) }))
            .filter((x) => x.t != null)
            .map((x) => ({ room: x.room, value: `${formatNumber(x.t!)}°`, sub: x.room.name ?? this.hass?.areas?.[x.room.area ?? '']?.name }))
        : [];
    const placed = gl.setWallLabels(pg.floor, build, wallItems);
    const before = [...(this._wallLabeled ?? [])].sort().join();
    if ([...placed].sort().join() !== before) this._wallLabeled = placed;
    this.syncGl();
    this.schedulePrebuild();
  }

  private glBuild(o: Record<string, any>) {
    return {
      wall: o.wall,
      height: o.height,
      full: o.full,
      focus: o.focus,
      backHeight: o.backHeight,
      alert: o.alert,
      sun: o.sun,
      spin: o.spin ?? 0,
      wallColor: o.wallColor,
      detail: 1.6,
      editing: !!this.editing,
      getState: this.getState,
      carOpen: (f: FurnitureConfig) => this.pieceLive(f)?.car,
      wind: !!this.effects && !this.editing,
      rooms: this.floor?.rooms ?? [],
      all: this.floor?.furniture ?? [],
      stairsDown: this.stairs ? new Set([...this.stairs].filter(([, v]) => !v.up).map(([k]) => k)) : undefined,
      stairsTo: this.stairs ? new Map([...this.stairs].map(([k, v]) => [k, v.up])) : undefined,
      pet: (f: FurnitureConfig) => {
        const state = this.pets?.get(f.id);
        const floor = this.floor;
        if (!floor) return { state };
        const nav = (allowClosed: boolean) => buildNav(floor, this.getState, allowClosed);
        const door = findFrontDoor(floor, this.frontDoor);
        const way = door ? wayToDoor(floor, [f.x, f.y], door) : undefined;
        return { state, nav, way: state?.mode === 'due' ? way : undefined, door: way ? { inside: way.path[way.path.length - 1], face: way.face } : undefined };
      },
    };
  }

  private furnKeyFor(height: number, focusId?: string) {
    return `${height}|${focusId ?? ''}|${this.editing ? 1 : 0}`;
  }

  /** Live state handed to the drawing of pieces that move: gates and garage doors (how far open), irrigation zones */
  private pieceLive(f: FurnitureConfig): PieceLive | undefined {
    const kind = resolveFurniture(f).k?.kind;
    // a car: what is open (from its device, detection cached)
    if (kind === 'car') return this.hass && (f.entity || f.entities || f.extra) && !this.editing ? { car: carOpen(this.hass, f, this.getState) } : undefined;
    // stairs: lit treads while their light is on or someone moves on them
    if (kind === 'stairs') return !this.editing && stairsLit(f, this.getState) > 0 ? { on: true } : undefined;
    if (!f.entity) return undefined;
    if (kind === 'fridge') {
      const count = fridgeList(f, this.getState);
      return count ? { count } : undefined;
    }
    if (kind === 'gate' || kind === 'garage_door') {
      const c = coverLive(this.getState(f.entity));
      return { open: c.open, alert: c.state === 'open' };
    }
    if (kind === 'irrigation_zone') {
      const s = this.getState(f.entity);
      return { on: !!s && (isActive(s) || s.state === 'open' || s.state === 'opening') };
    }
    return undefined;
  }

  /** Live state of every linked piece (what its look depends on) */
  private furnSig(floor: FloorConfig) {
    const sig = new Map<string, string>();
    for (const f of floor.furniture ?? []) {
      const role = resolveFurniture(f).role;
      if (role === 'pet') {
        const p = this.pets?.get(f.id);
        sig.set(f.id, `pet:${p?.mode ?? '-'}:${p?.slot ?? ''}:${this.frontDoor ?? ''}`);
        continue;
      }
      const kind = resolveFurniture(f).k?.kind;
      if (role === 'mower' || role === 'water' || role === 'energy' || role === 'car' || kind === 'gate' || kind === 'garage_door') {
        if (f.entity || f.entities) sig.set(f.id, `${liveClass(f, this.getState)}${role === 'car' ? ':' + carOpenSig(this.pieceLive(f)?.car) : ''}`);
        continue;
      }
      if (!f.entity && role !== 'heat' && !(kind === 'stairs' && f.contents?.length)) continue;
      const fx = furnitureFx(f, this.getState, floor.rooms);
      // a fridge with a shopping list: the number on its door
      const list = kind === 'fridge' ? fridgeList(f, this.getState) : 0;
      sig.set(f.id, (fx ? `${fx.kind}:${fx.color}:${fx.level.toFixed(2)}` : '-') + (list ? `:list${list}` : ''));
    }
    return sig;
  }

  /**
   * Room views are built ahead of time while nothing happens (one per idle moment), so zooming onto a room
   * or back only swaps prepared scenes.
   */
  private prebuildTimer?: number;
  private lastInteract = 0;
  private schedulePrebuild(delay = 2500) {
    clearTimeout(this.prebuildTimer);
    if (!this.gl || this.editing || !this.pendingGl) return;
    this.prebuildTimer = window.setTimeout(() => {
      const run = () => this.prebuildNext();
      if ('requestIdleCallback' in window) (window as any).requestIdleCallback(run, { timeout: 1500 });
      else run();
    }, delay);
  }

  private prebuildNext() {
    const gl = this.gl;
    const pg = this.pendingGl;
    if (!gl || !pg || this.editing || gl.furnitureCacheFull) return;
    if (this.panZoom?.busy || performance.now() - this.lastInteract < 2000 || this.camAnim) return this.schedulePrebuild(1500);
    const roomH = Math.max(this.wallHeight, this.roomHeight);
    const overviewH = this.fullWalls ? roomH : this.wallHeight;
    const rooms = pg.floor.rooms.filter((r) => r.points.length >= 3).sort((a, b) => Number(resolveAction(b, 'room', 'tap').action === 'zoom') - Number(resolveAction(a, 'room', 'tap').action === 'zoom'));
    const wanted: { key: string; height: number; focus?: RoomConfig }[] = [
      { key: this.furnKeyFor(overviewH), height: overviewH },
      ...rooms.map((r) => ({ key: this.furnKeyFor(roomH, r.id), height: roomH, focus: r })),
    ];
    const next = wanted.find((w) => !gl.hasFurniture(w.key));
    if (!next) return;
    gl.prebuildFurniture(pg.floor, { ...this.glBuild(pg.opts), height: next.height, focus: next.focus }, next.key, this.furnSig(pg.floor));
    this.schedulePrebuild(400);
  }

  /** (zooming no longer switches between 2D and 3D: only the button does) */
  private scheduleZoomMode(_s: number, _isDefault: boolean) {}

  /** WebGL pick at a client point (viewport coordinates) */
  private glPick(e: { clientX: number; clientY: number }, dx = 0, dy = 0, any = false): string | undefined {
    if (!this.gl || !this.is3d) return undefined;
    const vp = this.renderRoot.querySelector('.viewport') as HTMLElement;
    const r = vp.getBoundingClientRect();
    const items = this.floor?.furniture ?? [];
    // any: every piece except flat rugs (unlinked ones then swallow the tap); otherwise linked pieces only
    const ok = (id: string) => {
      const f = items.find((x) => x.id === id);
      if (!f) return false;
      if (this.editing) return true;
      return any ? linked(f) || resolveFurniture(f).k?.kind !== 'rug' : linked(f);
    };
    return this.gl.pick(e.clientX - r.left + dx, e.clientY - r.top + dy, ok);
  }

  // ---------- performance overlay ----------
  private statsText = '';
  private precisionText?: string;
  private statsTimer?: number;
  private statsFrames = 0;
  private statsLoop = () => {
    this.statsFrames++;
    if (this.stats) requestAnimationFrame(this.statsLoop);
  };
  private startStats() {
    if (this.statsTimer) return;
    let t0 = performance.now();
    requestAnimationFrame(this.statsLoop);
    this.statsTimer = window.setInterval(() => {
      if (!this.stats) {
        clearInterval(this.statsTimer);
        this.statsTimer = undefined;
        return;
      }
      const now = performance.now();
      const fps = (this.statsFrames * 1000) / (now - t0);
      this.statsFrames = 0;
      t0 = now;
      const gl = this.gl;
      const lines = [`Browser ${fps.toFixed(0)} fps`];
      if (gl) {
        const st = gl.stats();
        const c = gl.renderer.domElement;
        lines.push(
          `3D ${gl.fps.toFixed(0)} Bilder/s · ${gl.lastFrameMs.toFixed(1)} ms`,
          `${c.width}×${c.height} px (×${gl.renderer.getPixelRatio().toFixed(2)}) · DPR ${(window.devicePixelRatio || 1).toFixed(2)}`,
          `${st.calls} Aufrufe · ${(st.triangles / 1000).toFixed(1)}k Dreiecke · Profil ${gl.profileName}`,
          gl.gpuName().slice(0, 60),
          `Shader ${this.precisionText ??= shaderPrecision()}`,
        );
      } else
        lines.push(
          GL_WHY === 'chunk-reload' ? t('card.gl_chunk_reload') : GL_WHY === 'chunk' ? t('card.gl_chunk') : GL_WHY === 'context' ? t('card.gl_context') : 'CSS-3D (kein WebGL)',
        );
      const mem = (performance as any).memory;
      if (mem) lines.push(`JS ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
      this.statsText = lines.join('\n');
      this.requestUpdate();
    }, 1000);
  }

  /** A tapped lamp bounces once (WebGL: scale pop of the body; 2D and CSS 3D: the same pop as a CSS animation) */
  bounce(id: string) {
    if (this.gl) return this.gl.bounce(id);
    const q = `.piece[data-furniture="${CSS.escape(id)}"] > .pb, .furn3d [data-furniture="${CSS.escape(id)}"] > .b3`;
    for (const el of this.renderRoot.querySelectorAll<HTMLElement | SVGElement>(q)) {
      el.classList.remove('bounce');
      void (el as HTMLElement).getBoundingClientRect();
      el.classList.add('bounce');
      el.addEventListener('animationend', () => el.classList.remove('bounce'), { once: true });
    }
  }

  /** Test/debug access to the WebGL scene */
  get glScene() {
    return this.gl;
  }

  /** Screen rectangle (client px) of a piece in 3D — WebGL or CSS fallback */
  pieceRect(id: string): { x: number; y: number; w: number; h: number } | undefined {
    if (this.gl) {
      const vp = (this.renderRoot.querySelector('.viewport') as HTMLElement).getBoundingClientRect();
      const r = this.gl.screenRect(id);
      return r && { x: r.x + vp.left, y: r.y + vp.top, w: r.w, h: r.h };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const e of this.renderRoot.querySelectorAll(`.furn3d [data-furniture="${CSS.escape(id)}"] .f`)) {
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
  }

  /** State of a piece in 3D (live effect, emitting parts, spinning, tap flash, lowest part height) */
  pieceInfo(id: string) {
    if (this.gl) return this.gl.info(id);
    const ps = [...this.renderRoot.querySelectorAll(`.furn3d [data-furniture="${CSS.escape(id)}"]`)];
    if (!ps.length) return undefined;
    const fx = (ps[0].getAttribute('class') ?? '').match(/fx-(\w+)/)?.[1];
    return { visible: !ps[0].classList.contains('hide'), fx, emissive: ps.filter((p) => p.querySelector('.b3.emit')).length, spinning: false, z: 0 };
  }

  /** Piece id under a client point in 3D */
  pieceAt(x: number, y: number): string | undefined {
    if (this.gl) return this.glPick({ clientX: x, clientY: y }) ?? (this.editing ? undefined : undefined);
    const el = (this.renderRoot as ShadowRoot).elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest('[data-furniture]') as HTMLElement | null)?.dataset.furniture;
  }

  /** Room id under a client point (WebGL floor: from the floor point; otherwise the SVG) */
  roomAt(x: number, y: number): string | undefined {
    if (this.glFloor && this.floor) {
      const p = this.floorPoint({ clientX: x, clientY: y });
      if (!p) return undefined;
      for (let i = this.floor.rooms.length - 1; i >= 0; i--) if (this.floor.rooms[i].points.length >= 3 && pointInPolygon(p, this.floor.rooms[i].points)) return this.floor.rooms[i].id;
      return undefined;
    }
    const el = (this.renderRoot as ShadowRoot).elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest('[data-room]') as HTMLElement | null)?.dataset.room;
  }

  /** Window panes currently signalling the front door alarm */
  alertPanes(): number {
    if (this.gl) return this.gl.stats().pulsing;
    return this.renderRoot.querySelectorAll('.glass3.alert').length;
  }
  /** Portrait viewports use a flatter 3D tilt so the plan gains height */
  declare portrait: boolean;
  /** Animated effects (wind through open windows) */
  declare effects: boolean;
  declare windSpeed?: number;
  /** View rotation the plan returns to (per user / card) */
  declare defaultSpin: number;
  /** Exterior wall paint (2D walls, 3D outside faces) */
  declare wallColor?: string;
  /** auto: labels outside the building next to the room where possible; inside: always in the room */
  declare labelMode: 'auto' | 'inside';
  /** Editor: show the plan in 3D (editing stays possible) */
  declare threeD: boolean;
  /** Walls at real room height (interior view); walls hiding rooms turn translucent */
  declare fullWalls: boolean;
  /** Real room height in cm for full walls */
  declare roomHeight: number;
  /** Height of the rearmost walls in the cut-away 3D view */
  declare backWallHeight?: number;
  /** Camera tilt chosen by the user (deg), overrides the default */
  declare _tiltUser?: number;
  /** Editor: hide all room labels (e.g. while placing furniture) */
  declare hideLabels: boolean;
  declare hideLabelsOnMove: boolean;
  declare focusBadge: boolean;
  /** Room labels with a thermostat take taps (opens the heating) */
  declare labelTap: boolean;
  /** Room values as floating labels ('badge') or engraved into a wall ('wall', 3D) */
  declare labelStyle?: 'badge' | 'wall';
  declare _wallLabeled?: Set<string>;
  /** Walk / presence state of every pet (from the card) */
  declare pets?: Map<string, PetState>;
  /** Front door (opening id) the dog walks to */
  declare frontDoor?: string;
  /** Hausregeln: rooms (plan ids) somebody is in */
  declare hrOccupied?: Set<string>;
  /** Hausregeln: a rule shown on the plan — devices per sentence part (colour), its rooms, lines trigger → action */
  declare hrMarks?: HrMarks;
  /** Hausregeln: the sensor that set off the alarm (pulses red) */
  declare hrAlarmCause?: string;
  /** short rings where a rule has just switched something (2D; 3D draws them in WebGL) */
  declare _pulses?: { key: number; x: number; y: number; color: string; loop?: boolean }[];
  private pulseKey = 0;
  private causeTimer?: number;

  /** Where an entity sits on the plan: its piece, marker, door / window, or the room it belongs to */
  entityAnchor(id: string): Point | undefined {
    const f = this.floor;
    if (!f) return undefined;
    const p = f.furniture?.find((x) => x.entity === id || (x.entities && Object.values(x.entities).includes(id)));
    if (p) return [p.x, p.y];
    const d = f.devices.find((x) => x.entity === id);
    if (d) return [d.x, d.y];
    const o = f.openings?.find((x) => x.entity === id);
    if (o) return [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    const r = f.rooms.find((x) => x.lights?.includes(id) || x.climate === id || x.temperature === id || x.humidity === id || x.sensors?.some((s) => s.entity === id));
    if (r && r.points.length >= 3) return r.label ?? polylabel(r.points);
    return undefined;
  }

  /** The alarm's cause pulses red until the alarm is over */
  private followCause() {
    clearInterval(this.causeTimer);
    this._pulses = (this._pulses ?? []).filter((p) => !p.loop);
    const cause = this.hrAlarmCause;
    if (!cause) return;
    if (this.glFloor && this.gl) {
      this.pulseEntities([cause], '#ff3b30');
      this.causeTimer = window.setInterval(() => this.pulseEntities([cause], '#ff3b30'), 1400);
    } else this.pulseEntities([cause], '#ff3b30', true);
  }

  /** The alarm's cause: a short red ring at each (transform / opacity only) */
  pulseEntities(ids: string[], color: string, loop = false) {
    const pts = ids.map((id) => this.entityAnchor(id)).filter((p): p is Point => !!p);
    if (!pts.length) return;
    if (this.glFloor && this.gl) {
      this.gl.pulseRings(pts, color);
      return;
    }
    const add = pts.map((p) => ({ key: ++this.pulseKey, x: p[0], y: p[1], color, loop }));
    this._pulses = [...(this._pulses ?? []), ...add].slice(-24);
    if (!loop)
      window.setTimeout(() => {
        const keys = new Set(add.map((a) => a.key));
        this._pulses = (this._pulses ?? []).filter((x) => !keys.has(x.key));
      }, 1500);
  }
  /** Room whose label is shown at the top (room view, until the view is moved) */
  declare _badge?: string;
  private badgeArmed = 0;
  private badgeTimer?: number;
  private labelsTimer?: number;
  declare _spin: number;
  declare _spinning: boolean;
  /** Room currently zoomed onto (keeps 3D, dims the rest) */
  declare _focusId?: string;
  declare _zoomedIn: boolean;
  declare _small: boolean;

  panZoom?: PanZoom;
  private sizeObserver?: ResizeObserver;
  private labelCache = new Map<string, LabelPlacement>();
  private lastFloorId?: string;

  constructor() {
    super();
    this.wallWidth = 8;
    this.editing = false;
    this.showGrid = false;
    this.grid = 20;
    this.viewMode = 'auto';
    this.wallHeight = 90;
    this.portrait = false;
    this.effects = true;
    this.defaultSpin = 0;
    this.labelMode = 'auto';
    this.threeD = false;
    this.fullWalls = false;
    this.roomHeight = 250;
    this.hideLabels = false;
    this.hideLabelsOnMove = false;
    this.focusBadge = true;
    this.labelTap = false;
    this._spin = 0;
    this._spinning = false;
    this._zoomedIn = false;
    this._small = false;
    this.getState = (id) => this.hass?.states[id];
  }

  private spinStart = 0;
  private orbitTilt = 48;
  private basePersp = 2000;
  private focusPersp?: number;
  private currentPersp = 2000;

  /** Stronger perspective when zoomed in: feels like stepping into the room. */
  private updatePerspective() {
    const pz = this.panZoom;
    if (!pz || !this.renderRoot?.querySelector('.stage')) return;
    this.currentPersp = this.perspFor(pz.scale);
    // the perspective is part of the stage transform (a variable would restyle the whole plan on every zoom step)
    this.applyCam(false);
  }

  /** The perspective that belongs to a zoom level (stronger when zoomed in); fixed while zoomed onto a room */
  private perspFor(s: number): number {
    if (this._focusId) return this.focusPersp ?? this.currentPersp;
    const zoom = Math.max(1, s / (this.panZoom?.fitScale || 1));
    return Math.max(360, this.basePersp / Math.pow(zoom, 0.75));
  }

  /** world + stage 3D transform for a view (and the perspective of its zoom level) */
  private viewMatrix(v: ViewTransform, persp = this.perspFor(v.s)): DOMMatrix {
    const [cx, cy] = this.glCenter;
    const pm = new DOMMatrix();
    pm.m34 = -1 / persp;
    return new DOMMatrix().translate(v.tx, v.ty).scale(v.s).translate(cx, cy).multiply(pm).rotate(this.tilt, 0, 0).rotate(0, 0, this.spin).translate(-cx, -cy);
  }

  /**
   * Zoom about a screen point in 3D: the floor point under it stays exactly there, also while the perspective
   * changes with the zoom (screen = t + s · project(P), so t follows from P projected with the new perspective).
   */
  private zoomAnchor = (sx: number, sy: number, from: ViewTransform, s: number, at?: Point): { view: ViewTransform; at: Point } | undefined => {
    if (!this.is3d) return undefined;
    const P = at ?? this.unprojectWith(this.viewMatrix(from), sx, sy, 0);
    if (!P) return undefined;
    const q = this.viewMatrix({ s: 1, tx: 0, ty: 0 }, this.perspFor(s)).transformPoint(new DOMPoint(P[0], P[1], 0, 1));
    if (q.w <= 1e-6) return undefined;
    return { view: { s, tx: sx - (q.x / q.w) * s, ty: sy - (q.y / q.w) * s }, at: P };
  };

  /** Viewport px → floor-plane plan coordinates, inverting the world + stage 3D transform. */
  private unproject = (sx: number, sy: number): Point | undefined => {
    if (!this.is3d || !this.panZoom) return undefined;
    // the plane z = dragZ (floor, or the height an elevated piece sits at)
    return this.unprojectWith(this.viewMatrix(this.panZoom.view), sx, sy, this.dragZ);
  };

  private unprojectWith(m: DOMMatrix, sx: number, sy: number, z: number): Point | undefined {
    const a1 = m.m11 - sx * m.m14;
    const b1 = m.m21 - sx * m.m24;
    const c1 = sx * (m.m34 * z + m.m44) - (m.m31 * z + m.m41);
    const a2 = m.m12 - sy * m.m14;
    const b2 = m.m22 - sy * m.m24;
    const c2 = sy * (m.m34 * z + m.m44) - (m.m32 * z + m.m42);
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return undefined;
    return [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
  }
  private stableSpin = 0;
  private userSpun = false;

  /** Current view rotation in degrees (0 while editing). */
  get spin(): number {
    return this.editing && !this.threeD ? 0 : (this.liveSpin ?? this._spin);
  }

  /** While a finger turns / orbits the view: the live angles (no re-render per move, committed at the end) */
  private liveSpin?: number;
  private liveTilt?: number;

  /** Rotate to an angle via the shortest way (animated by the --fp-spin transition). */
  setSpin(deg: number) {
    const cur = this._spin;
    const delta = ((((deg - cur) % 360) + 540) % 360) - 180;
    this._spin = cur + delta;
    this.emitSpin();
  }

  rotateBy(deg: number) {
    this.userSpun = true;
    this.setSpin(this.snap90(this._spin + deg));
  }

  resetSpin() {
    this.userSpun = false;
    this.setSpin(this.defaultSpin);
  }

  private snap90(a: number) {
    const n = Math.round(a / 90) * 90;
    return Math.abs(n - a) <= 8 ? n : a;
  }

  private emitSpin() {
    this.dispatchEvent(new CustomEvent('fp-spin-change', { detail: { spin: this.spin, isDefault: this.isDefaultSpin } }));
  }

  get isDefaultSpin() {
    return Math.abs(((((this._spin - this.defaultSpin) % 360) + 540) % 360) - 180) < 0.5;
  }

  override willUpdate(changed: PropertyValues) {
    // washers & co. work out "running" / "fertig" from the device's entities (furniture-fx, chips): they need hass
    if (this.hass && applianceWatch) applianceWatch.hass = this.hass;
    if (changed.has('_focusId') && !this._focusId) {
      this._badge = undefined;
      clearTimeout(this.badgeTimer);
    }
    if (changed.has('defaultSpin') && !this.userSpun) {
      this._spin = this.defaultSpin;
      queueMicrotask(() => this.emitSpin());
    }
  }

  get tilt(): number {
    if (this.liveTilt != null) return this.liveTilt;
    if (this._tiltUser != null) return this._tiltUser;
    if (this._focusId) return 50;
    return this.portrait ? TILT_PORTRAIT : TILT_3D;
  }

  /** Camera tilt in degrees (10 = almost top-down … 80 = nearly eye level). */
  setTilt(deg: number | undefined) {
    this._tiltUser = deg == null ? undefined : Math.max(8, Math.min(80, deg));
  }

  /** Effective wall height: real room height for interior views, else the cut-away height. */
  get effectiveWallHeight(): number {
    return this.fullWalls || this._focusId ? Math.max(this.wallHeight, this.roomHeight) : this.wallHeight;
  }

  /** 3D or 2D: switched only by hand (the 2D/3D button) — never by zooming, card size or idle time.
   * "auto" only picks the start on devices that cannot do 3D well. */
  get is3d(): boolean {
    if (this.editing) return this.threeD;
    if (this.viewMode === '2d') return false;
    if (this.viewMode === '3d') return true;
    return !isWeakDevice();
  }

  get focused() {
    return !!this._focusId;
  }

  private dimDevice(d: DeviceConfig): boolean {
    if (!this._focusId) return false;
    const room = this.floor?.rooms.find((r) => r.id === this._focusId);
    return !!room && !pointInPolygon([d.x, d.y], room.points);
  }

  /** Zoom onto a room, seen from its configured side (3D). Calling it again for the same room returns. */
  async focusRoom(id: string) {
    const room = this.floor?.rooms.find((r) => r.id === id);
    if (!room || !this.panZoom || this.editing) return;
    if (this._focusId === id) return this.resetView();
    // Interior look: a stronger, fixed perspective scaled to the room
    const rb = boundsOf(room.points);
    this.focusPersp = Math.max(700, Math.max(rb.maxX - rb.minX, rb.maxY - rb.minY) * 3.2);
    this._focusId = id;
    this.updatePerspective();
    if (room.view_angle != null) {
      this.userSpun = true;
      this.setSpin(room.view_angle);
    }
    await this.updateComplete;
    if (this._focusId !== id || !this.panZoom) return;
    // frame the room as it will look once the camera has turned (computed, so turning and zooming run together)
    const badge = this.focusBadge && !room.hide_label;
    this.panZoom.focusRect(this.projectedRect(room.points, this.is3d ? this.effectiveWallHeight : 0), 0.84, badge ? BADGE_SPACE : 0);
    clearTimeout(this.badgeTimer);
    this._badge = undefined;
    if (badge)
      this.badgeTimer = window.setTimeout(() => {
        if (this._focusId !== id) return;
        this._badge = id;
        this.badgeArmed = performance.now() + 150;
      }, CAM_MS + 120);
  }

  /** End the room view without moving the view (the camera turns back and the walls rise again) */
  private lastScale = 0;
  private leaveFocus() {
    this._focusId = undefined;
    this._tiltUser = undefined;
    clearTimeout(this.badgeTimer);
    this._badge = undefined;
    this.resetSpin();
  }

  /** Screen rectangle (viewport px) of a floor polygon with walls of height h, seen with the target camera */
  private projectedRect(points: Point[], h: number) {
    const v = this.panZoom!.view;
    const [cx, cy] = this.glCenter;
    const persp = new DOMMatrix();
    persp.m34 = -1 / (this.currentPersp || this.basePersp);
    const tilt = this.is3d ? this.tilt : 0;
    const m = new DOMMatrix().translate(v.tx, v.ty).scale(v.s).translate(cx, cy).multiply(persp).rotate(tilt, 0, 0).rotate(0, 0, this.spin).translate(-cx, -cy);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points)
      for (const z of h ? [0, h] : [0]) {
        const q = m.transformPoint(new DOMPoint(x, y, z, 1));
        const px = q.x / q.w;
        const py = q.y / q.w;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  override firstUpdated() {
    const viewport = this.renderRoot.querySelector('.viewport') as HTMLElement;
    const world = this.renderRoot.querySelector('.world') as HTMLElement;
    const forward: GestureHandlers = {
      hitTest: (e) => this.hitTest(e),
      hasDoubleTap: (tg) => this.handlers?.hasDoubleTap?.(tg) ?? false,
      onTap: (tg, w) => this.handlers?.onTap?.(tg, w),
      onTapDown: (tg) => this.handlers?.onTapDown?.(tg),
      onDoubleTap: (tg, w) => this.handlers?.onDoubleTap?.(tg, w),
      onHold: (tg, w) => this.handlers?.onHold?.(tg, w),
      onDragStart: (tg, w, e) => this.handlers?.onDragStart?.(tg, w, e) ?? false,
      onDragMove: (w, e) => this.handlers?.onDragMove?.(w, e),
      onDragEnd: (w, c) => this.handlers?.onDragEnd?.(w, c),
      onHover: (w) => this.handlers?.onHover?.(w),
      onPress: (tg) => {
        this._pressed = tg && tg.kind !== 'background' ? tg : null;
      },
      onRotate: (phase, delta, exact) => {
        if (this.editing) return;
        if (phase === 'start') {
          this.spinStart = this._spin;
          this._spinning = true;
          this.userSpun = true;
        } else if (phase === 'move') {
          this.liveSpin = this.spinStart + delta;
          this.markInteracting();
          this.updateCam();
          this.emitSpin();
        } else {
          const a = this.liveSpin ?? this._spin;
          this._spin = exact ? a : this.snap90(a);
          this.liveSpin = undefined;
          this._spinning = false;
          this.emitSpin();
        }
      },
      onReset: () => {
        this._focusId = undefined;
        this._tiltUser = undefined;
        if (!this.editing) this.resetSpin();
      },
      canOrbit: () => this.is3d,
      // scrolling moves the floor focus (the card knows the floors); never while editing – there the wheel zooms
      floorScroll: () => !this.editing && !!this.handlers?.floorScroll?.(),
      onFloorStep: (dir) => (!this.editing && this.handlers?.onFloorStep?.(dir)) || false,
      onOrbit: (phase, dx, dy) => {
        if (!this.is3d) return;
        if (phase === 'start') {
          this.spinStart = this._spin;
          this.orbitTilt = this.tilt;
          this._spinning = true;
          this.userSpun = true;
        } else if (phase === 'move') {
          this.liveSpin = this.spinStart + dx * 0.4;
          this.liveTilt = Math.max(8, Math.min(80, this.orbitTilt - dy * 0.3));
          this.markInteracting();
          this.updateCam();
          this.emitSpin();
        } else {
          if (this.liveSpin != null) this._spin = this.liveSpin;
          if (this.liveTilt != null) this._tiltUser = this.liveTilt;
          this.liveSpin = this.liveTilt = undefined;
          this._spinning = false;
          this.emitSpin();
        }
      },
      onViewChange: (v, isDefault) => {
        // zooming out of a room view by hand (pinch/wheel) back to the overview size ends the room view
        const zoomedOut = v.s < this.lastScale - 1e-6;
        this.lastScale = v.s;
        if (this._focusId && zoomedOut && this.panZoom?.gesturing && v.s <= (this.panZoom?.fitScale ?? 0) * 1.06) this.leaveFocus();
        this.updatePerspective();
        this.markInteracting();
        this.syncGl();
        this.updateDetail(v.s);
        this.scheduleZoomMode(v.s, isDefault);
        this.handlers?.onViewChange?.(v, isDefault);
        this.dispatchEvent(new CustomEvent('fp-view-change', { detail: { view: v, isDefault } }));
      },
    };
    this.panZoom = new PanZoom(viewport, world, forward);
    const top = this.renderRoot.querySelector('.world-top') as HTMLElement | null;
    if (top) this.panZoom.mirrors = [top];
    this.initGl();
    this.panZoom.zoomedDoubleTapReset = !this.editing;
    this.panZoom.rotatable = !this.editing || this.threeD;
    this.panZoom.unproject = this.unproject;
    this.panZoom.zoomAnchor = this.zoomAnchor;
    this.panZoom.insetRight = this.insetRight ?? 0;
    this.panZoom.insetTop = this.insetTop ?? 0;
    this.panZoom.insetBottom = this.insetBottom ?? 0;
    this.panZoom.setBounds(this.fitBoundsFor(this.is3d), true);
    this.sizeObserver = new ResizeObserver(() => {
      const h = this.getBoundingClientRect().height;
      this._small = h > 0 && h < 360;
    });
    this.sizeObserver.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unAppl?.();
    this.unAppl = undefined;
    clearInterval(this.followTimer);
    clearInterval(this.causeTimer);
    this.panZoom?.destroy();
    this.panZoom = undefined;
    this.glResize?.disconnect();
    this.floorObserver?.disconnect();
    this.floorObserver = undefined;
    this.gl?.dispose();
    this.gl = undefined;
    this.glWallsKey = this.glFurnKey = this.glLight = this.glTheme = '';
    this.glFloorRef = undefined;
    clearTimeout(this.prebuildTimer);
    this.sizeObserver?.disconnect();
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && !this.panZoom) this.firstUpdated();
  }

  private was3d?: boolean;


  /** Chips of moving pieces (mower) follow them a few times per second */
  private followTimer?: number;
  private followChips() {
    clearInterval(this.followTimer);
    const els = [...this.renderRoot.querySelectorAll('[data-follow]')].filter((e) => (e as HTMLElement).dataset.follow) as HTMLElement[];
    if (!els.length || !this.gl) return;
    this.followTimer = window.setInterval(() => {
      for (const el of els) {
        const p = this.gl?.piecePos(el.dataset.follow!);
        if (!p) continue;
        el.style.left = `${p[0].toFixed(1)}px`;
        el.style.top = `${p[1].toFixed(1)}px`;
      }
    }, 250);
  }

  override updated(changed: PropertyValues) {
    // the camera first: the render may have replaced the stage's style (variables of the counter-rotation)
    this.updateCam();
    this.followChips();
    if (changed.has('hrAlarmCause')) this.followCause();
    if (this.stats) this.startStats();
    if (this.useGl && !this.gl) this.initGl();
    this.updateGl();
    if (this.gl) {
      this.floorWatch();
      const on = this.glFloor;
      if (on !== this.gl.floorActive) {
        if (on) {
          // back to 3D: show the kept textures right away, re-check their content afterwards
          if (this.gl.hasFloorLayer('static')) this.gl.setFloorVisible(true);
          this.floorDirty = { static: true, dynamic: true };
          this.scheduleFloor(0);
        } else this.gl.setFloorVisible(false);
      }
      this.updateNightTint();
    }
    if (this.lastStable !== undefined && this.lastStable !== this.stableSpin && !this._spinning) {
      // the spin transitions in CSS: keep all faces during the animation, cull again afterwards
      this.cullHold = true;
      clearTimeout(this.cullTimer);
      this.cullTimer = window.setTimeout(() => {
        this.cullHold = false;
        this.requestUpdate();
      }, 900);
      this.requestUpdate();
    }
    this.lastStable = this.stableSpin;
    if (!this.panZoom) return;
    if (changed.has('insetRight')) this.panZoom.setInsetRight(this.insetRight ?? 0);
    if (changed.has('insetTop')) this.panZoom.setInsetTop(this.insetTop ?? 0);
    if (changed.has('insetBottom')) this.panZoom.setInsetBottom(this.insetBottom ?? 0);
    if (changed.has('threeD')) this.panZoom.rotatable = !this.editing || this.threeD;
    this.panZoom.scaleVarsOnWorld = !!this.editing || !this.useGl;
    if (changed.has('threeD') && !this.threeD && this.editing) {
      this._spin = 0;
      this._tiltUser = undefined;
    }
    const is3d = this.is3d;
    if (changed.has('floor') || changed.has('fitBounds') || changed.has('frameBounds') || changed.has('portrait') || (changed.has('_spin') && !this._spinning) || is3d !== this.was3d) {
      this.updatePerspective();
      const floorChanged = this.floor?.id !== this.lastFloorId;
      this.lastFloorId = this.floor?.id;
      this.was3d = is3d;
      this.panZoom.setBounds(this.fitBoundsFor(is3d), floorChanged);
    }
  }

  private currentBounds(): Bounds {
    if (this.fitBounds) return this.fitBounds;
    // the view frames the home; gardens, terraces and driveways around it are cut in at the edges
    const b = this.editing ? floorBounds(this.floor) : buildingBounds(this.floor);
    const fb = this.editing ? undefined : this.frameBounds;
    if (fb) {
      b.minX = Math.min(b.minX, fb.minX);
      b.minY = Math.min(b.minY, fb.minY);
      b.maxX = Math.max(b.maxX, fb.maxX);
      b.maxY = Math.max(b.maxY, fb.maxY);
    }
    // Leave room for labels placed outside the building
    for (const r of this.floor?.rooms ?? []) {
      const pl = r.points.length >= 3 && !r.hide_label ? this.labelFor(r) : undefined;
      if (!pl?.tip) continue;
      const n = pl.normal ?? [0, 0];
      const m = pl.normal ? 120 : 70;
      for (const [x, y] of [
        [pl.tip[0] + n[0] * m - (pl.normal ? 0 : m), pl.tip[1] + n[1] * m - (pl.normal ? 0 : m)],
        [pl.tip[0] + n[0] * m + (pl.normal ? 0 : m), pl.tip[1] + n[1] * m + (pl.normal ? 0 : m)],
      ]) {
        b.minX = Math.min(b.minX, x);
        b.maxX = Math.max(b.maxX, x);
        b.minY = Math.min(b.minY, y);
        b.maxY = Math.max(b.maxY, y);
      }
    }
    return b;
  }

  /** Bounds used to fit the view. In 3D: the projected footprint of the tilted plan with walls. */
  private fitBoundsFor(is3d: boolean): Bounds {
    let b = this.currentBounds();
    const sp = ((this.spin % 360) + 360) % 360;
    if (sp > 0.1) {
      // Bounding box of the rotated plan around its center
      const r = (sp * Math.PI) / 180;
      const w0 = b.maxX - b.minX;
      const h0 = b.maxY - b.minY;
      const wr = Math.abs(w0 * Math.cos(r)) + Math.abs(h0 * Math.sin(r));
      const hr = Math.abs(w0 * Math.sin(r)) + Math.abs(h0 * Math.cos(r));
      const cx0 = (b.minX + b.maxX) / 2;
      const cy0 = (b.minY + b.maxY) / 2;
      b = { minX: cx0 - wr / 2, maxX: cx0 + wr / 2, minY: cy0 - hr / 2, maxY: cy0 + hr / 2 };
    }
    if (!is3d) return b;
    const t = (this.tilt * Math.PI) / 180;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const w3 = w * 1.18;
    const h3 = h * Math.cos(t) * 1.12 + Math.max(this.effectiveWallHeight, this.backWallHeight ?? 0) * Math.sin(t) + 60;
    return { minX: cx - w3 / 2, maxX: cx + w3 / 2, minY: cy - h3 / 2 + h * 0.02, maxY: cy + h3 / 2 + h * 0.02 };
  }

  resetView() {
    this.panZoom?.reset();
  }

  /** Height of the plane used to map the pointer into the plan (dragging elevated pieces in 3D) */
  private dragZ = 0;

  /** A Hausregeln rule on the floor: rooms as soft areas, rings around the devices (trigger orange, condition
   * teal, action blue), a quiet line from trigger to action. Part of the floor layer, so it lies on the floor
   * in 3D, too. The alarm's cause gets a red ring. */
  private renderHrMarks(rooms: RoomConfig[]) {
    const m = this.hrMarks;
    const cause = this.hrAlarmCause ? this.entityAnchor(this.hrAlarmCause) : undefined;
    if (!m && !cause) return nothing;
    const ring = (p: Point, color: string) =>
      svg`<circle cx=${p[0]} cy=${p[1]} r="30" fill=${color} fill-opacity="0.14" stroke=${color} stroke-width="4"></circle><circle cx=${p[0]} cy=${p[1]} r="6" fill=${color}></circle>`;
    const lines = (m?.lines ?? [])
      .map((l) => ({ a: this.entityAnchor(l.from), b: this.entityAnchor(l.to), color: l.color }))
      .filter((l): l is { a: Point; b: Point; color: string } => !!l.a && !!l.b && Math.hypot(l.a[0] - l.b[0], l.a[1] - l.b[1]) > 20);
    return svg`<g class="hrmarks">
      ${(m?.rooms ?? []).map((rm) => {
        const r = rooms.find((x) => x.id === rm.id);
        return r ? svg`<path d=${pointsToPath(r.points)} fill=${rm.color} fill-opacity="0.12" stroke=${rm.color} stroke-opacity="0.55" stroke-width="3" stroke-dasharray="10 8"></path>` : nothing;
      })}
      ${lines.map(({ a, b, color }) => {
        // a gentle arc, not a ruler line
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        const c: Point = [mx + nx * len * 0.18, my + ny * len * 0.18];
        return svg`<path d=${`M ${a[0]} ${a[1]} Q ${c[0]} ${c[1]} ${b[0]} ${b[1]}`} fill="none" stroke=${color} stroke-opacity="0.6" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"></path>`;
      })}
      ${(m?.devices ?? []).map((d) => {
        const p = this.entityAnchor(d.id);
        return p ? ring(p, d.color) : nothing;
      })}
      ${cause ? ring(cause, '#ff3b30') : nothing}
    </g>`;
  }

  /** Night: cool ambient over unlit rooms; warm light falling out of the windows of lit rooms */
  private renderNightLight(floor: FloorConfig, rooms: RoomConfig[]) {
    const k = this.night ?? 0;
    const lit = new Map(rooms.map((r) => [r.id, this.roomStatus(r)]));
    const dark = rooms.filter((r) => r.outdoor || !lit.get(r.id)?.lightsOn);
    // light falls out of the windows only onto ground that exists (garden, terrace): never into the void
    const ground = rooms.filter((r) => r.outdoor && r.points.length >= 3);
    const spills = (ground.length ? floor.openings ?? [] : [])
      .filter((o) => o.type === 'window')
      .map((o) => {
        const inward = windowInward(o, floor);
        if (!inward) return nothing;
        const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
        const room = rooms.find((r) => pointInPolygon([mid[0] + inward[0] * 8, mid[1] + inward[1] * 8], r.points));
        const st = room ? lit.get(room.id) : undefined;
        if (!st?.lightsOn) return nothing;
        const len = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
        const ang = (Math.atan2(-inward[1], -inward[0]) * 180) / Math.PI;
        return svg`<g transform=${`translate(${mid[0]} ${mid[1]}) rotate(${ang})`}>
          <ellipse class="spill" cx="55" cy="0" rx="95" ry=${len / 2 + 45} style=${`opacity:${(0.75 * k * st.level).toFixed(3)}`}></ellipse>
        </g>`;
      });
    return svg`
      <clipPath id="fp-dark-rooms">${dark.map((r) => svg`<path d=${pointsToPath(r.points)}></path>`)}</clipPath>
      ${dark.length ? svg`<g class="night-tint" clip-path="url(#fp-dark-rooms)"><path d=${dark.map((r) => pointsToPath(r.points)).join(' ')}></path></g>` : nothing}
      ${ground.length
        ? svg`<clipPath id="fp-ground">${ground.map((r) => svg`<path d=${pointsToPath(r.points)}></path>`)}</clipPath>
            <g class="spills" clip-path="url(#fp-ground)">${spills}</g>`
        : nothing}`;
  }

  /** Everything the 3D walls and furniture depend on, as one comparable string */
  private scene3dKey(floor: FloorConfig, o: { height: number; full: boolean; focus?: RoomConfig; backHeight?: number; alert?: Set<string>; spin?: number; cull?: boolean; wallColor?: string; wall: number }) {
    const sun = this.sun;
    const states: string[] = [];
    for (const op of floor.openings ?? []) if (op.entity) states.push(op.type === 'garage' ? coverLiveSig(this.getState(op.entity)) : openingState(this.getState(op.entity)));
    for (const f of floor.furniture ?? []) {
      if (!f.entity && resolveFurniture(f).role !== 'heat') continue;
      const kind = resolveFurniture(f).k?.kind;
      if (kind === 'gate' || kind === 'garage_door') states.push(liveClass(f, this.getState));
      if (kind === 'fridge') states.push(`list${fridgeList(f, this.getState)}`);
      const fx = furnitureFx(f, this.getState, floor.rooms);
      states.push(fx ? `${fx.kind}:${fx.color}:${fx.level.toFixed(2)}` : '-');
    }
    return [
      this.detail,
      round(o.spin ?? 0, 1),
      o.cull ? 1 : 0,
      o.height,
      o.full ? 1 : 0,
      o.focus?.id ?? '',
      o.backHeight ?? '',
      o.wall,
      o.wallColor ?? '',
      o.alert ? [...o.alert].join(',') : '',
      sun ? `${sun.up ? 1 : 0}:${round(sun.azimuth, 0)}:${round(sun.elevation, 0)}:${sun.strength.toFixed(2)}` : '',
      states.join('|'),
    ].join(';');
  }

  /** Level of detail for round bodies (cm per slice), from the on-screen size of the plan */
  private detail = 1.6;
  private detailTimer?: number;
  private updateDetail(scale: number) {
    const want = 4 / Math.max(0.05, scale); // ~4 px per slice on screen
    const next = [1.6, 2.5, 4, 6, 9].find((b) => b >= want) ?? 9;
    if (next === this.detail) return clearTimeout(this.detailTimer);
    clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => {
      this.detail = next;
      this.requestUpdate();
    }, 250);
  }

  /** While the view turns by itself (focus, compass, idle return) every face is kept until it settles */
  private cullHold = false;
  private cullTimer?: number;
  private lastStable?: number;

  /** Front door warning: a pulsing red beacon at every open window (billboard, at window height in 3D) */
  private renderWindowAlerts() {
    if (!this.alertWindows?.size || !this.floor) return nothing;
    const z = this.is3d ? Math.round(this.effectiveWallHeight * 0.6) : 0;
    return (this.floor.openings ?? [])
      .filter((o) => this.alertWindows!.has(o.id))
      .map((o) => {
        const mid = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
        return html`<div class="win-beacon" style=${`left:${mid[0]}px;top:${mid[1]}px;--bz:${z}px`}>
          <div class="wb"><i></i><i class="r2"></i><ha-icon icon="mdi:window-open-variant"></ha-icon></div>
        </div>`;
      });
  }

  private hitTest(e: PointerEvent): HitTarget {
    const t = this.hitTestInner(e);
    this.dragZ = 0;
    if (t.kind === 'furniture' && t.id && this.is3d && this.floor?.furniture) {
      const f = this.floor.furniture.find((x) => x.id === t.id);
      if (f) {
        // Map the pointer on a plane through the middle of the piece's body (where it is grabbed)
        const cut = this.effectiveWallHeight;
        const base = furnitureBaseHeight(f, this.floor.furniture, cut);
        const body = Math.min(resolveFurniture(f).height, Math.max(1, cut - base));
        this.dragZ = base + body * 0.5;
      }
    }
    return t;
  }

  private hitTestInner(e: PointerEvent): HitTarget {
    const path = e.composedPath() as HTMLElement[];
    // Same order as on screen: labels, markers and handles (top layer) — then the visible 3D object
    // (WebGL canvas) — then the floor (doors/windows, rooms, 2D pieces)
    const top = this.renderRoot.querySelector('.world-top');
    const inTop = top ? path.includes(top as HTMLElement) : false;
    for (const el of path) {
      const ds = el?.dataset;
      if (!ds) continue;
      if (ds.handle) return { kind: 'background', id: 'handle:' + ds.handle };
      if (ds.label && this.editing) return { kind: 'background', id: 'handle:label:' + ds.label };
      if (ds.label && this.labelTap) return { kind: 'label', id: ds.label };
      // "wants out" message: a tap checks the walk off
      if (ds.pet && !this.editing) return { kind: 'furniture', id: ds.pet };
      // stairs to another floor: the chip above them (it leads there, whatever the stairs themselves do)
      if (ds.stairs && !this.editing) return { kind: 'furniture', id: ds.stairs, to: ds.stairsTo || undefined };
      // the label of a stacked floor with something to tell: goes there (the card opens the thing)
      if (ds.stackFloor && !this.editing) return { kind: 'furniture', id: ds.stackPiece || '', to: ds.stackFloor };
      // washer / dryer / dishwasher "fertig": a tap opens it (with "Gesehen")
      if (ds.appliance && !this.editing) return { kind: 'furniture', id: ds.appliance };
      if (ds.device) return { kind: 'device', id: ds.device };
      if (inTop && ds.furniture && (this.editing || this.floor?.furniture?.some((f) => f.id === ds.furniture && linked(f)))) return { kind: 'furniture', id: ds.furniture };
    }
    if (this.gl && this.is3d && this.labelStyle === 'wall' && !this.editing) {
      const vp = this.renderRoot.querySelector('.viewport') as HTMLElement;
      const r = vp.getBoundingClientRect();
      const room = this.gl.pickLabel(e.clientX - r.left, e.clientY - r.top);
      if (room) return { kind: 'label', id: room };
    }
    if (this.gl && this.is3d) {
      const id = this.glPick(e, 0, 0, true);
      if (id) return { kind: 'furniture', id };
    }
    for (const el of path) {
      const ds = el?.dataset;
      if (!ds) continue;
      if (ds.opening) return this.nearDevice(e) ?? { kind: 'opening', id: ds.opening };
      // flat 2D pieces only count when there is no 3D body to tap; unlinked pieces swallow the tap (rugs excepted)
      if (ds.furniture && !(this.gl && this.is3d)) {
        const f = this.floor?.furniture?.find((x) => x.id === ds.furniture);
        // stairs without a device stay in the background: the tap goes to the room (their chip leads upstairs)
        const quiet = resolveFurniture(f ?? { kind: '' } as FurnitureConfig).k?.kind;
        if (f && (this.editing || f.entity || f.contents?.length || (quiet !== 'rug' && quiet !== 'stairs'))) return { kind: 'furniture', id: ds.furniture };
      }
      if (ds.room) return this.nearDevice(e) ?? { kind: 'room', id: ds.room };
    }
    const near = this.nearDevice(e);
    if (near) return near;
    if (this.glFloor && this.floor) {
      const p = this.floorPoint(e);
      if (!p) return { kind: 'background' };
      // doors/windows: close to the opening on the floor
      const reach = Math.max(22, this.wallWidth * 2.2);
      for (const o of this.floor.openings ?? []) {
        if (closestPointOnSegment(p, o.a, o.b).dist < reach) return { kind: 'opening', id: o.id };
      }
      for (let i = this.floor.rooms.length - 1; i >= 0; i--) {
        const r = this.floor.rooms[i];
        if (r.points.length >= 3 && (r.kind !== 'plot' || this.editing) && pointInPolygon(p, r.points)) return { kind: 'room', id: r.id };
      }
      return { kind: 'background' };
    }
    if (!this.floor || !this.panZoom || this.is3d || Math.abs(this.spin % 360) > 0.1) return { kind: 'background' };
    const p = this.panZoom.clientToWorld(e.clientX, e.clientY);
    for (let i = this.floor.rooms.length - 1; i >= 0; i--) {
      const r = this.floor.rooms[i];
      if (r.points.length >= 3 && (r.kind !== 'plot' || this.editing) && pointInPolygon(p, r.points)) return { kind: 'room', id: r.id };
    }
    return { kind: 'background' };
  }

  /** A tick more reach for linked devices: probe a few pixels around the finger (no extra geometry) */
  private nearDevice(e: PointerEvent): HitTarget | undefined {
    const items = this.floor?.furniture;
    if (this.editing || !items?.some(linked)) return undefined;
    if (this.gl && this.is3d) {
      for (const [dx, dy] of NEAR) {
        const id = this.glPick(e, dx, dy);
        if (id) return { kind: 'furniture', id };
      }
      return undefined;
    }
    for (const [dx, dy] of NEAR) {
      const el = (this.renderRoot as ShadowRoot).elementFromPoint(e.clientX + dx, e.clientY + dy) as HTMLElement | null;
      const id = (el?.closest('[data-furniture]') as HTMLElement | null)?.dataset.furniture;
      if (id && items.some((f) => f.id === id && linked(f))) return { kind: 'furniture', id };
    }
    return undefined;
  }

  roomLights(room: RoomConfig): string[] {
    return room.lights ?? areaLights(this.hass, room.area, room.exclude);
  }

  roomStatus(room: RoomConfig): RoomStatus {
    const lights = this.roomLights(room);
    let on = 0;
    let sum = 0;
    for (const id of lights) {
      const s = this.getState(id);
      if (s?.state === 'on') {
        on++;
        sum += (s.attributes.brightness ?? 255) / 255;
      }
    }
    return { lightsOn: on, lights: lights.length, level: on ? 0.55 + 0.45 * (sum / on) : 0 };
  }

  private labelFor(room: RoomConfig): LabelPlacement {
    const rooms = this.floor?.rooms ?? [];
    const key = JSON.stringify(room.points) + JSON.stringify(room.label ?? null) + this.labelMode + rooms.map((r) => r.points.length + ':' + r.points[0]).join();
    const hit = this.labelCache.get(room.id);
    if (hit && hit.key === key) return hit;
    const b = boundsOf(room.points);
    const val: LabelPlacement = { key, point: room.label ?? polylabel(room.points), width: Math.max(1, b.maxX - b.minX) };
    if (room.label) {
      // Pinned by the admin: placed exactly there; outside the room it gets a leader to the room
      val.pinned = true;
      if (!pointInPolygon(room.label, room.points)) Object.assign(val, { tip: room.label, inner: innerPoint(room.points, room.label) });
    } else if (this.labelMode !== 'inside' && !room.outdoor) {
      const out = outsidePlacement(room, rooms.filter((r) => !r.outdoor));
      if (out) Object.assign(val, out);
    }
    this.labelCache.set(room.id, val);
    return val;
  }

  private isPressed(kind: string, id: string) {
    return this._pressed?.kind === kind && this._pressed.id === id;
  }

  private isSelected(kind: string, id: string) {
    return this.selected?.kind === kind && this.selected.id === id;
  }

  override render() {
    const floor = this.floor;
    const b = this.currentBounds();
    const pad = this.editing ? (this.is3d ? 900 : 4000) : 280;
    const vb = { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
    // the property line lies below every other area
    const rooms = [...(floor?.rooms ?? [])].sort((a, b) => Number(b.kind === 'plot') - Number(a.kind === 'plot'));
    const is3d = this.is3d;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.basePersp = Math.round(Math.max(b.maxX - b.minX, b.maxY - b.minY) * 2.4);
    const persp = Math.round(this.currentPersp || this.basePersp);
    const sunLayer = floor ? renderSun(floor, this.sun, this.wallHeight, is3d) : undefined;
    if (sunLayer && this.useGl && is3d) {
      // real shadows come from WebGL
      sunLayer.inner = nothing;
      sunLayer.shadow = nothing;
    }
    const ffx = floor ? renderFurnitureFx(floor, this.getState) : undefined;
    const litByLamps = new Set<string>();
    for (const f of floor?.furniture ?? []) {
      if (furnitureFx(f, this.getState, floor?.rooms)?.kind !== 'light') continue;
      const room = rooms.find((r) => pointInPolygon([f.x, f.y], r.points));
      if (room) litByLamps.add(room.id);
    }
    const focusRoom = this._focusId ? floor?.rooms.find((r) => r.id === this._focusId) : undefined;
    const winds = floor && this.effects && !this.editing ? renderWind(floor, this.getState, this.windSpeed, focusRoom?.points) : [];
    if (!this._spinning) this.stableSpin = this.spin;
    const wallH = this.effectiveWallHeight;
    const opts3d = {
      wall: this.wallWidth,
      height: wallH,
      full: wallH > this.wallHeight + 1,
      focus: this._focusId ? rooms.find((r) => r.id === this._focusId) : undefined,
      backHeight: this.backWallHeight,
      alert: this.alertWindows,
      sun: this.sun,
      getState: this.getState,
      wallColor: this.wallColor,
      spin: this.stableSpin,
      cull: !this._spinning && !this.cullHold,
      detail: this.detail,
    };
    // The 3D scene is only rebuilt when something it shows changes (not on every HA update)
    const show3d = is3d || (this.viewMode !== '2d' && !this.editing);
    const key3d = floor && show3d ? this.scene3dKey(floor, opts3d) : '';
    this.pendingGl = floor && show3d && this.useGl ? { floor, key: key3d, opts: opts3d } : undefined;
    const stageCls = `stage ${is3d ? 'is3d' : ''} ${this._spinning ? 'spinning' : ''} ${this._focusId ? 'focusing' : ''} ${(this.night ?? 0) > 0.01 ? 'amb' : ''} ${this.glFloor ? 'glfloor' : ''}`;
    const stageStyle = `transform-origin:${round(cx)}px ${round(cy)}px;--persp:${persp}px;--wall-h:${wallH}px;--label-lift:${this.wallHeight}px`;
    this.glCenter = [cx, cy];
    const painted = rooms.filter((r) => r.wall_color && r.points.length >= 3);
    return html`
      <div class="viewport">
        <div class="world">
          <div class=${stageCls} style=${stageStyle}>
          <svg
            class="plan"
            style=${styleMap({ left: `${vb.x}px`, top: `${vb.y}px`, width: `${vb.w}px`, height: `${vb.h}px` })}
            viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"
            aria-hidden="true"
          >
            <defs>
              <mask id="fp-wall-mask" maskUnits="userSpaceOnUse" x=${vb.x} y=${vb.y} width=${vb.w} height=${vb.h}>
                <rect x=${vb.x} y=${vb.y} width=${vb.w} height=${vb.h} fill="white"></rect>
                ${openingMaskLines(floor?.openings ?? [], this.wallWidth)}
              </mask>
              <radialGradient id="fp-glow" cx="50%" cy="50%" r="75%">
                <stop offset="0%" class="glow-stop-0"></stop>
                <stop offset="100%" class="glow-stop-1"></stop>
              </radialGradient>
              ${this.showGrid
                ? svg`<pattern id="fp-grid" width=${this.grid} height=${this.grid} patternUnits="userSpaceOnUse">
                    <path d="M ${this.grid} 0 L 0 0 0 ${this.grid}" class="grid-line"></path>
                  </pattern>
                  <pattern id="fp-grid-major" width=${this.grid * 5} height=${this.grid * 5} patternUnits="userSpaceOnUse">
                    <rect width=${this.grid * 5} height=${this.grid * 5} fill="url(#fp-grid)"></rect>
                    <path d="M ${this.grid * 5} 0 L 0 0 0 ${this.grid * 5}" class="grid-line major"></path>
                  </pattern>`
                : nothing}
            </defs>
              ${sunLayer?.defs ?? nothing}
              <radialGradient id="fp-spill">
                <stop offset="0" class="spill-0"></stop>
                <stop offset="1" class="spill-1"></stop>
              </radialGradient>
              ${rooms.map((r) => floorPattern(`fp-floor-${r.id}`, r.floor) ?? nothing)}
              ${painted.map((r) => svg`<clipPath id=${`fp-clip-${r.id}`}><path d=${pointsToPath(r.points)}></path></clipPath>`)}
            ${this.showGrid ? svg`<rect x=${vb.x} y=${vb.y} width=${vb.w} height=${vb.h} fill="url(#fp-grid-major)"></rect>` : nothing}
            ${sunLayer?.shadow ?? nothing}
            ${this.below && this.belowMode === 'outline' ? this.renderBelow(this.below, 'below') : nothing}
            ${this.stack?.length && !this.is3d && !this.editing && !this._focusId ? this.renderStack(this.stack) : nothing}
            ${this.trace && !this.editing ? this.renderTrace(this.trace) : nothing}
            <g class="rooms">
              ${repeat(rooms, (r) => r.id, (r) => svg`<path class="room ${r.outdoor ? 'outdoor' : ''} ${r.kind === 'plot' ? 'plot' : ''}" data-room=${r.id} d=${pointsToPath(r.points)} style=${r.kind === 'plot' && !this.editing ? 'pointer-events:none' : ''}></path>`)}
            </g>
            <g class="floors">
              ${repeat(
                rooms.filter((r) => r.floor && r.floor.type !== 'none'),
                (r) => r.id,
                (r) => svg`<path class="floor" d=${pointsToPath(r.points)} fill=${`url(#fp-floor-${r.id})`}></path>`,
              )}
            </g>
            ${this.editing ? nothing : this.renderStairwells()}
            ${this.trace && this.editing ? this.renderTrace(this.trace) : nothing}
            ${sunLayer?.inner ?? nothing}
            ${floor && this.night && this.night > 0.05 && !this.editing ? this.renderNightLight(floor, rooms) : nothing}
            <g class="furniture">
              ${repeat(
                [...(floor?.furniture ?? [])].sort((a, b) => furnitureLayer(a) - furnitureLayer(b)),
                (f) => f.id,
                (f) => {
                  const fx = furnitureFx(f, this.getState, floor?.rooms);
                  return svg`<g class="piece ${this.isSelected('furniture', f.id) ? 'selected' : ''} ${fx ? `fx fx-${fx.kind}` : ''} ${f.entity || f.contents?.length ? 'linked' : ''} ${resolveFurniture(f).k?.kind === 'rug' ? 'rug' : ''} ${this.isPressed('furniture', f.id) ? 'pressed' : ''}"
                    data-furniture=${f.id} style=${fx ? `--glow:${fx.color}` : ''}
                    transform=${`translate(${f.x} ${f.y}) rotate(${f.rotation ?? 0})`}>${(f.entity || f.contents?.length) && !this.editing
                      ? svg`<circle class="fhit" r=${Math.max(32, Math.max(f.w, f.h) / 2 + 16)}></circle>`
                      : nothing}<g class="pb">${drawFurniture(f, this.pieceLive(f))}</g>${this.isSelected('furniture', f.id)
                      ? svg`<rect class="piece-sel" x=${-f.w / 2 - 4} y=${-f.h / 2 - 4} width=${f.w + 8} height=${f.h + 8} rx="6"></rect>`
                      : nothing}</g>`;
                },
              )}
            </g>
            ${this.hrOccupied?.size
              ? svg`<g class="occ">${rooms.filter((r) => this.hrOccupied!.has(r.id)).map((r) => svg`<path d=${pointsToPath(r.points)} fill="var(--fp-occupied)" fill-opacity="0.16"></path>`)}</g>`
              : nothing}
            <g class="glows">
              ${repeat(rooms, (r) => r.id, (r) => {
                // rooms whose lamps are drawn cast their light as pools: no second tint over the whole floor
                const st = this.roomStatus(r);
                const k = litByLamps.has(r.id) ? 0 : st.level;
                return svg`<path class="glow" d=${pointsToPath(r.points)} style=${`--k:${k.toFixed(3)}`}></path>`;
              })}
            </g>
            ${ffx ? svg`<defs>${ffx.defs}</defs><g class="ffxs">${ffx.items}</g>` : nothing}
            ${this.renderHrMarks(rooms)}
            <g class="beams">${sunLayer?.beams ?? nothing}</g>
            <g class="presses">
              ${repeat(
                rooms,
                (r) => r.id,
                (r) => svg`<path class="press ${this.isPressed('room', r.id) ? 'on' : ''}" d=${pointsToPath(r.points)}></path>`,
              )}
            </g>
            <g class="walls" mask="url(#fp-wall-mask)" style=${`stroke-width:${this.wallWidth}${this.wallColor ? `;--wall-paint:${paint(this.wallColor)}` : ''}`}>
              ${repeat(rooms.filter((r) => !r.outdoor), (r) => r.id, (r) => svg`<path class="wall" d=${pointsToPath(r.points)}></path>`)}
              ${(floor?.walls ?? []).map(
                (w) =>
                  svg`<line class="wall free ${w.height ? 'half' : ''} ${this.isSelected('wall', w.id) ? 'sel' : ''}" data-free-wall=${w.id} x1=${w.a[0]} y1=${w.a[1]} x2=${w.b[0]} y2=${w.b[1]} style=${`stroke-width:${w.thickness ?? this.wallWidth}${w.color ? `;stroke:${paint(w.color)}` : ''}`}></line>`,
              )}
              ${painted.map(
                (r) =>
                  svg`<path class="wall painted" d=${pointsToPath(r.points)} clip-path=${`url(#fp-clip-${r.id})`} style=${`stroke:${paint(r.wall_color!)}`}></path>`,
              )}
            </g>
            <g class="openings">
              ${repeat(
                floor?.openings ?? [],
                (o) => o.id,
                (o) =>
                  this.alertWindows?.has(o.id)
                    ? svg`<g class="win-alert">${drawOpening(o, this.wallWidth, 'open', false, floor ? windowInward(o, floor) : undefined, this.editing)}<line class="alert-line" x1=${o.a[0]} y1=${o.a[1]} x2=${o.b[0]} y2=${o.b[1]} style=${`stroke-width:${this.wallWidth * 2.6}`}></line></g>`
                    : drawOpening(
                    o,
                    this.wallWidth,
                    openingState(o.entity ? this.getState(o.entity) : undefined),
                    this.isSelected('opening', o.id),
                    o.type !== 'door' && floor ? windowInward(o, floor) : undefined,
                    this.editing,
                    o.type === 'garage' && o.entity ? coverLive(this.getState(o.entity)) : undefined,
                  ),
              )}
            </g>
            ${this.below && this.belowMode === 'ghost' ? this.renderBelow(this.below, 'below-ghost') : nothing}
            ${this._focusId && floor
              ? (() => {
                  const fr = rooms.find((r) => r.id === this._focusId);
                  // only the other rooms step back (no veil around the building)
                  const others = rooms.filter((r) => r !== fr && r.points.length >= 3);
                  return fr && others.length
                    ? svg`<path class="focus-dim" d=${others.map((r) => pointsToPath(r.points)).join(' ')}></path>`
                    : nothing;
                })()
              : nothing}
            <g class="leaders">
              ${rooms.map((r) => {
                // values engraved into the walls: no labels, so no leader lines either
                if (r.hide_label || r.points.length < 3 || this.hideLabels || this.engraved) return nothing;
                const pl = this.labelFor(r);
                if (!pl.tip || !pl.inner) return nothing;
                return svg`<line class="leader" x1=${pl.inner[0]} y1=${pl.inner[1]} x2=${pl.tip[0]} y2=${pl.tip[1]}></line>
                  <circle class="pin" cx=${pl.inner[0]} cy=${pl.inner[1]} r="4"></circle>`;
              })}
            </g>
            ${this.kbRing(rooms)}
            ${this.overlaySvg ?? nothing}
          </svg>
          ${floor && (ffx?.live.length || winds.length || this._pulses?.length)
            ? html`<svg
                class="plan fxsvg"
                style=${styleMap({ left: `${vb.x}px`, top: `${vb.y}px`, width: `${vb.w}px`, height: `${vb.h}px` })}
                viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"
                aria-hidden="true"
              >
                ${ffx?.live.length ? svg`<g class="ffxs">${ffx.live}</g>` : nothing}
                ${this._pulses?.length
                  ? svg`<g class="hrpulses">${repeat(
                      this._pulses,
                      (p) => p.key,
                      (p) => svg`<circle class="hrpulse ${p.loop ? 'loop' : ''}" cx=${p.x} cy=${p.y} r="40" style=${`stroke:${p.color};fill:${p.color}`}></circle>`,
                    )}</g>`
                  : nothing}
                ${winds.length && !this.glFloor ? svg`<g class="winds">${winds}</g>` : nothing}
              </svg>`
            : nothing}
          ${floor && show3d && !this.useGl
            ? html`<div class="walls3d">${guard([floor, key3d], () => renderWalls3d(floor, opts3d))}</div>
                <div class="furn3d">${guard([floor, key3d], () => renderFurniture3d(floor, opts3d))}</div>`
            : nothing}
          </div>
        </div>
        ${this.useGl ? html`<canvas class="gl" ?hidden=${!(floor && show3d)}></canvas>` : nothing}
        <div class="world world-top">
          <div class=${stageCls} style=${stageStyle}>
          <div class="labels" aria-hidden="true">${this.hideLabels ? nothing : repeat(rooms, (r) => r.id, (r) => this.renderLabel(r))}</div>
          ${floor ? this.renderKb(floor) : nothing}
          <div class="devices" aria-hidden="true">${repeat(floor?.devices ?? [], (d) => d.id, (d) => this.renderDevice(d))}${this.renderWindowAlerts()}${this.renderPetChips()}${this.renderInfoChips()}${this.renderStairChips()}${this.renderStackChips()}</div>
          ${this.overlayHtml ?? nothing}
          </div>
        </div>
        ${!rooms.length && !this.editing ? html`<div class="empty">${t('card.empty')}</div>` : nothing}
        ${this.renderBadge()}
        ${this.stats ? html`<div class="stats">${this.statsText}</div>` : nothing}
      </div>
    `;
  }

  /** Current temperature of a room (sensor, else the thermostat's reading) */
  private roomTemp(room: RoomConfig): number | undefined {
    const temp = room.temperature ? this.getState(room.temperature) : undefined;
    const climate = room.climate ? this.getState(room.climate) : undefined;
    const v = temp && !isUnavailable(temp) ? parseFloat(temp.state) : climate?.attributes.current_temperature;
    return v != null && !isNaN(v) ? v : undefined;
  }

  /** Label style "wall" in 3D: the values are engraved into walls / the floor instead of labels */
  private get engraved(): boolean {
    return this.labelStyle === 'wall' && this.is3d && !this.editing && !!this.useGl;
  }

  private renderLabel(room: RoomConfig) {
    if (room.hide_label || room.points.length < 3) return nothing;
    // label style "wall" (3D): values are engraved into walls or the floor — no floating labels
    if (this.engraved) return nothing;
    // outdoor areas only get a label when they show something (temperature, sensors)
    if (room.outdoor && !room.temperature && !room.humidity && !room.climate && !room.sensors?.length) return nothing;
    const { point, width } = this.labelFor(room);
    const temp = room.temperature ? this.getState(room.temperature) : undefined;
    const climate = room.climate ? this.getState(room.climate) : undefined;
    const tempVal = temp && !isUnavailable(temp) ? parseFloat(temp.state) : climate?.attributes.current_temperature;
    const status = this.roomStatus(room);
    const chips: TemplateResult[] = [];
    if (climate && !isUnavailable(climate)) {
      const heating = climate.attributes.hvac_action === 'heating';
      const off = climate.state === 'off';
      const target = climate.attributes.temperature;
      chips.push(html`<span class="chip-v ${heating ? 'heat' : ''} ${off ? 'off' : ''}">
        <ha-icon .icon=${heating ? 'mdi:fire' : off ? 'mdi:radiator-off' : 'mdi:thermostat'}></ha-icon>${off || target == null
          ? t('climate.off')
          : `${formatNumber(target, Number.isInteger(target) ? 0 : 1)}°`}
      </span>`);
    }
    if (room.humidity) {
      const h = this.getState(room.humidity);
      if (h && !isUnavailable(h))
        chips.push(html`<span class="chip-v"><ha-icon icon="mdi:water-percent"></ha-icon>${Math.round(parseFloat(h.state))} %</span>`);
    }
    for (const v of room.sensors ?? []) {
      const s = this.getState(v.entity);
      if (!s || isUnavailable(s)) continue;
      if (domainOf(v.entity) === 'binary_sensor') {
        if (!isActive(s)) continue;
        chips.push(html`<span class="chip-v alert" title=${entityName(this.hass, v.entity, s)}>
          <ha-icon .icon=${v.icon ?? binaryIcon(s)}></ha-icon>${v.name ?? ''}
        </span>`);
      } else {
        chips.push(html`<span class="chip-v"><ha-icon .icon=${v.icon ?? s.attributes.icon ?? 'mdi:gauge'}></ha-icon>${formatState(this.hass, s)}</span>`);
      }
    }
    const place = this.labelFor(room);
    // Shrink inside labels when the room is small on screen: world-scale = min(1/s, roomWidth / 150).
    const maxScale = place.tip ? '99' : (width / 150).toFixed(4);
    const at = place.tip ?? point;
    // Outside labels sit beside the tip, away from the wall (direction in screen space incl. view rotation)
    let ax = 0;
    let ay = 0;
    if (place.normal) {
      const r = (this.spin * Math.PI) / 180;
      ax = place.normal[0] * Math.cos(r) - place.normal[1] * Math.sin(r);
      ay = place.normal[0] * Math.sin(r) + place.normal[1] * Math.cos(r);
      if (Math.abs(ax) > 0.75) [ax, ay] = [Math.sign(ax), 0];
      else if (Math.abs(ay) > 0.75) [ax, ay] = [0, Math.sign(ay)];
    }
    return html`<div
      class="label ${this._focusId === room.id ? 'focused' : ''} ${this._badge === room.id ? 'badged' : ''} ${this.labelTap && room.climate && !this.editing ? 'tap' : ''} ${this.isPressed('label', room.id) ? 'pressed' : ''} ${status.lightsOn ? 'lit' : ''} ${room.floor && room.floor.type !== 'none' ? 'on-floor' : ''} ${place.tip ? 'outside' : ''} ${ay > 0.5 ? 'front' : ''} ${place.pinned ? 'pinned' : ''} ${this.isSelected('room', room.id) ? 'sel' : ''}"
      data-label=${room.id}
      style=${`left:${at[0]}px;top:${at[1]}px;--max:${maxScale};--ax:${ax.toFixed(3)};--ay:${ay.toFixed(3)}`}
    >
      ${this.labelBody(room, tempVal, chips)}
    </div>`;
  }

  private labelBody(room: RoomConfig, tempVal: number | undefined, chips: TemplateResult[]) {
    return html`<div class="name">${room.name ?? this.hass?.areas?.[room.area ?? '']?.name ?? ''}</div>
      ${tempVal != null && !isNaN(tempVal) ? html`<div class="temp num">${formatNumber(tempVal)}°</div>` : nothing}
      ${chips.length ? html`<div class="chips">${chips}</div>` : nothing}`;
  }

  /** Room view: the room's label at the top of the card, clear of the room */
  private renderBadge() {
    const room = this._badge ? this.floor?.rooms.find((r) => r.id === this._badge) : undefined;
    if (!room || room.hide_label) return nothing;
    return html`<div class="focus-badge">${this.renderLabel(room)}</div>`;
  }

  /** washer, dryer, dishwasher: redraw when their history or "Gesehen" marks arrive, and every 30 s while one runs */
  private applWho = () => this.requestUpdate();
  private unAppl?: () => void;

  /** Car, home battery, solar, mower, washer: a small chip with the live values above the piece */
  private renderInfoChips() {
    const floor = this.floor;
    if (!floor || this.editing) return nothing;
    const out: TemplateResult[] = [];
    let applBusy = false;
    let applDone = false;
    /** appliance chips already placed (x, y, level): a neighbour's chip goes one row higher instead of covering it */
    const placed: [number, number, number][] = [];
    const pct = (v?: number) => (v == null ? '–' : `${Math.round(v)} %`);
    const pw = (w?: number) => (w == null ? '' : Math.abs(w) >= 1000 ? `${formatNumber(w / 1000, 1)} kW` : `${Math.round(w)} W`);
    for (const f of floor.furniture ?? []) {
      const r = resolveFurniture(f);
      const kind = r.k?.kind;
      const appl = !!kind && APPLIANCE_KINDS.has(kind);
      const def = kind === 'car' || kind === 'home_battery' || kind === 'solar_panels' || kind === 'lawn_mower' || appl;
      if (!(f.show_value ?? def) || !(f.entity || f.entities)) continue;
      if (this._focusId) {
        const room = floor.rooms.find((x) => x.id === this._focusId);
        if (room && !pointInPolygon([f.x, f.y], room.points)) continue;
      }
      let icon = 'mdi:information-outline';
      let text = '';
      let cls = '';
      let extra = '';
      let tap = '';
      const get = (id?: string) => (id ? this.getState(id) : undefined);
      if (kind === 'car') {
        const c = carLive(f, this.getState);
        const name = f.name ? `${f.name} · ` : '';
        if (c.away) {
          icon = 'mdi:map-marker-outline';
          text = `${name}${t('car.away')}${c.where ? ` · ${c.where}` : ''}`;
          cls = 'away';
        } else if (c.charging) {
          icon = 'mdi:battery-charging';
          text = `${name}${pct(c.soc)} · ${t('car.charging')}${c.power ? ` · ${pw(c.power)}` : ''}`;
          cls = 'charge';
        } else if (c.low) {
          icon = 'mdi:battery-alert-variant-outline';
          text = `${name}${t('car.empty')} · ${pct(c.soc)}`;
          cls = 'warn';
        } else {
          icon = c.soc == null ? 'mdi:car' : `mdi:battery${c.soc >= 95 ? '' : `-${Math.max(10, Math.round(c.soc / 10) * 10)}`}`;
          text = `${name}${pct(c.soc)}${c.range != null ? ` · ${Math.round(c.range)} km` : ''}`;
        }
      } else if (kind === 'home_battery') {
        const soc = numOf(get(f.entity));
        const p = (numOf(get(f.entities?.power)) ?? 0) * (f.invert_power ? -1 : 1);
        icon = p > 20 ? 'mdi:battery-arrow-up' : p < -20 ? 'mdi:battery-arrow-down' : 'mdi:home-battery-outline';
        text = `${pct(soc)}${Math.abs(p) > 20 ? ` · ${p > 0 ? '+' : '−'}${pw(Math.abs(p))}` : ''}`;
        cls = p > 20 ? 'charge' : (soc ?? 100) <= 15 ? 'warn' : '';
      } else if (kind === 'solar_panels') {
        const p = numOf(get(f.entity)) ?? 0;
        icon = p > 5 ? 'mdi:solar-power-variant' : 'mdi:solar-power-variant-outline';
        text = p > 5 ? pw(p) : t('energy.no_sun');
        cls = p > 5 ? 'sun' : 'away';
      } else if (kind === 'lawn_mower') {
        const st = get(f.entity)?.state ?? '';
        icon = st === 'error' ? 'mdi:alert-outline' : 'mdi:robot-mower-outline';
        text = t(st === 'mowing' ? 'mower.mowing' : st === 'returning' ? 'mower.returning' : st === 'error' ? 'mower.error' : st === 'paused' ? 'mower.paused' : 'mower.docked');
        cls = st === 'error' ? 'warn' : st === 'mowing' ? 'charge' : 'away';
      } else if (appl && this.hass) {
        // washer, dryer, dishwasher: only while it runs (minutes left) or is done and nobody has seen it yet
        this.unAppl ??= applianceWatch.listen(this.applWho);
        const a = applianceStatus(this.hass, f, kind, this.getState);
        if (a.phase === 'idle') continue;
        applBusy = true;
        icon = kind === 'dryer' ? 'mdi:tumble-dryer' : kind === 'dishwasher' ? 'mdi:dishwasher' : 'mdi:washing-machine';
        if (a.phase === 'done') {
          applDone = true;
          icon = 'mdi:check-circle';
          text = t('appliance.done');
          cls = 'appl done';
          tap = f.id;
        } else if (a.phase === 'paused') {
          text = t('appliance.paused');
          cls = 'appl away';
        } else {
          text =
            a.mins != null
              ? a.mins <= 90 || a.endAt == null
                ? t('appliance.left', { n: a.mins })
                : t('appliance.until', { time: new Date(a.endAt).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' }) })
              : a.progress != null
                ? t('appliance.running_pct', { n: Math.round(a.progress) })
                : t('appliance.running');
          cls = 'appl run';
          if (a.progress != null) extra = `--p:${Math.max(0, Math.min(100, a.progress))}%`;
        }
      } else continue;
      const away = kind === 'car' && carLive(f, this.getState).away;
      let lift = 0;
      if (appl) {
        while (lift < 3 && placed.some(([x, y, l]) => l === lift && Math.abs(x - f.x) < 160 && Math.abs(y - f.y) < 90)) lift++;
        placed.push([f.x, f.y, lift]);
      }
      const z = this.is3d ? Math.round(r.elevation + (away ? r.height * 0.35 : r.height + (kind === 'car' ? 45 : 30)) + lift * 34) : 0;
      const top = lift && !this.is3d ? `calc(${f.y}px - ${lift * 34}px * var(--fp-inv, 1))` : `${f.y}px`;
      out.push(html`<div class="marker-wrap pet-wrap" data-follow=${kind === 'lawn_mower' ? f.id : ''} style=${`left:${f.x}px;top:${top};--bz:${z}px`}>
        <div class="pet-chip info ${cls} ${extra ? 'prog' : ''}" style=${extra} data-appliance=${tap} data-appl=${appl ? f.id : ''}><ha-icon .icon=${icon}></ha-icon>${text}</div>
      </div>`);
    }
    if (this.unAppl) {
      applianceWatch.clock(this.applWho, applBusy);
      if (applDone) applianceWatch.syncAcks(this.hass);
    }
    return out;
  }

  /** The floor below: its indoor rooms as a faint footprint (outline) or as dashed walls with its stairs (ghost) */
  // ---------- Keyboard and screen readers ----------

  /** Where the focusable items sit (plan units), in reading order: each room, then what is in it; the rest last.
   *  Rebuilt only when the floor changes. */
  private kbSpots(floor: FloorConfig): KbSpot[] {
    if (this.kbGeo?.floor === floor && this.kbGeo.editing === this.editing) return this.kbGeo.items;
    const rooms = floor.rooms.filter((r) => r.points.length >= 3 && (r.kind !== 'plot' || this.editing));
    const spot = (r: RoomConfig): Point => (r.label && pointInPolygon(r.label, r.points) ? r.label : polylabel(r.points));
    // reading order: rows of about a metre, then left to right
    const order = <T extends { x: number; y: number }>(a: T[]) => a.sort((p, q) => Math.round(p.y / 120) - Math.round(q.y / 120) || p.x - q.x);
    const roomSpots = order(
      rooms.map((r) => {
        const [x, y] = spot(r);
        return { id: r.id, x, y, room: r };
      }),
    );
    const things: KbSpot[] = [];
    for (const d of floor.devices) things.push({ kind: 'device', id: d.id, x: d.x, y: d.y });
    for (const f of floor.furniture ?? []) if (f.entity || f.contents?.length || this.editing) things.push({ kind: 'furniture', id: f.id, x: f.x, y: f.y });
    for (const o of floor.openings ?? []) if (o.entity || this.editing) things.push({ kind: 'opening', id: o.id, x: (o.a[0] + o.b[0]) / 2, y: (o.a[1] + o.b[1]) / 2 });
    const inRoom = (p: KbSpot) => roomSpots.find((r) => r.room.kind !== 'plot' && pointInPolygon([p.x, p.y], r.room.points))?.id;
    const items: KbSpot[] = [];
    const left = new Set(things);
    for (const r of roomSpots) {
      items.push({ kind: 'room', id: r.id, x: r.x, y: r.y });
      for (const p of order(things.filter((p) => left.has(p) && inRoom(p) === r.id))) {
        left.delete(p);
        items.push(p);
      }
    }
    items.push(...order([...left]));
    this.kbGeo = { floor, editing: this.editing, items };
    return items;
  }

  /** What a screen reader says for an item: its name and state ("Wohnzimmer, Licht an, 21 °C") */
  private kbLabel(floor: FloorConfig, it: KbSpot): string {
    if (it.kind === 'room') {
      const r = floor.rooms.find((x) => x.id === it.id)!;
      const parts = [r.name || t('editor.room')];
      const st = this.roomStatus(r);
      if (st.lights)
        parts.push(st.lightsOn === 0 || st.lightsOn === st.lights ? t(st.lightsOn ? 'a11y.light_on' : 'a11y.light_off') : t('a11y.lights_some', { n: st.lightsOn, m: st.lights }));
      const temp = this.roomTemp(r);
      if (temp != null) parts.push(`${formatNumber(temp, 1)} °C`);
      const hum = r.humidity ? this.getState(r.humidity) : undefined;
      if (hum && !isUnavailable(hum) && !isNaN(parseFloat(hum.state))) parts.push(t('a11y.humidity', { v: formatNumber(parseFloat(hum.state), 0) }));
      if (this.hrOccupied?.has(r.id)) parts.push(t('a11y.occupied'));
      return parts.join(', ');
    }
    const named = (entity: string | undefined, name: string | undefined, fallback: string) => {
      const s = entity ? this.getState(entity) : undefined;
      const n = name || (entity ? entityName(this.hass, entity, s) : fallback);
      return entity ? `${n}, ${formatState(this.hass, s)}` : n;
    };
    if (it.kind === 'device') {
      const d = floor.devices.find((x) => x.id === it.id)!;
      return named(d.entity, d.name, d.entity);
    }
    if (it.kind === 'furniture') {
      const f = floor.furniture!.find((x) => x.id === it.id)!;
      const k = resolveFurniture(f).k;
      return named(f.entity, f.name, k ? furnitureLabel(k) : f.kind);
    }
    const o = floor.openings!.find((x) => x.id === it.id)!;
    return named(o.entity, o.name, t(o.type === 'window' ? 'editor.window' : o.type === 'garage' ? 'editor.garage_door' : 'editor.door'));
  }

  /** Focusable stand-ins for rooms and devices on top of the plan: Tab enters the plan once, arrows move between
   *  the items by where they are on screen, Enter / Space taps, Shift+Enter or the context menu key holds */
  private renderKb(floor: FloorConfig) {
    const items = this.kbSpots(floor);
    if (!items.length) return nothing;
    const key = (it: KbSpot) => `${it.kind}:${it.id}`;
    const home = this.kbHome && items.some((it) => key(it) === this.kbHome) ? this.kbHome : key(items[0]);
    return html`<div class="kb-layer" role="group" aria-label=${t('a11y.plan', { floor: floor.name })} aria-describedby="kb-help">
      <span id="kb-help" class="sr-only">${t(this.editing ? 'a11y.help_editor' : 'a11y.help')}</span>
      ${repeat(
        items,
        key,
        (it) => html`<div
          class="kb kb-${it.kind} ${this._kbFocus === key(it) ? 'focused' : ''}"
          role="button"
          tabindex=${key(it) === home ? 0 : -1}
          aria-label=${this.kbLabel(floor, it)}
          aria-pressed=${this.editing ? (this.isSelected(it.kind, it.id) ? 'true' : 'false') : nothing}
          data-kb=${key(it)}
          style=${`left:${it.x}px;top:${it.y}px`}
          @focus=${() => {
            this._kbFocus = key(it);
            this.kbHome = key(it);
          }}
          @blur=${() => {
            if (this._kbFocus === key(it)) this._kbFocus = undefined;
          }}
          @keydown=${(e: KeyboardEvent) => this.onKbKey(e, it, items)}
        ></div>`,
      )}
    </div>`;
  }

  private onKbKey(e: KeyboardEvent, it: KbSpot, items: KbSpot[]) {
    const target: HitTarget = { kind: it.kind, id: it.id };
    const w: Point = [it.x, it.y];
    const hold = (e.key === 'Enter' && e.shiftKey) || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
    if (hold) {
      e.preventDefault();
      this.handlers?.onHold?.(target, w);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) this.handlers?.onTap?.(target, w);
      return;
    }
    let next: KbSpot | undefined;
    const i = items.indexOf(it);
    if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key.startsWith('Arrow') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // by what is on screen (the view may be turned or tilted); nothing that way: the next / previous in order
      const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const spots = [...this.renderRoot.querySelectorAll<HTMLElement>('.kb')]
        .map((k) => {
          const r = k.getBoundingClientRect();
          return { item: items.find((x) => `${x.kind}:${x.id}` === k.dataset.kb), x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })
        .filter((s): s is { item: KbSpot; x: number; y: number } => !!s.item && s.item !== it);
      next = spatialNext(spots, { x: el.left + el.width / 2, y: el.top + el.height / 2 }, e.key) ?? items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    } else return;
    e.preventDefault();
    if (!next) return;
    this.kbHome = `${next.kind}:${next.id}`;
    (this.renderRoot.querySelector(`.kb[data-kb="${CSS.escape(this.kbHome)}"]`) as HTMLElement | null)?.focus();
    this.requestUpdate();
  }

  /** The focused room's outline (2D and CSS 3D; in WebGL the stand-in's own ring shows where it is) */
  private kbRing(rooms: RoomConfig[]) {
    const k = this._kbFocus;
    if (!k?.startsWith('room:')) return nothing;
    const r = rooms.find((x) => x.id === k.slice(5));
    return r ? svg`<path class="kb-ring" d=${pointsToPath(r.points)}></path>` : nothing;
  }

  /** The trace image, placed and turned in plan units; never in the way of taps */
  private renderTrace({ t: tr, href }: { t: TraceImage; href: string }) {
    const h = tr.w * (tr.ratio || 1);
    const cx = tr.x + tr.w / 2;
    const cy = tr.y + h / 2;
    return svg`<g class="trace" transform=${`rotate(${tr.rotation ?? 0} ${cx} ${cy})`} style=${`opacity:${Math.max(0.05, Math.min(1, tr.opacity ?? 0.5))}`}>
      <image href=${href} x=${tr.x} y=${tr.y} width=${tr.w} height=${h} preserveAspectRatio="none"></image>
    </g>`;
  }

  /** 2D: the other floors of the stack as faint outlines, offset like sheets lying on top of each other (above: up
   *  and right, below: down and left), the one with something to tell a little clearer, with its mark */
  private renderStack(stack: StackFloor[]) {
    const k = this.stackOffset();
    return svg`<g class="stack" aria-hidden="true">${stack.map((it) => {
      const rooms = it.floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
      if (!rooms.length) return nothing;
      const s = stackSteps(it.dz);
      return svg`<g class="stack-floor ${it.bright ? 'bright' : ''} ${it.severe ? 'severe' : ''}" transform=${`translate(${round(s * k)} ${round(-s * k)})`}>
        <path d=${rooms.map((r) => pointsToPath(r.points)).join(' ')}></path>
        ${it.mark ? svg`<circle class="stack-mark" cx=${it.mark[0]} cy=${it.mark[1]} r=${round(k * 0.45)}></circle>` : nothing}
      </g>`;
    })}</g>`;
  }

  /** The label at the mark of a stacked floor with something to tell: at its height in 3D, on its offset sheet in 2D */
  private renderStackChips() {
    if (this.editing || this._focusId || !this.stack?.length) return nothing;
    const k = this.stackOffset();
    const show3d = this.is3d;
    return this.stack
      .filter((it) => it.mark && it.text && (show3d ? this.gl : true))
      .map((it) => {
        const s = show3d ? 0 : stackSteps(it.dz);
        const x = it.mark![0] + s * k;
        const y = it.mark![1] - s * k;
        return html`<div class="marker-wrap pet-wrap" style=${`left:${round(x)}px;top:${round(y)}px;--bz:${show3d ? Math.round(it.dz + 20) : 0}px`}>
          <div class="pet-chip stack-chip ${it.severe ? 'severe' : ''}" data-stack-piece=${it.piece ?? ''} data-stack-floor=${it.floor.id}><span class="stack-dot"></span>${it.text}<span class="stack-name">${it.floor.name}</span></div>
        </div>`;
      });
  }

  /** How far a neighbouring floor is offset in 2D (plan units) */
  private stackOffset() {
    const b = this.currentBounds();
    return Math.max(18, Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.045);
  }

  /** On screen (px): where a floor lifted by dz in the stack lies relative to the shown one – for the glide when the
   *  focus moves to it (3D: its projected height, 2D: the sheet offset) */
  stackShift(dz: number): { x: number; y: number } {
    const pz = this.panZoom;
    if (!pz || !dz) return { x: 0, y: 0 };
    if (!this.is3d) {
      const k = this.stackOffset() * stackSteps(dz) * pz.view.s;
      return { x: k, y: -k };
    }
    const m = this.viewMatrix(pz.view);
    const [cx, cy] = this.glCenter;
    const a = m.transformPoint(new DOMPoint(cx, cy, 0, 1));
    const b = m.transformPoint(new DOMPoint(cx, cy, dz, 1));
    if (a.w <= 1e-6 || b.w <= 1e-6) return { x: 0, y: 0 };
    return { x: b.x / b.w - a.x / a.w, y: b.y / b.w - a.y / a.w };
  }

  private renderBelow(below: FloorConfig, cls: 'below' | 'below-ghost') {
    const rooms = below.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
    if (!rooms.length) return nothing;
    const d = rooms.map((r) => pointsToPath(r.points)).join(' ');
    const stairs = cls === 'below-ghost' ? (below.furniture ?? []).filter((f) => resolveFurniture(f).k?.kind === 'stairs') : [];
    return svg`<g class=${cls} aria-hidden="true"><path d=${d}></path>${stairs.map(
      (f) => svg`<g class="ghost-piece" transform=${`translate(${f.x} ${f.y}) rotate(${f.rotation ?? 0})`}>${drawFurniture(f)}</g>`,
    )}</g>`;
  }

  /** Stairs to another floor: a small chip "↑ Obergeschoss" above them — a tap goes there. The stairwell of the
   *  stairs coming up from the floor below gets "↓ Erdgeschoss". */
  private renderStairChips() {
    const floor = this.floor;
    if (!floor || this.editing) return nothing;
    const out: TemplateResult[] = [];
    const chip = (f: FurnitureConfig, up: boolean, name: string, to: string | undefined, z: number) =>
      html`<div class="marker-wrap pet-wrap" style=${`left:${f.x}px;top:${f.y}px;--bz:${z}px`}>
        <div class="pet-chip stair" data-stairs=${f.id} data-stairs-to=${to ?? ''}><ha-icon .icon=${up ? 'mdi:stairs-up' : 'mdi:stairs-down'}></ha-icon>${name}</div>
      </div>`;
    for (const f of floor.furniture ?? []) {
      const to = this.stairs?.get(f.id);
      if (!to) continue;
      out.push(chip(f, to.up, to.name, to.to, this.is3d ? Math.round(Math.min(resolveFurniture(f).height, this.effectiveWallHeight) + 30) : 0));
    }
    for (const f of this.stairwells()) out.push(chip(f, false, this.stairsBelow!.name, this.stairsBelow!.to, this.is3d ? 30 : 0));
    return out;
  }

  /** The stairs from the floor below that end on this floor — unless this floor has its own stairs at that spot */
  private stairwells(): FurnitureConfig[] {
    const sb = this.stairsBelow;
    const floor = this.floor;
    if (!sb?.pieces.length || !floor) return [];
    const own = (floor.furniture ?? []).filter((x) => resolveFurniture(x).k?.kind === 'stairs');
    return sb.pieces.filter((f) => !own.some((x) => Math.hypot(x.x - f.x, x.y - f.y) < Math.max(f.w, f.h, x.w, x.h) / 2));
  }

  /** The stairwell: the stairs from below seen from above, faint, with a dashed edge (lies on the floor, also in 3D) */
  private renderStairwells() {
    const list = this.stairwells();
    if (!list.length) return nothing;
    return svg`<g class="stairwell" aria-hidden="true">${list.map(
      (f) => svg`<g transform=${`translate(${f.x} ${f.y}) rotate(${f.rotation ?? 0})`}>
        <g class="sw-steps">${drawFurniture(f)}</g>
        <rect class="sw-edge" x=${-f.w / 2} y=${-f.h / 2} width=${f.w} height=${f.h} rx="3"></rect>
      </g>`,
    )}</g>`;
  }

  /** Pets: "wants to go out" at the front door, "out for a walk" at the pet's place */
  private renderPetChips() {
    const floor = this.floor;
    if (!floor || !this.pets?.size || this.editing) return nothing;
    const z = this.is3d ? Math.round(Math.max(110, this.wallHeight * 1.2)) : 0;
    const out: TemplateResult[] = [];
    for (const f of floor.furniture ?? []) {
      const st = this.pets.get(f.id);
      if (!st || st.mode === 'idle') continue;
      const cat = resolveFurniture(f).k?.kind === 'cat';
      const name = f.name || t(cat ? 'pet.cat' : 'pet.dog');
      let at: Point = [f.x, f.y];
      let text = '';
      if (st.mode === 'due') {
        const door = findFrontDoor(floor, this.frontDoor);
        const way = door ? wayToDoor(floor, [f.x, f.y], door) : undefined;
        if (way) at = way.path[way.path.length - 1];
        text = t('pet.wants_out', { name });
      } else {
        const since = st.awaySince ? new Date(st.awaySince).toLocaleTimeString(getLanguage() === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
        text = t(cat ? 'pet.cat_out' : 'pet.out', { name }) + (since ? ` · ${t('pet.since', { t: since })}` : '');
      }
      out.push(html`<div class="marker-wrap pet-wrap" style=${`left:${at[0]}px;top:${at[1]}px;--bz:${z}px`}>
        <div class="pet-chip ${st.mode}" data-pet=${st.mode === 'due' ? f.id : ''}><ha-icon icon=${st.mode === 'due' ? 'mdi:dog-side' : cat ? 'mdi:cat' : 'mdi:walk'}></ha-icon>${text}${st.mode === 'due' ? html`<ha-icon class="check" icon="mdi:check-circle-outline"></ha-icon>` : nothing}</div>
      </div>`);
    }
    return out;
  }

  /** Quiet value (e.g. outdoor temperature): just the number, no marker or frame */
  private renderValue(d: DeviceConfig) {
    const s = this.getState(d.entity);
    const unit = String(s?.attributes.unit_of_measurement ?? '');
    const n = s && !isUnavailable(s) ? parseFloat(s.state) : NaN;
    const text = !s || isUnavailable(s) ? '–' : /°/.test(unit) && !isNaN(n) ? `${formatNumber(n, 1)}°` : formatState(this.hass, s);
    return html`<div class="marker-wrap value-wrap ${this.isPressed('device', d.id) ? 'pressed' : ''} ${this.isSelected('device', d.id) ? 'selected' : ''} ${this.dimDevice(d) ? 'faint' : ''}" style=${`left:${d.x}px;top:${d.y}px`}>
      <div class="value-tag" data-device=${d.id} role="button" aria-label=${d.name ?? entityName(this.hass, d.entity, s)}>
        <span class="v num">${text}</span>
        ${d.show_name ? html`<span class="n">${d.name ?? entityName(this.hass, d.entity, s)}</span>` : nothing}
      </div>
    </div>`;
  }

  private renderDevice(d: DeviceConfig) {
    if (d.display === 'value') return this.renderValue(d);
    const s = this.getState(d.entity);
    const style = stateStyle(s);
    const unavailable = isUnavailable(s);
    const pressed = this.isPressed('device', d.id);
    const sel = this.isSelected('device', d.id);
    return html`<div
      class="marker-wrap ${pressed ? 'pressed' : ''} ${sel ? 'selected' : ''} ${this.dimDevice(d) ? 'faint' : ''}"
      style=${`left:${d.x}px;top:${d.y}px`}
    >
      <div
        class="marker ${style ? 'on' : ''} ${unavailable ? 'unavailable' : ''}"
        data-device=${d.id}
        role="button"
        aria-label=${d.name ?? entityName(this.hass, d.entity, s)}
        style=${style ? `--c:${style.color};--ink:${style.ink}` : ''}
      >
        ${d.icon || !s || stateIcon(this.hass, s)
          ? html`<ha-icon .icon=${d.icon ?? stateIcon(this.hass, s) ?? 'mdi:help-circle-outline'}></ha-icon>`
          : html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>`}
      </div>
      ${d.show_name || d.show_state
        ? html`<div class="marker-label">
            ${d.show_name ? html`<span class="n">${d.name ?? entityName(this.hass, d.entity, s)}</span>` : nothing}
            ${d.show_state ? html`<span class="s">${formatState(this.hass, s)}</span>` : nothing}
          </div>`
        : nothing}
    </div>`;
  }

  // Tokens are inherited from the top-level host (card / layer), so dark mode cascades.
  static override styles = [
    components,
    css`
      /* under a popup the plan's looping animations rest; open-window warnings keep blinking */
      :host([covered]) :not(.alert-line, .alert, .wb *) {
        animation-play-state: paused !important;
      }
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
        user-select: none;
        -webkit-user-select: none;
      }
      .viewport {
        position: absolute;
        inset: 0;
        touch-action: none;
        overflow: hidden;
        cursor: default;
      }
      .world {
        position: absolute;
        left: 0;
        top: 0;
        width: 0;
        height: 0;
        transform-origin: 0 0;
      }
      .stage {
        position: absolute;
        left: 0;
        top: 0;
        width: 0;
        height: 0;
        transform-style: preserve-3d;
        --fp-tilt: 0deg;
        --fp-lift: 0px;
        --fp-walls: 0;
        /* tilt, spin, wall growth and label lift are animated in JS (applyCam) and written inline */
        transform: perspective(var(--persp)) rotateX(var(--fp-tilt)) rotateZ(var(--fp-spin));
      }
      .labels,
      .devices {
        position: absolute;
        left: 0;
        top: 0;
        transform-style: preserve-3d;
      }
      svg.plan {
        position: absolute;
        overflow: visible;
      }
      /* WebGL draws the floor: the SVG floor stays in place (hit geometry, tests) but is not painted */
      .stage.glfloor svg.plan {
        visibility: hidden;
      }
      .stage.glfloor svg.plan * {
        transition: none !important;
        animation: none !important;
      }
      .stats {
        position: absolute;
        left: 8px;
        bottom: 64px;
        z-index: 3;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.62);
        color: #fff;
        font: 11px/1.35 ui-monospace, Menlo, monospace;
        white-space: pre;
        pointer-events: none;
      }
      canvas.gl {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      /* animated floor effects live in their own layer: the plan below is not repainted every frame */
      svg.fxsvg {
        pointer-events: none;
        will-change: transform;
      }
      .stage.is3d .furniture .blades {
        animation: none;
      }
      :host([editing]) .furn3d {
        pointer-events: auto !important;
      }
      :host([editing]) .furn3d .p3 {
        cursor: move;
      }
      .walls3d,
      .furn3d {
        position: absolute;
        left: 0;
        top: 0;
        transform-style: preserve-3d;
        transform: scaleZ(var(--fp-walls));
        opacity: var(--fp-walls);
        pointer-events: none;
      }
      .p3,
      .b3 {
        position: absolute;
        width: 0;
        height: 0;
        transform-style: preserve-3d;
      }
      .f {
        position: absolute;
        backface-visibility: visible;
      }
      .f.top {
        overflow: hidden;
      }
      .ftop {
        width: 100%;
        height: 100%;
        display: block;
        overflow: visible;
      }
      .glass3d .f {
        background: color-mix(in srgb, var(--fp-glass) 45%, transparent) !important;
        box-shadow: inset 0 0 0 1px var(--fp-glass-edge);
      }
      .f.disc {
        border-radius: 50%;
      }
      /* Walls between the camera and the rooms: same height, translucent */
      /* Dollhouse: walls in front of a focused room slide down */
      .wallp {
        transition: transform var(--fp-dur-slow) var(--fp-ease-in-out);
      }
      .wallp.lowered {
        transform: scaleZ(0.1);
      }
      /* Zoomed onto a room: everything else steps back */
      .p3.faint .f,
      .p3.faint .glass3 {
        opacity: 0.16;
      }
      .p3.hide {
        display: none;
      }
      .marker-wrap.faint .marker {
        opacity: 0.25;
      }
      .faded .f {
        opacity: 0.14;
      }
      .faded .f.top {
        opacity: 0.45;
      }
      .faded .glass3 {
        opacity: 0.5;
      }
      .glass3 {
        position: absolute;
        background: color-mix(in srgb, var(--fp-glass) 55%, transparent);
        box-shadow: inset 0 0 0 2.5px var(--fp-window-frame), inset 0 0 0 3.5px var(--fp-glass-edge);
        border-radius: 2px;
      }
      .glass3.open {
        background: color-mix(in srgb, var(--fp-state-alert) 62%, transparent);
        box-shadow: inset 0 0 0 2.5px var(--fp-window-frame), inset 0 0 0 3.5px var(--fp-state-alert);
      }
      .door3,
      .pane3 {
        transition: transform var(--fp-dur-slow) var(--fp-ease);
      }
      .garage3 {
        transition: transform 1.6s var(--fp-ease);
      }
      .garage3.moving {
        transition-duration: 8s;
        transition-timing-function: linear;
      }
      /* In 3D the extruded walls/furniture replace the flat drawings */
      .walls,
      .furniture,
      .opening .leaf,
      .opening .jamb,
      .opening .mullion,
      .opening .glass,
      .opening .frame,
      .opening .sash {
        opacity: calc(1 - var(--fp-walls));
      }
      .opening.open .sash {
        opacity: calc(1 - var(--fp-walls));
      }
      /* In 3D only the swing area of doors stays on the floor */
      .stage.is3d .opening .threshold,
      .stage.is3d .opening .jamb,
      .stage.is3d .opening .knob,
      .stage.is3d .opening .mullion,
      .stage.is3d .opening.garage .gpanel,
      .stage.is3d .opening.garage .gtrack {
        display: none;
      }
      .stage.focusing .leaders {
        display: none;
      }
      /* Front door warning: open windows blink strongly red */
      .alert-line {
        stroke: #ff3b30;
        stroke-linecap: round;
        fill: none;
        pointer-events: none;
        animation: fp-alert-pulse 1.2s ease-in-out infinite;
      }
      .glass3.alert {
        background: #ff3b30 !important;
        box-shadow: 0 0 22px 8px rgba(255, 59, 48, 0.8), inset 0 0 0 2.5px var(--fp-window-frame) !important;
        animation: fp-alert-pulse 1.2s ease-in-out infinite;
      }
      @keyframes fp-alert-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.35;
        }
      }
      .win-beacon {
        position: absolute;
        width: 0;
        height: 0;
        transform-style: preserve-3d;
        pointer-events: none;
      }
      .wb {
        position: absolute;
        left: -20px;
        top: -20px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ff3b30;
        color: #fff;
        --mdc-icon-size: 22px;
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.9), 0 4px 18px rgba(255, 59, 48, 0.7);
        transform: translateZ(var(--bz, 0px)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt))) scale(var(--fp-inv, 1));
      }
      .wb i {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 3px solid #ff3b30;
        animation: fp-beacon 1.6s ease-out infinite;
      }
      .wb i.r2 {
        animation-delay: 0.8s;
      }
      @keyframes fp-beacon {
        0% {
          transform: scale(1);
          opacity: 0.9;
        }
        100% {
          transform: scale(2.6);
          opacity: 0;
        }
      }
      .bshadow path,
      .ishadow path {
        fill: var(--fp-shadow-tint, #000);
      }
      .ishadow {
        pointer-events: none;
      }
      .bshadow path.soft,
      .ishadow path.soft {
        stroke: var(--fp-shadow-tint, #000);
        stroke-linejoin: round;
        fill: none;
      }
      .night-tint path {
        fill: var(--fp-amb, #6f7bb0);
        opacity: var(--fp-amb-k, 0);
        mix-blend-mode: multiply;
        pointer-events: none;
      }
      .spill {
        fill: url(#fp-spill);
        pointer-events: none;
      }
      .spill-0 {
        stop-color: var(--fp-window-light, #ffc47a);
        stop-opacity: 0.85;
      }
      .spill-1 {
        stop-color: var(--fp-window-light, #ffc47a);
        stop-opacity: 0;
      }
      /* Colored ambient light on the 3D faces (blue hour / night), lamps excepted */
      .stage.amb .walls3d .f::after,
      .stage.amb .furn3d .f::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: var(--fp-amb, #fff);
        opacity: var(--fp-amb-k, 0);
        mix-blend-mode: multiply;
        pointer-events: none;
      }
      .b3.emit .f::after,
      .b3.clear .f::after {
        display: none;
      }
      .bshadow.ambient {
        opacity: 0.08;
      }
      .air {
        fill: none;
        stroke: var(--fp-air);
        stroke-width: 2.5;
        stroke-linecap: round;
        opacity: 0;
        animation: air 2s linear infinite;
        pointer-events: none;
      }
      @keyframes air {
        0% {
          transform: translateX(-80px);
          opacity: 0;
        }
        20% {
          opacity: 0.95;
        }
        75% {
          opacity: 0.55;
        }
        100% {
          transform: translateX(150px);
          opacity: 0;
        }
      }
      .beam {
        pointer-events: none;
        mix-blend-mode: normal;
      }
      .beam-0 {
        stop-color: var(--fp-sun-beam, var(--fp-sunbeam));
      }
      .beam-1 {
        stop-color: var(--fp-sun-beam, var(--fp-sunbeam));
        stop-opacity: 0;
      }
      .grid-line {
        fill: none;
        stroke: var(--fp-grid);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .grid-line.major {
        stroke: var(--fp-grid-major);
      }
      .room {
        fill: var(--fp-room);
      }
      /* outdoor area without a ground material: a soft lawn green */
      .room.outdoor {
        fill: color-mix(in srgb, #8fbf7f 70%, var(--fp-room));
      }
      /* property line: a dashed boundary around a faint ground */
      .room.plot {
        fill: color-mix(in srgb, #8fbf7f 26%, transparent);
        stroke: var(--fp-label-3);
        stroke-width: 1.6;
        stroke-dasharray: 10 6;
        vector-effect: non-scaling-stroke;
      }
      .floor {
        opacity: var(--fp-floor-opacity);
        pointer-events: none;
      }
      .trace {
        pointer-events: none;
      }
      /* keyboard: stand-ins for rooms and devices; visible only with the focus */
      .kb-layer {
        position: absolute;
        left: 0;
        top: 0;
        transform-style: preserve-3d;
      }
      .kb {
        position: absolute;
        width: 44px;
        height: 44px;
        margin: -22px 0 0 -22px;
        border-radius: 50%;
        pointer-events: none;
        outline: none;
      }
      .kb-room {
        width: 20px;
        height: 20px;
        margin: -10px 0 0 -10px;
      }
      .kb:focus-visible {
        box-shadow: 0 0 0 3px var(--fp-surface), 0 0 0 6px var(--fp-accent);
      }
      .kb-room:focus-visible {
        background: var(--fp-accent);
      }
      .kb-ring {
        fill: var(--fp-accent);
        fill-opacity: 0.1;
        stroke: var(--fp-accent);
        stroke-width: 4;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      /* Furniture: quiet top views */
      .furniture {
        pointer-events: none;
      }
      :host([editing]) .furniture .piece {
        pointer-events: visiblePainted;
        cursor: move;
      }
      /* Linked pieces: tappable, live state */
      .furniture .piece.linked,
      .furn3d .p3.linked {
        pointer-events: auto;
        cursor: pointer;
      }
      /* unlinked pieces take the tap too (so it does not fall through to the room), rugs excepted */
      .furniture .piece:not(.rug):not(.linked) {
        pointer-events: visiblePainted;
      }
      .fhit {
        fill: transparent;
        pointer-events: all;
      }
      /* 3D: only the device's own body reacts, never its footprint on the floor */
      .stage.is3d .furniture .piece,
      .stage.is3d .fhit {
        pointer-events: none;
      }
      .piece.pressed,
      .p3.linked.pressed {
        opacity: 0.6;
      }
      .piece.fx-light .bulb,
      .piece.fx-media .bulb {
        fill: var(--glow) !important;
      }
      .piece.fx-heat .bulb {
        fill: #ff8a4c !important;
      }
      .piece.fx-power .bulb,
      .piece.fx-cool .bulb,
      .piece.fx-air .bulb,
      .piece.fx-fan .bulb {
        fill: var(--glow) !important;
      }
      .blades {
        transform-box: fill-box;
        transform-origin: center;
      }
      .fx-fan .blades {
        animation: fp-spin 0.9s linear infinite;
      }
      @keyframes fp-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .b3.emit .f {
        box-shadow: 0 0 calc(4px + 14px * var(--gk, 1)) color-mix(in srgb, var(--glow) 70%, transparent);
      }
      .p3.fx-heat .b3.emit .f,
      .p3.fx-cool .b3.emit .f,
      .p3.fx-air .b3.emit .f,
      .p3.fx-fan .b3.emit .f,
      .p3.fx-media .b3.emit .f,
      .p3.fx-power .b3.emit .f {
        box-shadow: 0 0 8px color-mix(in srgb, var(--glow) 55%, transparent);
      }
      .b3.clear .f {
        box-shadow: none !important;
      }

      .ffxs {
        pointer-events: none;
      }
      /* a tapped lamp: one short, light bounce */
      .pb.bounce {
        transform-box: fill-box;
        transform-origin: center;
        animation: fp-bounce 450ms ease-out;
      }
      .b3.bounce {
        animation: fp-bounce-3d 450ms ease-out;
      }
      @keyframes fp-bounce {
        40% {
          transform: scale(1.1);
        }
      }
      @keyframes fp-bounce-3d {
        40% {
          scale: 1.1 1.1 1.1;
        }
      }
      /* Hausregeln: a rule has just switched something here */
      .hrpulse {
        fill-opacity: 0.18;
        stroke-width: 4;
        vector-effect: non-scaling-stroke;
        transform-box: fill-box;
        transform-origin: center;
        opacity: 0;
        animation: fp-hr-pulse 1.3s ease-out forwards;
        pointer-events: none;
      }
      .hrpulse.loop {
        animation-iteration-count: infinite;
      }
      @keyframes fp-hr-pulse {
        0% {
          transform: scale(0.35);
          opacity: 0.95;
        }
        100% {
          transform: scale(1.6);
          opacity: 0;
        }
      }
      .ffx.light,
      .ffx.media {
        mix-blend-mode: var(--fp-lamp-blend, normal);
      }
      .ffx .shimmer {
        fill: none;
        stroke-width: 3;
        vector-effect: non-scaling-stroke;
        filter: none;
        opacity: 0.7;
      }
      .ffx .breathe {
        animation: fp-breathe 3.2s ease-in-out infinite;
      }
      @keyframes fp-breathe {
        50% {
          opacity: 0.55;
        }
      }
      .ffx .ripple {
        transform-box: fill-box;
        transform-origin: center;
        animation: fp-ripple 2.4s ease-out infinite;
      }
      @keyframes fp-ripple {
        0% {
          transform: scale(0.6);
          opacity: 0;
        }
        40% {
          opacity: 1;
        }
        100% {
          transform: scale(1.15);
          opacity: 0;
        }
      }
      .ffx .ring {
        fill: none;
        stroke: var(--fp-air);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        transform-box: fill-box;
        transform-origin: center;
        opacity: 0;
        animation: fp-ring 3.6s ease-out infinite;
      }
      @keyframes fp-ring {
        0% {
          transform: scale(0.5);
          opacity: 0;
        }
        25% {
          opacity: 0.8;
        }
        100% {
          transform: scale(2.6);
          opacity: 0;
        }
      }
      .fstreak {
        fill: none;
        stroke-width: 2.5;
        stroke-linecap: round;
        stroke: var(--fp-air);
        opacity: 0;
        animation: fp-stream 1.6s linear infinite;
      }
      .fstreak.cool {
        stroke: #6cc0ff;
      }
      .fstreak.warm {
        stroke: #ec3b26;
        stroke-width: 1.8;
      }
      @keyframes fp-stream {
        0% {
          transform: translateY(-10px);
          opacity: 0;
        }
        25% {
          opacity: 0.85;
        }
        100% {
          transform: translateY(70px);
          opacity: 0;
        }
      }
      .ffx.water .ring {
        stroke: var(--fp-blue);
      }
      /* irrigation zone: its area, tinted while it waters */
      .zone {
        fill: var(--fp-blue);
        fill-opacity: 0.05;
        stroke: var(--fp-blue);
        stroke-opacity: 0.45;
        stroke-width: 1.2;
        stroke-dasharray: 6 5;
        vector-effect: non-scaling-stroke;
        transition: fill-opacity var(--fp-dur-slow) var(--fp-ease);
      }
      .zone.on {
        fill-opacity: 0.13;
        stroke-opacity: 0.9;
        stroke-dasharray: none;
      }
      /* gates and garage doors placed as pieces: leaves turn, the door's run grows (transitions) */
      .piece .gleaf,
      .piece .gtrack {
        transform-origin: 0 0;
        transition: transform 1.6s var(--fp-ease);
      }
      .piece .gpanel {
        transition: opacity 1.6s var(--fp-ease);
      }
      .piece .gtrack rect {
        fill: var(--fp-label);
        fill-opacity: 0.06;
        stroke: var(--fp-label-3);
        stroke-width: 1;
        stroke-dasharray: 4 3;
        vector-effect: non-scaling-stroke;
      }
      .piece .gtrack.alert rect {
        fill: var(--fp-state-alert);
        fill-opacity: 0.16;
        stroke: var(--fp-state-alert);
        stroke-dasharray: none;
      }
      /* a car's open tailgate, frunk, sunroof, doors, windows */
      .piece .car-open {
        fill: var(--fp-red);
        fill-opacity: 0.85;
        stroke: #fff;
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      @media (prefers-reduced-motion: reduce) {
        .fx-fan .blades,
        .ffx .breathe,
        .ffx .ripple,
        .ffx .ring,
        .fstreak {
          animation: none;
        }
        .ffx .ring,
        .fstreak {
          opacity: 0.4;
        }
      }
      .piece-sel {
        fill: none;
        stroke: var(--fp-accent);
        stroke-width: 2;
        stroke-dasharray: 5 4;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }

      /* Doors & windows */
      .opening .hit {
        stroke: transparent;
        stroke-linecap: round;
        pointer-events: stroke;
        cursor: pointer;
      }
      .opening .threshold {
        fill: var(--fp-frame);
      }
      .opening .jamb,
      .opening .mullion {
        fill: var(--fp-frame-edge);
      }
      .opening .frame {
        fill: var(--fp-window-frame);
        stroke: var(--fp-frame-edge);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .opening .glass {
        fill: var(--fp-glass);
        stroke: var(--fp-glass-edge);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        transition: opacity var(--fp-dur-slow) var(--fp-ease);
      }
      .opening .leaf,
      .opening .sash {
        transform-origin: 0 0;
        transition: transform var(--fp-dur-slow) var(--fp-ease);
      }
      .opening .leaf rect {
        fill: var(--fp-door-2d, var(--fp-door));
        stroke: var(--fp-door-edge);
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }
      .opening .knob {
        fill: var(--fp-door-edge);
      }
      .opening .sash rect {
        fill: var(--fp-window-frame);
        stroke: var(--fp-glass-edge);
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }
      .opening .sash {
        opacity: 0;
      }
      .opening.open .sash,
      .opening.preview .sash {
        opacity: 1;
      }
      .opening.preview:not(.open) .swing {
        opacity: 0.05;
      }
      .opening.preview:not(.open) .sash rect {
        stroke: var(--fp-label-3);
      }
      .opening .swing {
        fill: var(--fp-label);
        opacity: 0;
        transition: opacity var(--fp-dur-slow) var(--fp-ease);
        pointer-events: none;
      }
      .opening .arc {
        fill: none;
        stroke: var(--fp-label-3);
        stroke-width: 1;
        stroke-dasharray: 3 3;
        vector-effect: non-scaling-stroke;
        opacity: 0;
        transition: opacity var(--fp-dur-slow) var(--fp-ease);
      }
      /* a passage ("Wand weg"): only a faint line where the rooms meet; marked while selected in the editor */
      .opening.passage .threshold {
        stroke: var(--fp-label-3, rgba(60, 60, 67, 0.3));
        stroke-width: 1.2;
        stroke-dasharray: 6 6;
        opacity: 0.45;
        fill: none;
        pointer-events: none;
      }
      .opening.passage.selected .threshold {
        stroke: var(--fp-accent);
        stroke-width: 3;
        opacity: 1;
      }
      /* closed door: the architect's dashed swing, so it never reads as a window */
      .opening.door.closed .arc {
        opacity: 0.45;
      }
      .opening.door.unknown .swing {
        opacity: 0.035;
      }
      .opening.door.unknown .arc {
        opacity: 0.8;
      }
      .opening.open .swing {
        fill: var(--fp-state-alert);
        opacity: 0.13;
      }
      .opening.open .arc {
        stroke: var(--fp-state-alert);
        opacity: 0.7;
      }
      .opening.open .leaf rect {
        stroke: var(--fp-state-alert);
        stroke-width: 1.6;
      }
      .opening.open .knob {
        fill: var(--fp-state-alert);
      }
      .opening.open .glass {
        fill: var(--fp-state-alert);
        opacity: 0.55;
      }
      .opening.open .sash rect {
        stroke: var(--fp-state-alert);
      }
      /* garage door: the door in the wall, and the part gone up inside growing from the wall as it opens */
      .opening.garage .gtrack {
        transform-origin: 0 0;
        transition: transform 1.6s var(--fp-ease);
      }
      .opening.garage .gtrack rect {
        fill: var(--fp-label);
        fill-opacity: 0.06;
        stroke: var(--fp-label-3);
        stroke-width: 1;
        stroke-dasharray: 4 3;
        vector-effect: non-scaling-stroke;
      }
      .opening.garage .gtrack line,
      .opening.garage .gpanel line {
        stroke: var(--fp-door-edge);
        stroke-width: 0.8;
        vector-effect: non-scaling-stroke;
      }
      .opening.garage .gpanel {
        transition: opacity 1.6s var(--fp-ease);
      }
      .opening.garage .gpanel rect {
        fill: var(--fp-door-2d, var(--fp-door));
        stroke: var(--fp-door-edge);
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }
      .opening.garage.open .gtrack rect {
        fill: var(--fp-state-alert);
        fill-opacity: 0.16;
        stroke: var(--fp-state-alert);
        stroke-dasharray: none;
      }
      .opening.garage.open .gtrack line {
        stroke: var(--fp-state-alert);
        stroke-opacity: 0.5;
      }
      .opening.garage.open .gpanel rect {
        stroke: var(--fp-state-alert);
      }
      .opening.garage.moving .gtrack rect {
        animation: fp-garage-run 0.9s ease-in-out infinite alternate;
      }
      @keyframes fp-garage-run {
        to {
          fill-opacity: 0.32;
        }
      }
      .opening.selected .threshold,
      .opening.selected .frame {
        stroke: var(--fp-accent);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .glow {
        fill: url(#fp-glow);
        opacity: calc(var(--fp-glow-opacity) * var(--k));
        transition: opacity var(--fp-dur-slow) var(--fp-ease);
        pointer-events: none;
      }
      .glow-stop-0 {
        stop-color: var(--fp-glow);
      }
      .glow-stop-1 {
        stop-color: var(--fp-glow-edge);
        stop-opacity: var(--fp-glow-edge-opacity);
      }
      .press {
        fill: var(--fp-label);
        opacity: 0;
        transition: opacity var(--fp-dur-fast) var(--fp-ease);
        pointer-events: none;
      }
      .press.on {
        opacity: 0.06;
      }
      .wall {
        fill: none;
        stroke: var(--wall-paint, var(--fp-wall));
        stroke-linejoin: round;
        stroke-linecap: round;
        pointer-events: none;
      }
      /* a wall standing on its own ("Wand ziehen"); a half-height one a little lighter from above */
      .wall.free {
        stroke-linecap: square;
      }
      .wall.free.half {
        opacity: 0.6;
      }

      /* Labels: constant on-screen size, shrink in small rooms */
      .label {
        position: absolute;
        transform-origin: 0 0;
        transform: translateZ(var(--fp-lift)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt)))
          scale(min(var(--fp-inv, 1), var(--max, 1))) translate(calc(-50% + var(--ax, 0) * 50%), calc(-50% + var(--ay, 0) * 50%));
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        pointer-events: none;
        text-align: center;
        white-space: nowrap;
      }
      .label {
        text-shadow: 0 0 2px var(--fp-room), 0 0 6px var(--fp-room), 0 0 12px var(--fp-room);
      }
      /* Editor: labels can be dragged to pin them */
      :host([editing]) .label {
        pointer-events: auto;
        cursor: move;
        touch-action: none;
      }
      :host([editing]) .label.sel {
        box-shadow: 0 0 0 2px var(--fp-accent), var(--fp-shadow-2);
        border-radius: var(--fp-radius-m);
      }
      :host([editing]) .label.pinned::after {
        /* pinned marker */
        content: '';
        position: absolute;
        top: -4px;
        right: -4px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--fp-accent);
        box-shadow: 0 0 0 2px var(--fp-surface);
      }
      /* 3D: a thin stem from a floating outside label down to the end of its leader on the floor */
      .label.outside::before {
        content: '';
        position: absolute;
        left: calc(50% - var(--ax, 0) * 50% - 0.75px);
        top: 100%;
        width: 1.5px;
        height: max(0px, calc(var(--fp-lift) * sin(var(--fp-tilt)) * var(--fp-scale, 1) - 50% * (1 + var(--ay, 0))));
        background: var(--fp-label-3);
        opacity: var(--fp-walls);
        pointer-events: none;
      }
      .label.outside.front::before {
        display: none;
      }
      .focus-dim {
        fill: var(--fp-plan-bg);
        opacity: 0.62;
        pointer-events: none;
        animation: fp-fade var(--fp-dur-slow) var(--fp-ease) both;
      }
      @keyframes fp-fade {
        from {
          opacity: 0;
        }
      }
      .stage.focusing .label:not(.focused) {
        opacity: 0.2;
      }
      /* labels that open the heating */
      .label.tap {
        pointer-events: auto;
        cursor: pointer;
      }
      .label.tap.pressed {
        filter: brightness(0.9);
      }
      .labels.moving .label,
      .label.badged {
        pointer-events: none !important;
      }
      /* optional: labels fade out while the view moves */
      .labels {
        transition: opacity 180ms var(--fp-ease);
      }
      .labels.moving {
        opacity: 0;
      }
      /* room view: the room's label sits at the top instead of in the scene */
      .label.badged {
        opacity: 0 !important;
      }
      .focus-badge {
        position: absolute;
        top: 10px;
        left: 50%;
        z-index: 2;
        transform: translateX(-50%);
        pointer-events: none;
        animation: fp-badge-in 220ms var(--fp-ease) both;
      }
      @media (max-width: 560px) {
        .focus-badge {
          top: 58px;
        }
      }
      .focus-badge .label {
        position: static;
        transform: none;
        opacity: 1 !important;
        text-shadow: none;
        padding: var(--fp-space-2) var(--fp-space-4);
        border-radius: var(--fp-radius-m);
        background: color-mix(in srgb, var(--fp-surface) 92%, transparent);
        box-shadow: var(--fp-shadow-2);
      }
      .focus-badge .label::before {
        display: none;
      }
      @keyframes fp-badge-in {
        from {
          opacity: 0;
          transform: translate(-50%, -6px);
        }
      }
      .label,
      .leaders {
        transition: opacity var(--fp-dur) var(--fp-ease);
      }
      .leader {
        stroke: var(--fp-label-3);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      .pin {
        fill: var(--fp-surface);
        stroke: var(--fp-label-3);
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
      }
      /* Floating callouts in 3D, on textured floors and outside the building */
      .stage.is3d .label,
      .label.on-floor,
      .label.outside {
        text-shadow: none;
        padding: var(--fp-space-2) var(--fp-space-3);
        border-radius: var(--fp-radius-m);
        background: color-mix(in srgb, var(--fp-surface) 90%, transparent);
        box-shadow: var(--fp-shadow-2);
      }
      .label .name {
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
        letter-spacing: 0.01em;
        /* a long room name must not cover its neighbours (the room popup shows it in full) */
        max-width: 11em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .label .temp {
        font-size: var(--fp-text-title1);
        font-weight: var(--fp-weight-medium);
        letter-spacing: var(--fp-tracking-tight);
        line-height: 1.05;
        color: var(--fp-label);
      }
      .label .chips {
        display: flex;
        gap: var(--fp-space-2);
        margin-top: 2px;
      }
      .chip-v {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-medium);
        color: var(--fp-label-2);
        font-variant-numeric: tabular-nums;
      }
      .chip-v ha-icon {
        --mdc-icon-size: 15px;
      }
      .chip-v.heat {
        color: var(--fp-state-heat);
      }
      .chip-v.off {
        color: var(--fp-label-3);
      }
      .chip-v.alert {
        color: var(--fp-state-alert);
      }

      /* Device markers */
      .marker-wrap {
        position: absolute;
        width: 0;
        height: 0;
        transform-style: preserve-3d;
      }
      .marker {
        position: absolute;
        left: 0;
        top: 0;
        width: var(--fp-marker);
        height: var(--fp-marker);
        margin: calc(var(--fp-marker) / -2) 0 0 calc(var(--fp-marker) / -2);
        border-radius: var(--fp-radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-surface);
        color: var(--fp-label-2);
        box-shadow: var(--fp-shadow-2);
        transform: translateZ(var(--fp-lift)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt))) scale(var(--fp-inv, 1));
        transition: transform var(--fp-dur-fast) var(--fp-ease), opacity var(--fp-dur) var(--fp-ease);
        cursor: pointer;
        overflow: hidden;
      }
      .marker::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: var(--c, transparent);
        opacity: 0;
        transition: opacity var(--fp-dur) var(--fp-ease);
      }
      .marker.on::before {
        opacity: 1;
      }
      .marker.on {
        color: var(--ink, #fff);
      }
      .marker ha-state-icon,
      .marker ha-icon {
        position: relative;
        --mdc-icon-size: var(--fp-icon);
      }
      .marker.unavailable {
        opacity: 0.4;
      }
      .marker-wrap.pressed .marker {
        transform: translateZ(var(--fp-lift)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt)))
          scale(calc(var(--fp-inv, 1) * 0.9));
      }
      .marker-wrap.selected .marker {
        box-shadow: 0 0 0 3px var(--fp-surface), 0 0 0 6px var(--fp-accent), var(--fp-shadow-2);
      }
      /* the floor below: a faint footprint for context (also in the 3D floor texture) */
      .below path {
        fill: var(--fp-label);
        fill-opacity: 0.035;
        stroke: var(--fp-label);
        stroke-opacity: 0.26;
        stroke-width: 3;
        stroke-dasharray: 16 10;
        stroke-linejoin: round;
      }
      /* editor: the floor below as dashed walls over everything, so the walls above line up */
      .below-ghost {
        pointer-events: none;
      }
      /* the other floors of the stack (2D): faint offset outlines, never in the way */
      .stack {
        pointer-events: none;
      }
      .stack-floor > path {
        fill: var(--fp-label);
        fill-opacity: 0.03;
        stroke: var(--fp-label);
        stroke-opacity: 0.18;
        stroke-width: 1.5;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }
      .stack-floor.bright > path {
        fill-opacity: 0.06;
        stroke-opacity: 0.34;
      }
      .stack-mark {
        fill: var(--fp-orange);
      }
      .pet-chip.stack-chip {
        gap: 6px;
        pointer-events: auto;
        cursor: pointer;
      }
      .stack-chip .stack-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--fp-orange);
        flex: none;
      }
      .stack-chip.severe .stack-dot {
        background: var(--fp-red);
      }
      .stack-chip .stack-name {
        color: var(--fp-label-2);
        font-weight: 500;
      }
      .stack-chip .stack-name::before {
        content: '· ';
      }
      .stack-floor.severe .stack-mark {
        fill: var(--fp-red);
      }
      .below-ghost > path {
        fill: none;
        stroke: var(--fp-accent);
        stroke-opacity: 0.6;
        stroke-width: 2;
        stroke-dasharray: 7 5;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }
      .below-ghost .ghost-piece {
        opacity: 0.4;
      }
      /* the stairwell of the stairs coming up from the floor below: a faint hint, never in the way */
      .stairwell {
        pointer-events: none;
      }
      .stairwell .sw-steps {
        opacity: 0.32;
      }
      .stairwell .sw-edge {
        fill: none;
        stroke: var(--fp-label);
        stroke-opacity: 0.22;
        stroke-width: 2;
        stroke-dasharray: 9 7;
      }
      /* stairs to another floor */
      .pet-chip.stair {
        pointer-events: auto;
        cursor: pointer;
        padding: 4px 11px 4px 8px;
        font-size: var(--fp-text-caption);
        color: var(--fp-label);
        --mdc-icon-size: 16px;
      }
      .pet-chip.stair ha-icon {
        color: var(--fp-accent);
      }
      /* pets: "wants to go out" / "out for a walk" */
      .pet-chip {
        position: absolute;
        left: 0;
        top: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px 6px 9px;
        border-radius: var(--fp-radius-full);
        white-space: nowrap;
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
        background: color-mix(in srgb, var(--fp-surface) 92%, transparent);
        box-shadow: var(--fp-shadow-2);
        --mdc-icon-size: 18px;
        transform: translateZ(var(--bz, 0px)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt))) translate(-50%, -100%) scale(var(--fp-inv, 1));
        transform-origin: 0 0;
        pointer-events: none;
      }
      /* stays until checked off (a tap on it does that): it calls for attention a few times, then rests */
      .pet-chip.due {
        color: #fff;
        background: #e8892c;
        pointer-events: auto;
        cursor: pointer;
        animation: fp-pet-call 1.6s ease-in-out 5;
      }
      .pet-chip.due ha-icon {
        animation: fp-pet-hop 0.8s ease-in-out 10;
      }
      .pet-chip.due ha-icon.check {
        animation: none;
        margin-left: 2px;
        opacity: 0.9;
      }
      .pet-chip.away {
        color: var(--fp-label-2);
        font-weight: var(--fp-weight-medium);
      }
      .pet-chip.info {
        padding: 4px 10px 4px 7px;
        font-size: var(--fp-text-caption);
        --mdc-icon-size: 16px;
        max-width: 190px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      [data-follow] {
        transition: left 0.25s linear, top 0.25s linear;
      }
      .pet-chip.info.charge ha-icon {
        color: #2fbf63;
        animation: fp-pet-hop 1.6s ease-in-out infinite;
      }
      .pet-chip.info.sun ha-icon {
        color: #e8a92c;
      }
      /* washer, dryer, dishwasher: quiet while running (a thin progress line), a soft green "fertig" until seen */
      .pet-chip.info.appl.run ha-icon {
        color: var(--fp-accent);
      }
      .pet-chip.info.prog {
        background:
          linear-gradient(var(--fp-accent), var(--fp-accent)) left bottom / var(--p, 0%) 2px no-repeat,
          color-mix(in srgb, var(--fp-surface) 92%, transparent);
      }
      .pet-chip.info.appl.done {
        color: #fff;
        background: #2fa55a;
        pointer-events: auto;
        cursor: pointer;
        animation: fp-appl-done 2.4s ease-in-out 6 forwards;
        box-shadow: 0 0 0 4px rgba(47, 165, 90, 0.18), var(--fp-shadow-2);
      }
      @keyframes fp-appl-done {
        50% {
          box-shadow: 0 0 0 8px rgba(47, 165, 90, 0.26), var(--fp-shadow-2);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pet-chip.info.appl.done {
          animation: none;
        }
      }
      .pet-chip.info.warn {
        color: #fff;
        background: #e5483a;
        animation: fp-pet-call 1.6s ease-in-out infinite;
      }
      @keyframes fp-pet-call {
        50% {
          box-shadow: 0 0 0 6px rgba(232, 137, 44, 0.25), var(--fp-shadow-2);
        }
      }
      @keyframes fp-pet-hop {
        50% {
          transform: translateY(-2px) rotate(-8deg);
        }
      }
      /* value only (outdoor temperature …): a quiet number standing upright, no frame */
      .value-tag {
        position: absolute;
        left: 0;
        top: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        transform: translateZ(10px) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt))) translate(-50%, -50%) scale(var(--fp-inv, 1));
        transform-origin: 0 0;
        white-space: nowrap;
        cursor: pointer;
        color: var(--fp-sky-ink, var(--fp-label));
        text-shadow: 0 0 4px var(--fp-sky-halo, transparent), 0 1px 10px var(--fp-sky-halo, transparent);
        transition: opacity var(--fp-dur) var(--fp-ease);
      }
      .value-tag .v {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-medium);
        letter-spacing: var(--fp-tracking-tight);
        line-height: 1.1;
        opacity: 0.85;
      }
      .value-tag .n {
        font-size: var(--fp-text-caption);
        opacity: 0.75;
      }
      .value-wrap.pressed .value-tag {
        opacity: 0.6;
      }
      .value-wrap.faint .value-tag {
        opacity: 0.25;
      }
      :host([editing]) .value-wrap.selected .value-tag {
        outline: 2px solid var(--fp-accent);
        outline-offset: 4px;
        border-radius: var(--fp-radius-s);
      }
      .marker-label {
        position: absolute;
        left: 0;
        top: 0;
        transform: translateZ(var(--fp-lift)) rotateZ(calc(-1 * var(--fp-spin))) rotateX(calc(-1 * var(--fp-tilt)))
          translate(-50%, calc(var(--fp-marker) / 2 + 6px)) scale(var(--fp-inv, 1));
        transform-origin: 50% calc(var(--fp-marker) / -2 - 6px);
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        white-space: nowrap;
        font-size: var(--fp-text-caption);
        line-height: 1.25;
      }
      .marker-label .n {
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
      }
      .marker-label .s {
        color: var(--fp-label-2);
      }

      /* Editor overlays */
      .ed-sel {
        fill: var(--fp-accent);
        fill-opacity: 0.06;
        stroke: var(--fp-accent);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .ed-draw {
        fill: none;
        stroke: var(--fp-accent);
        stroke-width: 2.5;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .ed-draw-fill {
        fill: var(--fp-accent);
        fill-opacity: 0.08;
        pointer-events: none;
      }
      /* editor: "Raum teilen" – the cut being drawn */
      .ed-split {
        stroke: var(--fp-accent);
        stroke-width: 2.5;
        stroke-dasharray: 8 5;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      /* editor: the trace image's outline and the calibration */
      .ed-trace-box {
        fill: none;
        stroke: var(--fp-label-3);
        stroke-width: 1.5;
        stroke-dasharray: 6 5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .ed-trace-box.on {
        stroke: var(--fp-accent);
        stroke-width: 2;
      }
      .ed-trace-line {
        stroke: var(--fp-accent);
        stroke-width: 2.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .ed-trace-pt {
        fill: var(--fp-surface);
        stroke: var(--fp-accent);
        stroke-width: 2.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      /* editor: the floor a vacuum has driven over (aligning its map) */
      .vac-learned circle {
        fill: #2f8cff;
        opacity: 0.35;
      }
      .vac-walls circle {
        fill: #1b3fa8;
        opacity: 0.75;
      }
      /* the vacuum's own map: its rooms as coloured areas, walls as a fine dark line */
      .vac-room path {
        opacity: 0.32;
      }
      .vac-room.c0 path { fill: #ff7a59; }
      .vac-room.c1 path { fill: #2fbf63; }
      .vac-room.c2 path { fill: #2f8cff; }
      .vac-room.c3 path { fill: #ffb020; }
      .vac-room.c4 path { fill: #a05cff; }
      .vac-room.c5 path { fill: #00b8c8; }
      .vac-room text {
        fill: #10204a;
        font-weight: 600;
        text-anchor: middle;
        dominant-baseline: middle;
        paint-order: stroke;
        stroke: rgba(255, 255, 255, 0.85);
        stroke-width: 3px;
      }
      .vac-wall {
        fill: #10204a;
        opacity: 0.55;
      }
      .vac-room.dim path {
        opacity: 0.08;
      }
      .vac-room.dim text {
        opacity: 0.25;
      }
      .vac-room.hl path {
        opacity: 0.6;
      }
      /* alignment mode: the plan's room names, the focused room's outline, matched point pairs */
      .va-plan-name {
        fill: var(--fp-label-2);
        font-weight: 500;
        text-anchor: middle;
        dominant-baseline: middle;
        opacity: 0.8;
        pointer-events: none;
      }
      .va-crop {
        fill: rgba(255, 59, 48, 0.18);
        stroke: #ff3b30;
        stroke-width: 2;
        stroke-dasharray: 6 4;
        vector-effect: non-scaling-stroke;
      }
      .va-crop.draft {
        fill: rgba(255, 59, 48, 0.12);
      }
      .va-target {
        fill: none;
        stroke: #2f8cff;
        stroke-width: 3;
        stroke-dasharray: 8 5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .va-pin line {
        stroke: #10204a;
        stroke-width: 1.5;
        stroke-dasharray: 4 3;
        vector-effect: non-scaling-stroke;
      }
      .va-pin circle {
        stroke: #fff;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }
      .va-pin circle.robot {
        fill: #2f8cff;
      }
      .va-pin circle.plan {
        fill: #ff7a00;
      }
      .va-pin text {
        fill: #fff;
        font-weight: 700;
        text-anchor: middle;
        dominant-baseline: central;
        pointer-events: none;
      }
      .vac-dock {
        fill: none;
        stroke: #2f8cff;
        stroke-width: 3;
      }
      .ed-guide {
        stroke: var(--fp-accent);
        stroke-width: 1;
        stroke-dasharray: 4 4;
        opacity: 0.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .h {
        position: absolute;
        width: var(--fp-hit);
        height: var(--fp-hit);
        margin: calc(var(--fp-hit) / -2) 0 0 calc(var(--fp-hit) / -2);
        transform: scale(var(--fp-inv, 1));
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        touch-action: none;
      }
      .h::after {
        content: '';
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--fp-surface);
        box-shadow: 0 0 0 2.5px var(--fp-accent), var(--fp-shadow-1);
        transition: transform var(--fp-dur-fast) var(--fp-ease);
      }
      .h.on::after {
        background: var(--fp-accent);
        transform: scale(1.15);
      }
      .h.small::after {
        width: 14px;
        height: 14px;
      }
      .h.sq::after {
        border-radius: 4px;
      }
      .h.first::after {
        background: var(--fp-accent);
        transform: scale(1.3);
      }
      .h.mid::after {
        width: 10px;
        height: 10px;
        background: var(--fp-accent);
        opacity: 0.55;
        box-shadow: 0 0 0 2px var(--fp-surface);
      }
      .h.snap {
        pointer-events: none;
      }
      .h.snap::after {
        width: 26px;
        height: 26px;
        background: transparent;
        box-shadow: 0 0 0 2px var(--fp-accent);
        opacity: 0.8;
      }
      .h.snap.grid::after,
      .h.snap.none::after {
        width: 8px;
        height: 8px;
        background: var(--fp-accent);
        box-shadow: none;
      }
      .h.snap.edge::after {
        border-radius: 3px;
        transform: rotate(45deg);
        width: 16px;
        height: 16px;
      }
      /* lined up with something already drawn: a small ring, the helper lines show with what */
      .h.snap.align::after {
        width: 12px;
        height: 12px;
      }
      .ed-guide.align {
        opacity: 0.85;
        stroke-dasharray: 6 4;
      }
      .h.rot::after,
      .h.vacmove::after,
      .h.vacscale::after {
        display: none;
      }
      /* editor: how many Hausregeln rules a device starts / is checked in / switches */
      .hrcount {
        position: absolute;
        display: flex;
        gap: 3px;
        transform: translate(-50%, calc(-100% - 14px)) scale(var(--fp-inv, 1));
        transform-origin: 50% 100%;
        pointer-events: none;
        z-index: 2;
      }
      .hrcount span {
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        box-sizing: border-box;
        border-radius: 9px;
        background: var(--c);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 18px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      }
      /* the vacuum's map (or one of its rooms): a frame with a dot on every side and corner */
      .va-frame {
        fill: none;
        stroke: #2f8cff;
        stroke-width: 1.5;
        stroke-dasharray: 6 5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }
      .h.vacedge::after {
        width: 16px;
        height: 16px;
        border-radius: 5px;
        background: var(--fp-surface);
        border: 2.5px solid #2f8cff;
        box-sizing: border-box;
      }
      .h.vacedge.corner::after {
        border-radius: 50%;
      }
      .h.vacedge.ew::after {
        width: 10px;
        height: 28px;
      }
      .h.vacedge.ns::after {
        width: 28px;
        height: 10px;
      }
      .h.vacedge.corner {
        cursor: nwse-resize;
      }
      .h.vacedge.s-tr,
      .h.vacedge.s-bl {
        cursor: nesw-resize;
      }
      .h.vacedge.ew {
        cursor: ew-resize;
      }
      .h.vacedge.ns {
        cursor: ns-resize;
      }
      /* a wall of the plan to move onto the vacuum's map */
      .h.planwall::after {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #ff7a00;
        border: 3px solid var(--fp-surface);
        box-sizing: border-box;
      }
      .h.planwall span {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 12px;
        height: 2px;
        border-radius: 1px;
        background: #fff;
        transform: translate(-50%, -50%) rotate(var(--ang));
        z-index: 1;
        pointer-events: none;
      }
      /* stretch the vacuum's map: wider, taller, both */
      .h.vacscale {
        border-radius: 50%;
      }
      .h.vacscale ha-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--fp-surface);
        color: #2f8cff;
        border: 2px solid #2f8cff;
        box-sizing: border-box;
        --mdc-icon-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--fp-shadow-2);
      }
      .h.vacscale[data-handle='vac-sx'] {
        cursor: ew-resize;
      }
      .h.vacscale[data-handle='vac-sy'] {
        cursor: ns-resize;
      }
      .h.vacscale[data-handle='vac-s'] {
        cursor: nwse-resize;
      }
      /* editor: drag a vacuum's map */
      .h.vacmove {
        border-radius: 50%;
        cursor: move;
      }
      .h.vacmove ha-icon {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #2f8cff;
        color: #fff;
        --mdc-icon-size: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--fp-shadow-2);
      }
      .h.rot {
        border-radius: 50%;
      }
      .dim {
        position: absolute;
        transform: translate(-50%, -50%) scale(var(--fp-inv, 1));
        padding: 3px 9px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-label);
        color: var(--fp-surface);
        font-size: var(--fp-text-caption);
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: var(--fp-shadow-1);
      }
      .dim.live {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .h.rot ha-icon {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: var(--fp-accent);
        color: var(--fp-on-accent);
        --mdc-icon-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--fp-shadow-1);
      }
      .empty {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--fp-space-7);
        text-align: center;
        color: var(--fp-label-2);
        font-size: var(--fp-text-body);
        pointer-events: none;
      }
    `,
  ];
}

interface LabelPlacement {
  key: string;
  point: Point;
  width: number;
  /** Placed by the admin (room.label) */
  pinned?: boolean;
  /** Outside placement: label anchor (outside), leader start (inside), outward normal */
  tip?: Point;
  inner?: Point;
  normal?: Point;
}

/**
 * Finds the longest stretch of this room's walls that faces outside (no other room behind it) and
 * places the label just beyond it. Interior rooms return undefined (label stays inside).
 */
function outsidePlacement(room: RoomConfig, rooms: RoomConfig[]): Partial<LabelPlacement> | undefined {
  const pts = room.points;
  if (pts.length < 3) return undefined;
  const others = rooms.filter((r) => r !== room && r.points.length >= 3);
  const insideOther = (p: Point) => others.some((r) => pointInPolygon(p, r.points));
  let best: { len: number; mid: Point; n: Point } | undefined;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 60) continue;
    let n: Point = [dy / L, -dx / L];
    const m: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInPolygon([m[0] + n[0] * 3, m[1] + n[1] * 3], pts)) n = [-n[0], -n[1]];
    // Longest contiguous exterior run along this edge
    const steps = Math.max(4, Math.round(L / 20));
    let runStart = -1;
    for (let k = 0; k <= steps; k++) {
      const t = 0.03 + (0.94 * k) / steps;
      const p: Point = [a[0] + dx * t, a[1] + dy * t];
      const ext = k < steps && !insideOther([p[0] + n[0] * 14, p[1] + n[1] * 14]);
      if (ext && runStart < 0) runStart = t;
      if ((!ext || k === steps) && runStart >= 0) {
        const tEnd = ext ? t : 0.03 + (0.94 * (k - 1)) / steps;
        const len = (tEnd - runStart) * L;
        const tm = (runStart + tEnd) / 2;
        if (!best || len > best.len) best = { len, mid: [a[0] + dx * tm, a[1] + dy * tm], n };
        runStart = -1;
      }
    }
  }
  if (!best || best.len < 110) return undefined;
  const { mid, n } = best;
  return { tip: [mid[0] + n[0] * 46, mid[1] + n[1] * 46], inner: [mid[0] - n[0] * 26, mid[1] - n[1] * 26], normal: n };
}

/** A point just inside the polygon, near the boundary point closest to `from` (leader start). */
function innerPoint(pts: Point[], from: Point): Point {
  let best: Point = pts[0];
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const c = closestPointOnSegment(from, pts[i], pts[(i + 1) % pts.length]);
    if (c.dist < bd) {
      bd = c.dist;
      best = c.point;
    }
  }
  const dx = best[0] - from[0];
  const dy = best[1] - from[1];
  const d = Math.hypot(dx, dy) || 1;
  const p: Point = [best[0] + (dx / d) * 26, best[1] + (dy / d) * 26];
  return pointInPolygon(p, pts) ? p : polylabel(pts);
}

function binaryIcon(s: HassEntity): string {
  const dc = s.attributes.device_class;
  if (dc === 'window') return 'mdi:window-open-variant';
  if (dc === 'door') return 'mdi:door-open';
  if (dc === 'opening') return 'mdi:square-rounded-outline';
  if (dc === 'motion' || dc === 'occupancy' || dc === 'presence') return 'mdi:motion-sensor';
  return 'mdi:alert-circle-outline';
}

if (!customElements.get('fp-plan')) customElements.define('fp-plan', FpPlan);
