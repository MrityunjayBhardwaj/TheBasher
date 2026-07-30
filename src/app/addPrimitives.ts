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

/**
 * THE RESOURCES — things scene objects POINT AT rather than things that live in the scene
 * (#394). A material is not a body: it has no transform, nothing to select in the viewport,
 * and it is not a scene child. It is also not compute — it never touches the driver rail.
 *
 * A third list rather than a member of either existing one, because the two existing lists
 * are each defined by a property this does not have: SCENE_OBJECT_KINDS is "has a transform
 * and is a scene child", COMPUTE_KINDS is "feeds ParamDrivers through the pull rail". Filing
 * a material under either would make the list's own definition false, and both lists are
 * DERIVED FROM by other surfaces (the agent's `mesh.add` enum, `identify`'s primitive types),
 * so a wrong membership propagates into vocabularies rather than staying local.
 *
 * Added UNWIRED, like a camera or an empty: the director wires it to what it should shade.
 */
export const RESOURCE_KINDS = ['Material'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Every kind `buildAddPrimitiveOps` accepts. Derived — see SCENE_OBJECT_KINDS. */
export type PrimitiveKind = SceneObjectKind | ComputeKind | ResourceKind;

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
            // No `material`: a new sphere takes the ONE standard material from the
            // schema, exactly as a new cube does (#394 D7). The flat `{name,color}`
            // payload that used to sit here was already inert — zod strips unknown
            // keys, so the colour it named never reached `base.color`; the schema
            // default was doing the work. Removed rather than left reading as live.
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

  // #385 Stage C (C2 Slice 3) — a Curve is the object↔data split too, but the FIRST non-mesh
  // one: an Object (the pose) wired to a CurveData (control points/closed/resolution, no
  // material), then into the scene. Selection + the curve-point editor land on the Object
  // (curvePointEntriesOf resolves points through `data`); the CurveData's zod defaults supply
  // the seed 4-point path. Split-native, so "Curve" and the load-migration converge on one shape.
  if (kind === 'Curve') {
    const dataId = newId('data');
    const objId = newId('obj');
    return {
      ops: [
        { type: 'addNode', nodeId: dataId, nodeType: 'CurveData', params: {} },
        {
          type: 'addNode',
          nodeId: objId,
          nodeType: 'Object',
          params: paramsFor('Curve', position),
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
      description: `Add ${humanLabel('Curve')}`,
      newNodeId: objId,
    };
  }

  // #386 Stage C (C3) — the four POSABLE lights are the object↔data split too: an Object
  // (the pose) wired to a LightData (kind + shading, no transform), then into scene.LIGHTS
  // (NOT children). Selection + the studio panel land on the Object (shading resolves
  // through `data`); the LightData owns intensity/colour/falloff/aim. Split-native, so
  // "Add ▸ Point Light" and the load-migration converge on one shape (K23). AmbientLight
  // is NOT here — it stays a bare fused node (ambient = a World datablock), wired to
  // scene.lights by the generic tail below.
  if (
    kind === 'DirectionalLight' ||
    kind === 'PointLight' ||
    kind === 'SpotLight' ||
    kind === 'AreaLight'
  ) {
    const dataId = newId('data');
    const objId = newId('light');
    return {
      ops: [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'LightData',
          params: lightDataParamsFor(kind),
        },
        {
          type: 'addNode',
          nodeId: objId,
          nodeType: 'Object',
          params: paramsFor(kind, position),
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: objId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: objId, socket: 'out' },
          to: { node: sceneRef.node, socket: 'lights' },
        },
      ],
      description: `Add ${humanLabel(kind)}`,
      newNodeId: objId,
    };
  }

  // #387 Stage C (C4) — a camera is the object↔data split too: an Object (the pose) wired to
  // a CameraData (the lens: projection/fov/zoom/clip planes/DoF, plus the aim params lookAt
  // and roll, which stay on the data half parity-first, #387 D1). Both projections mint the
  // SAME node pair and differ only in `projection` — one datablock with a discriminator, as
  // LightData did for four light kinds. Split-native, so "Add ▸ Camera ▸ Perspective" and the
  // v6→v7 load-migration converge on one shape (K23).
  //
  // ⚠️ THIS BRANCH MUST BE AN EXPLICIT LITERAL, and that is the whole reason it exists rather
  // than falling through to the generic tail. The tail mints `nodeType: nodeTypeFor(kind)` — a
  // CALL, not a literal — and the retire-a-kind gate's signal is a construction POSITION, so a
  // camera left on the tail would keep minting a fused node with NOTHING going red once the
  // fused types retire. `buildAddPrimitiveOps` is covered by a unit test naming both camera
  // kinds for exactly this reason; that test is the gate the grep cannot be.
  //
  // Cameras stay FLOATING (no scene edge) — unchanged from the fused behaviour: the user
  // wires a camera to `scene.camera` deliberately.
  if (isCamera(kind)) {
    const dataId = newId('data');
    const objId = newId('cam');
    return {
      ops: [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'CameraData',
          params: cameraDataParamsFor(kind),
        },
        {
          type: 'addNode',
          nodeId: objId,
          nodeType: 'Object',
          params: paramsFor(kind, position),
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: objId, socket: 'data' },
        },
      ],
      description: `Add ${humanLabel(kind)}`,
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
  if (kind === 'Null') {
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
  if (isResource(kind)) return 'mat';
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
    // #365 Ph5a / #384 C1 / #385 C2 / #386 C3 / #387 C4 — a Cube, Sphere, Curve, the four
    // posable lights AND both cameras are all the object↔data split; the node the director
    // selects and refers to is the Object (the BoxData/SphereData/CurveData/LightData/
    // CameraData is its data leaf, not a scene object). Each mints the split via the
    // early-return branches above; this mapping only feeds identify's ALL_PRIMITIVE_TYPES, so
    // all resolve to their real 'Object' node type rather than a fused kind. (AmbientLight
    // stays fused → the default arm returns its own type.)
    case 'Cube':
    case 'Sphere':
    case 'Curve':
    case 'DirectionalLight':
    case 'PointLight':
    case 'SpotLight':
    case 'AreaLight':
    case 'PerspectiveCamera':
    case 'OrthographicCamera':
      return 'Object';
    default:
      return kind; // AmbientLight (stays fused), empties, compute nodes — direct mapping
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

/** A RESOURCE — something scene objects point at, with no body of its own (#394). Derived
 *  from RESOURCE_KINDS so a new resource cannot be added to the list and forgotten here. */
function isResource(kind: PrimitiveKind): boolean {
  return (RESOURCE_KINDS as readonly string[]).includes(kind);
}

function humanLabel(kind: PrimitiveKind): string {
  switch (kind) {
    case 'Material':
      return 'material';
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

/** The LightData half's params for a NEW posable light — the SHADING (kind + intensity/
 *  colour/falloff/aim), mirroring the pre-split light values byte-for-byte so a fresh
 *  light looks identical across the split. The Object half gets the TRS (paramsFor).
 *  (penumbra 0.2 here preserves the pre-split Add ▸ Spot value; it disagrees with
 *  SpotLight/LightData's zod default 0.1 — a pre-existing in-repo disagreement, kept
 *  as-is to preserve new-spot parity, #386.) */
function lightDataParamsFor(kind: PrimitiveKind): Record<string, unknown> {
  switch (kind) {
    case 'DirectionalLight':
      return { lightKind: 'Directional', intensity: 1.0, color: '#ffffff' };
    case 'PointLight':
      return { lightKind: 'Point', intensity: 1.0, color: '#ffffff', distance: 0, decay: 2 };
    case 'SpotLight':
      return {
        lightKind: 'Spot',
        intensity: 1.0,
        color: '#ffffff',
        target: [0, 0, 0],
        angle: Math.PI / 6,
        penumbra: 0.2,
        distance: 0,
        decay: 2,
      };
    case 'AreaLight':
      return {
        lightKind: 'Area',
        intensity: 1.0,
        color: '#ffffff',
        width: 2,
        height: 2,
        lookAt: [0, 0, 0],
      };
    default:
      return {};
  }
}

/**
 * #387 C4 — the CameraData (lens) half of a newly added camera. Sister to
 * `lightDataParamsFor`: the pose lives on the Object (`paramsFor`), the lens lives here.
 *
 * ⚠️ EVERY VALUE IS PRESERVED EXACTLY as the fused builders seeded it — `far: 1000` (which
 * differs from `CameraData`'s own zod default of 500, and from the seed project's 500) and
 * the orthographic `zoom: 1`. NO behaviour change rides in on the creation flip: this slice
 * changes the SHAPE a new camera is minted in, nothing about what it looks like. The ortho
 * `zoom: 1` in particular is currently read by no renderer at all (#478) — it is seeded here
 * unchanged so that issue stays exactly as measurable as it was, and is fixed under #478.
 *
 * `fov` is written for BOTH projections because `CameraData.fov` is required with no zod
 * default (deliberately — 45 is the pose road's failure value, so it must never arrive as a
 * silent fallback). Under `projection: 'Orthographic'` it is inert: the recompose reads
 * `zoom`. This is the same one-invented-value-in-one-place call the v6→v7 migration makes.
 */
function cameraDataParamsFor(kind: PrimitiveKind): Record<string, unknown> {
  const shared = { fov: 45, near: 0.01, far: 1000, lookAt: [0, 0, 0] };
  return kind === 'OrthographicCamera'
    ? { projection: 'Orthographic', zoom: 1, ...shared }
    : { projection: 'Perspective', ...shared };
}

/** Default params per kind. AmbientLight has no position; everything
 *  else accepts the spawn point. */
function paramsFor(kind: PrimitiveKind, position: Vec3): Record<string, unknown> {
  switch (kind) {
    // #365 Ph5a / #384 C1 / #385 C2 — Cube, Sphere AND Curve are all the object↔data split; their
    // params are the OBJECT half's TRS only (the BoxData/SphereData/CurveData they point at owns
    // the geometry/points). The split branches above wire each pair; this supplies the Object's
    // params. Curve's control points come from the CurveData's zod defaults, not here.
    // #365 Ph5a / #384 C1 / #385 C2 / #386 C3 — Cube, Sphere, Curve AND the four posable
    // lights are all the object↔data split; their params here are the OBJECT half's TRS
    // only (the data node they point at owns the geometry/points/shading). The split
    // branches above wire each pair; this supplies the Object's params. A light's shading
    // comes from lightDataParamsFor (the LightData half), not here.
    case 'Cube':
    case 'Sphere':
    case 'Curve':
    case 'DirectionalLight':
    case 'PointLight':
    case 'SpotLight':
    case 'AreaLight':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    // AmbientLight stays FUSED (ambient = a World datablock) — its params are shading only
    // (no pose), minted directly as an AmbientLight node by the generic tail.
    case 'AmbientLight':
      return { intensity: 0.3, color: '#ffffff' };
    // #387 C4 — a camera is the object↔data split; these params are the OBJECT half's TRS
    // only. The lens (fov/zoom/near/far/lookAt/roll) is minted by cameraDataParamsFor onto
    // the CameraData half by the camera branch above.
    case 'PerspectiveCamera':
    case 'OrthographicCamera':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    // #394 — a Material has NO pose. Its params come from its own zod defaults (THE
    // standard material), so nothing is seeded here; passing a `position` would mint a
    // param the schema strips and read as though a material had a place in the world.
    case 'Material':
      return {};
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
