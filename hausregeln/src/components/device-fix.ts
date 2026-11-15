/**
 * <hr-device-fix>: "Erkannt als … – ändern / nicht verwenden" for one entity, and adding a device by hand.
 * Every change goes to the one central override store (house_rules/devices/set) and so counts everywhere:
 * alarm, window warning, heating, light, rooms, rules.
 *   .entityId set, device known      → what was detected, kind / room / name / icon, "Nicht verwenden", "Zurücksetzen"
 *   .entityId set, excluded / vehicle → why it is not used, "Wieder verwenden" / "Als … verwenden"
 *   no .entityId (or not sorted)     → pick any entity, then kind, room, name, icon → "Hinzufügen"
 * Fires "done" after adding or removing.
 */
import { css, html, nothing } from 'lit';
import { mdiCarOutline, mdiEyeOffOutline, mdiMagnify, mdiRestore } from '@mdi/js';
import { StoreElement } from '../base';
import type { DeviceChange } from '../model';
import { fire, icon, shared } from '../design/shared';
import { KINDS } from '../vocabulary';
import { t } from '../i18n';
// i18n: complete

/** kinds a device of the house can have (core.KINDS_OK) */
export const DEVICE_KINDS = ['light', 'door', 'window', 'motion', 'presence', 'zone', 'climate', 'cover', 'media', 'switch', 'outlet', 'fan', 'purifier', 'leak', 'temperature', 'illuminance', 'lock', 'vacuum', 'script', 'vehicle'];

/** common mdi icons, for the picker when Home Assistant's own ha-icon-picker is not loaded */
const ICONS = [
  'lightbulb', 'ceiling-light', 'floor-lamp', 'lamp', 'led-strip-variant', 'door', 'door-open', 'door-sliding', 'garage', 'garage-open', 'gate',
  'window-closed-variant', 'window-open-variant', 'motion-sensor', 'account-eye', 'vibrate', 'water-alert', 'thermometer', 'radiator', 'fan',
  'air-purifier', 'blinds', 'roller-shade', 'curtains', 'speaker', 'television', 'power-socket-de', 'toggle-switch', 'lock', 'lock-open',
  'robot-vacuum', 'robot-mower', 'car', 'car-electric', 'bicycle', 'motorbike', 'scooter', 'map-marker', 'shield-home', 'cctv', 'bell',
  'doorbell', 'mailbox', 'flower', 'sprinkler', 'greenhouse', 'home-city-outline', 'washing-machine', 'tumble-dryer', 'dishwasher', 'fridge',
  'stove', 'coffee-maker', 'kettle', 'desk-lamp', 'bed', 'sofa', 'shower', 'toilet', 'pool', 'solar-power', 'battery', 'ev-station', 'flash',
].map((n) => `mdi:${n}`); // prettier-ignore

export class HrDeviceFix extends StoreElement {
  static override properties = { ...StoreElement.properties, entityId: { attribute: 'entity-id' }, noHide: { type: Boolean }, _pick: { state: true }, _q: { state: true }, _draft: { state: true } };
  declare entityId: string;
  /** without its own "Nicht verwenden" (the device pop-up has one in its footer) */
  declare noHide: boolean;
  declare _pick: string;
  declare _q: string;
  declare _draft: { kind: string; room: string; name: string; icon: string };

  constructor() {
    super();
    this.entityId = '';
    this.noHide = false;
    this._pick = '';
    this._q = '';
    this._draft = { kind: '', room: '', name: '', icon: '' };
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      .detected {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        font-size: var(--hr-text-subhead);
      }
      .detected.off {
        background: color-mix(in srgb, var(--hr-orange) 10%, var(--hr-surface));
      }
      .detected .grow {
        flex: 1;
        min-width: 0;
      }
      .detected small {
        display: block;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      .fields {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
        gap: var(--hr-space-3);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      input,
      select {
        font: inherit;
        font-weight: 400;
        min-height: 40px;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--hr-separator);
        background: var(--hr-surface);
        color: var(--hr-label);
        min-width: 0;
      }
      .iconrow {
        display: flex;
        gap: var(--hr-space-2);
        align-items: center;
      }
      .iconrow input {
        flex: 1;
      }
      .iconrow .prev {
        width: 40px;
        height: 40px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: var(--hr-fill);
        flex: none;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      label.search {
        flex-direction: row;
        font-weight: 400;
      }
      .search {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        background: var(--hr-surface);
        border-radius: var(--hr-radius-m);
        padding: 0 var(--hr-space-4);
        color: var(--hr-label-2);
        box-shadow: var(--hr-shadow-1);
      }
      .search input {
        flex: 1;
        border: 0;
        background: none;
        outline: none;
        min-height: 44px;
      }
      .list {
        max-height: 320px;
        overflow-y: auto;
      }
      .row[aria-pressed='true'] {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), var(--hr-surface));
      }
      .hint {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin: 0;
      }
    `,
  ];

  private async _set(change: Omit<DeviceChange, 'entity_id'>, entityId = this.entityId) {
    try {
      await this.store.setDevices([{ entity_id: entityId, ...change }]);
    } catch (e) {
      fire(this, 'hr-toast', (e as Error).message);
    }
  }

  private _kindSelect(value: string, change: (kind: string) => void) {
    return html`<label
      >${t('devices.f_kind')}<select aria-label=${t('devices.f_kind')} @change=${(e: Event) => change((e.target as HTMLSelectElement).value)}>
        ${value ? nothing : html`<option value="" selected>${t('devices.f_choose')}</option>`}
        ${DEVICE_KINDS.map((k) => html`<option value=${k} ?selected=${k === value}>${KINDS[k]?.label ?? k}</option>`)}
      </select></label
    >`;
  }

  private _roomSelect(value: string | undefined | null, change: (room: string | null) => void) {
    return html`<label
      >${t('devices.f_room')}<select aria-label=${t('devices.f_room')} @change=${(e: Event) => change((e.target as HTMLSelectElement).value || null)}>
        <option value="" ?selected=${!value}>${t('devices.no_room')}</option>
        ${this.store.rooms.map((r) => html`<option value=${r.id} ?selected=${r.id === value}>${r.name}</option>`)}
      </select></label
    >`;
  }

  /** Home Assistant's icon picker when it is loaded, else a field with a list of common icons */
  private _iconField(value: string, change: (icon: string) => void) {
    const hass = (this.store as unknown as { hass?: unknown }).hass;
    if (hass && customElements.get('ha-icon-picker'))
      return html`<label
        >${t('devices.icon')}<ha-icon-picker .hass=${hass} .value=${value} @value-changed=${(e: CustomEvent<{ value: string }>) => change(e.detail.value || '')}></ha-icon-picker
      ></label>`;
    return html`<label
      >${t('devices.icon')}
      <span class="iconrow">
        <span class="prev">${value ? icon(value, 22) : nothing}</span>
        <input
          list="hr-icons"
          placeholder="mdi:…"
          .value=${value}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            change(!v ? '' : v.startsWith('mdi:') ? v : `mdi:${v}`);
          }}
        />
        <datalist id="hr-icons">${ICONS.map((i) => html`<option value=${i}></option>`)}</datalist>
      </span></label
    >`;
  }

  /** any entity of Home Assistant that is not a device yet (helpers, templates, sensors Hausregeln does not sort) */
  private _picker() {
    const q = this._q.trim().toLowerCase();
    const known = new Set(this.store.devices.map((d) => d.entity_id));
    const list = this.store
      .allEntities()
      .filter((e) => !known.has(e.entity_id) && (!q || `${e.name} ${e.entity_id}`.toLowerCase().includes(q)))
      .slice(0, 60);
    return html`<label class="search">${icon(mdiMagnify, 20)}<input placeholder=${t('devices.f_search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} /></label>
      <div class="group list">
        ${list.length
          ? list.map(
              (e) => html`<button class="row" aria-pressed=${this._pick === e.entity_id ? 'true' : 'false'} @click=${() => ((this._pick = e.entity_id), (this._draft = { ...this._draft, name: this._draft.name || e.name }))}>
                <span class="grow"><div class="title">${e.name}</div><div class="sub">${e.entity_id}${e.state ? ` · ${e.state}` : ''}</div></span>
              </button>`,
            )
          : html`<div class="row"><span class="grow sub">${t('devices.f_nothing')}</span></div>`}
      </div>`;
  }

  private _new(entityId: string) {
    const d = this._draft;
    const add = async () => {
      await this._set({ manual: true, kind: d.kind, room: d.room || null, name: d.name.trim(), icon: d.icon, hidden: false }, entityId);
      fire(this, 'hr-toast', t('devices.f_added'));
      this.dispatchEvent(new CustomEvent('done'));
    };
    return html`${entityId === this.entityId ? html`<p class="hint">${t('devices.f_not_sorted')}</p>` : nothing}
      <div class="fields">
        <label>${t('devices.f_name')}<input .value=${d.name} placeholder=${this.store.entity(entityId)?.name ?? ''} @input=${(e: Event) => (this._draft = { ...d, name: (e.target as HTMLInputElement).value })} /></label>
        ${this._kindSelect(d.kind, (kind) => (this._draft = { ...d, kind }))} ${this._roomSelect(d.room, (room) => (this._draft = { ...d, room: room ?? '' }))}
        ${this._iconField(d.icon, (ic) => (this._draft = { ...d, icon: ic }))}
      </div>
      <div class="actions"><button class="btn primary" ?disabled=${!entityId || !d.kind || !this.store.admin} @click=${add}>${t('common.add')}</button></div>`;
  }

  override render() {
    const s = this.store;
    const eid = this.entityId;
    if (!eid)
      return html`${this._picker()}
        ${this._pick ? this._new(this._pick) : html`<p class="hint">${t('devices.f_pick_first')}</p>`}`;
    const d = s.device(eid);
    const u = s.devicesUnused.find((x) => x.entity_id === eid);
    const admin = s.admin;
    if (u) {
      const kind = KINDS[u.kind]?.label ?? u.kind;
      return html`<div class="detected off">
          ${icon(u.reason === 'vehicle' ? mdiCarOutline : mdiEyeOffOutline, 22)}
          <span class="grow"
            >${u.reason === 'vehicle' ? t('devices.f_vehicle', { vehicle: u.vehicle ?? '', kind }) : t('devices.f_unused')}
            <small>${t('devices.f_detected', { kind })}${u.room ? ` · ${s.room(u.room)?.name ?? ''}` : ''}</small></span
          >
        </div>
        <div class="actions">
          ${u.reason === 'vehicle'
            ? html`<button class="btn tinted" ?disabled=${!admin} @click=${() => this._set({ kind: u.kind })}>${t('devices.f_use_anyway', { kind })}</button>`
            : html`<button class="btn tinted" ?disabled=${!admin} @click=${() => this._set({ hidden: false })}>${icon(mdiRestore, 18)}${t('devices.f_use_again')}</button>`}
        </div>`;
    }
    if (!d) return this._new(eid);
    const detected = KINDS[d.auto_kind ?? d.kind]?.label ?? d.kind;
    const autoRoom = d.auto_room !== undefined ? d.auto_room : d.room;
    const changed = !!(d.auto_kind !== undefined || d.auto_room !== undefined || d.auto_name || d.icon);
    return html`<div class="detected">
        <span class="grow"
          >${d.manual
            ? t('devices.f_manual')
            : html`${t('devices.f_detected_as')} <b>${detected}</b>${autoRoom ? html` ${t('devices.f_in')} <b>${s.room(autoRoom)?.name ?? ''}</b>` : ` ${t('devices.f_no_room')}`}.`}
          ${d.vehicle ? html`<small>${t('devices.f_vehicle_note', { vehicle: d.vehicle })}</small>` : nothing}
          ${changed && !d.manual ? html`<small>${t('devices.f_changed')}</small>` : nothing}</span
        >
      </div>
      <div class="fields">
        <label
          >${t('devices.f_name')}<input
            .value=${d.name}
            ?disabled=${!admin}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value.trim();
              this._set({ name: v === (d.auto_name ?? '') ? '' : v });
            }}
        /></label>
        ${this._kindSelect(d.kind, (kind) => this._set({ kind }))} ${this._roomSelect(d.room, (room) => this._set(room ? { room, no_room: false } : { room: null, no_room: true }))}
        ${this._iconField(d.icon ?? '', (ic) => this._set({ icon: ic }))}
      </div>
      <div class="actions">
        ${d.manual
          ? html`<button class="btn danger" ?disabled=${!admin} @click=${() => this._set({ reset: true }).then(() => this.dispatchEvent(new CustomEvent('done')))}>${t('devices.f_remove_own')}</button>`
          : html`${this.noHide ? nothing : html`<button class="btn" ?disabled=${!admin} @click=${() => this._set({ hidden: true })}>${icon(mdiEyeOffOutline, 18)}${t('devices.hide')}</button>`}
              ${changed ? html`<button class="btn plain" ?disabled=${!admin} @click=${() => this._set({ reset: true })}>${icon(mdiRestore, 18)}${t('devices.f_reset')}</button>` : nothing}`}
      </div>
      ${admin ? nothing : html`<p class="hint">${t('devices.f_admins')}</p>`}`;
  }
}
customElements.define('hr-device-fix', HrDeviceFix);
