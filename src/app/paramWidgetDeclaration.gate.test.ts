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
import {
  colorParam,
  nameParam,
  optionsOf,
  placeholderOf,
  widget,
  widgetOf,
  type ParamOption,
  type ParamWidget,
} from '../nodes/paramWidget';
import { applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { profileOptions } from '../nodes/LightProfileSelect';
import { buildAddPrimitiveOps, SCENE_OBJECT_KINDS } from './addPrimitives';
import { buildAddConstraintOps } from './constraintStack';
import { stripChannelValuesForTarget } from './layeredChannels';
import { resolveConstraintRotation } from './nodeConstraints';
import { stripTargetRows } from './stripTargets';
import { addStripMutator } from '../agent/mutators/builders/addStrip';
import { createActionMutator } from '../agent/mutators/builders/createAction';
import { overrideDescriptor } from './overrideDescriptor';
import { resolveActiveRigNode } from './resolveRigLightSources';
import { nodeDisplayName } from './sceneTreeWalk';
import { activeProfileSelect, buildAddProfileOps } from './studioProfiles';
import { isAnimatable } from './animatableParams';
import { buildAddModifierOps } from './operatorStack';
import { buildNewMaterialOps } from './materialLink';
import { buildBindDriverOps } from './driverBind';
// #1066 — loading the pickers fills the slot the channel schemas ask (boot does this in the app).
import { driverKindsOf } from './channelPickers';
import { bakeBasherControllerValues, bakeComfyBatchedTracks } from './video/compileComfyBatch';
import { comfyParamPath, importComfyGraph, type ComfyApiJson } from '../core/comfy/comfyGraph';
import { comfyControllerPath, scanBasherControllers } from '../core/comfy/basherControllers';

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
    // THE DURABLE FORM, and it is deliberately NOT a fixed list of the twenty-five. A node
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
      // 25 since #1124 retired `MotionGenerate.name` — a generated motion's clip owns its name.
      // 26 at #1240: `PoseLayer.name`, through `nameParam` like every other.
      nameCount: 26,
      undeclared: [],
    });
  });

  it('row 12 — `nameParam` declares the control and does NOT narrow what the schema accepts', () => {
    // Same pairing as row 8, and for the same reason: the widget is presentation, so a
    // declared name must validate EXACTLY as the bare string it replaced. Twenty-five node
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
    // papered over here — #1032 carries every CHOICE entry and every named-wait entry still
    // listed below (twenty-five when this was written; each picker that lands removes its own
    // line). The last generic WIRING entry left in #1066; what wiring remains names its wait.
    const MINTED =
      'machine-minted — a hash, a handle or an id the product writes; typing one is never right';
    const CHOICE =
      'selects from what exists at runtime — wants a picker over the live options, for the same reason';
    // #1066 — channel wiring whose picker waits on a measurement, each named.
    const NO_VEC2_ROWS =
      'the animatable census has no vec2 rows (compositor layers, uvTransform), so no list could be honest (#1259)';
    const NOTHING_READS_IMAGE =
      'a keyed ComfyUI image input reaches nothing in the batch, so there is no path to offer (#1257)';

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
      // #1451 — a collection's id, set by clicking that collection in the outliner, as Blender sets
      // its active collection; a field to type an id into would be the wrong control.
      'Scene.activeCollection': 'set from the outliner by clicking a collection, as in Blender',

      // `FollowPath.target`, `Strip.action`, `Strip.target` and `TrackTo.target` left this list in
      // #1065 — pickers over what the strip fold and the constraint fold can resolve. The Number,
      // Vec3, Color and Text channels' `target`/`paramPath` left it in #1066 — pickers over what
      // the census measured and what a ComfyUI batch reads — and so did ParamDriver's, once the
      // census measured drivers on their own (#1258), and Quat's once it measured both rotation
      // modes (#1259). What stays has a named reason: a
      // picker needs something that KNOWS which paths animate, and for these nothing does yet.
      'KeyframeChannelImage.paramPath': NOTHING_READS_IMAGE,
      'KeyframeChannelImage.target': NOTHING_READS_IMAGE,
      'KeyframeChannelVec2.paramPath': NO_VEC2_ROWS,
      'KeyframeChannelVec2.target': NO_VEC2_ROWS,
      // #1210 — a bone of the parent armature, by name. #1284's bone picker (`TrackTo.aimBone`)
      // offers a character's bones; pointing it at the parent's is what would retire this line.
      'Object.parentBone': CHOICE,
      // #1447 — the same bone name on an imported Empty, which is a Group; the same picker retires it.
      'Group.parentBone': CHOICE,

      'ClipSelect.selectedClipName': CHOICE,
      'LightData.tex': CHOICE,
      // `LightProfileSelect.selectedProfile` left this list in #1064 — the first CHOICE to get
      // its picker. The stale-entry direction below is what makes that removal mandatory.
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
        // No separate enum arm below: a `ZodEnum` is not a `ZodString`, so the line above
        // already excludes it. Spelling it twice would read as a second guard and be dead.
        if (!(unwrapZod(field) instanceof z.ZodString)) continue;
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
    expect(readOnly.length).toBe(20); // 18 + `Group.parentBone` (#1447) + `Scene.activeCollection` (#1451)
  });

  it('row 15 — a param owns the word for its EMPTY state, and the control owns the fallback (#1031)', () => {
    // 🔴 THIS ROW EXISTS BECAUSE THE DEFECT WAS MINE, FOUND IN SELF-REVIEW OF THE COMMIT
    // ABOVE. The `text` arm was added with one caller and hardcoded that caller's word —
    // `placeholder="unnamed"`, right for a group's name. Seven params joined the same arm in
    // this issue, and every one would have rendered "unnamed": a prompt, a media source,
    // three output paths. The control and the word are different questions, and this pins
    // them apart so the next param to join cannot inherit somebody else's sentence.
    const shotName = fieldOf('Shot', 'name')!;
    const promptText = fieldOf('Prompt', 'text')!;

    expect({
      // A name HAS a reading for blank — the node still shows a label from the next rung of
      // `nodeDisplayName`'s ladder, so the field is empty but the node is not anonymous.
      name: placeholderOf(shotName),
      // A prompt does not. It declines, and `ParamRow` supplies the neutral `'empty'`.
      promptText: placeholderOf(promptText),
      // Same control for both — which is the whole point: sharing a widget must not mean
      // sharing a word.
      nameWidget: widgetOf(shotName),
      promptWidget: widgetOf(promptText),
    }).toEqual({
      name: 'unnamed',
      promptText: undefined,
      nameWidget: 'text',
      promptWidget: 'text',
    });

    // Declaring a placeholder must not move validation either — the same rule the widget
    // itself is held to, checked independently rather than assumed to follow from it.
    const withWord = widget('text', z.string().min(2), 'say something');
    const without = z.string().min(2);
    for (const v of ['', 'a', 'ab', 'abc']) {
      expect({ v, ok: withWord.safeParse(v).success }).toEqual({
        v,
        ok: without.safeParse(v).success,
      });
    }
    // …and a schema that was never given one answers undefined rather than a stray word.
    expect(placeholderOf(z.string())).toBeUndefined();
    expect(placeholderOf(undefined)).toBeUndefined();
    expect(placeholderOf('unnamed')).toBeUndefined();

    // The census, so this cannot drift into "every text param declares a word" (which would
    // make the fallback dead) or "none does" (which is the bug it replaces). Every `name`
    // carries one because they all come through the one helper. The one other word is a
    // picker's name for its empty value (#1064): a blank profile is "no profile".
    const declaredWord: string[] = [];
    let examined = 0;
    for (const type of listNodeTypes()) {
      const schema = getNodeType(type)?.paramSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        examined++;
        if (placeholderOf(field) !== undefined) declaredWord.push(`${type}.${key}`);
      }
    }
    expect({ examined: examined > 0, count: declaredWord.length }).toEqual({
      examined: true,
      // 25 `.name`s since #1124 retired `MotionGenerate.name`, the profile picker's word (#1064),
      // the bone picker's (#1284): an empty bone aims at "the object itself"; 28 at #1240
      // (`PoseLayer.name`).
      count: 28,
    });
    expect(declaredWord.filter((k) => !k.endsWith('.name'))).toEqual([
      'LightProfileSelect.selectedProfile',
      'TrackTo.aimBone',
    ]);
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
    //
    // ⚠️ AND IT HAD DRIFTED AGAIN (measured #1064): `text` joined the union in #1027 with no line
    // here, and this Record stopped compiling — `Property 'text' is missing` — which no gate
    // saw, for exactly the reason above. Repaired with all four members.
    const DRAWN_BY: Record<ParamWidget, string> = {
      query: 'QueryField — free text over the component-selection language',
      color: 'ColorParamField -> MaterialColorRow — swatch + hex (#521)',
      text: 'QueryField with testidKind "text" — plain authored string, the param’s own placeholder (#1027)',
      options:
        'OptionsParamField -> OptionsSelect — picker over the provider’s live options (#1064)',
    };
    expect(Object.keys(DRAWN_BY).sort()).toEqual(['color', 'options', 'query', 'text']);
    // When this list grows: add the arm to `ParamRow`'s switch in `src/app/NPanel.tsx`,
    // and give the new control its own e2e row the way `scope` has one — an authorable
    // control that can refuse owes a visible refusal and an observed recovery.
  });

  it('row 16 — declaring the profile picker does not change what `selectedProfile` accepts (#1064)', () => {
    // The pairing row: the schema BEFORE the declaration, rebuilt independently, against the
    // instance the node stores now. A stored name no rig carries must still validate — the
    // picker shows it as not found; refusing it would stop a saved project from loading.
    const before = z.string().default('');
    const field = fieldOf('LightProfileSelect', 'selectedProfile')!;
    const cases: unknown[] = [undefined, '', 'Key', 'a profile that is gone', 42, null, {}];
    const verdict = (s: z.ZodTypeAny, v: unknown) => {
      const r = s.safeParse(v);
      return r.success ? { ok: true, value: r.data } : { ok: false };
    };
    expect({ examined: cases.length, now: cases.map((v) => verdict(field, v)) }).toEqual({
      examined: 7,
      now: cases.map((v) => verdict(before, v)),
    });
    expect(widgetOf(field)).toBe('options');
  });

  it('row 17 — every options param has a provider, and every provider sits on an options param (#1064)', () => {
    // Both directions: an `options` control with no provider draws an empty list, and a
    // provider on a param drawn some other way is a picker nobody sees.
    let examined = 0;
    const optionsWidget: string[] = [];
    const withProvider: string[] = [];
    for (const type of listNodeTypes()) {
      const schema = getNodeType(type)?.paramSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        examined++;
        if (widgetOf(field) === 'options') optionsWidget.push(`${type}.${key}`);
        if (optionsOf(field) !== undefined) withProvider.push(`${type}.${key}`);
      }
    }
    expect({ examined: examined > 0, optionsWidget, withProvider }).toEqual({
      examined: true,
      optionsWidget: [
        'FollowPath.target',
        'KeyframeChannelColor.target',
        'KeyframeChannelColor.paramPath',
        'KeyframeChannelNumber.target',
        'KeyframeChannelNumber.paramPath',
        'KeyframeChannelQuat.target',
        'KeyframeChannelQuat.paramPath',
        'KeyframeChannelText.target',
        'KeyframeChannelText.paramPath',
        'KeyframeChannelVec3.target',
        'KeyframeChannelVec3.paramPath',
        'LightProfileSelect.selectedProfile',
        'ParamDriver.target',
        'ParamDriver.paramPath',
        'Strip.action',
        'Strip.target',
        'TrackTo.target',
        'TrackTo.aimBone',
      ],
      withProvider: [
        'FollowPath.target',
        'KeyframeChannelColor.target',
        'KeyframeChannelColor.paramPath',
        'KeyframeChannelNumber.target',
        'KeyframeChannelNumber.paramPath',
        'KeyframeChannelQuat.target',
        'KeyframeChannelQuat.paramPath',
        'KeyframeChannelText.target',
        'KeyframeChannelText.paramPath',
        'KeyframeChannelVec3.target',
        'KeyframeChannelVec3.paramPath',
        'LightProfileSelect.selectedProfile',
        'ParamDriver.target',
        'ParamDriver.paramPath',
        'Strip.action',
        'Strip.target',
        'TrackTo.target',
        'TrackTo.aimBone',
      ],
    });
  });

  it('row 19 — every strip and constraint option resolves once written, and nothing left out does (#1065)', () => {
    // The property #1064 set for every provider, checked through each param's REAL resolver and
    // in both directions: an offered option that resolves nothing is a picker that lies, and a
    // resolvable node left out is a target the director cannot reach. One of every scene
    // primitive, so the lists have placed and unplaced nodes to tell apart.
    const FRAME = { time: { frame: 0, seconds: 0, normalized: 0 } };
    const apply = (st: DagState, ops: readonly Op[]) => {
      let n = st;
      for (const op of ops) n = applyOp(n, op).next;
      return n;
    };
    let s = buildDefaultDagState();
    for (const kind of SCENE_OBJECT_KINDS) {
      const r = buildAddPrimitiveOps(s, kind, [1, 0, 0]);
      if (r) s = apply(s, r.ops);
    }
    const none = new Set<string>() as never;
    s = apply(
      s,
      createActionMutator.build(
        createActionMutator.spec.parse(createActionMutator.specExample),
        none,
        s,
      ),
    );
    const providerOf = (type: string, key: string) =>
      optionsOf((getNodeType(type)!.paramSchema as z.ZodObject<z.ZodRawShape>).shape[key])!;
    const enabled = (type: string, key: string) =>
      providerOf(type, key)(s, '')
        .filter((o) => !o.disabledReason)
        .map((o) => o.value);

    // Constraint target — the aim band, aimed at a fixed point no node sits on.
    const constrained = enabled('TrackTo', 'target');
    expect(enabled('FollowPath', 'target'), 'both constraints offer one list').toEqual(constrained);
    const aimOf = (target: string) => {
      const added = buildAddConstraintOps(s, target, 'TrackTo', 'con_probe')!;
      const t = apply(s, [
        ...added.ops,
        { type: 'setParam', nodeId: 'con_probe', paramPath: 'aimPoint', value: [37, 11, -23] },
      ]);
      return resolveConstraintRotation(t, target, FRAME);
    };
    const all = Object.keys(s.nodes);
    expect({ examined: all.length, offered: constrained.length > 0 }).toMatchObject({
      offered: true,
    });
    for (const id of all) {
      const resolves = aimOf(id) !== null;
      expect({ id, type: s.nodes[id].type, resolves }).toEqual({
        id,
        type: s.nodes[id].type,
        resolves: constrained.includes(id),
      });
    }

    // Strip action — through the strip fold, on a target the popover offers.
    const actions = enabled('Strip', 'action');
    const target = enabled('Strip', 'target')[0];
    expect(actions.length, 'the Action the builder made is offered').toBeGreaterThan(0);
    const foldedWith = (action: string) =>
      stripChannelValuesForTarget(
        apply(
          s,
          addStripMutator.build(
            addStripMutator.spec.parse({ action, target, stripId: 'strip_probe' }),
            none,
            s,
          ),
        ).nodes,
        target,
      ).length;
    for (const id of all) {
      expect({ id, folds: foldedWith(id) > 0 }).toEqual({ id, folds: actions.includes(id) });
    }

    // Strip target — the add-strip popover's own rows, so the two cannot disagree.
    expect(enabled('Strip', 'target')).toEqual(stripTargetRows(s).map((r) => r.id));
  });

  it('row 20 — every channel target+path option animates once written, and nothing left out does (#1066)', () => {
    // V558's property for the channel pickers, both ways, against each road's own answer:
    //   - a scene node: the measured census (`isAnimatable`) on EVERY concrete leaf of the
    //     channel's shape, so a path the picker drops or a pattern it mis-expands reds;
    //   - a ComfyUI workflow: the batch bake itself — each input is keyed A → B and counts only
    //     when the baked values move AND the baked input's declared kind is the channel's.
    // Two workflows, one per compile mode, because Mode A reads controllers and IGNORES keyed
    // foreign inputs: the mode branch is exactly what a picker could get wrong.
    const apply = (st: DagState, ops: readonly Op[]) => {
      let n = st;
      for (const op of ops) n = applyOp(n, op).next;
      return n;
    };
    let s = buildDefaultDagState();
    for (const kind of SCENE_OBJECT_KINDS) {
      const r = buildAddPrimitiveOps(s, kind, [1, 0, 0]);
      if (r) s = apply(s, r.ops);
    }
    // The contexts the census answers "unmeasured" for, built by the product's own builders, so
    // a picker that offered "not still" instead of "animates" would list them (and reds).
    const placeKind = (kind: 'Cube' | 'Sphere' | 'Math') => {
      const r = buildAddPrimitiveOps(s, kind, [2, 0, 0])!;
      s = apply(s, r.ops);
      return { obj: r.newNodeId, data: r.dataNodeId ?? r.newNodeId };
    };
    const linked = placeKind('Cube');
    s = apply(s, buildNewMaterialOps(s, linked.data)!.ops);
    const stacked = placeKind('Cube');
    s = apply(s, buildAddModifierOps(s, stacked.data, 'UVProjectModifier')!.ops);
    const aimed = placeKind('Cube');
    s = apply(s, buildAddConstraintOps(s, aimed.obj, 'TrackTo')!.ops);
    const driven = placeKind('Sphere');
    const source = placeKind('Math');
    const bind = buildBindDriverOps(s, {
      targetId: driven.data,
      paramPath: 'radius',
      source: { kind: 'output', id: 'm', label: 'm', ref: { node: source.obj, socket: 'out' } },
      driverId: 'drv',
    });
    s = apply(s, bind.ok ? bind.ops : []);
    expect(bind.ok, 'the driver binds').toBe(true);
    // #1259 — a quaternion is a leaf only once held, as the census seeds it: every node whose
    // schema declares a rotation mode holds the identity, and one Sphere composes it.
    const posable = Object.values(s.nodes).filter((n) => {
      const shape = (getNodeType(n.type)?.paramSchema as z.ZodObject<z.ZodRawShape>)?.shape;
      return shape !== undefined && 'rotationMode' in shape;
    });
    s = apply(
      s,
      posable.map((n) => ({
        type: 'setParam' as const,
        nodeId: n.id,
        paramPath: 'quaternion',
        value: [0, 0, 0, 1],
      })),
    );
    const turned = placeKind('Sphere');
    s = apply(s, [
      { type: 'setParam', nodeId: turned.obj, paramPath: 'quaternion', value: [0, 0, 0, 1] },
      { type: 'setParam', nodeId: turned.obj, paramPath: 'rotationMode', value: 'quaternion' },
    ]);

    const META = { name: 'w', importedAt: 'fixed', fps: 30, frames: 24 };
    const MODE_B: ComfyApiJson = {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 42, steps: 20, cfg: 6.5, sampler_name: 'euler', denoise: 1 },
      },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cube' } },
      '9': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    };
    const MODE_A: ComfyApiJson = {
      '3': { class_type: 'KSampler', inputs: { cfg: ['10', 0], denoise: 1 } },
      '10': {
        class_type: 'basher_controller',
        inputs: { name: 'CFG', kind: 'float', values_json: '[7.5]', frame_count: 1 },
      },
      '11': {
        class_type: 'basher_controller',
        inputs: { name: 'Prompt', kind: 'string', values_json: '["x"]', frame_count: 1 },
      },
      '12': {
        class_type: 'basher_controller',
        inputs: { name: 'Flip', kind: 'bool', values_json: '[false]', frame_count: 1 },
      },
    };
    const WORKFLOWS: Record<string, ComfyApiJson> = { wfB: MODE_B, wfA: MODE_A };
    s = apply(
      s,
      Object.entries(WORKFLOWS).map(([id, api]) => ({
        type: 'addNode' as const,
        nodeId: id,
        nodeType: 'ComfyUIWorkflow',
        params: { graph: importComfyGraph(api, META) },
      })),
    );

    const CHANNELS = [
      ['KeyframeChannelNumber', 'number', 1, 9],
      ['KeyframeChannelVec3', 'vec3', [0, 0, 0], [1, 2, 3]],
      ['KeyframeChannelQuat', 'quat', [0, 0, 0, 1], [0.2, 0.3, 0.1, 0.927]],
      ['KeyframeChannelColor', 'color', '#000000', '#ffffff'],
      ['KeyframeChannelText', 'text', 'A', 'B'],
    ] as const;
    const shapeOf = (v: unknown): string | null => {
      if (typeof v === 'number') return 'number';
      if (typeof v === 'string') return /^#[0-9a-fA-F]{6}$/.test(v) ? 'color' : null;
      if (Array.isArray(v) && v.every((x) => typeof x === 'number'))
        return v.length === 3 ? 'vec3' : v.length === 4 ? 'quat' : null;
      return null;
    };
    const leaves = (v: unknown, at: string[], out: [string, string][]) => {
      const shape = shapeOf(v);
      if (shape) out.push([at.join('.'), shape]);
      else if (v !== null && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) leaves(x, [...at, k], out);
      return out;
    };

    // Every input a channel or driver could name on a workflow: its controllers (Mode A) and
    // every raw input (Mode B).
    const comfyCandidates = (api: ComfyApiJson) => [
      ...scanBasherControllers(api).map((d) => ({
        path: comfyControllerPath(d.nodeId),
        declaredKind: d.kind as string | null,
      })),
      ...Object.entries(api).flatMap(([nid, n]) =>
        Object.keys(n.inputs ?? {}).map((input) => ({
          path: comfyParamPath(nid, input),
          declaredKind: null as string | null,
        })),
      ),
    ];

    const counted: Record<string, number> = {};
    for (const [type, kind, a, b] of CHANNELS) {
      const field = (key: string) =>
        optionsOf((getNodeType(type)!.paramSchema as z.ZodObject<z.ZodRawShape>).shape[key])!;
      const withProbe = (target: string, path: string, keyed: boolean) =>
        apply(s, [
          {
            type: 'addNode',
            nodeId: 'probe',
            nodeType: type,
            params: {
              target,
              paramPath: path,
              keyframes: keyed
                ? [
                    { time: 0, value: a, easing: 'linear' },
                    { time: 0.1, value: b, easing: 'linear' },
                  ]
                : [],
            },
          },
        ]);

      // What the pickers offer: every enabled target, then every enabled path on it.
      const offered: string[] = [];
      for (const t of field('target')(withProbe('', '', false), 'probe')) {
        if (t.disabledReason) continue;
        for (const pth of field('paramPath')(withProbe(t.value, '', false), 'probe'))
          if (!pth.disabledReason) offered.push(`${t.value} ${pth.value}`);
      }

      // What animates, asked of each road independently of the pickers.
      const truth: string[] = [];
      // No scene param is a text channel's (the census measures no text), so its truth is
      // ComfyUI-only below.
      if (kind !== 'text')
        for (const [id, node] of Object.entries(s.nodes)) {
          if (node.type === 'ComfyUIWorkflow') continue;
          for (const [path, shape] of leaves(node.params, [], []))
            if (shape === kind && isAnimatable(s, id, path, kind).answer === 'animatable')
              truth.push(`${id} ${path}`);
        }
      if (kind === 'number' || kind === 'text') {
        const declared = kind === 'number' ? ['float', 'int'] : ['string'];
        for (const [id, api] of Object.entries(WORKFLOWS)) {
          const decls = scanBasherControllers(api);
          for (const c of comfyCandidates(api)) {
            const st = withProbe(id, c.path, true);
            if (decls.length > 0) {
              const baked = bakeBasherControllerValues(st, id, decls, 0, 3, 30, 4);
              const moved = Object.entries(baked).some(
                ([cid, vs]) =>
                  comfyControllerPath(cid) === c.path && new Set(vs.map(String)).size > 1,
              );
              if (moved && declared.includes(String(c.declaredKind))) truth.push(`${id} ${c.path}`);
            } else {
              const track = bakeComfyBatchedTracks(
                st,
                id,
                importComfyGraph(api, META),
                0,
                3,
                30,
                4,
              ).find((t) => comfyParamPath(t.nodeId, t.inputName) === c.path);
              if (
                track &&
                new Set(track.values.map(String)).size > 1 &&
                declared.includes(track.valueKind)
              )
                truth.push(`${id} ${c.path}`);
            }
          }
        }
      }
      expect({ kind, offered: [...offered].sort() }).toEqual({ kind, offered: [...truth].sort() });
      counted[kind] = truth.length;
    }
    // The denominators ride with the verdict: an empty list on both sides would pass.
    expect(
      Object.values(counted).every((n) => n > 0),
      JSON.stringify(counted),
    ).toBe(true);

    // ParamDriver (#1258): the same property against the census's DRIVER answers, which differ
    // from the channel's (the camera pose ignores a driver, #1266). A driver's kind is its
    // source's, so one probe per road: each must offer exactly the leaves of its own kind(s).
    const controller = Object.values(s.nodes).find((n) => n.type === 'Null')!.id;
    const DRIVERS: readonly (readonly [string, Record<string, unknown>, boolean, string[]])[] = [
      ['unbound', {}, false, ['number', 'vec3']],
      ['transform', { sourceTransform: { node: controller, channel: 'tx' } }, false, ['number']],
      ['point', { sourceTransformVec: { node: controller } }, false, ['vec3']],
      ['wired Number', {}, true, ['number']],
    ];
    // A workflow's truth for a driver, measured on its own: a driver writing a sentinel onto
    // each candidate, baked; it counts when the sentinel reaches a number-kind input.
    const SENTINEL = 4242;
    const comfyDriverTruth: string[] = [];
    for (const [id, api] of Object.entries(WORKFLOWS)) {
      const decls = scanBasherControllers(api);
      for (const c of comfyCandidates(api)) {
        const st = apply(s, [
          {
            type: 'addNode',
            nodeId: 'sentinel',
            nodeType: 'ParamDriver',
            params: {
              target: id,
              paramPath: c.path,
              sourceTransform: {
                node: controller,
                channel: 'tx',
                remap: { inMin: 0, inMax: 1, outMin: SENTINEL, outMax: SENTINEL },
              },
            },
          },
        ]);
        const reached =
          decls.length > 0
            ? Object.entries(bakeBasherControllerValues(st, id, decls, 0, 3, 30, 4)).some(
                ([cid, vs]) =>
                  comfyControllerPath(cid) === c.path &&
                  vs.includes(SENTINEL) &&
                  ['float', 'int'].includes(String(c.declaredKind)),
              )
            : bakeComfyBatchedTracks(st, id, importComfyGraph(api, META), 0, 3, 30, 4).some(
                (t) =>
                  comfyParamPath(t.nodeId, t.inputName) === c.path &&
                  t.values.includes(SENTINEL) &&
                  ['float', 'int'].includes(t.valueKind),
              );
        if (reached) comfyDriverTruth.push(`${id} ${c.path}`);
      }
    }

    const driverField = (key: string) =>
      optionsOf(
        (getNodeType('ParamDriver')!.paramSchema as z.ZodObject<z.ZodRawShape>).shape[key],
      )!;
    const driverOffered: Record<string, number> = {};
    for (const [road, fields, wired, kinds] of DRIVERS) {
      const withDriver = (target: string) =>
        apply(s, [
          {
            type: 'addNode',
            nodeId: 'probe',
            nodeType: 'ParamDriver',
            params: { target, paramPath: '', ...fields },
          },
          ...(wired
            ? [
                {
                  type: 'connect' as const,
                  from: { node: source.obj, socket: 'out' },
                  to: { node: 'probe', socket: 'in' },
                },
              ]
            : []),
        ]);
      expect({ road, kinds: driverKindsOf(withDriver(''), 'probe') }).toEqual({ road, kinds });
      const offered: string[] = [];
      for (const t of driverField('target')(withDriver(''), 'probe')) {
        if (t.disabledReason) continue;
        for (const pth of driverField('paramPath')(withDriver(t.value), 'probe'))
          if (!pth.disabledReason) offered.push(`${t.value} ${pth.value}`);
      }
      const truth: string[] = [];
      for (const [id, node] of Object.entries(s.nodes)) {
        if (node.type === 'ComfyUIWorkflow') continue;
        for (const [path, shape] of leaves(node.params, [], []))
          if (
            kinds.includes(shape) &&
            isAnimatable(s, id, path, shape as 'number' | 'vec3', { mechanism: 'driver' })
              .answer === 'animatable'
          )
            truth.push(`${id} ${path}`);
      }
      if (kinds.includes('number')) truth.push(...comfyDriverTruth);
      expect({ road, offered: [...offered].sort() }).toEqual({ road, offered: [...truth].sort() });
      driverOffered[road] = truth.length;
    }
    // Denominators, and the kind split is real: the union is exactly its two halves.
    expect(
      Object.values(driverOffered).every((n) => n > 0),
      JSON.stringify(driverOffered),
    ).toBe(true);
    expect(driverOffered.unbound).toBe(driverOffered.transform + driverOffered.point);
    expect(comfyDriverTruth.length, 'a driver reaches some workflow input').toBeGreaterThan(0);
  });

  it('row 18 — every enabled profile option, once chosen, resolves to that rig on both roads (#1064)', () => {
    // The property the provider owes. Built with the product's own "+ Profile" builder, then
    // pushed into the shapes that break a name lookup: a blank name, a duplicate name, and a
    // rig in the graph that is not wired into the select.
    const FRAME = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };
    const apply = (s: DagState, ops: readonly Op[]) => {
      let n = s;
      for (const op of ops) n = applyOp(n, op).next;
      return n;
    };
    let s = buildDefaultDagState();
    for (const name of ['Key', 'Rim', 'Fill', 'Dup'])
      s = apply(s, buildAddProfileOps(s, name, [0, 0, 0])!.ops);
    const rigId = (name: string) =>
      Object.values(s.nodes).find(
        (n) => n.type === 'LightRig' && (n.params as { name: string }).name === name,
      )!.id;
    s = apply(s, [
      { type: 'setParam', nodeId: rigId('Fill'), paramPath: 'name', value: '' },
      { type: 'setParam', nodeId: rigId('Dup'), paramPath: 'name', value: 'Key' },
      { type: 'addNode', nodeId: 'rig_loose', nodeType: 'LightRig', params: { name: 'Loose' } },
    ]);
    const selId = activeProfileSelect(s)!;

    const resolves = (st: DagState, list: readonly ParamOption[]) =>
      list
        .filter((o) => o.disabledReason === undefined)
        .map((o) => {
          const after = apply(st, [
            { type: 'setParam', nodeId: selId, paramPath: 'selectedProfile', value: o.value },
          ]);
          const value = evaluate(after, selId, FRAME).value as { name?: string } | null;
          const rendered = resolveActiveRigNode(after);
          return {
            option: o.value,
            evaluate: value?.name === o.value,
            render:
              rendered !== null &&
              (after.nodes[rendered].params as { name: string }).name === o.value,
          };
        });

    const offered = optionsOf(fieldOf('LightProfileSelect', 'selectedProfile'))!(s, selId);
    expect(offered).toEqual(profileOptions(s, selId));
    expect({
      offered: offered.map((o) => `${o.value}${o.disabledReason ? ' (disabled)' : ''}`),
      resolved: resolves(s, offered),
    }).toEqual({
      offered: ['Key', 'Rim', ' (disabled)', 'Key (disabled)'],
      resolved: [
        { option: 'Key', evaluate: true, render: true },
        { option: 'Rim', evaluate: true, render: true },
      ],
    });

    // Positive control: the same property over a provider with the WRONG domain — every rig in
    // the graph, the shape Light Studio's switcher has today (#1110) — catches the unwired rig,
    // so the row above can fail. Spelled here rather than borrowed from that switcher, so fixing
    // #1110 cannot quietly turn this control into a row that asserts nothing.
    const everyRig = Object.values(s.nodes)
      .filter((n) => n.type === 'LightRig')
      .map((n) => (n.params as { name: string }).name)
      .filter((name) => name !== '')
      .map((name) => ({ value: name, label: name }));
    expect(
      resolves(s, everyRig)
        .filter((r) => !r.evaluate || !r.render)
        .map((r) => r.option),
    ).toEqual(['Loose']);
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
