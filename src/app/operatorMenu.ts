// operatorMenu — what a stack's "+ Add" menu offers, DERIVED from the declarations, with
// the wording and the reading order left where wording and order belong (ns-2 step 7).
//
// ── THE SPLIT THIS FILE EXISTS TO MAKE ────────────────────────────────────────────────
//
// Both stack panels used to carry a `const ADDABLE = [{type, label}, …]` — a hand-written
// list that answered TWO questions at once: *which operators does this stack offer* and
// *what do they read as*. Only the first is a membership claim, and only the first can be
// derived. Fusing them meant that forgetting a new operator's LABEL and forgetting its
// MEMBERSHIP were the same edit, so the cheap mistake carried the expensive consequence:
// the operator vanished from the panel entirely, silently, while continuing to register,
// evaluate and render.
//
// Split, the two failures separate cleanly:
//   • membership comes from `chain.section`, so it cannot be forgotten — it IS the
//     declaration that makes the thing an operator of that stack;
//   • a missing label costs a clumsy word in a menu, and the entry is still there.
//
// ── WHY LABELS ARE NOT DERIVED, MEASURED RATHER THAN ASSUMED ──────────────────────────
//
// `SetMaterialOp` → "Set Material" comes out right. `MaterialOverrideOp` → "Material
// Override" does not: that menu says "Override", because the panel it sits in is already
// the material stack and repeating the word is noise. One wrong in four is the lying-label
// rate this repo has paid for three times, so labels stay written down — which is also what
// `AddMenu.tsx` already does for all eighty node types. The fallback below is deliberately
// a FALLBACK, not a scheme: it exists so an unlabelled member is visible rather than
// missing, and it is expected to be overridden.
//
// REF: src/app/operatorChain.ts (`operatorTypesInSection` — the derivation and its lazy
//      throw); src/app/AddMenu.tsx (the precedent: labels live at the presentation layer);
//      src/app/ModifierStackControls.tsx + src/app/MaterialStackControls.tsx (the two
//      callers); src/app/operatorMembership.gate.test.ts; issues #607, #660.

import type { OperatorSection } from '../core/dag/types';
import { operatorTypesInSection } from './operatorChain';

export interface AddableOperator {
  readonly type: string;
  readonly label: string;
}

/**
 * A readable label for an operator nobody has written wording for: strip the category
 * suffix the type names carry and split the remaining camel case.
 *
 * `SubdivideModifier` → "Subdivide", `ColorCorrect` → "Color Correct". It is not trying to
 * be right — it is trying to be RECOGNISABLE, so that the menu entry is worth clicking
 * while the wording is still owed.
 */
export function fallbackOperatorLabel(type: string): string {
  return type
    .replace(/(?:Modifier|Op)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/**
 * The operators `section`'s stack offers, in the order `labels` names them, with any
 * derived member `labels` does not name appended (sorted, under a fallback label).
 *
 * THE ORDER IS THE MAP'S, AND THAT IS A DECISION. The material stack's two members read
 * SET then OVERRIDE — "set replaces the material flowing through, override authors a sparse
 * set of fields over it" — which is composition order, not alphabetical order, and no
 * registry knows it. Sorting the derived set instead would have quietly reversed that pair.
 * So the map keeps the order it was already keeping, and derivation decides only who is in
 * the list, never who is missing from it.
 */
export function addableOperators(
  section: OperatorSection,
  labels: Readonly<Record<string, string>>,
): AddableOperator[] {
  const members = new Set(operatorTypesInSection(section));
  const ordered: AddableOperator[] = [];
  for (const type of Object.keys(labels)) {
    if (members.delete(type)) ordered.push({ type, label: labels[type] });
  }
  for (const type of [...members].sort()) {
    ordered.push({ type, label: fallbackOperatorLabel(type) });
  }
  return ordered;
}
