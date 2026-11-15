import { LitElement, css, html, svg } from 'lit';
import { components } from '../design/components';
import { t } from '../i18n';

/** How a room's temperature appears on the plan: a label above the room, a label inside it, or engraved into a wall */
export type LabelStyle = 'outside' | 'inside' | 'wall';

export function labelStyleOf(cfg: { label_style?: string; labels?: string }): LabelStyle {
  return cfg.label_style === 'wall' ? 'wall' : cfg.labels === 'inside' ? 'inside' : 'outside';
}

/** Writes the choice into a card configuration (the defaults stay unset) */
export function setLabelStyle(cfg: { label_style?: string; labels?: string }, v: LabelStyle) {
  cfg.label_style = v === 'wall' ? 'wall' : undefined;
  cfg.labels = v === 'inside' ? 'inside' : undefined;
}

/** A tiny sketch of a room seen from above and slightly tilted, with the temperature as the style shows it */
function sketch(v: LabelStyle) {
  const room = svg`<path class="floor" d="M14 30 L50 20 L86 30 L50 42 Z"></path>
    <path class="wall" d="M14 30 L14 18 L50 8 L50 20 Z"></path>
    <path class="wall side" d="M50 8 L86 18 L86 30 L50 20 Z"></path>`;
  if (v === 'wall')
    return svg`${room}<text class="engraved" x="32" y="21" transform="skewY(-15.5) translate(0 9)" text-anchor="middle">21°</text>`;
  if (v === 'inside') return svg`${room}<rect class="pill" x="36" y="25" width="28" height="11" rx="5.5"></rect><text class="pill-t" x="50" y="33" text-anchor="middle">21°</text>`;
  return svg`${room}<line class="stem" x1="50" y1="12" x2="50" y2="31"></line><rect class="pill" x="34" y="1" width="32" height="12" rx="6"></rect><text class="pill-t" x="50" y="9.6" text-anchor="middle">21°</text>`;
}

/**
 * <fp-label-style>: the three ways to show a room's temperature as small picture tiles (a radio group), so one sees
 * what one gets before choosing. Fires "value-change" with the new style. Used in the editor's settings and the tour.
 */
export class FpLabelStyle extends LitElement {
  static override properties = { value: { type: String } };
  declare value: LabelStyle;

  constructor() {
    super();
    this.value = 'outside';
  }

  private pick(v: LabelStyle) {
    if (v === this.value) return;
    this.value = v;
    this.dispatchEvent(new CustomEvent('value-change', { detail: { value: v }, bubbles: true, composed: true }));
  }

  override render() {
    const opts: { v: LabelStyle; label: string }[] = [
      { v: 'outside', label: t('editor.values_outside') },
      { v: 'inside', label: t('editor.values_inside') },
      { v: 'wall', label: t('editor.values_wall') },
    ];
    const onKey = (e: KeyboardEvent) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const i = opts.findIndex((o) => o.v === this.value);
      this.pick(opts[(i + d + opts.length) % opts.length].v);
      void this.updateComplete.then(() => (this.renderRoot.querySelector('button[aria-checked="true"]') as HTMLElement | null)?.focus());
    };
    return html`<div class="tiles" role="radiogroup" aria-label=${t('editor.values_title')} @keydown=${onKey}>
      ${opts.map(
        (o) => html`<button
          class="ls-tile pressable"
          role="radio"
          data-style=${o.v}
          aria-checked=${o.v === this.value ? 'true' : 'false'}
          tabindex=${o.v === this.value ? 0 : -1}
          @click=${() => this.pick(o.v)}
        >
          <svg viewBox="0 0 100 46" aria-hidden="true">${sketch(o.v)}</svg>
          <span class="lbl">${o.label}</span>
        </button>`,
      )}
    </div>`;
  }

  static override styles = [
    components,
    css`
      :host {
        display: block;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--fp-space-2);
      }
      .ls-tile {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: 100%;
        box-sizing: border-box;
        gap: var(--fp-space-1);
        min-width: 0;
        padding: var(--fp-space-2) var(--fp-space-1);
        border: 0;
        border-radius: var(--fp-radius-m);
        background: var(--fp-fill, rgba(120, 120, 128, 0.12));
        box-shadow: inset 0 0 0 1.5px transparent;
        color: var(--fp-label);
        font: inherit;
        cursor: pointer;
      }
      .ls-tile[aria-checked='true'] {
        background: color-mix(in srgb, var(--fp-accent) 12%, var(--fp-surface));
        box-shadow: inset 0 0 0 1.5px var(--fp-accent);
      }
      .ls-tile:focus-visible {
        outline: 2px solid var(--fp-accent);
        outline-offset: 2px;
      }
      svg {
        display: block;
        flex: none;
        width: 100px;
        max-width: 100%;
        height: 46px;
        margin: 0 auto;
        overflow: visible;
      }
      .lbl {
        font-size: var(--fp-text-caption);
        font-weight: var(--fp-weight-semibold);
        text-align: center;
        line-height: 1.2;
      }
      .floor {
        fill: var(--fp-surface);
        stroke: var(--fp-label-3, rgba(120, 120, 128, 0.6));
        stroke-width: 0.8;
      }
      .wall {
        fill: color-mix(in srgb, var(--fp-label) 10%, var(--fp-surface));
        stroke: var(--fp-label-3, rgba(120, 120, 128, 0.6));
        stroke-width: 0.8;
      }
      .wall.side {
        fill: color-mix(in srgb, var(--fp-label) 16%, var(--fp-surface));
      }
      .pill {
        fill: var(--fp-surface);
        stroke: var(--fp-label-3, rgba(120, 120, 128, 0.6));
        stroke-width: 0.6;
      }
      .pill-t,
      .engraved {
        font: 600 7.5px system-ui, sans-serif;
        fill: var(--fp-label);
      }
      .engraved {
        fill: color-mix(in srgb, var(--fp-label) 55%, transparent);
      }
      .stem {
        stroke: var(--fp-label-3, rgba(120, 120, 128, 0.6));
        stroke-width: 0.8;
      }
    `,
  ];
}
if (!customElements.get('fp-label-style')) customElements.define('fp-label-style', FpLabelStyle);
