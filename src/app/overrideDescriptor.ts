// overrideDescriptor — the node-type → override-set metadata that GATES the
// NPanel per-field override decorator (#130 / Wave D, D-04).
//
// WHY a descriptor (not "decorate every param"): the decorator must appear ONLY
// on the fields a node's `overridden` set actually covers — NOT on `name`,
// `assetRef`, `childName`, `ignoreSourceMaterial`, etc. Without the gate the dot
// + revert affordance would over-reach every param (the MED risk in PLAN.md).
// The descriptor names exactly (a) which param holds the authored set and (b)
// which param paths it covers, so the decorator is opt-in per node type.
//
// THE CONSOLIDATION DIVIDEND (D-06): one descriptor table drives the SAME
// affordance for BOTH consumers of the shared `overrideSet` primitive —
// `MaterialOverride.overridden` (sparse, #124) and `GltfChild.overridden` (the
// TRS record, since 7.7). Before this, both rendered as the identical
// `(complex — Pro mode)` ParamRow fallback.
//
// REF: PLAN.md Wave D (D1/D2); CONTEXT D-04; the shared primitive
//      `src/core/override/overrideSet.ts` ([[V28]]); `src/app/Gizmo.tsx`
//      writeGltfChildOverride (the symmetric set-true write path).

import {
  clearOverride,
  isOverridden,
  withOverride,
  type OverriddenSet,
} from '../core/override/overrideSet';

export interface OverrideDescriptor {
  /** The param path holding the authored set (always `overridden` today). */
  readonly setParamPath: string;
  /** The param paths the set covers — the decorator renders ONLY on these. */
  readonly fields: readonly string[];
  /**
   * Schema shape of the set. `sparse` ⇒ a `.partial()` zod record where a
   * cleared field can DROP its key (MaterialOverride). `record` ⇒ a full
   * fixed-key zod object where every key is required, so a cleared field must
   * stay present as `false` (GltfChild — dropping the key fails validation).
   * This is the ONLY reason revert needs two primitives (clearOverride vs
   * withOverride-false); both read identically through `isOverridden`.
   */
  readonly shape: 'sparse' | 'record';
}

const DESCRIPTORS: Readonly<Record<string, OverrideDescriptor>> = {
  MaterialOverride: {
    // ONLY roughness/metalness — the fields where the authored bit actually
    // changes behaviour. `resolveMaterialOverrideFields` consults the bit for
    // these two alone (force the scalar over a source map); color / opacity /
    // emissive / emissiveIntensity are ALWAYS-applied tints (default =
    // map-identity), so their bit is inert and a decorator there would imply an
    // inherit-vs-override choice that does not exist. Honest scope, not the full
    // schema (the zod set still ALLOWS the other keys — no migration).
    setParamPath: 'overridden',
    fields: ['roughness', 'metalness'],
    shape: 'sparse',
  },
  GltfChild: {
    setParamPath: 'overridden',
    fields: ['position', 'rotation', 'scale'],
    shape: 'record',
  },
};

/** The override descriptor for a node type, or null if it tracks no overrides. */
export function overrideDescriptor(nodeType: string): OverrideDescriptor | null {
  return DESCRIPTORS[nodeType] ?? null;
}

/** Read the authored set off a node's params (absent / non-object ⇒ empty). */
export function readOverriddenSet(
  params: Record<string, unknown> | undefined,
  setParamPath: string,
): OverriddenSet<string> {
  const v = params?.[setParamPath];
  return v && typeof v === 'object' ? (v as OverriddenSet<string>) : {};
}

/** Is `field` explicitly authored in the node's set? (the dot's filled state) */
export function isFieldOverridden(
  params: Record<string, unknown> | undefined,
  descriptor: OverrideDescriptor,
  field: string,
): boolean {
  return isOverridden(readOverriddenSet(params, descriptor.setParamPath), field);
}

/**
 * Build the reverted set for one field, RESPECTING the schema shape:
 *   - sparse → `clearOverride` drops the key (stays minimal; #124 partial set);
 *   - record → `withOverride(false)` keeps the key as `false` (GltfChild's
 *     fixed-key zod object would reject a missing key).
 * Both make `isOverridden` return false ⇒ the resolver falls back to source.
 * The renderer restores the live channel because BOTH consumers branch on this
 * explicit bit, never on value-equality (R-4 / [[V28]]) — so the dormant scalar
 * the field still holds is simply ignored.
 */
export function buildRevertedSet(
  current: OverriddenSet<string>,
  descriptor: OverrideDescriptor,
  field: string,
): OverriddenSet<string> {
  return descriptor.shape === 'sparse'
    ? clearOverride(current, field)
    : withOverride(current, field, false);
}
