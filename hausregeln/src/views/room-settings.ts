/**
 * <hr-room-settings>: "Raum einstellen" – the one pop-up for a room's basics, opened from Räume, Licht and Heizung
 * (event "hr-room-settings" { id }, see panel.ts): which sensors tell whether someone is there (presence, motion,
 * zones, doors, also from other rooms), doors that make the room briefly occupied, when it counts as empty, the door
 * logic and when it is dark here. Nothing about light or heating (those pages have their own settings).
 * Every change is saved at once (store.saveRoom). Fires "close".
 */
import { css, html, nothing } from 'lit';
import { mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiChevronRight, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import { durationStepper } from '../components/duration';
import type { Room, RoomDark } from '../model';
import { sinceText } from '../describe';
import { fixButton, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { KINDS } from '../vocabulary';
import '../components/pop';
import { t, type I18nKey } from '../i18n';
// i18n: complete

type SensorList = 'presence' | 'motion' | 'doors' | 'zones';

/** sensor lists of a room; texts: rooms.list_<key>, rooms.list_<key>_none, rooms.list_<key>_help */
const LISTS: { key: SensorList; kind: string }[] = [
  { key: 'presence', kind: 'presence' },
  { key: 'motion', kind: 'motion' },
  { key: 'zones', kind: 'zone' },
  { key: 'doors', kind: 'door' },
];
const listText = (key: SensorList, part: '' | '_none' | '_help') => (key === 'zones' && part === '_none' ? '' : t(`rooms.list_${key}${part}` as I18nKey));

/** shared look of the round −/+ steppers in pop-ups */
export const stepperStyles = css`
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--hr-space-2);
  }
  .stepper output {
    min-width: 64px;
    text-align: center;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .stepper button {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--hr-fill);
    font-size: 20px;
  }
  .stepper button[disabled] {
    opacity: 0.4;
  }
`;

export class HrRoomSettings extends StoreElement {
  static override properties = { ...StoreElement.properties, roomId: { type: String }, _more: { state: true }, _doors: { state: true } };
  declare roomId: string;
  declare _more: boolean;
  /** the door picker of "Tür öffnet → Raum kurz belegt" is open */
  declare _doors: boolean;

  constructor() {
    super();
    this._more = false;
    this._doors = false;
  }

  static override styles = [
    shared,
    kit,
    stepperStyles,
    css`
      .rl-item .box {
        color: var(--hr-label-3);
        display: flex;
      }
      .rl-item .box.on {
        color: var(--hr-accent);
      }
      .rl-item .dot {
        flex: none;
      }
      .rl-item.fix {
        padding-right: var(--hr-space-2);
      }
      .rl-box input[type='time'] {
        font: inherit;
        min-height: 36px;
        padding: 4px 8px;
        border-radius: 8px;
        border: 1px solid var(--hr-separator);
        background: var(--hr-surface);
        color: var(--hr-label);
      }
      .times {
        display: flex;
        gap: var(--hr-space-3);
        flex-wrap: wrap;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .add {
        align-self: flex-start;
      }
    `,
  ];

  private get room(): Room | undefined {
    return this.store.room(this.roomId);
  }

  private _save(patch: Partial<Room>) {
    const r = this.room;
    if (r) this.store.saveRoom({ ...r, ...patch });
  }

  private _toggle(list: SensorList, id: string) {
    const r = this.room!;
    const cur = r[list];
    this._save({ [list]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } as Partial<Room>);
  }

  private _close = () => this.dispatchEvent(new CustomEvent('close'));

  private _sensors(room: Room) {
    const s = this.store;
    return LISTS.map((l) => {
      const mine = s.devices.filter((d) => d.kind === l.kind && d.room === room.id);
      const others = s.devices.filter((d) => d.kind === l.kind && d.room !== room.id && room[l.key].includes(d.entity_id));
      const list = [...mine, ...others];
      if (!list.length && l.key === 'zones') return nothing;
      return html`<div class="rl-sec">
        <h3>${listText(l.key, '')}</h3>
        <div class="rl-list">
          ${list.length
            ? list.map((d) => {
                const on = room[l.key].includes(d.entity_id);
                const active = d.state === 'on';
                return html`<div class="rl-item fix">
                  <button class="main" @click=${() => this._toggle(l.key, d.entity_id)} aria-pressed=${on ? 'true' : 'false'}>
                    <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
                    <span class="grow"
                      ><b>${d.name}</b
                      ><small
                        >${d.room !== room.id ? `${s.room(d.room)?.name ?? t('rooms.no_room')} · ` : ''}${t(
                          d.state === 'unavailable' ? 'rooms.unavailable' : l.key === 'doors' ? (active ? 'rooms.door_open' : 'rooms.door_closed') : active ? 'rooms.sees_someone' : 'rooms.nobody',
                        )}</small
                      ></span
                    >
                    <span class="dot ${active ? 'warm' : ''}"></span>
                  </button>
                  ${s.admin ? fixButton(this, d.entity_id) : nothing}
                </div>`;
              })
            : html`<div class="rl-item"><small>${listText(l.key, '_none')}</small></div>`}
        </div>
        <p class="rl-note rl-lbl">${listText(l.key, '_help')}</p>
      </div>`;
    });
  }

  private _other(room: Room) {
    const s = this.store;
    if (!this._more) return html`<button class="btn small add" @click=${() => (this._more = true)}>${icon(mdiPlus, 16)}${t('rooms.add_other_sensor')}</button>`;
    return html`<div class="rl-sec">
      <h3>${t('rooms.other_sensors')}</h3>
      <div class="rl-list">
        ${s.devices
          .filter((d) => ['presence', 'motion', 'door'].includes(d.kind) && d.room !== room.id)
          .map((d) => {
            const key: SensorList = d.kind === 'presence' ? 'presence' : d.kind === 'motion' ? 'motion' : 'doors';
            const on = room[key].includes(d.entity_id);
            return html`<button class="rl-item" @click=${() => this._toggle(key, d.entity_id)} aria-pressed=${on ? 'true' : 'false'}>
              <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
              <span class="grow"><b>${d.name}</b><small>${KINDS[d.kind]?.label} · ${s.room(d.room)?.name ?? t('rooms.no_room')}</small></span>
            </button>`;
          })}
      </div>
    </div>`;
  }

  /** "door opens → room briefly occupied": any door of the house, picked in a pop-up of its own */
  private _pulse(room: Room) {
    const s = this.store;
    const mine = room.door_pulse ?? [];
    const names = mine.map((id) => s.device(id)?.name ?? id);
    return html`<div class="rl-box">
      <div class="line">
        <span class="grow"><b>${t('rooms.pulse_title')}</b><small>${names.length ? names.join(', ') : t('rooms.pulse_none_chosen')}</small></span>
        <button class="btn small" @click=${() => (this._doors = true)}>${t('rooms.pulse_choose')}${icon(mdiChevronRight, 16)}</button>
      </div>
      ${mine.length
        ? html`<div class="line">
            <span class="grow"><b>${t('rooms.pulse_for')}</b></span>
            ${durationStepper((room.door_pulse_for ?? 30) / 60, (v) => this._save({ door_pulse_for: Math.max(5, Math.round(v * 60)) }), 5 / 60, 10)}
          </div>`
        : nothing}
    </div>`;
  }

  private _doorPicker(room: Room) {
    const s = this.store;
    const doors = s.devices.filter((d) => d.kind === 'door');
    const mine = room.door_pulse ?? [];
    const toggle = (id: string) => this._save({ door_pulse: mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id] });
    return html`<hr-pop narrow heading=${t('rooms.pulse_title')} .sub=${t('rooms.pulse_multi')} @close=${() => (this._doors = false)}>
      <div class="rl-list">
        ${doors.length
          ? doors.map((d) => {
              const on = mine.includes(d.entity_id);
              return html`<button class="rl-item" @click=${() => toggle(d.entity_id)} aria-pressed=${on ? 'true' : 'false'}>
                <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
                <span class="grow"><b>${d.name}</b><small>${s.room(d.room)?.name ?? t('rooms.no_room')}</small></span>
              </button>`;
            })
          : html`<div class="rl-item"><small>${t('rooms.pulse_none')}</small></div>`}
      </div>
      <p class="rl-note">${t('rooms.pulse_help')}</p>
      <button slot="foot" class="btn primary" @click=${() => (this._doors = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _empty(room: Room) {
    return html`<div class="rl-sec">
      <h3>${t('rooms.when_empty')}</h3>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('rooms.empty_after_title')}</b><small>${t('rooms.empty_after_help')}</small></span>
          ${durationStepper(room.empty_after, (v) => this._save({ empty_after: Math.max(0, v) }), 0, 60)}
        </div>
        <div class="line">
          <span class="grow"><b>${t('rooms.door_logic')}</b><small>${t('rooms.door_logic_help')}</small></span>
          <button class="switch" role="switch" aria-label=${t('rooms.door_logic')} aria-checked=${room.door_logic ? 'true' : 'false'} @click=${() => this._save({ door_logic: !room.door_logic })}></button>
        </div>
      </div>
      ${this._pulse(room)}
    </div>`;
  }

  /** the dark signal: light sensor, sun, evening window – dark at once, bright only after a while */
  private _dark(room: Room) {
    const s = this.store;
    const lux = room.lux ? s.device(room.lux) : undefined;
    const d: RoomDark = { sun: null, from: '', to: '', margin: 50, bright_for: 10, lux_when: 'lights_off', ...room.dark };
    const set = (patch: Partial<RoomDark>) => this._save({ dark: { ...d, ...patch } });
    const o = s.occupancy[room.id];
    const why = (o?.dark_why ?? []).map((w) => t(`rooms.why_${w}` as I18nKey)).join(', ');
    const state = !o?.dark ? t('rooms.dark_state_bright') : why ? t('rooms.dark_state_dark', { why }) : t('rooms.dark_state_held');
    const below = room.dark_below ?? 80;
    const timeOn = !!(d.from && d.to);
    return html`<div class="rl-sec">
      <h3>${t('rooms.dark_title')}</h3>
      <div class="rl-box">
        <div class="line"><span class="grow"><b>${state}</b>${lux ? html`<small>${t('rooms.dark_sensor', { name: lux.name, value: lux.detail ?? lux.state })}</small>` : html`<small>${t('rooms.dark_no_sensor')}</small>`}</span></div>
        ${lux
          ? html`<div class="line">
                <span class="grow"><b>${t('rooms.dark_below')}</b><small>${t(Number(lux.state) < below ? 'rooms.dark_now' : 'rooms.bright_now', { value: lux.detail ?? lux.state })}</small></span>
                <span class="stepper">
                  <button aria-label=${t('rooms.less')} @click=${() => this._save({ dark_below: Math.max(0, below - 10) })}>−</button>
                  <output>${below} lx</output>
                  <button aria-label=${t('rooms.more')} @click=${() => this._save({ dark_below: below + 10 })}>+</button>
                </span>
              </div>
              <div class="line">
                <span class="grow"><b>${t('rooms.dark_margin')}</b><small>${t('rooms.dark_margin_help', { lux: Math.round(below * (1 + d.margin / 100)) })}</small></span>
                <span class="stepper">
                  <button aria-label=${t('rooms.less')} @click=${() => set({ margin: Math.max(0, d.margin - 10) })}>−</button>
                  <output>+${d.margin} %</output>
                  <button aria-label=${t('rooms.more')} @click=${() => set({ margin: Math.min(500, d.margin + 10) })}>+</button>
                </span>
              </div>
              <div class="line">
                <span class="grow"><b>${t('rooms.dark_lux_off')}</b><small>${t('rooms.dark_lux_off_help')}</small></span>
                <button class="switch" role="switch" aria-label=${t('rooms.dark_lux_off')} aria-checked=${d.lux_when === 'lights_off' ? 'true' : 'false'} @click=${() => set({ lux_when: d.lux_when === 'lights_off' ? 'always' : 'lights_off' })}></button>
              </div>`
          : nothing}
        <div class="line">
          <span class="grow"><b>${t('rooms.dark_sun')}</b><small>${t(d.sun === null ? 'rooms.dark_sun_help_off' : 'rooms.dark_sun_help')}</small></span>
          <span class="stepper">
            <button aria-label=${t('rooms.less')} ?disabled=${d.sun === null} @click=${() => set({ sun: d.sun !== null && d.sun > -6 ? d.sun - 1 : null })}>−</button>
            <output>${d.sun === null ? t('rooms.dark_sun_off') : `${d.sun}°`}</output>
            <button aria-label=${t('rooms.more')} @click=${() => set({ sun: d.sun === null ? 3 : Math.min(30, d.sun + 1) })}>+</button>
          </span>
        </div>
        <div class="line">
          <span class="grow"><b>${t('rooms.dark_time')}</b><small>${t('rooms.dark_time_help')}</small></span>
          <button class="switch" role="switch" aria-label=${t('rooms.dark_time')} aria-checked=${timeOn ? 'true' : 'false'} @click=${() => set(timeOn ? { from: '', to: '' } : { from: '20:00', to: '06:00' })}></button>
          ${timeOn
            ? html`<div class="times">
                <label>${t('rooms.dark_from')} <input type="time" .value=${d.from} @change=${(e: Event) => set({ from: (e.target as HTMLInputElement).value })} /></label>
                <label>${t('rooms.dark_to')} <input type="time" .value=${d.to} @change=${(e: Event) => set({ to: (e.target as HTMLInputElement).value })} /></label>
              </div>`
            : nothing}
        </div>
        <div class="line">
          <span class="grow"><b>${t('rooms.dark_bright_for')}</b><small>${t('rooms.dark_bright_for_help')}</small></span>
          ${durationStepper(d.bright_for, (v) => set({ bright_for: v }), 0, 120)}
        </div>
      </div>
      <p class="rl-note rl-lbl">${t('rooms.dark_help')}</p>
    </div>`;
  }

  override render() {
    const room = this.room;
    if (!room) return nothing;
    const o = this.store.occupancy[room.id];
    const sub = o?.occupied ? t('rooms.occupied_since', { time: sinceText(o.since) }) : o ? t('rooms.empty_since', { time: sinceText(o.since) }) : '';
    return html`<hr-pop heading=${t('rooms.settings_title', { room: room.name })} .sub=${sub} @close=${this._close}>
        <p class="rl-note">${t('rooms.settings_lead')}</p>
        ${this._sensors(room)} ${this._other(room)} ${this._empty(room)} ${this._dark(room)}
        <button slot="foot" class="btn primary" @click=${this._close}>${t('common.done')}</button>
      </hr-pop>
      ${this._doors ? this._doorPicker(room) : nothing}`;
  }
}
customElements.define('hr-room-settings', HrRoomSettings);
