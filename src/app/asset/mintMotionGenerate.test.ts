// #935 — the road that puts a MotionGenerate into a graph.
//
// THE LOAD-BEARING ROW is end to end: mint, cook, and the render band sees keys.
// Every other row here pins one edge of the chain, and any of them can pass while
// the road as a whole reaches nothing — which is exactly how the producer came to
// be registered, correct, and unreachable in the first place.

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
import { boundClipsForAsset, type GraphNodeLike } from '../animate/boundClipsForAsset';
import { edgeTarget } from '../animate/graphNodes';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';
import { bakeGeneratedClipOps } from './bakeGeneratedClip';
import { mintMotionGenerateOps } from './mintMotionGenerate';

const ASSET_REF = 'asset://rig.glb';

function capability() {
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
        worldOffsetXZ: request.constraints?.waypoints ? [3, -1] : null,
        worldRotationRadians: null,
      };
    },
    cancel: async () => {},
  };
  return { cap, requests };
}

function apply(s: DagState, ops: Op[]): DagState {
  let next = s;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A project with a clock, a drawn curve, and a rigged glTF character. */
function project(): DagState {
  const skin = {
    jointKeys: ['Hips', 'Spine'],
    bindTRS: [
      { position: [0, 1.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ],
    parentJointIndex: [-1, 0],
    inverseBindMatrices: [],
  };
  return apply(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    { type: 'addNode', nodeId: 'curve', nodeType: 'CurveData', params: {} },
    { type: 'addNode', nodeId: 'pathObj', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'curve', socket: 'out' },
      to: { node: 'pathObj', socket: 'data' },
    },
    {
      type: 'addNode',
      nodeId: 'asset',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET_REF, skins: [skin] },
    },
    { type: 'addNode', nodeId: 'gskel', nodeType: 'GltfSkeleton', params: { skinIndex: 0 } },
    {
      type: 'connect',
      from: { node: 'asset', socket: 'out' },
      to: { node: 'gskel', socket: 'asset' },
    },
  ] as Op[]);
}

function bandSees(s: DagState): { clips: number; keyframes: number } {
  const nodes: Record<string, GraphNodeLike> = {};
  for (const [id, n] of Object.entries(s.nodes)) {
    nodes[id] = { type: n.type, params: n.params, inputs: n.inputs } as GraphNodeLike;
  }
  const bound = boundClipsForAsset(nodes, ASSET_REF);
  return { clips: bound.length, keyframes: bound.flatMap((b) => b.params.keyframes ?? []).length };
}

const ARGS = { prompt: 'a slow walk', seed: 7, model: 'kimodo-base' } as const;

describe('mintMotionGenerateOps (#935)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('THE ROAD END TO END: mint on a curve, cook, and the band sees the keys', async () => {
    let s = project();
    expect(bandSees(s)).toEqual({ clips: 0, keyframes: 0 });

    const { ops, clipId } = mintMotionGenerateOps(s, { ...ARGS, curveObjectId: 'pathObj' });
    s = apply(s, ops);
    // Minted but not cooked: the clip exists and is empty, and nothing is claimed.
    expect(bandSees(s)).toEqual({ clips: 0, keyframes: 0 });

    // The clip's rig edge is the plain Skeleton the mint made; a director binds it
    // to the character, which is the step the band matches on.
    s = apply(s, [
      {
        type: 'disconnect',
        from: { node: edgeTarget(s.nodes[clipId], 'skeleton')!, socket: 'out' },
        to: { node: clipId, socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'gskel', socket: 'out' },
        to: { node: clipId, socket: 'skeleton' },
      },
    ] as Op[]);

    const { cap, requests } = capability();
    await resolvePendingMotionGenerations(s, cap);
    s = apply(s, bakeGeneratedClipOps(s));

    const after = bandSees(s);
    expect(after.clips).toBe(1);
    expect(after.keyframes).toBeGreaterThan(0);
    // The curve reached the generator, which is the point of the path being an edge.
    expect(requests[0].constraints?.waypoints).toBeDefined();
  });

  it('wires all four edges, and the producer carries the request', () => {
    const s = project();
    const { ops, producerId, clipId, skeletonId } = mintMotionGenerateOps(s, {
      ...ARGS,
      curveObjectId: 'pathObj',
    });
    const next = apply(s, ops);
    expect(edgeTarget(next.nodes[clipId], 'skeleton')).toBe(skeletonId);
    // No clock: a clip is time-free (#920) and has no `time` socket to wire.
    expect(edgeTarget(next.nodes[clipId], 'time')).toBeNull();
    expect(edgeTarget(next.nodes[clipId], 'source')).toBe(producerId);
    expect(edgeTarget(next.nodes[producerId], 'path')).toBe('pathObj');
    expect(next.nodes[producerId].params).toMatchObject({
      prompt: 'a slow walk',
      seed: 7,
      model: 'kimodo-base',
      // The name defaults to the prompt, as an import defaults to its filename.
      name: 'a slow walk',
    });
  });

  it('mints without a curve — "generate a walk" is a whole request', () => {
    const s = project();
    const { ops, producerId } = mintMotionGenerateOps(s, ARGS);
    const next = apply(s, ops);
    expect(next.nodes[producerId].inputs.path).toBeUndefined();
    // And null-path is not the same request as an empty one: it still resolves.
    expect(ops.some((o) => o.type === 'connect' && o.to.socket === 'path')).toBe(false);
  });

  it('the minted clip reads as NEVER baked, so the first cook is not a no-op', async () => {
    let s = project();
    const { ops, clipId } = mintMotionGenerateOps(s, ARGS);
    s = apply(s, ops);
    expect((s.nodes[clipId].params as { sourceHash: string }).sourceHash).toBe('');
    expect((s.nodes[clipId].params as { keyframes: unknown[] }).keyframes).toEqual([]);

    const { cap } = capability();
    await resolvePendingMotionGenerations(s, cap);
    expect(bakeGeneratedClipOps(s).length).toBeGreaterThan(0);
  });

  it('mints in a project with no clock — a clip does not need one', () => {
    // It used to refuse here. A clip carried a `time` input until #920, so a
    // project without a TimeSource would have minted a clip that never advanced.
    // The clip is time-free now and the consumer holds the clock, so the refusal
    // guarded a condition that can no longer arise.
    const s = apply(emptyDagState(), [
      { type: 'addNode', nodeId: 'x', nodeType: 'Object', params: {} },
    ] as Op[]);
    const { ops, clipId } = mintMotionGenerateOps(s, ARGS);
    const next = apply(s, ops);
    expect(next.nodes[clipId].type).toBe('AnimationClip');
    expect(edgeTarget(next.nodes[clipId], 'time')).toBeNull();
  });

  // #1078 — the skeleton gets the Object a dropped .bvh's skeleton gets (#1056), in this batch.
  it('in a project with a scene, stands the skeleton in it as an Object at scale 1', () => {
    let s = apply(project(), [
      { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} },
    ] as Op[]);
    s = { ...s, outputs: { scene: { node: 'scene', socket: 'out' } } };
    const { ops, skeletonId, objectId } = mintMotionGenerateOps(s, ARGS);
    expect(objectId).toBeDefined();
    const next = apply(s, ops);
    const object = next.nodes[objectId!];
    expect(object.type).toBe('Object');
    expect(edgeTarget(object, 'data')).toBe(skeletonId);
    expect(next.nodes.scene.inputs.children).toEqual([{ node: objectId, socket: 'out' }]);
    // The generator declares its unit, so the rig is not normalised.
    expect((object.params as { scale: number[] }).scale).toEqual([1, 1, 1]);
    // #1101 — named after its clip, which defaults to the prompt.
    expect(object.meta?.name).toBe('a slow walk');
  });

  it('#1101 — a named request names the Object with the clip’s name, not the prompt', () => {
    let s = apply(project(), [
      { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} },
    ] as Op[]);
    s = { ...s, outputs: { scene: { node: 'scene', socket: 'out' } } };
    const { ops, clipId, objectId } = mintMotionGenerateOps(s, { ...ARGS, name: 'hero walk' });
    const next = apply(s, ops);
    expect((next.nodes[clipId].params as { name: string }).name).toBe('hero walk');
    expect(next.nodes[objectId!].meta?.name).toBe('hero walk');
  });

  // #1122 — through a REAL cook, the road that renames a generated clip: a new request lands a
  // new name on the clip (`bakeGeneratedClip.ts`), and the Object standing it follows.
  it('#1122 — a re-cook that renames the clip renames the Object standing it', async () => {
    let s = apply(project(), [
      { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} },
    ] as Op[]);
    s = { ...s, outputs: { scene: { node: 'scene', socket: 'out' } } };
    const { ops, producerId, clipId, objectId } = mintMotionGenerateOps(s, ARGS);
    s = apply(s, ops);
    expect(s.nodes[objectId!].meta).toEqual({ name: 'a slow walk', nameFrom: clipId });

    const { cap } = capability();
    s = apply(s, [
      { type: 'setParam', nodeId: producerId, paramPath: 'name', value: 'hero walk' },
      { type: 'setParam', nodeId: producerId, paramPath: 'prompt', value: 'a fast run' },
    ] as Op[]);
    await resolvePendingMotionGenerations(s, cap);
    const bake = bakeGeneratedClipOps(s);
    expect(bake.length, 'nothing re-cooked — the follow below would be vacuous').toBeGreaterThan(0);
    s = apply(s, bake);
    expect((s.nodes[clipId].params as { name: string }).name).toBe('hero walk');
    expect(s.nodes[objectId!].meta).toEqual({ name: 'hero walk', nameFrom: clipId });
  });

  it('in a project with no scene, adds no Object — there is nowhere to stand one', () => {
    const s = project();
    expect(s.outputs.scene).toBeUndefined();
    const { ops, objectId } = mintMotionGenerateOps(s, ARGS);
    expect(objectId).toBeUndefined();
    expect(ops.some((o) => o.type === 'addNode' && o.nodeType === 'Object')).toBe(false);
  });

  it('two mints in one project do not collide', () => {
    let s = project();
    const a = mintMotionGenerateOps(s, ARGS);
    s = apply(s, a.ops);
    const b = mintMotionGenerateOps(s, { ...ARGS, seed: 8 });
    s = apply(s, b.ops);
    expect(a.producerId).not.toBe(b.producerId);
    expect(a.clipId).not.toBe(b.clipId);
    expect(Object.keys(s.nodes)).toContain(b.clipId);
  });
});
