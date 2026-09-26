// #1215 — a pose layer's curve mutes the way an F-curve does, from the dopesheet's gutter M and the
// toolbar's Mute alike, and has no solo.
//
// Blender 5.1.1 skips an F-curve flagged `FCURVE_MUTED` when it evaluates an action
// (`anim_sys.cc:341`, `:768`): the property is left as it would be without that curve. F-curves have
// no solo; the layer does (#1241).
//
// Subject: skinned-bar-two-clips.glb imported native — its base layer keys Bone1's quaternion at
// every frame 0..24 (the bend). Muting that one curve leaves Bone1 at what arrives from below (the
// skeleton's rest) at every frame, Bone0 untouched; unmuting, or one undo, brings the bend back.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { emptyDagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import type { Node } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import type { ObjectValue, PosedSkeletonValue } from '../../nodes/types';
import {
  memberEulerDegreesAt,
  PoseLayerChannelSchema,
  type PoseLayerParams,
} from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { layerChannelRows, layerRowId } from '../../timeline/layerChannelRows';
import { rowFlag, rowFlagToggleOps } from './clipRowMint';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { poseLayerChain } from './poseChain';
import type { GraphNodeLike } from './graphNodes';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const live = () => useDagStore.getState().state;

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
  const state = result.ops.slice(0, -1).reduce((s, op) => applyOp(s, op).next, emptyDagState());
  const armature = Object.values(state.nodes).find(
    (n) =>
      state.nodes[(n.inputs.data as { node: string } | undefined)?.node ?? '']?.type === 'Skeleton',
  )!.id;
  const layer = poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    armature,
  ).base!;
  useDagStore.getState().hydrate(state);
  const row = layerRowId({ layerId: layer, bone: 'Bone1', component: 'quaternion' });
  return { state, armature, layer, row };
}

function poseAt(state: DagState, armature: string, seconds: number) {
  const value = evaluate(state, armature, { ctx: at(seconds) }).value as ObjectValue;
  return (value as { pose?: PosedSkeletonValue }).pose!.sample(seconds);
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.max(...Array.from(a, (c, i) => Math.abs(c - b[i])));

const toggle = (row: string, kind: 'mute' | 'solo') => {
  const ops = rowFlagToggleOps(live(), row, kind);
  if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', `toggle ${kind}`);
  return ops;
};

describe('#1215 — a layer curve mutes as an F-curve does', () => {
  it('muting Bone1’s curve leaves Bone1 at what arrives from below at every frame; Bone0 untouched; undo restores', async () => {
    const { state: before, armature, layer, row } = await bar();
    const rest = poseAt(before, armature, 0)[1].quaternion; // frame 0 of the bend = rest
    expect(maxDiff(poseAt(before, armature, 0.5)[1].quaternion, rest)).toBeGreaterThan(0.1);

    expect(toggle(row, 'mute')).not.toBeNull();
    expect(rowFlag(live(), row, 'mute')).toBe(true);
    const curve = (live().nodes[layer].params as PoseLayerParams).channels.find(
      (c) => c.bone === 'Bone1' && c.component === 'quaternion',
    )!;
    expect(curve.mute, 'the flag lives on the curve, in the layer').toBe(true);
    expect(curve.keyframes.length, 'muting keeps every key').toBeGreaterThan(20);
    for (let f = 0; f <= 24; f += 6) {
      const a = poseAt(before, armature, f / 24);
      const b = poseAt(live(), armature, f / 24);
      expect(maxDiff(b[1].quaternion, rest), `Bone1 at rest at ${f}`).toBeLessThan(1e-6);
      expect(maxDiff(a[0].quaternion, b[0].quaternion), `Bone0 at ${f}`).toBe(0);
    }
    // The row reads it: its own M lit, the layer unmuted.
    const r = layerChannelRows(live().nodes, armature).find((x) => x.channelId === row)!;
    expect(r.mute).toBe(true);
    expect(r.layerMuted).toBeUndefined();

    useDagStore.getState().undo();
    expect(
      maxDiff(
        poseAt(live(), armature, 0.5)[1].quaternion,
        poseAt(before, armature, 0.5)[1].quaternion,
      ),
    ).toBe(0);
    expect(rowFlag(live(), row, 'mute')).toBe(false);
  });

  it('a second toggle unmutes', async () => {
    const { state: before, armature, row } = await bar();
    toggle(row, 'mute');
    toggle(row, 'mute');
    expect(rowFlag(live(), row, 'mute')).toBe(false);
    expect(poseAt(live(), armature, 0.5)[1].quaternion).toEqual(
      poseAt(before, armature, 0.5)[1].quaternion,
    );
  });

  it('a layer curve has no solo: nothing to flip, and the schema cannot hold one', async () => {
    const { row } = await bar();
    expect(rowFlagToggleOps(live(), row, 'solo')).toBeNull();
    const parsed = PoseLayerChannelSchema.parse({
      bone: 'Bone1',
      component: 'quaternion',
      keyframes: [],
      solo: true,
    });
    expect('solo' in parsed).toBe(false);
    for (const component of ['position', 'rotation', 'scale', 'weight'] as const) {
      expect(
        'solo' in PoseLayerChannelSchema.parse({ bone: 'B', component, keyframes: [], solo: true }),
      ).toBe(false);
    }
  });

  it('a muted euler curve: the inspector shows the static value, as the layer plays it', () => {
    const member = {
      bone: 'B',
      rotationMode: 'XYZ' as const,
      rotation: [0, 0, 10] as [number, number, number],
    };
    const channels = [
      PoseLayerChannelSchema.parse({
        bone: 'B',
        component: 'rotation',
        keyframes: [{ time: 0, value: [0, 0, 50], easing: 'linear' }],
        mute: true,
      }),
    ];
    expect(memberEulerDegreesAt(member, channels, 0)).toEqual([0, 0, 10]);
    expect(memberEulerDegreesAt(member, [{ ...channels[0], mute: false }], 0)).toEqual([0, 0, 50]);
  });

  it('a channel node row still toggles its own params; a read-only clip row has nothing to flip', async () => {
    await bar();
    const node = {
      id: 'ch_num',
      type: 'KeyframeChannelNumber',
      inputs: {},
      params: { name: 'fov', paramPath: 'fov', target: '', keyframes: [{ time: 0, value: 1 }] },
    } as unknown as Node;
    const state = { ...live(), nodes: { ...live().nodes, ch_num: node } };
    expect(rowFlagToggleOps(state, 'ch_num', 'mute')).toEqual([
      { type: 'setParam', nodeId: 'ch_num', paramPath: 'mute', value: true },
    ]);
    expect(rowFlagToggleOps(state, 'ch_num', 'solo')).toEqual([
      { type: 'setParam', nodeId: 'ch_num', paramPath: 'solo', value: true },
    ]);
    expect(rowFlagToggleOps(state, 'clip:Bone1:rotation', 'mute')).toBeNull();
  });

  it('changing a muted curve’s rotation mode converts its keys, not its static value, and keeps it muted', async () => {
    const { armature, layer, row } = await bar();
    const bent = poseAt(live(), armature, 0.5)[1].quaternion;
    toggle(row, 'mute');
    const res = dispatchMutatorFromUI(
      'mutator.animate.setPoseMemberMode',
      { layer, bone: 'Bone1', rotationMode: 'XYZ', method: 'convert' },
      'mode',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const curve = (live().nodes[layer].params as PoseLayerParams).channels.find(
      (c) => c.bone === 'Bone1' && c.component === 'rotation',
    )!;
    expect(curve.mute, 'still muted in its new mode').toBe(true);
    // Unmuted, the converted curve plays the bend it held.
    const unmute = rowFlagToggleOps(
      live(),
      layerRowId({ layerId: layer, bone: 'Bone1', component: 'rotation' }),
      'mute',
    )!;
    useDagStore.getState().dispatchAtomic(unmute, 'user', 'unmute');
    expect(maxDiff(poseAt(live(), armature, 0.5)[1].quaternion, bent)).toBeLessThan(1e-5);
  });

  it('a muted weight curve: the layer plays at its static weight', async () => {
    const { state: before, armature, layer } = await bar();
    const params = live().nodes[layer].params as PoseLayerParams;
    // The layer's weight keyed to 0: the bend is silent, Bone1 at rest.
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: layer,
          paramPath: 'channels',
          value: [
            ...params.channels,
            PoseLayerChannelSchema.parse({
              bone: '',
              component: 'weight',
              keyframes: [{ time: 0, value: 0, easing: 'linear' }],
            }),
          ],
        },
      ],
      'user',
    );
    const rest = poseAt(before, armature, 0)[1].quaternion;
    expect(maxDiff(poseAt(live(), armature, 0.5)[1].quaternion, rest)).toBeLessThan(1e-6);
    const weightRow = layerRowId({ layerId: layer, bone: '', component: 'weight' });
    toggle(weightRow, 'mute');
    expect(poseAt(live(), armature, 0.5)[1].quaternion).toEqual(
      poseAt(before, armature, 0.5)[1].quaternion,
    );
  });
});
