import { afterEach, describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import { clear, get, size } from './geometryRegistry';

afterEach(() => clear());

const boxRef = (key: string, sz: [number, number, number]): GeometryRef => ({
  key,
  kind: 'box',
  descriptor: { kind: 'box', size: sz },
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
});
