// A second bind on a character that already carries a motion — what actually
// happens (#918).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────
// `saveGeneratedMotion.ts` justified its central design decision — saving writes
// bytes and deliberately does NOT call `routeImportByExtension` — partly with a
// downstream safety net:
//
//   "...and attempt a second bind on a character that already carries this
//    motion — which #807 correctly refuses."
//
// Nothing refuses it. `BindMotionRefusal` is exactly
// `'no-character' | 'ambiguous' | 'no-bridge' | 'rejected'`
// (`src/app/asset/bindMotionToCharacter.ts:69`) and has no "already bound"
// variant; the only mention of a second bind anywhere in production was that
// comment. The claim was very likely true once and dissolved on purpose when
// #889 removed the eager bake — the defect is that the sentence stayed.
//
// The decision it defends is still right, on reasons that stand alone: calling
// the import road would parse the same motion twice and add a duplicate
// Skeleton + AnimationClip. But a comment promising a refusal is worse than one
// that says nothing, because the next change can lean on the net and get silence
// instead. This is the sixth time in this codebase a comment has claimed an
// enforcement the code lacked, so the behaviour gets pinned rather than
// re-described.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IS ACTUALLY TRUE, AND IT IS WORTH KNOWING
// ─────────────────────────────────────────────────────────────────────────
// A second bind is ACCEPTED, and which clip drives a bone afterwards is decided
// by `clipIds.sort()` (`boundClipsForAsset.ts:86`) — so the winner is the
// id-sorted-FIRST clip, NOT the one bound most recently. Binding a second motion
// can therefore leave the first one driving the rig, which is not what "I just
// dropped this on the character" leads anyone to expect.
//
// REF: src/app/animate/boundClipsForAsset.ts (the sort that decides it);
//      src/app/asset/bindMotionToCharacter.ts (the refusal set that does not
//      include this case); src/app/asset/saveGeneratedMotion.ts (the comment
//      that claimed otherwise); issues #918, #889, #807.
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { gltfChildDagId, gltfSkeletonDagId } from '../../core/import/gltfImportChain';
import { boundClipsForAsset } from './boundClipsForAsset';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../bakedGltfChannels';

const ASSET = 'a';
const BONES = ['b0', 'b1'];
const SKEL = gltfSkeletonDagId(ASSET, 0);
const MAP = Object.fromEntries(BONES.map((n) => [n, gltfChildDagId(ASSET, n)]));
const RAD = (d: number) => (d * Math.PI) / 180;

/** Two keys per bone: rest at t=0, `deg` about Y at t=2. The value at t=1 is
 *  therefore half of `deg`, which is what makes the winner readable. */
function kfs(deg: number) {
  return BONES.flatMap((_, bone) => [
    { bone, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone, time: 2, position: [0, 0, 0], rotation: [0, RAD(deg), 0] },
  ]);
}

/** A rig with two clips bound to it. `n_out_z` is bound FIRST and sorts LAST,
 *  so bind order and id order disagree — which is the only way to tell which of
 *  the two actually decides. */
function twoClipsBound(): DagState {
  let s: DagState = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_asset',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      nodeNameMap: MAP,
      childHierarchy: {},
      skins: [
        {
          jointKeys: BONES,
          bindTRS: BONES.map(() => ({
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          })),
          parentJointIndex: [-1, 0],
          inverseBindMatrices: [],
        },
      ],
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
  for (const [id, deg] of [
    ['n_out_z', 90],
    ['n_out_a', -140],
  ] as const) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: id,
      nodeType: 'AnimationClip',
      params: { name: id, duration: 2, keyframes: kfs(deg) },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: SKEL, socket: 'out' },
      to: { node: id, socket: 'skeleton' },
    }).next;
  }
  return s;
}

describe('a second bind on an already-bound character (#918)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('is ACCEPTED — nothing refuses it, whatever the comments used to say', () => {
    const bound = boundClipsForAsset(twoClipsBound().nodes, ASSET);
    expect(bound).toHaveLength(2);
    expect(bound.map((b) => b.clipId).sort()).toEqual(['n_out_a', 'n_out_z']);
  });

  it('lets the id-sorted-FIRST clip drive the bone, not the one bound last', () => {
    // `n_out_z` was bound first and carries +90° at t=2, so it reads +45 at t=1.
    // `n_out_a` was bound second and carries -140°, reading -70. The bone reads
    // -70: the later bind wins here only because its id sorts first, and a rename
    // would silently swap which motion the rig performs.
    const s = twoClipsBound();
    const samplers = bakedChannelSamplersForAsset(s.nodes, MAP, ASSET);
    const y = sampleBakedChannel(samplers['b0'], 1)?.rotation?.[1];
    expect(y).toBeCloseTo(-70, 6);

    // Stated as the rule rather than the number, so this reds if the sort goes.
    const bound = boundClipsForAsset(s.nodes, ASSET);
    expect(bound[0].clipId).toBe('n_out_a');
  });
});
