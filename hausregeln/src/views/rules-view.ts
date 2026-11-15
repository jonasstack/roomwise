/**
 * <hr-rules-view>: the area "Regeln" (redesign, portal design i12faf5412a / ie3c979c536). On top a box to describe
 * a new rule in free text, a line with the suggestions for the home (opens a pop-up with all of them), filter chips
 * and the rules as equal tiles, grouped by topic (automatic) or in own groups ("Abendroutine", set up behind the
 * gear in the head: page layout settings "ui", nothing changes what runs). A tile opens the rule editor.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  mdiArrowUp,
  mdiChevronDown,
  mdiChevronRight,
  mdiChevronUp,
  mdiClose,
  mdiCreation,
  mdiDeleteOutline,
  mdiEyeOffOutline,
  mdiEyeOutline,
  mdiLightbulbOnOutline,
  mdiPencilOutline,
  mdiPlus,
} from '@mdi/js';
import { StoreElement } from '../base';
import type { Rule, RuleGroup, Suggestion } from '../model';
import type { Store } from '../store';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { isActive, ruleCardStyles, ruleTile } from '../components/rule-card';
import { registerPage } from '../components/page';
import '../components/pop';
import { sentence } from '../sentence';
import { quote, t, tn, type I18nKey } from '../i18n';
// i18n: complete

const paused = (r: Rule) => !r.enabled || (!!r.paused_until && new Date(r.paused_until).getTime() > Date.now());

/** status filter, label: t(`rules.filter_${id}`) */
const STATUS: { id: string; test: (r: Rule, active: boolean) => boolean }[] = [
  { id: 'all', test: () => true },
  { id: 'active', test: (_r, a) => a },
  { id: 'paused', test: (r) => paused(r) },
];

/** topics: the "Art" filter (own groups) and the automatic grouping, in this order of precedence for a rule with
 * several topics; label: t(`rules.topic_${id}`) */
const TOPICS = ['safety', 'media', 'light', 'heating', 'presence', 'cleaning', 'energy'] as const;
const topicOf = (r: Rule): string => TOPICS.find((x) => r.tags?.includes(x)) ?? 'other';

const EXAMPLES = (): string[] => [t('rules.example_1'), t('rules.example_2'), t('rules.example_3')];

/** id for an own group: "g_" and six letters/digits */
const newGroupId = () => `g_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

registerPage('rules', {
  gear: true,
  sub: (s: Store) => {
    const active = s.rules.filter((r) => isActive(s, r)).length;
    const off = s.rules.filter(paused).length;
    return html`<b>${tn('panel.rules_count', s.rules.length)}</b> · ${tn('panel.active_count', active)}${off ? ` · ${t('panel.paused_count', { n: off })}` : ''}`;
  },
});

/** the name pop-up: a new group or renaming one */
interface NameEdit {
  id?: string;
  name: string;
}

export class HrRulesView extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _status: { state: true },
    _topic: { state: true },
    _text: { state: true },
    _busy: { state: true },
    _writing: { state: true },
    _sugg: { state: true },
    _gear: { state: true },
    _name: { state: true },
    _del: { state: true },
  };
  declare _status: string;
  /** "Art" filter (own groups only): a topic or 'all' */
  declare _topic: string;
  declare _text: string;
  declare _busy: boolean;
  /** the describe box has the focus: then it shows the examples and the note */
  declare _writing: boolean;
  /** pop-up with all suggestions */
  declare _sugg: boolean;
  /** pop-up "Gruppierung der Regeln" (gear in the head) */
  declare _gear: boolean;
  declare _name: NameEdit | null;
  /** group to delete (confirmation) */
  declare _del: string | null;

  constructor() {
    super();
    this._status = 'all';
    this._topic = 'all';
    this._text = '';
    this._busy = false;
    this._writing = false;
    this._sugg = false;
    this._gear = false;
    this._name = null;
    this._del = null;
  }

  /** gear in the head: how the rules are grouped */
  openGear(): void {
    this._gear = true;
  }

  protected override reveal(anchor: string): void {
    if (anchor === 'suggestions') this._sugg = true;
    else if (anchor === 'grouping') this._gear = true;
    else super.reveal(anchor);
  }

  static override styles = [
    shared,
    kit,
    ruleCardStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
      }
      section {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        min-width: 0;
      }

      /* Free text */
      .askrow {
        display: flex;
        align-items: flex-start;
        gap: var(--hr-space-3);
      }
      .ask {
        flex: 1;
        min-width: 0;
        padding: var(--hr-space-3);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--hr-when) 9%, var(--hr-surface)),
          color-mix(in srgb, var(--hr-then) 9%, var(--hr-surface)) 55%,
          color-mix(in srgb, var(--hr-while) 9%, var(--hr-surface))
        );
      }
      .ask-line {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        background: var(--hr-surface);
        border-radius: var(--hr-radius-m);
        padding: 6px 6px 6px var(--hr-space-4);
        box-shadow: var(--hr-shadow-1);
      }
      .ask-line .ic {
        color: var(--hr-while);
      }
      .ask-line input {
        flex: 1;
        min-width: 0;
        border: 0;
        background: none;
        outline: none;
        font-size: var(--hr-text-body);
        font-family: var(--hr-font-sentence);
        min-height: 40px;
      }
      .ask-line input::placeholder {
        color: var(--hr-label-3);
      }
      .ask .send {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--hr-accent);
        color: var(--hr-on-accent);
        flex: none;
      }
      .ask .send[disabled] {
        background: var(--hr-fill-strong);
        color: var(--hr-label-3);
      }
      .ask .examples {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      .ask .examples button {
        font-size: var(--hr-text-footnote);
        padding: 6px 12px;
        border-radius: var(--hr-radius-full);
        background: color-mix(in srgb, var(--hr-surface) 70%, transparent);
        color: var(--hr-label-2);
        text-align: left;
      }
      .ask .hint {
        font-size: var(--hr-text-caption);
        color: var(--hr-label-2);
      }
      /* the examples and the note only while writing (or while there are hardly any rules yet) */
      .ask:not(.open) .examples,
      .ask:not(.open) .hint {
        display: none;
      }
      .askrow > .btn {
        margin-top: var(--hr-space-3);
        min-height: 52px;
      }
      .spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid currentColor;
        border-right-color: transparent;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (max-width: 640px) {
        .askrow {
          flex-direction: column;
          align-items: stretch;
        }
        .askrow > .btn {
          margin-top: 0;
          min-height: var(--hr-hit);
        }
      }

      /* The line with the suggestions */
      .sugg-line {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-3) var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-l);
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        text-align: left;
        width: 100%;
      }
      .sugg-line > .ic {
        color: var(--hr-accent);
      }
      .sugg-line .grow {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: var(--hr-space-3);
      }
      .sugg-line b {
        font-size: var(--hr-text-subhead);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: none;
        max-width: 100%;
      }
      .sugg-line .titles {
        font-size: var(--hr-text-subhead);
        color: var(--hr-label-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .sugg-line .go {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: var(--hr-text-subhead);
        font-weight: 600;
        color: var(--hr-accent);
        white-space: nowrap;
      }
      @media (max-width: 640px) {
        .sugg-line .titles {
          display: none;
        }
      }

      /* four tiles in a row on a laptop */
      .rl-grid.four {
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      @media (max-width: 640px) {
        .rl-grid.four {
          grid-template-columns: 1fr;
        }
      }

      /* Filters */
      .filters {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3) var(--hr-space-5);
        flex-wrap: wrap;
      }
      .filters .lbl {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
        min-width: 0;
        max-width: 100%;
      }
      .filters .lbl > span {
        font-size: var(--hr-text-caption);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--hr-label-2);
      }
      .seg .muted {
        margin-left: 2px;
      }
      .empty {
        padding: var(--hr-space-7) var(--hr-space-4);
        text-align: center;
        color: var(--hr-label-2);
      }

      /* Suggestions pop-up */
      .sug .top {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .sug .top .ic {
        color: var(--hr-accent);
      }
      .sug .top .grow {
        flex: 1;
      }
      .sug h3 {
        font-size: var(--hr-text-body);
        font-weight: 600;
        text-wrap: balance;
      }
      .sug p {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.45;
      }
      .sug .sentence {
        font-size: var(--hr-text-footnote);
        line-height: 1.7;
        padding: var(--hr-space-2) var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface-2);
      }
      .sug .x {
        width: 36px;
        height: 36px;
        margin: -6px -6px -6px 0;
      }

      /* Grouping pop-up */
      .grp .name {
        flex: 1;
        min-width: 0;
      }
      .grp.hid .name b {
        color: var(--hr-label-2);
        font-weight: 500;
      }
      .grp .acts {
        display: flex;
        gap: 2px;
        flex: none;
      }
      .grp .acts .icon-btn {
        width: 38px;
        height: 38px;
      }
      .head-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--hr-space-2);
        margin: 0 var(--hr-space-2);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .field input {
        font-size: var(--hr-text-body);
        color: var(--hr-label);
        background: var(--hr-surface);
        border: 0;
        border-radius: var(--hr-radius-m);
        box-shadow: var(--hr-shadow-1);
        padding: 12px 14px;
        outline: none;
      }
    `,
  ];

  private async _ask(text = this._text) {
    if (!text.trim() || this._busy) return;
    this._text = text;
    this._busy = true;
    try {
      const draft = await this.store.fromText(text);
      const source = draft.source?.startsWith('ai') || draft.source?.startsWith('ollama') ? t('rules.source_ai', { model: draft.model ?? t('rules.language_model') }) : draft.source ? t('rules.source_basic') : undefined;
      fire(this, 'hr-open-rule', { rule: draft.rule, isNew: true, unsure: draft.unsure, fromText: text, source });
      this._text = '';
    } finally {
      this._busy = false;
    }
  }

  // ------------------------------------------------------------------ suggestions
  private _suggestion(x: Suggestion) {
    const s = this.store;
    return html`<div class="rl-box sug">
      <div class="top">
        ${icon(x.icon, 18)}<span class="eyebrow grow">${x.badge ?? t('rules.suggestion')}</span>
        <button class="icon-btn x" aria-label=${t('rules.hide_suggestion')} title=${t('rules.hide_suggestion')} @click=${() => s.dismissSuggestion(x.id)}>${icon(mdiClose, 18)}</button>
      </div>
      <h3>${x.title}</h3>
      <p>${x.why}</p>
      ${x.rule ? sentence(s, x.rule) : nothing}
      <div class="acts">
        ${x.rule
          ? html`<button
              class="btn tinted small"
              @click=${() => {
                this._sugg = false;
                fire(this, 'hr-open-rule', { rule: structuredClone(x.rule), isNew: true, suggestion: x.id });
              }}
            >
              ${t('rules.view_and_apply')}
            </button>`
          : x.task === 'heat_block'
            ? html`<button class="btn tinted small" @click=${() => s.heatingDo('accept_proposal', undefined, x.id)}>${t('common.apply')}</button>`
            : html`<button
                class="btn tinted small"
                @click=${() => {
                  this._sugg = false;
                  fire(this, 'hr-task', { task: x.task, suggestion: x.id });
                }}
              >
                ${t('rules.sort_now')}
              </button>`}
      </div>
    </div>`;
  }

  private _suggPop() {
    const list = this.store.suggestions;
    return html`<hr-pop heading=${t('rules.suggestions_title')} .sub=${tn('rules.suggestions_count', list.length)} @close=${() => (this._sugg = false)}>
      ${list.length ? list.map((x) => this._suggestion(x)) : html`<p class="rl-note">${t('rules.suggestions_none')}</p>`}
      <button slot="foot" class="btn primary" @click=${() => (this._sugg = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  // ------------------------------------------------------------------ own groups
  private _groupsSave(groups: RuleGroup[]) {
    return this.store.saveUi({ groups });
  }

  private _moveGroup(id: string, by: number) {
    const g = [...this.store.ui.groups];
    const i = g.findIndex((x) => x.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j], g[i]];
    this._groupsSave(g);
  }

  private _gearPop() {
    const s = this.store;
    const ui = s.ui;
    const count = (id: string) => s.rules.filter((r) => r.group === id).length;
    const known = new Set(ui.groups.map((g) => g.id));
    const loose = s.rules.filter((r) => !r.group || !known.has(r.group)).length;
    return html`<hr-pop heading=${t('rules.grouping_title')} .sub=${ui.grouping === 'manual' ? tn('rules.grouping_manual_n', ui.groups.length) : t('rules.grouping_auto')} @close=${() => (this._gear = false)}>
      <div class="rl-sec">
        <h3>${t('rules.grouping_how')}</h3>
        <div class="rl-tg two" role="radiogroup" aria-label=${t('rules.grouping_how')}>
          <button role="radio" aria-pressed=${ui.grouping === 'auto' ? 'true' : 'false'} aria-checked=${ui.grouping === 'auto' ? 'true' : 'false'} ?disabled=${!s.canEdit} @click=${() => s.saveUi({ grouping: 'auto' })}>
            ${t('rules.grouping_auto')}<small>${t('rules.grouping_auto_sub')}</small>
          </button>
          <button role="radio" aria-pressed=${ui.grouping === 'manual' ? 'true' : 'false'} aria-checked=${ui.grouping === 'manual' ? 'true' : 'false'} ?disabled=${!s.canEdit} @click=${() => s.saveUi({ grouping: 'manual' })}>
            ${t('rules.grouping_manual')}<small>${t('rules.grouping_manual_sub')}</small>
          </button>
        </div>
      </div>
      <div class="rl-sec">
        <div class="head-line">
          <h3>${t('rules.groups_own')}</h3>
          ${s.canEdit ? html`<button class="btn small tinted" @click=${() => (this._name = { name: '' })}>${icon(mdiPlus, 18)}${t('rules.group_new')}</button>` : nothing}
        </div>
        ${ui.groups.length
          ? html`<div class="rl-list">
              ${ui.groups.map(
                (g, i) => html`<div class="rl-item grp ${g.hidden ? 'hid' : ''}">
                  <span class="name"><b>${g.name}</b><small>${tn('rules.group_rules', count(g.id))}${g.hidden ? ` · ${t('rules.group_hidden')}` : ''}</small></span>
                  ${s.canEdit
                    ? html`<span class="acts">
                        <button class="icon-btn" ?disabled=${i === 0} aria-label=${t('rules.group_up', { name: g.name })} @click=${() => this._moveGroup(g.id, -1)}>${icon(mdiChevronUp, 20)}</button>
                        <button class="icon-btn" ?disabled=${i === ui.groups.length - 1} aria-label=${t('rules.group_down', { name: g.name })} @click=${() => this._moveGroup(g.id, 1)}>${icon(mdiChevronDown, 20)}</button>
                        <button
                          class="icon-btn"
                          aria-label=${g.hidden ? t('rules.group_show', { name: g.name }) : t('rules.group_hide', { name: g.name })}
                          title=${g.hidden ? t('rules.group_show', { name: g.name }) : t('rules.group_hide', { name: g.name })}
                          @click=${() => this._groupsSave(ui.groups.map((x) => (x.id === g.id ? { ...x, hidden: !x.hidden } : x)))}
                        >
                          ${icon(g.hidden ? mdiEyeOffOutline : mdiEyeOutline, 20)}
                        </button>
                        <button class="icon-btn" aria-label=${t('rules.group_rename', { name: g.name })} title=${t('rules.group_rename', { name: g.name })} @click=${() => (this._name = { id: g.id, name: g.name })}>${icon(mdiPencilOutline, 20)}</button>
                        <button class="icon-btn" aria-label=${t('rules.group_delete', { name: g.name })} title=${t('rules.group_delete', { name: g.name })} @click=${() => (this._del = g.id)}>${icon(mdiDeleteOutline, 20)}</button>
                      </span>`
                    : nothing}
                </div>`,
              )}
            </div>`
          : html`<p class="rl-note">${t('rules.groups_none')}</p>`}
        <p class="rl-note">${t('rules.groups_loose', { n: loose })}</p>
      </div>
      <div class="rl-info">${icon(mdiLightbulbOnOutline, 18)}<span>${t('rules.groups_note')}</span></div>
      <button slot="foot" class="btn primary" @click=${() => (this._gear = false)}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _namePop(edit: NameEdit) {
    const s = this.store;
    const ui = s.ui;
    const ideas = [t('rules.group_idea_1'), t('rules.group_idea_2'), t('rules.group_idea_3'), t('rules.group_idea_4')].filter((x) => !ui.groups.some((g) => g.name === x));
    const name = edit.name.trim();
    const save = async () => {
      if (!name) return;
      if (edit.id) await this._groupsSave(ui.groups.map((g) => (g.id === edit.id ? { ...g, name } : g)));
      else await s.saveUi({ groups: [...ui.groups, { id: newGroupId(), name, hidden: false }], grouping: 'manual' });
      this._name = null;
    };
    return html`<hr-pop narrow heading=${edit.id ? t('rules.group_rename_title') : t('rules.group_new')} @close=${() => (this._name = null)}>
      <label class="field"
        >${t('rules.group_name')}
        <input
          .value=${edit.name}
          placeholder=${t('rules.group_name_ph')}
          maxlength="60"
          @input=${(e: InputEvent) => (this._name = { ...edit, name: (e.target as HTMLInputElement).value })}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && save()}
        />
      </label>
      ${!edit.id && ideas.length
        ? html`<div class="rl-sec">
            <h3>${t('rules.group_ideas')}</h3>
            <div class="rl-tg">${ideas.map((x) => html`<button aria-pressed=${name === x ? 'true' : 'false'} @click=${() => (this._name = { ...edit, name: x })}>${x}</button>`)}</div>
          </div>`
        : nothing}
      ${!edit.id ? html`<p class="rl-note">${t('rules.group_new_note')}</p>` : nothing}
      <button slot="foot" class="btn" @click=${() => (this._name = null)}>${t('common.cancel')}</button>
      <button slot="foot" class="btn primary" ?disabled=${!name} @click=${save}>${edit.id ? t('common.apply') : t('rules.group_create')}</button>
    </hr-pop>`;
  }

  private _delPop(id: string) {
    const s = this.store;
    const g = s.ui.groups.find((x) => x.id === id);
    if (!g) return nothing;
    const members = s.rules.filter((r) => r.group === id);
    return html`<hr-pop narrow heading=${t('rules.group_delete_title', { name: quote(g.name) })} @close=${() => (this._del = null)}>
      <p class="rl-note">${tn('rules.group_delete_text', members.length)}</p>
      ${members.length ? html`<div class="rl-box"><small>${members.map((r) => r.name).join(' · ')}</small></div>` : nothing}
      <button slot="foot" class="btn" @click=${() => (this._del = null)}>${t('common.cancel')}</button>
      <button
        slot="foot"
        class="btn danger"
        @click=${async () => {
          await this._groupsSave(s.ui.groups.filter((x) => x.id !== id));
          this._del = null;
        }}
      >
        ${t('rules.group_delete_do')}
      </button>
    </hr-pop>`;
  }

  // ------------------------------------------------------------------ page
  /** the rules in their groups: topics (automatic) or own groups, then "Weitere Regeln" */
  private _sections(list: Rule[]): { id: string; name: string; rules: Rule[] }[] {
    const ui = this.store.ui;
    if (ui.grouping === 'manual') {
      const known = new Set(ui.groups.map((g) => g.id));
      const out = ui.groups.filter((g) => !g.hidden).map((g) => ({ id: g.id, name: g.name, rules: list.filter((r) => r.group === g.id) }));
      out.push({ id: 'more', name: t('rules.more_rules'), rules: list.filter((r) => !r.group || !known.has(r.group)) });
      return out.filter((x) => x.rules.length);
    }
    return [...TOPICS, 'other']
      .map((id) => ({ id, name: t(`rules.topic_${id}` as I18nKey), rules: list.filter((r) => topicOf(r) === id) }))
      .filter((x) => x.rules.length);
  }

  override render() {
    const s = this.store;
    const manual = s.ui.grouping === 'manual';
    const status = STATUS.find((f) => f.id === this._status) ?? STATUS[0];
    const topic = manual ? this._topic : 'all';
    const list = s.rules.filter((r) => status.test(r, isActive(s, r)) && (topic === 'all' || r.tags?.includes(topic)));
    const handlers = {
      open: (rule: Rule) => fire(this, 'hr-open-rule', { rule: structuredClone(rule) }),
      toggle: (rule: Rule, v: boolean) => s.setEnabled(rule.id, v),
    };
    const n = s.suggestions.length;
    const sections = this._sections(list);
    const chip = (id: string, label: string, count: number, cur: string, set: (v: string) => void): TemplateResult =>
      html`<button aria-pressed=${cur === id ? 'true' : 'false'} @click=${() => set(id)}>${label}<span class="muted">${count}</span></button>`;
    return html`
      <div class="askrow">
        <section
          class="card ask ${this._writing || s.rules.length < 3 || this._text ? 'open' : ''}"
          aria-label=${t('rules.describe_rule')}
          @focusin=${() => (this._writing = true)}
          @focusout=${(e: FocusEvent) => {
            const box = e.currentTarget as HTMLElement;
            // a moment later, so that a tap on an example still reaches it
            setTimeout(() => (this._writing = box.contains(this.shadowRoot?.activeElement ?? null)), 250);
          }}
        >
          <form
            class="ask-line"
            @submit=${(e: Event) => {
              e.preventDefault();
              this._ask();
            }}
          >
            ${icon(mdiCreation, 22)}
            <input
              id="ask"
              .value=${this._text}
              @input=${(e: InputEvent) => (this._text = (e.target as HTMLInputElement).value)}
              placeholder=${t('rules.ask_placeholder')}
              aria-label=${t('rules.describe_rule')}
              autocomplete="off"
              enterkeyhint="send"
            />
            <button class="send" type="submit" aria-label=${t('rules.create_draft')} title=${t('rules.create_draft')} ?disabled=${!this._text.trim() || this._busy}>
              ${this._busy ? html`<span class="spinner"></span>` : icon(mdiArrowUp, 20)}
            </button>
          </form>
          <div class="examples">${EXAMPLES().map((x) => html`<button @click=${() => this._ask(x)}>${quote(x)}</button>`)}</div>
          <span class="hint">${s.ollama ? t('rules.hint_ollama') : t('rules.hint_basic')}</span>
        </section>
        ${s.canEdit ? html`<button class="btn primary" @click=${() => fire(this, 'hr-open-rule', { isNew: true })}>${icon(mdiPlus, 20)}${t('rules.new_rule')}</button>` : nothing}
      </div>

      ${n
        ? html`<button class="sugg-line" id="suggestions" @click=${() => (this._sugg = true)}>
            ${icon(mdiLightbulbOnOutline, 22)}
            <span class="grow"><b>${tn('rules.suggestions_folded', n)}</b><span class="titles">${s.suggestions.map((x) => x.title).join(' · ')}</span></span>
            <span class="go">${t('rules.suggestions_open')}${icon(mdiChevronRight, 18)}</span>
          </button>`
        : nothing}

      <section id="rules" aria-label=${t('rules.your_rules')}>
        <div class="filters">
          <div class="lbl">
            <span>${t('rules.filter_status')}</span>
            <div class="seg" role="group" aria-label=${t('rules.filter_status')}>
              ${STATUS.map((f) => {
                const c = s.rules.filter((r) => f.test(r, isActive(s, r))).length;
                return f.id === 'all' || c ? chip(f.id, t(`rules.filter_${f.id}` as I18nKey), c, this._status, (v) => (this._status = v)) : nothing;
              })}
            </div>
          </div>
          ${manual
            ? html`<div class="lbl">
                <span>${t('rules.filter_kind')}</span>
                <div class="seg" role="group" aria-label=${t('rules.filter_kind')}>
                  ${chip('all', t('rules.filter_all'), s.rules.length, topic, (v) => (this._topic = v))}
                  ${TOPICS.map((x) => {
                    const c = s.rules.filter((r) => r.tags?.includes(x)).length;
                    return c ? chip(x, t(`rules.topic_${x}` as I18nKey), c, topic, (v) => (this._topic = v)) : nothing;
                  })}
                </div>
              </div>`
            : nothing}
        </div>
        ${sections.length
          ? sections.map(
              (sec) => html`<h2 class="rl-group-h">${sec.name}<span class="muted">${sec.rules.length}</span></h2>
                <div class="rl-grid four">${sec.rules.map((r) => ruleTile(s, r, handlers))}</div>`,
            )
          : html`<div class="empty">${s.rules.length ? t('rules.filter_empty') : t('rules.none_yet')}</div>`}
      </section>

      ${this._sugg ? this._suggPop() : nothing} ${this._gear ? this._gearPop() : nothing} ${this._name ? this._namePop(this._name) : nothing}
      ${this._del ? this._delPop(this._del) : nothing}
    `;
  }
}
customElements.define('hr-rules-view', HrRulesView);
