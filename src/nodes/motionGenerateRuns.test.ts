// #1721 — a generated run's strip says stale when its path, prompt or character changes, and only
// that run's strip does. Pure over state: two generators on two curves, cooked by the stub (no
// generation call leaves the process), then edited the way the UI edits them.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState, type DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from './registerAll';
import { __resetGeneratedClipsForTests } from '../core/motiongen/generatedClipCache';
import { STUB_UNIT_SCALE, synthesiseBvh } from '../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationResult,
} from '../core/motiongen/MotionGenerationCapability';
import { resolvePendingMotionGenerations } from '../app/asset/resolveMotionGenerate';
import { bakeGeneratedClipOps } from '../app/asset/bakeGeneratedClip';
import { mintMotionGenerateOps } from '../app/asset/mintMotionGenerate';
import { buildSetCurvePointOps, curvePointsOf } from '../app/curvePoints';
import { validatePlan } from '../agent/mutators/index';
import { retargetMutator } from '../agent/mutators/builders/retarget';
import { edgeTarget } from '../app/animate/graphNodes';
import { generatedRuns, staleRunLabel } from './motionGenerateRuns';

const prompts: string[] = [];
const cap: MotionGenerationCapability = {
  id: 'stub',
  kind: 'stub',
  isAvailable: async () => true,
  async generate(request): Promise<MotionGenerationResult> {
    prompts.push(request.prompt);
    return {
      jobId: `job-${prompts.length}`,
      bvh: synthesiseBvh(request),
      model: request.model,
      unitScale: STUB_UNIT_SCALE,
      worldOffsetXZ: [0, 0],
      worldRotationRadians: null,
    };
  },
  cancel: async () => {},
};

function apply(s: DagState, ops: readonly Op[]): DagState {
  let next = s;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

function curveOps(id: string): Op[] {
  return [
    { type: 'addNode', nodeId: `${id}_data`, nodeType: 'CurveData', params: {} },
    { type: 'addNode', nodeId: id, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: `${id}_data`, socket: 'out' },
      to: { node: id, socket: 'data' },
    },
  ] as Op[];
}

/** Two generators, each on its own curve, both cooked once. */
async function twoRuns() {
  let s = apply(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    ...curveOps('pathA'),
    ...curveOps('pathB'),
    {
      type: 'addNode',
      nodeId: 'tall_skel',
      nodeType: 'Skeleton',
      params: {
        bones: [
          { name: 'Hips', parent: -1, position: [0, 1.2, 0], rotation: [0, 0, 0] },
          { name: 'Spine', parent: 0, position: [0, 0.5, 0], rotation: [0, 0, 0] },
        ],
      },
    },
  ] as Op[]);
  const a = mintMotionGenerateOps(s, {
    prompt: 'walk A',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathA',
  });
  s = apply(s, a.ops as Op[]);
  const b = mintMotionGenerateOps(s, {
    prompt: 'run B',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathB',
  });
  s = apply(s, b.ops as Op[]);
  await resolvePendingMotionGenerations(s, cap);
  s = apply(s, bakeGeneratedClipOps(s));
  return { s, a, b };
}

const runOf = (s: DagState, clipId: string) => generatedRuns(s).find((r) => r.clipId === clipId)!;
const posesOf = (s: DagState, clipId: string) =>
  (s.nodes[clipId].params as { poses: unknown[] }).poses;

describe('generatedRuns (#1721)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
    prompts.length = 0;
  });

  it('two freshly cooked runs are both current, one strip each', async () => {
    const { s, a, b } = await twoRuns();
    expect(prompts).toEqual(['walk A', 'run B']);
    const runs = generatedRuns(s);
    expect(runs.map((r) => [r.clipId, r.producerId, r.stale])).toEqual(
      [
        [a.clipId, a.producerId, false],
        [b.clipId, b.producerId, false],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(runs.every((r) => r.baked && r.duration > 0 && r.staleBecause === null)).toBe(true);
  });

  it('dragging a waypoint marks exactly that run stale, and its old take keeps playing', async () => {
    const { s: cooked, a, b } = await twoRuns();
    const before = posesOf(cooked, a.clipId);
    const p = curvePointsOf(cooked, 'pathA')!;
    // The op the inspector's point row and the viewport handle both build (curvePoints.ts).
    const s = apply(
      cooked,
      buildSetCurvePointOps(cooked, 'pathA', 2, [p[2][0] + 1, p[2][1], p[2][2] + 2])!,
    );

    expect(runOf(s, a.clipId)).toMatchObject({ stale: true, staleBecause: 'inputs' });
    expect(runOf(s, b.clipId)).toMatchObject({ stale: false, staleBecause: null });
    // Nothing jumps: the clip still holds the very poses it held before the drag.
    expect(posesOf(s, a.clipId)).toBe(before);
    // And the edit itself asked the generator for nothing.
    expect(prompts).toHaveLength(2);
  });

  it('a prompt change marks that run stale', async () => {
    const { s: cooked, a, b } = await twoRuns();
    const s = apply(cooked, [
      { type: 'setParam', nodeId: a.producerId, paramPath: 'prompt', value: 'sprint A' },
    ] as Op[]);
    expect(runOf(s, a.clipId).staleBecause).toBe('inputs');
    expect(runOf(s, b.clipId).stale).toBe(false);
  });

  it('a character that needs a different path scale marks the run stale, for the character', async () => {
    const { s: cooked, a, b } = await twoRuns();
    const plan = validatePlan(
      retargetMutator,
      {
        sourceId: a.clipId,
        sourceSkeletonId: edgeTarget(cooked.nodes[a.clipId], 'skeleton')!,
        targetSkeletonId: 'tall_skel',
        customMap: { Hips: 'Hips', Spine: 'Spine' },
        outputClipId: 'tall_walk',
      },
      cooked,
      'bind',
    );
    if (!plan.ok) throw new Error(plan.reason);
    const s = apply(cooked, plan.ops as Op[]);
    // The request hash did not move — the character is not in it — and the run is still behind.
    expect(runOf(s, a.clipId)).toMatchObject({ stale: true, staleBecause: 'character' });
    expect(runOf(s, b.clipId).stale).toBe(false);
  });

  it('a run that never landed is not "stale": there is no take to be behind yet', () => {
    registerAllNodes();
    let s = apply(emptyDagState(), [
      { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    ] as Op[]);
    const m = mintMotionGenerateOps(s, { prompt: 'wave', seed: 1, model: 'kimodo-base' });
    s = apply(s, m.ops as Op[]);
    expect(runOf(s, m.clipId)).toMatchObject({ baked: false, stale: false, status: 'pending' });
  });

  it('a graph with no generator evaluates nothing and has no runs', () => {
    expect(generatedRuns(emptyDagState())).toEqual([]);
  });

  it('labels name the reason', () => {
    expect(staleRunLabel('inputs')).toBe('stale · inputs changed');
    expect(staleRunLabel('character')).toBe('stale · fit to character');
  });
});
