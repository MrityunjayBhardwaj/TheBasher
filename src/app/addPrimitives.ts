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

/**
 * THE SCENE OBJECTS — everything the Add menu can put in the scene as a thing with a
 * transform: a body the director can see, select, pose, parent and talk about.
 *
 * This list is DATA, not documentation, and `PrimitiveKind` is derived FROM it (below) —
 * because the agent's vocabulary is derived from it too (`meshAdd`'s `kind` enum,
 * `identify`'s primitive types). It used to be the other way round: `PrimitiveKind` was a
 * hand-written union and the agent kept a hand-copied SUBSET of it. Nothing forced the copy
 * to track the original, so `Null` (#296) and `Curve` (#321) each shipped mouse-creatable
 * and VOICELESS — the agent's zod enum rejected them at runtime, with no compile error and
 * no failing test to notice. A director could build a path with the mouse and not be able to
 * SAY "add a curve", which is the entire camera-rig story (#324).
 *
 * Derived, that class is gone: a new scene object is agent-addressable the moment it exists,
 * and a kind that belongs to NEITHER list fails to typecheck rather than failing silently at
 * the user.
 */
export const SCENE_OBJECT_KINDS = [
  // Meshes
  'Cube',
  'Sphere',
  // Lights
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'AreaLight',
  'AmbientLight',
  // Cameras
  'PerspectiveCamera',
  'OrthographicCamera',
  // Empties
  'Group',
  'Transform',
  // #296 — a Null controller: a standalone transformable scene object (no child), so unlike
  // Group/Transform it wires straight into scene.children.
  'Null',
  // #321 — a Curve path: like a Null it is a standalone transformable scene object, so it
  // wires straight into scene.children (not a wrapper like Group/Transform).
  'Curve',
] as const;
export type SceneObjectKind = (typeof SCENE_OBJECT_KINDS)[number];

/**
 * THE COMPUTE / FLOATING VOCABULARY — number and vector nodes added UNWIRED. They feed
 * ParamDrivers through the pull rail and never enter the render tree, so they have no
 * transform, no body and nothing to select in the viewport. Deliberately NOT part of the
 * agent's `mesh.add` vocabulary: "add a Lag" is not a sentence a director says, and these
 * are authored where their sources are picked (the inspector).
 */
export const COMPUTE_KINDS = [
  // Scalar driver sources (Epic 1 Inc 1 vocabulary). #294 Inc 3.
  'Math',
  'Fit',
  'Clamp',
  'Mix',
  'CurveRemap',
  'Noise',
  // Vector compute (Vector3 rail) — MakeVec3/VecBreak3 convert to/from components,
  // Vec3Math does vector arithmetic.
  'MakeVec3',
  'VecBreak3',
  'Vec3Math',
  // Geometry query — SampleGeometry reads the ground point under a query node's world XZ;
  // its terrain/query are picked in the inspector.
  'SampleGeometry',
  // Stateful op — Lag (Epic 2 #297). Its output trails its input over time (the seam
  // replays it).
  'Lag',
  // Solver meta-op + its sub-network leaves (Epic 2). The Solver owns a sub-network cooked
  // every frame (Houdini Solver SOP); PrevFrame/SolverInput are its feedback + live-input
  // leaves.
  'Solver',
  'PrevFrame',
  'SolverInput',
] as const;
export type ComputeKind = (typeof COMPUTE_KINDS)[number];

/** Every kind `buildAddPrimitiveOps` accepts. Derived — see SCENE_OBJECT_KINDS. */
export type PrimitiveKind = SceneObjectKind | ComputeKind;

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

  // #365 Phase 5a (Slice 1b) — a Cube IS the object↔data split: an Object (the pose) wired
  // to a BoxData (geometry + material), then into the scene. It is the ONE multi-node build
  // here. Selection + chained mutators land on the Object (the posable half); a BoxData owns
  // the geometry. This makes new cubes split-native — the same pair the load-migration
  // produces for old fused BoxMesh saves (K23) — so "Cube" and the migration converge on one
  // shape. (Phase 2 introduced this via a separate "Object (Box)" item; Slice 1b folds it
  // into plain "Cube" and retires that scaffold word — one director noun for the box.)
  if (kind === 'Cube') {
    const dataId = newId('data');
    const objId = newId('obj');
    return {
      ops: [
        { type: 'addNode', nodeId: dataId, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
        {
          type: 'addNode',
          nodeId: objId,
          nodeType: 'Object',
          params: paramsFor('Cube', position),
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: objId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: objId, socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      description: `Add ${humanLabel('Cube')}`,
      newNodeId: objId,
    };
  }

  // #384 Stage C (C1 Slice 3) — a Sphere is the object↔data split, exactly like the Cube: an
  // Object (the pose) wired to a SphereData (geometry + material), then into the scene. Selection
  // + chained mutators land on the Object (the posable half); the SphereData owns radius/segments
  // + material. This makes new spheres split-native — the same pair the load-migration produces
  // for old fused SphereMesh saves (K23) — so "Sphere" and the migration converge on one shape.
  if (kind === 'Sphere') {
    const dataId = newId('data');
    const objId = newId('obj');
    return {
      ops: [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'SphereData',
          params: {
            radius: 0.5,
            widthSegments: 24,
            heightSegments: 16,
            material: { name: 'default', color: '#88aaff' },
          },
        },
        {
          type: 'addNode',
          nodeId: objId,
          nodeType: 'Object',
          params: paramsFor('Sphere', position),
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: objId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: objId, socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      description: `Add ${humanLabel('Sphere')}`,
      newNodeId: objId,
    };
  }

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
  if (kind === 'Null' || kind === 'Curve') {
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
  if (isLight(kind)) return 'light';
  if (isCamera(kind)) return 'cam';
  if (isCompute(kind)) return 'num';
  if (isSolverKind(kind)) return 'solver';
  if (kind === 'SampleGeometry') return 'geo';
  if (kind === 'Null') return 'null';
  if (kind === 'Curve') return 'curve';
  return 'empty';
}

function isCompute(kind: PrimitiveKind): boolean {
  return (
    kind === 'Math' ||
    kind === 'Fit' ||
    kind === 'Clamp' ||
    kind === 'Mix' ||
    kind === 'CurveRemap' ||
    kind === 'Noise' ||
    kind === 'MakeVec3' ||
    kind === 'VecBreak3' ||
    kind === 'Vec3Math' ||
    kind === 'Lag'
  );
}

/** The Solver meta-op family — floating number nodes added unwired (like compute), but
 *  distinct from the stateless compute vocabulary. */
function isSolverKind(kind: PrimitiveKind): boolean {
  return kind === 'Solver' || kind === 'PrevFrame' || kind === 'SolverInput';
}

/** The Add-menu kind → the DAG node type it creates. Exported because the agent's
 *  IDENTIFY vocabulary is derived from it (`ALL_PRIMITIVE_TYPES`, identify.ts): the two
 *  speak different dialects of the same thing — a director says "cube", the DAG says
 *  "Object" (the pose half of the object↔data split, since #365 Phase 5a; a BoxData holds
 *  the geometry) — and this is the ONE translation between them. A second copy is how a
 *  scene object ends up creatable but un-referrable (#324). */
export function nodeTypeFor(kind: PrimitiveKind): string {
  switch (kind) {
    // #365 Phase 5a / #384 Stage C — a Cube and a Sphere are both the object↔data split; the
    // node the director selects and refers to is the Object (the BoxData/SphereData is its data
    // leaf, not a scene object). Both mint the split via the early-return branches above; this
    // mapping only feeds identify's ALL_PRIMITIVE_TYPES, so both resolve to their real 'Object'
    // node type rather than a fused kind.
    case 'Cube':
    case 'Sphere':
      return 'Object';
    default:
      return kind; // DirectionalLight, PointLight, etc. — direct mapping
  }
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
    case 'Curve':
      return 'curve';
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
    case 'MakeVec3':
      return 'Make Vec3 node';
    case 'VecBreak3':
      return 'Break Vec3 node';
    case 'Vec3Math':
      return 'Vec3 Math node';
    case 'SampleGeometry':
      return 'Sample Geometry node';
    case 'Lag':
      return 'Lag node';
    case 'Solver':
      return 'Solver node';
    case 'PrevFrame':
      return 'Prev Frame node';
    case 'SolverInput':
      return 'Solver Input node';
  }
}

/** Default params per kind. AmbientLight has no position; everything
 *  else accepts the spawn point. */
function paramsFor(kind: PrimitiveKind, position: Vec3): Record<string, unknown> {
  switch (kind) {
    // #365 Phase 5a / #384 Stage C — Cube's and Sphere's params are the OBJECT half's TRS only
    // (the BoxData/SphereData they point at owns the geometry + material). The split branches
    // above wire the pair; this supplies the Object node's params.
    case 'Cube':
    case 'Sphere':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
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
    // #321 — the seed path. Points are LOCAL to the curve's origin (so the TRS gizmo moves
    // the whole path), and the zod default supplies them; we only place the origin.
    case 'Curve':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    // Compute nodes have full zod defaults on every param (computeNodes.ts) and no
    // position — an empty object lets the addNode parse fill the defaults.
    case 'Math':
    case 'Fit':
    case 'Clamp':
    case 'Mix':
    case 'CurveRemap':
    case 'Noise':
    case 'MakeVec3':
    case 'VecBreak3':
    case 'Vec3Math':
    case 'SampleGeometry':
    case 'Lag':
    case 'Solver':
    case 'PrevFrame':
    case 'SolverInput':
      // Solver meta-op + its leaves have full zod defaults (Solver.ts) and no position.
      // SampleGeometry likewise (its refs are optional, set later in the inspector).
      return {};
  }
}
