// ArrayModifier — the first geometry MODIFIER (SOP), the geometry half of V58
// (epic #201, #209). Proves: a sphere source → a ModifiedMesh carrying an `array`
// geometry handle + INHERITED transform/material; mute = identity passthrough; a
// non-leaf source passes through; and — the unit-level boundary-pair — the
// `array` geometry KEY the node's evaluate emits is BYTE-IDENTICAL to the key the
// read-side `resolveEvaluatedMesh` derives for the same wired chain (H40, no drift).
//
// REF: src/nodes/ArrayModifier.ts; src/app/modifierGeometry.ts;
//      src/app/resolveEvaluatedMesh.ts (the recursive array branch); vyapti V58.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedMesh } from '../app/resolveEvaluatedMesh';
import * as geometryRegistry from '../app/geometryRegistry';
import { hydrateInlineMaterial } from './materialSchema';
import { ArrayModifierNode } from './ArrayModifier';
import type {
  BakedMeshValue,
  SphereMeshValue,
  ModifiedMeshValue,
  SceneChild,
  TransformValue,
} from './types';

const MOD_ID = 'n_array';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

// #365 Phase 5a (Slice 2): the fused box value kind retired; SphereMesh is the still-fused
// leaf-mesh source that sourceGeometryRef/sourceTransform/sourceMaterial consume. The array's
// assertions (array descriptor, inherited TRS, material ref) are geometry-kind-agnostic.
function sphereValue(position: [number, number, number]): SphereMeshValue {
  return {
    kind: 'SphereMesh',
    radius: 1,
    widthSegments: 8,
    heightSegments: 6,
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: hydrateInlineMaterial(null, '#888888'),
  };
}

function evalMod(
  params: { count: number; offset: [number, number, number]; muted: boolean },
  target: SceneChild | undefined,
): SceneChild | undefined {
  return ArrayModifierNode.evaluate(params, { target }, ctx) as SceneChild | undefined;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('ArrayModifier.evaluate', () => {
  it('a sphere source → a ModifiedMesh with an array geometry handle + inherited TRS/material', () => {
    const src = sphereValue([3, 0, 0]);
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, src) as ModifiedMeshValue;
    expect(out.kind).toBe('ModifiedMesh');
    expect(out.geometry.kind).toBe('array');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'array', count: 3, offset: [2, 0, 0] });
    // INHERITED — the arrayed cluster sits where the source box was.
    expect(out.position).toEqual([3, 0, 0]);
    expect(out.material).toBe(src.material);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = sphereValue([0, 0, 0]);
    const out = evalMod({ count: 5, offset: [2, 0, 0], muted: true }, src);
    expect(out).toBe(src); // same reference — no ModifiedMesh produced
  });

  it('a non-leaf-mesh source (Transform) passes through unchanged (v1 scope)', () => {
    const wrapper: TransformValue = {
      kind: 'Transform',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      child: null,
    };
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, wrapper);
    expect(out).toBe(wrapper);
  });

  it('an unwired source (undefined) stays transparent (no crash)', () => {
    expect(evalMod({ count: 3, offset: [2, 0, 0], muted: false }, undefined)).toBeUndefined();
  });

  // #258 — the null-geom precondition the renderer's V38 surfacing depends on.
  // A BAKED source produces a real ModifiedMesh (baked passes sourceGeometryRef,
  // unlike glTF which passes THROUGH), but its geometry is an `array` over a
  // `baked` ref whose OPFS bytes aren't primed → geometryRegistry.get returns null.
  // ModifiedMeshR has no prime path, so this is a PERSISTENT blank the renderer
  // must surface (ex-silent). This locks that a baked-sourced modifier is exactly
  // the reachable null-geom case.
  it('a baked source → a ModifiedMesh whose geometry is null-until-primed (the #258 blank)', () => {
    __resetRegistryForTests();
    geometryRegistry.clear();
    const baked: BakedMeshValue = {
      kind: 'BakedMesh',
      geometry: {
        key: 'baked|deadbeef-8',
        kind: 'baked',
        descriptor: { kind: 'baked', hash: 'deadbeef', vertexCount: 8 },
      },
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: {
        materialClass: 'standard',
        color: '#ff8800',
        roughness: 0.4,
        metalness: 0.1,
        opacity: 1,
        transparent: false,
        emissive: '#000000',
        emissiveIntensity: 0,
        map: null,
        normalMap: null,
        roughnessMap: null,
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      },
    };
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, baked) as ModifiedMeshValue;
    expect(out.kind).toBe('ModifiedMesh'); // a real modified mesh (not a passthrough)
    expect(out.geometry.kind).toBe('array');
    // #358 — the baked material rides through the modifier verbatim (it was silently
    // dropped to null before: a ModifiedMesh could not hold a BakedMaterialSpec).
    expect(out.material).toBe(baked.material);
    // The array wraps the unprimed baked ref → the registry cannot build it sync.
    // (Rendering a baked-sourced modifier — geometry AND material — is the deferred
    // follow-up; this test locks the VALUE-level material fix independent of that.)
    expect(geometryRegistry.get(out.geometry)).toBeNull();
  });
});

describe('ArrayModifier — read-side parity (boundary-pair)', () => {
  // #365 Phase 5a (Slice 2): the source is a still-fused SphereMesh (the box value kind
  // retired). A modifier consuming a split Object is the deferred modifier-move — a follow-up —
  // so the evaluate↔read byte-identity property is pinned here on the primitive that still
  // has a fused value on BOTH sides of the boundary.
  const SPHERE_ID = 'n_sphere';
  function withSphere() {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: SPHERE_ID,
      nodeType: 'SphereMesh',
      params: { radius: 1, widthSegments: 8, heightSegments: 6 },
    }).next;
    return state;
  }

  it('resolveEvaluatedMesh derives the SAME array geometry key the evaluate path emits', () => {
    // Wire Sphere → ArrayModifier and resolve the modifier the read-side way.
    let state = withSphere();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [3, 0, 0], muted: false },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: SPHERE_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;

    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('array');
    // The modified geometry is sync-buildable → real UV islands (not null), so the
    // UV-editor backdrop works for a modifier (#209 follow-up).
    expect(resolved!.uvs).not.toBeNull();
    expect(resolved!.uvs!.islands.length).toBeGreaterThan(0);

    // The evaluate path projects the SAME sphere with the same params.
    const evald = evalMod(
      { count: 4, offset: [3, 0, 0], muted: false },
      sphereValue([0, 0, 0]),
    ) as ModifiedMeshValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    let state = withSphere();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [3, 0, 0], muted: true },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: SPHERE_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;
    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved!.geometry.kind).toBe('sphere'); // passthrough — the source's own handle
  });
});
