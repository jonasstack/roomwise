import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { SunInfo, WeatherInfo } from '../ambient';
import { bearingToPlan } from '../ambient';
import { WeatherGL, parseColor, type WeatherParams } from '../gl/weather';

let WX_OK: boolean | undefined;

/** Deterministic pseudo random (stable layout across renders). */
const rnd = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Slow drifts (clouds, fog) move in small steps: a few frames per second instead of 60 — they look the same, but the 3D scene is not recomposited every frame */
const STEPS_PER_S = 3;

const RAIN = new Set(['rainy', 'pouring', 'lightning-rainy', 'snowy-rainy', 'hail']);
const SNOW = new Set(['snowy', 'snowy-rainy']);
const STORM = new Set(['lightning', 'lightning-rainy']);
const OVERCAST = new Set(['cloudy', 'fog', 'rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'lightning-rainy']);

/**
 * Ambient sky + weather in screen space around/over the floor plan.
 * layer="back": sky tint, sun glow, stars. layer="front": sun marker, clouds with ground shadows,
 * fog banks, rain, snow, hail, lightning. Only transform/opacity animate; fewer particles on weak
 * devices; "static" pauses motion.
 */
export class FpAmbient extends LitElement {
  static override properties = {
    layer: { type: String, reflect: true },
    weather: { attribute: false },
    sun: { attribute: false },
    level: { type: String, reflect: true },
    north: { type: Number },
    tilt: { type: Number },
    spin: { type: Number },
    night: { type: Number },
    alarm: { type: Boolean },
    quality: { type: String, reflect: true },
    covered: { type: Boolean, reflect: true },
  };
  declare layer: 'back' | 'front';
  declare weather?: WeatherInfo;
  declare sun?: SunInfo;
  declare level: 'off' | 'static' | 'lite' | 'full';
  declare north: number;
  /** Current 3D tilt of the plan in degrees (0 in 2D): squashes the sun marker's orbit. */
  declare tilt: number;
  /** View rotation of the plan (degrees): sun and wind directions rotate with it. */
  declare spin: number;
  /** 0 day … 1 night (from the sky palette) */
  declare night: number;
  /** Front door warning: the sky pulses softly red */
  declare alarm?: boolean;
  /** 'smooth' (fluid, richer clouds) or 'saver' (slow drifts in steps) */
  declare quality: 'smooth' | 'saver';
  /** A popup or the editor covers the card: clouds, stars and precipitation hold still */
  declare covered?: boolean;

  constructor() {
    super();
    this.layer = 'back';
    this.level = 'full';
    this.north = 0;
    this.tilt = 0;
    this.spin = 0;
    this.night = 0;
    this.quality = 'smooth';
  }

  /** Plan direction → screen direction (applies the view rotation). */
  private rot(v: [number, number] | number[]): [number, number] {
    const a = (this.spin * Math.PI) / 180;
    return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
  }

  /** Smooth mode renders clouds, stars, shadows, fog and precipitation with WebGL shaders */
  private get useGl(): boolean {
    if (WX_OK === undefined) WX_OK = WeatherGL.supported();
    return WX_OK && this.quality !== 'saver' && this.level !== 'off';
  }
  private wx?: WeatherGL;

  override render() {
    if (this.level === 'off') return nothing;
    // saver: only the sky colour of the time of day — no clouds, stars, precipitation or any animation
    if (this.quality === 'saver') return this.layer === 'back' ? this.renderSkyOnly() : nothing;
    return this.layer === 'back' ? this.renderBack() : this.renderFront();
  }

  private renderSkyOnly() {
    const sun = this.sun;
    if (!sun) return nothing;
    const d = this.rot(sun.dir);
    const squash = 0.55 + 0.45 * Math.cos((this.tilt * Math.PI) / 180);
    const gx = 50 + d[0] * 62;
    const gy = 50 + d[1] * 62 * squash;
    const angle = (Math.atan2(d[0], -d[1] * squash) * 180) / Math.PI;
    return html`<div class="sky" style=${`--gx:${gx.toFixed(1)}%;--gy:${gy.toFixed(1)}%;--ga:${angle.toFixed(1)}deg`}></div>
      ${this.alarm ? html`<div class="alarm still"></div>` : nothing}`;
  }

  override updated() {
    if (!this.useGl) {
      this.wx?.destroy();
      this.wx = undefined;
      return;
    }
    const canvas = this.renderRoot.querySelector('canvas.wx') as HTMLCanvasElement | null;
    if (!canvas) return;
    if (!this.wx || this.wx.dead || this.wx.canvas !== canvas) {
      this.wx?.destroy();
      try {
        this.wx = new WeatherGL(canvas, this.layer);
      } catch (err) {
        console.warn('floorplan-card: weather shaders unavailable', err);
        WX_OK = false;
        this.requestUpdate();
        return;
      }
    }
    this.wx.set(this.wxParams());
    this.wx.setCovered(!!this.covered);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.wx?.destroy();
    this.wx = undefined;
  }

  private wxParams(): WeatherParams {
    const w = this.weather;
    const sun = this.sun;
    const cs = getComputedStyle(this);
    const v = (n: string, fb: [number, number, number, number]) => parseColor(cs.getPropertyValue(n) || '', fb);
    const cond = w?.condition ?? '';
    const cover = w && cond !== 'fog' ? Math.min(1, w.coverage / 100) : 0;
    const windTo = this.rot(w?.windBearing != null ? bearingToPlan(w.windBearing + 180, this.north) : [1, 0]);
    const windK = Math.min(1, (w?.windSpeed ?? 8) / 35);
    const squash = 0.55 + 0.45 * Math.cos((this.tilt * Math.PI) / 180);
    const sd = sun ? this.rot(sun.dir) : [0, -1];
    const sl = Math.hypot(sd[0], sd[1] * squash) || 1;
    const cloud = v('--fp-cloud', [1, 1, 1, 0.95]);
    const shadow = v('--fp-shadow-tint', [0.16, 0.2, 0.35, 1]);
    const belly = v('--fp-cloud-dark', [cloud[0] * 0.42 + shadow[0] * 0.58, cloud[1] * 0.42 + shadow[1] * 0.58, cloud[2] * 0.46 + shadow[2] * 0.54, 1]);
    const dark = [belly[0], belly[1], belly[2]] as [number, number, number];
    const rainK = cond === 'pouring' ? 1 : cond === 'rainy' ? 0.7 : cond === 'lightning-rainy' ? 0.8 : cond === 'snowy-rainy' ? 0.5 : cond === 'hail' ? 0.35 : 0;
    const snowK = cond === 'snowy' ? 1 : cond === 'snowy-rainy' ? 0.5 : cond === 'hail' ? 0.45 : 0;
    const slantDeg = Math.max(-28, Math.min(28, -windTo[0] * windK * 30));
    const starK = Number(cs.getPropertyValue('--fp-star-k')) || 0;
    return {
      cover: cover * (this.level === 'lite' ? 0.8 : 1),
      wind: [windTo[0] * (0.6 + windK), windTo[1] * (0.6 + windK)],
      windK,
      sun: [sd[0] / sl, (sd[1] * squash) / sl],
      sunK: sun?.up ? sun.strength : 0,
      stars: this.layer === 'back' && this.night > 0.15 ? starK * Math.max(0, 1 - cover * 1.3) : 0,
      rain: rainK,
      snow: snowK,
      fog: cond === 'fog' ? 1 : 0,
      slant: (slantDeg * Math.PI) / 180,
      cloudAlpha: Math.max(0.6, cloud[3]),
      still: this.level === 'static',
      colors: {
        light: [cloud[0], cloud[1], cloud[2]],
        dark,
        glow: v('--fp-sky-glow', [1, 0.8, 0.6, 0.4]),
        shadow: [shadow[0], shadow[1], shadow[2]],
        fog: v('--fp-fog', [1, 1, 1, 0.55]),
        rain: v('--fp-rain', [0.7, 0.8, 0.95, 0.6]),
        snow: v('--fp-snow', [1, 1, 1, 0.95]),
      },
    };
  }

  private renderBack() {
    const sun = this.sun;
    const w = this.weather;
    const parts: (TemplateResult | typeof nothing)[] = [];
    if (sun) {
      // Sky gradient towards the sun's side (also below the horizon: dusk & dawn light), glow, halo around the house
      const d = this.rot(sun.dir);
      const squash = 0.55 + 0.45 * Math.cos((this.tilt * Math.PI) / 180);
      const gx = 50 + d[0] * 62;
      const gy = 50 + d[1] * 62 * squash;
      const angle = (Math.atan2(d[0], -d[1] * squash) * 180) / Math.PI;
      parts.push(html`<div class="sky" style=${`--gx:${gx.toFixed(1)}%;--gy:${gy.toFixed(1)}%;--ga:${angle.toFixed(1)}deg`}></div>`);
    }
    if (this.useGl) {
      // fixed slots: the canvas (and its WebGL context) survives weather changes
      return html`${parts}${w && OVERCAST.has(w.condition) ? html`<div class="overcast"></div>` : nothing}<canvas class="wx"></canvas>${this.alarm ? html`<div class="alarm"></div>` : nothing}`;
    }
    if (w && OVERCAST.has(w.condition)) parts.push(html`<div class="overcast"></div>`);
    const starry = this.night > 0.15 && (w?.coverage ?? 0) < 75;
    if (starry) {
      const n = this.level === 'lite' ? 36 : 90;
      // three twinkle groups (each one layer) instead of one animation per star
      parts.push(html`<div class="stars">
        ${[0, 1, 2].map(
          (g) => html`<div class="twinkle g${g}">
            ${Array.from({ length: n }, (_, i) => i)
              .filter((i) => i % 3 === g)
              .map((i) => {
                const size = 0.8 + rnd(i, 3) ** 3 * 2.4;
                const hue = rnd(i, 6);
                return html`<i
                  class=${hue > 0.85 ? 'warm' : hue < 0.12 ? 'blue' : ''}
                  style=${`left:${(rnd(i, 1) * 100).toFixed(2)}%;top:${(rnd(i, 2) * 100).toFixed(2)}%;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px`}
                ></i>`;
              })}
          </div>`,
        )}
        ${this.level === 'full' ? html`<b class="shooting"></b>` : nothing}
      </div>`);
    }
    if (w) parts.push(this.clouds(w, 'puff'));
    if (this.alarm) parts.push(html`<div class="alarm"></div>`);
    return html`${parts}`;
  }

  private renderFront() {
    const w = this.weather;
    const lite = this.level === 'lite';
    const parts: (TemplateResult | typeof nothing)[] = [];
    if (!w) return html`${parts}`;
    const windTo = this.rot(w.windBearing != null ? bearingToPlan(w.windBearing + 180, this.north) : [1, 0]);
    const windStrength = Math.min(1, (w.windSpeed ?? 8) / 35);
    const slant = Math.max(-28, Math.min(28, -windTo[0] * windStrength * 30));

    if (this.useGl) {
      // fixed slots: the canvas (and its WebGL context) survives weather changes
      return html`${w.condition === 'fog' ? html`<div class="haze"></div>` : nothing}<canvas class="wx"></canvas>${STORM.has(w.condition) ? html`<div class="flash"></div>` : nothing}`;
    }
    parts.push(this.clouds(w, 'shade'));
    if (w.condition === 'fog') {
      parts.push(html`<div class="haze"></div>
        <div class="fog">
          ${Array.from({ length: lite ? 2 : 4 }, (_, i) => {
            const dur = 50 + rnd(i, 30) * 40;
            const steps = this.quality === 'saver' ? `;animation-timing-function:steps(${Math.round(dur * STEPS_PER_S)})` : '';
            return html`<i style=${`top:${(i * 24 - 8 + rnd(i, 31) * 8).toFixed(1)}%;animation-duration:${dur.toFixed(0)}s;animation-delay:-${(rnd(i, 32) * dur).toFixed(0)}s${steps}`}></i>`;
          })}
        </div>`);
    }
    if (RAIN.has(w.condition) && !SNOW.has(w.condition)) {
      parts.push(this.particles('rain', (w.condition === 'pouring' ? 4 : 3) - (lite ? 1 : 0), slant));
    }
    if (SNOW.has(w.condition)) parts.push(this.particles('snow', lite ? 2 : 3, slant * 0.6));
    if (w.condition === 'hail') parts.push(this.particles('hail', lite ? 1 : 2, slant));
    if (STORM.has(w.condition)) parts.push(html`<div class="flash"></div>`);
    return html`${parts}`;
  }

  /** Cloud layer: 'puff' bodies drift in the sky behind the plan, 'shade' casts their shadows over it. */
  private clouds(w: WeatherInfo, part: 'puff' | 'shade') {
    const cloudCount = w.coverage > 85 ? 4 : w.coverage > 55 ? 3 : w.coverage > 25 ? 2 : w.coverage > 10 ? 1 : 0;
    if (!cloudCount || w.condition === 'fog') return nothing;
    const windTo = this.rot(w.windBearing != null ? bearingToPlan(w.windBearing + 180, this.north) : [1, 0]);
    const windStrength = Math.min(1, (w.windSpeed ?? 8) / 35);
    const base = 110 - windStrength * 50;
    const smooth = this.quality !== 'saver';
    const n = this.level === 'lite' ? Math.ceil(cloudCount / 2) : cloudCount;
    const timing = (dur: number) => (smooth ? '' : `;animation-timing-function:steps(${Math.round(dur * STEPS_PER_S)})`);
    const cloud = (i: number, far: boolean) => {
      const dur = base * (0.75 + rnd(i, 7) * 0.6) * (far ? 1.7 : 1);
      const size = far ? 12 + rnd(i, 19) * 9 : (part === 'puff' ? 24 : 18) + rnd(i, 9) * 14;
      const morph = 14 + rnd(i, 17) * 10;
      return html`<div
        class="cloud ${far ? 'far' : ''}"
        style=${`top:${(rnd(i + (far ? 50 : 0), 8) * (far ? 60 : 85) - 10).toFixed(1)}%;width:${size.toFixed(0)}%;animation-duration:${dur.toFixed(0)}s;animation-delay:-${(rnd(i, 11) * dur).toFixed(0)}s${timing(dur)}`}
      >
        <i class=${part} style=${smooth ? `animation-duration:${morph.toFixed(1)}s;animation-delay:-${(rnd(i, 13) * morph).toFixed(1)}s` : ''}></i>
      </div>`;
    };
    // smooth: a second, distant layer of smaller clouds drifting slower (depth)
    const far = smooth && part === 'puff' && this.level !== 'lite' ? Array.from({ length: Math.min(4, cloudCount + 1) }, (_, i) => cloud(i + 20, true)) : [];
    return html`<div class="clouds ${windTo[0] < 0 ? 'rtl' : ''}">${far}${Array.from({ length: n }, (_, i) => cloud(i, false))}</div>`;
  }

  /**
   * Precipitation as three tiled sheets (near / middle / far) instead of hundreds of animated drops:
   * each sheet paints its drops with background gradients and moves as one composited layer.
   */
  private particles(kind: 'rain' | 'snow' | 'hail', perSheet: number, slant: number) {
    const tile = kind === 'snow' ? [220, 260] : [260, 320];
    const speed = kind === 'snow' ? [7, 9.5, 13] : kind === 'hail' ? [0.42, 0.5, 0.6] : [0.26, 0.33, 0.42];
    const sheets = [0, 1, 2].map((k) => {
      const scale = 1 - k * 0.22;
      const imgs: string[] = [];
      const pos: string[] = [];
      for (let i = 0; i < perSheet; i++) {
        const x = (rnd(i + k * 31, 41) * tile[0]).toFixed(0);
        const y = (rnd(i + k * 31, 42) * tile[1]).toFixed(0);
        if (kind === 'rain') imgs.push(`radial-gradient(${(1.1 * scale).toFixed(2)}px ${(30 * scale).toFixed(0)}px at ${x}px ${y}px, var(--fp-rain) 0%, transparent 100%)`);
        else imgs.push(`radial-gradient(circle ${((kind === 'snow' ? 4 : 2.2) * scale).toFixed(1)}px at ${x}px ${y}px, var(--fp-snow) 55%, transparent 100%)`);
        pos.push('0 0');
      }
      return html`<i
        class="sheet"
        style=${`--th:${tile[1]}px;background-image:${imgs.join(',')};background-size:${tile[0]}px ${tile[1]}px;animation-duration:${speed[k]}s;opacity:${(1 - k * 0.2).toFixed(2)}`}
      ></i>`;
    });
    return html`<div class="precip ${kind}" style=${`transform:rotate(${slant.toFixed(1)}deg) scale(1.35)`}>${sheets}</div>`;
  }

  static override styles = css`
    /* under a popup the sky holds still (the alarm pulse keeps going) */
    :host([covered]) :not(.alarm) {
      animation-play-state: paused !important;
    }
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      contain: strict;
    }
    canvas.wx {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .sky,
    .halo,
    .overcast {
      position: absolute;
      inset: 0;
    }
    /* one layer: halo around the house + darker edges, sun-side glow, sky gradient */
    .sky {
      contain: strict;
      background:
        radial-gradient(ellipse 55% 50% at 50% 52%, var(--fp-sky-glow-soft), transparent 75%),
        radial-gradient(ellipse 85% 80% at 50% 50%, transparent 60%, color-mix(in srgb, var(--fp-sky-top) 55%, transparent)),
        radial-gradient(ellipse 70% 60% at var(--gx) var(--gy), var(--fp-sky-glow), transparent 72%),
        radial-gradient(ellipse 140% 110% at var(--gx) var(--gy), var(--fp-sky-glow-soft), transparent 85%),
        linear-gradient(calc(var(--ga) + 180deg), var(--fp-sky-top), var(--fp-sky-bottom));
      transition: opacity 1.2s ease;
    }
    /* soft light pool around the house + darker edges: the house sits in its own atmosphere */
    .halo {
      background:
        radial-gradient(ellipse 55% 50% at 50% 52%, var(--fp-sky-glow-soft), transparent 75%),
        radial-gradient(ellipse 85% 80% at 50% 50%, transparent 60%, color-mix(in srgb, var(--fp-sky-top) 55%, transparent));
    }
    .overcast {
      background: linear-gradient(180deg, var(--fp-overcast), transparent 85%);
    }
    .alarm.still {
      animation: none;
      opacity: 0.8;
    }
    .alarm {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 75% 70% at 50% 50%, rgba(255, 59, 48, 0.08), rgba(255, 59, 48, 0.42));
      animation: alarm-pulse 2.4s ease-in-out infinite;
    }
    @keyframes alarm-pulse {
      0%,
      100% {
        opacity: 0.25;
      }
      50% {
        opacity: 1;
      }
    }
    .stars {
      position: absolute;
      inset: 0;
      opacity: var(--fp-star-k, 0);
      transition: opacity 2s ease;
    }
    .stars i {
      position: absolute;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 0 3px rgba(255, 255, 255, 0.7);
    }
    .twinkle {
      position: absolute;
      inset: 0;
      animation: twinkle 4s ease-in-out infinite alternate;
    }
    :host([quality='saver']) .twinkle {
      animation-timing-function: steps(12);
    }
    .twinkle.g1 {
      animation-duration: 5.5s;
      animation-delay: -2s;
    }
    .twinkle.g2 {
      animation-duration: 7s;
      animation-delay: -4s;
    }
    .stars i.warm {
      background: #ffe2b8;
    }
    .stars i.blue {
      background: #cddcff;
    }
    .shooting {
      position: absolute;
      left: 12%;
      top: 14%;
      width: 120px;
      height: 1.5px;
      border-radius: 1px;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.9));
      transform: rotate(18deg);
      opacity: 0;
      animation: shoot 23s linear infinite;
      animation-delay: 6s;
    }
    @keyframes shoot {
      0%,
      96% {
        opacity: 0;
        transform: rotate(18deg) translateX(0);
      }
      97% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: rotate(18deg) translateX(320px);
      }
    }

    /* Clouds: a soft puff plus its shadow on the ground, drifting with the wind */
    .clouds .cloud {
      position: absolute;
      left: 0;
      aspect-ratio: 2.2;
      animation: drift 100s linear infinite;
    }
    .clouds.rtl .cloud {
      animation-name: drift-rtl;
    }
    .cloud i {
      position: absolute;
      inset: 0;
      border-radius: 50%;
    }
    .cloud .shade {
      background: radial-gradient(closest-side at 35% 55%, var(--fp-cloud-shadow), transparent),
        radial-gradient(closest-side at 62% 45%, var(--fp-cloud-shadow), transparent),
        radial-gradient(closest-side at 50% 62%, var(--fp-cloud-shadow), transparent);
    }
    .cloud .puff {
      background: radial-gradient(closest-side at 34% 58%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 58% 42%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 72% 60%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 50% 66%, var(--fp-cloud), transparent);
    }
    /* smooth: fuller clouds with a slightly shaded underside, gently changing shape */
    :host([quality='smooth']) .cloud .puff {
      background: radial-gradient(closest-side at 30% 52%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 46% 38%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 63% 34%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 77% 52%, var(--fp-cloud), transparent),
        radial-gradient(closest-side at 52% 60%, var(--fp-cloud), transparent),
        radial-gradient(60% 40% at 52% 78%, color-mix(in srgb, var(--fp-cloud) 70%, var(--fp-cloud-shadow)), transparent);
      animation: morph 18s ease-in-out infinite alternate;
    }
    :host([quality='smooth']) .cloud .shade {
      animation: morph 18s ease-in-out infinite alternate;
    }
    :host([quality='smooth']) .cloud {
      will-change: transform;
    }
    .cloud.far {
      opacity: 0.55;
    }
    @keyframes morph {
      0% {
        transform: scale(1, 1) translateX(0);
      }
      50% {
        transform: scale(1.06, 0.95) translateX(1.5%);
      }
      100% {
        transform: scale(0.97, 1.05) translateX(-1%);
      }
    }

    /* Fog: a light haze plus banks drifting through */
    .haze {
      position: absolute;
      inset: 0;
      background: var(--fp-haze);
    }
    .fog i {
      position: absolute;
      left: 0;
      width: 140%;
      height: 42%;
      background: radial-gradient(closest-side, var(--fp-fog), transparent);
      animation: bank 70s linear infinite;
    }

    .precip {
      position: absolute;
      inset: -20% -20%;
      overflow: hidden;
    }
    .precip.snow {
      animation: sway 3s ease-in-out infinite alternate;
    }
    .precip .sheet {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(-1 * var(--th));
      bottom: 0;
      background-repeat: repeat;
      animation: sheet 0.3s linear infinite;
      will-change: transform;
    }
    @keyframes sheet {
      from {
        transform: translateY(0);
      }
      to {
        transform: translateY(var(--th));
      }
    }
    .flash {
      position: absolute;
      inset: 0;
      background: var(--fp-flash);
      opacity: 0;
      animation: flash 11s linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .cloud i {
        animation: none !important;
      }
    }
    :host([level='static']) * {
      animation-play-state: paused !important;
    }
    @keyframes twinkle {
      from {
        opacity: 0.25;
      }
      to {
        opacity: 1;
      }
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes drift {
      from {
        transform: translateX(-110%);
      }
      to {
        transform: translateX(calc(100vw + 10%));
      }
    }
    @keyframes drift-rtl {
      from {
        transform: translateX(calc(100vw + 10%));
      }
      to {
        transform: translateX(-110%);
      }
    }
    @keyframes bank {
      from {
        transform: translateX(-75%);
      }
      to {
        transform: translateX(75%);
      }
    }
    @keyframes fall {
      from {
        transform: translateY(-100%);
      }
      to {
        transform: translateY(100%);
      }
    }
    @keyframes sway {
      from {
        transform: translateX(-10px);
      }
      to {
        transform: translateX(10px);
      }
    }
    @keyframes flash {
      0%,
      91%,
      93.5%,
      100% {
        opacity: 0;
      }
      92% {
        opacity: 0.7;
      }
      94.5% {
        opacity: 0.45;
      }
      95.5% {
        opacity: 0;
      }
    }
  `;
}

if (!customElements.get('fp-ambient')) customElements.define('fp-ambient', FpAmbient);
