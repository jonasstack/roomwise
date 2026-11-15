/**
 * <hr-places-view>: the pop-up "Orte" of the area "Zuhause" (redesign). The places (Home Assistant zones) with who is
 * there and how many rules use them; a zone's rules open in their own pop-up with one-tap starts ("Wenn jemand die
 * Arbeit verlässt …"). Below them the learned places (name, turn into a zone, forget – admins); the gear in the head
 * holds the settings for learning (learn places and ways, place names from OpenStreetMap – off by default). Fires "close".
 */
import { css, html, nothing } from 'lit';
import { mdiCogOutline, mdiMapMarkerOutline, mdiMapMarkerPlusOutline, mdiPencilOutline, mdiPlus, mdiTrashCanOutline } from '@mdi/js';
import { StoreElement } from '../base';
import type { Clause, LearnedPlace, Rule, Zone } from '../model';
import { newRule } from '../store';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { ruleCard, ruleCardStyles } from '../components/rule-card';
import { t, tn, type I18nKey } from '../i18n';
import '../components/pop';
// i18n: complete

/** Is a person in this zone (person state = zone name, or "home")? */
function inZone(zone: Zone, raw?: string): boolean {
  if (!raw) return false;
  return zone.id === 'home' ? raw === 'home' : raw.toLowerCase() === zone.name.toLowerCase() || raw.toLowerCase() === zone.id;
}

function uses(zone: Zone, c: Clause): boolean {
  if (!c.subject.startsWith('person:')) return false;
  if (['enters_zone', 'leaves_zone', 'in_zone', 'not_in_zone'].includes(c.verb)) return (c.zone ?? 'home') === zone.id;
  return zone.id === 'home' && ['arrives', 'leaves', 'is_home', 'is_away', 'coming_home', 'is_near'].includes(c.verb);
}

/** rules that use a zone */
export function zoneRules(rules: Rule[], z: Zone): Rule[] {
  return rules.filter((r) => [...r.when, ...r.and, ...r.only].some((c) => uses(z, c)));
}

export class HrPlacesView extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _zone: { state: true },
    _learn: { state: true },
    _act: { state: true },
    _name: { state: true },
  };
  /** the zone whose rules are open */
  declare _zone: string | null;
  /** the settings for learning are open */
  declare _learn: boolean;
  /** an action on a learned place is open */
  declare _act: { kind: 'name' | 'zone' | 'forget'; place: LearnedPlace } | null;
  declare _name: string;

  constructor() {
    super();
    this._zone = null;
    this._learn = false;
    this._act = null;
    this._name = '';
  }

  static override styles = [
    shared,
    kit,
    ruleCardStyles,
    css`
      .zic {
        width: 40px;
        height: 40px;
        border-radius: var(--hr-radius-m);
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
        flex: none;
      }
      .here {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .acts {
        display: flex;
        gap: 2px;
      }
      .rules {
        display: grid;
        gap: var(--hr-space-2);
      }
      .starters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .starters .btn {
        font-family: var(--hr-font-sentence);
      }
      input.name {
        width: 100%;
        min-height: 44px;
        padding: 0 var(--hr-space-3);
        border-radius: var(--hr-radius-m);
        border: 0;
        background: var(--hr-fill);
        font-size: var(--hr-text-body);
      }
      label.field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
    `,
  ];

  private _close = () => this.dispatchEvent(new CustomEvent('close'));

  private _start(when: Clause, name: string) {
    fire(this, 'hr-open-rule', { isNew: true, rule: newRule({ name, when: [when] }) });
  }

  private _here(z: Zone) {
    return this.store.persons.filter((p) => inZone(z, p.zone ?? (p.home ? 'home' : undefined)));
  }

  private _zoneLine(z: Zone) {
    const here = this._here(z);
    const n = zoneRules(this.store.rules, z).length;
    return html`<div class="line">
      <span class="zic">${icon(z.icon || mdiMapMarkerOutline, 22)}</span>
      <div class="grow">
        <b>${z.name}</b><small>${z.radius ? t('home.radius', { m: Math.round(z.radius) }) : ''}${z.passive ? t('home.passive') : ''}</small>
        <div class="here">${here.length ? here.map((p) => html`<span class="rl-chip yes">${p.name}</span>`) : html`<span class="rl-chip">${t('home.nobody_here')}</span>`}</div>
      </div>
      <button class="btn small ${n ? 'tinted' : ''}" @click=${() => (this._zone = z.id)}>${n ? tn('panel.rules_count', n) : t('home.no_rules')}</button>
    </div>`;
  }

  private _info(p: LearnedPlace) {
    const tp = p.typical;
    return [
      tn('home.visits', p.visits),
      t(`home.days_${tp.days}` as I18nKey),
      tp.arrive ? t('home.arrive_from', { time: tp.arrive }) : '',
      t('home.stay_min', { min: tp.stay_min }),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private _learned(p: LearnedPlace) {
    const admin = this.store.admin;
    const act = (kind: 'name' | 'zone' | 'forget') => {
      this._name = p.name || '';
      this._act = { kind, place: p };
    };
    return html`<div class="line">
      <div class="grow"><b>${p.label}</b><small>${this._info(p)}</small></div>
      ${admin
        ? html`<span class="acts">
            <button class="icon-btn" title=${t('home.place_name')} aria-label=${t('home.place_name')} @click=${() => act('name')}>${icon(mdiPencilOutline, 20)}</button>
            <button class="icon-btn" title=${t('home.place_zone')} aria-label=${t('home.place_zone')} @click=${() => act('zone')}>${icon(mdiMapMarkerPlusOutline, 20)}</button>
            <button class="icon-btn" title=${t('home.place_forget')} aria-label=${t('home.place_forget')} @click=${() => act('forget')}>${icon(mdiTrashCanOutline, 20)}</button>
          </span>`
        : nothing}
    </div>`;
  }

  private _zonePop(z: Zone) {
    const s = this.store;
    const rules = zoneRules(s.rules, z);
    const here = this._here(z);
    const handlers = { open: (r: Rule) => fire(this, 'hr-open-rule', { rule: structuredClone(r) }), toggle: (r: Rule, v: boolean) => s.setEnabled(r.id, v) };
    const starters: [Clause, string][] =
      z.id === 'home'
        ? [
            [{ subject: 'person:someone', verb: 'arrives' }, t('home.start_arrives')],
            [{ subject: 'person:everyone', verb: 'leaves' }, t('home.start_leaves')],
            [{ subject: 'person:someone', verb: 'coming_home' }, t('home.start_coming_home')],
          ]
        : [
            [{ subject: 'person:someone', verb: 'enters_zone', zone: z.id }, t('home.start_enters_zone', { zone: z.name })],
            [{ subject: 'person:someone', verb: 'leaves_zone', zone: z.id }, t('home.start_leaves_zone', { zone: z.name })],
          ];
    const sub = html`${z.radius ? html`<span class="rl-chip">${t('home.radius', { m: Math.round(z.radius) })}</span>` : nothing}${here.length
        ? html`<span class="rl-chip yes">${t('home.is_here', { names: here.map((p) => p.name).join(', ') })}</span>`
        : html`<span class="rl-chip">${t('home.nobody_here')}</span>`}`;
    return html`<hr-pop narrow heading=${t('home.zone_rules', { zone: z.name })} .sub=${sub} @close=${() => (this._zone = null)}>
      ${rules.length ? html`<div class="rules">${rules.map((r) => ruleCard(s, r, handlers, { compact: true }))}</div>` : html`<p class="rl-note">${t('home.zone_no_rule')}</p>`}
      <div class="rl-sec">
        <span class="eyebrow">${t('home.start_rule')}</span>
        <div class="starters">${starters.map(([c, label]) => html`<button class="btn small tinted" @click=${() => this._start(c, label)}>${icon(mdiPlus, 16)}${label} …</button>`)}</div>
      </div>
      <button slot="foot" class="btn primary" @click=${() => (this._zone = null)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _learnPop() {
    const s = this.store;
    const v = s.places!;
    return html`<hr-pop narrow heading=${t('home.learn_settings')} @close=${() => (this._learn = false)}>
      <div class="rl-box">
        <div class="line">
          <div class="grow"><b>${t('home.learn_ways')}</b><small>${t('home.learn_ways_sub')}</small></div>
          <button class="switch" role="switch" aria-label=${t('home.learn_ways')} aria-checked=${v.settings.learn ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => s.placesSettings({ learn: !v.settings.learn })}></button>
        </div>
        <div class="line">
          <div class="grow"><b>${t('home.streets')}</b><small>${t('home.streets_sub')}</small></div>
          <button class="switch" role="switch" aria-label=${t('home.streets')} aria-checked=${v.settings.nominatim ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => s.placesSettings({ nominatim: !v.settings.nominatim })}></button>
        </div>
      </div>
      <button slot="foot" class="btn primary" @click=${() => (this._learn = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _actPop() {
    const s = this.store;
    const { kind, place: p } = this._act!;
    const close = () => (this._act = null);
    const name = this._name.trim();
    const run = async () => {
      if (kind === 'name') await s.placesName(p.id, name);
      else if (kind === 'zone') await s.placesToZone(p.id, name);
      else await s.placesDelete(p.id);
      close();
    };
    const field = html`<label class="field">${t('home.place_name_label')}
      <input class="name" .value=${this._name} @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && (kind === 'name' || name) && run()} />
    </label>`;
    const head = { name: t('home.place_name'), zone: t('home.place_zone'), forget: t('home.place_forget_q') }[kind];
    return html`<hr-pop narrow heading=${head} .sub=${p.label} @close=${close}>
      ${kind === 'forget' ? html`<p class="rl-note">${t('home.place_forget_text', { place: p.label })}</p>` : field}
      ${kind === 'name' ? html`<p class="rl-note">${t('home.place_name_text')}</p>` : nothing}
      ${kind === 'zone' ? html`<p class="rl-note">${t('home.place_zone_text')}</p>` : nothing}
      <button slot="foot" class="btn" @click=${close}>${t('common.cancel')}</button>
      <button slot="foot" class="btn ${kind === 'forget' ? 'danger' : 'primary'}" ?disabled=${kind === 'zone' && !name} @click=${run}>
        ${{ name: t('common.save'), zone: t('home.place_zone_do'), forget: t('home.place_forget_do') }[kind]}
      </button>
    </hr-pop>`;
  }

  override render() {
    const s = this.store;
    const v = s.places;
    const learned = v?.learned ?? [];
    const nRules = new Set(s.zones.flatMap((z) => zoneRules(s.rules, z).map((r) => r.id))).size;
    const sub = html`<span class="rl-chip">${tn('home.n_zones', s.zones.length)}</span>${v ? html`<span class="rl-chip">${tn('home.n_learned', learned.length)}</span>` : nothing}${nRules
        ? html`<span class="rl-chip acc">${tn('panel.rules_count', nRules)}</span>`
        : nothing}`;
    const zone = this._zone ? s.zones.find((z) => z.id === this._zone) : undefined;
    return html`<hr-pop heading=${t('home.places')} .sub=${sub} @close=${this._close}>
        ${v && s.admin
          ? html`<button slot="head" class="icon-btn" aria-label=${t('home.learn_settings')} title=${t('home.learn_settings')} @click=${() => (this._learn = true)}>${icon(mdiCogOutline, 22)}</button>`
          : nothing}
        <div class="rl-sec">
          <span class="eyebrow">${t('home.zones_people')}</span>
          ${s.zones.length ? html`<div class="rl-box">${s.zones.map((z) => this._zoneLine(z))}</div>` : html`<p class="rl-note">${t('home.no_places')}</p>`}
          <span class="rl-note">${t('home.places_lead')}</span>
        </div>
        ${v
          ? html`<div class="rl-sec">
              <span class="eyebrow">${t('home.learned_places')}</span>
              ${learned.length
                ? html`<div class="rl-box">${learned.map((p) => this._learned(p))}</div>`
                : html`<p class="rl-note">${v.stats.warming ? t('home.learning_now') : t('home.learned_none')}</p>`}
            </div>`
          : nothing}
        <button slot="foot" class="btn primary" @click=${this._close}>${t('common.done')}</button>
      </hr-pop>
      ${zone ? this._zonePop(zone) : nothing} ${this._learn && v ? this._learnPop() : nothing} ${this._act ? this._actPop() : nothing}`;
  }
}
customElements.define('hr-places-view', HrPlacesView);
