// resolveEvaluatedMesh — project EVERY mesh-producing kind into ONE `EvaluatedMesh`
// (v0.6 #1, issue #150). The kinds are named at their branches rather than here: the
// fused mesh producers this header used to list (BoxMesh, SphereMesh, BakedMesh) are all
// retired, and each is now read as a split `Object` reaching through its data node, which
// is the one shape the list kept failing to keep up with. The single producer
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
  BakedMaterialSpec,
  EvaluatedMesh,
  GeometryRef,
  InlineMaterialSpec,
  MaterialAssignment,
  MeshDataValue,
  MeshTransform,
  ObjectData,
  ObjectValue,
  Vec3,
} from '../nodes/types';
import { modifierDataSource } from './modifierDataSource';
import { isModifierNode, resolveStackObject } from './operatorStack';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { materialAssignmentOf, materialSlotsOf } from './materialAssignment';
import { resolveGltfChildTrs } from './resolveGltfChildTransform';
import { readMeshUVs } from './uvAttributes';

const IDENTITY_SCALE: Vec3 = [1, 1, 1];

/** No slot table and no per-face index — the answer for a road with no data half yet. */
const EMPTY_ASSIGNMENT: MaterialAssignment<InlineMaterialSpec | BakedMaterialSpec | null> = {
  slots: [],
  indices: null,
};

/** The pose of a modifier chain nothing wears yet — a dangling stack has no Object to
 *  take one from, and inventing the source's would re-fuse what the split separated. */
const IDENTITY_TRANSFORM: MeshTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: IDENTITY_SCALE,
};

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
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
 * The `MeshData` → `EvaluatedMesh` projection, exported because it is the ONE place a
 * mesh data value becomes a read face — and because it is the only way a test can hand the
 * read side a value the real population cannot yet produce (a mesh assigning two materials
 * across its faces). A projection nothing can call with a synthetic input is a projection
 * whose interesting cases are unreachable.
 */
export function evaluatedMeshFromMeshData(
  data: MeshDataValue,
  transform: MeshTransform,
): EvaluatedMesh {
  // #634 — resolved THROUGH the attribute system rather than read off the sibling field.
  // The data node's IR is the object's slot TABLE; the geometry's face attribute says which
  // slot each face uses. With every face on slot 0 this is byte-identically `data.material`,
  // which is the point: the read path moved first, while the answers still agreed.
  const materials = materialAssignmentOf(data.attributeKey, materialSlotsOf(data));
  const uvRead = readMeshUVs(data.geometry);
  return {
    geometry: data.geometry,
    uvRead,
    // The WHOLE assignment: the object's slot table paired with the geometry's per-face
    // index into it. Nothing is collapsed here — a consumer that can only carry one
    // material opts into `primaryMaterial` at its own call site, where the narrowing is
    // visible, rather than being handed a narrowed value it cannot tell from a full one.
    materials,
    transform,
  };
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

    // glTF has no data half to carry a slot table — its materials live on the loaded
    // clone (#389). An EMPTY table is the honest answer: not "one slot holding nothing".
    const gltfUvs = readMeshUVs(geometry);
    return {
      geometry,
      uvRead: gltfUvs,
      materials: EMPTY_ASSIGNMENT,
      transform,
    };
  }

  // #388 — the fused `node.type === 'BakedMesh'` branch was HERE, and it is gone with the
  // node it read. A retired kind must not keep a working read road: `BakedMesh.evaluate`
  // now throws, so a node that somehow reached this resolver would have been ANSWERED on
  // the read side (gizmo, inspector, UV projection) while the render side refused it —
  // the read/render disagreement the split exists to prevent, with nothing failing. A
  // baked mesh is resolved by the `node.type === 'Object'` branch below, through its
  // `BakedData`. Same removal the two earlier mesh kinds got at their own retirements
  // (`a27155c` BoxMesh, `c6ffeee` SphereMesh) — this was the last one still standing.

  if (isModifierNode(node)) {
    // SOP / modifier (epic #201, #209) — the read-side branch for a selected operator
    // (its geometry drives the UV editor, the inspector and the #209 boundary-pair
    // seam). One branch now serves BOTH modifiers, where there used to be a
    // per-modifier copy.
    //
    // #415 REPLACED THE RECURSION, and it was not optional. The old branch resolved
    // `inputs.target` by recursing into this same resolver and inherited the source's
    // TRANSFORM from the result. On the data lane `target` names a DATA node — and a
    // data node has no transform to report, by construction, which is the entire point
    // of the split. There is no honest `EvaluatedMesh` to recurse into, so the source
    // is read from the modifier's OWN evaluated value (`ModifiedDataValue`, or the
    // passthrough its source hands back when muted or non-mesh) and the pose is taken
    // from the OBJECT that wears the stack — the only node in the chain that has one.
    //
    // Reading this node's own evaluated value is also what keeps the two roads in one
    // band (H40): the geometry handle here is byte-identically the handle the renderer
    // draws, rather than a hand-rebuilt twin that has to be kept in step. Mute-bypass,
    // param defaults and non-mesh passthrough all come from the node's `evaluate`, so
    // they cannot answer differently on this road either.
    const value = evaluate(state, selectedId, { ctx, cache }).value as ObjectData | undefined;
    if (!value) return null; // unwired — nothing to modify
    const source = modifierDataSource(value);
    if (!source) return null; // non-mesh data passed through (curve/light/camera)
    // The pose is the wearing Object's own animated band — resolved through the SAME
    // Object branch below, so a modified mesh and its object can never disagree about
    // where they are. A dangling chain (nothing wears it yet) has no pose at all.
    const objectId = resolveStackObject(state, selectedId);
    const transform = objectId
      ? (resolveEvaluatedMesh(state, objectId, ctx, cache)?.transform ?? IDENTITY_TRANSFORM)
      : IDENTITY_TRANSFORM;
    const modifierMaterials = materialAssignmentOf(null, [source.material]);
    const modifierUvs = readMeshUVs(source.geometry);
    return {
      geometry: source.geometry,
      // The modified geometry is SYNC-buildable (box/sphere data), so its UVs (the
      // merged source islands) come from the SAME registry path as Box/Sphere (#209 UV
      // follow-up). Baked data is not sync-buildable → the registry misses → null.
      uvRead: modifierUvs,
      materials: modifierMaterials,
      transform,
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
    if (!value || !data) return null; // an Empty / not an Object
    // ⚠️ THIS WAS `data.kind !== 'MeshData'`. An inequality guard is already TOTAL, so
    // widening `ObjectData` could never redden it and `BakedData` was absorbed here in
    // silence — with the wrong answer, since a baked mesh IS a mesh face. Spelled as an
    // exhaustive switch, the next data kind (glTF, #389) is a compile error instead.
    if (data.kind === 'CurveData' || data.kind === 'LightData' || data.kind === 'CameraData') {
      return null; // not a mesh face
    }
    // The pose is the Object's own band (the same evaluated walk the primitives
    // use — animation/constraints/channels overlay it, V57); fall back to the
    // value's static TRS when the Object isn't in the rendered scene to walk.
    const transform = resolvePrimitiveTransform(state, selectedId, ctx, cache, {
      position: value.position,
      rotation: value.rotation,
      scale: isVec3(value.scale) ? value.scale : IDENTITY_SCALE, // C-1 hydrate guard
    });
    if (data.kind === 'BakedData') {
      // #388 — the Object half of a baked pair, and now the ONLY road a baked mesh is
      // read on. Everything the buffer owns passes through verbatim, exactly as the
      // retired fused branch did: the handle is already authoritative (OPFS,
      // content-hashed), the material is the captured spec, and `uvs` is null because a
      // baked ref is not sync-buildable from the registry. Only the TRANSFORM differs
      // from the fused shape, and it differs the way every split kind's does — resolved
      // through the Object's own animated band rather than read off raw params.
      const bakedMaterials = materialAssignmentOf(null, [data.material]);
      const bakedUvs = readMeshUVs(data.geometry);
      return {
        geometry: data.geometry,
        uvRead: bakedUvs,
        materials: bakedMaterials,
        transform,
      };
    }
    if (data.kind === 'ModifiedData') {
      // #415 — the Object half of a modifier pair. Same shape as the `MeshData` arm
      // below (the modifier's geometry IS a registry handle, so UVs resolve
      // synchronously), and the material passes verbatim into a ONE-slot table: the
      // read side's slots carry the wide Inline|Baked union that `ModifiedDataValue`
      // does, widened by #358 precisely so a baked-sourced modifier stops dropping its
      // material here.
      //
      // #638 (ns-1b step 6) — the table and the index are read through the SAME pair of
      // functions the `MeshData` arm uses, so the two roads cannot answer "what is this
      // made of" differently. Both fields are absent on every value except a partial-range
      // `SetMaterialOp`'s, and absent resolves to exactly what this arm returned before:
      // one slot, `indices: null`. The previous comment said this road "has no per-face
      // attribute yet" — it can have one now, and a synthesised array of zeros would still
      // be a lie for the roads that do not.
      const modGeometry = data.geometry;
      const modifiedMaterials = materialAssignmentOf(
        data.attributeKey ?? null,
        materialSlotsOf(data),
      );
      const modifiedUvs = readMeshUVs(modGeometry);
      return {
        geometry: modGeometry,
        uvRead: modifiedUvs,
        materials: modifiedMaterials,
        transform,
      };
    }
    const exhaustiveData: 'MeshData' = data.kind;
    void exhaustiveData;
    return evaluatedMeshFromMeshData(data, transform);
  }

  return null; // identity-null: not a mesh producer
}
