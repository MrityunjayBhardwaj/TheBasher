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
import { buildClipBoneSamplers } from '../nodes/AnimationClip';
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

  it('cycles the clip WITH OFFSET on position, rather than clamping or teleporting', () => {
    // The eager bake copied keys with `extend: hold`, so it silently dropped
    // looping. Delegating got the fold back — and #924 showed the fold alone was
    // still wrong: `t % duration` replays identical frames, so a root that
    // travels snapped home once per period.
    //
    // The clip runs [0,0,0] -> [0,4,0] over a span of 2. At t = 4 it is two full
    // periods on, so it reads the start of the clip again PLUS two periods of
    // travel: 0 + 2 * 4 = 8.
    const b = band(buildScene())[BONES[0]];
    expect(b!.position!(1)[1]).toBeCloseTo(2, 6);
    // This single row discriminates all three rules, which is why it is stated as
    // a value rather than a comparison: a HELD channel reads 4 out here, a
    // PLAIN-repeat channel reads 0, and only cycle-with-offset reads 8.
    expect(b!.position!(4)[1]).toBeCloseTo(8, 6);
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

describe('#888 — the band reads params nothing re-validated, so it must survive them', () => {
  it('a non-positive or NaN duration folds to 0 rather than producing NaN poses', () => {
    // The schema forbids these, but the band reads `clip.params` straight off a
    // saved file — the schema guards the NODE's inputs, not this path. `x % 0`
    // is NaN in JS, and a NaN would propagate through every lerp into a bone
    // pose of NaNs: a limb that silently vanishes rather than an error anyone
    // can trace back here.
    for (const duration of [0, -1, Number.NaN]) {
      const sampler = buildClipBoneSamplers({
        duration,
        loop: true,
        keyframes: [
          { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 0, time: 1, position: [0, 9, 0], rotation: [0, 0, 0] },
        ],
      } as never).get(0)!;
      const p = sampler(0.5).position;
      expect(Number.isFinite(p[1])).toBe(true);
      expect(p[1]).toBe(1); // the first key, which is what "no time domain" means
    }
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

// ─────────────────────────────────────────────────────────────────────────
// #924 — WHICH DOMAIN the extend rule runs over. This is a behaviour change the
// fix carries beyond the seam it was filed for, so it is stated rather than left
// to be discovered: the domain is the clip's KEY RANGE, not its declared
// `duration`.
//
// It closes a latent divergence rather than opening one. A minted channel has
// only its keys — its Cycles modifier repeats the KEY range — while the clip band
// used to fold on `duration`. Whenever the two disagreed, an edited bone and an
// unedited one rendered different motion, and nothing said so. They now read the
// same domain by construction.
//
// Blender draws the same line: a Cycles F-Modifier repeats the keyframe range,
// and an action's frame range is separate metadata that "does not make the action
// cycle on its own".
// ─────────────────────────────────────────────────────────────────────────
describe('#924 the extend domain is the key range, not the declared duration', () => {
  /** Keys spanning [0,3] on a clip that CLAIMS duration 2 — deliberately unequal. */
  const KEYS = [
    { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 3, position: [0, 3, 0], rotation: [0, 0, 0] },
  ];

  it('a non-looping clip holds its LAST KEY, not the value at `duration`', () => {
    const s = buildClipBoneSamplers({ keyframes: KEYS, duration: 2, loop: false } as never).get(0)!;
    // Inside the keys but past the declared duration: the authored key wins, so
    // this reads 2.5. Clamping to `duration` first would truncate the last third
    // of the authored motion and read 2.
    expect(s(2.5).position[1]).toBeCloseTo(2.5, 6);
    // Far outside: hold the last KEY (3), not the value at `duration` (2).
    expect(s(9).position[1]).toBeCloseTo(3, 6);
  });

  it('a looping clip cycles over the key range, so one period out is one key span', () => {
    const s = buildClipBoneSamplers({ keyframes: KEYS, duration: 2, loop: true } as never).get(0)!;
    // Period 3 (the key span), not 2 (the declared duration). At t = 3.5 the
    // mapped time is 0.5 and one span of travel has accumulated: 0.5 + 3 = 3.5.
    // A duration-period would map t = 3.5 to 1.5 and read a different number, so
    // this row distinguishes the two domains rather than merely showing a cycle.
    expect(s(3.5).position[1]).toBeCloseTo(3.5, 6);
  });
});
