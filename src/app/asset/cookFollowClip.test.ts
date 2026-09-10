// #1002 — the act behind #1001's signal, and the two shapes that lost to it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ACT IS DESTRUCTIVE, MEASURED RATHER THAN ARGUED
// ─────────────────────────────────────────────────────────────────────────────
// #1001 made a stranded bone visible; a director reading its name had nothing to
// press. The obvious kind alternative — "re-seed the bone but keep the offset
// the director authored" — lost twice, and both losses are rows in this file so
// that a future attempt reds instead of shipping:
//
//   1. IT IS NOT CONSTRUCTIBLE. The mint records the seed as a HASH, not as
//      content. Measured: after a re-cook, a scan of every array on every node
//      finds a track hashing to the recorded provenance 0 times — against a
//      positive control that finds it 1 time before the cook. `staleTrackIsGone`
//      below is that scan. FALSIFIED, and the first falsifier was too weak: it
//      stays GREEN when the seed keys are merely handed to the mint, because the
//      node schema drops a param it does not declare. It reds once `sourceKeys`
//      is added to `KeyframeChannelVec3`'s schema AND stamped — which is the
//      right trigger, because the schema field is what makes the delta shape
//      takeable, and that is the moment these numbers have to be read again.
//
//   2. IT WOULD BE WRONG EVEN THEN. A delta assumes the edit meant "above
//      whatever the clip does". The keys cannot say whether it did. Measured on
//      two real cooks of one character: for a director who FLATTENED a curve to
//      hold a pose — an authored range of 0.0° — the delta shape returns a track
//      carrying 26.96° of motion, more than either clip had (23.27° and 14.38°),
//      because it is the difference of two motions and nobody authored that.
//      `followsTheClipExactly` is that row: after the act the bone resolves to
//      the clip's own value, and any delta implementation fails it by
//      construction.
//
// This is the same indistinguishability the provenance itself exists for, one
// level up: a copy cannot say whether it was edited, and an edit cannot say
// whether it meant "above the clip" or "here".
//
// REF: src/app/animate/dispatchMutator.ts (`dispatchFollowClip`);
//      src/app/asset/cookMotionGenerations.ts (`motionCookOffer.stranded`);
//      src/app/asset/cookStrandedBones.test.ts (the signal this acts on);
//      issues #1002, #1001, #909, #121.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { gltfChildDagId, gltfChannelDagId } from '../../core/import/gltfImportChain';
import { importedChildNodes } from '../../test-utils/importedChildFixture';
import { ensureChannelForBone } from '../animate/ensureChannelForBone';
import { seedTrackHash } from '../animate/clipSeedProvenance';
import { radVec3ToDeg } from '../../viewport/rotation';
import { dispatchFollowClip } from '../animate/dispatchMutator';
import { motionCookOffer } from './cookMotionGenerations';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../bakedGltfChannels';
import { motionRequestHash, MotionGenerateParams } from '../../nodes/MotionGenerate';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const CHILD = gltfChildDagId(ASSET, BONE);
const PRODUCER = 'n_gen';
const PP = { name: '', prompt: 'a slow walk', seed: 7, model: 'kimodo-base' };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** One clip keyframe for bone 1, with both bands stated so a re-cook can move
 *  exactly one of them. `rotation` is RADIANS, the unit a clip stores. */
function key(time: number, y: number, rx: number) {
  return { bone: 1, time, position: [0, y, 0], rotation: [rx, 0, 0] };
}

function character(keyframes: unknown[]): DagState {
  return {
    nodes: {
      n_asset: {
        id: 'n_asset',
        type: 'GltfAsset',
        params: {
          assetRef: ASSET,
          skins: [{ jointKeys: [OTHER, BONE] }],
          // The renderer's own band reads this map, so the observation below is
          // the read the viewport makes rather than a parallel one.
          nodeNameMap: { [BONE]: CHILD },
        },
        inputs: {},
      },
      n_rig: {
        id: 'n_rig',
        type: 'GltfSkeleton',
        params: { skinIndex: 0 },
        inputs: { asset: { node: 'n_asset', socket: 'out' } },
      },
      [PRODUCER]: { id: PRODUCER, type: 'MotionGenerate', params: PP, inputs: {} },
      n_clip: {
        id: 'n_clip',
        type: 'AnimationClip',
        params: {
          duration: 1,
          loop: 'hold',
          keyframes,
          sourceHash: motionRequestHash(MotionGenerateParams.parse(PP), undefined),
        },
        inputs: {
          skeleton: { node: 'n_rig', socket: 'out' },
          source: { node: PRODUCER, socket: 'out' },
        },
      },
      ...importedChildNodes(CHILD, {
        assetRef: ASSET,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      }),
    },
    outputs: {},
  } as unknown as DagState;
}

/** The director edits both bands of the bone: two mints, both stamped. */
function editBoth(state: DagState): DagState {
  let next = state;
  for (const component of ['position', 'rotation'] as const) {
    const out = ensureChannelForBone(next, CHILD, component);
    expect(out).not.toBeNull();
    for (const op of out!.ops) next = applyOp(next, op as Op).next;
  }
  return next;
}

/** The cook lands new keys on the same clip node — the re-cook shape. */
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

const BEFORE = [key(0, 1, 0.1), key(1, 2, 0.2)];
/** 🔴 POSITION BYTE-IDENTICAL, ROTATION MOVED — and that is the ORDINARY case,
 *  not a contrivance. Measured over two real cooks of one 78-bone character: 77
 *  bones of 78 carry a CONSTANT position track (a retarget writes bind position
 *  for everything but the root), and 9 came back position-unchanged with their
 *  rotation moved. */
const AFTER = [key(0, 1, 0.9), key(1, 2, 0.8)];

/** The state a director is actually looking at: bone edited, clip re-cooked. */
function stranded(): DagState {
  return recook(editBoth(character(BEFORE)), AFTER);
}

/** What the RENDERER resolves for the bone, through its own band. */
function rendererRotation(state: DagState, seconds: number): number[] | undefined {
  const samplers = bakedChannelSamplersForAsset(state.nodes as never, { [BONE]: CHILD }, ASSET)[
    BONE
  ];
  return sampleBakedChannel(samplers, seconds)?.rotation as number[] | undefined;
}

describe('#1002 — the offer names an ADDRESS, not just a name', () => {
  it('offers only the STALE component, never the whole bone', () => {
    const offer = motionCookOffer(stranded(), PRODUCER);
    expect(offer.stranded.map((b) => b.childName)).toEqual([BONE]);
    // 🔴 THE LOSING ALTERNATIVE IS THE WHOLE BONE, and it is in this row. The
    // position channel is `current` — the clip has not moved under it and the
    // director's edit is still driving — so an action that took the bone would
    // discard a live edit nobody was warned about.
    expect(offer.stranded[0].targets).toEqual([{ assetRef: ASSET, component: 'rotation' }]);
  });

  it('says nothing at all when the re-cook moved neither band', () => {
    const quiet = recook(editBoth(character(BEFORE)), BEFORE);
    expect(motionCookOffer(quiet, PRODUCER).stranded).toEqual([]);
  });
});

describe('#1002 — the act', () => {
  it('removes the stale channel and LEAVES the current one', () => {
    useDagStore.getState().hydrate(stranded());
    const offer = motionCookOffer(useDagStore.getState().state, PRODUCER);
    const bone = offer.stranded[0];

    expect(
      dispatchFollowClip(
        bone.targets.map((t) => ({ ...t, childName: bone.childName })),
        'Discard edit',
      ),
    ).toEqual({ ok: true });

    const after = useDagStore.getState().state;
    expect(after.nodes[gltfChannelDagId(ASSET, BONE, 'rotation')]).toBeUndefined();
    // 🔴 THE ROW THE WHOLE-BONE SHAPE FAILS.
    expect(after.nodes[gltfChannelDagId(ASSET, BONE, 'position')]).toBeDefined();
  });

  it("🔴 followsTheClipExactly — the bone resolves to the CLIP's own value, not to a blend of it", () => {
    const before = stranded();
    // The edit is visible first, or the row below proves nothing: an assertion
    // that a bone matches the clip is trivially true for a bone that never left it.
    const edited = rendererRotation(before, 0);
    expect(edited).toBeDefined();

    useDagStore.getState().hydrate(before);
    const bone = motionCookOffer(before, PRODUCER).stranded[0];
    dispatchFollowClip(
      bone.targets.map((t) => ({ ...t, childName: bone.childName })),
      'Discard edit',
    );

    const after = rendererRotation(useDagStore.getState().state, 0);
    // The clip's own first rotation key, in the DEGREES the band reads.
    const clipDegrees = (0.9 * 180) / Math.PI;
    expect(after![0]).toBeCloseTo(clipDegrees, 6);
    // 🔴 AND IT MOVED. A delta implementation lands at clip + (edit − old seed),
    // which is this value only when the delta is zero — so this pair of
    // assertions is what a "keep the offset" shape fails.
    expect(after![0]).not.toBeCloseTo(edited![0], 6);
  });

  it('is ONE undo entry for one press, across EVERY channel the press covers', () => {
    // 🔴 TWO TARGETS, OR THE ROW CANNOT BITE. One press that dispatched per
    // channel would still leave a single entry when there is a single channel,
    // so a bone stranded in ONE band proves nothing about atomicity. This
    // re-cook moves BOTH bands, so the bone is stranded in both and the press
    // must still be one thing a director can undo.
    const both = recook(editBoth(character(BEFORE)), [key(0, 7, 0.9), key(1, 8, 0.8)]);
    useDagStore.getState().hydrate(both);
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const bone = motionCookOffer(both, PRODUCER).stranded[0];
    expect(bone.targets.map((t) => t.component).sort()).toEqual(['position', 'rotation']);

    dispatchFollowClip(
      bone.targets.map((t) => ({ ...t, childName: bone.childName })),
      'Discard edit',
    );
    const after = useDagStore.getState().state;
    expect(after.nodes[gltfChannelDagId(ASSET, BONE, 'position')]).toBeUndefined();
    expect(after.nodes[gltfChannelDagId(ASSET, BONE, 'rotation')]).toBeUndefined();

    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
  });

  it('clears the signal it was pressed from, and a second press is simply true', () => {
    useDagStore.getState().hydrate(stranded());
    const bone = motionCookOffer(useDagStore.getState().state, PRODUCER).stranded[0];
    const addresses = bone.targets.map((t) => ({ ...t, childName: bone.childName }));
    dispatchFollowClip(addresses, 'Discard edit');
    // The sentence a director just acted on is gone from the card.
    expect(motionCookOffer(useDagStore.getState().state, PRODUCER).stranded).toEqual([]);
    // Pressing again is not an error — the claim is simply already true.
    expect(dispatchFollowClip(addresses, 'Discard edit')).toEqual({ ok: true });
  });
});

describe('#1002 — the shape that could not be built', () => {
  it('🔴 staleTrackIsGone — after a re-cook the pre-cook track exists nowhere in the graph', () => {
    const before = editBoth(character(BEFORE));
    const chanId = gltfChannelDagId(ASSET, BONE, 'rotation');
    const recorded = (before.nodes[chanId].params as { sourceHash: string }).sourceHash;

    // THE SUBJECT STATE IS MINTED **AND EDITED**. Without the edit the channel's
    // own keys still ARE the seed and the scan finds it there — a match that
    // says nothing about a stranded bone, which is edited by definition.
    const keys = (before.nodes[chanId].params as { keyframes: { value: number[] }[] }).keyframes;
    const editedState = {
      ...before,
      nodes: {
        ...before.nodes,
        [chanId]: {
          ...before.nodes[chanId],
          params: {
            ...(before.nodes[chanId].params as object),
            keyframes: keys.map((k, i) => ({
              ...k,
              value: [k.value[0] + 5 + i, k.value[1], k.value[2]],
            })),
          },
        },
      },
    } as unknown as DagState;

    const scan = (state: DagState): number => {
      let found = 0;
      for (const node of Object.values(state.nodes)) {
        const params = node.params as Record<string, unknown> | undefined;
        if (!params) continue;
        for (const value of Object.values(params)) {
          if (!Array.isArray(value) || value.length === 0) continue;
          const rows = value as Record<string, unknown>[];
          // A clip's spelling (bone/time/rotation) and a channel's (time/value).
          // 🔴 CONVERTED, because a clip stores RADIANS and the recorded hash was
          // taken over DEGREES. Hashing the clip's raw numbers finds nothing
          // ANYWHERE — including before the re-cook — so the scan would report
          // "unrecoverable" without ever having been able to recover anything.
          // Caught by the positive control below, which is the only reason this
          // line is right.
          const asClip = rows
            .filter((r) => r && typeof r === 'object' && r.bone === 1)
            .map((r) => ({ time: r.time as number, value: radVec3ToDeg(r.rotation as never) }));
          const asChannel = rows
            .filter((r) => r && typeof r === 'object' && 'value' in r && 'time' in r)
            .map((r) => ({ time: r.time as number, value: r.value }));
          for (const track of [asClip, asChannel]) {
            if (track.length === 0) continue;
            if (seedTrackHash(track as never) === recorded) found += 1;
          }
        }
      }
      return found;
    };

    // POSITIVE CONTROL — the same scan BEFORE the re-cook finds the track in the
    // CLIP, which is where a delta implementation would have gone looking. A
    // zero here would mean the scan cannot recover anything at all, and the zero
    // below would say nothing about the re-cook.
    expect(scan(editedState)).toBeGreaterThan(0);
    expect(scan(recook(editedState, AFTER))).toBe(0);
  });
});
