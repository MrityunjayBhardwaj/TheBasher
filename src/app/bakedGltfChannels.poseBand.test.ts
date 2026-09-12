// #974 — the authored-pose band: a `PoseOverride` hanging off this rig reaches
// the render band by the edge that already exists.
//
//   RetargetClip --posed--> PoseOverride        (membership: the pose chain)
//   RetargetClip --inputs.skeleton--> GltfSkeleton --inputs.asset--> GltfAsset
//
// The rows are about the WALK, the PRECEDENCE and the UNITS. The override's own
// semantics (presence-not-value, copy-on-write, laziness) live in
// PoseOverride.test.ts and are not re-asserted here.
//
// REF: src/app/bakedGltfChannels.ts (poseBandForAsset); src/nodes/PoseOverride.ts;
//      issues #974, #900, #992.

import { describe, it, expect } from 'vitest';
import { emptyDagState, type DagState } from '../core/dag/state';
import { applyOp } from '../core/dag/ops';
import { registerAllNodes } from '../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../core/import/gltfImportChain';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from './bakedGltfChannels';
import { resolveAllChildTrs } from './resolveGltfChildTransform';

registerAllNodes();

const ASSET = 'asset-poseband';
const BONES = ['Hips', 'Spine'] as const;
const NODE_NAME_MAP = Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(ASSET, b)]));

interface Opts {
  bone?: string;
  overridden?: { position?: boolean; rotation?: boolean };
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Hang the override off nothing, to pin that membership is the edge walk. */
  detached?: boolean;
  /** Bake a real channel node on Hips.rotation, to pin precedence over the pose. */
  channelRotationDegrees?: number;
  /** Omit the PoseOverride entirely. */
  noOverride?: boolean;
}

function buildScene(o: Opts = {}): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_asset',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      nodeNameMap: NODE_NAME_MAP,
      skins: [
        {
          jointKeys: [...BONES],
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
    nodeId: 'a_skel',
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'a_asset', socket: 'out' },
    to: { node: 'a_skel', socket: 'asset' },
  }).next;

  // The SOURCE rig + clip the retarget reads (a different skeleton, as in life).
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_srcskel',
    nodeType: 'Skeleton',
    params: { bones: [{ name: 'src_Hips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_srcclip',
    nodeType: 'AnimationClip',
    params: {
      name: 'walk',
      duration: 2,
      loop: 'cycle-offset',
      keyframes: [
        { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { bone: 0, time: 2, position: [0, 4, 0], rotation: [0, Math.PI / 2, 0] },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'a_srcskel', socket: 'out' },
    to: { node: 'a_srcclip', socket: 'skeleton' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_map',
    nodeType: 'BoneNameMap',
    params: { name: 'bridge', map: { src_Hips: 'Hips' } },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_retarget',
    nodeType: 'RetargetClip',
    params: { name: 'retargeted' },
  }).next;
  for (const [from, socket] of [
    ['a_srcclip', 'sourceClip'],
    ['a_map', 'boneMap'],
    ['a_skel', 'skeleton'],
  ] as const) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: from, socket: 'out' },
      to: { node: 'a_retarget', socket },
    }).next;
  }

  if (!o.noOverride) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'a_pose',
      nodeType: 'PoseOverride',
      params: {
        bone: o.bone ?? BONES[0],
        position: o.position ?? [1, 2, 3],
        rotation: o.rotation ?? [10, 20, 30],
        overridden: o.overridden ?? { position: true },
      },
    }).next;
    if (!o.detached) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: 'a_retarget', socket: 'posed' },
        to: { node: 'a_pose', socket: 'pose' },
      }).next;
    }
  }

  if (o.channelRotationDegrees !== undefined) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChannelDagId(ASSET, BONES[0], 'rotation'),
      nodeType: 'KeyframeChannelVec3',
      params: {
        childName: BONES[0],
        target: gltfChildDagId(ASSET, BONES[0]),
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, o.channelRotationDegrees, 0], easing: 'linear' },
          { time: 2, value: [0, o.channelRotationDegrees, 0], easing: 'linear' },
        ],
      },
    }).next;
  }
  return s;
}

const bandAt = (s: DagState, bone: string, seconds: number) =>
  sampleBakedChannel(bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET)[bone], seconds);

describe('the authored-pose band (#974)', () => {
  it('an override on the rig reaches the band for the bone it names', () => {
    expect(bandAt(buildScene(), 'Hips', 0)?.position).toEqual([1, 2, 3]);
  });

  it('holds its value across time — a hand-pose is one value, not a track', () => {
    const s = buildScene();
    expect(bandAt(s, 'Hips', 0)?.position).toEqual([1, 2, 3]);
    expect(bandAt(s, 'Hips', 1.7)?.position).toEqual([1, 2, 3]);
  });

  it('an unauthored component falls through to the clip beneath it', () => {
    // position authored, rotation not → rotation must still come from the clip.
    // The claim is asserted as TIME-VARYING rather than as an exact angle: a
    // constant is exactly what the pose band produces, so "it moves" is the
    // property that distinguishes the two sources, and it does not re-assert the
    // retarget's own math (covered in RetargetClip.test.ts). Sampled at 0 and 1
    // and not at 2, because the clip is `cycle-offset` over 2s and t=2 wraps
    // back onto t=0 — which would have read as a frozen value.
    const s = buildScene();
    const a = bandAt(s, 'Hips', 0)?.rotation;
    const b = bandAt(s, 'Hips', 1)?.rotation;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toEqual(b);
    // ...while the AUTHORED component is frozen across the same two times.
    expect(bandAt(s, 'Hips', 0)?.position).toEqual(bandAt(s, 'Hips', 1)?.position);
  });

  it('🔴 UNITS: an authored rotation reaches the band in DEGREES, unconverted', () => {
    // The clip band converts radians→degrees. Copying that call here would scale
    // an authored pose by π/180 and render as a character standing still.
    const rot = bandAt(
      buildScene({ overridden: { rotation: true }, rotation: [10, 20, 30] }),
      'Hips',
      0,
    )?.rotation;
    expect(rot).toEqual([10, 20, 30]);
  });

  it('a real channel node still outranks the pose — most-specific authoring wins', () => {
    const rot = bandAt(
      buildScene({
        overridden: { rotation: true },
        rotation: [10, 20, 30],
        channelRotationDegrees: 77,
      }),
      'Hips',
      0,
    )?.rotation;
    expect(rot).toEqual([0, 77, 0]);
  });

  it('membership is the EDGE WALK — a detached override drives nothing', () => {
    const posed = bandAt(buildScene({ detached: true }), 'Hips', 0)?.position;
    // Falls back to the clip, which at t=0 is the origin.
    expect(posed).toEqual([0, 0, 0]);
  });

  it('a bone this asset cannot name produces NO band entry at all', () => {
    // 🔴 Asserted on the ABSENCE of the foreign key, not on Hips being
    // undisturbed. A falsification pass showed why: dropping the `nodeNameMap`
    // membership check leaves Hips untouched too — the stray entry just lands
    // under a key nothing reads — so the Hips assertion stayed green over a band
    // that had silently accepted a bone from outside the asset.
    const s = buildScene({ bone: 'NotOnThisRig' });
    const band = bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET);
    expect(band['NotOnThisRig']).toBeUndefined();
    expect(bandAt(s, 'Hips', 0)?.position).toEqual([0, 0, 0]);
  });

  it('with no override the band is exactly what it was before (#888 unchanged)', () => {
    expect(bandAt(buildScene({ noOverride: true }), 'Hips', 0)?.position).toEqual([0, 0, 0]);
  });

  // 🔴 ONE HOP FURTHER THAN THE BAND. Everything above proves the band produces
  // the right numbers; this proves the LAYERING PRIMITIVE consumes them, which
  // is the seam the renderer's useFrame and the read-side resolver both call.
  // Without it the chain from an authored param to a resolved child TRS is
  // asserted in two halves that nothing joins.
  it('the layering primitive resolves the authored pose onto the child TRS', () => {
    const resolveAt = (s: DagState, seconds: number) => {
      const samplers = bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET);
      const bakedByName: Record<string, NonNullable<ReturnType<typeof sampleBakedChannel>>> = {};
      for (const name of Object.keys(samplers)) {
        const baked = sampleBakedChannel(samplers[name], seconds);
        if (baked) bakedByName[name] = baked;
      }
      return resolveAllChildTrs({
        names: Object.keys(NODE_NAME_MAP),
        childByName: {},
        tracks: null,
        bakedByName,
      });
    };

    const posed = resolveAt(buildScene(), 0);
    expect(posed.Hips.position).toEqual([1, 2, 3]);

    // And the same scene WITHOUT the override resolves to the clip instead, so
    // the row above is attributable to the pose and not to a default.
    const bare = resolveAt(buildScene({ noOverride: true }), 0);
    expect(bare.Hips.position).toEqual([0, 0, 0]);
  });
});
