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
import { colorParam, nameParam, widget, widgetOf, type ParamWidget } from '../nodes/paramWidget';
import { overrideDescriptor } from './overrideDescriptor';
import { nodeDisplayName } from './sceneTreeWalk';

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

/** The panel's own unwrap, re-spelled here because it is private to `NPanel.tsx`. Kept
 *  identical on purpose: a census of what the panel draws must unwrap what the panel
 *  unwraps, or it measures a different question than the one it claims to answer. */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodDefault) return unwrapZod(schema.removeDefault());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapZod(schema.unwrap());
  }
  return schema;
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
        'ComponentGroupOp',
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
        'ComponentGroupOp',
        'MaskModifier',
        'MaterialOverrideOp',
        'MirrorModifier',
        'SetMaterialOp',
      ],
    });
    expect(declaringScope.length).toBe(7);
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

  it('row 10 — the TEXT control, and the read-only arm it was added to close (#1027)', () => {
    // 🔴 THIS ROW EXISTS BECAUSE THE GAP WAS FOUND IN SELF-REVIEW, NOT IN REVIEW OF A
    // SYMPTOM. `ComponentGroupOp` shipped offered in the Add menu with `name` as a bare
    // `z.string()`, which this panel renders as a READ-ONLY SPAN — so a director could add the
    // operator and could not type the one field that makes it do anything. The agent road
    // worked the whole time, which is exactly why nothing else caught it.
    expect(widgetOf(fieldOf('ComponentGroupOp', 'name'))).toBe('text');

    // The negative control, and it is the specific one that matters here: a bare string on the
    // same node family still resolves undefined, so this row is about the DECLARATION and not
    // about `widgetOf` having started answering for everything.
    expect(widgetOf(z.string())).toBeUndefined();
    expect(widgetOf(fieldOf('ComponentGroupOp', 'muted'))).toBeUndefined();
    // …and the scope beside it still asks for the query control, so the two did not merge.
    expect(widgetOf(fieldOf('ComponentGroupOp', SCOPE_PARAM))).toBe('query');

    // The refusal a director reads, verbatim, for the same reason row 4 pins the scope's: the
    // panel renders `issues[0].message` and a person reads it.
    const field = fieldOf('ComponentGroupOp', 'name')!;
    expect(field.safeParse('arm-left').success).toBe(false);
    expect(
      field.safeParse('arm-left').success
        ? 'ACCEPTED'
        : (field.safeParse('arm-left') as { error: { issues: { message: string }[] } }).error
            .issues[0]?.message,
    ).toContain('not a group name');
    // Blank is ACCEPTED and is not a refusal: it is the unconfigured state, and refusing it
    // would make the field unclearable once typed.
    expect(field.safeParse('').success).toBe(true);
    expect(field.safeParse('arm').success).toBe(true);
  });

  it('row 11 — no top-level `name` param is left read-only, stated as an absence (#1031)', () => {
    // THE DURABLE FORM, and it is deliberately NOT a fixed list of the twenty-six. A node
    // type added tomorrow with a `name: z.string()` that forgets `nameParam()` reds HERE
    // rather than shipping a field its director cannot type — which is the whole failure
    // this row descends from (#1027, found in self-review at the twenty-seventh site).
    //
    // A name is identified by what it IS: a top-level param whose schema is a string and
    // whose key is `name`. That is narrower than the colour rule above needs to be, because
    // unlike a hex colour a name has no structural signature — the key IS the signature, and
    // `nodeDisplayName` reads it by that key (`src/app/sceneTreeWalk.ts:99`).
    const names: string[] = [];
    const undeclared: string[] = [];
    let examined = 0;
    for (const type of listNodeTypes()) {
      const schema = getNodeType(type)?.paramSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        examined++;
        if (key !== 'name') continue;
        // By FIELD TYPE, not by a parsed default. 🔴 The first version of this census read
        // `schema.safeParse({})` to find string-VALUED params, and seven node types whose
        // schema has a required field cannot parse `{}` — so their params were never
        // examined at all and the count came back eleven short, `MotionGenerate.name`
        // among them. A zero from an instrument that skipped the subject is not a zero.
        if (!(unwrapZod(field) instanceof z.ZodString)) continue;
        names.push(`${type}.${key}`);
        if (widgetOf(field) !== 'text') undeclared.push(`${type}.${key}`);
      }
    }
    // The denominator and a positive control ride with the verdict, so an empty
    // `undeclared` can never be read as a pass from a loop that never ran.
    expect({ examined: examined > 0, nameCount: names.length, undeclared }).toEqual({
      examined: true,
      nameCount: 26,
      undeclared: [],
    });
  });

  it('row 12 — `nameParam` declares the control and does NOT narrow what the schema accepts', () => {
    // Same pairing as row 8, and for the same reason: the widget is presentation, so a
    // declared name must validate EXACTLY as the bare string it replaced. Twenty-six node
    // types' saved projects parse through these fields, so a refinement added here would
    // be a migration, not a decoration.
    const declared = nameParam('Shot');
    expect(widgetOf(declared)).toBe('text');
    for (const value of ['Shot', '', 'a name with spaces', '🎬', 'arm-left']) {
      expect({ value, ok: declared.safeParse(value).success }).toEqual({ value, ok: true });
    }
    expect(declared.parse(undefined)).toBe('Shot');
    // Blank is ACCEPTED on purpose — it is the unconfigured state `nodeDisplayName` falls
    // through on its way to the next rung, so refusing it would strand that fallback.
    expect(declared.safeParse('').success).toBe(true);
    // Registered per call, like `scopeParam` and `colorParam` — two instances, both declared.
    expect(nameParam('Track')).not.toBe(declared);
    expect(widgetOf(nameParam('Track'))).toBe('text');
  });

  it('row 13 — the name control is NOT the outliner rename, and the two fields both survive', () => {
    // 🔑 THE REASON THE GAP SURVIVED THIS LONG. A director CAN rename these nodes, so the
    // panel's read-only `name` row looked redundant rather than broken. It is a DIFFERENT
    // field: the outliner dispatches `setMeta` -> `meta.name` (`src/app/RenameInput.tsx:59`),
    // and this is `params.name`, which 36 production call sites read and which no surface
    // could set.
    //
    // 🔴 THIS ROW IS THE SECOND DRAFT. The first pinned the two as a SHAPE — `name` is in the
    // params, `metaName` is not — and `metaName` is a spelling no node has ever had, so that
    // half could not have reddened for any edit. An assertion whose subject cannot change is
    // not a guard. This asserts the BEHAVIOUR the two fields exist to produce instead, which
    // is what actually breaks if someone collapses them into one.
    const nodes = {
      both: {
        id: 'both',
        type: 'Shot',
        params: { name: 'from-params' },
        meta: { name: 'from-meta' },
      },
      paramsOnly: { id: 'paramsOnly', type: 'Shot', params: { name: 'from-params' } },
      neither: { id: 'neither', type: 'Shot', params: {} },
    } as unknown as Parameters<typeof nodeDisplayName>[0];

    expect({
      both: nodeDisplayName(nodes, 'both'),
      paramsOnly: nodeDisplayName(nodes, 'paramsOnly'),
      neither: nodeDisplayName(nodes, 'neither'),
    }).toEqual({
      // meta wins — a director's rename beats the semantic label rather than losing to it…
      both: 'from-meta',
      // …and the semantic label is what shows when there has been no rename, which is
      // exactly the value this issue made authorable.
      paramsOnly: 'from-params',
      // …and with neither, the id. Blank stays the unconfigured state and falls through.
      neither: 'neither',
    });
  });

  it('row 14 — every read-only string param is ACKNOWLEDGED, with the reason it has no control (#1031)', () => {
    // 🔑 THE ROW THIS ISSUE EXISTS FOR. The arm that renders an undeclared string as a
    // read-only span has swallowed a param three times — a component scope (#872), a
    // material colour (#521), a group's name (#1027) — and each was found by noticing a
    // symptom, one at a time, because NOTHING DISTINGUISHED "read-only on purpose" from
    // "read-only by accident". `AnimationClip.sourceHash` and `Prompt.text` landed on the
    // identical arm and read identically in the source.
    //
    // So the fall-through is made to carry a DECISION rather than a silence: every string
    // param the panel cannot author is listed here with the reason it has none, and a
    // param that is neither declared nor listed reds. A fourth one cannot arrive quietly —
    // it has to be answered for at the moment it is added.
    //
    // ⚠️ THIS IS A LIST OF ACKNOWLEDGEMENTS, NOT OF APPROVALS. Two of the three classes
    // below are gaps with a known shape: an identifier wants a PICKER over what exists, and
    // giving it free text would let a director type a name that silently selects nothing —
    // worse than read-only, because it looks like it worked. Tracked separately rather than
    // papered over here — #1032 carries the twenty-five that want one.
    const MINTED =
      'machine-minted — a hash, a handle or an id the product writes; typing one is never right';
    const WIRING =
      'names another node or a path into it — wants a picker, and free text would accept a target that resolves to nothing';
    const CHOICE =
      'selects from what exists at runtime — wants a picker over the live options, for the same reason';

    const ACKNOWLEDGED: Readonly<Record<string, string>> = {
      'AnimationClip.sourceHash': MINTED,
      'GltfAsset.assetRef': MINTED,
      'GltfData.assetRef': MINTED,
      'GltfData.childName': MINTED,
      'KeyframeChannelVec3.assetRef': MINTED,
      'KeyframeChannelVec3.childName': MINTED,
      'KeyframeChannelVec3.sourceClipId': MINTED,
      'KeyframeChannelVec3.sourceHash': MINTED,
      'RenderJob.jobId': MINTED,

      'FollowPath.target': WIRING,
      'KeyframeChannelColor.paramPath': WIRING,
      'KeyframeChannelColor.target': WIRING,
      'KeyframeChannelImage.paramPath': WIRING,
      'KeyframeChannelImage.target': WIRING,
      'KeyframeChannelNumber.paramPath': WIRING,
      'KeyframeChannelNumber.target': WIRING,
      'KeyframeChannelQuat.paramPath': WIRING,
      'KeyframeChannelQuat.target': WIRING,
      'KeyframeChannelText.paramPath': WIRING,
      'KeyframeChannelText.target': WIRING,
      'KeyframeChannelVec2.paramPath': WIRING,
      'KeyframeChannelVec2.target': WIRING,
      'KeyframeChannelVec3.paramPath': WIRING,
      'KeyframeChannelVec3.target': WIRING,
      'ParamDriver.paramPath': WIRING,
      'ParamDriver.target': WIRING,
      'Strip.action': WIRING,
      'Strip.target': WIRING,
      'TrackTo.target': WIRING,

      'ClipSelect.selectedClipName': CHOICE,
      'LightData.tex': CHOICE,
      'LightProfileSelect.selectedProfile': CHOICE,
      'MotionGenerate.model': CHOICE,
      'PoseOverride.bone': CHOICE,
    };

    let examined = 0;
    const readOnly: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      const schema = def?.paramSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      // A declared ref param renders in the inspector's ref block, NOT through `ParamRow`,
      // so it never reaches the read-only arm. Measured, and it is why this subtraction is
      // here: without it `FollowPath.curve` and `TrackTo.aimNode` read as gaps they are not.
      const refParams = (def as { refParams?: Record<string, unknown> } | undefined)?.refParams;
      const refKeys = new Set(refParams ? Object.keys(refParams) : []);
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        examined++;
        if (!(unwrapZod(field) instanceof z.ZodString)) continue;
        if (unwrapZod(field) instanceof z.ZodEnum) continue;
        if (refKeys.has(key)) continue;
        if (widgetOf(field) !== undefined) continue;
        readOnly.push(`${type}.${key}`);
      }
    }

    const unacknowledged = readOnly.filter((k) => !(k in ACKNOWLEDGED)).sort();
    const staleAcknowledgements = Object.keys(ACKNOWLEDGED)
      .filter((k) => !readOnly.includes(k))
      .sort();

    // Both directions, because each catches a different drift: a NEW undeclared string is
    // the gap this issue closes, and a STALE entry means a param got a control (or was
    // deleted) while its excuse stayed behind, which is how a list like this rots into
    // something nobody trusts.
    expect({ examined: examined > 0, unacknowledged, staleAcknowledgements }).toEqual({
      examined: true,
      unacknowledged: [],
      staleAcknowledgements: [],
    });
    // The denominator rides with the verdict — an empty `unacknowledged` from a loop that
    // never ran looks exactly like a pass.
    expect(readOnly.length).toBe(34);
  });

  it('row 5 — the widget union is closed, so a new member must be answered for', () => {
    // 🔴 THIS ROW DID NOT DO WHAT IT SAID, AND #521 IS THE MEASUREMENT (2026-09-03). It read
    //
    //     const all: readonly ParamWidget[] = ['query'];
    //     expect(all).toEqual(['query']);
    //
    // — a literal compared against an identical literal, which is true for every possible
    // union. Adding `'color'` to `ParamWidget` left this row GREEN while its own comment
    // claimed "adding a second one fails HERE". Only NPanel's `never` actually reddened.
    //
    // The fix is a TYPE-level forcing function rather than a value one: a `Record` keyed by
    // the union is a compile error the moment a member is added without a line here. The
    // runtime assertion then pins the census so the record cannot be quietly widened to
    // `Partial`.
    //
    // ⚠️ AND WHAT ACTUALLY ENFORCES IT IN CI IS NPanel's `never`, NOT THIS RECORD — measured.
    // `npm run typecheck` builds `tsconfig.app.json`, which EXCLUDES `*.test.*`, so no gate
    // job compiles this file. Adding a third member reported exactly one error, in NPanel;
    // this Record errored only under a config that includes tests (the changed-file sweep).
    // So the production `never` is the guard, and this row is the readable census beside it.
    // Said plainly because the row it replaces claimed an enforcement it did not have.
    const DRAWN_BY: Record<ParamWidget, string> = {
      query: 'QueryField — free text over the component-selection language',
      color: 'ColorParamField -> MaterialColorRow — swatch + hex (#521)',
    };
    expect(Object.keys(DRAWN_BY).sort()).toEqual(['color', 'query']);
    // When this list grows: add the arm to `ParamRow`'s switch in `src/app/NPanel.tsx`,
    // and give the new control its own e2e row the way `scope` has one — an authorable
    // control that can refuse owes a visible refusal and an observed recovery.
  });

  it('row 7 — every colour param declares the colour control, and none is left read-only', () => {
    // The durable form of the #521 census. Stated as "no colour param lacks the widget"
    // rather than as a fixed list, so a NEW colour param added tomorrow without calling
    // `colorParam()` reds this row instead of silently rendering as text.
    //
    // A colour is identified by what it IS rather than by its name: a top-level string
    // param whose schema default is a six-digit hex. That catches `Composition.background`,
    // which no name-based rule would, and it was measurably missing — #521's body claimed
    // the gap was "limited to" the material nodes and the census found seven sites across
    // four more node types.
    const colours: string[] = [];
    const undeclared: string[] = [];
    let examined = 0;
    for (const type of listNodeTypes()) {
      const schema = getNodeType(type)?.paramSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        examined++;
        if (!(field instanceof z.ZodDefault)) continue;
        const fallback: unknown = field._def.defaultValue();
        if (typeof fallback !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(fallback)) continue;
        colours.push(`${type}.${key}`);
        if (widgetOf(field) !== 'color') undeclared.push(`${type}.${key}`);
      }
    }
    expect({ examined: examined > 0, colours: colours.sort(), undeclared }).toEqual({
      examined: true,
      colours: [
        'AmbientLight.color',
        'Composition.background',
        'LightData.color',
        'MaterialOverride.color',
        'MaterialOverride.emissive',
        'MaterialOverrideOp.color',
        'MaterialOverrideOp.emissive',
      ],
      undeclared: [],
    });
  });

  it('row 8 — colorParam declares the control and does NOT narrow what the schema accepts', () => {
    // `scopeParam` refines because an unparseable query THROWS on the render walk. A colour
    // does not, and narrowing here would change what already-saved projects validate
    // against. So this row pins the absence of a refinement as a decision: a non-hex string
    // must still parse, or existing saves start failing to load.
    const declared = colorParam('#ffffff');
    expect(widgetOf(declared)).toBe('color');
    for (const value of ['#00ff88', 'rebeccapurple', 'not a colour', '']) {
      expect({ value, ok: declared.safeParse(value).success }).toEqual({ value, ok: true });
    }
    expect(declared.parse(undefined)).toBe('#ffffff');
    // Registered per call, like `scopeParam` — two instances, both declared.
    expect(colorParam('#000000')).not.toBe(declared);
    expect(widgetOf(colorParam('#000000'))).toBe('color');
  });

  it('row 9 — a colour the override set COVERS is authorable, so the picker marks the bit', () => {
    // 🔑 THE PAIRING, AND NEITHER HALF IS SUFFICIENT ALONE. `MaterialOverrideOp` composes
    // 'authored-only' (#529): a field the director edits without its bit being set is
    // DISCARDED by the fold. So a colour picker on that node is only real if the descriptor
    // covers the field — otherwise `dispatchOverrideValueEdit` declines, the panel writes a
    // bare `setParam`, and the control looks like it works while changing nothing.
    //
    // The descriptor listed `color` and `emissive` before any widget could reach them, and
    // said so in a note naming #521. This row is the other end of that note: the two facts
    // now have to move together.
    const op = overrideDescriptor('MaterialOverrideOp');
    expect(op).not.toBeNull();
    for (const field of ['color', 'emissive']) {
      expect({
        field,
        covered: op?.fields.includes(field) ?? false,
        widget: widgetOf(fieldOf('MaterialOverrideOp', field)),
      }).toEqual({ field, covered: true, widget: 'color' });
    }

    // ⚠️ THE SCENE-BAND SIBLING IS THE NEGATIVE CONTROL, AND ITS ASYMMETRY IS DELIBERATE.
    // `MaterialOverride` covers only `roughness`/`metalness`: its colour is an
    // always-applied tint with a map-identity default, so the bit is inert and a decorator
    // would imply an inherit-vs-override choice that does not exist. It still gets the
    // PICKER — the widget and the override set are independent questions, which is exactly
    // what this pair of assertions says.
    const wrapper = overrideDescriptor('MaterialOverride');
    expect({
      covered: wrapper?.fields.includes('color') ?? false,
      widget: widgetOf(fieldOf('MaterialOverride', 'color')),
    }).toEqual({ covered: false, widget: 'color' });
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
