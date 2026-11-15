/**
 * <hr-assistant-light>: assistant of the feature "Licht". Rooms with lights → who is there (sensors found) →
 * intelligent or own rules → brightness and colour per time of day → nobody there any more → guardrails →
 * summary. Intelligent starts as "Probelauf" (only shows what it would switch) unless chosen otherwise.
 */
import { html, nothing } from 'lit';
import { mdiBrain, mdiFormatListChecks } from '@mdi/js';
import type { Clause, SmartSlot } from '../model';
import { HrAssistantBase, type Ans, type AStep, type SummaryRow } from './base';
import '../components/conditions';

export const SLOT_LABEL: Record<string, string> = { morning: 'Morgens', day: 'Tagsüber', evening: 'Abends', late: 'Spätabends', night: 'Nachts' };
export const COLOR_LABEL: Record<string, string> = { kerze: 'Kerze', warm: 'Warm', neutral: 'Neutral', kalt: 'Kalt' };
export const COLOR_SWATCH: Record<string, string> = { kerze: '#ffb46b', warm: '#ffc98f', neutral: '#fff1de', kalt: '#e6efff' };
const DEFAULT_SLOTS: SmartSlot[] = [
  { id: 'morning', from: '06:00', brightness: 70, color: 'neutral' },
  { id: 'day', from: '10:00', brightness: 100, color: 'neutral' },
  { id: 'evening', from: '18:00', brightness: 80, color: 'warm' },
  { id: 'late', from: '21:30', brightness: 45, color: 'warm' },
  { id: 'night', from: '23:30', brightness: 10, color: 'kerze' },
];

interface LRoom {
  id: string;
  name: string;
  in?: string;
  lights: { entity_id: string; name: string; white: boolean; color: boolean }[];
  presence: { entity_id: string; name: string; kind?: string }[];
  door_logic: boolean;
  lux: { entity_id: string; name: string } | null;
  media: { entity_id: string; name: string }[];
  plan_on: boolean;
  rules: number;
  smart: string;
}

export class HrAssistantLight extends HrAssistantBase {
  readonly feature = 'light' as const;
  readonly label = 'Licht';

  private get _rooms(): LRoom[] {
    return (this._sug?.rooms ?? []) as LRoom[];
  }
  private get _chosen(): LRoom[] {
    const ids: string[] = this._ans.rooms ?? [];
    return this._rooms.filter((r) => ids.includes(r.id));
  }

  protected steps(): AStep[] {
    return [
      { id: 'rooms', title: 'In welchen Räumen?', keys: ['rooms'], required: true },
      { id: 'presence', title: 'Wer ist da?', keys: ['only_dark'] },
      { id: 'mode', title: 'Intelligent oder eigene Regeln?', keys: ['mode', 'active'], required: true },
      { id: 'slots', title: 'Wie hell, welche Farbe?', keys: ['slots'] },
      { id: 'empty', title: 'Wenn niemand mehr da ist', keys: ['empty', 'manual'] },
      { id: 'guards', title: 'Grenzen, die immer gelten', keys: ['guards', 'tv_off'] },
    ];
  }

  protected override preview(): Ans {
    const s = this.store;
    return {
      rooms: s.rooms
        .map((r) => ({
          id: r.id,
          name: r.name,
          in: r.in,
          lights: s.devices.filter((d) => d.kind === 'light' && d.room === r.id).map((d) => ({ entity_id: d.entity_id, name: d.name, white: true, color: false })),
          presence: [...r.presence, ...r.motion].map((e) => ({ entity_id: e, name: this.name(e) })),
          door_logic: !!r.door_logic,
          lux: r.lux ? { entity_id: r.lux, name: this.name(r.lux) } : null,
          media: s.devices.filter((d) => d.kind === 'media' && d.room === r.id).map((d) => ({ entity_id: d.entity_id, name: d.name })),
          plan_on: !!s.plans?.light[r.id]?.on,
          rules: s.plans?.light[r.id]?.rules.length ?? 0,
          smart: s.plans?.light[r.id]?.smart?.mode ?? 'off',
        }))
        .filter((r) => r.lights.length),
      night: [22, 6],
      slots: DEFAULT_SLOTS,
    };
  }

  protected defaults(sug: Ans): Ans {
    const rooms = (sug.rooms ?? []) as LRoom[];
    const sensed = rooms.filter((r) => r.presence.length || r.door_logic);
    const first = rooms.find((r) => r.plan_on);
    const plan = first ? this.store.plans?.light[first.id] : undefined;
    return {
      rooms: (sensed.length ? sensed : rooms).map((r) => r.id),
      only_dark: plan?.smart?.only_dark ?? true,
      mode: rooms.some((r) => r.smart !== 'off') || !rooms.some((r) => r.rules) ? 'smart' : 'rules',
      active: rooms.some((r) => r.smart === 'on'),
      slots: structuredClone(plan?.smart?.slots ?? sug.slots ?? DEFAULT_SLOTS),
      empty: { ...(plan?.empty ?? { mode: 'off', delay: 2, dim: 10, dim_for: 5 }) },
      manual: plan?.manual ?? 'room_empty',
      guards: { max: 100, night_max: 30, night_warm: true, off_while: [] as Clause[], ...(plan?.smart?.guards ?? {}) },
      tv_off: false,
    };
  }

  // ------------------------------------------------------------------ steps
  protected body(step: string) {
    switch (step) {
      case 'rooms':
        return this._roomsStep();
      case 'presence':
        return this._presenceStep();
      case 'mode':
        return this._modeStep();
      case 'slots':
        return this._slotsStep();
      case 'empty':
        return this._emptyStep();
      case 'guards':
        return this._guardsStep();
    }
    return html``;
  }

  private _roomsStep() {
    const rooms = this._rooms;
    const ids: string[] = this._ans.rooms ?? [];
    if (!rooms.length) return html`<p class="intro">Keine Lichter in deinen Räumen gefunden. Ordne Lichter in Home Assistant einem Bereich zu (oder unter „Geräte“), dann starte den Assistenten neu.</p>`;
    return html`<p class="intro">Licht geht von selbst an, wenn jemand im Raum ist, und aus, wenn der Raum leer ist. Vorgeschlagen sind die Räume, die wissen, ob jemand da ist.</p>
      <div class="group">
        ${rooms.map((r) => {
          const sensed = r.presence.length || r.door_logic;
          const sub = sensed ? `${r.lights.map((l) => l.name).join(', ')}` : 'Kein Melder: Der Raum weiß nicht, ob jemand da ist.';
          return this.check(ids.includes(r.id), r.name, sub, () => this.set({ rooms: this.toggleIn(ids, r.id) }));
        })}
      </div>
      ${rooms.some((r) => this._chosen.includes(r) && r.rules) ? html`<p class="note">Eigene Lichtregeln, die du schon gebaut hast, bleiben erhalten.</p>` : nothing}`;
  }

  private _presenceStep() {
    const rooms = this._chosen;
    return html`<p class="intro">Das hat Hausregeln in deinen Räumen gefunden. Ändern kannst du die Sensoren eines Raums jederzeit unter „Räume“.</p>
      <div class="group">
        ${rooms.map((r) =>
          this.line(
            r.name,
            r.presence.length
              ? `Wer ist da: ${r.presence.map((p) => p.name).join(', ')}${r.lux ? ` · hell oder dunkel: ${r.lux.name}` : ' · hell oder dunkel: die Sonne'}`
              : r.door_logic
                ? 'Wer ist da: geschätzt über die Tür'
                : 'Kein Melder gefunden. Ohne Sensor geht das Licht nicht von selbst an.',
            html``,
          ),
        )}
      </div>
      <div class="group">${this.check(this._ans.only_dark !== false, 'Nur, wenn es dunkel ist', 'Ohne Lichtsensor zählt die Sonne.', () => this.set({ only_dark: this._ans.only_dark === false }))}</div>`;
  }

  private _modeStep() {
    const smart = this._ans.mode !== 'rules';
    return html`<p class="intro">Zwei Wege, beide jederzeit änderbar. Eigene feste Regeln (z. B. „nie an, solange der Fernseher läuft“) kannst du in beiden Fällen dazubauen, sie gehen immer vor.</p>
      ${this.choice(this._ans.mode ?? 'smart', [
        { value: 'smart', title: 'Intelligent', sub: 'Lernt, wie ihr das Licht mögt: aus dem, was ihr von Hand einstellt, je Tageszeit und Lage. Startet mit den Werten im nächsten Schritt.', icon: mdiBrain },
        { value: 'rules', title: 'Eigene Regeln', sub: 'Feste Helligkeit und Farbe je Tageszeit. Genau so, wie du es einstellst, nichts ändert sich von selbst.', icon: mdiFormatListChecks },
      ], (v) => this.set({ mode: v }))}
      ${smart
        ? html`<h3>Wie anfangen?</h3>
            ${this.seg(this._ans.active ? 'on' : 'shadow', [
              ['shadow', 'Erst Probelauf'],
              ['on', 'Gleich schalten'],
            ], (v) => this.set({ active: v === 'on' }))}
            <p class="note">${this._ans.active
              ? 'Es schaltet sofort und lernt dabei dazu.'
              : 'Im Probelauf schaltet es nichts. Im Bereich „Licht“ siehst du, wie es geschaltet hätte und wie oft das zu dem passt, was ihr selbst macht. Einschalten, wenn es passt.'}</p>`
        : nothing}`;
  }

  private _slotsStep() {
    const slots: SmartSlot[] = this._ans.slots ?? DEFAULT_SLOTS;
    const up = (i: number, patch: Partial<SmartSlot>) => this.set({ slots: slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    const smart = this._ans.mode !== 'rules';
    return html`<p class="intro">${smart ? 'Startwerte je Tageszeit. Was ihr dann von Hand einstellt, lernt es dazu und passt sich an.' : 'So hell und in dieser Farbe geht das Licht je Tageszeit an.'}</p>
      ${slots.map(
        (s, i) => html`<div class="card slot">
          <div class="top">
            <b>${SLOT_LABEL[s.id] ?? s.id}<small>ab</small></b>
            <input class="time" type="time" aria-label="${SLOT_LABEL[s.id]} ab" .value=${s.from} @change=${(e: Event) => up(i, { from: (e.target as HTMLInputElement).value || s.from })} />
            ${this.stepper(s.brightness, '%', (v) => up(i, { brightness: Math.max(1, v) }), 5, 0, 100)}
          </div>
          ${this.seg(s.color, Object.entries(COLOR_LABEL).map(([k, l]) => [k, l] as [string, string]), (v) => up(i, { color: v as SmartSlot['color'] }))}
        </div>`,
      )}`;
  }

  private _emptyStep() {
    const em = this._ans.empty ?? { mode: 'off', delay: 2, dim: 10, dim_for: 5 };
    const up = (patch: Ans) => this.set({ empty: { ...em, ...patch } });
    return html`<p class="intro">Ist der Raum leer, wartet Hausregeln kurz (falls du nur etwas holst) und macht dann …</p>
      ${this.seg(em.mode, [
        ['off', 'Aus'],
        ['dim', 'Erst dimmen'],
        ['keep', 'Anlassen'],
      ], (v) => up({ mode: v }))}
      <div class="group">
        ${this.line('Nach', 'So lange muss der Raum leer sein', this.stepper(em.delay, 'Min.', (v) => up({ delay: v }), 1, 0, 60))}
        ${em.mode === 'dim' ? this.line('Dimmen auf', '', this.stepper(em.dim, '%', (v) => up({ dim: Math.max(1, v) }), 5, 0, 100)) : nothing}
        ${em.mode === 'dim' ? this.line('Dann aus nach', '0 = bleibt gedimmt', this.stepper(em.dim_for, 'Min.', (v) => up({ dim_for: v }), 1, 0, 60)) : nothing}
      </div>
      <h3>Von Hand geschaltet</h3>
      <p class="note">Schaltet jemand selbst, bleibt das Licht so …</p>
      ${this.seg(this._ans.manual ?? 'room_empty', [
        ['room_empty', 'Bis der Raum leer ist'],
        ['30m', '30 Min.'],
        ['none', 'Gar nicht'],
      ], (v) => this.set({ manual: v }))}`;
  }

  private _guardsStep() {
    const g = this._ans.guards ?? { max: 100, night_max: 30, night_warm: true, off_while: [] };
    const up = (patch: Ans) => this.set({ guards: { ...g, ...patch } });
    const night: [number, number] = this._sug?.night ?? [22, 6];
    const tv = this._chosen.filter((r) => r.media.length);
    return html`<p class="intro">Diese Grenzen gelten immer, auch gegen das, was das Licht gelernt hat.</p>
      <div class="group">
        ${this.line('Nie heller als', '', this.stepper(g.max, '%', (v) => up({ max: Math.max(5, v) }), 5, 5, 100))}
        ${this.line('Nachts höchstens', `„nachts“ = ${night[0]}–${night[1]} Uhr (Einstellungen → Wörter in Regeln)`, this.stepper(g.night_max, '%', (v) => up({ night_max: Math.max(1, v) }), 5, 0, 100))}
        ${this.check(g.night_warm, 'Nachts nur warmweiß', 'kein kaltes, blaues Licht', () => up({ night_warm: !g.night_warm }))}
        ${tv.length ? this.check(!!this._ans.tv_off, 'Aus lassen, solange der Fernseher läuft', tv.map((r) => `${r.name}: ${r.media[0].name}`).join(' · '), () => this.set({ tv_off: !this._ans.tv_off })) : nothing}
      </div>
      <h3>Außerdem aus lassen, solange …</h3>
      <hr-conditions .store=${this.store} .clauses=${g.off_while ?? []} joiner="oder" heading="Aus lassen, solange" @change=${(e: CustomEvent<Clause[]>) => up({ off_while: e.detail })}></hr-conditions>
      <p class="note">Eigene feste Lichtregeln baust du danach je Raum unter „Lichtregeln“ dazu, sie gehen immer vor.</p>`;
  }

  // ------------------------------------------------------------------ summary
  protected override summaryIntro(): string {
    return this._ans.mode === 'rules' ? 'So wird es eingerichtet. Tipp auf „Einrichten“, dann gelten die Regeln sofort.' : this._ans.active ? 'So wird es eingerichtet. Tipp auf „Einrichten“, dann schaltet das Licht sofort.' : 'So wird es eingerichtet. Tipp auf „Einrichten“: Der Probelauf beginnt, geschaltet wird noch nichts.';
  }

  protected summary(): SummaryRow[] {
    const a = this._ans;
    const rooms = this._chosen.map((r) => r.name);
    const slots: SmartSlot[] = a.slots ?? DEFAULT_SLOTS;
    const em = a.empty ?? { mode: 'off', delay: 2 };
    const g = a.guards ?? { max: 100, night_max: 30, night_warm: true };
    const rows: SummaryRow[] = [
      { title: 'Räume', sub: rooms.length ? rooms.join(', ') : 'keine', on: rooms.length > 0 },
      { title: a.mode === 'rules' ? 'Eigene Regeln' : 'Intelligent', sub: a.mode === 'rules' ? 'feste Werte je Tageszeit' : a.active ? 'schaltet sofort und lernt dazu' : 'Probelauf: zeigt erst, wie es geschaltet hätte' },
      { title: a.only_dark === false ? 'Auch wenn es hell ist' : 'Nur, wenn es dunkel ist', sub: 'Lichtsensor des Raums, sonst die Sonne' },
      { title: 'Tageszeiten', sub: slots.map((s) => `${SLOT_LABEL[s.id]} ab ${s.from}: ${s.brightness} %, ${COLOR_LABEL[s.color] ?? s.color}`).join(' · ') },
      { title: 'Niemand mehr da', sub: em.mode === 'off' ? `aus nach ${em.delay} Min.` : em.mode === 'dim' ? `nach ${em.delay} Min. gedimmt` : 'Licht bleibt an' },
      { title: 'Grenzen', sub: [g.max < 100 ? `nie heller als ${g.max} %` : '', `nachts höchstens ${g.night_max} %`, g.night_warm ? 'nachts warmweiß' : '', a.tv_off ? 'aus, solange der Fernseher läuft' : '', (g.off_while ?? []).length ? 'eigene Bedingungen' : ''].filter(Boolean).join(' · ') },
    ];
    return rows;
  }
}
customElements.define('hr-assistant-light', HrAssistantLight);
