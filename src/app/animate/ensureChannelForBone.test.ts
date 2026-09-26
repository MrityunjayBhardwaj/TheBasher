// #889 slice 1 — minting a bone's channel at the moment something authors on it.
//
// The claim under test is not "a node appears". It is that the minted node holds the bone
// where it already stood: seeded from its base pose, never empty. A channel minted empty
// samples to [0,0,0] and snaps the bone to the origin the instant a director touches it.
//
// The mint used to seed from an `AnimationClip` bound onto a clone rig; that road retired
// with the clone road's character half (#1053), and its rows (the clip's track, the
// radians→degrees conversion, the clip's time domain) retired with it.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { ensureChannelForBone } from './ensureChannelForBone';
import type { DagState } from '../../core/dag/state';
import type { KeyframeChannelVec3Params } from '../../nodes/KeyframeChannelVec3';
import { importedChildNodes } from '../../test-utils/importedChildFixture';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** An imported asset and one child, its base pose written the way the import writes it —
 *  rotation already in DEGREES — on the OBJECT half (#389). `withCloneClip` adds what an
 *  old save's clone character carried: a GltfSkeleton and an AnimationClip bound to it. */
function childState(opts?: {
  withCloneClip?: boolean;
  extraNodes?: Record<string, unknown>;
}): DagState {
  const nodes: Record<string, unknown> = {
    n_asset: {
      id: 'n_asset',
      type: 'GltfAsset',
      params: { assetRef: ASSET, skins: [{ jointKeys: [OTHER, BONE] }] },
      inputs: {},
    },
    ...importedChildNodes(gltfChildDagId(ASSET, BONE), {
      assetRef: ASSET,
      childName: BONE,
      position: [1, 2, 3],
      rotation: [10, 20, 30],
      scale: [1, 1, 1],
    }),
  };
  if (opts?.withCloneClip) {
    nodes.n_rig = {
      id: 'n_rig',
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: 'n_asset', socket: 'out' } },
    };
    nodes.n_clip = {
      id: 'n_clip',
      type: 'AnimationClip',
      params: {
        duration: 1,
        loop: 'cycle-offset',
        keyframes: [
          { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [0, 2, 0], rotation: [Math.PI / 2, 0, 0] },
        ],
      },
      inputs: { skeleton: { node: 'n_rig', socket: 'out' } },
    };
  }
  Object.assign(nodes, opts?.extraNodes ?? {});
  return { nodes } as unknown as DagState;
}

/** The params the mint's addNode would create for `component`. */
function mintedParams(
  state: DagState,
  component: 'position' | 'rotation' | 'scale',
): KeyframeChannelVec3Params {
  const res = ensureChannelForBone(state, gltfChildDagId(ASSET, BONE), component);
  expect(res).not.toBeNull();
  const add = res!.ops.find(
    (o) => o.type === 'addNode' && o.nodeId === gltfChannelDagId(ASSET, BONE, component),
  ) as { params: KeyframeChannelVec3Params } | undefined;
  expect(add).toBeDefined();
  return add!.params;
}

describe('minting a channel for a bone', () => {
  it('mints one, addressed by the derived content id', () => {
    const out = ensureChannelForBone(childState(), gltfChildDagId(ASSET, BONE), 'rotation');
    expect(out).not.toBeNull();
    expect(out!.channelId).toBe(gltfChannelDagId(ASSET, BONE, 'rotation'));
    expect(out!.ops).toHaveLength(1);
    expect(out!.ops[0].type).toBe('addNode');
  });

  it('seeds from the bone’s BASE pose, one key — never empty', () => {
    // An empty channel samples to [0,0,0] at every time and suppresses the pose underneath it,
    // so the bone would snap to the origin the instant it was first touched.
    for (const [component, base] of [
      ['position', [1, 2, 3]],
      ['rotation', [10, 20, 30]],
      ['scale', [1, 1, 1]],
    ] as const) {
      const kf = mintedParams(childState(), component).keyframes;
      expect(kf, component).toHaveLength(1);
      expect(kf[0].value, component).toEqual(base);
    }
  });

  it('claims no cycling — one key held is a constant, and a Cycles modifier would be noise', () => {
    // Invisible in the sampled value, so it has to be asserted on the params: the director
    // would otherwise find a Cycles modifier in their list that they never added.
    expect(mintedParams(childState(), 'position').modifiers ?? []).toEqual([]);
  });

  it('a clip bound onto a clone rig is not a seed — the bone starts from its base', () => {
    // The retired road. An old save can still hold the GltfSkeleton + AnimationClip pair; the
    // mint no longer reads it, so the seed is the base pose and nothing cycles.
    const params = mintedParams(childState({ withCloneClip: true }), 'position');
    expect(params.keyframes.map((k) => k.value)).toEqual([[1, 2, 3]]);
    expect(params.modifiers ?? []).toEqual([]);
    expect(params.sourceClipId).toBeUndefined();
    expect(params.sourceHash).toBeUndefined();
  });

  it('mints NOTHING when the channel already exists, so an authored edit survives', () => {
    // WHERE THIS IS ENFORCED, measured rather than assumed: deleting the early return in
    // `ensureChannelForBone` leaves this row GREEN, because `bakeChannelOpsForBone` skips a
    // component whose node is already in state. So this row pins the OBSERVABLE property —
    // an existing channel produces no ops — and does not claim to guard the fast path.
    const channelId = gltfChannelDagId(ASSET, BONE, 'rotation');
    const state = childState({
      extraNodes: {
        [channelId]: {
          id: channelId,
          type: 'KeyframeChannelVec3',
          params: {
            target: gltfChildDagId(ASSET, BONE),
            childName: BONE,
            assetRef: ASSET,
            paramPath: 'rotation',
            keyframes: [{ time: 0, value: [7, 7, 7] }],
          },
          inputs: {},
        },
      },
    });
    const out = ensureChannelForBone(state, gltfChildDagId(ASSET, BONE), 'rotation')!;
    expect(out.channelId).toBe(channelId);
    expect(out.ops).toEqual([]);
  });

  it('returns null for something that is not a glTF bone', () => {
    // A spec error rather than a graph state — it should surface as a refusal, not as a
    // silent no-op that leaves the edit with nowhere to go.
    expect(ensureChannelForBone(childState(), 'n_asset', 'position')).toBeNull();
  });
});
