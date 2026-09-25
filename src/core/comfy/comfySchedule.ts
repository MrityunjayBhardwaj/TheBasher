// comfySchedule — which of a workflow's params a keyframe channel reaches (#1066).
//
// A channel on a ComfyUIWorkflow node does something only when the batch compile reads its
// path, and the compile reads one of two sets depending on the workflow:
//   - Mode A (the workflow declares `basher_controller` nodes): the scalar controllers'
//     `controller:<id>` paths, and NOTHING under `comfy:` — a keyed foreign input is ignored.
//   - Mode B (a vanilla workflow): every non-structural float/int/string input's
//     `comfy:<node>.<input>` path.
// Image and video inputs bind out-of-band and read no channel (#1257).
//
// The compile (`src/app/video/compileComfyBatch.ts`) and the channel pickers both ask the
// predicates below, so a path the picker offers is a path the batch bakes, and a mode switch
// moves both at once. Measured: a keyed Mode-B `cfg` and prompt change the baked batch; a
// keyed `LoadImage.image` produces no track (2026-09-26).
//
// REF: src/app/video/compileComfyBatch.ts (the bake + the mode branch); issues #1066, #1257.

import {
  comfyControllerPath,
  hasBasherControllers,
  isScalarControllerKind,
  scanBasherControllers,
} from './basherControllers';
import {
  comfyParamPath,
  importComfyGraph,
  isStructuralParam,
  type ComfyApiJson,
  type ComfyGraphMeta,
  type ComfyParam,
} from './comfyGraph';

/** Mode B's filter: an input the batch bakes into a per-frame track. */
export function isBakedTrackParam(param: ComfyParam): boolean {
  if (isStructuralParam(param.classType, param.inputName)) return false;
  return param.valueKind === 'float' || param.valueKind === 'int' || param.valueKind === 'string';
}

/** The channel value a scheduled path takes: numbers for float/int, text for string. */
export type ComfyChannelKind = 'number' | 'text';

export interface ComfyScheduledPath {
  readonly path: string;
  readonly kind: ComfyChannelKind;
  /** What a director reads: the node's class and input, or the controller's name. */
  readonly label: string;
}

function channelKindOf(valueKind: string): ComfyChannelKind | null {
  if (valueKind === 'float' || valueKind === 'int') return 'number';
  if (valueKind === 'string') return 'text';
  // bool is baked in Mode A, but no keyframe channel carries a bool.
  return null;
}

/** Every path the batch compile reads a channel from, for this workflow. */
export function comfyScheduledPaths(
  apiJson: ComfyApiJson,
  meta: ComfyGraphMeta,
): ComfyScheduledPath[] {
  const out: ComfyScheduledPath[] = [];
  if (hasBasherControllers(apiJson)) {
    for (const decl of scanBasherControllers(apiJson)) {
      if (!isScalarControllerKind(decl.kind)) continue;
      const kind = channelKindOf(decl.kind);
      if (kind)
        out.push({
          path: comfyControllerPath(decl.nodeId),
          kind,
          label: `controller ${decl.name}`,
        });
    }
    return out;
  }
  for (const param of importComfyGraph(apiJson, meta).params) {
    if (!isBakedTrackParam(param)) continue;
    const kind = channelKindOf(param.valueKind);
    if (kind)
      out.push({
        path: comfyParamPath(param.nodeId, param.inputName),
        kind,
        label: `${param.classType} #${param.nodeId} · ${param.inputName}`,
      });
  }
  return out;
}
