import { LitElement, css, html, nothing } from 'lit';
import { components } from '../design/components';
import type { HomeAssistant } from '../types';
import { t, type I18nKey } from '../i18n';
import '../components/label-style';

/**
 * <fp-editor-tour>: a short guided tour of the editor's main tools (draw, doors and windows, furniture with
 * devices under "Other", settings, save). A ring marks the tool, a bubble next to it explains it; "Skip" ends it at any step.
 * Once finished or skipped it is remembered per Home Assistant user (HA's user data, with a local copy) and only
 * starts again from the toolbar button. Fires "tour-end".
 */

const KEY = 'roomwise_editor_tour';

interface Step {
  /** the tool the ring marks; none: a choice in the middle of the screen */
  sel?: string;
  title: I18nKey;
  text: I18nKey;
  /** a choice made right in the bubble: how temperatures appear (label outside / inside / engraved in the wall) */
  pick?: 'labels';
}

export const TOUR_STEPS: Step[] = [
  { sel: '[data-tool="draw"]', title: 'tour.draw_title', text: 'tour.draw_text' },
  { sel: '[data-tool="door"]', title: 'tour.openings_title', text: 'tour.openings_text' },
  { sel: '[data-panel="furniture"]', title: 'tour.furniture_title', text: 'tour.furniture_text' },
  { sel: '[data-panel="settings"]', title: 'tour.settings_title', text: 'tour.settings_text' },
  { title: 'tour.labels_title', text: 'tour.labels_text', pick: 'labels' },
  { sel: '.toolbar .save', title: 'tour.save_title', text: 'tour.save_text' },
];

const localKey = (hass: HomeAssistant) => `fp-tour-${hass.user?.id ?? 'anon'}`;

/** Has this user finished or skipped the tour (on any device)? */
export async function tourSeen(hass: HomeAssistant): Promise<boolean> {
  try {
    if (localStorage.getItem(localKey(hass)) === '1') return true;
  } catch {
    /* storage blocked */
  }
  try {
    const r = await hass.callWS<{ value?: { done?: boolean } | null }>({ type: 'frontend/get_user_data', key: KEY });
    return !!r?.value?.done;
  } catch {
    return false;
  }
}

export function markTourSeen(hass: HomeAssistant) {
  try {
    localStorage.setItem(localKey(hass), '1');
  } catch {
    /* storage blocked */
  }
  void hass.callWS({ type: 'frontend/set_user_data', key: KEY, value: { done: true } }).catch(() => undefined);
}

export class FpEditorTour extends LitElement {
  static override properties = { root: { attribute: false }, labelStyle: { type: String }, _step: { state: true }, _box: { state: true } };
  declare root: ShadowRoot;
  /** the plan's current label style (for the choice step); a pick fires "label-style" with { value } */
  declare labelStyle?: string;
  declare _step: number;
  declare _box?: DOMRect;

  constructor() {
    super();
    this._step = 0;
  }

  private onResize = () => this.measure();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.measure());
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.onResize);
  }

  /** steps whose tool is not on screen (e.g. hidden on a narrow phone) are left out */
  private get steps(): Step[] {
    return TOUR_STEPS.filter((s) => {
      if (!s.sel) return true;
      const el = this.root?.querySelector(s.sel) as HTMLElement | null;
      return !!el && el.getClientRects().length > 0;
    });
  }

  private measure() {
    const s = this.steps[this._step];
    if (s && !s.sel) {
      // a choice without a tool: the bubble in the middle, no ring
      this._box = new DOMRect(window.innerWidth / 2, window.innerHeight / 2 - 120, 0, 0);
      return;
    }
    const el = s?.sel && (this.root?.querySelector(s.sel) as HTMLElement | null);
    this._box = el ? el.getBoundingClientRect() : undefined;
  }

  private go(i: number) {
    if (i >= this.steps.length) return this.end(false);
    this._step = i;
    this.measure();
  }

  private end(skipped: boolean) {
    this.dispatchEvent(new CustomEvent('tour-end', { detail: { skipped }, bubbles: true, composed: true }));
  }

  override render() {
    const steps = this.steps;
    const s = steps[this._step];
    const b = this._box;
    if (!s || !b) return nothing;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    const W = Math.min(s.pick ? 360 : 300, vw - 32);
    // bubble: right of the tool if there is room (the tool rail), else below it (toolbar), kept on screen
    const right = !!s.sel && b.right + 14 + W < vw && b.top > 72;
    let x = right ? b.right + 14 : b.left + b.width / 2 - W / 2;
    let y = right ? b.top + b.height / 2 - 60 : b.bottom + 14;
    x = Math.max(16, Math.min(vw - W - 16, x));
    y = Math.max(16, Math.min(vh - 200, y));
    const last = this._step === steps.length - 1;
    return html`<div class="scrim" @click=${(e: Event) => e.stopPropagation()}></div>
      ${s.sel
        ? html`<div class="ring" style=${`left:${b.left - pad}px;top:${b.top - pad}px;width:${b.width + 2 * pad}px;height:${b.height + 2 * pad}px`}></div>`
        : html`<div class="dim"></div>`}
      <div class="bubble" role="dialog" aria-label=${t(s.title)} style=${`left:${x}px;top:${y}px;width:${W}px`}>
        <div class="count">${t('tour.step', { i: this._step + 1, n: steps.length })}</div>
        <div class="title">${t(s.title)}</div>
        <div class="text">${t(s.text)}</div>
        ${s.pick === 'labels'
          ? html`<fp-label-style
              .value=${this.labelStyle === 'wall' || this.labelStyle === 'inside' ? this.labelStyle : 'outside'}
              @value-change=${(e: CustomEvent) => {
                e.stopPropagation();
                this.labelStyle = e.detail.value;
                this.dispatchEvent(new CustomEvent('label-style', { detail: { value: e.detail.value }, bubbles: true, composed: true }));
              }}
            ></fp-label-style>`
          : nothing}
        <div class="actions">
          ${last ? nothing : html`<button class="btn plain pressable skip" @click=${() => this.end(true)}>${t('tour.skip')}</button>`}
          <button class="btn accent pressable next" @click=${() => this.go(this._step + 1)}>${last ? t('tour.done') : t('tour.next')}</button>
        </div>
      </div>`;
  }

  static override styles = [
    components,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 20;
      }
      .scrim {
        position: absolute;
        inset: 0;
      }
      .dim {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.38);
        pointer-events: none;
      }
      .ring {
        position: absolute;
        border-radius: var(--fp-radius-m);
        box-shadow:
          0 0 0 3px var(--fp-accent),
          0 0 0 9999px rgba(0, 0, 0, 0.38);
        pointer-events: none;
        transition:
          left var(--fp-dur) ease,
          top var(--fp-dur) ease,
          width var(--fp-dur) ease,
          height var(--fp-dur) ease;
      }
      .bubble {
        position: absolute;
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-2);
        padding: var(--fp-space-4);
        border-radius: var(--fp-radius-l);
        background: var(--fp-surface);
        color: var(--fp-label);
        box-shadow: var(--fp-shadow-3);
      }
      .count {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        font-weight: var(--fp-weight-semibold);
      }
      .title {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
      }
      .text {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
        line-height: 1.4;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--fp-space-2);
        margin-top: var(--fp-space-1);
      }
      @media (prefers-reduced-motion: reduce) {
        .ring {
          transition: none;
        }
      }
    `,
  ];
}
customElements.define('fp-editor-tour', FpEditorTour);
