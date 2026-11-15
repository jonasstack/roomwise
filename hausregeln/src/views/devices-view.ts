/**
 * <hr-devices-view>: the area "Geräte". Search, filter (Alle / In Regeln / Noch ohne Regel) and "Gerät hinzufügen";
 * the own groups as tiles; every device as an equal tile, grouped by room (shared room order, rooms hidden on this
 * page left out); devices that are not used. A device opens its pop-up (house-rules-device via "hr-open-device"),
 * a group the group editor. The page gear is "Räume anordnen".
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiCarOutline, mdiEyeOffOutline, mdiMagnify, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import type { Device } from '../model';
import type { Store } from '../store';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { KINDS } from '../vocabulary';
import { registerPage } from '../components/page';
import { hiddenRoomsNote } from '../components/room-arrange';
import '../components/pop';
import '../components/room-arrange';
import '../components/device-fix';
import { t, tn } from '../i18n';
// i18n: complete

const usedBy = (s: Store, d: Device) => s.usage(d.kind === 'zone' ? `zone:${d.entity_id}` : d.entity_id);

/** "63 Geräte · 41 in Regeln · 22 noch ohne Regel · 2 nicht verwendet" */
function devicesSub(s: Store): TemplateResult {
  const used = s.devices.filter((d) => usedBy(s, d).length > 0).length;
  return html`<b>${tn('devices.sub_count', s.devices.length)}</b> · ${t('devices.sub_used', { n: used })} · ${t('devices.sub_unused', { n: s.devices.length - used })}${s.devicesUnused.length
    ? ` · ${t('devices.sub_excluded', { n: s.devicesUnused.length })}`
    : ''}`;
}

registerPage('devices', { sub: devicesSub, gear: true });

export class HrDevicesView extends StoreElement {
  static override properties = { ...StoreElement.properties, _q: { state: true }, _only: { state: true }, _adding: { state: true }, _arrange: { state: true } };
  declare _adding: boolean;
  declare _arrange: boolean;
  declare _q: string;
  declare _only: 'all' | 'used' | 'unused';

  constructor() {
    super();
    this._q = '';
    this._only = 'all';
    this._adding = false;
    this._arrange = false;
  }

  /** the page gear in the panel's head: the groups are tiles on the page already, so only the room order */
  openGear(): void {
    this._arrange = true;
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-3);
        align-items: center;
      }
      .search {
        flex: 1 1 260px;
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
        font-size: var(--hr-text-body);
        color: var(--hr-label);
        min-width: 0;
      }
      .rl-tile.dev {
        min-height: 124px;
        padding: var(--hr-space-4);
        gap: var(--hr-space-2);
      }
      .rl-tile.dev h3 {
        font-size: var(--hr-text-body);
        line-height: 1.25;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
      }
      .rl-tile.dev .state {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rl-tile.on .rl-ic {
        background: color-mix(in srgb, var(--hr-yellow) 30%, transparent);
        color: color-mix(in srgb, var(--hr-orange) 80%, var(--hr-label));
      }
      .rl-tile.grp .names {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rl-tile.grp .rl-ic {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
      }
      .rl-tile.new {
        background: none;
        box-shadow: inset 0 0 0 1.5px var(--hr-separator);
      }
      .rl-chip.when {
        background: color-mix(in srgb, var(--hr-when) var(--hr-tint), transparent);
        color: var(--hr-label);
      }
      .rl-chip.then {
        background: color-mix(in srgb, var(--hr-then, var(--hr-accent)) var(--hr-tint), transparent);
        color: var(--hr-label);
      }
      .empty {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
      }
      .add-body {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
    `,
  ];

  private _tile(d: Device) {
    const s = this.store;
    const u = usedBy(s, d);
    const n = (as: string[]) => new Set(u.filter((x) => as.includes(x.as)).map((x) => x.rule.id)).size;
    const ha = s.automations.filter((a) => a.enabled && a.uses.some((x) => x.entity_id === d.entity_id)).length;
    const on = ['on', 'heat', 'playing'].includes(d.state);
    const state = `${KINDS[d.kind]?.label ?? d.kind}${d.detail ? ` · ${d.detail}` : ''}${d.state === 'unavailable' ? t('devices.unavailable_suffix') : ''}`;
    return html`<div class="rl-tile dev ${on ? 'on' : ''}">
      <button class="rl-open" aria-label=${d.name} @click=${() => fire(this, 'hr-open-device', { entity_id: d.entity_id })}></button>
      <div class="top">
        <span class="rl-ic small">${icon(d.icon ?? KINDS[d.kind]?.icon ?? '', 20)}</span>
        <span class="grow"><h3>${d.name}</h3><div class="state">${state}</div></span>
      </div>
      <div class="foot">
        <span class="rl-chips">
          ${n(['when']) ? html`<span class="rl-chip when" title=${t('devices.starts_title')}>${t('devices.starts_n', { n: n(['when']) })}</span>` : nothing}
          ${n(['then']) ? html`<span class="rl-chip then" title=${t('devices.switched_title')}>${t('devices.switched_n', { n: n(['then']) })}</span>` : nothing}
          ${ha ? html`<span class="rl-chip" title=${t('devices.ha_title')}>${t('devices.ha_n', { n: ha })}</span>` : nothing}
          ${!u.length && !ha ? html`<span class="rl-chip">${t('devices.no_rule_chip')}</span>` : nothing}
          ${d.manual ? html`<span class="rl-chip acc">${t('devices.added_by_you')}</span>` : d.auto_kind !== undefined ? html`<span class="rl-chip acc">${t('devices.corrected')}</span>` : nothing}
        </span>
      </div>
    </div>`;
  }

  private _groups() {
    const s = this.store;
    return html`<h2 class="rl-group-h">${t('devices.groups')}<span class="muted">${s.groups.length || ''}</span></h2>
      <div class="rl-grid four">
        ${s.groups.map((g) => {
          const members = g.members.map((e) => s.device(e)).filter(Boolean);
          const on = members.filter((d) => !['off', 'standby', 'closed', 'unavailable', 'docked'].includes(d!.state)).length;
          return html`<div class="rl-tile dev grp">
            <button class="rl-open" aria-label=${g.name} @click=${() => fire(this, 'hr-open-group', { group: g })}></button>
            <div class="top">
              <span class="rl-ic small">${icon(g.icon, 20)}</span>
              <span class="grow"><h3>${g.name}</h3><div class="state">${t('devices.group_count', { n: members.length, on })}</div></span>
            </div>
            <div class="names">${members.map((d) => d!.name).join(', ')}</div>
          </div>`;
        })}
        <div class="rl-tile dev new">
          <button class="rl-open" aria-label=${t('devices.new_group')} @click=${() => fire(this, 'hr-open-group', {})}></button>
          <div class="top">
            <span class="rl-ic small">${icon(mdiPlus, 20)}</span>
            <span class="grow"><h3>${t('devices.new_group')}</h3><div class="state">${t('devices.new_group_hint')}</div></span>
          </div>
        </div>
      </div>`;
  }

  override render() {
    const s = this.store;
    const q = this._q.trim().toLowerCase();
    const list = s.devices.filter(
      (d) =>
        (!q || `${d.name} ${KINDS[d.kind]?.label} ${s.room(d.room)?.name ?? ''} ${d.entity_id}`.toLowerCase().includes(q)) &&
        (this._only === 'all' || (this._only === 'used') === usedBy(s, d).length > 0),
    );
    const hidden = new Set(s.ui.room_hidden.devices ?? []);
    const sections = [
      ...s.orderedRooms('devices').map((r) => ({ id: r.id as string | undefined, name: r.name })),
      { id: undefined, name: t('devices.no_room') },
    ];
    const shown = sections.map((g) => ({ ...g, items: list.filter((d) => (g.id ? d.room === g.id : !d.room || !s.room(d.room))) })).filter((g) => g.items.length);
    // devices of hidden rooms still show up when searched for
    const fromHidden = q ? list.filter((d) => d.room && hidden.has(d.room)) : [];
    return html`
      <div class="tools">
        <button class="btn tinted" ?disabled=${!s.admin} @click=${() => (this._adding = true)}>${icon(mdiPlus, 18)}${t('devices.add')}</button>
        <label class="search">${icon(mdiMagnify, 20)}<input id="device-search" placeholder=${t('devices.search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} /></label>
        <div class="seg">
          <button aria-pressed=${this._only === 'all' ? 'true' : 'false'} @click=${() => (this._only = 'all')}>${t('common.all')}</button>
          <button aria-pressed=${this._only === 'used' ? 'true' : 'false'} @click=${() => (this._only = 'used')}>${t('devices.filter_used')}</button>
          <button aria-pressed=${this._only === 'unused' ? 'true' : 'false'} @click=${() => (this._only = 'unused')}>${t('devices.filter_unused')}</button>
        </div>
      </div>
      ${q ? nothing : this._groups()}
      ${shown.map(
        (g) => html`<h2 class="rl-group-h">${g.name}<span class="muted">${g.items.length}</span></h2>
          <div class="rl-grid four">${g.items.map((d) => this._tile(d))}</div>`,
      )}
      ${fromHidden.length
        ? html`<h2 class="rl-group-h">${t('devices.in_hidden_rooms')}<span class="muted">${fromHidden.length}</span></h2>
            <div class="rl-grid four">${fromHidden.map((d) => this._tile(d))}</div>`
        : nothing}
      ${!shown.length && !fromHidden.length ? html`<p class="empty">${t('devices.nothing_found')}</p>` : nothing}
      ${s.devicesUnused.length && !q
        ? html`<h2 class="rl-group-h">${t('devices.unused')}<span class="muted">${s.devicesUnused.length}</span></h2>
            <div class="rl-grid four">
              ${s.devicesUnused.map(
                (u) => html`<div class="rl-tile dev off">
                  <button class="rl-open" aria-label=${u.name} @click=${() => fire(this, 'hr-open-device', { entity_id: u.entity_id })}></button>
                  <div class="top">
                    <span class="rl-ic small">${icon(u.reason === 'vehicle' ? mdiCarOutline : mdiEyeOffOutline, 20)}</span>
                    <span class="grow"><h3>${u.name}</h3><div class="state">${KINDS[u.kind]?.label ?? u.kind}</div></span>
                  </div>
                  <div class="foot"><span class="rl-chip">${u.reason === 'vehicle' ? t('devices.part_of', { vehicle: u.vehicle ?? '' }) : t('devices.excluded_by_you')}</span></div>
                </div>`,
              )}
            </div>
            <p class="rl-note">${t('devices.unused_lead')}</p>`
        : nothing}
      ${hiddenRoomsNote(s, 'devices', () => (this._arrange = true))}
      ${this._adding
        ? html`<hr-pop heading=${t('devices.add')} .sub=${t('devices.add_lead')} @close=${() => (this._adding = false)}>
            <hr-device-fix .store=${s} @done=${() => (this._adding = false)}></hr-device-fix>
          </hr-pop>`
        : nothing}
      ${this._arrange ? html`<hr-room-arrange page="devices" .store=${s} @close=${() => (this._arrange = false)}></hr-room-arrange>` : nothing}
    `;
  }
}
customElements.define('hr-devices-view', HrDevicesView);
