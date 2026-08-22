// objectSlotAuthoring — the OBJECT-side slot table as an authoring surface (#645 P6).
//
// ── WHAT THIS IS THE AUTHORING HALF OF ────────────────────────────────────────────────
//
// #645 gave `ObjectValue` a sparse per-slot override and moved the derivation so the
// renderer and the read side both resolve through `objectSlotsOf`. P4 gave the AGENT a way
// to ask for one. Until this file there was still no way for a DIRECTOR to: the capability
// shipped, the pixels moved, and the only road to them was a plan.
//
// This module is the pure half — what the panel would draw, and the ops the two acts
// dispatch. The chrome lives in `NPanel.tsx` beside its siblings (`SlotSelector`,
// `GltfMaterialEditor`), the same split `materialLink.ts` ↔ `MaterialLinkControls.tsx` has.
//
// ── WHY THE COUNT COSTS AN EVALUATION, WHICH IS A DELIBERATE EXCEPTION ────────────────
//
// An Object's slot count is its DATA's — that is the reference's model and it is what makes
// an out-of-range override a no-op rather than a way to grow the table from the object side.
// But "how many slots does this object's data declare" is not answerable from shape: the
// table is whatever the modifier and material chain produced, so only the resolved value
// knows. `setObjectSlotMaterial`'s precondition pays the same cost for the same reason, and
// the alternative is not a cheaper check — it is no check, and a surface that offers an
// index resolving to nothing.
//
// ⚠️ Call these from a COMPONENT BODY, never from a zustand selector. Same rule
// `resolveDataKind` and `canWearMaterial` carry, and for the same reason.
//
// ── THE REFUSAL IS STRUCTURAL HERE, AND THAT IS NOT THE WHOLE OF IT ───────────────────
//
// The agent road refuses an out-of-range index with a message, because a spec can name any
// integer. This road cannot be asked one: the rows ARE the data's slots, so there is no
// index to offer that the table does not have. That is the stronger form of the same
// refusal — unrepresentable rather than rejected.
//
// 🔴 BUT AN OVERRIDE CAN GO OUT OF RANGE AFTER IT IS WRITTEN, and that case is the reason
// {@link ObjectSlotTable} has a second field. Write an override on slot 2, then let the data
// drop to one slot — the entry survives in params, resolves to nothing, and draws nothing.
// A surface that listed only the live rows would hide it, which is the silently-dropped
// write this whole area exists to stop, arriving one edit later instead. So stale entries
// are surfaced and clearable. `SlotSelector` keeps the same escape hatch for the same
// reason, one addressing dimension over.
//
// REF: src/app/materialAssignment.ts (`objectSlotsOf` — the ONE derivation and its
//      precedence rule); src/agent/mutators/builders/setObjectSlotMaterial.ts (the agent
//      half of this same capability); src/nodes/ObjectNode.ts (`slotOverrides` — why a
//      record, and why absent by default). Issues #645, #638, #646.

import type { DagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import type { InlineMaterialSpec } from '../nodes/types';
import { hydrateInlineMaterial, isBakedMaterialSpec } from '../nodes/materialSchema';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import type { EvaluatorCache } from '../core/dag/evaluator';

/** One row of the Object's slot list — one slot of the DATA's table, as this Object sees it. */
export interface ObjectSlotRow {
  readonly index: number;
  /** This Object re-points the slot — the reference's `link == OBJECT`. */
  readonly overridden: boolean;
  /** The colour the slot RESOLVES to, after the override if there is one. For the swatch. */
  readonly color: string;
  /** The resolved slot's material name, when it has one. */
  readonly name: string | null;
}

/**
 * What the panel draws for one Object.
 *
 * `rows` is one entry per slot the DATA declares — the table's length is the data's, which
 * is the rule stated at the derivation. `stale` is every override key past that length: an
 * entry that resolves to nothing today, kept visible so it can be cleared rather than
 * hidden while it silently does nothing.
 */
export interface ObjectSlotTable {
  readonly rows: readonly ObjectSlotRow[];
  readonly stale: readonly number[];
}

/** The record as it sits in params, or an empty one. Never mutated. */
function overridesOf(state: DagState, objectId: string): Readonly<Record<string, unknown>> {
  const params = state.nodes[objectId]?.params as
    | { slotOverrides?: Record<string, unknown> }
    | undefined;
  return params?.slotOverrides ?? {};
}

/** Decimal-integer keys only — the schema's own regex, read back. */
function overriddenIndices(state: DagState, objectId: string): readonly number[] {
  return Object.keys(overridesOf(state, objectId))
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * A slot's colour, whichever of the three shapes it arrived in.
 *
 * The resolved table carries `InlineMaterialSpec | BakedMaterialSpec | null`, and the swatch
 * has to say something for all three. Inline keeps its colour under `base`, a bake flattens
 * it to a top-level `color`, and `null` is a slot no material reached — drawn as the same
 * standard grey the renderer falls back to, because that IS what the screen shows.
 */
function colorOfSlot(slot: unknown): string {
  if (slot && isBakedMaterialSpec(slot)) return slot.color;
  const inline = slot as { base?: { color?: unknown } } | null | undefined;
  const c = inline?.base?.color;
  return typeof c === 'string' ? c : hydrateInlineMaterial(null).base.color;
}

function nameOfSlot(slot: unknown): string | null {
  const n = (slot as { name?: unknown } | null | undefined)?.name;
  return typeof n === 'string' && n.length > 0 ? n : null;
}

/**
 * The Object's slot list, or null when there is nothing to slot.
 *
 * Null is a real answer and it is not an error: an Empty Object has no data, and a camera or
 * a light has data that no material describes. The caller says so on screen rather than
 * drawing an empty card.
 */
export function objectSlotTable(
  state: DagState,
  objectId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): ObjectSlotTable | null {
  const node = state.nodes[objectId];
  if (!node || node.type !== 'Object') return null;
  const mesh = resolveEvaluatedMesh(state, objectId, ctx, cache);
  if (!mesh) return null;

  const slots = mesh.materials.slots;
  const overridden = new Set(overriddenIndices(state, objectId));
  const rows = slots.map((slot, index) => ({
    index,
    overridden: overridden.has(index),
    color: colorOfSlot(slot),
    name: nameOfSlot(slot),
  }));
  // Past the DATA's length — see the header. Derived from the same two numbers the
  // derivation uses, so it cannot disagree with what `objectSlotsOf` dropped.
  const stale = [...overridden].filter((i) => i >= slots.length);
  return { rows, stale };
}

/**
 * Take slot `index` over — write `link == OBJECT` for it.
 *
 * SEEDED FROM THE RESOLVED SLOT, not from a default. Taking a slot over should change no
 * pixel until the director edits it: the act being authored is "this slot is now mine",
 * and folding a colour change into it makes the two impossible to tell apart on screen.
 * Seeding from the resolved inline spec also keeps the roughness, metalness and every other
 * lobe the data had — hydrating from a colour would silently drop them, which is the same
 * half-built-material failure the agent builder's own note warns about.
 *
 * A baked or absent slot has no inline spec to copy, so it hydrates from that slot's colour:
 * the closest thing to "unchanged" the override's type can express.
 *
 * Null when the index is not a slot this object has — offer == accept, asked once here so
 * the panel cannot advertise a write this refuses ([[V108]]).
 */
export function buildOverrideSlotOp(
  state: DagState,
  objectId: string,
  index: number,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Op | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const node = state.nodes[objectId];
  if (!node || node.type !== 'Object') return null;
  const mesh = resolveEvaluatedMesh(state, objectId, ctx, cache);
  if (!mesh) return null;
  const slot = mesh.materials.slots[index];
  if (slot === undefined) return null;

  const seed: InlineMaterialSpec =
    slot !== null && !isBakedMaterialSpec(slot)
      ? hydrateInlineMaterial(slot)
      : hydrateInlineMaterial(null, colorOfSlot(slot));

  // The SAME op shape `setObjectSlotMaterial` builds. One act, one spelling — a UI that
  // wrote the whole record here and an agent that wrote one key would be two roads to the
  // same state, which is how they drift.
  return { type: 'setParam', nodeId: objectId, paramPath: `slotOverrides.${index}`, value: seed };
}

/**
 * Hand slot `index` back to the data — remove the entry, restoring `link == DATA`.
 *
 * A WHOLE-RECORD REPLACE, and it has to be: there is no op that deletes a key from a param,
 * and writing `undefined` at `slotOverrides.<i>` leaves the key present with a value the
 * schema rejects. So the record is rebuilt without it.
 *
 * ⚠️ REMOVING THE LAST ONE LEAVES `{}`, DELIBERATELY. `ObjectNode.evaluate` normalises an
 * empty record to an ABSENT field on the value, so "this Object overrides nothing" keeps one
 * spelling downstream whatever shape the param holds. Special-casing it here would put the
 * normalisation in two places, and the one that ships is the one on the value.
 *
 * Null when there is nothing to clear — offer == accept again, so a row without an override
 * cannot dispatch a no-op write.
 */
export function buildClearSlotOverrideOp(
  state: DagState,
  objectId: string,
  index: number,
): Op | null {
  const node = state.nodes[objectId];
  if (!node || node.type !== 'Object') return null;
  const cur = overridesOf(state, objectId);
  const key = String(index);
  if (!(key in cur)) return null;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (k !== key) next[k] = v;
  }
  return { type: 'setParam', nodeId: objectId, paramPath: 'slotOverrides', value: next };
}
