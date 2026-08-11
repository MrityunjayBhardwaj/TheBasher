// MirrorModifier — the second geometry MODIFIER (SOP), epic #201 / #209, V58.
// Proves: mesh data in → `ModifiedData` carrying a `mirror` geometry handle +
// INHERITED material; mute = identity passthrough; non-mesh data passes through; and —
// the unit-level boundary-pair — the `mirror` geometry KEY the node's evaluate emits is
// BYTE-IDENTICAL to the key the read-side `resolveEvaluatedMesh` derives for the same
// wired chain (H40, no drift). Same shape as ArrayModifier.test.ts — the substrate
// generalizes, and #415 re-confirmed that the cheap way: moving the stack onto the data
// lane changed both modifiers identically, line for line.
//
// See ArrayModifier.test.ts's header for what #415 INVERTED here — the pose assertions
// are gone because a data node has no pose to inherit, which is the point of the split.
//
// REF: src/nodes/MirrorModifier.ts; src/app/modifierGeometry.ts;
//      src/app/resolveEvaluatedMesh.ts (the modifier branch); vyapti V58; issue #415.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedMesh } from '../app/resolveEvaluatedMesh';
import { sphereGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial } from './materialSchema';
import { makeSplitSphere } from '../test-utils/splitSphere';
import { buildAddModifierOps, resolveStackBase } from '../app/operatorStack';
import { MirrorModifierNode } from './MirrorModifier';
import type { CurveDataValue, MeshDataValue, ModifiedDataValue, ObjectData } from './types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** #415 — the modifier's source is DATA now, so the fixture is the data value itself. */
function sphereData(): MeshDataValue {
  return {
    kind: 'MeshData',
    geometry: sphereGeometryRef(1, 8, 6),
    material: hydrateInlineMaterial(null, '#888888'),
  };
}

function evalMod(
  params: { axis: 'x' | 'y' | 'z'; offset?: number; muted: boolean },
  target: ObjectData | undefined,
): ObjectData | undefined {
  // offset defaults to 0 (zod's default isn't applied when calling evaluate directly,
  // and 0 matches the read-side's default → the parity keys line up).
  return MirrorModifierNode.evaluate({ offset: 0, ...params }, { target }, ctx) as
    | ObjectData
    | undefined;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('MirrorModifier.evaluate', () => {
  it('mesh data → ModifiedData with a mirror geometry handle + inherited material', () => {
    const src = sphereData();
    const out = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue;
    expect(out.kind).toBe('ModifiedData');
    expect(out.geometry.kind).toBe('mirror');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'x' });
    // INHERITED — the material rides through from the source data (#358).
    expect(out.material).toBe(src.material);
  });

  // #415 — the subtraction, asserted on the second modifier too. If only one of them
  // carried a pose the split would be half-done in a way nothing else here would see.
  it('carries NO pose — a data node has none to carry', () => {
    const out = evalMod({ axis: 'x', muted: false }, sphereData());
    expect(Object.keys(out!).sort()).toEqual(['geometry', 'kind', 'material']);
  });

  it('the axis param feeds the descriptor + key (distinct axes → distinct keys)', () => {
    const src = sphereData();
    const x = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue;
    const y = evalMod({ axis: 'y', muted: false }, src) as ModifiedDataValue;
    expect(y.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'y' });
    expect(x.geometry.key).not.toBe(y.geometry.key);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = sphereData();
    const out = evalMod({ axis: 'x', muted: true }, src);
    expect(out).toBe(src); // same reference — no ModifiedData produced
  });

  it('non-mesh data (a curve) passes through unchanged — nothing to reshape', () => {
    const curve: CurveDataValue = {
      kind: 'CurveData',
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      samples: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      closed: false,
    };
    const out = evalMod({ axis: 'x', muted: false }, curve);
    expect(out).toBe(curve);
  });

  it('an unwired source (undefined) stays transparent (no crash)', () => {
    expect(evalMod({ axis: 'x', muted: false }, undefined)).toBeUndefined();
  });
});

describe('MirrorModifier — read-side parity (boundary-pair)', () => {
  // The source is a split sphere: an `Object` (SPHERE_ID) posing a `SphereData`. #415 —
  // the chain is spliced onto the DATA node through the real `buildAddModifierOps`, so
  // this file cannot describe a topology the panel no longer builds.
  const SPHERE_ID = 'n_sphere';
  const SPHERE_DATA = 'n_sphere_data';
  function withMod(axis: 'x' | 'y' | 'z', muted: boolean) {
    const state = makeSplitSphere(buildDefaultDagState(), {
      objectId: SPHERE_ID,
      dataId: SPHERE_DATA,
      radius: 1,
      widthSegments: 8,
      heightSegments: 6,
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
    const res = buildAddModifierOps(state, resolveStackBase(state, SPHERE_ID), 'MirrorModifier', {
      axis,
      muted,
    });
    expect(res).not.toBeNull();
    return {
      state: res!.ops.reduce((s, op) => applyOp(s, op).next, state),
      id: res!.modifierId,
    };
  }

  it('resolveEvaluatedMesh derives the SAME mirror geometry key the evaluate path emits', () => {
    const { state, id } = withMod('z', false);
    // POSSESSION (H218) — the modifier sits BETWEEN the data and the Object.
    expect(state.nodes[id].inputs.target).toMatchObject({ node: SPHERE_DATA, socket: 'out' });
    expect(state.nodes[SPHERE_ID].inputs.data).toMatchObject({ node: id, socket: 'out' });

    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('mirror');
    // Sync-buildable modified geometry → real UV islands (not null) for the UV editor.
    expect(resolved!.uvRead.status).toBe('ok');
    expect(
      resolved!.uvRead.status === 'ok' && resolved!.uvRead.islands.islands.length,
    ).toBeGreaterThan(0);

    // The evaluate path projects the SAME sphere data with the same axis.
    const evald = evalMod({ axis: 'z', muted: false }, sphereData()) as ModifiedDataValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    const { state, id } = withMod('x', true);
    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved!.geometry.kind).toBe('sphere'); // passthrough — the source's own handle
  });
});
