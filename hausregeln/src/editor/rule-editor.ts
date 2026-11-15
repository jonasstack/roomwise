/**
 * <house-rules-editor>: builds a rule as a sentence. Can be used on its own (e.g. inside the
 * floorplan card): set .store and .rule (or nothing for a new rule) and the "standalone" attribute.
 * Events: "rule-saved" {rule}, "closed".
 */
import { css, html, nothing } from 'lit';
import {
  mdiChevronDown,
  mdiClose,
  mdiCodeJson,
  mdiCreation,
  mdiDeleteOutline,
  mdiFlask,
  mdiInfinity,
  mdiLightningBolt,
  mdiLinkVariant,
  mdiPlus,
  mdiCheckCircle,
  mdiCloseCircle,
  mdiShieldLockOutline,
  mdiPauseCircleOutline,
  mdiClockOutline,
  mdiPlay,
  mdiSwapHorizontal,
  mdiCheckboxMarked,
  mdiCheckboxBlankOutline,
  mdiHistory,
  mdiHomeAutomation,
} from '@mdi/js';
import { StoreElement } from '../base';
import type { AiReview, Clause, Rule } from '../model';
import { newRule, type TestResult } from '../store';
import { clauseText, clauseView, joiner, relTime, ruleSentence, type Section } from '../describe';
import { fire, icon, shared } from '../design/shared';
import { tokensFor } from '../design/tokens';
import { links, toneOf } from '../sentence';
import { findVerb, formatDuration } from '../vocabulary';
import { flavourFor } from './picker';
import './picker';
import './logic';
import { BLOCK_LABEL, STEP_VERBS, isLogic, newBlock } from './logic-blocks';
import '../components/sheet';
import '../components/rule-history';
import '../components/rule-export';
import { quote, t } from '../i18n';
// i18n: complete

interface PickerState {
  section: Section;
  index: number;
  /** an alternative ("oder …") of the clause at index */
  alt?: number;
  step: 'subject' | 'verb';
  tab?: string;
}

const ADD_LABEL: Record<Section, (r: Rule) => string> = {
  when: (r) => (r.type === 'while' ? t('rules.add_and_while') : t('rules.add_or_when')),
  and: () => t('rules.add_and_when'),
  then: () => t('rules.add_then_also'),
  else: () => t('rules.add_else_also'),
  only: () => t('rules.add_only_if'),
};

export class HouseRulesEditor extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    rule: { attribute: false },
    isNew: { type: Boolean },
    unsure: { attribute: false },
    fromText: {},
    source: {},
    _r: { state: true },
    _picker: { state: true },
    _test: { state: true },
    _more: { state: true },
    _adv: { state: true },
    _json: { state: true },
    _confirmDelete: { state: true },
    _ran: { state: true },
    _review: { state: true },
    _improve: { state: true },
    _side: { state: true },
  };
  declare rule: Rule | undefined;
  declare isNew: boolean;
  declare unsure: string[] | undefined;
  declare fromText: string | undefined;
  declare source: string | undefined;
  declare _r: Rule;
  declare _picker: PickerState | null;
  declare _test: TestResult | null | 'busy';
  declare _more: boolean;
  declare _adv: boolean;
  declare _json: boolean;
  declare _confirmDelete: boolean;
  declare _ran: { busy: boolean; text: string } | null;
  declare _review: AiReview | 'busy' | { error: string } | null;
  declare _improve: { busy: boolean; text?: string; rule?: Rule; sentence?: string } | null;
  /** a sheet on top of the editor: the rule's history or its export as an automation */
  declare _side: 'history' | 'export' | null;
  private _improveStarted = false;

  constructor() {
    super();
    this.isNew = false;
    this._picker = null;
    this._test = null;
    this._more = false;
    this._adv = false;
    this._json = false;
    this._confirmDelete = false;
    this._ran = null;
    this._review = null;
    this._improve = null;
    this._side = null;
  }

  override updated(): void {
    // a draft from a sentence: the connected AI checks it in the background
    // only when the simple recognition was unsure: a complete draft stays as it is (the model tends to "improve" correct ones wrongly)
    if (this.fromText && this.isNew && this.unsure?.length && this.store?.ollama && !this.store.demo && !this._improveStarted) {
      this._improveStarted = true;
      this._improve = { busy: true };
      this.store
        .aiImprove(this.fromText, this._r)
        .then((res) => {
          this._improve = res.changed && res.rule ? { busy: false, rule: res.rule, sentence: res.sentence } : { busy: false, text: res.note ?? t('rules.ai_draft_fine') };
        })
        .catch((e) => (this._improve = { busy: false, text: t('rules.ai_unreachable', { error: (e as Error).message }) }));
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    if (changed.has('rule') || !this._r) this._r = this.rule ? structuredClone(this.rule) : newRule();
  }

  private _update(fn: (r: Rule) => void) {
    const r = structuredClone(this._r);
    fn(r);
    this._r = r;
    this._test = null;
  }

  static override styles = [
    tokensFor(':host([standalone])'),
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        background: var(--hr-bg);
      }
      /* head and foot like the pop-ups of the pages (<hr-pop>) */
      .bar {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-4) var(--hr-space-4) var(--hr-space-3) var(--hr-space-6);
        border-bottom: 0.5px solid var(--hr-separator);
        background: var(--hr-surface);
      }
      .bar .grow {
        flex: 1;
        min-width: 0;
      }
      .bar h1 {
        font-size: var(--hr-text-title2);
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .bar .sub {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin-top: 2px;
      }
      .foot {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-6);
        border-top: 0.5px solid var(--hr-separator);
        background: var(--hr-surface);
      }
      @media (max-width: 520px) {
        .bar {
          padding-left: var(--hr-space-4);
        }
        .foot {
          padding: var(--hr-space-3) var(--hr-space-4) calc(var(--hr-space-3) + env(safe-area-inset-bottom, 0px));
        }
      }
      .group-field {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-2) var(--hr-space-2) var(--hr-space-2) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
      }
      .group-field .grow {
        flex: 1;
        min-width: 0;
      }
      .group-field b {
        display: block;
        font-weight: 600;
      }
      .group-field small {
        display: block;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .group-field select {
        font: inherit;
        color: inherit;
        min-height: 40px;
        max-width: 50%;
        padding: 0 var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        border: 0;
        background: var(--hr-fill);
      }
      .body {
        flex: 1;
        overflow-y: auto;
        padding: var(--hr-space-5) var(--hr-space-5) var(--hr-space-8);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
      }
      .body > * {
        flex-shrink: 0;
      }
      @media (max-width: 520px) {
        .body {
          padding: var(--hr-space-4) var(--hr-space-4) var(--hr-space-8);
        }
      }

      .from-text ul.unsure {
        margin: var(--hr-space-2) 0 0;
        padding-left: 1.2em;
        color: var(--hr-orange);
      }
      .from-text .sure {
        color: var(--hr-green);
        font-weight: 600;
      }
      .from-text {
        display: flex;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-while) 10%, var(--hr-surface));
        font-size: var(--hr-text-footnote);
        line-height: 1.45;
      }
      .from-text .ic {
        color: var(--hr-while);
        margin-top: 1px;
      }
      .from-text q {
        font-family: var(--hr-font-sentence);
        font-weight: 600;
      }

      .name {
        width: 100%;
        resize: none;
        field-sizing: content;
        line-height: 1.15;
        border: 0;
        background: none;
        outline: none;
        font-size: var(--hr-text-title1);
        font-weight: 700;
        letter-spacing: -0.02em;
        padding: 0;
      }
      .name::placeholder {
        color: var(--hr-label-3);
      }
      @media (max-width: 520px) {
        .name {
          font-size: var(--hr-text-title2);
        }
        .type span {
          display: none;
        }
        .bar h1 {
          font-size: var(--hr-text-subhead);
        }
        .line .kw {
          flex: 0 0 auto;
          min-width: 3.6em;
        }
        .while-note {
          padding-left: 0;
        }
        .canvas {
          padding: var(--hr-space-3);
        }
        .tap {
          min-height: 36px;
          padding: 3px 10px 3px 8px;
        }
        .line .rm {
          width: 28px;
        }
      }
      .bar h1 {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .types {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--hr-space-2);
      }
      .type {
        display: flex;
        gap: var(--hr-space-3);
        align-items: flex-start;
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
        text-align: left;
        box-shadow: inset 0 0 0 2px transparent;
        transition: box-shadow var(--hr-dur) var(--hr-ease);
      }
      .type[aria-pressed='true'] {
        box-shadow: inset 0 0 0 2px var(--tone);
        background: color-mix(in srgb, var(--tone) 7%, var(--hr-surface));
      }
      .type .ic {
        color: var(--tone);
        margin-top: 2px;
      }
      .type b {
        display: block;
        font-size: var(--hr-text-subhead);
      }
      .type span {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }

      /* The sentence */
      .canvas {
        padding: var(--hr-space-5) var(--hr-space-5) var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-1);
        font-family: var(--hr-font-sentence);
        font-size: 21px;
        line-height: 1.45;
      }
      @media (max-width: 520px) {
        .canvas {
          font-size: 18px;
          padding: var(--hr-space-4);
        }
      }
      .line.alt .kw {
        font-style: italic;
      }
      .line.alt-add {
        padding: 0 0 4px;
      }
      .add.small {
        font-size: 12px;
        padding: 2px 10px;
        min-height: 26px;
      }
      .line {
        display: flex;
        align-items: flex-start;
        gap: var(--hr-space-2);
        padding: 5px 0;
      }
      .line .kw {
        flex: 0 0 4.6em;
        padding-top: 6px;
        font-size: 0.82em;
        letter-spacing: 0.01em;
      }
      .line .words {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .tap {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 40px;
        padding: 4px 14px 4px 10px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
        font-weight: 600;
        text-align: left;
        max-width: 100%;
        transition: transform var(--hr-dur-fast) var(--hr-ease);
      }
      .tap:active {
        transform: scale(0.97);
      }
      .tap .ic {
        color: var(--tone);
      }
      .tap.verb {
        background: none;
        padding: 4px 6px;
        font-weight: 500;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--tone) 55%, transparent);
        text-decoration-thickness: 2px;
        text-underline-offset: 5px;
      }
      .tap.mod {
        background: var(--hr-fill);
        font-size: 0.78em;
        font-weight: 600;
        min-height: 32px;
        padding: 2px 10px;
        color: var(--hr-label-2);
      }
      .tap.missing {
        text-decoration: line-through;
      }
      .tap.empty {
        background: none;
        box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--tone) 45%, transparent);
        color: var(--tone);
        border-style: dashed;
      }
      .line .rm {
        width: 36px;
        height: 36px;
        margin-top: 2px;
        color: var(--hr-label-3);
        opacity: 0.8;
      }
      .line .rm:hover {
        color: var(--hr-red);
      }
      .line .rm.play {
        color: var(--tone);
        opacity: 1;
      }
      .line .rm.play:hover {
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 12%, transparent);
      }
      .ran {
        font-size: var(--hr-text-subhead);
        padding: var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        background: color-mix(in srgb, var(--hr-then) 10%, var(--hr-surface-2));
      }
      .sensitive {
        color: var(--hr-red);
      }
      .adds {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: var(--hr-space-2) 0 0 calc(4.6em + var(--hr-space-2));
        font-family: var(--hr-font);
      }
      @media (max-width: 520px) {
        .adds {
          padding-left: 0;
        }
      }
      .add {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 34px;
        padding: 0 12px 0 8px;
        border-radius: var(--hr-radius-full);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 8%, transparent);
      }
      .divider {
        height: 0.5px;
        background: var(--hr-separator);
        margin: var(--hr-space-2) 0;
      }
      .restore {
        display: flex;
        gap: var(--hr-space-2);
        align-items: flex-start;
        text-align: left;
        background: none;
        border: 0;
        padding: var(--hr-space-2) 0 0;
        color: var(--hr-label);
        font: inherit;
        font-family: var(--hr-font);
        cursor: pointer;
      }
      .restore > svg {
        flex: none;
        color: var(--hr-accent);
      }
      .restore b {
        display: block;
        font-size: var(--hr-text-subhead);
      }
      .restore span span {
        display: block;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .while-note {
        font-family: var(--hr-font);
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        padding-left: calc(4.6em + var(--hr-space-2));
      }

      /* Test */
      .test {
        padding: var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      .test-head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
      }
      .test-head div {
        flex: 1;
      }
      .test-head b {
        display: block;
      }
      .test-head span {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .checks {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--hr-text-subhead);
      }
      .check {
        display: flex;
        gap: var(--hr-space-2);
        align-items: flex-start;
      }
      .check .ok {
        color: var(--hr-green);
      }
      .check .no {
        color: var(--hr-red);
      }
      .check .wait {
        color: var(--hr-when);
      }
      .test .badge {
        color: var(--tone);
      }
      .check small {
        display: block;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      .verdict {
        padding: var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface-2);
        font-size: var(--hr-text-subhead);
      }
      .verdict ul {
        margin: 6px 0 0;
        padding-left: 1.2em;
        color: var(--hr-label-2);
      }

      .group .row .seg {
        flex: none;
      }
      .opt {
        flex-wrap: wrap;
      }
      .opt .grow {
        min-width: 180px;
      }
      .linked {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-subhead);
      }
      .linked button {
        color: var(--hr-accent);
        font-weight: 600;
      }
      details summary {
        cursor: pointer;
        list-style: none;
      }
      details summary::-webkit-details-marker {
        display: none;
      }
      pre {
        margin: 0;
        padding: var(--hr-space-4);
        font-size: 12px;
        line-height: 1.5;
        overflow-x: auto;
        background: var(--hr-surface-2);
        border-radius: var(--hr-radius-s);
      }
      .danger-zone {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        align-items: center;
      }
      .hint-save {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        text-align: center;
      }
      hr-sheet hr-picker {
        flex: 1;
      }
    `,
  ];

  /** "Gruppe": an own group of the rules page (page layout only); shown once own groups exist or are wanted */
  private _groupField() {
    const ui = this.store.ui;
    if (!ui.groups.length && ui.grouping !== 'manual') return nothing;
    const cur = this._r.group && ui.groups.some((g) => g.id === this._r.group) ? this._r.group : '';
    return html`<label class="group-field">
      <span class="grow"><b>${t('rules.group_field')}</b><small>${t('rules.group_field_sub')}</small></span>
      <select
        .value=${cur}
        ?disabled=${!this.store.canEdit}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          this._update((x) => {
            if (v) x.group = v;
            else delete x.group;
          });
        }}
      >
        <option value="" ?selected=${!cur}>${t('rules.group_field_none')}</option>
        ${ui.groups.map((g) => html`<option value=${g.id} ?selected=${cur === g.id}>${g.name}</option>`)}
      </select>
    </label>`;
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('closed', { bubbles: true, composed: true }));
  }

  private async _save() {
    const r = structuredClone(this._r);
    if (!r.name.trim()) r.name = this._autoName(r);
    await this.store.saveRule(r);
    this.dispatchEvent(new CustomEvent('rule-saved', { detail: { rule: r }, bubbles: true, composed: true }));
  }

  private async _delete(r: Rule) {
    const store = this.store;
    // the editor is gone when "Rückgängig" is tapped: later toasts go to whoever hosts it (the panel)
    const host: EventTarget = (this.getRootNode() as ShadowRoot).host ?? this;
    await store.deleteRule(r.id);
    this._close();
    fire(host, 'hr-toast', {
      text: t('rel.deleted_toast', { name: quote(r.name) }),
      action: {
        label: t('rel.undo'),
        run: () =>
          store
            .trashRestore(r.id)
            .then(() => fire(host, 'hr-toast', t('rel.back_toast', { name: quote(r.name) })))
            .catch((e: Error) => fire(host, 'hr-toast', t('rel.restore_failed', { error: e.message }))),
      },
    });
  }

  private _autoName(r: Rule): string {
    const then = r.then.find((c) => c.subject !== 'wait');
    const when = r.when[0];
    if (!then || !when) return t('rules.new_rule');
    const a = clauseText(this.store, then, 'then');
    const b = clauseText(this.store, when, 'when');
    const s = t(r.type === 'while' ? 'rules.auto_name_while' : 'rules.auto_name_when', { action: a.replace(/^./, (c) => c.toUpperCase()), cond: b });
    return s.length > 60 ? s.slice(0, 58) + '…' : s;
  }

  /** Runs one step (index) or all steps for real, without trigger and conditions. */
  private async _runSteps(index?: number, otherwise = false) {
    this._ran = { busy: true, text: index === undefined ? t('rules.running_all') : t('rules.running_one') };
    try {
      const res = await this.store.runActions(otherwise ? { ...this._r, then: this._r.else ?? [] } : this._r, index);
      this._ran = { busy: false, text: res.done.length ? t('rules.ran', { steps: res.done.join(' · ') }) : t('rules.ran_nothing') };
    } catch (e) {
      this._ran = { busy: false, text: t('common.error', { error: (e as Error).message }) };
    }
  }

  private async _aiReview() {
    this._review = 'busy';
    try {
      this._review = await this.store.aiReview(this._r);
    } catch (e) {
      this._review = { error: (e as Error).message };
    }
  }

  private _reviewCard() {
    if (!this.store.ollama) return nothing;
    const rv = this._review;
    const done = rv && rv !== 'busy' && !('error' in rv) ? (rv as AiReview) : null;
    const tone = done?.verdict === 'problem' ? 'var(--hr-red)' : done?.verdict === 'hinweis' ? 'var(--hr-orange)' : 'var(--hr-green)';
    return html`<section class="card test tone-while">
      <div class="test-head">
        <span class="badge">${icon(mdiCreation, 22)}</span>
        <div><b>${t('rules.ai_review')}</b><span>${t('rules.ai_review_sub')}</span></div>
        <button class="btn tinted small" ?disabled=${!this._r.when.length || !this._r.then.length || rv === 'busy'} @click=${this._aiReview}>${rv === 'busy' ? t('rules.checking') : done ? t('rules.again') : t('rules.check')}</button>
      </div>
      ${rv && rv !== 'busy' && 'error' in rv ? html`<div class="verdict" style="color:var(--hr-red)">${rv.error}</div>` : nothing}
      ${done
        ? html`<div class="verdict" style="box-shadow: inset 3px 0 0 ${tone}">
            <b>${done.verdict === 'ok' ? t('rules.verdict_ok') : done.verdict === 'problem' ? t('rules.verdict_problem') : t('rules.verdict_hint')}</b> ${done.summary}
            ${done.notes.length ? html`<ul>${done.notes.map((n) => html`<li>${n}</li>`)}</ul>` : nothing}
            ${done.improved
              ? html`<div style="margin-top:8px">${t('rules.proposal')} <i>${done.improved_sentence}</i></div>
                  <button class="btn small tinted" style="margin-top:8px" @click=${() => this._update((x) => Object.assign(x, { type: done.improved!.type, when: done.improved!.when, and: done.improved!.and, then: done.improved!.then, only: done.improved!.only }))}>${t('rules.apply_proposal')}</button>`
              : nothing}
            <div class="muted" style="font-size:12px;margin-top:6px">${done.model ?? ''}</div>
          </div>`
        : nothing}
    </section>`;
  }

  private async _runTest() {
    this._test = 'busy';
    this._test = await this.store.test(this._r);
  }

  private _onPick(e: CustomEvent<Clause>) {
    const p = this._picker!;
    this._update((r) => {
      const list = (r[p.section] ??= []);
      if (p.alt !== undefined && list[p.index]) {
        const alts = (list[p.index].or ??= []);
        if (p.alt >= alts.length) alts.push(e.detail);
        else alts[p.alt] = e.detail;
      } else if (p.index >= list.length) list.push(e.detail);
      else list[p.index] = { ...e.detail, ...(list[p.index].or ? { or: list[p.index].or } : {}) };
    });
    this._picker = null;
  }

  private _removeAlt(section: Section, i: number, a: number) {
    this._update((r) => {
      const c = (r[section] ?? [])[i];
      if (!c?.or) return;
      c.or.splice(a, 1);
      if (!c.or.length) delete c.or;
    });
  }

  /** "oder …" lines under a condition */
  private _alts(section: Section, c: Clause, i: number) {
    const r = this._r;
    const isCondition = section === 'and' || section === 'only' || (section === 'when' && r.type === 'while');
    if (!isCondition || isLogic(c)) return nothing;
    const tone = toneOf(r, section);
    return html`${(c.or ?? []).map((alt, a) => {
        const v = clauseView(this.store, alt, section);
        const open = (step: 'subject' | 'verb') => (this._picker = { section, index: i, alt: a, step });
        return html`<div class="line alt ${tone}">
          <span class="kw">${t('join.or')}</span>
          <span class="words">
            ${v.subject ? html`<button class="tap" @click=${() => open('subject')}>${icon(v.subject.icon, 20)}${v.subject.label}</button>` : nothing}
            <button class="tap verb" @click=${() => open('verb')}>${v.verb}</button>
            ${v.mods.map((m) => html`<button class="tap mod" @click=${() => open('verb')}>${m}</button>`)}
          </span>
          <button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => this._removeAlt(section, i, a)}>${icon(mdiClose, 18)}</button>
        </div>`;
      })}
      <div class="line alt-add ${tone}"><span class="kw"></span><button class="add small ${tone}" @click=${() => (this._picker = { section, index: i, alt: (c.or ?? []).length, step: 'subject' })}>${icon(mdiPlus, 14)}${t('rules.or_more')}</button></div>`;
  }

  private _remove(section: Section, i: number) {
    this._update((r) => (r[section] ?? []).splice(i, 1));
  }

  private _setType(type: Rule['type'] | 'toggle') {
    if (type === 'toggle' || (type === 'while' && this._r.else)) {
      // "Wechselnd" is a while rule with "sonst" steps; "Solange" drops them again
      const toggle = type === 'toggle';
      if (this._r.type === 'while') {
        this._update((r) => {
          if (toggle) r.else ??= [];
          else delete r.else;
        });
        return;
      }
      this._setType('while');
      if (toggle) this._update((r) => (r.else ??= []));
      return;
    }
    if (type === this._r.type) return;
    // events and states differ: translate the obvious pairs, keep the rest for the user to fix
    const map: Record<string, string> = type === 'while'
      ? { opens: 'is_open', closes: 'is_closed', turns_on: 'is_on', turns_off: 'is_off', entered: 'is_occupied', empty: 'is_empty', occupied: 'is_occupied', arrives: 'is_home', leaves: 'is_away', detected: 'is_active', starts_playing: 'is_playing', wet: 'is_wet' }
      : { is_open: 'opens', is_closed: 'closes', is_on: 'turns_on', is_off: 'turns_off', is_occupied: 'entered', is_empty: 'empty', is_home: 'arrives', is_away: 'leaves', is_active: 'detected', is_playing: 'starts_playing', is_wet: 'wet' };
    this._update((r) => {
      r.type = type;
      r.when = r.when.map((c) => ({ ...c, verb: map[c.verb] ?? c.verb }));
      if (type === 'when') delete r.else;
    });
  }

  private _line(section: Section, c: Clause | undefined, i: number) {
    const r = this._r;
    const tone = toneOf(r, section);
    const word = joiner(r, section, i);
    const open = (step: 'subject' | 'verb') => (this._picker = { section, index: i, step });
    if (!c)
      return html`<div class="line ${tone}">
        <span class="kw">${word}</span>
        <span class="words"><button class="tap empty" @click=${() => open('subject')}>${icon(mdiPlus, 18)}${section === 'when' ? (r.type === 'while' ? t('rules.empty_while') : t('rules.empty_when')) : t('rules.empty_then')}</button></span>
      </div>`;
    if (isLogic(c))
      return html`<div class="line ${tone}">
        <span class="kw">${word}</span>
        <hr-logic
          style="flex:1;min-width:0"
          .store=${this.store}
          .clause=${c}
          .triggerIds=${this._triggerIds()}
          @change=${(e: CustomEvent<Clause | null>) => {
            const next = e.detail;
            this._update((x) => {
              const list = (x[section] ??= []);
              if (next) list[i] = next;
              else list.splice(i, 1);
            });
          }}
        ></hr-logic>
      </div>`;
    const v = clauseView(this.store, c, section);
    const flavourOk = findVerb(v.subject?.kind ?? c.subject, c.verb)?.flavour === flavourFor(section, r.type) || !v.subject;
    return html`<div class="line ${tone}">
      <span class="kw">${word}</span>
      <span class="words">
        ${v.verbPre
          ? html`<button class="tap verb ${v.sensitive ? 'sensitive' : ''}" @click=${() => open('verb')}>
              ${v.sensitive ? icon(mdiShieldLockOutline, 18) : nothing}${v.verbPre}${!v.verb && (!flavourOk || v.unknownVerb) ? ' ⚠︎' : ''}
            </button>`
          : nothing}
        ${v.subject
          ? html`<button class="tap ${v.subject.missing ? 'missing' : ''}" @click=${() => open('subject')} aria-label=${t('rules.change_x', { name: v.subject.label })}>
              ${icon(v.subject.icon, 20)}${v.subject.label}
            </button>`
          : nothing}
        ${v.verb || !v.verbPre
          ? html`<button class="tap verb ${v.sensitive ? 'sensitive' : ''}" @click=${() => open('verb')}>
              ${v.sensitive && !v.verbPre ? icon(mdiShieldLockOutline, 18) : nothing}${v.verb}${!flavourOk || v.unknownVerb ? ' ⚠︎' : ''}
            </button>`
          : nothing}
        ${v.mods.map((m) => html`<button class="tap mod" @click=${() => open('verb')}>${m}</button>`)}
      </span>
      ${(section === 'then' || section === 'else') && c.subject !== 'wait'
        ? html`<button class="icon-btn rm play" title=${t('rules.run_step')} aria-label=${t('rules.run_step')} @click=${() => this._runSteps(i, section === 'else')}>${icon(mdiPlay, 18)}</button>`
        : nothing}
      <button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => this._remove(section, i)}>${icon(mdiClose, 18)}</button>
    </div>`;
  }

  private _add(section: Section, label: string, extra?: Clause, tab?: string) {
    const r = this._r;
    return html`<button
      class="add ${toneOf(r, section)}"
      @click=${() => {
        if (extra) this._update((x) => (x[section] ??= []).push(extra));
        else this._picker = { section, index: (r[section] ?? []).length, step: 'subject', tab };
      }}
    >
      ${icon(mdiPlus, 16)}${label}
    </button>`;
  }

  private _canvas() {
    const r = this._r;
    const lines = (section: Section) => (r[section] ?? []).map((c, i) => html`${this._line(section, c, i)}${this._alts(section, c, i)}`);
    const toggle = r.type === 'while' && !!r.else;
    const restore = r.options.restore !== false;
    return html`<section class="card canvas" aria-label=${t('rules.as_sentence')}>
      ${r.when.length ? lines('when') : this._line('when', undefined, 0)}
      ${lines('and')}
      <div class="adds">
        ${r.when.length ? this._add('when', ADD_LABEL.when(r)) : nothing} ${this._add('and', ADD_LABEL.and(r))}
      </div>
      <div class="divider"></div>
      ${r.then.length ? lines('then') : this._line('then', undefined, 0)}
      <div class="adds">
        ${r.then.length ? this._add('then', ADD_LABEL.then(r)) : nothing}
        ${r.then.length ? this._add('then', t('rules.add_wait'), { subject: 'wait', verb: 'wait', for: '5m' }) : nothing}
        ${r.then.length ? this._add('then', t('rules.add_start_rule'), undefined, 'rules') : nothing}
      </div>
      ${toggle
        ? html`<div class="divider"></div>
            ${r.else!.length ? lines('else') : this._line('else', undefined, 0)}
            <div class="adds">
              ${r.else!.length ? this._add('else', ADD_LABEL.else(r)) : nothing}
              ${r.else!.length ? this._add('else', t('rules.add_wait'), { subject: 'wait', verb: 'wait', for: '5m' }) : nothing}
            </div>
            <p class="while-note">${t('rules.toggle_note')}</p>`
        : r.type === 'while' && r.then.length
          ? html`<button class="restore" role="switch" aria-checked=${restore ? 'true' : 'false'} @click=${() => this._update((x) => (x.options = { ...x.options, restore: !restore }))}>
              ${icon(restore ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 22)}
              <span><b>${t('rules.restore')}</b><span>${restore ? t('rules.restore_on') : t('rules.restore_off')}</span></span>
            </button>`
          : nothing}
      ${r.only.length ? html`<div class="divider"></div>${lines('only')}` : nothing}
      <div class="adds">${this._add('only', r.only.length ? t('rules.add_and_only_if') : t('rules.add_only_if_more'))}</div>
    </section>`;
  }

  private _testCard() {
    const test = this._test;
    const r = this._r;
    const ready = r.when.length && r.then.length;
    return html`<section class="card test tone-then">
      <div class="test-head">
        <span class="badge">${icon(mdiFlask, 22)}</span>
        <div><b>${t('rules.test_run')}</b><span>${t('rules.test_run_sub')}</span></div>
        <button class="btn tinted small" ?disabled=${!ready || test === 'busy'} @click=${this._runTest}>${test && test !== 'busy' ? t('rules.again') : t('rules.check_now')}</button>
      </div>
      <div class="test-head">
        <span class="badge">${icon(mdiPlay, 22)}</span>
        <div><b>${t('rules.run_now')}</b><span>${t('rules.run_now_sub')}</span></div>
        <button class="btn tinted small" ?disabled=${!r.then.length || this._ran?.busy} @click=${() => this._runSteps()}>${t('rules.all_steps')}</button>
      </div>
      ${this._ran ? html`<div class="ran" role="status">${this._ran.text}</div>` : nothing}
      ${test && test !== 'busy'
        ? html`<div class="checks">
              ${test.checks.map((c) => {
                const clause = r[c.section][c.index];
                const trigger = c.section === 'when' && r.type === 'when';
                return html`<div class="check">
                  <span class=${trigger ? 'wait' : c.ok ? 'ok' : 'no'}>${icon(trigger ? mdiClockOutline : c.ok ? mdiCheckCircle : mdiCloseCircle, 20)}</span>
                  <div>${clauseText(this.store, clause, c.section)}<small>${trigger ? t('rules.trigger_waits') : t('rules.now_is', { now: c.now })}</small></div>
                </div>`;
              })}
            </div>
            <div class="verdict">
              ${test.verdict}
              <ul>
                ${test.would.map((w) => html`<li>${w}</li>`)}
              </ul>
            </div>`
        : nothing}
    </section>`;
  }

  private _options() {
    const r = this._r;
    const o = r.options;
    const set = (k: keyof Rule['options'], v: unknown) => this._update((x) => ((x.options as Record<string, unknown>)[k] = v));
    const sensitive = r.then.some((c) => clauseView(this.store, c, 'then').sensitive);
    const seg = (k: keyof Rule['options'], opts: [string, string][]) =>
      html`<div class="seg">
        ${opts.map(([v, label]) => html`<button aria-pressed=${(o[k] ?? '') === v ? 'true' : 'false'} @click=${() => set(k, v)}>${label}</button>`)}
      </div>`;
    return html`<section>
      <details ?open=${this._more} @toggle=${(e: Event) => (this._more = (e.target as HTMLDetailsElement).open)}>
        <summary class="row group"><span class="grow"><b>${t('rules.options')}</b><div class="sub">${t('rules.options_sub')}</div></span>${icon(mdiChevronDown, 20)}</summary>
        <div class="group" style="margin-top:8px">
          <div class="row opt">
            <span class="grow"><div class="title">${t('rules.cooldown')}</div><div class="sub">${t('rules.cooldown_sub')}</div></span>
            ${seg('cooldown', [['', t('rules.always')], ['5m', formatDuration('5m')], ['30m', formatDuration('30m')], ['1h', formatDuration('1h')], ['1d', t('rules.once_a_day')]])}
          </div>
          <div class="row opt">
            <span class="grow"><div class="title">${t('rules.manual')}</div><div class="sub">${t('rules.manual_sub')}</div></span>
            ${seg('manual_pause', [['', t('rules.manual_always')], ['30m', t('rules.manual_pause', { d: formatDuration('30m') })], ['1h', t('rules.manual_pause', { d: formatDuration('1h') })], ['room_empty', t('rules.manual_room_empty')]])}
          </div>
          ${this.store.ollama
            ? html`<div class="row">
                <span class="grow"><div class="title">${t('rules.ai_check')}</div><div class="sub">${t('rules.ai_check_sub')}</div></span>
                <button class="switch" role="switch" aria-checked=${o.ai_check ? 'true' : 'false'} @click=${() => set('ai_check', !o.ai_check)}></button>
              </div>`
            : nothing}
          <div class="row">
            <span class="grow"><div class="title">${t('rules.notify_me')}</div></span>
            <button class="switch" role="switch" aria-checked=${o.notify_me ? 'true' : 'false'} @click=${() => set('notify_me', !o.notify_me)}></button>
          </div>
          ${sensitive
            ? html`<div class="row">
                ${icon(mdiShieldLockOutline, 22)}
                <span class="grow"><div class="title">${t('rules.allow_sensitive')}</div><div class="sub">${t('rules.allow_sensitive_sub')}</div></span>
                <button class="switch" role="switch" aria-checked=${o.allow_sensitive ? 'true' : 'false'} @click=${() => set('allow_sensitive', !o.allow_sensitive)}></button>
              </div>`
            : nothing}
        </div>
      </details>
    </section>`;
  }

  /** trigger ids of a when rule (for "choose" blocks) */
  private _triggerIds(): string[] {
    const r = this._r;
    return r.type === 'when' ? [...new Set(r.when.map((c) => String(c.id ?? '')).filter(Boolean))] : [];
  }

  /** "Erweitert": how it runs when set off again, trigger ids, groups and step blocks (logic.py) */
  private _advanced() {
    const r = this._r;
    const o = r.options;
    const mode = o.mode ?? 'single';
    const set = (patch: Partial<Rule['options']>) => this._update((x) => (x.options = { ...x.options, ...patch }));
    const condSection: Section = r.type === 'while' ? 'when' : 'and';
    return html`<section>
      <details ?open=${this._adv} @toggle=${(e: Event) => (this._adv = (e.target as HTMLDetailsElement).open)}>
        <summary class="row group"><span class="grow"><b>${t('logic.advanced')}</b><div class="sub">${t('logic.advanced_sub')}</div></span>${icon(mdiChevronDown, 20)}</summary>
        <div class="group" style="margin-top:8px">
          ${r.type === 'when'
            ? html`<div class="row opt">
                  <span class="grow"><div class="title">${t('logic.run_mode')}</div><div class="sub">${t(`logic.run_mode_${mode}_sub`)}</div></span>
                  <div class="seg">
                    ${(['single', 'restart', 'queued', 'parallel'] as const).map((m) => html`<button aria-pressed=${mode === m ? 'true' : 'false'} @click=${() => set({ mode: m })}>${t(`logic.run_mode_${m}`)}</button>`)}
                  </div>
                </div>
                ${mode === 'queued' || mode === 'parallel'
                  ? html`<div class="row"><span class="grow"><div class="title">${t('logic.run_max')}</div></span>
                      <input type="number" min="1" max="100" style="width:5em" .value=${String(o.max ?? 10)} aria-label=${t('logic.run_max')} @change=${(e: Event) => set({ max: Math.max(1, Math.min(100, Number((e.target as HTMLInputElement).value) || 10)) })} /></div>`
                  : nothing}
                ${r.when.length
                  ? html`<div class="row opt">
                      <span class="grow"><div class="title">${t('logic.trigger_ids')}</div><div class="sub">${t('logic.trigger_ids_sub')}</div></span>
                    </div>
                    ${r.when.map(
                      (c, i) => html`<div class="row">
                        <span class="grow">${clauseText(this.store, c, 'when')}</span>
                        <input style="width:8em" .value=${String(c.id ?? '')} placeholder=${t('logic.trigger_id')} aria-label=${t('logic.trigger_id')}
                          @change=${(e: Event) => this._update((x) => { const v = (e.target as HTMLInputElement).value.trim().slice(0, 30); if (v) x.when[i] = { ...x.when[i], id: v }; else { const { id: _id, ...rest } = x.when[i]; x.when[i] = rest as Clause; } })} />
                      </div>`,
                    )}`
                  : nothing}`
            : nothing}
          <div class="row opt">
            <span class="grow"><div class="title">${t('logic.add_group')}</div><div class="sub">${t('logic.add_group_sub')}</div></span>
            <div class="seg">
              ${(['all', 'any', 'not'] as const).map((g) => html`<button @click=${() => this._update((x) => (x[condSection] ??= []).push(newBlock(g)))}>${t(BLOCK_LABEL[g])}</button>`)}
            </div>
          </div>
          <div class="row opt">
            <span class="grow"><div class="title">${t('logic.add_block')}</div><div class="sub">${t('logic.add_block_sub')}</div></span>
          </div>
          <div class="seg" style="flex-wrap:wrap">
            ${STEP_VERBS.map((v) => html`<button @click=${() => this._update((x) => x.then.push(newBlock(v)))}>${t(BLOCK_LABEL[v])}</button>`)}
          </div>
        </div>
      </details>
    </section>`;
  }

  private _links() {
    const l = links(this.store, this._r);
    if (!l.to.length && !l.from.length) return nothing;
    const open = (rule: Rule) => this.dispatchEvent(new CustomEvent('hr-open-rule', { detail: { rule: structuredClone(rule) }, bubbles: true, composed: true }));
    return html`<section class="card test linked">
      <div class="test-head"><span>${icon(mdiLinkVariant, 22)}</span><div><b>${t('rules.linked')}</b><span>${t('rules.linked_sub')}</span></div></div>
      ${l.from.map((x) => html`<div>${t('rules.follows_on')} <button @click=${() => open(x)}>${quote(x.name)}</button></div>`)}
      ${l.to.map((x) => html`<div>${t('rules.leads_to_one')} <button @click=${() => open(x)}>${quote(x.name)}</button></div>`)}
    </section>`;
  }

  override render() {
    const r = this._r;
    const ready = r.when.length > 0 && r.then.length > 0;
    const existing = !this.isNew && this.store.rule(r.id);
    return html`
      <header class="bar">
        <div class="grow">
          <h1>${this.isNew ? t('rules.new_rule') : t('rules.edit_rule')}</h1>
          <div class="sub">
            ${r.type === 'while' ? t('rules.type_while_rule') : t('rules.type_when_rule')}${existing && existing.meta?.last_run
              ? ` · ${t('rules.last_run', { when: relTime(existing.meta.last_run) })}`
              : ''}${existing && existing.meta?.runs_week ? ` · ${t('rules.runs_week', { n: existing.meta.runs_week })}` : ''}
          </div>
        </div>
        <button class="icon-btn" aria-label=${t('common.close')} title=${t('common.close')} @click=${this._close}>${icon(mdiClose, 22)}</button>
      </header>
      <div class="body">
        ${this.fromText
          ? html`<div class="from-text">
              ${icon(mdiCreation, 18)}
              <div>
                ${t('rules.from_text_before')} <q>${this.fromText}</q> ${t('rules.from_text_after')}
                ${this.unsure?.length
                  ? html`<ul class="unsure">${this.unsure.map((u) => html`<li>${u}</li>`)}</ul>`
                  : html`<br /><span class="sure">${t('rules.all_understood')}</span>`}
                ${this._improve?.busy ? html`<br /><span class="muted">${t('rules.ai_checking_sentence')}</span>` : nothing}
                ${this._improve && !this._improve.busy && this._improve.text ? html`<br /><span class="muted">${this._improve.text}</span>` : nothing}
                ${this._improve?.rule
                  ? html`<br /><b>${t('rules.ai_proposal')}</b> <i>${this._improve.sentence}</i>
                      <button
                        class="btn small tinted"
                        style="margin-left:6px"
                        @click=${() => {
                          const imp = this._improve!.rule!;
                          this._update((x) => {
                            Object.assign(x, { type: imp.type, when: imp.when, and: imp.and, then: imp.then, only: imp.only });
                            if (imp.else) x.else = imp.else;
                            else delete x.else;
                          });
                          this._improve = { busy: false, text: t('rules.ai_proposal_applied') };
                        }}
                      >
                        ${t('common.apply')}
                      </button>`
                  : nothing}
              </div>
            </div>`
          : nothing}

        <textarea
          id="rule-name"
          class="name"
          rows="1"
          .value=${r.name}
          placeholder=${ready ? this._autoName(r) : t('rules.name')}
          @input=${(e: Event) => this._update((x) => (x.name = (e.target as HTMLTextAreaElement).value.replace(/\n/g, ' ')))}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && e.preventDefault()}
          aria-label=${t('rules.name')}
        ></textarea>

        ${this._groupField()}

        <div class="types" role="group" aria-label=${t('rules.type')}>
          <button class="type tone-when" aria-pressed=${r.type === 'when' ? 'true' : 'false'} @click=${() => this._setType('when')}>
            ${icon(mdiLightningBolt, 22)}<div><b>${t('rules.type_when')}</b><span>${t('rules.type_when_sub')}</span></div>
          </button>
          <button class="type tone-while" aria-pressed=${r.type === 'while' && !r.else ? 'true' : 'false'} @click=${() => this._setType('while')}>
            ${icon(mdiInfinity, 22)}<div><b>${t('rules.type_while')}</b><span>${t('rules.type_while_sub')}</span></div>
          </button>
          <button class="type tone-while" aria-pressed=${r.type === 'while' && !!r.else ? 'true' : 'false'} @click=${() => this._setType('toggle')}>
            ${icon(mdiSwapHorizontal, 22)}<div><b>${t('rules.type_toggle')}</b><span>${t('rules.type_toggle_sub')}</span></div>
          </button>
        </div>

        ${this._canvas()} ${this._testCard()} ${this._reviewCard()} ${this._links()} ${this._options()} ${this._advanced()}

        <section>
          <details ?open=${this._json} @toggle=${(e: Event) => (this._json = (e.target as HTMLDetailsElement).open)}>
            <summary class="row group">${icon(mdiCodeJson, 22)}<span class="grow"><b>${t('rules.expert')}</b><div class="sub">${t('rules.expert_sub')}</div></span>${icon(mdiChevronDown, 20)}</summary>
            <p class="muted" style="margin:8px 4px;font-size:13px">${ruleSentence(this.store, r)}</p>
            <pre>${JSON.stringify({ name: r.name, type: r.type, when: r.when, and: r.and, then: r.then, ...(r.else ? { else: r.else } : {}), only: r.only, options: r.options }, null, 2)}</pre>
          </details>
        </section>

        ${existing && this.store.canEdit
          ? html`<div class="danger-zone">
              <button class="btn small" @click=${() => this.store.pause(r.id, new Date(Date.now() + 3600000).toISOString()).then(() => this._close())}>
                ${icon(mdiPauseCircleOutline, 18)}${t('rules.pause_hour')}
              </button>
              <button
                class="btn small"
                @click=${() => {
                  const d = new Date(Date.now() + 86400000);
                  d.setHours(6, 0, 0, 0);
                  this.store.pause(r.id, d.toISOString()).then(() => this._close());
                }}
              >
                ${t('rules.until_tomorrow')}
              </button>
              <span style="flex:1"></span>
              ${this._confirmDelete
                ? html`<span class="muted">${t('rules.really_delete')}</span>
                    <button class="btn small" @click=${() => (this._confirmDelete = false)}>${t('common.no')}</button>
                    <button class="btn danger small" @click=${() => this._delete(r)}>${t('common.delete')}</button>`
                : html`<button class="btn danger small" @click=${() => (this._confirmDelete = true)}>${icon(mdiDeleteOutline, 18)}${t('common.delete')}</button>`}
            </div>`
          : nothing}
        <div class="danger-zone">
          ${existing ? html`<button class="btn small" @click=${() => (this._side = 'history')}>${icon(mdiHistory, 18)}${t('rel.history')}</button>` : nothing}
          <button class="btn small" ?disabled=${!ready} @click=${() => (this._side = 'export')}>${icon(mdiHomeAutomation, 18)}${t('rel.export')}</button>
        </div>
        ${!ready ? html`<p class="hint-save">${t('rules.save_hint')}</p>` : nothing}
        ${!this.store.canEdit ? html`<p class="hint-save">${t('rel.guest_cannot_edit')}</p>` : nothing}
      </div>
      <footer class="foot">
        <button class="btn" @click=${this._close}>${t('common.cancel')}</button>
        <button class="btn primary" ?disabled=${!ready || !this.store.canEdit} @click=${this._save}>${t('common.save')}</button>
      </footer>

      ${this._side === 'history'
        ? html`<hr-sheet width="640" label=${t('rel.history')} @close=${() => (this._side = null)}>
            <hr-rule-history
              .store=${this.store}
              .ruleId=${r.id}
              @close=${() => (this._side = null)}
              @restored=${() => {
                const fresh = this.store.rule(r.id);
                if (fresh) this._r = structuredClone(fresh);
              }}
            ></hr-rule-history>
          </hr-sheet>`
        : nothing}
      ${this._side === 'export'
        ? html`<hr-sheet width="720" label=${t('rel.sheet_export')} @close=${() => (this._side = null)}>
            <hr-rule-export
              .store=${this.store}
              .rule=${r}
              @close=${() => (this._side = null)}
              @created=${() => {
                this._side = null;
                this._close();
              }}
            ></hr-rule-export>
          </hr-sheet>`
        : nothing}
      ${this._picker
        ? html`<hr-sheet width="560" label=${t('rules.choice')} @close=${() => (this._picker = null)}>
            <hr-picker
              .store=${this.store}
              .rule=${r}
              .section=${this._picker.section}
              .clause=${this._picker.alt !== undefined
                ? ((r[this._picker.section] ?? [])[this._picker.index]?.or ?? [])[this._picker.alt]
                : (r[this._picker.section] ?? [])[this._picker.index]}
              .step=${this._picker.step}
              ._tab=${this._picker.tab ?? 'quick'}
              @pick=${this._onPick}
              @close=${() => (this._picker = null)}
            ></hr-picker>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('house-rules-editor', HouseRulesEditor);
