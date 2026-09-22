// #1152 — an Object can parent. A node that both IS something (a mesh) and HOLDS something (its
// children) has one representation, as every Blender object does, instead of a mesh beside a
// Group that stands for nothing a director placed.
//
// THE REFERENCE, MEASURED. `public/assets/mesh-parent.gltf` (scripts/gen-mesh-parent-fixture.mjs)
// imported by Blender 5.1.1's own glTF importer, headless, `matrix_world` read per object and
// converted from Blender's Z-up back to glTF's Y-up (x, y, z)_gltf = (x, z, -y)_blender:
//
//   Body    mesh   parent -        world (0, 1, 0)    scale 2
//   Lamp    mesh   parent Body     world (0, 2, -2)   scale 0.5
//   Socket  empty  parent Body     world (0, 1, 2)    scale 2
//   Bulb    mesh   parent Socket   world (0, 2, 2)    scale 0.4
//
// every `matrix_parent_inverse` identity — a child's world is its parent's world times its own
// local transform. The first rows build that same tree by hand (Objects over split cubes, an
// empty as a Group) and ask for Blender's numbers; the last rows import the FILE itself through the
// native importer and ask for the same numbers of what it wrote.
//
// The parent is in QUATERNION mode with a DECOY euler, as every native import writes it: a
// reader that bypasses the resolved orientation composes the decoy and lands measurably wrong.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { ObjectNode } from '../nodes/ObjectNode';
import { makeSplitCube } from '../test-utils/splitCube';
import {
  childEdges,
  resolveParentWorldMatrix,
  resolveWorldTransform,
} from './resolveWorldTransform';
import { hierarchyChildIds, HIERARCHY_PARENT_TYPES } from './sceneHierarchy';
import { buildSceneTreeRows } from './sceneTreeWalk';
import { evaluate } from '../core/dag/evaluator';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { nodeDisplayName } from './sceneTreeWalk';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const H = Math.SQRT1_2;
/** A decoy the quaternion must win over: 45° about X, nowhere near the file's 90° about Y. */
const DECOY: [number, number, number] = [45, 0, 0];

/** The fixture's tree, by hand: Body (Object) → Lamp (Object), Body → Socket (Group) → Bulb. */
function buildTree(): DagState {
  let s = buildDefaultDagState();
  // The starter box is not part of this tree; take it out so nothing else sits at the origin.
  s = applyOp(s, {
    type: 'disconnect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  }).next;
  s = makeSplitCube(s, {
    objectId: 'body',
    position: [0, 1, 0],
    rotation: DECOY,
    scale: [2, 2, 2],
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
  const ops: Op[] = [
    { type: 'setParam', nodeId: 'body', paramPath: 'rotationMode', value: 'quaternion' },
    { type: 'setParam', nodeId: 'body', paramPath: 'quaternion', value: [0, H, 0, H] },
    {
      type: 'addNode',
      nodeId: 'socket',
      nodeType: 'Group',
      params: { position: [-1, 0, 0] },
    },
  ];
  for (const op of ops) s = applyOp(s, op).next;
  s = makeSplitCube(s, {
    objectId: 'lamp',
    position: [1, 0.5, 0],
    scale: [0.25, 0.25, 0.25],
    connectTo: { node: 'body', socket: 'children' },
  }).state;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'socket', socket: 'out' },
    to: { node: 'body', socket: 'children' },
  }).next;
  s = makeSplitCube(s, {
    objectId: 'bulb',
    position: [0, 0.5, 0],
    scale: [0.2, 0.2, 0.2],
    connectTo: { node: 'socket', socket: 'children' },
  }).state;
  return s;
}

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#1152 — an Object parents, and its children sit where Blender puts them', () => {
  it('an Object is a scene-graph parent through `children`', () => {
    expect(HIERARCHY_PARENT_TYPES.has('Object')).toBe(true);
    const s = buildTree();
    expect(hierarchyChildIds(s.nodes.body)).toEqual(['lamp', 'socket']);
  });

  it('carries `children` on its value only when it holds any', () => {
    const params = ObjectNode.paramSchema.parse({});
    const ev = (inputs: Record<string, unknown>) =>
      ObjectNode.evaluate(params, inputs, ctx as Parameters<typeof ObjectNode.evaluate>[2]);
    expect('children' in ev({})).toBe(false);
    expect('children' in ev({ children: [] })).toBe(false);
    const kid = ev({});
    expect(ev({ children: [kid] }).children).toEqual([kid]);
  });

  it('the walk pairs each evaluated child with its node, in socket order', () => {
    const s = buildTree();
    const { value } = evaluate(s, 'body', { ctx });
    expect(childEdges(s, 'body', value as never).map((e) => e.id)).toEqual(['lamp', 'socket']);
  });

  it.each([
    ['body', [0, 1, 0], [2, 2, 2]],
    ['lamp', [0, 2, -2], [0.5, 0.5, 0.5]],
    ['socket', [0, 1, 2], [2, 2, 2]],
    ['bulb', [0, 2, 2], [0.4, 0.4, 0.4]],
  ] as const)('%s lands at Blender’s world position and scale', (id, position, scale) => {
    const w = resolveWorldTransform(buildTree(), id, ctx);
    expect(w).not.toBeNull();
    expectVec(w!.position, position);
    expectVec(w!.scale, scale);
  });

  it('a child under an Object takes the Object’s world as its parent world', () => {
    const s = buildTree();
    const parent = resolveParentWorldMatrix(s, 'lamp', ctx);
    const body = resolveWorldTransform(s, 'body', ctx);
    expect(parent).not.toBeNull();
    expectVec(parent!.toArray(), body!.matrix);
  });

  it('the outliner lists an Object’s children beneath it, reparentable by their edge', () => {
    const rows = buildSceneTreeRows(buildTree());
    const at = (id: string) => rows.find((r) => r.nodeId === id)!;
    expect(at('lamp').depth).toBe(at('body').depth + 1);
    expect(at('socket').depth).toBe(at('body').depth + 1);
    expect(at('bulb').depth).toBe(at('body').depth + 2);
    expect(at('lamp').parent).toEqual({ nodeId: 'body', socket: 'children', index: 0 });
    expect(at('socket').parent).toEqual({ nodeId: 'body', socket: 'children', index: 1 });
  });
});

describe('#1152 — the file imports native, and lands where Blender puts it', () => {
  /** The fixture through the native importer, applied to the starter scene. */
  async function importFixture() {
    const bytes = readFileSync('public/assets/mesh-parent.gltf');
    const result = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      assetRef: 'user-imports/native/mesh-parent.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(`refused: ${result.refused}`);
    let s: DagState = buildDefaultDagState();
    for (const op of result.ops) s = applyOp(s, op).next;
    const idOf = (name: string) =>
      Object.values(s.nodes).find(
        (n) => nodeDisplayName(s.nodes, n.id) === name && n.type !== 'PolyMeshData',
      )!.id;
    return { s, idOf };
  }

  it('the mesh that holds children is an Object, and they hang on it', async () => {
    const { s, idOf } = await importFixture();
    expect(s.nodes[idOf('Body')].type).toBe('Object');
    expect(hierarchyChildIds(s.nodes[idOf('Body')])).toEqual([idOf('Lamp'), idOf('Socket')]);
    expect(s.nodes[idOf('Socket')].type).toBe('Group');
    expect(hierarchyChildIds(s.nodes[idOf('Socket')])).toEqual([idOf('Bulb')]);
  });

  it.each([
    ['Body', [0, 1, 0], 2],
    ['Lamp', [0, 2, -2], 0.5],
    ['Socket', [0, 1, 2], 2],
    ['Bulb', [0, 2, 2], 0.4],
  ] as const)('%s: the import’s world · Blender’s world for it', async (name, position, scale) => {
    const { s, idOf } = await importFixture();
    // The import Group places the model as a whole (its pivot at the model's centre); Blender's
    // numbers are the file's own, so they are composed under the import Group's world.
    const importWorld = resolveParentWorldMatrix(s, idOf('Body'), ctx) ?? new Matrix4();
    const want = new Vector3(...position).applyMatrix4(importWorld);
    const w = resolveWorldTransform(s, idOf(name), ctx)!;
    expectVec(w.position, want.toArray());
    expectVec(w.scale, [scale, scale, scale]);
  });
});
