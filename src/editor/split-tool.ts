/**
 * "Raum teilen" and "Räume zusammenlegen" in the editor.
 *
 * Raum teilen (tool in the toolbar, or from the room's inspector): two taps draw a line right through a room (with
 * the usual snapping to corners, walls and lines); the room is cut there into two rooms. Chosen in the hint bar:
 * "ohne Wand" (default – an open kitchen: the cut is a passage, only a faint line on the floor) or "mit Wand" (the
 * shared edge becomes a wall like any other). The larger part keeps the room (name, area, lights, climate …), the
 * other part becomes a new room, selected right away to name it and give it its devices. Furniture and devices stay
 * where they are and belong to the part they stand in; doors and windows on the outer walls stay.
 *
 * Räume zusammenlegen (room inspector): two neighbouring rooms become one – offered only when the result is one
 * simple outline. Doors and passages on the former shared wall go.
 *
 * Geometry: ../room-split.ts. Everything goes through `ed.mutate`, so undo works.
 */
import { html, svg, nothing, type TemplateResult } from 'lit';
import { t } from '../i18n';
import { closestPointOnSegment, pointInPolygon, round } from '../geometry';
import { mergeOutlines, splitOutline } from '../room-split';
import type { OpeningConfig, Point, RoomConfig } from '../types';
import type { FloorplanEditorUI } from './editor-ui';

/** Per editor: the first point of the line, the room picked in the inspector, with or without a wall */
const state = new WeakMap<FloorplanEditorUI, { a?: Point; room?: string; wall: boolean; hover?: Point }>();
const of = (ed: FloorplanEditorUI) => {
  let s = state.get(ed);
  if (!s) state.set(ed, (s = { wall: false }));
  return s;
};

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

/** Switch the tool on (from the toolbar or "Raum teilen …" in a room's inspector) */
export function startSplit(ed: FloorplanEditorUI, room?: string) {
  const s = of(ed);
  s.a = undefined;
  s.hover = undefined;
  s.room = room;
  ed._tool = 'split';
  ed._panel = null;
  ed.requestUpdate();
}

/** Leaving the tool (another tool, Escape) */
export function resetSplit(ed: FloorplanEditorUI) {
  const s = of(ed);
  s.a = undefined;
  s.hover = undefined;
  s.room = undefined;
}

export function splitHover(ed: FloorplanEditorUI, w: Point | null) {
  const s = of(ed);
  s.hover = w ? ed.snap(w, undefined, s.a ? [[s.a]] : []).point : undefined;
  ed.requestUpdate();
}

/** A tap with the tool: first the start of the line, then its end – and the room is cut */
export function splitTap(ed: FloorplanEditorUI, w: Point) {
  const s = of(ed);
  const p = ed.snap(w, undefined, s.a ? [[s.a]] : []).point;
  if (!s.a) {
    s.a = p;
    ed.requestUpdate();
    return;
  }
  const a = s.a;
  s.a = undefined;
  const res = splitRoom(ed, a, p, s.wall, s.room);
  if (res) {
    s.room = undefined;
    s.hover = undefined;
  }
  ed.requestUpdate();
}

/** The room a line cuts: the one picked, else the one the line's middle lies in */
function roomFor(ed: FloorplanEditorUI, a: Point, b: Point, picked?: string): RoomConfig | undefined {
  const rooms = ed.floor.rooms.filter((r) => r.points.length >= 3 && r.kind !== 'plot');
  if (picked) {
    const r = rooms.find((x) => x.id === picked);
    if (r) return r;
  }
  const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return rooms.find((r) => pointInPolygon(mid, r.points));
}

/** A name for the new part: "Küche" when the floor has none yet (the open kitchen), else "Raum n" */
function newName(ed: FloorplanEditorUI): string {
  const kitchen = t('split.kitchen');
  if (!ed.floor.rooms.some((r) => (r.name ?? '').toLowerCase() === kitchen.toLowerCase())) return kitchen;
  return `${t('editor.room')} ${ed.floor.rooms.length + 1}`;
}

/** Cuts a room along a→b; with `wall` false the cut is a passage. Returns the new room's id (or undefined + a hint). */
export function splitRoom(ed: FloorplanEditorUI, a: Point, b: Point, wall = false, picked?: string): string | undefined {
  const room = roomFor(ed, a, b, picked);
  if (!room) {
    ed.layer.toast(t('split.no_room'));
    return undefined;
  }
  const res = splitOutline(room.points, a, b);
  if (!res.ok) {
    ed.layer.toast(t(res.reason === 'small' ? 'split.too_small' : 'split.through'));
    return undefined;
  }
  const id = uid('room');
  const name = newName(ed);
  ed.mutate((_d, f) => {
    const r = f.rooms.find((x) => x.id === room.id);
    if (!r) return;
    r.points = res.pieces[0];
    // the new part looks like the old room (floor, walls), but has its own name, area and devices
    const part: RoomConfig = { id, name, points: res.pieces[1] };
    if (r.floor) part.floor = { ...r.floor };
    if (r.wall_color) part.wall_color = r.wall_color;
    if (r.outdoor) part.outdoor = true;
    f.rooms.push(part);
    if (!wall) {
      const [p, q] = res.chord;
      f.openings = [...(f.openings ?? []), { id: uid('open'), type: 'passage', a: [round(p[0]), round(p[1])], b: [round(q[0]), round(q[1])] }];
    }
  });
  ed._tool = 'select';
  ed.select({ kind: 'room', id });
  ed.layer.toast(t(wall ? 'split.done_wall' : 'split.done_open', { name }));
  return id;
}

/** The room next door this one can be joined with (one simple outline), with the result */
export function mergeCandidates(ed: FloorplanEditorUI, r: RoomConfig): { room: RoomConfig; outline: Point[]; shared: [Point, Point][] }[] {
  if (r.points.length < 3 || r.kind === 'plot') return [];
  const out: { room: RoomConfig; outline: Point[]; shared: [Point, Point][] }[] = [];
  for (const o of ed.floor.rooms) {
    if (o.id === r.id || o.points.length < 3 || !!o.outdoor !== !!r.outdoor || o.kind === 'plot') continue;
    const m = mergeOutlines(r.points, o.points);
    if (m) out.push({ room: o, ...m });
  }
  return out;
}

/** Joins `other` into `keep`: one outline, the other room's settings fill gaps, openings on the old wall go */
export function mergeRooms(ed: FloorplanEditorUI, keepId: string, otherId: string) {
  const keep = ed.floor.rooms.find((r) => r.id === keepId);
  const other = ed.floor.rooms.find((r) => r.id === otherId);
  if (!keep || !other) return;
  const m = mergeOutlines(keep.points, other.points);
  if (!m) {
    ed.layer.toast(t('split.merge_no'));
    return;
  }
  const onShared = (o: OpeningConfig) => m.shared.some(([p, q]) => closestPointOnSegment(o.a, p, q).dist < 2 && closestPointOnSegment(o.b, p, q).dist < 2);
  ed.mutate((_d, f) => {
    const k = f.rooms.find((r) => r.id === keepId);
    const o = f.rooms.find((r) => r.id === otherId);
    if (!k || !o) return;
    k.points = m.outline;
    // what only the other room had (lights, thermostat, sensors …) comes along
    for (const [key, v] of Object.entries(o)) {
      if (key === 'id' || key === 'name' || key === 'points' || v === undefined) continue;
      const cur = (k as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v) && Array.isArray(cur)) (k as unknown as Record<string, unknown>)[key] = [...new Set([...cur, ...v])];
      else if (cur === undefined) (k as unknown as Record<string, unknown>)[key] = v;
    }
    f.rooms = f.rooms.filter((r) => r.id !== otherId);
    f.openings = (f.openings ?? []).filter((x) => !onShared(x));
  });
  ed.select({ kind: 'room', id: keepId });
  ed.layer.toast(t('split.merged', { a: keep.name || '', b: other.name || '' }));
}

/** The hint bar of the tool: what to do, with or without a wall */
export function splitHint(ed: FloorplanEditorUI): TemplateResult {
  const s = of(ed);
  const pick = (wall: boolean, label: string) =>
    html`<button class="chip pressable ${s.wall === wall ? 'on' : ''}" aria-pressed=${s.wall === wall ? 'true' : 'false'} data-split-wall=${wall ? 'wall' : 'open'} @click=${() => {
      s.wall = wall;
      ed.requestUpdate();
    }}>${label}</button>`;
  return html`<div class="hint split-hint">
    <span>${t(s.a ? 'split.hint_end' : 'split.hint_start')}</span>
    <span class="split-kinds">${pick(false, t('split.open'))}${pick(true, t('split.wall'))}</span>
    ${s.a ? html`<button class="btn pressable" @click=${() => { s.a = undefined; ed.requestUpdate(); }}><ha-icon icon="mdi:undo-variant"></ha-icon></button>` : nothing}
  </div>`;
}

/** The line being drawn (plan units, in the editor's overlay svg) */
export function splitOverlay(ed: FloorplanEditorUI): unknown[] {
  const s = of(ed);
  if (ed._tool !== 'split' || !s.a) return [];
  const b = s.hover ?? s.a;
  return [svg`<line class="ed-split" x1=${s.a[0]} y1=${s.a[1]} x2=${b[0]} y2=${b[1]}></line>`];
}

/** The points shown as handles (start of the line, the snapped spot under the pointer) */
export function splitPoints(ed: FloorplanEditorUI): Point[] {
  const s = of(ed);
  if (ed._tool !== 'split') return [];
  return [s.a, s.hover].filter((p): p is Point => !!p);
}
