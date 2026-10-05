// #1158 — an overlay keeps the typed data it does not write.
//
// A channel or a held edit on a node clones that node's value to patch it, and a Group's value
// carries its children's. The clone was JSON, which hands a typed array back as `{ "0": … }` with no
// length — so a stored mesh anywhere under an animated node lost its points, and on a cold geometry
// cache the first draw threw `meshSplitLayout: points holds undefined numbers` and unmounted the
// editor. Measured in the running app importing an animated file whose empty is keyed (#1051); here
// the same shape is built on the plain native cube import, with a key put on its import Group.
//
// #1236 replaced the JSON clone with a copy of only the paths an overlay writes, so a typed array is
// now shared like every other unwritten object; the last block pins that contract.
//
// These rows build the draw's own order: the parent's overlay first, the child read out of what it
// produced, then the geometry built from a cold cache.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import type { Op } from '../core/dag/types';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { childEdges } from './resolveWorldTransform';
import { directChannelValuesForTarget } from './nodeChannels';
import { cloneForOverlay, overlayChannels } from '../nodes/overlayChannels';
import { overlayTransients } from './overlayTransients';
import { overlayWithIdentity } from './overlayWithIdentity';
import * as geometryRegistry from './geometryRegistry';
import type { SceneChild } from '../nodes/types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  geometryRegistry.clear();
});

/** The cube imported native — the import Group holding one Object and its stored mesh — with a
 *  position channel on that Group, and the Group's raw evaluated value. */
async function animatedImport() {
  const bytes = readFileSync('public/assets/cube.gltf');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/cube.gltf',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'unused',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state: DagState = buildDefaultDagState();
  for (const op of result.ops) state = applyOp(state, op).next;
  const cube = result.objectIds[0];
  // #1451 — an import stands its Object in the scene with no wrapper Group, so the parent this
  // gate is about is made here: a Group under the scene holding the stored mesh.
  const group = 'n_holder';
  const sceneId = state.outputs.scene!.node;
  for (const op of [
    { type: 'addNode', nodeId: group, nodeType: 'Group', params: {} },
    {
      type: 'disconnect',
      from: { node: cube, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: cube, socket: 'out' },
      to: { node: group, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: group, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
  ] as Op[])
    state = applyOp(state, op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: `${group}_position_channel`,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: group,
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 3, 0], easing: 'linear' },
        { time: 2, value: [0, 4, 0], easing: 'linear' },
      ],
    },
  }).next;
  const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const root = evaluate(state, state.outputs.render!.node, { ctx }).value as {
    scene: { children: SceneChild[] };
  };
  const refs = state.nodes[state.outputs.scene!.node].inputs.children as { node: string }[];
  const at = refs.findIndex((r) => r.node === group);
  expect(at, 'the Group is a scene child').toBeGreaterThanOrEqual(0);
  const pivot = { id: group, value: root.scene.children[at] };
  expect(
    childEdges(state, pivot.id, pivot.value).some((e) => e.id === cube),
    'the cube sits directly under the Group',
  ).toBe(true);
  return { state, cube, pivot };
}
const cubeUnder = (state: DagState, pivotId: string, pivotValue: SceneChild, cube: string) =>
  childEdges(state, pivotId, pivotValue).find((e) => e.id === cube)!.value;
const build = (value: SceneChild) =>
  geometryRegistry.getForAttach((value as unknown as { data: { geometry: never } }).data.geometry);

describe('#1158 — a stored mesh under an overlaid node keeps its data', () => {
  it('under a KEYED parent, the child builds from a cold cache', async () => {
    const { state, cube, pivot } = await animatedImport();
    const channels = directChannelValuesForTarget(state.nodes, pivot.id);
    expect(channels.length, 'the empty is keyed').toBeGreaterThan(0);
    const patched = overlayWithIdentity(
      'children',
      pivot.value,
      pivot.id,
      channels,
      new Map(),
      0.3,
    );
    expect(patched, 'the parent overlay did clone').not.toBe(pivot.value);
    expect(() => build(cubeUnder(state, pivot.id, patched, cube))).not.toThrow();
  });

  it('under a parent with a HELD edit, the child builds from a cold cache', async () => {
    const { state, cube, pivot } = await animatedImport();
    const held = new Map([
      ['e', { nodeId: pivot.id, paramPath: 'position', value: [0, 9, 0] }],
    ]) as unknown as Parameters<typeof overlayTransients>[2];
    const patched = overlayTransients(pivot.value, pivot.id, held)!;
    expect(patched).not.toBe(pivot.value);
    expect(() => build(cubeUnder(state, pivot.id, patched, cube))).not.toThrow();
  });

  it('the overlay still clones: the written field changes on the copy, never on the base', async () => {
    const { state, pivot } = await animatedImport();
    const channels = directChannelValuesForTarget(state.nodes, pivot.id);
    const before = JSON.stringify((pivot.value as unknown as { position: number[] }).position);
    const patched = overlayChannels(pivot.value, channels, 1, 1)!;
    expect((patched as unknown as { position: number[] }).position[1]).toBeCloseTo(3.5, 6);
    expect(JSON.stringify((pivot.value as unknown as { position: number[] }).position)).toBe(
      before,
    );
  });
});

describe('#1236 — an overlay copies only the paths it writes, and shares the rest', () => {
  /** Freeze a value and everything under it, so any write that escapes the copy throws. */
  function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
    return value;
  }
  const at = (path: string, value: unknown) =>
    ({
      kind: 'KeyframeChannel',
      name: 'c',
      target: 't',
      paramPath: path,
      valueType: typeof value === 'number' ? 'number' : 'vec3',
      sample: () => value,
    }) as never;

  it('shares what it does not write — typed arrays, functions, clips — as the same objects', () => {
    const points = new Float32Array([1, 2, 3]);
    const sample = (s: number) => [s];
    const action = { keyframes: [{ time: 0 }] };
    const base = deepFreeze({
      data: { geometry: { points } },
      pose: { kind: 'PosedSkeleton', sample },
      action,
      position: [0, 1, 0],
    });
    const out = overlayChannels(base, [at('position', [5, 0, 0])], 1, 0) as typeof base;
    expect(out).not.toBe(base);
    expect(out.position).toEqual([5, 0, 0]);
    expect(out.data).toBe(base.data);
    expect(out.data.geometry.points).toBe(points);
    expect(out.pose).toBe(base.pose);
    expect(out.pose.sample).toBe(sample);
    expect(out.action).toBe(action);
  });

  it('a write below the root copies its path and never reaches the base', () => {
    const base = deepFreeze({
      data: { size: [1, 1, 1], other: { keep: true } },
      position: [0, 0, 0],
    });
    // A frozen base throws on any write that escapes the copy, so reaching here green is the proof.
    const out = overlayChannels(base, [at('data.size.1', 4)], 1, 0) as typeof base;
    expect(out.data.size).toEqual([1, 4, 1]);
    expect(base.data.size).toEqual([1, 1, 1]);
    expect(out.data).not.toBe(base.data);
    expect(out.data.size).not.toBe(base.data.size);
    expect(out.data.other).toBe(base.data.other);
    expect(out.position).toBe(base.position);
  });

  it('a held edit on top of a channel, and the identity repair, write only into copies', () => {
    const base = deepFreeze({ data: { size: [1, 1, 1] }, position: [0, 0, 0] });
    const edits = new Map([
      ['t:data.size.0', { nodeId: 't', paramPath: 'data.size.0', value: 9 }],
    ]) as never;
    const out = overlayWithIdentity(
      'children',
      base,
      't',
      [at('data.size.1', 4)],
      edits,
      0,
    ) as typeof base;
    expect(out.data.size).toEqual([9, 4, 1]);
    expect(base.data.size).toEqual([1, 1, 1]);
    // The held edit's own copy never wrote into the channel overlay's intermediate either.
    const channelOnly = overlayChannels(base, [at('data.size.1', 4)], 1, 0) as typeof base;
    expect(channelOnly.data.size).toEqual([1, 4, 1]);
  });

  it('the no-write road still hands the base back by reference', () => {
    const base = deepFreeze({ position: [0, 0, 0] });
    expect(overlayChannels(base, [], 1, 0)).toBe(base);
    expect(overlayTransients(base, 't', new Map())).toBe(base);
    expect(cloneForOverlay(base)).not.toBe(base);
  });
});
