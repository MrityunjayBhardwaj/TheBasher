// The whole claim of the copy-on-write band, in one file: an EDITED bone holds
// its edit, an UNEDITED bone follows the clip (#889, inverting #887).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE USED TO SAY, AND WHY IT SAYS THE OPPOSITE NOW
// ─────────────────────────────────────────────────────────────────────────
// It was a CHARACTERISATION test: it asserted a defect on purpose. A baked
// channel outranked the clip it was copied from, nothing revisited the copy when
// the clip changed, and every bone had a copy — because `bakeClipOntoRig` baked
// the whole rig at bind time. So a clip edit rendered a stale value on all 23
// bones and nothing reported it.
//
// #889 slice 3 deleted that eager bake. The precedence rule did NOT change —
// presence still wins, per component — but WHAT IS PRESENT did: a channel now
// exists only where a director made one. The same mechanical fact ("the copy
// beats the clip") stops being staleness and becomes AUTHORSHIP, because the
// only copies left are authored.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 BOTH HALVES, OR THE TEST IS WORTHLESS
// ─────────────────────────────────────────────────────────────────────────
// A change that made EVERYTHING follow the clip — losing every edit — would
// satisfy a test that only checked the followers. A change that made everything
// hold would satisfy one that only checked the holder. So one scene carries both
// bones, one edited and one not, and the clip is changed underneath BOTH.
//
// The three ROAD tests below are unchanged and still describe the op layer: they
// establish that a clip really can change under a live band. What changed is the
// CONSEQUENCE, which is what the second describe block measures.
//
// REF: issues #877, #887, #888, #889; src/app/resolveGltfChildTransform.ts
//      (the band ladder — presence wins, never value-equality);
//      src/app/animate/ensureChannelForBone.ts (the mint, and its seed);
//      src/agent/tools/dagExec.ts (the universal mutation surface, an agent
//      tool, which is what makes ROAD B reachable in this product).

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import {
  gltfChildDagId,
  gltfSkeletonDagId,
  gltfChannelDagId,
} from '../../core/import/gltfImportChain';
import { ensureChannelForBone } from './ensureChannelForBone';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../bakedGltfChannels';
import type { GltfSkinMetadata } from '../../nodes/types';

const ASSET = 'asset-copy-on-write';
const HELD = 'bone_held'; // index 0 — the bone a director edits
const FOLLOWS = 'bone_follows'; // index 1 — the bone nobody touches
const BONES = [HELD, FOLLOWS];
const SKEL = gltfSkeletonDagId(ASSET, 0);
const CLIP = 'n_clip_0';

/** Radians in the clip; the band converts to the degrees a channel stores. */
const RAD = (deg: number) => (deg * Math.PI) / 180;

function skin(): GltfSkinMetadata {
  return {
    jointKeys: BONES,
    bindTRS: BONES.map(() => ({
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    parentJointIndex: BONES.map((_, i) => (i === 0 ? -1 : 0)),
    inverseBindMatrices: [],
  };
}

const NODE_NAME_MAP = Object.fromEntries(BONES.map((n) => [n, gltfChildDagId(ASSET, n)]));

/** Both bones rotate 0° → `endDeg` about Y over 2s. */
function keyframesTo(endDeg: number) {
  return BONES.flatMap((_, bone) => [
    { bone, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone, time: 2, position: [0, 0, 0], rotation: [0, RAD(endDeg), 0] },
  ]);
}

/** A character whose rig is driven by ONE bound AnimationClip, and no channels. */
function build(endDeg: number): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_asset',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      nodeNameMap: NODE_NAME_MAP,
      childHierarchy: {},
      skins: [skin()],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: SKEL,
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_asset', socket: 'out' },
    to: { node: SKEL, socket: 'asset' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: CLIP,
    nodeType: 'AnimationClip',
    params: { name: 'walk', duration: 2, keyframes: keyframesTo(endDeg) },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: SKEL, socket: 'out' },
    to: { node: CLIP, socket: 'skeleton' },
  }).next;
  for (const name of BONES) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(ASSET, name),
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: name,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
  }
  return s;
}

function fresh(endDeg = 90): DagState {
  __resetRegistryForTests();
  registerAllNodes();
  return build(endDeg);
}

/** The rendered Y rotation of one bone at `t`, through the band the renderer samples.
 *
 * 🔴 SAMPLED AT THE MIDPOINT, NEVER AT `t = duration`. The two roads disagree
 * exactly there and nowhere else: a bound clip LOOPS by default, so t=2 on a
 * 2s clip wraps to t=0, while a minted `KeyframeChannelVec3` clamps and holds
 * its last key. Comparing a follower against a holder at the boundary measures
 * that wrap rather than the precedence rule this file is about. */
function rotYAt(state: DagState, childName: string, t: number): number | undefined {
  const samplers = bakedChannelSamplersForAsset(state.nodes, NODE_NAME_MAP, ASSET);
  return sampleBakedChannel(samplers[childName], t)?.rotation?.[1];
}

/** ROAD B, the open one: rewrite the clip's keyframes under the live band. */
function changeClipTo(state: DagState, endDeg: number): DagState {
  return applyOp(state, {
    type: 'setParam',
    nodeId: CLIP,
    paramPath: 'keyframes',
    value: keyframesTo(endDeg),
  } as never).next;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#887 — the three roads that could change a clip under a live band', () => {
  it('ROAD A is CLOSED — re-adding the clip id throws, so a re-retarget cannot overwrite in place', () => {
    const s = fresh();
    // Deterministic ids mean a re-retarget reuses this id rather than minting a
    // new one. `ops.ts` refuses, which closes the road for reasons that have
    // nothing to do with staleness.
    expect(() =>
      applyOp(s, {
        type: 'addNode',
        nodeId: CLIP,
        nodeType: 'AnimationClip',
        params: { name: 'walk', duration: 2, keyframes: keyframesTo(999) },
      }),
    ).toThrow();
  });

  it('ROAD B is OPEN — setParam on the clip keyframes is silently accepted, with no guard at the op layer', () => {
    const s = changeClipTo(fresh(), -140);
    const kfs = (s.nodes[CLIP].params as { keyframes: { rotation: number[] }[] }).keyframes;
    // Accepted, and the new value is really there. No mutator reaches this —
    // every keyframe mutator gates on a `KeyframeChannel*` node type — but
    // `dag.exec` takes raw setParam on any node and is an agent tool.
    expect(kfs[1].rotation[1]).toBeCloseTo(RAD(-140), 10);
  });

  it('ROAD C is OPEN — the clip can be removed while any authored channel survives', () => {
    const s = applyOp(fresh(), { type: 'removeNode', nodeId: CLIP } as never).next;
    expect(CLIP in s.nodes).toBe(false);
  });
});

describe('#889 — what the band renders after the clip changes underneath it', () => {
  it('binds with ZERO channels, and both bones already follow the clip', () => {
    const s = fresh(90);
    expect(Object.values(s.nodes).filter((n) => n.type === 'KeyframeChannelVec3')).toHaveLength(0);
    // The clip alone drives both bones — this is what makes the eager copy
    // unnecessary rather than merely wasteful.
    expect(rotYAt(s, HELD, 1)).toBeCloseTo(45, 6);
    expect(rotYAt(s, FOLLOWS, 1)).toBeCloseTo(45, 6);
  });

  it('EDITED holds and UNEDITED follows — both halves, in one scene', () => {
    let s = fresh(90);

    // A director edits ONE bone. The mint is the real one, seeded from the clip
    // at this instant, so the edit starts from the motion rather than from zero.
    const minted = ensureChannelForBone(s, gltfChildDagId(ASSET, HELD), 'rotation');
    expect(minted).not.toBeNull();
    for (const op of minted!.ops) s = applyOp(s, op).next;
    expect(s.nodes[gltfChannelDagId(ASSET, HELD, 'rotation')]).toBeDefined();
    // ONE channel, for ONE bone, for ONE component. Not 46.
    expect(Object.values(s.nodes).filter((n) => n.type === 'KeyframeChannelVec3')).toHaveLength(1);

    // ROAD B: the clip now swings the other way, under both bones.
    s = changeClipTo(s, -140);

    // AUTHORSHIP: the edited bone keeps the motion it was minted with. Under the
    // eager bake this same fact was STALENESS — the difference is that this copy
    // exists because somebody made it, and 22 others no longer do.
    expect(rotYAt(s, HELD, 1)).toBeCloseTo(45, 6);
    // FOLLOWING: the untouched bone has no copy to go stale, so it moves.
    expect(rotYAt(s, FOLLOWS, 1)).toBeCloseTo(-70, 6);
  });
});
