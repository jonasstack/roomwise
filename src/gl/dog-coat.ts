import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Object3D,
  Quaternion,
  ShaderChunk,
  SkinnedMesh,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PetLook } from '../pets';

/**
 * The dog's coat and gear, on the animated skeleton.
 *
 * Coat: every fur part (body, wool, ears) carries its bind-pose position (`bindPos`, model space). A small
 * addition to the diffuse shader paints coloured capsules there — the markings (patches, socks, mask, belly)
 * and what was painted in the 3D editor sit exactly on the dog, also on the wool, in every pose and animation.
 *
 * Gear: collar with tag, harness, neckerchief — measured from the dog's own shape (cross-sections of body and
 * wool in bind pose) and riding on the bones.
 *
 * Model space (bind pose): x = side, y = up, z = forward (nose at +z).
 */
export const COAT_MAX = 40;

export interface CoatSpot {
  p: Vector3;
  q: Vector3;
  r: number;
  /** soft edge (0 hard … 1 all soft) */
  soft: number;
  c: Color;
}

// ---------- bind pose ----------

const bound = new WeakSet<BufferGeometry>();

/**
 * bindPos = the position as drawn in the model's rest pose, in model space (skinned like the GPU does it —
 * the stored positions of these models are packed and only meet the bones through the skin), once per geometry
 */
export function addBindPos(mesh: SkinnedMesh) {
  const geo = mesh.geometry;
  if (bound.has(geo) || geo.attributes.bindPos) return;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    arr[i * 3] = v.x;
    arr[i * 3 + 1] = v.y;
    arr[i * 3 + 2] = v.z;
  }
  geo.setAttribute('bindPos', new BufferAttribute(arr, 3));
  bound.add(geo);
}

/** Landmarks of one dog model in bind pose (bones, the outer surface for measuring) */
export interface DogBind {
  bone: (name: string) => Vector3 | undefined;
  /** outer surface points (body + wool + ears/tail), model space */
  pts: Vector3[];
  /** the same without legs, tail and ears (cross-sections for the gear) */
  torso: Vector3[];
  /** surface points of the original low-poly body + ears/tail: seeded markings stay where they always were */
  base: Vector3[];
  /** nose → tail root (model units) */
  len: number;
  /** rough body radius */
  girth: number;
}

const LIMB = /(Upper|Lower)Leg|BackLeg|^FF|Tail|Ear/;

/**
 * Measure a dog in bind pose: `model` (with its coat parts carrying bindPos), `extra` (wool, ears, tail),
 * `base` (the unrefined body geometries, with bindPos)
 */
export function measureBind(model: Object3D, extra: BufferGeometry[] = [], base: BufferGeometry[] = []): DogBind {
  model.updateMatrixWorld(true);
  const bones = new Map<string, Vector3>();
  let names: string[] = [];
  model.traverse((o) => {
    if ((o as { isBone?: boolean }).isBone) bones.set(o.name, o.getWorldPosition(new Vector3()));
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && !names.length) names = m.skeleton.bones.map((b) => b.name);
  });
  const take = (geo: BufferGeometry, into: Vector3[], torso?: Vector3[], limb = false) => {
    const b = geo.attributes.bindPos;
    if (!b) return;
    const si = geo.attributes.skinIndex;
    const sw = geo.attributes.skinWeight;
    // a few thousand points are plenty for measuring
    const step = Math.max(1, Math.floor(b.count / 3000));
    for (let i = 0; i < b.count; i += step) {
      const p = new Vector3().fromBufferAttribute(b, i);
      into.push(p);
      if (!torso || limb) continue;
      if (si && sw && names.length) {
        let best = 0;
        for (let c = 1; c < 4; c++) if (sw.getComponent(i, c) > sw.getComponent(i, best)) best = c;
        if (LIMB.test(names[si.getComponent(i, best)] ?? '')) continue;
      }
      torso.push(p);
    }
  };
  const pts: Vector3[] = [];
  const torso: Vector3[] = [];
  const basePts: Vector3[] = [];
  model.traverse((o) => {
    const m = o as SkinnedMesh;
    // the coat parts (they carry their bind-pose position)
    if (m.isSkinnedMesh && m.name !== 'wool' && m.geometry.attributes.bindPos) take(m.geometry, pts, torso);
  });
  for (const g of base) take(g, basePts);
  const woolPts: Vector3[] = [];
  for (const g of extra) {
    // ears and the tail (rigid, no skin) are limbs; the wool is skinned
    take(g, pts, torso, !g.attributes.skinIndex);
    take(g, g.attributes.skinIndex ? woolPts : basePts);
  }
  if (!basePts.length) basePts.push(...pts);
  const head = bones.get('Head') ?? new Vector3(0, 2.6, 1.7);
  const tail = bones.get('Tail1') ?? new Vector3(0, 1.9, -1.1);
  const t2 = bones.get('Torso2') ?? new Vector3(0, 1.7, 0.5);
  let g = 0;
  for (const p of [...basePts, ...woolPts]) if (Math.abs(p.z - t2.z) < 0.15) g = Math.max(g, Math.abs(p.x));
  return { bone: (n) => bones.get(n), pts, torso: torso.length > 50 ? torso : pts, base: basePts, len: head.distanceTo(tail) || 3, girth: g || 0.5 };
}

const BINS = 36;

/**
 * Cross-section of the dog (body + wool) at `c` across `axis`: its outline as a radius per angle around a centre
 * (angle 0 = bottom, turning to the left side; side = x, up = axis × x) — gear follows the real shape
 */
function section(bind: DogBind, c: Vector3, axis: Vector3, slab: number) {
  const side = new Vector3(1, 0, 0);
  const up = new Vector3().crossVectors(axis, side).normalize();
  // only what is near the axis (not the legs or the head lying in the same plane)
  const reach = bind.girth * 1.9;
  const pts: [number, number][] = [];
  const d = new Vector3();
  for (const p of bind.torso) {
    d.subVectors(p, c);
    if (Math.abs(d.dot(axis)) > slab) continue;
    const u = d.dot(side);
    const w = d.dot(up);
    if (u * u + w * w > reach * reach) continue;
    pts.push([u, w]);
  }
  const fallback = () => {
    const r = bind.girth * 0.6;
    return { center: c.clone(), rx: r, ry: r, side, up, rad: new Array(BINS).fill(r) as number[] };
  };
  if (pts.length < 12) return fallback();
  let cu = 0;
  let cw = 0;
  let rad: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const bins: number[][] = Array.from({ length: BINS }, () => []);
    for (const [u, w] of pts) {
      const du = u - cu;
      const dw = w - cw;
      const a = Math.atan2(du, -dw);
      bins[((Math.floor(((a + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / BINS)) % BINS) + BINS) % BINS].push(Math.hypot(du, dw));
    }
    // robust outline: the outer 92 % of each bin (a stray curl does not widen the ring)
    rad = bins.map((b) => (b.length ? b.sort((x, y) => x - y)[Math.min(b.length - 1, Math.floor(b.length * 0.92))] : NaN));
    for (let i = 0; i < BINS; i++)
      if (!(rad[i] > 0)) {
        let k = 1;
        while (k < BINS && !(rad[(i + k) % BINS] > 0) && !(rad[(i - k + BINS) % BINS] > 0)) k++;
        rad[i] = rad[(i + k) % BINS] > 0 ? rad[(i + k) % BINS] : rad[(i - k + BINS) % BINS] || bind.girth * 0.6;
      }
    // no spikes (a leg reaching into the slab), then smooth
    const med = [...rad].sort((x, y) => x - y)[BINS >> 1];
    rad = rad.map((r, i) => Math.min(r, med * 1.45, [rad[(i + BINS - 1) % BINS], r, rad[(i + 1) % BINS]].sort((x, y) => x - y)[1] * 1.15));
    for (let it = 0; it < 2; it++) rad = rad.map((r, i) => (rad[(i + BINS - 1) % BINS] + 2 * r + rad[(i + 1) % BINS]) / 4);
    // re-centre on the outline
    let su = 0;
    let sw = 0;
    rad.forEach((r, i) => {
      const a = ((i + 0.5) / BINS) * Math.PI * 2;
      su += cu + Math.sin(a) * r;
      sw += cw - Math.cos(a) * r;
    });
    cu = su / BINS;
    cw = sw / BINS;
  }
  const center = c.clone().addScaledVector(side, cu).addScaledVector(up, cw);
  const at = (a: number) => {
    const f = (((a / (Math.PI * 2)) * BINS - 0.5) % BINS + BINS) % BINS;
    const i = Math.floor(f);
    return rad[i] * (1 - (f - i)) + rad[(i + 1) % BINS] * (f - i);
  };
  return { center, rx: (at(Math.PI / 2) + at(-Math.PI / 2)) / 2, ry: (at(0) + at(Math.PI)) / 2, side, up, rad };
}

// ---------- coat ----------

/** Shader helpers of the coat: hash / value noise and the curl field (the same as `curlHeight` in dog-mesh) */
const FUR_GLSL = /* glsl */ `
float furHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float furNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(furHash(i), furHash(i + vec3(1, 0, 0)), f.x), mix(furHash(i + vec3(0, 1, 0)), furHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(furHash(i + vec3(0, 0, 1)), furHash(i + vec3(1, 0, 1)), f.x), mix(furHash(i + vec3(0, 1, 1)), furHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float furCurl(vec3 g) {
  vec3 i = floor(g);
  float best = 9.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      for (int z = -1; z <= 1; z++) {
        vec3 c = i + vec3(float(x), float(y), float(z));
        vec3 o = c + 0.15 + 0.7 * vec3(furHash(c), furHash(c + 17.3), furHash(c + 41.9));
        vec3 d = g - o;
        best = min(best, dot(d, d));
      }
  return max(0.0, 1.0 - best * 1.6);
}
`;

/** Lambert's direct light, wrapped around the form (soft fur, no hard terminator) with a warm edge */
const FUR_LIGHT = ShaderChunk.lights_lambert_pars_fragment.replace(
  'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;',
  `float nl = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( ( nl + 0.42 ) / 1.42 );
	vec3 irradiance = dotNL * directLight.color * mix( vec3( 1.0 ), vec3( 1.1, 0.96, 0.86 ), 1.0 - smoothstep( 0.0, 0.55, abs( nl + 0.1 ) ) );`,
);

export interface FurOptions {
  vertexColors?: boolean;
  /** wool curls: cell, depth (model units), crease darkening */
  curl?: [number, number, number];
}

/**
 * The coat: Lambert, softly wrapped light, a velvety sheen at the silhouette, darker towards the belly and paws,
 * a fine fur grain, curls on wool (bumped and shaded, faded out where they would be smaller than a pixel) — and its
 * colour overpainted by capsules on the bind-pose position (markings, painting).
 */
export function coatMaterial(color: Color, opts: FurOptions | boolean = {}): MeshLambertMaterial {
  const o: FurOptions = typeof opts === 'boolean' ? { vertexColors: opts } : opts;
  const vertexColors = !!o.vertexColors;
  const curly = !!o.curl && o.curl[0] > 0;
  const m = new MeshLambertMaterial({ color, vertexColors });
  const A = Array.from({ length: COAT_MAX }, () => new Vector4());
  const B = Array.from({ length: COAT_MAX }, () => new Vector4());
  const C = Array.from({ length: COAT_MAX }, () => new Vector4());
  const n = { value: 0 };
  const fur = {
    unit: { value: 20 },
    ao: { value: new Vector3(0.4, 1.4, 0.72) },
    curl: { value: new Vector3(...(o.curl ?? [0, 0, 0])) },
  };
  m.userData.coat = { A, B, C, n };
  m.userData.fur = fur;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCoatA = { value: A };
    sh.uniforms.uCoatB = { value: B };
    sh.uniforms.uCoatC = { value: C };
    sh.uniforms.uCoatN = n;
    sh.uniforms.uFurUnit = fur.unit;
    sh.uniforms.uFurAO = fur.ao;
    sh.uniforms.uFurCurl = fur.curl;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 bindPos;\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = bindPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${curly ? '#define FUR_CURL' : ''}
varying vec3 vBind;
uniform vec4 uCoatA[${COAT_MAX}];
uniform vec4 uCoatB[${COAT_MAX}];
uniform vec4 uCoatC[${COAT_MAX}];
uniform int uCoatN;
uniform float uFurUnit;
uniform vec3 uFurAO;
uniform vec3 uFurCurl;
${FUR_GLSL}`,
      )
      .replace('#include <lights_lambert_pars_fragment>', FUR_LIGHT)
      .replace(
        '#include <color_fragment>',
        `for (int i = 0; i < ${COAT_MAX}; i++) {
  if (i >= uCoatN) break;
  vec3 a = uCoatA[i].xyz;
  vec3 ab = uCoatB[i].xyz - a;
  float h = clamp(dot(vBind - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float d = length(vBind - a - ab * h);
  float r = uCoatA[i].w;
  float k = 1.0 - smoothstep(r * (1.0 - uCoatB[i].w), r, d);
  diffuseColor.rgb = mix(diffuseColor.rgb, uCoatC[i].rgb, k);
}
#include <color_fragment>
// how big the coat's detail is on screen (model units per pixel)
float furPx = length(fwidth(vBind));
// darker towards belly and paws (soft occlusion)
diffuseColor.rgb *= mix(uFurAO.z, 1.0, smoothstep(uFurAO.x, uFurAO.y, vBind.y));
// fine grain of the fur, only where it is larger than a pixel
if (furPx < 0.02) {
  float furGrain = furNoise(vBind * vec3(38.0, 38.0, 16.0)) * 0.6 + furNoise(vBind * 90.0) * 0.4;
  diffuseColor.rgb *= 1.0 + (furGrain - 0.5) * 0.14 * (1.0 - smoothstep(0.006, 0.02, furPx));
}
float furH = 0.0;
float furFade = 0.0;
#ifdef FUR_CURL
furFade = 1.0 - smoothstep(uFurCurl.x * 0.08, uFurCurl.x * 0.3, furPx);
if (furFade > 0.0) furH = furCurl(vBind / uFurCurl.x);
// curls: darker in the gaps (an even tone where they are too small to see)
diffuseColor.rgb *= mix(1.0 - uFurCurl.z * 0.45, 1.0 - uFurCurl.z * (1.0 - furH) * (1.0 - furH), furFade);
#endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#ifdef FUR_CURL
if (furFade > 0.0) {
  // bump from the curl height (surface gradient from screen derivatives)
  vec3 dpx = dFdx(-vViewPosition);
  vec3 dpy = dFdy(-vViewPosition);
  float hh = furH * uFurCurl.y * uFurUnit;
  float hx = dFdx(hh);
  float hy = dFdy(hh);
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1);
  if (abs(det) > 1e-10) normal = normalize(normal - (r1 * hx + r2 * hy) / det * furFade * 0.85);
}
#endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  // velvety sheen where the coat turns away (fur catches the light at the edge)
  float fr = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  fr = fr * fr * fr;
  outgoingLight += fr * 0.55 * (reflectedLight.indirectDiffuse + reflectedLight.directDiffuse * 0.6) + fr * 0.035;
}
#include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `coat${COAT_MAX}${vertexColors ? 'v' : ''}${curly ? 'c' : ''}`;
  return m;
}

/** Scale of the coat details: view units per model unit, the belly / paw shading by height (model units) */
export function setFur(m: Material, unit: number, aoLow: number, aoHigh: number) {
  const fur = m.userData.fur as { unit: { value: number }; ao: { value: Vector3 } } | undefined;
  if (!fur) return;
  fur.unit.value = unit;
  fur.ao.value.set(aoLow, aoHigh, fur.ao.value.z);
}

export function setCoat(m: Material, spots: CoatSpot[]) {
  const coat = m.userData.coat as { A: Vector4[]; B: Vector4[]; C: Vector4[]; n: { value: number } } | undefined;
  if (!coat) return;
  const list = spots.slice(0, COAT_MAX);
  list.forEach((s, i) => {
    coat.A[i].set(s.p.x, s.p.y, s.p.z, s.r);
    coat.B[i].set(s.q.x, s.q.y, s.q.z, s.soft);
    coat.C[i].set(s.c.r, s.c.g, s.c.b, 1);
  });
  coat.n.value = list.length;
}

const rnd = (s: number) => {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Markings as capsules on the coat (the model's own light parts are handled by its second material) */
export function markingSpots(look: PetLook, bind: DogBind, marks: Color): CoatSpot[] {
  const out: CoatSpot[] = [];
  const L = bind.len;
  const B = (n: string) => bind.bone(n);
  const dot = (p: Vector3, r: number, soft = 0.35, q?: Vector3) => out.push({ p: p.clone(), q: (q ?? p).clone(), r, soft, c: marks });
  switch (look.markings) {
    case 'socks':
      for (const n of ['FFL', 'FFR', 'FFBL', 'FFBR']) {
        const p = B(n);
        if (p) dot(new Vector3(p.x, 0.12 * L, p.z), 0.16 * L, 0.3);
      }
      break;
    case 'mask': {
      const h = B('Head');
      if (h) dot(new Vector3(0, h.y - 0.1 * L, h.z + 0.18 * L), 0.17 * L, 0.45);
      break;
    }
    case 'belly': {
      const a = B('Torso3');
      const b = B('Back');
      const n = B('Neck1');
      if (a && b) dot(new Vector3(0, a.y - bind.girth * 1.05, a.z), bind.girth * 0.75, 0.5, new Vector3(0, b.y - bind.girth * 1.0, b.z + 0.1 * L));
      if (a && n) dot(new Vector3(0, a.y - bind.girth * 0.7, a.z + 0.12 * L), bind.girth * 0.6, 0.5, new Vector3(0, n.y - 0.08 * L, n.z + 0.06 * L));
      break;
    }
    case 'patches': {
      // patches on the outer surface (wool where there is wool): top and sides of body and head, seeded
      const cands = bind.base.filter((p) => p.y > (B('Torso2')?.y ?? 1.6) - bind.girth * 0.25);
      if (!cands.length) break;
      const n = 5;
      const used: Vector3[] = [];
      for (let k = 0; k < 40 && used.length < n; k++) {
        const p = cands[Math.floor(rnd(look.seed * 31.7 + k * 7.13) * cands.length)];
        if (used.some((u) => u.distanceTo(p) < 0.28 * L)) continue;
        used.push(p);
        const r = (0.11 + rnd(look.seed * 3.3 + k) * 0.08) * L;
        // a little oval: stretched along the body
        const q = p.clone().add(new Vector3(0, 0, (rnd(look.seed + k * 1.7) - 0.5) * 0.12 * L));
        dot(p, r, 0.3, q);
      }
      // one ear often has its own colour
      const e = B(rnd(look.seed * 9.1) > 0.5 ? 'Ear1L' : 'Ear1R') ?? B('Head');
      if (e) dot(e, 0.15 * L, 0.4);
      break;
    }
  }
  return out;
}

/** Painted strokes from the config → capsules */
export function paintSpots(look: PetLook): CoatSpot[] {
  return look.paint.map((s) => ({ p: new Vector3(...s.p), q: new Vector3(...(s.q ?? s.p)), r: s.r, soft: 0.25, c: new Color(s.c) }));
}

// ---------- gear ----------

type Section = ReturnType<typeof section>;

/** Rounded-rectangle profile: x across the strap (along the axis), y outwards; counter-clockwise */
function roundRect(width: number, thick: number, segs: number): [number, number][] {
  const r = Math.min(thick * 0.48, width * 0.25);
  const hw = width / 2 - r;
  const ht = thick / 2 - r;
  const pts: [number, number][] = [];
  const corners: [number, number, number][] = [
    [hw, ht, 0],
    [-hw, ht, Math.PI / 2],
    [-hw, -ht, Math.PI],
    [hw, -ht, Math.PI * 1.5],
  ];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  return pts;
}

function circle(r: number, n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r] as [number, number]);
}

interface Frame {
  c: Vector3;
  /** outwards (profile y) */
  n: Vector3;
  /** across (profile x) */
  a: Vector3;
}

/** A profile swept along frames (closed ring or open strip), faces turned outwards, smooth normals */
function sweep(frames: Frame[], prof: [number, number][], closed: boolean): BufferGeometry {
  const P: number[] = [];
  const I: number[] = [];
  const m = prof.length;
  for (const f of frames)
    for (const [px, py] of prof) P.push(f.c.x + f.a.x * px + f.n.x * py, f.c.y + f.a.y * px + f.n.y * py, f.c.z + f.a.z * px + f.n.z * py);
  const nf = frames.length;
  for (let i = 0; i < (closed ? nf : nf - 1); i++) {
    const i2 = (i + 1) % nf;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      I.push(i * m + k, i2 * m + k, i2 * m + k2, i * m + k, i2 * m + k2, i * m + k2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  // outwards? (the outermost profile point's normal must point along n)
  let top = 0;
  prof.forEach((p, k) => {
    if (p[1] > prof[top][1]) top = k;
  });
  const nn = new Vector3().fromBufferAttribute(g.attributes.normal as BufferAttribute, top);
  if (nn.dot(frames[0].n) < 0) {
    const ix = g.index!;
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, t);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Frames around a cross-section ring (angle 0 = bottom), lifted `lift` off the surface */
function ringFrames(sec: Section, axis: Vector3, grow: number, lift: number, n: number, from = 0, to = Math.PI * 2): Frame[] {
  const out: Frame[] = [];
  const closed = to - from >= Math.PI * 2 - 1e-6;
  const cnt = closed ? n : n + 1;
  for (let j = 0; j < cnt; j++) {
    const th = from + ((to - from) * j) / n;
    const e = ringPoint(sec, th, grow);
    // outwards: across the outline's tangent
    const t = ringPoint(sec, th + 0.06, grow).sub(ringPoint(sec, th - 0.06, grow));
    const nrm = new Vector3().crossVectors(t, axis).normalize();
    if (nrm.dot(e.clone().sub(sec.center)) < 0) nrm.negate();
    out.push({ c: e.addScaledVector(nrm, lift), n: nrm, a: axis.clone() });
  }
  return out;
}

/** A flat strap with rounded edges around the dog: the inner face lies on the coat */
function strap(sec: Section, axis: Vector3, width: number, thick: number, grow: number, fine: boolean): BufferGeometry {
  return sweep(ringFrames(sec, axis, grow, thick / 2, fine ? 64 : 30), roundRect(width, thick, fine ? 4 : 2), true);
}

/** A point on the ring: angle 0 = bottom, turning to the left side */
function ringPoint(sec: Section, ang: number, grow = 1.04) {
  const f = ((((ang / (Math.PI * 2)) * BINS - 0.5) % BINS) + BINS) % BINS;
  const i = Math.floor(f);
  const r = sec.rad[i] * (1 - (f - i)) + sec.rad[(i + 1) % BINS] * (f - i);
  return sec.center
    .clone()
    .addScaledVector(sec.side, Math.sin(ang) * r * grow)
    .addScaledVector(sec.up, -Math.cos(ang) * r * grow);
}

/** A coin with a bevelled rim (the tag), axis along z */
function coin(r: number, h: number, fine: boolean): BufferGeometry {
  const b = Math.min(h * 0.45, r * 0.2);
  const prof = [new Vector2(0, h / 2), new Vector2(r - b, h / 2), new Vector2(r, h / 2 - b), new Vector2(r, -h / 2 + b), new Vector2(r - b, -h / 2), new Vector2(0, -h / 2)];
  const g = new LatheGeometry(prof, fine ? 32 : 16);
  g.rotateX(Math.PI / 2);
  return g;
}

export interface Gear {
  /** bone → geometries per part (model space; moved into bone space on attach) */
  parts: { bone: string; geo: BufferGeometry; kind: 'collar' | 'tag' | 'harness' | 'metal' | 'bandana'; at?: Vector3; axis?: Vector3 }[];
  /** the tag hangs over a neckerchief: moved this far out */
  tagOut: Vector3;
}

const gearCache = new WeakMap<object, Map<string, Gear>>();

/** Collar, tag, harness and neckerchief measured on this dog (cached per model + breed look + detail) */
export function gearFor(src: object, key: string, bind: DogBind, fine = false): Gear {
  let per = gearCache.get(src);
  if (!per) gearCache.set(src, (per = new Map()));
  const ck = `${key}|${fine ? 'fine' : ''}`;
  const hit = per.get(ck);
  if (hit) return hit;
  const B = (n: string, fb: Vector3) => bind.bone(n) ?? fb;
  const L = bind.len;
  const neck1 = B('Neck1', new Vector3(0, 2.1, 1.3));
  const neck2 = B('Neck2', new Vector3(0, 2.4, 1.5));
  const head = B('Head', new Vector3(0, 2.7, 1.7));
  const t3 = B('Torso3', new Vector3(0, 1.8, 1.0));
  const t2 = B('Torso2', new Vector3(0, 1.75, 0.5));
  const parts: Gear['parts'] = [];
  // collar: a flat strap around the neck, a little above its base
  const nAxis = head.clone().sub(neck1).normalize();
  const cAt = neck1.clone().lerp(neck2, 0.55);
  const col = section(bind, cAt, nAxis, 0.05 * L);
  const cw = 0.062 * L;
  parts.push({ bone: 'Neck1', geo: strap(col, nAxis, cw, 0.02 * L, 0.99, fine), kind: 'collar', at: col.center, axis: nAxis });
  // tag: a bevelled coin on a little ring, hanging at the front below the collar
  const bottom = ringPoint(col, 0, 1.0);
  const ring = new TorusGeometry(0.02 * L, 0.0055 * L, 6, fine ? 20 : 12);
  ring.rotateY(Math.PI / 2);
  ring.translate(bottom.x, bottom.y - 0.026 * L, bottom.z + 0.012 * L);
  parts.push({ bone: 'Neck1', geo: ring, kind: 'metal', at: col.center, axis: nAxis });
  const disc = coin(0.04 * L, 0.011 * L, fine);
  disc.translate(bottom.x, bottom.y - 0.068 * L, bottom.z + 0.02 * L);
  parts.push({ bone: 'Neck1', geo: disc, kind: 'tag', at: col.center, axis: nAxis });
  // neckerchief: a soft cloth triangle from the front half of the collar to a tip on the chest, rolled at the top
  {
    const tip = ringPoint(col, 0, 1.12).add(new Vector3(0, -0.21 * L, 0.07 * L));
    const N = fine ? 18 : 10;
    const M = fine ? 10 : 5;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= M; j++) {
      const v = j / M;
      for (let i = 0; i <= N; i++) {
        const u = (i / N) * 2 - 1;
        const base = ringPoint(col, 1.2 * u, 1.05);
        const out = base.clone().sub(col.center).normalize();
        const p = base.lerp(tip, v).addScaledVector(out, 0.035 * L * Math.sin(Math.PI * v) * Math.sqrt(Math.max(0, 1 - u * u)));
        pos.push(p.x, p.y, p.z);
      }
    }
    for (let j = 0; j < M; j++)
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        idx.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
      }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push({ bone: 'Neck1', geo: g, kind: 'bandana', at: col.center, axis: nAxis });
    const roll = sweep(ringFrames(col, nAxis, 1.03, 0.014 * L, fine ? 24 : 12, -1.28, 1.28), circle(0.016 * L, fine ? 10 : 6), false);
    parts.push({ bone: 'Neck1', geo: roll, kind: 'bandana', at: col.center, axis: nAxis });
  }
  // harness: girth strap behind the front legs, a strap around the chest / neck base, a pad on the back
  const bAxis = t3.clone().sub(t2).normalize();
  const gAt = t2.clone().lerp(t3, 0.65);
  const girth = section(bind, gAt, bAxis, 0.05 * L);
  const hw = 0.075 * L;
  const ht = 0.02 * L;
  parts.push({ bone: 'Torso3', geo: strap(girth, bAxis, hw, ht, 1.01, fine), kind: 'harness', at: girth.center, axis: bAxis });
  // the front strap: around the chest just behind the neck, nearly upright
  const fAxis = bAxis.clone().lerp(nAxis, 0.3).normalize();
  const fAt = t3.clone().lerp(neck1, 0.5);
  const front = section(bind, fAt, fAxis, 0.05 * L);
  parts.push({ bone: 'Neck1', geo: strap(front, fAxis, hw * 0.85, ht, 1.01, fine), kind: 'harness', at: front.center, axis: fAxis });
  {
    // padded saddle on the back, between the tops of both straps (a rounded cushion)
    const a = ringPoint(girth, Math.PI, 1.01 + ht / Math.max(1e-3, girth.ry));
    const b = ringPoint(front, Math.PI, 1.01 + ht / Math.max(1e-3, front.ry));
    const mid = a.clone().lerp(b, 0.4);
    const len = a.distanceTo(b) * 0.75 + hw;
    const pad = new SphereGeometry(1, fine ? 32 : 16, fine ? 16 : 8);
    const pp = pad.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const sx = pp.getX(i);
      const sz = pp.getZ(i);
      // boxier outline, a soft round top
      pp.setXYZ(i, Math.sign(sx) * Math.abs(sx) ** 0.6, pp.getY(i), Math.sign(sz) * Math.abs(sz) ** 0.6);
    }
    pad.computeVertexNormals();
    pad.scale(girth.rx * 0.6, 0.032 * L, len / 2);
    const dir = b.clone().sub(a).normalize();
    pad.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir));
    pad.translate(mid.x, mid.y + 0.004 * L, mid.z);
    parts.push({ bone: 'Torso3', geo: pad, kind: 'harness', at: girth.center.clone().lerp(front.center, 0.4) });
    // the D-ring the leash clips to
    const d = new TorusGeometry(0.032 * L, 0.0085 * L, 8, fine ? 24 : 14);
    d.rotateY(Math.PI / 2);
    d.translate(a.x, a.y + 0.055 * L, a.z + 0.02 * L);
    parts.push({ bone: 'Torso3', geo: d, kind: 'metal', at: girth.center.clone().lerp(front.center, 0.4) });
    // chest strap between both bottoms
    const c0 = ringPoint(girth, 0, 1.06);
    const c1 = ringPoint(front, 0, 1.06);
    const out = c0.clone().lerp(c1, 0.5).sub(girth.center.clone().lerp(front.center, 0.5)).normalize();
    const frames: Frame[] = [];
    for (let i = 0; i <= 6; i++) frames.push({ c: c0.clone().lerp(c1, i / 6).addScaledVector(out, ht * 0.3), n: out.clone(), a: new Vector3(1, 0, 0) });
    parts.push({ bone: 'Torso3', geo: sweep(frames, roundRect(hw * 0.55, ht * 0.8, fine ? 3 : 2), false), kind: 'harness', at: girth.center.clone().lerp(front.center, 0.5) });
  }
  for (const p of parts) {
    if (p.geo.index) p.geo = p.geo.toNonIndexed();
    p.geo.deleteAttribute('uv');
  }
  const tagOut = bottom.clone().sub(col.center).setX(0).normalize().multiplyScalar(0.05 * L).add(new Vector3(0, 0, 0.02 * L));
  const gear = { parts, tagOut };
  per.set(ck, gear);
  return gear;
}

/** How gear is skinned: the body mesh (skeleton, transform), a reference surface with skin weights + bindPos */
export interface GearSkin {
  body: SkinnedMesh;
  ref: BufferGeometry;
  /** model space → the body's vertex space (bind pose) */
  toLocal: Matrix4;
}

/** Reference points in a grid (nearest-neighbour lookups for skin weights), once per reference surface */
const refGrids = new WeakMap<BufferGeometry, { cell: number; map: Map<string, number[]> }>();
const GRID = 0.14;
function refGrid(ref: BufferGeometry) {
  let g = refGrids.get(ref);
  if (g) return g;
  const bp = ref.attributes.bindPos;
  const map = new Map<string, number[]>();
  for (let i = 0; i < bp.count; i++) {
    const k = `${Math.floor(bp.getX(i) / GRID)},${Math.floor(bp.getY(i) / GRID)},${Math.floor(bp.getZ(i) / GRID)}`;
    let l = map.get(k);
    if (!l) map.set(k, (l = []));
    l.push(i);
  }
  g = { cell: GRID, map };
  refGrids.set(ref, g);
  return g;
}

/** Skin weights for gear (model space positions): blended from the nearest points of the coat */
function skinGear(geo: BufferGeometry, ref: BufferGeometry, anchor?: Vector3, axis?: Vector3) {
  const grid = refGrid(ref);
  const bp = ref.attributes.bindPos;
  const si = ref.attributes.skinIndex;
  const sw = ref.attributes.skinWeight;
  const pos = geo.attributes.position;
  const n = pos.count;
  const SI = new Uint16Array(n * 4);
  const SW = new Float32Array(n * 4);
  const v = new Vector3();
  const weightsAt = (p: Vector3) => {
    const cx = Math.floor(p.x / grid.cell);
    const cy = Math.floor(p.y / grid.cell);
    const cz = Math.floor(p.z / grid.cell);
    const near: [number, number][] = [];
    const want = anchor ? 24 : 4;
    for (let r = 1; r <= 5 && near.length < want; r++) {
      near.length = 0;
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++)
            for (const i of grid.map.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              const d = (bp.getX(i) - p.x) ** 2 + (bp.getY(i) - p.y) ** 2 + (bp.getZ(i) - p.z) ** 2;
              near.push([d, i]);
            }
    }
    near.sort((a, b) => a[0] - b[0]);
    const acc = new Map<number, number>();
    for (const [d, i] of near.slice(0, anchor ? 24 : 6)) {
      const k = 1 / (d + 1e-4);
      for (let c = 0; c < 4; c++) {
        const w = sw.getComponent(i, c);
        if (w > 0) acc.set(si.getComponent(i, c), (acc.get(si.getComponent(i, c)) ?? 0) + w * k);
      }
    }
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((a, x) => a + x[1], 0) || 1;
    return top.map(([b, w]) => [b, w / sum] as [number, number]);
  };
  // a ring around the body: the mean skin of the coat in its plane (a neck strap moves with the neck)
  const ringWeights = (a: Vector3, ax: Vector3) => {
    const acc = new Map<number, number>();
    const d = new Vector3();
    for (let i = 0; i < bp.count; i++) {
      d.set(bp.getX(i) - a.x, bp.getY(i) - a.y, bp.getZ(i) - a.z);
      const along = d.dot(ax);
      if (Math.abs(along) > 0.12 || d.lengthSq() - along * along > 1.1) continue;
      for (let c = 0; c < 4; c++) {
        const w = sw.getComponent(i, c);
        if (w > 0) acc.set(si.getComponent(i, c), (acc.get(si.getComponent(i, c)) ?? 0) + w);
      }
    }
    if (!acc.size) return weightsAt(a);
    const top = [...acc].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const sum = top.reduce((x, t) => x + t[1], 0) || 1;
    return top.map(([b, w]) => [b, w / sum] as [number, number]);
  };
  const fixed = anchor ? (axis ? ringWeights(anchor, axis) : weightsAt(anchor)) : undefined;
  for (let i = 0; i < n; i++) {
    const w = fixed ?? weightsAt(v.fromBufferAttribute(pos, i));
    for (let c = 0; c < 4; c++) {
      SI[i * 4 + c] = w[c]?.[0] ?? 0;
      SW[i * 4 + c] = w[c]?.[1] ?? 0;
    }
  }
  geo.setAttribute('skinIndex', new BufferAttribute(SI, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(SW, 4));
}

/**
 * Attach the gear the look asks for to a dog (geometry moved into bone space, merged per bone and material).
 * Returns the materials (for disposal).
 */
export function attachGear(model: Object3D, gear: Gear, look: PetLook, skin?: GearSkin): Material[] {
  const want = (k: Gear['parts'][number]['kind']) =>
    k === 'collar'
      ? look.collar !== 'none'
      : k === 'tag'
        ? look.collar !== 'none' && !!look.tag
        : k === 'harness'
          ? !!look.harness
          : k === 'bandana'
            ? !!look.bandana
            : // metal: the tag ring with the tag, the D-ring with the harness
              true;
  const mats = new Map<string, Material>();
  const mat = (kind: string): Material => {
    let m = mats.get(kind);
    if (m) return m;
    // webbing with a soft sheen, cloth matte, metal with a coloured highlight (no environment map needed)
    if (kind === 'collar') m = new MeshPhongMaterial({ color: new Color(look.collar), shininess: 26, specular: new Color(0.16, 0.16, 0.16) });
    else if (kind === 'harness') m = new MeshPhongMaterial({ color: new Color(look.harness ?? '#3a6fd8'), shininess: 18, specular: new Color(0.12, 0.12, 0.12) });
    else if (kind === 'bandana') m = new MeshLambertMaterial({ color: new Color(look.bandana ?? '#d8483a'), side: 2 });
    else if (kind === 'tag') {
      const c = new Color(look.tag ?? '#d4af37');
      m = new MeshPhongMaterial({ color: c.clone().multiplyScalar(0.85), specular: c.clone().lerp(new Color(1, 1, 1), 0.4), shininess: 60, emissive: c.clone().multiplyScalar(0.1) });
    } else m = new MeshPhongMaterial({ color: new Color('#a9aeb5'), shininess: 110, specular: new Color(0.85, 0.85, 0.85) });
    mats.set(kind, m);
    return m;
  };
  model.updateMatrixWorld(true);
  const groups = new Map<string, Gear['parts']>();
  const metalFor = (i: number) => {
    // which metal part belongs to what: the first metal (tag ring) to the collar tag, the second (D-ring) to the harness
    const metals = gear.parts.filter((p) => p.kind === 'metal');
    const idx = metals.indexOf(gear.parts[i]);
    return idx === 0 ? look.collar !== 'none' && !!look.tag : !!look.harness;
  };
  gear.parts.forEach((p, i) => {
    if (!want(p.kind) || (p.kind === 'metal' && !metalFor(i))) return;
    const k = `${p.bone}|${p.kind}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  });
  for (const [k, list] of groups) {
    const [bone, kind] = k.split('|');
    const b = model.getObjectByName(bone);
    if (!b) continue;
    const tagged = look.bandana && bone === 'Neck1' && (kind === 'tag' || kind === 'metal');
    const g = mergeGeometries(
      list.map((x) => {
        const c = x.geo.clone();
        // over the neckerchief: tag and its ring hang in front of the cloth
        if (tagged) c.translate(gear.tagOut.x, gear.tagOut.y, gear.tagOut.z);
        // each piece keeps its shape: one blend of bones for all of it, taken where it sits on the dog
        if (skin) skinGear(c, skin.ref, x.at, x.axis);
        return c;
      }),
    )!;
    let m: Mesh;
    if (skin) {
      // skinned like the coat beneath it: follows neck and chest smoothly in every pose
      g.applyMatrix4(skin.toLocal);
      const sm = new SkinnedMesh(g, mat(kind));
      sm.position.copy(skin.body.position);
      sm.quaternion.copy(skin.body.quaternion);
      sm.scale.copy(skin.body.scale);
      skin.body.parent?.add(sm);
      sm.bind(skin.body.skeleton, skin.body.bindMatrix);
      m = sm;
    } else {
      g.applyMatrix4(b.matrixWorld.clone().invert());
      m = new Mesh(g, mat(kind));
      b.add(m);
    }
    m.name = `gear-${kind}`;
    m.castShadow = true;
    m.frustumCulled = false;
    m.userData.ownGeo = true;
  }
  return [...mats.values()];
}
