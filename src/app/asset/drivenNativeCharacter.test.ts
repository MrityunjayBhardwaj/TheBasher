// #1246 — a bound native character is found through its pose chain's source, however many pose
// layers sit between its armature Object and the retarget (a hand-pose, #1244; the base layer, #1211).
import { beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import { charactersDrivenByClip } from '../animate/boundClipsForAsset';
import type { BoneSpec } from '../../nodes/types';
import { useSelectionStore } from '../stores/selectionStore';
import { bindMotionToCharacter } from './bindMotionToCharacter';
const SWING = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 30 45 0 0
`;
beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});
it('a bound native character is found, hand-posed or not; another clip does not find it', async () => {
  let state = buildDefaultDagState();
  const b = readFileSync('public/assets/skinned-bar.glb');
  const r = await buildNativeGltfImportOps({
    buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in r) throw new Error(r.refused);
  for (const op of r.ops) state = applyOp(state, op).next;
  const motion = buildBvhImportOps({
    text: SWING,
    name: 'swing',
    ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
  });
  for (const op of motion.ops) state = applyOp(state, op).next;
  const stand = buildSkeletonObjectOps({
    skeletonId: 'swing_skel',
    bones: (state.nodes.swing_skel.params as { bones: BoneSpec[] }).bones,
    sceneNodeId: state.outputs.scene!.node,
    normalise: false,
    name: 'swing',
    clipId: 'swing_clip',
    nameFollowsClip: true,
  });
  for (const op of stand.ops) state = applyOp(state, op).next;
  const modifier = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!;
  const armatureId = (modifier.inputs.armature as { node: string }).node;
  const skeletonId = (state.nodes[armatureId].inputs.data as { node: string }).node;
  useSelectionStore.getState().select(null);
  for (const handPosed of [false, true]) {
    useDagStore.getState().hydrate(state);
    if (handPosed) {
      const posed = dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object: armatureId, bone: 'Bone1', rotation: [0, 0, 20] },
        'pose',
      );
      expect(posed.ok).toBe(true);
    }
    const bound = bindMotionToCharacter(
      { motionId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    const s = useDagStore.getState().state;
    expect(
      charactersDrivenByClip(s.nodes as never, 'swing_clip'),
      `hand-posed ${handPosed}`,
    ).toEqual([{ skeletonId, objectId: armatureId }]);
    // Control: a clip nothing is bound from drives nothing.
    expect(charactersDrivenByClip(s.nodes as never, 'n_scene')).toEqual([]);
  }
});
