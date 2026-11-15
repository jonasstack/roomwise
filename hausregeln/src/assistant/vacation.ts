/**
 * <hr-assistant-vacation>: assistant of the feature "Urlaubssimulation". Rooms → learned or fixed times →
 * fixed limits (never between …, how bright) → summary; afterwards an own hard rule for the vacation can be
 * added with the normal rule editor (it always goes first).
 */
import { html, nothing } from 'lit';
import { mdiBrain, mdiClockOutline } from '@mdi/js';
import { newRule } from '../store';
import { fire } from '../design/shared';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';

interface VRoom {
  id: string;
  name: string;
  lights: number;
  plan_on: boolean;
  vacation: boolean;
}

export class HrAssistantVacation extends HrAssistantBase {
  readonly feature = 'vacation' as const;
  readonly label = 'Urlaub';

  protected steps(): AStep[] {
    return [
      { id: 'rooms', title: 'In welchen Räumen?', keys: ['rooms'], required: true },
      { id: 'how', title: 'Gelernt oder feste Zeiten?', keys: ['smart', 'people', 'morning', 'night', 'end'] },
      { id: 'limits', title: 'Feste Grenzen', keys: ['never', 'brightness'] },
    ];
  }

  protected override preview(): Ans {
    const s = this.store;
    return {
      rooms: s.rooms.filter((r) => s.devices.some((d) => d.kind === 'light' && d.room === r.id)).map((r) => ({ id: r.id, name: r.name, lights: 1, plan_on: !!s.plans?.light[r.id]?.on, vacation: !!s.plans?.light[r.id]?.vacation.on })),
      config: { smart: true, people: 0, morning: true, night: true, dark: { never: false, never_from: '09:00', never_to: '16:00' } },
      days: 0,
      residents: s.residents.length,
    };
  }

  protected defaults(sug: Ans): Ans {
    const rooms = (sug.rooms ?? []) as VRoom[];
    const c = sug.config ?? {};
    const picked = rooms.filter((r) => r.vacation || r.plan_on);
    return {
      rooms: (picked.length ? picked : rooms).map((r) => r.id),
      smart: c.smart ?? true,
      people: c.people ?? 0,
      morning: c.morning ?? true,
      night: c.night ?? true,
      end: '23:00',
      never: { on: !!c.dark?.never, from: c.dark?.never_from ?? '09:00', to: c.dark?.never_to ?? '16:00' },
      brightness: 70,
    };
  }

  protected body(step: string) {
    const a = this._ans;
    const sug = this._sug ?? {};
    if (step === 'rooms') {
      const rooms = (sug.rooms ?? []) as VRoom[];
      return html`<p class="intro">Im Hausmodus „Urlaub“ gehen Lichter so an und aus, wie ihr es im Alltag macht, damit es von außen bewohnt wirkt.</p>
        <div class="group">
          ${rooms.length
            ? rooms.map((r) =>
                this.check((a.rooms ?? []).includes(r.id), r.name, r.plan_on ? `${r.lights} ${r.lights === 1 ? 'Licht' : 'Lichter'}` : 'Lichtsteuerung dort noch aus: wird nur für den Urlaub eingeschaltet, im Alltag ändert sich nichts.', () =>
                  this.set({ rooms: this.toggleIn(a.rooms ?? [], r.id) }),
                ),
              )
            : html`<div class="row"><span class="sub">Keine Räume mit Lichtern gefunden.</span></div>`}
        </div>`;
    }
    if (step === 'how') {
      const days: number = sug.days ?? 0;
      return html`<p class="intro">Am natürlichsten wirkt es, wenn das Licht so geht wie bei euch im Alltag. Das lernt Hausregeln aus den letzten Wochen.</p>
        ${this.choice(a.smart !== false, [
          { value: true, title: 'Wie im Alltag (gelernt)', sub: days ? `Aus ${days} Tagen gelernt: Räume, Zeiten, Wege durch die Wohnung.` : 'Lernt ab jetzt jede Nacht. Bis dahin sinnvolle Zeiten je Raumart.', icon: mdiBrain },
          { value: false, title: 'Feste Zeiten', sub: 'Ab Sonnenuntergang bis zu einer festen Uhrzeit, jeden Tag ein wenig anders.', icon: mdiClockOutline },
        ], (v) => this.set({ smart: v }))}
        ${a.smart !== false
          ? html`<div class="group">
              ${this.line('Wie viele Leute spielen', '0 = so viele, wie hier wohnen (höchstens 2)', this.stepper(a.people ?? 0, '', (v) => this.set({ people: v }), 1, 0, 3))}
              ${this.check(a.morning !== false, 'Auch morgens', 'Aufstehen, Bad, Küche – wenn es da noch dunkel ist', () => this.set({ morning: a.morning === false }))}
              ${this.check(a.night !== false, 'Nachts mal auf', 'wenn ihr das im Alltag auch macht', () => this.set({ night: a.night === false }))}
            </div>`
          : html`<div class="group">${this.line('Aus um', 'etwa, jeden Tag ein wenig anders', html`<input class="time" type="time" aria-label="Aus um" .value=${a.end ?? '23:00'} @change=${(e: Event) => this.set({ end: (e.target as HTMLInputElement).value || '23:00' })} />`)}</div>`}`;
    }
    const nv = a.never ?? { on: false, from: '09:00', to: '16:00' };
    return html`<p class="intro">Feste Grenzen gelten immer, auch gegen das Gelernte.</p>
      <div class="group">
        ${this.check(!!nv.on, 'Nie zwischen …', 'z. B. tagsüber, wenn es draußen hell genug ist', () => this.set({ never: { ...nv, on: !nv.on } }))}
        ${nv.on
          ? this.line(
              'Von – bis',
              '',
              html`<span class="stepper"><input class="time" type="time" aria-label="von" .value=${nv.from} @change=${(e: Event) => this.set({ never: { ...nv, from: (e.target as HTMLInputElement).value || nv.from } })} />–<input class="time" type="time" aria-label="bis" .value=${nv.to} @change=${(e: Event) => this.set({ never: { ...nv, to: (e.target as HTMLInputElement).value || nv.to } })} /></span>`,
            )
          : nothing}
        ${this.line('So hell', '', this.stepper(a.brightness ?? 70, '%', (v) => this.set({ brightness: Math.max(1, v) }), 5, 0, 100))}
      </div>
      <p class="note">„Nie an“-Lichtregeln eines Raums gelten auch im Urlaub. Eine eigene feste Regel für den Urlaub kannst du nach dem Einrichten dazubauen.</p>`;
  }

  protected summary(): SummaryRow[] {
    const a = this._ans;
    const rooms = ((this._sug?.rooms ?? []) as VRoom[]).filter((r) => (a.rooms ?? []).includes(r.id)).map((r) => r.name);
    const nv = a.never ?? { on: false };
    return [
      { title: 'Räume', sub: rooms.join(', ') || 'keine', on: rooms.length > 0 },
      { title: a.smart === false ? 'Feste Zeiten' : 'Wie im Alltag', sub: a.smart === false ? `ab Sonnenuntergang bis etwa ${a.end ?? '23:00'}` : [a.morning !== false ? 'auch morgens' : 'nicht morgens', a.night !== false ? 'nachts mal auf' : 'nachts dunkel'].join(' · ') },
      { title: 'Grenzen', sub: [nv.on ? `nie zwischen ${nv.from} und ${nv.to}` : '', `${a.brightness ?? 70} % hell`].filter(Boolean).join(' · ') },
      { title: 'Wann', sub: 'nur im Hausmodus „Urlaub“' },
    ];
  }

  protected override afterApplied() {
    const add = () => {
      fire(this, 'hr-open-rule', { rule: newRule({ name: 'Im Urlaub', only: [{ subject: 'mode', verb: 'is', mode: 'vacation' }] }), isNew: true });
      this.close();
    };
    return html`<button class="btn small tinted" @click=${add}>Eigene feste Regel für den Urlaub</button>`;
  }
}
customElements.define('hr-assistant-vacation', HrAssistantVacation);
