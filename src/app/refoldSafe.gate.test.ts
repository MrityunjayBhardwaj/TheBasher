// Gate for the tier the render root folds — `foldOverlays(..., { only: 'refoldSafe' })`
// (#583, epic #575).
//
// ── WHAT MAKES THIS TIER DIFFERENT FROM "STATIC", AND WHY THE DIFFERENCE NEEDED A GATE ──
//
// The obvious rule for a fold running before a seam that folds again is "fold the paths
// that do not vary over t". That rule is not sufficient, and the insufficiency is silent.
// A single-keyframe channel at influence 0.5 is perfectly static — it computes the same
// value at every playhead position — and folding it early still produces a WRONG picture,
// because `replaceBlend` lerps FROM THE BASE below full influence and this fold has just
// moved the base. The result is not the overlay applied twice; it is a third value that is
// neither the authored one nor the overlaid one.
//
// So the tier is a conjunction, and the two halves fail in different directions:
//
//   • the transient half guards the PLAYHEAD. The render root evaluates at ctx.time frozen
//     at zero, so a path whose value comes from sampling would be written at frame 0 and
//     frozen there for the whole scrub.
//   • the `!readsBase` half guards the ARITHMETIC downstream.
//
// Each case below fails only one half, so neither can be dropped without a red. That is
// the property being bought here — a gate whose cases all fail for the same reason would
// let either half be deleted quietly.
//
// ── WHY THE ASSERTIONS ARE ON THE FOLDED PARAMS AND NOT ON A PREDICATE ──────────────────
//
// `refoldSafe` is not exported, on purpose. A gate that called it directly would prove the
// predicate agrees with itself while saying nothing about whether the fold consults it —
// and "the classifier is right but nobody asks it" is a live failure mode on this rail
// (the membership set that was widened correctly while the gate that read it never
// mounted). So every case here asks the FOLD what it did, through its output.
//
// REF: src/app/cookState.ts (the tier + `PathOverlay`), src/nodes/foldChannel.ts (the
//      arithmetic the tier is derived from), src/viewport/SceneFromDAG.tsx (the caller);
//      issues #583, #575, #474.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, EvalCtx, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { foldOverlays, createFoldCache } from './cookState';
import { useTransientEditStore } from './stores/transientEditStore';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

const at = (seconds: number): EvalCtx => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** One BoxData → ArrayModifier chain. `count` is the param every case overlays. */
function scene(extra: Op[] = []): DagState {
  let state = emptyDagState();
  const ops: Op[] = [
    { type: 'addNode', nodeId: 'box', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
    {
      type: 'addNode',
      nodeId: 'arr',
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0], muted: false },
    },
    {
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'arr', socket: 'target' },
    },
  ];
  for (const op of [...ops, ...extra]) state = applyOp(state, op).next;
  return state;
}

/** A channel on `arr.count`. `keys` keyframes, and whatever blend the case is about. */
function channelOp(keys: number, blend?: { weight?: number; blendMode?: string }): Op {
  return {
    type: 'addNode',
    nodeId: 'ch',
    nodeType: 'KeyframeChannelNumber',
    params: {
      target: 'arr',
      paramPath: 'count',
      keyframes: Array.from({ length: keys }, (_, k) => ({
        time: k,
        value: 30 + k,
        interpolation: 'linear',
      })),
      ...blend,
    },
  };
}

const countOf = (s: { nodes: Record<string, { params: unknown }> }, id: string) =>
  (s.nodes[id].params as { count: number }).count;

/** Fold at the render root's tier, at the render root's frozen clock. */
const foldAtRoot = (s: DagState) => foldOverlays(s, at(0), undefined, { only: 'refoldSafe' });

describe('#583 — the tier the render root may fold', () => {
  beforeAll(() => registerAllNodes());
  afterEach(() => useTransientEditStore.getState().clearAll());

  it('folds a held edit — the #474 shape, and the reason the tier exists at all', () => {
    const s = scene();
    useTransientEditStore.getState().set('arr', 'count', 9);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(9);
  });

  it('folds a held edit sitting on a FULL-INFLUENCE channel — #474’s reachable case', () => {
    // "Animate a param, then drag it" is how issue #474 says the bug is actually reached,
    // and a bare transient-only rule would refuse exactly this. It is safe for the same
    // reason the tier is safe at all: a full-influence `replace` discards the base, so
    // moving the base is invisible to it, and the transient is applied last regardless.
    //
    // Note the channel has TWO keys — it genuinely varies over t — and the path is folded
    // anyway. That is not an oversight: what is written is the TRANSIENT's value, which
    // `resolveEvaluatedParam` returns without sampling anything, so nothing about this
    // fold depends on the frozen playhead.
    const s = scene([channelOp(2)]);
    useTransientEditStore.getState().set('arr', 'count', 9);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(9);
  });

  it('REFUSES a path whose channel blends against the base — combine', () => {
    // Fails the `!readsBase` half ONLY: there is a held edit, so the transient half is
    // satisfied. `combineBlend` adds onto whatever base it is handed, so folding here
    // would have the downstream seam add the overlay onto an already-overlaid base.
    const s = scene([channelOp(1, { blendMode: 'combine' })]);
    useTransientEditStore.getState().set('arr', 'count', 9);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(3);
  });

  it('REFUSES a path whose channel sits below full influence', () => {
    // Also fails the `!readsBase` half only — and this is the case that proves the tier is
    // not just "static". A one-key channel does not vary over t by any definition, so a
    // staticness rule would fold this path; `replaceBlend` still lerps from the base at
    // weight 0.5, so folding it is wrong.
    const s = scene([channelOp(1, { weight: 0.5 })]);
    useTransientEditStore.getState().set('arr', 'count', 9);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(3);
  });

  it('REFUSES a TIME-VARYING path — the freeze this tier exists to prevent', () => {
    // The case the issue asks for by name, because folding this path is the specific way
    // the slice goes wrong QUIETLY. A two-key channel genuinely varies over t; the render
    // root evaluates at a playhead frozen at zero. Fold it here and params carry the
    // frame-0 sample forever — the object holds still through the entire scrub while every
    // read surface reports it animating, and no static scene can tell the difference.
    //
    // Distinct from the single-key case below, which fails the same half for a different
    // reason: that one is static and still refused for want of a held edit. This one would
    // be refused even if the tier were the naive "fold what does not vary".
    const s = scene([channelOp(2)]);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(3);
  });

  it('REFUSES a path with no held edit, however static its channel is', () => {
    // Fails the transient half ONLY: a single-key channel at full influence is static AND
    // an overwrite, so `!readsBase` is satisfied and it is still not folded here. The
    // render root's clock is frozen, and this is the tier that refuses to depend on it.
    const s = scene([channelOp(1)]);
    expect(countOf(foldAtRoot(s), 'arr')).toBe(3);
  });

  it('the unrestricted fold DOES take that path — so the refusals are the mode, not the fold', () => {
    // Without this, every refusal above would also pass for a fold that had simply stopped
    // working, or for a fixture whose channel never bound to its target at all.
    const s = scene([channelOp(1)]);
    expect(countOf(foldOverlays(s, at(0), undefined, {}), 'arr')).toBe(30);
  });

  it('a scene with only refused paths comes back BY REFERENCE', () => {
    // The mode must not cost a rebuild for deciding to do nothing. `toBe`, because an
    // equal-but-fresh state is precisely the defect the identity discipline exists for.
    const s = scene([channelOp(1)]);
    expect(foldAtRoot(s)).toBe(s);
  });

  it('a MOVING held edit is re-resolved, not served from the cache', () => {
    // The freeze this catches was found by wiring the root, not by reasoning: the fold
    // cached on (authored params, seconds), and during a drag NEITHER moves — the params
    // object is untouched by design, and the root's playhead is frozen at zero. Both skip
    // arms fired, so the first drag frame's value was served for the rest of the drag.
    //
    // The tell in the browser is the cruelest kind: it repaints once, so the wiring looks
    // correct, and then holds still while the inspector reports the value it will not draw.
    const s = scene();
    const fold = createFoldCache();
    const store = useTransientEditStore.getState();

    store.set('arr', 'count', 9);
    expect(countOf(foldOverlays(s, at(0), undefined, { fold, only: 'refoldSafe' }), 'arr')).toBe(9);
    store.set('arr', 'count', 11);
    expect(countOf(foldOverlays(s, at(0), undefined, { fold, only: 'refoldSafe' }), 'arr')).toBe(
      11,
    );
    store.clearAll();
    expect(countOf(foldOverlays(s, at(0), undefined, { fold, only: 'refoldSafe' }), 'arr')).toBe(3);
  });

  it('an UNMOVED held edit still keeps its params object across calls', () => {
    // The other side of the case above: the cache term added for correctness must not have
    // cost the identity reuse the fold exists to preserve. Same store, same params, so the
    // re-resolve finds the value unmoved and hands back the same object.
    const s = scene();
    const fold = createFoldCache();
    useTransientEditStore.getState().set('arr', 'count', 9);
    const a = foldOverlays(s, at(0), undefined, { fold, only: 'refoldSafe' });
    const b = foldOverlays(s, at(0), undefined, { fold, only: 'refoldSafe' });
    expect(b.nodes.arr.params).toBe(a.nodes.arr.params);
  });

  it('the caller weight is 1 at EVERY overlayChannels call site', () => {
    // `readsBase` compares a channel's own weight against 1 and ignores the CALLER weight,
    // which is sound only while every caller passes 1. That is true today at all of them,
    // and it is the kind of premise that decays without a witness: a caller that starts
    // passing 0.5 makes every full-influence channel read the base, and this tier would go
    // on folding paths it must refuse — with no value assertion anywhere able to see it.
    //
    // Asserted as a census over the call sites rather than as a note, and stated as an
    // EXACT count so a new caller has to come here and answer rather than joining silently.
    const calls: string[] = [];
    for (const [, src] of sourceFiles()) {
      for (const m of stripComments(src).matchAll(/overlayChannels\([^)]*\)/g)) calls.push(m[0]);
    }
    // EXACT, not a floor. A census whose subject can empty goes green by losing its
    // corpus — a renamed helper, a narrowed file list — and reports the strongest possible
    // result for having measured nothing at all.
    expect(calls).toHaveLength(9);
    expect(calls.filter((c) => !/,\s*1,\s*/.test(c))).toEqual([]);
  });
});
