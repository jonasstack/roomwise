import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { components } from '../design/components';
import { tokens } from '../design/tokens';
import { FURNITURE_BY_KIND, FURNITURE_PALETTES, resolveFurniture, variantLabel } from '../furniture';
import { t } from '../i18n';
import { petLook, type PetLook } from '../pets';
import type { FurnitureConfig, PetConfig, PetPaint } from '../types';
import { DogStudio } from '../gl/dog-studio';
import { dogLookKey, type DogAnim } from '../gl/pet-model';

/** How many strokes the coat holds (the markings take a few of the shader's places) */
const MAX_PAINT = 30;
const BRUSH_CM = { s: 2.2, m: 4.5, l: 8 } as const;
const PAINT = ['#1d1d1f', '#4a3426', '#7a4f2e', '#a8743f', '#d4a26a', '#e8d2b0', '#f6efe3', '#ffffff', '#8e8e93', '#c9b8a6'];
const GEAR = ['#d8483a', '#e8892c', '#e8c547', '#4f9d5d', '#3f8ed8', '#5856d6', '#8a5cc8', '#e46aa0', '#2c2c2e', '#8b5a3c', '#f2f2f7'];
const TAGS = ['#d4af37', '#c0c4ca', '#b87333', '#2c2c2e'];
const EYES = ['#3a2618', '#6b4423', '#9a6a2f', '#3f6fa8', '#7aa0c8', '#1d1d1f'];

type Mode = 'turn' | 'paint' | 'erase';
/** the resting pose (config) and the animation that shows it */
const POSE_ANIM: Record<string, DogAnim> = { standing: 'Idle', sitting: 'Sit', lying: 'Lie' };

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The dog in 3D: turn it, paint on its coat, choose breed, colours, markings, ears, tail and gear (collar with
 * tag, harness, neckerchief). The same model as on the plan. Works on a draft; "Fertig" hands it back.
 */
export class FpDogEditor extends LitElement {
  static override properties = {
    furniture: { attribute: false },
    dark: { type: Boolean, reflect: true },
    _f: { state: true },
    _mode: { state: true },
    _brush: { state: true },
    _color: { state: true },
    _pose: { state: true },
    _ready: { state: true },
    _full: { state: true },
  };
  declare furniture: FurnitureConfig;
  declare dark: boolean;
  declare _f: FurnitureConfig;
  declare _mode: Mode;
  declare _brush: keyof typeof BRUSH_CM;
  declare _color: string;
  declare _pose: DogAnim;
  declare _ready: boolean;
  declare _full: boolean;

  private studio?: DogStudio;
  private ro?: ResizeObserver;
  private shownKey = '';
  private undo: PetPaint[][] = [];

  constructor() {
    super();
    this._mode = 'turn';
    this._brush = 'm';
    this._color = '#1d1d1f';
    this._pose = 'Idle';
    this._ready = false;
    this._full = false;
  }

  override willUpdate(ch: PropertyValues) {
    if (ch.has('furniture') && this.furniture && !this._f) {
      this._f = structuredClone(this.furniture);
      this._pose = POSE_ANIM[this.look.pose] ?? 'Idle';
    }
  }

  override firstUpdated() {
    const canvas = this.renderRoot.querySelector('canvas') as HTMLCanvasElement;
    try {
      this.studio = new DogStudio(canvas);
    } catch {
      return;
    }
    this.studio.start();
    const box = canvas.parentElement!;
    this.ro = new ResizeObserver(() => {
      const r = box.getBoundingClientRect();
      this.studio?.setSize(r.width, r.height);
    });
    this.ro.observe(box);
    this.syncStudio();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.studio?.dispose();
    this.studio = undefined;
  }

  override updated() {
    this.syncStudio();
  }

  private get look(): PetLook {
    return petLook(this._f);
  }

  private dims() {
    const r = resolveFurniture(this._f);
    return { length: this._f.w, height: r.height, width: this._f.h };
  }

  /** Rebuild the dog when its look changed; painting alone only updates the coat */
  private syncStudio() {
    if (!this.studio || !this._f) return;
    const look = this.look;
    const key = dogLookKey({ ...look, paint: [] }) + JSON.stringify(this.dims());
    if (key !== this.shownKey) {
      this.shownKey = key;
      void this.studio.show(look, this.dims(), this._pose).then((ok) => (this._ready = ok));
    } else this.studio.setPaint(look.paint);
  }

  // ---------- edits ----------

  private setF(fn: (x: FurnitureConfig) => void) {
    const x = structuredClone(this._f);
    fn(x);
    this._f = x;
  }

  private setPet(fn: (p: PetConfig) => void) {
    this.setF((x) => {
      const p: PetConfig = { ...(x.pet ?? {}) };
      fn(p);
      for (const k of Object.keys(p) as (keyof PetConfig)[]) if (p[k] === undefined) delete p[k];
      x.pet = Object.keys(p).length ? p : undefined;
    });
  }

  private get paint(): PetPaint[] {
    return this._f.pet?.paint ?? [];
  }

  private setPaint(list: PetPaint[]) {
    this._full = list.length >= MAX_PAINT;
    this.setPet((p) => (p.paint = list.length ? list : undefined));
  }

  // ---------- pointer: turn, zoom, paint ----------

  private ptrs = new Map<number, { x: number; y: number }>();
  private pinch?: { d: number; cx: number; cy: number };
  private stroke?: { list: PetPaint[]; last: [number, number, number]; dir?: [number, number, number] };
  /** what this drag does: painting on the dog, or turning (a drag beside it turns even while painting) */
  private drag?: 'turn' | 'paint';

  private brushR(): number {
    return BRUSH_CM[this._brush] * (this.studio?.unitsPerCm ?? 0.05);
  }

  private down = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.ptrs.size === 2) {
      this.endStroke();
      const [a, b] = [...this.ptrs.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    // right / middle button always turns
    this.drag = this._mode !== 'turn' && e.button === 0 && this.paintAt(e.clientX, e.clientY, true) ? 'paint' : 'turn';
  };

  private move = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pinch && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.studio?.zoom(this.pinch.d / d);
      this.studio?.orbit(cx - this.pinch.cx, cy - this.pinch.cy);
      this.pinch = { d, cx, cy };
      return;
    }
    if (this.drag === 'paint') this.paintAt(e.clientX, e.clientY, false);
    else this.studio?.orbit(dx, dy);
  };

  private up = (e: PointerEvent) => {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinch = undefined;
    if (!this.ptrs.size) {
      this.endStroke();
      this.drag = undefined;
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.studio?.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  };

  private gestureScale = 1;
  private gesture = (e: Event & { scale?: number }) => {
    e.preventDefault();
    if (e.type === 'gesturestart') this.gestureScale = 1;
    else if (e.type === 'gesturechange' && e.scale) {
      this.studio?.zoom(this.gestureScale / e.scale);
      this.gestureScale = e.scale;
    }
  };

  /** paint or erase under the pointer; false: the pointer is beside the dog */
  private paintAt(x: number, y: number, start: boolean): boolean {
    const p = this.studio?.pick(x, y);
    if (!p) return false;
    const r = this.brushR();
    if (this._mode === 'erase') {
      const hit = (s: PetPaint) => {
        const a = s.p;
        const b = s.q ?? s.p;
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
        const h = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
        return Math.hypot(ap[0] - ab[0] * h, ap[1] - ab[1] * h, ap[2] - ab[2] * h) < s.r + r;
      };
      if (start) this.undo.push(this.paint);
      const left = this.paint.filter((s) => !hit(s));
      if (left.length !== this.paint.length) this.setPaint(left);
      return true;
    }
    const c = this._color;
    const P = p.map(round3) as [number, number, number];
    if (start || !this.stroke) {
      if (this.paint.length >= MAX_PAINT) {
        this._full = true;
        return true;
      }
      this.undo.push(this.paint);
      if (this.undo.length > 30) this.undo.shift();
      const list = [...this.paint, { p: P, r: round3(r), c }];
      this.stroke = { list, last: P };
      this.setPaint(list);
      return true;
    }
    const s = this.stroke;
    const d = Math.hypot(P[0] - s.last[0], P[1] - s.last[1], P[2] - s.last[2]);
    if (d < r * 0.5) return true;
    const dir: [number, number, number] = [(P[0] - s.last[0]) / d, (P[1] - s.last[1]) / d, (P[2] - s.last[2]) / d];
    const cur = s.list[s.list.length - 1];
    // a straight stroke grows its capsule; a turn starts the next one (few capsules for long strokes)
    const straight = s.dir && dir[0] * s.dir[0] + dir[1] * s.dir[1] + dir[2] * s.dir[2] > 0.92;
    if (!cur.q || straight) {
      cur.q = P;
      s.dir = s.dir ?? dir;
    } else {
      if (s.list.length >= MAX_PAINT) {
        this._full = true;
        return true;
      }
      s.list.push({ p: cur.q, q: P, r: cur.r, c });
      s.dir = dir;
    }
    s.last = P;
    this.setPaint([...s.list]);
    return true;
  }

  private endStroke() {
    this.stroke = undefined;
  }

  // ---------- render ----------

  /** a colour row; `none` puts an "off" field first (gear), `lead` another first field (the eraser) */
  private swatches(label: string, palette: string[], value: string | undefined, set: (c: string) => void, opts: { none?: () => void; lead?: { icon: string; label: string; on: boolean; pick: () => void } } = {}) {
    const lead = opts.lead ?? (opts.none ? { icon: 'mdi:cancel', label: t('dog.none'), on: !value, pick: opts.none } : undefined);
    const sel = lead?.on ? undefined : value?.toLowerCase();
    return html`${label ? html`<div class="label-row">${label}</div>` : nothing}
      <div class="swatches">
        ${lead
          ? html`<button class="swatch none pressable ${lead.on ? 'sel' : ''}" aria-label=${lead.label} title=${lead.label} @click=${lead.pick}>
              <ha-icon icon=${lead.icon}></ha-icon>
            </button>`
          : nothing}
        ${palette.map((c) => html`<button class="swatch pressable ${sel === c.toLowerCase() ? 'sel' : ''}" style=${`background:${c}`} aria-label=${c} @click=${() => set(c)}></button>`)}
        <label class="swatch custom" title=${t('editor.custom_color')}>
          <input type="color" .value=${value && value.startsWith('#') ? value : '#888888'} @change=${(e: Event) => set((e.target as HTMLInputElement).value)} />
          <ha-icon icon="mdi:eyedropper-variant"></ha-icon>
        </label>
      </div>`;
  }

  private done() {
    this.dispatchEvent(new CustomEvent('dog-done', { detail: { furniture: this._f }, bubbles: true, composed: true }));
  }

  private cancel() {
    this.dispatchEvent(new CustomEvent('dog-cancel', { bubbles: true, composed: true }));
  }

  private resetView() {
    this.studio?.view('default');
    this.studio?.zoom(1 / (this.studio?.zoomLevel ?? 1));
  }

  private setRest(v: NonNullable<PetConfig['pose']>) {
    this.setPet((x) => (x.pose = v));
    this._pose = POSE_ANIM[v];
    this.studio?.setPose(this._pose);
  }

  override render() {
    if (!this._f) return nothing;
    const look = this.look;
    const r = resolveFurniture(this._f);
    const kind = FURNITURE_BY_KIND.get('dog');
    const simple = look.figure === 'simple';
    const painting = this._mode !== 'turn' && !simple;
    const swatchColors = [...new Set([look.fur, look.marks, ...PAINT].map((c) => c.toLowerCase()))];
    return html`
      <header class="bar">
        <button class="btn plain pressable" @click=${this.cancel}>${t('common.cancel')}</button>
        <div class="bar-title">${this._f.name || t('dog.title')}</div>
        <button class="btn accent pressable" data-done @click=${this.done}>${t('dog.done')}</button>
      </header>
      <div class="body">
        <div class="stage-wrap">
          <div
            class="stage ${this._mode}"
            @pointerdown=${this.down}
            @pointermove=${this.move}
            @pointerup=${this.up}
            @pointercancel=${this.up}
            @wheel=${this.wheel}
            @gesturestart=${this.gesture}
            @gesturechange=${this.gesture}
            @gestureend=${this.gesture}
            @contextmenu=${(e: Event) => e.preventDefault()}
          >
            <canvas></canvas>
            ${this._ready ? nothing : html`<div class="loading">${t('dog.loading')}</div>`}
          </div>
          <div class="tools">
            ${simple
              ? nothing
              : html`<button class="pill pressable" data-mode="paint" aria-pressed=${painting ? 'true' : 'false'} @click=${() => (this._mode = painting ? 'turn' : 'paint')}>
                  <ha-icon icon="mdi:brush"></ha-icon>${t('dog.paint')}
                </button>`}
            <button class="pill round pressable" title=${t('dog.reset_view')} aria-label=${t('dog.reset_view')} @click=${this.resetView}><ha-icon icon="mdi:restore"></ha-icon></button>
          </div>
          <div class="brushbar">
            ${painting
              ? html`${this.swatches('', swatchColors, this._color, (c) => ((this._color = c), (this._mode = 'paint')), {
                    lead: { icon: 'mdi:eraser', label: t('dog.erase'), on: this._mode === 'erase', pick: () => (this._mode = 'erase') },
                  })}
                  <div class="brush-row">
                    <div class="segmented" role="group" aria-label=${t('dog.brush')}>
                      ${(['s', 'm', 'l'] as const).map((b) => html`<button class="pressable" aria-pressed=${this._brush === b ? 'true' : 'false'} @click=${() => (this._brush = b)}><span class="dot ${b}"></span></button>`)}
                    </div>
                    <button class="btn pressable" ?disabled=${!this.undo.length} @click=${() => this.setPaint(this.undo.pop() ?? [])}><ha-icon icon="mdi:undo"></ha-icon>${t('dog.undo')}</button>
                    <button class="btn pressable" ?disabled=${!this.paint.length} @click=${() => {
                      this.undo.push(this.paint);
                      this.setPaint([]);
                    }}><ha-icon icon="mdi:delete-outline"></ha-icon>${t('dog.clear')}</button>
                  </div>
                  <div class="hint-s">${this._full ? t('dog.full') : t(this._mode === 'paint' ? 'dog.paint_hint' : 'dog.erase_hint')}</div>`
              : html`<div class="pose-row">
                  <span class="label-inline">${t('dog.pose')}</span>
                  <div class="chips">
                    ${(
                      [
                        ['standing', t('editor.pose_standing')],
                        ['sitting', t('editor.pose_sitting')],
                        ['lying', t('editor.pose_lying')],
                      ] as [NonNullable<PetConfig['pose']>, string][]
                    ).map(([v, l]) => html`<button class="chip pressable" aria-pressed=${look.pose === v ? 'true' : 'false'} @click=${() => this.setRest(v)}>${l}</button>`)}
                  </div>
                </div>
                <div class="hint-s">${t('dog.pose_hint')}</div>`}
          </div>
        </div>
        <div class="panel">
          <div class="section-title">${t('dog.figure')}</div>
          <div class="card">
            <div class="chips">
              ${(
                [
                  ['simple', t('dog.figure_simple')],
                  ['realistic', t('dog.figure_realistic')],
                ] as [NonNullable<PetConfig['figure']>, string][]
              ).map(([v, l]) => html`<button class="chip pressable" data-figure=${v} aria-pressed=${look.figure === v ? 'true' : 'false'} @click=${() => {
                this._mode = 'turn';
                this.setPet((x) => (x.figure = v === 'simple' ? 'simple' : undefined));
              }}>${l}</button>`)}
            </div>
            <div class="hint-s">${t('dog.figure_hint')}</div>
          </div>

          <div class="section-title">${t('dog.breed')}</div>
          <div class="chips">
            ${(kind?.variants ?? []).map(
              (v) => html`<button class="chip pressable" aria-pressed=${r.variant === v.id ? 'true' : 'false'} @click=${() =>
                this.setF((x) => {
                  x.variant = v.id;
                  if (v.w) x.w = v.w;
                  if (v.h) x.h = v.h;
                  x.height = undefined;
                  // the breed's own ears and tail
                  if (x.pet) {
                    delete x.pet.ears;
                    delete x.pet.tail;
                  }
                })}>${variantLabel(v)}</button>`,
            )}
          </div>

          <div class="section-title">${t('editor.fur')}</div>
          <div class="card">
            ${this.swatches(t('dog.fur_main'), FURNITURE_PALETTES.fur, r.color, (c) => this.setF((x) => (x.color = c)))}
            <div class="label-row">${t('editor.markings')}</div>
            <div class="chips">
              ${(
                [
                  ['none', t('editor.mark_none')],
                  ['belly', t('editor.mark_belly')],
                  ['socks', t('editor.mark_socks')],
                  ['mask', t('editor.mark_mask')],
                  ['patches', t('editor.mark_patches')],
                ] as [NonNullable<PetConfig['markings']>, string][]
              ).map(([v, l]) => html`<button class="chip pressable" aria-pressed=${look.markings === v ? 'true' : 'false'} @click=${() => this.setPet((x) => (x.markings = v))}>${l}</button>`)}
              ${look.markings === 'patches'
                ? html`<button class="chip pressable" title=${t('dog.reroll')} aria-label=${t('dog.reroll')} @click=${() => this.setPet((x) => (x.seed = (x.seed ?? 1) + 1))}><ha-icon icon="mdi:dice-5-outline"></ha-icon></button>`
                : nothing}
            </div>
            ${look.markings !== 'none' ? this.swatches(t('dog.marks_color'), FURNITURE_PALETTES.fur, r.accent, (c) => this.setF((x) => (x.accent = c))) : nothing}
            <div class="hint-s">${t('dog.fur_hint')}</div>
          </div>

          <div class="section-title">${t('dog.shape')}</div>
          <div class="card">
            <div class="label-row">${t('editor.ears')}</div>
            <div class="chips">
              ${(
                [
                  ['floppy', t('editor.ears_floppy')],
                  ['pointy', t('editor.ears_pointy')],
                  ['small', t('editor.ears_small')],
                ] as [NonNullable<PetConfig['ears']>, string][]
              ).map(([v, l]) => html`<button class="chip pressable" aria-pressed=${look.ears === v ? 'true' : 'false'} @click=${() => this.setPet((x) => (x.ears = v))}>${l}</button>`)}
            </div>
            <div class="label-row">${t('editor.tail')}</div>
            <div class="chips">
              ${(
                [
                  ['long', t('editor.tail_long')],
                  ['fluffy', t('editor.tail_fluffy')],
                  ['curled', t('editor.tail_curled')],
                  ['short', t('editor.tail_short')],
                ] as [NonNullable<PetConfig['tail']>, string][]
              ).map(([v, l]) => html`<button class="chip pressable" aria-pressed=${look.tail === v ? 'true' : 'false'} @click=${() => this.setPet((x) => (x.tail = v))}>${l}</button>`)}
            </div>
            ${this.swatches(t('dog.eyes'), EYES, look.eyes, (c) => this.setPet((x) => (x.eyes = c)))}
          </div>

          <div class="section-title">${t('dog.gear')}</div>
          <div class="card">
            ${this.swatches(t('dog.collar'), GEAR, look.collar === 'none' ? undefined : look.collar, (c) => this.setPet((x) => (x.collar = c)), { none: () => this.setPet((x) => (x.collar = 'none')) })}
            ${look.collar !== 'none' ? this.swatches(t('dog.tag'), TAGS, look.tag, (c) => this.setPet((x) => (x.tag = c)), { none: () => this.setPet((x) => (x.tag = 'none')) }) : nothing}
            ${simple
              ? nothing
              : html`${this.swatches(t('dog.harness'), GEAR, look.harness, (c) => this.setPet((x) => (x.harness = c)), { none: () => this.setPet((x) => (x.harness = undefined)) })}
                ${this.swatches(t('dog.bandana'), GEAR, look.bandana, (c) => this.setPet((x) => (x.bandana = c)), { none: () => this.setPet((x) => (x.bandana = undefined)) })}`}
          </div>

          ${simple
            ? nothing
            : html`<div class="section-title">${t('dog.plan_detail')}</div>
          <div class="card">
            <div class="chips">
              ${([
                [false, t('dog.detail_normal')],
                [true, t('dog.detail_high')],
              ] as [boolean, string][]).map(([v, l]) => html`<button class="chip pressable" data-detail=${v ? 'high' : 'normal'} aria-pressed=${!!look.detail === v ? 'true' : 'false'} @click=${() => this.setPet((x) => (x.detail = v || undefined))}>${l}</button>`)}
            </div>
            <div class="hint-s">${t('dog.detail_hint')}</div>
          </div>`}
        </div>
      </div>
    `;
  }

  static override styles = [
    tokens,
    components,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--fp-bg);
        color: var(--fp-label);
        font-family: var(--fp-font);
      }
      .bar {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        padding: var(--fp-space-2) var(--fp-space-3);
        border-bottom: 1px solid var(--fp-separator);
        background: var(--fp-surface);
        flex: none;
      }
      .bar-title {
        flex: 1;
        text-align: center;
        font-size: var(--fp-text-headline);
        font-weight: var(--fp-weight-semibold);
      }
      .body {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .stage-wrap {
        flex: 1.35;
        min-width: 0;
        display: flex;
        flex-direction: column;
        position: relative;
        background: radial-gradient(ellipse at 50% 42%, var(--fp-surface) 0%, var(--fp-bg) 75%);
      }
      .stage {
        flex: 1;
        min-height: 0;
        position: relative;
        touch-action: none;
        cursor: grab;
      }
      .stage.paint {
        cursor: crosshair;
      }
      .stage.erase {
        cursor: cell;
      }
      .stage canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      .loading {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fp-label-2);
        font-size: var(--fp-text-subhead);
      }
      .tools {
        position: absolute;
        top: var(--fp-space-3);
        left: var(--fp-space-3);
        right: var(--fp-space-3);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--fp-space-2);
        pointer-events: none;
      }
      .tools > * {
        pointer-events: auto;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        padding: 0 var(--fp-space-4);
        border-radius: var(--fp-radius-full);
        background: var(--fp-surface);
        color: var(--fp-label);
        box-shadow: var(--fp-shadow-1);
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
      }
      .pill ha-icon {
        --mdc-icon-size: 18px;
      }
      .pill[aria-pressed='true'] {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .pill.round {
        width: 40px;
        padding: 0;
        justify-content: center;
        color: var(--fp-label-2);
      }
      .pose-row {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        flex-wrap: wrap;
      }
      .label-inline {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .brushbar .chip[aria-pressed='true'] {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .segmented {
        display: inline-flex;
        background: var(--fp-fill);
        border-radius: var(--fp-radius-full);
        padding: 3px;
        gap: 2px;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .segmented button {
        min-height: 38px;
        min-width: 44px;
        justify-content: center;
        padding: 0 var(--fp-space-3);
        border-radius: var(--fp-radius-full);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
      }
      .segmented button ha-icon {
        --mdc-icon-size: 18px;
      }
      .segmented button[aria-pressed='true'] {
        background: var(--fp-surface);
        color: var(--fp-label);
        box-shadow: var(--fp-shadow-1);
      }
      .dot {
        display: block;
        border-radius: 50%;
        background: currentColor;
      }
      .dot.s {
        width: 6px;
        height: 6px;
      }
      .dot.m {
        width: 11px;
        height: 11px;
      }
      .dot.l {
        width: 17px;
        height: 17px;
      }
      .brushbar {
        flex: none;
        padding: var(--fp-space-3);
        border-top: 1px solid var(--fp-separator);
        background: var(--fp-surface);
      }
      .brushbar .swatches {
        margin-bottom: var(--fp-space-2);
      }
      .brush-row {
        display: flex;
        gap: var(--fp-space-2);
        align-items: center;
        flex-wrap: wrap;
      }
      .panel {
        width: 360px;
        flex: none;
        overflow: auto;
        overscroll-behavior: contain;
        padding: var(--fp-space-2) var(--fp-space-4) var(--fp-space-6);
        border-left: 1px solid var(--fp-separator);
      }
      .section-title {
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        margin: var(--fp-space-5) var(--fp-space-2) var(--fp-space-2);
      }
      .card {
        background: var(--fp-surface);
        border-radius: var(--fp-radius-m);
        padding: var(--fp-space-3);
      }
      .label-row {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        margin: var(--fp-space-2) var(--fp-space-1) var(--fp-space-2);
      }
      .label-row:first-child {
        margin-top: 0;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
      }
      .panel > .chips .chip {
        background: var(--fp-surface);
      }
      .chips .chip[aria-pressed='true'] {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
        margin-bottom: var(--fp-space-2);
      }
      .swatch {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14);
        position: relative;
        cursor: pointer;
      }
      .swatch.sel::after {
        content: '';
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        box-shadow: 0 0 0 2.5px var(--fp-accent);
      }
      .swatch.custom {
        display: flex;
        align-items: center;
        justify-content: center;
        background: conic-gradient(#ff5f57, #febc2e, #28c840, #36a3ff, #b469ff, #ff5f57);
        overflow: hidden;
      }
      .swatch.custom input {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
      }
      .swatch.custom ha-icon,
      .swatch.none ha-icon {
        --mdc-icon-size: 18px;
        pointer-events: none;
      }
      .swatch.custom ha-icon {
        color: #fff;
      }
      .swatch.none {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-surface);
        color: var(--fp-label-2);
      }
      .hint-s {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        margin: var(--fp-space-2) var(--fp-space-1) 0;
        line-height: 1.35;
      }
      .chip ha-icon {
        --mdc-icon-size: 18px;
      }
      .btn[disabled] {
        opacity: 0.4;
        pointer-events: none;
      }
      @media (max-width: 760px) {
        .body {
          flex-direction: column;
        }
        .stage-wrap {
          flex: none;
          height: 48vh;
        }
        .panel {
          width: auto;
          flex: 1;
          border-left: none;
          border-top: 1px solid var(--fp-separator);
        }
      }
    `,
  ];
}

if (!customElements.get('fp-dog-editor')) customElements.define('fp-dog-editor', FpDogEditor);
