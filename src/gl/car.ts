import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PlaneGeometry,
  Vector2,
  Float32BufferAttribute,
} from 'three';
import { PROFILES, type CarShape } from '../cars';
import type { CarOpen } from '../car-info';

const UNIT_BOX = new BoxGeometry(1, 1, 1);

/**
 * What of a car is open, drawn onto either car model (frame: front +x, centred, ground at z 0; L × W × H cm):
 * tailgate and frunk lids lifted, the sunroof's opening dark with the panel slid back, doors swung out about their
 * front edge, open windows as a red band. Lids and doors in the car's paint with a red edge, so it reads at a glance.
 */
export function carOpenParts(L: number, W: number, H: number, paint: string, o: CarOpen, m: CarMaterials): Group | undefined {
  if (!o.trunk && !o.frunk && !o.sunroof && !o.flap && !o.doors.some(Boolean) && !o.windows.some(Boolean)) return undefined;
  const g = new Group();
  g.name = 'open-parts';
  const red = m.mat('car-open|red', () => new MeshBasicMaterial({ color: new Color('#ff3b30'), transparent: true, opacity: 0.9 }));
  const body = m.mat(`car-open|paint|${paint}`, () => new MeshPhongMaterial({ color: new Color(paint), specular: new Color(0.09, 0.09, 0.1), shininess: 45 }));
  const dark = m.mat('car-open|dark', () => new MeshBasicMaterial({ color: new Color('#0b0d10') }));
  const box = (mat: Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, parent: Group = g) => {
    const b = new Mesh(UNIT_BOX, mat);
    b.scale.set(sx, sy, sz);
    b.position.set(x, y, z);
    b.castShadow = true;
    parent.add(b);
    return b;
  };
  /** a lid hinged at x0 (top), lifted by `deg` towards +x (front lid) or -x (tailgate) */
  const lid = (x0: number, len: number, z: number, dir: 1 | -1, deg: number) => {
    const hinge = new Group();
    hinge.position.set(x0, 0, z);
    hinge.rotation.y = dir * deg * (Math.PI / 180);
    box(body, len, W * 0.82, 2.5, (-dir * len) / 2, 0, 0, hinge);
    box(red, len, W * 0.84, 0.8, (-dir * len) / 2, 0, -1.8, hinge);
    g.add(hinge);
  };
  if (o.trunk) lid(-L * 0.36, L * 0.16, H * 0.84, 1, -70);
  if (o.frunk) lid(L * 0.25, L * 0.22, H * 0.7, -1, -55);
  if (o.sunroof) {
    box(dark, L * 0.16, W * 0.46, 1, -L * 0.02, 0, H + 0.6);
    box(red, L * 0.17, W * 0.48, 0.4, -L * 0.02, 0, H + 0.2);
    box(body, L * 0.16, W * 0.46, 1.2, -L * 0.17, 0, H + 2);
  }
  if (o.flap) box(red, 10, 3, 9, -L * 0.33, W / 2 + 0.5, H * 0.55);
  // doors fl, fr, rl, rr: front = +x, left = +y (the model's left when facing +x)
  o.doors.forEach((open, i) => {
    if (!open) return;
    const front = i < 2;
    const left = i % 2 === 0;
    const len = L * (front ? 0.24 : 0.21);
    const hinge = new Group();
    hinge.position.set(front ? L * 0.16 : -L * 0.08, (left ? 1 : -1) * W * 0.49, H * 0.08);
    hinge.rotation.z = (left ? -1 : 1) * 0.75;
    box(body, len, 3, H * 0.52, -len / 2, 0, H * 0.27, hinge);
    box(red, len, 3.4, 1.5, -len / 2, 0, H * 0.54, hinge);
    g.add(hinge);
  });
  o.windows.forEach((open, i) => {
    if (!open) return;
    const front = i < 2;
    const left = i % 2 === 0;
    box(red, L * 0.17, 1.2, H * 0.12, front ? L * 0.06 : -L * 0.15, (left ? 1 : -1) * W * 0.47, H * 0.72);
  });
  return g;
}

/**
 * Cars in a calm, modern style: one softly rounded body extruded from the side profile of its class,
 * a single glossy black glass canopy, aero disc wheels, slim light bars front and rear and a soft
 * contact shadow — no fiddly details.
 * Frame: x = length (front +x), y = width, z = up; centimetres, origin on the ground at the centre.
 */

export interface CarMaterials {
  /** cached material factory of the scene */
  mat(key: string, make: () => Material): Material;
  own(g: BufferGeometry): void;
}

let shadowTex: CanvasTexture | undefined;
function contactShadow(): CanvasTexture {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  shadowTex = new CanvasTexture(c);
  return shadowTex;
}



export function buildCarMesh(shape: CarShape, L: number, W: number, H: number, paint: string, roofPaint: string | undefined, ghost: boolean, m: CarMaterials): Group {
  const P = PROFILES[shape.body];
  const g = new Group();
  const op = ghost ? 0.2 : 1;
  const tr = ghost ? { transparent: true, opacity: op, depthWrite: false } : {};
  const tyreMat = m.mat(`car2|tyre|${op}`, () => new MeshLambertMaterial({ color: new Color('#1a1b1d'), ...tr }));
  const discMat = m.mat(`car2|disc|${op}`, () => new MeshPhongMaterial({ color: new Color('#cfd3d8'), specular: new Color(0.12, 0.12, 0.12), shininess: 50, ...tr }));
  const frontMat = m.mat(`car2|front|${op}`, () => new MeshBasicMaterial({ color: new Color(ghost ? '#8a8f96' : '#f4f8ff'), ...tr }));
  const rearMat = m.mat(`car2|rear|${op}`, () => new MeshBasicMaterial({ color: new Color(ghost ? '#8a5a5a' : '#ff3b30'), ...tr }));
  const darkMat = m.mat(`car2|dark|${op}`, () => new MeshLambertMaterial({ color: new Color('#202226'), ...tr }));

  const add = (geo: BufferGeometry, mat: Material, cast = !ghost) => {
    m.own(geo);
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = !ghost;
    if (ghost) mesh.renderOrder = 3;
    g.add(mesh);
    return mesh;
  };

  const clear = Math.max(12, H * 0.09);
  const r = Math.min(42, Math.max(30, H * (shape.body === 'micro' ? 0.2 : shape.body === 'van' || shape.body === 'box' ? 0.21 : 0.235)));
  const xf = L / 2 - L * P.overF * 0.9;
  const xr = -L / 2 + L * P.overR * 0.9;
  const belt = H * P.belt;
  const hood = H * (P.hood - 0.01);
  const trunk = H * (P.trunk - 0.01);
  const notch = shape.body === 'sedan' || shape.body === 'coupe' || shape.body === 'onebow';
  const fastback = shape.body === 'coupe' || shape.body === 'onebow';

  // ---- body + glasshouse as ONE smooth surface: cross-sections along the length, lofted together.
  // Wheel arches, crowned shoulders, the tapering glasshouse and the rounded nose/tail come from the sections;
  // glass and roof are colour zones of the same surface.
  const archR = r * 1.13;
  const rearEnd = notch ? P.deck : 0.035;
  const smooth = (t: number) => {
    const k = Math.max(0, Math.min(1, t));
    return k * k * (3 - 2 * k);
  };
  const shoulderAt = (f: number) => {
    if (f > P.cowl) return belt - (belt - hood) * Math.pow((f - P.cowl) / (1 - P.cowl), 1.5);
    if (notch && f < P.deck) return trunk + (belt - trunk) * Math.pow(f / P.deck, 1.4);
    return belt;
  };
  const topAt = (f: number, sh: number) => {
    if (f >= P.cowl || f <= rearEnd) return sh;
    if (f > P.roofF) return sh + (H - sh) * smooth(((P.cowl - f) / (P.cowl - P.roofF)) * 1.05);
    if (f >= P.roofR) {
      const m2 = (2 * (f - (P.roofF + P.roofR) / 2)) / (P.roofF - P.roofR);
      return H - 3 * m2 * m2;
    }
    const k = Math.max(0, Math.min(1, (f - rearEnd) / (P.roofR - rearEnd)));
    // fastback / one bow: one long, even arch down to the tail
    return sh + (H - sh) * (fastback ? 1 - (1 - k) * (1 - k) : smooth(k));
  };
  const bottomAt = (x: number) => {
    let z = clear;
    for (const xw of [xf, xr]) {
      const dx = x - xw;
      if (Math.abs(dx) < archR) z = Math.max(z, r + Math.sqrt(archR * archR - dx * dx) * 0.92);
    }
    return z;
  };
  const N = 72; // sections
  const half: [number, number, string][] = []; // [y, z, zone] template filled per section
  const ringPts = 17;
  const zones: string[] = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const cPaint = new Color(paint);
  const cRoof = new Color(roofPaint ?? paint);
  const cGlass = new Color('#16202a');
  const cLow = cPaint.clone().multiplyScalar(0.92);
  const stationF: number[] = [];
  for (let i = 0; i <= N; i++) {
    // denser sections towards the rounded ends
    const u = -Math.cos((Math.PI * i) / N);
    const x = (u * L) / 2;
    const f = (x + L / 2) / L;
    stationF.push(f);
    const wx = (W / 2) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), 7)), 1 / 7);
    const sh = shoulderAt(f);
    const top = topAt(f, sh);
    const zb = Math.min(bottomAt(x), sh - 12);
    const rc = Math.min(14, wx * 0.25, (sh - zb) * 0.3);
    const cw0 = wx * 0.84;
    const cw1 = wx * 0.66;
    const glassH = top - sh;
    const roofZone = f < P.roofF - 0.02 && f > P.roofR + 0.015;
    half.length = 0;
    // bottom centre → bottom edge → side → shoulder → glasshouse side → roof centre (15 points)
    half.push([0, zb, 'low'], [wx - rc, zb, 'low'], [wx - rc * 0.3, zb + rc * 0.3, 'low'], [wx, zb + rc, 'body']);
    const gz = glassH > 3 ? 'glass' : 'body';
    const rz = roofZone ? 'roof' : gz;
    half.push([wx * 1.015, zb + (sh - zb) * 0.55, 'body'], [wx, sh - rc * 0.9, 'body'], [wx - rc * 0.35, sh - rc * 0.25, 'body'], [wx - rc * 1.1, sh + 0.5, 'body']);
    // the same point twice at each colour border: crisp edges between paint and glass
    half.push([cw0, sh + Math.min(2, glassH * 0.1), 'body'], [cw0, sh + Math.min(2, glassH * 0.1), gz], [cw0 - (cw0 - cw1) * 0.5, sh + glassH * 0.5, gz], [cw1 + 2, top - Math.min(8, glassH * 0.25), gz]);
    half.push([cw1 - 4, top - Math.min(2, glassH * 0.05), gz], [cw1 - 4, top - Math.min(2, glassH * 0.05), rz], [cw1 * 0.6, top + 2.2, rz], [cw1 * 0.3, top + 3.4, rz], [0, top + 3.8, rz]);
    // full ring: right half up, left half back down (mirrored)
    const ring: [number, number, string][] = [...half, ...half.slice(0, -1).reverse().map(([y, z, zone]) => [-y, z, zone] as [number, number, string])];
    for (const [y, z, zone] of ring) {
      positions.push(x, y, z);
      const c = zone === 'glass' ? cGlass : zone === 'roof' ? cRoof : zone === 'low' ? cLow : cPaint;
      colors.push(c.r, c.g, c.b);
      zones.push(zone);
    }
  }
  const per = ringPts * 2 - 1;
  // faces are split by zone: paint (with its colours) and glass (own, calmer material)
  const paintIdx: number[] = [];
  const glassIdx: number[] = [];
  const lightF: number[] = [];
  const lightR: number[] = [];
  const panel: number[] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < per; j++) {
      const a0 = i * per + j;
      const a1 = i * per + ((j + 1) % per);
      const b0 = (i + 1) * per + j;
      const b1 = (i + 1) * per + ((j + 1) % per);
      const glassy = [a0, a1, b0, b1].filter((k) => zones[k] === 'glass').length >= 3;
      // light bands and the black front panel: zones on the nose and the tail of the same surface
      const hj = j < ringPts ? j : per - j - 1;
      const fi = stationF[i + 1];
      const fo = stationF[i];
      let target = glassy ? glassIdx : paintIdx;
      if (fi > 0.99 && hj === 5) target = lightF;
      else if (fo < 0.01 && hj === 5) target = lightR;
      else if (fi > 0.985 && hj === 4 && shape.ev) target = panel;
      target.push(a0, a1, b0, a1, b1, b0);
    }
  const bodyGeo = new BufferGeometry();
  bodyGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  bodyGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  bodyGeo.setIndex([...paintIdx, ...glassIdx, ...lightF, ...lightR, ...panel]);
  let at = 0;
  for (const [n, mi] of [[paintIdx.length, 0], [glassIdx.length, 1], [lightF.length, 2], [lightR.length, 3], [panel.length, 4]] as const) {
    bodyGeo.addGroup(at, n, mi);
    at += n;
  }
  bodyGeo.computeVertexNormals();
  const bodyMat = m.mat(`car3|body|${op}`, () => new MeshPhongMaterial({ color: 0xffffff, vertexColors: true, specular: new Color(0.07, 0.07, 0.075), shininess: 40, ...tr }));
  const glassMat = m.mat(`car3|glass|${op}`, () => new MeshPhongMaterial({ color: new Color('#121820'), specular: new Color(0.05, 0.055, 0.065), shininess: 60, ...tr }));
  m.own(bodyGeo);
  const panelMat = m.mat(`car3|panel|${op}`, () => new MeshPhongMaterial({ color: new Color('#0d0f12'), specular: new Color(0.12, 0.12, 0.13), shininess: 90, ...tr }));
  const bodyMesh = new Mesh(bodyGeo, [bodyMat, glassMat, frontMat, rearMat, panelMat]);
  bodyMesh.castShadow = !ghost;
  bodyMesh.receiveShadow = !ghost;
  if (ghost) bodyMesh.renderOrder = 3;
  g.add(bodyMesh);
  if (shape.star) {
    const star = add(new CylinderGeometry(4, 4, 1, 24), discMat, false);
    star.rotation.z = Math.PI / 2;
    star.position.set(L / 2 - 1.5, 0, clear + (hood - clear) * 0.5);
  }

  // ---- wheels: rounded tyre and a flat aero disc
  const tw = Math.min(24, W * 0.13);
  const prof: Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    prof.push(new Vector2(r * 0.7 + Math.sin(a) * r * 0.3, -tw / 2 + (1 - Math.cos(a)) * (tw / 2)));
  }
  const tyreGeo = new LatheGeometry(prof, 32);
  const discGeo = new CylinderGeometry(r * 0.72, r * 0.72, 1.2, 32);
  const capGeo = new CylinderGeometry(r * 0.18, r * 0.18, 1.6, 20);
  m.own(tyreGeo);
  m.own(discGeo);
  m.own(capGeo);
  for (const x of [xf, xr])
    for (const side of [1, -1]) {
      const wheel = new Group();
      wheel.position.set(x, side * (W / 2 - tw / 2 - 2), r);
      const tyre = new Mesh(tyreGeo, tyreMat);
      tyre.castShadow = !ghost;
      wheel.add(tyre);
      const disc = new Mesh(discGeo, discMat);
      disc.position.y = side * (tw / 2 - 1.5);
      wheel.add(disc);
      const cap = new Mesh(capGeo, darkMat);
      cap.position.y = side * (tw / 2 - 0.6);
      wheel.add(cap);
      g.add(wheel);
    }

  // ---- soft contact shadow under the car
  if (!ghost) {
    const sh = new Mesh(new PlaneGeometry(1, 1), m.mat('car2|shadow', () => new MeshBasicMaterial({ map: contactShadow(), transparent: true, depthWrite: false, opacity: 0.85 })));
    m.own(sh.geometry);
    sh.scale.set(L * 1.08, W * 1.3, 1);
    sh.position.z = 0.4;
    sh.renderOrder = 1;
    sh.raycast = () => {};
    g.add(sh);
  }
  return g;
}
