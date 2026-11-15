import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { components } from '../design/components';
import { t } from '../i18n';

/** One floor in the slider (top floor first) */
export interface SliderFloor {
  id: string;
  name: string;
  /** label of the compact variant ("EG", "OG") */
  short: string;
  /** something going on there: open windows (alert), a dog that wants out (pet), lights on (light) */
  dot?: 'alert' | 'pet' | 'light';
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Past the ends the wheel follows the finger with growing resistance */
const rubber = (x: number) => (0.5 * x) / (1 + x);

/**
 * Floor picker on the right edge of the card, like an iOS picker wheel: drag, flick, mouse wheel, trackpad or tap —
 * it always comes to rest with exactly one floor in the middle band. The rows move by transform only and
 * are painted straight to the DOM while the finger moves (no Lit render per frame); nothing runs once it rests.
 *
 * Events (bubbling, composed):
 *  - `floor-preview` { offset }: during a gesture / the snap — how far (in floors, ± = down / up) the wheel is
 *    from the shown floor, for the plan to follow a little
 *  - `floor-select` { id }: the floor it is going to rest on (sent once, when the target is known)
 *  - `floor-size` { width }: its width changed (the plan keeps the building clear of it)
 */
export class FpFloorSlider extends LitElement {
  static override properties = {
    floors: { attribute: false },
    value: { type: String },
    compact: { type: Boolean, reflect: true },
    rows: { type: Number },
  };

  declare floors: SliderFloor[];
  declare value?: string;
  declare compact: boolean;
  /** visible rows (3 or 5) */
  declare rows: number;

  /** wheel position in rows (0 = top floor); fractional while moving */
  private pos = 0;
  private vel = 0;
  private target?: number;
  private raf = 0;
  private lastT = 0;
  private drag?: { id: number; y0: number; p0: number; t0: number; moved: boolean; samples: { t: number; p: number }[]; detent: number };
  private wheelTimer?: number;
  private wheelStep = 0;
  private ro?: ResizeObserver;
  private width = 0;

  constructor() {
    super();
    this.floors = [];
    this.compact = false;
    this.rows = 3;
  }

  private get row() {
    return this.compact ? 40 : 44;
  }

  private get index() {
    return Math.max(0, this.floors.findIndex((f) => f.id === this.value));
  }

  override connectedCallback() {
    super.connectedCallback();
    this.ro = new ResizeObserver(() => {
      const w = Math.round(this.getBoundingClientRect().width);
      if (w && w !== this.width) {
        this.width = w;
        this.dispatchEvent(new CustomEvent('floor-size', { detail: { width: w }, bubbles: true, composed: true }));
      }
    });
    this.ro.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.wheelTimer);
  }

  override firstUpdated() {
    this.pos = this.index;
    this.paint();
    // wheel needs a non-passive listener (the page must not scroll or zoom underneath)
    this.renderRoot.querySelector('.pill')?.addEventListener('wheel', this.onWheel as EventListener, { passive: false });
  }

  override updated(changed: PropertyValues) {
    if (changed.has('floors') || changed.has('compact') || changed.has('rows')) {
      if (!this.raf && !this.drag) this.pos = this.index;
      this.paint();
    }
    // moved from outside (stairs, idle return, alert): roll there
    if (changed.has('value') && changed.get('value') !== undefined && !this.drag && this.target !== this.index) this.settle(this.index, 0, false);
  }

  // ---------- motion ----------

  /** Spring to a row (critically damped with a hint of overshoot: it clicks into place) */
  private settle(to: number, v0 = 0, select = true) {
    to = clamp(Math.round(to), 0, Math.max(0, this.floors.length - 1));
    this.target = to;
    this.vel = v0;
    if (select && this.floors[to] && this.floors[to].id !== this.value)
      this.dispatchEvent(new CustomEvent('floor-select', { detail: { id: this.floors[to].id }, bubbles: true, composed: true }));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.pos = to;
      this.vel = 0;
      this.paint();
      return this.stop();
    }
    if (!this.raf) {
      this.lastT = performance.now();
      this.raf = requestAnimationFrame(this.step);
    }
  }

  private step = (now: number) => {
    const dt = Math.min(0.032, (now - this.lastT) / 1000);
    this.lastT = now;
    const to = this.target ?? this.index;
    // ω 24/s, ζ 0.8 — about 280 ms to rest
    const w = 24;
    const z = 0.8;
    const a = -w * w * (this.pos - to) - 2 * z * w * this.vel;
    this.vel += a * dt;
    this.pos += this.vel * dt;
    if (Math.abs(this.pos - to) < 0.002 && Math.abs(this.vel) < 0.02) {
      this.pos = to;
      this.vel = 0;
      this.paint();
      return this.stop();
    }
    this.paint();
    this.raf = requestAnimationFrame(this.step);
  };

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = undefined;
    this.renderRoot.querySelector('.pill')?.classList.remove('moving');
  }

  /** Rows straight to the DOM: transform + opacity only */
  private paint() {
    const root = this.renderRoot;
    if (!root) return;
    const row = this.row;
    const half = this.rows / 2;
    const dim = root.querySelectorAll<HTMLElement>('.list.dim .item');
    const sel = root.querySelectorAll<HTMLElement>('.list.sel .item');
    for (let i = 0; i < dim.length; i++) {
      const d = i - this.pos;
      const ad = Math.abs(d);
      const y = d * row;
      dim[i].style.transform = `translateY(${y.toFixed(2)}px) scale(${(1 - Math.min(ad, 2) * 0.07).toFixed(3)})`;
      dim[i].style.opacity = ad > half + 0.5 ? '0' : (1 - clamp((ad - 0.6) / half, 0, 0.75)).toFixed(3);
      if (sel[i]) sel[i].style.transform = `translateY(${y.toFixed(2)}px)`;
    }
    const pill = root.querySelector('.pill');
    pill?.setAttribute('aria-valuenow', String(Math.round(clamp(this.pos, 0, this.floors.length - 1))));
    this.dispatchEvent(new CustomEvent('floor-preview', { detail: { offset: this.pos - this.index }, bubbles: true, composed: true }));
  }

  // ---------- gestures ----------

  private onDown = (e: PointerEvent) => {
    if (e.button > 0 || this.floors.length < 2) return;
    const pill = e.currentTarget as HTMLElement;
    pill.setPointerCapture?.(e.pointerId);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = undefined;
    this.drag = { id: e.pointerId, y0: e.clientY, p0: this.pos, t0: performance.now(), moved: false, samples: [{ t: performance.now(), p: this.pos }], detent: Math.round(this.pos) };
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < (e.pointerType === 'mouse' ? 3 : 6)) return;
    if (!d.moved) this.renderRoot.querySelector('.pill')?.classList.add('moving');
    d.moved = true;
    const n = this.floors.length - 1;
    const raw = d.p0 - dy / this.row;
    this.pos = raw < 0 ? -rubber(-raw) : raw > n ? n + rubber(raw - n) : raw;
    const now = performance.now();
    d.samples.push({ t: now, p: this.pos });
    while (d.samples.length > 2 && now - d.samples[0].t > 100) d.samples.shift();
    // a tiny tick at every detent, like a picker wheel (where the device can)
    const det = Math.round(clamp(this.pos, 0, n));
    if (det !== d.detent) {
      d.detent = det;
      if (e.pointerType === 'touch') navigator.vibrate?.(4);
    }
    this.paint();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = undefined;
    if (!d.moved) {
      // tap: the row under the finger
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const i = Math.round(this.pos + (e.clientY - (r.top + r.height / 2)) / this.row);
      if (i >= 0 && i < this.floors.length) this.settle(i);
      else this.settle(this.pos);
      return;
    }
    // flick: velocity of the last 100 ms carries it on (rows / s)
    const s = d.samples;
    const a = s[0];
    const b = s[s.length - 1];
    const v = b.t > a.t ? ((b.p - a.p) / (b.t - a.t)) * 1000 : 0;
    const projected = this.pos + v * 0.22;
    this.settle(projected, clamp(v, -30, 30));
  };

  private onCancel = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = undefined;
    this.settle(this.pos, 0, false);
  };

  /** Mouse wheel: one floor per notch. Trackpad (also Safari): follows, then snaps when the fingers rest */
  private onWheel = (e: WheelEvent) => {
    if (this.floors.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!px) return;
    const notch = e.deltaMode !== 0 || (Math.abs(px) >= 50 && Number.isInteger(px));
    if (notch) {
      const now = performance.now();
      if (now - this.wheelStep < 70) return;
      this.wheelStep = now;
      const from = this.target ?? Math.round(this.pos);
      this.settle(from + Math.sign(px));
      return;
    }
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = undefined;
    const n = this.floors.length - 1;
    this.pos = clamp(this.pos + px / (this.row * 1.6), -0.35, n + 0.35);
    this.renderRoot.querySelector('.pill')?.classList.add('moving');
    this.paint();
    clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => this.settle(this.pos), 120);
  };

  private onKey = (e: KeyboardEvent) => {
    const i = this.target ?? this.index;
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? this.floors.length - 1 : undefined;
    if (to === undefined) return;
    e.preventDefault();
    this.settle(to);
  };

  // ---------- render ----------

  private item(f: SliderFloor) {
    return html`<div class="item"><span class="txt">${this.compact ? f.short : f.name}</span>${f.dot ? html`<span class="dot ${f.dot}"></span>` : nothing}</div>`;
  }

  override render() {
    const floors = this.floors;
    const cur = floors[this.index];
    return html`<div
      class="pill"
      role="slider"
      tabindex="0"
      aria-orientation="vertical"
      aria-label=${t('card.floors')}
      aria-valuemin="0"
      aria-valuemax=${Math.max(0, floors.length - 1)}
      aria-valuetext=${cur?.name ?? ''}
      style=${`--row:${this.row}px;--rows:${this.rows}`}
      @pointerdown=${this.onDown}
      @pointermove=${this.onMove}
      @pointerup=${this.onUp}
      @pointercancel=${this.onCancel}
      @lostpointercapture=${this.onCancel}
      @keydown=${this.onKey}
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      <div class="sizer" aria-hidden="true">${floors.map((f) => html`<span>${this.compact ? f.short : f.name}<i></i></span>`)}</div>
      <div class="band"></div>
      <div class="list dim" aria-hidden="true">${repeat(floors, (f) => f.id, (f) => this.item(f))}</div>
      <div class="list sel" aria-hidden="true">${repeat(floors, (f) => f.id, (f) => this.item(f))}</div>
    </div>`;
  }

  static override styles = [
    components,
    css`
      :host {
        display: block;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }
      .pill {
        position: relative;
        height: calc(var(--row) * var(--rows) + 8px);
        min-width: 64px;
        max-width: 156px;
        border-radius: calc(var(--row) / 2 + 4px);
        overflow: hidden;
        touch-action: none;
        cursor: grab;
        outline: none;
        background: color-mix(in srgb, var(--fp-surface) 74%, transparent);
        -webkit-backdrop-filter: blur(18px) saturate(1.5);
        backdrop-filter: blur(18px) saturate(1.5);
        box-shadow: var(--fp-shadow-2), inset 0 0 0 0.5px color-mix(in srgb, var(--fp-label) 8%, transparent);
        isolation: isolate;
      }
      .pill.moving {
        cursor: grabbing;
      }
      .pill:focus-visible {
        box-shadow: var(--fp-shadow-2), 0 0 0 2px var(--fp-accent);
      }
      :host([compact]) .pill {
        min-width: 48px;
        width: 48px;
      }
      /* invisible: gives the pill the width of its longest name */
      .sizer {
        height: 0;
        overflow: hidden;
        visibility: hidden;
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
      }
      .sizer span {
        display: block;
        white-space: nowrap;
        padding: 0 18px;
      }
      .sizer i {
        display: inline-block;
        width: 12px;
      }
      :host([compact]) .sizer {
        display: none;
      }
      /* the resting place: the floor in the middle is always the one shown */
      .band {
        position: absolute;
        left: 4px;
        right: 4px;
        top: calc(50% - var(--row) / 2 + 2px);
        height: calc(var(--row) - 4px);
        border-radius: calc(var(--row) / 2);
        background: var(--fp-surface-raised);
        box-shadow: var(--fp-shadow-1);
        z-index: -1;
      }
      .list {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      /* the passing rows: quieter, fading towards the ends, never under the band */
      .list.dim {
        color: var(--fp-label-2);
        font-weight: var(--fp-weight-medium);
        -webkit-mask-image: linear-gradient(
          to bottom,
          transparent 0,
          #000 22%,
          #000 calc(50% - var(--row) / 2 + 2px),
          transparent calc(50% - var(--row) / 2 + 2px),
          transparent calc(50% + var(--row) / 2 - 2px),
          #000 calc(50% + var(--row) / 2 - 2px),
          #000 78%,
          transparent 100%
        );
        mask-image: linear-gradient(
          to bottom,
          transparent 0,
          #000 22%,
          #000 calc(50% - var(--row) / 2 + 2px),
          transparent calc(50% - var(--row) / 2 + 2px),
          transparent calc(50% + var(--row) / 2 - 2px),
          #000 calc(50% + var(--row) / 2 - 2px),
          #000 78%,
          transparent 100%
        );
      }
      /* the same rows, crisp and bold, seen only through the band */
      .list.sel {
        color: var(--fp-label);
        font-weight: var(--fp-weight-semibold);
        clip-path: inset(calc(50% - var(--row) / 2 + 2px) 4px calc(50% - var(--row) / 2 + 2px) 4px round calc(var(--row) / 2));
      }
      .item {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(50% - var(--row) / 2);
        height: var(--row);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 14px;
        font-size: var(--fp-text-subhead);
        letter-spacing: -0.01em;
        white-space: nowrap;
        will-change: transform;
      }
      .txt {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      :host([compact]) .item {
        padding: 0 4px;
        font-size: var(--fp-text-footnote);
        letter-spacing: 0;
      }
      :host([compact]) .list.sel {
        font-weight: var(--fp-weight-bold);
      }
      .dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--fp-state-light);
      }
      .dot.alert {
        background: var(--fp-red);
      }
      .dot.pet {
        background: var(--fp-orange);
      }
      :host([compact]) .dot {
        position: absolute;
        top: 8px;
        right: 6px;
        width: 5px;
        height: 5px;
      }
    `,
  ];
}

if (!customElements.get('fp-floor-slider')) customElements.define('fp-floor-slider', FpFloorSlider);
