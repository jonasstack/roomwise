import { nothing, svg, type SVGTemplateResult } from 'lit';
import type { GarageVariant, HassEntity, OpeningConfig, Point } from './types';
import { round } from './geometry';

export interface OpeningGeometry {
  hinge: Point;
  end: Point;
  length: number;
  dir: Point;
  /** Unit normal towards the swing side */
  normal: Point;
  /** +1 / -1: rotation sign (clockwise in screen space) to open towards normal */
  sign: number;
  angle: number; // degrees of the hinge→end direction
}

export function openingGeometry(o: OpeningConfig): OpeningGeometry {
  const hinge = o.hinge_b ? o.b : o.a;
  const end = o.hinge_b ? o.a : o.b;
  const dx = end[0] - hinge[0];
  const dy = end[1] - hinge[1];
  const length = Math.hypot(dx, dy) || 1;
  const dir: Point = [dx / length, dy / length];
  const side = o.flip ? -1 : 1;
  const normal: Point = [-dir[1] * side, dir[0] * side];
  return { hinge, end, length, dir, normal, sign: side, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** Contact sensors report "on" when open. Without an entity the state is unknown. */
export function openingState(s: HassEntity | undefined): 'open' | 'closed' | 'unknown' {
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return 'unknown';
  return s.state === 'on' || s.state === 'open' ? 'open' : 'closed';
}

/** Garage door or gate driven by a cover (or watched by a contact sensor) */
export interface CoverLive {
  /** how far open: 0 closed … 1 open */
  open: number;
  /** running right now */
  moving?: 'opening' | 'closing';
  state: 'open' | 'closed' | 'unknown';
}

/**
 * Live state of a garage door / gate: the cover's position when it reports one, else open / closed;
 * while it runs without a position it heads for where it is going.
 */
export function coverLive(s: HassEntity | undefined): CoverLive {
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return { open: 0, state: 'unknown' };
  const st = s.state;
  const moving = st === 'opening' || st === 'closing' ? st : undefined;
  const pos = Number(s.attributes.current_position);
  let open: number;
  if (s.entity_id.startsWith('cover.') && s.attributes.current_position != null && !isNaN(pos)) open = Math.max(0, Math.min(1, pos / 100));
  else open = st === 'open' || st === 'on' || st === 'opening' ? 1 : 0;
  return { open, moving, state: open > 0.02 || moving || st === 'open' || st === 'on' ? 'open' : 'closed' };
}

/** What a garage door's drawing depends on (redrawn when this changes) */
export function coverLiveSig(s: HassEntity | undefined): string {
  const c = coverLive(s);
  return `${c.state}:${c.open.toFixed(2)}:${c.moving ?? ''}`;
}

/** A cover that is a garage door or a gate (never opened by accident: always asks first) */
export function isGarageCover(s: HassEntity | undefined): boolean {
  const dc = s?.attributes.device_class;
  return !!s && s.entity_id.startsWith('cover.') && (dc === 'garage' || dc === 'gate');
}

/** Depth (cm) a garage door takes inside the garage when open: the panels under the ceiling, the tilted leaf, the coil */
export function garageDepth(v: GarageVariant | undefined, len: number): number {
  if (v === 'roller') return 26;
  if (v === 'up_over') return Math.min(170, len * 0.7);
  return Math.min(210, Math.max(120, len * 0.85));
}

export const DOOR_OPEN_DEG = 82;
export const SASH_OPEN_DEG = 90;

/** Sashes of a window in local coordinates (x along a→b): hinge x, length, direction (+1 from a, −1 from b). */
export function windowSashes(len: number, hingeB = false): { x: number; length: number; dir: 1 | -1 }[] {
  if (len > 90) {
    const half = len / 2;
    return [
      { x: 0, length: half, dir: 1 },
      { x: len, length: half, dir: -1 },
    ];
  }
  return hingeB ? [{ x: len, length: len, dir: -1 }] : [{ x: 0, length: len, dir: 1 }];
}

/**
 * Side a window opens to, as sign of the local normal (x along a→b): inwards by default,
 * reversed with `flip`.
 */
export function windowOpenSign(o: OpeningConfig, inward?: Point): 1 | -1 {
  const dx = o.b[0] - o.a[0];
  const dy = o.b[1] - o.a[1];
  const L = Math.hypot(dx, dy) || 1;
  const local: Point = [-dy / L, dx / L];
  const base = inward ? (inward[0] * local[0] + inward[1] * local[1] >= 0 ? 1 : -1) : 1;
  return (o.flip ? -base : base) as 1 | -1;
}

/**
 * Top view of a door or window, drawn in a local frame (x along the wall, y across it).
 * Leaves/sashes rotate via CSS transform around their hinge (animated).
 * @param inward unit vector into the building (windows open inwards); falls back to the flip side
 */
export function drawOpening(
  o: OpeningConfig,
  wall: number,
  state: 'open' | 'closed' | 'unknown',
  selected = false,
  inward?: Point,
  /** Editor: always show the opening direction (sashes drawn open, neutral) */
  preview = false,
  /** Garage door: how far open and whether it runs */
  live?: CoverLive,
): SVGTemplateResult {
  const cls = `opening ${o.type} ${state} ${selected ? 'selected' : ''} ${preview ? 'preview' : ''} ${live?.moving ? 'moving' : ''}`;
  const hit = svg`<line class="hit" data-opening=${o.id} x1=${o.a[0]} y1=${o.a[1]} x2=${o.b[0]} y2=${o.b[1]} style=${`stroke-width:${Math.max(36, wall * 4)}`}></line>`;
  const T = Math.max(4, wall);
  // a passage: no wall – only a faint threshold line on the floor; selectable in the editor only
  if (o.type === 'passage')
    return svg`<g class=${cls}>${preview || selected ? hit : nothing}<line class="threshold" x1=${o.a[0]} y1=${o.a[1]} x2=${o.b[0]} y2=${o.b[1]}></line></g>`;
  if (o.type === 'garage') return drawGarage(o, T, cls, hit, live ?? { open: state === 'open' ? 1 : 0, state }, inward, preview);
  if (o.type === 'door') {
    const g = openingGeometry(o);
    const L = g.length;
    const swing = g.sign; // +1: opens towards local +y
    const leafT = Math.max(3, Math.min(6, T * 0.55));
    const angle = state === 'closed' ? 0 : swing * DOOR_OPEN_DEG;
    const ax = round(L * Math.cos((DOOR_OPEN_DEG * Math.PI) / 180), 2);
    const ay = round(swing * L * Math.sin((DOOR_OPEN_DEG * Math.PI) / 180), 2);
    return svg`<g class=${cls}>
      <g transform=${`translate(${round(g.hinge[0], 2)} ${round(g.hinge[1], 2)}) rotate(${round(g.angle, 3)})`}>
        <rect class="threshold" x="0" y=${-T / 2} width=${L} height=${T} rx="1"></rect>
        <path class="swing" d=${`M 0 0 L ${L} 0 A ${L} ${L} 0 0 ${swing > 0 ? 1 : 0} ${ax} ${ay} Z`}></path>
        <path class="arc" d=${`M ${L} 0 A ${L} ${L} 0 0 ${swing > 0 ? 1 : 0} ${ax} ${ay}`}></path>
        <rect class="jamb" x="-1.5" y=${-T / 2 - 1} width="3" height=${T + 2} rx="1"></rect>
        <rect class="jamb" x=${L - 1.5} y=${-T / 2 - 1} width="3" height=${T + 2} rx="1"></rect>
        <g class="leaf" style=${`transform:rotate(${angle}deg)`}>
          <rect x="1.5" y=${-leafT / 2} width=${L - 3} height=${leafT} rx=${leafT / 2}></rect>
          <circle class="knob" cx=${L - 10} cy=${swing * (leafT / 2 + 1.6)} r="1.6"></circle>
        </g>
      </g>
      ${hit}
    </g>`;
  }
  // window
  const dx = o.b[0] - o.a[0];
  const dy = o.b[1] - o.a[1];
  const L = Math.hypot(dx, dy) || 1;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const inSign = windowOpenSign(o, inward);
  const sashes = windowSashes(L, !!o.hinge_b);
  const sashT = Math.max(2, Math.min(4, T * 0.35));
  return svg`<g class=${cls}>
    <g transform=${`translate(${round(o.a[0], 2)} ${round(o.a[1], 2)}) rotate(${round(ang, 3)})`}>
      <rect class="frame" x="0" y=${-T / 2} width=${L} height=${T} rx="1.5"></rect>
      <rect class="glass" x="2" y=${-Math.max(1, T * 0.14)} width=${L - 4} height=${Math.max(2, T * 0.28)} rx="1"></rect>
      ${sashes.length > 1 ? svg`<rect class="mullion" x=${L / 2 - 1} y=${-T / 2} width="2" height=${T}></rect>` : ''}
      ${sashes.map((sh) => {
        const a = sh.dir * inSign * SASH_OPEN_DEG;
        const ex = round(sh.dir * sh.length * Math.cos((SASH_OPEN_DEG * Math.PI) / 180), 2);
        const ey = round(inSign * sh.length * Math.sin((SASH_OPEN_DEG * Math.PI) / 180), 2);
        return svg`<g transform=${`translate(${round(sh.x, 2)} 0)`}>
          <path class="swing" d=${`M 0 0 L ${sh.dir * sh.length} 0 A ${sh.length} ${sh.length} 0 0 ${sh.dir * inSign > 0 ? 1 : 0} ${ex} ${ey} Z`}></path>
          <g class="sash" style=${`transform:rotate(${state === 'open' || preview ? a : 0}deg)`}>
            <rect x=${sh.dir > 0 ? 1 : -sh.length + 1} y=${-sashT / 2} width=${sh.length - 2} height=${sashT} rx=${sashT / 2}></rect>
          </g>
        </g>`;
      })}
    </g>
    ${hit}
  </g>`;
}

/**
 * Top view of a garage door: the door in the wall (sections), and — as it opens — the part that has gone up
 * inside the garage, growing from the wall (sectional: the panels under the ceiling; up-and-over: the tilted
 * leaf; roller: the coil). Open and running show in the alert colour; the growth is a CSS transition.
 */
function drawGarage(o: OpeningConfig, T: number, cls: string, hit: SVGTemplateResult, live: CoverLive, inward: Point | undefined, preview: boolean) {
  const dx = o.b[0] - o.a[0];
  const dy = o.b[1] - o.a[1];
  const L = Math.hypot(dx, dy) || 1;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const inSign = windowOpenSign(o, inward);
  const D = garageDepth(o.variant, L);
  const k = preview && live.state !== 'open' ? 0.35 : live.open;
  const n = Math.max(3, Math.round(L / 70));
  const pt = Math.max(3, Math.min(5, T * 0.5));
  return svg`<g class=${cls}>
    <g transform=${`translate(${round(o.a[0], 2)} ${round(o.a[1], 2)}) rotate(${round(ang, 3)})`}>
      <rect class="threshold" x="0" y=${-T / 2} width=${L} height=${T} rx="1"></rect>
      <g class="gtrack" style=${`transform:scaleY(${round(inSign * k, 3)})`}>
        <rect x="3" y="0" width=${L - 6} height=${D} rx="2"></rect>
        ${o.variant === 'roller' ? nothing : Array.from({ length: n - 1 }, (_, i) => svg`<line x1=${round(((i + 1) * L) / n, 1)} y1="2" x2=${round(((i + 1) * L) / n, 1)} y2=${D - 2}></line>`)}
      </g>
      <rect class="jamb" x="-1.5" y=${-T / 2 - 1} width="3" height=${T + 2} rx="1"></rect>
      <rect class="jamb" x=${L - 1.5} y=${-T / 2 - 1} width="3" height=${T + 2} rx="1"></rect>
      <g class="gpanel" style=${`opacity:${round(1 - k * 0.8, 2)}`}>
        <rect x="1.5" y=${-pt / 2} width=${L - 3} height=${pt} rx="1"></rect>
        ${Array.from({ length: n - 1 }, (_, i) => svg`<line x1=${round(((i + 1) * L) / n, 1)} y1=${-pt / 2} x2=${round(((i + 1) * L) / n, 1)} y2=${pt / 2}></line>`)}
      </g>
    </g>
    ${hit}
  </g>`;
}

/** Black strokes for the wall mask: walls are cut out where doors and windows are. */
export function openingMaskLines(openings: OpeningConfig[], wall: number) {
  return openings.map((o) => {
    // a passage often runs from wall to wall: stop half a wall short at each end, so the walls it meets keep
    // their full thickness (no notch); the piece left over lies inside those walls
    let [a, b] = [o.a, o.b];
    if (o.type === 'passage') {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const k = Math.min(0.45, wall / 2 / len);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      [a, b] = [[a[0] + dx * k, a[1] + dy * k], [b[0] - dx * k, b[1] - dy * k]];
    }
    return svg`<line x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]} stroke="black" stroke-width=${wall + 2}></line>`;
  });
}
