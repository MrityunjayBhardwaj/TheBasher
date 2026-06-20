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
  const arrayRef = (source: GeometryRef, count: number, offset: [number, number, number]): GeometryRef => ({
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
});
