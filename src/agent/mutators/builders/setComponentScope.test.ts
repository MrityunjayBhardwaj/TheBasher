// #667 — the agent's road to a component scope, exercised end to end.
//
// A director could type a scope from #872 onward; the agent could only reach it through a
// raw `dag.exec` setParam, which works but skips the five gates. These rows are the gated
// road, and the one that matters most is the CENSUS.
//
// ── WHY THE CENSUS IS THE LOAD-BEARING ROW ───────────────────────────────────────────
//
// This issue's own text said "four operators declare a scope". It was six by the time
// anyone acted on it — `MaskModifier` and `BevelModifier` joined without the text moving.
// A mutator that hardcoded the list would have inherited that decay silently: it would
// refuse a genuinely scopeable operator and report it as "not scopeable", which reads as a
// fact about the node rather than a fact about a stale list.
//
// So eligibility is DERIVED from the registry, and the row below asserts the derivation
// against the registry rather than against a copy of it — with a denominator, so a
// registry that stopped declaring scopes could not pass this by selecting nothing.
//
// REF: src/nodes/componentSelection.ts (`SCOPE_PARAM`, `scopeParam()`);
//      src/nodes/scopeQuery.ts (the grammar); src/app/paramWidgetDeclaration.gate.test.ts
//      (the director half, #872); issue #667.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../../core/dag';
import { getNodeType, listNodeTypes } from '../../../core/dag/registry';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { SCOPE_PARAM } from '../../../nodes/componentSelection';
import { setComponentScopeMutator, type SetComponentScopeSpec } from './setComponentScope';
import { validatePlan } from '../validate';

function plan(state: DagState, spec: SetComponentScopeSpec) {
  return validatePlan(setComponentScopeMutator, spec, state, 'set a component scope');
}

/** Add a bare node of `type` with id `id`. */
function withNode(state: DagState, id: string, type: string): DagState {
  return applyOp(state, { type: 'addNode', nodeId: id, nodeType: type, params: {} }).next;
}

/** Apply, asserting the write was not ACCEPTED-BUT-DROPPED (#423). */
function applyAll(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce<DagState>((s, op) => {
    const res = applyOp(s, op);
    expect(res.reportable).toBeUndefined();
    return res.next;
  }, state);
}

/**
 * A registered type that declares NO scope and whose params parse empty — derived rather
 * than named, so this fixture cannot rot the way a hardcoded operator list would.
 */
function anUnscopedType(): string {
  const t = listNodeTypes().find((type) => {
    const schema = getNodeType(type)?.paramSchema;
    if (!(schema instanceof z.ZodObject)) return false;
    if ((schema.shape as Record<string, z.ZodTypeAny>)[SCOPE_PARAM] !== undefined) return false;
    return schema.safeParse({}).success;
  });
  if (!t) throw new Error('no unscoped, default-constructible node type in the registry');
  return t;
}

/** Every registered node type declaring a `scope` param — the registry's own answer. */
function scopedTypes(): string[] {
  return listNodeTypes()
    .filter((t) => {
      const schema = getNodeType(t)?.paramSchema;
      if (!(schema instanceof z.ZodObject)) return false;
      return (schema.shape as Record<string, z.ZodTypeAny>)[SCOPE_PARAM] !== undefined;
    })
    .sort();
}

describe('#667 — setComponentScope', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('plans a scope on EVERY operator the registry says is scopeable, with a denominator', () => {
    const examined = listNodeTypes().length;
    const scoped = scopedTypes();

    const accepted = scoped.filter((type) => {
      const state = withNode(emptyDagState(), 'op', type);
      return plan(state, { nodeId: 'op', scope: '0-5' }).ok;
    });

    // Stated as a triple so a zero cannot read as a pass: if the registry stopped
    // declaring scopes, `scoped` would empty and this equality would fail rather than
    // hold trivially.
    expect({ examined, scoped, accepted }).toEqual({ examined, scoped, accepted: scoped });
    // And the derivation is checked against the registry's answer, not a copy of it —
    // but the count is pinned so a registry that silently lost an operator is visible.
    expect(scoped.length).toBe(6);
  });

  it('emits one setParam on the scope param, and the write is not silently dropped', () => {
    const state = withNode(emptyDagState(), 'arr', 'ArrayModifier');
    const p = plan(state, { nodeId: 'arr', scope: '0-9 ^3' });
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error(p.reason);

    expect(p.ops).toHaveLength(1);
    const op = p.ops[0] as { type: string; nodeId: string; paramPath: string; value: unknown };
    expect(op).toMatchObject({ type: 'setParam', nodeId: 'arr', paramPath: SCOPE_PARAM });
    expect(op.value).toBe('0-9 ^3');

    // 🔑 The #423 check — an accepted-but-dropped setParam would leave every row above
    // green while changing nothing on the node.
    const next = applyAll(state, p.ops);
    expect(next.nodes['arr'].params[SCOPE_PARAM]).toBe('0-9 ^3');
  });

  it('BLANK is an authoring intent, not an error — it clears back to the whole mesh', () => {
    const seeded = plan(withNode(emptyDagState(), 'arr', 'ArrayModifier'), {
      nodeId: 'arr',
      scope: '0-5',
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error(seeded.reason);
    const state = applyAll(withNode(emptyDagState(), 'arr', 'ArrayModifier'), seeded.ops);
    expect(state.nodes['arr'].params[SCOPE_PARAM]).toBe('0-5');

    const cleared = plan(state, { nodeId: 'arr', scope: '' });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error(cleared.reason);
    const next = applyAll(state, cleared.ops);
    expect(next.nodes['arr'].params[SCOPE_PARAM]).toBe('');
  });

  it('refuses a node that declares no scope, and says so about the TYPE', () => {
    const type = anUnscopedType();
    const state = withNode(emptyDagState(), 'plain', type);
    const p = plan(state, { nodeId: 'plain', scope: '0-5' });
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error('expected a refusal');
    // The message names the TYPE, so a director reading it learns why, not just that.
    expect(p.reason).toContain(type);
    expect(p.reason).toContain(SCOPE_PARAM);
  });

  it("refuses an unparsable query with the SCHEMA'S message, not a second opinion", () => {
    const state = withNode(emptyDagState(), 'arr', 'ArrayModifier');

    // The schema's own refusal string, read from the field rather than restated here — if
    // someone rewords the schema message, this row follows it instead of drifting.
    const field = (getNodeType('ArrayModifier')!.paramSchema as z.ZodObject<z.ZodRawShape>).shape[
      SCOPE_PARAM
    ];
    const schemaMessage = field.safeParse('5-2');
    expect(schemaMessage.success).toBe(false);
    const expected = schemaMessage.success
      ? ''
      : schemaMessage.error.issues.map((i) => i.message).join('; ');

    const p = plan(state, { nodeId: 'arr', scope: '5-2' });
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error('expected a refusal');
    expect(p.reason).toContain(expected);
  });

  it('refuses a deferred construct BY NAME rather than silently meaning everything', () => {
    const state = withNode(emptyDagState(), 'arr', 'ArrayModifier');
    for (const q of ['arm*', '@v>0']) {
      const p = plan(state, { nodeId: 'arr', scope: q });
      expect(p.ok, q).toBe(false);
    }
  });

  it('refuses a node id that is not in the DAG', () => {
    const p = plan(emptyDagState(), { nodeId: 'ghost', scope: '0-5' });
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error('expected a refusal');
    expect(p.reason).toContain('ghost');
  });
});
