/**
 * <house-rules-device>: the pop-up of one device: how it is now and why it last changed, the rules that start, check
 * or switch it, starting a new rule with it, the Home Assistant automations that use it, "Nicht verwenden". The gear
 * opens "Erkannt als" with name, kind, room and icon (hr-device-fix). Drawn as the content of a sheet: the panel
 * wraps it in <hr-sheet>, the floor plan card in its own sheet ("Regeln" of a device).
 * Embeddable (floorplan card): set .store, .entityId and the "standalone" attribute.
 */
import { css, html, nothing } from 'lit';
import { mdiArrowRight, mdiClose, mdiCogOutline, mdiEyeOffOutline, mdiHomeAssistant, mdiInfinity, mdiLightningBolt, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import type { Rule } from '../model';
import { newRule } from '../store';
import { relTime, ruleSentence, subjectInfo } from '../describe';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { tokensFor } from '../design/tokens';
import { KINDS, verbsFor } from '../vocabulary';
import { stateText } from '../live';
import '../components/sheet';
import '../components/pop';
import '../components/device-fix';
import '../editor/rule-editor';
import { t, tn } from '../i18n';
// i18n: complete

/** "Front door opens …" for the starter buttons; English actions put the device after the verb ("turn on {s}") */
const starterText = (name: string, label: string) =>
  label.includes('{s}') ? label.replace('{s}', name).replace(/\{\w+\}/g, '…') : `${name} ${label.replace(/\{\w+\}/g, '…')}`;

export class HouseRulesDevice extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    entityId: { attribute: 'entity-id' },
    closable: { type: Boolean },
    _editing: { state: true },
    _fix: { state: true },
    _hide: { state: true },
  };
  declare _editing: { rule?: Rule; isNew?: boolean } | null;
  /** the gear pop-up (Erkannt als, Art, Raum, Symbol) is open */
  declare _fix: boolean;
  /** "Nicht verwenden?" is asked */
  declare _hide: boolean;

  constructor() {
    super();
    this._editing = null;
    this._fix = false;
    this._hide = false;
    // used on its own (floorplan card): open the rule editor here instead of handing it to the panel
    this.addEventListener('hr-open-rule', (e) => {
      if (!this.hasAttribute('standalone')) return;
      e.stopPropagation();
      this._editing = (e as CustomEvent<{ rule?: Rule; isNew?: boolean }>).detail ?? {};
    });
  }
  declare entityId: string;
  declare closable: boolean;

  static override styles = [
    tokensFor(':host([standalone])'),
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        background: var(--hr-bg);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-4) var(--hr-space-4) var(--hr-space-3) var(--hr-space-5);
        background: var(--hr-surface);
        border-bottom: 0.5px solid var(--hr-separator);
      }
      .head .grow {
        flex: 1;
        min-width: 0;
      }
      .head h2 {
        font-size: var(--hr-text-title2);
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .head .sub {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 4px;
      }
      .body {
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: var(--hr-space-4) var(--hr-space-5) var(--hr-space-6);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
        min-height: 0;
        flex: 1;
      }
      .body > * {
        flex-shrink: 0;
      }
      .foot {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        flex-wrap: wrap;
        padding: var(--hr-space-3) var(--hr-space-5);
        background: var(--hr-surface);
        border-top: 0.5px solid var(--hr-separator);
      }
      .foot .sp {
        flex: 1;
      }
      .k {
        width: 36px;
        height: 36px;
        border-radius: var(--hr-radius-s);
        display: grid;
        place-items: center;
        flex: none;
        color: #fff;
        background: var(--hr-when);
      }
      .k.while {
        background: var(--hr-while);
      }
      .rl-item.off .main {
        opacity: 0.55;
      }
      .rl-item small.clamp {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .role {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        margin: var(--hr-space-1) var(--hr-space-2) 0;
      }
      .role .dot {
        background: var(--tone);
      }
      .starters {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      .starter {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        padding: 0 14px 0 10px;
        border-radius: var(--hr-radius-full);
        background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
        font-family: var(--hr-font-sentence);
        font-size: var(--hr-text-subhead);
        font-weight: 600;
      }
      .starter .ic {
        color: var(--tone);
      }
      .starter .kw {
        font-weight: 700;
      }
      .fix {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-orange) 10%, var(--hr-surface));
        font-size: var(--hr-text-footnote);
      }
      .fix span {
        flex: 1;
        min-width: 200px;
      }
      .ha .ico {
        color: #18bcf2;
      }
      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .why time {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        min-width: 82px;
        font-variant-numeric: tabular-nums;
      }
      .empty {
        padding: var(--hr-space-4);
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
      }
      @media (max-width: 640px) {
        .head {
          padding-left: var(--hr-space-4);
        }
        .body,
        .foot {
          padding-left: var(--hr-space-4);
          padding-right: var(--hr-space-4);
        }
      }
    `,
  ];

  private _open(rule: Rule, isNew = false) {
    fire(this, 'hr-open-rule', { rule: structuredClone(rule), isNew });
  }

  private _closeBtn() {
    return this.closable
      ? html`<button class="icon-btn" aria-label=${t('common.close')} title=${t('common.close')} @click=${() => this.dispatchEvent(new CustomEvent('close'))}>${icon(mdiClose, 22)}</button>`
      : nothing;
  }

  /** a rule as a short line: kind, name, sentence, on/off */
  private _ruleItem(r: Rule) {
    const s = this.store;
    return html`<div class="rl-item ${r.enabled ? '' : 'off'}">
      <button class="main" @click=${() => this._open(r)}>
        <span class="k ${r.type === 'while' ? 'while' : ''}">${icon(r.type === 'while' ? mdiInfinity : mdiLightningBolt, 18)}</span>
        <span class="grow"><b>${r.name}</b><small class="clamp">${r.sentence || ruleSentence(s, r)}</small><small>${r.meta?.last_run ? t('devices.last_run', { when: relTime(r.meta.last_run) }) : t('devices.never_ran')}</small></span>
      </button>
      <button class="switch" role="switch" aria-label=${t('devices.rule_toggle')} aria-checked=${r.enabled ? 'true' : 'false'} @click=${() => s.setEnabled(r.id, !r.enabled)}></button>
    </div>`;
  }

  /** gear: name, kind, room, icon, "Nicht verwenden", "Wie erkannt" (one central store, counts everywhere) */
  private _fixPop(name: string) {
    return html`<hr-pop heading=${t('devices.fix_title', { name })} .sub=${t('devices.fix_sub')} @close=${() => (this._fix = false)}>
      <hr-device-fix .store=${this.store} .entityId=${this.entityId} noHide @done=${() => (this._fix = false)}></hr-device-fix>
      <p class="rl-note">${t('devices.fix_note')}</p>
      <button slot="foot" class="btn primary" @click=${() => (this._fix = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _hidePop(name: string, n: number) {
    const s = this.store;
    const go = async () => {
      try {
        await s.setDevices([{ entity_id: this.entityId, hidden: true }]);
      } catch (e) {
        fire(this, 'hr-toast', (e as Error).message);
      }
      this._hide = false;
    };
    return html`<hr-pop narrow heading=${t('devices.hide_title', { name })} @close=${() => (this._hide = false)}>
      <p class="rl-note">${tn('devices.hide_text', n)}</p>
      <div class="rl-info">${icon(mdiEyeOffOutline, 18)}<span>${t('devices.hide_back')}</span></div>
      <button slot="foot" class="btn" @click=${() => (this._hide = false)}>${t('common.cancel')}</button>
      <button slot="foot" class="btn danger" ?disabled=${!s.admin} @click=${go}>${t('devices.hide')}</button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    const d = s.device(this.entityId);
    if (!d) {
      // not used (excluded, part of a vehicle) or not sorted by Hausregeln: only what can be done about it
      const u = s.devicesUnused.find((x) => x.entity_id === this.entityId);
      const e = s.entity(this.entityId);
      if (!u && !e) return html`<div class="empty">${t('devices.not_found')}</div>`;
      return html`<div class="head">
          <span class="rl-ic small">${icon(KINDS[u?.kind ?? '']?.icon ?? mdiHomeAssistant, 22)}</span>
          <div class="grow"><h2>${u?.name ?? e?.name}</h2><div class="sub"><span class="rl-chip">${this.entityId}</span></div></div>
          ${this._closeBtn()}
        </div>
        <div class="body"><hr-device-fix .store=${s} .entityId=${this.entityId}></hr-device-fix></div>`;
    }
    const kind = KINDS[d.kind];
    const usage = s.usage(d.kind === 'zone' ? `zone:${d.entity_id}` : d.entity_id);
    const byRole = (as: string[]) => [...new Map(usage.filter((u) => as.includes(u.as)).map((u) => [u.rule.id, u.rule])).values()];
    const starts = byRole(['when']);
    const checks = byRole(['and', 'only']);
    const switches = byRole(['then']);
    const all = new Set([...starts, ...checks, ...switches].map((r) => r.id)).size;
    const ha = s.automations.filter((a) => a.uses.some((u) => u.entity_id === d.entity_id));
    const why = s.history.filter((h) => h.entity_id === d.entity_id).slice(0, 5);
    const subject = d.kind === 'zone' ? `zone:${d.entity_id}` : d.entity_id;
    const info = subjectInfo(s, subject);
    const ev = verbsFor(info.kind, 'event')[0];
    const st = verbsFor(info.kind, 'state')[0];
    const act = verbsFor(info.kind, 'action')[0];
    const group = (tone: string, title: string, list: Rule[]) =>
      list.length ? html`<div class="role ${tone}"><span class="dot"></span>${title}</div><div class="rl-list">${list.map((r) => this._ruleItem(r))}</div>` : nothing;
    const last = why[0];

    return html`
      <div class="head">
        <span class="rl-ic small">${icon(d.icon ?? kind?.icon ?? info.icon, 22)}</span>
        <div class="grow">
          <h2>${d.name}</h2>
          <div class="sub">
            <span class="rl-chip">${kind?.label ?? d.kind}</span>
            <span class="rl-chip">${d.room ? s.room(d.room)?.name : t('devices.no_room')}</span>
            ${d.detail ? html`<span class="rl-chip acc">${d.detail}</span>` : nothing}
            ${d.state === 'unavailable' ? html`<span class="rl-chip bad">${t('rooms.unavailable')}</span>` : nothing}
          </div>
        </div>
        <button class="icon-btn" aria-label=${t('devices.fix_title', { name: d.name })} title=${t('devices.fix_title', { name: d.name })} @click=${() => (this._fix = true)}>${icon(mdiCogOutline, 22)}</button>
        ${this._closeBtn()}
      </div>
      <div class="body">
        ${d.kind_hint
          ? html`<div class="fix">
              <span>${t('devices.kind_fix', { ha: '\u0001', name: '\u0002' })
                .split(/(\u0001|\u0002)/)
                .map((x) => (x === '\u0001' ? html`<b>${KINDS[d.kind_hint!]?.label}</b>` : x === '\u0002' ? html`<b>${kind?.label}</b>` : x))}</span>
              <button class="btn small tinted" @click=${() => s.setDevices([{ entity_id: d.entity_id, kind: d.kind }])}>${kind?.label}</button>
              <button class="btn small" @click=${() => s.setDevices([{ entity_id: d.entity_id, kind: d.kind_hint }])}>${KINDS[d.kind_hint]?.label}</button>
            </div>`
          : nothing}

        <div class="rl-now">
          <span class="grow">
            <b>${d.detail || stateText(d.kind, { state: d.state, attributes: {} }) || d.state}</b>
            <small>${last ? t('devices.last_change', { time: relTime(last.at), what: last.why || last.what }) : t('devices.no_change_known')}</small>
          </span>
        </div>

        <div class="rl-sec">
          <span class="eyebrow">${t('devices.rules_of', { name: d.name })} · ${all}</span>
          ${all
            ? html`${group('tone-when', tn('devices.starts', starts.length), starts)} ${group('tone-and', t('devices.checked_by'), checks)}
              ${group('tone-then', t('devices.switched_by'), switches)}`
            : html`<p class="rl-note rl-lbl">${t('devices.no_rule', { name: d.name })}</p>`}
        </div>

        <div class="rl-sec">
          <span class="eyebrow">${t('devices.new_rule_with', { name: d.name })}</span>
          <div class="starters">
            ${ev
              ? html`<button class="starter tone-when" @click=${() => this._open(newRule({ when: [{ subject, verb: ev.id }] }), true)}>
                  ${icon(mdiPlus, 18)}<span class="kw">${t('join.when')}</span> ${starterText(d.name, ev.label)} …
                </button>`
              : nothing}
            ${st
              ? html`<button class="starter tone-while" @click=${() => this._open(newRule({ type: 'while', when: [{ subject, verb: st.id }] }), true)}>
                  ${icon(mdiPlus, 18)}<span class="kw">${t('join.while')}</span> ${starterText(d.name, st.label)} …
                </button>`
              : nothing}
            ${act
              ? html`<button class="starter tone-then" @click=${() => this._open(newRule({ then: [{ subject, verb: act.id }] }), true)}>
                  ${icon(mdiPlus, 18)}… <span class="kw">${t('join.then').toLowerCase()}</span> ${starterText(d.name, act.label)}
                </button>`
              : nothing}
          </div>
        </div>

        ${why.length
          ? html`<div class="rl-sec why">
              <span class="eyebrow">${t('devices.why_changed')}</span>
              <div class="rl-list">
                ${why.map(
                  (h) => html`<div class="rl-item">
                    <time>${relTime(h.at)}</time>
                    <span class="grow"><b>${h.what}</b><small>${h.why}</small></span>
                    ${h.rule && s.rule(h.rule)
                      ? html`<button class="icon-btn" aria-label=${t('devices.open_rule')} @click=${() => this._open(s.rule(h.rule!)!)}>${icon(mdiArrowRight, 20)}</button>`
                      : nothing}
                  </div>`,
                )}
              </div>
            </div>`
          : nothing}

        ${ha.length
          ? html`<div class="rl-sec ha">
              <span class="eyebrow">${t('devices.ha_automations')} · ${ha.length}</span>
              <div class="rl-list">
                ${ha.map((a) => {
                  const replacedBy = s.rules.find((r) => r.meta?.replaces?.includes(a.entity_id));
                  const as = [...new Set(a.uses.filter((u) => u.entity_id === d.entity_id).map((u) => u.as))];
                  return html`<div class="rl-item">
                    <span class="ico">${icon(mdiHomeAssistant, 20)}</span>
                    <span class="grow">
                      <b>${a.name}</b>
                      <small>${a.summary}</small>
                      <span class="tags">
                        ${as.map((x) => html`<span class="rl-chip">${t(x === 'trigger' ? 'devices.as_trigger' : x === 'condition' ? 'devices.as_condition' : 'devices.as_action')}</span>`)}
                        ${replacedBy
                          ? html`<span class="rl-chip yes">${t('devices.replaced_by', { name: replacedBy.name })}</span>`
                          : html`<span class="rl-chip">${t(a.enabled ? 'devices.active' : 'devices.off')}${a.last ? t('devices.last', { time: relTime(a.last) }) : ''}</span>`}
                      </span>
                    </span>
                    <button class="switch" role="switch" aria-label=${t('devices.automation_toggle')} aria-checked=${a.enabled ? 'true' : 'false'} @click=${() => s.setAutomation(a.entity_id, !a.enabled)}></button>
                  </div>`;
                })}
              </div>
            </div>`
          : nothing}
      </div>
      <div class="foot">
        ${d.manual ? nothing : html`<button class="btn" ?disabled=${!s.admin} @click=${() => (this._hide = true)}>${icon(mdiEyeOffOutline, 18)}${t('devices.hide')}</button>`}
        <span class="sp"></span>
        ${this.closable ? html`<button class="btn primary" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>${t('common.done')}</button>` : nothing}
      </div>
      ${this._fix ? this._fixPop(d.name) : nothing} ${this._hide ? this._hidePop(d.name, all) : nothing}
      ${this._editing
        ? html`<hr-sheet width="820" label=${t('devices.rule')} @close=${() => (this._editing = null)}>
            <house-rules-editor
              .store=${s}
              .rule=${this._editing.rule}
              ?isNew=${!!this._editing.isNew}
              @closed=${(e: Event) => {
                e.stopPropagation();
                this._editing = null;
              }}
              @rule-saved=${() => (this._editing = null)}
            ></house-rules-editor>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('house-rules-device', HouseRulesDevice);
