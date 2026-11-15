import { AmbientLight, BufferGeometry, DirectionalLight, HemisphereLight, Material, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { buildCarMesh } from './car';
import { carFromModel, carModelFor, loadCar } from './car-model';
import type { CarShape } from '../cars';

/**
 * A still image of a car, rendered from the very same 3D model as in the plan (three-quarter view from the
 * front left), for the car overview. One small offscreen renderer is kept for a while and then released.
 */
const images = new Map<string, Promise<string | undefined>>();
let renderer: WebGLRenderer | undefined;
let releaseTimer: number | undefined;

function getRenderer(): WebGLRenderer | undefined {
  clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer = undefined;
  }, 15000);
  if (renderer) return renderer;
  try {
    const canvas = document.createElement('canvas');
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    return renderer;
  } catch {
    return undefined;
  }
}

export function carImage(shape: CarShape, L: number, W: number, H: number, paint: string, roof: string | undefined): Promise<string | undefined> {
  const key = `${shape.de}|${L}|${W}|${H}|${paint}|${roof ?? ''}`;
  let p = images.get(key);
  if (p) return p;
  const cm = carModelFor(shape);
  p = (cm ? loadCar(cm) : Promise.resolve(undefined)).then((src) => new Promise<string | undefined>((resolve) => {
    requestAnimationFrame(() => {
      const r = getRenderer();
      if (!r) return resolve(undefined);
      const w = 720;
      const h = 360;
      r.setSize(w, h, false);
      r.setPixelRatio(1);
      const scene = new Scene();
      const geos: BufferGeometry[] = [];
      const mats = new Map<string, Material>();
      const matFn = (k: string, make: () => Material) => {
        let m = mats.get(k);
        if (!m) mats.set(k, (m = make()));
        return m;
      };
      const car = src ? carFromModel(src, L, W, H, paint, false, matFn) : buildCarMesh(shape, L, W, H, paint, roof, false, { mat: matFn, own: (g) => geos.push(g) });
      scene.add(car);
      scene.add(new HemisphereLight(0xffffff, 0xb8b2a8, 2.4));
      scene.add(new AmbientLight(0xffffff, 0.35));
      const sun = new DirectionalLight(0xffffff, 2.6);
      sun.position.set(L * 0.6, -W * 2.2, H * 3);
      scene.add(sun);
      const fill = new DirectionalLight(0xdfe8ff, 0.9);
      fill.position.set(-L, W * 2, H);
      scene.add(fill);
      // three-quarter view from the front left, slightly above
      const cam = new PerspectiveCamera(26, w / h, 10, 5000);
      cam.up.set(0, 0, 1);
      const target = new Vector3(L * 0.03, 0, H * 0.4);
      const dist = Math.max(L * 1.55, W * 3.2);
      cam.position.set(dist * 0.55, -dist * 0.8, H * 0.4 + dist * 0.22);
      cam.lookAt(target);
      r.render(scene, cam);
      const url = r.domElement.toDataURL('image/png');
      for (const g of geos) g.dispose();
      for (const m of mats.values()) m.dispose();
      resolve(url);
    });
  }));
  images.set(key, p);
  return p;
}
