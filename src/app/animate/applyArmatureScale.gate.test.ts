// #1511 — Apply Scale on a group holding a skeleton carries the scale into the rig: the rest, the
// keys of every clip it holds, and the skinned mesh. Nothing a director can see moves.
//
// THE ROW THAT CARRIES IT: every deformed vertex, in world space, at several times of EVERY clip the
// rig holds, is where it was before Apply. Blender's Apply rewrites the rest only and leaves the
// keys behind (measured on the X Bot's walk: the hips jump ~15 m, GROUND_TRUTH_BLENDER_TRANSFORM_APPLY
// §6); with the keys left unscaled here this row goes red. The fixture's group is given a scale
// first, so the rig starts in other units, as a Mixamo character's does under its 0.01.

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import type { MeshGeometryData, ModifiedDataValue } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import type { SkeletonParams } from '../../nodes/Skeleton';
import { resolveWorldTransform } from '../resolveWorldTransform';
import { hierarchyChildIds } from '../sceneHierarchy';
import { poseLayerChain } from './poseChain';
import type { GraphNodeLike } from './graphNodes';
import {
  armatureSkeletonObjectsOf,
  canApplyTransform,
  dispatchApplyTransform,
  type ApplyMask,
} from './dispatchApplyTransform';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const nodesOf = (state: DagState, type: string) =>
  Object.values(state.nodes).filter((n) => n.type === type);

async function importBar(): Promise<DagState> {
  const state = buildDefaultDagState();
  const bytes = readFileSync('public/assets/skinned-bar-two-clips.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar-two-clips.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  return apply(state, result.ops);
}

/** The group the import stood the skeleton up in. */
function armatureGroupOf(state: DagState): string {
  const group = nodesOf(state, 'Group').find((g) => armatureSkeletonObjectsOf(state, g.id).length);
  if (!group) throw new Error('the fixture has no group holding its skeleton');
  return group.id;
}

/** Every skinned vertex in WORLD space at `seconds`, mesh by mesh. */
function skinnedWorld(state: DagState, seconds: number): number[][] {
  const out: number[][] = [];
  for (const modifier of nodesOf(state, 'ArmatureModifier')) {
    const value = evaluate(state, modifier.id, { ctx: at(seconds) }).value as ModifiedDataValue;
    const descriptor = value.geometry.descriptor;
    if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
    const local = sampleSkinDeform(value.skin, descriptor.data as MeshGeometryData, seconds);
    const objectId = Object.values(state.nodes).find(
      (n) => n.type === 'Object' && (n.inputs?.data as { node?: string })?.node === modifier.id,
    )!.id;
    const world = new THREE.Matrix4().fromArray(
      resolveWorldTransform(state, objectId, at(seconds))!.matrix,
    );
    const v = new THREE.Vector3();
    for (let i = 0; i < local.length; i += 3) {
      out.push(v.fromArray(local, i).applyMatrix4(world).toArray());
    }
  }
  return out;
}

/** The rig's clips: each pose layer on the skeleton's chain played alone. */
function clipsOf(state: DagState, groupId: string): readonly string[] {
  const skeletonObject = armatureSkeletonObjectsOf(state, groupId)[0];
  return poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    skeletonObject,
  ).layers;
}

function soloed(state: DagState, layerId: string, layers: readonly string[]): DagState {
  return apply(
    state,
    layers.map((id) => ({
      type: 'setParam',
      nodeId: id,
      paramPath: 'mute',
      value: id !== layerId,
    })),
  );
}

const TIMES = [0, 0.25, 0.5, 0.75, 1];

/** The largest world-space distance between two vertex lists, against the size of the mesh. */
function worstRelative(a: number[][], b: number[][]): number {
  expect(b).toHaveLength(a.length);
  let size = 0;
  let worst = 0;
  a.forEach((p, i) => {
    size = Math.max(size, Math.hypot(...p));
    worst = Math.max(worst, Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2]));
  });
  return worst / Math.max(size, 1e-9);
}

async function applied(state: DagState, groupId: string, mask: ApplyMask = 'scale') {
  let next = state;
  const result = await dispatchApplyTransform(groupId, mask, {
    state,
    currentFrame: 0,
    dispatchAtomic: (ops) => {
      next = apply(next, ops);
    },
    setSelection: () => {},
    clearTransients: () => {},
  });
  return { result, next };
}

describe('#1511 — Apply Scale on an armature carries the scale into the rig', () => {
  it('nothing moves: every skinned vertex at every time of every clip stays where it was drawn', async () => {
    const imported = await importBar();
    const groupId = armatureGroupOf(imported);
    const s = 2.5;
    const before = apply(imported, [
      { type: 'setParam', nodeId: groupId, paramPath: 'scale', value: [s, s, s] },
    ]);
    const layers = clipsOf(before, groupId);
    // A fixture with one clip, or a clip that does not move, would pass with the keys left behind.
    expect(layers.length).toBeGreaterThanOrEqual(2);

    const { result, next: after } = await applied(before, groupId);
    expect(result).toEqual({ ok: true, bakedId: groupId });
    expect((after.nodes[groupId].params as { scale?: unknown }).scale).toEqual([1, 1, 1]);

    for (const layerId of layers) {
      const was = soloed(before, layerId, layers);
      const now = soloed(after, layerId, layers);
      const moving = worstRelative(skinnedWorld(was, TIMES[0]), skinnedWorld(was, TIMES[2]));
      expect(moving, `clip ${layerId} must move for this row to mean anything`).toBeGreaterThan(
        1e-3,
      );
      for (const t of TIMES) {
        expect(
          worstRelative(skinnedWorld(was, t), skinnedWorld(now, t)),
          `clip ${layerId} at ${t}s`,
        ).toBeLessThan(1e-5);
      }
    }
  });

  it('the rest is in the new units: every bone offset is the old one times the scale', async () => {
    const imported = await importBar();
    const groupId = armatureGroupOf(imported);
    const before = apply(imported, [
      { type: 'setParam', nodeId: groupId, paramPath: 'scale', value: [0.01, 0.01, 0.01] },
    ]);
    const skeletonId = (
      before.nodes[armatureSkeletonObjectsOf(before, groupId)[0]].inputs!.data as { node: string }
    ).node;
    const { next } = await applied(before, groupId);
    const was = (before.nodes[skeletonId].params as SkeletonParams).bones;
    const now = (next.nodes[skeletonId].params as SkeletonParams).bones;
    now.forEach((b, i) => {
      b.position.forEach((v, k) => expect(v).toBeCloseTo(was[i].position[k] * 0.01, 12));
      expect(b.rotation).toEqual(was[i].rotation);
    });
    // And the keys moved with it: every position key reads 0.01 of what it read.
    const keysOf = (state: DagState) =>
      clipsOf(before, groupId).flatMap((id) =>
        (state.nodes[id].params as PoseLayerParams).channels
          .filter((c) => c.component === 'position')
          .flatMap((c) => c.keyframes.map((k) => k.value as number[])),
      );
    const keysWas = keysOf(before);
    const keysNow = keysOf(next);
    expect(
      keysWas.some((v) => v.some((x) => Math.abs(x) > 1e-6)),
      'the fixture keys a position',
    ).toBe(true);
    keysNow.forEach((v, i) => v.forEach((x, k) => expect(x).toBeCloseTo(keysWas[i][k] * 0.01, 12)));
  });

  it('is offered for the group holding the skeleton, and not for a group without one', async () => {
    const imported = await importBar();
    const groupId = armatureGroupOf(imported);
    expect(canApplyTransform(imported, groupId)).toBe(true);
    const plain = nodesOf(imported, 'Group').find(
      (g) => !armatureSkeletonObjectsOf(imported, g.id).length,
    );
    if (plain) expect(canApplyTransform(imported, plain.id)).toBe(false);
  });

  it('refuses what v1 cannot carry, by name, and writes nothing', async () => {
    const imported = await importBar();
    const groupId = armatureGroupOf(imported);
    const skewed = apply(imported, [
      { type: 'setParam', nodeId: groupId, paramPath: 'scale', value: [1, 2, 1] },
    ]);
    const nonUniform = await applied(skewed, groupId);
    expect(nonUniform.result.ok).toBe(false);
    if (!nonUniform.result.ok)
      expect(nonUniform.result.reason).toMatch(/different scale on each axis/);
    expect(nonUniform.next).toBe(skewed);

    const rotation = await applied(imported, groupId, 'rotation');
    expect(rotation.result.ok).toBe(false);
    if (!rotation.result.ok) expect(rotation.result.reason).toMatch(/only its scale/);

    const turned = apply(imported, [
      { type: 'setParam', nodeId: groupId, paramPath: 'rotation', value: [0, 30, 0] },
    ]);
    const all = await applied(turned, groupId, 'all');
    expect(all.result.ok).toBe(false);
  });

  it('the group holds the skeleton directly (fixture guard)', async () => {
    const imported = await importBar();
    const groupId = armatureGroupOf(imported);
    expect(hierarchyChildIds(imported.nodes[groupId]).length).toBeGreaterThan(1);
  });
});
