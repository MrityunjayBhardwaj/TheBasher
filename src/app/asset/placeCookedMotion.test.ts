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

/**
 * Mint and cook, then bind THE WAY THE REAL BIND DOES (#966).
 *
 * 🔴 THE DIFFERENCE FROM `mintAndCook` IS THE WHOLE POINT. That helper moves the
 * clip's own `skeleton` edge onto the `GltfSkeleton`, which is a graph shape
 * `bindMotionToCharacter` never produces: it leaves the generated clip hanging
 * off its 78-bone source `Skeleton` and adds a `RetargetClip` beside it carrying
 * the rig. `boundClipsForAsset`'s header states that arrangement explicitly and
 * excludes the source clip from the read band because of it.
 *
 * So the shape below is the one a director actually gets, and placement has to
 * find the rig through the retarget rather than on the clip.
 */
async function mintAndCookThroughRetarget(s: DagState, cap: MotionGenerationCapability) {
  const { ops, clipId } = mintMotionGenerateOps(s, {
    prompt: 'a slow walk',
    seed: 7,
    model: 'kimodo-base',
    curveObjectId: 'pathObj',
  });
  let next = apply(s, ops);
  // The clip keeps its SOURCE skeleton — untouched, exactly as the bind leaves it.
  next = apply(next, [
    { type: 'addNode', nodeId: 'bonemap', nodeType: 'BoneNameMap', params: { map: {} } },
    { type: 'addNode', nodeId: 'retarget', nodeType: 'RetargetClip', params: {} },
    {
      type: 'connect',
      from: { node: clipId, socket: 'out' },
      to: { node: 'retarget', socket: 'sourceClip' },
    },
    {
      type: 'connect',
      from: { node: 'bonemap', socket: 'out' },
      to: { node: 'retarget', socket: 'boneMap' },
    },
    {
      type: 'connect',
      from: { node: 'gskel', socket: 'out' },
      to: { node: 'retarget', socket: 'skeleton' },
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

  // ───────────────────────────────────────────────────────────────────────
  // #966 — THE SHAPE THE BIND ACTUALLY BUILDS
  // ───────────────────────────────────────────────────────────────────────
  // Every row above this one binds by moving the clip's own `skeleton` edge onto
  // the GltfSkeleton. `bindMotionToCharacter` does not do that, and never did:
  // it leaves the generated clip on its source `Skeleton` and hangs the rig off a
  // `RetargetClip`. Measured in a headed browser against the real server — the
  // waypoints reached the wire, the offset came back as the curve's first point,
  // and placement refused with "not bound to a character rig" while 18 of 23
  // bones animated. The fixture was constructing the one world in which the code
  // was right.
  it('places the character when the rig is reached through the RetargetClip the bind builds', async () => {
    const { state } = await mintAndCookThroughRetarget(project(), capability(true, Math.PI / 2));
    const { ops, refusals } = placeCookedMotionOps(state);
    expect(refusals).toEqual([]);
    const placed = apply(state, ops);
    expect(posOf(placed)).toEqual([OFFSET[0], 0, OFFSET[1]]);
    expect(rotOf(placed)).toEqual([0, -90, 0]);
  });

  // Each guard in `riggedSkeletonsForClip` gets its own row, in a world where the
  // others cannot carry it. Written because the first two were VACUOUS: deleting
  // either left the row above green, because the fixture had only one rig, one
  // retarget and nothing else for a loosened match to find.
  it('does NOT claim a rig from a RetargetClip that retargets some OTHER clip', async () => {
    const { state, clipId } = await mintAndCookThroughRetarget(project(), capability());
    // Re-point the retarget at an unrelated clip. The rig is still in the graph
    // and still reachable by a walk that forgets to check WHOSE motion it carries.
    const detached = apply(state, [
      { type: 'addNode', nodeId: 'otherclip', nodeType: 'AnimationClip', params: {} },
      {
        type: 'disconnect',
        from: { node: clipId, socket: 'out' },
        to: { node: 'retarget', socket: 'sourceClip' },
      },
      {
        type: 'connect',
        from: { node: 'otherclip', socket: 'out' },
        to: { node: 'retarget', socket: 'sourceClip' },
      },
    ] as Op[]);
    const out = placeCookedMotionOps(detached);
    expect(out.ops).toEqual([]);
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0].reason).toMatch(/not bound to a character rig/);
  });

  it('does NOT treat a retarget onto a plain Skeleton as a character to place', async () => {
    const { state } = await mintAndCookThroughRetarget(project(), capability());
    // A rig-to-rig retarget is a legitimate graph: `RetargetClip.skeleton` takes a
    // `Skeleton`, and a `GltfSkeleton` is only one of the things that satisfies it.
    // A plain one has no asset and no root Group, so it is not somewhere a
    // character can be STOOD — and saying "no rig" is the honest diagnosis, not
    // "found a rig with nowhere to put it".
    const plain = apply(state, [
      { type: 'addNode', nodeId: 'plainskel', nodeType: 'Skeleton', params: {} },
      {
        type: 'disconnect',
        from: { node: 'gskel', socket: 'out' },
        to: { node: 'retarget', socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'plainskel', socket: 'out' },
        to: { node: 'retarget', socket: 'skeleton' },
      },
    ] as Op[]);
    const out = placeCookedMotionOps(plain);
    expect(out.ops).toEqual([]);
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0].reason).toMatch(/not bound to a character rig/);
  });

  it('places EVERY character the one clip drives, not whichever sorts first', async () => {
    const { state, clipId } = await mintAndCookThroughRetarget(project(), capability());
    const skin = (state.nodes.asset.params as { skins: unknown[] }).skins;
    // A second character, bound to the SAME generated walk. Both were asked to
    // walk the path; leaving one at the origin would make which one moves an
    // accident of id order.
    const two = apply(state, [
      {
        type: 'addNode',
        nodeId: 'asset2',
        nodeType: 'GltfAsset',
        params: { assetRef: 'asset://rig2.glb', skins: skin },
      },
      { type: 'addNode', nodeId: 'gskel2', nodeType: 'GltfSkeleton', params: { skinIndex: 0 } },
      {
        type: 'connect',
        from: { node: 'asset2', socket: 'out' },
        to: { node: 'gskel2', socket: 'asset' },
      },
      { type: 'addNode', nodeId: 'root2', nodeType: 'Group', params: { position: [0, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'asset2', socket: 'out' },
        to: { node: 'root2', socket: 'children' },
      },
      { type: 'addNode', nodeId: 'retarget2', nodeType: 'RetargetClip', params: {} },
      {
        type: 'connect',
        from: { node: clipId, socket: 'out' },
        to: { node: 'retarget2', socket: 'sourceClip' },
      },
      {
        type: 'connect',
        from: { node: 'bonemap', socket: 'out' },
        to: { node: 'retarget2', socket: 'boneMap' },
      },
      {
        type: 'connect',
        from: { node: 'gskel2', socket: 'out' },
        to: { node: 'retarget2', socket: 'skeleton' },
      },
    ] as Op[]);
    const { ops, refusals } = placeCookedMotionOps(two);
    expect(refusals).toEqual([]);
    const placed = apply(two, ops);
    expect(posOf(placed)).toEqual([OFFSET[0], 0, OFFSET[1]]);
    expect((placed.nodes.root2.params as { position: number[] }).position).toEqual([
      OFFSET[0],
      0,
      OFFSET[1],
    ]);
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

// ─────────────────────────────────────────────────────────────────────────────
// #964 — ONE BUTTON, ONE PAID CALL
// ─────────────────────────────────────────────────────────────────────────────
// Lives in this file because the fixtures above ARE the mint → cook → bake road,
// and these rows are about what that road spends.
//
// The generated-clip store is a module-level `Map` that nothing persists, so
// `__resetGeneratedClipsForTests()` is a real reload rather than a simulation of
// one: it clears exactly what a page reload clears, while the project JSON
// survives. After it, every generated clip in a project evaluated as `pending` —
// baked, current, playing, and reported as if it had never been made.
//
// Measured before the fix: two producers, reopened project, one edited, one press
// of that one's button — TWO paid calls. And because generation is
// non-deterministic, the second came back as a DIFFERENT walk and was baked over
// motion the director had already accepted. Money is the smaller half.

import { motionCookOffer } from './cookMotionGenerations';

/** Counts what the service was actually asked to make. */
function countingCapability(calls: string[]): MotionGenerationCapability {
  return {
    id: 'count',
    kind: 'stub',
    isAvailable: async () => true,
    async generate(request): Promise<MotionGenerationResult> {
      calls.push(request.prompt);
      return {
        jobId: 'j',
        bvh: synthesiseBvh(request),
        model: request.model,
        unitScale: STUB_UNIT_SCALE,
        worldOffsetXZ: null,
        worldRotationRadians: null,
      };
    },
    cancel: async () => {},
  };
}

/** Two independent producers in one project, each bound to the character rig. */
async function twoProducers(calls: string[]) {
  let s = project();
  const producers: string[] = [];
  for (const prompt of ['walk A', 'walk B']) {
    const { ops, clipId } = mintMotionGenerateOps(s, {
      prompt,
      seed: 7,
      model: 'kimodo-base',
      curveObjectId: 'pathObj',
    });
    s = apply(s, ops);
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
    producers.push(edgeTarget(s.nodes[clipId], 'source') ?? '');
  }
  await resolvePendingMotionGenerations(s, countingCapability(calls));
  s = apply(s, bakeGeneratedClipOps(s));
  return { state: s, producers };
}

describe('what a cook costs (#964)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('a reload does not make a baked, current clip look unmade', async () => {
    const first: string[] = [];
    const { state, producers } = await twoProducers(first);
    expect(first).toHaveLength(2);

    __resetGeneratedClipsForTests(); // the reload

    for (const id of producers) {
      const offer = motionCookOffer(state, id);
      // `pending` here is what a director reads on the node's card, beside a
      // button saying "Up to date" — and it is what `hasStaleGenerations` keys
      // on, which would report an untouched project as needing work.
      expect(offer.status).toBe('ready');
      expect(offer.stale).toBe(false);
      expect(offer.disabled).toBe(true);
    }
  });

  it('🔑 cooking ONE producer does not regenerate the others', async () => {
    const { state, producers } = await twoProducers([]);
    __resetGeneratedClipsForTests(); // the reload

    // The director edits one producer — the ordinary re-cook gesture.
    const edited = apply(state, [
      { type: 'setParam', nodeId: producers[0], paramPath: 'prompt', value: 'walk A, but faster' },
    ] as Op[]);
    expect(motionCookOffer(edited, producers[0]).disabled).toBe(false);
    expect(motionCookOffer(edited, producers[1]).disabled).toBe(true);

    const calls: string[] = [];
    await resolvePendingMotionGenerations(edited, countingCapability(calls), producers[0]);

    // Exactly the one that was asked for. The prompt is asserted, not just the
    // count: a guard that regenerated the WRONG single clip would also read 1.
    expect(calls).toEqual(['walk A, but faster']);
  });

  // 🔴 THE ROW ABOVE DOES NOT TEST SCOPING, and falsification is what said so:
  // deleting the scope filter left it GREEN, because the materialised guard alone
  // already stops the second call. Both producers there are baked, so scope never
  // gets a chance to matter.
  //
  // This is the case that separates them: NEITHER producer is baked, so both are
  // genuinely pending, and the only thing that can keep the count at one is the
  // scope. Without it this reds and the row above does not.
  it('🔑 scope alone: with NOTHING baked, cooking one still costs one', async () => {
    let s = project();
    const producers: string[] = [];
    for (const prompt of ['walk A', 'walk B']) {
      const { ops, clipId } = mintMotionGenerateOps(s, {
        prompt,
        seed: 7,
        model: 'kimodo-base',
        curveObjectId: 'pathObj',
      });
      s = apply(s, ops);
      producers.push(edgeTarget(s.nodes[clipId], 'source') ?? '');
    }
    // No cook, no bake — two fresh producers, both genuinely pending.
    const calls: string[] = [];
    await resolvePendingMotionGenerations(s, countingCapability(calls), producers[0]);
    expect(calls).toEqual(['walk A']);
  });

  it('and an UNSCOPED cook still skips what is already baked and current', async () => {
    // Defence in depth, and the root of the two. A caller that owns the whole
    // graph passes no producer; it must still not pay for clips whose keys are
    // sitting in the graph. Without this the scoping is the only guard, and the
    // next caller that forgets to scope pays for the whole project.
    const { state, producers } = await twoProducers([]);
    __resetGeneratedClipsForTests();
    const edited = apply(state, [
      { type: 'setParam', nodeId: producers[0], paramPath: 'prompt', value: 'walk A, but faster' },
    ] as Op[]);

    const calls: string[] = [];
    await resolvePendingMotionGenerations(edited, countingCapability(calls));

    expect(calls).toEqual(['walk A, but faster']);
  });
});
