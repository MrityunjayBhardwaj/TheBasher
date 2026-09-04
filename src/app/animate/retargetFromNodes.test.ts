// The params-side resolution of a RetargetClip node, and the walk that reads it (#901).
//
// The load-bearing row is PARITY: a graph with a RetargetClip must give the read
// band the same clip params as the materialised clip the old bake wrote. Everything
// else here guards a way that parity could be lost silently.

import { describe, expect, it } from 'vitest';
import { retargetClipParamsFromNodes, bonesOfSkeletonNode } from './retargetFromNodes';
import { boundClipsForAsset, type GraphNodeLike } from './boundClipsForAsset';
import { retargetClip } from '../../core/import/retarget';
import { RetargetClipNode, RetargetClipParams } from '../../nodes/RetargetClip';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';

const ASSET_REF = 'asset://rig.glb';

// Fresh allocations per call — subject and expectation never share an object.
const sourceBones = (): BoneSpec[] => [
  { name: 'mixamorig_Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 'mixamorig_Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
];
const sourceKeys = (): AnimationKeyframe[] => [
  { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
  { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
  { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
];
const nameMap = (): Record<string, string> => ({
  mixamorig_Hips: 'hips',
  mixamorig_Spine: 'spine',
});

/** A skin whose projection is the target rig — the shape import captures. */
const skin = () => ({
  jointKeys: ['hips', 'spine'],
  // DEGREES here; projectGltfSkeleton converts to the radians BoneSpec carries.
  bindTRS: [
    { position: [0, 1.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  ],
  parentJointIndex: [-1, 0],
  inverseBindMatrices: [],
});

function graph(over: Record<string, GraphNodeLike> = {}): Record<string, GraphNodeLike> {
  return {
    n_asset: { type: 'GltfAsset', params: { assetRef: ASSET_REF, skins: [skin()] }, inputs: {} },
    n_gltfSkel: {
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: 'n_asset', socket: 'out' } },
    },
    n_srcSkel: { type: 'Skeleton', params: { bones: sourceBones() }, inputs: {} },
    n_src: {
      type: 'AnimationClip',
      params: { name: 'walk', duration: 1, loop: false, keyframes: sourceKeys() },
      inputs: { skeleton: { node: 'n_srcSkel', socket: 'out' } },
    },
    n_map: { type: 'BoneNameMap', params: { name: 'bridge', map: nameMap() }, inputs: {} },
    n_retarget: {
      type: 'RetargetClip',
      params: { name: '' },
      inputs: {
        sourceClip: { node: 'n_src', socket: 'out' },
        boneMap: { node: 'n_map', socket: 'out' },
        skeleton: { node: 'n_gltfSkel', socket: 'out' },
      },
    },
    ...over,
  };
}

describe('bonesOfSkeletonNode', () => {
  it('reads a plain Skeleton’s bones and PROJECTS a GltfSkeleton’s, both from params', () => {
    const g = graph();
    expect(bonesOfSkeletonNode(g, 'n_srcSkel')?.map((b) => b.name)).toEqual([
      'mixamorig_Hips',
      'mixamorig_Spine',
    ]);
    // The target rig's bind pose is reachable WITHOUT an evaluator — that is what
    // lets the format migration, which runs on raw JSON, resolve a retarget too.
    expect(bonesOfSkeletonNode(g, 'n_gltfSkel')?.map((b) => b.name)).toEqual(['hips', 'spine']);
  });

  it('is null for a missing id, a non-skeleton node, and an unwired GltfSkeleton', () => {
    const g = graph();
    expect(bonesOfSkeletonNode(g, null)).toBeNull();
    expect(bonesOfSkeletonNode(g, 'nope')).toBeNull();
    expect(bonesOfSkeletonNode(g, 'n_src')).toBeNull();
    expect(
      bonesOfSkeletonNode(
        { ...g, n_gltfSkel: { type: 'GltfSkeleton', params: { skinIndex: 0 }, inputs: {} } },
        'n_gltfSkel',
      ),
    ).toBeNull();
  });
});

describe('retargetClipParamsFromNodes', () => {
  it('PARITY — resolves to exactly what the old bake materialised', () => {
    const params = retargetClipParamsFromNodes(graph(), graph().n_retarget);
    const baked = retargetClip({
      sourceBones: sourceBones(),
      sourceClip: { name: 'walk', duration: 1, keyframes: sourceKeys() },
      targetBones: bonesOfSkeletonNode(graph(), 'n_gltfSkel')! as BoneSpec[],
      nameMap: nameMap(),
    });
    expect(params).toEqual(baked.clipParams);
    expect(params!.keyframes!.length).toBeGreaterThan(0);
  });

  it('PARITY — the params road and the node’s evaluate() give the same answer', () => {
    // Two ways in, one piece of math. If these ever diverge, the band and the
    // value side would disagree about the same node, which is the failure
    // `boundClipsForAsset`'s own header exists to prevent one layer down.
    const g = graph();
    const viaParams = retargetClipParamsFromNodes(g, g.n_retarget);
    const viaEvaluate = RetargetClipNode.evaluate(
      RetargetClipParams.parse({}),
      {
        sourceClip: {
          kind: 'AnimationClip',
          name: 'walk',
          duration: 1,
          loop: false,
          keyframes: sourceKeys(),
          skeleton: { kind: 'Skeleton', bones: sourceBones() },
        },
        boneMap: { kind: 'BoneNameMap', name: 'bridge', map: nameMap() },
        skeleton: { kind: 'Skeleton', bones: bonesOfSkeletonNode(g, 'n_gltfSkel')! as BoneSpec[] },
      } as never,
      undefined as never,
    );
    expect(viaParams!.keyframes).toEqual(viaEvaluate.keyframes);
    expect(viaParams!.duration).toBe(viaEvaluate.duration);
    expect(viaParams!.name).toBe(viaEvaluate.name);
  });

  it('is null for every incomplete graph, one cause at a time', () => {
    const cases: Record<string, Record<string, GraphNodeLike>> = {
      'no sourceClip edge': graph({
        n_retarget: {
          ...graph().n_retarget,
          inputs: { boneMap: { node: 'n_map', socket: 'out' } },
        } as GraphNodeLike,
      }),
      'sourceClip is not a clip': graph({
        n_retarget: {
          ...graph().n_retarget,
          inputs: { ...graph().n_retarget.inputs, sourceClip: { node: 'n_map', socket: 'out' } },
        },
      }),
      'source clip has no keys': graph({
        n_src: { ...graph().n_src, params: { name: 'walk', duration: 1, keyframes: [] } },
      }),
      'source clip has no rig': graph({ n_src: { ...graph().n_src, inputs: {} } }),
      'boneMap is not a BoneNameMap': graph({
        n_retarget: {
          ...graph().n_retarget,
          inputs: { ...graph().n_retarget.inputs, boneMap: { node: 'n_src', socket: 'out' } },
        },
      }),
      'target rig has no bones': graph({
        n_asset: {
          type: 'GltfAsset',
          params: { assetRef: ASSET_REF, skins: [] },
          inputs: {},
        },
      }),
    };
    for (const [why, g] of Object.entries(cases)) {
      expect(retargetClipParamsFromNodes(g, g.n_retarget), why).toBeNull();
    }
    // The control: the unmodified graph DOES resolve, so the six rows above are
    // measuring their own cause rather than a fixture that never worked.
    expect(retargetClipParamsFromNodes(graph(), graph().n_retarget)).not.toBeNull();
  });

  it('recomputes when an operand object changes, and not otherwise', () => {
    // The memo is what keeps ~12ms off a drag of any unrelated node. It keys on
    // operand IDENTITY, which is exactly what a store edit replaces.
    const g = graph();
    const first = retargetClipParamsFromNodes(g, g.n_retarget);
    expect(retargetClipParamsFromNodes(g, g.n_retarget)).toBe(first);

    // A NEW source-params object — what editing the clip produces — must miss.
    const edited: Record<string, GraphNodeLike> = {
      ...g,
      n_src: { ...g.n_src, params: { name: 'walk', duration: 1, keyframes: sourceKeys() } },
    };
    expect(retargetClipParamsFromNodes(edited, edited.n_retarget)).not.toBe(first);

    // And a changed MAP must change the ANSWER, not merely the identity.
    const remapped: Record<string, GraphNodeLike> = {
      ...g,
      n_map: { ...g.n_map, params: { name: 'bridge', map: { mixamorig_Hips: 'hips' } } },
    };
    const partial = retargetClipParamsFromNodes(remapped, remapped.n_retarget)!;
    expect(new Set(partial.keyframes!.map((k) => k.bone))).not.toEqual(
      new Set(first!.keyframes!.map((k) => k.bone)),
    );
  });

  it('gives two retargets sharing every operand their OWN output names', () => {
    // Self-review found this as a WRONG ANSWER, not a worry: the memo keyed only
    // on what the math reads, and the output name rides in the answer without
    // being an operand — so the second node inherited the first's name.
    const g = graph({
      n_second: {
        ...graph().n_retarget,
        params: { name: 'Alien motion' },
      },
      n_retarget: { ...graph().n_retarget, params: { name: 'Robot motion' } },
    });
    expect(retargetClipParamsFromNodes(g, g.n_retarget)!.name).toBe('Robot motion');
    expect(retargetClipParamsFromNodes(g, g.n_second)!.name).toBe('Alien motion');
    // And the blank name still derives, rather than being remembered as ''.
    const blank = graph();
    expect(retargetClipParamsFromNodes(blank, blank.n_retarget)!.name).toBe('walk_retargeted');
  });
});

describe('boundClipsForAsset reads a RetargetClip', () => {
  it('finds it on the rig and hands the band the resolved keys', () => {
    const bound = boundClipsForAsset(graph(), ASSET_REF);
    expect(bound.map((b) => b.clipId)).toEqual(['n_retarget']);
    expect(bound[0].jointKeys).toEqual(['hips', 'spine']);
    expect(bound[0].params.keyframes!.length).toBeGreaterThan(0);
  });

  it('a materialised clip and a RetargetClip on the same rig agree, key for key', () => {
    // The migration story: an old project's baked clip and a newly bound graph
    // must drive the rig identically. Built from independent parses of the same
    // generators, so nothing is shared between the two sides.
    const viaGraph = boundClipsForAsset(graph(), ASSET_REF)[0];
    const baked = retargetClip({
      sourceBones: sourceBones(),
      sourceClip: { name: 'walk', duration: 1, keyframes: sourceKeys() },
      targetBones: bonesOfSkeletonNode(graph(), 'n_gltfSkel')! as BoneSpec[],
      nameMap: nameMap(),
    });
    const materialised = graph({
      n_baked: {
        type: 'AnimationClip',
        params: baked.clipParams,
        inputs: { skeleton: { node: 'n_gltfSkel', socket: 'out' } },
      },
    });
    delete materialised.n_retarget;
    const viaBake = boundClipsForAsset(materialised, ASSET_REF)[0];
    expect(viaGraph.params.keyframes).toEqual(viaBake.params.keyframes);
    expect(viaGraph.params.duration).toBe(viaBake.params.duration);
    expect(viaGraph.jointKeys).toEqual(viaBake.jointKeys);
  });

  it('skips a RetargetClip whose graph does not resolve, rather than emitting an empty clip', () => {
    // An empty clip would occupy a slot in "the clips driving this rig" and could
    // shadow a real one behind it — the sorted walk lets earlier entries win.
    const broken = graph({ n_src: { ...graph().n_src, inputs: {} } });
    expect(boundClipsForAsset(broken, ASSET_REF)).toEqual([]);
  });
});
