// #1318 — the Comfy batch bakes resolve the graph once per bake, not once per frame.
//
// "Render coherent clip" bakes each keyframeable workflow param (Mode B) or each scalar
// basher_controller (Mode A) frame by frame through `resolveEvaluatedParam`. A driver on one of
// those params evaluates its source through the scene, and on the "Camera Path + AI Walk" example
// the camera aims at the walker's Hips, so a driver reading the camera reaches the character's
// whole-clip `RetargetClip`. Measured before the fix over 6 frames: 6 retargets per bake, one per
// frame. With one evaluator cache per bake: 1.
//
// The keyframed param rides along so the shared cache is checked where it could go wrong: a
// time-dependent value must still change frame by frame, and match an uncached read.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { __retargetRunsForTests } from '../../nodes/RetargetClip';
import { buildExampleProject } from '../../core/project/examples';
import { applyOp, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { importComfyGraph, comfyParamPath, type ComfyApiJson } from '../../core/comfy/comfyGraph';
import { comfyControllerPath, scanBasherControllers } from '../../core/comfy/basherControllers';
import { buildBindDriverOps } from '../driverBind';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import { bakeBasherControllerValues, bakeComfyBatchedTracks } from './compileComfyBatch';

const META = { name: 'wf', importedAt: 'fixed', fps: 30, frames: 6 };
const LAST_FRAME = 5; // frames 0..5 inclusive: 6 frames

/** A vanilla workflow (Mode B): KSampler's cfg is keyed, its denoise is driven. */
const VANILLA: ComfyApiJson = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 20, cfg: 6.5, denoise: 1.0, model: ['4', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5.safetensors' } },
};
/** An authored workflow (Mode A): two float controllers, one keyed, one driven. */
const CONTROLLED: ComfyApiJson = {
  '3': { class_type: 'KSampler', inputs: { cfg: ['10', 0], denoise: ['11', 0], model: ['4', 0] } },
  '10': {
    class_type: 'basher_controller',
    inputs: { name: 'CFG', kind: 'float', values_json: '[7.5]', frame_count: 1 },
  },
  '11': {
    class_type: 'basher_controller',
    inputs: { name: 'Denoise', kind: 'float', values_json: '[1]', frame_count: 1 },
  },
};

beforeAll(() => registerAllNodes());

/** The example with a workflow node holding `apiJson`: `keyed` ramps 0 → 5 over the first
 *  second, and `driven` is driven by the camera's x, which reaches the walker through the
 *  camera's aim. */
async function exampleWithWorkflow(
  apiJson: ComfyApiJson,
  keyed: string,
  driven: string,
): Promise<DagState> {
  let s: DagState = (await buildExampleProject('example_camera_path_ai_walk')).state;
  const run = (ops: Op[]) => {
    for (const op of ops) s = applyOp(s, op).next;
  };
  run([
    {
      type: 'addNode',
      nodeId: 'cw',
      nodeType: 'ComfyUIWorkflow',
      params: { graph: { apiJson, meta: META } },
    } as Op,
    {
      type: 'addNode',
      nodeId: 'cw_ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        target: 'cw',
        paramPath: keyed,
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 5, easing: 'linear' },
        ],
      },
    } as Op,
  ]);
  const bind = buildBindDriverOps(s, {
    targetId: 'cw',
    paramPath: driven,
    driverId: 'cw_drv',
    source: { kind: 'transform', id: 'cam_tx', label: 'tx', node: 'n_camera', channel: 'tx' },
  });
  if (!bind.ok) throw new Error(bind.reason);
  run(bind.ops);
  return s;
}

/** What an uncached read gives for `paramPath` at each frame of the bake. */
function uncached(s: DagState, paramPath: string): unknown[] {
  return Array.from({ length: LAST_FRAME + 1 }, (_, frame) => {
    const ctx = { time: { frame, seconds: frame / 30, normalized: frame / (LAST_FRAME + 1) } };
    return resolveEvaluatedParam(s, 'cw', paramPath, ctx)?.value;
  });
}

describe('#1318 — a Comfy batch bake resolves the graph once', () => {
  it('Mode B: the param bake retargets once, and a keyed param still ramps per frame', async () => {
    const s = await exampleWithWorkflow(
      VANILLA,
      comfyParamPath('3', 'cfg'),
      comfyParamPath('3', 'denoise'),
    );
    const graph = importComfyGraph(VANILLA, META);

    const before = __retargetRunsForTests();
    const tracks = bakeComfyBatchedTracks(s, 'cw', graph, 0, LAST_FRAME, 30, LAST_FRAME + 1);
    expect(__retargetRunsForTests() - before).toBe(1);

    const values = (name: string) => tracks.find((t) => t.inputName === name)!.values;
    expect(new Set(values('cfg')).size).toBe(LAST_FRAME + 1);
    expect(values('cfg')).toEqual(uncached(s, comfyParamPath('3', 'cfg')));
    expect(values('denoise')).toEqual(uncached(s, comfyParamPath('3', 'denoise')));
  });

  it('Mode A: the controller bake retargets once, and a keyed controller still ramps', async () => {
    const s = await exampleWithWorkflow(
      CONTROLLED,
      comfyControllerPath('10'),
      comfyControllerPath('11'),
    );
    const decls = scanBasherControllers(CONTROLLED);
    expect(decls.map((d) => d.nodeId).sort()).toEqual(['10', '11']);

    const before = __retargetRunsForTests();
    const out = bakeBasherControllerValues(s, 'cw', decls, 0, LAST_FRAME, 30, LAST_FRAME + 1);
    expect(__retargetRunsForTests() - before).toBe(1);

    expect(new Set(out['10']).size).toBe(LAST_FRAME + 1);
    expect(out['10']).toEqual(uncached(s, comfyControllerPath('10')));
    expect(out['11']).toEqual(uncached(s, comfyControllerPath('11')));
  });
});
