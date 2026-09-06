// #935 — the cook that puts a generated clip where the render band can see it.
//
// THE LOAD-BEARING ROW is "the render band sees the generated keys". Without it
// every other row here still passes and the character never moves: the producer
// evaluates to a perfectly correct clip VALUE that no reader of pixels consumes.
// That is the defect this file exists to close, so the row asserts through
// `boundClipsForAsset` — the one walk the band, the mint, the dopesheet and the
// migration all share — rather than through this module's own return value.

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
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';
import { boundClipsForAsset, type GraphNodeLike } from '../animate/boundClipsForAsset';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';
import { bakeGeneratedClipOps, clipBakeStates } from './bakeGeneratedClip';

const ASSET_REF = 'asset://rig.glb';

const capability: MotionGenerationCapability = {
  id: 'stub-counting',
  kind: 'stub',
  isAvailable: async () => true,
  async generate(request): Promise<MotionGenerationResult> {
    return {
      jobId: 'job-1',
      bvh: synthesiseBvh(request),
      model: request.model,
      unitScale: STUB_UNIT_SCALE,
      worldOffsetXZ: null,
    };
  },
  cancel: async () => {},
};

function apply(s: DagState, ops: Op[]): DagState {
  let next = s;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/**
 * A producer feeding an ordinary clip, itself bound to a glTF rig — the whole
 * road the band walks, so a zero here is a real zero and not a fixture that
 * could never have exhibited the property.
 */
function graph(): DagState {
  return apply(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    {
      type: 'addNode',
      nodeId: 'gen',
      nodeType: 'MotionGenerate',
      params: { prompt: 'a slow walk', seed: 7, model: 'kimodo-base' },
    },
    { type: 'addNode', nodeId: 'skel', nodeType: 'Skeleton', params: { bones: [] } },
    {
      type: 'addNode',
      nodeId: 'clip',
      nodeType: 'AnimationClip',
      params: { name: 'placeholder', duration: 2, loop: true, keyframes: [] },
    },
    {
      type: 'connect',
      from: { node: 'skel', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    },
    {
      type: 'connect',
      from: { node: 'n_time', socket: 'out' },
      to: { node: 'clip', socket: 'time' },
    },
    {
      type: 'connect',
      from: { node: 'gen', socket: 'out' },
      to: { node: 'clip', socket: 'source' },
    },
  ] as Op[]);
}

/** The band's view of the graph, params-side, exactly as the render road reads it. */
function bandSees(s: DagState): { clips: number; keyframes: number } {
  const nodes: Record<string, GraphNodeLike> = {};
  for (const [id, n] of Object.entries(s.nodes)) {
    nodes[id] = { type: n.type, params: n.params, inputs: n.inputs } as GraphNodeLike;
  }
  const bound = boundClipsForAsset(nodes, ASSET_REF);
  return { clips: bound.length, keyframes: bound.flatMap((b) => b.params.keyframes ?? []).length };
}

/** The same graph plus the glTF rig the clip drives, so the band has an asset. */
function graphBoundToRig(): DagState {
  const skin = {
    jointKeys: ['Hips', 'Spine'],
    bindTRS: [
      { position: [0, 1.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ],
    parentJointIndex: [-1, 0],
    inverseBindMatrices: [],
  };
  return apply(graph(), [
    {
      type: 'addNode',
      nodeId: 'asset',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET_REF, skins: [skin] },
    },
    {
      type: 'addNode',
      nodeId: 'gskel',
      nodeType: 'GltfSkeleton',
      params: { skinIndex: 0 },
    },
    {
      type: 'connect',
      from: { node: 'asset', socket: 'out' },
      to: { node: 'gskel', socket: 'asset' },
    },
    // The clip's rig edge now names the glTF skeleton, which is what the band
    // matches on. The generated keys are written to the plain `skel` node it
    // replaced, so this graph deliberately keeps BOTH.
    {
      type: 'connect',
      from: { node: 'gskel', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    },
  ] as Op[]);
}

describe('bakeGeneratedClipOps (#935)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('THE ROW THAT CARRIES THE PHASE: the render band sees the generated keys', async () => {
    let s = graphBoundToRig();
    // Before: the producer has a correct clip VALUE and the band sees nothing.
    expect(bandSees(s)).toEqual({ clips: 0, keyframes: 0 });

    await resolvePendingMotionGenerations(s, capability);
    s = apply(s, bakeGeneratedClipOps(s));

    const after = bandSees(s);
    expect(after.clips).toBe(1);
    expect(after.keyframes).toBeGreaterThan(0);
  });

  it('a pending producer writes NOTHING and leaves the last motion playing (lock/freeze)', () => {
    const s = graph();
    // Stale and NOT baked: the params are behind the request (nothing has been
    // written yet), and there is no previous result to keep. Those are separate
    // facts and the row carries both.
    expect(clipBakeStates(s)).toEqual([
      { clipId: 'clip', producerId: 'gen', status: 'pending', stale: true, baked: false },
    ]);
    expect(bakeGeneratedClipOps(s)).toEqual([]);
    expect((s.nodes.clip.params as { name: string }).name).toBe('placeholder');
  });

  it('is idempotent: a second cook of an already-baked clip emits no ops', async () => {
    let s = graph();
    await resolvePendingMotionGenerations(s, capability);
    const first = bakeGeneratedClipOps(s);
    expect(first.length).toBeGreaterThan(0);
    s = apply(s, first);
    expect(clipBakeStates(s)[0]).toMatchObject({ status: 'ready', stale: false, baked: true });
    expect(bakeGeneratedClipOps(s)).toEqual([]);
  });

  it('writes the RIG before the keys, and the receipt hash last', async () => {
    const s = graph();
    await resolvePendingMotionGenerations(s, capability);
    const ops = bakeGeneratedClipOps(s) as { nodeId: string; paramPath: string }[];
    const at = (p: string) => ops.findIndex((o) => o.paramPath === p);
    expect(ops[0]).toMatchObject({ nodeId: 'skel', paramPath: 'bones' });
    expect(at('bones')).toBeLessThan(at('keyframes'));
    expect(at('sourceHash')).toBe(ops.length - 1);
  });

  it('leaves an ordinary clip alone — no `source` edge, and a source that is not a producer', async () => {
    // A dropped `.bvh`: same node type, no producer.
    let s = apply(graph(), [
      {
        type: 'disconnect',
        from: { node: 'gen', socket: 'out' },
        to: { node: 'clip', socket: 'source' },
      },
    ] as Op[]);
    await resolvePendingMotionGenerations(s, capability);
    expect(clipBakeStates(s)).toEqual([]);
    expect(bakeGeneratedClipOps(s)).toEqual([]);

    // A source edge that reaches something that generates nothing.
    s = apply(graph(), [
      {
        type: 'disconnect',
        from: { node: 'gen', socket: 'out' },
        to: { node: 'clip', socket: 'source' },
      },
      {
        type: 'addNode',
        nodeId: 'other',
        nodeType: 'AnimationClip',
        params: { name: 'x', duration: 1, loop: false, keyframes: [] },
      },
      {
        type: 'connect',
        from: { node: 'other', socket: 'out' },
        to: { node: 'clip', socket: 'source' },
      },
    ] as Op[]);
    expect(clipBakeStates(s)).toEqual([]);
  });

  it('a moved input makes the baked clip stale WITHOUT erasing it', async () => {
    let s = graph();
    await resolvePendingMotionGenerations(s, capability);
    s = apply(s, bakeGeneratedClipOps(s));
    const baked = (s.nodes.clip.params as { keyframes: unknown[] }).keyframes.length;
    expect(baked).toBeGreaterThan(0);

    // The director edits the request — the same move a control-point drag makes.
    s = applyOp(s, { type: 'setParam', nodeId: 'gen', paramPath: 'seed', value: 99 } as Op).next;

    // The drag: stale because the request moved, baked because there is a real
    // result still playing. This pair is what the affordance reads.
    expect(clipBakeStates(s)[0]).toMatchObject({ status: 'pending', stale: true, baked: true });
    // The motion is UNCHANGED. This is the row that says a drag does not blank it.
    expect((s.nodes.clip.params as { keyframes: unknown[] }).keyframes.length).toBe(baked);
    expect(bakeGeneratedClipOps(s)).toEqual([]);
  });
});
