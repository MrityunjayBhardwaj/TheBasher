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

import { cameraRotationLookingAt } from './cameraOrientation';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildSkeletonObjectOps } from '../core/import/skeletonObject';
import { DEFAULT_CAMERA_FAR, DEFAULT_CAMERA_NEAR } from '../nodes/CameraData';
import { placeBuiltin } from './builtinTemplates';
import { linkIntoActiveCollection } from './collections';
import { AIMABLE_LIGHT_KINDS, lightAimOps } from './lightAim';
import { freshAimedNames, freshObjectName, objectBaseName, takenObjectNames } from './objectNames';

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
  // #1339 — an armature: an Object whose data is a Skeleton of one bone, standing in its rest pose. Blender's Add › Armature; its bones are built from there in Edit mode.
  'Armature',
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
  // Transform compute (Matrix4 rail, #1784) — Blender's matrix nodes, plus Euler ↔ rotation.
  'CombineTransform',
  'SeparateTransform',
  'PolarSplit',
  'MultiplyTransforms',
  'InvertTransform',
  'TransformPoint',
  'TransformDirection',
  'EulerToRotation',
  'RotationToEuler',
  // Geometry query — SampleGeometry reads the ground point under a query node's world XZ;
  // its terrain/query are picked in the inspector.
  'SampleGeometry',
  // Stateful op — Lag (Epic 2 #297). Its output trails its input over time (the seam
  // replays it).
  'Lag',
  // Solver meta-op + its sub-network leaves (Epic 2). The Solver owns a sub-network cooked
  // every frame (Houdini Solver SOP); Prev Frame / Solver Input add a `BodyInput` leaf
  // reading its `prev` / `input` (#1548).
  'Solver',
  'PrevFrame',
  'SolverInput',
  // #1826 — the previous value of vector, rotation and transform state; each leaf's `input`
  // picker offers every name of its type, so one entry per type also reads the live input.
  'PrevFrameVector',
  'PrevFrameRotation',
  'PrevFrameTransform',
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
 * Added UNWIRED: the director wires it to what it should shade.
 */
export const RESOURCE_KINDS = ['Material'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Every kind `buildAddPrimitiveOps` accepts. Derived — see SCENE_OBJECT_KINDS. */
export type PrimitiveKind = SceneObjectKind | ComputeKind | ResourceKind;

export interface AddResult {
  ops: Op[];
  description: string;
  /** The node a director SELECTS and refers to — the Object half of a split kind. */
  newNodeId: string;
  /**
   * The DATA node of a split kind, when the kind has one (#772).
   *
   * Every split kind mints two nodes and until now returned only one, so a caller
   * that wanted to write the thing it had just created had to go and find the
   * other — `points` lives on the `CurveData`, not on the `Object` posing it. That
   * cost the agent one `dag.inspect` round trip on every curve, and a trajectory is
   * the case where the data params ARE the substance: "put a camera path here" is
   * entirely a statement about `points`.
   *
   * `undefined` for a FUSED kind (AmbientLight, the empties, the compute nodes,
   * Material), which has no second node. Undefined rather than repeating
   * `newNodeId`: a caller asking "which node holds the params" must be able to tell
   * "this one does" from "there isn't a separate one", and a duplicate id answers
   * the first question with the second one's value.
   */
  dataNodeId?: string;
  /** #1765 — the empty a new sun, spot or area light is aimed at (its Track-To's `aimNode`). */
  aimNodeId?: string;
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
 * Every scene object lands in the scene (#1518, checked by the census in #1822), and is named
 * there, as Blender names an object when it adds it (`objectNames.ts`).
 *
 * For meshes and empties: addNode → connect to scene.children. A Group or Transform with no child
 *   yet draws nothing, and it is in the outliner, ready to be dropped into.
 * For lights: addNode(light) → connect to scene.lights.
 * For cameras: addNode(camera) → connect to scene.children, NOT scene.camera. `scene.camera` is one
 *   socket, and wiring it REPLACES the active camera: the user opts in with Set Active or
 *   Camera-from-View. A camera Object in `children` draws nothing of its own; its frustum is the
 *   camera band's (`SceneFromDAG`), as for a camera in a Group.
 */
export function buildAddPrimitiveOps(
  state: DagState,
  kind: PrimitiveKind,
  position: Vec3,
): AddResult | null {
  const unnamed = buildUnlinkedAddOps(state, kind, position);
  const sceneId = state.outputs.scene?.node;
  if (!unnamed || !sceneId) return unnamed;
  const result = withNames(state, unnamed);
  // #1453 — every object added joins the active collection, as Blender links every object it adds:
  // what the scene's `children` or `lights` band holds. Each of those drawers honours a hidden
  // collection (`SceneFromDAG`). A Material or a compute node is not a scene object, and joins
  // nothing.
  const standsInScene = result.ops.some(
    (op) =>
      op.type === 'connect' &&
      op.from.node === result.newNodeId &&
      op.to.node === sceneId &&
      (op.to.socket === 'children' || op.to.socket === 'lights'),
  );
  return standsInScene
    ? {
        ...result,
        ops: linkIntoActiveCollection(state, result.ops, [
          result.newNodeId,
          ...(result.aimNodeId ? [result.aimNodeId] : []),
        ]),
      }
    : result;
}

/**
 * #1518 — `result` with the object it adds named: the name its builder gave it, or the word for its
 * kind, made free in the graph. A light's aim empty is named after that light, so the second spot's
 * is `Spot.001.aim` and not a second `Spot.aim`.
 */
function withNames(state: DagState, result: AddResult): AddResult {
  const added = (id: string | undefined) =>
    result.ops.find(
      (op): op is Extract<Op, { type: 'addNode' }> => op.type === 'addNode' && op.nodeId === id,
    );
  const object = added(result.newNodeId);
  const data = added(result.dataNodeId);
  const base =
    object &&
    objectBaseName(
      { type: object.nodeType, params: object.params },
      data && { type: data.nodeType, params: data.params },
    );
  if (!base) return result;
  const given = result.ops.find(
    (op): op is Extract<Op, { type: 'setMeta' }> =>
      op.type === 'setMeta' && op.nodeId === result.newNodeId,
  )?.name;
  const taken = takenObjectNames(state);
  const names = new Map<string, string>();
  if (result.aimNodeId) {
    const aimed = freshAimedNames(given ?? base, taken);
    names.set(result.newNodeId, aimed.name);
    names.set(result.aimNodeId, aimed.aim);
  } else {
    names.set(result.newNodeId, freshObjectName(given ?? base, taken));
  }
  const ops = result.ops.map((op) =>
    op.type === 'setMeta' && names.has(op.nodeId) ? { ...op, name: names.get(op.nodeId) } : op,
  );
  if (given === undefined) {
    ops.push({ type: 'setMeta', nodeId: result.newNodeId, name: names.get(result.newNodeId) });
  }
  return { ...result, ops };
}

function buildUnlinkedAddOps(
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
      dataNodeId: dataId,
    };
  }

  // #384 Stage C (C1 Slice 3) — a Sphere is the object↔data split, exactly like the Cube: an
  // Object (the pose) wired to a SphereData (geometry + material), then into the scene. Selection
  // + chained mutators land on the Object (the posable half); the SphereData owns radius/segments
  // + material. This makes new spheres split-native — the same pair the load-migration produces
  // for old fused SphereMesh saves (K23) — so "Sphere" and the migration converge on one shape.
  // #1339 — an armature: a Skeleton of one bone (`Bone` → `Bone_end`, below) and the Object
  // standing it, posed by the skeleton's own rest pose — the shape every import road builds
  // (`buildSkeletonObjectOps`), so a hand-built rig and an imported one are the same nodes.
  if (kind === 'Armature') {
    const dataId = newId('skel');
    // The BASE layer every import stands a rig on (Skeleton.pose → base layer → Object.pose), empty
    // until the rig is keyed — where a hand-built rig's motion lives, as Blender keys an armature
    // into its action (named as Blender names one, `ArmatureAction`). Without it the first
    // hand-pose layer sat straight on the rest pose and read as the base, which a hand-pose never
    // writes, so posing a second bone was refused.
    const baseId = newId('layer');
    const built = buildSkeletonObjectOps({
      skeletonId: dataId,
      name: 'Armature',
      sceneNodeId: sceneRef.node,
      pose: { node: baseId, socket: 'out' },
      nameFollowsClip: false,
    });
    return {
      ops: [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'Skeleton',
          // Blender's new armature is one bone, head at the origin and tail one unit up. Bones here
          // are joints (a joint's tail is its child), so that bone is two: its head joint and the
          // tail joint one unit up +Y, named `_end` as FBX names a chain's tip.
          params: {
            bones: [
              { name: 'Bone', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
              { name: 'Bone_end', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
            ],
          },
        },
        {
          type: 'addNode',
          nodeId: baseId,
          nodeType: 'PoseLayer',
          params: { name: 'ArmatureAction', mode: 'override', members: [] },
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'pose' },
          to: { node: baseId, socket: 'pose' },
        },
        // The Object's TRS from the same table every split kind reads; the builder mints it at
        // the origin, as an import stands a rig.
        ...built.ops.map((op) =>
          op.type === 'addNode' && op.nodeId === built.objectId
            ? { ...op, params: paramsFor('Armature', position) }
            : op,
        ),
      ],
      description: `Add ${humanLabel('Armature')}`,
      newNodeId: built.objectId,
      dataNodeId: dataId,
    };
  }

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
      dataNodeId: dataId,
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
      dataNodeId: dataId,
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
    // #1765 — a sun, spot or area light comes aimed at the world origin by a Track-To whose aim
    // is an empty ("Spot.aim") the user moves to re-aim it. A point light shines every way.
    const lightKind = (lightDataParamsFor(kind) as { lightKind: string }).lightKind;
    const aim = AIMABLE_LIGHT_KINDS.has(lightKind)
      ? lightAimOps(state, objId, { at: [0, 0, 0], kind: lightKind })
      : null;
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
        ...(aim?.ops ?? []),
      ],
      description: `Add ${humanLabel(kind)}`,
      newNodeId: objId,
      dataNodeId: dataId,
      ...(aim ? { aimNodeId: aim.nullId } : {}),
    };
  }

  // #387 Stage C (C4) — a camera is the object↔data split too: an Object (the pose) wired to
  // a CameraData (the lens: projection/fov/ortho scale/clip planes/DoF; no aim, #487). Both
  // projections mint the
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
  // A camera stands in `scene.children` (#1518), so it is in the scene like anything else Add
  // makes. Not in `scene.camera`, which is one socket: the user makes it active deliberately.
  if (isCamera(kind)) {
    const dataId = newId('data');
    const objId = newId('cam');
    return {
      ops: [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'CameraData',
          // #1764 — focused on the origin the new camera is turned to look at (below), so its
          // aim reticle sits there.
          params: {
            ...cameraDataParamsFor(kind),
            focusDistance: Math.hypot(...position) || 5,
          },
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
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      description: `Add ${humanLabel(kind)}`,
      newNodeId: objId,
      dataNodeId: dataId,
    };
  }

  // #1559 — a Lag is an instance of the built-in Lag template, its definition copied into the
  // project the first time one is added.
  if (kind === 'Lag') {
    const id = newId(prefixFor(kind));
    const placed = placeBuiltin(state, 'Lag', id);
    if (!placed.ok) return null;
    return { ops: placed.ops, description: `Add ${humanLabel(kind)}`, newNodeId: id };
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

  // Into the scene: empties under .children, lights under .lights. Compute nodes and resources
  // are not scene objects and stay unwired.
  if (kind === 'Null' || kind === 'Group' || kind === 'Transform') {
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
    kind === 'CombineTransform' ||
    kind === 'SeparateTransform' ||
    kind === 'PolarSplit' ||
    kind === 'MultiplyTransforms' ||
    kind === 'InvertTransform' ||
    kind === 'TransformPoint' ||
    kind === 'TransformDirection' ||
    kind === 'EulerToRotation' ||
    kind === 'RotationToEuler' ||
    kind === 'Lag'
  );
}

/** The Solver meta-op family — floating number nodes added unwired (like compute), but
 *  distinct from the stateless compute vocabulary. */
function isSolverKind(kind: PrimitiveKind): boolean {
  return (
    kind === 'Solver' ||
    kind === 'PrevFrame' ||
    kind === 'SolverInput' ||
    kind === 'PrevFrameVector' ||
    kind === 'PrevFrameRotation' ||
    kind === 'PrevFrameTransform'
  );
}

/** The Add-menu kind → the DAG node type it creates. Exported because the agent's
 *  IDENTIFY vocabulary is derived from it (`ALL_PRIMITIVE_TYPES`, identify.ts): the two
 *  speak different dialects of the same thing — a director says "cube", the DAG says
 *  "Object" (the pose half of the object↔data split, since #365 Phase 5a; a BoxData holds
 *  the geometry) — and this is the ONE translation between them. A second copy is how a
 *  scene object ends up creatable but un-referrable (#324). */
export function nodeTypeFor(kind: PrimitiveKind): string {
  switch (kind) {
    // #1559 — an instance of the built-in Lag template, not a Lag node.
    case 'Lag':
      return 'template.Lag';
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
    case 'Armature':
      return 'Object';
    // #1548 — the Solver's two inputs are one leaf type reading the input by name (paramsFor).
    case 'PrevFrame':
    case 'SolverInput':
      return 'BodyInput';
    case 'PrevFrameVector':
      return 'BodyInputVec';
    case 'PrevFrameRotation':
      return 'BodyInputRotation';
    case 'PrevFrameTransform':
      return 'BodyInputTransform';
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
    case 'Armature':
      return 'armature';
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
    case 'CombineTransform':
      return 'Combine Transform node';
    case 'SeparateTransform':
      return 'Separate Transform node';
    case 'PolarSplit':
      return 'Polar Split node';
    case 'MultiplyTransforms':
      return 'Multiply Transforms node';
    case 'InvertTransform':
      return 'Invert Transform node';
    case 'TransformPoint':
      return 'Transform Point node';
    case 'TransformDirection':
      return 'Transform Direction node';
    case 'EulerToRotation':
      return 'Euler to Rotation node';
    case 'RotationToEuler':
      return 'Rotation to Euler node';
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
    case 'PrevFrameVector':
      return 'Prev Frame (Vector) node';
    case 'PrevFrameRotation':
      return 'Prev Frame (Rotation) node';
    case 'PrevFrameTransform':
      return 'Prev Frame (Transform) node';
  }
}

/** The LightData half's params for a NEW posable light — the SHADING (kind + intensity/
 *  colour/falloff; #1765: no aim — the Object's rotation turns it), mirroring the pre-split light values byte-for-byte so a fresh
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
      };
    default:
      return {};
  }
}

/**
 * #387 C4 — the CameraData (lens) half of a newly added camera. Sister to
 * `lightDataParamsFor`: the pose lives on the Object (`paramsFor`), the lens lives here.
 *
 * ⚠️ THE CLIP PLANES NOW COME FROM `CameraData`'s OWN DEFAULTS — Blender's camera Clip
 * Start and Clip End (0.1–1000, #1193/#1195), the same values the schema, the seed project
 * and the pose fallback use, so which road minted a camera no longer decides its clipping.
 * Before that, this builder's `far: 1000` was the lone 1000 against their 500, and its
 * near was 0.01 everywhere. Every OTHER value is still preserved exactly as the fused
 * builders seeded it. An orthographic camera takes `CameraData`'s own ortho scale, Blender's
 * default 6 (#478, #1760); the `zoom: 1` it used to be seeded with was read by nothing.
 *
 * `fov` is written for BOTH projections because `CameraData.fov` is required with no zod
 * default (deliberately — 45 is the pose road's failure value, so it must never arrive as a
 * silent fallback). Under `projection: 'Orthographic'` it is inert: the frame is
 * `orthoScale`. This is the same one-invented-value-in-one-place call the v6→v7 migration makes.
 */
function cameraDataParamsFor(kind: PrimitiveKind): Record<string, unknown> {
  const shared = { fov: 45, near: DEFAULT_CAMERA_NEAR, far: DEFAULT_CAMERA_FAR };
  return kind === 'OrthographicCamera'
    ? { projection: 'Orthographic', ...shared }
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
    case 'Armature':
    case 'PointLight':
      return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
    // #1765 — a sun, spot or area light shines down its own −Z. A new one is aimed at the world
    // origin by a Track-To at an empty (`lightAimOps`), and its own rotation is turned the same
    // way, so muting the Track-To or deleting the empty leaves it facing where it faced.
    case 'DirectionalLight':
    case 'SpotLight':
    case 'AreaLight':
      return { position, rotation: cameraRotationLookingAt(position, [0, 0, 0]), scale: [1, 1, 1] };
    // AmbientLight stays FUSED (ambient = a World datablock) — its params are shading only
    // (no pose), minted directly as an AmbientLight node by the generic tail.
    case 'AmbientLight':
      return { intensity: 0.3, color: '#ffffff' };
    // #387 C4 — a camera is the object↔data split; these params are the OBJECT half's TRS
    // only. The lens (fov/orthoScale/near/far/DoF) is minted by cameraDataParamsFor onto
    // the CameraData half by the camera branch above.
    // #1760 — turned by its own rotation to the world origin (V665): the framing it had while
    // a lens look-at turned it.
    case 'PerspectiveCamera':
    case 'OrthographicCamera':
      return { position, rotation: cameraRotationLookingAt(position, [0, 0, 0]), scale: [1, 1, 1] };
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
    case 'CombineTransform':
    case 'SeparateTransform':
    case 'PolarSplit':
    case 'MultiplyTransforms':
    case 'InvertTransform':
    case 'TransformPoint':
    case 'TransformDirection':
    case 'EulerToRotation':
    case 'RotationToEuler':
    case 'SampleGeometry':
    case 'Lag':
    case 'Solver':
      // The Solver has full zod defaults (Solver.ts) and no position. SampleGeometry
      // likewise (its refs are optional, set later in the inspector).
      return {};
    // #1548 — a body-input leaf names the Solver input it reads.
    case 'PrevFrame':
      return { input: 'prev', slot: 0 };
    case 'SolverInput':
      return { input: 'input', slot: 0 };
    case 'PrevFrameVector':
      return { input: 'prevVec', slot: 0 };
    case 'PrevFrameRotation':
      return { input: 'prevRotation', slot: 0 };
    case 'PrevFrameTransform':
      return { input: 'prevTransform', slot: 0 };
  }
}
