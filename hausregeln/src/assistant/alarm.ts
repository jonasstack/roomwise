/**
 * <hr-assistant-alarm>: assistant of the feature "Alarmanlage". Modes → sensors (suggested from the rooms) →
 * delays → who gets the message (with the "Alarm aus" button) and what else happens → automatic → PIN → summary.
 * The PIN is never part of the kept answers; it goes straight to the integration (hashed there).
 */
import { html } from 'lit';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';

interface Dev {
  entity_id: string;
  name: string;
  kind?: string;
  room?: string | null;
}
const KIND_LABEL: Record<string, string> = { door: 'Türen', window: 'Fenster', motion: 'Bewegung', presence: 'Anwesenheit' };

export class HrAssistantAlarm extends HrAssistantBase {
  readonly feature = 'alarm' as const;
  readonly label = 'Alarmanlage';
  private _pin = '';

  protected steps(): AStep[] {
    return [
      { id: 'modes', title: 'Wann soll sie wachen?', keys: ['night_on', 'home_on'] },
      { id: 'sensors', title: 'Was soll auslösen?', keys: ['sensors'], required: true },
      { id: 'delays', title: 'Zeit zum Ausschalten', keys: ['entry_delay', 'exit_delay'] },
      { id: 'notify', title: 'Wer wird benachrichtigt?', keys: ['persons', 'sirens', 'flash', 'notify_disarm'] },
      { id: 'auto', title: 'Automatisch scharf?', keys: ['arm_away', 'disarm_home'] },
      { id: 'pin', title: 'PIN zum Ausschalten', keys: ['code'] },
    ];
  }

  protected override preview(): Ans {
    const s = this.store;
    const devs = s.devices.filter((d) => ['door', 'window', 'motion', 'presence'].includes(d.kind) && d.room);
    return {
      sensors: devs.map((d) => ({ entity_id: d.entity_id, name: d.name, kind: d.kind, room: d.room })),
      night: devs.filter((d) => d.kind === 'door' || d.kind === 'window').map((d) => d.entity_id),
      home: devs.filter((d) => d.kind === 'door').map((d) => d.entity_id),
      sirens: [],
      current: { modes: { away: [], night: [], home: [] }, entry_delay: 30, exit_delay: 60, has_code: false, notify_disarm: true, persons: 'everyone', sirens: [] },
    };
  }

  protected defaults(sug: Ans): Ans {
    const cur = sug.current ?? {};
    const had = Object.values(cur.modes ?? {}).some((x) => (x as string[]).length);
    return {
      sensors: had ? [...new Set([...(cur.modes.away ?? []), ...(cur.modes.night ?? []), ...(cur.modes.home ?? [])])] : (sug.sensors ?? []).map((d: Dev) => d.entity_id),
      night_on: true,
      home_on: had ? (cur.modes.home ?? []).length > 0 : false,
      entry_delay: cur.entry_delay ?? 30,
      exit_delay: cur.exit_delay ?? 60,
      persons: cur.persons ?? 'everyone',
      sirens: cur.sirens ?? [],
      flash: true,
      notify_disarm: cur.notify_disarm ?? true,
      arm_away: false,
      disarm_home: false,
    };
  }

  /** the answers that are sent: night/home sensors from the chosen ones; the PIN only now */
  protected override answers(): Ans {
    const a = super.answers();
    const chosen = new Set<string>(this._ans.sensors ?? []);
    const night: string[] = (this._sug?.night ?? []).filter((e: string) => chosen.has(e));
    const home: string[] = (this._sug?.home ?? []).filter((e: string) => chosen.has(e));
    a.night = this._ans.night_on === false ? [] : night;
    a.home = this._ans.home_on ? home : [];
    delete a.night_on;
    delete a.home_on;
    if (this._pin && !this.skipped.has('pin')) a.code = this._pin;
    return a;
  }

  protected body(step: string) {
    const a = this._ans;
    const sug = this._sug ?? {};
    switch (step) {
      case 'modes':
        return html`<p class="intro">Drei Arten scharf: <b>Weg</b> (niemand zuhause, alle Sensoren), <b>Nacht</b> (alle schlafen, nur Türen und Fenster) und <b>Zuhause</b> (nur Türen, z. B. abends). „Weg“ gibt es immer.</p>
          <div class="group">
            ${this.check(true, 'Weg', 'alle gewählten Sensoren', () => undefined, true)}
            ${this.check(a.night_on !== false, 'Nacht', 'Türen und Fenster, keine Bewegungsmelder', () => this.set({ night_on: a.night_on === false }))}
            ${this.check(!!a.home_on, 'Zuhause', 'nur Türen', () => this.set({ home_on: !a.home_on }))}
          </div>`;
      case 'sensors': {
        const list: Dev[] = sug.sensors ?? [];
        const groups = ['door', 'window', 'motion', 'presence'].map((k) => [k, list.filter((d) => d.kind === k)] as [string, Dev[]]).filter(([, l]) => l.length);
        const sel: string[] = a.sensors ?? [];
        if (!list.length) return html`<p class="intro">Keine Tür-, Fenster- oder Bewegungsmelder in deinen Räumen gefunden. Ordne sie in Home Assistant einem Bereich zu, dann starte den Assistenten neu.</p>`;
        return html`<p class="intro">Vorgeschlagen ist alles, was in deinen Räumen liegt. Hake ab, was auslösen soll.</p>
          ${groups.map(
            ([k, l]) => html`<h3>${KIND_LABEL[k]}</h3>
              <div class="group">${l.map((d) => this.check(sel.includes(d.entity_id), d.name, this.store.room(d.room ?? undefined)?.name ?? '', () => this.set({ sensors: this.toggleIn(sel, d.entity_id) })))}</div>`,
          )}`;
      }
      case 'delays':
        return html`<p class="intro">Wer heimkommt, braucht ein paar Sekunden zum Ausschalten, wer geht, zum Rausgehen. In der Zeit piept es nur.</p>
          <div class="group">
            ${this.line('Beim Heimkommen', 'Eine Tür geht auf: so lange bis zum Alarm', this.stepper(a.entry_delay ?? 30, 'Sek.', (v) => this.set({ entry_delay: v }), 5, 0, 300))}
            ${this.line('Beim Gehen', 'So lange nach dem Scharfschalten zählt noch nichts (nur „Weg“)', this.stepper(a.exit_delay ?? 60, 'Sek.', (v) => this.set({ exit_delay: v }), 10, 0, 600))}
          </div>`;
      case 'notify': {
        const persons = this.store.persons;
        const sel = a.persons;
        const isOn = (id: string) => sel === 'everyone' || (Array.isArray(sel) && sel.includes(id));
        const toggle = (id: string) => {
          const next = this.toggleIn(sel === 'everyone' ? persons.map((p) => p.id) : (sel as string[]), id);
          this.set({ persons: next.length === persons.length ? 'everyone' : next });
        };
        const sirens: Dev[] = sug.sirens ?? [];
        return html`<p class="intro">Bei Alarm kommt eine Nachricht aufs Handy, auf Wunsch mit Sirene und blinkendem Licht.</p>
          <div class="group">${persons.length ? persons.map((p) => this.check(isOn(p.id), p.name, p.phone ? 'Handy gefunden' : 'Kein Handy mit der Home Assistant-App', () => toggle(p.id))) : html`<div class="row"><span class="sub">Keine Personen in Home Assistant.</span></div>`}</div>
          <div class="group">
            ${this.check(a.notify_disarm !== false, 'Knopf „Alarm aus“ in der Nachricht', 'Das Handy fragt vorher Face ID bzw. seinen Code ab.', () => this.set({ notify_disarm: a.notify_disarm === false }))}
          </div>
          <h3>Was passiert noch?</h3>
          <div class="group">
            ${sirens.map((d) => this.check((a.sirens ?? []).includes(d.entity_id), `Sirene: ${d.name}`, '', () => this.set({ sirens: this.toggleIn(a.sirens ?? [], d.entity_id) })))}
            ${this.check(a.flash !== false, 'Alle Lichter blinken', 'bei Alarm, bis jemand ausschaltet', () => this.set({ flash: a.flash === false }))}
          </div>`;
      }
      case 'auto':
        return html`<p class="intro">Von Hand scharf schalten geht immer. Zusätzlich kann sie sich nach der Ortung der Handys richten.</p>
          <div class="group">
            ${this.check(!!a.arm_away, 'Scharf, wenn alle weg sind', 'nach 5 Minuten', () => this.set({ arm_away: !a.arm_away }))}
            ${this.check(!!a.disarm_home, 'Aus, sobald jemand heimkommt', 'über die Ortung des Handys', () => this.set({ disarm_home: !a.disarm_home }))}
          </div>`;
      case 'pin':
        return html`<p class="intro">Mit PIN fragt Hausregeln beim Ausschalten danach (auch in der Alarmzentrale von Home Assistant). Ohne PIN kann jeder mit Zugang zu Home Assistant ausschalten.</p>
          <div class="group"><div class="row">
            <input class="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder=${sug.current?.has_code ? 'PIN ist gesetzt – leer lassen, dann bleibt sie' : 'PIN, z. B. 4 Ziffern'} aria-label="PIN" .value=${this._pin} @input=${(e: Event) => (this._pin = (e.target as HTMLInputElement).value.trim())} />
          </div></div>`;
    }
    return html``;
  }

  protected summary(): SummaryRow[] {
    const a = this.answers();
    const persons = this.store.persons;
    const who = a.persons === 'everyone' ? 'alle' : (a.persons ?? []).map((id: string) => persons.find((p) => p.id === id)?.name ?? id).join(', ') || 'niemand';
    return [
      { title: 'Weg', sub: `${(a.sensors ?? []).length} Sensoren`, on: (a.sensors ?? []).length > 0 },
      { title: 'Nacht', sub: (a.night ?? []).length ? `${a.night.length} Türen und Fenster` : 'nicht genutzt', on: (a.night ?? []).length > 0 },
      { title: 'Zuhause', sub: (a.home ?? []).length ? `${a.home.length} Türen` : 'nicht genutzt', on: (a.home ?? []).length > 0 },
      { title: 'Zeit zum Ausschalten', sub: `${a.entry_delay ?? 30} Sek. beim Heimkommen, ${a.exit_delay ?? 60} Sek. beim Gehen` },
      { title: 'Nachricht an', sub: a.notify_disarm === false ? `${who}, ohne Knopf „Alarm aus“` : `${who}, mit Knopf „Alarm aus“` },
      { title: 'Sirene und Licht', sub: [`${(a.sirens ?? []).length} Sirenen`, a.flash === false ? 'Licht bleibt' : 'Lichter blinken'].join(' · ') },
      { title: 'Automatisch', sub: a.arm_away || a.disarm_home ? [a.arm_away ? 'scharf, wenn alle weg sind' : '', a.disarm_home ? 'aus beim Heimkommen' : ''].filter(Boolean).join(' · ') : 'nur von Hand', on: !!(a.arm_away || a.disarm_home) },
      { title: 'PIN', sub: this._pin ? 'neue PIN' : this._sug?.current?.has_code ? 'bleibt wie sie ist' : 'keine', on: !!this._pin || !!this._sug?.current?.has_code },
    ];
  }

  protected override summaryIntro(): string {
    return 'So wird die Alarmanlage eingerichtet. Danach ist sie an, aber noch unscharf.';
  }
}
customElements.define('hr-assistant-alarm', HrAssistantAlarm);
