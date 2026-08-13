// #638 (ns-1b step 5) — hydrating an object's material SLOT TABLE, at a hook count that
// cannot vary.
//
// ── WHY A FIXED CAP RATHER THAN "ONE PER SLOT" ────────────────────────────────────────
//
// `usePrimitiveMaterial` is a hook, and it contains six unconditional `useBakedTexture`
// calls plus one `useLayoutEffect`. N slots would mean 6N suspending loads and N
// retain/release pairs at a hook count that varies with the data — which React forbids
// outright, not as a style rule: a table growing from two slots to three would change the
// hook order mid-tree and corrupt every hook's state after it.
//
// Three other shapes were priced and rejected (a child component per slot, an imperative
// build, a hook loop keyed by React `key`). This is the chosen one: a FIXED number of calls,
// paid only by meshes that actually declare a slot table. Every single-material mesh in the
// app keeps its exact current path — it never reaches this module.
//
// ── WHY THE CAP OVER-RENDERS RATHER THAN REFUSING ─────────────────────────────────────
//
// A table longer than the cap is REPORTED, and the first `MAX_MATERIAL_SLOTS` slots still
// render. Over-rendering keeps the screen; refusing blanks it, and a blank viewport with a
// banner is a worse answer than a partially-materialled mesh with the same banner. Note that
// the cap and the coverage arm compose without a special case: if a face actually points at
// a slot beyond the cap, that group is uncovered, so `resolveMeshMaterial` degrades the whole
// mesh to one material and says so. The screen is never blank on either road.
//
// ── WHY EVERY SLOT ATTACHES WITH NO MINTED KEY ────────────────────────────────────────
//
// The evaluator mints exactly one `materialKey` per mesh data value, and it describes the
// single `material` field — not the table. A slot table's entries have no minted identity
// because nothing mints one, so the honest argument is #545's, unchanged: the downstream
// fallback calls `materialKeyOf`, the evaluator's own function, over the evaluator's own IR.
// One function, one answer, no second spelling to drift. Passing `data.materialKey` for slot
// 0 would be worse than passing nothing — the table's slot 0 need not be the same IR as the
// `material` field, and attaching one IR under another's identity is the exact defect the
// render-identity work exists to prevent. This widening is counted, by module and by call,
// in `materialKeyReach.gate.test.ts` case D. Whether the AUTHORING surface should mint a key
// per slot is a real question and it belongs to the step that builds one.
//
// REF: src/app/material/usePrimitiveMaterial.ts (the seam, and the required-key argument);
//      src/app/resolveMeshMaterial.ts (what consumes the hydrated table);
//      src/nodes/materialKeyReach.gate.test.ts (case D counts these calls);
//      issues #638, #545, #536.

import type * as THREE from 'three';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { usePrimitiveMaterial } from './usePrimitiveMaterial';

/**
 * The most material slots one mesh can render with.
 *
 * Eight, and the number is a hook budget rather than a domain limit: each slot costs six
 * suspending texture loads and one retain/release pair, and the render band this is called
 * from is where this app's React cost is already measured as the knee. Both reference
 * systems allow more; a table longer than this reports and renders its first eight.
 */
export const MAX_MATERIAL_SLOTS = 8;

/**
 * Hydrate a slot table into materials, in TABLE ORDER, at a fixed hook count.
 *
 * Slot `i` of the result is slot `i` of the table — never compacted, never reordered, so a
 * group's `materialIndex` addresses the same slot the object declared. Empty slots hydrate
 * to `fallback` rather than to a hole: `material[i]` being `undefined` makes the renderer
 * skip those groups with no error at all.
 */
export function useSlotMaterials(
  slots: readonly (InlineMaterialSpec | null)[],
  fallback: InlineMaterialSpec,
  override: MaterialValue | undefined,
  shading: string,
): {
  readonly materials: readonly THREE.MeshPhysicalMaterial[];
  readonly capRefusal: string | null;
} {
  // Written out rather than looped, and that is the decision D5 records: a loop over a
  // module constant does call the hook the same number of times every render, but it needs
  // an eslint escape at the one seam whose whole argument is that hook counts are fixed —
  // and an escape is exactly how the next edit turns the constant into a variable.
  const m0 = usePrimitiveMaterial(slots[0] ?? fallback, override, shading, null);
  const m1 = usePrimitiveMaterial(slots[1] ?? fallback, override, shading, null);
  const m2 = usePrimitiveMaterial(slots[2] ?? fallback, override, shading, null);
  const m3 = usePrimitiveMaterial(slots[3] ?? fallback, override, shading, null);
  const m4 = usePrimitiveMaterial(slots[4] ?? fallback, override, shading, null);
  const m5 = usePrimitiveMaterial(slots[5] ?? fallback, override, shading, null);
  const m6 = usePrimitiveMaterial(slots[6] ?? fallback, override, shading, null);
  const m7 = usePrimitiveMaterial(slots[7] ?? fallback, override, shading, null);

  return {
    materials: [m0, m1, m2, m3, m4, m5, m6, m7],
    capRefusal:
      slots.length > MAX_MATERIAL_SLOTS
        ? `useSlotMaterials: this object declares ${slots.length} material slots and ${MAX_MATERIAL_SLOTS} is the cap — the first ${MAX_MATERIAL_SLOTS} render, and any face assigned beyond them degrades the mesh to a single material`
        : null,
  };
}
