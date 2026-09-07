// #646 — the imported-material-array road, and why the guard over it is DEAD TODAY.
//
// ── WHAT THIS GATE HOLDS ───────────────────────────────────────────────────────────────
//
// `SceneFromDAG.tsx` refuses to overlay a DAG-authored material onto an imported mesh whose
// `material` is an ARRAY (`if (childId && !Array.isArray(src))`). #646 reads that guard as a
// live limitation: "a glTF child with a material array cannot receive a DAG material at all".
//
// Measured, that premise is false on every import road this repo has — for two DIFFERENT
// reasons, which is exactly why one row could not hold it:
//
//   glTF — three never BUILDS an array material. A multi-primitive mesh becomes a `Group` of
//          single-material `Mesh`es, so each primitive arrives as its own addressable slot.
//   FBX  — three's FBX loader DOES build one (`FBXLoader.js`, `if (materials.length > 1)`),
//          but Basher imports no FBX geometry and no FBX materials: only a skeleton and clips.
//
// So the array state is unreachable, and the capability #646 asks for was delivered instead by
// the Group road plus per-slot IR addressing (row C).
//
// ── WHY A GATE AND NOT A COMMENT ON THE ISSUE ─────────────────────────────────────────────
//
// Because the argument is entirely made of facts that live in OTHER people's code — a vendored
// loader and an import module that is explicitly staged for a later wave. Prose asserting them
// starts rotting the moment it is written, and this cluster has already been bitten by exactly
// that: #647's "what the fix requires" describes a widening that had already shipped.
//
// Row B is the one that earns its keep longest. It is a TRIPWIRE, not a tautology: the day
// Basher imports FBX meshes, an array material becomes constructible, the guard stops being
// dead, and this row goes red pointing straight at it. That is the whole reason the guard must
// NOT be deleted on the strength of "it is unreachable" — it is unreachable *for now*.
//
// ── THE FAILURE MODE THIS GATE IS BUILT AGAINST ───────────────────────────────────────────
//
// A census that examined nothing and printed success. Every row therefore asserts a
// DENOMINATOR before it asserts a count, and every "zero" is paired with a positive assertion
// that the road it is counting over still exists — a zero over a file that moved is not
// evidence of safety, it is evidence of a broken probe. Row D is the control on the parsers.
//
// REF: src/viewport/SceneFromDAG.tsx (the guard + the per-slot road it was replaced by);
//      src/core/import/fbx.ts (what the FBX road actually carries);
//      tests/e2e/p06-2-per-submesh.spec.ts (the live proof of per-slot addressing over a real
//      two-primitive fixture); issues #646, #638, #691.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../test-utils/sourceScan';

const REPO = join(__dirname, '..', '..');
const THREE_LOADERS = join(REPO, 'node_modules', 'three', 'examples', 'jsm', 'loaders');

const read = (...p: string[]): string => readFileSync(join(...p), 'utf8');
const lines = (s: string): number => s.split('\n').length;

/**
 * The brace-matched body of `export interface <name> { … }`, comment-stripped.
 *
 * Local rather than imported: the sibling copy lives in `materialKeyReach.gate.test.ts`, and
 * importing a spec file RE-REGISTERS its `describe`/`it` blocks into this suite — the unit
 * count defect `tools/gates/sourceFiles.ts` records in its own header. A twenty-line helper is
 * the cheaper of the two duplications.
 */
function interfaceBody(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const head = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(stripped);
  if (!head) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < stripped.length && depth > 0; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
  }
  return depth === 0 ? stripped.slice(start, i - 1) : null;
}

/** The field names an interface body DECLARES, in source order. */
function declaredFields(body: string): string[] {
  return [...body.matchAll(/(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/g)].map(
    (m) => m[1],
  );
}

describe('#646 — an imported mesh cannot carry a material ARRAY, on any road that exists', () => {
  it('A. three’s glTF loader builds no array material — multi-primitive becomes a Group', () => {
    const src = read(THREE_LOADERS, 'GLTFLoader.js');
    // DENOMINATOR FIRST. A zero from a file that failed to load is not a measurement.
    expect(lines(src)).toBeGreaterThan(4000);
    const stripped = stripComments(src);

    // The count that makes #646's premise false for glTF.
    expect([...stripped.matchAll(/\.material\s*=\s*\[/g)]).toHaveLength(0);

    // …and the road that stands in its place, asserted POSITIVELY. Without this, the zero
    // above would still pass if three deleted the mesh-building path entirely, and the gate
    // would report safety over a loader that no longer does the thing at all.
    expect(/if\s*\(\s*meshes\.length\s*===\s*1\s*\)/.test(stripped)).toBe(true);
    expect(/const\s+group\s*=\s*new\s+Group\(\)/.test(stripped)).toBe(true);
  });

  it('B. TRIPWIRE — Basher’s FBX import carries a skeleton and clips, no geometry, no material', () => {
    // three's FBX loader DOES build the array (`if ( materials.length > 1 ) material = materials`),
    // so this row is what keeps the array unreachable — not the loader, but OUR narrow use of it.
    const loader = read(THREE_LOADERS, 'FBXLoader.js');
    expect(lines(loader)).toBeGreaterThan(3000);
    expect(/materials\.length\s*>\s*1/.test(stripComments(loader))).toBe(true);

    const src = read(REPO, 'src', 'core', 'import', 'fbx.ts');
    expect(lines(src)).toBeGreaterThan(50);

    const body = interfaceBody(src, 'FbxImportResult');
    expect(body).not.toBeNull();
    // Exactly these two. A third field is the signal: geometry arriving is what makes an
    // array material constructible and the SceneFromDAG guard live again.
    expect(declaredFields(body as string)).toEqual(['skeletonParams', 'clipParams']);

    const stripped = stripComments(src);
    expect(/new\s+Mesh\s*\(/.test(stripped)).toBe(false);
    expect(/\.material\s*=/.test(stripped)).toBe(false);
  });

  it('C. the per-slot addressing that replaced the array road is present at all three sites', () => {
    const src = read(REPO, 'src', 'viewport', 'SceneFromDAG.tsx');
    expect(lines(src)).toBeGreaterThan(3000);
    const stripped = stripComments(src);

    // The three sites that make a multi-primitive import per-slot addressable. Proven end to
    // end by tests/e2e/p06-2-per-submesh.spec.ts over a real two-primitive fixture; asserted
    // here so a refactor cannot remove the capability while #646 still reads as open.
    expect(/localSlotByChild\.set\(/.test(stripped)).toBe(true);
    expect(/irs\?\.\[local\]/.test(stripped)).toBe(true);
    expect(/targetSlot === slotIdx/.test(stripped)).toBe(true);

    // And the guard itself STILL STANDS. It is dead today (rows A and B) and must stay:
    // row B is the condition that revives it.
    expect(/!Array\.isArray\(src\)/.test(stripped)).toBe(true);
  });

  it('D. guards the guard — the parsers read code, not prose about it', () => {
    // A mention inside a comment must not count as an assignment, or row A would report a
    // violation the day someone DOCUMENTS the array road.
    expect(
      /\.material\s*=\s*\[/.test(stripComments('/* m.material = [a, b] */ const x = 1;')),
    ).toBe(false);
    expect(/\.material\s*=\s*\[/.test(stripComments('m.material = [a, b];'))).toBe(true);

    // Brace matching: a nested object type must not end the body early, which would hide
    // every field after it and make row B's equality pass over a SHORTER list.
    const nested = 'export interface X {\n  readonly a: { b: string };\n  readonly c: Y;\n}\n';
    expect(declaredFields(interfaceBody(nested, 'X') as string)).toEqual(['a', 'c']);

    // A name that is not there returns null rather than an empty body that reads as "declares
    // nothing" — the difference between "no fields" and "no interface".
    expect(interfaceBody('export interface Other { a: 1 }', 'X')).toBeNull();
  });
});
