/**
 * WHICH CONTROL A PARAM WANTS, DECLARED BY ITS SCHEMA (#872).
 *
 * ── THE PROBLEM THIS EXISTS FOR ───────────────────────────────────────────────────────
 *
 * `ParamRow` (`src/app/NPanel.tsx`) chooses a control by looking at the param's RUNTIME
 * VALUE: number → a numeric field, vec3 → a vector field, boolean → a toggle, string → an
 * enum dropdown IF the schema declares one, and otherwise a read-only span. A value cannot
 * say what it is for. `'0-5'`, `'#00ff88'` and `'Camera_01'` are the same `string` at
 * runtime, and they want three different controls, so every one of them lands on the
 * read-only arm and cannot be authored at all.
 *
 * That arm is why six operators can carry a component scope that no director can type, and
 * why a material override's colour renders as text (#521).
 *
 * ── WHY THE DECLARATION LIVES ON THE SCHEMA AND NOT ON THE NODE ───────────────────────
 *
 * The obvious home is the node definition, which is what `chainInput`/the spine field
 * argues for at `src/core/dag/types.ts` — declare it, do not derive it. That reasoning is
 * right and this module keeps it; the only question is WHICH declaration site, and for a
 * param the answer differs from a socket.
 *
 * A socket's role is a property of the NODE: `target` means something different on a
 * modifier than on a poser, so each node must say. A param's widget is a property of the
 * PARAM TYPE: `scope` is the same field wherever it appears, and it appears six times
 * today (`ArrayModifier`, `BevelModifier`, `MaskModifier`, `MirrorModifier`,
 * `MaterialOverrideOp`, `SetMaterialOp`) through ONE shared helper, `scopeParam()`.
 * Declaring the widget per node would spell one fact six times, which is precisely the
 * failure the spine comment names — "spelled five times and declared nowhere" — and
 * exactly what #680 already corrected once for this same param, centralising the scope
 * schema only after five files had copied it. A seventh operator calling `scopeParam()`
 * gets the control for free, and cannot forget to ask for it.
 *
 * ── WHY A SIDE TABLE RATHER THAN A FIELD ON THE SCHEMA ────────────────────────────────
 *
 * zod 3 has no `.meta()`. The one carrier it does offer, `.describe()`, is ALREADY TAKEN:
 * 16 files use it, all under `src/agent`, as the natural-language descriptions the LLM
 * reads off a tool schema. Overloading it would put two unrelated readers on one string
 * and make the agent road's descriptions load-bearing for the inspector's layout.
 *
 * So the association is a `WeakMap` keyed by the schema object. Weak on purpose: it holds
 * no schema alive, and a schema built per call (as `scopeParam()` is) is registered on the
 * instance the node definition actually stores, which is the same instance the inspector
 * later reads back out of `paramSchema.shape`.
 */

import { z } from 'zod';

/**
 * The controls a declared param can ask for.
 *
 * ONE MEMBER TODAY, deliberately. `'query'` is the component-selection field — a free-text
 * control over a small query language whose refusals are named. A colour picker (#521) is
 * the next member and is NOT added here on speculation: it needs its own widget and its own
 * row, and adding the name before the row exists would make this union a wish list rather
 * than a census of what the panel can actually draw. The `never` in the panel's exhaustive
 * switch is what forces the next member to be answered for at the site that must draw it.
 */
export type ParamWidget = 'query';

/**
 * Schema instance → the control it asks for.
 *
 * Weak so registering a widget never extends a schema's lifetime. Keyed on the object the
 * node definition stores, so the lookup at render time is an identity hit, not a structural
 * guess about what a schema "looks like".
 */
const WIDGETS = new WeakMap<object, ParamWidget>();

/**
 * Declare that `schema` is authored with `kind`, and return the SAME schema.
 *
 * Returns the identical instance rather than a wrapper so it composes with nothing: a
 * declared schema validates exactly as it did undeclared, and a caller that ignores this
 * function's return value still gets a registered schema. The widget is presentation and
 * must never be able to change what the schema accepts.
 */
export function widget<S extends z.ZodTypeAny>(kind: ParamWidget, schema: S): S {
  WIDGETS.set(schema, kind);
  return schema;
}

/**
 * The control this schema asks for, or `undefined` if it declares none.
 *
 * Undefined is the honest answer for every param that has not been given a widget yet — the
 * panel keeps its existing behaviour for those, so this is additive and no param changes
 * its control by being near one that did.
 */
export function widgetOf(schema: unknown): ParamWidget | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  return WIDGETS.get(schema);
}
