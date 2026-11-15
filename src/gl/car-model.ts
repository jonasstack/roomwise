import { Box3, Color, Group, Mesh, MeshBasicMaterial, MeshPhongMaterial, Object3D, Vector3, type Material } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarShape } from '../cars';
import { assetUrl } from '../assets';

/**
 * Cars from CC0 models (Quaternius): compact, saloon, SUV — clean and modern. Recoloured to the car's paint,
 * LED-white headlights, red tail lights, tinted glass; stretched to the chosen model's real size.
 * Micro cars use the compact, vans the SUV — stretched to their real size.
 */
export type CarModel = 'hatch' | 'sedan' | 'suv';

export function carModelFor(shape: CarShape): CarModel | undefined {
  switch (shape.body) {
    case 'hatch':
    case 'estate':
    case 'micro':
      return 'hatch';
    case 'sedan':
    case 'coupe':
    case 'onebow':
      return 'sedan';
    case 'suv':
    case 'box':
    case 'van':
      return 'suv';
  }
  return undefined;
}

const cache = new Map<CarModel, Promise<Object3D | undefined>>();

function url(name: string): string {
  return assetUrl(`models/${name}.glb`);
}

export function loadCar(model: CarModel): Promise<Object3D | undefined> {
  let p = cache.get(model);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(url(`car-${model}`))
      .then((g) => g.scene)
      .catch((err) => {
        console.info('[floorplan-card] car model not available', err);
        return undefined;
      });
    cache.set(model, p);
  }
  return p;
}

const retries = new Map<CarModel, Promise<Object3D | undefined>>();

/** After a failed load (no network yet, server restarting): try again a few times, waiting longer each time */
export function retryCar(model: CarModel): Promise<Object3D | undefined> {
  let p = retries.get(model);
  if (!p) {
    p = (async () => {
      for (const wait of [15000, 60000, 300000]) {
        await new Promise((r) => setTimeout(r, wait));
        cache.delete(model);
        const src = await loadCar(model);
        if (src) return src;
      }
      return undefined;
    })().finally(() => retries.delete(model));
    retries.set(model, p);
  }
  return p;
}

/** A car in the card's frame (z up, front +x) at its real size */
export function carFromModel(src: Object3D, L: number, W: number, H: number, paint: string, ghost: boolean, mat: (key: string, make: () => Material) => Material): Group {
  const model = src.clone(true);
  const holder = new Group();
  holder.rotation.x = Math.PI / 2; // glTF y up → z up
  holder.add(model);
  holder.updateMatrixWorld(true);
  // which end is the front: where the headlights are
  const box = new Box3().setFromObject(holder);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const lights = new Box3();
  model.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && (Array.isArray(m.material) ? m.material : [m.material]).some((x) => /headlight/i.test(x.name))) lights.expandByObject(m);
  });
  const lc = lights.isEmpty() ? new Vector3(box.max.x, center.y, center.z) : lights.getCenter(new Vector3());
  const alongX = size.x >= size.y;
  const turn = new Group();
  turn.add(holder);
  if (alongX) turn.rotation.z = lc.x < center.x ? Math.PI : 0;
  else turn.rotation.z = lc.y < center.y ? Math.PI / 2 : -Math.PI / 2;
  const len = alongX ? size.x : size.y;
  const wid = alongX ? size.y : size.x;
  holder.position.set(-center.x, -center.y, -box.min.z);
  turn.scale.set(L / len, W / wid, H / size.z);
  const out = new Group();
  out.add(turn);
  const op = ghost ? 0.2 : 1;
  const tr = ghost ? { transparent: true, opacity: op, depthWrite: false } : {};
  model.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.castShadow = !ghost;
    m.receiveShadow = !ghost;
    if (ghost) m.renderOrder = 3;
    const map = (x: Material): Material => {
      const n = x.name.toLowerCase();
      if (/window/.test(n)) return mat(`cm|glass|${op}`, () => new MeshPhongMaterial({ color: new Color('#141a22'), specular: new Color(0.08, 0.09, 0.1), shininess: 70, ...tr }));
      if (/headlight/.test(n)) return mat(`cm|head|${op}`, () => new MeshBasicMaterial({ color: new Color(ghost ? '#8a8f96' : '#f2f6ff'), ...tr }));
      if (/tail/.test(n)) return mat(`cm|tail|${op}`, () => new MeshBasicMaterial({ color: new Color(ghost ? '#8a5a5a' : '#e0322a'), ...tr }));
      if (/black/.test(n)) return mat(`cm|black|${op}`, () => new MeshPhongMaterial({ color: new Color('#16171a'), specular: new Color(0.04, 0.04, 0.04), shininess: 20, ...tr }));
      if (/grey|gray|material/.test(n)) return mat(`cm|grey|${op}`, () => new MeshPhongMaterial({ color: new Color(n.includes('material') ? '#b9bec4' : '#3a3d42'), specular: new Color(0.1, 0.1, 0.1), shininess: 40, ...tr }));
      // the body: the model's first (main) colour
      return mat(`cm|paint|${paint}|${op}`, () => new MeshPhongMaterial({ color: new Color(paint), specular: new Color(0.09, 0.09, 0.1), shininess: 45, ...tr }));
    };
    m.material = Array.isArray(m.material) ? m.material.map(map) : map(m.material);
  });
  return out;
}
