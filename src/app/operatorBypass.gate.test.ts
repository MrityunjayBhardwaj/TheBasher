// ns-2 step 3 — THE BYPASS AND THE MEMBERSHIP LISTS, pinned exactly, each figure carrying
// the population it was counted over.
//
// ── WHY EVERY NUMBER HERE NAMES ITS POPULATION ────────────────────────────────────────
//
// The bypass concept is genuinely spelled across three unrelated categories — operators,
// constraints/drivers, and the timeline — in two vocabularies (`mute` and `muted`). A
// repo-wide count of the CONCEPT is therefore never wrong about the concept and is easy to
// be wrong about the SUBJECT: it lands in a document whose scope is one category, nothing
// in the number carries its category, and it survives every review because it is a real
// count of a real thing. That already happened to this phase's own plan, which carried
// "three unchecked casts" for the operator lane when three is the constraint/driver lane's
// number and the operator lane's is one. The same mis-scoped census also HID a member: it
// looked for casts, so it never saw the TYPED read of the same field one module over.
//
// So each assertion below states its population in its own name, and the out-of-scope
// lanes are pinned too — not because this phase touches them, but because a number that
// can only be read next to its neighbours is the number that cannot be quietly re-scoped.
//
// ── THE THREE FIGURES THIS FILE CORRECTS ──────────────────────────────────────────────
//
//   the plan said              measured here (552 non-test source files)
//   ─────────────────────────  ────────────────────────────────────────────────────────
//   "the 7 `muted:`"           7 in source — right, and it is THREE different populations:
//                              7 declared in source, 6 of them on registered node types
//                              (the 7th is the shared f-curve modifier base, which is the
//                              GOOD one this phase cites as its counter-example), and 5
//                              inside the operator category.
//   "the 11 `mute:`"           12 in source; 11 on registered node types. The 12th is an
//                              agent mutator's INPUT schema — a consumer, not a
//                              declaration.
//   "the 3 casts"              1 in the operator lane, plus 1 typed read the census that
//                              produced "3" could not see. The 3 are constraint/driver;
//                              2 more are the timeline. Both lanes are out of scope, and
//                              are pinned here so that stays visible.
//
// 🔄 THE THREE FIGURES ABOVE ARE STEP 3's, AND ONE OF THEM HAS SINCE MOVED. Step 5
// migrated the operator lane's honouring: the one unchecked cast and the one typed read
// are now a single checked read in `src/core/dag/chainBypass.ts`, and the five per-operator
// `evaluate` guards are gone. The constraint/driver and timeline lanes are untouched and
// their counts are unchanged, which is what the cast assertion below now says. The table
// above is left as written because it records what was measured and when — but nothing in
// it should be read as describing the tree today.
//
// ── WHAT THE LAST ASSERTION IS FOR ────────────────────────────────────────────────────
//
// `chainInput`-declarers minus `muted`-declarers is the whole defect in one line. Being an
// operator and being bypassable are the same claim about the same category, and today they
// are two independent acts of remembering — so the difference is not empty, and the two
// nodes in it are bypassable-by-accident rather than by declaration. When the base lands,
// that difference becomes a DECLARED answer instead of a missing one.
//
// REF: `.anvi/…/phases/ns-2-component-groups/PLAN.md` §8 step 3 + §17 (the corrections);
//      `CONTRACT-CENSUS.md` §3 #2 and #3; src/app/operatorChain.ts (four of the lists);
//      src/nodes/channelModifiers.ts (the shared base, one lane over);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #607, #660, #673.

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { stripComments } from '../test-utils/sourceScan';
import { sourceFiles } from '../../tools/gates/sourceFiles';

/** Every non-test source file, comment-stripped. Prose that QUOTES a pattern is not a use. */
const FILES: readonly (readonly [string, string])[] = sourceFiles().map(
  ([path, src]) => [path, stripComments(src)] as const,
);

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/**
 * Files declaring `<field>: z.…` in a schema, with a count each.
 *
 * Sorted with a plain `.sort()` and not `localeCompare`, deliberately: collation is
 * locale- and ICU-dependent, so a gate that pins an ORDER through `localeCompare` can pass
 * here and red on a runner with different collation data. Plain lexicographic order is a
 * property of the strings.
 */
function zodDeclarations(field: string): [string, number][] {
  const re = new RegExp(`\\b${field}:\\s*z\\.`, 'g');
  return FILES.map(([path, src]) => [path, (src.match(re) ?? []).length] as [string, number])
    .filter(([, count]) => count > 0)
    .sort();
}

/** The registered node types whose param schema declares `field`. */
function registeredDeclaring(field: string): string[] {
  return listNodeTypes()
    .filter((type) => {
      const shape = (
        getNodeType(type)?.paramSchema as unknown as { shape?: Record<string, unknown> }
      )?.shape;
      return !!shape && Object.prototype.hasOwnProperty.call(shape, field);
    })
    .sort();
}

/** Registered types whose schema could not be read at all — must be empty before any count. */
function unreadableSchemas(): string[] {
  return listNodeTypes()
    .filter(
      (type) =>
        !(getNodeType(type)?.paramSchema as unknown as { shape?: Record<string, unknown> })?.shape,
    )
    .sort();
}

/** The registered types declaring a chain spine — the operator category, as it stands today. */
function chainInputDeclarers(): string[] {
  return listNodeTypes()
    .filter((type) => getNodeType(type)?.chain?.input !== undefined)
    .sort();
}

/** The literal body of a list declaration, whitespace-collapsed, or `UNREADABLE`. */
function listBody(path: string, re: RegExp): string {
  const src = FILES.find(([p]) => p === path)?.[1];
  if (src === undefined) return 'UNREADABLE';
  const match = re.exec(src);
  return match ? match[1].replace(/\s+/g, ' ').trim() : 'UNREADABLE';
}

describe('ns-2 step 3 — the bypass, censused with its category attached', () => {
  it('THE INSTRUMENT CONTROL: the census sees a member whose file was read by hand', () => {
    // `src/nodes/ArrayModifier.ts` declares `muted: z.boolean().default(false)` — read, not
    // inferred. A census that cannot find this one is reporting about itself.
    const arrayModifier = FILES.find(([p]) => p === 'src/nodes/ArrayModifier.ts')?.[1];
    expect(arrayModifier).toBeDefined();
    expect(arrayModifier).toContain('muted: z.boolean()');
    expect(zodDeclarations('muted').map(([p]) => p)).toContain('src/nodes/ArrayModifier.ts');

    // The population is 552 non-test source files as of this commit, recorded in the header
    // rather than pinned to the digit. What IS pinned is that the corpus has not silently
    // shrunk: the failure this guards against is an enumeration that stops descending into a
    // directory and reports a clean, closed set over a smaller world. A tripwire on the exact
    // count would instead fire on every unrelated file this phase adds, and a gate that gets
    // its number bumped by reflex every few commits is one nobody reads.
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('THE INSTRUMENT CONTROL: every registered schema could be read', () => {
    // A probe reaching through a field name it guessed reports a clean zero, and a zero
    // here would agree with this phase's own thesis — the most expensive kind.
    expect(unreadableSchemas()).toEqual([]);
    expect(listNodeTypes()).toHaveLength(80);
  });

  it('`muted` is declared SEVEN times in source, and that is three different populations', () => {
    expect(zodDeclarations('muted')).toEqual([
      ['src/nodes/ArrayModifier.ts', 1],
      ['src/nodes/ColorCorrect.ts', 1],
      ['src/nodes/MaterialOverrideOp.ts', 1],
      ['src/nodes/MirrorModifier.ts', 1],
      ['src/nodes/SetMaterialOp.ts', 1],
      // A video strip. Bypassable, and not an operator — it declares no chain spine.
      ['src/nodes/Strip.ts', 1],
      // NOT a node type: the shared f-curve modifier base, one lane over. It is the
      // working counter-example this phase exists to carry back — a category that
      // declares its shared fields ONCE — and it has been sitting there since July.
      ['src/nodes/channelModifiers.ts', 1],
    ]);

    // Six of the seven are on registered node types; the seventh is that shared base.
    expect(registeredDeclaring('muted')).toEqual([
      'ArrayModifier',
      'ColorCorrect',
      'MaterialOverrideOp',
      'MirrorModifier',
      'SetMaterialOp',
      'Strip',
    ]);

    // Five are inside the operator category, and that number is DERIVED — the category is
    // "declares a chain spine", not a list someone maintains. `Strip` drops out on its own.
    const operatorsDeclaringMuted = chainInputDeclarers().filter((t) =>
      registeredDeclaring('muted').includes(t),
    );
    expect(operatorsDeclaringMuted).toEqual([
      'ArrayModifier',
      'ColorCorrect',
      'MaterialOverrideOp',
      'MirrorModifier',
      'SetMaterialOp',
    ]);
  });

  it('`mute` — the SECOND vocabulary — is declared twelve times in source, eleven on node types', () => {
    // Two spellings of one concept, and nothing anywhere relates them. A new operator that
    // picks the wrong one gets a mute button that does nothing.
    expect(zodDeclarations('mute').map(([path]) => path)).toEqual([
      // NOT a node declaration: an agent mutator's INPUT schema — a consumer of the field.
      'src/agent/mutators/builders/setTrackState.ts',
      'src/nodes/FollowPath.ts',
      'src/nodes/KeyframeChannelColor.ts',
      'src/nodes/KeyframeChannelImage.ts',
      'src/nodes/KeyframeChannelNumber.ts',
      'src/nodes/KeyframeChannelQuat.ts',
      'src/nodes/KeyframeChannelText.ts',
      'src/nodes/KeyframeChannelVec2.ts',
      'src/nodes/KeyframeChannelVec3.ts',
      'src/nodes/ParamDriver.ts',
      'src/nodes/Track.ts',
      'src/nodes/TrackTo.ts',
    ]);
    expect(registeredDeclaring('mute')).toHaveLength(11);

    // 19 declarations of one concept across 80 node types, in two vocabularies, and no
    // node declares both.
    expect(zodDeclarations('muted').length + zodDeclarations('mute').length).toBe(19);
    expect(
      registeredDeclaring('muted').filter((t) => registeredDeclaring('mute').includes(t)),
    ).toEqual([]);
  });

  it('the bypass is READ BACK per lane, and this phase has now migrated exactly one of them', () => {
    // The unchecked cast — `(node.params as {muted?: unknown}).muted === true` — which
    // cannot tell "declared and false" from "never declared".
    const casts = FILES.filter(([, src]) => /as\s*\{[^}]*mute[dD]?\??:[^}]*\}/.test(src))
      .map(([path, src]) => [path, (src.match(/as\s*\{[^}]*mute[dD]?\??:[^}]*\}/g) ?? []).length])
      .sort();
    // 🔄 ns-2 step 5: `src/app/operatorStack.ts` LEFT this list. It is the operator lane's
    // only cast and it is now one checked read through `chain.bypass`. The three lanes
    // that remain are the ones §11 scopes out, and they stay pinned here for the reason
    // they always were — a count that can only be read next to its neighbours is the count
    // nobody can quietly re-scope. Their numbers are UNCHANGED across step 5, which is
    // itself the assertion that this step stayed inside its lane.
    expect(casts).toEqual([
      ['src/app/constraintStack.ts', 1], // constraint / driver lane — OUT of this phase (#673)
      ['src/app/nodeConstraints.ts', 2], // constraint / driver lane — OUT of this phase (#673)
      ['src/timeline/TimelineDrawer.tsx', 2], // timeline lane — OUT of this phase
    ]);

    // The second honouring site in this phase's lane, and it was not a cast at all — which
    // is why a syntax census of casts could not see it, and why it would have survived the
    // consolidation reading the raw field after the field stopped being the declaration.
    //
    // Asserted POSITIVELY, on what it does now rather than on what it no longer says. The
    // obvious edit here was to flip the old `toContain('params.muted === true')` to a
    // `not.toContain`, and that assertion would pass on a file that had been emptied, or
    // renamed, or that spelled the raw read one space differently — it examines nothing.
    // Naming the shared predicate reds if the raw read comes back under any spelling.
    const owner = FILES.find(([p]) => p === 'src/app/resolveMaterialFieldOwner.ts')?.[1];
    expect(owner).toBeDefined();
    expect(owner).toContain('isBypassed(');

    // The arithmetic, restated in the open and by the minimum: `3 → 1`, never `3 → 0`.
    // One read survives, in `chainBypass.ts`, and what makes it CHECKED rather than merely
    // fewer is that the field name comes from the declaration and registration has already
    // refused a declaration whose named param the schema does not declare as a boolean.
    const stack = FILES.find(([p]) => p === 'src/app/operatorStack.ts')?.[1];
    expect(stack).toBeDefined();
    expect(stack).toContain('isBypassed(');
    expect(stack).toContain('bypassParamOf(');
  });

  it('THE DEFECT IN ONE LINE: being an operator and being bypassable are remembered separately', () => {
    expect(chainInputDeclarers()).toEqual([
      'ArrayModifier',
      'ColorCorrect',
      'MaterialOverride',
      'MaterialOverrideOp',
      'MirrorModifier',
      'SetMaterialOp',
      'Transform',
    ]);

    // Two operators declare no bypass. Nothing says whether that is a decision or an
    // omission, because there is nowhere to say it — and the cast that reads the field
    // gives both the same answer as an operator that declared `false` on purpose.
    const chainMinusMuted = chainInputDeclarers().filter(
      (t) => !registeredDeclaring('muted').includes(t),
    );
    expect(chainMinusMuted).toEqual(['MaterialOverride', 'Transform']);
  });

  it('SEVEN hand-maintained membership lists, contents pinned as literals', () => {
    // Four lists spell two sets of two, one spells a set of one, and each pair agrees only
    // because both halves were typed by the same hand on the same afternoon.
    expect(
      listBody('src/app/operatorChain.ts', /MODIFIER_NODE_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/),
    ).toBe("'ArrayModifier', 'MirrorModifier',");
    expect(
      listBody('src/app/ModifierStackControls.tsx', /const ADDABLE\b[^=]*=\s*\[([\s\S]*?)\]\s*;/),
    ).toBe(
      "{ type: 'ArrayModifier', label: 'Array' }, { type: 'MirrorModifier', label: 'Mirror' },",
    );
    expect(
      listBody(
        'src/agent/mutators/builders/addModifier.ts',
        /const ModifierType = z\.enum\(\[([\s\S]*?)\]\)/,
      ),
    ).toBe("'ArrayModifier', 'MirrorModifier'");

    expect(listBody('src/app/operatorChain.ts', /MATERIAL_LANE_TYPES[^=]*=\s*\[([\s\S]*?)\]/)).toBe(
      "'SetMaterialOp', 'MaterialOverrideOp'",
    );
    expect(
      listBody('src/app/MaterialStackControls.tsx', /const ADDABLE\b[^=]*=\s*\[([\s\S]*?)\]\s*;/),
    ).toBe(
      "{ type: 'SetMaterialOp', label: 'Set Material' }, { type: 'MaterialOverrideOp', label: 'Override' },",
    );

    expect(
      listBody('src/app/operatorChain.ts', /EFFECT_NODE_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/),
    ).toBe("'ColorCorrect'");

    // The seventh is `ALL` in `registerAll.ts` — the import door, not a membership claim,
    // and the one list this phase keeps for a structural reason rather than deriving.
    const registerAll = FILES.find(([p]) => p === 'src/nodes/registerAll.ts')?.[1];
    expect(registerAll).toBeDefined();
    expect(registerAll).toContain('const ALL');
  });
});
