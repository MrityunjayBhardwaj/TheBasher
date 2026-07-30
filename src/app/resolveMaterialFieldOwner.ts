// resolveMaterialFieldOwner — "which node owns THIS MATERIAL FIELD?" (#394 S3c).
//
// ── WHY THIS EXISTS: THE DEFECT THE LANE RE-MINTS ONE LAYER UP ──────────────────────
//
// `resolveDataParamOwner` resolves per param ROOT — it answers "who owns `material`?"
// and hops once to a linked Material node. That was the whole answer until the material
// operator lane landed. It is not any more:
//
//   BoxData ──▶ MaterialOverrideOp(color forced) ──▶ Object
//   Material ──────────────────▲ (wired into BoxData)
//
// `resolveDataParamOwner(state, object, 'material')` says the Material node. So
// `setMaterialColor` writes `material.base.color` there, the op composes over it, and the
// rendered colour does not move. The mutator reports success and changes nothing — the
// EXACT silent failure measured and fixed in `ac7c86f`, re-created by the lane's own
// feature. `MaterialOverriddenSet` is a PER-FIELD set, so authority genuinely varies
// field by field inside one material; a per-root answer cannot be right.
//
// So the reach is asked per FIELD: walk the stack from the TOP down, and the first layer
// that MASKS the field owns it. Nothing masks it → fall through to the per-root answer,
// which is still correct for the base.
//
// ── ONE DECISION, NOT A SECOND RULE ─────────────────────────────────────────────────
//
// "Does this layer mask the field?" is NOT re-derived here. It is read off
// `resolveMaterialOverrideFields` — the same function `composeMaterial` delegates to —
// because a `null` scalar in its result means exactly "the source keeps this channel"
// and anything else means "this layer wrote it". Re-deriving the map-aware condition
// would be a second spelling of the rule S3b deleted three spellings of.
//
// ── THE VOCABULARY BRIDGE ───────────────────────────────────────────────────────────
//
// The owner alone is not enough to write: a data node and a Material node store the
// field in the OpenPBR IR (`material.specular.roughness`), while an override op stores
// the flat scalar (`roughness`). So the answer carries the param path, and a caller
// never has to know which kind of node it landed on.
//
// ⚠️ THIS EVALUATES. Call it from a mutator's `build`/`preconditions` or a component
// body — NEVER from a zustand selector ([[H48]], the same warning `resolveDataKind`
// carries and for the same reason).
//
// REF: src/app/resolveDataParamOwner.ts (the per-root reach it extends, not replaces);
//      src/app/material/materialOverrideMerge.ts (the one decision); PLAN-2 §5; #394.

import type { DagState } from '../core/dag/state';
import type { MaterialOverrideField, ObjectData } from '../nodes/types';
import type { MaterialOverrideOpParams } from '../nodes/MaterialOverrideOp';
import { overrideValueOf } from '../nodes/MaterialOverrideOp';
import { evaluate } from '../core/dag/evaluator';
import {
  isDataLaneOperator,
  isMaterialLaneOperator,
  isPoserNode,
  singleRef,
  type MaterialLaneType,
} from './operatorChain';
import { modifierDataSource } from './modifierGeometry';
import {
  resolveMaterialOverrideFields,
  type MaterialMapPresence,
} from './material/materialOverrideMerge';
import { resolveDataParamOwner } from './resolveDataParamOwner';

/**
 * Where each override field lives in the OpenPBR IR — the ONE mapping between the flat
 * override vocabulary and the lobe-grouped param path. It is the same correspondence
 * `composeMaterial` writes as assignments; stated once here so a write road and the fold
 * cannot disagree about which lobe a field is.
 */
export const MATERIAL_FIELD_IR_PATH: Readonly<Record<MaterialOverrideField, string>> = {
  color: 'material.base.color',
  metalness: 'material.base.metalness',
  roughness: 'material.specular.roughness',
  opacity: 'material.geometry.opacity',
  emissive: 'material.emission.color',
  emissiveIntensity: 'material.emission.luminance',
};

/** The node a write to one material field must actually land on, and where on it. */
export interface MaterialFieldOwner {
  readonly nodeId: string;
  readonly paramPath: string;
}

const NO_MAPS: MaterialMapPresence = { roughnessMap: false, metalnessMap: false };

/**
 * The map presence of the material flowing INTO `opId` — the input the decision layer
 * needs, in the vocabulary each representation answers it in. Evaluating the operator's
 * `target` is what makes this the composed base AT THAT LAYER rather than the bottom of
 * the stack, which matters the moment two override ops sit on each other.
 */
function mapPresenceBelow(state: DagState, opId: string): MaterialMapPresence {
  const up = singleRef(state.nodes[opId], 'target');
  if (!up) return NO_MAPS;
  try {
    const value = evaluate(state, up.node).value as ObjectData | undefined;
    const material = value ? (modifierDataSource(value)?.material ?? null) : null;
    if (!material) return NO_MAPS;
    return 'materialClass' in material
      ? {
          roughnessMap: material.roughnessMap !== null,
          metalnessMap: material.metalnessMap !== null,
        }
      : {
          roughnessMap: material.maps.roughness !== null,
          metalnessMap: material.maps.metalness !== null,
        };
  } catch {
    // `evaluate` throws on a cycle / dangling ref / depth limit. An unevaluable source
    // defends no channel, which is the conservative answer here: it reports the op as
    // the owner, so a write lands on the layer the director can actually see.
    return NO_MAPS;
  }
}

/**
 * Does the material-lane operator `opId` mask `field` — and if so, where does a write to
 * that field belong?
 *
 * The switch closes on a `never` over `MaterialLaneType` ([[V109]]): a new material
 * operator added to `MATERIAL_LANE_TYPES` without an arm here is a COMPILE ERROR, not a
 * silently-transparent layer. That is the structural guard, because the failure mode of
 * a missing arm is invisible — the write succeeds against the layer below and nothing
 * changes on screen.
 */
function maskedBy(
  state: DagState,
  opId: string,
  field: MaterialOverrideField,
): MaterialFieldOwner | null {
  const node = state.nodes[opId];
  if (!node) return null;
  const params = node.params as Record<string, unknown>;
  // A muted layer is byte-identically no layer (V58) — it masks nothing.
  if (params.muted === true) return null;

  switch (node.type as MaterialLaneType) {
    case 'SetMaterialOp': {
      // Wholesale replace: it masks EVERY field, and its authority for each of them is
      // the Material node on its socket. Nothing connected ⇒ the operator is transparent
      // (its `evaluate` passes the source through), so it owns nothing.
      const ref = singleRef(node, 'material');
      if (!ref) return null;
      const producer = state.nodes[ref.node]?.params as Record<string, unknown> | undefined;
      // Self-checking, exactly like the second hop in `resolveDataParamOwner`: only claim
      // the producer as the owner when it actually carries a writable material param.
      if (!producer || !('material' in producer)) return null;
      return { nodeId: ref.node, paramPath: MATERIAL_FIELD_IR_PATH[field] };
    }
    case 'MaterialOverrideOp': {
      const fields = resolveMaterialOverrideFields(
        overrideValueOf(params as unknown as MaterialOverrideOpParams),
        mapPresenceBelow(state, opId),
        (params as unknown as MaterialOverrideOpParams).overridden,
      );
      // `null` ⇒ the source keeps the channel ⇒ this layer is transparent for it. Only
      // roughness/metalness can be null; the tint fields are always applied, which is
      // why an override op with default params still owns `color`.
      const written =
        field === 'roughness'
          ? fields.roughness !== null
          : field === 'metalness'
            ? fields.metalness !== null
            : true;
      return written ? { nodeId: opId, paramPath: field } : null;
    }
    default: {
      const exhaustive: never = node.type as never;
      void exhaustive;
      return null;
    }
  }
}

/**
 * The owner of one material FIELD for the scene object (or data node, or operator) `id`.
 *
 * Walks the data lane from the top of the stack downwards; the first layer that masks
 * the field wins. With no material operator in the chain this returns exactly what
 * `resolveDataParamOwner(state, id, 'material')` returns, with the field's IR path — so
 * it is a strict extension of the shipped reach, not a competing one.
 */
export function resolveMaterialFieldOwner(
  state: DagState,
  id: string,
  field: MaterialOverrideField,
): MaterialFieldOwner | null {
  const node = state.nodes[id];
  if (!node) return null;

  // The TOP of the stack: a poser names it through `data`; anything else is already in
  // the chain (a selected operator, or a bare data node with no stack at all).
  let cur: string | undefined = isPoserNode(node) ? singleRef(node, 'data')?.node : id;
  const seen = new Set<string>();
  while (cur && isDataLaneOperator(state.nodes[cur]) && !seen.has(cur)) {
    seen.add(cur);
    if (isMaterialLaneOperator(state.nodes[cur])) {
      const owner = maskedBy(state, cur, field);
      if (owner) return owner;
    }
    // A geometry modifier is transparent to material by construction — it INHERITS the
    // source's material (`ArrayModifier.ts:76`) rather than having an opinion on it.
    cur = singleRef(state.nodes[cur], 'target')?.node;
  }

  const baseOwner = resolveDataParamOwner(state, id, 'material');
  return baseOwner ? { nodeId: baseOwner, paramPath: MATERIAL_FIELD_IR_PATH[field] } : null;
}
