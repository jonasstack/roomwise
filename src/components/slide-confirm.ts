import { LitElement, css, html } from 'lit';

/**
 * Slide to confirm: the knob has to be dragged all the way to the end (pointer), or Space / Enter held for a moment
 * (keyboard). A tap, a click or a double tap never confirms. Emits `confirmed` once.
 */
export class FpSlideConfirm extends LitElement {
  static override properties = { label: { type: String }, _x: { state: true }, _hold: { state: true } };
  declare label: string;
  declare _x: number;
  /** keyboard hold progress 0–1 */
  declare _hold: number;
  private drag?: { id: number; x0: number; start: number };
  private done = false;
  private holdTimer?: number;
  /** how long Space / Enter has to be held */
  static HOLD_MS = 1200;

  constructor() {
    super();
    this.label = '';
    this._x = 0;
    this._hold = 0;
  }

  private get max(): number {
    const track = this.renderRoot.querySelector('.track') as HTMLElement | null;
    const knob = this.renderRoot.querySelector('.knob') as HTMLElement | null;
    return track && knob ? Math.max(1, track.clientWidth - knob.offsetWidth - 8) : 1;
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this._x = this.max;
    this.dispatchEvent(new CustomEvent('confirmed', { bubbles: true, composed: true }));
  }

  private down = (e: PointerEvent) => {
    if (this.done || e.button > 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x0: e.clientX, start: this._x };
    e.preventDefault();
  };

  private move = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this._x = Math.max(0, Math.min(this.max, this.drag.start + e.clientX - this.drag.x0));
  };

  private up = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = undefined;
    if (this._x >= this.max * 0.94) this.finish();
    else this._x = 0;
  };

  private keyDown = (e: KeyboardEvent) => {
    if ((e.key !== ' ' && e.key !== 'Enter') || this.done) return;
    e.preventDefault();
    if (this.holdTimer || e.repeat) return;
    const t0 = performance.now();
    const step = () => {
      this._hold = Math.min(1, (performance.now() - t0) / FpSlideConfirm.HOLD_MS);
      this._x = this._hold * this.max;
      if (this._hold >= 1) {
        this.holdTimer = undefined;
        this.finish();
      } else this.holdTimer = requestAnimationFrame(step);
    };
    this.holdTimer = requestAnimationFrame(step);
  };

  private keyUp = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    if (this.holdTimer) cancelAnimationFrame(this.holdTimer);
    this.holdTimer = undefined;
    if (!this.done) {
      this._hold = 0;
      this._x = 0;
    }
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.holdTimer) cancelAnimationFrame(this.holdTimer);
  }

  override render() {
    const k = this._x / this.max;
    return html`<div class="track ${this.drag ? 'dragging' : ''}" style=${`--k:${k.toFixed(3)}`}>
      <div class="fill" style=${`width:${this._x + 52}px`}></div>
      <span class="lbl">${this.label}</span>
      <button
        class="knob"
        role="slider"
        aria-label=${this.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${Math.round(k * 100)}
        style=${`transform:translateX(${this._x}px)`}
        @pointerdown=${this.down}
        @pointermove=${this.move}
        @pointerup=${this.up}
        @pointercancel=${this.up}
        @keydown=${this.keyDown}
        @keyup=${this.keyUp}
        @click=${(e: Event) => e.preventDefault()}
      >
        <ha-icon icon="mdi:chevron-double-right"></ha-icon>
      </button>
    </div>`;
  }

  static override styles = css`
    :host {
      display: block;
      user-select: none;
      -webkit-user-select: none;
    }
    .track {
      position: relative;
      height: 60px;
      border-radius: 30px;
      background: var(--fp-fill-2, rgba(120, 120, 128, 0.16));
      overflow: hidden;
      touch-action: none;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 30px;
      background: rgba(255, 59, 48, 0.22);
    }
    .track:not(.dragging) .fill,
    .track:not(.dragging) .knob {
      transition: transform var(--fp-dur, 0.25s) var(--fp-ease, ease), width var(--fp-dur, 0.25s) var(--fp-ease, ease);
    }
    .lbl {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-left: 56px;
      font-size: var(--fp-text-subhead, 15px);
      font-weight: var(--fp-weight-semibold, 600);
      color: var(--fp-label-2, #666);
      opacity: calc(1 - var(--k) * 1.6);
      pointer-events: none;
    }
    .knob {
      position: absolute;
      top: 4px;
      left: 4px;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: 0;
      padding: 0;
      background: var(--fp-red, #ff3b30);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      touch-action: none;
      box-shadow: var(--fp-shadow-1, 0 1px 3px rgba(0, 0, 0, 0.2));
      --mdc-icon-size: 26px;
    }
    .knob:focus-visible {
      outline: 3px solid var(--fp-accent, #007aff);
      outline-offset: 2px;
    }
    .dragging .knob {
      cursor: grabbing;
    }
  `;
}

if (!customElements.get('fp-slide-confirm')) customElements.define('fp-slide-confirm', FpSlideConfirm);
