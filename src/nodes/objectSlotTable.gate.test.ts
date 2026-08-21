// #645 P0 — WHERE THE SLOT TABLE IS DERIVED, WHO COULD OVERRIDE IT, AND THE FUSE THAT REDS
// WHEN ONE FINALLY CAN.
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
// The tree satisfies that claim in NONE of them. `materialSlots` sits on three DATA-side
// value types (`ModifiedMeshValue`, `MeshDataValue`, `ModifiedDataValue`); `ObjectValue`
// has no material field at all; and the single derivation reads `data`, never an Object.
// What ships is the reference's `link == DATA` case, implemented correctly. `link == OBJECT`
// does not exist, so the promised consequence is measurably false — two Objects reading one
// data node receive the identical table, and nothing in the type system can make them differ.
//
// That is worse than an open gap, because the four declarations carry measurements and
// references and so OUTRANK the code they describe: a reader checking the vocabulary finds
// agreement everywhere and never checks the consequence. This gate makes the consequence the
// thing that is checked.
//
// ── WHAT P0 WAS FOR, AND WHAT IT MEASURED ─────────────────────────────────────────────
//
// Before building the object-level half, one question decided whether the SHAPE was still
// right: the design rests on there being exactly ONE derivation site, so that moving it is a
// single edit. If a large share of the call sites had no Object in scope, that property was
// already gone and the object-level table would need a different shape entirely.
//
// Measured here rather than assumed. Of the production invocations, every one either has the
// Object in its signature, reaches it inside the enclosing branch, or is a site whose own
// callers have it. There is no site where the Object is genuinely unavailable, so the single
// derivation survives the move. Case B pins that classification so it cannot drift silently.
//
// ⚠️ WHAT THIS GATE DOES NOT ARGUE. It does not argue that the object-level table SHOULD be
// built — that is a live decision on #645, and the affordance question it turns on (is
// "no operator per branch" worth a mechanism, when the operator route already ships and
// shares geometry better?) is not one a test can answer. It only makes the current state
// impossible to misread in either direction.
//
// REF: ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md §6 (the re-point probe this road
//      already beats on instance sharing) and §7.2 (the instrument trap: a data-side read
//      agrees with the correct read for every non-overridden object, and disagrees only on
//      the case under test — it bit the reference session itself);
//      src/app/materialAssignment.ts (`materialSlotsOf`, the one derivation);
//      src/nodes/materialDivergence.test.ts (the shipped operator road, and the shared
//      `BufferGeometry` this must not cost); issues #645, #646, #647, #638.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { materialSlotsOf } from '../app/materialAssignment';
import { hydrateInlineMaterial } from './materialSchema';
import { boxDescriptor, boxGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import type { MeshDataValue, ObjectValue } from './types';

const TYPES = 'src/nodes/types.ts';
const ASSIGNMENT = 'src/app/materialAssignment.ts';

/**
 * The production roads that resolve a slot table. Tests are excluded on purpose: a test
 * calling the data-side derivation is not a migration site, and counting them would make
 * the census move every time a row is added.
 */
const PRODUCTION_ROADS = ['src/viewport/SceneFromDAG.tsx', 'src/app/resolveEvaluatedMesh.ts'];

const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/;

/** Lines that are prose, not code. A comment naming the function is not a call to it. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

type Invocation = {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  /** 'signature' — the Object is a parameter. 'body' — reached inside the enclosing branch.
   *  'none' — the enclosing function cannot see an Object at all. */
  readonly reach: 'signature' | 'body' | 'none';
};

/**
 * Every production invocation of `materialSlotsOf`, classified by how far the Object is from
 * the call. DERIVED from the source text, never listed — a new call site appears here on its
 * own, which is the only way this census can red for the right reason.
 */
function censusInvocations(): readonly Invocation[] {
  const found: Invocation[] = [];
  for (const file of PRODUCTION_ROADS) {
    const src = readFileSync(file, 'utf8').split('\n');
    const decls: { name: string; at: number }[] = [];
    src.forEach((l, i) => {
      const m = TOP_LEVEL_DECL.exec(l);
      if (m) decls.push({ name: m[1], at: i + 1 });
    });
    src.forEach((line, idx) => {
      const ln = idx + 1;
      if (isComment(line)) return;
      if (!/materialSlotsOf\(/.test(line)) return;
      // The import statement names the function without calling it.
      if (/^\s*import\s|from '/.test(line.trim())) return;
      let decl = decls[0];
      let next = src.length + 1;
      decls.forEach((d, i) => {
        if (d.at <= ln) {
          decl = d;
          next = decls[i + 1] ? decls[i + 1].at : src.length + 1;
        }
      });
      const signature = src.slice(decl.at - 1, decl.at + 14).join('\n');
      const body = src.slice(decl.at - 1, next - 1).join('\n');
      const reach = /ObjectValue/.test(signature)
        ? 'signature'
        : /ObjectValue|node\.type === 'Object'/.test(body)
          ? 'body'
          : 'none';
      found.push({ file, line: ln, fn: decl.name, reach });
    });
  }
  return found;
}

/**
 * Every production `.ts`/`.tsx` under `src/` — the universe case C searches, named here so a
 * zero it returns can be told apart from a walk that never ran. Test files are excluded
 * because a fixture minting a value kind is not a producer on the value flow.
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
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*readonly\s+([A-Za-z0-9_]+)\??:/gm)].map((m) => m[1]);
}

describe('#645 P0 — the slot table is derived in one place, and no Object can reach it', () => {
  // ── A. HOW MANY DERIVATIONS ARE THERE? ──────────────────────────────────────────────
  //
  // The whole design of the move rests on this being one. Keyed on the DEFINITION, not on
  // callers: a second `?? [x.material]` spelled anywhere else is a rival derivation that
  // agrees today and diverges the moment an override exists.
  it('A. there is exactly ONE derivation of a slot table, and it reads `data`', () => {
    const src = readFileSync(ASSIGNMENT, 'utf8');
    const definitions = [...src.matchAll(/export function materialSlotsOf\b/g)];
    expect(definitions).toHaveLength(1);

    // The body, pinned as a literal. `materialSlots ?? [material]` is the entire rule, and
    // the argument is a structural `data` shape — an `ObjectValue` cannot be passed to it
    // at all, because it declares no `material` field for the constraint to match.
    expect(src).toContain('return data.materialSlots ?? [data.material];');

    // A rival spelling of the same fallback, anywhere on the production roads.
    const rivals = PRODUCTION_ROADS.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !isComment(l))
        .filter((l) => /materialSlots\s*\?\?/.test(l)),
    );
    expect(rivals).toEqual([]);
  });

  // ── B. THE CENSUS — CAN EACH CALL SITE SEE AN OBJECT? ───────────────────────────────
  //
  // This is the row P0 was written to produce. The counts are LITERALS: a bound like
  // "at most 3 with no reach" would absorb exactly the event it is meant to detect.
  it('B. every production call site can reach an Object, so the single derivation can move', () => {
    const census = censusInvocations();
    expect(census).toHaveLength(7);

    const byReach = {
      signature: census.filter((c) => c.reach === 'signature'),
      body: census.filter((c) => c.reach === 'body'),
      none: census.filter((c) => c.reach === 'none'),
    };
    expect(byReach.signature).toHaveLength(3);
    expect(byReach.body).toHaveLength(1);
    expect(byReach.none).toHaveLength(3);

    // Named, so a red says WHICH road moved rather than only that a number did.
    expect(byReach.signature.map((c) => c.fn).sort()).toEqual([
      'ObjectMeshR',
      'ObjectR',
      'ObjectR',
    ]);
    expect(byReach.body.map((c) => c.fn)).toEqual(['resolveEvaluatedMesh']);
    expect(byReach.none.map((c) => c.fn).sort()).toEqual([
      'MeshChild',
      'evaluatedMeshFromMeshData',
      'needsMaterialSlots',
    ]);

    // ⚠️ THE THREE WITH NO REACH ARE NOT THREE BLOCKED SITES, and the difference is what
    // decided P0's gate. Each is addressable, and each was measured rather than argued
    // from the comment sitting above it:
    //
    //   MeshChild                 — the fused `ModifiedMesh` arm. Case C below measures
    //                               that its only production producer is the recompose
    //                               helper, whose output `ObjectR` renders directly. No
    //                               value reaches this arm through the DAG value flow.
    //   needsMaterialSlots        — a structural helper, deliberately Object-blind. Of its
    //                               three callers two are inside `ObjectR`; the third is
    //                               the unreachable arm above.
    //   evaluatedMeshFromMeshData — its sole production caller sits inside
    //                               `node.type === 'Object'`, so the Object IS present at
    //                               the call. Only the signature omits it, which is
    //                               precisely the lever that turns a silent
    //                               data-side read into a compile error.
    //
    // ⇒ zero sites where an Object is genuinely unavailable.
  });

  it('C. the fused ModifiedMesh arm has no producer on the DAG value flow', () => {
    // Why this lives in this gate: case B's verdict leans on it. If a node ever evaluates
    // to a `ModifiedMeshValue` again, `MeshChild`'s call stops being unreachable and
    // becomes a real migration site with no Object in sight — which would change B's
    // answer without touching B's numbers.
    //
    // ⚠️ THE UNIVERSE IS NAMED, and the denominator is asserted, because a census scoped to
    // the wrong set returns an honest zero for a question nobody asked. Here it is every
    // production `.ts`/`.tsx` under `src/` — not the handful of files this gate happens to
    // import, which is the scope that would have made the answer meaningless.
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

  // ── D. THE FUSE ─────────────────────────────────────────────────────────────────────
  //
  // THE QUESTION THIS ROW IS PROTECTING: when an Object gains a place to say "my slot n
  // points elsewhere", three decisions become owed at once and none of them can be
  // inherited — (1) what PRECEDENCE an Object override has over whatever the chain
  // produced for that slot index; (2) whether the override may enter the geometry key,
  // which it must not, because keeping it out is the one row where this road beats the
  // reference on instance sharing; (3) which of the seven call sites in case B still read
  // the data side, given that every one of them AGREES with the correct answer for every
  // non-overridden object and lies only on the case under test.
  //
  // This row reds in the commit that adds the field, which is the commit that must answer
  // all three. It is not a TODO: a TODO is read when someone opens the file, a fuse is
  // read by the runner and cannot be walked past.
  //
  // ITS SUCCESSOR, so it is replaced rather than deleted: a row asserting BEHAVIOURALLY
  // that two Objects over one shared data node resolve DIFFERENT tables while the data
  // value is untouched by identity, and that both still resolve to one `BufferGeometry`.
  // Deleting this row instead of succeeding it would leave the decision taken and
  // unenforced — the covered-but-unhonoured shape that made this gate necessary.
  it('D. FUSE — `ObjectValue` declares no material field, so link==OBJECT is unconstructible', () => {
    expect(fieldsOf(TYPES, 'ObjectValue')).toEqual([
      'kind',
      'position',
      'rotation',
      'scale',
      'data',
    ]);
  });

  it('D2. and behaviourally: two Objects over one data node resolve the IDENTICAL table', () => {
    const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
    const shared: MeshDataValue = {
      kind: 'MeshData',
      geometry: boxGeometryRef([1, 1, 1], key),
      material: hydrateInlineMaterial(null, '#ff0000'),
      materialKey: null,
      attributeKey: key,
    };
    const left: ObjectValue = {
      kind: 'Object',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      data: shared,
    };
    const right: ObjectValue = { ...left, position: [2, 0, 0] };

    // The resolution the renderer takes at `ObjectR`. It reads `data` — the Object is in
    // scope at that call and contributes nothing, which is the whole finding.
    const leftSlots = materialSlotsOf(left.data as MeshDataValue);
    const rightSlots = materialSlotsOf(right.data as MeshDataValue);

    expect(leftSlots).toEqual(rightSlots);
    // Stronger than equal: the same array instance, because the two Objects are not merely
    // configured alike — there is no per-Object step between them and one shared table.
    expect(leftSlots[0]).toBe(rightSlots[0]);
    expect(leftSlots).toHaveLength(1);
  });
});
