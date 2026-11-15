// Standalone close-up studio for the dog's face (no Home Assistant): bundled by tools/look/dog-face.mjs.
import { Vector3, type Material, type SkinnedMesh } from 'three';
import { DogStudio } from '../../../src/gl/dog-studio';
import { DOG_BREEDS, type PetLook } from '../../../src/pets';

const w = window as unknown as Record<string, unknown>;
w.DOG_BREEDS = DOG_BREEDS;
/** Render one still dog: look overrides, camera azimuth/elevation (rad), zoom, look-at point; resolves when drawn */
w.renderDog = async (o: { look: Partial<PetLook>; az: number; el: number; zoom: number; face?: boolean; pose?: string; fine?: boolean; size?: [number, number] }) => {
  const canvas = document.querySelector('canvas')!;
  const st = ((w.__studio as DogStudio | undefined) ?? (w.__studio = new DogStudio(canvas))) as DogStudio;
  st.animate = false;
  st.fine = o.fine !== false;
  const [cw, ch] = o.size ?? [480, 400];
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  st.setSize(cw, ch, 1);
  const b = o.look.breed ?? 'medium';
  const look = { breed: b, fur: '#c8a27a', marks: '#f1ebe1', markings: 'belly', ears: DOG_BREEDS[b]?.ears ?? 'floppy', tail: DOG_BREEDS[b]?.tail ?? 'long', collar: '#d8483a', pose: 'standing', tag: '#d4af37', eyes: '#3a2618', seed: 1, paint: [], ...o.look } as PetLook;
  await st.show(look, { length: 60, height: 40, width: 22 }, (o.pose ?? 'Idle') as never);
  const s = st as unknown as { az: number; el: number; zoomK: number; target: { x: number; z: number }; place(): void };
  s.az = o.az;
  s.el = o.el;
  s.zoomK = o.zoom;
  // face: look at the head bone, a little to the front
  const head = o.face ? st.actor?.bone('Head') : undefined;
  if (head) {
    st.actor!.group.updateMatrixWorld(true);
    const p = head.getWorldPosition(new Vector3());
    s.target.x = p.x + 4;
    s.target.z = p.z + 1;
  }
  s.place();
  st.render();
  return true;
};

/** Where the eyes and their catchlights are drawn (world space of the studio): centre per side */
w.eyeWorld = () => {
  const st = w.__studio as DogStudio;
  const out: Record<string, number[][]> = {};
  st.actor!.group.updateMatrixWorld(true);
  st.actor!.group.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!(m as unknown as { isMesh: boolean }).isMesh) return;
    const name = m.name === 'eye-spark' ? 'spark' : (m.material as Material).name;
    if (!/spark|Eyes/.test(name)) return;
    const sides = [new Vector3(), new Vector3()];
    const n = [0, 0];
    const v = new Vector3();
    const idx = m.geometry.index;
    const count = idx ? idx.count : m.geometry.attributes.position.count;
    for (let k = 0; k < count; k++) {
      const i = idx ? idx.getX(k) : k;
      if (m.isSkinnedMesh) m.getVertexPosition(i, v);
      else v.fromBufferAttribute(m.geometry.attributes.position, i);
      v.applyMatrix4(m.matrixWorld);
      const s = v.y >= 0 ? 0 : 1;
      sides[s].add(v);
      n[s]++;
    }
    (out[name] ??= []).push(...sides.map((s, i) => s.divideScalar(n[i] || 1).toArray().map((x) => +x.toFixed(2))));
  });
  return out;
};

/** Bind-pose landmarks (model space) of the shown dog's parts: centre and bounds per material */
w.dogInfo = () => {
  const out: Record<string, { c: number[]; min: number[]; max: number[] }> = {};
  const st = w.__studio as DogStudio;
  st.actor?.model.traverse((o) => {
    const m = o as SkinnedMesh;
    const bp = m.geometry?.attributes?.bindPos;
    if (!m.isSkinnedMesh || !bp) return;
    const min = [1e9, 1e9, 1e9];
    const max = [-1e9, -1e9, -1e9];
    const c = [0, 0, 0];
    for (let i = 0; i < bp.count; i++) {
      [bp.getX(i), bp.getY(i), bp.getZ(i)].forEach((x, k) => {
        min[k] = Math.min(min[k], x);
        max[k] = Math.max(max[k], x);
        c[k] += x / bp.count;
      });
    }
    const r = (a: number[]) => a.map((x) => +x.toFixed(3));
    out[`${(m.material as Material).name}:${m.name}`] = { c: r(c), min: r(min), max: r(max) };
  });
  return out;
};
