import { LitElement, css, html, nothing, svg } from 'lit';
import type { FloorConfig, Point } from '../types';
import { t } from '../i18n';

/**
 * "Etagen-Blick": another floor, faintly, under the shown one – only its rooms as outlines, a soft pulsing mark where
 * something is going on and a label above it ("Waschmaschine fertig · Keller"). Tilted and turned like the 3D view so
 * it reads as the floor beneath; flat in 2D. A tap goes there (the card handles `peek-open`). Loaded only when needed.
 */
export class FpFloorPeek extends LitElement {
  static override properties = {
    floor: { attribute: false },
    at: { attribute: false },
    text: { type: String },
    severe: { type: Boolean, reflect: true },
    tilt: { type: Number },
    spin: { type: Number },
    flat: { type: Boolean },
  };
  declare floor?: FloorConfig;
  declare at?: Point;
  declare text: string;
  declare severe: boolean;
  /** the 3D view's tilt and spin (degrees); 0 in 2D */
  declare tilt: number;
  declare spin: number;
  /** no tilt or pulse (effects off) */
  declare flat: boolean;

  constructor() {
    super();
    this.text = '';
    this.severe = false;
    this.tilt = 0;
    this.spin = 0;
    this.flat = false;
  }

  private open = () => this.dispatchEvent(new CustomEvent('peek-open', { bubbles: true, composed: true }));

  override render() {
    const f = this.floor;
    if (!f || !this.at) return nothing;
    const rooms = f.rooms.filter((r) => r.points.length >= 3 && !r.outdoor);
    const pts = rooms.flatMap((r) => r.points);
    if (!pts.length) return nothing;
    let minX = Math.min(...pts.map((p) => p[0]));
    let maxX = Math.max(...pts.map((p) => p[0]));
    let minY = Math.min(...pts.map((p) => p[1]));
    let maxY = Math.max(...pts.map((p) => p[1]));
    const pad = Math.max(maxX - minX, maxY - minY) * 0.06;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const w = maxX - minX;
    const h = maxY - minY;
    const r = Math.max(w, h) * 0.035;
    const tilt = this.flat ? 0 : Math.min(58, Math.max(0, this.tilt));
    const plate = tilt ? `transform: perspective(520px) rotateX(${tilt.toFixed(1)}deg) rotateZ(${this.spin.toFixed(1)}deg)` : `transform: rotateZ(${this.spin.toFixed(1)}deg)`;
    return html`<button class="peek ${this.flat ? 'flat' : ''}" aria-label=${t('peek.go', { text: this.text, floor: f.name })} title=${t('peek.go', { text: this.text, floor: f.name })} @click=${this.open}>
      <span class="label"><span class="dot"></span><span class="text">${this.text}</span><span class="floor">${f.name}</span></span>
      <span class="stage">
        <svg class="plate" viewBox=${`${minX} ${minY} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" style=${plate} aria-hidden="true">
          ${rooms.map((rm) => svg`<path class="room" d=${'M' + rm.points.map((p) => p.join(' ')).join('L') + 'Z'}></path>`)}
          <circle class="ring" cx=${this.at[0]} cy=${this.at[1]} r=${r * 2.2}></circle>
          <circle class="mark" cx=${this.at[0]} cy=${this.at[1]} r=${r}></circle>
        </svg>
      </span>
    </button>`;
  }

  static override styles = css`
    :host {
      --peek-c: var(--fp-orange, #ff9f0a);
      display: block;
      pointer-events: none;
    }
    :host([severe]) {
      --peek-c: var(--fp-red, #ff3b30);
    }
    .peek {
      all: unset;
      pointer-events: auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      animation: peek-in 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .peek:focus-visible .label {
      outline: 2px solid var(--fp-accent, #0a84ff);
      outline-offset: 2px;
    }
    .label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--fp-surface, #fff);
      color: var(--fp-label, #1c1c1e);
      box-shadow: var(--fp-shadow-1, 0 1px 3px rgba(0, 0, 0, 0.18));
      font: 600 var(--fp-text-caption, 12px) / 1.2 var(--fp-font, system-ui);
      white-space: nowrap;
    }
    .text {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .floor {
      color: var(--fp-label-2, #8e8e93);
      font-weight: 500;
    }
    .floor::before {
      content: '· ';
    }
    .dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--peek-c);
    }
    .stage {
      display: block;
      width: 100%;
      height: var(--peek-h, 92px);
      overflow: visible;
    }
    .plate {
      width: 100%;
      height: 100%;
      overflow: visible;
      transform-origin: 50% 50%;
      opacity: 0.9;
    }
    .room {
      fill: var(--fp-label, #1c1c1e);
      fill-opacity: 0.06;
      stroke: var(--fp-label, #1c1c1e);
      stroke-opacity: 0.28;
      stroke-width: 1.4;
      vector-effect: non-scaling-stroke;
      stroke-linejoin: round;
    }
    .mark {
      fill: var(--peek-c);
    }
    .ring {
      fill: var(--peek-c);
      fill-opacity: 0.22;
      transform-box: fill-box;
      transform-origin: center;
      animation: peek-pulse 2.4s ease-in-out infinite;
    }
    .flat .ring {
      animation: none;
    }
    @keyframes peek-pulse {
      0%,
      100% {
        transform: scale(0.7);
        opacity: 0.9;
      }
      50% {
        transform: scale(1.15);
        opacity: 0.35;
      }
    }
    @keyframes peek-in {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ring,
      .peek {
        animation: none;
      }
    }
  `;
}

if (!customElements.get('fp-floor-peek')) customElements.define('fp-floor-peek', FpFloorPeek);

declare global {
  interface HTMLElementTagNameMap {
    'fp-floor-peek': FpFloorPeek;
  }
}
