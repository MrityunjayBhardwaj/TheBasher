// #635 (ns-1) — the four answers a UV read can give, and the two that must never merge.
//
// The load-bearing assertion is the last one: `loading` and `none` are DISTINGUISHABLE at
// the type. Collapsed into one null, an in-flight OPFS read is indistinguishable from a mesh
// that has no UVs, and the consumer renders untextured and calls it correct — a defect that
// has already shipped once in the file that reads this one.
//
// REF: src/app/uvAttributes.ts; src/app/geometryRegistry.ts; issues #635, #630, #633.

import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { boxGeometryRef, sphereGeometryRef } from './modifierGeometry';
import { prime } from './geometryRegistry';
import { read } from './attributeStore';
import { UV_MAP } from '../nodes/attributes';
import { readMeshUVs } from './uvAttributes';
import type { GeometryRef } from '../nodes/types';

const bakedRef = (hash: string): GeometryRef => ({
  key: `baked|${hash}`,
  kind: 'baked',
  descriptor: { kind: 'baked', hash, vertexCount: 3 },
});

const gltfRef: GeometryRef = {
  key: 'gltf|asset|child',
  kind: 'gltf',
  descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
};

/** A triangle with positions and no `uv` attribute at all. */
function uvlessTriangle(): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  return geom;
}

describe('#635 a built geometry yields a CORNER-domain UV attribute', () => {
  it('lifts the uv buffer off the tessellation, at the corner domain', () => {
    const result = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const attribute = read(result.attributeKey)?.[UV_MAP];
    expect(attribute).toBeDefined();
    expect(attribute!.domain).toBe('corner');
    expect(attribute!.type).toBe('float2');
    // A box's 12 triangles are drawn from 24 indexed corners; the buffer carries a UV per
    // corner, which is what makes a seam expressible at all.
    expect(attribute!.count).toBe(24);
    expect(attribute!.data.length).toBe(48);
  });

  it('still hands back the island projection the UV editor draws', () => {
    const result = readMeshUVs(sphereGeometryRef(1, 8, 4, null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.islands.triangleCount).toBeGreaterThan(0);
  });

  it('keys two equal geometries onto one attribute entry', () => {
    const a = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    const b = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    expect(a.status === 'ok' && b.status === 'ok' && a.attributeKey === b.attributeKey).toBe(true);
  });
});

describe('#635 absence says WHY', () => {
  it('answers LOADING for bytes that exist but have not been read in', () => {
    expect(readMeshUVs(bakedRef('not-primed-yet')).status).toBe('loading');
  });

  it('answers ELSEWHERE for buffers that live in a loaded asset clone', () => {
    expect(readMeshUVs(gltfRef).status).toBe('elsewhere');
  });

  it('answers NONE for a geometry that is built and genuinely has no UVs', () => {
    const ref = bakedRef('primed-without-uvs');
    prime(ref, uvlessTriangle());
    expect(readMeshUVs(ref).status).toBe('none');
  });

  it('KEEPS LOADING AND NONE APART — the collapse this type exists to stop', () => {
    // Same shape of emptiness, opposite correct response: one says wait, the other says
    // render untextured. A single null cannot carry that difference, and a consumer that
    // guesses gets it wrong exactly half the time and silently.
    const midLoad = readMeshUVs(bakedRef('still-in-flight'));
    const genuinelyNone = readMeshUVs(bakedRef('primed-without-uvs-2'));
    prime(bakedRef('primed-without-uvs-2'), uvlessTriangle());

    expect(midLoad.status).toBe('loading');
    expect(readMeshUVs(bakedRef('primed-without-uvs-2')).status).toBe('none');
    expect(genuinelyNone.status).not.toBe(readMeshUVs(bakedRef('primed-without-uvs-2')).status);
  });

  it('never awaits — the read is synchronous on every arm', () => {
    // The pressure at this seam is to make the resolver async and "just await the UVs",
    // which would turn every read-side consumer into a suspense boundary. Every arm above
    // returned a value, not a promise; this states it as an assertion.
    for (const result of [
      readMeshUVs(boxGeometryRef([2, 2, 2], null)),
      readMeshUVs(bakedRef('never-primed')),
      readMeshUVs(gltfRef),
    ]) {
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result.status).toBe('string');
    }
  });
});
