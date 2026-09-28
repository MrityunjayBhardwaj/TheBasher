// #889 slice 3 / #903 / #911 — editing a key on a read-only clip row.
//
// A clip row has no channel node until an edit makes one (copy-on-write), so every edit on it —
// a drag, K, Delete, the diamond — first MINTS the child's channel from the clip, then writes.
// The clip here is an imported file's OWN animation (a `TransformClip` on the asset), minted by
// `bakeGltfChannel`. A second road, a motion bound onto a clone rig and minted from that
// `AnimationClip`, retired with the clone road's character half (#1053); its rows were ported
// here where they asked a question this road also answers, and deleted where they did not.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
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
  boneComponentAddress,
  clipRowMintOps,
  diamondActivation,
  paramAnimationDisplayState,
  resolveRowChannelForWrite,
  rowFlagToggleOps,
  transformClipCarriesChild,
} from './clipRowMint';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { paramAnimationState } from './paramAnimationState';
import { clipRowChannelId } from '../../timeline/clipChannelRows';
import { importedChildOps } from '../../test-utils/importedChildFixture';

const ASSET = 'asset-plain';
const BONE = 'mixamorig_LeftArm';

const EMBEDDED_ASSET = 'asset-embedded';
const EMBEDDED_CHILD = 'Torso';
const EMBEDDED_UNANIMATED = 'Antenna';
const CHILD_ID = gltfChildDagId(EMBEDDED_ASSET, EMBEDDED_CHILD);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** A glTF asset and one imported child, with nothing animating it. */
function plainChildScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET },
  }).next;
  for (const op of importedChildOps(gltfChildDagId(ASSET, BONE), {
    assetRef: ASSET,
    childName: BONE,
  })) {
    s = applyOp(s, op as Op).next;
  }
  return s;
}

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
    for (const op of importedChildOps(gltfChildDagId(EMBEDDED_ASSET, child), {
      assetRef: EMBEDDED_ASSET,
      childName: child,
    })) {
      s = applyOp(s, op as Op).next;
    }
  }
  s = applyOp(s, { type: 'addNode', nodeId: 'n_plain', nodeType: 'Transform', params: {} }).next;
  return s;
}

describe('the clip-row mint', () => {
  it('mints from the file’s own clip, one channel per component, rooted at the child', () => {
    const mint = clipRowMintOps(
      embeddedAnimationScene(),
      EMBEDDED_ASSET,
      EMBEDDED_CHILD,
      'rotation',
    );
    expect(mint.ok).toBe(true);
    if (!mint.ok) return;
    expect(mint.source).toBe('transform-clip');
    // The bake materialises the whole child whichever component was asked.
    const added = mint.ops.flatMap((o) => (o.type === 'addNode' ? [o.nodeId] : []));
    expect(added.sort()).toEqual(
      (['position', 'rotation', 'scale'] as const)
        .map((c) => gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, c))
        .sort(),
    );
    // The closure is `bakeGltfChannel`'s own, and it names the child it bakes.
    expect(mint.closure.rootSelectors).toContain(CHILD_ID);
  });

  it('mints nothing when the channel is already there', () => {
    const base = embeddedAnimationScene();
    const first = clipRowMintOps(base, EMBEDDED_ASSET, EMBEDDED_CHILD, 'rotation');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let s = base;
    for (const op of first.ops) s = applyOp(s, op).next;
    const second = clipRowMintOps(s, EMBEDDED_ASSET, EMBEDDED_CHILD, 'rotation');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ops).toHaveLength(0);
  });

  it('refuses a child the clip never targets, rather than minting from nothing', () => {
    const mint = clipRowMintOps(
      embeddedAnimationScene(),
      EMBEDDED_ASSET,
      EMBEDDED_UNANIMATED,
      'rotation',
    );
    expect(mint.ok).toBe(false);
  });
});

describe('dragging a key on a clip row', () => {
  it('mints the child’s channel AND retimes the key, as one entry', () => {
    useDagStore.getState().hydrate(embeddedAnimationScene());
    const channelId = gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, 'position');
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();

    const res = dispatchBakeThenRetime({
      assetRef: EMBEDDED_ASSET,
      childName: EMBEDDED_CHILD,
      component: 'position',
      fromTime: 1,
      toTime: 0.5,
    });
    expect(res.ok).toBe(true);

    const channel = useDagStore.getState().state.nodes[channelId];
    expect(channel).toBeDefined();
    const keys = (channel!.params as { keyframes: { time: number; value: number[] }[] }).keyframes;
    // The clip's OWN track survived the edit — the key moved from 1 to 0.5 and the key at 0 is
    // still there. A mint that seeded from nothing would leave a single key and still pass an
    // "ok === true" assertion.
    expect(keys.map((k) => k.time)).toEqual([0, 0.5]);
    expect(keys.find((k) => k.time === 0.5)!.value).toEqual([0, 1, 0]);
    expect(keys.find((k) => k.time === 0)!.value).toEqual([0, 0, 0]);
  });

  it('is ONE undo — reverting takes the channel away with the edit', () => {
    useDagStore.getState().hydrate(embeddedAnimationScene());
    const channelId = gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, 'position');
    expect(
      dispatchBakeThenRetime({
        assetRef: EMBEDDED_ASSET,
        childName: EMBEDDED_CHILD,
        component: 'position',
        fromTime: 1,
        toTime: 0.5,
      }).ok,
    ).toBe(true);
    expect(useDagStore.getState().state.nodes[channelId]).toBeDefined();
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();
  });

  it('refuses a child the clip never targets', () => {
    useDagStore.getState().hydrate(embeddedAnimationScene());
    const res = dispatchBakeThenRetime({
      assetRef: EMBEDDED_ASSET,
      childName: EMBEDDED_UNANIMATED,
      component: 'position',
      fromTime: 0,
      toTime: 0.5,
    });
    expect(res.ok).toBe(false);
  });
});

describe('the keyboard paths on a read-only clip row', () => {
  beforeEach(() => {
    useDagStore.getState().hydrate(embeddedAnimationScene());
    useTimelineSelection.getState().setActiveKeyframe(null);
  });

  it('K mints the channel and keys the RENDERED pose, not the base pose', () => {
    // The child's own `position` param is [0,0,0] — its base pose. The clip puts it at [0,1,0]
    // at t=1. Keying the base pose at t=0.5 would drop a key half a metre from what the director
    // is looking at, on a child that had been moving correctly.
    useTimelineSelection.getState().setActiveChannel(clipRowChannelId(EMBEDDED_CHILD, 'position'));
    useTimeStore.getState().setTime(0.5);

    const ops = buildKeyframeInsertOp();
    expect(ops).not.toBeNull();
    const channelId = gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, 'position');
    // mint (the channel's addNode among the bake's) + one write to that channel
    expect(ops!.some((o) => o.type === 'addNode' && o.nodeId === channelId)).toBe(true);
    const writes = ops!.filter((o) => o.type === 'setParam');
    expect(writes).toHaveLength(1);
    const write = writes[0] as unknown as {
      nodeId: string;
      value: { time: number; value: number[] }[];
    };
    expect(write.nodeId).toBe(channelId);
    const keyed = write.value.find((k) => k.time === 0.5)!;
    expect(keyed.value[1]).toBeCloseTo(0.5, 6); // halfway between 0 and 1
    // and the clip's own keys survived
    expect(write.value.map((k) => k.time)).toEqual([0, 0.5, 1]);
  });

  it('Delete on a clip-row key mints and removes THAT key', () => {
    useTimelineSelection.getState().setActiveKeyframe({
      channelId: clipRowChannelId(EMBEDDED_CHILD, 'position'),
      time: 1,
    });
    const ops = buildKeyframeDeleteOp();
    expect(ops).not.toBeNull();
    const write = ops!.find((o) => o.type === 'setParam') as unknown as {
      value: { time: number }[];
    };
    expect(write.value.map((k) => k.time)).toEqual([0]);
  });

  it('refuses to delete the LAST key rather than leaving an empty channel', () => {
    // An empty channel is a claim, not silence: the band collects it and the sampler answers
    // [0,0,0] at every time, so emptying it would snap the child to the origin instead of
    // returning it to the clip.
    useTimelineSelection.getState().setActiveKeyframe({
      channelId: clipRowChannelId(EMBEDDED_CHILD, 'position'),
      time: 1,
    });
    const first = buildKeyframeDeleteOp();
    useDagStore.getState().dispatchAtomic(first!, 'user', 'delete');
    const channelId = gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, 'position');
    useTimelineSelection.getState().setActiveKeyframe({ channelId, time: 0 });
    expect(buildKeyframeDeleteOp()).toBeNull();
  });
});

describe('the diamond / auto-key chokepoint on a bone', () => {
  it('mints the CONTENT-ADDRESSED channel, not addChannel’s generic one', () => {
    // The first-key composite builds `<target>_<paramPath>_channel` and carries none of the dual
    // key the renderer's enumerator matches on — the key would appear in the dopesheet and drive
    // nothing.
    useDagStore.getState().hydrate(plainChildScene());
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
    // Seeded from the base pose, then keyed — nothing animates this child, so the one seed key
    // is where it already stood.
    const keys = params.keyframes as { time: number; value: number[] }[];
    expect(keys.map((k) => k.time)).toEqual([0, 0.25]);
    expect(keys.find((k) => k.time === 0.25)!.value).toEqual([5, 5, 5]);
  });
});

describe('#1277 — keying the diamond on a child the file’s own clip drives', () => {
  it('lands the key ON the clip’s track — the clip’s later key survives', () => {
    // The clip-row K above keeps the clip's keys; the diamond reaches a different mint and
    // must agree with it. Before #1277 this left [0, 0.25]: the t=1 key was gone, and the
    // child stopped following the file's motion the moment it was keyed.
    useDagStore.getState().hydrate(embeddedAnimationScene());
    useTimeStore.getState().setTime(0.25);
    expect(keyParamFromTransient(CHILD_ID, 'position', [5, 5, 5]).ok).toBe(true);
    const channel =
      useDagStore.getState().state.nodes[
        gltfChannelDagId(EMBEDDED_ASSET, EMBEDDED_CHILD, 'position')
      ];
    const keys = (channel!.params as { keyframes: { time: number; value: number[] }[] }).keyframes;
    expect(keys.map((k) => k.time)).toEqual([0, 0.25, 1]);
    expect(keys.find((k) => k.time === 1)!.value).toEqual([0, 1, 0]);
    expect(keys.find((k) => k.time === 0.25)!.value).toEqual([5, 5, 5]);
  });
});

describe('#908 — an authored channel outranks the clip in the diamond', () => {
  it('only once the channel exists does the playhead light yellow', () => {
    // The clip has a key at t=0, and from the clip alone the diamond says animated, never on-key
    // (the #911 rows below). Same child, same frame 0, one difference: the channel now exists.
    // The contrast IS the outranking.
    let s = embeddedAnimationScene();
    const mint = clipRowMintOps(s, EMBEDDED_ASSET, EMBEDDED_CHILD, 'rotation');
    if (!mint.ok) throw new Error(`mint failed: ${mint.reason}`);
    for (const op of mint.ops) s = applyOp(s, op).next;
    expect(paramAnimationState(s, CHILD_ID, 'rotation', 0)).toBe('on-key');
    expect(paramAnimationDisplayState(s, CHILD_ID, 'rotation', 0)).toBe('on-key');
    // Between its own keys it is animated — the widening never demotes.
    expect(paramAnimationDisplayState(s, CHILD_ID, 'rotation', 15)).toBe('animated');
  });

  it('an ordinary node is untouched — the widening reaches imported children only', () => {
    const s = embeddedAnimationScene();
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
    const state = plainChildScene();
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
        plainChildScene(),
        gltfChildDagId(ASSET, BONE),
        paramPath,
      );

      expect(address).toEqual({ assetRef: ASSET, childName: BONE, component: paramPath });
    });
  }

  it('answers null for a param that is not a TRS component', () => {
    // The negative half matters as much as the positive one: a conversion that made this
    // function answer for EVERYTHING would pass a test that only checked the bone rows.
    expect(boneComponentAddress(plainChildScene(), gltfChildDagId(ASSET, BONE), 'name')).toBeNull();
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
    let state = plainChildScene();
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
    expect(boneComponentAddress(plainChildScene(), 'n_does_not_exist', 'rotation')).toBeNull();
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

describe("#911 — the diamond reads a glTF's own embedded animation", () => {
  it('an embedded-clip child reports animated, where the narrow reader says none', () => {
    const s = embeddedAnimationScene();
    // The narrow reader is not wrong — there is no authored channel here, and
    // ParamDiamond's delete gate still depends on that answer.
    expect(paramAnimationState(s, CHILD_ID, 'rotation', 30)).toBe('none');
    expect(paramAnimationDisplayState(s, CHILD_ID, 'rotation', 30)).toBe('animated');
    expect(paramAnimationDisplayState(s, CHILD_ID, 'position', 30)).toBe('animated');
  });

  it('SCALE is animated too — a TransformClip key carries full TRS', () => {
    expect(paramAnimationDisplayState(embeddedAnimationScene(), CHILD_ID, 'scale', 30)).toBe(
      'animated',
    );
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
    expect(transformClipCarriesChild(plainChildScene(), ASSET, BONE)).toBe(false);
  });
});

describe('#1215 — mute / solo on a read-only clip row flips nothing', () => {
  it('the row resolver would mint a copy here, and a mute toggle must not be the edit that makes it', () => {
    const s = embeddedAnimationScene();
    const row = clipRowChannelId(EMBEDDED_CHILD, 'rotation');
    // The control: this row IS resolvable for a write — through the mint (copy-on-write).
    expect(resolveRowChannelForWrite(s, row)?.mintOps.length).toBeGreaterThan(0);
    expect(rowFlagToggleOps(s, row, 'mute')).toBeNull();
    expect(rowFlagToggleOps(s, row, 'solo')).toBeNull();
  });
});
