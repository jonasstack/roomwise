/**
 * <hr-settings-view>: the area "Einstellungen" since the redesign: equal tiles, each opens a pop-up. Funktionen (the one
 * place that switches parts on/off), the setup wizard, the Urlaubsmodus (vacation and guests, content <hr-vacation>),
 * words used by rules, notifications, roles, the AI connection, the floor plan card, backup and restore, the trash
 * (with hidden suggestions), anonymous diagnostics and what removing Hausregeln does.
 * Links into it: place "urlaub", "woerter", "features", "setup", "notifications", "roles", "ai", "floorplan", "backup",
 * "trash", "telemetry", "remove" open that pop-up (/hausregeln/settings#urlaub, hr-tab "settings#woerter").
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  mdiAccountKeyOutline,
  mdiAirplane,
  mdiBellOutline,
  mdiBrain,
  mdiChartBoxOutline,
  mdiChevronRight,
  mdiCompassOutline,
  mdiContentSaveOutline,
  mdiDeleteOutline,
  mdiFloorPlan,
  mdiFormatQuoteOpen,
  mdiHomeRemoveOutline,
  mdiOpenInNew,
  mdiRestore,
  mdiToggleSwitchOutline,
} from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { LiveStore, type Settings } from '../live';
import type { FeatureId } from '../model';
import type { Store } from '../store';
import { FEATURES, FEATURE_ORDER } from '../components/feature';
import { registerPage } from '../components/page';
import '../components/pop';
import './ai-settings';
import './vacation';
import { fmtNumber, t, tn } from '../i18n';
// i18n: complete
import './backup';
import './telemetry-settings';
import { findFloorplanViews, floorplanAvailable, openPath } from '../setup/dashboard';
import './roles-settings';
import './notify-settings';
import './trash';

type Pop = 'features' | 'setup' | 'vacation' | 'words' | 'notifications' | 'roles' | 'ai' | 'floorplan' | 'backup' | 'trash' | 'telemetry' | 'remove';

/** places in this area (links, deep links) → pop-up; the German names are the ones other areas link to */
const PLACES: Record<string, Pop> = {
  urlaub: 'vacation',
  vacation: 'vacation',
  woerter: 'words',
  words: 'words',
  features: 'features',
  funktionen: 'features',
  setup: 'setup',
  notifications: 'notifications',
  roles: 'roles',
  ai: 'ai',
  floorplan: 'floorplan',
  backup: 'backup',
  trash: 'trash',
  telemetry: 'telemetry',
  remove: 'remove',
};

const shownFeatures = (): FeatureId[] => FEATURE_ORDER.filter((f) => FEATURES[f]);

registerPage('settings', {
  sub: (s: Store) => {
    const fs = shownFeatures();
    const on = fs.filter((f) => s.on(f)).length;
    const parts = [t('settings.sub_features', { n: on, of: fs.length })];
    parts.push(s.mode === 'vacation' ? t('settings.vac_on') : s.mode === 'guests' ? t('settings.guests_on') : t('settings.sub_vac_off'));
    return parts.join(' · ');
  },
});

export class HrSettingsView extends StoreElement {
  static override properties = { ...StoreElement.properties, _plans: { state: true }, _pop: { state: true } };
  /** dashboard views with the floor plan card; null while looking */
  declare _plans: { title: string; path: string }[] | null;
  /** the open pop-up */
  declare _pop: Pop | null;

  constructor() {
    super();
    this._plans = null;
    this._pop = null;
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
      }
      .rl-grid {
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      }
      .rl-tile {
        min-height: 150px;
      }
      .rl-tile h2 {
        white-space: nowrap;
      }
      @media (max-width: 640px) {
        .rl-grid {
          grid-template-columns: 1fr;
        }
        .rl-tile {
          min-height: 0;
        }
      }
      .rl-tile .big {
        font-size: var(--hr-text-subhead);
        font-weight: 600;
        line-height: 1.4;
      }
      .rl-tile .big b {
        font-weight: 700;
      }
      .rl-tile.danger .rl-ic {
        background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
        color: var(--hr-red);
      }
      .need {
        color: color-mix(in srgb, var(--hr-orange) 75%, var(--hr-label));
      }
      .open {
        display: inline-flex;
        align-items: center;
        color: var(--hr-accent);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        white-space: nowrap;
      }
      .rl-item .ic.f {
        color: var(--hr-accent);
      }
      .rl-item.off .ic.f {
        color: var(--hr-label-3);
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 56px;
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
      .words .rl-item {
        flex-wrap: wrap;
      }
      .ver {
        color: var(--hr-label-3);
        font-size: var(--hr-text-caption);
      }
      .ro {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .lead {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        line-height: 1.45;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    // read once when the settings open (only reads the dashboards)
    if (floorplanAvailable(this.store)) findFloorplanViews(this.store).then((p) => (this._plans = p), () => (this._plans = []));
  }

  /** a link to a place in this area opens its pop-up */
  protected override reveal(anchor: string): void {
    const p = PLACES[anchor];
    if (p) this._pop = p;
    else super.reveal(anchor);
  }

  private _close = () => (this._pop = null);

  private _feature(f: FeatureId) {
    const s = this.store;
    const m = FEATURES[f];
    const on = s.on(f);
    const blocked = !!m.needs && !s.on(m.needs);
    const target = m.tab ?? m.in;
    const go = () => {
      // a place in the settings themselves (the Urlaubsmodus): switch pop-ups, no navigation
      if (target?.startsWith('settings#')) this._pop = PLACES[target.slice(9)] ?? null;
      else {
        this._close();
        fire(this, 'hr-tab', target);
      }
    };
    return html`<div class="rl-item ${on ? '' : 'off'}">
      <span class="ic f">${icon(m.icon, 24)}</span>
      <span class="grow"><b>${m.label}</b><small>${m.sub}${blocked ? html` <span class="need">${t('settings.needs', { name: FEATURES[m.needs!].label })}</span>` : nothing}</small></span>
      ${on && target ? html`<button class="open" @click=${go}>${t('settings.open')}${icon(mdiChevronRight, 18)}</button>` : nothing}
      <button class="switch" role="switch" aria-label=${m.label} aria-checked=${on ? 'true' : 'false'} ?disabled=${!s.haAdmin} @click=${() => this._toggle(f, !on)}></button>
    </div>`;
  }

  /** Everything switched off in one place: whole functions and the switched-off parts of the heating */
  private _offList() {
    const s = this.store;
    const off = shownFeatures().filter((f) => !s.on(f));
    const g = s.on('heating') ? s.plans?.heating?.config : undefined;
    const parts: [string, string, () => void][] = [];
    if (g) {
      if (!g.summer.on) parts.push([t('heat.off_summer'), t('heat.off_summer_sub'), () => s.heatingSet({ summer: { ...g.summer, on: true } })]);
      if (!g.demand.on) parts.push([t('heat.off_demand'), t('heat.off_demand_sub'), () => s.heatingSet({ demand: { ...g.demand, on: true } })]);
      if (!g.exercise.on) parts.push([t('heat.off_exercise'), t('heat.off_exercise_sub'), () => s.heatingSet({ exercise: { ...g.exercise, on: true } })]);
      if (!g.notify.length && s.persons.length) parts.push([t('heat.off_notify'), t('heat.off_notify_sub'), () => s.heatingSet({ notify: s.persons.map((p) => p.id) })]);
    }
    if (!off.length && !parts.length) return nothing;
    return html`<div class="rl-sec">
      <h3>${t('settings.f_off')}</h3>
      <div class="rl-list">
        ${off.map((f) => this._feature(f))}
        ${parts.map(
          ([title, sub, on]) => html`<div class="rl-item off">
            <span class="grow"><b>${t('settings.f_heating_part', { name: title })}</b><small>${sub}</small></span>
            <button class="btn small" ?disabled=${!s.haAdmin} @click=${on}>${t('heat.turn_on')}</button>
          </div>`,
        )}
      </div>
      <p class="rl-note">${t('settings.f_off_note')}</p>
    </div>`;
  }

  private async _toggle(f: FeatureId, on: boolean) {
    const s = this.store;
    // urlaubssimulation needs the light: switching it on switches the light on too
    const patch: Partial<Record<FeatureId, boolean>> = { [f]: on };
    if (on && FEATURES[f].needs && !s.on(FEATURES[f].needs!)) patch[FEATURES[f].needs!] = true;
    await s.featuresSet(patch);
    fire(this, 'hr-toast', t(on ? 'settings.feature_switched_on' : 'settings.feature_switched_off', { name: FEATURES[f].label }));
  }

  /** one tile: icon, title, what it is, a state line; opens its pop-up */
  private _tile(p: Pop, ic: string, title: string, what: string, state: TemplateResult | string, chip?: TemplateResult) {
    return html`<div class="rl-tile ${p === 'remove' ? 'danger' : ''}" id=${p}>
      <button class="rl-open" aria-label=${title} @click=${() => (this._pop = p)}></button>
      <div class="top">
        <span class="rl-ic">${icon(ic, 24)}</span>
        <span class="grow"><h2>${title}</h2><div class="state">${what}</div></span>
        <span class="go">${icon(mdiChevronRight, 20)}</span>
      </div>
      <div class="big">${state}</div>
      ${chip ? html`<div class="foot">${chip}</div>` : nothing}
    </div>`;
  }

  private _settings() {
    const s = this.store;
    const live = s instanceof LiveStore ? s : undefined;
    const st = (live?.settings ?? {}) as Settings & { eco_temp?: number };
    const times = st.times ?? { night: [22, 6], morning: [6, 10], evening: [18, 22] };
    const save = (patch: Record<string, unknown>) => {
      if (live) live.settings = { ...live.settings, ...patch } as Settings;
      s.saveSettings(patch);
      this.requestUpdate();
    };
    return { live, times, eco: st.eco_temp ?? 17, save };
  }

  /** the pop-up content */
  private _popup(p: Pop) {
    const s = this.store;
    const { live, times, eco, save } = this._settings();
    const done = html`<button slot="foot" class="btn primary" @click=${this._close}>${t('common.done')}</button>`;
    switch (p) {
      case 'features':
        return html`<hr-pop heading=${t('settings.features')} .sub=${t('settings.sub_features', { n: shownFeatures().filter((f) => s.on(f)).length, of: shownFeatures().length })} @close=${this._close}>
          <p class="lead">${t('settings.features_lead')}</p>
          ${s.haAdmin ? nothing : html`<p class="ro">${t('settings.admins_only')}</p>`}
          <div class="rl-sec">
            <h3>${t('settings.f_on')}</h3>
            <div class="rl-list">${shownFeatures().filter((f) => s.on(f)).map((f) => this._feature(f))}</div>
          </div>
          ${this._offList()}
          ${done}
        </hr-pop>`;
      case 'setup': {
        const setup = s.setup;
        const resume = setup && !setup.done && setup.step !== 'welcome';
        return html`<hr-pop narrow heading=${t('settings.setup')} .sub=${t('settings.wizard')} @close=${this._close}>
          <div class="rl-box">
            <div class="line">
              <span class="rl-ic small">${icon(mdiCompassOutline, 22)}</span>
              <span class="grow"><b>${t('settings.wizard')}</b><small>${t('settings.wizard_text')}</small></span>
            </div>
          </div>
          ${s.haAdmin ? nothing : html`<p class="ro">${t('settings.admins_only')}</p>`}
          <button slot="foot" class="btn" @click=${this._close}>${t('common.close')}</button>
          <button slot="foot" class="btn primary" ?disabled=${!s.haAdmin} @click=${() => (this._close(), fire(this, 'hr-setup', { restart: !resume }))}>${resume ? t('settings.resume') : t('settings.start')}</button>
        </hr-pop>`;
      }
      case 'vacation':
        return html`<hr-pop heading=${t('settings.vacation')} .sub=${t('settings.vacation_sub')} @close=${this._close}>
          <hr-vacation .store=${s}></hr-vacation>
          ${done}
        </hr-pop>`;
      case 'words': {
        const hour = (name: string, i: 0 | 1) => {
          const h = (times[name] ?? [0, 0]) as [number, number];
          const set = (d: number) => save({ times: { ...times, [name]: i === 0 ? [(h[0] + d + 24) % 24, h[1]] : [h[0], (h[1] + d + 24) % 24] } });
          return html`<span class="stepper"><button aria-label=${t('settings.earlier')} @click=${() => set(-1)}>−</button><output>${h[i]}:00</output><button aria-label=${t('settings.later')} @click=${() => set(1)}>+</button></span>`;
        };
        return html`<hr-pop narrow heading=${t('settings.words')} @close=${this._close}>
          <p class="lead">${t('settings.words_lead')}</p>
          <div class="rl-list words">
            ${(
              [
                ['night', t('settings.word_night')],
                ['morning', t('settings.word_morning')],
                ['evening', t('settings.word_evening')],
              ] as const
            ).map(([k, label]) => html`<div class="rl-item"><span class="grow"><b>${label}</b></span>${hour(k, 0)}<span class="muted">${t('settings.until')}</span>${hour(k, 1)}</div>`)}
            <div class="rl-item">
              <span class="grow"><b>${t('settings.eco')}</b><small>${t('settings.eco_sub')}</small></span>
              <span class="stepper"><button aria-label=${t('settings.less')} @click=${() => save({ eco_temp: eco - 0.5 })}>−</button><output>${fmtNumber(eco)} °C</output><button aria-label=${t('settings.more')} @click=${() => save({ eco_temp: eco + 0.5 })}>+</button></span>
            </div>
          </div>
          <p class="rl-note">${t('settings.words_note')}</p>
          ${done}
        </hr-pop>`;
      }
      case 'notifications':
        return html`<hr-pop heading=${t('settings.notifications')} @close=${this._close}>
          <p class="lead">${t('settings.notifications_lead')}</p>
          ${live ? html`<hr-notify-settings .store=${s}></hr-notify-settings>` : html`<p class="ro">${t('settings.live_only')}</p>`}
          ${done}
        </hr-pop>`;
      case 'roles':
        return html`<hr-pop heading=${t('rel.roles_title')} @close=${this._close}>
          <p class="lead">${t('rel.roles_lead')}</p>
          ${live ? html`<hr-roles-settings .store=${s}></hr-roles-settings>` : html`<p class="ro">${t('settings.live_only')}</p>`}
          ${done}
        </hr-pop>`;
      case 'ai':
        return html`<hr-pop heading=${t('settings.ai')} .sub=${t('settings.ai_sub')} @close=${this._close}>
          ${s.on('ai')
            ? html`<hr-ai-settings .store=${s} @saved=${() => fire(this, 'hr-toast', t('settings.ai_saved'))}></hr-ai-settings>`
            : html`<div class="rl-info">${icon(mdiBrain, 20)}<span>${t('settings.feature_off', { name: FEATURES.ai.label })} ${FEATURES.ai.sub}</span></div>
                ${s.haAdmin ? html`<div><button class="btn tinted" @click=${() => this._toggle('ai', true)}>${t('settings.switch_on')}</button></div>` : html`<p class="ro">${t('settings.admins_only')}</p>`}`}
          ${done}
        </hr-pop>`;
      case 'floorplan': {
        const plans = this._plans;
        return html`<hr-pop narrow heading=${t('settings.floorplan')} @close=${this._close}>
          <p class="lead">${t('settings.floorplan_lead')}</p>
          <div class="rl-list">
            ${plans === null
              ? html`<div class="rl-item"><span class="grow"><small>${t('settings.floorplan_looking')}</small></span></div>`
              : plans.length
                ? plans.map(
                    (pl) => html`<button class="rl-item" @click=${() => openPath(pl.path)}>
                      <span class="ico">${icon(mdiFloorPlan, 20)}</span><span class="grow"><b>${pl.title}</b><small>${pl.path}</small></span><span class="open">${t('settings.open')}${icon(mdiChevronRight, 18)}</span>
                    </button>`,
                  )
                : html`<div class="rl-item">
                    <span class="ico">${icon(mdiFloorPlan, 20)}</span><span class="grow"><b>${t('settings.floorplan_none')}</b><small>${t('settings.floorplan_none_sub')}</small></span>
                  </div>`}
          </div>
          ${done}
        </hr-pop>`;
      }
      case 'backup':
        return html`<hr-pop heading=${t('settings.backup')} @close=${this._close}>
          ${live ? html`<hr-backup .store=${s}></hr-backup>` : html`<p class="ro">${t('settings.live_only')}</p>`}
          ${done}
        </hr-pop>`;
      case 'trash':
        return html`<hr-pop heading=${t('rel.trash_title')} .sub=${t('settings.trash_sub')} @close=${this._close}>
          <hr-trash .store=${s} open></hr-trash>
          <div class="rl-list">
            <button class="rl-item" @click=${() => s.restoreSuggestions().then(() => fire(this, 'hr-toast', t('settings.suggestions_restored')))}>
              <span class="ico">${icon(mdiRestore, 20)}</span><span class="grow"><b>${t('settings.restore_suggestions')}</b><small>${t('settings.restore_suggestions_sub')}</small></span>
            </button>
          </div>
          ${done}
        </hr-pop>`;
      case 'telemetry':
        return html`<hr-pop heading=${t('settings.telemetry')} @close=${this._close}>
          <p class="lead">${t('settings.telemetry_lead')}</p>
          <hr-telemetry-settings .store=${s}></hr-telemetry-settings>
          ${done}
        </hr-pop>`;
      case 'remove':
        return html`<hr-pop narrow heading=${t('rel.remove_title')} @close=${this._close}>
          <p class="lead">${t('rel.remove_text')}</p>
          <div class="rl-info">${icon(mdiHomeRemoveOutline, 20)}<span>${t('settings.remove_here')}</span></div>
          <button slot="foot" class="btn" @click=${this._close}>${t('common.close')}</button>
          ${live ? html`<button slot="foot" class="btn" @click=${() => (this._pop = 'backup')}>${icon(mdiContentSaveOutline, 18)}${t('settings.remove_backup_first')}</button>` : nothing}
          ${s.haAdmin ? html`<button slot="foot" class="btn tinted" @click=${() => openPath('/config/integrations/integration/house_rules')}>${icon(mdiOpenInNew, 18)}${t('settings.remove_to_ha')}</button>` : nothing}
        </hr-pop>`;
    }
  }

  override render() {
    const s = this.store;
    const { live, times, eco } = this._settings();
    const fs = shownFeatures();
    const on = fs.filter((f) => s.on(f)).length;
    const setup = s.setup;
    const ai = s.ai;
    const aiOn = s.on('ai') && ai && ai.provider !== 'none';
    const night = (times.night ?? [22, 6]) as [number, number];
    const vacAuto = s.modeAuto?.enabled && s.modeAuto.modes?.vacation?.on;
    const plans = this._plans;
    return html`
      <div class="rl-grid">
        ${this._tile('features', mdiToggleSwitchOutline, t('settings.features'), t('settings.features_what'), html`<b>${t('settings.sub_features', { n: on, of: fs.length })}</b>`)}
        ${this._tile(
          'setup',
          mdiCompassOutline,
          t('settings.setup'),
          t('settings.wizard'),
          setup?.done ? t('settings.setup_done') : setup && setup.step !== 'welcome' ? t('settings.setup_open') : t('settings.setup_new'),
          setup?.done ? html`<span class="rl-chip yes">${t('settings.chip_done')}</span>` : html`<span class="rl-chip warm">${t('settings.chip_open')}</span>`,
        )}
        ${this._tile(
          'vacation',
          mdiAirplane,
          t('settings.vacation'),
          t('settings.vacation_sub'),
          s.mode === 'vacation' ? t('settings.vac_on') : s.mode === 'guests' ? t('settings.guests_on') : t('settings.vac_off'),
          s.mode === 'vacation' || s.mode === 'guests'
            ? html`<span class="rl-chip acc">${t('settings.chip_active')}</span>`
            : vacAuto
              ? html`<span class="rl-chip">${t('settings.vac_auto')}</span>`
              : undefined,
        )}
        ${this._tile('words', mdiFormatQuoteOpen, t('settings.words'), t('settings.words_what'), t('settings.words_state', { from: night[0], to: night[1], eco: fmtNumber(eco) }))}
        ${live ? this._tile('notifications', mdiBellOutline, t('settings.notifications'), t('settings.notifications_what'), t('settings.notifications_state')) : nothing}
        ${live ? this._tile('roles', mdiAccountKeyOutline, t('rel.roles_title'), t('settings.roles_what'), t('settings.roles_state')) : nothing}
        ${this._tile(
          'ai',
          mdiBrain,
          t('settings.ai'),
          t('settings.ai_sub'),
          aiOn ? html`<b>${ai!.providers[ai!.provider]?.label ?? ai!.provider}</b>${ai!.model ? ` · ${ai!.model}` : ''}` : t('settings.ai_tile_none'),
          aiOn ? html`<span class="rl-chip yes">${t('settings.chip_connected')}</span>` : html`<span class="rl-chip">${t('common.off')}</span>`,
        )}
        ${floorplanAvailable(s)
          ? this._tile(
              'floorplan',
              mdiFloorPlan,
              t('settings.floorplan'),
              t('settings.floorplan_what'),
              plans === null ? t('settings.floorplan_looking') : plans.length ? tn('settings.floorplan_n', plans.length) : t('settings.floorplan_none'),
            )
          : nothing}
        ${live ? this._tile('backup', mdiContentSaveOutline, t('settings.backup'), t('settings.backup_what'), t('settings.backup_state')) : nothing}
        ${this._tile('trash', mdiDeleteOutline, t('rel.trash_title'), t('settings.trash_what'), t('settings.trash_sub'))}
        ${this._tile('telemetry', mdiChartBoxOutline, t('settings.telemetry'), t('settings.telemetry_what_short'), t('settings.telemetry_state'))}
        ${this._tile('remove', mdiHomeRemoveOutline, t('rel.remove_title'), t('settings.remove_what'), t('settings.remove_state'))}
      </div>
      <p class="ver">${t('settings.version', { version: live?.version ?? '' })}</p>
      ${this._pop ? this._popup(this._pop) : nothing}
    `;
  }
}
customElements.define('hr-settings-view', HrSettingsView);
