/**
 * "Wand ziehen": walls standing on their own, without drawing a room – a partition, a half-height wall, a room
 * divider. Tap the start, then every further tap adds a straight piece (a polyline); a tap on the last point again,
 * "Fertig" or Escape ends it. Snapping as usual (corners, walls, lines; the ends of free walls too). Each piece is one
 * record in `floor.walls` ({ id, a, b, thickness?, height?, color? }): selectable, its ends draggable, length,
 * thickness, height ("volle Höhe" or e.g. 110 cm) and paint in the inspector. Undo works (ed.mutate).
 *
 * In the plan they are wall pieces like any other (walls.ts): 2D, 3D (a half-height one at its own height), the
 * dog walks around them, doors and windows can be put on them.
 */
import { html, svg, nothing, type TemplateResult } from 'lit';
import { t } from '../i18n';
import { closestPointOnSegment, round } from '../geometry';
import type { FreeWallConfig, Point } from '../types';
import type { FloorplanEditorUI } from './editor-ui';

const state = new WeakMap<FloorplanEditorUI, { last?: Point; hover?: Point; count: number }>();
const of = (ed: FloorplanEditorUI) => {
  let s = state.get(ed);
  if (!s) state.set(ed, (s = { count: 0 }));
  return s;
};
const uid = () => `wall_${Math.random().toString(36).slice(2, 8)}`;
const r2 = (p: Point): Point => [round(p[0]), round(p[1])];

export function resetWall(ed: FloorplanEditorUI) {
  const s = of(ed);
  s.last = undefined;
  s.hover = undefined;
  s.count = 0;
}

export function wallHover(ed: FloorplanEditorUI, w: Point | null) {
  const s = of(ed);
  s.hover = w ? ed.snap(w, undefined, s.last ? [[s.last]] : []).point : undefined;
  ed.requestUpdate();
}

/** A tap with the tool: the start, then one straight piece per tap; the last point again ends it */
export function wallTap(ed: FloorplanEditorUI, w: Point) {
  const s = of(ed);
  const p = r2(ed.snap(w, undefined, s.last ? [[s.last]] : []).point);
  if (!s.last) {
    s.last = p;
    ed.requestUpdate();
    return;
  }
  if (Math.hypot(p[0] - s.last[0], p[1] - s.last[1]) < 5) return finishWall(ed);
  const a = s.last;
  const id = uid();
  ed.mutate((_d, f) => {
    f.walls = [...(f.walls ?? []), { id, a, b: p }];
  });
  s.last = p;
  s.count++;
  ed.requestUpdate();
}

/** Ends the polyline: the last piece is selected (to set thickness, height …) */
export function finishWall(ed: FloorplanEditorUI) {
  const s = of(ed);
  const last = ed.floor.walls?.[ed.floor.walls.length - 1];
  const had = s.count > 0;
  resetWall(ed);
  ed._tool = 'select';
  if (had && last) ed.select({ kind: 'wall', id: last.id });
  ed.requestUpdate();
}

export function wallHint(ed: FloorplanEditorUI): TemplateResult {
  const s = of(ed);
  return html`<div class="hint">
    <span>${t(s.last ? 'wall.hint_next' : 'wall.hint_start')}</span>
    ${s.last ? html`<button class="btn accent pressable" data-wall-finish @click=${() => finishWall(ed)}>${t('editor.draw_finish')}</button>` : nothing}
  </div>`;
}

export function wallOverlay(ed: FloorplanEditorUI): unknown[] {
  const s = of(ed);
  if (ed._tool !== 'wall' || !s.last || !s.hover) return [];
  return [svg`<line class="ed-split" x1=${s.last[0]} y1=${s.last[1]} x2=${s.hover[0]} y2=${s.hover[1]}></line>`];
}

export function wallPoints(ed: FloorplanEditorUI): Point[] {
  const s = of(ed);
  if (ed._tool !== 'wall') return [];
  return [s.last, s.hover].filter((p): p is Point => !!p);
}

/** The free wall a tap hits (within a few pixels of its line) */
export function freeWallAt(ed: FloorplanEditorUI, w: Point, tolPx = 12): FreeWallConfig | undefined {
  let best: FreeWallConfig | undefined;
  let bd = Infinity;
  for (const x of ed.floor.walls ?? []) {
    const c = closestPointOnSegment(w, x.a, x.b);
    const reach = Math.max(tolPx / ed.scale, (x.thickness ?? ed._draft.wall_width ?? 8) / 2 + 2);
    if (c.dist <= reach && c.dist < bd) {
      bd = c.dist;
      best = x;
    }
  }
  return best;
}
