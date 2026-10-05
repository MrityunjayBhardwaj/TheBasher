// #1210 — an Object parented to a bone stands where Blender stands it, frame by frame.
//
// Oracle: Blender 5.1.1, `ref/probes/blender-native-character/q1210_bone_prop_oracle.py`. It builds
// `skinned-bar-bone-prop.glb` — skinned-bar with its armature at (1.5, 0.25, 0) and a 0.2 cube
// parented to bone `Bone1` (the keyed one), offset and turned 30° — re-imports it, and prints the
// prop's world origin and its first corner in glTF axes at frames 0, 12 and 24 (24 fps).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { unpackMeshData } from './meshGeometryData';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';

const BLENDER = [
  { seconds: 0, origin: [1.8, 2.35, -0.2], corner: [1.7634, 2.2134, -0.3] },
  { seconds: 0.5, origin: [0.97803, 2.26368, -0.2], corner: [1.04333, 2.13824, -0.3] },
  { seconds: 1, origin: [0.43033, 1.64473, -0.2], corner: [0.56323, 1.59636, -0.3] },
] as const;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

async function imported(): Promise<{ state: DagState; propId: string }> {
  const bytes = readFileSync('public/assets/skinned-bar-bone-prop.glb');
  let state = buildDefaultDagState();
  const result = await buildNativeGltfImportOps({
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
  const propId = Object.values(state.nodes).find((n) => n.meta?.name === 'Prop')!.id;
  return { state, propId };
}

/** The prop's first mesh point, in its own space. */
function firstPoint(state: DagState, propId: string): THREE.Vector3 {
  const dataId = (state.nodes[propId].inputs.data as { node: string }).node;
  const mesh = unpackMeshData((state.nodes[dataId].params as { mesh: never }).mesh);
  return new THREE.Vector3(mesh.points[0], mesh.points[1], mesh.points[2]);
}

const at = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

describe('#1210 — an Object parented to a bone', () => {
  it('hangs under the armature’s Object and names the bone', async () => {
    const { state, propId } = await imported();
    const params = state.nodes[propId].params as { parentBone?: string };
    expect(params.parentBone).toBe('Bone1');
    const parent = Object.values(state.nodes).find((n) =>
      ((n.inputs.children as { node: string }[] | undefined) ?? []).some((r) => r.node === propId),
    )!;
    expect(parent.type).toBe('Object');
    expect(state.nodes[(parent.inputs.data as { node: string }).node].type).toBe('Skeleton');
  });

  it.each(BLENDER)(
    'stands where Blender stands it at $seconds s',
    async ({ seconds, origin, corner }) => {
      const { state, propId } = await imported();
      const world = resolveWorldTransform(state, propId, at(seconds))!;
      world.position.forEach((c, k) => expect(c, `origin axis ${k}`).toBeCloseTo(origin[k], 4));
      const m = new THREE.Matrix4().fromArray(world.matrix);
      const p = firstPoint(state, propId).applyMatrix4(m);
      p.toArray().forEach((c, k) => expect(c, `corner axis ${k}`).toBeCloseTo(corner[k], 4));
    },
  );

  it('its parent world carries the bone, so a drag converts in the bone’s space', async () => {
    const { state, propId } = await imported();
    const parent = resolveParentWorldMatrix(state, propId, at(0.5))!;
    const world = resolveWorldTransform(state, propId, at(0.5))!;
    const local = state.nodes[propId].params as {
      position: [number, number, number];
      quaternion: [number, number, number, number];
    };
    const composed = parent
      .clone()
      .multiply(
        new THREE.Matrix4().compose(
          new THREE.Vector3(...local.position),
          new THREE.Quaternion(...local.quaternion),
          new THREE.Vector3(1, 1, 1),
        ),
      );
    new THREE.Vector3()
      .setFromMatrixPosition(composed)
      .toArray()
      .forEach((c, k) => expect(c).toBeCloseTo(world.position[k], 6));
  });
});

describe('#1447 — a Group parented to a bone (an imported Empty) hangs from it as an Object does', () => {
  /** A Group with the prop's own transform, under the armature's Object, named by the bone or not. */
  async function withEmpty(parentBone: string | undefined) {
    const { state: imported_, propId } = await imported();
    let state = imported_;
    const prop = state.nodes[propId].params as Record<string, unknown>;
    const armature = Object.values(state.nodes).find((n) =>
      ((n.inputs.children as { node: string }[] | undefined) ?? []).some((r) => r.node === propId),
    )!;
    const ops = [
      {
        type: 'addNode' as const,
        nodeId: 'empty',
        nodeType: 'Group',
        params: {
          position: prop.position,
          rotation: prop.rotation,
          scale: prop.scale,
          rotationMode: prop.rotationMode,
          quaternion: prop.quaternion,
          ...(parentBone ? { parentBone } : {}),
        },
      },
      {
        type: 'connect' as const,
        from: { node: 'empty', socket: 'out' },
        to: { node: armature.id, socket: 'children' },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;
    return { state, propId };
  }

  it.each(BLENDER)(
    'stands where the prop on the same bone stands at $seconds s',
    async ({ seconds, origin }) => {
      const { state, propId } = await withEmpty('Bone1');
      const empty = resolveWorldTransform(state, 'empty', at(seconds))!;
      const prop = resolveWorldTransform(state, propId, at(seconds))!;
      empty.matrix.forEach((e, i) => expect(e, `element ${i}`).toBeCloseTo(prop.matrix[i], 9));
      empty.position.forEach((c, k) => expect(c, `origin axis ${k}`).toBeCloseTo(origin[k], 4));
    },
  );

  it('without the bone named, the same Group does not: the bone is what places it', async () => {
    const { state, propId } = await withEmpty(undefined);
    const empty = resolveWorldTransform(state, 'empty', at(1))!;
    const prop = resolveWorldTransform(state, propId, at(1))!;
    expect(
      new THREE.Vector3(...empty.position).distanceTo(new THREE.Vector3(...prop.position)),
    ).toBeGreaterThan(0.1);
  });
});
