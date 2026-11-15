/**
 * <hr-light-smart>: the intelligent light of a room in the "Licht" area (lightlearn.py).
 * Off · Probelauf ("so hätte ich geschaltet", nothing is switched) · On; per light what it wants right now and why
 * ("Warum ist das Licht so?", also for what rules or a person did), how often it matched what you did by hand,
 * what it learned per time of day, the guardrails (always win) and own hard rules on top (a light rule of the room).
 * Drawn as the body of the pop-up "Intelligentes Licht" of a room (light-view.ts).
 */
import { css, html, nothing } from 'lit';
import { mdiHelpCircleOutline, mdiMinus, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import type { Clause, LightPlan, LightRule, LightSmart, Room, SmartLearned } from '../model';
import '../components/conditions';

const DEFAULT: LightSmart = { mode: 'off', lights: [], only_dark: true, slots: [], guards: { max: 100, night_max: 30, night_warm: true, off_while: [] } };

export class HrLightSmart extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    room: { attribute: false },
    _learned: { state: true },
    _why: { state: true },
  };
  declare room: Room;
  declare _learned: SmartLearned | null;
  /** lights whose explanation is open */
  declare _why: string[];
  private _loadedFor = '';

  constructor() {
    super();
    this._learned = null;
    this._why = [];
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
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
      summary b {
        display: block;
      }
      summary .sub {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      details[open] > summary .chev {
        transform: rotate(180deg);
      }
      .brain {
        color: var(--hr-accent);
      }
      .inner {
        padding: 0 var(--hr-space-4) var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .label {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        margin: var(--hr-space-2) var(--hr-space-1) 0;
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin: 0;
        line-height: 1.4;
      }
      ul.why {
        margin: 4px 0 0;
        padding-left: 1.1em;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.45;
      }
      .want {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        white-space: nowrap;
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper button {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 0;
        background: var(--hr-fill);
        color: var(--hr-label);
        display: grid;
        place-items: center;
        cursor: pointer;
      }
      .stepper output {
        min-width: 56px;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--hr-text-footnote);
      }
      th,
      td {
        text-align: left;
        padding: 6px 4px;
        border-bottom: 0.5px solid var(--hr-separator);
        vertical-align: top;
      }
      th {
        color: var(--hr-label-2);
        font-weight: 600;
      }
      td small {
        display: block;
        color: var(--hr-label-3);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .scroll {
        overflow-x: auto;
      }
      .row.wrap {
        flex-wrap: wrap;
      }
    `,
  ];

  private get _plan(): LightPlan | undefined {
    return this.store.plans?.light[this.room.id];
  }
  private get _smart(): LightSmart {
    return { ...DEFAULT, ...(this._plan?.smart ?? {}) };
  }

  override updated(): void {
    // what was learned: again when the room changes or a new example came in
    const samples = this.store.plans?.now[this.room.id]?.light?.smart?.samples ?? 0;
    const key = `${this.room.id}:${samples}:${this._smart.mode}`;
    if (key !== this._loadedFor && this._smart.mode !== 'off') {
      this._loadedFor = key;
      this.store
        .lightLearned(this.room.id)
        .then((l) => (this._learned = l))
        .catch(() => undefined);
    }
  }

  private _save(patch: Partial<LightSmart>) {
    const p = this._plan;
    if (p) this.store.planSet('light', this.room.id, { ...p, smart: { ...this._smart, ...patch } });
  }

  private _name(id: string) {
    return this.store.device(id)?.name ?? this.store.entity(id)?.name ?? id;
  }

  private _stepper(value: number, unit: string, set: (v: number) => void, step: number, min: number, max: number) {
    return html`<span class="stepper">
      <button aria-label="weniger" @click=${() => set(Math.max(min, value - step))}>${icon(mdiMinus, 18)}</button>
      <output>${value} ${unit}</output>
      <button aria-label="mehr" @click=${() => set(Math.min(max, value + step))}>${icon(mdiPlus, 18)}</button>
    </span>`;
  }

  /** "Warum ist das Licht so?" for every light of the room */
  private _now() {
    const s = this.store;
    const st = s.plans?.now[this.room.id]?.light;
    const sm = st?.smart;
    const lights = s.devices.filter((d) => d.kind === 'light' && d.room === this.room.id);
    if (!lights.length) return nothing;
    const shadow = sm?.mode === 'shadow';
    return html`<span class="label">Warum ist das Licht so?</span>
      <div class="group">
        ${lights.map((d) => {
          const w = sm?.lights?.[d.entity_id];
          const open = this._why.includes(d.entity_id);
          const plan = st?.lights?.[d.entity_id];
          const want = w ? (w.mode === 'off' ? 'aus' : `${w.brightness} %, ${w.kelvin} K`) : '';
          const reasons = [...(plan ? [plan.startsWith('Intelligent') ? '' : `Gerade: ${plan}.`] : []), ...(w?.why ?? [])].filter(Boolean);
          return html`<div class="row wrap">
            <span class="grow">
              <div class="title">${d.name}</div>
              <div class="sub">${d.detail ?? d.state}${w ? html` · ${shadow ? 'hätte geschaltet' : 'will'}: <span class="want">${want}</span>` : st?.occupied === false ? ' · niemand da' : ''}</div>
              ${open ? html`<ul class="why">${reasons.length ? reasons.map((r) => html`<li>${r}</li>`) : html`<li>Gerade entscheidet nichts über dieses Licht.</li>`}</ul>` : nothing}
            </span>
            <button class="icon-btn" aria-label="Warum?" title="Warum?" aria-expanded=${open ? 'true' : 'false'} @click=${() => (this._why = open ? this._why.filter((x) => x !== d.entity_id) : [...this._why, d.entity_id])}>${icon(mdiHelpCircleOutline, 20)}</button>
          </div>`;
        })}
      </div>`;
  }

  private _agreement() {
    const sm = this.store.plans?.now[this.room.id]?.light?.smart;
    const ag = sm?.agree ?? this._learned?.agree;
    if (!ag?.n) return html`<p class="note">Noch kein Vergleich. Stell das Licht ein paar Mal selbst ein, dann zeigt sich hier, wie oft es genauso geschaltet hätte.</p>`;
    return html`<p class="note"><b>${ag.same} von ${ag.n}</b> Mal, als ihr das Licht selbst eingestellt habt, hätte es genauso geschaltet.${this._smart.mode === 'shadow' && ag.n >= 5 && ag.same / ag.n >= 0.7 ? ' Das passt gut, du kannst es einschalten.' : ''}</p>`;
  }

  private _table() {
    const l = this._learned;
    if (!l) return nothing;
    const lights = Object.keys(l.slots[0]?.lights ?? {});
    if (!lights.length) return nothing;
    return html`<span class="label">Gelernt je Tageszeit (${l.samples} ${l.samples === 1 ? 'Einstellung' : 'Einstellungen'} von Hand)</span>
      <div class="scroll"><table>
        <tr><th></th>${lights.map((e) => html`<th>${this._name(e)}</th>`)}</tr>
        ${l.slots.map(
          (sl) => html`<tr>
            <th>${sl.label}<small>${sl.from}–${sl.to}</small></th>
            ${lights.map((e) => {
              const x = sl.lights[e];
              return html`<td>${x.on ? `${x.brightness} %, ${x.kelvin} K` : 'aus'}<small>${x.learned >= 1 ? `gelernt (${Math.round(x.learned)})` : 'Startwert'}</small></td>`;
            })}
          </tr>`,
        )}
      </table></div>`;
  }

  /** the learned scenes as an own light rule of the room ("Solange jemand da ist" with a variant per time of day) */
  private _adopt() {
    const p = this._plan;
    const l = this._learned;
    if (!p || !l?.slots.length) return;
    const lights = Object.keys(l.slots[0].lights);
    const avg = (sl: SmartLearned['slots'][number]) => {
      const on = lights.map((e) => sl.lights[e]).filter((x) => x.on);
      const b = on.length ? Math.round(on.reduce((a, x) => a + x.brightness, 0) / on.length) : 0;
      const k = on.length ? Math.round(on.reduce((a, x) => a + x.kelvin, 0) / on.length / 100) * 100 : 2700;
      return { mode: on.length ? ('on' as const) : ('off' as const), brightness: Math.max(1, b), color: `k:${k}` as const };
    };
    const when: Clause[] = [{ subject: `room:${this.room.id}`, verb: 'is_occupied' }];
    if (this._smart.only_dark) when.push({ subject: `room:${this.room.id}`, verb: 'is_dark' });
    const rule: LightRule = {
      id: Math.random().toString(36).slice(2, 8),
      name: 'Gelernt: Licht je Tageszeit',
      enabled: true,
      kind: 'while',
      trigger: [],
      when,
      lights: [],
      action: avg(l.slots[0]),
      variants: l.slots.map((sl) => ({ id: Math.random().toString(36).slice(2, 8), when: [{ subject: 'time', verb: 'between', from: sl.from, to: sl.to }], ...avg(sl) })),
      after: 'others',
      empty_after: 'off',
      follow_empty: true,
    };
    // the rule now decides: the intelligent part steps back (learning stops, nothing is lost)
    this.store.planSet('light', this.room.id, { ...p, rules: [...p.rules, rule], smart: { ...this._smart, mode: 'off' } });
    fire(this, 'hr-toast', 'Als Lichtregel übernommen');
  }

  override render() {
    const p = this._plan;
    if (!p) return nothing;
    const sm = this._smart;
    const g = sm.guards;
    return html`<div class="inner">
        <p class="note">Lernt aus dem, was ihr von Hand einstellt (Tageszeit, Helligkeit, Weißton, wer zuhause ist, wie hell es draußen ist), und macht es dann selbst. Die Grenzen unten und eigene Lichtregeln gehen immer vor. Gespeichert wird nur in deinem Home Assistant.</p>
        <span class="label">Betriebsart</span>
        <div class="seg" role="group" aria-label="Intelligentes Licht">
          <button aria-pressed=${sm.mode === 'off' ? 'true' : 'false'} @click=${() => this._save({ mode: 'off' })}>Aus</button>
          <button aria-pressed=${sm.mode === 'shadow' ? 'true' : 'false'} @click=${() => this._save({ mode: 'shadow' })}>Probelauf</button>
          <button aria-pressed=${sm.mode === 'on' ? 'true' : 'false'} @click=${() => this._save({ mode: 'on' })}>An</button>
        </div>
        ${sm.mode === 'off'
          ? html`<p class="note">Im Probelauf schaltet es nichts, sondern zeigt hier, wie es geschaltet hätte.</p>`
          : html`${this._agreement()} ${this._now()} ${this._table()}
              <div class="actions">
                <button class="btn small" ?disabled=${!this._learned?.samples} @click=${() => this._adopt()}>Als eigene Lichtregel übernehmen</button>
                <button class="btn small" ?disabled=${!this._learned?.samples} @click=${() => this.store.lightForget(this.room.id).then(() => ((this._learned = null), (this._loadedFor = '')))}>Gelerntes vergessen</button>
              </div>`}
        <span class="label">Grenzen, die immer gelten</span>
        <div class="group">
          <div class="row wrap"><span class="grow"><div class="title">Nie heller als</div></span>${this._stepper(g.max, '%', (v) => this._save({ guards: { ...g, max: Math.max(5, v) } }), 5, 5, 100)}</div>
          <div class="row wrap"><span class="grow"><div class="title">Nachts höchstens</div><div class="sub">„nachts“ wie unter Einstellungen → Wörter in Regeln</div></span>${this._stepper(g.night_max, '%', (v) => this._save({ guards: { ...g, night_max: Math.max(1, v) } }), 5, 0, 100)}</div>
          <div class="row"><span class="grow"><div class="title">Nachts nur warmweiß</div></span><button class="switch" role="switch" aria-label="Nachts nur warmweiß" aria-checked=${g.night_warm ? 'true' : 'false'} @click=${() => this._save({ guards: { ...g, night_warm: !g.night_warm } })}></button></div>
          <div class="row"><span class="grow"><div class="title">Nur, wenn es dunkel ist</div><div class="sub">Lichtsensor des Raums, sonst die Sonne</div></span><button class="switch" role="switch" aria-label="Nur, wenn es dunkel ist" aria-checked=${sm.only_dark ? 'true' : 'false'} @click=${() => this._save({ only_dark: !sm.only_dark })}></button></div>
        </div>
        <hr-conditions .store=${this.store} .clauses=${g.off_while} joiner="oder" heading="Aus lassen, solange" @change=${(e: CustomEvent<Clause[]>) => this._save({ guards: { ...g, off_while: e.detail } })}></hr-conditions>
        <div class="actions">
          <button class="btn small tinted" @click=${() => fire(this, 'hr-light-new-rule', { room: this.room.id })}>Eigene feste Regel dazu</button>
        </div>
      </div>`;
  }
}
customElements.define('hr-light-smart', HrLightSmart);

/** short state of a room's intelligent light: "aus" / "Probelauf" / "an" (tiles and the room pop-up) */
export function smartLabel(mode: LightSmart['mode'] | undefined): string {
  return mode === 'shadow' ? 'Probelauf' : mode === 'on' ? 'an' : 'aus';
}
