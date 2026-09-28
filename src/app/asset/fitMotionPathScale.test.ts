// #1285 — a walk along a drawn path is asked for in the generator's metres, so the retarget lands
// the character on the curve instead of stopping it at the rigs' leg ratio.
//
// THE ROW THAT CARRIES IT is the request: after the fit, the waypoints the generator receives are
// the drawn ones scaled about the start by 1 / (the ratio the retarget applies). Everything else
// here says when that happens and when it must not.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../../core/dag/ops';
import { emptyDagState } from '../../core/dag/state';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetGeneratedClipsForTests } from '../../core/motiongen/generatedClipCache';
import {
  synthesiseBvh,
  STUB_UNIT_SCALE,
} from '../../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';
import { rootTravelScale } from '../../core/import/retarget';
import { evaluate } from '../../core/dag/evaluator';
import { motionRequestHash, type MotionGenerateParams } from '../../nodes/MotionGenerate';
import type { ObjectValue } from '../../nodes/types';
import { edgeTarget } from '../animate/graphNodes';
import { retargetOperandsFromNodes } from '../animate/retargetFromNodes';
import { validatePlan } from '../../agent/mutators/index';
import { retargetMutator } from '../../agent/mutators/builders/retarget';
import { resolvePendingMotionGenerations, waypointsInSourceMetres } from './resolveMotionGenerate';
import { bakeGeneratedClipOps } from './bakeGeneratedClip';
import { mintMotionGenerateOps } from './mintMotionGenerate';
import { waypointsFromCurve } from './motionPathFromCurve';
import { motionCookOffer } from './cookMotionGenerations';
import { fitMotionPathScaleOps, motionPathScaleFit } from './fitMotionPathScale';

const BRIDGE: Record<string, string> = { Hips: 'Hips', Spine: 'Spine' };

/** A stub generator that remembers every request it was sent. */
function recordingCapability() {
  const requests: MotionGenerationRequest[] = [];
  const cap: MotionGenerationCapability = {
    id: 'stub',
    kind: 'stub',
    isAvailable: async () => true,
    async generate(request): Promise<MotionGenerationResult> {
      requests.push(request);
      return {
        jobId: `job-${requests.length}`,
        bvh: synthesiseBvh(request),
        model: request.model,
        unitScale: STUB_UNIT_SCALE,
        worldOffsetXZ: [0, 0],
        worldRotationRadians: null,
      };
    },
    cancel: async () => {},
  };
  return { cap, requests };
}

function apply(s: DagState, ops: readonly Op[]): DagState {
  let next = s;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A character whose hips stand at `hipHeight` — a native `Skeleton`, the kind a bind retargets
 *  onto since the clone road's `GltfSkeleton` stopped being a bind target (#1053). */
function characterOps(id: string, hipHeight: number): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: `${id}_skel`,
      nodeType: 'Skeleton',
      params: {
        bones: [
          { name: 'Hips', parent: -1, position: [0, hipHeight, 0], rotation: [0, 0, 0] },
          { name: 'Spine', parent: 0, position: [0, 0.5, 0], rotation: [0, 0, 0] },
        ],
      },
    },
  ] as Op[];
}

function project(): DagState {
  return apply(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    { type: 'addNode', nodeId: 'curve', nodeType: 'CurveData', params: {} },
    { type: 'addNode', nodeId: 'pathObj', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'curve', socket: 'out' },
      to: { node: 'pathObj', socket: 'data' },
    },
    ...characterOps('tall', 1.2),
    ...characterOps('short', 0.6),
  ] as Op[]);
}

/** Bind a generated clip to a character through the product's own retarget mutator. */
function bind(s: DagState, clipId: string, characterSkel: string, outputClipId: string): DagState {
  const plan = validatePlan(
    retargetMutator,
    {
      sourceId: clipId,
      sourceSkeletonId: edgeTarget(s.nodes[clipId], 'skeleton')!,
      targetSkeletonId: characterSkel,
      customMap: BRIDGE,
      outputClipId,
    },
    s,
    'bind the generated motion',
  );
  if (!plan.ok) throw new Error(`the real bind refused: ${plan.reason}`);
  return apply(s, plan.ops as Op[]);
}

/** Mint along the path, cook once (the rig lands), bake. */
async function mintAndCook(cap: MotionGenerationCapability, withPath = true) {
  const mint = mintMotionGenerateOps(project(), {
    prompt: 'a slow walk',
    seed: 7,
    model: 'kimodo-base',
    ...(withPath ? { curveObjectId: 'pathObj' } : {}),
  });
  let s = apply(project(), mint.ops as Op[]);
  await resolvePendingMotionGenerations(s, cap);
  s = apply(s, bakeGeneratedClipOps(s));
  return { s, producerId: mint.producerId, clipId: mint.clipId };
}

/** The ratio the retarget itself will apply for this RetargetClip, read off its own operands. */
function appliedRatio(s: DagState, retargetId: string): number {
  const o = retargetOperandsFromNodes(s.nodes, s.nodes[retargetId])!;
  return rootTravelScale(o.sourceBones!, o.map!, o.targetBones!);
}

describe('fitting a generated walk’s path to its character (#1285)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('asks again for the drawn path divided by the ratio the retarget applies', async () => {
    const { cap, requests } = recordingCapability();
    const { s: cooked, producerId, clipId } = await mintAndCook(cap);
    const drawn = requests[0].constraints!.waypoints!;
    expect(drawn.length).toBeGreaterThan(1);

    let s = bind(cooked, clipId, 'tall_skel', 'tall_walk');
    const ratio = appliedRatio(s, 'tall_walk');
    // A fixture where the ratio is 1 would pass with the fit deleted.
    expect(Math.abs(ratio - 1)).toBeGreaterThan(0.1);

    const { ops, refusals } = fitMotionPathScaleOps(s);
    expect(refusals).toEqual([]);
    expect(ops).toEqual([
      { type: 'setParam', nodeId: producerId, paramPath: 'pathScale', value: ratio },
    ]);
    s = apply(s, ops);

    // The changed scale is a changed request: the producer asks again, and what it asks for is
    // the drawn path scaled about its start.
    const again = await resolvePendingMotionGenerations(s, cap);
    expect(again.map((r) => r.outcome)).toEqual(['generated']);
    const sent = requests[1].constraints!.waypoints!;
    expect(sent).toHaveLength(drawn.length);
    expect(sent[0].x).toBeCloseTo(drawn[0].x, 12);
    expect(sent[0].z).toBeCloseTo(drawn[0].z, 12);
    const last = drawn.length - 1;
    const span = (p: { x: number; z: number }, q: { x: number; z: number }) =>
      Math.hypot(q.x - p.x, q.z - p.z);
    // Walked at `ratio` by the retarget, this length is the drawn one.
    expect(span(sent[0], sent[last]) * ratio).toBeCloseTo(span(drawn[0], drawn[last]), 9);
  });

  it('writes nothing once fitted — a second cook asks nothing twice', async () => {
    const { cap } = recordingCapability();
    const { s: cooked, producerId, clipId } = await mintAndCook(cap);
    let s = bind(cooked, clipId, 'tall_skel', 'tall_walk');
    s = apply(s, fitMotionPathScaleOps(s).ops);
    expect(fitMotionPathScaleOps(s).ops).toEqual([]);
    expect(motionPathScaleFit(s, producerId).kind).toBe('fit');
  });

  it('with no character bound the walk’s own rig plays it, at 1 — nothing to write', async () => {
    const { cap } = recordingCapability();
    const { s, producerId } = await mintAndCook(cap);
    expect(motionPathScaleFit(s, producerId)).toEqual({ kind: 'fit', scale: 1, current: 1 });
    expect(fitMotionPathScaleOps(s).ops).toEqual([]);
  });

  it('two characters of different sizes are refused by name, and the scale is left alone', async () => {
    const { cap } = recordingCapability();
    const { s: cooked, producerId, clipId } = await mintAndCook(cap);
    let s = bind(cooked, clipId, 'tall_skel', 'tall_walk');
    s = bind(s, clipId, 'short_skel', 'short_walk');
    expect(appliedRatio(s, 'tall_walk')).not.toBeCloseTo(appliedRatio(s, 'short_walk'), 3);

    const { ops, refusals } = fitMotionPathScaleOps(s);
    expect(ops).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].producerId).toBe(producerId);
    expect(refusals[0].reason).toContain('tall_walk');
    expect(refusals[0].reason).toContain('short_walk');
  });

  it('a walk with no path has nothing to fit, whoever plays it', async () => {
    const { cap } = recordingCapability();
    const { s: cooked, producerId, clipId } = await mintAndCook(cap, false);
    const s = bind(cooked, clipId, 'tall_skel', 'tall_walk');
    expect(motionPathScaleFit(s, producerId)).toEqual({ kind: 'no-path' });
    expect(fitMotionPathScaleOps(s).ops).toEqual([]);
  });

  it('the cook button offers a re-cook while the clip is current but the path is not fitted', async () => {
    const { cap } = recordingCapability();
    const { s: cooked, producerId, clipId } = await mintAndCook(cap);
    expect(motionCookOffer(cooked, producerId).label).toBe('Up to date');
    const s = bind(cooked, clipId, 'tall_skel', 'tall_walk');
    const offer = motionCookOffer(s, producerId);
    expect(offer.label).toBe('Re-cook (fit path to character)');
    expect(offer.disabled).toBe(false);
  });
});

describe('the request identity of a path scale (#1285)', () => {
  beforeEach(() => registerAllNodes());

  const params: MotionGenerateParams = { prompt: 'walk', seed: 1, model: 'm' };

  function pathValue(): ObjectValue {
    const s = project();
    return evaluate(s, 'pathObj').value as ObjectValue;
  }

  it('absent and 1 are one request, so clips baked before #1285 keep their hash', () => {
    const path = pathValue();
    expect(motionRequestHash({ ...params, pathScale: 1 }, path)).toBe(
      motionRequestHash(params, path),
    );
  });

  it('a fitted scale is a different request with a path, and no request at all without one', () => {
    const path = pathValue();
    expect(motionRequestHash({ ...params, pathScale: 0.625 }, path)).not.toBe(
      motionRequestHash(params, path),
    );
    expect(motionRequestHash({ ...params, pathScale: 0.625 }, undefined)).toBe(
      motionRequestHash(params, undefined),
    );
  });
});

describe('waypointsInSourceMetres (#1285)', () => {
  it('scales every waypoint about the first, which stays put', () => {
    const out = waypointsInSourceMetres(
      [
        { x: 1, z: 2 },
        { x: 3, z: 2 },
        { x: 3, z: 6 },
      ],
      0.5,
    );
    expect(out).toEqual([
      { x: 1, z: 2 },
      { x: 5, z: 2 },
      { x: 5, z: 10 },
    ]);
  });

  it('reads the same curve the resolver reads', () => {
    // Guards the fixture, not the product: the rows above only mean something if the path
    // actually samples.
    registerAllNodes();
    expect(waypointsFromCurve(project(), 'pathObj')?.length).toBeGreaterThan(1);
  });
});
