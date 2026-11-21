// #1718 test fixture — a still workflow and two shots' video workflows, as files and as a graph.
//
// The still workflow (`sw`) takes Basher's render on `render`, a `prompt` and a `seed`, and makes
// one still (`still`). Each shot's video workflow takes a still on `first_frame` and makes frames
// (`video`) over its shot's frames: shot 1 is frames 0..2, shot 2 frames 3..5. Shot 1's first
// frame is wired from the still; shot 2 has none, so it is the shot an edit to the still must
// leave alone.

import type { ComfyApiJson } from '../core/comfy/comfyGraph';
import { applyOp, emptyDagState } from '../core/dag';
import type { DagState } from '../core/dag/state';

export const STILL_FILE: ComfyApiJson = {
  '1': { class_type: 'basher_controller', inputs: { name: 'render', kind: 'image', image: '' } },
  '2': {
    class_type: 'basher_controller',
    inputs: { name: 'prompt', kind: 'string', values_json: '["a castle at dusk"]' },
  },
  '3': {
    class_type: 'basher_controller',
    inputs: { name: 'seed', kind: 'int', values_json: '[7]' },
  },
  '4': {
    class_type: 'KSampler',
    inputs: { seed: ['3', 0], positive: ['2', 0], latent_image: ['1', 0] },
  },
  '5': { class_type: 'basher_export', inputs: { name: 'still', kind: 'image', images: ['4', 0] } },
};

export const VIDEO_FILE: ComfyApiJson = {
  '1': {
    class_type: 'basher_controller',
    inputs: { name: 'first_frame', kind: 'image', image: '' },
  },
  '2': { class_type: 'WanImageToVideo', inputs: { start_image: ['1', 0] } },
  '3': { class_type: 'basher_export', inputs: { name: 'video', kind: 'video', images: ['2', 0] } },
};

export const FIXTURE_META = { name: 'fixture', importedAt: 'x', fps: 30, frames: 1 };

function addWorkflow(
  s: DagState,
  nodeId: string,
  apiJson: ComfyApiJson,
  frameStart: number,
  frameEnd: number,
  outputPath: string,
): DagState {
  return applyOp(s, {
    type: 'addNode',
    nodeId,
    nodeType: 'ComfyUIWorkflow',
    params: { graph: { apiJson, meta: FIXTURE_META }, frameStart, frameEnd, outputPath },
  }).next;
}

/** The still `sw`, shot 1's `shot1` (wired from the still) and shot 2's `shot2` (not). */
export function stillAndShots(opts: { wired?: boolean } = {}): DagState {
  let s = emptyDagState();
  s = addWorkflow(s, 'sw', STILL_FILE, 0, 0, 'renders/generated/still');
  s = addWorkflow(s, 'shot1', VIDEO_FILE, 0, 2, 'renders/shot1/video');
  s = addWorkflow(s, 'shot2', VIDEO_FILE, 3, 5, 'renders/shot2/video');
  if (opts.wired === false) return s;
  return applyOp(s, {
    type: 'connect',
    from: { node: 'sw', socket: 'still' },
    to: { node: 'shot1', socket: 'first_frame' },
  }).next;
}
