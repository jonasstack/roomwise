import { html, nothing, svg, type TemplateResult } from 'lit';
import type { FloorConfig, FurnitureConfig, HassEntity, Point, RoomConfig } from './types';
import type { SunInfo } from './ambient';
import { wallBody, wallPieces, windowInward, type WallPiece } from './walls';
import { DOOR_OPEN_DEG, SASH_OPEN_DEG, coverLive, garageDepth, openingGeometry, openingState, windowOpenSign, windowSashes } from './openings';
import { drawFurniture, fridgeList, resolveFurniture } from './furniture';
import { furnitureParts, setDetail, type Part } from './furniture3d';
import { furnitureFx } from './furniture-fx';
import { tone } from './colors';
import { pointInPolygon, pointsToPath, round } from './geometry';

/** Light direction (towards the light, plan coords) for face shading: the sun, or a soft top-left key light. */
export function keyLight(sun?: SunInfo): { dir: Point; strength: number; tint?: boolean } {
  if (sun?.up) return { dir: sun.dir, strength: 0.35 + 0.65 * sun.strength, tint: true };
  const d = Math.hypot(0.55, 0.85);
  return { dir: [-0.55 / d, -0.85 / d], strength: sun && sun.phase === 'night' ? 0.25 : 0.45 };
}

/** Face color: shaded by its angle to the light; sunlit faces take the light's color, the others a colored shadow. */
function lit(color: string, n: Point, light: { dir: Point; strength: number; tint?: boolean }) {
  const base = mix(color, faceShade(n, light));
  if (!light.tint) return base;
  const lambert = Math.max(0, n[0] * light.dir[0] + n[1] * light.dir[1]);
  if (lambert > 0.05) return `color-mix(in srgb, ${base} ${100 - Math.round(lambert * 34 * light.strength)}%, var(--fp-sun-tint, #fff))`;
  return `color-mix(in srgb, ${base} 90%, var(--fp-shadow-tint, #000))`;
}

/** Darkness (0..40 %) of a vertical face with outward normal n. */
function faceShade(n: Point, light: { dir: Point; strength: number }) {
  const lambert = Math.max(0, n[0] * light.dir[0] + n[1] * light.dir[1]);
  return Math.round(20 - 18 * lambert * light.strength);
}

/** A token name (--fp-…) or any CSS color, shaded towards black by `dark` percent. */
const mix = (color: string, dark: number) =>
  `color-mix(in srgb, ${color.startsWith('--') ? `var(${color})` : color} ${100 - dark}%, black)`;

import { paint } from './colors';
export { paint };

export interface Box {
  len: number;
  depth: number;
  height: number;
  z?: number;
  side: string;
  top?: string;
  angle: number; // degrees, direction of len axis
  light: { dir: Point; strength: number };
  cls?: string;
  topContent?: TemplateResult;
  caps?: boolean;
  /** Override colors of the face towards local +y / −y */
  frontColor?: string;
  backColor?: string;
  /** Rounded top face (px) */
  radius?: number;
}

/**
 * Direction towards the camera (plan coords) while rendering; faces clearly turned away from it are
 * not created at all (back-face culling: far fewer composited layers). Undefined = keep every face.
 */
let VIEW: Point | undefined;
const CULL = -0.35;
const seen = (n: Point) => !VIEW || n[0] * VIEW[0] + n[1] * VIEW[1] > CULL;

function setView(o: { spin?: number; cull?: boolean }) {
  const sp = ((o.spin ?? 0) * Math.PI) / 180;
  VIEW = o.cull ? [Math.sin(sp), Math.cos(sp)] : undefined;
}

/** A box built from CSS faces: top + two long sides (+ optional end caps). Origin at its center on the floor. */
export function box(b: Box): TemplateResult {
  const a = (b.angle * Math.PI) / 180;
  const nFront: Point = [-Math.sin(a), Math.cos(a)];
  const nBack: Point = [Math.sin(a), -Math.cos(a)];
  const nEnd: Point = [Math.cos(a), Math.sin(a)];
  const nStart: Point = [-Math.cos(a), -Math.sin(a)];
  const z = b.z ?? 0;
  const L = round(b.len);
  const D = round(b.depth);
  const H = round(b.height);
  // see-through faces keep their back sides
  const all = !VIEW || /faded|glass|hitbox|lowered/.test(b.cls ?? '');
  const show = (n: Point) => all || seen(n);
  return html`<div class="b3 ${b.cls ?? ''}" style=${`transform:rotate(${round(b.angle, 3)}deg) translateZ(${z}px)`}>
    <div class="f top" style=${`width:${L}px;height:${D}px;left:${-L / 2}px;top:${-D / 2}px;transform:translateZ(${H}px);background:${b.top ?? mix(b.side, 0)}${b.radius ? `;border-radius:${round(Math.min(b.radius, L / 2, D / 2))}px` : ''}`}>
      ${b.topContent ?? nothing}
    </div>
    ${show(nFront)
      ? html`<div class="f" style=${`width:${L}px;height:${H}px;left:${-L / 2}px;top:${D / 2}px;transform-origin:50% 0;transform:rotateX(90deg);background:${lit(b.frontColor ?? b.side, nFront, b.light)}`}></div>`
      : nothing}
    ${show(nBack)
      ? html`<div class="f" style=${`width:${L}px;height:${H}px;left:${-L / 2}px;top:${-D / 2}px;transform-origin:50% 0;transform:rotateX(90deg);background:${lit(b.backColor ?? b.side, nBack, b.light)}`}></div>`
      : nothing}
    ${b.caps !== false && show(nEnd)
      ? html`<div class="f" style=${`width:${H}px;height:${D}px;left:${L / 2}px;top:${-D / 2}px;transform-origin:0 50%;transform:rotateY(-90deg);background:${lit(b.side, nEnd, b.light)}`}></div>`
      : nothing}
    ${b.caps !== false && show(nStart)
      ? html`<div class="f" style=${`width:${H}px;height:${D}px;left:${-L / 2 - H}px;top:${-D / 2}px;transform-origin:100% 50%;transform:rotateY(90deg);background:${lit(b.side, nStart, b.light)}`}></div>`
      : nothing}
  </div>`;
}

function at(p: Point) {
  return `left:${round(p[0])}px;top:${round(p[1])}px`;
}

export interface Plan3DOptions {
  floor?: FloorConfig;
  /** Exterior wall paint */
  wallColor?: string;
  /** View rotation (deg): walls facing the camera turn translucent */
  spin?: number;
  /** Full room height: interior walls that hide rooms turn translucent too */
  full?: boolean;
  /** Room zoomed onto: its walls between camera and room slide down (dollhouse view) */
  focus?: RoomConfig;
  /** Height of the rearmost exterior walls (nothing behind them from the current view) */
  backHeight?: number;
  /** Front door warning: windows that blink red */
  alert?: Set<string>;
  /** Skip faces turned away from the camera (off while the view rotates) */
  cull?: boolean;
  /** Level of detail: slice thickness (cm) for round bodies — coarser while the plan is small on screen */
  detail?: number;
  wall: number;
  height: number;
  sun?: SunInfo;
  getState: (id: string) => HassEntity | undefined;
}

export function renderWalls3d(floor: FloorConfig, o: Plan3DOptions): TemplateResult {
  o = { ...o, floor };
  setView(o);
  const light = keyLight(o.sun);
  const pieces = wallPieces(floor);
  const items = pieces.map((p) => renderPiece(p, o, light));
  return html`${items}`;
}

/** Opening heights as fractions of the wall height (≈ 250 cm room: parapet 65, window top 225, door 215). */
export const WINDOW_SILL = 0.26;
export const WINDOW_TOP = 0.9;
export const DOOR_TOP = 0.86;

function renderPiece(p: WallPiece, o: Plan3DOptions, light: { dir: Point; strength: number }) {
  const dx = p.b[0] - p.a[0];
  const dy = p.b[1] - p.a[1];
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const mid: Point = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
  // Exterior walls facing the viewer keep their height but turn translucent, so they never hide rooms.
  const sp = ((o.spin ?? 0) * Math.PI) / 180;
  // Screen-space "towards the viewer" component of a plan direction
  const facing = (n: Point) => n[0] * Math.sin(sp) + n[1] * Math.cos(sp);
  const segN: Point = [-dy / (len || 1), dx / (len || 1)];
  const touchesFocus = !!o.focus && (p.front === o.focus || p.back === o.focus);
  const towardsViewer = touchesFocus
    ? false // the focused room's own walls: front ones slide down (below), back and side walls stay solid
    : p.outward
      ? facing(p.outward) > 0.5
      : !!o.full && Math.abs(facing(segN)) > 0.5; // full height: interior walls across the view hide the room behind
  // Rearmost walls (exterior, facing away from the camera) may be taller than the cut-away walls
  const isBack = !!p.outward && facing(p.outward) < -0.3;
  const H = isBack && o.backHeight && o.backHeight > o.height ? o.backHeight : o.height;
  // Focused room: the walls between the camera and the room slide down (animated via scaleZ)
  let lowered = false;
  if (o.focus && (p.front === o.focus || p.back === o.focus)) {
    const nIn: Point = p.front === o.focus ? segN : [-segN[0], -segN[1]];
    lowered = facing(nIn) < -0.3;
  }
  const other = !!o.focus && p.front !== o.focus && p.back !== o.focus;
  const fade = (lowered ? 'lowered' : towardsViewer ? 'faded' : '') + (other ? ' faint' : '');
  // Paint per side: the room's wall color, exterior paint, or the neutral wall token
  const sideColor = (room?: { wall_color?: string }) =>
    room ? (room.wall_color ? paint(room.wall_color) : undefined) : o.wallColor ? paint(o.wallColor) : undefined;
  const colors = { frontColor: sideColor(p.front), backColor: sideColor(p.back) };
  const wallBox = (height: number, z = 0, l = len, caps = false) =>
    box({ len: l, depth: o.wall, height, z, side: '--fp-wall-side', top: 'var(--fp-wall-top)', angle, light, caps, cls: fade, ...colors });
  if (p.kind === 'wall') {
    const body = wallBody(p, o.wall);
    return html`<div class="p3 wallp ${fade}" style=${at(body.mid)}>${wallBox(H, 0, body.len, true)}</div>`;
  }
  const st = openingState(p.opening?.entity ? o.getState(p.opening.entity) : undefined);
  if (p.kind === 'window') {
    const win = p.opening!;
    // Real proportions: parapet ~25 %, glass up to ~90 %, lintel above
    const sill = H * WINDOW_SILL;
    const top = H * WINDOW_TOP;
    // Panes open inwards (into the building)
    const wlen = Math.hypot(win.b[0] - win.a[0], win.b[1] - win.a[1]) || 1;
    const wdir: Point = [(win.b[0] - win.a[0]) / wlen, (win.b[1] - win.a[1]) / wlen];
    const inSign = windowOpenSign(win, o.floor ? windowInward(win, o.floor) : undefined);
    const wang = (Math.atan2(wdir[1], wdir[0]) * 180) / Math.PI;
    const panes = windowSashes(wlen, !!win.hinge_b).map((sh) => {
      const hingeX = sh.x;
      const rot = st === 'open' ? sh.dir * inSign * SASH_OPEN_DEG : 0;
      const left = sh.dir > 0 ? 0 : -sh.length;
      return html`<div class="b3" style=${`transform:translateX(${round(hingeX)}px)`}>
        <div class="b3 pane3" style=${`transform:rotate(${rot}deg)`}>
          <div class="glass3 ${st} ${o.alert?.has(win.id) ? 'alert' : ''}" style=${`width:${round(sh.length - 1)}px;height:${round(top - sill - 2)}px;left:${round(left)}px;top:0;transform-origin:${sh.dir > 0 ? '0' : '100%'} 0;transform:translateZ(${round(sill + 1)}px) rotateX(90deg)`}></div>
        </div>
      </div>`;
    });
    return html`<div class="p3 wallp ${fade}" style=${at(mid)}>${wallBox(sill)} ${wallBox(H - top, top)}</div>
      <div class="p3 wallp ${fade}" style=${at(win.a)}><div class="b3" style=${`transform:rotate(${round(wang, 3)}deg)`}>${panes}</div></div>`;
  }
  if (p.kind === 'garage') {
    // garage door: the door (a CSS transition) goes up — sectional and roller doors shrink towards the lintel,
    // an up-and-over leaf tilts inwards about its top edge
    const op = p.opening!;
    const live = coverLive(op.entity ? o.getState(op.entity) : undefined);
    const Hd = H * DOOR_TOP - 3;
    const inward = (o.floor ? windowInward(op, o.floor) : undefined) ?? segN;
    const side = (inward[0] * segN[0] + inward[1] * segN[1] >= 0 ? 1 : -1) * (op.flip ? -1 : 1);
    const k = live.open;
    const panel = box({ len: len - 6, depth: 3.5, height: Hd, side: live.state === 'open' ? '--fp-state-alert' : '--fp-door-3d', top: 'var(--fp-door)', angle: 0, light: { dir: rotateVec(light.dir, -angle), strength: light.strength } });
    const t =
      op.variant === 'up_over'
        ? `translateZ(${round(Hd)}px) rotateX(${round(-side * k * 83, 1)}deg) translateZ(${round(-Hd)}px)`
        : `translateZ(${round(Hd)}px) scaleZ(${round(Math.max(0.02, 1 - k), 3)}) translateZ(${round(-Hd)}px)`;
    const D = Math.min(Hd, garageDepth(op.variant, len));
    const flat =
      op.variant === 'up_over' || k < 0.02
        ? nothing
        : html`<div class="b3" style=${`transform:translate(0, ${round((side * D * k) / 2 + side * 2)}px)`}>
            ${box({ len: len - 6, depth: op.variant === 'roller' ? 10 : D * k, height: op.variant === 'roller' ? 10 : 2.5, z: Hd - (op.variant === 'roller' ? 10 : 2.5), side: '--fp-door-3d', top: 'var(--fp-door)', angle: 0, light })}
          </div>`;
    return html`<div class="p3 wallp ${fade}" style=${at(mid)}>${wallBox(H * (1 - DOOR_TOP), H * DOOR_TOP)}
      <div class="b3" style=${`transform:rotate(${round(angle, 3)}deg)`}>
        <div class="b3 garage3 ${live.moving ? 'moving' : ''}" style=${`transform:${t}`}>${panel}</div>
        ${flat}
      </div>
    </div>`;
  }
  // door: a leaf with thickness, hinged at the opening's hinge point
  const g = openingGeometry(p.opening!);
  const leafAngle = st === 'closed' ? 0 : g.sign * DOOR_OPEN_DEG;
  const doorAngle = (Math.atan2(g.dir[1], g.dir[0]) * 180) / Math.PI;
  const L = g.length - 3;
  return html`<div class="p3 wallp ${fade}" style=${at(mid)}>${wallBox(H * (1 - DOOR_TOP), H * DOOR_TOP)}</div>
    <div class="p3 wallp ${fade}" style=${at(g.hinge)}>
    <div class="b3 door3 ${st}" style=${`transform:rotate(${round(doorAngle, 3)}deg) rotate(${leafAngle}deg)`}>
      <div class="b3" style=${`transform:translateX(${round(L / 2 + 1.5)}px)`}>
        ${box({ len: L, depth: 4, height: H * DOOR_TOP - 1, side: '--fp-door-3d', top: 'var(--fp-door)', angle: 0, light: { dir: rotateVec(light.dir, -(doorAngle + leafAngle)), strength: light.strength } })}
      </div>
    </div>
  </div>`;
}

function rotateVec(v: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
}

/** Whether a point lies on a (rotated) furniture footprint. */
export function onFootprint(p: Point, f: FurnitureConfig): boolean {
  const a = (-(f.rotation ?? 0) * Math.PI) / 180;
  const dx = p[0] - f.x;
  const dy = p[1] - f.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.h / 2;
}

export function renderFurniture3d(floor: FloorConfig, o: Plan3DOptions): TemplateResult {
  setView(o);
  setDetail(o.detail ?? 1.6);
  const slab = Math.max(2.2, o.detail ?? 2.2);
  const light = keyLight(o.sun);
  // Real heights; like an architectural model everything is cut at the wall height
  const cut = o.height;
  const items = floor.furniture ?? [];
  const supports = items.filter((f) => resolveFurniture(f).k?.support);
  const out: TemplateResult[] = [];
  for (const f of items) {
    const r = resolveFurniture(f);
    const itemCut = cut;
    // mounted above the cut-away walls (TV, wall cabinet, wall light): only shown in the room view
    const wallMounted = r.elevation > 0 && !r.ceiling;
    if (wallMounted && r.elevation >= itemCut - 0.5) continue;
    const dim = o.focus && !pointInPolygon([f.x, f.y], o.focus.points) ? 'hide' : '';
    let base = r.elevation;
    const onTop = !!r.k?.onTop && !base;
    if (onTop) for (const s of supports) if (s !== f && onFootprint([f.x, f.y], s)) base = Math.max(base, Math.min(resolveFurniture(s).height, cut));
    // Ceiling pieces float just above the cut-away walls (at their real height with full walls)
    const floating = isFloating(f, cut);
    if (floating) base = floatHeight(cut);
    // Lamps are never cut away; wall lights above the cut sit on the wall's top edge
    const isLight = r.role === 'light' && !wallMounted;
    // gates and garage doors stand as far open as they are
    const gateLike = (r.k?.kind === 'gate' || r.k?.kind === 'garage_door') && f.entity;
    let parts: Part[] = furnitureParts(f, gateLike ? { open: coverLive(o.getState(f.entity!)).open } : undefined) ?? [
      { x: 0, y: 0, z: 0, w: f.w, d: f.h, h: r.height, color: r.color, radius: 2, topSvg: true },
    ];
    if (floating) parts = parts.filter((p) => !p.cord);
    // Live state of a linked entity
    const fx = furnitureFx(f, o.getState, floor.rooms);
    // a fridge's shopping list: its open items engraved into the top
    const list = fridgeList(f, o.getState);
    const hasEmit = parts.some((p) => p.emit);
    const emitColor = (p: Part): string | undefined => {
      if (!fx) return undefined;
      if (fx.kind === 'heat' && !hasEmit) return `color-mix(in srgb, ${paint(p.color)} 50%, ${fx.color})`;
      if (!p.emit) return undefined;
      if (fx.kind === 'light') return `color-mix(in srgb, ${fx.color} ${Math.round(55 + 25 * fx.level)}%, white)`;
      if (fx.kind === 'heat') return `color-mix(in srgb, ${fx.color} 80%, #ffd9a8)`;
      return `color-mix(in srgb, ${fx.color} 75%, white)`;
    };
    const wrapCls = `p3 ${dim}${fx ? ` fx fx-${fx.kind}` : ''}${f.entity ? ' linked' : ''}`;
    const wrapStyle = (pos: Point) => at(pos) + (fx ? `;--glow:${fx.color};--gk:${fx.level.toFixed(2)}` : '');
    // Mirror pieces whose model does not handle `flip` itself
    if (r.flip && !['sofa', 'desk', 'counter'].includes(r.k?.kind ?? '')) parts = parts.map((p) => ({ ...p, x: -p.x, rot: -(p.rot ?? 0) }));
    const rot = f.rotation ?? 0;
    const ra = (rot * Math.PI) / 180;
    for (const p of parts) {
      const z0 = base + p.z;
      let z1 = z0 + p.h;
      if (!onTop && !floating && !r.ceiling && !isLight) {
        if (z0 >= itemCut) continue; // above the section plane
        z1 = Math.min(z1, itemCut);
      }
      const lit = emitColor(p);
      const h = Math.max(0.5, z1 - z0);
      const wx = f.x + p.x * Math.cos(ra) - p.y * Math.sin(ra);
      const wy = f.y + p.x * Math.sin(ra) + p.y * Math.cos(ra);
      const angle = rot + (p.rot ?? 0);
      const svgTop =
        p.topSvg && !p.rot
          ? html`<svg class="ftop" viewBox="${p.x - p.w / 2} ${p.y - p.d / 2} ${p.w} ${p.d}" preserveAspectRatio="none">${drawFurniture(f, list ? { count: list } : undefined)}</svg>`
          : undefined;
      if (p.cyl || p.round != null) {
        // Cylinder / rounded body: a stack of slabs (side tone below, lit top); small things get finer slices
        const n = p.shade ? 1 : Math.max(1, h < 50 ? Math.min(14, Math.round(h / slab)) : Math.min(6, Math.round(h / Math.max(6, slab))));
        const sh = (i: number) => (p.shade ? p.shade[0] + ((p.shade[1] - p.shade[0]) * i) / n : i / n);
        const rad = p.round != null ? `;border-radius:${round(Math.min(p.round, p.w / 2, p.d / 2), 1)}px` : '';
        const discs = [];
        for (let i = p.clear ? n : p.shade && p.shade[0] > 0 ? 1 : 0; i <= n; i++) {
          const top = i === n;
          const bg = p.clear
            ? 'transparent'
            : lit
              ? mix(lit, top ? 0 : 6)
              : top && svgTop
                ? paint(tone(p.color, 0.04))
                : mix(paint(top ? (p.top ?? tone(p.color, 0.06)) : p.color), top && (!p.shade || p.shade[1] >= 0.999) ? 0 : Math.round(16 * (1 - sh(i))));
          discs.push(html`<div
            class="f top ${p.round != null ? '' : 'disc'}"
            style=${`width:${round(p.w)}px;height:${round(p.d)}px;left:${round(-p.w / 2)}px;top:${round(-p.d / 2)}px;transform:translateZ(${round(z0 + (h * i) / n, 2)}px);background:${bg}${rad}`}
          >
            ${top ? (svgTop ?? nothing) : nothing}
          </div>`);
        }
        out.push(html`<div class=${wrapCls} data-furniture=${f.id} style=${wrapStyle([wx, wy])}><div class="b3 ${lit ? 'emit' : ''} ${p.clear ? 'clear' : ''}" style=${`transform:rotate(${round(angle, 3)}deg)`}>${discs}</div></div>`);
        continue;
      }
      const thin = p.w <= 6 && p.d <= 6;
      out.push(html`<div class=${wrapCls} data-furniture=${f.id} style=${wrapStyle([wx, wy])}>
        ${box({
          len: p.w,
          depth: p.d,
          height: h,
          z: round(z0, 2),
          side: lit ?? paint(p.color),
          top: lit ?? (svgTop ? paint(tone(p.color, 0.04)) : paint(p.top ?? tone(p.color, 0.06))),
          topContent: svgTop,
          angle,
          light,
          radius: p.radius,
          caps: !thin,
          cls: p.glass ? 'glass3d' : lit ? 'furn3 emit' : 'furn3',
        })}
      </div>`);
    }
  }
  return html`${out}`;
}


/** Sun beams through windows onto the floor + the building's shadow (SVG, part of the floor plan). */
export function renderSun(floor: FloorConfig, sun: SunInfo | undefined, wallHeight: number, is3d: boolean) {
  const defs: TemplateResult[] = [];
  const beams: TemplateResult[] = [];
  let shadow: TemplateResult | typeof nothing = nothing;
  let inner: TemplateResult | typeof nothing = nothing;
  const rooms = floor.rooms.filter((r) => r.points.length >= 3);
  if (sun?.up && sun.strength > 0.04) {
    const tanE = Math.tan((Math.max(4, sun.elevation) * Math.PI) / 180);
    // Building shadow, cast away from the sun
    const len = Math.min((wallHeight * 1.6) / tanE, 160);
    const v: Point = [-sun.dir[0] * len, -sun.dir[1] * len];
    const bd = rooms.map((r) => pointsToPath(r.points)).join(' ');
    shadow = svg`<g class="bshadow" style=${`opacity:${(0.07 + 0.07 * sun.strength).toFixed(3)}`} transform=${`translate(${round(v[0])} ${round(v[1])})`}>
      ${softShape(bd, 8)}
    </g>`;
    // Shadows inside the rooms: walls and furniture, long and colored when the sun is low
    const cast = (h: number): Point => {
      const l = Math.min(h / tanE, 260);
      return [-sun.dir[0] * l, -sun.dir[1] * l];
    };
    const polys: string[] = [];
    const wv = cast(wallHeight);
    for (const r of rooms)
      r.points.forEach((p, i) => {
        const q = r.points[(i + 1) % r.points.length];
        polys.push(pointsToPath([p, q, [q[0] + wv[0], q[1] + wv[1]], [p[0] + wv[0], p[1] + wv[1]]]));
      });
    for (const f of floor.furniture ?? []) {
      const fr = resolveFurniture(f);
      if (!fr.k || fr.elevation > 0 || fr.ceiling || fr.k.onTop || fr.height < 4) continue;
      const fv = cast(Math.min(fr.height, wallHeight));
      const a = ((f.rotation ?? 0) * Math.PI) / 180;
      const corners: Point[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const lx = (sx * f.w) / 2;
        const ly = (sy * f.h) / 2;
        return [f.x + lx * Math.cos(a) - ly * Math.sin(a), f.y + lx * Math.sin(a) + ly * Math.cos(a)];
      });
      polys.push(pointsToPath(hull([...corners, ...corners.map((c) => [c[0] + fv[0], c[1] + fv[1]] as Point)])));
    }
    defs.push(svg`<clipPath id="fp-rooms-clip">${rooms.map((r) => svg`<path d=${pointsToPath(r.points)}></path>`)}</clipPath>`);
    inner = svg`<g class="ishadow" clip-path="url(#fp-rooms-clip)" style=${`opacity:${(0.13 + 0.12 * sun.strength).toFixed(3)}`}>
      ${softShape(polys.join(' '), 2.5)}
    </g>`;
    const depth = Math.max(60, Math.min(200 / tanE, 520));
    (floor.openings ?? [])
      .filter((o) => o.type === 'window')
      .forEach((o, i) => {
        const inward = windowInward(o, floor);
        if (!inward) return;
        const facing = -(inward[0] * sun.dir[0] + inward[1] * sun.dir[1]); // >0: sun outside this window
        if (facing < 0.08) return;
        const d: Point = [-sun.dir[0] * depth, -sun.dir[1] * depth];
        const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
        const room = rooms.find((r) => pointInPolygon([mid[0] + inward[0] * 6, mid[1] + inward[1] * 6], r.points));
        if (!room) return;
        const id = `fp-beam-${i}`;
        const op = Math.min(0.85, 0.4 + 0.5 * sun.strength) * Math.min(1, 0.35 + facing * 1.4);
        defs.push(svg`<linearGradient id=${`${id}-g`} gradientUnits="userSpaceOnUse" x1=${mid[0]} y1=${mid[1]} x2=${mid[0] + d[0]} y2=${mid[1] + d[1]}>
            <stop offset="0" class="beam-0" style=${`stop-opacity:${op.toFixed(3)}`}></stop>
            <stop offset="1" class="beam-1"></stop>
          </linearGradient>
          <clipPath id=${`${id}-c`}><path d=${pointsToPath(room.points)}></path></clipPath>`);
        const poly: Point[] = [o.a, o.b, [o.b[0] + d[0], o.b[1] + d[1]], [o.a[0] + d[0], o.a[1] + d[1]]];
        beams.push(svg`<path class="beam" d=${pointsToPath(poly)} fill=${`url(#${id}-g)`} clip-path=${`url(#${id}-c)`}></path>`);
      });
  } else if (is3d) {
    // Soft ambient contact shadow under the building
    shadow = svg`<g class="bshadow ambient" transform="translate(0 14)">${softShape(rooms.map((r) => pointsToPath(r.points)).join(' '), 14)}</g>`;
  }
  return { defs, beams, shadow, inner };
}

/**
 * A soft-edged shape without blur filters (which are costly to rasterise on tablets): the fill plus
 * two wide translucent outlines form the penumbra — looks like a blur of radius r.
 */
function softShape(d: string, r: number) {
  return svg`<path class="soft" d=${d} style=${`stroke-width:${round(r * 2.2, 1)};stroke-opacity:0.28`}></path>
    <path class="soft" d=${d} style=${`stroke-width:${round(r * 1.1, 1)};stroke-opacity:0.5`}></path>
    <path d=${d}></path>`;
}

/** Convex hull (monotone chain) */
function hull(pts: Point[]): Point[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Air streaming in through open windows: wavy streaks travel from outside into the room
 * (transform/opacity animation). Faster with stronger wind.
 */
export function renderWind(floor: FloorConfig, getState: (id: string) => HassEntity | undefined, windSpeed = 8, only?: Point[]) {
  const out: TemplateResult[] = [];
  const dur = Math.max(1.1, Math.min(2.8, 2.8 - windSpeed / 14));
  (floor.openings ?? []).forEach((o) => {
    if (o.type !== 'window' || !o.entity || openingState(getState(o.entity)) !== 'open') return;
    const inward = windowInward(o, floor);
    if (!inward) return;
    const len = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
    const mid: Point = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    // room view: only the windows of that room (the streams are drawn above the scene)
    if (only && !pointInPolygon([mid[0] + inward[0] * 25, mid[1] + inward[1] * 25], only)) return;
    const angle = (Math.atan2(inward[1], inward[0]) * 180) / Math.PI;
    const n = Math.max(3, Math.min(7, Math.round(len / 22)));
    const streaks = Array.from({ length: n }, (_, i) => {
      const y = -len * 0.38 + (len * 0.76 * i) / Math.max(1, n - 1);
      const wave = 4 + (i % 3) * 1.5;
      return svg`<path class="air" d=${`M 0 ${round(y)} q 11 ${-wave} 22 0 t 22 0 t 22 0`}
        style=${`animation-duration:${dur.toFixed(2)}s;animation-delay:-${((i * 0.37) % 1 * dur).toFixed(2)}s`}></path>`;
    });
    out.push(svg`<g class="wind" transform=${`translate(${round(mid[0])} ${round(mid[1])}) rotate(${round(angle, 2)})`}>${streaks}</g>`);
  });
  return out;
}

/** A ceiling piece reaching above the cut height floats just above the walls instead */
export function isFloating(f: FurnitureConfig, cut: number): boolean {
  const r = resolveFurniture(f);
  return r.ceiling && r.elevation + r.height > cut;
}
export const floatHeight = (cut: number) => cut + 22;

/** Wall-mounted lights above the section plane are shown on the wall's top edge */
export function lightBase(f: FurnitureConfig, base: number, cut: number): number {
  const r = resolveFurniture(f);
  if (r.role !== 'light' || r.ceiling || r.elevation <= 0 || base + r.height <= cut) return base;
  return Math.max(0, cut - r.height * 0.6);
}

/** Height (cm) at which a piece's visible body sits: mounting height or the counter it stands on. */
export function furnitureBaseHeight(f: FurnitureConfig, all: FurnitureConfig[], cut: number): number {
  const r = resolveFurniture(f);
  if (isFloating(f, cut)) return floatHeight(cut);
  if (r.elevation) return lightBase(f, r.elevation, cut);
  if (!r.k?.onTop) return 0;
  let z = 0;
  for (const s of all) if (s !== f && resolveFurniture(s).k?.support && onFootprint([f.x, f.y], s)) z = Math.max(z, Math.min(resolveFurniture(s).height, cut));
  return z;
}
