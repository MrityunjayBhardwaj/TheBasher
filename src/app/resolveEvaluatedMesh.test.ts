// resolveEvaluatedMesh — the producer-agnostic projection suite (v0.6 #1, #150).
// Proves ONE resolver projects BoxMesh, SphereMesh, AND GltfChild into one
// EvaluatedMesh, that the geometry key is deterministic, and that the GltfChild
// transform funnels through the SAME resolveGltfChildTrs band (H40 — no drift).
//
// REF: PLAN.md Wave 1 Task 2; hetvabhasa H40; vyapti V20.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveGltfChildTrs } from './resolveGltfChildTransform';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';

const BOX_ID = 'n_box';
const SPHERE_ID = 'n_sphere';
const GLTF_CHILD_ID = 'n_gltf_child';

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('resolveEvaluatedMesh', () => {
  it('projects a BoxMesh: box geometry ref + transform from params + material', () => {
    const state = buildDefaultDagState();
    const mesh = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0));
    expect(mesh).not.toBeNull();
    expect(mesh!.geometry.kind).toBe('box');
    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [1, 1, 1] });
    // pre-migration node has no scale param → identity default (C-1 guard).
    expect(mesh!.transform.scale).toEqual([1, 1, 1]);
    expect(mesh!.transform.position).toEqual([0, 0, 0]);
    expect(mesh!.material).not.toBeNull();
    expect(mesh!.uvs).toBeNull();
  });

  it('box geometry key is deterministic (same params → byte-identical key)', () => {
    const state = buildDefaultDagState();
    const a = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0));
    const b = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0));
    expect(a!.geometry.key).toBe(b!.geometry.key);
  });

  it('box geometry key changes when size changes (no false sharing)', () => {
    let state = buildDefaultDagState();
    const before = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0))!.geometry.key;
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'size',
      value: [2, 3, 4],
    }).next;
    const after = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0))!.geometry.key;
    expect(after).not.toBe(before);
    expect(after).toContain('2,3,4');
  });

  it('projects a SphereMesh: sphere geometry ref + transform', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: SPHERE_ID,
      nodeType: 'SphereMesh',
      params: { radius: 0.5, widthSegments: 24, heightSegments: 16 },
    }).next;
    const mesh = resolveEvaluatedMesh(state, SPHERE_ID, ctxAt(0));
    expect(mesh).not.toBeNull();
    expect(mesh!.geometry.kind).toBe('sphere');
    expect(mesh!.geometry.descriptor).toEqual({
      kind: 'sphere',
      radius: 0.5,
      widthSegments: 24,
      heightSegments: 16,
    });
    expect(mesh!.transform.scale).toEqual([1, 1, 1]); // C-1 guard
  });

  it('projects a GltfChild: gltf geometry ref + transform via the ONE resolveGltfChildTrs band', () => {
    let state = buildDefaultDagState();
    const childTrs = {
      position: [1, 2, 3] as [number, number, number],
      rotation: [0, 90, 0] as [number, number, number],
      scale: [2, 2, 2] as [number, number, number],
    };
    const overridden = { position: false, rotation: false, scale: true };
    state = applyOp(state, {
      type: 'addNode',
      nodeId: GLTF_CHILD_ID,
      nodeType: 'GltfChild',
      params: {
        childName: 'Mesh0',
        assetRef: 'asset-1',
        position: childTrs.position,
        rotation: childTrs.rotation,
        scale: childTrs.scale,
        overridden,
      },
    }).next;

    const mesh = resolveEvaluatedMesh(state, GLTF_CHILD_ID, ctxAt(0));
    expect(mesh).not.toBeNull();
    expect(mesh!.geometry.kind).toBe('gltf');
    expect(mesh!.geometry.descriptor).toEqual({
      kind: 'gltf',
      assetRef: 'asset-1',
      childName: 'Mesh0',
    });
    expect(mesh!.material).toBeNull(); // #2 fills it later

    // H40 — the resolver's transform.scale equals the ONE band's output for the
    // same inputs (no parallel walk, no drift).
    const expected = resolveGltfChildTrs({
      base: childTrs,
      clipTrack: undefined,
      childNode: { ...childTrs, overridden },
      bakedChannel: undefined,
    });
    expect(mesh!.transform.scale).toEqual([...expected.scale]);
    expect(mesh!.transform.position).toEqual([...expected.position]);
    expect(mesh!.transform.rotation).toEqual([...expected.rotation]);
  });

  it('projects a BakedMesh: verbatim baked handle + identity transform + rich material (4th producer)', () => {
    let state = buildDefaultDagState();
    const geometry = {
      key: 'baked|deadbeef-8',
      kind: 'baked' as const,
      descriptor: { kind: 'baked' as const, hash: 'deadbeef', vertexCount: 8 },
    };
    const material = {
      materialClass: 'standard' as const,
      color: '#5af07a',
      roughness: 1,
      metalness: 0,
      opacity: 1,
      transparent: false,
      emissive: '#000000',
      emissiveIntensity: 1,
      map: null,
      normalMap: null,
      roughnessMap: null,
      metalnessMap: null,
      aoMap: null,
      emissiveMap: null,
    };
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_baked',
      nodeType: 'BakedMesh',
      params: { geometry, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material },
    }).next;

    const mesh = resolveEvaluatedMesh(state, 'n_baked', ctxAt(0));
    expect(mesh).not.toBeNull();
    // The handle is returned VERBATIM — no parallel walk, no re-derivation.
    expect(mesh!.geometry).toEqual(geometry);
    expect(mesh!.geometry.kind).toBe('baked');
    // Identity transform — the TRS is baked into the verts (renderer applies identity).
    expect(mesh!.transform.position).toEqual([0, 0, 0]);
    expect(mesh!.transform.scale).toEqual([1, 1, 1]);
    // The ONE rich material face (M6).
    expect(mesh!.material).toEqual(material);
  });

  it('returns null for a non-mesh node (identity-null, no crash)', () => {
    const state = buildDefaultDagState();
    expect(resolveEvaluatedMesh(state, 'n_camera', ctxAt(0))).toBeNull();
    expect(resolveEvaluatedMesh(state, 'does_not_exist', ctxAt(0))).toBeNull();
  });
});
