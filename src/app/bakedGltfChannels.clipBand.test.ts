// #888 — the clip band: a bone with NO channel node reaches a retargeted clip
// by walking the edge that already exists.
//
//   AnimationClip --inputs.skeleton--> GltfSkeleton --inputs.asset--> GltfAsset
//
// The rows here are about the WALK and the PRECEDENCE. The sampling math is not
// re-asserted: it is the clip's own (`buildClipBoneSamplers`), covered by
// nodes.test.ts, and delegating rather than rebuilding is the point.
//
// REF: issues #877, #888, #889; src/nodes/AnimationClip.ts (the delegated
//      sampler); src/app/gltfAssetDeps.ts (the renderer's subscription, whose
//      agreement with the read side is asserted at the bottom of this file).

import { describe, it, expect } from 'vitest';
import { emptyDagState } from '../core/dag/state';
import { applyOp } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import { registerAllNodes } from '../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../core/import/gltfImportChain';
import { bakedChannelSamplersForAsset } from './bakedGltfChannels';
import { gltfAssetDepNodes } from './gltfAssetDeps';

registerAllNodes();

const ASSET = 'asset-clipband';
const BONES = ['Hips', 'Spine'] as const;
const NODE_NAME_MAP = Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(ASSET, b)]));

/** Bone 0 rises 0 → 4 and turns 0 → π/2 over 2s. Bone 1 is untouched. */
const CLIP_KEYS = [
  { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
  { bone: 0, time: 2, position: [0, 4, 0], rotation: [0, Math.PI / 2, 0] },
];

interface SceneOpts {
  /** Wire the clip to this node id instead of the asset's own GltfSkeleton. */
  clipSkeletonId?: string;
  /** Add a second AnimationClip on the same rig, to pin the tie-break. */
  secondClip?: boolean;
  /** Bake bone 0's rotation as a real channel node, so precedence is testable. */
  channelRotationDegrees?: number;
}

function buildScene(opts: SceneOpts = {}): DagState {
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

  // A DIFFERENT rig, standing in for the source clip's own skeleton.
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_otherskel',
    nodeType: 'Skeleton',
    params: { bones: [] },
  }).next;

  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'a_clip',
    nodeType: 'AnimationClip',
    params: { name: 'retargeted', duration: 2, loop: true, keyframes: CLIP_KEYS },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: opts.clipSkeletonId ?? 'a_skel', socket: 'out' },
    to: { node: 'a_clip', socket: 'skeleton' },
  }).next;

  if (opts.secondClip) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'a_clip_zzz',
      nodeType: 'AnimationClip',
      params: {
        name: 'second',
        duration: 2,
        loop: true,
        keyframes: [
          { bone: 0, time: 0, position: [0, 100, 0], rotation: [0, 0, 0] },
          { bone: 0, time: 2, position: [0, 100, 0], rotation: [0, 0, 0] },
        ],
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'a_skel', socket: 'out' },
      to: { node: 'a_clip_zzz', socket: 'skeleton' },
    }).next;
  }

  if (opts.channelRotationDegrees !== undefined) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChannelDagId(ASSET, BONES[0], 'rotation'),
      nodeType: 'KeyframeChannelVec3',
      params: {
        childName: BONES[0],
        target: gltfChildDagId(ASSET, BONES[0]),
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, opts.channelRotationDegrees, 0], easing: 'linear' },
          { time: 2, value: [0, opts.channelRotationDegrees, 0], easing: 'linear' },
        ],
      },
    }).next;
  }

  for (const b of BONES) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(ASSET, b),
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: b,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
  }
  return s;
}

const band = (s: DagState) => bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET);

describe('#888 — the band reaches the clip through the skeleton edge', () => {
  it('serves a bone that has NO channel node, from the clip bound to its rig', () => {
    const b = band(buildScene())[BONES[0]];
    expect(b?.position).toBeTypeOf('function');
    expect(b?.rotation).toBeTypeOf('function');
    expect(b!.position!(1)[1]).toBeCloseTo(2, 6);
  });

  it('converts the clip RADIANS into the band DEGREES', () => {
    // The clip says π/2. The band this joins is degrees — copying through
    // unconverted scales every bone rotation by π/180, which renders as a
    // character standing still while its root position travels at full speed.
    expect(band(buildScene())[BONES[0]]!.rotation!(1)[1]).toBeCloseTo(45, 6);
  });

  it('never claims SCALE, which the clip cannot express', () => {
    // The resolver reads presence, so claiming scale would SUPPRESS the asset's
    // own scale track underneath rather than merely add nothing.
    expect(band(buildScene())[BONES[0]]!.scale).toBeUndefined();
  });

  it('says nothing about a bone the clip never keyframed', () => {
    // Bone 1 has no keys, so it must fall through to the clip/base bands below
    // rather than being pinned to a zero pose.
    expect(band(buildScene())[BONES[1]]).toBeUndefined();
  });

  it('EXCLUDES a clip bound to a different skeleton — the source clip case', () => {
    // The 78-bone source clip a retarget consumes hangs off its own Skeleton,
    // and its bone INDICES mean nothing against this rig. The edge is what
    // makes that mismatch unrepresentable instead of merely unlikely.
    expect(band(buildScene({ clipSkeletonId: 'a_otherskel' }))[BONES[0]]).toBeUndefined();
  });

  it('delegates the clip LOOP rather than clamping like the eager bake does', () => {
    // The bake copies keys with `extend: hold`, so it silently drops looping —
    // one of the things the copy lost without anyone recording it. Delegating
    // gets the clip's own folding back: t = 4 is two full periods on, so it
    // reads the start of the clip again.
    const b = band(buildScene())[BONES[0]];
    expect(b!.position!(1)[1]).toBeCloseTo(2, 6);
    expect(b!.position!(4)[1]).toBeCloseTo(0, 6);
    // The discriminating half: a HELD channel would still be reading its last
    // key (4) out here, so this row fails if the fold is ever dropped.
    expect(b!.position!(4)[1]).not.toBeCloseTo(4, 6);
  });

  it('is deterministic when two clips share a rig — first by sorted id wins', () => {
    // A second bind is refused by name today, so this tie-break should not
    // fire. "Should not fire" is not "cannot", and key order is not an ordering.
    const b = band(buildScene({ secondClip: true }))[BONES[0]];
    expect(b!.position!(1)[1]).toBeCloseTo(2, 6); // a_clip, not a_clip_zzz
  });
});

describe('#888 — precedence: a real channel outranks the clip, per component', () => {
  it('the channel supplies rotation and the clip still supplies position', () => {
    const b = band(buildScene({ channelRotationDegrees: 33 }))[BONES[0]];
    // The authored/materialised track wins its own component…
    expect(b!.rotation!(1)[1]).toBeCloseTo(33, 6);
    // …and does not suppress the component it says nothing about.
    expect(b!.position!(1)[1]).toBeCloseTo(2, 6);
  });

  it('when every component has a channel, the clip band changes nothing', () => {
    // This is the compatibility claim #889 rests on, asserted rather than
    // reasoned about: an existing project has a channel for every baked bone,
    // so the new arm is unreachable and saved scenes render identically.
    const s = buildScene({ channelRotationDegrees: 33 });
    const withClipBand = bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET);
    // Same graph with the clip removed: the channel band alone.
    const noClip = applyOp(s, { type: 'removeNode', nodeId: 'a_clip' } as never).next;
    const channelOnly = bakedChannelSamplersForAsset(noClip.nodes, NODE_NAME_MAP, ASSET);
    expect(withClipBand[BONES[0]]!.rotation!(1)).toEqual(channelOnly[BONES[0]]!.rotation!(1));
  });
});

describe('#888 — the H40 boundary pair: both surfaces see the same band', () => {
  it("the renderer's subscription carries the whole chain, so it resolves what the read side does", () => {
    // The read side passes the WHOLE node table; the renderer passes only
    // `gltfAssetDepNodes`. Teaching the enumerator to walk an edge without
    // widening that collector would give the gizmo/NPanel a moving bone and the
    // viewport a still one — silently, since both surfaces would still "work".
    // Asserting the two inputs produce the SAME band is that check, and it
    // reds if either side is changed alone.
    const s = buildScene();
    const readSide = bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET);

    const depNodes = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    const depMap = Object.fromEntries(depNodes.map((n) => [n.id, n]));
    const renderer = bakedChannelSamplersForAsset(depMap, NODE_NAME_MAP, ASSET);

    expect(Object.keys(renderer).sort()).toEqual(Object.keys(readSide).sort());
    expect(renderer[BONES[0]]!.position!(1)).toEqual(readSide[BONES[0]]!.position!(1));
    expect(renderer[BONES[0]]!.rotation!(1)).toEqual(readSide[BONES[0]]!.rotation!(1));
  });

  it('the collector names the asset, its skeleton and the clip bound to it', () => {
    // Stated as ids rather than only as a behaviour, so a future narrowing of
    // the collector reds here with a readable reason instead of as a mismatch.
    const s = buildScene();
    const ids = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP).map((n) => n.id);
    expect(ids).toContain('a_asset');
    expect(ids).toContain('a_skel');
    expect(ids).toContain('a_clip');
  });
});
