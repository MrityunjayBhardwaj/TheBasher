// channelAddress — how every channel-authoring mutator names the channel it writes to.
//
// #889 slice 2 added a `bone` form that minted a clone-road bone's channel on first edit. It went
// with the clone road (#1053): a kept clone-road import is not drawn and stays exactly as saved, so
// its saved bone channels are refused by id and there is no form left that mints one. What is
// pinned here is the address XOR, that refusal on every authoring mutator, and that an ordinary
// node's channel is untouched by it.

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
import { importedChildNodes } from '../../../test-utils/importedChildFixture';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const BONE_ID = gltfChildDagId(ASSET, BONE);
const ROT_CHANNEL = gltfChannelDagId(ASSET, BONE, 'rotation');

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** An imported asset whose child has no channel yet — the state copy-on-write
 *  leaves behind. (It used to carry a clip bound onto a clone rig as well, which
 *  the mint seeded from; that road retired with the clone road's character half,
 *  #1053, and the mint now seeds from the child's base pose.) */
function riggedState(extraNodes?: Record<string, unknown>): DagState {
  const nodes: Record<string, unknown> = {
    n_asset: {
      id: 'n_asset',
      type: 'GltfAsset',
      params: { assetRef: ASSET, skins: [{ jointKeys: [OTHER, BONE] }] },
      inputs: {},
    },
    ...importedChildNodes(BONE_ID, {
      assetRef: ASSET,
      childName: BONE,
      position: [1, 2, 3],
      rotation: [10, 20, 30],
    }),
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
    const parsed = m.spec.safeParse({
      ...rest,
      channelId: ROT_CHANNEL,
      layer: { layerId: 'n_layer', bone: BONE, component: 'rotation' },
    });
    expect(parsed.success).toBe(false);
  });

  it.each(ADDRESSED)(
    '$m.name no longer takes the clone road\u2019s bone form (#1053)',
    ({ m, rest }) => {
      // zod strips an unknown key, so the bone form alone is "names nothing" — refused, never a mint.
      const parsed = m.spec.safeParse({
        ...rest,
        bone: { assetRef: ASSET, childName: BONE, component: 'rotation' },
      });
      expect(parsed.success).toBe(false);
    },
  );

  it.each(ADDRESSED)('$m.name accepts the id form alone, unchanged', ({ m, rest }) => {
    expect(m.spec.safeParse({ ...rest, channelId: ROT_CHANNEL }).success).toBe(true);
  });
});

describe('the agent surface says so', () => {
  // The model never sees the schema: `listMutators` returns a name and a first
  // sentence, `getMutator` the description, and the spec is a free-form object
  // composed by copying a `specExample` that can only show ONE address form. So
  // an enforcement the description does not mention is a refusal the caller
  // cannot predict and cannot read its way out of — the capability is present
  // and unreachable, and nothing else in the suite can see that.
  it('every authoring mutator teaches the layer form and no longer offers the bone form', () => {
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
      .filter(
        ([, m]) =>
          // #1215 — the layer form, a bone's keys where they live.
          !m.description.includes('`layer` = {layerId, bone, component}') ||
          // #1053 — the clone road's bone form is gone; a description offering it would send the
          // model to a spec every mutator now refuses.
          m.description.includes('{assetRef, childName, component}'),
      )
      .map(([n]) => n);
    // Named, not counted — a count says how many drifted, never which.
    expect(silent).toEqual([]);
  });
});

describe('a saved clone-road bone channel is refused by id (#889 slice 3, #1053)', () => {
  // It fires on a channel that EXISTS: the channel belongs to an import the loader kept on the old
  // imported-file structure, which is not drawn and must be found as saved when it converts. An edit
  // would change a thing nobody can see.
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
    // The reason NAMES the bone, the component and the file, and says why.
    expect(plan.reason).toContain(BONE);
    expect(plan.reason).toContain('rotation');
    expect(plan.reason).toContain(ASSET);
    expect(plan.reason).toContain('saved on the old imported-file structure');
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
      .filter(
        ([, plan]) => plan.ok || !plan.reason.includes('saved on the old imported-file structure'),
      )
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
