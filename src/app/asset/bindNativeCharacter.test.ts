// #1213 — a motion binds to a native character: the retarget's pose reaches the armature Object.
//
// A native character is an armature Object whose data is a `Skeleton`, deformed through an
// Armature modifier that points at that Object (#393). Its pose is its Object's `pose` edge
// (#1224), the one thing that poses it: the deform, the bone draw and bone-parented Objects all
// read it. A bind that leaves that edge alone has changed nothing the director can see.
//
// Blender has no built-in retarget, so the retarget itself is compared with our own deform, not
// with Blender: the deform already equals Blender's on this fixture (`armatureDeform.test.ts`,
// `q13_skinned_bar_oracle.py`).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import type { BoneSpec, ObjectValue, PosedSkeletonValue, SkinDeformValue } from '../../nodes/types';
import type { MeshGeometryData } from '../../nodes/types';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { useSelectionStore } from '../stores/selectionStore';
import { collectSkeletonObjects } from '../skeletonObjects';
import { bindMotionToCharacter, characterTargets } from './bindMotionToCharacter';
import { poseLayerChain } from '../animate/poseChain';
import type { GraphNodeLike } from '../animate/graphNodes';

/** The retarget feeds the bottom of the Object's pose chain, and the base layer holding the file's
 *  own keys sits muted above it (#1211, as Blender swaps an armature's action). */
function expectBoundTo(state: DagState, objectId: string, retargetId: string) {
  const chain = poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    objectId,
  );
  expect(chain.source).toEqual({ node: retargetId, socket: 'posed' });
  expect(chain.layers).toHaveLength(1);
  expect((state.nodes[chain.layers[0]].params as { mute?: boolean }).mute).toBe(true);
}

/** A two-joint motion named as the bar's bones are, so the bind bridges it by matching names:
 *  `Bone1` swings 0° → 45° → 90° about Z over one second. */
const BAR_SWING_BVH = `HIERARCHY
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
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

const at = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** A native skinned import, as the skinned road builds it. */
async function importNative(state: DagState, file: string): Promise<DagState> {
  const bytes = readFileSync(`public/assets/${file}`);
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: `user-imports/native/${file}`,
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  return state;
}

/** A BVH motion standing in the scene as its own rig, as the import road stands one. */
function importMotion(state: DagState, id: string, text: string): DagState {
  const motion = buildBvhImportOps({
    text,
    name: id,
    ids: { skeleton: `${id}_skel`, clip: `${id}_clip` },
  });
  for (const op of motion.ops) state = applyOp(state, op).next;
  const bones = (state.nodes[`${id}_skel`].params as { bones: BoneSpec[] }).bones;
  const stand = buildSkeletonObjectOps({
    skeletonId: `${id}_skel`,
    bones,
    sceneNodeId: state.outputs.scene!.node,
    normalise: false,
    name: id,
    clipId: `${id}_clip`,
    nameFollowsClip: true,
  });
  for (const op of stand.ops) state = applyOp(state, op).next;
  return state;
}

/** The native skinned bar, and a BVH walk standing beside it as its own rig (the import road). */
async function scene() {
  let state = await importNative(buildDefaultDagState(), 'skinned-bar.glb');
  state = importMotion(state, 'walk', readFileSync('public/assets/motion/walk.bvh', 'utf8'));

  const nodes = Object.values(state.nodes);
  const modifierId = nodes.find((n) => n.type === 'ArmatureModifier')!.id;
  const armatureId = (state.nodes[modifierId].inputs.armature as { node: string }).node;
  const barSkeletonId = (state.nodes[armatureId].inputs.data as { node: string }).node;
  const barBones = (state.nodes[barSkeletonId].params as { bones: BoneSpec[] }).bones;
  return { state, armatureId, barSkeletonId, barBones };
}

/** The pose an evaluated Object carries, at `seconds`. */
function objectPose(state: DagState, objectId: string, seconds: number) {
  const value = evaluate(state, objectId, { ctx: at(seconds) }).value as ObjectValue;
  return (value as { pose?: PosedSkeletonValue }).pose?.sample(seconds) ?? null;
}

describe('#1213 — a retarget onto a native character poses its armature Object', () => {
  it('the retarget’s posed output becomes the armature Object’s pose, and the Object poses as it', async () => {
    const { state, armatureId, barSkeletonId, barBones } = await scene();
    useDagStore.getState().hydrate(state);

    const result = dispatchMutatorFromUI(
      'mutator.animation.retarget',
      {
        sourceId: 'walk_clip',
        sourceSkeletonId: 'walk_skel',
        targetSkeletonId: barSkeletonId,
        customMap: { Hips: barBones[0].name, Spine1: barBones[1].name },
        outputClipId: 'walk_on_bar',
        outputName: 'bar motion',
      },
      'bind',
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = useDagStore.getState().state;

    // The wiring: the retarget is the source of the Object's pose chain, under the muted base.
    expectBoundTo(after, armatureId, 'walk_on_bar');

    // The value: the Object poses exactly as the retarget does, and not as the bar's own clip.
    const retargeted = evaluate(after, 'walk_on_bar', { socket: 'posed', ctx: at(0) })
      .value as PosedSkeletonValue;
    let movedFromOwn = 0;
    for (const t of [0, 0.5, 1]) {
      const posed = objectPose(after, armatureId, t)!;
      const want = retargeted.sample(t);
      expect(posed.map((b) => b.name)).toEqual(want.map((b) => b.name));
      posed.forEach((b, i) => {
        b.quaternion.forEach((c, k) =>
          expect(c, `${b.name} q${k} @${t}`).toBeCloseTo(want[i].quaternion[k], 9),
        );
      });
      const own = objectPose(state, armatureId, t)!;
      movedFromOwn += posed.some((b, i) =>
        b.quaternion.some((c, k) => Math.abs(c - own[i].quaternion[k]) > 1e-6),
      )
        ? 1
        : 0;
    }
    expect(movedFromOwn, 'the bound walk differs from the bar’s own clip').toBeGreaterThan(0);
  });
});

/** The mesh Object an Armature modifier deforms, the modifier, and the mesh it deforms. */
function skinnedMesh(state: DagState, seconds: number) {
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const value = evaluate(state, modifierId, { ctx: at(seconds) }).value as {
    geometry: { descriptor: { data: MeshGeometryData } };
    skin: SkinDeformValue;
  };
  return { mesh: value.geometry.descriptor.data, skin: value.skin };
}

describe('#1213 — dropping a motion binds it to the native character', () => {
  it('the character is the rig that deforms a mesh; a motion’s own rig never is', async () => {
    const { state, armatureId, barSkeletonId } = await scene();
    const targets = characterTargets(state);
    expect(targets.map((t) => [t.objectId, t.skeletonId])).toEqual([[armatureId, barSkeletonId]]);
    // Another motion standing alone is not a character: a second drop says so instead of chaining.
    const motions = importMotion(
      importMotion(
        buildDefaultDagState(),
        'walk',
        readFileSync('public/assets/motion/walk.bvh', 'utf8'),
      ),
      'swing',
      BAR_SWING_BVH,
    );
    expect(characterTargets(motions)).toEqual([]);
    useDagStore.getState().hydrate(motions);
    const refused = bindMotionToCharacter(
      { motionId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(refused.ok === false && refused.refusal).toBe('no-character');
  });

  it('binds a motion onto the bar: the Object takes the retarget’s pose, the skin follows it, undo restores', async () => {
    const s0 = importMotion(
      await importNative(buildDefaultDagState(), 'skinned-bar.glb'),
      'swing',
      BAR_SWING_BVH,
    );
    const armatureId = characterTargets(s0)[0].objectId!;
    const ownPose = s0.nodes[armatureId].inputs.pose;
    useDagStore.getState().hydrate(s0);
    useSelectionStore.getState().select(null);

    const bound = bindMotionToCharacter(
      { motionId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    if (!bound.ok) return;
    expect(bound.mapped).toBe(2);
    const state = useDagStore.getState().state;
    expectBoundTo(state, armatureId, bound.clipId);
    expect(state.nodes.swing_skel_object.meta?.hidden, 'the motion’s own rig steps aside').toBe(
      true,
    );

    // The deform reads the bound motion: every vertex equals the deform driven by the retarget's
    // pose, the tip moves over the second, and it is not the bar's own clip.
    const retargeted = evaluate(state, bound.clipId, { socket: 'posed', ctx: at(0) })
      .value as PosedSkeletonValue;
    const tipMoved: number[] = [];
    for (const t of [0, 0.5, 1]) {
      const { mesh, skin } = skinnedMesh(state, t);
      const drawn = Array.from(sampleSkinDeform(skin, mesh, t));
      expect(drawn).toEqual(Array.from(sampleSkinDeform({ ...skin, pose: retargeted }, mesh, t)));
      const own = skinnedMesh(s0, t);
      tipMoved.push(
        Math.max(...drawn.map((c, i) => Math.abs(c - sampleSkinDeform(own.skin, own.mesh, t)[i]))),
      );
    }
    const { mesh, skin } = skinnedMesh(state, 0);
    expect(Array.from(sampleSkinDeform(skin, mesh, 1))).not.toEqual(
      Array.from(sampleSkinDeform(skin, mesh, 0)),
    );
    expect(Math.max(...tipMoved), 'the bound motion is not the bar’s own clip').toBeGreaterThan(
      1e-3,
    );

    // The bone draw reads the same pose.
    const rig = collectSkeletonObjects(state).find((o) => o.id === armatureId)!;
    expect(rig.pose!.sample(1)).toEqual(retargeted.sample(1));

    // One undo takes the bind back, and the bar's own clip poses it again.
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes[armatureId].inputs.pose).toEqual(ownPose);
  });

  // An oracle that is not our own code: the swing turns Bone1 by 45° and 90° about Z, and both rigs
  // rest unrotated, so the bar's top vertices (wholly Bone1's) turn by that angle about Bone1's head
  // (0, 1, 0). The bar's own clip lands elsewhere (tip (−1.0136, 0.8879) at 1 s, measured).
  it('the bound bar’s top turns by the motion’s own angle about Bone1’s head', async () => {
    const s0 = importMotion(
      await importNative(buildDefaultDagState(), 'skinned-bar.glb'),
      'swing',
      BAR_SWING_BVH,
    );
    useDagStore.getState().hydrate(s0);
    useSelectionStore.getState().select(null);
    expect(
      bindMotionToCharacter({ motionId: 'swing_clip', skeletonId: 'swing_skel' }, 'imported').ok,
    ).toBe(true);
    const state = useDagStore.getState().state;
    const { mesh, skin } = skinnedMesh(state, 0);
    const top: number[] = [];
    for (let i = 0; i < mesh.points.length / 3; i++)
      if (mesh.points[i * 3 + 1] > 2 - 1e-6) top.push(i);
    expect(top.length).toBeGreaterThan(0);
    for (const [t, degrees] of [
      [0, 0],
      [0.5, 45],
      [1, 90],
    ] as const) {
      const deformed = sampleSkinDeform(skin, mesh, t);
      const a = (degrees * Math.PI) / 180;
      for (const i of top) {
        const [x, y, z] = [mesh.points[i * 3], mesh.points[i * 3 + 1] - 1, mesh.points[i * 3 + 2]];
        const want = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a) + 1, z];
        want.forEach((c, k) =>
          expect(deformed[i * 3 + k], `vertex ${i} axis ${k} @${t}s`).toBeCloseTo(c, 5),
        );
      }
    }
  });

  it('two characters: nothing selected refuses naming both; selecting a mesh picks its rig', async () => {
    const s0 = importMotion(
      await importNative(buildDefaultDagState(), 'two-skinned-bars.glb'),
      'swing',
      BAR_SWING_BVH,
    );
    const targets = characterTargets(s0);
    // Named as Blender names the two armature Objects (#1238), so the refusal can tell them apart.
    expect(targets.map((t) => t.label)).toEqual(['SkinnedBar', 'SkinnedBarB']);
    useDagStore.getState().hydrate(s0);
    useSelectionStore.getState().select(null);
    const refused = bindMotionToCharacter(
      { motionId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(refused.ok === false && refused.refusal).toBe('ambiguous');
    for (const t of targets) expect(refused.ok === false && refused.reason).toContain(t.label);

    // Select the SECOND bar's mesh Object: data → Armature modifier → armature.
    const second = targets[1].objectId!;
    const meshObject = Object.values(s0.nodes).find((n) => {
      if (n.type !== 'Object') return false;
      const mod = s0.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? ''];
      return (
        mod?.type === 'ArmatureModifier' &&
        (mod.inputs.armature as { node: string }).node === second
      );
    })!.id;
    useSelectionStore.getState().select(meshObject);
    const bound = bindMotionToCharacter(
      { motionId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    const state = useDagStore.getState().state;
    const graph = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
    expect(poseLayerChain(graph, second).source?.socket).toBe('posed');
    // The other bar still plays its own keys: its chain reads its skeleton's rest pose.
    expect(poseLayerChain(graph, targets[0].objectId!).source?.socket).toBe('pose');
  });
});
