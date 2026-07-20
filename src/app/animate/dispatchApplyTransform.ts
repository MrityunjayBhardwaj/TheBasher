// dispatchApplyTransform — Apply-Transform for primitives (Phase 151 Wave 2 t5,
// issue #151). The Box/Sphere path: compose the (masked) resolved TRS into a 4×4
// matrix, bake it into a CLONE of the registry geometry, persist the baked bytes
// to OPFS, and swap the original mesh node for a new BakedMesh in ONE atomic Op
// composite (one dispatchAtomic = one Cmd+Z).
//
// THE single OPFS-write chokepoint (V20) and the single Apply Op author (V1) for
// primitives. The glTF-child path lands in Wave 4.
//
// Lifecycle (K15 extension, ORDERED):
//   1. resolve(sync) — read the resolved transform via resolveEvaluatedMesh.
//   2. clone+matrix(sync) — geometryRegistry.get(ref) returns a SHARED instance;
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
import type { Op, EvalCtx } from '../../core/dag/types';
import { requireNodeType } from '../../core/dag/registry';
import type { BakedMaterialSpec, InlineMaterialSpec, Vec3 } from '../../nodes/types';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import * as geometryRegistry from '../geometryRegistry';
import { writeBakedGeometry } from '../asset/bakedGeometryStore';
import { resolveEvaluatedMesh } from '../resolveEvaluatedMesh';
import { linkedDataNodeId } from '../resolveDataParamOwner';
import { isKeyframeChannelNode, paramAnimationState } from './paramAnimationState';
import { getStorage } from '../boot';
import { useTimeStore } from '../stores/timeStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useTransientEditStore } from '../stores/transientEditStore';
import { getGltfClone } from '../asset/gltfCloneRegistry';
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
 * the `linkedDataNodeId` reach the guard would ask the wrong node and get the
 * honest answer "nothing animated here" — the exact shape of the reach bugs the
 * split has produced repeatedly.
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
  // The Object owns the pose; the data node it points at owns geometry+material.
  // Both are consumed by the bake, so both are asked. A fused node has no `data`
  // edge and answers for itself alone.
  const subjects = [nodeId, linkedDataNodeId(state, nodeId)].filter(
    (id): id is string => id !== null,
  );
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

/** Compose a 4×4 from the resolved TRS, including ONLY the masked band(s). */
function composeMaskedMatrix(
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 },
  mask: ApplyMask,
): THREE.Matrix4 {
  const includeLoc = mask === 'all' || mask === 'location';
  const includeRot = mask === 'all' || mask === 'rotation';
  const includeScale = mask === 'all' || mask === 'scale';

  const pos = includeLoc ? new THREE.Vector3(...transform.position) : new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion();
  if (includeRot) {
    const [rx, ry, rz] = transform.rotation;
    const D2R = Math.PI / 180; // rotation is degrees Euler XYZ (codebase convention)
    quat.setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, 'XYZ'));
  }
  const scl = includeScale ? new THREE.Vector3(...transform.scale) : new THREE.Vector3(1, 1, 1);
  return new THREE.Matrix4().compose(pos, quat, scl);
}

/** Build a BakedMaterialSpec from a primitive's inline material (M6 — null maps). */
function bakedSpecFromInline(material: InlineMaterialSpec | null): BakedMaterialSpec {
  return {
    materialClass: 'standard',
    // Primitives expose color only; the remaining scalars take the renderer's
    // un-overridden defaults (applyOverride no-override branch, SceneFromDAG).
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
  return type === 'SphereMesh' || type === 'Object';
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
  if (node.type === 'GltfChild') {
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
  const matrix = composeMaskedMatrix(mesh.transform, mask);

  // 2 — clone the SHARED registry geometry before baking (H45).
  const src = geometryRegistry.get(mesh.geometry);
  if (!src) return { ok: false, reason: `Apply: geometry not in registry for "${selectedId}".` };
  const baked = src.clone();
  baked.applyMatrix4(matrix);
  // Rotation/scale change the surface orientation — recompute vertex normals so
  // lighting stays correct (translation-only bakes leave normals untouched).
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
  const spec = bakedSpecFromMeshMaterial(mesh.material);

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
  // 4b — RE-OCCUPY it with the baked node, then replay the consumer edges onto it.
  ops.push({
    type: 'addNode',
    nodeId: bakedId,
    nodeType: 'BakedMesh',
    params: {
      geometry: bakedRef,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: spec,
    },
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
  const node = state.nodes[selectedId];
  const p = node.params as { assetRef?: unknown; childName?: unknown };
  if (typeof p.assetRef !== 'string' || typeof p.childName !== 'string') {
    return { ok: false, reason: `Apply: GltfChild "${selectedId}" missing assetRef/childName.` };
  }
  const assetRef = p.assetRef;
  const childName = p.childName;
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
  const matrix = composeMaskedMatrix(mesh.transform, mask);

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

  // H45 — clone the SHARED clone geometry before baking; mutating it would corrupt
  // every other instance/child sharing the buffer.
  const baked = child.geometry.clone();
  baked.applyMatrix4(matrix);
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
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return { ok: false, reason: 'Apply: project has no `scene` output.' };

  // The owning GltfAsset node (to append the suppression key on it).
  const asset = Object.values(state.nodes).find(
    (n) => n.type === 'GltfAsset' && (n.params as { assetRef?: unknown }).assetRef === assetRef,
  );
  if (!asset) return { ok: false, reason: `Apply: owning GltfAsset for "${assetRef}" not found.` };
  const prevSuppressed = Array.isArray(
    (asset.params as { suppressedChildren?: unknown }).suppressedChildren,
  )
    ? ((asset.params as { suppressedChildren: string[] }).suppressedChildren as string[])
    : [];

  const bakedId = nextBakedId(state);
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: bakedId,
      nodeType: 'BakedMesh',
      params: {
        geometry: bakedRef,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        material: spec,
      },
    },
    {
      type: 'connect',
      from: { node: bakedId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'children' },
    },
    { type: 'removeNode', nodeId: selectedId },
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
