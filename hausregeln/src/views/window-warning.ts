/**
 * <hr-window-warning>: settings of "Fenster-Warnung beim Gehen" (pop-up of the tile "Fenster-Warnung" in the alarm
 * area). First what happens in three steps, then the door, which windows,
 * only when the last one leaves, lights flashing red, the announcement on the alarm's speakers, a message,
 * how to acknowledge, and the one-time import of the floor plan card's own warning.
 */
import { css, html, nothing } from 'lit';
import { mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiImport, mdiWindowOpenVariant } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, fixButton, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import type { WindowWarningConfig } from '../model';
import { findEntryAlert } from '../setup/dashboard';
import { getLanguage, t, type I18nKey } from '../i18n';
// i18n: complete
import { assistantButton, autoAssistant } from '../assistant/base';

const MODES: WindowWarningConfig['announce']['mode'][] = ['none', 'general', 'all', 'sequential'];

export class HrWindowWarning extends StoreElement {
  static override properties = { ...StoreElement.properties, _card: { state: true } };
  declare _card: { entry: Record<string, unknown>; openings: Record<string, unknown>[]; dashboard: string } | null | undefined;

  constructor() {
    super();
    this._card = undefined;
  }

  static override styles = [
    shared,
    kit,
    css`
      :host > *,
      .rl-box > * {
        flex-shrink: 0;
      }
      .rl-box .group {
        background: var(--hr-surface-2);
      }
      ol.steps {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        counter-reset: s;
        padding: 0;
        margin: 0;
      }
      ol.steps li {
        list-style: none;
        display: flex;
        gap: var(--hr-space-3);
        align-items: flex-start;
        font-size: var(--hr-text-subhead);
      }
      ol.steps li::before {
        counter-increment: s;
        content: counter(s);
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: var(--hr-accent);
        color: var(--hr-on-accent);
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: 13px;
        flex: none;
      }
      ol.steps small {
        display: block;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      details.card {
        padding: 0;
      }
      summary {
        list-style: none;
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        cursor: pointer;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      summary .grow {
        flex: 1;
        min-width: 0;
      }
      summary .sub {
        display: block;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .inner {
        padding: 0 var(--hr-space-4) var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      .label {
        font-size: var(--hr-text-footnote);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--hr-label-2);
        margin: var(--hr-space-2) 0 0 var(--hr-space-1);
      }
      .box {
        color: var(--hr-accent);
        display: flex;
      }
      .box.off {
        color: var(--hr-label-3);
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 60px;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stepper button {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 18px;
      }
      input.text {
        width: 100%;
        min-height: 40px;
        padding: 0 var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        border: 0;
        background: var(--hr-fill);
      }
      .live {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
      }
      .live .ic {
        color: var(--hr-red);
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.4;
      }
      .row.wrap {
        flex-wrap: wrap;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    if (this._card === undefined) {
      this._card = null;
      findEntryAlert(this.store).then((c) => (this._card = c));
    }
  }

  /** fix: the entity of a found door / window, with "ändern / nicht verwenden" next to it (counts everywhere) */
  private _check(on: boolean, title: string, sub: string, toggle: () => void, fix?: string) {
    const inner = html`<span class="box ${on ? '' : 'off'}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>`;
    if (fix && this.store.admin)
      return html`<div class="row fixrow"><button class="pick" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${toggle}>${inner}</button>${fixButton(this, fix)}</div>`;
    return html`<button class="row" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${toggle}>${inner}</button>`;
  }

  /** a part of the pop-up: title, a one-line summary, then the settings in a box */
  private _block(title: string, sub: string, body: unknown, _open = false) {
    return html`<section class="rl-sec">
      <h3>${title}</h3>
      <div class="rl-box">${sub ? html`<small>${sub}</small>` : nothing}${body}</div>
    </section>`;
  }

  private _steps(value: number, unit: string, step: number, min: number, max: number, set: (v: number) => void) {
    return html`<span class="stepper"><button aria-label=${t('warning.less')} @click=${() => set(Math.max(min, value - step))}>−</button><output>${value} ${unit}</output><button aria-label=${t('warning.more')} @click=${() => set(Math.min(max, value + step))}>+</button></span>`;
  }

  override updated(): void {
    autoAssistant(this, this.store, 'window_warning');
  }

  override render() {
    const s = this.store;
    const w = s.windowWarning;
    if (!w) return nothing;
    const c = w.config;
    const set = (patch: Partial<WindowWarningConfig>) => s.windowWarningSet(patch);
    const tog = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    const name = (e: string) => s.device(e)?.name ?? s.entity(e)?.name ?? e;
    const doors = s.devices.filter((d) => d.kind === 'door');
    const windows = s.devices.filter((d) => d.kind === 'window');
    const lights = s.devices.filter((d) => d.kind === 'light');
    const players = s.extraEntities('media_player');
    const alarmPlayers = s.alarm?.config.announce.players ?? [];
    const chosenWin = c.windows === 'all' ? windows.map((d) => d.entity_id) : c.windows;
    const ackable = s.allEntities().filter((e) => /^(input_button|button|event|input_boolean|binary_sensor)\./.test(e.entity_id) && !windows.some((d) => d.entity_id === e.entity_id));
    const persons = s.persons;
    const isP = (id: string) => c.notify.persons === 'everyone' || c.notify.persons.includes(id);
    const doorText = w.doors.map(name).join(', ') || t('warning.no_door');
    // the placeholders of the announcement texts in the user's language (the server knows both)
    const ph = getLanguage() === 'de' ? { w: '{fenster}', n: '{anzahl}' } : { w: '{windows}', n: '{count}' };
    return html`
      ${w.active
        ? html`<div class="live">
            ${icon(mdiWindowOpenVariant, 24)}
            <span class="grow"><b>${w.phase === 'alarm' ? t('warning.warning_now') : t('warning.acknowledged')}</b><div class="note">${t('warning.still_open', { names: w.names.join(', ') })}</div></span>
            ${w.phase === 'alarm' ? html`<button class="btn small" @click=${() => s.windowWarningAck()}>${t('warning.ack')}</button>` : nothing}
          </div>`
        : nothing}
      ${this._card && !c.imported
        ? html`<div class="fhint">
            ${icon(mdiImport, 20)}
            <span class="grow"><b>${t('warning.card_found')}</b> ${t('warning.card_found_text', { dashboard: this._card.dashboard })}</span>
            <button class="btn small tinted" @click=${() => s.windowWarningImport(this._card!.entry, this._card!.openings, this._card!.dashboard).then(() => fire(this, 'hr-toast', t('warning.imported_toast')))}>${t('common.apply')}</button>
          </div>`
        : c.imported
          ? html`<p class="note">${t('warning.imported_from', { from: c.imported.from })}</p>`
          : nothing}
      <section class="rl-sec">
        <h3>${t('warning.what_happens')}</h3>
        <div class="rl-box">
          <small>${t('warning.what_happens_lead')}</small>
          <ol class="steps">
            <li><span><b>${t('warning.step_door')}</b><small>${w.doors.length ? t('warning.step_door_sub', { doors: doorText }) : t('warning.step_door_none')}</small></span></li>
            <li><span><b>${t('warning.step_warn')}</b><small>${c.lights.mode !== 'none' && c.lights.entities.length ? t('warning.step_warn_sub_light') : t('warning.step_warn_sub')}</small></span></li>
            <li><span><b>${t('warning.step_announce')}</b><small>${c.announce.mode === 'none' ? t('warning.step_announce_none') : t('warning.step_announce_sub', { s: c.timeout })}</small></span></li>
          </ol>
        </div>
      </section>
      ${this._block(
        t('warning.when'),
        `${c.windows === 'all' ? t('warning.when_sum_any', { doors: doorText }) : t('warning.when_sum_n', { doors: doorText, n: c.windows.length })}${c.only_last ? t('warning.when_sum_last') : ''}`,
        html`<span class="label">${t('warning.this_door')}</span>
          <div class="group">
            ${doors.map((d) => this._check(w.doors.includes(d.entity_id), d.name, c.doors.length ? '' : w.suggested_doors.includes(d.entity_id) ? t('warning.suggested') : '', () => set({ doors: tog(c.doors.length ? c.doors : w.doors, d.entity_id) }), d.entity_id))}
          </div>
          <span class="label">${t('warning.these_windows')}</span>
          <div class="seg">
            <button aria-pressed=${c.windows === 'all' ? 'true' : 'false'} @click=${() => set({ windows: 'all' })}>${t('warning.all_incl_new')}</button>
            <button aria-pressed=${c.windows !== 'all' ? 'true' : 'false'} @click=${() => set({ windows: chosenWin })}>${t('warning.only_some')}</button>
          </div>
          ${c.windows !== 'all' ? html`<div class="group">${windows.map((d) => this._check(chosenWin.includes(d.entity_id), d.name, s.room(d.room)?.name ?? '', () => set({ windows: tog(chosenWin, d.entity_id) }), d.entity_id))}</div><p class="note">${t('warning.order_note')}</p>`
            : html`<details class="found">
                <summary class="note">${t('warning.found_windows', { n: windows.length })}</summary>
                <div class="group">
                  ${windows.map((d) => html`<div class="row fixrow"><span class="pick"><span class="grow"><div class="title">${d.name}</div><div class="sub">${s.room(d.room)?.name ?? t('devices.no_room')}</div></span></span>${s.admin ? fixButton(this, d.entity_id) : nothing}</div>`)}
                </div>
              </details>`}
          <div class="group">
            <div class="row"><span class="grow"><div class="title">${t('warning.only_last')}</div><div class="sub">${t('warning.only_last_sub')}</div></span><button class="switch" role="switch" aria-label=${t('warning.only_last_short')} aria-checked=${c.only_last ? 'true' : 'false'} @click=${() => set({ only_last: !c.only_last })}></button></div>
            <div class="row wrap"><span class="grow"><div class="title">${t('warning.delay')}</div><div class="sub">${t('warning.delay_sub')}</div></span>${this._steps(c.delay, 's', 5, 0, 120, (v) => set({ delay: v }))}</div>
          </div>`,
        // open only while there is nothing to warn about yet
        !w.doors.length,
      )}
      ${this._block(
        t('warning.what'),
        `${c.lights.mode !== 'none' && c.lights.entities.length ? `${t('warning.what_sum_lights', { n: c.lights.entities.length })} · ` : ''}${c.announce.mode === 'none' ? t('warning.what_sum_none', { s: c.timeout }) : t('warning.what_sum_announce', { s: c.timeout })}${c.notify.on ? t('warning.what_sum_notify') : ''}`,
        html`<span class="label">${t('warning.light')}</span>
          <div class="seg">
            <button aria-pressed=${c.lights.mode === 'none' ? 'true' : 'false'} @click=${() => set({ lights: { ...c.lights, mode: 'none' } })}>${t('warning.light_none')}</button>
            <button aria-pressed=${c.lights.mode === 'red' ? 'true' : 'false'} @click=${() => set({ lights: { ...c.lights, mode: 'red' } })}>${t('warning.light_red')}</button>
            <button aria-pressed=${c.lights.mode === 'flash' ? 'true' : 'false'} @click=${() => set({ lights: { ...c.lights, mode: 'flash' } })}>${t('warning.light_flash')}</button>
          </div>
          ${c.lights.mode !== 'none'
            ? html`<div class="group">${lights.map((d) => this._check(c.lights.entities.includes(d.entity_id), d.name, s.room(d.room)?.name ?? '', () => set({ lights: { ...c.lights, entities: tog(c.lights.entities, d.entity_id) } })))}</div>
                <p class="note">${t('warning.light_note')}</p>`
            : nothing}
          <div class="group">
            <div class="row"><span class="grow"><div class="title">${t('warning.blink')}</div><div class="sub">${t('warning.blink_sub')}</div></span><button class="switch" role="switch" aria-label=${t('warning.blink_short')} aria-checked=${c.blink ? 'true' : 'false'} @click=${() => set({ blink: !c.blink })}></button></div>
            <div class="row wrap"><span class="grow"><div class="title">${t('warning.timeout')}</div><div class="sub">${t('warning.timeout_sub')}</div></span>${this._steps(c.timeout, 's', 5, 0, 300, (v) => set({ timeout: v }))}</div>
          </div>
          <span class="label">${t('warning.announce')}</span>
          <div class="seg">${MODES.map((m) => html`<button aria-pressed=${c.announce.mode === m ? 'true' : 'false'} @click=${() => set({ announce: { ...c.announce, mode: m } })}>${t(`warning.announce_${m}` as I18nKey)}</button>`)}</div>
          ${c.announce.mode !== 'none'
            ? html`<div class="group">
                  ${players.map((p) => this._check((c.announce.players.length ? c.announce.players : alarmPlayers).includes(p.entity_id), p.name, !c.announce.players.length && alarmPlayers.includes(p.entity_id) ? t('warning.like_alarm') : '', () => set({ announce: { ...c.announce, players: tog(c.announce.players.length ? c.announce.players : alarmPlayers, p.entity_id) } })))}
                  ${players.length ? nothing : html`<div class="row"><span class="sub">${t('warning.no_speaker')}</span></div>`}
                </div>
                <input class="text" aria-label=${t('warning.text')} .value=${c.announce.mode === 'general' ? c.announce.texts.general : c.announce.mode === 'all' ? c.announce.texts.all : c.announce.texts.single} @change=${(e: Event) => {
                  const k = c.announce.mode === 'general' ? 'general' : c.announce.mode === 'all' ? 'all' : 'single';
                  set({ announce: { ...c.announce, texts: { ...c.announce.texts, [k]: (e.target as HTMLInputElement).value } } });
                }} />
                <p class="note">${t('warning.placeholders', ph)}${c.announce.mode === 'sequential' ? ` ${t('warning.sequential_note')}` : ''}</p>`
            : nothing}
          <div class="group">
            <div class="row"><span class="grow"><div class="title">${t('warning.notify')}</div><div class="sub">${t('warning.notify_sub')}</div></span><button class="switch" role="switch" aria-label=${t('warning.notify_short')} aria-checked=${c.notify.on ? 'true' : 'false'} @click=${() => set({ notify: { ...c.notify, on: !c.notify.on } })}></button></div>
            ${c.notify.on
              ? persons.map((p) =>
                  this._check(isP(p.id), p.name, p.phone ? '' : t('warning.no_phone'), () => {
                    const next = tog(c.notify.persons === 'everyone' ? persons.map((x) => x.id) : c.notify.persons, p.id);
                    set({ notify: { ...c.notify, persons: next.length === persons.length ? 'everyone' : next } });
                  }),
                )
              : nothing}
          </div>`,
      )}
      ${this._block(
        t('warning.ack'),
        c.ack_entity ? t('warning.ack_sum_entity', { name: name(c.ack_entity) }) : t('warning.ack_sum'),
        html`<p class="note">${t('warning.ack_note')}</p>
          <div class="group">
            ${this._check(!c.ack_entity, t('warning.no_button'), '', () => set({ ack_entity: '' }))}
            ${ackable.slice(0, 40).map((e) => this._check(c.ack_entity === e.entity_id, e.name, e.entity_id, () => set({ ack_entity: e.entity_id })))}
          </div>`,
      )}
      <div>${assistantButton(this, s, 'window_warning')}</div>
    `;
  }
}
customElements.define('hr-window-warning', HrWindowWarning);
