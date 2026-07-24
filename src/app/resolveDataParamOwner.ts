// resolveDataParamOwner — "which node owns this data param?" for the object↔data split.
//
// #365 Phase 5a: a scene object is now an `Object` (owning the transform) pointing at a data
// node (owning geometry + material) through its `data` input. So a data param — `material`,
// `size` — no longer lives on the node you selected/identified (the Object); it lives on the
// node the Object points at. Every editor that writes a data param (the inspector, the
// material/size mutators) must reach through `data` to find the true owner, or it silently
// edits a param the Object doesn't have.
//
// This is the ONE place that reach lives, so a new data param or a new data-carrying wrapper
// is handled in a single spot rather than re-derived at each call site (V101 — one projection,
// not a parallel list). Transform params (position/rotation/scale) stay on the Object and need
// no reach — this helper returns the Object's own id for those.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; src/nodes/BoxData.ts; #365 Phase 5a.

import type { DagState } from '../core/dag/state';

/**
 * The id of the data node `id` points at through its `data` input, or null when it points at
 * nothing (a fused node, or an Empty). Param-agnostic — use this when you need the linked data
 * node itself rather than the owner of one particular param.
 *
 * #398: the render's channel overlay needs this. A data-param channel targets the DATA node
 * (the inspector renders those rows keyed to it), while the overlay is keyed by the SCENE
 * CHILD — so without this reach an animated material or size resolves to nothing and the
 * viewport silently never repaints.
 */
export function linkedDataNodeId(state: DagState, id: string): string | null {
  const node = state.nodes[id];
  if (!node) return null;
  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  const dataId = dataRef?.node;
  return dataId && state.nodes[dataId] ? dataId : null;
}

/**
 * The INVERSE of {@link linkedDataNodeId}: the id of the Object that poses `dataId` through
 * its `data` input, or null when nothing poses it (a fused node, or an orphaned data node).
 *
 * #386 — needed because animation MANAGEMENT aggregates under the Object (V112, the locked
 * surfacing rule): a push-down mints ONE Strip targeting the OBJECT even when the channel it
 * consumed targeted the data half, since a Strip carries one `target`. Read surfaces that
 * address the DATA node (the inspector renders a data node's rows against its own id) must
 * therefore be able to look UP to the poser, or the viewport animates while the row reports
 * the static base — the H40 divergence the forward reach exists to prevent, in the other
 * direction.
 *
 * `data` is an EXCLUSIVE socket (only an ObjectNode has one) and every producer mints a fresh
 * data node per Object, so the poser is unique in practice; first match wins, which matches
 * the duplicate-path contract (a shared/fan-out data node cannot be created by any UI today).
 */
export function posingObjectId(state: DagState, dataId: string): string | null {
  if (!dataId || !state.nodes[dataId]) return null;
  for (const node of Object.values(state.nodes)) {
    const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
      | { node?: string }
      | undefined;
    if (dataRef?.node === dataId) return node.id;
  }
  return null;
}

/**
 * The id of the node that owns `paramRoot` (a top-level param key, e.g. 'material' or 'size')
 * for the scene object `id`: the node itself if its params carry that key, otherwise the node
 * it points at via its `data` input (the object↔data split). Returns null when neither carries
 * it — the caller should treat that as "this target has no such param".
 */
export function resolveDataParamOwner(
  state: DagState,
  id: string,
  paramRoot: string,
): string | null {
  const node = state.nodes[id];
  if (!node) return null;

  const params = node.params as Record<string, unknown> | undefined;
  if (params && paramRoot in params) return id;

  // Reach through the split: the Object owns the transform; the data node it points at via
  // `data` owns geometry + material.
  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  if (dataRef?.node) {
    const dataNode = state.nodes[dataRef.node];
    const dataParams = dataNode?.params as Record<string, unknown> | undefined;
    if (dataParams && paramRoot in dataParams) return dataRef.node;
  }

  return null;
}
