/**
 * <hr-light-glow>: Licht → Reinschau-Licht. A plain map of the rooms from the floor plan card (outlines and names, no
 * furniture); rooms that glow are lit warm. Tapping a room opens its setting: which other rooms make it glow (someone
 * in there, a light on there, or either – optionally only while a door is open or closed), which lamps glow how
 * bright, when (at night / when dark / always, not while sleeping, not with guests) and what must be off (e.g. the
 * TV). Saved with the room's light plan as `glow` (glow.py turns it into two light rules). Rules made by hand for
 * the same earlier can be replaced. Fires "close".
 *
 * The doors of the floor plan that have a sensor tell which rooms border on each other: a door is probed a little to
 * either side and the room on each side found. Those doors are suggested first ("someone next door and the door
 * open"); every other way (a light on next door, a door closed, rooms without a door sensor) only shows after
 * "Weitere Auslöser" is switched on.
 */
import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { StoreElement } from '../base';
import { shared } from '../design/shared';
import { kit } from '../design/kit';
import type { Device, GlowGlobal, LightGlow, LightPlan, Room } from '../model';
import { GLOW_GLOBAL } from '../store';
import { findFloorplanCard } from '../setup/dashboard';
import { t } from '../i18n';
import '../components/pop';
import '../components/live-toggle';
import { swatches, swatchStyles } from '../components/swatches';
// i18n: complete

interface MapRoom {
  name: string;
  points: [number, number][];
  /** the Hausregeln room it stands for (by name) */
  rid?: string;
}
/** a door with a sensor on the plan and the Hausregeln rooms on its two sides (undefined = outside / unknown) */
interface MapDoor {
  entity: string;
  name: string;
  a: [number, number];
  b: [number, number];
  sides: [string | undefined, string | undefined];
}
interface MapFloor {
  name: string;
  rooms: MapRoom[];
  doors: MapDoor[];
}

function inside(p: [number, number], pts: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const GLOW: LightGlow = { on: false, sources: [], lights: [], brightness: 5, per_light: {}, color: 'rules', dark: 'night', not_sleep: true, not_guests: false, only_off: [] };
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
/** rules made by hand earlier that do the same (as glow.py HANDMADE) */
const HANDMADE = /reinschau|glimmt|glow/i;
const IDS = ['glowauto', 'glowautok'];

/** the floor plan card's floors with their rooms, matched to the Hausregeln rooms by name; null = no card */
export async function glowMap(store: StoreElement['store']): Promise<MapFloor[] | null> {
  const found = await findFloorplanCard(store).catch(() => null);
  type CardFloor = { name?: string; rooms?: { name?: string; points?: [number, number][] }[]; openings?: { type?: string; a?: [number, number]; b?: [number, number]; entity?: string; name?: string }[] };
  const floors = (found?.card as { floors?: CardFloor[] } | undefined)?.floors;
  if (!floors?.length) return null;
  const byName = new Map(store.rooms.map((r) => [norm(r.name), r.id]));
  return floors.map((f) => {
    const rooms = (f.rooms ?? []).filter((r) => Array.isArray(r.points) && r.points.length >= 3).map((r) => ({ name: r.name ?? '', points: r.points!, rid: byName.get(norm(r.name ?? '')) }));
    const at = (p: [number, number]) => rooms.find((r) => inside(p, r.points))?.rid;
    const doors = (f.openings ?? [])
      .filter((o) => o.type === 'door' && o.entity?.startsWith('binary_sensor.') && o.a && o.b)
      .map((o) => {
        const [a, b] = [o.a!, o.b!];
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        // a little to either side of the door, across the wall
        const nx = (-(b[1] - a[1]) / len) * 18;
        const ny = ((b[0] - a[0]) / len) * 18;
        const name = o.name || store.device(o.entity!)?.name || o.entity!;
        return { entity: o.entity!, name, a, b, sides: [at([mx + nx, my + ny]), at([mx - nx, my - ny])] as [string | undefined, string | undefined] };
      });
    return { name: f.name ?? '', rooms, doors };
  });
}

/** doors with a sensor between this room and another one: [door, the room behind it] */
function doorsOf(floors: MapFloor[] | null | undefined, rid: string): { door: MapDoor; other: string }[] {
  const out: { door: MapDoor; other: string }[] = [];
  for (const d of (floors ?? []).flatMap((f) => f.doors)) {
    const [x, y] = d.sides;
    if (x === rid && y && y !== rid) out.push({ door: d, other: y });
    else if (y === rid && x && x !== rid) out.push({ door: d, other: x });
  }
  return out;
}

export class HrLightGlow extends StoreElement {
  static override properties = { ...StoreElement.properties, _floors: { state: true }, _floor: { state: true }, _room: { state: true }, _draft: { state: true }, _replace: { state: true }, _more: { state: true } };
  declare _floors: MapFloor[] | null | undefined;
  declare _floor: number;
  /** the room whose setting is open */
  declare _room: string;
  declare _draft: LightGlow | null;
  declare _replace: boolean;
  /** "Weitere Auslöser": every other way than someone next door behind a door with a sensor */
  declare _more: boolean;

  constructor() {
    super();
    this._floors = undefined;
    this._floor = 0;
    this._room = '';
    this._draft = null;
    this._replace = true;
    this._more = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    glowMap(this.store).then((f) => (this._floors = f));
  }

  protected override frozen(): boolean {
    return !!this._draft;
  }

  static override styles = [
    shared,
    kit,
    swatchStyles,
    css`
      svg.map {
        width: 100%;
        height: auto;
        max-height: 56vh;
        display: block;
        background: var(--hr-surface);
        border-radius: var(--hr-radius-l);
        box-shadow: var(--hr-shadow-1);
      }
      .room {
        fill: var(--hr-fill);
        stroke: var(--hr-separator);
        stroke-width: 3;
        cursor: pointer;
        transition: fill var(--hr-dur-fast);
      }
      .room:hover {
        fill: color-mix(in srgb, var(--hr-accent) 14%, var(--hr-fill));
      }
      .room.on {
        fill: color-mix(in srgb, var(--hr-glow) 70%, transparent);
        stroke: var(--hr-orange);
      }
      .room.none {
        fill: transparent;
        cursor: default;
        stroke-dasharray: 8 6;
      }
      text {
        font-family: var(--hr-font);
        font-weight: 600;
        fill: var(--hr-label);
        pointer-events: none;
        text-anchor: middle;
        dominant-baseline: middle;
      }
      line.door {
        stroke: var(--hr-accent);
        stroke-width: 10;
        stroke-linecap: round;
        pointer-events: none;
      }
      text.sub {
        font-weight: 500;
        fill: var(--hr-label-2);
      }
      .src {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .src + .src {
        border-top: 0.5px solid var(--hr-separator);
        padding-top: var(--hr-space-3);
      }
      .src .line {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        flex-wrap: wrap;
      }
      .src .line b {
        flex: 1 1 140px;
      }
      select {
        font: inherit;
        padding: 6px 10px;
        border-radius: var(--hr-radius-m);
        border: 0;
        background: var(--hr-fill);
        color: inherit;
        max-width: 100%;
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper button {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 18px;
      }
      .stepper output {
        min-width: 52px;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .lamp {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        min-height: 44px;
      }
      .lamp label {
        flex: 1;
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .lamp input,
      .chk input {
        width: 20px;
        height: 20px;
        accent-color: var(--hr-accent);
      }
      .stepper input.num {
        width: 56px;
        text-align: right;
        font: inherit;
        font-weight: 600;
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-fill);
        padding: 4px 6px;
        color: inherit;
      }
      input.range {
        width: 100%;
        accent-color: var(--hr-accent);
      }
      label.pick {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-subhead);
      }
      label.pick input {
        width: 44px;
        height: 32px;
        border: 0;
        background: none;
        padding: 0;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        min-height: 40px;
      }
    `,
  ];

  private _plan(rid: string): LightPlan | undefined {
    return this.store.plans?.light?.[rid];
  }

  private _glow(rid: string): LightGlow {
    return { ...GLOW, ...(this._plan(rid)?.glow ?? {}) };
  }

  private _open(rid: string) {
    this._room = rid;
    const g = structuredClone(this._glow(rid));
    const doors = doorsOf(this._floors, rid);
    if (!g.on && !g.sources.length) {
      // never set up: the doors with a sensor that border on the room are suggested (someone behind it, door open)
      g.sources = doors.map(({ door, other }) => ({ room: other, by: 'occupied' as const, door: door.entity, door_state: 'open' as const }));
    }
    this._draft = g;
    this._replace = true;
    // anything but "someone behind a door with a sensor, door open" was set: show the other ways right away
    // the door choices below (someone + door open / only the door / only someone behind it) are the usual ones
    const usual = (src: LightGlow['sources'][number]) =>
      src.door
        ? src.door_state === 'open' && (src.by === 'occupied' || src.by === 'door') && doors.some((d) => d.door.entity === src.door && d.other === src.room)
        : src.by === 'occupied' && doors.some((d) => d.other === src.room);
    this._more = g.sources.some((src) => !usual(src));
  }

  private _close() {
    this._room = '';
    this._draft = null;
    this.thaw();
  }

  private _set(patch: Partial<LightGlow>) {
    if (this._draft) this._draft = { ...this._draft, ...patch };
  }

  private _devices(rid: string, kinds: string[]): Device[] {
    return this.store.devices.filter((d) => d.room === rid && kinds.includes(d.kind));
  }

  /** "like the light rules": the colour of this room's own rule that switches its light on (best when someone comes
   * in), as glow.py takes it – only for the live preview here (its "je nach …" variants count on the server) */
  private _rulesColour(rid: string, lights: string[]): string {
    const rules = (this._plan(rid)?.rules ?? []).filter(
      (r) => r.enabled && !IDS.includes(r.id) && (r.kind === 'when' || r.kind === 'while') && (r.action?.mode ?? 'on') === 'on' && (!r.lights.length || r.lights.some((e) => lights.includes(e))),
    );
    const entering = rules.filter((r) => [...(r.trigger ?? []), ...(r.when ?? [])].some((c) => c.subject === `room:${rid}`));
    const c = (entering[0] ?? rules[0])?.action?.color;
    return c && c !== 'none' ? c : 'warm';
  }

  private _handmade(rid: string) {
    return (this._plan(rid)?.rules ?? []).filter((r) => !IDS.includes(r.id) && (HANDMADE.test(r.name) || HANDMADE.test(r.id)));
  }

  private async _save() {
    const rid = this._room;
    const p = this._plan(rid);
    const g = this._draft;
    if (!p || !g) return;
    const replace = g.on && this._replace ? this._handmade(rid).map((r) => r.id) : [];
    await this.store.planSet('light', rid, { ...p, glow: g, glow_replace: replace } as LightPlan);
    this.dispatchEvent(new CustomEvent('hr-toast', { detail: t('glow.saved', { room: this.store.rooms.find((r) => r.id === rid)?.name ?? '' }), bubbles: true, composed: true }));
    this._close();
  }

  // ------------------------------------------------------------------ the map
  private _map(floor: MapFloor): TemplateResult {
    const pts = floor.rooms.flatMap((r) => r.points);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 20;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    const w = Math.max(...xs) - x0 + pad;
    const h = Math.max(...ys) - y0 + pad;
    const font = Math.max(14, Math.min(w, h) / 22);
    return html`<svg class="map" viewBox="${x0} ${y0} ${w} ${h}" role="group" aria-label=${t('glow.map')}>
      ${floor.rooms.map((r) => {
        const on = !!(r.rid && this._glow(r.rid).on);
        const cx = r.points.reduce((a, p) => a + p[0], 0) / r.points.length;
        const cy = r.points.reduce((a, p) => a + p[1], 0) / r.points.length;
        const open = () => r.rid && this._open(r.rid);
        return svg`<g>
          <polygon class="room ${on ? 'on' : ''} ${r.rid ? '' : 'none'}" points=${r.points.map((p) => p.join(',')).join(' ')}
            role=${r.rid ? 'button' : 'img'} tabindex=${r.rid ? '0' : '-1'} aria-label=${r.name}
            @click=${open} @keydown=${(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && open()}></polygon>
          <text x=${cx} y=${cy - font * 0.4} style="font-size:${font}px">${r.name}</text>
          <text class="sub" x=${cx} y=${cy + font * 0.8} style="font-size:${font * 0.75}px">${!r.rid ? t('glow.no_room') : on ? t('glow.on_short') : t('glow.off_short')}</text>
        </g>`;
      })}
      ${floor.doors.map((d) => svg`<line class="door" x1=${d.a[0]} y1=${d.a[1]} x2=${d.b[0]} y2=${d.b[1]}><title>${d.name}</title></line>`)}
    </svg>`;
  }

  private _mapPop() {
    const f = this._floors;
    const close = () => this.dispatchEvent(new CustomEvent('close'));
    const on = Object.values(this.store.plans?.light ?? {}).filter((p) => p.glow?.on).length;
    return html`<hr-pop wide heading=${t('glow.title')} .sub=${on ? t('glow.n_on', { n: on }) : t('glow.none_on')} @close=${close}>
      <p class="rl-note">${t('glow.lead')}</p>
      ${f === undefined
        ? html`<p class="rl-note">${t('glow.loading')}</p>`
        : f === null
          ? html`<div class="rl-info">${t('glow.no_map')}</div>`
          : html`${f.length > 1
                ? html`<div class="seg" role="tablist">${f.map((x, i) => html`<button role="tab" aria-pressed=${this._floor === i ? 'true' : 'false'} @click=${() => (this._floor = i)}>${x.name}</button>`)}</div>`
                : nothing}
              ${this._map(f[Math.min(this._floor, f.length - 1)])}
              <p class="rl-note">${t('glow.tap')}</p>
              ${this._whenSec()}`}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  /** when the Reinschau-Licht may glow at all: one setting for every room */
  private _whenSec() {
    const s = this.store;
    const g = { ...GLOW_GLOBAL, ...(s.plans?.glow ?? {}) };
    const set = (patch: Partial<GlowGlobal>) => s.glowSet(patch);
    return html`<div class="rl-sec">
      <h3>${t('glow.when_all')}</h3>
      <div class="rl-box">
        <div class="seg" role="radiogroup" aria-label=${t('glow.when_all')}>
          ${(['night', 'dark', 'time', 'always'] as const).map((d) => html`<button role="radio" aria-pressed=${g.dark === d ? 'true' : 'false'} @click=${() => set({ dark: d })}>${t(`glow.dark_${d}`)}</button>`)}
        </div>
        <small>${t(`glow.dark_${g.dark}_sub`)}</small>
        ${g.dark === 'time'
          ? html`<div class="line">
              <span>${t('glow.from')}</span><input type="time" aria-label=${t('glow.from')} .value=${g.from} @change=${(e: Event) => set({ from: (e.target as HTMLInputElement).value || '20:00' })} />
              <span>${t('glow.to')}</span><input type="time" aria-label=${t('glow.to')} .value=${g.to} @change=${(e: Event) => set({ to: (e.target as HTMLInputElement).value || '06:00' })} />
            </div>`
          : nothing}
        <label class="chk"><input type="checkbox" .checked=${g.not_sleep} @change=${() => set({ not_sleep: !g.not_sleep })} />${t('glow.not_sleep')}</label>
        <label class="chk"><input type="checkbox" .checked=${g.not_guests} @change=${() => set({ not_guests: !g.not_guests })} />${t('glow.not_guests')}</label>
      </div>
      <p class="rl-note">${t('glow.when_all_note')}</p>
    </div>`;
  }

  // ------------------------------------------------------------------ the setting of one room
  private _roomPop(room: Room, g: LightGlow) {
    const others = this.store.orderedRooms().filter((r) => r.id !== room.id);
    const src = (rid: string) => g.sources.find((s) => s.room === rid);
    const setSrc = (rid: string, patch: Partial<LightGlow['sources'][number]> | null) => {
      const rest = g.sources.filter((s) => s.room !== rid);
      const cur = src(rid) ?? { room: rid, by: 'occupied' as const, door: null, door_state: 'open' as const };
      // choosing a first source switches the glow on
      this._set({ sources: patch === null ? rest : [...rest, { ...cur, ...patch }], ...(patch !== null && !g.sources.length ? { on: true } : {}) });
    };
    const lights = this._devices(room.id, ['light']);
    const offs = this._devices(room.id, ['media', 'switch', 'outlet', 'fan', 'purifier']);
    const made = this._handmade(room.id);
    // brightness in percent: typed in (1–100), or one step with − / +
    const pct = (v: number, set: (v: number) => void, label: string) => html`<span class="stepper">
      <button aria-label=${t('glow.less', { what: label })} @click=${() => set(Math.max(1, v - (v > 10 ? 5 : 1)))}>−</button>
      <input class="num" type="number" min="1" max="100" inputmode="numeric" .value=${String(v)} aria-label=${label} @change=${(e: Event) => set(Math.max(1, Math.min(100, Math.round(Number((e.target as HTMLInputElement).value) || 1))))} /><span>%</span>
      <button aria-label=${t('glow.more', { what: label })} @click=${() => set(Math.min(100, v + (v >= 10 ? 5 : 1)))}>+</button>
    </span>`;
    const byRules = g.color === 'rules';
    return html`<hr-pop heading=${t('glow.room_title', { room: room.name })} .sub=${t('glow.room_sub')} @close=${() => this._close()}>
      <button slot="head" class="switch" role="switch" aria-label=${t('glow.title')} aria-checked=${g.on ? 'true' : 'false'} @click=${() => this._set({ on: !g.on })}></button>
      ${this._doorSec(room, g)}
      <label class="chk"><input type="checkbox" .checked=${this._more} @change=${() => (this._more = !this._more)} />${t('glow.more_ways')}</label>
      ${this._more
        ? html`<div class="rl-sec">
        <h3>${t('glow.when_title')}</h3>
        <div class="rl-box">
          ${others.map((o) => {
            const s = src(o.id);
            const doors = this.store.devices.filter((d) => d.kind === 'door' && (d.room === o.id || d.room === room.id));
            return html`<div class="src">
              <div class="line">
                <b>${o.name}</b>
                <div class="seg" role="radiogroup" aria-label=${o.name}>
                  ${(['', 'occupied', 'light', 'either'] as const).map(
                    (by) => html`<button role="radio" aria-pressed=${(s?.by ?? '') === by ? 'true' : 'false'} @click=${() => setSrc(o.id, by ? { by } : null)}>${t(`glow.by_${by || 'none'}` as 'glow.by_none')}</button>`,
                  )}
                </div>
              </div>
              ${s
                ? html`<div class="line">
                    <span class="muted">${t('glow.door')}</span>
                    <select aria-label=${t('glow.door')} @change=${(e: Event) => setSrc(o.id, { door: (e.target as HTMLSelectElement).value || null })}>
                      <option value="" ?selected=${!s.door}>${t('glow.door_any')}</option>
                      ${doors.map((d) => html`<option value=${d.entity_id} ?selected=${s.door === d.entity_id}>${d.name}</option>`)}
                    </select>
                    ${s.door
                      ? html`<div class="seg" role="radiogroup" aria-label=${t('glow.door')}>
                          <button role="radio" aria-pressed=${s.door_state !== 'closed' ? 'true' : 'false'} @click=${() => setSrc(o.id, { door_state: 'open' })}>${t('glow.open')}</button>
                          <button role="radio" aria-pressed=${s.door_state === 'closed' ? 'true' : 'false'} @click=${() => setSrc(o.id, { door_state: 'closed' })}>${t('glow.closed')}</button>
                        </div>`
                      : nothing}
                  </div>`
                : nothing}
            </div>`;
          })}
        </div>
        <p class="rl-note">${t('glow.when_note', { room: room.name })}</p>
      </div>`
        : nothing}
      <div class="rl-sec">
        <h3>${t('glow.lamps')}</h3>
        <div class="rl-box">
          <div class="line">
            <span class="grow"><b>${t('glow.brightness')}</b><small>${t('glow.brightness_sub')}</small></span>
            ${pct(g.brightness, (v) => this._set({ brightness: v }), t('glow.brightness'))}
          </div>
          <input class="range" type="range" min="1" max="100" .value=${String(g.brightness)} aria-label=${t('glow.brightness')} @input=${(e: Event) => this._set({ brightness: Number((e.target as HTMLInputElement).value) })} />
          ${lights.length
            ? lights.map((l) => {
                const on = g.lights.includes(l.entity_id);
                const own = g.per_light[l.entity_id];
                return html`<div class="lamp">
                  <label><input type="checkbox" .checked=${on} @change=${() => this._set({ lights: on ? g.lights.filter((x) => x !== l.entity_id) : [...g.lights, l.entity_id], ...(!on && !g.lights.length && g.sources.length ? { on: true } : {}) })} />${l.name}</label>
                  ${on
                    ? own != null
                      ? html`${pct(own, (v) => this._set({ per_light: { ...g.per_light, [l.entity_id]: v } }), l.name)}
                          <button class="btn small plain" @click=${() => this._set({ per_light: Object.fromEntries(Object.entries(g.per_light).filter(([k]) => k !== l.entity_id)) })}>${t('glow.like_all')}</button>`
                      : html`<button class="btn small plain" @click=${() => this._set({ per_light: { ...g.per_light, [l.entity_id]: g.brightness } })}>${t('glow.own_pct', { n: g.brightness })}</button>`
                    : nothing}
                </div>`;
              })
            : html`<p class="rl-note">${t('glow.no_lamps')}</p>`}
        </div>
      </div>
      <div class="rl-sec">
        <h3>${t('glow.color')}</h3>
        <div class="rl-box">
          <div class="seg" role="radiogroup" aria-label=${t('glow.color')}>
            <button role="radio" aria-pressed=${byRules ? 'true' : 'false'} @click=${() => this._set({ color: 'rules' })}>${t('glow.c_rules')}</button>
            <button role="radio" aria-pressed=${byRules ? 'false' : 'true'} @click=${() => byRules && this._set({ color: 'k:2200' })}>${t('glow.c_own')}</button>
          </div>
          ${byRules
            ? html`<small>${t('glow.c_rules_sub', { room: room.name })}</small>`
            : swatches(g.color, (c) => this._set({ color: c }))}
        </div>
      </div>
      <hr-live-toggle .store=${this.store} .lights=${g.lights} .setting=${{ brightness: g.brightness, color: byRules ? this._rulesColour(room.id, g.lights) : g.color }} .perLight=${Object.fromEntries(Object.entries(g.per_light).map(([e, b]) => [e, { brightness: b }]))}></hr-live-toggle>
      ${offs.length
        ? html`<div class="rl-sec">
            <h3>${t('glow.only_off')}</h3>
            <div class="rl-box">
              ${offs.map((d) => {
                const on = g.only_off.includes(d.entity_id);
                return html`<label class="chk"><input type="checkbox" .checked=${on} @change=${() => this._set({ only_off: on ? g.only_off.filter((x) => x !== d.entity_id) : [...g.only_off, d.entity_id] })} />${t('glow.while_off', { name: d.name })}</label>`;
              })}
            </div>
            <p class="rl-note">${t('glow.when_global')}</p>
          </div>`
        : html`<p class="rl-note">${t('glow.when_global')}</p>`}
      ${made.length
        ? html`<div class="rl-info warn">
            <span>${t('glow.handmade', { names: made.map((r) => r.name).join(', ') })}</span>
          </div>
          <label class="chk"><input type="checkbox" .checked=${this._replace} @change=${() => (this._replace = !this._replace)} />${t('glow.replace')}</label>`
        : nothing}
      ${g.on && (!g.sources.length || !g.lights.length) ? html`<div class="rl-info warn"><span>${t('glow.incomplete')}</span></div>` : nothing}
      <button slot="foot" class="btn" @click=${() => this._close()}>${t('common.cancel')}</button>
      <button slot="foot" class="btn primary" @click=${() => this._save()}>${t('common.save')}</button>
    </hr-pop>`;
  }

  /** the doors with a sensor that border on the room: someone behind it and the door open makes it glow */
  private _doorSec(room: Room, g: LightGlow) {
    const doors = doorsOf(this._floors, room.id);
    const name = (rid: string) => this.store.rooms.find((r) => r.id === rid)?.name ?? rid;
    type Way = 'both' | 'door' | 'occ' | 'off';
    const mine = (d: MapDoor, other: string) => (s: LightGlow['sources'][number]) => s.door === d.entity || (s.room === other && !s.door && s.by === 'occupied');
    const way = (d: MapDoor, other: string): Way => {
      const s = g.sources.find(mine(d, other));
      if (!s) return 'off';
      if (!s.door) return 'occ';
      if (s.by === 'door') return 'door';
      return s.by === 'occupied' && s.door_state !== 'closed' ? 'both' : 'off';
    };
    const set = (d: MapDoor, other: string, w: Way) => {
      const rest = g.sources.filter((s) => !mine(d, other)(s));
      const add: Record<Exclude<Way, 'off'>, LightGlow['sources'][number]> = {
        both: { room: other, by: 'occupied', door: d.entity, door_state: 'open' },
        door: { room: other, by: 'door', door: d.entity, door_state: 'open' },
        occ: { room: other, by: 'occupied', door: null, door_state: 'open' },
      };
      this._set({ sources: w === 'off' ? rest : [...rest, add[w]] });
    };
    return html`<div class="rl-sec">
      <h3>${t('glow.doors_title')}</h3>
      <div class="rl-box">
        ${doors.length
          ? doors.map(({ door, other }) => {
              const w = way(door, other);
              return html`<div class="src">
                <div class="line"><b>${door.name}</b><span class="muted">→ ${name(other)}</span></div>
                <div class="seg wrap" role="radiogroup" aria-label=${door.name}>
                  ${(['both', 'door', 'occ', 'off'] as const).map(
                    (x) => html`<button role="radio" aria-pressed=${w === x ? 'true' : 'false'} @click=${() => set(door, other, x)}>${t(`glow.way_${x}`, { room: name(other) })}</button>`,
                  )}
                </div>
              </div>`;
            })
          : html`<p class="rl-note">${t('glow.no_doors', { room: room.name })}</p>`}
      </div>
      <p class="rl-note">${t('glow.doors_note', { room: room.name })}</p>
    </div>`;
  }

  override render() {
    const room = this.store.rooms.find((r) => r.id === this._room);
    return html`${this._mapPop()} ${room && this._draft ? this._roomPop(room, this._draft) : nothing}`;
  }
}
customElements.define('hr-light-glow', HrLightGlow);
