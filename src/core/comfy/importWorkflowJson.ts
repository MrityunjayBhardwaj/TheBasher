// importWorkflowJson — the PURE parse+validate step for loading a ComfyUI workflow
// file into a Basher ComfyUIWorkflow layer (the "load a workflow JSON" affordance).
// No I/O: it takes the file TEXT + a name and returns either a ready ComfyGraphParam
// (`{ apiJson, meta }` — the exact shape the node stores and `importComfyGraph` reads)
// or an actionable rejection. The picker/decode boundary stays impure; this is the
// snapshot-testable gate (design §15).
//
// ComfyUI exports TWO JSON shapes:
//   - API format (`/prompt`): a flat map `{ "3": { class_type, inputs }, … }` — the
//     ONE Basher consumes (importComfyGraph walks it). Produced by "Save (API Format)"
//     (Settings → enable Dev Mode).
//   - UI format ("Save"): `{ nodes: [...], links: [...], … }` — the editor graph, NOT
//     directly executable. We DETECT it and reject with guidance rather than importing
//     a graph whose manifest would be empty/wrong (never a silent mis-parse, §7.4).
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.1/§6.2; src/core/comfy/comfyGraph.ts
//      (importComfyGraph — the consumer); src/nodes/ComfyUIWorkflow.ts (ComfyGraphParam).

import type { ComfyApiJson, ComfyGraphMeta } from './comfyGraph';

/** The stored graph param shape (matches ComfyGraphParamSchema). */
export interface ParsedComfyGraph {
  readonly apiJson: ComfyApiJson;
  readonly meta: ComfyGraphMeta;
}

export type ParseWorkflowResult =
  | { readonly ok: true; readonly graph: ParsedComfyGraph }
  | { readonly ok: false; readonly reason: string };

/** True iff `v` is a plain (non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True iff `v` looks like ComfyUI's UI ("Save") export rather than API format. */
function looksLikeUiFormat(v: Record<string, unknown>): boolean {
  return Array.isArray(v.nodes) && ('links' in v || 'last_node_id' in v);
}

/** True iff every value of `v` is an API-format node (`{ class_type, inputs }`). */
function isApiFormat(v: Record<string, unknown>): boolean {
  const entries = Object.values(v);
  if (entries.length === 0) return false;
  return entries.every(
    (node) =>
      isPlainObject(node) &&
      typeof (node as { class_type?: unknown }).class_type === 'string' &&
      isPlainObject((node as { inputs?: unknown }).inputs),
  );
}

/**
 * Parse + validate a ComfyUI workflow file's TEXT into a ready ComfyGraphParam.
 * `name` labels the imported graph (the picker passes the filename, sans `.json`).
 * `meta.fps`/`frames` default to the per-frame preview shape (30/1); the batched
 * path (Inc 4) sets the real frame count. Deterministic (no clock) so it snapshots.
 */
export function parseComfyWorkflowJson(text: string, name: string): ParseWorkflowResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'That file is not valid JSON.' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'A ComfyUI workflow must be a JSON object of nodes.' };
  }
  if (looksLikeUiFormat(parsed)) {
    return {
      ok: false,
      reason:
        'This is a ComfyUI UI-format export (it has a "nodes" array). Use “Save (API Format)” in ComfyUI — enable Dev Mode in Settings to get that option.',
    };
  }
  if (!isApiFormat(parsed)) {
    return {
      ok: false,
      reason:
        'Not a ComfyUI API-format workflow: every entry must be a node with "class_type" and "inputs". Export with “Save (API Format)”.',
    };
  }
  const apiJson = parsed as ComfyApiJson;
  const cleanName = name.trim() || 'workflow';
  return {
    ok: true,
    graph: { apiJson, meta: { name: cleanName, importedAt: '', fps: 30, frames: 1 } },
  };
}
