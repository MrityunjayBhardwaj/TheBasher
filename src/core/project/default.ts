// The minimum viable Basher project — THESIS.md App. C, P0 deliverable.
// Authored nodes: camera, light, the box (an Object posed over a BoxData — the
// object↔data split, #365 Phase 5a), time root, scene aggregator, plus the
// RenderOutput sink. Boot Basher with this DAG → see a cube →
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
  // #387 Stage C (C4) — the camera is split-native: a CameraData (the lens — projection,
  // fov, clip planes, and the aim params lookAt/roll which stay on the data half
  // parity-first, #387 D1) and an Object (the pose) that points at it via `data`.
  //
  // ⚠️ THE OBJECT KEEPS THE ID `n_camera`. That id is what `scene.camera` names below, what
  // the v6→v7 migration's id-inheritance produces for an old fused save, and what ~18 e2e
  // files address. The pair a migrated project ends up with and the pair a NEW project starts
  // with are therefore the same shape with the same id — a new project is split-native, so it
  // needs no migration on boot (K23).
  //
  // Values preserved EXACTLY as the fused seed carried them (fov 45 / near 0.01 / far 500 /
  // position [3,2,3] / lookAt [0,0,0]): the flip changes the shape, not the framing.
  {
    type: 'addNode',
    nodeId: 'n_camera_data',
    nodeType: 'CameraData',
    params: { projection: 'Perspective', fov: 45, near: 0.01, far: 500, lookAt: [0, 0, 0] },
  },
  {
    type: 'addNode',
    nodeId: 'n_camera',
    nodeType: 'Object',
    params: { position: [3, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  {
    type: 'connect',
    from: { node: 'n_camera_data', socket: 'out' },
    to: { node: 'n_camera', socket: 'data' },
  },
  // #386 Stage C (C3) — the key light is split-native: a LightData (kind + shading) and an
  // Object (pose) that points at it via `data`. The Object keeps the id `n_light`, so the
  // scene.lights edge below is unchanged — the same pair the load-migration produces for old
  // fused saves (K23). A new project is split-native, so it needs no migration on boot.
  {
    type: 'addNode',
    nodeId: 'n_light_data',
    nodeType: 'LightData',
    params: { lightKind: 'Directional', intensity: 1.1, color: '#ffffff' },
  },
  {
    type: 'addNode',
    nodeId: 'n_light',
    nodeType: 'Object',
    params: { position: [5, 5, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  {
    type: 'connect',
    from: { node: 'n_light_data', socket: 'out' },
    to: { node: 'n_light', socket: 'data' },
  },
  // #365 Phase 5a (Slice 1b) — the box is split-native: a BoxData (geometry + material) and
  // an Object (pose) that points at it via `data`. The Object keeps the id `n_box`, so the
  // scene.children edge below (and any reference to the box) is unchanged — the same pair the
  // load-migration produces for old fused saves (K23). A new project is split-native.
  {
    type: 'addNode',
    nodeId: 'n_box_data',
    nodeType: 'BoxData',
    params: {
      size: [1, 1, 1],
      // #394 D7 — NO `material`. The canonical seed takes THE standard material from
      // the schema, so a new project's cube is the same cube Add ▸ Cube produces; it
      // used to author `base.color: '#5af07a'`, which made the seed the one green
      // thing in an otherwise standardized app. Named example scenes (examples.ts)
      // keep their authored palettes — those colours are the content.
    },
  },
  {
    type: 'addNode',
    nodeId: 'n_box',
    nodeType: 'Object',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  {
    type: 'connect',
    from: { node: 'n_box_data', socket: 'out' },
    to: { node: 'n_box', socket: 'data' },
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
