// #268 — a nested node's animation is READ where it is DRAWN.
//
// The renderer overlays channels at every depth (GroupR → RenderChild → DirectChannelsR, #266); the
// two reads the gizmo and inspector stand on overlaid only TOP-LEVEL scene children. So a channel on
// a nested node, or on a nested ancestor, moved the drawn mesh and left the read on the static pose.
// Every node of an import is nested (under the import Group), so an animated import hit it on every
// node.
//
// Expected values are the DRAWN ones, measured in the running app on this same fixture: the empty
// keyed y 3→5 over 2 s draws the cube at (1, 4, 0) at t = 1; the cube keyed x 1→5 draws it at
// (3, 3, 0). Each row was red before the fix.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const at = (seconds: number) =>
  ({ time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } }) as never;
function run(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** `nested-cube.gltf` through the product's own import: the cube at (1,0,0) under an empty at
 *  (0,3,0), both under the import Group. */
async function imported() {
  const bytes = readFileSync('public/assets/nested-cube.gltf');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/nested-cube.gltf',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'unused',
  });
  if ('refused' in result) throw new Error(result.refused);
  const state = run(buildDefaultDagState(), result.ops);
  const cube = result.objectIds[0];
  const empty = Object.values(state.nodes).find((n) => {
    const kids = n.inputs.children;
    return n.type === 'Group' && Array.isArray(kids) && kids.some((k) => k.node === cube);
  })!.id;
  return { state, cube, empty };
}

const channel = (id: string, target: string, paramPath: string, keys: unknown[]): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: paramPath === 'quaternion' ? 'KeyframeChannelQuat' : 'KeyframeChannelVec3',
  params: { name: paramPath, target, paramPath, keyframes: keys },
});
const lin = (time: number, value: number[]) => ({ time, value, easing: 'linear' });

function close(got: readonly number[] | null | undefined, want: readonly number[]) {
  expect(got, 'a value was read').not.toBeNull();
  got!.forEach((v, i) => expect(v, `axis ${i}`).toBeCloseTo(want[i], 6));
}

describe('#268 — the world read overlays every depth', () => {
  it('positive control: static, the read and the draw agree at (1, 3, 0)', async () => {
    const { state, cube } = await imported();
    close(resolveWorldTransform(state, cube, at(1))?.position, [1, 3, 0]);
  });

  it('a keyed nested ANCESTOR moves the child it holds (drawn at (1, 4, 0))', async () => {
    const { state, cube, empty } = await imported();
    const s = run(state, [
      channel('ch', empty, 'position', [lin(0, [0, 3, 0]), lin(2, [0, 5, 0])]),
    ]);
    close(resolveWorldTransform(s, cube, at(1))?.position, [1, 4, 0]);
    // The gizmo's anchor is the parent world: it has to move with the empty too.
    const parent = resolveParentWorldMatrix(s, cube, at(1));
    expect(parent?.elements[13]).toBeCloseTo(4, 6);
  });

  it("a nested node's OWN channel moves it (drawn at (3, 3, 0))", async () => {
    const { state, cube } = await imported();
    const s = run(state, [channel('ch', cube, 'position', [lin(0, [1, 0, 0]), lin(2, [5, 0, 0])])]);
    close(resolveWorldTransform(s, cube, at(1))?.position, [3, 3, 0]);
  });

  it('a keyed quaternion on a nested ancestor in quaternion mode turns the child', async () => {
    const { state, cube, empty } = await imported();
    const s = run(state, [
      { type: 'setParam', nodeId: empty, paramPath: 'rotationMode', value: 'quaternion' },
      { type: 'setParam', nodeId: empty, paramPath: 'quaternion', value: [0, 0, 0, 1] },
      channel('ch', empty, 'quaternion', [
        lin(0, [0, 0, 0, 1]),
        lin(1, [0, 0, Math.SQRT1_2, Math.SQRT1_2]),
      ]),
    ]);
    // The cube's (1, 0, 0) turned 90° about Z is (0, 1, 0), inside the empty at (0, 3, 0).
    close(resolveWorldTransform(s, cube, at(1))?.position, [0, 4, 0]);
  });
});

describe('#268 — the evaluated read (gizmo + inspector) finds a nested node', () => {
  it('a static nested node reads its own local pose, where it returned null', async () => {
    const { state, cube } = await imported();
    close(resolveEvaluatedTransform(state, cube, at(0))?.position, [1, 0, 0]);
  });

  it("a nested node's own channel is read, in its parent's space", async () => {
    const { state, cube } = await imported();
    const s = run(state, [channel('ch', cube, 'position', [lin(0, [1, 0, 0]), lin(2, [5, 0, 0])])]);
    close(resolveEvaluatedTransform(s, cube, at(1))?.position, [3, 0, 0]);
  });

  it('a keyed nested empty reads its keyed pose', async () => {
    const { state, empty } = await imported();
    const s = run(state, [
      channel('ch', empty, 'position', [lin(0, [0, 3, 0]), lin(2, [0, 5, 0])]),
    ]);
    close(resolveEvaluatedTransform(s, empty, at(1))?.position, [0, 4, 0]);
  });
});
