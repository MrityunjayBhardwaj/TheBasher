// resolveColorWriteTarget — "where does a colour write for this target land?"
//
// Colour reaches a node by two different roads, and until #592 each caller spelled both by
// hand. A MESH carries colour inside the OpenPBR material IR, so the owner is whichever
// layer of the material chain currently forces `color` and the path rides with it
// (`material.base.color` on an IR node, the flat `color` scalar on an override operator).
// A LIGHT carries a flat `color` param instead, with no material anywhere.
//
// #592 — THE BUG THIS EXISTS TO MAKE UNREPEATABLE. Both colour mutators asked the two roads
// as `resolveExposedTarget(...) || typeof node.params.color === 'string'`. The first arm is
// split-aware; the second was a RAW READ of the node it was handed. Post-split a light's
// colour lives on the LightData while `identify` hands over the Object, and lights only ever
// travelled the second arm — so the whole director-facing path to recolour a light rejected
// at gate 4, while the same call aimed at the data half worked. The raw read is gone: the
// light road now reaches through `data` exactly as the material road always did.
//
// ONE function rather than a probe in each builder's precondition AND build (four hand-
// mirrored spellings, whose own comments said "mirror setMaterialColor.ts — DO NOT
// re-derive"). Two spellings that agree today pass every behavioural test and drift on the
// next split; the offer and the write are now the same answer by construction, not by
// discipline.
//
// REF: src/app/resolveDataParamOwner.ts (the split reach), src/app/exposeParams.ts
// (`resolveExposedTarget` — the material chain's per-field owner),
// src/app/resolveMaterialFieldOwner.ts (`MATERIAL_FIELD_IR_PATH`); issues #592, #365, #394.

import type { DagState } from '../core/dag/state';
import { resolveExposedTarget } from './exposeParams';
import { MATERIAL_FIELD_IR_PATH } from './resolveMaterialFieldOwner';
import { resolveDataParamOwner } from './resolveDataParamOwner';

/** The node a colour write must address, and the param path on it. */
export interface ColorWriteTarget {
  nodeId: string;
  paramPath: string;
}

/**
 * The owner of `color` for the scene object `id`, or null when the target has no colour at
 * all — which is exactly the condition a mutator precondition should reject on.
 *
 * Material is asked FIRST and the order is load-bearing: a mesh's data node carries
 * `material`, never a top-level `color`, so the light road cannot answer for a mesh — but a
 * material operator forcing `color` must win over anything further down, and only
 * `resolveExposedTarget` knows the chain's topmost layer.
 *
 * Both roads reach through the object↔data split, so a FUSED node (which owns its params
 * directly) and a SPLIT pair resolve identically — `resolveDataParamOwner` returns the
 * node's own id when it carries the param, which is what keeps coexistence working.
 */
export function resolveColorWriteTarget(state: DagState, id: string): ColorWriteTarget | null {
  // Mesh road: per FIELD, because a material operator in the stack can force `color` over
  // whatever the data node or a linked Material node says. Asking per param ROOT here would
  // write a masked layer and report success.
  const matOwner = resolveExposedTarget(state, id, MATERIAL_FIELD_IR_PATH.color);
  if (matOwner) return { nodeId: matOwner.nodeId, paramPath: matOwner.paramPath };

  // Light road: a flat `color` param, on the LightData for a split light and on the node
  // itself for a fused one. This reach is the whole of #592.
  const lightOwner = resolveDataParamOwner(state, id, 'color');
  if (lightOwner) return { nodeId: lightOwner, paramPath: 'color' };

  return null;
}
