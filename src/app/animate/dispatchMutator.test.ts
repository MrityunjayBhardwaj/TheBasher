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
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import {
  dispatchMutatorFromUI,
  dispatchFirstKeyComposite,
  dispatchRetimeKeyframe,
} from './dispatchMutator';

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

/** scene with a PerspectiveCamera wired into scene.camera (the #190 shape). */
function buildSceneWithCamera(): DagState {
  let s = buildScene();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [3, 2, 3], lookAt: [0, 0, 0] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
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
  // P7.12 D-04: channel has no `time` socket — no time→channel connect.
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
    const kfs = (ch.params as { keyframes: Array<{ time: number; value: unknown }> }).keyframes;
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

describe('P7.1 — dispatchRetimeKeyframe (2-Mutator atomic composite, D-01/D-03)', () => {
  /** Seed the channel with a sample at t=1.0, value V, easing 'cubic'. */
  function seedWithSample(
    keyframes: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>,
  ): DagState {
    let s = buildSceneWithChannel();
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'box_position_channel',
      paramPath: 'keyframes',
      value: keyframes,
    }).next;
    return s;
  }

  const V = [1, 2, 3];

  it('retimes preserving value AND easing; old-time sample gone; ONE undo entry', () => {
    useDagStore.getState().hydrate(seedWithSample([{ time: 1.0, value: V, easing: 'cubic' }]));
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const res = dispatchRetimeKeyframe({
      channelId: 'box_position_channel',
      fromTime: 1.0,
      toTime: 1.3333,
    });
    expect(res).toEqual({ ok: true });

    const kfs = (
      useDagStore.getState().state.nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown; easing: string }>;
      }
    ).keyframes;
    // (b) sample at 1.3333 with SAME value + easing.
    expect(kfs).toHaveLength(1);
    expect(kfs[0].time).toBe(1.3333);
    expect(kfs[0].value).toEqual(V);
    expect(kfs[0].easing).toBe('cubic'); // D-01: easing survived
    // (c) NO sample remains at the old time (proves the remove matched).
    expect(kfs.some((k) => k.time === 1.0)).toBe(false);

    // (a) exactly ONE atomic undo entry; undo restores t=1.0.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);

    useDagStore.getState().undo();
    const restored = (
      useDagStore.getState().state.nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown; easing: string }>;
      }
    ).keyframes;
    expect(restored).toHaveLength(1);
    expect(restored[0].time).toBe(1.0);
    expect(restored[0].value).toEqual(V);
    expect(restored[0].easing).toBe('cubic');
  });

  it('collision: retime onto an occupied time overwrites (last-wins, D-03); one undo restores BOTH', () => {
    useDagStore.getState().hydrate(
      seedWithSample([
        { time: 1.0, value: V, easing: 'cubic' },
        { time: 2.0, value: [9, 9, 9], easing: 'linear' },
      ]),
    );

    const res = dispatchRetimeKeyframe({
      channelId: 'box_position_channel',
      fromTime: 1.0,
      toTime: 2.0, // collide onto the existing t=2.0 occupant
    });
    expect(res).toEqual({ ok: true });

    const kfs = (
      useDagStore.getState().state.nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown; easing: string }>;
      }
    ).keyframes;
    // exactly one sample at toTime — the occupant was overwritten by the
    // moved key (D-03 last-wins; falls out of keyframe.ts:110's replace).
    expect(kfs).toHaveLength(1);
    expect(kfs[0].time).toBe(2.0);
    expect(kfs[0].value).toEqual(V); // the MOVED key's value won
    expect(kfs[0].easing).toBe('cubic');

    // ONE atomic undo restores BOTH original samples.
    expect(useDagStore.getState().undoStack).toHaveLength(1);
    useDagStore.getState().undo();
    const restored = (
      useDagStore.getState().state.nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown }>;
      }
    ).keyframes;
    expect(restored.map((k) => k.time).sort((a, b) => a - b)).toEqual([1.0, 2.0]);
  });

  it('no sample at fromTime → { ok:false }, DAG byte-unchanged', () => {
    useDagStore.getState().hydrate(seedWithSample([{ time: 1.0, value: V, easing: 'cubic' }]));
    const before = JSON.stringify(useDagStore.getState().state);

    const res = dispatchRetimeKeyframe({
      channelId: 'box_position_channel',
      fromTime: 5.0, // no sample here
      toTime: 6.0,
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });
});

describe('#190 — camera first key (no AnimationLayer wrapper)', () => {
  it('keying a camera scalar (fov) creates a free-floating channel targeting the camera', () => {
    useDagStore.getState().hydrate(buildSceneWithCamera());

    const res = dispatchFirstKeyComposite({
      targetId: 'n_cam',
      paramPath: 'fov',
      value: 35,
      seconds: 0,
    });
    expect(res).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    const ch = nodes['n_cam_fov_channel'];
    expect(ch).toBeDefined();
    expect(ch.type).toBe('KeyframeChannelNumber');
    expect((ch.params as { target: string }).target).toBe('n_cam');
    expect((ch.params as { paramPath: string }).paramPath).toBe('fov');
    const kfs = (ch.params as { keyframes: Array<{ time: number; value: unknown }> }).keyframes;
    expect(kfs).toHaveLength(1);
    expect(kfs[0]).toMatchObject({ time: 0, value: 35 });

    // CRITICAL: the camera is NOT wrapped in an AnimationLayer, and scene.camera
    // still points at the camera node (not a layer) — else look-through breaks.
    expect(Object.values(nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
    const camRef = nodes['scene'].inputs['camera'];
    const ref = Array.isArray(camRef) ? camRef[0] : camRef;
    expect((ref as { node: string }).node).toBe('n_cam');

    // One atomic undo entry.
    expect(useDagStore.getState().undoStack).toHaveLength(1);
  });

  it('keying a camera vec3 (position) creates a KeyframeChannelVec3', () => {
    useDagStore.getState().hydrate(buildSceneWithCamera());
    const res = dispatchFirstKeyComposite({
      targetId: 'n_cam',
      paramPath: 'position',
      value: [3, 2, 3],
      seconds: 0,
    });
    expect(res).toEqual({ ok: true });
    const ch = useDagStore.getState().state.nodes['n_cam_position_channel'];
    expect(ch.type).toBe('KeyframeChannelVec3');
    expect((ch.params as { paramPath: string }).paramPath).toBe('position');
  });

  it('a second key on the same camera param routes through keyframe (no second channel)', () => {
    useDagStore.getState().hydrate(buildSceneWithCamera());
    dispatchFirstKeyComposite({ targetId: 'n_cam', paramPath: 'fov', value: 20, seconds: 0 });
    const second = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'n_cam_fov_channel', time: 1, value: 80 },
      'second camera key',
    );
    expect(second).toEqual({ ok: true });
    const kfs = (
      useDagStore.getState().state.nodes['n_cam_fov_channel'].params as {
        keyframes: Array<{ time: number; value: unknown }>;
      }
    ).keyframes;
    expect(kfs.map((k) => k.time)).toEqual([0, 1]);
    // Still no layer, still exactly one channel for the camera.
    const nodes = useDagStore.getState().state.nodes;
    expect(Object.values(nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
    expect(Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel'))).toHaveLength(
      1,
    );
  });
});

describe('A2 — dispatchFirstKeyComposite (multi-Mutator fork-evolve)', () => {
  it('first key: layer + channel + sample land atomically with deterministic ids', () => {
    useDagStore.getState().hydrate(buildScene());
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const res = dispatchFirstKeyComposite({
      targetId: 'box',
      paramPath: 'position',
      value: [0, 0, 0],
      seconds: 0,
    });

    expect(res).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    // Deterministic ids match addLayer.ts:131 / addChannel.ts:181.
    expect(nodes['box_layer']).toBeDefined();
    expect(nodes['box_layer'].type).toBe('AnimationLayer');
    expect(nodes['box_position_channel']).toBeDefined();
    expect(nodes['box_position_channel'].type).toBe('KeyframeChannelVec3');

    const kfs = (
      nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown }>;
      }
    ).keyframes;
    expect(kfs).toHaveLength(1);
    expect(kfs[0]).toMatchObject({ time: 0, value: [0, 0, 0] });

    // H34 splice: Scene.children now names the layer's .out, NOT raw box.
    const scene = nodes['scene'];
    const childRefs = scene.inputs['children'];
    const refs = Array.isArray(childRefs) ? childRefs : [childRefs];
    expect(refs.some((r) => r.node === 'box_layer')).toBe(true);
    expect(refs.some((r) => r.node === 'box')).toBe(false);

    // Exactly one atomic undo entry for the whole composite.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
  });

  it('second key on the same param routes through single keyframe (no duplicate layer)', () => {
    useDagStore.getState().hydrate(buildScene());

    const first = dispatchFirstKeyComposite({
      targetId: 'box',
      paramPath: 'position',
      value: [0, 0, 0],
      seconds: 0,
    });
    expect(first).toEqual({ ok: true });

    // Second key: the channel exists now → single keyframe Mutator.
    const second = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'box_position_channel', time: 1, value: [0, 5, 0] },
      'second key',
    );
    expect(second).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    const layers = Object.values(nodes).filter((n) => n.type === 'AnimationLayer');
    expect(layers).toHaveLength(1); // no duplicate layer

    const kfs = (
      nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown }>;
      }
    ).keyframes;
    expect(kfs).toHaveLength(2);
    expect(kfs.map((k) => k.time)).toEqual([0, 1]);

    // Two atomic entries total (one composite + one keyframe).
    expect(useDagStore.getState().undoStack).toHaveLength(2);
  });

  it('addChannel validates against the FORKED state (closure resolves the fresh layer id)', () => {
    // If addChannel were validated against the un-forked base, its
    // closure could not resolve box_layer and validate would reject.
    // A green composite IS the proof the fork-evolve sequencing is correct.
    useDagStore.getState().hydrate(buildScene());
    const res = dispatchFirstKeyComposite({
      targetId: 'box',
      paramPath: 'rotation',
      value: [0, 0, 0],
      seconds: 0,
    });
    expect(res).toEqual({ ok: true });
    expect(useDagStore.getState().state.nodes['box_rotation_channel']).toBeDefined();
  });

  // P7.12 D-04 (FLAG-4): post-migration the composite delegates to the
  // Time-wire-free addChannel, so its applied DAG must carry ZERO
  // `socket:'time'` connects landing on the channel, AND no channel input
  // binds the now-dropped `time` socket. This locks the invariant that the
  // first-key composite no longer roots/wires a TimeSource into the channel.
  it('FLAG-4: first-key composite emits NO time wire into the channel (D-04)', () => {
    useDagStore.getState().hydrate(buildScene());
    const res = dispatchFirstKeyComposite({
      targetId: 'box',
      paramPath: 'position',
      value: [0, 0, 0],
      seconds: 0,
    });
    expect(res).toEqual({ ok: true });

    // The channel node carries no binding on a `time` input socket.
    const channel = useDagStore.getState().state.nodes['box_position_channel'];
    expect(channel).toBeDefined();
    expect((channel.inputs as Record<string, unknown>).time).toBeUndefined();

    // No node in the resulting DAG wires anything into the channel's `time`.
    for (const node of Object.values(useDagStore.getState().state.nodes)) {
      const bindings = Object.values(node.inputs ?? {}).flat();
      for (const b of bindings) {
        const ref = b as { node?: string; socket?: string } | undefined;
        // Nothing should bind the channel via a `time`-named socket on it,
        // and the channel itself declares no `time` input.
        if (ref?.node === 'box_position_channel') {
          // The only legal consumer wiring is layer.animation ← channel.out;
          // there must be no time edge.
          expect(node.type === 'AnimationLayer' || node.type === 'KeyframeChannelVec3').toBe(true);
        }
      }
    }
  });
});
