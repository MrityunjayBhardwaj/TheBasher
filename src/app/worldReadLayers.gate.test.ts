// #1166 — the world read folds what the draw folds: bare channels, NLA strips and drivers.
//
// The renderer overlays a node with `useLayeredChannels` (SceneFromDAG): its bare channels, the
// channels its placed Strips contribute, then its drivers. `resolveEvaluatedTransform` folds the
// same set. `resolveWorldTransform`, which the gizmo and Apply's world read stand on, folded the
// bare channels alone, so a node moved only by a strip or a driver drew in one place while the
// gizmo sat at its static pose. Measured before the fix: the default box with a strip-only
// position (5,0,0)→(5,4,0) over 2 s draws at (5,2,0) at t = 1; the world read said (0,0,0).
//
// Every row compares against the evaluated read (the draw's fold) and states the value; the
// nested rows use `nested-cube.gltf` through the product's own import (the cube at (1,0,0) under
// an empty at (0,3,0)), so the walk descends through a node the fold has to reach.

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
function close(got: readonly number[] | null | undefined, want: readonly number[]) {
  expect(got, 'a value was read').not.toBeNull();
  got!.forEach((v, i) => expect(v, `axis ${i}`).toBeCloseTo(want[i], 6));
}

/** A Strip placing an Action that keys `paramPath` of `target` linearly `from` → `to` over 2 s. */
const strip = (target: string, paramPath: string, from: number[], to: number[]): Op[] => [
  {
    type: 'addNode',
    nodeId: `act_${target}`,
    nodeType: 'Action',
    params: {
      name: `act_${target}`,
      channels: [
        {
          valueType: 'vec3',
          paramPath,
          keyframes: [
            { time: 0, value: from },
            { time: 2, value: to },
          ],
        },
      ],
    },
  } as Op,
  {
    type: 'addNode',
    nodeId: `strip_${target}`,
    nodeType: 'Strip',
    params: { name: `strip_${target}`, action: `act_${target}`, target },
  } as Op,
  {
    type: 'addNode',
    nodeId: `trk_${target}`,
    nodeType: 'Track',
    params: { name: `trk_${target}`, strips: [`strip_${target}`], order: 0 },
  } as Op,
];

/** A ParamDriver replacing `target`'s position with the constant (k, 0, 0) — Fit with its input
 *  unconnected is fit(0, 0, 1, k, k) = k, the constant source the driver-read test uses. */
const driver = (target: string, k: number): Op[] => [
  { type: 'addNode', nodeId: `fx_${target}`, nodeType: 'Fit', params: { outMin: k, outMax: k } },
  { type: 'addNode', nodeId: `mk_${target}`, nodeType: 'MakeVec3', params: {} },
  {
    type: 'connect',
    from: { node: `fx_${target}`, socket: 'out' },
    to: { node: `mk_${target}`, socket: 'x' },
  },
  {
    type: 'addNode',
    nodeId: `drv_${target}`,
    nodeType: 'ParamDriver',
    params: { target, paramPath: 'position', blendMode: 'replace', order: 0 },
  },
  {
    type: 'connect',
    from: { node: `mk_${target}`, socket: 'out' },
    to: { node: `drv_${target}`, socket: 'in' },
  },
];

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

describe('#1166 — a top-level node: the world read folds strips and drivers', () => {
  it('a strip-only position is read where it is drawn, (5, 2, 0) at t = 1', () => {
    const s = run(buildDefaultDagState(), strip('n_box', 'position', [5, 0, 0], [5, 4, 0]));
    close(resolveEvaluatedTransform(s, 'n_box', at(1))?.position, [5, 2, 0]);
    close(resolveWorldTransform(s, 'n_box', at(1))?.position, [5, 2, 0]);
  });

  it('a driver-only position is read where it is drawn, (7, 0, 0)', () => {
    const s = run(buildDefaultDagState(), driver('n_box', 7));
    close(resolveEvaluatedTransform(s, 'n_box', at(1))?.position, [7, 0, 0]);
    close(resolveWorldTransform(s, 'n_box', at(1))?.position, [7, 0, 0]);
  });

  it('a light moved only by a strip is read where it is drawn, (2, 6, 3) at t = 1', () => {
    const s = run(buildDefaultDagState(), strip('n_light', 'position', [0, 5, 3], [4, 7, 3]));
    close(resolveWorldTransform(s, 'n_light', at(1))?.position, [2, 6, 3]);
  });

  it('positive control: the light with no strip reads its authored (5, 5, 3)', () => {
    close(resolveWorldTransform(buildDefaultDagState(), 'n_light', at(1))?.position, [5, 5, 3]);
  });

  it('positive control: with neither, the box reads its static pose', () => {
    const s = buildDefaultDagState();
    close(
      resolveWorldTransform(s, 'n_box', at(1))?.position,
      resolveEvaluatedTransform(s, 'n_box', at(1))!.position,
    );
  });
});

describe('#1166 — nested: the fold reaches every depth the walk descends', () => {
  it('a strip on the nested cube moves its world read, (3, 3, 0) at t = 1', async () => {
    const { state, cube } = await imported();
    const s = run(state, strip(cube, 'position', [1, 0, 0], [5, 0, 0]));
    close(resolveWorldTransform(s, cube, at(1))?.position, [3, 3, 0]);
  });

  it('a strip on the nested EMPTY moves the cube it holds, (1, 4, 0) at t = 1', async () => {
    const { state, cube, empty } = await imported();
    const s = run(state, strip(empty, 'position', [0, 3, 0], [0, 5, 0]));
    close(resolveWorldTransform(s, cube, at(1))?.position, [1, 4, 0]);
    const parent = resolveParentWorldMatrix(s, cube, at(1));
    expect(parent, 'the parent world is non-trivial').not.toBeNull();
    close([parent!.elements[12], parent!.elements[13], parent!.elements[14]], [0, 4, 0]);
  });

  it('a driver on the nested EMPTY moves the cube it holds, (1 + 6, 0, 0)', async () => {
    const { state, cube, empty } = await imported();
    const s = run(state, driver(empty, 6));
    close(resolveWorldTransform(s, cube, at(1))?.position, [7, 0, 0]);
  });
});
