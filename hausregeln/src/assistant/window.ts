/**
 * <hr-assistant-window>: assistant of the feature "Fenster-Warnung beim Gehen". Which door → how to warn → summary.
 */
import { html } from 'lit';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';

interface Dev {
  entity_id: string;
  name: string;
  room?: string | null;
}

export class HrAssistantWindow extends HrAssistantBase {
  readonly feature = 'window_warning' as const;
  readonly label = 'Fenster-Warnung';

  protected steps(): AStep[] {
    return [
      { id: 'door', title: 'Welche Tür?', keys: ['doors'], required: true },
      { id: 'how', title: 'Wie warnen?', keys: ['only_last', 'lights', 'announce', 'notify', 'timeout'] },
    ];
  }

  protected override preview(): Ans {
    const doors = this.store.devices.filter((d) => d.kind === 'door').map((d) => ({ entity_id: d.entity_id, name: d.name, room: d.room }));
    return { doors, suggested: doors.slice(0, 1).map((d) => d.entity_id), windows: this.store.devices.filter((d) => d.kind === 'window'), current: {} };
  }

  protected defaults(sug: Ans): Ans {
    const cur = sug.current ?? {};
    return {
      doors: cur.doors?.length ? cur.doors : sug.suggested ?? [],
      only_last: cur.only_last ?? true,
      lights: (cur.lights?.mode ?? 'red') !== 'none',
      announce: (cur.announce?.mode ?? 'all') !== 'none',
      notify: !!cur.notify?.on,
      timeout: cur.timeout ?? 30,
    };
  }

  protected body(step: string) {
    const a = this._ans;
    const sug = this._sug ?? {};
    if (step === 'door') {
      const doors: Dev[] = sug.doors ?? [];
      if (!doors.length) return html`<p class="intro">Keine Tür mit Kontakt gefunden. Ohne Türkontakt merkt Hausregeln nicht, wenn jemand geht.</p>`;
      return html`<p class="intro">Geht diese Tür auf, während noch Fenster offen sind, erinnert Hausregeln daran. Gezählt werden alle Fenster (${(sug.windows ?? []).length}), auch neue.</p>
        <div class="group">
          ${doors.map((d) =>
            this.check(
              (a.doors ?? []).includes(d.entity_id),
              d.name,
              [this.store.room(d.room ?? undefined)?.name, (sug.suggested ?? []).includes(d.entity_id) ? 'vorgeschlagen' : ''].filter(Boolean).join(' · '),
              () => this.set({ doors: this.toggleIn(a.doors ?? [], d.entity_id) }),
            ),
          )}
        </div>`;
    }
    return html`<p class="intro">Erst ein stiller Hinweis, dann, wenn niemand bestätigt, lauter.</p>
      <div class="group">
        ${this.check(!!a.only_last, 'Nur, wenn der Letzte geht', 'wenn höchstens eine Person zuhause ist', () => this.set({ only_last: !a.only_last }))}
        ${this.check(!!a.lights, 'Licht an der Tür blinkt 3× rot', 'danach wieder wie vorher', () => this.set({ lights: !a.lights }))}
        ${this.check(!!a.announce, 'Durchsage, wenn niemand bestätigt', 'auf den Lautsprechern der Alarmanlage, z. B. „Noch offen: Küchenfenster“', () => this.set({ announce: !a.announce }))}
        ${this.check(!!a.notify, 'Nachricht aufs Handy', 'wenn niemand bestätigt', () => this.set({ notify: !a.notify }))}
        ${this.line('Bestätigen innerhalb von', 'danach Durchsage bzw. Nachricht', this.stepper(a.timeout ?? 30, 'Sek.', (v) => this.set({ timeout: v }), 5, 0, 300))}
      </div>`;
  }

  protected summary(): SummaryRow[] {
    const a = this._ans;
    return [
      { title: 'Tür', sub: (a.doors ?? []).map((d: string) => this.name(d)).join(', ') || 'keine', on: (a.doors ?? []).length > 0 },
      { title: 'Wann', sub: a.only_last ? 'nur, wenn der Letzte geht' : 'jedes Mal' },
      { title: 'Licht', sub: a.lights ? 'blinkt 3× rot' : 'bleibt', on: !!a.lights },
      { title: 'Durchsage', sub: a.announce ? `nach ${a.timeout ?? 30} Sek. ohne Bestätigung` : 'keine', on: !!a.announce },
      { title: 'Nachricht', sub: a.notify ? 'aufs Handy' : 'keine', on: !!a.notify },
    ];
  }
}
customElements.define('hr-assistant-window', HrAssistantWindow);
