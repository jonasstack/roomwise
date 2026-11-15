import { LitElement, css, html, nothing, svg, type PropertyValues } from 'lit';
import type { WifiNetwork } from '../wifi-qr';
import { components } from '../design/components';
import type {
  Bounds,
  DeviceConfig,
  FloorConfig,
  FloorplanCardConfig,
  FurnitureConfig,
  HitTarget,
  HomeAssistant,
  ManualEntityConfig,
  OpeningConfig,
  Point,
  EditorStart,
  RoomConfig,
  VacuumLive,
  VacuumRoomFit,
  VacuumTransform,
} from '../types';
import type { FloorplanCard } from '../floorplan-card';
import type { FloorplanLayer } from '../layer/floorplan-layer';
import { serverWanted, syncServer, vacuumInfo, vacuumLearned, vacuumMap, type VacuumInfo } from '../entry-server';
// first steps "from the vacuum's map" (the card loads this bundle for it)
import '../components/vacuum-start';
import { autoFit, autoFitMap, fitPairs, mapperOf, roomMatch, sameRoom, toPlan, toRobot, type LearnedFloor, type VacuumMap } from '../vacuum-live';
import type { FpPlan } from '../components/fp-plan';
import { boundsOf, closestPointOnSegment, floorBounds, pointInPolygon, pointsToPath, polylabel, round, snapPoint, type SnapResult } from '../geometry';
import { PLAN_MAX_BYTES, normalizeConfig, planFile, readPlanFile, uid } from '../config';
import { moveWalls, planWalls, roomFromMap, snapToMap, wallEnds, wallLines } from '../vac-plan';
import { applyEdgeMove, edgeMove, sharedCorners, snapCorner, snapEdge, type CornerRef, type EdgeMove } from './wall-drag';
import { houseRules, hrColor, roomArea, ruleSentence, type HrForEntity, type HrRule } from '../house-rules';
import type { HrMarks } from '../components/fp-plan';
import { t } from '../i18n';
import { floorBelow, floorLevel, floorOfEntity, floorShort, orderedFloors, reorderLevels } from '../levels';
import { askStairsOnStart, onStairsEvent, startStairsTool, stairsHint, stairsTap } from './stairs-tool';
import { CATEGORIES, FURNITURE_BY_KIND, LIBRARY, categoryLabel, drawFurniture, snapsToWall, type LibraryItem } from '../furniture';
import { saveCardConfig } from './save';
import { renderTracePanel, traceOverlay, traceTap, patchTrace, storeTraceImages, dropUnusedImages, type TraceMode } from './trace-panel';
import { traceHref, type ProcessedImage } from '../trace';
import { contentOf, fetchPlans, saveShared, shareFromCard, type ShareState } from './plan-share';
import { mergePlan, type SharedPlan, type SharedPlanSummary } from '../shared-plans';
import { toYaml } from './yaml';
import { formatLength, renderInspector } from './inspector';
import type { EntityFilter } from './entity-list';
import '../components/fp-plan';
import '../components/controls';
import './entity-list';
import './action-editor';
import '../components/icon-picker';
import { markTourSeen, tourSeen } from './tour';
import './tour';
import { labelStyleOf, setLabelStyle, type LabelStyle } from '../components/label-style';

export type Tool = 'select' | 'draw' | 'door' | 'window' | 'garage' | 'stairs';
export type Panel = 'inspect' | 'furniture' | 'settings' | 'rules' | 'trace' | null;
export type Selection = { kind: 'room' | 'device' | 'opening' | 'furniture'; id: string } | null;

/** First entry of the furniture library: nothing fits — any Home Assistant entity, placed as a device marker */
const OTHER = { id: 'other', de: 'Sonstige', en: 'Other', icon: 'mdi:dots-horizontal-circle-outline' };

interface Drag {
  type: 'trace' | 'vertex' | 'edge' | 'room' | 'device' | 'opening' | 'opening-a' | 'opening-b' | 'furniture' | 'rotate' | 'resize' | 'rect' | 'point' | 'label' | 'vacmap' | 'vacrot' | 'vacscale' | 'vaccrop' | 'vacedge' | 'planwall';
  id?: string;
  index?: number;
  start: Point;
  orig?: any;
  edge?: [Point, Point];
  moved: boolean;
}

interface PickerState {
  title: string;
  filter?: EntityFilter;
  multi?: boolean;
  selected: string[];
  onPick: (ids: string[]) => void;
}

/** Sheet for an entity added by hand or re-categorised: entity, role / group, own name and icon */
export interface EntityEditState {
  title: string;
  value: ManualEntityConfig;
  /** choices for the role (grouped by `group`) */
  roles?: { value: string; label: string; group?: string }[];
  filter?: EntityFilter;
  onSave: (v: ManualEntityConfig) => void;
  onRemove?: () => void;
  removeLabel?: string;
}

const HISTORY_LIMIT = 100;

const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const SNAP_PX = 14;

export class FloorplanEditorUI extends LitElement {
  static override properties = {
    hass: { attribute: false },
    card: { attribute: false },
    config: { attribute: false },
    floorId: { attribute: false },
    layer: { attribute: false },
    start: { attribute: false },
    _tour: { state: true },
    _draft: { state: true },
    _tool: { state: true },
    _panel: { state: true },
    _sel: { state: true },
    _vertex: { state: true },
    _drawing: { state: true },
    _hover: { state: true },
    _snapGrid: { state: true },
    _snapGeom: { state: true },
    _linkWalls: { state: true },
    _showGrid: { state: true },
    _past: { state: true },
    _future: { state: true },
    _saving: { state: true },
    _picker: { state: true },
    _kindPick: { state: true },
    _kindQ: { state: true },
    _kindCat: { state: true },
    _entEdit: { state: true },
    _yaml: { state: true },
    _discard: { state: true },
    _ghost: { state: true },
    _fit: { state: true },
    _narrow: { state: true },
    _users: { state: true },
    _ttsLangs: { state: true },
    _wifi: { state: true },
    _showLabels: { state: true },
    _align: { state: true },
    _hrOn: { state: true },
    _hrRules: { state: true },
    _hrSel: { state: true },
    _hrMarks: { state: true },
    _furnCat: { state: true },
    _view3d: { state: true },
    _fullWalls: { state: true },
    _furnQ: { state: true },
    _share: { state: true },
    _plans: { state: true },
    _traceMode: { state: true },
    _traceHidden: { state: true },
  };
  /** Trace panel: calibrating (two points) or moving the picture; null: taps work as usual */
  declare _traceMode?: TraceMode;
  /** Trace image hidden for now (editor only, not saved) */
  declare _traceHidden: boolean;
  /** Pictures loaded in this editor, not stored yet (by temporary id) */
  readonly pendingImages = new Map<string, ProcessedImage>();
  /** The draft's shared plan (companion): an existing one, or one created on "Save"; undefined: the card's own */
  declare _share?: ShareState;
  /** Shared plans to choose from (settings) */
  declare _plans?: SharedPlanSummary[];
  /** Open the settings' "several dashboards" section once (first steps: "Use a shared floor plan") */
  shareOpen = false;
  /** the settings' "Floors" section is open (toolbar "Floors"), and scrolled into view once */
  floorsOpen = false;
  private floorsScroll = false;
  private shareScroll = false;
  private initial = '';
  private initialShare = '';

  declare hass: HomeAssistant;
  declare card: FloorplanCard;
  declare config: FloorplanCardConfig;
  declare floorId?: string;
  declare layer: FloorplanLayer;
  /** first steps: a suggested plan put into the draft when the editor opens (unsaved) */
  declare start?: EditorStart;
  declare _tour: boolean;
  declare _draft: FloorplanCardConfig;
  declare _tool: Tool;
  declare _panel: Panel;
  declare _sel: Selection;
  declare _vertex: number | null;
  declare _drawing: Point[];
  declare _hover: SnapResult | null;
  declare _snapGrid: boolean;
  declare _snapGeom: boolean;
  /** a wall / corner two rooms share moves for both (Alt while dragging: only this room) */
  declare _linkWalls: boolean;
  declare _showGrid: boolean;
  declare _past: string[];
  declare _future: string[];
  declare _saving: boolean;
  declare _picker?: PickerState;
  /** "Art ändern" of an object: the library's categories and search, a tap picks the kind (and variant) */
  declare _kindPick?: { current?: string; onPick: (kind: string, variant?: string) => void };
  declare _kindQ: string;
  declare _kindCat: string;
  declare _entEdit?: EntityEditState;
  declare _yaml: boolean;
  declare _discard: boolean;
  declare _ghost?: { label: string; icon: string; x: number; y: number };
  declare _fit?: Bounds;
  declare _narrow: boolean;
  declare _users?: { id: string; name: string }[];
  /** Supported languages per TTS engine (loaded on demand) */
  declare _ttsLangs?: Record<string, string[]>;
  /** The home's Wi-Fi networks (companion integration), edited at a router and saved on their own */
  declare _wifi?: { nets: WifiNetwork[]; dirty: boolean; busy?: boolean; missing?: boolean; show?: boolean };
  declare _showLabels: boolean;
  /** Laying a vacuum's map onto the plan: a mode of its own (nothing else to tap, left only by "Done") */
  declare _align?: {
    id: string;
    /** the vacuum's settings when the mode was opened (Reset) */
    start?: VacuumLive;
    /** the plan's rooms and openings when the mode was opened: "Reset" also undoes walls fitted to the map */
    startPlan?: { rooms: RoomConfig[]; openings: OpeningConfig[] };
    /** move: drag the map / a room; pairs: match points; crop: cut areas out of the vacuum's map; walls: fit
     * the plan's walls to the map */
    tool: 'move' | 'pairs' | 'crop' | 'walls';
    /** matched points: robot (mm) ↔ plan (cm); the second half of a pair is set by the next tap */
    pairs: { robot: Point; plan?: Point }[];
    /** a room of the vacuum's map edited on its own (its id) */
    room?: string;
    /** plan corners of the area being cut out */
    cropDraft?: [Point, Point];
  };
  /** Hausregeln installed (rules panel, rules per device, counters on the plan) */
  declare _hrOn: boolean;
  declare _hrRules: HrRule[];
  /** the rule shown on the plan */
  declare _hrSel?: string;
  declare _hrMarks?: HrMarks;
  /** rules per entity: starts / checked / switches */
  hrCounts = new Map<string, HrForEntity>();
  private offHr?: () => void;
  private hrCountTimer?: number;
  declare _furnCat: string;
  declare _view3d: boolean;
  declare _fullWalls: boolean;
  declare _furnQ: string;
  private usersLoading = false;

  /** HA users (admin only) for per-user default views. */
  /** The selected vacuum with an aligned map and learned floor: its map (or, while aligning, one of its rooms)
   * can be dragged, turned and stretched on the plan */
  private vacEdit() {
    const sel: Selection = this._align ? { kind: 'furniture', id: this._align.id } : this._sel;
    if (sel?.kind !== 'furniture' || (!this._align && this._tool !== 'select')) return undefined;
    const f = this.findSel(sel) as FurnitureConfig | undefined;
    const tf = f?.vacuum?.transform;
    const l = f?.entity ? this.vacLearned.get(f.entity) : undefined;
    const vm = f?.entity ? this.vacMaps.get(f.entity) : undefined;
    if (f?.kind !== 'robot_vacuum' || !tf) return undefined;
    const m = mapperOf(f.vacuum, vm)!;
    const room = this._align?.room;
    // the robot points shown: its map (rooms and walls, if there), else what it has driven over
    const res = l?.res || 100;
    let robot: Point[];
    if (vm?.rooms.length) robot = (room ? (vm.rooms.find((r) => r.id === room)?.pts ?? []) : [...vm.rooms.flatMap((r) => r.pts), ...vm.walls]).filter(([x, y]) => !m.cut(x, y));
    else robot = (l?.cells ?? []).map(([x, y]) => [(x + 0.5) * res, (y + 0.5) * res] as Point);
    if (!robot.length) return undefined;
    const P = (x: number, y: number) => m.toPlan(x, y, room);
    const cr: Point = [robot.reduce((a, p) => a + p[0], 0) / robot.length, robot.reduce((a, p) => a + p[1], 0) / robot.length];
    const cp = P(cr[0], cr[1]);
    let radius = 0;
    const step = Math.max(1, Math.floor(robot.length / 400));
    const pts: Point[] = [];
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    robot.forEach(([x, y], i) => {
      if (i % step) return;
      const p = P(x, y);
      pts.push(p);
      radius = Math.max(radius, Math.hypot(p[0] - cp[0], p[1] - cp[1]));
      box.minX = Math.min(box.minX, p[0]);
      box.minY = Math.min(box.minY, p[1]);
      box.maxX = Math.max(box.maxX, p[0]);
      box.maxY = Math.max(box.maxY, p[1]);
    });
    return { f, tf, m, room, centreRobot: cr, centre: cp, radius, pts, box };
  }

  // ---------- laying a vacuum's map onto the plan (own mode) ----------

  /** Enter the alignment mode for a vacuum (first time: an automatic guess to start from) */
  startAlign(id: string) {
    const f = this.floor.furniture?.find((x) => x.id === id);
    if (!f?.entity) return;
    this.loadVacLearned(f.entity, false, f.vacuum?.map_entity);
    this._align = { id, start: f.vacuum ? structuredClone(f.vacuum) : undefined, startPlan: { rooms: structuredClone(this.floor.rooms), openings: structuredClone(this.floor.openings ?? []) }, tool: 'move', pairs: [] };
    this._sel = { kind: 'furniture', id };
    this._panel = null;
    this._tool = 'select';
    this._view3d = false;
    if (!f.vacuum?.transform) this.alignAuto();
    this.updateComplete.then(() => this.refit(true));
  }

  /** Alignment mode: plan and the vacuum's map (or the room being edited) in view, above the dock */
  private alignRefit(animate: boolean) {
    const ve = this.vacEdit();
    const b = this._align?.room && ve ? { ...ve.box } : { ...floorBounds(this.floor) };
    if (ve && isFinite(ve.box.minX)) {
      b.minX = Math.min(b.minX, ve.box.minX);
      b.minY = Math.min(b.minY, ve.box.minY);
      b.maxX = Math.max(b.maxX, ve.box.maxX);
      b.maxY = Math.max(b.maxY, ve.box.maxY);
    }
    const m = this._align?.room ? 80 : 30;
    const stage = this.renderRoot.querySelector('.stage')?.getBoundingClientRect();
    const dock = (this.renderRoot.querySelector('.va-dock') as HTMLElement | null)?.offsetHeight ?? 250;
    const H = stage?.height || 800;
    const W = stage?.width || 1200;
    const h = b.maxY - b.minY + 2 * m;
    const w = b.maxX - b.minX + 2 * m;
    // screen room for the handles around the map (sides 50 px, top 100 px: rotate handle) and the dock below
    const free = Math.max(200, H - dock - 24 - 100 - 30);
    const k = Math.max(h / free, w / Math.max(200, W - 100));
    this._fit = { minX: b.minX - m - 50 * k, minY: b.minY - m - 100 * k, maxX: b.maxX + m + 50 * k, maxY: b.maxY + m + (dock + 24 + 30) * k };
    this.updateComplete.then(() => this.plan?.panZoom?.reset(animate));
  }

  endAlign = () => {
    const id = this._align?.id;
    this._align = undefined;
    if (id) this.select({ kind: 'furniture', id });
    this.refit(true);
  };

  private get alignPiece(): FurnitureConfig | undefined {
    return this._align ? this.floor.furniture?.find((x) => x.id === this._align!.id) : undefined;
  }

  private get alignMap(): VacuumMap | null | undefined {
    const f = this.alignPiece;
    return f?.entity ? this.vacMaps.get(f.entity) : undefined;
  }

  /** Change the aligning vacuum's settings (transform, rooms, cut-outs) */
  private setVac(fn: (v: VacuumLive) => void, record = true) {
    const id = this._align?.id;
    if (!id) return;
    this.mutate((_x, f) => {
      const it = f.furniture!.find((x) => x.id === id)!;
      const v: VacuumLive = structuredClone(it.vacuum ?? {});
      fn(v);
      if (v.rooms && !Object.keys(v.rooms).length) delete v.rooms;
      if (v.crop && !v.crop.length) delete v.crop;
      for (const k of Object.keys(v) as (keyof VacuumLive)[]) if (v[k] === undefined) delete v[k];
      it.vacuum = Object.keys(v).length ? v : undefined;
    }, record);
  }

  private setAlignTf(tf: VacuumTransform | undefined, record = true) {
    this.setVac((v) => (v.transform = tf), record);
  }

  /** A room's own placement (a fresh one: about the middle of its floor) */
  private roomFit(id: string): VacuumRoomFit {
    const cur = this.alignPiece?.vacuum?.rooms?.[id];
    if (cur) return { ...cur };
    const r = this.alignMap?.rooms.find((x) => x.id === id);
    const pts = r?.pts.length ? r.pts : [[0, 0] as [number, number]];
    return { c: [Math.round(pts.reduce((a, p) => a + p[0], 0) / pts.length), Math.round(pts.reduce((a, p) => a + p[1], 0) / pts.length)] };
  }

  private setRoomFit(id: string, fit: VacuumRoomFit | undefined, record = true) {
    this.setVac((v) => {
      const rooms = { ...(v.rooms ?? {}) };
      if (fit) rooms[id] = fit;
      else delete rooms[id];
      v.rooms = rooms;
    }, record);
  }

  /** Middle of the vacuum's map (robot mm): turning and sizing keep it in place */
  private alignMid(): Point | undefined {
    const pts = this.alignMap?.rooms.flatMap((r) => r.pts) ?? [];
    if (pts.length) return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return this.vacEdit()?.centreRobot;
  }

  /** Small steps: move (cm), turn (°), size (factor) — of the whole map about its middle, or of the room */
  nudge(dx: number, dy: number, drot: number, k: number) {
    const room = this._align?.room;
    if (room) {
      const fit = this.roomFit(room);
      const sx = Math.max(0.5, Math.min(2, (fit.scale ?? 1) * k));
      const sy = Math.max(0.5, Math.min(2, (fit.scaleY ?? fit.scale ?? 1) * k));
      this.setRoomFit(room, {
        ...fit,
        x: Math.round((fit.x ?? 0) + dx) || undefined,
        y: Math.round((fit.y ?? 0) + dy) || undefined,
        rot: Math.round((((fit.rot ?? 0) + drot) % 360) * 10) / 10 || undefined,
        scale: Math.round(sx * 1000) / 1000 === 1 ? undefined : Math.round(sx * 1000) / 1000,
        scaleY: Math.round(sy * 1000) / 1000 === Math.round(sx * 1000) / 1000 ? undefined : Math.round(sy * 1000) / 1000,
      });
      return;
    }
    const tf = this.alignPiece?.vacuum?.transform;
    if (!tf) return;
    const mid = this.alignMid();
    const before = mid ? toPlan(tf, mid[0], mid[1]) : undefined;
    const s0 = tf.scale ?? 0.1;
    const sy0 = tf.scaleY ?? s0;
    const clamp = (v: number) => Math.max(0.03, Math.min(0.3, v));
    const sx = Math.round(clamp(s0 * k) * 10000) / 10000;
    const sy = Math.round(clamp(sy0 * k) * 10000) / 10000;
    const next: VacuumTransform = { ...tf, rot: Math.round(((((tf.rot ?? 0) + drot) % 360) + 360) % 360 * 10) / 10, scale: sx, scaleY: sy !== sx ? sy : undefined };
    if (before && mid) {
      const after = toPlan(next, mid[0], mid[1]);
      next.x = Math.round(next.x + before[0] - after[0]);
      next.y = Math.round(next.y + before[1] - after[1]);
    }
    next.x = Math.round(next.x + dx);
    next.y = Math.round(next.y + dy);
    this.setAlignTf(next);
  }

  /** Automatic: rooms of the same name onto each other (or what it has driven over); cut-out areas do not count */
  alignAuto = () => {
    const f = this.alignPiece;
    if (!f?.entity) return;
    const vm = this.vacMaps.get(f.entity);
    const l = this.vacLearned.get(f.entity);
    const dock = this.floor.furniture?.find((p) => p.kind === 'robot_dock');
    const dk: Point | undefined = dock ? [dock.x, dock.y] : undefined;
    const crop = f.vacuum?.crop;
    const cut = crop?.length ? (x: number, y: number) => crop.some((poly) => pointInPolygon([x, y], poly)) : undefined;
    let fit = vm ? autoFitMap(this.floor, vm, dk, cut) : l?.cells.length ? autoFit(this.floor, l, dk) : undefined;
    // nothing drawn yet: the map as it is (mm → cm, its y counted upwards), placed at the origin — the rooms can
    // then be taken over from it
    if (!fit && vm?.rooms.length && !this.floor.rooms.some((r) => !r.outdoor)) {
      const pts = vm.rooms.flatMap((r) => r.pts);
      const minX = Math.min(...pts.map((p) => p[0]));
      const maxY = Math.max(...pts.map((p) => p[1]));
      fit = { x: Math.round(-minX * 0.1), y: Math.round(maxY * 0.1), rot: 0, scale: 0.1, mirror: true };
    }
    if (fit) {
      this.setAlignTf(fit);
      this._align = { ...this._align!, pairs: [] };
    }
    this.layer.toast(fit ? t('editor.vac_fit_done') : t('editor.vac_fit_failed'));
  };

  /** Mirror the map (some vacuums count y the other way round), keeping its middle in place */
  alignMirror = () => {
    const tf = this.alignPiece?.vacuum?.transform;
    const mid = this.alignMid();
    if (!tf) return;
    const next: VacuumTransform = { ...tf, mirror: !tf.mirror || undefined };
    if (mid) {
      const a = toPlan(tf, mid[0], mid[1]);
      const b = toPlan(next, mid[0], mid[1]);
      next.x = Math.round(next.x + a[0] - b[0]);
      next.y = Math.round(next.y + a[1] - b[1]);
    }
    this.setAlignTf(next);
  };

  /** Back to how it was when the mode was opened (the room being edited: only that room) */
  alignReset = () => {
    const a = this._align;
    if (!a) return;
    if (a.room) {
      this.setRoomFit(a.room, a.start?.rooms?.[a.room] ? { ...a.start.rooms[a.room] } : undefined);
      return;
    }
    this.setVac((v) => {
      v.transform = a.start?.transform ? { ...a.start.transform } : undefined;
      v.rooms = a.start?.rooms ? structuredClone(a.start.rooms) : undefined;
      v.crop = a.start?.crop ? structuredClone(a.start.crop) : undefined;
    });
    // walls fitted to the map ("Fit plan") go back too; rooms created from the map stay
    const sp = a.startPlan;
    if (sp && JSON.stringify(sp.rooms.map((r) => r.points)) !== JSON.stringify(this.floor.rooms.filter((r) => sp.rooms.some((x) => x.id === r.id)).map((r) => r.points)))
      this.mutate((_x, f) => {
        for (const r of f.rooms) {
          const was = sp.rooms.find((x) => x.id === r.id);
          if (was) r.points = structuredClone(was.points);
        }
        f.openings = (f.openings ?? []).map((o) => sp.openings.find((x) => x.id === o.id) ?? o);
      }, false);
    this._align = { ...a, pairs: [] };
  };

  /** The plan's walls (of the room being edited, or all) onto the lines of the vacuum's map */
  alignSnapWalls = () => {
    const a = this._align;
    const f = this.alignPiece;
    const vm = this.alignMap;
    if (!a || !f?.vacuum?.transform || !vm) return;
    const m = mapperOf(f.vacuum, vm)!;
    const name = a.room ? vm.rooms.find((r) => r.id === a.room)?.name : undefined;
    const target = name ? this.floor.rooms.find((r) => r.name && sameRoom(r.name, name)) : undefined;
    let n = 0;
    this.mutate((_x, fl) => (n = snapToMap(fl, vm, m, target?.id, (ids) => this.mapRoomsOf(ids))));
    this.layer.toast(n ? t('editor.va_walls_done', { n }) : t('editor.va_walls_none'));
  };

  /** The rooms of the vacuum's map that belong to these plan rooms (same name); undefined: none named alike */
  private mapRoomsOf(ids: Set<string>): string[] | undefined {
    const vm = this.alignMap;
    if (!vm) return undefined;
    const names = [...ids].map((id) => this.floor.rooms.find((r) => r.id === id)?.name).filter((x): x is string => !!x);
    const out = vm.rooms.filter((r) => r.name && names.some((nm) => sameRoom(nm, r.name!))).map((r) => r.id);
    return out.length ? out : undefined;
  }

  /** Rooms of the vacuum's map that the plan does not have yet (by name) */
  private missingRooms(): string[] {
    const vm = this.alignMap;
    if (!vm) return [];
    return vm.rooms.filter((r) => r.pts.length >= 12 && !(r.name && this.floor.rooms.some((x) => x.name && sameRoom(x.name, r.name!)))).map((r) => r.id);
  }

  /** New plan rooms from rooms of the vacuum's map (outline squared, pushed out onto its walls, named) */
  alignCreateRooms = (ids: string[]) => {
    const f = this.alignPiece;
    const vm = this.alignMap;
    if (!f?.vacuum?.transform || !vm || !ids.length) return;
    const m = mapperOf(f.vacuum, vm)!;
    const made = ids.map((id) => roomFromMap(vm, id, m, uid('room'))).filter((r): r is RoomConfig => !!r);
    if (!made.length) return this.layer.toast(t('editor.va_rooms_none'));
    this.mutate((_x, fl) => fl.rooms.push(...made));
    this.layer.toast(made.length === 1 ? t('editor.va_room_done', { name: made[0].name ?? '' }) : t('editor.va_rooms_done', { n: made.length }));
  };

  /** Show a room of the vacuum's map on its own (or the whole map again) */
  alignRoom(id: string | undefined) {
    this._align = { ...this._align!, room: id, tool: this._align!.tool === 'pairs' ? 'move' : this._align!.tool, cropDraft: undefined };
    this.updateComplete.then(() => this.refit(true));
  }

  /** A tap: in "move" a room of the vacuum's map opens on its own; "crop" removes the cut-out under the finger;
   * "pairs": a spot of the map, then the same spot on the plan — from two pairs the map follows them */
  private alignTap(w: Point) {
    const a = this._align!;
    const f = this.alignPiece;
    const tf = f?.vacuum?.transform;
    const vm = this.alignMap;
    if (!tf) return;
    const m = mapperOf(f!.vacuum, vm)!;
    if (a.tool === 'move') {
      if (a.room || !vm) return;
      const q = m.toRobot(w[0], w[1]);
      const id = m.roomOf(q[0], q[1]) ?? (vm.rooms.find((r) => r.pts.some(([x, y]) => Math.hypot(x - q[0], y - q[1]) < (vm.floor_res ?? 100) * 1.5))?.id);
      if (id && !m.cut(q[0], q[1])) this.alignRoom(id);
      return;
    }
    if (a.tool === 'crop') {
      const q = m.toRobot(w[0], w[1], a.room);
      const crop = f!.vacuum?.crop ?? [];
      const k = crop.findIndex((poly) => pointInPolygon(q, poly));
      if (k >= 0) this.setVac((v) => (v.crop = (v.crop ?? []).filter((_, i) => i !== k)));
      return;
    }
    const tol = 26 / this.scale;
    const pairs = [...a.pairs];
    const open = pairs.length && !pairs[pairs.length - 1].plan;
    if (!open) {
      // a spot of the vacuum's map: nearest wall point, else exactly where tapped
      let best: Point | undefined;
      let bd = tol;
      for (const p of vm?.walls ?? []) {
        if (m.cut(p[0], p[1])) continue;
        const q = toPlan(tf, p[0], p[1]);
        const d = Math.hypot(q[0] - w[0], q[1] - w[1]);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      pairs.push({ robot: best ?? toRobot(tf, w[0], w[1]) });
    } else {
      // the same spot on the plan: a room corner, else a wall, else where tapped
      let best: Point | undefined;
      let bd = tol;
      for (const r of this.floor.rooms)
        for (const p of r.points) {
          const d = Math.hypot(p[0] - w[0], p[1] - w[1]);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
      if (!best)
        for (const r of this.floor.rooms)
          r.points.forEach((p, i) => {
            const c = closestPointOnSegment(w, p, r.points[(i + 1) % r.points.length]);
            if (c.dist < tol * 0.7 && !best) best = c.point;
          });
      pairs[pairs.length - 1] = { ...pairs[pairs.length - 1], plan: best ?? [round(w[0]), round(w[1])] };
      const done = pairs.filter((p) => p.plan) as { robot: Point; plan: Point }[];
      const fit = fitPairs(done, !!tf.mirror);
      if (fit) this.setAlignTf(fit);
    }
    this._align = { ...a, pairs };
  }

  /** End of a cut-out drag: the rectangle (plan) becomes an area of the vacuum's map (robot mm) */
  private alignCropEnd() {
    const a = this._align;
    const d = a?.cropDraft;
    if (!a || !d) return;
    this._align = { ...a, cropDraft: undefined };
    const f = this.alignPiece;
    const tf = f?.vacuum?.transform;
    if (!tf || Math.abs(d[1][0] - d[0][0]) < 8 || Math.abs(d[1][1] - d[0][1]) < 8) return;
    const m = mapperOf(f!.vacuum, this.alignMap)!;
    const corners: Point[] = [d[0], [d[1][0], d[0][1]], d[1], [d[0][0], d[1][1]]];
    const poly = corners.map(([x, y]) => m.toRobot(x, y, a.room ?? null)).map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]);
    this.setVac((v) => (v.crop = [...(v.crop ?? []), poly]));
  }

  // ---------- Hausregeln ----------

  /** Entities on the plan that rules can be about: pieces, markers, doors / windows */
  private hrEntities(): string[] {
    const f = this.floor;
    const ids = new Set<string>();
    for (const x of f.furniture ?? []) if (x.entity) ids.add(x.entity);
    for (const d of f.devices) ids.add(d.entity);
    for (const o of f.openings ?? []) if (o.entity) ids.add(o.entity);
    return [...ids];
  }

  /** How many rules each device starts / is checked in / switches (for the counters and the inspector) */
  loadHrCounts() {
    clearTimeout(this.hrCountTimer);
    this.hrCountTimer = window.setTimeout(async () => {
      if (!this._hrOn) return;
      const link = houseRules(this.hass);
      const ids = this.hrEntities();
      const res = await Promise.all(ids.map((id) => link.forEntity(id)));
      this.hrCounts = new Map(ids.flatMap((id, i) => (res[i] ? [[id, res[i]!] as [string, HrForEntity]] : [])));
      this.requestUpdate();
    }, 250);
  }

  /** Show a rule on the plan: its devices by sentence part, its rooms, lines trigger → action */
  async showRule(id: string | undefined) {
    this._hrSel = id;
    const rule = id ? this._hrRules?.find((r) => r.id === id) : undefined;
    if (!rule) {
      this._hrMarks = undefined;
      return;
    }
    const ents = await houseRules(this.hass).ruleEntities(rule);
    if (this._hrSel !== id || !ents) return;
    // nothing of the rule on this floor, but on another one: show that floor
    const parts = (['when', 'then', 'and', 'only'] as const).flatMap((p) => ents[p] ?? []);
    const ruleEnts = parts.flatMap((c) => c.entities ?? []);
    const ruleAreas = parts.map((c) => c.room ?? (c.subject.startsWith('room:') ? c.subject.slice(5) : undefined)).filter((a): a is string => !!a);
    const on = (f: FloorConfig) => ruleEnts.some((e) => floorOfEntity({ floors: [f] }, e)) || ruleAreas.some((a) => f.rooms.some((r) => roomArea(r, this.hass) === a));
    if (this._draft.floors.length > 1 && !on(this.floor)) {
      const other = this._draft.floors.find((f) => f !== this.floor && on(f));
      if (other) {
        this.setFloor(other.id);
        this._hrSel = id;
      }
    }
    const dark = this.hass.themes?.darkMode ?? false;
    const devices: HrMarks['devices'] = [];
    const rooms: HrMarks['rooms'] = [];
    const seen = new Set<string>();
    const add = (part: 'when' | 'and' | 'then' | 'only', color: string) => {
      for (const c of ents[part] ?? []) {
        for (const e of c.entities ?? []) if (!seen.has(e)) {
          seen.add(e);
          devices.push({ id: e, color });
        }
        const area = c.room ?? (c.subject.startsWith('room:') ? c.subject.slice(5) : undefined);
        const r = area ? this.floor.rooms.find((x) => roomArea(x, this.hass) === area) : undefined;
        if (r && !rooms.some((x) => x.id === r.id)) rooms.push({ id: r.id, color });
      }
    };
    const whenC = hrColor(rule.type === 'while' ? 'while' : 'when', dark);
    add('when', whenC);
    add('then', hrColor('then', dark));
    add('and', hrColor('and', dark));
    add('only', hrColor('and', dark));
    const from = (ents.when ?? []).flatMap((c) => c.entities ?? []);
    const to = (ents.then ?? []).flatMap((c) => c.entities ?? []);
    const lines = from.flatMap((a) => to.map((b) => ({ from: a, to: b, color: whenC }))).filter((l) => l.from !== l.to).slice(0, 8);
    this._hrMarks = { devices, rooms, lines };
  }

  /** The rules panel: every rule as its sentence; picking one shows it on the plan */
  private renderRulesPanel() {
    const rules = this._hrRules ?? [];
    const sel = this._hrSel;
    return html`<p class="panel-hint">${t('hr.panel_hint')}</p>
      <button class="btn accent block pressable gap" @click=${() => this.layer.openHouseRules({ kind: 'editor', isNew: true })}>
        <ha-icon icon="mdi:plus"></ha-icon>${t('hr.rule_new')}
      </button>
      ${rules.length
        ? html`<div class="group hr-rules">
            ${rules.map(
              (r) => html`<div class="hr-rule ${sel === r.id ? 'sel' : ''} ${r.enabled ? '' : 'off'}">
                <button class="row hr-pick" @click=${() => void this.showRule(sel === r.id ? undefined : r.id)}>
                  <span class="hr-dot" style=${`background:${hrColor(r.type === 'while' ? 'while' : 'when', this.hass.themes?.darkMode)}`}></span>
                  <div class="grow">
                    <div class="title">${r.name || t('hr.rule')}</div>
                    <div class="subtitle hr-sentence">${ruleSentence(r, this.hass)}</div>
                  </div>
                  <ha-icon icon=${sel === r.id ? 'mdi:eye' : 'mdi:eye-outline'} style=${`color:${sel === r.id ? 'var(--fp-accent)' : 'var(--fp-label-3)'}`}></ha-icon>
                </button>
                ${sel === r.id
                  ? html`<div class="hr-acts">
                      <button class="btn pressable" @click=${() => this.layer.openHouseRules({ kind: 'editor', rule: r, isNew: false })}><ha-icon icon="mdi:pencil-outline"></ha-icon>${t('hr.rule_edit')}</button>
                      <button class="btn pressable" @click=${() => void houseRules(this.hass).setEnabled(r.id, !r.enabled)}>
                        <ha-icon .icon=${r.enabled ? 'mdi:pause' : 'mdi:play'}></ha-icon>${r.enabled ? t('hr.rule_off') : t('hr.rule_on')}
                      </button>
                    </div>
                    <div class="hr-legend">
                      <span><i style=${`background:${hrColor('when', this.hass.themes?.darkMode)}`}></i>${t('hr.part_when')}</span>
                      <span><i style=${`background:${hrColor('and', this.hass.themes?.darkMode)}`}></i>${t('hr.part_and')}</span>
                      <span><i style=${`background:${hrColor('then', this.hass.themes?.darkMode)}`}></i>${t('hr.part_then')}</span>
                    </div>`
                  : nothing}
              </div>`,
            )}
          </div>`
        : html`<div class="hint-s">${t('hr.rules_empty')}</div>`}`;
  }

  /** What each vacuum has learned about the floor (companion), for aligning its map */
  vacLearned = new Map<string, LearnedFloor | null>();
  /** and its own map (rooms, walls — Roborock, map camera, Valetudo) */
  vacMaps = new Map<string, VacuumMap | null | undefined>();
  /** where its position and map come from (adapter, map entity), per entity */
  vacInfo = new Map<string, VacuumInfo | null | undefined>();
  /** `map`: the map entity picked by hand for this vacuum (none: the companion finds it) */
  loadVacLearned(entity: string, fresh = false, map?: string) {
    if (this.vacLearned.has(entity) && !fresh) return;
    this.vacLearned.set(entity, null);
    void vacuumLearned(this.hass, entity).then((l) => {
      this.vacLearned.set(entity, l ?? { res: 100, cells: [] });
      this.requestUpdate();
    });
    this.vacInfo.set(entity, null);
    void vacuumInfo(this.hass, entity, map).then((i) => {
      this.vacInfo.set(entity, i);
      this.requestUpdate();
    });
    if (!this.vacMaps.has(entity) || fresh) {
      this.vacMaps.set(entity, null);
      void vacuumMap(this.hass, entity, map).then((m) => {
        this.vacMaps.set(entity, m);
        this.requestUpdate();
        // the alignment mode was opened before the map arrived: start from a guess, show it all
        const f = this.alignPiece;
        if (f?.entity === entity) {
          if (!f.vacuum?.transform && m) this.alignAuto();
          this.updateComplete.then(() => this.refit(true));
        }
      });
    }
  }

  loadUsers() {
    if (this._users || this.usersLoading) return;
    this.usersLoading = true;
    this.hass
      .callWS<any[]>({ type: 'config/auth/list' })
      .then((list) => {
        this._users = list
          .filter((u) => !u.system_generated && u.is_active !== false)
          .map((u) => ({ id: u.id, name: u.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
      })
      .catch(() => (this._users = []));
  }

  private drag?: Drag;
  private original?: FloorplanCardConfig;
  private ro?: ResizeObserver;

  constructor() {
    super();
    this._tool = 'select';
    this._panel = null;
    this._sel = null;
    this._vertex = null;
    this._drawing = [];
    this._hover = null;
    this._snapGrid = true;
    this._snapGeom = true;
    this._linkWalls = true;
    this._showGrid = true;
    this._past = [];
    this._future = [];
    this._saving = false;
    this._yaml = false;
    this._discard = false;
    this._narrow = false;
    this._showLabels = true;
    this._furnCat = 'living';
    this._view3d = false;
    this._fullWalls = true;
    this._furnQ = '';
    this._kindQ = '';
    this._kindCat = 'all';
    this._tour = false;
    this._traceHidden = false;
  }

  // ---------- Lifecycle ----------

  override willUpdate(changed: PropertyValues) {
    if (changed.has('_tool') && this._tool !== 'draw') this.kbCursor = undefined;
    // calibrating / moving the trace image only while its panel is open
    if (changed.has('_panel') && this._panel !== 'trace' && this._traceMode?.mode) this._traceMode = undefined;
    if (changed.has('config') && this.config && !this._draft) {
      this.original = this.card.rawConfig ?? this.config;
      this._draft = structuredClone(this.config);
      // a shared plan: the link lives in _share (saved into the card config on "Save")
      this._share = shareFromCard(this.config, this.card.sharedPlan);
      delete (this._draft as Partial<FloorplanCardConfig>).plan;
      this.initial = JSON.stringify(this._draft);
      this.initialShare = JSON.stringify(this._share ?? null);
      this.floorId = this.floorId && this._draft.floors.some((f) => f.id === this.floorId) ? this.floorId : this._draft.floors[0]?.id;
      if (this.start?.config) {
        // one undo step back to the empty plan; "Save" keeps it, "Cancel" asks before discarding
        this.replaceDraft(this.start.config);
      }
      if (this.start?.hint) this.layer.toast(this.start.hint);
      if (this.start?.share) {
        this._panel = 'settings';
        this.shareOpen = this.shareScroll = true;
      }
      // a house laid out with its floors: "Wo ist die Treppe?" (nothing is guessed) — after the tour, if it shows
      this.stairsAsk = !!this.start?.askStairs;
      this.refit();
      // first visit: the short tour of the main tools (once per user, again from the toolbar)
      // (not when the person came to pick a shared plan: the tour would only be in the way)
      const fresh = !this.start?.share && (!!this.start || !this.config.floors.some((f) => f.rooms.length));
      if (fresh && this.hass)
        void tourSeen(this.hass).then((seen) => {
          if (!seen && this.isConnected) this._tour = true;
          else this.askStairsNow();
        });
      else this.askStairsNow();
    }
  }

  /** "Wo ist die Treppe?" still to ask (a house from the first steps) */
  private stairsAsk = false;
  private askStairsNow() {
    if (!this.stairsAsk || !this.isConnected) return;
    this.stairsAsk = false;
    askStairsOnStart(this, orderedFloors(this._draft, this.hass));
  }

  override updated(changed: PropertyValues) {
    super.updated(changed);
    // the tour is over: now the stairs question
    if (changed.has('_tour') && !this._tour && changed.get('_tour')) this.askStairsNow();
    if (changed.has('_panel') && this._panel !== 'settings') this.floorsOpen = false;
    // toolbar "Floors": the section is further down in the settings
    if (this.floorsScroll && this._panel === 'settings') {
      const d = this.renderRoot.querySelector('details[data-fold="floors"]') as HTMLDetailsElement | null;
      if (d) {
        this.floorsScroll = false;
        d.open = true;
        d.scrollIntoView({ block: 'start' });
      }
    }
    // first steps "use a shared floor plan": the section is further down in the settings
    if (this.shareScroll && this._panel === 'settings') {
      const d = this.renderRoot.querySelector('details[data-share]');
      if (d) {
        this.shareScroll = false;
        d.scrollIntoView({ block: 'center' });
        (d.querySelector('[data-share-use], [data-share-make]') as HTMLElement | null)?.focus({ preventScroll: true });
      }
    }
  }

  /** Toolbar "Tour": the tools are shown in 2D with no panel open */
  private startTour = () => {
    this._view3d = false;
    this._panel = null;
    this._tour = true;
  };

  /** Replaces the whole plan in the draft (first steps, a loaded file), keeping this card's type and id. Undoable. */
  replaceDraft(cfg: FloorplanCardConfig) {
    this.snapshot();
    this._draft = normalizeConfig({ ...this._draft, ...cfg, type: this._draft.type, card_id: this._draft.card_id });
    if (!this._draft.card_id) delete (this._draft as Partial<FloorplanCardConfig>).card_id;
    this.floorId = this._draft.floors[0]?.id;
    this.select(null);
    this._panel = null;
    this.refit();
  }

  /** Settings → floor plan as a file: download the draft as JSON (without this card's id) */
  exportPlan() {
    const file = planFile(this._draft);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grundriss-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    this.layer.toast(t('plan_io.downloaded'));
  }

  /** Settings → load a floor plan file: checked by config.ts, confirmed, then put into the draft (unsaved) */
  pickPlan() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.loadPlanFile(f);
    });
    input.click();
  }

  async loadPlanFile(f: File): Promise<boolean> {
    if (f.size > PLAN_MAX_BYTES) {
      this.layer.toast(t('plan_io.too_big'));
      return false;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      this.layer.toast(t('plan_io.unreadable'));
      return false;
    }
    const { config, errors } = readPlanFile(raw, this._draft);
    if (!config) {
      this.layer.toast(t('plan_io.failed', { e: errors.join(' ') }));
      return false;
    }
    const rooms = config.floors.reduce((n, fl) => n + fl.rooms.length, 0);
    if (!(await this.layer.confirm(t('plan_io.confirm', { name: f.name, f: config.floors.length, r: rooms })))) return false;
    this.replaceDraft(config);
    const missing = new Set<string>();
    for (const fl of config.floors) {
      for (const d of fl.devices) if (!this.hass.states[d.entity]) missing.add(d.entity);
      for (const r of fl.rooms) for (const e of [...(r.lights ?? []), r.climate, r.temperature, r.humidity]) if (e && !this.hass.states[e]) missing.add(e);
    }
    this.layer.toast(missing.size ? t('plan_io.loaded_missing', { n: missing.size }) : t('plan_io.loaded'));
    return true;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hass) {
      const link = houseRules(this.hass);
      void link.start().then((ok) => {
        if (!ok || !this.isConnected) return;
        this._hrOn = true;
        this.offHr = link.listen((st) => {
          this._hrRules = st.rules;
          this.loadHrCounts();
          if (this._hrSel) void this.showRule(this._hrSel);
        });
      });
    }
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onKeyUp);
    // "Treppe setzen" / "Wo ist die Treppe?" from the floors bar or the first steps (stairs-tool.ts)
    this.addEventListener('fp-place-stairs', this.onStairs);
    this.addEventListener('fp-ask-stairs', this.onStairs);
    this.ro = new ResizeObserver(() => {
      const r = this.getBoundingClientRect();
      this._narrow = r.width < 900 || r.height > r.width;
    });
    this.ro.observe(this);
    document.documentElement.style.overflow = 'hidden';
  }

  private onStairs = (e: Event) => onStairsEvent(this, e);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.offHr?.();
    clearTimeout(this.hrCountTimer);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onKeyUp);
    this.removeEventListener('fp-place-stairs', this.onStairs);
    this.removeEventListener('fp-ask-stairs', this.onStairs);
    this.ro?.disconnect();
    document.documentElement.style.overflow = '';
  }

  // ---------- Model helpers ----------

  get floor(): FloorConfig {
    return this._draft.floors.find((f) => f.id === this.floorId) ?? this._draft.floors[0];
  }

  get grid() {
    return this._draft.grid ?? 20;
  }

  get plan(): FpPlan | null {
    return this.renderRoot.querySelector('fp-plan');
  }

  private get scale() {
    return this.plan?.panZoom?.scale ?? 1;
  }

  /** Records history and applies a mutation to a fresh copy (new identities for Lit). */
  mutate(fn: (draft: FloorplanCardConfig, floor: FloorConfig) => void, record = true) {
    if (record) {
      this._past = [...this._past.slice(-HISTORY_LIMIT + 1), JSON.stringify(this._draft)];
      this._future = [];
    }
    const next = structuredClone(this._draft);
    const floor = next.floors.find((f) => f.id === this.floorId) ?? next.floors[0];
    fn(next, floor);
    this._draft = next;
  }

  private snapshot() {
    this._past = [...this._past.slice(-HISTORY_LIMIT + 1), JSON.stringify(this._draft)];
    this._future = [];
  }

  undo = () => {
    if (!this._past.length) return;
    this._future = [JSON.stringify(this._draft), ...this._future];
    this._draft = JSON.parse(this._past[this._past.length - 1]);
    this._past = this._past.slice(0, -1);
    this.validateSelection();
  };

  redo = () => {
    if (!this._future.length) return;
    this._past = [...this._past, JSON.stringify(this._draft)];
    this._draft = JSON.parse(this._future[0]);
    this._future = this._future.slice(1);
    this.validateSelection();
  };

  private validateSelection() {
    if (!this._draft.floors.some((f) => f.id === this.floorId)) this.floorId = this._draft.floors[0]?.id;
    if (this._sel && !this.findSel(this._sel)) this.select(null);
  }

  get dirty() {
    return JSON.stringify(this._draft) !== this.initial || JSON.stringify(this._share ?? null) !== this.initialShare;
  }

  // ---------- Trace image ----------

  setTraceMode(m: TraceMode | undefined) {
    this._traceMode = m;
  }

  viewCenterPoint(): Point {
    return this.viewCenter();
  }

  /** The current floor's trace image for the plan (same object while nothing changed) */
  private traceCache?: { src: unknown; href: string; out: { t: NonNullable<FloorConfig['trace']>; href: string } };
  private editorTrace() {
    const tr = this.floor.trace;
    if (!tr || this._traceHidden || this._view3d) return undefined;
    const href = traceHref(this.hass, tr, () => this.requestUpdate(), this.pendingImages);
    if (!href) return undefined;
    if (this.traceCache?.src !== tr || this.traceCache.href !== href) this.traceCache = { src: tr, href, out: { t: tr, href } };
    return this.traceCache.out;
  }

  // ---------- Shared plan ----------

  setShare(share: ShareState | undefined) {
    this._share = share;
  }

  loadPlans() {
    this._plans = [];
    void fetchPlans(this.hass).then((p) => (this._plans = p));
  }

  /** Take a shared plan: its content replaces the plan in the draft (undoable), this card shows it from "Save" on */
  adoptShared(p: SharedPlan) {
    this.snapshot();
    this._draft = normalizeConfig(mergePlan(this._draft, p.plan));
    delete (this._draft as Partial<FloorplanCardConfig>).plan;
    // base: the content in the same form "Save" compares, so saving right away writes no new revision
    this._share = { id: p.id, name: p.name, savedName: p.name, rev: p.rev, base: stableJson(contentOf(this._draft)) };
    this.floorId = this._draft.floors[0]?.id;
    this.select(null);
    this.refit();
  }

  findSel(sel: Selection): RoomConfig | DeviceConfig | OpeningConfig | FurnitureConfig | undefined {
    if (!sel) return undefined;
    const f = this.floor;
    if (sel.kind === 'room') return f.rooms.find((r) => r.id === sel.id);
    if (sel.kind === 'device') return f.devices.find((d) => d.id === sel.id);
    if (sel.kind === 'opening') return f.openings?.find((o) => o.id === sel.id);
    return f.furniture?.find((x) => x.id === sel.id);
  }

  select(sel: Selection, vertex: number | null = null) {
    this._sel = sel;
    this._vertex = vertex;
    if (sel) this._panel = 'inspect';
    else if (this._panel === 'inspect') this._panel = null;
  }

  /** Recompute the canvas bounds from the content and fit the view to them. */
  refit(animate = false) {
    if (this._align) return this.alignRefit(animate);
    const empty = !this.floor?.rooms.length && !this.floor?.devices.length;
    // an empty upper floor frames the floor below (its ghost is what the new walls line up with)
    const below = empty ? this.below : undefined;
    const b = floorBounds(below ?? this.floor);
    const m = empty && !below ? 0 : 160;
    this._fit = empty && !below ? { minX: 0, minY: 0, maxX: 1000, maxY: 700 } : { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
    this.updateComplete.then(() => this.plan?.panZoom?.reset(animate));
  }

  private polygons(exclude?: { room: string; index: number }): Point[][] {
    return this.floor.rooms.map((r) => (exclude && r.id === exclude.room ? r.points.filter((_, i) => i !== exclude.index) : r.points));
  }

  /** The floor below (with indoor rooms): shown as a ghost, its corners and walls snap */
  get below(): FloorConfig | undefined {
    if (!this._draft || this._draft.floor_below === false) return undefined;
    const b = floorBelow(this._draft, this.floor?.id, this.hass);
    return b?.rooms.some((r) => r.points.length >= 3 && !r.outdoor) ? b : undefined;
  }

  snap(p: Point, exclude?: { room: string; index: number }, extra: Point[][] = []): SnapResult {
    const ghost = this.below?.rooms.filter((r) => r.points.length >= 3 && !r.outdoor).map((r) => r.points) ?? [];
    return snapPoint(p, [...this.polygons(exclude), ...extra, ...ghost], {
      grid: this.grid,
      tolerance: SNAP_PX / this.scale,
      snapGeometry: this._snapGeom,
      snapGrid: this.gridSnap,
    });
  }

  /** Room corners and walls snap to the grid: switched on, and not on a floor drawn freely (one made from a robot
   * vacuum's map: its walls are not on a grid, snapping them there would bend them) */
  get gridSnap(): boolean {
    return this._snapGrid && this.floor?.grid_snap !== false;
  }

  private ghostRooms(): Point[][] {
    return this.below?.rooms.filter((r) => r.points.length >= 3 && !r.outdoor).map((r) => r.points) ?? [];
  }

  private snapGrid(v: number, step = this.grid / 2) {
    return this._snapGrid ? Math.round(v / step) * step : round(v);
  }

  /** Nearest wall edge to a point (for doors/windows). */
  nearestEdge(p: Point, tolPx = 40): { a: Point; b: Point; point: Point; t: number } | null {
    let best: { a: Point; b: Point; point: Point; t: number; dist: number } | null = null;
    for (const r of this.floor.rooms)
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i];
        const b = r.points[(i + 1) % r.points.length];
        const c = closestPointOnSegment(p, a, b);
        if (c.dist <= tolPx / this.scale && (!best || c.dist < best.dist)) best = { a, b, point: c.point, t: c.t, dist: c.dist };
      }
    return best;
  }

  // ---------- Gestures from the plan ----------

  private parseHandle(tg: HitTarget): string | undefined {
    return tg.id?.startsWith('handle:') ? tg.id.slice(7) : undefined;
  }

  private handlers = {
    hasDoubleTap: () => false,
    onTap: (tg: HitTarget, w: Point) => this.onTap(tg, w),
    onDoubleTap: () => undefined,
    onHold: (tg: HitTarget) => {
      const h = this.parseHandle(tg);
      if (h?.startsWith('v:')) this.deleteVertex(Number(h.slice(2)));
    },
    // Ctrl / Cmd / Space held: the drag moves the view instead of whatever is under the pointer
    onDragStart: (tg: HitTarget, w: Point, e?: PointerEvent) => (e?.ctrlKey || e?.metaKey || this.spaceHeld ? false : this.onDragStart(tg, w, !!e?.altKey)),
    onDragMove: (w: Point) => this.onDragMove(w),
    onDragEnd: (_w: Point, cancelled: boolean) => this.onDragEnd(cancelled),
    onHover: (w: Point | null) => {
      if (w) this.kbCursor = undefined;
      if (this._tool === 'draw' && w) this._hover = this.snap(w, undefined, this._drawing.length ? [this._drawing] : []);
      else if (this._hover) this._hover = null;
    },
  };

  private onTap(tg: HitTarget, w: Point) {
    if (this._align) return this.alignTap(w);
    if (this._panel === 'trace' && this._traceMode?.mode === 'calibrate') return traceTap(this, w);
    if (this._panel === 'trace' && this._traceMode?.mode === 'move') return;
    const h = this.parseHandle(tg);
    if (this._tool === 'draw') return this.addDrawPoint(w, h);
    if (this._tool === 'door' || this._tool === 'window' || this._tool === 'garage') return this.placeOpening(w, this._tool);
    if (this._tool === 'stairs') return stairsTap(this, w);
    if (h?.startsWith('label:')) return this.select({ kind: 'room', id: h.slice(6) });
    if (h) {
      if (h.startsWith('v:')) this._vertex = Number(h.slice(2));
      else if (h.startsWith('m:')) this.insertVertex(Number(h.slice(2)));
      return;
    }
    if (tg.kind === 'background') return this.select(null);
    if (tg.kind === 'room' && this._sel?.kind === 'room' && this._sel.id === tg.id) return;
    this.select({ kind: tg.kind, id: tg.id! } as Selection);
  }

  private addDrawPoint(w: Point, handle?: string) {
    const pts = this._drawing;
    const s = handle === 'd:0' && pts.length >= 3 ? { point: pts[0], kind: 'vertex' as const } : this.snap(w, undefined, pts.length ? [pts] : []);
    if (pts.length >= 3 && Math.hypot(s.point[0] - pts[0][0], s.point[1] - pts[0][1]) < 0.5) return this.finishDrawing();
    const last = pts[pts.length - 1];
    if (last && Math.hypot(s.point[0] - last[0], s.point[1] - last[1]) < 0.5) return;
    this._drawing = [...pts, s.point];
  }

  finishDrawing = () => {
    const pts = this._drawing;
    if (pts.length < 3) return;
    const id = uid('room');
    this.mutate((_d, f) => {
      f.rooms.push({ id, name: `${t('editor.room')} ${f.rooms.length + 1}`, points: pts });
    });
    this._drawing = [];
    this._hover = null;
    this._tool = 'select';
    this.select({ kind: 'room', id });
  };

  cancelDrawing = () => {
    this._drawing = [];
    this._hover = null;
  };

  removeLastPoint = () => {
    this._drawing = this._drawing.slice(0, -1);
  };

  private placeOpening(w: Point, type: 'door' | 'window' | 'garage') {
    const e = this.nearestEdge(w);
    if (!e) return this.layer.toast(t('editor.opening_hint'));
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    let width = Math.min(type === 'door' ? 90 : type === 'garage' ? 250 : 120, len * 0.8);
    const half = width / 2 / len;
    const tc = Math.max(half, Math.min(1 - half, e.t));
    const dir: Point = [(e.b[0] - e.a[0]) / len, (e.b[1] - e.a[1]) / len];
    const c: Point = [e.a[0] + (e.b[0] - e.a[0]) * tc, e.a[1] + (e.b[1] - e.a[1]) * tc];
    width = round(width);
    const id = uid('open');
    this.mutate((_d, f) => {
      (f.openings ??= []).push({
        id,
        type,
        a: [round(c[0] - (dir[0] * width) / 2), round(c[1] - (dir[1] * width) / 2)],
        b: [round(c[0] + (dir[0] * width) / 2), round(c[1] + (dir[1] * width) / 2)],
      });
    });
    this._tool = 'select';
    this.select({ kind: 'opening', id });
  }

  insertVertex(edgeIndex: number) {
    const room = this.findSel(this._sel) as RoomConfig | undefined;
    if (!room) return;
    const a = room.points[edgeIndex];
    const b = room.points[(edgeIndex + 1) % room.points.length];
    const mid: Point = [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)];
    this.mutate((_d, f) => {
      f.rooms.find((r) => r.id === room.id)!.points.splice(edgeIndex + 1, 0, mid);
    });
    this._vertex = edgeIndex + 1;
  }

  deleteVertex = (index?: number) => {
    const i = index ?? this._vertex;
    const room = this.findSel(this._sel) as RoomConfig | undefined;
    if (!room || i == null || room.points.length <= 3) return;
    this.mutate((_d, f) => {
      f.rooms.find((r) => r.id === room.id)!.points.splice(i, 1);
    });
    this._vertex = null;
  };

  private onDragStart(tg: HitTarget, w: Point, alt = false): boolean {
    const h = this.parseHandle(tg);
    // moving the trace image: it follows the finger wherever it is grabbed
    if (this._panel === 'trace' && this._traceMode?.mode === 'move' && this.floor.trace) {
      this.snapshot();
      this.drag = { type: 'trace', start: w, orig: { x: this.floor.trace.x, y: this.floor.trace.y }, moved: false };
      return true;
    }
    if (this._panel === 'trace' && this._traceMode?.mode === 'calibrate') return false;
    if (this._align) {
      // the map moves wherever it is grabbed (setting points: the view pans instead)
      const ve = this.vacEdit();
      const tool = this._align.tool;
      // a wall of the plan: moves along its normal, snapping onto lines of the vacuum's map
      if (h?.startsWith('pw:')) {
        const walls = planWalls(this.floor);
        const wl = walls[Number(h.slice(3))];
        if (!wl) return false;
        this.snapshot();
        const vm = this.alignMap;
        const m = ve?.m;
        const [b, a] = wallEnds(wl);
        const lines = vm && m ? wallLines(vm, m, a, b, 120, this.mapRoomsOf(wl.rooms)).map((x) => x.off) : [];
        this.drag = { type: 'planwall', id: h.slice(3), start: w, orig: { rooms: structuredClone(this.floor.rooms), openings: structuredClone(this.floor.openings ?? []), wall: wl, index: Number(h.slice(3)), lines }, moved: false };
        return true;
      }
      if (!ve || ((tool === 'pairs' || tool === 'walls') && !h)) return false;
      // cutting out: the drag spans a rectangle
      if (tool === 'crop' && !h) {
        this.drag = { type: 'vaccrop', id: ve.f.id, start: w, moved: false };
        return true;
      }
      this.snapshot();
      const type = h === 'vac-rot' ? 'vacrot' : h?.startsWith('vac-e:') ? 'vacedge' : h?.startsWith('vac-s') ? 'vacscale' : 'vacmap';
      const room = this._align.room;
      this.drag = {
        type,
        id: ve.f.id,
        start: w,
        orig: {
          tf: { ...ve.tf },
          centre: ve.centre,
          centreRobot: ve.centreRobot,
          axis: h === 'vac-sx' ? 'x' : h === 'vac-sy' ? 'y' : 'xy',
          room,
          fit: room ? this.roomFit(room) : undefined,
          side: h?.startsWith('vac-e:') ? h.slice(6) : undefined,
          box: { ...ve.box },
          vac: structuredClone(ve.f.vacuum ?? {}),
        },
        moved: false,
      };
      return true;
    }
    if (this._tool === 'draw') {
      // With points placed, a one-finger drag positions the next point (live preview + length).
      if (this._drawing.length) {
        this.drag = { type: 'point', start: w, moved: false };
        this._hover = this.snap(w, undefined, [this._drawing]);
        return true;
      }
      this.drag = { type: 'rect', start: this.snap(w).point, moved: false };
      return true;
    }
    if (this._tool !== 'select') return false;
    if (h?.startsWith('label:')) {
      const id = h.slice(6);
      const room = this.floor.rooms.find((r) => r.id === id);
      if (!room) return false;
      this.snapshot();
      this.select({ kind: 'room', id });
      this.drag = { type: 'label', id, start: w, orig: room.label ?? polylabel(room.points), moved: false };
      return true;
    }
    const sel = this._sel;
    // a vacuum's map: drag it by its handle or by its dots, turn it by the rotate handle
    const ve = this.vacEdit();
    if (ve && (h === 'vac-move' || h === 'vac-rot' || h?.startsWith('vac-s') || (!h && ve.pts.some((p) => Math.hypot(p[0] - w[0], p[1] - w[1]) < 22 / this.scale)))) {
      this.snapshot();
      const type = h === 'vac-rot' ? 'vacrot' : h?.startsWith('vac-s') ? 'vacscale' : 'vacmap';
      this.drag = { type, id: ve.f.id, start: w, orig: { tf: { ...ve.tf }, centre: ve.centre, centreRobot: ve.centreRobot, axis: h === 'vac-sx' ? 'x' : h === 'vac-sy' ? 'y' : 'xy' }, moved: false };
      return true;
    }
    if (h && sel) {
      if (h.startsWith('v:') && sel.kind === 'room') {
        this.snapshot();
        this._vertex = Number(h.slice(2));
        // a corner other rooms share moves for them too (Alt / switched off: only this room's)
        const shared: CornerRef[] = sharedCorners(this.floor, sel.id, this._vertex, this._linkWalls && !alt);
        this.drag = { type: 'vertex', id: sel.id, index: this._vertex, start: w, orig: { shared }, moved: false };
        return true;
      }
      if (h.startsWith('m:') && sel.kind === 'room') {
        // the middle of a wall: drags the whole wall along its normal (a tap still adds a corner there); a wall
        // another room shares goes along for it
        const mv = edgeMove(this.floor, sel.id, Number(h.slice(2)), this._linkWalls && !alt);
        if (!mv) return false;
        this.snapshot();
        this.drag = { type: 'edge', id: sel.id, index: Number(h.slice(2)), start: w, orig: { mv, rooms: structuredClone(this.floor.rooms), openings: structuredClone(this.floor.openings ?? []) }, moved: false };
        return true;
      }
      if ((h === 'oa' || h === 'ob') && sel.kind === 'opening') {
        const o = this.findSel(sel) as OpeningConfig;
        this.snapshot();
        this.drag = { type: h === 'oa' ? 'opening-a' : 'opening-b', id: sel.id, start: w, orig: structuredClone(o), edge: this.edgeOf(o), moved: false };
        return true;
      }
      if ((h === 'rot' || h === 'size') && sel.kind === 'furniture') {
        this.snapshot();
        this.drag = { type: h === 'rot' ? 'rotate' : 'resize', id: sel.id, start: w, orig: structuredClone(this.findSel(sel)), moved: false };
        return true;
      }
    }
    if (tg.kind === 'device' && tg.id) {
      this.snapshot();
      this.select({ kind: 'device', id: tg.id });
      const d = this.findSel(this._sel) as DeviceConfig;
      this.drag = { type: 'device', id: tg.id, start: w, orig: { x: d.x, y: d.y }, moved: false };
      return true;
    }
    if (tg.kind === 'opening' && tg.id) {
      this.snapshot();
      this.select({ kind: 'opening', id: tg.id });
      const o = this.findSel(this._sel) as OpeningConfig;
      this.drag = { type: 'opening', id: tg.id, start: w, orig: structuredClone(o), edge: this.edgeOf(o), moved: false };
      return true;
    }
    if (tg.kind === 'furniture' && tg.id) {
      this.snapshot();
      this.select({ kind: 'furniture', id: tg.id });
      const x = this.findSel(this._sel) as FurnitureConfig;
      this.drag = { type: 'furniture', id: tg.id, start: w, orig: { x: x.x, y: x.y }, moved: false };
      return true;
    }
    if (tg.kind === 'room' && sel?.kind === 'room' && sel.id === tg.id) {
      this.snapshot();
      const r = this.findSel(sel) as RoomConfig;
      this.drag = { type: 'room', id: sel.id, start: w, orig: structuredClone(r.points), moved: false };
      return true;
    }
    return false;
  }

  /** Wall edge an opening lies on (closest edge to its midpoint). */
  private edgeOf(o: OpeningConfig): [Point, Point] {
    const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    let best: [Point, Point] = [o.a, o.b];
    let bd = Infinity;
    for (const r of this.floor.rooms)
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i];
        const b = r.points[(i + 1) % r.points.length];
        const c = closestPointOnSegment(mid, a, b);
        if (c.dist < bd) {
          bd = c.dist;
          best = [a, b];
        }
      }
    return best;
  }

  private onDragMove(w: Point) {
    const d = this.drag;
    if (!d) return;
    d.moved = true;
    const dx = w[0] - d.start[0];
    const dy = w[1] - d.start[1];
    switch (d.type) {
      case 'trace': {
        const o = d.orig as { x: number; y: number };
        patchTrace(this, (tr) => ({ ...tr, x: round(o.x + dx, 1), y: round(o.y + dy, 1) }), false);
        break;
      }
      case 'vaccrop':
        this._align = { ...this._align!, cropDraft: [d.start, w] };
        break;
      case 'planwall': {
        // the wall follows the finger along its normal; near a line of the vacuum's map it snaps onto it
        const o = d.orig as { rooms: RoomConfig[]; openings: OpeningConfig[]; wall: { nrm: Point; off: number }; index: number; lines: number[] };
        let delta = (w[0] - d.start[0]) * o.wall.nrm[0] + (w[1] - d.start[1]) * o.wall.nrm[1];
        const near = o.lines.map((l) => l - o.wall.off).sort((x, y) => Math.abs(x - delta) - Math.abs(y - delta))[0];
        if (near !== undefined && Math.abs(near - delta) < 10 / this.scale) delta = near;
        delta = Math.round(delta);
        this.mutate((_x, f) => {
          f.rooms = structuredClone(o.rooms);
          f.openings = structuredClone(o.openings);
          const walls = planWalls(f);
          moveWalls(f, walls, walls.map((_, i) => (i === o.index ? delta : 0)));
        }, false);
        break;
      }
      case 'vacedge': {
        // one side (or corner) of the map / the room: the opposite one stays put
        const o = d.orig as { tf: VacuumTransform; room?: string; fit?: VacuumRoomFit; side: string; box: { minX: number; minY: number; maxX: number; maxY: number }; vac: VacuumLive };
        const b = o.box;
        const ax = o.side.includes('l') ? b.maxX : o.side.includes('r') ? b.minX : (b.minX + b.maxX) / 2;
        const ay = o.side.includes('t') ? b.maxY : o.side.includes('b') ? b.minY : (b.minY + b.maxY) / 2;
        const k = (now: number, was: number) => (Math.abs(was) < 5 ? 1 : Math.max(0.4, Math.min(2.5, now / was)));
        const fx = o.side.includes('l') || o.side.includes('r') ? k(w[0] - ax, d.start[0] - ax) : 1;
        const fy = o.side.includes('t') || o.side.includes('b') ? k(w[1] - ay, d.start[1] - ay) : 1;
        const vm = this.alignMap;
        const before = mapperOf(o.vac, vm)!;
        const anchorRobot = before.toRobot(ax, ay, o.room ?? null);
        const next: VacuumLive = structuredClone(o.vac);
        if (o.room && o.fit) {
          const sx = Math.round((o.fit.scale ?? 1) * fx * 1000) / 1000;
          const sy = Math.round((o.fit.scaleY ?? o.fit.scale ?? 1) * fy * 1000) / 1000;
          next.rooms = { ...(next.rooms ?? {}), [o.room]: { ...o.fit, scale: sx === 1 ? undefined : sx, scaleY: sy === sx ? undefined : sy } };
        } else {
          const s0 = o.tf.scale ?? 0.1;
          const sy0 = o.tf.scaleY ?? s0;
          const sx = Math.round(s0 * fx * 10000) / 10000;
          const sy = Math.round(sy0 * fy * 10000) / 10000;
          next.transform = { ...o.tf, scale: sx, scaleY: sy !== sx ? sy : undefined };
        }
        const p = mapperOf(next, vm)!.toPlan(anchorRobot[0], anchorRobot[1], o.room ?? null);
        const dxA = ax - p[0];
        const dyA = ay - p[1];
        if (o.room && next.rooms?.[o.room]) {
          const f2 = next.rooms[o.room];
          f2.x = Math.round((f2.x ?? 0) + dxA) || undefined;
          f2.y = Math.round((f2.y ?? 0) + dyA) || undefined;
          this.setRoomFit(o.room, f2, false);
        } else if (next.transform) {
          next.transform.x = Math.round(next.transform.x + dxA);
          next.transform.y = Math.round(next.transform.y + dyA);
          this.setAlignTf(next.transform, false);
        }
        break;
      }
      case 'vacmap':
      case 'vacrot':
      case 'vacscale': {
        const o = d.orig as { tf: VacuumTransform; centre: Point; centreRobot: Point; axis: 'x' | 'y' | 'xy'; room?: string; fit?: VacuumRoomFit };
        if (o.room && o.fit) {
          // one room of the vacuum's map on its own: moved, turned about its middle, stretched
          const fit = { ...o.fit };
          if (d.type === 'vacmap') {
            fit.x = Math.round((o.fit.x ?? 0) + dx) || undefined;
            fit.y = Math.round((o.fit.y ?? 0) + dy) || undefined;
          } else if (d.type === 'vacrot') {
            const a0 = Math.atan2(d.start[1] - o.centre[1], d.start[0] - o.centre[0]);
            const a1 = Math.atan2(w[1] - o.centre[1], w[0] - o.centre[0]);
            fit.rot = Math.round((((o.fit.rot ?? 0) + ((a1 - a0) * 180) / Math.PI) % 360) * 2) / 2 || undefined;
          } else {
            const k = (a: number, b: number) => (Math.abs(b) < 1 ? 1 : Math.max(0.5, Math.min(2, a / b)));
            const fx = o.axis === 'y' ? 1 : o.axis === 'x' ? k(w[0] - o.centre[0], d.start[0] - o.centre[0]) : k(Math.hypot(w[0] - o.centre[0], w[1] - o.centre[1]), Math.hypot(d.start[0] - o.centre[0], d.start[1] - o.centre[1]));
            const fy = o.axis === 'x' ? 1 : o.axis === 'y' ? k(w[1] - o.centre[1], d.start[1] - o.centre[1]) : fx;
            const sx = Math.round((o.fit.scale ?? 1) * fx * 1000) / 1000;
            const sy = Math.round((o.fit.scaleY ?? o.fit.scale ?? 1) * fy * 1000) / 1000;
            fit.scale = sx === 1 ? undefined : sx;
            fit.scaleY = sy === sx ? undefined : sy;
          }
          this.setRoomFit(o.room, fit, false);
          break;
        }
        let tf: VacuumTransform;
        if (d.type === 'vacmap') tf = { ...o.tf, x: Math.round(o.tf.x + dx), y: Math.round(o.tf.y + dy) };
        else if (d.type === 'vacscale') {
          // stretch about the middle of the map (that point stays): across, along or both
          const k = (a: number, b: number) => (Math.abs(b) < 1 ? 1 : Math.max(0.5, Math.min(2, a / b)));
          const fx = o.axis === 'y' ? 1 : o.axis === 'x' ? k(w[0] - o.centre[0], d.start[0] - o.centre[0]) : k(Math.hypot(w[0] - o.centre[0], w[1] - o.centre[1]), Math.hypot(d.start[0] - o.centre[0], d.start[1] - o.centre[1]));
          const fy = o.axis === 'x' ? 1 : o.axis === 'y' ? k(w[1] - o.centre[1], d.start[1] - o.centre[1]) : fx;
          const s0 = o.tf.scale ?? 0.1;
          const sy0 = o.tf.scaleY ?? s0;
          const sx = Math.round(s0 * fx * 10000) / 10000;
          const sy = Math.round(sy0 * fy * 10000) / 10000;
          tf = { ...o.tf, scale: sx, scaleY: sy !== sx ? sy : undefined };
          const c = toPlan(tf, o.centreRobot[0], o.centreRobot[1]);
          tf.x = Math.round(tf.x + o.centre[0] - c[0]);
          tf.y = Math.round(tf.y + o.centre[1] - c[1]);
        } else {
          // turn around the middle of the map: that point stays where it is
          const a0 = Math.atan2(d.start[1] - o.centre[1], d.start[0] - o.centre[0]);
          const a1 = Math.atan2(w[1] - o.centre[1], w[0] - o.centre[0]);
          const rot = Math.round(((((o.tf.rot ?? 0) + ((a1 - a0) * 180) / Math.PI) % 360) + 360) % 360 * 2) / 2;
          tf = { ...o.tf, rot };
          const c = toPlan(tf, o.centreRobot[0], o.centreRobot[1]);
          tf.x = Math.round(tf.x + o.centre[0] - c[0]);
          tf.y = Math.round(tf.y + o.centre[1] - c[1]);
        }
        this.mutate((_x, f) => {
          const it = f.furniture!.find((x) => x.id === d.id)!;
          it.vacuum = { ...(it.vacuum ?? {}), transform: tf };
        }, false);
        break;
      }
      case 'label': {
        const o = d.orig as Point;
        this.mutate((_x, f) => {
          f.rooms.find((r) => r.id === d.id)!.label = [this.snapGrid(o[0] + dx, 5), this.snapGrid(o[1] + dy, 5)];
        }, false);
        break;
      }
      case 'point':
        this._hover = this.snap(w, undefined, [this._drawing]);
        break;
      case 'rect': {
        const end = this.snap(w).point;
        this._drawing = [d.start, [end[0], d.start[1]], end, [d.start[0], end[1]]];
        break;
      }
      case 'vertex': {
        const shared: CornerRef[] = (d.orig as { shared?: CornerRef[] } | undefined)?.shared ?? [{ room: d.id!, index: d.index! }];
        const s = snapCorner(this.floor, shared, w, { tolerance: SNAP_PX / this.scale, grid: this.grid, snapGrid: this.gridSnap, snapGeometry: this._snapGeom, ghost: this.ghostRooms() });
        this._hover = s;
        this.mutate((_x, f) => {
          for (const c of shared) {
            const r = f.rooms.find((x) => x.id === c.room);
            if (r?.points[c.index]) r.points[c.index] = s.point;
          }
        }, false);
        break;
      }
      case 'edge': {
        // the wall follows the finger along its normal, lining up with corners that stay (grid only when none is near)
        const o = d.orig as { mv: EdgeMove; rooms: RoomConfig[]; openings: OpeningConfig[] };
        const raw = (w[0] - d.start[0]) * o.mv.nrm[0] + (w[1] - d.start[1]) * o.mv.nrm[1];
        const base: FloorConfig = { ...this.floor, rooms: o.rooms, openings: o.openings };
        const { delta, snap } = snapEdge(base, o.mv, raw, { tolerance: SNAP_PX / this.scale, grid: this.grid, snapGrid: this.gridSnap, snapGeometry: this._snapGeom, extra: this.ghostRooms().flat() });
        this._hover = snap;
        this.mutate((_x, f) => {
          f.rooms = structuredClone(o.rooms);
          f.openings = structuredClone(o.openings);
          applyEdgeMove(f, o.mv, delta);
        }, false);
        break;
      }
      case 'room': {
        const orig = d.orig as Point[];
        const step = this.grid;
        const sx = this.gridSnap ? Math.round(dx / step) * step : round(dx);
        const sy = this.gridSnap ? Math.round(dy / step) * step : round(dy);
        this.mutate((_x, f) => {
          f.rooms.find((r) => r.id === d.id)!.points = orig.map((p) => [p[0] + sx, p[1] + sy]);
        }, false);
        break;
      }
      case 'device':
        this.mutate((_x, f) => {
          const dev = f.devices.find((x) => x.id === d.id)!;
          dev.x = this.snapGrid(d.orig.x + dx);
          dev.y = this.snapGrid(d.orig.y + dy);
        }, false);
        break;
      case 'furniture':
        this.mutate((_x, f) => {
          const it = f.furniture!.find((x) => x.id === d.id)!;
          it.x = this.snapGrid(d.orig.x + dx, 5);
          it.y = this.snapGrid(d.orig.y + dy, 5);
          const sw = this._snapGeom ? this.snapToWall(it) : undefined;
          if (sw) {
            it.x = sw.x;
            it.y = sw.y;
            it.rotation = sw.rotation || undefined;
          }
        }, false);
        break;
      case 'rotate': {
        const o = d.orig as FurnitureConfig;
        let ang = (Math.atan2(w[1] - o.y, w[0] - o.x) * 180) / Math.PI + 90;
        ang = Math.round(ang / 15) * 15;
        this.mutate((_x, f) => {
          f.furniture!.find((x) => x.id === d.id)!.rotation = ((ang % 360) + 360) % 360;
        }, false);
        break;
      }
      case 'resize': {
        const o = d.orig as FurnitureConfig;
        const rad = (-(o.rotation ?? 0) * Math.PI) / 180;
        const lx = (w[0] - o.x) * Math.cos(rad) - (w[1] - o.y) * Math.sin(rad);
        const ly = (w[0] - o.x) * Math.sin(rad) + (w[1] - o.y) * Math.cos(rad);
        this.mutate((_x, f) => {
          const it = f.furniture!.find((x) => x.id === d.id)!;
          it.w = Math.max(20, Math.round((Math.abs(lx) * 2) / 5) * 5);
          it.h = Math.max(20, Math.round((Math.abs(ly) * 2) / 5) * 5);
        }, false);
        break;
      }
      case 'opening':
      case 'opening-a':
      case 'opening-b': {
        const [ea, eb] = d.edge!;
        const len = Math.hypot(eb[0] - ea[0], eb[1] - ea[1]) || 1;
        const dir: Point = [(eb[0] - ea[0]) / len, (eb[1] - ea[1]) / len];
        const proj = (p: Point) => Math.max(0, Math.min(len, (p[0] - ea[0]) * dir[0] + (p[1] - ea[1]) * dir[1]));
        const at = (s: number): Point => [round(ea[0] + dir[0] * s), round(ea[1] + dir[1] * s)];
        const o = d.orig as OpeningConfig;
        let sa = proj(o.a);
        let sb = proj(o.b);
        if (d.type === 'opening') {
          const shift = Math.round((dx * dir[0] + dy * dir[1]) / 5) * 5;
          const lo = Math.min(sa, sb);
          const hi = Math.max(sa, sb);
          const k = Math.max(-lo, Math.min(len - hi, shift));
          sa += k;
          sb += k;
        } else {
          const s = Math.round(proj(w) / 5) * 5;
          if (d.type === 'opening-a') sa = Math.abs(s - sb) >= 30 ? s : sa;
          else sb = Math.abs(s - sa) >= 30 ? s : sb;
        }
        this.mutate((_x, f) => {
          const it = f.openings!.find((x) => x.id === d.id)!;
          it.a = at(sa);
          it.b = at(sb);
        }, false);
        break;
      }
    }
  }

  private onDragEnd(cancelled: boolean) {
    const d = this.drag;
    this.drag = undefined;
    const hovered = this._hover?.point;
    this._hover = null;
    if (!d) return;
    if (d.type === 'vaccrop') {
      if (cancelled) this._align = { ...this._align!, cropDraft: undefined };
      else this.alignCropEnd();
      return;
    }
    if (d.type === 'point') {
      const p = hovered;
      if (!cancelled && p) this.addDrawPoint(p, Math.hypot(p[0] - this._drawing[0][0], p[1] - this._drawing[0][1]) < 0.5 ? 'd:0' : undefined);
      return;
    }
    if (d.type === 'rect') {
      const b = boundsOf(this._drawing);
      if (!cancelled && this._drawing.length === 4 && b.maxX - b.minX >= this.grid && b.maxY - b.minY >= this.grid) {
        this.finishDrawing();
      } else this._drawing = [];
      return;
    }
    if (cancelled || !d.moved) {
      // Revert to the snapshot taken at drag start.
      if (this._past.length) {
        this._draft = JSON.parse(this._past[this._past.length - 1]);
        this._past = this._past.slice(0, -1);
      }
    }
  }

  // ---------- Library drag & drop (devices, furniture) ----------

  private startLibraryDrag(e: PointerEvent, item: { entity?: string; kind?: string; variant?: string }, label: string, icon: string) {
    this._ghost = { label, icon, x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => (this._ghost = { label, icon, x: ev.clientX, y: ev.clientY });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this._ghost = undefined;
      const plan = this.plan;
      if (!plan || ev.type === 'pointercancel') return;
      const r = plan.getBoundingClientRect();
      const panel = this.renderRoot.querySelector('.panel')?.getBoundingClientRect();
      const inPanel = panel && ev.clientX >= panel.left && ev.clientX <= panel.right && ev.clientY >= panel.top && ev.clientY <= panel.bottom;
      if (inPanel || ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      this.addItemAt(item, plan.panZoom!.clientToWorld(ev.clientX, ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Visible canvas center in world coordinates (tap-to-place fallback). */
  private viewCenter(): Point {
    const plan = this.plan!;
    const r = plan.getBoundingClientRect();
    const panel = this.renderRoot.querySelector('.panel')?.getBoundingClientRect();
    const w = this._narrow || !panel ? r.width : r.width - panel.width;
    const h = this._narrow && panel ? r.height - panel.height : r.height;
    return plan.panZoom!.clientToWorld(r.left + w / 2, r.top + h / 2);
  }

  addItemAt(item: { entity?: string; kind?: string; variant?: string }, w: Point) {
    if (item.entity) {
      const id = uid('dev');
      this.mutate((_d, f) => {
        const st = this.hass?.states[item.entity!];
        const at: [number, number] = [this.snapGrid(w[0]), this.snapGrid(w[1])];
        // a temperature sensor placed outside every room: shown as a quiet number by default (outdoor temperature)
        const temp = st?.attributes.device_class === 'temperature' || /°[CF]/.test(String(st?.attributes.unit_of_measurement ?? ''));
        const outside = !f.rooms.some((r) => r.points.length >= 3 && pointInPolygon(at, r.points));
        f.devices.push({ id, entity: item.entity!, x: at[0], y: at[1], ...(temp && outside ? { display: 'value' as const } : {}) });
      });
      this.select({ kind: 'device', id });
    } else if (item.kind) {
      const k = FURNITURE_BY_KIND.get(item.kind)!;
      const v0 = (item.variant ? k.variants?.find((v) => v.id === item.variant) : undefined) ?? k.variants?.[0];
      const id = uid('furn');
      this.mutate((_d, f) => {
        const it: FurnitureConfig = { id, kind: k.kind, ...(item.variant && v0 ? { variant: v0.id } : {}), x: this.snapGrid(w[0], 5), y: this.snapGrid(w[1], 5), w: v0?.w ?? k.w, h: v0?.h ?? k.h };
        const sw = this._snapGeom ? this.snapToWall(it) : undefined;
        if (sw) Object.assign(it, { x: sw.x, y: sw.y, rotation: sw.rotation || undefined });
        (f.furniture ??= []).push(it);
      });
      this.select({ kind: 'furniture', id });
    }
  }

  /**
   * Dock a piece against the nearest wall: back side to the wall, front into the room.
   * Returns the snapped placement or undefined when no wall is close.
   */
  snapToWall(f: FurnitureConfig): { x: number; y: number; rotation: number } | undefined {
    if (!snapsToWall(f)) return undefined;
    const wall = this._draft.wall_width ?? 8;
    let best: { d: number; p: Point; n: Point } | undefined;
    for (const r of this.floor.rooms)
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i];
        const b = r.points[(i + 1) % r.points.length];
        const c = closestPointOnSegment([f.x, f.y], a, b);
        if (c.t <= 0.001 || c.t >= 0.999) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        let n: Point = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        // normal pointing into the room this piece is in
        if (!pointInPolygon([c.point[0] + n[0] * 5, c.point[1] + n[1] * 5], r.points)) n = [-n[0], -n[1]];
        if ((f.x - c.point[0]) * n[0] + (f.y - c.point[1]) * n[1] < -10) continue; // piece is on the other side
        if (!best || c.dist < best.d) best = { d: c.dist, p: c.point, n };
      }
    if (!best || best.d > f.h / 2 + 40) return undefined;
    const off = wall / 2 + f.h / 2 + 0.5;
    const rotation = Math.round(((Math.atan2(-best.n[0], best.n[1]) * 180) / Math.PI + 360) % 360);
    return { x: round(best.p[0] + best.n[0] * off, 1), y: round(best.p[1] + best.n[1] * off, 1), rotation: rotation % 360 };
  }

  duplicateSelection = () => {
    const sel = this._sel;
    if (sel?.kind !== 'furniture' && sel?.kind !== 'device') return;
    const id = uid(sel.kind === 'furniture' ? 'furn' : 'dev');
    this.mutate((_d, f) => {
      const list = (sel.kind === 'furniture' ? f.furniture : f.devices) as any[];
      const src = list.find((x) => x.id === sel.id);
      if (src) list.push({ ...structuredClone(src), id, x: src.x + 20, y: src.y + 20 });
    });
    this.select({ kind: sel.kind, id });
  };

  // ---------- Entity picker ----------

  openPicker(p: PickerState) {
    this._picker = p;
  }

  /** Change an object's kind: opens on the current kind's category; search covers all kinds and variants */
  openKindPicker(current: string | undefined, onPick: (kind: string, variant?: string) => void) {
    this._kindQ = '';
    this._kindCat = FURNITURE_BY_KIND.get(current ?? '')?.cat ?? 'all';
    this._kindPick = { current, onPick };
  }

  /** Entity sheet (manual entity / re-categorise); the entity itself can be changed through the picker on top */
  openEntityEdit(s: EntityEditState) {
    this._entEdit = { ...s, value: { ...s.value } };
  }

  private renderEntityEdit() {
    const s = this._entEdit!;
    const v = s.value;
    const patch = (p: Partial<ManualEntityConfig>) => (this._entEdit = { ...s, value: { ...v, ...p } });
    const st = v.entity ? this.hass.states[v.entity] : undefined;
    const groups = [...new Set((s.roles ?? []).map((r) => r.group ?? ''))];
    return html`<div class="modal-scrim" @click=${() => (this._entEdit = undefined)}></div>
      <div class="picker ent-edit" role="dialog" aria-modal="true">
        <div class="panel-head">
          <div class="panel-title">${s.title}</div>
          <button
            class="btn accent pressable"
            data-ent-save
            ?disabled=${!v.entity}
            @click=${() => {
              const out: ManualEntityConfig = { entity: v.entity };
              if (v.role) out.role = v.role;
              if (v.name?.trim()) out.name = v.name.trim();
              if (v.icon) out.icon = v.icon;
              s.onSave(out);
              this._entEdit = undefined;
            }}
          >${t('common.done')}</button>
        </div>
        <div class="panel-body ent-body">
          <div class="group">
            <div class="row">
              <button class="grow pick" @click=${() => this.openPicker({ title: t('editor.entity'), filter: s.filter, selected: v.entity ? [v.entity] : [], onPick: (ids) => patch({ entity: ids[0] }) })}>
                <div class="subtitle">${t('editor.entity')}</div>
                <div class="title ${v.entity ? '' : 'placeholder'}">${v.entity ? (st?.attributes.friendly_name ?? v.entity) : t('editor.choose_entity')}</div>
              </button>
              <ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>
            </div>
            <label class="row field-row">
              <span class="subtitle">${t('editor.name')}</span>
              <input class="field inline" data-ent-name .value=${v.name ?? ''} placeholder=${st?.attributes.friendly_name ?? ''} @input=${(e: Event) => patch({ name: (e.target as HTMLInputElement).value })} />
            </label>
            ${s.roles?.length
              ? html`<label class="row field-row">
                  <span class="subtitle">${t('editor.ent_role')}</span>
                  <select class="field inline" data-ent-role @change=${(e: Event) => patch({ role: (e.target as HTMLSelectElement).value || undefined })}>
                    ${groups.map((g) => {
                      const opts = s.roles!.filter((r) => (r.group ?? '') === g).map((r) => html`<option value=${r.value} ?selected=${r.value === (v.role ?? '')}>${r.label}</option>`);
                      return g ? html`<optgroup label=${g}>${opts}</optgroup>` : opts;
                    })}
                  </select>
                </label>`
              : nothing}
          </div>
          <div class="section-title">${t('editor.icon')}</div>
          <fp-icon-picker .hass=${this.hass} .value=${v.icon} .placeholder=${(st?.attributes.icon as string | undefined) ?? ''} @value-change=${(e: CustomEvent) => patch({ icon: e.detail.value })}></fp-icon-picker>
          ${s.onRemove
            ? html`<button class="btn danger block pressable gap" data-ent-remove @click=${() => {
                s.onRemove!();
                this._entEdit = undefined;
              }}><ha-icon icon="mdi:eye-off-outline"></ha-icon>${s.removeLabel ?? t('common.delete')}</button>`
            : nothing}
        </div>
      </div>`;
  }

  // ---------- Floors ----------

  setFloor(id: string) {
    this.floorId = id;
    this.select(null);
    this._drawing = [];
    this.refit();
  }

  /** The settings' "Floors" section, opened and in view: rename, order, height, link to Home Assistant, delete */
  openFloors = () => {
    this._view3d = false;
    this._panel = 'settings';
    this.floorsOpen = this.floorsScroll = true;
  };

  /** "Place the stairs" on a floor (the floors menu): that floor, the stairs tool on (stairs-tool.ts) */
  placeStairs?: (floorId: string) => void = (floorId: string) => {
    if (floorId !== this.floorId && this._draft.floors.some((f) => f.id === floorId)) this.setFloor(floorId);
    this._view3d = false;
    startStairsTool(this);
  };

  /** A new floor on top (level above the highest); the floor below shows as a ghost to draw on */
  addFloor = () => {
    const id = uid('floor');
    this.mutate((d) => {
      const top = d.floors.length ? Math.max(...d.floors.map((f) => floorLevel(d, f, this.hass))) : -1;
      // levels so far implicit (the list order): written down, so the new floor really is on top
      d.floors.forEach((f) => (f.level ??= floorLevel(d, f, this.hass)));
      d.floors.push({ id, name: t('editor.new_floor', { n: d.floors.length + 1 }), level: top + 1, rooms: [], devices: [], openings: [], furniture: [] });
    });
    this.setFloor(id);
  };

  /** Delete a floor with everything on it — after asking */
  deleteFloor = async (fid?: string) => {
    if (this._draft.floors.length <= 1) return;
    const id = typeof fid === 'string' ? fid : this.floorId;
    const f = this._draft.floors.find((x) => x.id === id);
    if (!f || !(await this.layer.confirm(t('editor.delete_floor_confirm', { name: f.name })))) return;
    const keep = this.floorId !== id ? this.floorId : undefined;
    this.mutate((d) => (d.floors = d.floors.filter((x) => x.id !== id)));
    this.setFloor(keep ?? orderedFloors(this._draft, this.hass).at(-1)?.id ?? this._draft.floors[0].id);
  };

  /** One step up (1) or down (-1) in the order of floors */
  moveFloor(id: string, dir: 1 | -1) {
    const lv = reorderLevels(this._draft, id, dir, this.hass);
    if (!lv) return;
    this.mutate((d) => d.floors.forEach((f) => (f.level = lv.get(f.id) ?? f.level)));
  }

  /** Keyboard: move the selected room, device, door / window or piece (one undo step per press) */
  nudgeSelection(dx: number, dy: number): boolean {
    const sel = this._sel;
    if (!sel || !this.findSel(sel)) return false;
    const mv = (p: Point): Point => [round(p[0] + dx, 1), round(p[1] + dy, 1)];
    this.mutate((_d, f) => {
      if (sel.kind === 'room') {
        const r = f.rooms.find((x) => x.id === sel.id)!;
        r.points = this._vertex != null ? r.points.map((p, i) => (i === this._vertex ? mv(p) : p)) : r.points.map(mv);
        if (r.label && this._vertex == null) r.label = mv(r.label);
      } else if (sel.kind === 'device') {
        const d = f.devices.find((x) => x.id === sel.id)!;
        [d.x, d.y] = mv([d.x, d.y]);
      } else if (sel.kind === 'furniture') {
        const x = f.furniture!.find((p) => p.id === sel.id)!;
        [x.x, x.y] = mv([x.x, x.y]);
      } else {
        const o = f.openings!.find((p) => p.id === sel.id)!;
        o.a = mv(o.a);
        o.b = mv(o.b);
      }
    });
    return true;
  }

  deleteSelection = () => {
    const sel = this._sel;
    if (!sel) return;
    this.mutate((_d, f) => {
      if (sel.kind === 'room') f.rooms = f.rooms.filter((r) => r.id !== sel.id);
      if (sel.kind === 'device') f.devices = f.devices.filter((r) => r.id !== sel.id);
      if (sel.kind === 'opening') f.openings = f.openings?.filter((r) => r.id !== sel.id);
      if (sel.kind === 'furniture') f.furniture = f.furniture?.filter((r) => r.id !== sel.id);
    });
    this.select(null);
  };

  // ---------- Save / close ----------

  private async save() {
    if (!this.hass.user?.is_admin) return this.layer.toast(t('editor.not_admin'));
    this._saving = true;
    try {
      let stored: FloorplanCardConfig;
      let merged: FloorplanCardConfig;
      // trace images loaded here: to the companion (or, without it, small into the config)
      const draft = await storeTraceImages(this.hass, this._draft, this.pendingImages);
      if (this._share) {
        // a shared plan: content to the companion, the card's own part to the dashboard
        const r = await saveShared(this.hass, this.layer, this.original!, draft, this._share);
        if (!r) return;
        stored = r.stored;
        merged = r.merged;
        this.card.showShared(r.plan);
      } else {
        stored = merged = await saveCardConfig(this.hass, this.original!, draft);
      }
      await dropUnusedImages(this.hass, this.config, merged);
      // front door warning on the server: kept in sync with the card's settings
      const err = await syncServer(this.hass, merged, serverWanted(this.config));
      if (err) {
        console.warn('[floorplan-card] server automation', err);
        this.layer.toast(t('editor.ea_server_failed', { e: err }));
      } else this.layer.toast(t('card.saved'));
      this.card.setConfig(stored);
      this.close(true);
    } catch (err: any) {
      console.warn('[floorplan-card] save failed', err);
      const msg = String(err?.message ?? err);
      this.layer.toast(msg.includes('not found') ? t('editor.card_not_found') : t('editor.save_failed', { e: msg }));
    } finally {
      this._saving = false;
    }
  }

  private requestClose = () => {
    if (this.dirty) this._discard = true;
    else this.close();
  };

  close(saved = false) {
    this.dispatchEvent(new CustomEvent('fp-editor-close', { detail: { saved }, bubbles: true, composed: true }));
  }

  /** Space held down: dragging moves the view (like in drawing programs) */
  private spaceHeld = false;
  /** Drawing by keyboard: where the next corner goes (moved with the arrow keys) */
  private kbCursor?: Point;
  private onKeyUp = (e: Event) => {
    if (!(e instanceof KeyboardEvent) || e.key === ' ') this.spaceHeld = false;
  };

  private onKey = (e: KeyboardEvent) => {
    // handled already (the plan's keyboard navigation, a dialog)
    if (e.defaultPrevented) return;
    const origin = e.composedPath()[0] as HTMLElement;
    const tag = origin?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Space / Enter on a button presses it (keyboard use), it does not grab the view
    const control = tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || origin?.getAttribute?.('role') === 'button' || origin?.getAttribute?.('role') === 'switch';
    if (e.key === ' ' && !typing && !control) {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }
    if (this._align) {
      // arrows nudge the map (Shift: 10×), [ ] turn it, + − size; Escape does not leave the mode
      if (typing) return;
      const big = e.shiftKey ? 10 : 1;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if (k === 'ArrowLeft') this.nudge(-big, 0, 0, 1);
      else if (k === 'ArrowRight') this.nudge(big, 0, 0, 1);
      else if (k === 'ArrowUp') this.nudge(0, -big, 0, 1);
      else if (k === 'ArrowDown') this.nudge(0, big, 0, 1);
      else if (k === '[') this.nudge(0, 0, -0.5 * big, 1);
      else if (k === ']') this.nudge(0, 0, 0.5 * big, 1);
      else if (k === '+') this.nudge(0, 0, 0, 1 + 0.005 * big);
      else if (k === '-') this.nudge(0, 0, 0, 1 - 0.005 * big);
      else return;
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      if (typing) return;
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (typing) return;
      e.preventDefault();
      this.duplicateSelection();
    } else if (e.key === 'Escape') {
      if (this._picker) this._picker = undefined;
      else if (this._kindPick) this._kindPick = undefined;
      else if (this._entEdit) this._entEdit = undefined;
      else if (this._yaml) this._yaml = false;
      else if (this._drawing.length) this.cancelDrawing();
      else if (this._tool !== 'select') this._tool = 'select';
      else if (this._sel) this.select(null);
    } else if (this._tool === 'draw' && !typing && !control && (e.key.startsWith('Arrow') || (e.key === 'Enter' && this.kbCursor))) {
      // drawing by keyboard: arrows move a cross on the grid (Shift: 5 steps), Enter sets a corner; Enter on the
      // first corner (or "Done") closes the room
      e.preventDefault();
      if (e.key === 'Enter') return this.addDrawPoint(this.kbCursor!);
      const step = this.grid * (e.shiftKey ? 5 : 1);
      const c = this.kbCursor ?? this.snap(this._drawing[this._drawing.length - 1] ?? this.viewCenter()).point;
      const next: Point = [round(c[0] + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), 1), round(c[1] + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0), 1)];
      this.kbCursor = next;
      this._hover = { point: next, kind: 'grid' };
    } else if (e.key === 'Enter' && this._tool === 'draw' && !typing && !control) this.finishDrawing();
    else if (e.key.startsWith('Arrow') && !typing && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // arrows move the trace image (moving it) or the selection: 1 cm, with Shift 10 cm
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (this._panel === 'trace' && this._traceMode?.mode === 'move' && this.floor.trace) {
        patchTrace(this, (tr) => ({ ...tr, x: round(tr.x + dx, 1), y: round(tr.y + dy, 1) }));
        e.preventDefault();
      } else if (this._sel && this.nudgeSelection(dx, dy)) e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
      if (this._vertex != null && this._sel?.kind === 'room') this.deleteVertex();
      else this.deleteSelection();
    }
  };

  // ---------- Render ----------

  override render() {
    if (!this._draft) return nothing;
    if (this._align && this.alignPiece) return this.renderAlign();
    const floor = this.floor;
    const panelOpen = !!this._panel && (this._panel !== 'inspect' || !!this.findSel(this._sel));
    return html`
      <div class="editor ${this._narrow ? 'narrow' : ''} ${panelOpen ? 'with-panel' : ''}">
        ${this.renderToolbar()}
        <div class="stage">
          <fp-plan
            editing
            .hass=${this.hass}
            .floor=${floor}
            .below=${this.below}
            belowMode="ghost"
            .roomHeight=${floor.height ?? 250}
            .getState=${this.card.getState}
            .handlers=${this.handlers}
            .wallWidth=${this._draft.wall_width ?? 8}
            .showGrid=${this._showGrid}
            .grid=${this.grid}
            .selected=${this._sel ?? undefined}
            .fitBounds=${this._fit}
            labelMode="inside"
            .hideLabels=${!this._showLabels}
            .threeD=${this._view3d}
            .fullWalls=${this._view3d && this._fullWalls}
            .wallHeight=${this._draft.wall_height ?? 90}
            .backWallHeight=${this._draft.back_wall_height ?? 170}
            .wallColor=${this._draft.wall_color}
            .hrMarks=${this._panel === 'rules' ? this._hrMarks : undefined}
            .trace=${this.editorTrace()}
            .overlaySvg=${this.renderOverlaySvg()}
            .overlayHtml=${this.renderOverlayHtml()}
            class="tool-${this._tool}"
          ></fp-plan>
          ${this.renderTools()} ${this.renderHint()}
          ${this._view3d ? this.renderCamera() : nothing}
          <div class="zoom">
            <button class="icon-btn raised pressable" title=${t('card.reset_view')} @click=${() => this.refit(true)}>
              <ha-icon icon="mdi:fit-to-screen-outline"></ha-icon>
            </button>
          </div>
          ${panelOpen ? html`<aside class="panel">${this.renderPanel()}</aside>` : nothing}
        </div>
        ${this._ghost
          ? html`<div class="ghost" style=${`transform:translate(${this._ghost.x}px, ${this._ghost.y}px)`}>
              <ha-icon .icon=${this._ghost.icon}></ha-icon><span>${this._ghost.label}</span>
            </div>`
          : nothing}
        ${this._entEdit ? this.renderEntityEdit() : nothing} ${this._picker ? this.renderPicker() : nothing} ${this._kindPick ? this.renderKindPicker() : nothing} ${this._yaml ? this.renderYaml() : nothing}
        ${this._tour
          ? html`<fp-editor-tour
              .root=${this.renderRoot}
              .labelStyle=${labelStyleOf(this._draft)}
              @label-style=${(e: CustomEvent) => this.mutate((x) => setLabelStyle(x, e.detail.value as LabelStyle))}
              @tour-end=${() => {
                this._tour = false;
                markTourSeen(this.hass);
              }}
            ></fp-editor-tour>`
          : nothing}
        ${this._discard
          ? html`<div class="modal-scrim" @click=${() => (this._discard = false)}></div>
              <div class="alert">
                <div class="alert-title">${t('editor.discard_title')}</div>
                <div class="alert-actions">
                  <button class="btn pressable" @click=${() => (this._discard = false)}>${t('common.cancel')}</button>
                  <button class="btn danger pressable" @click=${() => this.close()}>${t('editor.discard')}</button>
                </div>
              </div>`
          : nothing}
      </div>
    `;
  }


  /** The plan reduced to rooms, walls, doors and windows (no furniture, devices, labels, floor patterns) */
  private alignFloorCache?: { src: FloorConfig; out: FloorConfig };
  private get alignFloor(): FloorConfig {
    const src = this.floor;
    if (this.alignFloorCache?.src !== src)
      this.alignFloorCache = { src, out: { ...src, furniture: [], devices: [], rooms: src.rooms.map((r) => ({ ...r, floor: undefined })) } };
    return this.alignFloorCache.out;
  }

  /** Alignment mode: only the plan's rooms and the vacuum's map, one bar on top (left only by "Done"), one dock.
   * A room of the vacuum's map can be opened on its own (tap it): then only that room shows and moves. */
  private renderAlign() {
    const a = this._align!;
    const f = this.alignPiece!;
    const tf = f.vacuum?.transform;
    const vm = this.alignMap;
    const m = tf ? mapperOf(f.vacuum, vm) : undefined;
    const match = m && vm?.rooms.length ? roomMatch(this.floor, vm, m) : [];
    const roomIdx = a.room ? (vm?.rooms.findIndex((r) => r.id === a.room) ?? -1) : -1;
    const cur = a.room ? match.find((x) => x.id === a.room) : undefined;
    const pending = a.pairs.length && !a.pairs[a.pairs.length - 1].plan;
    const done = a.pairs.filter((p) => p.plan).length;
    const nCrop = f.vacuum?.crop?.length ?? 0;
    const hint =
      a.tool === 'walls'
        ? t('editor.va_hint_walls')
        : a.tool === 'crop'
        ? t('editor.va_hint_crop')
        : a.tool === 'pairs'
          ? pending
            ? t('editor.va_hint_plan')
            : done >= 2
              ? t('editor.va_hint_more')
              : t('editor.va_hint_map')
          : a.room
            ? t('editor.va_hint_room')
            : t('editor.va_hint_move');
    const step = (icon: string, label: string, fn: () => void) =>
      html`<button class="va-step pressable" title=${label} aria-label=${label} @click=${fn}><ha-icon .icon=${icon}></ha-icon></button>`;
    const fit = a.room ? f.vacuum?.rooms?.[a.room] : undefined;
    const rotShown = a.room ? (fit?.rot ?? 0) : (tf?.rot ?? 0);
    const sizeShown = a.room ? Math.round(Math.sqrt((fit?.scale ?? 1) * (fit?.scaleY ?? fit?.scale ?? 1)) * 100) : Math.round(Math.sqrt((tf?.scale ?? 0.1) * (tf?.scaleY ?? tf?.scale ?? 0.1)) * 1000);
    const cropBtn = html`<button class="btn pressable ${a.tool === 'crop' ? 'accent' : ''}" ?disabled=${!tf} @click=${() => (this._align = { ...a, tool: a.tool === 'crop' ? 'move' : 'crop', cropDraft: undefined })}>
      <ha-icon icon="mdi:eraser"></ha-icon>${t('editor.va_crop')}${nCrop ? ` · ${nCrop}` : ''}
    </button>`;
    const wallsBtn = html`<button class="btn pressable ${a.tool === 'walls' ? 'accent' : ''}" ?disabled=${!tf} @click=${() => (this._align = { ...a, tool: a.tool === 'walls' ? 'move' : 'walls', cropDraft: undefined })}>
      <ha-icon icon="mdi:wall"></ha-icon>${t('editor.va_plan')}
    </button>`;
    const missing = tf ? this.missingRooms() : [];
    const roomMissing = !!a.room && missing.includes(a.room);
    const wallActions = html`<div class="va-actions va-sub">
      <button class="btn tinted pressable" @click=${this.alignSnapWalls}><ha-icon icon="mdi:magnet"></ha-icon>${a.room ? t('editor.va_walls_room') : t('editor.va_walls_all')}</button>
      ${a.room
        ? roomMissing
          ? html`<button class="btn tinted pressable" @click=${() => this.alignCreateRooms([a.room!])}><ha-icon icon="mdi:vector-square-plus"></ha-icon>${t('editor.va_room_create')}</button>`
          : nothing
        : missing.length
          ? html`<button class="btn tinted pressable" @click=${() => this.alignCreateRooms(missing)}><ha-icon icon="mdi:vector-square-plus"></ha-icon>${t('editor.va_rooms_create', { n: missing.length })}</button>`
          : nothing}
    </div>`;
    return html`
      <div class="editor aligning ${this._narrow ? 'narrow' : ''}">
        <header class="toolbar va-bar">
          <div class="tb-left">
            <button class="btn plain pressable" ?disabled=${!this._past.length} @click=${this.undo} title=${t('editor.undo')}><ha-icon icon="mdi:undo"></ha-icon></button>
            <button class="btn plain pressable" ?disabled=${!this._future.length} @click=${this.redo} title=${t('editor.redo')}><ha-icon icon="mdi:redo"></ha-icon></button>
            <button class="btn plain pressable" @click=${this.alignReset}>${a.room ? t('editor.va_reset_room') : t('editor.va_reset')}</button>
          </div>
          <div class="tb-center va-title"><ha-icon icon="mdi:map-marker-path"></ha-icon><span>${t('editor.va_title', { name: f.name ?? t('editor.vacuum') })}</span></div>
          <div class="tb-right">
            <button class="btn accent pressable va-done" @click=${this.endAlign}>${t('editor.va_done')}</button>
          </div>
        </header>
        <div class="stage">
          <fp-plan
            editing
            .hass=${this.hass}
            .floor=${this.alignFloor}
            .getState=${this.card.getState}
            .handlers=${this.handlers}
            .wallWidth=${this._draft.wall_width ?? 8}
            .showGrid=${false}
            .grid=${this.grid}
            .fitBounds=${this._fit}
            labelMode="inside"
            .hideLabels=${true}
            .threeD=${false}
            .wallHeight=${this._draft.wall_height ?? 90}
            .overlaySvg=${this.renderOverlaySvg()}
            .overlayHtml=${this.renderOverlayHtml()}
            class="tool-align ${a.tool === 'pairs' ? 'pairing' : a.tool === 'crop' ? 'cropping' : ''}"
          ></fp-plan>
          <div class="zoom">
            <button class="icon-btn raised pressable" title=${t('card.reset_view')} @click=${() => this.refit(true)}>
              <ha-icon icon="mdi:fit-to-screen-outline"></ha-icon>
            </button>
          </div>
          <div class="va-dock">
            ${a.room
              ? html`<div class="va-roombar">
                  <button class="btn pressable" @click=${() => this.alignRoom(undefined)}><ha-icon icon="mdi:chevron-left"></ha-icon>${t('editor.va_whole')}</button>
                  <span class="dot c${Math.max(0, roomIdx) % 6}"></span>
                  <span class="va-roomname">${vm?.rooms[roomIdx]?.name ?? '?'}</span>
                  ${cur?.plan ? html`<span class="pc ${cur.share >= 0.85 ? 'good' : cur.share >= 0.6 ? 'ok' : 'bad'}">${Math.round(cur.share * 100)} %</span>` : nothing}
                </div>`
              : nothing}
            <div class="va-hint">${!tf ? t('editor.va_no_tf') : vm === null ? t('editor.vac_loading') : hint}</div>
            ${match.length && !a.room
              ? html`<div class="va-rooms">
                  ${match.map((mm, i) => {
                    const own = !!f.vacuum?.rooms?.[mm.id];
                    return html`<button class="va-room pressable ${mm.share >= 0.85 ? 'good' : mm.share >= 0.6 ? 'ok' : 'bad'}" @click=${() => this.alignRoom(mm.id)}>
                      <span class="dot c${i % 6}"></span><span class="nm">${mm.name}</span>${own ? html`<ha-icon class="own" icon="mdi:vector-square-edit"></ha-icon>` : nothing}<span class="pc">${mm.plan ? `${Math.round(mm.share * 100)} %` : '–'}</span>
                    </button>`;
                  })}
                </div>`
              : nothing}
            ${a.tool === 'walls' ? wallActions : nothing}
            <div class="va-actions">
              ${a.room
                ? html`${cropBtn} ${wallsBtn}`
                : html`<button class="btn tinted pressable" @click=${this.alignAuto}><ha-icon icon="mdi:auto-fix"></ha-icon>${t('editor.va_auto')}</button>
                    <button class="btn pressable ${a.tool === 'pairs' ? 'accent' : ''}" ?disabled=${!tf} @click=${() => (this._align = { ...a, tool: a.tool === 'pairs' ? 'move' : 'pairs', pairs: a.tool === 'pairs' ? a.pairs : a.pairs.filter((p) => p.plan) })}>
                      <ha-icon icon="mdi:vector-link"></ha-icon>${t('editor.va_pairs')}${done ? ` · ${done}` : ''}
                    </button>
                    ${a.pairs.length ? html`<button class="btn pressable" @click=${() => (this._align = { ...a, pairs: [] })}><ha-icon icon="mdi:close-circle-outline"></ha-icon>${t('editor.va_pairs_clear')}</button>` : nothing}
                    ${cropBtn} ${wallsBtn}
                    <button class="btn pressable ${tf?.mirror ? 'on' : ''}" ?disabled=${!tf} @click=${this.alignMirror}><ha-icon icon="mdi:flip-vertical"></ha-icon>${t('editor.vac_mirror')}</button>`}
            </div>
            ${tf && a.tool !== 'walls'
              ? html`<div class="va-fine">
                  <div class="va-pad">
                    ${step('mdi:chevron-up', t('editor.va_up'), () => this.nudge(0, -2, 0, 1))}
                    <div class="va-row">
                      ${step('mdi:chevron-left', t('editor.va_left'), () => this.nudge(-2, 0, 0, 1))}
                      ${step('mdi:chevron-down', t('editor.va_down'), () => this.nudge(0, 2, 0, 1))}
                      ${step('mdi:chevron-right', t('editor.va_right'), () => this.nudge(2, 0, 0, 1))}
                    </div>
                  </div>
                  <div class="va-pair">${step('mdi:rotate-left', t('editor.va_turn_l'), () => this.nudge(0, 0, -0.5, 1))}<span>${rotShown.toFixed(1)}°</span>${step('mdi:rotate-right', t('editor.va_turn_r'), () => this.nudge(0, 0, 0.5, 1))}</div>
                  <div class="va-pair">${step('mdi:magnify-minus-outline', t('editor.va_smaller'), () => this.nudge(0, 0, 0, 0.995))}<span>${sizeShown} %</span>${step('mdi:magnify-plus-outline', t('editor.va_bigger'), () => this.nudge(0, 0, 0, 1.005))}</div>
                </div>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderToolbar() {
    const floors = this._draft.floors;
    // phones (the bar's own breakpoint): floors by their short name, the full one would not fit
    const narrow = window.matchMedia?.('(max-width: 600px)').matches ?? false;
    return html`<header class="toolbar">
      <div class="tb-left">
        <button class="btn plain pressable cancel" aria-label=${t('common.cancel')} @click=${this.requestClose}>
          <ha-icon icon="mdi:close"></ha-icon><span>${t('common.cancel')}</span>
        </button>
      </div>
      <div class="tb-center ${floors.length < 2 ? 'single' : ''}" role="group" aria-label=${t('editor.floors_bar')}>
        <fp-segmented
          class="floors"
          .options=${orderedFloors(this._draft, this.hass).reverse().map((f) => ({ value: f.id, label: narrow ? floorShort(f) : f.name }))}
          .value=${this.floorId ?? ''}
          @value-change=${(e: CustomEvent) => this.setFloor(e.detail.value)}
        ></fp-segmented>
        <button class="btn plain pressable tb-add-floor" title=${t('editor.add_floor')} aria-label=${t('editor.add_floor')} @click=${this.addFloor}>
          <ha-icon icon="mdi:layers-plus"></ha-icon><span>${t('editor.add_floor_short')}</span>
        </button>
        <button class="icon-btn pressable tb-floors" data-floors-menu title=${t('editor.floors_manage')} aria-label=${t('editor.floors_manage')} @click=${this.openFloors}>
          <ha-icon icon="mdi:layers-edit"></ha-icon>
        </button>
      </div>
      <div class="tb-right">
        <fp-segmented
          class="dim"
          .options=${[
            { value: '2d', label: '2D' },
            { value: '3d', label: '3D' },
          ]}
          .value=${this._view3d ? '3d' : '2d'}
          @value-change=${(e: CustomEvent) => {
            this._view3d = e.detail.value === '3d';
            if (this._tool === 'draw' && this._view3d) this._tool = 'select';
          }}
        ></fp-segmented>
        <button class="icon-btn plain pressable" title=${t('editor.undo')} aria-label=${t('editor.undo')} ?disabled=${!this._past.length} @click=${this.undo}>
          <ha-icon icon="mdi:undo"></ha-icon>
        </button>
        <button class="icon-btn plain pressable opt" title=${t('editor.redo')} aria-label=${t('editor.redo')} ?disabled=${!this._future.length} @click=${this.redo}>
          <ha-icon icon="mdi:redo"></ha-icon>
        </button>
        <button class="icon-btn plain pressable opt" title=${t('editor.yaml')} aria-label=${t('editor.yaml')} @click=${() => (this._yaml = true)}>
          <ha-icon icon="mdi:code-braces"></ha-icon>
        </button>
        <button class="icon-btn plain pressable opt tour-btn" title=${t('editor.tour')} aria-label=${t('editor.tour')} @click=${this.startTour}>
          <ha-icon icon="mdi:help-circle-outline"></ha-icon>
        </button>
        <button class="btn accent pressable save" ?disabled=${this._saving} @click=${this.save}>
          ${this._saving ? '…' : t('common.save')}
        </button>
      </div>
    </header>`;
  }

  private renderTools() {
    const tool = (id: Tool, icon: string, label: string) =>
      html`<button
        class="tool pressable ${this._tool === id ? 'on' : ''}"
        title=${label}
        aria-label=${label}
        aria-pressed=${this._tool === id ? 'true' : 'false'}
        data-tool=${id}
        @click=${() => {
          this._tool = id;
          this._drawing = [];
          if (id !== 'select') {
            this.select(null);
            this._panel = null;
          }
        }}
      >
        <ha-icon .icon=${icon}></ha-icon>
      </button>`;
    const panel = (id: Panel, icon: string, label: string) =>
      html`<button
        class="tool pressable ${this._panel === id ? 'on' : ''}"
        title=${label}
        aria-label=${label}
        data-panel=${id}
        @click=${() => {
          this._panel = this._panel === id ? null : id;
          this._tool = 'select';
          this._sel = null;
        }}
      >
        <ha-icon .icon=${icon}></ha-icon>
      </button>`;
    const toggle = (on: boolean, icon: string, label: string, fn: () => void) =>
      html`<button class="tool small pressable ${on ? 'on-soft' : ''}" title=${label} aria-label=${label} aria-pressed=${on ? 'true' : 'false'} @click=${fn}>
        <ha-icon .icon=${icon}></ha-icon>
      </button>`;
    return html`<nav class="tools">
      ${tool('select', 'mdi:cursor-default-outline', t('editor.select'))} ${tool('draw', 'mdi:vector-square-edit', t('editor.draw'))}
      ${tool('door', 'mdi:door', t('editor.door'))} ${tool('window', 'mdi:window-closed-variant', t('editor.window'))}
      ${tool('garage', 'mdi:garage', t('editor.garage_door'))} ${tool('stairs', 'mdi:stairs', t('editor.stairs_tool'))}
      <span class="sep"></span>
      ${panel('furniture', 'mdi:sofa-outline', t('editor.furniture'))}
      ${panel('settings', 'mdi:tune-variant', t('editor.settings'))} ${panel('trace', 'mdi:image-outline', t('trace.title'))}
      ${this._hrOn ? panel('rules', 'mdi:script-text-outline', t('hr.rules')) : nothing}
      <span class="sep"></span>
      ${toggle(this._showGrid, 'mdi:grid', t('editor.grid'), () => (this._showGrid = !this._showGrid))}
      ${toggle(this._showLabels, this._showLabels ? 'mdi:label-outline' : 'mdi:label-off-outline', t('editor.show_labels'), () => (this._showLabels = !this._showLabels))}
      ${toggle(this._snapGrid && this._snapGeom, 'mdi:magnet', t('editor.snap'), () => {
        const on = !(this._snapGrid && this._snapGeom);
        this._snapGrid = on;
        this._snapGeom = on;
      })}
      ${toggle(this._linkWalls, 'mdi:link-variant', t('editor.link_walls'), () => (this._linkWalls = !this._linkWalls))}
    </nav>`;
  }

  private renderCamera() {
    const plan = () => this.plan;
    const btn = (icon: string, label: string, fn: () => void, on = false) =>
      html`<button class="cam-btn pressable ${on ? 'on' : ''}" title=${label} aria-label=${label} @click=${fn}><ha-icon .icon=${icon}></ha-icon></button>`;
    return html`<div class="camera">
      ${btn('mdi:rotate-left', t('editor.cam_left'), () => plan()?.rotateBy(-45))}
      ${btn('mdi:rotate-right', t('editor.cam_right'), () => plan()?.rotateBy(45))}
      <span class="cam-sep"></span>
      ${btn('mdi:arrow-collapse-up', t('editor.cam_tilt_up'), () => plan()?.setTilt((plan()?.tilt ?? 48) - 12))}
      ${btn('mdi:arrow-collapse-down', t('editor.cam_tilt_down'), () => plan()?.setTilt((plan()?.tilt ?? 48) + 12))}
      ${btn('mdi:view-grid-outline', t('editor.cam_top'), () => {
        plan()?.setTilt(10);
        plan()?.setSpin(0);
      })}
      <span class="cam-sep"></span>
      ${btn(this._fullWalls ? 'mdi:wall' : 'mdi:wall-sconce-flat-outline', this._fullWalls ? t('editor.walls_full') : t('editor.walls_low'), () => (this._fullWalls = !this._fullWalls), this._fullWalls)}
      <span class="cam-hint">${t('editor.cam_hint')}</span>
    </div>`;
  }

  private renderHint() {
    const tm = this._panel === 'trace' ? this._traceMode?.mode : undefined;
    if (tm) return html`<div class="hint" role="status"><span>${tm === 'move' ? t('trace.move_hint') : t('trace.calibrate_hint', { n: Math.max(0, 2 - (this._traceMode?.pts.length ?? 0)) })}</span></div>`;
    if (this._tool === 'draw')
      return html`<div class="hint">
        <span>${this._drawing.length ? t('editor.draw_hint') : t('editor.draw_hint_start')}</span>
        ${this._drawing.length
          ? html`<button class="btn pressable" @click=${this.removeLastPoint}><ha-icon icon="mdi:undo-variant"></ha-icon></button>
              <button class="btn accent pressable" ?disabled=${this._drawing.length < 3} @click=${this.finishDrawing}>${t('editor.draw_finish')}</button>`
          : nothing}
      </div>`;
    if (this._tool === 'door' || this._tool === 'window' || this._tool === 'garage') return html`<div class="hint"><span>${t('editor.opening_hint')}</span></div>`;
    if (this._tool === 'stairs') return stairsHint(this);
    // an empty plan: say where to start
    if (this._tool === 'select' && !this._panel && !this.floor.rooms.length)
      return html`<div class="hint empty-hint">
        <ha-icon icon="mdi:vector-square-edit" style="color:var(--fp-accent)"></ha-icon>
        <span>${t(this.below ? 'editor.ghost_hint' : 'editor.empty_hint')}</span>
        <button
          class="btn accent pressable"
          data-empty-draw
          @click=${() => {
            this._view3d = false;
            this._tool = 'draw';
            this._drawing = [];
          }}
        >
          ${t('editor.empty_draw')}
        </button>
      </div>`;
    return nothing;
  }

  private renderOverlaySvg() {
    const parts: unknown[] = [...traceOverlay(this)];
    const sel = this._sel;
    if (sel?.kind === 'room') {
      const r = this.findSel(sel) as RoomConfig | undefined;
      if (r) parts.push(svg`<path class="ed-sel" d=${pointsToPath(r.points)}></path>`);
    }
    const pts = this._drawing;
    if (pts.length) {
      const hover = this._hover?.point;
      const all = this._tool === 'draw' && hover && (!this.drag || this.drag.type === 'point') ? [...pts, hover] : pts;
      const closed = this.drag?.type === 'rect';
      parts.push(svg`<path class="ed-draw-fill" d=${pointsToPath(all)}></path>`);
      parts.push(svg`<polyline class="ed-draw" points=${all.map((p) => p.join(',')).join(' ')}${closed ? ` ${all[0].join(',')}` : ''}></polyline>`);
    }
    // a selected vacuum: the floor it has driven over, laid onto the plan with its alignment
    if (sel?.kind === 'furniture') {
      const f = this.findSel(sel) as FurnitureConfig | undefined;
      const tf = f?.vacuum?.transform;
      const l = f?.entity ? this.vacLearned.get(f.entity) : undefined;
      // the walls of its own map: they belong on the plan's walls
      const vm = f?.entity ? this.vacMaps.get(f.entity) : undefined;
      if (f?.kind === 'robot_vacuum' && tf && vm?.rooms.length) {
        // its rooms as coloured areas with their names (like in the vacuum's app), its walls as a fine line;
        // rooms placed on their own follow their placement, cut-out areas are left out. While a room is edited
        // on its own only that room shows.
        const m = mapperOf(f.vacuum, vm)!;
        const only = this._align?.room;
        const sq = (pts: [number, number][], size: number, step: number, room?: string) => {
          let d = '';
          const h = size / 2;
          for (let i = 0; i < pts.length; i += step) {
            const [x, y] = pts[i];
            if (m.cut(x, y)) continue;
            if (only && room === undefined && m.roomOf(x, y) !== only) continue;
            const p = m.toPlan(x, y, room);
            d += `M${(p[0] - h).toFixed(1)} ${(p[1] - h).toFixed(1)}h${size.toFixed(1)}v${size.toFixed(1)}h${(-size).toFixed(1)}z`;
          }
          return d;
        };
        const sc = Math.max(tf.scale ?? 0.1, tf.scaleY ?? tf.scale ?? 0.1);
        const cell = (vm.floor_res ?? 100) * sc * 1.05;
        vm.rooms.forEach((r, i) => {
          if (!r.pts.length || (only && r.id !== only)) return;
          const c = r.pts.reduce((a, p) => [a[0] + p[0] / r.pts.length, a[1] + p[1] / r.pts.length], [0, 0]);
          const cp = m.toPlan(c[0], c[1], r.id);
          const fit = f.vacuum?.rooms?.[r.id];
          const k = fit ? Math.max(fit.scale ?? 1, fit.scaleY ?? fit.scale ?? 1) : 1;
          parts.push(svg`<g class="vac-room c${i % 6} ${only ? 'hl' : ''}"><path d=${sq(r.pts, cell * k, 1, r.id)}></path>
            ${r.name ? svg`<text x=${cp[0]} y=${cp[1]} style=${`font-size:${(13 / this.scale).toFixed(1)}px`}>${r.name}</text>` : nothing}</g>`);
        });
        const st = Math.max(1, Math.floor(vm.walls.length / 4000));
        parts.push(svg`<path class="vac-wall" d=${sq(vm.walls, Math.max(1.2, (vm.wall_res ?? 50) * sc * 0.8), st)}></path>`);
        if (vm.charger && !only) {
          const d = m.toPlan(vm.charger[0], vm.charger[1]);
          parts.push(svg`<circle class="vac-dock" cx=${d[0]} cy=${d[1]} r="9"></circle>`);
        }
        if (this._align) {
          parts.push(this.alignOverlay(tf, vm));
          // a frame around what moves (not while fitting the plan's walls)
          const ve = this._align.tool !== 'walls' ? this.vacEdit() : undefined;
          if (ve) parts.push(svg`<rect class="va-frame" x=${ve.box.minX} y=${ve.box.minY} width=${ve.box.maxX - ve.box.minX} height=${ve.box.maxY - ve.box.minY}></rect>`);
        }
      }
      if (f?.kind === 'robot_vacuum' && tf && l?.cells.length && !vm?.rooms.length) {
        const res = l.res || 100;
        const step = Math.max(1, Math.floor(l.cells.length / 2500));
        const r = Math.max(2.5, (res * (tf.scale ?? 0.1)) / 2);
        parts.push(svg`<g class="vac-learned">${l.cells
          .filter((_, i) => i % step === 0)
          .map(([x, y]) => {
            const p = toPlan(tf, (x + 0.5) * res, (y + 0.5) * res);
            return svg`<circle cx=${p[0]} cy=${p[1]} r=${r}></circle>`;
          })}</g>`);
        if (l.dock) {
          const d = toPlan(tf, l.dock[0], l.dock[1]);
          parts.push(svg`<circle class="vac-dock" cx=${d[0]} cy=${d[1]} r="9"></circle>`);
        }
      }
    }
    if (this._hover?.guides?.length) {
      // what the dragged corner / wall lines up with: from that corner to here, a little beyond both
      for (const [a, b] of this._hover.guides) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ex = ((b[0] - a[0]) / len) * (24 / this.scale);
        const ey = ((b[1] - a[1]) / len) * (24 / this.scale);
        parts.push(svg`<line class="ed-guide align" x1=${a[0] - ex} y1=${a[1] - ey} x2=${b[0] + ex} y2=${b[1] + ey}></line>`);
      }
    } else if (this._hover?.point && (this._hover.kind === 'vertex' || this._hover.kind === 'edge')) {
      // Alignment guides through the snapped point.
      const [x, y] = this._hover.point;
      parts.push(svg`<line class="ed-guide" x1=${x} y1=${y - 4000} x2=${x} y2=${y + 4000}></line><line class="ed-guide" x1=${x - 4000} y1=${y} x2=${x + 4000} y2=${y}></line>`);
    }
    return svg`<g class="editor-layer">${parts}</g>`;
  }

  /** Length labels at the middle of edges, offset outwards (screen-constant distance). */
  private dimensions(edges: [Point, Point][], polygon?: Point[], live = -1) {
    const s = this.scale;
    return edges.map(([a, b], i) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len * s < 36) return nothing;
      let n: Point = [dy / len, -dx / len];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (polygon && polygon.length >= 3 && pointInPolygon([mid[0] + n[0] * 2, mid[1] + n[1] * 2], polygon)) n = [-n[0], -n[1]];
      // clear of the edge and its middle handle: beside a vertical edge the label's half width counts
      const text = formatLength(len);
      const off = (14 + Math.abs(n[0]) * (text.length * 3.1 + 3) + Math.abs(n[1]) * 8) / s;
      return html`<div class="dim ${i === live ? 'live' : ''}" style=${`left:${mid[0] + n[0] * off}px;top:${mid[1] + n[1] * off}px`}>${text}</div>`;
    });
  }

  /** Alignment mode on the plan: names of the plan's rooms, the edited room's counterpart, cut-out areas, the
   * rectangle being cut, matched point pairs */
  private alignOverlay(tf: VacuumTransform, vm: VacuumMap) {
    const a = this._align!;
    const f = this.alignPiece!;
    const m = mapperOf(f.vacuum, vm)!;
    const fs = (13 / this.scale).toFixed(1);
    const name = a.room ? vm.rooms.find((r) => r.id === a.room)?.name : undefined;
    const target = name ? this.floor.rooms.find((r) => r.name && sameRoom(r.name, name)) : undefined;
    const r = 7 / this.scale;
    const d = a.cropDraft;
    return svg`<g class="va-ov">
      ${this.floor.rooms
        .filter((rm) => !rm.outdoor && rm.points.length >= 3)
        .map((rm) => {
          const c = polylabel(rm.points);
          return svg`<text class="va-plan-name" x=${c[0]} y=${c[1] - 16 / this.scale} style=${`font-size:${fs}px`}>${rm.name ?? ''}</text>`;
        })}
      ${target ? svg`<path class="va-target" d=${pointsToPath(target.points)}></path>` : nothing}
      ${(f.vacuum?.crop ?? []).map((poly) => {
        const pts = poly.map(([x, y]) => m.toPlan(x, y, a.room ?? null));
        return svg`<path class="va-crop" d=${pointsToPath(pts)}></path>`;
      })}
      ${d
        ? svg`<rect class="va-crop draft" x=${Math.min(d[0][0], d[1][0])} y=${Math.min(d[0][1], d[1][1])} width=${Math.abs(d[1][0] - d[0][0])} height=${Math.abs(d[1][1] - d[0][1])}></rect>`
        : nothing}
      ${a.pairs.map((p, i) => {
        const q = toPlan(tf, p.robot[0], p.robot[1]);
        return svg`<g class="va-pin">
          ${p.plan ? svg`<line x1=${q[0]} y1=${q[1]} x2=${p.plan[0]} y2=${p.plan[1]}></line>` : nothing}
          <circle class="robot" cx=${q[0]} cy=${q[1]} r=${r}></circle>
          ${p.plan ? svg`<circle class="plan" cx=${p.plan[0]} cy=${p.plan[1]} r=${r}></circle>` : nothing}
          <text x=${q[0]} y=${q[1]} style=${`font-size:${(9 / this.scale).toFixed(1)}px`}>${i + 1}</text>
          ${p.plan ? svg`<text x=${p.plan[0]} y=${p.plan[1]} style=${`font-size:${(9 / this.scale).toFixed(1)}px`}>${i + 1}</text>` : nothing}
        </g>`;
      })}
    </g>`;
  }

  /** Handles of a vacuum's map: move, turn, stretch */
  private vacHandles(out: unknown[]) {
    // fitting the plan's walls: one handle per wall instead
    if (this._align?.tool === 'walls') return this.planWallHandles(out);
    const ve = this.vacEdit();
    if (!ve) return;
    const b = ve.box;
    const pad = 22 / this.scale;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    out.push(html`<div class="h vacmove" data-handle="vac-move" title=${t('editor.vac_drag')} style=${`left:${ve.centre[0]}px;top:${ve.centre[1]}px`}><ha-icon icon="mdi:cursor-move"></ha-icon></div>`);
    out.push(html`<div class="h rot" data-handle="vac-rot" title=${t('editor.vac_turn')} style=${`left:${cx}px;top:${b.minY - pad - 40 / this.scale}px`}><ha-icon icon="mdi:rotate-right"></ha-icon></div>`);
    // each side and corner on its own: the opposite side / corner stays where it is
    const L = b.minX - pad;
    const R = b.maxX + pad;
    const T = b.minY - pad;
    const B = b.maxY + pad;
    for (const [side, x, y] of [
      ['l', L, cy],
      ['r', R, cy],
      ['t', cx, T],
      ['b', cx, B],
      ['tl', L, T],
      ['tr', R, T],
      ['bl', L, B],
      ['br', R, B],
    ] as const)
      out.push(html`<div class="h vacedge ${side.length === 2 ? 'corner' : side === 'l' || side === 'r' ? 'ew' : 'ns'} s-${side}" data-handle=${`vac-e:${side}`} title=${t('editor.vac_stretch')} style=${`left:${x}px;top:${y}px`}></div>`);
  }

  /** Fitting the plan to the vacuum's map: a handle on every wall of the plan (of the room being edited) */
  private planWallHandles(out: unknown[]) {
    const a = this._align!;
    const vm = this.alignMap;
    const name = a.room ? vm?.rooms.find((r) => r.id === a.room)?.name : undefined;
    const target = name ? this.floor.rooms.find((r) => r.name && sameRoom(r.name, name)) : undefined;
    planWalls(this.floor).forEach((w, i) => {
      if (target && !w.rooms.has(target.id)) return;
      if (w.t1 - w.t0 < 25) return;
      const [p, q] = wallEnds(w);
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      const ang = (Math.atan2(w.nrm[1], w.nrm[0]) * 180) / Math.PI;
      out.push(html`<div class="h planwall" data-handle=${`pw:${i}`} title=${t('editor.va_wall_drag')} style=${`left:${mx}px;top:${my}px;--ang:${ang}deg`}><span></span></div>`);
    });
  }

  private renderOverlayHtml() {
    const out: unknown[] = [];
    if (this._align) {
      this.vacHandles(out);
      return html`${out}`;
    }
    // Hausregeln: at every device how many rules it starts (orange) and how many switch it (blue)
    // (only once the plan shows this floor: right after switching floors it still has the old one)
    if (this._hrOn && this._tool === 'select' && this.hrCounts.size && this.plan && this.plan.floor !== this.floor)
      void this.updateComplete.then(() => this.requestUpdate());
    else if (this._hrOn && this._tool === 'select' && this.hrCounts.size) {
      const dark = this.hass.themes?.darkMode ?? false;
      for (const [id, c] of this.hrCounts) {
        if (!c.starts.length && !c.switches.length && !c.checks.length) continue;
        const p = this.plan?.entityAnchor(id);
        if (!p) continue;
        out.push(html`<div class="hrcount" style=${`left:${p[0]}px;top:${p[1]}px`} title=${t('hr.rules_sub', { s: c.starts.length, c: c.checks.length, w: c.switches.length })}>
          ${c.starts.length ? html`<span style=${`--c:${hrColor('when', dark)}`}>${c.starts.length}</span>` : nothing}
          ${c.checks.length ? html`<span style=${`--c:${hrColor('and', dark)}`}>${c.checks.length}</span>` : nothing}
          ${c.switches.length ? html`<span style=${`--c:${hrColor('then', dark)}`}>${c.switches.length}</span>` : nothing}
        </div>`);
      }
    }
    // Real wall lengths
    const pts = this._drawing;
    if (this._tool === 'draw' && pts.length) {
      if (this.drag?.type === 'rect' && pts.length === 4) out.push(this.dimensions([[pts[0], pts[1]], [pts[1], pts[2]]], pts));
      else {
        const hover = (!this.drag || this.drag.type === 'point') && this._hover?.point;
        const chain = hover ? [...pts, hover] : pts;
        const edges: [Point, Point][] = chain.slice(1).map((p, i) => [chain[i], p]);
        out.push(this.dimensions(edges, undefined, hover ? edges.length - 1 : -1));
      }
    }
    const selItem = this.findSel(this._sel);
    if (this._sel?.kind === 'room' && selItem && this._tool === 'select') {
      const rp = (selItem as RoomConfig).points;
      const live = this.drag?.type === 'vertex' || this.drag?.type === 'edge' ? this.drag.index! : -1;
      out.push(
        html`${this.dimensions(
          rp.map((p, i) => [p, rp[(i + 1) % rp.length]] as [Point, Point]),
          rp,
          live,
        )}`,
      );
    }
    if (this._sel?.kind === 'opening' && selItem) {
      const o = selItem as OpeningConfig;
      out.push(this.dimensions([[o.a, o.b]]));
    }
    const sel = this._sel;
    const item = this.findSel(sel);
    if (sel?.kind === 'room' && item && this._tool === 'select') {
      const pts = (item as RoomConfig).points;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        out.push(html`<div class="h mid" data-handle=${`m:${i}`} style=${`left:${(p[0] + q[0]) / 2}px;top:${(p[1] + q[1]) / 2}px`}></div>`);
      });
      pts.forEach((p, i) =>
        out.push(html`<div class="h vertex ${this._vertex === i ? 'on' : ''}" data-handle=${`v:${i}`} style=${`left:${p[0]}px;top:${p[1]}px`}></div>`),
      );
    }
    if (sel?.kind === 'opening' && item) {
      const o = item as OpeningConfig;
      out.push(html`<div class="h vertex small" data-handle="oa" style=${`left:${o.a[0]}px;top:${o.a[1]}px`}></div>`);
      out.push(html`<div class="h vertex small" data-handle="ob" style=${`left:${o.b[0]}px;top:${o.b[1]}px`}></div>`);
    }
    if (sel?.kind === 'furniture' && item) {
      const f = item as FurnitureConfig;
      const rad = ((f.rotation ?? 0) * Math.PI) / 180;
      const rot = (lx: number, ly: number): Point => [f.x + lx * Math.cos(rad) - ly * Math.sin(rad), f.y + lx * Math.sin(rad) + ly * Math.cos(rad)];
      // keep the rotate handle clear of thin pieces (TV, radiator, mirror)
      const top = rot(0, -f.h / 2 - 30 / this.scale);
      const corner = rot(f.w / 2, f.h / 2);
      out.push(html`<div class="h rot" data-handle="rot" style=${`left:${top[0]}px;top:${top[1]}px`}><ha-icon icon="mdi:rotate-right"></ha-icon></div>`);
      out.push(html`<div class="h vertex small sq" data-handle="size" style=${`left:${corner[0]}px;top:${corner[1]}px`}></div>`);
    }
    this.vacHandles(out);
    if (this._drawing.length && this._tool === 'draw')
      this._drawing.forEach((p, i) =>
        out.push(html`<div class="h vertex small ${i === 0 && this._drawing.length >= 3 ? 'first' : ''}" data-handle=${`d:${i}`} style=${`left:${p[0]}px;top:${p[1]}px`}></div>`),
      );
    if (this._hover?.point && this._tool === 'draw' && (!this.drag || this.drag.type === 'point'))
      out.push(html`<div class="h snap ${this._hover.kind}" style=${`left:${this._hover.point[0]}px;top:${this._hover.point[1]}px`}></div>`);
    if (this._hover?.point && this.drag?.type === 'vertex' && this._hover.kind !== 'grid' && this._hover.kind !== 'none')
      out.push(html`<div class="h snap ${this._hover.kind}" style=${`left:${this._hover.point[0]}px;top:${this._hover.point[1]}px`}></div>`);
    return html`${out}`;
  }

  private renderPanel() {
    const title =
      this._panel === 'furniture'
          ? t('editor.furniture')
          : this._panel === 'settings'
            ? t('editor.settings')
            : this._panel === 'trace'
              ? t('trace.title')
            : this._panel === 'rules'
              ? t('hr.rules')
            : this._sel?.kind === 'room'
              ? t('editor.room')
              : this._sel?.kind === 'device'
                ? t('editor.device')
                : this._sel?.kind === 'opening'
                  ? t('editor.opening')
                  : t('editor.furniture_item');
    return html`<div class="panel-head">
        <div class="panel-title">${title}</div>
        <button class="icon-btn pressable close" aria-label=${t('common.close')} @click=${() => (this._panel === 'inspect' ? this.select(null) : (this._panel = null))}>
          <ha-icon icon="mdi:close"></ha-icon>
        </button>
      </div>
      <div class="panel-body ${this._panel === 'furniture' && this._furnCat === OTHER.id && !this._furnQ.trim() ? 'fill' : ''}">
        ${this._panel === 'furniture'
            ? this.renderFurnitureLibrary()
            : this._panel === 'rules'
              ? this.renderRulesPanel()
              : this._panel === 'trace'
                ? renderTracePanel(this)
                : renderInspector(this)}
      </div>`;
  }

  private renderFurnitureLibrary() {
    const words = this._furnQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const q = words.length > 0;
    const tile = (it: LibraryItem) => {
      const k = it.k;
      const v = it.v ?? k.variants?.[0];
      const w = v?.w ?? k.w;
      const h = v?.h ?? k.h;
      const pad = Math.max(w, h) * 0.16 + 1.5;
      const item = { kind: k.kind, ...(it.v ? { variant: it.v.id } : {}) };
      return html`<button
        class="furn pressable"
        data-kind=${k.kind}
        data-variant=${it.v?.id ?? ''}
        style=${`touch-action:${this._narrow ? 'pan-x' : 'pan-y'}`}
        @pointerdown=${(e: PointerEvent) => {
          const sx = e.clientX;
          const sy = e.clientY;
          const el = e.currentTarget as HTMLElement;
          el.setPointerCapture(e.pointerId);
          let started = false;
          const mv = (ev: PointerEvent) => {
            const dx = ev.clientX - sx;
            const dy = ev.clientY - sy;
            if (started || Math.hypot(dx, dy) < 10) return;
            const intent = this._narrow ? dy < 0 && Math.abs(dy) > Math.abs(dx) * 0.4 : dx < 0 && Math.abs(dx) > Math.abs(dy) * 0.4;
            el.removeEventListener('pointermove', mv);
            if (!intent) return;
            started = true;
            el.dataset.dragged = '1';
            this.startLibraryDrag(ev, item, categoryLabel(it), k.icon);
          };
          el.addEventListener('pointermove', mv);
          el.addEventListener('pointerup', () => el.removeEventListener('pointermove', mv), { once: true });
        }}
        @click=${(e: Event) => {
          const el = e.currentTarget as HTMLElement;
          if (el.dataset.dragged) return void delete el.dataset.dragged;
          this.addItemAt(item, this.viewCenter());
        }}
      >
        <svg class="furn-pv" viewBox="${-w / 2 - pad} ${-h / 2 - pad} ${w + pad * 2} ${h + pad * 2}" aria-hidden="true">
          ${drawFurniture({ id: 'pv', kind: k.kind, ...(it.v ? { variant: it.v.id } : {}), x: 0, y: 0, w, h })}
        </svg>
        <span>${categoryLabel(it)}</span>
      </button>`;
    };
    const grid = (items: LibraryItem[]) => html`<div class="furn-grid">${items.map(tile)}</div>`;
    // "Other": no piece fits — any Home Assistant entity goes onto the plan as a device marker
    const toOther = () => ((this._furnCat = OTHER.id), (this._furnQ = ''));
    const otherRow = html`<button class="furn-other pressable" data-kind="other" @click=${toOther}>
      <ha-icon .icon=${OTHER.icon}></ha-icon><span><b>${categoryLabel(OTHER)}</b><small>${t('editor.lib_other_short')}</small></span><ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
    </button>`;
    let body;
    if (q) {
      const hits = LIBRARY.filter((it) => words.every((wd) => it.text.includes(wd)));
      body = hits.length ? grid(hits) : html`<p class="panel-hint furn-empty">${t('editor.library_empty')}</p>`;
    } else if (this._furnCat === OTHER.id)
      body = html`<p class="panel-hint">${t('editor.lib_other_hint')}</p>
        <fp-entity-list
          draggable
          .dragAxis=${this._narrow ? 'y' : 'x'}
          .hass=${this.hass}
          .selected=${this.floor.devices.map((d) => d.entity)}
          @entity-select=${(e: CustomEvent) => this.addItemAt({ entity: e.detail.entity }, this.viewCenter())}
          @entity-drag-start=${(e: CustomEvent) =>
            this.startLibraryDrag(e.detail.event, { entity: e.detail.entity }, this.hass.states[e.detail.entity]?.attributes.friendly_name ?? e.detail.entity, 'mdi:plus-circle')}
        ></fp-entity-list>`;
    else if (this._furnCat === 'all')
      body = html`${CATEGORIES.map((c) => html`<div class="furn-sec"><ha-icon .icon=${c.icon}></ha-icon>${categoryLabel(c)}</div>${grid(LIBRARY.filter((it) => it.k.cat === c.id))}`)}`;
    else body = grid(LIBRARY.filter((it) => it.k.cat === this._furnCat));
    // "Other" brings its own search (entities): no second search box above it
    const other = this._furnCat === OTHER.id && !q;
    return html`${other
        ? nothing
        : html`${otherRow}<div class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input class="field lib-search" type="search" placeholder=${t('editor.library_search')} .value=${this._furnQ} @input=${(e: any) => (this._furnQ = e.target.value)} />
          </div>`}
      <div class="cat-chips">
        ${[OTHER, { id: 'all', de: 'Alle', en: 'All', icon: 'mdi:view-grid-outline' }, ...CATEGORIES].map(
          (c) => html`<button class="chip pressable" aria-pressed=${!q && this._furnCat === c.id ? 'true' : 'false'} @click=${() => ((this._furnCat = c.id), (this._furnQ = ''))}>
            <ha-icon .icon=${c.icon}></ha-icon>${categoryLabel(c)}
          </button>`,
        )}
      </div>
      ${other ? nothing : html`<p class="panel-hint">${t('editor.library_hint')}</p>`}
      ${body}`;
  }

  private renderPicker() {
    const p = this._picker!;
    return html`<div class="modal-scrim" @click=${() => (this._picker = undefined)}></div>
      <div class="picker">
        <div class="panel-head">
          <div class="panel-title">${p.title}</div>
          ${p.multi
            ? html`<button class="btn accent pressable" @click=${() => {
                p.onPick(p.selected);
                this._picker = undefined;
              }}>${t('common.done')}</button>`
            : html`<button class="icon-btn pressable close" @click=${() => (this._picker = undefined)}><ha-icon icon="mdi:close"></ha-icon></button>`}
        </div>
        <fp-entity-list
          .hass=${this.hass}
          .filter=${p.filter}
          .selected=${p.selected}
          @entity-select=${(e: CustomEvent) => {
            const id = e.detail.entity as string;
            if (p.multi) {
              const selected = p.selected.includes(id) ? p.selected.filter((x) => x !== id) : [...p.selected, id];
              this._picker = { ...p, selected };
            } else {
              p.onPick([id]);
              this._picker = undefined;
            }
          }}
        ></fp-entity-list>
      </div>`;
  }

  private renderKindPicker() {
    const kp = this._kindPick!;
    const words = this._kindQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const close = () => (this._kindPick = undefined);
    const tile = (it: LibraryItem) => {
      const k = it.k;
      const v = it.v ?? k.variants?.[0];
      const w = v?.w ?? k.w;
      const h = v?.h ?? k.h;
      const pad = Math.max(w, h) * 0.16 + 1.5;
      return html`<button
        class="furn pressable"
        data-kind=${k.kind}
        data-variant=${it.v?.id ?? ''}
        aria-pressed=${!it.v && k.kind === kp.current ? 'true' : 'false'}
        @click=${() => {
          kp.onPick(k.kind, it.v?.id);
          close();
        }}
      >
        <svg class="furn-pv" viewBox="${-w / 2 - pad} ${-h / 2 - pad} ${w + pad * 2} ${h + pad * 2}" aria-hidden="true">
          ${drawFurniture({ id: 'pv', kind: k.kind, ...(it.v ? { variant: it.v.id } : {}), x: 0, y: 0, w, h })}
        </svg>
        <span>${categoryLabel(it)}</span>
      </button>`;
    };
    const grid = (items: LibraryItem[]) => html`<div class="furn-grid">${items.map(tile)}</div>`;
    let body;
    if (words.length) {
      const hits = LIBRARY.filter((it) => words.every((wd) => it.text.includes(wd)));
      body = hits.length ? grid(hits) : html`<p class="panel-hint furn-empty">${t('editor.library_empty')}</p>`;
    } else if (this._kindCat === 'all')
      body = CATEGORIES.map((c) => html`<div class="furn-sec"><ha-icon .icon=${c.icon}></ha-icon>${categoryLabel(c)}</div>${grid(LIBRARY.filter((it) => it.k.cat === c.id))}`);
    else body = grid(LIBRARY.filter((it) => it.k.cat === this._kindCat));
    return html`<div class="modal-scrim" @click=${close}></div>
      <div class="picker kinds" role="dialog" aria-label=${t('editor.kind_pick')}>
        <div class="panel-head">
          <div class="panel-title">${t('editor.kind_pick')}</div>
          <button class="icon-btn pressable close" aria-label=${t('common.close')} @click=${close}><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <div class="panel-body">
          <div class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input class="field lib-search kind-search" type="search" placeholder=${t('editor.library_search')} .value=${this._kindQ} @input=${(e: Event) => (this._kindQ = (e.target as HTMLInputElement).value)} />
          </div>
          <div class="cat-chips">
            ${[{ id: 'all', de: 'Alle', en: 'All', icon: 'mdi:view-grid-outline' }, ...CATEGORIES].map(
              (c) => html`<button class="chip pressable" aria-pressed=${!words.length && this._kindCat === c.id ? 'true' : 'false'} @click=${() => ((this._kindCat = c.id), (this._kindQ = ''))}>
                <ha-icon .icon=${c.icon}></ha-icon>${categoryLabel(c)}
              </button>`,
            )}
          </div>
          ${body}
        </div>
      </div>`;
  }

  private renderYaml() {
    const yaml = toYaml({ ...this._draft });
    return html`<div class="modal-scrim" @click=${() => (this._yaml = false)}></div>
      <div class="picker yaml">
        <div class="panel-head">
          <div class="panel-title">${t('editor.yaml_title')}</div>
          <button
            class="btn tinted pressable"
            @click=${async (e: Event) => {
              const btn = e.currentTarget as HTMLElement;
              try {
                await navigator.clipboard.writeText(yaml);
              } catch {
                const ta = this.renderRoot.querySelector('textarea.yaml-text') as HTMLTextAreaElement;
                ta.select();
                document.execCommand('copy');
              }
              btn.textContent = t('common.copied');
            }}
          >
            ${t('common.copy')}
          </button>
          <button class="icon-btn pressable close" aria-label=${t('common.close')} @click=${() => (this._yaml = false)}><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <textarea class="yaml-text" readonly .value=${yaml}></textarea>
      </div>`;
  }

  static override styles = [
    components,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1;
        display: block;
        background: var(--fp-bg);
      }
      .editor {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
      }
      .toolbar {
        height: 64px;
        flex: none;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: var(--fp-space-3);
        padding: 0 var(--fp-space-4);
        background: var(--fp-surface);
        box-shadow: 0 1px 0 var(--fp-separator);
        z-index: 2;
        padding-top: env(safe-area-inset-top, 0);
      }
      .tb-center {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        min-width: 0;
      }
      .tb-center fp-segmented {
        min-width: 160px;
        max-width: 44vw;
      }
      .tb-add-floor {
        white-space: nowrap;
        gap: 4px;
      }
      .tb-right {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: var(--fp-space-1);
      }
      .cancel ha-icon {
        display: none;
      }
      .save {
        margin-left: var(--fp-space-2);
        min-width: 96px;
      }
      /* phones: the bar keeps cancel, floors, 2D/3D, undo and save in view (adding floors, YAML: settings / larger screens) */
      @media (max-width: 600px) {
        .toolbar {
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: var(--fp-space-2);
          padding: 0 var(--fp-space-2);
        }
        .tb-center fp-segmented {
          min-width: 0;
          max-width: none;
          flex: 1;
        }
        .tb-center .tb-add-floor,
        .tb-right .opt {
          display: none;
        }
        .tb-right fp-segmented.dim {
          width: 84px;
          margin-right: 0;
        }
        .save {
          min-width: 0;
          margin-left: var(--fp-space-1);
          padding: 0 var(--fp-space-4);
        }
        .toolbar .btn.plain {
          padding: 0 var(--fp-space-2);
        }
        .cancel span,
        .tb-center.single fp-segmented {
          display: none;
        }
        .toolbar .cancel ha-icon {
          display: inline-flex;
        }
      }
      .stage {
        position: relative;
        flex: 1;
        min-height: 0;
      }
      fp-plan {
        position: absolute;
        inset: 0;
      }
      /* Keep the plan beside the inspector on wide screens */
      .with-panel:not(.narrow) fp-plan {
        right: 404px;
        width: auto;
      }
      fp-plan.tool-draw,
      fp-plan.tool-door,
      fp-plan.tool-window {
        cursor: crosshair;
      }
      .tools {
        position: absolute;
        left: var(--fp-space-4);
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-1);
        padding: var(--fp-space-2);
        background: var(--fp-surface);
        border-radius: var(--fp-radius-l);
        box-shadow: var(--fp-shadow-2);
        z-index: 1;
      }
      .tool {
        width: 48px;
        height: 48px;
        border-radius: var(--fp-radius-m);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fp-label);
        position: relative;
      }
      .tool.small {
        height: 44px;
      }
      .tool.on {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .tool.on-soft {
        color: var(--fp-accent);
      }
      .tool:not(.on-soft).small {
        color: var(--fp-label-3);
      }
      .sep {
        height: 1px;
        margin: var(--fp-space-1) var(--fp-space-2);
        background: var(--fp-separator);
      }
      .tb-right fp-segmented.dim {
        width: 104px;
        margin-right: var(--fp-space-2);
      }
      .camera {
        position: absolute;
        left: 50%;
        bottom: var(--fp-space-4);
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: var(--fp-space-1);
        padding: var(--fp-space-1) var(--fp-space-3) var(--fp-space-1) var(--fp-space-1);
        background: var(--fp-surface);
        border-radius: var(--fp-radius-full);
        box-shadow: var(--fp-shadow-2);
        z-index: 1;
        max-width: calc(100% - 140px);
      }
      .with-panel:not(.narrow) .camera {
        left: calc((100% - 404px) / 2);
      }
      .narrow.with-panel .camera {
        display: none;
      }
      .cam-btn {
        width: var(--fp-hit);
        height: var(--fp-hit);
        border-radius: var(--fp-radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fp-label);
        flex: none;
      }
      .cam-btn.on {
        color: var(--fp-accent);
      }
      .cam-sep {
        width: 1px;
        height: 24px;
        background: var(--fp-separator);
        margin: 0 var(--fp-space-1);
        flex: none;
      }
      .cam-hint {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        margin-left: var(--fp-space-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      @media (max-width: 1100px) {
        .cam-hint {
          display: none;
        }
      }
      .hint {
        position: absolute;
        top: var(--fp-space-4);
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        padding: var(--fp-space-2) var(--fp-space-2) var(--fp-space-2) var(--fp-space-5);
        min-height: 56px;
        background: var(--fp-surface);
        border-radius: var(--fp-radius-full);
        box-shadow: var(--fp-shadow-2);
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
        max-width: calc(100% - 180px);
        animation: rise var(--fp-dur) var(--fp-ease) both;
        z-index: 1;
      }
      .hint span {
        padding-right: var(--fp-space-3);
      }
      .empty-hint {
        padding-left: var(--fp-space-4);
        border-radius: var(--fp-radius-l);
      }
      /* "Treppe setzen": question, kind of stairs, a room to put them in */
      .stairs-hint {
        flex-wrap: wrap;
        justify-content: center;
        padding-left: var(--fp-space-4);
        border-radius: var(--fp-radius-l);
      }
      .stairs-hint .stair-kinds {
        display: inline-flex;
        gap: 4px;
        padding-right: 0;
      }
      .stairs-hint .chip {
        min-height: 36px;
        gap: 6px;
        white-space: nowrap;
      }
      .stairs-hint .chip ha-icon {
        --mdc-icon-size: 18px;
      }
      .empty-hint ha-icon,
      .empty-hint .btn {
        flex: none;
      }
      .narrow .empty-hint {
        left: calc(50% + 40px);
        max-width: calc(100% - 112px);
        flex-wrap: wrap;
        padding: var(--fp-space-3);
      }
      .narrow .empty-hint span {
        flex: 1 1 160px;
      }
      .narrow .empty-hint .btn {
        flex: 1 1 100%;
      }
      /* ---------- Hausregeln: rules panel ---------- */
      .hr-rules {
        margin-top: var(--fp-space-3);
      }
      .hr-rule + .hr-rule {
        border-top: 0.5px solid var(--fp-separator);
      }
      .hr-rule.off .title {
        color: var(--fp-label-3);
      }
      .hr-rule.sel {
        background: color-mix(in srgb, var(--fp-accent) 7%, transparent);
      }
      .hr-pick .hr-sentence {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .hr-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex: none;
      }
      .hr-acts {
        display: flex;
        gap: var(--fp-space-2);
        padding: 0 var(--fp-space-4) var(--fp-space-3);
      }
      .hr-acts .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .hr-legend {
        display: flex;
        gap: var(--fp-space-4);
        padding: 0 var(--fp-space-4) var(--fp-space-3);
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .hr-legend i {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        margin-right: 5px;
      }
      /* ---------- laying a vacuum's map onto the plan ---------- */
      .va-bar .tb-left {
        display: flex;
        gap: var(--fp-space-1);
        align-items: center;
      }
      .va-bar .tb-right {
        display: flex;
        justify-content: flex-end;
      }
      .va-title {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        font-weight: var(--fp-weight-semibold);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .va-title ha-icon {
        color: #2f8cff;
      }
      .va-done {
        min-width: 110px;
      }
      .va-dock {
        position: absolute;
        left: 50%;
        bottom: calc(var(--fp-space-4) + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        width: min(760px, calc(100% - 2 * var(--fp-space-4)));
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-3);
        padding: var(--fp-space-3) var(--fp-space-4);
        border-radius: var(--fp-radius-l, 20px);
        background: color-mix(in srgb, var(--fp-surface) 92%, transparent);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        box-shadow: var(--fp-shadow-3, 0 10px 30px rgba(0, 0, 0, 0.18));
        z-index: 3;
      }
      .va-hint {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        text-align: center;
      }
      .va-rooms {
        display: flex;
        gap: var(--fp-space-2);
        overflow-x: auto;
        scrollbar-width: none;
        justify-content: safe center;
      }
      .va-room {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: var(--fp-radius-full);
        border: 0;
        background: var(--fp-fill);
        color: var(--fp-label);
        font: inherit;
        font-size: var(--fp-text-subhead);
        cursor: pointer;
      }
      .va-room.on {
        background: var(--fp-label);
        color: var(--fp-surface);
      }
      .va-room .pc {
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .va-room.good .pc {
        color: #2fbf63;
      }
      .va-room.ok .pc {
        color: #ff9f0a;
      }
      .va-room.bad .pc {
        color: #ff3b30;
      }
      .va-room .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .dot.c0 { background: #ff7a59; }
      .dot.c1 { background: #2fbf63; }
      .dot.c2 { background: #2f8cff; }
      .dot.c3 { background: #ffb020; }
      .dot.c4 { background: #a05cff; }
      .dot.c5 { background: #00b8c8; }
      .va-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
        justify-content: center;
      }
      .va-actions .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .va-actions .btn.on {
        box-shadow: inset 0 0 0 2px #2f8cff;
      }
      .va-fine {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-5);
        flex-wrap: wrap;
      }
      .va-pad {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      .va-pad .va-row {
        display: flex;
        gap: 2px;
      }
      .va-pair {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        font-variant-numeric: tabular-nums;
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
      }
      .va-pair span {
        min-width: 52px;
        text-align: center;
      }
      .va-step {
        width: 40px;
        height: 34px;
        border-radius: 10px;
        border: 0;
        background: var(--fp-fill);
        color: var(--fp-label);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      .aligning fp-plan.pairing,
      .aligning fp-plan.cropping {
        cursor: crosshair;
      }
      .va-roombar {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
      }
      .va-roombar .btn {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding-left: 8px;
      }
      .va-roomname {
        font-weight: var(--fp-weight-semibold);
        font-size: var(--fp-text-headline, 17px);
      }
      .va-roombar .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        margin-left: var(--fp-space-2);
      }
      .va-roombar .pc {
        margin-left: auto;
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .va-roombar .pc.good {
        color: #2fbf63;
      }
      .va-roombar .pc.ok {
        color: #ff9f0a;
      }
      .va-roombar .pc.bad {
        color: #ff3b30;
      }
      .va-room ha-icon.own {
        --mdc-icon-size: 14px;
        color: #2f8cff;
      }
      .editor.narrow .va-fine {
        gap: var(--fp-space-3);
      }
      .zoom {
        position: absolute;
        left: var(--fp-space-4);
        bottom: var(--fp-space-4);
      }
      .panel {
        position: absolute;
        top: var(--fp-space-3);
        right: var(--fp-space-3);
        bottom: var(--fp-space-3);
        width: 380px;
        display: flex;
        flex-direction: column;
        background: var(--fp-surface-2);
        border-radius: var(--fp-radius-xl);
        box-shadow: var(--fp-shadow-3);
        overflow: hidden;
        animation: slide-in var(--fp-dur-slow) var(--fp-ease) both;
        z-index: 2;
      }
      .narrow .panel {
        top: auto;
        left: var(--fp-space-2);
        right: var(--fp-space-2);
        bottom: var(--fp-space-2);
        width: auto;
        height: 48%;
        animation-name: rise;
      }
      .narrow .tools {
        top: var(--fp-space-4);
        transform: none;
      }
      .narrow.with-panel .zoom {
        display: none;
      }
      .narrow.with-panel fp-plan {
        bottom: calc(48% + var(--fp-space-2));
        height: auto;
      }
      .panel-head {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        padding: var(--fp-space-4) var(--fp-space-4) var(--fp-space-2) var(--fp-space-5);
      }
      .panel-title {
        flex: 1;
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-bold);
        letter-spacing: -0.01em;
      }
      .close {
        width: 36px;
        height: 36px;
        position: relative;
      }
      .close::after {
        content: '';
        position: absolute;
        inset: -4px;
      }
      .close ha-icon {
        --mdc-icon-size: 20px;
        color: var(--fp-label-2);
      }
      .panel-body {
        flex: 1;
        overflow-y: auto;
        padding: 0 var(--fp-space-4) var(--fp-space-6);
        overscroll-behavior: contain;
      }
      .panel-body.fill {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding-bottom: 0;
      }
      .panel-body.fill fp-entity-list {
        flex: 1;
        min-height: 0;
      }
      .panel-hint {
        margin: 0 var(--fp-space-1) var(--fp-space-3);
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .furn-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: var(--fp-space-2);
        padding-bottom: var(--fp-space-4);
      }
      .lib-search {
        background: var(--fp-surface);
      }
      .cat-chips {
        display: flex;
        gap: var(--fp-space-2);
        overflow-x: auto;
        scrollbar-width: none;
        margin: var(--fp-space-3) calc(var(--fp-space-4) * -1) var(--fp-space-2);
        padding: 0 var(--fp-space-4);
      }
      .cat-chips::-webkit-scrollbar {
        display: none;
      }
      .cat-chips .chip {
        min-height: 36px;
        background: var(--fp-surface);
        white-space: nowrap;
        gap: 6px;
      }
      .cat-chips .chip ha-icon {
        --mdc-icon-size: 18px;
        color: var(--fp-label-2);
      }
      .cat-chips .chip[aria-pressed='true'] ha-icon {
        color: inherit;
      }
      .furn-sec {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        margin: var(--fp-space-3) var(--fp-space-1) var(--fp-space-2);
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
      }
      .furn-sec ha-icon {
        --mdc-icon-size: 18px;
      }
      .furn-empty {
        text-align: center;
        padding: var(--fp-space-4) 0;
      }
      .furn-other {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        width: 100%;
        margin: 0 0 var(--fp-space-2);
        padding: var(--fp-space-3);
        background: var(--fp-surface);
        border-radius: var(--fp-radius-m);
        color: var(--fp-label);
        text-align: start;
      }
      .furn-other > ha-icon {
        --mdc-icon-size: 24px;
        color: var(--fp-accent);
        flex: none;
      }
      .furn-other span {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }
      .furn-other b {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
      }
      .furn-other small {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .furn-other .chev {
        --mdc-icon-size: 20px;
        color: var(--fp-label-3);
        flex: none;
      }
      .cat-chips .chip[aria-pressed='true'] {
        background: var(--fp-label);
        color: var(--fp-surface);
      }
      .furn-pv {
        width: 76px;
        height: 56px;
        display: block;
      }
      .furn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-2);
        min-height: 92px;
        background: var(--fp-surface);
        border-radius: var(--fp-radius-m);
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-medium);
        color: var(--fp-label);
        user-select: none;
        -webkit-user-select: none;
        cursor: grab;
      }
      .furn span {
        text-align: center;
        line-height: 1.2;
        padding: 0 var(--fp-space-1);
      }
      .ghost {
        position: fixed;
        left: 0;
        top: 0;
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        padding: var(--fp-space-2) var(--fp-space-4) var(--fp-space-2) var(--fp-space-3);
        margin: -22px 0 0 -22px;
        background: var(--fp-accent);
        color: var(--fp-on-accent);
        border-radius: var(--fp-radius-full);
        box-shadow: var(--fp-shadow-3);
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        pointer-events: none;
        z-index: 10;
        white-space: nowrap;
      }
      .modal-scrim {
        position: fixed;
        inset: 0;
        background: var(--fp-scrim);
        z-index: 5;
        animation: fade var(--fp-dur) var(--fp-ease) both;
      }
      .picker {
        position: fixed;
        left: 50%;
        top: 50%;
        width: min(560px, calc(100% - 32px));
        height: min(720px, calc(100% - 64px));
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        background: var(--fp-surface-2);
        border-radius: var(--fp-radius-xl);
        box-shadow: var(--fp-shadow-3);
        z-index: 6;
        padding-bottom: var(--fp-space-2);
        overflow: hidden;
        animation: pop var(--fp-dur-slow) var(--fp-ease) both;
      }
      .picker.kinds .furn {
        cursor: pointer;
      }
      .picker.kinds .furn[aria-pressed='true'] {
        box-shadow: inset 0 0 0 2px var(--fp-accent);
      }
      .picker.ent-edit {
        height: auto;
        max-height: min(720px, calc(100% - 64px));
      }
      .ent-body {
        overflow: auto;
        padding: 0 var(--fp-space-4) var(--fp-space-4);
      }
      .picker fp-entity-list {
        flex: 1;
        min-height: 0;
        padding: 0 var(--fp-space-4);
      }
      .yaml-text {
        flex: 1;
        margin: 0 var(--fp-space-4) var(--fp-space-3);
        border: 0;
        border-radius: var(--fp-radius-m);
        background: var(--fp-surface);
        color: var(--fp-label);
        padding: var(--fp-space-4);
        font: var(--fp-text-footnote) / 1.5 ui-monospace, Menlo, Consolas, monospace;
        resize: none;
        outline: none;
      }
      .alert {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: min(340px, calc(100% - 32px));
        background: var(--fp-surface-raised);
        border-radius: var(--fp-radius-l);
        box-shadow: var(--fp-shadow-3);
        padding: var(--fp-space-6) var(--fp-space-5) var(--fp-space-5);
        z-index: 6;
        text-align: center;
        animation: pop var(--fp-dur) var(--fp-ease) both;
      }
      .alert-title {
        font-size: var(--fp-text-body);
        font-weight: var(--fp-weight-semibold);
        margin-bottom: var(--fp-space-5);
      }
      .alert-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--fp-space-3);
      }
      /* Inspector */
      .panel-body .group {
        margin-bottom: var(--fp-space-2);
      }
      .panel-body .section-title {
        margin-left: var(--fp-space-2);
      }
      .pick {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        text-align: left;
        min-height: 52px;
        justify-content: center;
        min-width: 0;
      }
      .pick .title {
        max-width: 100%;
      }
      .placeholder {
        color: var(--fp-label-3);
      }
      .accent {
        color: var(--fp-accent);
      }
      .row.add {
        cursor: pointer;
      }
      /* a value next to an entity never squeezes its name away */
      .row .trailing.state {
        max-width: 38%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* hints under a switch / tick: up to two lines instead of cut off */
      .panel-body .row .subtitle.wrap,
      .panel-body .row[role='checkbox'] .subtitle {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      /* own rule: a browser without :has() drops the whole rule it is in */
      .panel-body .row:has(> .switch) .subtitle {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .panel-body details.fold > summary .grow {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .panel-body details.fold > summary .sub {
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* long labels wrap instead of running out of the panel */
      .panel-body .btn.block {
        white-space: normal;
        text-align: center;
        padding-top: var(--fp-space-2);
        padding-bottom: var(--fp-space-2);
      }
      .row .btn.small {
        flex: none;
        min-height: 40px;
        padding: 0 var(--fp-space-3);
        font-size: var(--fp-text-footnote);
      }
      .time-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--fp-space-2) 0;
      }
      .field-row {
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
        padding-top: var(--fp-space-2);
        padding-bottom: var(--fp-space-2);
      }
      .field.inline {
        background: transparent;
        padding: 0;
        min-height: 32px;
        border-radius: 0;
      }
      .field.inline.mono {
        font-family: ui-monospace, Menlo, monospace;
        font-size: var(--fp-text-footnote);
      }
      .field.inline.err {
        box-shadow: inset 0 -2px 0 var(--fp-red);
      }
      /* media buttons: another action instead of a script, tucked away */
      .cmd-other {
        padding: 0 var(--fp-space-4) var(--fp-space-2);
      }
      .cmd-other summary {
        cursor: pointer;
        min-height: 32px;
        display: flex;
        align-items: center;
      }
      .cmd-other fp-action-editor {
        padding: var(--fp-space-2) 0 0;
      }
      .list-tools {
        min-height: var(--fp-hit);
      }
      select.field.inline {
        appearance: none;
        -webkit-appearance: none;
        cursor: pointer;
        color: var(--fp-accent);
      }
      .ic {
        width: 32px;
        height: 32px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-fill);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--fp-label-2);
        flex: none;
        --mdc-icon-size: 18px;
      }
      .icons {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
        margin: var(--fp-space-2) 0 var(--fp-space-4);
      }
      .icons .icon-btn {
        background: var(--fp-surface);
      }
      .icons .icon-btn.accent {
        background: var(--fp-accent);
      }
      .gap {
        margin-top: var(--fp-space-3);
      }
      .suggest {
        margin: var(--fp-space-1) 0 var(--fp-space-2);
      }
      .step-val {
        min-width: 64px;
        text-align: center;
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
      }
      .compass {
        position: relative;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--fp-fill);
        flex: none;
        transform: rotate(var(--rot));
        transition: transform var(--fp-dur) var(--fp-ease);
      }
      .compass .needle {
        position: absolute;
        left: 50%;
        top: 6px;
        width: 0;
        height: 0;
        margin-left: -6px;
        border: 6px solid transparent;
        border-bottom: 14px solid var(--fp-red);
        border-top: 0;
      }
      .compass .n {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 5px;
        text-align: center;
        font-size: 10px;
        font-weight: var(--fp-weight-bold);
        color: var(--fp-label-2);
      }
      .materials {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--fp-space-2);
        margin-bottom: var(--fp-space-3);
      }
      .mat {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-1);
        padding: var(--fp-space-1) 0 var(--fp-space-2);
        border-radius: var(--fp-radius-m);
        background: var(--fp-surface);
        font-size: var(--fp-text-caption);
        font-weight: var(--fp-weight-medium);
        color: var(--fp-label);
        min-height: var(--fp-hit);
      }
      .mat .pv {
        width: calc(100% - 8px);
        aspect-ratio: 1;
        border-radius: var(--fp-radius-s);
        display: block;
      }
      .pv-none {
        fill: var(--fp-room);
        stroke: var(--fp-separator);
      }
      .mat.sel {
        box-shadow: 0 0 0 2.5px var(--fp-accent);
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
        margin-bottom: var(--fp-space-3);
      }
      .swatch {
        width: var(--fp-hit);
        height: var(--fp-hit);
        border-radius: 50%;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
        position: relative;
        cursor: pointer;
      }
      .swatch.sel::after {
        content: '';
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        box-shadow: 0 0 0 2.5px var(--fp-accent);
      }
      .swatch.custom {
        display: flex;
        align-items: center;
        justify-content: center;
        background: conic-gradient(#ff5f57, #febc2e, #28c840, #36a3ff, #b469ff, #ff5f57);
        overflow: hidden;
      }
      .swatch.custom input {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
      }
      .swatch.custom ha-icon {
        --mdc-icon-size: 18px;
        color: #fff;
        pointer-events: none;
      }
      .swatch.none {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-surface);
        color: var(--fp-label-2);
      }
      .swatch.none ha-icon {
        --mdc-icon-size: 18px;
      }
      .side-picker {
        position: relative;
        display: grid;
        grid-template-columns: 48px 96px 48px;
        grid-template-rows: 48px 72px 48px;
        justify-content: center;
        gap: var(--fp-space-1);
        margin: var(--fp-space-2) 0;
      }
      .side-room {
        grid-column: 2;
        grid-row: 2;
        border: 2px solid var(--fp-label-3);
        border-radius: var(--fp-radius-s);
        background: var(--fp-surface);
      }
      .side {
        width: 48px;
        height: 48px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-surface);
        color: var(--fp-label-2);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
      }
      .side.sel {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .side.top {
        grid-column: 2;
        grid-row: 1;
        justify-self: center;
      }
      .side.left {
        grid-column: 1;
        grid-row: 2;
        align-self: center;
      }
      .side.center {
        grid-column: 2;
        grid-row: 2;
        justify-self: center;
        align-self: center;
        width: 40px;
        height: 40px;
      }
      .side.right {
        grid-column: 3;
        grid-row: 2;
        align-self: center;
      }
      .side.bottom {
        grid-column: 2;
        grid-row: 3;
        justify-self: center;
      }
      .dog-card {
        display: block;
        width: 100%;
        margin-top: var(--fp-space-3);
        background: var(--fp-surface);
        border-radius: var(--fp-radius-m);
        overflow: hidden;
        text-align: left;
      }
      .dog-pic {
        height: 180px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(ellipse at 50% 45%, var(--fp-surface) 0%, var(--fp-bg) 80%);
        color: var(--fp-label-3);
        --mdc-icon-size: 48px;
      }
      .dog-pic img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .furn-head {
        display: flex;
        gap: var(--fp-space-3);
        align-items: stretch;
        margin-bottom: var(--fp-space-2);
      }
      .furn-head .grow {
        flex: 1;
        min-width: 0;
      }
      .furn-big {
        width: 96px;
        flex: none;
        background: var(--fp-surface);
        border-radius: var(--fp-radius-m);
        padding: var(--fp-space-2);
      }
      .label-row {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        margin: 0 var(--fp-space-2) var(--fp-space-2);
      }
      .btn-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--fp-space-2);
        margin-top: var(--fp-space-3);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
      }
      .chips .chip {
        background: var(--fp-surface);
      }
      .chips .chip[aria-pressed='true'] {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      /* floors in the settings: badge with the short label, the shown floor ticked */
      .floor-row {
        padding-right: var(--fp-space-2);
        gap: 0;
      }
      .pick.floor-pick {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: var(--fp-space-3);
        min-height: 52px;
        text-align: left;
      }
      .floor-pick .grow {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        min-width: 0;
      }
      .floor-badge {
        flex: none;
        min-width: 36px;
        height: 28px;
        padding: 0 6px;
        border-radius: var(--fp-radius-s);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: var(--fp-text-caption);
        font-weight: var(--fp-weight-bold);
        background: var(--fp-fill);
        color: var(--fp-label-2);
      }
      .floor-row.cur .floor-badge {
        background: color-mix(in srgb, var(--fp-accent) 16%, transparent);
        color: var(--fp-accent);
      }
      .floor-check {
        color: var(--fp-accent);
        --mdc-icon-size: 20px;
        margin-right: var(--fp-space-1);
      }
      .area-chips {
        padding: 0 var(--fp-space-1) var(--fp-space-3);
      }
      .user-block:not(:first-child) {
        border-top: 1px solid var(--fp-separator);
      }
      .user-opts {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--fp-space-2);
        padding: 0 var(--fp-space-4) var(--fp-space-3);
      }
      .user-opts label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--fp-text-caption, 11px);
        color: var(--fp-label-2);
      }
      .user-opts .mini,
      .user-row .mini {
        width: 100%;
        min-height: 36px;
        padding: 0 var(--fp-space-2);
        font-size: var(--fp-text-footnote);
        background: var(--fp-fill);
        border-radius: var(--fp-radius-s);
        color: var(--fp-accent);
      }
      .wall-row .len {
        width: 92px;
        min-height: 36px;
        text-align: right;
        font-size: var(--fp-text-subhead);
        font-variant-numeric: tabular-nums;
        padding: 0 var(--fp-space-2);
      }
      .wall-row .unit {
        color: var(--fp-label-2);
        font-size: var(--fp-text-subhead);
        width: 18px;
      }
      .wall-row.hl .title {
        color: var(--fp-accent);
        font-weight: var(--fp-weight-semibold);
      }
      .hint-s {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        margin: 0 var(--fp-space-2) var(--fp-space-3);
      }
      @keyframes rise {
        from {
          opacity: 0;
          transform: translate(-50%, 8px);
        }
      }
      .narrow .panel {
        animation-name: rise-panel;
      }
      @keyframes rise-panel {
        from {
          opacity: 0;
          transform: translateY(24px);
        }
      }
      @keyframes slide-in {
        from {
          opacity: 0;
          transform: translateX(24px);
        }
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
      @keyframes pop {
        from {
          opacity: 0;
          transform: translate(-50%, -48%) scale(0.98);
        }
      }
    `,
  ];
}

if (!customElements.get('floorplan-card-editor-ui')) customElements.define('floorplan-card-editor-ui', FloorplanEditorUI);

