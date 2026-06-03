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
import type { DagState } from '../../core/dag/state';
import type { Op, OpSource, EvalCtx } from '../../core/dag/types';
import type { BakedMaterialSpec, InlineMaterialSpec, Vec3 } from '../../nodes/types';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import * as geometryRegistry from '../geometryRegistry';
import { writeBakedGeometry } from '../asset/bakedGeometryStore';
import { resolveEvaluatedMesh } from '../resolveEvaluatedMesh';
import { paramAnimationState } from './paramAnimationState';
import { getStorage } from '../boot';
import { useTimeStore } from '../stores/timeStore';
import { useSelectionStore } from '../stores/selectionStore';

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
  return TRS_BANDS.some((band) => paramAnimationState(state, nodeId, band, currentFrame) !== 'none');
}

/** Compose a 4×4 from the resolved TRS, including ONLY the masked band(s). */
function composeMaskedMatrix(
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 },
  mask: ApplyMask,
): THREE.Matrix4 {
  const includeLoc = mask === 'all' || mask === 'location';
  const includeRot = mask === 'all' || mask === 'rotation';
  const includeScale = mask === 'all' || mask === 'scale';

  const pos = includeLoc
    ? new THREE.Vector3(...transform.position)
    : new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion();
  if (includeRot) {
    const [rx, ry, rz] = transform.rotation;
    const D2R = Math.PI / 180; // rotation is degrees Euler XYZ (codebase convention)
    quat.setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, 'XYZ'));
  }
  const scl = includeScale
    ? new THREE.Vector3(...transform.scale)
    : new THREE.Vector3(1, 1, 1);
  return new THREE.Matrix4().compose(pos, quat, scl);
}

/** Build a BakedMaterialSpec from a primitive's inline material (M6 — null maps). */
function bakedSpecFromInline(material: InlineMaterialSpec | null): BakedMaterialSpec {
  return {
    materialClass: 'standard',
    // Primitives expose color only; the remaining scalars take the renderer's
    // un-overridden defaults (applyOverride no-override branch, SceneFromDAG).
    color: material?.color ?? '#ffffff',
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
  if (node.type !== 'BoxMesh' && node.type !== 'SphereMesh') {
    return {
      ok: false,
      reason: `Apply: "${node.type}" is not a primitive (glTF-child path is Wave 4).`,
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
  const setSelection = deps?.setSelection ?? ((id: string) => useSelectionStore.getState().select(id));
  setSelection(bakedId);

  return { ok: true, bakedId };
}
