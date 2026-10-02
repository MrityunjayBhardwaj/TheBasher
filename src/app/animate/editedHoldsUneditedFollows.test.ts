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
// establish that a clip really can change under a live band.
//
// 🔶 THE CONSEQUENCE BLOCK RETIRED WITH THE CLONE ROAD'S CHARACTER HALF (#1053). It measured the
// clone band, which drew a clip bound to a `GltfSkeleton`; nothing draws that now. On a native
// character the same two halves are pinned where they now live —
// `src/app/asset/poseNativeBone.test.ts` ("rebinding a motion keeps the pose"): the bone nobody
// posed plays the new motion, and the posed one keeps its pose, both read off the deformed skin.
//
// REF: issues #877, #887, #888, #889; app/resolveGltfChildTransform.ts (gone in #1053; at 7e1356c7)
//      (the band ladder — presence wins, never value-equality);
//      app/animate/ensureChannelForBone.ts (gone in #1053; at 15c170c4) (the mint, retired with the clone road);
//      src/agent/tools/dagExec.ts (the universal mutation surface, an agent
//      tool, which is what makes ROAD B reachable in this product).

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { gltfChildDagId, gltfSkeletonDagId } from '../../core/import/gltfImportChain';
import type { GltfSkinMetadata } from '../../nodes/types';
import { quatFromEulerXYZ } from '../../nodes/bonePose';
import { importedChildOps } from '../../test-utils/importedChildFixture';

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
function posesTo(endDeg: number) {
  const at = (time: number, deg: number) => ({
    time,
    bones: Object.fromEntries(
      BONES.map((name) => [
        name,
        { position: [0, 0, 0], quaternion: quatFromEulerXYZ([0, RAD(deg), 0]) },
      ]),
    ),
  });
  return [at(0, 0), at(2, endDeg)];
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
    params: { name: 'walk', duration: 2, poses: posesTo(endDeg) },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: SKEL, socket: 'out' },
    to: { node: CLIP, socket: 'skeleton' },
  }).next;
  for (const name of BONES) {
    for (const op of importedChildOps(gltfChildDagId(ASSET, name), {
      assetRef: ASSET,
      childName: name,
    })) {
      s = applyOp(s, op as Op).next;
    }
  }
  return s;
}

function fresh(endDeg = 90): DagState {
  __resetRegistryForTests();
  registerAllNodes();
  return build(endDeg);
}

/** ROAD B, the open one: rewrite the clip's poses under the live band. */
function changeClipTo(state: DagState, endDeg: number): DagState {
  return applyOp(state, {
    type: 'setParam',
    nodeId: CLIP,
    paramPath: 'poses',
    value: posesTo(endDeg),
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
        params: { name: 'walk', duration: 2, poses: posesTo(999) },
      }),
    ).toThrow();
  });

  it('ROAD B is OPEN — setParam on the clip poses is silently accepted, with no guard at the op layer', () => {
    const s = changeClipTo(fresh(), -140);
    const poses = (
      s.nodes[CLIP].params as { poses: { bones: Record<string, { quaternion: number[] }> }[] }
    ).poses;
    // Accepted, and the new value is really there. No mutator reaches this —
    // every keyframe mutator gates on a `KeyframeChannel*` node type — but
    // `dag.exec` takes raw setParam on any node and is an agent tool.
    expect(poses[1].bones[FOLLOWS].quaternion).toEqual(quatFromEulerXYZ([0, RAD(-140), 0]));
  });

  it('ROAD C is OPEN — the clip can be removed while any authored channel survives', () => {
    const s = applyOp(fresh(), { type: 'removeNode', nodeId: CLIP } as never).next;
    expect(CLIP in s.nodes).toBe(false);
  });
});
