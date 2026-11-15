/**
 * <hr-history-view>: the area "Verlauf". A slim timeline per day (Heute, Gestern, …) with filter chips; every entry
 * shows what happened and, in one line, why. Tapping it opens a pop-up with the whole reason and what took part
 * (rule, Home Assistant automation, devices), each with a way to open it.
 */
import { css, html, nothing } from 'lit';
import { mdiCancel, mdiChevronRight, mdiGestureTap, mdiHomeAssistant, mdiLightningBolt, mdiShieldHomeOutline, mdiDevices } from '@mdi/js';
import { StoreElement } from '../base';
import type { HistoryEntry } from '../model';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { registerPage } from '../components/page';
import { fmtDate, fmtTime, t, tn, type I18nKey } from '../i18n';
import '../components/pop';
// i18n: complete

/** label: t(`history.kind_${kind}`) */
const KIND = {
  rule: { icon: mdiLightningBolt, tone: 'tone-when' },
  automation: { icon: mdiHomeAssistant, tone: 'tone-and' },
  manual: { icon: mdiGestureTap, tone: 'tone-only' },
  skipped: { icon: mdiCancel, tone: 'tone-then' },
  alarm: { icon: mdiShieldHomeOutline, tone: 'tone-alarm' },
} as const;
const kindLabel = (k: keyof typeof KIND) => t(`history.kind_${k}` as I18nKey);
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

registerPage('history', {
  sub: (s) => {
    const today = s.history.filter((h) => isToday(h.at));
    const skipped = today.filter((h) => h.kind === 'skipped').length;
    return `${tn('history.n_today', today.length)}${skipped ? ` · ${tn('history.n_skipped', skipped)}` : ''}`;
  },
});

export class HrHistoryView extends StoreElement {
  static override properties = { ...StoreElement.properties, _kind: { state: true }, _open: { state: true } };
  declare _kind: 'all' | HistoryEntry['kind'];
  /** the entry whose pop-up is open */
  declare _open: HistoryEntry | null;

  constructor() {
    super();
    this._kind = 'all';
    this._open = null;
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
        max-width: 900px;
      }
      .lead {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        line-height: 1.45;
        max-width: 62ch;
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .chips button {
        min-height: 36px;
        padding: 0 14px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      .chips button[aria-pressed='true'] {
        background: var(--hr-label);
        color: var(--hr-bg);
      }
      .day {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .day h2 {
        font-size: var(--hr-text-subhead);
        color: var(--hr-label-2);
        margin-left: var(--hr-space-1);
      }
      .entry {
        display: grid;
        grid-template-columns: 52px 36px 1fr auto;
        gap: var(--hr-space-3);
        align-items: center;
        width: 100%;
        padding: var(--hr-space-3) var(--hr-space-4);
        text-align: left;
      }
      .entry + .entry {
        border-top: 0.5px solid var(--hr-separator);
      }
      .entry:hover {
        background: color-mix(in srgb, var(--hr-fill) 50%, transparent);
      }
      .entry time {
        font-variant-numeric: tabular-nums;
        font-size: var(--hr-text-subhead);
        font-weight: 600;
      }
      .k {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
        color: var(--tone);
      }
      .entry .txt {
        min-width: 0;
      }
      .entry .what {
        font-weight: 600;
      }
      .entry .why {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .entry .end {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        color: var(--hr-label-3);
      }
      .entry.skipped .what {
        color: var(--hr-label-2);
        text-decoration: line-through;
        text-decoration-color: var(--hr-label-3);
      }
      .empty {
        padding: var(--hr-space-6) var(--hr-space-4);
        text-align: center;
        color: var(--hr-label-2);
      }
      .why-text {
        font-size: var(--hr-text-body);
        line-height: 1.45;
      }
      .rl-item .open {
        display: inline-flex;
        align-items: center;
        color: var(--hr-accent);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        white-space: nowrap;
      }
      @media (max-width: 640px) {
        .entry {
          grid-template-columns: 44px 32px 1fr;
          padding: var(--hr-space-3);
        }
        .entry .end .rl-chip {
          display: none;
        }
        .entry .end {
          display: none;
        }
        .k {
          width: 32px;
          height: 32px;
        }
      }
    `,
  ];

  private _dayLabel(iso: string): string {
    const d = new Date(iso);
    if (isToday(iso)) return t('history.today');
    if (new Date(Date.now() - 86400000).toDateString() === d.toDateString()) return t('history.yesterday');
    return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /** the pop-up of one entry: the whole reason and what took part */
  private _pop(h: HistoryEntry) {
    const s = this.store;
    const k = KIND[h.kind];
    const rule = h.rule ? s.rule(h.rule) : undefined;
    const auto = h.automation ? s.automations.find((a) => a.entity_id === h.automation) : undefined;
    const ids = [...new Set([h.entity_id, ...(h.entities ?? [])].filter((x): x is string => !!x))];
    const devs = ids.map((id) => s.device(id)).filter((d): d is NonNullable<typeof d> => !!d);
    const close = () => (this._open = null);
    const sub = html`<span>${this._dayLabel(h.at)}, ${fmtTime(h.at)}</span><span class="rl-chip ${h.kind === 'skipped' ? 'warm' : h.kind === 'alarm' ? 'bad' : 'acc'}">${kindLabel(h.kind)}</span>`;
    return html`<hr-pop narrow heading=${h.what} .sub=${sub} @close=${close}>
      <div class="rl-sec">
        <span class="eyebrow">${h.kind === 'skipped' ? t('history.why_not') : t('history.why')}</span>
        <div class="rl-box ${k.tone}"><p class="why-text">${h.why}</p></div>
      </div>
      ${rule || h.rule_name || auto || h.automation || devs.length
        ? html`<div class="rl-sec">
            <span class="eyebrow">${t('history.involved')}</span>
            <div class="rl-list">
              ${rule
                ? html`<button class="rl-item" @click=${() => (close(), fire(this, 'hr-open-rule', { rule: structuredClone(rule) }))}>
                    <span class="ico">${icon(mdiLightningBolt, 20)}</span>
                    <span class="grow"><b>${rule.name}</b><small>${t('history.kind_rule')}</small></span>
                    <span class="open">${t('history.open')}${icon(mdiChevronRight, 18)}</span>
                  </button>`
                : h.rule_name
                  ? html`<div class="rl-item">
                      <span class="ico">${icon(mdiLightningBolt, 20)}</span>
                      <span class="grow"><b>${h.rule_name}</b><small>${h.rule?.startsWith('b_') ? t('history.behaviour_label') : t('history.rule_gone')}</small></span>
                    </div>`
                  : nothing}
              ${auto || h.automation
                ? html`<div class="rl-item">
                    <span class="ico">${icon(mdiHomeAssistant, 20)}</span>
                    <span class="grow"><b>${auto?.name ?? h.automation}</b><small>${t('history.automation_note')}</small></span>
                  </div>`
                : nothing}
              ${devs.map(
                (d) => html`<button class="rl-item" @click=${() => (close(), fire(this, 'hr-open-device', { entity_id: d.entity_id }))}>
                  <span class="ico">${icon(mdiDevices, 20)}</span>
                  <span class="grow"><b>${d.name}</b><small>${t('history.device')}</small></span>
                  <span class="open">${t('history.open')}${icon(mdiChevronRight, 18)}</span>
                </button>`,
              )}
            </div>
          </div>`
        : nothing}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.close')}</button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    const list = s.history.filter((h) => this._kind === 'all' || h.kind === this._kind);
    const days = new Map<string, HistoryEntry[]>();
    for (const h of list) {
      const key = this._dayLabel(h.at);
      days.set(key, [...(days.get(key) ?? []), h]);
    }
    return html`
      <p class="lead">${t('history.lead')}</p>
      <div class="chips" role="group" aria-label=${t('history.filter')}>
        ${(['all', 'rule', 'automation', 'manual', 'skipped', 'alarm'] as const).map(
          (k) => html`<button aria-pressed=${this._kind === k ? 'true' : 'false'} @click=${() => (this._kind = k)}>${k === 'all' ? t('history.all') : kindLabel(k)}</button>`,
        )}
      </div>
      ${days.size
        ? [...days].map(
            ([day, items]) => html`<section class="day">
              <h2>${day}</h2>
              <div class="rl-list">
                ${items.map((h) => {
                  const k = KIND[h.kind];
                  return html`<button class="entry ${h.kind} ${k.tone}" @click=${() => (this._open = h)}>
                    <time>${fmtTime(h.at)}</time>
                    <span class="k" title=${kindLabel(h.kind)}>${icon(k.icon, 20)}</span>
                    <span class="txt"><div class="what">${h.what}</div><div class="why">${h.why}</div></span>
                    <span class="end"><span class="rl-chip">${kindLabel(h.kind)}</span>${icon(mdiChevronRight, 18)}</span>
                  </button>`;
                })}
              </div>
            </section>`,
          )
        : html`<div class="rl-list"><p class="empty">${t('history.empty')}</p></div>`}
      ${this._open ? this._pop(this._open) : nothing}
    `;
  }
}
customElements.define('hr-history-view', HrHistoryView);
