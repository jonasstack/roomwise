import { LitElement, css, html, nothing } from 'lit';
import { mdiClose } from '@mdi/js';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { t } from '../i18n';
import './sheet';
// i18n: complete

/**
 * <hr-pop>: a pop-up of the redesigned pages (designed in the doku portal as "rl-pop"): a header with title, a
 * line below it and room for a switch or a gear (slot "head"), a scrolling body (default slot, use the .rl-sec /
 * .rl-box / .rl-list blocks of design/kit.ts) and an optional footer (slot "foot", e.g. Abbrechen / Speichern).
 * Lies on an <hr-sheet> (scrim, Escape, page lock; bottom sheet on phones). Several can be open at once: a pop-up
 * opened from another one is drawn after it (render it as a sibling, not inside the first one's slot).
 *
 *   <hr-pop heading="Wohnzimmer" sub="jemand da · 12 lx" @close=${…}>
 *     <button slot="head" class="icon-btn">…gear…</button>
 *     <div class="rl-sec">…</div>
 *     <button slot="foot" class="btn primary">Fertig</button>
 *   </hr-pop>
 *
 * Fires "close" (scrim, Escape, ×). `narrow` = 520 px wide instead of 680.
 */
export class HrPop extends LitElement {
  static override properties = {
    heading: { type: String },
    sub: { attribute: false },
    narrow: { type: Boolean },
    wide: { type: Boolean },
    _foot: { state: true },
  };
  declare heading: string;
  /** line under the title: text or a template (chips) */
  declare sub: unknown;
  declare narrow: boolean;
  declare wide: boolean;
  declare _foot: boolean;

  constructor() {
    super();
    this.heading = '';
    this.sub = '';
    this.narrow = false;
    this.wide = false;
    this._foot = false;
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: contents;
      }
      .pop {
        display: flex;
        flex-direction: column;
        min-height: 0;
        max-height: 100%;
        flex: 1;
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-4) var(--hr-space-4) var(--hr-space-3) var(--hr-space-6);
        background: var(--hr-surface);
        border-bottom: 0.5px solid var(--hr-separator);
      }
      .head .grow {
        flex: 1;
        min-width: 0;
      }
      h2 {
        font-size: var(--hr-text-title2);
        font-weight: 800;
        letter-spacing: -0.02em;
        overflow-wrap: anywhere;
      }
      .sub {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin-top: 2px;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }
      .body {
        padding: var(--hr-space-4) var(--hr-space-6) var(--hr-space-5);
        overflow: auto;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        min-height: 0;
        flex: 1;
      }
      .foot {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--hr-space-2);
        flex-wrap: wrap;
        padding: var(--hr-space-3) var(--hr-space-6);
        background: var(--hr-surface);
        border-top: 0.5px solid var(--hr-separator);
      }
      .foot[hidden] {
        display: none;
      }
      ::slotted([slot='head']) {
        flex: none;
      }
      /* the body is a column: blocks keep their height and the body scrolls (else groups get cut off) */
      .body ::slotted(*) {
        flex-shrink: 0;
      }
      @media (max-width: 640px) {
        .head {
          padding-left: var(--hr-space-4);
        }
        .body,
        .foot {
          padding-left: var(--hr-space-4);
          padding-right: var(--hr-space-4);
        }
      }
    `,
  ];

  private _close = () => this.dispatchEvent(new CustomEvent('close'));

  override render() {
    const width = this.narrow ? 520 : this.wide ? 820 : 680;
    return html`<hr-sheet width=${width} label=${this.heading} @close=${(e: Event) => (e.stopPropagation(), this._close())}>
      <div class="pop">
        <div class="head">
          <div class="grow">
            <h2>${this.heading}</h2>
            ${this.sub ? html`<div class="sub">${this.sub}</div>` : nothing}
          </div>
          <slot name="head"></slot>
          <button class="icon-btn" aria-label=${t('common.close')} title=${t('common.close')} @click=${this._close}>${icon(mdiClose, 22)}</button>
        </div>
        <div class="body"><slot></slot></div>
        <div class="foot" ?hidden=${!this._foot}><slot name="foot" @slotchange=${(e: Event) => (this._foot = (e.target as HTMLSlotElement).assignedElements().length > 0)}></slot></div>
      </div>
    </hr-sheet>`;
  }
}
customElements.define('hr-pop', HrPop);
