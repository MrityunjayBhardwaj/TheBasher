// #1215 — a character's computed motion (a bound retarget) shows in the dopesheet read-only: every
// bone of its wire × position / quaternion / scale, a key at each pose — the keys a bake at every pose
// would write. After the bake the rows are gone and the baked layer's editable rows stand in their
// place, key for key. A character whose motion is keys already (an imported file) shows none.
//
// Subject: skinned-bar.glb imported native, the two-joint swing (3 poses, 0.5 s apart) bound onto it
// through the product's bind — the same fixture as `bakePose.gate.test.ts`.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { buildDefaultDagState } from '../core/project/default';
import type { Op } from '../core/dag/types';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../core/import/skeletonObject';
import { registerAllNodes } from '../nodes/registerAll';
import type { BoneSpec } from '../nodes/types';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../agent/mutators';
import { useDiffStore } from '../agent/diff/store';
import { useSelectionStore } from '../app/stores/selectionStore';
import { bindMotionToCharacter, characterTargets } from '../app/asset/bindMotionToCharacter';
import { bakePose, freeBakedLayerId } from '../app/animate/bakePose';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { buildKeyframeInsertOp } from '../app/KeyboardShortcuts';
import { resolveRowChannelForWrite } from '../app/animate/clipRowMint';
import { useTimeStore } from '../app/stores/timeStore';
import { useTimelineSelection } from './timelineSelection';
import {
  appendComputedSourceRows,
  computedSourceRows,
  isComputedRowId,
  layerChannelRows,
} from './layerChannelRows';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const SWING = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

async function importedBar(): Promise<{ state: DagState; armature: string }> {
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const s0 = buildDefaultDagState();
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: s0.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  const state = apply(s0, result.ops);
  return { state, armature: characterTargets(state)[0].objectId! };
}

async function boundBar() {
  const { state: withBar, armature } = await importedBar();
  const motion = buildBvhImportOps({
    text: SWING,
    name: 'swing',
    ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
  });
  let state = apply(withBar, motion.ops);
  const bones = (state.nodes.swing_skel.params as { bones: BoneSpec[] }).bones;
  state = apply(
    state,
    buildSkeletonObjectOps({
      skeletonId: 'swing_skel',
      bones,
      sceneNodeId: state.outputs.scene!.node,
      normalise: false,
      name: 'swing',
      clipId: 'swing_clip',
      nameFollowsClip: true,
    }).ops,
  );
  useDagStore.getState().hydrate(state);
  useSelectionStore.getState().select(null);
  const bound = bindMotionToCharacter(
    { motionId: 'swing_clip', skeletonId: 'swing_skel' },
    'imported',
  );
  if (!bound.ok) throw new Error(JSON.stringify(bound));
  return { state: useDagStore.getState().state, armature, retarget: bound.clipId };
}

describe('#1215 — computed motion shows read-only until baked', () => {
  it('a bound retarget: every bone × position/quaternion/scale, a key at each pose, all read-only', async () => {
    const { state, armature } = await boundBar();
    const rows = computedSourceRows(state, armature);
    const bones = ['Bone0', 'Bone1'];
    expect(rows.map((r) => r.name.split(' — ')[1])).toEqual(
      bones.flatMap((b) => [`${b} position`, `${b} quaternion`, `${b} scale`]),
    );
    for (const row of rows) {
      expect(row.readOnly, row.name).toBe(true);
      expect(isComputedRowId(row.channelId)).toBe(true);
      expect(row.keyframes.map((k) => k.time)).toEqual([0, 0.5, 1]);
    }
  });

  it('are the keys a bake at every pose writes, and the bake replaces them with editable rows', async () => {
    const { state, armature } = await boundBar();
    const before = computedSourceRows(state, armature);
    const layerId = freeBakedLayerId(state, armature);
    const baked = bakePose(state, {
      object: armature,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId,
    });
    if (!baked.ok) throw new Error(baked.reason);
    const after = apply(state, baked.ops);
    expect(computedSourceRows(after, armature), 'baked: no computed source left').toEqual([]);
    const editable = layerChannelRows(after.nodes, armature).filter((r) =>
      r.channelId.includes(encodeURIComponent(layerId)),
    );
    expect(editable.map((r) => r.name.split(' — ')[1])).toEqual(
      before.map((r) => r.name.split(' — ')[1]),
    );
    editable.forEach((row, i) =>
      expect(row.keyframes.map((k) => k.time)).toEqual(before[i].keyframes.map((k) => k.time)),
    );
    expect(editable.every((r) => !r.readOnly)).toBe(true);
  });

  it("a character whose motion is keys already (an imported file's base layer) shows none", async () => {
    const { state, armature } = await importedBar();
    expect(computedSourceRows(state, armature)).toEqual([]);
    expect(layerChannelRows(state.nodes, armature).length).toBeGreaterThan(0);
  });

  it('shows only for the selected armature Object', async () => {
    const { state, armature } = await boundBar();
    const base = [{ channelId: 'x', name: 'x', keyframes: [] }];
    expect(appendComputedSourceRows({ baseRows: base, state, selectedNodeId: null })).toBe(base);
    // A node in the chain selected on its own (the base layer, in the node editor) is not the
    // character: rows follow the selected Object, as the layer rows do.
    const layer = Object.values(state.nodes).find((n) => n.type === 'PoseLayer')!.id;
    expect(appendComputedSourceRows({ baseRows: base, state, selectedNodeId: layer })).toBe(base);
    expect(
      appendComputedSourceRows({ baseRows: base, state, selectedNodeId: armature }).length,
    ).toBe(1 + 6);
  });

  it('a source with no range to take poses from is one row saying so, never no rows', async () => {
    const { state, armature, retarget } = await boundBar();
    // The swing's clip emptied: the retarget has no motion, so there are no poses to show.
    const emptied = apply(state, [
      { type: 'setParam', nodeId: 'swing_clip', paramPath: 'keyframes', value: [] },
    ]);
    const rows = computedSourceRows(emptied, armature);
    expect(rows).toHaveLength(1);
    expect(rows[0].readOnly).toBe(true);
    expect(rows[0].keyframes).toEqual([]);
    expect(rows[0].name).toBe('SkinnedBar motion — no poses to show (the motion has no range)');
    expect(emptied.nodes[retarget].type).toBe('RetargetClip');
  });

  it('reads through the caller’s cache: an edit elsewhere gives the same rows', async () => {
    const { state, armature } = await boundBar();
    const inner = createEvaluatorCache();
    let computed = 0;
    const cache = { ...inner, set: (k: string, v: never) => (computed++, inner.set(k, v)) };
    const first = computedSourceRows(state, armature, cache);
    expect(computed, 'the first read evaluates the source into the cache').toBeGreaterThan(0);
    const filled = computed;
    const elsewhere = apply(state, [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [3, 0, 0] },
    ]);
    expect(computedSourceRows(elsewhere, armature, cache)).toEqual(first);
    expect(computed, 'an edit elsewhere re-evaluates nothing').toBe(filled);
  });

  it('K on a computed row writes nothing: there is no curve until the bake', async () => {
    const { state, armature } = await boundBar();
    const row = computedSourceRows(state, armature)[1];
    expect(resolveRowChannelForWrite(state, row.channelId)).toBeNull();
    useDagStore.getState().hydrate(state);
    useTimeStore.getState().setTime(0.25);
    useTimelineSelection.getState().setActiveChannel(row.channelId);
    expect(buildKeyframeInsertOp()).toBeNull();
    // The control: the same gesture on the baked layer's row of that curve does key.
    const layerId = freeBakedLayerId(state, armature);
    const baked = bakePose(state, {
      object: armature,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId,
    });
    if (!baked.ok) throw new Error(baked.reason);
    useDagStore.getState().hydrate(apply(state, baked.ops));
    const editable = layerChannelRows(useDagStore.getState().state.nodes, armature).find(
      (r) => r.name.endsWith(row.name.split(' — ')[1]) && r.channelId.includes(layerId),
    )!;
    useTimelineSelection.getState().setActiveChannel(editable.channelId);
    expect(buildKeyframeInsertOp()).not.toBeNull();
  });
});
