// resolveTransformParam — the per-PARAM seam for the NPanel field display.
// This suite observes the CONSUMER side of the H40 producer/consumer
// boundary (the diagnostic question H40 mandates: "which side of the
// boundary did I observe — the evaluator, or the surface?"). The
// HEADLINE assertion (test 1) is the H40 distinctness anti-trap proof:
// helper output ≠ raw `node.params.X` at the on-key frame for an animated
// node. Equal values would silently pass for a no-op implementation —
// the gap IS the test.
//
// Harness shape mirrors resolveEvaluatedTransform.test.ts exactly: same
// default project + addLayer-shape rewire, same channel samples, same
// `ctxAt(seconds)` helper. We re-seed the static authored params so
// `STATIC_POS` is meaningful as the foil to the patched-clone value.
//
// REF: issue #69, CONTEXT D-01/D-03 (.planning/phases/7.4-npanel-evaluated-display/CONTEXT.md),
//      hetvabhasa H40 (.anvi/hetvabhasa.md:994-1014), PLAN W1.1.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveTransformParam } from './resolveTransformParam';

const BOX_ID = 'n_box';
const CHAN_ID = 'n_pos_channel';

// The authored static values — deliberately DIFFERENT from the channel
// samples so the distinctness assertion is a real gap, not trivially true.
const STATIC_POS: [number, number, number] = [0, 0, 0];
const STATIC_ROT: [number, number, number] = [0, 0, 0];
const KF0_POS: [number, number, number] = [1, 2, 3];
const KF1_POS: [number, number, number] = [7, 8, 9];

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/**
 * Build the default project, pin the box's authored params, then add a
 * FREE-FLOATING direct channel targeting the box (v0.7 #199 / V57 — no
 * AnimationLayer wrapper, no scene rewire; the box stays its own scene child).
 * The resolver overlays the channel via overlayChannels at ctx.time.seconds.
 */
function buildAnimatedState(): DagState {
  let state = buildDefaultDagState();

  // Pin the box's static authored values so STATIC_POS is the meaningful
  // foil for the distinctness assertion.
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
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('resolveTransformParam', () => {
  // 1. H40 DISTINCTNESS ANTI-TRAP — THE headline assertion. The helper's
  //    return value MUST differ from `state.nodes[BOX_ID].params.position`
  //    at the on-key frame. Equal values would silently pass for a
  //    `return node.params[paramPath]` no-op; the GAP is the proof that
  //    the helper actually unwraps the AnimationLayer patched clone
  //    (H40 mechanism) rather than reading the dead source.
  it('returns the patched (animated) value at the on-key frame, DISTINCT from node.params (H40 anti-trap)', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0); // on KF0

    const v = resolveTransformParam(state, BOX_ID, 'position', ctx);
    expect(v).not.toBeNull();
    expect(v).toEqual(KF0_POS);

    // The trap: a naive helper that returned `state.nodes[BOX_ID].params.position`
    // would return STATIC_POS — the authored value, frozen for the whole
    // animation. The distinctness IS the proof of unwrap.
    const raw = state.nodes[BOX_ID].params.position;
    expect(raw).toEqual(STATIC_POS);
    expect(v).not.toEqual(raw);
  });

  // 3. NULL FALLBACK — outer-null paths (caller falls back to static
  //    `value` per D-01). Three concrete null branches: nothing selected,
  //    a real node that is neither a scene child nor a wrapped target,
  //    and an unknown id.
  it('returns null when nothing is selected, for non-rendered nodes, and for unknown ids (D-01 outer-null)', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0);

    // Nothing selected.
    expect(resolveTransformParam(state, null, 'position', ctx)).toBeNull();

    // A real node that is neither a scene child nor a wrapped layer
    // target (n_camera is wired to scene.camera, not scene.children).
    expect(resolveTransformParam(state, 'n_camera', 'position', ctx)).toBeNull();

    // Unknown id.
    expect(resolveTransformParam(state, 'not_a_node', 'position', ctx)).toBeNull();
  });

  // 4. PER-PARAM FALLBACK — un-channelled sibling: position is animated,
  //    rotation is NOT. The resolver preserves un-channelled fields on
  //    the patched clone, so `result.rotation` is the static authored
  //    Vec3 (NOT null — verified at resolveEvaluatedTransform.test.ts:233-242).
  //    The helper passes that Vec3 through unchanged; the W2.1 callsite
  //    will display it. The per-param fallback contract (D-01) is what
  //    matters: rotation is NEVER mis-overwritten by position's animated
  //    value — the projection is field-scoped.
  it('passes the un-channelled sibling field through (rotation = static authored when only position is animated)', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0.5);

    // position interpolates between KF0_POS and KF1_POS at t=0.5.
    const pos = resolveTransformParam(state, BOX_ID, 'position', ctx);
    expect(pos).toEqual([4, 5, 6]);

    // rotation is un-channelled → the patched clone preserves the static
    // authored rotation; the helper passes it through (NOT null — the
    // resolver's contract, mirrored at the per-param seam).
    const rot = resolveTransformParam(state, BOX_ID, 'rotation', ctx);
    expect(rot).toEqual(STATIC_ROT);
  });

  // 5. D-03 SCOPE GUARD (transform-only fence, encoded in code): a
  //    non-transform paramPath must return null IMMEDIATELY so the
  //    NPanel field for that param keeps its static-source behavior by
  //    construction. The W2.1 callsite relies on this — without the
  //    fence the helper would accidentally null-out any per-param call
  //    for material colour, opacity, etc., and the callsite's per-param
  //    fallback would still work but the helper would be advertising a
  //    broader scope than 7.4 owns. The fence keeps the contract honest.
  it('returns null for non-transform paramPaths (D-03 transform-only fence)', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0);

    // Material colour — a real animated-param class in the future, but
    // explicitly OUT of 7.4 scope (D-03). Helper returns null → caller
    // shows the static authored value.
    expect(resolveTransformParam(state, BOX_ID, 'color', ctx)).toBeNull();
    // Opacity — same fence.
    expect(resolveTransformParam(state, BOX_ID, 'opacity', ctx)).toBeNull();
    // Even a transform-adjacent name like 'size' is OUT — the helper's
    // contract is 'position' | 'rotation' | 'scale' only; the scale field
    // already absorbs the BoxMesh-style size fallback inside the resolver.
    expect(resolveTransformParam(state, BOX_ID, 'size', ctx)).toBeNull();
  });

  // 6. PER-PARAM INTERPOLATION: at a NON-key frame the helper returns
  //    an interpolated Vec3 STRICTLY between the surrounding KFs. This
  //    confirms (a) the resolver is invoked at the caller's cadence
  //    (not snapped to a stored sample), and (b) the helper does not
  //    cache/quantise the value. Mirrors D-06's "≥2 playhead times"
  //    boundary-pair gate at the unit layer.
  it('tracks the playhead: distinct ctx times yield distinct interpolated values', () => {
    const state = buildAnimatedState();
    const at0 = resolveTransformParam(state, BOX_ID, 'position', ctxAt(0));
    const atMid = resolveTransformParam(state, BOX_ID, 'position', ctxAt(0.5));
    const at1 = resolveTransformParam(state, BOX_ID, 'position', ctxAt(1));

    expect(at0).toEqual(KF0_POS);
    expect(at1).toEqual(KF1_POS);
    // Mid value is strictly between the two KFs on every axis (linear
    // easing) — confirms live interpolation, not a stored sample.
    expect(atMid).toEqual([4, 5, 6]);
    expect(atMid).not.toEqual(at0);
    expect(atMid).not.toEqual(at1);
  });
});
