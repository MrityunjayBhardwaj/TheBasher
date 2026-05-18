// Tests for the UI → Mutator dispatch seam (Phase 7, Wave A).
//
// A1: single-Mutator dispatch — happy path mutates + one atomic undo
//     entry; rejection path leaves the DAG byte-unchanged with a reason.
//
// V13 pre-mortem (A1): assert propose() is called with the
// Mutator-DECLARED closure spec (mirrors orchestrator.ts:457), not the
// selection-inferred fallback.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import {
  __resetMutatorRegistryForTests,
  registerAllMutators,
} from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** box → scene(children), time source seeded, scene as the anchor output. */
function buildScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: {
      size: [1, 1, 1],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      material: { name: 'default', color: '#ff0000' },
    },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = {
    ...s,
    outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return s;
}

/** Seed a layer + Vec3 channel so the single-Mutator keyframe path works. */
function buildSceneWithChannel(): DagState {
  let s = buildScene();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box_layer',
    nodeType: 'AnimationLayer',
    params: { name: 'Layer' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box_position_channel',
    nodeType: 'KeyframeChannelVec3',
    params: { name: 'position', target: 'box', paramPath: 'position', keyframes: [] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_time', socket: 'out' },
    to: { node: 'box_position_channel', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box_position_channel', socket: 'out' },
    to: { node: 'box_layer', socket: 'animation' },
  }).next;
  return s;
}

describe('A1 — dispatchMutatorFromUI (single-Mutator seam)', () => {
  it('happy path: keyframe lands in the DAG + exactly ONE atomic undo entry', () => {
    useDagStore.getState().hydrate(buildSceneWithChannel());
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'box_position_channel', time: 0.5, value: [0, 2, 0] },
      'key position',
    );

    expect(res).toEqual({ ok: true });

    // OBSERVE the DAG actually shows the new sample.
    const ch = useDagStore.getState().state.nodes['box_position_channel'];
    const kfs = (ch.params as { keyframes: Array<{ time: number; value: unknown }> })
      .keyframes;
    expect(kfs).toHaveLength(1);
    expect(kfs[0]).toMatchObject({ time: 0.5, value: [0, 2, 0] });

    // OBSERVE exactly one atomic undo entry was produced.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
  });

  it('rejection path: invalid spec → { ok:false, reason } and DAG byte-unchanged', () => {
    useDagStore.getState().hydrate(buildSceneWithChannel());
    const before = JSON.stringify(useDagStore.getState().state);

    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'box_position_channel', time: 0.5, value: 'not-a-vec3' },
      'bad key',
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(typeof res.reason).toBe('string');
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });

  it('unknown mutator name → { ok:false } without mutation', () => {
    useDagStore.getState().hydrate(buildScene());
    const before = JSON.stringify(useDagStore.getState().state);
    const res = dispatchMutatorFromUI('mutator.nope', {}, 'x');
    expect(res.ok).toBe(false);
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
  });

  it('V13 pre-mortem: propose() receives the Mutator-DECLARED closure spec', () => {
    useDagStore.getState().hydrate(buildSceneWithChannel());
    const proposeSpy = vi.spyOn(useDiffStore.getState(), 'propose');

    dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'box_position_channel', time: 0.5, value: [0, 2, 0] },
      'key position',
    );

    expect(proposeSpy).toHaveBeenCalledTimes(1);
    const closureSpecArg = proposeSpy.mock.calls[0][4];
    // keyframe.ts:76-81 declares rootSelectors:[channelId], followedEdges:[].
    expect(closureSpecArg).toMatchObject({
      rootSelectors: ['box_position_channel'],
      followedEdges: [],
    });
    proposeSpy.mockRestore();
  });
});
