// #645 — WHERE THE SLOT TABLE IS DERIVED, WHO CONSULTS THE OBJECT, AND THE FUSE CHAIN THAT
// HAS TRACKED THIS ONE DECISION ACROSS THREE COMMITS.
//
// ── THE FINDING THIS GATE EXISTS TO STOP REPEATING ────────────────────────────────────
//
// Four places in the tree declare that the material slot TABLE is object-level, one of them
// promising it is "what lets two objects share one mesh and still look different":
//
//   src/nodes/types.ts:540           (#638's banner — the table is object-level substance)
//   src/nodes/types.ts:634           (why `material` was deleted as a peer of the geometry)
//   src/nodes/types.ts:1212          (`MeshDataValue.materialSlots`' own doc comment)
//   src/app/materialAssignment.ts:3  (the module header)
//
// Until #645 the tree satisfied that claim in NONE of them. `materialSlots` sat on three
// DATA-side value types; `ObjectValue` had no material field at all; and the single
// derivation read `data`, never an Object. What shipped was the reference's `link == DATA`
// case, implemented correctly, and nothing else — so the promised consequence was
// measurably false, and nothing failed, because the declarations agreed with the code's
// VOCABULARY and disagreed only with its CONSEQUENCE.
//
// That is worse than an open gap: the four declarations carry measurements and references
// and so OUTRANK the code they describe. A reader checking the vocabulary finds agreement
// everywhere and never checks the consequence. This gate checks the consequence.
//
// ── THE FUSE CHAIN, WHICH IS THE POINT OF THIS FILE ───────────────────────────────────
//
// One decision, tracked across three commits, each link failing in the commit that makes
// the next question answerable:
//
//   P0  `ObjectValue` has no material field       → blew when P1 added one
//   P1  nothing production reads `slotOverrides`  → blew when P2 added the reader
//   P2  the behavioural row (D2 below)            → the terminal link: two Objects over one
//                                                   data node resolve DIFFERENT tables, the
//                                                   data is untouched by identity, and both
//                                                   still share one `BufferGeometry`
//
// Each link was REPLACED, never deleted. A blown fuse removed rather than succeeded leaves
// the decision taken and unenforced — the covered-but-unhonoured shape again — and the
// moment it blows is the moment of maximum knowledge about what it was protecting.
//
// REF: ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md §6 (the re-point probe this
//      road beats on instance sharing) and §7.2 (the instrument trap: a data-side read
//      agrees with the correct read for every non-overridden object, and disagrees only on
//      the case under test — it bit the reference session itself);
//      src/app/materialAssignment.ts (`objectSlotsOf`, the one derivation; `dataSlotsOnly`,
//      the named escape hatch); src/nodes/materialDivergence.test.ts (the operator road,
//      whose shared `BufferGeometry` this must not cost); issues #645, #646, #647, #638.

import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { objectSlotsOf } from '../app/materialAssignment';
import { getForRead } from '../app/geometryRegistry';
import { registerAllNodes } from './registerAll';
import { hydrateInlineMaterial } from './materialSchema';
import { boxDescriptor, boxGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import type { MeshDataValue, ObjectValue } from './types';

const TYPES = 'src/nodes/types.ts';
const ASSIGNMENT = 'src/app/materialAssignment.ts';
const OBJECT_NODE = 'src/nodes/ObjectNode.ts';
/** #645 P6 — the authoring road. Reads WHICH slots are authored; never resolves what draws. */
const AUTHORING = 'src/app/objectSlotAuthoring.ts';
/** The panel that draws the list. Reads the authored colour for its field; same rule. */
const PANEL = 'src/app/NPanel.tsx';

/**
 * The production roads that resolve a slot table. Tests are excluded on purpose: a test
 * calling a derivation is not a migration site, and counting them would make the census
 * move every time a row is added.
 */
const PRODUCTION_ROADS = ['src/viewport/SceneFromDAG.tsx', 'src/app/resolveEvaluatedMesh.ts'];

const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/;

/** Lines that are prose, not code. A comment naming the function is not a call to it. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

type Invocation = { readonly file: string; readonly line: number; readonly fn: string };

/**
 * Every production invocation of `name`, with the function it sits in. DERIVED from the
 * source text, never listed — a new call site appears here on its own, which is the only
 * way this census can red for the right reason.
 */
function invocationsOf(name: string, files: readonly string[]): readonly Invocation[] {
  const found: Invocation[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8').split('\n');
    const decls: { name: string; at: number }[] = [];
    src.forEach((l, i) => {
      const m = TOP_LEVEL_DECL.exec(l);
      if (m) decls.push({ name: m[1], at: i + 1 });
    });
    src.forEach((line, idx) => {
      const ln = idx + 1;
      if (isComment(line)) return;
      if (!new RegExp(`\\b${name}\\(`).test(line)) return;
      if (/^\s*import\s|from '/.test(line.trim())) return;
      if (new RegExp(`export function ${name}\\b`).test(line)) return;
      let decl = decls[0];
      decls.forEach((d) => {
        if (d.at <= ln) decl = d;
      });
      found.push({ file, line: ln, fn: decl.name });
    });
  }
  return found;
}

/**
 * Every production `.ts`/`.tsx` under `src/` — the universe the censuses search, named here
 * so a zero one returns can be told apart from a walk that never ran.
 */
function productionSources(dir = 'src'): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...productionSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The declared field names of an interface, read off the type declaration itself. */
function fieldsOf(file: string, interfaceName: string): readonly string[] {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`${interfaceName} not found in ${file}`);
  const end = src.indexOf('\n}', start);
  return [...src.slice(start, end).matchAll(/^\s*readonly\s+([A-Za-z0-9_]+)\??:/gm)].map(
    (m) => m[1],
  );
}

beforeEach(() => {
  registerAllNodes();
});

describe('#645 — the slot table is derived once, through the Object', () => {
  // ── A. HOW MANY DERIVATIONS ARE THERE? ──────────────────────────────────────────────
  //
  // The whole design rests on this being one. Keyed on the DEFINITION, not on callers: a
  // second `?? [x.material]` spelled anywhere else is a rival derivation that agrees today
  // and diverges the moment an override exists.
  it('A. ONE derivation reads the Object, ONE named hatch reads only the data', () => {
    const src = readFileSync(ASSIGNMENT, 'utf8');
    expect([...src.matchAll(/export function objectSlotsOf\b/g)]).toHaveLength(1);
    expect([...src.matchAll(/export function dataSlotsOnly\b/g)]).toHaveLength(1);

    // The bodies, pinned as literals. The data half is the whole `materialSlots ?? [material]`
    // rule; the object half is a per-index override over it, which IS the precedence rule.
    expect(src).toContain('return data.materialSlots ?? [data.material];');
    expect(src).toContain('return base.map((slot, i) => overrides[String(i)] ?? slot);');

    // 🔴 NO CODE STILL CALLS THE OLD NAME, and that is not tidiness — it is the migration
    // lever. A widened signature that kept `materialSlotsOf` working would have left the
    // data-side read in place at every site that never thought about it, and nothing would
    // have failed until the exact case under test. Removing the name is what made every
    // call site stop compiling and say which of the two answers it wanted.
    //
    // ⚠️ CODE ONLY, DELIBERATELY. This file's neighbours keep history in prose on purpose
    // — `materialAssignment.ts` records what the function used to be called, and the trap
    // note in `types.ts` names the read that would be wrong. Both are the reason the
    // rename is legible later. The first spelling of this row matched the whole file and
    // went red on three stale INSTRUCTION comments telling readers to call a function that
    // no longer exists; those were real bugs and are fixed, but the fix for them is
    // editing the prose, not forbidding the word.
    const survivors = productionSources().filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((l) => !isComment(l) && /materialSlotsOf/.test(l)),
    );
    expect(survivors).toEqual([]);

    // A rival spelling of the fallback, anywhere on the production roads.
    const rivals = PRODUCTION_ROADS.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !isComment(l) && /materialSlots\s*\?\?/.test(l)),
    );
    expect(rivals).toEqual([]);
  });

  // ── B. THE CENSUS — WHO CONSULTS THE OBJECT, AND WHO IS ENTITLED NOT TO ─────────────
  //
  // Counts are LITERALS. A bound like "at most one hatch use" would absorb exactly the
  // event it exists to detect.
  it('B. every production road resolves through the Object, with one named exception', () => {
    const road = invocationsOf('objectSlotsOf', PRODUCTION_ROADS);
    expect(road).toHaveLength(5);
    expect(road.map((c) => c.fn).sort()).toEqual([
      'ObjectMeshR',
      'ObjectR',
      'ObjectR',
      'evaluatedMeshFromMeshData',
      'resolveEvaluatedMesh',
    ]);

    // 🔴 THE ESCAPE HATCH, CENSUSED EXACTLY. Its danger is that it is not WRONG anywhere:
    // it agrees with the correct answer for every object that overrides nothing, which is
    // almost all of them, and disagrees only on the case under test. A count is the only
    // thing that catches a road quietly rejoining it.
    //
    // ONE use on the production roads, and it is `MeshChild`'s fused `ModifiedMesh` arm —
    // a value that arrives through the DAG flow with no Object in reach and no Object
    // whose overrides could apply. Case C measures that the arm is unreachable besides.
    const hatch = invocationsOf('dataSlotsOnly', PRODUCTION_ROADS);
    expect(hatch).toHaveLength(1);
    expect(hatch[0].fn).toBe('MeshChild');

    // And inside the derivation module it is used exactly once — by `objectSlotsOf`, to
    // build the base it then overrides. That is composition, not an escape.
    const internal = invocationsOf('dataSlotsOnly', [ASSIGNMENT]);
    expect(internal).toHaveLength(1);
    expect(internal[0].fn).toBe('objectSlotsOf');
  });

  it('C. the fused ModifiedMesh arm has no producer on the DAG value flow', () => {
    // Why this lives in this gate: case B's verdict leans on it. If a node ever evaluates
    // to a `ModifiedMeshValue` again, the escape hatch stops being harmless and becomes a
    // live road reading the data side with an Object it never asked for.
    //
    // ⚠️ THE UNIVERSE IS NAMED, and the denominator is asserted, because a census scoped to
    // the wrong set returns an honest zero for a question nobody asked. Here it is every
    // production `.ts`/`.tsx` under `src/` — not the handful of files this gate imports.
    //
    // And it keys on the object-literal WRITE (`kind: 'ModifiedMesh',`), never on the
    // substring: `types.ts` DECLARES the kind on the interface, and a matcher that counts a
    // declaration as a producer reports the union's own definition as a value flow.
    const files = productionSources();
    expect(files.length).toBeGreaterThan(200); // the denominator is real, not an empty walk

    const producers = files.filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((l) => /^\s*kind: 'ModifiedMesh',/.test(l)),
    );
    expect(producers).toEqual(['src/nodes/modifiedRecompose.ts']);

    // The declaration is still exactly where it should be — asserted so that "no producers"
    // can never be satisfied by the kind having quietly ceased to exist.
    expect(readFileSync(TYPES, 'utf8')).toContain("readonly kind: 'ModifiedMesh';");
  });

  // ── D1. THE P1 LINK, BLOWN AND SUCCEEDED ────────────────────────────────────────────
  //
  // 🔴 THE ROW HERE ASSERTED THAT NOTHING PRODUCTION READ `slotOverrides`, and it reds now,
  // because P2 added the reader. What it was protecting: the commit that added one had to
  // answer the two questions P1 deliberately deferred — whether the override may enter the
  // GEOMETRY KEY, and which call sites still read the data side. D2 below answers both by
  // assertion rather than by statement.
  //
  // This row is not gone; it inverted. It now pins that the reader is exactly the
  // derivation and nowhere else — the same claim from the other side: the field has ONE
  // consumer, so it cannot be read two ways.
  it('D1. `slotOverrides` is read by the derivation, and by nothing else', () => {
    expect(fieldsOf(TYPES, 'ObjectValue')).toEqual([
      'kind',
      'position',
      'rotation',
      'scale',
      'data',
      'slotOverrides',
    ]);

    // Schema'd on the node, so an authored write is not silently dropped, and `.optional()`
    // rather than `.default({})` — the latter writes an empty record into every saved
    // Object, a format change wearing a default's clothes.
    const node = readFileSync(OBJECT_NODE, 'utf8');
    expect(node).toMatch(/slotOverrides: z\.record\([^\n]*\)\.optional\(\)/);

    // ⚠️ KEYED ON A READ, NOT ON THE NAME, and that was forced by a false positive rather
    // than foreseen. The first spelling matched the bare identifier and went red on
    // `paramHomeGolden.ts` — a frozen DATA TABLE containing the string
    // `slotOverrides=(unrouted)` inside a string literal, which reads nothing at all. A
    // census over a name cannot tell a reader from a mention of one.
    const READ = /\.slotOverrides\b|\{\s*slotOverrides\b/;
    const readers = productionSources()
      .filter((f) => f !== TYPES && f !== OBJECT_NODE)
      .filter((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .some((l) => !isComment(l) && READ.test(l)),
      );

    // 🔴 THE FUSE MOVED AT P6, AND MOVING IT IS THE POINT — it is replaced, never deleted.
    //
    // Through P5 this read `toEqual([ASSIGNMENT])`: the field had exactly ONE consumer, so
    // it could not be read two ways. P6 adds an AUTHORING surface, and a surface that lets a
    // director create an override has to be able to see which ones exist. So the literal
    // grows — and if that were all it did, the fuse would be gone, because "one reader" was
    // the whole of its content.
    //
    // What replaces it is the distinction the new readers make necessary. There are two
    // questions one can ask this field, and only one of them may have more than one asker:
    //
    //   • WHAT DRAWS — resolve the override against the data's table, apply precedence.
    //     Exactly ONE site, still: `objectSlotsOf` in `materialAssignment.ts`.
    //   • WHAT IS AUTHORED — which indices does this Object name? A question about the
    //     PARAM, answered without resolving anything, and the authoring road needs it.
    //
    // The danger a second reader introduces is not that it reads. It is that it RE-DERIVES —
    // that a panel composes its own answer to the first question and quietly disagrees with
    // the renderer. That is checked below, on the composition itself, rather than being
    // prevented by a count that this phase has to raise anyway.
    expect(readers).toEqual([ASSIGNMENT, AUTHORING, PANEL].sort());

    // The precedence rule — an Object override wins for the index it names — appears ONCE,
    // at the derivation. A road that spelled it again would agree on every object that
    // overrides nothing and disagree exactly where it matters (the reference's §7.2 trap),
    // which is precisely what a reader count cannot see.
    const COMPOSES = /overrides\[[^\]]*\]\s*\?\?/;
    const composers = productionSources().filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((l) => !isComment(l) && COMPOSES.test(l)),
    );
    expect(composers).toEqual([ASSIGNMENT]);
  });

  // ── E. THE ROW THE BROWSER HAD TO TEACH US ──────────────────────────────────────────
  //
  // 🔴 THIS EXISTS BECAUSE EVERY OTHER ROW IN THIS FILE WAS GREEN WHILE THE OVERRIDE DREW
  // NOTHING. P2 migrated the ASSIGNMENT in `ObjectMeshR` to resolve through the Object, and
  // left the single hydrated material beside it reading `data.material` directly. So the
  // slot table honoured the override and the pixel did not — two answers to one question,
  // with the census green because `objectSlotsOf` WAS being called, just not for the thing
  // that draws.
  //
  // The e2e spec caught it. That is a 34-minute gate for a one-line regression, so the
  // cheap detector lives here: on the single-slot road the hydration input and the
  // assignment input must be the SAME resolved table, and neither may be re-derived.
  //
  // ⚠️ WHAT THIS CANNOT SEE, stated rather than discovered later: it reads source text, so
  // a third spelling that reaches the data value by another route is invisible to it. The
  // behavioural backstop is `tests/e2e/p645-object-slot-override-draws.spec.ts`, whose grey
  // floor is the clause that actually refuses a wrong answer.
  it('E. the single-slot road hydrates from the RESOLVED table, not from `data.material`', () => {
    const src = readFileSync('src/viewport/SceneFromDAG.tsx', 'utf8');
    const body = src.slice(
      src.indexOf('function ObjectMeshR('),
      src.indexOf('function MultiMaterialMeshR('),
    );
    expect(body.length).toBeGreaterThan(200); // the slice is real, not an empty window

    const code = body.split('\n').filter((l) => !isComment(l));

    // The material that DRAWS comes off the resolved table.
    expect(code.some((l) => /const slots = data \? objectSlotsOf\(value, data\)/.test(l))).toBe(
      true,
    );
    expect(code.some((l) => /const mat = \(slots\[0\]/.test(l))).toBe(true);

    // And nothing on this road takes the material off the data value again. `data.material`
    // is exactly the read the bug was.
    expect(
      code.filter((l) => /data\??\.material\b/.test(l) && !/=== data\?\.material/.test(l)),
    ).toEqual([]);

    // The assignment reuses that same `slots` rather than resolving a second time — one
    // question, one answer.
    expect(code.some((l) => /materialAssignmentOf\(data\.attributeKey, slots\)/.test(l))).toBe(
      true,
    );
  });

  // ── D2. THE TERMINAL LINK — THE CONSEQUENCE ITSELF ──────────────────────────────────
  //
  // The claim four places in the tree have been making since #638, asserted at last. This
  // is what the whole chain was for, and it is deliberately a RELATION between two
  // resolutions rather than "the override applied": "slot 0 is green" is equally satisfied
  // by an implementation that overrides EVERY object, which is the defect, not the fix.
  it('D2. two Objects over ONE data node resolve DIFFERENT tables, and still share one geometry', () => {
    const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
    const sourceMaterial = hydrateInlineMaterial(null, '#ff0000');
    const shared: MeshDataValue = {
      kind: 'MeshData',
      geometry: boxGeometryRef([1, 1, 1], key),
      material: sourceMaterial,
      materialKey: null,
      attributeKey: key,
    };
    const plain: ObjectValue = {
      kind: 'Object',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      data: shared,
    };
    const overridden: ObjectValue = {
      ...plain,
      position: [2, 0, 0],
      slotOverrides: { '0': hydrateInlineMaterial(null, '#00ff00') },
    };

    const plainSlots = objectSlotsOf(plain, shared);
    const overriddenSlots = objectSlotsOf(overridden, shared);

    // They differ, and only where the override landed.
    expect(plainSlots[0]).not.toBe(overriddenSlots[0]);
    expect(overriddenSlots[0]).toBe(overridden.slotOverrides?.['0']);

    // 🔴 AND THE SHARED DATA IS UNTOUCHED — by IDENTITY, not equality. This is the
    // reference's "shared material datablock: never written" row. A composed copy that
    // merely looked the same would mean the override had reached the source.
    expect(plainSlots[0]).toBe(sourceMaterial);
    expect(shared.material).toBe(sourceMaterial);
    expect(shared.materialSlots).toBeUndefined();

    // 🔑 THE ROW THE REFERENCE CANNOT MATCH, and the second question P1 deferred. Blender's
    // re-point costs the diverging object its instance sharing; ours does not, because the
    // slot table is not part of the geometry key — only the attribute INDEX is. Asserted
    // through the registry rather than argued from the key's definition.
    expect(getForRead(shared.geometry)).toBe(getForRead(shared.geometry));
    expect(plain.data).toBe(overridden.data);
  });

  it('D2b. an override names ONE index — the others still come from the data', () => {
    // The sparseness, at the RESOLUTION rather than at the param. An implementation that
    // replaced the whole table whenever any override existed would pass D2 and fail here.
    const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
    const a = hydrateInlineMaterial(null, '#ff0000');
    const b = hydrateInlineMaterial(null, '#0000ff');
    const data = {
      kind: 'MeshData' as const,
      geometry: boxGeometryRef([1, 1, 1], key),
      material: a,
      materialSlots: [a, b],
      materialKey: null,
      attributeKey: key,
    };
    const green = hydrateInlineMaterial(null, '#00ff00');
    const slots = objectSlotsOf({ slotOverrides: { '1': green } }, data);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toBe(a); // untouched, from the data
    expect(slots[1]).toBe(green); // the one the Object named

    // An index the data has no slot for does not extend the table. The reference's model —
    // an object's slot count IS its data's — and an obligation on the authoring surface,
    // which must not offer an index the data cannot carry.
    const outOfRange = objectSlotsOf({ slotOverrides: { '7': green } }, data);
    expect(outOfRange).toHaveLength(2);
    expect(outOfRange[0]).toBe(a);
    expect(outOfRange[1]).toBe(b);
  });
});
