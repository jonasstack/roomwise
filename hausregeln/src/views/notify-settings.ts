/**
 * <hr-notify-settings>: Einstellungen → Benachrichtigungen. How often Hausregeln may write to the phones: per kind
 * on/off, the minimum gap per occasion and a daily maximum (per person), quiet hours, and per person which kinds
 * they get. Real alarms are not limited (they always go out at once). Server: notify.py, saved with settings/set.
 */
import { css, html, nothing } from 'lit';
import { mdiAirFilter, mdiBedClock, mdiBellOutline, mdiBellRing, mdiShieldHomeOutline, mdiWindowOpenVariant } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { LiveStore } from '../live';
import { t, type I18nKey } from '../i18n';
// i18n: complete

export type NotifyKind = 'vent' | 'window' | 'alarm_info' | 'rule' | 'rule_report' | 'wakeup';
export interface NotifyKindSetting {
  on: boolean;
  gap: number;
  daily: number;
}
export interface NotifySettings {
  kinds: Record<NotifyKind, NotifyKindSetting>;
  quiet: { on: boolean; from: string; to: string };
  persons: Record<string, { off: NotifyKind[] }>;
  defaults?: Record<NotifyKind, NotifyKindSetting>;
  today?: Partial<Record<NotifyKind, number>>;
  quiet_now?: boolean;
}

const KINDS: NotifyKind[] = ['vent', 'window', 'alarm_info', 'rule', 'rule_report', 'wakeup'];
const ICONS: Record<NotifyKind, string> = { vent: mdiAirFilter, window: mdiWindowOpenVariant, alarm_info: mdiShieldHomeOutline, rule: mdiBellOutline, rule_report: mdiBellRing, wakeup: mdiBedClock };
const GAPS = [0, 1, 5, 15, 30, 60, 120, 240, 480, 1440];
const DAILY = [0, 1, 2, 3, 5, 8, 10, 20, 30, 50];
const label = (k: NotifyKind) => t(`settings.n_kind_${k}` as I18nKey);
const sub = (k: NotifyKind) => t(`settings.n_kind_${k}_sub` as I18nKey);

export class HrNotifySettings extends StoreElement {
  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .row.wrap {
        flex-wrap: wrap;
      }
      .limits {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2) var(--hr-space-4);
        width: 100%;
        padding-left: 36px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 64px;
        text-align: center;
        font-weight: 600;
        color: var(--hr-label);
        font-variant-numeric: tabular-nums;
      }
      .stepper button {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 17px;
      }
      .time {
        font: inherit;
        padding: 4px 8px;
        border-radius: var(--hr-radius-s, 8px);
        border: 1px solid var(--hr-separator);
        background: var(--hr-surface);
        color: var(--hr-label);
      }
      .kinds {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        width: 100%;
        padding-left: 36px;
      }
      .kinds button {
        padding: 4px 10px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
      }
      .kinds button[aria-pressed='true'] {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-label);
      }
      .note {
        margin: var(--hr-space-3) 4px 0;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
    `,
  ];

  private get _cfg(): NotifySettings | undefined {
    const s = this.store;
    return s instanceof LiveStore ? ((s.settings as { notifications?: NotifySettings }).notifications ?? undefined) : undefined;
  }

  private _save(patch: Partial<NotifySettings>) {
    const s = this.store;
    if (!(s instanceof LiveStore)) return;
    const cur = this._cfg;
    if (cur) (s.settings as { notifications?: NotifySettings }).notifications = { ...cur, ...patch } as NotifySettings;
    s.saveSettings({ notifications: patch });
    this.requestUpdate();
  }

  private _kind(k: NotifyKind, v: NotifyKindSetting, today: number) {
    const set = (p: Partial<NotifyKindSetting>) => this._save({ kinds: { ...this._cfg!.kinds, [k]: { ...v, ...p } } });
    const step = (list: number[], cur: number, d: number) => {
      const i = list.findIndex((x) => x >= cur);
      return list[Math.max(0, Math.min(list.length - 1, (i < 0 ? list.length - 1 : i) + d))];
    };
    const gap = v.gap === 0 ? t('settings.n_gap_none') : v.gap >= 60 ? t('settings.n_hours', { n: Math.round((v.gap / 60) * 10) / 10 }) : t('settings.n_minutes', { n: v.gap });
    const daily = v.daily === 0 ? t('settings.n_daily_none') : String(v.daily);
    const admin = this.store.admin;
    return html`<div class="row wrap ${v.on ? '' : 'off'}">
      ${icon(ICONS[k], 24)}
      <span class="grow"><div class="title">${label(k)}</div><div class="sub">${sub(k)}${today ? ` ${t('settings.n_today', { n: today })}` : ''}</div></span>
      <button class="switch" role="switch" aria-label=${label(k)} aria-checked=${v.on ? 'true' : 'false'} ?disabled=${!admin} @click=${() => set({ on: !v.on })}></button>
      ${v.on
        ? html`<div class="limits">
            <span>${t('settings.n_gap')}</span>
            <span class="stepper"><button ?disabled=${!admin} aria-label=${t('settings.less')} @click=${() => set({ gap: step(GAPS, v.gap, -1) })}>−</button><output>${gap}</output><button ?disabled=${!admin} aria-label=${t('settings.more')} @click=${() => set({ gap: step(GAPS, v.gap, 1) })}>+</button></span>
            <span>${t('settings.n_daily')}</span>
            <span class="stepper"><button ?disabled=${!admin} aria-label=${t('settings.less')} @click=${() => set({ daily: step(DAILY, v.daily, -1) })}>−</button><output>${daily}</output><button ?disabled=${!admin} aria-label=${t('settings.more')} @click=${() => set({ daily: step(DAILY, v.daily, 1) })}>+</button></span>
          </div>`
        : nothing}
    </div>`;
  }

  override render() {
    const cfg = this._cfg;
    if (!cfg) return html`<p class="note">${t('settings.n_unavailable')}</p>`;
    const admin = this.store.admin;
    const q = cfg.quiet;
    const persons = this.store.persons.filter((p) => p.phone);
    const toggle = (pid: string, k: NotifyKind) => {
      const off = new Set(cfg.persons[pid]?.off ?? []);
      if (off.has(k)) off.delete(k);
      else off.add(k);
      this._save({ persons: { ...cfg.persons, [pid]: { off: [...off] } } });
    };
    return html`
      <div class="group">
        <div class="row wrap">
          ${icon(mdiBellOutline, 24)}
          <span class="grow"><div class="title">${t('settings.n_quiet')}</div><div class="sub">${q.on ? t('settings.n_quiet_sub') : t('settings.n_quiet_off')}</div></span>
          ${q.on
            ? html`<input class="time" type="time" aria-label=${t('settings.n_quiet_from')} .value=${q.from} ?disabled=${!admin} @change=${(e: Event) => this._save({ quiet: { ...q, from: (e.target as HTMLInputElement).value } })} />
                <span class="muted">${t('settings.until')}</span>
                <input class="time" type="time" aria-label=${t('settings.n_quiet_to')} .value=${q.to} ?disabled=${!admin} @change=${(e: Event) => this._save({ quiet: { ...q, to: (e.target as HTMLInputElement).value } })} />`
            : nothing}
          <button class="switch" role="switch" aria-label=${t('settings.n_quiet')} aria-checked=${q.on ? 'true' : 'false'} ?disabled=${!admin} @click=${() => this._save({ quiet: { ...q, on: !q.on } })}></button>
        </div>
        ${KINDS.map((k) => this._kind(k, cfg.kinds[k], cfg.today?.[k] ?? 0))}
      </div>
      ${persons.length
        ? html`<div class="group" style="margin-top: var(--hr-space-4)">
            ${persons.map(
              (p) => html`<div class="row wrap">
                <span class="grow"><div class="title">${p.name}</div><div class="sub">${t('settings.n_person_sub')}</div></span>
                <div class="kinds">
                  ${KINDS.map((k) => {
                    const on = !(cfg.persons[p.id]?.off ?? []).includes(k);
                    return html`<button aria-pressed=${on ? 'true' : 'false'} ?disabled=${!admin} @click=${() => toggle(p.id, k)}>${label(k)}</button>`;
                  })}
                </div>
              </div>`,
            )}
          </div>`
        : nothing}
      <p class="note">${t('settings.n_note')}</p>
    `;
  }
}
customElements.define('hr-notify-settings', HrNotifySettings);
