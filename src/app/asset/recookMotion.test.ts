// #1721 — Re-cook on a strip cooks THAT generator with one generation call and clears its stale
// mark; New seed changes only the seed and re-cooks. The capability is a recording stub injected
// through the boot seam, so no request ever leaves the process, and every call is counted.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetGeneratedClipsForTests } from '../../core/motiongen/generatedClipCache';
import {
  STUB_UNIT_SCALE,
  synthesiseBvh,
} from '../../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';

const requests: MotionGenerationRequest[] = [];
const capability: MotionGenerationCapability = {
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
      // Where the walk starts, as a server reports it: the path's first waypoint. So two paths
      // place their characters at two different spots, which is what the placement row needs.
      worldOffsetXZ: request.constraints?.waypoints?.length
        ? [request.constraints.waypoints[0].x, request.constraints.waypoints[0].z]
        : null,
      worldRotationRadians: null,
    };
  },
  cancel: async () => {},
};
vi.mock('../boot', () => ({ getMotionCapability: async () => capability }));

// Imported AFTER vi.mock so the cook picks up the mocked boot.
import { cookMotionGenerations, placeCookedMotion } from './cookMotionGenerations';
import { mintMotionGenerateOps } from './mintMotionGenerate';
import { recookMotion, recookWithNewSeed } from './recookMotion';
import { generatedRuns } from '../../nodes/motionGenerateRuns';
import { buildSetCurvePointOps, curvePointsOf } from '../curvePoints';

const dispatch = (ops: readonly Op[]) =>
  useDagStore.getState().dispatchAtomic(ops as Op[], 'user', 'test');
const state = () => useDagStore.getState().state;
const runOf = (clipId: string) => generatedRuns(state()).find((r) => r.clipId === clipId)!;
const clip = (clipId: string) =>
  state().nodes[clipId].params as { poses: unknown[]; sourceHash: string };

function curve(id: string): Op[] {
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

/** Two generators on two curves, both cooked: two calls, made before each row starts counting. */
async function twoRuns() {
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
  dispatch([...curve('pathA'), ...curve('pathB')]);
  const a = mintMotionGenerateOps(state(), {
    prompt: 'walk A',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathA',
  });
  dispatch(a.ops as Op[]);
  const b = mintMotionGenerateOps(state(), {
    prompt: 'run B',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathB',
  });
  dispatch(b.ops as Op[]);
  await cookMotionGenerations();
  expect(requests.map((r) => r.prompt).sort()).toEqual(['run B', 'walk A']);
  requests.length = 0;
  return { a, b };
}

function dragWaypoint(curveId: string, index: number) {
  const p = curvePointsOf(state(), curveId)![index];
  dispatch(buildSetCurvePointOps(state(), curveId, index, [p[0] + 1, p[1], p[2] + 2])!);
}

describe('recookMotion (#1721)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
    requests.length = 0;
  });

  it('dragging a waypoint marks exactly that run stale, and Re-cook clears it with ONE call', async () => {
    const { a, b } = await twoRuns();
    const bHash = clip(b.clipId).sourceHash;
    const aPoses = clip(a.clipId).poses;

    dragWaypoint('pathA', 2);
    expect(runOf(a.clipId).stale).toBe(true);
    expect(runOf(b.clipId).stale).toBe(false);
    expect(clip(a.clipId).poses).toBe(aPoses); // the old take still plays
    expect(requests).toHaveLength(0); // the drag asked for nothing

    await recookMotion(a.producerId);

    // Exactly one generation, for THAT generator, keeping its prompt and seed, on the new path.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ prompt: 'walk A', seed: 7 });
    expect(requests[0].constraints?.waypoints?.length).toBeGreaterThan(1);
    expect(runOf(a.clipId).stale).toBe(false);
    // B untouched.
    expect(clip(b.clipId).sourceHash).toBe(bHash);
  });

  it('Re-cook places only its own run: a stale neighbour whose take is cached keeps its spot', async () => {
    const { a, b } = await twoRuns();
    placeCookedMotion();
    const standInB = b.objectId!;
    const posB = () => (state().nodes[standInB].params as { position: number[] }).position;
    const p0 = curvePointsOf(state(), 'pathB')![0];
    // B's path moves and B is re-cooked there: B now stands at the moved start.
    dispatch(buildSetCurvePointOps(state(), 'pathB', 0, [p0[0] + 3, p0[1], p0[2]])!);
    await recookMotion(b.producerId);
    const bPlaced = [...posB()];
    const bHash = clip(b.clipId).sourceHash;
    // ...then back where it was, NOT re-cooked: B is stale, and its old take is in the cache, so
    // its producer answers `ready` with the ORIGINAL start.
    dispatch(buildSetCurvePointOps(state(), 'pathB', 0, p0)!);
    expect(runOf(b.clipId).stale).toBe(true);
    expect(runOf(b.clipId).status).toBe('ready');
    // A goes stale and is re-cooked.
    dragWaypoint('pathA', 1);
    requests.length = 0;
    await recookMotion(a.producerId);

    expect(requests.map((r) => r.prompt)).toEqual(['walk A']);
    // B was not pressed: its character stays where its playing take put it, and its clip is the same.
    expect(posB()).toEqual(bPlaced);
    expect(clip(b.clipId).sourceHash).toBe(bHash);
    expect(runOf(b.clipId).stale).toBe(true);
  });

  it('Re-cook with both runs stale still cooks only the one pressed', async () => {
    const { a, b } = await twoRuns();
    dragWaypoint('pathA', 1);
    dragWaypoint('pathB', 1);
    await recookMotion(b.producerId);
    expect(requests.map((r) => r.prompt)).toEqual(['run B']);
    expect(runOf(b.clipId).stale).toBe(false);
    expect(runOf(a.clipId).stale).toBe(true);
  });

  it('New seed changes the seed only, and re-cooks that generator once', async () => {
    const { a, b } = await twoRuns();
    const res = await recookWithNewSeed(a.producerId, () => 1234);
    expect(res).toMatchObject({ ok: true, seed: 1234 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ prompt: 'walk A', seed: 1234 });
    expect((state().nodes[a.producerId].params as { seed: number }).seed).toBe(1234);
    expect(runOf(a.clipId).stale).toBe(false);
    expect(runOf(b.clipId).stale).toBe(false);
  });

  it('a "new" seed equal to the current one is moved, so the press always changes something', async () => {
    const { a } = await twoRuns();
    const res = await recookWithNewSeed(a.producerId, () => 7);
    expect(res).toMatchObject({ ok: true, seed: 8 });
    expect(requests.map((r) => r.seed)).toEqual([8]);
  });

  it('a driven seed is refused and nothing is asked for', async () => {
    const { a } = await twoRuns();
    dispatch([
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: { target: a.producerId, paramPath: 'seed' },
      },
    ] as Op[]);
    const seedBefore = (state().nodes[a.producerId].params as { seed: number }).seed;
    const res = await recookWithNewSeed(a.producerId, () => 99);
    // Only meaningful if the fixture really is a driver the inspector would see.
    const { driverNodesForTarget } = await import('../paramDrivers');
    expect(driverNodesForTarget(state().nodes, a.producerId)).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
    expect((state().nodes[a.producerId].params as { seed: number }).seed).toBe(seedBefore);
  });
});
