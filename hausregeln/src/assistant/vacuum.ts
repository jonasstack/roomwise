/**
 * <hr-assistant-vacuum>: assistant of the feature "Saugroboter-Pause". Which robots → which sensors, how long after → summary.
 */
import { html, nothing } from 'lit';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';

interface Dev {
  entity_id: string;
  name: string;
  room?: string | null;
}

export class HrAssistantVacuum extends HrAssistantBase {
  readonly feature = 'vacuum' as const;
  readonly label = 'Saugroboter-Pause';

  protected steps(): AStep[] {
    return [
      { id: 'vacuums', title: 'Welche Saugroboter?', keys: ['vacuums'], required: true },
      { id: 'sensors', title: 'Welche Melder pausieren?', keys: ['sensors', 'after'] },
    ];
  }

  protected override preview(): Ans {
    const s = this.store;
    return { vacuums: s.devices.filter((d) => d.kind === 'vacuum'), sensors: s.devices.filter((d) => ['motion', 'presence', 'zone'].includes(d.kind)), current: { vacuums: [], sensors: 'all', after: 2 } };
  }

  protected defaults(sug: Ans): Ans {
    const cur = sug.current ?? {};
    return { vacuums: cur.vacuums ?? [], sensors: cur.sensors ?? 'all', after: cur.after ?? 2 };
  }

  protected body(step: string) {
    const a = this._ans;
    const sug = this._sug ?? {};
    if (step === 'vacuums') {
      const vacs: Dev[] = sug.vacuums ?? [];
      return html`<p class="intro">Solange ein Saugroboter saugt, lösen Bewegungsmelder sonst Licht, „Raum belegt“ oder sogar Alarm aus. Mit der Pause zählen sie dann nicht. Wer schon vorher erkannt wurde, bleibt erkannt.</p>
        <div class="group">
          ${vacs.length
            ? vacs.map((v) => this.check((a.vacuums ?? []).includes(v.entity_id), v.name, v.entity_id, () => this.set({ vacuums: this.toggleIn(a.vacuums ?? [], v.entity_id) })))
            : html`<div class="row"><span class="sub">Kein Saugroboter gefunden.</span></div>`}
        </div>`;
    }
    const sensors: Dev[] = sug.sensors ?? [];
    const sel = a.sensors;
    return html`<p class="intro">Welche Melder sollen während der Reinigung nicht zählen?</p>
      ${this.seg(sel === 'all' ? 'all' : 'some', [
        ['all', 'Alle Melder'],
        ['some', 'Nur bestimmte'],
      ], (v) => this.set({ sensors: v === 'all' ? 'all' : sel === 'all' ? sensors.map((d) => d.entity_id) : sel }))}
      ${sel !== 'all'
        ? html`<div class="group">${sensors.map((d) => this.check(sel.includes(d.entity_id), d.name, this.store.room(d.room ?? undefined)?.name ?? 'ohne Raum', () => this.set({ sensors: this.toggleIn(sel, d.entity_id) })))}</div>`
        : nothing}
      <div class="group">${this.line('Danach noch', 'Zeit, bis er wirklich in der Station steht', this.stepper(a.after ?? 2, 'Min.', (v) => this.set({ after: v }), 1, 0, 60))}</div>`;
  }

  protected summary(): SummaryRow[] {
    const a = this._ans;
    return [
      { title: 'Saugroboter', sub: (a.vacuums ?? []).map((v: string) => this.name(v)).join(', ') || 'keiner', on: (a.vacuums ?? []).length > 0 },
      { title: 'Melder', sub: a.sensors === 'all' ? 'alle Bewegungs- und Anwesenheitsmelder' : `${(a.sensors ?? []).length} bestimmte` },
      { title: 'Danach noch', sub: `${a.after ?? 2} Min.` },
    ];
  }
}
customElements.define('hr-assistant-vacuum', HrAssistantVacuum);
