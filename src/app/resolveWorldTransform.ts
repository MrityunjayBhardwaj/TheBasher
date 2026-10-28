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
//   DAG nodes). CAMERAS (#210 slice 3.2) resolve via their POSE — a dedicated
//   early branch returns position + look-orientation (-Z → lookAt, the frame
//   CameraHelpers draws) + identity scale, with the position/lookAt channels
//   overlaid by the SAME primitive (one band, H40). #231 Inc 3.3 — a camera can
//   now be a Group CHILD (groupable cameras): the early branch composes the
//   parent's world via `resolveParentWorldMatrix` (which DOES walk scene.children
//   to find the nested camera), so a nested camera's world == parentWorld · its
//   pose matrix. A camera wired only to scene.camera (not in a Group) → parentWorld
//   null → byte-identical to the flat local-pose world. It does NOT import the
//   camera resolver (activeCamera → trackTo → resolveWorldTransform would cycle)
//   and does NOT reflect a camera Track-To aim (that is the active-camera RENDER
//   path, resolveActiveCameraPoseAt). Descent stops at out-of-scope nodes, null.
//
// V8 file-location: lives in src/app/ beside resolveEvaluatedTransform — its
//   consumers (constraints, the camera migration) and its tests sit in
//   src/app/-reach; placing it in src/viewport/ would force app→viewport imports.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.3; vyapti V37/V58; H40.

import * as THREE from 'three';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { NodeRef } from '../core/dag/types';
import type { RenderOutputValue, SceneChild } from '../nodes/types';
import { overlayTransients } from './overlayTransients';
import { overlayChannels } from '../nodes/overlayChannels';
import { overlayCameraChannels } from './cameraChannels';
import { layeredChannelValues } from './layeredChannels';
import { driverChannelValuesForTarget } from './paramDrivers';
import type { KeyframeChannelValue } from '../nodes/types';
import { cameraLensParams, isCameraNode } from './cameraNode';
import { resolveRigLightSources } from './resolveRigLightSources';
import { cameraOrientationQuat } from './cameraOrientation';
import { hierarchySocketForKind } from './sceneHierarchy';
import { sceneIndexOf } from './sceneIndex';
import { getNodeType } from '../core/dag/registry';
import { conversionsInto } from '../core/dag/socketConversion';
import { useTransientEditStore } from './stores/transientEditStore';
import { withResolvedRotation } from './resolvedRotation';
import { boneParentMatrix } from '../nodes/boneParent';
import { type ClockedCtx, ctxOnClock, ctxOnClockOf } from './subjectClock';
import { measureStage } from '../perf/frameProfiler';

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
 *   - Group → `<group pos/rot°/scale><group -pivot>`   (GroupR, #222) — pivot-aware
 *   - MaterialOverride → pass-through, identity         (MaterialOverrideR)
 *   - BoxMesh / SphereMesh → `<mesh pos/rot°/scale>`   (Box/SphereMeshR)
 *   - a baked Object → `<mesh pos/rot°/scale>`          (BakedMeshR, #489)
 *   - other (GltfAsset root, etc.) → its TRS when present, else identity
 *
 * `.scale` is the TRANSFORM band (the `<mesh scale>` three multiplies into the
 * matrix), NOT BoxMesh `.size` (that is geometry args — it changes verts, not the
 * matrix). Rotation is DEGREES in the DAG (rotation.ts) → radians via Euler
 * 'XYZ' (three.js Object3D default), so this `compose()` == Object3D.updateMatrix.
 */
export function localMatrix(value: SceneChild): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  // #1153 — the one composition point of this resolver, called on each value after its
  // overlay: a quaternion-mode value's orientation is read into `rotation` here.
  const v = withResolvedRotation(value) as unknown as {
    kind: string;
    position?: unknown;
    rotation?: unknown;
    scale?: unknown;
    pivot?: unknown;
  };
  // MaterialOverride renders as a pass-through (no group) — identity.
  if (v.kind === 'MaterialOverride') return m;
  const pos = isVec3(v.position) ? v.position : ([0, 0, 0] as Vec3);
  const rot = isVec3(v.rotation) ? v.rotation : ([0, 0, 0] as Vec3);
  // #489 — a baked mesh honours its scale like every other kind, so there is no baked special
  // case here any more. It used to read identity, to agree with `BakedMeshR`'s pinned
  // `scale={[1,1,1]}` (the two roads had to move together, and that pin is why this comment
  // named the renderer). Both now take the Object's scale: what an Apply baked reads identity
  // on the Object, so nothing is applied twice, and a band the Apply kept (#1080) or a later
  // edit is read and drawn the same.
  const scl: Vec3 = isVec3(v.scale) ? v.scale : ([1, 1, 1] as Vec3);
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rot[0] * DEG2RAD, rot[1] * DEG2RAD, rot[2] * DEG2RAD, 'XYZ'),
  );
  m.compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    q,
    new THREE.Vector3(scl[0], scl[1], scl[2]),
  );
  // #222 — a Group rotates/scales about its `pivot`: the renderer wraps children
  // in an inner `<group position={-pivot}>` (GroupR), so the local matrix is
  // Translate(pos)·R·S·Translate(-pivot). At pivot=0 this is identity (back-compat).
  if (v.kind === 'Group' && isVec3(v.pivot)) {
    const [px, py, pz] = v.pivot as Vec3;
    m.multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
  }
  return m;
}

/** The (childNodeId, childValue) edges to descend, mapping each evaluated child
 *  VALUE to its producing DAG node id via the consumer's input sockets. This is
 *  the parallel-walk seam: the value carries the evaluated TRS, the DAG node
 *  carries the ids. Kinds with no addressable child nodes (leaf meshes, Scatter,
 *  Character, GltfAsset) return [].
 *
 *  EXPORTED (#266, B1) — the renderer reuses this SAME value→id map to resolve a
 *  nested child's node id at any depth, so an edge-less overlay (constraint /
 *  channel, [[V88]] N6) mounts by FLAT-ID LOOKUP instead of a render-tree walk.
 *  Do NOT author a second walk (Chesterton — the resolver already trusts this). */
export function childEdges(
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
      // Both wrap one child via their DECLARED chain socket (`chain.input`, #396) —
      // spelled `target` by Transform.ts:31 and MaterialOverride.ts:65 today. The
      // evaluated value field is `child`.
      //
      // Read the declaration rather than the name: "the socket called `target`" and
      // "the socket the wrap descends" agree for every type in the registry right
      // now, and stop agreeing the moment a wrapper gains a second same-typed input
      // (an argument, not a spine). At that point a by-name read still registers,
      // still connects and still evaluates — it just descends the wrong edge, which
      // here means a child that animates in the panel and freezes on screen.
      // #621 — the socket comes from `sceneHierarchy`, the one place that says which
      // sockets make a scene-graph parent. It resolves to the declared `chain.input`
      // for these two, so this is the same read #610 introduced; it is now shared with
      // the two scan sites below instead of being restated by each of them.
      const socket = hierarchySocketForKind(v.kind, node);
      const childId = socket ? refNode(node.inputs[socket]) : null;
      if (!childId || !v.child) return [];
      return [{ id: childId, value: v.child }];
    }
    case 'Group':
    case 'Object': {
      // #1152 — an Object parents through the same list socket, and its value carries
      // `children` only when it holds any (absent reads as none, below).
      // Group aggregates via its list socket (Group.ts:19); index i in the value's
      // `children` corresponds to index i in the binding. Read by INDEX rather than
      // through `hierarchyChildIds`, which compacts: an unbound entry must consume its
      // slot here or every later child would pair with the wrong value.
      const socket = hierarchySocketForKind(v.kind, node);
      const refs = socket ? node.inputs[socket] : undefined;
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
  at: Overlay,
): THREE.Matrix4 | null {
  const world = acc.clone().multiply(localMatrix(value));
  if (nodeId === targetId) return world;
  // `childEdges` reads the children off the RAW value, so each one is overlaid on the way down.
  for (const edge of childEdges(state, nodeId, value)) {
    const child = overlaidAt(state, edge.id, edge.value, at);
    if (!child) continue;
    const found = walk(
      state,
      edge.id,
      child,
      underParent(state, world, value, nodeId, child, at),
      targetId,
      at,
    );
    if (found) return found;
  }
  return null;
}

/** Like `walk`, but returns the target's PARENT world matrix — the accumulated
 *  ANCESTOR world BEFORE the target's own local matrix (so `parentWorld ·
 *  localMatrix(target) === walk(...)`). `acc` at the target IS that parent world.
 *  Returns null if the target is not under this subtree. (#230 — the gizmo needs
 *  the parent world to anchor in world space and convert a drag back to local.) */
function walkParent(
  state: DagState,
  nodeId: string,
  value: SceneChild,
  acc: THREE.Matrix4,
  targetId: string,
  at: Overlay,
): THREE.Matrix4 | null {
  if (nodeId === targetId) return acc;
  const world = acc.clone().multiply(localMatrix(value));
  for (const edge of childEdges(state, nodeId, value)) {
    const child = overlaidAt(state, edge.id, edge.value, at);
    if (!child) continue;
    const found = walkParent(
      state,
      edge.id,
      child,
      underParent(state, world, value, nodeId, child, at),
      targetId,
      at,
    );
    if (found) return found;
  }
  return null;
}

/**
 * #1210 — the space a child of `parent` hangs in: the parent's world, then the pose of the bone the
 * child is parented to when it names one (`boneParentMatrix`, Blender's `ob_parbone`). The renderer
 * composes the same product (`ObjectR`), so the drawn child and this read agree.
 */
function underParent(
  state: DagState,
  parentWorld: THREE.Matrix4,
  parent: SceneChild,
  parentId: string,
  child: SceneChild,
  at: Overlay,
): THREE.Matrix4 {
  // #1688 — the bone is posed on the clock the armature runs on (a camera rig's may be the
  // playhead's), as `BoneParentR` draws it.
  const seconds = ctxOnClockOf(state, parentId, at.ctx).time.seconds;
  const bone = boneParentMatrix(parent, child, seconds);
  return bone ? parentWorld.clone().multiply(bone) : parentWorld;
}

/** The time, evaluation context and held edits a walk overlays each node with. */
interface Overlay {
  readonly ctx: ClockedCtx;
  readonly cache: EvaluatorCache | undefined;
  readonly transients: ReturnType<typeof useTransientEditStore.getState>['edits'];
}

/**
 * #1166 — the channels the renderer folds onto `nodeId`: its bare channels, the channels its
 * placed Strips contribute, then its drivers — SceneFromDAG's `useLayeredChannels`, the set
 * `resolveEvaluatedTransform` folds too. Reading only the bare channels left a node moved by a
 * strip or a driver drawn in one place while this read sat on its static pose.
 */
function drawnChannels(state: DagState, nodeId: string, at: Overlay): KeyframeChannelValue[] {
  // #1729 — both folds read the scene index's slice of the table, not the whole of it: the
  // channels, strips and tracks the layered fold reads, and the driver fold only for a node a
  // driver names. Each used to scan every node, at every node a read passed.
  const index = sceneIndexOf(state.nodes);
  const layered = layeredChannelValues(index.layeredNodesFor(nodeId), nodeId);
  if (!index.hasDriversOn(nodeId)) return layered;
  const drivers = driverChannelValuesForTarget(state, nodeId, at.ctx, at.cache);
  return drivers.length === 0 ? layered : [...layered, ...drivers];
}

/**
 * One node's value as the renderer draws it: the channels it folds ({@link drawnChannels}), then its
 * held transient — the band DirectChannelsR applies to a node at ANY depth (#266). #268 — this used to
 * run for top-level scene children only, so a channel on a nested node, or on a nested ancestor,
 * moved the drawn mesh and left this read on the static pose.
 */
function overlaidAt(
  state: DagState,
  nodeId: string,
  value: SceneChild,
  at: Overlay,
): SceneChild | null {
  // #1688 — each node folds its channels on the clock it runs on, as the renderer draws it.
  const ctx = ctxOnClockOf(state, nodeId, at.ctx);
  if (ctx !== at.ctx) at = { ...at, ctx };
  let child: SceneChild | null = value;
  const channels = drawnChannels(state, nodeId, at);
  if (channels.length > 0) child = overlayChannels(child, channels, 1, at.ctx.time.seconds);
  return overlayTransients(child, nodeId, at.transients);
}

/**
 * #1729 — the holders of `id` from a top-level scene child down to `id` itself, read UP the scene
 * index: `[top, …, id]`. The cost is `id`'s depth, where searching down from the scene cost its
 * size. Null when `id` does not hang under the scene at all. `'search'` when some node on the way
 * is held more than once (by two parents, or listed twice): the depth-first search from the scene
 * then decides which holding wins, as it always has, so the caller makes that search.
 *
 * Holders are the sockets `sceneHierarchy` names by node TYPE, where `childEdges` keys on the value
 * KIND; the two agree for every type (pinned by the `mirrorsChildEdges` test), and the nesting fast
 * path this replaces already decided on the same relation.
 */
function holderChain(state: DagState, id: string): string[] | null | 'search' {
  const index = sceneIndexOf(state.nodes);
  const sceneId = state.outputs.scene?.node;
  const chain = [id];
  for (let at = id; ; ) {
    const holders = index.parentsOf(at);
    if (holders.length === 0) return null;
    if (holders.length > 1) return 'search';
    const holder = holders[0];
    if (holder === sceneId) return chain.reverse();
    // Held by a scene that is not the one rendered.
    if (state.nodes[holder]?.type === 'Scene') return null;
    if (chain.includes(holder)) return 'search';
    chain.push(holder);
    at = holder;
  }
}

/** Whether a value reaches the Scene's `children` exactly as its producer made it. When some type
 *  converts on the way in (#1549), only the evaluate of the whole scene gives what arrives. Kept
 *  once known; not while the Scene type is unregistered, so an early call cannot fix the answer. */
let sceneChildrenAsProduced: boolean | undefined;
function sceneChildrenArriveAsProduced(): boolean {
  if (sceneChildrenAsProduced !== undefined) return sceneChildrenAsProduced;
  const into = getNodeType('Scene')?.inputs.children;
  if (!into) return false;
  sceneChildrenAsProduced = conversionsInto(into) === null;
  return sceneChildrenAsProduced;
}

/**
 * The value top-level child `topId` gives the rendered scene, overlaid as the renderer draws it —
 * `scene.children[i]` of the render root, got by evaluating `topId` alone: the scene passes its
 * children through, so with the same context the evaluate is the same cache entries. Evaluating
 * the render root re-walked and re-hashed every node to answer for one (#1729). `'search'` when the
 * render does not draw the output scene directly, or a conversion on the way in means only the
 * scene's own evaluate says what arrives.
 */
function topLevelValue(state: DagState, topId: string, at: Overlay): SceneChild | null | 'search' {
  const render = state.outputs.render;
  if (!render) return null;
  const sceneId = state.outputs.scene?.node;
  const drawn = state.nodes[render.node]?.inputs.scene;
  if (!sceneId || !drawn || Array.isArray(drawn) || (drawn as NodeRef).node !== sceneId) {
    return 'search';
  }
  if (!sceneChildrenArriveAsProduced()) return 'search';
  const refs = state.nodes[sceneId]?.inputs.children;
  const list = (Array.isArray(refs) ? refs : refs ? [refs] : []) as NodeRef[];
  const ref = list.find((r) => r?.node === topId);
  if (!ref) return null;
  let produced: unknown;
  try {
    produced = evaluate(state, topId, { cache: at.cache, ctx: at.ctx }).value;
  } catch {
    return null;
  }
  // The evaluator's socket read: a record carrying the socket's name answers with that field.
  const value =
    produced &&
    typeof produced === 'object' &&
    Object.prototype.hasOwnProperty.call(produced, ref.socket)
      ? (produced as Record<string, unknown>)[ref.socket]
      : produced;
  return value ? overlaidAt(state, topId, value as SceneChild, at) : null;
}

/** Compose down `chain` from its overlaid top value: `walk` / `walkParent` along the one path. */
function composeDown(
  state: DagState,
  chain: readonly string[],
  top: SceneChild,
  at: Overlay,
  parentOnly: boolean,
): THREE.Matrix4 | null {
  let value = top;
  let acc = new THREE.Matrix4();
  for (let k = 0; k + 1 < chain.length; k++) {
    const world = acc.clone().multiply(localMatrix(value));
    const edge = childEdges(state, chain[k], value).find((e) => e.id === chain[k + 1]);
    if (!edge) return null;
    const child = overlaidAt(state, edge.id, edge.value, at);
    if (!child) return null;
    acc = underParent(state, world, value, chain[k], child, at);
    value = child;
  }
  return parentOnly ? acc : acc.clone().multiply(localMatrix(value));
}

/** The depth-first search from the render root that the chain replaces — kept for a node held
 *  more than once, and for a render that does not draw the output scene directly. */
function searchFromRoot(
  state: DagState,
  id: string,
  at: Overlay,
  parentOnly: boolean,
): THREE.Matrix4 | null {
  const target = state.outputs.render;
  if (!target) return null;
  let value: RenderOutputValue;
  try {
    value = evaluate(state, target.node, { cache: at.cache, ctx: at.ctx })
      .value as RenderOutputValue;
  } catch {
    return null;
  }
  if (!value?.scene?.children) return null;
  // Scene child-ref list — childRefs[i].node ↔ value.scene.children[i], EXACTLY as SceneFromDAG
  // and resolveEvaluatedTransform resolve it.
  const sceneRef = state.outputs.scene;
  const sceneNode = sceneRef ? state.nodes[sceneRef.node] : null;
  const childRefs =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as NodeRef[])
      : [];
  const identity = new THREE.Matrix4();
  for (let i = 0; i < value.scene.children.length; i++) {
    const topId = childRefs[i]?.node;
    if (!topId) continue;
    const child = overlaidAt(state, topId, value.scene.children[i], at);
    if (!child) continue;
    const found = parentOnly
      ? walkParent(state, topId, child, identity, id, at)
      : walk(state, topId, child, identity, id, at);
    if (found) return found;
  }
  return null;
}

/**
 * `id`'s world matrix as a scene-graph descendant — or, with `parentOnly`, the world of what it
 * hangs from — or null when it is not one. Walks up to the scene and composes down that path
 * (#1729); the search from the root answers only when the path is not unique.
 */
function sceneChildWorld(
  state: DagState,
  id: string,
  at: Overlay,
  parentOnly: boolean,
): THREE.Matrix4 | null {
  const chain = holderChain(state, id);
  if (chain === null) return null;
  // A top-level child hangs from the scene itself, whose world is the identity.
  if (parentOnly && chain !== 'search' && chain.length === 1) return new THREE.Matrix4();
  if (chain !== 'search') {
    const top = topLevelValue(state, chain[0], at);
    if (top !== 'search') return top ? composeDown(state, chain, top, at, parentOnly) : null;
  }
  return searchFromRoot(state, id, at, parentOnly);
}

function isIdentityMatrix(m: THREE.Matrix4): boolean {
  const e = m.elements;
  // Column-major identity. Tolerance absorbs compose/clone float noise.
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - I[i]) > 1e-6) return false;
  return true;
}

/** The world matrix of a camera from its pose: position + the orientation from
 *  (position → lookAt) banked by `roll`° (#229), identity scale. Delegates to the
 *  ONE shared `cameraOrientationQuat` so the resolved world matches the drawn
 *  frustum + the rendered/look-through orientation exactly (V37). */
function cameraWorldMatrix(position: Vec3, lookAt: Vec3, roll: number): THREE.Matrix4 {
  const pos = new THREE.Vector3(position[0], position[1], position[2]);
  const q = cameraOrientationQuat(position, lookAt, roll);
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
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): WorldTransform | null {
  // #1727 — timed as the `world` stage of a playback perf run; a plain call when none is armed.
  return measureStage('world', () => worldTransformOf(state, selectedId, ctx, cache));
}

function worldTransformOf(
  state: DagState,
  selectedId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): WorldTransform | null {
  // #1688 — the tree is evaluated at scene time; each node is re-timed onto its own clock.
  ctx = ctxOnClock(state, 'scene', ctx);
  // 0. Cameras (#210 slice 3.2) — wired via scene.camera (a single ref), a camera
  //    never appears in the scene-child / light walks below. Resolve its world
  //    from its pose: position + look-orientation + identity scale, with the
  //    camera's channels overlaid by `overlayCameraChannels`, the same call the
  //    camera resolver makes (#482). See the header on
  //    why this stays inline (the activeCamera import would cycle) and why a camera
  //    Track-To aim is not reflected here.
  const camNode = state.nodes[selectedId];
  if (camNode && isCameraNode(state, selectedId)) {
    // #387 — TWO reaches, and both must move together. The RAW read: `position` stays on
    // the Object (it owns the TRS) while `lookAt`/`roll` moved to the CameraData, so a
    // split camera read off one bag silently aims at the world origin. The CHANNEL read:
    // a channel on the aim targets the DATA half, so an exact-id scan finds nothing and a
    // keyed aim freezes. `cameraLensParams` answers the first; the both-ids enumerator —
    // the same one push-down and the render overlay consume — answers the second.
    const op = camNode.params as { position?: unknown };
    const cp = (cameraLensParams(state, selectedId) ?? {}) as { lookAt?: unknown; roll?: unknown };
    let cam: { position: Vec3; lookAt: Vec3; roll: number } = {
      // Fallbacks mirror DEFAULT_CAMERA_POSE (activeCamera.ts) without importing it.
      position: isVec3(op.position) ? op.position : [3, 2, 3],
      lookAt: isVec3(cp.lookAt) ? cp.lookAt : [0, 0, 0],
      roll: typeof cp.roll === 'number' ? cp.roll : 0,
    };
    // #1643 / #1688 — a camera's own keys run on the playhead, so something parented to it or
    // aimed at it reads it where it is drawn. What it hangs from keeps its own clock (below).
    const hungAt = ctx;
    ctx = ctxOnClockOf(state, selectedId, ctx);
    // #482 — the same call the camera's pose makes, so the gizmo and the render agree.
    cam = overlayCameraChannels(state, selectedId, cam, ctx, cache);
    // #231 Inc 3.3 — a camera nested in a Group composes the parent's world (the
    // groupable-camera path). `resolveParentWorldMatrix` returns null for a
    // top-level camera (wired only to scene.camera) → byte-identical to the flat
    // local-pose world. The local matrix is the camera's own pose orientation.
    const camLocal = cameraWorldMatrix(cam.position, cam.lookAt, cam.roll);
    const parentWorld = resolveParentWorldMatrix(state, selectedId, hungAt, cache);
    return decompose(parentWorld ? parentWorld.clone().multiply(camLocal) : camLocal);
  }

  const transients = useTransientEditStore.getState().edits;
  const identity = new THREE.Matrix4();

  // 1–3. A scene-graph descendant: every node from the top-level child down is overlaid the
  //    SAME way DirectChannelsR renders it (free-floating channels → held transient, at
  //    ctx.time.seconds), so an animated ancestor moves its descendants' world transform in
  //    lockstep with the render (H40, one band). #1729 — found by walking up the holders, not by
  //    searching the scene.
  const at: Overlay = { ctx, cache, transients };
  const world = sceneChildWorld(state, selectedId, at, false);
  if (world) return decompose(world);

  // The render root, for the lights below — the same evaluate SceneFromDAG makes every render.
  const target = state.outputs.render;
  if (!target) return null;
  let value: RenderOutputValue;
  try {
    value = evaluate(state, target.node, { cache, ctx }).value as RenderOutputValue;
  } catch {
    return null;
  }
  if (!value?.scene?.children) return null;
  const sceneRef = state.outputs.scene;
  const sceneNode = sceneRef ? state.nodes[sceneRef.node] : null;

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
    // A light folds what DirectChannelsLightR draws it with, as every other node does.
    const lit = overlaidAt(state, edge.id, edge.value, { ctx, cache, transients });
    if (!lit) continue;
    return decompose(identity.clone().multiply(localMatrix(lit)));
  }

  return null;
}

/**
 * #1638 — `nodeId`'s world matrix at any playhead, for a reader that samples something else at
 * the playhead too (a rig's pose). Resolved at that time through this one resolver, so keyed travel
 * on the node or any ancestor arrives exactly as the renderer folds it; `atRest` (the frame-0 matrix
 * the caller already holds) stands in where the node is not reachable at that time.
 */
export function worldMatrixAt(
  state: DagState,
  nodeId: string,
  atRest: readonly number[],
  cache?: EvaluatorCache,
): (seconds: number) => readonly number[] {
  return (seconds) =>
    resolveWorldTransform(
      state,
      nodeId,
      { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } },
      cache,
    )?.matrix ?? atRest;
}

/**
 * The world matrix of `selectedId`'s PARENT — the accumulated ancestor transform
 * the node hangs under — or **null** when the node has no non-trivial parent. Used
 * by the gizmo (#230) to anchor in world space and convert a drag back to the
 * node's local params.
 *
 * Returns null (→ caller keeps the local-only path, byte-identical to pre-#230)
 * for: a top-level scene child (parent is the identity scene root); a parent that
 * composes to identity (ancestors at origin / no rotation·scale — local == world);
 * cameras and lights (wired FLAT into scene.camera / scene.lights, never nested);
 * and unresolvable kinds (GltfChild — addressed by name; Scatter/Character
 * sub-objects; not found). Returns the parent's world matrix ONLY for a genuinely
 * nested scene child (under a transformed Transform/Group chain).
 *
 * MIRRORS `resolveWorldTransform`'s scene-child walk (same render-root evaluate,
 * same index-correspondence, same channel→transient overlay on the top-level
 * child) so the parent world tracks an animated ancestor exactly as the render does
 * (one band, H40).
 */
export function resolveParentWorldMatrix(
  state: DagState,
  selectedId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): THREE.Matrix4 | null {
  return measureStage('world', () => parentWorldMatrixOf(state, selectedId, ctx, cache));
}

function parentWorldMatrixOf(
  state: DagState,
  selectedId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): THREE.Matrix4 | null {
  // #1688 — the tree is evaluated at scene time; each node is re-timed onto its own clock.
  ctx = ctxOnClock(state, 'scene', ctx);
  const node = state.nodes[selectedId];
  if (!node) return null;
  // #231 Inc 3.3 — a camera can be a Group CHILD (groupable cameras), so cameras take the same
  // road: a nested camera is found as a Group descendant and gets the Group's accumulated world,
  // while one wired only to scene.camera, like a top-level light (scene.lights), is held by no
  // parent and has none.
  //
  // #1729 — the node is found by walking UP its holders (the scene index) and composing down that
  // one path, so the cost is its depth. That walk also answers the old nesting fast path — a node
  // nothing holds is not a descendant, null without an evaluate — and a top-level child, whose
  // parent is the scene's identity, without one either.
  const at: Overlay = { ctx, cache, transients: useTransientEditStore.getState().edits };
  const parent = sceneChildWorld(state, selectedId, at, true);
  // Not a descendant (GltfChild / Scatter / unreachable / flat camera or light) → null. A parent
  // that composes to identity → null, so the caller keeps its local-only path.
  return parent && !isIdentityMatrix(parent) ? parent : null;
}
