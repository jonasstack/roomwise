import { LitElement, css, html, nothing, svg } from 'lit';
import { components } from '../design/components';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function emit(el: HTMLElement, type: 'value-input' | 'value-change', value: unknown) {
  el.dispatchEvent(new CustomEvent(type, { detail: { value }, bubbles: true, composed: true }));
}

/**
 * Large pill slider (Apple Home style). Vertical by default, `horizontal` for rows.
 * Drag moves relatively, a tap jumps. Fill moves via transform only.
 * Emits `value-input` while dragging and `value-change` on release.
 */
export class FpSlider extends LitElement {
  static override properties = {
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    horizontal: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    /** CSS color/gradient for the fill */
    fill: { type: String },
    /** CSS background for the track (e.g. temperature gradient). When set, a handle line is shown instead of a fill. */
    track: { type: String },
    label: { type: String },
    icon: { type: String },
    _drag: { state: true },
  };

  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare horizontal: boolean;
  declare disabled: boolean;
  declare fill?: string;
  declare track?: string;
  declare label?: string;
  declare icon?: string;
  declare _drag?: number;

  private start?: { x: number; y: number; v: number; moved: boolean; size: number; rect: DOMRect };

  constructor() {
    super();
    this.value = 0;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.horizontal = false;
    this.disabled = false;
  }

  private get shown() {
    return this._drag ?? this.value;
  }

  private quantize(v: number) {
    return clamp(Math.round(v / this.step) * this.step, this.min, this.max);
  }

  private down = (e: PointerEvent) => {
    if (this.disabled) return;
    const rect = this.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.start = { x: e.clientX, y: e.clientY, v: this.value, moved: false, size: this.horizontal ? rect.width : rect.height, rect };
  };

  private move = (e: PointerEvent) => {
    const s = this.start;
    if (!s) return;
    const delta = this.horizontal ? e.clientX - s.x : s.y - e.clientY;
    if (!s.moved && Math.abs(delta) < 4) return;
    s.moved = true;
    this._drag = this.quantize(s.v + (delta / s.size) * (this.max - this.min));
    emit(this, 'value-input', this._drag);
  };

  private up = (e: PointerEvent) => {
    const s = this.start;
    if (!s) return;
    this.start = undefined;
    let v: number;
    if (!s.moved) {
      const r = s.rect;
      const frac = this.horizontal ? (e.clientX - r.left) / r.width : (r.bottom - e.clientY) / r.height;
      v = this.quantize(this.min + clamp(frac, 0, 1) * (this.max - this.min));
    } else v = this._drag ?? this.value;
    this._drag = undefined;
    this.value = v;
    emit(this, 'value-change', v);
  };

  private key = (e: KeyboardEvent) => {
    const k = e.key;
    const inc = k === 'ArrowUp' || k === 'ArrowRight' ? 1 : k === 'ArrowDown' || k === 'ArrowLeft' ? -1 : 0;
    if (!inc) return;
    e.preventDefault();
    this.value = this.quantize(this.value + inc * this.step * (e.shiftKey ? 10 : 1));
    emit(this, 'value-change', this.value);
  };

  override render() {
    const frac = (this.shown - this.min) / (this.max - this.min || 1);
    const pos = this.horizontal ? `translateX(${(frac - 1) * 100}%)` : `translateY(${(1 - frac) * 100}%)`;
    const handle = this.horizontal ? `translateX(${frac * 100}%)` : `translateY(${(1 - frac) * 100}%)`;
    return html`<div
      class="track ${this._drag != null ? 'dragging' : ''}"
      role="slider"
      tabindex="0"
      aria-label=${this.label ?? ''}
      aria-valuemin=${this.min}
      aria-valuemax=${this.max}
      aria-valuenow=${this.shown}
      style=${this.track ? `background:${this.track}` : ''}
      @pointerdown=${this.down}
      @pointermove=${this.move}
      @pointerup=${this.up}
      @pointercancel=${this.up}
      @keydown=${this.key}
    >
      ${this.track
        ? html`<div class="handle-rail" style=${`transform:${handle}`}><div class="handle"></div></div>`
        : html`<div class="fill" style=${`transform:${pos};background:${this.fill ?? 'var(--fp-label)'}`}></div>`}
      ${this.icon ? html`<ha-icon class="icon" .icon=${this.icon}></ha-icon>` : nothing}
      <slot></slot>
    </div>`;
  }

  static override styles = [
    components,
    css`
      :host {
        display: block;
        width: 120px;
        height: 320px;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        --radius: var(--fp-radius-xl);
      }
      :host([horizontal]) {
        width: 100%;
        height: 52px;
        --radius: var(--fp-radius-m);
      }
      :host([disabled]) {
        opacity: 0.4;
      }
      .track {
        position: relative;
        width: 100%;
        height: 100%;
        border-radius: var(--radius);
        background: var(--fp-fill-strong);
        overflow: hidden;
        cursor: grab;
        transition: transform var(--fp-dur) var(--fp-ease);
        isolation: isolate;
      }
      .track.dragging {
        transform: scale(1.02);
        cursor: grabbing;
      }
      .fill {
        position: absolute;
        inset: 0;
        transition: transform var(--fp-dur) var(--fp-ease);
        will-change: transform;
      }
      .track.dragging .fill,
      .track.dragging .handle-rail {
        transition: none;
      }
      .handle-rail {
        position: absolute;
        inset: 14px 0;
        transition: transform var(--fp-dur) var(--fp-ease);
        pointer-events: none;
      }
      .handle {
        position: absolute;
        left: 50%;
        top: 0;
        width: 44%;
        height: 6px;
        margin: -3px 0 0 -22%;
        border-radius: var(--fp-radius-full);
        background: #fff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
      }
      :host([horizontal]) .handle-rail {
        inset: 0 14px;
      }
      :host([horizontal]) .handle {
        left: 0;
        top: 50%;
        width: 6px;
        height: 56%;
        margin: -14% 0 0 -3px;
        transform: translateY(-14%);
      }
      .icon {
        position: absolute;
        left: 50%;
        bottom: var(--fp-space-5);
        transform: translateX(-50%);
        color: var(--fp-label-2);
        mix-blend-mode: normal;
        pointer-events: none;
      }
      :host([horizontal]) .icon {
        left: var(--fp-space-4);
        top: 50%;
        bottom: auto;
        transform: translateY(-50%);
        --mdc-icon-size: 20px;
      }
    `,
  ];
}

/** Hue/saturation wheel. value = [hue 0..360, saturation 0..100]. */
export class FpColorWheel extends LitElement {
  static override properties = { value: { attribute: false }, _drag: { state: true } };
  declare value: [number, number];
  declare _drag?: [number, number];

  constructor() {
    super();
    this.value = [30, 60];
  }

  private pick(e: PointerEvent): [number, number] {
    const r = this.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    const hue = (Math.atan2(y, x) * 180) / Math.PI;
    const sat = clamp(Math.hypot(x, y) / (r.width / 2), 0, 1) * 100;
    return [Math.round((hue + 450) % 360), Math.round(sat)];
  }

  private down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this._drag = this.pick(e);
    emit(this, 'value-input', this._drag);
  };
  private move = (e: PointerEvent) => {
    if (!this._drag) return;
    this._drag = this.pick(e);
    emit(this, 'value-input', this._drag);
  };
  private up = () => {
    if (!this._drag) return;
    this.value = this._drag;
    this._drag = undefined;
    emit(this, 'value-change', this.value);
  };

  override render() {
    const [h, s] = this._drag ?? this.value;
    const a = ((h - 90) * Math.PI) / 180;
    const x = 50 + Math.cos(a) * (s / 2);
    const y = 50 + Math.sin(a) * (s / 2);
    return html`<div class="wheel" @pointerdown=${this.down} @pointermove=${this.move} @pointerup=${this.up} @pointercancel=${this.up}>
      <div class="knob ${this._drag ? 'dragging' : ''}" style=${`left:${x}%;top:${y}%;background:hsl(${h}, ${s}%, ${100 - s / 2}%)`}></div>
    </div>`;
  }

  static override styles = css`
    :host {
      display: block;
      width: 240px;
      aspect-ratio: 1;
      touch-action: none;
    }
    .wheel {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle closest-side, #fff, rgba(255, 255, 255, 0) 100%),
        conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
      cursor: crosshair;
    }
    .knob {
      position: absolute;
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
      border-radius: 50%;
      border: 4px solid #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      transition: transform var(--fp-dur-fast) var(--fp-ease);
      pointer-events: none;
    }
    .knob.dragging {
      transform: scale(1.25);
    }
  `;
}

/** Thermostat dial: 270° arc, draggable knob, value in °C. */
export class FpDial extends LitElement {
  static override properties = {
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    current: { type: Number },
    active: { type: Boolean },
    disabled: { type: Boolean, reflect: true },
    color: { type: String },
    _drag: { state: true },
  };
  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare current?: number;
  declare active: boolean;
  declare disabled: boolean;
  declare color?: string;
  declare _drag?: number;

  constructor() {
    super();
    this.value = 20;
    this.min = 5;
    this.max = 30;
    this.step = 0.5;
    this.active = false;
    this.disabled = false;
  }

  private static START = 135;
  private static SWEEP = 270;

  private angleOf(v: number) {
    return FpDial.START + ((v - this.min) / (this.max - this.min || 1)) * FpDial.SWEEP;
  }

  private pt(angle: number, r: number) {
    const a = (angle * Math.PI) / 180;
    return [100 + Math.cos(a) * r, 100 + Math.sin(a) * r];
  }

  private arc(a0: number, a1: number, r: number) {
    const [x0, y0] = this.pt(a0, r);
    const [x1, y1] = this.pt(a1, r);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  }

  private valueAt(e: PointerEvent) {
    const r = this.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let a = (Math.atan2(y, x) * 180) / Math.PI;
    a = (a + 360) % 360;
    let rel = a - FpDial.START;
    if (rel < 0) rel += 360;
    if (rel > FpDial.SWEEP) rel = rel - FpDial.SWEEP < (360 - FpDial.SWEEP) / 2 ? FpDial.SWEEP : 0;
    const v = this.min + (rel / FpDial.SWEEP) * (this.max - this.min);
    return clamp(Math.round(v / this.step) * this.step, this.min, this.max);
  }

  private down = (e: PointerEvent) => {
    if (this.disabled) return;
    const path = e.composedPath() as Element[];
    if (!path.some((el) => (el as HTMLElement).classList?.contains('hit'))) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this._drag = this.valueAt(e);
    emit(this, 'value-input', this._drag);
  };
  private move = (e: PointerEvent) => {
    if (this._drag == null) return;
    this._drag = this.valueAt(e);
    emit(this, 'value-input', this._drag);
  };
  private up = () => {
    if (this._drag == null) return;
    this.value = this._drag;
    this._drag = undefined;
    emit(this, 'value-change', this.value);
  };

  override render() {
    const v = this._drag ?? this.value;
    const a = this.angleOf(v);
    const [kx, ky] = this.pt(a, 84);
    const end = FpDial.START + FpDial.SWEEP;
    const cur = this.current != null && this.current >= this.min && this.current <= this.max ? this.angleOf(this.current) : undefined;
    const [cx, cy] = cur != null ? this.pt(cur, 84) : [0, 0];
    return html`<div class="dial" @pointerdown=${this.down} @pointermove=${this.move} @pointerup=${this.up} @pointercancel=${this.up}>
      <svg viewBox="0 0 200 200">
        <path class="bg" d=${this.arc(FpDial.START, end, 84)}></path>
        <path class="val ${this.active ? 'active' : ''}" style=${this.color && this.active ? `stroke:${this.color}` : ''} d=${this.arc(FpDial.START, Math.max(FpDial.START + 0.01, a), 84)}></path>
        <path class="hit" d=${this.arc(FpDial.START, end, 84)}></path>
        ${cur != null ? svg`<circle class="cur" cx=${cx} cy=${cy} r="3"></circle>` : nothing}
        <circle class="knob ${this._drag != null ? 'dragging' : ''}" cx=${kx} cy=${ky} r="11"></circle>
      </svg>
      <div class="center"><slot></slot></div>
    </div>`;
  }

  static override styles = css`
    :host {
      display: block;
      width: 300px;
      aspect-ratio: 1;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    :host([disabled]) .val,
    :host([disabled]) .knob {
      opacity: 0.35;
    }
    .dial {
      position: relative;
      width: 100%;
      height: 100%;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    path {
      fill: none;
      stroke-linecap: round;
    }
    .bg {
      stroke: var(--fp-fill-strong);
      stroke-width: 16;
    }
    .val {
      stroke: var(--fp-label-3);
      stroke-width: 16;
    }
    .val.active {
      stroke: var(--fp-state-heat);
    }
    .hit {
      stroke: transparent;
      stroke-width: 48;
      cursor: pointer;
      pointer-events: stroke;
    }
    .knob {
      fill: #fff;
      filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.35));
      pointer-events: none;
      transition: transform var(--fp-dur-fast) var(--fp-ease);
      transform-box: fill-box;
      transform-origin: center;
    }
    .knob.dragging {
      transform: scale(1.2);
    }
    .cur {
      fill: var(--fp-label);
      pointer-events: none;
    }
    .center {
      position: absolute;
      inset: 22%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      pointer-events: none;
    }
    .center ::slotted(*) {
      pointer-events: auto;
    }
  `;
}

/** Segmented control with a sliding thumb. options: [{value,label}] */
export class FpSegmented extends LitElement {
  static override properties = { options: { attribute: false }, value: { type: String } };
  declare options: { value: string; label: string; icon?: string }[];
  declare value: string;

  constructor() {
    super();
    this.options = [];
    this.value = '';
  }

  override render() {
    const n = this.options.length || 1;
    const idx = Math.max(0, this.options.findIndex((o) => o.value === this.value));
    const pick = (o: { value: string }) => {
      if (o.value === this.value) return;
      this.value = o.value;
      emit(this, 'value-change', o.value);
    };
    // one choice of several: a radio group (arrow keys move the choice, Tab leaves the group)
    const onKey = (e: KeyboardEvent) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d || !this.options.length) return;
      e.preventDefault();
      e.stopPropagation();
      const o = this.options[(idx + d + this.options.length) % this.options.length];
      pick(o);
      void this.updateComplete.then(() => (this.renderRoot.querySelector('button[aria-checked="true"]') as HTMLElement | null)?.focus());
    };
    return html`<div class="segmented" role="radiogroup" @keydown=${onKey}>
      <div class="thumb" style=${`width:calc((100% - 6px) / ${n});transform:translateX(${idx * 100}%)`}></div>
      ${this.options.map(
        (o, i) => html`<button
          role="radio"
          title=${o.label}
          aria-checked=${i === idx ? 'true' : 'false'}
          tabindex=${i === idx ? 0 : -1}
          @click=${() => pick(o)}
        >
          ${o.icon ? html`<ha-icon .icon=${o.icon} style="--mdc-icon-size:18px"></ha-icon>` : nothing}<span class="lbl">${o.label}</span>
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
      .segmented button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-1);
        min-width: 0;
      }
      /* long labels in a narrow bar (floor names on a phone): cut off cleanly */
      .segmented button .lbl {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];
}

for (const [name, cls] of [
  ['fp-slider', FpSlider],
  ['fp-color-wheel', FpColorWheel],
  ['fp-dial', FpDial],
  ['fp-segmented', FpSegmented],
] as const)
  if (!customElements.get(name)) customElements.define(name, cls as unknown as CustomElementConstructor);
