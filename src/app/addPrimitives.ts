// addPrimitives — pure Op-chain builders for the Add menu.
//
// Each builder returns an `AddResult` with the ops + a description used
// for the undo entry. The caller (AddMenu / Shift+A handler) wraps the
// chain in `dispatchAtomic` so one menu pick = one Cmd+Z entry.
//
// Discipline (V1): never mutates state directly. The builder reads the
// current DagState only to resolve the Scene aggregator's id; everything
// else is computed locally.
//
// REF: THESIS.md §50 (Op system); krama K6 (sister chain — asset drop).

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';

export type PrimitiveKind =
  // Meshes
  | 'Cube'
  | 'Sphere'
  // Lights
  | 'DirectionalLight'
  | 'PointLight'
  | 'SpotLight'
  | 'AreaLight'
  | 'AmbientLight'
  // Cameras
  | 'PerspectiveCamera'
  | 'OrthographicCamera'
  // Empties
  | 'Group'
  | 'Transform'
  // #296 — a Null controller: a standalone transformable scene object (no child),
  // so unlike Group/Transform it wires straight into scene.children.
  | 'Null'
  // Compute — scalar driver sources (Epic 1 Inc 1 vocabulary). Float floating
  // nodes: they feed ParamDrivers via the pull rail, never the render tree, so
  // they are added unwired (like empties). #294 Inc 3.
  | 'Math'
  | 'Fit'
  | 'Clamp'
  | 'Mix'
  | 'CurveRemap'
  | 'Noise';

export interface AddResult {
  ops: Op[];
  description: string;
  newNodeId: string;
}

type Vec3 = [number, number, number];

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build the Op chain for adding a primitive at `position`. Returns null
 * when the scene aggregator is missing (a corrupt project — caller should
 * surface a friendly error rather than throw).
 *
 * For meshes: addNode(primitive) → connect to scene.children.
 * For lights: addNode(light) → connect to scene.lights.
 * For cameras: addNode(camera) only — wiring scene.camera REPLACES the
 *   existing camera (single-cardinality), so the user explicitly opts in
 *   via View → Camera-from-View OR by manually rerouting in Pro mode.
 *   Add menu cameras are visible nodes in the graph, ready to be wired.
 * For empties: addNode only — Group/Transform need a child to be
 *   visible. The user wires them via drag-drop or the (future) connect
 *   tool.
 */
export function buildAddPrimitiveOps(
  state: DagState,
  kind: PrimitiveKind,
  position: Vec3,
): AddResult | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;

  const id = newId(prefixFor(kind));
  const ops: Op[] = [];
  const params = paramsFor(kind, position);
  ops.push({
    type: 'addNode',
    nodeId: id,
    nodeType: nodeTypeFor(kind),
    params,
  });

  // Wire into the scene where applicable. Meshes go under .children,
  // lights under .lights. Cameras + empties stay floating (the user
  // wires them deliberately).
  if (isMesh(kind) || kind === 'Null') {
    ops.push({
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: sceneRef.node, socket: 'children' },
    });
  } else if (isLight(kind)) {
    ops.push({
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: sceneRef.node, socket: 'lights' },
    });
  }

  return {
    ops,
    description: `Add ${humanLabel(kind)}`,
    newNodeId: id,
  };
}

function prefixFor(kind: PrimitiveKind): string {
  if (isMesh(kind)) return 'mesh';
  if (isLight(kind)) return 'light';
  if (isCamera(kind)) return 'cam';
  if (isCompute(kind)) return 'num';
  if (kind === 'Null') return 'null';
  return 'empty';
}

function isCompute(kind: PrimitiveKind): boolean {
  return (
    kind === 'Math' ||
    kind === 'Fit' ||
    kind === 'Clamp' ||
    kind === 'Mix' ||
    kind === 'CurveRemap' ||
    kind === 'Noise'
  );
}

function nodeTypeFor(kind: PrimitiveKind): string {
  switch (kind) {
    case 'Cube':
      return 'BoxMesh';
    case 'Sphere':
      return 'SphereMesh';
    default:
      return kind; // DirectionalLight, PointLight, etc. — direct mapping
  }
}

function isMesh(kind: PrimitiveKind): boolean {
  return kind === 'Cube' || kind === 'Sphere';
}

function isLight(kind: PrimitiveKind): boolean {
  return (
    kind === 'DirectionalLight' ||
    kind === 'PointLight' ||
    kind === 'SpotLight' ||
    kind === 'AreaLight' ||
    kind === 'AmbientLight'
  );
}

function isCamera(kind: PrimitiveKind): boolean {
  return kind === 'PerspectiveCamera' || kind === 'OrthographicCamera';
}

function humanLabel(kind: PrimitiveKind): string {
  switch (kind) {
    case 'Cube':
      return 'cube';
    case 'Sphere':
      return 'sphere';
    case 'DirectionalLight':
      return 'sun (directional light)';
    case 'PointLight':
      return 'point light';
    case 'SpotLight':
      return 'spot light';
    case 'AreaLight':
      return 'area light';
    case 'AmbientLight':
      return 'ambient light';
    case 'PerspectiveCamera':
      return 'perspective camera';
    case 'OrthographicCamera':
      return 'orthographic camera';
    case 'Group':
      return 'group';
    case 'Transform':
      return 'transform';
    case 'Null':
      return 'null (controller)';
    case 'Math':
      return 'Math node';
    case 'Fit':
      return 'Fit node';
    case 'Clamp':
      return 'Clamp node';
    case 'Mix':
      return 'Mix node';
    case 'CurveRemap':
      return 'Curve Remap node';
    case 'Noise':
      return 'Noise node';
  }
}

/** Default params per kind. AmbientLight has no position; everything
 *  else accepts the spawn point. */
function paramsFor(kind: PrimitiveKind, position: Vec3): Record<string, unknown> {
  switch (kind) {
    case 'Cube':
      return {
        size: [1, 1, 1],
        position,
        rotation: [0, 0, 0],
        material: { name: 'default', color: '#5af07a' },
      };
    case 'Sphere':
      return {
        radius: 0.5,
        widthSegments: 24,
        heightSegments: 16,
        position,
        rotation: [0, 0, 0],
        material: { name: 'default', color: '#88aaff' },
      };
    case 'DirectionalLight':
      return { intensity: 1.0, position, color: '#ffffff' };
    case 'PointLight':
      return { intensity: 1.0, position, color: '#ffffff', distance: 0, decay: 2 };
    case 'SpotLight':
      return {
        intensity: 1.0,
        position,
        color: '#ffffff',
        target: [0, 0, 0],
        angle: Math.PI / 6,
        penumbra: 0.2,
        distance: 0,
        decay: 2,
      };
    case 'AreaLight':
      return {
        intensity: 1.0,
        position,
        color: '#ffffff',
        width: 2,
        height: 2,
        lookAt: [0, 0, 0],
      };
    case 'AmbientLight':
      return { intensity: 0.3, color: '#ffffff' };
    case 'PerspectiveCamera':
      return { fov: 45, near: 0.01, far: 1000, position, lookAt: [0, 0, 0] };
    case 'OrthographicCamera':
      return { zoom: 1, near: 0.01, far: 1000, position, lookAt: [0, 0, 0] };
    case 'Group':
      return {};
    case 'Transform':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    case 'Null':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    // Compute nodes have full zod defaults on every param (computeNodes.ts) and no
    // position — an empty object lets the addNode parse fill the defaults.
    case 'Math':
    case 'Fit':
    case 'Clamp':
    case 'Mix':
    case 'CurveRemap':
    case 'Noise':
      return {};
  }
}
