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
// The DAG node, EXPLICITLY: `Node` unqualified resolves to the DOM's in this project,
// and the mistake type-checks — a `Node & { type: … }` annotation silently becomes an
// intersection with `Element`'s ancestor and every field read below stops compiling for
// the wrong reason. Caught while fixing #674.
import type { Node } from '../core/dag/types';
import type { MaterialOverrideField, ObjectData } from '../nodes/types';
import type { MaterialOverrideOpParams } from '../nodes/MaterialOverrideOp';
import { overrideValueOf } from '../nodes/MaterialOverrideOp';
import { evaluate } from '../core/dag/evaluator';
import { requireNodeType } from '../core/dag/registry';
import { isBypassed } from '../core/dag/chainBypass';
import {
  isDataLaneOperator,
  isMaterialLaneOperator,
  isPoserNode,
  singleRef,
  type MaterialLaneType,
} from './operatorChain';
import { modifierDataSource } from './modifierDataSource';
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

/** The six fields, derived from the IR-path table so the two cannot drift apart. */
export const MATERIAL_OVERRIDE_FIELDS = Object.keys(
  MATERIAL_FIELD_IR_PATH,
) as readonly MaterialOverrideField[];

/**
 * Which fields the material-lane operator `opId` masks, and where a write to each belongs.
 *
 * ⚠️ ALL SIX FIELDS IN ONE CALL, and that is a correctness-shaped performance property,
 * not a micro-optimisation. This function EVALUATES (`mapPresenceBelow`), and the
 * evaluator hashes params before its cache lookup — the shape behind the measured ~458ms
 * inspector edit lag ([[H48]], #498). Asked once per field it evaluates six times per
 * operator; asked once per ROW, as a naive label implementation would, it evaluates once
 * per widget. Answering the whole set from a single `resolveMaterialOverrideFields` call
 * is what keeps the cost proportional to the LANE rather than to the panel.
 *
 * The switch closes on a `never` over `MaterialLaneType` ([[V109]]): a new material
 * operator added to `MATERIAL_LANE_TYPES` without an arm here is a COMPILE ERROR, not a
 * silently-transparent layer. That is the structural guard, because the failure mode of
 * a missing arm is invisible — the write succeeds against the layer below and nothing
 * changes on screen.
 *
 * 🔴 #674 — THAT SENTENCE WAS FALSE FOR AS LONG AS IT HAS BEEN WRITTEN, AND IT WAS THE
 * REASON THIS LIST WAS KEPT. Measured while ns-2 step 7 retired the sibling lists: a third
 * member added to `MATERIAL_LANE_TYPES` with no arm here compiled clean. Two casts each
 * independently disabled the check — `node.type as never` assigns to `never` from ANY type,
 * so the default arm compiled whatever was unhandled, and `node.type as MaterialLaneType`
 * asserted the discriminant instead of narrowing it. Both existed because the CALLER
 * narrows (`isMaterialLaneOperator`) and then passed an ID, so this function re-looked the
 * node up and got `type: string` back.
 *
 * ⇒ it takes the NARROWED NODE now. No casts, and the guarantee is the one the paragraph
 * above always claimed. A guard that is believed is worse than a missing one: nobody
 * re-derives a check that is already documented as covered.
 */
function maskedFieldsOf(
  state: DagState,
  node: Node & { type: MaterialLaneType },
): Partial<Record<MaterialOverrideField, MaterialFieldOwner>> {
  const opId = node.id;
  const params = node.params as Record<string, unknown>;
  // A bypassed layer is byte-identically no layer (V58) — it masks nothing.
  //
  // This was `(node.params as Record<string, unknown>).muted === true` — the SECOND
  // honouring site in the operator lane, and the one a census of unchecked casts could
  // not see, because it is not a cast: it reads a typed record under a literal field
  // name. That is what made it survive the consolidation that introduced `chainInput`
  // and would have made it survive this one — a walker still reading the raw field after
  // the field stopped being the declaration is exactly the "stops one lane short" shape
  // ns-2 exists to end, and it is silent, because the two spellings agree today.
  if (isBypassed(requireNodeType(node.type), node.params)) return {};

  const out: Partial<Record<MaterialOverrideField, MaterialFieldOwner>> = {};
  switch (node.type) {
    case 'SetMaterialOp': {
      // Wholesale replace: it masks EVERY field, and its authority for each of them is
      // the Material node on its socket. Nothing connected ⇒ the operator is transparent
      // (its `evaluate` passes the source through), so it owns nothing.
      const ref = singleRef(node, 'material');
      if (!ref) return {};
      const producer = state.nodes[ref.node]?.params as Record<string, unknown> | undefined;
      // Self-checking, exactly like the second hop in `resolveDataParamOwner`: only claim
      // the producer as the owner when it actually carries a writable material param.
      if (!producer || !('material' in producer)) return {};
      for (const field of MATERIAL_OVERRIDE_FIELDS) {
        out[field] = { nodeId: ref.node, paramPath: MATERIAL_FIELD_IR_PATH[field] };
      }
      return out;
    }
    case 'MaterialOverrideOp': {
      // ONE call, six answers — see the note above.
      const fields = resolveMaterialOverrideFields(
        overrideValueOf(params as unknown as MaterialOverrideOpParams),
        mapPresenceBelow(state, opId),
        (params as unknown as MaterialOverrideOpParams).overridden,
        // The data lane — the layer below is another authored layer, never a source
        // material. Must match what `MaterialOverrideOp.evaluate` composes with, or the
        // oracle and the render disagree about who owns a field, which is the class of
        // defect this whole resolver exists to close.
        'authored-only',
      );
      for (const field of MATERIAL_OVERRIDE_FIELDS) {
        // `null` ⇒ the layer below keeps the channel ⇒ this layer is transparent for it.
        //
        // #529 made this uniform. It used to special-case roughness/metalness and answer
        // `true` for the other four, because the tints really were always applied — so an
        // override op with DEFAULT params reported that it owned `color`, and the
        // inspector labelled the base row "Set by <op>" when the op had authored nothing.
        // Now every field answers the same way, off the same call.
        if (fields[field] !== null) out[field] = { nodeId: opId, paramPath: field };
      }
      return out;
    }
    default: {
      const exhaustive: never = node.type;
      void exhaustive;
      return {};
    }
  }
}

/**
 * The owner of EVERY material field for the scene object (or data node, or operator) `id`,
 * in one walk.
 *
 * Walks the data lane from the top of the stack downwards; for each field, the first layer
 * that masks it wins. With no material operator in the chain every field resolves to
 * exactly what `resolveDataParamOwner(state, id, 'material')` returns, with that field's IR
 * path — so this is a strict extension of the shipped reach, not a competing one.
 *
 * This is the form the inspector's masking labels consume: the projection asks ONCE per
 * chain and distributes the answers over its rows, never once per row.
 */
export function resolveMaterialFieldOwners(
  state: DagState,
  id: string,
): Readonly<Record<MaterialOverrideField, MaterialFieldOwner | null>> {
  const out = Object.fromEntries(MATERIAL_OVERRIDE_FIELDS.map((f) => [f, null])) as Record<
    MaterialOverrideField,
    MaterialFieldOwner | null
  >;
  const node = state.nodes[id];
  if (!node) return out;

  let remaining = MATERIAL_OVERRIDE_FIELDS.length;
  // The TOP of the stack: a poser names it through `data`; anything else is already in
  // the chain (a selected operator, or a bare data node with no stack at all).
  let cur: string | undefined = isPoserNode(node) ? singleRef(node, 'data')?.node : id;
  const seen = new Set<string>();
  while (cur && remaining > 0 && isDataLaneOperator(state.nodes[cur]) && !seen.has(cur)) {
    seen.add(cur);
    const op = state.nodes[cur];
    if (isMaterialLaneOperator(op)) {
      const masked = maskedFieldsOf(state, op);
      for (const field of MATERIAL_OVERRIDE_FIELDS) {
        const owner = masked[field];
        if (owner && out[field] === null) {
          out[field] = owner;
          remaining -= 1;
        }
      }
    }
    // A geometry modifier is transparent to material by construction — it INHERITS the
    // source's material (`ArrayModifier.ts:76`) rather than having an opinion on it.
    cur = singleRef(state.nodes[cur], 'target')?.node;
  }

  if (remaining > 0) {
    const baseOwner = resolveDataParamOwner(state, id, 'material');
    if (baseOwner) {
      for (const field of MATERIAL_OVERRIDE_FIELDS) {
        if (out[field] === null) {
          out[field] = { nodeId: baseOwner, paramPath: MATERIAL_FIELD_IR_PATH[field] };
        }
      }
    }
  }
  return out;
}

// #394 P5 — THE SINGLE-FIELD ENTRY POINT IS GONE, and its absence is the point.
//
// `resolveMaterialFieldOwner(state, id, field)` existed for the write roads that ask about
// one field (`setMaterialColor`, `randomize`). Those roads now ask `resolveExposedTarget`,
// which answers for ANY param — material or not — off the same projection the inspector's
// rows come from. Keeping a material-only spelling beside it would put two functions in the
// codebase that answer "who owns this?" for the same caller, which is the shape this
// module's own header is about.
//
// What survives here is the whole-set walk, and it survives because it is a DIFFERENT
// question: the projection asks it once per chain to label its rows, and it must stay a
// six-answers-in-one-walk shape for that to be affordable at all.
