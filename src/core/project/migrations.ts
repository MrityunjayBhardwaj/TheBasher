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
    // Material — shared by both mesh primitives (the data half owns the look).
    // A curve has no material, so a curve target never reaches this arm.
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

  const boxDef = getNodeType('BoxMesh');
  const objectVersion = getNodeType('Object')?.version ?? 1;
  const boxDataVersion = getNodeType('BoxData')?.version ?? 1;

  // boxId → its split-off data node id (used to re-target data-half channels).
  const dataIdByBox = new Map<string, string>();

  for (const box of Object.values(nodes)) {
    if (box?.type !== 'BoxMesh' || !box.id) continue;

    // Normalize the box through BoxMesh's OWN migration ladder first (reuse, not a
    // parallel copy), so an old-node-version box reaches the v4 shape — keeping its
    // material's byte-identical migrated look — BEFORE it is split.
    let params: Record<string, unknown> = { ...(box.params ?? {}) };
    if (boxDef) {
      let v = typeof box.version === 'number' ? box.version : boxDef.version;
      let safety = 64;
      while (v < boxDef.version && safety-- > 0) {
        const step = boxDef.migrations?.[v];
        if (!step) break;
        params = step(params) as Record<string, unknown>;
        v++;
      }
    }

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

  const sphereDef = getNodeType('SphereMesh');
  const objectVersion = getNodeType('Object')?.version ?? 1;
  const sphereDataVersion = getNodeType('SphereData')?.version ?? 1;

  // sphereId → its split-off data node id (used to re-target data-half channels).
  const dataIdBySphere = new Map<string, string>();

  for (const sphere of Object.values(nodes)) {
    if (sphere?.type !== 'SphereMesh' || !sphere.id) continue;

    // Normalize the sphere through SphereMesh's OWN migration ladder first (reuse, not
    // a parallel copy), so an old-node-version sphere reaches the v4 shape — keeping
    // its material's byte-identical migrated look — BEFORE it is split.
    let params: Record<string, unknown> = { ...(sphere.params ?? {}) };
    if (sphereDef) {
      let v = typeof sphere.version === 'number' ? sphere.version : sphereDef.version;
      let safety = 64;
      while (v < sphereDef.version && safety-- > 0) {
        const step = sphereDef.migrations?.[v];
        if (!step) break;
        params = step(params) as Record<string, unknown>;
        v++;
      }
    }

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

  const curveDef = getNodeType('Curve');
  const objectVersion = getNodeType('Object')?.version ?? 1;
  const curveDataVersion = getNodeType('CurveData')?.version ?? 1;

  // curveId → its split-off data node id (used to re-target data-half channels).
  const dataIdByCurve = new Map<string, string>();

  for (const curve of Object.values(nodes)) {
    if (curve?.type !== 'Curve' || !curve.id) continue;

    // Normalize the curve through Curve's OWN migration ladder first (reuse, not a
    // parallel copy), so a v1 bare-Vec3 curve reaches the v2 {id,co} shape — minting
    // the stable point ids — BEFORE it is split.
    let params: Record<string, unknown> = { ...(curve.params ?? {}) };
    if (curveDef) {
      let v = typeof curve.version === 'number' ? curve.version : curveDef.version;
      let safety = 64;
      while (v < curveDef.version && safety-- > 0) {
        const step = curveDef.migrations?.[v];
        if (!step) break;
        params = step(params) as Record<string, unknown>;
        v++;
      }
    }

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
    let params: Record<string, unknown> = { ...(light.params ?? {}) };
    const def = getNodeType(light.type!);
    if (def) {
      let v = typeof light.version === 'number' ? light.version : def.version;
      let safety = 64;
      while (v < def.version && safety-- > 0) {
        const step = def.migrations?.[v];
        if (!step) break;
        params = step(params) as Record<string, unknown>;
        v++;
      }
    }

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

function snapshotCurrentNodeVersions(nodes: Record<string, Node>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    out[node.type] = Math.max(out[node.type] ?? 0, node.version);
  }
  return out;
}
