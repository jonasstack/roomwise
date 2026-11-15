/**
 * <hr-assistant-mode>: assistant of the feature "Hausmodus automatisch". Which modes change by themselves → summary.
 * The exact conditions per mode stay editable under Zuhause → Hausmodus (the same sentence building blocks as rules).
 */
import { html, nothing } from 'lit';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';

/** "15m" / "2h" / "1d" → minutes */
const minutes = (f: string) => {
  const m = String(f || '').match(/^(\d+)(m|h|d)?$/);
  return m ? Number(m[1]) * (m[2] === 'h' ? 60 : m[2] === 'd' ? 1440 : 1) : 0;
};

export class HrAssistantMode extends HrAssistantBase {
  readonly feature = 'mode_auto' as const;
  readonly label = 'Hausmodus';

  protected steps(): AStep[] {
    return [{ id: 'modes', title: 'Wann soll der Modus wechseln?', keys: ['away', 'sleep', 'vacation'], required: true }];
  }

  protected override preview(): Ans {
    return { current: { away: { on: true, for: '' }, sleep: { on: false, for: '10m' }, vacation: { on: false, for: '' } }, night: [22, 6], residents: this.store.residents, wakeup: { on: false, beds: [] } };
  }

  protected defaults(sug: Ans): Ans {
    const c = sug.current ?? {};
    return {
      away: { on: c.away?.on ?? true, for: c.away?.for ?? '' },
      sleep: { on: c.sleep?.on ?? false, for: c.sleep?.for || '10m' },
      vacation: { on: c.vacation?.on ?? false },
      // "Aufstehen erkennen": on by default once a bed sensor was found
      wakeup: !!sug.wakeup?.on || !!sug.wakeup?.beds?.length,
    };
  }

  protected body() {
    const a = this._ans;
    const night: [number, number] = this._sug?.night ?? [22, 6];
    const up = (k: string, patch: Ans) => this.set({ [k]: { ...a[k], ...patch } });
    return html`<p class="intro">Der Hausmodus ist ein Wort für die Lage im Haus. Licht, Heizung, Alarmanlage und Regeln richten sich danach. Er kann von selbst wechseln, je nachdem, wer zuhause ist.</p>
      <div class="group">
        ${this.check(!!a.away?.on, '„Weg“, wenn alle weg sind', 'und „Zuhause“, sobald jemand heimkommt', () => up('away', { on: !a.away?.on }))}
        ${a.away?.on ? this.line('Erst nach', 'damit kurzes Rausgehen nicht zählt', this.stepper(minutes(a.away.for), 'Min.', (v) => up('away', { for: v ? `${v}m` : '' }), 5, 0, 120)) : nothing}
        ${this.check(!!a.sleep?.on, '„Schlafen“ nachts, wenn jemand zuhause ist', `„nachts“ = ${night[0]}–${night[1]} Uhr`, () => up('sleep', { on: !a.sleep?.on }))}
        ${a.sleep?.on && this._sug?.wakeup?.beds?.length
          ? this.check(!!a.wakeup, 'Schlafen endet beim Aufstehen', `nicht beim Gang ins Bad – lernt, wann ihr aufsteht (Bett: ${this._sug.wakeup.beds.join(', ')})`, () => this.set({ wakeup: !a.wakeup }))
          : nothing}
        ${this.check(!!a.vacation?.on, '„Urlaub“, wenn alle seit einem Tag weg sind', 'dann wirkt das Haus bewohnt, wenn die Urlaubssimulation an ist', () => up('vacation', { on: !a.vacation?.on }))}
      </div>
      <p class="note">Wer zählt, stellst du unter Zuhause → Wer wohnt hier? ein. Eigene Bedingungen je Modus (z. B. „Schlafen, wenn das Schlafzimmerlicht aus ist“) unter Zuhause → Hausmodus.</p>`;
  }

  protected summary(): SummaryRow[] {
    const a = this._ans;
    const away = minutes(a.away?.for);
    return [
      { title: 'Weg', sub: a.away?.on ? (away ? `wenn alle seit ${away} Min. weg sind` : 'wenn alle weg sind') : 'nur von Hand', on: !!a.away?.on },
      { title: 'Schlafen', sub: a.sleep?.on ? (a.wakeup && this._sug?.wakeup?.beds?.length ? 'nachts, wenn jemand zuhause ist; endet beim Aufstehen' : 'nachts, wenn jemand zuhause ist') : 'nur von Hand', on: !!a.sleep?.on },
      { title: 'Urlaub', sub: a.vacation?.on ? 'wenn alle seit einem Tag weg sind' : 'nur von Hand', on: !!a.vacation?.on },
    ];
  }
}
customElements.define('hr-assistant-mode', HrAssistantMode);
