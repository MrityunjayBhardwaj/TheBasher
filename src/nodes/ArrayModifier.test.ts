// ArrayModifier — the first geometry MODIFIER (SOP), the geometry half of V58
// (epic #201, #209). Proves: a box source → a ModifiedMesh carrying an `array`
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
import { hydrateInlineMaterial } from './materialSchema';
import { ArrayModifierNode } from './ArrayModifier';
import type { BoxMeshValue, ModifiedMeshValue, SceneChild, TransformValue } from './types';

const BOX_ID = 'n_box';
const MOD_ID = 'n_array';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

function boxValue(position: [number, number, number]): BoxMeshValue {
  return {
    kind: 'BoxMesh',
    size: [1, 1, 1],
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
  it('a box source → a ModifiedMesh with an array geometry handle + inherited TRS/material', () => {
    const src = boxValue([3, 0, 0]);
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, src) as ModifiedMeshValue;
    expect(out.kind).toBe('ModifiedMesh');
    expect(out.geometry.kind).toBe('array');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'array', count: 3, offset: [2, 0, 0] });
    // INHERITED — the arrayed cluster sits where the source box was.
    expect(out.position).toEqual([3, 0, 0]);
    expect(out.material).toBe(src.material);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = boxValue([0, 0, 0]);
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
});

describe('ArrayModifier — read-side parity (boundary-pair)', () => {
  it('resolveEvaluatedMesh derives the SAME array geometry key the evaluate path emits', () => {
    // Wire Box → ArrayModifier and resolve the modifier the read-side way.
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [3, 0, 0], muted: false },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;

    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('array');
    // The modified geometry is sync-buildable → real UV islands (not null), so the
    // UV-editor backdrop works for a modifier (#209 follow-up).
    expect(resolved!.uvs).not.toBeNull();
    expect(resolved!.uvs!.islands.length).toBeGreaterThan(0);

    // The evaluate path projects the SAME box (size [1,1,1]) with the same params.
    const evald = evalMod(
      { count: 4, offset: [3, 0, 0], muted: false },
      boxValue([0, 0, 0]),
    ) as ModifiedMeshValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [3, 0, 0], muted: true },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;
    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved!.geometry.kind).toBe('box'); // passthrough — the source's own handle
  });
});
