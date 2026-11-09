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

import { chainFollowUpOps } from '../dag/chainEdit';
import { cameraRotationLookingAt } from '../../app/cameraOrientation';
import { applyOp, emptyDagState, type DagState } from '../dag';
import type { Op } from '../dag/types';
import { composeProject, type Project } from './index';

export const DEFAULT_PROJECT_ID = 'default';

const DEFAULT_OPS: Op[] = [
  // #387 Stage C (C4) — the camera is split-native: a CameraData (the lens — projection,
  // fov, clip planes) and an Object (the pose, its rotation turning it, #487) that points at it
  // via `data`.
  //
  // ⚠️ THE OBJECT KEEPS THE ID `n_camera`. That id is what `scene.camera` names below, what
  // the v6→v7 migration's id-inheritance produces for an old fused save, and what ~18 e2e
  // files address. The pair a migrated project ends up with and the pair a NEW project starts
  // with are therefore the same shape with the same id — a new project is split-native, so it
  // needs no migration on boot (K23).
  //
  // Values preserved EXACTLY as the fused seed carried them (fov 45 / near 0.01 /
  // position [3,2,3], turned to look at [0,0,0]): the flip changes the shape, not the framing. The one
  // exceptions are the clip planes: far 500 → 1000 (#1193) and near 0.01 → 0.1 (#1195),
  // Blender's camera Clip End and Clip Start.
  {
    type: 'addNode',
    nodeId: 'n_camera_data',
    nodeType: 'CameraData',
    // #1764 — focused on the origin it looks at, so its aim reticle sits there.
    params: {
      projection: 'Perspective',
      fov: 45,
      near: 0.1,
      far: 1000,
      focusDistance: Math.hypot(3, 2, 3),
    },
  },
  {
    type: 'addNode',
    nodeId: 'n_camera',
    nodeType: 'Object',
    // #1760 — turned to look at the origin by its own rotation, as any Object (V665).
    params: {
      position: [3, 2, 3],
      rotation: cameraRotationLookingAt([3, 2, 3], [0, 0, 0]),
      scale: [1, 1, 1],
    },
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
    // #1765 — a sun shines down its own −Z. It is aimed at the origin by the Track-To at the end,
    // and turned that way by its own rotation too, so muting the Track-To changes nothing.
    params: {
      position: [5, 5, 3],
      rotation: cameraRotationLookingAt([5, 5, 3], [0, 0, 0]),
      scale: [1, 1, 1],
    },
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
  // #1765 — the sun comes aimed at the world origin by a Track-To at an empty there, "Sun.aim",
  // that the user moves to re-aim it: the one way every light is aimed (`lightAimOps`, which
  // Add ▸ Light goes through). Last, so the scene it hangs in exists.
  {
    type: 'addNode',
    nodeId: 'n_light_target',
    nodeType: 'Null',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  { type: 'setMeta', nodeId: 'n_light_target', name: 'Sun.aim' },
  {
    type: 'connect',
    from: { node: 'n_light_target', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  },
  {
    type: 'addNode',
    nodeId: 'n_light_aim',
    nodeType: 'TrackTo',
    params: {
      name: 'aim',
      target: 'n_light',
      aimNode: 'n_light_target',
      aimPoint: [0, 0, 0],
      up: [0, 1, 0],
      mute: false,
      order: 0,
    },
  },
];

export function buildDefaultDagState(): DagState {
  let state = emptyDagState();
  for (const op of DEFAULT_OPS) state = applyOp(state, op).next;
  // #1812 — built off the store, so the commit step that wires a constraint's chain is run here.
  for (const op of chainFollowUpOps(emptyDagState(), state)) state = applyOp(state, op).next;
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
