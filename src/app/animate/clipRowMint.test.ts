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
  clipRowMintOps,
  diamondActivation,
  paramAnimationDisplayState,
} from './clipRowMint';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { paramAnimationState } from './paramAnimationState';
import { transformClipCarriesChild } from './clipRowMint';
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
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET, BONE),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: BONE,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  }).next;
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

/** `generatedScene()` plus a GltfChild for OTHER and one ordinary node. */
function sceneWithNeighbours(): DagState {
  let s = generatedScene();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET, OTHER),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: OTHER,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  }).next;
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

// ─────────────────────────────────────────────────────────────────────────
// #911 — the SECOND clip road: a glTF asset's OWN embedded animation.
//
// #908 taught the diamond the `AnimationClip` band. A `.glb` that animates
// itself arrives on a `TransformClip` instead, and stayed gray. These rows use a
// separate assetRef from `generatedScene()` so the two roads cannot be confused
// for one another — and so the sibling road's rows above keep meaning what they
// say.
// ─────────────────────────────────────────────────────────────────────────

const EMBEDDED_ASSET = 'asset-embedded';
const EMBEDDED_CHILD = 'Torso';
const EMBEDDED_UNANIMATED = 'Antenna';

/** A glTF asset whose OWN animation drives EMBEDDED_CHILD, wired the way the
 *  importer wires it: GltfAsset ← ClipSelect ← TransformClip. */
function embeddedAnimationScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf_e',
    nodeType: 'GltfAsset',
    params: { assetRef: EMBEDDED_ASSET },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_tclip_e',
    nodeType: 'TransformClip',
    params: {
      name: 'spin',
      duration: 1,
      keyframes: [
        {
          targetNodeId: EMBEDDED_CHILD,
          time: 0,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        {
          targetNodeId: EMBEDDED_CHILD,
          time: 1,
          position: [0, 1, 0],
          rotation: [0, 90, 0],
          scale: [2, 2, 2],
        },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_sel_e',
    nodeType: 'ClipSelect',
    params: { selectedClipName: 'spin' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_tclip_e', socket: 'out' },
    to: { node: 'n_sel_e', socket: 'clips' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_sel_e', socket: 'out' },
    to: { node: 'n_gltf_e', socket: 'transformClip' },
  }).next;
  for (const child of [EMBEDDED_CHILD, EMBEDDED_UNANIMATED]) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(EMBEDDED_ASSET, child),
      nodeType: 'GltfChild',
      params: {
        assetRef: EMBEDDED_ASSET,
        childName: child,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    }).next;
  }
  return s;
}

describe("#911 — the diamond reads a glTF's own embedded animation", () => {
  const CHILD_ID = gltfChildDagId(EMBEDDED_ASSET, EMBEDDED_CHILD);

  it('an embedded-clip child reports animated, where the narrow reader says none', () => {
    const s = embeddedAnimationScene();
    // The narrow reader is not wrong — there is no authored channel here, and
    // ParamDiamond's delete gate still depends on that answer.
    expect(paramAnimationState(s, CHILD_ID, 'rotation', 30)).toBe('none');
    expect(paramAnimationDisplayState(s, CHILD_ID, 'rotation', 30)).toBe('animated');
    expect(paramAnimationDisplayState(s, CHILD_ID, 'position', 30)).toBe('animated');
  });

  it('SCALE is animated here and NOT on the AnimationClip road — the roads differ', () => {
    // 🔑 The row that stops one shared component filter being used for both. A
    // TransformClip key carries full TRS; an AnimationClip key has no scale at
    // all. Both answers below are correct, and they disagree — so a helper that
    // gave one answer would be lying on one of the two roads.
    expect(paramAnimationDisplayState(embeddedAnimationScene(), CHILD_ID, 'scale', 30)).toBe(
      'animated',
    );
    expect(
      paramAnimationDisplayState(sceneWithNeighbours(), gltfChildDagId(ASSET, BONE), 'scale', 30),
    ).toBe('none');
  });

  it('a child the embedded clip never targets still reports none', () => {
    // Without this row a fix that returned 'animated' for every child of an
    // animated asset passes.
    const s = embeddedAnimationScene();
    expect(
      paramAnimationDisplayState(
        s,
        gltfChildDagId(EMBEDDED_ASSET, EMBEDDED_UNANIMATED),
        'rotation',
        30,
      ),
    ).toBe('none');
  });

  it('never reports on-key from the embedded clip alone', () => {
    // The clip has a key at t=0, so frame 0 is ON one. Same reasoning as the
    // sibling road: the clip is the asset's, not the director's, so yellow —
    // which reads as "click to unkey" — would be an invitation to a delete that
    // cannot happen.
    expect(paramAnimationDisplayState(embeddedAnimationScene(), CHILD_ID, 'rotation', 0)).toBe(
      'animated',
    );
  });

  it('the probe answers about the CHILD, not about the asset having any clip at all', () => {
    const s = embeddedAnimationScene();
    expect(transformClipCarriesChild(s, EMBEDDED_ASSET, EMBEDDED_CHILD)).toBe(true);
    expect(transformClipCarriesChild(s, EMBEDDED_ASSET, EMBEDDED_UNANIMATED)).toBe(false);
    // …and an asset with no embedded clip at all is false rather than throwing.
    expect(transformClipCarriesChild(sceneWithNeighbours(), ASSET, BONE)).toBe(false);
  });
});
