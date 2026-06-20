// Resolve the accumulated WORLD transform of a node — the pure evaluable value a
// constraint (Track-To, Copy Transforms, Child Of) reads so a relationship is a
// pure function of (DAG state, time) and the viewport == the offscreen render
// (V37). The foundational gate of the operator/constraint epic (#201, slice #202).
//
// WHY this exists (epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.3):
//   Today accumulated WORLD transform is NOT a pure value. SceneFromDAG composes
//   it IMPLICITLY via R3F scene-graph nesting: TransformR emits a
//   `<group pos/rot°/scale>` (SceneFromDAG.tsx:2012), Group/MaterialOverride pass
//   through (identity / no wrapper), leaf meshes emit `<mesh pos/rot°/scale>`, and
//   three.js multiplies the nested LOCAL matrices via updateWorldMatrix at RENDER
//   time. The only pure resolver, resolveEvaluatedTransform, returns a node's
//   LOCAL TRS (== world only for a top-level child, whose SceneChildNode wrapper
//   group is identity). A constraint reads ANOTHER node's WORLD transform — it
//   cannot run against the live scene graph in pure eval. This is the §4.3 gate.
//
// The SceneFromDAG mirror (Chesterton — reuse the accumulation, do NOT re-derive):
//   This walks the SAME evaluated value tree SceneFromDAG renders, in PARALLEL
//   with the DAG input structure (Transform/MaterialOverride: `inputs.target`;
//   Group: `inputs.children`), multiplying each level's local matrix T·R·S exactly
//   as three.js composes Object3D.updateMatrix — `compose(position, quaternion-
//   from-Euler('XYZ'), scale)`, the three.js default Euler order the renderer's
//   `rotation={degVec3ToRad(...)}` sets. Same math three.js runs internally →
//   bit-equal world matrix (the boundary-pair gate proves it against the REAL
//   rendered object via __basher_mesh_world_position). The top-level child value
//   is overlaid (free-floating channels then the held transient) the SAME way
//   DirectChannelsR renders it and resolveEvaluatedTransform reads it — one band,
//   no drift (H40).
//
// PURE — a function of (state, nodeId, ctx). THREE is used ONLY as a matrix-math
//   library (no scene-graph read, no React). The one live store read is the
//   transient SET — identical to resolveEvaluatedTransform, justified by H40 (the
//   read MUST reflect the same live edit the subscribed render reads). Empty store
//   → identity overlay, so purity tests stay green.
//
// SCOPE: the kinds the constraint gate needs — Transform, Group, MaterialOverride
//   (pass-through), and the leaf meshes (Box/Sphere/Baked/Gltf asset-root) nested
//   under scene.children. #210 (the renderable-node unification) ALSO resolves
//   LIGHTS: a light is wired flat into scene.lights (or the active rig's lights),
//   not nested under a Transform, so its world == its own overlaid local matrix.
//   The same channel + transient overlay the scene-child path uses applies (one
//   band, H40) — so a constraint can aim at a light and __basher_world_transform
//   is uniform across node kinds. Still out of scope: a GltfChild's world
//   (addressed BY NAME inside a GltfAsset, not a scene-child edge) and
//   Scatter-instance / Character-bone worlds (sub-objects that are not addressable
//   DAG nodes). CAMERAS (#210 slice 3.2) resolve via their POSE — a camera is
//   wired through scene.camera (a single ref) and never appears in the walks
//   below, so a dedicated early branch returns position + look-orientation
//   (-Z → lookAt, the frame CameraHelpers draws) + identity scale, with the
//   position/lookAt channels overlaid by the SAME primitive (one band, H40). It
//   does NOT import the camera resolver (activeCamera → trackTo →
//   resolveWorldTransform would cycle) and does NOT reflect a camera Track-To aim
//   (that is the active-camera RENDER path, resolveActiveCameraPoseAt).
//   Descent stops at out-of-scope nodes and returns null. Documented, not silent.
//
// V8 file-location: lives in src/app/ beside resolveEvaluatedTransform — its
//   consumers (constraints, the camera migration) and its tests sit in
//   src/app/-reach; placing it in src/viewport/ would force app→viewport imports.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.3; vyapti V37/V58; H40.

import * as THREE from 'three';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeRef } from '../core/dag/types';
import type { RenderOutputValue, SceneChild } from '../nodes/types';
import { overlayTransients } from './overlayTransients';
import { overlayChannels } from '../nodes/overlayChannels';
import { directChannelValuesForTarget } from './nodeChannels';
import { resolveRigLightSources } from './resolveRigLightSources';
import { useTransientEditStore } from './stores/transientEditStore';

type Vec3 = [number, number, number];

export interface WorldTransform {
  /** World-space translation. */
  position: Vec3;
  /** World-space orientation as a quaternion [x, y, z, w]. */
  quaternion: [number, number, number, number];
  /** World-space scale. */
  scale: Vec3;
  /** Column-major 4×4 world matrix (THREE.Matrix4.toArray order) for consumers
   *  that want the composed matrix directly (Copy Transforms / Child Of). */
  matrix: number[];
}

const DEG2RAD = Math.PI / 180;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** First `{node}` of an input binding (single ref or a list's head), or null. */
function refNode(binding: unknown): string | null {
  if (Array.isArray(binding)) {
    const head = binding[0] as NodeRef | undefined;
    return head?.node ?? null;
  }
  const ref = binding as NodeRef | undefined;
  return ref && typeof ref === 'object' && 'node' in ref ? ref.node : null;
}

/**
 * The LOCAL matrix a single SceneChild value contributes — MIRRORING the R3F
 * element SceneFromDAG emits for that kind:
 *   - Transform → `<group pos/rot°/scale>`            (TransformR)
 *   - Group / MaterialOverride → pass-through, identity (GroupR / MaterialOverrideR)
 *   - BoxMesh / SphereMesh → `<mesh pos/rot°/scale>`   (Box/SphereMeshR)
 *   - BakedMesh → `<mesh pos/rot° scale=[1,1,1]>`      (transform baked into verts)
 *   - other (GltfAsset root, etc.) → its TRS when present, else identity
 *
 * `.scale` is the TRANSFORM band (the `<mesh scale>` three multiplies into the
 * matrix), NOT BoxMesh `.size` (that is geometry args — it changes verts, not the
 * matrix). Rotation is DEGREES in the DAG (rotation.ts) → radians via Euler
 * 'XYZ' (three.js Object3D default), so this `compose()` == Object3D.updateMatrix.
 */
function localMatrix(value: SceneChild): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const v = value as unknown as {
    kind: string;
    position?: unknown;
    rotation?: unknown;
    scale?: unknown;
  };
  // Group / MaterialOverride render as a pass-through (bare or no group) — identity.
  if (v.kind === 'Group' || v.kind === 'MaterialOverride') return m;
  const pos = isVec3(v.position) ? v.position : ([0, 0, 0] as Vec3);
  const rot = isVec3(v.rotation) ? v.rotation : ([0, 0, 0] as Vec3);
  // A baked mesh renders at identity scale (the transform is in the geometry).
  const scl: Vec3 =
    v.kind === 'BakedMesh' ? [1, 1, 1] : isVec3(v.scale) ? v.scale : ([1, 1, 1] as Vec3);
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rot[0] * DEG2RAD, rot[1] * DEG2RAD, rot[2] * DEG2RAD, 'XYZ'),
  );
  m.compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    q,
    new THREE.Vector3(scl[0], scl[1], scl[2]),
  );
  return m;
}

/** The (childNodeId, childValue) edges to descend, mapping each evaluated child
 *  VALUE to its producing DAG node id via the consumer's input sockets. This is
 *  the parallel-walk seam: the value carries the evaluated TRS, the DAG node
 *  carries the ids. Kinds with no addressable child nodes (leaf meshes, Scatter,
 *  Character, GltfAsset) return []. */
function childEdges(
  state: DagState,
  nodeId: string,
  value: SceneChild,
): Array<{ id: string; value: SceneChild }> {
  const node = state.nodes[nodeId];
  if (!node) return [];
  const v = value as unknown as {
    kind: string;
    child?: SceneChild | null;
    children?: readonly SceneChild[];
  };
  switch (v.kind) {
    case 'Transform':
    case 'MaterialOverride': {
      // Both wrap one child via the `target` input socket (Transform.ts:28,
      // MaterialOverride.ts:63); the evaluated value field is `child`.
      const childId = refNode(node.inputs.target);
      if (!childId || !v.child) return [];
      return [{ id: childId, value: v.child }];
    }
    case 'Group': {
      // Group aggregates via the `children` list socket (Group.ts:19); index i in
      // the value's `children` corresponds to index i in `inputs.children`.
      const refs = node.inputs.children;
      const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
      const kids = v.children ?? [];
      const out: Array<{ id: string; value: SceneChild }> = [];
      for (let i = 0; i < kids.length; i++) {
        const id = (list[i] as NodeRef | undefined)?.node;
        if (id) out.push({ id, value: kids[i] });
      }
      return out;
    }
    default:
      return [];
  }
}

/** Depth-first search for `targetId`, accumulating the world matrix top-down
 *  (world = ancestorWorld · localMatrix(value)). Returns the world matrix at the
 *  target, or null if the target is not under this subtree. */
function walk(
  state: DagState,
  nodeId: string,
  value: SceneChild,
  acc: THREE.Matrix4,
  targetId: string,
): THREE.Matrix4 | null {
  const world = acc.clone().multiply(localMatrix(value));
  if (nodeId === targetId) return world;
  for (const edge of childEdges(state, nodeId, value)) {
    const found = walk(state, edge.id, edge.value, world, targetId);
    if (found) return found;
  }
  return null;
}

/** The world matrix of a camera from its pose: position + the orientation that
 *  rotates the camera's local -Z (three.js forward) onto (position → lookAt),
 *  identity scale. Mirrors CameraHelpers.frustumQuaternion so the resolved world
 *  matches the drawn frustum. */
function cameraWorldMatrix(position: Vec3, lookAt: Vec3): THREE.Matrix4 {
  const pos = new THREE.Vector3(position[0], position[1], position[2]);
  const dir = new THREE.Vector3(
    lookAt[0] - position[0],
    lookAt[1] - position[1],
    lookAt[2] - position[2],
  );
  if (dir.lengthSq() === 0) dir.set(0, 0, -1);
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
}

function decompose(m: THREE.Matrix4): WorldTransform {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  return {
    position: [p.x, p.y, p.z],
    quaternion: [q.x, q.y, q.z, q.w],
    scale: [s.x, s.y, s.z],
    matrix: m.toArray(),
  };
}

/**
 * Resolve the accumulated WORLD transform of `selectedId` at `ctx.time` — pure,
 * MIRRORING the SceneFromDAG composition (see file header). Returns null when
 * the node is not reachable as a scene-child descendant (the caller falls back to
 * the node's local transform / static params — today's behavior, no crash).
 *
 * Pass the shared evaluator `cache` SceneFromDAG already holds so the render-root
 * evaluate is a cache HIT (no double work).
 */
export function resolveWorldTransform(
  state: DagState,
  selectedId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): WorldTransform | null {
  // 0. Cameras (#210 slice 3.2) — wired via scene.camera (a single ref), a camera
  //    never appears in the scene-child / light walks below. Resolve its world
  //    from its pose: position + look-orientation + identity scale, with the
  //    position/lookAt channels overlaid by the shared primitive (one band, H40 —
  //    overlayChannels.sample == the camera resolver's sampler). See the header on
  //    why this stays inline (the activeCamera import would cycle) and why a camera
  //    Track-To aim is not reflected here.
  const camNode = state.nodes[selectedId];
  if (
    camNode &&
    (camNode.type === 'PerspectiveCamera' || camNode.type === 'OrthographicCamera')
  ) {
    const cp = camNode.params as { position?: unknown; lookAt?: unknown };
    let cam: { position: Vec3; lookAt: Vec3 } = {
      // Fallbacks mirror DEFAULT_CAMERA_POSE (activeCamera.ts) without importing it.
      position: isVec3(cp.position) ? cp.position : [3, 2, 3],
      lookAt: isVec3(cp.lookAt) ? cp.lookAt : [0, 0, 0],
    };
    const camChannels = directChannelValuesForTarget(state.nodes, selectedId).filter(
      (c) => c.paramPath === 'position' || c.paramPath === 'lookAt',
    );
    if (camChannels.length > 0) {
      cam = overlayChannels(cam, camChannels, 1, ctx.time.seconds) ?? cam;
    }
    return decompose(cameraWorldMatrix(cam.position, cam.lookAt));
  }

  // 1. Render root — the same evaluate SceneFromDAG makes every render.
  const target = state.outputs.render;
  if (!target) return null;
  let value: RenderOutputValue;
  try {
    value = evaluate(state, target.node, { cache, ctx }).value as RenderOutputValue;
  } catch {
    return null;
  }
  if (!value?.scene?.children) return null;

  // 2. Scene child-ref list — childRefs[i].node ↔ value.scene.children[i], EXACTLY
  //    as SceneFromDAG and resolveEvaluatedTransform resolve it.
  const sceneRef = state.outputs.scene;
  const sceneNode = sceneRef ? state.nodes[sceneRef.node] : null;
  const childRefs =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as NodeRef[])
      : [];

  const transients = useTransientEditStore.getState().edits;
  const identity = new THREE.Matrix4();

  // 3. Walk each top-level subtree. The top-level child value is overlaid the
  //    SAME way DirectChannelsR renders it (free-floating channels → held
  //    transient, at ctx.time.seconds) so an animated ancestor moves its
  //    descendants' world transform in lockstep with the render (H40, one band).
  for (let i = 0; i < value.scene.children.length; i++) {
    const topId = childRefs[i]?.node;
    if (!topId) continue;
    let child: SceneChild | null = value.scene.children[i];
    const directChannels = directChannelValuesForTarget(state.nodes, topId);
    if (child && directChannels.length > 0) {
      child = overlayChannels(child, directChannels, 1, ctx.time.seconds);
    }
    child = overlayTransients(child, topId, transients);
    if (!child) continue;
    const world = walk(state, topId, child, identity, selectedId);
    if (world) return decompose(world);
  }

  // 4. Lights (#210) — a light is wired FLAT into scene.lights (or the active
  //    rig's lights), not nested under a Transform, so its world == its own
  //    overlaid local matrix. Mirror the renderer's index-correspondence:
  //    lightRefs[i] ↔ scene.lights[i] (SceneFromDAG.tsx:175-178) and
  //    rigLightSources[i] ↔ scene.lightRig.lights[i] (#208). The SAME channel →
  //    transient overlay the scene-child path uses applies (one band, H40) so the
  //    resolved world tracks an animated light exactly as the constraint/read need.
  const lightEdges: Array<{ id: string; value: SceneChild }> = [];
  const directLights = value.scene.lights ?? [];
  const lightRefs = Array.isArray(sceneNode?.inputs.lights)
    ? (sceneNode!.inputs.lights as NodeRef[])
    : [];
  for (let i = 0; i < directLights.length; i++) {
    const id = lightRefs[i]?.node;
    if (id) lightEdges.push({ id, value: directLights[i] as unknown as SceneChild });
  }
  const rigLights = value.scene.lightRig?.lights ?? [];
  const rigSources = resolveRigLightSources(state);
  for (let i = 0; i < rigLights.length; i++) {
    const id = rigSources[i];
    if (id) lightEdges.push({ id, value: rigLights[i] as unknown as SceneChild });
  }
  for (const edge of lightEdges) {
    if (edge.id !== selectedId) continue;
    let lit: SceneChild | null = edge.value;
    const directChannels = directChannelValuesForTarget(state.nodes, edge.id);
    if (lit && directChannels.length > 0) {
      lit = overlayChannels(lit, directChannels, 1, ctx.time.seconds);
    }
    lit = overlayTransients(lit, edge.id, transients);
    if (!lit) continue;
    return decompose(identity.clone().multiply(localMatrix(lit)));
  }

  return null;
}
