// #1051 — an imported node holds its rotation as the file's quaternion (Blender's shape), and the
// world it composes to is the file's own.
//
// The expected world is three.js composing the FILE's matrices (Pivot · Cube) under the import
// Group's world, which is read off the DAG for the empty's parent and so does not depend on how a
// node stores its rotation. The row is red if any node's orientation is dropped, stored in the wrong
// mode, or read from the euler.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const at = { time: { frame: 0, seconds: 0, normalized: 0 } } as never;
const ROT_CUBE: [number, number, number, number] = [0.1, 0.7, -0.3, 0.6403124237432849];
const ROT_PIVOT: [number, number, number, number] = [0, 0, 0.3826834323650898, 0.9238795325112867];

async function rotatedImport() {
  const json = JSON.parse(readFileSync('public/assets/nested-cube.gltf', 'utf8')) as {
    nodes: { name: string; translation?: number[]; rotation?: number[] }[];
  };
  const cube = json.nodes.find((n) => n.name === 'Cube')!;
  const pivot = json.nodes.find((n) => n.name === 'Pivot')!;
  cube.rotation = ROT_CUBE;
  pivot.rotation = ROT_PIVOT;
  const result = await buildNativeGltfImportOps({
    buffer: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer,
    assetRef: 'user-imports/native/rotated.gltf',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'unused',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state: DagState = buildDefaultDagState();
  for (const op of result.ops) state = applyOp(state, op).next;
  const cubeId = result.objectIds[0];
  const emptyId = Object.values(state.nodes).find((n) => {
    const kids = n.inputs.children;
    return n.type === 'Group' && Array.isArray(kids) && kids.some((k) => k.node === cubeId);
  })!.id;
  const local = (n: { translation?: number[]; rotation?: number[] }) =>
    new Matrix4().compose(
      new Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
      new Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
      new Vector3(1, 1, 1),
    );
  return { state, cubeId, emptyId, fileLocal: { cube: local(cube), pivot: local(pivot) } };
}

describe('#1051 — an imported node composes the file’s own orientation', () => {
  it('the cube’s world is the import Group’s world · Pivot · Cube, from the file', async () => {
    const { state, cubeId, emptyId, fileLocal } = await rotatedImport();
    const groupWorld = resolveParentWorldMatrix(state, emptyId, at) ?? new Matrix4();
    const want = groupWorld.clone().multiply(fileLocal.pivot).multiply(fileLocal.cube);
    const wp = new Vector3();
    const wq = new Quaternion();
    want.decompose(wp, wq, new Vector3());

    const got = resolveWorldTransform(state, cubeId, at)!;
    const gq = new Quaternion(...got.quaternion);
    expect((2 * Math.acos(Math.min(1, Math.abs(gq.dot(wq)))) * 180) / Math.PI).toBeLessThan(1e-4);
    got.position.forEach((v, i) => expect(v).toBeCloseTo(wp.toArray()[i], 9));
    // Positive control: the file's rotations are far from identity, so a dropped one is visible.
    expect((2 * Math.acos(Math.abs(ROT_CUBE[3])) * 180) / Math.PI).toBeGreaterThan(90);
  });
});
