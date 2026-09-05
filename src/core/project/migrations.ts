// Migration runner. v0.5 ships with no migrations registered — the runner
// itself is mandatory before the first schema bump (THESIS.md §52, V4).
//
// Two ladders run on load:
//   1. Project-format migrations: formatVersion N → N+1 over the whole file.
//   2. Per-node migrations: each node's recorded version → its registered
//      definition version, using `def.migrations[v]`.
//
// A loaded project that's already current passes through unchanged.
//
// REF: THESIS.md §52, krama K5 step 7.

import { getNodeType } from '../dag/registry';
import { normalizeRetiredParams } from './retiredLadders';
// The ONE edge walk from clip to rig, and the ONE radians→degrees helper the
// mint uses. Imported rather than re-implemented: a second copy of either would
// compare unequal for reasons that have nothing to do with authoring, and the
// walk's own header forbids a second answer to "which clip drives this bone".
// `core/project` → `app` is the direction `retiredLadders` already takes.
import { boundClipsForAsset, boneIndexOf } from '../../app/animate/boundClipsForAsset';
import type { GraphNodeLike } from '../../app/animate/boundClipsForAsset';
import { gltfChannelDagId, gltfChildDagId } from '../import/gltfImportChain';
import { radVec3ToDeg } from '../../viewport/rotation';
import type { Node } from '../dag/types';
import { PROJECT_FORMAT_VERSION, type Project } from './schema';

type FormatMigration = (raw: unknown) => unknown;

/** Ladder of project-format migrations keyed by source version. */
const formatMigrations: Record<number, FormatMigration> = {
  // v1 → v2 (#199): retire the AnimationLayer wrapper graph-wide.
  1: migrateAnimationLayers,
  // v2 → v3 (#365 Phase 5a): split each fused BoxMesh into Object + BoxData.
  2: migrateFusedBoxToSplit,
  // v3 → v4 (#384 Stage C · C1): split each fused SphereMesh into Object + SphereData.
  // A DISTINCT format version, NOT folded into the box's 2→3: a project already saved
  // at v3 (post-box-split) with a fused sphere would never re-run a 2→3 pass, so its
  // sphere would never split — a silent, permanent data loss for exactly the projects
  // most likely to exist.
  3: migrateFusedSphereToSplit,
  // v4 → v5 (#385 Stage C · C2): split each fused Curve into Object + CurveData.
  // Its OWN format version for the same reason as the sphere's: a project saved at
  // v4 (post-sphere-split) carrying a fused curve would never re-run an earlier pass.
  4: migrateFusedCurveToSplit,
  // v5 → v6 (#386 Stage C · C3): split the four posable lights into Object + LightData
  // (AmbientLight stays fused). Its OWN format version for the same reason: a project
  // saved at v5 (post-curve-split) carrying a fused light would never re-run an earlier
  // pass, so its light would never split — a silent, permanent data loss.
  5: migrateFusedLightToSplit,
  // v6 → v7 (#387 Stage C · C4): split the two fused cameras into Object + CameraData.
  // Its OWN format version for the same reason as every kind before it: a project saved
  // at v6 (post-light-split) carrying a fused camera would never re-run an earlier pass,
  // so its camera would never split — a silent, permanent data loss.
  6: migrateFusedCameraToSplit,
  // v7 → v8 (#388 Stage C · C5): split each fused BakedMesh into Object + BakedData.
  // Its OWN format version for the same reason as every kind before it: a project saved
  // at v7 (post-camera-split) carrying a fused baked mesh would never re-run an earlier
  // pass, so its baked mesh would never split — a silent, permanent data loss.
  7: migrateFusedBakedMeshToSplit,
  // v8 → v9 (#609): fold each ParamDriver's `inVec` binding onto its `in` socket.
  // Its OWN format version rather than a fold into an earlier step, for the same reason
  // every split above owns one: a project saved at v8 would never re-run an earlier
  // pass, so its driver would keep a binding on a socket that no longer exists — the
  // edge would simply vanish on load and the param would silently stop being driven.
  8: migrateDriverInVecToIn,
  // v9 → v10 (#915): drop the eager bake's unauthored per-bone channels. Its OWN
  // format version for the same reason as every step above: a project saved at v9
  // would never re-run an earlier pass, so its rig would stay frozen at the end of
  // its first cycle forever.
  9: migrateDropUnauthoredEagerChannels,
};

// ── v1 → v2: AnimationLayer retirement (#199) ──────────────────────────────
// Reverses what `addLayer` wired (addLayer.ts:88-123). For each AnimationLayer
// L wrapping target T with channels C wired into L.animation:
//   1. re-target each channel C to T (params.target = T) and FOLD L's gate/blend
//      onto it (mute/weight — the only behaviour the wrapper carried, V57 §11),
//   2. re-point every consumer edge L.out → T.out (the splice, reversed),
//   3. delete L. Its channels are now FREE-FLOATING direct channels.
// Runs on RAW JSON BEFORE ProjectSchema.parse, so the now-removed AnimationLayer
// node type is never looked up by the registry. solo / boneMask were inert
// (never filtered channels — AnimationLayer.ts:88-92) → dropped, but LOGGED when
// non-default so the loss is never silent (V38). REF: docs/UNIFICATION-DESIGN.md §4.

interface RawRef {
  node?: string;
  socket?: string;
}
interface RawNode {
  id?: string;
  type?: string;
  version?: number;
  params?: Record<string, unknown>;
  inputs?: Record<string, RawRef | RawRef[]>;
}

function asRefs(binding: RawRef | RawRef[] | undefined): RawRef[] {
  if (Array.isArray(binding)) return binding;
  return binding ? [binding] : [];
}

/** Replace any ref to `fromNode` with `toNode` (preserving the socket) in a
 *  binding, keeping the binding's single-vs-list shape. */
function remapBinding(
  binding: RawRef | RawRef[] | undefined,
  fromNode: string,
  toNode: string,
): RawRef | RawRef[] | undefined {
  if (Array.isArray(binding)) {
    return binding.map((r) => (r.node === fromNode ? { ...r, node: toNode } : r));
  }
  if (binding && binding.node === fromNode) return { ...binding, node: toNode };
  return binding;
}

export function migrateAnimationLayers(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode>; outputs?: Record<string, RawRef> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 2 };

  const layers = Object.values(nodes).filter((n) => n?.type === 'AnimationLayer');
  for (const layer of layers) {
    const layerId = layer.id;
    if (!layerId) continue;
    const targetId = asRefs(layer.inputs?.target)[0]?.node;
    const channelRefs = asRefs(layer.inputs?.animation);
    const lw = typeof layer.params?.weight === 'number' ? (layer.params.weight as number) : 1;
    const muted = layer.params?.mute === true;

    // Surface the dropped inert semantics (no silent loss, V38).
    const boneMask = layer.params?.boneMask;
    if (layer.params?.solo === true || (Array.isArray(boneMask) && boneMask.length > 0)) {
      console.warn(
        `[migrateAnimationLayers] layer "${layerId}" had solo/boneMask set; these were ` +
          `never wired (inert) and are dropped (#199). Reintroduce as per-channel solo / a ` +
          `ChannelGroup if a real need appears.`,
      );
    }

    // 1 — re-target each channel to the wrapped node + fold gate/blend on.
    for (const cref of channelRefs) {
      const ch = cref.node ? nodes[cref.node] : undefined;
      if (!ch) continue;
      ch.params = ch.params ?? {};
      if (targetId) ch.params.target = targetId;
      if (lw !== 1) ch.params.weight = lw;
      if (muted) ch.params.mute = true;
    }

    // 2 — re-point every consumer edge L.out → T.out (reverse the splice).
    if (targetId) {
      for (const n of Object.values(nodes)) {
        if (!n.inputs) continue;
        for (const socket of Object.keys(n.inputs)) {
          n.inputs[socket] = remapBinding(n.inputs[socket], layerId, targetId)!;
        }
      }
      const outputs = proj.state?.outputs;
      if (outputs) {
        for (const k of Object.keys(outputs)) {
          if (outputs[k]?.node === layerId) outputs[k] = { ...outputs[k], node: targetId };
        }
      }
    }

    // 3 — delete the layer node; its channels are now free-floating.
    delete nodes[layerId];
  }

  return { ...proj, formatVersion: 2 };
}

// ── v2 → v3: fused BoxMesh → Object + BoxData (object↔data split, #365 Ph5a) ──
// Splits each fused `BoxMesh` B into an `Object` O (owns the transform) + a fresh
// `BoxData` D (owns geometry `size` + material). O INHERITS B's id, so every
// consumer edge, channel `target`, constraint `target` and saved selection that
// named B still resolves — only `size`/`material.*` channels re-target to D (the
// §5 id-stability crux; getting it backwards silently orphans every channel).
// Each box is first normalized through BoxMesh's OWN version ladder, so an old
// node-version box (v1 no-scale, v2 {name,color} material) reaches the current v4
// shape BEFORE the split — its inline material keeps its byte-identical migrated
// look (roughness 0.5, not the new-box 0.3). Runs on RAW JSON before the schema
// parses. REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5.

/** A channel `paramPath` that addresses the DATA half (geometry/material), so its
 *  channel must follow the data node. Everything else (position/rotation/scale)
 *  stays on the inherited-id Object and needs no re-target. */
function isDataParamPath(paramPath: unknown): boolean {
  if (typeof paramPath !== 'string') return false;
  return (
    // Box geometry (the v2→v3 pass — coexisting saves still migrate through it).
    paramPath === 'size' ||
    paramPath.startsWith('size.') ||
    paramPath.startsWith('size[') ||
    // Sphere geometry (the v3→v4 pass, #384) — scalar params, no sub-paths.
    paramPath === 'radius' ||
    paramPath === 'widthSegments' ||
    paramPath === 'heightSegments' ||
    // Curve geometry (the v4→v5 pass, #385) — the control points, closure, and
    // sampling resolution all live on the CurveData half now.
    paramPath === 'points' ||
    paramPath.startsWith('points.') ||
    paramPath.startsWith('points[') ||
    paramPath === 'closed' ||
    paramPath === 'resolution' ||
    // Light shading (the v5→v6 pass, #386) — a posable light's kind + intensity/
    // colour/falloff/aim all live on the LightData half now. Bare `color`/`intensity`
    // are LIGHT-only here (a mesh material's colour is `material.base.color`, covered
    // by the `startsWith('material')` arm below); and this arm only ever fires for a
    // channel whose `target` is a FORMER LIGHT id (the caller gates on the light map),
    // so a MaterialOverride's own bare `color` channel is never mis-retargeted.
    //
    // ⚠️ THIS PREDICATE IS SHARED BY ALL FIVE SPLIT PASSES (box v2→v3, sphere v3→v4,
    // curve v4→v5, light v5→v6, camera v6→v7). Each pass gates on its OWN id map, so a
    // name added for one kind can still fire for an EARLIER kind's node if that kind
    // happens to own a param of the same name — and it would move a channel that should
    // have stayed on the Object, silently. Checked for this pass: none of BoxMesh (size),
    // SphereMesh (radius/widthSegments/heightSegments) or Curve (points/closed/
    // resolution) owns any name above (`widthSegments` ≠ `width` — these are exact
    // matches, not prefixes). The combined box+sphere+curve+light migration fixture
    // runs the earlier kinds' channels THROUGH this pass as live controls. When a SIXTH
    // kind adds its names here, re-run that check — a collision has no compiler and no
    // runtime error, only a channel that quietly stops rendering.
    paramPath === 'lightKind' ||
    paramPath === 'intensity' ||
    paramPath === 'color' ||
    paramPath === 'distance' ||
    paramPath === 'decay' ||
    paramPath === 'angle' ||
    paramPath === 'penumbra' ||
    paramPath === 'width' ||
    paramPath === 'height' ||
    paramPath === 'target' ||
    paramPath === 'lookAt' ||
    paramPath === 'tex' ||
    // Camera lens (the v6→v7 pass, #387) — the whole lens moves to the CameraData:
    // how it projects, its focal length / ortho scale, clip planes, the DoF bag, and
    // (parity-first, #387 D1) the aim params `lookAt`/`roll`. `lookAt` is already
    // listed above for the area light and wants moving for both kinds, so it needs no
    // second arm.
    //
    // COLLISION CHECK, re-run for this pass as the block above instructs. None of the
    // eleven names below is owned by ANY earlier split kind: box (`size`), sphere
    // (`radius`/`widthSegments`/`heightSegments`), curve (`points`/`closed`/
    // `resolution`), light (`lightKind`/`intensity`/`color`/`distance`/`decay`/`angle`/
    // `penumbra`/`width`/`height`/`target`/`lookAt`/`tex`), nor by the `Object` half
    // every kind produces (`position`/`rotation`/`scale`).
    //
    // ⚠️ AND THE PRECISE STATEMENT OF WHY THAT IS ENOUGH, because the obvious one is
    // wrong: a camera name CAN fire during an earlier pass. `paramPath` is free text,
    // so nothing stops a channel carrying `paramPath: 'fov'` while targeting a box —
    // and the box pass, gating only on its own id map plus this predicate, WILL move it
    // to the BoxData. That is not new with the camera: `intensity` (a light name) has
    // behaved this way for a box since #386. It is harmless for exactly one reason —
    // no earlier kind OWNS any of these names, so such a channel was already driving
    // nothing, and the re-target moves an inert channel between two halves of the same
    // subject without changing a single rendered value. The check that actually matters
    // is therefore the ownership one above; a name that an earlier kind DID own would
    // be a real, silent mis-move. Both properties are pinned in migrations.test.ts.
    paramPath === 'projection' ||
    paramPath === 'fov' ||
    paramPath === 'zoom' ||
    paramPath === 'near' ||
    paramPath === 'far' ||
    paramPath === 'sensorSize' ||
    paramPath === 'dofEnabled' ||
    paramPath === 'focusDistance' ||
    paramPath === 'fStop' ||
    paramPath === 'focusOnTarget' ||
    paramPath === 'roll' ||
    // Baked geometry (the v7→v8 pass, #388) — the OPFS handle moves to the BakedData.
    // ONE name, not two: a baked mesh's other data param is `material`, already covered
    // by the shared arm below since the box pass. (Whether a `geometry` channel is
    // MEANINGFUL is a separate question — a content-hashed buffer handle is not
    // interpolatable — but a channel naming it must still follow the param, or it
    // silently orphans instead of visibly doing nothing.)
    //
    // COLLISION CHECK, re-run for this pass as the block above instructs. `geometry` is
    // owned by exactly two node types in all of `src/nodes/` — `BakedMesh` (this pass's
    // source) and `BakedData` (its target). No earlier split kind owns it: box (`size`),
    // sphere (`radius`/`widthSegments`/`heightSegments`), curve (`points`/`closed`/
    // `resolution`), light (the shading set), camera (the lens set), nor the `Object`
    // half (`position`/`rotation`/`scale`). So the camera's argument carries unchanged:
    // an earlier pass CAN move a stray `geometry` channel off a box, and it is inert
    // because no earlier kind owns the name. ⚠️ #389 splits `GltfAsset`, which DOES own
    // a geometry-ish handle — re-run this check there rather than assuming it holds.
    paramPath === 'geometry' ||
    // Material — shared by both mesh primitives and the baked mesh (the data half owns
    // the look). A curve has no material, so a curve target never reaches this arm.
    paramPath.startsWith('material')
  );
}

/** A collision-free id for the split-off data node, derived from the box id. */
function freshDataId(nodes: Record<string, RawNode>, boxId: string): string {
  let id = `${boxId}__data`;
  let n = 1;
  while (nodes[id]) id = `${boxId}__data${n++}`;
  return id;
}

export function migrateFusedBoxToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 3 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const boxDataVersion = getNodeType('BoxData')?.version ?? 1;

  // boxId → its split-off data node id (used to re-target data-half channels).
  const dataIdByBox = new Map<string, string>();

  for (const box of Object.values(nodes)) {
    if (box?.type !== 'BoxMesh' || !box.id) continue;

    // Normalize the box through BoxMesh's OWN migration ladder first (reuse, not a
    // parallel copy), so an old-node-version box reaches the v4 shape — keeping its
    // material's byte-identical migrated look — BEFORE it is split.
    const params = normalizeRetiredParams('BoxMesh', box.version, {
      ...(box.params ?? {}),
    });

    const dataId = freshDataId(nodes, box.id);
    dataIdByBox.set(box.id, dataId);

    // The DATA half — geometry + material, no transform, no inputs.
    nodes[dataId] = {
      id: dataId,
      type: 'BoxData',
      version: boxDataVersion,
      params: { size: params.size, material: params.material },
      inputs: {},
    };

    // The OBJECT half — B converted IN PLACE (inherits the id). Owns the transform,
    // points at the data node through `data`; any pre-existing inputs are kept.
    box.type = 'Object';
    box.version = objectVersion;
    box.params = {
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
    };
    box.inputs = { ...(box.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject
  // by `params.target` (node id) + `params.paramPath`; position/rotation/scale
  // channels keep target = the box id (now the Object) and need no change.
  if (dataIdByBox.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdByBox.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 3 };
}

// ── v3 → v4: fused SphereMesh → Object + SphereData (object↔data split, #384) ──
// The exact mirror of the box split above, per-kind. Splits each fused `SphereMesh`
// S into an `Object` O (owns the transform) + a fresh `SphereData` D (owns geometry
// radius/widthSegments/heightSegments + material). O INHERITS S's id, so every
// consumer edge, channel `target`, constraint `target` and saved selection that named
// S still resolves — only radius/ws/hs/material channels re-target to D (the §5
// id-stability crux; getting it backwards silently orphans every geometry channel).
// Each sphere is first normalized through SphereMesh's OWN version ladder, so an old
// node-version sphere reaches the current v4 shape BEFORE the split — its inline
// material keeps its byte-identical migrated look. Runs on RAW JSON before the schema
// parses. REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5.
export function migrateFusedSphereToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 4 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const sphereDataVersion = getNodeType('SphereData')?.version ?? 1;

  // sphereId → its split-off data node id (used to re-target data-half channels).
  const dataIdBySphere = new Map<string, string>();

  for (const sphere of Object.values(nodes)) {
    if (sphere?.type !== 'SphereMesh' || !sphere.id) continue;

    // Normalize the sphere through SphereMesh's OWN migration ladder first (reuse, not
    // a parallel copy), so an old-node-version sphere reaches the v4 shape — keeping
    // its material's byte-identical migrated look — BEFORE it is split.
    const params = normalizeRetiredParams('SphereMesh', sphere.version, {
      ...(sphere.params ?? {}),
    });

    const dataId = freshDataId(nodes, sphere.id);
    dataIdBySphere.set(sphere.id, dataId);

    // The DATA half — geometry (radius/ws/hs) + material, no transform, no inputs.
    nodes[dataId] = {
      id: dataId,
      type: 'SphereData',
      version: sphereDataVersion,
      params: {
        radius: params.radius,
        widthSegments: params.widthSegments,
        heightSegments: params.heightSegments,
        material: params.material,
      },
      inputs: {},
    };

    // The OBJECT half — S converted IN PLACE (inherits the id). Owns the transform,
    // points at the data node through `data`; any pre-existing inputs are kept.
    sphere.type = 'Object';
    sphere.version = objectVersion;
    sphere.params = {
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
    };
    sphere.inputs = { ...(sphere.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject by
  // `params.target` (node id) + `params.paramPath`; position/rotation/scale channels
  // keep target = the sphere id (now the Object) and need no change.
  if (dataIdBySphere.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdBySphere.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 4 };
}

// ── v4 → v5: fused Curve → Object + CurveData (object↔data split, #385) ──
// The per-kind mirror of the box/sphere splits, for the FIRST non-mesh data. Splits
// each fused `Curve` C into an `Object` O (owns the transform) + a fresh `CurveData`
// D (owns the control points + closed + resolution). O INHERITS C's id, so every
// consumer edge, channel `target`, constraint `target`, FollowPath `curve` ref and
// saved curve-point selection (nodeId,pointId) that named C still resolves — only
// points/closed/resolution channels re-target to D. Each curve is first normalized
// through Curve's OWN version ladder (v1 bare-Vec3 points → v2 {id,co}), so an old
// node-version curve reaches the id'd-points shape BEFORE the split — keeping the
// stable point ids (epic #453) that the selection and #326 undo fix depend on.
// #349 (which world the points live in) is unchanged: samples stay LOCAL, the world
// seam is untouched. Runs on RAW JSON before the schema parses.
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; K23; issue #385.
export function migrateFusedCurveToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 5 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const curveDataVersion = getNodeType('CurveData')?.version ?? 1;

  // curveId → its split-off data node id (used to re-target data-half channels).
  const dataIdByCurve = new Map<string, string>();

  for (const curve of Object.values(nodes)) {
    if (curve?.type !== 'Curve' || !curve.id) continue;

    // Normalize the curve through Curve's OWN migration ladder first (reuse, not a
    // parallel copy), so a v1 bare-Vec3 curve reaches the v2 {id,co} shape — minting
    // the stable point ids — BEFORE it is split.
    const params = normalizeRetiredParams('Curve', curve.version, {
      ...(curve.params ?? {}),
    });

    const dataId = freshDataId(nodes, curve.id);
    dataIdByCurve.set(curve.id, dataId);

    // The DATA half — points + closed + resolution, no transform, no inputs. A curve
    // has no material (it is not render geometry).
    nodes[dataId] = {
      id: dataId,
      type: 'CurveData',
      version: curveDataVersion,
      params: {
        points: params.points,
        closed: params.closed,
        resolution: params.resolution,
      },
      inputs: {},
    };

    // The OBJECT half — C converted IN PLACE (inherits the id). Owns the transform,
    // points at the data node through `data`; any pre-existing inputs are kept.
    curve.type = 'Object';
    curve.version = objectVersion;
    curve.params = {
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
    };
    curve.inputs = { ...(curve.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject by
  // `params.target` (node id) + `params.paramPath`; position/rotation/scale channels
  // keep target = the curve id (now the Object) and need no change.
  if (dataIdByCurve.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdByCurve.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 5 };
}

// ── v5 → v6: fused posable lights → Object + LightData (object↔data split, #386) ──
// The per-kind mirror of the box/sphere/curve splits, for the SECOND non-mesh data and
// the FIRST PARTIAL retirement: only the FOUR posable kinds split (Directional / Point /
// Spot / Area) → an `Object` O (owns the transform) + a fresh `LightData` D (owns the
// shading — kind + intensity/colour/falloff/aim). AmbientLight is SKIPPED (ambient = a
// World datablock, only four light OBJECT types exist). O INHERITS the light's id, so
// every consumer edge, channel `target`, Track-To target, rig index-correspondence and
// saved selection still resolves — only shading channels re-target to D.
//
// One collapsed LightData schema cannot carry four different per-kind defaults, so each
// shading field is hydrated from the SOURCE KIND'S OWN zod default (Area intensity 5,
// Spot penumbra 0.1, …), NOT LightData's collapsed default — otherwise a migrated area
// light saved without an intensity would silently drop from 5 to 1 (a 5× lighting shift
// that still "looks like a light"). Ranges on LightData are the SUPERSET across kinds
// (intensity max(100)), so an existing `intensity:50` area light re-parses on load.
//
// Runs on RAW JSON before the schema parses. REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5;
// issue #386.

/** Fused light node TYPE → the LightData `lightKind` discriminator. AmbientLight is
 *  intentionally absent — it does not split. */
const LIGHT_KIND_OF: Record<string, 'Directional' | 'Point' | 'Spot' | 'Area'> = {
  DirectionalLight: 'Directional',
  PointLight: 'Point',
  SpotLight: 'Spot',
  AreaLight: 'Area',
};

/** Build a posable light's LightData param bag from its fused params, hydrating each
 *  shading field from the SOURCE KIND'S own zod default (per the file-head note).
 *  Only the kind's own subset is written; LightData's schema defaults the rest. */
function lightDataParamsFor(
  kind: 'Directional' | 'Point' | 'Spot' | 'Area',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const color = params.color ?? '#ffffff';
  switch (kind) {
    case 'Directional':
      // DirectionalLight.intensity has NO zod default (a required param) — a saved
      // project always carries it; fall back to 1 if somehow absent.
      return { lightKind: 'Directional', intensity: params.intensity ?? 1, color };
    case 'Point':
      return {
        lightKind: 'Point',
        intensity: params.intensity ?? 1,
        color,
        distance: params.distance ?? 0,
        decay: params.decay ?? 2,
      };
    case 'Spot':
      return {
        lightKind: 'Spot',
        intensity: params.intensity ?? 1,
        color,
        target: params.target ?? [0, 0, 0],
        angle: params.angle ?? Math.PI / 6,
        penumbra: params.penumbra ?? 0.1,
        distance: params.distance ?? 0,
        decay: params.decay ?? 2,
      };
    case 'Area':
      return {
        lightKind: 'Area',
        intensity: params.intensity ?? 5,
        color,
        width: params.width ?? 2,
        height: params.height ?? 2,
        lookAt: params.lookAt ?? [0, 0, 0],
        ...(params.tex !== undefined ? { tex: params.tex } : {}),
      };
  }
}

export function migrateFusedLightToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 6 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const lightDataVersion = getNodeType('LightData')?.version ?? 1;

  // lightId → its split-off data node id (used to re-target shading channels).
  const dataIdByLight = new Map<string, string>();

  for (const light of Object.values(nodes)) {
    const kind = light?.type ? LIGHT_KIND_OF[light.type] : undefined;
    // AmbientLight (and every non-light node) is skipped — it never enters the loop.
    if (!kind || !light.id) continue;

    // Normalize the light through its OWN migration ladder first (reuse, not a parallel
    // copy). All four posable kinds are v1 with no ladder steps today, but keep the
    // pattern so a future light-node version migrates BEFORE the split.
    const params = normalizeRetiredParams(light.type!, light.version, {
      ...(light.params ?? {}),
    });

    const dataId = freshDataId(nodes, light.id);
    dataIdByLight.set(light.id, dataId);

    // The DATA half — the shading, no transform, no inputs. Per-kind hydrate.
    nodes[dataId] = {
      id: dataId,
      type: 'LightData',
      version: lightDataVersion,
      params: lightDataParamsFor(kind, params),
      inputs: {},
    };

    // The OBJECT half — the light converted IN PLACE (inherits the id). Owns the
    // transform, points at the data node through `data`; any pre-existing inputs are
    // kept (constraint targets, rig membership, etc. all keyed on the inherited id).
    light.type = 'Object';
    light.version = objectVersion;
    light.params = {
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
    };
    light.inputs = { ...(light.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject by
  // `params.target` (a node-id STRING) + `params.paramPath`; a LightData's own `target`
  // is a Vec3 ARRAY, so it is skipped by the `typeof === 'string'` guard (no collision).
  // position/rotation/scale channels keep target = the light id (now the Object).
  if (dataIdByLight.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdByLight.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 6 };
}

// ── v6 → v7: fused Perspective/OrthographicCamera → Object + CameraData ────
// (object↔data split, #387 Stage C · C4)
//
// The per-kind repeat, one format version after the light's. Two fused camera NODES
// collapse into ONE `CameraData` carrying a `projection` discriminator — the same call
// the light made for its four kinds, and for the same reason: every reference model
// (Blender included) treats perspective and orthographic as one camera datablock with
// a type enum, and the two nodes already share every param but `fov`/`zoom`.
//
// The Object INHERITS the camera's id, so `scene.camera` edges, `CameraSelect.cameras`
// edges, constraint targets, saved selections and transform channels all still resolve
// — only lens/aim channels re-target to the fresh CameraData (the §5 id-stability
// crux; getting it backwards silently orphans every channel).
//
// PARITY-FIRST (#387 D1): `lookAt` and `roll` move to the CameraData with the rest of
// the lens, and the Object's `rotation` is written as identity and left UNUSED by the
// camera road. Baking aim into a quaternion is exact for a STATIC pose but NOT for an
// animated one — `rotation(t)` is a non-linear function of three independently keyed
// channels whose key times need not coincide — and every prior kind's migration met a
// byte-identity gate. The shipped LightData made the same call for the same reason.
//
// Runs on RAW JSON before the schema parses. REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5;
// src/nodes/CameraData.ts; src/nodes/cameraRecompose.ts; issue #387.

/** Fused camera node TYPE → the CameraData `projection` discriminator. */
const CAMERA_PROJECTION_OF: Record<string, 'Perspective' | 'Orthographic'> = {
  PerspectiveCamera: 'Perspective',
  OrthographicCamera: 'Orthographic',
};

/** Build a camera's CameraData param bag from its fused params, hydrating each lens
 *  field from the SOURCE KIND'S own zod default. Only the kind's own subset is
 *  written; CameraData's schema defaults the rest (an orthographic source has no DoF
 *  or sensor params at all, so those are simply absent and default on parse). */
function cameraDataParamsFor(
  projection: 'Perspective' | 'Orthographic',
  params: Record<string, unknown>,
): Record<string, unknown> {
  const aim = {
    lookAt: params.lookAt ?? [0, 0, 0],
    roll: params.roll ?? 0,
  };
  switch (projection) {
    case 'Perspective':
      return {
        projection: 'Perspective',
        // ⚠️ NO `?? 45` — and this is the ONE place the light's hydrate idiom must not
        // be copied. 45 is `DEFAULT_CAMERA_POSE.fov`: exactly what the pose road
        // returns when a read FAILS. A fallback here would make "this camera's fov
        // never arrived" indistinguishable from "this camera is framed at 45°",
        // which is precisely why `CameraData.fov` is required with no zod default.
        // The fused camera's own `fov` was itself required, so a saved project always
        // carries one; if a hand-edited file does not, the absence is carried
        // faithfully and stays loud rather than being papered over here.
        ...(params.fov !== undefined ? { fov: params.fov } : {}),
        near: params.near ?? 0.01,
        far: params.far ?? 500,
        sensorSize: params.sensorSize ?? 36,
        dofEnabled: params.dofEnabled ?? false,
        focusDistance: params.focusDistance ?? 5,
        fStop: params.fStop ?? 2.8,
        focusOnTarget: params.focusOnTarget ?? false,
        ...aim,
      };
    case 'Orthographic':
      return {
        projection: 'Orthographic',
        // D5 — the ONE invented value in this migration, in exactly one place.
        // `CameraData.fov` is required (see the note above) and an orthographic
        // source never had one. It is INERT while `projection === 'Orthographic'`
        // (the recompose reads `zoom`), and it is the value a later switch to
        // perspective would land on anyway. `addPrimitives.paramsFor` does the same.
        fov: 45,
        zoom: params.zoom ?? 50,
        near: params.near ?? 0.01,
        far: params.far ?? 500,
        ...aim,
      };
  }
}

export function migrateFusedCameraToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 7 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const cameraDataVersion = getNodeType('CameraData')?.version ?? 1;

  // cameraId → its split-off data node id (used to re-target lens/aim channels).
  const dataIdByCamera = new Map<string, string>();

  for (const camera of Object.values(nodes)) {
    const projection = camera?.type ? CAMERA_PROJECTION_OF[camera.type] : undefined;
    // Every non-camera node is skipped — it never enters the loop. An ALREADY-split
    // camera is an `Object`, so it is skipped too: that is what makes this idempotent.
    if (!projection || !camera.id) continue;

    // Normalize the camera through its OWN migration ladder first (reuse, not a
    // parallel copy). Both camera kinds are v1 with no ladder steps today, but keep
    // the pattern so a future camera-node version migrates BEFORE the split —
    // splitting raw params before normalizing is the silent look-shift for old saves.
    const params = normalizeRetiredParams(camera.type!, camera.version, {
      ...(camera.params ?? {}),
    });

    const dataId = freshDataId(nodes, camera.id);
    dataIdByCamera.set(camera.id, dataId);

    // The DATA half — the lens, no pose, no inputs. Per-projection hydrate.
    nodes[dataId] = {
      id: dataId,
      type: 'CameraData',
      version: cameraDataVersion,
      params: cameraDataParamsFor(projection, params),
      inputs: {},
    };

    // The OBJECT half — the camera converted IN PLACE (inherits the id). Owns the
    // pose, points at the data node through `data`; any pre-existing inputs are kept
    // (constraint targets, rig membership, Group parenting — all keyed on the
    // inherited id). `rotation`/`scale` are written as identity because neither fused
    // camera type HAS them: aim stays on the data half (D1), so the camera road
    // ignores the Object's rotation (see cameraRecompose.ts, which drops it).
    camera.type = 'Object';
    camera.version = objectVersion;
    camera.params = {
      position: params.position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    camera.inputs = { ...(camera.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject by
  // `params.target` (a node-id STRING) + `params.paramPath`; a CameraData's own
  // `lookAt` is a Vec3 ARRAY, so it is skipped by the `typeof === 'string'` guard —
  // the same non-collision the light relies on. position channels keep target = the
  // camera id (now the Object).
  if (dataIdByCamera.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdByCamera.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 7 };
}

// ── v7 → v8: fused BakedMesh → Object + BakedData ──────────────────────────
// (object↔data split, #388 Stage C · C5)
//
// The sixth kind, and the last node that still minted a fused pair. A baked mesh is a
// real scene object with a real pose — the TRS band is identity right after Apply
// Transform, but the mesh is first-class and re-transformable afterwards — so this is a
// SPLIT like the five before it, not a deletion.
//
// The Object INHERITS the baked mesh's id, so every consumer edge, channel `target`,
// constraint `target` and saved selection that named it still resolves with no
// re-pointing pass. Only `geometry`/`material.*` channels re-target to the data half.
//
// TWO THINGS THIS KIND DOES DIFFERENTLY FROM THE CAMERA, both because of what a baked
// mesh IS rather than any change to the recipe:
//
//   1. NOTHING IS INVENTED. The camera had to write `fov: 45` for an orthographic
//      source because `CameraData.fov` is required and an ortho camera never had one.
//      `BakedData`'s two params — `geometry` and `material` — are exactly the two the
//      fused `BakedMesh` also required with no zod default, so every source carries
//      both and each is copied across verbatim. A source somehow missing one fails to
//      parse afterwards, which is precisely what the fused node would have done: the
//      absence stays loud rather than being hydrated into a plausible wrong thing
//      (a fabricated buffer handle would resolve to nothing; a fabricated material
//      would render as the grey fallback the whole kind exists to avoid).
//
//   2. THE POSE IS HYDRATED, and here the light's `?? default` idiom IS right. All
//      three TRS params carry `BakedMesh`'s own schema defaults (identity), so a raw
//      save may legitimately omit them, and identity is a MEANINGFUL value for this
//      kind — the transform was composed into the vertices, so identity is what the
//      renderer must apply. It is not a failure sentinel the way the camera's 45 was,
//      which is the test that decides whether to hydrate at all.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; src/nodes/BakedData.ts (why a baked payload
//      is its own value kind and not a `MeshData`); krama K23; issue #388.

export function migrateFusedBakedMeshToSplit(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 8 };

  const objectVersion = getNodeType('Object')?.version ?? 1;
  const bakedDataVersion = getNodeType('BakedData')?.version ?? 1;

  // bakedMeshId → its split-off data node id (used to re-target geometry/material
  // channels).
  const dataIdByBaked = new Map<string, string>();

  for (const baked of Object.values(nodes)) {
    // Every non-BakedMesh node is skipped — it never enters the loop. An ALREADY-split
    // baked mesh is an `Object`, so it is skipped too: that is what makes this
    // idempotent.
    if (baked?.type !== 'BakedMesh' || !baked.id) continue;

    // Normalize the baked mesh through its OWN migration ladder first (reuse, not a
    // parallel copy). `BakedMesh` is v1 with no ladder steps today, but keep the pattern
    // so a future baked-node version migrates BEFORE the split — splitting raw params
    // before normalizing is the silent look-shift for old saves.
    const params = normalizeRetiredParams('BakedMesh', baked.version, {
      ...(baked.params ?? {}),
    });

    const dataId = freshDataId(nodes, baked.id);
    dataIdByBaked.set(baked.id, dataId);

    // The DATA half — the buffer handle + the captured material, no pose, no inputs.
    // Both carried verbatim; see note 1 in the header on why neither is hydrated.
    nodes[dataId] = {
      id: dataId,
      type: 'BakedData',
      version: bakedDataVersion,
      params: { geometry: params.geometry, material: params.material },
      inputs: {},
    };

    // The OBJECT half — the baked mesh converted IN PLACE (inherits the id). Owns the
    // pose, points at the data node through `data`; any pre-existing inputs are kept
    // (constraint targets, rig membership, Group parenting — all keyed on the inherited
    // id). See note 2 on why the TRS defaults are hydrated here.
    baked.type = 'Object';
    baked.version = objectVersion;
    baked.params = {
      position: params.position ?? [0, 0, 0],
      rotation: params.rotation ?? [0, 0, 0],
      scale: params.scale ?? [1, 1, 1],
    };
    baked.inputs = { ...(baked.inputs ?? {}), data: { node: dataId, socket: 'out' } };
  }

  // Re-target the channels that address the DATA half. A channel names its subject by
  // `params.target` (a node-id STRING) + `params.paramPath`; position/rotation/scale
  // channels keep target = the baked mesh's id (now the Object).
  if (dataIdByBaked.size > 0) {
    for (const n of Object.values(nodes)) {
      const target = n.params?.target;
      if (typeof target !== 'string') continue;
      const dataId = dataIdByBaked.get(target);
      if (dataId && n.params && isDataParamPath(n.params.paramPath)) {
        n.params.target = dataId;
      }
    }
  }

  return { ...proj, formatVersion: 8 };
}

export function registerFormatMigration(fromVersion: number, fn: FormatMigration): void {
  if (formatMigrations[fromVersion]) {
    throw new Error(`Format migration already registered from v${fromVersion}`);
  }
  formatMigrations[fromVersion] = fn;
}

export function migrateProjectFormat(raw: unknown): unknown {
  let cur = raw;
  let safety = 32;
  while (safety-- > 0) {
    const obj = cur as { formatVersion?: number };
    if (typeof obj?.formatVersion !== 'number') break;
    if (obj.formatVersion >= PROJECT_FORMAT_VERSION) break;
    const step = formatMigrations[obj.formatVersion];
    if (!step) {
      throw new Error(
        `No migration registered for project formatVersion ${obj.formatVersion} → ${obj.formatVersion + 1}`,
      );
    }
    cur = step(cur);
  }
  return cur;
}

/**
 * Walk every node in a (post-format-migration) project and step each one to
 * its registered version using its node-type's migration ladder.
 */
export function migrateNodes(project: Project): Project {
  const migratedNodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(project.state.nodes)) {
    migratedNodes[id] = migrateOneNode(node);
  }
  return {
    ...project,
    state: { ...project.state, nodes: migratedNodes },
    nodeVersions: snapshotCurrentNodeVersions(migratedNodes),
  };
}

function migrateOneNode(node: Node): Node {
  const def = getNodeType(node.type);
  if (!def) {
    throw new Error(
      `Cannot migrate node ${node.id}: unknown type "${node.type}". Register the type before loading.`,
    );
  }
  let working = node;
  let safety = 64;
  while (safety-- > 0) {
    if (working.version >= def.version) break;
    const step = def.migrations?.[working.version];
    if (!step) {
      throw new Error(`No migration for ${def.type} v${working.version} → v${working.version + 1}`);
    }
    working = {
      ...working,
      version: working.version + 1,
      params: step(working.params),
    };
  }
  return working;
}

// ── v8 → v9: ParamDriver's two source sockets become one (#609) ────────────
// `in: Number` + `inVec: Vector3` were one logical role the socket model could not
// describe, so a bind wired whichever matched the target's type. `in` now accepts
// either, and `inVec` is gone from the declaration.
//
// A socket id is a PERSISTED binding key — unlike a `TypeDescriptor`, which is code —
// so this cannot ride the per-node ladder: `def.migrations[v]` receives only
// `oldParams` and has no way to reach `inputs`. It has to happen here, on raw JSON,
// before `ProjectSchema.parse`.
//
// IDEMPOTENT and non-destructive: a driver with no `inVec` is untouched, and a driver
// that somehow carries BOTH keeps `inVec` — that is the binding the old evaluate would
// have chosen, since the Vector3 road won whenever it was wired. Preserving the old
// precedence is the whole job; picking the other one would silently re-point a live
// driver at a different source node.
export function migrateDriverInVecToIn(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 9 };

  for (const node of Object.values(nodes)) {
    if (node?.type !== 'ParamDriver' || !node.inputs) continue;
    const vec = node.inputs['inVec'];
    if (vec === undefined) continue;
    node.inputs['in'] = vec;
    delete node.inputs['inVec'];
  }

  return { ...proj, formatVersion: 9 };
}

function snapshotCurrentNodeVersions(nodes: Record<string, Node>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    out[node.type] = Math.max(out[node.type] ?? 0, node.version);
  }
  return out;
}

// ── v9 → v10: drop the eager bake's unauthored channels (#915) ─────────────
// `bakeClipOntoRig` gave EVERY bone a `KeyframeChannelVec3` at bind time — 46 of
// them for 23 bones in `Robot-Walk.basher`, not one authored by anybody. #889
// deleted that bake and made a channel appear only when something is authored
// into it; #913 then taught the mint to carry the source clip's TIME DOMAIN as a
// Cycles modifier. Neither reaches a channel that is ALREADY in a saved file.
//
// Those channels carry no modifier, so they HOLD past the clip's duration where
// the clip they were copied from WRAPS. Measured on `Robot-Walk.basher`: 46
// channels, 0 with modifiers, and `t = 1.98` ≠ `t = 1.98 + duration` on every
// bone — the whole rig plays its walk once and then stands still for the rest of
// the timeline. It was invisible for the life of the feature because it was
// UNIFORM: a rig that stops as a unit reads as "the clip ended", and only #889
// making the population mixed (one edited bone freezing beside 22 walking ones)
// put a control group in the frame.
//
// This is #889's own rule applied retroactively rather than a new mechanism: a
// channel nobody authored should not exist, and a bone without one is served by
// the clip band, where looping is already correct. Measured over all 23 bones at
// 4 out-of-range times, DELETING the 46 and adding Cycles to the 46 agree to
// 5.7e-14 — behaviourally the same fix. Deleting is chosen because it leaves no
// duplicate behind to go stale against its source, which is the defect #889
// exists to remove.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 WHAT MAKES THIS SAFE IS THE PREDICATE, NOT THE VERSION BUMP
// ─────────────────────────────────────────────────────────────────────────
// "Which of my channels were authored" is the question a pre-#889 file was
// thought to be unable to answer about itself. It can — by CONTENT rather than
// by a flag it does not carry. Re-derive the channel from the clip that drives
// its bone (the same one walk the mint and the read band use) and keep any
// channel that differs from that derivation in ANY field:
//
//   - a hand-edited bone keeps its edit, because its keys no longer match;
//   - a bone whose extend / blend / order / mute / weight / modifier stack was
//     touched keeps it, because those no longer match the bake's defaults;
//   - a key carrying a bézier handle keeps it, because the bake wrote exactly
//     `{time, value, easing}` and nothing else.
//
// Every comparison is EXACT — measured, a 1e-9 difference on one key of one
// channel is enough to keep that channel.
//
// AND IT FAILS TOWARD KEEPING. Anything unrecognised, unparseable, scale-domain,
// or without a bound clip is left alone. The cost of keeping a frozen channel is
// the bug this fixes and it stays visible; the cost of dropping an authored one
// is a director's work, silently. Every channel kept for a reason other than
// "somebody edited its keys" is counted and reported (V38, no silent loss), so a
// project this does not fully migrate says so rather than looking done.
//
// REF: src/app/animate/boundClipsForAsset.ts (the ONE edge walk — imported
//        rather than re-implemented, because a second copy of it is two answers
//        to "which clip drives this bone" that diverge silently);
//      src/app/animate/ensureChannelForBone.ts (`seedKeysFromClip`, the
//        derivation this mirrors key-for-key, including the radians→degrees
//        boundary, which must use the SAME helper or nothing compares equal);
//      src/agent/mutators/builders/bakeChannelOps.ts (the node shape + the
//        `easing: 'linear'` the bake stamps); issues #915, #913, #889, #877.

/** The eager bake's value for every non-keyframe field. A channel deviating in
 *  any of them was touched by somebody. `undefined` counts as a match: an absent
 *  field and a field at its schema default parse to the same channel. */
const EAGER_CHANNEL_FIELDS: Readonly<Record<string, unknown>> = {
  mute: false,
  solo: false,
  weight: 1,
  blendMode: 'replace',
  order: 0,
  extendBefore: 'hold',
  extendAfter: 'hold',
};

/** Exactly the keys `bakeChannelOpsForBone` writes on one keyframe. A key with
 *  more than these carries authoring the bake cannot have produced. */
const EAGER_KEY_FIELDS = ['easing', 'time', 'value'] as const;

/** The `KeyframeChannelVec3` version whose param shape the predicate below
 *  compares against.
 *
 *  🔴 THIS PASS RUNS ON RAW JSON, BEFORE `migrateNodes`, so it sees params in
 *  whatever shape the file was SAVED in — not the shape the registry describes.
 *  A v1 channel is a different vocabulary: it carries `cyclesBefore` /
 *  `cyclesAfter`, which the node ladder later folds into a Cycles modifier. The
 *  predicate does not read those keys, so a v1 channel with a director's cycling
 *  set up would look untouched and be dropped, discarding it.
 *
 *  So anything not at this exact version is KEPT. The literal (rather than a
 *  registry lookup) keeps this pass registry-free like every format migration
 *  above it, and `migrations.test.ts` pins it to the registered version so a
 *  future node bump reds instead of silently widening what gets deleted. */
const EAGER_CHANNEL_NODE_VERSION = 2;

function isDefaultedEmpty(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.length === 0);
}

/** Why a channel was kept — reported so a partly-migrated project says so. */
type KeepReason = 'edited-keys' | 'edited-channel' | 'no-bound-clip' | 'not-baked-shape';

/**
 * Is this channel bit-identical to what the eager bake wrote, and nothing more?
 *
 * Returns null when it is (⇒ safe to drop), or the reason it was kept.
 */
function eagerChannelKeepReason(
  node: RawNode,
  nodeId: string,
  nodes: Readonly<Record<string, GraphNodeLike>>,
): KeepReason | null {
  const p = node.params;
  if (!p) return 'not-baked-shape';
  // Saved in a param vocabulary this predicate does not read — see the constant.
  if (node.version !== EAGER_CHANNEL_NODE_VERSION) return 'not-baked-shape';
  const { assetRef, childName, paramPath } = p as Record<string, unknown>;
  if (typeof assetRef !== 'string' || typeof childName !== 'string') return 'not-baked-shape';
  // Scale was never eager-baked: `AnimationClipParams.keyframes` carries none.
  if (paramPath !== 'position' && paramPath !== 'rotation') return 'not-baked-shape';
  // The bake's ids are content-addressed one way. A channel sitting under a
  // different id, or aimed at a different bone node, came from somewhere else.
  if (nodeId !== gltfChannelDagId(assetRef, childName, paramPath)) return 'not-baked-shape';
  if (p.target !== gltfChildDagId(assetRef, childName)) return 'not-baked-shape';
  if (node.inputs && Object.keys(node.inputs).length > 0) return 'not-baked-shape';
  // The emitter's own deterministic label. No surface renames a channel today,
  // so this closes the hole rather than catching a known case — but a rename IS
  // authoring, and a predicate that ignored the field would delete it if one
  // ever ships.
  if (p.name !== `${childName} — ${paramPath}`) return 'edited-channel';

  for (const [field, expected] of Object.entries(EAGER_CHANNEL_FIELDS)) {
    const actual = p[field];
    if (actual !== undefined && actual !== expected) return 'edited-channel';
  }
  // A modifier stack, a per-axis override, or a per-axis extend is authoring by
  // definition — and an existing Cycles modifier means this channel is ALREADY
  // correct and must not be removed for being so.
  if (!isDefaultedEmpty(p.modifiers)) return 'edited-channel';
  if (!isDefaultedEmpty(p.axisModifiers)) return 'edited-channel';
  if (!isDefaultedEmpty(p.axisExtend)) return 'edited-channel';

  const saved = p.keyframes;
  if (!Array.isArray(saved)) return 'not-baked-shape';

  // The derivation, key for key. Same walk, same order, same unit conversion as
  // the mint — a second implementation of any of the three would compare unequal
  // for reasons that have nothing to do with authoring.
  for (const clip of boundClipsForAsset(nodes, assetRef)) {
    const index = boneIndexOf(clip, childName);
    if (index === null) continue;
    const mine = (clip.params.keyframes ?? []).filter((k) => k.bone === index);
    if (mine.length === 0) continue;
    const sorted = mine.slice().sort((a, b) => a.time - b.time);
    if (saved.length !== sorted.length) return 'edited-keys';
    for (let i = 0; i < sorted.length; i++) {
      const key = saved[i] as Record<string, unknown> | undefined;
      if (!key || typeof key !== 'object') return 'not-baked-shape';
      const present = Object.keys(key).sort();
      if (present.length !== EAGER_KEY_FIELDS.length) return 'edited-keys';
      if (present.some((k, j) => k !== EAGER_KEY_FIELDS[j])) return 'edited-keys';
      // #877 — the bake stamps 'linear' explicitly. A key without it parses to
      // the schema's 'cubic', which is a different curve and not this bake's.
      if (key.easing !== 'linear') return 'edited-keys';
      if (key.time !== sorted[i].time) return 'edited-keys';
      const want = paramPath === 'rotation' ? radVec3ToDeg(sorted[i].rotation) : sorted[i].position;
      const got = key.value;
      if (!Array.isArray(got) || got.length !== 3) return 'edited-keys';
      for (let a = 0; a < 3; a++) if (got[a] !== want[a]) return 'edited-keys';
    }
    return null;
  }
  // No clip drives this bone, so this channel cannot be a copy of one. It is
  // either `bakeGltfChannel`'s edit-time output or a base-pose seed — authored
  // either way, and removing it would delete motion with no source to fall to.
  return 'no-bound-clip';
}

export function migrateDropUnauthoredEagerChannels(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 10 };

  const graph = nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
  const dropped: string[] = [];
  const kept: Record<KeepReason, number> = {
    'edited-keys': 0,
    'edited-channel': 0,
    'no-bound-clip': 0,
    'not-baked-shape': 0,
  };
  let examined = 0;

  for (const [id, node] of Object.entries(nodes)) {
    if (node?.type !== 'KeyframeChannelVec3') continue;
    examined++;
    const reason = eagerChannelKeepReason(node, id, graph);
    if (reason === null) dropped.push(id);
    else kept[reason]++;
  }

  for (const id of dropped) delete nodes[id];

  if (dropped.length > 0 || kept['edited-keys'] > 0 || kept['edited-channel'] > 0) {
    const keptTotal = examined - dropped.length;
    console.warn(
      `[migrateDropUnauthoredEagerChannels] examined ${examined} bone channels: dropped ` +
        `${dropped.length} that were bit-identical copies of the clip driving them (#915 — ` +
        `they held past the clip's end instead of looping; those bones are now served by the ` +
        `clip band, which loops). Kept ${keptTotal}: ` +
        `${kept['edited-keys']} with edited keys, ${kept['edited-channel']} with an edited ` +
        `channel setting, ${kept['no-bound-clip']} with no clip driving the bone, ` +
        `${kept['not-baked-shape']} not in the bake's shape.`,
    );
  }

  return { ...proj, formatVersion: 10 };
}
