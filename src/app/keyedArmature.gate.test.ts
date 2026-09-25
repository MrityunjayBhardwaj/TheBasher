// #1224 — keying an armature Object, or the skinned mesh's Object, leaves its motion playing.
//
// The pose wire ends on the armature Object (`ObjectValue.pose`), and a pose samples through a
// closure. An overlay on a keyed Object once copied the value JSON-style and dropped every function,
// so a director who keyed the armature would have stopped the prop on its bone and the skin with
// nothing said. Since #1236 the overlay copies only the paths it writes. These rows key both
// Objects the way the product does (a direct position channel) and read through the shipped
// roads: the world resolver for the bone-parented prop, the render overlay for the skin, the
// armature band for the bone draw.
//
// Each key holds the Object's own position, so nothing should move because of it: the keyed answer
// must equal the unkeyed one, which `boneParent.test.ts` and `armatureDeform.test.ts` hold to
// Blender 5.1.1 (`q1210_bone_prop_oracle.py`).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { __buildSkinnedNativeGltfImportOpsForTests } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { sampleSkinDeform } from '../nodes/armatureDeform';
import type { ObjectValue, SkinDeformValue } from '../nodes/types';
import { directChannelValuesForTarget } from './nodeChannels';
import { overlayWithIdentity } from './overlayWithIdentity';
import { resolveWorldTransform } from './resolveWorldTransform';
import { collectSkeletonObjects } from './skeletonObjects';

/** Blender's prop origin, frames 0 / 12 / 24 at 24 fps (`boneParent.test.ts`). */
const BLENDER = [
  { seconds: 0, origin: [1.8, 2.35, -0.2] },
  { seconds: 0.5, origin: [0.97803, 2.26368, -0.2] },
  { seconds: 1, origin: [0.43033, 1.64473, -0.2] },
] as const;

const at = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

async function imported() {
  const bytes = readFileSync('public/assets/skinned-bar-bone-prop.glb');
  let state = buildDefaultDagState();
  const result = await __buildSkinnedNativeGltfImportOpsForTests({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar-bone-prop.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  const nodes = Object.values(state.nodes);
  const propId = nodes.find((n) => n.meta?.name === 'Prop')!.id;
  const modifierId = nodes.find((n) => n.type === 'ArmatureModifier')!.id;
  const armatureId = (state.nodes[modifierId].inputs.armature as { node: string }).node;
  const meshId = nodes.find(
    (n) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === modifierId,
  )!.id;
  return { state, propId, armatureId, meshId };
}

/** Key `target`'s position where it already stands, as the product keys an Object. */
function keyInPlace(state: DagState, target: string): DagState {
  const position = (state.nodes[target].params as { position: number[] }).position;
  return applyOp(state, {
    type: 'addNode',
    nodeId: `${target}_position_channel`,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target,
      paramPath: 'position',
      keyframes: [
        { time: 0, value: position, easing: 'linear' },
        { time: 1, value: position, easing: 'linear' },
      ],
    },
  }).next;
}

/** What the renderer draws the mesh Object's skin by: its value, through the render overlay. */
function drawnSkin(state: DagState, meshId: string, seconds: number): SkinDeformValue {
  const value = evaluate(state, meshId, { ctx: at(seconds) }).value as ObjectValue;
  const channels = directChannelValuesForTarget(state.nodes, meshId);
  const drawn = overlayWithIdentity('children', value, meshId, channels, new Map(), seconds);
  return (drawn.data as { skin: SkinDeformValue }).skin;
}

describe('#1224 — a keyed armature keeps its motion', () => {
  it('the keys are real: both Objects carry a channel', async () => {
    const { state: s0, armatureId, meshId } = await imported();
    const state = keyInPlace(keyInPlace(s0, armatureId), meshId);
    expect(directChannelValuesForTarget(state.nodes, armatureId).length).toBe(1);
    expect(directChannelValuesForTarget(state.nodes, meshId).length).toBe(1);
  });

  it.each(BLENDER)(
    'a prop on a bone of a KEYED armature stands where Blender stands it at $seconds s',
    async ({ seconds, origin }) => {
      const { state: s0, propId, armatureId } = await imported();
      const state = keyInPlace(s0, armatureId);
      const world = resolveWorldTransform(state, propId, at(seconds))!;
      world.position.forEach((c, k) => expect(c, `origin axis ${k}`).toBeCloseTo(origin[k], 4));
    },
  );

  it('the skin of a KEYED mesh Object deforms as the unkeyed one does, and moves', async () => {
    const { state: s0, meshId } = await imported();
    const state = keyInPlace(s0, meshId);
    const plain = drawnSkin(s0, meshId, 0);
    const keyed = drawnSkin(state, meshId, 0);
    expect(typeof keyed.pose?.sample, 'the pose survived the overlay').toBe('function');
    const modifier = evaluate(state, (state.nodes[meshId].inputs.data as { node: string }).node, {
      ctx: at(0),
    }).value as { geometry: { descriptor: { kind: string; data: never } } };
    const mesh = modifier.geometry.descriptor.data;
    for (const t of [0, 0.5, 1]) {
      expect(Array.from(sampleSkinDeform(keyed, mesh, t))).toEqual(
        Array.from(sampleSkinDeform(plain, mesh, t)),
      );
    }
    expect(Array.from(sampleSkinDeform(keyed, mesh, 1))).not.toEqual(
      Array.from(sampleSkinDeform(keyed, mesh, 0)),
    );
  });

  it('the bone draw of a KEYED armature is posed, and moves', async () => {
    const { state: s0, armatureId } = await imported();
    const state = keyInPlace(s0, armatureId);
    const rig = collectSkeletonObjects(state).find((o) => o.id === armatureId)!;
    expect(rig.pose).not.toBeNull();
    expect(rig.pose!.sample(1)).not.toEqual(rig.pose!.sample(0));
  });
});
