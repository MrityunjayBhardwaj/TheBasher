// lightNode — the GRAPH-level "is this node a light, and what are its shading params?"
// reach for the object↔data split (#386, Stage C · C3).
//
// Post-split a posable light is an `Object` posing a `LightData`: the shading (kind,
// intensity, colour, width/height, tex, aim) lives on the LightData, NOT on the node you
// selected/enumerated. The graph-level consumers — the studio rig enumeration, legacy
// adoption, the SceneTree reparent socket, the profile export — read `node.type` / node
// params, never a rendered `value.kind`, so the render-side recompose (lightRecompose.ts)
// can NEVER reach them. This is the ONE place the "reach through `data` to the light"
// question is answered, so a future light kind is added once, not in five call sites (V101).
//
// COEXISTENCE-SAFE: a still-fused light (a project that has not migrated yet) is recognised
// too — every predicate accepts BOTH the fused node and the split Object.
//
// The WORLD position of a rig light stays on the Object (it owns the TRS), so callers read
// `node.params.position` directly; only the SHADING (tex, width, …) moves behind `data`,
// which is what `lightParamsOf` returns.

import type { Node } from '../core/dag/types';

/** The fused light node types (the migration relics + the still-fused AmbientLight). */
const FUSED_LIGHT_TYPES = new Set([
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'AreaLight',
  'AmbientLight',
]);

/** The LightData node `id` poses through its `data` input, or null. */
function posedLightData(nodes: Readonly<Record<string, Node>>, id: string): Node | null {
  const node = nodes[id];
  if (!node) return null;
  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  const d = dataRef?.node ? nodes[dataRef.node] : undefined;
  return d?.type === 'LightData' ? d : null;
}

/** The `lightKind` a node describes: a fused light's own type mapped to the kind, or the
 *  posed LightData's `lightKind` param. Null when `id` is not a light. */
export function lightKindOf(nodes: Readonly<Record<string, Node>>, id: string): string | null {
  const node = nodes[id];
  if (!node) return null;
  if (node.type === 'AmbientLight') return 'Ambient';
  if (FUSED_LIGHT_TYPES.has(node.type)) return node.type.replace(/Light$/, '');
  const d = posedLightData(nodes, id);
  const lk = d ? (d.params as Record<string, unknown> | undefined)?.lightKind : undefined;
  return typeof lk === 'string' ? lk : null;
}

/** True iff `id` is an AreaLight — a fused `AreaLight` node OR an Object posing an
 *  Area-kind LightData (coexistence-safe). The studio rig is built from area lights. */
export function isAreaLightNode(nodes: Readonly<Record<string, Node>>, id: string): boolean {
  return lightKindOf(nodes, id) === 'Area';
}

/** True iff `id` is ANY light — a fused light node (incl. AmbientLight) OR an Object posing
 *  a LightData. Used by the SceneTree reparent socket to route a light row into
 *  `scene.lights` rather than `scene.children`. A cube-Object (posing a BoxData) is NOT a
 *  light. */
export function isLightNode(nodes: Readonly<Record<string, Node>>, id: string): boolean {
  const node = nodes[id];
  if (!node) return false;
  if (FUSED_LIGHT_TYPES.has(node.type)) return true;
  return posedLightData(nodes, id) != null;
}

/** The SHADING params of a light `id`: the fused node's own params, OR the posed LightData's
 *  params for a split light. Null when `id` is not a light. NOTE: a split light's pose
 *  (position/rotation/scale) is NOT here — it lives on the Object node. */
export function lightParamsOf(
  nodes: Readonly<Record<string, Node>>,
  id: string,
): Record<string, unknown> | null {
  const node = nodes[id];
  if (!node) return null;
  if (FUSED_LIGHT_TYPES.has(node.type)) return (node.params ?? {}) as Record<string, unknown>;
  const d = posedLightData(nodes, id);
  return d ? ((d.params ?? {}) as Record<string, unknown>) : null;
}
