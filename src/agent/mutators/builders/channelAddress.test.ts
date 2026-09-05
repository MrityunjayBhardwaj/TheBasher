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
function bakedState(extraNodes?: Record<string, unknown>): DagState {
  return riggedState({
    ...(extraNodes ?? {}),
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

/** The same bone, carrying exactly ONE authored key at t=1. */
function oneKeyState(): DagState {
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
        keyframes: [{ time: 1, value: [90, 0, 0], easing: 'linear' }],
      },
      inputs: {},
    },
  });
}

/** The same bone, carrying a channel with NO keys — the state a pre-#909 clear
 *  could leave behind, and the one a fresh removal does not create. */
function emptyChannelState(): DagState {
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
        keyframes: [],
      },
      inputs: {},
    },
  });
}

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

describe('the agent surface says so', () => {
  // The model never sees the schema: `listMutators` returns a name and a first
  // sentence, `getMutator` the description, and the spec is a free-form object
  // composed by copying a `specExample` that can only show ONE address form. So
  // an enforcement the description does not mention is a refusal the caller
  // cannot predict and cannot read its way out of — the capability is present
  // and unreachable, and nothing else in the suite can see that.
  it('every authoring mutator states the bone-form requirement in its description', () => {
    const silent = (
      [
        ['keyframe', keyframeMutator],
        ['removeKeyframes', removeKeyframesMutator],
        ['simplifyChannel', simplifyChannelMutator],
        ['setChannelExtend', setChannelExtendMutator],
        ['setKeyframeInterp', setKeyframeInterpMutator],
        ['addChannelModifier', addChannelModifierMutator],
      ] as const
    )
      .filter(([, m]) => !m.description.includes('is REFUSED for a'))
      .map(([n]) => n);
    // Named, not counted — a count says how many drifted, never which.
    expect(silent).toEqual([]);
  });
});

describe('the channelId form REFUSES a bone\u2019s channel (#889 slice 3)', () => {
  // The refusal is the point, and it fires on a channel that EXISTS. Anything
  // weaker is not a rule: addressing a bone by id works perfectly for as long
  // as somebody has already edited that bone, so a caller written against one
  // is green in every test that ran after an edit and silently wrong on the 22
  // bones of 23 that nobody has touched. A gate that only refused a MISSING
  // channel would refuse exactly the cases that already fail loudly.
  it('refuses, even though the channel is right there and the write would work', () => {
    const state = bakedState();
    expect(state.nodes[ROT_CHANNEL]).toBeDefined();

    const plan = validatePlan(
      keyframeMutator,
      { channelId: ROT_CHANNEL, time: 0.5, value: [1, 2, 3] },
      state,
      'test',
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // The reason NAMES the bone and the component, so the fix is mechanical
    // rather than a hunt for which of 23 bones the hash stood for.
    expect(plan.reason).toContain(BONE);
    expect(plan.reason).toContain('rotation');
    expect(plan.reason).toContain('bone: {assetRef, childName, component}');
  });

  it('refuses on every authoring mutator, not just the one', () => {
    const state = bakedState();
    // 🔴 EACH SPEC GOES THROUGH ITS OWN SCHEMA FIRST. `validatePlan` does not
    // parse — the boundary does (tool.ts / dispatchMutatorFromUI) — so a spec
    // with a misspelt field reaches `preconditions` anyway and is refused by the
    // gate, which is the RIGHT answer to the WRONG question: it proves the gate
    // fires on a shape no caller could ever send. Parsing here makes the row
    // assert what it claims. Measured: `addChannelModifier` took `kind` rather
    // than `modifierType` in the first draft of this row, and every assertion
    // passed. The changed-file type sweep found it; vitest could not.
    const cases = [
      ['keyframe', keyframeMutator, { channelId: ROT_CHANNEL, time: 0, value: [0, 0, 0] }],
      ['removeKeyframes', removeKeyframesMutator, { channelId: ROT_CHANNEL, scope: 'all' }],
      ['simplifyChannel', simplifyChannelMutator, { channelId: ROT_CHANNEL, tolerance: 0.1 }],
      [
        'setChannelExtend',
        setChannelExtendMutator,
        { channelId: ROT_CHANNEL, before: 'hold', after: 'hold' },
      ],
      [
        'setKeyframeInterp',
        setKeyframeInterpMutator,
        { channelId: ROT_CHANNEL, scope: 'all', easing: 'linear' },
      ],
      [
        'addChannelModifier',
        addChannelModifierMutator,
        { channelId: ROT_CHANNEL, modifierType: 'noise' },
      ],
    ] as const;

    const unparsed = cases.filter(([, m, spec]) => !m.spec.safeParse(spec).success).map(([n]) => n);
    expect(unparsed).toEqual([]);

    const wrongReason = cases
      .map(([name, m, spec]) => {
        const plan = validatePlan(m as never, m.spec.parse(spec) as never, state, 't');
        return [name, plan] as const;
      })
      .filter(([, plan]) => plan.ok || !plan.reason.includes('address a bone by its parts'))
      .map(([n]) => n);
    // Named, not counted: a count cannot tell "all six refused for the right
    // reason" from "one of them refused for an unrelated schema error".
    expect(wrongReason).toEqual([]);
  });

  it('leaves an ORDINARY node\u2019s channel alone — the gate is about bones, not about ids', () => {
    // The discriminator is the dual key, not the node type: a channel with no
    // `assetRef`/`childName` is an object's or a camera's, and the id form is
    // the only way to address one.
    const state = bakedState({
      n_plain_channel: {
        id: 'n_plain_channel',
        type: 'KeyframeChannelVec3',
        params: {
          name: 'cube position',
          target: 'n_cube',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
        },
        inputs: {},
      },
    });
    const plan = validatePlan(
      keyframeMutator,
      { channelId: 'n_plain_channel', time: 0.5, value: [1, 2, 3] },
      state,
      'test',
    );
    expect(plan.ok).toBe(true);
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

  it('still removes ONE key from a bone that HAS an authored channel', () => {
    // The channel keeps a key, so the removal is an edit to a track that
    // survives — which is what this mutator is for.
    const plan = validatePlan(
      removeKeyframesMutator,
      { bone: BONE_ADDRESS, scope: { time: 0 } },
      bakedState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops.map((o) => ('nodeId' in o ? o.nodeId : null))).toEqual([ROT_CHANNEL]);
    const set = plan.ops[0] as unknown as { value: { time: number }[] };
    expect(set.value.map((k) => k.time)).toEqual([1]);
  });

  // 🔴 INVERTED BY #909. This asserted that `scope:'all'` on a bone SUCCEEDS and
  // emitted one setParam. It does not any more, and the change cannot land
  // silently: emptying a bone's channel in place leaves it claiming its
  // component at [0,0,0], so the bone collapses to the origin instead of
  // returning to the clip.
  it('REFUSES a removal that would empty a bone\u2019s channel, by either road', () => {
    const roads = [
      ['all at once', { bone: BONE_ADDRESS, scope: 'all' as const }],
      // The end state is the rule, not the scope: taking the keys one at a time
      // reaches the same place, and a gate written against `scope:'all'` alone
      // would wave this through. Measured before the fix — it did.
      ['the last one by time', { bone: BONE_ADDRESS, scope: { time: 1 } }],
    ] as const;
    for (const [road, spec] of roads) {
      // `bakedState` has two keys; drop one first so `{time:1}` is the last.
      const state = road === 'the last one by time' ? oneKeyState() : bakedState();
      const plan = validatePlan(removeKeyframesMutator, spec, state, 'test');
      expect(plan.ok, road).toBe(false);
      if (plan.ok) continue;
      // The reason names the CONSEQUENCE, not the rule. "Not allowed" tells a
      // director nothing; "renders the bone at the origin" tells them why they
      // do not want it, and names the act that does what they meant.
      expect(plan.reason, road).toContain('renders the bone at the origin');
      expect(plan.reason, road).toContain(BONE);
    }
  });

  it('does NOT refuse on an already-empty channel — that removal empties nothing', () => {
    // The condition is "this removal would empty it", not "it is empty". A
    // no-op reported as a fault is its own defect.
    const plan = validatePlan(
      removeKeyframesMutator,
      { bone: BONE_ADDRESS, scope: 'all' as const },
      emptyChannelState(),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toEqual([]);
  });

  it('an ORDINARY node\u2019s channel may still be emptied in place', () => {
    // The band's presence rule is specific to the glTF child road. Emptying an
    // object's channel is the long-standing Blender Clear and must not move.
    const plan = validatePlan(
      removeKeyframesMutator,
      { channelId: 'n_plain_channel', scope: 'all' as const },
      bakedState({
        n_plain_channel: {
          id: 'n_plain_channel',
          type: 'KeyframeChannelVec3',
          params: {
            name: 'cube position',
            target: 'n_cube',
            paramPath: 'position',
            keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
          },
          inputs: {},
        },
      }),
      'test',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toHaveLength(1);
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
