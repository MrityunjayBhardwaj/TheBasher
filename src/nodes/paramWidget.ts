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
 * `'query'` is the component-selection field — a free-text control over a small query
 * language whose refusals are named. `'color'` (#521) is the swatch-plus-hex row the
 * material editor already draws, and it was added the way this comment said it would be:
 * the member first, then the `never` in the panel's exhaustive switch reddening at the site
 * that has to draw it, then the row. Observed — `Type '"color"' is not assignable to type
 * 'never'` — rather than assumed, which is the only thing that makes the forcing function a
 * fact rather than an intention.
 *
 * `'text'` (#1027) is a plain authored string that is not an enum, a colour or a query — a
 * component group's NAME, the first param of that shape in the repo. It is here because the
 * fall-through arm this module exists to close was still swallowing it: a bare `z.string()`
 * renders as a READ-ONLY span, so the operator shipped offered in the Add menu with the one
 * field that makes it do anything un-typeable. Measured in self-review, not predicted — and it
 * is the same "advertised action that silently does nothing" shape the panel refuses elsewhere.
 *
 * A member is still not added on speculation: the name and the row land together, so this
 * union stays a census of what the panel can actually draw rather than a wish list.
 */
export type ParamWidget = 'query' | 'color' | 'text';

/**
 * Schema instance → the control it asks for.
 *
 * Weak so registering a widget never extends a schema's lifetime. Keyed on the object the
 * node definition stores, so the lookup at render time is an identity hit, not a structural
 * guess about what a schema "looks like".
 */
const WIDGETS = new WeakMap<object, ParamWidget>();

/**
 * Schema instance → what its EMPTY state should be called, when the param has an opinion.
 *
 * 🔴 SEPARATE FROM THE KIND BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and conflating them is
 * the defect this pair exists to prevent. The kind says which control to draw; the
 * placeholder says what BLANK MEANS, and blank means something different per param even when
 * the control is identical. A blank scope is "all", a blank group name is "unnamed", a blank
 * prompt is just empty. The `text` arm was introduced (#1027) with the group name's word
 * hardcoded at the draw site, so every param that later asked for the same control inherited
 * the wrong sentence — a prompt field reading "unnamed". Found in self-review of #1031, at
 * the moment seven more params joined that arm.
 *
 * Weak and keyed by identity for {@link WIDGETS}' reasons. Absent is a real answer: the draw
 * site supplies the neutral word, so a param only speaks up when it has something better.
 */
const PLACEHOLDERS = new WeakMap<object, string>();

/**
 * Declare that `schema` is authored with `kind`, and return the SAME schema.
 *
 * Returns the identical instance rather than a wrapper so it composes with nothing: a
 * declared schema validates exactly as it did undeclared, and a caller that ignores this
 * function's return value still gets a registered schema. The widget is presentation and
 * must never be able to change what the schema accepts.
 */
export function widget<S extends z.ZodTypeAny>(
  kind: ParamWidget,
  schema: S,
  placeholder?: string,
): S {
  WIDGETS.set(schema, kind);
  if (placeholder !== undefined) PLACEHOLDERS.set(schema, placeholder);
  return schema;
}

/**
 * What this schema calls its empty state, or `undefined` if it has no opinion.
 *
 * Undefined is the honest answer and the common one: the draw site owns the neutral word for
 * each control, and a param overrides it only when blank means something specific there.
 */
export function placeholderOf(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  return PLACEHOLDERS.get(schema);
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

/**
 * A hex colour param, declared with the picker it is authored by (#521).
 *
 * ── WHY IT LIVES HERE AND NOT BESIDE A COLOUR MODULE ──────────────────────────────────
 *
 * `scopeParam()` lives in `componentSelection.ts` because that module owns what a scope IS —
 * the parser, the refusal, the default. A colour has no such module: it is a hex string and
 * nothing in this codebase owns that fact. The alternative was a file holding one function,
 * which this project's own rule calls a function rather than a module. So it sits beside the
 * declaration mechanism it uses, with seven callers.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────
 *
 * 🔴 IT ADDS NO `.refine(isHex6)`, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 * `scopeParam()` refines because an unparseable query reaching the resolver is a THROW on the
 * render walk. A non-hex colour is not: it reaches three.js, which resolves CSS names, and the
 * panel's own field already refuses a non-hex edit before dispatching. Adding a refinement
 * here would narrow what EXISTING SAVED PROJECTS validate against — a migration risk taken for
 * a failure that does not occur. The widget is presentation; it must not change what the
 * schema accepts, which is the same rule {@link widget} states about itself.
 */
export function colorParam(defaultHex: string): z.ZodDefault<z.ZodString> {
  return widget('color', z.string().default(defaultHex));
}

/**
 * A node's SEMANTIC name, declared with the text control it is authored by (#1031).
 *
 * ── WHY A HELPER RATHER THAN `widget('text', …)` AT TWENTY-SIX SITES ──────────────────
 *
 * This is the reasoning this module's header already states, applied to the param it is
 * most true of. A widget is a property of the PARAM TYPE, and `name` is the same field
 * wherever it appears: twenty-six node types carry a top-level `name: z.string()` whose
 * default is a domain label (`'Shot'`, `'clip'`, `'channel'`, `'track-to'`). Declaring the
 * control per node would spell one fact twenty-six times — the failure the spine comment
 * names — and a twenty-seventh node would have to remember. Calling this instead gets the
 * control for free and cannot forget to ask.
 *
 * ── WHY THIS IS NOT THE OUTLINER'S RENAME ─────────────────────────────────────────────
 *
 * 🔴 `params.name` AND `meta.name` ARE DIFFERENT FIELDS, and only the second one was ever
 * authorable. A director's double-click in the outliner dispatches `setMeta`
 * (`src/app/RenameInput.tsx:59`), which writes `meta.name` — rung 1 of `nodeDisplayName`'s
 * priority ladder. `params.name` is rung 2, documented there as "the SEMANTIC name carried
 * by Shot / AnimationClip / Character node params — their domain label, not a generic
 * field", and it has 36 production readers: a light rig is found by it
 * (`resolveRigLightSources.ts:50`), a studio profile is keyed on it (`studioProfiles.ts:42`),
 * a composition exports under it (`exportCompositionAction.ts:154`), a retarget names its
 * output with it (`retargetFromNodes.ts:181`). So renaming the node in the tree did NOT set
 * the thing those call sites read, and nothing in the panel could.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────
 *
 * No `.refine()`, for {@link colorParam}'s reason and one more. A name reaching a reader is
 * never a throw — every one of the 36 treats it as an opaque label or falls back — and
 * narrowing here would change what ALREADY-SAVED projects validate against, for a failure
 * that does not occur. The widget is presentation and must not move validation, which is
 * the rule {@link widget} states about itself.
 *
 * Blank stays accepted, and that is load-bearing rather than incidental: it is the
 * unconfigured state `nodeDisplayName` falls THROUGH on its way to the next rung, so
 * refusing it would make a name unclearable once typed and would strand the fallback.
 */
export function nameParam(defaultLabel: string): z.ZodDefault<z.ZodString> {
  // "unnamed" rather than the neutral "empty", because for a name blank has a READING: the
  // node still shows a label, drawn from the next rung of `nodeDisplayName`'s ladder. The
  // field is empty; the node is not anonymous.
  return widget('text', z.string().default(defaultLabel), 'unnamed');
}
