import { BoxGeometry } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import { clear, get, prime, size } from './geometryRegistry';

afterEach(() => clear());

const boxRef = (key: string, sz: [number, number, number]): GeometryRef => ({
  key,
  kind: 'box',
  descriptor: { kind: 'box', size: sz },
});

const bakedRef = (hash: string, vertexCount: number): GeometryRef => ({
  key: `baked|${hash}-${vertexCount}`,
  kind: 'baked',
  descriptor: { kind: 'baked', hash, vertexCount },
});

describe('geometryRegistry', () => {
  it('builds a box geometry on miss and caches it (same key → same instance)', () => {
    const ref = boxRef('box|1,1,1', [1, 1, 1]);
    const a = get(ref);
    const b = get(boxRef('box|1,1,1', [1, 1, 1]));
    expect(a).not.toBeNull();
    expect(a).toBe(b); // cache hit — identical instance, no churn
    expect(size()).toBe(1);
  });

  it('keys distinct params to distinct instances (no false sharing)', () => {
    const a = get(boxRef('box|1,1,1', [1, 1, 1]));
    const b = get(boxRef('box|2,2,2', [2, 2, 2]));
    expect(a).not.toBe(b);
    expect(size()).toBe(2);
  });

  it('builds a sphere geometry from its descriptor', () => {
    const ref: GeometryRef = {
      key: 'sphere|0.5|24|16',
      kind: 'sphere',
      descriptor: { kind: 'sphere', radius: 0.5, widthSegments: 24, heightSegments: 16 },
    };
    const g = get(ref);
    expect(g).not.toBeNull();
    expect(g).toBe(get(ref)); // cached
  });

  it('returns null for a gltf ref (registry does not own loaded glTF geometry)', () => {
    const ref: GeometryRef = {
      key: 'gltf|asset-1|Mesh0',
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: 'asset-1', childName: 'Mesh0' },
    };
    expect(get(ref)).toBeNull();
    expect(size()).toBe(0); // not cached
  });

  it('clear() empties the cache', () => {
    get(boxRef('box|1,1,1', [1, 1, 1]));
    expect(size()).toBe(1);
    clear();
    expect(size()).toBe(0);
  });

  it('returns null for an UNPRIMED baked ref (miss → caller suspends + loads from OPFS)', () => {
    const ref = bakedRef('abc123', 8);
    expect(get(ref)).toBeNull();
    expect(size()).toBe(0); // no sync build attempted for baked
  });

  it('prime() then get() is a sync cache hit returning the same instance', () => {
    const ref = bakedRef('abc123', 8);
    const geom = new BoxGeometry(1, 1, 1);
    const primed = prime(ref, geom);
    expect(primed).toBe(geom);
    expect(get(ref)).toBe(geom); // sync hit after prime
    expect(size()).toBe(1);
  });

  it('prime() is idempotent — a second prime for the same key keeps the first instance', () => {
    const ref = bakedRef('abc123', 8);
    const first = new BoxGeometry(1, 1, 1);
    const second = new BoxGeometry(1, 1, 1);
    prime(ref, first);
    const kept = prime(ref, second); // second instance dropped, first kept
    expect(kept).toBe(first);
    expect(get(ref)).toBe(first);
    expect(size()).toBe(1);
  });

  // SOP / modifier (epic #201, #209) — the recursive `array` descriptor build.
  const arrayRef = (
    source: GeometryRef,
    count: number,
    offset: [number, number, number],
  ): GeometryRef => ({
    key: `array|${source.key}|${count}|${offset.join(',')}`,
    kind: 'array',
    descriptor: { kind: 'array', source, count, offset },
  });

  it('builds an array modifier: N copies of the source merged (count× the vertices)', () => {
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const one = get(src)!;
    const oneCount = one.getAttribute('position').count; // BoxGeometry → 24
    const three = get(arrayRef(src, 3, [2, 0, 0]))!;
    expect(three).not.toBeNull();
    expect(three.getAttribute('position').count).toBe(oneCount * 3);
  });

  it('array copies are TRANSLATED by i*offset (the merged bounds span the run)', () => {
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const arr = get(arrayRef(src, 3, [5, 0, 0]))!;
    arr.computeBoundingBox();
    const bb = arr.boundingBox!;
    // copy0 spans x∈[-0.5,0.5]; copy2 sits at +10 → spans [9.5,10.5]. Width ≈ 11.
    expect(bb.min.x).toBeCloseTo(-0.5, 5);
    expect(bb.max.x).toBeCloseTo(10.5, 5);
  });

  it('array build caches by key (same params → same instance) and does not mutate the source', () => {
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const sourceInstance = get(src)!;
    const a = get(arrayRef(src, 2, [2, 0, 0]));
    const b = get(arrayRef(src, 2, [2, 0, 0]));
    expect(a).toBe(b); // cached
    // the cached source is still the unmodified single box (clones were translated)
    sourceInstance.computeBoundingBox();
    expect(sourceInstance.boundingBox!.max.x).toBeCloseTo(0.5, 5);
  });

  it('returns null for an array over a non-sync-buildable source (gltf) — v1 follow-up', () => {
    const gltfSrc: GeometryRef = {
      key: 'gltf|a|M',
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: 'a', childName: 'M' },
    };
    expect(get(arrayRef(gltfSrc, 3, [2, 0, 0]))).toBeNull();
  });

  // SOP / modifier (epic #201, #209) — the recursive `mirror` descriptor build.
  const mirrorRef = (source: GeometryRef, axis: 'x' | 'y' | 'z', offset = 0): GeometryRef => ({
    key: `mirror|${source.key}|${axis}|${offset}`,
    kind: 'mirror',
    descriptor: { kind: 'mirror', source, axis, offset },
  });

  it('builds a mirror modifier: source + reflection merged (2× the vertices)', () => {
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const oneCount = get(src)!.getAttribute('position').count; // BoxGeometry → 24
    const mir = get(mirrorRef(src, 'x'))!;
    expect(mir).not.toBeNull();
    expect(mir.getAttribute('position').count).toBe(oneCount * 2);
  });

  it('a non-zero offset separates the halves: reflection lands across the plane at `offset`', () => {
    // A unit box (x∈[-0.5,0.5]) mirrored across x=2 → reflected half spans
    // [2·2−0.5, 2·2+0.5] = [3.5,4.5]. The merged bounds span the original + reflection.
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const mir = get(mirrorRef(src, 'x', 2))!;
    mir.computeBoundingBox();
    expect(mir.boundingBox!.min.x).toBeCloseTo(-0.5, 5); // original half
    expect(mir.boundingBox!.max.x).toBeCloseTo(4.5, 5); // reflected half across x=2
  });

  it('mirror reverses the reflected half winding — winding agrees with the normals everywhere', () => {
    // The decisive correctness check: a reflection (det −1) flips triangle winding,
    // so without reverseWinding the mirrored half would render inside-out. For every
    // triangle, the geometric normal (from the index winding) must point the SAME
    // way as the stored vertex normal (dot > 0). A box face's 3 vertex normals all
    // equal the face normal, so a correct mirror gives dot ≈ +1 for ALL triangles.
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    const mir = get(mirrorRef(src, 'x'))!;
    const pos = mir.getAttribute('position');
    const nrm = mir.getAttribute('normal');
    const index = mir.getIndex()!;
    const idx = index.array;
    let minDot = Infinity;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
      const p0 = [pos.getX(a), pos.getY(a), pos.getZ(a)];
      const p1 = [pos.getX(b), pos.getY(b), pos.getZ(b)];
      const p2 = [pos.getX(c), pos.getY(c), pos.getZ(c)];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const g = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const vn = [nrm.getX(a), nrm.getY(a), nrm.getZ(a)];
      minDot = Math.min(minDot, g[0] * vn[0] + g[1] * vn[1] + g[2] * vn[2]);
    }
    expect(minDot).toBeGreaterThan(0); // every face front-facing — winding == normals
  });

  it('mirror caches by key (same params → same instance) and does not mutate the source', () => {
    const src = boxRef('box|2,1,1', [2, 1, 1]);
    const sourceInstance = get(src)!;
    const a = get(mirrorRef(src, 'x'));
    const b = get(mirrorRef(src, 'x'));
    expect(a).toBe(b); // cached
    // the cached source is still the unmodified single box (clones were reflected)
    sourceInstance.computeBoundingBox();
    expect(sourceInstance.boundingBox!.max.x).toBeCloseTo(1, 5); // half-width of a 2-wide box
  });

  it('distinct mirror axes key to distinct instances (no false sharing)', () => {
    const src = boxRef('box|1,1,1', [1, 1, 1]);
    expect(get(mirrorRef(src, 'x'))).not.toBe(get(mirrorRef(src, 'y')));
  });

  it('returns null for a mirror over a non-sync-buildable source (gltf) — v1 follow-up', () => {
    const gltfSrc: GeometryRef = {
      key: 'gltf|a|M',
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: 'a', childName: 'M' },
    };
    expect(get(mirrorRef(gltfSrc, 'x'))).toBeNull();
  });
});
