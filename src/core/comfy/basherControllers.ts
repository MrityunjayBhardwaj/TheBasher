// basherControllers — the PURE core of the two-node contract (the go-forward model;
// docs/COMFYUI-BASHER-NODES.md, superseding the keyframe-any-param compiler). It has
// NO I/O and NO DAG dependency: it enumerates a workflow's `basher_controller` nodes
// and writes baked per-frame arrays onto them. This is the whole "compiler" now —
// there is no manifest, no valueKind inference, no schedulable/structural
// classification, and no link rewiring, because the workflow AUTHOR already declared
// the control surface by wiring each `basher_controller` output into the input they
// want Basher to drive. Basher reads metadata ONLY from `basher_controller` nodes and
// never parses a foreign node — the correct side of the boundary.
//
// Two pure stages live here (the GPU-free, snapshot-testable IP — design §15):
//   scanBasherControllers(apiJson) → BasherControllerDecl[]
//     Find every `basher_controller` node; read its declared name / kind / default.
//     The list drives Basher's Controls rows (one keyframe channel per controller).
//   writeBasherControllerValues(apiJson, valuesById) → apiJson'
//     Deep-clone and write each controller's baked array into its `values_json` +
//     `frame_count` inputs. The author's wiring is untouched; only the node's own
//     value payload is set. This is the submit-time bake-injection (the inline
//     transport for scalar kinds — media kinds upload out-of-band, a later slice).
//
// REF: docs/COMFYUI-BASHER-NODES.md; the node lives arm's-length in the MIT extension
//      (comfyui/custom_nodes/BasherSchedule/ — `basher_controller`, AnyType `*` output
//      grounded against ComfyUI 0.26 comfy_execution/validation.py); vyapti V81.

import { isComfyLink, type ComfyApiJson, type ComfyInputValue } from './comfyGraph';

/** The ComfyUI class_type Basher scans for — the one declared input node. */
export const BASHER_CONTROLLER_TYPE = 'basher_controller';

/** The kinds a controller declares. Scalars travel inline (`values_json`); image /
 *  video travel out-of-band (uploaded bytes + filename — a later slice). */
export type BasherControllerKind = 'float' | 'int' | 'string' | 'bool' | 'image' | 'video';

const SCALAR_KINDS: ReadonlySet<string> = new Set(['float', 'int', 'string', 'bool']);

/** True iff `kind` is a scalar (keyframe-channel) controller, not a media bind. */
export function isScalarControllerKind(kind: string): kind is BasherControllerKind {
  return SCALAR_KINDS.has(kind);
}

/** One declared controller, read from a `basher_controller` node's own inputs. The
 *  `nodeId` is the V57 channel target's address; `name` labels the Controls row;
 *  `kind` picks the channel/interp type; `defaultValue` is the resting value when no
 *  channel is bound (parsed from the node's authored `values_json`, first element). */
export interface BasherControllerDecl {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: BasherControllerKind;
  readonly defaultValue: number | string | boolean;
}

function str(v: ComfyInputValue | undefined, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Parse the node's authored `values_json` first element as the resting value — the
 *  value the control holds before Basher binds a channel. Falls back per kind. */
function defaultFor(kind: BasherControllerKind, valuesJson: ComfyInputValue | undefined) {
  let first: unknown;
  if (typeof valuesJson === 'string') {
    try {
      const arr = JSON.parse(valuesJson);
      if (Array.isArray(arr) && arr.length > 0) first = arr[0];
    } catch {
      // malformed → use the per-kind fallback below
    }
  }
  if (kind === 'bool') return typeof first === 'boolean' ? first : false;
  if (kind === 'string') return typeof first === 'string' ? first : '';
  if (kind === 'int') return typeof first === 'number' ? Math.round(first) : 0;
  // float (image/video have no scalar default — reported as 0, unused for media)
  return typeof first === 'number' ? first : 0;
}

/** Enumerate every `basher_controller` node in a workflow, in stable (nodeId) order.
 *  Reads ONLY those nodes' own declared inputs (name/kind/values_json) — never a
 *  foreign node. A node missing `name`/`kind` falls back to its id / 'float'. */
export function scanBasherControllers(apiJson: ComfyApiJson): BasherControllerDecl[] {
  const out: BasherControllerDecl[] = [];
  for (const nodeId of Object.keys(apiJson)) {
    const node = apiJson[nodeId];
    if (!node || node.class_type !== BASHER_CONTROLLER_TYPE || !node.inputs) continue;
    const rawKind = str(node.inputs.kind, 'float');
    const kind: BasherControllerKind = (
      ['float', 'int', 'string', 'bool', 'image', 'video'] as const
    ).includes(rawKind as BasherControllerKind)
      ? (rawKind as BasherControllerKind)
      : 'float';
    out.push({
      nodeId,
      name: str(node.inputs.name, nodeId),
      kind,
      defaultValue: defaultFor(kind, node.inputs.values_json),
    });
  }
  out.sort((a, b) => a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
  return out;
}

/** Write each controller's baked per-frame array into its `values_json` + `frame_count`
 *  inputs (the inline transport for scalar kinds). Deep-clones — the source graph is
 *  never mutated. A controller id with no entry keeps its authored values; an entry for
 *  a non-controller node, or one whose `values_json` is now a wired link, is skipped.
 *  This is the entire submit-time compile: the author's wiring already routes the value
 *  to its target, so Basher only fills the node's own payload. */
export function writeBasherControllerValues(
  apiJson: ComfyApiJson,
  valuesById: Readonly<Record<string, readonly (number | string | boolean)[]>>,
): ComfyApiJson {
  const out = structuredClone(apiJson) as ComfyApiJson;
  for (const nodeId of Object.keys(valuesById)) {
    const node = out[nodeId];
    if (!node || node.class_type !== BASHER_CONTROLLER_TYPE || !node.inputs) continue;
    if (isComfyLink(node.inputs.values_json)) continue;
    const values = valuesById[nodeId];
    const inputs = node.inputs as Record<string, ComfyInputValue>;
    inputs.values_json = JSON.stringify(values);
    inputs.frame_count = Math.max(1, values.length);
  }
  return out;
}
