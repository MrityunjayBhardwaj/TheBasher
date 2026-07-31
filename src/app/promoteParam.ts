// promoteParam — turning an inspector row into an interface element (#394, PLAN-3 P7).
//
// ── WHAT A PROMOTE ACTUALLY IS ──────────────────────────────────────────────────────
//
// Two things that already exist, in one atomic op chain:
//
//   1. a SPARE PARAM on a control node, flagged `promoted` and given a home (#291/#294)
//   2. a PARAM DRIVER pulling that spare onto the target param (#294's `ch()` road)
//
// There is no promote record, no curation list, no registry. `exposeParams` reads the row
// back out of those two facts, which is why promoting twice onto the SAME spare is how
// 1:N is authored — the second promote adds only a driver, and the control it joins is
// the one already there. Houdini's grounding is the same shape: "promotion is itself a
// driver" (GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS §1), not a separate interface object.
//
// ── WHY THE CONTROL LIVES ON ITS OWN NODE, AND NOT ON THE OBJECT ────────────────────
//
// The obvious host is the Object whose inspector shows the control. It does not work, and
// the reason is structural rather than incidental: the Object sits DOWNSTREAM of its whole
// data lane, and `driverParamDeps` records `target ← driver ← spareHost`, so a control
// hosted there closes a loop for every param in its own chain. Measured, all three
// refused — `mod.count`, `obj_data.size`, and even the Object's own `position`:
//
//   host = the Object      → every target REFUSED ('binding would create a driver cycle')
//   host = the base data   → the lane above it OK; its OWN params REFUSED
//   host = a separate Null → every target OK
//
// The dependency is an over-approximation for a plain value read (`readBaseParam` never
// evaluates), but not a baseless one: a spare param can ITSELF be driven, so its value can
// transitively depend on a cook. Loosening that hop is #294's guard, not this stage's.
//
// So the control gets a Null of its own — which is not a new idiom but the one already
// ruled for: "a controller is a real scene object grabbed with the normal gizmo… one
// controller idiom, not two" (#296, `core/dag/types.ts`). ONE Null per object, minted on
// the first promote and joined by every later one, and it is minted through
// `buildAddPrimitiveOps` so scene membership has a single authority.
//
// Nothing records which Null belongs to which object, deliberately. The controller is
// DERIVED — it is whichever node already hosts a promoted control driving this chain
// (`resolveControlHost`), read back out of the same two facts the row is. A stored link
// would be a third fact to keep in sync with them.
//
// ── WHY THE CONTROL'S TYPE IS READ FROM THE SCHEMA, NOT FROM THE VALUE ──────────────
//
// The obvious shortcut is `Number.isInteger(currentValue) ? 'int' : 'float'`, and it is
// wrong in a way that only shows up later: a float param that happens to sit at 2 would
// get a knob that steps by 1 and truncates, and an int param whose value was somehow
// fractional would get a knob that can push 2.5 into a count. The node's zod schema
// already knows which it is, so it is asked. A param that is not a number at all cannot
// be promoted through this road and is REFUSED with a reason — never bound to a knob that
// would write a number into it ([[V38]]: no silent no-op, and no silently wrong write).
//
// ── TWO DECLARED LIMITS, BOTH MEASURED WHILE BUILDING THIS ──────────────────────────
//
// 1. 🔴 A PARAM THE COOK CONSUMES CANNOT BE DRIVEN AT ALL, AND THIS DOES NOT KNOW IT YET
//    (#524, live on `main` and not caused by promote). The evaluator is pure over
//    `node.params`; overlays fold at the render and read seams. So driving an
//    `ArrayModifier.count` moves `resolveEvaluatedParam` from 2 to 9 and leaves the
//    geometry it cooks at 2 — measured, both sides. A promote onto such a param builds a
//    knob that reports success and moves nothing.
//
//    Refusing it here needs a classification of "is this param read by an `evaluate` or by
//    a renderer?", which is the second axis #492 already records as absent. Until that
//    exists this builder cannot tell the two apart, and pretending otherwise with a
//    hardcoded list of node types would rot silently. Stated here rather than discovered
//    by a user.
//
// 2. ONE CONTROL DRIVES ONE NUMERIC TYPE. Joining an int param and a float param to one
//    knob is refused, because a float knob over 0..1 cannot also step an integer count and
//    coercing either way makes one drive lie about its own steps. PLAN-3 §4 P7's demo
//    pairs exactly such a couple (`count` + `roughness`), so this is a real narrowing of
//    the stage as written. Widening it means a per-drive conversion on the control, which
//    is a feature of its own.
//
// REF: src/app/driverBind.ts (`buildBindDriverOps` — the bind this composes with, and the
//      cycle guard it runs), src/app/exposeParams.ts (`promotedRowsFor` — the read side),
//      src/core/dag/types.ts (`SpareParamSchema.home`), src/app/controllersDock.ts
//      (`collectPromotedControls` — the other reader of the same flag);
//      ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §1; PLAN-3 §3.6 + §4 P7; #291,
//      #294, #394.

import { z } from 'zod';
import type { DagState } from '../core/dag/state';
import type { Op, SpareParam } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import type { Vec3 } from '../nodes/types';
import { buildAddPrimitiveOps } from './addPrimitives';
import { buildBindDriverOps } from './driverBind';
import { exposeParams } from './exposeParams';

/** The numeric spare types the `ch()` road can drive a scalar param with. */
export type NumericSpareType = 'float' | 'int';

/** Unwrap zod's wrappers (`.default()`, `.optional()`, `.nullable()`) down to the leaf,
 *  so a schema field's real type is visible however it was decorated. */
function unwrapZod(field: unknown): unknown {
  const def = (field as { _def?: { innerType?: unknown } } | undefined)?._def;
  return def?.innerType ? unwrapZod(def.innerType) : field;
}

/**
 * The spare-param type a control for `(nodeType, paramPath)` must have, or null when the
 * param is not a promotable scalar.
 *
 * ⚠️ TOP-LEVEL KEYS ONLY, and that is a declared limit rather than an oversight. A dotted
 * path addresses a field INSIDE a structured param (`material.base.color`), and the driver
 * rail folds onto a param band, not into an IR sub-field — so promoting one would build a
 * control that drives nothing visible. Refused loudly here instead.
 *
 * ⚠️ THIS READS ZOD'S `_def`, which is internal API. The gate below it is a test that asks
 * the question of REAL registered node types (an int param and a float one), so a zod
 * upgrade that changed the shape fails by name rather than silently answering 'float' for
 * everything — which is exactly the answer that would look correct.
 */
export function spareTypeForParam(
  nodeType: string | undefined,
  paramPath: string,
): NumericSpareType | null {
  if (!nodeType || paramPath.includes('.')) return null;
  const schema = getNodeType(nodeType)?.paramSchema;
  if (!(schema instanceof z.ZodObject)) return null;
  const field = unwrapZod((schema.shape as Record<string, unknown>)[paramPath]);
  if (!(field instanceof z.ZodNumber)) return null;
  return field.isInt ? 'int' : 'float';
}

/**
 * The node already hosting a promoted control for `selectedId`'s chain, or null.
 *
 * DERIVED, not stored. A second promote on the same object should join the controller the
 * first one made, and the graph already says which node that is — it is the host of any
 * promoted row the projection emits for this selection. Recording the link on the Object
 * instead would be a third fact to keep in step with the spare and the drivers.
 */
export function resolveControlHost(state: DagState, selectedId: string): string | null {
  for (const row of exposeParams(state, selectedId)) {
    if (row.kind === 'promoted') return row.controlNodeId;
  }
  return null;
}

/** Where the control's spare param goes. `'new'` mints a Null controller through the
 *  shipped primitive builder, so scene membership keeps one authority. */
export type ControlHost =
  | { readonly kind: 'existing'; readonly nodeId: string }
  | { readonly kind: 'new'; readonly name?: string; readonly position?: Vec3 };

export interface PromoteRequest {
  /** The row being promoted, taken from its projection entry — so the promote inherits
   *  the row's exact provenance instead of resolving the target again ([[V142]]). */
  readonly target: { readonly nodeId: string; readonly paramPath: string };
  /** The node that hosts the control's spare param — an existing controller, or a fresh
   *  Null. See the header for why it can never be the Object itself. */
  readonly control: ControlHost;
  /** The spare key. Naming an EXISTING promoted spare on that node is how a second param
   *  joins one control — the 1:N road. */
  readonly controlPath: string;
  /** Where the control renders. Ignored when joining an existing control, which already
   *  has one; a promote must not silently move a control someone else placed. */
  readonly home: { readonly section: string; readonly order?: number; readonly label?: string };
  /** A fresh, unused node id for the driver (caller-generated → deterministic tests). */
  readonly driverId: string;
}

export type PromoteResult =
  | { ok: true; ops: Op[]; controlNodeId: string }
  | { ok: false; reason: string };

/**
 * The forward op chain that promotes `target` onto a control, or a rejection carrying the
 * reason. `dispatchAtomic` computes the inverses, so undo restores every half together —
 * which is the reason this is one chain and not three user actions.
 */
export function buildPromoteParamOps(state: DagState, req: PromoteRequest): PromoteResult {
  const { target, control, controlPath, home, driverId } = req;
  const targetNode = state.nodes[target.nodeId];
  if (!targetNode) return { ok: false, reason: 'the promoted row names a node that is not here' };
  if (!controlPath.trim()) return { ok: false, reason: 'a control needs a name' };

  const spareType = spareTypeForParam(targetNode.type, target.paramPath);
  if (spareType === null) {
    return {
      ok: false,
      reason: `${target.paramPath} is not a plain number on ${targetNode.type}, and the driver rail drives numbers`,
    };
  }

  const ops: Op[] = [];
  let controlNodeId: string;
  let existing: SpareParam | undefined;
  if (control.kind === 'existing') {
    const host = state.nodes[control.nodeId];
    if (!host) return { ok: false, reason: 'the control node is not here' };
    controlNodeId = control.nodeId;
    existing = host.spare?.[controlPath];
  } else {
    // A fresh controller, built by the SAME function the Add menu uses — so it lands in
    // `scene.children`, appears in the outliner, and is grabbable with the normal gizmo,
    // without this module knowing how a scene object is wired.
    const at = control.position;
    const add = buildAddPrimitiveOps(state, 'Null', at ? [at[0], at[1], at[2]] : [0, 0, 0]);
    if (!add) return { ok: false, reason: 'this project has no scene to add a controller to' };
    controlNodeId = add.newNodeId;
    ops.push(...add.ops);
    if (control.name) {
      ops.push({ type: 'setMeta', nodeId: controlNodeId, name: control.name });
    }
    existing = undefined;
  }

  if (existing === undefined) {
    // A NEW control. It seeds from the param's current value, so promoting changes what
    // the interface looks like and NOT what the scene looks like — the driver immediately
    // replaces the param with the value it already had.
    const seed = (targetNode.params as Record<string, unknown> | undefined)?.[target.paramPath];
    const value = typeof seed === 'number' && Number.isFinite(seed) ? seed : 0;
    const param: SpareParam = {
      type: spareType,
      value,
      promoted: true,
      home: {
        section: home.section,
        ...(home.order !== undefined ? { order: home.order } : {}),
        ...(home.label !== undefined ? { label: home.label } : {}),
      },
    };
    ops.push({ type: 'setSpareParam', nodeId: controlNodeId, key: controlPath, param });
  } else if (existing.promoted !== true) {
    // An un-promoted spare of the same name is somebody else's knob, not a control. Taking
    // it over would change what the Controllers dock shows without being asked to.
    return { ok: false, reason: `${controlPath} already exists on this node and is not a control` };
  } else if (existing.type !== spareType) {
    // Joining a control of the wrong numeric type would make one of its drives lie about
    // its own steps. Refused rather than coerced.
    return {
      ok: false,
      reason: `${controlPath} is a ${existing.type} control and ${target.paramPath} needs ${spareType}`,
    };
  }

  // The bind runs through the SAME builder every other driver road uses, so the cycle
  // guard, the `order`-on-top rule (#315) and the params shape are not re-spelled here.
  const bind = buildBindDriverOps(state, {
    targetId: target.nodeId,
    paramPath: target.paramPath,
    source: {
      kind: 'spare',
      id: `spare:${controlNodeId}:${controlPath}`,
      label: controlPath,
      node: controlNodeId,
      key: controlPath,
    },
    driverId,
  });
  if (!bind.ok) return bind;
  ops.push(...bind.ops);
  return { ok: true, ops, controlNodeId };
}

/**
 * The forward op that removes ONE drive of a control: the driver, and nothing else.
 *
 * The spare param SURVIVES a drive being removed, deliberately. A control that vanished
 * when its last drive did would take its home, its label and its authored value with it,
 * so unbinding and re-binding would silently reset the interface. Removing the control
 * itself is a separate act on the control, which is where the spare-param editor already
 * lives (#294).
 */
export function buildUnpromoteDriveOps(state: DagState, driverId: string): Op[] {
  return state.nodes[driverId] ? [{ type: 'removeNode', nodeId: driverId }] : [];
}
