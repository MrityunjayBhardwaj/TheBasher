// resolveEvaluatedMesh — the producer-agnostic projection suite (v0.6 #1, #150).
// Proves ONE resolver projects BoxMesh, SphereMesh, AND GltfChild into one
// EvaluatedMesh, that the geometry key is deterministic, and that the GltfChild
// transform funnels through the SAME resolveGltfChildTrs band (H40 — no drift).
//
// REF: PLAN.md Wave 1 Task 2; hetvabhasa H40; vyapti V20.

import { primaryMaterial } from './materialAssignment';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveGltfChildTrs } from './resolveGltfChildTransform';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { makeSplitSphere } from '../test-utils/splitSphere';
import { rowDataParams, splitOps } from '../test-utils/splitKinds';

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
    expect(primaryMaterial(mesh!.materials)).not.toBeNull();
    // v0.6 #3 — box now carries REAL UV islands from the registry geometry (was
    // null pre-#3). BoxGeometry → 6 islands, each spanning the full [0,1] square.
    expect(mesh!.uvRead.status).toBe('ok');
    expect(mesh!.uvRead.status === 'ok' && mesh!.uvRead.islands.islands).toHaveLength(6);
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
    // #365 Phase 5a (Slice 1b) — size lives on the BoxData node now; the read is still through
    // the Object (BOX_ID, which resolves the geometry via its `data` edge).
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_box_data',
      paramPath: 'size',
      value: [2, 3, 4],
    }).next;
    const after = resolveEvaluatedMesh(state, BOX_ID, ctxAt(0))!.geometry.key;
    expect(after).not.toBe(before);
    expect(after).toContain('2,3,4');
  });

  it('projects a split sphere (Object → SphereData): sphere geometry ref + transform', () => {
    // #384 Stage C (C1): a sphere is now an Object owning the TRS, wired to a SphereData owning
    // geometry. The resolver reaches through the Object's `data` edge (read from the Object id,
    // the node the user selects) — same geometry ref, same C-1 identity-scale guard.
    const { state, objectId } = makeSplitSphere(buildDefaultDagState(), {
      objectId: SPHERE_ID,
      radius: 0.5,
      widthSegments: 24,
      heightSegments: 16,
    });
    const mesh = resolveEvaluatedMesh(state, objectId, ctxAt(0));
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
    expect(primaryMaterial(mesh!.materials)).toBeNull(); // #2 fills it later

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

  // #388 C5 — the read road for a baked PAIR. This branch used to narrow with
  // `data.kind !== 'MeshData'`, which is already total, so widening `ObjectData` could not
  // redden it and a baked pair silently resolved to null — no mesh for the gizmo, the
  // inspector or the UV projection.
  //
  // It was FIRST written against the fused `BakedMesh` as a live control, which is the
  // strongest anchor while both shapes exist. That control expired with the fused read
  // road (retired here — a kind whose `evaluate` throws must not keep answering reads),
  // so the pair now pins the CANONICAL STRUCT instead: the exact projection a baked mesh
  // must produce, rather than "whatever the relic used to say". This also carries the
  // coverage of the deleted fused-producer test — verbatim handle, verbatim rich
  // material, and the pose — which is where it belongs now that the pair is the only
  // producer.
  it('projects a baked PAIR: verbatim handle + captured spec + the Object half’s pose', () => {
    __reseedAllNodesForTests();
    const geometry = {
      key: 'baked|pair-8',
      kind: 'baked' as const,
      descriptor: { kind: 'baked' as const, hash: 'pairhash', vertexCount: 8 },
    };
    const material = { ...(rowDataParams('baked').material as Record<string, unknown>) };

    let state: DagState = emptyDagState();
    for (const op of splitOps(
      'baked',
      { objectId: 'n_pair' },
      { data: { geometry, material }, object: { position: [3, -2, 5] } },
    )) {
      state = applyOp(state, op as never).next;
    }

    const pair = resolveEvaluatedMesh(state, 'n_pair', ctxAt(0));
    expect(pair).not.toBeNull();
    // The handle is returned VERBATIM — no parallel walk, no re-derivation. The bytes are
    // authoritative in OPFS, keyed by content hash.
    expect(pair!.geometry).toEqual(geometry);
    expect(pair!.geometry.kind).toBe('baked');
    // The captured spec rides through verbatim — the ONE rich material face (M6).
    expect(primaryMaterial(pair!.materials)).toEqual(material);
    // `uvs` is null for a baked ref — the bytes are not sync-buildable, so a non-null here
    // would mean the pair took the primitive registry path by mistake.
    expect(pair!.uvRead.status).not.toBe('ok');
    // The pose is carried by the Object half, which is the whole point of the split.
    expect(pair!.transform.position).toEqual([3, -2, 5]);
    expect(pair!.transform.rotation).toEqual([0, 0, 0]);
    expect(pair!.transform.scale).toEqual([1, 1, 1]);
  });

  it('returns null for a non-mesh node (identity-null, no crash)', () => {
    const state = buildDefaultDagState();
    expect(resolveEvaluatedMesh(state, 'n_camera', ctxAt(0))).toBeNull();
    expect(resolveEvaluatedMesh(state, 'does_not_exist', ctxAt(0))).toBeNull();
  });
});
