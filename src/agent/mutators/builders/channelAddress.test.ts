// #889 slice 2 — every channel-authoring mutator can name a bone, and naming a
// bone that has no channel yet MINTS one instead of refusing.
//
// The claim under test is not "a second spec form parses". It is that the whole
// five-gate road works on the mint: the closure declares a node that does not
// exist yet, the value-shape gate reads a type from an op rather than from
// state, and the write lands on the seed the mint just took from the clip. Each
// of those is a separate place the road can be correct-looking and wrong.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests } from '../../../core/dag';
import { registerAllNodes } from '../../../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../../../core/import/gltfImportChain';
import type { DagState } from '../../../core/dag/state';
import { validatePlan } from '../validate';
import { keyframeMutator } from './keyframe';
import { removeKeyframesMutator } from './removeKeyframes';
import { simplifyChannelMutator } from './simplifyChannel';
import { setChannelExtendMutator } from './setChannelExtend';
import { setKeyframeInterpMutator } from './setKeyframeInterp';
import { addChannelModifierMutator } from './addChannelModifier';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const BONE_ID = gltfChildDagId(ASSET, BONE);
const ROT_CHANNEL = gltfChannelDagId(ASSET, BONE, 'rotation');

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A rigged asset with a bound clip and no baked channels — the state
 *  copy-on-write leaves behind, and the state 22 of a humanoid's 23 bones are
 *  in once the eager bake is gone. */
function riggedState(extraNodes?: Record<string, unknown>): DagState {
  const nodes: Record<string, unknown> = {
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
    [BONE_ID]: {
      id: BONE_ID,
      type: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      },
      inputs: {},
    },
    n_clip: {
      id: 'n_clip',
      type: 'AnimationClip',
      params: {
        duration: 1,
        loop: true,
        keyframes: [
          { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [0, 2, 0], rotation: [Math.PI / 2, 0, 0] },
        ],
      },
      inputs: { skeleton: { node: 'n_rig', socket: 'out' } },
    },
  };
  Object.assign(nodes, extraNodes ?? {});
  return { nodes } as unknown as DagState;
}

/** The same rig with the bone's rotation channel ALREADY there — the road where
 *  gate 3 has something real to reject, since a freshly-added node is exempt. */
function bakedState(): DagState {
  return riggedState({
    [ROT_CHANNEL]: {
      id: ROT_CHANNEL,
      type: 'KeyframeChannelVec3',
      params: {
        name: `${BONE} — rotation`,
        target: BONE_ID,
        childName: BONE,
        assetRef: ASSET,
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [90, 0, 0], easing: 'linear' },
        ],
      },
      inputs: {},
    },
  });
}

const BONE_ADDRESS = { assetRef: ASSET, childName: BONE, component: 'rotation' as const };

/** Every mutator that takes a channel address, with a spec that is valid apart
 *  from the address itself. Listed rather than derived so a new authoring
 *  mutator has to be added here deliberately. */
const ADDRESSED = [
  { m: keyframeMutator, rest: { time: 0.5, value: [1, 2, 3] } },
  { m: removeKeyframesMutator, rest: { scope: 'all' as const } },
  { m: simplifyChannelMutator, rest: { tolerance: 0.5 } },
  { m: setChannelExtendMutator, rest: { after: 'slope' as const } },
  { m: setKeyframeInterpMutator, rest: { easing: 'linear' as const } },
  { m: addChannelModifierMutator, rest: { modifierType: 'noise' as const } },
];

describe('the address is an XOR, enforced at the schema', () => {
  it.each(ADDRESSED)('$m.name rejects an address that names nothing', ({ m, rest }) => {
    const parsed = m.spec.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it.each(ADDRESSED)('$m.name rejects both forms at once', ({ m, rest }) => {
    // Not pedantry: a caller carrying both has not decided which thing it is
    // naming, and silently preferring one would make the other a lie that only
    // shows up when the two disagree.
    const parsed = m.spec.safeParse({ ...rest, channelId: ROT_CHANNEL, bone: BONE_ADDRESS });
    expect(parsed.success).toBe(false);
  });

  it.each(ADDRESSED)('$m.name accepts the bone form alone', ({ m, rest }) => {
    expect(m.spec.safeParse({ ...rest, bone: BONE_ADDRESS }).success).toBe(true);
  });

  it.each(ADDRESSED)('$m.name accepts the id form alone, unchanged', ({ m, rest }) => {
    expect(m.spec.safeParse({ ...rest, channelId: ROT_CHANNEL }).success).toBe(true);
  });
});

describe('keying a bone that has no channel', () => {
  it('mints, seeded from the clip, and passes all five gates', () => {
    const state = riggedState();
    expect(state.nodes[ROT_CHANNEL]).toBeUndefined();

    const plan = validatePlan(
      keyframeMutator,
      { bone: BONE_ADDRESS, time: 0.5, value: [1, 2, 3] },
      state,
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const add = plan.ops.find((o) => o.type === 'addNode' && o.nodeId === ROT_CHANNEL);
    const set = plan.ops.find((o) => o.type === 'setParam' && o.nodeId === ROT_CHANNEL);
    expect(add).toBeDefined();
    expect(set).toBeDefined();
  });

  it('the authored key lands ON the clip’s own track, not on emptiness', () => {
    // The row that separates "edit this motion" from "replace it with one key".
    // A build that read `state` for the existing keyframes instead of reading
    // the mint would produce a single-key channel here, and every structural
    // assertion above would still pass.
    const plan = validatePlan(
      keyframeMutator,
      { bone: BONE_ADDRESS, time: 0.5, value: [1, 2, 3] },
      riggedState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const set = plan.ops.find((o) => o.type === 'setParam') as {
      value: { time: number; value: number[] }[];
    };
    // The clip's two keys (0 and 1, rotation in DEGREES) plus the authored one.
    expect(set.value.map((k) => k.time)).toEqual([0, 0.5, 1]);
    expect(set.value[0].value).toEqual([0, 0, 0]);
    expect(set.value[1].value).toEqual([1, 2, 3]);
    expect(set.value[2].value[0]).toBeCloseTo(90, 6);
  });

  it('never mints an empty channel', () => {
    // An empty channel is a CLAIM, not silence: the band collects it and the
    // sampler answers [0,0,0] at every time, so an empty mint would suppress
    // the pose underneath and snap the bone to the origin on first touch.
    const plan = validatePlan(
      // `scale` is the component the clip cannot carry — the one place an empty
      // mint is reachable at all.
      keyframeMutator,
      { bone: { ...BONE_ADDRESS, component: 'scale' }, time: 0.5, value: [1, 1, 1] },
      riggedState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const add = plan.ops.find((o) => o.type === 'addNode') as {
      params: { keyframes: unknown[] };
    };
    expect(add.params.keyframes.length).toBeGreaterThan(0);
  });
});

describe('the bone form on a bone that already HAS a channel', () => {
  it('writes to it without minting, and stays inside the declared closure', () => {
    // Gate 3 exempts a node introduced in the same plan, so the MINT road can
    // never catch a closure that forgot to declare the channel. Only this road
    // can.
    const plan = validatePlan(
      keyframeMutator,
      { bone: BONE_ADDRESS, time: 0.5, value: [1, 2, 3] },
      bakedState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops.every((o) => o.type === 'setParam')).toBe(true);
    expect(plan.ops.map((o) => ('nodeId' in o ? o.nodeId : null))).toEqual([ROT_CHANNEL]);
  });

  it('does not re-seed — a director’s edit is not replaced by the clip', () => {
    const state = bakedState();
    const plan = validatePlan(
      keyframeMutator,
      { bone: BONE_ADDRESS, time: 0.25, value: [7, 7, 7] },
      state,
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const set = plan.ops[0] as unknown as { value: { time: number }[] };
    expect(set.value.map((k) => k.time)).toEqual([0, 0.25, 1]);
  });
});

describe('removeKeyframes addresses a bone but never mints', () => {
  it('refuses on a bone that follows the clip, naming the state', () => {
    const plan = validatePlan(
      removeKeyframesMutator,
      { bone: BONE_ADDRESS, scope: 'all' as const },
      riggedState(),
      'test',
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // The wording is load-bearing. Under copy-on-write "no channel" is the
    // healthy condition of nearly every bone, so a refusal that says "not in
    // DAG" reports health as a fault.
    expect(plan.reason).toContain('follows the clip');
    expect(plan.reason).not.toContain('not in DAG');
    // The REASON is what this row rests on, and deliberately so. A row that only
    // checked `ok === false` stayed green when the mutator was made to mint —
    // it then failed in build for an unrelated reason, and read as proof of a
    // refusal it was no longer making.
  });

  it('still removes from a bone that HAS an authored channel', () => {
    const plan = validatePlan(
      removeKeyframesMutator,
      { bone: BONE_ADDRESS, scope: 'all' as const },
      bakedState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops.map((o) => ('nodeId' in o ? o.nodeId : null))).toEqual([ROT_CHANNEL]);
  });
});

describe('a bone the asset does not have', () => {
  it('is refused by name rather than minting a channel for nobody', () => {
    const plan = validatePlan(
      keyframeMutator,
      {
        bone: { assetRef: ASSET, childName: 'not_a_bone', component: 'rotation' as const },
        time: 0,
        value: [0, 0, 0],
      },
      riggedState(),
      'test',
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('not_a_bone');
  });
});
