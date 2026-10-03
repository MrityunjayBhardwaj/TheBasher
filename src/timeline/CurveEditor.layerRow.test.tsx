// #1215 — a character's layer curve opens and edits in the graph editor, where it lives.
//
// A layer row (`layer:<layer>:<component>:<bone>`) names no node: the graph editor resolves it the
// way the dopesheet's K / Delete / drag do (`resolveRowChannelForWrite` → the channel address
// resolver), draws the curve's keys and lands an edit as a write to the layer's channel list. No
// channel node is created; one undo restores the layer.
//
// Subject: skinned-bar-two-clips.glb imported native (its base layer), with a Bone0 position curve
// keyed at 0 s and 1 s through the agent's own key tool. happy-dom has no layout, so the key DRAG is
// proven live (e2e `p1215-graph-editor-layer.spec.ts`); here the write road is driven through the
// active key's interpolation picker, which commits through the same `commit` as a drag.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import type { ObjectValue, PosedSkeletonValue } from '../nodes/types';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../agent/mutators';
import { useDiffStore } from '../agent/diff/store';
import { dispatchMutatorFromUI } from '../app/animate/dispatchMutator';
import { poseLayerChain } from '../app/animate/poseChain';
import type { GraphNodeLike } from '../app/animate/graphNodes';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimelineSelection } from './timelineSelection';
import { layerRowId } from './layerChannelRows';
import { CurveEditor } from './CurveEditor';
import { sceneOnlyState } from '../test-utils/sceneOnlyState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
  useTimelineSelection.setState({ activeChannelId: null, activeKeyframeId: null });
  useSelectionStore.getState().select(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const live = () => useDagStore.getState().state;
const channelsOf = (state: DagState, layer: string) =>
  (state.nodes[layer].params as PoseLayerParams).channels;

async function barWithBone0Position() {
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
  const layer = poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    armature,
  ).base!;
  useDagStore.getState().hydrate(state);
  // Replace any Bone0 position curve the file carries with two keys: 0 → origin, 1 s → (0,2,0).
  const address = { layerId: layer, bone: 'Bone0', component: 'position' as const };
  for (const [time, value] of [
    [0, [0, 0, 0]],
    [1, [0, 2, 0]],
  ] as const) {
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { layer: address, time, value: [...value], easing: 'linear' },
      'key Bone0',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
  }
  const keyed = channelsOf(live(), layer).find(
    (c) => c.bone === 'Bone0' && c.component === 'position',
  )!;
  // Drop any in-between keys the file carried so the curve is exactly the two.
  useDagStore.getState().dispatchAtomic(
    [
      {
        type: 'setParam',
        nodeId: layer,
        paramPath: 'channels',
        value: channelsOf(live(), layer).map((c) =>
          c === keyed
            ? { ...c, keyframes: c.keyframes.filter((k) => k.time === 0 || k.time === 1) }
            : c,
        ),
      },
    ],
    'user',
  );
  return { armature, layer, row: layerRowId(address) };
}

function bone0PositionAt(state: DagState, armature: string, seconds: number) {
  const value = evaluate(state, armature, { ctx: at(seconds) }).value as ObjectValue;
  const pose = (value as { pose?: PosedSkeletonValue }).pose!.sample(seconds);
  return pose.find((b) => b.name === 'Bone0')!.position;
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('#1215 — the graph editor reads and writes a layer curve where it lives', () => {
  it('draws a layer row: three axis tracks and one dot per key per axis', async () => {
    const { row } = await barWithBone0Position();
    useTimelineSelection.getState().setActiveChannel(row);
    act(() => root.render(<CurveEditor duration={1} />));
    expect(byTestId('curve-track-0'), 'a layer row opens as a curve').not.toBeNull();
    expect(byTestId('curve-track-2')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="curve-key-"]')).toHaveLength(2 * 3);
    expect(container.textContent).not.toContain('Channel not found');
  });

  it('an edit lands in the layer: no channel node, the bone moves between keys, one undo restores', async () => {
    const { armature, layer, row } = await barWithBone0Position();
    const before = live();
    const nodeCount = Object.keys(before.nodes).length;
    const mid = bone0PositionAt(before, armature, 0.5);
    expect(mid[1]).toBeCloseTo(1, 6); // linear, halfway to 2

    useTimelineSelection.getState().setActiveChannel(row);
    useTimelineSelection.getState().setActiveKeyframe({ channelId: row, time: 1 });
    act(() => root.render(<CurveEditor duration={1} />));
    const select = byTestId('curve-interp-select') as HTMLSelectElement | null;
    expect(select, 'the active key of a layer row has its picker').not.toBeNull();
    act(() => {
      select!.value = 'constant';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const after = live();
    const curve = channelsOf(after, layer).find(
      (c) => c.bone === 'Bone0' && c.component === 'position',
    )!;
    expect(curve.keyframes.find((k) => k.time === 1)!.easing).toBe('constant');
    expect(Object.keys(after.nodes)).toHaveLength(nodeCount);
    const held = bone0PositionAt(after, armature, 0.5);
    expect(Math.abs(held[1] - mid[1]), 'the bone moves between the keys').toBeGreaterThan(0.5);
    expect(bone0PositionAt(after, armature, 0)).toEqual(bone0PositionAt(before, armature, 0));

    act(() => useDagStore.getState().undo());
    expect(channelsOf(live(), layer)).toEqual(channelsOf(before, layer));
  });

  it("draws the layer curve's own extrapolation past its last key", async () => {
    const { layer, row } = await barWithBone0Position();
    useTimelineSelection.getState().setActiveChannel(row);
    act(() => root.render(<CurveEditor duration={2} />));
    const held = byTestId('curve-track-1')!.getAttribute('points');
    act(() =>
      useDagStore.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: layer,
            paramPath: 'channels',
            value: channelsOf(live(), layer).map((c) =>
              c.bone === 'Bone0' && c.component === 'position' ? { ...c, extendAfter: 'slope' } : c,
            ),
          },
        ],
        'user',
      ),
    );
    const sloped = byTestId('curve-track-1')!.getAttribute('points');
    expect(sloped, 'slope past 1 s draws differently from hold').not.toBe(held);
  });

  it('with no row pinned, a selected armature Object shows its first layer curve', async () => {
    const { armature, layer } = await barWithBone0Position();
    useSelectionStore.getState().select(armature);
    act(() => root.render(<CurveEditor duration={1} />));
    const first = channelsOf(live(), layer)[0];
    expect(container.textContent).toContain(first.component);
    expect(container.textContent).not.toContain('No animated channels yet');
  });
});
