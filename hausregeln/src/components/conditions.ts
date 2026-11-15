/**
 * <hr-conditions>: a list of conditions ("und"-linked states) edited with the same chips and picker as a rule.
 * Used for the automatic house mode and the smart alarm exceptions. Fires "change" with detail = new list.
 */
import { css, html, nothing } from 'lit';
import { mdiClose, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import type { Clause, Rule } from '../model';
import { newRule } from '../store';
import { clauseView } from '../describe';
import { icon, shared } from '../design/shared';
import '../editor/picker';
import '../editor/logic';
import { BLOCK_LABEL, STEP_VERBS, isLogic, newBlock } from '../editor/logic-blocks';
import './sheet';
import { t } from '../i18n';
// i18n: complete

export class HrConditions extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    clauses: { attribute: false },
    presets: { attribute: false },
    heading: {},
    joiner: {},
    section: {},
    advanced: { type: Boolean },
    triggerIds: { attribute: false },
    _pick: { state: true },
  };
  /** what the list holds: conditions ("and", default), steps ("then") or triggers ("when") */
  declare section: 'and' | 'then' | 'when';
  /** offer the blocks of the advanced logic (groups; for steps if/choose/repeat …) */
  declare advanced: boolean;
  /** the rule's trigger ids, handed to "choose" blocks */
  declare triggerIds: string[];
  declare clauses: Clause[];
  declare presets: { label: string; clause: Clause }[];
  declare heading: string;
  /** word between the lines: "und" (all must hold) or "oder" (one is enough, e.g. triggers) */
  /** 'und'/'oder' (older callers) or 'and'/'or'; shown in the user's language */
  declare joiner: 'und' | 'oder' | 'and' | 'or'; // i18n-ignore (values, not text)
  declare _pick: { index: number; alt?: number; step: 'subject' | 'verb' } | null;

  constructor() {
    super();
    this.clauses = [];
    this.presets = [];
    this.heading = '';
    this.joiner = 'and';
    this.section = 'and';
    this.advanced = false;
    this.triggerIds = [];
    this._pick = null;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
        --tone: var(--hr-and);
      }
      .line {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        flex-wrap: wrap;
        padding: 6px var(--hr-space-3);
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
        font-family: var(--hr-font-sentence);
      }
      .kw {
        color: var(--tone);
        font-weight: 700;
        min-width: 2.6em;
      }
      .tap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 2px 12px 2px 8px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
        font-weight: 600;
      }
      .tap .ic {
        color: var(--tone);
      }
      .tap.verb {
        background: none;
        font-weight: 500;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--tone) 55%, transparent);
        text-underline-offset: 4px;
      }
      .grow {
        flex: 1;
      }
      .rm {
        width: 34px;
        height: 34px;
        color: var(--hr-label-3);
      }
      .adds {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
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
        background: color-mix(in srgb, var(--tone) 10%, transparent);
      }
      .line.alt {
        margin-left: var(--hr-space-4);
      }
      .add.or {
        min-height: 28px;
        padding: 0 10px;
      }
      .preset {
        color: var(--hr-label-2);
        background: var(--hr-fill);
      }
      .empty {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        padding: var(--hr-space-2) var(--hr-space-1);
      }
      hr-sheet hr-picker {
        flex: 1;
      }
    `,
  ];

  private _emit(list: Clause[]) {
    this.clauses = list;
    this.dispatchEvent(new CustomEvent('change', { detail: list }));
  }

  private get _rule(): Rule {
    if (this.section === 'then') return newRule({ type: 'when', then: this.clauses });
    if (this.section === 'when') return newRule({ type: 'when', when: this.clauses });
    return newRule({ type: 'while', and: this.clauses });
  }

  /** the word in front of line i */
  private _kw(i: number): string {
    if (this.section === 'then') return i === 0 ? t('join.then') : t('join.and');
    if (this.section === 'when') return i === 0 ? t('join.when') : t('join.or');
    return i === 0 ? t('rules.cond_if') : /^(oder|or)$/.test(this.joiner) ? t('join.or') : t('join.and');
  }

  override render() {
    const list = this.clauses ?? [];
    const has = (c: Clause) => list.some((x) => x.subject === c.subject && x.verb === c.verb);
    return html`
      ${list.length
        ? list.map((c, i) => {
            if (isLogic(c))
              return html`<hr-logic
                .store=${this.store}
                .clause=${c}
                .triggerIds=${this.triggerIds}
                @change=${(e: CustomEvent<Clause | null>) => {
                  e.stopPropagation();
                  this._emit(e.detail ? list.map((x, n) => (n === i ? e.detail! : x)) : list.filter((_x, n) => n !== i));
                }}
              ></hr-logic>`;
            const v = clauseView(this.store, c, this.section);
            return html`<div class="line">
              <span class="kw">${this._kw(i)}</span>
              ${v.subject ? html`<button class="tap" @click=${() => (this._pick = { index: i, step: 'subject' })}>${icon(v.subject.icon, 18)}${v.subject.label}</button>` : nothing}
              <button class="tap verb" @click=${() => (this._pick = { index: i, step: 'verb' })}>${v.verb}${v.mods.length ? ` · ${v.mods.join(' · ')}` : ''}</button>
              <span class="grow"></span>
              ${this.section === 'and'
                ? html`<button class="add or" title=${t('rules.or_title')} @click=${() => (this._pick = { index: i, alt: (c.or ?? []).length, step: 'subject' })}>${t('rules.or_more')}</button>`
                : nothing}
              <button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => this._emit(list.filter((_, n) => n !== i))}>${icon(mdiClose, 18)}</button>
            </div>
            ${(c.or ?? []).map((alt, a) => {
              const av = clauseView(this.store, alt, 'and');
              return html`<div class="line alt">
                <span class="kw">${t('join.or')}</span>
                ${av.subject ? html`<button class="tap" @click=${() => (this._pick = { index: i, alt: a, step: 'subject' })}>${icon(av.subject.icon, 18)}${av.subject.label}</button>` : nothing}
                <button class="tap verb" @click=${() => (this._pick = { index: i, alt: a, step: 'verb' })}>${av.verb}${av.mods.length ? ` · ${av.mods.join(' · ')}` : ''}</button>
                <span class="grow"></span>
                <button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => {
                  const next = list.map((x, n) => (n === i ? { ...x, or: (x.or ?? []).filter((_y, m) => m !== a) } : x));
                  if (!next[i].or?.length) delete next[i].or;
                  this._emit(next);
                }}>${icon(mdiClose, 18)}</button>
              </div>`;
            })}`;
          })
        : html`<div class="empty">${this.section === 'then' ? t('logic.no_step') : t('rules.no_condition')}</div>`}
      <div class="adds">
        <button class="add" @click=${() => (this._pick = { index: list.length, step: 'subject' })}>${icon(mdiPlus, 16)}${this.section === 'then' ? t('logic.step') : this.section === 'when' ? t('logic.trigger') : t('rules.condition')}</button>
        ${this.advanced && this.section === 'and' ? html`<button class="add preset" @click=${() => this._emit([...list, newBlock('any')])}>${icon(mdiPlus, 16)}${t('logic.group')}</button>` : nothing}
        ${this.advanced && this.section === 'then'
          ? STEP_VERBS.map((v) => html`<button class="add preset" @click=${() => this._emit([...list, newBlock(v)])}>${icon(mdiPlus, 16)}${t(BLOCK_LABEL[v])}</button>`)
          : nothing}
        ${this.presets.filter((p) => !has(p.clause)).map((p) => html`<button class="add preset" @click=${() => this._emit([...list, p.clause])}>${icon(mdiPlus, 16)}${p.label}</button>`)}
      </div>
      ${this._pick
        ? html`<hr-sheet width="560" label=${t('rules.choice')} @close=${() => (this._pick = null)}>
            <hr-picker
              .store=${this.store}
              .rule=${this._rule}
              section=${this.section}
              .heading=${this.heading || (this.section === 'then' ? t('logic.step') : this.section === 'when' ? t('logic.trigger') : t('rules.cond_pick'))}
              .clause=${this._pick.alt !== undefined ? (list[this._pick.index]?.or ?? [])[this._pick.alt] : list[this._pick.index]}
              .step=${this._pick.step}
              @pick=${(e: CustomEvent<Clause>) => {
                const next = [...list];
                const p = this._pick!;
                if (p.alt !== undefined) {
                  const or = [...(next[p.index].or ?? [])];
                  or[p.alt] = e.detail;
                  next[p.index] = { ...next[p.index], or };
                } else next[p.index] = { ...e.detail, ...(next[p.index]?.or ? { or: next[p.index].or } : {}) };
                this._pick = null;
                this._emit(next);
              }}
              @close=${() => (this._pick = null)}
            ></hr-picker>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('hr-conditions', HrConditions);
