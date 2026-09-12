// #1001 — the cook affordance must NAME the bones its own gesture strands.
//
// `clipSeedProvenance.test.ts` gates the read: which channels are behind the
// clip. This gates the WIRING, which is a separate claim and can be wrong on its
// own — a correct read that no surface consumes is a fact nobody is told, and it
// is green either way (#872's lesson, one domain over).
//
// The row that carries the file is the last one: after a re-cook the card says
// "Up to date" — true of the clip, false of the character — and the stranded
// list is the only thing on that card that is not lying.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { gltfChildDagId } from '../../core/import/gltfImportChain';
import { importedChildNodes } from '../../test-utils/importedChildFixture';
import { ensureChannelForBone } from '../animate/ensureChannelForBone';
import { motionCookOffer } from './cookMotionGenerations';
import { motionRequestHash, MotionGenerateParams } from '../../nodes/MotionGenerate';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const CHILD = gltfChildDagId(ASSET, BONE);
const PRODUCER = 'n_gen';
const PRODUCER_PARAMS = { name: '', prompt: 'a slow walk', seed: 7, model: 'kimodo-base' };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function key(bone: number, time: number, y: number) {
  return { bone, time, position: [0, y, 0], rotation: [0, 0, 0] };
}

/**
 * A character with a generated clip on it: producer → clip → rig → asset.
 *
 * The `source` edge is what makes the clip a generated one as far as
 * `clipBakeStates` is concerned; the `skeleton` edge is what makes it a bound
 * one as far as `boundClipsForAsset` is concerned. BOTH are needed here, and
 * that pair of edges is precisely the hop this file exists to prove.
 */
function characterWithGeneratedClip(keyframes: unknown[]): DagState {
  return {
    nodes: {
      n_asset: {
        id: 'n_asset',
        type: 'GltfAsset',
        params: { assetRef: ASSET, skins: [{ jointKeys: [OTHER, BONE] }] },
        inputs: {},
      },
      n_rig: {
        id: 'n_rig',
        type: 'GltfSkeleton',
        params: { skinIndex: 0 },
        inputs: { asset: { node: 'n_asset', socket: 'out' } },
      },
      [PRODUCER]: {
        id: PRODUCER,
        type: 'MotionGenerate',
        // Spelled in full because this table is hand-built rather than parsed:
        // `MotionGenerate.evaluate` reads `params.name` directly, and an absent
        // one throws inside the offer rather than reporting anything.
        params: PRODUCER_PARAMS,
        inputs: {},
      },
      n_clip: {
        id: 'n_clip',
        type: 'AnimationClip',
        // The producer's OWN current request hash — so the clip reads as cooked
        // and up to date, which is the state the last row needs: everything the
        // card knows about says fine, and the character is playing two motions.
        params: {
          duration: 1,
          loop: 'hold',
          keyframes,
          sourceHash: motionRequestHash(MotionGenerateParams.parse(PRODUCER_PARAMS), undefined),
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

/** A director edits the bone: the mint fires and its ops land. */
function editBone(state: DagState): DagState {
  const out = ensureChannelForBone(state, CHILD, 'position');
  expect(out).not.toBeNull();
  let next = state;
  for (const op of out!.ops) next = applyOp(next, op as Op).next;
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

describe('#1001 — the cook affordance names the bones it stranded', () => {
  it('says nothing when no bone has been edited', () => {
    // The ordinary project, and it must stay silent there or the signal becomes
    // the alarm on a healthy bind that a director learns to scan past (#923).
    const s = characterWithGeneratedClip([key(1, 0, 1), key(1, 1, 2)]);
    expect(motionCookOffer(s, PRODUCER).stranded).toEqual([]);
  });

  it('says nothing when a bone is edited and the clip has not moved', () => {
    const s = editBone(characterWithGeneratedClip([key(1, 0, 1), key(1, 1, 2)]));
    expect(motionCookOffer(s, PRODUCER).stranded).toEqual([]);
  });

  it('🔴 names the edited bone once the clip is re-cooked under it', () => {
    const edited = editBone(characterWithGeneratedClip([key(1, 0, 1), key(1, 1, 2)]));
    const offer = motionCookOffer(recook(edited, [key(1, 0, 1), key(1, 1, 99)]), PRODUCER);
    expect(offer.stranded.map((b) => b.childName)).toEqual([BONE]);
  });

  it('🔴 reports it even while the card reads "Up to date" — the lying label', () => {
    // The clip IS up to date; the character is not. Without this line the one
    // surface a director is looking at, at the exact moment the damage is done,
    // tells them everything is fine.
    const edited = editBone(characterWithGeneratedClip([key(1, 0, 1), key(1, 1, 2)]));
    const after = recook(edited, [key(1, 0, 1), key(1, 1, 99)]);
    const offer = motionCookOffer(after, PRODUCER);
    expect(offer.stale).toBe(false);
    expect(offer.label).toBe('Up to date');
    expect(offer.stranded.map((b) => b.childName)).toEqual([BONE]);
  });
});
