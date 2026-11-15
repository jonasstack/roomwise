/**
 * <hr-mode-auto>: when the house switches its mode by itself (content of the pop-up "Hausmodus automatisch" in the
 * area Zuhause). What the automatic would choose now, then one row per mode in order of precedence with its switch;
 * "Einstellen" opens the mode's pop-up with the conditions ("Schlafen, wenn nachts und alle zuhause und …"), when it
 * ends and "Aufstehen erkennen". "Urlaub" is set up only in the vacation mode (Einstellungen → Urlaubsmodus, attribute
 * only="vacation" draws just that row there); the list here keeps its place in the order as a link.
 */
import { css, html, nothing } from 'lit';
import { mdiAirplane, mdiBedClock, mdiAccountGroup, mdiWalk, mdiChevronRight } from '@mdi/js';
import { StoreElement } from '../base';
import type { AutoMode, Clause, ModeEnd, WakeupView } from '../model';
import { clauseText } from '../describe';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { formatDuration } from '../vocabulary';
import '../components/conditions';
import '../components/pop';
import { t, type I18nKey } from '../i18n';
// i18n: complete
import { assistantButton, autoAssistant } from '../assistant/base';

/** modes in order of precedence; names: mode.<id>, hints: home.auto_hint_<id> */
const MODES: { id: AutoMode; icon: string }[] = [
  { id: 'vacation', icon: mdiAirplane },
  { id: 'away', icon: mdiWalk },
  { id: 'sleep', icon: mdiBedClock },
  { id: 'guests', icon: mdiAccountGroup },
];
const modeLabel = (m: string | null) => (m && ['home', 'away', 'sleep', 'vacation', 'guests'].includes(m) ? t(`mode.${m}` as I18nKey) : '–');
/** a text with {all} shown as a bold "alle" / "all" */
const withAll = (key: I18nKey, params: Record<string, string> = {}) =>
  t(key, { ...params, all: '\u0001' })
    .split('\u0001')
    .flatMap((part, i) => (i ? [html`<b>${t('home.all_bold')}</b>`, part] : [part]));

export class HrModeAuto extends StoreElement {
  static override properties = { ...StoreElement.properties, only: { type: String }, _edit: { state: true } };
  /** draw only this mode's row (the section Urlaub) */
  declare only: AutoMode | undefined;
  declare _edit: AutoMode | null;

  constructor() {
    super();
    this._edit = null;
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
      .rl-item .ic.mode {
        color: var(--hr-accent);
      }
      .rl-item small.cond {
        font-family: var(--hr-font-sentence);
      }
      .rl-item.off .ic.mode {
        color: var(--hr-label-3);
      }
      .rl-item .main .grow {
        flex: 1;
        min-width: 0;
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
      }
      .order {
        font-size: var(--hr-text-caption);
        color: var(--hr-label-3);
        font-weight: 700;
        width: 18px;
        text-align: center;
      }
      .edit p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        line-height: 1.45;
      }
      .edit {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .edit > * {
        flex-shrink: 0;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button {
        min-height: 34px;
        padding: 0 12px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
      }
      .chips button[aria-pressed='true'] {
        background: var(--hr-accent);
        color: var(--hr-on-accent);
      }
      .end {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        padding-top: var(--hr-space-4);
        border-top: 1px solid var(--hr-separator);
      }
      .end > * {
        flex-shrink: 0;
      }
      .end .seg {
        align-self: flex-start;
      }
      .end .seg button {
        white-space: normal;
        text-align: center;
      }
      p.warn {
        color: var(--hr-orange, #c77700);
      }
      .grow {
        flex: 1;
      }
      .reset {
        align-self: flex-start;
      }
      label.h {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
    `,
  ];

  private _presets(mode: AutoMode): { label: string; clause: Clause }[] {
    const s = this.store;
    const out: { label: string; clause: Clause }[] = [];
    if (mode === 'sleep') {
      out.push({ label: t('home.preset_night'), clause: { subject: 'time', verb: 'night' } });
      out.push({ label: t('home.preset_someone_home'), clause: { subject: 'person:someone', verb: 'is_home' } });
      out.push({ label: t('home.preset_everyone_home'), clause: { subject: 'person:everyone', verb: 'is_home' } });
      for (const r of s.rooms.filter((r) => /wohn|küche|kuche|flur/i.test(r.name) && (r.presence.length || r.motion.length)))
        out.push({ label: t('home.preset_room_empty_15', { room: r.name }), clause: { subject: `room:${r.id}`, verb: 'is_empty', for: '15m' } });
      for (const z of s.devices.filter((d) => d.kind === 'zone' && /^bett$|bett\b/i.test(d.name)).slice(0, 2))
        out.push({ label: t('home.preset_occupied', { name: z.name }), clause: { subject: `zone:${z.entity_id}`, verb: 'is_occupied' } });
      out.push({ label: t('home.preset_lights_off'), clause: { subject: 'all:light', verb: 'is_off' } });
    }
    if (mode === 'away') out.push({ label: t('home.preset_everyone_away'), clause: { subject: 'person:everyone', verb: 'is_away' } });
    if (mode === 'vacation') out.push({ label: t('home.preset_away_day'), clause: { subject: 'person:everyone', verb: 'is_away', for: '1d' } });
    if (mode === 'guests')
      for (const d of s.devices.filter((d) => /gast|gäste|besuch/i.test(d.name)).slice(0, 3)) out.push({ label: t('home.preset_on', { name: d.name }), clause: { subject: d.entity_id, verb: 'is_on' } });
    return out;
  }

  /** suggestions for "ends when …" */
  private _endPresets(mode: AutoMode): { label: string; clause: Clause }[] {
    const s = this.store;
    const out: { label: string; clause: Clause }[] = [];
    if (mode === 'sleep') {
      for (const z of s.devices.filter((d) => d.kind === 'zone' && /^bett$|bett\b/i.test(d.name)).slice(0, 2))
        out.push({ label: t('home.preset_free_15', { name: z.name }), clause: { subject: `zone:${z.entity_id}`, verb: 'is_free', for: '15m' } });
      out.push({ label: t('home.preset_morning'), clause: { subject: 'time', verb: 'morning' } });
      out.push({ label: t('home.preset_not_night'), clause: { subject: 'time', verb: 'between', from: '06:00', to: '22:00' } });
      for (const r of s.rooms.filter((r) => /wohn|küche|kuche/i.test(r.name) && (r.presence.length || r.motion.length)))
        out.push({ label: t('home.preset_occupied', { name: r.name }), clause: { subject: `room:${r.id}`, verb: 'is_occupied' } });
    }
    if (mode === 'away' || mode === 'vacation') out.push({ label: t('home.preset_someone_home'), clause: { subject: 'person:someone', verb: 'is_home' } });
    if (mode === 'guests')
      for (const d of s.devices.filter((d) => /gast|gäste|besuch/i.test(d.name)).slice(0, 3)) out.push({ label: t('home.preset_off', { name: d.name }), clause: { subject: d.entity_id, verb: 'is_off' } });
    return out;
  }

  private _endSection(mode: AutoMode, label: string, end: ModeEnd) {
    const s = this.store;
    const set = (patch: Partial<ModeEnd>) => s.modeAutoSet(mode, { end: { ...end, ...patch } });
    return html`<div class="end">
      <label class="h">${t('home.end_title', { mode: label })}</label>
      <div class="seg">
        <button aria-pressed=${end.on ? 'false' : 'true'} @click=${() => set({ on: false })}>${t('home.end_auto')}</button>
        <button aria-pressed=${end.on ? 'true' : 'false'} @click=${() => set({ on: true })}>${t('home.end_own')}</button>
      </div>
      ${end.on
        ? html`<p>${withAll('home.end_own_help', { mode: label })}</p>
            <hr-conditions .store=${s} .clauses=${end.when} .presets=${this._endPresets(mode)} heading=${t('home.ends_when')} @change=${(e: CustomEvent<Clause[]>) => set({ when: e.detail })}></hr-conditions>
            <label class="h">${t('home.end_for')}</label>
            <div class="chips">
              ${['', '1m', '5m', '10m', '15m', '30m'].map(
                (d) => html`<button aria-pressed=${(end.for || '') === d ? 'true' : 'false'} @click=${() => set({ for: d })}>${d ? formatDuration(d) : t('home.at_once')}</button>`,
              )}
            </div>
            ${end.when.length ? nothing : html`<p class="warn">${t('home.end_warn')}</p>`}`
        : html`<p>${t('home.end_auto_help')}</p>`}
    </div>`;
  }

  /** "Aufstehen erkennen": the end of "Schlafen" learned from the bed and the rest of the house */
  private _wakeupSection(w: WakeupView) {
    const s = this.store;
    const set = (patch: Partial<Pick<WakeupView, 'on' | 'action' | 'feedback' | 'beds' | 'rooms'>>) => s.wakeupSet(patch);
    const chosen = new Set(w.beds);
    const bedRooms = new Set(w.found_beds.map((b) => s.devices.find((d) => d.entity_id === b.entity_id)?.room).filter(Boolean));
    // bed sensors to choose from: zones and presence sensors in the bedroom(s), else all of them
    const near = s.devices.filter((d) => (d.kind === 'zone' || d.kind === 'presence') && (!bedRooms.size || bedRooms.has(d.room ?? '')));
    const toggleBed = (eid: string) => {
      const cur = w.beds.length ? w.beds : w.found_beds.map((b) => b.entity_id);
      set({ beds: cur.includes(eid) ? cur.filter((e) => e !== eid) : [...cur, eid] });
    };
    const learned = (kind: 'work' | 'free') => {
      const l = w.learned[kind];
      const key = kind === 'work' ? (l.room ? 'home.wake_learned_work_room' : 'home.wake_learned_work') : l.room ? 'home.wake_learned_free_room' : 'home.wake_learned_free';
      return l.n >= 2.5 ? t(key, { from: l.from, to: l.to, need: String(l.need), room: l.room ?? '' }) : t(kind === 'work' ? 'home.wake_learning_work' : 'home.wake_learning_free', { need: String(l.need) });
    };
    return html`<div class="end">
      <div class="head">
        <label class="h grow">${t('home.wake_title')}</label>
        <button class="switch" role="switch" aria-label=${t('home.wake_title')} aria-checked=${w.on ? 'true' : 'false'} @click=${() => set({ on: !w.on })}></button>
      </div>
      <p>${t('home.wake_help')}</p>
      ${w.on
        ? html`${w.found_beds.length
              ? html`<p>${t('home.wake_found', { beds: w.found_beds.map((b) => b.name).join(', '), rooms: w.found_rooms.join(', ') || '–' })}</p>`
              : html`<p class="warn">${t('home.wake_no_bed')}</p>`}
            <label class="h">${t('home.wake_beds')}</label>
            <div class="chips">
              ${near.map(
                (d) =>
                  html`<button aria-pressed=${(chosen.size ? chosen.has(d.entity_id) : w.found_beds.some((b) => b.entity_id === d.entity_id)) ? 'true' : 'false'} @click=${() => toggleBed(d.entity_id)}>${d.name}</button>`,
              )}
              ${chosen.size ? html`<button @click=${() => set({ beds: [] })}>${t('home.wake_beds_auto')}</button>` : nothing}
            </div>
            <label class="h">${t('home.wake_action')}</label>
            <div class="seg">
              <button aria-pressed=${w.action === 'direct' ? 'true' : 'false'} @click=${() => set({ action: 'direct' })}>${t('home.wake_direct')}</button>
              <button aria-pressed=${w.action === 'ask' ? 'true' : 'false'} @click=${() => set({ action: 'ask' })}>${t('home.wake_ask')}</button>
            </div>
            <div class="head">
              <span class="grow"><label class="h">${t('home.wake_feedback')}</label><p>${t('home.wake_feedback_help')}</p></span>
              <button class="switch" role="switch" aria-label=${t('home.wake_feedback')} aria-checked=${w.feedback ? 'true' : 'false'} @click=${() => set({ feedback: !w.feedback })}></button>
            </div>
            <label class="h">${t('home.wake_learned')}</label>
            <p>${learned('work')}</p>
            <p>${learned('free')}</p>
            ${w.status ? html`<p>${t('home.wake_now', { status: w.status })}</p>` : nothing}
            <button class="btn small reset" ?disabled=${!w.detections && !w.trips} @click=${() => s.wakeupReset()}>${t('home.wake_reset')}</button>`
        : nothing}
    </div>`;
  }

  private _sheet(mode: AutoMode) {
    const s = this.store;
    const cfg = s.modeAuto!.modes[mode];
    const label = modeLabel(mode);
    const close = () => (this._edit = null);
    return html`<hr-pop heading=${t('home.auto_title', { mode: label })} .sub=${t('home.order_n', { n: MODES.findIndex((m) => m.id === mode) + 1 })} @close=${close}>
      <button slot="head" class="switch" role="switch" aria-label=${t('home.auto_toggle')} aria-checked=${cfg.on ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => s.modeAutoSet(mode, { on: !cfg.on })}></button>
      <div class="edit">
        <p>${t(`home.auto_hint_${mode}` as I18nKey)} ${withAll('home.auto_set_when')}</p>
        <hr-conditions
          .store=${s}
          .clauses=${cfg.when}
          .presets=${this._presets(mode)}
          heading=${t('home.when_is', { mode: label })}
          @change=${(e: CustomEvent<Clause[]>) => s.modeAutoSet(mode, { when: e.detail })}
        ></hr-conditions>
        <label class="h">${t('home.start_for')}</label>
        <div class="chips">
          ${['', '2m', '5m', '10m', '15m', '30m'].map(
            (d) => html`<button aria-pressed=${(cfg.for || '') === d ? 'true' : 'false'} @click=${() => s.modeAutoSet(mode, { for: d })}>${d ? formatDuration(d) : t('home.at_once')}</button>`,
          )}
        </div>
        ${mode === 'sleep' && s.modeAuto!.wakeup ? this._wakeupSection(s.modeAuto!.wakeup) : nothing}
        ${mode === 'sleep' && s.modeAuto!.wakeup?.on ? html`<p>${t('home.wake_replaces_end')}</p>` : this._endSection(mode, label, cfg.end ?? { on: false, when: [], for: '' })}
      </div>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  override updated(): void {
    autoAssistant(this, this.store, 'mode_auto');
  }

  override render() {
    const s = this.store;
    const ma = s.modeAuto;
    if (!ma) return nothing;
    const text = (id: AutoMode) => {
      const cfg = ma.modes[id];
      const and = ` ${t('common.and')} `;
      const endText = id === 'sleep' && ma.wakeup?.on ? t('home.wake_ends_list') : cfg.end?.on && cfg.end.when.length ? `${t('home.ends_when_list', { conds: cfg.end.when.map((c) => clauseText(s, c, 'and')).join(and) })}${cfg.end.for ? ` (${formatDuration(cfg.end.for)})` : ''}` : '';
      const txt = cfg.on && cfg.when.length ? cfg.when.map((c) => clauseText(s, c, 'and')).join(and) + (cfg.for ? t('home.since', { d: formatDuration(cfg.for) }) : '') + endText : t('home.manual_only') + endText;
      return cfg.on && cfg.when.length ? t('home.when_list', { text: txt }) : txt;
    };
    // the vacation mode (Einstellungen → Urlaubsmodus): just that mode's row and its pop-up
    if (this.only) {
      const m = MODES.find((x) => x.id === this.only)!;
      const cfg = ma.modes[m.id];
      return html`<div class="rl-list">
          <div class="rl-item ${cfg.on && ma.enabled ? '' : 'off'}">
            <button class="main" @click=${() => (this._edit = m.id)}>
              <span class="ic mode">${icon(m.icon, 22)}</span>
              <span class="grow"><b>${t('home.auto_mode_title', { mode: modeLabel(m.id) })}</b><small class="cond">${ma.enabled ? text(m.id) : t('home.auto_off')}</small></span>
              <span class="go">${icon(mdiChevronRight, 20)}</span>
            </button>
            <button class="switch" role="switch" aria-label=${t('home.auto_mode_title', { mode: modeLabel(m.id) })} aria-checked=${cfg.on ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => s.modeAutoSet(m.id, { on: !cfg.on })}></button>
          </div>
        </div>
        ${this._edit ? this._sheet(this._edit) : nothing}`;
    }
    const now = ma.enabled
      ? ma.held
        ? t('home.held', { mode: modeLabel(s.mode) })
        : ma.why
          ? t(/^(bis|until) /.test(ma.why) ? 'home.now_target_until' : 'home.now_target_because', { mode: modeLabel(ma.target), why: ma.why })
          : t('home.now_target', { mode: modeLabel(ma.target) })
      : t('home.auto_off');
    return html`
      <div class="rl-now">
        <span class="grow"><b>${now}</b><small>${t('home.manual_in_tile')}</small></span>
      </div>
      ${ma.enabled
        ? html`<div class="rl-sec">
            <span class="eyebrow">${t('home.when_switch')}</span>
            <div class="rl-list">
              ${MODES.map((m, i) => {
                const cfg = ma.modes[m.id];
                const vac = m.id === 'vacation';
                return html`<div class="rl-item ${cfg.on ? '' : 'off'}">
                  <button class="main" @click=${() => (vac ? fire(this, 'hr-tab', 'settings#urlaub') : (this._edit = m.id))}>
                    <span class="order">${i + 1}</span>
                    <span class="ic mode">${icon(m.icon, 22)}</span>
                    <span class="grow"><b>${modeLabel(m.id)}</b><small class="cond">${vac ? t('home.auto_vacation_there', { text: text(m.id) }) : text(m.id)}</small></span>
                    <span class="btn small">${vac ? t('home.to_vacation') : t('home.set_up')}</span>
                  </button>
                  ${vac
                    ? nothing
                    : html`<button class="switch" role="switch" aria-label=${t('home.auto_mode_title', { mode: modeLabel(m.id) })} aria-checked=${cfg.on ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => s.modeAutoSet(m.id, { on: !cfg.on })}></button>`}
                </div>`;
              })}
            </div>
          </div>`
        : nothing}
      ${assistantButton(this, s, 'mode_auto') === nothing
        ? nothing
        : html`<div class="rl-box"><div class="line"><div class="grow"><b>${t('home.assist_title')}</b><small>${t('home.assist_sub')}</small></div>${assistantButton(this, s, 'mode_auto')}</div></div>`}
      ${this._edit ? this._sheet(this._edit) : nothing}
    `;
  }
}
customElements.define('hr-mode-auto', HrModeAuto);
