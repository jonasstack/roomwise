/**
 * <hr-home-view>: the area "Zuhause" (redesign, designed in the doku portal). Equal person tiles ("Wo ist wer", each
 * with its "zählt mit" switch – the one person selection for "alle weg" / "jemand da", house mode, alarm system and
 * vacation), below them tiles for the house mode and the places, and a status tile "Urlaub und Gäste" that leads to
 * the settings (Einstellungen → Urlaubsmodus). Everything else opens in pop-ups: a person, the house mode (switch by
 * hand, automatic switching), "Hausmodus automatisch" (hr-mode-auto) and the places (hr-places-view).
 * Places in the area: "mode-auto" opens the automatic switching, "places" the places, "residents" scrolls to the
 * persons; "vacation" (old links) goes on to the settings.
 */
import { css, html, nothing } from 'lit';
import { mdiAccountGroup, mdiAirplane, mdiBedClock, mdiChevronRight, mdiHome, mdiMapMarkerOutline, mdiWalk } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { featureHint } from '../components/feature';
import { registerPage } from '../components/page';
import { autoAssistant } from '../assistant/base';
import type { HouseMode } from '../model';
import type { Store } from '../store';
import { MODES } from '../vocabulary';
import { t, tn, type I18nKey } from '../i18n';
import { avatarStyles, personList, personTiles } from './where-view';
import { zoneRules } from './places-view';
import './mode-auto';
import './places-view';
import '../components/pop';
// i18n: complete

const MODE_ICONS: Record<HouseMode, string> = { home: mdiHome, away: mdiWalk, sleep: mdiBedClock, vacation: mdiAirplane, guests: mdiAccountGroup };

/** the line under the title: "Alex ist zuhause · Sam ist unterwegs" (counts when there are many) */
function homeSub(s: Store): string {
  // only who counts and whose whereabouts are known ("Tablet ist unterwegs" would be wrong)
  const people = personList(s).filter((p) => p.counts !== false && p.known);
  if (!people.length) return t('home.sub_nobody');
  if (people.length > 3) {
    const home = people.filter((p) => p.home).length;
    return `${tn('home.sub_n_home', home)} · ${tn('home.sub_n_away', people.length - home)}`;
  }
  return people.map((p) => t(p.home ? 'home.sub_is_home' : 'home.sub_is_away', { name: p.name })).join(' · ');
}

registerPage('home', { sub: homeSub });

export class HrHomeView extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _person: { state: true },
    _mode: { state: true },
    _auto: { state: true },
    _places: { state: true },
  };
  /** the person whose pop-up is open */
  declare _person: string | null;
  declare _mode: boolean;
  declare _auto: boolean;
  declare _places: boolean;

  constructor() {
    super();
    this._person = null;
    this._mode = false;
    this._auto = false;
    this._places = false;
  }

  static override styles = [
    shared,
    kit,
    avatarStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
      }
      .rl-lbl {
        margin-bottom: calc(-1 * var(--hr-space-2));
      }
      .big {
        font-size: var(--hr-text-body);
        font-weight: 600;
        line-height: 1.4;
      }
      .rl-tile.row {
        min-height: 0;
        flex-direction: row;
        align-items: center;
      }
      .note {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--hr-space-2);
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        margin-top: calc(-1 * var(--hr-space-2));
      }
      .note button {
        display: inline-flex;
        align-items: center;
        color: var(--hr-accent);
        font-weight: 600;
        font-size: inherit;
      }
      .modes {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 8px;
      }
      .modes > button {
        align-items: center;
        text-align: center;
        gap: 4px;
        padding: 10px 4px;
        min-height: 68px;
        font-size: var(--hr-text-footnote);
      }
      @media (max-width: 640px) {
        .modes {
          grid-template-columns: repeat(3, 1fr);
        }
      }
    `,
  ];

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    // the assistant for the automatic house mode opens by itself once, as when its list was on the page
    if (this.store.on('mode_auto')) autoAssistant(this, this.store, 'mode_auto');
  }

  protected override reveal(anchor: string): void {
    if (anchor === 'mode-auto') this._auto = true;
    else if (anchor === 'places') this._places = true;
    else if (anchor === 'vacation') fire(this, 'hr-tab', 'settings#urlaub');
    else super.reveal(anchor);
  }

  /** the alarm system counts other persons than the residents: say so (set up in the alarm area) */
  private _alarmDeviation() {
    const s = this.store;
    const sel = s.alarm?.config.presence?.persons ?? 'everyone';
    if (!s.on('alarm') || !s.alarm?.config.enabled || sel === 'everyone') return nothing;
    const names = s.persons.filter((p) => sel.includes(p.id)).map((p) => p.name);
    return html`<div class="note">
      <span>${names.length ? t('home.alarm_deviation', { names: names.join(', ') }) : t('home.alarm_deviation_none')}</span>
      <button @click=${() => fire(this, 'hr-tab', 'alarm#alarm-presence')}>${t('home.change')}${icon(mdiChevronRight, 18)}</button>
    </div>`;
  }

  private _modeTile() {
    const s = this.store;
    const ma = s.modeAuto;
    const auto = s.on('mode_auto') && !!ma?.enabled;
    const why = auto && ma && !ma.held && ma.why && ma.target === s.mode ? (/^(bis|until) /.test(ma.why) ? ma.why : t('home.because', { why: ma.why })) : ma?.held ? t('home.set_by_hand') : t(`home.mode_text_${s.mode}` as I18nKey);
    return html`<article class="rl-tile acc">
      <button class="rl-open" aria-label=${t('home.open_x', { x: t('home.house_mode') })} @click=${() => (this._mode = true)}></button>
      <div class="top"><span class="rl-ic">${icon(MODE_ICONS[s.mode], 24)}</span><div class="grow"><h2>${t('home.house_mode')}</h2></div><span class="go">${icon(mdiChevronRight, 20)}</span></div>
      <div class="big">${MODES[s.mode].label}</div>
      <div class="foot"><span>${why}</span><span class="rl-chip ${auto ? 'acc' : ''}">${t(auto ? 'home.auto_on_chip' : 'home.auto_off_chip')}</span></div>
    </article>`;
  }

  private _placesTile() {
    const s = this.store;
    const nRules = new Set(s.zones.flatMap((z) => zoneRules(s.rules, z).map((r) => r.id))).size;
    const learned = s.places?.learned.length ?? 0;
    const at = (s.places?.persons ?? []).filter((p) => p.state === 'zone' && p.place_name).map((p) => t('home.at_place', { name: p.name, place: p.place_name! }));
    return html`<article class="rl-tile acc">
      <button class="rl-open" aria-label=${t('home.open_x', { x: t('home.places') })} @click=${() => (this._places = true)}></button>
      <div class="top"><span class="rl-ic">${icon(mdiMapMarkerOutline, 24)}</span><div class="grow"><h2>${t('home.places')}</h2></div><span class="go">${icon(mdiChevronRight, 20)}</span></div>
      <div class="big">${tn('home.n_zones', s.zones.length)} · ${tn('panel.rules_count', nRules)}</div>
      <div class="foot"><span>${at[0] ?? t('home.zones_from_ha')}</span>${learned ? html`<span class="rl-chip warm">${tn('home.n_learned', learned)}</span>` : nothing}</div>
    </article>`;
  }

  private _vacationTile() {
    const s = this.store;
    const state = s.mode === 'vacation' ? t('home.vac_now') : s.mode === 'guests' ? t('home.guests_now') : t('home.vac_status_none');
    const active = s.mode === 'vacation' || s.mode === 'guests';
    return html`<article class="rl-tile row">
      <button class="rl-open" aria-label=${t('home.vac_to_settings')} @click=${() => fire(this, 'hr-tab', 'settings#urlaub')}></button>
      <span class="rl-ic">${icon(mdiAirplane, 24)}</span>
      <div class="grow"><h2>${t('home.vac_guests')}</h2><div class="state">${state} ${t('home.vac_status_where')}</div></div>
      <span class="rl-chip ${active ? 'acc' : ''}">${t(active ? 'home.active' : 'home.inactive')}</span>
      <span class="go">${icon(mdiChevronRight, 20)}</span>
    </article>`;
  }

  private _modePop() {
    const s = this.store;
    const ma = s.modeAuto;
    const close = () => (this._mode = false);
    const sub = html`<span class="rl-chip acc">${t('page.mode_now', { mode: MODES[s.mode].label })}</span>${ma?.held ? html`<span class="rl-chip">${t('home.set_by_hand')}</span>` : ma?.why && ma.target === s.mode ? html`<span class="rl-chip">${t('home.because', { why: ma.why })}</span>` : nothing}`;
    return html`<hr-pop heading=${t('home.house_mode')} .sub=${sub} @close=${close}>
      <div class="rl-sec">
        <span class="eyebrow">${t('home.by_hand')}</span>
        <div class="rl-tg modes" role="radiogroup" aria-label=${t('home.house_mode')}>
          ${(Object.keys(MODE_ICONS) as HouseMode[]).map(
            (m) => html`<button role="radio" aria-pressed=${s.mode === m ? 'true' : 'false'} aria-checked=${s.mode === m ? 'true' : 'false'} @click=${() => s.setMode(m)}>${icon(MODE_ICONS[m], 22)}${MODES[m].label}</button>`,
          )}
        </div>
      </div>
      <div class="rl-info">
        <div>${(Object.keys(MODE_ICONS) as HouseMode[]).map((m) => html`<b>${MODES[m].label}:</b> ${t(`home.mode_text_${m}` as I18nKey)}. `)}</div>
      </div>
      <div class="rl-box">
        <div class="line">
          <div class="grow"><b>${t('page.mode_auto')}</b><small>${t('page.mode_auto_sub')}</small></div>
          <button class="btn small" @click=${() => (this._auto = true)}>${t('page.mode_set')}</button>
        </div>
      </div>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _autoPop() {
    const s = this.store;
    const close = () => (this._auto = false);
    return html`<hr-pop heading=${t('home.auto_pop_title')} .sub=${t('home.auto_pop_sub')} @close=${close}>
      ${s.on('mode_auto') ? html`<hr-mode-auto .store=${s}></hr-mode-auto>` : featureHint(this, 'mode_auto', t('home.manual_only_hint'))}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    const people = personList(s);
    return html`
      <span class="eyebrow rl-lbl" id="residents">${t('home.where')}</span>
      ${people.length ? personTiles(s, (e) => (this._person = e)) : html`<p class="rl-note">${t('home.no_persons')}</p>`}
      ${this._alarmDeviation()}
      <div class="rl-grid">${this._modeTile()} ${this._placesTile()}</div>
      ${this._vacationTile()}
      ${this._person ? html`<hr-person-pop .store=${s} .entityId=${this._person} @close=${() => (this._person = null)}></hr-person-pop>` : nothing}
      ${this._mode ? this._modePop() : nothing} ${this._auto ? this._autoPop() : nothing}
      ${this._places ? html`<hr-places-view .store=${s} @close=${() => (this._places = false)}></hr-places-view>` : nothing}
    `;
  }
}
customElements.define('hr-home-view', HrHomeView);
