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

/** A rig with two clips bound to it, in BIND order: `n_out_z` first, then
 *  `n_out_a`. Their ids sort the other way round, so bind order and id order
 *  disagree — which is the only way to tell which of the two actually decides.
 *
 *  `activeId` marks the clip a bind would have stood up (#907). Omitted, the
 *  graph is exactly what a project saved before #907 looks like: no clip is
 *  active, so the walk must fall back to the id order it always used. */
function twoClipsBound(
  activeId?: string,
  order: readonly string[] = ['n_out_z', 'n_out_a'],
): DagState {
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
  const DEG: Record<string, number> = { n_out_z: 90, n_out_a: -140 };
  for (const id of order) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: id,
      nodeType: 'AnimationClip',
      params: {
        name: id,
        duration: 2,
        keyframes: kfs(DEG[id]),
        ...(activeId === id ? { active: true } : {}),
      },
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

  it('with NO active clip, the id order still decides — a saved project is unchanged', () => {
    // Every project saved before #907 looks like this. The active flag refines
    // the sort rather than replacing it, so with nothing active the answer is
    // byte-identical to what it has always been. Without this row the fix could
    // silently change what existing work does.
    const s = twoClipsBound();
    const samplers = bakedChannelSamplersForAsset(s.nodes, MAP, ASSET);
    expect(sampleBakedChannel(samplers['b0'], 1)?.rotation?.[1]).toBeCloseTo(-70, 6);
    expect(boundClipsForAsset(s.nodes, ASSET)[0].clipId).toBe('n_out_a');
  });

  // ── #907: THE PAIR THAT CARRIES THE CLAIM ────────────────────────────────
  // Either row ALONE passes against the old id-sort by accident, for opposite
  // reasons. Only together do they say "the LAST BIND decides", independent of
  // what the files happen to be called.
  describe('#907 — the last bind wins, whatever the ids sort like', () => {
    it('when the last-bound clip also sorts FIRST', () => {
      // Bound second AND sorts first. The old id-sort agreed here by luck.
      const s = twoClipsBound('n_out_a');
      const samplers = bakedChannelSamplersForAsset(s.nodes, MAP, ASSET);
      expect(sampleBakedChannel(samplers['b0'], 1)?.rotation?.[1]).toBeCloseTo(-70, 6);
      expect(boundClipsForAsset(s.nodes, ASSET)[0].clipId).toBe('n_out_a');
    });

    it('when the last-bound clip sorts LAST — the case the id order got wrong', () => {
      // Bind order reversed: `n_out_a` first, then `n_out_z`. The active clip
      // now sorts SECOND, so the old behaviour would hand the bone to
      // `n_out_a` (-70). It must read +45.
      const s = twoClipsBound('n_out_z', ['n_out_a', 'n_out_z']);
      const samplers = bakedChannelSamplersForAsset(s.nodes, MAP, ASSET);
      expect(sampleBakedChannel(samplers['b0'], 1)?.rotation?.[1]).toBeCloseTo(45, 6);
      expect(boundClipsForAsset(s.nodes, ASSET)[0].clipId).toBe('n_out_z');
    });

    it('the predecessor is DEACTIVATED, not destroyed — it is still there to go back to', () => {
      // The reference stashes the previous action onto a muted track rather than
      // discarding it: "unmute it again or delete it". A director may well want
      // two clips on a rig; what they could not do was say which one plays.
      const s = twoClipsBound('n_out_z', ['n_out_a', 'n_out_z']);
      const bound = boundClipsForAsset(s.nodes, ASSET);
      expect(bound).toHaveLength(2);
      expect(bound.map((b) => b.clipId)).toEqual(['n_out_z', 'n_out_a']);
      // ...and the stood-down clip keeps every one of its keys.
      expect(s.nodes['n_out_a'].params).toHaveProperty('keyframes');
      expect((s.nodes['n_out_a'].params as { keyframes: unknown[] }).keyframes).toHaveLength(4);
    });
  });
});
