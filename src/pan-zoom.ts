import type { Bounds, HitTarget, Point, ViewTransform } from './types';
import { GESTURE, MOTION } from './design/tokens';
import { reducedMotion } from './a11y';

export interface GestureHandlers {
  hitTest(e: PointerEvent): HitTarget;
  hasDoubleTap(t: HitTarget): boolean;
  /** A (first) tap was recognised — immediate feedback before the double-tap wait */
  onTapDown?(t: HitTarget): void;
  onTap(t: HitTarget, world: Point): void;
  onDoubleTap(t: HitTarget, world: Point): void;
  onHold(t: HitTarget, world: Point): void;
  /** Return true to claim a one-finger drag (editor). Otherwise the drag pans the view. */
  onDragStart?(t: HitTarget, world: Point, e: PointerEvent): boolean;
  onDragMove?(world: Point, e: PointerEvent): void;
  onDragEnd?(world: Point, cancelled: boolean): void;
  onPress?(t: HitTarget | null): void;
  onHover?(world: Point | null): void;
  onViewChange?(v: ViewTransform, isDefault: boolean): void;
  /** Two-finger rotation / shift+wheel. delta in degrees relative to the gesture start. */
  /** exact: the angle was set in steps (Shift + wheel) and stays as it is, no snapping to the next quarter turn */
  onRotate?(phase: 'start' | 'move' | 'end', delta: number, exact?: boolean): void;
  /** View was reset (double tap / reset()) */
  onReset?(): void;
  /** Right-mouse drag: orbit the 3D camera (dx = rotate, dy = tilt) */
  onOrbit?(phase: 'start' | 'move' | 'end', dx: number, dy: number): void;
  /** Whether the right mouse button orbits right now (3D); otherwise it pans the view */
  canOrbit?(): boolean;
  /** Scrolling moves the floor focus (several floors, not editing): the wheel and a two-finger swipe up/down step
   * floors; Ctrl/⌘ + wheel and pinching zoom */
  floorScroll?(): boolean;
  /** One floor up (+1) or down (−1); false when there is none in that direction */
  onFloorStep?(dir: 1 | -1): boolean;
}

interface Ptr {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
  t0: number;
  type: string;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Pan/zoom + gesture recognition on a viewport element. The world element receives a
 * translate/scale transform (only transform is animated) and the CSS variable --fp-inv = 1/scale,
 * which overlays use to keep a constant on-screen size.
 */
export class PanZoom {
  view: ViewTransform = { s: 1, tx: 0, ty: 0 };
  private fit: ViewTransform = { s: 1, tx: 0, ty: 0 };
  private bounds: Bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 700 };
  private size = { w: 1, h: 1 };
  private ptrs = new Map<number, Ptr>();
  private mode: 'idle' | 'pending' | 'pan' | 'drag' | 'pinch' | 'orbit' = 'idle';
  private orbitStart?: { x: number; y: number };
  /** Optional 3D inverse projection (viewport px → plan coordinates on the floor plane) */
  unproject?: (x: number, y: number) => Point | undefined;
  /**
   * Optional 3D zoom: the view at scale `s` that keeps the floor point under (x, y) — or the given one — there.
   * Without it (2D) the view is a plain translate + scale and the point follows directly.
   */
  zoomAnchor?: (x: number, y: number, from: ViewTransform, s: number, at?: Point) => { view: ViewTransform; at: Point } | undefined;
  private target: HitTarget = { kind: 'background' };
  private holdTimer?: number;
  private holdFired = false;
  private tapTimer?: number;
  private lastTap?: { time: number; x: number; y: number; target: HitTarget };
  private pinch?: {
    d0: number;
    c0: Point;
    v0: ViewTransform;
    a0: number;
    rotating: boolean;
    at: Point;
    /** where both fingers started: a parallel swipe up/down steps floors (floorScroll), anything else zooms */
    p0: [Point, Point];
    kind?: 'pinch' | 'floor';
    stepped?: boolean;
  };
  /** Allow two-finger rotation (off in the editor) */
  rotatable = true;
  private panStart?: { x: number; y: number; v0: ViewTransform };
  private anim?: number;
  private settleTimer?: number;
  private ro: ResizeObserver;
  private userMoved = false;
  padding = 24;
  /** px on the right kept clear of the building when it would otherwise run under an overlay (floor slider) */
  insetRight = 0;
  /** px at the top kept clear of the building (a panel over the plan, e.g. who is on the way) */
  insetTop = 0;
  /** px at the bottom kept clear of the building (the "Etagen-Blick": another floor shown faintly below) */
  insetBottom = 0;
  enabled = true;

  constructor(
    private viewport: HTMLElement,
    private world: HTMLElement,
    private h: GestureHandlers,
  ) {
    viewport.addEventListener('pointerdown', this.down);
    viewport.addEventListener('pointermove', this.move);
    viewport.addEventListener('pointerup', this.up);
    viewport.addEventListener('pointercancel', this.cancel);
    viewport.addEventListener('pointerleave', this.leave);
    viewport.addEventListener('wheel', this.wheel, { passive: false });
    viewport.addEventListener('contextmenu', this.ctx);
    // Safari (macOS trackpad): pinching comes as its own gesture events, not as ctrl + wheel
    viewport.addEventListener('gesturestart', this.gesture as EventListener, { passive: false });
    viewport.addEventListener('gesturechange', this.gesture as EventListener, { passive: false });
    viewport.addEventListener('gestureend', this.gesture as EventListener, { passive: false });
    this.ro = new ResizeObserver(() => this.measure(false));
    this.ro.observe(viewport);
  }

  destroy() {
    const v = this.viewport;
    v.removeEventListener('pointerdown', this.down);
    v.removeEventListener('pointermove', this.move);
    v.removeEventListener('pointerup', this.up);
    v.removeEventListener('pointercancel', this.cancel);
    v.removeEventListener('pointerleave', this.leave);
    v.removeEventListener('wheel', this.wheel);
    v.removeEventListener('contextmenu', this.ctx);
    v.removeEventListener('gesturestart', this.gesture as EventListener);
    v.removeEventListener('gesturechange', this.gesture as EventListener);
    v.removeEventListener('gestureend', this.gesture as EventListener);
    this.ro.disconnect();
    clearTimeout(this.holdTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this.settleTimer);
    if (this.anim) cancelAnimationFrame(this.anim);
  }

  setInsetRight(px: number) {
    if (Math.abs(px - this.insetRight) < 1) return;
    this.insetRight = px;
    this.measure(false);
  }

  setInsetTop(px: number) {
    if (Math.abs(px - this.insetTop) < 1) return;
    this.insetTop = px;
    this.measure(false);
  }

  setInsetBottom(px: number) {
    if (Math.abs(px - this.insetBottom) < 1) return;
    this.insetBottom = px;
    this.measure(false);
  }

  setBounds(b: Bounds, resetView = false) {
    const same =
      b.minX === this.bounds.minX && b.minY === this.bounds.minY && b.maxX === this.bounds.maxX && b.maxY === this.bounds.maxY;
    this.bounds = b;
    if (!same || resetView) this.measure(resetView || !this.userMoved);
  }

  /** Screen (viewport-relative px) -> world coordinates (on the floor plane, also in 3D). */
  toWorld(x: number, y: number): Point {
    const p = this.unproject?.(x, y);
    if (p) return p;
    return [(x - this.view.tx) / this.view.s, (y - this.view.ty) / this.view.s];
  }

  clientToWorld(cx: number, cy: number): Point {
    const r = this.viewport.getBoundingClientRect();
    return this.toWorld(cx - r.left, cy - r.top);
  }

  get scale() {
    return this.view.s;
  }

  /** The view is being moved by hand right now (pinch, pan, wheel) — not by an animation or a refit */
  get gesturing() {
    return this.mode === 'pinch' || this.mode === 'pan' || performance.now() - this.lastWheel < 250;
  }
  private lastWheel = 0;

  get fitScale() {
    return this.fit.s;
  }

  get viewport_() {
    return this.viewport;
  }

  get isDefault() {
    const v = this.view;
    const f = this.fit;
    return Math.abs(v.s / f.s - 1) < 0.01 && Math.abs(v.tx - f.tx) < 2 && Math.abs(v.ty - f.ty) < 2;
  }

  reset(animate = true) {
    this.h.onReset?.();
    this.userMoved = false;
    this.computeFit();
    this.animateTo({ ...this.fit }, animate);
  }

  zoomBy(factor: number, cx?: number, cy?: number) {
    const x = cx ?? this.size.w / 2;
    const y = cy ?? this.size.h / 2;
    const s = this.clampScale(this.view.s * factor);
    this.userMoved = true;
    this.animateTo(this.clampPan(this.zoomAt(x, y, this.view, s).view), true);
  }

  /** The view at scale s in which the point under (x, y) — or `at` from an earlier call — stays at (x, y) */
  private zoomAt(x: number, y: number, from: ViewTransform, s: number, at?: Point): { view: ViewTransform; at: Point } {
    const r = this.zoomAnchor?.(x, y, from, s, at);
    if (r) return r;
    const q: Point = at ?? [(x - from.tx) / from.s, (y - from.ty) / from.s];
    return { view: { s, tx: x - q[0] * s, ty: y - q[1] * s }, at: q };
  }

  /**
   * Mouse wheel: the notches set a target zoom, the view glides there (no jumps); the point under the pointer
   * stays where it is. Further notches while gliding extend the target.
   */
  private glide?: { target: number; x: number; y: number; at?: Point; raf: number; last: number };
  private glideZoom(x: number, y: number, factor: number) {
    const g = this.glide;
    const target = this.clampScale((g ? g.target : this.view.s) * factor);
    if (g && Math.hypot(g.x - x, g.y - y) < 6) {
      g.target = target;
      return;
    }
    this.stopGlide();
    const next = { target, x, y, at: undefined as Point | undefined, raf: 0, last: performance.now() };
    this.glide = next;
    this.active(true);
    const step = (now: number) => {
      if (this.glide !== next) return;
      const dt = Math.min(64, Math.max(1, now - next.last));
      next.last = now;
      const l0 = Math.log(this.view.s);
      const l1 = Math.log(next.target);
      const done = Math.abs(l1 - l0) < 0.003;
      const s = done ? next.target : Math.exp(l0 + (l1 - l0) * (1 - Math.exp(-dt / 75)));
      const r = this.zoomAt(next.x, next.y, this.view, s, next.at);
      next.at = r.at;
      this.lastWheel = now;
      this.apply(this.clampPan(r.view));
      if (done) {
        this.glide = undefined;
        this.active(false);
      } else next.raf = requestAnimationFrame(step);
    };
    next.raf = requestAnimationFrame(step);
  }

  private stopGlide() {
    if (!this.glide) return;
    cancelAnimationFrame(this.glide.raf);
    this.glide = undefined;
  }

  /** trackpad pinch: the anchor point is kept for the whole gesture (until the pointer moves) */
  private pinchAt?: { x: number; y: number; at: Point; t: number };

  /** refit: snap to the fitted view; otherwise keep the user's view (center preserved on resize). */
  private measure(refit = false) {
    const r = this.viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const changed = r.width !== this.size.w || r.height !== this.size.h;
    const prev = this.size;
    this.size = { w: r.width, h: r.height };
    if (changed && this.userMoved && !refit) {
      // Keep the world point at the viewport center where it was (e.g. when a side panel opens).
      this.view = { ...this.view, tx: this.view.tx + (r.width - prev.w) / 2, ty: this.view.ty + (r.height - prev.h) / 2 };
    }
    this.computeFit();
    // Never move the view under an active gesture (e.g. a side panel opening while dragging)
    if (this.mode !== 'idle' && this.mode !== 'pending') {
      this.view = { ...this.view, tx: this.view.tx - (changed && this.userMoved ? (r.width - prev.w) / 2 : 0), ty: this.view.ty - (changed && this.userMoved ? (r.height - prev.h) / 2 : 0) };
      return;
    }
    if (refit || !this.userMoved) this.apply({ ...this.fit });
    else if (changed) this.apply(this.clampPan(this.view));
  }

  /**
   * Zoom so that a screen rectangle (viewport-relative px) fills the view, keeping its content
   * under the same world point. Used to focus a room.
   */
  focusRect(r: { x: number; y: number; w: number; h: number }, margin = 0.84, top = 0) {
    const v = this.view;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const k = Math.min((this.size.w * margin) / Math.max(1, r.w), ((this.size.h - 110 - top) * margin) / Math.max(1, r.h));
    const s = Math.max(this.fit.s * 0.6, Math.min(this.fit.s * 8, v.s * k));
    const q: Point = [(cx - v.tx) / v.s, (cy - v.ty) / v.s];
    this.userMoved = true;
    this.animateTo({ s, tx: this.size.w / 2 - q[0] * s, ty: this.size.h / 2 + 10 + top / 2 - q[1] * s }, true);
  }

  private computeFit() {
    const { w, h } = this.size;
    const b = this.bounds;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const pad = Math.min(this.padding, w / 8, h / 8);
    let s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    let left = (w - bw * s) / 2;
    // an overlay on the right: only where the centred building would run under it, move it left (and only then shrink it)
    const ins = Math.min(this.insetRight, w / 4);
    if (ins > pad && left < ins) {
      s = Math.min(s, (w - pad - ins) / bw);
      const free = w - bw * s;
      left = Math.max(pad, Math.min(free / 2, free - ins));
    }
    // a panel at the top: only where the centred building would run under it, move it down (and only then shrink it)
    let top = (h - bh * s) / 2;
    const insT = Math.min(this.insetTop, h / 3);
    if (insT > pad && top < insT) {
      const s2 = Math.min(s, (h - pad - insT) / bh);
      if (s2 < s) {
        s = s2;
        left = this.insetRight > pad ? left : (w - bw * s) / 2;
      }
      const free = h - bh * s;
      top = Math.max(pad, Math.min(Math.max(free / 2, insT), free - pad));
    }
    // a panel at the bottom (another floor peeking in): the same, upwards
    const insB = Math.min(this.insetBottom, h / 3);
    if (insB > pad && top + bh * s > h - insB) {
      const topMin = insT > pad ? insT : pad;
      const s2 = Math.min(s, (h - insB - topMin) / bh);
      if (s2 < s) {
        s = s2;
        left = this.insetRight > pad ? left : (w - bw * s) / 2;
      }
      top = Math.max(topMin, Math.min((h - bh * s) / 2, h - insB - bh * s));
    }
    this.fit = { s, tx: left - b.minX * s, ty: top - b.minY * s };
  }

  private clampScale(s: number) {
    return Math.max(this.fit.s * 0.6, Math.min(this.fit.s * 8, s));
  }

  private clampPan(v: ViewTransform): ViewTransform {
    const b = this.bounds;
    const cw = (b.maxX - b.minX) * v.s;
    const ch = (b.maxY - b.minY) * v.s;
    const mx = Math.min(this.size.w * 0.35, cw * 0.5);
    const my = Math.min(this.size.h * 0.35, ch * 0.5);
    const left = v.tx + b.minX * v.s;
    const top = v.ty + b.minY * v.s;
    let tx = v.tx;
    let ty = v.ty;
    if (left > this.size.w - mx) tx -= left - (this.size.w - mx);
    if (left + cw < mx) tx += mx - (left + cw);
    if (top > this.size.h - my) ty -= top - (this.size.h - my);
    if (top + ch < my) ty += my - (top + ch);
    return { s: v.s, tx, ty };
  }

  /** A gesture or view animation is in progress */
  get busy(): boolean {
    return this.mode !== 'idle' || !!this.anim;
  }

  /** Further layers that move with the world (labels above the WebGL canvas) */
  mirrors: HTMLElement[] = [];

  /** The plan layer only needs the scale variables while editing (handles); elsewhere only the overlays use them */
  scaleVarsOnWorld = true;

  private apply(v: ViewTransform) {
    if (this.applyRaf) {
      cancelAnimationFrame(this.applyRaf);
      this.applyRaf = 0;
    }
    this.view = v;
    const tr = `translate3d(${v.tx}px, ${v.ty}px, 0) scale(${v.s})`;
    const inv = String(1 / v.s);
    const sc = String(v.s);
    this.world.style.transform = tr;
    if (this.scaleVarsOnWorld) {
      this.world.style.setProperty('--fp-inv', inv);
      this.world.style.setProperty('--fp-scale', sc);
    }
    for (const w of this.mirrors) {
      w.style.transform = tr;
      w.style.setProperty('--fp-inv', inv);
      w.style.setProperty('--fp-scale', sc);
    }
    this.h.onViewChange?.(v, this.isDefault);
  }

  /**
   * Gestures: pointer and wheel events can arrive several times per frame (touch screens often sample at
   * 120 Hz) — the view follows immediately, but the page is updated once per frame.
   */
  private applyRaf = 0;
  private applySoon(v: ViewTransform) {
    this.view = v;
    if (this.applyRaf) return;
    this.applyRaf = requestAnimationFrame(() => {
      this.applyRaf = 0;
      this.apply(this.view);
    });
  }

  private animateTo(target: ViewTransform, animate: boolean) {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.stopGlide();
    if (!animate || reducedMotion()) return this.apply(target);
    const from = { ...this.view };
    const t0 = performance.now();
    this.active(true);
    const step = (now: number) => {
      const k = easeOut(Math.min(1, (now - t0) / MOTION.slow));
      this.apply({
        s: from.s + (target.s - from.s) * k,
        tx: from.tx + (target.tx - from.tx) * k,
        ty: from.ty + (target.ty - from.ty) * k,
      });
      if (k < 1) this.anim = requestAnimationFrame(step);
      else {
        this.anim = undefined;
        this.active(false);
      }
    };
    this.anim = requestAnimationFrame(step);
  }

  /** will-change only while moving, so the plan re-rasterizes crisply afterwards. */
  private active(on: boolean) {
    clearTimeout(this.settleTimer);
    const all = [this.world, ...this.mirrors];
    if (on) for (const w of all) w.style.willChange = 'transform';
    else this.settleTimer = window.setTimeout(() => all.forEach((w) => (w.style.willChange = '')), 120);
  }

  private local(e: PointerEvent | WheelEvent): Point {
    const r = this.viewport.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private ctx = (e: Event) => e.preventDefault();

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.stopGlide();
    // middle button, or the right one where nothing orbits (2D): move the view, whatever is under the pointer
    if (e.pointerType === 'mouse' && this.ptrs.size === 0 && (e.button === 1 || (e.button === 2 && (!this.h.onOrbit || this.h.canOrbit?.() === false)))) {
      e.preventDefault();
      const [x, y] = this.local(e);
      this.ptrs.set(e.pointerId, { id: e.pointerId, x, y, x0: x, y0: y, t0: performance.now(), type: 'mouse' });
      try {
        this.viewport.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (this.anim) {
        cancelAnimationFrame(this.anim);
        this.anim = undefined;
      }
      this.mode = 'pan';
      this.panStart = { x, y, v0: { ...this.view } };
      this.active(true);
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 2 && this.h.onOrbit && this.ptrs.size === 0) {
      const [x, y] = this.local(e);
      this.mode = 'orbit';
      this.orbitStart = { x, y };
      this.ptrs.set(e.pointerId, { id: e.pointerId, x, y, x0: x, y0: y, t0: performance.now(), type: 'mouse' });
      try {
        this.viewport.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.h.onOrbit('start', 0, 0);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [x, y] = this.local(e);
    this.ptrs.set(e.pointerId, { id: e.pointerId, x, y, x0: x, y0: y, t0: performance.now(), type: e.pointerType });
    try {
      this.viewport.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.anim) {
      cancelAnimationFrame(this.anim);
      this.anim = undefined;
    }
    if (this.ptrs.size === 1) {
      this.target = this.h.hitTest(e);
      this.mode = 'pending';
      this.holdFired = false;
      this.h.onPress?.(this.target);
      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        if (this.mode !== 'pending') return;
        this.holdFired = true;
        this.h.onPress?.(null);
        this.h.onHold(this.target, this.toWorld(x, y));
      }, GESTURE.holdMs);
    } else if (this.ptrs.size === 2) {
      clearTimeout(this.holdTimer);
      this.h.onPress?.(null);
      if (this.mode === 'drag') this.h.onDragEnd?.(this.toWorld(x, y), true);
      const [a, b] = [...this.ptrs.values()];
      this.mode = 'pinch';
      const c0: Point = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.pinch = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        c0,
        v0: { ...this.view },
        a0: Math.atan2(b.y - a.y, b.x - a.x),
        rotating: false,
        at: this.zoomAt(c0[0], c0[1], this.view, this.view.s).at,
        p0: [
          [a.x, a.y],
          [b.x, b.y],
        ],
        kind: this.h.floorScroll?.() ? undefined : 'pinch',
      };
      this.active(true);
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && this.ptrs.size === 0) this.h.onHover?.(this.toWorld(...this.local(e)));
      return;
    }
    [p.x, p.y] = this.local(e);
    if (this.mode === 'orbit' && this.orbitStart) {
      this.h.onOrbit?.('move', p.x - this.orbitStart.x, p.y - this.orbitStart.y);
      return;
    }
    if (this.mode === 'pinch' && this.pinch && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch.kind !== 'pinch') {
        // several floors: decide early whether the two fingers swipe together up/down (floor) or pinch/turn (zoom)
        const [[ax, ay], [bx, by]] = this.pinch.p0;
        const da: Point = [a.x - ax, a.y - ay];
        const db: Point = [b.x - bx, b.y - by];
        const la = Math.hypot(...da);
        const lb = Math.hypot(...db);
        const dy = (da[1] + db[1]) / 2;
        const dx = (da[0] + db[0]) / 2;
        if (!this.pinch.kind) {
          if ((la + lb) / 2 < 14) return;
          const parallel = la > 4 && lb > 4 && (da[0] * db[0] + da[1] * db[1]) / (la * lb) > 0.8;
          const turn = Math.abs((((Math.atan2(b.y - a.y, b.x - a.x) - this.pinch.a0) * 180) / Math.PI + 540) % 360 - 180);
          this.pinch.kind = parallel && Math.abs(dy) > 1.5 * Math.abs(dx) && Math.abs(d / this.pinch.d0 - 1) < 0.15 && turn < 10 ? 'floor' : 'pinch';
        }
        if (this.pinch.kind === 'floor') {
          // fingers down pull the stack down: the floor above comes into focus (one step per swipe)
          if (!this.pinch.stepped && Math.abs(dy) >= 60) {
            this.pinch.stepped = true;
            this.h.onFloorStep?.(dy > 0 ? 1 : -1);
          }
          return;
        }
      }
      const c: Point = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const { d0, v0 } = this.pinch;
      const s = this.clampScale(v0.s * (d / d0));
      this.userMoved = true;
      // the point between the fingers stays between them (also in 3D, where the perspective follows the zoom)
      this.applySoon(this.clampPan(this.zoomAt(c[0], c[1], this.view, s, this.pinch.at).view));
      if (this.rotatable && this.h.onRotate) {
        let delta = ((Math.atan2(b.y - a.y, b.x - a.x) - this.pinch.a0) * 180) / Math.PI;
        delta = ((delta + 540) % 360) - 180;
        // A small dead zone keeps pure pinch-zooms from rotating
        if (!this.pinch.rotating && Math.abs(delta) > 10) {
          this.pinch.rotating = true;
          this.pinch.a0 += (Math.sign(delta) * 10 * Math.PI) / 180;
          this.h.onRotate('start', 0);
          delta -= Math.sign(delta) * 10;
        }
        if (this.pinch.rotating) this.h.onRotate('move', delta);
      }
      return;
    }
    if (this.mode === 'pending') {
      const slop = p.type === 'mouse' ? GESTURE.slopMouse : GESTURE.slopTouch;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) < slop) return;
      clearTimeout(this.holdTimer);
      this.h.onPress?.(null);
      if (this.holdFired) {
        this.mode = 'idle';
        return;
      }
      if (this.h.onDragStart?.(this.target, this.toWorld(p.x0, p.y0), e)) this.mode = 'drag';
      else {
        this.mode = 'pan';
        this.panStart = { x: p.x0, y: p.y0, v0: { ...this.view } };
        this.active(true);
      }
    }
    if (this.mode === 'drag') this.h.onDragMove?.(this.toWorld(p.x, p.y), e);
    else if (this.mode === 'pan' && this.panStart) {
      const { x, y, v0 } = this.panStart;
      this.userMoved = true;
      this.applySoon(this.clampPan({ s: v0.s, tx: v0.tx + (p.x - x), ty: v0.ty + (p.y - y) }));
    }
  };

  private up = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (this.mode === 'orbit') {
      this.h.onOrbit?.('end', 0, 0);
      this.mode = 'idle';
      this.orbitStart = undefined;
      this.swallowClick(e.clientX, e.clientY);
      return;
    }
    const world = this.toWorld(p.x, p.y);
    if (this.mode === 'pinch') {
      if (this.ptrs.size === 1) {
        // Continue as pan with the remaining finger.
        const r = [...this.ptrs.values()][0];
        if (this.pinch?.rotating) this.h.onRotate?.('end', 0);
        this.mode = 'pan';
        this.panStart = { x: r.x, y: r.y, v0: { ...this.view } };
      } else if (this.ptrs.size === 0) this.finish();
      return;
    }
    if (this.ptrs.size > 0) return;
    this.swallowClick(e.clientX, e.clientY);
    if (this.mode === 'drag') this.h.onDragEnd?.(world, false);
    else if (this.mode === 'pending' && !this.holdFired) {
      this.h.onPress?.(null);
      this.handleTap(this.target, p.x, p.y);
    }
    this.finish();
  };

  private cancel = (e: PointerEvent) => {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    this.h.onPress?.(null);
    if (this.mode === 'drag') this.h.onDragEnd?.(this.toWorld(0, 0), true);
    if (this.ptrs.size === 0) this.finish();
  };

  private leave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && this.ptrs.size === 0) this.h.onHover?.(null);
  };

  /**
   * Browsers synthesize a click after the pointer gesture. A tap may have just opened a popup under
   * the finger, so that click must not reach it (it could close the popup or press a button).
   */
  private swallowClick(x: number, y: number) {
    const stop = (e: MouseEvent) => {
      // Only the synthesized click at the gesture's end position; real clicks elsewhere pass.
      if (Math.hypot(e.clientX - x, e.clientY - y) > 30) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', stop, true);
    window.setTimeout(() => window.removeEventListener('click', stop, true), 350);
  }

  private finish() {
    if (this.pinch?.rotating) this.h.onRotate?.('end', 0);
    this.mode = 'idle';
    this.pinch = undefined;
    this.panStart = undefined;
    this.active(false);
  }

  /** When zoomed in, a double tap anywhere (without own double-tap action) resets the view. */
  zoomedDoubleTapReset = true;

  private handleTap(target: HitTarget, x: number, y: number) {
    const now = performance.now();
    const world = this.toWorld(x, y);
    const last = this.lastTap;
    const configured = target.kind !== 'background' && this.h.hasDoubleTap(target);
    const zoomed = this.zoomedDoubleTapReset && !this.isDefault;
    const wantsDouble = target.kind === 'background' || configured || zoomed;
    const isSecond =
      last && now - last.time < GESTURE.doubleTapMs + 60 && Math.hypot(last.x - x, last.y - y) < 40 && sameTarget(last.target, target);
    if (isSecond && wantsDouble) {
      clearTimeout(this.tapTimer);
      this.tapTimer = undefined;
      this.lastTap = undefined;
      if (configured) this.h.onDoubleTap(target, world);
      else this.reset();
      return;
    }
    this.lastTap = { time: now, x, y, target };
    this.h.onTapDown?.(target);
    if (target.kind !== 'background' && (configured || zoomed)) {
      // Wait to disambiguate from a double tap (only when one is configured or the view is zoomed).
      clearTimeout(this.tapTimer);
      this.tapTimer = window.setTimeout(() => {
        this.tapTimer = undefined;
        this.h.onTap(target, world);
      }, GESTURE.doubleTapMs);
    } else this.h.onTap(target, world);
  }

  /** Last time a trackpad scroll was seen: its momentum events are trackpad, too */
  private trackpadAt = 0;

  /** Trackpad or mouse wheel? Chrome/Safari report wheelDeltaY = −3 × deltaY for trackpads (a mouse wheel moves
   * in steps of 120); elsewhere: fine pixel steps or a sideways part */
  private isTrackpad(e: WheelEvent): boolean {
    const now = performance.now();
    const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
    let pad: boolean;
    if (e.deltaMode !== 0) pad = false;
    else if (wd !== undefined && wd !== 0) pad = wd === -3 * e.deltaY || (Math.abs(wd) % 120 !== 0 && Math.abs(e.deltaY) < 50);
    else pad = e.deltaX !== 0 || Math.abs(e.deltaY) < 40;
    if (!pad && now - this.trackpadAt < 300 && Math.abs(e.deltaY) < 60) pad = true;
    if (pad) this.trackpadAt = now;
    return pad;
  }

  private wheelRot = 0;
  private wheelRotTimer?: number;

  /**
   * Safari's trackpad pinch (GestureEvent: scale relative to the gesture start, position of the fingers):
   * the point between the fingers stays where it is. On touch screens the pointer events do the pinch; there
   * the gesture events only have to be kept from zooming the page.
   */
  private safariPinch?: { v0: ViewTransform; x: number; y: number; at: Point };
  private gesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
    e.preventDefault();
    if (!this.enabled || this.ptrs.size > 0) return;
    if (e.type === 'gestureend') {
      if (this.safariPinch) {
        this.safariPinch = undefined;
        this.active(false);
      }
      return;
    }
    const r = this.viewport.getBoundingClientRect();
    if (e.type === 'gesturestart' || !this.safariPinch) {
      this.stopGlide();
      if (this.anim) {
        cancelAnimationFrame(this.anim);
        this.anim = undefined;
      }
      const x = (e.clientX ?? r.left + r.width / 2) - r.left;
      const y = (e.clientY ?? r.top + r.height / 2) - r.top;
      this.safariPinch = { v0: { ...this.view }, x, y, at: this.zoomAt(x, y, this.view, this.view.s).at };
      this.active(true);
      if (e.type === 'gesturestart') return;
    }
    const g = this.safariPinch;
    const scale = e.scale && isFinite(e.scale) && e.scale > 0 ? e.scale : 1;
    const s = this.clampScale(g.v0.s * scale);
    this.userMoved = true;
    this.lastWheel = performance.now();
    this.applySoon(this.clampPan(this.zoomAt(g.x, g.y, this.view, s, g.at).view));
  };

  /** Wheel → floor steps: what a swing has gathered, the time a step locks the next, and whether this swing stepped */
  private floorAcc = 0;
  private floorLockUntil = 0;
  private floorSwing = false;
  private floorQuiet?: number;

  /**
   * Scrolling over the plan with several floors moves the floor focus: one notch (or about 120 px of a trackpad swing)
   * is one floor, wheel up = the floor above. A swing (trackpad momentum, a fast spin) is one step, not all floors.
   * A trackpad's sideways swipe still moves the view.
   */
  private floorWheel(e: WheelEvent) {
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.h : 1);
    const trackpad = this.isTrackpad(e);
    if (trackpad && Math.abs(e.deltaX) > Math.abs(dy)) {
      this.stopGlide();
      this.userMoved = true;
      this.active(true);
      this.applySoon(this.clampPan({ s: this.view.s, tx: this.view.tx - e.deltaX, ty: this.view.ty }));
      this.active(false);
      return;
    }
    clearTimeout(this.floorQuiet);
    this.floorQuiet = window.setTimeout(() => {
      this.floorAcc = 0;
      this.floorSwing = false;
    }, 220);
    const now = performance.now();
    if (now < this.floorLockUntil || this.floorSwing) return;
    this.floorAcc += dy;
    if (Math.abs(this.floorAcc) < (trackpad ? 120 : 40)) return;
    const dir: 1 | -1 = this.floorAcc < 0 ? 1 : -1;
    this.floorAcc = 0;
    this.floorLockUntil = now + 450;
    if (trackpad) this.floorSwing = true;
    this.h.onFloorStep?.(dir);
  }

  private wheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.lastWheel = performance.now();
    // several floors: scrolling steps floors, Ctrl/⌘ + wheel (and a trackpad pinch, sent as ctrl + wheel) zooms
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && this.h.floorScroll?.()) {
      this.floorWheel(e);
      return;
    }
    if (e.shiftKey && this.rotatable && this.h.onRotate) {
      // Shift + wheel rotates
      if (!this.wheelRotTimer) {
        this.wheelRot = 0;
        this.h.onRotate('start', 0);
      }
      this.wheelRot += (e.deltaY || e.deltaX) > 0 ? 5 : -5;
      this.h.onRotate('move', this.wheelRot);
      clearTimeout(this.wheelRotTimer);
      this.wheelRotTimer = window.setTimeout(() => {
        this.wheelRotTimer = undefined;
        // one notch at a time must turn too: 5° steps are not snapped back to the quarter turn they started from
        this.h.onRotate?.('end', 0, true);
      }, 300);
      return;
    }
    // trackpad: two fingers move the view, pinching (sent as ctrl + wheel) zooms. A mouse wheel zooms.
    if (!e.ctrlKey && !e.metaKey && this.isTrackpad(e)) {
      this.stopGlide();
      this.pinchAt = undefined;
      this.userMoved = true;
      this.active(true);
      this.applySoon(this.clampPan({ s: this.view.s, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY }));
      this.active(false);
      return;
    }
    const [x, y] = this.local(e);
    // lines / pages (some mice) → pixels
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.h : 1);
    this.userMoved = true;
    if (!e.ctrlKey) {
      this.pinchAt = undefined;
      this.glideZoom(x, y, Math.exp(-Math.max(-240, Math.min(240, dy)) * 0.002));
      return;
    }
    // trackpad pinch: many small steps, followed directly; the anchor stays for the gesture
    if (this.safariPinch) return;
    this.stopGlide();
    const now = performance.now();
    const pa = this.pinchAt && now - this.pinchAt.t < 220 && Math.hypot(this.pinchAt.x - x, this.pinchAt.y - y) < 6 ? this.pinchAt : undefined;
    const s = this.clampScale(this.view.s * Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.01));
    const r = this.zoomAt(x, y, this.view, s, pa?.at);
    this.pinchAt = { x, y, at: r.at, t: now };
    this.active(true);
    this.applySoon(this.clampPan(r.view));
    this.active(false);
  };
}

function sameTarget(a: HitTarget, b: HitTarget) {
  return a.kind === b.kind && a.id === b.id;
}
