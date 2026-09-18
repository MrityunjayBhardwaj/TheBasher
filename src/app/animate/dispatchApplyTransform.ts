// dispatchApplyTransform — Apply-Transform (Phase 151 Wave 2 t5, issue #151). Three roads:
//
//   - STORED MESH DATA (#1077, `applyIntoStoredMesh`): the pose is written into the mesh data at
//     the base of the Object's data lane, and the Object keeps posing it. No bake, no OPFS write,
//     the material is never read. Every native import takes this road.
//   - BOX / SPHERE (below): compose the (masked) resolved TRS into a 4×4 matrix, bake it into a
//     CLONE of the registry geometry, persist the baked bytes to OPFS, and swap the original mesh
//     node for a baked pair in ONE atomic Op composite (one dispatchAtomic = one Cmd+Z).
//   - glTF CHILD on the clone road (`dispatchApplyGltfChild`).
//
// THE single OPFS-write chokepoint (V20) and the single Apply Op author (V1).
//
// Lifecycle (K15 extension, ORDERED):
//   1. resolve(sync) — read the resolved transform via resolveEvaluatedMesh.
//   2. clone+matrix(sync) — getForRead(ref) returns a SHARED instance;
//      `.clone()` BEFORE applyMatrix4 (H45 — mutating the cache corrupts every
//      mesh sharing the key). Recompute normals when rotation/scale was baked.
//   3. OPFS write(async, AWAITED) — writeBakedGeometry. The await guarantees the
//      bytes exist before the node referencing them is committed (reload-safe).
//   4. Op composite(sync) — the BakedMesh INHERITS the applied node's id (#412), so
//      everything keyed by node id rather than by edge (a constraint/driver target, an
//      NLA strip) survives the bake. Ordered: disconnect every consumer edge → removeNode
//      original (+ its exclusive data node) → addNode BakedMesh at the SAME id → replay
//      the edges in ascending list index (preserves sibling order). The glTF-child path
//      still mints a fresh id — see nextBakedId.
//
// Animated guard (D-04): if ANYTHING the bake consumes is keyframed, reject — the
// dispatch-side belt (the UI also disables, through the same predicate). #411
// widened this from an enumerated TRS list to "is this node animated at all",
// reaching through the split's `data` edge, because the bake consumes geometry and
// material as well as the transform: a keyframed `size`/`radius` was invisible to
// the old guard and got silently frozen at the current frame.
//
// REF: PLAN.md Wave 2 Task 5; RESEARCH §Q1/§M6; hetvabhasa H45; vyapti V1/V20;
//      bakedGeometryStore.ts (writeBakedGeometry); dispatchMutator.ts (atomic pattern).

import * as THREE from 'three';
import { useDagStore } from '../../core/dag/store';
import type { OpSource } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import { IDENTITY_QUATERNION } from '../../nodes/rotationMode';
import { rotationWriteOf } from '../resolvedRotation';
import type { Op, EvalCtx } from '../../core/dag/types';
import { requireNodeType } from '../../core/dag/registry';
import type {
  BakedMaterialSpec,
  InlineMaterialSpec,
  MeshGeometryData,
  MeshTransform,
  Vec3,
} from '../../nodes/types';
import {
  isPackedMeshData,
  packMeshData,
  unpackMeshData,
  type PackedMeshData,
} from '../meshGeometryData';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import { getForRead } from '../geometryRegistry';
import { unheldBakeAttributes, writeBakedGeometry } from '../asset/bakedGeometryStore';
import { assignedMaterials, primaryMaterial, slotMaterialAt } from '../materialAssignment';
import type { EvaluatedMesh, Quat, RotationModeFields } from '../../nodes/types';
import { resolveEvaluatedMesh } from '../resolveEvaluatedMesh';
import { linkedDataNodeId } from '../resolveDataParamOwner';
import { resolveDataLaneBase } from '../operatorChain';
import { dataLaneNodeIds } from '../dataLaneOverlay';
import { isKeyframeChannelNode, paramAnimationState } from './paramAnimationState';
import { getStorage } from '../boot';
import { useTimeStore } from '../stores/timeStore';
import { importedChildDataId, importedChildOf, isImportedChild } from '../importedChild';
import { useSelectionStore } from '../stores/selectionStore';
import { useTransientEditStore } from '../stores/transientEditStore';
import { getGltfClone } from '../asset/gltfCloneRegistry';
import { hierarchyChildIds, hierarchySocketForKind } from '../sceneHierarchy';
import { resolveParentWorldMatrix, resolveWorldTransform } from '../resolveWorldTransform';
import { quaternionToEulerVec3 } from '../../core/import/threeAdapter';
import { captureBakedMaterial } from './captureBakedMaterial';
import { evaluate, createEvaluatorCache } from '../../core/dag/evaluator';
import type { GltfAssetValue } from '../../nodes/types';

export type ApplyMask = 'all' | 'location' | 'rotation' | 'scale';

export type DispatchResult = { ok: true; bakedId: string } | { ok: false; reason: string };

/** Injectable dependencies — production wires the live stores; tests inject mocks. */
export interface ApplyDeps {
  state: DagState;
  storage: StorageCapability;
  currentFrame: number;
  dispatchAtomic: (ops: Op[], source?: OpSource, description?: string) => unknown;
  setSelection: (id: string) => void;
  /** Drop every held (un-keyed) edit for a node — see the call site in step 5. */
  clearTransients: (nodeId: string) => void;
  /** glTF-child path only — the live render clone (tests inject a fake Group;
   *  production reads it from the live-clone registry by assetRef). */
  gltfClone: THREE.Group;
}

const ANIMATED_MSG = 'Apply unavailable — the object or its geometry is animated (#153/#149)';

/**
 * True when ANYTHING the bake consumes is animated — the guard that makes Apply
 * refuse rather than silently freeze an animation at the current frame (D-04).
 *
 * #411 — this used to be `TRS_BANDS.some(...)`, an enumerated list of
 * position/rotation/scale. But the bake does not only consume the transform: it
 * resolves geometry and material too and writes them into the BakedMesh. A
 * keyframed `size` on a cube or `radius` on a sphere was therefore invisible to
 * the guard, and Apply baked frame 0 and threw the animation away with nothing
 * warning — observed on both the split and fused shapes, so it was never a
 * split-specific bug.
 *
 * THE RULE IS NOW "IS THIS NODE ANIMATED AT ALL", NOT A LIST OF BANDS. A channel
 * names its subject by id, so the question is answered by scanning for channels
 * that point at the node — there is no param-name list to forget to extend when a
 * new bakeable param appears. That is the same move #377/#378 made on the
 * capability gates: ask, don't enumerate.
 *
 * IT REACHES THROUGH THE SPLIT. Geometry and material live on the DATA node, so a
 * `size` channel targets the BoxData, not the Object the user selected. Without
 * the reach the guard would ask the wrong node and get the honest answer "nothing
 * animated here" — the exact shape of the reach bugs the split has produced repeatedly.
 *
 * #1081 / #1098 — AND IT ASKS WHAT THE ROAD CONSUMES, not a fixed pair of nodes. It used
 * to ask the Object and its first `data` hop for every Apply. A stack puts operators into
 * that edge, so on the bake road the hop landed on the TOP operator and everything below
 * it — the data's `size`, a lower modifier's `count` — baked away unrefused (measured: 8
 * of 24 cases). The bake removes the whole lane, so it asks the whole lane. Stored mesh
 * data is applied INTO instead (#1077), writing only the base's `mesh` and the Object's
 * pose and leaving every operator and channel live, so there the Object alone is asked;
 * the old pair refused over a material or top operator that road never reads. The road is
 * decided by {@link applyRoadOf}, the same function dispatch branches on, so the offer
 * (menu, N panel) and the dispatch cannot disagree about which question applies.
 *
 * This ALSO closes the orphaned-channel half of #411: the bake removes the data
 * node, which would leave a `size`/`material` channel targeting a dead id. Since
 * any such channel now blocks the bake outright, the orphan can no longer be
 * created here. (The constraint/driver/NLA targets that this guard does NOT reach
 * are handled structurally instead: since #412 the baked node inherits the applied
 * node's id, so an id-keyed reference has nothing to dangle from. Selection was
 * never at risk — it is runtime UI state, and Apply moves it explicitly.)
 *
 * KNOWN GAP: a param driven by a driver rather than a keyframe channel is still
 * invisible to this guard. Drivers are resolved by paramPath and would need the
 * same reach; no bake path exercises one today, so it is recorded rather than
 * guessed at.
 */
export function isApplySourceAnimated(
  state: DagState,
  nodeId: string,
  currentFrame: number,
): boolean {
  // The Object owns the pose, which both roads write. The bake also consumes every node on
  // the data lane (base first, then each operator); applying into stored mesh data consumes
  // none of them. A fused node has no lane and answers for itself alone.
  const subjects =
    applyRoadOf(state, nodeId).kind === 'into-stored-mesh'
      ? [nodeId]
      : [nodeId, ...dataLaneNodeIds(state, nodeId)];
  return Object.values(state.nodes).some((node) => {
    if (!isKeyframeChannelNode(node)) return false;
    const p = (node.params ?? {}) as { target?: unknown; paramPath?: unknown };
    if (typeof p.target !== 'string' || !subjects.includes(p.target)) return false;
    // Defer to the shared reader for what counts as animated, so this guard and
    // the inspector's diamonds never disagree about the same channel.
    return (
      typeof p.paramPath === 'string' &&
      paramAnimationState(state, p.target, p.paramPath, currentFrame) !== 'none'
    );
  });
}

/** Which of Apply's two roads a node takes, and for stored mesh data, what it applies into. */
export type ApplyRoad =
  | { readonly kind: 'into-stored-mesh'; readonly dataId: string; readonly mesh: PackedMeshData }
  | { readonly kind: 'bake' };

/**
 * #1081 / #1098 — the ONE decision between applying into stored mesh data (#1077) and baking,
 * read by the dispatch that branches on it and by the animated guard that must ask what that
 * branch consumes. Two spellings of this test would let the guard answer for one road while
 * dispatch took the other.
 *
 * Recognised by what the BASE of the data lane holds (a packed mesh), not by its type name, for
 * the reason `isPackedMeshData` gives — and the base, not the `data` hop, because a modifier or
 * material operator on the stack sits between the Object and its mesh.
 */
export function applyRoadOf(state: DagState, nodeId: string): ApplyRoad {
  const baseId = resolveDataLaneBase(state, nodeId);
  if (baseId === nodeId) return { kind: 'bake' };
  const mesh = (state.nodes[baseId]?.params as { mesh?: unknown } | undefined)?.mesh;
  return isPackedMeshData(mesh)
    ? { kind: 'into-stored-mesh', dataId: baseId, mesh }
    : { kind: 'bake' };
}

/**
 * #1080 — what an Apply of `mask` puts into the geometry, and what it leaves on the Object. ONE
 * answer for every road that moves a pose into geometry: both bakes and the stored-mesh road (#1077).
 *
 * `kept` is the resolved pose with the applied bands set to identity, and the geometry takes
 * `kept⁻¹ · full`, so the Object drawing it under `kept` draws exactly what it drew before, for every
 * mask. The bake used to put only the applied band into the verts and then reset all three bands,
 * which moved and reshaped the object on Location, Rotation or Scale alone (measured: every partial
 * mask, off by up to 4 units) — and a rotation applied under a non-uniform scale that stays on the
 * Object cannot be kept by baking the band alone at all. Blender keeps the world shape exactly in
 * both cases (measured on 5.1.1).
 *
 * `null` when a kept scale is zero: `kept` has no inverse, so the rest of the pose cannot be taken
 * back out of the geometry.
 *
 * `full` is the pose as a matrix, and defaults to `transform`'s TRS. #1108 passes it explicitly for
 * an imported child whose pose carries the chain it drew under, which is not always a TRS (a
 * rotation under a parent's non-uniform scale shears): the bands come from its decomposition and
 * whatever a TRS cannot hold goes into the geometry, so the world shape stays exact.
 */
function splitAppliedPose(
  transform: MeshTransform,
  mask: ApplyMask,
  full: THREE.Matrix4 = trsMatrix(transform),
): { readonly matrix: THREE.Matrix4; readonly kept: MeshTransform } | null {
  const kept = { ...transform };
  for (const band of APPLIED_BANDS[mask]) kept[band] = [...IDENTITY_BAND[band]];
  const keptMatrix = trsMatrix(kept);
  if (keptMatrix.determinant() === 0) return null;
  return { matrix: keptMatrix.invert().multiply(full), kept };
}

/** The refusal every road gives when {@link splitAppliedPose} has no inverse to take. */
function zeroKeptScaleReason(selectedId: string): string {
  return `Apply: "${selectedId}" keeps a zero scale on an axis, so the rest of its transform cannot be taken back out of the mesh. Give every axis a non-zero scale first.`;
}

/**
 * #1080 — reverse every triangle's winding in place, for a baked matrix that mirrors. three flips
 * its front face only while an Object's OWN matrix mirrors; once the mirror is in the verts and the
 * Object no longer carries it, the unchanged winding draws every face inside-out (measured: all 12
 * of a box's triangles). The first corner stays where it was, as Blender keeps it and as the
 * stored-mesh road does.
 *
 * Through the component accessors rather than `.array`, so an interleaved attribute off a glTF
 * clone reverses the same way a plain one does.
 */
function reverseTriangleWinding(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const second = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, second);
    }
    index.needsUpdate = true;
    return;
  }
  const get = ['getX', 'getY', 'getZ', 'getW'] as const;
  const set = ['setX', 'setY', 'setZ', 'setW'] as const;
  for (const attribute of Object.values(geometry.attributes)) {
    for (let i = 0; i + 2 < attribute.count; i += 3) {
      for (let k = 0; k < attribute.itemSize; k++) {
        const second = attribute[get[k]](i + 1);
        attribute[set[k]](i + 1, attribute[get[k]](i + 2));
        attribute[set[k]](i + 2, second);
      }
    }
    if ('needsUpdate' in attribute) attribute.needsUpdate = true;
  }
}

/** Build a BakedMaterialSpec from a primitive's inline material (M6 — null maps). */
function bakedSpecFromInline(material: InlineMaterialSpec | null): BakedMaterialSpec {
  return {
    materialClass: 'standard',
    // Primitives expose color only; the remaining scalars are FROZEN at the values
    // the pre-#178 renderer used when no override was present. This used to cite
    // `SceneFromDAG.applyOverride`'s no-override branch; #394 S3b deleted that
    // branch as unreachable, so these are a bake-time snapshot of a historical
    // look, not a mirror of anything live. Changing them re-bakes differently.
    // v0.6 #2 (#178): the inline color now lives at base.color (OpenPBR IR).
    color: material?.base.color ?? '#ffffff',
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    transparent: false,
    emissive: '#000000',
    emissiveIntensity: 0,
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  };
}

/**
 * Narrow the resolved mesh material to the baked spec (#376). An `Object`'s data node
 * hands back `InlineMaterialSpec | BakedMaterialSpec | null` — a spec that is ALREADY
 * baked (it carries `materialClass`) passes through verbatim rather than being funnelled
 * through the inline converter, which would read `.base.color` off a shape that has none
 * and silently flatten the material to white.
 */
function bakedSpecFromMeshMaterial(
  material: InlineMaterialSpec | BakedMaterialSpec | null,
): BakedMaterialSpec {
  if (material && 'materialClass' in material) return material;
  return bakedSpecFromInline(material);
}

/**
 * Why this Apply must be refused when the mesh assigns more than one material, or `null`
 * when it assigns one (the whole population today).
 *
 * #634 — a bake collapses a mesh to ONE material spec. Flattening a two-material mesh into
 * its lowest slot would be data loss with better manners: nothing errors, the object keeps
 * rendering, and the second material is simply gone from a file the director now believes is
 * saved. Refusing by name is the honest answer, and it names the ATTRIBUTE so the message
 * points at the thing to change rather than at the operation that stopped.
 *
 * Exported because it is the decision, not the plumbing: the real resolver cannot yet
 * produce a multi-material mesh, so this is the only seam a test can hand one to.
 */
export function multiMaterialBakeRefusal(
  selectedId: string,
  materials: EvaluatedMesh['materials'],
): string | null {
  const assigned = assignedMaterials(materials);
  if (assigned.length <= 1) return null;
  return `Apply: "${selectedId}" assigns ${assigned.length} materials across its faces (material_index), and a bake carries one. Reduce it to a single material first.`;
}

/**
 * Why this Apply must be refused when the geometry it would bake carries attributes the baked
 * store cannot hold, or `null` when it holds all of them (#1119).
 *
 * A third refusal of the same family as {@link multiMaterialBakeRefusal}: the bake would drop a
 * colour layer, a second UV set or skin weights with nothing said, and the object would keep
 * rendering from a file the director believes is saved. It names the attributes so the message
 * says what would be lost. Asked of the SOURCE geometry, before it is cloned or written.
 *
 * Stored mesh data never reaches this: it is applied into, which keeps every corner layer. What
 * reaches it is an import still drawn from the file's own copy, and it becomes unreachable when
 * those import natively.
 */
export function unheldAttributesBakeRefusal(
  selectedId: string,
  geometry: THREE.BufferGeometry,
): string | null {
  const unheld = unheldBakeAttributes(geometry);
  if (unheld.length === 0) return null;
  const pronoun = unheld.length === 1 ? 'it' : 'them';
  return `Apply: "${selectedId}" carries ${unheld.join(', ')}, which a baked mesh has no place to keep, so Apply would drop ${pronoun}. Apply stays unavailable on it until the import comes across as native mesh data.`;
}

/**
 * Why this Apply must be refused when the material that would be baked is one we never
 * captured, or `null` when there is nothing uncaptured to lose (#605 item 2).
 *
 * ── THE SIBLING REFUSAL, AND WHY IT IS A SECOND ONE RATHER THAN A WIDER FIRST ────────────
 *
 * {@link multiMaterialBakeRefusal} stops a bake from flattening TWO materials into one. This
 * stops it from flattening ONE material into NONE, and the two are different failures with the
 * same manners: nothing errors, the object keeps rendering, and a material is simply gone from
 * a file the director now believes is saved. Kept separate because the messages must be —
 * "reduce it to a single material" is useless advice for a mesh whose one material is fine and
 * merely unreadable from here.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────────────────────
 *
 * `primaryMaterial` answers `null` for BOTH a genuinely materialless mesh and a clone-drawn one,
 * because its return type has no room for the difference — the collapse `absentSlot` exists to
 * end, still standing at the one consumer where it costs something. Observed on two assignments
 * differing ONLY in where their buffers live:
 *
 *     absentSlot           none -> "none"        elsewhere -> "elsewhere"    told apart
 *     slotMaterialAt(0)    none -> none          elsewhere -> elsewhere      told apart
 *     primaryMaterial      none -> null          elsewhere -> null           INDISTINGUISHABLE
 *     the bake at :412     null                  null                        INDISTINGUISHABLE
 *
 * So an Apply over an imported mesh wrote a baked spec with no material where the asset clone
 * has one on screen. The refusal is keyed through {@link slotMaterialAt}, not off
 * `absentSlot` directly: `absentSlot` says what an absence WOULD mean, and a clone-backed mesh
 * whose material we DID capture must still bake fine.
 *
 * 🔑 THIS REFUSAL IS DISTANCE FROM THE GOAL, AND IT SHOULD ONE DAY BE UNREACHABLE. `elsewhere`
 * exists only because an imported mesh's material lives in an asset clone instead of on the
 * mesh. In both reference systems the importer reads the material and puts it ON the geometry,
 * so the question never arises — a format fills the model and stops existing. When that holds
 * here, nothing can construct an `elsewhere` assignment and this function returns `null` for
 * every input. Refusing honestly is the interim; it is not the destination.
 */
export function uncapturedMaterialBakeRefusal(
  selectedId: string,
  materials: EvaluatedMesh['materials'],
): string | null {
  // Slot 0 is the one the bake carries — `primaryMaterial` narrows to it, and the
  // multi-material refusal above has already stopped anything with more than one assigned.
  if (slotMaterialAt(materials, 0).status !== 'elsewhere') return null;
  return `Apply: "${selectedId}" draws with a material owned by its imported asset, and we hold no capture of it. Baking would write a mesh with no material where one is on screen. Give the slot a material of its own first.`;
}

/**
 * The data node this Object poses, when retiring the Object should retire it too (#376).
 *
 * Returns null when there is no linked data node, or when the data node is SHARED — a
 * fan-out `BoxData` posed by a second Object must survive this bake, or the sibling
 * renders empty. Sharing is counted over real graph edges, so the check stays honest as
 * fan-out lands (#391).
 */
function exclusiveDataNodeOf(state: DagState, objectId: string): string | null {
  const dataId = linkedDataNodeId(state, objectId);
  if (!dataId) return null;
  const consumers = consumerEdgesOf(state, dataId);
  return consumers.length <= 1 ? dataId : null;
}

/** Find every consumer edge of `nodeId`.out, capturing socket + list index. */
interface ConsumerEdge {
  consumer: string;
  socket: string;
  /** Index within the consumer's list binding (or undefined for single). */
  index: number | undefined;
}
function consumerEdgesOf(state: DagState, nodeId: string): ConsumerEdge[] {
  const edges: ConsumerEdge[] = [];
  for (const consumer of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      if (Array.isArray(binding)) {
        binding.forEach((ref, i) => {
          if (ref.node === nodeId && ref.socket === 'out') {
            edges.push({ consumer: consumer.id, socket, index: i });
          }
        });
      } else if (binding.node === nodeId && binding.socket === 'out') {
        edges.push({ consumer: consumer.id, socket, index: undefined });
      }
    }
  }
  return edges;
}

let bakedCounter = 0;
/**
 * A fresh baked id. Since #412 this is the glTF-CHILD path only — the primitive/`Object`
 * path inherits the applied node's id instead. A GltfChild id is an import artifact on an
 * edge-less satellite node, so handing it to a standalone BakedMesh would risk colliding
 * with the same child on a later re-import; that path keeps minting deliberately.
 */
/**
 * A free id for the BakedData half of a baked pair. Mirrors the load migration's
 * `freshDataId` spelling (`<object>__data`, then `__data1`, `__data2`, …) so the two
 * roads that mint this pair — Apply and the v7 → v8 migration — produce the same-shaped
 * ids. Nothing ADDRESSES the data half by name (every consumer reaches it through the
 * `data` edge), so this is a readability contract, not a lookup key.
 */
function freshDataIdFor(state: DagState, objectId: string): string {
  let id = `${objectId}__data`;
  let n = 1;
  while (state.nodes[id]) id = `${objectId}__data${n++}`;
  return id;
}

function nextBakedId(state: DagState): string {
  // Deterministic-enough fresh id; loop until unused (collisions are vanishing).
  let id: string;
  do {
    id = `baked_${Date.now().toString(36)}_${bakedCounter++}`;
  } while (state.nodes[id]);
  return id;
}

/**
 * The node types Apply admits before asking the resolver. This is an ADMISSION filter, not
 * a capability test — the resolver below is what actually decides whether something is a
 * mesh. Kept in one function so the dispatcher's gate and the UI predicate share it rather
 * than each spelling the types out (the drift that #377/#406 are about).
 */
function isBakeableWrapperType(type: string): boolean {
  // #384 Stage C — the fused SphereMesh disjunct is gone; a sphere is a split Object now, so
  // Apply-Transform admits only `Object` and bakes through the Object+data path (#376/#377).
  return type === 'Object';
}

/** Whether a node IS a mesh does not vary with time, so a zero ctx is exact for the
 *  offer-side predicate below (the bake itself still resolves at the current frame). */
const ZERO_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/**
 * Can Apply-Transform bake `nodeId`? THE one predicate the two UI surfaces consume, so an
 * OFFERED Apply and an ACCEPTED Apply cannot disagree (the render==read boundary-pair by
 * construction, instead of three type lists kept in sync by hand).
 *
 * #376 follow-up: admitting every `Object` by type alone left the menu item and the NPanel
 * control ENABLED for an Empty, which then failed with an internal-sounding "could not
 * resolve mesh". Asking the shared resolver here is exact — an Object whose `data` is not
 * MeshData (an Empty today; a camera/light data node in a later phase) is correctly not
 * offered, with no capability list to keep updated.
 *
 * Mesh-ness does not vary with time, so a zero ctx is exact for this question.
 */
export function canApplyTransform(state: DagState, nodeId: string): boolean {
  const node = state.nodes[nodeId];
  if (!node || !isBakeableWrapperType(node.type)) return false;
  return resolveEvaluatedMesh(state, nodeId, ZERO_CTX) !== null;
}

/**
 * Apply the (masked) transform of a Box/Sphere into baked geometry, swapping the
 * node for a BakedMesh in one atomic, undoable composite. Returns the baked id —
 * since #412 that is the SAME id the applied node had (see step 4), so callers that
 * held the id keep a valid handle and every id-keyed reference to it still resolves.
 *
 * The `deps` arg is optional: production omits it and the live stores +
 * getStorage() + timeStore + selectionStore are used; tests inject mocks.
 */
export async function dispatchApplyTransform(
  selectedId: string,
  mask: ApplyMask = 'all',
  deps?: Partial<ApplyDeps>,
): Promise<DispatchResult> {
  const dagStore = useDagStore.getState();
  const state = deps?.state ?? dagStore.state;
  const currentFrame = deps?.currentFrame ?? useTimeStore.getState().frame;

  const node = state.nodes[selectedId];
  if (!node) return { ok: false, reason: `Apply: node "${selectedId}" not found.` };

  // The glTF-child path (the R-1 edge-less satellite) is materially different —
  // source geometry/material live inside the live render clone, and the asset
  // must suppress the child by name. It has its own dispatcher below.
  if (isImportedChild(state.nodes, selectedId)) {
    return dispatchApplyGltfChild(
      selectedId,
      mask,
      state,
      currentFrame,
      deps,
      dagStore.dispatchAtomic.bind(dagStore),
    );
  }

  // #376: a split `Object` bakes alongside the still-fused `SphereMesh`. The gate stays
  // TYPE-based rather than probing for mesh-ish params — an `Object` whose `data` is not
  // MeshData (an Empty, or a camera/light data node in a later phase) resolves to a null
  // mesh at step 1 below and is rejected there, so this admits by type and lets the ONE
  // resolver decide what is actually a mesh (no second capability list to drift — #377).
  if (!isBakeableWrapperType(node.type)) {
    return {
      ok: false,
      reason: `Apply: "${node.type}" is not a bakeable mesh.`,
    };
  }

  // Animated guard (D-04) — the dispatch-side belt.
  if (isApplySourceAnimated(state, selectedId, currentFrame)) {
    return { ok: false, reason: ANIMATED_MSG };
  }

  // 1 — resolve the transform (sync). The masked bands compose into the matrix.
  const ctx: EvalCtx = {
    time: { frame: currentFrame, seconds: currentFrame / 60, normalized: 0 },
  };
  const mesh = resolveEvaluatedMesh(state, selectedId, ctx);
  if (!mesh) return { ok: false, reason: `Apply: could not resolve mesh "${selectedId}".` };

  // #1077 — stored mesh data is applied INTO, never baked. `applyRoadOf` makes that call, and the
  // animated guard above read the same call to decide what to ask (#1081 / #1098).
  const road = applyRoadOf(state, selectedId);
  if (road.kind === 'into-stored-mesh') {
    return applyIntoStoredMesh(selectedId, road.dataId, road.mesh, mesh.transform, mask, state, {
      dispatchAtomic: deps?.dispatchAtomic ?? dagStore.dispatchAtomic.bind(dagStore),
      clearTransients:
        deps?.clearTransients ?? ((id: string) => useTransientEditStore.getState().clearNode(id)),
      setSelection: deps?.setSelection ?? ((id: string) => useSelectionStore.getState().select(id)),
    });
  }

  // #1080 — the geometry takes `kept⁻¹ · full`, and the Object keeps every band not applied.
  const split = splitAppliedPose(mesh.transform, mask);
  if (!split) return { ok: false, reason: zeroKeptScaleReason(selectedId) };

  // 2 — clone the SHARED registry geometry before baking (H45).
  const src = getForRead(mesh.geometry);
  if (!src) return { ok: false, reason: `Apply: geometry not in registry for "${selectedId}".` };
  const unheld = unheldAttributesBakeRefusal(selectedId, src);
  if (unheld) return { ok: false, reason: unheld };
  const baked = src.clone();
  baked.applyMatrix4(split.matrix);
  if (split.matrix.determinant() < 0) reverseTriangleWinding(baked);
  // Rotation/scale change the surface orientation — recompute vertex normals so
  // lighting stays correct. A location-only Apply bakes a pure translation (`kept⁻¹ · full`
  // conjugates the translation by the kept bands), which leaves normals untouched.
  if (mask !== 'location') baked.computeVertexNormals();

  // 3 — persist the baked bytes to OPFS (async, AWAITED before the Op composite).
  const storage = deps?.storage ?? (await getStorage());
  const bakedRef = await writeBakedGeometry(storage, baked);
  baked.dispose(); // the cloned CPU buffer is now in OPFS + (on load) the registry

  // 4 — atomic Op composite (Q1). The BakedMesh INHERITS the applied node's id (#412):
  // vacate the id, then re-occupy it. Everything keyed by node id therefore survives the
  // bake for free — a constraint `target`/`aimNode`, a driver `target`, an NLA `Strip`,
  // and every id-keyed field added later. The rejected alternative was a re-target sweep
  // over each of those params, which is a hand-maintained list of cases: the shape that
  // has silently stopped covering the world every time we have relied on it (#411 was one).
  // This is also the rule the object↔data split already chose — the load migration has the
  // Object inherit the fused node's id for exactly this reason (§5 id-stability).
  const bakedId = selectedId;
  const refusal = multiMaterialBakeRefusal(selectedId, mesh.materials);
  if (refusal) return { ok: false, reason: refusal };
  // Order matters and is not arbitrary: the multi-material refusal runs FIRST, so by the time
  // this asks about slot 0 there is at most one assigned material and slot 0 is the one the
  // bake carries. Reversed, a two-material clone-drawn mesh would be told about the wrong one.
  const uncaptured = uncapturedMaterialBakeRefusal(selectedId, mesh.materials);
  if (uncaptured) return { ok: false, reason: uncaptured };
  const spec = bakedSpecFromMeshMaterial(primaryMaterial(mesh.materials));

  // ASCENDING by list index: the edges are replayed after the node is re-added, and
  // `connect` splice-INSERTS at min(index, len). Removing our bindings shifts the
  // surviving siblings down, so re-inserting at the original indices in ascending order
  // lands every sibling back where it started. Out of order, the later insert would be
  // clamped short and sibling order would silently change (#259/H140 — the same property
  // the old connect-before-disconnect pass existed to protect, preserved by replay
  // ordering now that the id is inherited rather than fresh).
  const consumerEdges = consumerEdgesOf(state, selectedId).sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );

  // 4a — VACATE the id. `addNode` refuses an id that already exists and `removeNode`
  // refuses a still-consumed node, so inheritance forces disconnect-before-remove — the
  // INVERSE of the old ordering. Per-op validation only (no whole-graph invariant runs
  // mid-composite), so the transiently-unbound socket between 4a and 4b is legal.
  const ops: Op[] = [];
  for (const edge of consumerEdges) {
    ops.push({
      type: 'disconnect',
      from: { node: selectedId, socket: 'out' },
      to: { node: edge.consumer, socket: edge.socket },
    });
  }
  ops.push({ type: 'removeNode', nodeId: selectedId });
  // #376 — retire the PAIR. The pose baked into the geometry, so the Object goes; its
  // data node has to go with it or it is left orphaned in the graph (no consumer, still
  // saved). Guarded by exclusivity: a SHARED data node is posed by another Object too,
  // and removing it would empty that sibling. Ordered AFTER the Object's removeNode so
  // the `data` edge is already gone when the data node is dropped.
  const retiredDataId = node.type === 'Object' ? exclusiveDataNodeOf(state, selectedId) : null;
  if (retiredDataId) ops.push({ type: 'removeNode', nodeId: retiredDataId });
  // 4b — RE-OCCUPY it with the baked PAIR, then replay the consumer edges onto it.
  //
  // #388 C5 — Apply used to mint a FUSED `BakedMesh` here, which made this the last
  // producer in the codebase that took a split pair apart and handed back a node
  // carrying both a transform and its own geometry. It now mints the pair the load
  // migration already produces for every saved baked mesh, so the two roads agree and
  // an in-session bake and a reloaded one are the same shape.
  //
  // The OBJECT inherits the id, exactly as it does in the migration and for the same
  // reason: everything keyed by node id (a constraint `target`, a driver, an NLA strip,
  // the consumer edges replayed below, the user's `meta.name`) survives the bake for
  // free. The BakedData takes a fresh id and holds only what the buffer owns.
  const bakedDataId = freshDataIdFor(state, bakedId);
  ops.push({
    type: 'addNode',
    nodeId: bakedDataId,
    nodeType: 'BakedData',
    params: { geometry: bakedRef, material: spec },
  });
  ops.push({
    type: 'addNode',
    nodeId: bakedId,
    nodeType: 'Object',
    // #1080 — the KEPT pose: the applied bands are in the verts and read identity here, and
    // every band not applied stays exactly as it was. Written explicitly, never defaulted.
    params: {
      position: split.kept.position,
      ...keptRotationParamsOf(node.params as RotationModeFields, split.kept.rotation),
      scale: split.kept.scale,
    },
  });
  ops.push({
    type: 'connect',
    from: { node: bakedDataId, socket: 'out' },
    to: { node: bakedId, socket: 'data' },
  });
  // Carry the user's NAME across. `meta` lives on the node, so removeNode drops it and
  // the fresh BakedMesh would fall back to `node.id` as its label — an object named "Hero"
  // would show up as a raw id after a bake. That was survivable while the bake minted a
  // new node ("it is a different node"), but the id is inherited now: the same identity
  // keeping its constraints and edges while silently losing its name is incoherent, and
  // meta is identity data by the op's own account. BakedMesh has no `name` param, so the
  // meta override is the only place this can live.
  const inheritedName = node.meta?.name;
  if (inheritedName !== undefined) {
    ops.push({ type: 'setMeta', nodeId: bakedId, name: inheritedName });
  }
  for (const edge of consumerEdges) {
    const consumerType = state.nodes[edge.consumer].type;
    const isList = requireNodeType(consumerType).inputs[edge.socket]?.cardinality === 'list';
    ops.push({
      type: 'connect',
      from: { node: bakedId, socket: 'out' },
      to: { node: edge.consumer, socket: edge.socket },
      ...(isList && edge.index !== undefined ? { index: edge.index } : {}),
    });
  }

  const dispatchAtomic = deps?.dispatchAtomic ?? dagStore.dispatchAtomic.bind(dagStore);
  try {
    dispatchAtomic(ops, 'user', `Apply ${mask} → bake ${node.type}`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  // 5 — drop any HELD (un-keyed) edit on the retired nodes. A transient is keyed by
  // `${nodeId}|${paramPath}` in a module-level store that ONLY a frame change clears —
  // not selection, not undo. While the bake minted a fresh id this was unreachable: the
  // stale key named a removed node, so every lookup missed. With the id inherited the
  // key now HITS, and `resolveEvaluatedParam` gives a transient unconditional priority
  // with no type check — so the inspector, the gizmo and the world-transform read would
  // report a pre-bake offset while the viewport draws the baked mesh at the origin. That
  // is precisely the render/read divergence the transient band exists to prevent.
  //
  // Reachable because the transient OUTLIVES the animation that allowed it: hold an edit
  // on an animated node, undo the channel (undo does not touch the frame, so the edit
  // survives), and the node is now static enough for the animated guard to admit it.
  const clearTransients =
    deps?.clearTransients ?? ((id: string) => useTransientEditStore.getState().clearNode(id));
  clearTransients(selectedId);
  if (retiredDataId) clearTransients(retiredDataId);

  // Move selection to the new baked node.
  const setSelection =
    deps?.setSelection ?? ((id: string) => useSelectionStore.getState().select(id));
  setSelection(bakedId);

  return { ok: true, bakedId };
}

/** The Object params each Apply mask resets, and the identity each one resets to. */
const APPLIED_BANDS: Readonly<Record<ApplyMask, ReadonlyArray<'position' | 'rotation' | 'scale'>>> =
  {
    all: ['position', 'rotation', 'scale'],
    location: ['position'],
    rotation: ['rotation'],
    scale: ['scale'],
  };
const IDENTITY_BAND = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

/**
 * #1153 — the rotation params of a node Apply re-mints from its KEPT pose. The mode survives the
 * bake, as it does in Blender (Apply resets values, never `rotmode`): a quaternion-mode Object
 * comes back in quaternion mode holding the kept orientation (identity when rotation was the
 * band applied), written through the same path every writer takes.
 */
function keptRotationParamsOf(
  params: RotationModeFields,
  kept: Vec3,
): { rotation: Vec3; rotationMode?: 'quaternion'; quaternion?: Quat } {
  const write = rotationWriteOf(params, kept);
  if (write.paramPath === 'rotation') return { rotation: kept };
  return { rotation: kept, rotationMode: 'quaternion', quaternion: write.value };
}

/**
 * #1153 — applying rotation resets the quaternion too. Blender clears the euler AND the
 * quaternion when it applies rotation, whatever the mode (`object_transform.cc:1062-1066`), so
 * a quaternion-mode Object comes out of Apply at identity rather than re-applying its old turn
 * on top of the baked mesh. Written only when the node holds one: an absent quaternion is the
 * identity already, and writing it would change an euler node's saved shape.
 */
function quaternionResetFor(
  state: DagState,
  nodeId: string,
  applied: ReadonlyArray<'position' | 'rotation' | 'scale'>,
): Op[] {
  if (!applied.includes('rotation')) return [];
  const params = (state.nodes[nodeId]?.params ?? {}) as { quaternion?: unknown };
  if (params.quaternion === undefined) return [];
  return [{ type: 'setParam', nodeId, paramPath: 'quaternion', value: [...IDENTITY_QUATERNION] }];
}

/** T·R·S from a resolved transform (degrees, Euler XYZ), the order the renderer draws with. */
function trsMatrix(t: { position: Vec3; rotation: Vec3; scale: Vec3 }): THREE.Matrix4 {
  const D2R = Math.PI / 180;
  const [rx, ry, rz] = t.rotation;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, 'XYZ')),
    new THREE.Vector3(...t.scale),
  );
}

/**
 * A stored mesh with `matrix` applied to its points and corner normals. Every array is a COPY: the
 * decoded arrays are cached on the packed object (`unpackMeshData`), and undo puts that same object
 * back, so arrays written in place would draw the posed mesh under unposed strings after Cmd+Z.
 *
 * Corner layers (#1117) — UV sets and colours — are not spatial quantities, so the matrix does not
 * touch their values. Every layer is copied, and it moves with its corner when the corners reorder.
 *
 * A matrix with a negative determinant mirrors the mesh, which turns every face inside out. Each
 * face's corners are reversed with its FIRST corner kept, as Blender does on Apply (measured on
 * 5.1.1: loop `[0,1,3,2]` → `[0,2,3,1]`, normals still outward). Keeping the first corner keeps the
 * fan triangulation's diagonal where it was.
 */
function transformMeshData(data: MeshGeometryData, matrix: THREE.Matrix4): MeshGeometryData {
  const v = new THREE.Vector3();
  const points = new Float32Array(data.points.length);
  for (let i = 0; i < points.length; i += 3) {
    v.fromArray(data.points, i).applyMatrix4(matrix).toArray(points, i);
  }
  let cornerNormals: Float32Array | null = null;
  if (data.cornerNormals !== null) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    cornerNormals = new Float32Array(data.cornerNormals.length);
    for (let i = 0; i < cornerNormals.length; i += 3) {
      v.fromArray(data.cornerNormals, i)
        .applyMatrix3(normalMatrix)
        .normalize()
        .toArray(cornerNormals, i);
    }
  }
  const corners = data.cornerPoints.length;
  const cornerPoints = new Uint32Array(data.cornerPoints);
  const cornerLayers = data.cornerLayers.map((layer) => ({
    ...layer,
    data: new Float32Array(layer.data),
  }));
  if (matrix.determinant() < 0) {
    const reversedPoints = new Uint32Array(cornerPoints);
    // A layer's width is its length per corner: the data check has already tied the two together.
    const reversedLayers = cornerLayers.map((layer) => ({
      values: layer.data.slice(),
      width: corners === 0 ? 0 : layer.data.length / corners,
    }));
    const normals = cornerNormals?.slice() ?? null;
    let start = 0;
    for (const size of data.faceSizes) {
      for (let k = 1; k < size; k++) {
        const from = start + size - k; // corner k of the reversed run reads corner size-k
        const to = start + k;
        cornerPoints[to] = reversedPoints[from];
        cornerLayers.forEach((layer, i) => {
          const { values, width } = reversedLayers[i];
          layer.data.set(values.subarray(from * width, from * width + width), to * width);
        });
        if (cornerNormals !== null && normals !== null) {
          cornerNormals.set(normals.subarray(from * 3, from * 3 + 3), to * 3);
        }
      }
      start += size;
    }
  }
  return {
    points,
    faceSizes: new Uint32Array(data.faceSizes),
    cornerPoints,
    cornerLayers,
    cornerNormals,
  };
}

/**
 * Apply over an Object whose data is a stored mesh (#1077): the pose goes INTO that mesh data, and
 * the Object keeps posing it. Nothing is baked and nothing is converted.
 *
 * ── WHY NOT THE BAKE ROAD ─────────────────────────────────────────────────────────────────
 *
 * The bake re-expresses the material as a `BakedMaterialSpec`, which has no field for an alpha
 * cutoff, double-siding, vertex colours, per-map UV placement or UV sets, all of which an import
 * writes. It kept only the base colour and lost the rest with nothing saying so. And a baked mesh
 * answers none of the questions a stored mesh answers (`importedMeshParity.gate.test.ts`: 6 of 6
 * against 0 of 6), so baking an import would turn it back into the thing the import stopped being.
 * Blender does neither: after Apply the object points at the SAME Mesh datablock with the SAME
 * material, verts moved (measured on 4.5.9 and 5.1.1). This function never reads the material,
 * which is the whole of how it cannot lose one.
 *
 * ── WHAT IS WRITTEN INTO THE VERTS ─────────────────────────────────────────────────────────
 *
 * `kept⁻¹ · full`, where `full` is the resolved pose and `kept` is that pose with the applied bands
 * set to identity. The drawn world shape is therefore unchanged for every mask, including a rotation
 * applied under a non-uniform scale that stays on the Object, where the rotation alone would shear
 * the result. Blender keeps the world shape exactly in that case (measured: max vertex deviation 0).
 *
 * ── WITH OPERATORS ON THE STACK ───────────────────────────────────────────────────────────
 *
 * `dataId` is the BASE of the data lane, so modifiers and material operators stacked between it and
 * the Object stay exactly where they are and now read the applied mesh. The world shape above is
 * then a promise about the mesh, not about every modifier's result: an operator with an offset in
 * object units reads that offset against the new verts. Blender behaves the same (measured on
 * 5.1.1: Apply Scale under an Array modifier succeeds and keeps it; a constant offset changes the
 * drawn width 5.0 → 3.5, a relative offset keeps 4.0).
 *
 * Refused when anything along the lane feeds a second consumer (Blender: "Cannot apply to a multi
 * user"), because that consumer would change too, and when a kept scale is zero, because `kept`
 * has no inverse.
 */
function applyIntoStoredMesh(
  selectedId: string,
  dataId: string,
  packed: PackedMeshData,
  transform: MeshTransform,
  mask: ApplyMask,
  state: DagState,
  io: Pick<ApplyDeps, 'dispatchAtomic' | 'clearTransients' | 'setSelection'>,
): DispatchResult {
  // Walk UP from the mesh data to this Object: every step must have exactly one consumer. A second
  // consumer at the base is a second Object posing the mesh; one higher is a second Object wearing a
  // shared operator's result. Either way it would change with this Apply.
  const seen = new Set<string>();
  for (let cur = dataId; cur !== selectedId; ) {
    const edges = consumerEdgesOf(state, cur);
    if (edges.length !== 1 || seen.has(cur)) {
      const others = Math.max(edges.length - 1, 0);
      return {
        ok: false,
        reason: `Apply: "${selectedId}" shares its mesh data with ${others} other consumer${others === 1 ? '' : 's'} (at "${cur}"), and applying would change what they draw too. Give it its own copy of the mesh first.`,
      };
    }
    seen.add(cur);
    cur = edges[0].consumer;
  }
  const applied = APPLIED_BANDS[mask];
  const split = splitAppliedPose(transform, mask);
  if (!split) return { ok: false, reason: zeroKeptScaleReason(selectedId) };
  const next = transformMeshData(unpackMeshData(packed), split.matrix);

  const ops: Op[] = [
    { type: 'setParam', nodeId: dataId, paramPath: 'mesh', value: packMeshData(next) },
    ...applied.map(
      (band): Op => ({
        type: 'setParam',
        nodeId: selectedId,
        paramPath: band,
        value: [...IDENTITY_BAND[band]],
      }),
    ),
    ...quaternionResetFor(state, selectedId, applied),
  ];
  try {
    io.dispatchAtomic(ops, 'user', `Apply ${mask} → mesh data`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  // A held edit would otherwise outrank the identity just written — see step 5 of the bake road.
  io.clearTransients(selectedId);
  io.clearTransients(dataId);
  io.setSelection(selectedId);
  return { ok: true, bakedId: selectedId };
}

/**
 * Is the owning GltfAsset's active TransformClip driving `childName`? (D-04 — the
 * clip-driven half of the animated guard, on top of the keyframe-channel check.)
 * A clip-driven child has a non-identity sampled track for its name at the live
 * time, so baking a single static pose would silently freeze the animation.
 */
function isGltfChildClipDriven(
  state: DagState,
  assetRef: string,
  childName: string,
  seconds: number,
): boolean {
  for (const n of Object.values(state.nodes)) {
    if (n.type !== 'GltfAsset') continue;
    if ((n.params as { assetRef?: unknown }).assetRef !== assetRef) continue;
    try {
      const val = evaluate(state, n.id, {
        cache: createEvaluatorCache(),
        ctx: { time: { frame: seconds * 60, seconds, normalized: 0 } },
      }).value as GltfAssetValue;
      const tracks = val.transformClip?.sample(seconds) ?? null;
      // A track keyed for THIS child means the clip animates it (resolveEvaluated
      // Transform.ts:206 reads the same `sample(seconds)[childName]`).
      if (tracks && tracks[childName]) return true;
    } catch {
      // Unevaluable asset → treat as no clip layer (the static base still bakes).
    }
    break;
  }
  return false;
}

/**
 * #1108 — where an imported child's baked Object goes, and the pose it has there.
 *
 * The child draws under a chain the DAG does not hold as nodes of its own: the glTF parent nodes
 * inside the live clone, and any wrapper between the asset and the Group or Scene that holds it.
 * The bake takes the child out of the clone, so that chain has to go somewhere. Blender says where:
 * a child whose transform is applied keeps its parent, and nothing moves (measured on 5.1.1). The
 * nearest node here that holds children is the import's Group, so the baked Object is wired there,
 * and its pose is the child's pose RELATIVE TO that holder — `wrappers · clone parents · child` —
 * which the holder keeps drawing its own transform over, exactly as it did over the asset. It used
 * to go to the scene root with the child's own pose alone, which moved it by the whole chain.
 *
 * When nothing sits between the holder and the child, that is the child's resolved pose itself,
 * with no decomposition, so an import with a flat hierarchy bakes exactly as it did.
 *
 * It also names what it read above the child (`wrapperIds`, `cloneAncestorNames`): everything
 * there is read at the current frame and then gone from the child's chain, so the animated guard
 * asks exactly these, the same way #1081 made the guard ask what the road consumes.
 */
function importedChildPlacement(
  state: DagState,
  assetId: string,
  clone: THREE.Object3D,
  child: THREE.Object3D,
  local: MeshTransform,
  ctx: EvalCtx,
): {
  readonly holderId: string;
  readonly transform: MeshTransform;
  readonly full?: THREE.Matrix4;
  readonly wrapperIds: readonly string[];
  readonly cloneAncestorNames: readonly string[];
} | null {
  const nodes = Object.values(state.nodes);
  const parentOf = (id: string) => nodes.find((n) => hierarchyChildIds(n).includes(id));
  const assetParent = parentOf(assetId);
  const wrapperIds: string[] = [];
  let holder = assetParent;
  while (holder && hierarchySocketForKind(holder.type, holder) !== 'children') {
    wrapperIds.push(holder.id);
    holder = parentOf(holder.id);
  }
  const sceneId = state.outputs.scene?.node;
  const holderId = holder?.id ?? sceneId;
  if (!holderId) return null;

  // Wrappers between the holder and the asset (a Transform, a MaterialOverride): the holder's world
  // taken back out of the asset's parent world. Imports wire the asset straight into its Group, so
  // this is identity without asking the resolver.
  const between = new THREE.Matrix4();
  if (assetParent && assetParent.id !== holderId) {
    const assetParentWorld = resolveParentWorldMatrix(state, assetId, ctx) ?? new THREE.Matrix4();
    const holderWorld = holderId === sceneId ? null : resolveWorldTransform(state, holderId, ctx);
    const holderMatrix = holderWorld
      ? new THREE.Matrix4().fromArray(holderWorld.matrix)
      : new THREE.Matrix4();
    between.copy(holderMatrix.invert().multiply(assetParentWorld));
  }

  // The clone's own chain above the child, up to and including the clone root, as drawn.
  const parents = new THREE.Matrix4();
  const cloneAncestorNames: string[] = [];
  for (let o = child.parent; o; o = o.parent) {
    parents.premultiply(new THREE.Matrix4().compose(o.position, o.quaternion, o.scale));
    if (o.name) cloneAncestorNames.push(o.name);
    if (o === clone) break;
  }

  const above = between.multiply(parents);
  if (above.equals(new THREE.Matrix4())) {
    return { holderId, transform: local, wrapperIds, cloneAncestorNames };
  }
  const full = above.multiply(trsMatrix(local));
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  full.decompose(p, q, s);
  // One pose, consumed now and never interpolated against a neighbour, so the canonical
  // conversion is the right one (the #876 census's POINT_IN_TIME kind), through its one primitive.
  const [ex, ey, ez] = quaternionToEulerVec3(q);
  const deg = THREE.MathUtils.radToDeg;
  return {
    holderId,
    transform: {
      ...local,
      position: [p.x, p.y, p.z],
      rotation: [deg(ex), deg(ey), deg(ez)],
      scale: [s.x, s.y, s.z],
    },
    full,
    wrapperIds,
    cloneAncestorNames,
  };
}

/**
 * #1108 follow-up — the first thing above an imported child whose animation the bake would freeze,
 * or `null` when nothing above it animates.
 *
 * {@link importedChildPlacement} reads the wrappers and the clone's parent nodes at the current
 * frame, and the baked Object no longer draws under either, so any motion there would stop at that
 * frame (measured: a clip track or a baked channel on the glTF parent left the bake 4 units off
 * the drawn mesh one second later). The holder is not asked: the bake is wired under it and keeps
 * following it. Each ancestor is asked the questions the child is asked for itself: a keyframe
 * channel on its node (a baked channel targets the same node), and a clip track for its name.
 */
function animatedAncestorOfImportedChild(
  state: DagState,
  asset: { readonly params?: unknown },
  placement: {
    readonly wrapperIds: readonly string[];
    readonly cloneAncestorNames: readonly string[];
  },
  assetRef: string,
  currentFrame: number,
): string | null {
  const seconds = currentFrame / 60;
  for (const id of placement.wrapperIds) {
    if (isApplySourceAnimated(state, id, currentFrame)) return id;
  }
  const nameMap = (asset.params as { nodeNameMap?: Record<string, string> }).nodeNameMap ?? {};
  for (const name of placement.cloneAncestorNames) {
    // By the mapped id alone: a baked channel is drawn by `nodeNameMap` membership, whether or not
    // the node it names has a satellite in the graph.
    const nodeId = nameMap[name];
    if (nodeId && isApplySourceAnimated(state, nodeId, currentFrame)) return name;
    if (isGltfChildClipDriven(state, assetRef, name, seconds)) return name;
  }
  return null;
}

/**
 * Apply a glTF child's (masked) RESOLVED transform into a standalone BakedMesh,
 * capturing its resolved geometry + full PBR material off the LIVE render clone
 * (bake-what-renders, H58/H59), persisting both to OPFS, and — in the SAME atomic
 * composite — removing the GltfChild node and suppressing the source render by
 * name so the child renders exactly ONCE. One proposeAndAccept = one Cmd+Z.
 *
 * Lifecycle (ORDERED): resolve(sync) → read clone geom+material(sync) →
 *   clone+matrix(sync) → OPFS writes geom + textures (async, ALL awaited) →
 *   atomic Op composite (addNode + connect + removeNode + setParam, sync).
 */
async function dispatchApplyGltfChild(
  selectedId: string,
  mask: ApplyMask,
  state: DagState,
  currentFrame: number,
  deps: Partial<ApplyDeps> | undefined,
  liveDispatchAtomic: (ops: Op[], source?: OpSource, description?: string) => unknown,
): Promise<DispatchResult> {
  const imported = importedChildOf(state.nodes, selectedId);
  if (!imported) {
    return {
      ok: false,
      reason: `Apply: imported child "${selectedId}" missing assetRef/childName.`,
    };
  }
  const { assetRef, childName } = imported;
  const seconds = currentFrame / 60;

  // Animated guard (D-04) — keyframe channels on the child node OR a clip track
  // for this child on the owning asset. Either means the transform is animated;
  // baking a single static pose would freeze it.
  if (
    isApplySourceAnimated(state, selectedId, currentFrame) ||
    isGltfChildClipDriven(state, assetRef, childName, seconds)
  ) {
    return { ok: false, reason: ANIMATED_MSG };
  }

  // 1 — resolve the STATIC transform via the ONE band (Q6). resolveEvaluatedMesh's
  // GltfChild path funnels through resolveGltfChildTrs (manual → base; clip/baked
  // are the animated layers, barred by the guard). Compose the masked matrix.
  const ctx: EvalCtx = {
    time: { frame: currentFrame, seconds, normalized: 0 },
  };
  const mesh = resolveEvaluatedMesh(state, selectedId, ctx);
  if (!mesh) return { ok: false, reason: `Apply: could not resolve GltfChild "${selectedId}".` };

  // 2 — read source geometry + RESOLVED material off the LIVE render clone (Q4 —
  // registry.get returns null for gltf). The clone is the post-override render
  // state (H58/H59 bake-what-renders), accessed via the production-safe registry.
  const clone = deps?.gltfClone ?? getGltfClone(assetRef);
  if (!clone) {
    return {
      ok: false,
      reason: `Apply: glTF asset "${assetRef}" is not currently rendered (no live clone).`,
    };
  }
  const child = clone.getObjectByName(childName) as THREE.Mesh | undefined;
  if (!child || !(child as THREE.Mesh).isMesh || !child.geometry) {
    return { ok: false, reason: `Apply: child "${childName}" is not a renderable mesh.` };
  }

  // The owning GltfAsset node (to append the suppression key on it, and to find what holds it).
  const asset = Object.values(state.nodes).find(
    (n) => n.type === 'GltfAsset' && (n.params as { assetRef?: unknown }).assetRef === assetRef,
  );
  if (!asset) return { ok: false, reason: `Apply: owning GltfAsset for "${assetRef}" not found.` };

  // #1108 — the pose relative to the Group the child drew under, and that Group as the new parent.
  const placement = importedChildPlacement(state, asset.id, clone, child, mesh.transform, ctx);
  if (!placement) return { ok: false, reason: 'Apply: project has no `scene` output.' };
  const animatedAncestor = animatedAncestorOfImportedChild(
    state,
    asset,
    placement,
    assetRef,
    currentFrame,
  );
  if (animatedAncestor) {
    return {
      ok: false,
      reason: `Apply unavailable — "${animatedAncestor}", which "${childName}" draws under, is animated, and the bake would freeze it.`,
    };
  }
  // #1080 — the same split as every road: `kept⁻¹ · full` into the verts, `kept` on the Object.
  const split = splitAppliedPose(placement.transform, mask, placement.full);
  if (!split) return { ok: false, reason: zeroKeptScaleReason(selectedId) };

  const unheld = unheldAttributesBakeRefusal(selectedId, child.geometry);
  if (unheld) return { ok: false, reason: unheld };

  // H45 — clone the SHARED clone geometry before baking; mutating it would corrupt
  // every other instance/child sharing the buffer.
  const baked = child.geometry.clone();
  baked.applyMatrix4(split.matrix);
  if (split.matrix.determinant() < 0) reverseTriangleWinding(baked);
  if (mask !== 'location') baked.computeVertexNormals();

  // 3 — persist baked geometry + every texture map to OPFS (async, ALL AWAITED
  // before the Op composite so a reload right after Apply finds the bytes).
  const storage = deps?.storage ?? (await getStorage());
  const bakedRef = await writeBakedGeometry(storage, baked);
  baked.dispose();

  // Capture the RESOLVED material (M2 — post-override, read-only H45/M9). A child
  // may carry a Material[] (multi-primitive); bake the first (one-child-one-bake
  // for #151; multi-material merge is a later concern). Textures persist inside.
  const liveMat = Array.isArray(child.material) ? child.material[0] : child.material;
  if (!liveMat) return { ok: false, reason: `Apply: child "${childName}" has no material.` };
  const spec = await captureBakedMaterial(storage, liveMat);

  // 4 — atomic Op composite (Q1, the R-1 edge-less satellite collapses to):
  //   addNode BakedMesh + connect into Scene.children + removeNode GltfChild +
  //   setParam GltfAsset.suppressedChildren (append childName). ONE Cmd+Z.
  const prevSuppressed = Array.isArray(
    (asset.params as { suppressedChildren?: unknown }).suppressedChildren,
  )
    ? ((asset.params as { suppressedChildren: string[] }).suppressedChildren as string[])
    : [];

  const dataId = importedChildDataId(state.nodes, selectedId);
  const bakedId = nextBakedId(state);
  // #388 C5 — mints the PAIR, like the primitive road above and like the load migration.
  // Unlike that road there is no id to inherit: a glTF child is not a scene node, so the
  // bake introduces a genuinely new object and both halves take fresh ids.
  const bakedDataId = freshDataIdFor(state, bakedId);
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: bakedDataId,
      nodeType: 'BakedData',
      params: { geometry: bakedRef, material: spec },
    },
    {
      type: 'addNode',
      nodeId: bakedId,
      nodeType: 'Object',
      // #1080 — the KEPT pose, as on the primitive bake: applied bands identity, the rest unchanged.
      params: {
        position: split.kept.position,
        rotation: split.kept.rotation,
        scale: split.kept.scale,
      },
    },
    {
      type: 'connect',
      from: { node: bakedDataId, socket: 'out' },
      to: { node: bakedId, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: bakedId, socket: 'out' },
      to: { node: placement.holderId, socket: 'children' },
    },
    { type: 'removeNode', nodeId: selectedId },
    // #389 — the DATA half goes too. The apply collapses the imported child into a fresh
    // baked pair, so leaving `GltfData` behind would strand an inputless node describing a
    // child that has been suppressed on its own asset: invisible in the outliner (nothing
    // walks a bare data node), still resolving a geometry ref into a clone, and impossible
    // to select or delete. The fused kind was ONE node, so this line had no counterpart.
    ...(dataId ? [{ type: 'removeNode' as const, nodeId: dataId }] : []),
    {
      type: 'setParam',
      nodeId: asset.id,
      paramPath: 'suppressedChildren',
      value: [...prevSuppressed, childName],
    },
  ];

  const dispatchAtomic = deps?.dispatchAtomic ?? liveDispatchAtomic;
  try {
    dispatchAtomic(ops, 'user', `Apply ${mask} → bake glTF child ${childName}`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const setSelection =
    deps?.setSelection ?? ((id: string) => useSelectionStore.getState().select(id));
  setSelection(bakedId);

  return { ok: true, bakedId };
}
