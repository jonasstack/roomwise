/**
 * "Treppe setzen" in the editor: a tool in the toolbar (next to door, window, garage door) — a tap on the plan
 * places stairs there (straight, L-shaped or spiral, picked in the hint bar), then they are selected so kind, size and
 * steps can be adjusted in the inspector.
 *
 * Also callable from elsewhere (the floors bar, the first steps of a house):
 *   - `placeStairs(ed, at, opts)` places stairs right away;
 *   - `askStairs(ed)` asks "Wo ist die Treppe?" — the next tap places them; a room that is usually where stairs are
 *     (Flur, Diele, Treppenhaus …) is offered with one button. Robot maps never contain stairs: nothing is guessed.
 * Both also come as events on the editor element: `fp-place-stairs` ({ at?: [x, y], variant? }) and `fp-ask-stairs`.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../i18n';
import { pointInPolygon, polylabel } from '../geometry';
import { FURNITURE_BY_KIND } from '../furniture';
import type { FloorConfig, FurnitureConfig, Point, RoomConfig } from '../types';
import type { FloorplanEditorUI } from './editor-ui';

export type StairVariant = 'straight' | 'l' | 'spiral';

/** Per editor: the kind of stairs the tool places and whether it was opened as the question "Wo ist die Treppe?" */
const state = new WeakMap<FloorplanEditorUI, { variant: StairVariant; ask: boolean }>();
const of = (ed: FloorplanEditorUI) => {
  let s = state.get(ed);
  if (!s) state.set(ed, (s = { variant: 'straight', ask: false }));
  return s;
};

/** Rooms where stairs usually are: a stairwell first, then hallways */
const STAIR_ROOM = [/treppe|stair/i, /flur|diele|gang|hall|hallway|entr|eingang/i];

/** The room offered for the stairs (none when nothing fits — never a guess into a living room) */
export function stairsRoom(floor: FloorConfig): RoomConfig | undefined {
  const rooms = floor.rooms.filter((r) => r.points.length >= 3 && !r.outdoor && r.kind !== 'plot');
  for (const re of STAIR_ROOM) {
    const hit = rooms.find((r) => re.test(r.name ?? ''));
    if (hit) return hit;
  }
  return undefined;
}

/** Place stairs at a point of the shown floor (plan units) and select them */
export function placeStairs(ed: FloorplanEditorUI, at: Point, opts: { variant?: StairVariant; w?: number; h?: number; count?: number } = {}): string | undefined {
  const k = FURNITURE_BY_KIND.get('stairs');
  if (!k) return undefined;
  const variant = opts.variant ?? of(ed).variant;
  const before = new Set((ed.floor.furniture ?? []).map((f) => f.id));
  ed.addItemAt({ kind: 'stairs', variant }, at);
  const added = (ed.floor.furniture ?? []).find((f) => !before.has(f.id) && f.kind === 'stairs');
  if (added && (opts.w || opts.h || opts.count)) {
    ed.mutate((_d, fl) => {
      const f = fl.furniture?.find((x) => x.id === added.id);
      if (!f) return;
      if (opts.w) f.w = opts.w;
      if (opts.h) f.h = opts.h;
      if (opts.count) f.count = opts.count;
    });
  }
  of(ed).ask = false;
  ed._tool = 'select';
  ed.requestUpdate();
  return added?.id;
}

/** Ask where the stairs are: the stairs tool with the question in the hint bar */
export function askStairs(ed: FloorplanEditorUI): void {
  const s = of(ed);
  s.ask = true;
  ed._panel = null;
  ed.select(null);
  ed._tool = 'stairs';
  ed.requestUpdate();
}

/** The tool without the question (the floors menu's "Treppe setzen") */
export function startStairsTool(ed: FloorplanEditorUI): void {
  of(ed).ask = false;
  ed._panel = null;
  ed.select(null);
  ed._tool = 'stairs';
  ed.requestUpdate();
}

/**
 * After a house with several floors was laid out (first steps): ask where the stairs are — on a floor with rooms
 * that has a floor above (stairs lead up from there); nothing is asked when no such floor exists.
 */
export function askStairsOnStart(ed: FloorplanEditorUI, order: FloorConfig[]): void {
  if (order.length < 2) return;
  // order: top floor first — every floor but the top one has a floor above
  const below = order.slice(1);
  const at = below.find((f) => f.id === ed.floorId && f.rooms.length) ?? below.find((f) => f.rooms.length);
  if (!at) return;
  if (at.id !== ed.floorId) ed.setFloor(at.id);
  askStairs(ed);
}

/** The editor's tap while the stairs tool is on */
export function stairsTap(ed: FloorplanEditorUI, w: Point): void {
  placeStairs(ed, w);
}

/** Events from outside (floors bar, first steps): `fp-place-stairs` / `fp-ask-stairs` */
export function onStairsEvent(ed: FloorplanEditorUI, e: Event): void {
  const d = (e as CustomEvent).detail ?? {};
  if (e.type === 'fp-ask-stairs') return askStairs(ed);
  if (Array.isArray(d.at) && d.at.length === 2) {
    placeStairs(ed, [Number(d.at[0]), Number(d.at[1])], { variant: d.variant });
    return;
  }
  if (d.variant) of(ed).variant = d.variant;
  startStairsTool(ed);
}

/** Whether a piece is stairs that already stand at this point */
export function stairsAt(floor: FloorConfig, p: Point): FurnitureConfig | undefined {
  return (floor.furniture ?? []).find((f) => f.kind === 'stairs' && Math.hypot(f.x - p[0], f.y - p[1]) < Math.max(f.w, f.h) / 2);
}

/** The hint bar while the tool is on: the question (when asked), the kind of stairs, a room to put them in, later */
export function stairsHint(ed: FloorplanEditorUI): TemplateResult {
  const s = of(ed);
  const room = stairsRoom(ed.floor);
  const pick = (v: StairVariant, icon: string, label: string) =>
    html`<button class="chip pressable" data-stair-variant=${v} aria-pressed=${s.variant === v ? 'true' : 'false'} @click=${() => {
      s.variant = v;
      ed.requestUpdate();
    }}><ha-icon .icon=${icon}></ha-icon>${label}</button>`;
  const inRoom = room
    ? html`<button
        class="btn pressable"
        data-stairs-room=${room.id}
        @click=${() => {
          const c = room.label && pointInPolygon(room.label, room.points) ? room.label : polylabel(room.points);
          placeStairs(ed, c);
        }}
      >
        ${t('editor.stairs_in', { room: room.name || t('editor.room') })}
      </button>`
    : nothing;
  return html`<div class="hint stairs-hint" role="status">
    <ha-icon icon="mdi:stairs" style="color:var(--fp-accent)"></ha-icon>
    <span>${s.ask ? t('editor.stairs_ask') : t('editor.stairs_place_hint')}</span>
    <span class="stair-kinds">
      ${pick('straight', 'mdi:stairs', t('editor.stairs_straight'))}${pick('l', 'mdi:stairs-box', t('editor.stairs_l'))}${pick('spiral', 'mdi:rotate-right', t('editor.stairs_spiral'))}
    </span>
    ${inRoom}
    ${s.ask
      ? html`<button
          class="btn pressable"
          data-stairs-later
          @click=${() => {
            s.ask = false;
            ed._tool = 'select';
            ed.requestUpdate();
          }}
        >
          ${t('editor.stairs_later')}
        </button>`
      : nothing}
  </div>`;
}
