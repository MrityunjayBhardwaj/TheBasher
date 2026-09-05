// #889 slice 1 — minting a bone's channel at the moment something authors on it.
//
// The claim under test is not "a node appears". It is that the minted node
// carries the CLIP'S OWN MOTION for that bone, in the band's units. A channel
// minted empty would look identical in every structural assertion and drop the
// bone to its base pose the instant a director touched it.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { ensureChannelForBone } from './ensureChannelForBone';
import type { DagState } from '../../core/dag/state';
import { buildVec3Sampler, type KeyframeChannelVec3Params } from '../../nodes/KeyframeChannelVec3';
import { buildClipBoneSamplers, type AnimationClipParams } from '../../nodes/AnimationClip';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The node shape a glTF import plus a retargeted clip leaves behind.
 *  `jointKeys` is the index→name spine the clip's bone indices are read by. */
function riggedState(opts?: {
  withClip?: boolean;
  /** #913 — the clip's own time domain. Defaults to the schema default. */
  loop?: boolean;
  extraNodes?: Record<string, unknown>;
}): DagState {
  const jointKeys = [OTHER, BONE];
  const nodes: Record<string, unknown> = {
    n_asset: {
      id: 'n_asset',
      type: 'GltfAsset',
      params: { assetRef: ASSET, skins: [{ jointKeys }] },
      inputs: {},
    },
    n_rig: {
      id: 'n_rig',
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: 'n_asset', socket: 'out' } },
    },
    [gltfChildDagId(ASSET, BONE)]: {
      id: gltfChildDagId(ASSET, BONE),
      type: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: BONE,
        // The base pose the import writes — rotation already in DEGREES.
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      },
      inputs: {},
    },
  };
  if (opts?.withClip !== false) {
    nodes.n_clip = {
      id: 'n_clip',
      type: 'AnimationClip',
      params: {
        duration: 1,
        loop: opts?.loop ?? true,
        keyframes: [
          // Bone 1 is BONE. Rotations are RADIANS in a clip.
          { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [0, 2, 0], rotation: [Math.PI / 2, 0, 0] },
          // Bone 0 belongs to another bone entirely and must not leak in.
          { bone: 0, time: 0, position: [9, 9, 9], rotation: [0, 0, 0] },
        ],
      },
      inputs: { skeleton: { node: 'n_rig', socket: 'out' } },
    };
  }
  Object.assign(nodes, opts?.extraNodes ?? {});
  return { nodes } as unknown as DagState;
}

describe('minting a channel for a bone', () => {
  it('mints one, addressed by the derived content id', () => {
    const out = ensureChannelForBone(riggedState(), gltfChildDagId(ASSET, BONE), 'rotation');
    expect(out).not.toBeNull();
    expect(out!.channelId).toBe(gltfChannelDagId(ASSET, BONE, 'rotation'));
    expect(out!.ops).toHaveLength(1);
    expect(out!.ops[0].type).toBe('addNode');
  });

  it('SEEDS from the clip — the minted track carries the bone’s motion', () => {
    // The row that matters. An empty mint passes every structural assertion
    // above and makes the bone snap to base the moment it is edited.
    const out = ensureChannelForBone(riggedState(), gltfChildDagId(ASSET, BONE), 'position')!;
    const params = (out.ops[0] as { params: { keyframes: { time: number; value: number[] }[] } })
      .params;
    expect(params.keyframes.map((k) => k.time)).toEqual([0, 1]);
    expect(params.keyframes.map((k) => k.value)).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ]);
  });

  it('converts rotation to DEGREES, the unit the band is in', () => {
    // Radians through unconverted scales every bone rotation by π/180: a
    // character stands still while its root position travels (#843).
    const out = ensureChannelForBone(riggedState(), gltfChildDagId(ASSET, BONE), 'rotation')!;
    const params = (out.ops[0] as { params: { keyframes: { value: number[] }[] } }).params;
    expect(params.keyframes[1].value[0]).toBeCloseTo(90, 4);
  });

  it('takes only THIS bone’s keys, never the whole clip’s', () => {
    const out = ensureChannelForBone(riggedState(), gltfChildDagId(ASSET, BONE), 'position')!;
    const params = (out.ops[0] as { params: { keyframes: { value: number[] }[] } }).params;
    // Bone 0's [9,9,9] belongs to another bone and must not appear.
    expect(JSON.stringify(params.keyframes)).not.toContain('9');
  });

  it('mints NOTHING when the channel already exists', () => {
    // WHERE THIS IS ENFORCED, measured rather than assumed: deleting the early
    // return in `ensureChannelForBone` leaves this row GREEN, because
    // `bakeChannelOpsForBone` skips a component whose node is already in state.
    // So this row pins the OBSERVABLE property — an existing channel produces no
    // ops — and does not claim to be guarding the early return, which is a fast
    // path. Re-seeding would overwrite a director's edit with the clip, the
    // exact opposite of what the band is for.
    const channelId = gltfChannelDagId(ASSET, BONE, 'rotation');
    const state = riggedState({
      extraNodes: {
        [channelId]: {
          id: channelId,
          type: 'KeyframeChannelVec3',
          params: { keys: [{ time: 0, value: [7, 7, 7] }] },
          inputs: {},
        },
      },
    });
    const out = ensureChannelForBone(state, gltfChildDagId(ASSET, BONE), 'rotation')!;
    expect(out.channelId).toBe(channelId);
    expect(out.ops).toEqual([]);
  });

  it('still mints when no clip is bound — an empty track, not a refusal', () => {
    // An asset with no retargeted clip has nothing to seed from, and the bone
    // was not moving before the edit either. The edit must still have somewhere
    // to land, or the first keyframe on an unanimated bone would refuse.
    const out = ensureChannelForBone(
      riggedState({ withClip: false }),
      gltfChildDagId(ASSET, BONE),
      'position',
    );
    expect(out).not.toBeNull();
    expect(out!.ops).toHaveLength(1);
    // Seeded from the bone's BASE, not left empty: an empty channel samples to
    // [0,0,0] at every time and suppresses the pose underneath it, so the bone
    // would snap to the origin the instant it was first touched.
    const kf = (out!.ops[0] as { params: { keyframes: { value: number[] }[] } }).params.keyframes;
    expect(kf).toHaveLength(1);
    expect(kf[0].value).toEqual([1, 2, 3]);
  });

  it('mints SCALE from the base — never from the clip, which carries none', () => {
    // The eager bake had to refuse scale outright: it minted every component for
    // every bone, so a scale channel nobody asked for would have suppressed the
    // asset's own scale track underneath it (the resolver reads presence, not
    // value). On demand that reverses — scale is minted ONLY when something
    // authors scale, and suppressing the track underneath is then the point of
    // the edit rather than a side effect of it.
    const out = ensureChannelForBone(riggedState(), gltfChildDagId(ASSET, BONE), 'scale')!;
    const kf = (out.ops[0] as { params: { keyframes: { value: number[] }[] } }).params.keyframes;
    expect(kf).toHaveLength(1);
    expect(kf[0].value).toEqual([1, 1, 1]);
  });

  it('returns null for something that is not a glTF bone', () => {
    // A spec error rather than a graph state — it should surface as a refusal,
    // not as a silent no-op that leaves the edit with nowhere to go.
    expect(ensureChannelForBone(riggedState(), 'n_rig', 'position')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #913 — the mint carries the SOURCE's time domain, not just its keys.
//
// A clip wraps past its duration; a channel's schema default is `hold`. Copying
// the keys without the domain makes an edited bone stop dead after one cycle
// while its unedited neighbours keep going.
// ─────────────────────────────────────────────────────────────────────────
describe('#913 the mint carries the clip time domain', () => {
  const D = 1; // the fixture clip's duration
  const boneId = gltfChildDagId(ASSET, BONE);

  /** The params the mint's addNode would create for `component`. */
  function mintedParams(state: DagState, component: 'position' | 'rotation') {
    const res = ensureChannelForBone(state, boneId, component);
    expect(res).not.toBeNull();
    const add = res!.ops.find(
      (o) => o.type === 'addNode' && o.nodeId === gltfChannelDagId(ASSET, BONE, component),
    ) as { params: KeyframeChannelVec3Params } | undefined;
    expect(add).toBeDefined();
    return add!.params;
  }

  it('a bone minted from a LOOPING clip travels instead of freezing OR teleporting', () => {
    const params = mintedParams(riggedState(), 'position');
    const sample = buildVec3Sampler(params);
    // The defect, stated as the director sees it: one duration later the bone is
    // moving on, not stuck where it stopped (#913) and not snapped back to where
    // it started (#924).
    //
    // INVERTED, NOT RELAXED: this row used to assert `sample(D + 0.25)` EQUALS
    // `sample(0.25)`, which is plain repeat. Position now cycles with offset, so
    // the correct statement is that it differs by exactly one period of travel.
    // The travel is read off the channel's own endpoints rather than written as a
    // literal, so the row states the RULE and not this fixture's arithmetic.
    const keys = params.keyframes;
    const travel = keys[keys.length - 1].value.map((v, i) => v - keys[0].value[i]) as unknown as [
      number,
      number,
      number,
    ];
    const base = sample(0.25);
    expect(sample(D + 0.25)).toEqual(base.map((v, i) => v + travel[i]));
    expect(sample(2 * D + 0.25)).toEqual(base.map((v, i) => v + 2 * travel[i]));
    // The fixture must actually travel, or every row above is satisfied by zero
    // and this spec would pass on a plain repeat.
    expect(travel.some((v) => Math.abs(v) > 1e-9)).toBe(true);
    // And it is genuinely moving out there, not holding a constant that happens
    // to match — without this the row passes on a frozen channel.
    expect(sample(D + 0.25)).not.toEqual(sample(D + 0.75));
  });

  it('the minted channel agrees with the CLIP past the duration, which is the point', () => {
    const state = riggedState();
    const sample = buildVec3Sampler(mintedParams(state, 'position'));
    const clipSamplers = buildClipBoneSamplers({
      keyframes: (state.nodes.n_clip as { params: AnimationClipParams }).params.keyframes,
      duration: D,
      loop: true,
    });
    const fromClip = clipSamplers.get(1)!;
    for (const t of [D + 0.01, D * 1.5, D * 2 + 0.01]) {
      const a = fromClip(t).position;
      const b = sample(t);
      b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 6));
    }
  });

  it('a bone minted from a NON-looping clip still holds — the fix must not make everything cycle', () => {
    const params = mintedParams(riggedState({ loop: false }), 'position');
    expect(params.modifiers ?? []).toEqual([]);
    const sample = buildVec3Sampler(params);
    // Held at the last key, forever.
    expect(sample(D + 0.25)).toEqual(sample(D));
    expect(sample(D * 5)).toEqual(sample(D));
  });

  it('inside the authored range the minted values are unchanged by the fix', () => {
    const looping = buildVec3Sampler(mintedParams(riggedState(), 'position'));
    const held = buildVec3Sampler(mintedParams(riggedState({ loop: false }), 'position'));
    // The time domain is about OUTSIDE the range. Inside it the two must be
    // identical, or the fix changed something it had no business changing.
    for (const t of [0, 0.25, 0.5, 0.75, D]) expect(looping(t)).toEqual(held(t));
  });

  it('a bone with NO clip mints from its base pose and claims no cycling', () => {
    // Invisible in the sampled value — one key repeated is the same constant
    // either way — so it has to be asserted on the params. Without this row the
    // guard that distinguishes a clip seed from a base seed has no reader, and
    // the director gets a Cycles modifier in their list that they never added.
    const params = mintedParams(riggedState({ withClip: false }), 'position');
    expect(params.modifiers ?? []).toEqual([]);
  });

  it('an existing channel is never re-seeded, so an authored extend survives', () => {
    // A director who sets `hold` on a looping rig keeps `hold`. The mint's
    // contract is "ensure", not "refresh".
    const authored = {
      [gltfChannelDagId(ASSET, BONE, 'position')]: {
        id: gltfChannelDagId(ASSET, BONE, 'position'),
        type: 'KeyframeChannelVec3',
        params: {
          target: boneId,
          childName: BONE,
          assetRef: ASSET,
          paramPath: 'position',
          keyframes: [{ time: 0, value: [7, 7, 7] }],
          modifiers: [],
        },
        inputs: {},
      },
    };
    const res = ensureChannelForBone(riggedState({ extraNodes: authored }), boneId, 'position');
    expect(res).not.toBeNull();
    expect(res!.ops).toEqual([]);
  });
});
