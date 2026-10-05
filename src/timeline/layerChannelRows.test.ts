// #1215 — the dopesheet shows a character's keys where they live, and the timeline's own gestures
// (K, Delete, a key dragged along its row) edit them there.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../agent/mutators';
import { useDiffStore } from '../agent/diff/store';
import { dispatchRetimeKeyframe } from '../app/animate/dispatchMutator';
import { poseLayerChain } from '../app/animate/poseChain';
import type { GraphNodeLike } from '../app/animate/graphNodes';
import { buildKeyframeDeleteOp, buildKeyframeInsertOp } from '../app/KeyboardShortcuts';
import { useTimeStore } from '../app/stores/timeStore';
import { useTimelineSelection } from './timelineSelection';
import {
  appendLayerRows,
  layerChannelRows,
  layerRowId,
  parseLayerRowId,
  rowAddress,
} from './layerChannelRows';
import { sceneOnlyState } from '../test-utils/sceneOnlyState';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
  useTimelineSelection.getState().setActiveChannel(null);
  useTimelineSelection.getState().setActiveKeyframe(null);
});

async function bar() {
  const bytes = readFileSync('public/assets/skinned-bar-two-clips.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar-two-clips.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  const state = result.ops.reduce((s, op) => applyOp(s, op).next, sceneOnlyState());
  const armature = Object.values(state.nodes).find(
    (n) =>
      state.nodes[(n.inputs.data as { node: string } | undefined)?.node ?? '']?.type === 'Skeleton',
  )!.id;
  const chain = poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    armature,
  );
  useDagStore.getState().hydrate(state);
  return { state, armature, base: chain.base!, layers: chain.layers };
}

const live = () => useDagStore.getState().state;
const curve = (state: DagState, layer: string, bone: string, component: string) =>
  (state.nodes[layer].params as PoseLayerParams).channels.find(
    (c) => c.bone === bone && c.component === component,
  );

describe('#1215 — layer row ids', () => {
  it('round-trip a bone name with Blender’s dots and a colon, and answer null for any other row', () => {
    const address = {
      layerId: 'n_layer:1',
      bone: 'mixamorig:Arm.L.001',
      component: 'quaternion',
    } as const;
    const id = layerRowId(address);
    expect(parseLayerRowId(id)).toEqual(address);
    expect(rowAddress(id)).toEqual({ layer: address });
    expect(parseLayerRowId('clip:Bone1:position')).toBeNull();
    expect(parseLayerRowId('n_channel')).toBeNull();
    expect(rowAddress('n_channel')).toEqual({ channelId: 'n_channel' });
    expect(parseLayerRowId('layer:x:nonsense:bone')).toBeNull();
  });
});

describe('#1215 — which rows the dopesheet shows', () => {
  it('the selected armature Object’s layers, top first, every curve; a muted layer’s rows dimmed', async () => {
    const { state, armature, layers } = await bar();
    const rows = layerChannelRows(state.nodes, armature);
    // Two layers (the base "bend", the held "Wave" muted above it), 6 curves each.
    expect(layers).toHaveLength(2);
    expect(rows).toHaveLength(12);
    // #1215 — the layer's mute dims its rows; each row's own M stays its curve's mute (off here).
    expect(rows.slice(0, 6).every((r) => r.layerMuted === true && r.mute === undefined)).toBe(true);
    expect(rows.slice(6).every((r) => r.layerMuted === undefined)).toBe(true);
    expect(rows.every((r) => r.noSolo === true)).toBe(true);
    expect(rows[6].name).toMatch(/^bend — Bone0 position$/);
    const q = rows.find((r) => r.name === 'bend — Bone1 quaternion')!;
    expect(q.keyframes).toHaveLength(25);

    expect(
      appendLayerRows({ baseRows: [], nodes: state.nodes, selectedNodeId: armature }),
    ).toHaveLength(12);
    expect(appendLayerRows({ baseRows: [], nodes: state.nodes, selectedNodeId: null })).toEqual([]);
    const mesh = Object.values(state.nodes).find((n) => n.type === 'Object' && n.id !== armature)!;
    expect(appendLayerRows({ baseRows: [], nodes: state.nodes, selectedNodeId: mesh.id })).toEqual(
      [],
    );
  });
});

describe('#1215 — the timeline’s gestures edit a layer curve', () => {
  it('K keys the value the curve shows at the playhead, into the layer', async () => {
    const { base } = await bar();
    const row = layerRowId({ layerId: base, bone: 'Bone0', component: 'position' });
    useTimelineSelection.getState().setActiveChannel(row);
    useTimeStore.getState().setTime(0.3);
    const ops = buildKeyframeInsertOp();
    expect(ops).not.toBeNull();
    expect(ops!.every((op) => op.type === 'setParam' && op.nodeId === base)).toBe(true);
    useDagStore.getState().dispatchAtomic(ops!, 'user');
    const keys = curve(live(), base, 'Bone0', 'position')!.keyframes;
    expect(keys.some((k) => k.time === 0.3)).toBe(true);
  });

  it('Delete removes the active key from its layer curve; the last key removes the curve', async () => {
    const { base } = await bar();
    const row = layerRowId({ layerId: base, bone: 'Bone0', component: 'scale' });
    const keys = curve(live(), base, 'Bone0', 'scale')!.keyframes.map((k) => k.time);
    expect(keys.length).toBeGreaterThan(1);
    for (const [i, time] of keys.entries()) {
      useTimelineSelection.getState().setActiveKeyframe({ channelId: row, time });
      const ops = buildKeyframeDeleteOp();
      expect(ops, `delete key ${i}`).not.toBeNull();
      useDagStore.getState().dispatchAtomic(ops!, 'user');
    }
    expect(curve(live(), base, 'Bone0', 'scale')).toBeUndefined();
  });

  it('a key dragged along its row moves in the layer; one undo puts it back', async () => {
    const { base } = await bar();
    const row = layerRowId({ layerId: base, bone: 'Bone1', component: 'quaternion' });
    const before = curve(live(), base, 'Bone1', 'quaternion')!;
    const moved = before.keyframes.find((k) => k.time === 0.5)!;
    const res = dispatchRetimeKeyframe({ channelId: row, fromTime: 0.5, toTime: 0.52 });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = curve(live(), base, 'Bone1', 'quaternion')!;
    expect(after.keyframes.some((k) => k.time === 0.5)).toBe(false);
    expect(after.keyframes.find((k) => k.time === 0.52)!.value).toEqual(moved.value);
    useDagStore.getState().undo();
    expect(curve(live(), base, 'Bone1', 'quaternion')).toEqual(before);
  });

  it('a single-key curve keeps its extend when its key is dragged', async () => {
    const { base } = await bar();
    const one = layerRowId({ layerId: base, bone: 'Bone0', component: 'position' });
    const params = live().nodes[base].params as PoseLayerParams;
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: base,
          paramPath: 'channels',
          value: params.channels.map((c) =>
            c.bone === 'Bone0' && c.component === 'position'
              ? { ...c, keyframes: [c.keyframes[0]], extendAfter: 'slope' }
              : c,
          ),
        },
      ],
      'user',
    );
    const from = curve(live(), base, 'Bone0', 'position')!.keyframes[0].time;
    const res = dispatchRetimeKeyframe({ channelId: one, fromTime: from, toTime: from + 0.25 });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = curve(live(), base, 'Bone0', 'position')! as {
      extendAfter?: string;
      keyframes: { time: number }[];
    };
    expect(after.keyframes.map((k) => k.time)).toEqual([from + 0.25]);
    expect(after.extendAfter).toBe('slope');
  });

  it('#1482 — a key dragged on a many-key curve keeps its handles, and the rest of the curve is untouched', async () => {
    const { base } = await bar();
    const row = layerRowId({ layerId: base, bone: 'Bone0', component: 'position' });
    const params = live().nodes[base].params as PoseLayerParams;
    const original = params.channels.find((c) => c.bone === 'Bone0' && c.component === 'position')!;
    // Three keys, the middle one with its own ease, handle type and handles, and a modifier on the
    // curve: everything a remove + insert used to drop or rewrite.
    const [k0] = original.keyframes;
    const keys = [
      { ...k0, time: 0 },
      {
        ...k0,
        time: 0.5,
        ease: 'out',
        handleType: 'free',
        inHandle: { time: -0.1, value: [0, 0.2, 0] },
        outHandle: { time: 0.1, value: [0, -0.2, 0] },
      },
      { ...k0, time: 1 },
    ];
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: base,
          paramPath: 'channels',
          value: params.channels.map((c) =>
            c === original
              ? { ...c, keyframes: keys, modifiers: [{ type: 'noise', strength: 0.1 }] }
              : c,
          ),
        },
      ],
      'user',
    );
    const before = curve(live(), base, 'Bone0', 'position')! as {
      keyframes: unknown[];
      modifiers?: unknown[];
    };
    // The seed landed: a rejected setParam would leave nothing here to lose.
    expect(before.modifiers).toHaveLength(1);
    expect(before.keyframes[1]).toMatchObject({ ease: 'out', handleType: 'free' });

    const res = dispatchRetimeKeyframe({ channelId: row, fromTime: 0.5, toTime: 0.6 });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const after = curve(live(), base, 'Bone0', 'position')!;
    const [b0, b1, b2] = before.keyframes as Record<string, unknown>[];
    expect(after).toEqual({ ...before, keyframes: [b0, { ...b1, time: 0.6 }, b2] });
  });
});
