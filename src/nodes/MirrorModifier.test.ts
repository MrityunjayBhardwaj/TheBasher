// MirrorModifier — the second geometry MODIFIER (SOP), epic #201 / #209, V58.
// Proves: a sphere source → a ModifiedMesh carrying a `mirror` geometry handle +
// INHERITED transform/material; mute = identity passthrough; a non-leaf source
// passes through; and — the unit-level boundary-pair — the `mirror` geometry KEY
// the node's evaluate emits is BYTE-IDENTICAL to the key the read-side
// `resolveEvaluatedMesh` derives for the same wired chain (H40, no drift). Same
// shape as ArrayModifier.test.ts — the substrate generalizes.
//
// REF: src/nodes/MirrorModifier.ts; src/app/modifierGeometry.ts;
//      src/app/resolveEvaluatedMesh.ts (the recursive mirror branch); vyapti V58.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedMesh } from '../app/resolveEvaluatedMesh';
import { hydrateInlineMaterial } from './materialSchema';
import { MirrorModifierNode } from './MirrorModifier';
import type { SphereMeshValue, ModifiedMeshValue, SceneChild, TransformValue } from './types';

const MOD_ID = 'n_mirror';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

// #365 Phase 5a (Slice 2): the fused box value kind retired; SphereMesh is the still-fused
// leaf-mesh source the modifier consumes. The mirror's assertions are geometry-kind-agnostic.
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
  params: { axis: 'x' | 'y' | 'z'; offset?: number; muted: boolean },
  target: SceneChild | undefined,
): SceneChild | undefined {
  // offset defaults to 0 (zod's default isn't applied when calling evaluate directly,
  // and 0 matches the read-side's default → the parity keys line up).
  return MirrorModifierNode.evaluate({ offset: 0, ...params }, { target }, ctx) as
    | SceneChild
    | undefined;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('MirrorModifier.evaluate', () => {
  it('a sphere source → a ModifiedMesh with a mirror geometry handle + inherited TRS/material', () => {
    const src = sphereValue([3, 0, 0]);
    const out = evalMod({ axis: 'x', muted: false }, src) as ModifiedMeshValue;
    expect(out.kind).toBe('ModifiedMesh');
    expect(out.geometry.kind).toBe('mirror');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'x' });
    // INHERITED — the mirrored result sits where the source box was.
    expect(out.position).toEqual([3, 0, 0]);
    expect(out.material).toBe(src.material);
  });

  it('the axis param feeds the descriptor + key (distinct axes → distinct keys)', () => {
    const src = sphereValue([0, 0, 0]);
    const x = evalMod({ axis: 'x', muted: false }, src) as ModifiedMeshValue;
    const y = evalMod({ axis: 'y', muted: false }, src) as ModifiedMeshValue;
    expect(y.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'y' });
    expect(x.geometry.key).not.toBe(y.geometry.key);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = sphereValue([0, 0, 0]);
    const out = evalMod({ axis: 'x', muted: true }, src);
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
    const out = evalMod({ axis: 'x', muted: false }, wrapper);
    expect(out).toBe(wrapper);
  });

  it('an unwired source (undefined) stays transparent (no crash)', () => {
    expect(evalMod({ axis: 'x', muted: false }, undefined)).toBeUndefined();
  });
});

describe('MirrorModifier — read-side parity (boundary-pair)', () => {
  // #365 Phase 5a (Slice 2): the source is a still-fused SphereMesh (the box value kind
  // retired; a modifier on a split Object is the deferred modifier-move follow-up). The
  // evaluate↔read byte-identity is pinned on the primitive that still has a fused value.
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

  it('resolveEvaluatedMesh derives the SAME mirror geometry key the evaluate path emits', () => {
    let state = withSphere();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'MirrorModifier',
      params: { axis: 'z', muted: false },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: SPHERE_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;

    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('mirror');
    // Sync-buildable modified geometry → real UV islands (not null) for the UV editor.
    expect(resolved!.uvs).not.toBeNull();
    expect(resolved!.uvs!.islands.length).toBeGreaterThan(0);

    // The evaluate path projects the SAME sphere with the same axis.
    const evald = evalMod({ axis: 'z', muted: false }, sphereValue([0, 0, 0])) as ModifiedMeshValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    let state = withSphere();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'MirrorModifier',
      params: { axis: 'x', muted: true },
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
