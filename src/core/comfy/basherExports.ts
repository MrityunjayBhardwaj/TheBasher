// basherExports — the PURE scan for the OUTPUT half of the two-node contract
// (docs/COMFYUI-BASHER-NODES.md). The mirror image of basherControllers: where a
// `basher_controller` is a Basher-driven INPUT (declared by wiring its `*` output
// into a target), a `basher_export` is a Basher-collected OUTPUT (declared by wiring
// the result into its `images` input). Basher enumerates these by class_type and,
// after a render, routes each export node's /history frames into its own project
// MediaClip — the author DECLARES the collection point instead of Basher heuristically
// grabbing every SaveImage. It NEVER parses a foreign node — the correct boundary.
//
// REF: docs/COMFYUI-BASHER-NODES.md (the contract); the node lives arm's-length in the
//      MIT extension (comfyui/custom_nodes/BasherSchedule/ — `basher_export`); the
//      sibling input scan is ./basherControllers.ts; vyapti V81.

import type { ComfyApiJson } from './comfyGraph';

/** The ComfyUI class_type Basher scans for — the one declared output sink. */
export const BASHER_EXPORT_TYPE = 'basher_export';

/** One declared export, read from a `basher_export` node's own inputs. `nodeId` is
 *  the /history key Basher collects frames from; `name` labels the resulting clip. */
export interface BasherExportDecl {
  readonly nodeId: string;
  readonly name: string;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** True iff the workflow declares ANY `basher_export` node. Render-time collection
 *  DISPATCHES on this: present → collect each export's frames into its own MediaClip
 *  (author-declared); absent → the legacy "all output images → one clip" behaviour. */
export function hasBasherExports(apiJson: ComfyApiJson): boolean {
  for (const nodeId of Object.keys(apiJson)) {
    if (apiJson[nodeId]?.class_type === BASHER_EXPORT_TYPE) return true;
  }
  return false;
}

/** Enumerate every `basher_export` node in a workflow, in stable (nodeId) order.
 *  Reads ONLY those nodes' own declared `name` — never a foreign node. A node missing
 *  `name` falls back to its id. */
export function scanBasherExports(apiJson: ComfyApiJson): BasherExportDecl[] {
  const out: BasherExportDecl[] = [];
  for (const nodeId of Object.keys(apiJson)) {
    const node = apiJson[nodeId];
    if (!node || node.class_type !== BASHER_EXPORT_TYPE) continue;
    out.push({ nodeId, name: str(node.inputs?.name, nodeId) });
  }
  out.sort((a, b) => a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
  return out;
}
