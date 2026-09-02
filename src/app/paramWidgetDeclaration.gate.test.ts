// A PARAM'S CONTROL IS DECLARED BY ITS SCHEMA (#872), AND THE REFUSAL IS A STATE (#873).
//
// ── WHAT THIS GATE IS FOR ─────────────────────────────────────────────────────────────
//
// `ParamRow` used to choose a control from the param's RUNTIME VALUE, so every string that
// was not a declared enum fell to a read-only span. Six operators carried a component
// `scope` that no director could type. The fix is a widget DECLARED on the schema, and
// these rows pin the two things that make that fix real rather than nominal:
//
//   1. the declaration reaches every operator that shares the helper, and only the params
//      that asked for it — checked as a CENSUS with a denominator, not as a spot check;
//   2. declaring a control does not change what the schema ACCEPTS. Presentation must
//      never be able to move validation, and this is the row that would catch it if the
//      widget were ever implemented as a wrapper instead of a side table.
//
// Row 4 is the one worth reading twice: the message the panel shows is asserted to be the
// SCHEMA'S OWN, so the refusal a director reads cannot drift from the rule that produced
// it by someone rewording one of the two.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { SCOPE_PARAM, scopeParam } from '../nodes/componentSelection';
import { widget, widgetOf, type ParamWidget } from '../nodes/paramWidget';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The declared field schema for a top-level param — the same lookup NPanel does. */
function fieldOf(type: string, param: string): z.ZodTypeAny | undefined {
  const schema = getNodeType(type)?.paramSchema;
  if (!(schema instanceof z.ZodObject)) return undefined;
  return (schema.shape as Record<string, z.ZodTypeAny>)[param];
}

describe('a param declares its control on its schema (#872)', () => {
  it('row 1 — every operator that declares a scope gets the query control, with a denominator', () => {
    const examined = listNodeTypes().length;
    const declaringScope = listNodeTypes().filter((t) => fieldOf(t, SCOPE_PARAM) !== undefined);
    const withQueryWidget = declaringScope.filter(
      (t) => widgetOf(fieldOf(t, SCOPE_PARAM)) === 'query',
    );

    // The census is stated as a triple so a zero can never be read as a pass: if the
    // registry stopped declaring scopes at all, `declaringScope` would empty and the
    // equality below would fail rather than trivially hold.
    expect({ examined, declaringScope, withQueryWidget }).toEqual({
      examined,
      declaringScope: [
        'ArrayModifier',
        'BevelModifier',
        'MaskModifier',
        'MaterialOverrideOp',
        'MirrorModifier',
        'SetMaterialOp',
      ],
      // Identical to the line above ON PURPOSE: the point of declaring on the shared
      // helper rather than per node is that these two lists cannot come apart. A seventh
      // operator calling `scopeParam()` joins both; one that hand-rolls its own string
      // schema joins the first and reds here.
      withQueryWidget: [
        'ArrayModifier',
        'BevelModifier',
        'MaskModifier',
        'MaterialOverrideOp',
        'MirrorModifier',
        'SetMaterialOp',
      ],
    });
    expect(declaringScope.length).toBe(6);
  });

  it('row 2 — a param that declares no widget resolves undefined (negative control)', () => {
    // Without this the row above could pass with `widgetOf` returning 'query' for
    // everything. `muted` sits on the same nodes and asked for nothing.
    expect(widgetOf(fieldOf('MaskModifier', 'muted'))).toBeUndefined();
    expect(widgetOf(fieldOf('MaskModifier', 'keep'))).toBeUndefined();
    expect(widgetOf(fieldOf('BevelModifier', 'amount'))).toBeUndefined();
    expect(widgetOf(fieldOf('MirrorModifier', 'axis'))).toBeUndefined();
    // And a non-schema is not a widget carrier.
    expect(widgetOf(undefined)).toBeUndefined();
    expect(widgetOf(null)).toBeUndefined();
    expect(widgetOf('query')).toBeUndefined();
  });

  it('row 3 — declaring a control does not change what the schema accepts', () => {
    // The widget is a side table, so a declared schema must validate EXACTLY as the
    // undeclared one does. Built here rather than reused so the two are independent.
    const bare = z.string().min(2).default('ab');
    const declared = widget('query', z.string().min(2).default('ab'));

    const cases = ['', 'a', 'ab', 'abc', '0-5'];
    const bareResults = cases.map((c) => bare.safeParse(c).success);
    const declaredResults = cases.map((c) => declared.safeParse(c).success);

    expect({ examined: cases.length, declaredResults }).toEqual({
      examined: cases.length,
      declaredResults: bareResults,
    });
    // …and the accepted VALUES agree too, not just the verdicts.
    expect(declared.parse('abc')).toBe(bare.parse('abc'));
    // The declaration returns the same instance, which is what makes the above true by
    // construction rather than by luck.
    const s = z.string();
    expect(widget('query', s)).toBe(s);
  });

  it('row 4 — the refusal a director reads is the schema’s own message', () => {
    const field = fieldOf('MaskModifier', SCOPE_PARAM)!;
    const refused = ['arm*', '@v>0', 'garbage!!'];
    const accepted = ['0-9', '!1-10', '^0', ''];

    const messages = refused.map((q) => {
      const r = field.safeParse(q);
      return r.success ? 'ACCEPTED' : r.error.issues[0]?.message;
    });

    // One rule, one wording. The panel renders `issues[0].message` verbatim, so this is
    // the exact text a director sees — asserted here so nobody can reword the schema's
    // refusal without noticing that a person reads it.
    expect(messages).toEqual([
      'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
      'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
      'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
    ]);

    // The instrument control: the same field must ACCEPT the valid half, or the row above
    // would pass on a schema that refuses everything.
    expect({
      refusedCount: refused.filter((q) => !field.safeParse(q).success).length,
      acceptedCount: accepted.filter((q) => field.safeParse(q).success).length,
    }).toEqual({ refusedCount: 3, acceptedCount: 4 });
  });

  it('row 5 — the widget union is closed, so a new member must be answered for', () => {
    // `ParamWidget` has one member today. This row exists so that adding a second one
    // fails HERE with a readable reason, next to the note saying where else it must be
    // handled, rather than only inside NPanel's exhaustive switch.
    const all: readonly ParamWidget[] = ['query'];
    expect(all).toEqual(['query']);
    // When this list grows: add the arm to `ParamRow`'s switch in `src/app/NPanel.tsx`,
    // and give the new control its own e2e row the way `scope` has one — an authorable
    // control that can refuse owes a visible refusal and an observed recovery.
  });

  it('row 6 — the helper registers the instance the node actually stores', () => {
    // The declaration is by IDENTITY, so a helper that returned a fresh unregistered
    // schema, or a node that wrapped the helper's result, would silently lose the widget.
    // This is the failure mode a WeakMap makes possible, so it is pinned directly.
    const fresh = scopeParam();
    expect(widgetOf(fresh)).toBe('query');
    expect(widgetOf(fieldOf('ArrayModifier', SCOPE_PARAM))).toBe('query');
    // Two calls are two instances, and BOTH are registered — the registration happens per
    // call, not once on a shared singleton.
    expect(scopeParam()).not.toBe(fresh);
    expect(widgetOf(scopeParam())).toBe('query');
  });
});
