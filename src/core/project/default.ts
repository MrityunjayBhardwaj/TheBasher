// The minimum viable Basher project — THESIS.md App. C, P0 deliverable.
// Five authored nodes (camera, light, box, time root, scene aggregator)
// plus the RenderOutput sink. Boot Basher with this DAG → see a cube →
// edit camera position → see new angle → save → reload → identical state.
//
// `n_time` is the canonical project clock. THESIS §49 makes Time a
// first-class type; making it part of the seed honors the contract every
// time-consuming Mutator (addChannel, future render-clock) relies on.
// Leaf node, no consumers in the seed — animation channels wire to it
// when they exist.

import { applyOp, emptyDagState, type DagState } from '../dag';
import type { Op } from '../dag/types';
import { composeProject, type Project } from './index';

export const DEFAULT_PROJECT_ID = 'default';

const DEFAULT_OPS: Op[] = [
  {
    type: 'addNode',
    nodeId: 'n_camera',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, near: 0.1, far: 1000, position: [3, 2, 3], lookAt: [0, 0, 0] },
  },
  {
    type: 'addNode',
    nodeId: 'n_light',
    nodeType: 'DirectionalLight',
    params: { intensity: 1.1, position: [5, 5, 3], color: '#ffffff' },
  },
  {
    type: 'addNode',
    nodeId: 'n_box',
    nodeType: 'BoxMesh',
    params: {
      size: [1, 1, 1],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      // v0.6 #2 (#178): OpenPBR IR. base.color explicit; the remaining lobes fill
      // from the zod NEW-box defaults (specular.roughness 0.3 etc).
      material: { name: 'default', base: { color: '#5af07a' } },
    },
  },
  { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
  { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} },
  {
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true }, width: 1920, height: 1080 },
  },
  {
    type: 'connect',
    from: { node: 'n_camera', socket: 'out' },
    to: { node: 'n_scene', socket: 'camera' },
  },
  {
    type: 'connect',
    from: { node: 'n_light', socket: 'out' },
    to: { node: 'n_scene', socket: 'lights' },
  },
  {
    type: 'connect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  },
  {
    type: 'connect',
    from: { node: 'n_scene', socket: 'out' },
    to: { node: 'n_render', socket: 'scene' },
  },
];

export function buildDefaultDagState(): DagState {
  let state = emptyDagState();
  for (const op of DEFAULT_OPS) state = applyOp(state, op).next;
  state = {
    ...state,
    outputs: {
      scene: { node: 'n_scene', socket: 'out' },
      render: { node: 'n_render', socket: 'out' },
    },
  };
  return state;
}

export function buildDefaultProject(): Project {
  const state = buildDefaultDagState();
  return composeProject({ id: DEFAULT_PROJECT_ID, name: 'Untitled', state });
}
