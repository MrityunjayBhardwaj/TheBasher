// #889 slice 3 / #903 — dragging a key on a GENERATED character's clip row.
//
// Before this, `dispatchBakeThenRetime` minted through `bakeGltfChannel`, which
// reads the active TransformClip. A generated / BVH / retargeted motion is an
// AnimationClip, so that mutator refused — "No active clip track for bone" —
// and the drag aborted at the first step, doing nothing at all.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchBakeThenRetime } from './dispatchMutator';
import { keyParamFromTransient } from './autoKeyCommit';
import { buildKeyframeInsertOp, buildKeyframeDeleteOp } from '../KeyboardShortcuts';
import { useTimelineSelection } from '../../timeline/timelineSelection';
import { useTimeStore } from '../stores/timeStore';
import {
  animationClipCarriesBone,
  boneComponentAddress,
  clipRowMintOps,
  diamondActivation,
  paramAnimationDisplayState,
} from './clipRowMint';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { paramAnimationState } from './paramAnimationState';
import { importedChildOps } from '../../test-utils/importedChildFixture';
const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ASSET = 'asset-generated';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** GltfAsset → GltfSkeleton ← AnimationClip, plus the bone. The clip hangs off
 *  the rig by EDGE, which is what makes its bone indices meaningful. */
function generatedScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      skins: [
        {
          jointKeys: [OTHER, BONE],
          bindTRS: [
            { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          ],
          parentJointIndex: [-1, 0],
          inverseBindMatrices: [IDENTITY16, IDENTITY16],
        },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_rig',
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_gltf', socket: 'out' },
    to: { node: 'n_rig', socket: 'asset' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip',
    nodeType: 'AnimationClip',
    params: {
      duration: 1,
      loop: 'cycle-offset',
      keyframes: [
        { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
        { bone: 1, time: 1, position: [0, 2, 0], rotation: [0, 0, 0] },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_rig', socket: 'out' },
    to: { node: 'n_clip', socket: 'skeleton' },
  }).next;
  for (const op of importedChildOps(gltfChildDagId(ASSET, BONE), {
    assetRef: ASSET,
    childName: BONE,
  })) {
    s = applyOp(s, op as Op).next;
  }
  return s;
}

describe('which road the bone is on', () => {
  it('recognises a clip bound to the rig by edge', () => {
    expect(animationClipCarriesBone(generatedScene(), ASSET, BONE)).toBe(true);
  });

  it('says no for a bone the bound clip never keys', () => {
    // OTHER is in jointKeys but has no keyframes — a bone the motion does not
    // touch. Answering yes here would mint a channel seeded from nothing.
    expect(animationClipCarriesBone(generatedScene(), ASSET, OTHER)).toBe(false);
  });

  it('picks the AnimationClip mint, and it emits ops', () => {
    const mint = clipRowMintOps(generatedScene(), ASSET, BONE, 'rotation');
    expect(mint.ok).toBe(true);
    if (!mint.ok) return;
    expect(mint.source).toBe('animation-clip');
    expect(mint.ops).toHaveLength(1);
    // The closure DESCRIBES the ops it came with: every node the mint touches
    // is a declared root. Asserting the array literally would pin a shape;
    // asserting coverage pins the property that makes a closure spec worth
    // having. (What it does NOT do is keep the composite's later write legal —
    // each retime step declares its own root, measured by removing this one and
    // watching every drag row stay green.)
    const targets = mint.ops.map((o) => ('nodeId' in o ? o.nodeId : null));
    for (const t of targets) expect(mint.closure.rootSelectors).toContain(t);
    expect(mint.closure.rootSelectors).toContain(gltfChildDagId(ASSET, BONE));
  });

  it('mints nothing when the channel is already there', () => {
    const base = generatedScene();
    const first = clipRowMintOps(base, ASSET, BONE, 'rotation');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let s = base;
    for (const op of first.ops) s = applyOp(s, op).next;
    const second = clipRowMintOps(s, ASSET, BONE, 'rotation');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ops).toHaveLength(0);
  });
});

describe('dragging a key on a generated character’s clip row', () => {
  it('mints the bone’s channel AND retimes the key, as one entry', () => {
    useDagStore.getState().hydrate(generatedScene());
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();

    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: BONE,
      component: 'position',
      fromTime: 1,
      toTime: 0.5,
    });
    expect(res.ok).toBe(true);

    const channel = useDagStore.getState().state.nodes[channelId];
    expect(channel).toBeDefined();
    const keys = (channel!.params as { keyframes: { time: number; value: number[] }[] }).keyframes;
    // The clip's OWN track survived the edit — the key moved from 1 to 0.5 and
    // the key at 0 is still there. A mint that seeded from nothing would leave
    // a single key and still pass an "ok === true" assertion.
    expect(keys.map((k) => k.time)).toEqual([0, 0.5]);
    expect(keys.find((k) => k.time === 0.5)!.value).toEqual([0, 2, 0]);
    expect(keys.find((k) => k.time === 0)!.value).toEqual([0, 1, 0]);
  });

  it('is ONE undo — reverting takes the channel away with the edit', () => {
    useDagStore.getState().hydrate(generatedScene());
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    expect(
      dispatchBakeThenRetime({
        assetRef: ASSET,
        childName: BONE,
        component: 'position',
        fromTime: 1,
        toTime: 0.5,
      }).ok,
    ).toBe(true);
    expect(useDagStore.getState().state.nodes[channelId]).toBeDefined();
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();
  });

  it('refuses a bone the bound clip never keys, rather than minting from nothing', () => {
    useDagStore.getState().hydrate(generatedScene());
    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: OTHER,
      component: 'position',
      fromTime: 0,
      toTime: 0.5,
    });
    expect(res.ok).toBe(false);
  });
});

describe('the keyboard paths on a read-only clip row', () => {
  beforeEach(() => {
    useDagStore.getState().hydrate(generatedScene());
    useTimelineSelection.getState().setActiveKeyframe(null);
  });

  it('K mints the channel and keys the RENDERED pose, not the base pose', () => {
    // The bone's own `position` param is [0,0,0] — its base pose. The clip puts
    // it at [0,1,0] at t=0 and [0,2,0] at t=1. Keying the base pose here would
    // drop a key a metre from what the director is looking at, on a bone that
    // had been moving correctly.
    useTimelineSelection.getState().setActiveChannel(`clip:${BONE}:position`);
    useTimeStore.getState().setTime(0.5);

    const ops = buildKeyframeInsertOp();
    expect(ops).not.toBeNull();
    expect(ops!.length).toBe(2); // mint + write
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    const write = ops!.find((o) => o.type === 'setParam') as unknown as {
      nodeId: string;
      value: { time: number; value: number[] }[];
    };
    expect(write.nodeId).toBe(channelId);
    const keyed = write.value.find((k) => k.time === 0.5)!;
    expect(keyed.value[1]).toBeCloseTo(1.5, 6); // halfway between 1 and 2
    // and the clip's own keys survived
    expect(write.value.map((k) => k.time)).toEqual([0, 0.5, 1]);
  });

  it('Delete on a clip-row key mints and removes THAT key', () => {
    useTimelineSelection
      .getState()
      .setActiveKeyframe({ channelId: `clip:${BONE}:position`, time: 1 });
    const ops = buildKeyframeDeleteOp();
    expect(ops).not.toBeNull();
    const write = ops!.find((o) => o.type === 'setParam') as unknown as {
      value: { time: number }[];
    };
    expect(write.value.map((k) => k.time)).toEqual([0]);
  });

  it('refuses to delete the LAST key rather than leaving an empty channel', () => {
    // An empty channel is a claim, not silence: the band collects it and the
    // sampler answers [0,0,0] at every time, so emptying it would snap the bone
    // to the origin instead of returning it to the clip.
    useDagStore.getState().hydrate(generatedScene());
    useTimelineSelection
      .getState()
      .setActiveKeyframe({ channelId: `clip:${BONE}:position`, time: 1 });
    const first = buildKeyframeDeleteOp();
    useDagStore.getState().dispatchAtomic(first!, 'user', 'delete');
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    useTimelineSelection.getState().setActiveKeyframe({ channelId, time: 0 });
    expect(buildKeyframeDeleteOp()).toBeNull();
  });
});

describe('the diamond / auto-key chokepoint on a bone', () => {
  it('mints the CONTENT-ADDRESSED channel, not addChannel’s generic one', () => {
    // The first-key composite builds `<target>_<paramPath>_channel` and carries
    // none of the dual key the renderer's enumerator matches on — the key would
    // appear in the dopesheet and drive nothing.
    useDagStore.getState().hydrate(generatedScene());
    useTimeStore.getState().setTime(0.25);
    const boneId = gltfChildDagId(ASSET, BONE);
    const res = keyParamFromTransient(boneId, 'position', [5, 5, 5]);
    expect(res.ok).toBe(true);

    const nodes = useDagStore.getState().state.nodes;
    const contentAddressed = gltfChannelDagId(ASSET, BONE, 'position');
    expect(nodes[contentAddressed]).toBeDefined();
    expect(nodes[`${boneId}_position_channel`]).toBeUndefined();
    // The dual key the enumerator reads.
    const params = nodes[contentAddressed]!.params as Record<string, unknown>;
    expect(params.target).toBe(boneId);
    expect(params.childName).toBe(BONE);
    expect(params.assetRef).toBe(ASSET);
    // Seeded, then keyed — the clip's track is still there under the new key.
    const keys = params.keyframes as { time: number; value: number[] }[];
    expect(keys.map((k) => k.time)).toEqual([0, 0.25, 1]);
    expect(keys.find((k) => k.time === 0.25)!.value).toEqual([5, 5, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #908 — the inspector diamond reports a clip-driven bone as animated.
//
// Built on `generatedScene()` above, so every row runs against nodes the real
// schemas accepted rather than an object literal cast into shape.
// ─────────────────────────────────────────────────────────────────────────

/** `generatedScene()` plus an imported child for OTHER and one ordinary node. */
function sceneWithNeighbours(): DagState {
  let s = generatedScene();
  for (const op of importedChildOps(gltfChildDagId(ASSET, OTHER), {
    assetRef: ASSET,
    childName: OTHER,
  })) {
    s = applyOp(s, op as Op).next;
  }
  s = applyOp(s, { type: 'addNode', nodeId: 'n_plain', nodeType: 'Transform', params: {} }).next;
  return s;
}

/** The scene with BONE's rotation channel actually minted, through the mint. */
function sceneWithAuthoredChannel(): DagState {
  let s = sceneWithNeighbours();
  const mint = clipRowMintOps(s, ASSET, BONE, 'rotation');
  if (!mint.ok) throw new Error(`mint failed: ${mint.reason}`);
  for (const op of mint.ops) s = applyOp(s, op).next;
  return s;
}

describe('#908 — what the diamond shows for a clip-driven bone', () => {
  const BONE_ID = gltfChildDagId(ASSET, BONE);

  it('a clip-driven bone with NO channel reports animated, where the narrow reader says none', () => {
    const s = sceneWithNeighbours();
    // The narrow reader is not wrong — it answers a different question, and
    // ParamDiamond's delete gate still depends on that answer.
    expect(paramAnimationState(s, BONE_ID, 'rotation', 30)).toBe('none');
    expect(paramAnimationDisplayState(s, BONE_ID, 'rotation', 30)).toBe('animated');
    expect(paramAnimationDisplayState(s, BONE_ID, 'position', 30)).toBe('animated');
  });

  it('a bone the bound clip never keys still reports none', () => {
    // Without this row a fix that returned 'animated' for every bone passes.
    const s = sceneWithNeighbours();
    expect(paramAnimationDisplayState(s, gltfChildDagId(ASSET, OTHER), 'rotation', 30)).toBe(
      'none',
    );
  });

  it('scale reports none — an AnimationClip has no scale track to be animated by', () => {
    // Claiming scale would be the same lie pointing the other way, and it is
    // the same call the read band makes when it supplies position and rotation
    // only.
    const s = sceneWithNeighbours();
    expect(paramAnimationDisplayState(s, BONE_ID, 'scale', 30)).toBe('none');
  });

  it('never reports on-key from the clip alone — a clip key is not the director to remove', () => {
    // The clip has a key at t=0, so frame 0 is ON one. Yellow reads as "click
    // to unkey", and the clip is read-only and shared.
    const s = sceneWithNeighbours();
    expect(paramAnimationDisplayState(s, BONE_ID, 'rotation', 0)).toBe('animated');
  });

  it('an authored channel outranks the clip, and only then does the playhead light yellow', () => {
    // Same bone, same frame 0, one difference: the channel now exists. The
    // contrast with the row above IS the outranking.
    const s = sceneWithAuthoredChannel();
    expect(paramAnimationState(s, BONE_ID, 'rotation', 0)).toBe('on-key');
    expect(paramAnimationDisplayState(s, BONE_ID, 'rotation', 0)).toBe('on-key');
    // Between its own keys it is animated — the widening never demotes.
    expect(paramAnimationDisplayState(s, BONE_ID, 'rotation', 30)).toBe('animated');
  });

  it('an ordinary node is untouched — the widening reaches glTF bones only', () => {
    const s = sceneWithNeighbours();
    expect(paramAnimationDisplayState(s, 'n_plain', 'position', 30)).toBe('none');
  });
});

// ---------------------------------------------------------------------------

describe('boneComponentAddress — the address four write paths depend on (#389 C3 tripwire)', () => {
  // WHY THIS EXISTS, and why it is here rather than beside the split.
  //
  // `boneComponentAddress` had NO tracked test naming it, and four production callers
  // reach it: the parameter diamond's Alt-click path (`ParamDiamond.tsx`), BOTH Auto-Key
  // chokepoints (`autoKeyCommit.ts:168` and `:223`), and `resolveRowChannelForWrite`
  // below. It was only ever exercised indirectly, through `clipRowMintOps`.
  //
  // Its kind test WAS `node.type !== 'GltfChild'`, and #389 C3 rewrote it: the fused kind
  // retired, a bone became an ordinary `Object` pointing at a `GltfData`, and the test
  // became a hop through `importedChildOf`. These rows were written BEFORE that flip, on
  // purpose — they passed on the fused kind and they pass now, which is what makes them a
  // characterisation of the FUNCTION rather than of either spelling.
  //
  // What a missed conversion would have cost, measured caller by caller rather than
  // asserted in a group — an earlier draft of this comment said "all four go quiet", and
  // one of them does not:
  //   · `autoKeyCommit.ts:168` / `:223`  — both auto-key chokepoints lose the address.
  //   · `clipRowMint.ts:237`             — `paramAnimationDisplayState` falls through to
  //     the address, gets null, and answers 'none' where it answers 'animated' today, so
  //     a clip-driven bone's diamond goes gray. That is #908 regressing wholesale, and it
  //     is guarded by the #908 rows above, which red under exactly this condition.
  //   · `ParamDiamond.tsx`               — SURVIVES. Its Alt-click gate is fed by the
  //     NARROW reader (`paramAnimationState`, which never reaches this function), so the
  //     branch it takes does not move; the refusal falls to a literal fallback and still
  //     refuses. Only the sentence degrades, from the mutator's own to a generic one.
  //     The narrow-versus-wide split is load-bearing here and easy to conflate — see
  //     `ParamDiamond.tsx`'s own header, and the #908 row that pins the two readers
  //     disagreeing for the same bone.
  //
  // So this is a characterisation row, deliberately written BEFORE the flip: it passes on
  // the fused kind today and must still pass after it. It is the assertion that turns a
  // silent behaviour change into a red.
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  const bonePaths = ['position', 'rotation', 'scale'] as const;

  it('ANTI-VACUITY: the fixture bone really is the kind under test', () => {
    // Without this, the rows below would keep passing against a scene whose bone node
    // was never there — "returns an address" is not a claim about anything if the id
    // resolves to nothing.
    //
    // #389 — the address moved to the DATA half, so this checks BOTH nodes and the edge
    // between them. Checking only the Object would have kept passing against a pair whose
    // data node was missing, which is precisely the fixture the flip could have produced.
    const state = generatedScene();
    const object = state.nodes[gltfChildDagId(ASSET, BONE)];

    expect(object).toBeDefined();
    expect(object.type).toBe('Object');
    const dataRef = (object.inputs as { data?: { node?: string } }).data;
    expect(dataRef?.node).toBeDefined();
    const data = state.nodes[dataRef!.node!];
    expect(data.type).toBe('GltfData');
    expect(data.params).toMatchObject({ assetRef: ASSET, childName: BONE });
  });

  for (const paramPath of bonePaths) {
    it(`returns the bone's address for a plain glTF bone — ${paramPath}`, () => {
      const address = boneComponentAddress(
        generatedScene(),
        gltfChildDagId(ASSET, BONE),
        paramPath,
      );

      expect(address).toEqual({ assetRef: ASSET, childName: BONE, component: paramPath });
    });
  }

  it('answers null for a param that is not a TRS component', () => {
    // The negative half matters as much as the positive one: a conversion that made this
    // function answer for EVERYTHING would pass a test that only checked the bone rows.
    expect(boneComponentAddress(generatedScene(), gltfChildDagId(ASSET, BONE), 'name')).toBeNull();
  });

  it('answers null for a node that carries the SAME params but is not an imported child', () => {
    // The discriminator has to differ from the bone in the TESTED PROPERTY ALONE. An
    // arbitrary other node is not one: it fails the `assetRef`/`childName` guards further
    // down, so the row stays green even with the kind test deleted — measured, and it is
    // how this row was first written.
    //
    // #389 MOVED WHERE THAT PROPERTY LIVES, and the row moved with it rather than being
    // deleted. Before the split, cloning the bone and setting `type: 'Object'` was the
    // impostor. After it, `Object` is what a bone IS — that clone is a REAL imported
    // child, and this row would assert the opposite of the truth while reading exactly as
    // it always did. The kind test is now a hop: Object → `data` → is it a `GltfData`?
    // So the impostor is an Object whose `data` points at a BoxData instead: same params,
    // same type, same edge, and the ONE difference is what the guard actually asks.
    let state = generatedScene();
    const boneId = gltfChildDagId(ASSET, BONE);
    const impostorId = 'n_impostor';
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_impostor_data',
      nodeType: 'BoxData',
      params: { size: [1, 1, 1] },
    }).next;
    const impostor: DagState = {
      ...state,
      nodes: {
        ...state.nodes,
        [impostorId]: {
          ...state.nodes[boneId],
          id: impostorId,
          inputs: { data: { node: 'n_impostor_data', socket: 'out' } },
        },
      },
    };

    expect(impostor.nodes[impostorId].params).toEqual(state.nodes[boneId].params);
    expect(impostor.nodes[impostorId].type).toBe(state.nodes[boneId].type);
    expect(boneComponentAddress(impostor, impostorId, 'rotation')).toBeNull();
  });

  it('answers null for an id that is in no graph at all', () => {
    expect(boneComponentAddress(generatedScene(), 'n_does_not_exist', 'rotation')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #912 — Alt-click promised a delete and performed a create
// ─────────────────────────────────────────────────────────────────────────
// The defect was a conditional inside `ParamDiamond.onActivate`, and the reason
// it survived is that nothing could reach it: observing an Alt-click do the
// opposite of its tooltip needed a browser. The decision is a pure function now,
// so these four rows ARE the issue's test plan.
describe('#912 — what a diamond activation means', () => {
  it('ALT on a clip-driven bone REFUSES — it must never fall through and key', () => {
    // The whole bug in one row. `'none'` is the normal state of nearly every
    // bone since copy-on-write, and the old gate sent exactly this case to the
    // keying path.
    expect(diamondActivation(true, 'none')).toBe('refuse-nothing-authored');
    expect(diamondActivation(true, 'none')).not.toBe('key');
  });

  it('ALT on a bone that HAS an authored channel still deletes — no regression', () => {
    expect(diamondActivation(true, 'on-key')).toBe('delete');
    expect(diamondActivation(true, 'animated')).toBe('delete');
  });

  it('a plain click on a clip-driven bone still mints and keys — that road is correct', () => {
    expect(diamondActivation(false, 'none')).toBe('key');
    expect(diamondActivation(false, 'animated')).toBe('key');
  });

  it("a plain click ON a key still deletes it — Blender's toggle", () => {
    expect(diamondActivation(false, 'on-key')).toBe('delete');
  });

  it('ALT never keys, for ANY authored state — the property, not three examples', () => {
    // The three rows above are instances; this is the rule they are instances
    // of. A future state added to the enum has to satisfy it too, which is the
    // half that a table of examples cannot express.
    for (const st of ['none', 'animated', 'on-key'] as const) {
      expect(diamondActivation(true, st)).not.toBe('key');
    }
  });
});
