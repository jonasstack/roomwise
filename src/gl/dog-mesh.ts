import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

/**
 * Mesh tools for the dog: a smooth subdivision of the low-poly body (skin weights carried along) and the
 * wool coat as one continuous, skinned surface (smooth union of soft ellipsoids, polygonised with surface nets)
 * instead of a pile of separate balls.
 */

// ---------- skin weights ----------

type Skin = Map<number, number>;

function readSkin(idx: BufferAttribute, wgt: BufferAttribute, i: number): Skin {
  const s: Skin = new Map();
  for (let c = 0; c < 4; c++) {
    const w = wgt.getComponent(i, c);
    if (w > 0) s.set(idx.getComponent(i, c), (s.get(idx.getComponent(i, c)) ?? 0) + w);
  }
  return s;
}

function mixSkin(out: Skin, s: Skin, k: number) {
  for (const [b, w] of s) out.set(b, (out.get(b) ?? 0) + w * k);
}

/** The four strongest bones, normalised */
function writeSkin(s: Skin, idx: Uint16Array, wgt: Float32Array, i: number) {
  const top = [...s].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((a, x) => a + x[1], 0) || 1;
  for (let c = 0; c < 4; c++) {
    idx[i * 4 + c] = top[c]?.[0] ?? 0;
    wgt[i * 4 + c] = top[c] ? top[c][1] / sum : 0;
  }
}

// ---------- subdivision ----------

/**
 * Loop subdivision of an indexed, skinned triangle mesh. `smooth` blends between plain midpoint splitting (0,
 * keeps the shape) and full Loop smoothing (1, rounder, thin parts shrink a little). Faces keep their group
 * (`faceGroup`, one entry per triangle). Open edges stay creases (both sides of a seam between materials split
 * the same way).
 */
export function loopSubdivide(geo: BufferGeometry, faceGroup: Uint8Array, smooth = 0.8): { geo: BufferGeometry; faceGroup: Uint8Array } {
  const pos = geo.attributes.position as BufferAttribute;
  const sIdx = geo.attributes.skinIndex as BufferAttribute | undefined;
  const sWgt = geo.attributes.skinWeight as BufferAttribute | undefined;
  const index = geo.index!.array;
  const nv = pos.count;
  const nf = index.length / 3;
  // edges: key → new vertex id; opposite corners
  const edgeId = new Map<number, number>();
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeOpp: number[][] = [];
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const faceEdges = new Int32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = index[f * 3 + k];
      const b = index[f * 3 + ((k + 1) % 3)];
      const c = index[f * 3 + ((k + 2) % 3)];
      const kk = key(a, b);
      let e = edgeId.get(kk);
      if (e === undefined) {
        e = edgeA.length;
        edgeId.set(kk, e);
        edgeA.push(a);
        edgeB.push(b);
        edgeOpp.push([]);
      }
      edgeOpp[e].push(c);
      faceEdges[f * 3 + k] = e;
    }
  }
  const ne = edgeA.length;
  // neighbours of every old vertex, and its boundary neighbours
  const nbr: Set<number>[] = Array.from({ length: nv }, () => new Set());
  const bnd: number[][] = Array.from({ length: nv }, () => []);
  for (let e = 0; e < ne; e++) {
    const a = edgeA[e];
    const b = edgeB[e];
    nbr[a].add(b);
    nbr[b].add(a);
    if (edgeOpp[e].length !== 2) {
      bnd[a].push(b);
      bnd[b].push(a);
    }
  }
  const total = nv + ne;
  const P = new Float32Array(total * 3);
  const SI = sIdx ? new Uint16Array(total * 4) : undefined;
  const SW = sWgt ? new Float32Array(total * 4) : undefined;
  const v = new Vector3();
  const t = new Vector3();
  const get = (i: number, out: Vector3) => out.fromBufferAttribute(pos, i);
  // old vertices
  for (let i = 0; i < nv; i++) {
    get(i, v);
    const acc = new Vector3();
    if (bnd[i].length >= 2) {
      // crease: along the open edge only
      if (bnd[i].length === 2) {
        acc.copy(v).multiplyScalar(0.75);
        for (const j of bnd[i]) acc.addScaledVector(get(j, t), 0.125);
      } else acc.copy(v);
    } else {
      const n = nbr[i].size;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      acc.copy(v).multiplyScalar(1 - n * beta);
      for (const j of nbr[i]) acc.addScaledVector(get(j, t), beta);
    }
    acc.lerp(v, 1 - smooth);
    P[i * 3] = acc.x;
    P[i * 3 + 1] = acc.y;
    P[i * 3 + 2] = acc.z;
    if (SI && SW) for (let c = 0; c < 4; c++) {
      SI[i * 4 + c] = sIdx!.getComponent(i, c);
      SW[i * 4 + c] = sWgt!.getComponent(i, c);
    }
  }
  // edge vertices
  const a3 = new Vector3();
  const b3 = new Vector3();
  for (let e = 0; e < ne; e++) {
    const a = edgeA[e];
    const b = edgeB[e];
    get(a, a3);
    get(b, b3);
    const mid = a3.clone().add(b3).multiplyScalar(0.5);
    let p = mid;
    if (edgeOpp[e].length === 2) {
      const loop = a3.clone().add(b3).multiplyScalar(0.375).addScaledVector(get(edgeOpp[e][0], t), 0.125).addScaledVector(get(edgeOpp[e][1], t), 0.125);
      p = mid.lerp(loop, smooth);
    }
    const i = nv + e;
    P[i * 3] = p.x;
    P[i * 3 + 1] = p.y;
    P[i * 3 + 2] = p.z;
    if (SI && SW) {
      const s: Skin = new Map();
      mixSkin(s, readSkin(sIdx!, sWgt!, a), 0.5);
      mixSkin(s, readSkin(sIdx!, sWgt!, b), 0.5);
      writeSkin(s, SI, SW, i);
    }
  }
  // four faces per face
  const I = new Uint32Array(nf * 12);
  const G = new Uint8Array(nf * 4);
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3];
    const b = index[f * 3 + 1];
    const c = index[f * 3 + 2];
    const ab = nv + faceEdges[f * 3];
    const bc = nv + faceEdges[f * 3 + 1];
    const ca = nv + faceEdges[f * 3 + 2];
    I.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], f * 12);
    G.fill(faceGroup[f], f * 4, f * 4 + 4);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(P, 3));
  if (SI && SW) {
    out.setAttribute('skinIndex', new BufferAttribute(SI, 4));
    out.setAttribute('skinWeight', new BufferAttribute(SW, 4));
  }
  out.setIndex(new BufferAttribute(I, 1));
  return { geo: out, faceGroup: G };
}

/** The faces of one group as their own geometry sharing the vertex data */
export function pickGroup(geo: BufferGeometry, faceGroup: Uint8Array, g: number): BufferGeometry {
  const src = geo.index!.array;
  const keep: number[] = [];
  for (let f = 0; f < faceGroup.length; f++) if (faceGroup[f] === g) keep.push(src[f * 3], src[f * 3 + 1], src[f * 3 + 2]);
  const out = new BufferGeometry();
  for (const [n, a] of Object.entries(geo.attributes)) out.setAttribute(n, a);
  out.setIndex(new BufferAttribute(new Uint32Array(keep), 1));
  return out;
}

// ---------- wool ----------

/** One soft ellipsoid of the coat, on a bone */
export interface WoolBlob {
  c: Vector3;
  r: Vector3;
  bone: number;
  /** how much it melts into its neighbours (model units) */
  melt: number;
}

/** Signed distance to an ellipsoid (good approximation near the surface) */
function ellDist(px: number, py: number, pz: number, b: WoolBlob): number {
  const x = (px - b.c.x) / b.r.x;
  const y = (py - b.c.y) / b.r.y;
  const z = (pz - b.c.z) / b.r.z;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  const k1 = Math.sqrt((x * x) / (b.r.x * b.r.x) + (y * y) / (b.r.y * b.r.y) + (z * z) / (b.r.z * b.r.z));
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(b.r.x, b.r.y, b.r.z);
}

function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const fract = (x: number) => x - Math.floor(x);
/** The coat shader's hash (same numbers on both sides: the curls in the silhouette meet the shaded ones) */
function fhash(x: number, y: number, z: number): number {
  x = fract(x * 0.3183099 + 0.1) * 17;
  y = fract(y * 0.3183099 + 0.1) * 17;
  z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}

/**
 * 3D curl pattern (a field of small round curls, as in the coat shader): 0 in the gaps, 1 on a curl's crown.
 * Jittered points on a grid of cell size `cell`.
 */
export function curlHeight(x: number, y: number, z: number, cell: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const iz = Math.floor(gz);
  let best = 9;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;
        const px = cx + 0.15 + 0.7 * fhash(cx, cy, cz);
        const py = cy + 0.15 + 0.7 * fhash(cx + 17.3, cy + 17.3, cz + 17.3);
        const pz = cz + 0.15 + 0.7 * fhash(cx + 41.9, cy + 41.9, cz + 41.9);
        const d = (gx - px) ** 2 + (gy - py) ** 2 + (gz - pz) ** 2;
        if (d < best) best = d;
      }
  return Math.max(0, 1 - best * 1.6);
}

/**
 * The coat as one surface: smooth union of the blobs, polygonised on a grid of `cell` (surface nets, a few
 * smoothing passes), optionally displaced by small curls. Skin weights from the blobs nearby (their bones), so it
 * bends softly with the skeleton. Positions in model space (bind pose).
 */
export function woolSurface(blobs: WoolBlob[], cell: number, curl: { cell: number; depth: number } | undefined): BufferGeometry | undefined {
  if (!blobs.length) return undefined;
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const b of blobs) {
    lo.min(b.c.clone().sub(b.r).subScalar(b.melt + cell * 2));
    hi.max(b.c.clone().add(b.r).addScalar(b.melt + cell * 2));
  }
  const nx = Math.ceil((hi.x - lo.x) / cell) + 1;
  const ny = Math.ceil((hi.y - lo.y) / cell) + 1;
  const nz = Math.ceil((hi.z - lo.z) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // only blobs near a point matter: bucket by bounds
  for (let k = 0; k < nz; k++) {
    const z = lo.z + k * cell;
    const zs = blobs.filter((b) => Math.abs(z - b.c.z) < b.r.z + b.melt + cell * 2);
    for (let j = 0; j < ny; j++) {
      const y = lo.y + j * cell;
      const ys = zs.filter((b) => Math.abs(y - b.c.y) < b.r.y + b.melt + cell * 2);
      for (let i = 0; i < nx; i++) {
        const x = lo.x + i * cell;
        let d = 1e3;
        for (const b of ys) {
          if (Math.abs(x - b.c.x) > b.r.x + b.melt + cell * 2) continue;
          d = smin(d, ellDist(x, y, z, b), b.melt);
        }
        field[at(i, j, k)] = d;
      }
    }
  }
  // surface nets: one vertex per cell with a sign change, at the mean of the edge crossings
  const vid = new Int32Array(nx * ny * nz).fill(-1);
  const P: number[] = [];
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const vals = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [a, b, d] = corners[c];
          vals[c] = field[at(i + a, j + b, k + d)];
          if (vals[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [e0, e1] of edges) {
          const v0 = vals[e0];
          const v1 = vals[e1];
          if (v0 < 0 === v1 < 0) continue;
          const t = v0 / (v0 - v1);
          const [a0, b0, c0] = corners[e0];
          const [a1, b1, c1] = corners[e1];
          sx += a0 + (a1 - a0) * t;
          sy += b0 + (b1 - b0) * t;
          sz += c0 + (c1 - c0) * t;
          n++;
        }
        vid[at(i, j, k)] = P.length / 3;
        P.push(lo.x + (i + sx / n) * cell, lo.y + (j + sy / n) * cell, lo.z + (k + sz / n) * cell);
      }
  // quads across every grid edge with a sign change
  const I: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) I.push(a, c, b, a, d, c);
    else I.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const f0 = field[at(i, j, k)] < 0;
        // x edge (i,j,k)-(i+1,j,k): cells around it share y,z
        if (i < nx - 1 && f0 !== field[at(i + 1, j, k)] < 0) quad(vid[at(i, j - 1, k - 1)], vid[at(i, j, k - 1)], vid[at(i, j, k)], vid[at(i, j - 1, k)], !f0);
        if (j < ny - 1 && f0 !== field[at(i, j + 1, k)] < 0) quad(vid[at(i - 1, j, k - 1)], vid[at(i - 1, j, k)], vid[at(i, j, k)], vid[at(i, j, k - 1)], !f0);
        if (k < nz - 1 && f0 !== field[at(i, j, k + 1)] < 0) quad(vid[at(i - 1, j - 1, k)], vid[at(i, j - 1, k)], vid[at(i, j, k)], vid[at(i - 1, j, k)], !f0);
      }
  const nv = P.length / 3;
  if (!nv || !I.length) return undefined;
  // relax: a few Laplacian passes (surface nets are a little stepped)
  const nb: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < I.length; f += 3)
    for (let e = 0; e < 3; e++) {
      const a = I[f + e];
      const b = I[f + ((e + 1) % 3)];
      nb[a].push(b);
      nb[b].push(a);
    }
  let cur = Float32Array.from(P);
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(cur.length);
    for (let v = 0; v < nv; v++) {
      const list = nb[v];
      let x = 0;
      let y = 0;
      let z = 0;
      for (const u of list) {
        x += cur[u * 3];
        y += cur[u * 3 + 1];
        z += cur[u * 3 + 2];
      }
      const n = list.length || 1;
      const k = 0.5;
      next[v * 3] = cur[v * 3] * (1 - k) + (x / n) * k;
      next[v * 3 + 1] = cur[v * 3 + 1] * (1 - k) + (y / n) * k;
      next[v * 3 + 2] = cur[v * 3 + 2] * (1 - k) + (z / n) * k;
    }
    cur = next;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(cur, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  // curls: pushed out along the normal
  if (curl) {
    const p = geo.attributes.position as BufferAttribute;
    const n = geo.attributes.normal as BufferAttribute;
    for (let v = 0; v < nv; v++) {
      const h = curlHeight(p.getX(v), p.getY(v), p.getZ(v), curl.cell) - 0.5;
      const d = h * curl.depth;
      p.setXYZ(v, p.getX(v) + n.getX(v) * d, p.getY(v) + n.getY(v) * d, p.getZ(v) + n.getZ(v) * d);
    }
    geo.computeVertexNormals();
  }
  // skin: the blobs whose surface is near, weighted by closeness
  const SI = new Uint16Array(nv * 4);
  const SW = new Float32Array(nv * 4);
  const p = geo.attributes.position as BufferAttribute;
  for (let v = 0; v < nv; v++) {
    const s: Skin = new Map();
    const x = p.getX(v);
    const y = p.getY(v);
    const z = p.getZ(v);
    let best = Infinity;
    let bestBone = blobs[0].bone;
    for (const b of blobs) {
      const d = ellDist(x, y, z, b);
      if (d < best) {
        best = d;
        bestBone = b.bone;
      }
      const w = Math.max(0, 1 - Math.max(0, d) / (b.melt * 1.5 + 1e-3));
      if (w > 0) s.set(b.bone, (s.get(b.bone) ?? 0) + w * w);
    }
    if (!s.size) s.set(bestBone, 1);
    writeSkin(s, SI, SW, v);
  }
  geo.setAttribute('skinIndex', new BufferAttribute(SI, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(SW, 4));
  return geo;
}
