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
//   - box/sphere: the TRS band is DELEGATED to `resolveEvaluatedTransform` (#153)
//     — the same animation-tracking walk the renderer/gizmo/inspector use, which
//     overlays the free-floating direct channel (V57). When there is no render output to
//     walk (the bare-node case), we fall back to the node's own Op-backed params
//     (position/rotation/scale); `scale` defaults to identity ([1,1,1]) so a
//     pre-migration node still resolves green (C-1 — the V10/H14 guard ALSO at
//     the evaluator + every consumer that destructures scale). This closes the
//     latent H40 where a static param-read diverged from an animated render for
//     the #2/#3 (material/UV) consumers, one indirection deeper. No parallel walk.
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

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type {
  EvaluatedMesh,
  GeometryRef,
  MeshTransform,
  MirrorAxis,
  ObjectValue,
  Vec3,
} from '../nodes/types';
import { isBakedMaterialSpec } from '../nodes/materialSchema';
import { arrayGeometryRef, mirrorGeometryRef } from './modifierGeometry';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveGltfChildTrs } from './resolveGltfChildTransform';
import { get as getRegistryGeometry } from './geometryRegistry';
import { extractUVIslands } from './uvIslands';
import type { EvaluatedUVs } from '../nodes/types';

const IDENTITY_SCALE: Vec3 = [1, 1, 1];

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

// v0.6 #3 (#181, W1) — real UV islands for the SYNC producers only (A-2). The
// geometry registry builds box/sphere on demand (a few hundred verts — trivial,
// and the resolver is on-demand, never per-frame). glTF/baked geometry is ASYNC
// (asset clone / OPFS) and outside this pure sync resolver, so those branches
// return uvs:null and UVEditor resolves them itself via the SAME extractUVIslands
// (A-3). Mirrors the existing material:null-for-glTF contract.
function resolveRegistryUVs(geometry: GeometryRef): EvaluatedUVs | null {
  const g = getRegistryGeometry(geometry);
  return g ? extractUVIslands(g) : null;
}

/**
 * The primitive (Box/Sphere) transform band (#153). Prefer the full evaluated
 * walk (`resolveEvaluatedTransform` overlays the free-floating direct channel, V57 — the
 * renderer's exact, animation-tracking transform). When there is no render output
 * to walk (the bare-node case — node not in the rendered scene), fall back to the
 * node's own Op-backed params. Mirrors the GltfChild branch; never a parallel walk.
 * Closes the latent H40 where a static param-read diverged from an animated render.
 */
function resolvePrimitiveTransform(
  state: DagState,
  selectedId: string,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
  raw: MeshTransform,
): MeshTransform {
  const walked = resolveEvaluatedTransform(state, selectedId, ctx, cache);
  if (walked && walked.rotation && walked.scale) {
    return { position: walked.position, rotation: walked.rotation, scale: walked.scale };
  }
  return raw;
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

  // #365 Phase 5a / #384 Stage C: the fused `BoxMesh` AND `SphereMesh` branches are gone — a
  // box/sphere is a split Object, resolved by the `node.type === 'Object'` branch below (reach
  // through `data` to the BoxData/SphereData).

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

  if (node.type === 'ArrayModifier') {
    // SOP / modifier (epic #201, #209) — the RECURSIVE read-side branch, the
    // parity twin of `ArrayModifier.evaluate`. Resolve the SOURCE mesh (the node
    // wired into `inputs.target`) the same way the renderer evaluates it, then
    // wrap its geometry in the `array` descriptor through the SAME
    // `arrayGeometryRef` the evaluate path uses → identical deterministic key on
    // both roads (H40 one band, no drift). The modifier INHERITS the source's
    // transform + material (geometry is modified in local space; the source's TRS
    // positions the whole result). A muted modifier returns the source verbatim.
    const binding = node.inputs.target;
    if (!binding || Array.isArray(binding)) return null;
    const source = resolveEvaluatedMesh(state, binding.node, ctx, cache);
    if (!source) return null; // unwired / non-leaf-mesh source — nothing to modify
    const muted = (node.params as { muted?: unknown }).muted === true;
    if (muted) return source; // mute-bypass (V58): identity passthrough
    const p = node.params as { count?: unknown; offset?: unknown };
    const count = typeof p.count === 'number' ? p.count : 3;
    const offset: Vec3 = isVec3(p.offset) ? p.offset : [2, 0, 0];
    const geometry = arrayGeometryRef(source.geometry, count, offset);
    return {
      geometry,
      // The modified geometry is SYNC-buildable (a box/sphere source), so its UVs
      // (the merged source islands) come from the SAME registry path as Box/Sphere
      // (#209 UV follow-up). A glTF/baked source still resolves to null upstream.
      uvs: resolveRegistryUVs(geometry),
      material: source.material,
      transform: source.transform,
    };
  }

  if (node.type === 'MirrorModifier') {
    // SOP / modifier (epic #201, #209) — the RECURSIVE read-side branch, the parity
    // twin of `MirrorModifier.evaluate` (identical shape to the ArrayModifier branch
    // above). Resolve the SOURCE mesh the same way the renderer evaluates it, then
    // wrap its geometry in the `mirror` descriptor through the SAME `mirrorGeometryRef`
    // the evaluate path uses → identical deterministic key on both roads (H40, no
    // drift). A muted modifier returns the source verbatim.
    const binding = node.inputs.target;
    if (!binding || Array.isArray(binding)) return null;
    const source = resolveEvaluatedMesh(state, binding.node, ctx, cache);
    if (!source) return null; // unwired / non-leaf-mesh source — nothing to modify
    const muted = (node.params as { muted?: unknown }).muted === true;
    if (muted) return source; // mute-bypass (V58): identity passthrough
    const p = node.params as { axis?: unknown; offset?: unknown };
    const axis: MirrorAxis = p.axis === 'y' || p.axis === 'z' ? p.axis : 'x';
    const offset = typeof p.offset === 'number' ? p.offset : 0;
    const geometry = mirrorGeometryRef(source.geometry, axis, offset);
    return {
      geometry,
      uvs: resolveRegistryUVs(geometry), // sync-buildable → real UV islands (#209 follow-up)
      material: source.material,
      transform: source.transform,
    };
  }

  if (node.type === 'Object') {
    // The object↔data split (#362): the Object owns the pose; the mesh face is
    // reached THROUGH the typed `data` socket. Evaluate the Object — its value
    // carries the resolved `data` (the SAME geometry handle + material the data
    // node built, so read-side parity with the renderer's ObjectR is by
    // construction) plus the Object's own TRS. `data: null` is an Empty → no mesh;
    // non-mesh data (camera/light in later phases) → no mesh here either.
    const value = evaluate(state, selectedId, { ctx, cache }).value as ObjectValue | undefined;
    const data = value?.data;
    if (!value || !data || data.kind !== 'MeshData') return null;
    const geometry = data.geometry;
    // The pose is the Object's own band (the same evaluated walk the primitives
    // use — animation/constraints/channels overlay it, V57); fall back to the
    // value's static TRS when the Object isn't in the rendered scene to walk.
    const transform = resolvePrimitiveTransform(state, selectedId, ctx, cache, {
      position: value.position,
      rotation: value.rotation,
      scale: isVec3(value.scale) ? value.scale : IDENTITY_SCALE, // C-1 hydrate guard
    });
    return {
      geometry,
      uvs: resolveRegistryUVs(geometry),
      // Already a complete IR (the data node hydrated it) — pass it verbatim so the
      // read-side material is byte-identical to what ObjectR renders.
      material: data.material,
      transform,
    };
  }

  return null; // identity-null: not a mesh producer
}

/** A `GeometryRef{kind:'baked'}` handle carried on a BakedMesh param. */
function isBakedGeometryRef(v: unknown): v is GeometryRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { kind?: unknown; key?: unknown; descriptor?: { kind?: unknown } };
  return r.kind === 'baked' && typeof r.key === 'string' && r.descriptor?.kind === 'baked';
}
