// resolveEvaluatedTransform — the anti-trap unit suite (D-W9-4 tested-pure
// discipline). The headline assertion (group 1) is the proof that the
// resolver UNWRAPS the AnimationLayer patched clone rather than re-evaluating
// the selected node in isolation — the exact #68 trap (H22/H34 family).
//
// REF: issue #68, CONTEXT D-01/D-04/D-05, PLAN W1 task 2.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { BoxMeshValue, RenderOutputValue } from '../nodes/types';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

const BOX_ID = 'n_box';
const LAYER_ID = 'n_layer';
const CHAN_ID = 'n_pos_channel';
const ROT_CHAN_ID = 'n_rot_channel';

// The box's authored static position. Channel samples are DELIBERATELY
// different so "resolver value ≠ raw value" is a real gap, not trivially true.
const STATIC_POS: [number, number, number] = [0, 0, 0];
const STATIC_ROT: [number, number, number] = [0, 0, 0];
const KF0_POS: [number, number, number] = [1, 2, 3];
const KF1_POS: [number, number, number] = [7, 8, 9];

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/**
 * Build: default project, then rewire n_box → AnimationLayer → scene
 * EXACTLY as addLayer does (disconnect box→scene, connect layer→scene,
 * box→layer.target). FLAG-B: the layer's `inputs.target` is seeded
 * array-wrapped (Array.isArray(b)?b:[b] — addLayer.ts:101), so assertion 2
 * exercises the resolver's NodeRef-shape normalization, not bypasses it.
 */
function buildAnimatedState(
  opts: { rotChannel?: boolean; targetBindShape?: 'bare' | 'array' } = {},
): DagState {
  let state = buildDefaultDagState();
  // Pin the box's authored params so STATIC_POS is meaningful.
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'position',
    value: STATIC_POS,
  }).next;
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'rotation',
    value: STATIC_ROT,
  }).next;

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: CHAN_ID,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: BOX_ID,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: KF0_POS, easing: 'linear' },
          { time: 1, value: KF1_POS, easing: 'linear' },
        ],
      },
    },
    {
      type: 'addNode',
      nodeId: LAYER_ID,
      nodeType: 'AnimationLayer',
      params: { name: 'L', weight: 1, mute: false, solo: false, boneMask: [] },
    },
    // addLayer rewire: box→scene becomes layer→scene; box→layer.target.
    {
      type: 'disconnect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: LAYER_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: LAYER_ID, socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: CHAN_ID, socket: 'out' },
      to: { node: LAYER_ID, socket: 'animation' },
    },
    // The channel samples inputs.time?.seconds — wire it to the project
    // clock (n_time, a TimeSource that emits ctx.time) so the resolver's
    // ctx actually drives the sampled value (mirrors nodes.test.ts).
    {
      type: 'connect',
      from: { node: 'n_time', socket: 'out' },
      to: { node: CHAN_ID, socket: 'time' },
    },
  ];
  if (opts.rotChannel) {
    ops.push(
      {
        type: 'addNode',
        nodeId: ROT_CHAN_ID,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'rot',
          target: BOX_ID,
          paramPath: 'rotation',
          keyframes: [
            { time: 0, value: [0, 90, 0], easing: 'linear' },
            { time: 1, value: [0, 180, 0], easing: 'linear' },
          ],
        },
      },
      {
        type: 'connect',
        from: { node: ROT_CHAN_ID, socket: 'out' },
        to: { node: LAYER_ID, socket: 'animation' },
      },
      {
        type: 'connect',
        from: { node: 'n_time', socket: 'out' },
        to: { node: ROT_CHAN_ID, socket: 'time' },
      },
    );
  }
  for (const op of ops) state = applyOp(state, op).next;

  // Production shape (default): `connect box→layer.target` produces a BARE
  // single-cardinality NodeRef binding (observed: addLayer emits one
  // `connect` op; AnimationLayer.target is cardinality:'single'). The
  // `Array.isArray(b)?b:[b]` at addLayer.ts:101 is only the consumer-rewire
  // READ loop, NOT what is written to `layer.inputs.target`.
  //
  // FLAG-B coverage is a SEPARATE concern: the resolver's step-4
  // `normalizeRefs` must tolerate an array-shaped binding when TESTING
  // layer-target membership. Forcing the *evaluated* state's target input
  // to an array would break AnimationLayer.evaluate itself (the evaluator
  // resolves an array binding into an array VALUE — evaluator.ts:98-107 —
  // so patchTarget loses the channel; that is an AnimationLayer-input
  // concern OUT of 7.3 scope). So 'array' shape is used only by the
  // dedicated FLAG-B assertion, which asserts select-by-box still RESOLVES
  // (membership path exercised), not the patched value.
  if (opts.targetBindShape === 'array') {
    const layer = state.nodes[LAYER_ID];
    const t = layer.inputs.target;
    state = {
      ...state,
      nodes: {
        ...state.nodes,
        [LAYER_ID]: {
          ...layer,
          inputs: {
            ...layer.inputs,
            target: Array.isArray(t) ? t : [t],
          },
        },
      },
    };
  }
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('resolveEvaluatedTransform', () => {
  // 1. ANIMATED PATCH (anti-trap, issue #68): resolver returns the patched
  //    clone value, DISTINCT from evaluate(box) raw + the static params.
  it('returns the patched (animated) value, NOT the raw node value', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0); // channel value at t=0 = KF0_POS
    const r = resolveEvaluatedTransform(state, BOX_ID, ctx);
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(KF0_POS);

    // The trap: evaluate(state, boxId) returns the box's RAW value.
    const raw = evaluate(state, BOX_ID, ctx).value as BoxMeshValue;
    expect(raw.position).toEqual(STATIC_POS);
    // The gap IS the test: resolver ≠ raw ≠ static authored param.
    expect(r!.position).not.toEqual(raw.position);
    expect(r!.position).not.toEqual(STATIC_POS);
  });

  // 2. SELECT-BY-LAYER (D-01) — box id OR layer id → same transform.
  it('resolves the same transform whether box or layer id is selected (D-01)', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0);
    const byBox = resolveEvaluatedTransform(state, BOX_ID, ctx);
    const byLayer = resolveEvaluatedTransform(state, LAYER_ID, ctx);
    expect(byBox).not.toBeNull();
    expect(byLayer).not.toBeNull();
    expect(byLayer).toEqual(byBox);
    expect(byLayer!.position).toEqual(KF0_POS);
  });

  // 2b. FLAG-B — the resolver's step-4 `normalizeRefs` must tolerate an
  //     array-shaped `inputs.target` binding when testing layer-target
  //     membership: select-by-box must still RESOLVE (non-null) so a
  //     wrapped binding can never silently break select-by-box (D-01). The
  //     PATCHED value is NOT asserted here — the evaluator resolves an array
  //     binding into an array VALUE (evaluator.ts:98-107), which is an
  //     AnimationLayer-input concern out of 7.3 scope; the resolver's
  //     membership path is what FLAG-B guards.
  it('membership test tolerates an array-shaped inputs.target binding (FLAG-B)', () => {
    const bare = buildAnimatedState();
    const arr = buildAnimatedState({ targetBindShape: 'array' });
    const ctx = ctxAt(0);
    // A bare-ref-only assumption in step 4 would miss the wrapped target
    // and return null for select-by-box. normalizeRefs prevents that.
    const byBoxArr = resolveEvaluatedTransform(arr, BOX_ID, ctx);
    expect(byBoxArr).not.toBeNull();
    // Sanity: the bare canonical path resolves the patched value.
    expect(resolveEvaluatedTransform(bare, BOX_ID, ctx)!.position).toEqual(KF0_POS);
  });

  // 3. PER-PARAM FALLBACK (D-04): position animated, rotation NOT — rotation
  //    is read off the patched clone, which preserves un-channelled fields,
  //    so it equals the static authored rotation.
  it('position follows eval while un-channelled rotation stays the static authored value (D-04)', () => {
    const state = buildAnimatedState(); // only a position channel
    const ctx = ctxAt(0.5);
    const r = resolveEvaluatedTransform(state, BOX_ID, ctx);
    expect(r).not.toBeNull();
    // position interpolates between KF0 and KF1 at t=0.5 (linear midpoint).
    expect(r!.position).toEqual([4, 5, 6]);
    // rotation un-channelled → patched clone preserves static authored value.
    expect(r!.rotation).toEqual(STATIC_ROT);
  });

  // 4. PLAYHEAD TRACKING: two distinct times → two distinct positions
  //    matching the channel samples (≥2 — mirrors D-06 at the unit layer).
  it('tracks the playhead: distinct times yield distinct evaluated positions', () => {
    const state = buildAnimatedState();
    const at0 = resolveEvaluatedTransform(state, BOX_ID, ctxAt(0));
    const at1 = resolveEvaluatedTransform(state, BOX_ID, ctxAt(1));
    expect(at0!.position).toEqual(KF0_POS);
    expect(at1!.position).toEqual(KF1_POS);
    expect(at0!.position).not.toEqual(at1!.position);
  });

  // 5. IDENTITY-NULL: unknown id, and a node that is neither a scene child
  //    nor a wrapped target → null (no throw).
  it('returns null for an unknown id and for a non-rendered node (no crash)', () => {
    const state = buildAnimatedState();
    expect(resolveEvaluatedTransform(state, 'not_a_node', ctxAt(0))).toBeNull();
    // n_camera is a real node but not a scene child / wrapped target.
    expect(resolveEvaluatedTransform(state, 'n_camera', ctxAt(0))).toBeNull();
  });

  // 6. SCALE/SIZE: BoxMesh has `size`, no `scale` → resolver returns scale
  //    from the size fallback (mirrors getManipulable Gizmo.tsx:69-76).
  it('reads scale from the BoxMesh size fallback when no explicit scale', () => {
    const state = buildAnimatedState();
    const r = resolveEvaluatedTransform(state, BOX_ID, ctxAt(0));
    expect(r).not.toBeNull();
    // The default box size is [1,1,1]; BoxMesh has no `scale` field, so the
    // resolver falls back to `.size` per the documented contract.
    expect(r!.scale).toEqual([1, 1, 1]);
  });
});
