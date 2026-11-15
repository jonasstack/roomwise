/**
 * "Wo ist wer" in the area "Zuhause" (redesign): <hr-person-pop> is the pop-up of one person tile. Status line from
 * the server ("Arbeit · seit 8:12", "Unterwegs · wahrscheinlich nach Hause · ca. 12 Min."), the way home, whether
 * the person counts as resident ("alle weg", house mode, alarm, vacation), which of their phones get messages, a
 * small map with Home Assistant's own <ha-map> (left out when the map element cannot be loaded) and today's
 * timeline. personTiles() draws the equal tiles on the page. Fires "close".
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { mdiCellphone, mdiChevronRight } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import type { PlaceDetail, PlacePerson } from '../model';
import type { Store } from '../store';
import { fmtNumber, fmtTime, t, type I18nKey } from '../i18n';
import '../components/pop';
// i18n: complete

let mapLoading: Promise<boolean> | undefined;
/** Home Assistant's map element is loaded lazily by its map card: ask the card helpers for one, then use <ha-map>. */
export function ensureMap(): Promise<boolean> {
  if (customElements.get('ha-map')) return Promise.resolve(true);
  mapLoading ??= (async () => {
    const wait = () => Promise.race([customElements.whenDefined('ha-map'), new Promise((r) => setTimeout(r, 5000))]);
    try {
      const helpers = await (window as unknown as { loadCardHelpers?: () => Promise<{ createCardElement(c: object): unknown }> }).loadCardHelpers?.();
      if (helpers) {
        helpers.createCardElement({ type: 'map', entities: ['zone.home'] });
        await wait();
      }
    } catch {
      /* try the next way */
    }
    if (!customElements.get('ha-map')) {
      // opened directly (dashboards not loaded yet): let Home Assistant's panel resolver load its map panel's code
      try {
        await Promise.race([customElements.whenDefined('partial-panel-resolver'), new Promise((r) => setTimeout(r, 3000))]);
        const ppr = document.createElement('partial-panel-resolver') as HTMLElement & { hass?: unknown; _updateRoutes?: () => void; routerOptions?: { routes?: Record<string, { load?: () => Promise<unknown> }> } };
        ppr.hass = { panels: [{ url_path: 'hr-map-loader', component_name: 'map' }] };
        ppr._updateRoutes?.();
        await ppr.routerOptions?.routes?.['hr-map-loader']?.load?.();
        await wait();
      } catch {
        /* no map: the list is enough */
      }
    }
    return !!customElements.get('ha-map');
  })();
  return mapLoading;
}

const PERSON_STATES = ['home', 'not_home', 'unknown', 'unavailable'];
const stateWord = (st: string) => (PERSON_STATES.includes(st) ? t(`home.person_${st}` as I18nKey) : st);

/** one person as the page knows it: the resident switch, the place line from the server, the phones */
export interface PersonInfo {
  entity_id: string;
  name: string;
  /** counts as resident (null: no resident list from the server) */
  counts: boolean | null;
  tracked: boolean;
  home: boolean;
  moving: boolean;
  /** where the person is, is known (tracked and not "unknown") */
  known: boolean;
  /** status line */
  line: string;
  picture?: string | null;
  place?: PlacePerson;
}

/** everyone with a person entity: residents (with "zählt mit") merged with the places view (status line, picture) */
export function personList(s: Store): PersonInfo[] {
  const places = s.places?.persons ?? [];
  const base = s.residents.length
    ? s.residents.map((r) => ({ entity_id: r.entity_id, name: r.name, counts: r.counts as boolean | null, tracked: r.tracked, state: r.state }))
    : s.persons.map((p) => ({ entity_id: p.entity_id ?? p.id, name: p.name, counts: null, tracked: true, state: p.home ? 'home' : 'not_home' }));
  return base.map((b) => {
    const pl = places.find((x) => x.entity_id === b.entity_id);
    const home = pl ? pl.state === 'zone' && pl.place === 'home' : b.state === 'home' || !!s.persons.find((p) => (p.entity_id ?? p.id) === b.entity_id)?.home;
    return {
      entity_id: b.entity_id,
      name: b.name,
      counts: b.counts,
      tracked: b.tracked,
      home,
      moving: pl?.state === 'moving',
      known: pl ? pl.state !== 'unknown' : b.tracked && !['unknown', 'unavailable'].includes(b.state),
      line: pl?.line || (b.tracked ? stateWord(b.state) : t('home.no_tracking')),
      picture: pl?.picture,
      place: pl,
    };
  });
}

/** the resident switch: tap = counts or not for "alle weg", house mode, alarm and vacation */
export function toggleCounts(s: Store, entity: string): void {
  const excluded = s.residents.filter((p) => !p.counts).map((p) => p.entity_id);
  s.residentsSet(excluded.includes(entity) ? excluded.filter((x) => x !== entity) : [...excluded, entity]);
}

/** the equal person tiles of "Wo ist wer"; `open` opens a person's pop-up */
export function personTiles(s: Store, open: (entity: string) => void): TemplateResult {
  return html`<div class="rl-grid">
    ${personList(s).map((p) => {
      const phones = s.persons.find((x) => (x.entity_id ?? x.id) === p.entity_id);
      const getting = (phones?.phones_found ?? []).filter((ph) => (phones?.phones ?? []).includes(ph));
      const foot = phones?.phones_found?.length
        ? getting.length
          ? t('home.phones_get', { phones: getting.map(phoneName).join(', ') })
          : t('home.phones_none')
        : p.tracked
          ? ''
          : t('home.no_tracking');
      return html`<article class="rl-tile small ${p.counts === false ? 'off' : ''}">
        <button class="rl-open" aria-label=${t('home.person_open', { name: p.name })} @click=${() => open(p.entity_id)}></button>
        <div class="top">
          <span class="av ${p.home ? 'home' : p.moving ? 'moving' : ''}" style=${p.picture ? `background-image:url("${p.picture}")` : ''}>${p.picture ? '' : p.name.slice(0, 1)}</span>
          <div class="grow"><h3>${p.name}</h3><div class="state">${p.line}</div></div>
          <span class="go">${icon(mdiChevronRight, 20)}</span>
        </div>
        <div class="foot">
          <span>${foot}</span>
          ${p.counts === null
            ? nothing
            : html`<span class="counts over">
                <span class="rl-chip ${p.counts ? 'yes' : ''}">${t(p.counts ? 'home.counts' : 'home.not_counted')}</span>
                <button class="switch" role="switch" aria-label=${t('home.person_counts', { name: p.name })} aria-checked=${p.counts ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => toggleCounts(s, p.entity_id)}></button>
              </span>`}
        </div>
      </article>`;
    })}
  </div>`;
}

const phoneName = (ph: string) => ph.replace(/^mobile_app_/, '').replace(/_/g, ' ');

/** avatar styles shared by the page tiles and the pop-up */
export const avatarStyles = css`
  .av {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 800;
    font-size: var(--hr-text-title3);
    background: var(--hr-fill) center / cover no-repeat;
    color: var(--hr-label-2);
    flex: none;
  }
  .av.home {
    background-color: color-mix(in srgb, var(--hr-green) var(--hr-tint), transparent);
    color: var(--hr-green);
  }
  .av.moving {
    background-color: color-mix(in srgb, var(--hr-orange) var(--hr-tint), transparent);
    color: var(--hr-orange);
  }
  .counts {
    display: inline-flex;
    align-items: center;
    gap: var(--hr-space-2);
  }
`;

export class HrPersonPop extends StoreElement {
  static override properties = { ...StoreElement.properties, entityId: { type: String }, _detail: { state: true }, _map: { state: true } };
  declare entityId: string;
  declare _detail: PlaceDetail | null | undefined;
  declare _map: boolean;

  constructor() {
    super();
    this.entityId = '';
    this._detail = undefined;
    this._map = false;
  }

  static override styles = [
    shared,
    kit,
    avatarStyles,
    css`
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
        font-size: var(--hr-text-footnote);
      }
      .timeline li {
        display: flex;
        gap: var(--hr-space-2);
      }
      .timeline time {
        flex: none;
        width: 100px;
        color: var(--hr-label-2);
        font-variant-numeric: tabular-nums;
      }
      .timeline .trip {
        color: var(--hr-label-2);
      }
      .map {
        height: 240px;
        border-radius: var(--hr-radius-l);
        overflow: hidden;
        box-shadow: var(--hr-shadow-1);
      }
      ha-map {
        display: block;
        height: 100%;
      }
      .phones {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .phones button {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 32px;
        padding: 0 12px;
        border-radius: var(--hr-radius-full);
        font-size: var(--hr-text-footnote);
        background: var(--hr-fill);
        color: var(--hr-label-2);
        text-decoration: line-through;
      }
      .phones button[aria-pressed='true'] {
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-label);
        text-decoration: none;
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!this._map && (this.store as { hass?: unknown }).hass) void ensureMap().then((ok) => (this._map = ok));
    if (changed.has('entityId')) {
      this._detail = undefined;
      const pl = this.store.places?.persons.find((p) => p.entity_id === this.entityId);
      if (pl)
        this.store.placesPerson(pl.id).then(
          (d) => (this._detail = d),
          () => (this._detail = null),
        );
      else this._detail = null;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    // learned places as circles on the map (Leaflet comes with ha-map once it has loaded)
    const map = this.renderRoot.querySelector('ha-map') as (HTMLElement & { Leaflet?: any; layers?: unknown[]; _hrKey?: string }) | null;
    const learned = this.store.places?.learned ?? [];
    const key = learned.map((p) => `${p.id}${p.lat}${p.lon}${p.radius}`).join();
    if (!map || map._hrKey === key) return;
    const draw = (tries: number) => {
      const L = map.Leaflet;
      if (!L) {
        if (tries > 0) setTimeout(() => draw(tries - 1), 500);
        return;
      }
      try {
        map.layers = learned.map((p) => L.circle([p.lat, p.lon], { radius: p.radius, color: '#a24fd6', weight: 2, fillOpacity: 0.12 }).bindTooltip(p.label));
        map._hrKey = key;
      } catch {
        /* an older map element: zones and persons only */
      }
    };
    draw(10);
  }

  private _close = () => this.dispatchEvent(new CustomEvent('close'));

  private _timeline() {
    const d = this._detail;
    if (d === undefined) return html`<p class="rl-note">${t('home.loading')}</p>`;
    if (!d?.timeline.length) return html`<p class="rl-note">${t('home.today_nothing')}</p>`;
    const span = (from: string, to: string | null) => `${fmtTime(from)}${to ? `–${fmtTime(to)}` : ''}`;
    return html`<div class="rl-box">
      <ul class="timeline">
        ${d.timeline.map((e) =>
          e.kind === 'stay'
            ? html`<li><time>${span(e.from, e.to)}</time><span>${e.name}</span></li>`
            : html`<li class="trip"><time>${span(e.from, e.to)}</time><span>${e.to_name ? t('home.trip_to', { from: e.from_name, to: e.to_name }) : t('home.trip_from', { from: e.from_name })}</span></li>`,
        )}
      </ul>
    </div>`;
  }

  private _phones() {
    const s = this.store;
    const person = s.persons.find((x) => (x.entity_id ?? x.id) === this.entityId);
    const found = person?.phones_found ?? [];
    if (!found.length) return nothing;
    const off = s.persons.flatMap((x) => (x.phones_found ?? []).filter((ph) => !(x.phones ?? []).includes(ph)));
    const toggle = (ph: string) => s.phonesSet(off.includes(ph) ? off.filter((x) => x !== ph) : [...off, ph]);
    return html`<div class="line">
      <div class="grow">
        <b>${t('home.phones')}</b><small>${t('home.phones_hint')}</small>
        <div class="phones" style="margin-top:8px">
          ${found.map(
            (ph) => html`<button aria-pressed=${off.includes(ph) ? 'false' : 'true'} ?disabled=${!s.admin} title=${t(off.includes(ph) ? 'home.phone_off' : 'home.phone_on')} @click=${() => toggle(ph)}>
              ${icon(mdiCellphone, 14)}${phoneName(ph)}
            </button>`,
          )}
        </div>
      </div>
    </div>`;
  }

  override render() {
    const s = this.store;
    const p = personList(s).find((x) => x.entity_id === this.entityId);
    if (!p) return nothing;
    const pl = p.place;
    const pred = pl?.prediction;
    const hass = (s as { hass?: unknown }).hass;
    const entities = [p.entity_id, ...s.zones.map((z) => z.entity_id)];
    const sub = html`<span class="rl-chip ${p.home ? 'yes' : p.moving ? 'warm' : ''}">${p.home ? t('home.person_home') : p.moving ? t('home.moving') : pl?.place_name || stateWord(p.home ? 'home' : 'not_home')}</span>${pl?.since
        ? html`<span class="rl-chip">${t('home.since_time', { time: fmtTime(pl.since) })}</span>`
        : nothing}`;
    return html`<hr-pop narrow heading=${p.name} .sub=${sub} @close=${this._close}>
      <div class="rl-box">
        <div class="line"><div class="grow"><b>${t('home.stay')}</b><small>${p.line}${pl?.street ? ` · ${pl.street}` : ''}</small></div></div>
        ${pred && pred.eta_min != null
          ? html`<div class="line"><div class="grow"><b>${pred.destination === 'home' ? t('home.way_home') : t('home.way_to', { place: pred.name })}</b><small>${t('home.eta', { min: fmtNumber(pred.eta_min, 0) })}</small></div></div>`
          : nothing}
        ${pl?.distance_home_km != null && !p.home
          ? html`<div class="line"><div class="grow"><b>${t('home.distance')}</b><small>${t('home.distance_km', { km: fmtNumber(pl.distance_home_km, pl.distance_home_km < 10 ? 1 : 0) })}</small></div></div>`
          : nothing}
        ${p.counts === null
          ? nothing
          : html`<div class="line">
              <div class="grow"><b>${t('home.counts_title')}</b><small>${t('home.counts_sub')}</small></div>
              <button class="switch" role="switch" aria-label=${t('home.person_counts', { name: p.name })} aria-checked=${p.counts ? 'true' : 'false'} ?disabled=${!s.admin} @click=${() => toggleCounts(s, p.entity_id)}></button>
            </div>`}
        ${this._phones()}
      </div>
      ${this._map && hass && pl ? html`<div class="map"><ha-map .hass=${hass} .entities=${entities} .autoFit=${true} .fitZones=${true}></ha-map></div>` : nothing}
      ${pl ? html`<div class="rl-sec"><span class="eyebrow">${t('home.today')}</span>${this._timeline()}</div>` : nothing}
      <button slot="foot" class="btn primary" @click=${this._close}>${t('common.done')}</button>
    </hr-pop>`;
  }
}
customElements.define('hr-person-pop', HrPersonPop);
