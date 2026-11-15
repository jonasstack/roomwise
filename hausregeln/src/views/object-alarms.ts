/**
 * <hr-object-alarms>: "Weitere Alarme" in the alarm area – small alarms besides the house alarm (bike, car,
 * garage, garden shed, second building). Each has its own sensors, is armed on its own (by hand, with the house
 * alarm, by house mode) and sends its own message; switching off uses the house alarm's confirmation (hr-disarm).
 * Server side: objects.py; every object is also alarm_control_panel.alarm_<name> in Home Assistant.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiBellRing, mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiMagnify, mdiPlus, mdiShieldCheck, mdiShieldOffOutline, mdiTrashCanOutline } from '@mdi/js';
import { StoreElement } from '../base';
import type { ObjectAlarm, ObjectAlarmKind } from '../model';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { relTime } from '../describe';
import { t, type I18nKey } from '../i18n';
import '../components/disarm';
import '../components/sheet';
import '../components/pop';
// i18n: complete

/** kind, icon (name: alarm.oa_kind_<kind>) */
const KINDS: [ObjectAlarmKind, string][] = [
  ['bike', 'mdi:bicycle'],
  ['car', 'mdi:car'],
  ['garage', 'mdi:garage'],
  ['shed', 'mdi:greenhouse'],
  ['building', 'mdi:home-city-outline'],
  ['other', 'mdi:shield-outline'],
];
const KIND_LABEL = (k: ObjectAlarmKind) => t(`alarm.oa_kind_${k}` as I18nKey);
/** house modes (name: mode.<id>) */
const HOUSE = ['home', 'away', 'sleep', 'vacation', 'guests'];
const HOUSE_LABEL = (m: string) => t(`mode.${m}` as I18nKey);
/** entities that can report something for an object alarm */
const SENSOR_DOMAINS = /^(binary_sensor|device_tracker|lock|alarm_control_panel|sensor|event|input_boolean)\./;

export class HrObjectAlarms extends StoreElement {
  static override properties = { ...StoreElement.properties, compact: { type: Boolean }, _edit: { state: true }, _q: { state: true }, _disarm: { state: true } };
  /** only the alarms and their buttons (Alarm-Zentrale) */
  declare compact: boolean;
  declare _edit: string | null;
  declare _q: string;
  declare _disarm: { id: string; onlyAlarm: boolean } | null;

  constructor() {
    super();
    this._edit = null;
    this._q = '';
    this._disarm = null;
    this.compact = false;
  }

  static override styles = [
    shared,
    kit,
    css`
      /* pop-up bodies are flex columns: their parts keep their height and scroll instead of shrinking */
      hr-pop > * {
        flex-shrink: 0;
      }
      .rl-box .group {
        background: var(--hr-surface-2);
      }
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      .list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
        gap: var(--hr-space-3);
      }
      .obj {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        padding: var(--hr-space-4);
      }
      .obj .top {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        min-width: 0;
      }
      .obj .top .grow {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .obj small {
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      .tile {
        width: 44px;
        height: 44px;
        border-radius: 13px;
        display: grid;
        place-items: center;
        flex: none;
        background: var(--hr-fill);
        color: var(--hr-label-2);
      }
      .obj.armed .tile {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
      }
      .obj.triggered,
      .obj.pending {
        box-shadow: inset 0 0 0 2px var(--hr-red);
      }
      .obj.triggered .tile,
      .obj.pending .tile {
        background: color-mix(in srgb, var(--hr-red) 20%, transparent);
        color: var(--hr-red);
      }
      .acts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      .new {
        align-self: flex-start;
      }
      .ed {
        padding: var(--hr-space-5);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .label {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        margin-top: var(--hr-space-2);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
      }
      .chips button[aria-pressed='true'] {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
        font-weight: 600;
      }
      input,
      select {
        font: inherit;
        min-height: 40px;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--hr-separator);
        background: var(--hr-surface);
        color: var(--hr-label);
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
      }
      .scroll {
        max-height: 280px;
        overflow-y: auto;
      }
      .row .box {
        color: var(--hr-label-3, var(--hr-label-2));
      }
      .row .box.on {
        color: var(--hr-accent);
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin: 0;
      }
    `,
  ];

  private _name(eid: string): string {
    return this.store.device(eid)?.name ?? this.store.devicesUnused.find((u) => u.entity_id === eid)?.name ?? this.store.entity(eid)?.name ?? eid;
  }

  private async _save(patch: Partial<ObjectAlarm>) {
    try {
      return await this.store.objectSave(patch);
    } catch (e) {
      fire(this, 'hr-toast', (e as Error).message.replace(/^invalid: /, ''));
      return '';
    }
  }

  private async _new() {
    const id = await this._save({ kind: 'other', name: t('alarm.oa_new_name') });
    if (id) this._edit = id;
  }

  private async _arm(o: ObjectAlarm) {
    const res = await this.store.objectArm(o.id);
    if (!res.ok) fire(this, 'hr-toast', res.error === 'no_sensors' ? t('alarm.oa_no_sensors') : String(res.error));
  }

  private _card(o: ObjectAlarm) {
    const s = this.store;
    const alarm = o.state === 'triggered' || o.state === 'pending';
    const sub =
      alarm && o.cause_name
        ? `${o.label} · ${o.cause_name}`
        : `${o.label}${o.since ? ` · ${t('alarm.since', { time: relTime(new Date(o.since * 1000).toISOString()) })}` : ''}${o.by_auto ? ` · ${t('alarm.oa_auto')}` : ''}`;
    return html`<div class="card obj ${o.state}">
      <div class="top">
        <span class="tile">${icon(o.icon, 24)}</span>
        <span class="grow"><b>${o.name}</b><small>${sub}</small><small>${o.sensors.length ? o.sensors.map((e) => this._name(e)).join(', ') : t('alarm.oa_no_sensors_yet')}</small></span>
      </div>
      <div class="acts">
        ${o.state === 'disarmed'
          ? html`<button class="btn small tinted" ?disabled=${!o.sensors.length} @click=${() => this._arm(o)}>${icon(mdiShieldCheck, 18)}${t('alarm.oa_arm')}</button>`
          : html`${alarm ? html`<button class="btn small danger" @click=${() => (this._disarm = { id: o.id, onlyAlarm: true })}>${t('alarm.oa_only_this')}</button>` : nothing}
              <button class="btn small" @click=${() => (this._disarm = { id: o.id, onlyAlarm: false })}>${icon(mdiShieldOffOutline, 18)}${t('alarm.oa_disarm')}</button>`}
        ${s.haAdmin && !this.compact ? html`<button class="btn small plain" @click=${() => (this._edit = o.id)}>${t('alarm.oa_edit')}</button>` : nothing}
      </div>
    </div>`;
  }

  private _check(on: boolean, title: string, sub: string, toggle: () => void): TemplateResult {
    return html`<button class="row" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${toggle}>
      <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>
    </button>`;
  }

  private _toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  /** sensors: vehicle parts and fitting devices first, then any entity by search */
  private _sensors(o: ObjectAlarm) {
    const s = this.store;
    const q = this._q.trim().toLowerCase();
    const first = [
      ...s.devicesUnused.filter((u) => u.reason === 'vehicle').map((u) => ({ entity_id: u.entity_id, sub: t('alarm.oa_belongs', { vehicle: u.vehicle ?? '' }) })),
      ...s.devices.filter((d) => ['vehicle', 'motion', 'door', 'window', 'lock'].includes(d.kind)).map((d) => ({ entity_id: d.entity_id, sub: s.room(d.room)?.name ?? '' })),
    ];
    const seen = new Set(first.map((x) => x.entity_id));
    const more = q
      ? s
          .allEntities()
          .filter((e) => SENSOR_DOMAINS.test(e.entity_id) && !seen.has(e.entity_id) && `${e.name} ${e.entity_id}`.toLowerCase().includes(q))
          .map((e) => ({ entity_id: e.entity_id, sub: e.entity_id }))
      : [];
    const list = [...o.sensors.filter((e) => !seen.has(e) && !more.some((m) => m.entity_id === e)).map((e) => ({ entity_id: e, sub: e })), ...first.filter((x) => !q || `${this._name(x.entity_id)} ${x.entity_id}`.toLowerCase().includes(q)), ...more].slice(0, 80);
    return html`<label class="search">${icon(mdiMagnify, 20)}<input placeholder=${t('alarm.oa_search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} /></label>
      <div class="group scroll">
        ${list.length ? list.map((x) => this._check(o.sensors.includes(x.entity_id), this._name(x.entity_id), x.sub, () => this._save({ id: o.id, sensors: this._toggle(o.sensors, x.entity_id) }))) : html`<div class="row"><span class="grow sub">${t('alarm.oa_nothing')}</span></div>`}
      </div>
      <p class="note">${t('alarm.oa_sensors_note')}</p>`;
  }

  private _editor(o: ObjectAlarm) {
    const s = this.store;
    const save = (patch: Partial<ObjectAlarm>) => this._save({ id: o.id, ...patch });
    const persons = s.persons;
    const isP = (id: string) => o.notify.persons === 'everyone' || o.notify.persons.includes(id);
    const togP = (id: string) => {
      const next = this._toggle(o.notify.persons === 'everyone' ? persons.map((p) => p.id) : o.notify.persons, id);
      save({ notify: { ...o.notify, persons: next.length === persons.length ? 'everyone' : next } });
    };
    const sirens = [...s.extraEntities('siren'), ...s.devices.filter((d) => (d.kind === 'switch' || d.kind === 'outlet') && /sirene|siren/i.test(d.name)).map((d) => ({ entity_id: d.entity_id, name: d.name }))];
    const lights = s.devices.filter((d) => d.kind === 'light');
    const cams = s.extraEntities('camera');
    const auto = o.auto;
    const close = () => (this._edit = null);
    return html`<hr-pop heading=${o.name} .sub=${t('alarm.oa_ha_name', { name: o.name })} @close=${close}>
      <section class="rl-sec">
        <h3>${t('alarm.oa_what')}</h3>
        <div class="rl-box">
          <div class="chips">
            ${KINDS.map(([k, ic]) => html`<button aria-pressed=${o.kind === k ? 'true' : 'false'} @click=${() => save({ kind: k, icon: ic, ...(KINDS.some(([x]) => KIND_LABEL(x) === o.name) || o.name === t('alarm.oa_new_name') ? { name: KIND_LABEL(k) } : {}) })}>${icon(ic, 18)}${KIND_LABEL(k)}</button>`)}
          </div>
          <label class="label">${t('alarm.oa_name')} <input .value=${o.name} @change=${(e: Event) => save({ name: (e.target as HTMLInputElement).value })} /></label>
        </div>
      </section>
      <section class="rl-sec">
        <h3>${t('alarm.oa_sensors')}</h3>
        <div class="rl-box">${this._sensors(o)}</div>
      </section>
      <section class="rl-sec">
        <h3>${t('alarm.oa_arming')}</h3>
        <div class="rl-box">
          <div class="group">
            ${this._check(auto.with_alarm, t('alarm.oa_with_alarm'), t('alarm.oa_with_alarm_sub'), () => save({ auto: { ...auto, with_alarm: !auto.with_alarm } }))}
          </div>
          <span class="note">${t('alarm.oa_arm_on')}</span>
          <div class="chips">${HOUSE.map((m) => html`<button aria-pressed=${auto.arm_on.includes(m) ? 'true' : 'false'} @click=${() => save({ auto: { ...auto, arm_on: this._toggle(auto.arm_on, m), disarm_on: auto.disarm_on.filter((x) => x !== m) } })}>${HOUSE_LABEL(m)}</button>`)}</div>
          <span class="note">${t('alarm.oa_disarm_on')}</span>
          <div class="chips">${HOUSE.map((m) => html`<button aria-pressed=${auto.disarm_on.includes(m) ? 'true' : 'false'} @click=${() => save({ auto: { ...auto, disarm_on: this._toggle(auto.disarm_on, m), arm_on: auto.arm_on.filter((x) => x !== m) } })}>${HOUSE_LABEL(m)}</button>`)}</div>
          <div class="group">
            ${this._check(o.confirm, t('alarm.oa_confirm'), t('alarm.oa_confirm_sub'), () => save({ confirm: !o.confirm }))}
          </div>
          <label class="label"
            >${t('alarm.oa_delay')}
            <select @change=${(e: Event) => save({ delay: Number((e.target as HTMLSelectElement).value) })}>
              ${[0, 15, 30, 60, 120].map((v) => html`<option value=${v} ?selected=${o.delay === v}>${v ? t('alarm.oa_seconds', { n: v }) : t('alarm.oa_no_delay')}</option>`)}
            </select></label
          >
        </div>
      </section>
      <section class="rl-sec">
        <h3>${t('alarm.oa_who')}</h3>
        <div class="rl-box">
          <div class="group">${persons.length ? persons.map((p) => this._check(isP(p.id), p.name, p.phone ? '' : t('alarm.oa_no_app'), () => togP(p.id))) : html`<div class="row"><span class="grow sub">${t('alarm.no_persons')}</span></div>`}</div>
          <div class="group">${this._check(o.notify.critical, t('alarm.oa_critical'), t('alarm.oa_critical_sub'), () => save({ notify: { ...o.notify, critical: !o.notify.critical } }))}</div>
        </div>
      </section>
      ${sirens.length || lights.length || cams.length
        ? html`<section class="rl-sec">
            <h3>${t('alarm.oa_extras')}</h3>
            <div class="rl-box">
              ${sirens.length
                ? html`<span class="label">${t('alarm.oa_sirens')}</span>
                    <div class="group">${sirens.map((x) => this._check(o.sirens.includes(x.entity_id), x.name, '', () => save({ sirens: this._toggle(o.sirens, x.entity_id) })))}</div>`
                : nothing}
              ${lights.length
                ? html`<span class="label">${t('alarm.oa_lights')}</span>
                    <div class="chips">${lights.map((d) => html`<button aria-pressed=${o.lights.includes(d.entity_id) ? 'true' : 'false'} @click=${() => save({ lights: this._toggle(o.lights, d.entity_id) })}>${d.name}</button>`)}</div>`
                : nothing}
              ${cams.length
                ? html`<label class="label"
                    >${t('alarm.oa_camera')}
                    <select @change=${(e: Event) => save({ camera: (e.target as HTMLSelectElement).value })}>
                      <option value="" ?selected=${!o.camera}>${t('alarm.oa_no_camera')}</option>
                      ${cams.map((c) => html`<option value=${c.entity_id} ?selected=${o.camera === c.entity_id}>${c.name}</option>`)}
                    </select></label
                  >`
                : nothing}
            </div>
          </section>`
        : nothing}
      <button slot="foot" class="btn" @click=${() => s.objectTest(o.id).then(() => fire(this, 'hr-toast', t('alarm.test_alarm_sent')))}>${icon(mdiBellRing, 18)}${t('alarm.oa_test')}</button>
      <button
        slot="foot"
        class="btn danger"
        @click=${async () => {
          await s.objectDelete(o.id);
          this._edit = null;
        }}
      >
        ${icon(mdiTrashCanOutline, 18)}${t('alarm.oa_delete')}
      </button>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    const edit = this._edit ? s.objects.find((o) => o.id === this._edit) : undefined;
    return html`
      ${this.compact ? nothing : html`<p class="lead">${t('alarm.oa_lead')}</p>`}
      ${s.objects.length ? html`<div class="list">${s.objects.map((o) => this._card(o))}</div>` : nothing}
      ${s.haAdmin && !this.compact ? html`<button class="btn tinted new" @click=${() => this._new()}>${icon(mdiPlus, 18)}${t('alarm.oa_new')}</button>` : nothing}
      ${edit ? this._editor(edit) : nothing}
      ${this._disarm
        ? html`<hr-sheet width="440" label=${t('alarm.disarm_sheet')} @close=${() => (this._disarm = null)}>
            <hr-disarm .store=${s} .objectId=${this._disarm.id} ?onlyAlarm=${this._disarm.onlyAlarm} @done=${() => (this._disarm = null)} @close=${() => (this._disarm = null)}></hr-disarm>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('hr-object-alarms', HrObjectAlarms);
