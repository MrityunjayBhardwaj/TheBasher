// #1158 — an overlay keeps the typed data it does not write.
//
// A channel or a held edit on a node clones that node's value to patch it, and a Group's value
// carries its children's. The clone was JSON, which hands a typed array back as `{ "0": … }` with no
// length — so a stored mesh anywhere under an animated node lost its points, and on a cold geometry
// cache the first draw threw `meshSplitLayout: points holds undefined numbers` and unmounted the
// editor. Measured in the running app importing an animated file whose empty is keyed (#1051); here
// the same shape is built from the static nested cube with a key put on its empty.
//
// These rows build the draw's own order: the parent's overlay first, the child read out of what it
// produced, then the geometry built from a cold cache.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
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

/** The nested cube imported native with a position channel on its empty, and the raw evaluated
 *  value of that empty. */
async function animatedImport() {
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
  let state: DagState = buildDefaultDagState();
  for (const op of result.ops) state = applyOp(state, op).next;
  const cube = result.objectIds[0];
  const empty = Object.values(state.nodes).find((n) => {
    const kids = n.inputs.children;
    return n.type === 'Group' && Array.isArray(kids) && kids.some((k) => k.node === cube);
  })!.id;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: `${empty}_position_channel`,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: empty,
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
  let pivot: { id: string; value: SceneChild } | null = null;
  const find = (id: string, value: SceneChild): void => {
    for (const edge of childEdges(state, id, value)) {
      if (childEdges(state, edge.id, edge.value).some((e) => e.id === cube)) pivot = edge;
      else find(edge.id, edge.value);
    }
  };
  root.scene.children.forEach((v, i) => refs[i] && find(refs[i].node, v));
  return { state, cube, pivot: pivot! };
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

describe("#1158 — the overlay clone is JSON's, except for typed arrays", () => {
  it('agrees with a JSON round trip on every value JSON treats specially', () => {
    const odd = {
      a: 1,
      b: undefined,
      c: () => 1,
      d: [1, undefined, () => 2, NaN, Infinity, -0],
      e: new Date(0),
      f: new Map([[1, 2]]),
      g: { h: null, i: 'x', j: true },
      k: -0,
      l: [[[1]]],
    };
    // Structural, never through JSON: stringifying the clone would re-apply the very rules under
    // test (NaN → null, a hole → null) and pass a copy that broke them.
    expect(cloneForOverlay(odd)).toStrictEqual(JSON.parse(JSON.stringify(odd)));
  });

  it('hands a typed array back as the same array, and copies everything around it', () => {
    const points = new Float32Array([1, 2, 3]);
    const base = { data: { geometry: { points } }, position: [0, 1, 0] };
    const copy = cloneForOverlay(base);
    expect(copy.data.geometry.points).toBe(points);
    expect(copy.data).not.toBe(base.data);
    expect(copy.position).not.toBe(base.position);
  });
});
