// #902 — MotionGenerate: a generated clip has a producer the graph can re-cook.
//
// The claim under test is not "the node exists". It is the one the issue is
// about: EDITING THE CURVE CHANGES THE REQUEST. A node that took its path by id
// would pass every other row here and fail that one, which is why it leads.

import { beforeEach, describe, expect, it } from 'vitest';
import { createEvaluatorCache, evaluate } from '../core/dag/evaluator';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import type { DagState } from '../core/dag/state';
import { registerAllNodes } from './registerAll';
import { MotionGenerateParams } from './MotionGenerate';
import {
  __resetGeneratedClipsForTests,
  recordGeneratedClip,
  recordGenerationFailure,
} from '../core/motiongen/generatedClipCache';
import type { AnimationClipValue, SkeletonValue } from './types';

const RIG: SkeletonValue = {
  kind: 'Skeleton',
  bones: [{ name: 'Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] }],
};

/** CurveData → Object → MotionGenerate. The path arrives as an EDGE. */
function buildGraph(points?: { id: string; co: [number, number, number] }[]): DagState {
  let s = emptyDagState();
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'curve',
      nodeType: 'CurveData',
      params: points ? { points } : {},
    },
    { type: 'addNode', nodeId: 'obj', nodeType: 'Object', params: {} },
    {
      type: 'addNode',
      nodeId: 'gen',
      nodeType: 'MotionGenerate',
      params: { prompt: 'a slow walk', seed: 7, model: 'kimodo-base' },
    },
    {
      type: 'connect',
      from: { node: 'curve', socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    },
    { type: 'connect', from: { node: 'obj', socket: 'out' }, to: { node: 'gen', socket: 'path' } },
  ];
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

const clipOf = (s: DagState, cache?: ReturnType<typeof createEvaluatorCache>): AnimationClipValue =>
  evaluate(s, 'gen', cache ? { cache } : {}).value as AnimationClipValue;

const frame = (n: number): EvalCtx => ({
  time: { frame: n, seconds: n / 24, normalized: 0 },
});

describe('MotionGenerate (#902)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  // ── the property the issue exists for ────────────────────────────────────
  it('moving a control point changes the request — the re-cook the issue promises', () => {
    const before = buildGraph([
      { id: 'cp0', co: [0, 0, 0] },
      { id: 'cp1', co: [1, 0, 0] },
      { id: 'cp2', co: [2, 0, 0] },
      { id: 'cp3', co: [3, 0, 0] },
    ]);
    const after = buildGraph([
      { id: 'cp0', co: [0, 0, 0] },
      { id: 'cp1', co: [1, 0, 5] }, // dragged
      { id: 'cp2', co: [2, 0, 0] },
      { id: 'cp3', co: [3, 0, 0] },
    ]);

    // ANTI-VACUITY (the fixture must be able to exhibit the property): the two
    // curves must actually differ downstream, or the row below compares a value
    // with itself and passes for a reason that has nothing to do with the node.
    const curveBefore = evaluate(before, 'curve').hash;
    const curveAfter = evaluate(after, 'curve').hash;
    expect(curveBefore).not.toBe(curveAfter);

    expect(clipOf(before).generation?.requestHash).not.toBe(clipOf(after).generation?.requestHash);
  });

  it('moving the path OBJECT changes the request — placement is part of it', () => {
    const at0 = buildGraph();
    const moved = applyOp(at0, {
      type: 'setParam',
      nodeId: 'obj',
      paramPath: 'position',
      value: [10, 0, 4],
    }).next;
    expect(clipOf(at0).generation?.requestHash).not.toBe(clipOf(moved).generation?.requestHash);
  });

  it('renaming does NOT change the request — a rename must not re-run a paid call', () => {
    const s = buildGraph();
    const renamed = applyOp(s, {
      type: 'setParam',
      nodeId: 'gen',
      paramPath: 'name',
      value: 'stroll',
    }).next;
    expect(clipOf(renamed).generation?.requestHash).toBe(clipOf(s).generation?.requestHash);
    expect(clipOf(renamed).name).toBe('stroll');
  });

  it('the seed and the prompt DO change the request', () => {
    const s = buildGraph();
    const reseeded = applyOp(s, {
      type: 'setParam',
      nodeId: 'gen',
      paramPath: 'seed',
      value: 8,
    }).next;
    const reprompted = applyOp(s, {
      type: 'setParam',
      nodeId: 'gen',
      paramPath: 'prompt',
      value: 'a fast run',
    }).next;
    const base = clipOf(s).generation?.requestHash;
    expect(clipOf(reseeded).generation?.requestHash).not.toBe(base);
    expect(clipOf(reprompted).generation?.requestHash).not.toBe(base);
  });

  // ── the wait state ───────────────────────────────────────────────────────
  it('an unresolved request is PENDING, and is not an empty clip', () => {
    const clip = clipOf(buildGraph());
    expect(clip.generation?.status).toBe('pending');
    expect(clip.keyframes).toHaveLength(0);
    // The discriminating half: a pending clip must not be readable as a clip
    // that legitimately produced nothing.
    expect(clip.duration).toBe(0);
    expect(clip.generation?.reason).toBeUndefined();
  });

  it('once recorded, the SAME graph evaluates to the generated clip', () => {
    const s = buildGraph();
    const hash = clipOf(s).generation!.requestHash;
    recordGeneratedClip(hash, {
      duration: 2.5,
      keyframes: [{ bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] }],
      skeleton: RIG,
      model: 'kimodo-base',
    });
    const clip = clipOf(s);
    expect(clip.generation?.status).toBe('ready');
    expect(clip.duration).toBe(2.5);
    expect(clip.keyframes).toHaveLength(1);
    expect(clip.skeleton.bones).toHaveLength(1);
  });

  it('a failure is TERMINAL and carries its reason', () => {
    const s = buildGraph();
    const hash = clipOf(s).generation!.requestHash;
    recordGenerationFailure(hash, 'motion service unreachable');
    const clip = clipOf(s);
    expect(clip.generation?.status).toBe('failed');
    expect(clip.generation?.reason).toBe('motion service unreachable');
  });

  it('first write wins — a second result never changes a clip the graph has seen', () => {
    const s = buildGraph();
    const hash = clipOf(s).generation!.requestHash;
    recordGeneratedClip(hash, { duration: 1, keyframes: [], skeleton: RIG, model: 'm' });
    recordGeneratedClip(hash, { duration: 99, keyframes: [], skeleton: RIG, model: 'm' });
    expect(clipOf(s).duration).toBe(1);
  });

  // ── purity: the measured reason the node is not `pure: false` ────────────
  it('holds ONE cache entry across ten frames — not one per frame', () => {
    const s = buildGraph();
    const cache = createEvaluatorCache();
    for (let f = 0; f < 10; f++) evaluate(s, 'gen', { cache, ctx: frame(f) });
    // The generator's own entry must not multiply with time. Upstream curve and
    // object entries are in here too, so the bound is the graph's node count —
    // what would fail is the per-frame explosion (30 entries), not a fixed few.
    expect(cache.size()).toBeLessThanOrEqual(3);
  });

  // ── the seed is unconstructible-by-omission ──────────────────────────────
  it('refuses a node with no seed, no prompt, or no model', () => {
    expect(MotionGenerateParams.safeParse({ prompt: 'walk', model: 'm' }).success).toBe(false);
    expect(MotionGenerateParams.safeParse({ seed: 1, model: 'm' }).success).toBe(false);
    expect(MotionGenerateParams.safeParse({ prompt: 'walk', seed: 1 }).success).toBe(false);
    // ...and accepts the complete one, so the three rows above are refusals of
    // the NAMED field rather than of the object shape.
    expect(MotionGenerateParams.safeParse({ prompt: 'walk', seed: 1, model: 'm' }).success).toBe(
      true,
    );
  });

  it('no path wired is an ordinary generation, distinct from a wired one', () => {
    let bare = emptyDagState();
    for (const op of [
      {
        type: 'addNode',
        nodeId: 'gen',
        nodeType: 'MotionGenerate',
        params: { prompt: 'a slow walk', seed: 7, model: 'kimodo-base' },
      } as Op,
    ]) {
      bare = applyOp(bare, op).next;
    }
    const bareHash = (evaluate(bare, 'gen').value as AnimationClipValue).generation?.requestHash;
    expect(bareHash).toBeTruthy();
    // "no path" and "this path" are different requests — collapsing them would
    // let a pathless generation serve a curve-following one from cache.
    expect(bareHash).not.toBe(clipOf(buildGraph()).generation?.requestHash);
  });
});
