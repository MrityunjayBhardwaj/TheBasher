// #1003 — one clip, TWO characters, one stranded NAME.
//
// `cookStrandedBones.test.ts` gates the per-COMPONENT half of the stranded list:
// a name stands for several components and an action taking the whole bone would
// discard a live edit. The per-CHARACTER half was stated in the source as the
// reason the shape is a LIST and proved nowhere, because it needs a `RetargetClip`
// whose params actually resolve — real source bones, real target bones, a bone map
// — and `boundClipsForAsset` drops a retarget that resolves to no keyframes.
//
// That is this file. A generated clip sits on character A directly and reaches
// character B through a retarget, which is exactly the arrangement
// `bindMotionToCharacter` builds. Both characters have the same bone edited. A
// re-cook strands it on both, and the card shows ONE name.
//
// 🔴 THE ROW THAT MATTERS IS THE LAST ONE: the losing alternative. An action driven
// by the deduplicated NAME — or by the first target under it — fixes one character
// and leaves the other warned with the same sentence still on the card. The list
// carries a whole address per target so that cannot happen, and the row reds if a
// target goes missing.
//
// REF: #1003, #1002, #1001; src/app/asset/cookMotionGenerations.ts
// (`strandedBonesForClip`), src/app/animate/boundClipsForAsset.ts
// (`riggedSkeletonsForClip`, which returns a SET and is the reason there are two).

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { gltfChildDagId } from '../../core/import/gltfImportChain';
import { importedChildNodes } from '../../test-utils/importedChildFixture';
import { ensureChannelForBone } from '../animate/ensureChannelForBone';
import { motionCookOffer } from './cookMotionGenerations';
import { channelSeedRows } from '../animate/clipSeedProvenance';
import { motionRequestHash, MotionGenerateParams } from '../../nodes/MotionGenerate';

const ASSET_A = 'user-imports/dwarf.glb';
const ASSET_B = 'user-imports/elf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const PRODUCER = 'n_gen';
const PRODUCER_PARAMS = { name: '', prompt: 'a slow walk', seed: 7, model: 'kimodo-base' };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/**
 * 🔴 THE KEY VARIES ROTATION, NOT POSITION, AND THAT IS THE DOMAIN TALKING. A
 * retarget transfers ROTATION; the target's positions come from its own bind
 * pose. A re-cook that moves only the source's positions therefore leaves the
 * retargeted clip byte-identical, character B never goes stale, and this file
 * would report one character while claiming to prove two. Measured on the way in.
 */
function key(bone: number, time: number, deg: number) {
  return { bone, time, position: [0, 0, 0], rotation: [0, deg, 0] };
}

/**
 * A skin whose projection is a real rig. The FULL shape is required, not just
 * `jointKeys`: `bonesOfSkeletonNode` projects a GltfSkeleton through
 * `projectGltfSkeleton`, and a retarget whose source or target bones come back
 * empty resolves to null — which would make the second character report NOTHING
 * and this whole file green for the wrong reason.
 */
const skin = () => ({
  jointKeys: [OTHER, BONE],
  bindTRS: [
    { position: [0, 1.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  ],
  parentJointIndex: [-1, 0],
  inverseBindMatrices: [],
});

function characterNodes(prefix: string, assetRef: string) {
  return {
    [`${prefix}_asset`]: {
      id: `${prefix}_asset`,
      type: 'GltfAsset',
      params: { assetRef, skins: [skin()] },
      inputs: {},
    },
    [`${prefix}_rig`]: {
      id: `${prefix}_rig`,
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: `${prefix}_asset`, socket: 'out' } },
    },
  };
}

/**
 * Two characters, one generated clip. A holds the clip on its own `skeleton`
 * edge; B is reached through a `RetargetClip` reading that same clip — the two
 * arrangements `riggedSkeletonsForClip` unions.
 */
function twoCharactersOneClip(keyframes: unknown[]): DagState {
  return {
    nodes: {
      ...characterNodes('a', ASSET_A),
      ...characterNodes('b', ASSET_B),
      [PRODUCER]: { id: PRODUCER, type: 'MotionGenerate', params: PRODUCER_PARAMS, inputs: {} },
      n_clip: {
        id: 'n_clip',
        type: 'AnimationClip',
        params: {
          duration: 1,
          loop: 'hold',
          keyframes,
          sourceHash: motionRequestHash(MotionGenerateParams.parse(PRODUCER_PARAMS), undefined),
        },
        inputs: {
          skeleton: { node: 'a_rig', socket: 'out' },
          source: { node: PRODUCER, socket: 'out' },
        },
      },
      // Identity map: two characters on the same rig convention, which is the
      // ordinary case and keeps the stranded NAME the same on both sides — the
      // whole point being that one name covers two characters.
      n_map: {
        id: 'n_map',
        type: 'BoneNameMap',
        params: { name: 'bridge', map: { [OTHER]: OTHER, [BONE]: BONE } },
        inputs: {},
      },
      n_retarget: {
        id: 'n_retarget',
        type: 'RetargetClip',
        params: { name: '' },
        inputs: {
          sourceClip: { node: 'n_clip', socket: 'out' },
          boneMap: { node: 'n_map', socket: 'out' },
          skeleton: { node: 'b_rig', socket: 'out' },
        },
      },
      ...importedChildNodes(gltfChildDagId(ASSET_A, BONE), {
        assetRef: ASSET_A,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      }),
      ...importedChildNodes(gltfChildDagId(ASSET_B, BONE), {
        assetRef: ASSET_B,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      }),
    },
    outputs: {},
  } as unknown as DagState;
}

function editBone(state: DagState, assetRef: string): DagState {
  const out = ensureChannelForBone(state, gltfChildDagId(assetRef, BONE), 'rotation');
  expect(
    out,
    `nothing to mint for ${assetRef} — the fixture is not what this row assumes`,
  ).not.toBeNull();
  let next = state;
  for (const op of out!.ops) next = applyOp(next, op as Op).next;
  return next;
}

function recook(state: DagState, keyframes: unknown[]): DagState {
  return {
    ...state,
    nodes: {
      ...state.nodes,
      n_clip: {
        ...state.nodes.n_clip,
        params: { ...(state.nodes.n_clip.params as object), keyframes },
      },
    },
  } as unknown as DagState;
}

describe('#1003 — a clip stranding one bone on two characters', () => {
  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. If the retarget does not
  // resolve, character B contributes nothing and every row below would pass for
  // the wrong reason — the exact shape that made this claim ungatable before.
  it('the fixture actually reaches BOTH characters', () => {
    let s = twoCharactersOneClip([key(1, 0, 0), key(1, 1, 5)]);
    s = editBone(s, ASSET_A);
    s = editBone(s, ASSET_B);
    s = recook(s, [key(1, 0, 50), key(1, 1, 90)]);
    const refs = new Set(
      motionCookOffer(s, PRODUCER).stranded.flatMap((b) => b.targets.map((t) => t.assetRef)),
    );
    expect([...refs].sort()).toEqual([ASSET_A, ASSET_B]);
  });

  it('reports ONE name carrying a target on each character', () => {
    let s = twoCharactersOneClip([key(1, 0, 0), key(1, 1, 5)]);
    s = editBone(s, ASSET_A);
    s = editBone(s, ASSET_B);
    s = recook(s, [key(1, 0, 50), key(1, 1, 90)]);

    const stranded = motionCookOffer(s, PRODUCER).stranded;
    // One NAME — a director reading the card sees the bone once, not twice.
    expect(stranded.map((b) => b.childName)).toEqual([BONE]);
    // …and two ADDRESSES under it, which is what an action needs.
    const targets = stranded[0].targets;
    expect(new Set(targets.map((t) => t.assetRef))).toEqual(new Set([ASSET_A, ASSET_B]));
    for (const t of targets) expect(t.childName).toBe(BONE);
  });

  // THE LOSING ALTERNATIVE. An action driven by the name, or by the first target
  // under it, clears one character and leaves the other warned by the same
  // sentence. This row states that in the only form that can red: acting on a
  // strict subset of the targets leaves an assetRef behind.
  it('acting on the first target only would leave the other character warned', () => {
    let s = twoCharactersOneClip([key(1, 0, 0), key(1, 1, 5)]);
    s = editBone(s, ASSET_A);
    s = editBone(s, ASSET_B);
    s = recook(s, [key(1, 0, 50), key(1, 1, 90)]);

    const targets = motionCookOffer(s, PRODUCER).stranded[0].targets;
    const all = new Set(targets.map((t) => t.assetRef));
    const firstOnly = new Set([targets[0].assetRef]);
    expect(firstOnly.size).toBeLessThan(all.size);
    expect([...all].filter((r) => !firstOnly.has(r))).toHaveLength(all.size - 1);
  });

  it('CONTROL: with the second character unedited, only the first is named', () => {
    let s = twoCharactersOneClip([key(1, 0, 0), key(1, 1, 5)]);
    s = editBone(s, ASSET_A);
    s = recook(s, [key(1, 0, 50), key(1, 1, 90)]);
    const refs = new Set(
      motionCookOffer(s, PRODUCER).stranded.flatMap((b) => b.targets.map((t) => t.assetRef)),
    );
    expect([...refs]).toEqual([ASSET_A]);
  });
});

// ---------------------------------------------------------------------------
// #1004 — one act over the whole list, and the one thing it must never reach
// ---------------------------------------------------------------------------

/**
 * A single character whose bone has BOTH components edited, where the re-cook
 * moves only the rotation. That asymmetry is the ordinary case, not a contrived
 * one: measured over two real cooks, 77 of 78 bones carry a constant position
 * track, so their position channels stay `current` while their rotation goes
 * stale — and a bulk act that took the whole bone would throw away a live edit.
 */
function oneCharacterBothComponents(keyframes: unknown[]): DagState {
  return {
    nodes: {
      ...characterNodes('a', ASSET_A),
      [PRODUCER]: { id: PRODUCER, type: 'MotionGenerate', params: PRODUCER_PARAMS, inputs: {} },
      n_clip: {
        id: 'n_clip',
        type: 'AnimationClip',
        params: {
          duration: 1,
          loop: 'hold',
          keyframes,
          sourceHash: motionRequestHash(MotionGenerateParams.parse(PRODUCER_PARAMS), undefined),
        },
        inputs: {
          skeleton: { node: 'a_rig', socket: 'out' },
          source: { node: PRODUCER, socket: 'out' },
        },
      },
      ...importedChildNodes(gltfChildDagId(ASSET_A, BONE), {
        assetRef: ASSET_A,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      }),
      ...importedChildNodes(gltfChildDagId(ASSET_A, OTHER), {
        assetRef: ASSET_A,
        childName: OTHER,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      }),
    },
    outputs: {},
  } as unknown as DagState;
}

function mint(state: DagState, childName: string, component: 'position' | 'rotation'): DagState {
  const out = ensureChannelForBone(state, gltfChildDagId(ASSET_A, childName), component);
  expect(out, `nothing to mint for ${childName}/${component}`).not.toBeNull();
  let next = state;
  for (const op of out!.ops) next = applyOp(next, op as Op).next;
  return next;
}

describe('#1004 — one act over the whole stranded list', () => {
  it('the bulk set is exactly the union of the per-row sets', () => {
    let s = oneCharacterBothComponents([key(0, 0, 0), key(1, 0, 0), key(1, 1, 5)]);
    s = mint(s, BONE, 'rotation');
    s = mint(s, OTHER, 'rotation');
    s = recook(s, [key(0, 0, 30), key(1, 0, 50), key(1, 1, 90)]);

    const stranded = motionCookOffer(s, PRODUCER).stranded;
    expect(stranded.length).toBeGreaterThan(1); // or the button does not render
    const bulk = stranded.flatMap((b) => b.targets);
    const perRow = stranded.map((b) => b.targets).flat();
    expect(bulk).toEqual(perRow);
  });

  // 🔴 THE ROW THAT CARRIES THIS SECTION. `Clear baked motion` takes the whole
  // baked band; this act must take only what the card listed. The discriminating
  // fixture is a bone whose POSITION is still current while its ROTATION went
  // stale — take the bone and a live edit dies with it.
  it('the bulk act does not reach a channel that is still current', () => {
    let s = oneCharacterBothComponents([key(0, 0, 0), key(1, 0, 0), key(1, 1, 5)]);
    s = mint(s, BONE, 'rotation');
    s = mint(s, BONE, 'position');
    s = recook(s, [key(0, 0, 30), key(1, 0, 50), key(1, 1, 90)]);

    // The fixture exhibits the asymmetry, asserted rather than assumed — without
    // it the row cannot fail and would pass on any implementation.
    const rows = channelSeedRows(s, ASSET_A).filter((r) => r.childName === BONE);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['stale', 'current']));

    const bulk = motionCookOffer(s, PRODUCER).stranded.flatMap((b) => b.targets);
    expect(bulk.every((t) => t.component === 'rotation')).toBe(true);
    expect(bulk.some((t) => t.component === 'position')).toBe(false);
  });
});
