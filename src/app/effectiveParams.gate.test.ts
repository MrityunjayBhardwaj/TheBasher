// The `cookParams` totality gate (#524) — every declaration checked against a real
// evaluation, in BOTH directions.
//
// ── WHY THIS IS THE REAL GUARD, AND A BEHAVIOURAL TEST IS NOT ──────────────────────────
//
// `effectiveParams.ts` folds only params a node DECLARES as cook-consumed, and the safety
// argument for the whole change rests on that set being exactly right:
//
//   too NARROW — a consumed param left undeclared keeps #524's silent failure. The panel
//                animates, the geometry does not, and nothing anywhere says so.
//   too WIDE   — a param that DOES survive onto the value gets folded here AND overlaid at
//                the render seam. For a `replace` channel the second write recomputes the
//                same number and hides it; for an `add` one the contribution lands twice.
//
// The first draft of this guard was a behavioural test asserting the fold left a material
// channel alone, and it was VACUOUS: adding `material` to `BoxData.cookParams` left all six
// of its cases green. The reason is that the fold resolves TOP-LEVEL param names while a
// material channel targets `material.base.metalness`, so the wrong declaration never got a
// value to fold and the test could not see it. A wrong declaration is a structural fact, so
// it needs a structural instrument: measure where each param actually gets to, and require
// the declaration to match.
//
// ── WHAT IS MEASURED ───────────────────────────────────────────────────────────────────
//
// A param is cook-consumed exactly when it is ABSENT from its own node's evaluated value —
// that absence is why an overlay applied downstream has nothing to write to. So the gate
// evaluates a real instance of each subject and derives the set, rather than restating it.
//
// ⚠️ THE SUBJECT IS A SAMPLE, and saying so is the point. It covers the node types this
// gate can CONSTRUCT: the six split data kinds (through the shared `splitKinds` fixtures)
// and the two geometry modifiers (built here against a real box). A node type outside that
// set can declare `cookParams` wrongly, or fail to declare at all, and nothing here would
// notice. Widening it means a constructible fixture per node type, which is its own piece
// of work — this gate is not evidence that the registry as a whole is classified.
//
// REF: src/core/dag/types.ts (`NodeDefinition.cookParams`); src/app/effectiveParams.ts
//      (the fold, and the seams that apply it); src/test-utils/splitKinds.ts (the kind
//      fixtures); src/test-utils/paramReach.gate.test.ts (the sibling measurement this
//      shares its method with); issues #524, #492.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType, snapshotRegistry } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { splitOps, rowDataParams, SPLIT_KINDS, SPLIT_KIND_NAMES } from '../test-utils/splitKinds';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** The param names a node type's schema declares. Derived, never listed. */
function schemaParams(type: string): string[] {
  const def = snapshotRegistry()[type] as unknown as {
    paramSchema?: { shape?: Record<string, unknown> };
  };
  return Object.keys(def?.paramSchema?.shape ?? {});
}

/**
 * The params ABSENT from this node's own evaluated value — the measured cook-consumed set.
 *
 * The node must be evaluable in `state`; a modifier with nothing wired returns its (absent)
 * source and would measure every param as consumed for the wrong reason, which the vacuity
 * check below is there to catch.
 */
function measuredCookParams(state: DagState, id: string, type: string): string[] {
  const value = evaluate(state, id, { ctx: CTX }).value as Record<string, unknown> | undefined;
  return schemaParams(type).filter((p) => !(p in (value ?? {})));
}

/** A state with both geometry modifiers wired to the seed box — a real source, so the cook runs. */
function modifierState(): DagState {
  let state = buildDefaultDagState();
  for (const [id, type] of [
    ['n_arr', 'ArrayModifier'],
    ['n_mir', 'MirrorModifier'],
  ] as const) {
    state = applyOp(state, { type: 'addNode', nodeId: id, nodeType: type, params: {} } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_box_data', socket: 'out' },
      to: { node: id, socket: 'target' },
    } as Op).next;
  }
  return state;
}

/** A state holding one split kind's Object+data pair, built through the shared fixtures. */
function splitKindState(kind: (typeof SPLIT_KIND_NAMES)[number]): DagState {
  let state = emptyDagState();
  for (const op of splitOps(kind, { objectId: `n_${kind}` }, { data: rowDataParams(kind) })) {
    state = applyOp(state, op as Op).next;
  }
  return state;
}

/** Every subject this gate can construct: `[node type, state, node id]`. */
function subjects(): [string, DagState, string][] {
  const out: [string, DagState, string][] = [];
  const mods = modifierState();
  out.push(['ArrayModifier', mods, 'n_arr'], ['MirrorModifier', mods, 'n_mir']);
  for (const kind of SPLIT_KIND_NAMES) {
    out.push([SPLIT_KINDS[kind].dataType, splitKindState(kind), `n_${kind}_data`]);
  }
  return out;
}

beforeEach(() => {
  __reseedAllNodesForTests();
});

describe('#524 — cookParams says exactly what the cook consumes', () => {
  it('declares every param that is absent from the value, and no param that survives', () => {
    const problems: string[] = [];
    for (const [type, state, id] of subjects()) {
      const declared = [...(getNodeType(type)?.cookParams ?? [])].sort();
      const measured = measuredCookParams(state, id, type).sort();

      for (const p of measured) {
        if (!declared.includes(p)) {
          problems.push(
            `${type}.${p}: the cook consumes it — it is absent from the evaluated value — but ` +
              `it is not declared, so an overlay on it animates the panel and not the picture`,
          );
        }
      }
      for (const p of declared) {
        if (!measured.includes(p)) {
          problems.push(
            `${type}.${p}: declared cook-consumed but it DOES survive onto the value, so the ` +
              `render seam already overlays it — folding it as well applies it twice`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('guards the guard — every subject really evaluated, with params to check', () => {
    // Without this the check above passes by having nothing to check: a modifier with no
    // source returns its absent input, and every param then measures as "consumed" for a
    // reason that has nothing to do with the cook.
    const all = subjects();
    expect(all.length, 'the subject list is empty').toBe(8);
    for (const [type, state, id] of all) {
      expect(
        schemaParams(type).length,
        `${type}: no schema params — the subject is empty`,
      ).toBeGreaterThan(0);
      const value = evaluate(state, id, { ctx: CTX }).value as Record<string, unknown> | undefined;
      expect(value, `${type}: evaluated to nothing — the fixture is not wired`).toBeTruthy();
      expect(
        Object.keys(value ?? {}).length,
        `${type}: evaluated to an empty value, so every param would measure as consumed`,
      ).toBeGreaterThan(1);
    }
  });

  it('names a declared param that is not on the schema', () => {
    // The other direction of rot: a param renamed or removed leaves an entry describing
    // something that does not exist, and the totality check above would never look at it.
    const problems: string[] = [];
    for (const [type] of subjects()) {
      const schema = schemaParams(type);
      for (const p of getNodeType(type)?.cookParams ?? []) {
        if (!schema.includes(p)) problems.push(`${type}.${p}: declared but not on the schema`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
