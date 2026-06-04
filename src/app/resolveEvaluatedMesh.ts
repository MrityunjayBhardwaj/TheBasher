// resolveEvaluatedMesh — project EVERY mesh-producing kind (BoxMesh, SphereMesh,
// GltfChild) into ONE `EvaluatedMesh` (v0.6 #1, issue #150). The single producer
// the renderer, gizmo, and inspector all consume — generalizing the proven
// `resolveEvaluatedTransform` (one-producer-many-consumers) from the transform
// band to the whole mesh face.
//
// D-03 — projection layer, ZERO privileges:
//   `evaluate()` signatures are unchanged. box/sphere are projected as plain
//   meshes (no consumer branches on kind). A re-parametrizable Box is a
//   CAPABILITY, not a privilege.
//
// The ONE band, no drift (H40 / V20):
//   - box/sphere: the TRS band is the node's Op-backed params
//     (position/rotation/scale). `scale` defaults to identity ([1,1,1]) so a
//     pre-migration (Wave 2) node still resolves green (C-1 — the V10/H14 guard
//     ALSO at the evaluator + every consumer that destructures scale).
//   - GltfChild: the transform is delegated to `resolveEvaluatedTransform`
//     (which funnels through the ONE `resolveGltfChildTrs` layering primitive —
//     manual → baked → clip → base). When there is no render output to walk
//     (the bare-node case), we fall back to `resolveGltfChildTrs` directly with
//     the child's own params as base — STILL the one band, never a parallel walk.
//
// geometry is a `GeometryRef` HANDLE (deterministic key, §48) — NEVER inlined
// buffers (Ousterhout interface-depth). The registry (geometryRegistry.ts) builds
// box/sphere on demand; glTF geometry lives in the loaded asset clone (H45).
//
// REF: PLAN.md Wave 1 Task 2; CONTEXT §B/§H; RESEARCH §B; vyapti V1/V20; hetvabhasa H40.

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type {
  BakedMaterialSpec,
  EvaluatedMesh,
  GeometryRef,
  InlineMaterialSpec,
  MeshTransform,
  Vec3,
} from '../nodes/types';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveGltfChildTrs } from './resolveGltfChildTransform';

const IDENTITY_SCALE: Vec3 = [1, 1, 1];

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

function isMaterialSpec(v: unknown): v is InlineMaterialSpec {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { name?: unknown }).name === 'string' &&
    typeof (v as { color?: unknown }).color === 'string'
  );
}

/**
 * Project the selected node into ONE `EvaluatedMesh`, or null when the node is
 * not a mesh producer (identity-null — same no-crash contract as
 * `resolveEvaluatedTransform`). Pure: no store reads; the caller passes
 * `state`, `ctx`, and the optional shared evaluator `cache`.
 */
export function resolveEvaluatedMesh(
  state: DagState,
  selectedId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): EvaluatedMesh | null {
  const node = state.nodes[selectedId];
  if (!node) return null;

  if (node.type === 'BoxMesh') {
    const p = node.params as {
      size?: unknown;
      position?: unknown;
      rotation?: unknown;
      scale?: unknown;
      material?: unknown;
    };
    if (!isVec3(p.size) || !isVec3(p.position) || !isVec3(p.rotation)) return null;
    const size = p.size;
    const geometry: GeometryRef = {
      key: `box|${size[0]},${size[1]},${size[2]}`,
      kind: 'box',
      descriptor: { kind: 'box', size },
    };
    const transform: MeshTransform = {
      position: p.position,
      rotation: p.rotation,
      scale: isVec3(p.scale) ? p.scale : IDENTITY_SCALE, // C-1 hydrate guard
    };
    return {
      geometry,
      uvs: null,
      material: isMaterialSpec(p.material) ? p.material : null,
      transform,
    };
  }

  if (node.type === 'SphereMesh') {
    const p = node.params as {
      radius?: unknown;
      widthSegments?: unknown;
      heightSegments?: unknown;
      position?: unknown;
      rotation?: unknown;
      scale?: unknown;
      material?: unknown;
    };
    if (
      typeof p.radius !== 'number' ||
      typeof p.widthSegments !== 'number' ||
      typeof p.heightSegments !== 'number' ||
      !isVec3(p.position) ||
      !isVec3(p.rotation)
    ) {
      return null;
    }
    const geometry: GeometryRef = {
      key: `sphere|${p.radius}|${p.widthSegments}|${p.heightSegments}`,
      kind: 'sphere',
      descriptor: {
        kind: 'sphere',
        radius: p.radius,
        widthSegments: p.widthSegments,
        heightSegments: p.heightSegments,
      },
    };
    const transform: MeshTransform = {
      position: p.position,
      rotation: p.rotation,
      scale: isVec3(p.scale) ? p.scale : IDENTITY_SCALE, // C-1 hydrate guard
    };
    return {
      geometry,
      uvs: null,
      material: isMaterialSpec(p.material) ? p.material : null,
      transform,
    };
  }

  if (node.type === 'GltfChild') {
    const p = node.params as {
      assetRef?: unknown;
      childName?: unknown;
      position?: unknown;
      rotation?: unknown;
      scale?: unknown;
      overridden?: { position: boolean; rotation: boolean; scale: boolean };
    };
    if (
      typeof p.assetRef !== 'string' ||
      typeof p.childName !== 'string' ||
      !isVec3(p.position) ||
      !isVec3(p.rotation) ||
      !isVec3(p.scale) ||
      !p.overridden
    ) {
      return null;
    }
    const geometry: GeometryRef = {
      key: `gltf|${p.assetRef}|${p.childName}`,
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: p.assetRef, childName: p.childName },
    };

    // Transform via the ONE band. Prefer the full evaluated walk
    // (resolveEvaluatedTransform → resolveGltfChildTrs: manual → baked → clip →
    // base, the renderer's exact precedence). When there is no render output to
    // walk (bare-node case), fall back to resolveGltfChildTrs directly with the
    // child's own params as base — still the one primitive, never a parallel walk.
    const walked = resolveEvaluatedTransform(state, selectedId, ctx, cache);
    let transform: MeshTransform;
    if (walked && walked.rotation && walked.scale) {
      transform = { position: walked.position, rotation: walked.rotation, scale: walked.scale };
    } else {
      const childTrs = { position: p.position, rotation: p.rotation, scale: p.scale };
      const resolved = resolveGltfChildTrs({
        base: childTrs,
        clipTrack: undefined,
        childNode: { ...childTrs, overridden: p.overridden },
        bakedChannel: undefined,
      });
      transform = {
        position: resolved.position,
        rotation: resolved.rotation,
        scale: resolved.scale,
      };
    }

    return { geometry, uvs: null, material: null, transform };
  }

  if (node.type === 'BakedMesh') {
    // The 4th EvaluatedMesh producer (Phase 151, V29). NO parallel walk: the
    // baked GeometryRef is already authoritative (the bytes live in OPFS, keyed
    // by content hash) and the transform is identity (the TRS is baked INTO the
    // verts). Return the handle + material verbatim; the renderer (BakedMeshR)
    // loads the geometry via the suspense hook and applies identity scale (H40
    // band-drift guard — applying the node scale would double-transform).
    const p = node.params as {
      geometry?: unknown;
      position?: unknown;
      rotation?: unknown;
      scale?: unknown;
      material?: unknown;
    };
    if (!isBakedGeometryRef(p.geometry) || !isBakedMaterialSpec(p.material)) return null;
    const transform: MeshTransform = {
      position: isVec3(p.position) ? p.position : [0, 0, 0],
      rotation: isVec3(p.rotation) ? p.rotation : [0, 0, 0],
      scale: isVec3(p.scale) ? p.scale : IDENTITY_SCALE, // C-1 hydrate guard
    };
    return { geometry: p.geometry, uvs: null, material: p.material, transform };
  }

  return null; // identity-null: not a mesh producer
}

/** A `GeometryRef{kind:'baked'}` handle carried on a BakedMesh param. */
function isBakedGeometryRef(v: unknown): v is GeometryRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { kind?: unknown; key?: unknown; descriptor?: { kind?: unknown } };
  return r.kind === 'baked' && typeof r.key === 'string' && r.descriptor?.kind === 'baked';
}

/** The rich baked material spec — discriminated by `materialClass`. */
function isBakedMaterialSpec(v: unknown): v is BakedMaterialSpec {
  if (typeof v !== 'object' || v === null) return false;
  return typeof (v as { materialClass?: unknown }).materialClass === 'string';
}
