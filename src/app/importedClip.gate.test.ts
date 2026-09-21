// #1051 — an imported clip plays as the glTF spec defines it, through the native model.
//
// `anim-nested.gltf` animates a cube (rotation LINEAR, scale STEP, translation CUBICSPLINE) under
// an empty (translation LINEAR, rotation STEP). At each sampled time the expected world is built
// from the SPEC's formulas (Appendix C, written out below) composed by three.js under the import
// Group's world, and compared with the cube's world as the product reads it — through the channels
// the import wrote, the nested overlay, and quaternion mode together.

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
const at = (seconds: number) =>
  ({ time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } }) as never;
const D2R = Math.PI / 180;
const axisAngle = (axis: number[], deg: number) =>
  new Quaternion().setFromAxisAngle(
    new Vector3(...(axis as [number, number, number])).normalize(),
    deg * D2R,
  );

// ── The spec's values for the fixture's clip (scripts/gen-anim-nested-fixture.mjs) ────────────
/** The segment [times[k], times[k+1]] holding t (the last one at and past its end), and u in it. */
const segment = (times: number[], t: number) => {
  let k = 0;
  while (k < times.length - 2 && t >= times[k + 1]) k++;
  const u = Math.min(1, Math.max(0, (t - times[k]) / (times[k + 1] - times[k])));
  return { k, u, td: times[k + 1] - times[k] };
};
const clampT = (t: number, times: number[]) =>
  Math.min(Math.max(t, times[0]), times[times.length - 1]);
function pivotTranslation(t: number) {
  const u = clampT(t, [0, 2]) / 2;
  return new Vector3(0, 3 + u, 0);
}
function pivotRotation(t: number) {
  const held = t < 1 ? 0 : t < 2 ? 90 : 0; // STEP, C.2
  return axisAngle([0, 0, 1], held);
}
function cubeRotation(t: number) {
  const K = [axisAngle([0, 1, 0], 0), axisAngle([1, 1, 0], 170), axisAngle([0, 0, 1], 90)];
  const { k, u } = segment([0, 1, 2], clampT(t, [0, 2]));
  return K[k].clone().slerp(K[k + 1], u); // C.4; three's slerp takes the short path as C.4 does
}
function cubeScale(t: number) {
  const s = t < 1 ? 1 : t < 2 ? 2 : 1;
  return new Vector3(s, s, s);
}
function cubeTranslation(t: number) {
  const T = [0, 0.5, 2];
  const V = [
    [1, 0, 0],
    [2, 1, 0],
    [1, 0, 1],
  ];
  const IN = [
    [0, 0, 0],
    [8, -6, 2],
    [-5, 4, 9],
  ];
  const OUT = [
    [6, 5, -3],
    [-4, 7, 1],
    [0, 0, 0],
  ];
  const { k, u, td } = segment(T, clampT(t, [0, 2]));
  const h = (c: number) =>
    (2 * u ** 3 - 3 * u ** 2 + 1) * V[k][c] +
    td * (u ** 3 - 2 * u ** 2 + u) * OUT[k][c] +
    (-2 * u ** 3 + 3 * u ** 2) * V[k + 1][c] +
    td * (u ** 3 - u ** 2) * IN[k + 1][c]; // C.5
  return new Vector3(h(0), h(1), h(2));
}

async function importAnimated(file = 'public/assets/anim-nested.gltf') {
  const bytes = readFileSync(file);
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/anim-nested.gltf',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'unused',
  });
  return result;
}

describe('#1051 — an imported clip plays as the spec defines it', () => {
  it('the cube’s world matches the spec’s clip, composed, at 21 times across and past the clip', async () => {
    const result = await importAnimated();
    if ('refused' in result) throw new Error(result.refused);
    let state: DagState = buildDefaultDagState();
    for (const op of result.ops) state = applyOp(state, op).next;
    const cube = result.objectIds[0];
    const pivot = Object.values(state.nodes).find((n) => {
      const kids = n.inputs.children;
      return n.type === 'Group' && Array.isArray(kids) && kids.some((k) => k.node === cube);
    })!.id;

    let worstDeg = 0;
    let worstPos = 0;
    let checked = 0;
    for (let i = 0; i <= 20; i++) {
      const t = -0.25 + (2.5 * i) / 20; // before the first key and after the last: clamped (:2806)
      const groupWorld = resolveParentWorldMatrix(state, pivot, at(t)) ?? new Matrix4();
      const want = groupWorld
        .clone()
        .multiply(
          new Matrix4().compose(pivotTranslation(t), pivotRotation(t), new Vector3(1, 1, 1)),
        )
        .multiply(new Matrix4().compose(cubeTranslation(t), cubeRotation(t), cubeScale(t)));
      const wp = new Vector3();
      const wq = new Quaternion();
      want.decompose(wp, wq, new Vector3());
      const got = resolveWorldTransform(state, cube, at(t))!;
      const gq = new Quaternion(...got.quaternion);
      worstDeg = Math.max(worstDeg, (2 * Math.acos(Math.min(1, Math.abs(gq.dot(wq))))) / D2R);
      worstPos = Math.max(worstPos, new Vector3(...got.position).distanceTo(wp));
      checked++;
    }
    expect(checked).toBe(21);
    expect(worstDeg).toBeLessThan(1e-3);
    expect(worstPos).toBeLessThan(1e-5);
  });

  it('the channels are the ones Auto-Key would make: type, id, name, target, no file reference', async () => {
    const result = await importAnimated();
    if ('refused' in result) throw new Error(result.refused);
    const channels = result.ops.filter(
      (o): o is Extract<typeof o, { type: 'addNode' }> =>
        o.type === 'addNode' && o.nodeType.startsWith('KeyframeChannel'),
    );
    expect(channels).toHaveLength(5);
    for (const c of channels) {
      const p = c.params as Record<string, unknown>;
      expect(c.nodeId).toBe(`${p.target as string}_${p.paramPath as string}_channel`);
      expect(p.name).toBe(p.paramPath);
      expect(c.nodeType).toBe(
        p.paramPath === 'quaternion' ? 'KeyframeChannelQuat' : 'KeyframeChannelVec3',
      );
      // A format stops existing at import: nothing names the file or its node names.
      expect(Object.keys(p).sort()).toEqual(['keyframes', 'name', 'paramPath', 'target']);
    }
  });

  it('a file that cannot come across is refused whole, naming why', async () => {
    const json = JSON.parse(readFileSync('public/assets/anim-nested.gltf', 'utf8')) as {
      animations: unknown[];
    };
    json.animations.push(json.animations[0]);
    const result = await buildNativeGltfImportOps({
      buffer: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer,
      assetRef: 'user-imports/native/two-clips.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => {
        throw new Error('a refused import stores nothing');
      },
    });
    expect(result).toMatchObject({ issue: '#1154' });
  });
});
