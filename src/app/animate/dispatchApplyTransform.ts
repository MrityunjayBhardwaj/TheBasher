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
//   4. Op composite(sync) — addNode BakedMesh; for each consumer edge,
//      connect-before-disconnect (preserves sibling order); removeNode original.
//
// Animated guard (D-04): if any TRS band is keyframed, reject — the dispatch-side
// belt (the UI also disables). Apply available iff position/rotation/scale all
// read 'none' from paramAnimationState.
//
// REF: PLAN.md Wave 2 Task 5; RESEARCH §Q1/§M6; hetvabhasa H45; vyapti V1/V20;
//      bakedGeometryStore.ts (writeBakedGeometry); dispatchMutator.ts (atomic pattern).

import * as THREE from 'three';
import { useDagStore } from '../../core/dag/store';
import type { OpSource } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import type { Op, EvalCtx } from '../../core/dag/types';
import type { BakedMaterialSpec, InlineMaterialSpec, Vec3 } from '../../nodes/types';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import * as geometryRegistry from '../geometryRegistry';
import { writeBakedGeometry } from '../asset/bakedGeometryStore';
import { resolveEvaluatedMesh } from '../resolveEvaluatedMesh';
import { paramAnimationState } from './paramAnimationState';
import { getStorage } from '../boot';
import { useTimeStore } from '../stores/timeStore';
import { useSelectionStore } from '../stores/selectionStore';
import { getGltfClone } from '../asset/gltfCloneRegistry';
import { captureBakedMaterial } from './captureBakedMaterial';
import { evaluate, createEvaluatorCache } from '../../core/dag/evaluator';
import type { GltfAssetValue } from '../../nodes/types';

export type ApplyMask = 'all' | 'location' | 'rotation' | 'scale';

export type DispatchResult = { ok: true; bakedId: string } | { ok: false; reason: string };

/** The TRS bands present in the project (the animated-guard checks these). */
const TRS_BANDS = ['position', 'rotation', 'scale'] as const;

/** Injectable dependencies — production wires the live stores; tests inject mocks. */
export interface ApplyDeps {
  state: DagState;
  storage: StorageCapability;
  currentFrame: number;
  dispatchAtomic: (ops: Op[], source?: OpSource, description?: string) => unknown;
  setSelection: (id: string) => void;
  /** glTF-child path only — the live render clone (tests inject a fake Group;
   *  production reads it from the live-clone registry by assetRef). */
  gltfClone: THREE.Group;
}

const ANIMATED_MSG = 'Apply unavailable — transform is animated (#153/#149)';

/**
 * True when the node has a keyframe channel driving ANY TRS band (D-04). Apply is
 * available iff this returns false for all of position/rotation/scale.
 */
export function isTransformAnimated(
  state: DagState,
  nodeId: string,
  currentFrame: number,
): boolean {
  return TRS_BANDS.some(
    (band) => paramAnimationState(state, nodeId, band, currentFrame) !== 'none',
  );
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
function nextBakedId(state: DagState): string {
  // Deterministic-enough fresh id; loop until unused (collisions are vanishing).
  let id: string;
  do {
    id = `baked_${Date.now().toString(36)}_${bakedCounter++}`;
  } while (state.nodes[id]);
  return id;
}

/**
 * Apply the (masked) transform of a Box/Sphere into baked geometry, swapping the
 * node for a BakedMesh in one atomic, undoable composite. Returns the new id.
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

  if (node.type !== 'BoxMesh' && node.type !== 'SphereMesh') {
    return {
      ok: false,
      reason: `Apply: "${node.type}" is not a bakeable mesh.`,
    };
  }

  // Animated guard (D-04) — the dispatch-side belt.
  if (isTransformAnimated(state, selectedId, currentFrame)) {
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

  // 4 — atomic Op composite (Q1): addNode → connect-before-disconnect → removeNode.
  const bakedId = nextBakedId(state);
  const spec = bakedSpecFromInline(mesh.material as InlineMaterialSpec | null);
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
  ];
  for (const edge of consumerEdgesOf(state, selectedId)) {
    // connect-before-disconnect: insert the baked node at the SAME index so
    // sibling order is preserved, THEN remove the original edge.
    ops.push({
      type: 'connect',
      from: { node: bakedId, socket: 'out' },
      to: { node: edge.consumer, socket: edge.socket },
      ...(edge.index !== undefined ? { index: edge.index } : {}),
    });
    ops.push({
      type: 'disconnect',
      from: { node: selectedId, socket: 'out' },
      to: { node: edge.consumer, socket: edge.socket },
    });
  }
  ops.push({ type: 'removeNode', nodeId: selectedId });

  const dispatchAtomic = deps?.dispatchAtomic ?? dagStore.dispatchAtomic.bind(dagStore);
  try {
    dispatchAtomic(ops, 'user', `Apply ${mask} → bake ${node.type}`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

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
    isTransformAnimated(state, selectedId, currentFrame) ||
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
