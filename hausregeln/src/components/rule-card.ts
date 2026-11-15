import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiInfinity, mdiLightningBolt, mdiLinkVariant, mdiPauseCircleOutline } from '@mdi/js';
import type { Rule } from '../model';
import type { Store } from '../store';
import { relTime } from '../describe';
import { icon } from '../design/shared';
import { links, sentence } from '../sentence';
import { ruleSentence } from '../describe';
import { quote, t } from '../i18n';
// i18n: complete

export const ruleCardStyles = css`
  .rule {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    padding: var(--hr-space-4);
    text-align: left;
    width: 100%;
    min-width: 0;
    cursor: pointer;
    transition: transform var(--hr-dur-fast) var(--hr-ease);
  }
  .rule:active {
    transform: scale(0.99);
  }
  .rule.off .sentence,
  .rule.off .head h3 {
    opacity: 0.45;
  }
  .rule .head {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
  }
  .rule .badge {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
    color: var(--tone);
    flex: none;
  }
  .rule h3 {
    flex: 1;
    min-width: 0;
    font-size: var(--hr-text-body);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .sentence {
    font-family: var(--hr-font-sentence);
    font-size: var(--hr-text-subhead);
    line-height: 1.75;
  }
  .sentence .part::after {
    content: ' ';
  }
  .rule .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .rule .foot .meta {
    margin-right: auto;
    font-variant-numeric: tabular-nums;
  }
  .rule-tile .badge {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
    color: var(--tone);
    flex: none;
  }
  .rule-tile h3 {
    font-size: var(--hr-text-body);
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .rule-tile .top {
    align-items: flex-start;
  }
  .rule-tile.off .text,
  .rule-tile.off h3 {
    opacity: 0.5;
  }
  .rule-tile.off {
    opacity: 1;
  }
`;

export function isActive(store: Store, rule: Rule): boolean {
  return rule.type === 'while' && rule.enabled && store.isActive(rule);
}

export function ruleCard(
  store: Store,
  rule: Rule,
  on: { open: (r: Rule) => void; toggle: (r: Rule, v: boolean) => void },
  opts: { compact?: boolean } = {},
): TemplateResult {
  const paused = rule.paused_until && new Date(rule.paused_until).getTime() > Date.now();
  const l = links(store, rule);
  const active = isActive(store, rule);
  const tone = rule.type === 'while' ? 'tone-while' : 'tone-when';
  return html`<article
    class="card rule ${tone} ${!rule.enabled || paused ? 'off' : ''}"
    tabindex="0"
    @click=${() => on.open(rule)}
    @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && on.open(rule)}
  >
    <div class="head">
      <span class="badge" title=${rule.type === 'while' ? t('rules.type_while_rule') : t('rules.type_when_rule')}>${icon(rule.type === 'while' ? mdiInfinity : mdiLightningBolt, 18)}</span>
      <h3>${rule.name || t('rules.no_name')}</h3>
      <button
        class="switch"
        role="switch"
        aria-checked=${rule.enabled ? 'true' : 'false'}
        aria-label=${t('rules.toggle')}
        @click=${(e: Event) => {
          e.stopPropagation();
          on.toggle(rule, !rule.enabled);
        }}
      ></button>
    </div>
    ${sentence(store, rule, { limit: opts.compact ? 2 : 3 })}
    <div class="foot">
      <span class="meta">${rule.meta?.last_run ? t('rules.last_run', { when: relTime(rule.meta.last_run) }) : t('rules.never_ran')}${rule.meta?.runs_week ? ` · ${t('rules.runs_week', { n: rule.meta.runs_week })}` : ''}</span>
      ${active ? html`<span class="pill live"><span class="dot on"></span>${t('rules.active_now')}</span>` : nothing}
      ${paused ? html`<span class="pill warn">${icon(mdiPauseCircleOutline, 14)}${t('rules.paused_until', { when: relTime(rule.paused_until) })}</span>` : nothing}
      ${!opts.compact && rule.meta?.replaces?.length ? html`<span class="pill">${t('rules.replaces', { n: rule.meta.replaces.length })}</span>` : nothing}
      ${!opts.compact && l.to.length ? html`<span class="pill accent">${icon(mdiLinkVariant, 14)}${t('rules.leads_to', { rules: l.to.map((r) => quote(r.name)).join(', ') })}</span>` : nothing}
      ${!opts.compact && l.from.length ? html`<span class="pill accent">${icon(mdiLinkVariant, 14)}${t('rules.follows', { rules: l.from.map((r) => quote(r.name)).join(', ') })}</span>` : nothing}
    </div>
  </article>`;
}

/** a rule as a tile of the rules page (redesign): type, name, switch, the sentence (3 lines), last run and chips.
 * Needs the `kit` styles and `ruleCardStyles` (tones). The whole tile opens the rule. */
export function ruleTile(store: Store, rule: Rule, on: { open: (r: Rule) => void; toggle: (r: Rule, v: boolean) => void }): TemplateResult {
  const paused = rule.paused_until && new Date(rule.paused_until).getTime() > Date.now();
  const l = links(store, rule);
  const active = isActive(store, rule);
  const tone = rule.type === 'while' ? 'tone-while' : 'tone-when';
  return html`<article class="rl-tile small rule-tile ${tone} ${!rule.enabled || paused ? 'off' : ''}">
    <button class="rl-open" aria-label=${rule.name || t('rules.no_name')} @click=${() => on.open(rule)}></button>
    <div class="top">
      <span class="badge" title=${rule.type === 'while' ? t('rules.type_while_rule') : t('rules.type_when_rule')}>${icon(rule.type === 'while' ? mdiInfinity : mdiLightningBolt, 18)}</span>
      <h3 class="grow">${rule.name || t('rules.no_name')}</h3>
      <button class="switch" role="switch" aria-checked=${rule.enabled ? 'true' : 'false'} aria-label=${t('rules.toggle_x', { name: rule.name || t('rules.no_name') })} @click=${() => on.toggle(rule, !rule.enabled)}></button>
    </div>
    <p class="text">${ruleSentence(store, rule)}</p>
    <div class="foot">
      <span>${paused ? t('rules.paused_until', { when: relTime(rule.paused_until) }) : rule.meta?.last_run ? t('rules.last_run', { when: relTime(rule.meta.last_run) }) : t('rules.never_ran')}${!paused && rule.meta?.runs_week ? ` · ${t('rules.runs_week', { n: rule.meta.runs_week })}` : ''}</span>
      ${active || paused || rule.meta?.replaces?.length || l.to.length || l.from.length
        ? html`<span class="rl-chips">
            ${active ? html`<span class="rl-chip yes">${t('rules.active_now')}</span>` : nothing}
            ${paused ? html`<span class="rl-chip warm">${icon(mdiPauseCircleOutline, 14)}${t('rules.paused')}</span>` : nothing}
            ${rule.meta?.replaces?.length ? html`<span class="rl-chip" title=${t('rules.replaces', { n: rule.meta.replaces.length })}>${t('rules.replaces_short', { n: rule.meta.replaces.length })}</span>` : nothing}
            ${l.to.length ? html`<span class="rl-chip acc" title=${t('rules.leads_to', { rules: l.to.map((r) => quote(r.name)).join(', ') })}>${icon(mdiLinkVariant, 14)}${t('rules.leads_to_short')}</span>` : nothing}
            ${l.from.length ? html`<span class="rl-chip acc" title=${t('rules.follows', { rules: l.from.map((r) => quote(r.name)).join(', ') })}>${icon(mdiLinkVariant, 14)}${t('rules.follows_short')}</span>` : nothing}
          </span>`
        : nothing}
    </div>
  </article>`;
}
