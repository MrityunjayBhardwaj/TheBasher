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
  dispatchPushDownToStrip,
  bareChannelToActionChannel,
} from './dispatchMutator';
import { layeredChannelValues } from '../layeredChannels';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';

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

/** Seed a free-floating Vec3 channel (v0.7 #199 / V57 — no AnimationLayer) so the
 *  single-Mutator keyframe path works. */
function buildSceneWithChannel(): DagState {
  let s = buildScene();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box_position_channel',
    nodeType: 'KeyframeChannelVec3',
    params: { name: 'position', target: 'box', paramPath: 'position', keyframes: [] },
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

describe('A2 — dispatchFirstKeyComposite (native → free-floating direct channel, #199)', () => {
  it('first key: a single direct channel + sample land atomically, NO layer, scene unchanged', () => {
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
    // #199 — a native first-key now mints ONE free-floating channel targeting the
    // node's dagId (V57), the SAME road as camera/glTF. No AnimationLayer wrapper.
    expect(Object.values(nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
    expect(nodes['box_position_channel']).toBeDefined();
    expect(nodes['box_position_channel'].type).toBe('KeyframeChannelVec3');
    expect(nodes['box_layer']).toBeUndefined();

    const params = nodes['box_position_channel'].params as {
      target: string;
      paramPath: string;
      keyframes: Array<{ time: number; value: unknown }>;
    };
    // The channel targets the node by dagId (free-floating, no input socket wiring).
    expect(params.target).toBe('box');
    expect(params.paramPath).toBe('position');
    expect(params.keyframes).toHaveLength(1);
    expect(params.keyframes[0]).toMatchObject({ time: 0, value: [0, 0, 0] });

    // Scene.children STILL names raw box directly — no wrapper splices in.
    const scene = nodes['scene'];
    const childRefs = scene.inputs['children'];
    const refs = Array.isArray(childRefs) ? childRefs : [childRefs];
    expect(refs.some((r) => r.node === 'box')).toBe(true);

    // Exactly one atomic undo entry for the single-op first key.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
  });

  it('second key on the same param routes through single keyframe (no duplicate channel, no layer)', () => {
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
    expect(Object.values(nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
    const channels = Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel'));
    expect(channels).toHaveLength(1); // no duplicate channel

    const kfs = (
      nodes['box_position_channel'].params as {
        keyframes: Array<{ time: number; value: unknown }>;
      }
    ).keyframes;
    expect(kfs).toHaveLength(2);
    expect(kfs.map((k) => k.time)).toEqual([0, 1]);

    // Two atomic entries total (one first key + one keyframe).
    expect(useDagStore.getState().undoStack).toHaveLength(2);
  });

  it('keying a SECOND distinct param mints a SEPARATE direct channel (still no layer)', () => {
    useDagStore.getState().hydrate(buildScene());
    expect(
      dispatchFirstKeyComposite({
        targetId: 'box',
        paramPath: 'position',
        value: [0, 0, 0],
        seconds: 0,
      }),
    ).toEqual({ ok: true });
    expect(
      dispatchFirstKeyComposite({
        targetId: 'box',
        paramPath: 'rotation',
        value: [0, 0, 0],
        seconds: 0,
      }),
    ).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    expect(Object.values(nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
    expect(nodes['box_position_channel']).toBeDefined();
    expect(nodes['box_rotation_channel']).toBeDefined();
    expect((nodes['box_rotation_channel'].params as { target: string }).target).toBe('box');
  });

  // #199 / P7.12 D-04 (FLAG-4): the direct channel is FREE-FLOATING — found by a
  // target scan, never wired through an input socket. It carries no `time` input
  // and nothing in the DAG binds it (no AnimationLayer.animation edge anymore).
  it('FLAG-4: the direct channel is free-floating — no time wire, no consumer edge', () => {
    useDagStore.getState().hydrate(buildScene());
    const res = dispatchFirstKeyComposite({
      targetId: 'box',
      paramPath: 'position',
      value: [0, 0, 0],
      seconds: 0,
    });
    expect(res).toEqual({ ok: true });

    const channel = useDagStore.getState().state.nodes['box_position_channel'];
    expect(channel).toBeDefined();
    expect((channel.inputs as Record<string, unknown>).time).toBeUndefined();

    // No node in the resulting DAG binds the channel via ANY input socket — it is
    // free-floating, resolved purely by its `params.target` dagId.
    for (const node of Object.values(useDagStore.getState().state.nodes)) {
      const bindings = Object.values(node.inputs ?? {}).flat();
      for (const b of bindings) {
        const ref = b as { node?: string; socket?: string } | undefined;
        expect(ref?.node).not.toBe('box_position_channel');
      }
    }
  });
});

describe('5E — dispatchPushDownToStrip (bare channels → Action + Strip, ONE undo entry)', () => {
  /** Seed `box` with a bare vec3 ramp channel (keys 0→[0,0,0] .. 2→[2,1,0]). */
  function seedBareRamp(
    channelId = 'box_position_channel',
    extra?: Record<string, unknown>,
  ): DagState {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: channelId,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 'box',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [2, 1, 0], easing: 'linear' },
        ],
        ...(extra ?? {}),
      },
    }).next;
    return s;
  }

  /** The FOLD's view of `paramPath` on `targetId`, sampled at `times` — via the
   *  real `layeredChannelValues` seam (READ-only import; the same array both
   *  fold consumers eat). One contribution expected before AND after push-down
   *  (bare channel before, strip-synthetic after). */
  function foldSamples(targetId: string, paramPath: string, times: readonly number[]) {
    const values = layeredChannelValues(useDagStore.getState().state.nodes, targetId).filter(
      (v) => v.paramPath === paramPath,
    );
    expect(values).toHaveLength(1);
    return times.map((t) => values[0].sample(t));
  }

  const TIMES = [-1, 0, 1, 2, 5] as const; // inside + both hold sides

  it('happy path: Action+Strip+Track minted, channels GONE, fold byte-identical, ONE undo restores everything', () => {
    useDagStore.getState().hydrate(seedBareRamp());
    const beforeJson = JSON.stringify(useDagStore.getState().state);
    const before = foldSamples('box', 'position', TIMES);
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const res = dispatchPushDownToStrip('box');
    expect(res).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    // The vocabulary nodes exist; the bare channel is GONE (no double-drive —
    // bare channels fold below strips, layeredChannels.ts:224-226).
    expect(nodes['box_position_channel']).toBeUndefined();
    const action = nodes['nla_action_1'];
    expect(action?.type).toBe('Action');
    const channels = (
      action.params as { channels: Array<{ valueType: string; paramPath: string }> }
    ).channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ valueType: 'vec3', paramPath: 'position' });
    const strip = nodes['nla_strip_1'];
    expect(strip?.type).toBe('Strip');
    expect(strip.params).toMatchObject({ action: 'nla_action_1', target: 'box', start: 0 });
    const track = nodes['nla_track_1'];
    expect(track?.type).toBe('Track');
    expect((track.params as { strips: string[] }).strips).toEqual(['nla_strip_1']);

    // OBSERVE the fold: the strip-synthetic contribution samples byte-identical
    // to the bare channel at every probe time (inside the span AND both holds).
    expect(foldSamples('box', 'position', TIMES)).toEqual(before);

    // ONE atomic undo entry covers create+place+delete; undo restores ALL.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
    useDagStore.getState().undo();
    expect(JSON.stringify(useDagStore.getState().state)).toBe(beforeJson);
    expect(useDagStore.getState().state.nodes['box_position_channel']).toBeDefined();
    expect(useDagStore.getState().state.nodes['nla_action_1']).toBeUndefined();
    expect(useDagStore.getState().state.nodes['nla_strip_1']).toBeUndefined();
    expect(useDagStore.getState().state.nodes['nla_track_1']).toBeUndefined();
  });

  it('strip start = the channels’ MIN key time (identity remap inside the span)', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'box_position_channel',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 'box',
        paramPath: 'position',
        keyframes: [
          { time: 0.5, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [3, 0, 0], easing: 'linear' },
        ],
      },
    }).next;
    useDagStore.getState().hydrate(s);
    const before = foldSamples('box', 'position', TIMES);

    expect(dispatchPushDownToStrip('box')).toEqual({ ok: true });
    expect(
      (useDagStore.getState().state.nodes['nla_strip_1'].params as { start: number }).start,
    ).toBe(0.5);
    expect(foldSamples('box', 'position', TIMES)).toEqual(before);
  });

  it('no bare channels → {ok:false}, DAG byte-unchanged', () => {
    useDagStore.getState().hydrate(buildScene());
    const before = JSON.stringify(useDagStore.getState().state);
    const res = dispatchPushDownToStrip('box');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no bare keyframe channels');
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });

  // #386 — the object↔data split moved a light's shading onto its LightData, so the
  // channel a director authors from the Light Studio panel targets the DATA half while the
  // selection (and every management surface) addresses the OBJECT. An exact-id enumeration
  // reports zero bare channels and push-down refuses on a visibly animated light — silently,
  // because "no bare channels" is a legitimate answer. The Strip still targets the OBJECT:
  // a Strip carries ONE target, and V112 forbids giving a data node its own strip lane.
  it('SPLIT LIGHT: pushes down a shading channel that targets the DATA half; the Strip stays on the Object', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt_data',
      nodeType: 'LightData',
      params: { lightKind: 'Point', intensity: 5 },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt',
      nodeType: 'Object',
      params: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'lt_data', socket: 'out' },
      to: { node: 'lt', socket: 'data' },
    }).next;
    // The channel a Light Studio keyframe authors: on the LIGHTDATA, not the Object.
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt_intensity_channel',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: 'lt_data',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 5, easing: 'linear' },
          { time: 2, value: 40, easing: 'linear' },
        ],
      },
    }).next;
    useDagStore.getState().hydrate(s);

    // Selecting the OBJECT — the only thing a director can select — must find it.
    const res = dispatchPushDownToStrip('lt');
    expect(res).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    expect(nodes['lt_intensity_channel'], 'the data half bare channel is consumed').toBeUndefined();
    const action = nodes['nla_action_1'];
    const channels = (action.params as { channels: Array<{ paramPath: string }> }).channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ valueType: 'number', paramPath: 'intensity' });
    // The Strip targets the OBJECT (V112 — animation aggregates under the object), and the
    // light's FLAT overlay reads `value.intensity`, so it drives from there.
    expect(nodes['nla_strip_1'].params).toMatchObject({ target: 'lt', start: 0 });

    // RENDER side: the strip-synthetic intensity is served on the OBJECT, which is where
    // the light's flat overlay (useLightShadingChannels → useLayeredChannels(objectId))
    // picks it up. It samples the same 5 → 40 the consumed bare channel did.
    const objFold = layeredChannelValues(nodes, 'lt').filter((v) => v.paramPath === 'intensity');
    expect(objFold).toHaveLength(1);
    expect([objFold[0].sample(0), objFold[0].sample(2)]).toEqual([5, 40]);

    // READ side (H40): the inspector renders a LightData's rows against the DATA id, and
    // nothing targets the data node any more — so the read MUST reach up to the poser or it
    // reports the static base 5 while the viewport animates to 40. The inverse reach in
    // resolveEvaluatedParam is what closes that; assert the read agrees with the render at
    // BOTH ends of the ramp (one sample would pass on any value that merely differs).
    const readAt = (t: number) =>
      resolveEvaluatedParam(useDagStore.getState().state, 'lt_data', 'intensity', {
        time: { frame: Math.round(t * 60), seconds: t, normalized: 0 },
      })?.value;
    expect(readAt(0), 'read == render at t=0').toBe(5);
    expect(readAt(2), 'read == render at t=2').toBe(40);
  });

  it('unknown target → {ok:false} without mutation', () => {
    useDagStore.getState().hydrate(buildScene());
    const res = dispatchPushDownToStrip('nope');
    expect(res.ok).toBe(false);
  });

  it('HONESTY GUARD: a channel with non-default weight is REFUSED by name; DAG byte-unchanged', () => {
    useDagStore.getState().hydrate(seedBareRamp('box_position_channel', { weight: 0.5 }));
    const before = JSON.stringify(useDagStore.getState().state);
    const res = dispatchPushDownToStrip('box');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('box_position_channel');
      expect(res.reason).toContain('weight');
    }
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });
});

describe('5E — bareChannelToActionChannel (the pure mapper + refusal guard)', () => {
  const baseParams = {
    name: 'position',
    target: 'box',
    paramPath: 'position',
    mute: false,
    weight: 1,
    blendMode: 'replace',
    order: 0,
    extendBefore: 'hold',
    extendAfter: 'hold',
    modifiers: [],
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [2, 1, 0], easing: 'linear' },
    ],
  };
  const node = (params: Record<string, unknown>, type = 'KeyframeChannelVec3') => ({
    id: 'ch1',
    type,
    params,
  });

  it('maps a default vec3 channel: target STRIPPED, valueType added, keyframes verbatim', () => {
    const res = bareChannelToActionChannel(node({ ...baseParams }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.channel.valueType).toBe('vec3');
      expect(res.channel.paramPath).toBe('position');
      expect('target' in res.channel).toBe(false);
      expect(res.channel.keyframes).toMatchObject([
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 2, value: [2, 1, 0], easing: 'linear' },
      ]);
    }
  });

  it('absent optional fields read as their defaults (text/image schemas differ)', () => {
    // A minimal params object (only what a Text channel carries) must not be
    // refused for "missing" extend/modifier fields.
    const res = bareChannelToActionChannel(
      node(
        {
          name: 'prompt',
          target: 'box',
          paramPath: 'prompt',
          keyframes: [{ time: 0, value: 'hello', easing: 'linear' }],
        },
        'KeyframeChannelText',
      ),
    );
    expect(res.ok).toBe(true);
  });

  it.each([
    [
      'unknown node type',
      { ...baseParams },
      'KeyframeChannelFuture',
      'no Action-channel equivalent',
    ],
    ['mute', { ...baseParams, mute: true }, 'KeyframeChannelVec3', 'muted'],
    ['weight', { ...baseParams, weight: 0.5 }, 'KeyframeChannelVec3', 'weight'],
    ['blendMode', { ...baseParams, blendMode: 'combine' }, 'KeyframeChannelVec3', 'blendMode'],
    ['order', { ...baseParams, order: 3 }, 'KeyframeChannelVec3', 'fold order'],
    [
      'extendBefore',
      { ...baseParams, extendBefore: 'slope' },
      'KeyframeChannelVec3',
      'extrapolation',
    ],
    [
      'extendAfter',
      { ...baseParams, extendAfter: 'slope' },
      'KeyframeChannelVec3',
      'extrapolation',
    ],
    [
      'modifiers',
      { ...baseParams, modifiers: [{ type: 'noise', enabled: true }] },
      'KeyframeChannelVec3',
      'F-Modifier',
    ],
    [
      'axisModifiers',
      { ...baseParams, axisModifiers: [null, [{ type: 'noise', enabled: true }], null] },
      'KeyframeChannelVec3',
      'per-axis',
    ],
    [
      'baked glTF (childName)',
      { ...baseParams, childName: 'Hips' },
      'KeyframeChannelVec3',
      'baked glTF',
    ],
    [
      'baked glTF (assetRef)',
      { ...baseParams, assetRef: 'a1' },
      'KeyframeChannelVec3',
      'baked glTF',
    ],
  ])('REFUSES %s, naming the channel', (_label, params, type, reasonPart) => {
    const res = bareChannelToActionChannel(node(params as Record<string, unknown>, type));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('ch1');
      expect(res.reason).toContain(reasonPart);
    }
  });
});
