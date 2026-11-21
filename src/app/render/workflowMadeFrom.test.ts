// #1717 — a shot's workflow is stale when anything that decides ANY of its frames moved, and only
// then: moving one shot's camera marks that shot stale and no other.
//
// The graph: the default scene, three cameras on a switch cut at 0 s, 1 s and 2 s (three shots of
// 30 frames), the beauty / depth / normal passes filming through the switch, and one stylized
// workflow per shot reading the passes over the shot's frames.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { comfyControllerPath } from '../../core/comfy/basherControllers';
import {
  STYLIZED_REALISM_META,
  STYLIZED_REALISM_WORKFLOW,
} from '../../core/comfy/builtinWorkflows';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { buildSetActiveCameraOps } from '../setActiveCamera';
import { shotsOf } from '../shots';
import { madeStateOf, workflowMadeFrom } from './workflowMadeFrom';

beforeAll(() => registerAllNodes());

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

/** Three cameras cut at `cuts` (seconds), the three passes, and a workflow per shot. */
function film(
  cuts: [number, string][] = [
    [0, 'n_camera'],
    [1, 'cam2'],
    [2, 'cam3'],
  ],
  end = 3,
): { state: DagState; shots: string[] } {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) s = apply(s, buildSetActiveCameraOps(s, id) ?? []);
  const select = shotsOf(s, end).selectId!;
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: select,
        paramPath: 'active',
        keyframes: cuts.map(([time, value]) => ({ time, value, easing: 'constant' })),
      },
    },
  ];
  for (const [pass, type] of [
    ['beauty', 'BeautyPass'],
    ['depth', 'DepthPass'],
    ['normal', 'NormalPass'],
  ]) {
    ops.push(
      { type: 'addNode', nodeId: `p_${pass}`, nodeType: type, params: {} },
      {
        type: 'connect',
        from: { node: 'n_scene', socket: 'out' },
        to: { node: `p_${pass}`, socket: 'scene' },
      },
      {
        type: 'connect',
        from: { node: select, socket: 'out' },
        to: { node: `p_${pass}`, socket: 'camera' },
      },
      {
        type: 'connect',
        from: { node: 'n_time', socket: 'out' },
        to: { node: `p_${pass}`, socket: 'time' },
      },
    );
  }
  s = apply(s, ops);
  const shots = shotsOf(s, end).shots;
  const ids: string[] = [];
  for (const shot of shots) {
    const id = `shot${shot.index + 1}`;
    ids.push(id);
    const frameStart = Math.round(shot.start * 30);
    const frameEnd = Math.round(shot.end * 30) - 1;
    s = apply(s, [
      {
        type: 'addNode',
        nodeId: id,
        nodeType: 'ComfyUIWorkflow',
        params: {
          graph: { apiJson: STYLIZED_REALISM_WORKFLOW, meta: STYLIZED_REALISM_META },
          frameStart,
          frameEnd,
          outputPath: `renders/shots/${id}`,
        },
      },
      ...['beauty', 'depth', 'normal'].map(
        (pass): Op => ({
          type: 'connect',
          from: { node: `p_${pass}`, socket: 'out' },
          to: { node: id, socket: pass },
        }),
      ),
      {
        type: 'connect',
        from: { node: 'n_time', socket: 'out' },
        to: { node: id, socket: 'time' },
      },
    ]);
  }
  return { state: s, shots: ids };
}

/** Every workflow recorded as made from what it would make now. */
function allMade(s: DagState, ids: readonly string[]): DagState {
  return apply(
    s,
    ids.map((id) => ({
      type: 'setParam',
      nodeId: id,
      paramPath: 'madeFrom',
      value: workflowMadeFrom(s, id),
    })),
  );
}

const states = (s: DagState, ids: readonly string[]) => ids.map((id) => madeStateOf(s, id));

describe('#1717 — what a shot was made from covers every frame of the shot', () => {
  it('three shots, three cameras: the fixture cuts where it says', () => {
    const { state } = film();
    expect(shotsOf(state, 3).shots.map((x) => [x.start, x.end, x.cameraId])).toEqual([
      [0, 1, 'n_camera'],
      [1, 2, 'cam2'],
      [2, 3, 'cam3'],
    ]);
  });

  it("moving shot 2's camera marks shot 2 stale, and shots 1 and 3 stay current", () => {
    const { state, shots } = film();
    const made = allMade(state, shots);
    expect(states(made, shots)).toEqual(['current', 'current', 'current']);
    const moved = apply(made, [
      { type: 'setParam', nodeId: 'cam2', paramPath: 'position', value: [25, 1, 0] },
    ]);
    expect(states(moved, shots)).toEqual(['current', 'stale', 'current']);
  });

  it("a key on shot 2's camera in the middle of the shot marks shot 2 stale, and only shot 2", () => {
    const { state, shots } = film();
    const made = allMade(state, shots);
    const keyed = apply(made, [
      {
        type: 'addNode',
        nodeId: 'cam2_pos',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'cam2',
          paramPath: 'position',
          keyframes: [{ time: 1.5, value: [22, 3, 1], easing: 'linear' }],
        },
      },
    ]);
    expect(states(keyed, shots)).toEqual(['current', 'stale', 'current']);
  });

  it("moving shot 1's camera, the switch's own camera, marks only shot 1 stale", () => {
    // The trap: the graph is evaluated without its channels, so a render pass's own hash films
    // with the switch's authored camera at EVERY frame. Read through it, this move would mark all
    // three shots stale.
    const { state, shots } = film();
    const made = allMade(state, shots);
    const moved = apply(made, [
      { type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [3, 9, 9] },
    ]);
    expect(states(moved, shots)).toEqual(['stale', 'current', 'current']);
  });

  it('a camera move after the first frame of the shot is seen (the first frame alone would not)', () => {
    // Shot 2 runs 1 s..2 s on cam2; cam2 is keyed still until 1.6 s and moves after, so the shot's
    // first frame is unchanged and its later frames are not.
    const { state, shots } = film();
    const keyFrom = (to: [number, number, number]): Op => ({
      type: 'addNode',
      nodeId: 'cam2_pos',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 'cam2',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [20, 0, 0], easing: 'linear' },
          { time: 1.6, value: [20, 0, 0], easing: 'linear' },
          { time: 2, value: to, easing: 'linear' },
        ],
      },
    });
    const keyed = apply(state, [keyFrom([30, 0, 0])]);
    const made = allMade(keyed, shots);
    const moved = apply(made, [
      {
        type: 'setParam',
        nodeId: 'cam2_pos',
        paramPath: 'keyframes',
        value: [
          { time: 0, value: [20, 0, 0], easing: 'linear' },
          { time: 1.6, value: [20, 0, 0], easing: 'linear' },
          { time: 2, value: [35, 2, 0], easing: 'linear' },
        ],
      },
    ]);
    expect(
      (moved.nodes.cam2_pos.params as { keyframes: { value: unknown }[] }).keyframes[2].value,
    ).toEqual([35, 2, 0]);
    expect(states(moved, shots)).toEqual(['current', 'stale', 'current']);
  });

  it('moving something every shot films marks every shot stale', () => {
    const { state, shots } = film();
    const made = allMade(state, shots);
    const moved = apply(made, [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 2, 0] },
    ]);
    expect(states(moved, shots)).toEqual(['stale', 'stale', 'stale']);
  });

  it('putting the camera back makes the shot current again', () => {
    const { state, shots } = film();
    const made = allMade(state, shots);
    const away = apply(made, [
      { type: 'setParam', nodeId: 'cam2', paramPath: 'position', value: [25, 1, 0] },
    ]);
    const back = apply(away, [
      { type: 'setParam', nodeId: 'cam2', paramPath: 'position', value: [20, 0, 0] },
    ]);
    expect(states(back, shots)).toEqual(['current', 'current', 'current']);
  });

  it('costs one read per frame: a 10 s shot, measured', () => {
    const { state } = film([[0, 'n_camera']], 10);
    expect(shotsOf(state, 10).shots).toHaveLength(1);
    const t0 = performance.now();
    const hash = workflowMadeFrom(state, 'shot1');
    const cold = performance.now() - t0;
    const t1 = performance.now();
    workflowMadeFrom(state, 'shot1');
    const memoised = performance.now() - t1;
    console.log(
      `[#1717] 10 s shot (300 frames): ${cold.toFixed(1)} ms cold, ${memoised.toFixed(3)} ms memoised`,
    );
    expect(hash).toEqual(expect.any(String));
    expect(memoised).toBeLessThan(1);
  });
});

describe('#1948 — a keyed input of the workflow is part of what it was made from', () => {
  /** A key on the stylized file's `prompt` input (marker node 20) of workflow `id`. */
  const promptKey = (id: string, text: string, nodeId = `${id}_prompt_key`): Op => ({
    type: 'addNode',
    nodeId,
    nodeType: 'KeyframeChannelText',
    params: {
      name: 'prompt',
      target: id,
      paramPath: comfyControllerPath('20'),
      keyframes: [{ time: 1.2, value: text, easing: 'constant' }],
    },
  });
  const setKey = (nodeId: string, text: string): Op => ({
    type: 'setParam',
    nodeId,
    paramPath: 'keyframes',
    value: [{ time: 1.2, value: text, easing: 'constant' }],
  });

  it("changing a key on a workflow's prompt marks it stale, and changing it back marks it current", () => {
    const { state, shots } = film();
    const made = allMade(apply(state, [promptKey('shot2', 'a castle at dusk')]), shots);
    expect(states(made, shots)).toEqual(['current', 'current', 'current']);
    const edited = apply(made, [setKey('shot2_prompt_key', 'a castle in rain')]);
    expect(states(edited, shots)).toEqual(['current', 'stale', 'current']);
    const back = apply(edited, [setKey('shot2_prompt_key', 'a castle at dusk')]);
    expect(states(back, shots)).toEqual(['current', 'current', 'current']);
  });

  it('a first key on the prompt marks the workflow stale (the keyed value replaces the default)', () => {
    const { state, shots } = film();
    const made = allMade(state, shots);
    const keyed = apply(made, [promptKey('shot2', 'a castle in rain')]);
    expect(states(keyed, shots)).toEqual(['current', 'stale', 'current']);
  });

  it("keys on another workflow's prompt do not touch this one", () => {
    const { state, shots } = film();
    const made = allMade(apply(state, [promptKey('shot3', 'night')]), shots);
    const edited = apply(made, [setKey('shot3_prompt_key', 'dawn')]);
    expect(states(edited, shots)).toEqual(['current', 'current', 'stale']);
  });
});

describe('#1717 — an edit the workflow does not read costs no re-read of its frames', () => {
  it('a 60 s shot: an edit elsewhere reuses its answer, an edit it reads does not', () => {
    const { state, shots } = film([[0, 'n_camera']], 60);
    const cold0 = performance.now();
    const first = workflowMadeFrom(state, shots[0]);
    const cold = performance.now() - cold0;
    // Something the shot does not read: a new, unconnected node.
    const elsewhere = apply(state, [
      { type: 'addNode', nodeId: 'unrelated', nodeType: 'TimeSource', params: {} },
    ]);
    const warm0 = performance.now();
    expect(workflowMadeFrom(elsewhere, shots[0])).toBe(first);
    const warm = performance.now() - warm0;
    console.log(
      `[#1717] 60 s shot: ${cold.toFixed(0)} ms read, ${warm.toFixed(1)} ms after an edit elsewhere`,
    );
    expect(warm).toBeLessThan(cold / 4);
    // Something it reads: the camera on screen.
    const moved = apply(state, [
      { type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [1, 2, 3] },
    ]);
    expect(workflowMadeFrom(moved, shots[0])).not.toBe(first);
  });
});
