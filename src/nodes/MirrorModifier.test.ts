// MirrorModifier — the second geometry MODIFIER (SOP), epic #201 / #209, V58.
// Proves: a box source → a ModifiedMesh carrying a `mirror` geometry handle +
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
import type { BoxMeshValue, ModifiedMeshValue, SceneChild, TransformValue } from './types';

const BOX_ID = 'n_box';
const MOD_ID = 'n_mirror';

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
  it('a box source → a ModifiedMesh with a mirror geometry handle + inherited TRS/material', () => {
    const src = boxValue([3, 0, 0]);
    const out = evalMod({ axis: 'x', muted: false }, src) as ModifiedMeshValue;
    expect(out.kind).toBe('ModifiedMesh');
    expect(out.geometry.kind).toBe('mirror');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'x' });
    // INHERITED — the mirrored result sits where the source box was.
    expect(out.position).toEqual([3, 0, 0]);
    expect(out.material).toBe(src.material);
  });

  it('the axis param feeds the descriptor + key (distinct axes → distinct keys)', () => {
    const src = boxValue([0, 0, 0]);
    const x = evalMod({ axis: 'x', muted: false }, src) as ModifiedMeshValue;
    const y = evalMod({ axis: 'y', muted: false }, src) as ModifiedMeshValue;
    expect(y.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'y' });
    expect(x.geometry.key).not.toBe(y.geometry.key);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = boxValue([0, 0, 0]);
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
  it('resolveEvaluatedMesh derives the SAME mirror geometry key the evaluate path emits', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'MirrorModifier',
      params: { axis: 'z', muted: false },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: MOD_ID, socket: 'target' },
    }).next;

    const resolved = resolveEvaluatedMesh(state, MOD_ID, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('mirror');
    // Sync-buildable modified geometry → real UV islands (not null) for the UV editor.
    expect(resolved!.uvs).not.toBeNull();
    expect(resolved!.uvs!.islands.length).toBeGreaterThan(0);

    // The evaluate path projects the SAME box (size [1,1,1]) with the same axis.
    const evald = evalMod({ axis: 'z', muted: false }, boxValue([0, 0, 0])) as ModifiedMeshValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: MOD_ID,
      nodeType: 'MirrorModifier',
      params: { axis: 'x', muted: true },
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
