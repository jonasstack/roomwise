/**
 * The feature assistant: one reusable shell for the small assistants of Licht, Alarmanlage, Fenster-Warnung,
 * Urlaub, Saugroboter-Pause and Hausmodus (same look as the setup wizard: steps, progress, Zurück / Weiter,
 * Überspringen, a summary at the end). A subclass names its steps, draws each step's body and fills the answers
 * from what the integration found (house_rules/assistant/suggest). "Einrichten" on the summary sends everything at
 * once (house_rules/assistant/apply), which switches the feature on and marks it set up.
 * Skipping a step leaves out its answers: what it is about stays as it is. ✕ = later (does not open by itself again).
 *
 * Opening: fire 'hr-assistant' with {feature, auto?}; the panel shows the matching assistant in a sheet.
 * autoAssistant() asks for it once when a feature's area is opened and nothing is set up yet.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { mdiCheck, mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiClose, mdiMinus, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import { wizardStyles } from '../setup/wizard-styles';
import type { AssistantId } from '../model';
import type { Store } from '../store';
import { assistantStyles } from './styles';

export type Ans = Record<string, any>;

export interface AStep {
  id: string;
  title: string;
  /** answer keys this step fills (left out when the step is skipped) */
  keys: string[];
  /** cannot be skipped (e.g. the choice the rest depends on) */
  required?: boolean;
}

export interface SummaryRow {
  title: string;
  sub: string;
  on?: boolean;
}

export abstract class HrAssistantBase extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _i: { state: true },
    _sug: { state: true },
    _ans: { state: true },
    _busy: { state: true },
    _msg: { state: true },
    _applied: { state: true },
  };
  declare _i: number;
  declare _sug: Ans | null;
  declare _ans: Ans;
  declare _busy: boolean;
  declare _msg: string;
  declare _applied: boolean;
  /** steps skipped with "Überspringen" */
  protected skipped = new Set<string>();

  abstract readonly feature: AssistantId;
  /** the feature's name in the header ("Licht") */
  abstract readonly label: string;
  /** the steps before the summary (may depend on earlier answers) */
  protected abstract steps(): AStep[];
  protected abstract body(step: string): TemplateResult;
  /** answers prefilled from the suggestion */
  protected abstract defaults(sug: Ans): Ans;
  protected abstract summary(): SummaryRow[];
  /** extra below the summary once it is set up (e.g. "Eigene feste Regel dazu") */
  protected afterApplied(): TemplateResult | typeof nothing {
    return nothing;
  }
  /** close the assistant (e.g. before opening something else) */
  protected close() {
    this.dispatchEvent(new CustomEvent('close'));
  }
  /** a sentence above the summary */
  protected summaryIntro(): string {
    return 'So wird es eingerichtet. Tipp auf „Einrichten“, dann gilt es sofort.';
  }

  static override styles = [shared, wizardStyles, assistantStyles];

  constructor() {
    super();
    this._i = 0;
    this._sug = null;
    this._ans = {};
    this._busy = false;
    this._msg = '';
    this._applied = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._load();
  }

  /** the assistant keeps its own answers: live updates must not reset what is being chosen */
  protected override frozen(): boolean {
    return !this._applied;
  }

  private async _load() {
    const sug = (await this.store.assistantSuggest(this.feature).catch(() => null)) ?? this.preview();
    this._sug = sug;
    this._ans = { ...this.defaults(sug), ...this._ans };
  }

  /** without the integration (preview): something to show */
  protected preview(): Ans {
    return {};
  }

  protected set(patch: Ans) {
    this._ans = { ...this._ans, ...patch };
  }

  // ------------------------------------------------------------------ building blocks
  protected check(on: boolean, title: string, sub: string, toggle: () => void, disabled = false) {
    return html`<button class="row" role="checkbox" aria-checked=${on ? 'true' : 'false'} ?disabled=${disabled} @click=${toggle}>
      <span class="box ${on ? '' : 'off'}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>
    </button>`;
  }

  /** big choice cards (one of them) */
  protected choice<T>(value: T, options: { value: T; title: string; sub: string; icon: string }[], pick: (v: T) => void) {
    return html`<div class="choice" role="radiogroup">
      ${options.map((o) => html`<button role="radio" aria-pressed=${value === o.value ? 'true' : 'false'} @click=${() => pick(o.value)}>${icon(o.icon, 24)}<span><b>${o.title}</b><small>${o.sub}</small></span></button>`)}
    </div>`;
  }

  protected seg<T>(value: T, options: [T, string][], pick: (v: T) => void) {
    return html`<div class="seg">${options.map(([v, l]) => html`<button aria-pressed=${value === v ? 'true' : 'false'} @click=${() => pick(v)}>${l}</button>`)}</div>`;
  }

  protected stepper(value: number, unit: string, set: (v: number) => void, step = 1, min = 0, max = 100) {
    return html`<span class="stepper">
      <button aria-label="weniger" @click=${() => set(Math.max(min, value - step))}>${icon(mdiMinus, 18)}</button>
      <output>${value} ${unit}</output>
      <button aria-label="mehr" @click=${() => set(Math.min(max, value + step))}>${icon(mdiPlus, 18)}</button>
    </span>`;
  }

  /** a row with a title, a hint and a control on the right */
  protected line(title: string, sub: string, control: TemplateResult) {
    return html`<div class="row wrap"><span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>${control}</div>`;
  }

  protected toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  protected name(id: string): string {
    return this.store.device(id)?.name ?? this.store.entity(id)?.name ?? id;
  }

  // ------------------------------------------------------------------ navigation
  /** the answers that are sent: those of skipped steps left out */
  protected answers(): Ans {
    const out = { ...this._ans };
    for (const st of this.steps()) if (this.skipped.has(st.id)) for (const k of st.keys) delete out[k];
    return out;
  }

  private _go(delta: number, skip = false) {
    const steps = this.steps();
    const cur = steps[this._i];
    if (cur) {
      if (skip) this.skipped.add(cur.id);
      else if (delta > 0) this.skipped.delete(cur.id);
    }
    this._i = Math.max(0, Math.min(steps.length, this._i + delta));
    this._msg = '';
    this.renderRoot.querySelector('.body')?.scrollTo({ top: 0 });
  }

  private async _apply() {
    this._busy = true;
    this._msg = '';
    try {
      await this.store.assistantApply(this.feature, this.answers());
      this._applied = true;
      this.thaw();
      fire(this, 'hr-toast', `${this.label} eingerichtet`);
    } catch (e) {
      this._msg = (e as Error).message || 'Das hat nicht geklappt.';
    }
    this._busy = false;
  }

  /** ✕: later. Does not open by itself again; "Assistent starten" stays in the area. */
  private _later() {
    if (!this._applied) this.store.assistantMark(this.feature, { dismissed: true }).catch(() => undefined);
    this.dispatchEvent(new CustomEvent('close'));
  }

  private _summary() {
    const rows = this.summary();
    const skipped = this.steps().filter((s) => this.skipped.has(s.id));
    if (this._applied)
      return html`<p class="intro"><span class="ok">${icon(mdiCheck, 18)}Eingerichtet.</span> Ändern kannst du alles jederzeit im Bereich selbst. Den Assistenten startest du dort mit „Assistent erneut starten“.</p>
        <div class="group sum">${rows.map((r) => this._row(r))}</div>
        ${this.afterApplied()}`;
    return html`<p class="intro">${this.summaryIntro()}</p>
      <div class="group sum">${rows.map((r) => this._row(r))}</div>
      ${skipped.length ? html`<p class="note">Übersprungen, bleibt, wie es ist: ${skipped.map((s) => s.title).join(', ')}.</p>` : nothing}`;
  }

  private _row(r: SummaryRow) {
    return html`<div class="row">
      <span class="ic ${r.on === false ? 'off' : 'on'}">${icon(r.on === false ? mdiClose : mdiCheck, 20)}</span>
      <span class="grow"><div class="title">${r.title}</div><div class="sub">${r.sub}</div></span>
    </div>`;
  }

  override render() {
    const steps = this.steps();
    const total = steps.length + 1;
    const atSummary = this._i >= steps.length;
    const cur = atSummary ? null : steps[this._i];
    const title = cur ? cur.title : this._applied ? 'Fertig' : 'Zusammenfassung';
    return html`
      <header>
        <div class="grow">
          <span class="count">Assistent · ${this.label} · ${Math.min(this._i + 1, total)} von ${total}</span>
          <h2>${title}</h2>
          <div class="progress" aria-hidden="true">${Array.from({ length: total }, (_x, j) => html`<span class=${j <= this._i ? 'on' : ''}></span>`)}</div>
        </div>
        <button class="icon-btn" aria-label="Später" title="Später" @click=${() => this._later()}>${icon(mdiClose, 22)}</button>
      </header>
      <div class="body">${!this._sug ? html`<p class="note">Lade …</p>` : cur ? this.body(cur.id) : this._summary()} ${this._msg ? html`<p class="err">${this._msg}</p>` : nothing}</div>
      <footer>
        ${this._i > 0 && !this._applied ? html`<button class="btn" ?disabled=${this._busy} @click=${() => this._go(-1)}>Zurück</button>` : nothing}
        <span class="spacer"></span>
        ${cur && !cur.required ? html`<button class="btn plain" ?disabled=${this._busy} @click=${() => this._go(1, true)}>Überspringen</button>` : nothing}
        ${this._applied
          ? html`<button class="btn primary" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>Fertig</button>`
          : atSummary
            ? html`<button class="btn primary" ?disabled=${this._busy || !this._sug} @click=${() => this._apply()}>${this._busy ? 'Richte ein …' : 'Einrichten'}</button>`
            : html`<button class="btn primary" ?disabled=${!this._sug} @click=${() => this._go(1)}>Weiter</button>`}
      </footer>
    `;
  }
}

// ---------------------------------------------------------------------- opening
const asked = new WeakMap<object, Set<AssistantId>>();

/** Admins run the assistants; the alarm assistant writes the alarm settings, so only a Home Assistant admin. */
function mayRun(s: Store, f: AssistantId): boolean {
  return f === 'alarm' ? s.haAdmin : s.admin;
}

/** Should the feature's assistant open by itself? On, admin, not set up, not put off, nothing configured yet,
 * and not while the first setup wizard is still pending. */
export function needsAssistant(s: Store, f: AssistantId): boolean {
  const st = s.setup;
  if (!st || !mayRun(s, f) || s.demo || !s.on(f)) return false;
  if (!st.done && !st.answers?.dismissed) return false;
  const a = st.assistants?.[f];
  return !!a && !a.done && !a.dismissed && !a.configured;
}

/** Asks the panel once per element to open the assistant when the feature has no setup yet (call in updated()). */
export function autoAssistant(el: HTMLElement, s: Store, f: AssistantId): void {
  const done = asked.get(el) ?? new Set<AssistantId>();
  if (done.has(f) || !needsAssistant(s, f)) return;
  done.add(f);
  asked.set(el, done);
  fire(el, 'hr-assistant', { feature: f, auto: true });
}

/** "Assistent erneut starten" (or "Mit dem Assistenten einrichten" when it never ran) for the area. */
export function assistantButton(el: HTMLElement, s: Store, f: AssistantId): TemplateResult | typeof nothing {
  if (!mayRun(s, f)) return nothing;
  const a = s.setup?.assistants?.[f];
  return html`<button class="btn small" @click=${() => fire(el, 'hr-assistant', { feature: f })}>${a?.done ? 'Assistent erneut starten' : 'Mit dem Assistenten einrichten'}</button>`;
}
