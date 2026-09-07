// #935 — the node road's placement half.
//
// THE ROW THAT CARRIES IT is idempotency. A generated walk is canonicalised to
// the origin and the generator hands back where frame 0 belongs; applying that
// as a DELTA would walk the character one offset further down the path on every
// cook, which looks like drift and reads like physics. The target is absolute,
// and this pins it.

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
import { edgeTarget } from '../animate/graphNodes';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';
import { bakeGeneratedClipOps } from './bakeGeneratedClip';
import { mintMotionGenerateOps } from './mintMotionGenerate';
import { placeCookedMotionOps } from './placeGeneratedMotion';

/** The offset the generator reports when a world path was requested. */
const OFFSET: [number, number] = [3, -1];

function capability(withOffset = true, rotation: number | null = null) {
  const cap: MotionGenerationCapability = {
    id: 'stub',
    kind: 'stub',
    isAvailable: async () => true,
    async generate(request): Promise<MotionGenerationResult> {
      return {
        jobId: 'job-1',
        bvh: synthesiseBvh(request),
        model: request.model,
        unitScale: STUB_UNIT_SCALE,
        // The stub omits `constraints` from its digest on purpose, so the offset
        // is stated here rather than derived — this spec is about what placement
        // does with an offset, not about how the server computes one.
        worldOffsetXZ: withOffset ? OFFSET : null,
        worldRotationRadians: withOffset ? rotation : null,
      };
    },
    cancel: async () => {},
  };
  return cap;
}

function apply(s: DagState, ops: Op[]): DagState {
  let next = s;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A rigged character with the root Group an import gives it, plus a curve. */
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
      params: { assetRef: 'asset://rig.glb', skins: [skin] },
    },
    { type: 'addNode', nodeId: 'gskel', nodeType: 'GltfSkeleton', params: { skinIndex: 0 } },
    {
      type: 'connect',
      from: { node: 'asset', socket: 'out' },
      to: { node: 'gskel', socket: 'asset' },
    },
    // The root Group the import emits — the node that owns where the thing stands.
    { type: 'addNode', nodeId: 'root', nodeType: 'Group', params: { position: [0, 0, 0] } },
    {
      type: 'connect',
      from: { node: 'asset', socket: 'out' },
      to: { node: 'root', socket: 'children' },
    },
  ] as Op[]);
}

/** Mint, bind the clip to the character's rig, cook, and bake. */
async function mintAndCook(s: DagState, cap: MotionGenerationCapability) {
  const { ops, clipId } = mintMotionGenerateOps(s, {
    prompt: 'a slow walk',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathObj',
  });
  let next = apply(s, ops);
  next = apply(next, [
    {
      type: 'disconnect',
      from: { node: edgeTarget(next.nodes[clipId], 'skeleton')!, socket: 'out' },
      to: { node: clipId, socket: 'skeleton' },
    },
    {
      type: 'connect',
      from: { node: 'gskel', socket: 'out' },
      to: { node: clipId, socket: 'skeleton' },
    },
  ] as Op[]);
  await resolvePendingMotionGenerations(next, cap);
  next = apply(next, bakeGeneratedClipOps(next));
  return { state: next, clipId };
}

const posOf = (s: DagState) => (s.nodes.root.params as { position: number[] }).position;
const rotOf = (s: DagState) => (s.nodes.root.params as { rotation?: number[] }).rotation;

describe('placeCookedMotionOps (#935)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('moves the character to where the path was drawn', async () => {
    const { state } = await mintAndCook(project(), capability());
    expect(posOf(state)).toEqual([0, 0, 0]);

    const { ops, refusals } = placeCookedMotionOps(state);
    expect(refusals).toEqual([]);
    const placed = apply(state, ops);
    // Y is untouched, so a character dropped at a height stays at that height.
    expect(posOf(placed)).toEqual([OFFSET[0], 0, OFFSET[1]]);
  });

  // #897 — THE FACING HALF, ALL THE WAY DOWN THE NODE ROAD.
  //
  // This road reads the clip's `generation` block and nothing else, so every hop
  // between the capability and that block has to carry both halves. The field is
  // OPTIONAL on `MotionGenerationState` — a clip cached before the facing existed
  // genuinely states none — and optional means the typechecker says nothing when
  // a hop drops it. It was in fact dropped at exactly one hop when this was
  // written, with the tier fully green. So the gate runs the whole road rather
  // than any single hop: capability -> cache -> node value -> placement.
  it('carries the FACING down the same road as the offset', async () => {
    const { state } = await mintAndCook(project(), capability(true, Math.PI / 2));
    const { ops, refusals } = placeCookedMotionOps(state);
    expect(refusals).toEqual([]);
    const placed = apply(state, ops);
    // +Z requested. `Group.rotation` is degrees into a THREE Euler, whose Y runs
    // the other way, so +pi/2 lands as -90.
    expect(rotOf(placed)).toEqual([0, -90, 0]);
    expect(posOf(placed)).toEqual([OFFSET[0], 0, OFFSET[1]]);
  });

  it('leaves the facing alone when the clip states none', async () => {
    const { state } = await mintAndCook(project(), capability(true, null));
    const placed = apply(state, placeCookedMotionOps(state).ops);
    // Untouched, not zeroed: a clip that never asked to face anywhere must not
    // rotate a character the director may have turned by hand.
    expect(rotOf(placed)).toEqual([0, 0, 0]);
  });

  it('IS IDEMPOTENT: the target is absolute, so a second cook does not walk it further', async () => {
    const { state } = await mintAndCook(project(), capability());
    const once = apply(state, placeCookedMotionOps(state).ops);
    const twice = apply(once, placeCookedMotionOps(once).ops);
    expect(posOf(twice)).toEqual(posOf(once));
    expect(posOf(twice)).toEqual([OFFSET[0], 0, OFFSET[1]]);
  });

  it('places NOTHING when no world path was requested — null is not [0, 0]', async () => {
    const { state } = await mintAndCook(project(), capability(false));
    expect(placeCookedMotionOps(state)).toEqual({ ops: [], refusals: [] });
    expect(posOf(state)).toEqual([0, 0, 0]);
  });

  it('REFUSES rather than silently leaving a character at the origin', async () => {
    // Cooked with an offset, but the clip was never bound to a character rig.
    const s = project();
    const { ops, clipId } = mintMotionGenerateOps(s, {
      prompt: 'a slow walk',
      seed: 7,
      model: 'kimodo-base',
      curveObjectId: 'pathObj',
    });
    let next = apply(s, ops);
    await resolvePendingMotionGenerations(next, capability());
    next = apply(next, bakeGeneratedClipOps(next));

    const out = placeCookedMotionOps(next);
    expect(out.ops).toEqual([]);
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toMatchObject({ clipId });
    expect(out.refusals[0].reason).toMatch(/not bound to a character rig/);
  });
});
