/**
 * <hr-heat-explain>: "So denkt deine Heizung" for one room (smart heating, smart_heat.py).
 * Today's plan as a timeline with reasons and how sure, the learned week as a heat map, the next hours
 * (target and expected room temperature), the last decisions with their reasons, what the guardrails
 * prevented, the shadow-mode comparison, what the room model learned and the cost estimate.
 * Loaded on demand (house_rules/heating/explain); nothing here is pushed live.
 */
import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { StoreElement } from '../base';
import { shared } from '../design/shared';
import type { HeatEnergyPeriod, HeatExplain } from '../model';
import { t } from '../i18n';
import { buildingLabel, levelLabel } from './heat-common';

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const GUARD: Record<string, string> = { max: 'nie über', min: 'nie unter', never: 'nicht heizen in der Zeit', occupied: 'jemand im Raum: mindestens' };
const n = (v: number | null | undefined, d = 1) => (v == null ? '–' : String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ','));
const deg = (v: number | null | undefined) => (v == null ? '–' : `${n(v)} °C`);
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`);
const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
const time = (t: number) => new Date(t * 1000).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const eur = (v: number | null | undefined) => (v == null ? '' : ` · ${v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`);

export class HrHeatExplain extends StoreElement {
  static override properties = { ...StoreElement.properties, room: { type: String }, _x: { state: true }, _err: { state: true } };
  declare room: string;
  declare _x: HeatExplain | null;
  declare _err: string;

  constructor() {
    super();
    this.room = '';
    this._x = null;
    this._err = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._load();
  }

  private async _load() {
    try {
      this._x = await this.store.heatingExplain(this.room);
      this._err = this._x ? '' : 'Noch keine Daten.';
    } catch (e) {
      this._err = (e as Error).message;
    }
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      section.card {
        padding: var(--hr-space-3) var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      h3 {
        margin: 0;
        font-size: var(--hr-text-body);
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin: 0;
        line-height: 1.4;
      }
      .tl {
        display: flex;
        height: 28px;
        border-radius: 8px;
        overflow: hidden;
        gap: 2px;
      }
      .tl i {
        display: block;
        height: 100%;
        min-width: 2px;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: var(--hr-text-caption);
        color: var(--hr-label-3);
        font-variant-numeric: tabular-nums;
      }
      ul.list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--hr-text-footnote);
      }
      ul.list b {
        font-variant-numeric: tabular-nums;
      }
      ul.list small {
        color: var(--hr-label-2);
      }
      .map {
        display: grid;
        grid-template-columns: 2em repeat(48, 1fr);
        gap: 1px;
        font-size: var(--hr-text-caption);
        color: var(--hr-label-2);
        align-items: center;
      }
      .map i {
        display: block;
        height: 14px;
        border-radius: 2px;
      }
      .legend {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-caption);
        color: var(--hr-label-2);
      }
      .legend .ramp {
        width: 90px;
        height: 8px;
        border-radius: 4px;
        background: linear-gradient(90deg, color-mix(in srgb, var(--hr-orange) 6%, var(--hr-surface)), var(--hr-orange));
      }
      .legend .sw {
        width: 14px;
        height: 3px;
        border-radius: 2px;
        background: var(--hr-orange);
      }
      .legend .sw.b {
        background: var(--hr-label-2);
      }
      svg {
        width: 100%;
        height: 120px;
        overflow: visible;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: var(--hr-space-2);
      }
      .kpi {
        background: var(--hr-bg);
        border-radius: 12px;
        padding: var(--hr-space-2) var(--hr-space-3);
      }
      .kpi b {
        display: block;
        font-size: var(--hr-text-title3, 20px);
        font-variant-numeric: tabular-nums;
      }
      .kpi small {
        color: var(--hr-label-2);
        font-size: var(--hr-text-caption);
      }
      .chain {
        margin: 2px 0 0;
        padding-left: 1.1em;
        color: var(--hr-label-2);
      }
    `,
  ];

  /** temperature → orange intensity (one hue, light to dark) */
  private _shade(t: number, lo: number, hi: number) {
    const k = hi > lo ? (t - lo) / (hi - lo) : 1;
    return `color-mix(in srgb, var(--hr-orange) ${Math.round(18 + 82 * Math.max(0, Math.min(1, k)))}%, var(--hr-surface))`;
  }

  private _today(x: HeatExplain) {
    const temps = x.today.map((s) => s.temp);
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const nowM = new Date().getHours() * 60 + new Date().getMinutes();
    return html`<section class="card">
      <h3>Heute</h3>
      <div class="tl" role="img" aria-label="Plan für heute">
        ${x.today.map((s) => html`<i title="${s.from}–${s.to}: ${deg(s.temp)} · ${levelLabel(s.level)} · ${s.why} · sicher ${pct(s.confidence)}" style="flex:${mins(s.to) - mins(s.from)};background:${this._shade(s.temp, lo, hi)}"></i>`)}
      </div>
      <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
      <ul class="list">
        ${x.today.map(
          (s) => html`<li style=${mins(s.from) <= nowM && nowM < mins(s.to === '24:00' ? '23:59' : s.to) ? 'font-weight:600' : ''}><b>${s.from}–${s.to}</b> ${deg(s.temp)} · ${levelLabel(s.level)} <small>· ${s.why} · sicher ${pct(s.confidence)}</small></li>`,
        )}
      </ul>
      <p class="note">So sieht ein üblicher Tag aus. Wer gerade da ist, ob alle weg sind und offene Fenster entscheiden im Moment selbst.</p>
    </section>`;
  }

  private _map(x: HeatExplain) {
    const h = x.habits;
    return html`<section class="card">
      <h3>Was ich gelernt habe</h3>
      <div class="map" role="img" aria-label="Belegung je Wochentag und Uhrzeit">
        ${x.heatmap.map(
          (row, d) => html`<span>${DAYS[d]}</span>${[...Array(48)].map((_v, i) => {
            const v = Math.round((row[2 * i] + row[2 * i + 1]) / 2);
            const hh = String(Math.floor(i / 2)).padStart(2, '0');
            return html`<i title="${DAYS[d]} ${hh}:${i % 2 ? '30' : '00'}: ${v} % der Tage jemand da" style="background:color-mix(in srgb, var(--hr-orange) ${Math.max(6, v)}%, var(--hr-surface))"></i>`;
          })}`,
        )}
      </div>
      <div class="axis" style="padding-left:2em"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
      <div class="legend"><span>selten</span><span class="ramp"></span><span>meist jemand da</span></div>
      <p class="note">
        ${x.days ? `Aus ${x.days} Tagen gelernt.` : 'Noch nichts gelernt – bis dahin gilt eine Schätzung nach dem Raumnamen.'}
        ${h.wake.work ? ` Werktags meist auf um ${h.wake.work}, ins Bett gegen ${h.sleep.work ?? '–'}.` : ''}
        ${h.wake.free ? ` Freie Tage: auf um ${h.wake.free}, ins Bett gegen ${h.sleep.free ?? '–'}.` : ''}
      </p>
    </section>`;
  }

  /** two series over time on one axis (°C): orange = target, grey = room / shadow */
  private _lines(a: (number | null)[], b: (number | null)[], labels: string[], la: string, lb: string): TemplateResult {
    const vals = [...a, ...b].filter((v): v is number => v != null);
    if (!vals.length) return html``;
    const lo = Math.floor(Math.min(...vals) - 0.5);
    const hi = Math.ceil(Math.max(...vals) + 0.5);
    const W = 300;
    const H = 100;
    const X = (i: number) => (labels.length > 1 ? (i / (labels.length - 1)) * W : 0);
    const Y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    const path = (s: (number | null)[], step: boolean) => {
      let d = '';
      s.forEach((v, i) => {
        if (v == null) return;
        if (!d) d = `M${X(i)},${Y(v)}`;
        else d += step ? `H${X(i)}V${Y(v)}` : `L${X(i)},${Y(v)}`;
      });
      return d;
    };
    const ticks = [0, Math.floor(labels.length / 2), labels.length - 1];
    return html`<svg viewBox="-28 -6 336 124" preserveAspectRatio="none" role="img" aria-label="${la} und ${lb}">
        ${svg`<line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="var(--hr-separator)" stroke-width="1"></line>
          <text x="-6" y="${Y(hi) + 4}" text-anchor="end" font-size="9" fill="var(--hr-label-3)">${hi}°</text>
          <text x="-6" y="${Y(lo) + 4}" text-anchor="end" font-size="9" fill="var(--hr-label-3)">${lo}°</text>
          ${ticks.map((i) => svg`<text x="${X(i)}" y="${H + 14}" text-anchor="middle" font-size="9" fill="var(--hr-label-3)">${labels[i]}</text>`)}
          <path d="${path(b, false)}" fill="none" stroke="var(--hr-label-2)" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"></path>
          <path d="${path(a, true)}" fill="none" stroke="var(--hr-orange)" stroke-width="2" vector-effect="non-scaling-stroke"></path>
          ${a.map((v, i) => (v == null ? nothing : svg`<circle cx="${X(i)}" cy="${Y(v)}" r="6" fill="transparent"><title>${labels[i]}: ${la} ${deg(v)}${b[i] != null ? `, ${lb} ${deg(b[i])}` : ''}</title></circle>`))}`}
      </svg>
      <div class="legend"><span class="sw"></span><span>${la}</span><span class="sw b"></span><span>${lb}</span></div>`;
  }

  private _forecast(x: HeatExplain) {
    if (!x.forecast.length) return nothing;
    return html`<section class="card">
      <h3>Die nächsten Stunden</h3>
      ${this._lines(
        x.forecast.map((f) => f.target),
        x.forecast.map((f) => f.temp),
        x.forecast.map((f) => f.t),
        'Ziel',
        'erwartete Raumtemperatur',
      )}
    </section>`;
  }

  private _decisions(x: HeatExplain) {
    return html`<section class="card">
      <h3>Letzte Entscheidungen</h3>
      ${x.decisions.length
        ? html`<ul class="list">
            ${x.decisions.slice(0, 8).map(
              (d) => html`<li><b>${time(d.t)}</b> ${deg(d.temp)} – ${d.why}${d.confidence != null ? html` <small>· sicher ${pct(d.confidence)}</small>` : nothing}
                  <ul class="chain">${d.chain.map((c) => html`<li>${c}</li>`)}</ul></li>`,
            )}
          </ul>`
        : html`<p class="note">Noch keine – sie erscheinen, sobald der Raum intelligent heizt.</p>`}
      ${x.guards.length
        ? html`<h3>Was die Grenzen verhindert haben</h3>
            <ul class="list">
              ${x.guards.slice(0, 5).map((g) => html`<li><b>${time(g.t)}</b> ${g.guards.map((h) => `${GUARD[h.guard]} ${deg(h.got)} (statt ${deg(h.wanted)})`).join(', ')}</li>`)}
            </ul>`
        : nothing}
    </section>`;
  }

  private _shadow(x: HeatExplain) {
    const rows = x.shadow.rows.filter((r) => r[1] != null || r[2] != null);
    if (!rows.length) return nothing;
    return html`<section class="card">
      <h3>So hätte ich geheizt</h3>
      ${this._lines(
        rows.map((r) => r[2]),
        rows.map((r) => r[1]),
        rows.map((r) => new Date(r[0] * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })),
        'intelligent',
        'wie geheizt wurde',
      )}
      <p class="note">${x.shadow.saved_pct != null ? (x.shadow.saved_pct > 0 ? `Etwa ${x.shadow.saved_pct} % weniger Wärme in der beobachteten Zeit (Schätzung).` : 'In der beobachteten Zeit etwa gleich viel Wärme.') : 'Noch zu wenig beobachtet für einen Vergleich.'}</p>
    </section>`;
  }

  private _period(label: string, p: HeatEnergyPeriod, rid: string) {
    const r = p.rooms[rid] ?? { kwh: 0, cost: 0, saved_kwh: 0 };
    return html`<div class="kpi"><small>${label}</small><b>${n(r.kwh)} kWh</b><small>${eur(p.cost != null ? r.cost : null).replace(' · ', '')}${r.saved_kwh > 0 ? ` · ${n(r.saved_kwh)} kWh gespart` : ''}</small></div>`;
  }

  private _model(x: HeatExplain) {
    const m = x.model;
    const e = x.energy;
    return html`<section class="card">
      <h3>Der Raum</h3>
      <p class="note">
        Heizt mit offenem Ventil etwa ${n(m.rate_now)} °C pro Stunde${x.outside != null ? ` bei ${deg(x.outside)} draußen` : ''}, von 18 auf 21 °C in etwa ${m.heat_3k_min} Min.; ohne Heizung kühlt er um etwa ${n(m.cool_per_h)} °C pro Stunde ab.
        ${m.confidence < 1 ? `Noch am Lernen (sicher ${pct(m.confidence)}).` : 'Gut gelernt.'}
        ${m.lag_min != null ? t(m.confidence < 1 ? 'heat.explain_prior' : 'heat.explain_lag', { building: buildingLabel(m.building), lag: m.lag_min }) : ''}
        ${m.door_per_h != null && Math.abs(m.door_per_h) >= 0.1 ? t(m.door_per_h > 0 ? 'heat.explain_door' : 'heat.explain_door_warm', { deg: n(Math.abs(m.door_per_h)) }) : ''}
        ${m.window_per_h != null && m.window_per_h >= 0.1 ? t('heat.explain_window', { deg: n(m.window_per_h) }) : ''}
      </p>
      <h3>Verbrauch (geschätzt)</h3>
      <div class="kpis">${this._period('Heute', e.today, x.room)}${this._period('7 Tage', e.week, x.room)}${this._period('30 Tage', e.month, x.room)}</div>
      <p class="note">
        ${e.from_meter ? `Aus dem Zähler (${e.meter.label}), auf die Räume verteilt nach Ventilstunden.` : `Ohne Zähler geschätzt: Heizkörper etwa ${n(e.radiator_w[x.room] ?? 0, 0)} W × Ventilstunden.`}
        „Gespart“ heißt: im Vergleich zu immer Komfort. Alles Schätzungen.
      </p>
    </section>`;
  }

  override render() {
    const x = this._x;
    if (!x) return html`<p class="note">${this._err || 'Lade …'}</p>`;
    const st = x.status;
    return html`
      ${st?.phase === 'shadow' ? html`<p class="note">Beobachtet noch ${n(st.shadow?.left ?? 0)} Tage und heizt bis dahin nach dem Zeitplan.</p>` : nothing}
      ${this._today(x)} ${this._map(x)} ${this._forecast(x)} ${this._decisions(x)} ${this._shadow(x)} ${this._model(x)}
    `;
  }
}
customElements.define('hr-heat-explain', HrHeatExplain);
