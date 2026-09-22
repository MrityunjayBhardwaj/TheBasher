// #1185 — Apply Transform on an Object that holds children leaves them where they are drawn.
//
// Once an Object could parent (#1152), Apply on one did two wrong things, measured: on the
// primitive road it rebuilt the Object and wired back only its `data`, so the children fell out of
// the scene (Apply still said ok); on the stored-mesh road nothing re-solved them, so they moved by
// whatever Apply took out of the parent. Blender keeps every child in place (`ignore_parent_tx`,
// `object_transform.cc:536-556`; measured on 5.1.1 — child deviation 1.2e-7 — in
// GROUND_TRUTH_BLENDER_TRANSFORM_APPLY Q6b). What a position, rotation and scale cannot hold
// (a shear), or an animated child, is refused by name instead.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { buildDefaultDagState } from '../../core/project/default';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import * as geometryRegistry from '../geometryRegistry';
import { resolveWorldTransform } from '../resolveWorldTransform';
import { hierarchyChildIds } from '../sceneHierarchy';
import { nodeDisplayName } from '../sceneTreeWalk';
import { makeSplitCube } from '../../test-utils/splitCube';
import { dispatchApplyTransform } from './dispatchApplyTransform';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } } as never;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  geometryRegistry.clear();
});

/** Body (a box: at (0,1,0), 90° about Y, scale 2) holding Lamp (a box) and Socket (a Group with a
 *  pivot) holding nothing; Lamp can be put in quaternion mode over a decoy euler. */
function primitiveTree(opts: { lampQuaternion?: boolean; bodyScale?: number[] } = {}): DagState {
  let s: DagState = buildDefaultDagState();
  s = makeSplitCube(s, {
    objectId: 'body',
    position: [0, 1, 0],
    rotation: [0, 90, 0],
    scale: (opts.bodyScale ?? [2, 2, 2]) as [number, number, number],
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
  s = makeSplitCube(s, {
    objectId: 'lamp',
    position: [1, 0.5, 0],
    rotation: [0, 0, 30],
    scale: [0.25, 0.25, 0.25],
    connectTo: { node: 'body', socket: 'children' },
  }).state;
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'socket',
      nodeType: 'Group',
      params: { position: [-1, 0, 0], rotation: [10, 0, 0], pivot: [0.3, 0, 0] },
    },
    {
      type: 'connect',
      from: { node: 'socket', socket: 'out' },
      to: { node: 'body', socket: 'children' },
    },
  ];
  if (opts.lampQuaternion) {
    ops.push(
      { type: 'setParam', nodeId: 'lamp', paramPath: 'rotation', value: [45, 0, 0] }, // decoy
      { type: 'setParam', nodeId: 'lamp', paramPath: 'rotationMode', value: 'quaternion' },
      {
        type: 'setParam',
        nodeId: 'lamp',
        paramPath: 'quaternion',
        value: [0, 0, 0.2588190451, 0.9659258263],
      },
    );
  }
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

async function apply(state: DagState, id: string, mask: 'all' | 'location' | 'rotation' | 'scale') {
  const ref = { current: state };
  const calls: Op[][] = [];
  const result = await dispatchApplyTransform(id, mask, {
    state,
    storage: new MemoryStorage(),
    currentFrame: 0,
    dispatchAtomic: (ops: Op[]) => {
      calls.push(ops);
      for (const op of ops) ref.current = applyOp(ref.current, op).next;
      return [];
    },
    setSelection: () => {},
  });
  return { result, after: ref.current, calls };
}

function expectSameWorld(before: DagState, after: DagState, id: string): void {
  const a = resolveWorldTransform(before, id, ctx);
  const b = resolveWorldTransform(after, id, ctx);
  expect(a, `${id} before`).not.toBeNull();
  expect(b, `${id} after — still in the scene`).not.toBeNull();
  const m = (w: { matrix: number[] }) => w.matrix;
  m(b!).forEach((v, i) => expect(v, `${id} world[${i}]`).toBeCloseTo(m(a!)[i], 6));
}

describe('#1185 — Apply on a parent Object keeps its children where they are drawn', () => {
  it.each(['scale', 'rotation', 'location', 'all'] as const)(
    'primitive road, Apply %s: the children stay held, and stay put',
    async (mask) => {
      const before = primitiveTree();
      const { result, after } = await apply(before, 'body', mask);
      expect(result.ok).toBe(true);
      expect(hierarchyChildIds(after.nodes.body)).toEqual(['lamp', 'socket']);
      expectSameWorld(before, after, 'lamp');
      expectSameWorld(before, after, 'socket');
    },
  );

  it('a quaternion-mode child stays in quaternion mode, re-solved through its quaternion', async () => {
    const before = primitiveTree({ lampQuaternion: true });
    const { result, after } = await apply(before, 'body', 'all');
    expect(result.ok).toBe(true);
    expect((after.nodes.lamp.params as { rotationMode?: string }).rotationMode).toBe('quaternion');
    // the decoy was not rewritten into the quaternion's place
    expect((after.nodes.lamp.params as { rotation: number[] }).rotation).toEqual([45, 0, 0]);
    expectSameWorld(before, after, 'lamp');
  });

  it('stored-mesh road (the native import): Apply all keeps every child in place', async () => {
    const bytes = readFileSync('public/assets/mesh-parent.gltf');
    const r = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      assetRef: 'user-imports/native/mesh-parent.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'unused',
    });
    if ('refused' in r) throw new Error(r.refused);
    let before: DagState = buildDefaultDagState();
    for (const op of r.ops) before = applyOp(before, op).next;
    const id = (name: string) =>
      Object.values(before.nodes).find(
        (n) => nodeDisplayName(before.nodes, n.id) === name && n.type !== 'PolyMeshData',
      )!.id;
    const { result, after } = await apply(before, id('Body'), 'all');
    expect(result.ok).toBe(true);
    // In place: the Body is the same node, still holding both.
    expect(hierarchyChildIds(after.nodes[id('Body')])).toEqual([id('Lamp'), id('Socket')]);
    for (const name of ['Lamp', 'Socket', 'Bulb']) expectSameWorld(before, after, id(name));
  });

  it('a shear the child cannot hold is refused by name, and nothing is written', async () => {
    // Body scaled (2,1,1) and NOT turned, Lamp turned 30° about Z: taking the scale out would
    // shear the Lamp.
    let before = primitiveTree({ bodyScale: [2, 1, 1] });
    before = applyOp(before, {
      type: 'setParam',
      nodeId: 'body',
      paramPath: 'rotation',
      value: [0, 0, 0],
    }).next;
    const { result, calls } = await apply(before, 'body', 'scale');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('would shear it');
    expect(!result.ok && result.reason).toContain('lamp');
    expect(calls).toEqual([]);
  });

  it('a uniform scale over the same turned child is not a shear, and applies', async () => {
    let before = primitiveTree({ bodyScale: [2, 2, 2] });
    before = applyOp(before, {
      type: 'setParam',
      nodeId: 'body',
      paramPath: 'rotation',
      value: [0, 0, 0],
    }).next;
    const { result, after } = await apply(before, 'body', 'scale');
    expect(result.ok).toBe(true);
    expectSameWorld(before, after, 'lamp');
  });

  it('an animated child is refused by name, and nothing is written', async () => {
    let before = primitiveTree();
    before = applyOp(before, {
      type: 'addNode',
      nodeId: 'lamp_pos',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 'lamp',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [1, 0.5, 0], easing: 'linear' },
          { time: 1, value: [1, 1.5, 0], easing: 'linear' },
        ],
      },
    }).next;
    const { result, calls } = await apply(before, 'body', 'all');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('is animated');
    expect(calls).toEqual([]);
  });
});
