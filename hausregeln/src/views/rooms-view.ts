/**
 * <hr-rooms-view>: the area "Räume". Equal room tiles (shared order, hidden ones left out, see room-arrange.ts):
 * occupied or empty since when, who was seen, today's occupancy as a bar, the room's sensors. A tile opens the room
 * pop-up (hr-room-detail via "hr-open-room"). The page gear holds "Räume anordnen" and the robot vacuum pause.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiAlertCircleOutline, mdiChevronRight, mdiFloorPlan, mdiRobotVacuum } from '@mdi/js';
import { StoreElement } from '../base';
import { formatSeconds } from '../components/duration';
import type { Room } from '../model';
import type { Store } from '../store';
import { sinceText } from '../describe';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { featureHint } from '../components/feature';
import { registerPage } from '../components/page';
import { hiddenRoomsNote } from '../components/room-arrange';
import { roomStyles, sensorChips, timeline } from './room-common';
import '../components/pop';
import '../components/room-arrange';
import './home-extras';
import { fmtTime, t, tn } from '../i18n';
// i18n: complete

/** "1 von 5 Räumen belegt · Wohnzimmer seit 26 Min." */
function roomsSub(s: Store): TemplateResult | string {
  const busy = s.rooms.filter((r) => s.occupancy[r.id]?.occupied);
  const first = busy[0];
  const o = first ? s.occupancy[first.id] : undefined;
  return html`<b>${tn('rooms.sub_busy', busy.length, { all: s.rooms.length })}</b>${first && o ? ` · ${t('rooms.sub_since', { room: first.name, time: sinceText(o.since) })}` : ''}`;
}

registerPage('rooms', { sub: roomsSub, gear: true, plan: true });

export class HrRoomsView extends StoreElement {
  static override properties = { ...StoreElement.properties, _gear: { state: true }, _arrange: { state: true }, _vacuum: { state: true } };
  declare _gear: boolean;
  declare _arrange: boolean;
  declare _vacuum: boolean;

  constructor() {
    super();
    this._gear = false;
    this._arrange = false;
    this._vacuum = false;
  }

  /** the page gear in the panel's head */
  openGear(): void {
    this._gear = true;
  }

  static override styles = [
    shared,
    kit,
    roomStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .lead {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
      }
      .rl-tile.occupied {
        overflow: hidden;
      }
      .rl-tile.occupied::before {
        content: '';
        position: absolute;
        inset: -40% -20% auto auto;
        width: 70%;
        aspect-ratio: 1;
        border-radius: 50%;
        background: radial-gradient(circle, color-mix(in srgb, var(--hr-glow) 70%, transparent), transparent 70%);
        opacity: 0.75;
        pointer-events: none;
      }
      .big {
        font-size: var(--hr-text-title3);
        font-weight: 700;
        letter-spacing: -0.02em;
        position: relative;
      }
      .rl-tile.occupied .big {
        color: color-mix(in srgb, var(--hr-orange) 80%, var(--hr-label));
      }
      .big small {
        display: block;
        font-size: var(--hr-text-footnote);
        font-weight: 500;
        color: var(--hr-label-2);
        letter-spacing: 0;
      }
      .note {
        display: flex;
        gap: 6px;
        font-size: var(--hr-text-footnote);
        color: color-mix(in srgb, var(--hr-orange) 75%, var(--hr-label));
      }
      .status {
        position: relative;
        margin: calc(-1 * var(--hr-space-2)) 0 0;
      }
    `,
  ];

  private _tile(room: Room) {
    const s = this.store;
    const o = s.occupancy[room.id];
    const lux = room.lux ? s.device(room.lux) : undefined;
    const dark = lux && room.dark_below != null ? Number(lux.state) < room.dark_below : undefined;
    const status = o?.occupied
      ? o.empty_at
        ? html`<span class="rl-chip warm">${t('rooms.soon_empty')}</span>`
        : html`<span class="rl-chip warm"><span class="dot warm"></span>${t('rooms.occupied')}</span>`
      : html`<span class="rl-chip">${t('rooms.empty')}</span>`;
    return html`<div class="rl-tile small ${o?.occupied ? 'occupied lit' : ''}">
      <button class="rl-open" aria-label=${room.name} @click=${() => fire(this, 'hr-open-room', { id: room.id })}></button>
      <div class="top">
        <span class="rl-ic small">${icon(room.icon, 20)}</span>
        <span class="grow"><h2>${room.name}</h2></span>
      </div>
      <div class="status">${status}</div>
      <div class="big">
        ${o ? t('rooms.since', { time: sinceText(o.since) }) : '–'}
        <small
          >${o?.occupied
            ? o.empty_at
              ? t('rooms.empty_at', { time: fmtTime(o.empty_at * 1000), delay: formatSeconds(room.empty_after * 60) })
              : o.by
                ? t('rooms.detected_by', { by: o.by })
                : t('rooms.someone_there')
            : room.empty_after
              ? t('rooms.empty_after', { delay: formatSeconds(room.empty_after * 60) })
              : t('rooms.empty_at_once')}</small
        >
      </div>
      ${timeline(s.today(room.id))}
      <div class="foot">
        <span class="rl-chips">${sensorChips(room)}${lux ? html`<span class="rl-chip">${lux.detail}${dark ? t('rooms.dark_suffix') : ''}</span>` : nothing}</span>
      </div>
      ${!room.presence.length && !room.motion.length
        ? html`<div class="note">${icon(mdiAlertCircleOutline, 16)}<span>${t(room.door_logic ? 'rooms.no_presence_sensor_doors' : 'rooms.no_presence_sensor')}</span></div>`
        : nothing}
    </div>`;
  }

  private _vacuums(): boolean {
    const s = this.store;
    return s.devices.some((d) => d.kind === 'vacuum') || (s.cleaning?.vacuums.length ?? 0) > 0;
  }

  /** the page gear: arrange the room tiles, the robot vacuum pause */
  private _gearPop() {
    const s = this.store;
    const c = s.cleaning;
    const vac = this._vacuums();
    return html`<hr-pop narrow heading=${t('rooms.gear_title')} .sub=${t('rooms.gear_sub')} @close=${() => (this._gear = false)}>
      <div class="rl-list">
        <button class="rl-item" @click=${() => ((this._gear = false), (this._arrange = true))}>
          <span class="ico">${icon(mdiFloorPlan, 20)}</span>
          <span class="grow"><b>${t('arrange.title')}</b><small>${tn('rooms.gear_arrange_sub', s.hiddenRooms('rooms').length)}</small></span>
          <span class="go">${icon(mdiChevronRight, 20)}</span>
        </button>
        ${vac
          ? html`<button class="rl-item" @click=${() => ((this._gear = false), (this._vacuum = true))}>
              <span class="ico">${icon(mdiRobotVacuum, 20)}</span>
              <span class="grow"
                ><b>${t('rooms.vacuum_pause')}</b
                ><small>${!s.on('vacuum') ? t('common.off') : c?.on && c.vacuums.length ? (c.active ? t('home.vac_cleaning') : t('home.vac_paused_while')) : t('home.vac_not_linked')}</small></span
              >
              <span class="go">${icon(mdiChevronRight, 20)}</span>
            </button>`
          : nothing}
      </div>
      <button slot="foot" class="btn primary" @click=${() => (this._gear = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _vacuumPop() {
    const s = this.store;
    return html`<hr-pop heading=${t('rooms.vacuum_pause')} .sub=${t('rooms.vacuum_sub')} @close=${() => (this._vacuum = false)}>
      ${s.on('vacuum') ? html`<hr-home-extras .store=${s}></hr-home-extras>` : featureHint(this, 'vacuum')}
      <button slot="foot" class="btn primary" @click=${() => (this._vacuum = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    return html`
      <p class="lead">${t('rooms.lead')}</p>
      <div class="rl-grid">${s.orderedRooms('rooms').map((r) => this._tile(r))}</div>
      ${hiddenRoomsNote(s, 'rooms', () => (this._arrange = true))}
      ${this._gear ? this._gearPop() : nothing} ${this._vacuum ? this._vacuumPop() : nothing}
      ${this._arrange ? html`<hr-room-arrange page="rooms" .store=${s} @close=${() => (this._arrange = false)}></hr-room-arrange>` : nothing}
    `;
  }
}
customElements.define('hr-rooms-view', HrRoomsView);
